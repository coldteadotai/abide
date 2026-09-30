import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHookReply } from "../src/pi/protocol.js";
import { runJsonProcess } from "../src/pi/bridge.js";

const dirs: string[] = [];
const fixture = (source: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "abide-pi-process-"));
  dirs.push(dir);
  const script = path.join(dir, "child.cjs");
  writeFileSync(script, source);
  return { script, dir };
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const options = { timeoutMs: 2_000, maxOutputBytes: 1024 };

describe("Pi hook replies", () => {
  it("decodes repairs, compilation context and advisory notices", () => {
    expect(parseHookReply({ decision: "block", reason: "repair", systemMessage: "note" })).toEqual({
      kind: "block",
      reason: "repair",
      systemMessage: "note",
    });
    expect(
      parseHookReply({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "compile" },
        systemMessage: "note",
      }),
    ).toEqual({ kind: "session-context", additionalContext: "compile", systemMessage: "note" });
    expect(parseHookReply({ systemMessage: "note" })).toEqual({
      kind: "notice",
      systemMessage: "note",
    });
  });
  it("ignores invalid and empty replies", () => {
    for (const raw of [
      undefined,
      {},
      "not JSON",
      { decision: "allow", reason: "x" },
      { decision: "block", reason: 1 },
    ])
      expect(parseHookReply(raw)).toEqual({ kind: "silent" });
  });
});

describe("bounded Pi subprocesses", () => {
  it("passes JSON through stdin and accepts only successful JSON stdout", async () => {
    const { script } = fixture(
      'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s));',
    );
    expect(await runJsonProcess(script, [], { text: "hi" }, options)).toEqual({ text: "hi" });
  });
  it("fails open on malformed output, nonzero exit, early pipe close and spawn failure", async () => {
    for (const source of [
      'console.log("not json")',
      'console.log("{}");process.exit(1)',
      "process.exit(0)",
    ]) {
      const { script } = fixture(source);
      expect(
        await runJsonProcess(script, [], { text: "x".repeat(100_000) }, options),
      ).toBeUndefined();
    }
    expect(await runJsonProcess("/missing/abide.cjs", [], {}, options)).toBeUndefined();
  });
  it("fails open when Node is unavailable on PATH", async () => {
    const { script } = fixture('console.log("{}")');
    vi.stubEnv("PATH", "");
    try {
      expect(await runJsonProcess(script, [], {}, options)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("kills output overflow instead of collecting unlimited stdout", async () => {
    const { script } = fixture('process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)');
    expect(await runJsonProcess(script, [], {}, options)).toBeUndefined();
  });
  it("terminates a hanging child at its deadline", async () => {
    const { script, dir } = fixture(
      'require("fs").writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)',
    );
    const pidFile = path.join(dir, "pid");
    const started = performance.now();
    expect(
      await runJsonProcess(script, [pidFile], {}, { ...options, timeoutMs: 300 }),
    ).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 1_000,
      interval: 10,
    });
  });
  it("honors cancellation before and during child execution", async () => {
    const { script } = fixture("setInterval(()=>{},1000)");
    expect(
      await runJsonProcess(script, [], {}, { ...options, signal: AbortSignal.abort() }),
    ).toBeUndefined();
    const controller = new AbortController();
    const result = runJsonProcess(script, [], {}, { ...options, signal: controller.signal });
    controller.abort();
    expect(await result).toBeUndefined();
  });
});
