import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWriteTool, createEditTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { parsePiSession, piSessionsFor } from "../src/lib/replayPi.js";
import { editsFromPostToolUse } from "../src/lib/diff.js";

const dirs: string[] = [];
const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "abide-pi-replay-"));
  dirs.push(dir);
  const cwd = path.join(dir, "project");
  const manager = SessionManager.create(cwd, path.join(dir, "sessions"));
  return { dir, cwd, manager };
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const user = (manager: SessionManager, text: string) =>
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
const tool = async (
  manager: SessionManager,
  cwd: string,
  id: string,
  name: "write" | "edit",
  input:
    | { path: string; content: string }
    | { path: string; edits: { oldText: string; newText: string }[] },
) => {
  manager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "session-record",
    model: "local-tools",
    timestamp: Date.now(),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: input }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  let result;
  switch (name) {
    case "write":
      if (!("content" in input)) throw new Error("Expected write arguments");
      result = await createWriteTool(cwd).execute(id, input, undefined, undefined);
      break;
    case "edit":
      if (!("edits" in input)) throw new Error("Expected edit arguments");
      result = await createEditTool(cwd).execute(id, input, undefined, undefined);
      break;
  }
  manager.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  });
};

it("replays files and original-relative edits recorded by Pi's real tools and session manager", async () => {
  const { cwd, manager, dir } = setup();
  user(manager, "Create and then update the local labels");
  await tool(manager, cwd, "w", "write", { path: "@a.ts", content: "a b\n" });
  manager.appendCustomMessageEntry("abide-repair", "Repair the labels", true);
  await tool(manager, cwd, "e", "edit", {
    path: "a.ts",
    edits: [
      { oldText: "a", newText: "b" },
      { oldText: "b", newText: "c" },
    ],
  });
  const file = manager.getSessionFile();
  if (!file) throw new Error("Expected a persisted Pi session");
  const replay = parsePiSession(file);
  expect(replay.cwd).toBe(cwd);
  expect(replay.turns).toHaveLength(1);
  expect(replay.turns[0]?.edits).toHaveLength(2);
  const edit = replay.turns[0]?.edits[1];
  if (!edit) throw new Error("Expected the recorded edit");
  const hunks = editsFromPostToolUse(edit.input);
  expect(hunks[0]?.text).toContain("-a b");
  expect(hunks[0]?.text).toContain("+b c");
  expect(piSessionsFor(cwd, path.join(dir, "sessions"))).toHaveLength(1);
  expect(piSessionsFor(path.join(dir, "another"), path.join(dir, "sessions"))).toHaveLength(0);
});

it("does not replay writes on a branch Pi abandoned", async () => {
  const { cwd, manager } = setup();
  const start = user(manager, "Initial request");
  await tool(manager, cwd, "old", "write", { path: "old.ts", content: "old\n" });
  manager.branch(start);
  user(manager, "Replacement request");
  await tool(manager, cwd, "new", "write", { path: "new.ts", content: "new\n" });
  const file = manager.getSessionFile();
  if (!file) throw new Error("Expected session file");
  const replay = parsePiSession(file);
  expect(replay.turns.map((turn) => turn.prompt)).toEqual(["Replacement request"]);
  expect(replay.turns[0]?.edits[0]?.input.tool_input).toMatchObject({
    file_path: path.join(cwd, "new.ts"),
  });
});
