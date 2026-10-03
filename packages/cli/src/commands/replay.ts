import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AbideError, assertNever, hostSchema, type Host } from "@coldtea/abide-schema";
import { hasApiKey, NO_KEY_HINT } from "../lib/credentials.js";
import { hostLabel } from "../lib/hosts.js";
import { loadRules } from "../lib/loadRules.js";
import { findRepoRoot } from "../lib/paths.js";
import {
  driftByTurn,
  parseTranscript,
  replaySessions,
  tallyRules,
  type ReplaySession,
} from "../lib/replay.js";
import { codexSessionsDir, codexSessionsFor } from "../lib/replayCodex.js";
import { opencodeDbPath, opencodeSessionsFor } from "../lib/replayOpencode.js";
import { piSessionsDir, piSessionsFor } from "../lib/replayPi.js";
import { say, usd, warn } from "../lib/ui.js";
import { Header } from "../ui/components/Header.js";
import { showLive } from "../ui/render.js";
import { ReplayView, type ReplayData } from "../ui/views/ReplayView.js";
import { collectReplaySessions, type ReplayCollection } from "../lib/replayCollection.js";

/** Claude Code names the transcript directory after the repo path. */
export const claudeProjectDir = (root: string): string =>
  path.join(homedir(), ".claude", "projects", root.replace(/[/.]/g, "-"));

const transcriptFiles = (target: string): string[] => {
  const stat = statSync(target);
  if (stat.isFile()) return [target];
  return readdirSync(target)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(target, name))
    .sort();
};

const sessionsFor = async (
  host: Host,
  root: string,
  paths: readonly string[],
): Promise<ReplayCollection> => {
  let sessions: ReplaySession[];
  switch (host) {
    case "claude":
      return collectReplaySessions(
        root,
        (paths.length > 0 ? paths : [claudeProjectDir(root)]).flatMap(transcriptFiles),
        parseTranscript,
      );
    case "codex":
      return codexSessionsFor(root, paths[0] ?? codexSessionsDir());
    case "opencode":
      sessions = opencodeSessionsFor(root, paths[0] ?? opencodeDbPath());
      break;
    case "pi":
      sessions = (paths.length > 0 ? paths : [piSessionsDir()]).flatMap((target) =>
        piSessionsFor(root, target),
      );
      break;
    default:
      return assertNever(host);
  }
  return { sessions, skippedSessions: [] };
};

export const runReplay = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      concurrency: { type: "string", default: "3" },
      "max-sessions": { type: "string" },
      diffs: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const [first, ...rest] = positionals;
  if (first === undefined)
    throw new AbideError(
      "HOST_UNKNOWN",
      "name the agent whose sessions to replay: abide replay claude|codex|opencode|pi [--repo <path>]",
    );
  const named = hostSchema.safeParse(first.toLowerCase());
  // no agent name: positionals are Claude Code transcripts
  const host: Host = named.success ? named.data : "claude";
  const paths = named.success ? rest : positionals;
  const root = findRepoRoot(values.repo ?? process.cwd());
  if (!hasApiKey(root)) throw new AbideError("NO_API_KEY", NO_KEY_HINT);
  const loaded = loadRules(root);
  if (loaded.rules.length === 0)
    throw new AbideError(
      "RUBRIC_MISSING",
      `no rubric in ${root} or ~/.abide; run abide compile there first`,
    );
  const cap = values["max-sessions"] === undefined ? Infinity : Number(values["max-sessions"]);
  const collected = await sessionsFor(host, root, paths);
  const sessions = collected.sessions.slice(0, cap);
  const { skippedSessions } = collected;
  for (const skipped of skippedSessions)
    warn(`Skipped session ${JSON.stringify(skipped.file)}: ${skipped.reason} (${skipped.code})`);
  const exitCode = skippedSessions.length > 0 && collected.sessions.length === 0 ? 1 : 0;
  const editCount = sessions.reduce(
    (n, s) => n + s.turns.reduce((m, t) => m + t.edits.length, 0),
    0,
  );
  const concurrency = Math.max(1, Number(values.concurrency));

  const run = async (progress: (label: string) => void): Promise<ReplayData> => {
    const started = performance.now();
    const result = await replaySessions(
      sessions,
      loaded.rules,
      loaded.thresholds,
      concurrency,
      (done, total, spend) => progress(`${done} of ${total} edits · about ${usd(spend)}`),
      values.diffs,
    );
    return {
      root,
      host: hostLabel(host),
      sessions: sessions.length,
      skippedSessions,
      edits: editCount,
      result,
      drift: driftByTurn(result.edits),
      tallies: tallyRules(result, loaded.rules),
      spendUsd:
        result.edits.reduce((s, e) => s + e.costUsd, 0) +
        result.turns.reduce((s, t) => s + t.costUsd, 0),
      elapsedMs: performance.now() - started,
    };
  };

  if (values.json) {
    const data = await run(() => {});
    say(
      JSON.stringify({
        root,
        host,
        sessions: data.sessions,
        skippedSessions: data.skippedSessions,
        edits: data.edits,
        spendUsd: data.spendUsd,
        elapsedMs: data.elapsedMs,
        drift: data.drift,
        byRule: data.tallies,
        editResults: data.result.edits,
        turnResults: data.result.turns,
      }),
    );
    return exitCode;
  }
  return showLive<ReplayData>({
    header: Header({
      command: "replay",
      where: root,
      note: `${hostLabel(host)}: ${sessions.length} sessions, ${editCount} edits, ${concurrency} at a time`,
    }),
    run,
    done: (data) => ReplayView({ data }),
    code: () => exitCode,
  });
};
