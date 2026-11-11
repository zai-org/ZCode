// PLM-EXT-P2C：输入框 `@` 面板的插件分组 composer.mention（docs/plugins/extension-host.md §16.6）。
// 隔离 HOME：两个纯 JS fixture 插件（test/e2e/fixtures/fs/plugins/plugin-extension-mention/）复制到 E2E HOME，
// 经 ~/.zcode/cli/config.json 的 plugins.dirs 加载：
// - e2e-ext-mention（扩展）：条目 items 指向扩展命令 search。query 越短命令返回越慢（每少一个字多 1.5 秒），
//   快速输入时旧结果晚到，验证只采用最新一次。
// - e2e-mcp-mention（只有 MCP）：条目 docs 指向 app 可见的工具 mention_search，CLI plugins/mentionItems 调它。
//   首次调用在会话里弹审批：先拒绝（组内显示错误），再「始终允许」（候选项出现，之后不再询问）。
// 发送用 replay：准备轮与插入轮按独立 marker 匹配 plugin-extension-mention.json；
// 断言 provider 请求里有选中候选项的 insertText 原文。
// 运行时证据：Main 日志（[extensions] / [extension-host] / fixture 的 E2E_MENTION_*）、`@` 面板 DOM、
// 输入框的 canonical markdown（Lexical E2E bridge）、MCP server 的调用记录、provider 请求捕获。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TID_PROMPT_SUGGESTION_PANEL, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { createExtensionLog, writePluginDirsConfig } from "#e2e/helpers/extension-host-views";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  approveV4PermissionAlways,
  clickV4Send,
  clickV4SlashOption,
  denyV4PermissionWithFeedback,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P2C";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-mention",
);
const PLUGINS = ["e2e-ext-mention", "e2e-mcp-mention"];
const EXT_PLUGIN = "e2e-ext-mention@inline";
const MCP_PLUGIN = "e2e-mcp-mention@inline";
const EXT_ITEM = `${EXT_PLUGIN}/items`;
const MCP_ITEM = `${MCP_PLUGIN}/docs`;
const EXT_SECTION = `extension:${EXT_ITEM}`;
const MCP_SECTION = `extension:${MCP_ITEM}`;
// query 选不太可能命中文件、会话、插件名的字母，`@` 面板里只剩插件分组。
const SLOW_QUERY = "qx";
const FAST_QUERY = "qxjv";
const CHOSEN = `ext:${EXT_ITEM}:${FAST_QUERY}-2`;
const CHOSEN_INSERT = `E2E_MENTION_INSERT[${FAST_QUERY}#2]`;
// MCP 分组的三次查询：拒绝、始终允许、允许后不再询问。
const MCP_DENIED_QUERY = "jzq";
const MCP_ALLOWED_QUERY = "jzqk";
const MCP_AGAIN_QUERY = "jzqkw";
const SETUP_PROMPT = `E2E_EXT_MENTION_SETUP: Reply with exactly "upstream-e2e-ok" and no other text.`;
const REPLY_PROMPT = `Reply with exactly "upstream-e2e-ok" and no other text.`;

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

function fixtureHome(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-mention");
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
}

interface MentionGroupReading {
  panelOpen: boolean;
  header: string | null;
  status: string | null;
  statusText: string;
  options: Array<{ id: string; text: string }>;
}

/** 读 `@` 面板里一个分组：组名、状态行（loading / error）与候选行（按 data-section-id）。 */
async function readMentionGroup(sectionId: string): Promise<MentionGroupReading> {
  return browser.execute(
    (panelTestId, id) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      const rows = Array.from(
        panel?.querySelectorAll<HTMLElement>("[data-section-id]") ?? [],
      ).filter((element) => element.dataset.sectionId === id);
      const header = rows.find((element) =>
        element.dataset.testid?.startsWith("prompt-suggestion-section"),
      );
      const status = rows.find((element) => element.dataset.status);
      return {
        panelOpen: Boolean(panel),
        header: header?.textContent ?? null,
        status: status?.dataset.status ?? null,
        statusText: status?.textContent ?? "",
        options: rows
          .filter((element) => element.dataset.optionId)
          .map((element) => ({
            id: element.dataset.optionId ?? "",
            text: element.textContent ?? "",
          })),
      };
    },
    TID_PROMPT_SUGGESTION_PANEL,
    sectionId,
  );
}

async function waitForMentionGroup(
  sectionId: string,
  predicate: (group: MentionGroupReading) => boolean,
  message: string,
  timeout = 30000,
): Promise<MentionGroupReading> {
  let latest: MentionGroupReading | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readMentionGroup(sectionId);
        return predicate(latest);
      },
      { timeout, interval: 200, timeoutMsg: message },
    );
  } catch (error) {
    const sections = await browser.execute(
      (panelTestId) => [
        ...new Set(
          Array.from(
            document
              .querySelector(`[data-testid="${panelTestId}"]`)
              ?.querySelectorAll<HTMLElement>("[data-section-id]") ?? [],
          ).map((element) => element.dataset.sectionId ?? ""),
        ),
      ],
      TID_PROMPT_SUGGESTION_PANEL,
    );
    await capturePluginManualReview(CASE_ID, `group-missing-${sectionId.split("/").pop()}`).catch(
      () => undefined,
    );
    throw new Error(`${message}: ${JSON.stringify({ latest, sections })}`, { cause: error });
  }
  return latest!;
}

/** 输入框的 canonical markdown（发送的就是它）与插件提及块。 */
async function readComposer(): Promise<{ markdown: string; chips: string[] }> {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const bridge = (input as HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } })
      ?.__zcodeLexicalInputE2E;
    return {
      markdown: bridge?.getText() ?? "",
      chips: Array.from(
        input?.querySelectorAll<HTMLElement>('[data-mention-category="extensions"]') ?? [],
      ).map((element) => element.textContent ?? ""),
    };
  }, TID_V4_COMPOSER_INPUT);
}

/** 光标移到输入框末尾后输入（选中候选项后编辑器已在 rAF 里拿回焦点）。 */
async function typeAtComposerEnd(text: string): Promise<void> {
  await focusAppWindow();
  await browser.execute((inputTestId) => {
    const input = document.querySelector<
      HTMLElement & { __zcodeLexicalInputE2E?: { focus: () => void } }
    >(`[data-testid="${inputTestId}"]`);
    input?.__zcodeLexicalInputE2E?.focus();
  }, TID_V4_COMPOSER_INPUT);
  await browser.keys(text.split(""));
}

async function readMcpCalls(): Promise<Array<{ event: string; query?: string }>> {
  const raw = await readFile(join(fixtureHome(), "e2e-mcp-mention-calls.jsonl"), "utf8").catch(
    () => "",
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; query?: string });
}

/**
 * 让页面始终按「有焦点」处理（CDP Emulation.setFocusEmulationEnabled），并等文档拿到焦点。
 * `@` 面板只在编辑器有选区时打开，审批卡片的键盘选择也要焦点。
 * 修复原因：同一台机器上并行跑的其他 E2E（别的 worktree）会抢走前台，编辑器 focus 落空，面板不打开
 * （运行时证据：document.hasFocus() === false、activeElement 是 body；切前台后又被立即抢走）。
 * 焦点模拟不依赖操作系统的前台窗口，不和别的运行抢。
 */
async function focusAppWindow(): Promise<void> {
  await browser.electron.execute(async (electron) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
    );
    if (!window) throw new Error("no visible app window");
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
  });
  await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
    timeout: 15000,
    interval: 300,
    timeoutMsg: "the page should have focus under focus emulation",
  });
}

/**
 * 写入 `@` 查询，光标在末尾。先清空、再聚焦、再写入，各占一帧：
 * 修复原因：带着旧文本聚焦时，浏览器会把光标放回旧位置，触发器按光标前的文本算出半截查询
 * （运行时日志：审批后重新打开 `@jzq` 时扩展先收到 q="jz"），tool 条目会因此多弹一次审批。
 * 清空后聚焦没有 `@`，不会查询；最后 setText 由 Lexical 把选区放到末尾。
 */
async function writeMentionQuery(query: string): Promise<void> {
  await focusAppWindow();
  const written = await browser.executeAsync(
    (inputTestId, text, done: (result?: string) => void) => {
      const input = document.querySelector<
        HTMLElement & {
          __zcodeLexicalInputE2E?: { focus: () => void; setText: (value: string) => void };
        }
      >(`[data-testid="${inputTestId}"]`);
      const bridge = input?.__zcodeLexicalInputE2E;
      if (!input?.isContentEditable || !bridge) {
        done("not-editable");
        return;
      }
      bridge.setText("");
      requestAnimationFrame(() => {
        bridge.focus();
        requestAnimationFrame(() => {
          bridge.setText(text);
          done("ok");
        });
      });
    },
    TID_V4_COMPOSER_INPUT,
    `@${query}`,
  );
  if (written !== "ok") {
    throw new Error(`the composer should accept the @ query ${query}: ${written}`);
  }
}

/** 写入 `@` 查询后等面板打开；打不开时带上焦点与输入框状态并截图，便于定位。 */
async function setMentionQuery(query: string): Promise<void> {
  await writeMentionQuery(query);
  try {
    await browser.waitUntil(
      () =>
        browser.execute(
          (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
          TID_PROMPT_SUGGESTION_PANEL,
        ),
      { timeout: 15000, interval: 200, timeoutMsg: `the @ panel should open for ${query}` },
    );
  } catch (error) {
    const state = await browser.execute((inputTestId) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      return {
        hasFocus: document.hasFocus(),
        active: (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
        inComposer: Boolean(input?.contains(document.activeElement)),
        editable: input?.isContentEditable ?? null,
        anchor: window.getSelection()?.anchorNode?.textContent ?? null,
        anchorOffset: window.getSelection()?.anchorOffset ?? null,
        composers: document.querySelectorAll(`[data-testid="${inputTestId}"]`).length,
      };
    }, TID_V4_COMPOSER_INPUT);
    await capturePluginManualReview(CASE_ID, `panel-missing-${query}`).catch(() => undefined);
    throw new Error(`@ panel did not open: ${JSON.stringify(state)}`, { cause: error });
  }
}

/**
 * 审批卡片替换输入框、切换语言或主题时面板会关闭；用同一查询重新打开。键没变，不重发，直接显示已有结果。
 */
const reopenMentionQuery = setMentionQuery;

async function capture(label: string): Promise<string> {
  await browser.pause(300);
  return capturePluginManualReview(CASE_ID, label);
}

describe("PLM-EXT-P2C 输入框 @ 面板的插件分组", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-p2c-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("MCP 工具分组（先跑：之后的查询不再弹审批）：首次调用在会话里弹审批，拒绝显示组内错误，始终允许后显示候选项", async function () {
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
      "the mention extension should activate",
      60000,
    );
    evidence.staticTable = await log.waitFor(
      (line) => line.includes("[extensions]") && /static table rev=\d+ .*items=/.test(line),
      "the window host should read the static table",
    );
    // 先发一条消息，让草稿成为正式会话：「始终允许本项目」只在已持久化的会话里写进项目规则。
    // 运行时证据：草稿（预热会话）里选「始终允许本项目」后 CLI 记
    // `Project permission update skipped without persisted session`，同一会话的下一次调用仍然询问。
    await sendV4Prompt(SETUP_PROMPT);
    const session = await waitForV4Pane(
      (snapshot) =>
        Boolean(snapshot.sessionId && snapshot.sessionId !== "draft") &&
        snapshot.timelineText.includes("upstream-e2e-ok"),
      "the setup message should create a session",
      60000,
    );
    evidence.sessionId = session.sessionId;
    // MCP server 随会话启动：等会话列出它的工具再查，否则首个查询会因工具还没列出而失败。
    await browser.waitUntil(
      async () => (await readMcpCalls()).some((call) => call.event === "listed"),
      {
        timeout: 60000,
        interval: 500,
        timeoutMsg: "the session should list the mention MCP tools",
      },
    );

    // (b1) 拒绝：组内显示「已拒绝调用插件工具」，不影响扩展分组。
    await writeMentionQuery(MCP_DENIED_QUERY);
    await waitForV4PermissionDialog();
    await capture("mcp-mention-approval-zh-CN-zai-light");
    await focusAppWindow();
    expect(await denyV4PermissionWithFeedback("")).toBe(true);
    evidence.deniedLog = await log.waitFor(
      (line) =>
        line.includes("mention items error") &&
        line.includes(`entry=${MCP_ITEM}`) &&
        line.includes("code=plugin_mention_tool_denied"),
      "the window host should report the denied tool call",
    );
    // 审批卡片替换输入框时面板关闭；同一查询重新打开面板，不重发，直接显示拒绝结果。
    await reopenMentionQuery(MCP_DENIED_QUERY);
    const denied = await waitForMentionGroup(
      MCP_SECTION,
      (group) => group.status === "notice",
      "the MCP group should show the denied state",
    );
    evidence.deniedGroup = denied;
    expect(denied.header).toContain("E2E 文档");
    expect(denied.statusText).toContain("已拒绝调用插件工具");
    const extensionBesideDenied = await waitForMentionGroup(
      EXT_SECTION,
      (group) => group.options.length === 3,
      "the extension group should still show its candidates",
    );
    evidence.extensionBesideDenied = extensionBesideDenied.options.map((option) => option.id);
    expect(
      await waitForV4PermissionDialog(2000)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    await capture("mcp-mention-denied-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await reopenMentionQuery(MCP_DENIED_QUERY);
    await waitForMentionGroup(
      MCP_SECTION,
      (group) => group.statusText.includes("denied"),
      "the denied state should follow en-US",
    );
    await capture("mcp-mention-denied-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (b2) 始终允许：候选项出现；之后的查询不再询问。
    await writeMentionQuery(MCP_ALLOWED_QUERY);
    await waitForV4PermissionDialog();
    await focusAppWindow();
    await approveV4PermissionAlways();
    await reopenMentionQuery(MCP_ALLOWED_QUERY);
    const allowed = await waitForMentionGroup(
      MCP_SECTION,
      (group) =>
        group.options.some((option) => option.id === `ext:${MCP_ITEM}:${MCP_ALLOWED_QUERY}-1`),
      "the MCP group should show the tool's candidates after approval",
    );
    evidence.allowedGroup = allowed;
    await setMentionQuery(MCP_AGAIN_QUERY);
    const again = await waitForMentionGroup(
      MCP_SECTION,
      (group) =>
        group.options.some((option) => option.id === `ext:${MCP_ITEM}:${MCP_AGAIN_QUERY}-1`),
      "the next query should not ask again",
    );
    evidence.againGroup = again;
    expect(
      await waitForV4PermissionDialog(1000)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      await reopenMentionQuery(MCP_AGAIN_QUERY);
      await waitForMentionGroup(
        MCP_SECTION,
        (group) => (group.header ?? "").includes(locale === "en-US" ? "E2E docs" : "E2E 文档"),
        `the MCP group title should follow ${locale}`,
      );
      await capture(`mcp-mention-items-${locale}-${theme}`);
    }
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    const calls = await readMcpCalls();
    evidence.mcpCalls = calls;
    // 被拒绝的调用没有到达 server；批准后的两次都到了。
    expect(calls.filter((call) => call.event === "call").map((call) => call.query)).toEqual([
      MCP_ALLOWED_QUERY,
      MCP_AGAIN_QUERY,
    ]);
    evidence.lifecycle = (await log.lines()).filter((line) =>
      /static table|mention items|E2E_MENTION|activated in/.test(line),
    );
  });

  it("扩展命令分组：快速输入只采用最新结果，选中插入 insertText，发送后请求里有原文", async function () {
    this.timeout(600000);

    // (a1) 慢查询：命令收到 { query: "qx" }，结果 3 秒后才回。结果回来前组里不会有 qx 的候选项
    // （上一个用例已经查过，组里是上次采用的结果；没有结果时显示加载）。
    const linesBeforeSlow = (await log.lines()).length;
    await setMentionQuery(SLOW_QUERY);
    evidence.slowQueryLog = await log.waitFor(
      (line) => line.includes(`E2E_MENTION_QUERY q="${SLOW_QUERY}"`),
      "the extension command should receive the slow query",
    );
    expect(String(evidence.slowQueryLog)).toContain("scope=session");
    const pending = await readMentionGroup(EXT_SECTION);
    evidence.pendingGroup = pending;
    expect(pending.header).toContain("E2E 条目");
    expect(pending.options.some((option) => option.id.includes(`:${SLOW_QUERY}-`))).toBe(false);
    await capture("mention-pending-zh-CN-zai-light");

    // (a2) 快速输入：新查询立即返回，组显示它的候选项。
    await setMentionQuery(FAST_QUERY);
    const fast = await waitForMentionGroup(
      EXT_SECTION,
      (group) => group.options.some((option) => option.id === CHOSEN),
      "the extension group should show the latest query's candidates",
    );
    evidence.fastGroup = fast;
    expect(fast.options.map((option) => option.id)).toEqual(
      [1, 2, 3].map((n) => `ext:${EXT_ITEM}:${FAST_QUERY}-${n}`),
    );

    // (a3) 旧查询的结果晚到：丢弃，组仍是最新查询的候选项。
    evidence.slowDoneLog = await log.waitFor(
      (line) => line.includes(`E2E_MENTION_DONE q="${SLOW_QUERY}"`),
      "the slow query should finish after the fast one",
    );
    const queryOrder = (await log.lines())
      .slice(linesBeforeSlow)
      .filter((line) => line.includes("E2E_MENTION_"));
    evidence.queryOrder = queryOrder;
    const fastDone = queryOrder.findIndex((line) =>
      line.includes(`E2E_MENTION_DONE q="${FAST_QUERY}"`),
    );
    const slowDone = queryOrder.findIndex((line) =>
      line.includes(`E2E_MENTION_DONE q="${SLOW_QUERY}"`),
    );
    expect(fastDone).toBeGreaterThanOrEqual(0);
    expect(slowDone).toBeGreaterThan(fastDone);
    // 每次输入只发一次查询（没有面板刚打开时的空串查询）。
    expect(
      queryOrder
        .filter((line) => line.includes("E2E_MENTION_QUERY"))
        .map((line) => /q="([^"]*)"/.exec(line)?.[1]),
    ).toEqual([SLOW_QUERY, FAST_QUERY]);
    // 晚到的结果要经过 Window Host 回到 Renderer：等一小段时间再读，确认没有被它覆盖。
    await browser.pause(1500);
    const afterStale = await readMentionGroup(EXT_SECTION);
    evidence.afterStaleGroup = afterStale;
    expect(afterStale.options.map((option) => option.id)).toEqual(fast.options.map((o) => o.id));
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      await reopenMentionQuery(FAST_QUERY);
      await waitForMentionGroup(
        EXT_SECTION,
        (group) =>
          (group.header ?? "").includes(locale === "en-US" ? "E2E items" : "E2E 条目") &&
          group.options.length === 3,
        `the extension group title should follow ${locale}`,
      );
      await capture(`mention-items-${locale}-${theme}`);
    }
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await reopenMentionQuery(FAST_QUERY);
    await waitForMentionGroup(
      EXT_SECTION,
      (group) => group.options.some((option) => option.id === CHOSEN),
      "the extension group should still be open",
    );

    // (a4) 选中：插入提及块，输入框的 markdown 就是 insertText 原文（后面跟一个空格）。
    await focusAppWindow();
    expect(await clickV4SlashOption(CHOSEN)).toBe(true);
    await browser.waitUntil(async () => (await readComposer()).markdown === `${CHOSEN_INSERT} `, {
      timeout: 10000,
      timeoutMsg: `the composer markdown should be the insertText: ${JSON.stringify(await readComposer())}`,
    });
    const composer = await readComposer();
    evidence.composerAfterChoose = composer;
    expect(composer.chips).toEqual([`E2E ${FAST_QUERY} #2`]);
    await capture("mention-chip-zh-CN-zai-light");

    // (a5) 发送（replay）：provider 请求里有 insertText 原文。
    await typeAtComposerEnd(REPLY_PROMPT);
    await browser.waitUntil(
      async () => (await readComposer()).markdown === `${CHOSEN_INSERT} ${REPLY_PROMPT}`,
      {
        timeout: 10000,
        timeoutMsg: `the composer should hold the chip and the prompt: ${JSON.stringify(await readComposer())}`,
      },
    );
    await clickV4Send();
    const request = await waitForUpstreamNetworkCapture(CHOSEN_INSERT);
    evidence.requestPath = request.path;
    // 请求体是 JSON：提示词里的引号被转义，按同一种转义比较。
    expect(JSON.stringify(request.requestJson)).toContain(
      JSON.stringify(`${CHOSEN_INSERT} ${REPLY_PROMPT}`).slice(1, -1),
    );
    await waitForV4Pane(
      (snapshot) =>
        snapshot.timelineText.includes(`E2E ${FAST_QUERY} #2`) ||
        snapshot.timelineText.includes(CHOSEN_INSERT),
      "the sent message with the mention should appear in the timeline",
      60000,
    );
    await capture("mention-sent-zh-CN-zai-light");
  });
});
