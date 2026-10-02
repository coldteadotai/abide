import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runClaude } from "../src/lib/claude.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])(
  "does not let inherited %s override Claude Code login",
  async (credential) => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-claude-"));
    dirs.push(root);
    writeFileSync(
      path.join(root, "claude"),
      `#!${process.execPath}
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) process.exit(23);
if (process.env.CLAUDE_CONFIG_DIR !== "subscription-config") process.exit(24);
if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== "test-oauth-token") process.exit(25);
process.exit(0);
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", root);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
    vi.stubEnv(credential, "test-api-credential");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "subscription-config");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-oauth-token");

    expect(await runClaude(root, "test prompt")).toBe(0);
    expect(process.env[credential]).toBe("test-api-credential");
  },
);
