// PLM-EXT-2B：扩展视图、context 组成与生成速率（docs/plugins/extension-host.md §7.2、§8、§9、§10、§15、§16.11）。
// 隔离 HOME：fixture 插件复制到 E2E HOME，经 ~/.zcode/cli/config.json 的 plugins.dirs 加载。
// 发送消息走 replay：E2E_PROVIDER_REPLAY_FIXTURE_PATH 指向 common.json 与 plugin-extension-views.json，
// 提示词带 E2E_SLOW_STREAM，命中既有受控慢流（8s / 16s / 24s 各一段文字，90s 结束）。
// 运行时证据取自 Main 日志（[extension-host] / [extensions] 前缀与 fixture 写的 E2E_VIEW_*）与视图页面的 DOM。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TID_CHAT_CONTEXT_USAGE_TRIGGER, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  clickSlot,
  closeActiveSidePaneTab,
  createExtensionLog,
  openLauncher,
  openLauncherView,
  readActiveSidePaneTab,
  readSlot,
  readViewPane,
  waitForSlot,
  waitForViewPage,
  waitForViewPane,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  ensureUpstreamModelForE2E,
} from "#e2e/helpers/upstream-provider";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-2B";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(process.cwd(), "test/e2e/fixtures/fs/plugins/plugin-extension-views");
const PLUGINS = ["e2e-ext-view", "e2e-ext-factory"];
const VIEW_PLUGIN = "e2e-ext-view@inline";
const CONTEXT_VIEW = `${VIEW_PLUGIN}/context`;
const FACTORY_VIEW = "e2e-ext-factory@inline/factory";
const TPS_ITEM = `${VIEW_PLUGIN}/tps`;
const SILENT_ITEM = `${VIEW_PLUGIN}/silent`;
/** provider-basic 的慢流夹具报告的 usage（与原 PLM-EXT-2C 相同）。 */
const SLOW_STREAM_USAGE = { input: 120, output: 12 };
const PROMPT = `E2E_SLOW_STREAM E2E_EXT_VIEW_TPS: Reply with exactly "deepseek-e2e-ok" and no other text.`;

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

/** App 输入框用量圆环的「已用」：aria-label「上下文已用 N / 总量 M」/「Context usage N of M」里的第一个数。 */
async function readComposerContextUsed(): Promise<number | null> {
  const label = await browser.execute(
    (id) =>
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getAttribute("aria-label"),
    TID_CHAT_CONTEXT_USAGE_TRIGGER,
  );
  const first = label?.match(/\d[\d,.\s]*/)?.[0];
  return first ? Number(first.replace(/\D/g, "")) : null;
}

function fixtureHome(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-views");
}

async function seedExtensionFixtures(): Promise<void> {
  const target = fixtureHome();
  await mkdir(target, { recursive: true });
  for (const name of PLUGINS) {
    await cp(join(FIXTURE_ROOT, name), join(target, name), { recursive: true, force: true });
  }
  await writePluginDirsConfig(
    PLUGINS.map((name) => join(target, name)),
    PLUGINS.map((name) => `${name}@inline`),
  );
}

/** Renderer 的屏幕会话报告日志（`[extension-slots] workbench report {...}`），按出现顺序。 */
function parseWorkbenchReports(
  lines: readonly string[],
): Array<{ sessions: number; drafts: number }> {
  const marker = "[extension-slots] workbench report ";
  return lines
    .filter((line) => line.includes(marker))
    .map((line) => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
}

/** fixture 页面报告的渲染结果（E2E_VIEW_RENDERED 后的 JSON）。 */
async function readRenderedReports(): Promise<Array<Record<string, unknown>>> {
  return (await log.lines())
    .filter((line) => line.includes("E2E_VIEW_RENDERED "))
    .map((line) => JSON.parse(line.slice(line.indexOf("{", line.indexOf("E2E_VIEW_RENDERED")))));
}

describe("PLM-EXT-2B 扩展视图、context 组成与生成速率", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-2b-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("草稿预演、换模型、生成速率、views.open、写法二与扩展进程换代", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedExtensionFixtures();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setCurrentElectronRendererContentSize(1400, 900);
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await log.waitFor(
      (line) => line.includes(`[${VIEW_PLUGIN}] activated in`),
      "the view fixture should activate",
      60000,
    );
    evidence.notDeclared = await log.waitFor(
      (line) => line.includes("E2E_VIEW_OPEN_NOT_DECLARED"),
      "views.open with an undeclared id should fail locally",
    );
    expect(evidence.notDeclared).toContain("E2E_VIEW_OPEN_NOT_DECLARED not-declared");
    await waitForSlot(TPS_ITEM, (slot) => slot.text.includes("E2E tps"), "tps slot idle text");
    // 原由 PLM-EXT-2C 断言：清单声明、但扩展从没设置文字的插槽条目不显示（§6）。
    expect(await readSlot(SILENT_ITEM)).toBeNull();

    // (a) 草稿：从启动页「扩展」分区打开视图，标签页显示首个请求的预演。
    await openLauncherView(`${VIEW_PLUGIN}/open-view`);
    const pane = await waitForViewPane(
      CONTEXT_VIEW,
      (item) => item.phase === "running" && item.displayed,
      "context view should be running",
    );
    evidence.draftPane = pane;
    expect(pane.scope).toBe("session");
    expect(pane.gen).toBe("1");
    // 写法一的打开回调（§16.11）：实例打开时调用一次，作用域与标签页一致。
    evidence.didOpen = await log.waitFor(
      (line) => line.includes(`E2E_VIEW_DID_OPEN instance=${pane.instance}`),
      "onDidOpen should run when the view instance opens",
    );
    expect(evidence.didOpen).toContain("scope=session");
    const draftPage = await waitForViewPage(
      CONTEXT_VIEW,
      (page) => page.dataset.phase === "draft-preview",
      "the draft view should show the draft preview",
    );
    evidence.draftPage = draftPage;
    const categories = (draftPage.dataset.categories ?? "").split(",");
    expect(categories).toContain("system_prompt");
    expect(categories).toContain("system_tool_schemas");
    // 原由 PLM-EXT-2C 断言：context.get 的类别带条目（工具名、技能名、指令文件）。
    evidence.draftItems = draftPage.dataset.items;
    expect(Number(draftPage.dataset.items)).toBeGreaterThan(0);
    const draftReport = (await readRenderedReports()).find(
      (report) => report.phase === "draft-preview",
    );
    evidence.draftReport = draftReport;
    expect(Number(draftReport?.systemPromptTokens)).toBeGreaterThan(0);
    expect(Number(draftReport?.systemToolTokens)).toBeGreaterThan(0);
    const draftSessionId = draftPage.dataset.sessionId ?? "";
    expect(draftSessionId).toMatch(/^sess_/);
    // 预演没有副作用：草稿仍是草稿，任务列表里没有这个会话。
    const afterPreview = await getV4PaneSnapshot();
    evidence.afterPreviewPane = afterPreview.sessionId;
    expect(afterPreview.sessionId === null || afterPreview.sessionId === "draft").toBe(true);
    expect(await $(`[data-testid="${testId(TID_TASK_ITEM, draftSessionId)}"]`).isExisting()).toBe(
      false,
    );
    expect(await readActiveSidePaneTab()).toBe(`extension-view:${CONTEXT_VIEW}`);

    // (b) 草稿里换模型：Window Host 补发一条 context.onDidChange，视图按新模型重新预演。
    const firstModel = draftPage.dataset.model ?? "";
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "");
    const switchedPage = await waitForViewPage(
      CONTEXT_VIEW,
      (page) => page.dataset.model === UPSTREAM_SECONDARY_MODEL,
      "the view should show the newly selected draft model",
    );
    evidence.modelSwitch = { from: firstModel, to: switchedPage.dataset.model };
    expect(switchedPage.dataset.phase).toBe("draft-preview");
    expect(firstModel).not.toBe(UPSTREAM_SECONDARY_MODEL);
    evidence.draftModelChangeLog = await log.waitFor(
      (line) => line.includes("context changed by draft model"),
      "the window host should report the draft model change",
    );

    // (c) 发送一条消息：流式阶段 composer.status 显示估算的 tok/s，结束后换成准确值。
    // 同时取证草稿首发的交接：从发送到窗格变成正式会话，屏幕会话报告里这个会话一直在（§16.11）。
    const linesBeforeSend = (await log.lines()).length;
    await sendV4Prompt(PROMPT);
    const streaming = await waitForSlot(
      TPS_ITEM,
      (slot) => slot.label.includes("E2E_TPS streaming"),
      "composer.status should show a streaming tok/s",
      90000,
    );
    evidence.streaming = streaming;
    expect(streaming.text).toMatch(/\d+\.\d{2} tok\/s/);
    // 流式期间贡献表只走增量：记下此刻的快照日志行数，结束时比较。
    const snapshotLinesBefore = (await log.lines()).filter((line) =>
      line.includes("contributions snapshot"),
    ).length;
    const final = await waitForSlot(
      TPS_ITEM,
      (slot) => slot.label.includes("E2E_TPS final"),
      "composer.status should switch to the final tok/s",
      150000,
    );
    evidence.final = final;
    expect(final.text).toMatch(/\d+\.\d{2} tok\/s/);
    // 原由 PLM-EXT-2C 断言：final 事件带这次请求的模型（草稿里换过的模型）、服务商的输出 token 与首 token 时间。
    expect(final.label).toContain(UPSTREAM_SECONDARY_MODEL);
    expect(final.label).toMatch(new RegExp(`out=${SLOW_STREAM_USAGE.output} ttft=\\d+`));
    const snapshotLinesAfter = (await log.lines()).filter((line) =>
      line.includes("contributions snapshot"),
    ).length;
    evidence.snapshotLinesDuringStream = snapshotLinesAfter - snapshotLinesBefore;
    expect(snapshotLinesAfter - snapshotLinesBefore).toBe(0);
    evidence.tpsLog = (await log.lines()).filter((line) => line.includes("E2E_VIEW_TPS"));
    await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "the draft should become a session after the first send",
      60000,
    );
    await log.waitFor(
      (line) => line.includes('[extension-slots] workbench report {"sessions":1,"drafts":0}'),
      "the workbench report should switch from the draft to the session",
    );
    const handoffLines = (await log.lines()).slice(linesBeforeSend);
    const handoffReports = parseWorkbenchReports(handoffLines);
    evidence.handoffReports = handoffReports;
    evidence.handoffWorkbenchEvents = handoffLines.filter((line) =>
      line.includes("E2E_VIEW_WORKBENCH"),
    );
    // 修复前：预热会话提升后、正式 sessionId 到达前约 260ms 报告为空（sessions=0）。
    expect(handoffReports.length).toBeGreaterThan(0);
    expect(handoffReports.every((report) => report.sessions === 1)).toBe(true);
    expect(handoffLines.some((line) => line.includes("E2E_VIEW_WORKBENCH []"))).toBe(false);
    const requestPage = await waitForViewPage(
      CONTEXT_VIEW,
      (page) =>
        page.dataset.phase === "request" && (page.dataset.categories ?? "").includes("messages"),
      "the view should refresh to the request composition with messages",
      120000,
    );
    evidence.requestPage = requestPage;
    expect(requestPage.dataset.sessionId).toBe(draftSessionId);
    // 原由 PLM-EXT-2C 断言（§11 总量对齐）：context.get 的 providerContextTokens 等于输入框圆环的「已用」，
    // 两者是 CLI 用同一函数、同一份服务商 usage 算出的（input + 这次回复的 output）。
    const providerPage = await waitForViewPage(
      CONTEXT_VIEW,
      (page) => page.dataset.phase === "request" && Boolean(page.dataset.providerContextTokens),
      "context.get should carry providerContextTokens after the provider usage arrives",
      120000,
    );
    let ringUsed: number | null = null;
    await browser.waitUntil(
      async () => {
        ringUsed = await readComposerContextUsed();
        return ringUsed === SLOW_STREAM_USAGE.input + SLOW_STREAM_USAGE.output;
      },
      { timeout: 30000, interval: 300, timeoutMsg: "the composer ring should show the usage" },
    );
    evidence.providerContextTokens = { page: providerPage.dataset.providerContextTokens, ringUsed };
    expect(Number(providerPage.dataset.providerContextTokens)).toBe(ringUsed);
    const afterSend = await readViewPane(CONTEXT_VIEW);
    // 草稿发送首条消息后标签页保留，实例不重建（同一会话）。
    expect(afterSend?.instance).toBe(pane.instance);

    // (d) 命令里调 views.open：先切到另一个标签，再点 composer.status，标签页回到前台。
    await openLauncher();
    expect(await readActiveSidePaneTab()).not.toBe(`extension-view:${CONTEXT_VIEW}`);
    await clickSlot(TPS_ITEM);
    await browser.waitUntil(
      async () => (await readActiveSidePaneTab()) === `extension-view:${CONTEXT_VIEW}`,
      { timeout: 20000, timeoutMsg: "views.open should focus the context view tab" },
    );
    evidence.openedByCommand = await log.waitFor(
      (line) => line.includes("E2E_VIEW_OPENED_BY_COMMAND"),
      "the command should finish after the ack",
    );
    expect(evidence.openedByCommand).toContain("scope=session");
    evidence.openAck = await log.waitFor(
      (line) => line.includes("views.open acked") && line.includes("ok=true"),
      "the window host should log the views.open ack",
    );

    // App 环境（§16.11）：激活时 env.get 拿到 Renderer 已报告的语言；env.onDidChange 订阅后的
    // 第一个事件就是这个当前值；用例切到 zh-CN 后再收到一次。
    const envGet = await log.waitFor(
      (line) => line.includes("E2E_VIEW_ENV_GET"),
      "env.get should settle during activation",
    );
    evidence.envGet = envGet;
    const envEvents = (await log.lines()).filter((line) => line.includes("E2E_VIEW_ENV_CHANGED"));
    evidence.envInitial = envEvents[0];
    if (envGet.includes("locale=")) {
      const activationLocale = envGet.slice(envGet.indexOf("locale=") + "locale=".length).trim();
      expect(envEvents[0]).toContain(`E2E_VIEW_ENV_CHANGED locale=${activationLocale}`);
    } else {
      // Renderer 还没报告时 env.get 抛 host-unavailable，第一个事件在报告到达时推送。
      expect(envGet).toContain("E2E_VIEW_ENV_GET error=host-unavailable");
      expect(envEvents.length).toBeGreaterThan(0);
    }
    expect(envEvents.some((line) => line.includes("E2E_VIEW_ENV_CHANGED locale=zh-CN"))).toBe(true);

    // (g) 深浅主题、中英文截图：视图标签与 composer.status。
    const linesBeforeLocaleSwitch = (await log.lines()).length;
    const screenshots: string[] = [];
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      // 原由 PLM-EXT-2C 断言：页面经 hostContext 跟随宿主的主题与语言。
      await waitForViewPage(
        CONTEXT_VIEW,
        (page) =>
          page.dataset.phase === "request" &&
          page.dataset.locale === locale &&
          page.dataset.theme === (theme === "zai-dark" ? "dark" : "light"),
        `the view should follow ${locale} ${theme}`,
      );
      screenshots.push(await capturePluginManualReview(CASE_ID, `view-${locale}-${theme}`));
    }
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    // 切换 App 语言后扩展收到 env.onDidChange：先 en-US，切回后 zh-CN（只看切换之后的日志）。
    await browser.waitUntil(
      async () => {
        const events = (await log.lines())
          .slice(linesBeforeLocaleSwitch)
          .filter((line) => line.includes("E2E_VIEW_ENV_CHANGED"))
          .map((line) => line.slice(line.indexOf("locale=") + "locale=".length).trim());
        evidence.envSwitched = events;
        return events.join(",") === "en-US,zh-CN";
      },
      {
        timeout: 20000,
        interval: 500,
        timeoutMsg: "env.onDidChange should follow the app language",
      },
    );

    // (e) 写法二：插件自己的 MCP server，首次打开时按 onView 激活。
    await openLauncherView("e2e-ext-factory@inline/open-factory");
    await waitForViewPane(
      FACTORY_VIEW,
      (item) => item.phase === "running" && item.displayed,
      "factory view should be running",
    );
    const factoryPage = await waitForViewPage(
      FACTORY_VIEW,
      (page) => page.text.includes("E2E factory pong"),
      "factory view page should call its own server",
    );
    evidence.factoryPage = factoryPage;
    expect(factoryPage.dataset.scope).toBe("session");
    await log.waitFor(
      (line) => line.includes("[e2e-ext-factory@inline] activating (onView:factory)"),
      "the factory extension should activate on view",
    );
    screenshots.push(await capturePluginManualReview(CASE_ID, "factory-zh-CN-zai-light"));

    // (f) 杀掉扩展进程：gen + 1 重启，视图标签按新代际重建。
    await browser.execute((id) => {
      document
        .querySelector<HTMLElement>(`[data-side-pane-tab-id="extension-view:${id}"]`)
        ?.click();
    }, CONTEXT_VIEW);
    const state = JSON.parse(
      await readFile(join(fixtureHome(), "e2e-ext-view-state.json"), "utf8"),
    ) as { pid: number };
    evidence.gen1Pid = state.pid;
    process.kill(state.pid, "SIGKILL");
    const rebuilt = await waitForViewPane(
      CONTEXT_VIEW,
      (item) => item.gen === "2" && item.phase === "running",
      "the view should be rebuilt with gen 2",
      60000,
    );
    evidence.rebuiltPane = rebuilt;
    expect(rebuilt.instance).not.toBe(pane.instance);
    const rebuiltPage = await waitForViewPage(
      CONTEXT_VIEW,
      (page) => page.dataset.phase === "request",
      "the rebuilt view should render the composition again",
    );
    evidence.rebuiltPage = rebuiltPage.dataset;
    screenshots.push(await capturePluginManualReview(CASE_ID, "rebuilt-gen2-zh-CN-zai-light"));
    evidence.screenshots = screenshots;

    // 原由 PLM-JARVIS-2 断言：关掉视图标签，面板里没有这个视图；扩展收到这个实例的 onDidClose。
    await closeActiveSidePaneTab();
    await browser.waitUntil(async () => (await readViewPane(CONTEXT_VIEW)) === null, {
      timeout: 15000,
      interval: 300,
      timeoutMsg: "the context view should close",
    });
    evidence.viewClosed = await log.waitFor(
      (line) => line.includes(`E2E_VIEW_CLOSED instance=${rebuilt.instance}`),
      "the extension should see onDidClose for the closed view",
    );

    evidence.lifecycle = (await log.lines()).filter((line) =>
      /status=|paired|activated|snapshot|static table|declarations|view prepared|view closed|view opened|pump|views\.open|workbench report|env report|E2E_VIEW_(CONTEXT_CHANGED|WORKBENCH|CLOSED|DID_OPEN|ENV)|E2E_FACTORY/.test(
        line,
      ),
    );
  });
});
