import { join } from "node:path";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  clickSelectionAction,
  dragSelectMainTimelineRange,
  dragSelectMainTimelineText,
  readMainComposerSelectionChip,
  readMainTimelineAnnotationMarks,
  typeSelectionComment,
} from "#e2e/helpers/conversation-selection-comment";
import {
  countUpstreamRequests,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { ensureReadonlyToolFixtureFile } from "#e2e/helpers/conversation-session-readonly-tool";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const artifacts = () => process.env.ZCODE_E2E_ARTIFACT_DIR!;
const HISTORY_PARA = "E2E_SCS_HISTORY_PARA";
const LIVE_PARA = "E2E_SCS_LIVE_PARA";
const COMMENT = "E2E_SCS_COMMENT";
const CROSS_START = "E2E_SCS_CROSS_START";
const CROSS_END = "E2E_SCS_CROSS_END";
const MIX_START = "E2E_SCS_MIX_START";
const MIX_END = "E2E_SCS_MIX_END";
const MATH_START = "E2E_SCS_MATH_START";
const MATH_END = "E2E_SCS_MATH_END";
const line = (index: number) => `E2E_SCS_LINE_${String(index).padStart(2, "0")}`;

interface SelectionProbeEvent {
  at: number;
  type: string;
  detail?: string;
}

/** 记录输出过程中会影响选区的运行时事件：时间线滚动、选区变化、选区所在节点被替换、浮层增删。 */
async function installSelectionProbe(): Promise<void> {
  await browser.execute(() => {
    const target = window as typeof window & { __scsProbe?: SelectionProbeEvent[] };
    if (target.__scsProbe) return;
    const events: SelectionProbeEvent[] = [];
    target.__scsProbe = events;
    const push = (type: string, detail?: string) => {
      if (events.length < 400) events.push({ at: Math.round(performance.now()), type, detail });
    };
    document.addEventListener(
      "scroll",
      (event) => {
        const element = event.target instanceof HTMLElement ? event.target : null;
        push(
          "scroll",
          `${element?.dataset.testid ?? element?.className.slice(0, 40)}@${element?.scrollTop}`,
        );
      },
      { capture: true, passive: true },
    );
    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      push(
        "selectionchange",
        selection?.isCollapsed ? "collapsed" : `len=${selection?.toString().length}`,
      );
    });
    window.addEventListener("resize", () => push("resize"));
    new MutationObserver((records) => {
      const anchor = window.getSelection()?.anchorNode ?? null;
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (
            node instanceof HTMLElement &&
            node.hasAttribute("data-conversation-selection-tooltip")
          )
            push("tooltip-removed");
          else if (anchor && node.contains(anchor)) push("anchor-removed", node.nodeName);
          else if (node instanceof HTMLElement && node.querySelector("[data-row-id]"))
            push("row-container-removed", node.className.slice(0, 60));
        }
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.hasAttribute("data-conversation-selection-tooltip")
          )
            push("tooltip-added");
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function readSelectionProbe(): Promise<SelectionProbeEvent[]> {
  return browser.execute(
    () => (window as typeof window & { __scsProbe?: SelectionProbeEvent[] }).__scsProbe ?? [],
  );
}

/**
 * 当前选区文字；浮层底边到选区顶边的距离（浮层在选区上方时接近 8px）与两者中心的水平偏差，
 * 没有浮层时为 null；以及选区是否还在时间线可视范围内。
 */
async function readSelectionState(): Promise<{
  text: string;
  tooltipGap: number | null;
  tooltipOffset: number | null;
  visible: boolean;
}> {
  return browser.execute(() => {
    const selection = window.getSelection();
    const tooltip = document.querySelector("[data-conversation-selection-tooltip]");
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect() ?? null;
    const box = tooltip?.getBoundingClientRect() ?? null;
    const timeline = document.querySelector('[data-testid="v4-timeline"]')?.getBoundingClientRect();
    return {
      text: selection?.toString() ?? "",
      tooltipGap: box && rect ? Math.round(rect.top - box.bottom) : null,
      tooltipOffset:
        box && rect
          ? Math.round(Math.abs(box.left + box.width / 2 - (rect.left + rect.width / 2)))
          : null,
      visible: Boolean(
        rect && timeline && rect.bottom > timeline.top && rect.top < timeline.bottom,
      ),
    };
  });
}

/** 浮层正对选区：在选区上方约 8px、水平居中。 */
function tooltipFollowsSelection(state: {
  tooltipGap: number | null;
  tooltipOffset: number | null;
}) {
  return (
    state.tooltipGap !== null &&
    Math.abs(state.tooltipGap) <= 24 &&
    state.tooltipOffset !== null &&
    state.tooltipOffset <= 6
  );
}

/** 在时间线上滚动真实滚轮（正数向下）。 */
async function wheelTimeline(deltaY: number): Promise<void> {
  await browser.performActions([
    {
      type: "wheel",
      id: "scs-wheel",
      actions: [{ type: "scroll", x: 700, y: 400, deltaX: 0, deltaY, duration: 50 }],
    },
  ]);
  await browser.releaseActions();
}

/** 用产品快捷键开关右侧面板（macOS ⌥⌘B，其他平台 Ctrl+Alt+B），等时间线宽度变化。 */
async function toggleSidePane(): Promise<void> {
  const width = () =>
    browser.execute(
      () =>
        document.querySelector('[data-testid="v4-timeline"]')?.getBoundingClientRect().width ?? 0,
    );
  const before = await width();
  await browser.execute(() => {
    const mac = navigator.platform.startsWith("Mac");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        altKey: true,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await browser.waitUntil(async () => Math.abs((await width()) - before) > 40, {
    timeout: 10000,
    timeoutMsg: "右侧面板开关后时间线宽度没有变化",
  });
  // 面板展开有过渡动画，等宽度稳定。
  let last = -1;
  await browser.waitUntil(
    async () => {
      const current = await width();
      const stable = current === last;
      last = current;
      return stable;
    },
    { timeout: 5000, interval: 150 },
  );
}

interface Box {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/** 正文注释标记的几何：各段下划线、编号气泡、代码块与正文栏的位置。 */
/** 把时间线里第一个代码块横向滚到指定位置，返回实际的 scrollLeft。 */
async function scrollCodeBlock(left: number): Promise<number> {
  return browser.execute((target) => {
    const shadow = document.querySelector(
      '[data-v4-timeline-message-layer="true"] diffs-container',
    )?.shadowRoot;
    for (const element of shadow?.querySelectorAll<HTMLElement>("*") ?? []) {
      if (element.scrollWidth <= element.clientWidth + 10) continue;
      element.scrollLeft = target;
      if (target === 0 || element.scrollLeft > 0) return element.scrollLeft;
    }
    return -1;
  }, left);
}

async function readAnnotationGeometry(): Promise<{
  lines: Box[];
  number: Box;
  codeBlockTop: number;
  codeBlockBottom: number;
  codeBlockWidth: number;
  columnWidth: number;
}> {
  return browser.execute(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
      };
    };
    const overlay = document.querySelector("[data-conversation-annotation-marks]");
    const code = document.querySelector("[data-row-id] diffs-container");
    const number = overlay?.querySelector("[data-annotation-number-variant]");
    if (!overlay || !code || !number) throw new Error("缺少注释标记或代码块");
    // 代码正文在 Shadow DOM 里；向上找到带圆角的代码块外壳。
    const block = code.closest(".rounded-xl") ?? code;
    return {
      lines: Array.from(overlay.querySelectorAll("[data-annotation-mark] > div")).map(box),
      number: box(number),
      codeBlockTop: box(block).top,
      codeBlockBottom: box(block).bottom,
      codeBlockWidth: box(block).width,
      columnWidth: box(code.closest("[data-row-id]")!).width,
    };
  });
}

describe("选区注释 · 回答输出过程中 manual review", () => {
  after(async () => {
    await clearAppData();
  });

  it("SCM07-09、SCM11-13: 跨代码块、Markdown 混排与公式的标记位置；浮层随滚动、侧栏、切会话的表现；回答输出过程中框选，浮层保持到完成注释", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await pinE2ELocale("zh-CN");
    await ensureReadonlyToolFixtureFile();

    await sendV4Prompt("E2E_SCS_SEED: answer briefly");
    await waitForV4AssistantMessageContaining(HISTORY_PARA, 60000);
    await waitForV4ConversationState(
      (state) => state.state === "idle" && state.activeInputId === null,
      "第一轮回答没有完成",
      60000,
    );

    // SCM08：选区从一段正文开始，跨过一整段正文和一个代码块，到下一段正文中间结束。
    await dragSelectMainTimelineRange(CROSS_START, CROSS_END);
    await clickSelectionAction("comment");
    await $("[data-conversation-selection-comment-input]").waitForDisplayed({ timeout: 5000 });
    await browser.saveScreenshot(join(artifacts(), "scm08-cross-block-pending.png"));
    const pending = await readAnnotationGeometry();
    // 正文划线已经标出原文，输入卡片不再重复显示原文。
    expect(await $("[data-conversation-selection-comment-editor]").getText()).not.toContain(
      CROSS_END,
    );
    await browser.keys("Enter");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      async () =>
        JSON.stringify((await readMainTimelineAnnotationMarks()).map((mark) => mark.variant)) ===
        JSON.stringify(["quote"]),
      { timeout: 10000, timeoutMsg: "跨块注释保存后正文没有出现空心编号" },
    );
    await browser.saveScreenshot(join(artifacts(), "scm08-cross-block-saved.png"));
    const saved = await readAnnotationGeometry();
    for (const [label, geometry] of [
      ["输入时", pending],
      ["保存后", saved],
    ] as const) {
      const last = geometry.lines.at(-1);
      const inCode = (line: Box) =>
        line.top >= geometry.codeBlockTop && line.bottom <= geometry.codeBlockBottom;
      const problems = [
        // 三段正文各一条线，被跨过的代码块里三行有字的代码各一条线（空行不画），裁在代码块
        // 宽度内；代码块语言标签不画线，整段选中的段落也不多出撑满整行的线。
        geometry.lines.length === 6 ? null : "下划线不是 6 段",
        geometry.lines.every((line) => line.width < geometry.columnWidth * 0.6 || inCode(line))
          ? null
          : "有下划线撑满整行",
        geometry.lines.filter(inCode).length === 3 ? null : "代码块里应当正好三条线",
        geometry.lines.filter(inCode).every((line) => line.width <= geometry.codeBlockWidth)
          ? null
          : "代码块里的线超出了代码块",
        // 角标贴在末行右上方：探入文字行不超过 5px，大小 18px。
        last && geometry.number.bottom - last.top <= 5 && geometry.number.width === 18
          ? null
          : "角标压住了文字行或大小不对",
      ].filter(Boolean);
      if (problems.length > 0) {
        throw new Error(
          `${label}标记位置不对（${problems.join("；")}）: ${JSON.stringify(geometry)}`,
        );
      }
    }
    await browser.execute(() => window.getSelection()?.removeAllRanges());

    // 代码块横向滚动后下划线跟着重算：滚动容器在 Shadow DOM 里，scroll 事件传不到外面。
    // 第一行很长，滚动后仍在可视范围内；后两行很短，滚出左边后不应再留线，滚回后恢复。
    const scrolled = await scrollCodeBlock(400);
    expect(scrolled).toBeGreaterThan(100);
    await browser.waitUntil(
      async () => {
        const geometry = await readAnnotationGeometry();
        return (
          geometry.lines.filter(
            (line) => line.top >= geometry.codeBlockTop && line.bottom <= geometry.codeBlockBottom,
          ).length === 1
        );
      },
      { timeout: 3000, timeoutMsg: "代码块横向滚动后，滚出可视范围的代码行还留着下划线" },
    );
    await browser.saveScreenshot(join(artifacts(), "scm08-code-scrolled.png"));
    await scrollCodeBlock(0);
    await browser.waitUntil(
      async () => {
        const geometry = await readAnnotationGeometry();
        return (
          geometry.lines.filter(
            (line) => line.top >= geometry.codeBlockTop && line.bottom <= geometry.codeBlockBottom,
          ).length === 3
        );
      },
      { timeout: 3000, timeoutMsg: "代码块滚回后代码行的下划线没有恢复" },
    );

    // SCM09：选区覆盖加粗、行内代码、有序列表和自动换行的列表项。
    await dragSelectMainTimelineRange(MIX_START, MIX_END);
    await clickSelectionAction("comment");
    await $("[data-conversation-selection-comment-input]").waitForDisplayed({ timeout: 5000 });
    await browser.keys("Enter");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => (await readMainTimelineAnnotationMarks()).length === 2, {
      timeout: 10000,
      timeoutMsg: "Markdown 混排注释保存后正文没有出现第 2 个编号",
    });
    await browser.saveScreenshot(join(artifacts(), "scm09-markdown-mix-saved.png"));
    const mix = await browser.execute(
      (startText, endText) => {
        const overlay = document.querySelector("[data-conversation-annotation-marks]")!;
        const marks = Array.from(overlay.querySelectorAll("[data-annotation-mark]")).at(-1)!;
        const lines = Array.from(marks.querySelectorAll(":scope > div")).map((line) => {
          const rect = line.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        // 期望：按选中文字本身的矩形数出视觉行，每行从第一个字到最后一个字。
        const row = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).find(
          (candidate) => candidate.textContent?.includes(startText),
        )!;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        const rows: { left: number; right: number; top: number; bottom: number }[] = [];
        let inside = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.textContent ?? "";
          const from = value.indexOf(startText);
          const to = value.indexOf(endText);
          if (!inside && from < 0) continue;
          inside = true;
          const range = document.createRange();
          range.setStart(node, from >= 0 ? from : 0);
          range.setEnd(node, to >= 0 ? to + endText.length : value.length);
          for (const rect of range.getClientRects()) {
            if (rect.width < 0.5) continue;
            const middle = (rect.top + rect.bottom) / 2;
            const hit = rows.find((item) => middle > item.top && middle < item.bottom);
            if (hit) {
              hit.left = Math.min(hit.left, rect.left);
              hit.right = Math.max(hit.right, rect.right);
            } else {
              rows.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
            }
          }
          if (to >= 0) break;
        }
        return { lines, rows };
      },
      MIX_START,
      MIX_END,
    );
    const round = (value: number) => Math.round(value);
    const mixProblems = [
      // 不断线、不双线：每个视觉行正好一条线。
      mix.lines.length === mix.rows.length
        ? null
        : `下划线 ${mix.lines.length} 段，文字 ${mix.rows.length} 行`,
      // 不缺线：每条线画到该行最后一个字；左端从第一个选中的字开始，
      // 列表项的首行（第 2、3、5 行）还要向左带上序号，与换行后的第 4 行左端对齐。
      ...mix.rows.map((row, index) => {
        const line = mix.lines.find(
          (item) =>
            (row.top + row.bottom) / 2 > item.top && (row.top + row.bottom) / 2 < item.bottom,
        );
        if (!line) return `第 ${index + 1} 行没有下划线`;
        const expectedLeft = [1, 2, 4].includes(index) ? mix.rows[3]!.left : row.left;
        return Math.abs(line.left - expectedLeft) <= 1.5 && Math.abs(line.right - row.right) <= 1.5
          ? null
          : `第 ${index + 1} 行下划线 ${round(line.left)}–${round(line.right)}，应为 ${round(expectedLeft)}–${round(row.right)}`;
      }),
    ].filter(Boolean);
    if (mixProblems.length > 0) {
      throw new Error(
        `Markdown 混排的下划线不对（${mixProblems.join("；")}）: ${JSON.stringify(mix)}`,
      );
    }

    // SCM11：选区含行内公式和独立公式。每个公式整体算一段，不能碎成一堆小线。
    await dragSelectMainTimelineRange(MATH_START, MATH_END);
    await clickSelectionAction("comment");
    await $("[data-conversation-selection-comment-input]").waitForDisplayed({ timeout: 5000 });
    await browser.keys("Enter");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => (await readMainTimelineAnnotationMarks()).length === 3, {
      timeout: 10000,
      timeoutMsg: "公式注释保存后正文没有出现第 3 个编号",
    });
    await browser.saveScreenshot(join(artifacts(), "scm11-math-saved.png"));
    const mathLines = await browser.execute(() => {
      const overlay = document.querySelector("[data-conversation-annotation-marks]")!;
      const marks = Array.from(overlay.querySelectorAll("[data-annotation-mark]")).at(-1)!;
      return Array.from(marks.querySelectorAll(":scope > div")).map((line) => {
        const rect = line.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
        };
      });
    });
    // 带行内公式的一行、独立公式、公式后的一行：正好三条线，互不重叠。
    const mathOverlap = mathLines.some((line, index) =>
      mathLines.some(
        (other, otherIndex) =>
          otherIndex > index && other.top < line.bottom && line.top < other.bottom,
      ),
    );
    // 独立公式（第 2 条）的线只有公式那么宽，不撑满整行。
    if (
      mathLines.length !== 3 ||
      mathOverlap ||
      mathLines.some((line) => line.width < 20) ||
      mathLines[1]!.width > 400
    ) {
      throw new Error(`公式处的下划线不对: ${JSON.stringify(mathLines)}`);
    }
    await browser.execute(() => window.getSelection()?.removeAllRanges());

    // SCM12：框选后浮层的位置与消失。
    await dragSelectMainTimelineText(HISTORY_PARA);
    expect(tooltipFollowsSelection(await readSelectionState())).toBe(true);
    // ① 滚到选区离开可视范围：浮层隐藏，选区还在；滚回来浮层重新出现并对准选区。
    await browser.waitUntil(
      async () => {
        if (!(await readSelectionState()).visible) return true;
        await wheelTimeline(240);
        return false;
      },
      { timeout: 15000, timeoutMsg: "滚轮没能把选区滚出可视范围" },
    );
    await browser.waitUntil(async () => (await readSelectionState()).tooltipGap === null, {
      timeout: 5000,
      timeoutMsg: "选区滚出可视范围后浮层没有隐藏",
    });
    expect((await readSelectionState()).text).toBe(HISTORY_PARA);
    await browser.waitUntil(
      async () => {
        const state = await readSelectionState();
        if (state.visible && tooltipFollowsSelection(state)) return true;
        if (!state.visible) await wheelTimeline(-240);
        return false;
      },
      { timeout: 15000, timeoutMsg: "选区滚回可视范围后浮层没有重新对准选区" },
    );
    await browser.saveScreenshot(join(artifacts(), "scm12-scrolled-back.png"));
    // SCM13：按 Esc 关掉浮层。选区还在，但之后的滚动不能把浮层弹回来。
    // （回答输出过程中按 Esc 会停止生成，所以在回答完成后用滚轮验证同一条规则。）
    await browser.keys("Escape");
    await $("[data-conversation-selection-tooltip]").waitForExist({ reverse: true, timeout: 3000 });
    for (const delta of [120, -120, 80, -80]) {
      await wheelTimeline(delta);
      await browser.pause(200);
      const state = await readSelectionState();
      if (state.tooltipGap !== null) {
        throw new Error(`按 Esc 关掉的浮层在滚动后又出现了: ${JSON.stringify(state)}`);
      }
      expect(state.text).toBe(HISTORY_PARA);
    }
    // 重新框选后浮层照常出现。
    await dragSelectMainTimelineText(HISTORY_PARA);
    expect(tooltipFollowsSelection(await readSelectionState())).toBe(true);
    // ② 打开右侧面板，时间线变窄、文字重排：选区还在时浮层必须跟到新位置，不能停在原地。
    await toggleSidePane();
    await browser.waitUntil(
      async () => {
        const state = await readSelectionState();
        return state.text === "" ? state.tooltipGap === null : tooltipFollowsSelection(state);
      },
      {
        timeout: 5000,
        timeoutMsg: `打开右侧面板后浮层没有跟随选区: ${JSON.stringify(await readSelectionState())}`,
      },
    );
    await browser.saveScreenshot(join(artifacts(), "scm12-side-pane-open.png"));
    await toggleSidePane();
    // ③ 切到别的会话再切回来：浮层不带到新会话，切回后也不留旧浮层。
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    await dragSelectMainTimelineText(HISTORY_PARA);
    await startNewV4Draft();
    expect(await $("[data-conversation-selection-tooltip]").isExisting()).toBe(false);
    await selectV4TaskById(sessionId);
    await waitForV4AssistantMessageContaining(HISTORY_PARA, 30000);
    const afterSwitch = await readSelectionState();
    expect(
      afterSwitch.text === ""
        ? afterSwitch.tooltipGap === null
        : tooltipFollowsSelection(afterSwitch),
    ).toBe(true);
    await browser.execute(() => window.getSelection()?.removeAllRanges());
    // 三条注释还在 composer 里。
    expect((await readMainComposerSelectionChip()).count).toBe(3);

    // SCM07：跨块注释随这条提问一起发出；回答分多步输出，期间框选并完成注释。
    await sendV4Prompt("E2E_SCS_STREAM: run the scripted steps");
    // 被跨过的代码块正文随引用发给模型（原先 Shadow DOM 里的代码不在选区文本里）。
    await waitForUpstreamRequest(
      // 代码紧跟在它上方那段正文之后，没有被插到别处。
      {
        lastUserMessageIncludes: [
          "E2E_SCS_STREAM",
          CROSS_END,
          // 引用以 JSON 形式嵌在消息文本里，换行是转义后的两个字符。
          "中间这一段会被整段选中。\\n\\n```\\nDesktop (Mac)",
          // 代码正文逐字保留：模板字符串里的连续空行不能被压缩。
          "0123456789\\nconst value = `A\\n\\n\\nB`;\\n```",
        ],
      },
      "跨块注释的原文没有带上代码块正文",
      30000,
    );
    // 公式以 TeX 源码进入引用（行内 $…$，独立 $$…$$），而不是浏览器给出的逐字符 MathML 碎片。
    // 引用是嵌在消息文本里的 JSON，TeX 里的反斜杠是转义后的两个字符。
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [
          "E2E_SCS_STREAM",
          "这一行有行内公式 $E = mc^2$ 和 $\\\\sum_{i=1}^{n} i = \\\\frac{n(n+1)}{2}$，下面是独立公式：",
          "$$\\\\int_0^1 x^2 \\\\, dx = \\\\frac{1}{3}$$",
          MATH_END,
        ],
      },
      "公式没有以 TeX 源码进入引用原文",
      30000,
    );
    expect(await countUpstreamRequests({ lastUserMessageIncludes: ["E2E_SCS_STREAM", "𝐸"] })).toBe(
      0,
    );
    // 等第二段正文出现再框选第一段：第一段的逐词渐显已结束，文字节点稳定，真实拖选才可靠。
    await waitForV4AssistantMessageContaining("E2E_SCS_SECOND_PARA", 60000);
    await installSelectionProbe();

    // 输出仍在继续：后面还有工具调用、思考块、工具行分组和约 15 秒的流式正文（含跟随滚动）。
    // 框选本轮已经输出完成的第一段正文，不滚动时间线。
    await dragSelectMainTimelineText(LIVE_PARA, { scroll: false });
    await browser.saveScreenshot(join(artifacts(), "scm07-streaming-selection-menu.png"));
    await waitForV4AssistantMessageContaining(line(6), 30000);
    const afterStreaming = await readSelectionState();
    await browser.saveScreenshot(join(artifacts(), "scm07-streaming-selection-after.png"));
    if (afterStreaming.text !== LIVE_PARA || !tooltipFollowsSelection(afterStreaming)) {
      throw new Error(
        `输出过程中选区丢失，或浮层消失/没有跟随选区: ${JSON.stringify(afterStreaming)}\nprobe=${JSON.stringify(
          await readSelectionProbe(),
        )}`,
      );
    }

    // 输出继续时完成注释：输入不被打断，保存后正文出现实心编号。
    await clickSelectionAction("comment");
    await typeSelectionComment(COMMENT);
    // 输入期间回答继续输出、时间线继续滚动：输入卡片要跟着正文里的虚线标记走，不能留在原地。
    const lineBeforeFollow = await browser.execute(
      () =>
        document
          .querySelector('[data-annotation-mark="__pending__"] > div')
          ?.getBoundingClientRect().top ?? null,
    );
    await browser.waitUntil(
      async () => {
        const follow = await browser.execute(() => {
          const line = document
            .querySelector('[data-annotation-mark="__pending__"] > div')
            ?.getBoundingClientRect();
          const editor = document
            .querySelector("[data-conversation-selection-comment-editor]")
            ?.getBoundingClientRect();
          if (!line || !editor) return null;
          return {
            lineTop: line.top,
            // 卡片在标记上方时看卡片底边到标记顶边的距离，在下方时看卡片顶边到标记底边。
            gap: Math.min(Math.abs(line.top - editor.bottom), Math.abs(editor.top - line.bottom)),
          };
        });
        // 等标记至少移动过 40px 再核对，确认是在滚动之后仍然对准。
        return (
          follow !== null &&
          lineBeforeFollow !== null &&
          Math.abs(follow.lineTop - lineBeforeFollow) >= 40 &&
          follow.gap <= 24
        );
      },
      { timeout: 15000, timeoutMsg: "输出过程中输入卡片没有跟随正文里的标记" },
    );
    expect(await $("[data-conversation-selection-comment-input]").getValue()).toBe(COMMENT);
    await browser.saveScreenshot(join(artifacts(), "scm07-editor-follows.png"));
    await browser.keys("Enter");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    try {
      await browser.waitUntil(
        async () =>
          // SCM08、SCM09 的注释已随本轮提问发出（变成灰色已发送标记），这里是新的第 1 条。
          (await readMainComposerSelectionChip()).count === 1 &&
          (await readMainTimelineAnnotationMarks()).some(
            (mark) => mark.number === 1 && mark.variant === "comment",
          ),
        { timeout: 10000 },
      );
    } catch {
      await browser.saveScreenshot(join(artifacts(), "scm07-save-failed.png"));
      throw new Error(
        `输出过程中保存的注释没有出现在 composer 与正文: ${JSON.stringify({
          chip: await readMainComposerSelectionChip(),
          marks: await readMainTimelineAnnotationMarks(),
        })}`,
      );
    }
    await waitForV4AssistantMessageContaining("E2E_SCS_STREAM_DONE", 60000);
    expect((await readMainComposerSelectionChip()).count).toBe(1);

    // SCM13：点“在辅助对话中提问”后右侧面板打开、时间线变窄。浮层已被这次点击关掉，
    // 不能因为容器尺寸变化在原选区上重新出现。
    await dragSelectMainTimelineText("E2E_SCS_STREAM_DONE");
    const widthBeforeAsk = await browser.execute(
      () =>
        document.querySelector('[data-testid="v4-timeline"]')?.getBoundingClientRect().width ?? 0,
    );
    await clickSelectionAction("ask-in-side-chat");
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await browser.execute(
            () =>
              document.querySelector('[data-testid="v4-timeline"]')?.getBoundingClientRect()
                .width ?? 0,
          )) - widthBeforeAsk,
        ) > 40,
      { timeout: 15000, timeoutMsg: "点“在辅助对话中提问”后右侧面板没有打开" },
    );
    const askedAt = Date.now();
    while (Date.now() - askedAt < 1500) {
      if (await $("[data-conversation-selection-tooltip]").isExisting()) {
        throw new Error("点“在辅助对话中提问”后，主时间线上又出现了选区浮层");
      }
      await browser.pause(120);
    }
    await browser.saveScreenshot(join(artifacts(), "scm13-ask-in-side-chat.png"));
  });
});
