import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";

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
});

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
