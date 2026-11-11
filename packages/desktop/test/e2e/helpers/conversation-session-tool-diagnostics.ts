import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_MESSAGE_EDIT_BUTTON,
  TID_CHAT_MESSAGE_FORK_BUTTON,
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_CHAT_VIEW,
  TID_V4_SESSION_PANE,
} from "@zcode/shared/test-ids";

export interface ToolCallBlockSnapshot {
  exists: boolean;
  hasEditAction: boolean;
  hasForkAction: boolean;
  status: string | null;
  testId: string;
  text: string;
  toolCallId: string | null;
  toolName: string | null;
}

interface AssistantMessageSnapshot {
  messageId: string | null;
  text: string;
}

interface ChatStateSnapshot {
  activeInputId: string | null;
  queueCount: string | null;
  state: string | null;
}

export interface ToolCallDiagnostics {
  assistantMessages: AssistantMessageSnapshot[];
  assistantHistory: AssistantHistoryStateSnapshot[];
  blocks: ToolCallBlockSnapshot[];
  chatState: ChatStateSnapshot | null;
  matcher: ToolCallMatcher | null;
  matchedBlock: ToolCallBlockSnapshot | null;
  rendererStore: RendererStoreDiagnostics;
}

interface AssistantHistoryStateSnapshot {
  contentExists: boolean;
  contentOpen: string | null;
  contentText: string;
  expanded: boolean;
  hasContent: string | null;
  stateKey: string | null;
  triggerTestId: string;
}

interface RendererStoreDiagnostics {
  activeTaskId: string | null;
  available: boolean;
  messages: RendererStoreMessageSnapshot[];
  reason: string | null;
}

interface RendererStoreMessageSnapshot {
  content: string;
  id: string | null;
  partTypes: string[];
  role: string | null;
  taskId: string;
  toolCalls: RendererStoreToolCallSnapshot[];
  workspaceKey: string;
}

interface RendererStoreToolCallSnapshot {
  error: string | null;
  output: string | null;
  rawErrorDetail: string | null;
  rawErrorMessage: string | null;
  status: string | null;
  toolId: string | null;
  toolName: string | null;
}

export type ToolCallMatcher =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "toolCallId";
      value: string;
    }
  | {
      type: "toolName";
      value: string;
    };

export function expandAssistantHistoriesWithContent(): Promise<void> {
  return browser.execute((historyTriggerPrefix) => {
    const triggers = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${historyTriggerPrefix}-"]`),
    );
    for (const trigger of triggers) {
      const expanded =
        trigger.getAttribute("aria-expanded") === "true" ||
        trigger.getAttribute("data-history-open") === "true";
      if (trigger.getAttribute("data-history-has-content") !== "false" && !expanded) {
        trigger.click();
      }
    }
  }, TID_CHAT_ASSISTANT_HISTORY_TRIGGER);
}

/** 摘要组默认收起时子项不挂载；工具 DOM 访问必须在展开外层过程后再展开内部组。 */
export function expandVisibleSummaryGroups(): Promise<void> {
  return browser.execute(() => {
    const triggers = document.querySelectorAll<HTMLElement>(
      '[data-summary-group-trigger][aria-expanded="false"]',
    );
    for (const trigger of triggers) {
      const rect = trigger.getBoundingClientRect();
      const style = getComputedStyle(trigger);
      if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden") trigger.click();
    }
  });
}

export function getToolCallDiagnostics(
  matcher: ToolCallMatcher | null,
): Promise<ToolCallDiagnostics> {
  return browser.execute(
    (
      toolBlockPrefix,
      editButtonPrefix,
      forkButtonPrefix,
      assistantMessagePrefix,
      chatViewTestId,
      historyTriggerPrefix,
      historyContentPrefix,
      v4PaneTestId,
      expectedMatcher,
    ) => {
      const normalizeText = (value: string) => value.replace(/\u00a0/g, " ").trim();
      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${toolBlockPrefix}-"]`),
      ).map((block) => ({
        exists: true,
        hasEditAction: Boolean(
          // V4 消息操作已换前缀；负向断言必须检查现行入口，不能仅检查退役节点。
          block.querySelector(`[data-testid^="${editButtonPrefix}-"], [data-testid^="v4-edit-"]`),
        ),
        hasForkAction: Boolean(
          block.querySelector(`[data-testid^="${forkButtonPrefix}-"], [data-testid^="v4-fork-"]`),
        ),
        status: block.getAttribute("data-status"),
        testId: block.getAttribute("data-testid") ?? "",
        text: normalizeText(block.innerText),
        toolCallId: block.getAttribute("data-tool-call-id"),
        toolName: block.getAttribute("data-tool-name"),
      }));

      const matchedBlock =
        expectedMatcher === null
          ? null
          : (blocks.findLast((block) => {
              if (expectedMatcher.type === "text") {
                return block.text.includes(expectedMatcher.value);
              }
              if (expectedMatcher.type === "toolCallId") {
                return (
                  block.toolCallId === expectedMatcher.value ||
                  block.toolCallId?.startsWith(`${expectedMatcher.value}:`)
                );
              }
              return block.toolName === expectedMatcher.value;
            }) ?? null);

      const assistantMessages = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${assistantMessagePrefix}-"]`),
      ).map((message) => ({
        messageId: message.getAttribute("data-message-id"),
        text: normalizeText(message.innerText),
      }));
      const assistantHistory = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${historyTriggerPrefix}-"]`),
      ).map((trigger) => {
        const triggerTestId = trigger.getAttribute("data-testid") ?? "";
        // Bug 根因：V4 history 只把 unit.key 编入 test id，不再写
        // data-history-state-key；旧诊断因此找不到已存在的折叠内容，误导 E2E 归因。
        const stateKey =
          trigger.getAttribute("data-history-state-key") ??
          (triggerTestId.startsWith(`${historyTriggerPrefix}-`)
            ? triggerTestId.slice(historyTriggerPrefix.length + 1)
            : null);
        const content =
          stateKey !== null
            ? (Array.from(
                document.querySelectorAll<HTMLElement>(`[data-testid^="${historyContentPrefix}-"]`),
              ).find(
                (candidate) =>
                  candidate.getAttribute("data-testid") === `${historyContentPrefix}-${stateKey}`,
              ) ?? null)
            : null;
        return {
          contentExists: Boolean(content),
          contentOpen: content?.getAttribute("data-history-open") ?? null,
          contentText: normalizeText(content?.innerText ?? ""),
          expanded: trigger.getAttribute("aria-expanded") === "true",
          hasContent: trigger.getAttribute("data-history-has-content"),
          stateKey,
          triggerTestId,
        };
      });

      const chatView = document.querySelector<HTMLElement>(`[data-testid="${chatViewTestId}"]`);
      const chatState = chatView
        ? {
            activeInputId: chatView.getAttribute("data-active-input-id"),
            queueCount: chatView.getAttribute("data-queue-count"),
            state: chatView.getAttribute("data-chat-state"),
          }
        : null;
      const v4SessionId = document
        // Bug 根因：V4 pane test id 始终带 paneId 后缀；精确匹配基础 id 会让
        // hooks/tool 失败诊断把真实 active task 误报成 null。
        .querySelector<HTMLElement>(`[data-testid^="${v4PaneTestId}-"]`)
        ?.getAttribute("data-session-id");
      // 修复原因：V4 不再渲染 chat-view；诊断若只从旧 root 取 taskId，
      // 会把 renderer store 误报为空，掩盖真正的 tool 投影问题。
      const activeTaskId =
        chatView?.getAttribute("data-task-id") ||
        (v4SessionId && v4SessionId !== "draft" ? v4SessionId : null);
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            workspaces?: Record<
              string,
              {
                taskMessagesByTaskId?: Record<string, RendererStoreRawMessage[]>;
              }
            >;
          };
        };
      };
      const storeApi = e2eWindow.__zcodeSessionStoreE2E;
      const rendererStore = (() => {
        if (!storeApi) {
          return {
            activeTaskId,
            available: false,
            messages: [],
            reason: "store-bridge-missing",
          };
        }

        const state = storeApi.getState();
        const readRecord = (value: unknown): Record<string, unknown> | null =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        const readString = (value: unknown): string | null =>
          typeof value === "string" ? value : null;
        const readRawToolError = (toolCall: RendererStoreRawToolCall) => {
          const raw = readRecord(toolCall.raw);
          const result = readRecord(raw?.result);
          const error = readRecord(raw?.error) ?? readRecord(result?.error);
          return {
            rawErrorDetail: readString(error?.detail),
            rawErrorMessage: readString(error?.message),
          };
        };
        const messages = Object.entries(state.workspaces ?? {}).flatMap(
          ([workspaceKey, workspace]) =>
            Object.entries(workspace.taskMessagesByTaskId ?? {}).flatMap(([taskId, taskMessages]) =>
              taskMessages.map((message) => ({
                content: message.content ?? "",
                id: message.id ?? null,
                partTypes: (message.parts ?? []).map((part) => part.type ?? ""),
                role: message.role ?? null,
                taskId,
                toolCalls: (message.toolCalls ?? []).map((toolCall) => {
                  const rawError = readRawToolError(toolCall);
                  return {
                    error: toolCall.error ?? null,
                    output: toolCall.output ?? null,
                    rawErrorDetail: rawError.rawErrorDetail,
                    rawErrorMessage: rawError.rawErrorMessage,
                    status: toolCall.status ?? null,
                    toolId: toolCall.toolId ?? null,
                    toolName: toolCall.toolName ?? null,
                  };
                }),
                workspaceKey,
              })),
            ),
        );
        return {
          activeTaskId,
          available: true,
          messages: activeTaskId
            ? messages.filter((message) => message.taskId === activeTaskId)
            : messages,
          reason: null,
        };
      })();

      return {
        assistantMessages,
        assistantHistory,
        blocks,
        chatState,
        matcher: expectedMatcher,
        matchedBlock,
        rendererStore,
      };
    },
    TID_CHAT_TOOL_CALL_BLOCK,
    TID_CHAT_MESSAGE_EDIT_BUTTON,
    TID_CHAT_MESSAGE_FORK_BUTTON,
    TID_CHAT_ASSISTANT_MESSAGE,
    TID_CHAT_VIEW,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
    TID_V4_SESSION_PANE,
    matcher,
  );
}

interface RendererStoreRawMessage {
  content?: string;
  id?: string;
  parts?: Array<{ type?: string }>;
  role?: string;
  toolCalls?: RendererStoreRawToolCall[];
}

interface RendererStoreRawToolCall {
  error?: string | null;
  output?: string | null;
  raw?: unknown;
  status?: string;
  toolId?: string;
  toolName?: string;
}
