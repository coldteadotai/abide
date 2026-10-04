import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  rubricSchema,
  type CheckType,
  type Rubric,
  type Rule,
  type RuleStatus,
} from "@coldtea/abide-schema";
import { hashFile } from "./sources.js";
import { canonicalSourcePath, homeDir, resolveSourcePath } from "./paths.js";
import { ruleAppliesToRepo } from "./scope.js";
import { readRegularText } from "./regularFile.js";

export type RubricRead =
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; issues: string[] }
  | { kind: "ok"; path: string; rubric: Rubric };

export const readRubric = (file: string): RubricRead => {
  const raw = readRegularText(file);
  if (raw === undefined) return { kind: "missing", path: file };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "not JSON";
    return { kind: "invalid", path: file, issues: [message] };
  }
  const parsed = rubricSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "invalid",
      path: file,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { kind: "ok", path: file, rubric: parsed.data };
};

export const writeRubric = (file: string, rubric: Rubric): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rubric, null, 2)}\n`);
};

/** Hashes every source and settles on one spelling for each path, in sources and in rules. */
export const fillSourceShas = (
  rubric: Rubric,
  root: string,
): { rubric: Rubric; missing: string[] } => {
  const missing: string[] = [];
  const sources = rubric.sources.map((source) => {
    const canonical = canonicalSourcePath(root, source.path);
    const sha = hashFile(resolveSourcePath(root, source.path));
    if (sha === undefined) {
      missing.push(source.path);
      return { ...source, path: canonical };
    }
    return { ...source, path: canonical, sha };
  });
  const rules = rubric.rules.map((rule) => ({
    ...rule,
    source: { ...rule.source, path: canonicalSourcePath(root, rule.source.path) },
  }));
  return { rubric: { ...rubric, sources, rules }, missing };
};

export type MergedRule = Rule & { origin: "project" | "global" };

/**
 * Project rules win on an id clash.
 *
 * A rule naming repos is dropped when the repo under check is not one of them.
 * Only global rules can be dropped this way in practice, but the filter is
 * applied to both: a project rule that names its own repo is either a match
 * (kept) or a statement that it belongs elsewhere (honoured). The clash is
 * resolved first, so a project rule still overrides a global one of the same id
 * — including where the global one would not have applied.
 */
export const mergeRules = (
  project: Rubric | undefined,
  global: Rubric | undefined,
  root: string,
  home: string,
): MergedRule[] => {
  const byId = new Map<string, MergedRule>();
  const keep = (rule: Rule, origin: MergedRule["origin"]): void => {
    if (!ruleAppliesToRepo(rule, root, home)) return;
    byId.set(rule.id, { ...rule, origin });
  };
  for (const rule of global?.rules ?? []) keep(rule, "global");
  for (const rule of project?.rules ?? []) keep(rule, "project");
  return [...byId.values()];
};

export type BucketCounts = Record<CheckType, number> & {
  total: number;
  byStatus: Record<RuleStatus, number>;
};

export const bucketCounts = (rules: readonly Rule[]): BucketCounts => {
  const counts: BucketCounts = {
    lint: 0,
    model: 0,
    deferred: 0,
    unenforceable: 0,
    total: rules.length,
    byStatus: { active: 0, weak: 0, noisy: 0, disabled: 0 },
  };
  for (const rule of rules) {
    counts[rule.check.type] += 1;
    counts.byStatus[rule.status] += 1;
  }
  return counts;
};
