import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { WebSocket } from "ws";
import { acquireFileLock } from "@zcode/shared/node";
import { type WebRemoteControlStatus } from "@zcode/shared";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  seedSettings,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";

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

describe("桌面 OAuth 凭据完成事件", () => {
  it("AUTH-08: 新设备身份保存失败终止启动并清理设备，恢复设置后可手动重启", async function () {
    this.timeout(120_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!origin || !artifacts) throw new Error("缺少会话事件 fixture");
    const openDialog = async () => {
      await browser.waitUntil(
        async () => {
          if (await $('[data-testid="onboarding-page"]').isDisplayed())
            await browser.keys("Escape");
          for (const trigger of await $$(
            'button[aria-label="Mobile remote control"], button[aria-label="移动端远程控制"]',
          )) {
            if (await trigger.isDisplayed()) {
              await trigger.click();
              return true;
            }
          }
          return false;
        },
        { timeout: 60_000, timeoutMsg: "未出现远控入口" },
      );
    };
    const devices = async () => {
      const response = await fetch(`${origin}/api/v1/remote/device`, {
        headers: { Authorization: "Bearer mock-token" },
      });
      return (await response.json()).data as Array<{ device_sid: string; online: boolean }>;
    };
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
        return $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).isExisting();
      },
      { timeout: 60_000 },
    );
    await browser.waitUntil(async () => (await remoteStatus()).status === "running", {
      timeout: 40_000,
    });
    await openDialog();
    const stop = $('[data-testid="web-remote-control-connection-card"] button');
    await stop.waitForEnabled({ timeout: 10_000 });
    await stop.click();
    await browser.waitUntil(async () => (await remoteStatus()).status === "idle");
    await browser.waitUntil(async () => (await devices()).every((device) => !device.online));
    for (const device of await devices()) {
      const deleted = await fetch(`${origin}/api/v1/remote/device/delete`, {
        method: "POST",
        headers: { Authorization: "Bearer mock-token", "Content-Type": "application/json" },
        body: JSON.stringify({ device_sid: device.device_sid }),
      });
      expect((await deleted.json()).code).toBe(0);
    }
    const before = await devices();
    const { appDataDir } = getE2EAppDataPaths();
    if (!appDataDir.includes(".e2e-home-")) throw new Error("设置写入故障必须限制在隔离 HOME");
    const settingsFile = join(appDataDir, "setting.json");
    const settingsMode = (await stat(settingsFile)).mode & 0o777;
    const directoryMode = (await stat(appDataDir)).mode & 0o777;
    try {
      // 保留 endpoint/旧 SID 的真实读取，只禁止设置原子写入，确保新身份保存确实失败。
      await chmod(settingsFile, 0o444);
      await chmod(appDataDir, 0o555);
      await openDialog();
      await browser.waitUntil(async () => (await remoteStatus()).status === "error", {
        timeout: 5000,
        timeoutMsg: "身份保存失败未及时终止远控启动",
      });
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="web-remote-control-connection-card"]').getText()).includes(
            "relay-unavailable",
          ),
        { timeout: 5000 },
      );
      expect(await $('[data-testid="web-remote-control-scan-card"] img').isExisting()).toBe(false);
      expect(await devices()).toEqual(before);
      await browser.pause(2500);
      expect(await devices()).toEqual(before);
      await browser.saveScreenshot(join(artifacts, "remote-device-save-failure.png"));
      await writeFile(
        join(artifacts, "remote-device-save-failure.json"),
        JSON.stringify({ status: await remoteStatus(), before, after: await devices() }, null, 2),
      );
    } finally {
      await chmod(appDataDir, directoryMode);
      await chmod(settingsFile, settingsMode);
      await browser.keys("Escape");
    }
    await openDialog();
    await browser.waitUntil(async () => (await remoteStatus()).status === "running", {
      timeout: 10_000,
      timeoutMsg: "恢复设置后手动开启远控未成功",
    });
    await browser.keys("Escape");
  });

  it("AUTH-08: 登出后设置失败仍关闭已配对远控，且不依赖 UI 用户清空或重启", async function () {
    this.timeout(120_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!origin || !artifacts) throw new Error("缺少会话事件 fixture");
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
        return $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).isExisting();
      },
      { timeout: 60_000, timeoutMsg: "启动后未进入已登录工作区" },
    );
    await browser.waitUntil(async () => (await remoteStatus()).status === "running", {
      timeout: 40_000,
    });
    const headers = { Authorization: "Bearer mock-token", "Content-Type": "application/json" };
    const devices = await (await fetch(`${origin}/api/v1/remote/device`, { headers })).json();
    const sid = devices.data.find((device: { online: boolean }) => device.online)?.device_sid;
    expect(typeof sid).toBe("string");
    const token = await (
      await fetch(`${origin}/api/v1/remote/token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "terminal" }),
      })
    ).json();
    const terminal = new WebSocket(
      `${origin.replace("http:", "ws:")}/api/v1/remote/ws2?token=${token.data.token}`,
    );
    const opened = once(terminal, "open");
    const messages: Array<{ type: string; pair_status?: string }> = [];
    terminal.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    const { appDataDir, credentialsFile } = getE2EAppDataPaths();
    const settingsFile = join(appDataDir, "setting.json");
    let releaseSettingsLock: (() => Promise<void>) | undefined;
    // E2E 日志按 worker 隔离；从 Main 获取实际目录，不能读取普通用户配置目录。
    const logs = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logs) throw new Error("缺少 worker 运行时日志目录");
    const readRuntimeLog = async () => {
      const names = (await readdir(logs)).filter((name) => name.endsWith(".log")).sort();
      return (await Promise.all(names.map((name) => readFile(join(logs, name), "utf8")))).join(
        "\n",
      );
    };
    const relaunch = await browser.electron.mock("app", "relaunch");
    await relaunch.mockResolvedValue(undefined);
    const quit = await browser.electron.mock("app", "quit");
    await quit.mockResolvedValue(undefined);
    try {
      await opened;
      terminal.send(JSON.stringify({ type: "auth_init", device_sid: sid }));
      await browser.waitUntil(
        async () =>
          messages.some(
            (message) => message.type === "auth_ack" && message.pair_status === "matched",
          ),
        { timeout: 10_000 },
      );
      await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
      await $(`[data-testid="${TID_LOGOUT_BUTTON}"]`).click();
      const confirm = $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
      await confirm.waitForDisplayed();
      // 登出前会先读设置；把文件改成目录会在 oauth.logout 前失败，未覆盖凭据事件。
      // 只占用设置写锁，保留有效正文与独立凭据锁，让故障发生在凭据清理后的设置写入。
      const logBeforeFailure = await readRuntimeLog();
      releaseSettingsLock = await acquireFileLock(settingsFile, [25, 50, 100], 100, 8_000);
      await confirm.click();
      await browser.waitUntil(
        async () => {
          const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
          return !("zcodejwttoken" in credentials);
        },
        { timeout: 15_000 },
      );
      await browser.waitUntil(async () => (await remoteStatus()).status === "auth-required", {
        timeout: 10_000,
      });
      await browser.waitUntil(async () => terminal.readyState === WebSocket.CLOSED, {
        timeout: 10_000,
      });
      // 等待真实写入拒绝的日志，不能把“仍在等待写锁”当作失败证据就提前放锁。
      await browser.waitUntil(
        async () =>
          (await readRuntimeLog()).slice(logBeforeFailure.length).includes("setting.update FAIL"),
        { timeout: 15_000, timeoutMsg: "凭据清理后未观察到设置写锁失败" },
      );
      await relaunch.update();
      await quit.update();
      expect(relaunch.mock.calls.length).toBe(0);
      expect(quit.mock.calls.length).toBe(0);
      expect(await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).getText()).toContain("ZCode E2E");
      await writeFile(
        join(artifacts, "remote-logout-settings-failure.json"),
        JSON.stringify(
          {
            credentialCleared: true,
            settingsWriteRejected: true,
            status: await remoteStatus(),
            terminalClosed: true,
            relaunchCalls: relaunch.mock.calls.length,
          },
          null,
          2,
        ),
      );
    } finally {
      terminal.terminate();
      await releaseSettingsLock?.();
      await browser.electron.restoreAllMocks();
    }
  });
  it("AUTH-CN-REMOTE: 中国区主身份可配对，补关联不断开，退出关闭连接", async function () {
    this.timeout(90_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    if (!origin) throw new Error("缺少会话事件 fixture");
    const { credentialsFile } = getE2EAppDataPaths();
    await writeFile(
      credentialsFile,
      JSON.stringify({
        "oauth:active_provider": "zai_cn",
        "oauth:session_revision": "cn-remote-before-profile",
        "oauth:zai_cn:access_token": "cn-upstream-not-relay",
        "oauth:zai_cn:user_info": JSON.stringify({
          user_id: "zcode-e2e-user",
          name: "ZCode E2E",
        }),
        "oauth:linked_bigmodel": JSON.stringify({
          userId: "zcode-e2e-user",
          customerId: "associated-customer",
          accessToken: "linked-before",
        }),
        zcodejwttoken: "mock-token",
      }),
      "utf8",
    );
    await seedSettings({
      webRemoteControlLastEnabledContext: { workspacePath: DEFAULT_WORKSPACE },
    });
    await browser.reloadSession();
    await browser.waitUntil(async () => (await remoteStatus()).status === "running", {
      timeout: 15_000,
      timeoutMsg: "中国区主身份没有启动远控",
    });
    const headers = { Authorization: "Bearer mock-token", "Content-Type": "application/json" };
    const devices = async () =>
      (await (await fetch(`${origin}/api/v1/remote/device`, { headers })).json()).data as Array<{
        device_sid: string;
        online: boolean;
      }>;
    const sid = (await devices()).find((device) => device.online)?.device_sid;
    expect(typeof sid).toBe("string");
    const issued = await (
      await fetch(`${origin}/api/v1/remote/token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ role: "terminal" }),
      })
    ).json();
    const terminal = new WebSocket(
      `${origin.replace("http:", "ws:")}/api/v1/remote/ws2?token=${issued.data.token}`,
    );
    const messages: Array<{ type: string; pair_status?: string }> = [];
    terminal.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    try {
      await once(terminal, "open");
      terminal.send(JSON.stringify({ type: "auth_init", device_sid: sid }));
      await browser.waitUntil(
        async () =>
          messages.some(
            (message) => message.type === "auth_ack" && message.pair_status === "matched",
          ),
        { timeout: 10_000 },
      );
      await browser.waitUntil(async () => (await remoteStatus()).status === "active", {
        timeout: 10_000,
      });
      await waitForTestIdByDom(TID_LOGIN_TRIGGER);
      await browser.execute((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.oauthService ? value : fiber.memoizedProps?.services;
          if (services?.oauthService) {
            (window as any).__cnRemoteServices = services;
            return;
          }
          fiber = fiber.return;
        }
        throw new Error("Missing OAuth accessor");
      }, TID_LOGIN_TRIGGER);
      await fetch(`${origin}/__e2e/linked-profile`, { method: "POST" });
      const availability = await browser.execute(async () =>
        (window as any).__cnRemoteServices.oauthService.refreshAccountProfile(),
      );
      expect(availability.loginProvider).toBe("zai_cn");
      expect(availability.sessionRevision).not.toBe("cn-remote-before-profile");
      expect((await remoteStatus()).status).toBe("active");
      expect(terminal.readyState).toBe(WebSocket.OPEN);
      expect((await devices()).find((device) => device.online)?.device_sid).toBe(sid);
      await browser.execute(async () =>
        (window as any).__cnRemoteServices.oauthService.logoutAll(),
      );
      await browser.waitUntil(async () => (await remoteStatus()).status === "auth-required", {
        timeout: 10_000,
      });
      await browser.waitUntil(async () => terminal.readyState === WebSocket.CLOSED, {
        timeout: 10_000,
      });
    } finally {
      terminal.terminate();
      await browser.execute(() => {
        delete (window as any).__cnRemoteServices;
      });
    }
  });
});
