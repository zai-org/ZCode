import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type WebRemoteControlStatus } from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { readSettings } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import {
  bringRemoteDeviceOnline,
  readRemoteDockerContainer,
  takeRemoteDeviceOffline,
} from "#e2e/helpers/remote-docker-target";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_MOBILE_STARTUP_RESTORE";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-startup");
const CHROME =
  process.env.R3_MOBILE_CHROME?.trim() ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function remoteStatus() {
  const serialized = await browser.execute(async () => {
    const bridge = (
      window as Window & { zcode?: { getWebRemoteControlStatus(): Promise<{ status: string }> } }
    ).zcode;
    if (!bridge) throw new Error("缺少 preload 远控接口");
    // WebDriver 把返回对象的 error 字段当成协议错误；序列化后再在测试端还原真实状态。
    return JSON.stringify(await bridge.getWebRemoteControlStatus());
  });
  return JSON.parse(serialized) as WebRemoteControlStatus;
}

async function onlineDevices(origin: string) {
  const response = await fetch(`${origin}/api/v1/remote/device`, {
    headers: { Authorization: "Bearer mock-token" },
  });
  const devices = (await response.json()).data as Array<{ device_sid: string; online: boolean }>;
  return devices.filter((device) => device.online).map((device) => device.device_sid);
}

describe(`${CASE_MARKER}: 上次远控目标是 SSH 项目，重启时远端离线`, () => {
  it("AUTH-09-R: 远端离线时恢复设备连接，手机可配对，远端恢复后手机进入该项目，桌面弹窗沿用原连接", async function () {
    this.timeout(15 * 60_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    if (!origin) throw new Error(`${CASE_MARKER}: 缺少 loopback relay fixture`);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const facts: Record<string, unknown> = {};
    await mkdir(artifactDir, { recursive: true });

    // 1. 连接 SSH 项目，在该项目打开远控弹窗，使它成为上次启用目标。
    await prepareSSHConnectionPage(CASE_MARKER);
    const connected = await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    const identity = connected.workspaceIdentity;
    if (!identity) throw new Error(`${CASE_MARKER}: SSH 项目缺少 workspaceIdentity`);
    const projectId = await $(`[data-project-workspace-identity="${identity}"]`).getAttribute(
      "data-project-id",
    );
    if (!projectId) throw new Error(`${CASE_MARKER}: SSH 项目缺少 projectId`);
    const trigger = $('button[aria-label="移动端远程控制"]');
    await trigger.waitForClickable({ timeout: 30_000 });
    await trigger.click();
    await browser.waitUntil(
      async () => {
        const status = await remoteStatus();
        return status.status === "running" && status.workspaceIdentity === identity;
      },
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 在 SSH 项目开启远控失败` },
    );
    await browser.keys("Escape");
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        const lastActive = settings.lastActiveWorkspace as { workspaceIdentity?: string } | null;
        return (
          settings.webRemoteControlLastEnabledContext?.workspaceIdentity === identity &&
          lastActive?.workspaceIdentity === identity
        );
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 上次启用目标或激活项目未写入 SSH 项目` },
    );

    // 2. 远端离线后重启：窗口只恢复断开的 SSH 项目，启动重连会失败。
    await takeRemoteDeviceOffline(container);
    let mobileBrowser: { close(): Promise<void> } | null = null;
    try {
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForRendererAfterColdRestart(CASE_MARKER);

      // 3. 修复点：远端没连上也要恢复设备连接，初始目标仍是上次的 SSH 项目。
      await browser.waitUntil(async () => (await remoteStatus()).status === "running", {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 远端离线时重启未自动恢复远控`,
      });
      const restored = await remoteStatus();
      expect(restored.workspaceIdentity).toBe(identity);
      expect(restored.remoteSessionId).toBeUndefined();
      expect((await readRemoteTabSnapshot(identity)).remoteSessionId).toBeNull();
      await browser.waitUntil(async () => (await onlineDevices(origin)).length === 1, {
        timeout: 10_000,
        timeoutMsg: `${CASE_MARKER}: 自动恢复后 relay 上没有在线设备`,
      });
      facts.restored = {
        status: restored.status,
        workspaceIdentityMatches: restored.workspaceIdentity === identity,
        remoteSessionId: restored.remoteSessionId ?? null,
      };

      // 4. 手机用恢复后的链接配对。没有可 bridge 的工作区，手机进入 home-only，列出离线的 SSH 项目。
      const pairUrl = restored.connectUrl;
      if (!pairUrl?.startsWith("http")) throw new Error(`${CASE_MARKER}: 恢复后没有配对链接`);
      const { chromium } = await import("playwright-core");
      const launched = await chromium.launch({ headless: true, executablePath: CHROME });
      mobileBrowser = launched;
      const context = await launched.newContext({
        viewport: MOBILE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const mobile = await context.newPage();
      const workspaceRow = mobile.locator(`[data-home-only-workspace="${identity}"]`);
      await openMobilePairingPage(mobile, pairUrl, {
        artifactDir,
        caseMarker: CASE_MARKER,
        phase: "offline-remote-pairing",
        readySelector: `[data-home-only-workspace="${identity}"]`,
      });
      await browser.waitUntil(async () => Boolean((await remoteStatus()).mobileConnected), {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 桌面未看到手机连接`,
      });
      // 合成账号首次进入会弹会话迁移引导；它与本用例无关，取消后再操作首页。
      const dismissMigration = async () => {
        const cancel = mobile.getByTestId("onboarding-wizard-cancel");
        if (await cancel.isVisible()) {
          await cancel.click();
          await mobile.getByTestId("onboarding-migration-dialog").waitFor({ state: "hidden" });
        }
      };
      await dismissMigration();
      // 离线行带“ · 连接”动作；可 bridge 后该动作消失，行也不再禁用。
      expect(await workspaceRow.textContent()).toContain(" · ");
      await mobile.screenshot({
        path: resolve(artifactDir, "mobile-offline-remote-home.png"),
        fullPage: true,
        animations: "disabled",
      });

      // 5. 远端恢复；手机点离线行交给桌面重连，再点同一行进入项目并新建草稿。
      await bringRemoteDeviceOnline(container, { host: config.host, port: config.port });
      await workspaceRow.click();
      await browser.waitUntil(
        async () => Boolean((await readRemoteTabSnapshot(identity)).remoteSessionId),
        { timeout: 120_000, timeoutMsg: `${CASE_MARKER}: 手机触发的重连没有恢复 SSH 项目` },
      );
      await mobile.waitForFunction(
        (key: string) => {
          const row = document.querySelector<HTMLButtonElement>(
            `[data-home-only-workspace=${JSON.stringify(key)}]`,
          );
          return Boolean(row && !row.disabled && !row.textContent?.includes(" · "));
        },
        identity,
        { timeout: 60_000 },
      );
      await workspaceRow.click();
      // 打开工作区后手机可能直接显示该工作区的草稿，也可能先显示项目列表；两种落点都要进入同一个草稿。
      const projectCard = mobile.locator(`[data-project-id="${projectId}"]`);
      const composer = mobile.getByTestId(TID_V4_COMPOSER_INPUT).first();
      const pane = mobile.getByTestId(testId(TID_V4_SESSION_PANE, "workspace-main"));
      const onboarding = mobile.getByTestId("onboarding-page");
      try {
        await composer.or(projectCard).or(onboarding).first().waitFor({ timeout: 60_000 });
        // 切到远端 Host 后 Root 重建，隔离账号会再次看到职业引导；沿用配对 helper 的三步跳过。
        if (await onboarding.isVisible()) {
          for (const step of [1, 2, 3]) {
            await onboarding
              .locator('li[aria-current="step"]')
              .filter({ hasText: `${step}.` })
              .waitFor();
            await onboarding.getByRole("button", { name: /^(跳过|Skip)$/u }).click();
          }
          // 偏好保存后引导会自行关闭；仍可见时才点退出，与配对 helper 的判定一致。
          await mobile.waitForFunction(() => {
            const page = document.querySelector('[data-testid="onboarding-page"]');
            return (
              !page ||
              Array.from(page.querySelectorAll("button")).some(
                (button) =>
                  /^(开始使用|Get started)$/u.test(button.textContent?.trim() ?? "") &&
                  !button.disabled,
              )
            );
          });
          if (await onboarding.isVisible())
            await onboarding.getByRole("button", { name: /退出引导|Exit onboarding/u }).click();
          await onboarding.waitFor({ state: "hidden", timeout: 30_000 });
          facts.onboardingAfterSwitch = true;
        }
        await composer.or(projectCard).first().waitFor({ timeout: 60_000 });
        await dismissMigration();
        const landing = (await composer.isVisible()) ? "composer" : "project-list";
        if (landing === "project-list")
          await projectCard.getByTestId("virtual-project-create-task").click();
        await composer.waitFor({ timeout: 60_000 });
        expect(await pane.getAttribute("data-session-id")).toBe("draft");
        facts.mobileLanding = landing;
      } catch (error) {
        facts.mobileFailure = {
          url: new URL(mobile.url()).pathname,
          testIds: await mobile.evaluate(() =>
            [
              ...new Set(
                [...document.querySelectorAll("[data-testid]")].map((e) =>
                  e.getAttribute("data-testid"),
                ),
              ),
            ].slice(0, 80),
          ),
          mobilePage: await mobile.evaluate(
            () =>
              document.querySelector("[data-mobile-page]")?.getAttribute("data-mobile-page") ??
              null,
          ),
        };
        await mobile
          .screenshot({
            path: resolve(artifactDir, "mobile-enter-remote-failure.png"),
            fullPage: true,
          })
          .catch(() => undefined);
        throw error;
      }
      const afterReconnect = await remoteStatus();
      // 同一次设备连接：手机进入项目不能靠重启远控。
      expect(afterReconnect.sessionId).toBe(restored.sessionId);
      expect(afterReconnect.mobileConnected).toBe(true);
      await mobile.screenshot({
        path: resolve(artifactDir, "mobile-reconnected-remote-draft.png"),
        fullPage: true,
        animations: "disabled",
      });
      facts.afterReconnect = {
        sameDeviceSession: afterReconnect.sessionId === restored.sessionId,
        mobileConnected: afterReconnect.mobileConnected,
        mobilePane: "draft",
      };
      await context.close();

      // 6. 手机断开后在该 SSH 项目打开远控弹窗：远控以未连接目标启动、远端之后连上，
      // 弹窗也要判为同一会话，不能重启 device relay。重启会换新 runtime，丢掉手机上报的位置。
      await browser.waitUntil(async () => (await remoteStatus()).mobileConnected === false, {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 关闭手机后桌面仍显示手机已连接`,
      });
      const tab = await readRemoteTabSnapshot(identity);
      expect(tab.activeWorkspaceIdentity).toBe(identity);
      if (!tab.remoteSessionId) throw new Error(`${CASE_MARKER}: SSH tab 缺少 remoteSessionId`);
      // 冷重启后旧元素引用失效，重新查询入口。
      const reopenTrigger = $('button[aria-label="移动端远程控制"]');
      await reopenTrigger.waitForClickable({ timeout: 30_000 });
      await reopenTrigger.click();
      const stop = $('[data-testid="web-remote-control-connection-card"] button');
      // 停止按钮在弹窗完成状态同步（复用或重启都会等到结果）后才可用。
      await stop.waitForEnabled({ timeout: 60_000 });
      const afterDialog = await remoteStatus();
      await browser.keys("Escape");
      facts.dialogAfterReconnect = {
        sameDeviceSession: afterDialog.sessionId === restored.sessionId,
        keptMobileViewState: afterDialog.mobileViewState?.activeWorkspaceKey === identity,
        remoteSessionIdMatchesTab: afterDialog.remoteSessionId === tab.remoteSessionId,
      };
      expect(afterDialog.sessionId).toBe(restored.sessionId);
      expect(afterDialog.mobileViewState?.activeWorkspaceKey).toBe(identity);
      expect(afterDialog.remoteSessionId).toBe(tab.remoteSessionId);
    } finally {
      await mobileBrowser?.close().catch(() => undefined);
      await bringRemoteDeviceOnline(container, { host: config.host, port: config.port }).catch(
        () => undefined,
      );
      await writeFile(
        resolve(artifactDir, "remote-startup-restore-ssh.json"),
        JSON.stringify(facts, null, 2),
      );
    }
  });
});
