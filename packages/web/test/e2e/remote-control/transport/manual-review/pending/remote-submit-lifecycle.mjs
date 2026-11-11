// MRS01–04：真实 Web Root/Composer/反馈表单、Host 装配和 raw RPC；外部账号/relay/Agent 返回受控。
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-submit-lifecycle.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import {
  RemoteServiceAccess,
  connectViaProtocol,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zcode/client";
import { ServiceChannels } from "@zcode/shared";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import { createDeviceSwitchDesktopBridge } from "../../../projects/manual-review/pending/remote-device-switch.helpers.mjs";
import { taskSnapshotFrame } from "../../../projects/manual-review/pending/remote-task-open.fixture.mjs";
import {
  setup,
  assertEventually,
} from "../../../authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const root = resolve(import.meta.dirname, "../../../../../../../..");
const { Emitter, ProxyChannel, ChannelClient, ChannelServer, createQueuePair } = await import(
  pathToFileURL(resolve(root, "packages/rpc/src/index.ts"))
);
const contracts = await import(pathToFileURL(resolve(root, "packages/services/src/index.ts")));
const { resolveEffectiveModelSelection } = await import(
  pathToFileURL(resolve(root, "packages/provider/src/index.ts"))
);
const { createServerRemoteWorkspaceServiceCollection } = await import(
  pathToFileURL(resolve(root, "packages/desktop/src/host/remoteWorkspaceServiceCollection.ts"))
);
const { exposeWindowHostAttachmentServices } = await import(
  pathToFileURL(resolve(root, "packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts"))
);
const artifacts = resolve(root, ".tmp/remote-submit-lifecycle-e2e");
await mkdir(artifacts, { recursive: true });
const vite = await createServer({
  root: resolve(root, "packages/web"),
  configFile: resolve(root, "packages/web/vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
});
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const selection = {
  providerId: "fixture",
  modelId: "fixture-model",
  options: { reasoningLevel: "high" },
};
const modelView = {
  revision: 1,
  preferredSelection: selection,
  providers: [
    {
      providerId: "fixture",
      providerName: "Fixture",
      config: { api: { type: "anthropic-messages", baseUrl: "https://example.invalid" } },
      models: [
        {
          modelId: "fixture-model",
          config: {
            enabled: true,
            optionSpecs: { reasoningLevel: { values: ["high"], map: "{}" } },
          },
        },
      ],
    },
  ],
};
async function boundaryControls() {
  const local = new contracts.ServiceCollection()
    .register(contracts.IFeedbackService, { getDeviceSnapshot: async () => ({ owner: "window" }) })
    .register(contracts.IGenUiService, {
      listState: async () => [],
      setState: async () => "written",
      prepareSandbox: async () => "sandbox",
    });
  for (const mode of ["web-remote-replayable", "desktop-continuous"]) {
    const [sp, cp] = createQueuePair();
    const server = new ChannelServer(sp, "MRS04");
    const client = new ChannelClient(cp);
    try {
      exposeWindowHostAttachmentServices({ server, services: local, clientMode: mode });
      assert.deepEqual(await client.getChannel("feedback").call("getDeviceSnapshot", []), {
        owner: "window",
      });
      assert.deepEqual(await client.getChannel("gen-ui").call("listState", [{}]), []);
      for (const method of ["setState", "prepareSandbox"]) {
        const call = client.getChannel("gen-ui").call(method, [{}]);
        if (mode === "web-remote-replayable") await assert.rejects(call, /Method not found/);
        else assert.ok(await call);
      }
    } finally {
      client.dispose();
      server.dispose();
    }
  }
  // 未收到 Initialize 就结束，以及终结后才创建客户端：都不能产生无主 Promise。
  for (const beforeConnect of [false, true]) {
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: "MRS04-before-init",
      sendFrame: () => true,
    });
    if (beforeConnect) adapter.dispose();
    const services = connectViaProtocol(adapter.protocol, { signal: adapter.signal });
    const rejected = assert.rejects(services.feedbackService.getDeviceSnapshot(), /disposed/);
    adapter.dispose();
    adapter.dispose();
    await rejected;
    await assert.rejects(services.feedbackService.getDeviceSnapshot(), /disposed/);
  }
  // 同 bridge 的正常 RPC、replay 与终结后晚到响应对照；只用受控释放，不改变产品计时器。
  let left, right, finish;
  let entered;
  const requestEntered = new Promise((done) => {
    entered = done;
  });
  left = createAcknowledgedWebRemoteControlRelayProtocol({
    bridgeSessionId: "MRS04-live",
    sendFrame: (frame) => {
      queueMicrotask(() => right.acceptPayload(frame));
      return true;
    },
  });
  right = createAcknowledgedWebRemoteControlRelayProtocol({
    bridgeSessionId: "MRS04-live",
    sendFrame: (frame) => {
      queueMicrotask(() => left.acceptPayload(frame));
      return true;
    },
  });
  const server = new ChannelServer(right.protocol, "MRS04");
  server.registerChannel(
    "feedback",
    ProxyChannel.fromService({
      getDeviceSnapshot: async () => ({ owner: "window" }),
      create: () =>
        new Promise((done) => {
          finish = done;
          entered();
        }),
    }),
  );
  try {
    const services = connectViaProtocol(left.protocol, { signal: left.signal });
    assert.deepEqual(await services.feedbackService.getDeviceSnapshot(), { owner: "window" });
    left.replayUnacknowledged();
    assert.equal(left.signal.aborted, false);
    const rejected = assert.rejects(services.feedbackService.create({}), /disposed/);
    await requestEntered;
    left.markDegraded("MRS04-terminal");
    left.markDegraded("MRS04-duplicate");
    finish({ id: "late" });
    await rejected;
    await assert.rejects(services.feedbackService.getDeviceSnapshot(), /disposed/);
  } finally {
    left.dispose();
    right.dispose();
    server.dispose();
  }
  return { case: "MRS04", result: "passed" };
}
const sourceId = "remote:server:mrs-source";
const taskId = "MRS_TASK";

async function scenario({ width, theme, locale, remote }) {
  const h = await setup(browser, { width, theme, locale, signedIn: true });
  const { page } = h;
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(120_000);
  // 账号/营销等旁路仅提供空响应；产品 UI 就绪由下面的明确状态断言判定，不等第三方资源 load。
  await h.context.route(/\/api\//, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/") || pathname.startsWith("/api/v1/remote/"))
      return route.fallback();
    await route.fulfill({ json: { code: 0, data: {} } });
  });
  const prefix = `${remote ? "remote" : "local"}-${width}-${theme}-${locale}`;
  const workspacePath = remote ? "/workspace/remote" : "/workspace/local";
  const workspaceIdentity = remote ? `${sourceId}:${workspacePath}` : undefined;
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const project = {
    id: "MRS_PROJECT",
    hostId: remote ? sourceId : "local",
    name: "E2E_MRS_PROJECT",
    roots: [{ rootPath: workspacePath, position: 0, isPrimary: true }],
    pinned: false,
    deleted: false,
    position: 0,
    nameOverridden: true,
    createdAt: 1,
    updatedAt: 2,
  };
  const task = {
    taskId,
    projectId: project.id,
    hostId: project.hostId,
    workspacePath,
    workspaceIdentity,
    title: "E2E_MRS_TASK",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    mode: "default",
    status: "completed",
  };
  const workspace = {
    workspacePath,
    workspaceIdentity,
    kind: remote ? "remote" : "local",
    label: "E2E_MRS",
    ...(remote ? { remoteSessionId: "mrs-source-session", connectionState: "connected" } : {}),
  };
  const traffic = { feedback: [], genUi: [], commands: [], opens: [], errors: [] };
  const bridges = new Map();
  let socketRef,
    currentBridge,
    holdRead = false,
    heldRead,
    snapshots = new Map();
  const send = (socket, payload) => socket.send(JSON.stringify({ type: "data", payload }));
  const baseFeedback = {
    getDeviceSnapshot: async () => ({ appVersion: "3.16.3", deviceMid: "E2E_CONTROLLER" }),
    create: async (input) => {
      traffic.feedback.push(input);
      return { id: `E2E_MRS_${traffic.feedback.length}` };
    },
  };
  const baseGenUi = {
    listState: async (scope) => {
      traffic.genUi.push(scope);
      if (holdRead)
        return new Promise((done) => {
          heldRead = () => done([]);
        });
      return [];
    },
  };
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") traffic.errors.push(m.text());
  });
  await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (socket) => {
    socketRef = socket;
    const ready = (request) => {
      const bridge = {
        ...workspace,
        workspaceKey,
        bridgeSessionId: request.bridgeSessionId,
        bridgeGeneration: request.bridgeGeneration,
        initialTaskId: taskId,
        ...(remote ? { capabilities: { windowProjectDirectory: true } } : {}),
      };
      currentBridge = bridge;
      const frames = new Emitter();
      send(socket, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: bridge.bridgeSessionId,
        bridgeGeneration: bridge.bridgeGeneration,
        bridge,
      });
      bridges.set(
        bridge.bridgeSessionId,
        createDeviceSwitchDesktopBridge(socket, bridge, {
          locale,
          theme,
          events: { [`${ServiceChannels.ZCodeAgent}:onDynamicConversationFrame`]: frames.event },
          responses: {
            [`${ServiceChannels.OnboardingRecord}:shouldOnboard`]: false,
            [`${ServiceChannels.SettingsSync}:getFirstRunPromptState`]: { handled: true },
            [`${ServiceChannels.ModelSelection}:getView`]: (input) => ({
              ...modelView,
              ...resolveEffectiveModelSelection({
                selection: input?.selection ?? selection,
                registry: modelView,
                classifyProvider: () => "ordinary",
              }),
            }),
            [`${ServiceChannels.Project}:readTree`]: { projects: [project], tasks: [task] },
            [`${ServiceChannels.Project}:readProjects`]: [project],
            [`${ServiceChannels.Project}:resolveSessionDirectories`]: {
              projectId: project.id,
              workspacePath,
            },
            [`${ServiceChannels.ZCodeTask}:getTaskMeta`]: task,
            [`${ServiceChannels.ZCodeAgent}:helloConversationV4`]: {
              kind: "hello",
              protocolVersion: V4_WIRE_PROTOCOL_VERSION,
              connectionId: bridge.bridgeSessionId,
              clientMode: "web-remote-replayable",
              deliveryProfile: "replayable",
              serverTime: 1,
              auth: {},
              capabilities: {
                nativeDialogs: false,
                localTerminal: false,
                binaryFrames: true,
                compression: "none",
              },
            },
            [`${ServiceChannels.ZCodeAgent}:initializeConversationV4`]: null,
            [`${ServiceChannels.ZCodeAgent}:subscribeConversationV4`]: () => {
              const subscriptionId = `sub-${bridge.bridgeSessionId}`;
              snapshots.set(bridge.bridgeSessionId, () => {
                const frame = taskSnapshotFrame(taskId, subscriptionId);
                frame.frame.payload.snapshot.config = {
                  mode: "build",
                  provider: selection.providerId,
                  model: selection.modelId,
                  modelSelection: selection,
                  thought: "high",
                  followupMode: "queue",
                };
                frames.fire(frame);
              });
              return { ack: { subscriptionId, mode: "snapshot", logEpoch: "e2e" } };
            },
            [`${ServiceChannels.ZCodeAgent}:unsubscribeConversationV4`]: null,
            [`${ServiceChannels.ZCodeAgent}:conversationWorkflowRunsV4`]: { runs: [] },
            [`${ServiceChannels.ZCodeAgent}:conversationPlansV4`]: { plans: [] },
            [`${ServiceChannels.ZCodeAgent}:queryConversationCommandsV4`]: { results: [] },
            [`${ServiceChannels.ZCodeAgent}:sendConversationCommandV4`]: ({ envelope }) => {
              traffic.commands.push(envelope);
              return {
                commandId: envelope.commandId,
                sessionId: taskId,
                status: "accepted",
                acceptedAt: Date.now(),
                result: { type: "inputDisposition", delivery: "startNow" },
              };
            },
          },
          exposeChannels(server, channels) {
            const channelClient = {
              getChannel: (name) => {
                const channel = channels.get(name);
                return {
                  call: (method, args) => channel.call("fixture", method, args),
                  listen: (event, args) => channel.listen("fixture", event, args),
                };
              },
            };
            const accessor = new RemoteServiceAccess(channelClient);
            const local = new contracts.ServiceCollection();
            for (const descriptor of Object.values(contracts)) {
              if (
                descriptor &&
                typeof descriptor === "object" &&
                typeof descriptor.channelName === "string"
              )
                local.register(
                  descriptor,
                  ProxyChannel.toService(channelClient.getChannel(descriptor.channelName)),
                );
            }
            local
              .register(contracts.IFeedbackService, baseFeedback)
              .register(contracts.IGenUiService, baseGenUi);
            const services = remote
              ? createServerRemoteWorkspaceServiceCollection({
                  clientConfigService: accessor.clientConfigService,
                  connectionServices: accessor,
                  targetKind: "ssh",
                  virtualProjects: true,
                  sourceServices: local,
                })
              : local;
            exposeWindowHostAttachmentServices({
              server,
              services,
              clientMode: "web-remote-replayable",
              attachmentScope: { kind: remote ? "remote" : "local" },
              windowServices: local,
            });
          },
        }),
      );
    };
    socket.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "auth_init")
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "e2e-device", pair_status: "matched" }),
        );
      if (m.type === "pair_status_query")
        socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
      const p = m.payload;
      if (!p) return;
      if (p.zcode_type === "rpc-frame" || p.zcode_type === "rpc-frame-ack") {
        bridges.get(p.bridgeSessionId)?.acceptPayload(p);
        return;
      }
      const result = {
        windowControlSessionId: "e2e-device",
        desktopAppVersion: "3.16.3",
        workspaces: [workspace],
        initialViewState: { activeWorkspaceKey: workspaceKey, activeTaskId: taskId, updatedAt: 1 },
      };
      if (p.zcode_type === "bootstrap-request" || p.zcode_type === "workspace-list-request")
        send(socket, {
          zcode_type: p.zcode_type.replace("request", "response"),
          requestId: p.requestId,
          success: true,
          result,
        });
      if (p.zcode_type === "mobile-view-state-update")
        send(socket, { zcode_type: "mobile-view-state-updated", requestId: p.requestId });
      if (p.zcode_type === "workspace-bridge-open") {
        traffic.opens.push(p);
        ready(p);
      }
    });
  });
  async function hydrate() {
    await assertEventually(() => snapshots.has(currentBridge?.bridgeSessionId));
    snapshots.get(currentBridge.bridgeSessionId)();
    await page.getByText(`E2E_MRO01_${taskId}_HISTORY`, { exact: true }).waitFor();
  }
  try {
    await page.goto(
      new URL("remote/v4?app_version=3.16.3&sid=e2e-device&mid=e2e-mid", origin).href,
      { waitUntil: "domcontentloaded" },
    );
    // 通过真实项目/任务入口打开已有会话，禁用引导由隔离服务判定。
    await page.getByText("E2E_MRS_TASK", { exact: true }).first().click();
    await hydrate();
    // 只用产品 store 打开表单；提交按钮、输入、RPC 和后台 job 都走真实代码。
    await page.evaluate(async (root) => {
      const { useFeedbackStore } = await import(
        `${"/@fs"}${root}/packages/ui/src/feedback/feedbackStore.ts`
      );
      useFeedbackStore
        .getState()
        .openSubmit({ description: "E2E_MRS_FEEDBACK", includeLogs: false });
    }, root);
    await page
      .getByRole("button", { name: /^(提交反馈|Submit feedback|提交|Submit)$/ })
      .last()
      .click();
    await assertEventually(() => traffic.feedback.length === 1);
    assert.equal(traffic.feedback[0].device.deviceMid, "E2E_CONTROLLER");
    await page.keyboard.press("Escape");
    const input = page
      .getByTestId(TID_V4_COMPOSER_INPUT)
      .locator('[contenteditable="true"]')
      .or(page.locator(`[data-testid="${TID_V4_COMPOSER_INPUT}"][contenteditable="true"]`))
      .first();
    await input.fill("E2E_MRS_NORMAL");
    await page.getByTestId(TID_V4_COMPOSER_SEND).click();
    await assertEventually(() => traffic.commands.some((e) => e.type === "sendText"));
    assert.equal(traffic.genUi.length, 1, "发送必须读取控制端 Gen UI，不能超时跳过");
    assert.equal(traffic.genUi[0].workspacePath, workspacePath);
    assert.equal(traffic.genUi[0].workspaceIdentity, workspaceIdentity);
    const commandCount = traffic.commands.length;
    holdRead = true;
    await input.fill("E2E_MRS_PENDING");
    await page.getByTestId(TID_V4_COMPOSER_SEND).click();
    await assertEventually(() => Boolean(heldRead));
    const oldBridge = currentBridge;
    send(socketRef, {
      zcode_type: "bridge-degraded",
      bridgeSessionId: oldBridge.bridgeSessionId,
      reason: "rpc-transport-fault",
    });
    await assertEventually(() => currentBridge.bridgeSessionId !== oldBridge.bridgeSessionId);
    await hydrate();
    await page.waitForFunction(
      (marker) =>
        Array.from(document.querySelectorAll('[contenteditable="true"]')).some((e) =>
          e.textContent.includes(marker),
        ),
      "E2E_MRS_PENDING",
    );
    heldRead();
    holdRead = false;
    assert.equal(traffic.commands.length, commandCount, "旧请求迟到不得自动提交正文");
    await page.getByTestId(TID_V4_COMPOSER_SEND).click();
    await assertEventually(() => traffic.commands.length === commandCount + 1);
    assert.equal(traffic.commands.at(-1).payload.text.includes("E2E_MRS_PENDING"), true);
    assert.equal(
      traffic.errors.some((e) => /Channel name '(feedback|gen-ui)' timed out/.test(e)),
      false,
    );
    await page.screenshot({ path: resolve(artifacts, `${prefix}.png`) });
    assert.deepEqual(h.errors, []);
    return { prefix, result: "passed", traffic };
  } catch (error) {
    await page.screenshot({ path: resolve(artifacts, `${prefix}-failed.png`) });
    await writeFile(
      resolve(artifacts, `${prefix}-failed.json`),
      JSON.stringify(
        {
          error: String(error),
          traffic,
          pageErrors: h.errors,
          body: await page.locator("body").innerText(),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    for (const b of bridges.values()) b.dispose();
    await h.context.close();
  }
}
try {
  results.push(await boundaryControls());
  for (const config of [
    { width: 390, theme: "zai-light", locale: "zh-CN", remote: true },
    { width: 1440, theme: "zai-dark", locale: "en-US", remote: false },
  ])
    results.push(await scenario(config));
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  await vite.close();
}
