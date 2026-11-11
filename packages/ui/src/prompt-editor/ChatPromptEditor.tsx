/* oxlint-disable eslint(max-lines) -- 输入壳同时收口 Lexical 同步、拖拽和工具栏插槽，暂不拆组件。 */
// 输入展示壳：纯 props 组件、无 store/协议依赖；mention 面板通过 enableMentionPanel 透传。
import type {
  KeyboardEventHandler,
  DragEventHandler,
  FormEventHandler,
  MutableRefObject,
  ReactNode,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TID_CHAT_SEND_BUTTON } from "@zcode/shared/test-ids";
import { ArrowUpIcon, Hand, XIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import {
  LexicalChatInput,
  type ChatComposerPasteEvent,
  type LexicalChatInputHandle,
  type UserInputPresence,
} from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import {
  hasWorkspaceFileDragPayload,
  readWorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { ChatPromptActionMenu } from "@/prompt-editor/ChatPromptActionMenu.js";
import { useComposerToolbarFit } from "@/prompt-editor/useComposerToolbarFit.js";

function runAfterFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  callback();
}

export function ChatPromptEditor({
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  initialValue,
  syncInitialValueOnMount = true,
  placeholder,
  disabled = false,
  disabledReason,
  submitting = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  submitLabel,
  cancelLabel,
  showMentionButton = false,
  showSlashButton = false,
  enableWorkspaceFileDrop = false,
  enableExternalFileDrop = false,
  isDraggingOver = false,
  dragAttachmentHint,
  topContent,
  inputLeadingContent,
  leadingActions,
  attachmentAction,
  betweenCancelAndSubmitAction,
  submitControl,
  inputTestId,
  submitTestId,
  cancelTestId,
  inputApiRef,
  onModeSwitchContainerChange,
  triggerPanelContainer,
  promptHistory,
  className,
  shellClassName,
  avoidIosInputFocusZoom = false,
  compactPlaceholder = false,
  layout = "stacked",
  onChange,
  onUserInputClear,
  onUserInputPresenceChange,
  onUserInputStart,
  onSubmit,
  onModifiedSubmit,
  onCancel,
  onFocus,
  onWhiteboardMentionSelected,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  excludedSlashCommandNames,
  appSlashCommands,
  extraPlugins,
  enableMentionPanel,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** 仅供 Composer Skill catalog；可为草稿的 prewarm Session。 */
  skillCatalogSessionId?: string | null;
  initialValue?: string;
  syncInitialValueOnMount?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  submitLabel: string;
  cancelLabel?: string;
  showMentionButton?: boolean;
  showSlashButton?: boolean;
  enableWorkspaceFileDrop?: boolean;
  enableExternalFileDrop?: boolean;
  isDraggingOver?: boolean;
  dragAttachmentHint?: string;
  topContent?: ReactNode;
  /** 与输入正文同一行的前置内容；Highspeed 使用紧凑 Fast 标签。 */
  inputLeadingContent?: ReactNode;
  leadingActions?: ReactNode;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  /** 行内编辑专用：固定插在取消与主提交之间的第二动作。 */
  betweenCancelAndSubmitAction?: ReactNode;
  submitControl?: ReactNode;
  inputTestId?: string;
  submitTestId?: string;
  cancelTestId?: string;
  inputApiRef?: MutableRefObject<LexicalChatInputHandle | null>;
  onModeSwitchContainerChange?: (container: HTMLSpanElement | null) => void;
  triggerPanelContainer?: HTMLElement | null;
  promptHistory?: readonly string[];
  className?: string;
  shellClassName?: string;
  avoidIosInputFocusZoom?: boolean;
  compactPlaceholder?: boolean;
  /**
   * stacked：输入区在上、工具栏在下；inline：[+] 输入区 [控件][发送] 排成一行，控件只显示图标
   * （Side Pane 完整视图浮窗，docs/ui/side-pane-full-view.md）。两种布局共用同一棵 DOM 树，
   * 切换时编辑器不重新挂载。
   */
  layout?: "stacked" | "inline";
  onChange?: (value: string) => void;
  onUserInputClear?: () => void;
  onUserInputPresenceChange?: (presence: UserInputPresence) => void;
  onUserInputStart?: () => void;
  // 适配：返回 false 表示业务层拒绝/延迟本次提交，Lexical 不自行 reset（草稿保留）。
  onSubmit: (value: string) => boolean | void;
  onModifiedSubmit?: (value: string) => boolean | void;
  onCancel?: () => void;
  onFocus?: () => void;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  excludedSlashCommandNames?: readonly string[];
  /** App 层本地斜杠命令（透传 LexicalChatInput）。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** mention 面板开关（透传 LexicalChatInput）。 */
  enableMentionPanel?: boolean;
  /** 额外挂进编辑器的 Lexical 插件（透传 LexicalChatInput）。 */
  extraPlugins?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const isInline = layout === "inline";
  const toolbarRef = useComposerToolbarFit({ iconOnly: isInline });
  const internalInputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const resolvedInputApiRef = inputApiRef ?? internalInputApiRef;
  const [internalTriggerPanelContainer, setInternalTriggerPanelContainer] =
    useState<HTMLDivElement | null>(null);
  const resolvedTriggerPanelContainer = triggerPanelContainer ?? internalTriggerPanelContainer;
  const latestTextRef = useRef(initialValue ?? "");
  const hasSyncedInitialValueRef = useRef(false);
  const {
    externalFileDragging,
    internalDragging,
    setExternalFileDragging,
    setInternalDragging,
    setWorkspaceFileDragging,
    workspaceFileDragging,
  } = usePromptEditorDragState({
    enableExternalFileDrop,
    enableWorkspaceFileDrop,
  });
  const actionMenuTitle = intl.formatMessage({
    id: "chat.composer.actionMenu",
  });
  const workspaceFileDragHint = intl.formatMessage({
    id: "chat.composer.workspaceFileDragHint",
  });
  const hasActionMenu = Boolean(attachmentAction) || showMentionButton || showSlashButton;

  useEffect(() => {
    if (!syncInitialValueOnMount) {
      return;
    }
    if (initialValue === undefined) {
      return;
    }
    if (hasSyncedInitialValueRef.current) {
      return;
    }
    hasSyncedInitialValueRef.current = true;

    latestTextRef.current = initialValue;
    runAfterFrame(() => {
      // task 草稿恢复时外层 input state 已经更新，但 Lexical 内部文本不会自动跟随 props。
      // 同时普通打字也会更新 input prop，必须先比较当前编辑器文本，避免每个字符都程序化重写编辑器。
      if (resolvedInputApiRef.current?.getMarkdown() === initialValue) {
        return;
      }
      resolvedInputApiRef.current?.setText(initialValue);
    });
  }, [initialValue, resolvedInputApiRef, syncInitialValueOnMount]);

  const handleTextChange = useCallback(
    (value: string) => {
      latestTextRef.current = value;
      onChange?.(value);
    },
    [onChange],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      onSubmit(resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current);
    },
    [onSubmit, resolvedInputApiRef],
  );

  const handleKeyDown: KeyboardEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      if (event.key !== "Escape" || !onCancel || submitting) {
        return;
      }

      // Dialog 通过 React Portal 挂载时，Esc 关闭弹窗的事件仍会沿组件树
      // 冒泡到行内编辑 form；弹窗已消费这次交互，不能再把消息编辑一并取消。
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        return;
      }

      // 交互说明：用户消息 edit 是临时编辑态，Esc 应等价于点击取消，方便键盘流快速退出。
      event.preventDefault();
      onCancel();
    },
    [onCancel, submitting],
  );

  const handleEditorSubmit = useCallback(
    // 适配：透传业务层返回值（false = 不 reset 编辑器，草稿保留），
    // 吞掉返回值会让 Enter 路径总是清空。
    (value: string) => onSubmit(value),
    [onSubmit],
  );

  const handleDragOver: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const hasWorkspaceFilePayload =
        enableWorkspaceFileDrop && hasWorkspaceFileDragPayload(event.dataTransfer);
      if (hasWorkspaceFilePayload) {
        // 浏览器在 dragover 阶段通常只暴露 dataTransfer.types，不保证能读到 getData 内容。
        // 之前用完整 payload 判断，导致编辑输入框 drop 可用但 hover 状态不亮。
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setWorkspaceFileDragging(true);
        setInternalDragging(true);
        return;
      }
      if (enableExternalFileDrop && Array.from(event.dataTransfer.types).includes("Files")) {
        setExternalFileDragging(true);
      }

      onDragOver?.(event);
    },
    [enableExternalFileDrop, enableWorkspaceFileDrop, onDragOver],
  );

  const handleDragLeave: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      setInternalDragging(false);
      onDragLeave?.(event);
    },
    [onDragLeave],
  );

  const handleDrop: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const workspaceFilePayload = enableWorkspaceFileDrop
        ? readWorkspaceFileDragPayload(event.dataTransfer)
        : null;
      if (workspaceFilePayload) {
        // file tree 拖拽不是系统文件，不能走附件分支；
        // 这里统一转换成和 @ 文件一致的 mention，避免 contenteditable 插入纯文本。
        event.preventDefault();
        // 用户消息编辑器嵌套在 ChatView drop target 内；消费后必须停止冒泡，
        // 否则同一条 mention 还会被底部主输入框再次接收。
        event.stopPropagation();
        setInternalDragging(false);
        setWorkspaceFileDragging(false);
        const currentMarkdown = resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current;
        appendWorkspaceFileMentionToComposer({
          inputApiRef: resolvedInputApiRef,
          currentMarkdown,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: handleTextChange,
        });
        return;
      }

      setInternalDragging(false);
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      onDrop?.(event);
    },
    [
      enableWorkspaceFileDrop,
      handleTextChange,
      onDrop,
      resolvedInputApiRef,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // file tree 拖进编辑框时走的是 mention 插入，不是附件上传。
  // 这里单独使用 workspace file 文案，并从拖拽开始事件就点亮可投放状态，避免必须 over 到输入框才有反馈。
  const isWorkspaceFileDropActive = workspaceFileDragging || internalDragging;
  const isExternalFileDropActive = externalFileDragging || isDraggingOver;
  const draggingOverlayHint = isWorkspaceFileDropActive
    ? workspaceFileDragHint
    : isExternalFileDropActive
      ? dragAttachmentHint
      : undefined;

  const editorNode = (
    // 单行时输入区至少占一半宽度，上下留白与 h-7 控件对齐；两行布局下 contents 不改变原有排版。
    <div className={isInline ? "min-w-1/2 flex-1 py-1 [&_[contenteditable]]:min-h-5" : "contents"}>
      <LexicalChatInput
        extraPlugins={extraPlugins}
        placeholder={placeholder}
        disabled={disabled}
        submitDisabled={submitDisabled}
        allowSubmitWhenEmpty={allowSubmitWhenEmpty}
        enterSubmits={enterSubmits}
        onSubmit={handleEditorSubmit}
        onModifiedSubmit={onModifiedSubmit}
        onChange={handleTextChange}
        onUserInputClear={onUserInputClear}
        onUserInputPresenceChange={onUserInputPresenceChange}
        onUserInputStart={onUserInputStart}
        onFocus={onFocus}
        triggerPanelContainer={resolvedTriggerPanelContainer}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        taskId={taskId}
        skillCatalogSessionId={skillCatalogSessionId}
        inputTestId={inputTestId}
        editorApiRef={resolvedInputApiRef}
        promptHistory={promptHistory}
        avoidIosInputFocusZoom={avoidIosInputFocusZoom}
        compactPlaceholder={compactPlaceholder}
        onWhiteboardMentionSelected={onWhiteboardMentionSelected}
        onPaste={onPaste}
        excludedSlashCommandNames={excludedSlashCommandNames}
        appSlashCommands={appSlashCommands}
        enableMentionPanel={enableMentionPanel}
      />
    </div>
  );
  const actionMenuNode = hasActionMenu ? (
    <span data-composer-action-menu className="flex shrink-0 items-center">
      <ChatPromptActionMenu
        actionMenuTitle={actionMenuTitle}
        excludedSlashCommandNames={excludedSlashCommandNames}
        attachmentAction={attachmentAction}
        disabled={disabled}
        disabledReason={disabledReason}
        inputApiRef={resolvedInputApiRef}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        sessionId={taskId}
        container={resolvedTriggerPanelContainer}
        showPlugins={enableMentionPanel !== false}
      />
    </span>
  ) : null;

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className={cn("relative", className)}>
      {triggerPanelContainer ? null : (
        <div
          ref={setInternalTriggerPanelContainer}
          className="absolute inset-x-0 bottom-full z-20"
        />
      )}
      <div
        data-composer-layout={layout}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative flex flex-col gap-3 overflow-hidden rounded-2xl border-[0.5px] border-input-border bg-input p-3 shadow-(--shadow-composer-soft) transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused",
          isInline && "flex-row flex-wrap items-end gap-2 p-2",
          (isWorkspaceFileDropActive || isExternalFileDropActive) &&
            "border-brand bg-input-focused ring-1 ring-brand/30",
          shellClassName,
        )}
      >
        {draggingOverlayHint ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>{draggingOverlayHint}</span>
            </div>
          </div>
        ) : null}

        {topContent ? (
          // 单行布局下附件等内容单独占输入行上方一整行。
          <div className={isInline ? "basis-full" : "contents"}>{topContent}</div>
        ) : null}
        {/* 单行布局把「+」放到输入区左侧；只有菜单按钮换位置重新挂载，编辑器位置不变。 */}
        {isInline ? actionMenuNode : null}
        {inputLeadingContent ? (
          <div className={cn("flex min-w-0 items-start gap-2", isInline && "flex-1")}>
            <div className="shrink-0">{inputLeadingContent}</div>
            <div className="min-w-0 flex-1">{editorNode}</div>
          </div>
        ) : (
          editorNode
        )}
        <div
          ref={toolbarRef}
          className={cn("group/toolbar flex items-end gap-3", isInline && "shrink-0 gap-1.5")}
        >
          <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
            <div className="flex shrink-0 items-center gap-1" data-composer-leading-content>
              {isInline ? null : actionMenuNode}
              {/* Bugfix：权限/模式选择曾作为 leadingActions 先于动作菜单渲染，导致常驻顺序与产品规范相反。 */}
              {leadingActions}
              {onModeSwitchContainerChange ? (
                <span ref={onModeSwitchContainerChange} className="flex shrink-0 items-center" />
              ) : null}
            </div>
          </div>
          <div
            className="ml-auto flex shrink-0 items-center justify-end gap-1.5"
            data-composer-trailing-actions
          >
            {onCancel && cancelLabel ? (
              <ControlHintTooltip title={cancelLabel} shortcut="Esc">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onCancel}
                  disabled={submitting}
                  data-testid={cancelTestId}
                  aria-label={cancelLabel}
                >
                  <XIcon className="size-4" />
                  <span className="sr-only">{cancelLabel}</span>
                </Button>
              </ControlHintTooltip>
            ) : null}
            {betweenCancelAndSubmitAction}
            {submitControl ?? (
              <ControlHintTooltip title={submitLabel} shortcut={enterSubmits ? "Enter" : undefined}>
                <Button
                  type="submit"
                  size="icon-md"
                  disabled={submitDisabled}
                  data-testid={submitTestId ?? TID_CHAT_SEND_BUTTON}
                  aria-label={submitLabel}
                  className="gap-1 rounded-full bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
                >
                  {submitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
                  <span className="sr-only">{submitLabel}</span>
                </Button>
              </ControlHintTooltip>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
