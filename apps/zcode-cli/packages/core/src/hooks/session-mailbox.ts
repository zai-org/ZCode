import {
  HookEventName,
  type SessionId,
  type SessionMailboxPort,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRegistration } from "./types.js";

const MAILBOX_DRAIN_LIMIT = 20;

// 修复原因：错误结果（Bash 非零退出、MCP isError）改跑 PostToolUseFailure 后，只注册 PostToolUse
// 的 mailbox 在这些调用之后不再取邮件，要等下一次成功的调用或 Stop。工具后的两个事件都按 guide 投递。
const POST_TOOL_EVENTS: readonly HookEventName[] = [
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
];

export function createSessionMailboxHookRegistrations(options: {
  enqueuePendingInput?: (input: string, traceContext: TraceContext) => Promise<void>;
  mailbox: SessionMailboxPort;
  sessionId: SessionId;
}): HookRegistration[] {
  const callback: HookRegistration["callback"] = async (input, context) => {
    const messages = await options.mailbox.drainUnread(
      { sessionId: options.sessionId, limit: MAILBOX_DRAIN_LIMIT },
      { signal: context.signal },
    );
    if (messages.length === 0) return undefined;

    if (POST_TOOL_EVENTS.includes(input.hookEventName) && options.enqueuePendingInput) {
      for (const message of messages) {
        await options.enqueuePendingInput(formatMailboxMessages([message]), {
          sessionId: options.sessionId,
          traceId: input.traceId,
          turnId: input.turnId,
        });
      }
      return undefined;
    }

    const additionalContext = formatMailboxMessages(messages);
    return {
      ...(input.hookEventName === HookEventName.Stop ? { continue: true } : {}),
      hookSpecificOutput: {
        additionalContext,
        hookEventName: input.hookEventName,
      },
    };
  };

  return [HookEventName.UserPromptSubmit, ...POST_TOOL_EVENTS, HookEventName.Stop].map((event) => ({
    callback,
    descriptor: {
      clientVisible: false,
      commandDisplay: "Session mailbox",
      executionMode: "foreground",
      executionType: "process",
      sourceKind: "internal",
      timeoutMs: 60_000,
    },
    event,
    source: "builtin.sessionMailbox.drain",
  }));
}

function formatMailboxMessages(
  messages: Awaited<ReturnType<SessionMailboxPort["drainUnread"]>>,
): string {
  return messages
    .map((message) =>
      [
        `<session-message source="mailbox" message_id="${escapeAttr(message.messageId)}" from_session="${escapeAttr(message.fromSessionId)}" created_at="${escapeAttr(message.createdAt)}">`,
        "For reference only. Verify against raw source before acting.",
        "",
        message.content,
        "</session-message>",
      ].join("\n"),
    )
    .join("\n\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
