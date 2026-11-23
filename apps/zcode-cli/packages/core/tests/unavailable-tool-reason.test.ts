// 未知工具报错后缀：规格见根目录 docs/model-tool-call-validation.md「未知工具的后缀」。
// 走真实 runtime 与执行器，断言下一次模型请求里的 tool result 原文。
import { createSessionId, type ModelRequest } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function toolResultText(request: ModelRequest | undefined, toolCallId: string): string {
  const message = request?.messages.find(
    (entry) => entry.role === "tool" && "toolCallId" in entry && entry.toolCallId === toolCallId,
  );
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? String(block.text) : "",
    )
    .join("\n");
}

async function callUnknownTool(
  label: string,
  name: string,
  config: Partial<AgentRuntimeConfig> = {},
): Promise<string> {
  const requests: ModelRequest[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId(`unavailable-tool-${label}`),
    { mode: "build", modelStreaming: "off", titleGeneration: { enabled: false }, ...config },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        async generateText(request) {
          requests.push(request);
          if (requests.length > 1)
            return { text: "done", finishReason: "stop", usage: {} } as never;
          return {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [{ id: "call", name, input: {} }],
          } as never;
        },
      }),
    },
  );
  try {
    await runtime.executeTurn("go");
    return toolResultText(requests[1], "call");
  } finally {
    runtime.beginShutdown();
  }
}

describe("unavailable tool reason", () => {
  it("points a wrongly cased name to the registered tool", async () => {
    expect(await callUnknownTool("case", "read")).toBe(
      "<tool_use_error>Error: No such tool available: read. Tool names are case-sensitive: call Read instead.</tool_use_error>",
    );
  });

  it("redirects Grep and Glob to Bash when Bash is registered", async () => {
    const config = { toolDisallowlist: ["Grep", "Glob"] };
    expect(await callUnknownTool("grep-bash", "Grep", config)).toBe(
      "<tool_use_error>Error: No such tool available: Grep. Grep is not available in this session \u2014 search file contents with `grep` via the Bash tool instead.</tool_use_error>",
    );
    expect(await callUnknownTool("glob-bash", "Glob", config)).toBe(
      "<tool_use_error>Error: No such tool available: Glob. Glob is not available in this session \u2014 find files with `find` via the Bash tool instead.</tool_use_error>",
    );
  });

  it("reports Grep and Glob as disabled without Bash", async () => {
    const config = { toolDisallowlist: ["Grep", "Glob", "Bash"] };
    expect(await callUnknownTool("grep-off", "Grep", config)).toBe(
      "<tool_use_error>Error: No such tool available: Grep. Grep is disabled for this session.</tool_use_error>",
    );
    expect(await callUnknownTool("glob-off", "Glob", config)).toBe(
      "<tool_use_error>Error: No such tool available: Glob. Glob is disabled for this session.</tool_use_error>",
    );
  });

  it("tells the model a built-in tool is not registered here", async () => {
    expect(await callUnknownTool("builtin", "Write", { toolDisallowlist: ["Write"] })).toBe(
      "<tool_use_error>Error: No such tool available: Write. Write is not among the tools available here. Continue with the tools you have.</tool_use_error>",
    );
  });

  it("tells a subagent to finish with its own tools", async () => {
    expect(
      await callUnknownTool("subagent", "Write", {
        taskType: "subagent_child",
        toolDisallowlist: ["Write"],
      }),
    ).toBe(
      "<tool_use_error>Error: No such tool available: Write. Write is not available inside subagents. Complete the task with the tools provided and return your findings in your final response.</tool_use_error>",
    );
  });

  it("keeps the base sentence for names that match nothing", async () => {
    expect(await callUnknownTool("none", "UnknownFixture")).toBe(
      "<tool_use_error>Error: No such tool available: UnknownFixture</tool_use_error>",
    );
  });
});
