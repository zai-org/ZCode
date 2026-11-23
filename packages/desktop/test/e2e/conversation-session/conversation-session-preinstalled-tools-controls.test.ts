import { preinstalledFixtureRecordPath } from "#e2e/helpers/preinstalled-tools-fixture";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const fixtureStatus = async () =>
  (await fetch(`${fixtureUrl()}/status`)).json() as Promise<{
    requests: number;
    pending: number;
    runtimeChecks: number;
    lateWrites: number;
  }>;
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function waitStatus(status: string) {
  await browser.waitUntil(
    async () =>
      (await $(
        '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
      ).getAttribute("data-status")) === status,
    { timeout: 30000, timeoutMsg: `预装状态未达到 ${status}` },
  );
}
async function toggleAuto(enabled: boolean) {
  const toggle = $('[data-testid="preinstalled-tools-auto-install"]');
  await toggle.waitForDisplayed();
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
  await browser.waitUntil(
    async () =>
      (await toggle.getAttribute("aria-checked")) === String(enabled) && (await toggle.isEnabled()),
    { timeout: 10000 },
  );
}

async function repeatPrepare() {
  const result = await browser.executeAsync((done: (error: string | null) => void) => {
    const api = (
      window as typeof window & {
        zcode: {
          executePreinstalledToolsCommand(command: {
            type: "prepare";
            toolId: string;
          }): Promise<void>;
        };
      }
    ).zcode;
    void Promise.all(
      Array.from({ length: 4 }, () =>
        api.executePreinstalledToolsCommand({ type: "prepare", toolId: "libreoffice" }),
      ),
    ).then(
      () => done(null),
      (error) => done(String(error)),
    );
  });
  expect(result).toBeNull();
}
async function visualMatrix(phase: string) {
  // 仅用现有展示动作设置语言和主题；不改预装状态、操作归属或安装事实。
  for (const locale of ["zh-CN", "en-US"] as const)
    for (const theme of ["zai-dark", "zai-light"] as const) {
      await setPluginPresentation({ locale, theme, width: 1000, height: 760 });
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="preinstalled-tools-dialog"]').getText()).includes(
            locale === "zh-CN" ? "自动预装" : "Automatic preinstall",
          ),
        { timeout: 10000 },
      );
      await assertDialogFits();
      await browser.saveScreenshot(
        `${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-controls-${phase}-${locale}-${theme}.png`,
      );
    }
  await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 760, height: 640 });
  await assertDialogFits();
  await browser.saveScreenshot(
    `${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-controls-${phase}-small.png`,
  );
  await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1000, height: 760 });
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const dialog = document.querySelector('[data-testid="preinstalled-tools-dialog"]');
        return (
          dialog
            ?.getAnimations({ subtree: true })
            .every(
              (animation) =>
                animation.effect?.getComputedTiming().iterations === Infinity ||
                animation.playState === "finished" ||
                animation.playState === "idle",
            ) ?? false
        );
      }),
    { timeout: 10000 },
  );
}
async function emulateMotion(value?: "reduce" | "no-preference") {
  await browser.electron.execute(async (electron, preference) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
    );
    if (!window) throw new Error("没有可见的预装工具窗口");
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: preference ? [{ name: "prefers-reduced-motion", value: preference }] : [],
    });
  }, value);
}

async function assertDialogFits() {
  const layout = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="preinstalled-tools-dialog"]',
    )!;
    const rect = dialog.getBoundingClientRect();
    return {
      scrollWidth: dialog.scrollWidth,
      width: dialog.clientWidth,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
}

describe("预装工具完整控制（待审核）", () => {
  it("LOP-03/04/06/07/09/10/14/15: 偏好、取消、重试与可访问对话框", async function () {
    this.timeout(360000);
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("preparing");
    await $('[data-testid="preinstalled-tools-auto-install"]').execute((element) =>
      element.focus(),
    );
    await browser.keys("Space");
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute(
          "aria-checked",
        )) === "false",
      { timeout: 10000 },
    );
    await repeatPrepare();
    expect((await fixtureStatus()).requests).toBe(1);
    await waitStatus("preparing");
    await $('[data-testid="preinstalled-tools-cancel"]').click();
    await waitStatus("not-installed");
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    const recordPath = await preinstalledFixtureRecordPath(root);
    await expect(stat(recordPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readdir(join(root, "tools", "libreoffice", "staging"))).toEqual([]);
    await visualMatrix("not-installed");
    await browser.keys("Escape");
    await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed({ reverse: true });
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("not-installed");
    expect(
      await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute("aria-checked"),
    ).toBe("false");
    expect((await fixtureStatus()).requests).toBe(1);
    await $('[data-testid="preinstalled-tools-download"]').click();
    await waitStatus("preparing");
    await browser.waitUntil(async () => (await fixtureStatus()).requests === 2, { timeout: 10000 });
    await repeatPrepare();
    expect((await fixtureStatus()).requests).toBe(2);
    // 使用公开平台命令紧邻提交取消和重试，不写 owner、store 或私有 Promise。
    await browser.execute(async () => {
      const api = (
        window as typeof window & {
          zcode: {
            executePreinstalledToolsCommand(command: {
              type: "cancel" | "prepare";
              toolId: string;
            }): Promise<void>;
          };
        }
      ).zcode;
      await Promise.all([
        api.executePreinstalledToolsCommand({ type: "cancel", toolId: "libreoffice" }),
        api.executePreinstalledToolsCommand({ type: "prepare", toolId: "libreoffice" }),
      ]);
    });
    await browser.waitUntil(async () => (await fixtureStatus()).requests === 3, { timeout: 10000 });
    await fetch(`${fixtureUrl()}/release-request/2`);
    expect((await fixtureStatus()).lateWrites).toBe(1);
    await waitStatus("preparing");
    await expect(stat(recordPath)).rejects.toHaveProperty("code", "ENOENT");
    await visualMatrix("downloading");
    await fetch(`${fixtureUrl()}/break-request/3`);
    await waitStatus("failed");
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      "下载中断，请重试。",
    );
    await visualMatrix("failed");
    await $('[data-testid="preinstalled-tools-retry"]').click();
    await browser.waitUntil(async () => (await fixtureStatus()).requests === 4, { timeout: 10000 });
    await fetch(`${fixtureUrl()}/release-request/4`);
    await browser.waitUntil(
      async () =>
        (await $(
          '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
        ).getAttribute("data-phase")) === "checking",
      { timeout: 30000 },
    );
    await visualMatrix("checking");
    // 动画类存在并不代表位置会变；缺少定位时 left 动画曾静止在 35%。
    const indicatorX = () =>
      browser.execute(
        () =>
          document
            .querySelector(
              '[data-testid="preinstalled-tools-dialog"] [data-slot="progress-indicator"]',
            )!
            .getBoundingClientRect().x,
      );
    await emulateMotion("no-preference");
    const initialX = await indicatorX();
    await browser.waitUntil(async () => Math.abs((await indicatorX()) - initialX) > 2, {
      timeout: 4000,
      interval: 50,
      timeoutMsg: "检查阶段的滚动指示条没有移动",
    });
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-indeterminate-motion.json"),
      JSON.stringify({ phase: "checking", initialX, movedX: await indicatorX() }),
    );
    try {
      await emulateMotion("reduce");
      const reduced = await browser.execute(() => ({
        media: matchMedia("(prefers-reduced-motion: reduce)").matches,
        animation: getComputedStyle(
          document.querySelector(
            '[data-testid="preinstalled-tools-dialog"] [data-slot="progress-indicator"]',
          )!,
        ).animationName,
      }));
      expect(reduced).toEqual({ media: true, animation: "none" });
    } finally {
      await emulateMotion();
    }
    expect(
      await $('[data-testid="preinstalled-tools-dialog"] [role="progressbar"]').getAttribute(
        "aria-valuenow",
      ),
    ).toBeNull();
    await fetch(`${fixtureUrl()}/finish-check`);
    await waitStatus("ready");
    await visualMatrix("ready");
    // 发布后到达的取消只能读取已就绪结果，不能撤销记录。
    await browser.execute(async () => {
      await (
        window as typeof window & {
          zcode: {
            executePreinstalledToolsCommand(command: {
              type: "cancel";
              toolId: string;
            }): Promise<void>;
          };
        }
      ).zcode.executePreinstalledToolsCommand({ type: "cancel", toolId: "libreoffice" });
    });
    await waitStatus("ready");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    expect(await stat(record.installationDir)).toBeDefined();
    expect(
      await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute("aria-checked"),
    ).toBe("false");
    expect(await $$("[data-sonner-toast]").length).toBe(0);
    await browser.keys("Escape");
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await rm(recordPath);
        await rm(record.installationDir, { recursive: true, force: true });
      },
    });
    await fetch(`${fixtureUrl()}/hold`);
    await fetch(`${fixtureUrl()}/hold-check`);
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("not-installed");
    await toggleAuto(true);
    await waitStatus("preparing");
    await browser.waitUntil(async () => (await fixtureStatus()).requests === 5, { timeout: 10000 });
    await fetch(`${fixtureUrl()}/release-request/5`);
    await browser.waitUntil(async () => (await fixtureStatus()).runtimeChecks === 2, {
      timeout: 30000,
    });
    await $('[data-testid="preinstalled-tools-cancel"]').click();
    await waitStatus("not-installed");
    expect(
      await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute("aria-checked"),
    ).toBe("true");
    await expect(stat(recordPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readdir(join(root, "tools", "libreoffice", "staging"))).toEqual([]);

    // 从外部文件系统制造原子发布失败；运行检查通过也不能留下可用记录或半成品路径。
    await $('[data-testid="preinstalled-tools-download"]').click();
    await browser.waitUntil(async () => (await fixtureStatus()).requests === 6, { timeout: 10000 });
    await fetch(`${fixtureUrl()}/release-request/6`);
    await browser.waitUntil(async () => (await fixtureStatus()).runtimeChecks === 3, {
      timeout: 30000,
    });
    await mkdir(recordPath);
    await fetch(`${fixtureUrl()}/finish-check`);
    await waitStatus("failed");
    expect((await stat(recordPath)).isDirectory()).toBe(true);
    expect(await readdir(join(root, "tools", "libreoffice", "versions"))).toEqual([]);
    expect(await readdir(join(root, "tools", "libreoffice", "staging"))).toEqual([]);
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-controls-publication-failed.png`,
    );
    await rm(recordPath, { recursive: true });
    await $('[data-testid="preinstalled-tools-retry"]').click();
    await browser.waitUntil(async () => (await fixtureStatus()).requests === 7, { timeout: 10000 });
    await fetch(`${fixtureUrl()}/release-request/7`);
    await waitStatus("ready");
    expect((await stat(recordPath)).isFile()).toBe(true);
  });
});
