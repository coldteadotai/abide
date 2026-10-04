import path from "node:path";
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import {
  AbideError,
  assertNever,
  type Rule,
  type Thresholds,
  type Verdict,
} from "@coldtea/abide-schema";
import { isModelRule } from "./jev.js";
import { ruleAppliesTo } from "./scope.js";
import { readRegularFile } from "./regularFile.js";
import { MAX_DIFF_INPUT_CHARS } from "./constants.js";
import { isExcludedPath, relativeToRoot } from "./paths.js";
import { BINARY_SAMPLE_BYTES, isBinaryContent } from "./binary.js";
import { loudestVerdicts, runCheck, type CheckOutcome } from "./checkRunner.js";

/** An audit is not on the agent's clock: a call may wait out a rate limit rather than count as a miss. */
const AUDIT_CALL_TIMEOUT_MS = 30_000;

const SKIP_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum)$|\.(min\.js|min\.css|map|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|lock|snap|jsonl)$/;

/** Every tracked or untracked-but-not-ignored file under the given paths, repo-relative. */
export const listRepoFiles = (root: string, paths: readonly string[]): string[] => {
  const args = [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...(paths.length ? paths : ["."]),
  ];
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.status !== 0) {
    const code =
      result.error !== undefined && "code" in result.error ? result.error.code : undefined;
    const failure = code === "ETIMEDOUT" ? "timeout" : code === "ENOBUFS" ? "overflow" : "refused";
    switch (failure) {
      case "timeout":
        throw new AbideError("GIT_UNAVAILABLE", "git took too long to list the files");
      case "overflow":
        throw new AbideError("GIT_UNAVAILABLE", "git listed more files than audit can hold");
      case "refused": {
        const said = (result.stderr ?? "")
          .trim()
          .split("\n")[0]
          ?.replace(/^fatal: /, "");
        throw new AbideError(
          "GIT_UNAVAILABLE",
          said ? `git could not list the files: ${said}` : "git could not list the files",
        );
      }
      default:
        return assertNever(failure);
    }
  }
  return result.stdout
    .split("\0")
    .filter((f) => f !== "" && !SKIP_FILE.test(f) && !isExcludedPath(f, root));
};

/** Real path of a file, or nothing if any link on the way leads out of the repo or to an excluded file. */
const insideRepo = (root: string, file: string): string | undefined => {
  if (isExcludedPath(file, root)) return undefined;
  try {
    const base = realpathSync(root);
    const real = realpathSync(path.join(root, file));
    if (!real.startsWith(`${base}${path.sep}`)) return undefined;
    return isExcludedPath(relativeToRoot(base, real), root) ? undefined : real;
  } catch {
    return undefined;
  }
};

export type AuditSkipped = { tooBig: string[]; binary: string[]; outOfScope: number };

/** The files at least one active edit-phase model rule applies to; audits judge nothing else. */
export const auditableFiles = (
  root: string,
  files: readonly string[],
  rules: readonly Rule[],
): { files: string[]; skipped: AuditSkipped } => {
  const editRules = rules.filter(
    (r) => isModelRule(r) && r.status === "active" && r.when === "edit",
  );
  const kept: string[] = [];
  const tooBig: string[] = [];
  const binary: string[] = [];
  let outOfScope = 0;
  for (const file of files) {
    if (!editRules.some((r) => ruleAppliesTo(r, file))) {
      outOfScope += 1;
      continue;
    }
    const real = insideRepo(root, file);
    if (real === undefined) continue;
    try {
      const stat = lstatSync(real);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_DIFF_INPUT_CHARS) {
        tooBig.push(file);
        continue;
      }
    } catch {
      continue;
    }
    const sample = readRegularFile(real, {
      maxBytes: MAX_DIFF_INPUT_CHARS,
      prefixBytes: BINARY_SAMPLE_BYTES,
      followSymlinks: false,
    });
    if (sample !== undefined && isBinaryContent(sample)) {
      binary.push(file);
      continue;
    }
    kept.push(file);
  }
  return { files: kept, skipped: { tooBig, binary, outOfScope } };
};

/** A whole file as one hunk of added lines: how an audit shows a judge a file that was never "changed". */
export const fileAsAdded = (content: string): string => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
};

/** Lines per chunk. A judge asked about a 900 line file answers about the average of it; asked about 150 lines it answers about those lines. */
export const AUDIT_CHUNK_LINES = 150;

/** A file as consecutive hunks of added lines, each small enough to be judged on its own. */
export const fileAsChunks = (content: string, size = AUDIT_CHUNK_LINES): string[] => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return [];
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += size) {
    const part = lines.slice(start, start + size);
    chunks.push(`@@ -0,0 +${start + 1},${part.length} @@\n${part.map((l) => `+${l}`).join("\n")}`);
  }
  return chunks;
};

export type AuditFileResult = {
  file: string;
  verdicts: Verdict[];
  rules: number;
  latencyMs: number;
  costUsd: number;
  /** Chunks the gateway never answered, so the file was judged in part or not at all. */
  chunksFailed?: number;
  chunks?: number;
  error?: string;
};

export type AuditProgress = (done: number, total: number, spendUsd: number) => void;

export type AuditRunResult = { results: AuditFileResult[]; binary: string[] };

export const pool = async <T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(workers);
};

type Judged = { outs: CheckOutcome[]; failed: { text: string; error: string }[]; chunks: number };

const judge = async (
  file: string,
  chunks: readonly string[],
  rules: readonly Rule[],
  thresholds: Thresholds,
): Promise<Judged> => {
  const outs: CheckOutcome[] = [];
  const failed: { text: string; error: string }[] = [];
  for (const text of chunks) {
    try {
      outs.push(
        await runCheck({
          phase: "edit",
          fileDiffs: [{ file, text }],
          rules,
          thresholds,
          timeoutMs: AUDIT_CALL_TIMEOUT_MS,
          retries: 3,
        }),
      );
    } catch (error) {
      failed.push({ text, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { outs, failed, chunks: chunks.length };
};

const summarize = (file: string, judged: Judged): AuditFileResult => {
  const costUsd = judged.outs.reduce((s, o) => s + (o.usage.costUsd ?? 0), 0);
  const last = judged.failed.at(-1);
  return {
    file,
    verdicts: loudestVerdicts(judged.outs.flatMap((o) => o.verdicts)),
    rules: judged.outs[0]?.modelRules.length ?? 0,
    latencyMs: judged.outs.reduce((s, o) => s + o.modelLatencyMs, 0),
    costUsd,
    chunks: judged.chunks,
    ...(judged.failed.length > 0
      ? {
          chunksFailed: judged.failed.length,
          error: `${judged.failed.length} of ${judged.chunks} chunks not judged: ${last?.error ?? "unknown"}`,
        }
      : {}),
  };
};

export const auditFiles = async (
  root: string,
  files: readonly string[],
  rules: readonly Rule[],
  thresholds: Thresholds,
  concurrency: number,
  progress: AuditProgress,
): Promise<AuditRunResult> => {
  const judgedByFile = new Map<string, Judged>();
  const unreadable: AuditFileResult[] = [];
  const binary: string[] = [];
  let done = 0;
  let spendUsd = 0;
  const reportProgress = (): void =>
    progress(done - binary.length, files.length - binary.length, spendUsd);
  await pool(files, concurrency, async (file) => {
    try {
      const real = insideRepo(root, file);
      const bytes =
        real === undefined
          ? undefined
          : readRegularFile(real, { maxBytes: MAX_DIFF_INPUT_CHARS, followSymlinks: false });
      if (bytes === undefined) {
        unreadable.push({
          file,
          verdicts: [],
          rules: 0,
          latencyMs: 0,
          costUsd: 0,
          error:
            "not a regular file inside the repository, or could not be read within the size limit",
        });
        return;
      }
      if (isBinaryContent(bytes)) {
        binary.push(file);
        return;
      }
      const judged = await judge(file, fileAsChunks(bytes.toString("utf8")), rules, thresholds);
      judgedByFile.set(file, judged);
      spendUsd += judged.outs.reduce((s, o) => s + (o.usage.costUsd ?? 0), 0);
    } finally {
      done += 1;
      reportProgress();
    }
  });
  // A second pass, one at a time, for chunks the gateway turned away while it
  // was busy with the rest of the pool. Most of them go through on their own.
  for (const [file, judged] of judgedByFile) {
    if (judged.failed.length === 0) continue;
    const retried = await judge(
      file,
      judged.failed.map((f) => f.text),
      rules,
      thresholds,
    );
    judged.outs.push(...retried.outs);
    judged.failed = retried.failed;
    spendUsd += retried.outs.reduce((s, o) => s + (o.usage.costUsd ?? 0), 0);
    reportProgress();
  }
  return {
    results: [
      ...unreadable,
      ...[...judgedByFile].map(([file, judged]) => summarize(file, judged)),
    ].sort((a, b) => a.file.localeCompare(b.file)),
    binary: binary.sort(),
  };
};

export type RuleTally = { ruleId: string; broken: string[]; flagged: string[]; checked: number };

/** Per rule: which files break it, which are uncertain, how many it saw. Loudest first. */
export const tallyByRule = (results: readonly AuditFileResult[]): RuleTally[] => {
  const byRule = new Map<string, RuleTally>();
  for (const r of results) {
    for (const v of r.verdicts) {
      const t = byRule.get(v.ruleId) ?? { ruleId: v.ruleId, broken: [], flagged: [], checked: 0 };
      t.checked += 1;
      if (v.band === "act") t.broken.push(r.file);
      else if (v.band === "flag") t.flagged.push(r.file);
      byRule.set(v.ruleId, t);
    }
  }
  return [...byRule.values()].sort(
    (a, b) =>
      b.broken.length - a.broken.length ||
      b.flagged.length - a.flagged.length ||
      a.ruleId.localeCompare(b.ruleId),
  );
};
