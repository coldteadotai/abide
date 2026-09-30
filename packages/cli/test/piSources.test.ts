import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { discoverGlobalSources, discoverProjectSources } from "../src/lib/sources.js";
import { planCompile } from "../src/hooks/sessionStart.js";

const directories: string[] = [];
const directory = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "abide-pi-sources-"));
  directories.push(dir);
  return dir;
};
const instructions = async (cwd: string, agentDir: string) => {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  return loader.getAgentsFiles().agentsFiles.map((file) => file.path);
};
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

it("discovers the Pi global instructions that its resource loader actually loads", async () => {
  const home = directory();
  const cwd = directory();
  const agentDir = path.join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, "AGENTS.md");
  writeFileSync(file, "No abstractions for single-use code\n");
  vi.stubEnv("ABIDE_HOME_DIR", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  expect(await instructions(cwd, agentDir)).toContain(file);
  expect(discoverGlobalSources()).toMatchObject([
    { path: "~/.pi/agent/AGENTS.md", absolute: file, required: true, origin: "global" },
  ]);
  expect(planCompile(cwd).targets.map((target) => target.which)).toEqual(["global"]);
});

it("honors a configured Pi agent directory and its override precedence", async () => {
  const home = directory();
  const cwd = directory();
  const agentDir = directory();
  for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"])
    writeFileSync(path.join(agentDir, name), "No abstractions for single-use code\n");
  vi.stubEnv("ABIDE_HOME_DIR", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const override = path.join(agentDir, "AGENTS.override.md");
  const loaded = await instructions(cwd, agentDir);
  expect(loaded).toContain(override);
  expect(loaded).not.toContain(path.join(agentDir, "AGENTS.md"));
  expect(discoverGlobalSources().map((source) => source.absolute)).toEqual([override]);
});

it("preserves other hosts' project sources when Pi loads a directory override", async () => {
  const cwd = directory();
  const agentDir = directory();
  for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"])
    writeFileSync(path.join(cwd, name), "No abstractions for single-use code\n");
  const override = path.join(cwd, "AGENTS.override.md");
  const loaded = await instructions(cwd, agentDir);
  expect(loaded).toContain(override);
  expect(loaded).not.toContain(path.join(cwd, "AGENTS.md"));
  expect(discoverProjectSources(cwd).map((source) => source.path)).toEqual([
    "AGENTS.override.md",
    "AGENTS.md",
    "CLAUDE.md",
  ]);
  expect(
    planCompile(cwd)
      .targets.find((target) => target.which === "project")
      ?.candidates.map((source) => source.path),
  ).toContain("CLAUDE.md");
});

it("keeps nested override scope consistent with Pi's directory context", async () => {
  const cwd = directory();
  const agentDir = directory();
  const nested = path.join(cwd, "apps", "web");
  mkdirSync(nested, { recursive: true });
  for (const name of ["AGENTS.md", "AGENTS.override.md"])
    writeFileSync(path.join(nested, name), "No abstractions for single-use code\n");
  expect(await instructions(nested, agentDir)).toContain(path.join(nested, "AGENTS.override.md"));
  expect(discoverProjectSources(cwd)).toMatchObject([
    { path: "apps/web/AGENTS.override.md", scope: "apps/web/**/*", required: true },
    { path: "apps/web/AGENTS.md", scope: "apps/web/**/*", required: true },
  ]);
});
