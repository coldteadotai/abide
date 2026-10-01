import { parseArgs } from "node:util";
import { AbideError, assertNever, type AbideErrorCode, type Rubric } from "@coldtea/abide-schema";
import { parseCompileAgent, runHeadless, selectCompileAgent } from "../lib/headless.js";
import { hostLabel } from "../lib/hosts.js";
import { compilePrompt, type TuneStats } from "../lib/compilePrompt.js";
import { readEvents } from "../lib/events.js";
import { findLintConfigs } from "../lib/lintConfig.js";
import { placeCompileSkill } from "../lib/packageRoot.js";
import { findRepoRoot, globalRubricPath, homeDir, rubricPath, toSourcePath } from "../lib/paths.js";
import { readRubric } from "../lib/rubricFile.js";
import { checkStaleness, discoverGlobalSources, discoverProjectSources } from "../lib/sources.js";
import { say } from "../lib/ui.js";
import { Callout } from "../ui/components/Callout.js";
import { Header } from "../ui/components/Header.js";
import { showStatic } from "../ui/render.js";
import { CompileDoneView } from "../ui/views/CompileDoneView.js";
import { planCompile } from "../hooks/sessionStart.js";

const tuneStats = (
  root: string,
  file: string,
): { rubric: Rubric; stats: TuneStats[] } | undefined => {
  const read = readRubric(file);
  if (read.kind !== "ok") return undefined;
  const fired = new Map<string, number>();
  const checks = new Map<string, number>();
  for (const event of readEvents(root)) {
    if (event.kind !== "check") continue;
    for (const v of event.verdicts) {
      checks.set(v.ruleId, (checks.get(v.ruleId) ?? 0) + 1);
      if (v.band === "act") fired.set(v.ruleId, (fired.get(v.ruleId) ?? 0) + 1);
    }
  }
  const stats = read.rubric.rules
    .filter((r) => r.check.type === "model")
    .map((r) => ({
      rule: r.id,
      status: r.status,
      median: r.calibration?.median,
      fired: fired.get(r.id) ?? 0,
      checks: checks.get(r.id) ?? 0,
    }));
  return { rubric: read.rubric, stats };
};

/** Reads back the rubric the agent just wrote and boxes what to do with it. */
const showCompiled = async (
  root: string,
  which: "project" | "global",
  file: string,
): Promise<void> => {
  const read = readRubric(file);
  const label = toSourcePath(root, file);

  switch (read.kind) {
    case "ok":
      await showStatic(CompileDoneView({ data: { which, file: label, rules: read.rubric.rules } }));
      return;

    case "missing":
      await showStatic(
        Callout({
          tone: "warn",
          title: `The turn finished but ${label} was not written`,
          children: "Start your agent in this repo and ask it to compile the rubric.",
        }),
      );
      return;

    case "invalid":
      await showStatic(
        Callout({
          tone: "bad",
          title: `The turn finished but ${label} does not validate`,
          children: read.issues.slice(0, 3).join("\n"),
        }),
      );
      return;

    default:
      return assertNever(read);
  }
};

/** Compiles now, in a headless agent turn, instead of waiting for the next session. */
export const runCompile = async (argv: string[], tune: boolean): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: "boolean", default: false },
      global: { type: "boolean", default: false },
      agent: { type: "string" },
    },
  });
  const requestedAgent = parseCompileAgent(values.agent);
  const root = findRepoRoot(process.cwd());
  const plan = planCompile(root);
  if (plan.invalid.length > 0) {
    await showStatic(
      Callout({
        tone: "bad",
        title: "Fix the rubric first",
        children: plan.invalid.map((p) => p).join("\n"),
      }),
    );
    return 1;
  }
  if (plan.noSources)
    throw new AbideError(
      "NO_INSTRUCTION_FILES",
      "found 0 instruction files, so there is nothing to compile. Add an AGENTS.md.",
    );

  let prompt: string;
  const compiled: { which: "project" | "global"; file: string }[] = [];
  if (tune) {
    const stats = tuneStats(root, values.global ? globalRubricPath() : rubricPath(root));
    if (stats === undefined)
      throw new AbideError("RUBRIC_MISSING", "nothing to tune yet; compile first");
    const target = values.global
      ? {
          which: "global" as const,
          root: homeDir(),
          candidates: discoverGlobalSources(),
          staleness: checkStaleness(stats.rubric, discoverGlobalSources(), homeDir()),
          lintConfigs: [],
        }
      : {
          which: "project" as const,
          root,
          candidates: discoverProjectSources(root),
          staleness: checkStaleness(stats.rubric, discoverProjectSources(root), root),
          lintConfigs: findLintConfigs(root),
        };
    prompt = compilePrompt(placeCompileSkill(root), [target], stats);
    compiled.push({
      which: target.which,
      file: values.global ? globalRubricPath() : rubricPath(root),
    });
  } else {
    if (plan.targets.length === 0) {
      await showStatic(Callout({ tone: "ok", title: "Rubric is up to date. Nothing to compile." }));
      return 0;
    }
    prompt = compilePrompt(placeCompileSkill(root), plan.targets);
    for (const t of plan.targets)
      compiled.push({
        which: t.which,
        file: t.which === "global" ? globalRubricPath() : rubricPath(root),
      });
  }

  if (values.print) {
    say(prompt);
    return 0;
  }
  const agent = selectCompileAgent(requestedAgent);
  if (agent === undefined) {
    await showStatic(
      Callout({
        tone: "warn",
        title: "Neither claude nor pi is available. Paste this into an agent session in this repo:",
      }),
    );
    say(prompt);
    return 0;
  }
  let authenticationNote: string;
  let failureCode: AbideErrorCode;
  switch (agent) {
    case "claude":
      authenticationNote = "This runs on your subscription.";
      failureCode = "CLAUDE_UNAVAILABLE";
      break;
    case "pi":
      authenticationNote = "This uses your Pi model and authentication settings.";
      failureCode = "HEADLESS_UNAVAILABLE";
      break;
    default:
      return assertNever(agent);
  }
  await showStatic(
    Header({
      command: tune ? "tune" : "compile",
      where: root,
      note:
        `Starting a headless ${hostLabel(agent)} turn to ` +
        (tune ? "rewrite the weak rules" : "compile the rubric") +
        `. ${authenticationNote}`,
    }),
  );
  const code = await runHeadless(agent, root, prompt);
  if (code !== 0) throw new AbideError(failureCode, `${agent} exited with ${code}`);
  for (const c of compiled) await showCompiled(root, c.which, c.file);
  return 0;
};
