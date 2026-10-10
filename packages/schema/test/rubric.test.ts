import { describe, expect, it } from "vitest";
import { createRuleId, createSourceSha, rubricSchema } from "../src/index.js";

const base = {
  version: 1 as const,
  compiledAt: "2026-09-17T00:00:00.000Z",
  sources: [{ path: "AGENTS.md" }],
};

describe("rubricSchema", () => {
  it("accepts a lint rule, a model rule with a phase, and the two reporting buckets", () => {
    const parsed = rubricSchema.parse({
      ...base,
      rules: [
        {
          id: "no-interface",
          text: "Use type, never interface",
          source: { path: "AGENTS.md", line: 3 },
          check: {
            type: "lint",
            how: "@typescript-eslint/consistent-type-definitions",
            pattern: "^\\s*(export\\s+)?interface\\s",
          },
        },
        {
          id: "raw-error-to-user",
          text: "Never show a user a raw error",
          source: { path: "AGENTS.md" },
          when: "edit",
          check: {
            type: "model",
            question: {
              type: "boolean",
              instructions: "Does the change put raw error text in a response body?",
            },
          },
        },
        {
          id: "reuse-codes",
          text: "Reuse existing error codes",
          source: { path: "AGENTS.md" },
          check: { type: "deferred", reason: "needs every existing code" },
        },
        {
          id: "ask-first",
          text: "Ask when unsure",
          source: { path: "AGENTS.md" },
          check: { type: "unenforceable", reason: "about conversation, not code" },
        },
      ],
    });
    expect(parsed.rules[0]?.status).toBe("active");
  });

  it("accepts the optional context flag on a model check and rejects a non-boolean", () => {
    const withContext = (context: unknown) => ({
      ...base,
      rules: [
        {
          id: "callers-ok",
          text: "Keep callers working",
          source: { path: "AGENTS.md" },
          when: "turn",
          check: {
            type: "model",
            context,
            question: { type: "boolean", instructions: "Does the change break a caller?" },
          },
        },
      ],
    });
    expect(rubricSchema.safeParse(withContext(true)).success).toBe(true);
    expect(rubricSchema.safeParse(withContext("yes")).success).toBe(false);
  });

  it("rejects a model rule without a phase", () => {
    const result = rubricSchema.safeParse({
      ...base,
      rules: [
        {
          id: "x",
          text: "x",
          source: { path: "AGENTS.md" },
          check: { type: "model", question: { type: "boolean", instructions: "?" } },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids and bad ids", () => {
    const rule = {
      id: "Bad_Id",
      text: "x",
      source: { path: "AGENTS.md" },
      check: { type: "lint", how: "x" },
    };
    expect(rubricSchema.safeParse({ ...base, rules: [rule] }).success).toBe(false);
    const ok = { ...rule, id: "good-id" };
    expect(rubricSchema.safeParse({ ...base, rules: [ok, ok] }).success).toBe(false);
  });

  it("validates choice and score questions", () => {
    const choice = {
      id: "service-shape",
      text: "Services are class based",
      source: { path: "AGENTS.md" },
      when: "edit",
      check: {
        type: "model",
        question: {
          type: "choice",
          instructions: "What shape is the service?",
          criteria: { correct: "class with static methods", loose: "exported functions" },
          violating: ["loose"],
        },
      },
    };
    expect(rubricSchema.safeParse({ ...base, rules: [choice] }).success).toBe(true);
    const badChoice = {
      ...choice,
      check: { ...choice.check, question: { ...choice.check.question, violating: ["nope"] } },
    };
    expect(rubricSchema.safeParse({ ...base, rules: [badChoice] }).success).toBe(false);

    const score = {
      id: "overlong",
      text: "Minimum code",
      source: { path: "AGENTS.md" },
      when: "turn",
      check: {
        type: "model",
        question: {
          type: "score",
          instructions: "How much longer than needed?",
          criteria: ["as short as it can be", "somewhat longer", "twice as long", "four times"],
          violatingFrom: 2,
        },
      },
    };
    expect(rubricSchema.safeParse({ ...base, rules: [score] }).success).toBe(true);
    const badScore = {
      ...score,
      check: { ...score.check, question: { ...score.check.question, violatingFrom: 4 } },
    };
    expect(rubricSchema.safeParse({ ...base, rules: [badScore] }).success).toBe(false);
  });
});

describe("ids", () => {
  it("slugifies rule ids", () => {
    expect(createRuleId("Use `type`, never `interface`!")).toBe("use-type-never-interface");
    expect(createRuleId("123 leading digits")).toBe("leading-digits");
    expect(createRuleId("???")).toBe("rule");
  });

  it("hashes sources deterministically", () => {
    expect(createSourceSha("abc")).toBe(createSourceSha("abc"));
    expect(createSourceSha("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
