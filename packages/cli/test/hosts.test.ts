import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectHosts,
  installHost,
  installTarget,
  parseHost,
  uninstallHost,
} from "../src/lib/hosts.js";
import { OPENCODE_PLUGIN_MARKER } from "../src/lib/opencodePlugin.js";

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "abide-home-"));
  root = mkdtempSync(path.join(tmpdir(), "abide-repo-"));
  process.env.ABIDE_HOME_DIR = home;
  process.env.PATH = "/nonexistent";
});

afterEach(() => {
  delete process.env.ABIDE_HOME_DIR;
});

describe("hosts", () => {
  it("names the agents it knows and refuses the rest", () => {
    expect(parseHost("Codex")).toBe("codex");
    expect(() => parseHost("grok")).toThrow(/not one of/);
  });

  it("detects a host by its config directory", () => {
    expect(detectHosts()).toEqual([]);
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    expect(detectHosts()).toEqual(["codex", "opencode"]);
  });

  it("detects a host that is only on PATH, spelled as its shell would find it", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "abide-bin-"));
    const launcher = path.join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(launcher, "");
    chmodSync(launcher, 0o755);
    process.env.PATH = bin;
    expect(detectHosts()).toEqual(["claude"]);
  });

  it("writes Claude and Codex hooks into their own files and removes only its own entries", () => {
    for (const host of ["claude", "codex"] as const) {
      const target = installTarget(host, root, false);
      installHost(host, root, false);
      const json = JSON.parse(readFileSync(target, "utf8"));
      expect(Object.keys(json.hooks).sort()).toEqual([
        "PostToolUse",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ]);
      expect(json.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|apply_patch");
      expect(uninstallHost(host, root, false)).toBe(4);
      expect(uninstallHost(host, root, false)).toBe(0);
    }
    expect(installTarget("codex", root, true)).toBe(path.join(root, ".codex", "hooks.json"));
  });

  it("installs OpenCode as a plugin file it can recognise, and leaves a stranger's file alone", () => {
    const target = installTarget("opencode", root, false);
    expect(target).toBe(path.join(home, ".config", "opencode", "plugins", "abide.js"));
    installHost("opencode", root, false);
    const text = readFileSync(target, "utf8");
    expect(text).toContain(OPENCODE_PLUGIN_MARKER);
    expect(text).toMatch(/export \{ default \} from "file:\/\/.*opencode\/abide\.mjs"/);
    expect(uninstallHost("opencode", root, false)).toBe(1);
    expect(existsSync(target)).toBe(false);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export default async () => ({});\n");
    expect(uninstallHost("opencode", root, false)).toBe(0);
    expect(existsSync(target)).toBe(true);
  });
});
