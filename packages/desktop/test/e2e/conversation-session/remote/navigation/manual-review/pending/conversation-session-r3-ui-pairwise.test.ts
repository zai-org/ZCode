import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { connectSSHWorkspace, readSSHRuntimeConfig } from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
const CASE_MARKER = "E2E_R3_UI_PAIRWISE";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-ui-pairwise");
const NARROW = { width: 960, height: 700 };

/** Electron 下 WebDriver setWindowSize 不可用（Browser.getWindowForTarget 缺失），改经 main 进程设置主窗口尺寸。 */
async function setWindowSize(width: number, height: number): Promise<number> {
  const startedAt = Date.now();
  await browser.electron.execute(
    (electron, w, h) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      win?.setSize(w, h);
    },
    width,
    height,
  );
  await browser.waitUntil(
    async () => {
      const geometry = await browser.electron.execute((electron) => {
        const win = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
        return win ? { size: win.getSize(), content: win.getContentSize() } : null;
      });
      const viewport = await browser.execute(() => [innerWidth, innerHeight]);
      return Boolean(
        geometry &&
        geometry.size[0] === width &&
        geometry.size[1] === height &&
        geometry.content[0] === viewport[0] &&
        geometry.content[1] === viewport[1],
      );
    },
    { timeout: 10_000, interval: 100, timeoutMsg: "窗口尺寸与 Renderer viewport 未收敛" },
  );
  return Date.now() - startedAt;
}

async function setLocaleAndTheme(
  locale: "zh-CN" | "en-US",
  theme: "light" | "dark",
): Promise<{ locale: string; theme: string }> {
  const read = () =>
    browser.execute(() => {
      const actions = (
        window as Window & { __testActions?: { getLocale?: () => string; getTheme?: () => string } }
      ).__testActions;
      return { locale: actions?.getLocale?.() ?? "", theme: actions?.getTheme?.() ?? "" };
    });
  await browser.execute(
    (nextLocale, nextTheme) => {
      const actions = (
        window as Window & {
          __testActions?: { setLocale?: (l: string) => void; setTheme?: (t: string) => void };
        }
      ).__testActions;
      actions?.setLocale?.(nextLocale);
      actions?.setTheme?.(nextTheme);
    },
    locale,
    theme,
  );
  // locale/theme 切换为异步状态更新：最多等 10s 收敛。
  let state = await read();
  await browser.waitUntil(
    async () => {
      state = await read();
      return state.locale === locale && state.theme.includes(theme);
    },
    { timeout: 10_000, interval: 300, timeoutMsg: "locale-theme" },
  );
  return state;
}

/** 视口内可见的关键元素是否被裁切/横向溢出，以及焦点是否落在可见元素上。 */
async function readLayoutHealth(selectors: string[]): Promise<{
  overflowX: boolean;
  clipped: string[];
  focusVisible: boolean;
  htmlClass: string;
  bodyText: string;
}> {
  return browser.execute((list) => {
    const clipped: string[] = [];
    for (const selector of list) {
      for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (
          rect.left < -1 ||
          rect.right > window.innerWidth + 1 ||
          rect.top < -1 ||
          rect.bottom > window.innerHeight + 1
        )
          clipped.push(
            `${selector}@${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}`,
          );
      }
    }
    const active = document.activeElement as HTMLElement | null;
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      clipped: clipped.slice(0, 10),
      focusVisible: Boolean(active && active !== document.body && active.getClientRects().length),
      htmlClass: document.documentElement.className,
      bodyText: (document.body?.innerText ?? "").replace(/\s+/gu, " ").slice(0, 2000),
    };
  }, selectors);
}

describe(`${CASE_MARKER}: 项目导航中英文/深浅主题与窄窗口`, () => {
  const facts: Array<Record<string, unknown>> = [];
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "ui-pairwise.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("R3A-UI-03 英文深色窄窗口与中文浅色桌面下，设备标注、项目菜单、离线入口与重连保持可见可用", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(artifactDir, { recursive: true });
    const scenarios = [
      {
        locale: "en-US" as const,
        theme: "dark" as const,
        width: NARROW.width,
        height: NARROW.height,
      },
      { locale: "zh-CN" as const, theme: "light" as const, width: 1280, height: 900 },
    ];
    let identity: string | undefined;
    for (const scenario of scenarios) {
      const current: Record<string, unknown> = { ...scenario };
      facts.push(current);
      current.resizeMs = await setWindowSize(scenario.width, scenario.height);
      const appearance = await setLocaleAndTheme(scenario.locale, scenario.theme);
      expect(appearance.locale).toBe(scenario.locale);
      expect(appearance.theme).toContain(scenario.theme);
      if (!identity) {
        const tab = await connectSSHWorkspace({
          config,
          caseMarker: CASE_MARKER,
          workspacePath: config.workspacePaths[0],
        });
        identity = tab.workspaceIdentity!;
      }
      const sourceId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
      if (!sourceId) throw new Error("缺少 Source 身份");
      const selector = `[data-project-workspace-identity="${identity}"]`;
      const row = $(selector);
      expect(await row.getAttribute("data-connection-state")).toBe("online");
      // 项目整合后设备标签只负责展示；详情弹层已移除，操作由项目菜单承载。
      const deviceName = (await readSettings()).sourceServers?.find(
        (source) => source.sourceServerId === sourceId,
      )?.displayName;
      expect(deviceName).toBeTruthy();
      const device = row.$('[data-testid="project-device"]');
      // 设备原生 title 已迁入统一身份详情；检查可见名称和真实 hover，避免旧属性让后续矩阵提前失败。
      expect(await device.getText()).toBe(deviceName);
      await row.$('[data-testid="virtual-project-toggle"]').moveTo();
      const details = $('[data-testid="remote-identity-details"]');
      await details.waitForDisplayed();
      current.identityDetails = await details.getText();
      expect(current.identityDetails).toContain(deviceName);
      expect(current.identityDetails).toContain(config.workspacePaths[0]);
      expect(await details.$$("button")).toHaveLength(0);
      const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
      await browser.action("pointer").move(outside).perform();
      await details.waitForDisplayed({ reverse: true });
      await row.moveTo();
      const trigger = row.$('[data-testid="virtual-project-menu"]');
      await trigger.click();
      const menuId = await trigger.getAttribute("aria-controls");
      expect(menuId).toBeTruthy();
      const menuSelector = `[id=${JSON.stringify(menuId)}]`;
      const menu = $(menuSelector);
      await menu.waitForDisplayed({ timeout: 15_000 });
      expect(await menu.getText()).toMatch(
        scenario.locale === "en-US" ? /Edit|Delete|Remove/iu : /编辑|删除|移除/u,
      );
      current.deviceName = deviceName;
      current.menuText = await menu.getText();
      await menu.$('[data-testid="virtual-project-edit"]').click();
      const editorSelector = '[role="dialog"]:has([data-testid="virtual-project-name"])';
      const editor = $(editorSelector);
      await editor.waitForDisplayed();
      expect(
        await editor.$('[data-testid="virtual-project-root-name"]').getAttribute("title"),
      ).toBe(config.workspacePaths[0]);
      // 菜单退场与 Dialog autofocus 分别提交；显示节点后仍需等待焦点实际进入编辑器。
      await browser
        .waitUntil(
          () =>
            browser.execute((selector) => {
              const editor = document.querySelector(selector);
              const active = document.activeElement;
              return Boolean(
                editor && active && editor.contains(active) && active.getClientRects().length,
              );
            }, editorSelector),
          { timeout: 5000, timeoutMsg: "项目编辑器未获得可见焦点" },
        )
        .catch(async (cause: unknown) => {
          current.focusFailure = await browser.execute(() => ({
            tag: document.activeElement?.tagName,
            testId: document.activeElement?.getAttribute("data-testid"),
          }));
          throw cause;
        });
      const health = await readLayoutHealth([selector, editorSelector]);
      expect(health.overflowX).toBe(false);
      expect(health.clipped).toEqual([]);
      expect(health.focusVisible).toBe(true);
      await browser.saveScreenshot(
        resolve(artifactDir, `${scenario.locale}-${scenario.theme}.png`),
      );
      await browser.keys("Escape");
      await disconnectRemoteSource(sourceId, CASE_MARKER, { workspaceIdentities: [identity] });
      expect(await row.isDisplayed()).toBe(true);
      await reconnectRemoteProject(identity, CASE_MARKER);
      expect(await row.getAttribute("data-connection-state")).toBe("online");
      current.health = health;
    }
  });
});
