// PLM-EXT-2A：扩展进程基础设施与插槽（docs/plugins/extension-host.md §6、§12、§15、§16.1、§16.2）。
// 隔离 HOME：fixture 插件复制到 E2E HOME，经 ~/.zcode/cli/config.json 的 plugins.dirs 加载。
// 运行时证据取自 Main 日志（[extension-host] 前缀）与 fixture 写出的状态文件。
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_MODEL_CONFIG,
  TID_EXTENSION_COMPOSER_STATUS,
  TID_SIDE_PANE_EXTENSIONS,
  TID_SIDE_PANE_EXTENSIONS_STOPPED,
  TID_SIDE_PANE_EXTENSION_PROBLEM,
  TID_SIDE_PANE_EXTENSION_VIEW_ITEM,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { ensureSidePaneEntryVisible } from "#e2e/helpers/browser-side-pane";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-2A";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-host-runtime",
);
const PLUGINS = ["e2e-ext-status", "e2e-ext-hang", "e2e-ext-invalid", "e2e-ext-incompatible"];
const STATUS_ITEM = "e2e-ext-status@inline/status";
const READY_TEXT = "E2E ok";
const HANG_TEXT = "E2E hang";
const HANG_ITEM = "e2e-ext-hang@inline/hang";
/** 启动页视图条目（静态声明）：扩展进程停止后照常显示，标签变为「扩展已停止」，操作改为重新加载。 */
const PANEL_ITEM = "e2e-ext-status@inline/open-panel";
/** 引用未声明视图的条目：只有它不可用，问题行带字段路径。 */
const BROKEN_ITEM_PATH = 'slots["sidePane.launcher"][1].target.view';
/** 只由设置页注入的网络变量（main/extensionHostSupervisor.ts 的 PROXY / NO_PROXY / CA 键）。 */
const SETTINGS_NETWORK_ENV = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
]);
/** 与 main/extensionHostSupervisor.ts 的 EXTENSION_HOST_ENV_ALLOWLIST 一致，外加进程标签。 */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "windir",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_ENV",
  "ZCODE_PROCESS_LABEL",
]);
/**
 * 系统在子进程启动时注入的键，不来自 Window Host 的环境（见 docs/plugins/extension-host.md §12.1）：
 * macOS 上 Chromium 的子进程启动器写 MACH_PORT_RENDEZVOUS_PEER_VALDATION，CoreFoundation 写 __CF_USER_TEXT_ENCODING。
 */
const PLATFORM_INJECTED_ENV = new Set([
  "MACH_PORT_RENDEZVOUS_PEER_VALDATION",
  "__CF_USER_TEXT_ENCODING",
]);

const evidence: Record<string, unknown> = {};
/** 只在这一行之后找日志：种子前的首次启动也有一个（没有插件的）扩展进程。 */
let logCursor = 0;

function fixtureHome(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-host");
}

async function seedExtensionFixtures(): Promise<void> {
  const target = fixtureHome();
  await mkdir(target, { recursive: true });
  for (const name of PLUGINS) {
    await cp(join(FIXTURE_ROOT, name), join(target, name), { recursive: true, force: true });
  }
  const configPath = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")) as Record<
    string,
    unknown
  >;
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...config,
        plugins: {
          ...plugins,
          enabled: true,
          dirs: PLUGINS.map((name) => join(target, name)),
          enabledPlugins: {
            ...((plugins.enabledPlugins ?? {}) as Record<string, boolean>),
            ...Object.fromEntries(PLUGINS.map((name) => [`${name}@inline`, true])),
          },
        },
      },
      null,
      2,
    ),
  );
}

async function readMainLog(): Promise<string[]> {
  const logDir =
    process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() || join(resolveE2EStorageRoot(), "v2", "logs");
  const names = (await readdir(logDir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".log"))
    .sort();
  const lines: string[] = [];
  for (const name of names) {
    lines.push(...(await readFile(join(logDir, name), "utf8")).split("\n"));
  }
  return lines.filter((line) => line.includes("[extension-host]") || line.includes("[extensions]"));
}

async function waitForLog(
  predicate: (line: string) => boolean,
  message: string,
  timeout = 30000,
): Promise<string> {
  let found = "";
  await browser.waitUntil(
    async () => {
      found = (await readMainLog()).slice(logCursor).find(predicate) ?? "";
      return Boolean(found);
    },
    { timeout, interval: 500, timeoutMsg: message },
  );
  return found;
}

async function readStatusState(): Promise<{ pid: number; envKeys: string[]; activatedAt: number }> {
  return JSON.parse(await readFile(join(fixtureHome(), "e2e-ext-status-state.json"), "utf8"));
}

async function readSlotText(itemId: string): Promise<string | null> {
  return browser.execute(
    (testId, id) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"][data-extension-item="${id}"]`)
        ?.textContent ?? null,
    TID_EXTENSION_COMPOSER_STATUS,
    itemId,
  );
}

async function waitForSlotText(itemId: string, text: string | null, timeout = 30000) {
  await browser.waitUntil(async () => (await readSlotText(itemId)) === text, {
    timeout,
    interval: 250,
    timeoutMsg: `composer.status ${itemId} should be ${text ?? "absent"}`,
  });
}

async function clickSlot(itemId: string): Promise<void> {
  await browser.execute(
    (testId, id) => {
      document
        .querySelector<HTMLElement>(`[data-testid="${testId}"][data-extension-item="${id}"]`)
        ?.click();
    },
    TID_EXTENSION_COMPOSER_STATUS,
    itemId,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGenRunning(gen: number, timeout = 30000): Promise<void> {
  await waitForLog(
    (line) => line.includes(`[extension-host] gen=${gen} status=running`),
    `extension host gen=${gen} should be running`,
    timeout,
  );
}

/** 打开右侧面板的启动页。窄窗口会收起面板但保留 DOM，所以按「可见」判断，不按「存在」。 */
async function openLauncher(): Promise<void> {
  await ensureSidePaneEntryVisible();
  await browser.waitUntil(
    async () => {
      if (await $('[data-side-pane-open-tab-item="browser"]').isDisplayed()) return true;
      // 与产品 ⌥⌘B 共用真实 workspace shortcut。
      await browser.execute(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "b",
            code: "KeyB",
            altKey: true,
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      return false;
    },
    { timeout: 15000, interval: 1000, timeoutMsg: "side pane launcher should be visible" },
  );
}

async function runReloadFromCommandCenter(): Promise<void> {
  await $('[data-testid="sidebar-search-open"]').click();
  const input = $('[role="dialog"] [cmdk-input]');
  await input.waitForDisplayed({ timeout: 10000 });
  await input.setValue(">重新加载扩展");
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"] [cmdk-item]'),
        ).find((element) => /重新加载扩展|Reload extensions/.test(element.textContent ?? ""));
        if (!item) return false;
        item.click();
        return true;
      }),
    { timeout: 10000, timeoutMsg: "command center should list 重新加载扩展" },
  );
}

interface LauncherRow {
  item: string | undefined;
  text: string | null;
  title: string | null;
}

/** 启动页「扩展」分区的某一类行（问题行或视图条目）。 */
async function readLauncherRows(testId: string): Promise<LauncherRow[]> {
  return browser.execute(
    (rowTestId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${rowTestId}"]`)).map(
        (row) => ({
          item: row.dataset.sidePaneOpenTabItem,
          text: row.textContent,
          title: row.getAttribute("title"),
        }),
      ),
    testId,
  );
}

function findRow(rows: LauncherRow[], item: string): LauncherRow | undefined {
  return rows.find((row) => row.item === item);
}

describe("PLM-EXT-2A 扩展进程基础设施与插槽", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-2a-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("插槽、问题行、崩溃恢复、卡死预算、重新加载、环境变量与退出收口", async function () {
    this.timeout(420000);
    requirePluginManualReview();
    await seedExtensionFixtures();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        logCursor = (await readMainLog()).length;
      },
    });
    // 配好上游模型并进入真实草稿：草稿有预热会话，composer.status 的点击作用域是会话。
    await prepareV4ConversationE2E();
    await setCurrentElectronRendererContentSize(1400, 900);
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (a) 激活后 composer.status 显示在用量圆环左边。
    await waitForSlotText(STATUS_ITEM, READY_TEXT, 60000);
    // 草稿没有用量数据时圆环不渲染；插槽紧挨模型控件组（圆环、模型选择器）之前。
    const layout = await browser.execute(
      (slotTestId, ringTestId, configTestId, modelTestId, id) => {
        const slot = document.querySelector<HTMLElement>(
          `[data-testid="${slotTestId}"][data-extension-item="${id}"]`,
        );
        const ring = document.querySelector<HTMLElement>(`[data-testid="${ringTestId}"]`);
        const model = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
        let next = slot?.nextElementSibling ?? null;
        while (next && next.getAttribute("data-testid") === slotTestId) {
          next = next.nextElementSibling;
        }
        return {
          beforeModelControls: next?.getAttribute("data-testid") === configTestId,
          ringPresent: Boolean(ring),
          slotRight: slot?.getBoundingClientRect().right ?? null,
          ringLeft: ring?.getBoundingClientRect().left ?? null,
          modelLeft: model?.getBoundingClientRect().left ?? null,
          ringFollowsSlot: ring
            ? Boolean(slot && slot.compareDocumentPosition(ring) & Node.DOCUMENT_POSITION_FOLLOWING)
            : null,
        };
      },
      TID_EXTENSION_COMPOSER_STATUS,
      TID_CHAT_CONTEXT_USAGE_TRIGGER,
      TID_V4_MODEL_CONFIG,
      TID_CHAT_MODEL_SELECT_TRIGGER,
      STATUS_ITEM,
    );
    evidence.layout = layout;
    expect(layout.beforeModelControls).toBe(true);
    if (layout.ringPresent) expect(layout.ringFollowsSlot).toBe(true);
    for (const right of [layout.ringLeft, layout.modelLeft]) {
      if (layout.slotRight !== null && right !== null) {
        expect(layout.slotRight).toBeLessThanOrEqual(right + 1);
      }
    }
    await waitForLog(
      (line) => line.includes("[e2e-ext-status@inline] activated in"),
      "activation log",
    );
    await waitForLog(
      (line) => /\[extension-host\] gen=1 contributions snapshot gen=1 rev=\d+/.test(line),
      "contributions snapshot log",
    );
    await waitForLog(
      (line) => line.includes("[extensions]") && line.includes("contributions snapshot gen=1"),
      "window host snapshot relay log",
    );
    // 静态声明归 Window Host（§16.1）：它读清单生成静态表，只把合法、兼容的扩展声明交给扩展进程。
    // 静态表包含插件清单里的每个插件（隔离 HOME 里还有不带 extension 的内置插件），扩展只有 2 个合法兼容。
    const staticTableLine = await waitForLog(
      (line) =>
        line.includes("[extensions]") &&
        /static table rev=\d+ plugins=\d+ extensions=2 /.test(line),
      "the window host should build the static table from every inventory plugin",
    );
    evidence.staticTableLog = staticTableLine;
    expect(Number(/plugins=(\d+)/.exec(staticTableLine)?.[1])).toBeGreaterThanOrEqual(
      PLUGINS.length,
    );
    evidence.declarationsLog = await waitForLog(
      (line) =>
        line.includes("[extensions]") && line.includes("declarations pushed gen=1 extensions=2"),
      "the window host should push only valid, compatible extensions",
    );
    // 未知插槽 id 只记诊断；引用未声明视图的条目只让它自己不可用（不交给扩展进程）。
    evidence.ignoredSlotLog = await waitForLog(
      (line) =>
        line.includes("manifest ignored e2e-ext-status@inline") &&
        line.includes('slots["future.slot"]'),
      "an unknown slot id should be ignored with a diagnostic",
    );
    evidence.unusableItemLog = await waitForLog(
      (line) => line.includes("E2E_EXT_UNUSABLE_ITEM not-declared"),
      "the unusable item should not reach the extension host",
    );

    // 点击执行命令：作用域为当前会话（草稿为预热会话），扩展按该会话写入文字。
    await clickSlot(STATUS_ITEM);
    await waitForSlotText(STATUS_ITEM, "E2E #1");
    evidence.commandLog = await waitForLog(
      (line) => line.includes("E2E_EXT_COMMAND_RUN") && line.includes("clicks=1"),
      "command run log",
    );
    expect(evidence.commandLog).toContain("scope=session");

    // 运行时护栏：ctx 冻结、process.exit 被拦截、未声明 id 抛 not-declared、未捕获错误归因插件。
    const guardLines = (await readMainLog()).slice(logCursor);
    evidence.guards = guardLines.filter((line) =>
      /E2E_EXT_(CTX_FROZEN|EXIT_BLOCKED|NOT_DECLARED)|E2E_EXT_UNCAUGHT/.test(line),
    );
    expect(guardLines.some((line) => line.includes("E2E_EXT_CTX_FROZEN true"))).toBe(true);
    expect(guardLines.some((line) => line.includes("E2E_EXT_EXIT_BLOCKED internal"))).toBe(true);
    expect(guardLines.some((line) => line.includes("E2E_EXT_NOT_DECLARED not-declared"))).toBe(
      true,
    );
    await waitForLog(
      (line) =>
        line.includes("[e2e-ext-status@inline] uncaught exception") &&
        line.includes("E2E_EXT_UNCAUGHT"),
      "uncaught error should be logged with the plugin id",
    );

    // (e) 环境变量只有白名单里的键，外加设置页注入的网络变量。代理、No Proxy 与 CA 不在白名单里，只来自
    // 设置页（与 CLI 相同）：capture 模式下 WDIO 把自己的代理与 CA 写进隔离 HOME 的 setting.json，所以这里
    // 可能出现。「设置页留空时一个都没有」由 PLM-EXT-H3（plugin-extension-network）断言。
    const envLine = await waitForLog((line) => line.includes("E2E_EXT_ENV_KEYS"), "env keys log");
    const envKeys = JSON.parse(
      envLine.slice(envLine.indexOf("[", envLine.indexOf("E2E_EXT_ENV_KEYS"))),
    ) as string[];
    evidence.envKeys = envKeys;
    const unexpected = envKeys.filter(
      (key) =>
        !ENV_ALLOWLIST.has(key) &&
        !PLATFORM_INJECTED_ENV.has(key) &&
        !SETTINGS_NETWORK_ENV.has(key),
    );
    evidence.envNotAllowlisted = envKeys.filter((key) => !ENV_ALLOWLIST.has(key));
    expect(unexpected).toEqual([]);
    expect(envKeys.some((key) => /OTEL|TELEMETRY|OAUTH|SECRET|TOKEN|BIGMODEL/i.test(key))).toBe(
      false,
    );
    expect(envKeys).toContain("ZCODE_PROCESS_LABEL");

    // (d) 启动页「扩展」分区：清单非法（悬停带字段路径）、版本不兼容、条目不可用。
    await openLauncher();
    await $(`[data-testid="${TID_SIDE_PANE_EXTENSIONS}"]`).waitForExist({ timeout: 15000 });
    const assertProblemRows = (problems: LauncherRow[]) => {
      const invalid = findRow(problems, "extension-problem:e2e-ext-invalid@inline");
      const incompatible = findRow(problems, "extension-problem:e2e-ext-incompatible@inline");
      const unusableItem = findRow(problems, "extension-problem:e2e-ext-status@inline");
      expect(invalid?.text).toContain("清单非法");
      expect(invalid?.title).toContain("extension.contributes.commands[0].titel");
      expect(incompatible?.text).toContain("版本不兼容");
      expect(incompatible?.title).toContain("^2.0.0");
      // 条目不可用只影响它自己：同一插件的 composer.status 与启动页条目照常。
      expect(unusableItem?.text).toContain("清单非法");
      expect(unusableItem?.title).toContain(BROKEN_ITEM_PATH);
    };
    const problems = await readLauncherRows(TID_SIDE_PANE_EXTENSION_PROBLEM);
    evidence.problems = problems;
    assertProblemRows(problems);
    // 静态条目：扩展进程运行时是普通的「打开」行。
    const panelRunning = findRow(
      await readLauncherRows(TID_SIDE_PANE_EXTENSION_VIEW_ITEM),
      `extension-view:${PANEL_ITEM}`,
    );
    evidence.panelRowRunning = panelRunning;
    expect(panelRunning?.text).toContain("E2E 状态面板");
    expect(panelRunning?.text).not.toContain("扩展已停止");

    // (g) 深浅主题、中英文截图：插槽与启动页分区（分区在启动页底部，先滚到可见）。
    await browser.execute((testId) => {
      document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: "center" });
    }, TID_SIDE_PANE_EXTENSIONS);
    const screenshots: string[] = [];
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      screenshots.push(await capturePluginManualReview(CASE_ID, `slots-${locale}-${theme}`));
    }
    evidence.screenshots = screenshots;

    // 工具栏变窄时扩展条目最先收起（只留图标）：任何其他档位收起时，扩展条目必须已收起。
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 900, height: 900 });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (testId) =>
            Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)).every(
              (element) => element.dataset.composerCompact === "true",
            ),
          TID_EXTENSION_COMPOSER_STATUS,
        ),
      { timeout: 10000, timeoutMsg: "extension items should collapse first in a narrow toolbar" },
    );
    const collapse = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]")).map(
        (element) => ({
          priority: element.dataset.composerCollapsePriority,
          compact: element.dataset.composerCompact ?? null,
        }),
      ),
    );
    evidence.narrowCollapse = collapse;
    screenshots.push(await capturePluginManualReview(CASE_ID, "composer-narrow-zh-CN-zai-light"));
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (b) 杀掉扩展进程：gen + 1 重启，插槽文字由扩展重新设置（动态值随进程清空）。
    const first = await readStatusState();
    evidence.gen1Pid = first.pid;
    process.kill(first.pid, "SIGKILL");
    await waitForLog(
      (line) =>
        line.includes("[extension-host] gen=1 extension host exited") &&
        line.includes("intent=crash"),
      "gen=1 exit should be logged as a crash",
    );
    await waitForGenRunning(2);
    await browser.waitUntil(async () => (await readStatusState()).pid !== first.pid, {
      timeout: 30000,
      timeoutMsg: "extension should activate again in the new process",
    });
    await waitForSlotText(STATUS_ITEM, READY_TEXT);

    // (c) 卡死：死循环命令 15 秒左右被判卡死并重启（计入预算）。
    const hangStartedAt = Date.now();
    await waitForSlotText(HANG_ITEM, HANG_TEXT);
    await clickSlot(HANG_ITEM);
    await waitForLog(
      (line) => line.includes("[extension-host] gen=2 unresponsive"),
      "busy loop should be detected",
      30000,
    );
    evidence.hangDetectedMs = Date.now() - hangStartedAt;
    expect(evidence.hangDetectedMs as number).toBeLessThan(25000);
    await waitForGenRunning(3);
    await waitForSlotText(HANG_ITEM, HANG_TEXT);

    // 第 3 次崩溃：最后一次自动重启，退避 4s。
    await clickSlot(HANG_ITEM);
    await waitForLog(
      (line) => line.includes("[extension-host] gen=3 restarting in 4000ms (restart 3/3)"),
      "the third crash should use the last backoff step",
      30000,
    );
    await waitForGenRunning(4);
    await waitForSlotText(HANG_ITEM, HANG_TEXT);

    // 第 4 次崩溃：5 分钟内超过 3 次自动重启，预算耗尽，扩展进程停止。
    await clickSlot(HANG_ITEM);
    await waitForLog(
      (line) => line.includes("[extension-host] gen=4 status=stopped"),
      "crash budget should be exhausted",
      30000,
    );
    await waitForSlotText(STATUS_ITEM, null);
    await openLauncher();
    await $(`[data-testid="${TID_SIDE_PANE_EXTENSIONS_STOPPED}"]`).waitForExist({ timeout: 15000 });
    evidence.stoppedRow = await browser.execute(
      (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "",
      TID_SIDE_PANE_EXTENSIONS_STOPPED,
    );
    expect(evidence.stoppedRow).toContain("扩展已停止");
    expect(await $(`[data-testid="${TID_SIDE_PANE_EXTENSIONS_STOPPED}"]`).isDisplayed()).toBe(true);
    // 扩展进程停止后静态声明照常（§16.1）：问题行都在；扩展目标的条目照常显示但不可用，
    // 标签为「扩展已停止」，操作改为「重新加载」。
    const stoppedProblems = await readLauncherRows(TID_SIDE_PANE_EXTENSION_PROBLEM);
    evidence.problemsWhileStopped = stoppedProblems;
    assertProblemRows(stoppedProblems);
    const panelStopped = findRow(
      await readLauncherRows(TID_SIDE_PANE_EXTENSION_VIEW_ITEM),
      `extension-view:${PANEL_ITEM}`,
    );
    evidence.panelRowStopped = panelStopped;
    expect(panelStopped?.text).toContain("E2E 状态面板");
    expect(panelStopped?.text).toContain("扩展已停止");
    expect(panelStopped?.text).toContain("重新加载");
    await browser.execute((testId) => {
      document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: "center" });
    }, TID_SIDE_PANE_EXTENSIONS_STOPPED);
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      screenshots.push(await capturePluginManualReview(CASE_ID, `stopped-${locale}-${theme}`));
    }
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // 命令中心「重新加载扩展」：清零预算并重启，已停止时也能用。
    await runReloadFromCommandCenter();
    await waitForLog(
      (line) => line.includes("reload requested; crash budget reset"),
      "reload should reach the supervisor",
    );
    await waitForGenRunning(5);
    await waitForSlotText(STATUS_ITEM, READY_TEXT);
    await $(`[data-testid="${TID_SIDE_PANE_EXTENSIONS_STOPPED}"]`).waitForExist({
      reverse: true,
      timeout: 15000,
    });
    // 重新加载会重读静态表；扩展进程恢复后条目回到「打开」。
    await waitForLog(
      (line) => line.includes("[extensions]") && /static table rev=\d+ .*\(reload\)/.test(line),
      "reload should re-read the static table",
    );
    const panelReloaded = findRow(
      await readLauncherRows(TID_SIDE_PANE_EXTENSION_VIEW_ITEM),
      `extension-view:${PANEL_ITEM}`,
    );
    evidence.panelRowReloaded = panelReloaded;
    expect(panelReloaded?.text).not.toContain("扩展已停止");

    // (f) 退出 App：扩展进程在退出收口内结束，没有残留进程。
    const last = await readStatusState();
    evidence.gen5Pid = last.pid;
    let aliveAfterQuit: boolean | null = null;
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => {
        aliveAfterQuit = isAlive(last.pid);
      },
    });
    evidence.aliveAfterQuit = aliveAfterQuit;
    expect(aliveAfterQuit).toBe(false);
    evidence.disposeLog = await waitForLog(
      (line) =>
        line.includes("[extension-host] gen=5 extension host exited") &&
        line.includes("intent=dispose"),
      "gen=5 should exit through the quit barrier",
    );
    evidence.lifecycle = (await readMainLog())
      .slice(logCursor)
      .filter((line) =>
        /status=|forked|paired|exited|unresponsive|budget|reload|activated|snapshot|static table|declarations|manifest/.test(
          line,
        ),
      );
  });
});
