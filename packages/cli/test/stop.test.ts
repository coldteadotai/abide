import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Verdict } from "@coldtea/abide-schema";

const verdicts = vi.hoisted(() => ({ next: [] as Verdict[], calls: 0 }));

vi.mock("../src/lib/checkRunner.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/checkRunner.js")>();
  return {
    ...actual,
    runCheck: async () => {
      verdicts.calls += 1;
      return { verdicts: verdicts.next, modelRules: [], calls: 1, usage: {}, modelLatencyMs: 0 };
    },
  };
});

const { handleStop, turnDiff } = await import("../src/hooks/stop.js");
const { handleTurnStart } = await import("../src/hooks/turnStart.js");
const { turnDir } = await import("../src/lib/session.js");

const OLD = { GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" };

const sh = (root: string, command: string, env: NodeJS.ProcessEnv = {}): string =>
  execSync(command, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "a",
      GIT_AUTHOR_EMAIL: "a@b",
      GIT_COMMITTER_NAME: "a",
      GIT_COMMITTER_EMAIL: "a@b",
      ...env,
    },
  });

const rule = {
  id: "comment-volume",
  text: "Comment sparingly",
  source: { path: "AGENTS.md" },
  when: "turn",
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
};

/** `upstream` predates the turn: it edits, adds and deletes a file. */
const repoWithUpstream = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-stop-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".abide"));
  writeFileSync(
    path.join(root, ".abide", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [rule],
    }),
  );
  mkdirSync(path.join(root, "src", "[id]"), { recursive: true });
  writeFileSync(path.join(root, "src", "shared.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src", "[id]", "gone.ts"), "export const g = 1;\n");
  sh(root, "git init -q -b main . && git add -A && git commit -q -m init", OLD);
  sh(root, "git checkout -q -b upstream");
  writeFileSync(
    path.join(root, "src", "shared.ts"),
    "// a comment\n// another\nexport const a = 2;\n",
  );
  writeFileSync(path.join(root, "src", "added.ts"), "// explains b\nexport const b = 1;\n");
  rmSync(path.join(root, "src", "[id]", "gone.ts"));
  sh(root, "git add -A && git commit -q -m upstream", OLD);
  sh(root, "git checkout -q main");
  return root;
};

const base = (root: string) => ({ session_id: "s", prompt_id: "p", cwd: root });

const startTurn = async (root: string): Promise<void> => {
  await handleTurnStart({
    ...base(root),
    hook_event_name: "UserPromptSubmit",
    prompt: "pull remote",
  });
};

const stop = (root: string) =>
  handleStop({ ...base(root), hook_event_name: "Stop", stop_hook_active: false });

describe("the Stop check", () => {
  beforeEach(() => {
    process.env.ABIDE_HOME_DIR = mkdtempSync(path.join(tmpdir(), "abide-home-"));
    verdicts.next = [];
    verdicts.calls = 0;
  });
  afterEach(() => {
    delete process.env.ABIDE_HOME_DIR;
  });

  it("leaves out what a fast-forward brought in, deletions included", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    writeFileSync(path.join(root, "mine.ts"), "export const m = 1;\n");
    sh(root, "git merge -q --ff-only upstream");
    const turn = turnDiff(root, turnDir("s", "p"));
    expect(turn.kind).toBe("complete");
    if (turn.kind !== "complete") return;
    expect(turn.files).toEqual(["mine.ts"]);
  });

  it("still sees what the agent changed in a pulled file after the pull", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    sh(root, "git merge -q --no-edit --no-ff upstream");
    writeFileSync(
      path.join(root, "src", "shared.ts"),
      "// a comment\n// another\nexport const a = 3;\n",
    );
    const turn = turnDiff(root, turnDir("s", "p"));
    expect(turn.kind).toBe("complete");
    if (turn.kind !== "complete") return;
    expect(turn.files).toEqual(["src/shared.ts"]);
    const text = turn.fileDiffs[0]?.text ?? "";
    expect(text).toContain("+export const a = 3;");
    expect(text).toContain("-export const a = 2;");
    expect(text).not.toContain("+// a comment");
  });

  it("still sees work the agent committed during the turn", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    writeFileSync(path.join(root, "src", "shared.ts"), "export const a = 5;\n");
    sh(root, "git commit -qam mine");
    const turn = turnDiff(root, turnDir("s", "p"));
    expect(turn.kind).toBe("complete");
    if (turn.kind !== "complete") return;
    expect(turn.files).toEqual(["src/shared.ts"]);
  });

  it("does not block a second time on a diff the agent left unchanged", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
    verdicts.next = [
      { ruleId: "comment-volume", probability: 0.9, band: "act", answer: "about half" },
    ];
    const first = await stop(root);
    expect(first.kind).toBe("block");
    if (first.kind === "block") expect(first.reason).toContain("Repair mine.ts before you finish");
    const second = await stop(root);
    expect(second.kind).toBe("notice");
    expect(verdicts.calls).toBe(2);
  });

  it("checks again once the agent changes something after a block", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
    verdicts.next = [{ ruleId: "comment-volume", probability: 0.9, band: "act" }];
    expect((await stop(root)).kind).toBe("block");
    writeFileSync(path.join(root, "mine.ts"), "export const m = 1;\n");
    verdicts.next = [];
    expect((await stop(root)).kind).toBe("silent");
    expect(verdicts.calls).toBe(4);
  });

  it("does not diff a turn that started in one worktree and stopped in another", async () => {
    const root = repoWithUpstream();
    const other = `${root}-worktree`;
    sh(root, `git worktree add -q "${other}" upstream`);
    await startTurn(other);
    verdicts.next = [{ ruleId: "comment-volume", probability: 0.9, band: "act" }];
    expect(turnDiff(root, turnDir("s", "p")).kind).toBe("incomplete");
    expect((await stop(root)).kind).toBe("silent");
    expect(verdicts.calls).toBe(0);
  });

  it("still checks a turn that stopped in a subdirectory of the repo it started in", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
    verdicts.next = [{ ruleId: "comment-volume", probability: 0.9, band: "act" }];
    expect((await stop(path.join(root, "src"))).kind).toBe("block");
  });

  it("names only files that still exist, and never blocks a turn that only deleted files", async () => {
    const root = repoWithUpstream();
    await startTurn(root);
    rmSync(path.join(root, "src", "shared.ts"));
    verdicts.next = [{ ruleId: "comment-volume", probability: 0.9, band: "act" }];
    expect((await stop(root)).kind).toBe("notice");

    await startTurn(root);
    writeFileSync(path.join(root, "mine.ts"), "export const m = 1;\n");
    rmSync(path.join(root, "src", "[id]", "gone.ts"));
    const out = await stop(root);
    expect(out.kind).toBe("block");
    if (out.kind === "block") {
      expect(out.reason).toContain("Repair mine.ts before");
      expect(out.reason).not.toContain("gone.ts");
    }
  });
});
