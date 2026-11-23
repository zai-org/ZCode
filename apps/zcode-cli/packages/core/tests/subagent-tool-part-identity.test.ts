import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId, SessionEventType, type SessionId } from "@zcode/contracts";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 回归 2026-11-10：子代理事实原来不落盘，父 transcript 里只有模型可见文本的 `agentId:`、`output_file:`
// 行与启动回执前缀。冷加载重建 Agent 行、子会话目录查询、崩溃对账只能从文本里正则查找；同步失败的 part
// 是 error 状态，`agentId:` 行只在 metadata.modelContent 里，冷加载读不到，行身份退回 tool call id、没有
// 子会话入口。现在身份与后台启动事实结构化写进 Agent tool part 的 part.metadata。

const AGENT_CALL_ID = "call_identity_agent";
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

async function runParentAgentCall(
  agentInput: Record<string, unknown>,
  child: (parentTurnDone: Promise<void>) => Promise<unknown>,
  subagents: { autoBackgroundMs?: number } = {},
) {
  const sessionId = createSessionId(`runtime-agent-part-identity-${crypto.randomUUID()}`);
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-agent-part-identity-"));
  const eventStore = createTestSessionEventStore();
  const sessionStore = createRecordingSubagentSessionStore();
  const parentTurnDone = Promise.withResolvers<void>();
  let parentCalls = 0;
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      mode: "build",
      workingDirectory: "/workspace/project",
      // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
      subagents: { outputRootDir, alwaysBackground: false, ...subagents },
    },
    {
      eventStore,
      sessionStore,
      modelFactory: createTestModelFactory({
        async generateText(_request: unknown, observation: any) {
          if (observation.invocationContext?.metadata?.querySource === "subagent") {
            return child(parentTurnDone.promise);
          }
          parentCalls++;
          if (parentCalls > 1) return { finishReason: "stop", text: "parent done", usage };
          return {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [{ id: AGENT_CALL_ID, name: "Agent", input: agentInput }],
            usage,
          };
        },
      } as never),
    },
  );
  await runtime.executeTurn("Use an agent to review the module");
  parentTurnDone.resolve();
  await (
    runtime as unknown as { subagentPort?: { waitForIdle?: () => Promise<void> } }
  ).subagentPort?.waitForIdle?.();
  const messages = await sessionStore.messages({ sessionID: sessionId });
  // 测试 store 每次保存都追加一份，真实 store 按 part id 覆盖：取最后保存的那份。
  const agentPart = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && part.callID === AGENT_CALL_ID)
    .at(-1);
  const spawned = (await eventStore.getEvents(sessionId)).find(
    (event) => event.type === SessionEventType.SubagentSpawned,
  );
  await runtime.close();
  return {
    agentPart: agentPart as
      | { metadata?: Record<string, unknown>; state: { status: string } }
      | undefined,
    outputDirOf: (agentId: string | undefined) => join(outputRootDir, sessionId, agentId ?? ""),
    spawned: spawned?.payload as { agentId?: string; childSessionId?: SessionId } | undefined,
  };
}

const reviewInput = {
  description: "Review module",
  prompt: "Review the module.",
  subagent_type: "general-purpose",
};

describe("Agent tool part subagent facts", () => {
  it.each([
    [
      "a completed sync agent",
      reviewInput,
      async () => ({ finishReason: "stop", text: "Findings: module A is fine.", usage }),
      {},
      "completed",
      false,
    ],
    [
      "a sync agent that failed after its child session was ready",
      reviewInput,
      async () => {
        throw new Error("Provider rate limited the request (HTTP 429)");
      },
      {},
      "error",
      false,
    ],
    [
      "a background agent launch",
      { ...reviewInput, run_in_background: true },
      async () => ({ finishReason: "stop", text: "Background findings.", usage }),
      {},
      "completed",
      true,
    ],
    [
      "a foreground agent moved to the background",
      reviewInput,
      async (parentTurnDone: Promise<void>) => {
        // 父轮结束前 child 不返回：前台等待一定先被自动转后台打断。
        await parentTurnDone;
        return { finishReason: "stop", text: "Findings after moving.", usage };
      },
      { autoBackgroundMs: 1 },
      "completed",
      true,
    ],
  ] as const)(
    "stores the facts on %s",
    async (_name, input, child, subagents, partStatus, background) => {
      const { agentPart, outputDirOf, spawned } = await runParentAgentCall(input, child, subagents);

      expect(agentPart?.state.status).toBe(partStatus);
      expect(spawned?.agentId).toMatch(/^agent_/);
      // 与 SubagentSpawned 同一份值：两处身份来自 child session 就绪的同一时刻。同步、后台都记下 runner
      // 为这次运行定下的输出文件（metadata.json 在同一目录），冷恢复按它找，不按当前存储配置推算。
      expect(agentPart?.metadata).toMatchObject({
        agentId: spawned?.agentId,
        childSessionId: spawned?.childSessionId,
        outputFile: join(outputDirOf(spawned?.agentId), "output.txt"),
      });
      expect(spawned?.childSessionId).toBe(createSessionId(`subagent_${spawned?.agentId}`));
      if (background) {
        expect(agentPart?.metadata).toMatchObject({ background: true });
      } else {
        expect(agentPart?.metadata).not.toHaveProperty("background");
      }
    },
  );

  it("stores no facts when the agent fails before a child session exists", async () => {
    const { agentPart, spawned } = await runParentAgentCall(
      { ...reviewInput, subagent_type: "missing-agent-type" },
      async () => {
        throw new Error("a child must not start");
      },
    );

    expect(agentPart?.state.status).toBe("error");
    expect(spawned).toBeUndefined();
    expect(agentPart?.metadata).not.toHaveProperty("agentId");
    expect(agentPart?.metadata).not.toHaveProperty("childSessionId");
    expect(agentPart?.metadata).not.toHaveProperty("outputFile");
  });
});
