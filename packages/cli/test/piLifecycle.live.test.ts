import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { assertNever, eventSchema } from "@coldtea/abide-schema";
import { expect, it } from "vitest";
import { findCredentials } from "../src/lib/credentials.js";
import { piSessionsFor } from "../src/lib/replayPi.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = path.join(root, "packages", "cli", "dist", "bin.js");
const boundarySchema = z.object({
  baselineStarts: z.number(),
  canContinue: z.boolean(),
  repairs: z.number(),
  precedingEntries: z.number(),
  baselines: z.number(),
});
const records = <T>(file: string, schema: z.ZodType<T>): T[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });

it.skipIf(process.env.ABIDE_PI_LIVE !== "1")(
  "continues a real Pi task after a live Jev turn violation without replacing its baseline",
  async () => {
    const credentials = findCredentials(root);
    if (credentials.kind === "none") throw new Error("Live verification requires an Abide key");
    const dir = mkdtempSync(path.join(tmpdir(), "abide-pi-live-"));
    const repo = path.join(dir, "repo");
    const observations = path.join(dir, "boundaries.jsonl");
    const observer = path.join(dir, "observe.mjs");
    const preceding = path.join(dir, "preceding.mjs");
    const file = "packages/cli/src/pi/repair-smoke.ts";
    const queuedFile = "packages/cli/src/pi/queued-marker.ts";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ABIDE_HOME_DIR: path.join(dir, "abide-home"),
      TYPESAFE_AI_API_KEY: "",
      AI_GATEWAY_API_KEY: "",
    };
    switch (credentials.kind) {
      case "typesafe":
        env.TYPESAFE_AI_API_KEY = credentials.key;
        if (credentials.baseURL !== undefined) env.TYPESAFE_AI_BASE_URL = credentials.baseURL;
        break;
      case "gateway":
        env.AI_GATEWAY_API_KEY = credentials.key;
        break;
      default:
        assertNever(credentials);
    }
    try {
      await exec("git", ["clone", "--quiet", "--shared", root, repo]);
      await exec(process.execPath, [bin, "init", "pi", "--project"], {
        cwd: repo,
        env,
        timeout: 30_000,
      });
      const extension = path.join(repo, ".pi", "extensions", "abide.js");
      writeFileSync(
        preceding,
        `export default function(pi) {
  pi.on("agent_before_settle", (event) => ({entries:[...event.entries,{type:"custom",customType:"preceding-extension",data:{present:true}}]}));
}\n`,
      );
      writeFileSync(
        observer,
        `import { appendFileSync, readdirSync } from "node:fs";
export default function(pi) {
  let baselineStarts = 0;
  let initialWrite = true;
  let repairAllowed = false;
  pi.on("before_agent_start", () => { baselineStarts += 1; });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "read" && !initialWrite && !repairAllowed && event.input.path !== ${JSON.stringify(queuedFile)}) return {block:true,reason:"Initial-write phase only: finish your response and wait for Abide's final repair request"};
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "write" && !event.isError && initialWrite) {
      initialWrite = false;
      pi.sendUserMessage(${JSON.stringify(`Additional requirement: also write ${queuedFile} containing export const queued = true; before finishing. This supersedes the earlier single-file restriction. Keep copyReport unchanged until Abide requests repair.`)}, {deliverAs:"steer"});
    }
  });
  pi.on("agent_before_settle", (event) => {
    if (event.entries.some(x=>x.type==="custom_message"&&x.customType==="abide-repair")) repairAllowed = true;
    appendFileSync(${JSON.stringify(observations)}, JSON.stringify({baselineStarts, canContinue:event.context.canContinue, repairs:event.entries.filter(x=>x.type==="custom_message"&&x.customType==="abide-repair").length,precedingEntries:event.entries.filter(x=>x.type==="custom"&&x.customType==="preceding-extension").length,baselines:readdirSync(${JSON.stringify(path.join(dir, "abide-home", ".abide", "sessions"))},{recursive:true}).filter(name=>name.endsWith(${JSON.stringify(path.sep + "baseline")})).length})+"\\n");
  });
}
`,
      );
      const source =
        "type Report = { ok: boolean };\n\nfunction copyReport(report: Report): Report {\n  return { ok: report.ok };\n}\n\nexport function verify(ok: boolean): Report {\n  return copyReport({ ok });\n}\n";
      const prompt = `Check the existing no-single-use-abstraction rule through Abide. First use write to create ${file} exactly as below. This initial write is the intentional negative case; do not preemptively inline it. After any Abide repair request, inline copyReport while preserving verify's signature and return value. Do not change any other file.\n\n${source}`;
      const run = exec(
        "pi",
        [
          "--no-extensions",
          "--extension",
          preceding,
          "--extension",
          extension,
          "--extension",
          observer,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--session-dir",
          path.join(dir, "pi-sessions"),
          "--tools",
          "read,write,edit",
          "--thinking",
          "low",
          "--mode",
          "json",
          "--print",
          prompt,
        ],
        {
          cwd: repo,
          env,
          timeout: 240_000,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      run.child.stdin?.end();
      const result = await run;
      expect(result.stderr).toBe("");
      const checks = records(path.join(repo, ".abide", "events.jsonl"), eventSchema).flatMap(
        (event) => (event.kind === "check" && event.phase === "turn" ? [event] : []),
      );
      const boundaries = records(observations, boundarySchema);
      const appSchema = z.object({ type: z.string() });
      const appEvents = result.stdout
        .trim()
        .split("\n")
        .map((line) => appSchema.parse(JSON.parse(line)));
      expect(appEvents.some((event) => event.type === "agent_settled")).toBe(true);
      expect(
        checks.some(
          (event) =>
            event.blocked &&
            event.verdicts.some(
              (v) => v.ruleId === "no-single-use-abstraction" && v.band === "act",
            ),
        ),
      ).toBe(true);
      expect(boundaries[0]?.repairs).toBe(1);
      expect(boundaries.every((boundary) => boundary.precedingEntries === 1)).toBe(true);
      expect(boundaries).toHaveLength(2);
      expect(boundaries.every((boundary) => boundary.baselineStarts === 1)).toBe(true);
      expect(boundaries.every((boundary) => boundary.baselines === 1)).toBe(true);
      expect(
        readdirSync(path.join(dir, "abide-home", ".abide", "sessions"), {
          recursive: true,
          encoding: "utf8",
        }).filter((name) => name.endsWith(path.sep + "baseline")),
      ).toEqual([]);
      expect(checks).toHaveLength(2);
      expect(checks[0]?.promptId).toBeTypeOf("string");
      expect(new Set(checks.map((check) => check.promptId)).size).toBe(1);
      expect(checks[1]?.blocked).toBe(false);
      expect(checks[0]?.verdicts.find((verdict) => verdict.ruleId === "scope-creep")?.band).toBe(
        "clear",
      );
      expect(readFileSync(path.join(repo, queuedFile), "utf8")).toContain("queued = true");
      expect(readFileSync(path.join(repo, file), "utf8")).not.toContain("copyReport");
      const replay = piSessionsFor(repo, path.join(dir, "pi-sessions"));
      expect(replay).toHaveLength(1);
      expect(replay[0]?.turns.flatMap((turn) => turn.edits).length).toBeGreaterThanOrEqual(3);
      const replayCommand = await exec(
        process.execPath,
        [bin, "replay", "pi", path.join(dir, "pi-sessions"), "--repo", repo, "--json"],
        { cwd: repo, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const replayReport = z
        .object({ host: z.literal("pi"), sessions: z.number(), edits: z.number() })
        .parse(JSON.parse(replayCommand.stdout));
      expect(replayReport.sessions).toBe(1);
      expect(replayReport.edits).toBeGreaterThanOrEqual(3);
      await exec(process.execPath, [bin, "uninstall", "pi", "--project"], {
        cwd: repo,
        env,
        timeout: 15_000,
      });
      expect(existsSync(extension)).toBe(false);
      expect(readFileSync(path.join(repo, file), "utf8")).toContain("verify");
      console.log(
        JSON.stringify({
          livePiRepair: true,
          checks: checks.map((check) => ({
            phase: check.phase,
            blocked: check.blocked,
            latencyMs: check.latencyMs,
            modelLatencyMs: check.modelLatencyMs,
            rule: check.verdicts.find((verdict) => verdict.ruleId === "no-single-use-abstraction"),
          })),
          boundaries,
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
