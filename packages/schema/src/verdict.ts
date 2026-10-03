import { z } from "zod";
import { ruleWhenSchema } from "./rubric.js";

export const bandSchema = z.enum(["act", "flag", "clear"]);
export type Band = z.infer<typeof bandSchema>;

export const verdictSchema = z.object({
  ruleId: z.string(),
  /** Probability that the rule is violated, 0 to 1. Lint hits are 1. */
  probability: z.number().min(0).max(1),
  band: bandSchema,
  /** For choice and score answers, what the model picked. */
  answer: z.string().optional(),
  /** Set only when judged on one file. */
  file: z.string().optional(),
});
export type Verdict = z.infer<typeof verdictSchema>;

export const checkPhaseSchema = ruleWhenSchema;
export type CheckPhase = z.infer<typeof checkPhaseSchema>;

export const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

export const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    at: z.string(),
    phase: checkPhaseSchema,
    sessionId: z.string().optional(),
    promptId: z.string().optional(),
    files: z.array(z.string()),
    rules: z.number().int(),
    /** Older logs counted regex rules here; abide no longer runs any. */
    lintRules: z.number().int().optional(),
    latencyMs: z.number(),
    modelLatencyMs: z.number().optional(),
    usage: usageSchema.optional(),
    verdicts: z.array(verdictSchema),
    blocked: z.boolean(),
  }),
  z.object({
    kind: z.literal("skip"),
    at: z.string(),
    phase: checkPhaseSchema,
    sessionId: z.string().optional(),
    reason: z.string(),
    files: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("error"),
    at: z.string(),
    phase: z.union([checkPhaseSchema, z.literal("session")]),
    sessionId: z.string().optional(),
    code: z.string(),
    message: z.string(),
    latencyMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("compile-needed"),
    at: z.string(),
    sessionId: z.string().optional(),
    reason: z.string(),
    sources: z.array(z.string()),
  }),
]);
export type AbideEvent = z.infer<typeof eventSchema>;
