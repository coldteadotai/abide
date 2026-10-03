import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayReadError } from "@coldtea/abide-schema";
import { parseTranscript } from "../src/lib/replay.js";
import { MAX_REPLAY_RECORD_BYTES } from "../src/lib/constants.js";
import { collectReplaySessions } from "../src/lib/replayCollection.js";
import { claudeTranscript, codexTranscript } from "./helpers/replay.js";
import { codexSessionsFor, parseCodexRollout } from "../src/lib/replayCodex.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "abide-replay-collect-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe.each([
  { host: "Codex", parse: parseCodexRollout, transcript: codexTranscript },
  { host: "Claude", parse: parseTranscript, transcript: claudeTranscript },
])("$host replay collection", ({ parse, transcript }) => {
  it("ignores an oversized session from another repository", async () => {
    const file = path.join(directory, "rollout-outside.jsonl");
    writeFileSync(
      file,
      `${transcript(path.dirname(directory))}\n${"x".repeat(MAX_REPLAY_RECORD_BYTES + 1)}`,
    );
    expect(await collectReplaySessions(directory, [file], parse)).toEqual({
      sessions: [],
      skippedSessions: [],
    });
  });

  it("continues past unreadable and oversized files without retaining partial edits", async () => {
    const good = path.join(directory, "rollout-good.jsonl");
    const large = path.join(directory, "rollout-large.jsonl");
    const missing = path.join(directory, "rollout-missing.jsonl");
    writeFileSync(good, transcript(directory));
    writeFileSync(large, `${transcript(directory)}\n${"x".repeat(MAX_REPLAY_RECORD_BYTES + 1)}`);
    const result = await collectReplaySessions(directory, [missing, large, good], parse);
    expect(result.sessions.map((session) => session.file)).toEqual([good]);
    expect(result.sessions[0]?.turns[0]?.edits).toHaveLength(1);
    expect(result.skippedSessions).toEqual([
      { file: missing, code: "REPLAY_READ_FAILED", reason: expect.any(String) },
      { file: large, code: "REPLAY_RECORD_TOO_LARGE", reason: expect.any(String) },
    ]);
  });

  it("drops a session when reading fails after edits have been collected", async () => {
    const bad = path.join(directory, "bad.jsonl");
    const good = path.join(directory, "good.jsonl");
    writeFileSync(bad, transcript(directory));
    writeFileSync(good, transcript(directory));
    const result = await collectReplaySessions(directory, [bad, good], async (file) => {
      const session = await parse(file);
      if (file === bad) throw new ReplayReadError("REPLAY_READ_FAILED", "simulated late failure");
      return session;
    });
    expect(result.sessions.map((session) => session.file)).toEqual([good]);
    expect(result.skippedSessions.map((session) => session.file)).toEqual([bad]);
  });

  it("preserves file order, filters other repositories and ignores sessions without edits", async () => {
    const files = ["b", "outside", "empty", "a"].map((name) =>
      path.join(directory, `${name}.jsonl`),
    );
    for (const file of files)
      writeFileSync(
        file,
        file.endsWith("empty.jsonl")
          ? "{}\n"
          : transcript(file.endsWith("outside.jsonl") ? path.dirname(directory) : directory),
      );
    const result = await collectReplaySessions(directory, files, parse);
    expect(result.sessions.map((session) => path.basename(session.file))).toEqual([
      "b.jsonl",
      "a.jsonl",
    ]);
    expect(result.skippedSessions).toEqual([]);
  });
});

it.each([
  { cwd: undefined, skips: 1 },
  { cwd: ".", skips: 1 },
  { cwd: "..", skips: 0 },
])("scopes late read failures to their known cwd: $cwd", async ({ cwd, skips }) => {
  const result = await collectReplaySessions(directory, ["file"], async () => {
    throw new ReplayReadError("REPLAY_READ_FAILED", "simulated late failure", {
      cwd: cwd === undefined ? undefined : path.resolve(directory, cwd),
    });
  });
  expect(result.sessions).toEqual([]);
  expect(result.skippedSessions).toHaveLength(skips);
});

it("does not hide unexpected parser failures", async () => {
  const failure = new Error("parser bug");
  await expect(
    collectReplaySessions(directory, ["file"], async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

it("Codex directory replay returns sorted healthy sessions and reports failed files", async () => {
  const bad = path.join(directory, "rollout-bad.jsonl");
  for (const name of ["rollout-z.jsonl", "rollout-a.jsonl"])
    writeFileSync(path.join(directory, name), codexTranscript(directory));
  writeFileSync(bad, "x".repeat(MAX_REPLAY_RECORD_BYTES + 1));
  const result = await codexSessionsFor(directory, directory);
  expect(result.sessions.map((session) => path.basename(session.file))).toEqual([
    "rollout-a.jsonl",
    "rollout-z.jsonl",
  ]);
  expect(result.skippedSessions[0]?.file).toBe(bad);
});
