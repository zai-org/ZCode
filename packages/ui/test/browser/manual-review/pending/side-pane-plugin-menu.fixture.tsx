import { PlatformProvider } from "@/hooks/usePlatform.js";
import { parseClientConfigSnapshot, type IPlatformService } from "@zcode/shared";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PluginUiWorkspaceProvider, openPluginUiSidePane } from "@/plugin-ui/index.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import {
  activateNewTabSidePane,
  stampSidePaneTabsOwnership,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { PanelImperativeHandle } from "react-resizable-panels";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.add(`theme-zai-${params.get("theme") ?? "light"}`);
const workspacePath = "/workspace/example";
const workspaceIdentity = "fixture-workspace";
const remoteSessionId = undefined;
const noop = () => {};
const readCatalog = async () => (await fetch("/catalog")).json();
const mutatePlugin = async (path: string, input: unknown) => {
  const response = await fetch(path, { method: "POST", body: JSON.stringify(input) });
  if (!response.ok) throw new Error("plugin operation failed");
  return response.json();
};
const services = (params.has("noBridge")
  ? {}
  : {
      pluginManagementService: {
        listPlugins: readCatalog,
        getPluginsOverview: readCatalog,
        installPlugin: (input: unknown) => mutatePlugin("/install", input),
        setPluginEnabled: (input: unknown) => mutatePlugin("/enable", input),
      },
      skillsService: {},
      clientConfigService: {
        getSnapshot: async () => {
          const response = await fetch("/client-config");
          if (!response.ok) throw new Error("config unavailable");
          return parseClientConfigSnapshot(await response.json());
        },
      },
      pluginUiBridgeService: {
        listSurfaces: async (scope: unknown) => {
          const response = await fetch("/surfaces", {
            method: "POST",
            body: JSON.stringify(scope),
          });
          return response.json();
        },
      },
    }) as unknown as IServiceAccessor;
const existingTab: WorkspaceSidePaneState = {
  activeTabId: "whiteboard:fixture",
  tabs: [
    {
      id: "whiteboard:fixture",
      type: "whiteboard",
      boardId: "fixture",
      title: "Existing",
      ownerTaskId: params.has("draft") ? null : "session-fixture",
    },
  ],
};

function Fixture() {
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    // 当前产品由面板 owner 在首次展开时创建 new-tab；夹具也提供相同的入口状态。
    () =>
      params.has("existing")
        ? existingTab
        : stampSidePaneTabsOwnership(activateNewTabSidePane(null), {
            workspaceKey: workspaceIdentity,
            ownerTaskId: params.has("draft") ? null : "session-fixture",
          }),
  );
  const [request, setRequest] = useState<OpenPluginUiSideTabRequest | null>(null);
  const [opened, setOpened] = useState<WorkspaceSidePaneState | null>(null);
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  // 本测试在 tab owner 边界验收命令与去重；沙箱/Agent 不属于启动页交互回归。
  const open = (next: OpenPluginUiSideTabRequest) => {
    setRequest(next);
    setOpened((current) =>
      openPluginUiSidePane(current, { ...next, workspaceKey: workspaceIdentity }),
    );
  };
  const panel = (
    <AnimatedSidePanePanel
      services={services}
      isVisible={!params.has("hidden")}
      isDesktop={!params.has("mobile")}
      mobileOverlay={params.has("mobile")}
      mobileStacked={params.has("stacked")}
      fullView={
        params.has("fullView")
          ? { surface: "side-pane", conversationTitle: "Conversation", onSelectSurface: noop }
          : null
      }
      screenshotSurfaceRequest={
        params.has("screenshot")
          ? {
              requestId: "fixture-screenshot",
              webContentsId: 1,
              viewport: { width: 1280, height: 720 },
              workspaceKey: workspaceIdentity,
              sessionId: "session-fixture",
              tabId: "browser-fixture",
              browserId: "browser-fixture",
              browserGeneration: 1,
            }
          : null
      }
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={[]}
      isBrowserOpen={false}
      supportsEmbeddedBrowser={false}
      workspaceAbsPath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={remoteSessionId}
      activeTaskId={params.has("draft") ? null : "session-fixture"}
      sidePaneOwnerId={params.has("draft") ? null : "session-fixture"}
      gitState={{} as Parameters<typeof AnimatedSidePanePanel>[0]["gitState"]}
      activeGitSourceId="unstaged"
      panelRef={panelRef}
      panelElementRef={panelElementRef}
      browserNavigationRequest={null}
      browserRestoreUrls={{}}
      fileChangeFindActiveIndex={0}
      fileChangeFindNavigationRequestId={0}
      fileChangeFindQuery=""
      onFileChangeFindMatchCountChange={noop}
      onCloseCodeViewer={noop}
      onCloseGit={noop}
      onActivateTab={(id) =>
        setSidePaneState((current) => (current ? { ...current, activeTabId: id } : current))
      }
      onOpenNewTab={() =>
        setSidePaneState((current) =>
          stampSidePaneTabsOwnership(activateNewTabSidePane(current), {
            workspaceKey: workspaceIdentity,
            ownerTaskId: params.has("draft") ? null : "session-fixture",
          }),
        )
      }
      onReorderTab={noop}
      onCloseTab={noop}
      onCloseOtherTabs={noop}
      onCloseAllTabs={noop}
      onReopenClosedTab={noop}
      onOpenBrowserTab={noop}
      onOpenWhiteboard={noop}
      onOpenDeveloperTools={noop}
      onOpenPluginMarket={noop}
      onOpenTerminalTab={noop}
      onOpenReviewTab={noop}
      onOpenSelectionSideConversation={noop}
      onOpenBrowserUrl={noop}
      onOpenCodeViewer={noop}
      onOpenSubagentSession={noop}
      onRefreshGit={noop}
      onBrowserNavigationRequestHandled={noop}
      onBrowserUrlChange={noop}
      onBrowserPageMetadataChange={noop}
      onSelectGitSource={noop}
    />
  );
  return (
    <main className="h-screen min-w-0 bg-background text-foreground">
      <button data-testid="show-tabs" onClick={() => setSidePaneState(existingTab)}>
        Show existing tab
      </button>
      <output data-testid="request" hidden>
        {JSON.stringify(request)}
      </output>
      <output data-testid="opened" hidden>
        {JSON.stringify(opened)}
      </output>
      <div data-testid="panel-fixture" className="h-5/6 min-w-0">
        {params.has("mobile") ? (
          renderPanel()
        ) : (
          <ResizablePanelGroup layoutId="plugin-menu-fixture" orientation="horizontal">
            <ResizablePanel defaultSize={40}>
              <div />
            </ResizablePanel>
            {renderPanel()}
          </ResizablePanelGroup>
        )}
      </div>
    </main>
  );
  function renderPanel() {
    return params.has("noHost") ? (
      panel
    ) : (
      <PlatformProvider platform={{ pluginSandbox: {} } as IPlatformService}>
        <PluginUiWorkspaceProvider onOpenSidePane={open}>{panel}</PluginUiWorkspaceProvider>
      </PlatformProvider>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
