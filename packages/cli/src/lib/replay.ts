import path from "node:path";
import {
  postToolUseInputSchema,
  type PostToolUseInput,
  type Rule,
  type Thresholds,
  type Verdict,
} from "@coldtea/abide-schema";
import { pool } from "./audit.js";
import { runCheck } from "./checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS, MAX_TASK_CHARS, TURN_CHECK_TIMEOUT_MS } from "./constants.js";
import { boundState, editsFromPostToolUse } from "./diff.js";
import type { FileDiff } from "./git.js";
import { findRepoRoot, isExcludedPath, relativeToRoot } from "./paths.js";
import { readSessionLines } from "./replayJsonl.js";

/**
 * A past coding session, read back from the host's transcript, so every edit
 * it made can be judged as if abide had been installed at the time. Nothing
 * here touches the working tree: the diffs come from the transcript alone.
 */
export type ReplayEdit = { turn: number; input: PostToolUseInput };
export type ReplayTurn = { index: number; prompt: string | undefined; edits: ReplayEdit[] };
export type ReplaySession = { file: string; cwd: string; turns: ReplayTurn[] };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

type ToolUse = { id: string; name: string; input: unknown; turn: number };

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record;
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const promptText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content.trim() === "" ? undefined : content;
  const parts = asList(content).flatMap((p) => {
    const part = asRecord(p);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
  const hasToolResult = asList(content).some((p) => asRecord(p)?.type === "tool_result");
  if (hasToolResult || parts.length === 0) return undefined;
  return parts.join("\n");
};

export const parseTranscript = async (file: string): Promise<ReplaySession> => {
  const turns: ReplayTurn[] = [];
  const uses = new Map<string, ToolUse>();
  let cwd: string | undefined;
  let turnIndex = 0;
  const current = (): ReplayTurn => {
    const last = turns.at(-1);
    if (last !== undefined) return last;
    const first: ReplayTurn = { index: 0, prompt: undefined, edits: [] };
    turns.push(first);
    return first;
  };
  for await (const line of readSessionLines(file, () => cwd)) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      // a torn line, still being written
      continue;
    }
    if (entry === undefined) continue;
    if (typeof entry.cwd === "string") cwd ??= entry.cwd;
    const message = asRecord(entry.message);
    if (entry.type === "user" && entry.isMeta !== true) {
      const prompt = promptText(message?.content);
      if (prompt !== undefined) {
        turnIndex += 1;
        turns.push({ index: turnIndex, prompt: prompt.slice(0, MAX_TASK_CHARS), edits: [] });
      }
      const result = asRecord(entry.toolUseResult);
      for (const p of asList(message?.content)) {
        const part = asRecord(p);
        if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
        const use = uses.get(part.tool_use_id);
        if (use === undefined) continue;
        uses.delete(part.tool_use_id);
        const parsed = postToolUseInputSchema.safeParse({
          session_id: path.basename(file, ".jsonl"),
          cwd: cwd ?? process.cwd(),
          hook_event_name: "PostToolUse",
          tool_name: use.name,
          tool_use_id: use.id,
          tool_input: use.input,
          ...(result === undefined ? {} : { tool_response: result }),
        });
        if (!parsed.success) continue;
        const turn = turns.find((t) => t.index === use.turn) ?? current();
        turn.edits.push({ turn: turn.index, input: parsed.data });
      }
    }
    if (entry.type === "assistant") {
      for (const p of asList(message?.content)) {
        const part = asRecord(p);
        if (part?.type !== "tool_use" || typeof part.id !== "string") continue;
        if (typeof part.name !== "string" || !EDIT_TOOLS.has(part.name)) continue;
        uses.set(part.id, { id: part.id, name: part.name, input: part.input, turn: turnIndex });
      }
    }
  }
  return { file, cwd: cwd ?? process.cwd(), turns: turns.filter((t) => t.edits.length > 0) };
};

export type ReplayEditResult = {
  session: string;
  turn: number;
  file: string;
  verdicts: Verdict[];
  costUsd: number;
  error?: string;
  diff?: string;
  task?: string;
};

export type ReplayTurnResult = {
  session: string;
  turn: number;
  files: string[];
  verdicts: Verdict[];
  costUsd: number;
  error?: string;
};

export type ReplayResult = { edits: ReplayEditResult[]; turns: ReplayTurnResult[] };

export type ReplayProgress = (done: number, total: number, spendUsd: number) => void;

const failed = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Judges every edit of every session as the edit hook would have, then every
 * turn as the stop hook would have, from the edits alone. Shell-made changes
 * are not in a transcript and are not judged.
 */
export const replaySessions = async (
  sessions: readonly ReplaySession[],
  rules: readonly Rule[],
  thresholds: Thresholds,
  concurrency: number,
  progress: ReplayProgress,
  keepDiffs = false,
): Promise<ReplayResult> => {
  type Job = { session: ReplaySession; turn: ReplayTurn; edit: ReplayEdit };
  const jobs: Job[] = sessions.flatMap((session) =>
    session.turns.flatMap((turn) => turn.edits.map((edit) => ({ session, turn, edit }))),
  );
  const edits: ReplayEditResult[] = [];
  const turnDiffs = new Map<
    string,
    { session: ReplaySession; turn: ReplayTurn; files: Map<string, string[]> }
  >();
  let done = 0;
  let spendUsd = 0;
  await pool(jobs, concurrency, async ({ session, turn, edit }) => {
    const root = findRepoRoot(session.cwd);
    const name = path.basename(session.file, ".jsonl");
    for (const hunk of editsFromPostToolUse(edit.input)) {
      const relative = relativeToRoot(root, hunk.filePath);
      if (relative.startsWith("..") || isExcludedPath(relative) || hunk.text === undefined)
        continue;
      const { text } = boundState(hunk.text);
      if (text.trim() === "") continue;
      const key = `${name}:${turn.index}`;
      const bucket = turnDiffs.get(key) ?? { session, turn, files: new Map<string, string[]>() };
      bucket.files.set(relative, [...(bucket.files.get(relative) ?? []), text]);
      turnDiffs.set(key, bucket);
      try {
        const out = await runCheck({
          phase: "edit",
          fileDiffs: [{ file: relative, text }],
          task: turn.prompt,
          rules,
          thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
          retries: 2,
        });
        spendUsd += out.usage.costUsd ?? 0;
        edits.push({
          session: name,
          turn: turn.index,
          file: relative,
          verdicts: out.verdicts,
          costUsd: out.usage.costUsd ?? 0,
          ...(keepDiffs
            ? { diff: text, ...(turn.prompt === undefined ? {} : { task: turn.prompt }) }
            : {}),
        });
      } catch (error) {
        edits.push({
          session: name,
          turn: turn.index,
          file: relative,
          verdicts: [],
          costUsd: 0,
          error: failed(error),
        });
      }
    }
    done += 1;
    progress(done, jobs.length, spendUsd);
  });

  const turns: ReplayTurnResult[] = [];
  await pool([...turnDiffs.values()], concurrency, async ({ session, turn, files }) => {
    const name = path.basename(session.file, ".jsonl");
    const fileDiffs: FileDiff[] = [...files.entries()].map(([file, texts]) => ({
      file,
      text: boundState(texts.join("\n"), 8_000).text,
    }));
    try {
      const out = await runCheck({
        phase: "turn",
        fileDiffs,
        task: turn.prompt,
        rules,
        thresholds,
        timeoutMs: TURN_CHECK_TIMEOUT_MS,
        retries: 2,
      });
      spendUsd += out.usage.costUsd ?? 0;
      turns.push({
        session: name,
        turn: turn.index,
        files: fileDiffs.map((f) => f.file),
        verdicts: out.verdicts,
        costUsd: out.usage.costUsd ?? 0,
      });
    } catch (error) {
      turns.push({
        session: name,
        turn: turn.index,
        files: fileDiffs.map((f) => f.file),
        verdicts: [],
        costUsd: 0,
        error: failed(error),
      });
    }
    progress(done, jobs.length, spendUsd);
  });
  return { edits, turns };
};

/** Turn ranges the drift is reported over. The first covers the session's opening, where instructions are fresh. */
export const DRIFT_BUCKETS: readonly { label: string; from: number; to: number }[] = [
  { label: "turns 1 to 5", from: 1, to: 5 },
  { label: "turns 6 to 15", from: 6, to: 15 },
  { label: "turns 16 and later", from: 16, to: Infinity },
];

export type DriftRow = {
  label: string;
  edits: number;
  broken: number;
  /** Share of judged edits with at least one rule above the act line. */
  rate: number;
};

export const driftByTurn = (edits: readonly ReplayEditResult[]): DriftRow[] =>
  DRIFT_BUCKETS.map((b) => {
    const inBucket = edits.filter(
      (e) => e.error === undefined && e.turn >= b.from && e.turn <= b.to,
    );
    const broken = inBucket.filter((e) => e.verdicts.some((v) => v.band === "act")).length;
    return {
      label: b.label,
      edits: inBucket.length,
      broken,
      rate: inBucket.length === 0 ? 0 : broken / inBucket.length,
    };
  });

export type RuleTally = {
  rule: string;
  phase: "edit" | "turn";
  broken: number;
  flagged: number;
  of: number;
  example: string;
};

export const tallyRules = (result: ReplayResult, rules: readonly Rule[]): RuleTally[] => {
  const tallies: RuleTally[] = [];
  for (const rule of rules) {
    if (rule.check.type !== "model") continue;
    const phase = rule.when ?? "edit";
    const items: { file: string; verdicts: Verdict[] }[] =
      phase === "edit"
        ? result.edits.map((e) => ({ file: e.file, verdicts: e.verdicts }))
        : result.turns.map((t) => ({ file: t.files.join(", "), verdicts: t.verdicts }));
    let broken = 0;
    let flagged = 0;
    let of = 0;
    let example = "";
    for (const item of items) {
      const v = item.verdicts.find((x) => x.ruleId === rule.id);
      if (v === undefined) continue;
      of += 1;
      if (v.band === "act") {
        broken += 1;
        if (example === "") example = item.file;
      } else if (v.band === "flag") flagged += 1;
    }
    if (of > 0) tallies.push({ rule: rule.id, phase, broken, flagged, of, example });
  }
  return tallies.sort((a, b) => b.broken - a.broken || b.flagged - a.flagged);
};
