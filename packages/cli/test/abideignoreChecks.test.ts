import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_THRESHOLDS, postToolUseInputSchema, rubricSchema } from "@coldtea/abide-schema";
import { checkWithModel } from "../src/lib/jev.js";
import { loadRules } from "../src/lib/loadRules.js";
import { runCheckCommand } from "../src/commands/check.js";
import { handleStop, turnDiff } from "../src/hooks/stop.js";
import { handleTurnStart } from "../src/hooks/turnStart.js";
import { createMutationTracker } from "../src/pi/mutations.js";
import { handlePostToolUse } from "../src/hooks/postToolUse.js";
import { recordFileStart, turnDir } from "../src/lib/session.js";
import { replaySessions, type ReplaySession } from "../src/lib/replay.js";
import { recentHistory, splitDiff, workingTreeDiff } from "../src/lib/git.js";
import { auditableFiles, auditFiles, listRepoFiles } from "../src/lib/audit.js";

vi.mock("../src/lib/jev.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/jev.js")>();
  return {
    ...actual,
    checkWithModel: vi.fn(async () => ({ verdicts: [], usage: {}, latencyMs: 0 })),
  };
});
vi.mock("../src/lib/ui.js", () => ({ say: vi.fn() }));

const source = "src/a.ts";
const ignored = ["src/a.generated.ts", "src/_generated/nested.ts", "next-env.d.ts"];
const before = Array.from(
  { length: 8 },
  (_, i) => `export const initial${i} = "initial fixture value";\n`,
).join("");
const after = "export const changed = 2;\n";
let sandbox: string;
let root: string;

const write = (file: string, text: string): void => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
};
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "abide-ignore-checks-")));
  root = path.join(sandbox, "repo");
  mkdirSync(root);
  vi.stubEnv("ABIDE_HOME_DIR", path.join(sandbox, "home"));
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-only-no-network");
  vi.mocked(checkWithModel).mockClear();
  write("AGENTS.md", "- fixture rule\n");
  write(".abideignore", "**/*.generated.ts\n**/_generated/**\nnext-env.d.ts\n");
  const rubric = rubricSchema.parse({
    version: 1,
    compiledAt: "x",
    sources: [{ path: "AGENTS.md" }],
    rules: ["edit", "turn"].map((when) => ({
      id: when,
      when,
      text: "fixture rule",
      source: { path: "AGENTS.md" },
      check: { type: "model", question: { type: "boolean", instructions: "fixture question" } },
    })),
  });
  write(".abide/rubric.json", JSON.stringify(rubric));
  for (const file of [source, ...ignored]) write(file, before);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "fixture");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

const identity = () => ({ session_id: "ignore-fixture", prompt_id: "p", cwd: root });
const editInput = (file: string) =>
  postToolUseInputSchema.parse({
    ...identity(),
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, file), content: after },
    tool_response: { originalFile: before },
  });
const stop = () => handleStop({ ...identity(), hook_event_name: "Stop", stop_hook_active: false });
const expectOnlySourceAtModel = (phases: string[]): void => {
  const calls = vi.mocked(checkWithModel).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.map(([rules]) => rules[0]?.when).sort()).toEqual([...phases].sort());
  for (const [, state] of calls) {
    expect(state.file === undefined ? state.files : [state.file]).toEqual([source]);
    expect(state.diff).toContain("export const");
    for (const file of ignored) expect(state.diff).not.toContain(file);
    expect(state.diff).not.toContain("ignored-only-marker");
  }
};
const changeFiles = (): void => {
  write(source, after);
  for (const file of ignored) write(file, "export const ignored = 'ignored-only-marker';\n");
};

describe("ignored tracked files stay out of rule checks", () => {
  it("makes no model calls for an ignored-only turn", async () => {
    await handleTurnStart({
      ...identity(),
      hook_event_name: "UserPromptSubmit",
      prompt: "regenerate",
    });
    for (const file of ignored) {
      write(file, after);
      expect(await handlePostToolUse(editInput(file))).toEqual({ kind: "silent" });
    }
    expect(await stop()).toEqual({ kind: "silent" });
    expect(checkWithModel).not.toHaveBeenCalled();
  });

  it("filters post-tool-use edits and the fallback Stop diff", async () => {
    changeFiles();
    for (const file of [source, ...ignored]) await handlePostToolUse(editInput(file));
    await stop();
    expectOnlySourceAtModel(["edit", "turn"]);
  });

  it("filters previously captured fallback records, including deletions", async () => {
    for (const file of [source, ...ignored]) {
      recordFileStart(turnDir("ignore-fixture", "p"), path.join(root, file), before);
      rmSync(path.join(root, file));
    }
    const turn = turnDiff(root, turnDir("ignore-fixture", "p"));
    expect(turn.kind).toBe("complete");
    if (turn.kind !== "complete") throw new Error("missing complete diff");
    expect(turn.files).toEqual([source]);
    await stop();
    expectOnlySourceAtModel(["edit", "turn"]);
  });

  it.each([false, true])(
    "filters the git Stop diff and edit backfill, deleted=%s",
    async (deleted) => {
      await handleTurnStart({
        ...identity(),
        hook_event_name: "UserPromptSubmit",
        prompt: "change source",
      });
      if (deleted) {
        for (const file of [source, ...ignored]) rmSync(path.join(root, file));
      } else changeFiles();
      const turn = turnDiff(root, turnDir("ignore-fixture", "p"));
      expect(turn.kind).toBe("complete");
      if (turn.kind !== "complete") throw new Error("missing complete diff");
      expect(turn.files).toEqual([source]);
      await stop();
      expectOnlySourceAtModel(["edit", "turn"]);
    },
  );

  it("filters replay edit and turn checks from a nested working directory", async () => {
    const session: ReplaySession = {
      file: "session.jsonl",
      cwd: path.join(root, "src"),
      turns: [
        {
          index: 1,
          prompt: "change source",
          edits: [source, ...ignored].map((file) => ({ turn: 1, input: editInput(file) })),
        },
      ],
    };
    const result = await replaySessions(
      [session],
      loadRules(root).rules,
      DEFAULT_THRESHOLDS,
      2,
      () => {},
    );
    expect(result.edits.map((e) => e.file)).toEqual([source]);
    expect(result.turns.map((t) => t.files)).toEqual([[source]]);
    expectOnlySourceAtModel(["edit", "turn"]);
  });

  it("filters check's working tree and explicit patch inputs", async () => {
    changeFiles();
    const cwd = process.cwd();
    process.chdir(path.join(root, "src"));
    try {
      await runCheckCommand(["--json"]);
      expectOnlySourceAtModel(["edit", "turn"]);
      vi.mocked(checkWithModel).mockClear();
      const patch = path.join(sandbox, "change.patch");
      writeFileSync(patch, workingTreeDiff(root, []));
      await runCheckCommand(["--json", "--diff", patch]);
      expectOnlySourceAtModel(["edit", "turn"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("filters audit listing, selection and direct model calls", async () => {
    changeFiles();
    const rules = loadRules(root).rules;
    const listed = listRepoFiles(root, ["src", "next-env.d.ts"]);
    expect(listed).toEqual([source]);
    expect(auditableFiles(root, [source, ...ignored], rules).files).toEqual([source]);
    await auditFiles(root, [source, ...ignored], rules, DEFAULT_THRESHOLDS, 2, () => {});
    expectOnlySourceAtModel(["edit"]);
  });

  it("filters calibration history and working-tree patches", () => {
    const history = recentHistory(root, 20, 20);
    const files = history.hunks.map((h) => h.file);
    expect(files).toContain(source);
    for (const file of ignored) expect(files).not.toContain(file);
    for (const commit of history.commits)
      for (const file of ignored) expect(commit.files).not.toContain(file);
    changeFiles();
    expect(splitDiff(workingTreeDiff(root, []), root).map((f) => f.file)).toEqual([source]);
    expect(
      git("ls-files", "--", ...ignored)
        .trim()
        .split("\n")
        .sort(),
    ).toEqual([...ignored].sort());
  });

  it("resolves Pi exclusions relative to the repo, not the nested working directory", () => {
    const tracker = createMutationTracker();
    const cwd = path.join(root, "src");
    expect(
      tracker.begin("sibling", "write", { path: "../AGENTS.md", content: after }, cwd),
    ).toBeUndefined();
    for (const file of ignored)
      expect(
        tracker.begin(
          file,
          "write",
          { path: path.relative(cwd, path.join(root, file)), content: after },
          cwd,
        ),
      ).toBeUndefined();
    expect(tracker.begin("source", "write", { path: "a.ts", content: after }, cwd)?.file).toBe(
      path.join(root, source),
    );
  });
});
