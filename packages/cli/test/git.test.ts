import path from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createBlobId } from "@coldtea/abide-schema";
import { blobIdsAt, snapshotTree, splitDiff, workingTreeDiff } from "../src/lib/git.js";

describe("the working tree diff", () => {
  it("leaves staged and untracked binary content out of the model diff", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-git-"));
    execSync("git init -q .", { cwd: root });
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    writeFileSync(path.join(root, "template.docx"), binary);
    execSync("git add template.docx", { cwd: root });
    writeFileSync(path.join(root, "unknown"), binary);
    writeFileSync(path.join(root, "new.ts"), "export const b = 1;\n");
    expect(splitDiff(workingTreeDiff(root, [])).map((f) => f.file)).toEqual(["new.ts"]);
  });

  it("includes files git does not track yet", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-git-"));
    execSync("git init -q .", { cwd: root });
    writeFileSync(path.join(root, "tracked.ts"), "export const a = 1;\n");
    execSync("git add . && git -c user.email=a@b -c user.name=a commit -q -m init", { cwd: root });
    writeFileSync(path.join(root, "tracked.ts"), "export const a = 2;\n");
    writeFileSync(path.join(root, "new.ts"), "export const b = 1;\n");
    const files = splitDiff(workingTreeDiff(root, []));
    expect(files.map((f) => f.file).sort()).toEqual(["new.ts", "tracked.ts"]);
    expect(files.find((f) => f.file === "new.ts")?.text).toContain("+export const b = 1;");
  });

  it("leaves secret files out of every patch it splits", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-git-"));
    execSync("git init -q .", { cwd: root });
    writeFileSync(path.join(root, ".env"), "KEY=1\n");
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(splitDiff(workingTreeDiff(root, [])).map((f) => f.file)).toEqual(["a.ts"]);
  });
});

describe("the turn snapshot", () => {
  it("names each file's content as git does, and never stages a secret file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-git-"));
    execSync("git init -q .", { cwd: root });
    mkdirSync(path.join(root, "apps"));
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, ".env"), "KEY=1\n");
    writeFileSync(path.join(root, "apps", ".env.local"), "KEY=2\n");
    writeFileSync(path.join(root, "apps", "server.key"), "k\n");
    const tree = snapshotTree(root, path.join(root, ".git", "abide-index"), 5_000);
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    if (tree === undefined) return;
    const ids = blobIdsAt(
      root,
      tree,
      ["a.ts", ".env", "apps/.env.local", "apps/server.key"],
      5_000,
    );
    expect(ids).toEqual(new Map([["a.ts", createBlobId("export const a = 1;\n")]]));
    const staged = execSync("git ls-tree -r --name-only " + tree, { cwd: root, encoding: "utf8" });
    expect(staged.trim().split("\n")).toEqual(["a.ts"]);
    expect(blobIdsAt(root, tree, [], 5_000)).toEqual(new Map());
    expect(blobIdsAt(root, "0".repeat(40), ["a.ts"], 5_000)).toBeUndefined();
  });
});
