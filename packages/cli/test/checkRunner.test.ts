import { describe, expect, it, vi } from "vitest";
import type { Rule, Verdict } from "@coldtea/abide-schema";

vi.mock("../src/lib/jev.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/lib/jev.js")>()),
  checkWithModel: async (rules: readonly Rule[]) => ({
    verdicts: rules.map((r) => ({ ruleId: r.id, probability: 0.9, band: "act" })),
    usage: {},
    latencyMs: 0,
  }),
}));

const { mergeOutcomes, runCheck } = await import("../src/lib/checkRunner.js");
type CheckOutcome = import("../src/lib/checkRunner.js").CheckOutcome;

const outcome = (verdicts: Verdict[], calls = 1): CheckOutcome => ({
  verdicts,
  modelRules: [],
  calls,
  usage: { inputTokens: 10, costUsd: 0.5 },
  modelLatencyMs: calls * 100,
});

describe("merging the outcomes of several checks", () => {
  it("keeps the loudest verdict per rule, so a file that broke a rule is not hidden by one that kept it", () => {
    const merged = mergeOutcomes([
      outcome([{ ruleId: "r", probability: 0.05, band: "clear" }]),
      outcome([{ ruleId: "r", probability: 0.95, band: "act" }], 2),
      outcome([{ ruleId: "s", probability: 0.6, band: "flag" }]),
    ]);
    expect(merged.verdicts).toEqual([
      { ruleId: "r", probability: 0.95, band: "act" },
      { ruleId: "s", probability: 0.6, band: "flag" },
    ]);
    expect(merged.calls).toBe(4);
    expect(merged.usage).toEqual({ inputTokens: 30, outputTokens: 0, costUsd: 1.5 });
    expect(merged.modelLatencyMs).toBe(200);
  });

  it("keeps the file the loudest verdict was judged on", () => {
    const merged = mergeOutcomes([
      outcome([{ ruleId: "r", probability: 0.2, band: "clear", file: "a.ts" }]),
      outcome([{ ruleId: "r", probability: 0.8, band: "act", file: "runner.ts" }]),
    ]);
    expect(merged.verdicts).toEqual([
      { ruleId: "r", probability: 0.8, band: "act", file: "runner.ts" },
    ]);
  });

  it("merges nothing into an empty outcome", () => {
    expect(mergeOutcomes([])).toEqual({
      verdicts: [],
      modelRules: [],
      calls: 0,
      usage: {},
      modelLatencyMs: 0,
    });
  });
});

const modelRule = (id: string, when: "edit" | "turn", scope?: string[]): Rule => ({
  id,
  text: id,
  source: { path: "AGENTS.md" },
  status: "active",
  when,
  ...(scope === undefined ? {} : { scope }),
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
});

describe("running a check", () => {
  const check = (phase: "edit" | "turn", rules: Rule[], files: string[]) =>
    runCheck({
      phase,
      fileDiffs: files.map((file) => ({ file, text: "+x" })),
      rules,
      thresholds: { act: 0.7, flag: 0.4 },
      timeoutMs: 1_000,
    });

  it("names the file on a verdict judged on one file", async () => {
    const out = await check("edit", [modelRule("r", "edit")], ["runner.ts"]);
    expect(out.verdicts).toEqual([
      { ruleId: "r", probability: 0.9, band: "act", file: "runner.ts" },
    ]);
  });

  it("names no file on a verdict judged over several, unless its scope held one", async () => {
    const out = await check(
      "turn",
      [modelRule("whole", "turn"), modelRule("docs", "turn", ["docs/**"])],
      ["a.ts", "docs/x.md"],
    );
    expect(out.verdicts).toEqual([
      { ruleId: "whole", probability: 0.9, band: "act" },
      { ruleId: "docs", probability: 0.9, band: "act", file: "docs/x.md" },
    ]);
  });
});
