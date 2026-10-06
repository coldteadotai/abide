import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FileDiff } from "./git.js";
import { debug } from "./output.js";

const run = promisify(execFile);

export const CONTEXT_MAX_CHARS = 6000;
const BUDGET_MS = 4000;
const SKELETON_CHARS = 1800;
const HOPS_CHARS = 2400;
const CONVEX_DIR = "packages/backend/convex/";
const SCHEMA_FILE = `${CONVEX_DIR}schema.ts`;
const MAX_SYMBOLS = 8;

/** How many call hops out from each changed symbol; ABIDE_CONTEXT_DEPTH overrides. */
export const contextDepth = (): number =>
  Math.max(1, Math.min(4, Number(process.env.ABIDE_CONTEXT_DEPTH) || 2));

const EXPORT_RE =
  /^[+-]?\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+(\w+)/gm;
const HOP_RE = /^ {2}\w+ ([←→]) (.+) \(([^()]*)\) \[depth (\d+)\]$/gm;
const NOISE_PATH = /\.test\.|\.spec\.|_generated|\.d\.ts/;

class BudgetSpent extends Error {}

const isKilled = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "killed" in error && error.killed === true;

const graft = async (args: string[], root: string, deadline: number): Promise<string> => {
  const left = Math.floor(deadline - performance.now());
  if (left <= 0) throw new BudgetSpent("graft budget spent");
  try {
    const { stdout } = await run(
      process.env.ABIDE_GRAFT_BIN ?? "graft",
      [...args, "--no-refresh"],
      {
        cwd: root,
        timeout: left,
        maxBuffer: 4_000_000,
      },
    );
    const text = stdout
      .split("\n")
      .filter((l) => !l.startsWith("⬆") && !l.startsWith("[graft]"))
      .join("\n")
      .trim();
    return text.includes("no wiring graph") ? "" : text;
  } catch (error) {
    if (isKilled(error)) throw error;
    debug(
      `graft ${args[0]} ${args[1]}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
    return "";
  }
};

/** Ranges of the new file that a diff's hunk headers touch. */
const changedRanges = (diff: string): [number, number][] =>
  [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => [
    Number(m[1]),
    Number(m[1]) + Math.max(Number(m[2] ?? 1) - 1, 0),
  ]);

/** Symbols from a graft skeleton (`- L10-L20  function name  sig`), optionally only those overlapping the ranges. */
const skeletonSymbols = (skeleton: string, ranges?: [number, number][]): string[] =>
  [...skeleton.matchAll(/^- L(\d+)-L(\d+)\s+\w+\s+(\w+)/gm)]
    .filter(
      (m) =>
        ranges === undefined || ranges.some(([a, b]) => a <= Number(m[2]) && b >= Number(m[1])),
    )
    .flatMap((m) => (m[3] === undefined ? [] : [m[3]]));

/** One line per call hop, nearest hops first, repeats and test/generated files dropped. */
const hopLines = (results: { symbol: string; text: string }[]): string => {
  const hops = new Map<string, number>();
  for (const { symbol, text } of results) {
    for (const m of text.matchAll(HOP_RE)) {
      if (NOISE_PATH.test(m[3] ?? "")) continue;
      hops.set(`${symbol} ${m[1]} ${m[2]} (${m[3]})`, Number(m[4]));
    }
  }
  return [...hops]
    .sort((a, b) => a[1] - b[1])
    .map(([line, depth]) => `d${depth} ${line}`)
    .join("\n");
};

const withoutComments = (text: string): string =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");

/** Table definitions from the Convex schema for every table name the text mentions. */
const schemaTables = async (root: string, text: string): Promise<string> => {
  const source = await readFile(path.join(root, SCHEMA_FILE), "utf8");
  const out: string[] = [];
  for (const m of source.matchAll(/zodTable\("(\w+)"/g)) {
    if (!text.includes(`"${m[1]}"`)) continue;
    const end = source.indexOf("\n});", m.index);
    out.push(
      `// table ${m[1]}\n${withoutComments(source.slice(source.lastIndexOf("\n", m.index) + 1, end === -1 ? undefined : end + 4))}`,
    );
  }
  return out.slice(0, 3).join("\n");
};

/** Skeletons, callers and callees (to `depth` hops) of the changed symbols, then table definitions, capped. Undefined when graft cannot supply it in time. */
const assemble = async (
  files: readonly FileDiff[],
  root: string,
  depth: number,
  allSymbols: boolean,
): Promise<string | undefined> => {
  try {
    const deadline = performance.now() + BUDGET_MS;
    const skeletons = await Promise.all(
      files.map((f) => graft(["skeleton", f.file], root, deadline)),
    );
    const symbols = new Set<string>();
    files.forEach((f, i) => {
      for (const m of f.text.matchAll(EXPORT_RE)) if (m[1] !== undefined) symbols.add(m[1]);
      for (const s of skeletonSymbols(
        skeletons[i] ?? "",
        allSymbols ? undefined : changedRanges(f.text),
      )) {
        symbols.add(s);
      }
    });
    const wanted = [...symbols].slice(0, MAX_SYMBOLS);
    const hops = await Promise.all(
      wanted.flatMap((symbol) =>
        ["in", "out"].map(async (direction) => ({
          symbol,
          text: await graft(
            ["callers", symbol, "--direction", direction, "--depth", String(depth)],
            root,
            deadline,
          ),
        })),
      ),
    );
    const text = files.map((f) => f.text).join("\n");
    const schema = files.some((f) => f.file.startsWith(CONVEX_DIR))
      ? await schemaTables(root, text).catch((e: unknown) => {
          debug(`schema: ${e instanceof Error ? e.message : String(e)}`);
          return "";
        })
      : "";
    const skeleton = skeletons
      .map((s, i) =>
        s === ""
          ? ""
          : `${files[i]?.file}\n${s
              .split("\n")
              .map((l) => l.slice(0, 140))
              .join("\n")}`,
      )
      .filter(Boolean)
      .join("\n");
    let context = "";
    for (const [title, body, cap] of [
      ["File skeletons", skeleton, SKELETON_CHARS],
      [
        `Callers and callees of changed symbols (to ${depth} hops, nearest first)`,
        hopLines(hops),
        HOPS_CHARS,
      ],
      ["Table definitions", schema, CONTEXT_MAX_CHARS],
    ] as const) {
      const room = CONTEXT_MAX_CHARS - context.length - title.length - 5;
      if (body !== "" && room > 0)
        context += `## ${title}\n${body.slice(0, Math.min(cap, room))}\n`;
    }
    return context === "" ? undefined : context;
  } catch (error) {
    debug(`context omitted: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

/** Turn phase: context for a set of changed files. */
export const buildContext = (
  fileDiffs: readonly FileDiff[],
  root = process.cwd(),
  depth = contextDepth(),
): Promise<string | undefined> => assemble(fileDiffs, root, depth, false);

/** Audit: context for one whole file, built once and reused for each of its chunks. */
export const buildFileContext = (
  file: string,
  content: string,
  root = process.cwd(),
  depth = contextDepth(),
): Promise<string | undefined> => assemble([{ file, text: content }], root, depth, true);
