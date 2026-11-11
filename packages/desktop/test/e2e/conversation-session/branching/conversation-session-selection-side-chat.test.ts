import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  TID_PROMPT_SUGGESTION_PANEL,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4ConversationState,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const PARENT_MARKER = "E2E_SSC_PARENT_SELECTION_MARKER";
const MAIN_DRAFT = "E2E_SSC_MAIN_DRAFT_KEEP";
const SIDE_DRAFT = "E2E_SSC_SIDE_DRAFT_KEEP";

describe("框选文字副屏会话 manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSC01/02/08/14/15/17/19/25/26/27/28/29/30/31: 隐藏历史、多开、关闭隔离、active 路由与 /side 命令", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    // 用例断言中文辅助 tab 标题；首帧跟随系统语言，必须先固定语言再创建 child。
    await pinE2ELocale("zh-CN");
    await sendV4Prompt(`Reply with exactly ${PARENT_MARKER}`);
    await waitForSelectableMainTimelineText(PARENT_MARKER, 60000);
    const parent = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "SSC parent session 没有建立",
    );

    await setComposerText(testId(TID_V4_SESSION_PANE, "workspace-main"), MAIN_DRAFT);
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("add-to-task");
    await expectComposerState(testId(TID_V4_SESSION_PANE, "workspace-main"), MAIN_DRAFT, 1);

    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const firstSide = await waitForSelectionSidePane();
    expect(firstSide.childSessionId).not.toBe(parent.sessionId);
    await expectComposerState(firstSide.paneTestId, "", 1);
    const inheritedHistoryVisible = await browser.execute(
      (paneTestId, marker) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        return pane?.innerText.includes(marker) ?? false;
      },
      firstSide.paneTestId,
      PARENT_MARKER,
    );
    expect(inheritedHistoryVisible).toBe(false);

    await setComposerText(firstSide.paneTestId, SIDE_DRAFT);
    await selectMainTimelineText("E2E_SSC_PARENT");
    await clickSelectionAction("ask-in-side-chat");
    const reusedSide = await waitForSelectionSidePane();
    expect(reusedSide.childSessionId).toBe(firstSide.childSessionId);
    await expectComposerState(reusedSide.paneTestId, SIDE_DRAFT, 2);

    await clickComposerSend(testId(TID_V4_SESSION_PANE, "workspace-main"));
    // 修复原因：timeline 容器也含 Composer，旧草稿会在请求发出前满足“完成”检查。
    // 先等本轮独有回答，再关闭副屏划词，避免新消息投影在拖选时移动文本。
    await waitForV4AssistantMessageContaining("E2E_SSC_MAIN_DRAFT_DONE", 30000);
    await waitForV4ConversationState(
      (state) => state.state === "idle" && state.activeInputId === null,
      "父会话追加输入没有完成",
    );
    const afterParentAdvance = await waitForSelectionSidePane();
    expect(afterParentAdvance.childSessionId).toBe(firstSide.childSessionId);
    await expectComposerState(afterParentAdvance.paneTestId, SIDE_DRAFT, 2);

    await closeSelectionSideTab();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.querySelector('[data-side-pane-tab-id^="selection-side-chat:"]'),
        ),
      { timeout: 30000, timeoutMsg: "关闭后 selection side tab 仍存在" },
    );

    // 关闭最后一个标签会收起右侧面板；宽度动画持续触发时间线 scroll，scroll 会关闭选区浮层。
    // 等实际面板收至零宽后再划词，不能把 tab DOM 消失当作布局已稳定。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const panel = document.querySelector('[data-workspace-side-frame="true"]')?.parentElement;
          return !panel || panel.getBoundingClientRect().width === 0;
        }),
      { timeout: 10000, timeoutMsg: "关闭最后一个辅助 tab 后面板没有收起" },
    );
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const recreatedSide = await waitForSelectionSidePane();
    expect(recreatedSide.childSessionId).not.toBe(firstSide.childSessionId);

    await clickAddSelectionSideConversation();
    await waitForSelectionSidePanes(2);
    await clickAddSelectionSideConversation();
    const threeSides = await waitForSelectionSidePanes(3);
    expect(new Set(threeSides.map((side) => side.childSessionId)).size).toBe(3);
    expect(threeSides.map((side) => side.title)).toEqual([
      "辅助对话 1",
      "辅助对话 2",
      "辅助对话 3",
    ]);

    await activateSidePaneTab(recreatedSide.tabId);
    await selectMainTimelineText("E2E_SSC_PARENT");
    await clickSelectionAction("ask-in-side-chat");
    await expectComposerState(recreatedSide.paneTestId, "", 2);
    for (const side of threeSides.filter(
      (candidate) => candidate.childSessionId !== recreatedSide.childSessionId,
    )) {
      await expectNoSelectionReferences(side.paneTestId);
    }

    const siblingSides = threeSides.filter(
      (candidate) => candidate.childSessionId !== recreatedSide.childSessionId,
    );
    const sideToClose = siblingSides[0];
    const survivingSibling = siblingSides[1];
    if (!sideToClose || !survivingSibling) {
      throw new Error("multi-open sibling side panes missing");
    }
    // 隐藏 tab 的输入框不可交互；先走真实切换，再验证关闭另一个 tab 不丢草稿。
    await activateSidePaneTab(survivingSibling.tabId);
    await setComposerText(survivingSibling.paneTestId, "E2E_SSC_SIBLING_DRAFT");
    await closeSelectionSideTab(sideToClose.tabId);
    const remainingSides = await waitForSelectionSidePanes(2);
    expect(
      remainingSides.some((candidate) => candidate.childSessionId === sideToClose.childSessionId),
    ).toBe(false);
    await expectComposerText(survivingSibling.paneTestId, "E2E_SSC_SIBLING_DRAFT");
    await expectNoSelectionReferences(survivingSibling.paneTestId);

    await clickAddSidePaneItem("terminal");
    await waitForActiveSidePaneTab("terminal:");
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const afterNoActiveAuxiliary = await waitForSelectionSidePanes(3);
    const remainingChildIds = new Set(remainingSides.map((side) => side.childSessionId));
    const createdForSelection = afterNoActiveAuxiliary.find(
      (side) => !remainingChildIds.has(side.childSessionId),
    );
    expect(createdForSelection).toBeDefined();
    if (!createdForSelection) {
      throw new Error("selection did not create a new auxiliary child");
    }
    await expectComposerState(createdForSelection.paneTestId, "", 1);

    // SSC28：/side 与 /btw App 层命令选中即开新辅助 tab，并移除输入中的命令 token。
    const mainPaneTestId = testId(TID_V4_SESSION_PANE, "workspace-main");
    const sidesBeforeSlashCommand = await waitForSelectionSidePanes(3);
    const knownChildIds = new Set(sidesBeforeSlashCommand.map((side) => side.childSessionId));
    await typeIntoComposerByKeyboard(mainPaneTestId, "/side");
    await clickSlashSuggestionOption("app-slash:side");
    const afterSideCommand = await waitForSelectionSidePanes(4);
    const sideCommandChild = afterSideCommand.find(
      (side) => !knownChildIds.has(side.childSessionId),
    );
    expect(sideCommandChild).toBeDefined();
    await expectComposerPlainText(mainPaneTestId, "");

    await typeIntoComposerByKeyboard(mainPaneTestId, "/btw");
    await clickSlashSuggestionOption("app-slash:btw");
    await waitForSelectionSidePanes(5);
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC30：带参数的 `/side` 直接创建 child，并把参数作为首条普通输入提交。
    const childrenBeforeArgument = await waitForSelectionSidePanes(5);
    const childrenBeforeArgumentIds = new Set(
      childrenBeforeArgument.map((side) => side.childSessionId),
    );
    await setComposerText(mainPaneTestId, "/side E2E_SSC_SIDE_ARGUMENT_IDLE");
    await clickComposerSend(mainPaneTestId);
    const idleArgumentChildren = await waitForSelectionSidePanes(6);
    const idleArgumentChild = idleArgumentChildren.find(
      (side) => !childrenBeforeArgumentIds.has(side.childSessionId),
    );
    expect(idleArgumentChild).toBeDefined();
    if (!idleArgumentChild) throw new Error("带参数 /side 没有创建 child");
    await waitForSelectionSidePaneContaining(
      idleArgumentChild.paneTestId,
      "E2E_SSC_SIDE_ARGUMENT_IDLE",
    );
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC31：父会话启动新 turn 后立即发送 `/btw <text>`，参数命令只启动 child，
    // 不把父会话当前 turn 改成 queue/guide。
    await setComposerText(mainPaneTestId, "Reply with exactly E2E_SSC_RUNNING_PARENT");
    await clickComposerSend(mainPaneTestId);
    await waitForV4ConversationState(
      // V4 运行态来自可见 Stop projection，不依赖旧 store 的 activeInputId 镜像。
      (state) => state.state === "streaming",
      "SSC31 父轮没有实际运行",
    );
    const childrenBeforeRunningArgument = await waitForSelectionSidePanes(6);
    const childrenBeforeRunningArgumentIds = new Set(
      childrenBeforeRunningArgument.map((side) => side.childSessionId),
    );
    await setComposerText(mainPaneTestId, "/btw E2E_SSC_SIDE_ARGUMENT_RUNNING");
    await clickComposerSend(mainPaneTestId);
    const runningArgumentChildren = await waitForSelectionSidePanes(7);
    const runningArgumentChild = runningArgumentChildren.find(
      (side) => !childrenBeforeRunningArgumentIds.has(side.childSessionId),
    );
    expect(runningArgumentChild).toBeDefined();
    if (!runningArgumentChild) throw new Error("运行中带参数 /btw 没有创建 child");
    await waitForSelectionSidePaneContaining(
      runningArgumentChild.paneTestId,
      "E2E_SSC_SIDE_ARGUMENT_RUNNING",
    );
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC29：辅助对话自身 composer 的 `/` 面板不提供 /side、/btw，CLI 命令展示不受影响。
    const activeSideAfterBtw = await waitForActiveSelectionSidePane();
    await typeIntoComposerByKeyboard(activeSideAfterBtw.paneTestId, "/");
    await expectSlashPanelWithoutSideCommands();
    await dismissSlashPanel(activeSideAfterBtw.paneTestId);

    // SSC29：草稿态（未创建 session）不提供 /side、/btw。
    await openNewTaskDraft();
    await typeIntoComposerByKeyboard(mainPaneTestId, "/");
    await expectSlashPanelWithoutSideCommands();
    await dismissSlashPanel(mainPaneTestId);
  });
});

async function selectMainTimelineText(text: string): Promise<void> {
  const paneTestId = testId(TID_V4_SESSION_PANE, "workspace-main");
  await browser.execute(() => {
    const state = window as Window & { __selectionTrace?: { events: unknown[]; stop(): void } };
    state.__selectionTrace?.stop();
    const events: unknown[] = [];
    const types = ["mousedown", "mouseup", "selectionchange", "scroll", "resize", "focusin"];
    const listener = (event: Event) => {
      const selection = window.getSelection();
      events.push({
        type: event.type,
        time: performance.now(),
        text: selection?.toString(),
        target: (event.target as Element)?.getAttribute?.("data-testid"),
        anchor: selection?.anchorNode?.parentElement
          ?.closest("[data-row-id]")
          ?.getAttribute("data-row-id"),
        focused: document.activeElement?.getAttribute("data-testid"),
        tooltip: Boolean(document.querySelector("[data-conversation-selection-tooltip]")),
      });
    };
    for (const type of types) window.addEventListener(type, listener, true);
    state.__selectionTrace = {
      events,
      stop: () => {
        for (const type of types) window.removeEventListener(type, listener, true);
      },
    };
  });
  // 上一次引用动作可能保留选区；在旧选区上拖动会变成 HTML 拖放，而不是重新划词。
  await browser.execute(() => window.getSelection()?.removeAllRanges());
  // 旧 helper 直接改 DOM Range，再重试 mouseup；它绕过了原生选区与 pane 焦点更新。
  // 这里只读取文本坐标，交互由真实 pointer drag 完成；滚动先于 pointerdown。
  const locator = (id: string, targetText: string, scroll: boolean) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
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
  };
  const readLayoutTransitions = (id: string): string[] => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!pane) return ["missing-pane"];
    return document.getAnimations().flatMap((animation) => {
      if (!(animation instanceof CSSTransition) || animation.playState !== "running") return [];
      if (!["width", "max-width", "height", "transform"].includes(animation.transitionProperty))
        return [];
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && (pane.contains(target) || target.contains(pane))
        ? [animation.transitionProperty]
        : [];
    });
  };
  // 辅助面板收起后，主列还会跨断点做宽度过渡；动态测高会把文字再滚动 59px。
  // 等实际布局过渡结束后才取坐标，避免用旧坐标拖选相邻行。
  await browser.waitUntil(
    async () => (await browser.execute(readLayoutTransitions, paneTestId)).length === 0,
    { timeout: 10000, timeoutMsg: "主时间线布局过渡未结束，不能开始原生划词" },
  );
  await browser.execute(locator, paneTestId, text, true);
  const position = await browser.execute(locator, paneTestId, text, false);
  expect(await browser.execute(readLayoutTransitions, paneTestId)).toEqual([]);
  await browser.performActions([
    {
      type: "pointer",
      id: "selection-drag",
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
  try {
    await browser.waitUntil(
      () => browser.execute((expected) => window.getSelection()?.toString() === expected, text),
      { timeout: 5000, timeoutMsg: `真实拖选未选中目标文本: ${text}` },
    );
    await $("[data-conversation-selection-tooltip]").waitForDisplayed({ timeout: 5000 });
  } catch (error) {
    const events = await browser.execute(
      () =>
        (window as Window & { __selectionTrace?: { events: unknown[] } }).__selectionTrace?.events,
    );
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "selection-events.json"),
      JSON.stringify(
        {
          text,
          position,
          currentPosition: await browser.execute(locator, paneTestId, text, false),
          events,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await browser.execute(() =>
      (window as Window & { __selectionTrace?: { stop(): void } }).__selectionTrace?.stop(),
    );
  }
}

async function waitForSelectableMainTimelineText(text: string, timeout: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (paneTestId, targetText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
          if (!pane) return false;
          const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if (
              node.textContent?.trim() === targetText &&
              node.parentElement?.closest("[data-row-id]")
            ) {
              return true;
            }
            node = walker.nextNode();
          }
          return false;
        },
        testId(TID_V4_SESSION_PANE, "workspace-main"),
        text,
      ),
    {
      timeout,
      timeoutMsg: `主时间线没有出现可选文本: ${text}`,
    },
  );
}

async function clickSelectionAction(action: "add-to-task" | "ask-in-side-chat"): Promise<void> {
  // 修复原因：浮层在 selectionchange/rAF 中可能短暂重挂载；"先检查后点击"两次往返之间
  // 按钮会消失一瞬导致 flake。这里把检查与点击合成单个原子脚本并整体重试。
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
    {
      timeout: 30000,
      timeoutMsg: `划词动作不可用: ${action}`,
    },
  );
}

async function waitForSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: { childSessionId: string; paneTestId: string; tabId: string } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const childSessionId = pane?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "selection side pane 没有打开" },
  );
  if (!result) throw new Error("selection side pane result missing");
  return result;
}

async function waitForSelectionSidePanes(expectedCount: number): Promise<
  Array<{
    childSessionId: string;
    paneTestId: string;
    tabId: string;
    title: string;
  }>
> {
  let result: Array<{
    childSessionId: string;
    paneTestId: string;
    tabId: string;
    title: string;
  }> = [];
  await browser.waitUntil(
    async () => {
      result = await browser.execute(
        (panePrefix) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-side-pane-tab-id^="selection-side-chat:"]',
            ),
          ).flatMap((tab) => {
            const tabId = tab.dataset.sidePaneTabId;
            if (!tabId) return [];
            const paneTestId = `${panePrefix}-${tabId}`;
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const childSessionId = pane?.dataset.sessionId;
            return childSessionId
              ? [{ childSessionId, paneTestId, tabId, title: tab.innerText.trim() }]
              : [];
          }),
        TID_V4_SESSION_PANE,
      );
      return result.length === expectedCount;
    },
    {
      timeout: 30000,
      timeoutMsg: `selection side pane 数量不是 ${expectedCount}`,
    },
  );
  return result;
}

async function clickAddSelectionSideConversation(): Promise<void> {
  await clickAddSidePaneItem("selection-side-conversation");
}

async function clickAddSidePaneItem(
  itemId: "selection-side-conversation" | "terminal",
): Promise<void> {
  // 修复原因：Radix DropdownMenu trigger 依赖 pointerdown 手势，element.click()
  // 或单独的 WebDriver click 在 Electron 下不稳定；与 e2ecase-regression 同口径，
  // 派发完整 pointer/mouse/click 事件序列激活 trigger 与 menu item。
  const dispatchActivationScript = (selector: string) => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const event = type.startsWith("pointer")
        ? new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
    }
    return true;
  };
  await browser.waitUntil(
    async () => browser.execute(dispatchActivationScript, "[data-side-pane-add-trigger]"),
    { timeout: 15000, timeoutMsg: "Side Pane 新增标签按钮不存在" },
  );
  const itemSelector = `[data-state="active"] [data-side-pane-open-tab-item="${itemId}"]`;
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => Boolean(document.querySelector(selector)), itemSelector),
    { timeout: 15000, timeoutMsg: `${itemId} 新增菜单没有打开` },
  );
  const clicked = await browser.execute(dispatchActivationScript, itemSelector);
  expect(clicked).toBe(true);
}

async function waitForActiveSidePaneTab(idPrefix: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextIdPrefix) => {
        const activeTab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id][data-state="active"]',
        );
        return activeTab?.dataset.sidePaneTabId?.startsWith(nextIdPrefix) ?? false;
      }, idPrefix),
    {
      timeout: 30000,
      timeoutMsg: `Side Pane active tab 不是 ${idPrefix}`,
    },
  );
}

async function activateSidePaneTab(tabId: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const tab = document.querySelector<HTMLElement>(
      `[data-side-pane-tab-id="${CSS.escape(targetTabId)}"]`,
    );
    tab?.click();
    return Boolean(tab);
  }, tabId);
  expect(clicked).toBe(true);
}

async function setComposerText(paneTestId: string, text: string): Promise<void> {
  // 多 pane 共用 testid 时单点 Lexical bridge 可能不在目标输入上；通过真实键盘输入。
  await clearComposerByKeyboard(paneTestId);
  await browser.keys(text.split(""));
  await expectComposerPlainText(paneTestId, text);
}

async function expectComposerState(
  paneTestId: string,
  text: string,
  referenceCount: number,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, expectedText, expectedReferenceCount) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          return (
            (input?.textContent ?? "").trim() === expectedText &&
            pane?.querySelector(
              `[data-conversation-selection-reference-count="${expectedReferenceCount}"]`,
            ) !== null
          );
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
        referenceCount,
      ),
    {
      timeout: 15000,
      timeoutMsg: `composer 草稿或引用数量不匹配: ${paneTestId}`,
    },
  );
}

async function expectNoSelectionReferences(paneTestId: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextPaneTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
        return (
          pane !== null &&
          pane.querySelector("[data-conversation-selection-reference-count]") === null
        );
      }, paneTestId),
    {
      timeout: 15000,
      timeoutMsg: `非目标辅助对话出现了划词引用: ${paneTestId}`,
    },
  );
}

async function expectComposerText(paneTestId: string, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, expectedText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          return (
            (
              input as
                | (HTMLElement & {
                    __zcodeLexicalInputE2E?: { getText: () => string };
                  })
                | undefined
            )?.__zcodeLexicalInputE2E?.getText() === expectedText
          );
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    {
      timeout: 15000,
      timeoutMsg: `composer 草稿不匹配: ${paneTestId}`,
    },
  );
}

async function clickComposerSend(paneTestId: string): Promise<void> {
  const clicked = await browser.execute(
    (nextPaneTestId, sendTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    paneTestId,
    TID_V4_COMPOSER_SEND,
  );
  expect(clicked).toBe(true);
}

async function waitForActiveSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: { childSessionId: string; paneTestId: string; tabId: string } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"][data-state="active"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const childSessionId = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`)
          ?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "没有 active 的 selection side pane" },
  );
  if (!result) throw new Error("active selection side pane missing");
  return result;
}

async function waitForSelectionSidePaneContaining(
  paneTestId: string,
  marker: string,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, nextMarker) =>
          document
            .querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`)
            ?.innerText.includes(nextMarker) ?? false,
        paneTestId,
        marker,
      ),
    { timeout: 60000, timeoutMsg: `selection side pane 没有出现 ${marker}` },
  );
}

/** 斜杠面板由真实键盘事件触发，输入一次后等待可见正文收敛。 */
async function typeIntoComposerByKeyboard(paneTestId: string, text: string): Promise<void> {
  await setComposerText(paneTestId, text);
}

/** 不依赖 bridge 的清空：全选 + Backspace（真实键序，Lexical 正常处理）。 */
async function clearComposerByKeyboard(paneTestId: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  const input = $(inputSelector);
  await input.waitForClickable({ timeout: 15000 });
  await input.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await browser.keys([modifier, "a"]);
  await browser.keys("Backspace");
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector) =>
          (document.querySelector<HTMLElement>(selector)?.textContent ?? "").trim() === "",
        inputSelector,
      ),
    { timeout: 10000, timeoutMsg: `composer 清空失败: ${paneTestId}` },
  );
}

/** 不依赖 bridge 的 composer 文本断言（bridge 在多 composer 场景可能脱落）。 */
async function expectComposerPlainText(paneTestId: string, text: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector, expectedText) =>
          (document.querySelector<HTMLElement>(selector)?.textContent ?? "").trim() ===
          expectedText,
        inputSelector,
        text,
      ),
    { timeout: 15000, timeoutMsg: `composer 文本不匹配: ${paneTestId}` },
  );
}

async function clickSlashSuggestionOption(optionId: string): Promise<void> {
  // 修复原因：面板可能因编辑器失焦（新辅助 tab autofocus）瞬时关闭；"先查后点"两次
  // 往返之间选项会消失。这里把查找与 mousedown 合成单个原子脚本并整体重试。
  // MentionPanel 选项在 onMouseDown 触发 onSelect，element.click() 不会命中。
  await browser.waitUntil(
    async () =>
      browser.execute((nextOptionId) => {
        const option = document.querySelector<HTMLButtonElement>(
          `[data-option-id="${CSS.escape(nextOptionId)}"]`,
        );
        if (!option) return false;
        option.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        return true;
      }, optionId),
    { timeout: 15000, timeoutMsg: `斜杠面板没有出现选项: ${optionId}` },
  );
}

async function expectSlashPanelWithoutSideCommands(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
        TID_PROMPT_SUGGESTION_PANEL,
      ),
    { timeout: 15000, timeoutMsg: "斜杠面板没有打开" },
  );
  // SSC29 只限制辅助对话入口；/plan 等后续加入的合法 App 命令不在禁止范围。
  const appCommands = await browser.execute(() =>
    [...document.querySelectorAll('[data-option-id^="app-slash:"]')].map((node) =>
      node.getAttribute("data-option-id"),
    ),
  );
  expect(appCommands).not.toContain("app-slash:side");
  expect(appCommands).not.toContain("app-slash:btw");
}

async function dismissSlashPanel(paneTestId: string): Promise<void> {
  await browser.keys("Escape");
  await clearComposerByKeyboard(paneTestId);
}

async function openNewTaskDraft(): Promise<void> {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await waitForV4ConversationState(
    (state) => state.sessionId === null && state.taskId === null,
    "项目没有进入空草稿",
  );
}

async function closeSelectionSideTab(tabId?: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const tab = document.querySelector<HTMLElement>(
      targetTabId
        ? `[data-side-pane-tab-id="${CSS.escape(targetTabId)}"]`
        : '[data-side-pane-tab-id^="selection-side-chat:"]',
    );
    const button = tab?.querySelector<HTMLButtonElement>("button");
    button?.click();
    return Boolean(button);
  }, tabId);
  expect(clicked).toBe(true);
}
