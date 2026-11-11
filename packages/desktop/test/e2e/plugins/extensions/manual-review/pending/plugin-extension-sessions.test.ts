// PLM-EXT-P3A：扩展的会话读权限（docs/plugins/extension-host.md §17.2、§17.3、§17.7、§17.8、§17.10 第 1 步）。
// 隔离 HOME：三个纯 JS fixture 扩展（test/e2e/fixtures/fs/plugins/plugin-extension-sessions/）经 plugins.dirs 加载：
// - e2e-ext-sessions：清单声明 grants ["sessions.read"]。激活时与每次换语言时调 ctx.sessions.listSessions
//   与 readSession(view: messages)，日志只有数量、角色、id 与是否含测试标记。
// - e2e-ext-sessions-nogrant：没有声明 grants，调用应报 not-declared。
// - e2e-ext-sessions-late：带代码的扩展，初始禁用；已有扩展持有会话权限时，启用它要先确认。
// 正式会话用 replay 创建：提示词带 upstream-e2e-ok，命中 provider-basic.json 的 upstream-provider-basic。
// 运行时证据：Main 日志（[extensions] / [extension-slots] / fixture 的 E2E_SESSIONS_*）、隔离 HOME 的
// ~/.zcode/v2/extensions/grants.json 与 audit/*.jsonl、启动页与详情页 DOM。
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXTENSION_SESSION_CONSENT_REVISION } from "@zcode/shared/extension-host";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_EXTENSION_ENABLE_CONFIRM_DIALOG,
  TID_EXTENSION_GRANT_DIALOG,
  TID_EXTENSION_PERMISSIONS,
  TID_EXTENSION_PERMISSIONS_ACTION,
  TID_EXTENSION_PERMISSIONS_REVOKE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SIDE_PANE_EXTENSION_GRANT,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { createExtensionLog, openLauncher } from "#e2e/helpers/extension-host-views";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  clickPluginControl,
  openInstalledPluginSettingsDetail,
  openPluginManagementSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P3A";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-sessions",
);
const PLUGIN = "e2e-ext-sessions";
const PLUGIN_ID = `${PLUGIN}@inline`;
const NOGRANT_ID = "e2e-ext-sessions-nogrant@inline";
const LATE = "e2e-ext-sessions-late";
const LATE_ID = `${LATE}@inline`;
const PLUGINS = [PLUGIN, "e2e-ext-sessions-nogrant", LATE];
// 标记让 fixture 判断 readSession 读到的是这条消息；审计文件里不能出现它。
const MARKER = "E2E_EXT_SESSIONS";
const PROMPT = `${MARKER}: Reply with exactly "upstream-e2e-ok" and no other text.`;

const evidence: Record<string, unknown> = {};
const screenshots: string[] = [];
const log = createExtensionLog();

function extensionsDataPath(...segments: string[]): string {
  return join(resolveE2EStorageRoot(), "v2", "extensions", ...segments);
}

/** 三个插件都进 plugins.dirs；e2e-ext-sessions-late 显式禁用，之后经设置页启用。 */
async function seedFixtures(): Promise<void> {
  const target = join(getE2EAppDataPaths().homeDir, "fixtures", "extension-sessions");
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
  await mkdir(join(getE2EAppDataPaths().homeDir, ".zcode", "cli"), { recursive: true });
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
            [PLUGIN_ID]: true,
            [NOGRANT_ID]: true,
            [LATE_ID]: false,
          },
        },
      },
      null,
      2,
    ),
  );
}

async function readGrantsFile(): Promise<Record<string, unknown> | null> {
  const text = await readFile(extensionsDataPath("grants.json"), "utf8").catch(() => null);
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

/** 隔离 HOME 里全部审计文件的原文与解析后的行。 */
async function readAudit(): Promise<{ text: string; lines: Array<Record<string, unknown>> }> {
  const dir = extensionsDataPath("audit");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".jsonl"),
  );
  let text = "";
  for (const name of names.sort()) text += await readFile(join(dir, name), "utf8");
  return {
    text,
    lines: text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** 等 from 行之后出现满足条件的日志行（换语言会触发探测；旧的探测行不能算）。 */
async function waitForLogAfter(
  from: number,
  predicate: (line: string) => boolean,
  message: string,
  timeout = 30000,
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

/**
 * 打开右侧面板的启动页并确认它真的可见：窄窗口或换主题后面板可能收起但保留 DOM，
 * 按「可见」判断，不按「存在」（与 PLM-EXT-2A 相同）。
 */
async function openVisibleLauncher(): Promise<void> {
  await openLauncher();
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

function grantRowSelector(pluginId: string): string {
  return `[data-testid="${TID_SIDE_PANE_EXTENSION_GRANT}"][data-side-pane-open-tab-item="extension-grant:${pluginId}"]`;
}

/** 启动页「需要授权」行（`extension-grant:<pluginId>`）的文本；没有这一行时为 null。 */
async function readGrantRow(pluginId: string): Promise<string | null> {
  return browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    return row ? (row.textContent ?? "") : null;
  }, grantRowSelector(pluginId));
}

/** 这一行可见（面板展开）后滚到中间，供截图与点击。 */
async function waitForVisibleGrantRow(pluginId: string, message: string): Promise<void> {
  await openVisibleLauncher();
  await browser.waitUntil(async () => $(grantRowSelector(pluginId)).isDisplayed(), {
    timeout: 30000,
    interval: 300,
    timeoutMsg: message,
  });
  await browser.execute((selector) => {
    document.querySelector(selector)?.scrollIntoView({ block: "center" });
  }, grantRowSelector(pluginId));
}

async function clickGrantRow(pluginId: string): Promise<void> {
  const clicked = await browser.execute(
    (rowTestId, id) => {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="${rowTestId}"][data-side-pane-open-tab-item="extension-grant:${id}"]`,
      );
      row?.scrollIntoView({ block: "center" });
      row?.click();
      return Boolean(row);
    },
    TID_SIDE_PANE_EXTENSION_GRANT,
    pluginId,
  );
  if (!clicked) throw new Error(`the launcher has no grant row for ${pluginId}`);
}

/** ConfirmDialog 的内容层（按 testId）：标题与正文。 */
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

async function confirmDialog(dialogTestId: string): Promise<void> {
  await browser.execute(
    (id, confirmTestId) => {
      document
        .querySelector<HTMLElement>(`[data-testid="${id}"] [data-testid="${confirmTestId}"]`)
        ?.click();
    },
    dialogTestId,
    TID_CONFIRM_DIALOG_CONFIRM,
  );
  await browser.waitUntil(async () => (await readDialog(dialogTestId)) === null, {
    timeout: 15000,
    timeoutMsg: `${dialogTestId} should close after confirming`,
  });
}

/** 按 Esc 关闭 ConfirmDialog（等同取消）。 */
async function dismissDialog(dialogTestId: string): Promise<void> {
  await browser.keys("Escape");
  await browser.waitUntil(async () => (await readDialog(dialogTestId)) === null, {
    timeout: 15000,
    timeoutMsg: `${dialogTestId} should close on Escape`,
  });
}

/** 设置页插件列表里该插件启用开关的状态（Radix Switch 的 aria-checked）。 */
async function readSwitchChecked(pluginId: string): Promise<boolean | null> {
  return browser.execute((id) => {
    const element = document.querySelector<HTMLElement>(
      `[data-testid="plugin-settings-enabled-switch"][data-plugin-id="${id}"]`,
    );
    return element ? element.getAttribute("aria-checked") === "true" : null;
  }, pluginId);
}

interface PermissionsUi {
  status: string | null;
  text: string;
  actions: Array<{ capability: string; grant: string }>;
}

async function readPermissions(pluginId: string): Promise<PermissionsUi | null> {
  return browser.execute(
    (sectionTestId, actionTestId, id) => {
      const section = document.querySelector<HTMLElement>(
        `[data-testid="${sectionTestId}"][data-plugin-id="${id}"]`,
      );
      if (!section) return null;
      return {
        status: section.dataset.grantStatus ?? null,
        text: section.innerText ?? "",
        actions: Array.from(
          section.querySelectorAll<HTMLElement>(`[data-testid="${actionTestId}"]`),
        ).map((row) => ({
          capability: row.dataset.capability ?? "",
          grant: row.dataset.grant ?? "",
        })),
      };
    },
    TID_EXTENSION_PERMISSIONS,
    TID_EXTENSION_PERMISSIONS_ACTION,
    pluginId,
  );
}

async function waitForPermissions(
  pluginId: string,
  predicate: (ui: PermissionsUi) => boolean,
  message: string,
): Promise<PermissionsUi> {
  let latest: PermissionsUi | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readPermissions(pluginId);
        return Boolean(latest && predicate(latest));
      },
      { timeout: 30000, interval: 300 },
    );
  } catch {
    // 失败时带上最后一次读数（timeoutMsg 在等待开始前就求值了，拿不到最后的读数）。
    throw new Error(`${message}: ${JSON.stringify(latest)}`);
  }
  return latest!;
}

describe("PLM-EXT-P3A 扩展的会话读权限、授权与审计", () => {
  after(async () => {
    evidence.screenshots = screenshots;
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-p3a-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("未授权报 not-granted，授权后能读会话，撤销后又报 not-granted；审计不含内容；启用确认", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedFixtures();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (a) 未授权：扩展照常激活，会话能力报 not-granted；清单没有声明档位的扩展报 not-declared。
    evidence.notGranted = await log.waitFor(
      (line) =>
        line.includes(`E2E_SESSIONS_LIST plugin=${PLUGIN_ID} reason=activate`) &&
        line.includes("error="),
      "the sessions extension should probe on activation",
      60000,
    );
    expect(String(evidence.notGranted)).toContain("error=not-granted");
    evidence.notDeclared = await log.waitFor(
      (line) => line.includes(`E2E_SESSIONS_NOGRANT plugin=${NOGRANT_ID}`),
      "the extension without grants should probe on activation",
      60000,
    );
    expect(String(evidence.notDeclared)).toContain("error=not-declared");
    expect(await readGrantsFile()).toBeNull();

    // (b) 启动页「扩展」分区显示「需要授权」；没有声明档位的插件不显示。
    await waitForVisibleGrantRow(PLUGIN_ID, "the launcher should show the needs-consent row");
    evidence.grantRow = await readGrantRow(PLUGIN_ID);
    expect(String(evidence.grantRow)).toContain("需要授权");
    expect(String(evidence.grantRow)).toContain("读取会话");
    expect(await readGrantRow(NOGRANT_ID)).toBeNull();
    for (const [locale, theme] of [
      ["zh-CN", "zai-light"],
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
      ["en-US", "zai-dark"],
    ] as const) {
      await setPluginPresentation({ locale, theme, width: 1400, height: 900 });
      await waitForVisibleGrantRow(
        PLUGIN_ID,
        "the needs-consent row should stay after switching presentation",
      );
      await capture(`launcher-needs-consent-${locale}-${theme}`);
    }
    evidence.grantRowEnglish = await readGrantRow(PLUGIN_ID);
    expect(String(evidence.grantRowEnglish)).toContain("Needs permission");

    // (c) 授权对话框（spec 原文）→ 授权：grants.json 有记录，启动页的行消失。
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await waitForVisibleGrantRow(
      PLUGIN_ID,
      "the needs-consent row should be visible before granting",
    );
    await clickGrantRow(PLUGIN_ID);
    evidence.grantDialog = await waitForDialog(
      TID_EXTENSION_GRANT_DIALOG,
      "the grant row should open the consent dialog",
    );
    expect(String(evidence.grantDialog)).toContain(`允许「${PLUGIN}」读取会话？`);
    expect(String(evidence.grantDialog)).toContain(
      "扩展代码与其他扩展在同一个进程运行，彼此没有隔离。",
    );
    expect(String(evidence.grantDialog)).toContain("插件发起的操作会标出来源，并写入审计日志。");
    await capture("grant-dialog-zh-CN-zai-light");
    // 取消（Esc）不授权：没有记录，这一行还在。对话框文案在打开时按当时的语言生成，所以换语言后重新打开截图。
    await dismissDialog(TID_EXTENSION_GRANT_DIALOG);
    expect(await readGrantsFile()).toBeNull();
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await waitForVisibleGrantRow(PLUGIN_ID, "the needs-consent row should stay after cancelling");
    await clickGrantRow(PLUGIN_ID);
    evidence.grantDialogEnglish = await waitForDialog(
      TID_EXTENSION_GRANT_DIALOG,
      "the grant row should open the consent dialog again",
    );
    expect(String(evidence.grantDialogEnglish)).toContain(`Allow “${PLUGIN}” to read sessions?`);
    await capture("grant-dialog-en-US-zai-dark");
    await confirmDialog(TID_EXTENSION_GRANT_DIALOG);
    await browser.waitUntil(
      async () => {
        const plugins = ((await readGrantsFile())?.plugins ?? {}) as Record<string, unknown>;
        return Boolean(plugins[PLUGIN_ID]);
      },
      { timeout: 15000, timeoutMsg: "grants.json should record the grant" },
    );
    const grantsFile = await readGrantsFile();
    evidence.grantsFile = grantsFile;
    expect(grantsFile).toMatchObject({
      version: 1,
      plugins: {
        [PLUGIN_ID]: {
          grants: ["sessions.read"],
          consentedVersion: "1.0.0",
          consentRevision: EXTENSION_SESSION_CONSENT_REVISION,
        },
      },
    });
    await browser.waitUntil(async () => (await readGrantRow(PLUGIN_ID)) === null, {
      timeout: 15000,
      timeoutMsg: "the needs-consent row should disappear after granting",
    });
    evidence.grantLog = await log.waitFor(
      (line) => line.includes(`extension grants granted plugin=${PLUGIN_ID} tiers=sessions.read`),
      "the Window Host should log the grant",
    );

    // (d) 发一条 replay 消息建正式会话；换语言触发探测：listSessions 有这个会话，readSession 读到它的消息。
    // 先回到中文，后面换成英文时 env.onDidChange 才会触发。
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await sendV4Prompt(PROMPT);
    const session = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "the draft should become a session after the first send",
      60000,
    );
    const sessionId = session.sessionId ?? "";
    evidence.sessionId = sessionId;
    // 录制的回复是 deepseek-e2e-ok（provider-basic.json 的 upstream-provider-basic）。
    await waitForV4AssistantMessageContaining("deepseek-e2e-ok");
    const beforeEnglish = (await log.lines()).length;
    await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 1400, height: 900 });
    evidence.grantedList = await waitForLogAfter(
      beforeEnglish,
      (line) =>
        line.includes(`E2E_SESSIONS_LIST plugin=${PLUGIN_ID} reason=locale-en-US`) &&
        line.includes(" ok "),
      "listSessions should succeed after granting",
    );
    expect(String(evidence.grantedList)).toContain(sessionId);
    evidence.grantedRead = await waitForLogAfter(
      beforeEnglish,
      (line) =>
        line.includes(`E2E_SESSIONS_READ plugin=${PLUGIN_ID} reason=locale-en-US id=${sessionId}`),
      "readSession should return the session messages",
    );
    expect(String(evidence.grantedRead)).toContain("view=messages");
    expect(String(evidence.grantedRead)).toContain("roles=assistant,user");
    expect(String(evidence.grantedRead)).toContain("marker=true");

    // (e) 已有扩展持有会话权限：在设置页启用另一个带代码的扩展，要先确认；确认后它激活。
    await openPluginManagementSettings();
    await waitForPluginControl("plugin-settings-enabled-switch", { pluginId: LATE_ID }, 30000);
    await clickPluginControl("plugin-settings-enabled-switch", { pluginId: LATE_ID });
    evidence.enableDialog = await waitForDialog(
      TID_EXTENSION_ENABLE_CONFIRM_DIALOG,
      "enabling a code extension while grants are held should ask for confirmation",
    );
    // 标题用设置页的插件显示名（E2e Ext Sessions Late），持有者用静态表里的插件名。
    expect(String(evidence.enableDialog)).toMatch(/^Enable “.+”\?/u);
    expect(String(evidence.enableDialog)).toContain("its code can use these permissions too");
    expect(String(evidence.enableDialog)).toContain(`“${PLUGIN}” (Read sessions)`);
    await capture("enable-confirm-en-US-zai-light");
    // 取消（Esc）不启用：开关仍是关，扩展没有激活。再换语言重新打开确认。
    await dismissDialog(TID_EXTENSION_ENABLE_CONFIRM_DIALOG);
    expect(await readSwitchChecked(LATE_ID)).toBe(false);
    expect((await log.lines()).some((line) => line.includes("E2E_SESSIONS_LATE_ACTIVATED"))).toBe(
      false,
    );
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1400, height: 900 });
    await clickPluginControl("plugin-settings-enabled-switch", { pluginId: LATE_ID });
    evidence.enableDialogChinese = await waitForDialog(
      TID_EXTENSION_ENABLE_CONFIRM_DIALOG,
      "enabling again should ask for confirmation again",
    );
    expect(String(evidence.enableDialogChinese)).toContain(`「${PLUGIN}」（读取会话）`);
    await capture("enable-confirm-zh-CN-zai-dark");
    await confirmDialog(TID_EXTENSION_ENABLE_CONFIRM_DIALOG);
    evidence.lateActivated = await log.waitFor(
      (line) => line.includes(`E2E_SESSIONS_LATE_ACTIVATED plugin=${LATE_ID}`),
      "the late extension should activate after confirming",
      60000,
    );

    // (f) 插件详情页「权限」区块：已授予、最近操作有授权一行；撤销后回到需要授权。
    await openInstalledPluginSettingsDetail(PLUGIN_ID);
    const granted = await waitForPermissions(
      PLUGIN_ID,
      (ui) => ui.status === "granted" && ui.actions.some((a) => a.capability === "grants.grant"),
      "the permissions section should show the grant",
    );
    evidence.permissionsGranted = granted;
    await capture("permissions-granted-zh-CN-zai-dark");
    await setPluginPresentation({ locale: "en-US", theme: "zai-light", width: 1400, height: 900 });
    await capture("permissions-granted-en-US-zai-light");
    await clickPluginControl(TID_EXTENSION_PERMISSIONS_REVOKE, { pluginId: PLUGIN_ID });
    const revoked = await waitForPermissions(
      PLUGIN_ID,
      (ui) =>
        ui.status === "needs-consent" && ui.actions.some((a) => a.capability === "grants.revoke"),
      "the permissions section should show the revoke",
    );
    evidence.permissionsRevoked = revoked;
    expect(revoked.actions.slice(0, 2)).toEqual([
      { capability: "grants.revoke", grant: "sessions.read" },
      { capability: "grants.grant", grant: "sessions.read" },
    ]);
    await capture("permissions-revoked-en-US-zai-light");
    const grantsAfterRevoke = await readGrantsFile();
    evidence.grantsAfterRevoke = grantsAfterRevoke;
    expect(
      Object.keys((grantsAfterRevoke?.plugins ?? {}) as Record<string, unknown>),
    ).not.toContain(PLUGIN_ID);

    // (g) 撤销后：换语言再探测，又报 not-granted。
    const beforeChinese = (await log.lines()).length;
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    evidence.revokedList = await waitForLogAfter(
      beforeChinese,
      (line) => line.includes(`E2E_SESSIONS_LIST plugin=${PLUGIN_ID} reason=locale-zh-CN`),
      "the probe should run after revoking",
    );
    expect(String(evidence.revokedList)).toContain("error=not-granted");

    // (h) 启动页又显示「需要授权」。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "settings back button should be visible",
    });
    await waitForVisibleGrantRow(
      PLUGIN_ID,
      "the launcher should show the needs-consent row again after revoking",
    );
    await capture("launcher-needs-consent-again-zh-CN-zai-light");

    // (i) 审计文件：授权与撤销各一行，字段只有标识与结果，不含提示词、标记与正文。
    const audit = await readAudit();
    evidence.auditLines = audit.lines;
    const own = audit.lines.filter((line) => line.pluginId === PLUGIN_ID);
    expect(own.map((line) => line.capability)).toEqual(["grants.grant", "grants.revoke"]);
    for (const line of own) {
      expect(line).toMatchObject({ v: 1, grant: "sessions.read", outcome: "ok" });
      expect(typeof line.ts).toBe("number");
    }
    expect(audit.text).not.toContain(MARKER);
    expect(audit.text).not.toContain("upstream-e2e-ok");
    expect(audit.text).not.toContain("deepseek-e2e-ok");
    expect(audit.text).not.toContain(getE2EAppDataPaths().homeDir);
  });
});
