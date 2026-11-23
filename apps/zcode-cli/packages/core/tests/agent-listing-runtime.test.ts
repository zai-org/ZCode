import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompactTrigger,
  ModelErrorCode,
  createPartId,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";
import { collectAgentListingAttachment } from "../src/subagent/listing.js";
import type { AgentDefinitionsSnapshot } from "../src/subagent/definitions.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";

const snapshot = (...names: string[]): AgentDefinitionsSnapshot => ({
  activeAgents: names.map((name) => ({
    name,
    description: `Description ${name}`,
    source: "user",
    systemPrompt: "private",
  })),
});
const initial = collectAgentListingAttachment({
  definitions: snapshot("A"),
  entries: [],
  tools: [{ name: "Agent" }],
})!;
const listingMessages = (request: ModelRequest) =>
  request.messages.filter(
    (m) =>
      typeof m.content === "string" &&
      /(?:Available agent types|New agent types|The following agent types)/u.test(m.content),
  );
const result = {
  finishReason: "stop" as const,
  text: "Summary of current work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};
let sessionId: ReturnType<typeof createSessionId>;
let store: ReturnType<typeof createRecordingMessageStore>;
let requests: ModelRequest[];
const definitions = vi.fn(() => snapshot("A"));
const respond = vi.fn<(request: ModelRequest) => Promise<ModelResult>>();
let runtime: ReturnType<typeof createTestAgentRuntime>;

function createRuntime(
  deps: Partial<AgentRuntimeDeps> = {},
  config: Partial<AgentRuntimeConfig> = {},
) {
  return createTestAgentRuntime(
    sessionId,
    { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false }, ...config },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      getAgentDefinitions: definitions,
      modelFactory: createTestModelFactory({
        properties: { supportsMidConversationSystem: true },
        generateText: async (request) => {
          requests.push(request);
          return respond(request);
        },
      }),
      ...deps,
    },
  );
}
const entries = () =>
  (runtime as unknown as AgentRuntimeInternal).messageHistory.toRuntimeEntries();
const listings = () => entries().filter((e) => e.metadata?.source === "agent_listing_delta");
// 历史里的条目带加入时间（静默提醒计时用），内容与新收集的公告相同。
const committedInitial = { ...initial, time: expect.any(Number) };

beforeEach(() => {
  sessionId = createSessionId();
  store = createRecordingMessageStore();
  requests = [];
  definitions.mockReset().mockImplementation(() => snapshot("A"));
  respond.mockReset().mockResolvedValue(result);
  runtime = createRuntime();
});

describe("runtime agent listing", () => {
  it.each([false, true])("refreshes listing once (compact=%s)", async (enabled) => {
    const registry = createToolRegistry();
    const projectContract = vi.fn<NonNullable<ToolEntry["resolveModelContract"]>>(() => ({}));
    registry.register({
      inputSchema: {},
      resolveModelContract: projectContract,
      metadata: {
        name: "UpdateDefinitions",
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        definitions.mockReturnValue(snapshot("B"));
        projectContract.mockClear();
        return "updated";
      },
    });
    runtime = createRuntime(
      { toolRegistry: registry, sessionStore: undefined },
      { compact: { enabled } },
    );
    respond.mockResolvedValueOnce({
      ...result,
      text: "",
      finishReason: "tool-calls",
      toolCalls: [{ id: "update", name: "UpdateDefinitions", input: {} }],
    });
    await runtime.executeTurn("update definitions");
    expect(projectContract.mock.calls.filter(([context]) => context.model)).toHaveLength(1);
    await runtime.executeTurn("continue");
    expect(requests).toHaveLength(3);
    expect(listingMessages(requests[0]!)).toHaveLength(1);
    const description = requests[0]!.tools?.find((tool) => tool.name === "Agent")?.description;
    expect(description).toContain("Available agent types are listed in <system-reminder>");
    expect(description).not.toContain("Description A");
    const notices = listingMessages(requests[1]!);
    expect(notices).toHaveLength(2);
    expect(notices[1]!.content).toContain("- B: Description B");
    expect(notices[1]!.content).toContain("no longer available:\n- A");
    expect(requests[1]!.messages.indexOf(notices[1]!)).toBeGreaterThan(
      requests[1]!.messages.findIndex((m) => m.role === "tool"),
    );
    expect(listingMessages(requests[2]!)).toEqual(notices);
  });

  it.each(["disabled", "denied"])("does not read definitions when Agent is %s", async (reason) => {
    definitions.mockImplementation(() => {
      throw new Error("must not read");
    });
    runtime = createRuntime({}, { subagents: { enabled: reason !== "disabled" } });
    await runtime.executeTurn("hello", undefined, {
      toolDisallowlist: reason === "denied" ? ["Agent"] : [],
    });
    expect(definitions).not.toHaveBeenCalled();
    expect(listingMessages(requests[0]!)).toEqual([]);
  });

  it.each([undefined, CompactTrigger.Manual, CompactTrigger.Reactive])(
    "persists and restores the same effective listing after compact=%s",
    async (trigger) => {
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      if (trigger) {
        const compacted = await (
          runtime as unknown as AgentRuntimeInternal
        ).compactActiveConversation(undefined, createRootTraceContext({ sessionId }), [], {
          trigger,
        });
        expect(compacted.outcome).toBe("compacted");
        expect(
          compacted.entries.filter((e) => e.metadata?.source === "agent_listing_delta"),
        ).toEqual([committedInitial]);
      }
      const listingParts = store.savedParts.filter(
        (part) => part.metadata?.runtimeMessage?.source === "agent_listing_delta",
      );
      expect(listingParts.at(-1)?.metadata.runtimeMessage.agentListingDelta).toEqual(
        initial.metadata.agentListingDelta,
      );
      const coldStore = createRecordingMessageStore();
      await coldStore.createSession(await store.getSession(sessionId));
      coldStore.savedMessages.push(...structuredClone(store.savedMessages));
      coldStore.savedParts.push(...structuredClone(store.savedParts));
      await runtime.executeTurn("compare");
      const live = listingMessages(requests.at(-1)!);
      const cold = createRuntime({ sessionStore: coldStore as never });
      await cold.resumeFromStore();
      await cold.executeTurn("compare");
      expect(listingMessages(requests.at(-1)!)).toEqual(live);
      expect(live).toHaveLength(1);
      expect(String(live[0]!.content)).toContain(initial.content);
    },
  );

  it.each([false, true])(
    "hydrates structured metadata from pure or mixed synthetic text, mixed=%s",
    async (mixed) => {
      await runtime.executeTurn("first");
      const notice = (await store.messages()).find((m) => m.info.source === "agent_listing_delta")!;
      if (mixed)
        notice.parts.push({
          ...notice.parts[0],
          id: createPartId(),
          synthetic: false,
          metadata: undefined,
          text: "user text",
        });
      const history = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({ history, messages: [notice] });
      expect(history.toRuntimeEntries().find((e) => e.kind === "attachment")).toEqual({
        ...initial,
        time: notice.info.time.created,
      });
      expect(
        collectAgentListingAttachment({
          definitions: snapshot("A"),
          entries: history.toRuntimeEntries(),
          tools: [{ name: "Agent" }],
        }),
      ).toBeUndefined();
      for (const delta of [undefined, { ...initial.metadata.agentListingDelta, addedTypes: [1] }]) {
        notice.parts[0]!.metadata.runtimeMessage.agentListingDelta = delta;
        const restored = new MessageHistoryImpl();
        await hydrateMessageHistoryFromSession({ history: restored, messages: [notice] });
        expect(
          collectAgentListingAttachment({
            definitions: snapshot("A"),
            entries: restored.borrowReadOnlyRuntimeEntries(),
            tools: [{ name: "Agent" }],
          }),
        ).toEqual(initial);
      }
    },
  );

  it("does not commit a failed listing write and can retry", async () => {
    const savePart = store.savePart;
    store.savePart = async (part) => {
      if (part.metadata?.source === "agent_listing_delta") throw new Error("listing write failed");
      await savePart(part);
    };
    await expect(runtime.executeTurn("first")).rejects.toThrow();
    expect(respond).not.toHaveBeenCalled();
    expect(listings()).toEqual([]);
    store.savePart = savePart;
    await runtime.executeTurn("retry");
    expect(listings()).toEqual([committedInitial]);
  });

  it("does not translate a definitions failure into removals", async () => {
    await runtime.executeTurn("first");
    definitions.mockImplementation(() => {
      throw new Error("definitions failed");
    });
    await expect(runtime.executeTurn("next")).rejects.toThrow();
    expect(listings()).toEqual([committedInitial]);
    expect(requests).toHaveLength(1);
  });

  it.each([CompactTrigger.Auto, CompactTrigger.Reactive])("hides Agent: %s", async (trigger) => {
    runtime = createRuntime({}, { compact: { enabled: true } });
    let ordinaryCount = 0;
    let compactCount = 0;
    definitions.mockImplementation(() => {
      throw new Error("Agent is hidden");
    });
    respond.mockImplementation(async (request) => {
      if (JSON.stringify(request.messages).includes("create a detailed summary")) {
        compactCount++;
        return result;
      }
      ordinaryCount++;
      if (trigger === CompactTrigger.Auto && ordinaryCount === 3)
        return {
          ...result,
          usage: { inputTokens: 1_000_000, outputTokens: 1, totalTokens: 1_000_001 },
        };
      if (trigger === CompactTrigger.Reactive && ordinaryCount === 4)
        throw Object.assign(new Error("provider context window exceeded"), {
          code: ModelErrorCode.ModelContextExceeded,
        });
      return result;
    });
    for (const prompt of ["first setup", "second setup", "third setup", "continue current work"])
      await runtime.executeTurn(prompt, undefined, { toolDisallowlist: ["Agent"] });
    expect(compactCount).toBe(1);
    expect(ordinaryCount).toBe(trigger === CompactTrigger.Auto ? 4 : 5);
    expect(definitions).not.toHaveBeenCalled();
    const ordinary = requests.filter(
      (r) => !JSON.stringify(r.messages).includes("create a detailed summary"),
    );
    expect(
      ordinary.every(
        (r) => listingMessages(r).length === 0 && !r.tools?.some((t) => t.name === "Agent"),
      ),
    ).toBe(true);
  });
});
