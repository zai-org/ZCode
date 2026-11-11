import type { RuntimeInputPresentation } from "@zcode/contracts";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import { SessionEventType, createPartId, traceContextToLogContext } from "../deps.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import type {
  EnvInfo,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageVisibility,
  Model,
  ModelTextContentBlock,
  SessionId,
  SessionProjection,
  SessionStorePort,
  TraceContext,
  SyntheticUserMessageSource,
  TurnInputIntentMetadata,
  TurnExecutionKind,
} from "../deps.js";
import {
  emptyTokenUsageInfo,
  isHiddenReminderMessage,
  toTokenUsageInfo,
} from "../helpers/index.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildSyntheticUserNoticeMessageMetadata,
  buildSyntheticUserNoticePartMetadata,
  buildSyntheticUserNoticeSemantics,
} from "./synthetic-notice-metadata.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { buildProjectionAnchor, mapSyntheticSourceToAnchorOrigin } from "./projection-anchor.js";

export async function persistUserPrompt(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  input: string,
  attachments: ResolvedTurnAttachment[] | undefined,
  traceContext: TraceContext,
  options?: {
    /**
     * drain 注入的输入把投递语义落到持久事实（metadata.turnSteerDelivery），
     * 冷恢复据此还原「queue=独立轮 / guide=内联当前轮」的切分，与 live 结构一致。
     */
    steerDelivery?: "guide" | "queue";
    inputPresentation?: RuntimeInputPresentation;
    /**
     * （promotion 原子性）：给定账本 id 且 store 支持时，账本置 promoted
     * 与 message/parts 持久化走同一事务——杜绝「queue 已消费但 transcript 无
     * user message」的孤儿窗口（旧 drain 跨 store 无事务）。
     */
    sessionInputId?: string;
    /** V4 command 幂等锚点；必须来自 CLI admission，不能在 drain 时换新 id。 */
    sourceCommandId?: string;
    clientId?: string;
    intent?: TurnInputIntentMetadata;
    /** 冷恢复所需的执行语义；不能只存在于 live TurnStarted。 */
    executionKind?: TurnExecutionKind;
    /** 引擎附加文本的起点；同样为冷恢复而存。 */
    epilogueStart?: number;
  },
): Promise<void> {
  this.latestConversationMessageId = messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  const tools = Object.fromEntries(this.getTools().map((tool) => [tool.name, true]));
  const conversationInputIntent = buildPersistedConversationInputIntent(
    input,
    options?.intent,
    "drained",
  );
  const message: Parameters<SessionStorePort["saveMessage"]>[0] = {
    id: messageID,
    sessionID: this.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    modelSelection: this.getSessionModelSelection(),
    contextSnapshot: buildPersistedContextSnapshot(this.config.envInfo),
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    anchor: buildProjectionAnchor(
      traceContext,
      "realUser",
      options?.intent?.sourceCommandId ?? options?.sourceCommandId,
    ),
    system: this.config.systemPrompt,
    tools,
    ...(options?.inputPresentation ||
    options?.steerDelivery ||
    options?.clientId ||
    options?.intent ||
    options?.executionKind ||
    options?.epilogueStart !== undefined
      ? {
          metadata: {
            ...(options?.steerDelivery ? { turnSteerDelivery: options.steerDelivery } : {}),
            ...(options?.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
            ...(options?.intent ? { inputIntent: options.intent } : {}),
            ...(conversationInputIntent ? { conversationInputIntent } : {}),
            ...((options?.intent?.clientId ?? options?.clientId)
              ? { inputClientId: options?.intent?.clientId ?? options?.clientId }
              : {}),
            ...(options?.executionKind ? { executionKind: options.executionKind } : {}),
            ...(options?.intent?.highspeed ? { highspeed: options.intent.highspeed } : {}),
            ...(options?.epilogueStart === undefined
              ? {}
              : { epilogueStart: options.epilogueStart }),
          },
        }
      : {}),
  };
  const parts: MessagePart[] = [
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID,
      type: "text",
      text: withConversationQuotes(
        input,
        options?.intent?.conversationQuotes,
        options?.intent?.botGroupSource,
      ),
      time: {
        start: created,
        end: created,
      },
    },
    ...(attachments ?? []).map(
      (attachment): MessagePart => ({
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "file",
        mime: attachment.mime,
        filename: attachment.filename,
        url: attachment.url,
        source: attachment.source,
        metadata: attachment.metadata,
      }),
    ),
  ];

  if (options?.sessionInputId && this.sessionStore.promoteSessionInput) {
    await this.sessionStore.promoteSessionInput({
      id: options.sessionInputId,
      sessionID: this.sessionId,
      message,
      parts,
    });
    this.logger?.debug("Session input promoted", {
      ...traceContextToLogContext(traceContext),
      event: "session_input.promoted",
      messageId: messageID,
      module: "core.runtime",
      sessionInputId: options.sessionInputId,
      status: "completed",
    });
    const sourceCommandId =
      options.intent?.sourceCommandId ?? options.sourceCommandId ?? options.sessionInputId;
    // promotion 事务提交后再发事件：gateway 只能在此边界解除 live-input pin。
    // 若在 queue remove/TurnStarted 就解除，LRU churn 会在 transcript 尚未落盘时把
    // commands/query 退化成 unknown，重复执行同一输入。
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionInputPromoted,
        {
          pendingInputId: options.sessionInputId,
          sourceCommandId,
          messageId: messageID,
        },
        traceContext,
      ),
      traceContext,
    );
    return;
  }

  await this.persistMessage(message, traceContext);
  for (const part of parts) {
    await this.persistPart(part, traceContext);
  }
}

export async function persistSyntheticUserNotice(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "rewind",
    text,
    traceContext,
  });
}

export async function persistSyntheticUserNoticeForSession(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    /** 多段时每段一个文本 part，按顺序写入同一条消息。 */
    text: string | readonly string[];
    traceContext: TraceContext;
    /** 额外结构化 metadata，会与 `{ source }` 合并写到 part.metadata 上，供 UI 识别消息类型。 */
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  },
): Promise<void> {
  const created = Date.now();
  const visibility = options.visibility ?? "model-only";
  const info: MessageInfo = {
    id: options.messageID,
    sessionID: options.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    metadata: buildSyntheticUserNoticeMessageMetadata(options.source, visibility, options.metadata),
    modelSelection: this.getSessionModelSelection(),
    semantics: buildSyntheticUserNoticeSemantics(options.source, visibility),
    anchor: buildProjectionAnchor(
      options.traceContext,
      mapSyntheticSourceToAnchorOrigin(options.source),
    ),
    source: options.source,
    system: this.config.systemPrompt,
    synthetic: true,
    visibility,
  };
  const texts = typeof options.text === "string" ? [options.text] : options.text;
  const parts: MessagePart[] = texts.map((text) => ({
    id: createPartId(),
    sessionID: options.sessionId,
    messageID: options.messageID,
    type: "text",
    text,
    synthetic: true,
    time: {
      start: created,
      end: created,
    },
    metadata: buildSyntheticUserNoticePartMetadata(options.source, visibility, options.metadata),
  }));
  // 修复原因：冷恢复的 getLatestActiveSessionMessageId 跳过隐藏提醒（agent listing 等公告），
  // 这里却总移动指针，live 与冷恢复的 compaction 覆盖边界、timeline 锚点不一致。
  // 用同一个判定，并传入将要写入的同一条记录（含 part），与冷恢复读到的完全相同。
  if (options.sessionId === this.sessionId && !isHiddenReminderMessage({ info, parts })) {
    this.latestConversationMessageId = options.messageID;
  }
  if (!this.sessionStore) return;

  // 多个 part 同一事务写入：中途失败时不会留下只有前几段的消息，冷恢复读到的段数与 live 相同。
  if (parts.length > 1 && this.sessionStore.commitMessageBundle) {
    await this.sessionStore.commitMessageBundle({
      sessionID: options.sessionId,
      messages: [{ info, parts }],
    });
    this.logger?.debug("Session message bundle persisted", {
      ...traceContextToLogContext(options.traceContext),
      event: "session.message_bundle.persisted",
      messageId: options.messageID,
      module: "core.runtime",
      partCount: parts.length,
      status: "completed",
    });
    return;
  }
  await this.persistMessage(info, options.traceContext);
  for (const part of parts) await this.persistPart(part, options.traceContext);
}

export async function persistAssistantMessage(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  parentID: MessageId,
  created: number,
  update:
    | {
        completed?: number;
        error?: { name: string; data?: Record<string, unknown> };
        finish?: string;
        tokens?: ReturnType<typeof toTokenUsageInfo>;
        /** 这一步来自签名修复后的重试；写进 metadata，冷恢复后投影继续去掉修复前的签名块。 */
        signedReasoningReset?: boolean;
      }
    | undefined,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  this.latestConversationMessageId = messageID;
  this.latestAssistantMessageId = messageID;
  if (traceContext.turnId) {
    this.latestAssistantTurnId = traceContext.turnId;
  }
  if (!this.sessionStore) return;
  const selection = this.getSessionModelSelection();
  const providerId =
    model?.providerId ?? (selection && createModelProviderId(selection.providerId));
  const modelId = model?.modelId ?? (selection && createModelId(selection.modelId));

  await this.persistMessage(
    {
      id: messageID,
      sessionID: this.sessionId,
      role: "assistant",
      time: {
        created,
        completed: update?.completed,
      },
      error: update?.error,
      parentID,
      // 默认模型可能在请求进行中切换；模型请求路径必须显式传入生成这条
      // 消息的模型。默认值只保留给不经过模型结果的既有 synthetic/fallback 路径。
      modelId,
      providerId,
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        // cwd 可随 Bash cd 变化，root 必须保留会话初始工作区身份。
        root: this.workspaceRoot,
      },
      cost: 0,
      tokens: update?.tokens ?? emptyTokenUsageInfo(),
      finish: update?.finish,
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(traceContext),
      // 同一条消息每次保存都是整行覆盖；完成时必须带上标记，不能只在某次中间保存里写。
      ...(update?.signedReasoningReset ? { metadata: { signedReasoningReset: true } } : {}),
    },
    traceContext,
  );
}

export async function persistMessage(
  this: AgentRuntimeInternal,
  input: Parameters<SessionStorePort["saveMessage"]>[0],
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.saveMessage(input, copyFrom);
  this.logger?.debug("Session message persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.message.persisted",
    messageId: input.id,
    module: "core.runtime",
    role: input.role,
    status: "completed",
  });
}

export async function persistPart(
  this: AgentRuntimeInternal,
  input: MessagePart,
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.savePart(input, copyFrom);
  this.logger?.debug("Session part persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.part.persisted",
    messageId: input.messageID,
    module: "core.runtime",
    partId: input.id,
    partType: input.type,
    status: "completed",
  });
}

/**
 * 每个文字块写一个 text part，冷恢复与 live 一样一块一行；空块不写。
 * 没有 textBlocks 时（旧路径）整段文字写成一个不带序号的 part。
 */
export async function persistTextBlockParts(
  runtime: AgentRuntimeInternal,
  input: {
    messageId: MessageId;
    textBlocks: readonly ModelTextContentBlock[] | undefined;
    text: string;
    time: { start: number; end: number };
  },
  traceContext: TraceContext,
): Promise<void> {
  const textBlocks = input.textBlocks ?? [{ type: "text" as const, text: input.text }];
  for (const block of textBlocks) {
    if (block.text.length === 0) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: input.messageId,
        type: "text",
        text: block.text,
        ...(block.blockIndex !== undefined ? { blockIndex: block.blockIndex } : {}),
        time: { ...input.time },
      },
      traceContext,
    );
  }
}

function buildPersistedContextSnapshot(envInfo: EnvInfo | undefined):
  | {
      envInfo: EnvInfo;
    }
  | undefined {
  if (!envInfo) {
    return undefined;
  }

  return { envInfo: { ...envInfo } };
}

export async function rebuildProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  const events = await this.eventStore.getEvents(this.sessionId);
  return this.eventReducer.reduce(events);
}
