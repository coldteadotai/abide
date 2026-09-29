import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileSkillPath, placeCompileSkill } from "../src/lib/packageRoot.js";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";

describe("placing the compile skill in a repo (needs `pnpm build` first)", () => {
  it("copies it into .abide", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-skill-"));
    const placed = placeCompileSkill(root);
    expect(placed).toBe(path.join(root, ".abide", "compile-skill.md"));
    expect(readFileSync(placed, "utf8")).toBe(readFileSync(compileSkillPath(), "utf8"));
    expect(placeCompileSkill(root)).toBe(placed);
  });

  it.skipIf(NO_FIFO)(
    "refuses a FIFO or a symlink in the copy's place and falls back to the packaged copy",
    { timeout: 3_000 },
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "abide-skill-"));
      mkdirSync(path.join(root, ".abide"));
      mkfifo(path.join(root, ".abide", "compile-skill.md"));
      expect(placeCompileSkill(root)).toBe(compileSkillPath());

      const other = mkdtempSync(path.join(tmpdir(), "abide-skill-"));
      const precious = path.join(other, "precious.txt");
      writeFileSync(precious, "keep me\n");
      mkdirSync(path.join(other, ".abide"));
      symlinkSync(precious, path.join(other, ".abide", "compile-skill.md"));
      expect(placeCompileSkill(other)).toBe(compileSkillPath());
      expect(readFileSync(precious, "utf8")).toBe("keep me\n");
      expect(existsSync(path.join(other, ".abide", "compile-skill.md"))).toBe(true);
    },
  );
});
