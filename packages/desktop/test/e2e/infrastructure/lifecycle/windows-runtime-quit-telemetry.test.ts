type FinalArmsEntry = {
  payload: {
    name: string;
    properties: Record<string, string>;
  };
};

type ArmsBridgeWindow = Window & {
  __zcodeFinalArmsCustomEventsE2E?: {
    clear(): Promise<void>;
    configure(request: { suppressedEventNames: string[] }): Promise<void>;
    read(): Promise<FinalArmsEntry[]>;
  };
  zcode?: {
    reportArmsCustomEvent(payload: {
      name: string;
      group: string;
      properties: Record<string, string>;
    }): Promise<void>;
  };
};

const TARGET_MESSAGE = "Windows runtime start was cancelled";
const OTHER_MESSAGE = "Windows runtime control closed before Job was confirmed empty";

async function reportSubscriptionError(errorKey: string, message: string) {
  await browser.execute(
    async (key, errorMessage) => {
      const reporter = (window as ArmsBridgeWindow).zcode?.reportArmsCustomEvent;
      if (!reporter) throw new Error("ARMS event reporter is unavailable");
      await reporter({
        name: "chat_error_banner",
        group: "ui_error",
        properties: {
          surface: "session_subscription_error",
          error_code: "fault.subscribe.unknown",
          error_key: key,
          error_message: errorMessage,
        },
      });
    },
    errorKey,
    message,
  );
}

async function readCapturedErrors(): Promise<FinalArmsEntry[]> {
  return browser.execute(async () => {
    const bridge = (window as ArmsBridgeWindow).__zcodeFinalArmsCustomEventsE2E;
    if (!bridge) throw new Error("Final ARMS event capture is unavailable");
    return bridge.read();
  });
}

describe("正常退出时的 Windows Session 订阅错误上报", () => {
  it("退出前保留错误，确认退出后仅抑制 runtime 启动取消", async function () {
    if (process.platform !== "win32") this.skip();
    this.timeout(90_000);

    await browser.execute(async () => {
      const bridge = (window as ArmsBridgeWindow).__zcodeFinalArmsCustomEventsE2E;
      if (!bridge) throw new Error("Final ARMS event capture is unavailable");
      await bridge.clear();
      // 捕获最终 payload，但不把测试错误发送到 ARMS。
      await bridge.configure({ suppressedEventNames: ["chat_error_banner"] });
    });

    await reportSubscriptionError("before-quit", TARGET_MESSAGE);
    expect(
      (await readCapturedErrors()).some(
        (entry) => entry.payload.properties.error_key === "before-quit",
      ),
    ).toBe(true);

    await browser.electron.execute((electron) => {
      const state = globalThis as typeof globalThis & {
        __quitTelemetryE2E?: { attempts: number; listener: (event: Electron.Event) => void };
      };
      const listener = (event: Electron.Event) => {
        const current = state.__quitTelemetryE2E;
        if (!current) return;
        current.attempts += 1;
        // 首次 before-quit 由产品拦截并完成 Host 清理；第二次在 app_quit 已确立后保留 Renderer。
        if (current.attempts === 2) event.preventDefault();
      };
      state.__quitTelemetryE2E = { attempts: 0, listener };
      electron.app.on("before-quit", listener);
      electron.app.quit();
    });

    try {
      await browser.waitUntil(
        async () =>
          (await browser.electron.execute(() => {
            const state = globalThis as typeof globalThis & {
              __quitTelemetryE2E?: { attempts: number };
            };
            return state.__quitTelemetryE2E?.attempts ?? 0;
          })) >= 2,
        { timeout: 30_000, timeoutMsg: "正常退出未完成 prepareAppQuit 后的第二次 before-quit" },
      );

      await reportSubscriptionError("after-quit-cancelled", TARGET_MESSAGE);
      await reportSubscriptionError("after-quit-job-error", OTHER_MESSAGE);
      const captured = await readCapturedErrors();
      expect(
        captured.some((entry) => entry.payload.properties.error_key === "after-quit-cancelled"),
      ).toBe(false);
      expect(
        captured.some((entry) => entry.payload.properties.error_key === "after-quit-job-error"),
      ).toBe(true);
    } finally {
      await browser.electron.execute((electron) => {
        const state = globalThis as typeof globalThis & {
          __quitTelemetryE2E?: { listener: (event: Electron.Event) => void };
        };
        if (!state.__quitTelemetryE2E) return;
        electron.app.removeListener("before-quit", state.__quitTelemetryE2E.listener);
        delete state.__quitTelemetryE2E;
      });
    }
  });
});
