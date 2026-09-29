import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExecutable } from "../src/lib/executable.js";

const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
let bin: string;

beforeEach(() => {
  bin = mkdtempSync(path.join(tmpdir(), "abide-bin-"));
  process.env.PATH = [path.join(bin, "missing"), bin].join(path.delimiter);
  delete process.env.PATHEXT;
});

afterEach(() => {
  process.env.PATH = env.PATH;
  if (env.PATHEXT === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = env.PATHEXT;
});

describe("finding an executable on PATH", () => {
  it("finds a file it may run and nothing else", () => {
    expect(findExecutable("claude", "linux")).toBeUndefined();
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n");
    if (process.platform !== "win32") {
      chmodSync(path.join(bin, "claude"), 0o644);
      expect(findExecutable("claude", "linux")).toBeUndefined();
      chmodSync(path.join(bin, "claude"), 0o755);
    }
    expect(findExecutable("claude", "linux")).toBe(path.join(bin, "claude"));
  });

  it("tries the PATHEXT suffixes on Windows, as its shells do", () => {
    writeFileSync(path.join(bin, "codex.cmd"), "@echo off\n");
    expect(findExecutable("codex", "win32")).toBe(path.join(bin, "codex.cmd"));
    expect(findExecutable("codex", "linux")).toBeUndefined();
    process.env.PATHEXT = ".EXE";
    expect(findExecutable("codex", "win32")).toBeUndefined();
  });

  it("ignores a directory of the same name", () => {
    mkdtempSync(path.join(bin, "opencode"));
    expect(findExecutable("opencode")).toBeUndefined();
  });
});
