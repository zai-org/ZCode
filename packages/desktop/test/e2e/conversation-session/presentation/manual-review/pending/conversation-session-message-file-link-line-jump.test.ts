import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_PREVIEW_PANE, TID_SIDE_PANE_TOGGLE } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

// 规格：docs/ui/preview-pane.md「带行号的文件链接」；用例 MFL01（单行）、MFL02（区间与多段）。
const MARKER = "E2E_MESSAGE_FILE_LINK_LINE_JUMP";
const CASE_RELATIVE_ROOT = "file-link-line-jump-e2e";
const CASE_ROOT = join(DEFAULT_WORKSPACE, CASE_RELATIVE_ROOT);
const SAMPLE_FILE = join(CASE_ROOT, "sample.ts");
const SAMPLE_LINE_COUNT = 150;
const PREVIEW_PANE = `[data-testid="${TID_PREVIEW_PANE}"]`;
const SIDE_PANE_TOGGLE = `[data-testid="${TID_SIDE_PANE_TOGGLE}"]`;

/** 正文链接文案与 fixture 中的 Markdown 一一对应。 */
const LINKS = {
  colonLine: "FLJ colon 42",
  hashLine: "FLJ hash 80",
  lineColumn: "FLJ line column 100",
  noLine: "FLJ no line",
  outOfRange: "FLJ out of range",
} as const;

/** MFL02 区间与多段链接文案，与 fixture 中的 Markdown 一一对应。 */
const RANGE_LINKS = {
  colonRange: "FLR colon 30-35",
  hashRange: "FLR hash L30-L35",
  hashRangeShortEnd: "FLR hash L30-35",
  hashTallRange: "FLR hash L60-L140",
  colonPastEnd: "FLR colon 140-999",
  colonMultiLine: "FLR colon 30,40",
  colonMultiRange: "FLR colon 30-35,40-42",
  colonReversed: "FLR reversed 35-30",
  colonAllOutOfRange: "FLR out of range 9999-10000",
} as const;

/** 区间链接的滚动断言：整体放得下就居中；放不下时起始行置顶；贴近文件末尾时只要求整段可见。 */
type RangeScrollExpectation = "center" | "top" | "visible";

interface PreviewRangeState {
  ready: boolean;
  scrollTop: number;
  clientHeight: number;
  lineHeight: number;
  /** 期望区间首行顶部、末行底部相对滚动容器可视区顶部的偏移（像素）；行不存在时为 null。 */
  spanTop: number | null;
  spanBottom: number | null;
  /** 代码行背景色与普通行不同的行号，即视觉上被高亮的行。 */
  highlightedLines: number[];
  /** 被高亮行的「代码背景色|行号背景色|行号文字色」去重集合；多段与单行高亮视觉一致时只有 1 种。 */
  highlightStyles: string[];
  codeViewerTabCount: number;
  errorText: string;
}

interface PreviewLineState {
  ready: boolean;
  scrollTop: number;
  clientHeight: number;
  /** 目标行中心相对滚动容器可视区中心的偏移（像素）；目标行不存在时为 null。 */
  centerOffset: number | null;
  lineHeight: number;
  selectedLines: number[];
  codeViewerTabCount: number;
  errorText: string;
}

describe("消息正文带行号的文件链接定位", () => {
  after(async () => {
    await rm(CASE_ROOT, { recursive: true, force: true });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MFL01: 三种行号写法居中高亮、同文件再次点击重新定位、重新挂载不回跳、无行号与超出行数停在开头", async () => {
    await prepareSampleFile();
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${MARKER}: reply with file links to ${CASE_RELATIVE_ROOT}/sample.ts.`);
    await waitForV4AssistantMessageContaining(`${MARKER}_DONE`, 90_000);
    await waitForV4Pane(
      (pane) => !pane.canStop && pane.timelineText.includes(`${MARKER}_DONE`),
      "带行号文件链接夹具回复没有完成",
      90_000,
    );

    // `a.ts:42`：首次打开预览，第 42 行居中并高亮。
    await clickBodyFileLink(LINKS.colonLine);
    await waitForFocusedLine(42);

    // 一次点击只定位一次：用户手动滚到文件末尾后，折叠再展开侧边面板让 CodeViewer 重新挂载，
    // 预览不能被拉回第 42 行；第 42 行的高亮保留。
    await scrollPreviewToBottom();
    await toggleSidePane();
    await waitForPreviewHidden();
    await toggleSidePane();
    await waitForNotRefocused(42);

    // 再点同一个 `:42` 链接：新的点击重新定位到第 42 行。
    await clickBodyFileLink(LINKS.colonLine);
    await waitForFocusedLine(42);

    // 预览已打开，点同文件 `#L80`：复用同一个 tab，并跳到新行。
    await clickBodyFileLink(LINKS.hashLine);
    await waitForFocusedLine(80);

    // `a.ts:100:5`：列号只解析不定位，效果与 `:100` 相同。
    await clickBodyFileLink(LINKS.lineColumn);
    await waitForFocusedLine(100);

    // 无行号：从开头显示，不高亮任何行。
    await clickBodyFileLink(LINKS.noLine);
    await waitForStaysAtTop("无行号链接");

    // 行号超出文件行数：先跳到一个有效行，确认超出行数时会回到开头而不是停在旧位置。
    await clickBodyFileLink(LINKS.colonLine);
    await waitForFocusedLine(42);
    await clickBodyFileLink(LINKS.outOfRange);
    await waitForStaysAtTop("超出行数链接");
  }).timeout(240_000);

  it("MFL02: 行号区间与多段整段高亮，放得下居中、放不下起始行置顶，超出部分截断或丢弃", async () => {
    await prepareSampleFile();
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${MARKER}: reply with file links to ${CASE_RELATIVE_ROOT}/sample.ts.`);
    await waitForV4AssistantMessageContaining(`${MARKER}_DONE`, 90_000);
    await waitForV4Pane(
      (pane) => !pane.canStop && pane.timelineText.includes(`${MARKER}_DONE`),
      "带行号区间文件链接夹具回复没有完成",
      90_000,
    );

    // `a.ts:30-35`：首次打开预览，第 30～35 行整段高亮并居中。
    await clickBodyFileLink(RANGE_LINKS.colonRange);
    await waitForFocusedRange(range(30, 35), 30, 35, "center");

    // `#L60-L140` 共 81 行，超过可视区：起始行 60 置顶。
    await clickBodyFileLink(RANGE_LINKS.hashTallRange);
    await waitForFocusedRange(range(60, 140), 60, 140, "top");

    // `#L30-L35` 与 `:30-35` 效果相同；中间隔一个不同位置，证明是重新定位而不是停在旧位置。
    await clickBodyFileLink(RANGE_LINKS.hashRange);
    await waitForFocusedRange(range(30, 35), 30, 35, "center");

    // `:140-999` 结束行超出文件末尾，截到最后一行 150。
    await clickBodyFileLink(RANGE_LINKS.colonPastEnd);
    await waitForFocusedRange(range(140, SAMPLE_LINE_COUNT), 140, SAMPLE_LINE_COUNT, "visible");

    // `#L30-35`（结束行不带 L）与 `#L30-L35` 相同。
    await clickBodyFileLink(RANGE_LINKS.hashRangeShortEnd);
    await waitForFocusedRange(range(30, 35), 30, 35, "center");

    // `:30,40` 多段：两行都高亮，从首段起始到末段结束整体居中。
    await clickBodyFileLink(RANGE_LINKS.colonMultiLine);
    await waitForFocusedRange([30, 40], 30, 40, "center");

    // `:30-35,40-42` 多段区间：所有段都高亮，段间的 36～39 不高亮。
    await clickBodyFileLink(RANGE_LINKS.colonMultiRange);
    await waitForFocusedRange([...range(30, 35), ...range(40, 42)], 30, 42, "center");

    // `:35-30` 结束行小于起始行：按单行起始行 35 处理。
    await clickBodyFileLink(RANGE_LINKS.colonReversed);
    await waitForFocusedRange([35], 35, 35, "center");

    // `:9999-10000` 所有段都超出行数：停在开头，不高亮，不报错。
    await clickBodyFileLink(RANGE_LINKS.colonAllOutOfRange);
    await waitForRangeStaysAtTop("全部段超出行数的区间链接");
  }).timeout(240_000);
});

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

async function prepareSampleFile() {
  await rm(CASE_ROOT, { recursive: true, force: true });
  await mkdir(CASE_ROOT, { recursive: true });
  const lines = Array.from(
    { length: SAMPLE_LINE_COUNT },
    (_, index) =>
      `export const flj_line_${String(index + 1).padStart(3, "0")} = "FLJ_LINE_${index + 1}";`,
  );
  await writeFile(SAMPLE_FILE, `${lines.join("\n")}\n`, "utf8");
}

async function clickBodyFileLink(label: string) {
  // 前一个用例的会话可能仍隐藏挂在 DOM 里，有同名链接；只点当前可见的那个。
  let link: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$(`button=${label}`)) {
        if (await candidate.isDisplayed()) {
          link = candidate;
          return true;
        }
      }
      return false;
    },
    { timeout: 30_000, timeoutMsg: `没有可见的文件链接 ${label}` },
  );
  if (!link) throw new Error(`没有可见的文件链接 ${label}`);
  await link.waitForStable();
  await link.waitForClickable();
  await link.click();
}

async function readPreviewLineState(targetLine: number | null): Promise<PreviewLineState> {
  return browser.execute(
    (paneSelector, line) => {
      const empty = {
        ready: false,
        scrollTop: -1,
        clientHeight: 0,
        centerOffset: null,
        lineHeight: 0,
        selectedLines: [] as number[],
        codeViewerTabCount: 0,
        errorText: "",
      };
      const codeViewerTabCount = document.querySelectorAll(
        '[data-side-pane-tab-id^="code-viewer:"]',
      ).length;
      const pane = document.querySelector<HTMLElement>(paneSelector);
      if (!pane) return { ...empty, codeViewerTabCount };
      const errorText =
        pane.querySelector<HTMLElement>(".text-destructive, .text-warning")?.textContent ?? "";
      const container = pane.querySelector<HTMLElement>("div[data-language]");
      if (!container) return { ...empty, codeViewerTabCount, errorText };

      // CodeViewer 的代码行渲染在 @pierre/diffs 的 Shadow DOM 中，与 findCodeViewerLineElement 同口径遍历。
      const roots: ParentNode[] = [container];
      for (let index = 0; index < roots.length; index += 1) {
        for (const element of roots[index]!.querySelectorAll<HTMLElement>("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      const find = (selector: string) => {
        for (const root of roots) {
          const found = root.querySelector<HTMLElement>(selector);
          if (found) return found;
        }
        return null;
      };
      const selectedLines = new Set<number>();
      for (const root of roots) {
        for (const element of root.querySelectorAll<HTMLElement>(
          "[data-line][data-selected-line]",
        )) {
          selectedLines.add(Number(element.getAttribute("data-line")));
        }
      }
      const firstLine = find('[data-line="1"]');
      const target = line === null ? null : find(`[data-line="${line}"]`);
      const containerRect = container.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      return {
        ready: Boolean(firstLine),
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        centerOffset: targetRect
          ? targetRect.top +
            targetRect.height / 2 -
            (containerRect.top + container.clientHeight / 2)
          : null,
        lineHeight: targetRect?.height ?? firstLine?.getBoundingClientRect().height ?? 0,
        selectedLines: [...selectedLines].sort((left, right) => left - right),
        codeViewerTabCount,
        errorText: errorText.trim(),
      };
    },
    PREVIEW_PANE,
    targetLine,
  );
}

async function waitForFocusedLine(line: number) {
  let state: PreviewLineState | null = null;
  await browser
    .waitUntil(
      async () => {
        state = await readPreviewLineState(line);
        return (
          state.ready &&
          state.scrollTop > 0 &&
          state.centerOffset !== null &&
          // 目标行中心与可视区中心的偏差不超过两行高度，即「在可视区中部」。
          Math.abs(state.centerOffset) <= Math.max(state.lineHeight * 2, 24) &&
          state.selectedLines.length === 1 &&
          state.selectedLines[0] === line
        );
      },
      { timeout: 20_000, interval: 200 },
    )
    .catch(() => {
      throw new Error(`第 ${line} 行没有居中高亮: ${JSON.stringify(state)}`);
    });
  // 同一文件始终复用一个预览 tab。
  expect(state!.codeViewerTabCount).toBe(1);
  expect(state!.errorText).toBe("");
}

async function scrollPreviewToBottom() {
  await browser.execute((paneSelector) => {
    const container = document
      .querySelector<HTMLElement>(paneSelector)
      ?.querySelector<HTMLElement>("div[data-language]");
    if (!container) throw new Error("预览滚动容器不存在");
    container.scrollTop = container.scrollHeight;
  }, PREVIEW_PANE);
  let state: PreviewLineState | null = null;
  await browser
    .waitUntil(
      async () => {
        state = await readPreviewLineState(SAMPLE_LINE_COUNT);
        // 最后一行落在可视区下半部，即已滚到末尾。
        return (
          state.ready &&
          state.centerOffset !== null &&
          state.centerOffset > 0 &&
          state.centerOffset <= state.clientHeight / 2
        );
      },
      { timeout: 10_000, interval: 200 },
    )
    .catch(() => {
      throw new Error(`预览没有滚到文件末尾: ${JSON.stringify(state)}`);
    });
}

async function toggleSidePane() {
  let toggle: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$(SIDE_PANE_TOGGLE)) {
        if (await candidate.isDisplayed()) {
          toggle = candidate;
          return true;
        }
      }
      return false;
    },
    { timeout: 10_000, timeoutMsg: "没有可见的侧边面板开关" },
  );
  if (!toggle) throw new Error("没有可见的侧边面板开关");
  await toggle.click();
}

async function waitForPreviewHidden() {
  // 折叠后预览的代码内容卸载或不可见；再展开时 CodeViewer 会重新挂载。
  await browser.waitUntil(
    async () =>
      browser.execute((paneSelector) => {
        const container = document
          .querySelector<HTMLElement>(paneSelector)
          ?.querySelector<HTMLElement>("div[data-language]");
        return !container || container.getClientRects().length === 0;
      }, PREVIEW_PANE),
    { timeout: 10_000, interval: 200, timeoutMsg: "折叠侧边面板后预览仍可见" },
  );
}

async function waitForNotRefocused(line: number) {
  let state: PreviewLineState | null = null;
  let stableSamples = 0;
  // 连续多次采样：目标行都不在可视区中部，且高亮仍在，才算没有被旧的定位请求拉回。
  await browser
    .waitUntil(
      async () => {
        state = await readPreviewLineState(line);
        const refocused =
          state.centerOffset !== null &&
          Math.abs(state.centerOffset) <= Math.max(state.lineHeight * 2, 24);
        const ok =
          state.ready &&
          !refocused &&
          state.selectedLines.length === 1 &&
          state.selectedLines[0] === line;
        stableSamples = ok ? stableSamples + 1 : 0;
        return stableSamples >= 10;
      },
      { timeout: 20_000, interval: 150 },
    )
    .catch(() => {
      throw new Error(`重新挂载后预览被拉回第 ${line} 行或高亮丢失: ${JSON.stringify(state)}`);
    });
  expect(state!.codeViewerTabCount).toBe(1);
  expect(state!.errorText).toBe("");
}

async function waitForStaysAtTop(label: string) {
  let state: PreviewLineState | null = null;
  let stableSamples = 0;
  // 连续多次采样都停在开头才算通过，防止旧的定位请求在内容渲染后又把容器滚走。
  await browser
    .waitUntil(
      async () => {
        state = await readPreviewLineState(null);
        const atTop = state.ready && state.scrollTop === 0 && state.selectedLines.length === 0;
        stableSamples = atTop ? stableSamples + 1 : 0;
        return stableSamples >= 8;
      },
      { timeout: 20_000, interval: 150 },
    )
    .catch(() => {
      throw new Error(`${label} 没有停在开头: ${JSON.stringify(state)}`);
    });
  expect(state!.codeViewerTabCount).toBe(1);
  expect(state!.errorText).toBe("");
}

async function readPreviewRangeState(
  spanStartLine: number | null,
  spanEndLine: number | null,
): Promise<PreviewRangeState> {
  return browser.execute(
    (paneSelector, startLine, endLine) => {
      const empty = {
        ready: false,
        scrollTop: -1,
        clientHeight: 0,
        lineHeight: 0,
        spanTop: null,
        spanBottom: null,
        highlightedLines: [] as number[],
        highlightStyles: [] as string[],
        codeViewerTabCount: 0,
        errorText: "",
      };
      // 前一个用例的会话仍隐藏挂在 DOM 里，只看当前可见的预览面板和 tab。
      const isVisible = (element: Element) => element.getClientRects().length > 0;
      const codeViewerTabCount = [
        ...document.querySelectorAll('[data-side-pane-tab-id^="code-viewer:"]'),
      ].filter(isVisible).length;
      const pane = [...document.querySelectorAll<HTMLElement>(paneSelector)].find(isVisible);
      if (!pane) return { ...empty, codeViewerTabCount };
      const errorText =
        pane.querySelector<HTMLElement>(".text-destructive, .text-warning")?.textContent ?? "";
      const container = pane.querySelector<HTMLElement>("div[data-language]");
      if (!container) return { ...empty, codeViewerTabCount, errorText };

      const roots: ParentNode[] = [container];
      for (let index = 0; index < roots.length; index += 1) {
        for (const element of roots[index]!.querySelectorAll<HTMLElement>("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      const codeLines = new Map<number, HTMLElement>();
      const gutterLines = new Map<number, HTMLElement>();
      for (const root of roots) {
        for (const element of root.querySelectorAll<HTMLElement>("[data-line]")) {
          if (element.hasAttribute("data-column-number")) continue;
          codeLines.set(Number(element.getAttribute("data-line")), element);
        }
        for (const element of root.querySelectorAll<HTMLElement>("[data-column-number]")) {
          gutterLines.set(Number(element.getAttribute("data-column-number")), element);
        }
      }
      // 高亮按真实视觉判定：以第 1 行（所有用例都不高亮它）的背景色为普通行基准，与之不同即为被高亮。
      // 这样同时覆盖 @pierre/diffs 原生选中行与额外段，并能检查两者视觉是否一致。
      const firstLineElement = codeLines.get(1);
      const normalBackground = firstLineElement
        ? getComputedStyle(firstLineElement).backgroundColor
        : "";
      const backgrounds = new Map<number, string>();
      for (const [line, element] of codeLines) {
        backgrounds.set(line, getComputedStyle(element).backgroundColor);
      }
      const highlightedLines: number[] = [];
      const highlightStyles = new Set<string>();
      for (const [line, background] of backgrounds) {
        if (background === normalBackground) continue;
        highlightedLines.push(line);
        const gutter = gutterLines.get(line);
        const gutterStyle = gutter ? getComputedStyle(gutter) : null;
        highlightStyles.add(
          `${background}|${gutterStyle?.backgroundColor ?? ""}|${gutterStyle?.color ?? ""}`,
        );
      }
      const containerTop = container.getBoundingClientRect().top;
      const startRect =
        startLine === null ? null : codeLines.get(startLine)?.getBoundingClientRect();
      const endRect = endLine === null ? null : codeLines.get(endLine)?.getBoundingClientRect();
      return {
        ready: codeLines.has(1),
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        lineHeight: startRect?.height ?? codeLines.get(1)?.getBoundingClientRect().height ?? 0,
        spanTop: startRect ? startRect.top - containerTop : null,
        spanBottom: endRect ? endRect.bottom - containerTop : null,
        highlightedLines: highlightedLines.sort((left, right) => left - right),
        highlightStyles: [...highlightStyles],
        codeViewerTabCount,
        errorText: errorText.trim(),
      };
    },
    PREVIEW_PANE,
    spanStartLine,
    spanEndLine,
  );
}

function isRangeScrollSatisfied(state: PreviewRangeState, expectation: RangeScrollExpectation) {
  if (state.spanTop === null || state.spanBottom === null) return false;
  const tolerance = Math.max(state.lineHeight * 2, 24);
  if (expectation === "top") return Math.abs(state.spanTop) <= tolerance;
  if (expectation === "visible") {
    return state.spanTop >= 0 && state.spanBottom <= state.clientHeight + 1;
  }
  const spanCenter = (state.spanTop + state.spanBottom) / 2;
  return Math.abs(spanCenter - state.clientHeight / 2) <= tolerance;
}

async function waitForFocusedRange(
  expectedLines: number[],
  spanStartLine: number,
  spanEndLine: number,
  expectation: RangeScrollExpectation,
) {
  let state: PreviewRangeState | null = null;
  await browser
    .waitUntil(
      async () => {
        state = await readPreviewRangeState(spanStartLine, spanEndLine);
        return (
          state.ready &&
          state.scrollTop > 0 &&
          isRangeScrollSatisfied(state, expectation) &&
          // 区间内每一行都高亮，区间外没有；所有段的高亮视觉一致。
          state.highlightedLines.join(",") === expectedLines.join(",") &&
          state.highlightStyles.length === 1
        );
      },
      { timeout: 20_000, interval: 200 },
    )
    .catch(() => {
      throw new Error(
        `第 ${spanStartLine}～${spanEndLine} 行没有按 ${expectation} 定位并高亮 ${expectedLines.join(",")}: ${JSON.stringify(state)}`,
      );
    });
  expect(state!.codeViewerTabCount).toBe(1);
  expect(state!.errorText).toBe("");
}

async function waitForRangeStaysAtTop(label: string) {
  let state: PreviewRangeState | null = null;
  let stableSamples = 0;
  await browser
    .waitUntil(
      async () => {
        state = await readPreviewRangeState(null, null);
        const atTop = state.ready && state.scrollTop === 0 && state.highlightedLines.length === 0;
        stableSamples = atTop ? stableSamples + 1 : 0;
        return stableSamples >= 8;
      },
      { timeout: 20_000, interval: 150 },
    )
    .catch(() => {
      throw new Error(`${label} 没有停在开头: ${JSON.stringify(state)}`);
    });
  expect(state!.codeViewerTabCount).toBe(1);
  expect(state!.errorText).toBe("");
}
