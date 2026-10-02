import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceSha, type Rubric, type Rule } from "@coldtea/abide-schema";
import {
  checkStaleness,
  discoverGlobalSources,
  discoverProjectSources,
} from "../src/lib/sources.js";
import { fillSourceShas, mergeRules } from "../src/lib/rubricFile.js";

const repo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-"));
  writeFileSync(path.join(root, "AGENTS.md"), "# rules\n- Use type\n");
  mkdirSync(path.join(root, "apps", "web"), { recursive: true });
  writeFileSync(path.join(root, "apps", "web", "CLAUDE.md"), "- web rule\n");
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "dep", "AGENTS.md"), "ignored\n");
  return root;
};

const rubricFor = (root: string): Rubric => ({
  version: 1,
  compiledAt: "x",
  sources: [
    { path: "AGENTS.md", sha: createSourceSha("# rules\n- Use type\n") },
    { path: "apps/web/CLAUDE.md", sha: createSourceSha("- web rule\n") },
  ],
  rules: [],
});

describe("source discovery", () => {
  it("finds root and nested files with scopes and skips node_modules", () => {
    const root = repo();
    const found = discoverProjectSources(root);
    expect(found.map((f) => [f.path, f.scope])).toEqual([
      ["AGENTS.md", "**/*"],
      ["apps/web/CLAUDE.md", "apps/web/**/*"],
    ]);
  });

  it("detects fresh, changed, new, and missing sources", () => {
    const root = repo();
    const rubric = rubricFor(root);
    expect(checkStaleness(rubric, discoverProjectSources(root), root)).toEqual({ status: "fresh" });
    expect(checkStaleness(undefined, discoverProjectSources(root), root)).toEqual({
      status: "missing",
    });

    writeFileSync(path.join(root, "AGENTS.md"), "# rules\n- Use type\n- New rule\n");
    const changed = checkStaleness(rubric, discoverProjectSources(root), root);
    expect(changed).toMatchObject({ status: "stale", changed: ["AGENTS.md"] });

    writeFileSync(path.join(root, "CLAUDE.md"), "Read ./AGENTS.md\n");
    const added = checkStaleness(rubricFor(root), discoverProjectSources(root), root);
    expect(added).toMatchObject({ status: "stale", added: ["CLAUDE.md"] });

    const unhashed = checkStaleness({ ...rubric, sources: [{ path: "AGENTS.md" }] }, [], root);
    expect(unhashed).toMatchObject({ status: "stale", unhashed: ["AGENTS.md"] });
  });
});

describe("global sources", () => {
  it("accepts home-relative spellings and canonicalizes them to ~/", () => {
    const home = mkdtempSync(path.join(tmpdir(), "abide-home-"));
    process.env.ABIDE_HOME_DIR = home;
    try {
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(path.join(home, ".codex", "AGENTS.md"), "- rule\n");
      const candidates = discoverGlobalSources();
      expect(candidates.map((c) => c.path)).toEqual(["~/.codex/AGENTS.md"]);
      const written: Rubric = {
        version: 1,
        compiledAt: "x",
        sources: [{ path: ".codex/AGENTS.md" }],
        rules: [
          {
            id: "r",
            text: "t",
            source: { path: ".codex/AGENTS.md", line: 1 },
            status: "active",
            check: { type: "lint", how: "x" },
          },
        ],
      };
      const { rubric, missing } = fillSourceShas(written, home);
      expect(missing).toEqual([]);
      expect(rubric.sources[0]?.path).toBe("~/.codex/AGENTS.md");
      expect(rubric.rules[0]?.source.path).toBe("~/.codex/AGENTS.md");
      expect(checkStaleness(rubric, candidates, home)).toEqual({ status: "fresh" });
      expect(checkStaleness(written, candidates, home)).toMatchObject({
        status: "stale",
        unhashed: [".codex/AGENTS.md"],
      });
    } finally {
      delete process.env.ABIDE_HOME_DIR;
    }
  });
});

describe("merging", () => {
  it("lets the project rubric win on an id clash", () => {
    const mk = (text: string): Rubric => ({
      version: 1,
      compiledAt: "x",
      sources: [],
      rules: [
        {
          id: "same",
          text,
          source: { path: "AGENTS.md" },
          status: "active",
          check: { type: "lint", how: "x" },
        },
      ],
    });
    const merged = mergeRules(mk("project"), mk("global"), "/repo", "/home/u");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: "project", origin: "project" });
  });

  it("drops a global rule that names a different repo", () => {
    const mk = (repos?: string[]): Rubric => ({
      version: 1,
      compiledAt: "x",
      sources: [],
      rules: [
        {
          id: "scoped-to-api",
          text: "t",
          source: { path: "AGENTS.md" },
          status: "active",
          check: { type: "lint", how: "x" },
          ...(repos === undefined ? {} : { repos }),
        },
      ],
    });
    const at = (root: string, repo: string): string[] =>
      mergeRules(undefined, mk([repo]), root, "/Users/u").map((r) => r.id);
    expect(at("/Users/u/workspace/api", "~/workspace/api")).toEqual(["scoped-to-api"]);
    expect(at("/Users/u/workspace/web", "~/workspace/api")).toEqual([]);
    expect(mergeRules(undefined, mk(), "/Users/u/workspace/web", "/Users/u")).toHaveLength(1);
  });

  it("drops also a project rule that names another repo", () => {
    const rule = (repos: string[]): Rule => ({
      id: "r",
      text: "t",
      source: { path: "AGENTS.md" },
      status: "active",
      check: { type: "lint", how: "x" },
      repos,
    });
    const rubric = (repos: string[]): Rubric => ({
      version: 1,
      compiledAt: "x",
      sources: [],
      rules: [rule(repos)],
    });
    expect(
      mergeRules(rubric(["~/elsewhere"]), undefined, "/Users/u/workspace/api", "/Users/u"),
    ).toEqual([]);
  });
});
