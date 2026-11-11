// MRO01：真实 Web 入口与 RPC 帧；受控桌面 bridge 成功/失败，不发送模型请求。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/remote-task-open.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "../../../../../../../rpc/src/index.ts";
import { taskSnapshotFrame } from "./remote-task-open.fixture.mjs";
import { createDeviceSwitchDesktopBridge } from "./remote-device-switch.helpers.mjs";
import {
  setup,
  assertEventually,
} from "../../../authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/remote-task-open-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const hostId = "remote:server:e2e-source";
const localPath = "/workspace/local";
const remotePath = "/workspace/remote";
const identity = `${hostId}:${remotePath}`;
const project = (id, hostId, rootPath) => ({
  id,
  hostId,
  name: `E2E_MRO01_${id}`,
  roots: [{ rootPath, position: 0, isPrimary: true }],
  nameOverridden: true,
  pinned: false,
  deleted: false,
  position: 0,
  createdAt: 1,
  updatedAt: 2,
});
const projects = [project("LOCAL", "local", localPath), project("REMOTE", hostId, remotePath)];
const task = (taskId, projectId, hostId, workspacePath, workspaceIdentity) => ({
  taskId,
  projectId,
  hostId,
  workspacePath,
  workspaceIdentity,
  title: `E2E_MRO01_${taskId}`,
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
  archived: false,
  mode: "default",
  status: "completed",
});
const tasks = [
  task("LOCAL_TASK", "LOCAL", "local", localPath),
  task("REMOTE_TASK", "REMOTE", hostId, remotePath, identity),
];
const workspaces = [
  { workspacePath: localPath, kind: "local", label: "Local" },
  {
    workspacePath: remotePath,
    workspaceIdentity: identity,
    remoteSessionId: "remote-scope",
    kind: "remote",
    label: "Remote",
    connectionState: "connected",
  },
];
const directory = {
  hosts: [
    {
      id: hostId,
      membershipId: "member",
      kind: "server",
      target: { kind: "server", serverId: "e2e-source", url: "https://example.test" },
      position: 0,
      connectionStatus: "online",
    },
  ],
  entries: [
    {
      id: "entry",
      hostId,
      projectId: "REMOTE",
      name: projects[1].name,
      roots: projects[1].roots,
      legacyWorkspace: null,
      lastSyncedAt: 1,
    },
  ],
};
try {
  for (const theme of ["zai-light", "zai-dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      const h = await setup(browser, { width: 390, theme, locale, signedIn: true });
      const { page } = h;
      page.setDefaultTimeout(15000);
      const traffic = { opens: [], views: [], subscriptions: [], errors: [] };
      const bridges = new Map();
      const snapshots = new Map();
      let pending;
      let failNext = true;
      const send = (socket, payload) => socket.send(JSON.stringify({ type: "data", payload }));
      page.on("console", (message) => {
        if (message.type() === "error") traffic.errors.push(message.text());
      });
      await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
        socket.onClose(() => {
          for (const bridge of bridges.values()) bridge.dispose();
        });
        const ready = (request) => {
          const target = workspaces.find(
            (item) => (item.workspaceIdentity || item.workspacePath) === request.workspaceKey,
          );
          assert.ok(target);
          const bridge = {
            ...target,
            workspaceKey: request.workspaceKey,
            bridgeSessionId: request.bridgeSessionId,
            bridgeGeneration: request.bridgeGeneration,
            initialTaskId: request.taskId,
          };
          const frames = new Emitter();
          send(socket, {
            zcode_type: "workspace-bridge-ready",
            requestId: request.requestId,
            bridgeSessionId: request.bridgeSessionId,
            bridgeGeneration: request.bridgeGeneration,
            bridge,
          });
          bridges.set(
            bridge.bridgeSessionId,
            createDeviceSwitchDesktopBridge(socket, bridge, {
              locale,
              theme,
              events: {
                [`${ServiceChannels.ZCodeAgent}:onDynamicConversationFrame`]: frames.event,
              },
              responses: {
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
                [`${ServiceChannels.Project}:readTree`]: (params) => ({
                  projects: projects.filter((p) => p.hostId === (params?.hostId || "local")),
                  tasks: tasks.filter((t) => t.hostId === (params?.hostId || "local")),
                }),
                [`${ServiceChannels.RemoteProjects}:readDirectory`]: directory,
                [`${ServiceChannels.RemoteProjects}:refreshEntry`]: null,
                [`${ServiceChannels.ZCodeTask}:getTaskMeta`]: (input) =>
                  tasks.find((t) => t.taskId === input.taskId) ?? null,
                [`${ServiceChannels.ZCodeAgent}:subscribeConversationV4`]: (input) => {
                  traffic.subscriptions.push({
                    workspacePath: input.workspacePath,
                    workspaceIdentity: input.workspaceIdentity,
                    sessionId: input.sessionId,
                  });
                  const subscriptionId = `sub-${traffic.subscriptions.length}`;
                  snapshots.set(input.sessionId, () =>
                    frames.fire(taskSnapshotFrame(input.sessionId, subscriptionId)),
                  );
                  return {
                    ack: {
                      subscriptionId,
                      mode: "snapshot",
                      logEpoch: "e2e",
                    },
                  };
                },
                [`${ServiceChannels.ZCodeAgent}:unsubscribeConversationV4`]: null,
                [`${ServiceChannels.ZCodeAgent}:conversationWorkflowRunsV4`]: { runs: [] },
                [`${ServiceChannels.ZCodeAgent}:conversationPlansV4`]: { plans: [] },
              },
            }),
          );
        };
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "auth_init")
            socket.send(
              JSON.stringify({
                type: "auth_ack",
                device_sid: "e2e-device",
                pair_status: "matched",
              }),
            );
          if (message.type === "pair_status_query")
            socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
          const payload = message.payload;
          if (!payload) return;
          if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
            bridges.get(payload.bridgeSessionId)?.acceptPayload(payload);
            return;
          }
          const result = {
            windowControlSessionId: "e2e-device",
            desktopAppVersion: "3.15.1",
            workspaces,
            initialViewState: {
              activeWorkspaceKey: localPath,
              activeTaskId: "LOCAL_TASK",
              updatedAt: 1,
            },
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
            traffic.views.push(payload);
            send(socket, { zcode_type: "mobile-view-state-updated", requestId: payload.requestId });
          }
          if (payload.zcode_type === "workspace-bridge-open") {
            traffic.opens.push(payload);
            if (payload.workspaceKey === identity) {
              // 测试主动释放响应，断言等待阶段；不用定时器制造时序。
              pending = () => {
                if (failNext) {
                  failNext = false;
                  send(socket, {
                    zcode_type: "workspace-bridge-error",
                    requestId: payload.requestId,
                    bridgeSessionId: payload.bridgeSessionId,
                    bridgeGeneration: payload.bridgeGeneration,
                    reason: "unexpected-error",
                    error: "E2E_MRO01_BRIDGE_REJECTED",
                  });
                } else ready(payload);
              };
            } else ready(payload);
          }
        });
      });
      try {
        await page.goto(
          new URL("/remote/v4?app_version=3.15.1&sid=e2e-device&mid=e2e-mid", origin).href,
        );
        const local = page.locator('[data-project-name="E2E_MRO01_LOCAL"]');
        const remote = page.locator('[data-project-name="E2E_MRO01_REMOTE"]');
        const onboarding = page.getByTestId("onboarding-page");
        const welcome = page.getByRole("dialog", { name: /欢迎使用 ZCode|Welcome to ZCode/ });
        await local.or(onboarding).or(welcome).first().waitFor();
        if (await onboarding.isVisible())
          await onboarding.getByRole("button", { name: /退出引导|Exit onboarding/ }).click();
        await local.or(welcome).first().waitFor();
        if (await welcome.isVisible())
          await welcome.getByRole("button", { name: /^(Close|关闭)$/ }).click();
        for (const row of [local, remote]) {
          await row.waitFor();
          const toggle = row.getByTestId("virtual-project-toggle");
          if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        }
        const remoteTask = remote.getByText("E2E_MRO01_REMOTE_TASK", { exact: true });
        const home = page.locator('[data-mobile-page="home"]');
        const chat = page.locator('[data-mobile-page="chat"]');
        await home.waitFor();
        // 先实际打开本地历史再返回列表，确保失败场景持有可被误展示的旧会话。
        await local.getByText("E2E_MRO01_LOCAL_TASK", { exact: true }).click();
        await chat.waitFor();
        await assertEventually(() => snapshots.has("LOCAL_TASK"));
        snapshots.get("LOCAL_TASK")();
        await page.getByText("E2E_MRO01_LOCAL_TASK_HISTORY", { exact: true }).waitFor();
        await page.goBack();
        await home.waitFor();
        const subscriptionsBefore = traffic.subscriptions.length;
        await remoteTask.click();
        await assertEventually(() => Boolean(pending));
        assert.equal(await home.isVisible(), true, "等待远端 bridge 时必须保留列表");
        assert.equal(await chat.count(), 0, "不得提前展示旧本地会话");
        pending();
        pending = undefined;
        await page.getByText("E2E_MRO01_BRIDGE_REJECTED", { exact: true }).waitFor();
        assert.equal(await home.isVisible(), true);
        assert.equal(await chat.count(), 0);
        assert.equal(await page.getByText("[object Object]", { exact: true }).count(), 0);
        assert.equal(traffic.subscriptions.length, subscriptionsBefore);
        const prefix = `${theme}-${locale}`;
        await page.screenshot({
          path: resolve(artifacts, `${prefix}-failure.png`),
          fullPage: true,
        });
        await remoteTask.click();
        await assertEventually(() => Boolean(pending));
        assert.equal(await home.isVisible(), true);
        pending();
        pending = undefined;
        await chat.waitFor();
        await page.locator('[data-session-id="REMOTE_TASK"]').waitFor();
        await assertEventually(() =>
          traffic.subscriptions.some(
            (s) => s.sessionId === "REMOTE_TASK" && s.workspaceIdentity === identity,
          ),
        );
        snapshots.get("REMOTE_TASK")();
        await page.getByText("E2E_MRO01_REMOTE_TASK_HISTORY", { exact: true }).waitFor();
        assert.equal(
          await page.getByText("E2E_MRO01_LOCAL_TASK_HISTORY", { exact: true }).count(),
          0,
        );
        assert.equal(await page.locator('[data-session-id="LOCAL_TASK"]').count(), 0);
        assert.deepEqual(
          traffic.opens
            .filter((p) => p.workspaceKey === identity)
            .map((p) => ({ taskId: p.taskId, hostId: p.taskHostId })),
          [
            { taskId: "REMOTE_TASK", hostId },
            { taskId: "REMOTE_TASK", hostId },
          ],
        );
        await page.screenshot({
          path: resolve(artifacts, `${prefix}-success.png`),
          fullPage: true,
        });
        // 返回列表再打开当前 workspace 的任务，不应再申请 bridge。
        await page.goBack();
        await home.waitFor();
        const opensBefore = traffic.opens.length;
        await page.getByText("E2E_MRO01_REMOTE_TASK", { exact: true }).click();
        await chat.waitFor();
        assert.equal(traffic.opens.length, opensBefore);
        assert.deepEqual(h.errors, []);
        results.push({ theme, locale, result: "passed" });
      } catch (error) {
        await page.screenshot({ path: resolve(artifacts, "failure.png"), fullPage: true });
        console.error((await page.locator("body").innerText()).slice(-5000), h.errors);
        throw error;
      } finally {
        await writeFile(
          resolve(artifacts, `${theme}-${locale}-traffic.json`),
          JSON.stringify(traffic, null, 2),
        );
        await h.context.close();
      }
    }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`MRO01 passed: ${results.length} configurations; ${artifacts}`);
} finally {
  await browser.close();
}
