import path from "node:path";

export const codexTranscript = (cwd: string): string => {
  const item = (payload: unknown): string => JSON.stringify({ type: "response_item", payload });
  return [
    JSON.stringify({ type: "session_meta", payload: { cwd } }),
    item({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "add a route 🌱" }],
    }),
    item({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "c1",
      input: "*** Begin Patch\n*** Add File: src/a.ts\n+export const a = 1;\n*** End Patch",
    }),
    item({ type: "custom_tool_call_output", call_id: "c1", output: "Success." }),
  ].join("\n");
};

export const claudeTranscript = (cwd: string): string =>
  [
    { type: "user", cwd, message: { content: "add a route 🌱" } },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "Write",
            input: { file_path: path.join(cwd, "src", "a.ts"), content: "export const a = 1;\n" },
          },
        ],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Success." }] },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
