import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverProjectSources } from "../src/lib/sources.js";
import { planCompile } from "../src/hooks/sessionStart.js";
import { findRepoRoot } from "../src/lib/paths.js";

const directories: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "abide-home-"));
  directories.push(dir);
  vi.stubEnv("ABIDE_HOME_DIR", dir);
  mkdirSync(path.join(dir, ".abide"), { recursive: true });
  writeFileSync(path.join(dir, ".abide", "global.json"), "{}\n");
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("the home directory is never a project root", () => {
  it("does not let ~/.abide or ~/CLAUDE.md make home the root of a scratch folder", () => {
    const dir = home();
    writeFileSync(path.join(dir, "CLAUDE.md"), "- a stray rule\n");
    const scratch = path.join(dir, "Library", "scratch");
    mkdirSync(scratch, { recursive: true });
    expect(findRepoRoot(scratch)).toBe(scratch);
  });

  it("recognizes home through a symlink alias and a differently spelled start path", () => {
    const dir = home();
    const alias = path.join(mkdtempSync(path.join(tmpdir(), "abide-alias-")), "home");
    directories.push(path.dirname(alias));
    symlinkSync(dir, alias);
    vi.stubEnv("ABIDE_HOME_DIR", alias);
    const physical = realpathSync.native(dir);
    mkdirSync(path.join(physical, "projects", "other"), { recursive: true });
    writeFileSync(path.join(physical, "projects", "other", "CLAUDE.md"), "- rule\n");
    const scratch = path.join(physical, "scratch");
    mkdirSync(scratch);
    expect(findRepoRoot(scratch)).toBe(scratch);
    expect(discoverProjectSources(physical)).toEqual([]);
    expect(planCompile(findRepoRoot(scratch)).targets.map((target) => target.which)).toEqual([]);
  });

  it("still finds a marked project between the start directory and home", () => {
    const dir = home();
    const project = path.join(dir, "Documents", "proj");
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "AGENTS.md"), "- rule\n");
    expect(findRepoRoot(path.join(project, "src"))).toBe(project);
  });

  it("does not walk the whole home tree for project sources", () => {
    const dir = home();
    mkdirSync(path.join(dir, "Documents", "other"), { recursive: true });
    writeFileSync(path.join(dir, "Documents", "other", "CLAUDE.md"), "- rule\n");
    expect(discoverProjectSources(dir)).toEqual([]);
  });

  it("plans no project compile for a session started outside any repo", () => {
    const dir = home();
    mkdirSync(path.join(dir, "Documents", "other"), { recursive: true });
    writeFileSync(path.join(dir, "Documents", "other", "CLAUDE.md"), "- rule\n");
    const scratch = path.join(dir, "Backups", "notes");
    mkdirSync(scratch, { recursive: true });
    for (const start of [scratch, dir]) {
      const plan = planCompile(findRepoRoot(start));
      expect(plan.targets.map((target) => target.which)).toEqual([]);
    }
  });
});
