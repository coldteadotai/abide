import { describe, expect, it } from "vitest";
import type { Rule, Verdict } from "@coldtea/abide-schema";
import { filesToRepair, flagNotice, repairReason } from "../src/lib/reason.js";

const rule = (id: string, scope?: string[]): Rule => ({
  id,
  text: "Comment sparingly",
  source: { path: "AGENTS.md", line: 3 },
  status: "active",
  when: "edit",
  ...(scope === undefined ? {} : { scope }),
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
});

const act = (ruleId: string, file?: string): Verdict => ({
  ruleId,
  probability: 0.8,
  band: "act",
  answer: "about half",
  ...(file === undefined ? {} : { file }),
});

const files = ["a.ts", "runner.ts", "docs/x.md", "util.ts"];

describe("the repair reason", () => {
  it("names the file a rule broke in and asks for a repair there only", () => {
    const reason = repairReason(
      "turn",
      [{ rule: rule("comments"), verdict: act("comments", "runner.ts") }],
      files,
    );
    expect(reason).toContain(`Judged in runner.ts: about half (0.80).`);
    expect(reason).toContain("Repair runner.ts before you finish.");
    expect(reason).not.toContain("a.ts");
    expect(reason).not.toContain("util.ts");
  });

  it("lists every file a rule broke in under that rule once", () => {
    const comments = rule("comments");
    const reason = repairReason(
      "turn",
      [
        { rule: comments, verdict: act("comments", "runner.ts") },
        { rule: comments, verdict: { ...act("comments", "util.ts"), probability: 0.9 } },
      ],
      files,
    );
    expect(reason).toContain("The changes in this turn appear to break a rule");
    expect(reason.match(/Rule "comments"/g)).toHaveLength(1);
    expect(reason).toContain(
      "Judged in runner.ts: about half (0.80). Judged in util.ts: about half (0.90).",
    );
    expect(reason).toContain("Repair 2 files (runner.ts, util.ts) before you finish.");
  });

  it("blames a rule judged over the whole change on the changed files in its scope", () => {
    const docs = rule("docs", ["docs/**"]);
    const reason = repairReason("turn", [{ rule: docs, verdict: act("docs") }], files);
    expect(reason).toContain("Judged: about half (0.80).");
    expect(reason).toContain("Repair docs/x.md before you finish.");
    expect(filesToRepair([{ rule: docs, verdict: act("docs") }], ["a.ts"])).toEqual([]);
  });

  it("gives the score and file for a rule the model answered yes or no", () => {
    const verdict: Verdict = { ruleId: "comments", probability: 0.89, band: "act", file: "a.ts" };
    expect(repairReason("edit", [{ rule: rule("comments"), verdict }], ["a.ts"])).toBe(
      'Abide: This edit appears to break a rule from this repository\'s instructions.\n- Rule "comments" from AGENTS.md line 3: "Comment sparingly". Scored 0.89 in a.ts.\nRepair a.ts now, then continue with the task.',
    );
  });

  it("names a file once when an edit touched it twice", () => {
    expect(
      filesToRepair(
        [{ rule: rule("comments"), verdict: act("comments", "a.ts") }],
        ["a.ts", "a.ts"],
      ),
    ).toEqual(["a.ts"]);
  });

  it("asks for nothing in a file that no longer exists", () => {
    expect(
      filesToRepair([{ rule: rule("comments"), verdict: act("comments", "gone.ts") }], files),
    ).toEqual([]);
  });
});

describe("the flag notice", () => {
  it("names the file each uncertain verdict came from", () => {
    const flag: Verdict = { ruleId: "comments", probability: 0.6, band: "flag", file: "a.ts" };
    expect(flagNotice("turn", [{ rule: rule("comments"), verdict: flag }], files)).toBe(
      "Abide: uncertain about comments 0.60 in a.ts (turn). Not sent to the agent. Details in .abide/events.jsonl.",
    );
  });

  it("still lists the changed files for a verdict judged over several", () => {
    const flag: Verdict = { ruleId: "comments", probability: 0.6, band: "flag" };
    expect(
      flagNotice("turn", [{ rule: rule("comments"), verdict: flag }], ["a.ts", "b.ts"]),
    ).toContain("comments 0.60 on a.ts, b.ts (turn)");
  });
});
