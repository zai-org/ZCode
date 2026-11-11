import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import React from "react";
import { ApprovalArea } from "./app-approval-panel.js";
import {
  actionPanelContentWidthForTerminal,
  AppShell,
  LoginRequiredPanel,
  SlashSuggestionPanel,
} from "./app-components.js";
import { SelectionPanel } from "./app-selection-panel.js";
import { ContentPane } from "./app-transcript-components.js";
import { FileMentionPanel } from "./app-file-mention-panel.js";
import type { FileMentionState } from "./app-file-mentions.js";
import { EffortSuggestionPanel } from "./app-effort-suggestion-panel.js";
import { InputPane, type PromptInputEditor } from "./app-input-pane.js";
import { InputActiveStatus } from "./app-input-status.js";
import { QueuedInputPanel } from "./app-queued-inputs.js";
import { ModeSuggestionPanel } from "./app-mode-suggestion-panel.js";
import { ModelSuggestionPanel } from "./app-model-suggestion-panel.js";
import { useMcpSidebarStatus } from "./app-mcp-status.js";
import { Sidebar } from "./app-sidebar.js";
import {
  type SidebarLayout,
  type SidebarSectionId,
  type SidebarSectionExpansion,
} from "./app-sidebar-layout.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  EffortCommandSelectionState,
  Message,
  ModifiedFileStat,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiOptions } from "./types.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";
import type { SubagentItem, SubagentsController } from "./app-subagents.js";
import { SubagentView } from "./app-subagent-view.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function AppView(props: {
  subagents?: SubagentsController;
  toggleSidebar?: () => boolean;
  activeTurnId?: TurnId;
  approvalQueue: ApprovalPrompt[];
  busy: boolean;
  cacheStats?: CacheStats;
  contextUsage: ContextUsage;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  copyCurrentSelection: () => boolean;
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  effortOptions: readonly TuiEffortOption[];
  effortSelection?: EffortCommandSelectionState;
  fileMention?: FileMentionState;
  inputCursorToEndVersion: number;
  lastError?: string;
  lastEvent: string;
  loginRequired: boolean;
  liveModelText: string;
  mode: string;
  modeOptions: readonly TuiModeOption[];
  modeSelection?: ModeCommandSelectionState;
  model: string;
  modifiedFiles: ModifiedFileStat[];
  modelOptions: readonly NonNullable<TuiOptions["modelOptions"]>[number][];
  modelSelection?: ModelCommandSelectionState;
  messages: Message[];
  networkRequests: NetworkRequest[];
  options: TuiOptions;
  queuedInputs?: QueuedInput[];
  selection?: SelectionState;
  setDraftValue: (value: string) => void;
  sidebarLayout: SidebarLayout;
  sidebarSections: SidebarSectionExpansion;
  slashCommands: readonly NonNullable<TuiOptions["slashCommands"]>[number][];
  slashSelection?: SlashSelectionState;
  status: string;
  statusDetails: string[];
  submitValue: (value: string) => void;
  thoughtLevel: string;
  todos: TodoItem[];
  toggleSidebarSection?: (section: SidebarSectionId) => boolean;
  traceId?: string;
  terminalWidth: number;
  usage?: ModelUsageSummary;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
  expandedWorkflowRunIds?: ReadonlySet<string>;
}): React.ReactElement {
  const readOnly = Boolean(props.subagents?.selected);
  const handleShellMouseUp = React.useCallback(() => {
    props.copyCurrentSelection();
    if (!readOnly) props.editorRef.current?.focus();
  }, [props.copyCurrentSelection, props.editorRef, readOnly]);
  const actionPanelContentWidth = actionPanelContentWidthForTerminal(
    props.terminalWidth,
    props.sidebarLayout.reservedWidth,
  );
  const mcpStatus = useMcpSidebarStatus(
    props.loginRequired ? undefined : props.options.listMcpServers,
  );
  const transcriptMessages = props.liveModelText
    ? [
        ...props.messages,
        {
          content: props.liveModelText,
          role: "agent" as const,
          streaming: true,
        },
      ]
    : props.messages;

  // 旧的测试入口和嵌入式调用不会传 queuedInputs；默认空队列，避免队列面板在无数据时打断焦点交互。
  const queuedInputs = props.queuedInputs ?? [];
  const composerSelection = props.selection?.placement === "composer" ? props.selection : undefined;
  const actionSelection = props.selection && !composerSelection ? props.selection : undefined;
  const sidebar = props.sidebarLayout.visible
    ? h(Sidebar, {
        subagents: props.subagents,
        onOpenSubagent: (item: SubagentItem) => {
          props.subagents?.open(item);
          if (props.sidebarLayout.overlay) props.toggleSidebar?.();
        },
        activeTurnId: props.activeTurnId,
        busy: props.busy,
        cacheStats: props.cacheStats,
        contextUsage: props.contextUsage,
        draft: props.draft,
        lastError: props.lastError,
        lastEvent: props.lastEvent,
        messageCount: transcriptMessages.length,
        mcpStatus,
        mode: props.mode,
        model: props.model,
        modifiedFiles: props.modifiedFiles,
        networkRequests: props.networkRequests,
        onToggleSection: props.toggleSidebarSection,
        sectionExpansion: props.sidebarSections,
        status: props.status,
        statusDetails: props.statusDetails,
        thoughtLevel: props.thoughtLevel,
        todos: props.todos,
        traceId: props.traceId,
        usage: props.usage,
        developerMode: props.options.developerMode,
        version: props.options.version,
        workspaceDirectory: props.options.workspaceDirectory,
        workspaceGitBranch: props.options.workspaceGitBranch,
        copy: props.copy,
      })
    : null;

  return h(
    AppShell,
    { onMouseUp: handleShellMouseUp, sidebar, sidebarLayout: props.sidebarLayout },
    readOnly && props.subagents
      ? h(SubagentView, {
          controller: props.subagents,
          copy: props.copy,
          contentWidth: actionPanelContentWidth,
          pendingMain: props.approvalQueue.length > 0 || Boolean(props.selection),
        })
      : null,
    h(
      "box",
      {
        id: "main-conversation-view",
        visible: !readOnly,
        style: { flexDirection: "column", flexGrow: 1, minHeight: 0 },
      },
      h(ContentPane, {
        id: "main-transcript",
        animateEmptyLogo: !props.options.noColor,
        copy: props.copy,
        focused: false,
        messages: transcriptMessages,
        terminalWidth: actionPanelContentWidth,
        workflowCardsByToolCallId: props.workflowCardsByToolCallId,
        expandedWorkflowRunIds: props.expandedWorkflowRunIds,
      }),
      props.approvalQueue[0]
        ? h(ApprovalArea, {
            approval: props.approvalQueue[0],
            contentWidth: actionPanelContentWidth,
            copy: props.copy,
            mainSessionId: props.options.getMainSessionId?.(),
          })
        : actionSelection
          ? h(SelectionPanel, {
              contentWidth: actionPanelContentWidth,
              copy: props.copy,
              selection: actionSelection,
            })
          : h(ComposerInputArea, {
              focused: !readOnly,
              busy: props.busy,
              contentWidth: actionPanelContentWidth,
              contextUsage: props.contextUsage,
              copy: props.copy,
              draft: props.draft,
              editorRef: props.editorRef,
              effortOptions: props.effortOptions,
              effortSelection: props.effortSelection,
              fileMention: props.fileMention,
              inputCursorToEndVersion: props.inputCursorToEndVersion,
              loginRequired: props.loginRequired,
              mode: props.mode,
              modeOptions: props.modeOptions,
              modeSelection: props.modeSelection,
              model: props.model,
              modelOptions: props.modelOptions,
              modelSelection: props.modelSelection,
              queuedInputs,
              selection: composerSelection,
              setDraftValue: readOnly ? () => {} : props.setDraftValue,
              slashCommands: props.slashCommands,
              slashSelection: props.slashSelection,
              submitValue: readOnly ? () => {} : props.submitValue,
              thoughtLevel: props.thoughtLevel,
            }),
    ),
  );
}

export function ComposerInputArea(props: {
  focused?: boolean;
  busy: boolean;
  contentWidth: number;
  contextUsage: ContextUsage;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  effortOptions: readonly TuiEffortOption[];
  effortSelection?: EffortCommandSelectionState;
  fileMention?: FileMentionState;
  inputCursorToEndVersion: number;
  loginRequired: boolean;
  mode: string;
  modeOptions: readonly TuiModeOption[];
  modeSelection?: ModeCommandSelectionState;
  model: string;
  modelOptions: readonly NonNullable<TuiOptions["modelOptions"]>[number][];
  modelSelection?: ModelCommandSelectionState;
  queuedInputs: QueuedInput[];
  selection?: SelectionState;
  setDraftValue: (value: string) => void;
  slashCommands: readonly NonNullable<TuiOptions["slashCommands"]>[number][];
  slashSelection?: SlashSelectionState;
  submitValue: (value: string) => void;
  thoughtLevel: string;
}): React.ReactElement {
  return h(
    React.Fragment,
    null,
    props.loginRequired ? h(LoginRequiredPanel, { copy: props.copy }) : null,
    props.fileMention
      ? h(FileMentionPanel, {
          contentWidth: props.contentWidth,
          copy: props.copy,
          state: props.fileMention,
        })
      : null,
    props.selection
      ? h(SelectionPanel, {
          contentWidth: props.contentWidth,
          copy: props.copy,
          selection: props.selection,
        })
      : null,
    props.modelSelection
      ? h(ModelSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentModel: props.model,
          models: props.modelOptions,
          selectedIndex: props.modelSelection.selectedIndex,
        })
      : null,
    props.effortSelection
      ? h(EffortSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentEffort: props.thoughtLevel,
          efforts: props.effortOptions,
          selectedIndex: props.effortSelection.selectedIndex,
        })
      : null,
    props.modeSelection
      ? h(ModeSuggestionPanel, {
          contentWidth: props.contentWidth,
          currentMode: props.mode,
          modes: props.modeOptions,
          selectedIndex: props.modeSelection.selectedIndex,
        })
      : null,
    props.slashSelection
      ? h(SlashSuggestionPanel, {
          contentWidth: props.contentWidth,
          commands: props.slashCommands,
          copy: props.copy,
          selectedIndex: props.slashSelection.selectedIndex,
        })
      : null,
    h(QueuedInputPanel, {
      contentWidth: props.contentWidth,
      copy: props.copy,
      inputs: props.queuedInputs,
    }),
    h(InputPane, {
      busy: props.busy,
      contentWidth: props.contentWidth,
      copy: props.copy,
      editorRef: props.editorRef,
      focused: props.focused ?? true,
      mode: props.mode,
      model: props.model,
      onInput: props.setDraftValue,
      onSubmit: props.submitValue,
      resetCursorToEndVersion: props.inputCursorToEndVersion,
      thoughtLevel: props.thoughtLevel,
      value: props.draft,
    }),
    h(InputActiveStatus, {
      active: props.busy,
      contentWidth: props.contentWidth,
      contextUsage: props.contextUsage,
      copy: props.copy,
    }),
  );
}
