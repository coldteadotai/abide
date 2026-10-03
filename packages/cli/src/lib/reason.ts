import type { Rule, Verdict } from "@coldtea/abide-schema";
import { ruleAppliesTo } from "./scope.js";

type Violation = { rule: Rule; verdict: Verdict };

const where = (rule: Rule): string =>
  rule.source.line === undefined
    ? rule.source.path
    : `${rule.source.path} line ${rule.source.line}`;

const quote = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
};

const blames = ({ rule, verdict }: Violation, file: string): boolean =>
  verdict.file === undefined ? ruleAppliesTo(rule, file) : verdict.file === file;

export const filesToRepair = (
  violations: readonly Violation[],
  files: readonly string[],
): string[] => [...new Set(files)].filter((f) => violations.some((v) => blames(v, f)));

const evidence = (rule: Rule, verdict: Verdict): string => {
  const score = verdict.probability.toFixed(2);
  const at = verdict.file === undefined ? "" : ` in ${verdict.file}`;
  if (rule.check.type === "lint" && verdict.answer !== undefined)
    return ` Matched${at}: ${verdict.answer}`;
  if (verdict.answer !== undefined) return ` Judged${at}: ${verdict.answer} (${score}).`;
  return verdict.file === undefined ? ` (${score})` : ` Scored ${score} in ${verdict.file}.`;
};

/** One line per broken rule. Never the whole instruction file. */
export const repairReason = (
  phase: "edit" | "turn",
  violations: readonly Violation[],
  files: readonly string[],
): string => {
  const byRule = new Map<string, { rule: Rule; verdicts: Verdict[] }>();
  for (const { rule, verdict } of violations) {
    const entry = byRule.get(rule.id) ?? { rule, verdicts: [] };
    entry.verdicts.push(verdict);
    byRule.set(rule.id, entry);
  }
  const lines = [...byRule.values()].map(
    ({ rule, verdicts }) =>
      `Rule "${rule.id}" from ${where(rule)}: "${quote(rule.text)}".${verdicts.map((v) => evidence(rule, v)).join("")}`,
  );
  const targets = filesToRepair(violations, files);
  const subject = phase === "edit" ? "This edit appears" : "The changes in this turn appear";
  const target =
    targets.length === 1 ? targets[0] : `${targets.length} files (${targets.join(", ")})`;
  const ask =
    phase === "edit"
      ? `Repair ${target} now, then continue with the task.`
      : `Repair ${target} before you finish. Keep the fix to what the rule asks.`;
  return `Abide: ${subject} to break ${lines.length === 1 ? "a rule" : `${lines.length} rules`} from this repository's instructions.\n${lines.map((l) => `- ${l}`).join("\n")}\n${ask}`;
};

export const flagNotice = (
  phase: "edit" | "turn",
  flagged: readonly Violation[],
  files: readonly string[],
): string => {
  const list = flagged
    .map(
      ({ rule, verdict }) =>
        `${rule.id} ${verdict.probability.toFixed(2)}${verdict.file === undefined ? "" : ` in ${verdict.file}`}`,
    )
    .join(", ");
  const on = flagged.some((p) => p.verdict.file === undefined) ? ` on ${files.join(", ")}` : "";
  return `Abide: uncertain about ${list}${on} (${phase}). Not sent to the agent. Details in .abide/events.jsonl.`;
};
