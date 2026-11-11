import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";

describe("桌面主窗口尺寸持久化 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("拖拽调整后保存尺寸，不依赖 close/quit 写入", async function () {
    this.timeout(60_000);

    await waitForDefaultWorkspaceReady(30_000);
    const paths = getE2EAppDataPaths();
    const targetSize = await browser.electron.execute((electron) => {
      // 后台 E2E 不保证 OS 焦点；按主 renderer 定位，避免 getFocusedWindow 返回空。
      const win = electron.BrowserWindow.getAllWindows().find((window) =>
        /\/renderer\/index\.html(?:[?#]|$)/u.test(window.webContents.getURL()),
      );
      if (!win || win.isDestroyed()) throw new Error("没有找到 Electron 主窗口");
      win.blur();
      const current = win.getNormalBounds();
      const requested = { width: current.width + 80, height: current.height + 40 };
      // 当前 Electron 的 WebDriver window/rect 命令不支持 Browser.getWindowForTarget，
      // 直接调用原生 API 触发与用户拖拽一致的 resize 事件。
      win.setSize(requested.width, requested.height);
      const applied = win.getNormalBounds();
      return { width: applied.width, height: applied.height };
    });

    await browser.waitUntil(
      async () => {
        const settings = await readSettings(paths.appDataDir);
        const size = settings.desktopWindowSize;
        return (
          size?.width === targetSize.width &&
          size.height === targetSize.height &&
          size.maximized === false
        );
      },
      {
        timeout: 15_000,
        timeoutMsg: "窗口 resize 防抖后没有将尺寸写入 setting.json",
      },
    );

    expect(await pathExists(`${join(paths.appDataDir, "setting.json")}.lock`)).toBe(false);
  });
});

async function readSettings(appDataDir: string): Promise<{
  desktopWindowSize?: { width?: number; height?: number; maximized?: boolean };
}> {
  try {
    return JSON.parse(await readFile(join(appDataDir, "setting.json"), "utf-8")) as {
      desktopWindowSize?: { width?: number; height?: number; maximized?: boolean };
    };
  } catch {
    return {};
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
