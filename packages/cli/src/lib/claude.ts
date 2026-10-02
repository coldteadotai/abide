import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { globalAbideDir } from "./paths.js";
import { discoverGlobalSources } from "./sources.js";

export const claudeAvailable = (): boolean =>
  spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

/** Runs one headless Claude Code turn in the repo and streams its output. */
export const runClaude = (root: string, prompt: string): Promise<number> =>
  new Promise((resolve) => {
    const extraDirs = [
      globalAbideDir(),
      ...discoverGlobalSources().map((s) => path.dirname(s.absolute)),
    ];
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    };
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash(node *)",
        "Bash(abide *)",
        "--add-dir",
        ...extraDirs,
        "--output-format",
        "text",
      ],
      { cwd: root, stdio: "inherit", env },
    );
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
