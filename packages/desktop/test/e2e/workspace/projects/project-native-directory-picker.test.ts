import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { ServiceChannels } from "@zcode/shared";
import type { VirtualProject } from "@zcode/services";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

type ThemeWindow = typeof window & {
  __testActions?: {
    getTheme(): string;
    setTheme(theme: string): void;
    getLocale(): "zh-CN" | "en-US";
    setLocale(locale: "zh-CN" | "en-US"): void;
  };
};

describe("本地项目原生多目录选择", () => {
  const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "native-project-picker");
  const paths = ["one", "two", "three"].map((name) => join(root, name));
  const project = '[data-project-name="E2E_NATIVE_PROJECT_PICKER"]';

  before(async () => {
    await waitForDefaultWorkspaceReady(30_000);
    await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
    await installHandoffRpcProbe();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await restoreHandoffProbes();
    await rm(root, { recursive: true, force: true });
  });

  it("NDP01/NDP02/PRO01: 多目录新项目排首位，刷新与重开后保留", async () => {
    const readProjectOrder = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="project-section"] [data-project-name]')].map(
          (element) => element.getAttribute("data-project-name"),
        ),
      );
    const previousOrder = await readProjectOrder();
    expect(previousOrder.length).toBeGreaterThan(0);
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_NATIVE_PROJECT_PICKER");
    await selectNativeProjectDirectories(paths.slice(0, 2));
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(2);
    await $$('[data-testid="virtual-project-root-row"]')[1]!
      .$('[data-testid="virtual-project-set-primary"]')
      .click();
    await selectNativeProjectDirectories([paths[1]!, paths[2]!]);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(3);
    await selectNativeProjectDirectories([]);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(3);
    expect(
      await $$('[data-testid="virtual-project-root-row"]')[1]!
        .$('[data-testid="virtual-project-primary"]')
        .isExisting(),
    ).toBe(true);
    // PCFT01/02/03：确认前读取真实 Host，取消不能留下项目或改写草稿。
    const readSaved = () =>
      callHandoffHost<VirtualProject[]>(ServiceChannels.Project, "readProjects");
    const before = await readSaved();
    for (const action of ["cancel", "close", "escape", "outside"]) {
      await $('[data-testid="virtual-project-save"]').click();
      const dialog = $('[data-testid="project-folder-trust-dialog"]');
      await dialog.waitForDisplayed();
      expect(
        await $$('[data-testid="project-folder-trust-path"]').map((row) => row.getText()),
      ).toEqual(paths);
      expect(await readSaved()).toEqual(before);
      if (action === "cancel") {
        expect(
          await browser.execute(() => document.activeElement?.getAttribute("data-testid")),
        ).toBe("project-folder-trust-cancel");
        await browser.keys("Enter");
      } else if (action === "close") {
        await dialog.$('[data-slot="dialog-close"]').click();
      } else if (action === "escape") {
        await browser.keys("Escape");
      } else {
        await browser.action("pointer").move({ x: 8, y: 8 }).down().up().perform();
      }
      await dialog.waitForExist({ reverse: true });
      expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
        "E2E_NATIVE_PROJECT_PICKER",
      );
      expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(3);
      await browser.waitUntil(() =>
        browser.execute(
          () => document.activeElement?.getAttribute("data-testid") === "virtual-project-save",
        ),
      );
      expect(await readSaved()).toEqual(before);
    }
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-dialog"]').waitForDisplayed();
    // Electron 没有 Browser.getWindowForTarget，窗口尺寸通过真实 BrowserWindow 调整。
    const windowSize = await browser.electron.execute((electron) => {
      const appWindow = electron.BrowserWindow.getAllWindows()[0]!;
      return { bounds: appWindow.getBounds(), minimum: appWindow.getMinimumSize() };
    });
    const trustViewport = await browser.execute(() => ({ width: innerWidth, height: innerHeight }));
    const trustTheme = await browser.execute(() =>
      (window as ThemeWindow).__testActions!.getTheme(),
    );
    const trustLocale = await browser.execute(() =>
      (window as ThemeWindow).__testActions!.getLocale(),
    );
    try {
      for (const width of [1200, 390]) {
        await browser.execute(
          (viewportWidth) =>
            (window as ThemeWindow).__testActions!.setLocale(
              viewportWidth === 1200 ? "en-US" : "zh-CN",
            ),
          width,
        );
        await browser.electron.execute((electron, nextWidth) => {
          const appWindow = electron.BrowserWindow.getAllWindows()[0]!;
          appWindow.setMinimumSize(320, 480);
          appWindow.setSize(nextWidth, 844);
        }, width);
        await browser.waitUntil(() =>
          browser.execute((nextWidth) => innerWidth === nextWidth, width),
        );
        for (const theme of ["zai-light", "zai-dark"]) {
          await browser.execute(
            (value) => (window as ThemeWindow).__testActions!.setTheme(value),
            theme,
          );
          await waitForTrustLayout({ width, height: 844 });
          const geometry = await browser.execute(() => {
            const button = document.querySelector('[data-testid="project-folder-trust-confirm"]')!;
            const box = button.getBoundingClientRect();
            return {
              visible:
                box.left >= 0 &&
                box.right <= innerWidth &&
                box.top >= 0 &&
                box.bottom <= innerHeight,
              hit: button.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              ),
            };
          });
          expect(geometry).toEqual({ visible: true, hit: true });
          expect(await $('[data-testid="project-folder-trust-dialog"]').getText()).toContain(
            width === 1200 ? "This computer" : "此电脑",
          );
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `PCFT-trust-${width}-${theme}.png`),
          );
        }
      }
    } finally {
      await browser.electron.execute((electron, previous) => {
        const appWindow = electron.BrowserWindow.getAllWindows()[0]!;
        appWindow.setBounds(previous.bounds);
        appWindow.setMinimumSize(previous.minimum[0]!, previous.minimum[1]!);
      }, windowSize);
      await browser.execute(
        (value) => (window as ThemeWindow).__testActions!.setTheme(value),
        trustTheme,
      );
      await browser.execute(
        (locale) => (window as ThemeWindow).__testActions!.setLocale(locale),
        trustLocale,
      );
    }
    // 原生 resize 返回时弹窗尺寸过渡仍会移动按钮；等待实际布局收口，避免单次点击落空。
    await waitForTrustLayout(trustViewport);
    expect(
      await browser.execute(() =>
        document
          .getAnimations()
          .filter((animation) => {
            const dialog = document.querySelector('[data-testid="project-folder-trust-dialog"]');
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return (
              animation.playState === "running" &&
              animation instanceof CSSTransition &&
              /^(max-)?(width|height)$|^transform$/.test(animation.transitionProperty) &&
              target instanceof Element &&
              dialog &&
              (dialog.contains(target) || target.contains(dialog))
            );
          })
          .map((animation) => (animation as CSSTransition).transitionProperty),
      ),
    ).toEqual([]);
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
    expect(
      (await readSaved())
        .find((item) => item.name === "E2E_NATIVE_PROJECT_PICKER")
        ?.roots.map((item) => item.rootPath),
    ).toEqual(paths);
    // 窄屏布局会自动收起侧栏；还原尺寸后通过真实入口展开，再检查项目顺序。
    if (!(await $('[data-testid="project-section"]').isDisplayed())) {
      await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
    }
    await $(project).waitForDisplayed();
    expect(await readProjectOrder()).toEqual(["E2E_NATIVE_PROJECT_PICKER", ...previousOrder]);
    await browser.refresh();
    // 创建项目已激活所选主要目录；刷新仍等待旧夹具目录会把正确恢复误报成导航失败。
    await waitForWorkspaceApp(paths[1]!, 30_000);
    await $(project).waitForDisplayed();
    expect(await readProjectOrder()).toEqual(["E2E_NATIVE_PROJECT_PICKER", ...previousOrder]);
    await $(project).$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-edit"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    const rows = await $$('[data-testid="virtual-project-root-name"]');
    expect(await rows.map((row) => row.getAttribute("title"))).toEqual(paths);
    expect(
      await $$('[data-testid="virtual-project-root-row"]')[1]!
        .$('[data-testid="virtual-project-primary"]')
        .isExisting(),
    ).toBe(true);
    const originalTheme = await browser.execute(() =>
      (window as ThemeWindow).__testActions!.getTheme(),
    );
    try {
      for (const theme of ["zai-light", "zai-dark"]) {
        await browser.execute(
          (value) => (window as ThemeWindow).__testActions!.setTheme(value),
          theme,
        );
        await browser.waitUntil(() =>
          browser.execute(
            (value) => document.documentElement.classList.contains(`theme-${value}`),
            theme,
          ),
        );
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `native-project-${theme}.png`),
        );
      }
    } finally {
      await browser.execute(
        (value) => (window as ThemeWindow).__testActions!.setTheme(value),
        originalTheme,
      );
    }
    await browser.keys("Escape");
    await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
    await $(project).$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-delete"]').click();
    await $(project).waitForExist({ reverse: true });
  });
});

async function waitForTrustLayout(viewport: { width: number; height: number }): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const dialog = document.querySelector('[data-testid="project-folder-trust-dialog"]');
        if (!dialog || innerWidth !== expected.width || innerHeight !== expected.height)
          return false;
        return !document.getAnimations().some((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return (
            animation.playState === "running" &&
            animation instanceof CSSTransition &&
            /^(max-)?(width|height)$|^transform$/.test(animation.transitionProperty) &&
            target instanceof Element &&
            (dialog.contains(target) || target.contains(dialog))
          );
        });
      }, viewport),
    { timeout: 10_000, timeoutMsg: "信任弹窗视口或布局过渡尚未完成" },
  );
}
