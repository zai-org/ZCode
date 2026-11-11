import { createPage } from "../../../ui/src/plugin-ui/adapters/pluginUiManagedPage.js";
import { acquirePluginUiPage } from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { attachPluginUiToolResults } from "../../../ui/src/plugin-ui/adapters/pluginUiBackground.js";
import { buildPluginUiSurfaceKey } from "../../../ui/src/plugin-ui/contract.js";
import { subscribePage } from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/adapters/pluginUiSessionActions.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ServiceProvider } from "../../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../ui/src/hooks/usePlatform.js";
import { usePluginUiHost } from "../../../ui/src/plugin-ui/adapters/usePluginUiHost.js";
import { PluginUiCard } from "../../../ui/src/plugin-ui/components/PluginUiCard.js";
import { PluginUiSidePaneView } from "../../../ui/src/plugin-ui/components/PluginUiSidePane.js";
import { pluginUiPages } from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { getPluginUiWidgetState } from "../../../ui/src/plugin-ui/app/pluginUiWidgetStateStore.js";
import { RowsFixture } from "./rows-renderer.js";
import type {
  UsePluginUiHostInput,
  UsePluginUiHostResult,
} from "../../../ui/src/plugin-ui/adapters/pluginUiHostTypes.js";
const harness = (window as any).harness;
const ready = Promise.withResolvers<void>();
(window as any).harnessReady = ready.promise;
const paused = Promise.withResolvers<void>();
(window as any).fixturePaused = paused.promise;
const drained = new Set<() => void>();
const channels = new Map<string, Set<(value: any) => void>>();
const emit = (name: string, value: unknown) => {
  for (const handler of channels.get(name) ?? []) handler(value);
};
const subscribe = (name: string, handler: (value: any) => void) => {
  const set = channels.get(name) ?? new Set();
  channels.set(name, set);
  set.add(handler);
  return {
    dispose: () => {
      set.delete(handler);
      for (const notify of drained) notify();
    },
  };
};
window.addEventListener("message", (event) => {
  if (event.data?.type === "fixture-notification")
    emit(event.data.payload.kind, event.data.payload.value);
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    emit("ports", { ...event.data, port: event.ports[0] });
});
const proxy = (send: (method: string, p: unknown) => Promise<unknown>) =>
  new Proxy({}, { get: (_, method) => (p: unknown) => send(String(method), p) });
const agent = {
  ...Object.fromEntries(
    [
      "helloConversationV4",
      "initializeConversationV4",
      "subscribeConversationV4",
      "unsubscribeConversationV4",
      "resyncConversationV4",
      "getSessionLifecycle",
    ].map((method) => [method, (p: unknown) => harness.v4(method, p)]),
  ),
  onDynamicPluginUiToolResult: () => (handler: any) => subscribe("ui-result", handler),
  onDynamicConversationFrame: () => (handler: any) => subscribe("frame", handler),
  onDynamicSessionLifecycle: () => (handler: any) => subscribe("session-lifecycle", handler),
  onDynamicLocalTtftFacts: () => (handler: any) => subscribe("ttft", handler),
  onAgentRuntimeRestarted: (handler: any) => subscribe("restart", handler),
  onAgentRuntimeLifecycle: (handler: any) => subscribe("lifecycle", handler),
};
const services = {
  zcodeAgentService: agent,
  zcodeTaskService: { onDynamicWorkspaceEvent: () => (handler: any) => subscribe("task", handler) },
  pluginUiBridgeService: proxy(harness.bridge),
  pluginUiSamplingService: proxy(harness.bridge),
  pluginUiAppToolsService: proxy(harness.appTools),
};
const platform = {
  pluginSandbox: {
    setExecutionActive: window.zcodePluginSandbox?.setExecutionActive,
    getOwnerWebContentsId: () => harness.owner(),
    disposeSandbox: (id: string, init: number) => harness.dispose(id, init),
    consumeUserGesture: async () => false,
    onPorts(handler: any) {
      const listener = subscribe("ports", handler);
      return () => listener.dispose();
    },
  },
};
let current: UsePluginUiHostResult;
let renderState: (next: {
  inline: boolean;
  sidebar: boolean;
  sequence?: number;
  remote?: boolean;
}) => void;
let config: any;
const phases: string[] = [];
const deadlines = new Set<() => void>();
const realSetTimeout = window.setTimeout.bind(window),
  realClearTimeout = window.clearTimeout.bind(window);
const fakeIds = new Map<number, () => void>();
let nextTimer = -1;
// 只控制产品的五分钟/三十分钟期限；握手、teardown、keep-warm 仍用真实完成事件。
window.setTimeout = ((run: () => void, ms: number, ...args: any[]) => {
  if (ms < 300_000 || ms > 1_800_000) return realSetTimeout(run, ms, ...args);
  const id = nextTimer--;
  deadlines.add(run);
  fakeIds.set(id, run);
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id: number) => {
  const run = fakeIds.get(id);
  if (run) {
    deadlines.delete(run);
    fakeIds.delete(id);
  } else realClearTimeout(id);
}) as typeof window.clearTimeout;

function Anchor({
  side,
  enabled,
  sequence,
  remote,
  visible = true,
}: {
  side: boolean;
  enabled: boolean;
  sequence?: number;
  remote?: boolean;
  visible?: boolean;
}) {
  const input: UsePluginUiHostInput = {
    ...config,
    scope: { ...config.scope, ...(remote ? { remoteSessionId: "fixture-remote" } : {}) },
    theme: config.theme ?? "light",
    locale: config.locale ?? "en",
    displayMode: side ? "fullscreen" : "inline",
    width: config.width ?? 400,
    hostVersion: "managed-fixture",
    toolInput: sequence === undefined ? undefined : { sequence },
    toolResult:
      sequence === undefined ? undefined : { content: [], structuredContent: { sequence } },
    toolCallId: `feed-${sequence}`,
    enabled,
  };
  const host = usePluginUiHost(input);
  if (enabled) current = host;
  useEffect(() => {
    if (!enabled) return;
    phases.push(host.phase);
    void harness.event({ type: "phase", phase: host.phase, key: host.pageKey });
    if (host.phase === "running" || !host.supported) ready.resolve();
    if (host.phase === "error") ready.reject(new Error(host.error ?? "managed page failed"));
  }, [host.phase, host.pageKey, enabled]);
  if (config.mode.startsWith("background-cold")) return null;
  return side ? (
    <PluginUiSidePaneView
      visible={visible}
      scopeRef={config.scope.scope}
      host={host}
      loadingLabel="loading"
      errorLabel="failed"
      retryLabel="retry"
    />
  ) : (
    <PluginUiCard
      {...host}
      prefersBorder={false}
      loadingLabel="loading"
      errorLabel="failed"
      retryLabel="retry"
      onRetry={host.reload}
    />
  );
}
function Fixture() {
  const [state, setState] = useState({
    inline: config.mode !== "background-hidden" && !config.mode.startsWith("background-admission"),
    sidebar: config.mode === "background-hidden",
    sidebarVisible: true,
    sidebarActive: true,
    chatVisible: true,
    workspaceVisible: true,
    sequence: undefined as number | undefined,
    remote: config.mode === "remote",
  });
  renderState = (next) => setState((previous) => ({ ...previous, ...next }));
  return (
    <ServiceProvider services={services as never}>
      <PlatformProvider platform={platform as never}>
        <div
          id="inline-scroll"
          style={{
            position: "absolute",
            left: 20,
            top: 20,
            width: config.width ?? 400,
            height: 350,
            overflow: "auto",
          }}
        >
          <div data-sandbox-page-container="true" style={{ position: "relative" }}>
            <div id="inline-anchor">
              {state.inline && (
                <Anchor
                  side={false}
                  enabled={!state.sidebar}
                  sequence={state.sequence}
                  remote={state.remote}
                />
              )}
            </div>
            <div style={{ height: 1400 }} />
          </div>
        </div>
        <div
          id="sidebar-anchor"
          aria-hidden={!state.sidebarVisible || !state.chatVisible || !state.workspaceVisible}
          style={{
            position: "absolute",
            left: 500,
            top: 20,
            width: state.sidebarVisible ? 450 : 0,
            height: 600,
            display: config.mode === "background-hidden" ? "none" : undefined,
            overflow: "hidden",
            opacity: state.sidebarVisible && state.chatVisible && state.workspaceVisible ? 1 : 0,
            pointerEvents:
              state.sidebarVisible && state.chatVisible && state.workspaceVisible
                ? undefined
                : "none",
          }}
        >
          {/* 复现应用收起时锁宽、切标签时 forceMount 的真实布局；锚点一直连接。 */}
          <div style={{ width: 450, height: 600, display: state.sidebarActive ? "block" : "none" }}>
            {state.sidebar && (
              <Anchor
                side
                enabled
                visible={
                  state.sidebarVisible &&
                  state.sidebarActive &&
                  state.chatVisible &&
                  state.workspaceVisible
                }
                sequence={state.sequence}
                remote={state.remote}
              />
            )}
          </div>
        </div>
        <div style={{ position: "absolute", left: 500, top: 650 }}>
          <button
            id="toggle-sidebar"
            onClick={() =>
              setState((previous) => ({ ...previous, sidebarVisible: !previous.sidebarVisible }))
            }
          >
            Toggle sidebar
          </button>
          <button
            id="switch-sidebar-tab"
            onClick={() =>
              setState((previous) => ({ ...previous, sidebarActive: !previous.sidebarActive }))
            }
          >
            Switch tab
          </button>
          <button
            id="switch-main-page"
            onClick={() =>
              setState((previous) => ({ ...previous, chatVisible: !previous.chatVisible }))
            }
          >
            Switch page
          </button>
          <button
            id="switch-workspace"
            onClick={() =>
              setState((previous) => ({
                ...previous,
                workspaceVisible: !previous.workspaceVisible,
              }))
            }
          >
            Switch workspace
          </button>
        </div>
      </PlatformProvider>
    </ServiceProvider>
  );
}
const layout = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
(window as any).setAnchors = async (inline: boolean, sidebar: boolean, sequence?: number) => {
  flushSync(() => renderState({ inline, sidebar, sequence }));
  await layout();
};
(window as any).revealBackgroundPage = async () => {
  config.mode = "background";
  flushSync(() => renderState({ inline: false, sidebar: true }));
  await layout();
};
(window as any).setShowcasePresentation = async (
  theme: "light" | "dark",
  locale: string,
  width: number,
) => {
  Object.assign(config, { theme, locale, width });
  // fixture 没有应用主题样式表，提供宿主 token 以验证 reader → hostContext → 页面颜色。
  for (const [token, values] of Object.entries({
    "--color-background": ["#ffffff", "#17191c"],
    "--color-panel": ["#f4f5f6", "#23272c"],
    "--color-foreground": ["#202124", "#e6edf3"],
    "--color-foreground-subtle": ["#5f6368", "#adb5bd"],
    "--color-border": ["#dadce0", "#454b52"],
  }))
    document.documentElement.style.setProperty(token, values[theme === "dark" ? 1 : 0]!);
  flushSync(() => renderState({ inline: true, sidebar: false }));
  await layout();
};
(window as any).managedState = () => ({
  actual: {
    phase: pluginUiPages.get(current.pageKey)?.snapshot().phase,
    error: pluginUiPages.get(current.pageKey)?.snapshot().error,
  },
  phase: current.phase,
  supported: current.supported,
  handle: current.handle,
  key: current.pageKey,
  visible: pluginUiPages.get(current.pageKey)?.visible,
  busy: pluginUiPages.get(current.pageKey)?.busy(),
  widget: getPluginUiWidgetState(current.pageKey),
  views: document.querySelectorAll("webview").length,
  listeners: Object.fromEntries([...channels].map(([key, listeners]) => [key, listeners.size])),
  phases,
});
(window as any).expireOffscreen = () => {
  const pending = [...deadlines];
  deadlines.clear();
  for (const run of pending) run();
};
(window as any).removeTask = () => {
  // 删除任务同时撤掉呈现入口；不能让测试中仍挂载的 hook 再次请求已删除任务。
  flushSync(() => renderState({ inline: false, sidebar: false }));
  emit("task", {
    type: "workspace_task_list_changed",
    reason: "task_deleted",
    taskId: config.scope.sessionId,
  });
};
(window as any).runtimeUnavailable = () =>
  emit("lifecycle", {
    workspaceKey: config.scope.workspaceIdentity ?? config.scope.workspacePath,
    state: "unavailable",
  });
(window as any).retryManaged = () => current.reload();
(window as any).waitManagedPhase = (phase: string) => {
  const page = pluginUiPages.get(current.pageKey);
  if (!page || page.snapshot().phase === phase) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const off = page.subscribe(() => {
      if (page.snapshot().phase === phase) {
        off();
        resolve();
      }
    });
  });
};
(window as any).suspendManaged = () => pluginUiPages.get(current.pageKey)?.suspend();
(window as any).waitConnectionsReleased = () =>
  new Promise<void>((resolve) => {
    const check = () => {
      if ([...channels.values()].every((set) => set.size === 0)) {
        drained.delete(check);
        resolve();
      }
    };
    drained.add(check);
    check();
  });
(window as any).clearManaged = () => pluginUiPages.clear();
(window as any).setFallback = async (remote: boolean, noSandbox: boolean) => {
  const previous = platform.pluginSandbox;
  if (noSandbox) platform.pluginSandbox = undefined as never;
  flushSync(() => renderState({ inline: true, sidebar: false, remote }));
  await layout();
  platform.pluginSandbox = previous;
  return { supported: current.supported, views: document.querySelectorAll("webview").length };
};
void harness
  .config()
  .then(async (value: any) => {
    config = value;
    if (config.mode === "sampling") {
      let unregister: (() => void) | undefined;
      (window as any).setSamplingEnabled = (enabled: boolean) => {
        unregister?.();
        unregister = undefined;
        if (enabled)
          unregister = registerPluginUiSessionActions(config.scope, {
            sendFollowUp: async () => {
              throw new Error("Sampling must not send a conversation turn");
            },
          });
      };
      (window as any).setSamplingEnabled(true);
      const idleWaiters = new Set<() => void>();
      const settled = pluginUiPages.settled.bind(pluginUiPages);
      pluginUiPages.settled = (page) => {
        settled(page);
        for (const notify of idleWaiters) notify();
      };
      (window as any).waitSamplingIdle = () =>
        new Promise<void>((resolve) => {
          const notify = () => {
            if (!pluginUiPages.get(current.pageKey)?.busy()) {
              idleWaiters.delete(notify);
              resolve();
            }
          };
          idleWaiters.add(notify);
          notify();
        });
    }
    if (config.mode.startsWith("background-admission")) {
      // 故意不挂 Anchor/usePluginUiHost，也没有 conversation lease；只保留生产窗口接收器。
      const key = buildPluginUiSurfaceKey(
        { ...config.scope, ...config.presentation },
        config.scope.scope,
      );
      subscribePage(key, () => {
        const page = pluginUiPages.get(key);
        if (page) current = page.snapshot();
      });
      const off = attachPluginUiToolResults(services as never, platform as never, () => ({
        theme: "light",
        locale: "en",
      }));
      (window as any).stopBackgroundReceiver = off;
      ready.resolve();
    }
    if (config.mode === "web") platform.pluginSandbox = undefined as never;
    if (config.mode.endsWith("-minimized")) {
      const start = Promise.withResolvers<void>();
      (window as any).startFixture = start.resolve;
      paused.resolve();
      await start.promise;
    }
    createRoot(document.getElementById("root")!).render(
      config.mode === "rows" ? (
        <ServiceProvider services={services as never}>
          <PlatformProvider platform={platform as never}>
            <RowsFixture config={config} ready={ready.resolve} />
          </PlatformProvider>
        </ServiceProvider>
      ) : (
        <Fixture />
      ),
    );
  })
  .catch(ready.reject);

const originalNow = Date.now;
let retentionOffset = 0;
(window as any).advanceRetention = (ms: number) => {
  retentionOffset += ms;
  Date.now = () => originalNow() + retentionOffset;
  (window as any).expireOffscreen();
};
(window as any).addRetentionPages = async (count: number) => {
  const keys: string[] = [];
  for (let index = 0; index < count; index++) {
    const input = {
      ...config,
      theme: "light",
      locale: "en-US",
      displayMode: "inline",
      width: 400,
      hostVersion: "fixture",
      toolInput: undefined,
      toolResult: undefined,
      scope: { ...config.scope, scope: { kind: "toolCall", toolCallId: `retained-${index}` } },
    } as UsePluginUiHostInput;
    const key = buildPluginUiSurfaceKey(
      { ...input.scope, ...input.presentation },
      input.scope.scope,
    );
    const page = await acquirePluginUiPage(key, () =>
      createPage(key, input, platform as any, services as any),
    );
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const { phase, error } = page.snapshot();
        if (phase === "running" || phase === "error") {
          off();
          if (error) reject(new Error(error));
          else resolve();
        }
      };
      const off = page.subscribe(check);
      check();
    });
    keys.push(key);
  }
  return keys;
};
(window as any).retentionStates = (keys: string[]) =>
  keys.map((key) => pluginUiPages.get(key)?.snapshot().phase);
