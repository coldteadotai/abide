import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markBaseline,
  readBaselineStatus,
  blockCount,
  clearTurn,
  hasTurnState,
  incrementBlock,
  incrementStopChecks,
  readBaseline,
  readChecked,
  readFileStarts,
  recordChecked,
  recordFileStart,
  stopCheckCount,
  turnDir,
  writeBaseline,
} from "../src/lib/session.js";

describe("turn state on disk", () => {
  beforeEach(() => {
    process.env.ABIDE_HOME_DIR = mkdtempSync(path.join(tmpdir(), "abide-home-"));
  });
  afterEach(() => {
    delete process.env.ABIDE_HOME_DIR;
  });

  it("keeps the first record of a file and every file two hooks record in parallel", () => {
    const dir = turnDir("s", "p");
    recordFileStart(dir, "/r/a.ts", "a v1");
    recordFileStart(dir, "/r/b.ts", "b v1");
    recordFileStart(dir, "/r/a.ts", "a v2");
    expect(readFileStarts(dir).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "/r/a.ts", original: "a v1" },
      { path: "/r/b.ts", original: "b v1" },
    ]);
    expect(hasTurnState(dir)).toBe(true);
  });

  it("counts blocks and stop checks without a read-modify-write", () => {
    const dir = turnDir("s", "p");
    expect(blockCount(dir, "k")).toBe(0);
    expect(incrementBlock(dir, "k")).toBe(1);
    expect(incrementBlock(dir, "k")).toBe(2);
    expect(blockCount(dir, "k")).toBe(2);
    expect(blockCount(dir, "other")).toBe(0);
    expect(stopCheckCount(dir)).toBe(0);
    incrementStopChecks(dir);
    expect(stopCheckCount(dir)).toBe(1);
  });

  it("keeps a baseline once and clears the turn whole", () => {
    const dir = turnDir("s", "p");
    writeBaseline(dir, "a".repeat(40));
    writeBaseline(dir, "b".repeat(40));
    expect(readBaseline(dir)).toBe("a".repeat(40));
    clearTurn(dir);
    expect(hasTurnState(dir)).toBe(false);
    expect(() => readdirSync(dir)).toThrow();
  });

  it("records the baseline attempt and counts it as turn state", () => {
    const dir = turnDir("s", "p");
    expect(readBaselineStatus(dir)).toBeUndefined();
    markBaseline(dir, "pending");
    expect(readBaselineStatus(dir)).toBe("pending");
    expect(hasTurnState(dir)).toBe(true);
    markBaseline(dir, "failed");
    expect(readBaselineStatus(dir)).toBe("failed");
    markBaseline(dir, "ok");
    expect(readBaselineStatus(dir)).toBe("ok");
  });

  it("keeps every judged edit once", () => {
    const dir = turnDir("s", "p");
    expect(readChecked(dir)).toEqual([]);
    recordChecked(dir, { path: "a.ts", before: null, after: "1" });
    recordChecked(dir, { path: "a.ts", before: "1", after: "2" });
    recordChecked(dir, { path: "a.ts", before: "1", after: "2" });
    expect(readChecked(dir).sort((x, y) => x.after.localeCompare(y.after))).toEqual([
      { path: "a.ts", before: null, after: "1" },
      { path: "a.ts", before: "1", after: "2" },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "writes its state owner-only, since a snapshot holds whatever the agent edited",
    () => {
      const dir = turnDir("s", "p");
      recordFileStart(dir, "/r/a.ts", "SECRET=1");
      markBaseline(dir, "ok");
      const mode = (p: string): number => statSync(p).mode & 0o777;
      expect(mode(dir)).toBe(0o700);
      expect(mode(path.join(dir, "files"))).toBe(0o700);
      for (const name of readdirSync(path.join(dir, "files"))) {
        expect(mode(path.join(dir, "files", name))).toBe(0o600);
      }
      expect(mode(path.join(dir, "baseline-status"))).toBe(0o600);
    },
  );

  it("separates prompts and sessions", () => {
    recordFileStart(turnDir("s", "p1"), "/r/a.ts", null);
    expect(readFileStarts(turnDir("s", "p2"))).toEqual([]);
    expect(readFileStarts(turnDir("t", "p1"))).toEqual([]);
  });
});
