// 手机浏览器验收：真实记忆组件 + WebSocket RPC + 隔离 SettingService 落盘。
// SSH 链路另由 conversation-session-remote-memory-settings.test.ts 验证。
// 运行：pnpm exec tsx packages/desktop/test/e2e/settings/agent/manual-review/pending/memory-settings-mobile.mjs
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
  ISettingService,
  IMemoryService,
  IOnboardingRecordService,
  ServiceCollection,
} from "@zcode/services";
import { createSettingService } from "@zcode/services/node";

const repoRoot = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const artifacts = resolve(repoRoot, "packages/desktop/.e2e-artifacts/memory-settings-mobile");
const root = await mkdtemp(resolve(tmpdir(), "memory-settings-mobile-"));
await mkdir(artifacts, { recursive: true });
const targets = {};
const previousDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
try {
  for (const name of ["local", "remote"]) {
    // SettingService 按实例捕获 home，不读取 dataBaseDir；必须在构造前隔离实际目录。
    process.env.ZCODE_DESKTOP_HOME_DIR = resolve(root, name);
    const settings = createSettingService();
    await settings.update({ memoryEnabled: false, locale: "zh-CN" });
    targets[name] = settings;
  }
} finally {
  if (previousDesktopHome === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
  else process.env.ZCODE_DESKTOP_HOME_DIR = previousDesktopHome;
}
let catalogReads = 0;
const entryId = resolve(repoRoot, "packages/desktop/memory-mobile-entry.js");
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { connectViaWebSocket } from '@zcode/client';
import { Event } from '@zcode/rpc';
import { ServiceProvider } from '@/hooks/useServices.js';
import { PlatformProvider } from '@/hooks/usePlatform.js';
import { StoreProvider } from '@/store/StoreProvider.js';
import { ZCodeIntlProvider } from '@/i18n/IntlProvider.js';
import { MemorySettingsPage } from '@/settings/MemorySettingsSection.js';
import '@/styles.css';
const services = await connectViaWebSocket('ws://' + location.host + '/memory-rpc?target=' + new URLSearchParams(location.search).get('target'));
const h = React.createElement;
const platform = { getDeviceId: () => 'mobile-memory', reportTelemetryEvent: async () => {} };
const broadcast = { onMessage: Event.None, send: async () => {} };
createRoot(document.getElementById('root')).render(
  h(ServiceProvider, {services}, h(PlatformProvider, {platform},
    h(StoreProvider, {broadcastService: broadcast}, h(ZCodeIntlProvider, null,
      h('main', {style: {background: 'var(--color-background)', color: 'var(--color-foreground)', minHeight: '100vh', padding: 16}},
        h(MemorySettingsPage, {isDesktop: false, workspaceDisplayNames: []})))))));
`;
const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "memory-mobile-fixture",
      resolveId: (id) => (id === "/memory-mobile-entry.js" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/memory-fixture?")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              request.url,
              '<meta name="viewport" content="width=device-width, initial-scale=1"><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/memory-mobile-entry.js"></script></body>',
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
const websocket = new WebSocketServer({ noServer: true });
websocket.on("connection", (socket, request) => {
  const target = new URL(request.url, "http://localhost").searchParams.get("target");
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
  const server = new ChannelServer(protocol, "memory-mobile");
  new ServiceCollection()
    .register(ISettingService, targets[target])
    .register(IOnboardingRecordService, { updateRecordPreferences: async () => {} })
    .register(IMemoryService, {
      listProjectMemories: async () => {
        catalogReads++;
        throw new Error("手机不能读取 catalog");
      },
    })
    .exposeOnChannelServer(server);
  socket.on("message", (data) => onData.fire(VSBuffer.wrap(new Uint8Array(data))));
  socket.on("close", () => {
    onClose.fire();
    server.dispose();
    onData.dispose();
    onClose.dispose();
  });
});
vite.httpServer.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/memory-rpc?"))
    websocket.handleUpgrade(request, socket, head, (ws) =>
      websocket.emit("connection", ws, request),
    );
});
let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const target of ["local", "remote"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}/memory-fixture?target=${target}`);
      const toggle = page.getByTestId("settings-memory-switch");
      await toggle.waitFor({ timeout: 30_000 });
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      assert.equal(await page.getByTestId("settings-memory-device-trigger").count(), 0);
      await toggle.tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="settings-memory-switch"]')
            ?.getAttribute("aria-checked") === "true",
      );
      assert.equal((await targets[target].get()).memoryEnabled, true);
      assert.equal(
        (await targets[target === "local" ? "remote" : "local"].get()).memoryEnabled,
        false,
      );
      for (const width of [390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        for (const theme of ["light", "dark"]) {
          await page.evaluate((theme) => {
            document.documentElement.classList.toggle("dark", theme === "dark");
            document.documentElement.classList.remove("theme-zai-light", "theme-zai-dark");
            document.documentElement.classList.add(`theme-zai-${theme}`);
          }, theme);
          await page.screenshot({ path: resolve(artifacts, `${target}-${theme}-${width}.png`) });
        }
      }
      await toggle.tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="settings-memory-switch"]')
            ?.getAttribute("aria-checked") === "false",
      );
      assert.equal((await targets[target].get()).memoryEnabled, false);
      assert.deepEqual(errors, []);
      console.log(`PASS MEM-DEVICE-MOBILE ${target}`);
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, "failure.png") });
      console.error(errors);
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.equal(catalogReads, 0);
} finally {
  await browser?.close();
  for (const socket of websocket.clients) socket.terminate();
  await new Promise((done) => websocket.close(done));
  await vite.close();
  await rm(root, { recursive: true, force: true });
}
