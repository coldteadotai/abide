import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Verdict } from "@coldtea/abide-schema";
import type { CheckRequest } from "../src/lib/checkRunner.js";

const verdicts = vi.hoisted(() => ({
  next: [] as Verdict[],
  /** Overrides `next` per request. */
  by: undefined as ((request: CheckRequest) => Verdict[]) | undefined,
  calls: 0,
}));

vi.mock("../src/lib/checkRunner.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/checkRunner.js")>();
  return {
    ...actual,
    runCheck: async (request: CheckRequest) => {
      verdicts.calls += 1;
      return {
        verdicts: verdicts.by?.(request) ?? verdicts.next,
        modelRules: [],
        calls: 1,
        usage: {},
        modelLatencyMs: 0,
      };
    },
  };
});

const { handleStop, turnDiff } = await import("../src/hooks/stop.js");
const { handleTurnStart } = await import("../src/hooks/turnStart.js");
const { recordFileStart, turnDir } = await import("../src/lib/session.js");
const { readEvents } = await import("../src/lib/events.js");

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
    verdicts.by = undefined;
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

  it("names only the file that broke an edit rule, out of every file the turn changed", async () => {
    const root = repoWithUpstream();
    writeFileSync(
      path.join(root, ".abide", "rubric.json"),
      JSON.stringify({
        version: 1,
        compiledAt: "x",
        sources: [{ path: "AGENTS.md" }],
        rules: [{ ...rule, when: "edit" }],
      }),
    );
    await startTurn(root);
    for (const name of ["a.ts", "runner.ts", "z.ts"])
      writeFileSync(path.join(root, name), `export const ${name[0]} = 1;\n`);
    verdicts.by = ({ phase, fileDiffs }) => {
      const file = fileDiffs[0]?.file;
      if (phase !== "edit" || file === undefined) return [];
      return [
        file === "runner.ts"
          ? { ruleId: "comment-volume", probability: 0.8, band: "act", answer: "about half", file }
          : { ruleId: "comment-volume", probability: 0.2, band: "clear", file },
      ];
    };
    const out = await stop(root);
    expect(out.kind).toBe("block");
    if (out.kind === "block") {
      expect(out.reason).toContain("Judged in runner.ts: about half (0.80).");
      expect(out.reason).toContain("Repair runner.ts before you finish.");
      expect(out.reason).not.toMatch(/a\.ts|z\.ts/);
    }
    const check = readEvents(root).find((e) => e.kind === "check");
    expect(check?.kind === "check" && check.verdicts).toEqual([
      {
        ruleId: "comment-volume",
        probability: 0.8,
        band: "act",
        answer: "about half",
        file: "runner.ts",
      },
    ]);
  });

  describe("with another session in the same tree", () => {
    const startAs = (root: string, session: string, prompt = "p") =>
      handleTurnStart({
        session_id: session,
        prompt_id: prompt,
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        prompt: "work",
      });
    const stopAs = (root: string, session: string, prompt = "p") =>
      handleStop({
        session_id: session,
        prompt_id: prompt,
        cwd: root,
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
    /** What Edit or Write records for this session. */
    const editAs = (root: string, session: string, file: string, text: string) => {
      recordFileStart(turnDir(session, "p"), path.join(root, file), null);
      writeFileSync(path.join(root, file), text);
    };
    const age = (session: string, prompt: string, ms: number) => {
      const then = new Date(Date.now() - ms);
      const dir = turnDir(session, prompt);
      utimesSync(path.join(dir, "root"), then, then);
      utimesSync(path.dirname(dir), then, then);
    };

    beforeEach(() => {
      verdicts.next = [{ ruleId: "comment-volume", probability: 0.9, band: "act" }];
    });

    it("does not judge a session that edited nothing for the other's edits", async () => {
      const root = repoWithUpstream();
      await startAs(root, "reviewer");
      await startAs(root, "writer");
      editAs(root, "writer", "mine.ts", "// says m\nexport const m = 1;\n");
      expect(await stopAs(root, "reviewer")).toEqual({ kind: "silent" });
      expect(verdicts.calls).toBe(0);
    });

    it("marks the turn that started first too, and judges only its own edits", async () => {
      const root = repoWithUpstream();
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      editAs(root, "writer", "mine.ts", "// says m\nexport const m = 1;\n");
      writeFileSync(path.join(root, "theirs.ts"), "// says t\nexport const t = 1;\n");
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual(["mine.ts"]);
      const out = await stopAs(root, "writer");
      expect(out.kind).toBe("block");
      if (out.kind === "block") expect(out.reason).not.toContain("theirs.ts");
    });

    it("judges a patched file by what changed, not by all of its content", async () => {
      const root = repoWithUpstream();
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      // apply_patch cannot say what an updated file held before.
      recordFileStart(turnDir("writer", "p"), path.join(root, "src", "shared.ts"), null);
      writeFileSync(path.join(root, "src", "shared.ts"), "export const a = 9;\n");
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual(["src/shared.ts"]);
      const text = turn.kind === "complete" ? (turn.fileDiffs[0]?.text ?? "") : "";
      expect(text).toContain("-export const a = 1;");
      expect(text).toContain("+export const a = 9;");
    });

    it("keeps a file this session deleted, and drops one the other session deleted", async () => {
      const root = repoWithUpstream();
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      recordFileStart(turnDir("writer", "p"), path.join(root, "src", "[id]", "gone.ts"), null);
      rmSync(path.join(root, "src", "[id]", "gone.ts"));
      rmSync(path.join(root, "src", "shared.ts"));
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual(["src/[id]/gone.ts"]);
    });

    it("sees the other session when it reached the repo through a symlink", async () => {
      const root = repoWithUpstream();
      const alias = `${root}-alias`;
      symlinkSync(root, alias);
      await startAs(root, "reviewer");
      await startAs(alias, "writer");
      editAs(alias, "writer", "mine.ts", "// says m\nexport const m = 1;\n");
      expect(await stopAs(root, "reviewer")).toEqual({ kind: "silent" });
      expect(verdicts.calls).toBe(0);
    });

    it("keeps an edit made through a symlinked file", async () => {
      const root = repoWithUpstream();
      symlinkSync("shared.ts", path.join(root, "src", "alias.ts"));
      sh(root, "git add -A && git commit -qm alias");
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      editAs(root, "writer", "src/alias.ts", "export const a = 9;\n");
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual(["src/shared.ts"]);
    });

    it("keeps the file an alias reached when the edit was made, not what it points at later", async () => {
      const root = repoWithUpstream();
      symlinkSync("shared.ts", path.join(root, "src", "alias.ts"));
      writeFileSync(path.join(root, "src", "theirs.ts"), "export const t = 1;\n");
      sh(root, "git add -A && git commit -qm alias");
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      editAs(root, "writer", "src/alias.ts", "export const a = 9;\n");
      rmSync(path.join(root, "src", "alias.ts"));
      symlinkSync("theirs.ts", path.join(root, "src", "alias.ts"));
      writeFileSync(path.join(root, "src", "theirs.ts"), "export const t = 2;\n");
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual(["src/alias.ts", "src/shared.ts"]);
    });

    it("keeps every file an alias reached, when the session retargets it between edits", async () => {
      const root = repoWithUpstream();
      symlinkSync("shared.ts", path.join(root, "src", "alias.ts"));
      writeFileSync(path.join(root, "src", "second.ts"), "export const s = 1;\n");
      sh(root, "git add -A && git commit -qm alias");
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      editAs(root, "writer", "src/alias.ts", "export const a = 9;\n");
      rmSync(path.join(root, "src", "alias.ts"));
      symlinkSync("second.ts", path.join(root, "src", "alias.ts"));
      editAs(root, "writer", "src/alias.ts", "export const s = 2;\n");
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual([
        "src/alias.ts",
        "src/second.ts",
        "src/shared.ts",
      ]);
    });

    it("keeps a file this session deleted through a symlinked directory", async () => {
      const root = repoWithUpstream();
      symlinkSync("[id]", path.join(root, "src", "linked"));
      sh(root, "git add -A && git commit -qm linked");
      await startAs(root, "writer");
      await startAs(root, "reviewer");
      rmSync(path.join(root, "src", "linked", "gone.ts"));
      recordFileStart(turnDir("writer", "p"), path.join(root, "src", "linked", "gone.ts"), null);
      const turn = turnDiff(root, turnDir("writer", "p"));
      expect(turn.kind === "complete" && turn.files).toEqual(["src/[id]/gone.ts"]);
    });

    it("still judges a lone session's shell edits", async () => {
      const root = repoWithUpstream();
      await startAs(root, "writer");
      writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
      expect((await stopAs(root, "writer")).kind).toBe("block");
    });

    it("ignores a turn left open past the age bound", async () => {
      const root = repoWithUpstream();
      await startAs(root, "interrupted");
      age("interrupted", "p", 3 * 60 * 60 * 1000);
      await startAs(root, "writer");
      writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
      expect((await stopAs(root, "writer")).kind).toBe("block");
    });

    it("ignores a session's older turn once it has started a newer one elsewhere", async () => {
      const root = repoWithUpstream();
      const elsewhere = repoWithUpstream();
      await startAs(root, "other", "first");
      age("other", "first", 60 * 1000);
      await startAs(elsewhere, "other", "second");
      await startAs(root, "writer");
      writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
      expect((await stopAs(root, "writer")).kind).toBe("block");
    });

    it("ignores a session working in another tree", async () => {
      const root = repoWithUpstream();
      const other = `${root}-worktree`;
      sh(root, `git worktree add -q "${other}" upstream`);
      await startAs(other, "other");
      await startAs(root, "writer");
      writeFileSync(path.join(root, "mine.ts"), "// says m\nexport const m = 1;\n");
      expect((await stopAs(root, "writer")).kind).toBe("block");
    });
  });
});
