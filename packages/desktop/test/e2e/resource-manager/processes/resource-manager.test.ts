import { join } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  activateResourceManagerTab,
  closeResourceManagerWindow,
  countAgentProcessRows,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  openResourceManagerFromHelpMenu,
  readResourceUsageSnapshot,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";

describe("资源管理器", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("从右上角问号帮助菜单打开资源管理器窗口", async function () {
    // 原因：Windows/Linux 没有原生菜单栏，自绘标题栏箭头菜单也已下线，
    // 问号菜单是这两个平台唯一的资源管理器入口，必须与原生 Help 菜单同样可达。
    this.timeout(60_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);

    await openResourceManagerFromHelpMenu();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    await expect($('[data-testid="resource-manager-cpu-app"]')).toBeDisplayed();

    await switchToElectronRendererTarget(isMainRendererUrl);
    await closeResourceManagerWindow();
  });

  it("从 Help 菜单打开后展示四类分组，Agent 进程会在 Host 采样后拿到真实内存", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);

    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();

    // 默认 CPU tab：四类分组固定存在（空组也要显示），CPU 指标卡带 ZCode / 整机两个读数。
    for (const category of ["base", "task", "builtin-plugin", "community-plugin"]) {
      await expect($(`[data-testid="resource-manager-group-${category}"]`)).toBeDisplayed();
    }
    await expect($('[data-testid="resource-manager-cpu-app"]')).toBeDisplayed();
    expect(await $('[data-testid="resource-manager-memory-system"]').isExisting()).toBe(false);
    // 切到内存 tab：换成内存指标卡，分组仍在；再切回 CPU 继续后续断言。
    await activateResourceManagerTab("memory");
    await expect($('[data-testid="resource-manager-memory-system"]')).toBeDisplayed();
    await expect($('[data-testid="resource-manager-group-base"]')).toBeDisplayed();
    await expect($('[data-testid="resource-manager-group-task"]')).toBeDisplayed();
    await activateResourceManagerTab("cpu");
    await expect($('[data-testid="resource-manager-cpu-app"]')).toBeDisplayed();

    // 只清 renderer timer 不够：存储页期间 Main 必须拒绝查询，避免遗留调用继续驱动 Host。
    await activateResourceManagerTab("storage");
    await browser.waitUntil(
      async () =>
        browser.execute(async () => {
          try {
            await (
              window as unknown as { resourceManager: { getSnapshot: () => Promise<unknown> } }
            ).resourceManager.getSnapshot();
            return false;
          } catch (error) {
            return String(error).includes("Resource sampling is inactive");
          }
        }),
      { timeout: 5_000, interval: 100, timeoutMsg: "存储页仍允许进程查询" },
    );
    await activateResourceManagerTab("cpu");
    await waitForResourceManagerReady();

    // 默认 workspace 至少拉起一个本地 Agent；Host 侧采样落地后该行必须有真实 RSS。
    await browser.waitUntil(async () => (await countAgentProcessRows()) >= 1, {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: "资源管理器里没有出现 Agent 进程",
    });
    await browser.waitUntil(
      async () => {
        const snapshot = await readResourceUsageSnapshot();
        const agent = snapshot?.processes.find((process) =>
          process.name.startsWith("zcode-agent-"),
        );
        return Boolean(agent && agent.sampled && agent.memoryBytes > 0);
      },
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: "Agent 进程行没有拿到 Host 采样的内存指标",
      },
    );

    const snapshot = await readResourceUsageSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.processes.some((process) => process.name === "zcode-main")).toBe(true);
    expect(snapshot!.processes.some((process) => process.name.startsWith("zcode-host-"))).toBe(
      true,
    );
    // 所有进程行的 CPU 都是整机口径，总和不能超过 100%。
    expect(snapshot!.app.cpuPercent).toBeLessThanOrEqual(100);
    expect(snapshot!.app.memoryBytes).toBeGreaterThan(0);

    // UI 行与快照同源：DOM 里能找到 Agent 行。
    const rowNames = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="resource-manager-process-row"]'),
      ).map((element) => element.dataset.processName ?? ""),
    );
    expect(rowNames.some((name) => name.startsWith("zcode-agent-"))).toBe(true);

    const preferences = await browser.execute(() => ({
      theme: localStorage.getItem("zcode-theme"),
      locale: localStorage.getItem("zcode-locale-preference"),
    }));
    try {
      for (const theme of ["zai-light", "zai-dark"]) {
        for (const [width, locale, title] of [
          [640, "zh-CN", "任务进程"],
          [1200, "en-US", "Task processes"],
        ] as const) {
          await browser.electron.execute((electron, nextWidth) => {
            const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
              candidate.webContents.getURL().includes("resource-manager.html"),
            );
            window?.setSize(nextWidth, 700);
          }, width);
          await browser.execute(
            (nextTheme, nextLocale) => {
              localStorage.setItem("zcode-theme", nextTheme);
              localStorage.setItem("zcode-locale-preference", nextLocale);
            },
            theme,
            locale,
          );
          await browser.refresh();
          await waitForResourceManagerReady();
          const taskGroup = $('[data-testid="resource-manager-group-task"]');
          await expect(taskGroup).toHaveText(expect.stringContaining(title));
          await $('[data-process-name="zcode-main"]').waitForExist({ timeout: 10_000 });
          await browser.execute(() => {
            document
              .querySelector('[data-testid="resource-manager-group-task"]')
              ?.scrollIntoView({ block: "center", behavior: "instant" });
          });
          expect(
            await browser.execute(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
          await browser.saveScreenshot(
            join(
              process.env.ZCODE_E2E_ARTIFACT_DIR!,
              `resource-manager-${theme}-${locale}-${width}.png`,
            ),
          );
        }
      }
    } finally {
      await browser.execute((previous) => {
        for (const [key, value] of Object.entries({
          "zcode-theme": previous.theme,
          "zcode-locale-preference": previous.locale,
        })) {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      }, preferences);
    }

    await switchToElectronRendererTarget(isMainRendererUrl);
  });
});
