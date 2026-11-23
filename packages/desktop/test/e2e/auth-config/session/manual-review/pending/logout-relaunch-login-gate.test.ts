import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_REGION_SWITCH,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_LOGOUT_BUTTON,
  TID_OAUTH_LOGIN_BUTTON,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";
import { startElectronWindowRecording } from "#e2e/helpers/electron-window-recorder";

// 退出后到重启前出现的登录入口；与启动画面互斥。
const LOGIN_ENTRY_TEST_IDS = [
  TID_OAUTH_LOGIN_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_LOGIN_TRIGGER,
];
const STARTUP_LOADING_TEST_ID = "root-startup-loading";

type LogoutGateState = {
  commands: string[];
  rejectRelaunch?: (error: Error) => void;
  original?: (...args: unknown[]) => unknown;
};

describe("AUTH-LOGOUT-GATE 退出登录到重启前的登录门禁", () => {
  after(async () => {
    await restoreDesktopCommandHandler();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("确认退出后到重启前不暴露登录入口，重启失败才恢复", async function () {
    this.timeout(180_000);
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL;
    if (!baseUrl) throw new Error("缺少合成 OAuth 控制面 fixture");
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockResolvedValue(undefined);

    // 人工复核用录屏：仅 ZCODE_E2E_RECORD_LOGOUT_GATE=1 时开启，并在关键画面停留，不影响常规运行。
    const recording =
      process.env.ZCODE_E2E_RECORD_LOGOUT_GATE === "1"
        ? await startElectronWindowRecording({
            browser,
            outputPath: join(
              process.env.ZCODE_E2E_ARTIFACT_DIR!,
              "logout-relaunch-login-gate.webm",
            ),
            frameIntervalMs: 100,
          })
        : undefined;
    const holdForRecording = () => (recording ? browser.pause(2_000) : Promise.resolve());
    try {
      // 1. 真实 UI 走中国区登录，由真实 Host polling 完成。
      await fetch(`${baseUrl}/__e2e/cn-ready`, { method: "POST" });
      await openLoginEntry();
      const region = await browser.$(`[data-testid="${TID_LOGIN_REGION_SWITCH}"]`);
      if ((await region.getText()).includes("中国")) await region.click();
      await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
      await browser.waitUntil(
        async () =>
          (await (await fetch(`${baseUrl}/__e2e/status`)).json()).activeProvider === "zai_cn",
        { timeout: 10_000, timeoutMsg: "登录没有发起中国区 init" },
      );
      await browser.waitUntil(
        async () => {
          await dismissOccupationOnboarding().catch(() => undefined);
          return (
            !(await isAnyVisible([TID_OAUTH_LOGIN_BUTTON, TID_LOGIN_USE_API_KEY_BUTTON])) &&
            (await isAnyVisible([TID_LOGIN_TRIGGER]))
          );
        },
        { timeout: 30_000, timeoutMsg: "登录完成后没有回到工作区" },
      );
      // 夹具接口返回结构错误会让工作区局部崩溃（曾因 client/scenes 兜底返回对象而报 e.find）；
      // 录屏与断言都应基于正常工作区。等推荐区的 scenes 请求返回并渲染两帧后再检查。
      await browser.waitUntil(
        async () =>
          (await (await fetch(`${baseUrl}/__e2e/status`)).json()).clientScenesRequests > 0,
        { timeout: 10_000, timeoutMsg: "工作区没有请求 client/scenes" },
      );
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      expect(await hasSectionErrorBoundary()).toBe(false);
      await holdForRecording();

      // 2. 截断真实重启：RelaunchApp 挂起，直到测试主动让它失败；其他命令照常执行。
      await browser.electron.execute((electron, channel) => {
        const handlers = (
          electron.ipcMain as unknown as {
            _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
          }
        )._invokeHandlers;
        const state: LogoutGateState = { commands: [], original: handlers.get(channel) };
        (globalThis as typeof globalThis & { __logoutGate?: LogoutGateState }).__logoutGate = state;
        electron.ipcMain.removeHandler(channel);
        electron.ipcMain.handle(channel, (event, command: string, ...rest: unknown[]) => {
          state.commands.push(command);
          if (command === "relaunchApp") {
            return new Promise((_resolve, reject) => {
              state.rejectRelaunch = reject;
            });
          }
          return state.original?.(event, command, ...rest);
        });
      }, PlatformChannels.ExecuteDesktopCommand);

      // 3. 逐帧采样：确认退出后任何一帧出现登录入口都记为失败。
      await browser.execute(
        (ids, loadingId) => {
          const sampler = { sawLoginEntry: false, sawLoading: false, running: true };
          (window as unknown as { __logoutGateSampler: typeof sampler }).__logoutGateSampler =
            sampler;
          const visible = (id: string) =>
            Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)).some(
              (element) => element.getBoundingClientRect().height > 0,
            );
          const tick = () => {
            if (!sampler.running) return;
            if (ids.some(visible)) sampler.sawLoginEntry = true;
            if (visible(loadingId)) sampler.sawLoading = true;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        [TID_OAUTH_LOGIN_BUTTON, TID_LOGIN_USE_API_KEY_BUTTON],
        STARTUP_LOADING_TEST_ID,
      );

      for (const trigger of await browser.$$(`[data-testid="${TID_LOGIN_TRIGGER}"]`)) {
        if (await trigger.isDisplayed()) {
          await trigger.click();
          break;
        }
      }
      await browser.$(`[data-testid="${TID_LOGOUT_BUTTON}"]`).click();
      await browser.$(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).waitForDisplayed();
      await browser.$(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).click();

      await browser.waitUntil(async () => (await readGateCommands()).includes("relaunchApp"), {
        timeout: 30_000,
        timeoutMsg: "确认退出后没有发出 RelaunchApp",
      });
      await holdForRecording();
      // 再等两帧，覆盖重启命令发出后的渲染。
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      const sampled = await browser.execute(() => {
        const sampler = (
          window as unknown as {
            __logoutGateSampler: { sawLoginEntry: boolean; sawLoading: boolean; running: boolean };
          }
        ).__logoutGateSampler;
        sampler.running = false;
        return { sawLoginEntry: sampler.sawLoginEntry, sawLoading: sampler.sawLoading };
      });
      expect(sampled).toEqual({ sawLoginEntry: false, sawLoading: true });
      expect(await isAnyVisible(LOGIN_ENTRY_TEST_IDS)).toBe(false);
      expect(await isAnyVisible([STARTUP_LOADING_TEST_ID])).toBe(true);
      const commands = await readGateCommands();
      expect(commands.slice(commands.indexOf("clearCodingPlanWebviewStorage"))).toEqual([
        "clearCodingPlanWebviewStorage",
        "relaunchApp",
      ]);

      // 4. 重启命令失败：阻断态解除，登录入口重新可用。
      await browser.electron.execute(() => {
        (
          globalThis as typeof globalThis & { __logoutGate?: LogoutGateState }
        ).__logoutGate?.rejectRelaunch?.(new Error("e2e relaunch failure"));
      });
      await browser.waitUntil(
        async () =>
          !(await isAnyVisible([STARTUP_LOADING_TEST_ID])) &&
          (await isAnyVisible(LOGIN_ENTRY_TEST_IDS)),
        { timeout: 10_000, timeoutMsg: "重启失败后仍停在启动画面或没有登录入口" },
      );
      await holdForRecording();
    } finally {
      await recording?.stop({ tailDurationMs: 1_000 });
    }
  });
});

async function openLoginEntry() {
  await browser.waitUntil(
    async () => {
      await dismissOccupationOnboarding().catch(() => undefined);
      return isAnyVisible([TID_OAUTH_LOGIN_BUTTON, TID_LOGIN_TRIGGER]);
    },
    { timeout: 60_000, timeoutMsg: "启动后没有登录入口" },
  );
  if (!(await isAnyVisible([TID_OAUTH_LOGIN_BUTTON]))) {
    for (const trigger of await browser.$$(`[data-testid="${TID_LOGIN_TRIGGER}"]`)) {
      if (await trigger.isDisplayed()) {
        await trigger.click();
        break;
      }
    }
    await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
  }
  await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
}

async function hasSectionErrorBoundary(): Promise<boolean> {
  return browser.execute(() =>
    /这块界面出了点问题|This section ran into a problem/u.test(document.body.innerText),
  );
}

async function isAnyVisible(ids: string[]): Promise<boolean> {
  return browser.execute(
    (testIds) =>
      testIds.some((id) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)).some(
          (element) => element.getBoundingClientRect().height > 0,
        ),
      ),
    ids,
  );
}

async function readGateCommands(): Promise<string[]> {
  return browser.electron.execute(
    () =>
      (globalThis as typeof globalThis & { __logoutGate?: LogoutGateState }).__logoutGate
        ?.commands ?? [],
  );
}

async function restoreDesktopCommandHandler() {
  await browser.electron.execute((electron, channel) => {
    const state = (globalThis as typeof globalThis & { __logoutGate?: LogoutGateState })
      .__logoutGate;
    if (!state?.original) return;
    electron.ipcMain.removeHandler(channel);
    electron.ipcMain.handle(
      channel,
      state.original as Parameters<typeof electron.ipcMain.handle>[1],
    );
    delete (globalThis as typeof globalThis & { __logoutGate?: LogoutGateState }).__logoutGate;
  }, PlatformChannels.ExecuteDesktopCommand);
}
