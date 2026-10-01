import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { AbideError, assertNever } from "@coldtea/abide-schema";
import { claudeAvailable, runClaude } from "./claude.js";

const compileAgentSchema = z.enum(["claude", "pi"]);
export type CompileAgent = z.infer<typeof compileAgentSchema>;

export const parseCompileAgent = (value: unknown): CompileAgent | undefined => {
  const parsed = compileAgentSchema.optional().safeParse(value);
  if (!parsed.success)
    throw new AbideError("HOST_UNKNOWN", "compile and tune support --agent claude or --agent pi");
  return parsed.data;
};

const agentAvailable = (agent: CompileAgent): boolean => {
  switch (agent) {
    case "claude":
      return claudeAvailable();
    case "pi":
      return spawnSync("pi", ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0;
    default:
      return assertNever(agent);
  }
};

export const selectCompileAgent = (requested?: CompileAgent): CompileAgent | undefined => {
  if (requested !== undefined) {
    if (!agentAvailable(requested))
      throw new AbideError("HEADLESS_UNAVAILABLE", `${requested} is not available on PATH`);
    return requested;
  }
  if (agentAvailable("claude")) return "claude";
  if (agentAvailable("pi")) return "pi";
  return undefined;
};

export const runHeadless = (agent: CompileAgent, root: string, prompt: string): Promise<number> => {
  switch (agent) {
    case "claude":
      return runClaude(root, prompt);
    case "pi":
      return new Promise((resolve) => {
        const child = spawn("pi", ["--print", "--no-session", "--", prompt], {
          cwd: root,
          stdio: ["ignore", "inherit", "inherit"],
        });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      });
    default:
      return assertNever(agent);
  }
};
