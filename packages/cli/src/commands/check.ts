import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AbideError } from "@coldtea/abide-schema";
import { runCheck } from "../lib/checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS, TURN_CHECK_TIMEOUT_MS } from "../lib/constants.js";
import { hasApiKey, NO_KEY_HINT } from "../lib/credentials.js";
import { boundState } from "../lib/diff.js";
import { splitDiff, workingTreeDiff } from "../lib/git.js";
import { loadRules } from "../lib/loadRules.js";
import { findRepoRoot } from "../lib/paths.js";
import { say } from "../lib/ui.js";
import { Header } from "../ui/components/Header.js";
import { showLive } from "../ui/render.js";
import { CheckView, type CheckData, type CheckSection } from "../ui/views/CheckView.js";

/** Checks uncommitted changes (or a patch file) the way the hooks would, and shows every verdict. */
export const runCheckCommand = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      diff: { type: "string" },
      task: { type: "string" },
      phase: { type: "string", default: "all" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const root = findRepoRoot(process.cwd());
  const loaded = loadRules(root);
  if (loaded.rules.length === 0)
    throw new AbideError(
      "RUBRIC_MISSING",
      "no rubric here or in ~/.abide; run abide compile first",
    );

  if (!hasApiKey(root)) throw new AbideError("NO_API_KEY", NO_KEY_HINT);

  const patch =
    values.diff === undefined
      ? workingTreeDiff(root, positionals)
      : readFileSync(values.diff, "utf8");
  const files = splitDiff(patch, root);
  const phase = values.phase;

  const run = async (progress: (label: string) => void): Promise<CheckData> => {
    const sections: CheckSection[] = [];
    let spendUsd = 0;
    if (files.length === 0) return { root, sections, spendUsd, all: values.all };
    if (phase === "all" || phase === "edit") {
      for (const f of files) {
        progress(`checking ${f.file}`);
        const out = await runCheck({
          phase: "edit",
          fileDiffs: [{ file: f.file, text: boundState(f.text).text }],
          task: values.task,
          rules: loaded.rules,
          thresholds: loaded.thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
          retries: 2,
        });
        spendUsd += out.usage.costUsd ?? 0;
        sections.push({
          phase: "edit",
          files: [f.file],
          modelRules: out.modelRules.length,
          calls: out.calls,
          latencyMs: out.modelLatencyMs,
          verdicts: out.verdicts,
        });
      }
    }
    if (phase === "all" || phase === "turn") {
      progress(
        `checking the whole change, ${files.length} ${files.length === 1 ? "file" : "files"}`,
      );
      const out = await runCheck({
        phase: "turn",
        fileDiffs: files.map((f) => ({ file: f.file, text: boundState(f.text, 8_000).text })),
        task: values.task,
        rules: loaded.rules,
        thresholds: loaded.thresholds,
        timeoutMs: TURN_CHECK_TIMEOUT_MS,
        retries: 2,
      });
      spendUsd += out.usage.costUsd ?? 0;
      sections.push({
        phase: "turn",
        files: files.map((f) => f.file),
        modelRules: out.modelRules.length,
        calls: out.calls,
        latencyMs: out.modelLatencyMs,
        verdicts: out.verdicts,
      });
    }
    return { root, sections, spendUsd, all: values.all };
  };

  if (values.json) {
    const data = await run(() => {});
    say(JSON.stringify(data));
    return data.sections.some((s) => s.verdicts.some((v) => v.band === "act")) ? 1 : 0;
  }
  return showLive<CheckData>({
    header: Header({
      command: "check",
      where: root,
      note: files.length === 0 ? "nothing to check: no changed lines" : undefined,
    }),
    run,
    done: (data) => CheckView({ data }),
    code: (data) => (data.sections.some((s) => s.verdicts.some((v) => v.band === "act")) ? 1 : 0),
  });
};
