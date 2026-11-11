// MRO02：真实 Web 页面、RPC、Host 项目服务和隔离 SQLite；不发送模型请求。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/remote-project-directory.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import {
  BufferReader,
  deserialize,
  Emitter,
  VSBuffer,
} from "../../../../../../../rpc/src/index.ts";
import { taskSnapshotFrame } from "./remote-task-open.fixture.mjs";
import { createProjectDirectoryFixture } from "./remote-project-directory.fixture.mjs";
import { createDeviceSwitchDesktopBridge } from "./remote-device-switch.helpers.mjs";
import {
  setup,
  assertEventually,
} from "../../../authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(process.env.MRO02_ARTIFACTS || ".tmp/remote-project-directory-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const configurations = [1024, 390].flatMap((width) =>
  ["zai-light", "zai-dark"].flatMap((theme) =>
    ["zh-CN", "en-US"].map((locale) => ({ width, theme, locale })),
  ),
);
const selectedConfigurations = process.env.MRO02_WIDTH
  ? configurations.filter(({ width }) => width === Number(process.env.MRO02_WIDTH))
  : configurations;
try {
  for (const configuration of process.env.MRO02_FIRST_ONLY
    ? selectedConfigurations.slice(0, 1)
    : selectedConfigurations) {
    const { width, theme, locale } = configuration;
    const prefix = `${width}-${theme}-${locale}`;
    const fixture = await createProjectDirectoryFixture(artifacts);
    const h = await setup(browser, { width, theme, locale, signedIn: true });
    const { page } = h;
    page.setDefaultTimeout(15_000);
    const bridges = new Map();
    const snapshots = new Map();
    const directoryReadinessRecovery = {
      bridgeSessionId: null,
      droppedRequests: 0,
      replayedRequests: 0,
      matchedSignals: 0,
      capabilityCalls: 0,
    };
    let droppedCapabilityFrame;
    fixture.traffic.directoryReadinessRecovery = directoryReadinessRecovery;
    let view = { activeWorkspaceKey: fixture.localPath, activeTaskId: "LOCAL_TASK", updatedAt: 1 };
    const send = (socket, payload) => socket.send(JSON.stringify({ type: "data", payload }));
    fixture.traffic.navigations = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) fixture.traffic.navigations.push(frame.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") fixture.traffic.errors.push(message.text());
    });
    await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
      const ownBridges = [];
      socket.onClose(() => {
        for (const bridge of ownBridges) bridge.dispose();
      });
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "auth_init")
          socket.send(
            JSON.stringify({ type: "auth_ack", device_sid: "e2e-device", pair_status: "matched" }),
          );
        if (message.type === "pair_status_query")
          socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
        const payload = message.payload;
        if (!payload) return;
        if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
          if (
            payload.zcode_type === "rpc-frame" &&
            payload.bridgeSessionId === directoryReadinessRecovery.bridgeSessionId &&
            payload.fragmentCount === 1
          ) {
            const header = deserialize(
              new BufferReader(VSBuffer.wrap(Buffer.from(payload.dataBase64, "base64"))),
            );
            if (header[2] === "window-project-changes" && header[3] === "getCapabilities") {
              if (!droppedCapabilityFrame) {
                droppedCapabilityFrame = payload;
                directoryReadinessRecovery.droppedRequests++;
                // 只在 relay 边界丢帧，原 matched 消息驱动浏览器 main 的真实 send-ready 回调。
                directoryReadinessRecovery.matchedSignals++;
                socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
                return;
              }
              assert.deepEqual(payload, droppedCapabilityFrame, "recover the same unacked frame");
              directoryReadinessRecovery.replayedRequests++;
            }
          }
          bridges.get(payload.bridgeSessionId)?.acceptPayload(payload);
          return;
        }
        const result = {
          windowControlSessionId: "e2e-device",
          desktopAppVersion: "3.15.1",
          workspaces: fixture.workspaces,
          initialViewState: view,
        };
        if (payload.zcode_type === "bootstrap-request")
          send(socket, {
            zcode_type: "bootstrap-response",
            requestId: payload.requestId,
            success: true,
            result,
          });
        if (payload.zcode_type === "workspace-list-request")
          send(socket, {
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: true,
            result,
          });
        if (payload.zcode_type === "mobile-view-state-update") {
          fixture.traffic.views.push(payload);
          view = payload.viewState;
          send(socket, { zcode_type: "mobile-view-state-updated", requestId: payload.requestId });
        }
        if (payload.zcode_type !== "workspace-bridge-open") return;
        fixture.traffic.opens.push(payload);
        const target = fixture.workspaces.find(
          (item) => (item.workspaceIdentity || item.workspacePath) === payload.workspaceKey,
        );
        assert.ok(target, "MRO02 only opens fixture workspaces");
        const remoteBridge = target.kind === "remote";
        const bridge = {
          ...target,
          workspaceKey: payload.workspaceKey,
          bridgeSessionId: payload.bridgeSessionId,
          bridgeGeneration: payload.bridgeGeneration,
          initialTaskId: payload.taskId,
          ...(remoteBridge ? { capabilities: { windowProjectDirectory: true } } : {}),
        };
        if (remoteBridge && !directoryReadinessRecovery.bridgeSessionId)
          directoryReadinessRecovery.bridgeSessionId = bridge.bridgeSessionId;
        const frames = new Emitter();
        const channels = fixture.channels(remoteBridge);
        // relay RPC 首帧只能在客户端收到 ready、登记桥接代际后发送，顺序沿用共享夹具。
        send(socket, {
          zcode_type: "workspace-bridge-ready",
          requestId: payload.requestId,
          bridgeSessionId: payload.bridgeSessionId,
          bridgeGeneration: payload.bridgeGeneration,
          bridge,
        });
        const desktopBridge = createDeviceSwitchDesktopBridge(socket, bridge, {
          locale,
          theme,
          events: {
            ...channels.events,
            [`${ServiceChannels.ZCodeAgent}:onDynamicConversationFrame`]: frames.event,
          },
          responses: {
            ...channels.responses,
            "window-project-changes:getCapabilities": (...args) => {
              if (bridge.bridgeSessionId === directoryReadinessRecovery.bridgeSessionId)
                directoryReadinessRecovery.capabilityCalls++;
              return channels.responses["window-project-changes:getCapabilities"](...args);
            },
            [`${ServiceChannels.SettingsSync}:getFirstRunPromptState`]: { handled: true },
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
            [`${ServiceChannels.ZCodeAgent}:subscribeConversationV4`]: (input) => {
              const subscriptionId = `sub-${bridge.bridgeSessionId}-${input.sessionId}`;
              snapshots.set(input.sessionId, () =>
                frames.fire(taskSnapshotFrame(input.sessionId, subscriptionId)),
              );
              return { ack: { subscriptionId, mode: "snapshot", logEpoch: "e2e" } };
            },
            [`${ServiceChannels.ZCodeAgent}:unsubscribeConversationV4`]: null,
            [`${ServiceChannels.ZCodeAgent}:conversationWorkflowRunsV4`]: { runs: [] },
            [`${ServiceChannels.ZCodeAgent}:conversationPlansV4`]: { plans: [] },
          },
        });
        bridges.set(bridge.bridgeSessionId, desktopBridge);
        ownBridges.push(desktopBridge);
      });
    });
    const local = () => page.locator(`[data-project-id="${fixture.local.id}"]`);
    const remote = () => page.locator(`[data-project-id="${fixture.remote.id}"]`);
    const home = page.locator('[data-mobile-page="home"]');
    const chat = page.locator('[data-mobile-page="chat"]');
    const returnHome = async () => {
      if (width < 768 && (await chat.isVisible())) {
        await page.goBack();
        await home.waitFor();
      }
    };
    const directoryVisible = async (phase) => {
      await local().waitFor();
      await remote().waitFor();
      await page.getByText("E2E_MRO02_PINNED_TASK", { exact: true }).first().waitFor();
      assert.equal(
        await page.locator(`[data-project-id="${fixture.hidden.id}"]`).count(),
        0,
        `${phase}: unadded Source project must stay hidden`,
      );
      assert.equal(
        await page.getByText("E2E_MRO02_NOT_ADDED_TASK", { exact: true }).count(),
        0,
        `${phase}: unadded Source task must stay hidden`,
      );
    };
    const openTask = async (row, title) => {
      const toggle = row.getByTestId("virtual-project-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await row.getByText(title, { exact: true }).first().click();
    };
    try {
      await page.goto(
        new URL("/remote/v4?app_version=3.15.1&sid=e2e-device&mid=e2e-mid", origin).href,
      );
      const onboarding = page.getByTestId("onboarding-page");
      const welcome = page.getByRole("dialog", { name: /欢迎使用 ZCode|Welcome to ZCode/ });
      await local().or(onboarding).or(welcome).first().waitFor();
      if (await onboarding.isVisible())
        await onboarding.getByRole("button", { name: /退出引导|Exit onboarding/ }).click();
      await local().or(welcome).first().waitFor();
      if (await welcome.isVisible())
        await welcome.getByRole("button", { name: /^(Close|关闭)$/ }).click();
      await directoryVisible("initial local");
      await openTask(remote(), "E2E_MRO02_REMOTE_TASK");
      await page.locator('[data-session-id="REMOTE_TASK"]').waitFor();
      const assertRemoteHeader = async () => {
        const header = page.getByTestId("workspace-path");
        await header.waitFor({ state: "visible" });
        await page
          .locator(
            `[data-testid="workspace-path"][aria-description="${locale === "zh-CN" ? "已连接" : "Connected"}"]`,
          )
          .waitFor({ state: "visible" });
        // bridge 登记早于目录读取完成；连接就绪不代表设备名就绪，按名称条件等待避免误读占位文字。
        await header
          .locator("[data-workspace-device-name]")
          .filter({ hasText: /^example\.test$/ })
          .waitFor({ state: "visible" });
      };
      await assertRemoteHeader();
      await assertEventually(() => snapshots.has("REMOTE_TASK"));
      snapshots.get("REMOTE_TASK")();
      await returnHome();
      await directoryVisible("remote bridge");
      assert.equal(directoryReadinessRecovery.droppedRequests, 1, "drop one capability request");
      assert.equal(directoryReadinessRecovery.matchedSignals, 1, "signal send-ready after loss");
      assert.equal(directoryReadinessRecovery.replayedRequests, 1, "pending request is replayed");
      assert.equal(directoryReadinessRecovery.capabilityCalls, 1, "capability service runs once");
      assert.ok(
        fixture.traffic.calls.some(
          (call) => call.channel === "window-project" && call.method === "readTree",
        ),
        "remote sidebar must read the window directory channel",
      );
      // 此处检查浏览器里真实注册的 Source RPC 代理，不把侧栏新通道误用于工作区消费者。
      const source = await page.evaluate(
        async (modulePath) => {
          const { getRemoteWorkspaceSession } = await import(modulePath);
          const services = getRemoteWorkspaceSession("mro02-remote-scope").services;
          return {
            tree: await services.projectService.readTree(),
            directory: await services.remoteProjectService.readDirectory(),
          };
        },
        `/@fs/${resolve("packages/ui/src/store/remoteWorkspaceSessionStore.ts").replaceAll("\\", "/").replace(/^\/+/, "")}`,
      );
      assert.deepEqual(
        new Set(source.tree.projects.map((project) => project.id)),
        new Set([fixture.remote.id, fixture.hidden.id]),
      );
      assert.deepEqual(source.directory, { hosts: [], entries: [] });
      // 窗口真实服务修改本机项目，仅发窗口项目事件；remote 原广播保持 Source 语义。
      await fixture.windowProject.saveProject({
        id: fixture.local.id,
        name: "E2E_MRO02_LOCAL_RENAMED",
      });
      await page.locator('[data-project-name="E2E_MRO02_LOCAL_RENAMED"]').waitFor();
      await local().getByTestId("virtual-project-menu").click();
      await page.getByTestId("virtual-project-pin").click();
      await assertEventually(
        () =>
          fixture.windowRepository
            .readTree()
            .projects.find((project) => project.id === fixture.local.id)?.pinned === true,
      );
      assert.ok(
        fixture.traffic.calls.some(
          (call) =>
            call.channel === "window-project" &&
            call.method === "saveProject" &&
            call.args[0]?.id === fixture.local.id,
        ),
        "project writes must use the same window owner as reads",
      );
      await page.screenshot({ path: resolve(artifacts, `${prefix}-remote.png`), fullPage: true });
      await page.reload();
      await assertEventually(() => fixture.traffic.opens.at(-1)?.workspaceKey === fixture.identity);
      if (width < 768) {
        await home.or(chat).first().waitFor();
        await returnHome();
      }
      if (width >= 768) await assertRemoteHeader();
      await directoryVisible("reload remote");
      await openTask(local(), "E2E_MRO02_LOCAL_TASK");
      await page.locator('[data-session-id="LOCAL_TASK"]').waitFor();
      await returnHome();
      await directoryVisible("return local");
      assert.equal(fixture.traffic.opens.at(-1).workspaceKey, fixture.localPath);
      assert.deepEqual(h.errors, []);
      await page.screenshot({ path: resolve(artifacts, `${prefix}-returned.png`), fullPage: true });
      results.push({ ...configuration, result: "passed" });
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, `${prefix}-failure.png`), fullPage: true });
      await writeFile(
        resolve(artifacts, `${prefix}-failure.txt`),
        `${error.stack}\n\n${await page.locator("body").innerText()}\n${JSON.stringify(h.errors)}`,
      );
      throw error;
    } finally {
      await writeFile(
        resolve(artifacts, `${prefix}-traffic.json`),
        JSON.stringify(fixture.traffic, null, 2),
      );
      await h.context.close();
      fixture.dispose();
    }
  }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`MRO02 passed: ${results.length} configurations; ${artifacts}`);
} finally {
  await browser.close();
}
