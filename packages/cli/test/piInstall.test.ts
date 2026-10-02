import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { chooseHosts } from "../src/commands/init.js";
import {
  detectHosts,
  installHost,
  installTarget,
  parseHost,
  uninstallHost,
} from "../src/lib/hosts.js";

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "abide-pi-home-"));
  root = mkdtempSync(path.join(tmpdir(), "abide-pi-project-"));
  vi.stubEnv("ABIDE_HOME_DIR", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  vi.stubEnv("PATH", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it("detects Pi and selects it when init has no host argument", () => {
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  expect(parseHost("Pi")).toBe("pi");
  expect(detectHosts()).toEqual(["pi"]);
  expect(chooseHosts([])).toEqual(["pi"]);
});

it("installs global and project extensions that the actual Pi loader can load", async () => {
  const host = parseHost("pi");
  const agentDir = path.join(home, "custom agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  expect(installTarget(host, root, false)).toBe(path.join(agentDir, "extensions", "abide.js"));
  expect(installTarget(host, root, true)).toBe(path.join(root, ".pi", "extensions", "abide.js"));
  for (const project of [false, true]) {
    const target = installHost(host, root, project).target;
    const text = readFileSync(target, "utf8");
    installHost(host, root, project);
    expect(readFileSync(target, "utf8")).toBe(text);
    writeFileSync(target, text.replace(/from "[^"]+"/, 'from "file:///old-install/extension.js"'));
    installHost(host, root, project);
    expect(readFileSync(target, "utf8")).toBe(text);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    expect(uninstallHost(host, root, project)).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(uninstallHost(host, root, project)).toBe(0);
  }
});

it("refuses to replace or remove an unrelated extension", () => {
  const host = parseHost("pi");
  const target = installTarget(host, root, true);
  mkdirSync(path.dirname(target), { recursive: true });
  const original = "export default function unrelated() {}\n";
  writeFileSync(target, original);
  expect(() => installHost(host, root, true)).toThrow(/already exists/);
  expect(uninstallHost(host, root, true)).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(original);
});

it.skipIf(process.platform === "win32")("refuses a symlink at its install target", () => {
  const host = parseHost("pi");
  const target = installTarget(host, root, true);
  const other = path.join(root, "other.js");
  writeFileSync(other, "export default function unrelated() {}\n");
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(other, target);
  expect(() => installHost(host, root, true)).toThrow();
  expect(uninstallHost(host, root, true)).toBe(0);
  expect(readFileSync(other, "utf8")).toBe("export default function unrelated() {}\n");
});
