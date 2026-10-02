import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parsePatch } from "diff";
import {
  AbideError,
  assertNever,
  patchHunkSchema,
  postToolUseInputSchema,
  type PatchHunk,
  type PostToolUseInput,
} from "@coldtea/abide-schema";
import { piEditInputSchema, piWriteInputSchema } from "../pi/protocol.js";
import { resolveToolPath } from "../pi/mutations.js";
import { MAX_TASK_CHARS } from "./constants.js";
import { expandHome, piAgentDir } from "./paths.js";
import { readRegularText } from "./regularFile.js";
import type { ReplaySession, ReplayTurn } from "./replay.js";

const headerSchema = z.object({ type: z.literal("session"), id: z.string(), cwd: z.string() });
const entrySchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  message: z.unknown().optional(),
});
type Entry = z.infer<typeof entrySchema>;
const contentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() })),
]);
const callSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.enum(["edit", "write"]),
  arguments: z.unknown(),
});
type Call = z.infer<typeof callSchema>;
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: contentSchema }),
  z.object({ role: z.literal("assistant"), content: z.array(z.unknown()) }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    isError: z.boolean(),
    details: z.object({ patch: z.string().optional() }).optional(),
  }),
]);

export const piSessionsDir = (): string =>
  process.env.PI_CODING_AGENT_SESSION_DIR
    ? path.resolve(expandHome(process.env.PI_CODING_AGENT_SESSION_DIR))
    : path.join(piAgentDir(), "sessions");

const patchHunks = (patch: string | undefined): PatchHunk[] | undefined => {
  if (patch === undefined) return undefined;
  try {
    return patchHunkSchema.array().parse(
      parsePatch(patch).flatMap((file) =>
        file.hunks.map((hunk) => ({
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: hunk.lines,
        })),
      ),
    );
  } catch {
    return undefined;
  }
};

const activeBranch = (entries: Entry[]): Entry[] => {
  const byId = new Map(
    entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])),
  );
  const last = entries.at(-1);
  if (last?.id === undefined) return entries;
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let entry: Entry | undefined = last;
  while (entry?.id !== undefined && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId == null ? undefined : byId.get(entry.parentId);
  }
  return branch.reverse();
};

const editInput = (
  call: Call,
  cwd: string,
  sessionId: string,
  patch?: string,
): PostToolUseInput | undefined => {
  const base = {
    session_id: sessionId,
    cwd,
    hook_event_name: "PostToolUse" as const,
    tool_use_id: call.id,
  };
  switch (call.name) {
    case "write": {
      const parsed = piWriteInputSchema.safeParse(call.arguments);
      return parsed.success
        ? postToolUseInputSchema.parse({
            ...base,
            tool_name: "Write",
            tool_input: {
              file_path: resolveToolPath(parsed.data.path, cwd),
              content: parsed.data.content,
            },
          })
        : undefined;
    }
    case "edit": {
      const parsed = piEditInputSchema.safeParse(call.arguments);
      if (!parsed.success) return undefined;
      return postToolUseInputSchema.parse({
        ...base,
        tool_name: "MultiEdit",
        tool_input: {
          file_path: resolveToolPath(parsed.data.path, cwd),
          edits: parsed.data.edits.map((edit) => ({
            old_string: edit.oldText,
            new_string: edit.newText,
          })),
        },
        tool_response: { structuredPatch: patchHunks(patch) },
      });
    }
    default:
      return assertNever(call.name);
  }
};

export const parsePiSession = (file: string): ReplaySession => {
  const text = readRegularText(file);
  if (text === undefined) throw new AbideError("CHECK_FAILED", `could not read Pi session ${file}`);
  let header: z.infer<typeof headerSchema> | undefined;
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const raw: unknown = JSON.parse(line);
      const meta = headerSchema.safeParse(raw);
      if (meta.success) {
        header = meta.data;
        continue;
      }
      const entry = entrySchema.safeParse(raw);
      if (entry.success) entries.push(entry.data);
    } catch {
      continue;
    }
  }
  if (!header) throw new AbideError("CHECK_FAILED", `Pi session ${file} has no valid header`);
  const turns: ReplayTurn[] = [];
  const pending = new Map<string, { call: Call; turn: ReplayTurn }>();
  for (const entry of activeBranch(entries)) {
    if (entry.type !== "message") continue;
    const parsed = messageSchema.safeParse(entry.message);
    if (!parsed.success) continue;
    const message = parsed.data;
    switch (message.role) {
      case "user": {
        const prompt =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? "")
                .join("\n");
        turns.push({ index: turns.length + 1, prompt: prompt.slice(0, MAX_TASK_CHARS), edits: [] });
        break;
      }
      case "assistant": {
        const turn = turns.at(-1);
        if (!turn) break;
        for (const part of message.content) {
          const call = callSchema.safeParse(part);
          if (call.success) pending.set(call.data.id, { call: call.data, turn });
        }
        break;
      }
      case "toolResult": {
        const recorded = pending.get(message.toolCallId);
        pending.delete(message.toolCallId);
        if (!recorded || message.isError) break;
        const input = editInput(recorded.call, header.cwd, header.id, message.details?.patch);
        if (input) recorded.turn.edits.push({ turn: recorded.turn.index, input });
        break;
      }
      default:
        assertNever(message);
    }
  }
  return { file, cwd: header.cwd, turns: turns.filter((turn) => turn.edits.length > 0) };
};

const sessionFiles = (target: string): string[] => {
  try {
    if (statSync(target).isFile()) return [target];
    return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(target, entry.name);
      return entry.isDirectory()
        ? sessionFiles(file)
        : entry.isFile() && entry.name.endsWith(".jsonl")
          ? [file]
          : [];
    });
  } catch {
    return [];
  }
};

export const piSessionsFor = (root: string, target = piSessionsDir()): ReplaySession[] =>
  sessionFiles(target)
    .sort()
    .flatMap((file) => {
      try {
        const session = parsePiSession(file);
        const relative = path.relative(root, session.cwd);
        return (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) &&
          session.turns.length > 0
          ? [session]
          : [];
      } catch {
        return [];
      }
    });
