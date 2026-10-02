import { DEFAULT_THRESHOLDS, type Rubric, type Thresholds } from "@coldtea/abide-schema";
import { globalRubricPath, homeDir, rubricPath } from "./paths.js";
import { mergeRules, readRubric, type MergedRule } from "./rubricFile.js";

export type LoadedRules = {
  project: Rubric | undefined;
  global: Rubric | undefined;
  rules: MergedRule[];
  thresholds: Thresholds;
  problems: string[];
};

/** Project rubric plus the global one, project winning on a clash. */
export const loadRules = (root: string): LoadedRules => {
  const problems: string[] = [];
  const pick = (file: string): Rubric | undefined => {
    const read = readRubric(file);
    switch (read.kind) {
      case "ok":
        return read.rubric;
      case "invalid":
        problems.push(`${read.path}: ${read.issues[0] ?? "invalid"}`);
        return undefined;
      case "missing":
        return undefined;
      default:
        return undefined;
    }
  };
  const project = pick(rubricPath(root));
  const global = pick(globalRubricPath());
  return {
    project,
    global,
    rules: mergeRules(project, global, root, homeDir()),
    thresholds: project?.thresholds ?? global?.thresholds ?? DEFAULT_THRESHOLDS,
    problems,
  };
};
