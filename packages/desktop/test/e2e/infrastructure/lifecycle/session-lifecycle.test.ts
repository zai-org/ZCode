import { dirname } from "node:path";

import { collectE2EProcessTreePids, listSystemProcesses } from "#e2e/helpers/e2e-process-cleanup";

describe("桌面端 E2E session 生命周期", () => {
  it("启动参数丢失后仍可从当前 profile 找到完整 Electron 进程树", async () => {
    const { mainPid, userDataDir } = await browser.electron.execute((electron) => ({
      mainPid: process.pid,
      userDataDir: electron.app.getPath("userData"),
    }));
    const processes = await listSystemProcesses();
    const detectedPids = collectE2EProcessTreePids(processes, {
      chromiumProfileRootDir: dirname(userDataDir),
      homeDir: process.env.ZCODE_E2E_HOME_DIR ?? "",
      runId: process.env.ZCODE_E2E_RUN_ID,
    });

    expect(detectedPids).toContain(mainPid);
    const children = processes.filter((item) => item.ppid === mainPid);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((item) => detectedPids.includes(item.pid))).toBe(true);
  });

  it("每轮都把 WebDriver current handle 绑定到真实 renderer page target", async () => {
    const handles = await browser.getWindowHandles();
    const currentHandle = await browser.getWindowHandle();
    const puppeteer = await browser.getPuppeteer();
    const pageTargetIds = puppeteer
      .targets()
      .filter((target) => target.type() === "page")
      .map((target) => (target as unknown as { _targetId?: string })._targetId)
      .filter((targetId): targetId is string => Boolean(targetId));
    const url = await browser.execute(() => window.location.href);

    expect(handles).toContain(currentHandle);
    expect(pageTargetIds).toContain(currentHandle);
    expect(handles.every((handle) => pageTargetIds.includes(handle))).toBe(true);
    expect(url).toContain("/renderer/index.html");
    expect(url).not.toBe("chrome-error://chromewebdata/");
  });
});
