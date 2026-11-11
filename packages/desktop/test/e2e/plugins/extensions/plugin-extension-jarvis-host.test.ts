// PLM-EXT-JARVISHOST：Jarvis 要的宿主能力（docs/plugins/extension-host.md §18.1、§18.4 Jarvis 第 1 步）。
// 隔离 HOME：纯 JS fixture 扩展 e2e-ext-jarvis-host（test/e2e/fixtures/fs/plugins/plugin-extension-jarvis-host/）
// 经 plugins.dirs 加载。发送消息走 replay（common.json 与 plugin-extension-jarvis-host.json 的 plugin-extension-jarvis-host-1）。
//   a H5 视图的 App 作用域：从 nav.primary 打开 scope "app" 的视图；切到同一工作区的另一个会话、再切回后实例 id 不变；
//     全局「新建任务」进另一个工作区、再切回原会话的工作区，实例 id 仍不变，页面上只有一个这个视图的标签。
//     新建任务会进新的虚拟工作区（另一个侧栏，标签不在那里），所以第二个会话经 Host 的 createSession（导入历史，
//     不调模型）建在同一工作区，再从任务列表切换。
//   b H6 ctx.extension.dataPath：等于 CLI 的插件数据目录（<E2E HOME>/.zcode/cli/plugins/data/<插件 id>），激活前已建好。
//   c H9 models.list：列出 E2E provider 的模型，标签就是模型 id。
//   d H11 导航未读标记：激活时为 3；经视图工具改成 120（显示 99+）、"dot"、清除。
//   e H12 grants.request：视图工具请宿主弹授权对话框；取消后返回空档位，确认后返回 sessions.read，再请求不弹。
//   f H8 notifications.show：Main 的 Notification.show 换成记录、窗口焦点换成受控读数（测试机上不弹真实通知）。
//     依次：窗口有焦点 → focused；设置里「任务通知」关 → disabled；详情页开关关 → muted；都放开 → 弹出，
//     标题带插件名前缀；紧接着第二条 → rate-limited；触发记录的通知的 click → 打开该插件的视图。
// 运行时证据：Main 日志（[extension-host] / [extensions] 前缀与 fixture 写的 E2E_JARVISHOST_*）、视图标签页与页面 DOM。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_EXTENSION_GRANT_DIALOG,
  TID_EXTENSION_PERMISSIONS,
  TID_EXTENSION_PERMISSIONS_ACTION,
  TID_EXTENSION_PERMISSIONS_NOTIFICATIONS,
  TID_NAV_PRIMARY_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_NEW_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
} from "#e2e/helpers/upstream-provider";
import {
  createExtensionLog,
  evaluateInViewPage,
  openLauncher,
  readActiveSidePaneTab,
  reloadExtensionsFromCommandCenter,
  waitForViewPage,
  waitForViewPane,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  openInstalledPluginSettingsDetail,
  openPluginManagementSettings,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-JARVISHOST";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-jarvis-host",
);
const PLUGIN = "e2e-ext-jarvis-host";
const PLUGIN_ID = `${PLUGIN}@inline`;
const HOME_VIEW = `${PLUGIN_ID}/home`;
const NAV_ITEM = `${PLUGIN_ID}/home`;
const PROMPT = `E2E_EXT_JARVIS_HOST: Reply with exactly "upstream-e2e-ok" and no other text.`;

/** 当前工作区路径（Renderer 的标签 store）。 */
async function readActiveWorkspacePath(): Promise<string | null> {
  return browser.execute(
    () =>
      (
        window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
        }
      ).__zcodeTabStoreE2E?.getState().activeWorkspacePath ?? null,
  );
}

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

function fixtureHome(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-jarvis-host");
}

/** fixture 激活时写下的扩展进程 pid（插件目录旁的状态文件）。 */
async function readFixturePid(): Promise<number | null> {
  return readFile(join(fixtureHome(), "e2e-ext-jarvis-host-state.json"), "utf8").then(
    (text) => Number((JSON.parse(text) as { pid?: number }).pid) || null,
    () => null,
  );
}

/** 最近一行 E2E_JARVISHOST_DATA 的 previous 与 count。 */
function parseDataLine(line: string): { previous: number; count: number } {
  return {
    previous: Number(/previous=(\d+)/.exec(line)?.[1]),
    count: Number(/count=(\d+)/.exec(line)?.[1]),
  };
}

async function seedFixture(): Promise<void> {
  const target = fixtureHome();
  await mkdir(target, { recursive: true });
  await cp(join(FIXTURE_ROOT, PLUGIN), join(target, PLUGIN), { recursive: true, force: true });
  await writePluginDirsConfig([join(target, PLUGIN)], [PLUGIN_ID]);
}

async function clickNavItem(itemId: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemTestId, id) => {
          const element = document.querySelector<HTMLElement>(
            `[data-testid="${itemTestId}"][data-extension-item="${id}"]`,
          );
          if (!element) return false;
          element.click();
          return true;
        },
        TID_NAV_PRIMARY_ITEM,
        itemId,
      ),
    { timeout: 30000, interval: 300, timeoutMsg: `nav item ${itemId} should be clickable` },
  );
}

interface NavBadgeReading {
  badge: string;
  label: string;
  text: string;
  hasDot: boolean;
}

async function readNavBadge(itemId: string): Promise<NavBadgeReading | null> {
  return browser.execute(
    (itemTestId, id) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${itemTestId}"][data-extension-item="${id}"]`,
      );
      if (!element) return null;
      return {
        badge: element.dataset.extensionBadge ?? "",
        label: element.getAttribute("aria-label") ?? "",
        text: element.textContent ?? "",
        hasDot: Boolean(element.querySelector(".bg-icon-blue")),
      };
    },
    TID_NAV_PRIMARY_ITEM,
    itemId,
  );
}

async function waitForNavBadge(
  itemId: string,
  predicate: (reading: NavBadgeReading) => boolean,
  message: string,
): Promise<NavBadgeReading> {
  let reading: NavBadgeReading | null = null;
  await browser.waitUntil(
    async () => {
      reading = await readNavBadge(itemId);
      return Boolean(reading && predicate(reading));
    },
    { timeout: 30000, interval: 300, timeoutMsg: `${message}: ${JSON.stringify(reading)}` },
  );
  return reading!;
}

/**
 * 在视图页面里调视图工具（页面经 window.zcode 调，与插件页面相同的路径）。
 * wait 为 false 时不等结果：grants.request 要等对话框关闭才返回。
 */
async function callViewTool(
  sandboxId: string,
  name: string,
  args: unknown,
  wait = true,
): Promise<void> {
  const call = `window.zcode.callTool(${JSON.stringify(name)}, ${JSON.stringify(args)})`;
  await evaluateInViewPage(sandboxId, wait ? `${call}.then(() => true)` : `(void ${call}, true)`);
}

/** ConfirmDialog 的内容层（按 testId）。 */
async function readDialog(dialogTestId: string): Promise<string | null> {
  return browser.execute((id) => {
    const dialog = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return dialog ? (dialog.innerText ?? "") : null;
  }, dialogTestId);
}

async function waitForDialog(dialogTestId: string, message: string): Promise<string> {
  let text: string | null = null;
  await browser.waitUntil(
    async () => {
      text = await readDialog(dialogTestId);
      return Boolean(text);
    },
    { timeout: 15000, interval: 200, timeoutMsg: message },
  );
  return text!;
}

async function closeDialog(dialogTestId: string, confirm: boolean): Promise<void> {
  if (confirm) {
    await browser.execute(
      (id, confirmTestId) => {
        document
          .querySelector<HTMLElement>(`[data-testid="${id}"] [data-testid="${confirmTestId}"]`)
          ?.click();
      },
      dialogTestId,
      TID_CONFIRM_DIALOG_CONFIRM,
    );
  } else {
    await browser.keys("Escape");
  }
  await browser.waitUntil(async () => (await readDialog(dialogTestId)) === null, {
    timeout: 15000,
    timeoutMsg: `${dialogTestId} should close`,
  });
}

// —— H8：Main 里的通知记录与焦点读数 ——

interface RecordedNotification {
  title: string;
  body: string;
  silent: boolean;
}

/** 把 Main 的 Notification.show 换成记录，窗口焦点读数改成受控（focused 为 null 时用真实值）。 */
async function installMainNotificationProbe(): Promise<void> {
  await browser.electron.execute((electron) => {
    const scope = globalThis as typeof globalThis & {
      __e2eExtNotifications?: Array<InstanceType<typeof electron.Notification>>;
      __e2eFocusOverride?: boolean | null;
      __e2eRestoreNotificationProbe?: () => void;
    };
    if (scope.__e2eRestoreNotificationProbe) return;
    scope.__e2eExtNotifications = [];
    scope.__e2eFocusOverride = null;
    const notificationProto = electron.Notification.prototype;
    const windowProto = electron.BrowserWindow.prototype;
    const originalShow = notificationProto.show;
    const originalFocused = windowProto.isFocused;
    notificationProto.show = function () {
      scope.__e2eExtNotifications!.push(this);
    };
    windowProto.isFocused = function () {
      return scope.__e2eFocusOverride ?? originalFocused.call(this);
    };
    scope.__e2eRestoreNotificationProbe = () => {
      notificationProto.show = originalShow;
      windowProto.isFocused = originalFocused;
      delete scope.__e2eRestoreNotificationProbe;
    };
  });
}

async function setMainFocus(focused: boolean | null): Promise<void> {
  await browser.electron.execute((_electron, value) => {
    (globalThis as typeof globalThis & { __e2eFocusOverride?: boolean | null }).__e2eFocusOverride =
      value;
  }, focused);
}

async function readRecordedNotifications(): Promise<RecordedNotification[]> {
  return browser.electron.execute(() =>
    (
      (
        globalThis as typeof globalThis & {
          __e2eExtNotifications?: Array<{ title: string; body: string; silent: boolean }>;
        }
      ).__e2eExtNotifications ?? []
    ).map((item) => ({ title: item.title, body: item.body, silent: item.silent })),
  );
}

async function clickRecordedNotification(index: number): Promise<void> {
  await browser.electron.execute((_electron, at) => {
    (
      globalThis as typeof globalThis & {
        __e2eExtNotifications?: Array<{ emit(event: string): void }>;
      }
    ).__e2eExtNotifications?.[at]?.emit("click");
  }, index);
}

async function restoreMainNotificationProbe(): Promise<void> {
  await browser.electron
    .execute(() => {
      (
        globalThis as typeof globalThis & { __e2eRestoreNotificationProbe?: () => void }
      ).__e2eRestoreNotificationProbe?.();
    })
    .catch(() => undefined);
}

/** 打开设置页的一个分区。 */
async function openSettingsSection(section: string): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "the settings button should be visible",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section), {
    timeout: 15000,
    timeoutMsg: `settings should expose the ${section} section`,
  });
}

async function closeSettings(): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "the settings back button should be visible",
  });
}

/** 设置页「任务通知」一行的开关（全局的系统通知开关）：设成 checked。 */
async function setTaskNotificationSwitch(checked: boolean): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((wanted) => {
        const label = Array.from(document.querySelectorAll<HTMLElement>("body *")).find(
          (element) =>
            element.childElementCount === 0 &&
            /^(任务通知|Task notifications)$/.test(element.textContent?.trim() ?? ""),
        );
        let row: HTMLElement | null = label ?? null;
        let control: HTMLElement | null = null;
        while (row && !control) {
          control = row.querySelector<HTMLElement>('[role="switch"]');
          row = row.parentElement;
        }
        if (!control) return false;
        if ((control.getAttribute("aria-checked") === "true") !== wanted) control.click();
        return (control.getAttribute("aria-checked") === "true") === wanted;
      }, checked),
    {
      timeout: 15000,
      interval: 300,
      timeoutMsg: `the task notification switch should be ${checked}`,
    },
  );
}

async function readNotificationsSwitch(pluginId: string): Promise<boolean | null> {
  return browser.execute(
    (switchTestId, id) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${switchTestId}"][data-plugin-id="${id}"]`,
      );
      return element ? element.getAttribute("aria-checked") === "true" : null;
    },
    TID_EXTENSION_PERMISSIONS_NOTIFICATIONS,
    pluginId,
  );
}

async function readPermissionActions(pluginId: string): Promise<string[]> {
  return browser.execute(
    (sectionTestId, actionTestId, id) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid="${sectionTestId}"][data-plugin-id="${id}"] [data-testid="${actionTestId}"]`,
        ),
      ).map((row) => row.dataset.capability ?? ""),
    TID_EXTENSION_PERMISSIONS,
    TID_EXTENSION_PERMISSIONS_ACTION,
    pluginId,
  );
}

describe("PLM-EXT-JARVISHOST Jarvis 要的宿主能力", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-jarvishost-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await restoreMainNotificationProbe();
    await clearAppData();
  });

  it("App 作用域视图、数据目录与模型列表", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedFixture();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setCurrentElectronRendererContentSize(1400, 900);
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await log.waitFor(
      (line) => line.includes(`[${PLUGIN_ID}] activated in`),
      "the fixture extension should activate",
      60000,
    );

    // (b) H6：数据目录来自 CLI 的 plugins/list，激活前已存在。
    const dataLine = await log.waitFor(
      (line) => line.includes("E2E_JARVISHOST_DATAPATH "),
      "the fixture should report its data path",
    );
    const reported = JSON.parse(
      dataLine.slice(dataLine.indexOf("{", dataLine.indexOf("E2E_JARVISHOST_DATAPATH"))),
    ) as {
      dataPath: string;
      isDirectory: boolean;
    };
    evidence.dataPath = reported;
    expect(reported.dataPath).toBe(
      join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "plugins", "data", PLUGIN_ID),
    );
    expect(reported.isDirectory).toBe(true);

    // (c) H9：已配置的模型，与输入框模型选择器同一份视图。
    const modelsLine = await log.waitFor(
      (line) => line.includes("E2E_JARVISHOST_MODELS "),
      "the fixture should report models.list",
      60000,
    );
    expect(modelsLine).toContain("E2E_JARVISHOST_MODELS ok ");
    const okMarker = "E2E_JARVISHOST_MODELS ok ";
    const models = JSON.parse(
      modelsLine.slice(modelsLine.indexOf(okMarker) + okMarker.length),
    ) as Array<{
      id: string;
      providerId: string;
      modelId: string;
      label: string;
      providerName: string;
    }>;
    evidence.models = models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((model) => model.id)).toContain(`${UPSTREAM_PROVIDER_ID}/${UPSTREAM_MODEL}`);
    // 已配置的第二个模型也在列表里（以前只由示例插件用例 PLM-JARVIS-2 断言）。
    expect(models.map((model) => model.id)).toContain(
      `${UPSTREAM_PROVIDER_ID}/${UPSTREAM_SECONDARY_MODEL}`,
    );
    for (const model of models) {
      expect(model.id).toBe(`${model.providerId}/${model.modelId}`);
      expect(model.label).toBe(model.modelId);
      expect(model.providerName.length).toBeGreaterThan(0);
    }

    // (a) H5：先发一条消息建正式会话，再从导航打开 App 作用域的视图。
    await sendV4Prompt(PROMPT);
    const session = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "the draft should become a session after the first send",
      60000,
    );
    const sessionId = session.sessionId ?? "";
    evidence.sessionId = sessionId;
    await waitForV4AssistantMessageContaining("deepseek-e2e-ok");
    await clickNavItem(NAV_ITEM);
    const pane = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running" && item.displayed,
      "the app-scoped view should be running",
    );
    evidence.appPane = pane;
    expect(pane.scope).toBe("app");
    const page = await waitForViewPage(
      HOME_VIEW,
      (item) => item.dataset.ready === "1",
      "the app-scoped view page should render",
    );
    evidence.appPage = page.dataset;
    expect(page.dataset.scope).toBe("app");
    expect(page.dataset.instance).toBe(pane.instance);
    const opened = await log.waitFor(
      (line) => line.includes(`E2E_JARVISHOST_VIEW_OPEN instance=${pane.instance}`),
      "onDidOpen should run for the app-scoped view",
    );
    expect(opened).toContain("scope=app session=none");
    await capturePluginManualReview(CASE_ID, "app-view-zh-CN-zai-light");

    // 同一工作区的第二个会话：导入历史建会话，不调模型；从任务列表切过去，焦点会话变了，实例不重建。
    await installHandoffRpcProbe();
    const workspace = await browser.execute(() => {
      const tabs = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState(): {
              activeWorkspacePath: string | null;
              activeWorkspaceIdentity: string | null;
            };
          };
        }
      ).__zcodeTabStoreE2E!.getState();
      return { path: tabs.activeWorkspacePath!, identity: tabs.activeWorkspaceIdentity };
    });
    const created = await callHandoffHost<{ session: { sessionId: string } }>(
      ServiceChannels.ZCodeAgent,
      "createSession",
      [
        {
          workspacePath: workspace.path,
          ...(workspace.identity ? { workspaceIdentity: workspace.identity } : {}),
          persistence: "immediate",
          importedHistory: {
            source: "claudeCode",
            title: "E2E_JARVISHOST_SECOND_SESSION",
            messages: [
              { role: "user", content: "E2E_JARVISHOST_SECOND_SESSION" },
              { role: "assistant", content: "second session for the app-scoped view check" },
            ],
          },
        },
      ],
    );
    const secondSessionId = created.session.sessionId;
    evidence.secondSessionId = secondSessionId;
    await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
      { taskId: secondSessionId, workspacePath: workspace.path },
    ]);
    await selectV4TaskById(secondSessionId, 30000);
    await browser.pause(1500);
    const afterSecond = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running",
      "the app-scoped view should stay after switching to another session",
    );
    evidence.afterSecond = afterSecond;
    expect(afterSecond.instance).toBe(pane.instance);
    // 切回原会话：实例仍不变。
    await selectV4TaskById(sessionId);
    await waitForV4Pane((snapshot) => snapshot.sessionId === sessionId, "back to the session");
    await browser.pause(1500);
    const afterSwitch = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running",
      "the app-scoped view should stay after switching sessions",
    );
    evidence.afterSwitch = afterSwitch;
    expect(afterSwitch.instance).toBe(pane.instance);
    // 切换工作区（§18.1 H5「跨工作区保留」）：全局「新建任务」进一个新的虚拟工作区，标签跟着移过去，实例不重建；
    // 再从任务列表切回原会话（回到原工作区），实例仍不变。
    await clickTestIdByDom(TID_TASK_NEW_BUTTON, {
      timeout: 15000,
      timeoutMsg: "the global new task button should be visible",
    });
    let otherWorkspace = "";
    await browser.waitUntil(
      async () => {
        otherWorkspace = (await readActiveWorkspacePath()) ?? "";
        return Boolean(otherWorkspace) && otherWorkspace !== workspace.path;
      },
      { timeout: 30000, timeoutMsg: "the global new task should enter another workspace" },
    );
    evidence.otherWorkspace = otherWorkspace;
    await browser.pause(1500);
    const afterWorkspace = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running",
      "the app-scoped view should move to the other workspace",
    );
    evidence.afterWorkspace = afterWorkspace;
    expect(afterWorkspace.instance).toBe(pane.instance);
    await selectV4TaskById(sessionId);
    await browser.waitUntil(async () => (await readActiveWorkspacePath()) === workspace.path, {
      timeout: 30000,
      timeoutMsg: "selecting the first session should return to its workspace",
    });
    await waitForV4Pane((snapshot) => snapshot.sessionId === sessionId, "back to the session");
    await browser.pause(1500);
    const afterWorkspaceBack = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running" && item.displayed,
      "the app-scoped view should come back with the first workspace",
    );
    evidence.afterWorkspaceBack = afterWorkspaceBack;
    expect(afterWorkspaceBack.instance).toBe(pane.instance);
    // 标签只在当前工作区的侧栏里：页面上只有一个这个视图的标签。
    const paneCount = await browser.execute(
      (viewId) => document.querySelectorAll(`[data-extension-view-id="${viewId}"]`).length,
      HOME_VIEW,
    );
    evidence.paneCountAfterWorkspaceBack = paneCount;
    expect(paneCount).toBe(1);
    const opens = (await log.lines()).filter((line) => line.includes("E2E_JARVISHOST_VIEW_OPEN"));
    evidence.viewOpens = opens;
    expect(opens).toHaveLength(1);
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await capturePluginManualReview(CASE_ID, "app-view-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (d) H11：导航条目的未读标记。激活时扩展设为 3。
    const initialBadge = await waitForNavBadge(
      NAV_ITEM,
      (reading) => reading.badge === "3",
      "the nav item should show the badge set on activation",
    );
    evidence.initialBadge = initialBadge;
    expect(initialBadge.text).toContain("3");
    expect(initialBadge.label).toContain("3 条未读");
    const sandbox = afterSwitch.sandbox ?? "";
    await callViewTool(sandbox, "setBadge", { badge: 120 });
    const cappedBadge = await waitForNavBadge(
      NAV_ITEM,
      (reading) => reading.badge === "120",
      "the nav badge should update to 120",
    );
    expect(cappedBadge.text).toContain("99+");
    await callViewTool(sandbox, "setBadge", { badge: "dot" });
    const dotBadge = await waitForNavBadge(
      NAV_ITEM,
      (reading) => reading.badge === "dot",
      "the nav badge should become a dot",
    );
    evidence.dotBadge = dotBadge;
    expect(dotBadge.hasDot).toBe(true);
    expect(dotBadge.label).toContain("有新内容");
    await capturePluginManualReview(CASE_ID, "nav-badge-dot-zh-CN-zai-light");
    await callViewTool(sandbox, "setBadge", { badge: 5 });
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    const englishBadge = await waitForNavBadge(
      NAV_ITEM,
      (reading) => reading.badge === "5" && reading.label.includes("5 unread"),
      "the nav badge should be localized",
    );
    evidence.englishBadge = englishBadge;
    await capturePluginManualReview(CASE_ID, "nav-badge-count-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await callViewTool(sandbox, "setBadge", { badge: null });
    const cleared = await waitForNavBadge(
      NAV_ITEM,
      (reading) => reading.badge === "",
      "the nav badge should clear",
    );
    expect(cleared.hasDot).toBe(false);
    expect(cleared.label).not.toContain("·");

    // (e) H12：视图请宿主弹授权对话框。取消不是错误，返回空档位。
    const grantLines = async () =>
      (await log.lines()).filter((line) => line.includes("E2E_JARVISHOST_GRANTS "));
    await callViewTool(sandbox, "requestGrants", {}, false);
    const dialogText = await waitForDialog(
      TID_EXTENSION_GRANT_DIALOG,
      "grants.request should open the consent dialog",
    );
    evidence.grantDialog = dialogText;
    expect(dialogText).toContain(`允许「${PLUGIN}」读取会话？`);
    await capturePluginManualReview(CASE_ID, "grants-request-dialog-zh-CN-zai-light");
    await closeDialog(TID_EXTENSION_GRANT_DIALOG, false);
    await browser.waitUntil(async () => (await grantLines()).length === 1, {
      timeout: 15000,
      timeoutMsg: "grants.request should return after cancelling",
    });
    expect((await grantLines())[0]).toContain("E2E_JARVISHOST_GRANTS ok granted=");
    expect((await grantLines())[0]).not.toContain("sessions.read");
    // 确认：返回 sessions.read。
    await callViewTool(sandbox, "requestGrants", {}, false);
    await waitForDialog(TID_EXTENSION_GRANT_DIALOG, "grants.request should ask again");
    await closeDialog(TID_EXTENSION_GRANT_DIALOG, true);
    await browser.waitUntil(async () => (await grantLines()).length === 2, {
      timeout: 15000,
      timeoutMsg: "grants.request should return after granting",
    });
    expect((await grantLines())[1]).toContain("E2E_JARVISHOST_GRANTS ok granted=sessions.read");
    // 已授予：不弹对话框，直接返回。
    await callViewTool(sandbox, "requestGrants", {});
    await browser.waitUntil(async () => (await grantLines()).length === 3, {
      timeout: 15000,
      timeoutMsg: "grants.request should return at once when already granted",
    });
    expect((await grantLines())[2]).toContain("E2E_JARVISHOST_GRANTS ok granted=sessions.read");
    expect(await readDialog(TID_EXTENSION_GRANT_DIALOG)).toBeNull();
    evidence.grantResults = await grantLines();
    evidence.grantRelayLog = (await log.lines()).filter((line) => line.includes("grants.request"));
    expect(dialogText).toContain("系统通知");
    expect((await grantLines())[1]).toContain("granted=sessions.read,notifications");

    // (f) H8：系统通知。每次经视图工具 notify 调 notifications.show，读日志里的结果。
    await installMainNotificationProbe();
    const notifyResults = async () =>
      (await log.lines()).filter((line) => line.includes("E2E_JARVISHOST_NOTIFY "));
    const notify = async (args: Record<string, unknown>) => {
      const before = (await notifyResults()).length;
      const current = await waitForViewPane(
        HOME_VIEW,
        (item) => item.phase === "running" && Boolean(item.sandbox),
        "the view should be running before notify",
      );
      await waitForViewPage(HOME_VIEW, (item) => item.dataset.ready === "1", "view page ready");
      await callViewTool(current.sandbox ?? "", "notify", args);
      await browser.waitUntil(async () => (await notifyResults()).length > before, {
        timeout: 15000,
        timeoutMsg: "notifications.show should return",
      });
      return (await notifyResults()).at(-1)!;
    };
    // 窗口有焦点：不弹。
    await setMainFocus(true);
    expect(await notify({})).toContain(
      'E2E_JARVISHOST_NOTIFY ok {"shown":false,"reason":"focused"}',
    );
    await setMainFocus(false);
    // 设置里「任务通知」关：不弹。
    await openSettingsSection("general");
    await setTaskNotificationSwitch(false);
    await closeSettings();
    expect(await notify({})).toContain(
      'E2E_JARVISHOST_NOTIFY ok {"shown":false,"reason":"disabled"}',
    );
    await openSettingsSection("general");
    await setTaskNotificationSwitch(true);
    await closeSettings();
    // 详情页开关（默认开）关掉：不弹，最近操作有一行。
    await openPluginManagementSettings();
    await openInstalledPluginSettingsDetail(PLUGIN_ID);
    await browser.waitUntil(async () => (await readNotificationsSwitch(PLUGIN_ID)) === true, {
      timeout: 15000,
      timeoutMsg: "the notifications switch should default to on",
    });
    await capturePluginManualReview(CASE_ID, "notifications-switch-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await capturePluginManualReview(CASE_ID, "notifications-switch-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await browser.execute(
      (switchTestId, id) =>
        document
          .querySelector<HTMLElement>(`[data-testid="${switchTestId}"][data-plugin-id="${id}"]`)
          ?.click(),
      TID_EXTENSION_PERMISSIONS_NOTIFICATIONS,
      PLUGIN_ID,
    );
    await browser.waitUntil(async () => (await readNotificationsSwitch(PLUGIN_ID)) === false, {
      timeout: 15000,
      timeoutMsg: "the notifications switch should turn off",
    });
    await browser.waitUntil(
      async () => (await readPermissionActions(PLUGIN_ID)).includes("grants.notifications.off"),
      { timeout: 15000, timeoutMsg: "recent actions should show the switch change" },
    );
    await closeSettings();
    expect(await notify({})).toContain('E2E_JARVISHOST_NOTIFY ok {"shown":false,"reason":"muted"}');
    await openPluginManagementSettings();
    await openInstalledPluginSettingsDetail(PLUGIN_ID);
    await browser.execute(
      (switchTestId, id) =>
        document
          .querySelector<HTMLElement>(`[data-testid="${switchTestId}"][data-plugin-id="${id}"]`)
          ?.click(),
      TID_EXTENSION_PERMISSIONS_NOTIFICATIONS,
      PLUGIN_ID,
    );
    await browser.waitUntil(async () => (await readNotificationsSwitch(PLUGIN_ID)) === true, {
      timeout: 15000,
      timeoutMsg: "the notifications switch should turn back on",
    });
    await closeSettings();
    // 都放开：弹出；标题由宿主加插件名前缀，静音。
    expect(await notify({ view: "home" })).toContain('E2E_JARVISHOST_NOTIFY ok {"shown":true}');
    const recorded = await readRecordedNotifications();
    evidence.recordedNotifications = recorded;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      title: `${PLUGIN}：E2E title`,
      body: "E2E body",
      silent: true,
    });
    // 紧接着第二条：限流，不弹。
    expect(await notify({})).toContain(
      'E2E_JARVISHOST_NOTIFY ok {"shown":false,"reason":"rate-limited"}',
    );
    expect(await readRecordedNotifications()).toHaveLength(1);
    // 点了通知：打开该插件声明的视图（先切到启动页，证明是点击打开的）。
    await openLauncher();
    const beforeClick = await readActiveSidePaneTab();
    evidence.activeTabBeforeClick = beforeClick;
    expect(beforeClick).not.toBe(`extension-view:${HOME_VIEW}`);
    await clickRecordedNotification(0);
    await browser.waitUntil(
      async () => (await readActiveSidePaneTab()) === `extension-view:${HOME_VIEW}`,
      { timeout: 15000, timeoutMsg: "clicking the notification should open the plugin view" },
    );
    evidence.notificationClickLog = await log.waitFor(
      (line) => line.includes("[extension-slots] notification click"),
      "the renderer should log the notification click",
    );
    expect(String(evidence.notificationClickLog)).toContain('"opened":true');
    evidence.notifyResults = await notifyResults();
    evidence.notificationLogs = (await log.lines()).filter(
      (line) => line.includes("notifications.show") || line.includes("show-extension-notification"),
    );
    // 日志不带标题与正文。
    expect(JSON.stringify(evidence.notificationLogs)).not.toContain("E2E title");
    expect(JSON.stringify(evidence.notificationLogs)).not.toContain("E2E body");
    await setMainFocus(null);
  });

  // 以下宿主行为以前只由示例插件用例 PLM-JARVIS-1、2 断言（Jarvis 是 App 作用域视图、存数据、申请完全访问）。
  it("换代后的 App 作用域视图、App 重启后的数据目录、经 grants.request 申请完全访问", async function () {
    this.timeout(600000);
    requirePluginManualReview();

    // (h) 杀掉扩展进程：App 作用域的视图按新代际重建（新实例 id），页面重新就绪。
    await clickNavItem(NAV_ITEM);
    const before = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running" && item.displayed,
      "the app-scoped view should be open before the kill",
    );
    const pid = await readFixturePid();
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, "SIGKILL");
    const rebuilt = await waitForViewPane(
      HOME_VIEW,
      (item) => Number(item.gen) > Number(before.gen) && item.phase === "running",
      "the app-scoped view should be rebuilt by the new generation",
      90000,
    );
    evidence.appViewAfterKill = { before, rebuilt };
    expect(rebuilt.scope).toBe("app");
    expect(rebuilt.instance).not.toBe(before.instance);
    await waitForViewPage(
      HOME_VIEW,
      (page) => page.dataset.ready === "1",
      "the rebuilt app-scoped view page should be ready",
    );
    await capturePluginManualReview(CASE_ID, "app-view-after-kill-zh-CN-zai-light");

    // (i) H6：重启 App 后，dataPath 里上一次写的数据还在（激活时读到的 previous 等于重启前的 count）。
    const beforeRestart = parseDataLine(
      (await log.lines()).filter((line) => line.includes("E2E_JARVISHOST_DATA ")).at(-1) ?? "",
    );
    evidence.dataBeforeRestart = beforeRestart;
    expect(beforeRestart.count).toBeGreaterThanOrEqual(2);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    const afterRestartLine = await log.waitFor(
      (line) => line.includes("E2E_JARVISHOST_DATA "),
      "the fixture should read its data after the App restarts",
      90000,
    );
    evidence.dataAfterRestart = afterRestartLine;
    expect(parseDataLine(afterRestartLine)).toEqual({
      previous: beforeRestart.count,
      count: beforeRestart.count + 1,
    });

    // (j) H12 + 完全访问：清单改成申请 sessions.fullAccess 并「重新加载扩展」后回到待授权；视图经
    // grants.request 请宿主弹授权对话框，正文单独写完全访问一行；确认后返回的档位含完全访问。
    const manifestPath = join(fixtureHome(), PLUGIN, ".zcode-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      extension: { grants: string[] };
    };
    manifest.extension.grants = ["sessions.fullAccess", "notifications"];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const beforeReload = (await log.lines()).length;
    await reloadExtensionsFromCommandCenter();
    await browser.waitUntil(
      async () =>
        (await log.lines())
          .slice(beforeReload)
          .some((line) => line.includes(`[${PLUGIN_ID}] activated in`)),
      { timeout: 90000, interval: 500, timeoutMsg: "the fixture should activate after reloading" },
    );
    await clickNavItem(NAV_ITEM);
    const view = await waitForViewPane(
      HOME_VIEW,
      (item) => item.phase === "running" && item.displayed && Boolean(item.sandbox),
      "the view should be running after reloading",
      60000,
    );
    await waitForViewPage(HOME_VIEW, (page) => page.dataset.ready === "1", "view page ready");
    const grantLines = async () =>
      (await log.lines())
        .slice(beforeReload)
        .filter((line) => line.includes("E2E_JARVISHOST_GRANTS "));
    await callViewTool(view.sandbox ?? "", "requestGrants", {}, false);
    const fullDialog = await waitForDialog(
      TID_EXTENSION_GRANT_DIALOG,
      "grants.request should ask for full access",
    );
    evidence.fullAccessGrantDialog = fullDialog;
    expect(fullDialog).toContain(`允许「${PLUGIN}」读取和操作会话？`);
    expect(fullDialog).toContain("完全访问：插件可以把它项目里的会话切到完全访问");
    expect(fullDialog).toContain("系统通知");
    await capturePluginManualReview(CASE_ID, "grants-request-full-access-zh-CN-zai-light");
    await closeDialog(TID_EXTENSION_GRANT_DIALOG, true);
    await browser.waitUntil(async () => (await grantLines()).length === 1, {
      timeout: 15000,
      timeoutMsg: "grants.request should return after granting full access",
    });
    evidence.fullAccessGrantResult = (await grantLines())[0];
    expect((await grantLines())[0]).toContain(
      "E2E_JARVISHOST_GRANTS ok granted=sessions.fullAccess,notifications",
    );
  });
});
