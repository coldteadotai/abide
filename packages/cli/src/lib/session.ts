import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MAX_TASK_CHARS, OPEN_TURN_MAX_AGE_MS, SESSION_STATE_MAX_AGE_MS } from "./constants.js";
import { physicalPath, sessionsDir } from "./paths.js";

/**
 * Turn state on disk, one directory per session and prompt, written as
 * first-write-wins files. Hooks for parallel tool calls run at the same time,
 * so nothing here is read, changed and written back: a file's start-of-turn
 * content is created once with `wx`, and a counter is the number of files
 * with its prefix, each created with `wx`.
 */

const safe = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, "_");
const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export const NO_PROMPT_TURN = "turn";

export const turnDir = (sessionId: string, promptId: string | undefined): string =>
  path.join(sessionsDir(), safe(sessionId), safe(promptId ?? NO_PROMPT_TURN));

const fileStartSchema = z.object({ path: z.string(), original: z.string().nullable() });
export type FileStart = z.infer<typeof fileStartSchema>;

// Owner-only: a start-of-turn snapshot holds whatever the agent edited.
const writePrivate = (file: string, contents: string, flag: "w" | "wx" = "w"): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, contents, { flag, mode: 0o600 });
};

const createOnce = (file: string, contents: string): boolean => {
  try {
    writePrivate(file, contents, "wx");
    return true;
  } catch {
    return false;
  }
};

const countWithPrefix = (dir: string, prefix: string): number => {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix)).length;
  } catch {
    return 0;
  }
};

/** Bumps a counter by creating the next numbered file. Two hooks racing both land: each retries past the other's number. */
const increment = (dir: string, prefix: string): number => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const next = countWithPrefix(dir, prefix) + 1;
    if (createOnce(path.join(dir, `${prefix}${next}`), "")) return next;
  }
  return countWithPrefix(dir, prefix);
};

/** The content a file had when this turn first touched it. Only the first record counts. */
export const recordFileStart = (
  dir: string,
  absolutePath: string,
  original: string | null,
): void => {
  const record: FileStart = { path: absolutePath, original };
  createOnce(path.join(dir, "files", `${shortHash(absolutePath)}.json`), JSON.stringify(record));
  // Resolved now: the symlink may point elsewhere by Stop.
  const physical = physicalPath(absolutePath);
  createOnce(path.join(dir, "touched", shortHash(physical)), physical);
};

/** Files this session's edit tools reached, symlinks resolved at edit time. */
export const readTouched = (dir: string): string[] => {
  const touched: string[] = [];
  try {
    for (const name of readdirSync(path.join(dir, "touched"))) {
      try {
        touched.push(readFileSync(path.join(dir, "touched", name), "utf8"));
      } catch {
        // being written by the other hook
      }
    }
  } catch {
    // no edits this turn
  }
  return touched;
};

const readRecords = <T>(dir: string, schema: z.ZodType<T>): T[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const name of names) {
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // torn
    }
  }
  return records;
};

export const readFileStarts = (dir: string): FileStart[] =>
  readRecords(path.join(dir, "files"), fileStartSchema);

/** Stop judges these again: a block the agent ignored must not end the turn quietly. */
export const recordBlockedFile = (dir: string, relativePath: string): void => {
  createOnce(path.join(dir, "blocked", shortHash(relativePath)), relativePath);
};

export const readBlockedFiles = (dir: string): Set<string> => {
  const files = new Set<string>();
  try {
    for (const name of readdirSync(path.join(dir, "blocked"))) {
      try {
        files.add(readFileSync(path.join(dir, "blocked", name), "utf8"));
      } catch {
        // being written by the other hook
      }
    }
  } catch {
    // no blocks this turn
  }
  return files;
};

const checkedSchema = z.object({
  path: z.string(),
  /** Null when the file did not exist. */
  before: z.string().nullable(),
  after: z.string(),
});
/** An edit a check judged, as blob ids on either side of it. */
export type CheckedEdit = z.infer<typeof checkedSchema>;

/** All kept: Stop walks them as a chain from turn start to the file as it stands. */
export const recordChecked = (dir: string, record: CheckedEdit): void => {
  const contents = JSON.stringify(record);
  createOnce(path.join(dir, "checked", `${shortHash(contents)}.json`), contents);
};

export const readChecked = (dir: string): CheckedEdit[] =>
  readRecords(path.join(dir, "checked"), checkedSchema);

const blockPrefix = (key: string): string => `${shortHash(key)}.`;

export const blockCount = (dir: string, key: string): number =>
  countWithPrefix(path.join(dir, "blocks"), blockPrefix(key));

export const incrementBlock = (dir: string, key: string): number =>
  increment(path.join(dir, "blocks"), blockPrefix(key));

export const stopCheckCount = (dir: string): number =>
  countWithPrefix(path.join(dir, "stops"), "stop.");

export const incrementStopChecks = (dir: string): number =>
  increment(path.join(dir, "stops"), "stop.");

/** The prompt that started the turn, for hosts that send it instead of a transcript. */
export const writePrompt = (dir: string, prompt: string): void => {
  createOnce(path.join(dir, "prompt"), prompt);
};

export const readPrompt = (dir: string): string | undefined => {
  try {
    const text = readFileSync(path.join(dir, "prompt"), "utf8").trim();
    return text === "" ? undefined : text.slice(0, MAX_TASK_CHARS);
  } catch {
    return undefined;
  }
};

/** The git tree the working tree was at when the turn began, when a turn-start hook recorded one. */
export const writeBaseline = (dir: string, tree: string): void => {
  createOnce(path.join(dir, "baseline"), tree);
};

export const readBaseline = (dir: string): string | undefined => {
  try {
    const tree = readFileSync(path.join(dir, "baseline"), "utf8").trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
};

const turnHeadSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** Unix seconds, like git commit times. */
  startedAt: z.number(),
});
/** Lets Stop tell a pull from an edit. */
export type TurnHead = z.infer<typeof turnHeadSchema>;

export const writeTurnHead = (dir: string, head: TurnHead): void => {
  createOnce(path.join(dir, "head"), JSON.stringify(head));
};

export const readTurnHead = (dir: string): TurnHead | undefined => {
  try {
    const parsed = turnHeadSchema.safeParse(
      JSON.parse(readFileSync(path.join(dir, "head"), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** Worktrees share one object store, so a baseline taken in one diffs cleanly, and wrongly, against another. */
export const writeTurnRoot = (dir: string, root: string): void => {
  createOnce(path.join(dir, "root"), root);
};

export const readTurnRoot = (dir: string): string | undefined => {
  try {
    return readFileSync(path.join(dir, "root"), "utf8");
  } catch {
    return undefined;
  }
};

const turnStartedAt = (dir: string): number | undefined => {
  try {
    return statSync(path.join(dir, "root")).mtimeMs;
  } catch {
    return undefined;
  }
};

/** Only a session's newest turn can be open: a new turn ends the last, even without a Stop. */
export const openTurnsIn = (root: string, sessionId: string, now = Date.now()): string[] => {
  let sessions: string[];
  try {
    sessions = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const here = physicalPath(root);
  const open: string[] = [];
  for (const session of sessions) {
    if (session === safe(sessionId)) continue;
    const sessionPath = path.join(sessionsDir(), session);
    let turns: string[];
    try {
      // A new turn directory bumps its session directory's mtime.
      if (now - statSync(sessionPath).mtimeMs > OPEN_TURN_MAX_AGE_MS) continue;
      turns = readdirSync(sessionPath);
    } catch {
      continue;
    }
    let newest: { dir: string; at: number } | undefined;
    for (const turn of turns) {
      const dir = path.join(sessionPath, turn);
      const at = turnStartedAt(dir);
      if (at !== undefined && (newest === undefined || at > newest.at)) newest = { dir, at };
    }
    if (newest === undefined || now - newest.at > OPEN_TURN_MAX_AGE_MS) continue;
    const there = readTurnRoot(newest.dir);
    if (there !== undefined && physicalPath(there) === here) open.push(newest.dir);
  }
  return open;
};

/** Never creates the directory, so a turn that ended stays gone. */
export const markShared = (dir: string): void => {
  try {
    writeFileSync(path.join(dir, "shared"), "", { flag: "wx", mode: 0o600 });
  } catch {
    // already marked, or the turn ended
  }
};

export const isShared = (dir: string): boolean => existsSync(path.join(dir, "shared"));

export const createTurnDiffKey = (fileDiffs: readonly { file: string; text: string }[]): string =>
  shortHash(JSON.stringify(fileDiffs.map((f) => [f.file, f.text])));

export const recordBlockedDiff = (dir: string, key: string): void => {
  createOnce(path.join(dir, "blocked-diffs", key), "");
};

export const wasBlockedOn = (dir: string, key: string): boolean =>
  existsSync(path.join(dir, "blocked-diffs", key));

/**
 * What became of the turn-start snapshot. Absent on a repository without git,
 * where the per-file fallback is the documented mode. `pending` means the
 * hook died before it could say, which for the Stop check is the same as
 * failed: the turn cannot be read back whole.
 */
export type BaselineStatus = "pending" | "ok" | "failed";

const statusFile = (dir: string): string => path.join(dir, "baseline-status");

export const markBaseline = (dir: string, status: BaselineStatus): void => {
  try {
    writePrivate(statusFile(dir), status);
  } catch {
    // nothing to record on; Stop will see no status and take the fallback
  }
};

export const readBaselineStatus = (dir: string): BaselineStatus | undefined => {
  try {
    const raw = readFileSync(statusFile(dir), "utf8").trim();
    return raw === "ok" || raw === "pending" || raw === "failed" ? raw : undefined;
  } catch {
    return undefined;
  }
};

export const hasTurnState = (dir: string): boolean =>
  readFileStarts(dir).length > 0 ||
  readBaseline(dir) !== undefined ||
  readBaselineStatus(dir) !== undefined;

export const clearTurn = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // already gone
  }
};

export const pruneOldTurns = (now = Date.now()): void => {
  try {
    for (const name of readdirSync(sessionsDir())) {
      const file = path.join(sessionsDir(), name);
      if (now - statSync(file).mtimeMs > SESSION_STATE_MAX_AGE_MS)
        rmSync(file, { recursive: true, force: true });
    }
  } catch {
    // no sessions dir yet
  }
};
