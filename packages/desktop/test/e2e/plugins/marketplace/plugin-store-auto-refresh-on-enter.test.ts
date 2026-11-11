import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  PLUGIN_CDN_ZIP_MARKETPLACE_ID,
  PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED,
} from "#e2e/helpers/plugin-cdn-zip-marketplace";
import {
  capturePluginManualReview,
  getPluginOverview,
  hasPluginControl,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

// 本例验证真实官方市场刷新，需要可访问公网 CDN；模型 replay 不替代市场 HTTP 请求。
// 已迁入正式目录，直接按本文件运行，不再依赖 manual-review 的 capture 或 HOLD_MS 配置。
const CDN_REFRESH_TIMEOUT_MS = 180000;
const NO_REFRESH_SETTLE_MS = 5000;

function readOfficialLastUpdated(
  overview: Awaited<ReturnType<typeof getPluginOverview>>,
): string | undefined {
  return overview.marketplaces.find((item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID)
    ?.lastUpdated;
}

describe("PLM-LC-019 Desktop plugin store auto refresh on enter (real official CDN)", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("官方市场刷新时间过期时，进入商店页不点刷新也会自动刷新，重进则命中节流", async function () {
    requirePluginManualReview();
    await waitForDefaultWorkspaceReady();

    // wdio seed 把官方市场 lastUpdated 写成远古时间且 pluginCount>0，必然落在节流窗口外。
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(
      PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED,
    );
    const enteredAt = Date.now();

    await openPluginSettings();
    let refreshedLastUpdated: string | undefined;
    let official: Awaited<ReturnType<typeof getPluginOverview>>["marketplaces"][number] | undefined;
    await browser
      .waitUntil(
        async () => {
          official = (await getPluginOverview()).marketplaces.find(
            (item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID,
          );
          // 刷新失败会被持久化成 refreshFailure；直接带着诊断失败，不要空等到超时。
          if (official?.refreshFailure) {
            throw new Error(
              `Official marketplace auto refresh failed: ${JSON.stringify(official.refreshFailure)}`,
            );
          }
          refreshedLastUpdated = official?.lastUpdated;
          return (
            refreshedLastUpdated !== undefined &&
            refreshedLastUpdated !== PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED
          );
        },
        {
          timeout: CDN_REFRESH_TIMEOUT_MS,
          interval: 2000,
          timeoutMsg: "Entering the plugin store did not auto refresh the official marketplace",
        },
      )
      .catch((error: unknown) => {
        // 超时时把官方市场记录一并带出，便于区分「没触发」与「触发了但落盘异常」。
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; official=${JSON.stringify(official)}`,
        );
      });
    if (!refreshedLastUpdated) throw new Error("Official marketplace lastUpdated missing");
    // 允许 agent/renderer 时钟有秒级偏差。
    expect(Date.parse(refreshedLastUpdated)).toBeGreaterThanOrEqual(enteredAt - 60_000);
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    await capturePluginManualReview("PLM-LC-019", "auto-refreshed-on-enter");

    // 刚刷新过：离开再重进商店页命中 10 分钟窗口，不再刷新。
    // 商店顶栏返回聊天，再从侧栏进入，保证 PluginStorePage 真正重新挂载。
    await clickTestIdByDom("desktop-top-nav-back");
    await clickTestIdByDom("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-root", {}, 30000);
    await browser.pause(NO_REFRESH_SETTLE_MS);
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(refreshedLastUpdated);
  });
});
