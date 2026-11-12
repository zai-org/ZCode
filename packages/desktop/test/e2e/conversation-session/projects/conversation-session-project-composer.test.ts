import { join } from "node:path";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";

describe("输入框项目选择器", () => {
  it("VP30：未打开项目与侧栏一致、搜索项目、零 root 选择与改名同步", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: "zh-CN"): void } }
      ).__testActions!.setLocale("zh-CN");
    });
    const names = Array.from({ length: 7 }, (_, i) => `E2E_PROJECT_PICKER_${i}`);
    for (const name of names) {
      await $('[data-testid="virtual-project-add"]').click();
      await $('[data-testid="virtual-project-name"]').setValue(name);
      await $('[data-testid="virtual-project-save"]').click();
      await $(`[data-project-name="${name}"]`).waitForExist();
      // 列表先收到保存结果，编辑器遮罩在退出动画结束后才卸载；不能先点击下一个创建入口。
      await $('[data-slot="dialog-overlay"]').waitForExist({ reverse: true });
    }
    const sidebarNames = await browser.execute(() =>
      [...document.querySelectorAll("aside [data-project-name]")].map((n) =>
        n.getAttribute("data-project-name"),
      ),
    );
    await $('[data-testid="composer-workspace-trigger"]').click();
    const menu = $('[data-testid="composer-project-menu"]');
    await menu.waitForDisplayed();
    expect(await menu.$('input[placeholder="搜索项目或设备"]').isExisting()).toBe(true);
    // 原生拖拽命中不受 DOM 层级影响；CDP 点击可绕过它，必须同时检查菜单的 no-drag。
    expect(
      await browser.execute(() =>
        getComputedStyle(
          document.querySelector('[data-testid="composer-project-menu"]')!,
        ).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    await menu.$("input").click();
    expect(
      await browser.execute(
        () =>
          document.activeElement ===
          document.querySelector('[data-testid="composer-project-menu"] input'),
      ),
    ).toBe(true);
    const menuNames = () =>
      browser.execute(() =>
        [
          ...document.querySelectorAll('[data-testid="composer-project-menu"] [data-project-id]'),
        ].map((n) => n.getAttribute("data-project-name")),
      );
    expect(await menuNames()).toEqual(sidebarNames);
    await menu.$("input").setValue(names[6]!);
    expect(await menuNames()).toEqual([names[6]]);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-composer-search.png"),
    );
    await menu.$("[data-project-id]").click();
    const trigger = $('[data-testid="composer-workspace-trigger"]');
    await browser.waitUntil(async () => (await trigger.getText()).includes(names[6]!));
    const project = $(`[data-project-name="${names[6]}"]`);
    await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
    await $('[data-testid="virtual-project-edit"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_PROJECT_PICKER_RENAMED");
    await $('[data-testid="virtual-project-save"]').click();
    await browser.waitUntil(async () =>
      (await trigger.getText()).includes("E2E_PROJECT_PICKER_RENAMED"),
    );
    await trigger.click();
    // WebDriver clearValue 不保证触发 React input；用真实键盘清空受控搜索框。
    await menu.$("input").click();
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
    await browser.keys("Backspace");
    await browser.waitUntil(async () => (await menuNames()).length === sidebarNames.length);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-composer-directory.png"),
    );
    const checked = menu.$('[data-project-id][aria-checked="true"]');
    expect(await checked.getAttribute("data-project-name")).toBe("E2E_PROJECT_PICKER_RENAMED");
    expect((await menuNames()).includes(names[6]!)).toBe(false);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-composer-directory.png"),
    );
    await browser.keys("Escape");
    await $(
      '[data-project-name="E2E_PROJECT_PICKER_RENAMED"] [data-testid="virtual-project-row"]',
    ).click({ button: "right" });
    await $('[data-testid="virtual-project-delete"]').click();
    await $('[data-project-name="E2E_PROJECT_PICKER_RENAMED"]').waitForExist({ reverse: true });
    await trigger.click();
    expect(await menuNames()).not.toContain("E2E_PROJECT_PICKER_RENAMED");
    await captureMenuLayouts();
    await browser.keys("Escape");
  });
});

async function captureMenuLayouts() {
  const originalTheme = await browser.execute(() =>
    (window as typeof window & { __testActions: { getTheme(): string } }).__testActions.getTheme(),
  );
  const emulate = (width?: number) =>
    browser.electron.execute(async (electron, width) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.isVisible(),
      )!;
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
        width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
      );
    }, width);
  const theme = (value: string) =>
    browser.execute(
      (value) =>
        (
          window as typeof window & { __testActions: { setTheme(value: string): void } }
        ).__testActions.setTheme(value),
      value,
    );
  try {
    for (const width of [1200, 390]) {
      await emulate(width);
      await browser.waitUntil(() => browser.execute((expected) => innerWidth === expected, width));
      for (const value of ["zai-light", "zai-dark"]) {
        await theme(value);
        await browser.waitUntil(() =>
          browser.execute(
            (value) => document.documentElement.classList.contains(`theme-${value}`),
            value,
          ),
        );
        // 只验证共享菜单窄屏布局，不把设备模拟当成手机 shared-host 验证。
        const bounds = await browser.execute(() => {
          const menu = document.querySelector('[data-testid="composer-project-menu"]')!;
          const footer = menu.querySelector('[data-testid="composer-work-outside-project"]')!;
          const list = menu.querySelector("[data-project-id]")!.closest(".overflow-y-auto")!;
          const box = menu.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: innerWidth,
            height: innerHeight,
            footerBottom: footer.getBoundingClientRect().bottom,
            scrolls: getComputedStyle(list).overflowY === "auto",
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(bounds.width);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
        expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.bottom);
        expect(bounds.scrolls).toBe(true);
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `project-composer-${width}-${value}.png`),
        );
      }
    }
  } finally {
    await emulate();
    await theme(originalTheme);
  }
}
