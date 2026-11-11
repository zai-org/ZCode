// MD07：真实 Web 入口，受控 relay/桌面响应；不替代真机 OAuth/线上部署验收。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/remote-device-switch.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { TID_AUTOMATIONS_OPEN, TID_TASK_NEW_BUTTON } from "@zcode/shared/test-ids";
import { createDeviceSwitchDesktopBridge } from "./remote-device-switch.helpers.mjs";
import {
  setup,
  mixedDevices,
  assertEventually,
} from "../../../authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/remote-device-switch-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const longName = "Alice’s MacBook Pro — 研发与测试工作站 / Development workstation";
try {
  for (const width of process.env.REMOTE_DEVICE_E2E_WIDTH
    ? [Number(process.env.REMOTE_DEVICE_E2E_WIDTH)]
    : [390, 1024])
    for (const mode of ["home-only", "bridge"])
      for (const theme of ["zai-light", "zai-dark"])
        for (const locale of ["zh-CN", "en-US"]) {
          const h = await setup(browser, { width, theme, locale, signedIn: true });
          const { page } = h;
          page.setDefaultTimeout(15_000);
          const connections = [];
          const send = (socket, payload) => socket.send(JSON.stringify({ type: "data", payload }));
          await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
            const connection = { socket, sid: undefined, closed: false, holdBootstrap: false };
            connections.push(connection);
            socket.onClose(() => {
              connection.closed = true;
              connection.bridge?.dispose();
            });
            socket.onMessage((raw) => {
              const message = JSON.parse(String(raw));
              if (message.type === "auth_init") {
                connection.sid = message.device_sid;
                const device = mixedDevices.find((item) => item.device_sid === connection.sid);
                assert.ok(device?.online);
                assert.equal(new URL(socket.url()).searchParams.get("mid"), device.device_mid);
                socket.send(
                  JSON.stringify({
                    type: "auth_ack",
                    device_sid: connection.sid,
                    pair_status: "matched",
                  }),
                );
              }
              if (message.type === "pair_status_query")
                socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
              const payload = message.payload;
              if (payload?.zcode_type === "rpc-frame" || payload?.zcode_type === "rpc-frame-ack") {
                connection.bridge?.acceptPayload(payload);
                return;
              }
              const workspace = {
                workspacePath: "/workspace/device-switch",
                workspaceIdentity: `remote:ssh:${connection.sid}:/workspace/device-switch`,
                label: `E2E_DEVICE_${connection.sid}`,
                kind: "remote",
                connectionState: mode === "bridge" ? "connected" : "disconnected",
                ...(mode === "bridge" ? { remoteSessionId: `remote-${connection.sid}` } : {}),
              };
              connection.result ??= { workspaces: [workspace] };
              if (payload?.zcode_type === "workspace-bridge-open") {
                const bridge = {
                  ...workspace,
                  workspaceKey: workspace.workspaceIdentity,
                  bridgeSessionId: payload.bridgeSessionId,
                  bridgeGeneration: payload.bridgeGeneration,
                };
                send(socket, {
                  zcode_type: "workspace-bridge-ready",
                  requestId: payload.requestId,
                  bridgeSessionId: payload.bridgeSessionId,
                  bridgeGeneration: payload.bridgeGeneration,
                  bridge,
                });
                connection.bridge = createDeviceSwitchDesktopBridge(socket, bridge, {
                  locale,
                  theme,
                });
              }
              if (payload?.zcode_type === "bootstrap-request") {
                const response = {
                  zcode_type: "bootstrap-response",
                  requestId: payload.requestId,
                  success: true,
                  result: {
                    windowControlSessionId: connection.sid,
                    desktopAppVersion: "3.13.0",
                    ...connection.result,
                  },
                };
                if (connection.holdBootstrap) connection.pendingBootstrap = response;
                else send(socket, response);
              }
              if (payload?.zcode_type === "workspace-list-request")
                send(socket, {
                  ...(connection.failList
                    ? {
                        zcode_type: "app-error",
                        reason: "unexpected-error",
                        error: "E2E_REFRESH_FAILED",
                      }
                    : {
                        zcode_type: "workspace-list-response",
                        success: true,
                        result: connection.result,
                      }),
                  requestId: payload.requestId,
                });
            });
          });
          const hasBridgeSession = (sid) =>
            page.evaluate(
              async ({ url, sid }) => {
                const store = await import(url);
                return Boolean(store.getRemoteWorkspaceSession(`remote-${sid}`));
              },
              {
                url: `/@fs${resolve("packages/ui/src/store/remoteWorkspaceSessionStore.ts")}`,
                sid,
              },
            );
          // 手机 home 与宽屏共用项目侧栏，设备入口是导航首行的整行按钮：可读名称“切换设备”，行内显示电脑名。
          const buttonName = () => (locale === "zh-CN" ? "切换设备" : "Switch device");
          const waitForHome = async (name) => {
            const button = page.getByRole("button", { name: buttonName(), exact: true });
            const onboarding = page.getByTestId("onboarding-page");
            const startupDialog = page.getByRole("dialog");
            // 首启可能显示职业引导、欢迎页或迁移提示，不能假定 home-only 必定进入职业引导。
            await button.or(onboarding).or(startupDialog).first().waitFor();
            if (await onboarding.isVisible()) {
              await onboarding.getByRole("button", { name: /退出引导|Exit onboarding/ }).click();
            }
            await button.or(startupDialog).first().waitFor();
            if (await startupDialog.isVisible())
              await startupDialog.getByRole("button", { name: /^(Close|关闭)$/ }).click();
            await button.waitFor();
            await button.getByText(name, { exact: true }).waitFor();
            const navigation = page.getByTestId("sidebar-primary-navigation");
            // RSNAV01：远控不承载这两个主视图；初次连接、切换设备和刷新都不能露出无效入口。
            assert.equal(await navigation.getByTestId(TID_AUTOMATIONS_OPEN).count(), 0);
            assert.equal(await navigation.getByTestId("plugin-store-sidebar-open").count(), 0);
            assert.equal(await navigation.getByTestId(TID_TASK_NEW_BUTTON).isVisible(), true);
            assert.equal(
              await navigation.evaluate(
                (node, label) => node.firstElementChild?.ariaLabel === label,
                buttonName(),
              ),
              true,
              "设备行必须是导航首行，位于“新建任务”之上",
            );
            // 长电脑名单行截断，不再撑高设备行。
            const [rowHeight, nameClipped] = await button.evaluate((node) => {
              const label = node.querySelector("span");
              return [node.getBoundingClientRect().height, label.scrollWidth > label.clientWidth];
            });
            assert.equal(rowHeight, 32);
            assert.equal(nameClipped, name === longName);
            return button;
          };
          try {
            const url = new URL("/remote/v4?app_version=3.13.0&sid=e2e-device&mid=e2e-mid", origin);
            url.searchParams.set("name", longName);
            await page.goto(url.href, { waitUntil: "domcontentloaded" });
            const button = await waitForHome(longName);
            assert.equal(h.traffic.lists, 0, "扫码连接不先请求账号设备列表");
            if (mode === "bridge") assert.equal(await hasBridgeSession("e2e-device"), true);
            await page.evaluate(() => document.fonts.ready);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
              false,
            );
            const filename = `connected-${width}-${mode}-${theme}-${locale}.png`;
            await page.screenshot({ path: resolve(artifacts, filename), fullPage: true });
            const first = connections[0];
            // 触发真实恢复请求并延迟响应，切换后旧请求不可重新挂载首页。
            first.holdBootstrap = true;
            first.socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
            first.socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
            await assertEventually(() => Boolean(first.pendingBootstrap));
            await button.click();
            await page.getByRole("heading", { name: /选择电脑|Choose a computer/ }).waitFor();
            await assertEventually(() => first.closed);
            if (mode === "bridge") assert.equal(await hasBridgeSession("e2e-device"), false);
            send(first.socket, first.pendingBootstrap);
            assert.equal(new URL(page.url()).searchParams.has("sid"), false);
            assert.equal(new URL(page.url()).searchParams.has("name"), false);
            assert.equal(new URL(page.url()).searchParams.get("app_version"), "3.13.0");
            assert.equal(
              await page.evaluate(() => localStorage.getItem("zcode-web-remote-last-device-sid")),
              "e2e-device",
            );
            await page.getByRole("button", { name: /Alice’s MacBook/ }).waitFor();
            await page.getByRole("button", { name: /^(刷新|Refresh)$/ }).click();
            await assertEventually(() => h.traffic.lists === 2);
            assert.equal(connections.length, 1, "最近设备仍在线，列表和刷新也不能自动连回去");
            assert.equal(h.traffic.tokens, 1);
            await page.getByRole("button", { name: /Workstation/ }).click();
            await waitForHome("Workstation");
            assert.equal(new URL(page.url()).searchParams.get("sid"), "second");
            assert.equal(new URL(page.url()).searchParams.get("mid"), "d67e89f0-other");
            assert.equal(connections.length, 2);
            assert.equal(connections[1].sid, "second");
            if (mode === "bridge") {
              assert.equal(await hasBridgeSession("e2e-device"), false);
              assert.equal(await hasBridgeSession("second"), true);
            }
            assert.equal(await page.getByText(`E2E_DEVICE_e2e-device`, { exact: true }).count(), 0);
            // 应用就绪由下方真实首页断言确认，不等待外部字体等非关键资源的 load。
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForHome("Workstation");
            assert.equal(connections.at(-1).sid, "second");
            assert.equal(h.traffic.lists, 2, "刷新按新 SID 直连，不重新选设备");
            assert.deepEqual(h.errors, []);
            results.push({
              width,
              mode,
              theme,
              locale,
              result: "passed",
              screenshot: filename,
            });
          } catch (error) {
            console.error(error);
            await page.screenshot({ path: resolve(artifacts, "failure.png"), fullPage: true });
            console.error(await page.locator("body").innerText(), h.errors);
            throw error;
          } finally {
            await h.context.close();
          }
        }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`MD07 passed: ${results.length} configurations; ${artifacts}`);
} finally {
  await browser.close();
}
