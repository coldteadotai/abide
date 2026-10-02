import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const dirs: string[] = [];
const invocationSchema = z.object({
  agent: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
});
const rubric = {
  version: 1,
  compiledAt: "test",
  sources: [{ path: "AGENTS.md" }],
  rules: [],
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (agents: string[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-compile-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const executables = path.join(root, "bin");
  const record = path.join(root, "invocation.json");
  for (const dir of [home, executables, path.join(root, ".git"), path.join(root, ".abide")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, "AGENTS.md"), "Use type, never interface\n");
  writeFileSync(path.join(root, ".abide", "rubric.json"), JSON.stringify(rubric));
  for (const agent of agents) {
    writeFileSync(
      path.join(executables, agent),
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) process.exit(0);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({agent:${JSON.stringify(agent)},args:process.argv.slice(2),cwd:process.cwd()}));
process.exit(Number(process.env.TEST_AGENT_EXIT || 0));
`,
      { mode: 0o755 },
    );
  }
  const env = {
    ...process.env,
    ABIDE_HOME_DIR: home,
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
    PATH: executables,
  };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    execFileSync(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    });
  const failure = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    });
  const invocation = () => invocationSchema.parse(JSON.parse(readFileSync(record, "utf8")));
  return { root, home, record, run, failure, invocation };
};

it.each(["compile", "tune"])("runs %s with Pi print mode and the compile skill", (command) => {
  const f = fixture(["pi", "claude"]);
  const output = f.run([command, "--agent", "pi"]);
  const call = f.invocation();
  expect(call.agent).toBe("pi");
  expect(call.cwd).toBe(f.root);
  expect(call.args.slice(0, 2)).toEqual(["--print", "--no-session"]);
  expect(call.args.at(-1)).toContain("compile-skill.md");
  expect(call.args.at(-1)).toContain("Do not skip the validate and calibrate steps");
  expect(output).toContain("Pi");
  expect(output).not.toContain("This runs on your subscription");
  if (command === "tune") expect(call.args.at(-1)).toContain("Calibration and firing statistics");
});

it("passes the global target and statistics to Pi for tune --global", () => {
  const f = fixture(["pi"]);
  mkdirSync(path.join(f.home, ".abide"));
  writeFileSync(path.join(f.home, "AGENTS.md"), "Use type, never interface\n");
  writeFileSync(path.join(f.home, ".abide", "global.json"), JSON.stringify(rubric));
  f.run(["tune", "--global", "--agent", "pi"]);
  expect(f.invocation().args.at(-1)).toContain(path.join(f.home, ".abide", "global.json"));
  expect(f.invocation().args.at(-1)).toContain("Calibration and firing statistics");
});

it("prefers Claude when both runners are available", () => {
  const f = fixture(["pi", "claude"]);
  f.run(["compile"]);
  expect(f.invocation().agent).toBe("claude");
});

it("falls back to Pi when Claude is unavailable", () => {
  const f = fixture(["pi"]);
  f.run(["compile"]);
  expect(f.invocation().agent).toBe("pi");
});

it("does not fall back when an explicitly selected runner is unavailable", () => {
  const f = fixture(["pi"]);
  const result = f.failure(["compile", "--agent", "claude"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("HEADLESS_UNAVAILABLE");
  expect(existsSync(f.record)).toBe(false);
});

it("returns a Pi failure without starting Claude", () => {
  const f = fixture(["pi", "claude"]);
  const result = f.failure(["compile", "--agent", "pi"], { TEST_AGENT_EXIT: "7" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("pi exited with 7");
  expect(f.invocation().agent).toBe("pi");
});

it("prints the prompt when neither runner is available", () => {
  const f = fixture([]);
  expect(f.run(["compile"])).toContain("compile-skill.md");
  expect(existsSync(f.record)).toBe(false);
});

it("keeps --print independent of runner availability", () => {
  const f = fixture([]);
  expect(f.run(["tune", "--agent", "pi", "--print"])).toContain(
    "Calibration and firing statistics",
  );
  expect(existsSync(f.record)).toBe(false);
});

it("rejects unsupported headless agents", () => {
  const f = fixture(["claude"]);
  const result = f.failure(["compile", "--agent", "codex"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("HOST_UNKNOWN");
  expect(existsSync(f.record)).toBe(false);
});
