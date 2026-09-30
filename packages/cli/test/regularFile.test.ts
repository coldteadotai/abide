import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRegularFile, readRegularText, writeRegularFile } from "../src/lib/regularFile.js";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";
import { NO_SYMLINK } from "./helpers/symlink.js";

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  // A short write, as a full disk gives.
  return { ...actual, writeSync: () => 3 };
});

describe("reading files the agent points at", () => {
  it("reads a regular file, and refuses one past the size it will take", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-read-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello");
    expect(readRegularText(file)).toBe("hello");
    expect(readRegularFile(file, { maxBytes: 4 })).toBeUndefined();
    expect(readRegularText(path.join(dir, "missing"))).toBeUndefined();
  });

  it.skipIf(NO_FIFO)("refuses a FIFO instead of waiting on its writer", { timeout: 3_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-read-"));
    const fifo = path.join(dir, "pipe");
    mkfifo(fifo);
    expect(readRegularFile(fifo)).toBeUndefined();
    expect(readRegularFile("/dev/zero")).toBeUndefined();
  });

  it.skipIf(NO_SYMLINK)("follows a symlink only when asked to", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-read-"));
    writeFileSync(path.join(dir, "target"), "t");
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    expect(readRegularText(path.join(dir, "link"))).toBe("t");
    expect(readRegularText(path.join(dir, "link"), { followSymlinks: false })).toBeUndefined();
  });
});

describe("writing files abide owns", () => {
  it("writes every byte even when a single write call stops short", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-write-"));
    const file = path.join(dir, "a.env");
    writeFileSync(file, "DATABASE_URL=x\nOLD=1\n");
    expect(writeRegularFile(file, "DATABASE_URL=x\nNEW=2\n", { use: "replace" })).toBe(true);
    expect(readRegularText(file)).toBe("DATABASE_URL=x\nNEW=2\n");
  });
});
