import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AbideError } from "@coldtea/abide-schema";

const hookEntrySchema = z
  .object({ type: z.string(), command: z.string().optional() })
  .passthrough();
const hookGroupSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(hookEntrySchema) })
  .passthrough();
const settingsSchema = z
  .object({ hooks: z.record(z.string(), z.array(hookGroupSchema)).optional() })
  .passthrough();
type Settings = z.infer<typeof settingsSchema>;
type HookEntry = z.infer<typeof hookEntrySchema>;
type HookGroup = z.infer<typeof hookGroupSchema>;

export const ABIDE_HOOK_MARKER = "abide-hook.js";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";

export type HookSpec = { event: HookEvent; matcher?: string; command: string; timeout: number };

export const hookSpecs = (hookScript: string): HookSpec[] => {
  const cmd = (name: string): string => `node "${hookScript}" ${name}`;
  return [
    { event: "SessionStart", command: cmd("session-start"), timeout: 10 },
    { event: "UserPromptSubmit", command: cmd("turn-start"), timeout: 10 },
    {
      event: "PostToolUse",
      matcher: "Edit|Write|MultiEdit|apply_patch",
      command: cmd("post-tool-use"),
      timeout: 20,
    },
    { event: "Stop", command: cmd("stop"), timeout: 30 },
  ];
};

const isOurs = (entry: HookEntry): boolean => entry.command?.includes(ABIDE_HOOK_MARKER) ?? false;

/** A group shared with someone else's hook keeps theirs. */
const withoutOurs = (groups: readonly HookGroup[]): { kept: HookGroup[]; removed: number } => {
  const kept: HookGroup[] = [];
  let removed = 0;
  for (const group of groups) {
    const hooks = group.hooks.filter((h) => !isOurs(h));
    removed += group.hooks.length - hooks.length;
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return { kept, removed };
};

export const readSettings = (file: string): Settings => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return {};
    throw new AbideError("SETTINGS_INVALID", `could not read settings at ${file}`, { cause });
  }
  if (raw.trim() === "") return {};
  try {
    return settingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new AbideError("SETTINGS_INVALID", `${file} is not a settings file abide can edit`, {
      cause: error,
    });
  }
};

export const installHooks = (file: string, specs: readonly HookSpec[]): void => {
  const settings = readSettings(file);
  const hooks = { ...(settings.hooks ?? {}) };
  for (const spec of specs) {
    const { kept } = withoutOurs(hooks[spec.event] ?? []);
    const group: HookGroup = {
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [{ type: "command", command: spec.command, timeout: spec.timeout }],
    };
    hooks[spec.event] = [...kept, group];
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
};

export const uninstallHooks = (file: string): number => {
  const settings = readSettings(file);
  if (settings.hooks === undefined) return 0;
  let removed = 0;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const result = withoutOurs(groups);
    removed += result.removed;
    if (result.kept.length > 0) hooks[event] = result.kept;
  }
  writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  return removed;
};

export const installedHookEvents = (file: string): HookEvent[] => {
  const settings = readSettings(file);
  const events: HookEvent[] = [];
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
  ] satisfies HookEvent[]) {
    if ((settings.hooks?.[event] ?? []).some((g) => g.hooks.some(isOurs))) events.push(event);
  }
  return events;
};
