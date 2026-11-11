import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";

type TooltipWindow = typeof window & {
  __sidebarTooltipProbe?: { elapsed: number; text: string };
  __sidebarTooltipObserver?: MutationObserver;
  __sidebarTooltipPointer?: { x: number; y: number };
  __sidebarTooltipHits?: string[];
};

describe("SBT sidebar tooltip delay", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(join(DEFAULT_WORKSPACE, "src"), { recursive: true });
    await writeFile(
      join(DEFAULT_WORKSPACE, "src", "sidebar-fixture.ts"),
      "export const fixture = true;\n",
    );
  });
  after(async () => {
    await clearAppData();
  });

  it("SBT01/02/03: 左侧提示等待 300ms，右侧文件树保留原生提示和操作", async () => {
    const artifacts = join(process.cwd(), ".e2e-artifacts", "sidebar-tooltips-desktop");
    await mkdir(artifacts, { recursive: true });
    const project = '[data-testid="virtual-project-row"]';
    await $(project).waitForDisplayed();
    await $(project).moveTo();
    const selectors = [
      `${project} [data-testid="virtual-project-menu"]`,
      `${project} [data-testid="virtual-project-files"]`,
      `${project} [data-testid="virtual-project-create-task"]`,
      '[data-testid="virtual-project-add"]',
      '[data-testid="virtual-project-new-task"]',
      '[data-testid="sidebar-search-open"]',
      '[data-testid="sidebar-view-menu"]',
      '[data-testid="task-settings-button"]',
    ];
    const measurements: Array<{ selector: string; elapsed: number; text: string }> = [];
    const checkHint = async (selector: string, sidebarDelay = true) => {
      await $(selector).scrollIntoView({ block: "nearest" });
      await browser.execute((selector) => {
        const state = window as TooltipWindow;
        state.__sidebarTooltipObserver?.disconnect();
        state.__sidebarTooltipProbe = undefined;
        state.__sidebarTooltipPointer = undefined;
        state.__sidebarTooltipHits = [];
        document.addEventListener(
          "pointermove",
          (event) => {
            state.__sidebarTooltipHits?.push((event.target as Element).outerHTML);
          },
          { once: true, capture: true },
        );
        const element = document.querySelector(selector)!;
        element.addEventListener(
          "pointermove",
          (event) => {
            const pointer = event as PointerEvent;
            state.__sidebarTooltipPointer = { x: pointer.clientX, y: pointer.clientY };
            const start = performance.now();
            const observer = new MutationObserver(() => {
              const tooltip = document.querySelector(
                '[data-slot="tooltip-content"][data-state$="open"]',
              );
              if (!tooltip) return;
              state.__sidebarTooltipProbe = {
                elapsed: performance.now() - start,
                text: tooltip.textContent ?? "",
              };
              observer.disconnect();
            });
            state.__sidebarTooltipObserver = observer;
            observer.observe(document.body, { subtree: true, childList: true });
          },
          { once: true },
        );
      }, selector);
      await $(selector).moveTo();
      try {
        await browser.waitUntil(
          () => browser.execute(() => Boolean((window as TooltipWindow).__sidebarTooltipProbe)),
          { timeout: 5000, timeoutMsg: `Tooltip did not open: ${selector}` },
        );
      } catch (error) {
        await browser.saveScreenshot(join(artifacts, "failure.png"));
        const diagnostic = await browser.execute((selector) => {
          const element = document.querySelector(selector)!;
          const rect = element.getBoundingClientRect();
          return {
            selector,
            pointer: (window as TooltipWindow).__sidebarTooltipPointer,
            hits: (window as TooltipWindow).__sidebarTooltipHits,
            element: element.outerHTML,
            hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
              ?.outerHTML,
            hints: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).map(
              (node) => node.outerHTML,
            ),
          };
        }, selector);
        await writeFile(join(artifacts, "failure.json"), JSON.stringify(diagnostic, null, 2));
        throw error;
      }
      const timing = await browser.execute(() => (window as TooltipWindow).__sidebarTooltipProbe!);
      measurements.push({ selector, ...timing });
      if (sidebarDelay) expect(timing.elapsed).toBeGreaterThanOrEqual(275);
      expect(timing.elapsed).toBeLessThan(1500);
      expect(timing.text.trim().length).toBeGreaterThan(0);
    };
    for (const selector of selectors) await checkHint(selector);
    await browser.saveScreenshot(join(artifacts, "sidebar.png"));

    // 用原生 pointer 路径验证提前移出，不通过直接派发事件绕过命中测试。
    await browser.action("pointer").move({ x: 1000, y: 500 }).perform();
    await browser.pause(350);
    await $('[data-testid="sidebar-search-open"]').moveTo();
    await browser.pause(100);
    expect(await $$('[data-slot="tooltip-content"]').length).toBe(0);
    await browser.action("pointer").move({ x: 1000, y: 500 }).perform();
    await browser.pause(350);
    expect(await $$('[data-slot="tooltip-content"]').length).toBe(0);

    await $(`${project} [data-testid="virtual-project-files"]`).click();
    const panel = '[data-testid="workspace-file-tree-panel"]';
    await $(panel).waitForDisplayed();
    const more = `${panel} button:has(svg.lucide-ellipsis)`;
    // 文件树已迁到右侧，不属于左侧 300ms 提示范围；检查真实原生 title 和操作。
    const checkNativeTitle = async (selector: string) => {
      expect((await $(selector).getAttribute("title"))?.trim().length).toBeGreaterThan(0);
    };
    await checkNativeTitle(more);
    const refresh = '[data-testid="workspace-file-tree-refresh-button"]';
    // 刷新原本就是共享自定义提示，右侧不套用左侧的 300ms 门槛。
    await checkHint(refresh, false);
    await $(refresh).click();
    await $(`${panel} [role="treeitem"]`).waitForDisplayed();
    await checkNativeTitle(`${panel} [role="treeitem"]`);
    await $(more).click();
    await $('[role="menuitem"]').waitForDisplayed();
    await browser.keys("Escape");
    // 菜单关闭会恢复触发器焦点；等关闭完成后再输入，避免文本落入菜单的键盘搜索。
    await $('[role="menu"]').waitForDisplayed({ reverse: true, timeout: 5000 });
    await $(`${panel} input`).click();
    await $(`${panel} input`).setValue("src");
    expect(await $(`${panel} input`).getValue()).toBe("src");
    await writeFile(
      join(artifacts, "file-search-dom.json"),
      JSON.stringify(
        await browser.execute((selector) => {
          const root = document.querySelector(selector);
          return {
            input: root?.querySelector("input")?.value,
            active: document.activeElement?.outerHTML,
            buttons: Array.from(root?.querySelectorAll("button") ?? []).map(
              (button) => button.outerHTML,
            ),
          };
        }, panel),
        null,
        2,
      ),
    );
    const clear = `${panel} button:has(svg.lucide-x)`;
    await checkNativeTitle(clear);
    await $(clear).click();
    expect(await $(`${panel} input`).getValue()).toBe("");
    await browser.saveScreenshot(join(artifacts, "file-tree.png"));
    await writeFile(join(artifacts, "timings.json"), JSON.stringify(measurements, null, 2));
  });
});
