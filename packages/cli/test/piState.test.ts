import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleTurnStart } from "../src/hooks/turnStart.js";
import { handleStop, turnDiff } from "../src/hooks/stop.js";
import { readBaseline, turnDir } from "../src/lib/session.js";

const directories: string[] = [];
const setup = async () => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-pi-state-"));
  const home = mkdtempSync(path.join(tmpdir(), "abide-pi-state-home-"));
  directories.push(root, home);
  vi.stubEnv("ABIDE_HOME_DIR", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"));
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(path.join(root, "initial.ts"), "export const initial = 1;\n");
  const identity = { session_id: "pi-state", prompt_id: "activity", cwd: root };
  await handleTurnStart({
    ...identity,
    hook_event_name: "UserPromptSubmit",
    prompt: "Make a local change",
  });
  const dir = turnDir(identity.session_id, identity.prompt_id);
  expect(readBaseline(dir)).toBeDefined();
  return { root, identity, dir };
};
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

it("retains a clean Pi boundary's baseline so a later shell change is still visible", async () => {
  const { root, identity, dir } = await setup();
  const baseline = readBaseline(dir);
  expect(
    await handleStop({ ...identity, hook_event_name: "Stop", turn_state: "preserve" }),
  ).toEqual({ kind: "silent" });
  expect(readBaseline(dir)).toBe(baseline);
  execFileSync(
    process.execPath,
    ["-e", 'require("node:fs").writeFileSync("shell.ts", "export const shell = 1;\\n")'],
    { cwd: root },
  );
  const diff = turnDiff(root, dir);
  expect(diff.kind).toBe("complete");
  if (diff.kind !== "complete") throw new Error("Expected a complete git diff");
  expect(diff.source).toBe("git");
  expect(diff.files).toEqual(["shell.ts"]);
  expect(await handleStop({ ...identity, hook_event_name: "Stop", turn_state: "clear" })).toEqual({
    kind: "silent",
  });
  expect(existsSync(dir)).toBe(false);
});

it("keeps the existing cleanup behavior for hosts that do not request retention", async () => {
  const { identity, dir } = await setup();
  expect(await handleStop({ ...identity, hook_event_name: "Stop" })).toEqual({ kind: "silent" });
  expect(existsSync(dir)).toBe(false);
});
