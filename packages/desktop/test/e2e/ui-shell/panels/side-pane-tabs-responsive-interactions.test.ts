import { join } from "node:path";
import { release } from "node:os";
import {
  TID_TERMINAL_TOGGLE,
  TID_SIDE_PANE_TOGGLE,
  TID_WORKSPACE_HEADER,
  TID_WORKSPACE_TITLE,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { listSystemProcesses } from "#e2e/helpers/e2e-process-cleanup";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const TAB_SELECTOR = "[data-side-pane-tab-id]";
const VIEWPORT_SELECTOR = "[data-side-pane-tabs-viewport]";
const CONTENT_SELECTOR = "[data-side-pane-tabs-content]";
const ADD_TRIGGER_SELECTOR = "[data-side-pane-add-tab-trigger]";
const TOOLTIP_SELECTOR = '[data-slot="tooltip-content"]';
const DRAFT_SUGGESTED_PROMPTS_SLOT_SELECTOR = '[data-v4-draft-suggested-prompts-slot="true"]';

async function bottomTerminalText(): Promise<string> {
  return browser.execute(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#terminal .xterm-rows")).filter(
      (row) => row.offsetParent !== null,
    );
    return Array.from(rows.at(-1)?.children ?? [])
      .map((row) => (row.textContent ?? "").replace(/\u00a0/gu, " ").trimEnd())
      .join("\n");
  });
}

async function typeInBottomTerminal(command: string): Promise<void> {
  await browser.waitUntil(async () => /(?:>|[$#%])\s*$/u.test(await bottomTerminalText()), {
    timeout: 30_000,
    timeoutMsg: "底部终端提示符未就绪",
  });
  expect(
    await browser.execute((text) => {
      const input = Array.from(
        document.querySelectorAll<HTMLTextAreaElement>("#terminal .xterm-helper-textarea"),
      ).find((candidate) => candidate.closest<HTMLElement>(".xterm")?.offsetParent !== null);
      if (!input) return false;
      input.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
      return document.activeElement === input;
    }, command),
  ).toBe(true);
  await browser.keys("Enter");
}

function expectedWorkspacePanelRadiusPx(): number {
  if (process.platform === "win32") return 6;
  // Darwin 25 起对应 Tahoe，Sequoia 及旧系统的工作区使用更小的内层圆角。
  if (process.platform === "darwin") return Number.parseInt(release(), 10) >= 25 ? 12 : 6;
  return 12;
}

interface TabStripMetrics {
  addInsideViewport: boolean;
  clientWidth: number;
  scrollWidth: number;
  tabWidths: number[];
}

describe("Side Pane Tab responsive interactions", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    // 运行日志确认冷启预热回填会重新同步面板 scope；布局用例先等待投影就绪。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const pane = document.querySelector('[data-session-id="draft"]');
          return (
            pane?.getAttribute("data-session-lifecycle") === "ready" &&
            Boolean(pane.getAttribute("data-projection-seq"))
          );
        }),
      { timeout: 30_000, timeoutMsg: "布局用例的草稿投影尚未就绪" },
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SPT-E2E-000 renders the shared header skeleton for a new task draft", async () => {
    const header = await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`);
    await header.waitForDisplayed({ timeout: 10_000 });

    expect(await header.getAttribute("data-workspace-header-variant")).toBe("draft");
    if (process.platform === "win32" || process.platform === "linux") {
      expect(await header.$('[data-testid="desktop-window-controls"]').isExisting()).toBe(true);
    }
    expect(await header.$(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).getSize("height")).toBe(28);
    if (process.platform === "win32" || process.platform === "linux") {
      expect(await header.$("button > svg.lucide-chevron-down").isExisting()).toBe(false);
    }
    expect(await $(`[data-testid="${TID_WORKSPACE_TITLE}"]`).isExisting()).toBe(false);
    expect(await readHeaderBorderBottomColor()).toBe("rgba(0, 0, 0, 0)");
    expect(
      await browser.execute((slotSelector) => {
        const slot = document.querySelector<HTMLElement>(slotSelector);
        if (!slot) return null;
        const style = window.getComputedStyle(slot);
        return { height: style.height, position: style.position };
      }, DRAFT_SUGGESTED_PROMPTS_SLOT_SELECTOR),
    ).toEqual({ height: "32px", position: "static" });

    const sidePaneToggle = await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    await sidePaneToggle.waitForClickable({ timeout: 10_000 });
    const originalWidth = await browser.execute(
      () =>
        document
          .querySelector('[data-workspace-conversation-frame="true"]')
          ?.getBoundingClientRect().width ?? 0,
    );
    let expectedRestoredWidth = originalWidth;
    await sidePaneToggle.click();
    await browser.waitUntil(
      async () => (await readHeaderBorderBottomColor()) === "rgba(0, 0, 0, 0)",
      {
        timeout: 5_000,
        timeoutMsg: "Side Pane 展开后 Draft Header 分割线应保持透明",
      },
    );
    await browser.waitUntil(
      async () => {
        const metrics = await readIndependentPanelMetrics();
        return Boolean(
          metrics &&
          Math.abs(metrics.gap - 3) < 1 &&
          Math.abs(metrics.topDelta) < 1 &&
          Math.abs(metrics.bottomDelta) < 1,
        );
      },
      { timeout: 5000, timeoutMsg: "独立面板未形成上下对齐的 3px 间距" },
    );
    const panels = await readIndependentPanelMetrics();
    if (process.platform === "win32" || process.platform === "linux")
      expect(
        await browser.execute(() => {
          const controls = document.querySelector(
            '[data-workspace-side-frame] [data-testid="desktop-window-controls"]',
          )!;
          const frame = controls.closest("[data-workspace-side-frame]")!;
          return (
            frame.getBoundingClientRect().right -
            controls.getBoundingClientRect().right -
            parseFloat(getComputedStyle(frame).borderRightWidth)
          );
        }),
      ).toBeCloseTo(8, 0);
    if (process.platform === "win32" || process.platform === "linux") {
      expect(await header.$('[data-testid="desktop-window-controls"]').isExisting()).toBe(false);
      expect(
        await $(
          '[data-workspace-side-frame] [data-testid="desktop-window-controls"]',
        ).isDisplayed(),
      ).toBe(true);
      expect(
        await browser.execute(() => {
          const controls = document.querySelector(
            '[data-workspace-side-frame] [data-testid="desktop-window-controls"]',
          )!;
          const toggle = controls.previousElementSibling!;
          return controls.getBoundingClientRect().left - toggle.getBoundingClientRect().right;
        }),
      ).toBeCloseTo(2, 0);
    }
    if (process.platform === "win32" || process.platform === "linux") {
      expect(
        await browser.execute(() => {
          const logo = document.querySelector('[data-testid="desktop-top-logo-sidebar-toggle"]')!;
          return logo.getBoundingClientRect().left;
        }),
      ).toBe(13);
      const logoButton = await $('[data-testid="desktop-top-logo-sidebar-toggle"]');
      expect(await logoButton.getSize("width")).toBe(28);
      expect(await logoButton.$("[data-desktop-logo-badge]").getSize("width")).toBe(20);
      expect(await logoButton.$("[data-desktop-logo-badge] svg").getSize("width")).toBe(13);
      expect(await logoButton.$("animate").isExisting()).toBe(false);
      await logoButton.moveTo();
      await browser.waitUntil(
        async () =>
          await logoButton
            .$("[data-desktop-logo-visual]")
            .getCSSProperty("opacity")
            .then((value) => Number(value.value) === 0),
      );
      await logoButton.click();
      await logoButton.$("svg.lucide-panel-left-open").waitForExist();
      await browser.waitUntil(async () =>
        browser.execute(
          (inset) =>
            Math.abs(
              document
                .querySelector('[data-workspace-conversation-frame="true"]')!
                .getBoundingClientRect().left - inset,
            ) < 1,
          process.platform === "win32" ? 6 : 4,
        ),
      );
      await logoButton.click();
      await logoButton.$("svg.lucide-panel-left-close").waitForExist();
    }
    if (process.platform === "win32" || process.platform === "linux") {
      expect(
        await browser.execute(() => {
          const left = document
            .querySelector('[data-testid="desktop-top-nav-back"]')!
            .getBoundingClientRect();
          const right = document
            .querySelector('[data-testid="workspace-header"]')!
            .getBoundingClientRect();
          return Math.abs(left.top + left.height / 2 - right.top - right.height / 2);
        }),
      ).toBeLessThanOrEqual(1);
    }
    expect(
      await browser.execute(() => {
        const header = document.querySelector('[data-testid="workspace-header"]')!;
        const content = Array.from(header.children).find((element) =>
          element.classList.contains("p-2"),
        )!;
        return getComputedStyle(content).paddingRight;
      }),
    ).toBe("8px");
    if (
      process.platform === "win32" ||
      process.platform === "linux" ||
      process.platform === "darwin"
    ) {
      const inset = await browser.execute(() => {
        const content = document.querySelector("#content")!;
        const frame = document.querySelector('[data-workspace-conversation-frame="true"]')!;
        const style = getComputedStyle(content);
        return {
          right: style.paddingRight,
          bottom: style.paddingBottom,
          top: frame.getBoundingClientRect().top - content.getBoundingClientRect().top,
        };
      });
      const outerInset = process.platform === "win32" ? 6 : 4;
      expect(inset).toEqual({
        right: `${outerInset}px`,
        bottom: `${outerInset}px`,
        top: outerInset,
      });
      expect(
        await browser.execute(() => {
          const sidebar = document.querySelector<HTMLElement>(
            '[data-workspace-sidebar-panel="true"]',
          );
          const handle = document.querySelector<HTMLElement>('[data-testid="resizable-handle"]');
          if (!sidebar || !handle) return null;
          const sidebarRect = sidebar.getBoundingClientRect();
          const handleRect = handle.getBoundingClientRect();
          return handleRect.left + handleRect.width / 2 - sidebarRect.right;
        }),
      ).toBe(2);

      await movePointerAwayFromResizeHandles();
      expect(await readResizeHandleStyle('[data-testid="resizable-handle"]')).toEqual({
        hasExtendedIndicatorLine: true,
        indicatorOpacity: "0",
        handleHeight: "full",
        handleWidth: 4,

        marginLeft: "0px",
        marginRight: "0px",
      });
      const sidebarWidthBeforeDrag = await browser.execute(
        () =>
          document
            .querySelector<HTMLElement>('[data-workspace-sidebar-panel="true"]')!
            .getBoundingClientRect().width,
      );
      await hoverResizeHandle('[data-testid="resizable-handle"]');
      await assertResizeHandleVisible('[data-testid="resizable-handle"]');
      await dragResizeHandle('[data-testid="resizable-handle"]', 24, 0);
      await browser.waitUntil(
        async () =>
          Math.abs(
            (await browser.execute(
              () =>
                document
                  .querySelector<HTMLElement>('[data-workspace-sidebar-panel="true"]')!
                  .getBoundingClientRect().width,
            )) - sidebarWidthBeforeDrag,
          ) > 10,
        { timeout: 5000, timeoutMsg: "Sidebar resize handle 没有改变侧栏宽度" },
      );
      const sidebarWidthAfterDrag = await browser.execute(
        () =>
          document
            .querySelector<HTMLElement>('[data-workspace-sidebar-panel="true"]')!
            .getBoundingClientRect().width,
      );
      expectedRestoredWidth -= sidebarWidthAfterDrag - sidebarWidthBeforeDrag;
    }
    expect(await header.$(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).isExisting()).toBe(false);
    const sidePaneClose = await $(
      `[data-workspace-side-frame] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
    );
    await sidePaneClose.waitForClickable({ timeout: 5000 });
    expect(panels?.headerInsideConversation).toBe(true);
    const expectedPanelRadiusPx = expectedWorkspacePanelRadiusPx();
    if (expectedPanelRadiusPx === 6) {
      // Side Pane 展开时会话外框使用动态圆角变量，只有右侧 chrome 外框使用圆角 token。
      const framesUseRadiusToken = await browser.execute(() => {
        const frame = document.querySelector('[data-workspace-side-frame="true"]');
        return Boolean(
          frame?.classList.contains("rounded-md") || frame?.classList.contains("rounded-l-md"),
        );
      });
      expect(framesUseRadiusToken).toBe(true);
    }
    expect(panels?.leftRadius).toBe(`${expectedPanelRadiusPx}px`);
    expect(panels?.rightRadius).toBe(`${expectedPanelRadiusPx}px`);
    await movePointerAwayFromResizeHandles();
    expect(
      await readResizeHandleStyle('[data-workspace-side-pane-resize-handle="true"]'),
    ).toMatchObject({
      hasExtendedIndicatorLine: true,
      indicatorOpacity: "0",
      handleWidth: 3,
    });
    await hoverResizeHandle('[data-workspace-side-pane-resize-handle="true"]');
    await assertResizeHandleVisible('[data-workspace-side-pane-resize-handle="true"]');
    if (process.platform === "win32" || process.platform === "linux") {
      expect(
        await browser.execute(() => {
          const style = getComputedStyle(document.querySelector("[data-workspace-side-frame]")!);
          return [style.borderTopRightRadius, style.borderBottomRightRadius];
        }),
      ).toEqual(process.platform === "win32" ? ["6px", "6px"] : ["12px", "12px"]);
    }
    const drag = await browser.execute(() => {
      const frame = document
        .querySelector('[data-workspace-conversation-frame="true"]')!
        .getBoundingClientRect();
      return {
        x: Math.round(frame.right + 2),
        y: Math.round(frame.top + frame.height / 2),
        width: frame.width,
      };
    });
    await dragResizeHandle('[data-workspace-side-pane-resize-handle="true"]', -45, 0);
    await browser.waitUntil(
      async () => {
        const width = await browser.execute(
          () =>
            document
              .querySelector('[data-workspace-conversation-frame="true"]')!
              .getBoundingClientRect().width,
        );
        return Math.abs(width - drag.width) > 10;
      },
      { timeout: 5000, timeoutMsg: "独立面板间距无法拖动调整宽度" },
    );
    expect((await readIndependentPanelMetrics())?.gap).toBeCloseTo(3, 0);
    const terminalToggle = await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`);
    await terminalToggle.click();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const terminal = document.querySelector<HTMLElement>("#terminal");
          const frame = document.querySelector('[data-workspace-conversation-frame="true"]');
          return Boolean(
            terminal &&
            frame &&
            !frame.contains(terminal) &&
            terminal.closest("#conversation-column") === frame.closest("#conversation-column") &&
            terminal.getBoundingClientRect().height > 20 &&
            Math.abs(
              terminal.getBoundingClientRect().top - frame.getBoundingClientRect().bottom - 4,
            ) < 1,
          );
        }),
      { timeout: 10000, timeoutMsg: "终端没有以 4px 间距在会话下方独立展开" },
    );
    await movePointerAwayFromResizeHandles();
    expect(
      await readResizeHandleStyle('[data-workspace-terminal-resize-handle="true"]'),
    ).toMatchObject({
      hasExtendedIndicatorLine: true,
      indicatorOpacity: "0",
      handleHeight: 4,
    });
    const conversationHeightBeforeDrag = await browser.execute(
      () =>
        document
          .querySelector<HTMLElement>('[data-workspace-conversation-frame="true"]')!
          .getBoundingClientRect().height,
    );
    await hoverResizeHandle('[data-workspace-terminal-resize-handle="true"]');
    await assertResizeHandleVisible('[data-workspace-terminal-resize-handle="true"]');
    await dragResizeHandle('[data-workspace-terminal-resize-handle="true"]', 0, -24);
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await browser.execute(
            () =>
              document
                .querySelector<HTMLElement>('[data-workspace-conversation-frame="true"]')!
                .getBoundingClientRect().height,
          )) - conversationHeightBeforeDrag,
        ) > 10,
      { timeout: 5000, timeoutMsg: "Terminal resize handle 没有改变会话高度" },
    );
    for (const theme of ["zai-light", "zai-dark"]) {
      await browser.execute((value) => {
        const actions = (
          window as typeof window & { __testActions?: { setTheme?: (theme: string) => void } }
        ).__testActions;
        if (!actions?.setTheme) throw new Error("缺少主题测试入口");
        actions.setTheme(value);
      }, theme);
      await browser.waitUntil(
        async () =>
          browser.execute(
            (value) => document.documentElement.classList.contains(`theme-${value}`),
            theme,
          ),
        { timeout: 5000 },
      );
      for (const selector of [
        '[data-testid="resizable-handle"]',
        '[data-workspace-side-pane-resize-handle="true"]',
        '[data-workspace-terminal-resize-handle="true"]',
      ]) {
        expect((await readResizeHandleStyle(selector)).hasExtendedIndicatorLine).toBe(true);
      }
      const colors = await browser.execute(() => {
        const left = document.querySelector('[data-workspace-conversation-frame="true"]')!;
        const right = document.querySelector('[data-workspace-side-frame="true"]')!;
        const terminal = document.querySelector('[data-workspace-terminal-frame="true"]')!;
        return [
          getComputedStyle(left).backgroundColor,
          getComputedStyle(right).backgroundColor,
          getComputedStyle(terminal).backgroundColor,
        ];
      });
      expect(colors[0]).toBe(colors[1]);
      expect(colors[0]).toBe(colors[2]);
      expect(colors[0]).not.toBe("rgba(0, 0, 0, 0)");
      if (process.platform === "win32" || process.platform === "linux") {
        expect(await $("[data-desktop-logo-badge] svg").getSize("width")).toBe(13);
      }
      const terminalTabStyle = await browser.execute(() => {
        const tab = document.querySelector('#terminal [role="tab"][data-active]')!;
        const content = tab.querySelector("[data-terminal-tab-content]")!;
        return {
          border: getComputedStyle(tab).borderColor,
          mask: getComputedStyle(content).maskImage,
          closePosition: getComputedStyle(tab.querySelector("button")!).position,
          gap: getComputedStyle(tab.closest('[role="tablist"]')!).columnGap,
        };
      });
      expect(terminalTabStyle.border).toBe("rgba(0, 0, 0, 0)");
      expect(terminalTabStyle.mask).not.toBe("none");
      expect(terminalTabStyle.closePosition).toBe("static");
      expect(terminalTabStyle.gap).toBe("4px");
      await browser.saveScreenshot(
        join(
          process.env.ZCODE_E2E_ARTIFACT_DIR || process.cwd(),
          `independent-panels-${theme}.png`,
        ),
      );
    }
    await terminalToggle.click();

    await sidePaneClose.click();
    await browser.waitUntil(
      async () => (await readHeaderBorderBottomColor()) === "rgba(0, 0, 0, 0)",
      {
        timeout: 5_000,
        timeoutMsg: "Side Pane 收起后 Draft Header 分割线未恢复透明",
      },
    );
    await browser.waitUntil(
      async () => {
        const width = await browser.execute(
          () =>
            document
              .querySelector('[data-workspace-conversation-frame="true"]')
              ?.getBoundingClientRect().width ?? 0,
        );
        return Math.abs(width - expectedRestoredWidth) < 2;
      },
      { timeout: 5000, timeoutMsg: "关闭 Side Pane 后会话宽度未恢复" },
    );
    const closedFrame = await browser.execute(() => {
      const frame = document.querySelector('[data-workspace-conversation-frame="true"]')!;
      return {
        usesRadiusToken:
          frame.classList.contains("rounded-md") || frame.classList.contains("rounded-l-md"),
        leftRadius: getComputedStyle(frame).borderTopLeftRadius,
      };
    });
    if (expectedPanelRadiusPx === 6) expect(closedFrame.usesRadiusToken).toBe(true);
    expect(closedFrame.leftRadius).toBe(`${expectedPanelRadiusPx}px`);
  });

  it("TERM-TAB-05 closes the sole terminal session and creates a fresh one on reopen", async () => {
    const terminalToggle = await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`);
    const processMarker = `E2E_TERMINAL_CLOSE_${Date.now().toString(36)}`;
    let terminalProcessPid = 0;

    try {
      await terminalToggle.click();
      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            Boolean(
              document.querySelector<HTMLElement>("#terminal .xterm")?.getBoundingClientRect()
                .height,
            ),
          ),
        { timeout: 15_000, timeoutMsg: "唯一终端没有打开" },
      );

      const originalTerminalMarker = `terminal-${Date.now().toString(36)}`;
      const command = `node -e "setInterval(() => {}, 1000)" ${processMarker}`;
      await typeInBottomTerminal(command);
      await browser.waitUntil(
        async () => {
          const terminalProcess = (await listSystemProcesses()).find(
            (item) => item.command.includes(processMarker) && item.command.includes("node"),
          );
          terminalProcessPid = terminalProcess?.pid ?? 0;
          return terminalProcessPid > 0;
        },
        { timeout: 15_000, interval: 200, timeoutMsg: "唯一终端没有启动进程探针" },
      );
      expect(
        await browser.execute((marker) => {
          const terminal = document.querySelector<HTMLElement>("#terminal .xterm");
          terminal?.setAttribute("data-terminal-e2e-marker", marker);
          return Boolean(terminal);
        }, originalTerminalMarker),
      ).toBe(true);
      expect(
        await browser.execute(() => {
          const activeTab = document.querySelector<HTMLElement>(
            '#terminal [role="tab"][data-active]',
          );
          const close = activeTab?.querySelector<HTMLButtonElement>("button");
          close?.click();
          return Boolean(close);
        }),
      ).toBe(true);

      await browser.waitUntil(
        async () =>
          browser.execute((marker) => {
            const oldTerminal = document.querySelector(`[data-terminal-e2e-marker="${marker}"]`);
            const terminal = document.querySelector<HTMLElement>("#terminal");
            const panel = terminal?.closest<HTMLElement>("[data-panel]");
            return !oldTerminal && Boolean(panel && panel.getBoundingClientRect().height <= 1);
          }, originalTerminalMarker),
        { timeout: 15_000, timeoutMsg: "关闭唯一终端 tab 后旧 session 未卸载或面板未收起" },
      );
      await browser.waitUntil(
        async () => {
          const oldProcess = (await listSystemProcesses()).find(
            (item) => item.pid === terminalProcessPid && item.command.includes(processMarker),
          );
          return !oldProcess;
        },
        {
          timeout: 15_000,
          interval: 200,
          timeoutMsg: "关闭唯一终端 tab 后运行中的命令仍存活",
        },
      );

      await terminalToggle.click();
      await browser.waitUntil(
        async () =>
          browser.execute((marker) => {
            const terminal = document.querySelector<HTMLElement>("#terminal .xterm");
            return Boolean(
              terminal &&
              terminal.getAttribute("data-terminal-e2e-marker") !== marker &&
              terminal.getBoundingClientRect().height > 20,
            );
          }, originalTerminalMarker),
        { timeout: 15_000, timeoutMsg: "重新打开终端后没有创建新 session" },
      );
      await terminalToggle.click();
    } finally {
      if (terminalProcessPid > 0) {
        const probeStillExists = (await listSystemProcesses()).some(
          (item) => item.pid === terminalProcessPid && item.command.includes(processMarker),
        );
        if (probeStillExists) {
          try {
            process.kill(terminalProcessPid, "SIGKILL");
          } catch {
            // 进程可能在扫描后、清理前已经退出。
          }
        }
      }
    }
  });

  it("SPT-E2E-001 keeps one tab at 156px and the add button beside it", async () => {
    if (process.platform === "win32" || process.platform === "linux") {
      // 本组用例强制 tab viewport 为 360px；自绘窗控按 CSS 像素预留后，需要足够宽的真实窗口容纳测试夹具。
      await browser.electron.execute((electron) => {
        electron.BrowserWindow.getAllWindows()[0]!.setSize(2200, 1400);
      });
      await browser.waitUntil(async () => browser.execute(() => window.innerWidth > 1400));
    }
    await ensureTerminalTabCount(1);
    await setTabsViewportWidth(360);

    const metrics = await readTabStripMetrics();
    expect(metrics.tabWidths).toHaveLength(1);
    expect(metrics.tabWidths[0]).toBeCloseTo(156, 0);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.addInsideViewport).toBe(true);
    const regions = await browser.execute(() => {
      const header = document.querySelector('[data-workspace-side-frame] [role="tablist"]')!;
      const region = (element: Element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region");
      return {
        header: region(header),
        controls: [...header.querySelectorAll("button, [data-side-pane-tab-id]")].map(region),
      };
    });
    expect(regions.header).toBe("drag");
    expect(regions.controls.length).toBeGreaterThan(2);
    expect(regions.controls.every((region) => region === "no-drag")).toBe(true);
    const close = await $(`[data-workspace-side-frame] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    expect(
      await browser.execute(() => {
        const header = document.querySelector('[data-workspace-side-frame] [role="tablist"]')!;
        const first = header.querySelector("button")!;
        return first.getBoundingClientRect().left - header.getBoundingClientRect().left;
      }),
    ).toBeCloseTo(8, 0);
    await close.waitForClickable({ timeout: 5000 });
    await close.click();
    const reopen = await $(
      `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
    );
    await reopen.waitForClickable({ timeout: 5000 });
    await reopen.click();
    await ensureSidePaneExpanded();
    await $(TAB_SELECTOR).waitForDisplayed({ timeout: 5000 });
  });

  it("SPT-E2E-002 shrinks tabs equally above 60px before scrolling", async () => {
    await ensureTerminalTabCount(3);
    await setTabsViewportWidth(300);

    const metrics = await readTabStripMetrics();
    expect(metrics.tabWidths).toHaveLength(3);
    expect(Math.max(...metrics.tabWidths) - Math.min(...metrics.tabWidths)).toBeLessThanOrEqual(1);
    expect(metrics.tabWidths[0]).toBeGreaterThan(60);
    expect(metrics.tabWidths[0]).toBeLessThan(156);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.addInsideViewport).toBe(true);
  });

  it("SPT-E2E-003 scrolls only at the 60px floor and fixes add outside", async () => {
    await ensureTerminalTabCount(6);
    await setTabsViewportWidth(300);

    const metrics = await readTabStripMetrics();
    expect(metrics.tabWidths).toHaveLength(6);
    expect(Math.min(...metrics.tabWidths)).toBeGreaterThanOrEqual(59.5);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth + 1);
    expect(metrics.addInsideViewport).toBe(false);
  });

  it("SPT-E2E-004 shows close on active or hovered tabs without activating an inactive tab", async () => {
    await ensureTerminalTabCount(2);
    await setTabsViewportWidth(360);
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`).moveTo();

    const before = await browser.execute((tabSelector) => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(tabSelector));
      return tabs.map((tab) => {
        const closeButton = tab.querySelector<HTMLButtonElement>("button");
        const style = closeButton ? window.getComputedStyle(closeButton) : null;
        return {
          id: tab.dataset.sidePaneTabId ?? "",
          active: tab.dataset.state === "active",
          closeVisible:
            Boolean(closeButton) &&
            style?.display !== "none" &&
            style?.visibility !== "hidden" &&
            Number(style?.opacity ?? "0") > 0,
        };
      });
    }, TAB_SELECTOR);
    const inactive = before.find((tab) => !tab.active);
    const active = before.find((tab) => tab.active);

    expect(active?.closeVisible).toBe(true);
    expect(inactive?.closeVisible).toBe(false);
    expect(inactive?.id).toBeTruthy();
    expect(active?.id).toBeTruthy();

    const inactiveTab = await $(`${TAB_SELECTOR}[data-side-pane-tab-id="${inactive!.id}"]`);
    const readContent = () =>
      browser.execute((id) => {
        const tab = document.querySelector(`[data-side-pane-tab-id="${id}"]`)!;
        const content = tab.querySelector("[data-side-pane-tab-content]")!;
        const title = tab.querySelector("[data-side-pane-tab-title]")!;
        return {
          width: content.getBoundingClientRect().width,
          left: title.getBoundingClientRect().left,
          mask: getComputedStyle(content).maskImage,
          textOverflow: getComputedStyle(title).textOverflow,
        };
      }, inactive!.id);
    const idleContent = await readContent();
    await inactiveTab.moveTo();
    const hoveredContent = await readContent();
    expect(idleContent.textOverflow).toBe("clip");
    expect(idleContent.mask).not.toBe("none");
    expect(hoveredContent.mask).not.toBe(idleContent.mask);
    expect(hoveredContent.width).toBe(idleContent.width);
    expect(hoveredContent.left).toBe(idleContent.left);
    const closeButton = await inactiveTab.$("button");
    await closeButton.waitForDisplayed({ timeout: 5000 });
    await closeButton.click();

    await browser.waitUntil(
      async () =>
        browser.execute(
          (tabSelector, closedId, activeId) => {
            const closed = document.querySelector(
              `${tabSelector}[data-side-pane-tab-id="${closedId}"]`,
            );
            const current = document.querySelector<HTMLElement>(
              `${tabSelector}[data-side-pane-tab-id="${activeId}"]`,
            );
            return !closed && current?.dataset.state === "active";
          },
          TAB_SELECTOR,
          inactive!.id,
          active!.id,
        ),
      { timeout: 5_000, timeoutMsg: "关闭 inactive tab 后 active tab 发生变化" },
    );
  });

  it("SPT-E2E-005 restarts the 1500ms tooltip delay on another tab", async () => {
    await ensureTerminalTabCount(2);
    await setTabsViewportWidth(360);
    const tabs = await $$(TAB_SELECTOR);
    const [firstTab, secondTab] = tabs;
    if (!firstTab || !secondTab) throw new Error("Expected two Side Pane tabs");

    await firstTab.moveTo();
    await browser.pause(1_000);
    expect(await countDisplayedTooltips()).toBe(0);

    await secondTab.moveTo();
    await browser.pause(700);
    expect(await countDisplayedTooltips()).toBe(0);

    await browser.pause(1_000);
    // 终端标题可能重复且包含序号；读取 Tooltip 语义节点，避免外层 textContent 包含双份文案。
    expect(await countDisplayedTooltips()).toBe(1);
    const tooltipTitle = await browser.execute(() =>
      document.querySelector('[data-slot="tooltip-content"] [role="tooltip"]')?.textContent?.trim(),
    );
    expect(tooltipTitle).toBe(await secondTab.$("[data-side-pane-tab-title]").getText());
  });

  it("SPT-E2E-006 closes an inactive tab with the middle mouse button without activating it", async () => {
    await ensureTerminalTabCount(2);
    await setTabsViewportWidth(360);

    const before = await browser.execute((tabSelector) => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(tabSelector));
      return tabs.map((tab) => ({
        id: tab.dataset.sidePaneTabId ?? "",
        active: tab.dataset.state === "active",
      }));
    }, TAB_SELECTOR);
    const inactive = before.find((tab) => !tab.active);
    const active = before.find((tab) => tab.active);

    expect(inactive?.id).toBeTruthy();
    expect(active?.id).toBeTruthy();

    const dispatchResult = await browser.execute(
      (tabSelector, tabId) => {
        const tab = document.querySelector<HTMLElement>(
          `${tabSelector}[data-side-pane-tab-id="${tabId}"]`,
        );
        if (!tab) throw new Error(`Missing tab ${tabId}`);
        const event = new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: 1,
          buttons: 4,
        });
        const notCanceled = tab.dispatchEvent(event);
        return { notCanceled, active: tab.dataset.state === "active" };
      },
      TAB_SELECTOR,
      inactive!.id,
    );

    expect(dispatchResult.notCanceled).toBe(false);
    expect(dispatchResult.active).toBe(false);

    await browser.waitUntil(
      async () =>
        browser.execute(
          (tabSelector, closedId, activeId) => {
            const closed = document.querySelector(
              `${tabSelector}[data-side-pane-tab-id="${closedId}"]`,
            );
            const current = document.querySelector<HTMLElement>(
              `${tabSelector}[data-side-pane-tab-id="${activeId}"]`,
            );
            return !closed && current?.dataset.state === "active";
          },
          TAB_SELECTOR,
          inactive!.id,
          active!.id,
        ),
      { timeout: 5_000, timeoutMsg: "中键关闭 inactive tab 后 active tab 发生变化" },
    );
  });
  it("SPT-E2E-007 routes custom desktop minimize and close controls", async function () {
    if (process.platform !== "win32" && process.platform !== "linux") {
      this.skip();
      return;
    }
    if (process.platform === "win32" || process.platform === "linux") {
      const maximize = await $('[data-testid="window-control-maximize"]');
      const normalBounds = await browser.electron.execute((electron) =>
        electron.BrowserWindow.getAllWindows()[0]!.getBounds(),
      );
      expect(await maximize.getSize("height")).toBe(28);
      await maximize.click();
      await browser.waitUntil(
        async () => (await maximize.getAttribute("data-maximized")) === "true",
      );
      expect(await maximize.$("svg.lucide-window-restore").isExisting()).toBe(true);
      try {
        await browser.waitUntil(
          async () =>
            browser.execute(() => {
              const style = getComputedStyle(
                document.querySelector("[data-workspace-side-frame]")!,
              );
              return (
                [
                  style.borderTopLeftRadius,
                  style.borderTopRightRadius,
                  style.borderBottomLeftRadius,
                  style.borderBottomRightRadius,
                  // 修复原因：2026-10 起 Windows 面板圆角改用设计 token rounded-md（6px），
                  // 旧断言沿用 09-04 的 5px 规则；以 workspace-independent-panels 规格为准。
                ].every((value) => value === "6px") &&
                [
                  style.borderTopWidth,
                  style.borderRightWidth,
                  style.borderBottomWidth,
                  style.borderLeftWidth,
                ].every((value) => value === "1px")
              );
            }),
          { timeout: 5000, timeoutMsg: "最大化后的 Side Pane 必须保持四角 6px 和完整边框" },
        );
      } finally {
        await maximize.click();
        await browser.waitUntil(
          async () => (await maximize.getAttribute("data-maximized")) === "false",
        );
        await browser.waitUntil(async () => {
          const bounds = await browser.electron.execute((electron) =>
            electron.BrowserWindow.getAllWindows()[0]!.getBounds(),
          );
          return (
            bounds.width === normalBounds.width &&
            bounds.height === normalBounds.height &&
            Math.abs((await readIndependentPanelMetrics())!.gap - 3) < 1
          );
        });
      }
    }

    await browser.electron.execute((electron) => {
      const win = electron.BrowserWindow.getAllWindows()[0]! as Electron.BrowserWindow & {
        testMinimized?: boolean;
      };
      win.testMinimized = false;
      win.once("minimize", () => {
        win.testMinimized = true;
      });
    });
    await $('[data-testid="window-control-minimize"]').click();
    try {
      // WDIO 获取窗口上下文可能重新激活窗口，使用真实 minimize 事件作为成功证据。
      await browser.waitUntil(async () =>
        browser.electron.execute(
          (electron) =>
            (
              electron.BrowserWindow.getAllWindows()[0]! as Electron.BrowserWindow & {
                testMinimized?: boolean;
              }
            ).testMinimized === true,
        ),
      );
    } finally {
      await browser.electron.execute((electron) => {
        const win = electron.BrowserWindow.getAllWindows()[0]!;
        win.restore();
        win.show();
      });
    }
    // 修复原因：Windows 关闭最后一个窗口已改为直接 markForceQuit + app.quit()（不再只靠 close 事件），
    // 旧写法在 close 事件里 preventDefault 拦不住退出，WDIO 会话被销毁、后续用例全部 window closed。
    // 本用例验证自绘按钮经 DesktopCommand 路由到窗口 close；在窗口实例上临时记录 close 调用，
    // renderer → IPC → command 链路仍是真实的，退出流程不在本用例范围。
    await browser.electron.execute((electron) => {
      const win = electron.BrowserWindow.getAllWindows()[0]! as Electron.BrowserWindow & {
        testCloseReceived?: boolean;
      };
      win.testCloseReceived = false;
      win.close = () => {
        win.testCloseReceived = true;
      };
    });
    try {
      await $('[data-testid="window-control-close"]').click();
      await browser.waitUntil(async () =>
        browser.electron.execute(
          (electron) =>
            (
              electron.BrowserWindow.getAllWindows()[0]! as Electron.BrowserWindow & {
                testCloseReceived?: boolean;
              }
            ).testCloseReceived === true,
        ),
      );
    } finally {
      await browser.electron.execute((electron) => {
        const win = electron.BrowserWindow.getAllWindows()[0]! as Electron.BrowserWindow & {
          close: unknown;
        };
        // 删除实例属性，恢复原型上的真实 close。
        delete (win as { close?: unknown }).close;
      });
    }
  });
  it("SPT-E2E-009 opens a real new tab and replaces it with a tool", async () => {
    await ensureSidePaneExpanded();
    const active = () => $('[data-side-pane-tab-id][data-state="active"]');
    while ((await readTabCount()) > 1) {
      const count = await readTabCount();
      await (await active()).$("button").click();
      await browser.waitUntil(async () => (await readTabCount()) === count - 1);
    }
    if (!/新标签页|New tab/.test(await (await active()).getText())) {
      await (await active()).$("button").click();
      await browser.waitUntil(async () => (await readTabCount()) === 0);
      await $(
        `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
      ).waitForDisplayed();
      await ensureSidePaneExpanded();
    }
    expect(await readTabCount()).toBe(1);
    await $(ADD_TRIGGER_SELECTOR).waitForDisplayed();
    await $('[data-state="active"] [data-side-pane-open-tab-item="terminal"]').click();
    await browser.waitUntil(async () => !/新标签页|New tab/.test(await (await active()).getText()));
    expect(await readTabCount()).toBe(1);
    const toolId = await (await active()).getAttribute("data-side-pane-tab-id");
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await ensureSidePaneExpanded();
    expect(await (await active()).getAttribute("data-side-pane-tab-id")).toBe(toolId);
    await $(ADD_TRIGGER_SELECTOR).click();
    await browser.waitUntil(async () => (await readTabCount()) === 2);
    expect(await (await active()).getText()).toMatch(/新标签页|New tab/);
    await (await active()).$("button").click();
    await browser.waitUntil(async () => (await readTabCount()) === 1);
    await (await active()).$("button").click();
    await browser.waitUntil(async () => (await readTabCount()) === 0);
    await $(
      `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
    ).waitForDisplayed();
    await ensureSidePaneExpanded();
    expect(await (await active()).getText()).toMatch(/新标签页|New tab/);
    // 走真实菜单命令与 IPC，确认末标签关闭不再被自动补建吞掉。
    await browser.electron.execute((electron) => {
      const item = electron.Menu.getApplicationMenu()
        ?.items.flatMap((menu) => menu.submenu?.items ?? [])
        .find((entry) => entry.accelerator === "CmdOrCtrl+W");
      if (!item) throw new Error("未找到关闭当前上下文菜单");
      const target = electron.BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes("/renderer/index.html"),
      );
      if (!target || !item.enabled) throw new Error("关闭菜单或目标窗口不可用");
      target.focus();
      item.click(item, target, {} as never);
    });
    await browser.waitUntil(async () => (await readTabCount()) === 0);
    await $(
      `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
    ).waitForDisplayed();
    // 不真正关闭测试窗口；再次发出同一可取消事件，必须允许 Root 执行关窗 fallback。
    expect(
      await browser.execute(() =>
        window.dispatchEvent(new Event("zcode:close-active-context-request", { cancelable: true })),
      ),
    ).toBe(true);
    await ensureSidePaneExpanded();
    expect(await readTabCount()).toBe(1);
  });

  it("新标签页支持多开、聚焦、统一宽度和关闭", async () => {
    await ensureTerminalTabCount(1);
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await $(ADD_TRIGGER_SELECTOR).click();
      await browser.waitUntil(async () => (await readTabCount()) === index + 2);
      const active = await $('[data-side-pane-tab-id][data-state="active"]');
      const id = await active.getAttribute("data-side-pane-tab-id");
      if (!id) throw new Error("新标签页缺少 id");
      ids.push(id);
      expect(await active.getText()).toMatch(/新标签页|New tab/);
      expect(await active.getSize("width")).toBeLessThanOrEqual(156);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const first = await $(`[data-side-pane-tab-id="${ids[0]}"]`);
    await first.click();
    expect(await first.getAttribute("data-state")).toBe("active");
    await $('[data-state="active"] [data-side-pane-open-tab-item="browser"]').waitForDisplayed();
    await first.$("button").click();
    await browser.waitUntil(async () => (await readTabCount()) === 2);
    await $(`[data-side-pane-tab-id="${ids[1]}"] button`).click();
    await browser.waitUntil(async () => (await readTabCount()) === 1);
  });
});

interface ResizeHandleRect {
  x: number;
  y: number;
}

async function readResizeHandleRect(selector: string): Promise<ResizeHandleRect> {
  return browser.execute((targetSelector) => {
    const rect = document.querySelector<HTMLElement>(targetSelector)!.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, selector);
}

async function movePointerAwayFromResizeHandles(): Promise<void> {
  await browser.performActions([
    {
      type: "pointer",
      id: "resize-pointer",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", duration: 0, x: 20, y: 20 }],
    },
  ]);
  await browser.releaseActions();
}

async function hoverResizeHandle(selector: string): Promise<void> {
  await $(selector).moveTo();
}

async function dragResizeHandle(selector: string, deltaX: number, deltaY: number): Promise<void> {
  const rect = await readResizeHandleRect(selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "resize-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: rect.x, y: rect.y },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 250, x: rect.x + deltaX, y: rect.y + deltaY },
      ],
    },
  ]);
  try {
    await assertResizeHandleVisible(selector);
    // 开关有尺寸动画，真实拖拽仍必须跟手；按下期间不能继续做 width / flex-grow 过渡。
    const sizeMotion = await browser.execute(() => ({
      left: getComputedStyle(document.querySelector('[data-workspace-sidebar-panel="true"]')!)
        .transitionProperty,
      right: getComputedStyle(document.querySelector("#browser")!).transitionDuration,
    }));
    if (selector === '[data-testid="resizable-handle"]')
      expect(sizeMotion.left).not.toContain("width");
    expect(sizeMotion.right).toBe("0s");
  } finally {
    await browser.performActions([
      {
        type: "pointer",
        id: "resize-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerUp", button: 0 }],
      },
    ]);
    await browser.releaseActions();
  }
}

async function readResizeHandleStyle(selector: string) {
  return browser.execute((targetSelector) => {
    const handle = document.querySelector<HTMLElement>(targetSelector)!;
    const handleRect = handle.getBoundingClientRect();
    const handleStyle = getComputedStyle(handle);
    const indicatorStyle = getComputedStyle(handle, "::after");
    const reference = document.createElement("div");
    // 测试节点不参与 Tailwind 扫描，直接按主题 token 计算期望色，避免缺失 utility 造成误报。
    reference.style.backgroundColor = document.documentElement.classList.contains("dark")
      ? "var(--color-sky-400)"
      : "var(--color-sky-500)";
    document.body.append(reference);
    const indicatorColor = getComputedStyle(reference).backgroundColor;
    reference.remove();
    const vertical = handleRect.height > handleRect.width;
    const expectedInset = Number.parseFloat(
      handleStyle.getPropertyValue(
        targetSelector === '[data-testid="resizable-handle"]'
          ? "--workspace-resize-handle-inset"
          : "--workspace-panel-radius",
      ),
    );
    return {
      hasExtendedIndicatorLine:
        indicatorStyle.content !== "none" &&
        indicatorStyle.maskImage === "none" &&
        Math.abs(
          Number.parseFloat(vertical ? indicatorStyle.height : indicatorStyle.width) -
            ((vertical ? handleRect.height : handleRect.width) - 2 * expectedInset),
        ) < 1 &&
        indicatorStyle.backgroundColor === indicatorColor,
      indicatorOpacity: indicatorStyle.opacity,
      handleHeight: vertical ? "full" : handleRect.height,
      handleWidth: handleRect.width,

      marginLeft: handleStyle.marginLeft,
      marginRight: handleStyle.marginRight,
    };
  }, selector);
}

async function assertResizeHandleVisible(selector: string): Promise<void> {
  await browser.waitUntil(
    async () => Number((await readResizeHandleStyle(selector)).indicatorOpacity) > 0.99,
    { timeout: 1000 },
  );
  expect((await readResizeHandleStyle(selector)).hasExtendedIndicatorLine).toBe(true);
}

async function readHeaderBorderBottomColor(): Promise<string> {
  return browser.execute((headerTestId) => {
    const headerElement = document.querySelector<HTMLElement>(`[data-testid="${headerTestId}"]`);
    if (!headerElement) {
      throw new Error("Workspace Header is not mounted");
    }
    return window.getComputedStyle(headerElement).borderBottomColor;
  }, TID_WORKSPACE_HEADER);
}

async function ensureTerminalTabCount(targetCount: number): Promise<void> {
  await ensureSidePaneExpanded();
  const initialLauncher = await $(
    '[data-state="active"] [data-side-pane-open-tab-item="terminal"]',
  );
  if (await initialLauncher.isDisplayed()) {
    await initialLauncher.click();
    await browser.waitUntil(async () => !(await initialLauncher.isDisplayed()));
  }
  let count = await readTabCount();

  while (count > targetCount) {
    await browser.execute((tabSelector) => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(tabSelector));
      tabs.at(-1)?.querySelector<HTMLButtonElement>("button")?.click();
    }, TAB_SELECTOR);
    count -= 1;
    await browser.waitUntil(async () => (await readTabCount()) === count, {
      timeout: 5_000,
      timeoutMsg: `Side Pane Tab 数量未减少到 ${count}`,
    });
  }

  while (count < targetCount) {
    if (count === 0) {
      const launcher = await $('[data-side-pane-open-tab-item="terminal"]');
      await launcher.waitForClickable({ timeout: 10_000 });
      await launcher.click();
    } else {
      const addTrigger = await $(ADD_TRIGGER_SELECTOR);
      await addTrigger.waitForClickable({ timeout: 5_000 });
      await addTrigger.click();
      const launcher = await $('[data-state="active"] [data-side-pane-open-tab-item="terminal"]');
      await launcher.waitForClickable({ timeout: 5_000 });
      await launcher.click();
    }

    count += 1;
    await browser.waitUntil(async () => (await readTabCount()) === count, {
      timeout: 10_000,
      timeoutMsg: `Side Pane Tab 数量未增加到 ${count}`,
    });
  }
}

async function readTabCount(): Promise<number> {
  return browser.execute(
    (tabSelector) => document.querySelectorAll(tabSelector).length,
    TAB_SELECTOR,
  );
}

async function ensureSidePaneExpanded(): Promise<void> {
  // 运行时记录确认标题栏按钮会随收起动画移动；功能用例先等布局稳定再点坐标。
  // 动画中的快速反向另由 STF02 采样验证，这里不以可见/可点击代替动画完成。
  await waitForSidePaneMotion();
  // Side Pane 收起后仍保留 DOM，不能把标签栏存在当作已展开；等待实际面板显示后再操作。
  const isExpanded = () =>
    browser.execute(() => {
      const frame = document.querySelector('[data-workspace-side-frame="true"]');
      const panel = frame?.parentElement;
      return Boolean(
        panel &&
        panel.getBoundingClientRect().width > 100 &&
        getComputedStyle(panel).opacity === "1",
      );
    });
  // 展开动画尚未完成时不能再次切换；只有 WorkspaceHeader 中的展开按钮才触发打开。
  const toggle = await $(
    `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
  );
  if (await toggle.isExisting()) {
    await toggle.waitForClickable({ timeout: 10_000 });
    await toggle.click();
  }
  await browser.waitUntil(isExpanded, { timeout: 10_000, timeoutMsg: "Side Pane 未实际展开" });
  await waitForSidePaneMotion();
}

async function waitForSidePaneMotion(): Promise<void> {
  // Panel 尺寸命令和目标布局各在后续帧提交，先跨过提交帧再检查真实 CSS 过渡。
  await browser.executeAsync((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await browser.waitUntil(() =>
    browser.execute(
      () =>
        !document
          .querySelector("#browser")
          ?.getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition && animation.transitionProperty === "flex-grow",
          ),
    ),
  );
}

async function setTabsViewportWidth(widthPx: number): Promise<void> {
  await browser.execute(
    (viewportSelector, width) => {
      const viewport = document.querySelector<HTMLElement>(viewportSelector);
      if (!viewport) throw new Error("Missing Side Pane tabs viewport");
      viewport.style.flex = `0 0 ${width}px`;
      viewport.style.width = `${width}px`;
    },
    VIEWPORT_SELECTOR,
    widthPx,
  );
  await browser.pause(150);
}

async function readTabStripMetrics(): Promise<TabStripMetrics> {
  return browser.execute(
    (tabSelector, viewportSelector, contentSelector, addSelector) => {
      const viewport = document.querySelector<HTMLElement>(viewportSelector);
      const content = document.querySelector<HTMLElement>(contentSelector);
      const addTrigger = document.querySelector<HTMLElement>(addSelector);
      if (!viewport || !content || !addTrigger) {
        throw new Error("Side Pane tab strip metrics target is missing");
      }

      return {
        addInsideViewport: viewport.contains(addTrigger),
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        tabWidths: Array.from(content.querySelectorAll<HTMLElement>(tabSelector)).map(
          (tab) => tab.getBoundingClientRect().width,
        ),
      };
    },
    TAB_SELECTOR,
    VIEWPORT_SELECTOR,
    CONTENT_SELECTOR,
    ADD_TRIGGER_SELECTOR,
  );
}

async function countDisplayedTooltips(): Promise<number> {
  return browser.execute(
    (tooltipSelector) =>
      Array.from(document.querySelectorAll<HTMLElement>(tooltipSelector)).filter(
        (tooltip) => window.getComputedStyle(tooltip).visibility !== "hidden",
      ).length,
    TOOLTIP_SELECTOR,
  );
}

async function readIndependentPanelMetrics() {
  return browser.execute(() => {
    const left = document.querySelector<HTMLElement>('[data-workspace-conversation-frame="true"]');
    const right = document.querySelector<HTMLElement>('[data-workspace-side-frame="true"]');
    const header = document.querySelector('[data-testid="workspace-header"]');
    if (!left || !right) return null;
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return {
      gap: b.left - a.right,
      topDelta: b.top - a.top,
      bottomDelta: b.bottom - a.bottom,
      headerInsideConversation: left.contains(header),
      leftRadius: getComputedStyle(left).borderTopLeftRadius,
      rightRadius: getComputedStyle(right).borderTopLeftRadius,
    };
  });
}
