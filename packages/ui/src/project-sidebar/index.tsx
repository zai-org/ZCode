import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
export { readProjectSidebarView } from "@/project-sidebar/view-preference.js";
import { SortableProjects } from "@/project-sidebar/SortableProjects.js";
export { ArchiveManagement } from "@/project-sidebar/ArchiveManagement.js";
export { useWebRemoteControlRendererActions } from "@/project-sidebar/useWebRemoteControlRendererActions.js";
export { ProjectManagement } from "@/project-sidebar/ProjectManagement.js";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { TID_SIDEBAR } from "@zcode/shared/test-ids";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import type {
  ProjectSidebarProps,
  VirtualProject,
  Locale,
  Theme,
  RemoteProjectHost,
} from "@/project-sidebar/contract.js";
import { useProjectPinIntent } from "@/project-sidebar/useProjectPinIntent.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";
import { useProjectConnectionDiagnostics } from "@/project-sidebar/useProjectConnectionDiagnostics.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
export {
  ProjectDirectoryProvider,
  useOptionalProjectDirectory,
  useOptionalProjectDirectoryActions,
  useOptionalProjectSelectionDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
export { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
import { useAppControlNavigation } from "@/project-sidebar/useAppControlNavigation.js";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import {
  selectProjectRows,
  selectSortedProjects,
  projectKey,
  projectHasUnread,
  projectSourceServerId,
} from "@/project-sidebar/view.js";
import { TaskGroupedView } from "@/project-sidebar/TaskGroupedView.js";
import { taskGroupKey } from "@/project-sidebar/grouped-view.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import {
  ProjectSidebarNode,
  runProjectAction as action,
} from "@/project-sidebar/ProjectSidebarNode.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { ManagedWorktreesDialog } from "@/project-sidebar/ManagedWorktreesDialog.js";
import { useManagedWorktreeService } from "@/project-sidebar/useManagedWorktrees.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import { ProjectSections } from "@/project-sidebar/ProjectSections.js";
import { ProjectSidebarListHeader } from "@/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectSidebarNavigation } from "@/project-sidebar/ProjectSidebarNavigation.js";
import { HomeOnlyWorkspaceRows } from "@/project-sidebar/HomeOnlyWorkspaceRows.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
export { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
export { useRemoteWorkspaceConnectionGate } from "@/project-sidebar/useRemoteWorkspaceConnectionGate.js";
export { resolveEntryProject } from "@/project-sidebar/view.js";
export type {
  SidebarFileTreeOpenRequest,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

// 右侧面板显隐曾让所有项目的菜单和 Tooltip 重渲染；只隔离无关父更新，保留目录/context 订阅。
export const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  const {
    tree: authoritativeTree,
    directory,
    service,
    remoteService,
    availability,
    hostReadErrors,
    refresh,
    error,
    loading,
    preferences,
    groups,
    deviceNames,
  } = useProjectDirectory();
  const { tree, pin } = useProjectPinIntent(authoritativeTree);
  const remoteSync = useProjectRemoteSync(directory);
  const diagnostics = useProjectConnectionDiagnostics(directory, props, hostReadErrors);
  const navigateToTask = useProjectTaskNavigation(props, tree, remoteService);
  useAppControlNavigation(props, tree, navigateToTask);
  const onSelectTask = useCallback<ProjectSidebarProps["onSelectTask"]>(
    (...args) => {
      void navigateToTask(...args);
    },
    [navigateToTask],
  );
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const setTheme = useZCodeStore((state) => state.setTheme);
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const { view, setView } = preferences;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [groupedToolbar, setGroupedToolbar] = useState<HTMLDivElement | null>(null);
  const [groupedSticky, setGroupedSticky] = useState<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<{ project: VirtualProject | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [worktreeProject, setWorktreeProject] = useState<VirtualProject | null>(null);
  const managedWorktreeService = useManagedWorktreeService();
  // 入口条件：桌面、非手机远控壳、Host 提供服务；是否 Git 仓库交给弹窗空状态表达。
  const canManageWorktrees = Boolean(
    managedWorktreeService && props.isDesktop && !props.isWebRemoteControl,
  );
  // 当前任务只影响远端“创建项目”的默认设备；分组继承在点击时读，
  // 避免本地会话/草稿切换让全部项目的菜单与 Tooltip 重渲染。
  const hasActiveRemoteTask = useZCodeSessionStore((state) =>
    Boolean(
      props.workspaceIdentity &&
      state.workspaces[props.workspaceIdentity.trim() || props.workspacePath]?.activeTaskId,
    ),
  );
  const [remotePicker, setRemotePicker] = useState<RemoteProjectHost | null>(null);
  const { openFiles, openTaskFiles } = useProjectFileTree(props, directory, remoteService);
  const remoteControlEnabled = useWebRemoteControlFeatureEnabled();
  const mobileStatus = useWebRemoteControlStatus({
    enabled: Boolean(props.isDesktop && remoteControlEnabled),
  });
  const mobileView = mobileStatus.mobileConnected ? mobileStatus.mobileViewState : null;
  const mobileActiveTaskKey =
    mobileView?.activeWorkspaceKey && mobileView.activeTaskId
      ? `${mobileView.activeWorkspaceKey}:${mobileView.activeTaskId}`
      : null;
  const taskPresentation = useMemo(
    () => ({
      isWebRemoteControl: props.isWebRemoteControl,
      activeWorkspaceKey: props.workspaceIdentity?.trim() || props.workspacePath,
      mobileActiveTaskKey,
      onPin: pin,
      onOpenTaskFiles: openTaskFiles,
    }),
    [
      props.isWebRemoteControl,
      props.workspacePath,
      props.workspaceIdentity,
      mobileActiveTaskKey,
      pin,
      openTaskFiles,
    ],
  );
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const start = async (projectId?: string, hostId?: string, taskGroupId?: string | null) => {
    const activeTaskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(props.workspacePath, props.workspaceIdentity).activeTaskId;
    const inheritedGroup =
      view === "grouped" && !projectId && activeTaskId
        ? (groups.parents.get(
            taskGroupKey({
              taskId: activeTaskId,
              workspacePath: props.workspacePath,
              workspaceIdentity: props.workspaceIdentity,
            }),
          ) ?? null)
        : view === "grouped" && !projectId
          ? (useZCodeSessionStore
              .getState()
              .getWorkspaceState(props.workspacePath, props.workspaceIdentity).draftTaskGroupId ??
            null)
          : null;
    props.onCreateTask({
      projectId: projectId ?? null,
      taskGroupId: taskGroupId === undefined ? inheritedGroup : taskGroupId,
      ...(hostId ? { hostId } : {}),
    });
  };
  const projects = preferences.sort(selectSortedProjects(tree));
  const expandableProjects = projects.filter(
    (project) => availability.get(projectKey(project))?.online !== false,
  );
  const hasExpandedProjects = expandableProjects.some(preferences.isExpanded);
  const reorder = (active: string, over: string) => {
    const source = projects.find((item) => projectKey(item) === active);
    const target = projects.find((item) => projectKey(item) === over);
    if (!source || !target || source.pinned !== target.pinned) return;
    preferences.reorder(
      projects.filter((item) => item.pinned === source.pinned),
      active,
      over,
    );
  };
  const renderProject = (project: VirtualProject) => (
    <ProjectSidebarNode
      key={projectKey(project)}
      project={project}
      deviceLabel={deviceNames.get(projectSourceServerId(project) ?? "")}
      remoteHost={directory.hosts.find((host) => host.id === project.hostId)}
      diagnostics={diagnostics.get(project.hostId)}
      expanded={preferences.isExpanded(project)}
      onExpandedChange={preferences.setExpanded}
      hasUnread={projectHasUnread(authoritativeTree, project)}
      availability={availability.get(projectKey(project))}
      tasks={selectProjectRows(tree, {
        kind: "project",
        projectId: project.id,
        hostId: project.hostId,
      })}
      onSelect={onSelectTask}
      refresh={refresh}
      service={service}
      remoteService={remoteService}
      isDesktop={props.isDesktop}
      isWebRemoteControl={props.isWebRemoteControl}
      onCreateTask={props.onCreateTask}
      onReconnectRemoteWorkspace={props.onReconnectRemoteWorkspace}
      onEdit={setEditor}
      onViewFiles={openFiles}
      remoteActions={remoteSync.actions}
      onOpenWorktrees={canManageWorktrees ? setWorktreeProject : undefined}
    />
  );
  const openSettings = useCallback(() => {
    tabStore.getState().openSettingsTab();
  }, [tabStore]);
  const changeLocale = useCallback(
    (value: string) => setLocalePreference(value as Locale | "system"),
    [setLocalePreference],
  );
  const changeTheme = useCallback((value: string) => setTheme(value as Theme), [setTheme]);
  const upgrade = useCallback<
    NonNullable<Parameters<typeof WorkspaceSidebarFooter>[0]["onUpgradeClick"]>
  >(
    (providerId, funnelContext) => openCodingPlanUpgrade({ providerId, funnelContext }),
    [openCodingPlanUpgrade],
  );
  const banner = useMemo(() => <SidebarBottomActivity />, []);
  // 手机远控 home-only 没有 base attachment，也就没有项目契约；改用 relay 层工作区列表与重连入口。
  const homeOnlySwitcher = service ? undefined : props.webRemoteControlWorkspaceSwitcher;
  return (
    <ProjectTaskListContext.Provider value={taskPresentation}>
      <SidebarTooltipProvider>
        <aside data-testid={TID_SIDEBAR} className="flex h-full min-h-0 flex-col overflow-hidden">
          <div
            className={`h-12 shrink-0 [app-region:drag] ${props.isWebRemoteControl ? "max-md:hidden" : ""}`}
          />
          {/* 内联改名聚焦曾把 hidden 容器横向滚动，导致手机整栏左移；滑动面板只裁切，不允许焦点滚动。 */}
          <div className="relative min-h-0 flex-1 overflow-clip">
            <div
              data-project-sidebar-panel="navigation"
              className="absolute inset-0 flex min-h-0 flex-col"
            >
              {/* 原因：顶层新建显式传 null 会抹掉当前项目；省略归属，让 Root 与快捷键共用继承路径。 */}
              <ProjectSidebarNavigation props={props} onCreate={props.onCreateTask} />
              <div
                data-testid="sidebar-task-list-region"
                className="flex min-h-0 flex-1 flex-col border-t border-border/50 pt-3 [anchor-name:--sidebar-task-list-divider]"
              >
                <ProjectSidebarListHeader
                  onOpenCommandCenter={props.onOpenCommandCenter}
                  view={view}
                  onViewChange={setView}
                  groupedActionsRef={setGroupedToolbar}
                />
                {/* 原因：仅设 overflow-y:auto 会让拖拽位移打开水平滚动；列表始终只允许纵向滚动。 */}
                {/* 原因：项目侧栏迁移后普通滚动容器遗漏边缘渐隐；复用统一 mask，随实际滚动边界更新。 */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div ref={setGroupedSticky} />
                  <ScrollFadeViewport ref={scrollRef} className="overflow-x-hidden">
                    <div className="flex flex-col gap-3 pb-3">
                      {homeOnlySwitcher ? (
                        <HomeOnlyWorkspaceRows switcher={homeOnlySwitcher} />
                      ) : view === "projects" ? (
                        <>
                          <ProjectTaskRows
                            kind="pinned"
                            tasks={selectProjectRows(tree, { kind: "pinned" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                          <SortableProjects
                            projects={projects.filter((project) => project.pinned)}
                            renderProject={renderProject}
                            onReorder={reorder}
                          />
                          <ProjectSections
                            tree={tree}
                            projects={projects}
                            directory={directory}
                            renderProject={renderProject}
                            onReorder={reorder}
                            loading={loading}
                            onSelect={onSelectTask}
                            refresh={refresh}
                            onCreate={() => action(() => start())}
                            onAddProject={() => setCreating(true)}
                            hasExpandedProjects={hasExpandedProjects}
                            canToggleProjects={expandableProjects.length > 0}
                            onToggleProjects={() =>
                              preferences.setAllExpanded(expandableProjects, !hasExpandedProjects)
                            }
                          />
                        </>
                      ) : view === "grouped" ? (
                        <>
                          <ProjectTaskRows
                            kind="pinned"
                            tasks={selectProjectRows(tree, { kind: "pinned" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                          <TaskGroupedView
                            tasks={tree.tasks}
                            onSelect={onSelectTask}
                            refresh={refresh}
                            scrollRef={scrollRef}
                            toolbarTarget={groupedToolbar}
                            stickyTarget={groupedSticky}
                            workspacePath={props.workspacePath}
                            workspaceIdentity={props.workspaceIdentity}
                            onOpenAutomations={props.onOpenAutomations}
                            onCreate={(groupId) =>
                              action(() => start(undefined, undefined, groupId))
                            }
                          />
                        </>
                      ) : (
                        <ProjectTaskRows
                          key={view}
                          kind={view}
                          tasks={selectProjectRows(view === "unread" ? authoritativeTree : tree, {
                            kind: view,
                          })}
                          onSelect={onSelectTask}
                          refresh={refresh}
                        />
                      )}
                      {loading && !homeOnlySwitcher ? (
                        <p className="px-4 text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({ id: "common.loading" })}
                        </p>
                      ) : null}
                      {error && !homeOnlySwitcher ? (
                        <p role="alert" className="px-4 text-ui-sm text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  </ScrollFadeViewport>
                </div>
              </div>
              <WorkspaceSidebarFooter
                className="pr-3"
                theme={props.theme}
                localeMenuValue={localePreference}
                onLocaleChange={changeLocale}
                onThemeChange={changeTheme}
                onSettingsButtonClick={openSettings}
                onUsageClick={openSettings}
                onUpgradeClick={upgrade}
                onLogin={props.onLogin}
                onLogout={props.onLogout}
                user={props.user}
                workspacePath={props.workspacePath}
                // 项目侧栏不再从 tab 反推身份；远控入口必须沿用当前 attachment 的精确 scope。
                workspaceIdentity={props.workspaceIdentity}
                workspaceRemoteSessionId={props.workspaceRemoteSessionId}
                isDesktop={props.isDesktop}
                banner={banner}
              />
            </div>
          </div>
          {creating && service && remoteService ? (
            <ProjectCreation
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              onCreateTask={props.onCreateTask}
              directory={directory}
              defaultDeviceId={
                hasActiveRemoteTask && props.workspaceIdentity
                  ? (remoteHostIdFromWorkspaceIdentity(props.workspaceIdentity) ?? "local")
                  : "local"
              }
              allowDeviceManagement={props.isDesktop === true}
              projects={tree.projects}
              service={service}
              remoteService={remoteService}
              onOpenRemoteWorkspace={props.onOpenRemoteWorkspace}
              onClose={() => setCreating(false)}
              onSaved={refresh}
            />
          ) : null}
          {remotePicker && service && remoteService ? (
            <RemoteProjectPicker
              key={remotePicker.membershipId}
              host={remotePicker}
              service={service}
              remoteService={remoteService}
              onClose={() => setRemotePicker(null)}
              onSaved={refresh}
            />
          ) : null}
          {editor && service ? (
            <ProjectEditor
              key={editor.project?.id ?? "new"}
              project={editor.project}
              host={directory.hosts.find((host) => host.id === editor.project?.hostId)}
              projects={tree.projects.filter(
                (project) => !availability.get(projectKey(project))?.entryId,
              )}
              service={service}
              onClose={() => setEditor(null)}
              onSaved={refresh}
              onDeleted={refresh}
            />
          ) : null}
          {worktreeProject && managedWorktreeService ? (
            <ManagedWorktreesDialog
              key={projectKey(worktreeProject)}
              project={worktreeProject}
              service={managedWorktreeService}
              onClose={() => setWorktreeProject(null)}
              onOpenTask={onSelectTask}
            />
          ) : null}
          {remoteSync.dialog}
        </aside>
      </SidebarTooltipProvider>
    </ProjectTaskListContext.Provider>
  );
});

export { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
