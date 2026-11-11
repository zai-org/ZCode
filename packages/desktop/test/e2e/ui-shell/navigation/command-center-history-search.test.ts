import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { isIsolatedE2EHomeDir } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedProviderReadinessHistoryFixture } from "#e2e/helpers/provider-readiness-history-fixture";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";

const marker = "E2E_HISTORY_TITLE";
const bodyMarker = "E2E_HISTORY_BODY";
const inputSelector = '[role="dialog"] [cmdk-input]';
const rowSelector = '[role="dialog"] [cmdk-item][data-value^="task-result:"]';
const cases = ["active", "pinned", "archived", "unclassified", "deleted", "cli-deleted", "foreign"];
const visibleCases = cases.slice(0, 4);
let closedWorkspace: string;
let home: string;

describe("Command Center Host 历史搜索", () => {
  afterEach(async () => {
    const snapshot = await browser.execute(() => ({
      text: document.body.innerText.slice(0, 12000),
      rows: Array.from(document.querySelectorAll('[role="dialog"] [cmdk-item]')).map((row) => ({
        text: row.textContent,
        value: row.getAttribute("data-value"),
      })),
    }));
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "history-search-state.json"),
      JSON.stringify(snapshot, null, 2),
    );
  });
  before(async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    home = process.env.ZCODE_E2E_HOME_DIR ?? "";
    // 旧 basename 守卫误拒 runner 默认的 .e2e-home；复用统一守卫，仍禁止写普通 HOME。
    if (!isIsolatedE2EHomeDir(home)) throw new Error("需要隔离 E2E HOME");
    closedWorkspace = join(home, "ClosedHistoryWorkspace");
    await mkdir(closedWorkspace, { recursive: true });
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        for (const name of cases) {
          await seedProviderReadinessHistoryFixture({
            cliEntryPoint: resolve("../../apps/zcode-cli/packages/cli/dist/zcode.cjs"),
            e2eHomeDir: home,
            workspacePath: closedWorkspace,
            history: {
              sessionId: `session_e2e_history_${name}`,
              title: `${marker}_${name}`,
              userText: `${bodyMarker}_${name}`,
              assistantText: `Persisted history ${name}`,
              modelId: "missing-model",
              runtimeProviderId: "missing-provider",
              taskProviderId: "glm",
              assistantInputTokens: 0,
              assistantOutputTokens: 0,
            },
          });
        }
        // node:sqlite 只提供同步接口；夹具在 Host 退出后写入，避免与迁移/索引写入竞争。
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        try {
          const stamp = Date.now() - 36 * 24 * 60 * 60 * 1000;
          db.prepare(`UPDATE tasks SET host_id='local', root_path=workspace_path,
            project_id=NULL, cli_title=title, cli_title_source='custom', cli_created_at=?,
            cli_updated_at=?, created_at=?, updated_at=?, cli_deleted=0, handoff_pending=8
            WHERE task_id LIKE 'session_e2e_history_%'`).run(stamp, stamp, stamp, stamp);
          db.exec(`UPDATE tasks SET pinned=1 WHERE task_id='session_e2e_history_pinned';
            UPDATE tasks SET archived=1 WHERE task_id='session_e2e_history_archived';
            UPDATE tasks SET deleted=1 WHERE task_id='session_e2e_history_deleted';
            UPDATE tasks SET cli_deleted=1 WHERE task_id='session_e2e_history_cli-deleted';
            UPDATE tasks SET host_id='server:other-device' WHERE task_id='session_e2e_history_foreign'`);
          db.prepare(`INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at)
            VALUES('e2e-history-project','local','E2E_HISTORY_PROJECT',100,?,?)`).run(stamp, stamp);
          db.prepare(
            `INSERT INTO project_roots(project_id,root_path,position) VALUES('e2e-history-project',?,0)`,
          ).run(closedWorkspace);
          db.exec(`UPDATE tasks SET project_id='e2e-history-project' WHERE task_id IN
            ('session_e2e_history_active','session_e2e_history_pinned','session_e2e_history_archived')`);
        } finally {
          db.close();
        }
        const settingsPath = join(home, ".zcode/v2/setting.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        await writeFile(
          settingsPath,
          JSON.stringify({ ...settings, taskAutoArchiveEnabled: false }),
        );
      },
    });
  });

  it("CC-HISTORY-01：未打开目录的一个月前标题/正文、置顶、归档及 Host 隔离", async () => {
    const tabs = await browser.execute(() => {
      const store = (
        window as typeof window & {
          __zcodeTabStoreE2E?: { getState(): { tabs: Array<{ workspacePath?: string }> } };
        }
      ).__zcodeTabStoreE2E;
      if (!store) throw new Error("缺少 tab store 测试入口");
      return store.getState().tabs.map((tab) => tab.workspacePath);
    });
    expect(tabs).not.toContain(closedWorkspace);
    await openSearch();
    await searchAndExpect(marker, visibleCases);
    for (const name of visibleCases) await searchAndExpect(`${bodyMarker}_${name}`, [name]);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "history-cold-search.png"),
    );
    await browser.keys("Escape");
  });

  it("CC-HISTORY-02：点击未打开目录的归档结果并再次搜索", async () => {
    await openSearch();
    await searchAndExpect(`${marker}_archived`, ["archived"]);
    await $(rowSelector).click();
    await browser.waitUntil(
      () =>
        browser.execute((text) => document.body.innerText.includes(text), `${bodyMarker}_archived`),
      { timeout: 45_000, timeoutMsg: "应打开归档任务的真实持久化正文" },
    );
    await openSearch();
    await searchAndExpect(marker, visibleCases);
    await browser.keys("Escape");
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT archived FROM tasks WHERE task_id='session_e2e_history_archived'").get(),
      ).toEqual({ archived: 1 });
    } finally {
      db.close();
    }
  });

  it("CC-HISTORY-03：手机真实 shared-host 搜索旧任务标题和正文", async function () {
    this.timeout(120_000);
    let receivePair!: (url: string) => void;
    const pairing = new Promise<string>((resolvePair) => {
      receivePair = resolvePair;
    });
    // 配对链接只经过内存，不让 WDIO 命令日志保存配对密码。
    const receiver = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method !== "OPTIONS") {
        let value = "";
        for await (const chunk of request) value += String(chunk);
        receivePair(value);
      }
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("pair receiver failed");
    const mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    try {
      await browser.execute((port) => {
        const target = window as typeof window & { __historyRestoreClipboard?: () => void };
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        target.__historyRestoreClipboard = () => {
          navigator.clipboard.writeText = original;
        };
        navigator.clipboard.writeText = async (text) => {
          await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: text });
        };
      }, address.port);
      await $(
        'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
      ).click();
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[data-testid="web-remote-control-dialog-scroll"] button',
              ),
            ).find(
              (node) => /^(复制链接|Copy link)$/.test(node.innerText.trim()) && !node.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 45_000 },
      );
      const context = await mobile.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await context.addInitScript((credentials) => {
        for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
      }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
      const page = await context.newPage();
      await openMobilePairingPage(page, await pairing, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
        caseMarker: "CC-HISTORY-03",
        phase: "history-search",
        readySelector: '[data-testid="sidebar-search-open"]',
      });
      await page.getByTestId("sidebar-search-open").tap();
      await page.getByRole("tab", { name: /^(任务|Tasks)$/ }).click();
      for (const query of [marker, bodyMarker]) {
        await page.locator(inputSelector).fill(query);
        await page.waitForFunction(
          ({ rowSelector, marker, visibleCases }) => {
            const rows = Array.from(document.querySelectorAll(rowSelector)).map(
              (row) => row.textContent ?? "",
            );
            return (
              rows.length === visibleCases.length &&
              visibleCases.every((name) => rows.some((text) => text.includes(`${marker}_${name}`)))
            );
          },
          { rowSelector, marker, visibleCases },
        );
      }
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "history-mobile-search.png"),
      });
    } finally {
      await mobile.close();
      receiver.close();
      await browser.execute(() => {
        const target = window as typeof window & { __historyRestoreClipboard?: () => void };
        target.__historyRestoreClipboard?.();
        delete target.__historyRestoreClipboard;
      });
      await browser.keys("Escape");
    }
  });
});

async function openSearch() {
  await $('[data-testid="sidebar-search-open"]').click();
  await $(inputSelector).waitForDisplayed();
  await $('[role="dialog"]')
    .$('.//button[@role="tab" and (normalize-space(.)="任务" or normalize-space(.)="Tasks")]')
    .click();
}

async function searchAndExpect(query: string, names: string[]) {
  await $(inputSelector).setValue(query);
  await browser.waitUntil(
    async () => {
      const texts = await $$(rowSelector).map((row) => row.getText());
      return (
        texts.length === names.length &&
        names.every((name) => texts.some((text) => text.includes(`${marker}_${name}`)))
      );
    },
    { timeout: 10_000, timeoutMsg: `历史搜索 ${query} 应返回 ${names.join(",")}` },
  );
}
