import path from "node:path";
import { z } from "zod";
import { assertNever, postToolUseInputSchema, type PostToolUseInput } from "@coldtea/abide-schema";
import { isExcludedPath } from "../lib/paths.js";
import type { FileState } from "./protocol.js";

const editSchema = z.object({
  path: z.string(),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1),
});
const writeSchema = z.object({ path: z.string(), content: z.string() });
type Change = { file: string; before: string | null; after: string };
type Pending = { file: string; before: FileState; tainted: boolean };
export type MutationTracker = {
  begin(
    callId: string,
    toolName: string,
    input: unknown,
    cwd: string,
  ): { file: string } | undefined;
  setBefore(callId: string, state: FileState): void;
  file(callId: string): string | undefined;
  complete(callId: string, after: FileState): Change | undefined;
  discard(callId: string): void;
  clear(): void;
};

export const createMutationTracker = (): MutationTracker => {
  const pending = new Map<string, Pending>();
  return {
    begin(callId, toolName, input, cwd) {
      const schema =
        toolName === "edit" ? editSchema : toolName === "write" ? writeSchema : undefined;
      const parsed = schema?.safeParse(input);
      if (!parsed?.success || parsed.data.path.startsWith("~")) return undefined;
      const file = path.resolve(cwd, parsed.data.path);
      const relative = path.relative(cwd, file).split(path.sep).join("/");
      if (relative.startsWith("../") || isExcludedPath(relative)) return undefined;
      const key = process.platform === "win32" ? file.toLowerCase() : file;
      let tainted = pending.has(callId);
      for (const entry of pending.values()) {
        const other = process.platform === "win32" ? entry.file.toLowerCase() : entry.file;
        if (other === key) {
          entry.tainted = true;
          tainted = true;
        }
      }
      pending.set(callId, { file, before: { kind: "unreadable" }, tainted });
      return { file };
    },
    setBefore(callId, state) {
      const entry = pending.get(callId);
      if (entry) entry.before = state;
    },
    file(callId) {
      return pending.get(callId)?.file;
    },
    complete(callId, after) {
      const entry = pending.get(callId);
      pending.delete(callId);
      if (!entry || entry.tainted || after.kind !== "present") return undefined;
      switch (entry.before.kind) {
        case "present":
          return { file: entry.file, before: entry.before.text, after: after.text };
        case "absent":
          return { file: entry.file, before: null, after: after.text };
        case "unreadable":
        case "oversized":
          return undefined;
        default:
          return assertNever(entry.before);
      }
    },
    discard(callId) {
      pending.delete(callId);
    },
    clear() {
      pending.clear();
    },
  };
};

export const mutationPayload = (
  change: Change,
  identity: { session_id: string; prompt_id: string; cwd: string },
  callId: string,
): PostToolUseInput =>
  postToolUseInputSchema.parse({
    ...identity,
    hook_event_name: "PostToolUse",
    tool_use_id: callId,
    tool_name: "Write",
    tool_input: { file_path: change.file, content: change.after },
    tool_response: { originalFile: change.before },
  });
