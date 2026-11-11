// 开发工具独立 E2E：使用真实 Vite 配置和 Electron renderer，不启动业务服务或连接账号。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { _electron as electron } from "playwright-core";
import { build, createServer } from "vite";

const desktopRoot = resolve(import.meta.dirname, "../../../../../..");
const require = createRequire(import.meta.url);

test(
  "RS04/05: Scan observes renders only in the enabled development entry",
  { timeout: 90_000 },
  async () => {
    const cacheRoot = resolve(desktopRoot, ".e2e-cache");
    await mkdir(cacheRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(resolve(cacheRoot, "react-scan-"));
    const artifactRoot = resolve(desktopRoot, ".e2e-artifacts", `react-scan-dev-${Date.now()}`);
    await mkdir(artifactRoot, { recursive: true });
    const previousFlag = process.env.ZCODE_REACT_SCAN;
    const errors = [];
    let app;
    let server;
    try {
      await writeFile(
        resolve(fixtureRoot, "index.html"),
        `<!doctype html>
      <html><head><title>React Scan development probe</title>
      <script>window.scanReadyBeforeReact = typeof window.reactScan === 'function';</script>
      </head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`,
      );
      await writeFile(
        resolve(fixtureRoot, "main.js"),
        `
      import { createElement, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      window.scanRenders = 0;
      window.reactScan?.({ onRender(fiber) {
        if (fiber.type?.name === 'RenderProbe') window.scanRenders++;
      }});
      function RenderProbe() {
        const [count, setCount] = useState(0);
        return createElement('button', {onClick: () => setCount(value => value + 1)}, 'Count: ' + count);
      }
      createRoot(document.getElementById('root')).render(createElement(RenderProbe));
    `,
      );
      await writeFile(
        resolve(fixtureRoot, "electron.cjs"),
        `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(resolve(fixtureRoot, "user-data"))});
      app.whenReady().then(() => {
        const win = new BrowserWindow({ width: 1100, height: 800,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        win.loadURL(process.env.REACT_SCAN_TEST_URL);
      });
      app.on('window-all-closed', () => app.quit());
    `,
      );

      for (const enabled of [true, false]) {
        process.env.ZCODE_REACT_SCAN = enabled ? "1" : "0";
        server = await createServer({
          configFile: resolve(desktopRoot, "vite.config.ts"),
          root: fixtureRoot,
          mode: "development",
          cacheDir: resolve(fixtureRoot, ".vite"),
          server: { port: 0, host: "127.0.0.1", watch: null },
          optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client"] },
          logLevel: "error",
        });
        await server.listen();
        app = await electron.launch({
          executablePath: require("electron"),
          args: [resolve(fixtureRoot, "electron.cjs")],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "",
            REACT_SCAN_TEST_URL: server.resolvedUrls.local[0],
          },
        });
        const page = await app.firstWindow();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.getByRole("button", { name: "Count: 0", exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.scanReadyBeforeReact), enabled);
        if (enabled) {
          await page.waitForFunction(() => window.scanRenders > 0);
          await page.locator("#react-scan-toolbar-root button").first().waitFor();
          const initialRenders = await page.evaluate(() => window.scanRenders);
          await page.getByRole("button", { name: "Count: 0", exact: true }).click();
          await page.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
          await page.waitForFunction((initial) => window.scanRenders > initial, initialRenders);
          // 刷新重新创建页面；hook 必须再次早于 React 就绪。
          await page.reload();
          await page.waitForFunction(() => window.scanReadyBeforeReact && window.scanRenders > 0);
          await page.locator("#react-scan-toolbar-root button").first().waitFor();
          assert.equal(await page.locator("#react-scan-toolbar-root").count(), 1);
          await page.screenshot({ path: resolve(artifactRoot, "scan-enabled.png") });
        } else {
          await page.getByRole("button", { name: "Count: 0", exact: true }).click();
          await page.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
          assert.equal(await page.evaluate(() => window.scanRenders), 0);
          assert.equal(await page.locator("#react-scan-toolbar-root").count(), 0);
        }
        await app.close();
        app = undefined;
        await server.close();
        server = undefined;
      }

      process.env.ZCODE_REACT_SCAN = "1";
      const result = await build({
        configFile: resolve(desktopRoot, "vite.config.ts"),
        root: fixtureRoot,
        mode: "production",
        logLevel: "error",
        build: {
          outDir: resolve(fixtureRoot, "dist"),
          sourcemap: false,
          rollupOptions: { input: resolve(fixtureRoot, "index.html") },
        },
      });
      const html = await readFile(resolve(fixtureRoot, "dist/index.html"), "utf8");
      assert.ok(!html.includes("react-scan"));
      for (const bundle of Array.isArray(result) ? result : [result]) {
        for (const output of bundle.output) {
          if (output.type === "chunk") {
            assert.ok(
              Object.keys(output.modules).every(
                (id) => !id.replaceAll("\\", "/").includes("/react-scan/"),
              ),
            );
          }
        }
      }
      assert.deepEqual(errors, []);
      process.stdout.write(`React Scan runtime evidence: ${artifactRoot}\n`);
    } finally {
      await app?.close();
      await server?.close();
      if (previousFlag === undefined) delete process.env.ZCODE_REACT_SCAN;
      else process.env.ZCODE_REACT_SCAN = previousFlag;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);
