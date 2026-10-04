import { describe, expect, it } from "vitest";
import { BINARY_SAMPLE_BYTES, isBinaryContent } from "../src/lib/binary.js";

describe("binary content detection", () => {
  it("accepts empty files, ASCII, and Unicode text", () => {
    for (const text of ["", "hello\r\nworld", "Grüße 日本語 👋", "\uFEFFhello"]) {
      expect(isBinaryContent(Buffer.from(text))).toBe(false);
    }
  });

  it("detects NUL bytes at either end of Git's 8,000-byte sample", () => {
    for (const offset of [0, BINARY_SAMPLE_BYTES - 1]) {
      const bytes = Buffer.alloc(BINARY_SAMPLE_BYTES + 1, 0x61);
      bytes[offset] = 0;
      expect(isBinaryContent(bytes)).toBe(true);
    }
  });

  it("does not inspect bytes past the sample", () => {
    const bytes = Buffer.alloc(BINARY_SAMPLE_BYTES + 1, 0x61);
    bytes[BINARY_SAMPLE_BYTES] = 0;
    expect(isBinaryContent(bytes)).toBe(false);
  });
});
