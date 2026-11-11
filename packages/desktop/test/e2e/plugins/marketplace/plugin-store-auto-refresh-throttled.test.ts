import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  PLUGIN_CDN_ZIP_ID,
  PLUGIN_CDN_ZIP_MARKETPLACE_ID,
  PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED,
} from "#e2e/helpers/plugin-cdn-zip-marketplace";
import {
  capturePluginManualReview,
  getPluginOverview,
  hasPluginControl,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginCard,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const THROTTLED_TIMEOUT_MS = 120000;
// 自动刷新若被误触发，operationId 会立刻置为 marketplace:update:*；等一个远大于 UI 调度延迟
// 的窗口再取 overview，确认 lastUpdated 与 seed 值一致即证明没有发起刷新。
const NO_REFRESH_SETTLE_MS = 5000;

function readOfficialLastUpdated(
  overview: Awaited<ReturnType<typeof getPluginOverview>>,
): string | undefined {
  return overview.marketplaces.find((item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID)
    ?.lastUpdated;
}

describe("PLM-LC-018 Desktop plugin store auto refresh throttled", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("官方市场 1 分钟前刷新过，进入与重进商店页都不再刷新", async function () {
    this.timeout(THROTTLED_TIMEOUT_MS);
    requirePluginManualReview();
    await waitForDefaultWorkspaceReady();

    // wdio seed 把官方市场 lastUpdated 写成启动前 1 分钟（命中 10 分钟节流窗口）。
    const seeded = await getPluginOverview();
    const seededLastUpdated = readOfficialLastUpdated(seeded);
    if (!seededLastUpdated) throw new Error("Seeded official marketplace has no lastUpdated");
    expect(Date.now() - Date.parse(seededLastUpdated)).toBeLessThan(10 * 60_000);

    await openPluginSettings();
    await waitForPluginCard(PLUGIN_CDN_ZIP_ID, 60000);
    await browser.pause(NO_REFRESH_SETTLE_MS);
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(seededLastUpdated);
    expect(await hasPluginControl("plugin-store-error")).toBe(false);

    // 离开商店页再重进（重新挂载），仍在窗口内，同样不刷新。
    // 商店顶栏返回聊天，再从侧栏进入，保证 PluginStorePage 真正重新挂载。
    await clickTestIdByDom("desktop-top-nav-back");
    await clickTestIdByDom("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-root", {}, 30000);
    await waitForPluginCard(PLUGIN_CDN_ZIP_ID, 60000);
    await browser.pause(NO_REFRESH_SETTLE_MS);
    const after = await getPluginOverview();
    expect(readOfficialLastUpdated(after)).toBe(seededLastUpdated);
    expect(
      after.marketplaces.find((item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID)?.refreshFailure,
    ).toBeUndefined();
    // claude-plugins-official 不是强依赖：进入商店页不得对它发起任何拉取（无失败痕迹、时间戳不变）。
    const claude = after.marketplaces.find((item) => item.id === "claude-plugins-official");
    expect(claude?.refreshFailure).toBeUndefined();
    expect(claude?.lastUpdated).toBe(PLUGIN_CDN_ZIP_OFFLINE_LAST_UPDATED);
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    await capturePluginManualReview("PLM-LC-018", "throttled-reenter");
  });
});
