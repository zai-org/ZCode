import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { TID_FEEDBACK_LOGS_OPT_IN } from "@zcode/shared/test-ids";
import {
  pinE2ELocale,
  readSettings,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { startHelpConfigFixture } from "#e2e/helpers/help-client-config-fixture";

async function dismissInitialOnboarding() {
  const onboarding = $('[data-testid="onboarding-page"]');
  await browser.waitUntil(
    async () =>
      (await onboarding.isExisting()) ||
      (await $('button[aria-label="Help"]').isExisting()) ||
      (await $('button[aria-label="帮助"]').isExisting()),
    { timeout: 15000 },
  );
  if (await onboarding.isDisplayed()) {
    // 当前 staging 的引导按本地完成记录触发；只关窗口后刷新会重开。
    // 通过现有跳过操作完成隔离测试账号的三步引导，不改变产品实现。
    for (let step = 0; step < 3; step += 1) {
      const before = await onboarding.getText();
      await onboarding.$("footer > button").click();
      await browser.waitUntil(
        async () => !(await onboarding.isDisplayed()) || (await onboarding.getText()) !== before,
        { timeout: 15000 },
      );
      if (!(await onboarding.isDisplayed())) break;
    }
    await onboarding.waitForDisplayed({ reverse: true, timeout: 15000 });
  }
}

describe("反馈上传授权（manual review）", () => {
  const screenshotDirectory = join(process.cwd(), ".e2e-artifacts", "feedback-upload-privacy");
  let settings: Awaited<ReturnType<typeof readSettings>>;
  let server: Awaited<ReturnType<typeof startHelpConfigFixture>>;
  let windowSize:
    | { width: number; height: number; minWidth: number; minHeight: number }
    | undefined;

  before(async () => {
    await mkdir(screenshotDirectory, { recursive: true });
    await dismissInitialOnboarding();
    await waitForDefaultWorkspaceReady(30000);
    settings = await readSettings();
    windowSize = await browser.electron.execute((electron) => {
      const window = electron.BrowserWindow.getAllWindows()[0]!;
      const bounds = window.getBounds();
      const [minWidth = 0, minHeight = 0] = window.getMinimumSize();
      window.setMinimumSize(360, 400);
      return { width: bounds.width, height: bounds.height, minWidth, minHeight };
    });
    server = await startHelpConfigFixture({ feedback_use_external_form: false });
  });
  after(async () => {
    await browser.keys("Escape");
    if (settings) await seedSettings(settings);
    if (windowSize)
      await browser.electron.execute((electron, size) => {
        const window = electron.BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(size.minWidth, size.minHeight);
        window.setSize(size.width, size.height);
      }, windowSize);
    await server?.close();
  });

  for (const [locale, width, height, helpLabel, reportLabel, hint] of [
    ["en-US", 1280, 900, "Help", "Report", "On by default"],
    ["zh-CN", 430, 900, "帮助", "问题上报", "默认开启"],
  ] as const) {
    it(`FB-PRIV-01/08 / FB-DESC-01 / FB-REQ-A11Y-01: ${locale} ${width}px 反馈必填标识与日志选择`, async () => {
      await seedSettings({ locale, localePreference: locale, zcodeEndpointOrigin: server.origin });
      await browser.electron.execute(
        (electron, size) => {
          electron.BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height);
        },
        { width, height },
      );
      await browser.refresh();
      await dismissInitialOnboarding();
      await waitForDefaultWorkspaceReady(30000);
      // 帮助按钮的 aria-label 跟随 renderer 语言；settings 写入不会改已加载的 renderer。
      await pinE2ELocale(locale);
      const help = $(`button[aria-label="${helpLabel}"]`);
      await help.waitForDisplayed({ timeout: 10000 });
      await help.click();
      await $(`//*[@role="menuitem" and contains(.,"${reportLabel}")]`).click();
      const dialog = $('[role="dialog"]');
      await dialog.waitForDisplayed({ timeout: 10000 });
      const description = dialog.$("textarea");
      const submitButton = dialog.$(
        `button=${locale === "zh-CN" ? "提交反馈" : "Submit feedback"}`,
      );
      await expect(description).toHaveAttribute("required");
      await expect(description).toHaveAttribute("aria-required", "true");
      await expect(description).toHaveAttribute(
        "aria-label",
        locale === "zh-CN" ? "问题描述" : "Issue description",
      );
      const bugMarker = dialog.$("section h3 span[aria-hidden='true']");
      await expect(bugMarker).toHaveText("*");
      await expect(submitButton).toBeDisabled();
      const logs = $(`[data-testid="${TID_FEEDBACK_LOGS_OPT_IN}"]`);
      await expect(logs).toHaveAttribute("aria-checked", "true");
      await expect(dialog).toHaveText(expect.stringContaining(hint));
      expect(await dialog.$$("img").length).toBe(0);
      await logs.click();
      await expect(logs).toHaveAttribute("aria-checked", "false");
      await logs.click();
      await expect(logs).toHaveAttribute("aria-checked", "true");
      for (const theme of ["light", "dark"] as const) {
        await browser.execute((value) => {
          const actions = (
            window as typeof window & { __testActions?: { setTheme?: (theme: string) => void } }
          ).__testActions;
          if (!actions?.setTheme) throw new Error("缺少主题测试入口");
          actions.setTheme(value);
        }, theme);
        await expect(bugMarker).toBeDisplayed();
        await logs.scrollIntoView();
        await expect(logs).toBeDisplayed();
        await browser.saveScreenshot(
          join(screenshotDirectory, `zcode-feedback-${locale}-${theme}.png`),
        );
      }
      await browser.keys("Escape");
      await help.click();
      const requestLabel = locale === "zh-CN" ? "给产品提需求" : "Request a feature";
      await $(`//*[@role="menuitem" and contains(.,"${requestLabel}")]`).click();
      await dialog.waitForDisplayed({ timeout: 10000 });
      const requiredMarkers = await dialog.$$("section h3 span");
      expect(requiredMarkers.length).toBe(2);
      for (const marker of requiredMarkers) {
        await expect(marker).toHaveText("*");
        await expect(marker).toHaveAttribute("aria-hidden", "true");
      }
      const requestFields = await dialog.$$("textarea");
      expect(requestFields.length).toBe(2);
      const fieldLabels =
        locale === "zh-CN"
          ? ["需求描述", "期望的解决方案"]
          : ["Request description", "Expected solution"];
      for await (const [index, field] of requestFields.entries()) {
        await expect(field).toHaveAttribute("required");
        await expect(field).toHaveAttribute("aria-required", "true");
        await expect(field).toHaveAttribute("aria-label", fieldLabels[index]);
      }
      await expect(
        dialog.$(`button=${locale === "zh-CN" ? "提交需求" : "Submit request"}`),
      ).toBeDisabled();
      for (const theme of ["light", "dark"] as const) {
        await browser.execute((value) => {
          const actions = (
            window as typeof window & { __testActions?: { setTheme?: (theme: string) => void } }
          ).__testActions;
          if (!actions?.setTheme) throw new Error("缺少主题测试入口");
          actions.setTheme(value);
        }, theme);
        for (const marker of requiredMarkers) await expect(marker).toBeDisplayed();
        await browser.saveScreenshot(
          join(screenshotDirectory, `zcode-feature-request-${locale}-${theme}.png`),
        );
      }
      await browser.keys("Escape");
    });
  }
});

// 浏览器 fixture 单独由 esbuild 打包，不向 WDIO 的 Window 类型注入产品 store 声明。
declare global {
  interface Window {
    feedbackSubmitFixture?: {
      failNextCreate(): void;
      restore(jobId: string): void;
      snapshot(): {
        calls: { create: number; prepare: number; upload: string[]; cleanup: number };
        createInputs: Array<Record<string, unknown>>;
        jobs: Array<{ id: string; status: string; includeLogs?: boolean }>;
      };
    };
  }
}

describe("FB-PRIV-02: 反馈表单到日志服务边界", () => {
  let server: Awaited<ReturnType<typeof startHelpConfigFixture>>;
  let mainHandle: string;
  let windowId: number;

  before(async () => {
    // 按当前 spec 定位仓库根目录，否则测试页面会从仓库外查找入口与 tsconfig。
    const root = resolve(import.meta.dirname, "../../../../../..");
    const bundle = await build({
      entryPoints: [resolve(root, "packages/desktop/test/e2e/helpers/feedback-submit-fixture.js")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      alias: { "@": resolve(root, "packages/ui/src") },
      define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
      tsconfig: resolve(root, "packages/ui/tsconfig.json"),
    });
    // fixture 页的脚本在 head 同步执行；等 DOM 就绪后再挂载真实表单。
    server = await startHelpConfigFixture(
      {},
      `
      window.addEventListener("error", (event) => {
        document.documentElement.dataset.fixtureError = event.message;
      });
      window.addEventListener("DOMContentLoaded", () => { ${bundle.outputFiles[0]!.text} });
    `,
    );
    mainHandle = await browser.getWindowHandle();
    const existing = await browser.getWindowHandles();
    windowId = await browser.electron.execute(async (electron, url) => {
      const win = new electron.BrowserWindow({
        width: 1000,
        height: 900,
        show: false,
        // 隐藏窗口也保持回调计时稳定，避免 Chromium 后台节流影响表单完成回调。
        webPreferences: { sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      });
      await win.loadURL(url);
      return win.id;
    }, server.origin);
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > existing.length,
    );
    const handle = (await browser.getWindowHandles()).find((item) => !existing.includes(item))!;
    await browser.switchToWindow(handle);
  });
  after(async () => {
    if (windowId)
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
        windowId,
      );
    if (mainHandle) await browser.switchToWindow(mainHandle);
    await server?.close();
  });

  const snapshot = () => browser.execute(() => window.feedbackSubmitFixture!.snapshot());
  const submit = async () => {
    const previousJobs = (await snapshot()).jobs.length;
    await $("button=Submit feedback").click();
    await browser.waitUntil(
      async () => {
        const jobs = (await snapshot()).jobs;
        return jobs.length > previousJobs && ["success", "error"].includes(jobs.at(-1)!.status);
      },
      { timeout: 10000 },
    );
  };

  for (const kind of ["ssh", "wsl", "docker"] as const) {
    for (const includeLogs of [true, false]) {
      const caseId = includeLogs ? "FB-REMOTE-LOG-01" : "FB-REMOTE-LOG-02";
      it(`${caseId}: ${kind} 连接反馈${includeLogs ? "默认上传日志" : "允许取消日志"}`, async () => {
        await browser.url(`${server.origin}/#remoteKind=${kind}`);
        await browser.refresh();
        const openConnectionFeedback = async () => {
          const feedback = $("button=Feedback");
          await feedback.waitForDisplayed({ timeout: 10000 });
          await feedback.click();
          const logs = $(`[data-testid="${TID_FEEDBACK_LOGS_OPT_IN}"]`);
          await expect(logs).toHaveAttribute("aria-checked", "true");
          return logs;
        };
        const logs = await openConnectionFeedback();
        await expect($("textarea")).toHaveValue(
          expect.stringContaining("E2E_REMOTE_CONNECTION_LOG"),
        );
        if (!includeLogs) {
          await logs.click();
          await expect(logs).toHaveAttribute("aria-checked", "false");
        }
        await submit();
        const result = await snapshot();
        expect(result.jobs.at(-1)).toMatchObject({ status: "success", includeLogs });
        expect(result.createInputs).toHaveLength(1);
        expect(result.createInputs[0]).toMatchObject({
          title: "An error occurred during remote connection. Please help investigate.",
          description: expect.stringContaining("E2E_REMOTE_CONNECTION_LOG"),
          type: "bug",
        });
        expect(result.createInputs[0]!.description).toContain("E2E_REMOTE_FEEDBACK_FAILED");
        expect(result.calls).toEqual({
          create: 1,
          prepare: includeLogs ? 1 : 0,
          upload: includeLogs ? ["log"] : [],
          cleanup: includeLogs ? 1 : 0,
        });
        if (!includeLogs) await openConnectionFeedback();
      });
    }
  }

  it("FB-DESC-02: 空描述不调用服务，有效描述可提交", async () => {
    await browser.url(server.origin);
    const description = $("textarea");
    await description.waitForDisplayed({ timeout: 10000 });
    const submitButton = $("button=Submit feedback");
    await expect(description).toHaveAttribute("required");
    await expect(submitButton).toBeDisabled();
    await description.setValue("   ");
    await expect(submitButton).toBeDisabled();
    expect((await snapshot()).calls).toEqual({ create: 0, prepare: 0, upload: [], cleanup: 0 });
    await description.setValue("E2E_FEEDBACK_REQUIRED_DESCRIPTION");
    await expect(submitButton).toBeEnabled();
    // WebDriver clearValue 不保证触发 React 的 input；通过实际退格事件验证清空。
    await description.setValue(" ");
    await browser.keys("Backspace");
    await expect(description).toHaveValue("");
    await expect(submitButton).toBeDisabled();
    expect((await snapshot()).calls).toEqual({ create: 0, prepare: 0, upload: [], cleanup: 0 });
    await description.setValue("E2E_FEEDBACK_REQUIRED_DESCRIPTION");
    await submit();
    const result = await snapshot();
    expect(result.createInputs).toHaveLength(1);
    expect(result.createInputs[0]).toMatchObject({
      title: "E2E_FEEDBACK_REQUIRED_DESCRIPTION",
      description: expect.stringContaining("E2E_FEEDBACK_REQUIRED_DESCRIPTION"),
    });
  });

  for (const [name, includeLogs, restore] of [
    ["默认提交", true, false],
    ["取消后提交", false, false],
    ["开启日志的后台任务恢复后重试", true, true],
    ["取消日志的后台任务恢复后重试", false, true],
  ] as const) {
    it(`${name}：验证实际归档/上传调用`, async () => {
      await browser.refresh();
      const logs = $(`[data-testid="${TID_FEEDBACK_LOGS_OPT_IN}"]`);
      await browser.waitUntil(
        async () => {
          const error = await browser.execute(() => document.documentElement.dataset.fixtureError);
          if (error) throw new Error(`Feedback fixture failed: ${error}`);
          return logs.isExisting();
        },
        { timeout: 10000 },
      );
      await expect(logs).toHaveAttribute("aria-checked", "true");
      await $("textarea").setValue("E2E_FEEDBACK_LOG_CHOICE");
      if (!includeLogs) await logs.click();
      if (restore) {
        await browser.execute(() => window.feedbackSubmitFixture!.failNextCreate());
        await submit();
        const failed = await snapshot();
        expect(failed.jobs[0]).toMatchObject({ status: "error", includeLogs });
        expect(failed.calls).toEqual({ create: 1, prepare: 0, upload: [], cleanup: 0 });
        await browser.execute(
          (id) => window.feedbackSubmitFixture!.restore(id),
          failed.jobs[0]!.id,
        );
        await expect($("textarea")).toHaveValue("E2E_FEEDBACK_LOG_CHOICE");
        await expect(logs).toHaveAttribute("aria-checked", String(includeLogs));
      }
      await submit();
      const result = await snapshot();
      expect(result.jobs.at(-1)).toMatchObject({ status: "success", includeLogs });
      expect(result.createInputs).toHaveLength(restore ? 2 : 1);
      for (const input of result.createInputs) {
        expect(input).toMatchObject({
          title: "E2E_FEEDBACK_LOG_CHOICE",
          description: expect.stringContaining("E2E_FEEDBACK_LOG_CHOICE"),
          type: "bug",
        });
      }
      if (restore) expect(result.createInputs[1]).toEqual(result.createInputs[0]);
      expect(result.calls).toEqual({
        create: restore ? 2 : 1,
        prepare: includeLogs ? 1 : 0,
        upload: includeLogs ? ["log"] : [],
        cleanup: includeLogs ? 1 : 0,
      });
    });
  }
});
