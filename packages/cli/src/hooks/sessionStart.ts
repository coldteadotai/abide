import { sessionStartInputSchema, type HookOutput } from "@coldtea/abide-schema";
import { compilePrompt, type CompileTarget } from "../lib/compilePrompt.js";
import { appendEvent } from "../lib/events.js";
import { hasApiKey } from "../lib/credentials.js";
import { findLintConfigs } from "../lib/lintConfig.js";
import { placeCompileSkill } from "../lib/packageRoot.js";
import { findRepoRoot, globalRubricPath, homeDir, rubricPath } from "../lib/paths.js";
import { readRubric } from "../lib/rubricFile.js";
import { pruneOldTurns } from "../lib/session.js";
import {
  checkStaleness,
  discoverGlobalSources,
  discoverProjectSources,
  needsCompile,
} from "../lib/sources.js";

export type CompilePlan = {
  targets: CompileTarget[];
  invalid: string[];
  /** Rubrics left alone because they are marked manual. */
  manual: CompileTarget["which"][];
  noSources: boolean;
};

/** What, if anything, needs compiling for this repository and this machine. */
export const planCompile = (root: string): CompilePlan => {
  const targets: CompileTarget[] = [];
  const invalid: string[] = [];
  const manual: CompileTarget["which"][] = [];

  const project = discoverProjectSources(root);
  const projectRead = readRubric(rubricPath(root));
  if (projectRead.kind === "invalid") {
    invalid.push(`${projectRead.path}: ${projectRead.issues.slice(0, 3).join("; ")}`);
  }
  const projectRubric = projectRead.kind === "ok" ? projectRead.rubric : undefined;
  const projectStale = checkStaleness(projectRubric, project, root);
  if (projectStale.status === "manual") manual.push("project");
  if (
    project.some((c) => c.required) &&
    needsCompile(projectStale) &&
    projectRead.kind !== "invalid"
  ) {
    targets.push({
      which: "project",
      root,
      candidates: project,
      staleness: projectStale,
      lintConfigs: findLintConfigs(root),
    });
  }

  const global = discoverGlobalSources();
  const globalRead = readRubric(globalRubricPath());
  if (globalRead.kind === "invalid") {
    invalid.push(`${globalRead.path}: ${globalRead.issues.slice(0, 3).join("; ")}`);
  }
  const globalRubric = globalRead.kind === "ok" ? globalRead.rubric : undefined;
  const globalStale = checkStaleness(globalRubric, global, homeDir());
  if (globalStale.status === "manual") manual.push("global");
  if (global.length > 0 && needsCompile(globalStale) && globalRead.kind !== "invalid") {
    targets.push({
      which: "global",
      root: homeDir(),
      candidates: global,
      staleness: globalStale,
      lintConfigs: [],
    });
  }

  return { targets, invalid, manual, noSources: project.length === 0 && global.length === 0 };
};

export const handleSessionStart = async (raw: unknown): Promise<HookOutput> => {
  const parsed = sessionStartInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const root = findRepoRoot(input.cwd);
  pruneOldTurns();

  const plan = planCompile(root);
  const notices: string[] = [];
  if (!hasApiKey(root)) {
    notices.push(
      "Abide: no API key was found, so edits are not being checked. Run abide login, or put TYPESAFE_AI_API_KEY in the environment or a .env at the repo root, then start a new session.",
    );
  }
  for (const problem of plan.invalid) {
    notices.push(`Abide: rubric could not be read and is being ignored: ${problem}`);
  }
  const systemMessage = notices.length > 0 ? notices.join("\n") : undefined;

  if (plan.targets.length === 0) {
    return systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage };
  }

  appendEvent(root, {
    kind: "compile-needed",
    at: new Date().toISOString(),
    sessionId: input.session_id,
    reason: plan.targets.map((t) => `${t.which}: ${t.staleness.status}`).join(", "),
    sources: plan.targets.flatMap((t) => t.candidates.map((c) => c.path)),
  });

  return {
    kind: "session-context",
    additionalContext: compilePrompt(placeCompileSkill(root), plan.targets),
    ...(systemMessage === undefined ? {} : { systemMessage }),
  };
};
