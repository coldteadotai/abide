import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexSessionsFor, parseCodexRollout } from "../src/lib/replayCodex.js";
import { opencodeSessionsFromRows } from "../src/lib/replayOpencode.js";

const line = (entry: unknown): string => JSON.stringify(entry);

describe("replay from Codex rollouts", () => {
  it("reads prompts and applied patches, skips injected context and failed patches", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-codex-"));
    const repo = "/r/app";
    const file = path.join(dir, "2026", "09", "18", "rollout-2026-09-18T10-00-00-abc.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    const item = (payload: unknown) => line({ type: "response_item", payload });
    writeFileSync(
      file,
      [
        line({ type: "session_meta", payload: { cwd: repo } }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /r/app\n..." }],
        }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "add a logout route" }],
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c1",
          input: "*** Begin Patch\n*** Add File: src/a.ts\n+export const a = 1;\n*** End Patch",
        }),
        item({
          type: "custom_tool_call_output",
          call_id: "c1",
          output: "Success. Updated the following files:\nA src/a.ts",
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c2",
          input: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** End Patch",
        }),
        item({
          type: "custom_tool_call_output",
          call_id: "c2",
          output: "apply_patch verification failed: Failed to find expected lines",
        }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "now tests" }],
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c3",
          input: "*** Begin Patch\n*** Add File: tests/a.test.ts\n+it()\n*** End Patch",
        }),
        item({ type: "custom_tool_call_output", call_id: "c3", output: "Success." }),
        "",
      ].join("\n"),
    );
    const session = await parseCodexRollout(file);
    expect(session.cwd).toBe(repo);
    expect(session.turns.map((t) => [t.index, t.prompt, t.edits.length])).toEqual([
      [1, "add a logout route", 1],
      [2, "now tests", 1],
    ]);
    expect(session.turns[0]?.edits[0]?.input.tool_name).toBe("apply_patch");
    expect((await codexSessionsFor(repo, dir)).sessions).toHaveLength(1);
    expect((await codexSessionsFor("/elsewhere", dir)).sessions).toHaveLength(0);
  });
});

describe("replay from OpenCode rows", () => {
  it("groups parts into turns and maps edit and write tools onto hook payloads", () => {
    const repo = path.resolve("r", "app");
    const row = (
      messageId: string,
      role: string,
      created: number,
      part: unknown,
      directory = repo,
      sessionId = "ses_1",
    ) => ({ sessionId, directory, messageId, role, created, part: JSON.stringify(part) });
    const rows = [
      row("m1", "user", 1, { type: "text", text: "add a route" }),
      row("m2", "assistant", 2, {
        type: "tool",
        tool: "write",
        callID: "w1",
        state: {
          status: "completed",
          input: { filePath: "src/a.ts", content: "export const a = 1;\n" },
        },
      }),
      row("m2", "assistant", 2, {
        type: "tool",
        tool: "edit",
        callID: "e1",
        state: {
          status: "completed",
          input: { filePath: path.join(repo, "src", "a.ts"), oldString: "1", newString: "2" },
        },
      }),
      row("m2", "assistant", 2, {
        type: "tool",
        tool: "bash",
        callID: "b1",
        state: { status: "completed", input: { command: "ls" } },
      }),
      row("m3", "user", 3, { type: "text", text: "Abide: This edit appears to break a rule" }),
      row("m4", "user", 1, { type: "text", text: "elsewhere" }, path.resolve("other"), "ses_2"),
      row(
        "m5",
        "assistant",
        2,
        {
          type: "tool",
          tool: "write",
          callID: "w2",
          state: { status: "completed", input: { filePath: "x.ts", content: "" } },
        },
        path.resolve("other"),
        "ses_2",
      ),
    ];
    const sessions = opencodeSessionsFromRows(repo, rows);
    expect(sessions).toHaveLength(1);
    const [s] = sessions;
    expect(s?.turns.map((t) => [t.index, t.prompt, t.edits.map((e) => e.input.tool_name)])).toEqual(
      [[1, "add a route", ["Write", "Edit"]]],
    );
    const write = s?.turns[0]?.edits[0]?.input;
    expect(write?.tool_name === "Write" && write.tool_input.file_path).toBe(
      path.join(repo, "src", "a.ts"),
    );
  });
});
