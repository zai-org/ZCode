import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ZCodePluginsOverviewResult } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  capturePluginManualReview,
  clickPluginControl,
  getPluginControlText,
  getPluginOverview,
  hasPluginControl,
  installMarketplacePluginThroughAgent,
  installPluginThroughUi,
  openManageView,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  selectPluginSettingsScope,
  setPluginPresentation,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

// PLM-EXT-STORE（docs/plugins/plugin-publishing.md §4.3–4.4）：商店按插件 API 版本挡住不兼容的扩展插件，
// 安装前在详情页显示「含常驻代码」与申请的权限。本地市场四个插件：
// - ok：engines ^1.4.0（App 的 EXTENSION_API_VERSION 是 1.4.0），申请完全访问与系统通知，可以装；
// - future：engines ^99.0.0，商店显示「需要更新 ZCode」，不能装；
// - installed：先装兼容的 1.0.0，目录再升到不兼容的 2.0.0：不显示更新，「全部更新」跳过它；
// - plain：不带扩展，安装与更新行为不变。
const CASE_ID = "PLM-EXT-STORE";
const MARKET = "e2e-ext-compat-market";
const OK = `e2e-ext-compat-ok@${MARKET}`;
const FUTURE = `e2e-ext-compat-future@${MARKET}`;
const INSTALLED_NAME = "e2e-ext-compat-installed";
const INSTALLED = `${INSTALLED_NAME}@${MARKET}`;
const PLAIN_NAME = "e2e-ext-compat-plain";
const PLAIN = `${PLAIN_NAME}@${MARKET}`;
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-store-extension-compat/store-market",
);

interface InstallButtonState {
  disabled: boolean;
  blocked: string | null;
  text: string;
}

/** 当前显示的那个安装按钮（列表卡片或详情页主按钮，同一时刻只显示一处）。 */
async function readInstallButton(pluginId: string): Promise<InstallButtonState | null> {
  return browser.execute((id) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="plugin-store-install"]'),
    ).find(
      (candidate) =>
        candidate.dataset.pluginId === id && candidate.getBoundingClientRect().height > 0,
    );
    if (!button) return null;
    return {
      disabled: button.disabled,
      blocked: button.dataset.installBlocked ?? null,
      text: button.textContent?.trim() ?? "",
    };
  }, pluginId);
}

/** 详情页「含常驻代码」一区：每个档位一行，完全访问另起一行。 */
async function readExtensionNotice(pluginId: string) {
  return browser.execute((id) => {
    const section = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="plugin-store-extension-notice"]'),
    ).find((candidate) => candidate.dataset.pluginId === id);
    if (!section) return null;
    const grants = Array.from(
      section.querySelectorAll<HTMLElement>('[data-testid="plugin-store-extension-grant"]'),
    ).map((row) => ({ grant: row.dataset.grant ?? "", text: row.textContent?.trim() ?? "" }));
    return {
      text: section.textContent ?? "",
      grants,
      fullAccess:
        section
          .querySelector<HTMLElement>('[data-testid="plugin-store-extension-full-access"]')
          ?.textContent?.trim() ?? null,
      noGrants: Boolean(section.querySelector('[data-testid="plugin-store-extension-no-grants"]')),
    };
  }, pluginId);
}

async function backToStoreList(): Promise<void> {
  await clickPluginControl("plugin-store-detail-back");
  await waitForPluginControl("plugin-store-list");
}

/** 目录与插件包都升到 2.0.0；installed 的新版要求 ^99.0.0。改的是添加市场时的来源目录，手动刷新时重新复制。 */
async function bumpCatalog(market: string): Promise<void> {
  const catalogPath = join(market, ".claude-plugin", "marketplace.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    plugins: Array<Record<string, unknown>>;
  };
  for (const entry of catalog.plugins) {
    if (entry.name !== INSTALLED_NAME && entry.name !== PLAIN_NAME) continue;
    entry.version = "2.0.0";
    if (entry.name === INSTALLED_NAME) {
      entry.extensionSummary = { engines: { zcode: "^99.0.0" }, grants: [] };
    }
    const manifestPath = join(
      market,
      "plugins",
      String(entry.name),
      ".zcode-plugin",
      "plugin.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = "2.0.0";
    if (entry.name === INSTALLED_NAME) manifest.extension = { engines: { zcode: "^99.0.0" } };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

function findAvailable(overview: ZCodePluginsOverviewResult, id: string) {
  return overview.availablePlugins.find((plugin) => plugin.id === id);
}

function findInstalled(overview: ZCodePluginsOverviewResult, id: string) {
  return overview.installedPlugins.find((plugin) => plugin.id === id);
}

const screenshots: string[] = [];

/** 列表与两个详情页：中文浅色、英文深色各一组。 */
async function captureStoreViews(label: "zh-CN-zai-light" | "en-US-zai-dark"): Promise<void> {
  await waitForPluginCard(FUTURE);
  screenshots.push(await capturePluginManualReview(CASE_ID, `store-list-${label}`));
  await openPluginCard(FUTURE);
  await waitForPluginControl("plugin-store-extension-incompatible", { pluginId: FUTURE });
  screenshots.push(await capturePluginManualReview(CASE_ID, `future-detail-${label}`));
  await backToStoreList();
  await openPluginCard(OK);
  await waitForPluginControl("plugin-store-extension-notice", { pluginId: OK });
  screenshots.push(await capturePluginManualReview(CASE_ID, `compatible-detail-${label}`));
  await backToStoreList();
}

describe("PLM-EXT-STORE 商店按插件 API 版本挡住不兼容的扩展插件", () => {
  after(async () => {
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir) {
      await writeFile(
        join(artifactDir, "plm-ext-store-evidence.json"),
        JSON.stringify({ screenshots }, null, 2),
      ).catch(() => {});
    }
    await clearAppData();
  });

  it("不兼容不能装、安装前显示扩展信息、不兼容的新版不提示更新", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    const { homeDir } = getE2EAppDataPaths();
    const market = join(homeDir, "fixtures", "ext-store-compat", "store-market");
    await mkdir(market, { recursive: true });
    await cp(FIXTURE_ROOT, market, { recursive: true, force: true });
    await addMarketplaceSourceThroughAgent(market);
    await waitUntilPluginOverview(
      (overview) =>
        [OK, FUTURE, INSTALLED, PLAIN].every((id) => findAvailable(overview, id) !== undefined),
      "the local market should list all four plugins",
      60000,
    );
    await installMarketplacePluginThroughAgent(INSTALLED_NAME, MARKET);

    // services 读到 CLI 的能力位后才要扩展摘要（§4.3）；没有扩展的插件不带，componentTypes 透传 extension。
    const initial = await getPluginOverview();
    expect(findAvailable(initial, OK)?.listing?.extensionSummary).toEqual({
      engines: { zcode: "^1.4.0" },
      grants: ["sessions.fullAccess", "notifications"],
    });
    expect(findAvailable(initial, OK)?.componentTypes).toContain("extension");
    expect(findAvailable(initial, FUTURE)?.listing?.extensionSummary?.engines.zcode).toBe(
      "^99.0.0",
    );
    expect(findAvailable(initial, PLAIN)?.listing?.extensionSummary).toBeUndefined();
    expect(findAvailable(initial, PLAIN)?.componentTypes ?? []).not.toContain("extension");

    // (a) 列表：不兼容的插件按钮是不能点的「需要更新 ZCode」；兼容的与普通的照常「安装」。
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(FUTURE);
    expect(await readInstallButton(FUTURE)).toEqual({
      disabled: true,
      blocked: "requires-update",
      text: "需要更新 ZCode",
    });
    expect(await readInstallButton(OK)).toEqual({ disabled: false, blocked: null, text: "安装" });
    expect(await readInstallButton(PLAIN)).toEqual({
      disabled: false,
      blocked: null,
      text: "安装",
    });

    // (b) 不兼容插件的详情页：按钮不能点，简介下有说明；照样显示含常驻代码与申请的权限。
    await openPluginCard(FUTURE);
    expect(await readInstallButton(FUTURE)).toMatchObject({
      disabled: true,
      blocked: "requires-update",
    });
    expect(
      await getPluginControlText("plugin-store-extension-incompatible", { pluginId: FUTURE }),
    ).toContain("更新 ZCode");
    const futureNotice = await readExtensionNotice(FUTURE);
    expect(futureNotice?.text).toContain("含常驻代码");
    expect(futureNotice?.grants).toEqual([{ grant: "sessions.read", text: "读取会话" }]);
    expect(futureNotice?.fullAccess).toBeNull();
    await backToStoreList();

    // (c) 兼容插件的详情页：档位按授权对话框的档位名列出，完全访问单独一行写明含义。
    await openPluginCard(OK);
    expect(await hasPluginControl("plugin-store-extension-incompatible", { pluginId: OK })).toBe(
      false,
    );
    const okNotice = await readExtensionNotice(OK);
    expect(okNotice?.text).toContain("含常驻代码");
    expect(okNotice?.grants).toEqual([
      { grant: "sessions.fullAccess", text: "读写会话（含完全访问）" },
      { grant: "notifications", text: "发送系统通知" },
    ]);
    expect(okNotice?.fullAccess).toMatch(/^完全访问：/);
    expect(okNotice?.noGrants).toBe(false);
    await backToStoreList();

    // (d) 普通插件：详情页没有扩展信息。
    await openPluginCard(PLAIN);
    expect(await readExtensionNotice(PLAIN)).toBeNull();
    await backToStoreList();

    await captureStoreViews("zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await captureStoreViews("en-US-zai-dark");
    await openPluginCard(FUTURE);
    expect(await readInstallButton(FUTURE)).toMatchObject({
      disabled: true,
      text: "Requires newer ZCode",
    });
    expect((await readExtensionNotice(FUTURE))?.text).toContain("Includes resident code");
    await backToStoreList();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (e) 兼容插件与普通插件照常从商店安装；装上后详情页换成「权限」区块，不再显示安装前的说明。
    await openPluginCard(OK);
    await installPluginThroughUi(OK);
    await waitUntilPluginOverview(
      (overview) => findInstalled(overview, OK) !== undefined,
      "the compatible extension plugin should install",
      60000,
    );
    await browser.waitUntil(
      async () => !(await hasPluginControl("plugin-store-extension-notice", { pluginId: OK })),
      { timeout: 15000, timeoutMsg: "the pre-install notice should leave after install" },
    );
    await backToStoreList();
    await openPluginCard(PLAIN);
    await installPluginThroughUi(PLAIN);
    await waitUntilPluginOverview(
      (overview) => findInstalled(overview, PLAIN) !== undefined,
      "the plain plugin should install",
      60000,
    );
    await backToStoreList();

    // (f) 目录升级：installed 的新版要 ^99.0.0，plain 的新版普通。CLI 两个都报 update-available。
    await bumpCatalog(market);
    await clickPluginControl("plugin-store-refresh");
    await waitUntilPluginOverview(
      (overview) =>
        findInstalled(overview, INSTALLED)?.updateStatus === "update-available" &&
        findInstalled(overview, INSTALLED)?.listing?.extensionSummary?.engines.zcode ===
          "^99.0.0" &&
        findInstalled(overview, PLAIN)?.updateStatus === "update-available",
      "both installed plugins should report a newer catalog version",
      60000,
    );
    // App 显示前按兼容过滤：plain 有「可更新」，installed 没有角标、没有更新按钮。
    await waitForPluginControl("plugin-store-update-badge", { pluginId: PLAIN }, 30000);
    expect(await hasPluginControl("plugin-store-card-update", { pluginId: PLAIN })).toBe(true);
    expect(await hasPluginControl("plugin-store-update-badge", { pluginId: INSTALLED })).toBe(
      false,
    );
    expect(await hasPluginControl("plugin-store-card-update", { pluginId: INSTALLED })).toBe(false);
    // 刷新后个人分段还会列出其他市场：把本地市场的卡片滚到视野里再截图。
    await browser.execute((id) => {
      document
        .querySelector<HTMLElement>(`[data-testid="plugin-store-card"][data-plugin-id="${id}"]`)
        ?.scrollIntoView({ block: "center" });
    }, PLAIN);
    screenshots.push(await capturePluginManualReview(CASE_ID, "updates-zh-CN-zai-light"));
    await openPluginCard(INSTALLED);
    expect(await hasPluginControl("plugin-store-card-update", { pluginId: INSTALLED })).toBe(false);
    expect(await hasPluginControl("plugin-store-detail-update")).toBe(false);
    await backToStoreList();

    // (g) 「全部更新」只算 plain，执行后 installed 仍是 1.0.0，照常启用。
    await openManageView();
    await selectPluginSettingsScope("user");
    await waitForPluginControl("plugin-settings-update-all");
    expect(await getPluginControlText("plugin-settings-update-all")).toContain("（1）");
    screenshots.push(await capturePluginManualReview(CASE_ID, "update-all-zh-CN-zai-light"));
    await clickPluginControl("plugin-settings-update-all");
    await waitUntilPluginOverview(
      (overview) => findInstalled(overview, PLAIN)?.version === "2.0.0",
      "update-all should update the plain plugin",
      60000,
    );
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-settings-update-all")), {
      timeout: 15000,
      timeoutMsg: "update-all should leave once only the incompatible update remains",
    });
    const final = await getPluginOverview();
    expect(findInstalled(final, INSTALLED)).toMatchObject({
      version: "1.0.0",
      enabled: true,
      updateStatus: "update-available",
    });
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    screenshots.push(await capturePluginManualReview(CASE_ID, "after-update-all-en-US-zai-dark"));
  });
});
