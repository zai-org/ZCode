import { access } from "node:fs/promises";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

interface WindowInfo {
  title: string;
  visible: boolean;
  url: string;
}

describe("桌面端容器 headless boot demo", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("能在容器虚拟显示中启动主窗口并创建默认工作区", async () => {
    await browser.waitUntil(
      async () => {
        try {
          await access(DEFAULT_WORKSPACE);
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 10000,
        timeoutMsg: `默认工作区没有自动创建: ${DEFAULT_WORKSPACE}`,
      },
    );

    const windows = await browser.electron.execute((electron) => {
      return electron.BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed())
        .map((win) => ({
          title: win.getTitle(),
          visible: win.isVisible(),
          url: win.webContents.getURL(),
        }));
    });

    const mainWindow = (windows as WindowInfo[]).find((win) =>
      win.url.includes("/renderer/index.html"),
    );

    expect(mainWindow).toBeTruthy();
    expect(mainWindow?.title).toBe("ZCode");
    expect(mainWindow?.visible).toBe(true);

    // 修复原因：v4 renderer URL 只承载启动/恢复参数，workspace 绑定已经迁入 store。
    // 继续断言路径出现在 URL 会把正确的容器启动判成失败，应改看真实可交互工作区。
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  });
});
