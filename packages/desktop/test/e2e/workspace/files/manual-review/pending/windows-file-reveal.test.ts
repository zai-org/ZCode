import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";

describe("Windows 本地文件定位 IPC", () => {
  it("同一请求只通过 shell 定位一次中文及空格文件", async function () {
    if (process.platform !== "win32") this.skip();
    await waitForDefaultWorkspaceReady(30000);
    const directory = await mkdtemp(join(tmpdir(), "zcode-reveal-"));
    const filePath = join(directory, "生成 文件.html");
    try {
      await writeFile(filePath, "<html></html>");
      const reveal = await browser.electron.mock("shell", "showItemInFolder");
      await reveal.mockReturnValue(undefined);
      const open = await browser.electron.mock("shell", "openPath");
      await open.mockResolvedValue("");
      const result = await browser.execute(async (path) => {
        const bridge = (
          window as unknown as {
            zcode: {
              openInEditor(editorId: string, path: string): Promise<{ success: boolean }>;
            };
          }
        ).zcode;
        return bridge.openInEditor("explorer", path);
      }, filePath);
      expect(result).toEqual({ success: true });
      await expect(reveal).toHaveBeenCalledTimes(1);
      await expect(reveal).toHaveBeenCalledWith(filePath);
      await expect(open).not.toHaveBeenCalled();
    } finally {
      await browser.electron.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
