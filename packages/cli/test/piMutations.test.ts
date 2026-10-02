import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { assertNever } from "@coldtea/abide-schema";
import { afterAll, describe, expect, it } from "vitest";
import { createPiBridge } from "../dist/pi/bridge.js";
import { createMutationTracker, mutationPayload } from "../src/pi/mutations.js";
import { mkfifo, NO_FIFO } from "./helpers/fifo.js";

const root = mkdtempSync(path.join(tmpdir(), "abide-pi-mutations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const identity = { session_id: "s", prompt_id: "p", cwd: root };

describe("Pi completed changes", () => {
  it("checks the actual multi-edit result, not sequential replacement reconstruction", () => {
    const tracker = createMutationTracker();
    tracker.begin(
      "e",
      "edit",
      {
        path: "a.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "b", newText: "c" },
        ],
      },
      root,
    );
    tracker.setBefore("e", { kind: "present", text: "a b\n" });
    const change = tracker.complete("e", { kind: "present", text: "b c\n" });
    expect(change).toEqual({ file: path.join(root, "a.ts"), before: "a b\n", after: "b c\n" });
    if (!change) throw new Error("missing change");
    expect(mutationPayload(change, identity, "e")).toMatchObject({
      tool_name: "Write",
      tool_input: { content: "b c\n" },
      tool_response: { originalFile: "a b\n" },
      tool_use_id: "e",
    });
  });
  it("distinguishes a new file from an unreadable existing file", () => {
    for (const kind of ["absent", "unreadable", "oversized"] as const) {
      const tracker = createMutationTracker();
      tracker.begin("w", "write", { path: "a.ts", content: "after" }, root);
      tracker.setBefore("w", { kind });
      const change = tracker.complete("w", { kind: "present", text: "after" });
      if (kind === "absent") expect(change?.before).toBeNull();
      else expect(change).toBeUndefined();
    }
  });
  it("taints both overlapping same-file calls including path aliases", () => {
    const tracker = createMutationTracker();
    tracker.begin("a", "write", { path: "./a.ts", content: "a" }, root);
    tracker.setBefore("a", { kind: "absent" });
    tracker.begin("b", "write", { path: path.join(root, "a.ts"), content: "b" }, root);
    tracker.setBefore("b", { kind: "present", text: "a" });
    expect(tracker.complete("a", { kind: "present", text: "b" })).toBeUndefined();
    expect(tracker.complete("b", { kind: "present", text: "b" })).toBeUndefined();
  });
  it("keeps parallel different-file and nested call IDs separate", () => {
    const tracker = createMutationTracker();
    for (const id of ["parent/1", "parent/2"]) {
      tracker.begin(id, "write", { path: `${id.replace("/", "-")}.ts`, content: id }, root);
      tracker.setBefore(id, { kind: "absent" });
    }
    expect(tracker.complete("parent/2", { kind: "present", text: "two" })?.after).toBe("two");
    expect(tracker.complete("parent/1", { kind: "present", text: "one" })?.after).toBe("one");
  });
  it("ignores malformed, unsupported, excluded and missing calls", () => {
    const tracker = createMutationTracker();
    for (const [name, input] of [
      ["bash", { command: "hi" }],
      ["write", {}],
      ["edit", { path: "a" }],
      ["write", { path: ".env.local", content: "x" }],
      ["write", { path: ".abide/rubric.json", content: "x" }],
    ] as const)
      expect(tracker.begin("x", name, input, root)).toBeUndefined();
    expect(tracker.complete("missing", { kind: "present", text: "x" })).toBeUndefined();
    tracker.begin("x", "write", { path: "a", content: "x" }, root);
    tracker.discard("x");
    expect(tracker.complete("x", { kind: "present", text: "x" })).toBeUndefined();
    tracker.clear();
  });
});

describe("Pi path normalization", () => {
  for (const variant of ["at", "home", "unicode", "url"] as const) {
    it(`captures the file Pi actually writes for a ${variant} path`, async () => {
      const cwd = mkdtempSync(path.join(homedir(), ".abide-pi-path-"));
      const bridge = createPiBridge();
      try {
        const file = path.join(cwd, "two words.ts");
        const inputPath = (() => {
          switch (variant) {
            case "at":
              return "@two words.ts";
            case "home":
              return `~/${path.relative(homedir(), file).split(path.sep).join("/")}`;
            case "unicode":
              return "@two\u202fwords.ts";
            case "url":
              return pathToFileURL(file).href;
            default:
              return assertNever(variant);
          }
        })();
        const input = { path: inputPath, content: "export const value = 1;\n" };
        const tracker = createMutationTracker();
        const pending = tracker.begin("actual-pi-write", "write", input, cwd);
        expect(pending?.file).toBe(file);
        if (!pending) throw new Error("Expected a tracked Pi write");
        tracker.setBefore("actual-pi-write", await bridge.capture(pending.file));
        await createWriteTool(cwd).execute("actual-pi-write", input, undefined, undefined);
        const change = tracker.complete("actual-pi-write", await bridge.capture(pending.file));
        expect(change).toEqual({ file, before: null, after: "export const value = 1;\n" });
        expect(readFileSync(file, "utf8")).toBe("export const value = 1;\n");
      } finally {
        bridge.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
  it("excludes secret and Abide-owned paths after normalization", () => {
    const tracker = createMutationTracker();
    for (const file of [
      "@.env.local",
      "@.abide/rubric.json",
      pathToFileURL(path.join(root, ".env")).href,
    ]) {
      expect(tracker.begin("excluded", "write", { path: file, content: "" }, root)).toBeUndefined();
    }
  });
});

describe("isolated capture (build first)", () => {
  it("reads bounded regular files and distinguishes oversized and absent files", async () => {
    const bridge = createPiBridge();
    const file = path.join(root, "capture.ts");
    writeFileSync(file, "hello");
    expect(await bridge.capture(file)).toEqual({ kind: "present", text: "hello" });
    writeFileSync(file, "x".repeat(500_001));
    expect(await bridge.capture(file)).toEqual({ kind: "oversized" });
    expect(await bridge.capture(path.join(root, "absent.ts"))).toEqual({ kind: "absent" });
    bridge.close();
    bridge.close();
    expect(await bridge.capture(path.join(root, "absent.ts"))).toEqual({ kind: "absent" });
  });
  it.skipIf(process.platform === "win32")(
    "refuses leaf, dangling and directory symlinks",
    async () => {
      const dir = path.join(root, "links");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "target"), "x");
      symlinkSync("target", path.join(dir, "leaf"));
      symlinkSync("gone", path.join(dir, "dangling"));
      symlinkSync(dir, path.join(root, "alias"));
      const bridge = createPiBridge();
      for (const file of [
        path.join(dir, "leaf"),
        path.join(dir, "dangling"),
        path.join(root, "alias", "target"),
      ])
        expect(await bridge.capture(file)).toEqual({ kind: "unreadable" });
      bridge.close();
    },
  );
  it.skipIf(NO_FIFO)("refuses a FIFO without waiting on a writer", async () => {
    const file = path.join(root, "pipe");
    mkfifo(file);
    const bridge = createPiBridge();
    expect(await bridge.capture(file)).toEqual({ kind: "unreadable" });
    bridge.close();
  });
});
