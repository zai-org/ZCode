import { BrowserWindow, ipcMain, webContents, type WebContents } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { installPluginSandboxHost } from "../../src/main/pluginSandbox/index.js";
import { createPluginUiBridgeService } from "../../../services/src/plugin-ui-bridge/pluginUiBridgeService.js";
import { createPluginUiSamplingService } from "../../../services/src/plugin-ui-bridge/pluginUiSamplingService.js";
import { Events, startAgent } from "./agent.js";
import { startModel } from "./model.js";
import { evaluateGuest } from "./guest-evaluation.js";

export async function managedEnvironment(root: string, node: string, cli: string) {
  const model = await startModel(root, cli);
  const agent = await startAgent(root, node, cli, model.env);
  const events = new Events<any>();
  const windows: BrowserWindow[] = [];
  const modes = new Map<number, string>();
  const scopes = new Map<number, any>();
  const gates = new Map<string, Promise<void>>();
  const handles = new Map<number, any>();
  const guests = new Map<number, WebContents>();
  const native = installPluginSandboxHost({
    rendererDir: root,
    aliasDir: root,
    preloadPath: join(root, "guest.cjs"),
    logger: { warn: (message) => process.stderr.write(`${message}\n`) },
  });
  const wire = (p: any) => {
    const {
      workspacePath,
      workspaceIdentity,
      scopeId: _scope,
      resourceUri: _uri,
      ownerWebContentsId: _owner,
      csp: _csp,
      prefersBorder: _border,
      ...rest
    } = p;
    return {
      ...rest,
      workspace: {
        workspacePath,
        workspaceKey: workspaceIdentity?.trim() || workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      },
    };
  };
  const sampling = createPluginUiSamplingService({
    sample: (p) => agent.call("mcp/uiSampling", wire(p)),
    cancelSampling: (p) => agent.call("mcp/uiCancelSampling", wire(p)),
  });
  const bridge = createPluginUiBridgeService({
    openInstance: (p) =>
      agent.call("mcp/uiOpenInstance", {
        ...wire(p),
        resourceUri: p.resourceUri,
        scopeId: p.scopeId,
        ownerWebContentsId: p.ownerWebContentsId,
      }),
    validateInstance: (p) => agent.call("mcp/uiValidateInstance", wire(p)),
    closeInstance: (p) => agent.call("mcp/uiCloseInstance", wire(p)),
    recycleInstance: async (p) =>
      (await agent.call("mcp/uiCloseInstance", { ...wire(p), onlyIfIdle: true })).closed,
    readMcpResource: (p) => agent.call("mcp/readResource", wire(p)),
    callMcpToolForUi: (p) => agent.call("mcp/uiCallTool", wire(p)),
    cancelMcpToolCallForUi: (p) => agent.call("mcp/uiCancelCall", wire(p)),
    readMcpResourceForUi: (p) => agent.call("mcp/uiReadResource", wire(p)),
    listMcpResourcesForUi: (p) => agent.call("mcp/uiListResources", wire(p)),
    listMcpResourceTemplatesForUi: (p) => agent.call("mcp/uiListResourceTemplates", wire(p)),
    subscribeMcpResourceForUi: (p) =>
      agent.call("mcp/uiSubscribeResource", { ...wire(p), scopeId: p.scopeId }),
    unsubscribeMcpResourceForUi: (p) =>
      agent.call("mcp/uiUnsubscribeResource", { ...wire(p), scopeId: p.scopeId }),
    registerSandbox: async (p) => {
      const handle = native.registerFromHost(p);
      handles.set(p.ownerWebContentsId, handle);
      events.emit({ type: "registered", owner: p.ownerWebContentsId, handle });
      return handle;
    },
  });
  agent.client.onNotification((event) => {
    if (event.method === "session/lifecycle/changed") {
      for (const win of windows) {
        if (
          !win.isDestroyed() &&
          scopes.get(win.webContents.id)?.sessionId === event.params.sessionId
        )
          win.webContents.send("fixture-notification", {
            kind: "session-lifecycle",
            value: event.params,
          });
      }
      return;
    }
    if (event.method === "v4/plugin-ui/tool-result") {
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        const scope = scopes.get(win.webContents.id);
        if (scope?.sessionId === event.params.sessionId)
          win.webContents.send("fixture-notification", {
            kind: "ui-result",
            value: {
              ...event.params,
              workspacePath: scope.workspace.workspacePath,
            },
          });
      }
      return;
    }
    if (event.method !== "v4/conversation/frame") return;
    for (const win of windows) {
      if (
        !win.isDestroyed() &&
        event.params.topic === `conversation/${scopes.get(win.webContents.id)?.sessionId}`
      )
        win.webContents.send("fixture-notification", { kind: "frame", value: event.params });
    }
  });
  ipcMain.handle("fixture-config", (event) => {
    const scope = scopes.get(event.sender.id);
    return {
      mode: modes.get(event.sender.id),
      scope: {
        ...scope.workspace,
        sessionId: scope.sessionId,
        scope: { kind: "surface", surfaceId: scope.surface ?? "same" },
      },
      presentation: {
        pluginId: scope.pluginId,
        serverName: scope.serverName,
        resourceUri: scope.resourceUri ?? "ui://fixture",
      },
    };
  });
  ipcMain.handle("fixture-event", (event, value) =>
    events.emit({ ...value, owner: event.sender.id }),
  );
  ipcMain.handle("fixture-bridge", async (event, method, params) => {
    const scope = scopes.get(event.sender.id);
    assert.equal(params.sessionId, scope.sessionId);
    assert.equal(params.serverName, scope.serverName);
    events.emit({ type: "bridge-arrived", method, owner: event.sender.id });
    const result = await ({ ...bridge, ...sampling } as any)[method](params);
    events.emit({ type: "bridge", method, owner: event.sender.id });
    await gates.get(`return:${method}`);
    return result;
  });
  ipcMain.handle("fixture-app-tools", async (event, method, params) => {
    const methods: Record<string, string> = {
      registerAppTools: "mcp/uiRegisterAppTools",
      unregisterAppTools: "mcp/uiUnregisterAppTools",
      claimAppToolCall: "mcp/uiClaimAppToolCall",
      resolveAppToolCall: "mcp/uiResolveAppToolCall",
    };
    assert.ok(methods[method]);
    events.emit({ type: "app-tools-arrived", method, owner: event.sender.id, params });
    await gates.get(method);
    const result = await agent.call(methods[method]!, { ...wire(params), scopeId: params.scopeId });
    events.emit({ type: method, owner: event.sender.id, params, result });
    return result;
  });
  ipcMain.handle("fixture-v4", async (event, method, params) => {
    const scope = scopes.get(event.sender.id);
    const connectionId = `managed-${event.sender.id}`;
    if (method === "helloConversationV4")
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId,
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
          independentPlanState: true,
        },
        auth: {},
      };
    if (method === "initializeConversationV4") return;
    if (method === "getSessionLifecycle")
      return agent.call("session/lifecycle/getState", { sessionId: params.sessionId });
    if (method === "subscribeConversationV4") {
      const result = await agent.call("v4/conversation/subscribe", {
        connectionId,
        clientMode: "desktop-continuous",
        workspace: scope.workspace,
        topic: `conversation/${params.sessionId}`,
        ...(params.visibility ? { visibility: params.visibility } : {}),
      });
      events.emit({ type: "subscribed", owner: event.sender.id });
      return result;
    }
    if (method === "unsubscribeConversationV4") {
      const result = await agent.call("v4/conversation/unsubscribe", {
        connectionId,
        topic: `conversation/${params.sessionId}`,
        subscriptionId: params.subscriptionId,
      });
      events.emit({ type: "unsubscribed", owner: event.sender.id });
      return result;
    }
    if (method === "resyncConversationV4")
      return agent.call("v4/conversation/resync", { connectionId, ...params });
    throw new Error(`Unexpected managed service call ${method}`);
  });
  async function createWindow(scope: any, mode = "local") {
    const win = new BrowserWindow({
      show: mode.startsWith("background"),
      width: 1000,
      height: 700,
      webPreferences: {
        preload: join(root, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: mode.startsWith("background"),
      },
    });
    windows.push(win);
    modes.set(win.webContents.id, mode);
    scopes.set(win.webContents.id, scope);
    win.webContents.on("console-message", (e) => process.stderr.write(`${e.message}\n`));
    const pending: string[] = [];
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = native.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!result.ok) event.preventDefault();
      else pending.push(result.sandboxId);
    });
    win.webContents.on("did-attach-webview", (_event, guest) => {
      guests.set(win.webContents.id, guest);
      native.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! });
    });
    await win.loadFile(join(root, "managed.html"));
    if (mode.endsWith("-minimized")) {
      // 已加载的宿主窗口先最小化，再发起首个插件请求，覆盖真实后台创建时序。
      await win.webContents.executeJavaScript("window.fixturePaused");
      win.minimize();
      await win.webContents
        .executeJavaScript(`document.hidden || new Promise(resolve=>document.addEventListener('visibilitychange',function changed(){
        if(document.hidden){document.removeEventListener('visibilitychange',changed);resolve()}
      }))`);
      await win.webContents.executeJavaScript("window.startFixture()");
    }
    await win.webContents.executeJavaScript("window.harnessReady");
    if (mode !== "local" && mode !== "sampling") return win;
    await evaluateGuest(
      guests.get(win.webContents.id)!,
      scope.resourceUri ? "window.showcaseReady" : "window.fixtureReady",
    );
    await events.wait((e) => e.type === "subscribed" && e.owner === win.webContents.id);
    return win;
  }
  return {
    gates,
    model,
    agent,
    events,
    windows,
    scopes,
    handles,
    guests,
    native,
    wire,
    bridge,
    createWindow,
    evalPage: (win: BrowserWindow, code: string) =>
      evaluateGuest(guests.get(win.webContents.id)!, code),
    countGuests: () =>
      webContents.getAllWebContents().filter((c) => c.getType() === "webview").length,
    async close() {
      for (const win of windows) if (!win.isDestroyed()) win.destroy();
      await agent.close();
      await model.close();
    },
  };
}
