import type { SessionEvent, TurnId } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import type React from "react";
import type {
  DraftAttachment,
  Message,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
  TranscriptPart,
  SubmitValueOptions,
} from "./app-model.js";
import { toPromptInput } from "./app-input.js";
import { upsertQueuedInput } from "./app-queued-inputs.js";
import {
  finalizeStreamProjectedMessages,
  projectedTranscriptHasResponse,
} from "./app-transcript-stream.js";
import { appendSystemErrorMessage } from "./app-transcript-errors.js";
import { formatFileDiffDisplay } from "./app-tool-diff-display.js";
import { buildToolTranscriptProjection } from "./app-tool-transcript.js";
import {
  compactCommandFromText,
  createLocalCompactTimelineMessage,
  failLatestStartedCompactTimeline,
  upsertCompactTimelineMessage,
} from "./app-compact-timeline.js";
import type { TuiOptions, TuiRestoredTranscriptPart, TuiSubmitPromptResult } from "./types.js";

const LOCAL_USER_MESSAGE_ID_PREFIX = "local-user";

let localUserMessageSequence = 0;

export function appendAgentResult(
  current: Message[],
  result: TuiSubmitPromptResult,
  options: { workspaceDirectory?: string } = {},
): Message[] {
  // resume 回放以前只保留 content/role，导致已持久化的 reasoning/tool
  // part 被初始渲染丢掉；这里恢复成 TUI 结构化 parts，继续复用实时流式组件。
  const restored = result.restoredMessages
    ? result.restoredMessages.map((message) =>
        restoreTranscriptMessage(message, options.workspaceDirectory),
      )
    : result.resetSessionProjection
      ? []
      : current;
  const finalized = finalizeStreamProjectedMessages(restored);
  if (!result.restoredMessages && projectedTranscriptHasResponse(finalized, result.response)) {
    return finalized;
  }
  if (result.response.trim().length === 0) {
    // streaming and steering paths can complete with no additional final text;
    // rendering a placeholder makes the transcript show a reply the agent never sent.
    return finalized;
  }
  return [
    ...finalized,
    {
      content: result.response,
      role: "agent",
    },
  ];
}

function restoreTranscriptMessage(
  message: NonNullable<TuiSubmitPromptResult["restoredMessages"]>[number],
  workspaceDirectory: string | undefined,
): Message {
  const parts = (message.parts ?? [])
    .map((part) => restoreTranscriptPart(part, workspaceDirectory))
    .filter((part): part is TranscriptPart => Boolean(part));

  return {
    ...(message.id ? { id: message.id } : {}),
    content: message.content,
    ...(parts.length > 0 ? { parts } : {}),
    role: message.role,
  };
}

function restoreTranscriptPart(
  part: TuiRestoredTranscriptPart,
  workspaceDirectory: string | undefined,
): TranscriptPart | undefined {
  if (part.type === "text") {
    return part.text.trim().length > 0 ? { text: part.text, type: "text" } : undefined;
  }

  if (part.type === "thought") {
    return part.text.trim().length > 0
      ? {
          contentCharCount: part.text.length,
          status: "thought",
          text: part.text,
          type: "thought",
        }
      : undefined;
  }

  const projection = buildToolTranscriptProjection(part.toolName, part.input, workspaceDirectory);
  const resultDisplay =
    part.resultDisplay?.kind === "file_diff"
      ? formatFileDiffDisplay(part.resultDisplay as Record<string, unknown>)
      : undefined;
  return {
    detailLines: projection.detailLines,
    ...(part.error ? { error: part.error } : {}),
    ...(part.output ? { output: part.output } : {}),
    ...(resultDisplay ? { resultDisplay } : {}),
    status: part.status,
    title: projection.title ?? part.title,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    type: "tool",
  };
}

export async function submitDuringActiveTurn(input: {
  activeTurnId?: TurnId;
  applyResult: (result: TuiSubmitPromptResult, preserveTurnState?: boolean) => void;
  applySessionEvent: (event: SessionEvent) => void;
  draftAttachments: DraftAttachment[];
  options: TuiOptions;
  messageInsertIndex: number;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setStatus: (status: string) => void;
  signal?: AbortSignal;
  text: string;
  modelSelection?: ModelSelection;
}): Promise<void> {
  if (!input.options.sendInput) {
    input.setStatus("Agent is still responding.");
    return;
  }
  input.setDraftValue("");
  const compactCommand =
    input.draftAttachments.length === 0 ? compactCommandFromText(input.text) : undefined;
  const localUserMessage = createLocalUserMessage(redactSensitivePromptForTranscript(input.text));
  try {
    input.setStatus("Queueing input...");
    const result = await input.options.sendInput(
      toPromptInput(input.text, input.draftAttachments, input.modelSelection),
      {
        abortSignal: input.signal,
        delivery: "auto",
        expectedTurnId: input.activeTurnId,
        onEvent: input.applySessionEvent,
      },
    );
    if (result.kind === "started_turn" || result.kind === "command_result") {
      if (!compactCommand) {
        input.setMessages((current) =>
          insertLocalUserMessageAt(current, localUserMessage, input.messageInsertIndex),
        );
      }
      input.applyResult(
        compactCommand ? { ...result.result, response: "" } : result.result,
        result.kind === "command_result",
      );
      return;
    }
    if (result.kind !== "queued") {
      input.setDraftValue(input.text);
    } else {
      // 排队输入还没有被 runtime 注入模型上下文，直接追加到 transcript
      // 会和正在流式输出的回复混在一起；先放到输入框上方的队列区。
      input.setQueuedInputs((current) =>
        upsertQueuedInput(current, {
          id: result.pendingInputId,
          text: localUserMessage.content,
        }),
      );
    }
    input.setStatus(
      result.kind === "queued"
        ? result.queueLength > 1
          ? `Input queued (${result.queueLength} pending).`
          : "Input queued."
        : `Input not queued: ${result.reason}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.setLastError(message);
    input.setDraftValue(input.text);
    input.setMessages((current) => appendSystemErrorMessage(current, message));
    input.setStatus(`Input not queued: ${message}.`);
  }
}

export async function submitIdleTurn(input: {
  applyResult: (result: TuiSubmitPromptResult) => void;
  applySessionEvent: (event: SessionEvent) => void;
  draftAttachments: DraftAttachment[];
  options: TuiOptions;
  setBusy: (value: boolean) => void;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setLiveModelText: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: (status: string) => void;
  setStatusDetails: React.Dispatch<React.SetStateAction<string[]>>;
  submitOptions?: SubmitValueOptions;
  text: string;
  modelSelection?: ModelSelection;
  turnRef: React.MutableRefObject<AbortController | undefined>;
}): Promise<void> {
  const promptInput = toPromptInput(input.text, input.draftAttachments, input.modelSelection);
  const compactCommand =
    input.draftAttachments.length === 0 ? compactCommandFromText(input.text) : undefined;
  const abortController = new AbortController();
  input.turnRef.current = abortController;
  input.setDraftValue("");
  input.setDraftAttachments([]);
  input.setBusy(true);
  input.setLastError(undefined);
  input.setStatus("Thinking...");
  input.setStatusDetails([]);
  input.setLiveModelText("");
  if (!input.submitOptions?.preserveSelection) input.setSelection(undefined);
  input.setSlashSelection(undefined);
  if (compactCommand) {
    // `/compact` 是控制命令，TUI 之前把它渲染成 user row；
    // app 侧又有专门的 compaction 横条，导致两端语义不一致。这里直接渲染同一类 timeline row。
    input.setMessages((current) =>
      upsertCompactTimelineMessage(
        current,
        createLocalCompactTimelineMessage({
          command: compactCommand,
          status: "started",
        }),
      ),
    );
  } else {
    input.setMessages((current) => [
      ...current,
      { content: redactSensitivePromptForTranscript(input.text), role: "user" },
    ]);
  }

  try {
    const result = await input.options.submitPrompt(promptInput, {
      abortSignal: abortController.signal,
      onEvent: input.applySessionEvent,
    });
    input.applyResult(compactCommand ? { ...result, response: "" } : result);
  } catch (error) {
    if (abortController.signal.aborted) {
      input.setLastError(undefined);
      input.setStatus(input.submitOptions?.abortStatus ?? "Operation cancelled.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    input.setLastError(message);
    input.setStatus("Turn failed.");
    input.setMessages((current) =>
      compactCommand
        ? failLatestStartedCompactTimeline(current, message)
        : appendSystemErrorMessage(current, message),
    );
  } finally {
    input.setBusy(false);
    if (input.turnRef.current === abortController) {
      input.turnRef.current = undefined;
    }
  }
}

function createLocalUserMessage(content: string): Message & { id: string } {
  localUserMessageSequence += 1;
  return {
    content,
    id: `${LOCAL_USER_MESSAGE_ID_PREFIX}-${localUserMessageSequence}`,
    role: "user",
  };
}

export function redactSensitivePromptForTranscript(text: string): string {
  const trimmed = text.trim();
  const match =
    /^\/login\s+(zai-coding-plan-api-key|bigmodel-coding-plan-api-key)(?:\s+([\s\S]+))?$/u.exec(
      trimmed,
    );
  if (!match?.[2]?.trim()) return text;
  return `/login ${match[1]} <redacted>`;
}

function insertLocalUserMessageAt(
  messages: Message[],
  message: Message & { id: string },
  index: number,
): Message[] {
  const insertionIndex = Math.max(0, Math.min(messages.length, Math.floor(index)));
  return [...messages.slice(0, insertionIndex), message, ...messages.slice(insertionIndex)];
}
