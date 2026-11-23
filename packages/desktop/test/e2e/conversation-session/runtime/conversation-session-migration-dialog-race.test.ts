import { join } from "node:path";
import type { IServiceAccessor, ISettingsSyncService } from "@zcode/services";
import { TID_TASK_SETTINGS_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import { clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { startElectronWindowRecording } from "#e2e/helpers/electron-window-recorder";

type GateMethod = "getFirstRunPromptState" | "detect";
type TrackedMethod = GateMethod | "markFirstRunPromptHandled";
type MigrationTestServices = Omit<IServiceAccessor, "settingsSyncService"> & {
  settingsSyncService: ISettingsSyncService;
};
interface MigrationRaceGate {
  services: MigrationTestServices;
  original: ISettingsSyncService;
  releases: Array<() => void>;
  calls: TrackedMethod[];
  completed: number;
}
interface ServiceFiber {
  return: ServiceFiber | null;
  memoizedProps?: { value?: Partial<IServiceAccessor>; services?: Partial<IServiceAccessor> };
}
declare global {
  interface Window {
    __migrationRaceGate?: MigrationRaceGate;
  }
}

const dialogSelector = '[data-testid="onboarding-migration-dialog"]';

async function openEntryWithGate(method: GateMethod, reject: boolean, handled = true) {
  await prepareV4ConversationE2E({ skipProvider: true });
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
  await $(
    '//button[normalize-space(.)="打开引导" or normalize-space(.)="Open onboarding"]',
  ).click();
  await waitForTestIdByDom("onboarding-page");
  for (let step = 0; step < 2; step += 1) {
    await $('//button[normalize-space(.)="下一步" or normalize-space(.)="Next"]').click();
  }
  await browser.execute(
    async (gateMethod, fail, promptHandled) => {
      const element = document.querySelector("button");
      if (!element) throw new Error("Migration entry is not mounted");
      const node = element as unknown as Record<string, unknown>;
      let fiber = node[
        Object.keys(node).find((key) => key.startsWith("__reactFiber"))!
      ] as ServiceFiber | null;
      let services: MigrationTestServices | undefined;
      while (fiber) {
        const candidate = fiber.memoizedProps?.value ?? fiber.memoizedProps?.services;
        if (candidate?.settingsSyncService) {
          services = candidate as MigrationTestServices;
          break;
        }
        fiber = fiber.return;
      }
      if (!services) throw new Error("Migration service context missing");
      await services.settingService.update({ settingsSyncFirstRunPromptHandled: promptHandled });
      const original = services.settingsSyncService;
      const gate: MigrationRaceGate = {
        services,
        original,
        releases: [],
        calls: [],
        completed: 0,
      };
      window.__migrationRaceGate = gate;
      // 仅截留真实 RPC 的返回时机；UI 操作与首启查询仍经过产品链路。
      services.settingsSyncService = new Proxy(original, {
        get(target, key) {
          if (
            key !== "getFirstRunPromptState" &&
            key !== "detect" &&
            key !== "markFirstRunPromptHandled"
          ) {
            return Reflect.get(target, key);
          }
          return async (...args: unknown[]) => {
            gate.calls.push(key);
            try {
              const result = await Reflect.apply(Reflect.get(target, key), target, args);
              if (key !== gateMethod) return result;
              return await new Promise((resolve, rejectResult) => {
                gate.releases.push(() => {
                  if (fail) rejectResult(new Error("E2E stale discovery failure"));
                  else resolve(result);
                });
              });
            } finally {
              gate.completed += 1;
            }
          };
        },
      });
    },
    method,
    reject,
    handled,
  );
  await $(
    '//label[.//span[normalize-space(.)="迁移会话数据" or normalize-space(.)="Migrate conversations"]]//button[@role="checkbox"]',
  ).click();
  await $('//button[normalize-space(.)="开始使用" or normalize-space(.)="Get started"]').click();
  await waitForTestIdByDom("onboarding-migration-dialog");
  await browser.waitUntil(
    async () => await browser.execute(() => (window.__migrationRaceGate?.releases.length ?? 0) > 0),
    { timeout: 15_000, timeoutMsg: "Migration RPC did not reach the response gate" },
  );
}

async function releaseGate() {
  const callsBeforeRelease = await browser.execute(() => {
    const gate = window.__migrationRaceGate;
    if (!gate?.releases.length) throw new Error("No migration response is pending");
    const calls = [...gate.calls];
    for (const release of gate.releases.splice(0)) release();
    return calls;
  });
  await browser.waitUntil(
    async () =>
      await browser.execute(async () => {
        const gate = window.__migrationRaceGate;
        if (!gate) throw new Error("Migration response gate missing");
        const started = gate.calls.length;
        // 原断言只等两帧，可能早于后续 detect / 标记 RPC。先跨过一个事件循环任务，
        // 让已释放 Promise 的调用方继续执行，再核对所有真实请求均已结束。
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(null);
        });
        if (gate.releases.length || gate.completed !== started || gate.calls.length !== started) {
          return false;
        }
        // 帧屏障只等 React 提交界面；业务收敛由上面的请求计数保证。
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return gate.completed === gate.calls.length && gate.calls.length === started;
      }),
    { timeout: 15_000, timeoutMsg: "Migration request chain did not settle after gate release" },
  );
  return await browser.execute((expectedCalls) => {
    const gate = window.__migrationRaceGate;
    if (!gate) throw new Error("Migration response gate missing");
    return { expectedCalls, actualCalls: [...gate.calls] };
  }, callsBeforeRelease);
}

describe("E2E_DSYNC_16_MIGRATION_RACE", () => {
  afterEach(async () => {
    await browser.execute(() => {
      const gate = window.__migrationRaceGate;
      if (!gate) return;
      gate.services.settingsSyncService = gate.original;
      for (const release of gate.releases.splice(0)) release();
      delete window.__migrationRaceGate;
    });
    if (await $(dialogSelector).isExisting()) {
      await browser.keys("Escape");
      await $(dialogSelector).waitForExist({ reverse: true });
    }
  });

  for (const handled of [true, false]) {
    it(`DSYNC-16-03 手动打开后迟到的首启回包不能关闭向导（handled=${handled}）`, async function () {
      this.timeout(180_000);
      const recording = await startElectronWindowRecording({
        captureFrame: async () => {
          // 职业引导会保留独立窗口；录制当前 WebDriver 页面，避免采到旧引导窗口。
          const url = await browser.getUrl();
          const png = await browser.electron.execute(async (electron, targetUrl) => {
            const target = electron.BrowserWindow.getAllWindows().find(
              (window) => !window.isDestroyed() && window.webContents.getURL() === targetUrl,
            );
            if (!target) throw new Error("Migration recording window missing");
            return (await target.webContents.capturePage()).toPNG().toString("base64");
          }, url);
          return Buffer.from(png, "base64");
        },
        outputPath: join(
          process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts",
          `migration-race-${handled}.webm`,
        ),
      });
      try {
        await openEntryWithGate("getFirstRunPromptState", false, handled);
        const calls = await releaseGate();
        expect(calls.actualCalls).toEqual(calls.expectedCalls);
        expect(await $(dialogSelector).isDisplayed()).toBe(true);
        await $('//button[normalize-space(.)="继续" or normalize-space(.)="Continue"]').click();
        await browser.waitUntil(
          async () =>
            (await $(dialogSelector).getAttribute("data-wizard-step")) === "skills-import",
          { timeout: 15_000 },
        );
      } finally {
        // 尾录仅用于保留最后一步的画面，断言不依赖这段等待。
        await recording.stop({ tailDurationMs: 1_000 });
      }
    });
  }

  for (const fail of [false, true]) {
    it(`DSYNC-16-${fail ? "05" : "04"} 关闭后迟到的检测${fail ? "失败" : "成功"}不能重开向导`, async function () {
      this.timeout(180_000);
      await openEntryWithGate("detect", fail);
      await clickTestIdByDom("onboarding-wizard-cancel");
      await $(dialogSelector).waitForExist({ reverse: true });
      await releaseGate();
      expect(await $(dialogSelector).isExisting()).toBe(false);
    });
  }
});
