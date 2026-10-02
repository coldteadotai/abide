import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_DIFF_INPUT_CHARS } from "../lib/constants.js";
import { readRegularText } from "../lib/regularFile.js";
import { readStdin } from "../lib/stdin.js";
import type { FileState } from "./protocol.js";

const maxBytes = MAX_DIFF_INPUT_CHARS / 2;
const requestSchema = z.object({ file: z.string().max(4096).refine(path.isAbsolute) });

export const captureFile = (file: string): FileState => {
  const ancestors: string[] = [];
  for (let current = file; ; current = path.dirname(current)) {
    ancestors.push(current);
    if (path.dirname(current) === current) break;
  }
  for (const ancestor of ancestors.reverse()) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) return { kind: "unreadable" };
    } catch (error) {
      return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
        ? { kind: "absent" }
        : { kind: "unreadable" };
    }
  }
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return { kind: "unreadable" };
    if (stat.size > maxBytes) return { kind: "oversized" };
    const text = readRegularText(file, { maxBytes, followSymlinks: false });
    return text === undefined ? { kind: "unreadable" } : { kind: "present", text };
  } catch {
    return { kind: "unreadable" };
  }
};

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let state: FileState = { kind: "unreadable" };
  try {
    const parsed = requestSchema.safeParse(JSON.parse(await readStdin()));
    if (parsed.success) state = captureFile(parsed.data.file);
  } catch {
    state = { kind: "unreadable" };
  }
  process.stdout.write(`${JSON.stringify(state)}\n`, () => process.exit(0));
}
