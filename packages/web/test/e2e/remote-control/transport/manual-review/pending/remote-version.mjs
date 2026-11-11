// RV01–RV03：真实 Web 入口与浏览器导航；模拟 relay/桌面响应，不验证外部资源路由服务。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：node packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-version.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const origin = process.env.REMOTE_VERSION_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/remote-version-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function scenario({ width, theme, locale, missingVersion = false, oldDesktop = false }) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript((value) => {
    localStorage.setItem("zcode-theme", value);
    localStorage.setItem("zcodejwttoken", "e2e-jwt");
    localStorage.setItem("oauth:active_provider", "zai");
    localStorage.setItem("oauth:zai:access_token", "e2e-access");
    localStorage.setItem(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "e2e-user", name: "E2E" }),
    );
  }, theme);
  await page.route("**/api/v1/remote/token", (route) =>
    route.fulfill({
      json: { code: 0, msg: "", data: { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60 } },
    }),
  );
  const waitForHome = async () => {
    const home = page.getByText("E2E_REMOTE_VERSION", { exact: true }).first();
    const onboarding = page.getByTestId("onboarding-page");
    await home.or(onboarding).first().waitFor();
    if (await onboarding.isVisible()) await page.keyboard.press("Escape");
    // home-only 首页在手机与宽屏都由项目侧栏展示桌面工作区列表。
    await home.waitFor();
  };
  let desktopVersion = oldDesktop ? undefined : "3.12.2";
  let relay;
  let bootstrapCount = 0;
  let bridgeCount = 0;
  let navigationCount = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationCount += 1;
  });
  const workspace = {
    workspacePath: "/workspace/remote-version",
    workspaceIdentity: "remote:ssh:e2e:/workspace/remote-version",
    label: "E2E_REMOTE_VERSION",
    kind: "remote",
    connectionState: "disconnected",
  };
  const send = (message) => relay.send(JSON.stringify(message));
  await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
    relay = socket;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "auth_init") {
        send({ type: "auth_ack", device_sid: "e2e-device", pair_status: "matched" });
      }
      if (message.type === "pair_status_query")
        send({ type: "pair_status_ack", pair_status: "matched" });
      const payload = message.payload;
      if (payload?.zcode_type === "bootstrap-request") {
        bootstrapCount += 1;
        send({
          type: "data",
          payload: {
            zcode_type: "bootstrap-response",
            requestId: payload.requestId,
            success: true,
            result: {
              windowControlSessionId: "e2e-device",
              desktopAppVersion: desktopVersion,
              workspaces: [workspace],
              tasks: [],
            },
          },
        });
      }
      if (payload?.zcode_type === "workspace-list-request") {
        send({
          type: "data",
          payload: {
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: true,
            result: { workspaces: [workspace], tasks: [] },
          },
        });
      }
      if (payload?.zcode_type === "workspace-bridge-open") bridgeCount += 1;
    });
  });

  const url = new URL("/remote/v4/", origin);
  url.search = "sid=e2e-device&mid=e2e-mid&name=E2E";
  if (!missingVersion) url.searchParams.set("app_version", "3.12.1");
  url.hash = "keep-fragment";
  try {
    await page.goto(url.toString());
    if (!oldDesktop)
      await page.waitForURL((target) => target.searchParams.get("app_version") === "3.12.2");
    await waitForHome();
    assert.deepEqual(errors, []);
    const readyUrl = page.url();
    const parsed = new URL(readyUrl);
    assert.equal(parsed.hash, "#keep-fragment");
    for (const [key, value] of url.searchParams) {
      if (key !== "app_version") assert.equal(parsed.searchParams.get(key), value);
    }
    assert.equal(bridgeCount, 0);
    assert.equal(navigationCount, oldDesktop ? 1 : 2);
    if (oldDesktop) {
      assert.equal(readyUrl, url.toString());
      assert.equal(await page.locator("dialog[aria-labelledby='remote-version-title']").count(), 0);
      return;
    }
    const beforeRecovery = navigationCount;
    const initialBootstraps = bootstrapCount;
    send({ type: "pair_status_ack", pair_status: "waiting" });
    send({ type: "pair_status_ack", pair_status: "matched" });
    await page.waitForFunction(() => document.querySelector("dialog") === null);
    await assertEventually(() => bootstrapCount > initialBootstraps);
    assert.equal(navigationCount, beforeRecovery);
    assert.equal(page.url(), readyUrl);
    await page.evaluate(() => {
      window.__remoteVersionRoot = document.getElementById("root").firstElementChild;
      window.__backgroundShortcutCount = 0;
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "F2") window.__backgroundShortcutCount += 1;
        },
        true,
      );
    });
    desktopVersion = "3.12.3";
    send({ type: "pair_status_ack", pair_status: "waiting" });
    send({ type: "pair_status_ack", pair_status: "matched" });
    const dialog = page.getByRole("dialog", {
      name: locale === "zh-CN" ? "桌面版本已更新" : "Desktop version changed",
      exact: true,
    });
    await dialog.waitFor();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 15 && Math.abs(bounds.x - (width - bounds.width) / 2) < 2);
    assert.equal(page.url(), readyUrl);
    assert.equal(navigationCount, beforeRecovery);
    assert.equal(
      await page.evaluate(
        () => window.__remoteVersionRoot === document.getElementById("root").firstElementChild,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press("F2");
    assert.equal(await page.evaluate(() => window.__backgroundShortcutCount), 0);
    await page.screenshot({
      path: resolve(artifacts, `${width}-${theme}-${locale}.png`),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: locale === "zh-CN" ? "重新加载" : "Reload", exact: true })
      .click();
    await page.waitForURL((target) => target.searchParams.get("app_version") === "3.12.3");
    await waitForHome();
    assert.equal(navigationCount, beforeRecovery + 1);
    assert.equal(await page.locator("dialog[aria-labelledby='remote-version-title']").count(), 0);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: resolve(artifacts, "failure.png"), fullPage: true });
    console.error(await page.locator("body").innerText(), errors);
    throw error;
  } finally {
    await context.close();
  }
}

async function assertEventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(predicate(), "expected a new version bootstrap after recovery");
}

try {
  for (const options of [
    { width: 390, theme: "zai-light", locale: "zh-CN" },
    { width: 390, theme: "zai-dark", locale: "en-US" },
    { width: 1280, theme: "zai-light", locale: "en-US" },
    { width: 1280, theme: "zai-dark", locale: "zh-CN" },
    { width: 390, theme: "zai-dark", locale: "zh-CN", missingVersion: true },
    { width: 390, theme: "zai-dark", locale: "zh-CN", oldDesktop: true },
  ]) {
    await scenario(options);
    console.log("PASS RV01–RV03", options);
  }
} finally {
  await browser.close();
}
