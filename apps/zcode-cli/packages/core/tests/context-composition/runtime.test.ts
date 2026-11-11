// Context 组成的 runtime 行为（spec §4 第 3、4、5 类）：
// apps/zcode-cli/docs/design/v2/model/context-composition.md。
import { describe, expect, it, vi } from "vitest";
import { createSessionId, type ModelRequest } from "@zcode/contracts";
import { contextCompositionSchema } from "@zcode/shared/zcode-protocol-v4";
import { countContextPrefixMessages } from "../../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import type { ContextCompositionChangeReason } from "../../src/runtime/context-composition/index.js";
import { createTestAgentRuntime } from "../test-agent-runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { createTestModelFactory } from "../test-runtime-model.js";
import { createRecordingMessageStore } from "../runtime-output-token-continuation-test-helpers.js";

const PROVIDER_INPUT_TOKENS = 1_234;
const PROVIDER_OUTPUT_TOKENS = 5;
const SUMMARY_MARKER = "create a detailed summary";

function fixture() {
  const sessionId = createSessionId("context-composition");
  const store = createRecordingMessageStore();
  const createSession = vi.spyOn(store, "createSession");
  const requests: ModelRequest[] = [];
  const runtime = createTestAgentRuntime(
    sessionId,
    { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false } },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      modelFactory: createTestModelFactory({
        properties: { supportsMidConversationSystem: true },
        async generateText(request) {
          requests.push(request);
          const isCompact = JSON.stringify(request.messages.at(-1)?.content).includes(
            SUMMARY_MARKER,
          );
          return {
            finishReason: "stop",
            text: isCompact ? "<summary>older work</summary>" : "done",
            usage: {
              inputTokens: PROVIDER_INPUT_TOKENS,
              outputTokens: PROVIDER_OUTPUT_TOKENS,
              totalTokens: PROVIDER_INPUT_TOKENS + PROVIDER_OUTPUT_TOKENS,
            },
          };
        },
      }),
    },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  const conversationEntries = () => {
    const entries = internal.messageHistory.borrowReadOnlyRuntimeEntries();
    return entries.slice(countContextPrefixMessages(entries));
  };
  const reasons: ContextCompositionChangeReason[] = [];
  runtime.subscribeContextCompositionChanged(({ reason }) => reasons.push(reason));
  return { runtime, store, createSession, requests, conversationEntries, reasons };
}

const tokensOf = (
  composition: { categories: Array<{ id: string; tokens: number }> } | null,
  id: string,
) => composition?.categories.find((category) => category.id === id)?.tokens ?? 0;

describe("context composition runtime", () => {
  it("previews the first request of a draft without side effects", async () => {
    const f = fixture();

    const first = await f.runtime.getContextComposition();
    const second = await f.runtime.getContextComposition();

    expect(first?.phase).toBe("draft-preview");
    expect(tokensOf(first, "system_prompt")).toBeGreaterThan(0);
    expect(tokensOf(first, "system_tool_schemas")).toBeGreaterThan(0);
    // 首个请求前的提醒（日期、模型等）在预演里出现，但不落进历史。
    expect(tokensOf(first, "reminders")).toBeGreaterThan(0);
    expect(first!.estimatedTokens).toBe(
      first!.categories.reduce((sum, category) => sum + category.tokens, 0),
    );
    expect(first!.freeTokens).toBe(first!.model.contextWindow! - first!.estimatedTokens);
    expect(first).not.toHaveProperty("providerInputTokens");
    expect(first).not.toHaveProperty("providerContextTokens");
    expect(() =>
      contextCompositionSchema.parse({ ...first, sessionId: "s", revision: 0 }),
    ).not.toThrow();
    expect(second?.categories).toEqual(first?.categories);

    // 草稿仍是草稿：没有会话行、没有消息、对话历史为空、没有落库的公告。
    expect(f.runtime.isSessionPersisted()).toBe(false);
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.store.savedMessages).toEqual([]);
    expect(f.conversationEntries()).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("returns the request composition for the same model and a preview after a model change", async () => {
    const f = fixture();
    await f.runtime.executeTurn("hello");

    const sameModel = await f.runtime.getContextComposition();
    expect(sameModel?.phase).toBe("request");
    expect(sameModel?.providerInputTokens).toBe(PROVIDER_INPUT_TOKENS);
    // 与输入框用量圆环同一个值：input + 这次回复的 output（getModelUsageContextTokens）。
    expect(sameModel?.providerContextTokens).toBe(PROVIDER_INPUT_TOKENS + PROVIDER_OUTPUT_TOKENS);
    expect(tokensOf(sameModel, "messages")).toBeGreaterThan(0);
    expect(tokensOf(sameModel, "reminders")).toBeGreaterThan(0);

    const otherModel = await f.runtime.getContextComposition({
      modelSelection: { providerId: "test", modelId: "other-model" },
    });
    expect(otherModel?.phase).toBe("draft-preview");
    expect(otherModel?.model.modelId).toBe("other-model");
    expect(otherModel).not.toHaveProperty("providerInputTokens");
    expect(otherModel).not.toHaveProperty("providerContextTokens");

    // 换模型让请求组成作废：同一模型也改为预演，直到下一次请求。
    f.runtime.markContextCompositionChanged();
    expect((await f.runtime.getContextComposition())?.phase).toBe("draft-preview");
    await f.runtime.executeTurn("again");
    expect((await f.runtime.getContextComposition())?.phase).toBe("request");
  });

  it("returns null when no model selection is available", async () => {
    const f = fixture();
    f.runtime.setSessionModelSelection(undefined);
    expect(await f.runtime.getContextComposition()).toBeNull();
  });

  it("notifies listeners on every change trigger", async () => {
    const f = fixture();

    await f.runtime.executeTurn("hello");
    expect(f.reasons).toEqual(["request", "request_usage"]);
    // 首轮走 ensureContextInitialized；之后每轮开始按本轮模型重建前缀。
    f.reasons.length = 0;
    await f.runtime.executeTurn("again");
    expect(f.reasons).toEqual(["context_prefix", "request", "request_usage"]);

    f.reasons.length = 0;
    f.runtime.invalidateToolCache();
    expect(f.reasons).toEqual(["tools"]);

    f.reasons.length = 0;
    f.runtime.updateConfig({ language: "zh-CN" });
    expect(f.reasons).toEqual(["context_prefix"]);

    f.reasons.length = 0;
    f.runtime.markContextCompositionChanged();
    expect(f.reasons).toEqual(["model"]);

    f.reasons.length = 0;
    await f.runtime.executeTurn("/compact");
    expect(f.reasons).toContain("compact");
    // compact 之后请求组成作废，预演里能看到压缩摘要。
    const afterCompact = await f.runtime.getContextComposition();
    expect(afterCompact?.phase).toBe("draft-preview");
    expect(tokensOf(afterCompact, "compact_summary")).toBeGreaterThan(0);
  });

  it("stops notifying after unsubscribe", () => {
    const f = fixture();
    const listener = vi.fn();
    const unsubscribe = f.runtime.subscribeContextCompositionChanged(listener);
    f.runtime.invalidateToolCache();
    unsubscribe();
    f.runtime.invalidateToolCache();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
