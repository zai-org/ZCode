import { createSessionId, modelMessageContentToText } from "@zcode/contracts";
import {
  type AgentRuntime,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
} from "../src/runtime.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { estimateCurrentModelInputTokens } from "../src/runtime/methods/compact.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";

export const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export function requestText(messages: readonly { content: unknown }[]): string {
  return messages.map((message) => modelMessageContentToText(message.content as never)).join("\n");
}

export function countContinuePrompts(messages: readonly { content: unknown }[]): number {
  return requestText(messages).split(OUTPUT_TOKEN_CONTINUE_PROMPT).length - 1;
}

/** 去掉缓存断点后的请求消息：断点随最新消息移动，不算内容。 */
export function withoutCacheControl<T extends object>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    const { cacheControl: _cacheControl, ...rest } = message as T & { cacheControl?: unknown };
    return rest as T;
  });
}

/** 冷恢复的 assistant 带空 toolCalls，live 没有；wire 上两者相同，比较前去掉空数组。 */
export function withoutEmptyToolCalls<T extends object>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    const { toolCalls, ...rest } = message as T & { toolCalls?: unknown[] };
    return (toolCalls?.length ? message : rest) as T;
  });
}

export function estimateCanonicalHistory(runtime: AgentRuntime): number {
  const projection = buildProviderRequestMessages({
    entries: (runtime as any).messageHistory.toRuntimeEntries(),
  });
  return estimateCurrentModelInputTokens(projection.messages, projection.sourceEntries);
}

export function outputLimitResult(input: {
  rawFinishReason?: string;
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}) {
  return {
    finishReason: input.rawFinishReason ? "other" : "length",
    providerMetadata: input.rawFinishReason
      ? { rawFinishReason: input.rawFinishReason }
      : undefined,
    text: input.text ?? "",
    usage: input.usage ?? {},
  };
}

export function stopResult(text: string, inputTokens: number, outputTokens = 1) {
  return {
    finishReason: "stop",
    text,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

export function createRuntime(input: {
  config?: AgentRuntimeConfig;
  deps?: Partial<AgentRuntimeDeps>;
  id: string;
  modelAdapter: unknown;
}): AgentRuntime {
  return createTestAgentRuntime(
    createSessionId(input.id),
    { titleGeneration: { enabled: false }, ...input.config },
    {
      eventStore: input.deps?.eventStore ?? createTestSessionEventStore(),
      ...input.deps,
      modelAdapter: input.modelAdapter,
    } as AgentRuntimeDeps,
  );
}

export function registerReadOnlyTool(
  registry: ReturnType<typeof createToolRegistry>,
  name: string,
  result: string,
): void {
  registry.register({
    inputSchema: {},
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler: async () => result,
  });
}

export function createRecordingMessageStore() {
  const savedMessages: any[] = [];
  const savedParts: any[] = [];
  const sessions = new Map<string, any>();
  return {
    savedMessages,
    savedParts,
    async createSession(input: any) {
      const session = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: input.time ?? { created: Date.now(), updated: Date.now() },
      };
      sessions.set(input.id, session);
      return session;
    },
    async updateSession(input: any) {
      const current = sessions.get(input.id) ?? input;
      const session = { ...current, ...input };
      sessions.set(input.id, session);
      return session;
    },
    async saveMessage(message: any) {
      const index = savedMessages.findIndex((saved) => saved.id === message.id);
      if (index >= 0) {
        savedMessages[index] = message;
        return;
      }
      savedMessages.push(message);
    },
    async removeMessage(input: { sessionID: string; messageID: string }) {
      const messageIndex = savedMessages.findIndex(
        (message) => message.sessionID === input.sessionID && message.id === input.messageID,
      );
      if (messageIndex >= 0) savedMessages.splice(messageIndex, 1);
      for (let index = savedParts.length - 1; index >= 0; index -= 1) {
        const part = savedParts[index];
        if (part.sessionID === input.sessionID && part.messageID === input.messageID) {
          savedParts.splice(index, 1);
        }
      }
    },
    async savePart(part: any) {
      const index = savedParts.findIndex((saved) => saved.id === part.id);
      if (index >= 0) {
        savedParts[index] = part;
        return;
      }
      savedParts.push(part);
    },
    async messages() {
      return savedMessages.map((info) => ({
        info,
        parts: savedParts.filter((part) => part.messageID === info.id),
      }));
    },
    async sessionEntries() {
      return [];
    },
    async readTodos() {
      return [];
    },
    async readTarget() {
      return null;
    },
    async getSession(sessionID: string) {
      return sessions.get(sessionID) ?? null;
    },
  };
}
