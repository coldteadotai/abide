import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../src/lib/events.js";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";

const event = { kind: "skip", at: "now", phase: "edit", reason: "test" } as const;

describe("the event log", () => {
  it("appends and reads back", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abide-events-"));
    appendEvent(root, event);
    appendEvent(root, event);
    expect(readEvents(root)).toEqual([event, event]);
    expect(
      readFileSync(path.join(root, ".abide", "events.jsonl"), "utf8").split("\n"),
    ).toHaveLength(3);
  });

  it.skipIf(NO_FIFO)(
    "refuses a FIFO in the log's place instead of waiting on its reader",
    { timeout: 3_000 },
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "abide-events-"));
      mkdirSync(path.join(root, ".abide"));
      mkfifo(path.join(root, ".abide", "events.jsonl"));
      appendEvent(root, event);
    },
  );
});
