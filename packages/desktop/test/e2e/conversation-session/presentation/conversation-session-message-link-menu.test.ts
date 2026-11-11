import { join } from "node:path";
import { TID_BROWSER_ADDRESS_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setCurrentElectronRendererContentSize } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_MESSAGE_LINK_MENU";
const URL = "https://example.com/page?q=a%20b&lang=zh#section";
const MENU = '[data-slot="context-menu-content"][data-state="open"]';

describe("消息正文链接菜单", () => {
  let previousClipboard = "";
  let windowSnapshot: { id: number; minimum: number[]; size: number[] } | undefined;

  before(async () => {
    previousClipboard = await browser.electron.execute((electron) => electron.clipboard.readText());
  });

  after(async () => {
    if (windowSnapshot) {
      await browser.electron.execute((electron, snapshot) => {
        const window = electron.BrowserWindow.fromId(snapshot.id);
        window?.setMinimumSize(snapshot.minimum[0]!, snapshot.minimum[1]!);
        window?.setContentSize(snapshot.size[0]!, snapshot.size[1]!);
      }, windowSnapshot);
    }
    await browser.electron.execute(
      (electron, text) => electron.clipboard.writeText(text),
      previousClipboard,
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MLC01: 分组、图标、完整链接复制及两个打开目标", async () => {
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${MARKER}: Reply with [Link label](${URL}).`);
    await waitForV4Pane(
      (pane) => !pane.canStop && pane.timelineText.includes(`${MARKER}_DONE`),
      "消息链接夹具未完成",
      60_000,
    );
    const external = await browser.electron.mock("shell", "openExternal");
    await external.mockResolvedValue(undefined);
    windowSnapshot = await browser.electron.execute(
      (electron, url) => {
        const window = electron.BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.getURL() === url,
        );
        if (!window) throw new Error("Missing test window");
        const snapshot = {
          id: window.id,
          minimum: window.getMinimumSize(),
          size: window.getContentSize(),
        };
        // 桌面窗口最小宽度为 480px；窄屏视觉验收需临时放宽，结束后恢复窗口约束。
        window.setMinimumSize(320, 400);
        return snapshot;
      },
      await browser.getUrl(),
    );

    for (const width of [1200, 390]) {
      for (const theme of ["zai-light", "zai-dark"] as const) {
        const locale = theme === "zai-dark" ? "zh-CN" : "en-US";
        await setCurrentElectronRendererContentSize(width, 800);
        await browser.execute(
          (next) => {
            const actions = (
              window as typeof window & {
                __testActions?: {
                  setLocale: (locale: string) => void;
                  setTheme: (theme: string) => void;
                };
              }
            ).__testActions;
            if (!actions) throw new Error("Missing presentation actions");
            actions.setLocale(next.locale);
            actions.setTheme(next.theme);
          },
          { locale, theme },
        );
        await openMenu();
        const expected =
          locale === "zh-CN"
            ? ["在 ZCode 中打开", "在浏览器中打开", "复制链接"]
            : ["Open in ZCode", "Open in browser", "Copy link"];
        await browser.waitUntil(
          async () =>
            JSON.stringify(
              await browser.$$(MENU + ' [role="menuitem"]').map((item) => item.getText()),
            ) === JSON.stringify(expected),
        );
        const layout = await browser.execute((selector) => {
          const menu = document.querySelector<HTMLElement>(selector)!;
          const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
          const separator = menu.querySelector('[role="separator"]');
          const rect = menu.getBoundingClientRect();
          return {
            icons: items.map((item) => item.querySelector("svg")?.getAttribute("class")),
            grouped:
              items[0]?.nextElementSibling === items[1] &&
              items[1]?.nextElementSibling === separator &&
              separator?.nextElementSibling === items[2],
            fits:
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              items.every((item) => item.scrollWidth <= item.clientWidth),
          };
        }, MENU);
        expect(layout.grouped).toBe(true);
        expect(layout.fits).toBe(true);
        expect(layout.icons[0]).toContain("lucide-panel-right");
        expect(layout.icons[1]).toContain("lucide-external-link");
        expect(layout.icons[2]).toContain("lucide-copy");
        if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, `message-link-menu-${width}-${theme}.png`),
          );
        }
        await browser.electron.execute((electron) => electron.clipboard.clear());
        await browser.$(MENU + ' [role="menuitem"]:last-child').click();
        await browser.waitUntil(
          async () =>
            (await browser.electron.execute((electron) => electron.clipboard.readText())) === URL,
        );
        expect(await browser.$(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`).isExisting()).toBe(
          false,
        );
        await expect(external).not.toHaveBeenCalled();
      }
    }

    await setCurrentElectronRendererContentSize(1200, 800);
    await openMenu();
    await browser.$(MENU + ' [role="menuitem"]:nth-child(2)').click();
    await browser.waitUntil(async () => {
      try {
        await expect(external).toHaveBeenCalledWith(URL);
        return true;
      } catch {
        return false;
      }
    });
    expect(await browser.$(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`).isExisting()).toBe(
      false,
    );

    await openMenu();
    await browser.$(MENU + ' [role="menuitem"]:first-child').click();
    const address = await browser.$(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await address.waitForDisplayed();
    await browser.waitUntil(async () => (await address.getValue()) === URL);
    await expect(external).toHaveBeenCalledTimes(1);
  }).timeout(180_000);
});

async function openMenu() {
  const link = await browser.$(`button[title="${URL}"]`);
  await link.waitForDisplayed();
  // 缩窗时布局动画会移动链接，直接右键可能落到旁边段落；等待真实位置稳定再点击。
  await link.waitForStable();
  await link.waitForClickable();
  await link.click({ button: "right" });
  await browser.$(MENU).waitForDisplayed();
}
