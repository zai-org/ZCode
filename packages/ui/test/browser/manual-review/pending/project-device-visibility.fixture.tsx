import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import type { IBroadcastService, VirtualProject } from "@zcode/services";
import { createZCodeStore } from "@/store/index.js";
import { StoreContext, useZCodeStore } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ProjectSidebarNode } from "@/project-sidebar/ProjectSidebarNode.js";
import { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { projectKey } from "@/project-sidebar/view.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const mobile = query.get("mobile") === "1";
const local = query.get("local") === "1";
const theme = query.get("theme") ?? "light";
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const channel = new BroadcastChannel("project-device-preference-fixture");
const broadcast: IBroadcastService = {
  send: async (message) => channel.postMessage(message),
  onMessage(listener) {
    const receive = (event: MessageEvent) => listener(event.data);
    channel.addEventListener("message", receive);
    return { dispose: () => channel.removeEventListener("message", receive) };
  },
  acquireClaim: async () => ({ status: "unavailable" }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => false,
};
const store = createZCodeStore(broadcast);
document.documentElement.className = `${theme} theme-zai-${theme}`;
const rows = (["online", "offline", "needs-upgrade"] as const).map((state, i) => {
  const project: VirtualProject = {
    id: state,
    hostId: local ? "local" : `remote:server:${state}`,
    name: "Project",
    roots: [{ rootPath: `/work/${state}`, position: 0, isPrimary: true }],
    deleted: false,
    pinned: i === 0,
    nameOverridden: true,
    position: i,
    createdAt: 1,
    updatedAt: 1,
  };
  const host: NonNullable<ProjectNodeProps["remoteHost"]> = {
    id: project.hostId,
    membershipId: state,
    kind: "ssh",
    target: { kind: "ssh", host: `${state}.example.com`, username: "dev", port: 22 },
    connectionStatus: state === "online" ? "online" : "offline",
    lastConnectionStatus: state,
    position: i,
  };
  return { project, host, availability: { online: local || state === "online", entryId: state } };
});
const noop = () => {};
const refresh = async () => {};
const management = {
  getSnapshot: async () => ({
    generation: 1,
    profiles: [],
    servers: [],
    states: [],
    workspaceHistory: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  }),
  onDidChangeState: new Emitter().event,
};
// 只替换外部目录与连接数据；设置、store、项目装配、行、详情和菜单使用生产组件。
Object.assign(window, {
  __projectDeviceDirectory: {
    tree: { projects: rows.map((row) => row.project), tasks: [] },
    projects: rows.map((row) => row.project),
    availability: new Map(rows.map((row) => [projectKey(row.project), row.availability])),
    directory: { hosts: local ? [] : rows.map((row) => row.host) },
    deviceNames: new Map(rows.map((row) => [row.project.id, `Device ${row.project.id}`])),
    loading: false,
    error: null,
    service: {},
    remoteService: {},
    refresh,
  },
});
function Fixture() {
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const hidden = useZCodeStore((state) => state.hideProjectDeviceNames);
  const setHidden = useZCodeStore((state) => state.setHideProjectDeviceNames);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="w-64 max-w-full bg-sidebar" aria-label="Projects">
        {rows.map(({ project, host, availability }) => (
          <div key={project.id} data-fixture-project={project.id}>
            <ProjectSidebarNode
              project={project}
              remoteHost={local ? undefined : host}
              deviceLabel={local ? undefined : `Device ${project.id}`}
              isDesktop={!mobile}
              isWebRemoteControl={mobile}
              availability={availability}
              hasUnread
              tasks={[]}
              expanded={expandedProjects.includes(project.id)}
              onExpandedChange={(expanded) =>
                setExpandedProjects((current) =>
                  expanded ? [...current, project.id] : current.filter((id) => id !== project.id),
                )
              }
              onEdit={noop}
              onViewFiles={refresh}
              onCreateTask={noop}
              onReconnectRemoteWorkspace={refresh}
              onSelect={noop}
              refresh={refresh}
              remoteActions={() => []}
            />
          </div>
        ))}
      </section>
      <section className="mt-6 max-w-xl" aria-label="Remote settings">
        <SourceServerManagementPanel
          management={management as never}
          hideProjectDeviceNames={hidden}
          onHideProjectDeviceNamesChange={setHidden}
        />
      </section>
      <ProjectComposerMenu
        workspacePath="/work/online"
        compactForRemoteControl={mobile}
        onCreateTask={noop}
        onSelectConversationWorkspace={noop}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StoreContext.Provider value={store}>
    <ServiceProvider services={{} as never}>
      <ZCodeIntlProvider initialLocale={locale}>
        <TooltipProvider>
          <TabStoreProvider>
            <Fixture />
          </TabStoreProvider>
        </TooltipProvider>
      </ZCodeIntlProvider>
    </ServiceProvider>
  </StoreContext.Provider>,
);
