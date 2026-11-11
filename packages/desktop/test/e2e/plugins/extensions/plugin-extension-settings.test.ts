// PLM-EXT-P2D：插件设置与扩展的 settings 能力（docs/plugins/extension-host.md §16.7；存储见 CLI spec
// apps/zcode-cli/docs/design/v2/plugin-compat.md「Sensitive Option Storage」）。
// 隔离 HOME：两个纯 JS fixture 扩展（test/e2e/fixtures/fs/plugins/plugin-extension-settings/）经 plugins.dirs 加载：
// - e2e-ext-settings：userConfig 有敏感键 token 与普通键 region（默认 eu）。env.onDidChange 时调 settings.get，
//   另订阅 settings.onDidChange。日志只有 hasToken、token 长度、region 与键名。
//   视图 account 的工具 login / logout 调 settings.update（P4 H1，§18.1），用例经沙箱页面调这两个工具。
// - e2e-ext-settings-other：只有自己的 mode（默认 lite），验证 settings.get 拿不到别的插件的值，
//   settings.update 写不了不属于它的键（第一次 env 时试写，都应报 invalid-input）。
// 设置经真实的设置页（插件管理详情 → 高级）保存与清除。不需要模型。
// 运行时证据：Main 日志（[extensions] / fixture 的 E2E_SETTINGS_*）、隔离 HOME 的 config.json 与
// plugin-secrets.json、设置页 DOM；扫描隔离 HOME 与 App 数据目录，token 原文只能出现在 plugin-secrets.json。
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_NAV_PRIMARY_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SIDE_PANE_EXTENSION_VIEW_ITEM,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  createExtensionLog,
  evaluateInViewPage,
  openLauncher,
  openLauncherView,
  waitForViewPane,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  clickPluginControl,
  openInstalledPluginSettingsAdvanced,
  openPluginManagementSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P2D";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-settings",
);
const PLUGINS = ["e2e-ext-settings", "e2e-ext-settings-other"];
const PLUGIN_ID = "e2e-ext-settings@inline";
// 每次运行一个新值：扫描泄露时不会被历史文件误判。
const TOKEN = `E2E-SECRET-${randomUUID()}`;
// settings.update 写入的第二个值（P4 H1）：与设置页保存的值不同，扫描时能分开判断。
const UPDATE_TOKEN = `E2E-UPDATE-${randomUUID()}`;
const REGION = "us-east";
const UPDATED_REGION = "ap-south";
const ACCOUNT_VIEW = `${PLUGIN_ID}/account`;

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

function cliPath(...segments: string[]): string {
  return join(getE2EAppDataPaths().homeDir, ".zcode", "cli", ...segments);
}

async function seedFixtures(): Promise<void> {
  const target = join(getE2EAppDataPaths().homeDir, "fixtures", "extension-settings");
  await mkdir(target, { recursive: true });
  for (const name of PLUGINS) {
    await cp(join(FIXTURE_ROOT, name), join(target, name), { recursive: true, force: true });
  }
  await writePluginDirsConfig(
    PLUGINS.map((name) => join(target, name)),
    PLUGINS.map((name) => `${name}@inline`),
  );
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Record<string, unknown>;
}

/** `~/.zcode/cli/config.json` 里本插件 user 层的选项。 */
async function readConfigOptions(): Promise<Record<string, unknown>> {
  const config = await readJson(cliPath("config.json"));
  const plugins = (config.plugins ?? {}) as { options?: Record<string, Record<string, unknown>> };
  return plugins.options?.[PLUGIN_ID] ?? {};
}

/** `~/.zcode/cli/plugin-secrets.json` 里本插件 user 层的敏感值。 */
async function readSecretOptions(): Promise<Record<string, unknown>> {
  const secrets = (await readJson(cliPath("plugin-secrets.json"))) as {
    user?: Record<string, Record<string, unknown>>;
  };
  return secrets.user?.[PLUGIN_ID] ?? {};
}

async function setConfigInput(configKey: string, value: string): Promise<void> {
  await waitForPluginControl("plugin-store-config-input", { configKey });
  const done = await browser.execute(
    (key, next) => {
      const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === "plugin-store-config-input" &&
          candidate.dataset.configKey === key,
      );
      if (!(element instanceof HTMLInputElement)) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        element,
        next,
      );
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: next }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    configKey,
    value,
  );
  if (!done) throw new Error(`could not set the plugin config input ${configKey}`);
}

interface ConfigUi {
  tokenInputType: string | null;
  tokenValueLength: number;
  region: string | null;
  clearKeys: string[];
  scopes: Record<string, string>;
}

/** 设置页里本插件的配置区：敏感输入框类型、清除按钮、scope 标记（不读 token 值本身）。 */
async function readConfigUi(): Promise<ConfigUi> {
  return browser.execute((pluginId) => {
    const section = document.querySelector<HTMLElement>(
      `[data-testid="plugin-store-config"][data-plugin-id="${pluginId}"]`,
    );
    const input = (key: string) =>
      section?.querySelector<HTMLInputElement>(
        `[data-testid="plugin-store-config-input"][data-config-key="${key}"]`,
      ) ?? null;
    const scopes: Record<string, string> = {};
    for (const label of Array.from(section?.querySelectorAll<HTMLElement>("label") ?? [])) {
      const key = label.querySelector<HTMLElement>("[data-config-key]")?.dataset.configKey;
      const scope =
        label.querySelector<HTMLElement>("[data-settings-scope]")?.dataset.settingsScope;
      if (key && scope) scopes[key] = scope;
    }
    return {
      tokenInputType: input("token")?.type ?? null,
      tokenValueLength: input("token")?.value.length ?? 0,
      region: input("region")?.value ?? null,
      clearKeys: Array.from(
        section?.querySelectorAll<HTMLElement>('[data-testid="plugin-store-config-clear"]') ?? [],
      ).map((element) => element.dataset.configKey ?? ""),
      scopes,
    };
  }, PLUGIN_ID);
}

async function waitForConfigUi(
  predicate: (ui: ConfigUi) => boolean,
  message: string,
): Promise<ConfigUi> {
  let latest: ConfigUi | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readConfigUi();
      return predicate(latest);
    },
    { timeout: 30000, interval: 300, timeoutMsg: `${message}: ${JSON.stringify(latest)}` },
  );
  return latest!;
}

/** 等 from 行之后出现满足条件的日志行（启动时的语言可能已经是 en-US，旧的探测行不能算）。 */
async function waitForLogAfter(
  from: number,
  predicate: (line: string) => boolean,
  message: string,
): Promise<string> {
  let found = "";
  await browser.waitUntil(
    async () => {
      found = (await log.lines()).slice(from).find(predicate) ?? "";
      return Boolean(found);
    },
    { timeout: 30000, interval: 500, timeoutMsg: message },
  );
  return found;
}

/** 递归找含 needle 的文件（只读 ≤ 20MB 的文件）。 */
async function findFilesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const bytes = Buffer.from(needle);
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path).catch(() => null);
        if (!info || info.size > 20 * 1024 * 1024) continue;
        const content = await readFile(path).catch(() => null);
        if (content?.includes(bytes)) hits.push(path);
      }
    }
  };
  await walk(root);
  return hits;
}

/** 隔离 HOME、App 数据目录与运行时日志目录里含 needle 的文件。 */
async function scanLeaks(needle: string): Promise<{ roots: string[]; hits: string[] }> {
  const { homeDir, appDataDir } = getE2EAppDataPaths();
  const roots = [
    ...new Set([homeDir, appDataDir, process.env.ZCODE_E2E_RUNTIME_LOG_DIR ?? ""]),
  ].filter(Boolean);
  const hits = (await Promise.all(roots.map((root) => findFilesContaining(root, needle)))).flat();
  return { roots, hits: [...new Set(hits)] };
}

/** `~/.zcode/cli/config.json` 里另一个插件 user 层的选项。 */
async function readOtherConfigOptions(): Promise<Record<string, unknown>> {
  const config = await readJson(cliPath("config.json"));
  const plugins = (config.plugins ?? {}) as { options?: Record<string, Record<string, unknown>> };
  return plugins.options?.["e2e-ext-settings-other@inline"] ?? {};
}

/** 某个元素里第一个 svg 的 class（Lucide 图标带 `lucide-<名字>`）。 */
async function readIconClass(selector: string): Promise<string | null> {
  return browser.execute(
    (target) => document.querySelector(target)?.querySelector("svg")?.getAttribute("class") ?? null,
    selector,
  );
}

/** 在 account 视图的沙箱页面里调视图工具（与 GitLab 面板页面调 login 同一条路径），返回 CallToolResult。 */
async function callAccountTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const pane = await waitForViewPane(
    ACCOUNT_VIEW,
    (item) => item.phase === "running" && item.displayed,
    "the account view should be running",
  );
  const raw = await evaluateInViewPage<string>(
    pane.sandbox!,
    `window.zcode.ready()
      .then(() => window.zcode.callTool(${JSON.stringify(name)}, ${JSON.stringify(args)}))
      .then((result) => JSON.stringify(result))`,
  );
  if (!raw) throw new Error(`the account view did not answer the ${name} tool call`);
  return JSON.parse(raw) as unknown;
}

describe("PLM-EXT-P2D 插件设置与扩展的 settings 能力", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-p2d-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("敏感值存私有文件，settings.get 只给本插件，onDidChange 在保存与清除后触发", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    await seedFixtures();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (a) 保存前：settings.get 只有默认值。
    evidence.initialProbe = await log.waitFor(
      (line) =>
        line.includes("E2E_SETTINGS_PROBE plugin=e2e-ext-settings ") &&
        line.includes("locale=zh-CN"),
      "the settings extension should read its defaults",
      60000,
    );
    expect(String(evidence.initialProbe)).toContain("hasToken=false tokenLength=0 region=eu");
    evidence.initialOtherProbe = await log.waitFor(
      (line) =>
        line.includes("E2E_SETTINGS_PROBE plugin=e2e-ext-settings-other") &&
        line.includes("locale=zh-CN"),
      "the other extension should read its own defaults",
      60000,
    );
    expect(String(evidence.initialOtherProbe)).toContain("hasToken=false mode=lite keys=mode");

    // (b) 设置页保存两个键：普通值进 config.json，敏感值只进 plugin-secrets.json。
    await openPluginManagementSettings();
    await openInstalledPluginSettingsAdvanced(PLUGIN_ID);
    const before = await waitForConfigUi(
      (ui) => ui.tokenInputType !== null,
      "the plugin settings should show the config fields",
    );
    evidence.configUiBefore = before;
    expect(before.tokenInputType).toBe("password");
    expect(before.scopes).toMatchObject({ token: "default", region: "default" });
    await capturePluginManualReview(CASE_ID, "settings-before-zh-CN-zai-light");
    const linesBeforeSave = (await log.lines()).length;
    await setConfigInput("token", TOKEN);
    await setConfigInput("region", REGION);
    await clickPluginControl("plugin-store-config-save", { pluginId: PLUGIN_ID });
    await browser.waitUntil(async () => (await readConfigOptions()).region === REGION, {
      timeout: 30000,
      timeoutMsg: "region should be saved in config.json",
    });
    const configOptions = await readConfigOptions();
    const secretOptions = await readSecretOptions();
    evidence.configOptions = configOptions;
    evidence.secretKeys = Object.keys(secretOptions);
    expect(configOptions).toEqual({ region: REGION });
    expect(secretOptions.token).toBe(TOKEN);
    expect(JSON.stringify(await readJson(cliPath("config.json")))).not.toContain(TOKEN);

    // (c) onDidChange：保存成功后本插件收到新值。
    evidence.changedLog = await log.waitFor(
      (line) => line.includes("E2E_SETTINGS_CHANGED plugin=e2e-ext-settings hasToken=true"),
      "settings.onDidChange should fire after saving",
    );
    expect(String(evidence.changedLog)).toContain(
      `tokenLength=${TOKEN.length} region=${REGION} keys=region,token`,
    );
    evidence.windowHostSettingsLog = (await log.lines()).filter((line) =>
      line.includes("[extensions] settings"),
    );

    // (e) 设置页：敏感值掩码、user scope 有清除按钮、scope 标记跟着来源变。
    const after = await waitForConfigUi(
      (ui) => ui.scopes.token === "user" && ui.scopes.region === "user",
      "the scope markers should show the user scope after saving",
    );
    evidence.configUiAfter = after;
    expect(after.tokenInputType).toBe("password");
    expect(after.clearKeys).toContain("token");
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      await capturePluginManualReview(CASE_ID, `settings-saved-${locale}-${theme}`);
    }

    // (d) settings.get：换语言让两个扩展再读。第一个拿到 token（只看长度）与 region；第二个只有自己的值。
    evidence.probeAfterSave = await waitForLogAfter(
      linesBeforeSave,
      (line) =>
        line.includes("E2E_SETTINGS_PROBE plugin=e2e-ext-settings ") &&
        line.includes("locale=en-US"),
      "the settings extension should read the saved values",
    );
    expect(String(evidence.probeAfterSave)).toContain(
      `hasToken=true tokenLength=${TOKEN.length} region=${REGION} keys=region,token`,
    );
    evidence.otherProbeAfterSave = await waitForLogAfter(
      linesBeforeSave,
      (line) =>
        line.includes("E2E_SETTINGS_PROBE plugin=e2e-ext-settings-other") &&
        line.includes("locale=en-US"),
      "the other extension should read only its own values",
    );
    expect(String(evidence.otherProbeAfterSave)).toContain("hasToken=false mode=lite keys=mode");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (g) 清除敏感值：两处都删，onDidChange 再触发一次，hasToken=false。
    const changedBefore = (await log.lines()).filter((line) =>
      line.includes("E2E_SETTINGS_CHANGED"),
    ).length;
    await clickPluginControl("plugin-store-config-clear", {
      pluginId: PLUGIN_ID,
      configKey: "token",
    });
    await clickPluginControl("plugin-store-config-save", { pluginId: PLUGIN_ID });
    await browser.waitUntil(async () => !("token" in (await readSecretOptions())), {
      timeout: 30000,
      timeoutMsg: "the cleared token should leave plugin-secrets.json",
    });
    evidence.clearedLog = await log.waitFor(
      (line) =>
        line.includes("E2E_SETTINGS_CHANGED plugin=e2e-ext-settings hasToken=false") &&
        line.includes(`region=${REGION}`),
      "settings.onDidChange should fire after clearing the token",
    );
    expect(
      (await log.lines()).filter((line) => line.includes("E2E_SETTINGS_CHANGED")).length,
    ).toBeGreaterThan(changedBefore);
    expect(await readConfigOptions()).toEqual({ region: REGION });
    const cleared = await waitForConfigUi(
      (ui) => ui.scopes.token === "default",
      "the token scope marker should fall back to default after clearing",
    );
    evidence.configUiCleared = cleared;
    await capturePluginManualReview(CASE_ID, "settings-cleared-zh-CN-zai-light");

    // (h) settings.update（P4 H1，§18.1）：视图工具 login 写敏感键。只进 plugin-secrets.json，onDidChange 触发。
    // 视图在对话主视图的侧栏里：先关掉设置页。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "the settings back button should be visible",
    });
    const linesBeforeLogin = (await log.lines()).length;
    // H4（§18.1）：启动页条目、导航条目与视图标签用 GitLab 示例的图标（log-in、git-merge、git-pull-request），
    // 不退回通用插件图标。读 Lucide 渲染的 svg class。
    await openLauncher();
    evidence.icons = {
      launcher: await readIconClass(
        `[data-testid="${TID_SIDE_PANE_EXTENSION_VIEW_ITEM}"][data-side-pane-open-tab-item="extension-view:${ACCOUNT_VIEW}"]`,
      ),
      nav: await readIconClass(
        `[data-testid="${TID_NAV_PRIMARY_ITEM}"][data-extension-item="${PLUGIN_ID}/nav"]`,
      ),
    };
    await openLauncherView(ACCOUNT_VIEW);
    const loginResult = await callAccountTool("login", { token: UPDATE_TOKEN });
    (evidence.icons as Record<string, string | null>).tab = await readIconClass(
      `[data-side-pane-tab-id="extension-view:${ACCOUNT_VIEW}"]`,
    );
    expect(evidence.icons).toMatchObject({
      launcher: expect.stringContaining("lucide-log-in"),
      nav: expect.stringContaining("lucide-git-merge"),
      tab: expect.stringContaining("lucide-git-pull-request"),
    });
    evidence.loginResult = loginResult;
    expect(JSON.stringify(loginResult)).toContain('"ok":true');
    expect(JSON.stringify(loginResult)).not.toContain(UPDATE_TOKEN);
    await browser.waitUntil(async () => (await readSecretOptions()).token === UPDATE_TOKEN, {
      timeout: 30000,
      timeoutMsg: "settings.update should store the token in plugin-secrets.json",
    });
    expect(await readConfigOptions()).toEqual({ region: REGION });
    expect(JSON.stringify(await readJson(cliPath("config.json")))).not.toContain(UPDATE_TOKEN);
    evidence.updateChangedLog = await waitForLogAfter(
      linesBeforeLogin,
      (line) =>
        line.includes("E2E_SETTINGS_CHANGED plugin=e2e-ext-settings hasToken=true") &&
        line.includes(`tokenLength=${UPDATE_TOKEN.length} region=${REGION}`),
      "settings.onDidChange should fire after settings.update",
    );
    evidence.updateServiceLog = (await log.lines())
      .slice(linesBeforeLogin)
      .filter(
        (line) => line.includes("[extensions] settings") || line.includes("E2E_SETTINGS_UPDATE"),
      );
    expect(JSON.stringify(evidence.updateServiceLog)).toContain(
      `settings update plugin=${PLUGIN_ID} keys=1 cleared=0`,
    );
    await capturePluginManualReview(CASE_ID, "settings-update-account-view-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await capturePluginManualReview(CASE_ID, "settings-update-account-view-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (i) 只写自己的插件：第二个扩展写不属于它的 token、写类型不符的 mode，都报 invalid-input，什么都没写。
    evidence.foreignTokenLog = await log.waitFor(
      (line) => line.includes("E2E_SETTINGS_FOREIGN token "),
      "the other extension should try to write a foreign key",
    );
    expect(String(evidence.foreignTokenLog)).toContain("code=invalid-input");
    evidence.foreignTypeLog = await log.waitFor(
      (line) => line.includes("E2E_SETTINGS_FOREIGN mode-type "),
      "the other extension should try to write a wrong value type",
    );
    expect(String(evidence.foreignTypeLog)).toContain("code=invalid-input");
    expect(await readOtherConfigOptions()).toEqual({});
    expect((await readSecretOptions()).token).toBe(UPDATE_TOKEN);

    // (j) 写入后不泄露：新 token 原文只在 plugin-secrets.json 里。
    const updateScan = await scanLeaks(UPDATE_TOKEN);
    evidence.updateTokenHits = updateScan.hits;
    expect(updateScan.hits).toEqual([cliPath("plugin-secrets.json")]);

    // (k) settings.update 清除：logout 两处都删，onDidChange 再触发一次 hasToken=false。
    const linesBeforeLogout = (await log.lines()).length;
    const logoutResult = await callAccountTool("logout", {});
    evidence.logoutResult = logoutResult;
    expect(JSON.stringify(logoutResult)).toContain('"ok":true');
    await browser.waitUntil(async () => !("token" in (await readSecretOptions())), {
      timeout: 30000,
      timeoutMsg: "settings.update clear should remove the token from plugin-secrets.json",
    });
    expect(await readConfigOptions()).toEqual({ region: REGION });
    evidence.logoutChangedLog = await waitForLogAfter(
      linesBeforeLogout,
      (line) =>
        line.includes("E2E_SETTINGS_CHANGED plugin=e2e-ext-settings hasToken=false") &&
        line.includes(`region=${REGION}`),
      "settings.onDidChange should fire after clearing through settings.update",
    );

    // (m) settings.update 写普通键：只进 config.json 的 plugins.options，不进 plugin-secrets.json；onDidChange 触发。
    // 宿主行为，以前只由示例插件用例 PLM-JARVIS-2 断言（Jarvis 的设置面板保存模型等普通设置）。
    const linesBeforeRegion = (await log.lines()).length;
    const regionResult = await callAccountTool("setRegion", { region: UPDATED_REGION });
    evidence.regionResult = regionResult;
    expect(JSON.stringify(regionResult)).toContain('"ok":true');
    await browser.waitUntil(async () => (await readConfigOptions()).region === UPDATED_REGION, {
      timeout: 30000,
      timeoutMsg: "settings.update should store the normal key in config.json",
    });
    expect(await readConfigOptions()).toEqual({ region: UPDATED_REGION });
    expect(Object.keys(await readSecretOptions())).not.toContain("region");
    evidence.regionChangedLog = await waitForLogAfter(
      linesBeforeRegion,
      (line) =>
        line.includes("E2E_SETTINGS_CHANGED plugin=e2e-ext-settings hasToken=false") &&
        line.includes(`region=${UPDATED_REGION}`),
      "settings.onDidChange should fire after settings.update wrote the normal key",
    );

    // (f) 日志与其他文件不泄露：两个 token 原文都不在 App / CLI 日志与数据目录里（plugin-secrets.json 已清空）。
    const scan = await scanLeaks(TOKEN);
    const updateScanAfterClear = await scanLeaks(UPDATE_TOKEN);
    evidence.tokenScanRoots = scan.roots;
    evidence.tokenLeaks = scan.hits;
    evidence.updateTokenLeaksAfterClear = updateScanAfterClear.hits;
    expect(scan.hits).toEqual([]);
    expect(updateScanAfterClear.hits).toEqual([]);
  });
});
