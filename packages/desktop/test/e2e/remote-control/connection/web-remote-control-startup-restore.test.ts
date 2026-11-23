import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type WebRemoteControlStatus } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";

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

async function lastEnabledContext() {
  const { appDataDir } = getE2EAppDataPaths();
  const settings = JSON.parse(await readFile(join(appDataDir, "setting.json"), "utf8"));
  return settings.webRemoteControlLastEnabledContext as { workspacePath: string } | undefined;
}

async function waitForRemoteTrigger() {
  let trigger: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
      for (const candidate of await $$(
        'button[aria-label="Mobile remote control"], button[aria-label="移动端远程控制"]',
      )) {
        if (await candidate.isDisplayed()) {
          trigger = candidate;
          return true;
        }
      }
      return false;
    },
    { timeout: 60_000, timeoutMsg: "未出现远控入口" },
  );
  return trigger!;
}

describe("桌面重启后自动恢复远控", () => {
  it("AUTH-09: 上次启用目标不在窗口时仍恢复设备连接，用户停止后重启保持关闭", async function () {
    this.timeout(180_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!origin || !artifacts) throw new Error("缺少远控启动恢复 fixture");

    // fixture 把上次启用目标写成未打开的 ZCodeProject-previous；窗口只恢复 ZCodeProject。
    await waitForRemoteTrigger();
    await browser.waitUntil(async () => (await remoteStatus()).status === "running", {
      timeout: 40_000,
      timeoutMsg: "上次启用目标不在窗口时未自动恢复远控",
    });
    const restored = await remoteStatus();
    expect(restored.workspacePath).toBe(DEFAULT_WORKSPACE);
    expect(restored.initialTaskId).toBeUndefined();
    await browser.waitUntil(async () => (await onlineDevices(origin)).length === 1, {
      timeout: 10_000,
      timeoutMsg: "自动恢复后 relay 上没有在线设备",
    });
    await browser.waitUntil(
      async () => (await lastEnabledContext())?.workspacePath === DEFAULT_WORKSPACE,
      { timeout: 10_000, timeoutMsg: "自动恢复成功后未更新上次启用目标" },
    );

    await (await waitForRemoteTrigger()).click();
    const stop = $('[data-testid="web-remote-control-connection-card"] button');
    await stop.waitForEnabled({ timeout: 10_000 });
    await stop.click();
    await browser.waitUntil(async () => (await remoteStatus()).status === "idle", {
      timeout: 10_000,
    });
    await browser.waitUntil(async () => (await onlineDevices(origin)).length === 0, {
      timeout: 10_000,
    });
    expect(await lastEnabledContext()).toBeUndefined();
    await browser.keys("Escape");

    await reloadElectronSessionSafely(browser);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await waitForRemoteTrigger();
    // 恢复判定在窗口同步时完成；再观察一段时间，确认没有迟到的自动启动。
    await browser.pause(3000);
    const afterRestart = await remoteStatus();
    expect(afterRestart.status).toBe("idle");
    expect(await onlineDevices(origin)).toEqual([]);

    await writeFile(
      join(artifacts, "remote-startup-restore.json"),
      JSON.stringify(
        {
          restored: {
            status: restored.status,
            workspacePath: restored.workspacePath,
            initialTaskId: restored.initialTaskId ?? null,
          },
          afterRestart: { status: afterRestart.status },
        },
        null,
        2,
      ),
    );
  });
});
