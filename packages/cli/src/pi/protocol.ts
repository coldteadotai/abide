import { z } from "zod";
import type { HookOutput } from "@coldtea/abide-schema";

export const fileStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present"), text: z.string() }),
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("unreadable") }),
  z.object({ kind: z.literal("oversized") }),
]);
export type FileState = z.infer<typeof fileStateSchema>;

export const piEditInputSchema = z.object({
  path: z.string(),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1),
});
export const piWriteInputSchema = z.object({ path: z.string(), content: z.string() });

const blockSchema = z.object({
  decision: z.literal("block"),
  reason: z.string(),
  systemMessage: z.string().optional(),
});
const contextSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("SessionStart"),
    additionalContext: z.string(),
  }),
  systemMessage: z.string().optional(),
});
const noticeSchema = z.object({ systemMessage: z.string() }).strict();

export const parseHookReply = (raw: unknown): HookOutput => {
  const block = blockSchema.safeParse(raw);
  if (block.success)
    return { kind: "block", reason: block.data.reason, systemMessage: block.data.systemMessage };
  const context = contextSchema.safeParse(raw);
  if (context.success)
    return {
      kind: "session-context",
      additionalContext: context.data.hookSpecificOutput.additionalContext,
      systemMessage: context.data.systemMessage,
    };
  const notice = noticeSchema.safeParse(raw);
  return notice.success
    ? { kind: "notice", systemMessage: notice.data.systemMessage }
    : { kind: "silent" };
};
