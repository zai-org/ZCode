import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ProjectTree, VirtualProject } from "@zcode/services";
import {
  buildRemoteHostWorkspaceIdentity,
  parseWebRemoteControlAppPayload,
  ServiceChannels,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND, TID_V4_STOP } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { redactMobileDiagnosticText } from "#e2e/helpers/mobile-pairing";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { prepareSSHConnectionPage } from "#e2e/helpers/ssh-remote-p0";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  ensureUpstreamProviderForE2E,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "#e2e/helpers/upstream-provider";
import {
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { createWebRemoteVisibilityBrowser } from "#e2e/helpers/web-remote-visibility-browser";

const CASE = "E2E_MRO04";
const CASE_NAME = "conversation-session-web-remote-recovery";

interface RecoveryEvidence {
  scenario: "lost-invalidation" | "native-background";
  faultStartedAt?: number;
  blockedBridgeSessionId?: string;
  droppedRawFrames: number;
  droppedInvalidations: number;
  hiddenAt?: number;
  invalidatedAt?: number;
  visibleAt?: number;
  restoredAt?: number;
  invalidations: number;
  duplicateInvalidations: number;
  recoveryOpens: Array<{ workspaceKey?: string; taskId?: string; bridgeSessionId: string }>;
  originalTaskId?: string;
  failure?: string;
}

async function readDesktopWorkspacePaths(): Promise<string[]> {
  return browser.execute(() => {
    const state = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): { tabs: Array<{ workspacePath?: string }> };
        };
      }
    ).__zcodeTabStoreE2E?.getState();
    if (!state) throw new Error("MRO04 desktop tab store missing");
    return state.tabs.flatMap((tab) => (tab.workspacePath ? [tab.workspacePath] : []));
  });
}

async function readWebWorkspace(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (
      window as Window & {
        __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
      }
    ).__zcodeTabStoreE2E?.getState();
    return state?.activeWorkspacePath ?? null;
  });
}

type NativeWebRemote = Awaited<ReturnType<typeof createWebRemoteVisibilityBrowser>>;

/** 桌面配置受控 provider，并保存一个只由手机打开的项目目录。 */
async function prepareMobileOnlyProject(label: string) {
  await prepareSSHConnectionPage(CASE);
  // 全局新建会分配独立cwd；先走项目级新建，再让provider helper检查夹具目录。
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  await selectUpstreamModel();
  await selectUpstreamThoughtLevel();
  await installHandoffRpcProbe();
  const workspacePath = resolveE2ERuntimePath(CASE_NAME, `mobile-only-${label}`);
  await mkdir(workspacePath, { recursive: true });
  const project = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
    { name: `${CASE}_${label}`, roots: [workspacePath], primaryRoot: workspacePath },
  ]);
  expect(await readDesktopWorkspacePaths()).not.toContain(workspacePath);
  return { workspacePath, project, pairingUrl: await obtainUnreadPairingUrl() };
}

/** Web 进入手机独立项目并新建草稿；桌面 tabs 不应因此打开该目录。 */
async function openMobileOnlyDraft(
  native: NativeWebRemote,
  target: { workspacePath: string; project: VirtualProject; pairingUrl: string },
) {
  const { page } = native;
  const projectSelector = `[data-project-id=${JSON.stringify(target.project.id)}]`;
  await native.navigate(target.pairingUrl, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS, projectSelector);
  const row = page.locator(projectSelector).first();
  await row.hover();
  await row.getByTestId("virtual-project-create-task").click();
  await page.locator('[data-session-id="draft"]').waitFor({ timeout: 30_000 });
  await browser.waitUntil(async () => (await readWebWorkspace(page)) === target.workspacePath, {
    timeout: 30_000,
    timeoutMsg: "MRO04 Web project admission did not select its own directory",
  });
  expect(await readDesktopWorkspacePaths()).not.toContain(target.workspacePath);
}

async function waitForWebTaskDone(page: Page, taskId: string, done: string, timeout: number) {
  await page.waitForFunction(
    ({ taskId, done, stopTestId }) => {
      const pane = document.querySelector(`[data-session-id="${taskId}"]`);
      return Boolean(
        pane?.textContent?.includes(done) &&
        !Array.from(pane.querySelectorAll(`[data-testid="${stopTestId}"]`)).some(
          (stop) => stop.getClientRects().length > 0,
        ),
      );
    },
    { taskId, done, stopTestId: TID_V4_STOP },
    { timeout },
  );
}

describe(`${CASE}: 失效通知补发与长后台恢复原项目任务`, () => {
  after(async () => {
    await restoreHandoffProbes();
    await clearAppData();
  });

  for (const width of [1440, 390]) {
    const loseInvalidation = width === 1440;
    const title = loseInvalidation
      ? "首次失效通知丢失后15秒内补发恢复原task，重复通知只恢复一次"
      : "真实后台46秒后回前台15秒内显示原task完成内容";
    it(`MRO04-${width}: ${title}`, async function () {
      this.timeout(5 * 60_000);
      const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (!artifacts || !process.env.ZCODE_E2E_HOME_DIR)
        throw new Error("MRO04 requires isolated Electron runner");
      const target = await prepareMobileOnlyProject(String(width));
      const { workspacePath, pairingUrl } = target;
      const native = await createWebRemoteVisibilityBrowser(artifacts, {
        width,
        caseMarker: `MRO04-${width}`,
      });
      const { page } = native;
      const evidence: RecoveryEvidence = {
        scenario: loseInvalidation ? "lost-invalidation" : "native-background",
        droppedRawFrames: 0,
        droppedInvalidations: 0,
        invalidations: 0,
        duplicateInvalidations: 0,
        recoveryOpens: [],
      };
      let staleInvalidation: string | Buffer | undefined;
      let staleReplayed = false;
      let currentBridgeSessionId: string | undefined;
      try {
        // 原生后台允许Web先自愈，不能强制桌面先降级。补发场景单独丢旧bridge下行数据和首条
        // 真实失效通知，保留ACK与心跳；两条路径都不改时钟/可见性，也不提前制造失效通知。
        await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
          const server = route.connectToServer();
          route.onMessage((message) => {
            const frame = JSON.parse(String(message)) as { payload?: unknown };
            const payload = parseWebRemoteControlAppPayload(frame.payload);
            if (
              payload?.zcode_type === "workspace-bridge-open" &&
              (evidence.hiddenAt || evidence.faultStartedAt)
            )
              evidence.recoveryOpens.push({
                workspaceKey: payload.workspaceKey,
                taskId: payload.taskId,
                bridgeSessionId: payload.bridgeSessionId,
              });
            server.send(message);
          });
          server.onMessage((message) => {
            const frame = JSON.parse(String(message)) as { payload?: unknown };
            const payload = parseWebRemoteControlAppPayload(frame.payload);
            if (payload?.zcode_type === "workspace-bridge-ready")
              currentBridgeSessionId = payload.bridgeSessionId;
            if (
              loseInvalidation &&
              evidence.faultStartedAt &&
              payload?.zcode_type === "rpc-frame" &&
              payload.bridgeSessionId === evidence.blockedBridgeSessionId
            ) {
              evidence.droppedRawFrames += 1;
              return;
            }
            const observedInvalidation =
              payload?.zcode_type === "bridge-degraded" &&
              Boolean(evidence.hiddenAt || evidence.faultStartedAt);
            if (observedInvalidation) {
              evidence.invalidations += 1;
              evidence.invalidatedAt ??= Date.now();
              staleInvalidation = message;
              if (loseInvalidation && evidence.droppedInvalidations === 0) {
                evidence.droppedInvalidations += 1;
                return;
              }
            }
            route.send(message);
            if (loseInvalidation && observedInvalidation) {
              route.send(message);
              route.send(message);
              evidence.duplicateInvalidations += 2;
            }
            if (
              loseInvalidation &&
              payload?.zcode_type === "workspace-bridge-ready" &&
              evidence.faultStartedAt &&
              staleInvalidation &&
              !staleReplayed
            ) {
              staleReplayed = true;
              route.send(staleInvalidation);
            }
          });
        });
        await openMobileOnlyDraft(native, target);

        await sendV4Prompt(`${CASE}_DESKTOP_${width}: 只回复受控回放内容，不调用工具。`);
        await waitForV4AssistantMessageContaining(`MRO04_DESKTOP_${width}_STREAMING`, 90_000);
        // 桌面操作可能遮挡原生Chrome；发送前明确恢复visible，不把非预期后台混入发送前置。
        await native.show();
        await page
          .getByTestId(TID_V4_COMPOSER_INPUT)
          .first()
          .fill(`${CASE}_MOBILE_${width}: 只回复受控回放内容，不调用工具。`);
        await page.getByTestId(TID_V4_COMPOSER_SEND).first().click();
        await page.getByText(`MRO04_MOBILE_${width}_STREAMING`, { exact: false }).first().waitFor({
          timeout: 90_000,
        });
        const taskId = await page
          .locator('[data-session-id]:not([data-session-id="draft"])')
          .first()
          .getAttribute("data-session-id");
        if (!taskId) throw new Error("MRO04 Web draft did not create a task");
        evidence.originalTaskId = taskId;
        await page.getByTestId(TID_V4_STOP).first().waitFor();
        if (loseInvalidation) {
          expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
          if (!currentBridgeSessionId) throw new Error("MRO04 active Web bridge missing");
          evidence.blockedBridgeSessionId = currentBridgeSessionId;
          evidence.faultStartedAt = Date.now();
        } else {
          await native.hide();
          evidence.hiddenAt = Date.now();
        }
        await releaseControlledReplay(`mro04-mobile-${width}`);
        await releaseControlledReplay(`mro04-desktop-${width}`);
        // 桌面continuous与同Host权威任务都必须已完成，不能把未结束的模型误判为Web恢复延迟。
        await waitForV4AssistantMessageContaining(`MRO04_DESKTOP_${width}_DONE`, 30_000);
        await waitForV4ConversationState(
          (state) => state.state === "idle",
          "MRO04 desktop busy",
          30_000,
        );
        await browser.waitUntil(
          async () => {
            const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
              {},
            ]);
            return tree.tasks.some((task) => task.taskId === taskId && task.status === "completed");
          },
          { timeout: 30_000, timeoutMsg: "MRO04 mobile task did not finish in the Host" },
        );
        let recoveryStartedAt: number;
        if (loseInvalidation) {
          await browser.waitUntil(() => Boolean(evidence.invalidatedAt), {
            timeout: 60_000,
            interval: 100,
            timeoutMsg: "MRO04 dropped downlink did not reach the real raw deadline",
          });
          expect(evidence.droppedRawFrames).toBeGreaterThan(0);
          expect(evidence.droppedInvalidations).toBe(1);
          expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
          recoveryStartedAt = evidence.invalidatedAt!;
        } else {
          await browser.waitUntil(() => Date.now() - evidence.hiddenAt! >= 46_000, {
            timeout: 60_000,
            interval: 200,
            timeoutMsg: "MRO04 native background interval incomplete",
          });
          expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
          evidence.visibleAt = Date.now();
          await native.show();
          recoveryStartedAt = evidence.visibleAt;
        }
        await waitForWebTaskDone(
          page,
          taskId,
          `MRO04_MOBILE_${width}_DONE`,
          Math.max(1, 15_000 - (Date.now() - recoveryStartedAt)),
        );
        evidence.restoredAt = Date.now();
        expect(evidence.restoredAt - recoveryStartedAt).toBeLessThan(15_000);
        expect(await readWebWorkspace(page)).toBe(workspacePath);
        expect(await readDesktopWorkspacePaths()).not.toContain(workspacePath);
        if (loseInvalidation) {
          expect(evidence.invalidations).toBeGreaterThanOrEqual(2);
          expect(evidence.duplicateInvalidations).toBeGreaterThan(0);
          expect(staleReplayed).toBe(true);
          expect(evidence.recoveryOpens).toHaveLength(1);
          expect(evidence.recoveryOpens[0]).toMatchObject({ workspaceKey: workspacePath, taskId });
        }
        await native.screenshot(`MRO04-${width}-restored.png`);
      } catch (error) {
        evidence.failure = redactMobileDiagnosticText(String(error), pairingUrl);
        await native.screenshot(`MRO04-${width}-failure.png`).catch(() => undefined);
        throw error;
      } finally {
        await writeFile(join(artifacts, `MRO04-${width}.json`), JSON.stringify(evidence, null, 2));
        await native.close();
        await restoreHandoffProbes();
      }
    });
  }
  it("MRO04-06: 运行中短后台持续收帧，回前台复用原socket与bridge完成原task", async function () {
    this.timeout(4 * 60_000);
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!artifacts || !process.env.ZCODE_E2E_HOME_DIR)
      throw new Error("MRO04 requires isolated Electron runner");
    const marker = "MRO04-short-390";
    const fixtureId = "mro04-mobile-short-390";
    const target = await prepareMobileOnlyProject("short-390");
    const native = await createWebRemoteVisibilityBrowser(artifacts, {
      width: 390,
      caseMarker: marker,
    });
    const { page } = native;
    const evidence = {
      sockets: 0,
      socketsAtHide: 0,
      hiddenAt: undefined as number | undefined,
      visibleAt: undefined as number | undefined,
      restoredAt: undefined as number | undefined,
      hiddenDownlinkRawFrames: 0,
      hiddenUplinkAcks: 0,
      hiddenUplinkFrames: 0,
      bridgeOpensAfterHide: 0,
      bridgeAtHide: undefined as string | undefined,
      bridgeAtEnd: undefined as string | undefined,
      failure: undefined as string | undefined,
    };
    let hidden = false;
    try {
      // 只观察真实线级消息，不丢帧、不改时钟或可见性。桌面心跳会补发未确认帧，
      // 只看最终内容无法区分修复前后，因此同时记录后台 ACK、socket 数与 bridge-open。
      await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
        evidence.sockets += 1;
        const server = route.connectToServer();
        route.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { payload?: unknown };
          const payload = parseWebRemoteControlAppPayload(frame.payload);
          if (evidence.hiddenAt && payload?.zcode_type === "workspace-bridge-open")
            evidence.bridgeOpensAfterHide += 1;
          if (hidden && payload?.zcode_type === "rpc-frame-ack") evidence.hiddenUplinkAcks += 1;
          if (hidden && payload?.zcode_type === "rpc-frame") evidence.hiddenUplinkFrames += 1;
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { payload?: unknown };
          const payload = parseWebRemoteControlAppPayload(frame.payload);
          if (payload?.zcode_type === "workspace-bridge-ready")
            evidence.bridgeAtEnd = payload.bridgeSessionId;
          if (hidden && payload?.zcode_type === "rpc-frame") evidence.hiddenDownlinkRawFrames += 1;
          route.send(message);
        });
      });
      await openMobileOnlyDraft(native, target);
      await page
        .getByTestId(TID_V4_COMPOSER_INPUT)
        .first()
        .fill(`${CASE}_SHORT_390: 只回复受控回放内容，不调用工具。`);
      await page.getByTestId(TID_V4_COMPOSER_SEND).first().click();
      await page.getByText("MRO04_SHORT_390_STREAMING", { exact: false }).first().waitFor({
        timeout: 90_000,
      });
      const taskId = await page
        .locator('[data-session-id]:not([data-session-id="draft"])')
        .first()
        .getAttribute("data-session-id");
      if (!taskId) throw new Error("MRO04-06 Web draft did not create a task");
      await page.getByTestId(TID_V4_STOP).first().waitFor();
      evidence.bridgeAtHide = evidence.bridgeAtEnd;
      evidence.socketsAtHide = evidence.sockets;

      await native.hide();
      evidence.hiddenAt = Date.now();
      hidden = true;
      // 第一段在后台约 4.5 秒内持续输出；停留 8 秒覆盖桌面心跳补发，仍短于 45 秒 raw 期限。
      await releaseControlledReplay(fixtureId);
      await browser.waitUntil(() => Date.now() - evidence.hiddenAt! >= 8_000, {
        timeout: 20_000,
        interval: 200,
        timeoutMsg: "MRO04-06 native background interval incomplete",
      });
      expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
      hidden = false;
      evidence.visibleAt = Date.now();
      await native.show();
      // 回前台后的新输出：后台若丢过帧，这里先到的新序号会触发断档与 bridge 重建。
      await releaseControlledReplay(fixtureId);
      await waitForWebTaskDone(page, taskId, "MRO04_SHORT_390_DONE", 15_000);
      evidence.restoredAt = Date.now();

      expect(evidence.visibleAt - evidence.hiddenAt).toBeLessThan(45_000);
      expect(evidence.hiddenDownlinkRawFrames).toBeGreaterThan(0);
      expect(evidence.hiddenUplinkAcks).toBeGreaterThan(0);
      expect(evidence.hiddenUplinkFrames).toBe(0);
      expect(evidence.bridgeOpensAfterHide).toBe(0);
      expect(evidence.sockets).toBe(evidence.socketsAtHide);
      expect(evidence.bridgeAtEnd).toBe(evidence.bridgeAtHide);
      const paneText = await page.locator(`[data-session-id="${taskId}"]`).first().textContent();
      for (const part of ["HIDDEN_1", "HIDDEN_4", "VISIBLE", "DONE"])
        expect(paneText).toContain(`MRO04_SHORT_390_${part}`);
      expect(await readWebWorkspace(page)).toBe(target.workspacePath);
      await native.screenshot(`${marker}-restored.png`);
    } catch (error) {
      evidence.failure = redactMobileDiagnosticText(String(error), target.pairingUrl);
      await native.screenshot(`${marker}-failure.png`).catch(() => undefined);
      throw error;
    } finally {
      await writeFile(join(artifacts, `${marker}.json`), JSON.stringify(evidence, null, 2));
      await native.close();
      await restoreHandoffProbes();
    }
  });
  it("MRO04-07: 后台多个在途ACK各收到INTERNAL，回前台先探测原socket，桌面离开期间不进失败页", async function () {
    this.timeout(4 * 60_000);
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!artifacts || !process.env.ZCODE_E2E_HOME_DIR)
      throw new Error("MRO04 requires isolated Electron runner");
    const marker = "MRO04-internal-390";
    const fixtureId = "mro04-mobile-internal-390";
    // 大于后台一批增量的跨度（约0.9秒），保证首个 INTERNAL 到达前已有多个 ACK 在途。
    const internalDelayMs = 2_000;
    // 恢复须落在回前台后15秒的 recover 窗口内，才按原 workspace/task 恢复；更长会触发原有的导航丢失
    // （配对后 bootstrap 不带原导航）。修复前后的区分靠后台是否关闭原 socket，不靠失败页时间。
    const awayVisibleMs = 10_000;
    const failureTitles = ["桌面端已离线", "Desktop Offline"];
    const target = await prepareMobileOnlyProject("internal-390");
    const native = await createWebRemoteVisibilityBrowser(artifacts, {
      width: 390,
      caseMarker: marker,
    });
    const { page } = native;
    // normal 透传；hold 拦截手机 data 并延迟回 INTERNAL；away 另丢弃下行 data、把配对回包改为 waiting。
    let mode: "normal" | "hold" | "away" = "normal";
    let dataInFlight = 0;
    const evidence = {
      hiddenAt: undefined as number | undefined,
      visibleAt: undefined as number | undefined,
      restoredAt: undefined as number | undefined,
      doneAt: undefined as number | undefined,
      socketAtHide: -1,
      sockets: [] as Array<{ openedAt: number; closedAt?: number; closedBy?: "page" | "relay" }>,
      interceptedData: 0,
      interceptedAcks: 0,
      internals: [] as Array<{ socket: number; at: number; dataInFlight: number }>,
      rewrittenPairStatus: 0,
      droppedDownlinkData: 0,
      probesAfterShow: [] as Array<{ socket: number; at: number }>,
      failureSeenAt: undefined as number | undefined,
      paneDetachedAt: undefined as number | undefined,
      failure: undefined as string | undefined,
    };
    try {
      // loopback relay 在桌面断开时发 DEVICE_OFFLINE 并关闭手机 socket，走不到 INTERNAL 路径。
      // 这里只在手机线级按 hub 契约模拟“找不到桌面”：data 回 INTERNAL 且不关 socket；桌面与 relay
      // 的真实连接不变，握手和查询照常转发、只改回包配对态，保证 relay 侧会话始终已认证。
      await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
        const socket = evidence.sockets.length;
        const record: (typeof evidence.sockets)[number] = { openedAt: Date.now() };
        evidence.sockets.push(record);
        const server = route.connectToServer();
        route.onClose((code, reason) => {
          record.closedAt ??= Date.now();
          record.closedBy ??= "page";
          void server.close({ code, reason });
        });
        server.onClose((code, reason) => {
          record.closedAt ??= Date.now();
          record.closedBy ??= "relay";
          void route.close({ code, reason });
        });
        route.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { type?: string; payload?: unknown };
          if (frame.type === "pair_status_query" && evidence.visibleAt)
            evidence.probesAfterShow.push({ socket, at: Date.now() });
          if (mode !== "normal" && frame.type === "data") {
            evidence.interceptedData += 1;
            if (parseWebRemoteControlAppPayload(frame.payload)?.zcode_type === "rpc-frame-ack")
              evidence.interceptedAcks += 1;
            dataInFlight += 1;
            setTimeout(() => {
              evidence.internals.push({ socket, at: Date.now(), dataInFlight });
              dataInFlight -= 1;
              if (mode === "hold") mode = "away";
              if (!record.closedAt) route.send(JSON.stringify({ type: "error", code: "INTERNAL" }));
            }, internalDelayMs);
            return;
          }
          server.send(message);
        });
        server.onMessage((message) => {
          if (mode !== "away") {
            route.send(message);
            return;
          }
          const frame = JSON.parse(String(message)) as { type?: string; pair_status?: string };
          if (frame.type === "data") {
            evidence.droppedDownlinkData += 1;
            return;
          }
          if (
            (frame.type === "auth_ack" || frame.type === "pair_status_ack") &&
            frame.pair_status === "matched"
          ) {
            evidence.rewrittenPairStatus += 1;
            route.send(JSON.stringify({ ...frame, pair_status: "waiting" }));
            return;
          }
          route.send(message);
        });
      });
      await openMobileOnlyDraft(native, target);
      await page
        .getByTestId(TID_V4_COMPOSER_INPUT)
        .first()
        .fill(`${CASE}_INTERNAL_390: 只回复受控回放内容，不调用工具。`);
      await page.getByTestId(TID_V4_COMPOSER_SEND).first().click();
      await page.getByText("MRO04_INTERNAL_390_STREAMING", { exact: false }).first().waitFor({
        timeout: 90_000,
      });
      const taskId = await page
        .locator('[data-session-id]:not([data-session-id="draft"])')
        .first()
        .getAttribute("data-session-id");
      if (!taskId) throw new Error("MRO04-07 Web draft did not create a task");
      await page.getByTestId(TID_V4_STOP).first().waitFor();
      evidence.socketAtHide = evidence.sockets.length - 1;
      expect(evidence.sockets[evidence.socketAtHide]?.closedAt).toBeUndefined();

      await native.hide();
      evidence.hiddenAt = Date.now();
      mode = "hold";
      // 一批增量约0.9秒内到达，手机逐条回 ACK；全部 INTERNAL 回完后仍留足8秒后台。
      await releaseControlledReplay(fixtureId);
      await browser.waitUntil(
        () =>
          evidence.interceptedAcks >= 2 &&
          evidence.internals.length >= evidence.interceptedData &&
          Date.now() - evidence.hiddenAt! >= 8_000,
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg: "MRO04-07 hidden ACK/INTERNAL window incomplete",
        },
      );
      expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");

      evidence.visibleAt = Date.now();
      await native.show();
      // 桌面仍“离开”：只观察，不驱动页面。失败页是终态，出现即停止观察。
      const paneSelector = `[data-session-id="${taskId}"]`;
      while (Date.now() - evidence.visibleAt < awayVisibleMs && !evidence.failureSeenAt) {
        const view = await page.evaluate(
          ({ paneSelector, failureTitles }) => ({
            pane: document.querySelector(paneSelector) !== null,
            failure: failureTitles.some((title) => document.body.innerText.includes(title)),
          }),
          { paneSelector, failureTitles },
        );
        if (!view.pane) evidence.paneDetachedAt ??= Date.now();
        if (view.failure) evidence.failureSeenAt = Date.now();
        await browser.pause(500);
      }
      await native.screenshot(`${marker}-away-end.png`);

      // 前置：线级确实复现“首个 INTERNAL 到达前已有多个 ACK 在途”，否则不能区分修复前后。
      expect(evidence.interceptedAcks).toBeGreaterThanOrEqual(2);
      expect(evidence.internals[0]?.dataInFlight).toBeGreaterThanOrEqual(2);
      expect(
        evidence.internals.filter((entry) => entry.at < evidence.visibleAt!).length,
      ).toBeGreaterThanOrEqual(2);
      // 用户可见症状：桌面离开期间不出现失败页，原 task 面板保持挂载。
      expect(evidence.failureSeenAt).toBeUndefined();
      expect(evidence.paneDetachedAt).toBeUndefined();
      // 首次偏离：修复前第二个 INTERNAL 在后台关闭原 socket，回前台改为新建连接。
      const original = evidence.sockets[evidence.socketAtHide]!;
      expect(original.closedAt === undefined || original.closedAt >= evidence.visibleAt).toBe(true);
      expect(evidence.probesAfterShow[0]?.socket).toBe(evidence.socketAtHide);

      mode = "normal";
      evidence.restoredAt = Date.now();
      await releaseControlledReplay(fixtureId);
      await waitForWebTaskDone(page, taskId, "MRO04_INTERNAL_390_DONE", 15_000);
      evidence.doneAt = Date.now();
      const paneText = await page.locator(paneSelector).first().textContent();
      for (const part of ["HIDDEN_1", "HIDDEN_4", "VISIBLE", "DONE"])
        expect(paneText).toContain(`MRO04_INTERNAL_390_${part}`);
      expect(await readWebWorkspace(page)).toBe(target.workspacePath);
      await native.screenshot(`${marker}-restored.png`);
    } catch (error) {
      evidence.failure = redactMobileDiagnosticText(String(error), target.pairingUrl);
      await native.screenshot(`${marker}-failure.png`).catch(() => undefined);
      throw error;
    } finally {
      await writeFile(join(artifacts, `${marker}.json`), JSON.stringify(evidence, null, 2));
      await native.close();
      await restoreHandoffProbes();
    }
  });
  for (const width of [1440, 390]) {
    for (const scenario of ["offline", "deleted-task", "removed-host"] as const) {
      it(`MRO04-cold-${width}-${scenario}: 首次加载和刷新使用可用workspace`, async function () {
        this.timeout(3 * 60_000);
        const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
        if (!artifacts || !process.env.ZCODE_E2E_HOME_DIR)
          throw new Error("MRO04 cold start requires isolated Electron runner");
        await prepareSSHConnectionPage(CASE);
        await startDraftFromProject(DEFAULT_WORKSPACE);
        const desktopPaths = await readDesktopWorkspacePaths();
        const pairingUrl = await obtainUnreadPairingUrl();
        const marker = `MRO04-cold-${width}-${scenario}`;
        const native = await createWebRemoteVisibilityBrowser(artifacts, {
          width,
          caseMarker: marker,
        });
        const { page } = native;
        const evidence = {
          bootstraps: 0,
          opens: [] as Array<
            Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-bridge-open" }>
          >,
          ready: [] as string[],
          viewUpdates: [] as string[],
          errors: [] as string[],
          failure: undefined as string | undefined,
        };
        const staleKey =
          scenario === "deleted-task"
            ? resolveE2ERuntimePath(CASE_NAME, "closed-project")
            : buildRemoteHostWorkspaceIdentity("remote:server:removed-mro04", "/workspace/closed");
        try {
          // 只在真实 bootstrap 边界注入旧导航，保留认证、版本与实际可用候选。
          // 后续 bridge 和 RPC 仍由真实 Desktop/Host 处理，不能模拟一个成功首页。
          await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
            const server = route.connectToServer();
            route.onMessage((message) => {
              const frame = JSON.parse(String(message)) as { payload?: unknown };
              const payload = parseWebRemoteControlAppPayload(frame.payload);
              if (payload?.zcode_type === "workspace-bridge-open") evidence.opens.push(payload);
              if (payload?.zcode_type === "mobile-view-state-update")
                evidence.viewUpdates.push(payload.viewState.activeWorkspaceKey ?? "");
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = JSON.parse(String(message)) as { payload?: unknown };
              const payload = parseWebRemoteControlAppPayload(frame.payload);
              if (payload?.zcode_type === "workspace-bridge-ready")
                evidence.ready.push(payload.bridge.workspaceKey);
              if (payload?.zcode_type === "workspace-bridge-error")
                evidence.errors.push(payload.error);
              if (payload?.zcode_type === "bootstrap-response") {
                evidence.bootstraps += 1;
                route.send(
                  JSON.stringify({
                    ...frame,
                    payload: {
                      ...payload,
                      result: {
                        ...payload.result,
                        workspaces: [
                          ...(scenario === "offline"
                            ? [
                                {
                                  workspacePath: "/workspace/closed",
                                  workspaceIdentity: staleKey,
                                  kind: "remote",
                                  label: "MRO04 offline",
                                  connectionState: "disconnected",
                                },
                              ]
                            : []),
                          ...payload.result.workspaces,
                        ],
                        mobileViewState: {
                          activeWorkspaceKey: staleKey,
                          activeTaskId: "missing-mro04-task",
                          updatedAt: 1,
                        },
                      },
                    },
                  }),
                );
                return;
              }
              route.send(message);
            });
          });
          for (const phase of ["initial", "reload"] as const) {
            const readyBefore = evidence.ready.length;
            const viewsBefore = evidence.viewUpdates.length;
            if (phase === "initial")
              await native.navigate(pairingUrl, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
            else await page.reload({ waitUntil: "domcontentloaded" });
            await browser.waitUntil(
              () => evidence.ready.length > readyBefore || evidence.errors.length > 0,
              { timeout: 30_000, timeoutMsg: `${marker}: no usable bridge after ${phase}` },
            );
            expect(evidence.errors).toEqual([]);
            expect(evidence.ready.at(-1)).toBe(DEFAULT_WORKSPACE);
            await browser.waitUntil(
              async () =>
                (await readWebWorkspace(page)) === DEFAULT_WORKSPACE &&
                evidence.viewUpdates.slice(viewsBefore).includes(DEFAULT_WORKSPACE),
              { timeout: 30_000, timeoutMsg: `${marker}: fallback navigation not published` },
            );
            await page.getByTestId("sidebar").waitFor();
            expect(await readDesktopWorkspacePaths()).toEqual(desktopPaths);
            await native.screenshot(`${marker}-${phase}.png`);
          }
          expect(evidence.bootstraps).toBeGreaterThanOrEqual(2);
          expect(evidence.opens.length).toBeGreaterThanOrEqual(2);
          for (const request of evidence.opens) {
            expect(request.workspaceKey).toBe(DEFAULT_WORKSPACE);
            expect(request.taskId).toBeUndefined();
            expect(request.taskHostId).toBeUndefined();
          }
        } catch (error) {
          evidence.failure = redactMobileDiagnosticText(String(error), pairingUrl);
          await native.screenshot(`${marker}-failure.png`).catch(() => undefined);
          throw error;
        } finally {
          await writeFile(join(artifacts, `${marker}.json`), JSON.stringify(evidence, null, 2));
          await native.close();
        }
      });
    }
  }
});
