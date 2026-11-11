import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  zcodeProtocolMethods,
  zcodeMessagePartSchema,
  zcodeSessionCancelBackgroundTaskResultSchema,
  zcodeSessionCompactResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionEventSchema,
  zcodeSessionForkResultSchema,
  zcodeSessionGoalResultSchema,
  zcodeSessionListResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeProviderTestModelConnectivityResultSchema,
  zcodeProviderRefreshRegistryResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  type ZCodeProtocolMessage,
  type ZCodeProtocolNotification,
} from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  conversationTopicFrameSchema,
  reassembleTopicWireFrames,
  routedTopicFrameSchema,
  routedTopicWireFrameSchema,
  conversationTopic,
  sessionsIndexTopic,
  v4ConversationUsageResultSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationResyncResultSchema,
  v4UsageStatsResultSchema,
  workspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  createTraceId,
  type BackgroundTaskInfo,
  type MessageId,
  type MessagePart,
  type ModelId,
  type ModelProviderId,
  type MessageWithParts,
  type ProjectId,
  type SessionEvent,
  type SessionId,
  type LogContext,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type McpServerConfig,
  type ExecutionShellSelection,
} from "@zcode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type Provider,
} from "@zcode/provider";
import { buildRuntimeUserEntriesFromTurn } from "../../core/src/runtime/helpers/conversation.js";
import type { SendInputOptions } from "../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";
import { shouldCloseSessionForExpectedPersistence } from "../src/zcode-protocol/server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import {
  buildSessionSnapshot,
  mapMessageWithParts,
  mapSessionEvent,
  mapSessionEvents,
  mapSessionSettings,
} from "../src/zcode-protocol/mapper.js";
import { createWorkspaceZCodeApp } from "../src/zcode-protocol/workspace-model-runtime.js";
import { onSessionEvent } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
};

function currentOnlyModelOption() {
  return {
    ref: { providerId: "provider", modelId: "current-model" },
    label: "current-model",
    providerLabel: "provider",
    properties: {
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
    },
  } as const;
}

function createProtocolTestProviderRegistry(): ProviderRegistry {
  const modelConfig = new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      maxOutputTokens: {
        max: 32_000,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    }),
  });
  const provider: Provider = {
    providerId: "custom-openai",
    config: createApiKeyProviderConfig({
      apiFormat: "openai-chat-completions",
      apiKey: "sk-test",
      baseURL: "https://api.example.com/v1",
      models: ["agent-model", "backup-model"],
    }),
    models: [
      { modelId: "agent-model", config: modelConfig },
      { modelId: "backup-model", config: modelConfig },
    ],
  };
  return new ProviderRegistry([provider]);
}

describe("mapSessionSettings", () => {
  it("projects the current model default thought level separately from current", async () => {
    const app = createFakeApp(undefined, {
      getDefaultThoughtLevel: () => "max",
      getThoughtLevel: () => undefined,
      listThoughtLevels: () => ["high", "max"],
    });

    const settings = await mapSessionSettings(app);

    expect(settings.thoughtLevel).toMatchObject({
      available: [
        { value: "high", label: "high" },
        { value: "max", label: "max" },
      ],
      defaultLevel: "max",
      enabled: true,
    });
    expect(settings.thoughtLevel.current).toBeUndefined();
  });
});

describe("conditional session close", () => {
  it("only closes when the current persistence still matches the caller expectation", () => {
    expect(shouldCloseSessionForExpectedPersistence("deferred", "deferred")).toBe(true);
    expect(shouldCloseSessionForExpectedPersistence("immediate", "deferred")).toBe(false);
    expect(shouldCloseSessionForExpectedPersistence("immediate")).toBe(true);
  });
});

describe("ZCodeProtocolAgentServer", () => {
  it("所有 Entry 都不再接受旧 Workspace Provider 写协议", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    for (const [index, method] of [
      "workspace/updateProviderRegistry",
      "workspace/upsertModelProvider",
      "workspace/removeModelProvider",
    ].entries()) {
      await expect(
        server.handleMessage({
          id: `retired-provider-writer-${index}`,
          method,
          params: {},
        } as ZCodeProtocolMessage),
      ).resolves.toMatchObject({
        id: `retired-provider-writer-${index}`,
        error: { code: -32601 },
      });
    }
  });

  it("uses the Host managed policy for no-session Settings pretrust", async () => {
    const policyProvider = new InMemoryWorkspaceHookPolicyProvider({
      mode: "deny",
      reason: "managed",
      policyRevision: "test:deny:v1",
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
      workspaceHookPolicyProvider: policyProvider,
    });

    await expect(
      requestResult(server, {
        id: "workspace-hook-trust-denied",
        method: zcodeProtocolMethods.workspaceHookTrustGrant,
        params: {
          workspace,
          bundleDigest: "b".repeat(64),
          hookDeclarationDigest: "a".repeat(64),
        },
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_blocked_by_policy",
    });
  });

  it("injects the same Host managed policy provider into session Runtime", async () => {
    const policyProvider = new InMemoryWorkspaceHookPolicyProvider({
      mode: "user_decides",
      policyRevision: "test:user-decides:v1",
    });
    let createdOptions: ZCodeAppOptions | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdOptions = options;
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
      workspaceHookPolicyProvider: policyProvider,
    });

    await requestResult(server, {
      id: "session-with-shared-hook-policy",
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });

    expect(createdOptions?.workspaceHookPolicyProvider).toBe(policyProvider);
  });

  it("applies strict workspace interaction preferences without creating a session", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    const result = zcodeWorkspaceUpdateInteractionPreferencesResultSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
        params: {
          workspace,
          preferences: {
            askUserQuestionAutoResolutionEnabled: false,
          },
        },
      }),
    );

    expect(result).toEqual({
      workspace,
      askUserQuestionAutoResolutionEnabled: false,
      snoozedInteractionCount: 0,
    });
  });

  it("maps core tool events into typed ZCode session event payloads", () => {
    const mapped = zcodeSessionEventSchema.parse(
      mapSessionEvent({
        id: "evt_tool_1" as SessionEvent["id"],
        payload: {
          duration: 12,
          result: {
            content: "done",
            success: true,
          },
          toolCallId: "tool_1",
          toolName: "Edit",
        },
        sequenceNumber: 3,
        sessionId: "sess_1" as SessionId,
        timestamp: new Date(4),
        traceId: "trace_1" as SessionEvent["traceId"],
        type: SessionEventType.ToolCallResult,
      } satisfies SessionEvent),
    );

    expect(mapped.type).toBe("tool.updated");
    expect(mapped.payload.kind).toBe("result");
  });

  it("maps core permission denied events as denied protocol permission resolutions", () => {
    const mapped = zcodeSessionEventSchema.parse(
      mapSessionEvent({
        id: "evt_permission_denied" as SessionEvent["id"],
        payload: {
          toolCallId: "tool_write_denied",
          toolName: "Write",
          reason: "Plan mode only allows read-only, non-destructive tools",
          inputSummary: {
            file_path: "/tmp/denied.txt",
          },
        },
        sequenceNumber: 4,
        sessionId: "sess_1" as SessionId,
        timestamp: new Date(5),
        traceId: "trace_permission_denied" as SessionEvent["traceId"],
        type: SessionEventType.PermissionDenied,
      } satisfies SessionEvent),
    );

    expect(mapped.type).toBe("permission.resolved");
    expect(mapped.payload).toMatchObject({
      decision: "deny",
      reason: "Plan mode only allows read-only, non-destructive tools",
      toolCallId: "tool_write_denied",
      toolName: "Write",
    });
  });

  it("does not expose compact internal timeline text through the protocol", () => {
    const internalSummary =
      "This session is being continued from a previous conversation that was compacted.";
    const mapped = mapMessageWithParts({
      info: {
        id: "msg_compact" as MessageId,
        sessionID: "sess_1" as SessionId,
        role: "assistant",
        parentID: "msg_user" as MessageId,
        time: { created: 1, completed: 2 },
        agent: "zcode-agent",
        providerId: "glm" as ModelProviderId,
        modelId: "glm-4.6" as ModelId,
        cost: 0,
      },
      parts: [
        {
          id: "part_compact",
          sessionID: "sess_1",
          messageID: "msg_compact",
          type: "compaction",
          auto: true,
          summaryMessageId: "msg_summary",
          timelineText: internalSummary,
          timelineStatus: "completed",
          trigger: "auto",
        },
      ],
    } as unknown as MessageWithParts);

    expect(mapped.parts[0]).not.toHaveProperty("timelineText");
    expect(zcodeMessagePartSchema.parse(mapped.parts[0])).not.toHaveProperty("timelineText");
    expect(JSON.stringify(mapped)).not.toContain(internalSummary);
  });

  it("does not expose read-state metadata through protocol tool parts", () => {
    const fileContent = "secret file content that should stay internal";
    const mapped = mapMessageWithParts({
      info: {
        id: "msg_read" as MessageId,
        sessionID: "sess_1" as SessionId,
        role: "assistant",
        parentID: "msg_user" as MessageId,
        time: { created: 1, completed: 2 },
        agent: "zcode-agent",
        providerId: "glm" as ModelProviderId,
        modelId: "glm-4.6" as ModelId,
        cost: 0,
      },
      parts: [
        {
          callID: "tool_read_1",
          id: "part_read",
          messageID: "msg_read",
          sessionID: "sess_1",
          state: {
            input: { file_path: "/workspace/app/secret.txt" },
            metadata: {
              display: {
                additions: 0,
                deletions: 0,
                kind: "file_diff",
                structuredPatch: [],
              },
              readFileState: {
                content: fileContent,
                isPartialView: false,
                mtimeMs: 1,
                path: "/workspace/app/secret.txt",
                readAtMs: 2,
                revisionId: "rev-1",
                schemaVersion: 1,
                sizeBytes: fileContent.length,
                tool: "Read",
              },
              schemaVersion: 1,
            },
            output: "1\tsecret file content",
            status: "completed",
            time: { start: 1, end: 2 },
            title: "Read",
          },
          tool: "Read",
          type: "tool",
        },
      ],
    } as unknown as MessageWithParts);

    const part = zcodeMessagePartSchema.parse(mapped.parts[0]);
    if (part.type !== "tool" || part.state.status !== "completed") {
      throw new Error("expected completed tool part");
    }
    expect(part.state.metadata).toMatchObject({
      display: {
        kind: "file_diff",
      },
      schemaVersion: 1,
    });
    expect(part.state.metadata).not.toHaveProperty("readFileState");
    expect(JSON.stringify(mapped)).not.toContain(fileContent);
  });

  it("maps completed tool parts with missing metadata to an empty protocol metadata object", () => {
    const mapped = mapMessageWithParts({
      info: {
        id: "msg_tool_without_metadata" as MessageId,
        sessionID: "sess_1" as SessionId,
        role: "assistant",
        parentID: "msg_user" as MessageId,
        time: { created: 1, completed: 2 },
        agent: "zcode-agent",
        providerId: "glm" as ModelProviderId,
        modelId: "glm-4.6" as ModelId,
        cost: 0,
      },
      parts: [
        {
          callID: "tool_read_without_metadata",
          id: "part_read_without_metadata",
          messageID: "msg_tool_without_metadata",
          sessionID: "sess_1",
          state: {
            input: { file_path: "/workspace/app/plain.txt" },
            output: "1\tplain",
            status: "completed",
            time: { start: 1, end: 2 },
            title: "Read",
          },
          tool: "Read",
          type: "tool",
        },
      ],
    } as unknown as MessageWithParts);

    const part = zcodeMessagePartSchema.parse(mapped.parts[0]);
    if (part.type !== "tool" || part.state.status !== "completed") {
      throw new Error("expected completed tool part");
    }
    expect(part.state.metadata).toEqual({});
  });

  it("keeps model request protocol events compact", () => {
    const mapped = zcodeSessionEventSchema.parse(
      mapSessionEvent({
        id: "evt_model_request" as SessionEvent["id"],
        payload: {
          messages: [
            {
              role: "user",
              content: "large prompt body",
            },
          ],
          providerId: "provider",
          modelId: "model",
          toolCount: 3,
          iteration: 2,
        },
        sequenceNumber: 4,
        sessionId: "sess_1" as SessionId,
        timestamp: new Date(5),
        traceId: "trace_model_request" as SessionEvent["traceId"],
        type: SessionEventType.ModelRequest,
      } satisfies SessionEvent),
    );

    expect(mapped.type).toBe("session.updated");
    expect(mapped.payload).toMatchObject({
      messageCount: 1,
      providerId: "provider",
      modelId: "model",
      toolCount: 3,
      iteration: 2,
    });
    expect(mapped.payload).not.toHaveProperty("messages");
  });

  it("maps current-only session settings without enumerating the full model catalog", async () => {
    const app = createFakeApp(undefined, {
      getModel: () => "provider/current-model",
      getCurrentModelOption: () => currentOnlyModelOption(),
      getThoughtLevel: () => undefined,
      listModels: () => {
        throw new Error("listModels should not run for current-only settings");
      },
      listThoughtLevels: () => [],
    });
    vi.spyOn(app.runtime, "getSessionModelSelection").mockReturnValue({
      providerId: "provider",
      modelId: "current-model",
    });

    const settings = await mapSessionSettings(app, {
      modelAvailability: "current",
    });

    expect(settings.model.available).toEqual([
      expect.objectContaining({
        label: "current-model",
        providerLabel: "provider",
        ref: {
          modelId: "current-model",
          providerId: "provider",
        },
        properties: currentOnlyModelOption().properties,
      }),
    ]);
    expect(settings.model.current).toEqual({
      modelId: "current-model",
      providerId: "provider",
    });
  });

  it("preserves current context window in current-only session snapshots without enumerating models", async () => {
    const sessionId = "sess_current_context" as SessionId;
    const app = createFakeApp(
      { sessionId },
      {
        getModel: () => "provider/current-model",
        getCurrentModelOption: () => currentOnlyModelOption(),
        getThoughtLevel: () => undefined,
        listModels: () => {
          throw new Error("listModels should not run for current-only snapshots");
        },
        listThoughtLevels: () => [],
        runtime: {
          getSessionModelSelection: () => ({ providerId: "provider", modelId: "current-model" }),
          getProjection: async () =>
            ({
              activeToolCalls: [],
              backgroundTasks: [],
              contextUsed: 0,
              contextWindow: 256_000,
              createdAt: new Date(1),
              id: sessionId,
              mode: "build",
              pendingPermissions: [],
              pendingSteerInputs: [],
              status: "idle",
              streamingToolLedger: [],
              target: null,
              totalTokenCount: 0,
              turnCount: 0,
              updatedAt: new Date(1),
            }) as never,
          getActiveTurnInfo: () => undefined,
          subscribeEvents: () => () => {},
        } as never,
      },
    );

    const snapshot = await buildSessionSnapshot({
      app,
      eventSeq: 0,
      messages: [],
      modelAvailability: "current",
      stateRevision: 1,
      workspace,
    });

    expect(snapshot.settings.model.available).toEqual([
      expect.objectContaining({
        contextWindow: 256_000,
        ref: {
          modelId: "current-model",
          providerId: "provider",
        },
      }),
    ]);
  });

  it("fills the goal first-round title past a SessionStart reminder stored before the prompt", async () => {
    // SessionStart hook 的上下文写在首条 prompt 之前；补首轮标题时要跳过这条隐藏提醒。
    const sessionId = "sess_goal_title_reminder" as SessionId;
    const objective = "Ship the goal title fallback";
    const app = createFakeApp(
      { sessionId },
      {
        runtime: {
          getSessionModelSelection: () => undefined,
          getProjection: async () =>
            ({
              activeToolCalls: [],
              backgroundTasks: [],
              contextUsed: 0,
              contextWindow: 128_000,
              createdAt: new Date(1),
              id: sessionId,
              mode: "build",
              pendingPermissions: [],
              pendingSteerInputs: [],
              status: "idle",
              streamingToolLedger: [],
              target: null,
              totalTokenCount: 0,
              turnCount: 0,
              updatedAt: new Date(1),
            }) as never,
          getActiveTurnInfo: () => undefined,
          subscribeEvents: () => () => {},
        } as never,
      },
    );
    const userRow = (id: string, created: number, text: string, hidden: boolean) =>
      ({
        info: {
          id,
          sessionID: sessionId,
          role: "user",
          time: { created },
          ...(hidden
            ? {
                synthetic: true,
                visibility: "model-only",
                semantics: {
                  origin: "agent_runtime",
                  kind: "system_reminder",
                  source: "hook_context",
                  uiVisibility: "hidden",
                  providerVisibility: "visible",
                  transcriptVisibility: "hidden",
                },
              }
            : {}),
        },
        parts: [{ id: `${id}-part`, sessionID: sessionId, messageID: id, type: "text", text }],
      }) as never;

    const snapshot = await buildSessionSnapshot({
      app,
      eventSeq: 0,
      messages: [
        userRow("msg_reminder", 1_000, "SessionStart hook additional context: ...", true),
        userRow("msg_prompt", 1_010, objective, false),
      ],
      session: { id: sessionId, title: "Goal title", time: { created: 1, updated: 1 } } as never,
      stateRevision: 1,
      target: {
        sessionID: sessionId,
        targetID: "target-title",
        objective,
        summaryTitle: null,
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: 1_020, updated: 1_020 },
      },
      workspace,
    });

    expect(snapshot.projection.target?.summaryTitle).toBe("Goal title");
  });

  it("preserves latest main turn context usage breakdown in session snapshots", async () => {
    const sessionId = "sess_context_breakdown" as SessionId;
    const app = createFakeApp(
      { sessionId },
      {
        runtime: {
          getSessionModelSelection: () => undefined,
          getProjection: async () =>
            ({
              activeToolCalls: [],
              backgroundTasks: [],
              contextUsed: 26_347,
              contextWindow: 1_000_000,
              createdAt: new Date(1),
              id: sessionId,
              mode: "build",
              pendingPermissions: [],
              pendingSteerInputs: [],
              status: "idle",
              streamingToolLedger: [],
              target: null,
              totalTokenCount: 0,
              turnCount: 0,
              updatedAt: new Date(1),
            }) as never,
          getActiveTurnInfo: () => undefined,
          subscribeEvents: () => () => {},
        } as never,
      },
    );
    const breakdown = [
      { source: "system_tool_schemas" as const, chars: 89_047 },
      { source: "mcp_tool_schemas" as const, chars: 43_644 },
      { source: "messages" as const, chars: 9_104 },
    ];

    const snapshot = await buildSessionSnapshot({
      app,
      eventSeq: 4,
      messages: [],
      persistedContextUsageBreakdownEvents: [
        {
          id: "event_context_breakdown",
          sessionId,
          sequenceNumber: 4,
          timestamp: new Date(4),
          traceId: "trace_context_breakdown" as never,
          type: SessionEventType.ModelComplete,
          payload: {
            content: "",
            contextUsageBreakdown: breakdown,
            contextWindow: 1_000_000,
            querySource: "main_turn",
            stopReason: "stop",
            usage: {
              inputTokens: 25_913,
              outputTokens: 434,
              totalTokens: 26_347,
            },
          },
        } as SessionEvent,
      ],
      stateRevision: 1,
      workspace,
    });

    expect(snapshot.runtime.contextUsage).toEqual({
      used: 26_347,
      size: 1_000_000,
      cost: null,
      breakdown,
    });
  });

  it("does not expose the last projected turn as an active runtime turn", async () => {
    const sessionId = "sess_completed_projection_turn" as SessionId;
    const completedTurnId = "turn_completed_projection";
    const app = createFakeApp(
      { sessionId },
      {
        runtime: {
          getSessionModelSelection: () => undefined,
          getProjection: async () =>
            ({
              activeToolCalls: [],
              backgroundTasks: [],
              contextUsed: 0,
              contextWindow: 128_000,
              createdAt: new Date(1),
              currentTurnId: completedTurnId,
              id: sessionId,
              mode: "build",
              pendingPermissions: [],
              pendingSteerInputs: [],
              status: "idle",
              streamingToolLedger: [],
              target: null,
              totalTokenCount: 0,
              turnCount: 1,
              updatedAt: new Date(2),
            }) as never,
          getActiveTurnInfo: () => undefined,
          subscribeEvents: () => () => {},
        } as never,
      },
    );

    const snapshot = await buildSessionSnapshot({
      app,
      eventSeq: 4,
      messages: [],
      stateRevision: 1,
      workspace,
    });

    expect(snapshot.projection.currentTurnId).toBe(completedTurnId);
    expect(snapshot.runtime.activeTurnId).toBeUndefined();
    expect(snapshot.runtime.activeTurnKind).toBeUndefined();
  });

  it("maps active turn runtime fields while a session active turn exists", async () => {
    const sessionId = "sess_active_runtime_turn" as SessionId;
    const activeTurnId = "turn_active_runtime";
    const app = createFakeApp(
      { sessionId },
      {
        runtime: {
          getSessionModelSelection: () => undefined,
          getProjection: async () =>
            ({
              activeToolCalls: [],
              backgroundTasks: [],
              contextUsed: 0,
              contextWindow: 128_000,
              createdAt: new Date(1),
              currentTurnId: activeTurnId,
              id: sessionId,
              mode: "build",
              pendingPermissions: [],
              pendingSteerInputs: [],
              status: "running",
              streamingToolLedger: [],
              target: null,
              totalTokenCount: 0,
              turnCount: 1,
              updatedAt: new Date(2),
            }) as never,
          getActiveTurnInfo: () =>
            ({
              kind: "regular",
              queueLength: 0,
              steerable: true,
              turnId: activeTurnId,
            }) as never,
          subscribeEvents: () => () => {},
        } as never,
      },
    );

    const snapshot = await buildSessionSnapshot({
      app,
      eventSeq: 4,
      messages: [],
      stateRevision: 1,
      workspace,
    });

    expect(snapshot.runtime.activeTurnId).toBe(activeTurnId);
    expect(snapshot.runtime.activeTurnKind).toBe("regular");
  });

  it("hydrates image artifact file parts when building session snapshots", async () => {
    const sessionId = "sess_image_artifact" as SessionId;
    const artifactUri = "zcode-artifact://sess_image_artifact/tool-result-image";
    const app = createFakeApp(
      { sessionId },
      {
        readToolResultArtifact: async (uri) => ({
          bytes: 30,
          content: "data:image/png;base64,aW1hZ2U=",
          contentType: "text/plain",
          uri,
        }),
      },
    );
    const messages = [
      {
        info: {
          id: "msg_user_image" as MessageId,
          sessionID: sessionId,
          role: "user",
          time: { created: 1 },
          agent: "zcode-agent",
          modelSelection: {
            providerId: "glm" as ModelProviderId,
            modelId: "glm-4.6" as ModelId,
          },
        },
        parts: [
          {
            id: "part_user_text" as never,
            sessionID: sessionId,
            messageID: "msg_user_image" as MessageId,
            text: "图片里是啥",
            type: "text",
          },
          {
            id: "part_user_image" as never,
            sessionID: sessionId,
            messageID: "msg_user_image" as MessageId,
            filename: "screen.png",
            metadata: {
              artifactUri,
              sizeBytes: 30,
              storageKind: "artifact",
            },
            mime: "image/png",
            type: "file",
            url: artifactUri,
          },
        ],
      },
    ] as unknown as MessageWithParts[];

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await buildSessionSnapshot({
        app,
        eventSeq: 0,
        messages,
        stateRevision: 1,
        workspace,
      }),
    );

    expect(snapshot.messages[0]?.parts[1]).toMatchObject({
      type: "file",
      url: "data:image/png;base64,aW1hZ2U=",
    });
  });

  it("uses fallback record timestamps before projection timestamps in session snapshots", async () => {
    const app = createFakeApp();
    const snapshot = await buildSessionSnapshot({
      app,
      eventSeq: 0,
      fallbackCreatedAt: 8_000,
      fallbackUpdatedAt: 9_000,
      messages: [],
      stateRevision: 1,
      workspace,
    });

    expect(snapshot.session.createdAt).toBe(8_000);
    expect(snapshot.session.updatedAt).toBe(9_000);
  });

  it("emits Computer Use lifecycle metadata without a legacy deliveryKind", () => {
    const ingest = vi.fn();
    const notify = vi.fn<(notification: ZCodeProtocolNotification) => void>();
    const record = {
      app: { sessionId: "sess_cua_sideband" },
      updatedAt: 1_700,
      workspace,
    } as unknown as Parameters<typeof onSessionEvent>[1];
    const context = {
      notify,
      v4Gateway: { ingest },
    } as unknown as Parameters<typeof onSessionEvent>[0];
    const event = (
      type: SessionEvent["type"],
      sequenceNumber: number,
      payload: unknown,
      turnId?: string,
    ): SessionEvent => ({
      id: `evt-cua-${sequenceNumber}` as SessionEvent["id"],
      payload,
      sequenceNumber,
      sessionId: "sess_cua_sideband" as SessionId,
      timestamp: new Date(1_700 + sequenceNumber),
      traceId: "trace_cua_sideband" as SessionEvent["traceId"],
      ...(turnId ? { turnId: turnId as SessionEvent["turnId"] } : {}),
      type,
    });
    const events = [
      event(SessionEventType.TurnStarted, 1, { turnNumber: 1, input: "control" }, "turn-1"),
      event(
        SessionEventType.ToolCallScheduled,
        2,
        {
          toolCallId: "call-1",
          toolName: "mcp__computer-use__left_click",
          input: { target: "Calculator" },
        },
        "turn-1",
      ),
      event(
        SessionEventType.ToolCallStarted,
        3,
        { toolCallId: "call-1", startedAt: new Date(1_703) },
        "turn-1",
      ),
      event(
        SessionEventType.ToolCallResult,
        4,
        { toolCallId: "call-1", result: { secret: "must-not-pass" }, duration: 1 },
        "turn-1",
      ),
      event(SessionEventType.TurnComplete, 5, { resultType: "success" }, "turn-1"),
      event(SessionEventType.SessionEnded, 6, { reason: "closed" }),
    ];

    for (const sessionEvent of events) onSessionEvent(context, record, sessionEvent);

    expect(notify.mock.calls.map(([notification]) => notification.method)).toEqual(
      Array.from({ length: 5 }, () => "computer-use/operation-event"),
    );
    const params = notify.mock.calls.map(
      ([notification]) => notification.params as Record<string, unknown>,
    );
    expect(params.map((value) => value.kind)).toEqual([
      "turn-started",
      "tool-scheduled",
      "tool-started",
      "turn-completed",
      "session-closed",
    ]);
    expect(params[1]).not.toHaveProperty("input");
    expect(params[2]).not.toHaveProperty("result");
    expect(ingest).toHaveBeenCalledTimes(events.length);
  });

  it("keeps v4 ingestion alive when the Computer Use lifecycle sideband throws", () => {
    const ingest = vi.fn();
    const warn = vi.fn();
    const record = {
      app: { sessionId: "sess_cua_sideband_failure" },
      updatedAt: 1_700,
      workspace,
    } as unknown as Parameters<typeof onSessionEvent>[1];
    const context = {
      logger: { warn },
      notify: vi.fn(() => {
        throw new Error("transport closed");
      }),
      v4Gateway: { ingest },
    } as unknown as Parameters<typeof onSessionEvent>[0];
    const event = {
      id: "evt-cua-sideband-failure" as SessionEvent["id"],
      payload: { turnNumber: 1, input: "control" },
      sequenceNumber: 1,
      sessionId: "sess_cua_sideband_failure" as SessionId,
      timestamp: new Date(1_800),
      traceId: "trace_cua_sideband_failure" as SessionEvent["traceId"],
      turnId: "turn-1" as SessionEvent["turnId"],
      type: SessionEventType.TurnStarted,
    } satisfies SessionEvent;

    expect(() => onSessionEvent(context, record, event)).not.toThrow();
    expect(ingest).toHaveBeenCalledWith("sess_cua_sideband_failure", event);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("promotes a deferred record to immediate once the runtime reports the session persisted", () => {
    // 2026-09-14 实机：中枢直接启动的会话由 runtime 落行（controlOnly 启动轮，没有首发），record 一直
    // 是 deferred，sessions-index 视其为 draft 而跳过——侧栏永远不出现。record.persistence 是 runtime
    // 事实的镜像，在事件入口对齐一次即覆盖所有持久化路径。
    const ingest = vi.fn();
    let persisted = false;
    const record = {
      app: { sessionId: "sess_launch", runtime: { isSessionPersisted: () => persisted } },
      persistence: "deferred",
      updatedAt: 1_700,
      workspace,
    } as unknown as Parameters<typeof onSessionEvent>[1];
    const context = {
      v4Gateway: { ingest },
    } as unknown as Parameters<typeof onSessionEvent>[0];
    const event = {
      id: "evt_launch_title" as SessionEvent["id"],
      payload: { previousTitle: "", source: "first_input", title: "deep-research" },
      sequenceNumber: 1,
      sessionId: "sess_launch" as SessionId,
      timestamp: new Date(1_800),
      traceId: "trace_launch" as SessionEvent["traceId"],
      type: SessionEventType.SessionTitleUpdated,
    } satisfies SessionEvent;

    // runtime 尚未持久化：仍是 draft。
    onSessionEvent(context, record, event);
    expect(record.persistence).toBe("deferred");

    // runtime 持久化之后的第一条事件：离开 draft，且对齐发生在 ingest 之前（同一条事件就能进列表）。
    persisted = true;
    ingest.mockImplementation(() => {
      expect(record.persistence).toBe("immediate");
    });
    onSessionEvent(context, record, event);
    expect(record.persistence).toBe("immediate");
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("does not bump record updatedAt for session title metadata events", () => {
    const ingest = vi.fn();
    const record = {
      app: { sessionId: "sess_title_sort" },
      updatedAt: 1_700,
      workspace,
    } as unknown as Parameters<typeof onSessionEvent>[1];
    const context = {
      v4Gateway: { ingest },
    } as unknown as Parameters<typeof onSessionEvent>[0];
    const event = {
      id: "evt_title_sort" as SessionEvent["id"],
      payload: {
        previousTitle: "",
        source: "generated",
        title: "Restored title",
      },
      sequenceNumber: 1,
      sessionId: "sess_title_sort" as SessionId,
      timestamp: new Date(1_800),
      traceId: "trace_title_sort" as SessionEvent["traceId"],
      type: SessionEventType.SessionTitleUpdated,
    } satisfies SessionEvent;

    onSessionEvent(context, record, event);

    expect(record.updatedAt).toBe(1_700);
    expect(ingest).toHaveBeenCalledWith("sess_title_sort", event);
  });

  it("routes raw child events to the child publisher without touching the parent record", () => {
    const ingest = vi.fn();
    const record = {
      app: { sessionId: "sess_parent" },
      updatedAt: 1_700,
      workspace,
    } as unknown as Parameters<typeof onSessionEvent>[1];
    const context = {
      v4Gateway: { ingestDetachedLiveSession: ingest },
    } as unknown as Parameters<typeof onSessionEvent>[0];
    const event = {
      id: "evt_child_delta" as SessionEvent["id"],
      payload: { kind: "text_delta", delta: "child", done: false },
      sequenceNumber: 2,
      sessionId: "sess_child" as SessionId,
      timestamp: new Date(1_800),
      traceId: "trace_child_delta" as SessionEvent["traceId"],
      type: SessionEventType.ModelStreaming,
    } satisfies SessionEvent;

    onSessionEvent(context, record, event);

    expect(record.updatedAt).toBe(1_700);
    expect(ingest).toHaveBeenCalledTimes(1);
    // 保留 source detached child publisher 生命周期：路由 child 时同时登记 parent 归属。
    expect(ingest).toHaveBeenCalledWith("sess_child", event, "sess_parent");
  });

  it("exposes model streaming tool input previews to the app protocol", () => {
    const events = mapSessionEvents(
      [
        {
          id: "evt_tool_input_delta" as SessionEvent["id"],
          payload: {
            kind: "tool_input_delta",
            delta: '{"file_path":"README.md"}',
            done: false,
          },
          sequenceNumber: 5,
          sessionId: "sess_1" as SessionId,
          timestamp: new Date(6),
          traceId: "trace_tool_input_delta" as SessionEvent["traceId"],
          type: SessionEventType.ModelStreaming,
        },
        {
          id: "evt_text_delta" as SessionEvent["id"],
          payload: {
            kind: "text_delta",
            delta: "hello",
            done: false,
          },
          sequenceNumber: 6,
          sessionId: "sess_1" as SessionId,
          timestamp: new Date(7),
          traceId: "trace_text_delta" as SessionEvent["traceId"],
          type: SessionEventType.ModelStreaming,
        },
        {
          id: "evt_tool_scheduled" as SessionEvent["id"],
          payload: {
            input: { file_path: "README.md" },
            toolCallId: "call_1",
            toolName: "Read",
          },
          sequenceNumber: 7,
          sessionId: "sess_1" as SessionId,
          timestamp: new Date(8),
          traceId: "trace_tool_scheduled" as SessionEvent["traceId"],
          type: SessionEventType.ToolCallScheduled,
        },
      ] satisfies SessionEvent[],
      "desktop-continuous",
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      eventId: "evt_tool_input_delta",
      payload: { kind: "tool_input_delta", delta: '{"file_path":"README.md"}' },
      type: "model.streaming",
    });
    expect(events[1].eventId).toBe("evt_text_delta");
    expect(events[1].payload).toMatchObject({ kind: "text_delta", delta: "hello" });
    expect(events[2]).toMatchObject({
      eventId: "evt_tool_scheduled",
      payload: {
        input: { file_path: "README.md" },
        kind: "scheduled",
        toolCallId: "call_1",
        toolName: "Read",
      },
      type: "tool.updated",
    });
  });

  it("does not expose internal streaming tool ledger updates to the app protocol", () => {
    const events = mapSessionEvents([
      {
        id: "evt_tool_ledger" as SessionEvent["id"],
        payload: {
          input: { content: "large generated file" },
          status: "tool_started",
          toolCallId: "call_1",
          toolName: "Write",
        },
        sequenceNumber: 8,
        sessionId: "sess_1" as SessionId,
        timestamp: new Date(9),
        traceId: "trace_tool_ledger" as SessionEvent["traceId"],
        type: SessionEventType.StreamingToolLedgerUpdated,
      },
    ]);

    expect(events).toEqual([]);
  });

  it("logs snapshot phase timings for session create diagnostics", async () => {
    const logs: RecordedLog[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      loggerFactory: createProtocolTestLoggerFactory(logs),
      version: "test-version",
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });

    const completed = logs.find(
      (log) => log.context.event === "zcode_protocol.session_create.completed",
    );
    expect(completed?.context.snapshotPhaseDurationsMs).toMatchObject({
      buildSnapshot: expect.any(Number),
      eventSeq: expect.any(Number),
      persistedMessages: expect.any(Number),
      persistedSession: expect.any(Number),
      rewindEvents: expect.any(Number),
      target: expect.any(Number),
      todos: expect.any(Number),
    });
  });

  // M5 ③-3：usage query 的 v4 名字空间分派（L2）。数据访问层与旧 usage/stats、
  // session/usage 共用（usage store 聚合），这里锁定 v4 方法名可达且结果过 v4 schema。
  it("serves v4/usage/stats through the usage data access layer", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    const result = v4UsageStatsResultSchema.parse(
      await requestResult(server, {
        id: 1,
        method: V4_METHODS.usageStats,
        params: { range: "7d", timeZone: "UTC" },
      }),
    );

    // 无 usage store 的兜底路径：返回空快照而非抛错（与旧 op 语义一致）。
    expect(result.range).toBe("7d");
    expect(result.timeZone).toBe("UTC");
    expect(result.source).toBe("agent-db");
    expect(result.models).toEqual([]);
  });

  it("serves v4/conversation/usage keyed by sessionId", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    const result = v4ConversationUsageResultSchema.parse(
      await requestResult(server, {
        id: 1,
        method: V4_METHODS.conversationUsage,
        params: { sessionId: "sess_v4_usage" },
      }),
    );

    expect(result.sessionId).toBe("sess_v4_usage");
    expect(result.totalTokens).toBe(0);
    expect(result.inputBaselineBySource).toEqual({});
  });

  it("三类 v4 subscribe response 只含 ACK，并把 initial 放入 request-scoped outbox", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: "create-for-v4-outbox",
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const topics = [
      conversationTopic(created.session.sessionId),
      sessionsIndexTopic(workspace.workspaceKey),
      workspaceConfigTopic(workspace.workspaceKey),
    ];

    for (const [index, topic] of topics.entries()) {
      const id = `v4-subscribe-${index}`;
      const response = await server.handleMessage({
        id,
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic,
          connectionId: `connection-${index}`,
          clientMode: "desktop-continuous",
        },
      });
      // staging 已在 ACK 内加入可选 openTiming 诊断；这里守住 response 仍只承载 ACK，
      // 初始 frame 仍必须进入 request-scoped outbox，不把诊断字段误判成 initial payload。
      expect(response).toMatchObject({
        id,
        result: {
          ack: {
            subscriptionId: expect.any(String),
            mode: "snapshot",
            logEpoch: expect.any(String),
            // 会话主题的 ACK 额外携带 session open 计时遥测（staging 的 ARMS 面）；
            // 列表/配置主题没有会话可计时，不带这个键。
            ...(index === 0 ? { openTiming: expect.any(Object) } : {}),
          },
        },
      });
      const ack = (response as { result: { ack: { subscriptionId: string } } }).result.ack;
      const queued = server.takePostResponseMessages(id);
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.every((message) => message.method === V4_NOTIFICATIONS.conversationFrame)).toBe(
        true,
      );
      const assembled = reassembleTopicWireFrames(
        queued.map((message) => routedTopicWireFrameSchema.parse(message.params)),
        routedTopicFrameSchema,
      );
      expect(assembled).toMatchObject({
        kind: "complete",
        frame: {
          topic,
          subscriptionId: ack.subscriptionId,
          payload: { kind: "snapshot" },
        },
      });
      expect(server.takePostResponseMessages(id)).toEqual([]);
    }
  });

  it("routes strict v4 connection flow control to the gateway", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    expect(
      await server.handleMessage({
        id: "flow-saturated",
        method: V4_METHODS.connectionFlow,
        params: { connectionId: "mobile-flow", state: "saturated" },
      }),
    ).toEqual({ id: "flow-saturated", result: {} });

    const invalid = await server.handleMessage({
      id: "flow-invalid",
      method: V4_METHODS.connectionFlow,
      params: { connectionId: "mobile-flow", state: "forged" },
    });
    expect(invalid).toMatchObject({ id: "flow-invalid", error: expect.any(Object) });
  });

  it("routes attachment begin/chunk/commit/abort without a full-data RPC", async () => {
    const writePromptAttachment = vi.fn(async () => ({ ref: "zcode-artifact://upload/server" }));
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { writePromptAttachment }),
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: "attachment-session",
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const bytes = Buffer.from("server attachment");
    const common = {
      connectionId: "attachment-connection",
      sessionId: created.session.sessionId,
      uploadId: "upload-server",
    };
    await expect(
      requestResult(server, {
        id: "attachment-begin",
        method: V4_METHODS.attachmentBegin,
        params: {
          ...common,
          fileName: "server.txt",
          mime: "text/plain",
          totalBytes: bytes.byteLength,
          totalChunks: 1,
          checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        },
      }),
    ).resolves.toMatchObject({ state: "staging", nextChunkIndex: 0 });
    await requestResult(server, {
      id: "attachment-chunk",
      method: V4_METHODS.attachmentChunk,
      params: { ...common, chunkIndex: 0, dataBase64: bytes.toString("base64") },
    });
    await expect(
      requestResult(server, {
        id: "attachment-commit",
        method: V4_METHODS.attachmentCommit,
        params: common,
      }),
    ).resolves.toEqual({ ref: "zcode-artifact://upload/server" });
    await expect(
      requestResult(server, {
        id: "attachment-commit-retry",
        method: V4_METHODS.attachmentCommit,
        params: common,
      }),
    ).resolves.toEqual({ ref: "zcode-artifact://upload/server" });
    await expect(
      requestResult(server, {
        id: "attachment-abort",
        method: V4_METHODS.attachmentAbort,
        params: common,
      }),
    ).resolves.toEqual({});
    expect(writePromptAttachment).toHaveBeenCalledTimes(1);
    expect(writePromptAttachment).toHaveBeenCalledWith({
      fileName: "server.txt",
      mime: "text/plain",
      bytes: new Uint8Array(bytes),
    });
    await expect(
      server.handleMessage({
        id: "legacy-full-data-put",
        method: "v4/attachment/put" as never,
        params: {
          sessionId: created.session.sessionId,
          fileName: "forbidden.txt",
          mime: "text/plain",
          dataBase64: bytes.toString("base64"),
        },
      }),
    ).resolves.toMatchObject({
      id: "legacy-full-data-put",
      error: { code: -32601 },
    });
  });

  it("并发 subscribe request id 的 post-response outbox 不串线", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const topics = [
      sessionsIndexTopic(workspace.workspaceKey),
      workspaceConfigTopic(workspace.workspaceKey),
    ];

    await Promise.all(
      topics.map((topic, index) =>
        server.handleMessage({
          id: `parallel-${index}`,
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic,
            connectionId: `parallel-connection-${index}`,
            clientMode: "desktop-continuous",
          },
        }),
      ),
    );

    expect(server.takePostResponseMessages("parallel-1")[0]).toMatchObject({
      params: { topic: topics[1] },
    });
    expect(server.takePostResponseMessages("parallel-0")[0]).toMatchObject({
      params: { topic: topics[0] },
    });
  });

  it("aligned resume 经真实 server/outbox/NDJSON 只写一行 ACK response", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: "create-for-aligned-resume",
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const topic = conversationTopic(created.session.sessionId);
    const initialResponse = await server.handleMessage({
      id: "initial-subscribe",
      method: V4_METHODS.conversationSubscribe,
      params: {
        topic,
        connectionId: "aligned-connection",
        clientMode: "desktop-continuous",
      },
    });
    if (!initialResponse || !("result" in initialResponse)) {
      throw new Error("Expected initial subscribe response");
    }
    const initialResult = v4ConversationSubscribeResultSchema.parse(initialResponse.result);
    const initialMessages = server.takePostResponseMessages("initial-subscribe");
    if (initialMessages.length === 0) {
      throw new Error("Expected initial subscribe outbox frame");
    }
    const initialAssembly = reassembleTopicWireFrames(
      initialMessages.map((message) => routedTopicWireFrameSchema.parse(message.params)),
      conversationTopicFrameSchema,
    );
    if (initialAssembly.kind !== "complete") {
      throw new Error("Expected complete initial subscribe frame");
    }
    const initialFrame = initialAssembly.frame;

    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    connection.start();
    input.end(
      `${JSON.stringify({
        id: "aligned-resume",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic,
          connectionId: "aligned-connection",
          clientMode: "desktop-continuous",
          base: { logEpoch: initialResult.ack.logEpoch, seq: initialFrame.toSeq },
        },
      })}\n`,
    );
    await connection.waitForClose();

    const lines = written.trim().split("\n");
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0]!) as { result: unknown };
    expect(v4ConversationSubscribeResultSchema.parse(response.result).ack.mode).toBe("resume");
    expect(server.takePostResponseMessages("aligned-resume")).toEqual([]);
  });

  it("same-sub resync 经真实 server/NDJSON 严格先 ACK 再 physical recovery", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: "create-for-resync-order",
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const topic = conversationTopic(created.session.sessionId);
    const subscribedResponse = await server.handleMessage({
      id: "subscribe-before-resync",
      method: V4_METHODS.conversationSubscribe,
      params: {
        topic,
        connectionId: "resync-connection",
        clientMode: "web-remote-replayable",
      },
    });
    if (!subscribedResponse || !("result" in subscribedResponse)) {
      throw new Error("Expected subscribe response");
    }
    const subscribed = v4ConversationSubscribeResultSchema.parse(subscribedResponse.result);
    // 初始 batch admission 后才开始 same-sub recovery。
    expect(server.takePostResponseMessages("subscribe-before-resync").length).toBeGreaterThan(0);

    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    connection.start();
    input.end(
      `${JSON.stringify({
        id: "same-sub-resync",
        method: V4_METHODS.conversationResync,
        params: {
          topic,
          connectionId: "resync-connection",
          subscriptionId: subscribed.ack.subscriptionId,
          base: null,
          forceSnapshot: true,
        },
      })}\n`,
    );
    await connection.waitForClose();

    const lines = written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(1);
    const result = v4ConversationResyncResultSchema.parse(lines[0]?.result);
    expect(result.ack.subscriptionId).toBe(subscribed.ack.subscriptionId);
    expect(result.ack.mode).toBe("snapshot");
    expect(lines.slice(1).every((line) => line.method === V4_NOTIFICATIONS.conversationFrame)).toBe(
      true,
    );
  });

  it("uses the app supplied protocol trace as the session root trace", async () => {
    const logs: RecordedLog[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      loggerFactory: createProtocolTestLoggerFactory(logs),
      version: "test-version",
    });

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
        trace: { traceId: "trace_from_app" },
      }),
    );

    expect(snapshot.session.traceId).toBe("trace_from_app");
    const createRecord = logs.find(
      (log) => log.context.event === "zcode_protocol.create_record.mcp_config",
    );
    expect(createRecord?.context.rootTraceId).toBe("trace_from_app");
  });

  it("keeps project plugin roots and untrusted project MCP disconnected during refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-mcp-list-"));
    const workspacePath = join(root, "workspace");
    const pluginRoot = join(root, "plugin");
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const mcpPort = createProtocolListMcpPort(connectedConfigs);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspacePath,
      mcpPort,
      version: "test-version",
    });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
          },
          mcp: {
            servers: {
              "project-only": {
                type: "stdio",
                command: "project-server",
              },
            },
          },
        }),
      );
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "status-plugin",
          mcpServers: {
            "plugin-live": {
              command: "plugin-server",
            },
          },
        }),
      );

      const result = await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.mcpList,
        params: {
          workspace: {
            workspaceKey: workspacePath,
            workspacePath,
          },
        },
      });

      expect(connectedConfigs).toHaveLength(1);
      // 旧夹具仍期待项目配置自动加载插件、启动 MCP；当前合同要求用户安装与工作区信任。
      expect(connectedConfigs[0]?.["plugin:status-plugin:plugin-live"]).toBeUndefined();
      expect(connectedConfigs[0]?.["project-only"]).toBeUndefined();
      expect(result).toMatchObject({
        statuses: {
          "project-only": {
            status: "untrusted",
            toolCount: 0,
            transport: "stdio",
          },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses explicit protocol MCP servers for MCP list statuses", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-mcp-list-explicit-"));
    const workspacePath = join(root, "workspace");
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const mcpPort = createProtocolListMcpPort(connectedConfigs);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspacePath,
      mcpPort,
      version: "test-version",
    });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(workspacePath, { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              "disk-only": {
                type: "stdio",
                command: "disk-server",
              },
            },
          },
        }),
      );

      const result = await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.mcpList,
        params: {
          workspace: {
            workspaceKey: workspacePath,
            workspacePath,
          },
          mcpServers: [
            {
              name: "agents-fallback",
              command: "node",
              args: ["server.mjs"],
              env: [{ name: "TOKEN", value: "secret" }],
              timeoutMs: 3000,
            },
          ],
        },
      });

      expect(connectedConfigs).toHaveLength(1);
      expect(connectedConfigs[0]?.["agents-fallback"]).toMatchObject({
        args: ["server.mjs"],
        command: "node",
        env: { TOKEN: "secret" },
        timeoutMs: 3000,
        type: "stdio",
      });
      expect(connectedConfigs[0]?.["disk-only"]).toBeUndefined();
      expect(result).toMatchObject({
        statuses: {
          "agents-fallback": {
            status: "connected",
            toolCount: 3,
            transport: "stdio",
          },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not read or disconnect another workspace MCP lease in status mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-mcp-list-status-"));
    const workspacePath = join(root, "workspace");
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const disconnectedNames: string[] = [];
    const mcpPort = createProtocolReplaceMcpPort(connectedConfigs, disconnectedNames, {
      everything: {
        status: "connected",
        transport: "stdio",
        toolCount: 9,
        updatedAt: new Date(1).toISOString(),
      },
      "plugin:canva:canva": {
        authorization: {
          authorizationUrl: "https://auth.canva.example.test/authorize",
          startedAt: new Date(1).toISOString(),
          type: "oauth_authorization_code",
        },
        status: "connecting",
        transport: "http",
        toolCount: 0,
        updatedAt: new Date(1).toISOString(),
      },
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspacePath,
      mcpPort,
      version: "test-version",
    });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(workspacePath, { recursive: true });

      const result = await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.mcpList,
        params: {
          workspace: {
            workspaceKey: workspacePath,
            workspacePath,
          },
          mode: "status",
          mcpServers: [
            {
              name: "plugin:canva:canva",
              type: "http",
              url: "https://mcp.canva.example.test/mcp",
              headers: [],
              oauth: {
                type: "authorization_code",
                clientName: "ZCode",
              },
            },
          ],
        },
      });

      expect(connectedConfigs).toHaveLength(0);
      expect(disconnectedNames).toHaveLength(0);
      // 没有为此 workspace 取得设置 lease 时，不能把原始端口中其他 owner 的连接态投过来。
      expect((result as { statuses: Record<string, unknown> }).statuses.everything).toBeUndefined();
      expect(result).toMatchObject({
        statuses: {
          "plugin:canva:canva": {
            status: "disconnected",
            transport: "http",
          },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps replace convergence when default connect sees pending OAuth status", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-mcp-list-connect-pending-"));
    const workspacePath = join(root, "workspace");
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const disconnectedNames: string[] = [];
    const mcpPort = createProtocolReplaceMcpPort(connectedConfigs, disconnectedNames, {
      "plugin:canva:canva": {
        authorization: {
          authorizationUrl: "https://auth.canva.example.test/authorize",
          startedAt: new Date(1).toISOString(),
          type: "oauth_authorization_code",
        },
        status: "connecting",
        transport: "http",
        toolCount: 0,
        updatedAt: new Date(1).toISOString(),
      },
      stale: {
        status: "connected",
        transport: "stdio",
        toolCount: 1,
        updatedAt: new Date(1).toISOString(),
      },
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspacePath,
      mcpPort,
      version: "test-version",
    });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(workspacePath, { recursive: true });

      const result = await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.mcpList,
        params: {
          workspace: {
            workspaceKey: workspacePath,
            workspacePath,
          },
          mcpServers: [
            {
              name: "everything",
              command: "node",
              args: ["server.mjs"],
              env: [],
            },
            {
              name: "plugin:canva:canva",
              type: "http",
              url: "https://mcp.canva.example.test/mcp",
              headers: [],
              oauth: {
                type: "authorization_code",
                clientName: "ZCode",
              },
            },
          ],
        },
      });

      expect(connectedConfigs).toHaveLength(1);
      expect(connectedConfigs[0]).toMatchObject({
        everything: {
          command: "node",
          type: "stdio",
        },
        "plugin:canva:canva": {
          type: "http",
        },
      });
      expect(disconnectedNames).toContain("stale");
      expect(result).toMatchObject({
        statuses: {
          everything: {
            status: "connected",
          },
          "plugin:canva:canva": {
            status: "connected",
          },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns pending MCP OAuth authorization status without waiting for callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-protocol-mcp-oauth-pending-"));
    const workspacePath = join(root, "workspace");
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    let finishConnect!: () => void;
    const mcpPort = createProtocolPendingAuthorizationMcpPort(connectedConfigs, (resolve) => {
      finishConnect = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspacePath,
      mcpPort,
      version: "test-version",
    });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(workspacePath, { recursive: true });

      const result = await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.mcpList,
        params: {
          workspace: {
            workspaceKey: workspacePath,
            workspacePath,
          },
          mcpServers: [
            {
              name: "notion",
              type: "http",
              url: "https://mcp.notion.example.test/mcp",
              headers: [],
              oauth: {
                type: "authorization_code",
                clientName: "ZCode",
              },
            },
          ],
        },
      });

      expect(connectedConfigs).toHaveLength(1);
      expect(result).toMatchObject({
        statuses: {
          notion: {
            authorization: {
              authorizationUrl: "https://auth.example.test/authorize?state=state_test",
              type: "oauth_authorization_code",
            },
            status: "connecting",
            transport: "http",
          },
        },
      });
      finishConnect();
    } finally {
      finishConnect?.();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels background bash tasks through the session protocol", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    let cancelledTaskId: string | undefined;
    let backgroundTasks: BackgroundTaskInfo[] = [
      {
        cancellable: true,
        command: "pnpm dev",
        status: "running",
        taskId: "bg_1",
        terminalId: "bg_1",
      },
    ];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const app = createFakeApp(options);
        return {
          ...app,
          cancelBackgroundTask: async (taskId) => {
            cancelledTaskId = taskId;
            const currentTask = backgroundTasks[0];
            if (!currentTask) {
              throw new Error("Expected background task fixture");
            }
            backgroundTasks = [
              {
                ...currentTask,
                cancellable: false,
                status: "cancelled",
              },
            ];
            return {
              cancelled: true,
              snapshot: backgroundTasks[0],
              status: "cancelled",
              taskId,
            };
          },
          runtime: {
            ...app.runtime,
            getProjection: async () => ({
              ...(await app.runtime.getProjection()),
              backgroundTasks,
            }),
          },
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const result = zcodeSessionCancelBackgroundTaskResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionCancelBackgroundTask,
        params: { sessionId: snapshot.session.sessionId, taskId: "bg_1" },
      }),
    );

    expect(cancelledTaskId).toBe("bg_1");
    expect(result).toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "bg_1",
    });
    expect(notifications.some((item) => item.method === "state.updated")).toBe(true);
  });

  it("sends contiguous protocol seq for the visible session event stream", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    const logs: RecordedLog[] = [];
    let eventStore: ZCodeAppOptions["eventStore"];
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      loggerFactory: createProtocolTestLoggerFactory(logs),
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
      },
    });

    const emitStoredEvent = async (event: SessionEvent) => {
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const emitLiveOnlyEvent = async (event: SessionEvent) => {
      if (!liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      await liveSink(event);
    };
    const baseEvent = {
      sessionId: created.session.sessionId as SessionId,
      timestamp: new Date(7),
      traceId: "trace_protocol_seq" as SessionEvent["traceId"],
      type: SessionEventType.ModelStreaming,
    };
    await emitLiveOnlyEvent({
      ...baseEvent,
      id: "evt_live_text_delta_1" as SessionEvent["id"],
      payload: { delta: "live", done: false, kind: "text_delta" },
      sequenceNumber: 0,
    });
    await emitLiveOnlyEvent({
      ...baseEvent,
      id: "evt_live_text_delta_2" as SessionEvent["id"],
      payload: { delta: " only", done: false, kind: "text_delta" },
      sequenceNumber: 0,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_tool_input_delta" as SessionEvent["id"],
      payload: { delta: '{"file_path":"README.md"}', done: false, kind: "tool_input_delta" },
      sequenceNumber: 0,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_text_delta_1" as SessionEvent["id"],
      payload: { delta: "hello", done: false, kind: "text_delta" },
      sequenceNumber: 0,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_text_delta_2" as SessionEvent["id"],
      payload: { delta: " world", done: false, kind: "text_delta" },
      sequenceNumber: 0,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_turn_complete" as SessionEvent["id"],
      payload: {
        duration: 1,
        response: "done",
        resultType: "success",
        tokenCount: 2,
        toolCallCount: 0,
      },
      sequenceNumber: 0,
      type: SessionEventType.TurnComplete,
    });

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(liveEvents.map((event) => event.eventId)).toEqual([
      "evt_live_text_delta_1",
      "evt_live_text_delta_2",
      "evt_tool_input_delta",
      "evt_text_delta_1",
      "evt_text_delta_2",
      "evt_turn_complete",
    ]);

    const subscribed = zcodeSessionSubscribeResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionSubscribe,
        params: {
          sessionId: created.session.sessionId,
          deliveryKind: "desktop-continuous",
          afterSeq: 1,
          includeSnapshot: true,
        },
      }),
    );
    expect(subscribed.eventSeq).toBe(6);
    expect(subscribed.events.map((event) => event.seq)).toEqual([3, 4, 5, 6]);
    expect(subscribed.snapshot?.runtime.eventSeq).toBe(6);

    const sentLog = logs.find(
      (log) =>
        log.context.event === "zcode_protocol.session_event.sent" &&
        log.context.eventId === "evt_text_delta_1",
    );
    expect(sentLog?.context).toMatchObject({
      event: "zcode_protocol.session_event.sent",
      eventId: "evt_text_delta_1",
      payloadKeys: ["delta", "done", "kind"],
      payloadKind: "text_delta",
      payloadSummary: {
        deltaBytes: expect.any(Number),
        done: false,
        kind: "text_delta",
      },
      protocolEventType: "model.streaming",
      protocolMessageBytes: expect.any(Number),
      protocolPayloadBytes: expect.any(Number),
      protocolSeq: 4,
      sessionEventType: SessionEventType.ModelStreaming,
    });
    expect(sentLog?.context.protocolMessage).toBeUndefined();
    expect(JSON.stringify(sentLog?.context)).not.toContain("hello");
  });

  it("omits repeated scheduled tool input after model streaming tool calls", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    let eventStore: ZCodeAppOptions["eventStore"];
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      },
    });

    const emitStoredEvent = async (event: SessionEvent) => {
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const toolInput = {
      content: "generated content\n".repeat(512),
      file_path: "/workspace/generated.html",
    };
    const inputByteLength = Buffer.byteLength(JSON.stringify(toolInput), "utf8");
    const baseEvent = {
      sessionId: created.session.sessionId as SessionId,
      timestamp: new Date(7),
      traceId: "trace_tool_input_dedupe" as SessionEvent["traceId"],
    };

    await emitStoredEvent({
      ...baseEvent,
      id: "evt_tool_call" as SessionEvent["id"],
      payload: {
        done: true,
        input: toolInput,
        kind: "tool_call",
        toolCallId: "call_write",
        toolName: "Write",
      },
      sequenceNumber: 0,
      type: SessionEventType.ModelStreaming,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_tool_scheduled" as SessionEvent["id"],
      payload: {
        input: toolInput,
        schedule: { dependencies: [] },
        toolCallId: "call_write",
        toolName: "Write",
      },
      sequenceNumber: 0,
      type: SessionEventType.ToolCallScheduled,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_tool_ledger" as SessionEvent["id"],
      payload: {
        input: toolInput,
        status: "tool_started",
        toolCallId: "call_write",
        toolName: "Write",
      },
      sequenceNumber: 0,
      type: SessionEventType.StreamingToolLedgerUpdated,
    });

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.map((event) => event.eventId)).toEqual([
      "evt_tool_call",
      "evt_tool_scheduled",
    ]);
    expect(liveEvents.map((event) => event.seq)).toEqual([1, 2]);
    const liveScheduledPayload = liveEvents[1]?.payload as Record<string, unknown>;
    expect(liveScheduledPayload).toMatchObject({
      inputByteLength,
      inputOmitted: true,
      inputRef: "model_stream",
      kind: "scheduled",
      toolCallId: "call_write",
      toolName: "Write",
    });
    expect(Object.prototype.hasOwnProperty.call(liveScheduledPayload, "input")).toBe(false);

    const replayed = zcodeSessionEventsResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionEvents,
        params: { sessionId: created.session.sessionId, afterSeq: 0 },
      }),
    );
    expect(replayed.events.map((event) => event.eventId)).toEqual([
      "evt_tool_call",
      "evt_tool_scheduled",
    ]);
    const replayScheduledPayload = replayed.events[1]?.payload as Record<string, unknown>;
    expect(replayScheduledPayload).toMatchObject({
      inputByteLength,
      inputOmitted: true,
      inputRef: "model_stream",
      kind: "scheduled",
      toolCallId: "call_write",
      toolName: "Write",
    });
    expect(Object.prototype.hasOwnProperty.call(replayScheduledPayload, "input")).toBe(false);
    expect(JSON.stringify(liveScheduledPayload)).not.toContain("generated content");
    expect(JSON.stringify(replayScheduledPayload)).not.toContain("generated content");
  });

  it("coalesces streaming tool input deltas with eager and timestamp-budgeted flushes", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    let eventStore: ZCodeAppOptions["eventStore"];
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      },
    });

    const emitStoredEvent = async (event: SessionEvent) => {
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const baseEvent = {
      sessionId: created.session.sessionId as SessionId,
      traceId: "trace_tool_delta_coalesce" as SessionEvent["traceId"],
      type: SessionEventType.ModelStreaming,
    };

    for (const [index, item] of [
      { delta: "a", timestamp: 7 },
      { delta: "b", timestamp: 407 },
      { delta: "c", timestamp: 758 },
    ].entries()) {
      await emitStoredEvent({
        ...baseEvent,
        id: `evt_tool_delta_${index + 1}` as SessionEvent["id"],
        payload: {
          delta: item.delta,
          done: false,
          kind: "tool_input_delta",
          toolCallId: "call_write",
          toolName: "Write",
        },
        sequenceNumber: 0,
        timestamp: new Date(item.timestamp),
      });
    }
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_tool_input_end" as SessionEvent["id"],
      payload: {
        done: true,
        kind: "tool_input_end",
        toolCallId: "call_write",
        toolName: "Write",
      },
      sequenceNumber: 0,
      timestamp: new Date(759),
    });

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(liveEvents.map((event) => event.eventId)).toEqual([
      "evt_tool_delta_1",
      "evt_tool_delta_3",
      "evt_tool_input_end",
    ]);
    expect(liveEvents[0]?.payload).toMatchObject({
      delta: "a",
      kind: "tool_input_delta",
      toolCallId: "call_write",
    });
    expect(liveEvents[1]?.payload).toMatchObject({
      delta: "bc",
      kind: "tool_input_delta",
      toolCallId: "call_write",
    });

    const replayed = zcodeSessionEventsResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionEvents,
        params: { sessionId: created.session.sessionId, afterSeq: 0 },
      }),
    );
    expect(replayed.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(replayed.events[0]?.payload).toMatchObject({
      delta: "a",
      kind: "tool_input_delta",
      toolCallId: "call_write",
    });
    expect(replayed.events[1]?.payload).toMatchObject({
      delta: "bc",
      kind: "tool_input_delta",
      toolCallId: "call_write",
    });
  });

  it("coalesces text and reasoning streaming deltas after the first visible token", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    let eventStore: ZCodeAppOptions["eventStore"];
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      },
    });

    const emitStoredEvent = async (event: SessionEvent) => {
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const baseEvent = {
      sessionId: created.session.sessionId as SessionId,
      traceId: "trace_text_delta_coalesce" as SessionEvent["traceId"],
      type: SessionEventType.ModelStreaming,
    };

    for (const [index, delta] of ["first", " second", " third"].entries()) {
      await emitStoredEvent({
        ...baseEvent,
        id: `evt_reasoning_delta_${index + 1}` as SessionEvent["id"],
        timestamp: new Date([0, 100, 260][index] ?? 260),
        payload: {
          assistantMessageId: "msg_reasoning",
          delta,
          done: false,
          kind: "reasoning_delta",
        },
        sequenceNumber: 0,
      });
    }
    const liveEventsBeforeTurnComplete = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEventsBeforeTurnComplete.map((event) => event.eventId)).toEqual([
      "evt_reasoning_delta_1",
      "evt_reasoning_delta_3",
    ]);
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_turn_complete_after_reasoning" as SessionEvent["id"],
      timestamp: new Date(300),
      payload: {
        duration: 1,
        response: "done",
        resultType: "success",
        tokenCount: 3,
        toolCallCount: 0,
      },
      sequenceNumber: 0,
      type: SessionEventType.TurnComplete,
    });

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(liveEvents.map((event) => event.eventId)).toEqual([
      "evt_reasoning_delta_1",
      "evt_reasoning_delta_3",
      "evt_turn_complete_after_reasoning",
    ]);
    expect(liveEvents[0]?.payload).toMatchObject({
      delta: "first",
      kind: "reasoning_delta",
    });
    expect(liveEvents[1]?.payload).toMatchObject({
      delta: " second third",
      kind: "reasoning_delta",
    });

    const replayed = zcodeSessionEventsResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionEvents,
        params: { sessionId: created.session.sessionId, afterSeq: 0 },
      }),
    );
    expect(replayed.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(replayed.events[1]?.payload).toMatchObject({
      delta: " second third",
      kind: "reasoning_delta",
    });
  });

  it("keeps separate text streaming parts in separate protocol batches", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    let eventStore: ZCodeAppOptions["eventStore"];
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      },
    });

    const emitStoredEvent = async (event: SessionEvent) => {
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const baseEvent = {
      sessionId: created.session.sessionId as SessionId,
      timestamp: new Date(7),
      traceId: "trace_parent_text_delta_coalesce" as SessionEvent["traceId"],
      type: SessionEventType.ModelStreaming,
    };

    await emitStoredEvent({
      ...baseEvent,
      id: "evt_parent_a_text_delta" as SessionEvent["id"],
      payload: {
        delta: "from-a",
        done: false,
        kind: "text_delta",
        partId: "part_a",
      },
      sequenceNumber: 0,
    });
    await emitStoredEvent({
      ...baseEvent,
      id: "evt_parent_b_text_delta" as SessionEvent["id"],
      payload: {
        delta: "from-b",
        done: false,
        kind: "text_delta",
        partId: "part_b",
      },
      sequenceNumber: 0,
    });

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.map((event) => event.eventId)).toEqual([
      "evt_parent_a_text_delta",
      "evt_parent_b_text_delta",
    ]);
    expect(liveEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        delta: "from-a",
        kind: "text_delta",
        partId: "part_a",
      }),
      expect.objectContaining({
        delta: "from-b",
        kind: "text_delta",
        partId: "part_b",
      }),
    ]);
  });

  it("creates imported sessions as resumable protocol sessions", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const importedWorkspace = {
      ...workspace,
      workspaceIdentity: "ssh:example:/workspace/app",
    };
    try {
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => createFakeApp(options),
        cwd: importedWorkspace.workspacePath,
        sessionStore: store,
        version: "test-version",
      });

      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: {
            workspace: importedWorkspace,
            sessionId: "claude-import-test-session",
            importedHistory: {
              source: "claudeCode",
              title: "Imported Claude Session",
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
              messages: [
                {
                  role: "user",
                  content: "继续这个导入会话",
                  timestamp: 1_700_000_001_000,
                },
                {
                  role: "assistant",
                  content: "可以继续。",
                  timestamp: 1_700_000_000_500,
                },
              ],
            },
          },
        }),
      );

      expect(created.session.title).toBe("Imported Claude Session");
      expect(created.session.sessionId).toBe("claude-import-test-session");
      await expect(
        store.getSession("claude-import-test-session" as SessionId),
      ).resolves.toMatchObject({
        workspaceID: importedWorkspace.workspaceIdentity,
      });
      expect(messageTexts(created.messages)).toEqual(["继续这个导入会话", "可以继续。"]);

      const switched = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 2,
          method: zcodeProtocolMethods.sessionSetModel,
          params: {
            sessionId: created.session.sessionId,
            model: { providerId: "glm", modelId: "glm-4-air" },
          },
        }),
      );

      expect(switched.session.sessionId).toBe(created.session.sessionId);
      expect(switched.settings.model.current).toMatchObject({
        providerId: "glm",
        modelId: "glm-4-air",
      });
      expect(messageTexts(switched.messages)).toEqual(["继续这个导入会话", "可以继续。"]);

      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          workspace: importedWorkspace,
          sessionId: "claude-import-second-session",
          importedHistory: {
            source: "claudeCode",
            title: "Second Imported Claude Session",
            messages: [
              {
                role: "user",
                content: "第二个导入会话",
                timestamp: 1_700_000_003_000,
              },
              {
                role: "assistant",
                content: "第二个也可以继续。",
                timestamp: 1_700_000_002_000,
              },
            ],
          },
        },
      });

      const rereadFirst = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 4,
          method: zcodeProtocolMethods.sessionRead,
          params: { sessionId: created.session.sessionId },
        }),
      );
      const secondMessages = await store.messages({
        sessionID: "claude-import-second-session" as SessionId,
      });

      expect(messageTexts(rereadFirst.messages)).toEqual(["继续这个导入会话", "可以继续。"]);
      expect(messageTexts(secondMessages)).toEqual(["第二个导入会话", "第二个也可以继续。"]);
      expect(secondMessages.map((message) => message.info.id)).toEqual([
        "msg_claude-import-second-session_import_0",
        "msg_claude-import-second-session_import_1",
      ]);
    } finally {
      store.close();
    }
  });

  it("accepts an assigned fresh ID and rejects replacement of the existing runtime", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const params = { workspace, sessionId: "host-assigned-session" };
    const first = await server.handleMessage({
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params,
    });
    expect(first).toHaveProperty("result.session.sessionId", params.sessionId);
    const again = await server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.sessionCreate,
      params,
    });
    expect(again).toMatchObject({ error: { code: -32602, message: "sessionId already exists" } });
  });

  it("rejects concurrent creation of the same assigned ID while materializing", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: async (options) => {
        started();
        await gate;
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const params = { workspace, sessionId: "concurrent-create" };
    const first = server.handleMessage({
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params,
    });
    await entered;
    const second = await server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.sessionCreate,
      params,
    });
    release();
    expect(second).toMatchObject({ error: { code: -32602, message: "sessionId already exists" } });
    expect(await first).toHaveProperty("result.session.sessionId", params.sessionId);
  });

  it("keeps session title generation internals out of the visible event stream", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    let eventStore: ZCodeAppOptions["eventStore"];
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
      },
    });
    const emitStoredEvent = async (event: SessionEvent) => {
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const common = {
      sessionId: created.session.sessionId as SessionId,
      timestamp: new Date(8),
      traceId: "trace_title_generation" as SessionEvent["traceId"],
      turnId: "turn_title" as SessionEvent["turnId"],
    };

    await emitStoredEvent({
      ...common,
      id: "evt_turn_complete" as SessionEvent["id"],
      payload: {
        response: "done",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
      },
      sequenceNumber: 0,
      type: SessionEventType.TurnComplete,
    });
    await emitStoredEvent({
      ...common,
      id: "evt_title_model_request" as SessionEvent["id"],
      payload: {
        messages: [],
        model: "glm/glm-4.6",
        querySource: "session_title",
        toolCount: 0,
      },
      sequenceNumber: 0,
      type: SessionEventType.ModelRequest,
    });
    await emitStoredEvent({
      ...common,
      id: "evt_title_model_status_started" as SessionEvent["id"],
      payload: {
        attempt: 1,
        maxAttempts: 11,
        model: { modelId: "glm-0606", providerId: "zai" },
        querySource: "session_title",
        requestId: "request_title",
        timestamp: "2026-06-03T10:33:41.048Z",
        traceId: "trace_title_generation",
        transport: "http",
        type: "model_request_started",
      },
      sequenceNumber: 0,
      type: SessionEventType.ModelNetworkStatus,
    });
    await emitStoredEvent({
      ...common,
      id: "evt_main_model_retry" as SessionEvent["id"],
      payload: {
        attempt: 2,
        delayMs: 1234,
        maxAttempts: 11,
        message: "Provider returned a server error.",
        model: { modelId: "glm-0606", providerId: "zai" },
        nextAttempt: 3,
        querySource: "main_turn",
        reason: "server_error",
        requestId: "request_main",
        statusCode: 502,
        timestamp: "2026-06-03T10:33:43.048Z",
        traceId: "trace_title_generation",
        transport: "http",
        type: "model_retry_scheduled",
      },
      sequenceNumber: 0,
      type: SessionEventType.ModelNetworkStatus,
    });
    await emitStoredEvent({
      ...common,
      id: "evt_title_model_complete" as SessionEvent["id"],
      payload: {
        content: '{"title":"Done"}',
        querySource: "session_title",
        stopReason: "stop",
        toolCallCount: 0,
      },
      sequenceNumber: 0,
      type: SessionEventType.ModelComplete,
    });
    await emitStoredEvent({
      ...common,
      id: "evt_title_updated" as SessionEvent["id"],
      payload: {
        previousTitle: "Old title",
        source: "generated",
        title: "Done",
      },
      sequenceNumber: 0,
      type: SessionEventType.SessionTitleUpdated,
    });

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.map((event) => [event.seq, event.type])).toEqual([
      [1, "turn.completed"],
      [2, "session.updated"],
      [3, "session.titleUpdated"],
    ]);
    expect(liveEvents[1]?.payload).toMatchObject({
      _meta: {
        zcode: {
          apiRetry: {
            attempt: 2,
            errorStatus: 502,
            kind: "api_retry",
            maxRetries: 10,
            retryDelayMs: 1234,
          },
        },
      },
      querySource: "main_turn",
      type: "model_retry_scheduled",
    });
  });

  it("publishes core stream recovery retry counts as apiRetry meta", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    let eventStore: SessionEventStore | undefined;
    let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        eventStore = options?.eventStore;
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            subscribeEvents: (sink: {
              onSessionEvent(event: SessionEvent): void | Promise<void>;
            }) => {
              liveSink = sink.onSessionEvent;
              return () => {};
            },
          } as never,
        };
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSubscribe,
      params: {
        sessionId: created.session.sessionId,
        deliveryKind: "desktop-continuous",
      },
    });
    if (!eventStore || !liveSink) {
      throw new Error("Expected fake app event sink to be wired");
    }
    const storedEvent = await eventStore.append({
      id: "evt_stream_recovery_retry" as SessionEvent["id"],
      payload: {
        attempt: 1,
        maxAttempts: 11,
        model: { modelId: "glm-0606", providerId: "zai" },
        requestId: "request_recovery",
        streamRecovery: {
          attemptId: "stream_attempt_1",
          anchorId: "anchor_1",
          maxRetries: 10,
          recoveredFromRequestId: "request_failed",
          retryNumber: 3,
        },
        timestamp: "2026-06-03T10:33:43.048Z",
        traceId: "trace_stream_recovery",
        transport: "http",
        type: "model_request_started",
      },
      sequenceNumber: 0,
      sessionId: created.session.sessionId as SessionId,
      timestamp: new Date(8),
      traceId: "trace_stream_recovery" as SessionEvent["traceId"],
      turnId: "turn_stream_recovery" as SessionEvent["turnId"],
      type: SessionEventType.ModelNetworkStatus,
    });
    await liveSink(storedEvent);

    const liveEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(liveEvents.at(-1)?.payload).toMatchObject({
      _meta: {
        zcode: {
          apiRetry: {
            attempt: 3,
            errorStatus: null,
            kind: "api_retry",
            maxRetries: 10,
            retryDelayMs: 0,
          },
        },
      },
      streamRecovery: {
        recoveredFromRequestId: "request_failed",
        retryNumber: 3,
      },
      type: "model_request_started",
    });

    const progressEvent = await eventStore.append({
      id: "evt_stream_recovery_progress" as SessionEvent["id"],
      payload: {
        attemptId: "stream_attempt_2",
        failedRequestId: "request_recovery",
        maxRetries: 10,
        recoveredFromRequestId: "request_recovery",
        retryNumber: 4,
        streamMode: "sse",
      },
      sequenceNumber: 0,
      sessionId: created.session.sessionId as SessionId,
      timestamp: new Date(9),
      traceId: "trace_stream_recovery" as SessionEvent["traceId"],
      turnId: "turn_stream_recovery" as SessionEvent["turnId"],
      type: SessionEventType.StreamRecoveryRetryStarted,
    });
    await liveSink(progressEvent);

    const progressEvents = notifications
      .filter((notification) => notification.method === "session/event")
      .map((notification) => zcodeSessionEventSchema.parse(notification.params));
    expect(progressEvents.at(-1)).toMatchObject({
      type: "streamRecovery.updated",
      payload: {
        _meta: {
          zcode: {
            apiRetry: {
              attempt: 4,
              errorStatus: null,
              kind: "api_retry",
              maxRetries: 10,
              retryDelayMs: 0,
            },
          },
        },
        recoveredFromRequestId: "request_recovery",
        retryNumber: 4,
      },
    });
  });

  it("returns direct session snapshots for create/read and wrapped subscribe results", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    expect(created.protocol).toEqual({ name: "ZCode Protocol", version: 1 });
    expect(created.session.workspace.workspaceKey).toBe(workspace.workspaceKey);

    const read = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionRead,
        params: { sessionId: created.session.sessionId },
      }),
    );
    expect(read.session.sessionId).toBe(created.session.sessionId);

    const subscribed = zcodeSessionSubscribeResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionSubscribe,
        params: {
          sessionId: created.session.sessionId,
          deliveryKind: "desktop-continuous",
          includeSnapshot: true,
        },
      }),
    );
    expect(subscribed.sessionId).toBe(created.session.sessionId);
    expect(subscribed.snapshot?.session.sessionId).toBe(created.session.sessionId);
  });

  it("session/read contentProfile=index 剥离大载荷，缺省仍返回完整历史", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const big = "y".repeat(512 * 1024);
    try {
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => createFakeApp(options),
        cwd: workspace.workspacePath,
        sessionStore: store,
        version: "test-version",
      });
      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: { workspace },
        }),
      );
      const sessionID = created.session.sessionId as SessionId;
      if (!(await store.getSession(sessionID))) {
        await store.createSession({
          id: sessionID,
          projectID: "project_index_profile" as ProjectId,
          slug: "index-profile",
          directory: workspace.workspacePath,
          path: workspace.workspacePath,
          title: "Index profile",
          version: "test-version",
          time: { created: 1, updated: 1 },
        });
      }
      const userId = "msg_index_user" as MessageId;
      const assistantId = "msg_index_assistant" as MessageId;
      await store.saveMessage({
        id: userId,
        sessionID,
        role: "user",
        agent: "zcode-agent",
        time: { created: 10 },
        modelSelection: { providerId: "glm" as ModelProviderId, modelId: "glm-4.6" as ModelId },
      });
      await store.savePart({
        id: "part_index_user" as never,
        messageID: userId,
        sessionID,
        type: "text",
        text: "查一下订单",
      });
      await store.saveMessage({
        id: assistantId,
        sessionID,
        role: "assistant",
        parentID: userId,
        agent: "zcode-agent",
        time: { created: 20, completed: 30 },
        providerId: "glm" as ModelProviderId,
        modelId: "glm-4.6" as ModelId,
        mode: "build",
        path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } },
      } as never);
      await store.savePart({
        id: "part_index_reasoning" as never,
        messageID: assistantId,
        sessionID,
        type: "reasoning",
        text: big,
        time: { start: 21, end: 22 },
      } as never);
      await store.savePart({
        id: "part_index_tool" as never,
        messageID: assistantId,
        sessionID,
        type: "tool",
        callID: "call_index_tool",
        tool: "Bash",
        state: {
          status: "completed",
          input: { command: big },
          output: big,
          title: "Bash",
          metadata: {},
          time: { start: 23, end: 24 },
        },
      } as never);
      await store.savePart({
        id: "part_index_text" as never,
        messageID: assistantId,
        sessionID,
        type: "text",
        text: "订单在 orderService",
      });

      const readWith = async (id: number, extra: Record<string, unknown>) =>
        zcodeSessionStateSnapshotSchema.parse(
          await requestResult(server, {
            id,
            method: zcodeProtocolMethods.sessionRead,
            params: { sessionId: sessionID, ...extra },
          }),
        );
      const full = await readWith(2, {});
      const index = await readWith(3, { contentProfile: "index" });

      expect(JSON.stringify(full).length).toBeGreaterThan(big.length * 2);
      expect(JSON.stringify(index).length).toBeLessThan(big.length / 4);
      const shape = (snapshot: typeof full) =>
        snapshot.messages.map((message) => ({
          id: message.info.messageId,
          parts: message.parts.map((part) => `${part.partId}:${part.type}`),
        }));
      expect(shape(index)).toEqual(shape(full));
      expect(messageTexts(index.messages)).toEqual(messageTexts(full.messages));
      const indexTool = index.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool");
      expect(indexTool).toMatchObject({ state: { status: "completed", input: {}, output: "" } });
      // index 读取不能污染后续 full 读取（CLI 侧不得原地改写缓存消息）。
      const fullAgain = await readWith(4, { contentProfile: "full" });
      expect(JSON.stringify(fullAgain.messages)).toBe(JSON.stringify(full.messages));
    } finally {
      store.close();
    }
  });

  it("returns built-in slash commands for workspace and session snapshots", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    const presentation = zcodeWorkspacePresentationSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.workspaceReadPresentation,
        params: { workspace },
      }),
    );
    expect(presentation.slashCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputHint: "/compact [instructions]",
          name: "compact",
        }),
        expect.objectContaining({
          inputHint: "/goal [pause|resume|clear|replace <objective>|<objective>]",
          name: "goal",
        }),
      ]),
    );

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const createdCommandNames = created.slashCommands?.map((command) => command.name) ?? [];
    expect(createdCommandNames).toEqual(expect.arrayContaining(["compact", "goal"]));
    expect(createdCommandNames).not.toContain("model");
  });

  it("enables model streaming by default for protocol workspace apps", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];

    await createWorkspaceZCodeApp(
      {
        deps: {
          createZCodeApp: (options) => {
            createdAppOptions.push(options ?? {});
            return createFakeApp(options);
          },
        },
        notify: () => undefined,
        sessions: new Map(),
      },
      workspace,
      {
        runtimeConfig: {
          workingDirectory: workspace.workspacePath,
        },
      },
    );

    expect(createdAppOptions[0]?.runtimeConfig?.modelStreaming).toBe("on");
  });

  it("passes the opaque workspace identity into protocol app Memory config", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const remoteWorkspace = {
      workspaceIdentity: "ssh:example:/workspace/app",
      workspaceKey: "ssh:example:/workspace/app",
      workspacePath: "/workspace/app",
      remoteSessionId: "remote-session-1",
    };

    await createWorkspaceZCodeApp(
      {
        deps: {
          createZCodeApp: (options) => {
            createdAppOptions.push(options ?? {});
            return createFakeApp(options);
          },
        },
        notify: () => undefined,
        sessions: new Map(),
      },
      remoteWorkspace,
      {
        runtimeConfig: {
          workingDirectory: remoteWorkspace.workspacePath,
        },
      },
    );

    expect(createdAppOptions[0]?.runtimeConfig?.memory?.workspaceIdentity).toBe(
      remoteWorkspace.workspaceIdentity,
    );
    expect(createdAppOptions[0]?.runtimeConfig?.remoteSessionId).toBe(
      remoteWorkspace.remoteSessionId,
    );
  });

  it("preserves unapplied zcode-plan runtime headers original failure", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const requestClient = vi.fn(async () => ({
      headersApplied: false,
      errorMessage: "Runtime headers helper timed out after 5000ms.",
    }));

    await createWorkspaceZCodeApp(
      {
        deps: {
          createZCodeApp: (options) => {
            createdAppOptions.push(options ?? {});
            return createFakeApp(options);
          },
        },
        notify: () => undefined,
        requestClient,
        sessions: new Map(),
      },
      workspace,
      {
        runtimeConfig: {
          workingDirectory: workspace.workspacePath,
        },
      },
    );

    const runtimeHeadersPort = createdAppOptions[0]?.providerRuntimeHeadersPort;
    expect(
      runtimeHeadersPort?.shouldRefreshBeforeModelRequest?.({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        modelId: "glm-5.1",
      }),
    ).toBe(true);

    await expect(
      runtimeHeadersPort?.refreshBeforeModelRequest({
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          mode: "start-plan",
        },
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        modelId: "glm-5.1",
        reason: "model-request",
        sessionId: "sess_test" as never,
        traceContext: {} as never,
      }),
    ).rejects.toThrow("Runtime headers helper timed out after 5000ms.");
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
      expect.objectContaining({
        accountAccess: expect.objectContaining({
          mode: "start-plan",
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns per-request auth and distinct IDs for concurrent runtime header refreshes", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const requestClient = vi.fn(async () => ({
      headersApplied: true,
      requestAuth: {
        apiKey: "request-key",
        apiKeyId: "real-key-id",
        headers: { "X-Request": "request-header" },
      },
    }));

    await createWorkspaceZCodeApp(
      {
        deps: {
          createZCodeApp: (options) => {
            createdAppOptions.push(options ?? {});
            return createFakeApp(options);
          },
        },
        notify: () => undefined,
        requestClient,
        sessions: new Map(),
      },
      workspace,
      {
        runtimeConfig: {
          workingDirectory: workspace.workspacePath,
        },
      },
    );

    await expect(
      createdAppOptions[0]?.providerRuntimeHeadersPort?.refreshBeforeModelRequest({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        modelId: "glm-5.1",
        reason: "model-request",
        sessionId: "sess_test" as never,
        traceContext: {} as never,
      }),
    ).resolves.toMatchObject({
      headersApplied: true,
      requestAuth: {
        apiKey: "request-key",
        apiKeyId: "real-key-id",
        headers: { "X-Request": "request-header" },
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const port = createdAppOptions[0]!.providerRuntimeHeadersPort!;
      const input = {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        modelId: "glm-5.1",
        reason: "model-request" as const,
        sessionId: "sess_test" as never,
        traceContext: {} as never,
      };
      const results = await Promise.all([
        port.refreshBeforeModelRequest(input),
        port.refreshBeforeModelRequest(input),
      ]);
      expect(results.map((result) => result.requestAuth)).toEqual([
        {
          apiKey: "request-key",
          apiKeyId: "real-key-id",
          headers: { "X-Request": "request-header" },
        },
        {
          apiKey: "request-key",
          apiKeyId: "real-key-id",
          headers: { "X-Request": "request-header" },
        },
      ]);
      const requests = (
        requestClient.mock.calls as unknown as Array<
          [string, { requestId: string; reason: string }]
        >
      ).slice(-2);
      expect(requests[0][1].requestId).not.toBe(requests[1][1].requestId);
      expect(requests.map(([, request]) => request.reason)).toEqual([
        "model-request",
        "model-request",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("injects protocol MCP servers into session runtime config", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: {
        workspace,
        mcpServers: [
          {
            name: "chrome-devtools",
            command: "npx",
            args: ["-y", "chrome-devtools-mcp@latest"],
            env: [],
            timeoutMs: 3,
          },
          {
            name: "linear",
            type: "http",
            url: "https://mcp.example.test",
            headers: [{ name: "X-Test", value: "1" }],
            timeoutMs: 5000,
          },
          {
            name: "events",
            type: "sse",
            url: "https://mcp.example.test/sse",
            headers: [],
            timeoutMs: 8000,
          },
        ],
      },
    });

    expect(createdAppOptions[0]?.runtimeConfig?.mcp).toEqual({
      enabled: true,
      servers: {
        "chrome-devtools": {
          type: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest"],
          env: {},
          timeoutMs: 3,
        },
        linear: {
          type: "http",
          url: "https://mcp.example.test",
          headers: { "X-Test": "1" },
          timeoutMs: 5000,
        },
        events: {
          type: "sse",
          url: "https://mcp.example.test/sse",
          headers: {},
          timeoutMs: 8000,
        },
      },
    });
  });

  it("injects protocol tool allow and deny lists into session runtime config", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: {
        workspace,
        toolAllowlist: ["mcp__zcode_cua__get_app_state"],
        toolDenylist: ["Bash"],
      },
    });

    expect(createdAppOptions[0]?.runtimeConfig?.toolAllowlist).toEqual([
      "mcp__zcode_cua__get_app_state",
    ]);
    expect(createdAppOptions[0]?.runtimeConfig?.toolDisallowlist).toEqual(["Bash"]);
  });

  it("远程 SSH/WSL workspace 默认禁用全部 Cron 工具并保留调用方 denylist", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    for (const [index, workspaceIdentity] of [
      "remote:ssh:example.test:22:dev:/workspace/app",
      "remote:wsl:Ubuntu-24.04:dev:/workspace/app",
    ].entries()) {
      await requestResult(server, {
        id: index + 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          workspace: {
            ...workspace,
            workspaceIdentity,
            workspaceKey: workspaceIdentity,
          },
          toolDenylist: ["Bash"],
        },
      });

      expect(createdAppOptions[index]?.runtimeConfig?.toolDisallowlist).toEqual([
        "Bash",
        "CronCreate",
        "CronList",
        "CronUpdate",
        "CronDelete",
        "CronPauseSelf",
      ]);
    }
  });

  it("reads materialization preferences once per root runtime and keeps active resumes stable", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    let nativeSearchEnabled = false;
    let toolSearchMode: "off" | "local" = "off";
    let memoryEnabled = false;
    let modelContextBudgetStrategy: "legacy" | "preflight-v1" = "legacy";
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const preferenceRequests = attachSessionRuntimePreferencesResponder(server, () => ({
      nativeSearchEnhancementsEnabled: nativeSearchEnabled,
      toolSearchMode,
      memoryEnabled,
      modelContextBudgetStrategy,
    }));

    const disabled = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    nativeSearchEnabled = true;
    toolSearchMode = "local";
    memoryEnabled = true;
    modelContextBudgetStrategy = "preflight-v1";
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionResume,
      params: { sessionId: disabled.session.sessionId },
    });
    await requestResult(server, {
      id: 3,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });

    expect(
      preferenceRequests.map((request) => (request.params as { scope: string }).scope),
    ).toEqual(["runtime-materialization", "runtime-materialization"]);
    expect(createdAppOptions).toHaveLength(2);
    expect(createdAppOptions[0]?.runtimeConfig?.toolSearch).toEqual({ mode: "off" });
    expect(createdAppOptions[1]?.runtimeConfig?.toolSearch).toEqual({ mode: "local" });
    expect(createdAppOptions[0]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(false);
    expect(createdAppOptions[0]?.runtimeConfig?.memory?.enabled).toBe(false);
    expect(createdAppOptions[0]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");
    expect(createdAppOptions[1]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(true);
    expect(createdAppOptions[1]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");
    // 开启 Settings 只解除总开关，不覆盖底层 features.memory/use 配置。
    expect(createdAppOptions[1]?.runtimeConfig?.memory?.enabled).toBeUndefined();
  });

  it("reads the latest materialization preferences for a cold resume", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = "sess_native_search_cold_resume" as SessionId;
    const createdAppOptions: ZCodeAppOptions[] = [];
    try {
      await store.createSession({
        id: sessionId,
        projectID: "project_native_search_cold_resume" as ProjectId,
        slug: "native-search-cold-resume",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: "Native search cold resume",
        version: "test-version",
        time: { created: 1, updated: 1 },
      });
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => {
          createdAppOptions.push(options);
          return createFakeApp(options);
        },
        cwd: workspace.workspacePath,
        sessionStore: store,
        version: "test-version",
      });
      const preferenceRequests = attachSessionRuntimePreferencesResponder(server, () => ({
        nativeSearchEnhancementsEnabled: false,
        toolSearchMode: "auto",
        memoryEnabled: false,
        modelContextBudgetStrategy: "preflight-v1",
      }));

      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionResume,
        params: { sessionId },
      });

      expect(preferenceRequests).toHaveLength(1);
      expect(createdAppOptions[0]?.runtimeConfig?.toolSearch).toEqual({ mode: "auto" });
      expect(createdAppOptions[0]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(false);
      expect(createdAppOptions[0]?.runtimeConfig?.memory?.enabled).toBe(false);
      expect(createdAppOptions[0]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");
    } finally {
      await store.close();
    }
  });

  // 远端 Host 同样持有子智能体快照：是否接入只看 Host 声明的能力，不按 workspace 身份排除远程。
  it.each([
    undefined,
    "remote:ssh:example.test:22:dev:/workspace/app",
    "remote:server:example-server:/workspace/app",
  ])(
    "injects pull access into advertised local and remote sessions (%s)",
    async (workspaceIdentity) => {
      const options: ZCodeAppOptions[] = [];
      const reads: unknown[] = [];
      let content = "old";
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (input) => {
          options.push(input);
          return createFakeApp(input);
        },
        cwd: workspace.workspacePath,
        version: "test-version",
      });
      server.setNotificationSink((message) => {
        if (!("id" in message)) return;
        if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          void server.handleMessage({
            id: message.id,
            result: {
              nativeSearchEnhancementsEnabled: true,
              memoryEnabled: false,
              subagentRuntimeConfigEnabled: true,
            },
          });
        }
        if (message.method === zcodeProtocolMethods.subagentsReadRuntimeConfig) {
          reads.push(message.params);
          void server.handleMessage({
            id: message.id,
            result: {
              kind: "ready",
              // Host 返回已解析快照；磁盘文档及启停状态不再跨这个协议边界。
              profiles: [
                {
                  name: "reviewer",
                  description: "review",
                  path: "/agents/reviewer.md",
                  source: "user",
                  systemPrompt: content,
                },
              ],
              builtInModelSelectionOverrides: {},
              pluginAgentModelSelectionOverrides: {},
            },
          });
        }
      });
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          workspace: {
            ...workspace,
            ...(workspaceIdentity ? { workspaceIdentity, workspaceKey: workspaceIdentity } : {}),
          },
        },
      });
      expect(reads).toEqual([]);
      const reader = options[0]?.readSubagentRuntimeConfig;
      expect(reader).toBeTypeOf("function");
      const input = {
        signal: new AbortController().signal,
        traceContext: { traceId: createTraceId(), sessionId: options[0]!.sessionId! },
      };
      expect((await reader!(input)).profiles[0]?.systemPrompt).toBe("old");
      content = "new";
      expect((await reader!(input)).profiles[0]?.systemPrompt).toBe("new");
      expect(reads).toEqual([
        { sessionId: options[0]!.sessionId },
        { sessionId: options[0]!.sessionId },
      ]);
    },
  );

  it("keeps native search on but defaults Memory off when no Host client is attached", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });

    expect(createdAppOptions[0]?.readSubagentRuntimeConfig).toBeUndefined();
    expect(createdAppOptions[0]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(true);
    expect(createdAppOptions[0]?.runtimeConfig?.memory?.enabled).toBe(false);
    expect(createdAppOptions[0]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");
  });

  it("defaults Memory off for an old Host but rejects other preference failures", async () => {
    const oldHostOptions: ZCodeAppOptions[] = [];
    const oldHostServer = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        oldHostOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    oldHostServer.setNotificationSink((message) => {
      if (
        "id" in message &&
        message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
      ) {
        void oldHostServer.handleMessage({
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
    });

    await requestResult(oldHostServer, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });
    expect(oldHostOptions[0]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(true);
    expect(oldHostOptions[0]?.runtimeConfig?.memory?.enabled).toBe(false);
    expect(oldHostOptions[0]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");

    for (const response of [
      { error: { code: -32603, message: "setting read failed" } },
      { result: { nativeSearchEnhancementsEnabled: "invalid" } },
    ]) {
      const createdAppOptions: ZCodeAppOptions[] = [];
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => {
          createdAppOptions.push(options);
          return createFakeApp(options);
        },
        cwd: workspace.workspacePath,
        version: "test-version",
      });
      server.setNotificationSink((message) => {
        if (
          "id" in message &&
          message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
        ) {
          void server.handleMessage({ id: message.id, ...response } as ZCodeProtocolMessage);
        }
      });

      const result = await server.handleMessage({
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      });

      expect(result).toMatchObject({ error: { code: -32603 } });
      expect(createdAppOptions).toHaveLength(0);
    }
  });

  it("times out runtime preference resolution while the Host remains connected", async () => {
    vi.useFakeTimers();
    const createdAppOptions: ZCodeAppOptions[] = [];
    const logs: RecordedLog[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      loggerFactory: createProtocolTestLoggerFactory(logs),
      version: "test-version",
    });
    server.setNotificationSink(() => {
      // 保持 Host 连接但故意不响应，覆盖 transport 不断开时的生命周期收口。
    });

    try {
      const resultPromise = server.handleMessage({
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      });

      await vi.advanceTimersByTimeAsync(ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS);

      await expect(resultPromise).resolves.toMatchObject({
        error: {
          code: -32022,
          data: {
            timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
          },
        },
      });
      expect(createdAppOptions).toHaveLength(0);
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "ZCode Protocol runtime preferences request timed out",
          context: expect.objectContaining({
            errorCode: -32022,
            scope: "runtime-materialization",
            sessionId: expect.any(String),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults Memory off when an older responder omits the preference field", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    attachSessionRuntimePreferencesResponder(server, () => ({
      nativeSearchEnhancementsEnabled: true,
    }));

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });

    expect(createdAppOptions[0]?.readSubagentRuntimeConfig).toBeUndefined();
    expect(createdAppOptions[0]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(true);
    expect(createdAppOptions[0]?.runtimeConfig?.memory?.enabled).toBe(false);
  });

  it("settles queued Session creation when the Host disconnects during preference resolution", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((message) => connection.send(message));
    connection.start();
    input.write(
      [
        {
          id: "create-before-close",
          method: zcodeProtocolMethods.sessionCreate,
          params: { workspace },
        },
        {
          id: "create-queued",
          method: zcodeProtocolMethods.sessionCreate,
          params: { workspace },
        },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n",
    );

    await vi.waitFor(() =>
      expect(written).toContain(zcodeProtocolMethods.sessionRequestRuntimePreferences),
    );
    input.end();
    await connection.waitForClose();

    const messages = written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ZCodeProtocolMessage);
    expect(
      messages.filter(
        (message) =>
          "method" in message &&
          message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences,
      ),
    ).toHaveLength(1);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "create-before-close",
          error: expect.objectContaining({ code: -32603 }),
        }),
        expect.objectContaining({
          id: "create-queued",
          error: expect.objectContaining({ code: -32603 }),
        }),
      ]),
    );
    expect(createdAppOptions).toHaveLength(0);
  });

  it("stops every active Session runtime when the owning protocol transport disconnects", () => {
    const app = createFakeApp();
    const stopActiveForegroundExecution = vi.fn(() => ({
      foregroundExecutionId: "foreground-test",
      kind: "stopped" as const,
    }));
    app.runtime.stopActiveForegroundExecution = stopActiveForegroundExecution;
    const activeAbortController = new AbortController();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: () => app,
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
    context.sessions.set("sess_active", {
      activeAbortController,
      app,
    } as unknown as ZCodeProtocolSessionRecord);
    const disconnectError = new Error("Core owner disconnected");

    server.disconnectClient(disconnectError);

    expect(stopActiveForegroundExecution).toHaveBeenCalledOnce();
    expect(stopActiveForegroundExecution).toHaveBeenCalledWith({
      reason: "ZCode Protocol owner disconnected",
    });
    expect(activeAbortController.signal.aborted).toBe(true);
    expect(activeAbortController.signal.reason).toBe(disconnectError);
  });

  it("initializes the configured integrated terminal shell before the first prompt", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const shellInitializations: unknown[] = [];
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-shell-"));
    const fakeGitBash = join(tempRoot, "bash.exe");
    await writeFile(fakeGitBash, "");
    await chmod(fakeGitBash, 0o755);
    try {
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) =>
          createShellRecordingFakeApp(options, shellInitializations, createdAppOptions),
        cwd: workspace.workspacePath,
        platform: "win32",
        version: "test-version",
      });
      const preferenceRequests = attachSessionRuntimePreferencesResponder(server, (scope) => ({
        nativeSearchEnhancementsEnabled: true,
        ...(scope === "user-execution"
          ? {
              integratedTerminalShell: {
                mode: "shell" as const,
                dialect: "git-bash" as const,
                id: `git-bash:${fakeGitBash}`,
                label: "Git Bash",
                path: fakeGitBash,
              },
            }
          : {}),
      }));

      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: {
            workspace,
          },
        }),
      );

      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId: created.session.sessionId,
          inputId: "input_shell_init",
          content: "first prompt",
        },
      });

      expect(
        preferenceRequests.map((request) => (request.params as { scope: string }).scope),
      ).toEqual(["runtime-materialization", "user-execution"]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }

    expect(createdAppOptions[0]?.runtimeConfig?.bashShellSelection).toBeUndefined();
    expect(shellInitializations).toEqual([
      {
        display: {
          name: "Git Bash",
        },
        dialect: "git-bash",
        id: `git-bash:${fakeGitBash}`,
        label: "Git Bash",
        path: fakeGitBash,
        source: "user-config",
      },
    ]);
  });

  it("does not initialize an unavailable configured integrated terminal shell as the effective snapshot", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const shellInitializations: unknown[] = [];
    const unavailablePath = "Z:\\Missing\\Git\\bin\\bash.exe";
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createShellRecordingFakeApp(options, shellInitializations, createdAppOptions),
      cwd: workspace.workspacePath,
      env: { PATH: "" },
      platform: "win32",
      version: "test-version",
    });
    attachSessionRuntimePreferencesResponder(server, (scope) => ({
      nativeSearchEnhancementsEnabled: true,
      ...(scope === "user-execution"
        ? {
            integratedTerminalShell: {
              mode: "shell" as const,
              dialect: "git-bash" as const,
              id: `git-bash:${unavailablePath}`,
              label: "Git Bash",
              path: unavailablePath,
            },
          }
        : {}),
    }));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          workspace,
        },
      }),
    );

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        inputId: "input_unavailable_shell",
        content: "first prompt",
      },
    });

    expect(createdAppOptions[0]?.runtimeConfig?.bashShellSelection).toBeUndefined();
    expect(shellInitializations[0]).toMatchObject({
      source: expect.not.stringMatching(/^user-config$/u),
    });
    expect((shellInitializations[0] as { path?: string } | undefined)?.path).not.toBe(
      unavailablePath,
    );
  });

  it("keeps an existing session on its first prompt shell when later sends carry a newer shell setting", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-shell-static-"));
    const initialGitBash = join(tempRoot, "initial-bash.exe");
    const laterGitBash = join(tempRoot, "later-bash.exe");
    const shellInitializations: unknown[] = [];
    await writeFile(initialGitBash, "");
    await writeFile(laterGitBash, "");
    await chmod(initialGitBash, 0o755);
    await chmod(laterGitBash, 0o755);
    try {
      let selectedShell = initialGitBash;
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => createShellRecordingFakeApp(options, shellInitializations),
        cwd: workspace.workspacePath,
        platform: "win32",
        version: "test-version",
      });
      const preferenceRequests = attachSessionRuntimePreferencesResponder(server, (scope) => ({
        nativeSearchEnhancementsEnabled: true,
        ...(scope === "user-execution"
          ? {
              integratedTerminalShell: {
                mode: "shell" as const,
                dialect: "git-bash" as const,
                id: `git-bash:${selectedShell}`,
                label: "Git Bash",
                path: selectedShell,
              },
            }
          : {}),
      }));

      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: {
            workspace,
          },
        }),
      );

      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId: created.session.sessionId,
          inputId: "input_shell_init",
          content: "first prompt",
        },
      });

      selectedShell = laterGitBash;

      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionResume,
        params: {
          sessionId: created.session.sessionId,
          workspace,
        },
      });

      await requestResult(server, {
        id: 4,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId: created.session.sessionId,
          inputId: "input_after_shell_change",
          content: "continue",
        },
      });

      expect(
        preferenceRequests.map((request) => (request.params as { scope: string }).scope),
      ).toEqual(["runtime-materialization", "user-execution"]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }

    expect(shellInitializations).toEqual([
      {
        display: {
          name: "Git Bash",
        },
        dialect: "git-bash",
        id: `git-bash:${initialGitBash}`,
        label: "Git Bash",
        path: initialGitBash,
        source: "user-config",
      },
    ]);
  });

  it("initializes a deferred draft shell before accepting its first prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-shell-deferred-"));
    const laterGitBash = join(tempRoot, "later-bash.exe");
    const createdAppOptions: ZCodeAppOptions[] = [];
    const shellInitializations: unknown[] = [];
    await writeFile(laterGitBash, "");
    await chmod(laterGitBash, 0o755);
    try {
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) =>
          createShellRecordingFakeApp(options, shellInitializations, createdAppOptions),
        cwd: workspace.workspacePath,
        platform: "win32",
        version: "test-version",
      });
      attachSessionRuntimePreferencesResponder(server, (scope) => ({
        nativeSearchEnhancementsEnabled: true,
        ...(scope === "user-execution"
          ? {
              integratedTerminalShell: {
                mode: "shell" as const,
                dialect: "git-bash" as const,
                id: `git-bash:${laterGitBash}`,
                label: "Git Bash",
                path: laterGitBash,
              },
            }
          : {}),
      }));

      const draft = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: {
            workspace,
            persistence: "deferred",
          },
        }),
      );

      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId: draft.session.sessionId,
          inputId: "input_deferred_shell_change",
          content: "first prompt",
        },
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }

    expect(createdAppOptions[0]?.runtimeConfig?.bashShellSelection).toBeUndefined();
    expect(shellInitializations).toEqual([
      {
        display: { name: "Git Bash" },
        dialect: "git-bash",
        id: `git-bash:${laterGitBash}`,
        label: "Git Bash",
        path: laterGitBash,
        source: "user-config",
      },
    ]);
  });

  it("rejects integrated terminal shell params on create, resume, and send", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
      platform: "win32",
      version: "test-version",
    });
    const integratedTerminalShell = {
      mode: "shell",
      dialect: "git-bash",
      id: "git-bash:/tmp/bash.exe",
      label: "Git Bash",
      path: "/tmp/bash.exe",
    };

    await expect(
      server.handleMessage({
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          workspace,
          integratedTerminalShell,
        } as never,
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
      },
    });
    await expect(
      server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionResume,
        params: {
          sessionId: "sess_shell_resume_schema",
          workspace,
          integratedTerminalShell,
        } as never,
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
      },
    });
    await expect(
      server.handleMessage({
        id: 3,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId: "sess_shell_send_schema",
          content: "hello",
          integratedTerminalShell,
        } as never,
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
      },
    });
  });

  it("keeps deferred draft sessions out of session/list until the first send", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
    });

    const draft = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace, persistence: "deferred" },
      }),
    );

    const hiddenList = zcodeSessionListResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionList,
        params: { workspace },
      }),
    );
    expect(hiddenList.sessions.map((session) => session.sessionId)).not.toContain(
      draft.session.sessionId,
    );

    await requestResult(server, {
      id: 3,
      method: zcodeProtocolMethods.sessionSend,
      params: { sessionId: draft.session.sessionId, content: "hello" },
    });

    const visibleList = zcodeSessionListResultSchema.parse(
      await requestResult(server, {
        id: 4,
        method: zcodeProtocolMethods.sessionList,
        params: { workspace },
      }),
    );
    expect(visibleList.sessions.map((session) => session.sessionId)).toContain(
      draft.session.sessionId,
    );
  });

  it("keeps server-owned model state and emits state update notifications", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    const updated = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSetModel,
        params: {
          sessionId: created.session.sessionId,
          model: { providerId: "glm", modelId: "glm-4-air" },
          expectedRevision: created.runtime.stateRevision,
        },
      }),
    );

    expect(updated.settings.model.current).toEqual({ providerId: "glm", modelId: "glm-4-air" });
    expect(updated.runtime.stateRevision).toBe(created.runtime.stateRevision + 1);
    // 新生命周期合同在 create 时发布 starting/ready；模型状态断言只读取自己的通知域。
    expect(
      notifications.filter((notification) => notification.method === "state.updated"),
    ).toMatchObject([
      {
        method: "state.updated",
        params: {
          type: "state.updated",
          scope: "session",
          sessionId: created.session.sessionId,
          reason: "model_changed",
        },
      },
    ]);
  });

  it("maps a protocol session model to structured Runtime Selection", async () => {
    const createdAppOptions: ZCodeAppOptions[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdAppOptions.push(options);
        return createFakeApp(options);
      },
      cwd: workspace.workspacePath,
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: {
        workspace,
        model: {
          providerId: "glm",
          modelId: "glm-4-air",
          options: { reasoningLevel: "deep" },
        },
      },
    });

    expect(createdAppOptions[0]?.runtimeConfig?.modelSelection).toEqual({
      providerId: "glm",
      modelId: "glm-4-air",
      options: { reasoningLevel: "deep" },
    });
  });

  it("resumes persisted sessions with the latest historical model and mode", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = "sess_history" as SessionId;
    const userMessageId = "msg_user_history" as MessageId;
    const assistantMessageId = "msg_assistant_history" as MessageId;
    try {
      await store.createSession({
        id: sessionId,
        projectID: "project_history" as ProjectId,
        slug: "history-session",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: "History session",
        version: "test-version",
        time: { created: 1, updated: 4 },
      });
      await store.saveMessage({
        id: userMessageId,
        sessionID: sessionId,
        role: "user",
        time: { created: 2 },
        agent: "zcode-agent",
        modelSelection: {
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4-air" as ModelId,
        },
        tools: {},
      });
      await store.saveMessage({
        id: assistantMessageId,
        sessionID: sessionId,
        role: "assistant",
        time: { created: 3, completed: 4 },
        parentID: userMessageId,
        providerId: "glm" as ModelProviderId,
        modelId: "glm-4-air" as ModelId,
        mode: "plan",
        agent: "zcode-agent",
        path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
        cost: 0,
        tokens: { input: 12345, output: 67, reasoning: 0, cache: { read: 2345, write: 678 } },
      });

      const appOptions: ZCodeAppOptions[] = [];
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => {
          appOptions.push(options ?? {});
          return createFakeApp(options);
        },
        cwd: workspace.workspacePath,
        sessionStore: store,
      });

      const resumed = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionResume,
          params: { sessionId, workspace },
        }),
      );

      expect(appOptions[0]?.runtimeConfig).toMatchObject({ mode: "plan" });
      // 当前结构只能来自 Session 当前选择 entry；Protocol 不再把历史消息伪装成当前选择。
      expect(appOptions[0]?.runtimeConfig?.modelSelection).toBeUndefined();
      // Process Registry 在协议入口启动时已经就绪，冷恢复不再创建旧 deferred adapter。
      expect(appOptions[0]?.modelAdapter).toBeUndefined();
      expect(resumed.settings).toMatchObject({
        mode: { current: "plan" },
        model: { current: { providerId: "glm", modelId: "glm-4.6" } },
      });
      expect(resumed.projection.lastError).toBeUndefined();
      expect(resumed.runtime.contextUsage).toEqual({
        used: 12412,
        size: 128000,
        cost: null,
        cache: {
          inputTokens: 12345,
          cacheReadTokens: 2345,
          cacheWriteTokens: 678,
          latestHitRate: 2345 / 12345,
          hitRate: 2345 / 12345,
          hitRateRequestCount: 1,
          totalInputTokens: 12345,
          totalCacheReadTokens: 2345,
          totalCacheWriteTokens: 678,
        },
      });
      expect(resumed.messages.map((message) => message.info.model)).toEqual([
        { providerId: "glm", modelId: "glm-4-air" },
        { providerId: "glm", modelId: "glm-4-air" },
      ]);

      const sendResult = await server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: { sessionId, content: "continue" },
      });
      expect(sendResult).toMatchObject({ id: 2, result: expect.any(Object) });
    } finally {
      store.close();
    }
  });

  it("resume 回填持久化 taskType：workflow_child 绝不落回缺省 interactive", async () => {
    // Bug 根因（2026-08-24 实测）：resume 物化 record 时丢掉了持久化的 taskType（fork 路径
    // 一直带着，resume 路径没带），createRecord 落回缺省 "interactive"。于是被 resume 的
    // dwf actor 会话通过 isTaskListSessionType 的筛，经 getSessionWorkspaceId 漏进
    // sessions-index，desktop 任务列表里长出 25 条「workflow actor actor#N@k」假任务。
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = "sess_dwf_actor_tasktype" as SessionId;
    try {
      await store.createSession({
        id: sessionId,
        projectID: "project_tasktype" as ProjectId,
        slug: "dwf-actor-tasktype",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: "workflow actor actor#1@1",
        version: "test-version",
        taskType: "workflow_child",
        time: { created: 1, updated: 2 },
      });

      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => createFakeApp(options),
        cwd: workspace.workspacePath,
        sessionStore: store,
      });

      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionResume,
        params: { sessionId, workspace },
      });

      const record = (
        server as unknown as { context: ZCodeProtocolAgentServerContext }
      ).context.sessions.get(sessionId);
      expect(record?.taskType).toBe("workflow_child");
    } finally {
      store.close();
    }
  });

  it("workspace presentation omits model facts", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
    });

    const presentation = zcodeWorkspacePresentationSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.workspaceReadPresentation,
        params: { workspace },
      }),
    );

    expect(presentation.mode).toBe("build");
    expect("model" in presentation).toBe(false);
    expect("settings" in presentation).toBe(false);
  });

  it("通过独立协议同步 Account Config，不再从 Workspace Snapshot 反向投影", async () => {
    const syncAccountProviderConfig = vi.fn(async () => true);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: () => createFakeApp(),
      cwd: workspace.workspacePath,
      syncAccountProviderConfig,
    });

    const result = await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.providerUpdateAccountConfig,
      params: {
        revision: "account-1",
        basedOnZCodeBuiltinRevision: "zcode-builtin:1",
        states: {
          "account:zai-individual-coding-plan": {
            availability: "available",
            entitled: true,
            current: false,
          },
        },
        providers: {
          "account:zai-individual-coding-plan": {
            access: { type: "zhipu-account", entitled: true },
            builtinModelIds: ["GLM-5.2"],
          },
        },
      },
    });

    expect(result).toEqual({
      receivedRevision: "account-1",
      providerCount: 1,
      status: "received",
    });
    expect(syncAccountProviderConfig).toHaveBeenCalledTimes(1);
    const snapshot = syncAccountProviderConfig.mock.calls[0]?.[0];
    expect(snapshot?.revision).toBe("account-1");
    expect(snapshot?.basedOnZCodeBuiltinRevision).toBe("zcode-builtin:1");
    expect(snapshot?.states?.["account:zai-individual-coding-plan"].current).toBe(false);
    expect(snapshot?.providers.get("account:zai-individual-coding-plan")?.toJSON()).toEqual({
      access: { type: "zhipu-account", entitled: true },
      builtinModelIds: ["GLM-5.2"],
    });
  });

  it("在执行前刷新 Worker 自己的 Provider Registry，不接收 Desktop 快照", async () => {
    const refreshProviderRegistry = vi.fn(async (reason: string) => {
      expect(reason).toBe("before-turn");
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: () => createFakeApp(),
      cwd: workspace.workspacePath,
      refreshProviderRegistry,
    });

    const result = await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.providerRefreshRegistry,
      params: { reason: "before-turn" },
    });

    expect(zcodeProviderRefreshRegistryResultSchema.parse(result)).toEqual({
      refreshed: true,
    });
    expect(refreshProviderRegistry).toHaveBeenCalledTimes(1);
  });

  it("workspace presentation rejects legacy runtimeModel", async () => {
    const firstProviderRuntimeModel = {
      generatedAt: 2,
      model: {
        modelId: "first-model",
        providerId: "provider-first",
      },
      provider: {
        baseURL: "https://first.example.com/v1",
        kind: "openai-compatible" as const,
        models: [
          {
            label: "First Model",
            modelId: "first-model",
            reasoning: {
              defaultLevel: "max",
              enabled: true,
              levels: [
                { label: "High", value: "high" },
                { label: "Max", value: "max" },
              ],
            },
          },
        ],
        providerId: "provider-first",
      },
      revision: "model-runtime:first-provider-default",
      thoughtLevel: "max",
    };
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
    });

    const rejected = await server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.workspaceReadPresentation,
      params: {
        runtimeModel: firstProviderRuntimeModel,
        workspace,
      },
    });
    expect(rejected).toMatchObject({
      error: { code: -32602 },
      id: 2,
    });
  });

  it("uses app-provided thought level when creating a session", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: workspace.workspacePath,
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          workspace,
          model: { providerId: "glm", modelId: "glm-4-air" },
          thoughtLevel: "deep",
        },
      }),
    );

    expect(created.settings).toMatchObject({
      model: { current: { providerId: "glm", modelId: "glm-4-air" } },
      thoughtLevel: { current: "deep" },
    });
  });

  it("acks session/send before the prompt turn finishes", async () => {
    let resolveSendInput!: () => void;
    let sendInputSettled = false;
    let receivedInputId: string | undefined;
    let receivedBrowserAmbientContext: unknown;
    let receivedOffPeakTaskId: string | undefined;
    let receivedOffPeakRunType: string | undefined;
    const sendInputCompletion = new Promise<void>((resolve) => {
      resolveSendInput = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async (_input, options) => {
            receivedInputId = options?.inputId;
            receivedBrowserAmbientContext = options?.browserAmbientContext;
            receivedOffPeakTaskId = options?.offPeakTaskId;
            receivedOffPeakRunType = options?.offPeakRunType;
            await sendInputCompletion;
            sendInputSettled = true;
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    const sendResponse = server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "hello",
        inputId: "t-sess_test-run",
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "resume",
        browserAmbientContext: {
          tabCount: 1,
          currentUrl: "https://example.com/current",
        },
        expectedRevision: created.runtime.stateRevision,
      },
    });
    const raceResult = await Promise.race([
      sendResponse.then((response) => ({ response, status: "resolved" as const })),
      new Promise<{ status: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ status: "timeout" }), 20),
      ),
    ]);

    expect(raceResult.status).toBe("resolved");
    expect(receivedInputId).toBe("t-sess_test-run");
    expect(receivedBrowserAmbientContext).toEqual({
      tabCount: 1,
      currentUrl: "https://example.com/current",
    });
    expect(receivedOffPeakTaskId).toBe("off-peak-task-1");
    expect(receivedOffPeakRunType).toBe("resume");
    expect(sendInputSettled).toBe(false);
    resolveSendInput();
    await sendInputCompletion;
  });

  it("Bot 私聊带附件走 legacy session/send 时，ambient 块不声明设计模式", async () => {
    // Bot 私聊带附件时 Host 仍走旧版 session/send（zcodeTaskServiceAdapter 附件回退）。旧协议没有
    // inputOrigin 字段，Core 拿不到「桌面输入」，所以不写「Design mode: available」——锁住这一现状。
    let receivedOptions: SendInputOptions | undefined;
    let resolveSendInput!: () => void;
    const sendInputCalled = new Promise<void>((resolve) => {
      resolveSendInput = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async (_input, sendOptions) => {
            receivedOptions = sendOptions;
            resolveSendInput();
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "E2E_BOT_ATTACHMENT 看图",
        inputId: "bot-legacy-input",
        browserAmbientContext: { tabCount: 1, currentUrl: "http://localhost:5173/" },
        botDeliveryTarget: {
          provider: "feishu",
          botId: "bot-1",
          providerUserId: "ou_user",
          chatType: "private",
        },
        expectedRevision: created.runtime.stateRevision,
      },
    });
    await sendInputCalled;
    expect(receivedOptions?.browserAmbientContext).toEqual({
      tabCount: 1,
      currentUrl: "http://localhost:5173/",
    });
    expect(receivedOptions?.intent?.inputOrigin).toBeUndefined();
    // 与 Core turn.ts 相同的取值：inputOrigin / clientId 都来自 intent。
    const content = String(
      buildRuntimeUserEntriesFromTurn("E2E_BOT_ATTACHMENT 看图", [], {
        browserAmbientContext: receivedOptions?.browserAmbientContext,
        ...(receivedOptions?.intent?.inputOrigin
          ? { inputOrigin: receivedOptions.intent.inputOrigin }
          : {}),
        ...(receivedOptions?.intent?.clientId
          ? { inputClientId: receivedOptions.intent.clientId }
          : {}),
      })[0]?.message.content,
    );
    expect(content).toContain("- The user has the in-app browser open with 1 tab.");
    expect(content).not.toContain("Design mode");
  });

  it("legacy session/send 在 busy 入队时把显式 automation 身份交给 Core admission", async () => {
    let receivedAutomationId: string | undefined;
    let receivedToolDisallowlist: readonly string[] | undefined;
    let resolveSendInputStarted!: () => void;
    const sendInputStarted = new Promise<void>((resolve) => {
      resolveSendInputStarted = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async (_input, sendOptions) => {
            receivedAutomationId = sendOptions?.automationId;
            receivedToolDisallowlist = sendOptions?.toolDisallowlist;
            resolveSendInputStarted();
            return {
              kind: "queued",
              pendingInputId: "pending-automation-queued",
              queueLength: 1,
              turnId: "turn-busy" as never,
            };
          },
        }),
      cwd: workspace.workspacePath,
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "automation busy prompt",
        automationId: "automation-queued",
        inputId: "automation-queued:scheduled:run-1",
        expectedRevision: created.runtime.stateRevision,
      },
    });
    await sendInputStarted;

    expect(receivedAutomationId).toBe("automation-queued");
    expect(receivedToolDisallowlist).toEqual(["CronCreate"]);
  });

  it("does not restore automation identity from a caller-controlled inputId", async () => {
    let receivedAutomationId: string | undefined;
    let receivedToolDisallowlist: readonly string[] | undefined;
    let resolveSendInputStarted!: () => void;
    const sendInputStarted = new Promise<void>((resolve) => {
      resolveSendInputStarted = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async (_input, options) => {
            receivedAutomationId = options?.automationId;
            receivedToolDisallowlist = options?.toolDisallowlist;
            resolveSendInputStarted();
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "ordinary prompt",
        inputId: "automation-other-task:manual:forged-run",
        expectedRevision: created.runtime.stateRevision,
      },
    });
    await sendInputStarted;

    expect(receivedAutomationId).toBeUndefined();
    expect(receivedToolDisallowlist).toBeUndefined();
  });

  it("emits prompt_completed after the active prompt lock is released", async () => {
    let sessionId = "";
    let secondSendDuringCompleted: Promise<unknown> | undefined;
    let finalizationCountDuringCompleted: number | undefined;
    let activeLockDuringCompleted: AbortController | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async () => ({
            kind: "started_turn",
            turnId: "completed-fixture" as never,
            completion: Promise.resolve({} as never),
          }),
        }),
      cwd: workspace.workspacePath,
    });
    setTestNotificationSink(server, (notification) => {
      if (
        notification.method === "state.updated" &&
        (notification.params as { reason?: string }).reason === "prompt_completed" &&
        !secondSendDuringCompleted
      ) {
        const record = (
          server as unknown as { context: ZCodeProtocolAgentServerContext }
        ).context.sessions.get(sessionId);
        finalizationCountDuringCompleted = record?.residencyFinalizationCount;
        activeLockDuringCompleted = record?.activeAbortController;
        secondSendDuringCompleted = server.handleMessage({
          id: 3,
          method: zcodeProtocolMethods.sessionSend,
          params: {
            sessionId,
            content: "second",
            inputId: "input_second",
          },
        });
      }
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    sessionId = created.session.sessionId;

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId,
        content: "first",
        inputId: "input_first",
        expectedRevision: created.runtime.stateRevision,
      },
    });

    await vi.waitFor(() => {
      expect(secondSendDuringCompleted).toBeDefined();
    });
    const secondResponse = await secondSendDuringCompleted;

    expect(secondResponse).toMatchObject({
      result: {
        accepted: true,
        sessionId,
      },
    });
    expect(activeLockDuringCompleted).toBeUndefined();
    expect(finalizationCountDuringCompleted).toBe(1);
    await vi.waitFor(() => {
      const record = (
        server as unknown as { context: ZCodeProtocolAgentServerContext }
      ).context.sessions.get(sessionId);
      expect(record?.residencyFinalizationCount).toBe(0);
    });
  });

  it("maps protocol localPath attachments before sending input to core", async () => {
    let receivedInput: unknown;
    let resolveReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async (input) => {
            receivedInput = input;
            resolveReceived();
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "inspect attachments",
        expectedRevision: created.runtime.stateRevision,
        attachments: [
          {
            kind: "file",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 0,
            localPath: "/tmp/report.pdf",
          },
          {
            kind: "file",
            filename: "pasted-text.txt",
            mimeType: "text/plain",
            sizeBytes: 8192,
            localPath: "/tmp/.zcode/tmp/paste-attachments/2026-06-30/pasted-text.txt",
            sourceKind: "clipboard-text",
          },
          {
            kind: "image",
            filename: "diagram.png",
            mimeType: "image/png",
            localPath: "/tmp/diagram.png",
          },
        ],
      },
    });
    await received;

    expect(receivedInput).toMatchObject({
      text: "inspect attachments",
      attachments: [
        { path: "/tmp/report.pdf", type: "pdf" },
        {
          path: "/tmp/.zcode/tmp/paste-attachments/2026-06-30/pasted-text.txt",
          sourceKind: "clipboard-text",
          type: "file",
        },
        { path: "/tmp/diagram.png", type: "image" },
      ],
    });
  });

  it("bridges protocol permission requests through server-to-client JSON-RPC", async () => {
    const outgoing: ZCodeProtocolMessage[] = [];
    const origin = {
      kind: "subagent",
      agentId: "agent_perm",
      agentType: "general",
      childSessionId: "sess_child_perm",
      childTurnId: "turn_child_perm",
      parentSessionId: "sess_parent_perm",
      parentToolCallId: "tool_parent_agent",
      parentTurnId: "turn_parent_perm",
    } as const;
    let brokerResult:
      | Awaited<ReturnType<NonNullable<ZCodeAppOptions["permissionBroker"]>["requestPermission"]>>
      | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async () => {
            brokerResult = await options?.permissionBroker?.requestPermission({
              input: { command: "rm -rf tmp" },
              mode: "build",
              origin,
              reason: "Bash requires approval",
              requestId: "perm_1",
              requestedAt: new Date(1),
              riskLevel: "high",
              ruleId: "rule_1",
              sessionId: (options?.sessionId ?? "sess_test") as never,
              toolCallId: "tool_1" as never,
              toolName: "Bash",
              traceId: "trace_test" as never,
            });
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });
    setTestNotificationSink(server, (message) => outgoing.push(message));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: { sessionId: created.session.sessionId, content: "run command" },
    });

    await vi.waitFor(() => {
      expect(outgoing.some((message) => message.method === "interaction/requestPermission")).toBe(
        true,
      );
    });
    const permissionRequest = outgoing.find(
      (message) => message.method === "interaction/requestPermission" && "id" in message,
    );
    expect(permissionRequest).toMatchObject({
      method: "interaction/requestPermission",
      params: {
        options: [
          {
            optionId: "allow_once",
            response: { decision: "allow" },
          },
          {
            optionId: "allow_project",
            response: {
              decision: "allow",
              permissionUpdates: [
                {
                  behavior: "allow",
                  rules: [{ ruleContent: "rm -rf tmp", toolName: "Bash" }],
                  type: "addRules",
                },
              ],
            },
          },
          {
            optionId: "deny",
            response: { decision: "deny" },
          },
        ],
        origin,
        requestId: "perm_1",
        toolName: "Bash",
      },
    });

    await server.handleMessage({ id: permissionRequest?.id ?? "", result: { decision: "allow" } });
    await vi.waitFor(() => {
      expect(brokerResult).toMatchObject({ decision: "allow" });
    });
  });

  it("reannounces pending protocol permission requests so a later client request can be answered", async () => {
    vi.useFakeTimers();
    try {
      const outgoing: ZCodeProtocolMessage[] = [];
      let brokerResultPromise:
        | ReturnType<NonNullable<ZCodeAppOptions["permissionBroker"]>["requestPermission"]>
        | undefined;
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) =>
          createFakeApp(options, {
            sendInput: async () => {
              brokerResultPromise = options?.permissionBroker?.requestPermission({
                input: { command: "rm -rf tmp" },
                mode: "build",
                reason: "Bash requires approval",
                requestId: "perm_reannounce",
                requestedAt: new Date(1),
                riskLevel: "high",
                ruleId: "rule_1",
                sessionId: (options?.sessionId ?? "sess_test") as never,
                toolCallId: "tool_1" as never,
                toolName: "Bash",
                traceId: "trace_test" as never,
              });
              await brokerResultPromise;
              return { kind: "rejected", reason: "no_active_turn" };
            },
          }),
        cwd: workspace.workspacePath,
      });
      setTestNotificationSink(server, (message) => outgoing.push(message));

      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: { workspace },
        }),
      );
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: { sessionId: created.session.sessionId, content: "run command" },
      });

      await vi.waitFor(() => {
        expect(brokerResultPromise).toBeDefined();
      });
      const firstRequest = outgoing.find(
        (message) => message.method === "interaction/requestPermission" && "id" in message,
      );
      expect(firstRequest).toMatchObject({
        method: "interaction/requestPermission",
        params: {
          requestId: "perm_reannounce",
          toolName: "Bash",
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const permissionRequests = outgoing.filter(
        (message) => message.method === "interaction/requestPermission" && "id" in message,
      );
      expect(permissionRequests).toHaveLength(2);
      expect(permissionRequests[1]).toMatchObject({
        method: "interaction/requestPermission",
        params: {
          requestId: "perm_reannounce",
          toolName: "Bash",
        },
      });
      const firstProtocolRequestId =
        firstRequest && "id" in firstRequest ? firstRequest.id : undefined;
      expect(permissionRequests[1]?.id).not.toBe(firstProtocolRequestId);

      await server.handleMessage({
        id: permissionRequests[1]?.id ?? "",
        result: { decision: "allow" },
      });
      await expect(brokerResultPromise).resolves.toMatchObject({
        decision: "allow",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bridges AskUserQuestion through protocol user input requests", async () => {
    const outgoing: ZCodeProtocolMessage[] = [];
    const origin = {
      kind: "subagent",
      agentId: "agent_ask",
      agentType: "general",
      childSessionId: "sess_child_ask",
      childTurnId: "turn_child_ask",
      parentSessionId: "sess_parent_ask",
      parentToolCallId: "tool_parent_agent",
      parentTurnId: "turn_parent_ask",
    } as const;
    let brokerResult:
      | Awaited<ReturnType<NonNullable<ZCodeAppOptions["permissionBroker"]>["requestPermission"]>>
      | undefined;
    const askInput = {
      questions: [
        {
          question: "Which branch should I test?",
          header: "Branch",
          options: [
            { label: "main", description: "Use main branch" },
            { label: "release", description: "Use release branch" },
          ],
        },
      ],
    };
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async () => {
            brokerResult = await options?.permissionBroker?.requestPermission({
              input: askInput,
              mode: "build",
              origin,
              reason: "AskUserQuestion pauses execution to collect answers from the user",
              requestId: "ask_1",
              requestedAt: new Date(1),
              riskLevel: "low",
              ruleId: "rule_ask",
              sessionId: (options?.sessionId ?? "sess_test") as never,
              toolCallId: "tool_ask" as never,
              toolName: "AskUserQuestion",
              traceId: "trace_test" as never,
            });
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });
    setTestNotificationSink(server, (message) => outgoing.push(message));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: { sessionId: created.session.sessionId, content: "ask" },
    });

    await vi.waitFor(() => {
      expect(outgoing.some((message) => message.method === "interaction/requestUserInput")).toBe(
        true,
      );
    });
    const userInputRequest = outgoing.find(
      (message) => message.method === "interaction/requestUserInput" && "id" in message,
    );
    expect(userInputRequest).toMatchObject({
      method: "interaction/requestUserInput",
      params: {
        origin,
        requestId: "ask_1",
        questions: [{ question: "Which branch should I test?" }],
      },
    });

    await server.handleMessage({
      id: userInputRequest?.id ?? "",
      result: {
        action: "accept",
        content: {
          answers: { "Which branch should I test?": "release" },
          answer_0: "release",
          answer: "release",
        },
      },
    });
    await vi.waitFor(() => {
      expect(brokerResult).toMatchObject({
        decision: "modify",
        modifiedInput: {
          answers: { "Which branch should I test?": "release" },
          questions: askInput.questions,
        },
      });
    });
    expect(
      (brokerResult as { modifiedInput?: Record<string, unknown> }).modifiedInput,
    ).not.toHaveProperty("answer_0");
    expect(
      (brokerResult as { modifiedInput?: Record<string, unknown> }).modifiedInput,
    ).not.toHaveProperty("answer");
  });

  it("bridges ExitPlanMode approval through protocol user input requests", async () => {
    const outgoing: ZCodeProtocolMessage[] = [];
    const origin = {
      kind: "subagent",
      agentId: "agent_exit_plan",
      agentType: "general",
      childSessionId: "sess_child_exit_plan",
      childTurnId: "turn_child_exit_plan",
      parentSessionId: "sess_parent_exit_plan",
      parentToolCallId: "tool_parent_agent",
      parentTurnId: "turn_parent_exit_plan",
    } as const;
    let brokerResult:
      | Awaited<ReturnType<NonNullable<ZCodeAppOptions["permissionBroker"]>["requestPermission"]>>
      | undefined;
    const exitPlanInput = {
      plan: "1. Change the runtime\n2. Add tests",
    };
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          sendInput: async () => {
            brokerResult = await options?.permissionBroker?.requestPermission({
              input: exitPlanInput,
              mode: "plan",
              origin,
              reason: "ExitPlanMode requires user approval before implementation",
              requestId: "exit_plan_1",
              requestedAt: new Date(1),
              riskLevel: "high",
              ruleId: "rule_exit_plan",
              sessionId: (options?.sessionId ?? "sess_test") as never,
              toolCallId: "tool_exit_plan" as never,
              toolName: "ExitPlanMode",
              traceId: "trace_test" as never,
            });
            return { kind: "rejected", reason: "no_active_turn" };
          },
        }),
      cwd: workspace.workspacePath,
    });
    setTestNotificationSink(server, (message) => outgoing.push(message));

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );
    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: { sessionId: created.session.sessionId, content: "plan" },
    });

    await vi.waitFor(() => {
      expect(outgoing.some((message) => message.method === "interaction/requestUserInput")).toBe(
        true,
      );
    });
    expect(outgoing.some((message) => message.method === "interaction/requestPermission")).toBe(
      false,
    );
    const userInputRequest = outgoing.find(
      (message) => message.method === "interaction/requestUserInput" && "id" in message,
    );
    expect(userInputRequest).toMatchObject({
      method: "interaction/requestUserInput",
      params: {
        origin,
        requestId: "exit_plan_1",
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        questions: [
          {
            header: "Plan",
            options: [{ value: "approve", label: "Approve" }],
          },
        ],
      },
    });

    await server.handleMessage({
      id: userInputRequest?.id ?? "",
      result: {
        action: "accept",
        content: {
          answer_0: "Please add tests before implementation.",
          answer: "Please add tests before implementation.",
        },
      },
    });
    await vi.waitFor(() => {
      expect(brokerResult).toMatchObject({
        decision: "deny",
        reason: "Please add tests before implementation.",
        reasonSource: "plan_approval_feedback",
      });
    });
  });

  it("reannounces pending ExitPlanMode approval so a later client request can be answered", async () => {
    vi.useFakeTimers();
    try {
      const outgoing: ZCodeProtocolMessage[] = [];
      let brokerResultPromise:
        | ReturnType<NonNullable<ZCodeAppOptions["permissionBroker"]>["requestPermission"]>
        | undefined;
      const exitPlanInput = {
        plan: "1. Change the runtime\n2. Add tests",
      };
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) =>
          createFakeApp(options, {
            sendInput: async () => {
              brokerResultPromise = options?.permissionBroker?.requestPermission({
                input: exitPlanInput,
                mode: "plan",
                reason: "ExitPlanMode requires user approval before implementation",
                requestId: "exit_plan_reannounce",
                requestedAt: new Date(1),
                riskLevel: "high",
                ruleId: "rule_exit_plan",
                sessionId: (options?.sessionId ?? "sess_test") as never,
                toolCallId: "tool_exit_plan" as never,
                toolName: "ExitPlanMode",
                traceId: "trace_test" as never,
              });
              await brokerResultPromise;
              return { kind: "rejected", reason: "no_active_turn" };
            },
          }),
        cwd: workspace.workspacePath,
      });
      setTestNotificationSink(server, (message) => outgoing.push(message));

      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: { workspace },
        }),
      );
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: { sessionId: created.session.sessionId, content: "plan" },
      });

      await vi.waitFor(() => {
        expect(brokerResultPromise).toBeDefined();
      });
      const firstRequest = outgoing.find(
        (message) => message.method === "interaction/requestUserInput" && "id" in message,
      );
      expect(firstRequest).toMatchObject({
        method: "interaction/requestUserInput",
        params: {
          requestId: "exit_plan_reannounce",
          schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const userInputRequests = outgoing.filter(
        (message) => message.method === "interaction/requestUserInput" && "id" in message,
      );
      expect(userInputRequests).toHaveLength(2);
      expect(userInputRequests[1]).toMatchObject({
        method: "interaction/requestUserInput",
        params: {
          requestId: "exit_plan_reannounce",
          schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        },
      });
      const firstProtocolRequestId =
        firstRequest && "id" in firstRequest ? firstRequest.id : undefined;
      expect(userInputRequests[1]?.id).not.toBe(firstProtocolRequestId);

      await server.handleMessage({
        id: userInputRequests[1]?.id ?? "",
        result: {
          action: "accept",
          content: {
            answer_0: "approve",
            answer: "approve",
          },
        },
      });
      await expect(brokerResultPromise).resolves.toMatchObject({
        decision: "allow",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // M5 ③-4：session/rewind、session/rewindCascade 旧协议词已删除（v4 fork/edit/retry
  // 经原生 handler 直发 `/rewind conversation <messageId>` slash command，见
  // zcode-protocol-v4/commands/handlers/fork-edit-retry.ts）；本用例收敛为 compact 单验证。
  it("runs compact through the explicit session protocol method", async () => {
    const submittedPrompts: string[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          submitPrompt: async (prompt) => {
            submittedPrompts.push(typeof prompt === "string" ? prompt : prompt.text);
            return { response: `ok:${submittedPrompts.at(-1)}` } as never;
          },
        }),
      cwd: workspace.workspacePath,
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    const compacted = zcodeSessionCompactResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionCompact,
        params: {
          sessionId: created.session.sessionId,
          instructions: "keep recent files",
        },
      }),
    );

    expect(submittedPrompts).toEqual(["/compact keep recent files"]);
    expect(compacted.response).toBe("");
    expect(compacted.compact?.state).toBe("accepted");
  });

  it("aborts in-flight compact requests when the session is stopped", async () => {
    let resolveCompactStarted!: () => void;
    let resolveCompactAborted!: () => void;
    let compactSignal: AbortSignal | undefined;
    const compactStarted = new Promise<void>((resolve) => {
      resolveCompactStarted = resolve;
    });
    const compactAborted = new Promise<void>((resolve) => {
      resolveCompactAborted = resolve;
    });
    const submitPrompt = vi.fn(async (_prompt, options) => {
      compactSignal = options?.abortSignal;
      resolveCompactStarted();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          resolveCompactAborted();
          reject(options?.abortSignal?.reason ?? new Error("compact aborted"));
        };
        if (options?.abortSignal?.aborted) {
          abort();
          return;
        }
        options?.abortSignal?.addEventListener("abort", abort, { once: true });
      });
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { submitPrompt }),
      cwd: workspace.workspacePath,
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    const compactResponse = server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.sessionCompact,
      params: {
        sessionId: created.session.sessionId,
        inputId: "input-compact",
        instructions: "keep recent files",
      },
    });
    await compactStarted;

    expect(compactSignal?.aborted).toBe(false);
    await requestResult(server, {
      id: 3,
      method: zcodeProtocolMethods.sessionStop,
      params: { sessionId: created.session.sessionId },
    });
    await compactAborted;

    expect(compactSignal?.aborted).toBe(true);
    expect(submitPrompt).toHaveBeenCalledWith(
      "/compact keep recent files",
      expect.objectContaining({
        abortSignal: compactSignal,
        inputId: "input-compact",
      }),
    );
    const response = await compactResponse;
    const result = zcodeSessionCompactResultSchema.parse(
      response && "result" in response ? response.result : undefined,
    );
    expect(result.compact?.state).toBe("accepted");
  });

  it("generates workspace text through an active app", async () => {
    const generateWorkspaceText = vi.fn(async (input: { prompt: string; querySource: string }) => ({
      text: `generated:${input.querySource}:${input.prompt}`,
      selection: { providerId: "glm", modelId: "glm-4.6" },
      finishReason: "length",
      usage: { inputTokens: 3, outputTokens: 256, totalTokens: 259 },
    }));
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { generateWorkspaceText }),
      cwd: workspace.workspacePath,
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });
    const result = zcodeWorkspaceGenerateTextResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.workspaceGenerateText,
        params: {
          workspace,
          selection: { providerId: "glm", modelId: "glm-4.6" },
          prompt: "write a commit message",
          querySource: "git_commit_message",
          maxOutputTokens: 256,
        },
      }),
    );

    expect(result).toEqual({
      text: "generated:git_commit_message:write a commit message",
      selection: { providerId: "glm", modelId: "glm-4.6" },
      finishReason: "length",
      usage: { inputTokens: 3, outputTokens: 256, totalTokens: 259 },
    });
    expect(generateWorkspaceText).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { providerId: "glm", modelId: "glm-4.6" },
        prompt: "write a commit message",
        querySource: "git_commit_message",
        maxOutputTokens: 256,
      }),
      { abortSignal: undefined },
    );
    expect(generateWorkspaceText.mock.calls[0]?.[0]).not.toHaveProperty("modelSelection");
  });

  it("tests provider connectivity through the selected formal Model", async () => {
    const calls: string[] = [];
    const refreshProviderRegistry = vi.fn(async () => {
      calls.push("refresh");
    });
    const testModelConnectivity = vi.fn(async () => {});
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        createFakeApp(options, {
          testModelConnectivity: async (...args) => {
            calls.push("connectivity");
            await testModelConnectivity(...args);
          },
        }),
      cwd: workspace.workspacePath,
      refreshProviderRegistry,
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    });
    const result = zcodeProviderTestModelConnectivityResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.providerTestModelConnectivity,
        params: {
          workspace,
          selection: {
            providerId: "custom-openai",
            modelId: "agent-model",
            options: { reasoningLevel: "high" },
          },
        },
      }),
    );

    expect(result).toEqual({ success: true });
    expect(refreshProviderRegistry).toHaveBeenCalledWith("provider-connectivity");
    expect(calls).toEqual(["refresh", "connectivity"]);
    expect(testModelConnectivity).toHaveBeenCalledWith(
      {
        selection: {
          providerId: "custom-openai",
          modelId: "agent-model",
          options: { reasoningLevel: "high" },
        },
      },
      { abortSignal: undefined },
    );
  });

  it("closes the temporary app after provider connectivity testing", async () => {
    const close = vi.fn(async () => {});
    const testModelConnectivity = vi.fn(async () => {});
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { close, testModelConnectivity }),
      cwd: workspace.workspacePath,
    });

    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.providerTestModelConnectivity,
      params: {
        workspace,
        selection: { providerId: "custom-openai", modelId: "agent-model" },
      },
    });

    expect(testModelConnectivity).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("cancels an active workspace text generation by operation id", async () => {
    let generatedSignal: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const generateWorkspaceText = vi.fn(
      async (...[, options]: Parameters<ZCodeApp["generateWorkspaceText"]>) => {
        generatedSignal = options?.abortSignal;
        resolveStarted?.();
        await new Promise<never>((_resolve, reject) => {
          generatedSignal?.addEventListener("abort", () => reject(generatedSignal?.reason), {
            once: true,
          });
        });
      },
    );
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { generateWorkspaceText }),
      cwd: workspace.workspacePath,
    });

    const generateResponse = server.handleMessage({
      id: 1,
      method: zcodeProtocolMethods.workspaceGenerateText,
      params: {
        workspace,
        selection: { providerId: "glm", modelId: "glm-4.6" },
        prompt: "generate text",
        querySource: "test_sidecar",
        operationId: "workspace_model_1",
      },
    });
    await started;

    const cancelResult = zcodeWorkspaceCancelGenerateTextResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.workspaceCancelGenerateText,
        params: { operationId: "workspace_model_1" },
      }),
    );

    expect(cancelResult).toEqual({ operationId: "workspace_model_1", cancelled: true });
    expect(generatedSignal?.aborted).toBe(true);
    await expect(generateResponse).resolves.toMatchObject({
      id: 1,
      error: expect.objectContaining({ message: expect.any(String) }),
    });
  });

  it("rejects a duplicate active workspace text operation id without replacing its controller", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let invocation = 0;
    const generateWorkspaceText = vi.fn(
      async (...[, options]: Parameters<ZCodeApp["generateWorkspaceText"]>) => {
        invocation += 1;
        if (invocation > 1) {
          return {
            text: "reused",
            selection: { providerId: "glm", modelId: "glm-4.6" },
            finishReason: "stop",
          };
        }
        firstSignal = options?.abortSignal;
        resolveStarted?.();
        await new Promise<never>((_resolve, reject) => {
          firstSignal?.addEventListener("abort", () => reject(firstSignal?.reason), { once: true });
        });
      },
    );
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { generateWorkspaceText }),
      cwd: workspace.workspacePath,
    });
    const params = {
      workspace,
      selection: { providerId: "glm", modelId: "glm-4.6" },
      prompt: "generate text",
      querySource: "test_sidecar",
      operationId: "workspace_model_duplicate",
    } as const;

    const firstResponse = server.handleMessage({
      id: 1,
      method: zcodeProtocolMethods.workspaceGenerateText,
      params,
    });
    await started;

    await expect(
      server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.workspaceGenerateText,
        params,
      }),
    ).resolves.toMatchObject({
      id: 2,
      error: expect.objectContaining({
        code: -32600,
        message: expect.stringContaining("already active"),
      }),
    });
    expect(generateWorkspaceText).toHaveBeenCalledOnce();

    const cancelResult = zcodeWorkspaceCancelGenerateTextResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.workspaceCancelGenerateText,
        params: { operationId: params.operationId },
      }),
    );
    expect(cancelResult.cancelled).toBe(true);
    expect(firstSignal?.aborted).toBe(true);
    await expect(firstResponse).resolves.toMatchObject({
      id: 1,
      error: expect.objectContaining({ message: expect.any(String) }),
    });

    const reused = await requestResult(server, {
      id: 4,
      method: zcodeProtocolMethods.workspaceGenerateText,
      params: { ...params, operationId: params.operationId, prompt: "reuse id after completion" },
    });
    expect(reused).toMatchObject({ text: expect.any(String) });
  });

  it("closes the temporary app after draft workspace text generation", async () => {
    const close = vi.fn(async () => {});
    const appOptions: ZCodeAppOptions[] = [];
    const generateWorkspaceText = vi.fn(async () => ({
      text: "fix(git): generate message",
      selection: { providerId: "custom-openai", modelId: "backup-model" },
      finishReason: "stop",
    }));
    const providerRegistry = createProtocolTestProviderRegistry();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const effectiveOptions = { ...options, providerRegistry };
        appOptions.push(effectiveOptions);
        return createFakeApp(effectiveOptions, { close, generateWorkspaceText });
      },
      cwd: workspace.workspacePath,
    });

    const result = zcodeWorkspaceGenerateTextResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.workspaceGenerateText,
        params: {
          workspace,
          selection: { providerId: "custom-openai", modelId: "backup-model" },
          prompt: "write a commit message",
          querySource: "git_commit_message",
        },
      }),
    );

    expect(result.text).toBe("fix(git): generate message");
    expect(generateWorkspaceText).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const temporaryAppOptions = appOptions.at(-1);
    expect(temporaryAppOptions?.providerRegistry).toBe(providerRegistry);
    expect(temporaryAppOptions?.modelAdapter).toBeUndefined();
  });

  it("drops duplicate compact requests while the same session is compacting", async () => {
    const submitPrompt = vi.fn();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const app = createFakeApp(options);
        return {
          ...app,
          runtime: {
            ...app.runtime,
            getActiveTurnInfo: () =>
              ({
                kind: "compact",
                queueLength: 0,
                steerable: false,
                turnId: "turn_compact",
              }) as never,
          },
          submitPrompt,
        };
      },
      cwd: workspace.workspacePath,
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    const compacted = zcodeSessionCompactResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionCompact,
        params: {
          sessionId: created.session.sessionId,
          instructions: "keep recent files",
        },
      }),
    );

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(compacted.response).toBe("");
    expect(compacted.snapshot.runtime.activeTurnKind).toBe("compact");
  });

  it("runs goal through target APIs instead of submitPrompt", async () => {
    let target: Awaited<ReturnType<NonNullable<ZCodeApp["readTarget"]>>> = null;
    const submitPrompt = vi.fn();
    const continueActiveTarget = vi.fn(async () => ({ response: "continued" }) as never);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const app = createFakeApp(options);
        return {
          ...app,
          clearTarget: async () => {
            const hadTarget = target !== null;
            target = null;
            return hadTarget;
          },
          continueActiveTarget,
          readTarget: async () => target,
          runtime: {
            ...app.runtime,
            getProjection: async () =>
              ({
                activeToolCalls: [],
                backgroundTasks: [],
                contextUsed: 0,
                contextWindow: 128_000,
                createdAt: new Date(1),
                id: app.sessionId,
                mode: "build",
                pendingPermissions: [],
                pendingSteerInputs: [],
                status: "idle",
                streamingToolLedger: [],
                target,
                totalTokenCount: 0,
                turnCount: 0,
                updatedAt: new Date(1),
              }) as never,
          } as never,
          setTarget: async (input) => {
            target = {
              objective: input.objective,
              sessionID: app.sessionId,
              status: input.status ?? "active",
              summaryTitle: null,
              targetID: "goal_1" as never,
              time: {
                created: 1,
                updated: 2,
              },
              tokenBudget: input.tokenBudget,
              tokensUsed: 0,
            };
            return target;
          },
          submitPrompt,
          updateTargetStatus: async (status) => {
            if (!target) return null;
            target = { ...target, status, time: { ...target.time, updated: 3 } };
            return target;
          },
        } satisfies ZCodeApp;
      },
      cwd: workspace.workspacePath,
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    const setResult = zcodeSessionGoalResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionGoal,
        params: {
          sessionId: created.session.sessionId,
          action: "set",
          objective: "Ship slash command routing",
          inputId: "input_goal_1",
        },
      }),
    );
    const replaceBySetResult = zcodeSessionGoalResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionGoal,
        params: {
          sessionId: created.session.sessionId,
          action: "set",
          objective: "Replace without explicit keyword",
          inputId: "input_goal_2",
        },
      }),
    );
    const clearResult = zcodeSessionGoalResultSchema.parse(
      await requestResult(server, {
        id: 4,
        method: zcodeProtocolMethods.sessionGoal,
        params: {
          sessionId: created.session.sessionId,
          action: "clear",
        },
      }),
    );

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(continueActiveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ inputId: "input_goal_1" }),
    );
    expect(continueActiveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ inputId: "input_goal_2" }),
    );
    expect(setResult).toMatchObject({
      response: expect.stringContaining("Goal active"),
      startedTurn: true,
      snapshot: {
        projection: {
          target: expect.objectContaining({ objective: "Ship slash command routing" }),
        },
      },
    });
    expect(replaceBySetResult).toMatchObject({
      response: expect.stringContaining("Goal active"),
      startedTurn: true,
      snapshot: {
        projection: {
          target: expect.objectContaining({ objective: "Replace without explicit keyword" }),
        },
      },
    });
    expect(clearResult).toMatchObject({
      response: "Goal cleared.",
      startedTurn: false,
      snapshot: { projection: { target: null } },
    });
  });

  it("rejects session goal commands while a prompt is running", async () => {
    const sendInput = vi.fn(async () => await new Promise<never>(() => {}));
    const setTarget = vi.fn(async () => ({
      objective: "Should wait",
      sessionID: "sess_test" as SessionId,
      status: "active" as const,
      targetID: "goal_running",
      time: { created: 1, updated: 1 },
    }));
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options, { sendInput, setTarget }),
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "keep running",
        inputId: "input_running",
      },
    });

    const response = await server.handleMessage({
      id: 3,
      method: zcodeProtocolMethods.sessionGoal,
      params: {
        sessionId: created.session.sessionId,
        action: "set",
        objective: "Should wait",
        inputId: "input_goal_blocked",
      },
    });

    expect(response).toMatchObject({
      error: {
        code: -32010,
        message: "Cannot manage goals while a prompt is running",
      },
      id: 3,
    });
    expect(setTarget).not.toHaveBeenCalled();
  });

  it("allows session goal pause to stop a running prompt", async () => {
    const abortReasons: string[] = [];
    let target: Awaited<ReturnType<NonNullable<ZCodeApp["readTarget"]>>> = null;
    const sendInput = vi.fn<ZCodeApp["sendInput"]>(
      async (_input, options) =>
        await new Promise<never>((_resolve, reject) => {
          const signal = options.abortSignal;
          const rejectFromAbort = () => {
            const reason = signal.reason;
            abortReasons.push(reason instanceof Error ? reason.message : String(reason));
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          };
          if (signal.aborted) {
            rejectFromAbort();
            return;
          }
          signal.addEventListener("abort", rejectFromAbort, { once: true });
        }),
    );
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const app = createFakeApp(options, { sendInput });
        target = {
          objective: "Pause current goal immediately",
          sessionID: app.sessionId,
          status: "active",
          targetID: "goal_pause_running",
          time: { created: 1, updated: 1 },
        };
        return {
          ...app,
          readTarget: async () => target,
          runtime: {
            ...app.runtime,
            getProjection: async () =>
              ({
                activeToolCalls: [],
                backgroundTasks: [],
                contextUsed: 0,
                contextWindow: 128_000,
                createdAt: new Date(1),
                id: app.sessionId,
                mode: "build",
                pendingPermissions: [],
                pendingSteerInputs: [],
                status: "running",
                streamingToolLedger: [],
                target,
                totalTokenCount: 0,
                turnCount: 1,
                updatedAt: new Date(2),
              }) as never,
          } as never,
          updateTargetStatus: async (status) => {
            if (!target) return null;
            target = { ...target, status, time: { ...target.time, updated: 3 } };
            return target;
          },
        } satisfies ZCodeApp;
      },
    });
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: created.session.sessionId,
        content: "keep running",
        inputId: "input_pause_running",
      },
    });

    const pauseResult = zcodeSessionGoalResultSchema.parse(
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionGoal,
        params: {
          sessionId: created.session.sessionId,
          action: "pause",
          inputId: "input_goal_pause_running",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(abortReasons).toContain("ZCode Protocol goal paused");
    });
    expect(target?.status).toBe("paused");
    expect(pauseResult).toMatchObject({
      response: "",
      startedTurn: false,
      snapshot: {
        projection: {
          target: expect.objectContaining({ status: "paused" }),
        },
      },
    });
  });

  it("pauses an active goal when session stop cancels goal continuation", async () => {
    const notifications: ZCodeProtocolNotification[] = [];
    const abortReasons: string[] = [];
    let resolveContinuationStarted!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      resolveContinuationStarted = resolve;
    });
    let target: Awaited<ReturnType<NonNullable<ZCodeApp["readTarget"]>>> = null;
    const continueActiveTarget = vi.fn<ZCodeApp["continueActiveTarget"]>(
      async (options) =>
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.abortSignal;
          resolveContinuationStarted();
          const rejectFromAbort = () => {
            const reason = signal?.reason;
            abortReasons.push(reason instanceof Error ? reason.message : String(reason));
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          };
          if (signal?.aborted) {
            rejectFromAbort();
            return;
          }
          signal?.addEventListener("abort", rejectFromAbort, { once: true });
        }),
    );
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const app = createFakeApp(options, { continueActiveTarget });
        return {
          ...app,
          readTarget: async () => target,
          runtime: {
            ...app.runtime,
            getProjection: async () =>
              ({
                activeToolCalls: [],
                backgroundTasks: [],
                contextUsed: 0,
                contextWindow: 128_000,
                createdAt: new Date(1),
                id: app.sessionId,
                mode: "build",
                pendingPermissions: [],
                pendingSteerInputs: [],
                status: continueActiveTarget.mock.calls.length > 0 ? "running" : "idle",
                streamingToolLedger: [],
                target,
                totalTokenCount: 0,
                turnCount: continueActiveTarget.mock.calls.length,
                updatedAt: new Date(2),
              }) as never,
          } as never,
          setTarget: async (input) => {
            target = {
              objective: input.objective,
              sessionID: app.sessionId,
              status: input.status ?? "active",
              summaryTitle: null,
              targetID: "goal_stop_running",
              time: { created: 1, updated: 2 },
              timeUsedSeconds: 0,
              tokenBudget: input.tokenBudget ?? null,
              tokensUsed: 0,
            };
            return target;
          },
          updateTargetStatus: async (status) => {
            if (!target) return null;
            target = { ...target, status, time: { ...target.time, updated: 3 } };
            return target;
          },
        } satisfies ZCodeApp;
      },
      cwd: workspace.workspacePath,
    });
    setTestNotificationSink(server, (notification) => notifications.push(notification));
    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    const goalResult = zcodeSessionGoalResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionGoal,
        params: {
          sessionId: created.session.sessionId,
          action: "set",
          objective: "Stop should pause this goal",
          inputId: "input_goal_stop_running",
        },
      }),
    );
    await continuationStarted;
    const notificationCountBeforeStop = notifications.length;

    await requestResult(server, {
      id: 3,
      method: zcodeProtocolMethods.sessionStop,
      params: { sessionId: created.session.sessionId },
    });

    await vi.waitFor(() => {
      expect(abortReasons).toContain("ZCode Protocol session stopped");
    });
    expect(goalResult.startedTurn).toBe(true);
    expect(target?.status).toBe("paused");
    expect(
      notifications
        .slice(notificationCountBeforeStop)
        .some((item) => item.method === "state.updated"),
    ).toBe(true);
  });

  it("includes persisted goal and todos in protocol snapshots", async () => {
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const app = createFakeApp(options);
        const persistedTarget = {
          objective: "Restore parser goal",
          sessionID: app.sessionId,
          status: "paused" as const,
          summaryTitle: "Restore parser goal",
          targetID: "goal_db",
          time: { created: 10, updated: 20 },
          timeUsedSeconds: 7,
          tokenBudget: null,
          tokensUsed: 123,
        };
        return {
          ...app,
          readTarget: async () => persistedTarget,
          readTodos: async () => [
            { content: "Implement lexer", priority: "high", status: "completed" },
            { content: "Implement parser", priority: "high", status: "in_progress" },
          ],
        };
      },
      cwd: workspace.workspacePath,
    });

    const created = zcodeSessionStateSnapshotSchema.parse(
      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      }),
    );

    expect(created.projection.target).toMatchObject({
      objective: "Restore parser goal",
      status: "paused",
      summaryTitle: "Restore parser goal",
      targetId: "goal_db",
    });
    expect(created.session.target).toMatchObject({
      objective: "Restore parser goal",
      summaryTitle: "Restore parser goal",
      targetId: "goal_db",
    });
    expect(created.todos).toEqual([
      { content: "Implement lexer", priority: "high", status: "completed" },
      { content: "Implement parser", priority: "high", status: "in_progress" },
    ]);
  });

  it("derives goal stats and todo groups from persisted verifier boundaries", async () => {
    const app = createFakeApp();
    const target = {
      objective: "Ship grouped todo restore",
      sessionID: app.sessionId,
      status: "active" as const,
      summaryTitle: null,
      targetID: "goal_1" as never,
      time: { created: 1_000, updated: 9_400 },
      timeUsedSeconds: 0,
      tokenBudget: 120_000,
      tokensUsed: 0,
    };
    const messages = [
      {
        info: {
          id: "msg_goal_1" as MessageId,
          sessionID: app.sessionId,
          role: "user",
          time: { created: 1_000 },
          agent: "zcode-agent",
          modelSelection: {
            providerId: "glm" as ModelProviderId,
            modelId: "glm-4.6" as ModelId,
          },
          source: "goal-continuation",
          synthetic: true,
          visibility: "model-only",
          metadata: { source: "goal-continuation", targetId: "goal_1" },
        },
        parts: [
          {
            id: "part_goal_1" as never,
            sessionID: app.sessionId,
            messageID: "msg_goal_1" as MessageId,
            type: "text",
            text: "continue the active goal",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_1" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          parentID: "msg_goal_1" as MessageId,
          time: { created: 2_000, completed: 4_500 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: {
            input: 100,
            output: 10,
            reasoning: 1,
            total: 111,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part_todo_1" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_1" as MessageId,
            type: "tool",
            callID: "tool_todo_1",
            tool: "TodoWrite",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Read existing restore flow", priority: "high", status: "completed" },
                  { content: "Project grouped todos", priority: "high", status: "in_progress" },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 2_100, end: 4_200 },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_goal_2" as MessageId,
          sessionID: app.sessionId,
          role: "user",
          time: { created: 5_000 },
          agent: "zcode-agent",
          modelSelection: {
            providerId: "glm" as ModelProviderId,
            modelId: "glm-4.6" as ModelId,
          },
          metadata: { source: "goal-continuation", targetId: "goal_1" },
        },
        parts: [
          {
            id: "part_goal_2" as never,
            sessionID: app.sessionId,
            messageID: "msg_goal_2" as MessageId,
            type: "text",
            text: "continue again",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_2" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          parentID: "msg_goal_2" as MessageId,
          time: { created: 5_500, completed: 8_000 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: {
            input: 200,
            output: 20,
            reasoning: 2,
            total: 222,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part_bash_2" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_2" as MessageId,
            type: "tool",
            callID: "tool_bash_2",
            tool: "Bash",
            state: {
              status: "completed",
              input: { command: "pnpm typecheck" },
              output: "passed",
              title: "Bash",
              metadata: {},
              time: { start: 5_600, end: 6_000 },
            },
          },
          {
            id: "part_todo_2" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_2" as MessageId,
            type: "tool",
            callID: "tool_todo_2",
            tool: "todo_write",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Project grouped todos", priority: "high", status: "completed" },
                  { content: "Verify restored summary", priority: "medium", status: "in_progress" },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 6_100, end: 7_800 },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_3" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          parentID: "msg_assistant_2" as MessageId,
          time: { created: 8_200, completed: 9_400 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: {
            input: 20,
            output: 8,
            reasoning: 2,
            total: 30,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part_todo_3" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_3" as MessageId,
            type: "tool",
            callID: "tool_todo_3",
            tool: "TodoWrite",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Project grouped todos", priority: "high", status: "completed" },
                  { content: "Verify restored summary", priority: "medium", status: "completed" },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 8_300, end: 9_300 },
            },
          },
        ],
      },
    ] as unknown as MessageWithParts[];

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await buildSessionSnapshot({
        app,
        eventSeq: 1,
        messages,
        persistedGoalVerificationEvents: [
          {
            id: "evt_verify_1" as SessionEvent["id"],
            payload: {
              goalIteration: 1,
              status: "completed",
              targetId: "goal_1",
              verification: {
                nextAction: "Verify restored summary",
                passed: false,
                reason: "The restored summary is not verified yet.",
              },
              verificationId: "verify_1",
            },
            sequenceNumber: 10,
            sessionId: app.sessionId,
            timestamp: new Date(4_800),
            traceId: "trace_verify_1" as SessionEvent["traceId"],
            type: SessionEventType.TargetCompletionVerification,
          },
        ],
        stateRevision: 1,
        target,
        todos: [],
        workspace,
      }),
    );

    expect(snapshot.goalStats).toEqual({
      contextUsed: 0,
      contextWindow: 128_000,
      iterationCount: 2,
      timeUsedSeconds: 8,
      tokenBudget: 120_000,
      tokensUsed: 363,
      toolCallCount: 4,
    });
    expect(snapshot.runtime.goalVerificationTimeline).toEqual([
      {
        display: "separator",
        goalIteration: 1,
        kind: "synthetic",
        status: "completed",
        targetId: "goal_1",
        type: "goal_verification",
        updatedAt: 4_800,
        verification: {
          nextAction: "Verify restored summary",
          passed: false,
          reason: "The restored summary is not verified yet.",
        },
        verificationId: "verify_1",
        version: 1,
      },
    ]);
    expect(snapshot.todoGroups).toEqual([
      {
        id: "goal-iteration-1",
        source: "goal_iteration",
        goalIteration: 1,
        targetId: "goal_1",
        startedAt: 1_000,
        updatedAt: 9_300,
        todos: [
          { content: "Read existing restore flow", priority: "high", status: "completed" },
          { content: "Project grouped todos", priority: "high", status: "completed" },
        ],
      },
      {
        id: "goal-iteration-2",
        source: "goal_iteration",
        goalIteration: 2,
        targetId: "goal_1",
        startedAt: 4_800,
        updatedAt: 9_300,
        todos: [{ content: "Verify restored summary", priority: "medium", status: "completed" }],
      },
    ]);
  });

  it("does not advance goal stats after paused verifier cancellation", async () => {
    const app = createFakeApp();
    const target = {
      objective: "Stop goal verification",
      sessionID: app.sessionId,
      status: "paused" as const,
      summaryTitle: null,
      targetID: "goal_paused_cancelled" as never,
      time: { created: 1_000, updated: 4_000 },
      timeUsedSeconds: 2,
      tokenBudget: null,
      tokensUsed: 10,
    };

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await buildSessionSnapshot({
        app,
        eventSeq: 1,
        messages: [],
        persistedGoalVerificationEvents: [
          {
            id: "evt_verify_cancelled" as SessionEvent["id"],
            payload: {
              goalIteration: 1,
              status: "cancelled",
              targetId: "goal_paused_cancelled",
              verificationId: "verify_cancelled",
            },
            sequenceNumber: 10,
            sessionId: app.sessionId,
            timestamp: new Date(3_500),
            traceId: "trace_verify_cancelled" as SessionEvent["traceId"],
            type: SessionEventType.TargetCompletionVerification,
          },
        ],
        stateRevision: 1,
        target,
        todos: [],
        workspace,
      }),
    );

    expect(snapshot.goalStats).toMatchObject({
      iterationCount: 1,
      timeUsedSeconds: 2,
      tokensUsed: 10,
    });
    expect(snapshot.runtime.goalVerificationTimeline).toEqual([
      expect.objectContaining({
        goalIteration: 1,
        status: "cancelled",
        targetId: "goal_paused_cancelled",
      }),
    ]);
  });

  it("keeps visible user continuation todo updates in the current verifier iteration", async () => {
    const app = createFakeApp();
    const target = {
      objective: "Ship dynamic grouped todos",
      sessionID: app.sessionId,
      status: "active" as const,
      summaryTitle: null,
      targetID: "goal_visible_continue" as never,
      time: { created: 1_000, updated: 7_000 },
      timeUsedSeconds: 0,
      tokenBudget: null,
      tokensUsed: 0,
    };
    const messages = [
      {
        info: {
          id: "msg_goal_1" as MessageId,
          sessionID: app.sessionId,
          role: "user",
          time: { created: 1_000 },
          agent: "zcode-agent",
          modelSelection: {
            providerId: "glm" as ModelProviderId,
            modelId: "glm-4.6" as ModelId,
          },
          source: "goal-continuation",
          synthetic: true,
          visibility: "model-only",
          metadata: { source: "goal-continuation", targetId: "goal_visible_continue" },
        },
        parts: [
          {
            id: "part_goal_1" as never,
            sessionID: app.sessionId,
            messageID: "msg_goal_1" as MessageId,
            type: "text",
            text: "continue the active goal",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_1" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          parentID: "msg_goal_1" as MessageId,
          time: { created: 2_000, completed: 3_000 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            total: 15,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part_todo_1" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_1" as MessageId,
            type: "tool",
            callID: "tool_todo_1",
            tool: "TodoWrite",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Wire UI components in App", priority: "high", status: "in_progress" },
                  { content: "Wire undo/history system", priority: "medium", status: "pending" },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 2_100, end: 2_900 },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_visible_continue" as MessageId,
          sessionID: app.sessionId,
          role: "user",
          time: { created: 4_000 },
          agent: "zcode-agent",
          modelSelection: {
            providerId: "glm" as ModelProviderId,
            modelId: "glm-4.6" as ModelId,
          },
        },
        parts: [
          {
            id: "part_visible_continue" as never,
            sessionID: app.sessionId,
            messageID: "msg_visible_continue" as MessageId,
            type: "text",
            text: "继续",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_2" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          parentID: "msg_visible_continue" as MessageId,
          time: { created: 4_500, completed: 5_500 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: {
            input: 20,
            output: 5,
            reasoning: 0,
            total: 25,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part_todo_2" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_2" as MessageId,
            type: "tool",
            callID: "tool_todo_2",
            tool: "todo_write",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Wire UI components in App", priority: "high", status: "completed" },
                  {
                    content: "Complete remaining blend modes in WebGL shaders and Rust engine",
                    priority: "high",
                    status: "in_progress",
                  },
                  {
                    content: "Wire PSD import through worker into App",
                    priority: "medium",
                    status: "pending",
                  },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 4_600, end: 5_300 },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_3" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          parentID: "msg_assistant_2" as MessageId,
          time: { created: 5_800, completed: 7_000 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: {
            input: 30,
            output: 5,
            reasoning: 0,
            total: 35,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "part_todo_3" as never,
            sessionID: app.sessionId,
            messageID: "msg_assistant_3" as MessageId,
            type: "tool",
            callID: "tool_todo_3",
            tool: "TodoWrite",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Wire UI components in App", priority: "high", status: "completed" },
                  {
                    content: "Complete remaining blend modes in WebGL shaders and Rust engine",
                    priority: "high",
                    status: "completed",
                  },
                  {
                    content: "Wire PSD import through worker into App",
                    priority: "medium",
                    status: "in_progress",
                  },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 5_900, end: 6_900 },
            },
          },
        ],
      },
    ] as unknown as MessageWithParts[];

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await buildSessionSnapshot({
        app,
        eventSeq: 1,
        messages,
        stateRevision: 1,
        target,
        todos: [],
        workspace,
      }),
    );

    expect(snapshot.goalStats).toMatchObject({
      iterationCount: 1,
      toolCallCount: 3,
      tokensUsed: 75,
    });
    expect(snapshot.todoGroups).toEqual([
      {
        id: "goal-iteration-1",
        source: "goal_iteration",
        goalIteration: 1,
        targetId: "goal_visible_continue",
        startedAt: 1_000,
        updatedAt: 6_900,
        todos: [
          { content: "Wire UI components in App", priority: "high", status: "completed" },
          { content: "Wire undo/history system", priority: "medium", status: "pending" },
          {
            content: "Complete remaining blend modes in WebGL shaders and Rust engine",
            priority: "high",
            status: "completed",
          },
          {
            content: "Wire PSD import through worker into App",
            priority: "medium",
            status: "in_progress",
          },
        ],
      },
    ]);
  });

  it("keeps standalone non-goal todos grouped as session current todos", async () => {
    const app = createFakeApp();
    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await buildSessionSnapshot({
        app,
        eventSeq: 1,
        messages: [],
        stateRevision: 1,
        target: null,
        todos: [
          { content: "Read logs", priority: "high", status: "completed" },
          { content: "Reproduce locally", priority: "high", status: "in_progress" },
          { content: "Write fix", priority: "medium", status: "pending" },
        ],
        workspace,
      }),
    );

    expect(snapshot.goalStats).toBeUndefined();
    expect(snapshot.todoGroups).toEqual([
      {
        id: "session-current",
        source: "session",
        todos: [
          { content: "Read logs", priority: "high", status: "completed" },
          { content: "Reproduce locally", priority: "high", status: "in_progress" },
          { content: "Write fix", priority: "medium", status: "pending" },
        ],
      },
    ]);
  });

  it("ignores subagent TodoWrite parts when building main session todo groups", async () => {
    const app = createFakeApp();
    const messages = [
      {
        info: {
          id: "msg_main_todo" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          time: { created: 1_000, completed: 1_200 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "part_main_todo" as never,
            sessionID: app.sessionId,
            messageID: "msg_main_todo" as MessageId,
            type: "tool",
            callID: "call_main_todo",
            tool: "TodoWrite",
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Main inspect logs", priority: "high", status: "completed" },
                  { content: "Main patch projection", priority: "high", status: "in_progress" },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: {},
              time: { start: 1_050, end: 1_100 },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_subagent_todo" as MessageId,
          sessionID: app.sessionId,
          role: "assistant",
          time: { created: 2_000, completed: 2_200 },
          agent: "zcode-agent",
          providerId: "glm" as ModelProviderId,
          modelId: "glm-4.6" as ModelId,
          mode: "build",
          path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "part_subagent_todo" as never,
            sessionID: app.sessionId,
            messageID: "msg_subagent_todo" as MessageId,
            type: "tool",
            callID: "tool_subagent_agent_1_call_todo",
            tool: "TodoWrite",
            metadata: { source: "subagent" },
            state: {
              status: "completed",
              input: {
                todos: [
                  { content: "Subagent search market", priority: "high", status: "completed" },
                  {
                    content: "Subagent summarize sources",
                    priority: "medium",
                    status: "completed",
                  },
                ],
              },
              output: "ok",
              title: "TodoWrite",
              metadata: { source: "subagent", parentToolCallId: "call_agent" },
              time: { start: 2_050, end: 2_100 },
            },
          },
        ],
      },
    ] as unknown as MessageWithParts[];

    const snapshot = zcodeSessionStateSnapshotSchema.parse(
      await buildSessionSnapshot({
        app,
        eventSeq: 1,
        messages,
        stateRevision: 1,
        target: null,
        todos: [],
        workspace,
      }),
    );

    expect(snapshot.todoGroups).toEqual([
      {
        id: "session",
        source: "session",
        startedAt: 1_000,
        updatedAt: 1_100,
        todos: [
          { content: "Main inspect logs", priority: "high", status: "completed" },
          { content: "Main patch projection", priority: "high", status: "in_progress" },
        ],
      },
    ]);
  });

  it("forks sessions and lets selection children inherit parent runtime preferences", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const forkTargets: Array<{ targetCheckpointId?: string; targetMessageId?: string }> = [];
    const createdAppOptions: ZCodeAppOptions[] = [];
    const selectionChildId = "sess_selection_runtime_preferences" as SessionId;
    try {
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => {
          createdAppOptions.push(options);
          const app = createFakeApp(options);
          return {
            ...app,
            clearTarget: async () => await store.clearTarget({ sessionID: app.sessionId }),
            forkFromCheckpoint: async (target) => {
              forkTargets.push({
                targetCheckpointId: target?.targetCheckpointId,
                targetMessageId: target?.targetMessageId,
              });
              const forkedSessionId = "sess_forked" as SessionId;
              if (!(await store.getSession(forkedSessionId))) {
                await store.createSession({
                  id: forkedSessionId,
                  parentID: options?.sessionId,
                  projectID: "project_fork_runtime_settings" as ProjectId,
                  slug: "fork-runtime-settings",
                  directory: workspace.workspacePath,
                  path: workspace.workspacePath,
                  title: "Fork runtime settings",
                  version: "test-version",
                  time: { created: 10, updated: 10 },
                });
              }
              return {
                checkpoint: {} as never,
                copiedMessageCount: 2,
                forkedSessionId,
                parentSessionId: (options?.sessionId ?? "sess_parent") as never,
                targetMessageId: "msg_assistant_1" as never,
                targetCheckpointId: "checkpoint_1",
                restoredFiles: [],
                response: "forked",
              };
            },
            readTarget: async () => await store.readTarget({ sessionID: app.sessionId }),
            runtime: {
              ...app.runtime,
              createSelectionSideConversation: async () => {
                if (!(await store.getSession(selectionChildId))) {
                  await store.createSession({
                    id: selectionChildId,
                    parentID: app.sessionId,
                    projectID: "project_selection_runtime_preferences" as ProjectId,
                    slug: "selection-runtime-preferences",
                    directory: workspace.workspacePath,
                    path: workspace.workspacePath,
                    taskType: "selection_side_chat",
                    title: "Selection runtime preferences",
                    version: "test-version",
                    time: { created: 20, updated: 20 },
                  });
                }
                return {
                  forkedSessionId: selectionChildId,
                  parentSessionId: app.sessionId,
                  response: "selection child",
                  targetMessageId: "msg_assistant_1" as MessageId,
                } as never;
              },
            } as never,
            setTarget: async (input) =>
              await store.setTarget({
                objective: input.objective,
                sessionID: app.sessionId,
                status: input.status ?? "active",
                tokenBudget: input.tokenBudget,
              }),
            updateTargetStatus: async (status) =>
              await store.updateTargetStatus({ sessionID: app.sessionId, status }),
          } satisfies ZCodeApp;
        },
        cwd: workspace.workspacePath,
        sessionStore: store,
      });
      let toolSearchMode: "local" | "off" = "local";
      const preferenceRequests = attachSessionRuntimePreferencesResponder(server, () => ({
        nativeSearchEnhancementsEnabled: false,
        toolSearchMode,
        memoryEnabled: false,
        subagentRuntimeConfigEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
      }));
      const created = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: 1,
          method: zcodeProtocolMethods.sessionCreate,
          params: { workspace },
        }),
      );
      if (!(await store.getSession(created.session.sessionId as SessionId))) {
        await store.createSession({
          id: created.session.sessionId as SessionId,
          projectID: "project_fork_runtime_settings" as ProjectId,
          slug: "fork-runtime-settings-parent",
          directory: workspace.workspacePath,
          path: workspace.workspacePath,
          title: "Fork runtime settings parent",
          version: "test-version",
          time: { created: 1, updated: 1 },
        });
      }
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSetModel,
        params: {
          sessionId: created.session.sessionId,
          model: { providerId: "glm", modelId: "glm-4-air" },
        },
      });
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionSetMode,
        params: {
          sessionId: created.session.sessionId,
          mode: "plan",
        },
      });
      await requestResult(server, {
        id: 4,
        method: zcodeProtocolMethods.sessionSetThoughtLevel,
        params: {
          sessionId: created.session.sessionId,
          thoughtLevel: "deep",
        },
      });
      const goal = zcodeSessionGoalResultSchema.parse(
        await requestResult(server, {
          id: 5,
          method: zcodeProtocolMethods.sessionGoal,
          params: {
            sessionId: created.session.sessionId,
            action: "set",
            objective: "Fork inherits parent goal target",
          },
        }),
      );
      expect(goal.snapshot.session.target).toMatchObject({
        objective: "Fork inherits parent goal target",
        sessionId: created.session.sessionId,
        status: "active",
      });

      toolSearchMode = "off";
      const result = zcodeSessionForkResultSchema.parse(
        await requestResult(server, {
          id: 6,
          method: zcodeProtocolMethods.sessionFork,
          params: {
            sessionId: created.session.sessionId,
            target: { kind: "message", messageId: "msg_assistant_1" },
          },
        }),
      );

      expect(forkTargets).toEqual([
        expect.objectContaining({ targetMessageId: "msg_assistant_1" }),
      ]);
      expect(result).toMatchObject({
        forkedSessionId: "sess_forked",
        targetMessageId: "msg_assistant_1",
        targetCheckpointId: "checkpoint_1",
      });
      expect(result.snapshot.session.sessionId).toBe("sess_forked");
      expect(result.snapshot.settings).toMatchObject({
        mode: { current: "plan" },
        model: { current: { providerId: "glm", modelId: "glm-4-air" } },
        thoughtLevel: { current: "deep" },
      });
      expect(createdAppOptions).toHaveLength(2);
      expect(createdAppOptions[1]?.readSubagentRuntimeConfig).toBeTypeOf("function");
      expect(preferenceRequests).toHaveLength(1);
      expect(createdAppOptions[1]?.runtimeConfig?.toolSearch).toEqual({ mode: "local" });
      expect(createdAppOptions[1]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(false);
      expect(createdAppOptions[1]?.runtimeConfig?.memory?.enabled).toBe(false);
      expect(createdAppOptions[1]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");
      expect(result.snapshot.session.target).toMatchObject({
        objective: "Fork inherits parent goal target",
        sessionId: "sess_forked",
        status: "active",
      });
      expect(result.snapshot.projection.target).toMatchObject({
        objective: "Fork inherits parent goal target",
        sessionId: "sess_forked",
        status: "active",
      });
      expect(result.snapshot.session.target?.targetId).toBe(goal.snapshot.session.target?.targetId);
      expect(await store.readTarget({ sessionID: "sess_forked" as SessionId })).toMatchObject({
        objective: "Fork inherits parent goal target",
      });

      const selection = await requestResult(server, {
        id: 7,
        method: V4_METHODS.command,
        params: {
          clientId: "client-selection-runtime-preferences",
          commandId: "cmd-selection-runtime-preferences",
          issuedAt: 20,
          payload: {},
          sessionId: created.session.sessionId,
          type: "createSelectionSideSession",
        },
      });
      expect(selection).toMatchObject({
        status: "accepted",
        result: {
          sessionId: selectionChildId,
          type: "createSelectionSideSession",
        },
      });
      expect(createdAppOptions).toHaveLength(3);
      expect(createdAppOptions[2]?.readSubagentRuntimeConfig).toBeTypeOf("function");
      expect(preferenceRequests).toHaveLength(1);
      expect(createdAppOptions[2]?.runtimeConfig?.toolSearch).toEqual({ mode: "local" });
      expect(createdAppOptions[2]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(false);
      expect(createdAppOptions[2]?.runtimeConfig?.memory?.enabled).toBe(false);
      expect(createdAppOptions[2]?.runtimeConfig?.modelContextBudgetStrategy).toBe("preflight-v1");
      expect((await store.getSession(selectionChildId))?.taskType).toBe("selection_side_chat");
    } finally {
      await store.close();
    }
  });

  it("resolves turn fork targets before later user, fork, and compact synthetic messages", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = "sess_fork_turn_history" as SessionId;
    const forkTargets: Array<{ targetCheckpointId?: string; targetMessageId?: string }> = [];
    try {
      await store.createSession({
        id: sessionId,
        projectID: "project_fork_turn_history" as ProjectId,
        slug: "fork-turn-history",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: "Fork turn history",
        version: "test-version",
        time: { created: 1, updated: 12 },
      });
      await saveUserTextMessage(store, sessionId, "msg_user_0" as MessageId, "第一轮", 2);
      await saveAssistantTextMessage(
        store,
        sessionId,
        "msg_assistant_0" as MessageId,
        "msg_user_0" as MessageId,
        "第一轮回复",
        3,
      );
      await saveUserTextMessage(store, sessionId, "msg_user_1" as MessageId, "第二轮", 4);
      await saveAssistantTextMessage(
        store,
        sessionId,
        "msg_assistant_1" as MessageId,
        "msg_user_1" as MessageId,
        "第二轮回复",
        5,
      );
      await saveSyntheticForkNotice(store, sessionId, "msg_fork_notice" as MessageId, 6);
      await saveCompactSummary(store, sessionId, "msg_compact_summary" as MessageId, 7);

      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) =>
          createFakeApp(options, {
            forkFromCheckpoint: async (target) => {
              forkTargets.push({
                targetCheckpointId: target?.targetCheckpointId,
                targetMessageId: target?.targetMessageId,
              });
              // 两次 fork 必须像真实 core 一样生成不同身份，否则第二次会命中已初始化实例。
              const forkedSessionId = `sess_forked_${forkTargets.length}` as SessionId;
              // fake 必须遵守 core fork 契约：返回前 child 已落 store。旧夹具只返回 id，
              // registerForkedSession 按生产语义回读时必然报 Persisted child not found。
              if (!(await store.getSession(forkedSessionId))) {
                await store.createSession({
                  id: forkedSessionId,
                  parentID: sessionId,
                  projectID: "project_fork_turn_history" as ProjectId,
                  slug: "fork-turn-history-child",
                  directory: workspace.workspacePath,
                  path: workspace.workspacePath,
                  title: "Fork turn history child",
                  version: "test-version",
                  time: { created: 10, updated: 10 },
                });
              }
              return {
                checkpoint: {} as never,
                copiedMessageCount: 2,
                forkedSessionId,
                parentSessionId: sessionId,
                targetMessageId: target?.targetMessageId as never,
                restoredFiles: [],
                response: "forked",
              };
            },
          }),
        cwd: workspace.workspacePath,
        sessionStore: store,
      });

      await requestResult(server, {
        id: 1,
        method: zcodeProtocolMethods.sessionResume,
        params: { sessionId, workspace },
      });

      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionFork,
        params: {
          sessionId,
          target: { kind: "turn", turnIndex: 0 },
        },
      });
      await requestResult(server, {
        id: 3,
        method: zcodeProtocolMethods.sessionFork,
        params: {
          sessionId,
          target: { kind: "turn", turnIndex: 1 },
        },
      });

      expect(forkTargets).toEqual([
        expect.objectContaining({ targetMessageId: "msg_assistant_0" }),
        expect.objectContaining({ targetMessageId: "msg_assistant_1" }),
      ]);
    } finally {
      await store.close();
    }
  });

  it("maps core session title updates into explicit protocol events", () => {
    const event = mapSessionEvent(
      {
        id: "evt_title" as never,
        payload: {
          previousTitle: "please fix the mobile login button",
          source: "generated",
          title: "Fix mobile login",
        },
        sequenceNumber: 3,
        sessionId: "sess_test" as SessionId,
        timestamp: new Date(4),
        traceId: "trace_test" as never,
        type: SessionEventType.SessionTitleUpdated,
      } satisfies SessionEvent,
      "desktop-continuous",
    );

    expect(event.type).toBe("session.titleUpdated");
    expect(event.payload).toMatchObject({ title: "Fix mobile login" });
  });
});

type TestSessionStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

async function saveUserTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  text: string,
  created: number,
) {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "zcode-agent",
    model: {
      providerId: "glm" as ModelProviderId,
      modelId: "glm-4-air" as ModelId,
    },
    tools: {},
  });
  await saveTextPart(store, sessionId, messageId, text, created);
}

async function saveSyntheticForkNotice(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  created: number,
) {
  const metadata = {
    forkContext: {
      kind: "session_fork",
      parentSessionId: "sess_parent",
      targetMessageId: "msg_assistant_1",
    },
    source: "fork",
    visibility: "user-visible",
  };
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "zcode-agent",
    metadata,
    model: {
      providerId: "glm" as ModelProviderId,
      modelId: "glm-4-air" as ModelId,
    },
    source: "fork",
    synthetic: true,
    tools: {},
    visibility: "user-visible",
  });
  await saveTextPart(
    store,
    sessionId,
    messageId,
    "<system-reminder>\nThis session was forked from a previous session message.\n</system-reminder>",
    created,
    {
      metadata,
      synthetic: true,
    },
  );
}

async function saveCompactSummary(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  created: number,
) {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "zcode-agent",
    model: {
      providerId: "glm" as ModelProviderId,
      modelId: "glm-4-air" as ModelId,
    },
    summary: {
      body: "历史摘要",
      diffs: [],
      title: "Compact summary",
    },
    tools: {},
  });
  await saveTextPart(store, sessionId, messageId, "compact summary context", created, {
    synthetic: true,
  });
  await store.savePart({
    id: `${messageId}_compaction` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "compaction",
    auto: false,
    trigger: "manual",
    phase: "standalone_turn",
    compactReason: "user_requested",
    operationId: "cmp_test",
  } as MessagePart);
}

async function saveAssistantTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  parentMessageId: MessageId,
  text: string,
  created: number,
) {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created, completed: created },
    parentID: parentMessageId,
    providerId: "glm" as ModelProviderId,
    modelId: "glm-4-air" as ModelId,
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  await saveTextPart(store, sessionId, messageId, text, created);
}

async function saveTextPart(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  text: string,
  created: number,
  options: Pick<MessagePart, "metadata" | "synthetic"> = {},
) {
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
    ...options,
  });
}

function messageTexts(
  messages: ReadonlyArray<{ parts: ReadonlyArray<{ text?: string; type: string }> }>,
) {
  return messages.map((message) =>
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(""),
  );
}

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function setTestNotificationSink(
  server: ZCodeProtocolAgentServer,
  sink: Parameters<ZCodeProtocolAgentServer["setNotificationSink"]>[0],
): void {
  server.setNotificationSink((message) => {
    if (
      "id" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    ) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: true },
      });
      return;
    }
    sink(message);
  });
}

function attachSessionRuntimePreferencesResponder(
  server: ZCodeProtocolAgentServer,
  resolvePreferences: (scope: "runtime-materialization" | "user-execution") => {
    nativeSearchEnhancementsEnabled: boolean;
    toolSearchMode?: "auto" | "local" | "off";
    memoryEnabled?: boolean;
    subagentRuntimeConfigEnabled?: boolean;
    modelContextBudgetStrategy?: "legacy" | "preflight-v1";
    integratedTerminalShell?:
      | {
          mode: "auto";
        }
      | {
          mode: "shell";
          dialect: "git-bash" | "cmd";
          id: string;
          label: string;
          path: string;
        };
  },
): ZCodeProtocolMessage[] {
  const requests: ZCodeProtocolMessage[] = [];
  server.setNotificationSink((message) => {
    if (
      "id" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    ) {
      requests.push(message);
      const scope = (message.params as { scope: "runtime-materialization" | "user-execution" })
        .scope;
      void server.handleMessage({
        id: message.id,
        result: resolvePreferences(scope),
      });
    }
  });
  return requests;
}

interface RecordedLog {
  context: Record<string, unknown>;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

function createProtocolTestLoggerFactory(logs: RecordedLog[]): LoggerFactory {
  const loggerFor = (baseContext: LogContext = {}): Logger => ({
    child(childContext) {
      return loggerFor({ ...baseContext, ...childContext });
    },
    debug(message, logContext) {
      recordLog(logs, "debug", message, baseContext, logContext);
    },
    error(message, _error, logContext) {
      recordLog(logs, "error", message, baseContext, logContext);
    },
    info(message, logContext) {
      recordLog(logs, "info", message, baseContext, logContext);
    },
    warn(message, logContext) {
      recordLog(logs, "warn", message, baseContext, logContext);
    },
  });

  return {
    createLogger: () => loggerFor(),
    setLevel: () => {},
    withContext: (context) => loggerFor(context),
  };
}

function recordLog(
  logs: RecordedLog[],
  level: RecordedLog["level"],
  message: string,
  baseContext: LogContext,
  logContext?: LogContext,
): void {
  logs.push({
    level,
    message,
    context: { ...baseContext, ...logContext },
  });
}

function createProtocolListMcpPort(connectedConfigs: Record<string, McpServerConfig>[]): McpPort {
  const statuses: Awaited<ReturnType<McpPort["status"]>> = {};

  return {
    async callTool() {
      return { content: [] };
    },
    async close() {},
    async connectConfiguredServers(servers) {
      connectedConfigs.push(servers);
      for (const [name, config] of Object.entries(servers)) {
        statuses[name] = {
          status: config.enabled === false ? "disabled" : "connected",
          transport: config.type,
          toolCount: config.enabled === false ? 0 : 3,
          updatedAt: new Date(1).toISOString(),
        };
      }
      return {
        statuses,
        tools: [],
      };
    },
    async connectServer(name, config) {
      const status = {
        status: "connected" as const,
        transport: config.type,
        toolCount: 3,
        updatedAt: new Date(1).toISOString(),
      };
      statuses[name] = status;
      return status;
    },
    async disconnectServer(name) {
      const status = statuses[name];
      delete statuses[name];
      return status;
    },
    async listTools() {
      return [];
    },
    async status() {
      return statuses;
    },
  };
}

function createProtocolReplaceMcpPort(
  connectedConfigs: Record<string, McpServerConfig>[],
  disconnectedNames: string[],
  initialStatuses: Awaited<ReturnType<McpPort["status"]>>,
): McpPort {
  const statuses: Awaited<ReturnType<McpPort["status"]>> = { ...initialStatuses };

  return {
    async callTool() {
      return { content: [] };
    },
    async close() {},
    async connectConfiguredServers(servers) {
      connectedConfigs.push(servers);
      for (const name of Object.keys(statuses)) {
        if (!(name in servers)) {
          disconnectedNames.push(name);
          delete statuses[name];
        }
      }
      for (const [name, config] of Object.entries(servers)) {
        statuses[name] = {
          status: config.enabled === false ? "disabled" : "connected",
          transport: config.type,
          toolCount: config.enabled === false ? 0 : 3,
          updatedAt: new Date(2).toISOString(),
        };
      }
      return {
        statuses,
        tools: [],
      };
    },
    async connectServer(name, config) {
      const status = {
        status: "connected" as const,
        transport: config.type,
        toolCount: 3,
        updatedAt: new Date(2).toISOString(),
      };
      statuses[name] = status;
      return status;
    },
    async disconnectServer(name) {
      disconnectedNames.push(name);
      const status = statuses[name];
      delete statuses[name];
      return status;
    },
    async listTools() {
      return [];
    },
    async status() {
      return statuses;
    },
  };
}

function createProtocolPendingAuthorizationMcpPort(
  connectedConfigs: Record<string, McpServerConfig>[],
  onConnectWaiter: (resolve: () => void) => void,
): McpPort {
  const statuses: Awaited<ReturnType<McpPort["status"]>> = {};

  return {
    async callTool() {
      return { content: [] };
    },
    async close() {},
    async connectConfiguredServers(servers) {
      connectedConfigs.push(servers);
      statuses.notion = {
        authorization: {
          authorizationUrl: "https://auth.example.test/authorize?state=state_test",
          startedAt: new Date(1).toISOString(),
          type: "oauth_authorization_code",
        },
        status: "connecting",
        transport: "http",
        toolCount: 0,
        updatedAt: new Date(1).toISOString(),
      };
      await new Promise<void>((resolve) => {
        onConnectWaiter(resolve);
      });
      statuses.notion = {
        status: "connected",
        transport: "http",
        toolCount: 3,
        updatedAt: new Date(2).toISOString(),
      };
      return {
        statuses,
        tools: [],
      };
    },
    async connectServer(name, config) {
      const status = {
        status: "connecting" as const,
        transport: config.type,
        toolCount: 0,
        updatedAt: new Date(1).toISOString(),
      };
      statuses[name] = status;
      return status;
    },
    async disconnectServer(name) {
      const status = statuses[name];
      delete statuses[name];
      return status;
    },
    async listTools() {
      return [];
    },
    async status() {
      return statuses;
    },
  };
}

type ShellInitializationCandidate = Parameters<
  ZCodeApp["runtime"]["initializeSessionShellEnvironmentIfNeeded"]
>[0];

function resolveShellInitializationCandidate(
  candidate: ShellInitializationCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

function createShellRecordingFakeApp(
  options: ZCodeAppOptions,
  shellInitializations: unknown[],
  createdAppOptions?: ZCodeAppOptions[],
): ZCodeApp {
  createdAppOptions?.push(options);
  const app = createFakeApp(options);
  let effectiveShellSelection = options.runtimeConfig?.bashShellSelection;
  let shellInitialized = effectiveShellSelection !== undefined;
  let shellInitializationPromise: Promise<void> | undefined;
  const recordShellInitialization = (selection: ShellInitializationCandidate) => {
    if (shellInitialized) {
      return false;
    }
    const resolvedSelection = resolveShellInitializationCandidate(selection);
    effectiveShellSelection = resolvedSelection;
    shellInitialized = true;
    shellInitializations.push(resolvedSelection);
    return true;
  };
  const initializeFromStartupPreferences = async () => {
    if (shellInitialized) {
      return;
    }
    shellInitializationPromise ??= (async () => {
      const selection = await options.resolveInitialBashShellSelection?.();
      if (selection) {
        recordShellInitialization(selection);
      }
    })();
    await shellInitializationPromise;
  };
  return {
    ...app,
    resume: async (resumeOptions) => {
      await initializeFromStartupPreferences();
      return app.resume(resumeOptions);
    },
    runtime: {
      ...app.runtime,
      getSessionShellSelection: () => effectiveShellSelection,
      initializeSessionShellEnvironmentIfNeeded: recordShellInitialization,
    } as never,
    sendInput: async (input, sendOptions) => {
      await initializeFromStartupPreferences();
      return app.sendInput(input, sendOptions);
    },
  };
}
