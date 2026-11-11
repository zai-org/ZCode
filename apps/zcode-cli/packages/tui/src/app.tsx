import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppView } from "./app-view.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import { selectionCopyStatus, type SelectionCopyResult } from "./app-copy.js";
import { useClipboardImagePaste } from "./app-clipboard-image.js";
import { useFileMentionController } from "./app-file-mentions.js";
import { useTuiKeyboardControls } from "./app-keyboard.js";
import { useTuiModeSwitcher } from "./app-mode.js";
import { createTuiPermissionRequester } from "./app-permission.js";
import { appendAgentResult } from "./app-submit.js";
import { useSubmitValue } from "./app-submit-controller.js";
import { filterSlashCommands, reconcileSlashSelection } from "./app-input.js";
import { useEffortCommandController } from "./app-effort-command.js";
import { useInputHistory } from "./app-input-history.js";
import { useModeCommandController } from "./app-mode-command.js";
import { useModelCommandController } from "./app-model-command.js";
import { useSidebarController } from "./app-sidebar-layout.js";
import { createSelectionState } from "./app-selection-state.js";
import { resolveComposerSubmittedText } from "./app-submit-resolver.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  DraftAttachment,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import { useTuiThemeSync } from "./app-theme-sync.js";
import { useSessionEventApplier } from "./app-session-event-handler.js";
import { useTuiWorkflowRuns } from "./app-workflow-controller.js";
import { useTuiApplyResult } from "./app-result.js";
import { useSubagents } from "./app-subagents.js";
import type { TuiOptions } from "./types.js";

type TuiAppProps = {
  copySelection: () => Promise<SelectionCopyResult>;
  hasCopyableSelection: () => boolean;
  options: TuiOptions;
  onExit: (code: number) => void;
};

export function TuiApp({
  copySelection,
  hasCopyableSelection,
  onExit,
  options,
}: TuiAppProps): React.ReactElement {
  // Startup sentinels are diagnostics, not user-visible transcript messages.
  const initialResult = options.initialResult;
  const initialLoginRequired = initialResult?.loginRequired ?? options.loginRequired ?? false;
  const initialLocale = options.locale ?? "en-US";
  const initialCopy = getZCodeCopy(initialLocale).tui;
  useTuiThemeSync(options);
  const [messages, setMessages] = useState<Message[]>(() =>
    initialResult
      ? appendAgentResult([], initialResult, { workspaceDirectory: options.workspaceDirectory })
      : [],
  );
  const [draft, setDraftState] = useState("");
  const [, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(initialResult?.mode ?? options.initialMode ?? "build");
  const [model, setModel] = useState(initialResult?.model ?? options.initialModel ?? "unknown");
  const [thoughtLevel, setThoughtLevel] = useState(
    initialResult?.thoughtLevel ?? options.initialThoughtLevel ?? "",
  );
  const [locale, setLocale] = useState(initialLocale);
  const [lastEvent, setLastEvent] = useState("idle");
  const [lastError, setLastError] = useState<string | undefined>();
  const copy = useMemo(() => getZCodeCopy(locale), [locale]);
  const [loginRequired, setLoginRequired] = useState(initialLoginRequired);
  const [status, setStatus] = useState(
    initialResult?.selection?.prompt ??
      (initialLoginRequired ? initialCopy.loginRequired.status : initialCopy.status.ready),
  );
  const [statusDetails, setStatusDetails] = useState<string[]>([]);
  const [traceId, setTraceId] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<TurnId | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage>({});
  const [cacheStats, setCacheStats] = useState<CacheStats | undefined>();
  const [usage, setUsage] = useState<ModelUsageSummary | undefined>();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFileStat[]>([]);
  const [liveModelText, setLiveModelText] = useState("");
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  const [selection, setSelection] = useState<SelectionState | undefined>(() =>
    createSelectionState(initialResult?.selection),
  );
  const [slashSelection, setSlashSelection] = useState<SlashSelectionState | undefined>();
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [inputCursorToEndVersion, setInputCursorToEndVersion] = useState(0);
  // dwf 运行态镜像：共享 reducer 逐事件维护 + 冷启动一次性补种，无第二时钟。
  const workflowRuns = useTuiWorkflowRuns({ copy: copy.tui, options, setMessages });
  const sidebar = useSidebarController();
  const subagents = useSubagents(options);

  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const draftRef = useRef("");
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const inputEditorRef = useRef<PromptInputEditor | null>(null);
  const inputHistoryIndexRef = useRef(0);
  const inputHistoryDraftAttachmentsRef = useRef<DraftAttachment[] | undefined>(undefined);
  const inputHistoryDraftRef = useRef<string | undefined>(undefined);
  const nextAttachmentIdRef = useRef(1);
  const assistantMessageIdsByToolCallIdRef = useRef(new Map<string, string>());
  const modifiedFileToolCallIdsRef = useRef(new Set<string>());
  const toolNamesByIdRef = useRef(new Map<string, string>());

  const slashCommands = options.slashCommands ?? [];
  const [effortOptions, setEffortOptions] = useState<NonNullable<TuiOptions["effortOptions"]>>(
    () => initialResult?.effortOptions ?? options.effortOptions ?? [],
  );
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const effortCommand = useEffortCommandController(draft, effortOptions);
  const modelCommand = useModelCommandController(draft, options);
  const modeCommand = useModeCommandController(draft);

  const setDraftAttachments = useCallback((action: React.SetStateAction<DraftAttachment[]>) => {
    const nextAttachments =
      typeof action === "function" ? action(draftAttachmentsRef.current) : action;
    draftAttachmentsRef.current = nextAttachments;
    setDraftAttachmentsState(nextAttachments);
  }, []);

  const setDraftValue = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraftState(value);
      setDraftAttachments((current) =>
        current.filter((attachment) => value.includes(attachment.placeholder)),
      );
      inputHistoryIndexRef.current = 0;
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      const nextModelSelection = modelCommand.reconcileDraft(value);
      const nextEffortSelection = nextModelSelection
        ? undefined
        : effortCommand.reconcileDraft(value);
      const nextModeSelection =
        nextModelSelection || nextEffortSelection ? undefined : modeCommand.reconcileDraft(value);
      if (nextModelSelection) {
        effortCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextEffortSelection) {
        modelCommand.setSelection(undefined);
        modeCommand.setSelection(undefined);
      } else if (nextModeSelection) {
        effortCommand.setSelection(undefined);
        modelCommand.setSelection(undefined);
      }
      setSlashSelection(
        nextModelSelection || nextEffortSelection || nextModeSelection
          ? undefined
          : reconcileSlashSelection(value, slashCommands),
      );
    },
    [effortCommand, modeCommand, modelCommand, setDraftAttachments, slashCommands],
  );

  const applyResult = useTuiApplyResult({
    fallback: { locale, loginRequired, mode, model },
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setEffortOptions,
    setLastEvent,
    setLiveModelText,
    setLocale,
    setLoginRequired,
    setMessages,
    setMode,
    setModel,
    setModelOptions: modelCommand.setModelOptions,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setSelection,
    setStatus,
    setThoughtLevel,
    setTodos,
    setTraceId,
    setUsage,
    workspaceDirectory: options.workspaceDirectory,
  });

  const applySessionEvent = useSessionEventApplier({
    subscribeSessionEvents: options.subscribeSessionEvents,
    observeSessionEvent: subagents.onEvent,
    copy: copy.tui,
    getMainSessionId: options.getMainSessionId,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setLastError,
    setLastEvent,
    setLiveModelText,
    setMessages,
    setModel,
    setThoughtLevel,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setStatus,
    setTodos,
    setUsage,
    setWorkflowMirror: workflowRuns.setMirror,
    assistantMessageIdsByToolCallId: assistantMessageIdsByToolCallIdRef.current,
    modifiedFileToolCallIds: modifiedFileToolCallIdsRef.current,
    toolNamesById: toolNamesByIdRef.current,
    workspaceDirectory: options.workspaceDirectory,
  });

  const requestPermission = useMemo(
    () => createTuiPermissionRequester({ setApprovalQueue, setStatus }),
    [],
  );
  const registerPermissionRequester = options.registerPermissionRequester;
  // 挂载期间审批入口一直有效：主会话回合之外的询问（后台会话、通知驱动的回合）也进同一队列。
  useEffect(
    () => registerPermissionRequester?.(requestPermission),
    [registerPermissionRequester, requestPermission],
  );

  const resolveSubmittedText = useCallback(
    (submittedValue: string) => {
      const modelOption = modelCommand.selectedOption(submittedValue);
      const effortOption = modelOption ? undefined : effortCommand.selectedOption(submittedValue);
      return resolveComposerSubmittedText({
        effortOption,
        modeOption:
          modelOption || effortOption ? undefined : modeCommand.selectedOption(submittedValue),
        modelOption,
        slashCommands: filteredSlashCommands,
        slashSelection,
        submittedValue,
      });
    },
    [effortCommand, filteredSlashCommands, modeCommand, modelCommand, slashSelection],
  );

  const submitValue = useSubmitValue({
    activeTurnId,
    applyResult,
    applySessionEvent,
    busy,
    draftAttachmentsRef,
    emptyPromptStatus: copy.tui.input.typePrompt,
    messageInsertIndex: messages.length,
    options,
    resolveSubmittedText,
    resolveSubmittedModel: (value) => modelCommand.selectedOption(value)?.ref,
    setBusy,
    setDraftAttachments,
    setDraftValue,
    setLastError,
    setLiveModelText,
    setMessages,
    setQueuedInputs,
    setSelection,
    setSlashSelection,
    setStatus,
    setStatusDetails,
    turnRef: abortControllerRef,
  });

  const pasteClipboardImage = useClipboardImagePaste({
    abortControllerRef,
    busy,
    getDraftValue: () => draftRef.current,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  });

  const { recallNextInput, recallPreviousInput } = useInputHistory({
    copy: copy.tui,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftState,
    setDraftValue,
    setInputCursorToEndVersion,
    setSlashSelection,
    setStatus,
    setStatusDetails,
  });

  const fileMentions = useFileMentionController({
    busy,
    draft,
    editorRef: inputEditorRef,
    listWorkspacePathSuggestions: options.listWorkspacePathSuggestions,
    nextAttachmentIdRef,
    setDraftAttachments,
    setDraftValue,
    setSlashSelection,
    setStatus,
  });

  const copyCurrentSelection = useCallback((): boolean => {
    if (!hasCopyableSelection()) return false;
    void copySelection().then((result) => {
      const copyStatus = selectionCopyStatus(result, copy.tui.copy);
      if (copyStatus.status) setStatus(copyStatus.status);
      if (copyStatus.details) setStatusDetails(copyStatus.details);
    });
    return true;
  }, [copy, copySelection, hasCopyableSelection]);
  const switchMode = useTuiModeSwitcher({
    mode,
    setMode,
    setModeHandler: options.setMode,
    setStatus,
  });

  useTuiKeyboardControls({
    readOnlyView: subagents.selected ? { back: subagents.back } : undefined,
    abortControllerRef,
    approvalQueue,
    busy,
    copyCurrentSelection,
    effortSelection: effortCommand.selection,
    filteredEffortOptions: effortCommand.filteredOptions,
    filteredSlashCommands,
    filteredModeOptions: modeCommand.filteredOptions,
    filteredModelOptions: modelCommand.filteredOptions,
    handleFileMentionKey: fileMentions.handleKey,
    onExit,
    pasteClipboardImage,
    recallNextInput,
    recallPreviousInput,
    draftValue: draft,
    inputHistoryActive: inputHistoryDraftRef.current !== undefined,
    messages,
    modelSelection: modelCommand.selection,
    modeSelection: modeCommand.selection,
    selection,
    setApprovalQueue,
    setDraftAttachments,
    setDraftValue,
    setEffortSelection: effortCommand.setSelection,
    setModelSelection: modelCommand.setSelection,
    setModeSelection: modeCommand.setSelection,
    setSelection,
    setSlashSelection,
    setStatus,
    slashSelection,
    submitValue,
    switchMode,
    workflowExpansion: workflowRuns.expansion,
    toggleSidebar: sidebar.toggleSidebar,
    toggleSidebarSection: sidebar.toggleSidebarSection,
  });

  return React.createElement(AppView, {
    subagents,
    toggleSidebar: sidebar.toggleSidebar,
    activeTurnId,
    approvalQueue,
    busy,
    cacheStats,
    contextUsage,
    copy: copy.tui,
    copyCurrentSelection,
    draft,
    editorRef: inputEditorRef,
    inputCursorToEndVersion,
    lastError,
    lastEvent,
    loginRequired,
    liveModelText,
    mode,
    model,
    messages,
    modifiedFiles,
    networkRequests,
    options,
    queuedInputs,
    selection,
    fileMention: fileMentions.state,
    setDraftValue,
    sidebarLayout: sidebar.layout,
    sidebarSections: sidebar.sections,
    effortOptions: effortCommand.filteredOptions,
    effortSelection: effortCommand.selection,
    modelOptions: modelCommand.filteredOptions,
    modelSelection: modelCommand.selection,
    modeOptions: modeCommand.filteredOptions,
    modeSelection: modeCommand.selection,
    slashCommands: filteredSlashCommands,
    slashSelection,
    status,
    statusDetails,
    submitValue,
    thoughtLevel,
    todos,
    toggleSidebarSection: sidebar.toggleSidebarSection,
    traceId,
    terminalWidth: sidebar.terminalWidth,
    usage,
    workflowCardsByToolCallId: workflowRuns.cardsByToolCallId,
    expandedWorkflowRunIds: workflowRuns.expandedRunIds,
  });
}
