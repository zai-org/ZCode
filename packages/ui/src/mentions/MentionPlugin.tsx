/* eslint-disable max-lines */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import { PaletteIcon, WandSparkles } from "lucide-react";
import {
  $createTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useZCodeIntl } from "../i18n/IntlProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
} from "../lib/promptInputTriggers.js";
import { ContextMentionOptionContent } from "@/mentions/components/ContextMentionOptionContent.js";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import {
  MentionPanel,
  type MentionPanelOption,
  type MentionPanelSection,
} from "./components/MentionPanel.js";
import {
  buildVisibleMentionGroups,
  hasMentionQuery,
  MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  type MentionResultGroup,
} from "./mentionSearch.js";
import {
  getMentionPanelGroupOrder,
  getSessionMentionWorkspaceScope,
  type MentionPanelGroupId,
} from "./mentionPanelRouting.js";
import { $createPromptMentionNode } from "./nodes/PromptMentionNode.js";
import {
  ExtensionMentionOptionContent,
  useExtensionMentionGroups,
} from "@/extension-slots/index.js";
import { useFileMentionProvider } from "./providers/fileMentionProvider.js";
import { usePluginsMentionProvider } from "./providers/pluginsMentionProvider.js";
import { useSessionsMentionProvider } from "./providers/sessionsMentionProvider.js";
import { useSkillsMentionProvider } from "./providers/skillsMentionProvider.js";
import { useWhiteboardMentionProvider } from "./providers/whiteboardMentionProvider.js";
import type { MentionItem } from "./mentionTypes.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./activePromptInputToken.js";
import { getCurrentTextNodeSelection } from "./mentionHelpers.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface MentionPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined = 新建草稿。决定 Plugins 分组的 catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
}

export function getWrappedMentionIndex(
  currentIndex: number,
  delta: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  // mention 面板的上下键导航以前会把边界直接 clamp 到首/尾项。
  // 这里改成循环取模，保证按上键能从第一项跳到最后一项，按下键也能从最后一项回到第一项。
  return (currentIndex + delta + itemCount) % itemCount;
}

/**
 * 在循环导航的基础上跳过禁选项（V1 同名 Plugin 冲突项）。
 * 全部禁选时保持原地不动，Enter/Tab 的选择守卫会拒绝插入。
 */
export function getNextEnabledMentionIndex(
  currentIndex: number,
  delta: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  let next = getWrappedMentionIndex(currentIndex, delta, items.length);
  for (let step = 0; step < items.length; step++) {
    if (!items[next]?.disabled) {
      return next;
    }
    next = getWrappedMentionIndex(next, delta >= 0 ? 1 : -1, items.length);
  }
  return currentIndex;
}

/**
 * 候选首次出现或异步分组更新时，把选中项收敛到可选条目。
 * 根因：冲突 Plugin 保持可见后可能占据 flatItems[0]；若仍默认选中 0，
 * 第一次 Enter/Tab 会命中禁选项并回落编辑器默认行为，而不是继续键盘导航。
 */
export function coerceEnabledMentionIndex(
  currentIndex: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  const boundedIndex = Math.min(Math.max(currentIndex, 0), items.length - 1);
  if (!items[boundedIndex]?.disabled) {
    return boundedIndex;
  }
  const firstEnabledIndex = items.findIndex((item) => !item.disabled);
  return firstEnabledIndex >= 0 ? firstEnabledIndex : boundedIndex;
}

/**
 * IME 组合期间（拼音未上屏）是否冻结 @ 面板重算：中间态字母会被当作 query 逐字过滤一轮，
 * 面板闪烁且中间态结果错误；composition 提交后 Lexical 会再派发一次 update 完成重算。
 * Android 例外：Chrome + Gboard 对拉丁词也走 composition（整词到空格才 compositionend），
 * 冻结会让手机 Web 的 @ 面板失去逐字过滤，因此 Android 保持实时重算。
 */
export function shouldFreezeMentionRecalcWhileComposing(
  isComposing: boolean,
  userAgent: string,
): boolean {
  return isComposing && !/Android/i.test(userAgent);
}

export function MentionPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  onWhiteboardMentionSelected,
}: MentionPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useZCodeIntl();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const activeQuery = activeTrigger?.query ?? "";
  // 候选过滤会在渲染线程扫描大型 workspace；输入框与搜索共用同一个 query
  // 时，快速输入/删除会让每次按键都同步承担搜索成本。deferred query 只延后候选派生，
  // 不延后编辑器 token、触发器和最终插入，因此输入始终跟手，结果最终收敛到最新 query。
  const deferredActiveQuery = useDeferredValue(activeQuery);
  const hasActiveQuery = hasMentionQuery(activeQuery);
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  const isOpen =
    !disabled &&
    (activeTrigger?.trigger === "@" ||
      activeTrigger?.trigger === "$" ||
      activeTrigger?.trigger === "#");
  const isContextTrigger = activeTrigger?.trigger === "@";
  const isSessionTrigger = activeTrigger?.trigger === "#";
  const isSkillTrigger = activeTrigger?.trigger === "$";

  // 修复说明：之前把 @ 面板拆成了两层，导致用户输入 query 后还要再确认一次，
  // 实际感受像“按回车之后才开始搜”。现在改成单层分组面板，query 一变化就直接展示各分组结果。
  const skillsResult = useSkillsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    provider,
    deferredActiveQuery,
    isOpen && isSkillTrigger,
    false,
    intl.formatMessage({ id: "chat.mention.skills.empty" }),
    intl.formatMessage({ id: "chat.mention.skills.title" }),
  );
  const fileDefaultPreviewLimit = !hasActiveQuery
    ? MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT
    : MENTION_DEFAULT_GROUP_PREVIEW_LIMIT;
  const fileResult = useFileMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.files.empty" }),
    intl.formatMessage({ id: "chat.mention.files.title" }),
    fileDefaultPreviewLimit,
    { sessionId, projectId: draftProjectId },
  );
  const whiteboardResult = useWhiteboardMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger && Boolean(onWhiteboardMentionSelected),
    intl.formatMessage({ id: "chat.mention.whiteboards.empty" }),
    intl.formatMessage({ id: "chat.mention.whiteboards.title" }),
  );
  const sessionsResult = useSessionsMentionProvider(
    provider,
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && (isContextTrigger || isSessionTrigger),
    getSessionMentionWorkspaceScope(activeTrigger?.trigger),
    intl.formatMessage({ id: "chat.mention.sessions.empty" }),
    intl.formatMessage({ id: "chat.mention.sessions.title" }),
    intl.formatMessage({ id: "project.tasks" }),
  );
  // Plugins 分组：新建草稿（sessionId=null）读 workspace
  // 当前 catalog，已有 Session 读 session-owned 冻结 catalog；冲突项由 provider 标记禁选。
  const pluginsResult = usePluginsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.plugins.empty" }),
    intl.formatMessage({ id: "chat.mention.plugins.title" }),
  );

  // 插件 composer.mention 条目的分组（docs/plugins/extension-host.md §16.6）：只在 `@` 面板，
  // 作用域与 Plugins 分组相同（草稿为预热会话）。没有扩展门面（Web、手机远控）时为空。
  const extensionGroups = useExtensionMentionGroups({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    sessionId: sessionId ?? null,
    // 用即时 query 而不是 deferred：插件按 query 远程查询，延后没有收益；面板刚打开时 deferred 值
    // 还是上一次的空串，会多发一次查询，tool 条目还会因此多弹一次审批（运行时日志：同一次输入先查 "" 再查 "qx"）。
    query: activeQuery,
    enabled: isOpen && isContextTrigger,
  });

  const panelGroups = useMemo<MentionResultGroup<MentionItem>[]>(() => {
    if (activeTrigger?.trigger === "#" && sessionsResult.groups?.length) {
      return buildVisibleMentionGroups(
        sessionsResult.groups.map((group) => ({
          ...group,
          emptyText: sessionsResult.emptyText,
          loading: sessionsResult.loading,
          errorText: sessionsResult.error?.message ?? null,
        })),
      );
    }
    const groupsById = {
      files: {
        id: "files",
        title: fileResult.title,
        items: fileResult.items,
        loading: fileResult.loading,
        errorText: fileResult.error?.message ?? null,
        emptyText: fileResult.emptyText,
      },
      plugins: {
        id: "plugins",
        title: pluginsResult.title,
        items: pluginsResult.items,
        loading: pluginsResult.loading,
        errorText: pluginsResult.error?.message ?? null,
        emptyText: pluginsResult.emptyText,
      },
      sessions: {
        id: "sessions",
        title: sessionsResult.title,
        items: sessionsResult.items,
        loading: sessionsResult.loading,
        errorText: sessionsResult.error?.message ?? null,
        emptyText: sessionsResult.emptyText,
      },
      skills: {
        id: "skills",
        title: skillsResult.title,
        items: skillsResult.items,
        loading: skillsResult.loading,
        errorText: skillsResult.error?.message ?? null,
        emptyText: skillsResult.emptyText,
      },
      whiteboards: {
        id: "whiteboards",
        title: whiteboardResult.title,
        items: whiteboardResult.items,
        loading: whiteboardResult.loading,
        errorText: whiteboardResult.error?.message ?? null,
        emptyText: whiteboardResult.emptyText,
      },
    } satisfies Record<MentionPanelGroupId, MentionResultGroup<MentionItem>>;

    // @ 的类别顺序与 $ 单分组保持原契约；# 的项目分组来自当前 Host 查询结果。
    // 插件分组只在 @ 面板，排在内置分组之后。
    return buildVisibleMentionGroups([
      ...getMentionPanelGroupOrder(activeTrigger?.trigger).map((groupId) => groupsById[groupId]),
      ...(activeTrigger?.trigger === "@" ? extensionGroups : []),
    ]);
  }, [
    extensionGroups,
    fileResult.emptyText,
    fileResult.error,
    fileResult.items,
    fileResult.loading,
    fileResult.title,
    activeTrigger?.trigger,
    pluginsResult.emptyText,
    pluginsResult.error,
    pluginsResult.items,
    pluginsResult.loading,
    pluginsResult.title,
    sessionsResult.emptyText,
    sessionsResult.error,
    sessionsResult.items,
    sessionsResult.groups,
    sessionsResult.loading,
    sessionsResult.title,
    whiteboardResult.emptyText,
    whiteboardResult.error,
    whiteboardResult.items,
    whiteboardResult.loading,
    whiteboardResult.title,
    skillsResult.emptyText,
    skillsResult.error,
    skillsResult.items,
    skillsResult.loading,
    skillsResult.title,
  ]);

  const flatItems = useMemo(() => panelGroups.flatMap((group) => group.items), [panelGroups]);

  const panelSections = useMemo<MentionPanelSection[]>(
    () =>
      panelGroups.map((group) => ({
        id: group.id,
        title: group.title,
        showHeader: activeTrigger?.trigger === "#" || group.showHeader === true,
        options: group.items.map<MentionPanelOption>((item) => ({
          id: item.id,
          label: item.displayLabel ?? item.label,
          description: item.description,
          // 冲突 Plugin 等禁选项：面板可见但不可选择，行内展示原因（V1 fail closed）。
          disabled: item.disabled,
          disabledReason: item.disabledReason,
          // @ 面板之前只用 label/description 自己拼文件行，导致图标、文件名和路径展示
          // 跟输入框里的 mention token 不一致。这里统一复用 fileDisplay，让面板和 token 使用同一套文件语义展示。
          content:
            item.category === "files" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "skills" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                {/* Bugfix: skills 候选项需要和命令类项保持一致的主次信息密度，
                    这里保留图标 + 名称主文案，再把描述压成右侧弱信息，而不是额外占第二行。 */}
                <WandSparkles className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {item.description}
                </span>
              </span>
            ) : item.category === "whiteboards" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                <PaletteIcon className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.mention.whiteboards.strokeCount" },
                    { count: item.description },
                  )}
                </span>
              </span>
            ) : item.category === "sessions" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "plugins" ? (
              <PluginMentionOptionContent item={item} />
            ) : item.category === "extensions" ? (
              <ExtensionMentionOptionContent item={item} />
            ) : undefined,
        })),
        loading: group.loading,
        loadingText: intl.formatMessage({
          id: "chat.mention.category.loading",
        }),
        errorText: group.errorText,
        noticeText: group.noticeText ?? null,
        emptyText: group.emptyText,
      })),
    [intl, panelGroups, workspacePath, activeTrigger?.trigger],
  );

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex((current) => coerceEnabledMentionIndex(current, flatItems));
  }, [flatItems]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (
        shouldFreezeMentionRecalcWhileComposing(
          editor.isComposing(),
          typeof navigator === "undefined" ? "" : navigator.userAgent,
        )
      ) {
        return;
      }
      editorState.read(() => {
        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = reconcileActivePromptInputTokenSnapshot(
          activeTokenRef.current,
          selectionState,
          dirtyElements.size === 0 && dirtyLeaves.size === 0,
        );
        if (
          !nextActiveToken ||
          (nextActiveToken.trigger !== "@" &&
            nextActiveToken.trigger !== "$" &&
            nextActiveToken.trigger !== "#")
        ) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        const nextSignature = getPromptInputTriggerSignature(nextActiveToken);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveToken.trigger &&
            current.query === nextActiveToken.query
          ) {
            return current;
          }

          return {
            query: nextActiveToken.query,
            trigger: nextActiveToken.trigger,
          };
        });
      });
    });
  }, [disabled, editor]);

  const insertMentionItem = useCallback(
    (item: MentionItem) => {
      if (item.category === "whiteboards" && onWhiteboardMentionSelected) {
        editor.update(() => {
          const selectionState = getCurrentTextNodeSelection();
          if (!selectionState) {
            return;
          }

          const snapshotRange = getActivePromptInputTokenReplacementRange(
            activeTokenRef.current,
            selectionState,
          );
          const activeMentionTrigger = snapshotRange
            ? activeTokenRef.current
            : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
          if (
            !activeMentionTrigger ||
            (activeMentionTrigger.trigger !== "@" && activeMentionTrigger.trigger !== "$")
          ) {
            return;
          }

          const tokenStart =
            snapshotRange?.start ??
            selectionState.cursorOffset - activeMentionTrigger.query.length - 1;
          const tokenEnd =
            snapshotRange?.end ??
            selectionState.cursorOffset +
              getActivePromptInputTokenTailLength(
                activeMentionTrigger,
                selectionState.textAfterCursor,
                [item.label, item.value, item.markdown],
              );
          selectionState.selection.setTextNodeRange(
            selectionState.node,
            tokenStart,
            selectionState.node,
            tokenEnd,
          );
          selectionState.selection.insertText("");
        });

        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        void onWhiteboardMentionSelected(item.value);
        requestAnimationFrame(() => {
          editor.focus();
        });
        return;
      }

      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeMentionTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (
          !activeMentionTrigger ||
          (activeMentionTrigger.trigger !== "@" &&
            activeMentionTrigger.trigger !== "$" &&
            activeMentionTrigger.trigger !== "#")
        ) {
          return;
        }

        const tokenStart =
          snapshotRange?.start ??
          selectionState.cursorOffset - activeMentionTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeMentionTrigger,
              selectionState.textAfterCursor,
              [item.label, item.value, item.markdown],
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([
          $createPromptMentionNode({
            id: item.id,
            category: item.category,
            label: item.label,
            value: item.value,
            markdown: item.markdown,
            description: item.description,
            data: item.data,
          }),
          trailingWhitespace,
        ]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [editor, onWhiteboardMentionSelected],
  );

  const selectOption = useCallback(
    (index: number) => {
      const nextItem = flatItems[index];
      if (!nextItem) {
        return false;
      }
      // 禁选项（同名冲突 Plugin）不可插入：键盘 Enter/Tab 与鼠标点击都走这里统一拒绝。
      if (nextItem.disabled) {
        return false;
      }

      insertMentionItem(nextItem);
      return true;
    },
    [flatItems, insertMentionItem],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, 1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, -1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    // 调试说明：先注释掉 blur 自动关闭逻辑，方便观察 panel 在焦点切换时的实际行为。
    // 当前只移除“失焦即消失”这一路径，Esc / 选中项 / trigger 失效等关闭逻辑仍然保留。
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, flatItems, isOpen, selectOption, selectedIndex]);

  const panelTitle = intl.formatMessage({ id: "chat.mention.title" });
  const panelDescription = hasActiveQuery
    ? ""
    : activeTrigger?.trigger === "#"
      ? intl.formatMessage({ id: "chat.mention.sessions.searchHint" })
      : activeTrigger?.trigger === "$"
        ? intl.formatMessage({ id: "chat.mention.skills.searchHint" })
        : intl.formatMessage({ id: "chat.mention.searchHint" });
  const panelEmptyText = hasActiveQuery
    ? intl.formatMessage({ id: "chat.mention.emptyResults" })
    : "";

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger={activeTrigger?.trigger ?? "@"}
      sections={panelSections}
      emptyText={panelEmptyText}
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectOption}
    />,
    container,
  );
}
