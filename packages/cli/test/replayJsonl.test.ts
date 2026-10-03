import path from "node:path";
import { tmpdir } from "node:os";
import type { ReadStream } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";
import { readReplayLines } from "../src/lib/replayJsonl.js";

const io = vi.hoisted((): { chunkBytes: number; fail: boolean; streams: ReadStream[] } => ({
  chunkBytes: 3,
  fail: false,
  streams: [],
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn((file, options) => {
      const stream = actual.createReadStream(file, { ...options, highWaterMark: io.chunkBytes });
      io.streams.push(stream);
      if (io.fail) stream.once("data", () => stream.destroy(new Error("simulated read failure")));
      return stream;
    }),
  };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "abide-jsonl-"));
  io.chunkBytes = 3;
  io.fail = false;
  io.streams = [];
});

afterEach(() => {
  for (const stream of io.streams) expect(stream.closed).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});

const linesOf = async (text: string, maxBytes = 100): Promise<string[]> => {
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, text);
  const lines: string[] = [];
  for await (const line of readReplayLines(file, maxBytes)) lines.push(line);
  return lines;
};

describe("bounded replay JSONL reads", () => {
  it("handles chunk boundaries, split UTF-8, CRLF, blanks and an unterminated final line", async () => {
    expect(await linesOf('🌱\r\n\n{"x":1}\r\nlast')).toEqual(["🌱", "", '{"x":1}', "last"]);
  });

  it("reads several records in one chunk", async () => {
    io.chunkBytes = 64;
    expect(await linesOf("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("reads an empty file", async () => {
    expect(await linesOf("")).toEqual([]);
  });

  it("limits record bytes rather than file bytes or characters", async () => {
    expect(await linesOf("12345\n12345\n12345", 5)).toEqual(["12345", "12345", "12345"]);
    await expect(linesOf("🌱🌱", 5)).rejects.toMatchObject({ code: "REPLAY_RECORD_TOO_LARGE" });
  });

  it.each(["123456\n", "123456"])("rejects a record over the bound: %j", async (text) => {
    await expect(linesOf(text, 5)).rejects.toMatchObject({ code: "REPLAY_RECORD_TOO_LARGE" });
  });

  it("rejects an oversized record in one chunk", async () => {
    io.chunkBytes = 64;
    await expect(linesOf("123456\n", 5)).rejects.toMatchObject({ code: "REPLAY_RECORD_TOO_LARGE" });
  });

  it("wraps stream read failures and closes the descriptor", async () => {
    io.fail = true;
    await expect(linesOf("first\nsecond\n")).rejects.toMatchObject({
      code: "REPLAY_READ_FAILED",
      cause: { message: "simulated read failure" },
    });
  });

  it("closes the stream when the consumer stops early", async () => {
    const file = path.join(directory, "session.jsonl");
    writeFileSync(file, "first\nsecond\n");
    for await (const line of readReplayLines(file)) {
      expect(line).toBe("first");
      break;
    }
  });

  it("closes the stream when the consumer throws", async () => {
    const file = path.join(directory, "session.jsonl");
    writeFileSync(file, "first\nsecond\n");
    const failure = new Error("consumer failed");
    await expect(async () => {
      for await (const line of readReplayLines(file)) {
        expect(line).toBe("first");
        throw failure;
      }
    }).rejects.toBe(failure);
  });

  it.skipIf(NO_FIFO)(
    "rejects a FIFO without waiting for a writer",
    { timeout: 3_000 },
    async () => {
      const file = path.join(directory, "session.jsonl");
      mkfifo(file);
      await expect(async () => {
        for await (const line of readReplayLines(file)) expect(line).toBeUndefined();
      }).rejects.toMatchObject({ code: "REPLAY_READ_FAILED" });
    },
  );
});
