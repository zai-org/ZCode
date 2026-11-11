// HO01：home-only 首页工作区列表与重连入口；真实 Web 入口，受控 relay/桌面响应。
// 不替代真机、OAuth 与线上部署验收。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/remote-home-only-workspaces.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createDeviceSwitchDesktopBridge } from "./remote-device-switch.helpers.mjs";
import {
  setup,
  assertEventually,
} from "../../../authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/remote-home-only-workspaces-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const remote = (name, extra = {}) => ({
  workspacePath: `/srv/${name}`,
  workspaceIdentity: `remote:ssh:e2e:/srv/${name}`,
  label: `E2E_${name.toUpperCase()}`,
  kind: "remote",
  connectionState: "disconnected",
  ...extra,
});
try {
  for (const width of [390, 1024])
    for (const theme of ["zai-light", "zai-dark"])
      for (const locale of ["zh-CN", "en-US"]) {
        const h = await setup(browser, { width, theme, locale, signedIn: true });
        const { page } = h;
        page.setDefaultTimeout(15_000);
        const zh = locale === "zh-CN";
        const text = {
          offline: zh ? "未连接 · 连接" : "Not connected · Connect",
          failed: zh ? "连接失败 · 连接" : "Connection failed · Connect",
          online: zh ? "已连接" : "Connected",
          toast: zh ? "连接失败" : "Connection failed",
        };
        // 桌面是列表唯一事实源：断开项没有 remoteSessionId，重连成功后才带回。
        const workspaces = [
          remote("alpha"),
          remote("beta", { lastConnectionError: "E2E_SSH_REFUSED" }),
        ];
        const traffic = { lists: 0, reconnects: [], bridgeOpens: [] };
        let bridge;
        const send = (socket, payload) => socket.send(JSON.stringify({ type: "data", payload }));
        await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
          socket.onClose(() => bridge?.dispose());
          socket.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.type === "auth_init")
              socket.send(
                JSON.stringify({
                  type: "auth_ack",
                  device_sid: message.device_sid,
                  pair_status: "matched",
                }),
              );
            if (message.type === "pair_status_query")
              socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
            const payload = message.payload;
            if (payload?.zcode_type === "rpc-frame" || payload?.zcode_type === "rpc-frame-ack") {
              bridge?.acceptPayload(payload);
              return;
            }
            if (payload?.zcode_type === "bootstrap-request")
              send(socket, {
                zcode_type: "bootstrap-response",
                requestId: payload.requestId,
                success: true,
                result: {
                  windowControlSessionId: "e2e-device",
                  desktopAppVersion: "3.13.0",
                  workspaces,
                },
              });
            if (payload?.zcode_type === "workspace-list-request") {
              traffic.lists++;
              send(socket, {
                zcode_type: "workspace-list-response",
                requestId: payload.requestId,
                success: true,
                result: { workspaces },
              });
            }
            if (payload?.zcode_type === "workspace-reconnect-request") {
              traffic.reconnects.push(payload.workspaceKey);
              const target = workspaces.find(
                (item) => item.workspaceIdentity === payload.workspaceKey,
              );
              if (target.label === "E2E_BETA") {
                send(socket, {
                  zcode_type: "workspace-reconnect-response",
                  requestId: payload.requestId,
                  workspaceKey: payload.workspaceKey,
                  success: false,
                  error: "E2E_SSH_REFUSED",
                });
                return;
              }
              Object.assign(target, {
                connectionState: "connected",
                remoteSessionId: "remote-alpha",
              });
              send(socket, { zcode_type: "workspace-list-updated", result: { workspaces } });
              send(socket, {
                zcode_type: "workspace-reconnect-response",
                requestId: payload.requestId,
                workspaceKey: payload.workspaceKey,
                success: true,
              });
            }
            if (payload?.zcode_type === "workspace-bridge-open") {
              traffic.bridgeOpens.push(payload.workspaceKey);
              const target = workspaces.find(
                (item) => item.workspaceIdentity === payload.workspaceKey,
              );
              const ready = {
                ...target,
                workspaceKey: target.workspaceIdentity,
                bridgeSessionId: payload.bridgeSessionId,
                bridgeGeneration: payload.bridgeGeneration,
              };
              send(socket, {
                zcode_type: "workspace-bridge-ready",
                requestId: payload.requestId,
                bridgeSessionId: payload.bridgeSessionId,
                bridgeGeneration: payload.bridgeGeneration,
                bridge: ready,
              });
              bridge = createDeviceSwitchDesktopBridge(socket, ready, { locale, theme });
            }
          });
        });
        const section = page.getByTestId("home-only-workspaces");
        const row = (label) => section.locator("[data-home-only-workspace]", { hasText: label });
        try {
          const url = new URL("/remote/v4?app_version=3.13.0&sid=e2e-device&mid=e2e-mid", origin);
          url.searchParams.set("name", "E2E Mac");
          await page.goto(url.href);
          // home-only 空设置会依次触发职业引导与首次启动欢迎页；关闭后才是首页。
          const onboarding = page.getByTestId("onboarding-page");
          await onboarding.waitFor();
          await onboarding.getByRole("button", { name: /退出引导|Exit onboarding/ }).click();
          const welcome = page.getByRole("dialog", { name: /欢迎使用 ZCode|Welcome to ZCode/ });
          await welcome.waitFor();
          await welcome.getByRole("button", { name: /^(Close|关闭)$/ }).click();
          await welcome.waitFor({ state: "detached" });
          await section.waitFor();
          await row("E2E_ALPHA").waitFor();
          assert.match(await row("E2E_ALPHA").innerText(), new RegExp(text.offline));
          assert.match(await row("E2E_BETA").innerText(), new RegExp(text.failed));
          assert.equal(await page.getByText("project.service-unavailable").count(), 0);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          const filename = `home-only-${width}-${theme}-${locale}.png`;
          await page.screenshot({ path: resolve(artifacts, filename), fullPage: true });

          // 失败重连：提示本地化错误，行保持可用，不重新拉列表、不建 bridge。
          const listsBeforeFailure = traffic.lists;
          await row("E2E_BETA").click();
          await page.getByText(text.toast, { exact: true }).first().waitFor();
          await section
            .locator("[data-home-only-workspace]:not([disabled])", { hasText: "E2E_BETA" })
            .waitFor();
          assert.equal(traffic.lists, listsBeforeFailure);

          // 成功重连：列表带回 remoteSessionId 后行变为可打开，但不自动切换。
          await row("E2E_ALPHA").click();
          await row("E2E_ALPHA").filter({ hasText: text.online }).waitFor();
          assert.deepEqual(traffic.reconnects, [
            "remote:ssh:e2e:/srv/beta",
            "remote:ssh:e2e:/srv/alpha",
          ]);
          assert.equal(traffic.bridgeOpens.length, 0);

          // 点击可 bridge 行才打开工作区，首页换成带项目契约的 bridge Root。
          await row("E2E_ALPHA").click();
          await assertEventually(() => traffic.bridgeOpens.length === 1);
          assert.equal(traffic.bridgeOpens[0], "remote:ssh:e2e:/srv/alpha");
          await section.waitFor({ state: "detached" });
          assert.deepEqual(h.errors, []);
          results.push({ width, theme, locale, result: "passed", screenshot: filename });
        } catch (error) {
          await page.screenshot({ path: resolve(artifacts, "failure.png"), fullPage: true });
          console.error(await page.locator("body").innerText(), h.errors);
          throw error;
        } finally {
          await h.context.close();
        }
      }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`HO01 passed: ${results.length} configurations; ${artifacts}`);
} finally {
  await browser.close();
}
