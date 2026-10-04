import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { NO_SYMLINK } from "./helpers/symlink.js";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";
import { readRegularFile, readRegularText, writeRegularFile } from "../src/lib/regularFile.js";

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

  it("reads only a requested prefix without weakening the file size limit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-read-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello");
    expect(readRegularFile(file, { prefixBytes: 2 })).toEqual(Buffer.from("he"));
    expect(readRegularFile(file, { prefixBytes: 10 })).toEqual(Buffer.from("hello"));
    expect(readRegularFile(file, { prefixBytes: 0 })).toEqual(Buffer.alloc(0));
    expect(readRegularFile(file, { maxBytes: 4, prefixBytes: 2 })).toBeUndefined();
  });

  it.skipIf(NO_FIFO)("refuses a FIFO instead of waiting on its writer", { timeout: 3_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "abide-read-"));
    const fifo = path.join(dir, "pipe");
    mkfifo(fifo);
    expect(readRegularFile(fifo)).toBeUndefined();
    expect(readRegularFile(fifo, { prefixBytes: 8_000 })).toBeUndefined();
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
