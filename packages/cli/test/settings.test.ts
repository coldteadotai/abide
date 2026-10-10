import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hookSpecs,
  installHooks,
  installedHookEvents,
  uninstallHooks,
} from "../src/lib/settings.js";

describe("settings", () => {
  it("installs four hooks, keeps others, and is idempotent", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "abide-settings-")), "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: "x",
        hooks: {
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "other.sh" }] }],
        },
      }),
    );
    const specs = hookSpecs("/pkg/dist/abide-hook.js");
    installHooks(file, specs);
    installHooks(file, specs);
    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(json.model).toBe("x");
    expect(json.hooks.PostToolUse).toHaveLength(2);
    expect(json.hooks.PostToolUse[0].hooks[0].command).toBe("other.sh");
    expect(json.hooks.PostToolUse[1].matcher).toBe("Edit|Write|MultiEdit|apply_patch");
    expect(json.hooks.PostToolUse[1].hooks[0].command).toContain("abide-hook.js");
    expect(json.hooks.Stop).toHaveLength(1);
    expect(json.hooks.UserPromptSubmit).toHaveLength(1);
    expect(installedHookEvents(file)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
    ]);
    expect(uninstallHooks(file)).toBe(4);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.hooks.PostToolUse).toHaveLength(1);
    expect(after.hooks.Stop).toBeUndefined();
  });

  it("takes only its own entry out of a group it shares with someone else's hook", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "abide-settings-")), "settings.json");
    const specs = hookSpecs("/pkg/dist/abide-hook.js");
    installHooks(file, specs);
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.hooks.Stop[0].hooks.push({ type: "command", command: "theirs.sh" });
    writeFileSync(file, JSON.stringify(json));
    installHooks(file, specs);
    const reinstalled = JSON.parse(readFileSync(file, "utf8"));
    expect(
      reinstalled.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
        g.hooks.map((h) => h.command),
      ),
    ).toEqual(["theirs.sh", 'node "/pkg/dist/abide-hook.js" stop']);
    expect(uninstallHooks(file)).toBe(4);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "theirs.sh" }] }]);
    expect(installedHookEvents(file)).toEqual([]);
  });

  it("preserves unreadable but writable settings instead of treating them as missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-settings-"));
    const file = path.join(root, "settings.json");
    const original = JSON.stringify({
      model: "keep-me",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }] }] },
    });
    writeFileSync(file, original);
    chmodSync(file, 0o200);
    try {
      expect(() => installHooks(file, hookSpecs("/pkg/dist/abide-hook.js"))).toThrow(
        /could not read/,
      );
    } finally {
      chmodSync(file, 0o600);
      const after = readFileSync(file, "utf8");
      rmSync(root, { recursive: true, force: true });
      expect(after).toBe(original);
    }
  });

  it("refuses a settings file it cannot parse", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "abide-settings-")), "settings.json");
    writeFileSync(file, "{ not json");
    expect(() => installHooks(file, hookSpecs("/x/abide-hook.js"))).toThrow(/not a settings file/);
  });
});
