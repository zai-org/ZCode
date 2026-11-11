/* oxlint-disable eslint(max-lines) -- 平台事件和分享导入共用同一生命周期。 */
import { getConversationShareErrorDetails } from "@/lib/conversationShareError.js";
import { useEffect, useRef, useState } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import type { IPlatformService, ZCodeTaskClientMode } from "@zcode/shared";
import { readV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import { resolveImportedComposerConfig } from "@/v4/composer/newTaskDraft.js";
import { dismissToast, toast, updateToast } from "@/components/ui/toast.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import {
  useWebRemoteControlWorkspaceSync,
  shouldPublishCompleteWorkspaceSnapshot,
} from "@/root/rootPlatformWorkspaceSync.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  createShareImportIntent,
  isShareImportIntentSame,
  resolveShareImportFailurePresentation,
  type ShareImportIntent,
} from "@/root/shareImportIntent.js";

export function useRootPlatformEffects({
  initialWorkspaceAbsPath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  clientMode = "desktop-continuous",
  canBootstrapInitialWorkspace = true,
  addTab,
  setIsBootstrappingInitialWorkspace,
  platform,
  activateTabByPath,
  startDraftInWorkspace,
  startNewTaskFromActiveWorkspace,
  openWorkspace,
  openWorkspacePath,
  setWorkspaceActionError,
  allowOpenWorkspace = true,
  isDesktop,
  locale,
  localeResolved = true,
  tabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  reconnectingRemoteWorkspaceKeys = [],
  remoteWorkspaceErrorByWorkspaceKey = {},
  webRemoteControlFeatureEnabled = false,
  hasCompletedFullTabRestore = true,
  intl,
  isRestoringOAuthSession,
}: {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  initialTaskId?: string;
  initialTaskDraft?: CreateTaskOptions;
  clientMode?: ZCodeTaskClientMode;
  canBootstrapInitialWorkspace?: boolean;
  addTab: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
  ) => void;
  setIsBootstrappingInitialWorkspace: (value: boolean) => void;
  platform: IPlatformService;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  startDraftInWorkspace: (
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CreateTaskOptions,
  ) => void;
  startNewTaskFromActiveWorkspace: (source: string) => void;
  openWorkspace: () => void;
  openWorkspacePath: (workspacePath: string, activateOtherWindow?: boolean) => void | Promise<void>;
  setWorkspaceActionError: (message: string | null) => void;
  allowOpenWorkspace?: boolean;
  isDesktop?: boolean;
  locale: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["locale"];
  /** IntlProvider 是否已从持久化设置确定语言；未确定前 locale 只是占位初值。 */
  localeResolved?: boolean;
  tabs: WindowTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
  webRemoteControlFeatureEnabled?: boolean;
  hasCompletedFullTabRestore?: boolean;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  isRestoringOAuthSession: boolean;
}) {
  const didBootstrapInitialWorkspaceRef = useRef(false);
  const baseServices = useOptionalBaseWorkspaceServices();
  const pendingShareImportRef = useRef<ShareImportIntent | null>(null);
  const [shareImportRevision, setShareImportRevision] = useState(0);
  const composerClientNamespace = useComposerClientNamespace();
  const activeShareImportRef = useRef<ShareImportIntent | null>(null);
  const importOperationRef = useRef<string | null>(null);
  const lastImportProgressToastRef = useRef<{ phase: string; at: number } | null>(null);
  const importToastIdRef = useRef<number | null>(null);

  useEffect(() => {
    // 启动时必须先判断 OAuth 本地会话，再恢复历史/初始 workspace。
    // 如果这里抢先 addTab，未登录用户会先看到主界面，之后才被登录页覆盖。
    if (!canBootstrapInitialWorkspace || didBootstrapInitialWorkspaceRef.current) {
      return;
    }

    didBootstrapInitialWorkspaceRef.current = true;
    if (
      isDesktop &&
      initialWorkspaceAbsPath &&
      initialWorkspacePurpose === "project" &&
      clientMode === "desktop-continuous" &&
      !initialWorkspaceIdentity &&
      !initialTaskId &&
      !initialTaskDraft &&
      !isRendererReloadNavigation()
    ) {
      // 冷启动的 project 标记只描述 tab，不能代替草稿 projectId；与运行中系统目录
      // 入口共用 Host 项目接纳，完成前保留启动屏障，避免空归属草稿先被预热。
      void Promise.resolve(openWorkspacePath(initialWorkspaceAbsPath)).finally(() => {
        setIsBootstrappingInitialWorkspace(false);
      });
      return;
    }
    if (initialWorkspaceAbsPath) {
      const savedScope = readComposerWorkspaceScope(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity,
        composerClientNamespace,
      );
      // 手机重建 Root 时 bridge 只有地址；项目意图随已有浏览器草稿恢复，先于 prewarm。
      const savedDraft =
        clientMode === "web-remote-replayable" && !initialTaskId && !initialTaskDraft
          ? readV4ComposerDraft(
              initialWorkspaceAbsPath,
              initialWorkspaceIdentity,
              V4_DRAFT_SCOPE_ROOT,
              savedScope,
            )
          : null;
      const draftIntent =
        initialTaskDraft ??
        (savedScope
          ? { projectId: savedScope.projectId, taskGroupId: savedDraft?.taskGroupId }
          : undefined) ??
        (savedDraft?.projectId !== undefined
          ? { projectId: savedDraft.projectId, taskGroupId: savedDraft.taskGroupId }
          : undefined);
      addTab(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity || initialWorkspacePurpose
          ? {
              ...(initialWorkspaceIdentity ? { workspaceIdentity: initialWorkspaceIdentity } : {}),
              ...(initialWorkspacePurpose ? { workspacePurpose: initialWorkspacePurpose } : {}),
            }
          : undefined,
      );
      if (initialTaskId) {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(initialWorkspaceAbsPath, initialTaskId, initialWorkspaceIdentity);
      } else if (draftIntent || !isRendererReloadNavigation()) {
        // 修复原因：main 注入 initial workspace 只表达工作区入口；没有显式 taskId
        // 的 app 冷启动必须进入草稿，不能让 renderer-local last-session/group/pane
        // 抢回历史会话；同一 renderer reload 则保留当前 session 续流资格。
        startDraftInWorkspace(initialWorkspaceAbsPath, initialWorkspaceIdentity, draftIntent);
      }
    }
    // Dock 最近项目会通过 initialWorkspaceAbsPath 直达工作区。
    // 如果这里仍然等首屏先按默认空 tab 渲染一次，窗口会先闪出打开工作区中间页，
    // 再异步补上目标 workspace，视觉上像是“打开错页再跳转”。
    // 这里把初始工作区注入也纳入启动保护期，等首个 tab 准备好后再渲染正式内容。
    setIsBootstrappingInitialWorkspace(false);
  }, [
    addTab,
    openWorkspacePath,
    isDesktop,
    canBootstrapInitialWorkspace,
    initialTaskId,
    initialTaskDraft,
    composerClientNamespace,
    clientMode,
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    setIsBootstrappingInitialWorkspace,
    startDraftInWorkspace,
  ]);

  useEffect(() => {
    const disposeFocusTab = platform.onFocusTab((path: string) => {
      logger.info("[Root] onFocusTab:", path);
      // 跨窗口打开由目标窗口完成项目接纳，避免只激活目录后留下未归类草稿。
      void openWorkspacePath(path, false);
    });
    const disposeNewTab = platform.onNewTab(() => {
      logger.info("[Root] onNewTab");
      setWorkspaceActionError(null);
      // 新标签过去会打开工作区中间页，导致启动/快捷键都可能进入中间页。
      // 现在新标签语义收敛为“打开工作区”动作，由 Root 决定目录选择或默认 workspace 兜底。
      openWorkspace();
    });
    // 新建回调包含当前语言；同步更新订阅，避免快捷键展示切换语言前的错误提示。
    const disposeNewTask = platform.onNewTask(() => {
      startNewTaskFromActiveWorkspace("onNewTask");
    });
    const disposeOpenWorkspace = platform.onOpenWorkspace(() => {
      logger.info("[Root] onOpenWorkspace");
      openWorkspace();
    });
    const disposeOpenWorkspacePath = platform.onOpenWorkspacePath
      ? platform.onOpenWorkspacePath((path: string) => {
          if (!allowOpenWorkspace) {
            logger.info("[Root] 当前模式不支持通过 deep link 打开文件夹，已忽略请求");
            return;
          }

          logger.info("[Root] onOpenWorkspacePath:", path);
          // 系统服务 deep link 对应输入框上方 Open folder 语义。
          // 这里复用 handleSelectProject，而不是把路径作为聊天附件，才能保留 tab 去重、
          // 跨窗口激活和 recentProjects 更新这些手动打开文件夹的既有行为。
          openWorkspacePath(path);
        })
      : () => {};
    const disposeShareImport = platform.onShareImport
      ? platform.onShareImport((payload) => {
          const current = pendingShareImportRef.current ?? activeShareImportRef.current;
          if (current && isShareImportIntentSame(current, payload)) {
            logger.info("[Root] 忽略重复的 share import deep link", {
              shareCodeLength: payload.shareCode.length,
            });
            return;
          }
          const activeTab = tabs.find(
            (tab): tab is Extract<WindowTabState, { kind: "workspace" }> =>
              tab.kind === "workspace" &&
              tab.workspacePath === activeWorkspacePath &&
              (activeWorkspaceIdentity
                ? tab.workspaceIdentity === activeWorkspaceIdentity
                : !tab.workspaceIdentity),
          );
          pendingShareImportRef.current = createShareImportIntent(payload.shareCode, undefined, {
            ...(activeWorkspacePath ? { targetWorkspacePath: activeWorkspacePath } : {}),
            ...(activeWorkspaceIdentity
              ? { targetWorkspaceIdentity: activeWorkspaceIdentity }
              : {}),
            targetWorkspaceKind:
              activeTab?.remoteSessionId || activeTab?.remoteTarget ? "remote" : "local",
          });
          setShareImportRevision((revision) => revision + 1);
          logger.info("[Root] 收到 share import deep link", {
            shareCodeLength: payload.shareCode.length,
          });
        })
      : () => {};
    const disposeNotificationClick = platform.onTaskNotificationClick((taskId: string) => {
      logger.info("[Root] onTaskNotificationClick:", taskId);
      // 遍历所有 workspace 找到 taskId 所属的 workspace，然后激活对应 tab 并切换任务
      const workspaces = useZCodeSessionStore.getState().workspaces;
      for (const [workspacePath, workspaceState] of Object.entries(workspaces)) {
        const taskMeta = workspaceState.taskListCache?.find((task) => task.taskId === taskId);
        const hasTask = workspaceState.activeTaskId === taskId || Boolean(taskMeta);
        if (hasTask) {
          const targetWorkspacePath = taskMeta?.workspacePath ?? workspacePath;
          const targetWorkspaceIdentity = taskMeta?.workspaceIdentity;
          // 通知点击会从全局 workspace store 反查 task。
          // 远端任务必须用 task meta 自带的 workspaceIdentity 激活和选中，否则会落到 path-only 桶。
          activateTabByPath(
            targetWorkspacePath,
            targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : undefined,
          );
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
          return;
        }
      }
      logger.warn("[Root] onTaskNotificationClick: task not found in any workspace:", taskId);
    });
    const disposeUpdateCheckResult = platform.onUpdateCheckResult
      ? platform.onUpdateCheckResult((payload) => {
          logger.info("[Root] onUpdateCheckResult:", payload.kind);
          switch (payload.kind) {
            case "up-to-date":
              toast(
                intl.formatMessage(
                  { id: "update.toast.upToDate" },
                  { version: payload.currentVersion },
                ),
              );
              return;
            case "downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.downloading" },
                  { version: payload.version },
                ),
              );
              return;
            case "available":
              toast(
                intl.formatMessage({ id: "update.toast.available" }, { version: payload.version }),
              );
              return;
            case "already-downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.alreadyDownloading" },
                  { progress: payload.progress },
                ),
              );
              return;
            case "ready":
              toast(intl.formatMessage({ id: "update.toast.ready" }, { version: payload.version }));
              return;
            case "dev-skipped":
              toast(intl.formatMessage({ id: "update.toast.devSkipped" }));
              return;
            case "error":
              toast(intl.formatMessage({ id: "update.toast.error" }, { error: payload.message }));
              return;
          }
        })
      : () => {};
    return () => {
      disposeFocusTab();
      disposeNewTab();
      disposeNewTask();
      disposeOpenWorkspace();
      disposeOpenWorkspacePath();
      disposeShareImport();
      disposeNotificationClick();
      disposeUpdateCheckResult();
    };
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    platform,
    startNewTaskFromActiveWorkspace,
    tabs,
  ]);

  useEffect(() => {
    const pending = pendingShareImportRef.current;
    if (!pending || !baseServices || activeShareImportRef.current || importOperationRef.current) {
      return;
    }
    if (isRestoringOAuthSession) {
      return;
    }

    // 分享页 Deep Link 不应在 Root 层按登录态分叉；未登录与已登录都
    // 走同一份 continuation/import 流程。公开可导入分享由接口自身决定是否可用。
    pending.status = "importing";
    pendingShareImportRef.current = null;
    activeShareImportRef.current = pending;
    if (importToastIdRef.current !== null) {
      dismissToast(importToastIdRef.current);
      importToastIdRef.current = null;
    }
    const operationId = `share-import-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    importOperationRef.current = operationId;
    lastImportProgressToastRef.current = null;
    const progressEvent =
      baseServices.conversationShareService.onDynamicImportProgress(operationId);
    const disposeProgress = progressEvent((progress) => {
      const now = Date.now();
      const last = lastImportProgressToastRef.current;
      if (
        last &&
        last.phase === progress.phase &&
        now - last.at < 800 &&
        progress.phase !== "complete"
      ) {
        return;
      }
      // complete 只表示导入事务已经收口；成功结果会在下方统一替换进度提示，避免短暂闪过
      // “导入完成”后又紧接着出现“已从分享导入”的两条成功 Toast。
      if (progress.phase === "complete") {
        return;
      }
      lastImportProgressToastRef.current = { phase: progress.phase, at: now };
      const label =
        progress.phase === "downloading"
          ? intl.formatMessage(
              { id: "conversationShare.import.downloading" },
              { completed: progress.completedArtifacts, total: progress.totalArtifacts },
            )
          : progress.phase === "installing"
            ? intl.formatMessage({ id: "conversationShare.import.installing" })
            : intl.formatMessage({ id: "conversationShare.import.committing" });
      if (importToastIdRef.current === null) {
        importToastIdRef.current = toast(label, { durationMs: 0, variant: "info" });
      } else {
        updateToast(importToastIdRef.current, {
          message: label,
          durationMs: 0,
          variant: "info",
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        });
      }
    });

    void baseServices.conversationShareService
      .importShare(
        {
          shareCode: pending.shareCode,
          clientRequestId: pending.clientRequestId,
          ...(pending.targetWorkspacePath
            ? { targetWorkspacePath: pending.targetWorkspacePath }
            : {}),
          ...(pending.targetWorkspaceIdentity
            ? { targetWorkspaceIdentity: pending.targetWorkspaceIdentity }
            : {}),
          ...(pending.targetWorkspaceKind
            ? { targetWorkspaceKind: pending.targetWorkspaceKind }
            : {}),
          locale,
        },
        operationId,
      )
      .then((result) => {
        pending.status = "complete";
        // 先准备实际落地工作区的独立草稿，再激活；复用导入不覆盖会话选择。
        const composerConfig = resolveImportedComposerConfig(result, composerClientNamespace);
        const activated = activateTabByPath(
          result.workspacePath,
          result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : undefined,
        );
        if (!activated) {
          addTab(result.workspacePath, {
            ...(result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : {}),
            workspacePurpose: "conversation",
          });
        }
        const sessionStore = useZCodeSessionStore.getState();
        sessionStore.setActiveTaskId(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
          composerConfig,
        );
        // 导入可能复用当前已打开的 session；仅 setActiveTaskId 不会产生可观察的切换。
        // 每次成功都显式发出一次定位请求，目标 pane 准备好分享内容后再消费。
        sessionStore.requestTimelineBottom(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
        );
        // 回退过的导入会落在与用户当前所看不同的 workspace，必须讲清落在哪、为何回退，
        // 否则用户只会看到会话“跑到别处去了”。
        const resultMessage = result.fallbackReason
          ? intl.formatMessage(
              {
                id:
                  result.fallbackReason === "remote_workspace"
                    ? "conversationShare.import.fallbackRemoteWorkspace"
                    : "conversationShare.import.fallbackDefaultWorkspace",
              },
              { title: result.title, workspacePath: result.workspacePath },
            )
          : intl.formatMessage({ id: "conversationShare.import.source" }, { title: result.title });
        const resultToastOptions = {
          durationMs: result.fallbackReason ? 7000 : 3000,
          variant: result.fallbackReason ? ("info" as const) : ("default" as const),
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(resultMessage, resultToastOptions);
        } else {
          updateToast(importToastIdRef.current, { message: resultMessage, ...resultToastOptions });
        }
      })
      .catch((error) => {
        pending.status = "failed";
        const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const kind = typeof record.kind === "string" ? record.kind : "unknown";
        const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : undefined;
        const firstIssue = Array.isArray(record.issues) ? record.issues[0] : undefined;
        const firstIssueRecord =
          firstIssue && typeof firstIssue === "object" && !Array.isArray(firstIssue)
            ? (firstIssue as Record<string, unknown>)
            : undefined;
        const artifactDisplayName =
          typeof firstIssueRecord?.artifactDisplayName === "string"
            ? firstIssueRecord.artifactDisplayName
            : undefined;
        const diagnostics = getConversationShareErrorDetails(error);
        logger.warn("[Root] share import failed", {
          status: diagnostics.status,
          code: diagnostics.code,
          requestId: diagnostics.requestId,
          operationId,
          clientRequestId: pending.clientRequestId,
          kind,
          ...(reasonCode ? { reasonCode } : {}),
          ...(typeof record.issueCount === "number" ? { issueCount: record.issueCount } : {}),
        });
        const failurePresentation = resolveShareImportFailurePresentation(kind);
        const retryImport = () => {
          pending.status = "received";
          pendingShareImportRef.current = pending;
          setShareImportRevision((revision) => revision + 1);
        };
        const detailedMessageId =
          artifactDisplayName && kind === "invalid_contract"
            ? "conversationShare.import.integrityFailedWithArtifact"
            : artifactDisplayName && kind === "network"
              ? "conversationShare.import.failedWithArtifact"
              : failurePresentation.messageId;
        const failureMessage = intl.formatMessage(
          { id: detailedMessageId },
          artifactDisplayName ? { artifactDisplayName } : undefined,
        );
        const failureToastOptions = {
          durationMs: 7000,
          ...(failurePresentation.retryable
            ? {
                actionLabel: intl.formatMessage({ id: "conversationShare.import.retry" }),
                onAction: retryImport,
              }
            : {}),
          dismissible: true,
          variant: "default" as const,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(failureMessage, failureToastOptions);
        } else {
          updateToast(importToastIdRef.current, {
            message: failureMessage,
            ...failureToastOptions,
          });
        }
      })
      .finally(() => {
        disposeProgress.dispose();
        activeShareImportRef.current = null;
        importOperationRef.current = null;
        setShareImportRevision((revision) => revision + 1);
      });
  }, [
    activateTabByPath,
    addTab,
    baseServices,
    intl,
    isRestoringOAuthSession,
    locale,
    shareImportRevision,
    composerClientNamespace,
  ]);

  useEffect(() => {
    if (!isDesktop || !shouldPublishCompleteWorkspaceSnapshot(hasCompletedFullTabRestore)) {
      return;
    }

    const paths = tabs
      .filter(isWorkspaceTab)
      // 启动期远程 workspace 现在会先以“断开占位 tab”恢复，
      // 这些 tab 没有 remoteSessionId，但本质仍是远程会话，不能当成本地路径同步给主进程窗口列表。
      // 这里改成按完整远程身份字段过滤，避免把远程路径误同步到本地窗口标签。
      .filter((tab) => !tab.remoteSessionId && !tab.workspaceIdentity && !tab.remoteTarget)
      .map((tab) => tab.workspacePath);
    platform.syncWindowTabs(paths);
  }, [hasCompletedFullTabRestore, isDesktop, platform, tabs]);

  useWebRemoteControlWorkspaceSync({
    platform,
    tabs,
    isDesktop: Boolean(isDesktop),
    featureEnabled: webRemoteControlFeatureEnabled,
    hasCompletedFullTabRestore,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
  });

  useEffect(() => {
    if (isDesktop) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占。本监听先于录制监听注册（同 capture 阶段），
      // 不短路的话录制期按 Cmd/Ctrl+N、O 预览会真实触发新建任务/打开工作区。
      if (isShortcutRecordingActive()) {
        return;
      }
      const isNewTaskShortcut = matchesPrimaryShortcut(event, "n");
      const isOpenWorkspaceShortcut = matchesPrimaryShortcut(event, "o");

      if (!isNewTaskShortcut && !isOpenWorkspaceShortcut) {
        return;
      }

      // Web 端没有宿主菜单，补一层 best-effort 键盘监听，按平台主修饰键落到同一套根级动作。
      // 耦合说明：这里固定使用默认键位（Ctrl/Cmd+N、+O），与「menu 通道命令在 Web 端不可配置」
      // （设置页置灰）配套——若未来放开 Web 端 menu 通道改键，
      // 此处必须改为读快捷键生效表，否则用户改键后 Web 行为会分裂。
      event.preventDefault();
      if (isOpenWorkspaceShortcut) {
        openWorkspace();
        return;
      }

      startNewTaskFromActiveWorkspace("web CmdOrCtrl+N");
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [isDesktop, openWorkspace, startNewTaskFromActiveWorkspace]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }
    // 冷启动竞态修复：IntlProvider 读完 setting.json 之前，locale 只是占位初值（无本地偏好时按
    // navigator 系统语言，中文系统即 zh-CN）。以前这里一挂载就把占位值推给 Main，Main 再广播给
    // Host，导致 UI 选 ja/ru/ko 的用户冷启动后几秒内遥测、client/configs、marketing/touch、
    // getCustomerInfo 等请求带 X-Client-Language=zh-CN。Main 启动时已从 setting.json 同步拿到
    // 真实语言，所以这里必须等语言确定后再同步，不能用占位值覆盖。
    if (!localeResolved) {
      return;
    }

    let disposed = false;

    // 原生菜单文案之前在 main 进程里写死，renderer 切换 locale 只会更新 React 标题栏菜单。
    // 结果就是桌面端会同时出现两套语言，Help 里的反馈/导出日志也无法跟随当前语言切换。
    // 这里把当前 locale 主动同步给 main，让原生菜单和标题栏菜单都从同一份语言状态重建。
    platform.setApplicationLocale(locale).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] 同步应用菜单语言失败", { locale, error });
    });

    return () => {
      disposed = true;
    };
  }, [isDesktop, locale, localeResolved, platform]);

  const activeTabId = useTabStore((state: TabStoreState) => state.activeTabId);
  const activeTabCandidate = useTabStore((state: TabStoreState) =>
    state.tabs.find((tab: WindowTabState) => tab.id === state.activeTabId),
  );
  const activeTab =
    activeTabCandidate && isWorkspaceTab(activeTabCandidate) ? activeTabCandidate : undefined;
  const lastSyncedSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isDesktop) return;
    const workspacePath = activeTab?.workspacePath;
    const workspaceIdentity = activeTab?.workspaceIdentity;
    const syncActiveSession = (): void => {
      const nextSessionId = workspacePath
        ? (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .activeTaskId ?? null)
        : null;
      if (nextSessionId === lastSyncedSessionIdRef.current) return;
      lastSyncedSessionIdRef.current = nextSessionId;
      platform.syncActiveTaskSession(nextSessionId);
    };
    syncActiveSession();
    return useZCodeSessionStore.subscribe(syncActiveSession);
  }, [activeTab, activeTabId, isDesktop, platform]);
}
