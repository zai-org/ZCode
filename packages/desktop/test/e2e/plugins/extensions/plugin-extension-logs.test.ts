// PLM-EXT-P2E：扩展日志控制台（docs/plugins/extension-host.md §16.8、§16.10 第 5 步）。
// 隔离 HOME：两个纯 JS fixture 插件（test/e2e/fixtures/fs/plugins/plugin-extension-logs/）复制到 E2E HOME，
// 经 ~/.zcode/cli/config.json 的 plugins.dirs 加载：
// - e2e-ext-logs：激活时 info / warn / error 各一行、一行超过 4KB 的长日志、console.log 与 console.warn 各一行；
//   composer.status 条目执行命令 emit，每次再写三个级别各一行。
// - e2e-ext-logs-peer：激活时写一行，用来验证按插件过滤。
// 运行时证据：日志标签每行的 data-*（seq、level、gen、plugin id）、Main 日志文件、Renderer 的 [extension-slots] 日志。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_EXTENSION_LOGS,
  TID_EXTENSION_LOGS_CLEAR,
  TID_EXTENSION_LOGS_COPY,
  TID_EXTENSION_LOGS_LEVEL_FILTER,
  TID_EXTENSION_LOGS_ROW,
  TID_EXTENSION_LOGS_SOURCE_FILTER,
  TID_SIDE_PANE_EXTENSION_LOGS_ITEM,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  clickSlot,
  createExtensionLog,
  openLauncher,
  readActiveSidePaneTab,
  waitForSlot,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P2E";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(process.cwd(), "test/e2e/fixtures/fs/plugins/plugin-extension-logs");
const PLUGINS = ["e2e-ext-logs", "e2e-ext-logs-peer"];
const LOGS_PLUGIN = "e2e-ext-logs@inline";
const PEER_PLUGIN = "e2e-ext-logs-peer@inline";
const EMIT_ITEM = `${LOGS_PLUGIN}/emit`;
const LOGS_TAB = "extension-logs";
/** 与协议的 EXTENSION_LOG_MESSAGE_MAX_BYTES、EXTENSION_LOG_TRUNCATED_MARKER 一致。 */
const MESSAGE_MAX_BYTES = 4096;
const TRUNCATED_MARKER = "…[truncated]";

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

interface LogRow {
  seq: number;
  level: string;
  gen: number;
  pluginId: string | null;
  message: string;
}

function fixtureHome(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-logs");
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

async function readExtensionPid(): Promise<number> {
  const state = JSON.parse(
    await readFile(join(fixtureHome(), "e2e-ext-logs-state.json"), "utf8"),
  ) as { pid: number };
  return state.pid;
}

/** 日志标签当前显示的行（已按来源与级别过滤）。 */
async function readRows(): Promise<LogRow[]> {
  return browser.execute(
    (paneTestId, rowTestId) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid="${paneTestId}"] [data-testid="${rowTestId}"]`,
        ),
      ).map((row) => ({
        seq: Number(row.dataset.seq),
        level: row.dataset.level ?? "",
        gen: Number(row.dataset.gen),
        pluginId: row.dataset.pluginId ?? null,
        // 最后一列是消息本身。
        message: row.lastElementChild?.textContent ?? "",
      })),
    TID_EXTENSION_LOGS,
    TID_EXTENSION_LOGS_ROW,
  );
}

async function waitForRows(
  predicate: (rows: LogRow[]) => boolean,
  message: string,
  timeout = 30000,
): Promise<LogRow[]> {
  let latest: LogRow[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latest = await readRows();
        return predicate(latest);
      },
      { timeout, interval: 300 },
    );
  } catch {
    throw new Error(
      `${message}: ${JSON.stringify(latest.map((row) => ({ ...row, message: row.message.slice(0, 120) })))}`,
    );
  }
  return latest;
}

const hasRow = (rows: LogRow[], match: (row: LogRow) => boolean) => rows.some(match);
const byMessage = (text: string, extra: (row: LogRow) => boolean = () => true) => {
  return (row: LogRow) => row.message.includes(text) && extra(row);
};

async function waitForActiveLogsTab(): Promise<void> {
  await browser.waitUntil(async () => (await readActiveSidePaneTab()) === LOGS_TAB, {
    timeout: 15000,
    timeoutMsg: "the extension-logs tab should be active",
  });
  await $(`[data-testid="${TID_EXTENSION_LOGS}"][data-loaded="true"]`).waitForDisplayed({
    timeout: 15000,
  });
}

async function openLogsFromLauncher(): Promise<void> {
  await openLauncher();
  await browser.waitUntil(
    async () =>
      browser.execute((rowTestId) => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${rowTestId}"]`);
        if (!row || row.getBoundingClientRect().width === 0) return false;
        row.scrollIntoView({ block: "center" });
        row.click();
        return true;
      }, TID_SIDE_PANE_EXTENSION_LOGS_ITEM),
    { timeout: 30000, interval: 500, timeoutMsg: "launcher should list 扩展日志" },
  );
  await waitForActiveLogsTab();
}

async function openLogsFromCommandCenter(): Promise<void> {
  await $('[data-testid="sidebar-search-open"]').click();
  const input = $('[role="dialog"] [cmdk-input]');
  await input.waitForDisplayed({ timeout: 10000 });
  await input.setValue(">打开扩展日志");
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"] [cmdk-item]'),
        ).find((element) => /打开扩展日志|Open extension logs/.test(element.textContent ?? ""));
        if (!item) return false;
        item.click();
        return true;
      }),
    { timeout: 10000, timeoutMsg: "command center should list 打开扩展日志" },
  );
  await waitForActiveLogsTab();
}

async function closeLogsTab(): Promise<void> {
  await browser.execute((tabId) => {
    document
      .querySelector<HTMLElement>(`[data-side-pane-tab-id="${tabId}"] button[aria-label]`)
      ?.click();
  }, LOGS_TAB);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (tabId) => !document.querySelector(`[data-side-pane-tab-id="${tabId}"]`),
        LOGS_TAB,
      ),
    { timeout: 10000, timeoutMsg: "the extension-logs tab should close" },
  );
}

/** Radix Select 靠真实指针事件开合：用 WDIO 点击触发器与选项。 */
async function selectFilter(triggerTestId: string, optionText: string): Promise<void> {
  await $(`[data-testid="${triggerTestId}"]`).click();
  const option = await browser.waitUntil(
    async () => {
      for (const candidate of await $$('[role="option"]')) {
        if ((await candidate.getText()).trim() === optionText) return candidate;
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `filter option ${optionText} should be listed` },
  );
  await option.click();
  await browser.waitUntil(async () => (await $$('[role="option"]').length) === 0, {
    timeout: 5000,
    timeoutMsg: "the filter menu should close",
  });
}

async function readFilterLabel(triggerTestId: string): Promise<string> {
  return (await $(`[data-testid="${triggerTestId}"]`).getText()).trim();
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("PLM-EXT-P2E 扩展日志控制台", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-p2e-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("实时日志、按插件与级别过滤、清空、复制、扩展进程崩溃后旧日志保留", async function () {
    this.timeout(300000);
    requirePluginManualReview();
    await seedFixtures();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await waitForSlot(EMIT_ITEM, (slot) => slot.text === "E2E logs", "emit slot should render");

    // (a) 启动页「扩展」分区的「扩展日志」一行打开 extension-logs 标签。
    await openLauncher();
    await browser.execute((rowTestId) => {
      document.querySelector(`[data-testid="${rowTestId}"]`)?.scrollIntoView({ block: "center" });
    }, TID_SIDE_PANE_EXTENSION_LOGS_ITEM);
    const screenshots: string[] = [
      await capturePluginManualReview(CASE_ID, "launcher-zh-CN-zai-light"),
    ];
    await openLogsFromLauncher();

    // (b) 激活时的三行带插件归因与级别；console.* 同样归因；第二个插件与监管器生命周期行都在。
    const initial = await waitForRows(
      (rows) =>
        hasRow(
          rows,
          byMessage("E2E_LOGS_ACTIVATE_INFO", (row) => row.level === "info"),
        ) &&
        hasRow(
          rows,
          byMessage("E2E_LOGS_ACTIVATE_WARN", (row) => row.level === "warn"),
        ) &&
        hasRow(
          rows,
          byMessage("E2E_LOGS_ACTIVATE_ERROR", (row) => row.level === "error"),
        ) &&
        hasRow(rows, byMessage("E2E_LOGS_PEER_INFO")) &&
        hasRow(rows, byMessage("E2E_LOGS_STDOUT")) &&
        hasRow(rows, byMessage("E2E_LOGS_CONSOLE_WARN")) &&
        hasRow(
          rows,
          byMessage("status=running", (row) => row.pluginId === null),
        ),
      "activation logs should appear in the log tab",
    );
    evidence.initialRows = initial.length;
    for (const marker of ["E2E_LOGS_ACTIVATE_INFO", "E2E_LOGS_ACTIVATE_WARN"]) {
      const row = initial.find(byMessage(marker));
      expect(row?.pluginId).toBe(LOGS_PLUGIN);
      expect(row?.gen).toBe(1);
    }
    expect(initial.find(byMessage("E2E_LOGS_PEER_INFO"))?.pluginId).toBe(PEER_PLUGIN);
    // console.* 在插件上下文里按插件归因，级别按方法映射，不再是没有归属的 [stdout] 行。
    const consoleLog = initial.find(byMessage("E2E_LOGS_STDOUT"));
    expect(consoleLog?.pluginId).toBe(LOGS_PLUGIN);
    expect(consoleLog?.level).toBe("info");
    expect(consoleLog?.message.startsWith("[stdout]")).toBe(false);
    expect(initial.find(byMessage("E2E_LOGS_CONSOLE_WARN"))?.level).toBe("warn");
    expect(initial.find(byMessage("E2E_LOGS_CONSOLE_WARN"))?.pluginId).toBe(LOGS_PLUGIN);
    // seq 严格递增：快照与追加合起来没有重复。
    expect(initial.every((row, index) => index === 0 || row.seq > initial[index - 1]!.seq)).toBe(
      true,
    );
    // 超过 4KB 的行在缓冲里截断，日志文件照写完整内容。
    const longRow = initial.find(byMessage("E2E_LOGS_LONG"));
    evidence.longRowBytes = longRow ? utf8Length(longRow.message) : null;
    expect(longRow?.message.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(utf8Length(longRow?.message ?? "")).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    const longFileLine = await log.waitFor(
      (line) => line.includes(`[${LOGS_PLUGIN}] E2E_LOGS_LONG`),
      "the log file should keep the long line",
    );
    evidence.longFileLineLength = longFileLine.length;
    expect(longFileLine.includes("x".repeat(6000))).toBe(true);

    // (c) 实时追加：执行命令后三行出现，不用重开标签。
    await clickSlot(EMIT_ITEM);
    const afterRun1 = await waitForRows(
      (rows) =>
        ["INFO", "WARN", "ERROR"].every((level) =>
          hasRow(
            rows,
            byMessage(`E2E_LOGS_COMMAND_${level} run=1`, (row) => row.pluginId === LOGS_PLUGIN),
          ),
        ),
      "command logs should arrive live",
    );
    expect(
      afterRun1.every((row, index) => index === 0 || row.seq > afterRun1[index - 1]!.seq),
    ).toBe(true);

    // (d) 按插件过滤。
    await selectFilter(TID_EXTENSION_LOGS_SOURCE_FILTER, LOGS_PLUGIN);
    const pluginRows = await waitForRows(
      (rows) => rows.length > 0 && rows.every((row) => row.pluginId === LOGS_PLUGIN),
      "plugin filter should keep only e2e-ext-logs rows",
    );
    evidence.pluginFilterRows = pluginRows.length;
    await selectFilter(TID_EXTENSION_LOGS_SOURCE_FILTER, PEER_PLUGIN);
    await waitForRows(
      (rows) =>
        rows.length > 0 &&
        rows.every((row) => row.pluginId === PEER_PLUGIN) &&
        hasRow(rows, byMessage("E2E_LOGS_PEER_INFO")),
      "plugin filter should keep only peer rows",
    );
    await selectFilter(TID_EXTENSION_LOGS_SOURCE_FILTER, "扩展进程");
    await waitForRows(
      (rows) =>
        rows.length > 0 &&
        rows.every((row) => row.pluginId === null) &&
        hasRow(rows, byMessage("status=running")),
      "host filter should keep only extension host and supervisor rows",
    );
    await selectFilter(TID_EXTENSION_LOGS_SOURCE_FILTER, "全部来源");

    // (e) 按级别过滤。
    await selectFilter(TID_EXTENSION_LOGS_LEVEL_FILTER, "仅错误");
    await waitForRows(
      (rows) =>
        rows.length > 0 &&
        rows.every((row) => row.level === "error") &&
        hasRow(rows, byMessage("E2E_LOGS_COMMAND_ERROR run=1")),
      "error filter should keep only error rows",
    );
    await selectFilter(TID_EXTENSION_LOGS_LEVEL_FILTER, "警告及以上");
    await waitForRows(
      (rows) =>
        rows.every((row) => row.level === "warn" || row.level === "error") &&
        hasRow(rows, byMessage("E2E_LOGS_COMMAND_WARN run=1")),
      "warn filter should keep warnings and errors",
    );
    // 过滤叠加：插件 + 级别。
    await selectFilter(TID_EXTENSION_LOGS_SOURCE_FILTER, LOGS_PLUGIN);
    await selectFilter(TID_EXTENSION_LOGS_LEVEL_FILTER, "仅错误");
    const combined = await waitForRows(
      (rows) =>
        rows.length > 0 &&
        rows.every((row) => row.level === "error" && row.pluginId === LOGS_PLUGIN),
      "plugin and level filters should combine",
    );
    evidence.combinedFilterRows = combined.map((row) => row.message);
    await selectFilter(TID_EXTENSION_LOGS_SOURCE_FILTER, "全部来源");
    await selectFilter(TID_EXTENSION_LOGS_LEVEL_FILTER, "全部级别");
    await waitForRows(
      (rows) => hasRow(rows, byMessage("E2E_LOGS_ACTIVATE_INFO")),
      "all rows should return after resetting the filters",
    );

    // (f) 深浅主题 × 中英文截图（全部来源、全部级别）。
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      screenshots.push(await capturePluginManualReview(CASE_ID, `logs-${locale}-${theme}`));
    }
    evidence.filterLabelsEnUS = {
      source: await readFilterLabel(TID_EXTENSION_LOGS_SOURCE_FILTER),
      level: await readFilterLabel(TID_EXTENSION_LOGS_LEVEL_FILTER),
    };
    expect(evidence.filterLabelsEnUS).toEqual({ source: "All sources", level: "All levels" });
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (g) 清空只清视图；之后的新日志照常出现。
    const lastSeqBeforeClear = Math.max(...(await readRows()).map((row) => row.seq));
    await $(`[data-testid="${TID_EXTENSION_LOGS_CLEAR}"]`).click();
    await waitForRows((rows) => rows.length === 0, "clear should empty the view");
    await clickSlot(EMIT_ITEM);
    const afterClear = await waitForRows(
      (rows) => hasRow(rows, byMessage("E2E_LOGS_COMMAND_ERROR run=2")),
      "new logs should still arrive after clearing",
    );
    expect(afterClear.every((row) => row.seq > lastSeqBeforeClear)).toBe(true);
    expect(hasRow(afterClear, byMessage("E2E_LOGS_ACTIVATE_INFO"))).toBe(false);
    // 清空不影响 Main 的缓冲与日志文件。
    await log.waitFor(
      (line) => line.includes(`[${LOGS_PLUGIN}] E2E_LOGS_ACTIVATE_INFO`),
      "the log file should keep the cleared lines",
    );

    // (h) 复制当前过滤后的条目。先清空剪贴板：系统剪贴板跨运行保留，上一轮的内容会让断言误判通过。
    await browser.electron.execute((electron) => electron.clipboard.writeText(""));
    await $(`[data-testid="${TID_EXTENSION_LOGS_COPY}"]`).click();
    let copied = "";
    await browser.waitUntil(
      async () => {
        copied = (await browser.electron.execute((electron) =>
          electron.clipboard.readText(),
        )) as string;
        return copied.includes("E2E_LOGS_COMMAND_ERROR run=2");
      },
      { timeout: 10000, timeoutMsg: "copy should put the visible rows on the clipboard" },
    );
    evidence.copied = copied.split("\n");
    expect(copied).toContain(`ERROR [${LOGS_PLUGIN}] E2E_LOGS_COMMAND_ERROR run=2`);
    expect(copied).not.toContain("E2E_LOGS_ACTIVATE_INFO");

    // (i) 杀掉扩展进程：旧行还在，监管器的退出与重启行出现，新代际的日志到达。
    const pid = await readExtensionPid();
    evidence.gen1Pid = pid;
    process.kill(pid, "SIGKILL");
    const afterCrash = await waitForRows(
      (rows) =>
        hasRow(
          rows,
          byMessage("extension host exited", (row) => row.gen === 1 && row.pluginId === null),
        ) &&
        hasRow(
          rows,
          byMessage("status=restarting", (row) => row.gen === 1),
        ) &&
        hasRow(
          rows,
          byMessage("status=running", (row) => row.gen === 2),
        ) &&
        hasRow(
          rows,
          byMessage(
            "E2E_LOGS_ACTIVATE_INFO",
            (row) => row.gen === 2 && row.pluginId === LOGS_PLUGIN,
          ),
        ),
      "lifecycle lines and the new generation should appear after the crash",
      60000,
    );
    expect(afterCrash.find(byMessage("extension host exited"))?.message).toContain("intent=crash");
    // 崩溃前的行仍在（缓冲在 Main，扩展进程崩溃不影响）。
    expect(
      hasRow(
        afterCrash,
        byMessage("E2E_LOGS_COMMAND_ERROR run=2", (row) => row.gen === 1),
      ),
    ).toBe(true);
    evidence.afterCrash = afterCrash
      .filter((row) => row.pluginId === null || row.gen === 2)
      .map((row) => `${row.seq} gen=${row.gen} ${row.level} ${row.pluginId ?? "-"} ${row.message}`);
    screenshots.push(await capturePluginManualReview(CASE_ID, "after-crash-zh-CN-zai-light"));

    // (j) 命令中心「打开扩展日志」：关闭标签后重新打开，取新快照；清空的位置仍然保留。
    await closeLogsTab();
    await openLogsFromCommandCenter();
    const reopened = await waitForRows(
      (rows) =>
        hasRow(
          rows,
          byMessage("E2E_LOGS_ACTIVATE_INFO", (row) => row.gen === 2),
        ) && hasRow(rows, byMessage("E2E_LOGS_COMMAND_ERROR run=2")),
      "the command center should reopen the log tab with a fresh snapshot",
    );
    expect(reopened.every((row) => row.seq > lastSeqBeforeClear)).toBe(true);
    evidence.rendererLogs = (await log.lines()).filter((line) =>
      line.includes("[extension-slots] logs"),
    );
    evidence.screenshots = screenshots;
  });
});
