import { existsSync } from "node:fs";
import path from "node:path";
import {
  assertNever,
  createBlobId,
  isAbideError,
  stopInputSchema,
  turnIdOf,
  type HookOutput,
  type Rule,
  type Verdict,
} from "@coldtea/abide-schema";
import { mergeOutcomes, runCheck, type CheckOutcome } from "../lib/checkRunner.js";
import {
  MAX_STOP_CHECKS_PER_TURN,
  STOP_FALLBACK_DIFF_TIMEOUT_MS,
  STOP_GIT_TIMEOUT_MS,
  TURN_CHECK_TIMEOUT_MS,
} from "../lib/constants.js";
import { editsCoverFile } from "../lib/coverage.js";
import { boundState, remainingMs, unifiedDiff } from "../lib/diff.js";
import { appendEvent } from "../lib/events.js";
import {
  blobIdsAt,
  diffTrees,
  filesBroughtIn,
  headCommit,
  snapshotTree,
  splitDiff,
  type FileDiff,
} from "../lib/git.js";
import { hasApiKey } from "../lib/credentials.js";
import { loadRules } from "../lib/loadRules.js";
import { debug } from "../lib/output.js";
import { findRepoRoot, isExcludedPath, physicalPath, relativeToRoot } from "../lib/paths.js";
import { readRegularFile, readRegularText } from "../lib/regularFile.js";
import { filesToRepair, flagNotice, repairReason } from "../lib/reason.js";
import {
  clearTurn,
  createTurnDiffKey,
  hasTurnState,
  incrementStopChecks,
  isShared,
  readBaseline,
  readBlockedFiles,
  readBaselineStatus,
  readChecked,
  readFileStarts,
  readPrompt,
  readTouched,
  readTurnHead,
  readTurnRoot,
  recordBlockedDiff,
  stopCheckCount,
  turnDir,
  wasBlockedOn,
} from "../lib/session.js";
import { lastUserPrompt } from "../lib/transcript.js";

export type TurnDiff =
  | {
      kind: "complete";
      files: string[];
      fileDiffs: FileDiff[];
      source: "git" | "files";
      /** Blob id at turn start per file; null if absent then, undefined if git could not say. */
      startIds: Map<string, string | null> | undefined;
    }
  /** Part of the turn could not be read back in time. A judgment on the rest would be a judgment on a different change. */
  | { kind: "incomplete"; reason: string; missing: string[] };

const incomplete = (reason: string): TurnDiff => ({ kind: "incomplete", reason, missing: [] });

/** Pulled-in files diff against the new HEAD: they aren't the agent's edits. */
const gitTurnDiff = (root: string, dir: string, baseline: string): TurnDiff => {
  const deadline = performance.now() + STOP_GIT_TIMEOUT_MS;
  const left = (): number => Math.floor(deadline - performance.now());
  const now = snapshotTree(root, path.join(dir, "index"), left());
  const patch =
    now === undefined || left() <= 0 ? undefined : diffTrees(root, baseline, now, left());
  if (now === undefined || patch === undefined)
    return incomplete("git could not snapshot the working tree in time");

  const start = readTurnHead(dir);
  const head = start === undefined ? undefined : headCommit(root, left());
  if (start !== undefined && head === undefined)
    return incomplete("git could not read HEAD in time");
  const brought =
    start === undefined || head === undefined || head === start.commit
      ? new Set<string>()
      : filesBroughtIn(root, start.commit, head, start.startedAt, left());
  if (brought === undefined) return incomplete("git could not list the commits HEAD moved across");
  const sinceHead =
    head === undefined || brought.size === 0 ? "" : diffTrees(root, head, now, left());
  if (sinceHead === undefined) return incomplete("git could not diff against the new HEAD in time");

  const fileDiffs = [
    ...splitDiff(patch).filter((f) => !brought.has(f.file)),
    ...splitDiff(sinceHead).filter((f) => brought.has(f.file)),
  ];
  const files = fileDiffs.map((f) => f.file);
  const ownIds = blobIdsAt(
    root,
    baseline,
    files.filter((f) => !brought.has(f)),
    left(),
  );
  const pulledIds =
    head === undefined
      ? new Map<string, string>()
      : blobIdsAt(
          root,
          head,
          files.filter((f) => brought.has(f)),
          left(),
        );
  return {
    kind: "complete",
    files,
    fileDiffs,
    source: "git",
    startIds:
      ownIds === undefined || pulledIds === undefined
        ? undefined
        : new Map(files.map((f) => [f, (brought.has(f) ? pulledIds : ownIds).get(f) ?? null])),
  };
};

const ownFiles = (root: string, dir: string, turn: TurnDiff): TurnDiff => {
  if (turn.kind === "incomplete") return turn;
  // Git names an edit made through a symlink by the link's target.
  const physicalRoot = physicalPath(root);
  const own = new Set([
    ...readFileStarts(dir).map((start) => relativeToRoot(root, start.path)),
    ...readTouched(dir).map((file) => relativeToRoot(physicalRoot, file)),
  ]);
  const fileDiffs = turn.fileDiffs.filter((f) => own.has(f.file));
  return {
    ...turn,
    files: fileDiffs.map((f) => f.file),
    fileDiffs,
  };
};

/**
 * Everything the turn changed. With a baseline from turn-start it is the git
 * diff between then and now, whichever tool made the change. Without one it
 * is each file's start-of-turn content against the disk, which sees only what
 * Edit and Write touched. Every diff here shares one budget, and a turn that
 * did not fit in it is reported as incomplete rather than checked in part.
 * A turn shared with another session keeps only files its own edit tools touched.
 */
export const turnDiff = (root: string, dir: string): TurnDiff => {
  const status = readBaselineStatus(dir);
  if (status === "failed" || status === "pending")
    return incomplete("git could not snapshot the working tree at turn start");
  const baseline = readBaseline(dir);
  const startRoot = readTurnRoot(dir);
  if (baseline !== undefined && startRoot !== undefined && startRoot !== root)
    return incomplete(`the turn started in ${startRoot} and ended in ${root}`);
  if (baseline !== undefined) {
    const turn = gitTurnDiff(root, dir, baseline);
    // After the snapshot: a later session marks this turn before it can edit.
    return isShared(dir) ? ownFiles(root, dir, turn) : turn;
  }
  const deadline = performance.now() + STOP_FALLBACK_DIFF_TIMEOUT_MS;
  const fileDiffs: FileDiff[] = [];
  const missing: string[] = [];
  const startIds = new Map<string, string | null>();
  for (const start of readFileStarts(dir)) {
    const relative = relativeToRoot(root, start.path);
    if (relative.startsWith("..") || isExcludedPath(relative)) continue;
    const after = readRegularText(start.path) ?? null;
    if (after === null && existsSync(start.path)) {
      missing.push(relative);
      continue;
    }
    if (start.original === after) continue;
    const patch = unifiedDiff(relative, start.original ?? "", after ?? "", remainingMs(deadline));
    if (patch === undefined) {
      missing.push(relative);
      continue;
    }
    fileDiffs.push(...splitDiff(patch));
    startIds.set(relative, start.original === null ? null : createBlobId(start.original));
  }
  if (missing.length > 0) {
    return {
      kind: "incomplete",
      reason: "some files changed this turn could not be diffed in time",
      missing,
    };
  }
  return {
    kind: "complete",
    files: fileDiffs.map((f) => f.file),
    fileDiffs,
    source: "files",
    startIds,
  };
};

type Pair = { rule: Rule; verdict: Verdict };

export const handleStop = async (raw: unknown): Promise<HookOutput> => {
  const parsed = stopInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const dir = turnDir(input.session_id, turnIdOf(input));
  switch (input.turn_state) {
    case "clear":
      clearTurn(dir);
      return { kind: "silent" };
    case "finish":
    case "preserve":
      break;
    default:
      return assertNever(input.turn_state);
  }
  const started = performance.now();
  const at = new Date().toISOString();
  const root = findRepoRoot(input.cwd);

  const finish = (output: HookOutput): HookOutput => {
    if (output.kind !== "block" && input.turn_state === "finish") clearTurn(dir);
    return output;
  };

  if (!hasTurnState(dir)) return finish({ kind: "silent" });
  if (stopCheckCount(dir) >= MAX_STOP_CHECKS_PER_TURN) return finish({ kind: "silent" });

  const loaded = loadRules(root);
  for (const problem of loaded.problems) debug(problem);
  if (loaded.rules.length === 0) return finish({ kind: "silent" });

  const turn = turnDiff(root, dir);
  if (turn.kind === "incomplete") {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      reason: `turn diff incomplete: ${turn.reason}`,
      files: turn.missing,
    });
    return finish({ kind: "silent" });
  }
  const { files, fileDiffs } = turn;
  if (files.length === 0) return finish({ kind: "silent" });
  const bounded = fileDiffs.map((f) => ({
    file: f.file,
    text: boundState(f.text, 8_000).text,
  }));
  // Same diff as the last block: the agent declined, so don't loop.
  const diffKey = createTurnDiffKey(bounded);
  if (wasBlockedOn(dir, diffKey)) {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      reason: "unchanged since the last block, so the agent declined the repair",
      files,
    });
    return finish({
      kind: "notice",
      systemMessage: `Abide: the turn ended without the repair it was blocked for (${files.join(", ")}). Not blocking again. Details in .abide/events.jsonl.`,
    });
  }

  if (!hasApiKey(root)) {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      reason: "no api key",
      files,
    });
  }

  if (input.turn_state === "finish") incrementStopChecks(dir);
  // Edit-phase rules rerun on files the edit checks did not see whole, and on
  // blocked ones: a block the agent ignored must not end the turn quietly.
  const checked = readChecked(dir);
  const blocked = readBlockedFiles(dir);
  const covered = (file: string): boolean => {
    if (turn.startIds === undefined || blocked.has(file)) return false;
    const now = readRegularFile(path.join(root, file));
    if (now === undefined) return false;
    const start = turn.startIds.get(file) ?? null;
    return editsCoverFile(
      start,
      checked.filter((e) => e.path === file),
      createBlobId(now),
    );
  };
  const unchecked = bounded.filter((f) => !covered(f.file));
  const task =
    lastUserPrompt(input.transcript_path ?? undefined) ?? input.prompt ?? readPrompt(dir);
  let outcomes: CheckOutcome[];
  try {
    const turnOutcome = await runCheck({
      phase: "turn",
      fileDiffs: bounded,
      task,
      rules: loaded.rules,
      thresholds: loaded.thresholds,
      timeoutMs: TURN_CHECK_TIMEOUT_MS,
    });
    const editOutcomes = await Promise.all(
      unchecked.map((f) =>
        runCheck({
          phase: "edit",
          fileDiffs: [f],
          task,
          rules: loaded.rules,
          thresholds: loaded.thresholds,
          timeoutMs: TURN_CHECK_TIMEOUT_MS,
        }),
      ),
    );
    outcomes = [turnOutcome, ...editOutcomes];
  } catch (error) {
    appendEvent(root, {
      kind: "error",
      at,
      phase: "turn",
      sessionId: input.session_id,
      code: isAbideError(error) ? error.code : "CHECK_FAILED",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started),
    });
    return finish({ kind: "silent" });
  }

  const outcome = mergeOutcomes(outcomes);
  const byId = new Map(loaded.rules.map((r) => [r.id, r]));
  const toPairs = (verdicts: readonly Verdict[]): Pair[] =>
    verdicts.flatMap((verdict) => {
      const rule = byId.get(verdict.ruleId);
      return rule === undefined ? [] : [{ rule, verdict }];
    });
  // Deleted files cannot be repaired.
  const repairable = files.filter((f) => existsSync(path.join(root, f)));
  // Unmerged, so every broken file is named.
  const acting = toPairs(outcomes.flatMap((o) => o.verdicts)).filter(
    (p) => p.verdict.band === "act" && filesToRepair([p], repairable).length > 0,
  );
  if (input.turn_state === "preserve" && acting.length > 0) incrementStopChecks(dir);
  const flagged = toPairs(outcome.verdicts).filter(
    (p) => p.verdict.band !== "clear" && !acting.some((a) => a.rule.id === p.rule.id),
  );

  appendEvent(root, {
    kind: "check",
    at,
    phase: "turn",
    sessionId: input.session_id,
    promptId: turnIdOf(input),
    files,
    rules: outcome.modelRules.length,
    latencyMs: Math.round(performance.now() - started),
    modelLatencyMs: outcome.modelLatencyMs,
    usage: outcome.usage,
    verdicts: outcome.verdicts,
    blocked: acting.length > 0,
  });

  const systemMessage = flagged.length > 0 ? flagNotice("turn", flagged, files) : undefined;
  if (acting.length > 0) {
    recordBlockedDiff(dir, diffKey);
    return finish({
      kind: "block",
      reason: repairReason("turn", acting, repairable),
      ...(systemMessage === undefined ? {} : { systemMessage }),
    });
  }
  return finish(
    systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage },
  );
};
