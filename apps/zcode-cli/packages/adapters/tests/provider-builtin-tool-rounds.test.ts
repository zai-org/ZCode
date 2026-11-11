// 服务端内置工具（analyze_image）多轮回放：真实 GLM 流（脱敏 fixture）经 compat → AI SDK → Runtime，
// 验证下一次请求、持久化顺序和冷恢复回放。背景见 docs/design/v2/model/anthropic-stream-compat.md。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CompactTrigger,
  InMemorySessionEventStore,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { AgentRuntime } from "../../core/src/runtime.js";
import { OUTPUT_TOKEN_CONTINUE_PROMPT } from "../../core/src/runtime/methods/turn-output-token-continuation.js";
import { PROVIDER_TOOL_INTERRUPTED_RESULT } from "../../core/src/runtime/provider-tool-rounds/contract.js";
import { MessageHistoryImpl } from "../../core/src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../core/src/agent/session-history-hydrator.js";
import { compactActiveConversation } from "../../core/src/runtime/methods/compact-active.js";
import { buildProviderRequestMessages } from "../../core/src/runtime/helpers/provider-request-messages.js";
import { findLatestCommittedAssistantUsage } from "../../core/src/runtime/methods/turn-model-step-usage.js";
import {
  eventStream,
  plainReply,
  sse,
  openScenario,
  createRuntime,
  FIXTURE,
  type WireBody,
  type WireMessage,
} from "./provider-builtin-tool-rounds-fixture.js";

// 服务端新格式（直接下发 mcp_tool_use / mcp_tool_result）：由 FIXTURE 按服务端文档改造，其余帧相同。
const MCP_FIXTURE = join(import.meta.dirname, "fixtures", "provider-builtin-analyze-image-mcp.sse");
const TOOL_CALL_ID = "call_93e9e7ad911f4b1799a6c543";

const asIs = (fixture: string) => fixture;
/** 2026-11-05 线上漏发 server_name 的形态：其余帧与 MCP_FIXTURE 相同。 */
function withoutServerName(fixture: string): string {
  const edited = fixture.replace('"server_name": "4_5v_mcp", ', "");
  if (edited === fixture) throw new Error("MCP fixture has no server_name to drop");
  return edited;
}

function conversation(body: WireBody | undefined): WireMessage[] {
  // 去掉 system 和 cache_control 标记，只比较对话本身。
  return JSON.parse(
    JSON.stringify((body?.messages ?? []).filter((message) => message.role !== "system")),
    (key, value) => (key === "cache_control" ? undefined : value),
  );
}

describe("provider built-in tool rounds", () => {
  it.each([
    ["server_tool_use", FIXTURE, asIs],
    ["mcp_tool_use", MCP_FIXTURE, asIs],
    // AI SDK schema 要求 server_name，漏发时整轮报错；兼容层补齐后这一轮必须照常完成。
    ["mcp_tool_use without server_name", MCP_FIXTURE, withoutServerName],
  ])(
    "replays a server-executed analyze_image (%s) as its own round, live and after cold resume",
    async (_format, fixturePath, edit) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-provider-builtin-"));
      const sessionID = createSessionId("provider-builtin");
      const fixture = edit(await readFile(fixturePath, "utf8"));
      const bodies: WireBody[] = [];
      let store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
      const events = new InMemorySessionEventStore({ retention: "unbounded" });
      let runtime: AgentRuntime | undefined;
      try {
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(await new Request(input, init).json());
          return bodies.length === 1
            ? new Response(fixture, { headers: { "content-type": "text/event-stream" } })
            : plainReply(`reply ${bodies.length}`);
        });

        runtime = createRuntime(root, sessionID, store, events);
        await runtime.executeTurn("识别 shot.png 里的文字");
        await runtime.executeTurn("再说一遍");

        // 下一次请求：服务端工具独立成一轮（方案 A），不再出现 markdown 渲染。
        const live = conversation(bodies[1]);
        expect(live.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
          "user",
        ]);
        expect(live[1]!.content).toEqual([
          expect.objectContaining({ type: "thinking" }),
          { type: "text", text: "图片已上传为远程 URL，现在用视觉分析工具识别其中文字。" },
          expect.objectContaining({ type: "tool_use", id: TOOL_CALL_ID, name: "analyze_image" }),
        ]);
        expect(live[2]!.content).toEqual([
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: TOOL_CALL_ID,
            content: expect.stringContaining("Error 1302: request rate limit exceeded"),
          }),
        ]);
        expect(live[3]!.content).toEqual([
          { type: "text", text: expect.stringMatching(/^图片中的文字为/) },
        ]);
        expect(JSON.stringify(bodies[1])).not.toContain("**🌐");
        expect(JSON.stringify(bodies[1])).not.toContain("analyze_image_result_summary");

        // 持久化按流顺序：本轮正文 → 服务端工具卡片 → 下一轮正文。
        const assistant = (await store.messages({ sessionID })).find(
          (message) => message.info.role === "assistant",
        );
        const parts = assistant!.parts.filter(
          (part) => part.type !== "step-start" && part.type !== "step-finish",
        );
        expect(parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool", "text"]);
        expect(parts[2]).toMatchObject({
          type: "tool",
          callID: TOOL_CALL_ID,
          tool: "analyze_image",
          metadata: { providerExecuted: true },
          state: { status: "completed", output: expect.stringContaining("Order Console") },
        });

        // 实时卡片：Scheduled → Started → Result，结果是服务端返回的识别文本。
        const toolEvents = (await events.getEvents(sessionID)).filter(
          (event) =>
            (event.payload as { toolCallId?: string } | undefined)?.toolCallId === TOOL_CALL_ID &&
            event.type !== SessionEventType.ModelStreaming,
        );
        expect(toolEvents.map((event) => event.type)).toEqual([
          SessionEventType.ToolCallScheduled,
          SessionEventType.ToolCallStarted,
          SessionEventType.ToolCallResult,
        ]);

        // 冷恢复后回放出完全相同的对话。
        runtime.beginShutdown();
        store.close();
        store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
        runtime = createRuntime(
          root,
          sessionID,
          store,
          new InMemorySessionEventStore({ retention: "unbounded" }),
        );
        await runtime.resumeFromStore();
        await runtime.executeTurn("第三句");
        const cold = conversation(bodies[2]);
        expect(cold.slice(0, live.length + 1)).toEqual([
          ...live,
          { role: "assistant", content: [{ type: "text", text: "reply 2" }] },
        ]);
      } finally {
        runtime?.beginShutdown();
        vi.unstubAllGlobals();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

// ─── 评审回归：终态判断、断流作废、缺少结果 ────────────────────────────────────

function fixtureFrames(fixture: string): string[] {
  return fixture.split("\n\n").filter((frame) => frame.trim().length > 0);
}

function frameData(frame: string): Record<string, unknown> | undefined {
  const line = frame.split("\n").find((candidate) => candidate.startsWith("data:"));
  return line ? (JSON.parse(line.slice("data:".length)) as Record<string, unknown>) : undefined;
}

function sseBody(frames: string[]): string {
  return frames.map((frame) => `${frame}\n\n`).join("");
}

/** 再发一句拿 live history，冷恢复后再发一句拿冷恢复 history，两者必须一致。 */
async function expectColdResumeMatchesLive(scenario: Awaited<ReturnType<typeof openScenario>>) {
  await scenario.runtime.executeTurn("再说一遍");
  const live = conversation(scenario.bodies.at(-1));
  await scenario.coldResume();
  await scenario.runtime.executeTurn("第三句");
  const cold = conversation(scenario.bodies.at(-1));
  expect(cold.slice(0, live.length)).toEqual(live);
  return live;
}

describe("provider built-in tool rounds (review regressions)", () => {
  const formats = [
    ["server_tool_use", FIXTURE],
    ["mcp_tool_use", MCP_FIXTURE],
  ];

  it.each(formats)(
    "still continues a truncated answer after a server-executed tool round (%s)",
    async (_format, fixturePath) => {
      const scenario = await openScenario(
        (index, fixture) =>
          index === 0
            ? eventStream(
                fixture.replace(/"stop_reason": "end_turn"/u, '"stop_reason": "max_tokens"'),
              )
            : plainReply(`reply ${index}`),
        fixturePath,
      );
      try {
        await scenario.runtime.executeTurn("识别 shot.png 里的文字");
        // 服务端工具不算待执行调用：max_tokens 必须触发续写请求。
        expect(scenario.bodies).toHaveLength(2);
        const continuation = conversation(scenario.bodies[1]);
        expect(JSON.stringify(continuation.at(-1))).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
        expect(continuation.some((message) => JSON.stringify(message).includes(TOOL_CALL_ID))).toBe(
          true,
        );
      } finally {
        await scenario.close();
      }
    },
  );

  it.each(formats)(
    "keeps a discarded stream attempt out of both live and cold-resumed history (%s)",
    async (_format, fixturePath) => {
      const scenario = await openScenario((index, fixture) => {
        if (index !== 0) return plainReply(`reply ${index}`);
        // 服务端工具与结果已下发、最后一轮正文写到一半时断流（可重试）。
        const frames = fixtureFrames(fixture);
        const cut = frames.findIndex((frame) => {
          const data = frameData(frame);
          return data?.type === "content_block_delta" && data.index === 6;
        });
        const encoder = new TextEncoder();
        let delivered = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            // 先交付已收到的帧，等下游消费后再断流：源流出错时，下游 TransformStream 里尚未读取的数据会被丢弃。
            async pull(controller) {
              if (!delivered) {
                delivered = true;
                controller.enqueue(encoder.encode(sseBody(frames.slice(0, cut + 1))));
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
              // 与 Node 真实 socket 错误一致带 code，adapter 才会归类为网络断流。
              controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }, fixturePath);
      try {
        await scenario.runtime.executeTurn("识别 shot.png 里的文字");
        const live = await expectColdResumeMatchesLive(scenario);
        // 作废的 attempt 不进任何 history：只剩重试后的回答。
        expect(JSON.stringify(live)).not.toContain(TOOL_CALL_ID);
        expect(live.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      } finally {
        await scenario.close();
      }
    },
  );

  it("drops an MCP result that no call paired and settles the call as interrupted, live and cold", async () => {
    // AI SDK 遇到未配对的 mcp_tool_result 会抛 TypeError，整轮失败；兼容层丢弃它后，调用按中断收口。
    const scenario = await openScenario(
      (index, fixture) =>
        index === 0
          ? eventStream(
              fixture.replace(`"tool_use_id": "${TOOL_CALL_ID}"`, '"tool_use_id": "call_unpaired"'),
            )
          : plainReply(`reply ${index}`),
      MCP_FIXTURE,
    );
    try {
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      const live = await expectColdResumeMatchesLive(scenario);
      expect(live[2]!.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: TOOL_CALL_ID,
          is_error: true,
          content: PROVIDER_TOOL_INTERRUPTED_RESULT,
        }),
      ]);
    } finally {
      await scenario.close();
    }
  });

  // 新格式合成流：调用、结果和文字块按服务端文档的形态构造。
  const textEvents = (index: number, value: string) => [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
    { type: "content_block_stop", index },
  ];
  const mcpCallEvents = (index: number, id: string, name: string) => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "mcp_tool_use", id, name, server_name: "4_5v_mcp", input: { name } },
    },
    { type: "content_block_stop", index },
  ];
  const mcpResultEvents = (index: number, id: string, value: string, isError: boolean) => [
    {
      type: "content_block_start",
      index,
      content_block: {
        type: "mcp_tool_result",
        tool_use_id: id,
        content: [{ type: "text", text: value }],
        is_error: isError,
      },
    },
    { type: "content_block_stop", index },
  ];
  const mcpReply = (blocks: Array<Record<string, unknown>>) =>
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_mcp",
          type: "message",
          role: "assistant",
          model: "glm-5.3",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      ...blocks,
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);

  it("keeps a model answer labelled **Output:** when the server sends no summary, live and cold", async () => {
    // 评审 CR-01：结果后没有服务端摘要，模型回答以 **Output:** 开头；兼容层不能把整段回答删掉。
    const answer = "**Output:** 正常最终回答";
    const scenario = await openScenario((index) =>
      index === 0
        ? mcpReply([
            ...mcpCallEvents(0, "call_a", "analyze_image"),
            ...mcpResultEvents(1, "call_a", "图片结果", false),
            ...textEvents(2, answer),
          ])
        : plainReply(`reply ${index}`),
    );
    try {
      await scenario.runtime.executeTurn("看图");
      const assistant = (await scenario.store.messages({ sessionID: scenario.sessionID })).find(
        (message) => message.info.role === "assistant",
      );
      expect(assistant!.parts).toContainEqual(
        expect.objectContaining({ type: "text", text: answer }),
      );
      const live = await expectColdResumeMatchesLive(scenario);
      expect(live[3]!.content).toEqual([{ type: "text", text: answer }]);
    } finally {
      await scenario.close();
    }
  });

  it("replays parallel MCP calls, including an error result, as rounds in call order, live and cold", async () => {
    // 新格式并行：调用都在前、结果都在后，按 id 配对回各自的轮次；方案 A 回放成先后两轮。
    const scenario = await openScenario((index) =>
      index === 0
        ? mcpReply([
            ...textEvents(0, "**🌐 Built-in Tool: analyze_image**"),
            ...mcpCallEvents(1, "call_a", "analyze_image"),
            ...textEvents(2, "**🌐 Built-in Tool: webReader**"),
            ...mcpCallEvents(3, "call_b", "webReader"),
            ...mcpResultEvents(4, "call_a", "图片结果", false),
            ...textEvents(5, "**Output:**\n**analyze_image_result_summary:** 图片结果"),
            ...mcpResultEvents(6, "call_b", "MCP error 400", true),
            ...textEvents(7, "**Output:**\n**webReader_result_summary:** MCP error 400"),
            ...textEvents(8, "最终回答"),
          ])
        : plainReply(`reply ${index}`),
    );
    try {
      await scenario.runtime.executeTurn("看图并读网页");
      const toolEvents = (await scenario.events.getEvents(scenario.sessionID)).filter(
        (event) =>
          ["call_a", "call_b"].includes(
            (event.payload as { toolCallId?: string } | undefined)?.toolCallId ?? "",
          ) && event.type !== SessionEventType.ModelStreaming,
      );
      expect(
        toolEvents.map((event) => [
          event.type,
          (event.payload as { toolCallId: string }).toolCallId,
        ]),
      ).toEqual([
        [SessionEventType.ToolCallScheduled, "call_a"],
        [SessionEventType.ToolCallStarted, "call_a"],
        [SessionEventType.ToolCallScheduled, "call_b"],
        [SessionEventType.ToolCallStarted, "call_b"],
        [SessionEventType.ToolCallResult, "call_a"],
        [SessionEventType.ToolCallResult, "call_b"],
      ]);
      expect(toolEvents.at(-1)!.payload).toMatchObject({ result: { success: false } });

      const live = await expectColdResumeMatchesLive(scenario);
      const wire = JSON.stringify(live);
      expect(wire).not.toContain("**🌐");
      expect(wire).not.toContain("**Output:**");
      expect(live.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(live[1]!.content).toEqual([
        expect.objectContaining({ type: "tool_use", id: "call_a", name: "analyze_image" }),
      ]);
      expect(live[2]!.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call_a",
          content: "图片结果",
        }),
      ]);
      expect(live[3]!.content).toEqual([
        expect.objectContaining({ type: "tool_use", id: "call_b", name: "webReader" }),
      ]);
      expect(live[4]!.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call_b",
          is_error: true,
          content: "MCP error 400",
        }),
      ]);
      expect(live[5]!.content).toEqual([{ type: "text", text: "最终回答" }]);
    } finally {
      await scenario.close();
    }
  });

  it("settles a server tool whose result never arrives as interrupted, live and cold", async () => {
    const scenario = await openScenario((index, fixture) => {
      if (index !== 0) return plainReply(`reply ${index}`);
      const frames = fixtureFrames(fixture).filter((frame) => {
        const data = frameData(frame);
        const block = data?.content_block as { type?: string } | undefined;
        return !(
          (data?.type === "content_block_start" && block?.type === "tool_result") ||
          (data?.type === "content_block_stop" && data.index === 5)
        );
      });
      return eventStream(sseBody(frames));
    });
    try {
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      const toolEvents = (await scenario.events.getEvents(scenario.sessionID)).filter(
        (event) =>
          (event.payload as { toolCallId?: string } | undefined)?.toolCallId === TOOL_CALL_ID &&
          event.type !== SessionEventType.ModelStreaming,
      );
      expect(toolEvents.map((event) => event.type)).toEqual([
        SessionEventType.ToolCallScheduled,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallResult,
      ]);
      expect(toolEvents[2]!.payload).toMatchObject({ result: { success: false } });

      const live = await expectColdResumeMatchesLive(scenario);
      expect(live[2]!.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: TOOL_CALL_ID,
          is_error: true,
          content: PROVIDER_TOOL_INTERRUPTED_RESULT,
        }),
      ]);
    } finally {
      await scenario.close();
    }
  });

  it("keeps one compact group per stored response, live and after cold resume", async () => {
    const scenario = await openScenario((_index, fixture, body) => {
      const text = JSON.stringify(body.messages);
      if (text.includes("create a detailed summary")) {
        return plainReply("<summary>older work summary</summary>");
      }
      return text.includes("识别 shot.png") && !text.includes(TOOL_CALL_ID)
        ? eventStream(fixture)
        : plainReply("earlier reply");
    });
    try {
      await scenario.runtime.executeTurn("old setup");
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      // 一条持久化 assistant 拆成了 round + 最后一轮；compact 保留最近一组时必须整条保留或整条摘要。
      await compactActiveConversation.call(
        scenario.runtime as never,
        undefined,
        createRootTraceContext({ sessionId: scenario.sessionID }),
        [],
        { trigger: CompactTrigger.Auto },
      );
      const project = (entries: ReturnType<MessageHistoryImpl["toRuntimeEntries"]>) =>
        buildProviderRequestMessages({
          entries,
          useMidConversationSystem: false,
          applyCacheControl: false,
        }).messages.filter((message) => message.toolCalls?.length || message.role === "tool");
      const live = project(
        (
          scenario.runtime as unknown as { messageHistory: MessageHistoryImpl }
        ).messageHistory.toRuntimeEntries(),
      );
      const restored = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({
        history: restored,
        messages: await scenario.store.messages({ sessionID: scenario.sessionID }),
      });
      expect(project(restored.toRuntimeEntries())).toEqual(live);
      // 最近一组是整条服务端工具响应：调用与结果随最后一轮一起保留。
      expect(JSON.stringify(live)).toContain(TOOL_CALL_ID);
    } finally {
      await scenario.close();
    }
  });

  it.each(["with", "without"] as const)(
    "does not anchor context usage on a server tool response %s trailing text, live and cold",
    async (trailing) => {
      // 服务端多轮请求的 usage 是合计（fixture 约 37k，单次上下文约一半），不能当估算锚点。
      const fixtureFor = (fixture: string) =>
        trailing === "with"
          ? fixture
          : sseBody(fixtureFrames(fixture).filter((frame) => frameData(frame)?.index !== 6));
      const scenario = await openScenario((_index, fixture, body) => {
        const text = JSON.stringify(body.messages);
        return text.includes("识别 shot.png") && !text.includes(TOOL_CALL_ID)
          ? eventStream(fixtureFor(fixture))
          : plainReply("earlier reply");
      });
      try {
        await scenario.runtime.executeTurn("old setup");
        await scenario.runtime.executeTurn("识别 shot.png 里的文字");
        const anchorOf = (entries: ReturnType<MessageHistoryImpl["toRuntimeEntries"]>) => {
          const anchor = findLatestCommittedAssistantUsage(entries);
          const entry = anchor ? entries[anchor.messageIndex] : undefined;
          return {
            baseline: anchor?.baseline,
            message: entry && "message" in entry ? entry.message.content : undefined,
          };
        };
        const live = anchorOf(
          (
            scenario.runtime as unknown as { messageHistory: MessageHistoryImpl }
          ).messageHistory.toRuntimeEntries(),
        );
        const restored = new MessageHistoryImpl();
        await hydrateMessageHistoryFromSession({
          history: restored,
          messages: await scenario.store.messages({ sessionID: scenario.sessionID }),
        });
        expect(anchorOf(restored.toRuntimeEntries())).toEqual(live);
        // 锚点仍是上一轮的真实 usage，而不是服务端合计。
        expect(JSON.stringify(live.message)).toContain("earlier reply");
        await expectColdResumeMatchesLive(scenario);
      } finally {
        await scenario.close();
      }
    },
  );
});
