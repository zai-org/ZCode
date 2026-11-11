// PLM-EXT-P3B：扩展的会话读连接与商店安装后的激活确认（docs/plugins/extension-host.md §17.3、§17.5、§17.7、
// §17.10 第 2 步）。
// 隔离 HOME：
// - 纯 JS fixture 扩展 e2e-ext-reads（test/e2e/fixtures/fs/plugins/plugin-extension-reads/）经 plugins.dirs
//   加载，清单声明 sessions.read；授权记录预先写进隔离 HOME 的 grants.json（授权流程由 PLM-EXT-P3A 覆盖）。
//   它订阅会话列表；有 9 个种子会话时做一次上限探测；观察最近的非种子会话的行与会话状态，视图显示镜像的行。
// - 9 个种子会话用 seedProviderReadinessHistoryFixture 写进 CLI DB 与 tasks-index（只在 App 退出后写）。
// - 本地插件市场 store-market（两个带扩展代码与技能的插件），经设置页的插件商店安装。
// 模型用 replay：提示词带 upstream-e2e-ok，命中 plugin-extension-sessions-read.json（回复 deepseek-e2e-ok）。
// 运行时证据：Main 日志（[extensions] 的 session read connection / session mirror / activation 行与 fixture 的
// E2E_READS_* / E2E_STORE_*）、隔离 HOME 的 grants.json、视图页面 DOM、截图。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_EXTENSION_ACTIVATION_DIALOG,
  TID_SIDE_PANE_EXTENSION_ACTIVATION,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedProviderReadinessHistoryFixture } from "#e2e/helpers/provider-readiness-history-fixture";
import { ServiceChannels } from "@zcode/shared";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  createExtensionLog,
  openLauncher,
  openLauncherView,
  reloadExtensionsFromCommandCenter,
  waitForViewPage,
  waitForViewPane,
} from "#e2e/helpers/extension-host-views";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  addMarketplaceSourceThroughAgent,
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  getPluginReferenceCatalog,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P3B";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(process.cwd(), "test/e2e/fixtures/fs/plugins/plugin-extension-reads");
const CLI_ENTRY = resolve(process.cwd(), "../../apps/zcode-cli/packages/cli/dist/zcode.cjs");
const PLUGIN = "e2e-ext-reads";
const PLUGIN_ID = `${PLUGIN}@inline`;
/** 长历史的轮数：行镜像的窗口装不下，要往前翻页（与原 PLM-JARVIS-1 相同）。 */
const HISTORY_ROUNDS = 40;
const VIEW_ID = `${PLUGIN_ID}/rows`;
const LAUNCHER_ITEM = `${PLUGIN_ID}/open-rows`;
const MARKET = "e2e-ext-store-market";
const STORE_A = `e2e-ext-store-a@${MARKET}`;
const STORE_B = `e2e-ext-store-b@${MARKET}`;
const SEED_COUNT = 9;
const MARKER = "E2E_EXT_READS";
const PROMPT = `${MARKER}: Reply with exactly "upstream-e2e-ok" and no other text.`;
// 录制的回复（plugin-extension-sessions-read.json 的 plugin-extension-sessions-read-1）。
const REPLY = "deepseek-e2e-ok";

const evidence: Record<string, unknown> = {};
const screenshots: string[] = [];
const log = createExtensionLog();

function fixturesDir(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-reads");
}

function grantsPath(): string {
  return join(resolveE2EStorageRoot(), "v2", "extensions", "grants.json");
}

async function readGrantsFile(): Promise<Record<string, unknown> | null> {
  const text = await readFile(grantsPath(), "utf8").catch(() => null);
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

async function activationOf(pluginId: string): Promise<string | null> {
  const activations = ((await readGrantsFile())?.activations ?? {}) as Record<
    string,
    { state?: string }
  >;
  return activations[pluginId]?.state ?? null;
}

/** fixture 插件进 plugins.dirs 并启用；授权记录预先写好（授权流程由 PLM-EXT-P3A 覆盖）。 */
async function seedPlugin(): Promise<void> {
  const target = fixturesDir();
  await mkdir(target, { recursive: true });
  await cp(join(FIXTURE_ROOT, PLUGIN), join(target, PLUGIN), { recursive: true, force: true });
  const configPath = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")) as Record<
    string,
    unknown
  >;
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  await mkdir(join(getE2EAppDataPaths().homeDir, ".zcode", "cli"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...config,
        plugins: {
          ...plugins,
          enabled: true,
          dirs: [join(target, PLUGIN)],
          enabledPlugins: {
            ...((plugins.enabledPlugins ?? {}) as Record<string, boolean>),
            [PLUGIN_ID]: true,
          },
        },
      },
      null,
      2,
    ),
  );
  await mkdir(join(resolveE2EStorageRoot(), "v2", "extensions"), { recursive: true });
  await writeFile(
    grantsPath(),
    JSON.stringify({
      version: 1,
      plugins: {
        // 故意不写 consentRevision（旧格式）：只读档位的含义没变，旧记录照常生效（§17.12）。
        [PLUGIN_ID]: {
          grants: ["sessions.read"],
          consentedVersion: "1.0.0",
          consentedAt: Date.now(),
        },
      },
    }),
  );
}

/** 9 个种子会话（标题以 E2E_READS_SEED_ 开头），只在 App 退出后写。 */
async function seedSessions(): Promise<void> {
  const home = getE2EAppDataPaths().homeDir;
  for (let index = 0; index < SEED_COUNT; index += 1) {
    await seedProviderReadinessHistoryFixture({
      cliEntryPoint: CLI_ENTRY,
      e2eHomeDir: home,
      workspacePath: DEFAULT_WORKSPACE,
      history: {
        sessionId: `sess_e2e_reads_seed_${index}`,
        title: `E2E_READS_SEED_${index}`,
        userText: `E2E_READS_SEED_USER_${index}`,
        assistantText: `E2E_READS_SEED_REPLY_${index}`,
        modelId: "missing-model",
        runtimeProviderId: "missing-provider",
        taskProviderId: "glm",
        assistantInputTokens: 0,
        assistantOutputTokens: 0,
      },
    });
  }
}

async function readFixtureState(): Promise<{ pid: number; activatedAt: number } | null> {
  const text = await readFile(join(fixturesDir(), "e2e-ext-reads-state.json"), "utf8").catch(
    () => null,
  );
  return text ? (JSON.parse(text) as { pid: number; activatedAt: number }) : null;
}

async function waitForLogAfter(
  from: number,
  predicate: (line: string) => boolean,
  message: string,
  timeout = 60000,
): Promise<string> {
  let found = "";
  await browser.waitUntil(
    async () => {
      found = (await log.lines()).slice(from).find(predicate) ?? "";
      return Boolean(found);
    },
    { timeout, interval: 500, timeoutMsg: message },
  );
  return found;
}

async function capture(label: string): Promise<void> {
  screenshots.push(await capturePluginManualReview(CASE_ID, label));
}

/** 打开右侧面板的启动页并确认它真的可见（与 PLM-EXT-P3A 相同）。 */
async function openVisibleLauncher(): Promise<void> {
  await openLauncher();
  await browser.waitUntil(
    async () => {
      if (await $('[data-side-pane-open-tab-item="browser"]').isDisplayed()) return true;
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

function activationRowSelector(pluginId: string): string {
  return `[data-testid="${TID_SIDE_PANE_EXTENSION_ACTIVATION}"][data-side-pane-open-tab-item="extension-activation:${pluginId}"]`;
}

async function readActivationRow(pluginId: string): Promise<string | null> {
  return browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    return row ? (row.textContent ?? "") : null;
  }, activationRowSelector(pluginId));
}

async function waitForVisibleActivationRow(pluginId: string, message: string): Promise<void> {
  await openVisibleLauncher();
  await browser.waitUntil(async () => $(activationRowSelector(pluginId)).isDisplayed(), {
    timeout: 30000,
    interval: 300,
    timeoutMsg: message,
  });
  await browser.execute((selector) => {
    document.querySelector(selector)?.scrollIntoView({ block: "center" });
  }, activationRowSelector(pluginId));
}

async function clickActivationRow(pluginId: string): Promise<void> {
  const clicked = await browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    row?.scrollIntoView({ block: "center" });
    row?.click();
    return Boolean(row);
  }, activationRowSelector(pluginId));
  if (!clicked) throw new Error(`the launcher has no activation row for ${pluginId}`);
}

async function readDialog(): Promise<string | null> {
  return browser.execute((id) => {
    const dialog = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return dialog ? (dialog.innerText ?? "") : null;
  }, TID_EXTENSION_ACTIVATION_DIALOG);
}

async function waitForDialog(message: string): Promise<string> {
  let text: string | null = null;
  await browser.waitUntil(
    async () => {
      text = await readDialog();
      return Boolean(text);
    },
    { timeout: 15000, interval: 200, timeoutMsg: message },
  );
  return text!;
}

async function waitForDialogClosed(message: string): Promise<void> {
  await browser.waitUntil(async () => (await readDialog()) === null, {
    timeout: 15000,
    timeoutMsg: message,
  });
}

/** 点对话框里文字为 label 的按钮（取消按钮没有 testid，按文字找）。 */
async function clickDialogButton(label: string): Promise<void> {
  const clicked = await browser.execute(
    (id, text) => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(`[data-testid="${id}"] button`),
      ).find((element) => (element.textContent ?? "").trim() === text);
      button?.click();
      return Boolean(button);
    },
    TID_EXTENSION_ACTIVATION_DIALOG,
    label,
  );
  if (!clicked) throw new Error(`the activation dialog has no button "${label}"`);
}

async function confirmDialog(): Promise<void> {
  await browser.execute(
    (id, confirmTestId) => {
      document
        .querySelector<HTMLElement>(`[data-testid="${id}"] [data-testid="${confirmTestId}"]`)
        ?.click();
    },
    TID_EXTENSION_ACTIVATION_DIALOG,
    TID_CONFIRM_DIALOG_CONFIRM,
  );
  await waitForDialogClosed("the activation dialog should close after confirming");
}

/** 经设置页进入插件商店，打开卡片并安装（安装即启用，user 层）。 */
async function installFromStore(pluginId: string): Promise<void> {
  await openPluginSettings();
  await clickPluginControl("plugin-store-segment-personal");
  await openPluginCard(pluginId);
  await installPluginThroughUi(pluginId);
  await clickPluginControl("plugin-store-detail-back");
  await clickTestIdByDom("desktop-top-nav-back");
}

describe("PLM-EXT-P3B 扩展的会话读连接与商店安装后的激活确认", () => {
  after(async () => {
    evidence.screenshots = screenshots;
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-p3b-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await restoreHandoffProbes().catch(() => undefined);
    await clearAppData();
  });

  it("列表、上限、实时行、readRows 与换代后的 reset", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedPlugin();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await seedSessions();
        await log.mark();
      },
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (a) 列表：订阅后的第一个事件是 snapshot，种子会话都在里面。
    evidence.listSnapshot = await log.waitFor(
      (line) =>
        line.includes("E2E_READS_LIST kind=snapshot") && line.includes(`seeds=${SEED_COUNT}`),
      "the list snapshot should contain the seeded sessions",
      90000,
    );
    evidence.listPumpStarted = await log.waitFor(
      (line) => line.includes("[extensions]") && line.includes("session list pump started"),
      "the Window Host should start the session list pump",
    );

    // (b) 上限：同一插件 9 个不同会话，前 8 个收到 reset，第 9 个 limit-exceeded；之后全部退订。
    const limitLine = await log.waitFor(
      (line) => line.includes("E2E_READS_LIMIT results="),
      "the limit probe should finish",
      180000,
    );
    evidence.limit = limitLine;
    const results = limitLine.split("results=")[1]!.trim().split(",");
    expect(results).toHaveLength(SEED_COUNT);
    expect(results.slice(0, 8).every((result) => result === "event:reset")).toBe(true);
    expect(results[8]).toBe("error:limit-exceeded");
    const connectionLine = await log.waitFor(
      (line) => line.includes("session read connection open connectionId=extension-host:"),
      "the Window Host should open the extension read connection",
    );
    evidence.readConnection = connectionLine;
    const gen = Number(/connectionId=extension-host:(\d+)/.exec(connectionLine)?.[1]);
    expect(gen).toBeGreaterThan(0);
    await log.waitFor(
      (line) => line.includes("E2E_READS_LIMIT released"),
      "the limit probe should release its subscriptions",
    );
    await browser.waitUntil(
      async () =>
        (await log.lines()).filter((line) => line.includes("session mirror released")).length >= 8,
      { timeout: 30000, timeoutMsg: "the Window Host should release the 8 probe mirrors" },
    );
    evidence.mirrorsSubscribed = (await log.lines()).filter((line) =>
      line.includes("session mirror subscribed"),
    ).length;

    // (c) 打开视图；在界面上发消息：视图实时出现用户行与助手回复，插件收到 rows 增量。
    await openLauncherView(LAUNCHER_ITEM);
    await waitForViewPane(
      VIEW_ID,
      (item) => item.phase === "running" && item.displayed,
      "the rows view should be running",
    );
    const beforeSend = (await log.lines()).length;
    await sendV4Prompt(PROMPT);
    const pane = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "the draft should become a session after the first send",
      60000,
    );
    const sessionId = pane.sessionId ?? "";
    evidence.sessionId = sessionId;
    await waitForV4AssistantMessageContaining(REPLY);
    const page = await waitForViewPage(
      VIEW_ID,
      (view) => view.text.includes(MARKER) && view.text.includes(REPLY),
      "the rows view should show the user row and the reply",
      60000,
    );
    evidence.viewPage = page;
    expect(page.dataset.sessionId).toBe(sessionId);
    evidence.watch = await waitForLogAfter(
      beforeSend,
      (line) => line.includes(`E2E_READS_WATCH session=${sessionId}`),
      "the extension should watch the new session",
    );
    evidence.reset = await waitForLogAfter(
      beforeSend,
      (line) => line.includes(`E2E_READS_ROWS session=${sessionId} kind=reset`),
      "the first rows event should be reset",
    );
    evidence.liveRows = await waitForLogAfter(
      beforeSend,
      (line) =>
        line.includes(`E2E_READS_ROWS session=${sessionId} kind=rows`) &&
        line.includes("reply=true"),
      "the reply should arrive as a live rows event",
    );
    evidence.readRows = await waitForLogAfter(
      beforeSend,
      (line) => line.includes(`E2E_READS_READROWS session=${sessionId}`),
      "readRows should return the session rows",
    );
    expect(String(evidence.readRows)).toContain("marker=true");
    evidence.conversation = await waitForLogAfter(
      beforeSend,
      (line) => line.includes(`E2E_READS_CONV session=${sessionId} phase=`),
      "the extension should receive the conversation state",
    );
    // 行与会话状态都不记正文：日志里不能有提示词原文。
    const readLines = (await log.lines()).filter((line) => line.includes("E2E_READS_"));
    expect(JSON.stringify(readLines)).not.toContain("Reply with exactly");
    await capture("reads-view-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await waitForViewPage(
      VIEW_ID,
      (view) => view.text.includes(REPLY),
      "the rows view should stay after switching presentation",
    );
    await capture("reads-view-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (d) 杀掉扩展进程：新一代重新激活、重新订阅，第一个事件是 reset，镜像里有完整的行。
    const before = await readFixtureState();
    expect(before?.pid).toBeGreaterThan(0);
    const beforeKill = (await log.lines()).length;
    process.kill(before!.pid, "SIGKILL");
    await browser.waitUntil(async () => (await readFixtureState())?.pid !== before!.pid, {
      timeout: 60000,
      timeoutMsg: "the extension host should restart and re-activate the fixture",
    });
    evidence.resetAfterKill = await waitForLogAfter(
      beforeKill,
      (line) =>
        line.includes(`E2E_READS_ROWS session=${sessionId} kind=reset`) &&
        line.includes("marker=true") &&
        line.includes("reply=true"),
      "the new generation should start with a reset carrying the rows",
    );
    const reconnected = await waitForLogAfter(
      beforeKill,
      (line) => line.includes("session read connection open connectionId=extension-host:"),
      "the new generation should open its own read connection",
    );
    evidence.reconnected = reconnected;
    expect(Number(/connectionId=extension-host:(\d+)/.exec(reconnected)?.[1])).toBeGreaterThan(gen);
    evidence.closedOld = await waitForLogAfter(
      beforeKill,
      (line) => line.includes(`session read connection closed connectionId=extension-host:${gen}`),
      "the old generation's read connection should be released",
    );

    // (h) 「重新加载扩展」：扩展重新激活、重新订阅，这个会话的第一个行事件是 reset，带完整的行。
    // 宿主行为，以前只由示例插件用例 PLM-JARVIS-1 断言。
    const beforeReload = (await log.lines()).length;
    await reloadExtensionsFromCommandCenter();
    const firstAfterReload = await waitForLogAfter(
      beforeReload,
      (line) => line.includes(`E2E_READS_ROWS session=${sessionId} `),
      "the reloaded extension should subscribe to the session rows again",
      90000,
    );
    evidence.firstRowsAfterReload = firstAfterReload;
    expect(firstAfterReload).toContain("kind=reset");
    expect(firstAfterReload).toContain("marker=true");
    expect(firstAfterReload).toContain("reply=true");

    // (i) 长历史：导入 40 轮的会话。行镜像只留尾部窗口（窗口里没有第一轮）；扩展用
    // readRows({ beforeRowId }) 往前翻页，hasMore 直到翻到第一轮才变成 false。
    // 宿主行为，以前只由示例插件用例 PLM-JARVIS-1 断言。
    await installHandoffRpcProbe();
    const history = Array.from({ length: HISTORY_ROUNDS }, (_, index) => {
      const n = String(index + 1).padStart(3, "0");
      return [
        { role: "user", content: `E2E_READS_HISTORY_ASK_${n}` },
        { role: "assistant", content: `E2E_READS_HISTORY_REPLY_${n}` },
      ];
    }).flat();
    const beforeImport = (await log.lines()).length;
    const imported = await callHandoffHost<{ session: { sessionId: string } }>(
      ServiceChannels.ZCodeAgent,
      "createSession",
      [
        {
          workspacePath: DEFAULT_WORKSPACE,
          persistence: "immediate",
          importedHistory: { source: "claudeCode", title: "E2E_READS_HISTORY", messages: history },
        },
      ],
    );
    const historyId = imported.session.sessionId;
    const paged = await waitForLogAfter(
      beforeImport,
      (line) => line.includes(`E2E_READS_HISTORY session=${historyId} `),
      "the extension should page through the imported history",
      90000,
    );
    evidence.historyPaging = paged;
    const field = (name: string) => new RegExp(`\\b${name}=(\\S+)`).exec(paged)?.[1];
    expect(field("windowHasFirst")).toBe("false");
    expect(field("hasFirst")).toBe("true");
    expect(field("hasMore")).toBe("false");
    expect(Number(field("pages"))).toBeGreaterThanOrEqual(2);
    expect(Number(field("total"))).toBeGreaterThan(Number(field("window")));
    expect(Number(field("total"))).toBeGreaterThanOrEqual(HISTORY_ROUNDS * 2);
  });

  it("商店安装的带代码扩展先不激活：不激活保持停用，确认后激活", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    // 前一个用例的 e2e-ext-reads 持有 sessions.read：再从商店装带代码的插件要先确认。
    const market = join(fixturesDir(), "store-market");
    await cp(join(FIXTURE_ROOT, "store-market"), market, { recursive: true, force: true });
    await addMarketplaceSourceThroughAgent(market);
    await waitUntilPluginOverview(
      (overview) =>
        [STORE_A, STORE_B].every((id) =>
          overview.availablePlugins.some((plugin) => plugin.id === id),
        ),
      "the store fixture market should list both plugins",
      60000,
    );

    // (a) 安装 A：Window Host 记为 pending，扩展进程不激活它；启动页显示「需要确认」。
    const beforeA = (await log.lines()).length;
    await installFromStore(STORE_A);
    evidence.heldA = await waitForLogAfter(
      beforeA,
      (line) => line.includes(`extension activation held plugin=${STORE_A}`),
      "the Window Host should hold the newly installed extension",
    );
    await browser.waitUntil(async () => (await activationOf(STORE_A)) === "pending", {
      timeout: 15000,
      timeoutMsg: "grants.json should record the pending activation",
    });
    await waitForVisibleActivationRow(
      STORE_A,
      "the launcher should show the needs-confirmation row",
    );
    evidence.rowA = await readActivationRow(STORE_A);
    expect(String(evidence.rowA)).toContain("需要确认");
    await capture("activation-row-zh-CN-zai-light");

    // (b) 对话框列出持有者；「不激活」→ declined，行消失，扩展代码不运行，技能照常。
    await clickActivationRow(STORE_A);
    evidence.dialogA = await waitForDialog("the activation row should open the dialog");
    expect(String(evidence.dialogA)).toContain("的扩展代码？");
    expect(String(evidence.dialogA)).toContain(PLUGIN);
    expect(String(evidence.dialogA)).toContain("不激活时，插件的技能与 MCP 照常可用。");
    await capture("activation-dialog-zh-CN-zai-light");
    await clickDialogButton("不激活");
    await waitForDialogClosed("the activation dialog should close after declining");
    await browser.waitUntil(async () => (await activationOf(STORE_A)) === "declined", {
      timeout: 15000,
      timeoutMsg: "grants.json should record the declined activation",
    });
    await browser.waitUntil(async () => (await readActivationRow(STORE_A)) === null, {
      timeout: 15000,
      timeoutMsg: "the needs-confirmation row should disappear after declining",
    });
    const pluginA = (await getPluginList()).plugins.find((plugin) => plugin.id === STORE_A);
    evidence.pluginA = pluginA ? { id: pluginA.id, enabled: pluginA.enabled } : null;
    expect(pluginA?.enabled).toBe(true);
    const catalogA = (await getPluginReferenceCatalog()).plugins.find(
      (plugin) => plugin.pluginId === STORE_A,
    );
    evidence.catalogA = catalogA
      ? { enabled: catalogA.enabled, skills: catalogA.skillQualifiedNames }
      : null;
    expect(catalogA?.skillQualifiedNames.join(",")).toContain("e2e-store-skill-a");

    // (c) 安装 B：关闭对话框（Esc）不算决定，行还在；确认后扩展进程激活它。
    const beforeB = (await log.lines()).length;
    await installFromStore(STORE_B);
    await waitForLogAfter(
      beforeB,
      (line) => line.includes(`extension activation held plugin=${STORE_B}`),
      "the Window Host should hold the second extension",
    );
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await waitForVisibleActivationRow(STORE_B, "the launcher should show the row for B");
    evidence.rowB = await readActivationRow(STORE_B);
    expect(String(evidence.rowB)).toContain("Needs confirmation");
    await capture("activation-row-en-US-zai-dark");
    await clickActivationRow(STORE_B);
    evidence.dialogB = await waitForDialog("the activation row for B should open the dialog");
    expect(String(evidence.dialogB)).toContain("Activate the extension code of");
    await capture("activation-dialog-en-US-zai-dark");
    await browser.keys("Escape");
    await waitForDialogClosed("the activation dialog should close on Escape");
    expect(await activationOf(STORE_B)).toBe("pending");
    await waitForVisibleActivationRow(STORE_B, "the row should stay after dismissing the dialog");
    await clickActivationRow(STORE_B);
    await waitForDialog("the activation dialog should open again");
    const beforeAllow = (await log.lines()).length;
    await confirmDialog();
    evidence.activatedB = await waitForLogAfter(
      beforeAllow,
      (line) => line.includes(`E2E_STORE_ACTIVATED plugin=${STORE_B}`),
      "the extension host should activate B after confirming",
    );
    await browser.waitUntil(async () => (await activationOf(STORE_B)) === null, {
      timeout: 15000,
      timeoutMsg: "grants.json should drop the activation record after confirming",
    });
    await browser.waitUntil(async () => (await readActivationRow(STORE_B)) === null, {
      timeout: 15000,
      timeoutMsg: "the needs-confirmation row should disappear after confirming",
    });
    // A 一直没有激活。
    const activatedA = (await log.lines()).filter((line) =>
      line.includes(`E2E_STORE_ACTIVATED plugin=${STORE_A}`),
    );
    evidence.activatedA = activatedA;
    expect(activatedA).toEqual([]);
    evidence.grantsFile = await readGrantsFile();
  });
});
