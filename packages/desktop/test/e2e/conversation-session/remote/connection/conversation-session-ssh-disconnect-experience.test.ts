import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_SETTINGS_BACK_BUTTON, TID_SETTINGS_PAGE } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  connectRemoteSourceFromSettings,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import {
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4ComposerText,
  getV4QueueItems,
  getV4Messages,
} from "#e2e/helpers/v4-conversation";
import {
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  openSSHRemoteDialog,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_RDUX_08_DISCONNECT";
const DRAFT = `${CASE_MARKER}_UNSENT_DRAFT`;

describe(`${CASE_MARKER}: 断线会话与原地重连`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-08-01/02/03 设置页主动断开后不空白、草稿不提交，项目原地重连与设置页重连", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[0],
    });
    if (!tab.workspaceIdentity) throw new Error(`${CASE_MARKER}: 缺少 workspace identity`);
    const sourceId = parseRemoteWorkspaceIdentity(tab.workspaceIdentity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 缺少 Source identity`);
    await setV4ComposerText(DRAFT);
    // 走原空白页路径：会话 -> 设置设备卡断开 -> 返回原会话。
    await disconnectRemoteSource(sourceId, CASE_MARKER);
    const banner = $('[data-testid="remote-conversation-banner"]');
    await banner.waitForDisplayed({ timeout: 30_000 });
    expect(await banner.getAttribute("data-connection-state")).toBe("offline");
    expect(
      await browser.execute(
        () =>
          document.body.textContent?.includes("设备未连接，连接后继续此会话") ||
          document.body.textContent?.includes("Reconnect to continue this conversation."),
      ),
    ).toBe(true);
    expect(
      await browser.execute(
        (draft) =>
          Array.from(document.querySelectorAll<HTMLElement>("[contenteditable], textarea")).some(
            (input) =>
              (input instanceof HTMLTextAreaElement ? input.value : input.textContent)?.includes(
                draft,
              ),
          ),
        DRAFT,
      ),
    ).toBe(true);
    const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rdux08");
    await mkdir(artifactDir, { recursive: true });
    const originalSize = await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.getSize(),
    );
    for (const theme of ["light", "dark"]) {
      await browser.execute((value) => {
        const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
          .__testActions;
        if (!actions) throw new Error("Missing theme test actions");
        actions.setTheme(value);
      }, theme);
      for (const width of [1400, 480]) {
        await browser.electron.execute((electron, nextWidth) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => !window.isDestroyed())
            ?.setSize(nextWidth, 900);
        }, width);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        // 窄窗口会自动收起侧栏；连续采样确认位置稳定，避免把动画帧当作视觉证据。
        let previousLayout = "";
        let stableSamples = 0;
        await browser.waitUntil(
          async () => {
            const layout = await browser.execute(() => {
              const banner = document
                .querySelector('[data-testid="remote-conversation-banner"]')
                ?.getBoundingClientRect();
              return banner
                ? {
                    left: Math.round(banner.left * 100) / 100,
                    right: Math.round(banner.right * 100) / 100,
                    width: banner.width,
                    viewport: window.innerWidth,
                  }
                : null;
            });
            const serialized = JSON.stringify(layout);
            stableSamples = serialized === previousLayout ? stableSamples + 1 : 0;
            previousLayout = serialized;
            return Boolean(
              layout &&
              layout.width > 0 &&
              layout.left >= -1 &&
              layout.right <= layout.viewport + 1 &&
              stableSamples >= 2,
            );
          },
          {
            timeout: 5000,
            interval: 100,
            timeoutMsg: `${CASE_MARKER}: ${theme}/${width} 横幅布局未稳定或超出窗口`,
          },
        );
        const noControlOverlap = await browser.execute(() => {
          const reason = document.querySelector('[data-testid="remote-send-unavailable"]');
          const leading = document.querySelector("[data-composer-leading-content]");
          return (
            !reason ||
            !leading ||
            reason.getBoundingClientRect().left >= leading.getBoundingClientRect().right - 1
          );
        });
        await browser.saveScreenshot(
          resolve(artifactDir, `disconnected-conversation-${theme}-${width}.png`),
        );
        expect(noControlOverlap).toBe(true);
      }
    }
    if (originalSize)
      await browser.electron.execute((electron, size) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed())
          ?.setSize(size[0]!, size[1]!);
      }, originalSize);
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );

    const projectOpen = $(
      `[data-project-workspace-identity="${tab.workspaceIdentity}"] [data-testid="virtual-project-toggle"] .truncate.text-ui-base`,
    );
    if (!(await projectOpen.isDisplayed())) {
      for (const toggle of await $$('button[aria-label="切换侧边栏"]')) {
        if (await toggle.isDisplayed()) {
          await toggle.click();
          break;
        }
      }
      await projectOpen.waitForDisplayed();
    }
    // 观察整个连接期间，不能只在成功之后断言向导已关闭。
    await browser.execute(() => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="ssh-dialog"]'))
          document.body.dataset.rduxUnexpectedWizard = "true";
      });
      observer.observe(document.body, { subtree: true, childList: true });
      (window as unknown as { __rduxObserver: MutationObserver }).__rduxObserver = observer;
    });
    // 新标题只折叠历史；原地恢复应使用项目菜单的连接动作。
    await requestRemoteProjectConnection(tab.workspaceIdentity, CASE_MARKER);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: tab.workspaceIdentity,
      expectedPath: config.workspacePaths[0],
      requireActive: false,
    });
    expect(
      await browser.execute(() => {
        (window as unknown as { __rduxObserver: MutationObserver }).__rduxObserver.disconnect();
        return document.body.dataset.rduxUnexpectedWizard ?? "false";
      }),
    ).toBe("false");
    await banner.waitForDisplayed({ reverse: true, timeout: 30_000 });
    await waitForV4ComposerText(DRAFT, `${CASE_MARKER}: 重连丢失草稿`);
    expect(await getV4QueueItems()).toHaveLength(0);
    expect((await getV4Messages("user")).some((message) => message.text.includes(DRAFT))).toBe(
      false,
    );

    await disconnectRemoteSource(sourceId, CASE_MARKER);
    const countBefore = (await readSettings()).lastWorkspaceSession?.length;
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    // 设置入口连接完成后留在设备管理；旧用例继续点击已移除的目录步骤导致假失败。
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("closed");
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    await $(
      `[data-source-server-card="${sourceId}"] [data-remote-connection-status="online"]`,
    ).waitForDisplayed();
    expect(await $('[data-testid="virtual-project-name"]').isExisting()).toBe(false);
    expect((await readSettings()).lastWorkspaceSession?.length).toBe(countBefore);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await waitForV4ComposerText(DRAFT, `${CASE_MARKER}: 设置重连丢失草稿`);
  });
});
