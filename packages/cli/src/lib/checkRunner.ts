import type { CheckPhase, Rule, Thresholds, Usage, Verdict } from "@coldtea/abide-schema";
import type { FileDiff } from "./git.js";
import { checkWithModel, isModelRule, type ModelRule } from "./jev.js";
import { ruleAppliesTo } from "./scope.js";

export type CheckRequest = {
  phase: CheckPhase;
  /** The change, one entry per touched file, paths repo-relative. */
  fileDiffs: readonly FileDiff[];
  task?: string;
  rules: readonly Rule[];
  thresholds: Thresholds;
  timeoutMs: number;
  /** Transient gateway failures to retry. Hooks leave it at zero. */
  retries?: number;
};

export type CheckOutcome = {
  verdicts: Verdict[];
  modelRules: ModelRule[];
  /** How many model calls the check took: one per distinct set of in-scope files. */
  calls: number;
  usage: Usage;
  modelLatencyMs: number;
};

/** Only model rules run. A lint-shaped rule is the linter's to enforce, and abide only reports it. */
const runsInPhase = (rule: Rule, phase: CheckPhase): boolean =>
  rule.status === "active" && rule.check.type === "model" && rule.when === phase;

/** Rules that are active, belong to this phase, and apply to at least one touched file. */
export const selectRules = (
  rules: readonly Rule[],
  phase: CheckPhase,
  files: readonly string[],
): Rule[] =>
  rules.filter((rule) => runsInPhase(rule, phase) && files.some((f) => ruleAppliesTo(rule, f)));

const renderFiles = (fileDiffs: readonly FileDiff[]): string =>
  fileDiffs.map((f) => `--- a/${f.file}\n+++ b/${f.file}\n${f.text}`).join("\n");

/** Rules grouped by the files each one applies to, so no rule ever sees a file outside its scope. */
export const groupByScope = (
  rules: readonly ModelRule[],
  fileDiffs: readonly FileDiff[],
): { rules: ModelRule[]; fileDiffs: FileDiff[] }[] => {
  const groups = new Map<string, { rules: ModelRule[]; fileDiffs: FileDiff[] }>();
  for (const rule of rules) {
    const inScope = fileDiffs.filter((f) => ruleAppliesTo(rule, f.file));
    if (inScope.length === 0) continue;
    const key = inScope.map((f) => f.file).join("\n");
    const group = groups.get(key) ?? { rules: [], fileDiffs: inScope };
    group.rules.push(rule);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
});

/** One verdict per rule: the loudest. */
export const loudestVerdicts = (verdicts: readonly Verdict[]): Verdict[] => {
  const best = new Map<string, Verdict>();
  for (const v of verdicts) {
    const have = best.get(v.ruleId);
    if (have === undefined || v.probability > have.probability) best.set(v.ruleId, v);
  }
  return [...best.values()];
};

export const mergeOutcomes = (outcomes: readonly CheckOutcome[]): CheckOutcome => {
  const modelRules: ModelRule[] = [];
  for (const o of outcomes) {
    for (const rule of o.modelRules) if (!modelRules.includes(rule)) modelRules.push(rule);
  }
  return {
    verdicts: loudestVerdicts(outcomes.flatMap((o) => o.verdicts)),
    modelRules,
    calls: outcomes.reduce((sum, o) => sum + o.calls, 0),
    usage: outcomes.reduce<Usage>((sum, o) => addUsage(sum, o.usage), {}),
    modelLatencyMs: Math.max(0, ...outcomes.map((o) => o.modelLatencyMs)),
  };
};

export const runCheck = async (request: CheckRequest): Promise<CheckOutcome> => {
  const files = request.fileDiffs.map((f) => f.file);
  const modelRules = selectRules(request.rules, request.phase, files).filter(isModelRule);

  const groups = groupByScope(modelRules, request.fileDiffs);
  if (groups.length === 0) {
    return { verdicts: [], modelRules, calls: 0, usage: {}, modelLatencyMs: 0 };
  }

  const started = performance.now();
  const results = await Promise.all(
    groups.map(async (group) => {
      const only = group.fileDiffs.length === 1 ? group.fileDiffs[0] : undefined;
      const result = await checkWithModel(
        group.rules,
        {
          ...(request.task === undefined ? {} : { task: request.task }),
          ...(request.phase === "edit" && only !== undefined
            ? { file: only.file, diff: only.text }
            : { files: group.fileDiffs.map((f) => f.file), diff: renderFiles(group.fileDiffs) }),
        },
        request.thresholds,
        request.timeoutMs,
        request.retries ?? 0,
      );
      return only === undefined
        ? result
        : { ...result, verdicts: result.verdicts.map((v) => ({ ...v, file: only.file })) };
    }),
  );
  return {
    verdicts: results.flatMap((r) => r.verdicts),
    modelRules,
    calls: groups.length,
    usage: results.reduce<Usage>((sum, r) => addUsage(sum, r.usage), {}),
    modelLatencyMs: Math.round(performance.now() - started),
  };
};
