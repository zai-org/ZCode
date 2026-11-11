import { access } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { readDynamicWorkflowGrayMockStatus } from "#e2e/helpers/dynamic-workflow-gray";
import {
  denyV4PermissionWithFeedback,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 保存确认窗的长内容（docs/dynamic-workflow/launch.md「`SaveWorkflow`」第 4 步）：窗口上限与问答窗相同，
// 选项以上是**唯一**的纵向滚动区，选项与确认钉在下面；说明折叠到 4 行、实参折叠到 8 行、脚本默认
// 收起，展开只把同一个滚动区变长。保存窗只由模型调用 SaveWorkflow 打开，所以走合成回放：一次
// 超长载荷的 tool_use。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里
// （与 …-gray-always-on-user-choice 同一个借道）。
// 先真实加载 dynamic-workflows Skill，再调用 SaveWorkflow；否则工具在审批前就会拒绝。
// 真实高度、滚轮去向、粘性表头由 Electron 回放验证。
const MARKER = "E2E_DWF_SAVE_WINDOW_BOUNDS";
const FINAL_MARKER = "E2E_DWF_SAVE_WINDOW_BOUNDS_DONE";
const SAVED_FILE = join(DEFAULT_WORKSPACE, ".zcode", "workflows", "release-check-overlong.dwf.ts");
const PANEL = '[data-permission-dialog-bounded="true"]';
const SCROLL_AREA = '[data-permission-dialog-scroll="true"]';
// 与组件同值：min(72dvh, 42rem)，根字号 16px。
const PANEL_CAP_REM_PX = 672;
const ARGS_PREVIEW_ROWS = 8;
const ARGS_TOTAL = 40;
/** 矮屏用例的内容区高度：低于 36rem（576px），保存确认窗应退回整窗一个滚动区。 */
const SHORT_VIEWPORT_PX = 480;

interface SaveWindowState {
  viewportHeight: number;
  panelTop: number;
  panelBottom: number;
  areaTop: number;
  areaScrollTop: number;
  areaClientHeight: number;
  areaScrollHeight: number;
  /** 窗口里所有内容溢出、且纵向可滚的元素：设计要求只有滚动区自己。 */
  verticalScrollers: string[];
  /** 窗口之外所有可滚元素的 scrollTop：滚轮手势不能漏到对话时间线上。 */
  outsideScrollTops: number[];
  argRows: number;
  clampToggles: number;
  argsHeaderTop: number | null;
  /** 确认按钮中心点上最上层的元素就是它自己：没被裁掉、没被盖住、在视口内。 */
  confirmHit: boolean;
}

async function readSaveWindowState(): Promise<SaveWindowState | null> {
  return browser.execute(
    (panelSelector: string, areaSelector: string) => {
      const panel = document.querySelector<HTMLElement>(panelSelector);
      const area = document.querySelector<HTMLElement>(areaSelector);
      const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
        ["Confirm", "确认"].includes(button.getAttribute("aria-label") ?? ""),
      );
      if (!panel || !area || !confirm) return null;
      const scrollsVertically = (element: Element) => {
        const overflowY = getComputedStyle(element).overflowY;
        return (
          (overflowY === "auto" || overflowY === "scroll") &&
          element.scrollHeight > element.clientHeight + 1
        );
      };
      const verticalScrollers = [panel, ...Array.from(panel.querySelectorAll("*"))]
        .filter(scrollsVertically)
        .map((element) =>
          element === area
            ? "scroll-area"
            : element === panel
              ? "panel"
              : `${element.tagName}.${String(element.className)}`,
        );
      const outsideScrollTops = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((element) => !panel.contains(element) && scrollsVertically(element))
        .map((element) => element.scrollTop);
      const confirmRect = confirm.getBoundingClientRect();
      const hit = document.elementFromPoint(
        confirmRect.left + confirmRect.width / 2,
        confirmRect.top + confirmRect.height / 2,
      );
      const header = panel.querySelector('[data-workflow-save-args="true"] th');
      const panelRect = panel.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        panelTop: panelRect.top,
        panelBottom: panelRect.bottom,
        areaTop: area.getBoundingClientRect().top,
        areaScrollTop: area.scrollTop,
        areaClientHeight: area.clientHeight,
        areaScrollHeight: area.scrollHeight,
        verticalScrollers,
        outsideScrollTops,
        argRows: panel.querySelectorAll("[data-workflow-save-arg]").length,
        clampToggles: panel.querySelectorAll('[data-workflow-save-clamp-toggle="true"]').length,
        argsHeaderTop: header ? header.getBoundingClientRect().top : null,
        confirmHit: hit === confirm || confirm.contains(hit),
      };
    },
    PANEL,
    SCROLL_AREA,
  );
}

async function wheelOverScrollArea(deltaY: number) {
  await browser
    .action("wheel")
    .scroll({ origin: await $(SCROLL_AREA), deltaY, duration: 0 })
    .perform();
}

describe("动态工作流 · 保存确认窗的长内容", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWS-01 超长说明 + 40 个实参 + 长脚本：一个滚动区、选项钉底、长内容折叠且键盘可达，滚轮只动滚动区，矮屏整窗滚动", async function () {
    this.timeout(240000);

    expect((await readDynamicWorkflowGrayMockStatus()).scenario).toBe("alwaysOn");

    await sendV4Prompt(`${MARKER} 把刚才的工作流保存下来`);
    await waitForV4PermissionDialogInComposerDock();

    // 1) 窗口：不超过 min(72% 视口, 42rem)、整窗在视口内、确认按钮点得到；纵向可滚的只有滚动区。
    let state: SaveWindowState | null = null;
    await browser.waitUntil(
      async () => {
        state = await readSaveWindowState();
        return state !== null && state.confirmHit;
      },
      { timeout: 30000, timeoutMsg: "保存确认窗没有渲染出限高布局，或确认按钮被挤出视口" },
    );
    const initial = state as unknown as SaveWindowState;
    expect(initial.panelTop).toBeGreaterThanOrEqual(0);
    expect(initial.panelBottom).toBeLessThanOrEqual(initial.viewportHeight);
    expect(initial.panelBottom - initial.panelTop).toBeLessThanOrEqual(
      Math.min(initial.viewportHeight * 0.72, PANEL_CAP_REM_PX) + 1,
    );
    expect(initial.verticalScrollers).toEqual(["scroll-area"]);

    // 2) 折叠：说明与 whenToUse 各有「展开」，实参只显示前 8 行。
    expect(initial.clampToggles).toBe(2);
    expect(initial.argRows).toBe(ARGS_PREVIEW_ROWS);

    // 3) 键盘：焦点起在第一个选项上；Shift+Tab 离开选项循环，落到滚动区最后一个控件（脚本开关），
    //    再一次到「显示全部」，回车展开全部实参。
    const readFocus = () =>
      browser.execute((areaSelector: string) => {
        const active = document.activeElement;
        return {
          inArea: Boolean(active?.closest(areaSelector)),
          isOption: active?.getAttribute("role") === "option",
          text: active?.textContent?.trim() ?? "",
        };
      }, SCROLL_AREA);
    await browser.waitUntil(async () => (await readFocus()).isOption, {
      timeout: 5000,
      timeoutMsg: "保存确认窗打开后焦点不在选项上",
    });
    await browser.keys(["Shift", "Tab"]);
    const onScript = await readFocus();
    expect(onScript.inArea).toBe(true);
    expect(onScript.text).toContain("显示完整脚本");
    await browser.keys(["Shift", "Tab"]);
    const onShowAll = await readFocus();
    expect(onShowAll.inArea).toBe(true);
    expect(onShowAll.text).toContain(`显示全部 ${ARGS_TOTAL} 个参数`);
    await browser.keys(["Enter"]);

    // 4) 再展开脚本：仍只有一个纵向滚动区，窗口不变高，确认仍点得到。
    const scriptToggle = await $("button*=显示完整脚本");
    await scriptToggle.click();
    // 失败日志中脚本展开动画使 scrollHeight 从 2589 继续增长到 2604，旧终点因此失效。
    // 等对应内容的真实展开动画完成后再量尺寸，不能用固定暂停或放宽滚动隔离断言。
    await browser.waitUntil(
      () =>
        browser.execute((areaSelector: string) => {
          const content = document.querySelector(
            `${areaSelector} [data-slot="collapsible-content"][data-state="open"]`,
          );
          return (
            Boolean(content) &&
            content!
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState === "finished")
          );
        }, SCROLL_AREA),
      { timeout: 15000, timeoutMsg: "脚本展开动画未完成，不能测量滚动终点" },
    );
    await browser.waitUntil(
      async () => {
        state = await readSaveWindowState();
        return state !== null && state.argRows === ARGS_TOTAL;
      },
      { timeout: 15000, timeoutMsg: "键盘回车「显示全部」后实参没有全部展开" },
    );
    const expanded = state as unknown as SaveWindowState;
    expect(expanded.verticalScrollers).toEqual(["scroll-area"]);
    expect(expanded.panelBottom - expanded.panelTop).toBeLessThanOrEqual(
      Math.min(expanded.viewportHeight * 0.72, PANEL_CAP_REM_PX) + 1,
    );
    expect(expanded.confirmHit).toBe(true);

    // 5) 滚轮：从顶部开始，指针在滚动区上滚一次，滚动区按滚动量移动，窗口外的滚动容器纹丝不动。
    await browser.execute((areaSelector: string) => {
      const area = document.querySelector(areaSelector);
      if (area) area.scrollTop = 0;
    }, SCROLL_AREA);
    const before = await readSaveWindowState();
    await wheelOverScrollArea(600);
    await browser.waitUntil(async () => ((await readSaveWindowState())?.areaScrollTop ?? 0) > 0, {
      timeout: 5000,
      timeoutMsg: "滚轮没有滚动保存确认窗的滚动区",
    });
    const afterWheel = await readSaveWindowState();
    expect(afterWheel?.outsideScrollTops).toEqual(before?.outsideScrollTops);

    // 6) 粘性表头：把实参表滚到中段，表头贴住滚动区上沿。
    await browser.execute((areaSelector: string) => {
      const area = document.querySelector(areaSelector);
      const row = area?.querySelector('[data-workflow-save-arg="arg20"]');
      if (area && row) {
        area.scrollTop += row.getBoundingClientRect().top - area.getBoundingClientRect().top;
      }
    }, SCROLL_AREA);
    const midTable = await readSaveWindowState();
    expect(midTable?.argsHeaderTop).not.toBeNull();
    expect(Math.abs((midTable?.argsHeaderTop ?? 0) - (midTable?.areaTop ?? 0))).toBeLessThanOrEqual(
      1,
    );

    // 7) 滚到底再滚：手势停在滚动区里，不链到对话时间线。
    await browser.execute((areaSelector: string) => {
      const area = document.querySelector(areaSelector);
      if (area) area.scrollTop = area.scrollHeight;
    }, SCROLL_AREA);
    const atEnd = await readSaveWindowState();
    await wheelOverScrollArea(600);
    const pastEnd = await readSaveWindowState();
    expect(pastEnd?.areaScrollTop).toBe(atEnd?.areaScrollTop);
    expect(pastEnd?.outsideScrollTops).toEqual(atEnd?.outsideScrollTops);

    // 8) 矮屏：内容区降到 36rem 以下，钉底的选项、反馈与确认可能高过上限，整窗退回唯一的滚动区，
    //    选项随内容滚动；滚到底确认按钮点得到。之后恢复原尺寸。
    const originalSize = await browser.electron.execute((electron, shortHeight: number) => {
      const win = electron.BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
      // getContentSize 恒为 [宽, 高]；Electron 的类型只写成 number[]。
      const [width, height] = win.getContentSize() as [number, number];
      win.setMinimumSize(320, 400);
      win.setContentSize(width, shortHeight);
      return { width, height };
    }, SHORT_VIEWPORT_PX);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerHeight)) === SHORT_VIEWPORT_PX,
      { timeout: 10000, timeoutMsg: "窗口没有缩到矮屏高度" },
    );
    const short = await readSaveWindowState();
    expect(short?.verticalScrollers).toEqual(["panel"]);
    expect((short?.panelBottom ?? 0) - (short?.panelTop ?? 0)).toBeLessThanOrEqual(
      SHORT_VIEWPORT_PX * 0.72 + 1,
    );
    await browser.execute((panelSelector: string) => {
      const panel = document.querySelector(panelSelector);
      if (panel) panel.scrollTop = panel.scrollHeight;
    }, PANEL);
    expect((await readSaveWindowState())?.confirmHit).toBe(true);
    await browser.electron.execute((electron, size: { width: number; height: number }) => {
      const win = electron.BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
      win.setContentSize(size.width, size.height);
    }, originalSize);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerHeight)) === originalSize.height,
      { timeout: 10000, timeoutMsg: "窗口没有恢复原尺寸" },
    );

    // 9) 拒绝：不写盘，turn 收口。
    await denyV4PermissionWithFeedback("先不保存");
    await waitForV4TimelineContaining(FINAL_MARKER, 60000);
    await expect(access(SAVED_FILE)).rejects.toThrow();
  });
});
