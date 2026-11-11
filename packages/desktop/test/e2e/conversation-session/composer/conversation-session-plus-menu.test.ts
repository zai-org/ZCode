import { readFile } from "node:fs/promises";
import { TID_CHAT_ATTACHMENT_BUTTON, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  getV4ComposerText,
  getV4SlashOptionIds,
  prepareV4ConversationE2E,
  waitForV4SlashOption,
} from "#e2e/helpers/v4-conversation";

const panel = '[data-trigger="+"]';
async function openMenu() {
  await $(`[data-testid="${TID_CHAT_ATTACHMENT_BUTTON}"]`).click();
  await $(panel).waitForDisplayed();
}
async function clearDraft(text = "") {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, { stabilizeLexicalCaretAtEnd: true });
}

// E2E_PLUS_MENU：只编辑草稿，不发送 prompt；空 provider fixture 是有意的合同。
describe("PLUS composer context menu", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  afterEach(async () => {
    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!capturePath) throw new Error("Missing provider capture evidence");
    expect(JSON.parse(await readFile(capturePath, "utf8")).records).toEqual([]);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PLUS02 offers Goal only in an empty new draft and keeps it at the message start", async () => {
    await clearDraft("before after");
    for (let i = 0; i < 5; i++) await browser.keys("ArrowLeft");
    await openMenu();
    expect(await $(`${panel} [data-option-id="add-goal"]`).isExisting()).toBe(false);
    await browser.keys("Escape");
    expect(await getV4ComposerText()).toBe("before after");
    await clearDraft();
    await openMenu();
    await $(`${panel} [data-option-id="add-goal"]`).click();
    await $(panel).waitForDisplayed({ reverse: true });
    await browser.keys("E2E_PLUS_MENU objective");
    await browser.waitUntil(
      async () => (await getV4ComposerText()) === "/goal E2E_PLUS_MENU objective",
    );
  });

  it("PLUS05 offers Workflow after Goal in an empty draft and keeps it at the message start", async () => {
    // 先等 CLI catalog（含内置命令 /workflow）送达，并断言 `/` 面板里 workflow 紧随 goal；
    // + 菜单在打开瞬间快照 catalog，必须在 catalog 就绪后再打开。
    await clearDraft("/");
    await waitForV4SlashOption("slash:workflow");
    const slashIds = await getV4SlashOptionIds();
    expect(slashIds.indexOf("slash:workflow")).toBe(slashIds.indexOf("slash:goal") + 1);
    await clearDraft();
    await openMenu();
    const workflow = `${panel} [data-option-id="add-workflow"]`;
    await $(workflow).waitForDisplayed();
    const addIds = await browser.execute(
      (selector) =>
        [...document.querySelectorAll(`${selector} [data-option-id^="add-"]`)].map((element) =>
          element.getAttribute("data-option-id"),
        ),
      panel,
    );
    expect(addIds.indexOf("add-workflow")).toBe(addIds.indexOf("add-goal") + 1);
    await $(workflow).click();
    await $(panel).waitForDisplayed({ reverse: true });
    await browser.keys("E2E_PLUS_MENU task");
    await browser.waitUntil(
      async () => (await getV4ComposerText()) === "/workflow E2E_PLUS_MENU task",
    );
    await openMenu();
    expect(await $(workflow).isExisting()).toBe(false);
    await browser.keys("Escape");
    await $(panel).waitForDisplayed({ reverse: true });
  });

  it("PLUS01/03 shares the enabled plugin candidate with @ and supports Escape", async () => {
    await clearDraft("@skill-creator");
    const plugin = '[data-option-id="plugin:skill-creator@zcode-plugins-official"]';
    await $(`[data-trigger="@"] ${plugin}`).waitForDisplayed({ timeout: 30000 });
    await browser.keys("Escape");
    await clearDraft("E2E_PLUS_MENU ");
    await openMenu();
    await $(`${panel} ${plugin}`).waitForDisplayed({ timeout: 30000 });
    await $(`${panel} ${plugin}`).click();
    await browser.waitUntil(
      async () =>
        (await getV4ComposerText())?.includes("plugin://skill-creator@zcode-plugins-official") ===
        true,
    );
    expect(await getV4ComposerText()).toContain("E2E_PLUS_MENU ");
    const before = await getV4ComposerText();
    await openMenu();
    await browser.keys("Escape");
    await $(panel).waitForDisplayed({ reverse: true });
    expect(await getV4ComposerText()).toBe(before);
  });

  it("PLUS02 inserts into the current draft after the saved selection becomes stale", async () => {
    await clearDraft("E2E_PLUS_MENU old draft");
    await openMenu();
    const plugin = `${panel} [data-option-id="plugin:skill-creator@zcode-plugins-official"]`;
    await $(plugin).waitForDisplayed({ timeout: 30000 });
    // 通过现有 E2E bridge 模拟程序回填；菜单应关闭，重开后使用新草稿。
    await browser.execute((testId) => {
      const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement & {
        __zcodeLexicalInputE2E: { setText: (text: string) => void };
      };
      input.__zcodeLexicalInputE2E.setText("E2E_PLUS_MENU replacement ");
    }, TID_V4_COMPOSER_INPUT);
    await browser.waitUntil(
      async () => (await getV4ComposerText()) === "E2E_PLUS_MENU replacement ",
    );
    await $(panel).waitForDisplayed({ reverse: true });
    await openMenu();
    await $(plugin).click();
    await browser.waitUntil(
      async () =>
        (await getV4ComposerText())?.includes("plugin://skill-creator@zcode-plugins-official") ===
        true,
    );
    expect(await getV4ComposerText()).toContain("E2E_PLUS_MENU replacement ");
    expect(await getV4ComposerText()).not.toContain("old draft");
  });

  it("PLUS04 keeps the composer anchor across repeated opens", async () => {
    await clearDraft();
    for (let attempt = 0; attempt < 4; attempt++) {
      await openMenu();
      // 旧按钮锚点卸载后会得到零尺寸；必须检查真实宽度，不能仅以 displayed 判定打开成功。
      await browser.waitUntil(async () => {
        const layout = await readLayout();
        return (
          layout.settled && layout.width > 100 && Math.abs(layout.width - layout.composerWidth) < 2
        );
      });
      await browser.keys("Escape");
      await $(panel).waitForDisplayed({ reverse: true });
    }
  });

  it("PLUS04 lays out a single desktop footer row and wraps inside a narrow viewport", async () => {
    const size = await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((w) => w.isVisible())!
        .getBounds(),
    );
    try {
      await resizeWindow(1440, 1000);
      await clearDraft();
      await openMenu();
      await $(
        `${panel} [data-option-id="plugin:skill-creator@zcode-plugins-official"]`,
      ).waitForDisplayed({ timeout: 30000 });
      // 候选异步加载且 Popover 有打开动画，需等待实际列表扩展后再检查布局。
      await browser.waitUntil(async () => (await readLayout()).listHeight > 224, {
        timeout: 10000,
      });
      const wide = await readLayout();
      expect(wide.footerY.every((y) => Math.abs(y - wide.footerY[0]!) < 2)).toBe(true);
      expect(wide.listHeight).toBeGreaterThan(224);
      await browser.keys("Escape");
      await resizeWindow(540, 900);
      await openMenu();
      await browser.waitUntil(async () => {
        const layout = await readLayout();
        return layout.left >= 0 && layout.right <= layout.viewport && layout.settled;
      });
      const narrow = await readLayout();
      expect(narrow.left).toBeGreaterThanOrEqual(0);
      expect(narrow.right).toBeLessThanOrEqual(narrow.viewport);
      expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.width + 1);
      await browser.keys("Escape");
    } finally {
      await browser.electron.execute(
        (electron, bounds) =>
          electron.BrowserWindow.getAllWindows()
            .find((w) => w.isVisible())!
            .setBounds(bounds),
        size,
      );
    }
  });
});

async function readLayout() {
  return browser.execute((selector) => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const rect = element.getBoundingClientRect();
    const codes = [...element.querySelectorAll("code")];
    const footer = codes[0]?.parentElement?.parentElement;
    return {
      footerY: [...(footer?.children ?? [])].map((child) => child.getBoundingClientRect().y),
      listHeight: element.querySelector('[role="listbox"]')!.getBoundingClientRect().height,
      // scrollWidth 不含 transform，必须等 Popover 缩放动画结束后与 rect 比较。
      settled: Math.abs(rect.width - element.offsetWidth) < 1,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      composerWidth: document
        .querySelector(`[data-testid="chat-attachment-button"]`)!
        .closest("form")!
        .getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
      viewport: window.innerWidth,
    };
  }, panel);
}

async function resizeWindow(width: number, height: number) {
  await browser.electron.execute(
    (electron, nextWidth, nextHeight) => {
      const window = electron.BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
      window.setMinimumSize(320, 400);
      window.setContentSize(nextWidth, nextHeight);
    },
    width,
    height,
  );
  await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) === width);
}
