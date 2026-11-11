import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createPluginUiInteractions } from "@/plugin-ui/adapters/pluginUiInteractions.js";
import { usePluginUiResourceDeltaFeed } from "@/plugin-ui/adapters/pluginUiResourceDeltaFeed.js";
import { usePluginUiHost } from "@/plugin-ui/adapters/usePluginUiHost.js";
import {
  getPluginUiSurfaceFeed,
  offerPluginUiSurfaceFeed,
} from "@/plugin-ui/app/pluginUiSurfaceFeedStore.js";
import { claimPluginUiSurface } from "@/plugin-ui/app/pluginUiSurfaceStore.js";
import {
  deliverOfficeViewerDocumentIfReady,
  subscribeOfficeViewerPendingOpen,
} from "@/plugin-ui/officeViewerOpen.js";
import type {
  PluginUiPresentation,
  PluginUiSessionScope,
  PluginUiSidePaneTab,
  PluginUiSidePaneViewProps,
} from "@/plugin-ui/contract.js";
import { PLUGIN_UI_SIDE_PANE_TITLE_BAR, buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { resolveSidePaneDisplayModeRequest } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import {
  EMPTY_PLUGIN_UI_SURFACE_FEED,
  buildPluginUiToolResult,
  findToolRowById,
  isPluginUiToolCancelled,
  readPluginUiToolInput,
  reducePluginUiSurfaceFeed,
} from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import type { McpAppsDisplayMode, PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";

const FULLSCREEN_ONLY: readonly McpAppsDisplayMode[] = ["fullscreen"];
const INLINE_AND_FULLSCREEN: readonly McpAppsDisplayMode[] = ["inline", "fullscreen"];

export function usePluginUiSidePaneModel({
  tab,
  visible,
  scopeRef,
  onOpenBrowserUrl,
  onCloseTab,
}: {
  tab: PluginUiSidePaneTab;
  visible: boolean;
  scopeRef: PluginUiScopeRef;
  onOpenBrowserUrl?: (url: string) => void;
  onCloseTab?: (tabId: string) => void;
}): PluginUiSidePaneViewProps {
  const { intl, locale } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");

  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  // 4b-2 R4：侧栏不在 SessionPane 树内，自己把会话投影的资源通知接到路由表（按 store 引用计数，不重复投递）。
  const feedScope = useMemo<PluginUiSessionScope>(
    () => ({
      workspacePath: tab.workspacePath,
      remoteSessionId: tab.remoteSessionId,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      sessionId: tab.parentSessionId,
    }),
    [tab.parentSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  usePluginUiResourceDeltaFeed(lease?.store, feedScope);

  const surfaceKey = buildPluginUiSurfaceKey({ ...tab, sessionId: tab.parentSessionId }, scopeRef);

  const rows = state.snapshot?.rows.window ?? null;
  // 工具卡片 tab：投喂本行。
  const row = useMemo(
    () =>
      scopeRef.kind === "toolCall" && rows ? findToolRowById(rows, scopeRef.toolCallId) : null,
    [rows, scopeRef],
  );
  const toolCall = useMemo(() => (row ? toolCallRowToLegacyNode(row).toolCall : null), [row]);
  const rowPresentation = useMemo(
    () => (toolCall ? readPluginUiPresentation(toolCall.raw) : null),
    [toolCall],
  );
  // 面板 tab（H06）：投喂"最后一次成功结果"快照，由投影窗口归约、合并进 renderer 内存 store；
  // 最新一行 running / failed 不覆盖上一份好结果，窗口裁掉旧行后快照仍在。归约是纯函数，读 store 在渲染期无副作用。
  const feed = useMemo(
    () =>
      scopeRef.kind === "surface"
        ? reducePluginUiSurfaceFeed(
            getPluginUiSurfaceFeed(surfaceKey),
            rows ?? [],
            scopeRef.surfaceId,
            tab.pluginId,
            { serverName: tab.serverName, resourceUri: tab.resourceUri },
          )
        : EMPTY_PLUGIN_UI_SURFACE_FEED,
    [rows, scopeRef, surfaceKey, tab.pluginId, tab.serverName, tab.resourceUri],
  );
  useEffect(() => {
    if (scopeRef.kind === "surface") offerPluginUiSurfaceFeed(surfaceKey, feed);
  }, [feed, scopeRef.kind, surfaceKey]);
  // 面板的呈现信息来自 tab（清单入口），不随工具行变化；工具卡片 tab 仍以行上的 display.ui 为准。
  const presentation = useMemo<PluginUiPresentation | null>(() => {
    if (scopeRef.kind === "toolCall") return rowPresentation;
    return tab.serverName
      ? {
          serverName: tab.serverName,
          pluginId: tab.pluginId,
          resourceUri: tab.resourceUri,
          // surface 的 tab 只有路由身份；展示选择沿用最后一次成功结果，不能在开侧栏时丢失。
          preferredDisplayMode: feed.result?.presentation.preferredDisplayMode,
        }
      : null;
  }, [rowPresentation, scopeRef.kind, tab.pluginId, tab.resourceUri, tab.serverName, feed.result]);
  const placementKey = buildPluginUiSurfaceKey(
    { ...tab, sessionId: tab.parentSessionId },
    resolvePluginUiLogicalScope(presentation ?? {}, scopeRef),
  );
  useEffect(() => claimPluginUiSurface(placementKey, "side-pane"), [placementKey]);
  const toolInput = useMemo(
    () => (scopeRef.kind === "surface" ? feed.latest?.input : readPluginUiToolInput(toolCall)),
    [feed.latest, scopeRef.kind, toolCall],
  );
  const toolResult = useMemo(
    () =>
      scopeRef.kind === "surface"
        ? feed.result?.toolResult
        : buildPluginUiToolResult(toolCall, rowPresentation),
    [feed.result, rowPresentation, scopeRef.kind, toolCall],
  );
  const toolCallId = scopeRef.kind === "surface" ? feed.latest?.toolCallId : scopeRef.toolCallId;
  const toolCancelled =
    scopeRef.kind === "surface"
      ? feed.latest?.status === "cancelled"
      : isPluginUiToolCancelled(toolCall);
  // H10：只有该作用域在会话流里仍有内联卡片可接管（行在投影窗口内）且宿主给了关闭入口，才能回 inline。
  const canReturnInline =
    Boolean(onCloseTab) && (scopeRef.kind === "surface" ? feed.latest !== null : row !== null);
  const handleDisplayModeRequest = useCallback(
    (mode: McpAppsDisplayMode) => {
      const resolved = resolveSidePaneDisplayModeRequest(mode, canReturnInline);
      if (resolved === "inline") onCloseTab?.(tab.id);
      return resolved;
    },
    [canReturnInline, onCloseTab, tab.id],
  );
  const [width, setWidth] = useState(0);
  const interactions = useMemo(
    () =>
      createPluginUiInteractions({
        workspacePath: tab.workspacePath,
        remoteSessionId: tab.remoteSessionId,
        workspaceIdentity: tab.workspaceIdentity,
        sessionId: tab.parentSessionId,
        pluginId: tab.pluginId,
        scope: scopeRef,
      }),
    [
      scopeRef,
      tab.parentSessionId,
      tab.pluginId,
      tab.workspacePath,
      tab.workspaceIdentity,
      tab.remoteSessionId,
    ],
  );
  // widgetState 初值由 usePluginUiHost 按同一 surfaceKey 从宿主内存 store 读取（4a-0），面板不另取。
  const host = usePluginUiHost({
    presentation: presentation ?? {
      serverName: "",
      pluginId: tab.pluginId,
      resourceUri: tab.resourceUri,
    },
    scope: {
      workspacePath: tab.workspacePath,
      remoteSessionId: tab.remoteSessionId ?? undefined,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      sessionId: tab.parentSessionId,
      scope: scopeRef,
    },
    theme: resolveTheme(theme),
    locale,
    displayMode: "fullscreen",
    toolInput,
    toolResult,
    toolCallId,
    toolCancelled,
    hostVersion: "zcode",
    availableDisplayModes: canReturnInline ? INLINE_AND_FULLSCREEN : FULLSCREEN_ONLY,
    onDisplayModeRequest: handleDisplayModeRequest,
    onOpenExternal: onOpenBrowserUrl,
    width,
    titleBar: PLUGIN_UI_SIDE_PANE_TITLE_BAR,
    interactions,
    // 启动屏障（H07）：工具卡片 tab 要等本行进投影（rowPresentation 才有 serverName，否则 prepareSandbox 被参数校验拒绝，
    // 而 identity 不变导致 controller 之后也不会重启）；面板 tab 要等投影快照到达（rows 非 null），
    // 否则第一次 setWidgetData 没有 toolInput / toolResult，页面先空渲染一次再收通知。
    enabled: presentation !== null && (scopeRef.kind === "toolCall" || rows !== null),
  });
  // 文件查看面板：消费文件树 / 文件链接入口排入的待开文档（open_document 由宿主代调，
  // 结果经 notifyToolResult 回投；notifyToolResult 在 attached 前会被丢弃，所以必须等 running）。
  // 路由表有内置 `.xlsx` 常量与插件声明（file.viewer，docs/plugins/extension-host.md §16.5）两个来源，
  // 这里不再按 Office 的 surface id 过滤：每个 surface 标签都按自己的 tab id 订阅，只有排过队的标签会收到文件。
  useEffect(() => {
    if (!tab.surfaceId) return;
    if (host.phase !== "running") return;
    return subscribeOfficeViewerPendingOpen(tab.id, () => {
      deliverOfficeViewerDocumentIfReady(tab.id, host.pageKey);
    });
  }, [host.phase, host.pageKey, tab.id, tab.surfaceId]);

  return {
    visible,
    scopeRef,
    host: {
      ...host,
      handle: presentation ? host.handle : null,
      phase: presentation ? host.phase : "preparing",
    },
    loadingLabel: intl.formatMessage({ id: "pluginUi.loading" }),
    errorLabel: intl.formatMessage({ id: "pluginUi.loadFailed" }),
    retryLabel: intl.formatMessage({ id: "pluginUi.retry" }),
    onWidthChange: setWidth,
  };
}

/** 侧栏不在 SessionPane 树内，由这个适配器复用原 workspace 的 V4 层与 lease。 */
export function PluginUiConversationScope({
  tab,
  children,
}: {
  tab: PluginUiSidePaneTab;
  children: ReactNode;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.workspacePath, tab.workspaceIdentity, tab.remoteSessionId],
  );
  return <V4PaneConversationProvider scope={scope}>{children}</V4PaneConversationProvider>;
}
