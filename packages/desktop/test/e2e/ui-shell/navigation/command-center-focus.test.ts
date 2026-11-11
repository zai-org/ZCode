import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

async function setTheme(theme: string) {
  await browser.execute((value) => {
    const actions = (
      window as typeof window & { __testActions?: { setTheme(theme: string): void } }
    ).__testActions;
    if (!actions) throw new Error("缺少主题测试入口");
    actions.setTheme(value);
  }, theme);
  await browser.waitUntil(() =>
    browser.execute(
      (value) => document.documentElement.classList.contains(`theme-${value}`),
      theme,
    ),
  );
}

async function emulate(width?: number, forcedColors = false) {
  await browser.electron.execute(
    async (electron, width, forcedColors) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) throw new Error("No visible renderer");
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
        width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
      );
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: forcedColors ? [{ name: "forced-colors", value: "active" }] : [],
      });
    },
    width,
    forcedColors,
  );
}

describe("组合输入框焦点", () => {
  afterEach(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "command-center-focus-dialogs.json"),
      JSON.stringify(
        await browser.execute(() =>
          Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).map(
            (dialog) => dialog.textContent,
          ),
        ),
      ),
    );
    await browser.keys("Escape");
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
  });
  it("CC-FOCUS-01：深浅主题和窄屏只保留外层胶囊边框", async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    for (const theme of ["zai-light", "zai-dark"]) {
      await setTheme(theme);
      const search = $('[data-testid="sidebar-search-open"]');
      await search.waitForDisplayed();
      await $('[data-testid="plugin-store-sidebar-open"]').moveTo();
      const entrance = await browser.execute(() => {
        const button = document.querySelector<HTMLElement>('[data-testid="sidebar-search-open"]')!;
        button.blur();
        const filter = document.querySelector<HTMLElement>('[data-testid="sidebar-view-menu"]')!;
        const title = document.querySelector<HTMLElement>('[data-testid="sidebar-list-title"]')!;
        const section = document.querySelector<HTMLElement>(
          '[data-purpose-section-drag-trigger="projects"]',
        )!;
        const titleColorProbe = document.createElement("span");
        titleColorProbe.className = "text-foreground-subtle";
        title.parentElement!.appendChild(titleColorProbe);
        const titleColor = getComputedStyle(titleColorProbe).color;
        titleColorProbe.remove();
        const searchRect = button.getBoundingClientRect();
        const filterRect = filter.getBoundingClientRect();
        return {
          titleUsesBase:
            parseFloat(getComputedStyle(title).fontSize) ===
            parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size"),
            ),
          sectionUsesBase:
            parseFloat(getComputedStyle(section).fontSize) ===
            parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size"),
            ),
          titleSizeDelta:
            parseFloat(getComputedStyle(title).fontSize) -
            parseFloat(getComputedStyle(section).fontSize),
          titleHasSecondaryColor: getComputedStyle(title).color === titleColor,
          titleTopSpacing: getComputedStyle(
            title.closest<HTMLElement>('[data-testid="sidebar-task-list-region"]')!,
          ).paddingTop,
          titleBottomSpacing: getComputedStyle(
            title.closest<HTMLElement>('[data-testid="sidebar-search-toolbar"]')!,
          ).paddingBottom,
          listDividerWidth: getComputedStyle(
            title.closest<HTMLElement>('[data-testid="sidebar-task-list-region"]')!,
          ).borderTopWidth,
          independentHeader:
            title.closest('[data-testid="sidebar-task-list-region"]') !== null &&
            title.closest('[data-testid="sidebar-primary-navigation"]') === null,
          tag: button.tagName,
          searchWidth: searchRect.width,
          searchHeight: searchRect.height,
          buttonGap: filterRect.left - searchRect.right,
          filterWidth: filterRect.width,
          filterHeight: filterRect.height,
          ordered:
            title.getBoundingClientRect().right <= searchRect.left &&
            searchRect.right <= filterRect.left,
          text: button.textContent,
        };
      });
      expect(entrance).toEqual({
        titleUsesBase: true,
        sectionUsesBase: true,
        titleSizeDelta: 0,
        titleHasSecondaryColor: true,
        titleTopSpacing: "12px",
        titleBottomSpacing: "8px",
        listDividerWidth: "1px",
        independentHeader: true,
        tag: "BUTTON",
        searchWidth: 24,
        searchHeight: 24,
        buttonGap: 4,
        filterWidth: 24,
        filterHeight: 24,
        ordered: true,
        text: "",
      });
      const divider = await browser.execute(() => {
        const region = document.querySelector<HTMLElement>(
          '[data-testid="sidebar-task-list-region"]',
        )!;
        const extension = document.querySelector<HTMLElement>("[data-sidebar-divider-extension]")!;
        const handle = document.querySelector<HTMLElement>('[data-testid="resizable-handle"]')!;
        const regionRect = region.getBoundingClientRect();
        const extensionRect = extension.getBoundingClientRect();
        const handleRect = handle.getBoundingClientRect();
        const probe = document.createElement("span");
        probe.className = "border-t border-border/50";
        region.appendChild(probe);
        const expectedColor = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return {
          startGap: extensionRect.left - regionRect.right,
          endGap: handleRect.right - extensionRect.right,
          verticalGap: extensionRect.top - regionRect.top,
          height: extensionRect.height,
          width: handleRect.width,
          pointerEvents: getComputedStyle(extension).pointerEvents,
          sameColor:
            getComputedStyle(extension).backgroundColor ===
              getComputedStyle(region).borderTopColor &&
            getComputedStyle(region).borderTopColor === expectedColor,
        };
      });
      expect(divider).toEqual({
        startGap: 0,
        endGap: 0,
        verticalGap: 0,
        height: 1,
        width: 4,
        pointerEvents: "none",
        sameColor: true,
      });
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `sidebar-title-actions-${theme}.png`),
      );
      const dragStart = await browser.execute(() => {
        const region = document.querySelector<HTMLElement>(
          '[data-testid="sidebar-task-list-region"]',
        )!;
        const handle = document.querySelector<HTMLElement>('[data-testid="resizable-handle"]')!;
        const sidebar = document.querySelector<HTMLElement>(
          '[data-workspace-sidebar-panel="true"]',
        )!;
        return {
          x: Math.round(handle.getBoundingClientRect().left + 2),
          y: Math.round(region.getBoundingClientRect().top),
          width: sidebar.getBoundingClientRect().width,
        };
      });
      await browser.performActions([
        {
          type: "pointer",
          id: "divider-resize",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, x: dragStart.x, y: dragStart.y },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 200, x: dragStart.x + 24, y: dragStart.y },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () =>
              document
                .querySelector<HTMLElement>('[data-workspace-sidebar-panel="true"]')!
                .getBoundingClientRect().width,
          )) >
          dragStart.width + 10,
        { timeout: 5000, timeoutMsg: "分隔线处拖拽未改变侧栏宽度" },
      );
      await search.moveTo();
      const hint = $('[data-slot="tooltip-content"]');
      await hint.waitForDisplayed();
      expect(await hint.$('[data-slot="kbd"]').getText()).toMatch(/K/);
      expect(await hint.getText()).not.toContain(" · ");
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `sidebar-search-tooltip-${theme}.png`),
      );
      await search.click();
      const input = $('[role="dialog"] [cmdk-input]');
      await input.waitForDisplayed();
      for (const width of [512, 360]) {
        // 样式回归只收窄共享面板，不依赖任务 fixture 或手机连接。
        await browser.execute((value) => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
          dialog.style.setProperty("width", `${value}px`, "important");
          dialog.style.setProperty("max-width", `${value}px`, "important");
        }, width);
        // 面板宽度有过渡动画，读取最终几何后再断言，避免把动画中间帧当成回归。
        await browser.waitUntil(() =>
          browser.execute(
            (value) =>
              document.querySelector('[role="dialog"]')!.getBoundingClientRect().width === value,
            width,
          ),
        );
        await input.click();
        const focusStyle = await browser.execute(() => {
          const input = document.querySelector('[role="dialog"] [cmdk-input]')!;
          return {
            focusVisible: input.matches(":focus-visible"),
            // outline 为 none 时，当前 Electron 仍返回 medium 的 3px；按是否绘制断言。
            outlineStyle: getComputedStyle(input).outlineStyle,
            boxShadow: getComputedStyle(input).boxShadow,
            shellBorderWidth: getComputedStyle(input.parentElement!).borderTopWidth,
            width: document.querySelector('[role="dialog"]')!.getBoundingClientRect().width,
          };
        });
        expect(focusStyle).toEqual({
          focusVisible: true,
          outlineStyle: "none",
          boxShadow: "none",
          shellBorderWidth: "1px",
          width,
        });
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `command-center-focus-${theme}-${width}.png`),
        );
      }
      await browser.keys("Escape");
    }
  });

  it("DIALOG-FOCUS-01：项目名称沿用共享 Input 焦点边框，点击和 Tab 不叠加 outline", async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    try {
      // 窄屏会收起侧栏；先打开共享弹窗，再在同一弹窗切换主题与宽度，不创建项目。
      await emulate(1200);
      await $('[data-testid="virtual-project-add"]').click();
      // 创建项目已直接进入表单，旧类型选择步骤不再存在。
      const input = $('[data-testid="virtual-project-name"]');
      await input.waitForDisplayed();
      await browser.waitUntil(() => input.isFocused());
      for (const theme of ["zai-light", "zai-dark"]) {
        await setTheme(theme);
        for (const width of [1200, 390]) {
          for (const forcedColors of [false, true]) {
            await emulate(width, forcedColors);
            await browser.waitUntil(() =>
              browser.execute(
                (expectedWidth, forced) =>
                  innerWidth === expectedWidth &&
                  matchMedia("(forced-colors: active)").matches === forced,
                width,
                forcedColors,
              ),
            );
            await input.click();
            await browser.keys("Tab");
            expect(await input.isFocused()).toBe(false);
            await browser.keys(["Shift", "Tab"]);
            expect(await input.isFocused()).toBe(true);
            await input.setValue("E2E_DIALOG_FOCUS");
            expect(await input.getValue()).toBe("E2E_DIALOG_FOCUS");
            const focusStyle = await browser.execute(() => {
              const input = document.querySelector('[data-testid="virtual-project-name"]')!;
              const dialog = input.closest('[role="dialog"]')!.getBoundingClientRect();
              // 名称已使用独立 Input；旧测试把普通布局父元素当成组合输入外壳。
              const probe = document.createElement("span");
              probe.style.border = "1px solid var(--color-input-border-focused)";
              document.body.appendChild(probe);
              const expectedBorderColor = getComputedStyle(probe).borderTopColor;
              probe.remove();
              return {
                focusVisible: input.matches(":focus-visible"),
                // outline 为 none 时，当前 Electron 仍返回 medium 的 3px；按是否绘制断言。
                outlineStyle: getComputedStyle(input).outlineStyle,
                boxShadow: getComputedStyle(input).boxShadow,
                inputBorderWidth: getComputedStyle(input).borderTopWidth,
                inputBorderColor: getComputedStyle(input).borderTopColor,
                expectedBorderColor,
                parentBorderWidth: getComputedStyle(input.parentElement!).borderTopWidth,
                fits: dialog.left >= 0 && dialog.right <= innerWidth,
                inputSize: Number.parseFloat(getComputedStyle(input).fontSize),
              };
            });
            expect(focusStyle.focusVisible).toBe(true);
            expect(focusStyle.outlineStyle).toBe("none");
            expect(focusStyle.boxShadow).toBe("none");
            expect(focusStyle.inputBorderWidth).toBe("1px");
            expect(focusStyle.parentBorderWidth).toBe("0px");
            if (!forcedColors)
              expect(focusStyle.inputBorderColor).toBe(focusStyle.expectedBorderColor);
            expect(focusStyle.fits).toBe(true);
            if (width === 390) expect(focusStyle.inputSize).toBeGreaterThanOrEqual(16);
            await browser.saveScreenshot(
              join(
                process.env.ZCODE_E2E_ARTIFACT_DIR!,
                `project-focus-${theme}-${width}-${forcedColors ? "forced" : "normal"}.png`,
              ),
            );
          }
        }
      }
    } finally {
      await emulate();
      await browser.keys("Escape");
    }
  });
});
