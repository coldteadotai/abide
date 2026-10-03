import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { postToolUseInputSchema } from "@coldtea/abide-schema";
import { MAX_TASK_CHARS } from "./constants.js";
import type { ReplaySession, ReplayTurn } from "./replay.js";
import { readSessionLines } from "./replayJsonl.js";
import { collectReplaySessions, type ReplayCollection } from "./replayCollection.js";

/** One rollout file per session, one JSON object per line. An `apply_patch` call carries the same patch text the live hook receives. */
export const codexSessionsDir = (): string => path.join(homedir(), ".codex", "sessions");

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record;
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Codex's own additions to a user turn, not prompts. */
const INJECTED = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions instructions>",
  "<turn_aborted>",
  "\n# Files mentioned by the user",
];

const promptOf = (payload: Record<string, unknown>): string | undefined => {
  const text = asList(payload.content)
    .flatMap((c) => {
      const part = asRecord(c);
      return part?.type === "input_text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
  if (text.trim() === "" || INJECTED.some((prefix) => text.startsWith(prefix))) return undefined;
  return text.slice(0, MAX_TASK_CHARS);
};

const FAILED_OUTPUT = /^apply_patch (verification )?failed|^error/i;

export const parseCodexRollout = async (file: string): Promise<ReplaySession> => {
  const turns: ReplayTurn[] = [];
  const pending = new Map<string, { turn: ReplayTurn; command: string }>();
  let cwd: string | undefined;
  let turnIndex = 0;
  const current = (): ReplayTurn => {
    const last = turns.at(-1);
    if (last !== undefined) return last;
    const first: ReplayTurn = { index: 0, prompt: undefined, edits: [] };
    turns.push(first);
    return first;
  };
  const sessionId = path.basename(file, ".jsonl");
  for await (const line of readSessionLines(file, () => cwd)) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      // a torn line, still being written
      continue;
    }
    const payload = asRecord(entry?.payload);
    if (entry === undefined || payload === undefined) continue;
    if (entry.type === "session_meta" && typeof payload.cwd === "string") cwd ??= payload.cwd;
    if (entry.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") {
      const prompt = promptOf(payload);
      if (prompt === undefined) continue;
      turnIndex += 1;
      turns.push({ index: turnIndex, prompt, edits: [] });
      continue;
    }
    if (
      payload.type === "custom_tool_call" &&
      payload.name === "apply_patch" &&
      typeof payload.call_id === "string" &&
      typeof payload.input === "string"
    ) {
      pending.set(payload.call_id, { turn: current(), command: payload.input });
      continue;
    }
    if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
      const call = pending.get(payload.call_id);
      pending.delete(payload.call_id);
      if (call === undefined) continue;
      // a patch that did not apply changed nothing
      if (typeof payload.output === "string" && FAILED_OUTPUT.test(payload.output)) continue;
      const parsed = postToolUseInputSchema.safeParse({
        session_id: sessionId,
        cwd: cwd ?? process.cwd(),
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_use_id: payload.call_id,
        tool_input: { command: call.command },
      });
      if (parsed.success) call.turn.edits.push({ turn: call.turn.index, input: parsed.data });
    }
  }
  return { file, cwd: cwd ?? process.cwd(), turns: turns.filter((t) => t.edits.length > 0) };
};

const rolloutFiles = (dir: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) return rolloutFiles(full);
    } catch {
      return [];
    }
    return name.startsWith("rollout-") && name.endsWith(".jsonl") ? [full] : [];
  });
};

export const codexSessionsFor = (
  root: string,
  dir = codexSessionsDir(),
): Promise<ReplayCollection> =>
  collectReplaySessions(root, rolloutFiles(dir).sort(), parseCodexRollout);
