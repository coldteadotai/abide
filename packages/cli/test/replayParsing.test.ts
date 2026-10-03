import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { parseTranscript } from "../src/lib/replay.js";
import { parseCodexRollout } from "../src/lib/replayCodex.js";
import { MAX_REPLAY_RECORD_BYTES } from "../src/lib/constants.js";
import { claudeTranscript, codexTranscript } from "./helpers/replay.js";

const directories: string[] = [];
const sessionFile = (text: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "abide-replay-parse-"));
  directories.push(directory);
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, text);
  return file;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.each([
  { host: "Codex", parse: parseCodexRollout, transcript: codexTranscript },
  { host: "Claude", parse: parseTranscript, transcript: claudeTranscript },
])("$host replay parsing", ({ parse, transcript }) => {
  const cwd = path.resolve("r", "app");

  it("keeps edits despite blank, malformed and torn lines, CRLF and no final newline", async () => {
    const text = `\nnot-json\n${transcript(cwd)}\n{"torn":`;
    const session = await parse(sessionFile(text.replaceAll("\n", "\r\n")));
    expect(session.cwd).toBe(cwd);
    expect(session.turns.map((turn) => [turn.index, turn.prompt, turn.edits.length])).toEqual([
      [1, "add a route 🌱", 1],
    ]);
  });

  it("rejects an oversized record even after collecting valid edits", async () => {
    const oversized = JSON.stringify({ ignored: "x".repeat(MAX_REPLAY_RECORD_BYTES) });
    const file = sessionFile(`${transcript(cwd)}\n${oversized}\n`);
    await expect(async () => parse(file)).rejects.toMatchObject({
      code: "REPLAY_RECORD_TOO_LARGE",
      cwd,
    });
  });

  it("reports unreadable files with a domain error", async () => {
    const file = sessionFile("");
    rmSync(file);
    await expect(async () => parse(file)).rejects.toMatchObject({ code: "REPLAY_READ_FAILED" });
  });
});
