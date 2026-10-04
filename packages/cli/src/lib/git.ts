import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parsePatch } from "diff";
import { AbideError } from "@coldtea/abide-schema";
import { GIT_TIMEOUT_MS, MAX_STATE_CHARS } from "./constants.js";
import { renderHunks } from "./diff.js";
import { isExcludedPath, SECRET_FILE_PATTERNS } from "./paths.js";

/**
 * One git call, killed outright at its timeout. A clean filter, LFS, or a slow
 * disk can hold git for longer than a hook may live, and nothing on the main
 * thread can interrupt a synchronous child. stderr is not ours to hold open:
 * a filter that inherited it could keep us waiting after git itself is gone.
 */
const git = (
  root: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
  options: { env?: NodeJS.ProcessEnv; ok?: readonly number[] } = {},
): string | undefined => {
  const { env, ok = [0] } = options;
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.max(1, timeoutMs),
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    ...(env === undefined ? {} : { env }),
  });
  return result.status !== null && ok.includes(result.status) ? result.stdout : undefined;
};

export const isGitRepo = (root: string): boolean =>
  git(root, ["rev-parse", "--is-inside-work-tree"], 2_000) !== undefined;

export const isIgnored = (root: string, relativePath: string): boolean => {
  if (!isGitRepo(root)) return true;
  return git(root, ["check-ignore", "-q", "--", relativePath], 2_000) !== undefined;
};

const SKIP_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum)$|\.(min\.js|min\.css|map|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|lock|snap)$/;

export type FileDiff = { file: string; text: string };

/** Splits a unified diff into per-file hunk text, dropping generated, binary and excluded files. */
export const splitDiff = (patch: string, root?: string): FileDiff[] => {
  const out: FileDiff[] = [];
  for (const file of parsePatch(patch)) {
    // A deletion has no new name: its old one is the file the turn removed.
    const named =
      file.newFileName && file.newFileName !== "/dev/null" ? file.newFileName : file.oldFileName;
    const name = (named ?? "").replace(/^[ab]\//, "");
    if (name === "" || name === "/dev/null" || SKIP_FILE.test(name) || isExcludedPath(name, root)) {
      continue;
    }
    if (file.hunks.length === 0) continue;
    out.push({ file: name, text: renderHunks(file.hunks) });
  }
  return out;
};

export type HistoryHunk = { commit: string; subject: string; file: string; text: string };
export type HistoryCommit = {
  commit: string;
  subject: string;
  files: string[];
  fileDiffs: FileDiff[];
};

/** Recent real changes from this repository's history, for calibration. */
export const recentHistory = (
  root: string,
  wantHunks: number,
  wantCommits: number,
): { hunks: HistoryHunk[]; commits: HistoryCommit[] } => {
  const list = git(root, ["log", "--no-merges", "-n", "60", "--format=%H%x1f%s", "HEAD"]);
  if (list === undefined)
    throw new AbideError("GIT_UNAVAILABLE", "git history is not readable here");
  const hunks: HistoryHunk[] = [];
  const commits: HistoryCommit[] = [];
  const seenFiles = new Set<string>();
  for (const line of list.split("\n")) {
    if (line.trim() === "") continue;
    const [commit, subject = ""] = line.split("\x1f");
    if (commit === undefined) continue;
    if (hunks.length >= wantHunks && commits.length >= wantCommits) break;
    const patch = git(root, [
      "show",
      "--format=",
      "--unified=3",
      "--no-color",
      "--diff-filter=AM",
      commit,
    ]);
    if (patch === undefined || patch.trim() === "") continue;
    const files = splitDiff(patch, root);
    if (files.length === 0) continue;
    if (commits.length < wantCommits) {
      const size = files.reduce((sum, f) => sum + f.text.length, 0);
      if (size >= 200 && size <= MAX_STATE_CHARS) {
        commits.push({ commit, subject, files: files.map((f) => f.file), fileDiffs: files });
      }
    }
    for (const f of files) {
      if (hunks.length >= wantHunks) break;
      const changed = f.text.split("\n").filter((l) => /^[+-](?![+-]{2})/.test(l)).length;
      if (changed < 3 || f.text.length > 6000 || seenFiles.has(f.file)) continue;
      seenFiles.add(f.file);
      hunks.push({ commit, subject, file: f.file, text: f.text });
    }
  }
  return { hunks, commits };
};

/** Uncommitted changes, including staged, as one patch. */
export const workingTreeDiff = (root: string, paths: readonly string[]): string => {
  const hasHead = git(root, ["rev-parse", "--verify", "HEAD"]) !== undefined;
  const base = hasHead
    ? ["diff", "HEAD", "--no-color", "--unified=3"]
    : ["diff", "--cached", "--no-color", "--unified=3"];
  const tracked = git(root, [...base, "--", ...paths]) ?? "";
  const untracked = (
    git(root, ["ls-files", "--others", "--exclude-standard", "--", ...paths]) ?? ""
  )
    .split("\n")
    .filter((f) => f.trim() !== "");
  // --no-index exits 1 when the sides differ.
  const added = untracked
    .map((f) =>
      git(
        root,
        ["diff", "--no-color", "--no-index", "--unified=3", "--", "/dev/null", f],
        GIT_TIMEOUT_MS,
        { ok: [0, 1] },
      ),
    )
    .filter((p): p is string => p !== undefined && p.trim() !== "");
  return [tracked, ...added].join("\n");
};

const indexPath = (root: string): string | undefined => {
  const out = git(root, ["rev-parse", "--git-path", "index"], 2_000);
  if (out === undefined) return undefined;
  const p = out.trim();
  return path.isAbsolute(p) ? p : path.join(root, p);
};

// Never staged, so no snapshot writes a secret into the object store.
const NOT_SECRETS = SECRET_FILE_PATTERNS.map((pattern) => `:(exclude,glob)**/${pattern}`);

/**
 * A tree object for the working tree as it stands now, untracked files
 * included and ignored files excluded, without touching the real index. The
 * real index is copied first so `add -A` only has to look at what changed.
 */
export const snapshotTree = (
  root: string,
  scratchIndex: string,
  timeoutMs: number,
): string | undefined => {
  const deadline = performance.now() + timeoutMs;
  const remaining = (): number => Math.floor(deadline - performance.now());
  try {
    mkdirSync(path.dirname(scratchIndex), { recursive: true });
    const real = indexPath(root);
    if (real !== undefined && existsSync(real)) copyFileSync(real, scratchIndex);
  } catch {
    return undefined;
  }
  const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
  if (
    remaining() <= 0 ||
    git(root, ["add", "-A", "--", ".", ...NOT_SECRETS], remaining(), { env }) === undefined
  )
    return undefined;
  if (remaining() <= 0) return undefined;
  const hash = git(root, ["write-tree"], remaining(), { env })?.trim();
  return hash !== undefined && /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined;
};

/** Blob id per file in a tree; absent files are left out, undefined if git did not answer in time. */
export const blobIdsAt = (
  root: string,
  tree: string,
  files: readonly string[],
  timeoutMs: number,
): Map<string, string> | undefined => {
  if (files.length === 0) return new Map();
  const out = git(root, ["ls-tree", "-r", "-z", tree, "--", ...files], timeoutMs);
  if (out === undefined) return undefined;
  const ids = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t([^]+)$/.exec(entry);
    if (m?.[1] !== undefined && m[2] !== undefined) ids.set(m[2], m[1]);
  }
  return ids;
};

/** Undefined on an unborn branch or a timeout. */
export const headCommit = (root: string, timeoutMs: number): string | undefined => {
  const id = git(root, ["rev-parse", "--verify", "-q", "HEAD"], timeoutMs)?.trim();
  return id !== undefined && /^[0-9a-f]{40,64}$/.test(id) ? id : undefined;
};

/**
 * Files that commits older than `since` changed between two HEADs. Files a
 * newer commit also touched are the turn's own work and left out.
 */
export const filesBroughtIn = (
  root: string,
  from: string,
  to: string,
  since: number,
  timeoutMs: number,
): Set<string> | undefined => {
  const out = git(
    root,
    [
      "log",
      "--no-merges",
      "--no-renames",
      "-z",
      "--format=%x1e%ct",
      "--name-only",
      `${from}...${to}`,
    ],
    timeoutMs,
  );
  if (out === undefined) return undefined;
  const earlier = new Set<string>();
  const during = new Set<string>();
  for (const entry of out.split("\x1e")) {
    const [time = "", ...names] = entry.split("\0");
    if (time.trim() === "") continue;
    const into = Number(time) < since ? earlier : during;
    for (const name of names) {
      const file = name.replace(/^\n/, "");
      if (file !== "") into.add(file);
    }
  }
  return new Set([...earlier].filter((file) => !during.has(file)));
};

/** Everything that changed between two snapshots, as one patch. */
export const diffTrees = (
  root: string,
  base: string,
  now: string,
  timeoutMs: number,
): string | undefined =>
  base === now
    ? ""
    : git(root, ["diff-tree", "-p", "-M", "--no-color", "--unified=3", base, now], timeoutMs);
