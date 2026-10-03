import { z } from "zod";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rubricSchema } from "@coldtea/abide-schema";
import { MAX_REPLAY_RECORD_BYTES } from "../src/lib/constants.js";
import { claudeTranscript, codexTranscript } from "./helpers/replay.js";

const script = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const outputSchema = z.object({
  sessions: z.number(),
  edits: z.number(),
  skippedSessions: z.array(
    z.object({
      file: z.string(),
      code: z.enum(["REPLAY_READ_FAILED", "REPLAY_RECORD_TOO_LARGE"]),
      reason: z.string(),
    }),
  ),
  editResults: z.array(z.object({ file: z.string() })),
});

it("preserves Pi replay results with the shared collection return type", () => {
  const entries = [
    { type: "session", id: "pi-fixture", cwd: root },
    { type: "message", message: { role: "user", content: "add a route" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "write",
            arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
          },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "c1", isError: false } },
  ];
  writeFileSync(
    path.join(sessions, "pi-session.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  const result = run("pi", "--json");
  expect(result.status).toBe(0);
  const output = outputSchema.parse(JSON.parse(result.stdout));
  expect(output.sessions).toBe(1);
  expect(output.edits).toBe(1);
  expect(output.editResults).toHaveLength(1);
  expect(output.skippedSessions).toEqual([]);
  expect(result.stderr).toBe("");
});

let root: string;
let sessions: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "abide-replay-command-")));
  sessions = path.join(root, "sessions");
  mkdirSync(sessions);
  mkdirSync(path.join(root, ".abide"));
  const rubric = rubricSchema.parse({
    version: 1,
    compiledAt: "2026-10-03",
    sources: [],
    rules: [
      {
        id: "lint-only-fixture",
        text: "test fixture",
        source: { path: "AGENTS.md" },
        check: { type: "lint", how: "test fixture; no model calls" },
      },
    ],
  });
  writeFileSync(path.join(root, ".abide", "rubric.json"), JSON.stringify(rubric));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (host: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, "replay", host, sessions, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      ABIDE_HOME_DIR: root,
      AI_GATEWAY_API_KEY: "",
      TYPESAFE_AI_API_KEY: "test-only-no-network",
      TYPESAFE_AI_BASE_URL: "",
    },
  });

const addOversized = (prefix = ""): string => {
  const file = path.join(sessions, "rollout-bad.jsonl");
  writeFileSync(file, `${prefix}\n${"x".repeat(MAX_REPLAY_RECORD_BYTES + 1)}`);
  return file;
};

describe.each([
  { host: "codex", transcript: codexTranscript },
  { host: "claude", transcript: claudeTranscript },
])("$host replay command", ({ host, transcript }) => {
  it.each([true, false])("ignores oversized sessions from other repos, json=%s", (json) => {
    addOversized(transcript(path.join(path.dirname(root), "other-repo")));
    const result = run(host, ...(json ? ["--json"] : []));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    if (json) {
      const output = outputSchema.parse(JSON.parse(result.stdout));
      expect(output.sessions).toBe(0);
      expect(output.skippedSessions).toEqual([]);
    } else {
      expect(result.stdout).not.toContain("Skipped 1 session");
      expect(result.stdout).not.toContain("No edits were judged");
    }
  });

  it("returns partial JSON results, keeping warnings on stderr", () => {
    const bad = addOversized();
    writeFileSync(path.join(sessions, "rollout-good.jsonl"), transcript(root));
    const result = run(host, "--json");
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    const output = outputSchema.parse(JSON.parse(result.stdout));
    expect(output.sessions).toBe(1);
    expect(output.edits).toBe(1);
    expect(output.editResults).toHaveLength(1);
    expect(output.skippedSessions).toEqual([
      { file: bad, code: "REPLAY_RECORD_TOO_LARGE", reason: expect.any(String) },
    ]);
    expect(result.stderr).toContain(JSON.stringify(bad));
    expect(result.stderr).toContain("REPLAY_RECORD_TOO_LARGE");
    expect(result.stderr).not.toContain("xxxx");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("returns 1 with structured results when every session fails", () => {
    addOversized();
    const result = run(host, "--json");
    expect(result.status).toBe(1);
    const output = outputSchema.parse(JSON.parse(result.stdout));
    expect(output.sessions).toBe(0);
    expect(output.edits).toBe(0);
    expect(output.skippedSessions).toHaveLength(1);
  });

  it("shows skipped sessions in the terminal and does not claim a clean run when all fail", () => {
    addOversized();
    const result = run(host);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Skipped 1 session");
    expect(result.stdout).toContain("No edits were judged");
    expect(result.stdout).not.toContain("No edit or turn broke a rule");
  });

  it("keeps the existing successful empty-run behavior", () => {
    const result = run(host, "--json");
    expect(result.status).toBe(0);
    const output = outputSchema.parse(JSON.parse(result.stdout));
    expect(output.sessions).toBe(0);
    expect(output.skippedSessions).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("still applies max-sessions after collecting sorted sessions", () => {
    for (const name of ["rollout-z.jsonl", "rollout-a.jsonl"])
      writeFileSync(path.join(sessions, name), transcript(root));
    const result = run(host, "--json", "--max-sessions", "1");
    expect(result.status).toBe(0);
    const output = outputSchema.parse(JSON.parse(result.stdout));
    expect(output.sessions).toBe(1);
    expect(output.edits).toBe(1);
    expect(output.skippedSessions).toEqual([]);
  });
});
