import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const runner = new URL("../dist/lib/hookRunner.js", import.meta.url).href;

const run = (handler: string, input = "{}", drainStdout = true) =>
  new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    elapsedMs: number;
  }>((resolve, reject) => {
    let started = Date.now();
    let ready = false;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runHook } from ${JSON.stringify(runner)}; process.stderr.write("hook-ready\\n"); await runHook("stop", ${handler}, 100);`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    if (drainStdout) child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    let timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (ready || !chunk.includes("hook-ready")) return;
      ready = true;
      started = Date.now();
      clearTimeout(timeout);
      timeout = setTimeout(() => child.kill("SIGKILL"), 1_500);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, signal, stdout, elapsedMs: Date.now() - started });
    });
    child.stdin.end(input);
  });

describe("the hook runner deadline (needs `pnpm build` first)", () => {
  it("exits within its budget when the host does not drain stdout", async () => {
    const result = await run(
      'async () => ({ kind: "notice", systemMessage: "x".repeat(1_048_576) })',
      "{}",
      false,
    );
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(1_000);
  });

  it("writes normal host JSON before exiting", async () => {
    const result = await run('async () => ({ kind: "notice", systemMessage: "checked" })');
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: "checked" });
  });

  it("passes malformed stdin to the handler as undefined", async () => {
    const result = await run(
      'async (raw) => ({ kind: "notice", systemMessage: raw === undefined ? "no input" : "input" })',
      "not JSON",
    );
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: "no input" });
  });

  it("exits silently when the handler never finishes", async () => {
    const result = await run("async () => new Promise(() => {})");
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.elapsedMs).toBeLessThan(1_000);
  });
});
