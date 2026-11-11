import { useCallback, useState } from "react";
import { Event, ProxyChannel } from "@zcode/rpc";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { WorkspaceHeaderTitleSection } from "@/WorkspaceHeaderSections.js";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  ProjectDirectoryProvider,
  ProjectSidebar,
  useOptionalProjectDirectory,
  useOptionalProjectDirectoryActions,
  ProjectComposerMenu,
} from "@/project-sidebar/index.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ProjectTree, ProjectSidebarProps } from "@/project-sidebar/contract.js";
import type { IServiceAccessor } from "@zcode/services";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const mobile = params.get("mobile") === "1";
const activity = params.get("activity") === "1";
const expansion = params.get("expansion") === "1";
const boundaries = params.get("boundaries") === "1";
const tooltips = params.get("tooltips") === "1";
const sessionSwitch = params.get("sessionSwitch") === "1";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const noop = () => {};
const activate = () => true;
const dispose = () => ({ dispose: noop });
const tree: ProjectTree = {
  projects: Array.from({ length: 44 }, (_, index) => ({
    id: `p${index}`,
    hostId: "local",
    name: `Project ${index}`,
    roots:
      tooltips || sessionSwitch ? [{ rootPath: "/example", position: 0, isPrimary: true }] : [],
    pinned: false,
    deleted: false,
    position: index,
    createdAt: 1,
    updatedAt: 1,
    nameOverridden: true,
  })),
  tasks: activity
    ? [
        {
          taskId: "running-task",
          traceId: "running-task",
          mode: "build",
          workspacePath: "/example",
          hostId: "local",
          projectId: "p0",
          title: "Running task",
          createdAt: 1,
          updatedAt: 1,
          pinned: false,
          archived: false,
        },
      ]
    : [],
};
if (expansion)
  tree.tasks.push(
    ...Array.from({ length: 5 }, (_, index) => ({
      taskId: `expansion-task-${index}`,
      traceId: `expansion-task-${index}`,
      mode: "build" as const,
      workspacePath: "/example",
      hostId: "local",
      projectId: "p0",
      title: `Expansion task ${index}`,
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
    })),
  );
if (sessionSwitch)
  tree.tasks.push(
    ...Array.from({ length: 4 }, (_, index) => ({
      taskId: index === 3 ? "switch-0" : `switch-${index}`,
      traceId: `switch-${index}`,
      mode: "build" as const,
      workspacePath: index === 3 ? "/other" : "/example",
      hostId: "local",
      projectId: index === 3 ? "p1" : "p0",
      title: `Switch task ${index}`,
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
    })),
  );
if (boundaries)
  tree.tasks.push(
    ...Array.from({ length: 8 }, (_, index) => ({
      ...tree.tasks[0]!,
      taskId: `unrelated-${index}`,
      title: `Unrelated ${index}`,
      projectId: null,
    })),
  );
let activitySnapshot = {
  items: activity
    ? [
        attachTaskListRowActivity(tree.tasks[0]!, {
          phase: "running",
          lastActivityAt: 1,
          hasBackgroundWork: false,
        }),
      ]
    : [],
};
const activityListeners = new Set<() => void>();
const activityStore = {
  getSnapshot: () => activitySnapshot,
  subscribe: (listener: () => void) => {
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  },
  update: (complete = false) => {
    activitySnapshot = {
      items: [
        attachTaskListRowActivity(tree.tasks[0]!, {
          phase: complete ? "completedSuccess" : "running",
          lastActivityAt: activitySnapshot.items[0]!.__zcodeSessionActivity.lastActivityAt + 1,
          hasBackgroundWork: false,
        }),
      ],
    };
    activityListeners.forEach((listener) => listener());
  },
};
const tabState = {
  tabs: [],
  activeWorkspacePath: "/example",
  activeWorkspaceIdentity: null,
  openSettingsTab: noop,
};
const tabStore = { getState: () => tabState, subscribe: () => noop };
const remoteDirectory = {
  hosts: [
    {
      id: "remote:server:header-host",
      kind: "ssh",
      target: { kind: "ssh", host: "original.example.com", username: "dev", port: 22 },
      connectionStatus: "offline",
      position: 0,
    },
  ],
  entries: [],
};
const services = {
  credentialService: ProxyChannel.toService({
    call: async <T,>() => null as T,
    listen: () => Event.None,
  }),
  settingService: { get: async () => ({}), update: async () => {} },
  projectService: {
    readTree: async () => structuredClone(tree),
    saveProject: async (input: { id: string; pinned: boolean }) => {
      tree.projects.find((project) => project.id === input.id)!.pinned = input.pinned;
    },
    prepareSession: async () => ({
      workspacePath: "/example",
      projectId: null,
      additionalDirectories: [],
    }),
  },
  remoteProjectService: {
    readDirectory: async () =>
      expansion ? structuredClone(remoteDirectory) : { hosts: [], entries: [] },
  },
  broadcastService: { onMessage: dispose },
  zcodeTaskService: {
    onDynamicWorkspaceEvent: () => dispose,
    getTaskSessionFilePath: async () => ({ path: null, exists: false }),
    getTaskNativeSessionLogFile: async () => ({ path: null, exists: false }),
    getWorkspaceProviderConfigFile: async () => ({ path: null, exists: false }),
  },
} as unknown as IServiceAccessor;
Object.assign(window, { __renderFixture: { services, tabStore, activityStore } });
useZCodeSessionStore.getState().setActiveTaskId("/example", sessionSwitch ? null : "old-session");
const common = {
  workspacePath: "/example",
  theme,
  isDesktop: !mobile,
  isWebRemoteControl: mobile,
  onSelectTask: (...args: unknown[]) => {
    Object.assign(window, { __selectedTask: args });
    if (sessionSwitch)
      useZCodeSessionStore.getState().setActiveTaskId(args[0] as string, args[1] as string);
  },
  onStartDraftInWorkspace: noop,
  onOpenFolderFromWorkspaceMenu: noop,
  onConnectRemote: async () => "remote",
  onSelectRemoteProject: async () => {},
  onCancelRemoteProject: async () => {},
  onReconnectRemoteWorkspace: async () => {},
  reconnectingRemoteWorkspaceKeys: [],
  remoteWorkspaceErrorByWorkspaceKey: {},
  onOpenCommandCenter: noop,
} satisfies Omit<ProjectSidebarProps, "onCreateTask" | "onCreateConversationTask">;
const actions = {
  intl: { formatMessage: ({ id }: { id: string }) => id } as never,
  platform: {
    onRemoteConnectionLog: () => noop,
    onRemoteSessionClosed: () => noop,
    onRemoteSessionReconnected: () => noop,
  } as never,
  services,
  tabStoreApi: tabStore as never,
  addTab: () => "/example",
  activeWorkspacePath: "/example",
  activeWorkspaceIdentity: null,
  supportsSettings: true,
  allowOpenWorkspace: true,
  preferDirectoryBrowser: false,
  refreshProviderState: async () => {},
  updateAppSettings: async () => {},
  setOAuthError: noop,
  setUser: noop,
  workbenchGroupClientMode: mobile
    ? ("web-remote-replayable" as const)
    : ("desktop-continuous" as const),
  // 手机 bridge 只模拟导航完成；Renderer 仍走实际 replayable 分支。
  openMobileProjectDraft: async () => {
    useZCodeSessionStore.getState().startDraft("/example");
  },
};
function Controls() {
  const directory = useOptionalProjectDirectory()!;
  const [refreshes, setRefreshes] = useState(0);
  const taskActivity = (
    directory.tree.tasks[0] as (typeof activitySnapshot.items)[number] | undefined
  )?.__zcodeSessionActivity;
  return (
    <>
      {activity && (
        <>
          <ChatLoading
            data-testid="fixture-chat-loading"
            loading={taskActivity?.phase === "running"}
          />
          <button
            data-testid="activate-task"
            onClick={() =>
              useZCodeSessionStore.getState().setActiveTaskId("/example", "running-task")
            }
          >
            Activate task
          </button>
          <button data-testid="activity-tick" onClick={() => activityStore.update()}>
            Tick
          </button>
          <button data-testid="activity-complete" onClick={() => activityStore.update(true)}>
            Complete
          </button>
          <button
            data-testid="change-task"
            onClick={async () => {
              tree.tasks[0] = { ...tree.tasks[0]!, title: "Renamed task", unreadAt: 100 };
              await directory.refresh();
            }}
          >
            Change task
          </button>
          <output data-testid="activity-version">
            {
              (directory.tree.tasks[0] as (typeof activitySnapshot.items)[number])
                ?.__zcodeSessionActivity?.lastActivityAt
            }
          </output>
        </>
      )}
      <button
        data-testid="change-header-device"
        onClick={() => {
          remoteDirectory.hosts[0]!.target.host = "updated.example.com";
          void directory.refresh();
        }}
      >
        Change header device
      </button>
      <button
        data-testid="refresh-directory"
        onClick={async () => {
          await directory.refresh();
          setRefreshes((value) => value + 1);
        }}
      >
        Refresh
      </button>
      <output data-testid="refresh-count">{refreshes}</output>
      <button
        data-testid="rename-project"
        onClick={() => {
          tree.projects[0]!.name = "Renamed project";
          void directory.refresh();
        }}
      >
        Rename
      </button>
    </>
  );
}
function DirectoryCommandConsumer() {
  useOptionalProjectDirectoryActions();
  return null;
}
function Fixture() {
  const [revision, setRevision] = useState(0);
  const [fileRevision, setFileRevision] = useState(0);
  const openFiles = useCallback(
    (target: unknown) => Object.assign(window, { __openedFiles: { target, fileRevision } }),
    [fileRevision],
  );
  const [headerTitle, setHeaderTitle] = useState("Existing session");
  const [navigationPage, setNavigationPage] = useState("chat");
  const openAutomations = useCallback(() => setNavigationPage("automations"), []);
  const openPlugins = useCallback(() => setNavigationPage("plugins"), []);
  const task = useZCodeSessionStore((state) => state.workspaces["/example"]?.activeTaskId);
  // 模拟 Root 每轮装配导航实现；执行和侧栏均使用真实生产 hook/组件。
  const remote = useRemoteWorkspaceHistory({
    intl: actions.intl,
    services,
    platform: actions.platform,
    supportsSettings: false,
    isDesktop: !mobile,
    allowRemoteWorkspace: false,
    tabStoreApi: actions.tabStoreApi,
    activateTabByPath: activate,
    addTab: noop,
  });
  const navigation = useRootWorkspaceActions({
    ...actions,
    openRemoteProjectWorkspace: async () => {},
  });
  return (
    <ProjectDirectoryProvider isDesktop={!mobile}>
      <div className="flex h-screen bg-background text-foreground">
        <div className="w-64 shrink-0 bg-sidebar">
          <ProjectSidebar
            {...common}
            canGoBack={sessionSwitch ? Boolean(task) : undefined}
            onOpenFileManager={sessionSwitch ? openFiles : undefined}
            onCreateTask={navigation.handleCreateTask}
            onCreateConversationTask={navigation.handleCreateConversationTask}
            onSelectRemoteProject={remote.handleSelectRemoteProject}
            onReconnectRemoteWorkspace={remote.handleReconnectRemoteWorkspace}
            onOpenAutomations={openAutomations}
            automationsActive={navigationPage === "automations"}
            onOpenPluginStore={openPlugins}
            pluginStoreActive={navigationPage === "plugins"}
          />
        </div>
        <main className="min-w-0 p-2 text-ui-sm">
          {expansion && (
            <>
              <WorkspaceHeaderTitleSection
                workspaceAbsPath="/example"
                workspaceIdentity={
                  mobile
                    ? buildRemoteHostWorkspaceIdentity("remote:server:header-host", "/example")
                    : undefined
                }
                isWebRemoteControl={mobile}
                projectName="Project 0"
                activeTaskTitle={headerTitle}
                activeTaskId="old-session"
                activeTraceId={null}
                activeSessionId={null}
                activeTaskProvider={null}
                gitSummary={{
                  workspacePath: "/example",
                  repoRoot: "",
                  workspaceInRepoPath: "",
                  autoRefreshWatchPaths: [],
                  branchName: null,
                  trackingBranchName: null,
                  headRefType: "branch",
                  ahead: 0,
                  behind: 0,
                  isDirty: false,
                  isGitAvailable: false,
                  isRepository: false,
                }}
                gitDirtyFileCount={0}
                sessionLogPath={null}
                nativeSessionLogProvider={null}
                nativeSessionLogPath={null}
                nativeSessionLogExists={false}
                nativeSessionLogLoading={false}
                providerWorkspaceConfigPath={null}
                providerWorkspaceConfigExists={false}
                providerWorkspaceConfigLoading={false}
                onRefreshGit={noop}
                workspaceHeaderState={{ selectedProvider: "glm" }}
                selectedEditor={null}
              />
              <button data-testid="rename-header" onClick={() => setHeaderTitle("Renamed session")}>
                Rename session
              </button>
            </>
          )}
          <output data-testid="current-task">{task ?? "draft"}</output>
          <button data-testid="shell-update" onClick={() => setRevision(revision + 1)}>
            Update {revision}
          </button>
          <Controls />
          {sessionSwitch && (
            <button
              data-testid="replace-file-handler"
              onClick={() => setFileRevision((n) => n + 1)}
            >
              Replace file handler
            </button>
          )}
          {boundaries && (
            <>
              <DirectoryCommandConsumer />
              <ProjectComposerMenu
                workspacePath="/example"
                onCreateTask={noop}
                onSelectConversationWorkspace={noop}
              />
            </>
          )}
        </main>
      </div>
    </ProjectDirectoryProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <TooltipProvider>
      {params.get("spinner") === "1" ? (
        <Spinner className="size-5 text-foreground-subtle" />
      ) : (
        // 侧栏新增 worktree 创建行后会读取全局服务，夹具必须提供同一份服务上下文。
        <ServiceProvider services={services as never}>
          <Fixture />
        </ServiceProvider>
      )}
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
