import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Rule } from "@coldtea/abide-schema";
import type { CheckState } from "../src/lib/jev.js";

const calls: { ids: string[]; state: CheckState }[] = [];

vi.mock("../src/lib/jev.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/lib/jev.js")>()),
  checkWithModel: async (rules: readonly Rule[], state: CheckState) => {
    calls.push({ ids: rules.map((r) => r.id), state });
    return { verdicts: [], usage: {}, latencyMs: 0 };
  },
}));

const { runCheck } = await import("../src/lib/checkRunner.js");
const { auditableFiles, auditFiles } = await import("../src/lib/audit.js");
const { buildContext, CONTEXT_MAX_CHARS } = await import("../src/lib/graftContext.js");

const rule = (id: string, when: "edit" | "turn", context?: boolean): Rule => ({
  id,
  text: "t",
  source: { path: "AGENTS.md" },
  status: "active",
  when,
  check: {
    type: "model",
    question: { type: "boolean", instructions: "?" },
    ...(context === undefined ? {} : { context }),
  },
});

const thresholds = { act: 0.8, flag: 0.5 };
const fileDiffs = [{ file: "src/a.ts", text: "@@ -0,0 +1,1 @@\n+export const a = 1;" }];

/** A graft stand-in: a skeleton of one symbol, no callers, and a body far over the cap. */
const fakeGraft = (): string => {
  const bin = path.join(mkdtempSync(path.join(tmpdir(), "abide-graft-")), "graft");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = skeleton ]; then echo "- L1-L1  const  a"; yes "x" | head -c 20000; fi\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
};

afterEach(() => {
  calls.length = 0;
  vi.unstubAllEnvs();
});

describe("check.context", () => {
  it("sends a plain rule the exact change and a context rule its own call with context", async () => {
    vi.stubEnv("ABIDE_GRAFT_BIN", fakeGraft());
    const out = await runCheck({
      phase: "turn",
      fileDiffs,
      rules: [rule("plain", "turn"), rule("ctx", "turn", true)],
      thresholds,
      timeoutMs: 1000,
    });
    expect(out.calls).toBe(2);
    const plain = calls.find((c) => c.ids.join() === "plain");
    const ctx = calls.find((c) => c.ids.join() === "ctx");
    expect(plain?.state).not.toHaveProperty("context");
    expect(typeof ctx?.state.context).toBe("string");
    expect(ctx?.state.context?.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });

  it("gives edit-phase hooks no context unless the caller supplies one", async () => {
    await runCheck({
      phase: "edit",
      fileDiffs,
      rules: [rule("ctx", "edit", true)],
      thresholds,
      timeoutMs: 1000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).not.toHaveProperty("context");
  });

  it("fails open with no context when graft is missing", async () => {
    vi.stubEnv("ABIDE_GRAFT_BIN", "/nonexistent/graft");
    expect(await buildContext(fileDiffs, tmpdir())).toBeUndefined();
  });

  it("audits a turn-phase context rule once per file, with the file's context", async () => {
    vi.stubEnv("ABIDE_GRAFT_BIN", fakeGraft());
    const root = mkdtempSync(path.join(tmpdir(), "abide-ctx-"));
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const rules = [rule("plain", "edit"), rule("ctx", "turn", true)];
    expect(auditableFiles(root, ["a.ts"], [rule("ctx", "turn", true)]).files).toEqual(["a.ts"]);
    const {
      results: [result],
    } = await auditFiles(root, ["a.ts"], rules, thresholds, 1, () => {});
    expect(result?.rules).toBe(2);
    expect(calls.map((c) => c.ids.join())).toEqual(["plain", "ctx"]);
    expect(calls[0]?.state).not.toHaveProperty("context");
    expect(calls[1]?.state.context).toContain("a.ts");
  });
});
