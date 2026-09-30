import { randomUUID } from "node:crypto";
import { assertNever, type HookOutput } from "@coldtea/abide-schema";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_TASK_CHARS } from "../lib/constants.js";
import { createPiBridge } from "./bridge.js";
import { createMutationTracker, mutationPayload, type MutationTracker } from "./mutations.js";

type Task =
  | { kind: "idle" }
  | {
      kind: "active";
      identity: { session_id: string; prompt_id: string; cwd: string };
      controller: AbortController;
      mutations: MutationTracker;
      followups: number;
      prompt: string;
      lastPrompt: string;
    };
type ActiveTask = Extract<Task, { kind: "active" }>;
const createTaskId = (): string => randomUUID();

export default function abide(pi: ExtensionAPI): void {
  const bridge = createPiBridge();
  let task: Task = { kind: "idle" };
  let epoch = 0;
  let compileContext: string | undefined;

  const reset = (): void => {
    switch (task.kind) {
      case "active":
        task.controller.abort();
        task.mutations.clear();
        break;
      case "idle":
        break;
      default:
        assertNever(task);
    }
    task = { kind: "idle" };
    epoch += 1;
    bridge.close();
  };
  const finishActivity = async (): Promise<void> => {
    const current = task;
    reset();
    switch (current.kind) {
      case "idle":
        return;
      case "active":
        await bridge.hook("stop", {
          ...current.identity,
          hook_event_name: "Stop",
          turn_state: "clear",
        });
        return;
      default:
        return assertNever(current);
    }
  };
  const signalFor = (current: ActiveTask, ctx: ExtensionContext): AbortSignal =>
    ctx.signal === undefined
      ? current.controller.signal
      : AbortSignal.any([current.controller.signal, ctx.signal]);
  const currentTask = (current: ActiveTask, signal: AbortSignal): boolean =>
    task === current && !signal.aborted;
  const notify = (message: string | undefined, ctx: ExtensionContext): void => {
    if (!message) return;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else pi.appendEntry("abide-notice", { message });
  };
  const advisory = (output: HookOutput, ctx: ExtensionContext): void => {
    switch (output.kind) {
      case "silent":
        return;
      case "notice":
      case "block":
      case "session-context":
        notify(output.systemMessage, ctx);
        return;
      default:
        return assertNever(output);
    }
  };

  pi.on("session_start", async (event, ctx) => {
    try {
      reset();
      compileContext = undefined;
      const generation = epoch;
      const output = await bridge.hook("session-start", {
        session_id: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        hook_event_name: "SessionStart",
        source: event.reason,
      });
      if (generation !== epoch) return;
      advisory(output, ctx);
      switch (output.kind) {
        case "session-context":
          compileContext = output.additionalContext;
          return;
        case "silent":
        case "notice":
        case "block":
          return;
        default:
          return assertNever(output);
      }
    } catch {
      compileContext = undefined;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      reset();
      const current: ActiveTask = {
        kind: "active",
        identity: {
          session_id: ctx.sessionManager.getSessionId(),
          prompt_id: createTaskId(),
          cwd: ctx.cwd,
        },
        controller: new AbortController(),
        mutations: createMutationTracker(),
        followups: 0,
        prompt: event.prompt.slice(0, MAX_TASK_CHARS),
        lastPrompt: event.prompt.slice(0, MAX_TASK_CHARS),
      };
      task = current;
      const signal = signalFor(current, ctx);
      await bridge.hook(
        "turn-start",
        { ...current.identity, hook_event_name: "UserPromptSubmit", prompt: event.prompt },
        signal,
      );
      if (!currentTask(current, signal) || compileContext === undefined) return;
      const content = compileContext;
      compileContext = undefined;
      return { message: { customType: "abide-compile", content, display: false } };
    } catch {
      reset();
    }
  });

  pi.on("message_end", (event) => {
    if (task.kind !== "active") return;
    const message = event.message;
    switch (message.role) {
      case "user": {
        const text = (
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
        ).slice(0, MAX_TASK_CHARS);
        if (text !== task.lastPrompt) {
          task.prompt = `${task.prompt}\n${text}`.slice(-MAX_TASK_CHARS);
          task.lastPrompt = text;
        }
        return;
      }
      case "system":
      case "assistant":
      case "toolResult":
      case "bashExecution":
      case "custom":
      case "branchSummary":
      case "compactionSummary":
        return;
      default:
        return assertNever(message);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (task.kind !== "active") return;
    const current = task;
    try {
      const pending = current.mutations.begin(
        event.toolCallId,
        event.toolName,
        event.input,
        ctx.cwd,
      );
      if (!pending) return;
      const signal = signalFor(current, ctx);
      const before = await bridge.capture(pending.file, signal);
      if (currentTask(current, signal)) current.mutations.setBefore(event.toolCallId, before);
    } catch {
      current.mutations.discard(event.toolCallId);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (task.kind !== "active") return;
    const current = task;
    try {
      if (event.isError) {
        current.mutations.discard(event.toolCallId);
        return;
      }
      const file = current.mutations.file(event.toolCallId);
      if (!file) return;
      const signal = signalFor(current, ctx);
      const after = await bridge.capture(file, signal);
      if (!currentTask(current, signal)) return;
      const change = current.mutations.complete(event.toolCallId, after);
      if (!change) return;
      const output = await bridge.hook(
        "post-tool-use",
        mutationPayload(change, { ...current.identity, prompt: current.prompt }, event.toolCallId),
        signal,
      );
      if (!currentTask(current, signal)) return;
      advisory(output, ctx);
      switch (output.kind) {
        case "block":
          return {
            content: [...event.content, { type: "text", text: output.reason }],
            structuredContent: event.structuredContent,
          };
        case "silent":
        case "notice":
        case "session-context":
          return;
        default:
          return assertNever(output);
      }
    } catch {
      current.mutations.discard(event.toolCallId);
    }
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (task.kind !== "active") return;
    const current = task;
    try {
      switch (event.outcome) {
        case "aborted":
        case "error":
          return;
        case "completed":
          break;
        default:
          return assertNever(event.outcome);
      }
      const signal = signalFor(current, ctx);
      const output = await bridge.hook(
        "stop",
        {
          ...current.identity,
          hook_event_name: "Stop",
          turn_state: "preserve",
          prompt: current.prompt,
          stop_hook_active: current.followups > 0,
        },
        signal,
      );
      if (!currentTask(current, signal)) return;
      advisory(output, ctx);
      switch (output.kind) {
        case "block":
          if (current.followups >= 1) {
            notify(output.reason, ctx);
            return;
          }
          current.followups += 1;
          // Pi validates continuation after applying this repair message.
          return {
            entries: [
              ...event.entries,
              {
                type: "custom_message",
                customType: "abide-repair",
                content: output.reason,
                display: true,
              },
            ],
            continue: true,
          };
        case "silent":
        case "notice":
        case "session-context":
          return;
        default:
          return assertNever(output);
      }
    } catch {
      current.controller.abort();
    }
  });

  pi.on("agent_settled", async () => {
    try {
      await finishActivity();
    } catch {
      task = { kind: "idle" };
    }
  });
  pi.on("session_shutdown", async () => {
    try {
      await finishActivity();
      compileContext = undefined;
    } catch {
      task = { kind: "idle" };
    }
  });
}
