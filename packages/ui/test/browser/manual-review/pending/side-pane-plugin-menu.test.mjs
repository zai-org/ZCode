import { registerSidePaneWidthCases } from "./side-pane-width-motion.cases.mjs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/side-pane-plugin-menu.fixture.tsx";
const surfaces = ["hello", "canvas", "development"].map((id) => ({
  id,
  pluginId: `${id}@example`,
  pluginName: id,
  title: {
    en: id === "hello" ? "Hello panel" : "Canvas",
    "zh-CN": id === "hello" ? "Hello 面板" : "画布",
  },
  server: `plugin:${id}:server`,
  resourceUri: `ui://${id}/panel.html`,
}));
const catalog = (entries, installed = true, enabled = true) => ({
  plugins: installed
    ? entries.map((surface) => ({
        id: surface.pluginId,
        name: surface.pluginName,
        marketplace: surface.pluginId.split("@")[1],
        enabled,
        uiSurfaces: [surface],
      }))
    : [],
  availablePlugins: entries.map((surface) => ({
    id: surface.pluginId,
    name: surface.pluginName,
    marketplace: surface.pluginId.split("@")[1],
    installed,
  })),
  marketplaces: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
});
const add = "[data-side-pane-add-tab-trigger]";
const activeLauncher = '[role="tabpanel"][data-state="active"]';
const newTabItems = `${activeLauncher} [data-side-pane-open-tab-item^="plugin-ui:"]`;
const launcherItems = '[data-side-pane-open-tab-item^="plugin-ui:"]';
let server, browser, origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "plugin-menu-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await Promise.all([
    browser?.close().then(() => console.info("Fixture browser closed")),
    server?.close().then(() => console.info("Fixture server closed")),
  ]);
});

registerSidePaneWidthCases(
  () => browser,
  () => origin,
);

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`SPT-E2E-007 ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(120000);
    const errors = [];
    const scopes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const query = `locale=${locale}&theme=${theme}${width < 500 ? "&mobile=1" : ""}`;
    await page.route("**/surfaces", (route) => {
      scopes.push(route.request().postDataJSON());
      return route.fulfill({ json: surfaces });
    });
    const configGate = Promise.withResolvers();
    const catalogGate = Promise.withResolvers();
    const configStarted = Promise.withResolvers();
    const catalogStarted = Promise.withResolvers();
    await page.route("**/client-config", async (route) => {
      configStarted.resolve();
      await configGate.promise;
      return route.fulfill({
        json: {
          code: 0,
          data: {
            configs: {
              uiPluginRecommendations: [...surfaces.slice(0, 2), surfaces[0]]
                .map((surface) => ({ pluginId: surface.pluginId, surfaceId: surface.id }))
                .concat([{ pluginId: "missing@example", surfaceId: "missing" }]),
            },
          },
        },
      });
    });

    await page.route("**/catalog", async (route) => {
      catalogStarted.resolve();
      await catalogGate.promise;
      return route.fulfill({ json: catalog(surfaces) });
    });
    const read = (id) => page.getByTestId(id).textContent().then(JSON.parse);
    try {
      await page.goto(`${origin}fixture?${query}`, { waitUntil: "domcontentloaded" });
      await Promise.all([configStarted.promise, catalogStarted.promise]);
      await page.getByTestId("side-pane-ui-loading").waitFor();
      assert.equal(await page.getByTestId("side-pane-ui-empty").count(), 0);
      const configResponse = page.waitForResponse("**/client-config");
      configGate.resolve();
      await (await configResponse).finished();
      // 配置先到、市场目录仍在途，也不能闪现空态。
      assert.equal(await page.getByTestId("side-pane-ui-empty").count(), 0);
      assert.equal(await page.getByTestId("side-pane-ui-loading").count(), 1);
      const loadingArtifacts = join(tmpdir(), "zcode-side-pane-plugin-menu");
      await mkdir(loadingArtifacts, { recursive: true });
      await page.screenshot({ path: join(loadingArtifacts, `loading-${width}-${theme}.png`) });
      catalogGate.resolve();
      await page.locator(launcherItems).first().waitFor();
      assert.equal(await page.locator(launcherItems).count(), 2);
      assert.equal(await page.getByTestId("side-pane-plugin-market").count(), 1);
      const artifacts = join(tmpdir(), "zcode-side-pane-plugin-menu");
      await mkdir(artifacts, { recursive: true });
      // 空态启动页与原型对照：横向行、短分割线、UI 插件区。
      await page.screenshot({ path: join(artifacts, `launcher-${width}-${locale}-${theme}.png`) });
      await page.locator(launcherItems).first().click();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="request"]').textContent) !== null,
      );
      const expected = await read("request");
      assert.deepEqual(expected, {
        parentSessionId: "session-fixture",
        surfaceId: "hello",
        serverName: "plugin:hello:server",
        pluginId: "hello@example",
        resourceUri: "ui://hello/panel.html",
        title: locale === "zh-CN" ? "Hello 面板" : "Hello panel",
        workspacePath: "/workspace/example",
        workspaceIdentity: "fixture-workspace",
        remoteSessionId: null,
      });
      await page.getByTestId("show-tabs").click();
      await page.locator(add).click();
      await page.locator(newTabItems).first().waitFor();
      assert.equal(await page.locator(newTabItems).count(), 2);
      assert.match(
        await page.locator(newTabItems).first().textContent(),
        new RegExp(expected.title),
      );
      const box = await page.locator(activeLauncher).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 800);
      await page.screenshot({ path: join(artifacts, `${width}-${locale}-${theme}.png`) });
      await page.locator(newTabItems).first().click();
      await page.locator(activeLauncher).waitFor();
      assert.deepEqual(await read("request"), expected);
      assert.equal((await read("opened")).tabs.length, 1);
      // 原菜单方向键合同已移除；新标签页启动行使用原生按钮的 Tab/Enter。
      await page.locator(add).focus();
      await page.keyboard.press("Enter");
      await page.locator(newTabItems).last().waitFor();
      await page.locator(newTabItems).first().focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .locator(newTabItems)
          .last()
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="request"]').textContent)?.surfaceId ===
          "canvas",
      );
      assert.equal((await read("request")).surfaceId, "canvas");
      assert.equal((await read("opened")).tabs.length, 2);
      assert.ok(scopes.every((scope) => scope.workspaceIdentity === "fixture-workspace"));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      // 推荐区直接安装、启用；每次成功后必须另点打开，不能自动打开。
      let installed = false,
        enabled = false;
      const mutations = [];
      await page.unroute("**/catalog");
      await page.route("**/catalog", (route) =>
        route.fulfill({ json: catalog(surfaces, installed, enabled) }),
      );
      await page.route("**/install", (route) => {
        mutations.push(route.request().postDataJSON());
        installed = true;
        return route.fulfill({ json: { diagnostics: [] } });
      });
      await page.route("**/enable", (route) => {
        mutations.push(route.request().postDataJSON());
        enabled = true;
        return route.fulfill({ json: { enabled: true, diagnostics: [] } });
      });
      await page.goto(`${origin}fixture?${query}`);
      const first = page.locator(launcherItems).first();
      await first.getByText(locale === "zh-CN" ? "安装" : "Install", { exact: true }).waitFor();
      assert.equal(await page.locator(launcherItems).count(), 2);
      await page.screenshot({
        path: join(artifacts, `uninstalled-${width}-${locale}-${theme}.png`),
      });
      await first.click();
      await first.getByText(locale === "zh-CN" ? "启用" : "Enable", { exact: true }).waitFor();
      assert.equal(await read("request"), null);
      assert.equal(mutations[0].scope, "user");
      await page.screenshot({ path: join(artifacts, `disabled-${width}-${locale}-${theme}.png`) });
      await first.click();
      await first.getByText(locale === "zh-CN" ? "打开" : "Open", { exact: true }).waitFor();
      assert.equal(await read("request"), null);
      assert.equal(mutations[1].scope, "workspace");
      await first.click();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="request"]').textContent) !== null,
      );
      assert.equal((await read("request")).pluginId, surfaces[0].pluginId);
      installed = false;
      enabled = false;
      await page.goto(`${origin}fixture?${query}&existing=1`);
      await page.locator(add).click();
      const newTabFirst = page.locator(newTabItems).first();
      await newTabFirst
        .getByText(locale === "zh-CN" ? "安装" : "Install", { exact: true })
        .waitFor();
      await newTabFirst.click();
      await newTabFirst
        .getByText(locale === "zh-CN" ? "启用" : "Enable", { exact: true })
        .waitFor();
      assert.equal(await read("request"), null);
      await newTabFirst.click();
      await newTabFirst.getByText(locale === "zh-CN" ? "打开" : "Open", { exact: true }).waitFor();
      assert.equal(await read("request"), null);
      await newTabFirst.click();
      await page.locator(activeLauncher).waitFor();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="request"]').textContent) !== null,
      );
      for (const config of [{}, { uiPluginRecommendations: [] }, null]) {
        await page.unroute("**/client-config");
        await page.route("**/client-config", (route) =>
          route.fulfill(
            config === null ? { status: 503 } : { json: { code: 0, data: { configs: config } } },
          ),
        );
        await page.goto(`${origin}fixture?${query}`);
        await page.getByTestId("side-pane-ui-empty").waitFor();
        assert.equal(await page.locator(launcherItems).count(), 0);
      }
      await page.unroute("**/client-config");
      await page.route("**/client-config", (route) =>
        route.fulfill({
          json: {
            code: 0,
            data: {
              configs: {
                uiPluginRecommendations: surfaces
                  .slice(0, 2)
                  .map((surface) => ({ pluginId: surface.pluginId, surfaceId: surface.id })),
              },
            },
          },
        }),
      );
      for (const mode of ["draft", "noHost", "noBridge"]) {
        let calls = 0;
        await page.unroute("**/surfaces");
        await page.route("**/surfaces", (route) => {
          calls++;
          return route.fulfill({ json: [] });
        });
        await page.goto(`${origin}fixture?${query}&existing=1&${mode}=1`);
        await page.locator(add).click();
        await page.locator(activeLauncher).waitFor();
        assert.equal(await page.locator(newTabItems).count(), 0, mode);
        if (mode === "draft") {
          assert.equal(
            await page.locator('[data-testid="side-pane-ui-recommendations"]').count(),
            0,
          );
          assert.equal(await page.locator('[data-testid="side-pane-plugin-market"]').count(), 0);
        }
        assert.equal(calls, 0, mode);
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      const diagnostic = `${String(error)}; pageErrors=${JSON.stringify(errors)}; body=${(await page.locator("body").innerText()).slice(0, 1500)}`;
      console.error(diagnostic);
      throw new Error(diagnostic, { cause: error });
    } finally {
      await page.close();
    }
  });
}

if (process.env.ZCODE_UI_RECOMMENDATIONS_LIVE_CONFIG_URL) {
  test("staging client config drives side pane recommendations", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(15000);
    try {
      const response = await page.request.get(process.env.ZCODE_UI_RECOMMENDATIONS_LIVE_CONFIG_URL);
      assert.equal(response.status(), 200);
      const envelope = await response.json();
      assert.equal(envelope.code, 0);
      const entries = envelope.data.configs.uiPluginRecommendations;
      assert.ok(entries.length > 0);
      assert.ok(entries.every((entry) => entry.pluginId.endsWith("@zcode-plugins-official")));
      await page.route("**/client-config", (route) => route.fulfill({ json: envelope }));
      await page.route("**/catalog", (route) =>
        route.fulfill({
          json: catalog(
            entries.map((entry) => ({ pluginId: entry.pluginId, pluginName: entry.pluginId })),
          ),
        }),
      );
      // 此处只验证真实配置到组件的链路；工作区可用面板由夹具提供，不代表安装验证。
      await page.route("**/surfaces", (route) =>
        route.fulfill({
          json: entries.map((entry) => ({
            id: entry.surfaceId,
            pluginId: entry.pluginId,
            pluginName: entry.pluginId,
            title: entry.surfaceId,
            server: "fixture-server",
            resourceUri: "ui://fixture/panel.html",
          })),
        }),
      );
      await page.goto(`${origin}fixture?locale=zh-CN&theme=light`);
      await page.locator(launcherItems).first().waitFor();
      assert.equal(await page.locator(launcherItems).count(), entries.length);
      await page.screenshot({
        path: join(tmpdir(), "zcode-side-pane-plugin-menu", "staging-recommendations.png"),
      });
      await page.locator(launcherItems).first().click();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="request"]').textContent) !== null,
      );
      const request = JSON.parse(await page.getByTestId("request").textContent());
      assert.equal(request.pluginId, entries[0].pluginId);
      assert.equal(request.surfaceId, entries[0].surfaceId);
    } finally {
      await page.close();
    }
  });
}

test("cold new-tab launcher shows skeleton until config settles", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const gate = Promise.withResolvers();
  try {
    await page.route("**/catalog", (route) => route.fulfill({ json: catalog(surfaces) }));
    await page.route("**/client-config", async (route) => {
      await gate.promise;
      return route.fulfill({ json: { code: 0, data: { configs: {} } } });
    });
    await page.goto(`${origin}fixture?existing=1`);
    await page.locator(add).click();
    await page.getByTestId("side-pane-ui-loading").waitFor();
    assert.equal(await page.getByTestId("side-pane-ui-empty").count(), 0);
    gate.resolve();
    await page.getByTestId("side-pane-ui-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator(newTabItems).count(), 0);
  } finally {
    gate.resolve();
    await page.close();
  }
});

test("SPT-E2E-007 same-plugin surfaces share progress and respect reduced motion", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const gate = Promise.withResolvers();
  const entries = [surfaces[0], { ...surfaces[0], id: "details" }, surfaces[1]];
  let installed = false;
  let installCalls = 0;
  try {
    await page.route("**/catalog", (route) => {
      const result = catalog(surfaces.slice(0, 2), false);
      if (installed) {
        result.plugins = catalog([surfaces[0]]).plugins;
        result.plugins[0].uiSurfaces = entries.slice(0, 2);
        result.availablePlugins[0].installed = true;
      }
      return route.fulfill({ json: result });
    });
    await page.route("**/client-config", (route) =>
      route.fulfill({
        json: {
          code: 0,
          data: {
            configs: {
              uiPluginRecommendations: entries.map((surface) => ({
                pluginId: surface.pluginId,
                surfaceId: surface.id,
              })),
            },
          },
        },
      }),
    );
    await page.route("**/install", async (route) => {
      installCalls++;
      await gate.promise;
      installed = true;
      return route.fulfill({ json: { diagnostics: [] } });
    });
    await page.goto(`${origin}fixture?locale=en-US&theme=light`);
    const items = page.locator(launcherItems);
    await items.first().getByText("Install", { exact: true }).waitFor();
    await items.first().click();
    const spinners = items.getByTestId("side-pane-plugin-progress");
    await spinners.nth(1).waitFor();
    assert.equal(await spinners.count(), 2);
    assert.equal(await items.nth(2).getByText("Install", { exact: true }).count(), 1);
    assert.equal(await items.nth(2).getByTestId("side-pane-plugin-progress").count(), 0);
    assert.deepEqual(
      await items.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-busy")),
      ),
      ["true", "true", null],
    );
    assert.equal(installCalls, 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await spinners.first().isVisible(), true);
    assert.equal(
      await spinners.first().evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    gate.resolve();
    await items.first().getByText("Open", { exact: true }).waitFor();
    await items.nth(1).getByText("Open", { exact: true }).waitFor();
    assert.equal(await spinners.count(), 0);
    assert.equal(await page.getByTestId("request").textContent(), "null");
  } finally {
    gate.resolve();
    await page.close();
  }
});

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  for (const existing of [false, true]) {
    for (const operation of ["install", "enable"]) {
      test(`SPT-E2E-007 progress ${operation}/${existing ? "new-tab" : "empty"}/${width}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        page.setDefaultTimeout(15000);
        const gates = [Promise.withResolvers(), Promise.withResolvers()];
        const attempts = [];
        const errors = [];
        const states = surfaces.map((_, index) => ({
          installed: index === 2 || operation === "enable",
          enabled: index === 2,
        }));
        const action =
          operation === "install"
            ? locale === "zh-CN"
              ? "安装"
              : "Install"
            : locale === "zh-CN"
              ? "启用"
              : "Enable";
        const loading = locale === "zh-CN" ? "加载中..." : "Loading...";
        const open = locale === "zh-CN" ? "打开" : "Open";
        const readCatalog = () => ({
          ...catalog([], false, false),
          plugins: surfaces.flatMap(
            (surface, index) =>
              catalog([surface], states[index].installed, states[index].enabled).plugins,
          ),
          availablePlugins: surfaces.flatMap(
            (surface, index) =>
              catalog([surface], states[index].installed, states[index].enabled).availablePlugins,
          ),
        });
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/surfaces", (route) => route.fulfill({ json: surfaces }));
        await page.route("**/catalog", (route) => route.fulfill({ json: readCatalog() }));
        await page.route("**/client-config", (route) =>
          route.fulfill({
            json: {
              code: 0,
              data: {
                configs: {
                  uiPluginRecommendations: surfaces.map((surface) => ({
                    pluginId: surface.pluginId,
                    surfaceId: surface.id,
                  })),
                },
              },
            },
          }),
        );
        await page.route(`**/${operation}`, async (route) => {
          const attempt = attempts.length;
          attempts.push(route.request().postDataJSON());
          await gates[attempt].promise;
          if (attempt === 0) return route.fulfill({ status: 503 });
          states[1][operation === "install" ? "installed" : "enabled"] = true;
          return route.fulfill({ json: { diagnostics: [] } });
        });
        const selector = existing ? newTabItems : launcherItems;
        const items = page.locator(selector);
        // 安装态会改变展示位置，操作进度按插件身份定位，不依赖列表索引。
        const itemSelector = (index) =>
          `${selector}[data-side-pane-open-tab-item="plugin-ui:${surfaces[index].pluginId}/${surfaces[index].id}"]`;
        const item = (index) => page.locator(itemSelector(index));
        const waitIdle = () =>
          page.waitForFunction(
            (selector) =>
              [...document.querySelectorAll(selector)].every((element) => !element.disabled),
            selector,
          );
        const assertProgress = async (index) => {
          await item(index).getByText(loading, { exact: true }).waitFor();
          assert.equal(await items.getByText(loading, { exact: true }).count(), 1);
          const spinner = item(index).getByTestId("side-pane-plugin-progress");
          assert.equal(await spinner.count(), 1, "操作中的插件应有加载图标");
          assert.equal(await spinner.isVisible(), true);
          assert.notEqual(
            await spinner.evaluate((element) => getComputedStyle(element).animationName),
            "none",
          );
          assert.equal(await items.getByTestId("side-pane-plugin-progress").count(), 1);
          assert.equal(await item(index).getAttribute("aria-busy"), "true");
          assert.equal(await page.locator(`${selector}[aria-busy="true"]`).count(), 1);
          assert.equal(
            await item(1 - index)
              .getByText(action, { exact: true })
              .count(),
            1,
          );
          assert.equal(await item(2).getByText(open, { exact: true }).count(), 1);
          assert.deepEqual(
            await Promise.all([0, 1, 2].map((index) => item(index).isDisabled())),
            [0, 1, 2].map((candidate) => candidate === index),
          );
        };
        try {
          const query = `locale=${locale}&theme=${theme}${width < 500 ? "&mobile=1" : ""}${existing ? "&existing=1" : ""}`;
          await page.goto(`${origin}fixture?${query}`, { waitUntil: "domcontentloaded" });
          if (existing) await page.locator(add).click();
          await item(0).getByText(action, { exact: true }).waitFor();
          await item(0).click();
          await assertProgress(0);
          assert.equal(attempts.length, 1);
          gates[0].resolve();
          await waitIdle();
          await item(0).getByText(action, { exact: true }).waitFor();
          assert.equal(await items.getByTestId("side-pane-plugin-progress").count(), 0);
          assert.equal(await page.locator(`${selector}[aria-busy="true"]`).count(), 0);

          // 失败后换另一个插件重试，防止进度归属残留在第一次点击的插件上。
          await item(1).click();
          await assertProgress(1);
          assert.equal(attempts.length, 2);
          const artifacts = join(tmpdir(), "zcode-side-pane-plugin-menu");
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({
            path: join(artifacts, `progress-${operation}-${existing}-${width}-${theme}.png`),
          });
          gates[1].resolve();
          await waitIdle();
          const completed =
            operation === "install" ? (locale === "zh-CN" ? "启用" : "Enable") : open;
          await item(1).getByText(completed, { exact: true }).waitFor();
          assert.equal(await items.getByText(loading, { exact: true }).count(), 0);
          assert.equal(await items.getByTestId("side-pane-plugin-progress").count(), 0);
          assert.equal(await page.locator(`${selector}[aria-busy="true"]`).count(), 0);
          assert.equal(await item(0).getByText(action, { exact: true }).count(), 1);
          assert.equal(await page.getByTestId("request").textContent(), "null");
          assert.deepEqual(errors, []);
        } finally {
          gates.forEach((gate) => gate.resolve());
          await page.close();
        }
      });
    }
  }
}

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  for (const existing of [false, true]) {
    test(`SPT-E2E-007 concurrent installs ${existing ? "new-tab" : "empty"}/${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.setDefaultTimeout(15000);
      const gates = [Promise.withResolvers(), Promise.withResolvers()];
      const entered = [Promise.withResolvers(), Promise.withResolvers()];
      const calls = [];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let firstInstalled = false;
      const selector = existing ? newTabItems : launcherItems;
      const items = page.locator(selector);
      // 安装态会改变展示位置，操作进度按插件身份定位，不依赖列表索引。
      const itemSelector = (index) =>
        `${selector}[data-side-pane-open-tab-item="plugin-ui:${surfaces[index].pluginId}/${surfaces[index].id}"]`;
      const item = (index) => page.locator(itemSelector(index));
      try {
        await page.route("**/client-config", (route) =>
          route.fulfill({
            json: {
              code: 0,
              data: {
                configs: {
                  uiPluginRecommendations: surfaces.map((surface) => ({
                    pluginId: surface.pluginId,
                    surfaceId: surface.id,
                  })),
                },
              },
            },
          }),
        );
        await page.route("**/catalog", (route) =>
          route.fulfill({
            json: {
              ...catalog(surfaces, false),
              plugins: catalog([surfaces[2], ...(firstInstalled ? [surfaces[0]] : [])]).plugins,
              availablePlugins: surfaces.map((surface, index) => ({
                ...catalog([surface], index === 2 || (index === 0 && firstInstalled))
                  .availablePlugins[0],
              })),
            },
          }),
        );
        await page.route("**/surfaces", (route) => route.fulfill({ json: surfaces }));
        await page.route("**/install", async (route) => {
          const input = route.request().postDataJSON();
          const index = surfaces.findIndex((surface) => surface.pluginName === input.pluginName);
          calls.push(input.pluginName);
          entered[index].resolve();
          await gates[index].promise;
          if (index === 1) return route.fulfill({ status: 503 });
          firstInstalled = true;
          return route.fulfill({ json: { diagnostics: [] } });
        });
        const query = `locale=${locale}&theme=${theme}${width < 500 ? "&mobile=1" : ""}${existing ? "&existing=1" : ""}`;
        await page.goto(`${origin}fixture?${query}`, { waitUntil: "domcontentloaded" });
        if (existing) await page.locator(add).click();
        await item(0).waitFor();
        await item(0).click();
        await entered[0].promise;
        assert.equal(await item(1).isEnabled(), true);
        assert.equal(await item(2).isEnabled(), true);
        await item(1).click();
        await entered[1].promise;
        assert.deepEqual(calls, ["hello", "canvas"]);
        assert.deepEqual(await Promise.all([0, 1, 2].map((index) => item(index).isDisabled())), [
          true,
          true,
          false,
        ]);
        assert.equal(await items.getByTestId("side-pane-plugin-progress").count(), 2);
        // 安装中仍可打开其他已启用插件，真实 surface 查询到 tab owner 的链路继续工作。
        await item(2).click();
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="request"]').textContent)?.pluginId ===
            "development@example",
        );
        gates[1].resolve();
        await page.waitForFunction(
          (selector) => !document.querySelector(selector).disabled,
          itemSelector(1),
        );
        assert.equal(await item(0).isDisabled(), true);
        assert.equal(await item(0).getByTestId("side-pane-plugin-progress").count(), 1);
        const artifacts = join(tmpdir(), "zcode-side-pane-plugin-menu");
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: join(artifacts, `concurrent-${existing}-${width}-${theme}.png`),
        });
        gates[0].resolve();
        await page.waitForFunction(
          (selector) => !document.querySelector(selector).disabled,
          itemSelector(0),
        );
        assert.equal(await items.getByTestId("side-pane-plugin-progress").count(), 0);
        assert.deepEqual(calls, ["hello", "canvas"]);
      } catch (error) {
        throw new Error(
          `${String(error)}; pageErrors=${JSON.stringify(errors)}; body=${(await page.locator("body").innerText()).slice(0, 1500)}`,
          { cause: error },
        );
      } finally {
        gates.forEach((gate) => gate.resolve());
        await page.close();
      }
    });
  }
}

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`SPT-E2E-007 installed priority and community tag ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(120000);
    const entries = ["new", "community", "official", "personal"].map((name) => ({
      ...surfaces[0],
      id: name,
      pluginName: name,
      pluginId: `${name}@${name === "personal" ? "example" : "zcode-plugins-official"}`,
      title: { en: name, "zh-CN": name },
    }));
    const snapshot = catalog(entries);
    snapshot.plugins = snapshot.plugins.filter((item) => item.name !== "new");
    snapshot.plugins[0].enabled = false;
    snapshot.availablePlugins = snapshot.availablePlugins.map((item) => ({
      ...item,
      installed: item.name !== "new",
      listing: {
        publisherType: ["community", "personal"].includes(item.name) ? "community" : "official",
        displayName: `${item.name} description`,
      },
    }));
    await page.route("**/catalog", (route) => route.fulfill({ json: snapshot }));
    await page.route("**/client-config", (route) =>
      route.fulfill({
        json: {
          code: 0,
          data: {
            configs: {
              uiPluginRecommendations: entries.map((entry) => ({
                pluginId: entry.pluginId,
                surfaceId: entry.id,
              })),
            },
          },
        },
      }),
    );
    try {
      await page.goto(
        `${origin}fixture?locale=${locale}&theme=${theme}${width < 500 ? "&mobile=1" : ""}`,
      );
      const rows = page.locator(launcherItems);
      await rows.first().waitFor();
      assert.deepEqual(
        await rows.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-side-pane-open-tab-item")),
        ),
        [entries[1], entries[2], entries[3], entries[0]].map(
          (entry) => `plugin-ui:${entry.pluginId}/${entry.id}`,
        ),
      );
      const tag = locale === "zh-CN" ? "社区" : "Community";
      assert.equal(await rows.getByText(tag, { exact: true }).count(), 1);
      const badge = rows.first().getByText(tag, { exact: true });
      assert.equal(await badge.isVisible(), true);
      const description = rows.first().getByText("community description", { exact: true });
      const badgeBox = await badge.boundingBox();
      const descriptionBox = await description.boundingBox();
      assert.ok(badgeBox.x + badgeBox.width <= descriptionBox.x);
      const artifacts = join(tmpdir(), "zcode-side-pane-plugin-menu");
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `community-${width}-${locale}-${theme}.png`) });
    } finally {
      await page.close();
    }
  });
}
