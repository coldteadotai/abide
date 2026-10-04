import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNever, postToolUseInputSchema, type PostToolUseInput } from "@coldtea/abide-schema";
import { findRepoRoot, isExcludedPath, relativeToRoot } from "../lib/paths.js";
import { piEditInputSchema, piWriteInputSchema, type FileState } from "./protocol.js";
type Change = { file: string; before: string | null; after: string };
type Pending = { file: string; before: FileState; tainted: boolean };

export const resolveToolPath = (input: string, cwd: string): string => {
  let file = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (
    process.platform === "win32" &&
    file.startsWith("/") &&
    !file.startsWith("//") &&
    !file.includes("\\")
  ) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(file);
    if (drive?.[1]) file = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (file === "~") file = homedir();
  else if (file.startsWith("~/") || (process.platform === "win32" && file.startsWith("~\\")))
    file = path.join(homedir(), file.slice(2));
  if (file.startsWith("file://")) file = fileURLToPath(file);
  return path.resolve(cwd, file);
};

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
        toolName === "edit"
          ? piEditInputSchema
          : toolName === "write"
            ? piWriteInputSchema
            : undefined;
      const parsed = schema?.safeParse(input);
      if (!parsed?.success) return undefined;
      const file = resolveToolPath(parsed.data.path, cwd);
      const root = findRepoRoot(cwd);
      const relative = path.relative(cwd, file).split(path.sep).join("/");
      if (
        relative === ".." ||
        relative.startsWith("../") ||
        path.isAbsolute(relative) ||
        isExcludedPath(relativeToRoot(root, file), root)
      )
        return undefined;
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
  identity: { session_id: string; prompt_id: string; cwd: string; prompt?: string },
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
