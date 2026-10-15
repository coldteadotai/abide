import { describe, expect, it, vi } from "vitest";
import { msFromEnv } from "../src/lib/constants.js";

describe("msFromEnv", () => {
  it("keeps the default when the variable is unset, empty or not a positive integer", () => {
    expect(msFromEnv("ABIDE_TEST_TIMEOUT_MS", 8_000, 15_000)).toBe(8_000);
    for (const raw of ["", "abc", "0", "-5", "1.5"]) {
      vi.stubEnv("ABIDE_TEST_TIMEOUT_MS", raw);
      expect(msFromEnv("ABIDE_TEST_TIMEOUT_MS", 8_000, 15_000)).toBe(8_000);
    }
  });

  it("uses the variable, capped at the ceiling", () => {
    vi.stubEnv("ABIDE_TEST_TIMEOUT_MS", "12000");
    expect(msFromEnv("ABIDE_TEST_TIMEOUT_MS", 8_000, 15_000)).toBe(12_000);
    vi.stubEnv("ABIDE_TEST_TIMEOUT_MS", "60000");
    expect(msFromEnv("ABIDE_TEST_TIMEOUT_MS", 8_000, 15_000)).toBe(15_000);
  });
});
