import { describe, expect, it } from "vitest";
import {
  BROWSER_TURN_SCREENSHOT_SOURCE,
  createMessageId,
  createPartId,
  createSessionId,
  type MessagePart,
  type MessageWithParts,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from "@zcode/contracts";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { clonePartForFork } from "../src/runtime/helpers/steering.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

const sessionID = createSessionId("tool-order");
const messageID = createMessageId("assistant");

function tool(callID: string, declarationIndex?: number): ToolPart {
  return {
    id: createPartId(callID),
    sessionID,
    messageID,
    type: "tool",
    callID,
    tool: callID,
    ...(declarationIndex === undefined ? {} : { declarationIndex }),
    state: {
      status: "completed",
      input: { argument: callID },
      output: `result-${callID}`,
      title: callID,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

async function hydrate(parts: MessagePart[], nextParts?: ToolPart[]) {
  const message: MessageWithParts = {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: createMessageId("user"),
      time: { created: 1 },
      agent: "zcode-agent",
      mode: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
  const history = new MessageHistoryImpl();
  const messages = [message];
  if (nextParts) {
    const nextID = createMessageId("next-assistant");
    messages.push({
      info: { ...message.info, id: nextID },
      parts: nextParts.map((part) => ({ ...part, messageID: nextID })),
    });
  }
  await hydrateMessageHistoryFromSession({ history, messages });
  return buildProviderRequestMessages({ entries: history.toRuntimeEntries() }).messages;
}

describe("provider tool history declaration order", () => {
  it("restores calls and results together without reordering stored parts", async () => {
    const parts = [tool("Read", 2), tool("Bash", 0), tool("Grep", 1)];
    const original = structuredClone(parts);
    const messages = await hydrate(parts);
    expect(messages[0]?.toolCalls).toEqual(
      ["Bash", "Grep", "Read"].map((name) => ({
        id: name,
        name,
        input: { argument: name },
      })),
    );
    expect(messages.slice(1).map((message) => [message.toolCallId, message.content])).toEqual([
      ["Bash", "result-Bash"],
      ["Grep", "result-Grep"],
      ["Read", "result-Read"],
    ]);
    expect(parts).toEqual(original);
  });

  it.each([
    [undefined, undefined],
    [1, undefined],
    [undefined, 0],
  ])("preserves the whole legacy group for indexes %s / %s", async (first, second) => {
    const messages = await hydrate([tool("Read", first), tool("Bash", second)]);
    expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["Read", "Bash"]);
    expect(messages.slice(1).map((message) => message.toolCallId)).toEqual(["Read", "Bash"]);
  });

  it.each(["completed", "error", "pending", "running"] as const)(
    "selects the latest attempt even when its state is %s",
    async (status) => {
      const earlier = tool("Read", 1);
      // 旧尝试可以迟到更新；最新调用结果由 part 插入顺序决定，不能按时间或成功状态挑选。
      earlier.state = {
        status: "completed",
        input: {},
        output: "earlier result",
        title: "Read",
        metadata: {},
        time: { start: 100, end: 200 },
      };
      const latest = { ...tool("Read", 1), id: createPartId("Read-retry") };
      const content =
        status === "completed"
          ? "latest result"
          : status === "error"
            ? "latest error"
            : "[Tool execution was interrupted before resume]";
      if (status === "completed") {
        latest.state = {
          status,
          output: content,
          input: {},
          title: "Read",
          metadata: {},
          time: { start: 1, end: 2 },
        };
      } else if (status === "error") {
        latest.state = { status, input: {}, error: content, time: { start: 1, end: 2 } };
      } else if (status === "pending") {
        latest.state = { status, input: {}, raw: "{}" };
      } else {
        latest.state = { status, input: {}, time: { start: 1 } };
      }
      const parts = [earlier, tool("Bash", 0), latest];
      const original = structuredClone(parts);
      const messages = await hydrate(parts);
      expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["Bash", "Read"]);
      expect(
        messages.slice(1).map((message) => [message.toolCallId, message.content, message.isError]),
      ).toEqual([
        ["Bash", "result-Bash", false],
        ["Read", content, status !== "completed"],
      ]);
      expect(parts).toEqual(original);
    },
  );

  it.each([
    [undefined, undefined],
    [undefined, 0],
    [1, undefined],
  ])(
    "keeps selected attempts in physical order with missing indexes %s / %s",
    async (readIndex, bashIndex) => {
      const retry = { ...tool("Read", readIndex), id: createPartId("Read-retry") };
      const messages = await hydrate([tool("Read", readIndex), tool("Bash", bashIndex), retry]);
      expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["Bash", "Read"]);
      expect(messages.slice(1).map((message) => message.toolCallId)).toEqual(["Bash", "Read"]);
    },
  );

  it("keeps calls with the same ID in separate assistant messages", async () => {
    const read = tool("Read", 1);
    read.state = {
      status: "error",
      input: { argument: "Read" },
      error: "first-read-error",
      time: { start: 1, end: 2 },
    };
    const retry = { ...tool("Read", 1), id: createPartId("Read-retry") };
    const messages = await hydrate([read], [retry]);
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.toolCalls?.map((call) => call.id)),
    ).toEqual([["Read"], ["Read"]]);
    expect(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => [message.toolCallId, message.content]),
    ).toEqual([
      ["Read", "first-read-error"],
      ["Read", "result-Read"],
    ]);
  });

  it("orders interrupted and failed results with gaps in persisted indexes", async () => {
    const read = tool("Read", 3);
    read.state = { status: "running", input: {}, time: { start: 1 } };
    const bash = tool("Bash", 0);
    bash.state = {
      status: "error",
      input: {},
      error: "UI error",
      metadata: { modelContent: "model error" },
      time: { start: 1, end: 2 },
    };
    const messages = await hydrate([read, bash]);
    expect(
      messages.slice(1).map((message) => [message.toolCallId, message.content, message.isError]),
    ).toEqual([
      ["Bash", "model error", true],
      ["Read", "[Tool execution was interrupted before resume]", true],
    ]);
  });

  it.each([false, true])(
    "keeps numeric order through fork cloning (remap calls: %s)",
    async (remap) => {
      const childID = createMessageId("child-assistant");
      const retry = { ...tool("Read", 1), id: createPartId("Read-retry") };
      const parts = [tool("Read", 1), tool("Bash", 0), retry].map(
        (part) =>
          clonePartForFork(part, {
            forkedSessionId: createSessionId("child"),
            nextMessageId: childID,
            ...(remap
              ? {
                  messageIdMap: new Map([[messageID, childID]]),
                  toolCallIdMap: new Map([
                    ["Read", "child-Read"],
                    ["Bash", "child-Bash"],
                  ]),
                }
              : {}),
          }) as ToolPart,
      );
      const messages = await hydrate(parts);
      expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(
        remap ? ["child-Bash", "child-Read"] : ["Bash", "Read"],
      );
    },
  );
});

describe("assistant block order in provider history", () => {
  function screenshot(): ToolPart {
    return {
      id: createPartId("screenshot"),
      sessionID,
      messageID,
      type: "tool",
      callID: "screenshot-call",
      tool: "mcp__node_repl__js",
      state: {
        status: "completed",
        input: { source: BROWSER_TURN_SCREENSHOT_SOURCE },
        output: "",
        title: "mcp__node_repl__js",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
  }

  function text(id: string, value: string, blockIndex?: number): TextPart {
    return {
      id: createPartId(id),
      sessionID,
      messageID,
      type: "text",
      text: value,
      ...(blockIndex === undefined ? {} : { blockIndex }),
    };
  }

  function reasoning(id: string, value: string, blockIndex?: number): ReasoningPart {
    return {
      id: createPartId(id),
      sessionID,
      messageID,
      type: "reasoning",
      text: value,
      metadata: { fixtureProvider: { signature: `signature-${id}` } },
      time: { start: 1, end: 2 },
      ...(blockIndex === undefined ? {} : { blockIndex }),
    };
  }

  function orderedTool(callID: string, blockIndex: number): ToolPart {
    return { ...tool(callID), blockIndex };
  }

  it("keeps the browser turn-end screenshot out of cold model history", async () => {
    // live 从不把轮尾截图放进模型历史；以前冷恢复会把它变成一个工具调用加结果，
    // 导致冷恢复请求和 live 不同。UI 仍然从原始 parts 显示它。
    const messages = await hydrate([tool("Read", 0), screenshot()]);
    expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["Read"]);
    expect(messages.slice(1).map((message) => message.toolCallId)).toEqual(["Read"]);
  });

  it("does not let the screenshot make an ordered message fall back to legacy", async () => {
    const messages = await hydrate([
      orderedTool("Read", 2),
      text("first", "first", 1),
      reasoning("think", "think", 0),
      screenshot(),
    ]);
    expect(messages[0]?.content).toEqual([
      expect.objectContaining({ type: "reasoning", text: "think", blockIndex: 0 }),
      { type: "text", text: "first", blockIndex: 1 },
    ]);
    expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["Read"]);
  });

  it("restores ordered blocks in stream order and keeps text blocks separate", async () => {
    // 只读工具先落盘，reasoning 和 text 在流结束后写库；hydrator 不能依赖写库顺序。
    const messages = await hydrate([
      orderedTool("Read", 4),
      reasoning("first-thought", "first thought", 0),
      text("first", "first", 1),
      reasoning("second-thought", "second thought", 2),
      text("second", "second", 3),
    ]);
    expect(messages[0]?.content).toEqual([
      expect.objectContaining({ type: "reasoning", text: "first thought", blockIndex: 0 }),
      { type: "text", text: "first", blockIndex: 1 },
      expect.objectContaining({ type: "reasoning", text: "second thought", blockIndex: 2 }),
      { type: "text", text: "second", blockIndex: 3 },
    ]);
    expect(messages[0]?.toolCalls).toEqual([
      { id: "Read", name: "Read", input: { argument: "Read" }, blockIndex: 4 },
    ]);
    expect(messages[1]?.toolCallId).toBe("Read");
  });

  it("treats a message with any missing blockIndex as legacy", async () => {
    const messages = await hydrate([
      reasoning("think", "think"),
      text("first", "first", 1),
      text("second", "second", 2),
    ]);
    expect(messages[0]?.content).toEqual([
      expect.objectContaining({ type: "reasoning", text: "think" }),
      { type: "text", text: "first\n\nsecond" },
    ]);
  });

  it("orders tools by blockIndex and falls back to declarationIndex for legacy parts", async () => {
    const ordered = await hydrate([orderedTool("Read", 5), orderedTool("Bash", 2)]);
    expect(ordered[0]?.toolCalls?.map((call) => call.id)).toEqual(["Bash", "Read"]);
    const legacy = await hydrate([tool("Read", 1), tool("Bash", 0)]);
    expect(legacy[0]?.toolCalls?.map((call) => call.id)).toEqual(["Bash", "Read"]);
    const physical = await hydrate([tool("Read"), tool("Bash")]);
    expect(physical[0]?.toolCalls?.map((call) => call.id)).toEqual(["Read", "Bash"]);
    // 非法 blockIndex（JSON 里的 null）按缺失处理，回退到 declarationIndex，不能被当成 0 参与排序。
    const invalid = await hydrate([
      { ...tool("Read", 1), blockIndex: null as unknown as number },
      { ...tool("Bash", 0), blockIndex: 0 },
    ]);
    expect(invalid[0]?.toolCalls?.map((call) => call.id)).toEqual(["Bash", "Read"]);
  });

  it("selects the latest attempt per call while sharing its blockIndex", async () => {
    const retried = {
      ...orderedTool("Read", 3),
      id: createPartId("Read-retry"),
      state: { ...tool("Read").state, output: "retry result" } as ToolPart["state"],
    };
    const messages = await hydrate([orderedTool("Read", 3), orderedTool("Bash", 4), retried]);
    expect(messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["Read", "Bash"]);
    expect(messages.slice(1).map((message) => [message.toolCallId, message.content])).toEqual([
      ["Read", "retry result"],
      ["Bash", "result-Bash"],
    ]);
  });
});
