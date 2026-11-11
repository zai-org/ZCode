// 会话 active 分支投影：协议读取与独立 CLI 会话读取共用同一份规则。
// rewind 后持久化账本仍保留旧分支；读取方必须只看 active branch，否则编辑重发后会同时出现错发原文和新消息。
import {
  parseRewindTriggeredPayload,
  RewindScope,
  RewindStrategy,
  type MessageId,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
} from "@zcode/contracts";
import { getConversationMessageProjectionPolicy } from "@zcode/shared";

/**
 * 与产品对话界面同一判据：只保留真实用户输入、可见回复和时间线事件。
 * 运行时提醒、环境信息与中断标记作为隐藏 user 消息落库，读取方不能当作用户原话返回。
 */
export function isTranscriptVisibleMessage(message: MessageWithParts): boolean {
  const policy = getConversationMessageProjectionPolicy(message);
  return (
    policy === "realUserInput" || policy === "visibleAssistant" || policy === "timelineOnly"
  );
}

export function projectActiveSessionMessages(
  messages: MessageWithParts[],
  session: SessionInfo | null | undefined,
  rewindEvents: readonly SessionEvent[],
): MessageWithParts[] {
  const activeConversationRewinds: ActiveConversationRewindPayload[] = [];
  const sessionRewindPayload = activeConversationRewindPayloadFromSession(session);
  if (sessionRewindPayload) {
    activeConversationRewinds.push(sessionRewindPayload);
  }
  let activeMessages = applyRewindBranch(messages, messages, {
    createdMessageId: sessionRewindPayload?.createdMessageId,
    keptMessageIds: session?.revert?.keptMessageIDs,
    targetMessageId: sessionRewindPayload?.targetMessageId,
  });

  for (const event of rewindEvents) {
    const payload = parseActiveConversationRewindPayload(event);
    if (!payload?.targetMessageId) {
      continue;
    }
    activeConversationRewinds.push(payload);
    activeMessages = applyRewindBranch(activeMessages, messages, payload);
  }

  return filterRewindCommandAckMessages(activeMessages, activeConversationRewinds);
}

type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}

function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core 会为不可用的 rewind 记录 unavailable event，但这类事件没有 createdMessageId。
      // 它不是新的 active branch 起点，协议投影不能用它裁剪消息，否则连续编辑会把可见消息投空。
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // 内部 `/rewind conversation <messageId>` 的成功回执可能被旧事件投影落成
  // assistant 文本。它只是编辑/重试的控制命令 ACK，刷新或恢复时不能再渲染给用户。
  return text === ackText || text.endsWith(`\n${ackText}`);
}

function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  if (options.keptMessageIds) {
    // 连续 rewind 后，账本里的 target 前缀不等于 active branch 前缀。
    // 优先使用 runtime 在 rewind 当时保存的 keptMessageIDs，避免旧分支在 snapshot/readMessages 中复活。
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // conversation rewind 的持久化账本会保留被回滚的旧分支。
  // UI snapshot/readMessages 必须投影 active branch，否则编辑重发后会同时看到错发原文和新消息。
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}
