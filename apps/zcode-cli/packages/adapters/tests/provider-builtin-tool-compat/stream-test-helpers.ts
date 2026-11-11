import {
  ProviderBuiltinToolStreamRewriter,
  type SseFrame,
} from "../../src/model/provider-builtin-tool-compat/contract.js";

// provider-builtin-tool-compat 契约用例共用的帧构造：逐帧喂给改写器，返回下游看到的 JSON。

function frame(data: Record<string, unknown>): {
  frame: SseFrame;
  parsed: Record<string, unknown>;
} {
  return {
    frame: {
      frame: `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}`,
      separator: "\n\n",
    },
    parsed: data,
  };
}

export function run(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const rewriter = new ProviderBuiltinToolStreamRewriter();
  const out: SseFrame[] = [];
  for (const { frame: input, parsed } of events.map(frame))
    out.push(...rewriter.push(input, parsed));
  out.push(...rewriter.finish());
  return out.map((item) => JSON.parse(item.frame.split("data: ")[1]!) as Record<string, unknown>);
}

export const serverToolUse = (index: number) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "server_tool_use", id: "call_1", name: "analyze_image", input: {} },
  },
  { type: "content_block_stop", index },
];

export const textBlock = (index: number, text: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];

export const deltaTexts = (events: Array<Record<string, unknown>>) =>
  events
    .filter((event) => event.type === "content_block_delta")
    .map((event) => (event.delta as { text: string }).text);
