import path from "node:path";
import { createTwoFilesPatch, structuredPatch } from "diff";
import type { PatchHunk, PostToolUseInput } from "@coldtea/abide-schema";
import { assertNever } from "@coldtea/abide-schema";
import { parseApplyPatch } from "./applyPatch.js";
import { DIFF_TIMEOUT_MS, MAX_DIFF_INPUT_CHARS, MAX_STATE_CHARS } from "./constants.js";
import { readRegularText } from "./regularFile.js";

export const renderHunks = (hunks: readonly PatchHunk[]): string =>
  hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`,
    )
    .join("\n");

/** Undefined when the diff would take longer than a hook may spend on it, or the inputs are too big to try. */
const hunksBetween = (
  before: string,
  after: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): PatchHunk[] | undefined => {
  if (timeoutMs <= 0 || before.length + after.length > MAX_DIFF_INPUT_CHARS) return undefined;
  const patch = structuredPatch("a", "b", before, after, undefined, undefined, {
    context: 3,
    timeout: timeoutMs,
  });
  return patch?.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
};

const allAdded = (content: string): string => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
};

/**
 * One file's change from a PostToolUse payload. `text` is undefined when the
 * diff could not be computed within the time a hook may spend on it; the
 * caller skips that file and says so rather than holding the agent.
 * `original` is the file's content before the edit when the host said, for
 * a Stop check without a git baseline. `after` is derived from the payload
 * alone, so it is exactly what the judge saw; null when it cannot be.
 */
export type EditHunk = {
  filePath: string;
  text: string | undefined;
  isNewFile: boolean;
  original: string | null;
  after: string | null;
};

type Replacement = { old: string; new: string; all?: boolean };

// A function replacement keeps "$" in the new text literal.
const applyEdit = (content: string, edit: Replacement): string =>
  edit.all
    ? content.replaceAll(edit.old, () => edit.new)
    : content.replace(edit.old, () => edit.new);

const applyEdits = (content: string | null, edits: readonly Replacement[]): string | null =>
  content === null ? null : edits.reduce(applyEdit, content);

const synthesized = (
  before: string,
  after: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): string | undefined => {
  const hunks = hunksBetween(before, after, timeoutMs);
  return hunks === undefined ? undefined : renderHunks(hunks);
};

/** Time left on a budget that several diffs share. */
export const remainingMs = (deadline: number): number => Math.floor(deadline - performance.now());

/** Reverses the edit on the file as it is now, since the host did not send the original. */
const reversed = (filePath: string, edits: readonly Replacement[]): string | null =>
  applyEdits(
    readRegularText(filePath) ?? null,
    [...edits].reverse().map((e) => ({ old: e.new, new: e.old, ...(e.all ? { all: true } : {}) })),
  );

/** Every file one PostToolUse payload changed. Claude-style tools name one file; a Codex patch may name several. */
export const editsFromPostToolUse = (input: PostToolUseInput): EditHunk[] => {
  switch (input.tool_name) {
    case "Edit": {
      const hostPatch = input.tool_response?.structuredPatch;
      const fromHost = hostPatch && hostPatch.length > 0 ? renderHunks(hostPatch) : undefined;
      const filePath = input.tool_input.file_path;
      const text =
        fromHost ?? synthesized(input.tool_input.old_string, input.tool_input.new_string);
      const edits: Replacement[] = [
        {
          old: input.tool_input.old_string,
          new: input.tool_input.new_string,
          ...(input.tool_input.replace_all ? { all: true } : {}),
        },
      ];
      const original = input.tool_response?.originalFile ?? reversed(filePath, edits);
      return [{ filePath, text, isNewFile: false, original, after: applyEdits(original, edits) }];
    }
    case "Write": {
      const hostPatch = input.tool_response?.structuredPatch;
      const fromHost = hostPatch && hostPatch.length > 0 ? renderHunks(hostPatch) : undefined;
      const filePath = input.tool_input.file_path;
      const original = input.tool_response?.originalFile;
      const after = input.tool_input.content;
      if (original === null || original === undefined) {
        const text = after.length > MAX_DIFF_INPUT_CHARS ? undefined : allAdded(after);
        return [{ filePath, text, isNewFile: true, original: null, after }];
      }
      const text = fromHost ?? synthesized(original, after);
      return [{ filePath, text, isNewFile: false, original, after }];
    }
    case "MultiEdit": {
      const hostPatch = input.tool_response?.structuredPatch;
      const fromHost = hostPatch && hostPatch.length > 0 ? renderHunks(hostPatch) : undefined;
      const filePath = input.tool_input.file_path;
      const edits: Replacement[] = input.tool_input.edits.map((e) => ({
        old: e.old_string,
        new: e.new_string,
        ...(e.replace_all ? { all: true } : {}),
      }));
      const original = input.tool_response?.originalFile ?? reversed(filePath, edits);
      const after = applyEdits(original, edits);
      if (fromHost !== undefined) {
        return [{ filePath, text: fromHost, isNewFile: false, original, after }];
      }
      // One budget for every part: each on its own could pass while together they hold the hook.
      const deadline = performance.now() + DIFF_TIMEOUT_MS;
      const parts: string[] = [];
      let text: string | undefined = undefined;
      for (const edit of input.tool_input.edits) {
        const part = synthesized(edit.old_string, edit.new_string, remainingMs(deadline));
        if (part === undefined) {
          parts.length = 0;
          break;
        }
        parts.push(part);
      }
      if (parts.length > 0) text = parts.join("\n");
      return [{ filePath, text, isNewFile: false, original, after }];
    }
    case "apply_patch":
      return parseApplyPatch(input.tool_input.command).flatMap((file): EditHunk[] => {
        const filePath = path.resolve(
          input.cwd,
          file.kind === "update" ? (file.movedTo ?? file.path) : file.path,
        );
        switch (file.kind) {
          case "add":
            return [{ filePath, text: file.text, isNewFile: true, original: null, after: null }];
          case "update":
            return [{ filePath, text: file.text, isNewFile: false, original: null, after: null }];
          case "delete":
            return [];
          default:
            return assertNever(file);
        }
      });
    default:
      return assertNever(input);
  }
};

/** Files an apply_patch deleted or moved away, so Stop can count them as this session's. */
export const removedByPatch = (input: PostToolUseInput): string[] => {
  switch (input.tool_name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
      return [];
    case "apply_patch":
      return parseApplyPatch(input.tool_input.command).flatMap((file): string[] => {
        switch (file.kind) {
          case "add":
            return [];
          case "update":
            return file.movedTo === undefined ? [] : [path.resolve(input.cwd, file.path)];
          case "delete":
            return [path.resolve(input.cwd, file.path)];
          default:
            return assertNever(file);
        }
      });
    default:
      return assertNever(input);
  }
};

/** Undefined when the diff could not be computed within the time a hook may spend on it. */
export const unifiedDiff = (
  relativePath: string,
  before: string,
  after: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): string | undefined =>
  timeoutMs <= 0 || before.length + after.length > MAX_DIFF_INPUT_CHARS
    ? undefined
    : createTwoFilesPatch(
        `a/${relativePath}`,
        `b/${relativePath}`,
        before,
        after,
        undefined,
        undefined,
        {
          context: 3,
          timeout: timeoutMs,
        },
      );

export const addedLines = (hunkText: string): string[] =>
  hunkText
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));

export const changedLineCount = (hunkText: string): number =>
  hunkText.split("\n").filter((l) => /^[+-](?![+-]{2})/.test(l)).length;

export const boundState = (
  text: string,
  max = MAX_STATE_CHARS,
): { text: string; truncated: boolean } =>
  text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, max)}\n[abide: diff cut at ${max} characters]`, truncated: true };
