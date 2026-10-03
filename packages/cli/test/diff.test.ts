import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  addedLines,
  boundState,
  editsFromPostToolUse,
  removedByPatch,
  unifiedDiff,
} from "../src/lib/diff.js";
import { splitDiff } from "../src/lib/git.js";

const base = { session_id: "s", cwd: path.resolve("r"), hook_event_name: "PostToolUse" as const };

describe("hunks from hook payloads", () => {
  it("prefers the host's structured patch for an Edit", () => {
    const [h] = editsFromPostToolUse({
      ...base,
      tool_name: "Edit",
      tool_input: { file_path: "/r/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      tool_response: {
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-const a = 1;", "+const a = 2;"],
          },
        ],
      },
    });
    expect(h?.text).toBe("@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;");
    expect(addedLines(h?.text ?? "")).toEqual(["const a = 2;"]);
  });

  it("synthesizes a hunk when the host sends none", () => {
    const [h] = editsFromPostToolUse({
      ...base,
      tool_name: "Edit",
      tool_input: { file_path: "/r/a.ts", old_string: "x\ny\n", new_string: "x\nz\n" },
    });
    expect(addedLines(h?.text ?? "")).toEqual(["z"]);
  });

  it("treats a new file as all added lines", () => {
    const [h] = editsFromPostToolUse({
      ...base,
      tool_name: "Write",
      tool_input: { file_path: "/r/new.ts", content: "a\nb\n" },
      tool_response: { originalFile: null, structuredPatch: [] },
    });
    expect(h?.isNewFile).toBe(true);
    expect(addedLines(h?.text ?? "")).toEqual(["a", "b"]);
  });

  it("diffs an overwrite against the original", () => {
    const [h] = editsFromPostToolUse({
      ...base,
      tool_name: "Write",
      tool_input: { file_path: "/r/a.ts", content: "a\nc\n" },
      tool_response: { originalFile: "a\nb\n" },
    });
    expect(addedLines(h?.text ?? "")).toEqual(["c"]);
  });

  it("gives up on a diff it cannot compute in time or that is too big to try", () => {
    const lines = (prefix: string) =>
      Array.from({ length: 30_000 }, (_, i) => `${prefix}${i} ${Math.random()}`).join("\n");
    const started = performance.now();
    const [h] = editsFromPostToolUse({
      ...base,
      tool_name: "Write",
      tool_input: { file_path: "/r/big.ts", content: lines("new") },
      tool_response: { originalFile: lines("old"), structuredPatch: [] },
    });
    expect(h?.text).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(6_000);
    expect(unifiedDiff("big.ts", "x".repeat(600_000), "y".repeat(600_000))).toBeUndefined();
  });

  it("reads every file out of a Codex apply_patch", () => {
    const edits = editsFromPostToolUse({
      ...base,
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/new.ts",
          "+export const a = 1;",
          "*** Update File: src/old.ts",
          "@@ export const b = 1;",
          " export const b = 1;",
          "-export const c = 1;",
          "+export const c = 2;",
          "*** Delete File: src/gone.ts",
          "*** End Patch",
        ].join("\n"),
      },
    });
    expect(edits.map((e) => e.filePath)).toEqual([
      path.resolve(base.cwd, "src/new.ts"),
      path.resolve(base.cwd, "src/old.ts"),
    ]);
    expect(edits[0]?.isNewFile).toBe(true);
    expect(addedLines(edits[0]?.text ?? "")).toEqual(["export const a = 1;"]);
    expect(addedLines(edits[1]?.text ?? "")).toEqual(["export const c = 2;"]);
  });

  it("names what an apply_patch deleted or moved away", () => {
    const removed = removedByPatch({
      ...base,
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/new.ts",
          "+export const a = 1;",
          "*** Update File: src/from.ts",
          "*** Move to: src/to.ts",
          "@@",
          "-export const c = 1;",
          "+export const c = 2;",
          "*** Delete File: src/gone.ts",
          "*** End Patch",
        ].join("\n"),
      },
    });
    expect(removed).toEqual([
      path.resolve(base.cwd, "src/from.ts"),
      path.resolve(base.cwd, "src/gone.ts"),
    ]);
  });

  it("bounds the state it sends", () => {
    const big = "+x\n".repeat(20_000);
    const r = boundState(big, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(200);
  });
});

describe("what an edit leaves behind", () => {
  it("derives the file after the edit from the payload, keeping a literal dollar sign", () => {
    const [h] = editsFromPostToolUse({
      session_id: "s",
      cwd: "/r",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/r/a.ts", old_string: "x", new_string: "$&y" },
      tool_response: { originalFile: "x x\n" },
    });
    expect(h?.original).toBe("x x\n");
    expect(h?.after).toBe("$&y x\n");
    const [all] = editsFromPostToolUse({
      session_id: "s",
      cwd: "/r",
      hook_event_name: "PostToolUse",
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "/r/a.ts",
        edits: [
          { old_string: "x", new_string: "y", replace_all: true },
          { old_string: "y y", new_string: "z" },
        ],
      },
      tool_response: { originalFile: "x x\n" },
    });
    expect(all?.after).toBe("z\n");
  });

  it("says nothing about the file after an edit it cannot derive", () => {
    const [h] = editsFromPostToolUse({
      session_id: "s",
      cwd: "/r",
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch" },
    });
    expect(h?.after).toBeNull();
  });
});

describe("unified diffs", () => {
  it("round-trips through splitDiff", () => {
    const patch = unifiedDiff("src/a.ts", "one\ntwo\n", "one\nthree\n") ?? "";
    const files = splitDiff(patch);
    expect(files.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(addedLines(files[0]?.text ?? "")).toEqual(["three"]);
  });

  it("keeps deletions under their old name, alongside additions and edits", () => {
    const patch = [
      unifiedDiff("src/deleted.ts", "gone\n", "") ?? "",
      unifiedDiff("src/added.ts", "", "new\n") ?? "",
      unifiedDiff("src/edited.ts", "a\n", "b\n") ?? "",
    ]
      .join("\n")
      .replace("+++ b/src/deleted.ts", "+++ /dev/null")
      .replace("--- a/src/added.ts", "--- /dev/null");
    const files = splitDiff(patch);
    expect(files.map((f) => f.file).sort()).toEqual([
      "src/added.ts",
      "src/deleted.ts",
      "src/edited.ts",
    ]);
    const deleted = files.find((f) => f.file === "src/deleted.ts");
    expect(deleted?.text).toContain("-gone");
    expect(
      splitDiff(
        (unifiedDiff("only.ts", "x\n", "") ?? "").replace("+++ b/only.ts", "+++ /dev/null"),
      ).map((f) => f.file),
    ).toEqual(["only.ts"]);
  });

  it("drops lockfiles and binaries", () => {
    const patch =
      (unifiedDiff("pnpm-lock.yaml", "a\n", "b\n") ?? "") +
      (unifiedDiff("logo.png", "a\n", "b\n") ?? "");
    expect(splitDiff(patch)).toEqual([]);
  });
});
