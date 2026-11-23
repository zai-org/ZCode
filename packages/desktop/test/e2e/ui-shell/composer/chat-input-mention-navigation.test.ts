import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_PROMPT_SUGGESTION_SECTION,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";

type LexicalInputE2EBridge = {
  focus: () => void;
  getText: () => string;
  setEditorStateJson: (editorStateJson: string) => void;
};

type LexicalInputE2EElement = HTMLElement & {
  __zcodeLexicalInputE2E?: LexicalInputE2EBridge;
};

const FILE_MENTION_LABEL = "option-right-repro.ts";
const FILE_MENTION_PATH = "src/option-right-repro.ts";
const FILE_MENTION_MARKDOWN = `[${FILE_MENTION_LABEL}](${FILE_MENTION_PATH})`;
const TYPED_AFTER_MENTION = "继续输入";
const PLUGIN_NAME = "skill-creator";
const PLUGIN_STABLE_ID = "skill-creator@zcode-plugins-official";
const PLUGIN_OPTION_ID = `plugin:${PLUGIN_STABLE_ID}`;
const SCROLL_ANCHOR_PREFIX = "e2e-scroll-anchor";
const SCROLL_ANCHOR_DIR = join(DEFAULT_WORKSPACE, SCROLL_ANCHOR_PREFIX);
const SCROLL_ANCHOR_FILE_COUNT = 40;
const ZCODEIGNORE_PATH = join(DEFAULT_WORKSPACE, ".zcodeignore");
const OPTION_ROW_HEIGHT = 34;
const LISTBOX_SELECTOR = `[data-testid="${TID_PROMPT_SUGGESTION_PANEL}"] [role="listbox"]`;

describe("chat input mention navigation", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps a file mention when typing after Option+ArrowRight moves across it", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await setChatInputFileMentionState();
    await placeSelectionBeforeFileMention();

    await pressOptionArrowRight();
    const afterMove = await getMentionNavigationSnapshot();
    expect(afterMove.mentionCount).toBe(1);

    await browser.keys(TYPED_AFTER_MENTION);
    const afterTyping = await getMentionNavigationSnapshot();
    expect(afterTyping.mentionCount).toBe(1);
    expect(afterTyping.bridgeText).toContain(FILE_MENTION_MARKDOWN);
    expect(afterTyping.bridgeText).toContain(TYPED_AFTER_MENTION);
  });

  it("keeps the Plugin candidates stable while ArrowLeft/ArrowRight moves inside the active token", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `@${PLUGIN_NAME}`, {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await waitForPluginOption();
    await startPluginOptionStabilityProbe();

    await browser.keys("ArrowLeft");
    await waitForPluginOption();
    await browser.keys("ArrowRight");
    await waitForPluginOption();
    await browser.keys("ArrowLeft");
    await waitForPluginOption();

    expect(await finishPluginOptionStabilityProbe()).toEqual({
      optionDisconnected: false,
      panelDisconnected: false,
    });

    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await getComposerText()) === `[@${PLUGIN_NAME}](plugin://${PLUGIN_STABLE_ID}) `,
      {
        timeout: 10000,
        timeoutMsg: "ArrowLeft 后选择 Plugin 没有替换完整 token，或残留了重复后缀",
      },
    );
  });

  // 反馈 ZCT-2122356778527907840（3.18.2）：长列表用滚轮翻到中段后，后台任务状态变化触发候选刷新，
  // 列表被拉回开头。这里用真实 wheel 滚动，再走与后台任务变化相同的 state:projects 广播刷新候选。
  it("keeps the wheel scroll position when candidates refresh, and ArrowDown scrolls the selection into view", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await mkdir(SCROLL_ANCHOR_DIR, { recursive: true });
    try {
      for (let index = 0; index < SCROLL_ANCHOR_FILE_COUNT; index += 1) {
        await writeFile(
          join(SCROLL_ANCHOR_DIR, `${SCROLL_ANCHOR_PREFIX}-${String(index).padStart(2, "0")}.ts`),
          `export const value = ${index};\n`,
        );
      }
      await installHandoffRpcProbe();
      await installFileSearchResponseProbe();
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `@${SCROLL_ANCHOR_PREFIX}`, {
        stabilizeLexicalCaretAtEnd: true,
        timeout: 15000,
      });
      await browser.waitUntil(
        async () =>
          ((await getListboxSnapshot())?.optionRowEstimate ?? 0) >= SCROLL_ANCHOR_FILE_COUNT,
        { timeout: 30000, timeoutMsg: "长列表文件候选没有全部出现" },
      );
      const initial = await getListboxSnapshot();
      expect(initial!.scrollHeight).toBeGreaterThan(initial!.clientHeight * 3);

      await browser
        .action("wheel")
        .scroll({ origin: await $(LISTBOX_SELECTOR), deltaY: 520, duration: 0 })
        .perform();
      await browser.waitUntil(async () => ((await getListboxSnapshot())?.scrollTop ?? 0) > 200, {
        timeout: 5000,
        timeoutMsg: "真实 wheel 没有把候选列表滚到中段",
      });
      const beforeRefresh = await getListboxSnapshot();

      // 刷新结果要和刷新前有可见差异，才能证明新结果真的替换上去了：用 .zcodeignore 去掉最后一个文件
      // （远离视口，不影响当前滚动位置）。.zcodeignore 的修改时间与大小属于 Host 文件列表缓存签名，
      // 这次重新查询不会命中旧缓存。
      await writeFile(
        ZCODEIGNORE_PATH,
        `${SCROLL_ANCHOR_PREFIX}/${SCROLL_ANCHOR_PREFIX}-${String(SCROLL_ANCHOR_FILE_COUNT - 1).padStart(2, "0")}.ts\n`,
      );
      // 等候选刷新的 Host 响应真正回到渲染层，再判定位置，避免刷新未发生时用例空过。
      const responsesBefore = await readFileSearchResponseCount();
      await callHandoffHost(ServiceChannels.Broadcast, "send", [
        { channel: "state:projects", payload: {} },
      ]);
      await browser.waitUntil(async () => (await readFileSearchResponseCount()) > responsesBefore, {
        timeout: 15000,
        timeoutMsg: "state:projects 广播后文件候选没有重新查询",
      });
      await browser.waitUntil(
        async () =>
          (await getListboxSnapshot())?.optionRowEstimate === beforeRefresh!.optionRowEstimate - 1,
        { timeout: 10000, timeoutMsg: "刷新结果没有替换到候选列表（被忽略的文件仍在）" },
      );
      await waitForAnimationFrames(3);
      const afterRefresh = await getListboxSnapshot();
      expect(afterRefresh!.loadingCount).toBe(0);
      expect(Math.abs(afterRefresh!.scrollTop - beforeRefresh!.scrollTop)).toBeLessThanOrEqual(2);

      for (let step = 0; step < 15; step += 1) {
        await browser.keys("ArrowDown");
        await browser.waitUntil(
          async () => (await getListboxSnapshot())?.selectedIndex === step + 1,
          { timeout: 5000, timeoutMsg: `ArrowDown 第 ${step + 1} 次没有移动选中项` },
        );
        await waitForAnimationFrames(2);
        const snapshot = await getListboxSnapshot();
        expect(snapshot!.selectedVisible).toBe(true);
      }

      // 重新输入关键字：选中项回到首项，列表回到开头。
      await browser
        .action("wheel")
        .scroll({ origin: await $(LISTBOX_SELECTOR), deltaY: 520, duration: 0 })
        .perform();
      await browser.keys(["-", "1"]);
      await browser.waitUntil(
        async () => {
          const snapshot = await getListboxSnapshot();
          return (
            snapshot?.scrollTop === 0 && snapshot.selectedIndex === 0 && snapshot.selectedVisible
          );
        },
        { timeout: 10000, timeoutMsg: "重新输入关键字后候选列表没有回到开头" },
      );

      // 多分组面板：各分组加载完成后，首个分组标题和首项都在视口内。
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@", {
        stabilizeLexicalCaretAtEnd: true,
        timeout: 15000,
      });
      await browser.waitUntil(
        async () => {
          const snapshot = await getListboxSnapshot();
          return (
            snapshot !== null &&
            snapshot.loadingCount === 0 &&
            snapshot.firstSectionVisible &&
            snapshot.selectedIndex === 0 &&
            snapshot.selectedVisible &&
            snapshot.scrollTop === 0
          );
        },
        { timeout: 30000, timeoutMsg: "分组加载完成后首个分组标题或首项不在视口内" },
      );
    } finally {
      await browser.keys("Escape");
      await rm(SCROLL_ANCHOR_DIR, { recursive: true, force: true });
      await rm(ZCODEIGNORE_PATH, { force: true });
    }
  });
});

type ListboxSnapshot = {
  clientHeight: number;
  firstSectionVisible: boolean;
  loadingCount: number;
  optionRowEstimate: number;
  scrollHeight: number;
  scrollTop: number;
  selectedIndex: number | null;
  selectedVisible: boolean;
};

async function getListboxSnapshot(): Promise<ListboxSnapshot | null> {
  return browser.execute(
    (listboxSelector, optionRowHeight, sectionTestId) => {
      const listbox = document.querySelector<HTMLElement>(listboxSelector);
      if (!listbox) return null;
      const selected = listbox.querySelector<HTMLElement>('[data-selected="true"]');
      const listboxRect = listbox.getBoundingClientRect();
      const selectedRect = selected?.getBoundingClientRect();
      const firstSectionRect = listbox
        .querySelector<HTMLElement>(`[data-testid^="${sectionTestId}"]`)
        ?.getBoundingClientRect();
      return {
        // 虚拟列表只渲染视口附近的行；单分组无标题时，总高度 / 行高 = 候选条数。
        optionRowEstimate: Math.floor(listbox.scrollHeight / optionRowHeight),
        clientHeight: listbox.clientHeight,
        firstSectionVisible: Boolean(
          firstSectionRect && firstSectionRect.top >= listbox.getBoundingClientRect().top - 4,
        ),
        loadingCount: listbox.querySelectorAll('[data-status="loading"]').length,
        scrollHeight: listbox.scrollHeight,
        scrollTop: listbox.scrollTop,
        selectedIndex: selected ? Number(selected.dataset.optionIndex) : null,
        // 虚拟列表按行定位，不计列表 3px 上下内边距，选中行可压进内边距；容差取内边距大小。
        selectedVisible: Boolean(
          selectedRect &&
          selectedRect.top >= listboxRect.top - 4 &&
          selectedRect.bottom <= listboxRect.bottom + 4,
        ),
      };
    },
    LISTBOX_SELECTOR,
    OPTION_ROW_HEIGHT,
    TID_PROMPT_SUGGESTION_SECTION,
  );
}

/** 统计渲染层收到的、包含长列表文件名的 Host 响应，用来确认候选刷新确实发生。 */
async function installFileSearchResponseProbe() {
  await browser.execute((marker) => {
    const probeWindow = window as Window & { __zcodeMentionScrollProbe?: { responses: number } };
    const probe = { responses: 0 };
    const ports = new WeakSet<MessagePort>();
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array && !ports.has(this)) {
        ports.add(this);
        this.addEventListener("message", (event: MessageEvent) => {
          if (
            event.data instanceof Uint8Array &&
            new TextDecoder().decode(event.data).includes(marker)
          )
            probe.responses += 1;
        });
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    probeWindow.__zcodeMentionScrollProbe = probe;
  }, `${SCROLL_ANCHOR_PREFIX}-00`);
}

async function readFileSearchResponseCount(): Promise<number> {
  return browser.execute(
    () =>
      (window as Window & { __zcodeMentionScrollProbe?: { responses: number } })
        .__zcodeMentionScrollProbe?.responses ?? 0,
  );
}

async function waitForAnimationFrames(count: number) {
  await browser.execute(
    (frames) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(frames);
      }),
    count,
  );
}

async function waitForPluginOption() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, optionTestId) =>
          Boolean(
            document.querySelector(`[data-testid="${panelTestId}"]`) &&
            document.querySelector(`[data-testid="${optionTestId}"]`),
          ),
        TID_PROMPT_SUGGESTION_PANEL,
        testId(TID_PROMPT_SUGGESTION_OPTION, PLUGIN_OPTION_ID),
      ),
    {
      timeout: 30000,
      timeoutMsg: "Plugin mention candidate did not become visible",
    },
  );
}

async function startPluginOptionStabilityProbe() {
  const started = await browser.execute(
    (panelTestId, optionTestId) => {
      type StabilityProbe = {
        observer: MutationObserver;
        option: Element;
        optionDisconnected: boolean;
        panel: Element;
        panelDisconnected: boolean;
      };
      const probeWindow = window as Window & {
        __zcodeMentionStabilityProbe?: StabilityProbe;
      };
      const panel = document.querySelector(`[data-testid="${panelTestId}"]`);
      const option = document.querySelector(`[data-testid="${optionTestId}"]`);
      if (!panel || !option) {
        return false;
      }

      const probe: StabilityProbe = {
        observer: new MutationObserver(() => {
          probe.optionDisconnected ||= !document.contains(probe.option);
          probe.panelDisconnected ||= !document.contains(probe.panel);
        }),
        option,
        optionDisconnected: false,
        panel,
        panelDisconnected: false,
      };
      probe.observer.observe(document.body, { childList: true, subtree: true });
      probeWindow.__zcodeMentionStabilityProbe = probe;
      return true;
    },
    TID_PROMPT_SUGGESTION_PANEL,
    testId(TID_PROMPT_SUGGESTION_OPTION, PLUGIN_OPTION_ID),
  );
  expect(started).toBe(true);
}

async function finishPluginOptionStabilityProbe() {
  return browser.execute(() => {
    const probeWindow = window as Window & {
      __zcodeMentionStabilityProbe?: {
        observer: MutationObserver;
        optionDisconnected: boolean;
        panelDisconnected: boolean;
      };
    };
    const probe = probeWindow.__zcodeMentionStabilityProbe;
    probe?.observer.disconnect();
    delete probeWindow.__zcodeMentionStabilityProbe;
    return {
      optionDisconnected: probe?.optionDisconnected ?? true,
      panelDisconnected: probe?.panelDisconnected ?? true,
    };
  });
}

function getComposerText() {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<LexicalInputE2EElement>(`[data-testid="${inputTestId}"]`);
    return input?.__zcodeLexicalInputE2E?.getText() ?? "";
  }, TID_V4_COMPOSER_INPUT);
}

async function setChatInputFileMentionState() {
  await browser.waitUntil(
    async () =>
      browser.execute((inputTestId) => {
        const input = document.querySelector<LexicalInputE2EElement>(
          `[data-testid="${inputTestId}"]`,
        );
        return Boolean(input?.__zcodeLexicalInputE2E);
      }, TID_V4_COMPOSER_INPUT),
    {
      timeout: 15000,
      timeoutMsg: "chat input lexical e2e bridge was not attached",
    },
  );

  const result = (await browser.execute((inputTestId) => {
    try {
      const fileMentionPath = "src/option-right-repro.ts";
      const fileMentionMarkdown = "[option-right-repro.ts](src/option-right-repro.ts)";
      const stateJson = JSON.stringify({
        root: {
          children: [
            {
              children: [
                {
                  category: "files",
                  data: {
                    kind: "file",
                    path: fileMentionPath,
                    relativePath: fileMentionPath,
                    scope: "workspace",
                  },
                  description: "",
                  detail: 0,
                  format: 0,
                  mentionId: "e2e-option-right-file",
                  mode: "token",
                  markdown: fileMentionMarkdown,
                  style: "",
                  text: "option-right-repro.ts",
                  type: "prompt-mention",
                  value: fileMentionPath,
                  version: 1,
                },
                {
                  detail: 0,
                  format: 0,
                  mode: "normal",
                  style: "",
                  text: " ",
                  type: "text",
                  version: 1,
                },
              ],
              direction: null,
              format: "",
              indent: 0,
              type: "paragraph",
              version: 1,
            },
          ],
          direction: null,
          format: "",
          indent: 0,
          type: "root",
          version: 1,
        },
      });

      const input = document.querySelector<LexicalInputE2EElement>(
        `[data-testid="${inputTestId}"]`,
      );
      const bridge = input?.__zcodeLexicalInputE2E;
      if (!input || !bridge) {
        return { ok: false, reason: "bridge-missing" };
      }
      bridge.setEditorStateJson(stateJson);
      bridge.focus();
      return {
        mentionCount: input.querySelectorAll("[data-mention-id]").length,
        ok: bridge.getText().includes(fileMentionMarkdown),
        text: bridge.getText(),
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }, TID_V4_COMPOSER_INPUT)) as {
    mentionCount?: number;
    ok: boolean;
    reason?: string;
    text?: string;
  };

  if (!result.ok || result.mentionCount !== 1) {
    throw new Error(`failed to seed file mention: ${JSON.stringify(result)}`);
  }
}

async function placeSelectionBeforeFileMention() {
  const result = (await browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const mention = input?.querySelector<HTMLElement>(`[data-mention-id="e2e-option-right-file"]`);
    if (!input || !mention) {
      return { ok: false, reason: "mention-missing" };
    }

    input.focus();
    const range = document.createRange();
    range.setStartBefore(mention);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { ok: true };
  }, TID_V4_COMPOSER_INPUT)) as { ok: boolean; reason?: string };

  if (!result.ok) {
    throw new Error(`failed to place selection before mention: ${JSON.stringify(result)}`);
  }
}

async function pressOptionArrowRight() {
  await browser.performActions([
    {
      id: "keyboard",
      type: "key",
      actions: [
        { type: "keyDown", value: "\uE00A" },
        { type: "keyDown", value: "\uE014" },
        { type: "keyUp", value: "\uE014" },
        { type: "keyUp", value: "\uE00A" },
      ],
    },
  ]);
  await browser.releaseActions();
}

function getMentionNavigationSnapshot() {
  return browser.execute((inputTestId) => {
    // 修复原因：v4 硬切后 Lexical bridge 挂在 composer v4 testid 上，
    // 继续查 legacy chat-input 会把“节点不存在”误报成键盘导航回归。
    const input = document.querySelector<LexicalInputE2EElement>(`[data-testid="${inputTestId}"]`);
    const selection = window.getSelection();
    return {
      bridgeText: input?.__zcodeLexicalInputE2E?.getText() ?? "",
      domText: input?.innerText ?? input?.textContent ?? "",
      mentionCount: input?.querySelectorAll("[data-mention-id]").length ?? 0,
      selection: {
        anchorNodeName: selection?.anchorNode?.nodeName ?? null,
        anchorOffset: selection?.anchorOffset ?? null,
      },
    };
  }, TID_V4_COMPOSER_INPUT);
}
