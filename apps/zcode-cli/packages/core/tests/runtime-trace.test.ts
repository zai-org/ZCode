import { withoutAgentListingMessages } from "./test-agent-listing.js";
import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  SessionEventType,
  type LogContext,
  type Logger,
  type McpConnectionSnapshot,
  type McpPort,
  type SessionEvent,
  type SessionEventSink,
  type SessionEventStorePort,
  type TraceContext,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createContextBuilder } from "../src/context/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestImageArtifactStore } from "./test-image-artifact-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function providerContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "type" in block) {
          if (block.type === "text" && "text" in block) {
            return String(block.text);
          }
          return JSON.stringify(block);
        }
        return String(block ?? "");
      })
      .join("\n");
  }
  return String(content ?? "");
}

const EPHEMERAL = { type: "ephemeral" };
const reminderText = (body: string) => `<system-reminder>\n${body}\n</system-reminder>`;
const MODEL_REMINDER = reminderText(
  "You are powered by the model named test/default-runtime-model.",
);
const ENVIRONMENT_REMINDER = expect.stringMatching(
  /^<system-reminder>\n# Environment\n[\s\S]*\n<\/system-reminder>$/,
);
// 日期跟随真实时钟。默认测试模型不合并相邻 user，紧跟输入的那一块也不补换行。
const TODAY_REMINDER = expect.stringMatching(
  /^<system-reminder>\nToday's date is \d{4}-\d{2}-\d{2}\.\n<\/system-reminder>$/,
);
// 真实用户消息的轮首重新起算，token 预算提醒为满额。
const TOTAL_TOKENS_TURN_START_REMINDER = reminderText(
  "<total_tokens>15000000 tokens left</total_tokens>",
);

function providerMessagesToText(messages: readonly { content?: unknown }[] | undefined): string {
  return (messages ?? []).map((message) => providerContentToText(message.content)).join("\n");
}

describe("AgentRuntime trace propagation", () => {
  it("uses one trace id for turn, model, and session events", async () => {
    let capturedTraceContext: TraceContext | undefined;
    let capturedMetadata: Record<string, unknown> | undefined;
    const sessionId = createSessionId("runtime-trace");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        logger,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            capturedTraceContext = observation.invocationContext?.traceContext;
            capturedMetadata = observation.invocationContext?.metadata;
            return {
              finishReason: "stop",
              model: observation.model,
              providerMetadata: undefined,
              text: "model response",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
        traceContext,
      },
    );

    const result = await runtime.executeTurn("hello");
    const events = await eventStore.getEvents(sessionId);

    expect(result.traceId).toBe(traceContext.traceId);
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set([traceContext.traceId]));
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.ModelRequest,
      SessionEventType.ModelComplete,
      SessionEventType.TurnComplete,
    ]);
    const turnStarted = events.find((event) => event.type === SessionEventType.TurnStarted);
    const turnQueryId = (turnStarted?.payload as Record<string, unknown> | undefined)?.queryId;
    expect(turnQueryId).toEqual(expect.stringMatching(/^query_/));
    expect(capturedTraceContext?.traceId).toBe(traceContext.traceId);
    expect(capturedTraceContext?.queryId).toBe(turnQueryId);
    expect(capturedMetadata?.traceId).toBe(traceContext.traceId);
    expect(capturedMetadata?.queryId).toBe(turnQueryId);
    expect(capturedMetadata?.sessionId).toBe(sessionId);
    expect(result.response).toBe("model response");
    expect(result.projection.totalTokenCount).toBe(5);
    const turnComplete = events.find((event) => event.type === SessionEventType.TurnComplete);
    expect(turnComplete?.payload).toMatchObject({ historyRoundCount: 1 });

    const usageLog = logger.entries.find(
      (entry) => entry.level === "debug" && entry.message === "Context usage snapshot",
    );
    const usageContext = usageLog?.context as
      | (LogContext & {
          categories?: Array<Record<string, unknown>>;
          categoryBreakdown?: Array<Record<string, unknown>>;
          messageBreakdown?: Array<Record<string, unknown>>;
        })
      | undefined;
    expect(usageContext).toMatchObject({
      event: "context_usage_snapshot",
      module: "core.runtime",
      sessionId,
      status: "completed",
      tokenMethod: "estimated",
      traceId: traceContext.traceId,
    });
    expect(usageContext?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: expect.any(String),
          source: "messages",
          tokenMethod: "estimated",
          tokenizer: "zcode.estimateTokens.v1",
          tokens: expect.any(Number),
        }),
      ]),
    );
    expect(usageContext?.messageBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          tokenMethod: "estimated",
        }),
      ]),
    );
    expect(
      usageContext?.categoryBreakdown?.find((category) => category.source === "messages"),
    ).toMatchObject({
      source: "messages",
      contributors: expect.arrayContaining([
        expect.objectContaining({
          kind: "message_role",
          role: "user",
          count: expect.any(Number),
          tokenMethod: "estimated",
        }),
      ]),
    });
    const modelComplete = events.find((event) => event.type === SessionEventType.ModelComplete);
    expect((modelComplete?.payload as Record<string, unknown>)?.contextUsageBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chars: expect.any(Number),
          source: "messages",
        }),
      ]),
    );
  });

  it("logs image attachment resolution and model media projection without payloads", async () => {
    const sessionId = createSessionId("runtime-image-media-logs");
    const traceContext = createRootTraceContext({ sessionId });
    const logger = new CapturingLogger();
    const runtime = createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/workspace" },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        logger,
        modelFactory: createTestModelFactory({
          async generateText() {
            return {
              finishReason: "stop",
              model: { modelId: "test-model", providerId: "test-provider" },
              providerMetadata: undefined,
              text: "image response",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
        traceContext,
      },
    );

    await runtime.executeTurn("describe [image #1]", [
      {
        content: "data:image/png;base64,aW1hZ2U=",
        path: "[image #1]",
        type: "image",
      },
    ]);

    const attachmentLog = logger.entries.find(
      (entry) => entry.context?.event === "turn.attachments.resolved",
    );
    expect(attachmentLog?.context).toMatchObject({
      attachmentCount: 1,
      event: "turn.attachments.resolved",
      imageAttachmentCount: 1,
      module: "core.runtime",
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(attachmentLog?.context?.attachments).toEqual([
      expect.objectContaining({
        contentBlockType: "image",
        mediaType: "image/png",
        mime: "image/png",
        placeholder: "[image #1]",
        recoverability: "provider_ready",
        sourceKind: "inline",
        storageKind: "artifact",
        urlKind: "artifact",
      }),
    ]);

    const mediaLog = logger.entries.find(
      (entry) => entry.context?.event === "model.request.media_summary",
    );
    expect(mediaLog?.context).toMatchObject({
      event: "model.request.media_summary",
      incomingMediaBlockCount: 1,
      omittedMediaCount: 0,
      providerMediaBlockCount: 1,
      retainedMediaCount: 1,
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(mediaLog?.context?.providerMediaBlocks).toEqual([
      expect.objectContaining({
        blockType: "image",
        mediaType: "image/png",
        placeholder: "[image #1]",
        role: "user",
        sourceKind: "inline",
      }),
    ]);
    expect(JSON.stringify([attachmentLog?.context, mediaLog?.context])).not.toContain("aW1hZ2U");
  });

  it("logs turn steering queue, drain, and model request context", async () => {
    const sessionId = createSessionId("runtime-steer-logs");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    let runtime: AgentRuntime;
    let modelCallCount = 0;

    runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        logger,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            modelCallCount++;
            if (modelCallCount === 1) {
              const activeTurn = runtime.getActiveTurnInfo();
              expect(activeTurn?.steerable).toBe(true);
              const result = await runtime.steerTurn({
                delivery: "guide",
                expectedTurnId: activeTurn?.turnId,
                input: "keep the original task but switch to option B",
              });
              expect(result.kind).toBe("queued");
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "first answer",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "second answer",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
        traceContext,
      },
    );

    const result = await runtime.executeTurn("original task");
    const logContexts = logger.entries.map((entry) => entry.context);
    const queued = logContexts.find((context) => context?.event === "turn.steer.queued");
    const drained = logContexts.find((context) => context?.event === "turn.steer.drained");
    const steeredRequest = logContexts.find(
      (context) =>
        context?.event === "model.request.steering_context" &&
        context.drainedInputVisibleAtTail === true,
    );

    expect(result.response).toBe("second answer");
    expect(modelCallCount).toBe(2);
    expect(queued).toMatchObject({
      event: "turn.steer.queued",
      inputPreview: "keep the original task but switch to option B",
      queryId: expect.stringMatching(/^query_/),
      queueLength: 1,
      sessionId,
      status: "waiting",
      traceId: traceContext.traceId,
    });
    const steerQueryId = queued?.queryId;
    expect(drained).toMatchObject({
      drainedCount: 1,
      event: "turn.steer.drained",
      inputPreviews: ["keep the original task but switch to option B"],
      queryId: steerQueryId,
      queryIds: [steerQueryId],
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(steeredRequest).toMatchObject({
      drainedInputCount: 1,
      drainedInputVisibleAtTail: true,
      event: "model.request.steering_context",
      latestUserMessageFromEnd: 0,
      modelStepCount: 1,
      queryId: steerQueryId,
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    const messageTailRoles = steeredRequest?.messageTailRoles as string[] | undefined;
    // 纯文本回复后取出的 guide 重新起算 token 预算；提醒（MCS 关时为单独的 user reminder）
    // 按投影规则冒泡到这条 user 输入之前。
    expect(messageTailRoles?.slice(-3)).toEqual(["assistant", "user", "user"]);
    const steeredMessageTail = steeredRequest?.messageTail as
      | Array<Record<string, unknown>>
      | undefined;
    expect(steeredMessageTail?.at(-2)).toMatchObject({
      contentBytes:
        "<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>"
          .length,
      role: "user",
    });
    expect(steeredMessageTail?.at(-1)).toMatchObject({
      contentBytes: "keep the original task but switch to option B".length,
      role: "user",
    });
  });

  it("emits full context sections through the debug logger for debug observers", async () => {
    const sessionId = createSessionId("runtime-context-debug");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    const contextBuilder = createContextBuilder({
      workingDirectory: ".",
      envInfo: {
        cwd: ".",
        nodeVersion: "v24.14.0",
        osVersion: "test",
        platform: "test",
        shell: "test",
      },
    }).addSection({
      name: "Debug Section",
      source: "request_user_context",
      content: "debug context section body",
      preview: "debug context section body",
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        contextBuilder,
        eventStore,
        logger,
        traceContext,
      },
    );

    expect(runtime.getContextBuilder()).toBe(contextBuilder);

    const contextLog = logger.entries.find(
      (entry) => entry.level === "debug" && entry.message === "Context built",
    );
    const context = contextLog?.context as
      | (LogContext & {
          sections?: Array<Record<string, unknown>>;
        })
      | undefined;

    expect(context).toMatchObject({
      event: "context.built",
      module: "core.runtime",
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(context?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chars: "debug context section body".length,
          content: "debug context section body",
          name: "Debug Section",
          preview: "debug context section body",
          source: "request_user_context",
          tokens: expect.any(Number),
        }),
      ]),
    );
    expect(context?.sections?.[0]).toEqual(
      expect.objectContaining({
        chars: expect.any(Number),
        content: expect.any(String),
        name: expect.any(String),
        preview: expect.any(String),
        source: expect.any(String),
        tokens: expect.any(Number),
      }),
    );
  });

  it("does not let getContextBuilder preempt async context initialization", async () => {
    const sessionId = createSessionId("runtime-get-context-builder-lazy-init");
    const eventStore = createTestSessionEventStore();
    let resolveCount = 0;
    let requestEnvInfo: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const detectedEnvInfo = {
      cwd: "/resolved",
      platform: "linux",
      shell: "bash",
      osVersion: "Linux 6.6.0",
      nodeVersion: "v24.14.0",
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/initial",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            resolveCount++;
            requestEnvInfo = request.envInfo;
            return {
              workingDirectory: "/resolved",
              currentDate: "2026-06-02",
              diagnostics: [],
              envInfo: request.envInfo ?? detectedEnvInfo,
              userInstructions: {
                filePath: "/resolved/AGENTS.md",
                fileName: "AGENTS.md",
                content: "resolved project instructions",
                bytesRead: "resolved project instructions".length,
                sizeBytes: "resolved project instructions".length,
                truncated: false,
              },
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    runtime.getContextBuilder();
    await runtime.executeTurn("hello");

    expect(resolveCount).toBe(1);
    expect(requestEnvInfo).toBeUndefined();
    const requestText = providerMessagesToText(requests[0]);
    expect(requestText).toContain("/resolved");
    expect(requestText).toContain("- Platform: linux");
    expect(requestText).toContain("resolved project instructions");
    expect(requests[0]?.at(-1)?.role).toBe("user");
    expect(requests[0]?.at(-1)?.content).toContain("hello");
  });

  it("passes the effective Bash shell snapshot to context source resolution", async () => {
    const sessionId = createSessionId("runtime-context-effective-shell");
    const eventStore = createTestSessionEventStore();
    let requestShellDisplayName: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        bashShellSelection: {
          dialect: "posix",
          display: { name: "zsh" },
          path: "/usr/bin/zsh",
          source: "auto-detected",
        },
        workingDirectory: "/resolved",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            requestShellDisplayName = request.effectiveShellDisplayName;
            return {
              workingDirectory: "/resolved",
              currentDate: "2026-06-20",
              diagnostics: [],
              envInfo: {
                cwd: "/resolved",
                nodeVersion: "v24.14.0",
                osVersion: "Linux 6.6.0",
                platform: "linux",
                shell: request.effectiveShellDisplayName ?? "fish",
              },
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello");

    expect(requestShellDisplayName).toBe("zsh");
    expect(providerMessagesToText(requests[0])).toContain("- Shell: zsh");
  });

  it("initializes session shell environment once and ignores later candidates", async () => {
    const sessionId = createSessionId("runtime-session-shell-owner-once");
    const eventStore = createTestSessionEventStore();
    let requestShellDisplayName: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const firstSelection = {
      dialect: "posix" as const,
      display: { name: "zsh" },
      path: "/bin/zsh",
      source: "auto-detected" as const,
    };
    const secondSelection = {
      dialect: "posix" as const,
      display: { name: "bash" },
      path: "/bin/bash",
      source: "auto-detected" as const,
    };

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/workspace",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            requestShellDisplayName = request.effectiveShellDisplayName;
            return {
              currentDate: "2026-06-23",
              diagnostics: [],
              envInfo: {
                cwd: "/workspace",
                nodeVersion: "v24.14.0",
                osVersion: "Linux 6.6.0",
                platform: "linux",
                shell: request.effectiveShellDisplayName ?? "fish",
              },
              workingDirectory: "/workspace",
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    let firstCandidateResolveCount = 0;
    let secondCandidateResolveCount = 0;
    expect(
      runtime.initializeSessionShellEnvironmentIfNeeded(() => {
        firstCandidateResolveCount += 1;
        return firstSelection;
      }),
    ).toBe(true);
    expect(
      runtime.initializeSessionShellEnvironmentIfNeeded(() => {
        secondCandidateResolveCount += 1;
        return secondSelection;
      }),
    ).toBe(false);
    expect(firstCandidateResolveCount).toBe(1);
    expect(secondCandidateResolveCount).toBe(0);

    await runtime.executeTurn("check shell");

    expect(requestShellDisplayName).toBe("zsh");
    expect(providerMessagesToText(requests[0])).toContain("- Shell: zsh");
  });

  it("refreshes the initial shell environment when shell changes before the first conversation message", async () => {
    const sessionId = createSessionId("runtime-shell-pre-conversation-refresh");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    let requestMessages: Array<{ role: string; content: string }> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/workspace",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            return {
              workingDirectory: "/workspace",
              currentDate: "2026-06-20",
              diagnostics: [],
              envInfo: {
                cwd: "/workspace",
                nodeVersion: "v24.14.0",
                osVersion: "Linux 6.6.0",
                platform: "linux",
                shell: request.effectiveShellDisplayName ?? "fish",
              },
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requestMessages = withoutAgentListingMessages(request.messages).map((message) => ({
              content: providerContentToText(message.content),
              role: message.role,
            }));
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
        traceContext,
      },
    );

    await runtime.ensureContextInitialized(traceContext);
    runtime.initializeSessionShellEnvironmentIfNeeded({
      dialect: "git-bash",
      display: { name: "Git Bash" },
      id: "git-bash:/usr/bin/bash",
      label: "Git Bash",
      path: "/usr/bin/bash",
      source: "user-config",
    });
    await runtime.executeTurn("first");

    const requestText = providerMessagesToText(requestMessages);
    expect(requestText).toContain("- Shell: Git Bash");
    expect(requestText).not.toContain("- Shell: fish");
  });

  it("does not let pre-initialization model updates preempt env detection", async () => {
    const sessionId = createSessionId("runtime-model-update-before-context-init");
    const eventStore = createTestSessionEventStore();
    let requestEnvInfo: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const detectedEnvInfo = {
      cwd: "/resolved",
      platform: "linux",
      shell: "bash",
      osVersion: "Linux 6.6.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "feat/trajectory-167",
      gitStatus: "dirty" as const,
      gitStatusLines: [" M package.json"],
      recentCommits: ["abc123 test commit"],
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/resolved",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            requestEnvInfo = request.envInfo;
            return {
              workingDirectory: "/resolved",
              currentDate: "2026-06-11",
              diagnostics: [],
              envInfo: request.envInfo ?? detectedEnvInfo,
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    runtime.setSessionModelSelection(
      createTestModelSelection(createTestModelSelection("openai/test-model")),
    );
    await runtime.executeTurn("hello");

    expect(requestEnvInfo).toBeUndefined();
    const requestText = providerMessagesToText(requests[0]);
    expect(requestText).toContain(" - Is a git repository: true");
    expect(requestText).toContain("- Platform: linux");
    expect(requestText).toContain("Current branch: feat/trajectory-167");
    expect(requestText).not.toContain("- Platform: unknown");
    expect(requestText).not.toContain(" - Is a git repository: false");
  });

  it("treats systemPrompt as a custom prompt while preserving userContext", async () => {
    const sessionId = createSessionId("runtime-custom-system-body");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are terse for this session.",
        language: "Chinese",
        outputStyle: {
          name: "Terse",
          prompt: "Keep responses short.",
          keepCodingInstructions: false,
        },
        compact: {
          enabled: true,
          microcompact: {
            enabled: true,
            keepRecentToolResults: 3,
          },
        },
        currentDate: "2026-06-04",
        projectContext: {
          type: "node",
          packageManager: "pnpm",
          scripts: {
            test: "vitest",
          },
        },
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux 6.6.0",
          nodeVersion: "v24.14.0",
          isGitRepository: true,
          gitBranch: "main",
          gitStatus: "dirty",
          gitStatusLines: [" M package.json"],
        },
      },
      {
        eventStore,
        now: () => new Date(2026, 5, 4, 12),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello");

    expect(requests[0]?.[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(requests[0]?.[0]?.content).toBe("You are ZCode, an interactive agent");
    expect(requests[0]?.[1]?.content).toBe("\nYou are terse for this session.");
    // 自定义 prompt 不影响环境与模型公告。
    expect(requests[0]?.[2]?.content).toContain("# Environment\n");
    expect(requests[0]?.[3]?.content).toContain("You are powered by the model named");
    // 自定义 prompt 也宣告 output style 指令，紧跟模型公告。
    expect(requests[0]?.[4]?.content).toContain("# Output Style: Terse\nKeep responses short.");
    // 自定义 prompt 不带 system 预算行，但轮首的 token 预算提醒照常发，排在 output_style 之前。
    expect(requests[0]?.[5]).toEqual({
      role: "user",
      content:
        "<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>",
    });
    // 输入附件（output_style）在前，请求前公告（date）在后，与两个收集器的顺序一致。
    expect(requests[0]?.[6]?.role).toBe("user");
    expect(requests[0]?.[6]?.content).toContain("Terse output style is active");
    expect(requests[0]?.[6]?.content).toContain("<system-reminder>");
    expect(requests[0]?.[7]?.role).toBe("user");
    expect(requests[0]?.[7]?.content).not.toContain("# agentsMd");
    expect(requests[0]?.[7]?.content).not.toContain("# claudeMd");
    expect(requests[0]?.[7]?.content).not.toContain("Project context:");
    expect(requests[0]?.[7]?.content).not.toContain("- Package manager: pnpm");
    expect(requests[0]?.[7]?.content).not.toContain("- `test`: vitest");
    expect(requests[0]?.[7]?.content).toContain("Today's date is 2026-06-04.");
    expect(requests[0]?.[7]?.content).not.toContain("# user_instructions");
    expect(requests[0]?.[7]?.content).not.toContain("hello");
    expect(requests[0]?.[8]?.role).toBe("user");
    expect(requests[0]?.[8]?.content).toContain("hello");
    const providerText = providerMessagesToText(requests[0]);
    expect(
      requests[0]?.slice(0, 2).some((message) => message.content.includes("total_tokens")),
    ).toBe(false);
    expect(providerText).not.toContain("# Session Guidance");
    expect(providerText).not.toContain("# Session-specific guidance");
    expect(providerText).not.toContain("## Current Environment");
    expect(providerText).not.toContain("# Context management");
    expect(providerText).not.toContain("# Memory");
    expect(providerText).not.toContain("# Language");
    expect(providerText.match(/# Output Style: Terse/g)).toHaveLength(1);
    expect(providerText).not.toContain("# Function Result Clearing");
    expect(providerText).not.toContain("# Summarize Tool Results");
    expect(providerText).not.toContain("M package.json");
  });

  it("preserves context prefix and conversation history without request-time prefix mutation", async () => {
    const sessionId = createSessionId("runtime-context-prefix-refresh");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux 6.6.0",
          nodeVersion: "v24.14.0",
        },
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first" : "second",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(requests[1]?.filter((message) => message.role === "system")).toHaveLength(3);
    const secondRequestText = providerMessagesToText(requests[1]);
    expect(secondRequestText).not.toContain("# Session-specific guidance");
    expect(secondRequestText).not.toContain("`! <command>`");
    expect(secondRequestText).not.toContain(
      "Otherwise use `find` or `grep` via the Bash tool directly.",
    );
    expect(secondRequestText).toContain("first");
    expect(secondRequestText).toContain("second");
  });

  it("keeps aligned system prompt shape across multiple turns with dynamic sections and MCP tools", async () => {
    const sessionId = createSessionId("runtime-system-prompt-multi-turn-dynamic-mcp");
    const eventStore = createTestSessionEventStore();
    const requests: Array<{
      messages: Array<{ role: string; content: string; cacheControl?: unknown }>;
      toolNames: string[];
    }> = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      }),
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        compact: {
          enabled: true,
          microcompact: {
            enabled: true,
            keepRecentToolResults: 2,
          },
        },
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux 6.6.0",
          nodeVersion: "v24.14.0",
        },
        language: "Spanish",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
        outputStyle: {
          name: "Learning",
          prompt: "Explain tradeoffs while solving the task.",
          keepCodingInstructions: false,
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push({
              messages: withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
              toolNames: request.tools.map((tool: { name: string }) => tool.name),
            });
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");

    const second = requests[1];
    // 完整形状：三段 system、请求前公告、第一轮问答、工具批次后的 output style 提醒、第二问。
    // 只有 system 的后两段和最后一条带 cacheControl；公告与历史消息不带。
    const styleActive = reminderText(
      "Learning output style is active. Remember to follow the specific guidelines for this style.",
    );
    expect(second?.messages).toEqual([
      { role: "system", cacheControl: undefined, content: "You are ZCode, an interactive agent" },
      { role: "system", cacheControl: EPHEMERAL, content: expect.stringContaining("# Harness") },
      {
        role: "system",
        cacheControl: EPHEMERAL,
        content: expect.stringMatching(/^\n\nWrite code that reads like the surrounding code/),
      },
      { role: "user", cacheControl: undefined, content: ENVIRONMENT_REMINDER },
      { role: "user", cacheControl: undefined, content: MODEL_REMINDER },
      {
        role: "user",
        cacheControl: undefined,
        content: reminderText(
          "# Output Style: Learning\nExplain tradeoffs while solving the task.",
        ),
      },
      { role: "user", cacheControl: undefined, content: TOTAL_TOKENS_TURN_START_REMINDER },
      { role: "user", cacheControl: undefined, content: styleActive },
      { role: "user", cacheControl: undefined, content: TODAY_REMINDER },
      { role: "user", cacheControl: undefined, content: "first question" },
      { role: "assistant", cacheControl: undefined, content: "first response" },
      { role: "user", cacheControl: undefined, content: TOTAL_TOKENS_TURN_START_REMINDER },
      { role: "user", cacheControl: undefined, content: styleActive },
      { role: "user", cacheControl: EPHEMERAL, content: "second question" },
    ]);
    expect(second?.toolNames).toContain("mcp__local__ping");

    const cliPrefix = second?.messages[0]?.content ?? "";
    const stableBody = second?.messages[1]?.content ?? "";
    const dynamicSystem = second?.messages[2]?.content ?? "";

    expect(cliPrefix).toBe("You are ZCode, an interactive agent");
    expect(stableBody).not.toContain("# Agent Identity");
    expect(stableBody).toContain(
      'You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.',
    );
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).toContain("# Harness");
    expect(stableBody).not.toContain("# Session-specific guidance");
    expect(stableBody).not.toContain("# Environment");
    expect(stableBody).not.toContain("# Context management");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("Write code that reads like the surrounding code");
    expect(stableBody).not.toContain("For actions that are hard to reverse");
    expect(dynamicSystem).not.toContain("# Session Guidance");
    expect(dynamicSystem).toMatch(/^\n\nWrite code that reads like the surrounding code/);
    expect(dynamicSystem).toContain("Write code that reads like the surrounding code");
    expect(dynamicSystem).toContain("For actions that are hard to reverse");
    expect(dynamicSystem).not.toContain("# Session-specific guidance");
    expect(dynamicSystem).not.toContain("`! <command>`");
    expect(dynamicSystem).not.toContain("# Environment");
    expect(providerMessagesToText(second?.messages)).toContain("# Environment");
    expect(dynamicSystem).toContain("# Context management");
    expect(dynamicSystem).not.toContain("not a git repository");
    expect(dynamicSystem).not.toContain("- **Git**:");
    expect(dynamicSystem).not.toContain("# Language");
    expect(dynamicSystem).not.toContain(
      "Respond in the primary language of the user's current prompt",
    );
    expect(dynamicSystem).not.toContain("Respond in Spanish");
    // output style 指令不在 system 里，作为附件宣告。
    expect(dynamicSystem).not.toContain("# Output Style");
    expect(dynamicSystem).not.toContain("# Function Result Clearing");
    expect(dynamicSystem).not.toContain("compactable tool results");
    expect(dynamicSystem).not.toContain("# Summarize Tool Results");
    expect(dynamicSystem).not.toContain("mcp__local__ping");
    expect(dynamicSystem).not.toContain("scratchpad");
    expect(dynamicSystem).not.toContain("token_budget");
    const messageTexts = second?.messages.map((message) => String(message.content)) ?? [];
    const firstQuestionIndex = messageTexts.findIndex((text) => text.includes("first question"));
    const firstReminderIndex = messageTexts.findIndex((text) =>
      text.includes("Learning output style is active"),
    );
    // 风格提醒是独立消息，排在用户问题之前，不并入用户正文。
    expect(firstReminderIndex).toBeGreaterThanOrEqual(0);
    expect(firstReminderIndex).toBeLessThan(firstQuestionIndex);
    expect(messageTexts[firstQuestionIndex]).not.toContain("Learning output style is active");
    expect(second?.messages.at(-1)?.content).toContain("second question");
    const styleReminders =
      second?.messages.filter((message) =>
        message.content.includes("Learning output style is active"),
      ) ?? [];
    const firstOutputStyleReminder = styleReminders[0]?.content ?? "";
    const secondOutputStyleReminder = styleReminders[1]?.content ?? "";
    expect(firstOutputStyleReminder).toContain("Learning output style is active");
    expect(secondOutputStyleReminder).toContain("Learning output style is active");
    expect(firstOutputStyleReminder).toContain("<system-reminder>");
    expect(secondOutputStyleReminder).toContain("<system-reminder>");
    expect(secondOutputStyleReminder).not.toContain("Explain tradeoffs while solving the task.");
    expect(secondOutputStyleReminder).not.toContain("source=");
    expect(
      providerMessagesToText(second?.messages).match(/Learning output style is active/g),
    ).toHaveLength(2);
    expect(JSON.stringify(second?.messages)).not.toContain("runtimeMessage");
  });

  it("preserves system-reminder-looking real user text across config refresh", async () => {
    const sessionId = createSessionId("runtime-config-refresh-real-user-reminder-text");
    const literalUserPrompt = "<system-reminder>\nuser typed this literal tag\n</system-reminder>";
    const requests: Array<Array<{ role: string; content: unknown; cacheControl?: unknown }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn(literalUserPrompt);
    runtime.updateConfig({
      outputStyle: {
        name: "Learning",
        prompt: "Explain tradeoffs while solving the task.",
      },
    });
    await runtime.executeTurn("second question");

    const secondMessages = requests[1] ?? [];
    expect(
      secondMessages.some(
        (message) => message.role === "user" && message.content.includes(literalUserPrompt),
      ),
    ).toBe(true);
    expect(
      secondMessages.some(
        (message) => message.role === "user" && message.content.includes("second question"),
      ),
    ).toBe(true);
    expect(JSON.stringify(secondMessages)).not.toContain("runtimeMessage");
    expect(JSON.stringify(secondMessages)).not.toContain("real_user");
    expect(JSON.stringify(secondMessages)).not.toContain("context_prefix");
  });

  it("keeps conversation history across turns in one runtime", async () => {
    const sessionId = createSessionId("runtime-history");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string; cacheControl?: unknown }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");

    // 完整形状：三段 system，然后是输入附件（环境、模型、token 预算）、请求前公告（日期）和第一问，
    // 公告不带 cacheControl。
    expect(requests[0]?.map(({ role, cacheControl }) => ({ role, cacheControl }))).toEqual([
      { role: "system", cacheControl: undefined },
      { role: "system", cacheControl: EPHEMERAL },
      { role: "system", cacheControl: EPHEMERAL },
      { role: "user", cacheControl: undefined },
      { role: "user", cacheControl: undefined },
      { role: "user", cacheControl: undefined },
      { role: "user", cacheControl: undefined },
      { role: "user", cacheControl: EPHEMERAL },
    ]);
    expect(requests[0]?.slice(3).map((message) => message.content)).toEqual([
      ENVIRONMENT_REMINDER,
      MODEL_REMINDER,
      TOTAL_TOKENS_TURN_START_REMINDER,
      TODAY_REMINDER,
      "first question",
    ]);
    expect(requests[0]?.[0]?.content).toBe("You are ZCode, an interactive agent");
    expect(requests[0]?.[1]?.content).not.toContain("# Agent Identity");
    expect(requests[0]?.[1]?.content).toMatch(
      /^\n?You are an agent working with the user toward their goals/,
    );
    expect(requests[0]?.[1]?.content).toContain("# Harness");
    expect(requests[0]?.[1]?.content).not.toContain("# Session-specific guidance");
    expect(requests[0]?.[1]?.content).not.toContain("# Environment");
    expect(requests[0]?.[1]?.content).not.toContain("# Context management");
    expect(requests[0]?.[1]?.content).not.toContain("# Task Behavior");
    expect(requests[0]?.[1]?.content).not.toContain(
      "Write code that reads like the surrounding code",
    );
    expect(requests[0]?.[1]?.content).not.toContain("For actions that are hard to reverse");
    expect(requests[0]?.[2]?.content).toMatch(
      /^\n\nWrite code that reads like the surrounding code/,
    );
    expect(requests[0]?.[2]?.content).toContain(
      "Before deleting or overwriting, look at the target. Report outcomes faithfully:",
    );
    expect(
      requests[0]?.[2]?.content.indexOf("Write code that reads like the surrounding code"),
    ).toBeLessThan(requests[0]?.[2]?.content.indexOf("For actions that are hard to reverse") ?? -1);
    expect(requests[0]?.[2]?.content.indexOf("For actions that are hard to reverse")).toBeLessThan(
      requests[0]?.[2]?.content.indexOf("# Context management") ?? -1,
    );
    expect(requests[0]?.[2]?.content).not.toContain("# Session-specific guidance");
    expect(requests[0]?.[2]?.content).not.toContain("`! <command>`");
    expect(requests[0]?.[2]?.content).not.toContain("# Language");
    expect(requests[0]?.[2]?.content).not.toContain("# Function Result Clearing");
    expect(requests[0]?.[2]?.content).not.toContain("# Summarize Tool Results");
    expect(requests[0]?.[2]?.content).not.toContain("## Current Environment");
    expect(requests[0]?.[2]?.content).not.toContain("# Environment");
    expect(providerMessagesToText(requests[0])).toContain("# Environment");
    expect(requests[0]?.[2]?.content).toContain("# Context management");
    expect(requests[0]?.[2]?.content).toContain(
      "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey",
    );
    expect(requests[0]?.[2]?.content.indexOf("# Context management")).toBeLessThan(
      requests[0]?.[2]?.content.indexOf("When you have enough information to act, act.") ?? -1,
    );
    expect(
      requests[0]?.[2]?.content.endsWith(
        "If you are weighing a choice, give a recommendation, not an exhaustive survey\n\n<total_tokens>15000000 tokens left</total_tokens>",
      ),
    ).toBe(true);
    expect(requests[0]?.[2]?.content).not.toContain("not a git repository");
    expect(requests[0]?.[2]?.content).not.toContain("- **Git**:");
    expect(requests[0]?.at(-1)).toEqual({
      role: "user",
      content: "first question",
      cacheControl: { type: "ephemeral" },
    });
    expect(requests[1]?.slice(0, -3).map(({ role, content }) => ({ role, content }))).toEqual(
      requests[0]?.map(({ role, content }) => ({ role, content })),
    );
    expect(requests[1]?.at(-4)?.cacheControl).toBeUndefined();
    expect(requests[1]?.at(-3)?.content).toBe("first response");
    expect(requests[1]?.at(-2)?.content).toBe(TOTAL_TOKENS_TURN_START_REMINDER);
    expect(requests[1]?.at(-1)).toEqual({
      role: "user",
      content: "second question",
      cacheControl: { type: "ephemeral" },
    });
  });

  it("keeps structured context prefix before real user messages across turns", async () => {
    const sessionId = createSessionId("runtime-meta-user-context");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string; cacheControl?: unknown }>> = [];
    const envInfo = {
      cwd: "/workspace",
      nodeVersion: "v24.14.0",
      osVersion: "test",
      platform: "test",
      shell: "test",
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      { currentDate: "2026-05-04" },
      {
        // 修复原因：每轮都按 context source 快照重建 builder，注入的 contextBuilder 只影响初始历史，
        // 指令公告从未进入请求，用例测不到它的名字所说的结构化前缀。指令改由 context source 提供。
        contextSourcePort: {
          async resolveEnvironment() {
            return envInfo;
          },
          async resolveGitContext() {
            return envInfo;
          },
          async resolveContextSources() {
            return {
              workingDirectory: "/workspace",
              currentDate: "2026-05-04",
              diagnostics: [],
              envInfo,
              userInstructions: {
                filePath: "/workspace/AGENTS.md",
                fileName: "AGENTS.md",
                content: "project instructions",
                bytesRead: 20,
                sizeBytes: 20,
                truncated: false,
              },
            };
          },
        },
        eventStore,
        now: () => new Date(2026, 4, 4, 12),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");

    // 结构化前缀：环境、模型、token 预算、指令、日期公告都是 user 侧附件，排在第一问之前，不带 cacheControl。
    const prefix = [
      { role: "user", cacheControl: undefined, content: ENVIRONMENT_REMINDER },
      { role: "user", cacheControl: undefined, content: MODEL_REMINDER },
      { role: "user", cacheControl: undefined, content: TOTAL_TOKENS_TURN_START_REMINDER },
      {
        role: "user",
        cacheControl: undefined,
        content: expect.stringMatching(
          /^<system-reminder>\nCodebase and user instructions are shown below\.[\s\S]*Contents of \/workspace\/AGENTS\.md \(project instructions, checked into the codebase\):\n\nproject instructions\n<\/system-reminder>$/,
        ),
      },
      {
        role: "user",
        cacheControl: undefined,
        content: reminderText("Today's date is 2026-05-04."),
      },
    ];
    const systems = [
      { role: "system", cacheControl: undefined, content: "You are ZCode, an interactive agent" },
      { role: "system", cacheControl: EPHEMERAL, content: expect.any(String) },
      { role: "system", cacheControl: EPHEMERAL, content: expect.any(String) },
    ];
    expect(requests[0]).toEqual([
      ...systems,
      ...prefix,
      { role: "user", cacheControl: EPHEMERAL, content: "first question" },
    ]);
    // 第二轮前缀不变：第一问的 cacheControl 移到第二问。
    expect(requests[1]).toEqual([
      ...systems,
      ...prefix,
      { role: "user", cacheControl: undefined, content: "first question" },
      { role: "assistant", cacheControl: undefined, content: "first response" },
      { role: "user", cacheControl: undefined, content: TOTAL_TOKENS_TURN_START_REMINDER },
      { role: "user", cacheControl: EPHEMERAL, content: "second question" },
    ]);
  });

  it("appends a date change once while retaining the initial date in history", async () => {
    const sessionId = createSessionId("runtime-date-change");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const dates = [
      new Date(2026, 5, 2, 10, 0, 0),
      new Date(2026, 5, 2, 11, 0, 0),
      new Date(2026, 5, 3, 0, 5, 0),
      new Date(2026, 5, 3, 9, 0, 0),
    ];
    let nowIndex = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        currentDate: "2026-06-02",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `response ${requests.length}`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
        now: () => dates[nowIndex]!,
      },
    );

    for (const question of [
      "first question",
      "second question",
      "third question",
      "fourth question",
    ]) {
      await runtime.executeTurn(question);
      nowIndex += 1;
    }

    const requestTexts = requests.map((messages) =>
      messages.map((message) => message.content).join("\n"),
    );
    expect(requestTexts[0]).not.toContain("The date has changed.");
    expect(requestTexts[1]).not.toContain("The date has changed.");
    expect(requestTexts[2]).toContain("The date has changed. Today's date is now 2026-06-03.");
    expect(requestTexts[3]).toContain("The date has changed. Today's date is now 2026-06-03.");
    expect(
      requests[2]?.filter((message) => message.content.includes("The date has changed.")),
    ).toHaveLength(1);
    expect(
      requests[3]?.filter((message) => message.content.includes("The date has changed.")),
    ).toHaveLength(1);
    expect(requestTexts[2]).toContain("Today's date is 2026-06-02.");
    expect(requestTexts[3]).toContain("Today's date is 2026-06-02.");
    expect(requestTexts[2]).not.toContain("Today's date is 2026-06-03.");
  });

  it("publishes appended events to a live event sink in order", async () => {
    const sessionId = createSessionId("runtime-live-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: Array<{ sequenceNumber: number; type: string }> = [];
    const eventSink: SessionEventSink = {
      onSessionEvent(event) {
        liveEvents.push({
          sequenceNumber: event.sequenceNumber,
          type: event.type,
        });
      },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventSink,
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "live response",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello live events");

    const storedEvents = (await eventStore.getEvents(sessionId)).map((event) => ({
      sequenceNumber: event.sequenceNumber,
      type: event.type,
    }));
    expect(liveEvents).toEqual([
      { sequenceNumber: 1, type: SessionEventType.TurnStarted },
      { sequenceNumber: 2, type: SessionEventType.ModelRequest },
      { sequenceNumber: 3, type: SessionEventType.ModelComplete },
      { sequenceNumber: 4, type: SessionEventType.TurnComplete },
    ]);
    expect(liveEvents).toEqual(storedEvents);
  });

  it("streams model deltas through session events when enabled", async () => {
    const sessionId = createSessionId("runtime-model-streaming");
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelStreaming: "on" },
      {
        eventStore,
        logger,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText(request) {
            expect(withoutAgentListingMessages(request.messages).at(-1)).toMatchObject({
              content: "hello streaming",
              role: "user",
            });
            yield { type: "text_delta", text: "he" };
            yield { type: "text_delta", text: "llo" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("hello streaming");
    const events = await eventStore.getEvents(sessionId);
    const streamingPayloads = events
      .filter((event) => event.type === SessionEventType.ModelStreaming)
      .map((event) => event.payload as { delta: string; done: boolean; kind: string });

    expect(result.response).toBe("hello");
    expect(streamingPayloads).toEqual([
      { assistantMessageId: expect.any(String), delta: "he", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "llo", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "", done: true, kind: "finish" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.ModelRequest,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelComplete,
      SessionEventType.TurnComplete,
    ]);

    const appendSummary = logger.entries.find(
      (entry) => entry.context?.event === "event_store.appended.summary",
    );
    expect(appendSummary?.context).toMatchObject({
      event: "event_store.appended.summary",
      eventCount: 3,
      firstSessionEventSequenceNumber: 3,
      flushReason: "low_frequency_event",
      lastSessionEventSequenceNumber: 5,
      module: "core.runtime",
      payloadKinds: {
        finish: 1,
        text_delta: 2,
      },
      sessionEventType: SessionEventType.ModelStreaming,
    });
    expect(
      logger.entries.some(
        (entry) =>
          entry.context?.event === "event_store.appended" &&
          entry.context.sessionEventType === SessionEventType.ModelStreaming,
      ),
    ).toBe(false);
  });

  it("keeps consuming model stream chunks while streaming event append is pending", async () => {
    const sessionId = createSessionId("runtime-model-streaming-append-backpressure");
    const baseEventStore = createTestSessionEventStore();
    const firstStreamingAppendStarted = createDeferred<void>();
    const releaseFirstStreamingAppend = createDeferred<void>();
    const secondChunkConsumed = createDeferred<"resolved">();
    let delayedFirstStreamingAppend = false;
    const eventStore: SessionEventStorePort = {
      async append(event: SessionEvent) {
        if (
          event.type === SessionEventType.ModelStreaming &&
          (event.payload as { kind?: string }).kind === "text_delta" &&
          !delayedFirstStreamingAppend
        ) {
          delayedFirstStreamingAppend = true;
          firstStreamingAppendStarted.resolve();
          await releaseFirstStreamingAppend.promise;
        }
        return baseEventStore.append(event);
      },
      deleteSession: (id) => baseEventStore.deleteSession(id),
      getEvents: (id) => baseEventStore.getEvents(id),
      getEventsAfter: (id, sequenceNumber) => baseEventStore.getEventsAfter(id, sequenceNumber),
      getLatestSequenceNumber: (id) => baseEventStore.getLatestSequenceNumber(id),
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelStreaming: "on" },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText() {
            yield { type: "text_delta", text: "直" };
            secondChunkConsumed.resolve("resolved");
            yield { type: "text_delta", text: "接" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never),
      },
    );

    const turnPromise = runtime.executeTurn("hello streaming backpressure");
    await firstStreamingAppendStarted.promise;
    await expect(Promise.race([secondChunkConsumed.promise, waitForTest(30)])).resolves.toBe(
      "resolved",
    );
    releaseFirstStreamingAppend.resolve();

    const result = await turnPromise;
    const streamingPayloads = (await baseEventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.ModelStreaming)
      .map((event) => event.payload as { delta: string; kind: string });

    expect(result.response).toBe("直接");
    expect(streamingPayloads).toEqual([
      { assistantMessageId: expect.any(String), delta: "直", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "接", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "", done: true, kind: "finish" },
    ]);
  });

  it("continues the turn when a live event sink fails", async () => {
    const sessionId = createSessionId("runtime-live-event-sink-failure");
    const eventStore = createTestSessionEventStore();
    const liveEventTypes: string[] = [];
    const eventSink: SessionEventSink = {
      onSessionEvent(event) {
        liveEventTypes.push(event.type);
        if (event.type === SessionEventType.ModelComplete) {
          throw new Error("live sink unavailable");
        }
      },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventSink,
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "sink failure still returns",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("hello failing sink");
    const storedTypes = (await eventStore.getEvents(sessionId)).map((event) => event.type);

    expect(result.response).toBe("sink failure still returns");
    expect(liveEventTypes).toContain(SessionEventType.ModelComplete);
    expect(storedTypes).toContain(SessionEventType.TurnComplete);
  });
});

interface CapturedLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: LogContext;
  error?: Error;
}

class CapturingLogger implements Logger {
  readonly entries: CapturedLogEntry[];

  constructor(
    private readonly defaultContext: LogContext = {},
    entries: CapturedLogEntry[] = [],
  ) {
    this.entries = entries;
  }

  debug(message: string, context?: LogContext): void {
    this.push("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.push("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.push("warn", message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.push("error", message, context, error);
  }

  child(context: LogContext): Logger {
    return new CapturingLogger({ ...this.defaultContext, ...context }, this.entries);
  }

  private push(
    level: CapturedLogEntry["level"],
    message: string,
    context?: LogContext,
    error?: Error,
  ): void {
    this.entries.push({
      level,
      message,
      context: { ...this.defaultContext, ...context },
      error,
    });
  }
}

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: async () => emptyMcpSnapshot(),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    ...overrides,
  };
}

function emptyMcpSnapshot(): McpConnectionSnapshot {
  return {
    statuses: {},
    tools: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function waitForTest(delayMs: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), delayMs);
  });
}

it.each([true, false])(
  "appends a model change once and uses the Harness wording of the request channel (MCS=%s)",
  async (mcs) => {
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      createSessionId(`dynamic-context-${mcs}`),
      {
        workingDirectory: "/workspace",
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux",
          nodeVersion: "24",
          isGitRepository: true,
          gitBranch: "main",
          gitStatus: "clean",
        },
      },
      {
        now: () => new Date(2026, 9, 14, 12),
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: { supportsMidConversationSystem: mcs },
          async generateText(request) {
            requests.push(
              request.messages.map((message) => ({
                role: message.role,
                content: providerContentToText(message.content),
              })),
            );
            return {
              text: "done",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    runtime.setSessionModelSelection(createTestModelSelection("provider-b/model-b"));
    await runtime.executeTurn("third");
    await runtime.executeTurn("fourth");
    const text = (index: number) => requests[index]!.map((message) => message.content).join("\n");
    expect(text(1).match(/powered by the model named provider-a\/model-a/g)).toHaveLength(1);
    expect(text(2)).toContain("powered by the model named provider-a/model-a");
    expect(text(2)).toContain("powered by the model named provider-b/model-b");
    expect(text(3).match(/powered by the model named provider-b\/model-b/g)).toHaveLength(1);
    // Harness 第三条必须描述本请求实际使用的动态上下文通道。
    for (let index = 0; index < 4; index++) {
      const harness = requests[index]![1]!.content;
      expect(harness.includes(MCS_HARNESS_BULLET)).toBe(mcs);
      expect(harness.includes(REMINDER_HARNESS_BULLET)).toBe(!mcs);
    }
  },
);

const MCS_HARNESS_BULLET =
  " - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.";
const REMINDER_HARNESS_BULLET =
  " - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.";

it("keeps the request model's Harness wording for a manual compact after a config rebuild", async () => {
  const requests: Array<{ querySource: unknown; harness: string }> = [];
  const runtime = createTestAgentRuntime(
    createSessionId("harness-manual-compact-after-config"),
    { workingDirectory: "/workspace", titleGeneration: { enabled: false } },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        properties: { supportsMidConversationSystem: false },
        async generateText(request, observation) {
          requests.push({
            querySource: observation.invocationContext?.metadata?.querySource,
            harness: providerContentToText(request.messages[1]?.content),
          });
          return {
            text: "<summary>done</summary>",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    },
  );
  await runtime.executeTurn("first");
  // 轮外改语言会不带模型重建前缀；随后的手动 compact 仍按本次请求的模型投影。
  runtime.updateConfig({ language: "Chinese" });
  await runtime.executeTurn("/compact");

  const compactRequest = requests.find((request) => request.querySource === "compact");
  expect(compactRequest?.harness).toContain(REMINDER_HARNESS_BULLET);
  expect(compactRequest?.harness).not.toContain(MCS_HARNESS_BULLET);
});

it("uses the MCS Harness wording when MCS is forced for a model without MCS support", async () => {
  const requests: string[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId("harness-forced-mcs"),
    {
      workingDirectory: "/workspace",
      titleGeneration: { enabled: false },
      midConversationSystem: { mode: "force" },
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        properties: { supportsMidConversationSystem: false },
        async generateText(request) {
          requests.push(providerContentToText(request.messages[1]?.content));
          return {
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    },
  );
  await runtime.executeTurn("first");
  expect(requests[0]).toContain(MCS_HARNESS_BULLET);
  expect(requests[0]).not.toContain(REMINDER_HARNESS_BULLET);
});
