import type { HookOutput } from "@coldtea/abide-schema";
import { debug, emit } from "./output.js";
import { readStdin } from "./stdin.js";

export type HookName = "session-start" | "turn-start" | "post-tool-use" | "stop";

const EVENT: Record<HookName, "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop"> = {
  "session-start": "SessionStart",
  "turn-start": "UserPromptSubmit",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
};

/**
 * Every hook goes through here: parse what we can, never throw, and leave
 * within the budget whatever else is going on. The deadline exits the
 * process rather than resolving a promise, because a promise cannot interrupt
 * work that is still running, and an open handle would keep us alive after it.
 */
export const runHook = async (
  name: HookName,
  handler: (raw: unknown) => Promise<HookOutput>,
  budgetMs: number,
): Promise<void> => {
  process.exitCode = 0;
  let finished = false;
  const finish = (output: HookOutput): void => {
    if (finished) return;
    finished = true;
    try {
      emit(output, EVENT[name], () => process.exit(0));
    } catch {
      process.exit(0);
    }
  };
  setTimeout(() => {
    debug(`${name}: gave up after ${budgetMs}ms`);
    process.exit(0);
  }, budgetMs);
  try {
    const text = await readStdin();
    let raw: unknown = undefined;
    try {
      raw = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      debug(`${name}: stdin was not JSON`);
    }
    finish(await handler(raw));
  } catch (error) {
    debug(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    finish({ kind: "silent" });
  }
};
