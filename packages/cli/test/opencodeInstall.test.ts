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
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  installOpencodePlugin,
  OPENCODE_PLUGIN_MARKER,
  uninstallOpencodePlugin,
} from "../src/lib/opencodePlugin.js";

let root: string;
let target: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "abide-opencode-install-"));
  target = path.join(root, "plugins", "abide.js");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("creates missing plugins, reinstalls idempotently, and upgrades owned shims", () => {
  installOpencodePlugin(target);
  const installed = readFileSync(target, "utf8");
  expect(installed).toContain(OPENCODE_PLUGIN_MARKER);
  installOpencodePlugin(target);
  expect(readFileSync(target, "utf8")).toBe(installed);
  writeFileSync(target, installed.replace(/from "[^"]+"/, 'from "file:///old-install/abide.mjs"'));
  installOpencodePlugin(target);
  expect(readFileSync(target, "utf8")).toBe(installed);
  expect(uninstallOpencodePlugin(target)).toBe(true);
  expect(existsSync(target)).toBe(false);
  expect(uninstallOpencodePlugin(target)).toBe(false);
});

it("refuses to replace or remove unrelated plugins", () => {
  mkdirSync(path.dirname(target));
  const original = "export default function unrelated() {}\n";
  writeFileSync(target, original);
  expect(() => installOpencodePlugin(target)).toThrow(/already exists/);
  expect(readFileSync(target, "utf8")).toBe(original);
  expect(uninstallOpencodePlugin(target)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(original);
});

it("does not claim a foreign plugin merely mentioning Abide's marker", () => {
  mkdirSync(path.dirname(target));
  const original = `export const name = ${JSON.stringify(OPENCODE_PLUGIN_MARKER)};\n`;
  writeFileSync(target, original);
  expect(() => installOpencodePlugin(target)).toThrow(/already exists/);
  expect(uninstallOpencodePlugin(target)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(original);
});

it("refuses symlinks without replacing or removing their target", () => {
  const other = path.join(root, "other.js");
  const original = "export default function unrelated() {}\n";
  writeFileSync(other, original);
  mkdirSync(path.dirname(target));
  symlinkSync(other, target);
  expect(() => installOpencodePlugin(target)).toThrow();
  expect(uninstallOpencodePlugin(target)).toBe(false);
  expect(readFileSync(other, "utf8")).toBe(original);
  expect(readFileSync(target, "utf8")).toBe(original);
});

it("does not follow a dangling symlink when installing", () => {
  const other = path.join(root, "absent.js");
  mkdirSync(path.dirname(target));
  symlinkSync(other, target);
  expect(() => installOpencodePlugin(target)).toThrow();
  expect(uninstallOpencodePlugin(target)).toBe(false);
  expect(existsSync(other)).toBe(false);
});
