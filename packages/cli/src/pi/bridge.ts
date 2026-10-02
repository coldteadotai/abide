import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HookOutput } from "@coldtea/abide-schema";
import type { HookName } from "../lib/hookRunner.js";
import { fileStateSchema, parseHookReply, type FileState } from "./protocol.js";

type ProcessOptions = { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal };

export const runJsonProcess = async (
  script: string,
  args: readonly string[],
  payload: unknown,
  options: ProcessOptions,
): Promise<unknown> => {
  if (options.signal?.aborted) return undefined;
  let input: string;
  try {
    input = JSON.stringify(payload);
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    const child = spawn("node", [script, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          resolve(undefined);
          return;
        }
      }
      // Filesystem-stalled children may not emit close even after SIGKILL.
      resolve(value);
    };
    const abort = (): void => finish(undefined);
    const timer = setTimeout(abort, options.timeoutMs);
    child.stdin.on("error", abort);
    child.stdout.on("error", abort);
    child.on("error", abort);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        abort();
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(undefined);
        return;
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(undefined);
      }
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      child.stdin.end(input);
    } catch {
      abort();
    }
  }).catch(() => undefined);
};

export type PiBridge = {
  hook(name: HookName, payload: unknown, signal?: AbortSignal): Promise<HookOutput>;
  capture(file: string, signal?: AbortSignal): Promise<FileState>;
  close(): void;
};

const budgets: Record<HookName, number> = {
  "session-start": 10_000,
  "turn-start": 10_000,
  "post-tool-use": 20_000,
  stop: 30_000,
};

export const createPiBridge = (): PiBridge => {
  let controller = new AbortController();
  const signalFor = (signal?: AbortSignal): AbortSignal =>
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  return {
    async hook(name, payload, signal) {
      const raw = await runJsonProcess(
        fileURLToPath(new URL("../abide-hook.js", import.meta.url)),
        [name],
        payload,
        {
          timeoutMs: budgets[name],
          maxOutputBytes: 64 * 1024,
          signal: signalFor(signal),
        },
      );
      return parseHookReply(raw);
    },
    async capture(file, signal) {
      const raw = await runJsonProcess(
        fileURLToPath(new URL("./capture.js", import.meta.url)),
        [],
        { file },
        {
          timeoutMs: 1_000,
          maxOutputBytes: 4 * 1024 * 1024,
          signal: signalFor(signal),
        },
      );
      const parsed = fileStateSchema.safeParse(raw);
      return parsed.success ? parsed.data : { kind: "unreadable" };
    },
    close() {
      controller.abort();
      controller = new AbortController();
    },
  };
};
