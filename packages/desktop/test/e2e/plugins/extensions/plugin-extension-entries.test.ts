// PLM-EXT-P2B：插件入口——主导航 nav.primary 与文件查看器 file.viewer（docs/plugins/extension-host.md §16.3–§16.5）。
// 隔离 HOME：两个纯 JS fixture 插件（test/e2e/fixtures/fs/plugins/plugin-extension-entries/）复制到 E2E HOME，
// 经 ~/.zcode/cli/config.json 的 plugins.dirs 加载：
// - e2e-ext-entries（扩展）：nav.primary 的 view 条目，file.viewer 为 .E2EVIEW（大写，验证大小写不敏感）打开视图。
// - e2e-mcp-viewer（只有 MCP App）：nav.primary 的 surface 条目，file.viewer 为 .e2edoc 打开页面并调 open_document。
// 正式会话用 replay 创建：提示词带 upstream-e2e-ok，命中 plugin-extension-entries.json 的 plugin-extension-entries-1。
// 运行时证据：Main 日志（[extension-host] / [extensions] / [extension-slots] / fixture 的 E2E_ENTRY_*）、
// 视图与 MCP App 页面的 DOM、MCP server 写的调用记录。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TID_NAV_PRIMARY_ITEM, TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  createExtensionLog,
  openLauncher,
  readActiveSidePaneTab,
  waitForViewPage,
  waitForViewPane,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P2B";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-entries",
);
const PLUGINS = ["e2e-ext-entries", "e2e-mcp-viewer"];
const EXT_PLUGIN = "e2e-ext-entries@inline";
const MCP_PLUGIN = "e2e-mcp-viewer@inline";
const NAV_VIEW_ITEM = `${EXT_PLUGIN}/nav`;
const NAV_SURFACE_ITEM = `${MCP_PLUGIN}/panel`;
const NAV_VIEW = `${EXT_PLUGIN}/nav`;
const FILE_VIEW = `${EXT_PLUGIN}/file`;
const FILE_DIR = "e2e-entries";
const VIEW_FILE = `${FILE_DIR}/notes.e2eview`;
const DOC_FILE = `${FILE_DIR}/report.e2edoc`;
const XLSX_FILE = `${FILE_DIR}/sheet.xlsx`;
const PROMPT = `E2E_EXT_ENTRIES: Reply with exactly "upstream-e2e-ok" and no other text.`;

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

function fixtureHome(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-entries");
}

async function seedFixtures(): Promise<void> {
  const target = fixtureHome();
  await mkdir(target, { recursive: true });
  for (const name of PLUGINS) {
    await cp(join(FIXTURE_ROOT, name), join(target, name), { recursive: true, force: true });
  }
  await writePluginDirsConfig(
    PLUGINS.map((name) => join(target, name)),
    PLUGINS.map((name) => `${name}@inline`),
  );
  const dir = join(DEFAULT_WORKSPACE, FILE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(DEFAULT_WORKSPACE, VIEW_FILE), "E2E extension viewer file\n");
  await writeFile(join(DEFAULT_WORKSPACE, DOC_FILE), "E2E MCP App viewer file\n");
  // 内容不是真的 xlsx：只验证路由（官方面板不在 E2E profile 时回退内置预览）。
  await writeFile(join(DEFAULT_WORKSPACE, XLSX_FILE), "not a real workbook\n");
}

interface NavItem {
  id: string;
  target: string;
  text: string;
  stopped: boolean;
  label: string;
  /** 导航条目没有选中态：不能带 aria-pressed（「自动化」「插件市场」才有）。 */
  pressable: boolean;
}

async function readNavItems(): Promise<NavItem[]> {
  return browser.execute(
    (itemTestId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${itemTestId}"]`)).map(
        (element) => ({
          id: element.dataset.extensionItem ?? "",
          target: element.dataset.extensionTarget ?? "",
          text: element.textContent ?? "",
          stopped: element.dataset.extensionHostStopped === "true",
          label: element.getAttribute("aria-label") ?? "",
          pressable: element.hasAttribute("aria-pressed"),
        }),
      ),
    TID_NAV_PRIMARY_ITEM,
  );
}

async function waitForNavItems(
  predicate: (items: NavItem[]) => boolean,
  message: string,
  timeout = 30000,
): Promise<NavItem[]> {
  let items: NavItem[] = [];
  await browser.waitUntil(
    async () => {
      items = await readNavItems();
      return predicate(items);
    },
    { timeout, interval: 300, timeoutMsg: `${message}: ${JSON.stringify(items)}` },
  );
  return items;
}

/** 截图前把指针移到窗口左上角：文件树入口会让项目行的悬停卡片一直开着，挡住画面。 */
async function capture(label: string): Promise<string> {
  await browser.action("pointer").move({ x: 2, y: 2, origin: "viewport" }).perform();
  await browser.pause(300);
  return capturePluginManualReview(CASE_ID, label);
}

/** 导航条目的期望顺序：按渲染端同一语言的排序规则比较标题，相同时按插件 id（§16.4）。 */
async function expectedNavOrder(items: NavItem[], locale: string): Promise<string[]> {
  return browser.execute(
    (entries, lang) =>
      [...entries]
        .sort(
          (a, b) =>
            a.text.localeCompare(b.text, lang) ||
            (a.id.split("/")[0]! < b.id.split("/")[0]! ? -1 : 1),
        )
        .map((entry) => entry.id),
    items.map((item) => ({ id: item.id, text: item.text })),
    locale,
  );
}

async function clickNavItem(itemId: string): Promise<void> {
  const clicked = await browser.execute(
    (itemTestId, id) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${itemTestId}"][data-extension-item="${id}"]`,
      );
      element?.click();
      return Boolean(element);
    },
    TID_NAV_PRIMARY_ITEM,
    itemId,
  );
  expect(clicked).toBe(true);
}

/** 左侧主导航的「插件市场」按钮是否选中：用来确认导航条目没有切换主视图。 */
async function readMainView(): Promise<{ pluginStore: boolean; automations: boolean }> {
  return browser.execute(() => ({
    pluginStore:
      document
        .querySelector('[data-testid="plugin-store-sidebar-open"]')
        ?.getAttribute("aria-pressed") === "true",
    automations:
      document
        .querySelector('[data-testid="automations-open"], [data-testid="sidebar-automations-open"]')
        ?.getAttribute("aria-pressed") === "true",
  }));
}

/** 所有沙箱 guest 里 E2E MCP 面板页面的 body dataset（标签页保活时可能有多份）。 */
async function readMcpPanelPages(): Promise<Array<Record<string, string>>> {
  return (await browser.electron.execute(async (electron) => {
    const pages: Array<Record<string, string>> = [];
    for (const guest of electron.webContents.getAllWebContents()) {
      if (guest.isDestroyed() || !guest.getURL().startsWith("zcode-sandbox://")) continue;
      for (const frame of guest.mainFrame.framesInSubtree) {
        if (!frame.url.startsWith("zcode-sandbox://plugin-")) continue;
        const dataset = (await frame
          .executeJavaScript(
            `document.querySelector("h1")?.textContent === "E2E MCP panel" ? { ...document.body.dataset } : null`,
          )
          .catch(() => null)) as Record<string, string> | null;
        if (dataset) pages.push(dataset);
      }
    }
    return pages;
  })) as Array<Record<string, string>>;
}

async function waitForMcpPanelPage(
  predicate: (page: Record<string, string>) => boolean,
  message: string,
  timeout = 60000,
): Promise<Record<string, string>> {
  let pages: Array<Record<string, string>> = [];
  let found: Record<string, string> | undefined;
  await browser.waitUntil(
    async () => {
      pages = await readMcpPanelPages();
      found = pages.find(predicate);
      return Boolean(found);
    },
    { timeout, interval: 500, timeoutMsg: `${message}: ${JSON.stringify(pages)}` },
  );
  return found!;
}

async function clickFileTreeRow(relativePath: string): Promise<void> {
  const path = join(DEFAULT_WORKSPACE, relativePath);
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) => element.dataset.testid === id && element.getBoundingClientRect().width > 0,
          );
          row?.scrollIntoView({ block: "center" });
          row?.click();
          return Boolean(row);
        },
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout: 15000, interval: 300, timeoutMsg: `file tree row not found: ${relativePath}` },
  );
}

/** 回到文件管理标签（打开查看器后当前标签换成了查看器）。 */
async function activateFileManagerTab(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="file-manager"]');
        tab?.click();
        return Boolean(tab);
      }),
    { timeout: 15000, interval: 300, timeoutMsg: "file manager tab should exist" },
  );
}

async function readMcpViewerCalls(): Promise<Array<{ tool: string; path: string }>> {
  const raw = await readFile(join(fixtureHome(), "e2e-mcp-viewer-calls.jsonl"), "utf8").catch(
    () => "",
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; path: string });
}

/** 等 open_document 到达 MCP server；中途出现权限请求就批准（页面调工具按会话权限规则授权）。 */
async function waitForOpenDocument(path: string): Promise<void> {
  const deadline = Date.now() + 60000;
  let approvals = 0;
  for (;;) {
    if ((await readMcpViewerCalls()).some((call) => call.path === path)) break;
    if (Date.now() > deadline) throw new Error(`open_document did not reach the server: ${path}`);
    const permissionOpen = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some((element) =>
        /Permission required|需要权限/.test(element.getAttribute("aria-label") ?? ""),
      ),
    );
    if (permissionOpen) {
      await approveV4Permission();
      approvals += 1;
    }
    await browser.pause(500);
  }
  evidence.openDocumentApprovals = approvals;
}

async function readExtensionHostPid(): Promise<{ pid: number; activatedAt: number }> {
  return JSON.parse(await readFile(join(fixtureHome(), "e2e-ext-entries-state.json"), "utf8")) as {
    pid: number;
    activatedAt: number;
  };
}

/** 连续杀掉扩展进程直到崩溃预算耗尽（§12.1：退避 1s、2s、4s，第 4 次崩溃停止）。返回 stopped 日志行。 */
async function stopExtensionHost(): Promise<string> {
  const linesBefore = (await log.lines()).length;
  for (let crash = 1; crash <= 4; crash += 1) {
    const state = await readExtensionHostPid();
    process.kill(state.pid, "SIGKILL");
    if (crash === 4) break;
    await browser.waitUntil(
      async () => {
        const next = await readExtensionHostPid().catch(() => state);
        return next.activatedAt > state.activatedAt;
      },
      { timeout: 60000, interval: 500, timeoutMsg: `the extension host should restart (${crash})` },
    );
  }
  let stopped = "";
  await browser.waitUntil(
    async () => {
      stopped =
        (await log.lines())
          .slice(linesBefore)
          .find((line) => /\[extension-host\] gen=\d+ status=stopped/.test(line)) ?? "";
      return Boolean(stopped);
    },
    {
      timeout: 60000,
      interval: 500,
      timeoutMsg: "the extension host should stop after the budget",
    },
  );
  return stopped;
}

describe("PLM-EXT-P2B 插件入口：主导航与文件查看器", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-p2b-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("主导航：视图与 MCP App 条目、根草稿与正式会话、扩展进程停止", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedFixtures();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await log.waitFor(
      (line) => line.includes(`[${EXT_PLUGIN}] activated in`),
      "the entries extension should activate",
      60000,
    );
    evidence.staticTable = await log.waitFor(
      (line) => line.includes("[extensions]") && /static table rev=\d+ .*items=/.test(line),
      "the window host should read the static table",
    );

    // (a) 两个导航条目都在「插件市场」之后，按标题排序；深浅主题、中英文截图。
    const zhItems = await waitForNavItems(
      (items) =>
        items.some((item) => item.id === NAV_VIEW_ITEM) &&
        items.some((item) => item.id === NAV_SURFACE_ITEM),
      "nav.primary should list both fixture entries",
    );
    evidence.navItemsZh = zhItems;
    expect(zhItems.find((item) => item.id === NAV_VIEW_ITEM)?.text).toContain("E2E 导航视图");
    expect(zhItems.find((item) => item.id === NAV_SURFACE_ITEM)?.text).toContain("E2E MCP 面板");
    expect(zhItems.map((item) => item.id)).toEqual(await expectedNavOrder(zhItems, "zh-CN"));
    evidence.navAfterPluginStore = await browser.execute((itemTestId) => {
      const store = document.querySelector('[data-testid="plugin-store-sidebar-open"]');
      const first = document.querySelector(`[data-testid="${itemTestId}"]`);
      return Boolean(
        store && first && store.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }, TID_NAV_PRIMARY_ITEM);
    expect(evidence.navAfterPluginStore).toBe(true);
    const screenshots: string[] = [];
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      const items = await waitForNavItems(
        (current) =>
          locale === "en-US"
            ? current.some((item) => item.text.includes("E2E nav view"))
            : current.some((item) => item.text.includes("E2E 导航视图")),
        `nav.primary titles should follow ${locale}`,
      );
      evidence[`navItems-${locale}`] = items.map((item) => item.text);
      expect(items.map((item) => item.id)).toEqual(await expectedNavOrder(items, locale));
      screenshots.push(await capture(`nav-${locale}-${theme}`));
    }
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (b) 导航 → 扩展视图标签；不切换主视图、没有选中态。
    await clickNavItem(NAV_VIEW_ITEM);
    const navPane = await waitForViewPane(
      NAV_VIEW,
      (pane) => pane.phase === "running" && pane.displayed,
      "the nav view tab should be running",
    );
    evidence.navViewPane = navPane;
    const navPage = await waitForViewPage(
      NAV_VIEW,
      (page) => page.dataset.ready === "1",
      "the nav view page should render",
    );
    evidence.navViewPage = navPage.dataset;
    expect(navPage.dataset.viewId).toBe("nav");
    expect(navPage.dataset.inputKind).toBe("");
    expect(await readActiveSidePaneTab()).toBe(`extension-view:${NAV_VIEW}`);
    expect(await readMainView()).toEqual({ pluginStore: false, automations: false });
    evidence.navViewOpenLog = await log.waitFor(
      (line) => line.includes("E2E_ENTRY_VIEW_OPEN view=nav") && line.includes("input=null"),
      "the nav view instance should open without input",
    );
    expect((await readNavItems()).every((item) => !item.pressable)).toBe(true);
    screenshots.push(await capture("nav-view-zh-CN-zai-light"));

    // (c) 导航 → MCP App 页面，根草稿路径：停在插件市场（没有对话窗格的会话）时点击，
    // 先进根草稿、回到对话，再在预热会话就绪后打开页面。
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="plugin-store-sidebar-open"]')?.click(),
    );
    await browser.waitUntil(async () => (await readMainView()).pluginStore, {
      timeout: 15000,
      timeoutMsg: "the plugin store main view should open",
    });
    await clickNavItem(NAV_SURFACE_ITEM);
    evidence.draftSurfaceLog = await log.waitFor(
      (line) =>
        line.includes("[extension-slots] open surface") &&
        line.includes(NAV_SURFACE_ITEM.split("/")[0]!) &&
        line.includes('"path":"draft"'),
      "the surface entry should take the root draft path",
    );
    await browser.waitUntil(async () => !(await readMainView()).pluginStore, {
      timeout: 15000,
      timeoutMsg: "the root draft path should return to the conversation",
    });
    await waitForV4Pane((snapshot) => snapshot.sessionId === "draft", "the pane should be a draft");
    const draftPage = await waitForMcpPanelPage(
      (page) => page.ready === "1",
      "the MCP App page should open in the root draft",
    );
    evidence.draftPanelPage = draftPage;
    const draftTab = (await readActiveSidePaneTab()) ?? "";
    evidence.draftPanelTab = draftTab;
    expect(draftTab.startsWith("plugin-ui:")).toBe(true);
    expect(draftTab).toContain(encodeURIComponent(MCP_PLUGIN));
    screenshots.push(await capture("nav-surface-draft-zh-CN-zai-light"));

    // (d) 导航 → MCP App 页面，正式会话：发送一条 replay 消息后，在焦点窗格的正式会话里打开。
    await sendV4Prompt(PROMPT);
    const session = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "the draft should become a session after the first send",
      60000,
    );
    const sessionId = session.sessionId ?? "";
    evidence.sessionId = sessionId;
    await openLauncher();
    expect((await readActiveSidePaneTab())?.startsWith("plugin-ui:")).toBe(false);
    await clickNavItem(NAV_SURFACE_ITEM);
    evidence.sessionSurfaceLog = await log.waitFor(
      (line) =>
        line.includes("[extension-slots] open surface") &&
        line.includes('"path":"session"') &&
        line.includes(sessionId),
      "the surface entry should open in the focused session",
    );
    await browser.waitUntil(
      async () => {
        const active = (await readActiveSidePaneTab()) ?? "";
        return active.startsWith("plugin-ui:") && active.includes(encodeURIComponent(sessionId));
      },
      { timeout: 20000, timeoutMsg: "the MCP App tab should belong to the session" },
    );
    evidence.sessionPanelTab = await readActiveSidePaneTab();
    await waitForMcpPanelPage((page) => page.ready === "1", "the session MCP App page should run");

    // (h) 扩展进程停止：连续杀掉扩展进程直到预算耗尽。view 条目显示「扩展已停止」与「重新加载」，
    // MCP App 条目照常打开页面（P2a 移到这里的断言）。
    evidence.stoppedLog = await stopExtensionHost();
    const stoppedItems = await waitForNavItems(
      (items) => items.some((item) => item.id === NAV_VIEW_ITEM && item.stopped),
      "the view entry should show the stopped state",
    );
    evidence.stoppedNavItems = stoppedItems;
    const stoppedView = stoppedItems.find((item) => item.id === NAV_VIEW_ITEM)!;
    expect(stoppedView.text).toContain("E2E 导航视图");
    expect(stoppedView.text).toContain("已停止");
    expect(stoppedView.text).toContain("重新加载");
    expect(stoppedView.label).toContain("扩展已停止");
    expect(stoppedItems.find((item) => item.id === NAV_SURFACE_ITEM)?.stopped).toBe(false);
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      screenshots.push(await capture(`nav-stopped-${locale}-${theme}`));
    }
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await openLauncher();
    await clickNavItem(NAV_SURFACE_ITEM);
    await browser.waitUntil(
      async () => ((await readActiveSidePaneTab()) ?? "").startsWith("plugin-ui:"),
      { timeout: 20000, timeoutMsg: "the MCP App entry should still open while stopped" },
    );
    await waitForMcpPanelPage(
      (page) => page.ready === "1",
      "the MCP App page should still run while the extension host is stopped",
    );
    evidence.surfaceWhileStoppedTab = await readActiveSidePaneTab();
    // 点击停止的 view 条目 = 重新加载：清零预算并重启，条目回到正常状态。
    await clickNavItem(NAV_VIEW_ITEM);
    evidence.reloadLog = await log.waitFor(
      (line) => line.includes("reload requested; crash budget reset"),
      "the stopped entry should reload the extension host",
    );
    await waitForNavItems(
      (items) => items.some((item) => item.id === NAV_VIEW_ITEM && !item.stopped),
      "the view entry should recover after reload",
      60000,
    );
    evidence.navScreenshots = screenshots;
  });

  it("文件查看器：view 与 surface 查看器、.xlsx 路由与扩展进程停止", async function () {
    this.timeout(600000);
    const screenshots: string[] = [];
    // (e) file.viewer 的 view：.e2eview（清单写 .E2EVIEW）→ 扩展视图标签，每个文件一个，view.input 带文件。
    await openProjectFileTree(DEFAULT_WORKSPACE);
    await clickFileTreeRow(FILE_DIR);
    await clickFileTreeRow(VIEW_FILE);
    const fileTabId = `extension-view:${FILE_VIEW}:file:${VIEW_FILE}`;
    await browser.waitUntil(async () => (await readActiveSidePaneTab()) === fileTabId, {
      timeout: 20000,
      timeoutMsg: `the file viewer tab should open: ${fileTabId}`,
    });
    const filePane = await waitForViewPane(
      FILE_VIEW,
      (pane) => pane.phase === "running" && pane.displayed,
      "the file viewer tab should be running",
    );
    evidence.fileViewPane = filePane;
    const filePage = await waitForViewPage(
      FILE_VIEW,
      (page) => page.dataset.ready === "1",
      "the file viewer page should render",
    );
    evidence.fileViewPage = filePage.dataset;
    expect(filePage.dataset.viewId).toBe("file");
    expect(filePage.dataset.inputKind).toBe("file");
    expect(filePage.dataset.inputPath).toBe(VIEW_FILE);
    expect(filePage.dataset.inputWorkspace).toBe(DEFAULT_WORKSPACE);
    evidence.fileTabTitle = await browser.execute(
      (id) => document.querySelector(`[data-side-pane-tab-id="${id}"]`)?.textContent ?? "",
      fileTabId,
    );
    expect(evidence.fileTabTitle).toContain("notes.e2eview");
    evidence.fileViewOpenLog = await log.waitFor(
      (line) =>
        line.includes("E2E_ENTRY_VIEW_OPEN view=file") && line.includes(`"path":"${VIEW_FILE}"`),
      "the file viewer instance should receive view.input",
    );
    screenshots.push(await capture("file-view-zh-CN-zai-light"));

    // (f) file.viewer 的 surface：.e2edoc → MCP App 页面（每个文件一个标签），页面就绪后宿主调 open_document。
    await activateFileManagerTab();
    await clickFileTreeRow(DOC_FILE);
    await waitForOpenDocument(DOC_FILE);
    evidence.mcpViewerCalls = await readMcpViewerCalls();
    const docPage = await waitForMcpPanelPage(
      (page) => page.openedPath === DOC_FILE,
      "the MCP App viewer page should receive the open_document result",
    );
    evidence.docPanelPage = docPage;
    const docTab = (await readActiveSidePaneTab()) ?? "";
    evidence.docPanelTab = docTab;
    expect(docTab.startsWith("plugin-ui:")).toBe(true);
    expect(docTab).toContain("report.e2edoc");
    screenshots.push(await capture("file-surface-zh-CN-zai-light"));

    // (g) .xlsx 仍先走内置的官方路由：官方 spreadsheets 插件接管，插件声明的查看器不接管。
    // 修复原因：这条断言最初写成「没有官方插件、走回退」，是因为开发机仓库根目录的本地
    // .zcode/config.json 禁用了官方插件，并经项目配置发现进入了 E2E
    // （docs/testing/conversation-session-e2e-development-workflow.md「已知问题」）。干净环境里官方插件
    // 默认启用，正确行为是官方路由打开 spreadsheets 页面。
    await activateFileManagerTab();
    const linesBeforeXlsx = (await log.lines()).length;
    await clickFileTreeRow(XLSX_FILE);
    await browser.waitUntil(
      async () => String((await readActiveSidePaneTab()) ?? "").includes("spreadsheets%40zcode"),
      { timeout: 30000, timeoutMsg: ".xlsx should open in the official spreadsheets page" },
    );
    evidence.xlsxActiveTab = await readActiveSidePaneTab();
    const xlsxLines = (await log.lines())
      .slice(linesBeforeXlsx)
      .filter((line) => line.includes("file viewer"));
    evidence.xlsxLines = xlsxLines;
    expect(String(evidence.xlsxActiveTab).startsWith("plugin-ui:")).toBe(true);
    expect(xlsxLines.some((line) => line.includes("file viewer routed"))).toBe(false);

    // 扩展进程停止：view 查看器打不开，不参加选择，.e2eview 走内置预览（文件管理标签内）。
    evidence.stoppedAgainLog = await stopExtensionHost();
    await waitForNavItems(
      (items) => items.some((item) => item.id === NAV_VIEW_ITEM && item.stopped),
      "the view entry should show the stopped state again",
    );
    await activateFileManagerTab();
    const linesBeforeStoppedView = (await log.lines()).length;
    await clickFileTreeRow(VIEW_FILE);
    await browser.waitUntil(
      async () => String(await readActiveSidePaneTab()).startsWith("file-manager"),
      { timeout: 15000, timeoutMsg: "the .e2eview file should stay in the file manager preview" },
    );
    evidence.viewFileWhileStoppedTab = await readActiveSidePaneTab();
    expect(
      (await log.lines())
        .slice(linesBeforeStoppedView)
        .some((line) => line.includes("file viewer routed")),
    ).toBe(false);
    await clickNavItem(NAV_VIEW_ITEM);
    await waitForNavItems(
      (items) => items.some((item) => item.id === NAV_VIEW_ITEM && !item.stopped),
      "the view entry should recover after the second reload",
      60000,
    );
    evidence.fileScreenshots = screenshots;
    evidence.lifecycle = (await log.lines()).filter((line) =>
      /status=|static table|declarations|view prepared|view opened|open surface|file viewer|E2E_ENTRY|office-viewer/.test(
        line,
      ),
    );
  });
});
