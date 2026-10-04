import path from "node:path";
import picomatch from "picomatch";
import type { Rule } from "@coldtea/abide-schema";

const matchers = new Map<string, (p: string) => boolean>();

const matcherFor = (globs: readonly string[]): ((p: string) => boolean) => {
  const key = globs.join("\n");
  let m = matchers.get(key);
  if (m === undefined) {
    m = picomatch([...globs], { dot: true });
    matchers.set(key, m);
  }
  return m;
};

/** Repo-relative posix path against the rule's globs. No scope means every file. */
export const ruleAppliesTo = (rule: Pick<Rule, "scope">, relativePath: string): boolean =>
  rule.scope === undefined || matcherFor(rule.scope)(relativePath);

/**
 * Whether a rule belongs to the repo being checked. No repos means every repo.
 *
 * This is the answer `scope` cannot give. A global rule's globs are resolved
 * against the repo the edit is in, so `docs/**` there matches `docs/` in every
 * repo; a repo entry is matched against the repo root itself, either as the
 * literal `~/...` spelling or as an absolute path. Comparison is on whole path
 * segments, so `~/workspace/api` does not pull in `~/workspace/api-docs`.
 */
export const ruleAppliesToRepo = (
  rule: Pick<Rule, "repos">,
  root: string,
  home: string,
): boolean => {
  if (rule.repos === undefined) return true;
  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  const candidates = new Set<string>();
  const absolute = path.resolve(root);
  candidates.add(absolute);
  if (absolute === home) candidates.add("~");
  else if (absolute.startsWith(homePrefix))
    candidates.add(`~/${absolute.slice(homePrefix.length)}`);
  for (const entry of rule.repos) {
    const wanted =
      entry === "~" ? home : entry.startsWith("~/") ? path.join(home, entry.slice(2)) : entry;
    if (candidates.has(path.resolve(wanted))) return true;
  }
  return false;
};
