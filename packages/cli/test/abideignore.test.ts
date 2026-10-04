import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";
import { isExcludedPath } from "../src/lib/paths.js";
import { readRegularText } from "../src/lib/regularFile.js";

vi.mock("../src/lib/regularFile.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/regularFile.js")>();
  return { ...actual, readRegularText: vi.fn(actual.readRegularText) };
});

let root: string;
let ignore: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "abide-ignore-"));
  ignore = path.join(root, ".abideignore");
  vi.mocked(readRegularText).mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const expectSafetyExclusions = (): void => {
  expect(isExcludedPath(".env.local", root)).toBe(true);
  expect(isExcludedPath("certs/private.key", root)).toBe(true);
  expect(isExcludedPath(".abide/rubric.json", root)).toBe(true);
  expect(isExcludedPath("src/a.ts", root)).toBe(false);
};

describe("repo-wide ignore globs", () => {
  it("handles comments, whitespace, CRLF, nested paths, dotfiles and deleted files", () => {
    writeFileSync(
      ignore,
      "  # generated\r\n\r\n **/_generated/** \r\n**/*.generated.ts\r\nnext-env.d.ts\r\n",
    );
    for (const file of [
      "_generated/a.ts",
      "apps/web/_generated/deep/a.ts",
      ".hidden/a.generated.ts",
      "next-env.d.ts",
      "deleted.generated.ts",
    ])
      expect(isExcludedPath(file, root), file).toBe(true);
    for (const file of ["apps/web/next-env.d.ts", "src/a.ts", "src/generated.ts"])
      expect(isExcludedPath(file, root), file).toBe(false);
    expectSafetyExclusions();
  });

  it("never interprets a leading ! as Git-style negation or re-inclusion", () => {
    writeFileSync(ignore, "**/*.generated.ts\n!src/keep.generated.ts\n!src/a.ts\n");
    expect(isExcludedPath("src/keep.generated.ts", root)).toBe(true);
    expect(isExcludedPath("src/a.ts", root)).toBe(false);
    expect(isExcludedPath("other.ts", root)).toBe(false);
  });

  it("skips malformed globs without losing valid globs or safety exclusions", () => {
    writeFileSync(ignore, "[\n{\n(\n\0\n**/*.generated.ts\n");
    expect(isExcludedPath("src/a.generated.ts", root)).toBe(true);
    expectSafetyExclusions();
  });

  it("caches per repository and refreshes on creation, same-size edits and removal", () => {
    const other = path.join(root, "other");
    mkdirSync(other);
    writeFileSync(path.join(other, ".abideignore"), "other.ts\n");
    expect(isExcludedPath("first.ts", root)).toBe(false);
    writeFileSync(ignore, "first.ts\n");
    expect(isExcludedPath("first.ts", root)).toBe(true);
    expect(isExcludedPath("first.ts", path.join(root, "."))).toBe(true);
    expect(readRegularText).toHaveBeenCalledTimes(1);
    expect(isExcludedPath("first.ts", other)).toBe(false);
    expect(isExcludedPath("other.ts", other)).toBe(true);
    writeFileSync(ignore, "other.ts\n");
    utimesSync(ignore, new Date(0), new Date(0));
    expect(isExcludedPath("first.ts", root)).toBe(false);
    expect(isExcludedPath("other.ts", root)).toBe(true);
    rmSync(ignore);
    expect(isExcludedPath("other.ts", root)).toBe(false);
    expect(isExcludedPath("other.ts", other)).toBe(true);
    writeFileSync(ignore, "first.ts\n");
    expect(isExcludedPath("first.ts", root)).toBe(true);
  });

  it("fails safely for missing, unreadable, oversized and non-regular files", () => {
    expectSafetyExclusions();
    writeFileSync(ignore, "**/*\n");
    vi.mocked(readRegularText).mockReturnValueOnce(undefined);
    expectSafetyExclusions();
    writeFileSync(ignore, "**/*\n" + "#".repeat(64 * 1024));
    expectSafetyExclusions();
    rmSync(ignore);
    mkdirSync(ignore);
    expectSafetyExclusions();
  });

  it.skipIf(NO_FIFO)("refuses a FIFO without waiting for a writer", { timeout: 3_000 }, () => {
    mkfifo(ignore);
    expectSafetyExclusions();
  });
});
