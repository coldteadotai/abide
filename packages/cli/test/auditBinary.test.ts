import { z } from "zod";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_THRESHOLDS, rubricSchema, type Rule } from "@coldtea/abide-schema";
import { say } from "../src/lib/ui.js";
import { runAudit } from "../src/commands/audit.js";
import { runCheck } from "../src/lib/checkRunner.js";
import { auditableFiles, auditFiles, listRepoFiles } from "../src/lib/audit.js";

vi.mock("../src/lib/checkRunner.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/lib/checkRunner.js")>()),
  runCheck: vi.fn(async () => ({
    verdicts: [],
    modelRules: [],
    calls: 1,
    usage: {},
    modelLatencyMs: 0,
  })),
}));
vi.mock("../src/lib/ui.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/lib/ui.js")>()),
  say: vi.fn(),
}));

const rules: Rule[] = [
  {
    id: "fixture",
    text: "fixture rule",
    source: { path: "AGENTS.md" },
    status: "active",
    when: "edit",
    check: { type: "model", question: { type: "boolean", instructions: "fixture question" } },
  },
];
const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff]);
const binaryNames = ["a.docx", "b.xlsx", "c.pptx", "d.zip", "e", "f.ts"];
const outputSchema = z.object({
  files: z.number(),
  skipped: z.object({ binary: z.array(z.string()) }),
  byFile: z.array(z.object({ file: z.string() })),
});
let root: string;

const writeBinaries = (): void => {
  for (const name of binaryNames) writeFileSync(path.join(root, name), binary);
};

const prepareCommand = (): void => {
  mkdirSync(path.join(root, ".abide"));
  writeFileSync(
    path.join(root, ".abide", "rubric.json"),
    JSON.stringify(rubricSchema.parse({ version: 1, compiledAt: "x", sources: [], rules })),
  );
  vi.spyOn(process, "cwd").mockReturnValue(root);
};

const printedOutput = () => {
  const printed = vi.mocked(say).mock.calls[0]?.[0];
  if (typeof printed !== "string") throw new Error("audit did not print JSON");
  return outputSchema.parse(JSON.parse(printed));
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "abide-audit-binary-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  vi.stubEnv("ABIDE_HOME_DIR", path.join(root, "home"));
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-only-no-network");
  vi.mocked(runCheck).mockClear();
  vi.mocked(say).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("binary audit input", () => {
  it("skips tracked and untracked binaries by content before applying a file cap", () => {
    writeBinaries();
    execFileSync("git", ["add", "--", "a.docx"], { cwd: root });
    writeFileSync(path.join(root, "z.ts"), 'export const greeting = "Grüße 日本語 👋";\n');
    writeFileSync(path.join(root, "empty"), "");
    const candidates = listRepoFiles(root, []);
    expect(candidates).toEqual(expect.arrayContaining(binaryNames));
    const selected = auditableFiles(root, candidates, rules);
    expect(selected.files.sort()).toEqual(["empty", "z.ts"]);
    expect(selected.skipped.binary.sort()).toEqual(binaryNames);
    expect(selected.files.slice(0, 1)).toEqual(["empty"]);
  });

  it("never judges or retries binary input even when called directly", async () => {
    writeBinaries();
    const progress = vi.fn();
    const output = await auditFiles(root, binaryNames, rules, DEFAULT_THRESHOLDS, 3, progress);
    expect(runCheck).not.toHaveBeenCalled();
    expect(output.results).toEqual([]);
    expect(output.binary.sort()).toEqual(binaryNames);
    expect(progress).toHaveBeenLastCalledWith(0, 0, 0);
  });

  it("rechecks the bytes when a selected text file becomes binary", async () => {
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");
    const selected = auditableFiles(root, ["a.ts", "b.ts"], rules);
    expect(selected.files).toEqual(["a.ts", "b.ts"]);
    writeFileSync(path.join(root, "a.ts"), binary);
    const progress = vi.fn();
    const output = await auditFiles(root, selected.files, rules, DEFAULT_THRESHOLDS, 2, progress);
    expect(output.binary).toEqual(["a.ts"]);
    expect(output.results.map((r) => r.file)).toEqual(["b.ts"]);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(1, 1, 0);
  });

  it("keeps unreadable files distinct from skipped binaries and completes progress", async () => {
    const progress = vi.fn();
    const output = await auditFiles(root, ["missing.ts"], rules, DEFAULT_THRESHOLDS, 1, progress);
    expect(output.binary).toEqual([]);
    expect(output.results).toEqual([
      expect.objectContaining({ file: "missing.ts", error: expect.any(String) }),
    ]);
    expect(runCheck).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(1, 1, 0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a permission-denied file in the queue so the audit reports its read error",
    async () => {
      const file = path.join(root, "locked.ts");
      writeFileSync(file, "export const locked = true;\n");
      chmodSync(file, 0o000);
      try {
        const selected = auditableFiles(root, ["locked.ts"], rules);
        expect(selected.files).toEqual(["locked.ts"]);
        expect(selected.skipped).toEqual({ tooBig: [], binary: [], outOfScope: 0 });
        const output = await auditFiles(
          root,
          selected.files,
          rules,
          DEFAULT_THRESHOLDS,
          1,
          () => {},
        );
        expect(output.binary).toEqual([]);
        expect(output.results).toEqual([
          expect.objectContaining({ file: "locked.ts", error: expect.any(String) }),
        ]);
        expect(runCheck).not.toHaveBeenCalled();
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );

  it("preserves Unicode when sending text to the judge", async () => {
    const text = 'export const greeting = "Grüße 日本語 👋";\n';
    writeFileSync(path.join(root, "text.docx"), text);
    const selected = auditableFiles(root, ["text.docx"], rules);
    expect(selected.files).toEqual(["text.docx"]);
    const output = await auditFiles(root, selected.files, rules, DEFAULT_THRESHOLDS, 1, () => {});
    expect(output.binary).toEqual([]);
    expect(runCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        fileDiffs: [{ file: "text.docx", text: `@@ -0,0 +1,1 @@\n+${text.trimEnd()}` }],
      }),
    );
  });

  it("does not send a file that grows past the limit after selection", async () => {
    writeFileSync(path.join(root, "growing.ts"), "small\n");
    const selected = auditableFiles(root, ["growing.ts"], rules);
    writeFileSync(path.join(root, "growing.ts"), Buffer.alloc(1_000_001, 0x61));
    const output = await auditFiles(root, selected.files, rules, DEFAULT_THRESHOLDS, 1, () => {});
    expect(runCheck).not.toHaveBeenCalled();
    expect(output.results[0]?.error).toContain("size limit");
  });

  it("reports skips in audit JSON without letting binaries consume --max-files", async () => {
    writeFileSync(path.join(root, "a.docx"), binary);
    writeFileSync(path.join(root, "z.ts"), "export const z = 1;\n");
    prepareCommand();
    expect(await runAudit(["--json", "--max-files", "1"])).toBe(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(printedOutput()).toMatchObject({
      files: 1,
      skipped: { binary: ["a.docx"] },
      byFile: [{ file: "z.ts" }],
    });
  });

  it("merges binary skips discovered during judging into the final JSON totals", async () => {
    for (const name of ["a.ts", "b.ts"]) writeFileSync(path.join(root, name), "text\n");
    writeFileSync(path.join(root, "c.docx"), binary);
    prepareCommand();
    vi.mocked(runCheck).mockImplementationOnce(async () => {
      writeFileSync(path.join(root, "b.ts"), binary);
      return { verdicts: [], modelRules: [], calls: 1, usage: {}, modelLatencyMs: 0 };
    });
    expect(await runAudit(["--json", "--concurrency", "1"])).toBe(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(printedOutput()).toMatchObject({
      files: 1,
      skipped: { binary: ["b.ts", "c.docx"] },
      byFile: [{ file: "a.ts" }],
    });
  });
});
