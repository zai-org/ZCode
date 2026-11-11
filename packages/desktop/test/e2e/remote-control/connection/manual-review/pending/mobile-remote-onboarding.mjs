// ONBOARD-REMOTE-01：真实引导组件、远程服务装配、手机 attachment allowlist 与 WebSocket RPC 的浏览器边界回归。
// 首页按钮/Root key 重建由夹具驱动；不覆盖真实 relay 配对或 SSH/WSL/Docker transport。
// R3 下 SSH/WSL/Docker 与 Server 都走 Source 全转发，引导记录 owner 是 Source，不是本机 Local Host。
// 运行：pnpm exec tsx packages/desktop/test/e2e/remote-control/connection/manual-review/pending/mobile-remote-onboarding.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { WebSocketServer } from "ws";
import { ChannelServer, Emitter, Event, SocketProtocol, VSBuffer } from "@zcode/rpc";
import {
  IBroadcastService,
  IOnboardingRecordService,
  ISettingService,
  ServiceCollection,
} from "@zcode/services";
import { setDataBaseDir } from "@zcode/services/node";
import { createOnboardingRecordService } from "../../../../../../../services/src/onboarding/onboardingRecordService.js";
import { createServerRemoteWorkspaceServiceCollection } from "../../../../../../src/host/remoteWorkspaceServiceCollection.js";
import { exposeWindowHostAttachmentServices } from "../../../../../../src/host/windowHostAttachmentRpcPolicy.js";

const repoRoot = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const artifacts = resolve(repoRoot, ".tmp/mobile-remote-onboarding-e2e");
const dataDir = await mkdtemp(resolve(tmpdir(), "onboarding-remote-e2e-"));
await mkdir(artifacts, { recursive: true });
setDataBaseDir(dataDir);
const localRecord = createOnboardingRecordService({
  loadUserId: async () => "desktop-user",
  hasExistingLocalTask: async () => false,
});
const sourceRecord = createOnboardingRecordService({
  loadUserId: async () => "source-user",
  hasExistingLocalTask: async () => false,
});
const broadcastService = { onMessage: Event.None, send: async () => {} };
const connectionServices = new Proxy(
  {
    onboardingRecordService: sourceRecord,
    zcodeAgentService: { onDynamicSessionRuntimePreferencesRequest: () => Event.None },
  },
  { get: (target, key) => target[key] ?? {} },
);
const clientConfigService = { getSnapshot: async () => ({ pluginStoreOrder: null }) };
// 真实 Host 传入的 sourceServices 含本机记录服务；用例借此证明远程集合不会回落到本机记录。
const sourceServices = new ServiceCollection().register(IOnboardingRecordService, localRecord);
const targetKinds = ["ssh", "server"];
const collections = Object.fromEntries(
  targetKinds.map((targetKind) => [
    targetKind,
    createServerRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices,
      targetKind,
      sourceServices,
    }),
  ]),
);
// settings 故意没有 onboardingOccupation，确保通过来自真实记录 owner 的判定进入任务。
for (const services of Object.values(collections)) {
  services.register(ISettingService, {
    get: async () => ({ locale: "zh-CN" }),
    update: async () => {},
  });
  services.register(IBroadcastService, broadcastService);
}

const entryId = resolve(repoRoot, "packages/desktop/onboarding-e2e-entry.js");
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { connectViaWebSocket } from '@zcode/client';
import { Event } from '@zcode/rpc';
import { ServiceProvider } from '@/hooks/useServices.js';
import { PlatformProvider } from '@/hooks/usePlatform.js';
import { StoreProvider } from '@/store/StoreProvider.js';
import { ZCodeIntlProvider } from '@/i18n/IntlProvider.js';
import { OccupationOnboarding } from '@/onboarding/OccupationOnboarding.js';
import '@/styles.css';
const h = React.createElement;
const platform = { getDeviceId: () => 'browser-onboarding', reportTelemetryEvent: async () => {} };
const broadcast = { onMessage: Event.None, send: async () => {} };
function Fixture() {
  const [bridge, setBridge] = useState(null);
  const open = async () => {
    const services = await connectViaWebSocket('ws://' + location.host + '/onboarding-rpc?kind=' + new URLSearchParams(location.search).get('kind'));
    setBridge({services, id: crypto.randomUUID()});
  };
  return h(React.Fragment, null,
    h('button', {onClick: open}, '新建远程任务'),
    bridge && h(ServiceProvider, {key: bridge.id, services: bridge.services},
      h(PlatformProvider, {platform}, h(StoreProvider, {broadcastService: broadcast},
        h(ZCodeIntlProvider, null,
          h(OccupationOnboarding, null, h('div', {'data-testid': 'task-draft', 'data-bridge-id': bridge.id}, '远程任务草稿')))))));
}
createRoot(document.getElementById('root')).render(h(Fixture));
`;
const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "onboarding-e2e-fixture",
      resolveId: (id) => (id === "/onboarding-e2e-entry.js" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/onboarding-fixture?")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<div id="root"></div><script type="module" src="/onboarding-e2e-entry.js"></script>',
            ),
          );
        });
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": resolve(repoRoot, "packages/ui/src") } },
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react/jsx-runtime"] },
});
const wsServer = new WebSocketServer({ noServer: true });
const rpcErrors = [];
wsServer.on("connection", (socket, req) => {
  const kind = new URL(req.url, "http://localhost").searchParams.get("kind");
  const onData = new Emitter();
  const onClose = new Emitter();
  const protocol = new SocketProtocol({
    onData: onData.event,
    onClose: onClose.event,
    onEnd: Event.None,
    write: (buffer) => socket.send(buffer.buffer),
    end: () => socket.close(),
    drain: async () => {},
    dispose: () => {},
  });
  const server = new ChannelServer(protocol, "mobile-onboarding", 1000);
  // 与真实手机 attachment 相同的 allowlist；漏放行 onboarding-record 时调用会超时。
  exposeWindowHostAttachmentServices({
    server,
    services: collections[kind],
    clientMode: "web-remote-replayable",
  });
  socket.on("message", (data) => onData.fire(VSBuffer.wrap(new Uint8Array(data))));
  socket.on("error", (error) => rpcErrors.push(error.message));
  socket.on("close", () => {
    onClose.fire();
    server.dispose();
    onData.dispose();
    onClose.dispose();
  });
});
vite.httpServer.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/onboarding-rpc?"))
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
});
let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const kind of targetKinds) {
    const owner = sourceRecord;
    const other = localRecord;
    for (const completed of [true, false]) {
      await owner.clearRecords();
      if (completed)
        await owner.appendRecord("browser-onboarding", {
          occupation: "developer",
          interfaceMode: "coding",
          memoryEnabled: false,
          proactiveSuggestionsEnabled: false,
          completedAt: "2026-10-09T00:00:00.000Z",
        });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: "zh-CN",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.text().includes("occupation-onboarding") && message.type() === "warning")
          errors.push(message.text());
      });
      page.setDefaultTimeout(15_000);
      try {
        await page.goto(`${origin}/onboarding-fixture?kind=${kind}`);
        await page.getByRole("button", { name: "新建远程任务", exact: true }).click();
        const onboarding = page.getByTestId("onboarding-page");
        const draft = page.getByTestId("task-draft");
        if (!completed) {
          await onboarding.waitFor();
          await page.keyboard.press("Escape");
        }
        await draft.waitFor();
        // 关闭的 RPC 已落盘后再重新挂载，避免把写入途中的第二次点击混进本次接线回归。
        await assertEventually(async () => !(await owner.shouldOnboard("browser-onboarding")));
        const previousBridgeId = await draft.getAttribute("data-bridge-id");
        await page.getByRole("button", { name: "新建远程任务", exact: true }).click();
        await page.waitForFunction((previous) => {
          const current = document
            .querySelector('[data-testid="task-draft"]')
            ?.getAttribute("data-bridge-id");
          return Boolean(current && current !== previous);
        }, previousBridgeId);
        await draft.waitFor();
        assert.equal(await onboarding.count(), 0);
        assert.equal(
          await other.shouldOnboard("browser-onboarding"),
          true,
          "不能写入另一侧身份的记录",
        );
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: resolve(artifacts, `${kind}-${completed ? "completed" : "dismissed"}.png`),
        });
        console.log(`PASS ONBOARD-REMOTE-01 ${kind} ${completed ? "completed" : "dismissed"}`);
      } catch (error) {
        await page.screenshot({ path: resolve(artifacts, "failure.png") });
        console.error(await page.locator("body").innerText(), errors);
        throw error;
      } finally {
        await context.close();
      }
    }
  }
  assert.deepEqual(rpcErrors, []);
} finally {
  await browser?.close();
  for (const socket of wsServer.clients) socket.terminate();
  await new Promise((done) => wsServer.close(done));
  await vite.close();
  setDataBaseDir(null);
  await rm(dataDir, { recursive: true, force: true });
}
async function assertEventually(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail("引导关闭记录未落盘");
}
