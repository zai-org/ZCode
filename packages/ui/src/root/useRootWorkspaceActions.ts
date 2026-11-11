import { stageV4ComposerDraftAttachments } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { readProjectSidebarView } from "@/project-sidebar/index.js";
/* eslint-disable max-lines -- Root workspace action hook 集中编排项目、远程和 conversation 入口；合并期保持动作边界完整，后续按领域拆分。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DesktopCommandIds,
  remoteHostIdFromWorkspaceIdentity,
  type AppSettings,
  type IPlatformService,
  type UserInfo,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type {
  CreateTaskOptions,
  CreateTaskRequest,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { parseWslUncWorkspacePath } from "@/lib/wslUncWorkspace.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  resolveComposerScope,
  ensurePendingTaskDraft,
  bindPendingTaskDraft,
  rememberComposerWorkspaceScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { notifyTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { type TabStore, type TabStoreState } from "@/store/tabStore.js";
import type { RootProps } from "@/root/types.js";
import {
  hadPersistedPaneLayoutAtModuleLoad,
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import type { WorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

/** 新任务落点：identity 缺省一律归一化为 null，供只读校验、focus/addTab 统一消费。 */
export interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}

/**
 * 解析新任务落点：请求显式带 targetWorkspace 时（跨项目发起已保存工作流）直接采用它，不再询问 workbench 焦点；
 * 否则惰性回退到 resolveWorkbenchNewTaskTarget。identity 缺省归一化为 null。
 */
export function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}

export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  isDesktop = false,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  refreshProviderState,
  updateAppSettings,
  setOAuthError,
  setUser,
  onProviderFamilyDomainClearedAfterLogout,
  userId,
  onOpenRemoteConnection,
  openRemoteProjectWorkspace,
  openMobileProjectDraft,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  isDesktop?: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  refreshProviderState: () => Promise<void>;
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuthError: (error: string | null) => void;
  setUser: (user: UserInfo | null) => void;
  onProviderFamilyDomainClearedAfterLogout?: () => void;
  userId?: string;
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  openRemoteProjectWorkspace?: (target: {
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    expectedMembershipId?: string;
    projectId: string | null;
    isCurrent?: () => boolean;
  }) => Promise<void>;
  openMobileProjectDraft?: (request: CreateTaskOptions) => Promise<void>;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  const navigationSequence = useRef(0);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const requestConfirmation = useConfirmDialog();
  // Root 的远端装配依赖本 hook 返回的动作，函数引用每轮都会变化；它只用于点击执行，
  // 不应使整个新建入口失稳。与任务导航一致，读取最近已提交实现，并冻结本次操作的实现。
  const remoteProjectOpener = useRef(openRemoteProjectWorkspace);
  useLayoutEffect(() => {
    remoteProjectOpener.current = openRemoteProjectWorkspace;
  });

  useEffect(() => {
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    if (workbenchGroupClientMode === "desktop-continuous" && !isRendererReloadNavigation()) {
      // group/pane 是 renderer-local 持久化 UI 状态。app 冷启动如果直接
      // 激活它们，即使 activeTaskId=null 也会把历史 session 显示出来，违背启动草稿语义。
      // renderer reload 则保留恢复资格，用于输出中刷新续流。
      const workbenchState = useWorkbenchGroupStore.getState();
      const activeGroup = workbenchState.activeGroupId
        ? workbenchState.groups[workbenchState.activeGroupId]
        : null;
      const activeGroupWasRestored = Boolean(
        activeGroup &&
        [activeGroup.primaryBinding, ...Object.values(activeGroup.panes)].some(
          (binding) => binding.restoredUnvalidated,
        ),
      );
      if (activeGroupWasRestored) {
        workbenchState.deactivateActiveGroup();
      }
      if (hadPersistedPaneLayoutAtModuleLoad()) {
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
    }
  }, [workbenchGroupClientMode]);

  const composerClientNamespace = useComposerClientNamespace();
  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string, options?: CreateTaskOptions) => {
      const projectId =
        options?.projectId !== undefined
          ? options.projectId
          : (readComposerWorkspaceScope(workspacePath, workspaceIdentity, composerClientNamespace)
              ?.projectId ?? null);
      const scope = resolveComposerScope(projectId, workspaceIdentity, composerClientNamespace);
      const savedDraft = readV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        scope,
      );
      const taskGroupId =
        options?.taskGroupId !== undefined
          ? options.taskGroupId
          : (savedDraft?.taskGroupId ?? null);
      rememberComposerWorkspaceScope(workspacePath, workspaceIdentity, scope);
      if (options?.draftId) bindPendingTaskDraft(scope, options.draftId, workspacePath);
      persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        {
          text: "",
          ...(options?.initialComposerDraft?.draft ?? savedDraft),
          projectId,
          taskGroupId,
        },
        scope,
      );
      if (workbenchGroupClientMode === "desktop-continuous") {
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      useZCodeSessionStore
        .getState()
        .startDraft(workspacePath, options?.provider, workspaceIdentity, {
          projectId,
          taskGroupId,
        });
      if (options?.initialComposerDraft) {
        stageV4ComposerDraftAttachments(
          workspacePath,
          workspaceIdentity,
          useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .draftFocusVersion,
          options.initialComposerDraft,
        );
      }
      // 项目草稿只由接收目录的 Root 初始化；mention 的尾空格属于编辑内容。
      const initialPrompt = options?.initialPrompt;
      if (initialPrompt?.trim()) {
        const mention = options?.initialPromptMention;
        persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            projectId,
            taskGroupId,
            ...(mention ? { mention } : {}),
          },
          scope,
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, initialPrompt, workspaceIdentity, mention);
      }
    },
    [workbenchGroupClientMode, composerClientNamespace],
  );

  const startNewTaskFromActiveWorkspace = useCallback(
    async (source: string, request?: CreateTaskRequest) => {
      const openRemoteProjectWorkspace = remoteProjectOpener.current;
      const sequence = ++navigationSequence.current;
      const originTab = tabStoreApi.getState().activeTabId;
      const originWorkspace = activeWorkspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined)
        : null;
      const isCurrent = () =>
        (typeof request !== "object" || request.isCurrent?.() !== false) &&
        sequence === navigationSequence.current &&
        tabStoreApi.getState().activeTabId === originTab &&
        (!activeWorkspacePath ||
          (() => {
            const state = useZCodeSessionStore
              .getState()
              .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined);
            return (
              state.activeTaskId === originWorkspace?.activeTaskId &&
              state.draftFocusVersion === originWorkspace?.draftFocusVersion
            );
          })());
      try {
        // 在第一次 await 前捕获活动任务/草稿；快捷键和侧栏新建共用同一组织意图。
        const requestOptions = typeof request === "string" ? { provider: request } : { ...request };
        if (
          requestOptions.taskGroupId === undefined &&
          requestOptions.projectId === undefined &&
          readProjectSidebarView() === "grouped" &&
          activeWorkspacePath
        ) {
          const taskId = originWorkspace?.activeTaskId;
          const draftGroupId = originWorkspace?.draftTaskGroupId;
          const structure = taskId ? await services.taskGroupService?.read() : undefined;
          if (!isCurrent()) return;
          requestOptions.taskGroupId = taskId
            ? (structure?.members.find(
                (member) =>
                  member.taskId === taskId &&
                  member.workspaceKey === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
              )?.groupId ?? null)
            : (draftGroupId ?? null);
        }
        request = requestOptions;
        let projectId =
          typeof request === "string"
            ? undefined
            : (request?.projectId ?? request?.targetWorkspace?.projectId);
        let hostId =
          typeof request === "string"
            ? undefined
            : (request?.hostId ?? request?.targetWorkspace?.hostId);
        const hasExplicitProject =
          typeof request === "object" &&
          request !== null &&
          ("projectId" in request || Boolean(request.targetWorkspace?.projectId));
        const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
          resolveWorkbenchNewTaskTarget({
            activeWorkspacePath,
            activeWorkspaceIdentity,
            activeGroup: useWorkbenchGroupStore.getState().activeGroupId
              ? (useWorkbenchGroupStore.getState().groups[
                  useWorkbenchGroupStore.getState().activeGroupId!
                ] ?? null)
              : null,
            paneLayout: usePaneLayoutStore.getState(),
          }),
        );
        if (!hasExplicitProject && newTaskTarget) {
          // 原因：仅远程继承项目会让本地快捷键落入未归类。按任务完整身份读取归属，不能由 cwd 猜项目。
          if (newTaskTarget.workspaceIdentity) {
            hostId =
              remoteHostIdFromWorkspaceIdentity(newTaskTarget.workspaceIdentity) ?? undefined;
            if (!hostId) throw new Error("project.host-identity-required");
          }
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(
              newTaskTarget.workspacePath,
              newTaskTarget.workspaceIdentity ?? undefined,
            );
          const tree = workspace.activeTaskId
            ? await services.projectService?.readTree(hostId ? { hostId } : undefined)
            : undefined;
          if (workspace.activeTaskId && !tree) throw new Error("project.service-unavailable");
          projectId = workspace.activeTaskId
            ? (tree?.tasks.find(
                (task) =>
                  task.taskId === workspace.activeTaskId &&
                  (task.workspaceIdentity?.trim() || task.workspacePath) ===
                    (newTaskTarget.workspaceIdentity?.trim() || newTaskTarget.workspacePath),
              )?.projectId ?? undefined)
            : (workspace.draftProjectId ?? undefined);
          if (projectId && (!hostId || hostId === "local")) {
            // 软删除保留历史 project_id；把它直接继承给新任务会报 not-found 并停在旧页。
            // 只继承同 Host 的有效项目，草稿也复验；读取失败仍报错，不冒充项目已删除。
            const projects = tree?.projects ?? (await services.projectService?.readProjects());
            if (!projects) throw new Error("project.service-unavailable");
            if (
              !projects.some(
                (project) =>
                  project.id === projectId && project.hostId === "local" && !project.deleted,
              )
            ) {
              logger.debug("[Root] 新任务不继承已删除的本地项目", { projectId });
              projectId = undefined;
            }
          }
          if (hostId && hostId !== "local" && !projectId)
            throw new Error("project.remote-project-required");
        }
        if (!isCurrent()) return;
        if (workbenchGroupClientMode === "web-remote-replayable") {
          if (!openMobileProjectDraft) throw new Error("project.remote-navigation-unavailable");
          // 归属先在共享入口解析，目录仍只由 bridge owner 准备；旧 Root 不写交接后的草稿。
          await openMobileProjectDraft({
            ...requestOptions,
            ...(projectId ? { projectId } : {}),
            ...(hostId ? { hostId } : {}),
          });
          return;
        }
        if (!services.projectService) throw new Error("project.service-unavailable");
        const pendingDraft =
          !projectId && (!hostId || hostId === "local")
            ? ensurePendingTaskDraft(resolveComposerScope(null, undefined, composerClientNamespace))
            : null;
        const target = await services.projectService.prepareSession({
          ...(projectId ? { projectId } : {}),
          ...(hostId ? { hostId } : {}),
          // worktree 模式由 Host 新建受管 worktree 并返回其中的 cwd；不复用未归类草稿目录。
          ...(typeof request === "object" && request.worktree && projectId
            ? { worktree: request.worktree }
            : {}),
          // 显式 local 与省略 Host 是同一入口，不能漏掉待发送身份而另建目录。
          ...(pendingDraft
            ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
            : {}),
        });
        if (!isCurrent()) return;
        if (hostId && hostId !== "local") {
          if (!target.workspaceIdentity || !openRemoteProjectWorkspace)
            throw new Error("project.remote-navigation-unavailable");
          await openRemoteProjectWorkspace({
            ...target,
            hostId,
            isCurrent,
            ...(typeof request === "object" && request.remoteProjectMembershipId
              ? { expectedMembershipId: request.remoteProjectMembershipId }
              : {}),
          });
        }
        // 目录准备成功才提交导航；失败保留当前会话和分屏。
        if (!hostId || hostId === "local")
          addTab(target.workspacePath, {
            workspacePurpose: target.projectId ? "project" : "conversation",
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          });
        startDraftInWorkspace(target.workspacePath, target.workspaceIdentity, {
          ...(typeof request === "string" ? { provider: request } : request),
          ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
          projectId: target.projectId,
        });
        if (typeof request === "object") request.onComplete?.();
        setWorkspaceActionError(null);
        logger.info(`[Root] ${source}`, {
          workspacePath: target.workspacePath,
          projectId: target.projectId,
        });
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("[Root] 准备新任务失败", error);
        if (typeof request === "object" && request.onError) request.onError(error);
        else {
          // 原因：原错误状态无人展示，目录移走后顶部新建和快捷键只会静默失败。
          // 在仍有效的动作出口反馈；有 onError 的调用方继续负责展示，避免重复提示。
          // 手机 bridge 返回普通错误对象，不能用 instanceof Error 丢掉 message。
          const message =
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
              ? error.message
              : String(error);
          toast(
            message === "project.primaryRootMissing" || message === "project.primaryRootUnavailable"
              ? intl.formatMessage({ id: message })
              : message,
          );
        }
      }
    },
    [
      services.projectService,
      intl,
      composerClientNamespace,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      tabStoreApi,
      addTab,
      openMobileProjectDraft,
      workbenchGroupClientMode,
      startDraftInWorkspace,
    ],
  );

  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    createTask: startNewTaskFromActiveWorkspace,
    setWorkspaceActionError,
  });

  const handleLogout = useCallback(async () => {
    let runningAgentSessionCount: number | null = null;
    try {
      const sessionActivity = await platform.getDesktopSessionActivity?.();
      runningAgentSessionCount =
        typeof sessionActivity?.runningAgentSessionCount === "number"
          ? sessionActivity.runningAgentSessionCount
          : null;
    } catch (error) {
      logger.warn("[Root] 查询桌面运行中会话数量失败，使用保守退出登录文案", { error });
    }

    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "logout.confirm.title" }),
      description:
        runningAgentSessionCount !== null && runningAgentSessionCount > 0
          ? intl.formatMessage(
              { id: "logout.confirm.descriptionWithRunningSessions" },
              { count: String(runningAgentSessionCount) },
            )
          : intl.formatMessage({ id: "logout.confirm.descriptionDefault" }),
      confirmLabel: intl.formatMessage({ id: "logout.confirm.ok" }),
      cancelLabel: intl.formatMessage({ id: "logout.confirm.cancel" }),
    });
    if (!confirmed) {
      return;
    }

    // Bug 原因：telemetry 是辅助链路；等待网络重试会延迟退出登录，甚至在旧的无超时实现里
    // 无限阻塞主流程。这里只调度事件，Main 侧负责有界重试与退出 drain。
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: "app_user_logout",
        eventRegion: "app_profile",
        eventType: "ck",
        eventExtraDetail: {},
        userId,
      },
      "Root",
    );
    const settingsBeforeLogout = await services.settingService.get();
    const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
      currentDomain: settingsBeforeLogout.providerFamilyDomain,
    });
    await services.oauthService.logout();
    await updateAppSettings({
      providerFamilyDomain: (nextProviderFamilyDomain ?? "") as AppSettings["providerFamilyDomain"],
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
    });
    if (!nextProviderFamilyDomain) {
      onProviderFamilyDomainClearedAfterLogout?.();
    }
    // ZAI/BigModel provider 已恢复为 App 登录镜像。
    // 派生 Coding/Start key 由 OAuth logout 的 host hook 统一清理，Root 只负责刷新展示态。
    setOAuthError(null);
    setUser(null);
    // 退出登录后刷新 Account Source 与 Registry，避免继续展示退出前的 Provider 状态。
    await refreshProviderState();
    // Coding Plan 官网 webview 使用独立持久 partition，App logout 必须同步清理。
    await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [
    intl,
    requestConfirmation,
    refreshProviderState,
    onProviderFamilyDomainClearedAfterLogout,
    platform,
    services.oauthService,
    services.modelSelectionService,
    services.settingService,
    setOAuthError,
    setUser,
    updateAppSettings,
    userId,
  ]);

  const handleSelectProject = useCallback(
    async (path: string, activateOtherWindow = true) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      const sequence = ++navigationSequence.current;
      const origin = tabStoreApi.getState();
      const readOriginDraft = () =>
        origin.activeWorkspacePath
          ? useZCodeSessionStore
              .getState()
              .getWorkspaceState(
                origin.activeWorkspacePath,
                origin.activeWorkspaceIdentity ?? undefined,
              )
          : undefined;
      const originDraft = readOriginDraft();
      const isCurrent = () => {
        const current = readOriginDraft();
        return (
          sequence === navigationSequence.current &&
          tabStoreApi.getState().activeTabId === origin.activeTabId &&
          current?.activeTaskId === originDraft?.activeTaskId &&
          current?.draftFocusVersion === originDraft?.draftFocusVersion
        );
      };
      try {
        const wslUncWorkspace = parseWslUncWorkspacePath(path);
        if (wslUncWorkspace && onOpenRemoteConnection) {
          const shouldOpenWslConnection = await requestConfirmation({
            title: intl.formatMessage({ id: "workspace.wslUncPrompt.title" }),
            description: intl.formatMessage(
              { id: "workspace.wslUncPrompt.description" },
              {
                path,
              },
            ),
            confirmLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.openWsl" }),
            cancelLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.continuePath" }),
          });
          if (shouldOpenWslConnection) {
            logger.info("[Root] 用户选择通过 WSL 远程连接打开 UNC 工作区", {
              distro: wslUncWorkspace.distro,
              path,
            });
            onOpenRemoteConnection({
              preferredKind: "wsl",
              preferredWslDistro: wslUncWorkspace.distro,
            });
            return;
          }
        }

        if (!isCurrent()) return;
        // 项目模型迁移后，单独 addTab 不再赋予项目归属。桌面目录入口必须先由
        // Host 原子复用/创建项目，再初始化草稿，不能沿用该目录的旧草稿归属。
        let projectId: string | undefined;
        if (isDesktop) {
          if (!services.projectService) throw new Error("project.service-unavailable");
          projectId = (
            await services.projectService.saveProject({ roots: [path], reuseExistingRoot: true })
          ).id;
        }
        if (!isCurrent()) return;
        // 桌面端：检查是否已有其他窗口打开了该目录，如果是则激活该窗口对应 tab
        const result = activateOtherWindow
          ? await platform.activateOrSetWorkspace(path)
          : { activated: false };
        if (!isCurrent()) return;
        if (result.activated) {
          logger.info("[Root] 目录已在其他窗口打开，已激活该窗口对应 tab，跳过重复打开");
          return;
        }

        // 新增 tab（如果已在本窗口打开则激活它）
        addTab(path);
        // 打开 workspace 是 workspace-only 意图，不是“继续上次会话”。
        // 即使命中已存在 tab，也必须清掉该 workspace 的 activeTaskId 并回到单 pane 草稿。
        startDraftInWorkspace(path, undefined, projectId ? { projectId } : undefined);
        setWorkspaceActionError(null);
        logger.info("[Root] 已打开目录", { path, projectId });
      } catch (err) {
        if (!isCurrent()) return;
        logger.error("[Root] handleSelectProject error:", err);
        setWorkspaceActionError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      addTab,
      intl,
      onOpenRemoteConnection,
      platform,
      requestConfirmation,
      services.projectService,
      isDesktop,
      startDraftInWorkspace,
      tabStoreApi,
    ],
  );

  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web 远程控制当前只保证“进入 desktop 已打开的 workspace”。
      // 之前这里继续放开“打开工作区”，用户会被带进打开工作区中间页，
      // 但后续的新工作区/新会话链路并没有在 Web 远程控制模式里补齐，看起来就像页面一直卡住。
      // 这里直接拦掉入口，避免把用户带进半支持状态。
      logger.info("[Root] 当前模式不支持打开其他工作区，已忽略请求");
      return;
    }
    setWorkspaceActionError(null);

    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    // 打开工作区中间页作为“新标签页”会在启动空态、Cmd/Ctrl+O
    // 和菜单打开工作区时抢占整页。现在打开工作区只保留为动作：本地优先直接弹系统目录选择，
    // 不再进入中间页面；不支持系统目录选择的壳层由启动兜底负责创建默认 workspace。
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info("[Root] 当前模式不支持从空态菜单打开文件夹，已忽略请求");
      return;
    }

    // 空态 workspace 菜单的 Open folder 需要复用根级打开工作区动作。
    // 因此这里调用同一个入口函数，只把 Root 里的 selectDirectory 与项目选择回调注入进去。
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 从空态菜单创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      return startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );

  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }

    // 设置页返回最近 workspace 时不能只按 path 激活。
    // 同一路径可能存在不同远端身份，丢掉 activeWorkspaceIdentity 会把远程工作区切到 path-only 桶。
    const activated = tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
    const taskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined).activeTaskId;
    if (activated && taskId) {
      notifyTaskNavigationCommitted({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        taskId,
      });
    }
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);

  // 设置页（分享管理）跳到指定会话：与自动化「打开会话」共用 workspace 解析，
  // 远程 tab 未打开时 fail-closed，不凭 identity 伪造远程 tab。
  const handleOpenTaskFromSettings = useCallback(
    (target: { workspacePath: string; workspaceIdentity?: string; taskId: string }) => {
      const workspaceResult = ensureTaskNavigationWorkspace({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        activateTabByPath: (workspacePath, options) =>
          tabStoreApi.getState().activateTabByPath(workspacePath, options),
        addLocalWorkspaceTab: (workspacePath) => addTab(workspacePath),
      });
      if (!workspaceResult.accepted) {
        logger.warn("[Root] open task from settings rejected", {
          reason: workspaceResult.reason,
        });
        toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
        return;
      }
      useZCodeSessionStore
        .getState()
        .setActiveTaskId(target.workspacePath, target.taskId, target.workspaceIdentity);
      notifyTaskNavigationCommitted(target);
    },
    [addTab, intl, tabStoreApi],
  );

  return {
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
    handleOpenTaskFromSettings,
  };
}
