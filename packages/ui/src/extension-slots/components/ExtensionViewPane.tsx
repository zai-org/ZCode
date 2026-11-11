import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  findStaticView,
  type ExtensionViewInput,
  type ResolvedScope,
} from "@zcode/shared/extension-host";
import { TID_EXTENSION_VIEW } from "@zcode/shared/test-ids";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useExtensionSlotsState,
  useExtensionViewsService,
  useExtensionsService,
} from "@/extension-slots/adapters/useExtensionSlots.js";
import {
  createExtensionViewPage,
  type ExtensionViewPage,
  type ExtensionViewPageSnapshot,
} from "@/extension-slots/adapters/extensionViewPage.js";
import type { ExtensionViewPaneProps } from "@/extension-slots/contract.js";

const IDLE_SNAPSHOT: ExtensionViewPageSnapshot = {
  phase: "preparing",
  error: null,
  instanceId: null,
  gen: null,
  sandboxId: null,
};
const noopSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE_SNAPSHOT;

/**
 * 扩展视图标签页（docs/plugins/extension-host.md §8）。挂载时创建实例、卸载时关闭；
 * 扩展进程换代（贡献表快照的 gen 变化）或侧栏目标换了会话时按新的代际与作用域重建。
 */
export function ExtensionViewPane({
  tab,
  visible,
  target,
  onOpenExternal,
}: ExtensionViewPaneProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const sandbox = platform.pluginSandbox ?? null;
  const service = useExtensionsService();
  const viewsService = useExtensionViewsService();
  // 视图声明来自 Window Host 的静态表（§16.1）；实例要等扩展进程连上（快照的 gen）才能创建。
  const { gen, declared, appScoped } = useExtensionSlotsState(service, (state) => {
    const view = findStaticView(state.table, tab.viewId);
    return {
      gen: state.snapshot?.gen ?? null,
      declared: Boolean(view),
      appScoped: view?.scope === "app",
    };
  });
  // 实例作用域：侧栏当前目标的会话（草稿为预热会话），没有会话时为工作区。草稿首发交接期间
  // 窗格的会话不会消失（预热协调器保留已提升的 binding，§16.11），目标直接派生即可。
  // 声明了 scope: "app" 的视图（§18.1 H5）固定为 App 作用域：切换会话、草稿首发都不重建实例。
  const sessionId = appScoped ? null : target.sessionId;
  // 用序列化值做依赖：同一作用域的新对象不触发重建。
  const scopeKey = useMemo(() => {
    if (appScoped) return JSON.stringify({ kind: "app" } satisfies ResolvedScope);
    const workspace = {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
    const scope: ResolvedScope = sessionId
      ? { kind: "session", workspace, sessionId }
      : { kind: "workspace", workspace };
    return JSON.stringify(scope);
  }, [appScoped, sessionId, target.workspaceIdentity, target.workspacePath]);
  const scopeKind = appScoped ? "app" : sessionId ? "session" : "workspace";
  // file.viewer 的打开对象（§16.5）同样按值做依赖：标签对象换了引用不重建实例。
  const inputKey = tab.input ? JSON.stringify(tab.input) : null;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const openExternalRef = useRef(onOpenExternal);
  openExternalRef.current = onOpenExternal;
  const [page, setPage] = useState<ExtensionViewPage | null>(null);

  useEffect(() => {
    if (!viewsService || !sandbox || gen === null || !declared) return;
    const created = createExtensionViewPage({
      service: viewsService,
      platform: sandbox,
      viewId: tab.viewId,
      scope: JSON.parse(scopeKey) as ResolvedScope,
      ...(inputKey ? { input: JSON.parse(inputKey) as ExtensionViewInput } : {}),
      locale: localeRef.current,
      openExternal: (url) => openExternalRef.current?.(url),
    });
    setPage(created);
    return () => {
      setPage((current) => (current === created ? null : current));
      void created.dispose();
    };
  }, [declared, gen, inputKey, sandbox, scopeKey, tab.viewId, viewsService]);

  useEffect(() => {
    page?.setLocale(locale);
  }, [locale, page]);

  const snapshot = useSyncExternalStore(
    page?.subscribe ?? noopSubscribe,
    page?.getSnapshot ?? idleSnapshot,
    idleSnapshot,
  );

  const anchorRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = anchorRef.current;
    // 标签页隐藏时同步解绑：页面停在停放层，实例继续保活。
    if (!page || !node || !visible) return;
    return page.bind(node);
  }, [page, visible]);

  const message =
    !service || !viewsService
      ? null
      : !sandbox
        ? intl.formatMessage({ id: "extensions.view.unsupported" })
        : gen === null
          ? intl.formatMessage({ id: "extensions.view.hostNotRunning" })
          : !declared
            ? intl.formatMessage({ id: "extensions.view.unavailable" })
            : snapshot.phase === "error"
              ? intl.formatMessage(
                  { id: "extensions.view.failed" },
                  { reason: snapshot.error ?? "" },
                )
              : snapshot.phase === "preparing"
                ? intl.formatMessage({ id: "extensions.view.loading" })
                : null;

  return (
    <div
      ref={anchorRef}
      data-testid={TID_EXTENSION_VIEW}
      data-extension-view-id={tab.viewId}
      data-extension-view-phase={page ? snapshot.phase : "idle"}
      data-extension-view-gen={snapshot.gen ?? ""}
      data-extension-view-instance={snapshot.instanceId ?? ""}
      data-extension-view-sandbox={snapshot.sandboxId ?? ""}
      data-extension-view-scope={scopeKind}
      data-extension-view-input-path={tab.input?.path ?? ""}
      className="relative h-full min-h-0 w-full overflow-hidden"
    >
      {message ? (
        <div className="flex h-full items-center justify-center px-3 py-2 text-center text-ui-sm text-foreground-subtle">
          {message}
        </div>
      ) : null}
    </div>
  );
}
