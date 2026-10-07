import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSourceSha, type Rubric } from "@coldtea/abide-schema";
import {
  checkStaleness,
  discoverGlobalSources,
  discoverProjectSources,
} from "../src/lib/sources.js";
import { fillSourceShas, mergeRules } from "../src/lib/rubricFile.js";
import { planCompile } from "../src/hooks/sessionStart.js";

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

  it("never reports a hand-maintained rubric stale, so session start does not ask to compile it", () => {
    const root = repo();
    const manual: Rubric = { ...rubricFor(root), manual: true, sources: [] };
    expect(checkStaleness(manual, discoverProjectSources(root), root)).toEqual({
      status: "manual",
    });

    vi.stubEnv("ABIDE_HOME_DIR", mkdtempSync(path.join(tmpdir(), "abide-home-")));
    try {
      mkdirSync(path.join(root, ".abide"));
      writeFileSync(path.join(root, ".abide", "rubric.json"), JSON.stringify(manual));
      expect(planCompile(root)).toMatchObject({ targets: [], manual: ["project"] });
      writeFileSync(
        path.join(root, ".abide", "rubric.json"),
        JSON.stringify({ ...manual, manual: false }),
      );
      expect(planCompile(root).targets.map((t) => t.which)).toEqual(["project"]);
    } finally {
      vi.unstubAllEnvs();
    }
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
    const merged = mergeRules(mk("project"), mk("global"));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: "project", origin: "project" });
  });
});
