import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import picomatch from "picomatch";

export const homeDir = (): string => process.env.ABIDE_HOME_DIR ?? homedir();

export const globalAbideDir = (): string => path.join(homeDir(), ".abide");
export const globalRubricPath = (): string => path.join(globalAbideDir(), "global.json");
export const sessionsDir = (): string => path.join(globalAbideDir(), "sessions");

export const abideDir = (root: string): string => path.join(root, ".abide");
export const rubricPath = (root: string): string => path.join(abideDir(root), "rubric.json");
export const eventsPath = (root: string): string => path.join(abideDir(root), "events.jsonl");

/** A deleted file resolves through its directory. */
export const physicalPath = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const ROOT_MARKERS = [".git", ".abide", "AGENTS.md", "CLAUDE.md"];

/** The nearest ancestor that looks like a repository root, else the start directory. */
export const findRepoRoot = (start: string): string => {
  let dir = path.resolve(start);
  if (!isDir(dir)) dir = path.dirname(dir);
  let fallback: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (fallback === undefined && ROOT_MARKERS.some((m) => existsSync(path.join(dir, m)))) {
      fallback = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback ?? path.resolve(start);
};

export const expandHome = (p: string): string =>
  p === "~" ? homeDir() : p.startsWith("~/") ? path.join(homeDir(), p.slice(2)) : p;

export const piAgentDir = (): string =>
  path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR || path.join(homeDir(), ".pi", "agent")));

/** Absolute location of a rubric source path ("~/x" or repo-relative). */
export const resolveSourcePath = (root: string, sourcePath: string): string =>
  sourcePath.startsWith("~") ? expandHome(sourcePath) : path.resolve(root, sourcePath);

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** The rubric's spelling of an absolute path: repo-relative, "~/..." inside home, else absolute. */
export const toSourcePath = (root: string, absolute: string): string => {
  const rel = path.relative(root, absolute);
  if (
    path.resolve(root) !== homeDir() &&
    rel !== "" &&
    !rel.startsWith("..") &&
    !path.isAbsolute(rel)
  ) {
    return toPosix(rel);
  }
  const fromHome = path.relative(homeDir(), absolute);
  if (fromHome !== "" && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
    return `~/${toPosix(fromHome)}`;
  }
  return toPosix(absolute);
};

/** One spelling for a source path however the agent wrote it. */
export const canonicalSourcePath = (root: string, sourcePath: string): string =>
  toSourcePath(root, resolveSourcePath(root, sourcePath));

export const relativeToRoot = (root: string, absolute: string): string =>
  toPosix(path.relative(root, absolute));

/** Files abide owns are never checked; the agent writes the rubric under supervision of the compile skill. */
export const isAbideOwned = (relativePath: string): boolean =>
  relativePath === ".abide" || relativePath.startsWith(".abide/");

/** Basename globs; also fed to git as pathspecs. */
export const SECRET_FILE_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  ".envrc",
  "*.pem",
  "*.key",
];

const isSecretName = picomatch([...SECRET_FILE_PATTERNS], { dot: true });

export const isSecretFile = (relativePath: string): boolean =>
  isSecretName(path.posix.basename(relativePath));

export const isExcludedPath = (relativePath: string): boolean =>
  isAbideOwned(relativePath) || isSecretFile(relativePath);
