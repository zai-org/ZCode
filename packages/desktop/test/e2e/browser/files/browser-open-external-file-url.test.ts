import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_REFRESH_BUTTON,
} from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";

type ElectronMock = Awaited<ReturnType<typeof browser.electron.mock>>;

describe("内置浏览器「在默认浏览器中打开」对本地 file URL 的分流", () => {
  let tempDir: string;
  let fileUrl: string;
  let shellOpenExternal: ElectronMock;
  let shellOpenPath: ElectronMock;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-e2e-file-url-"));
    const assetDir = join(tempDir, "04 素材");
    await mkdir(assetDir);
    await writeFile(
      join(assetDir, "页面.html"),
      "<!doctype html><html><body><h1>本地预览页面</h1></body></html>",
      "utf8",
    );
    fileUrl = pathToFileURL(join(assetDir, "页面.html")).href;
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("中文与空格路径的 file URL 经 shell.openPath 用解码后的本地路径打开", async function () {
    this.timeout(240_000);
    shellOpenExternal = await browser.electron.mock("shell", "openExternal");
    await shellOpenExternal.mockResolvedValue(undefined);
    shellOpenPath = await browser.electron.mock("shell", "openPath");
    await shellOpenPath.mockResolvedValue("");

    await prepareConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();

    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await addressInput.setValue(fileUrl);
    await browser.keys("Enter");

    await waitForBrowserReady();

    await clickTestIdByWebDriver(TID_BROWSER_MORE_BUTTON);
    await clickTestIdByWebDriver(TID_BROWSER_OPEN_EXTERNAL_ITEM);

    await browser.waitUntil(
      async () => {
        try {
          await expect(shellOpenPath).toHaveBeenCalledWith(
            expect.stringContaining(join("04 素材", "页面.html")),
          );
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: "file URL 没有走 shell.openPath 打开本地路径" },
    );
    await expect(shellOpenPath).not.toHaveBeenCalledWith(expect.stringContaining("%"));
    await expect(shellOpenExternal).not.toHaveBeenCalled();
  });
});

async function waitForBrowserReady(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((refreshTestId: string) => {
        const refresh = document.querySelector<HTMLButtonElement>(
          `[data-testid="${refreshTestId}"]`,
        );
        return (
          !!refresh &&
          !refresh.disabled &&
          refresh.getAttribute("aria-disabled") !== "true" &&
          refresh.getAttribute("data-disabled") !== "true"
        );
      }, TID_BROWSER_REFRESH_BUTTON),
    { timeout: 30_000, timeoutMsg: "内置浏览器没有加载完本地 file URL" },
  );
}
