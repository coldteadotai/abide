import { parseArgs } from "node:util";
import { AbideError } from "@coldtea/abide-schema";
import { say, usd } from "../lib/ui.js";
import { isGitRepo } from "../lib/git.js";
import { showLive } from "../ui/render.js";
import { findRepoRoot } from "../lib/paths.js";
import { loadRules } from "../lib/loadRules.js";
import { Header } from "../ui/components/Header.js";
import { hasApiKey, NO_KEY_HINT } from "../lib/credentials.js";
import { AuditView, type AuditData } from "../ui/views/AuditView.js";
import { auditFiles, auditableFiles, listRepoFiles, tallyByRule } from "../lib/audit.js";

/** Judges every file in scope as if it had just been written, and reports what breaks which rule. */
export const runAudit = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      concurrency: { type: "string", default: "3" },
      "max-files": { type: "string" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const root = findRepoRoot(process.cwd());
  if (!hasApiKey(root)) throw new AbideError("NO_API_KEY", NO_KEY_HINT);
  if (!isGitRepo(root))
    throw new AbideError(
      "GIT_UNAVAILABLE",
      "audit walks the files git knows about, and this is not a git repository",
    );
  const loaded = loadRules(root);
  if (loaded.rules.length === 0)
    throw new AbideError(
      "RUBRIC_MISSING",
      "no rubric here or in ~/.abide; run abide compile first",
    );

  const candidates = listRepoFiles(root, positionals);
  const { files: inScope, skipped } = auditableFiles(root, candidates, loaded.rules);
  const cap = values["max-files"] === undefined ? Infinity : Number(values["max-files"]);
  const files = inScope.slice(0, cap);
  const concurrency = Math.max(1, Number(values.concurrency));

  const run = async (progress: (label: string) => void): Promise<AuditData> => {
    const started = performance.now();
    const { results, binary } = await auditFiles(
      root,
      files,
      loaded.rules,
      loaded.thresholds,
      concurrency,
      (done, total, spend) => {
        progress(`${done} of ${total} files ${"·"} about ${usd(spend)}`);
      },
    );
    return {
      root,
      files: results.length,
      skipped: { ...skipped, binary: [...skipped.binary, ...binary].sort() },
      results,
      tallies: tallyByRule(results),
      spendUsd: results.reduce((s, r) => s + r.costUsd, 0),
      elapsedMs: performance.now() - started,
      all: values.all,
    };
  };

  if (values.json) {
    const data = await run(() => {});
    say(
      JSON.stringify({
        root,
        files: data.files,
        skipped: data.skipped,
        spendUsd: data.spendUsd,
        elapsedMs: data.elapsedMs,
        byRule: data.tallies,
        byFile: data.results,
      }),
    );
    return data.tallies.some((t) => t.broken.length > 0) ? 1 : 0;
  }
  return showLive<AuditData>({
    header: Header({
      command: "audit",
      where: root,
      note:
        files.length === 0
          ? "no files in scope of any edit-phase rule"
          : `${files.length} files in scope, ${concurrency} at a time`,
    }),
    run,
    done: (data) => AuditView({ data }),
    code: (data) => (data.tallies.some((t) => t.broken.length > 0) ? 1 : 0),
  });
};
