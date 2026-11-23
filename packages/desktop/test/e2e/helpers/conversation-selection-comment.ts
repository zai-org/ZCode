import { TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";

const MAIN_PANE = testId(TID_V4_SESSION_PANE, "workspace-main");

/** 读取主时间线中目标文字的首尾坐标；表格单元格等整段匹配的文本节点优先。 */
function locateTimelineText(paneTestId: string, targetText: string, scroll: boolean) {
  const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
  if (!pane) throw new Error("缺少主 pane");
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  let found: { node: Node; offset: number } | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? "";
    const offset = value.indexOf(targetText);
    if (offset < 0 || !node.parentElement?.closest("[data-row-id]")) continue;
    found ??= { node, offset };
    if (value.trim() === targetText) {
      found = { node, offset };
      break;
    }
  }
  if (!found) throw new Error(`主时间线缺少选区文本: ${targetText}`);
  if (scroll) found.node.parentElement?.scrollIntoView({ block: "center", behavior: "instant" });
  const range = document.createRange();
  range.setStart(found.node, found.offset);
  range.setEnd(found.node, found.offset + 1);
  const first = range.getBoundingClientRect();
  range.setStart(found.node, found.offset + targetText.length - 1);
  range.setEnd(found.node, found.offset + targetText.length);
  const last = range.getBoundingClientRect();
  return {
    x1: Math.ceil(first.left),
    y1: Math.round(first.top + first.height / 2),
    x2: Math.floor(last.right),
    y2: Math.round(last.top + last.height / 2),
  };
}

/**
 * 真实 pointer 拖选主时间线文字，并等待选区浮层出现。
 * scroll=false 时不滚动目标：回答输出过程中滚动会让时间线退出“跟随到底”，改变被测场景。
 */
export async function dragSelectMainTimelineText(
  text: string,
  options: { scroll?: boolean } = {},
): Promise<void> {
  if (options.scroll !== false) await browser.execute(locateTimelineText, MAIN_PANE, text, true);
  // 回答输出时时间线会跟随滚动，定位坐标与按下鼠标之间文字可能已经移动；没选中就重新定位再拖。
  let actual = "";
  let position = { x1: 0, y1: 0, x2: 0, y2: 0 };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 上一次动作可能保留选区；在旧选区上拖动会变成 HTML 拖放，而不是重新划词。
    await browser.execute(() => window.getSelection()?.removeAllRanges());
    position = await browser.execute(locateTimelineText, MAIN_PANE, text, false);
    await browser.performActions([
      {
        type: "pointer",
        id: "selection-comment-drag",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: position.x1, y: position.y1, duration: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", x: position.x2, y: position.y2, duration: 200 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    actual = await browser.execute(() => window.getSelection()?.toString() ?? "");
    if (actual === text) break;
  }
  if (actual !== text) {
    throw new Error(
      `真实拖选未选中目标文本: ${text}; 实际选区=${JSON.stringify(actual)} 坐标=${JSON.stringify(position)}`,
    );
  }
  await $("[data-conversation-selection-tooltip]").waitForDisplayed({ timeout: 5000 });
}

/** 真实 pointer 从 startText 的首字拖到 endText 的末字（可跨段落、代码块），并等待选区浮层出现。 */
export async function dragSelectMainTimelineRange(
  startText: string,
  endText: string,
): Promise<void> {
  await browser.execute(() => window.getSelection()?.removeAllRanges());
  await browser.execute(locateTimelineText, MAIN_PANE, startText, true);
  const start = await browser.execute(locateTimelineText, MAIN_PANE, startText, false);
  const end = await browser.execute(locateTimelineText, MAIN_PANE, endText, false);
  await browser.performActions([
    {
      type: "pointer",
      id: "selection-comment-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: start.x1, y: start.y1, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: end.x2, y: end.y2, duration: 300 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  await browser.waitUntil(
    () =>
      browser.execute(
        (first, last) => {
          const selected = window.getSelection()?.toString() ?? "";
          return selected.startsWith(first) && selected.endsWith(last);
        },
        startText,
        endText,
      ),
    { timeout: 5000, timeoutMsg: `真实拖选未选中范围: ${startText} → ${endText}` },
  );
  await $("[data-conversation-selection-tooltip]").waitForDisplayed({ timeout: 5000 });
}

/** 浮层可能在 selectionchange/rAF 中重挂载；检查与点击合成一次原子脚本并整体重试。 */
export async function clickSelectionAction(
  action: "comment" | "add-to-task" | "ask-in-side-chat",
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextAction) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-conversation-selection-action="${nextAction}"]`,
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, action),
    { timeout: 30000, timeoutMsg: `划词动作不可用: ${action}` },
  );
}

/** 在批注浮层里用真实键盘输入批注。 */
export async function typeSelectionComment(comment: string): Promise<void> {
  const input = await $("[data-conversation-selection-comment-input]");
  await input.waitForDisplayed({ timeout: 5000 });
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.activeElement?.hasAttribute("data-conversation-selection-comment-input") ===
          true,
      ),
    { timeout: 5000, timeoutMsg: "批注输入框没有自动获得焦点" },
  );
  await browser.keys(comment.split(""));
  await browser.waitUntil(async () => (await input.getValue()) === comment, {
    timeout: 5000,
    timeoutMsg: "批注输入在键入过程中被清空或浮层被关闭",
  });
}

/** 主 composer 的引用 chip 状态：引用条数与 aria-label（含批注数）。 */
export async function readMainComposerSelectionChip(): Promise<{
  count: number | null;
  label: string | null;
}> {
  return browser.execute((paneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
    const chips = Array.from(
      pane?.querySelectorAll<HTMLElement>("[data-conversation-selection-reference-count]") ?? [],
    ).filter((chip) => !chip.closest("[data-row-id]"));
    const chip = chips.at(-1);
    if (!chip) return { count: null, label: null };
    return {
      count: Number(chip.dataset.conversationSelectionReferenceCount),
      label: chip.getAttribute("aria-label"),
    };
  }, MAIN_PANE);
}

/** 主时间线正文里的注释编号标记（含已发送的灰色标记），按编号排序。 */
export async function readMainTimelineAnnotationMarks(): Promise<
  { number: number; variant: string }[]
> {
  return browser.execute((paneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
    return Array.from(
      pane?.querySelectorAll<HTMLElement>(
        "[data-conversation-annotation-marks] [data-annotation-number-variant]",
      ) ?? [],
    )
      .map((mark) => ({
        number: Number(mark.textContent),
        variant: mark.dataset.annotationNumberVariant ?? "",
      }))
      .sort((a, b) => a.number - b.number || a.variant.localeCompare(b.variant));
  }, MAIN_PANE);
}

/** 点正文里第 n 号注释气泡，等待编辑浮层出现。 */
export async function openMainTimelineAnnotation(number: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (paneTestId, target) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
          const button = pane?.querySelector<HTMLButtonElement>(
            `[data-annotation-mark-number="${target}"]`,
          );
          if (!button) return false;
          button.click();
          return true;
        },
        MAIN_PANE,
        number,
      ),
    { timeout: 10000, timeoutMsg: `正文里没有第 ${number} 号注释标记` },
  );
  await $('[data-conversation-selection-comment-mode="edit"]').waitForDisplayed({ timeout: 5000 });
}
