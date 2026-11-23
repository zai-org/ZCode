/* eslint-disable max-lines -- 演示走查按真实用户顺序串起数据同步的全部功能，拆散会丢失章节的连续性。 */
import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_PROMPT_SUGGESTION_PANEL,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_VIRTUAL_PROJECT_MENU,
  testId,
  virtualProjectActionTestId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  startElectronWindowRecording,
  type ElectronWindowRecordingSession,
} from "#e2e/helpers/electron-window-recorder";
import { createAndConfigurePersonalProvider } from "#e2e/helpers/personal-provider-settings";
import {
  addMarketplaceSourceThroughAgent,
  createPluginLifecycleFixture,
  installMarketplacePluginThroughAgent,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_NAME,
} from "#e2e/helpers/plugin-management-lifecycle";
import { hoverProjectRow, projectSectionSelector } from "#e2e/helpers/project-sidebar";
import {
  bringRemoteDeviceOnline,
  chmodRemoteContainerPath,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  remoteContainerPathExists,
  takeRemoteDeviceOffline,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

/**
 * DSYNC-DEMO：数据同步功能演示走查（docs/remote/data-sync.md）。不是断言型用例：在本机 Docker 远端上
 * 按用户顺序走完数据同步的全部功能，每章录一段窗口视频（页面内叠加字幕、点击前高亮目标），最后拼成
 * 一个 mp4。断言只保留「流程确实到达了该状态」；某一章失败只记一条失败并继续后面的章节，最终仍判失败。
 * 长时间等待（连接、安装、离线判定）不进视频。
 */
const MARKER = "E2E_DSYNC_DEMO_WALKTHROUGH";
const artifact = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/data-sync-demo",
  "data-sync-demo",
);
const run = promisify(execFile);
const FFMPEG = process.env.ZCODE_E2E_FFMPEG_PATH?.trim() || "ffmpeg";
const FFPROBE = process.env.ZCODE_E2E_FFPROBE_PATH?.trim() || "ffprobe";
const WINDOW = { width: 1440, height: 900 };
const NARROW_WIDTH = 720;
const FRAME_INTERVAL_MS = 200;
const BEAT_MS = 2_200;
const LONG_BEAT_MS = 3_200;
const CLICK_LEAD_MS = 700;
const REMOTE_HOME = "/home/dev";
const REMOTE_CLI_CONFIG = `${REMOTE_HOME}/.zcode/cli/config.json`;
const SCOPE_TRIGGER = '[data-plugin-scope-trigger="true"]';
const DIALOG = '[data-testid="remote-sync-dialog"]';
const DIALOG_CLOSE = `${DIALOG} [data-slot="dialog-close"]`;

const SKILL = {
  push: "demo-code-review",
  agentsDir: "demo-agents-dir",
  update: "demo-api-design",
  older: "demo-legacy-tips",
  differs: "demo-release-notes",
  synced: "demo-style-guide",
  blocked: "demo-linked-assets",
  remoteOnly: "remote-only-notes",
  conflict: "demo-conflict",
} as const;
const AGENT = { push: "demo-reviewer", synced: "demo-planner" } as const;
const MCP = { push: "demo-search", filesystem: "filesystem", differs: "demo-docs" } as const;
const PLUGIN = {
  update: "demo-toolkit",
  older: "demo-formatter",
  marketplace: PLUGIN_LIFECYCLE_ID.toLowerCase(),
} as const;
const COMMAND = { nested: "/demo/commit", agentsDir: "/demo-review", synced: "/demo-standup" };
const HOOK = {
  push: "echo demo: lint after bash",
  unchecked: "echo demo: guard writes",
  synced: "echo demo: check before edit",
  remoteOnly: "echo remote-only: format after edit",
};
const DEPENDENCY_HINT_BOTH = `远端缺少 MCP：${MCP.push}；远端缺少技能：${SKILL.push}`;
const DEPENDENCY_HINT_MCP = `远端缺少 MCP：${MCP.push}`;
const PROVIDER = {
  providerName: "Demo Provider",
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-demo-0123456789abcd",
};
const SECOND_PROVIDER = {
  providerName: "Demo Provider Backup",
  baseURL: "https://backup.example.com/v1",
  apiKey: "sk-demo-backup-9876543210wxyz",
};

interface ClipEntry {
  chapter: string;
  title: string;
  file: string;
  durationSec?: number;
  error?: string;
}

const clips: ClipEntry[] = [];
const failures: string[] = [];
let activeRecording: { session: ElectronWindowRecordingSession; entry: ClipEntry } | null = null;

const tid = (id: string) => `[data-testid="${id}"]`;
const rowSelector = (key: string) => tid(`remote-sync-row-${key}`);
const ANY_ROW = '[data-testid^="remote-sync-row-"]:not([data-testid^="remote-sync-row-hint-"])';

// ---------- 录制 ----------

/** 按窗口逻辑尺寸采帧：Retina 屏 capturePage 返回 2 倍图，缩回逻辑尺寸以减小帧体积与编码耗时。 */
async function captureLogicalFrame(): Promise<Buffer> {
  const pngBase64 = await browser.electron.execute(async (electron) => {
    const windows = electron.BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .sort((left, right) => Number(right.isFocused()) - Number(left.isFocused()));
    const target = windows.find((win) => win.isVisible()) ?? windows[0];
    if (!target) throw new Error("No Electron BrowserWindow is available for recording");
    const image = await target.webContents.capturePage();
    if (image.isEmpty())
      throw new Error("Electron BrowserWindow capturePage returned an empty image");
    const { width, height } = target.getContentBounds();
    const sized =
      image.getSize().width > width ? image.resize({ width, height, quality: "good" }) : image;
    return sized.toPNG().toString("base64");
  });
  return Buffer.from(String(pngBase64), "base64");
}

async function startPart(chapter: string, title: string): Promise<void> {
  const file = `clip-${String(clips.length + 1).padStart(2, "0")}-${chapter}.webm`;
  const entry: ClipEntry = { chapter, title, file };
  const session = await startElectronWindowRecording({
    browser,
    captureFrame: captureLogicalFrame,
    frameIntervalMs: FRAME_INTERVAL_MS,
    outputPath: resolve(artifact, file),
    encodeTimeoutMs: 5 * 60_000,
    stopTimeoutMs: 5 * 60_000,
  });
  clips.push(entry);
  activeRecording = { session, entry };
}

async function stopPart(): Promise<void> {
  const current = activeRecording;
  activeRecording = null;
  if (!current) return;
  try {
    await current.session.stop({ tailDurationMs: 400 });
  } catch (error) {
    current.entry.error = String(error instanceof Error ? error.message : error);
  }
}

/** 长时间等待不进视频：停止当前片段，等待结束后在同一章节继续录制。 */
async function offCamera<T>(fn: () => Promise<T>): Promise<T> {
  const current = activeRecording;
  if (!current) return await fn();
  await stopPart();
  try {
    return await fn();
  } finally {
    await startPart(current.entry.chapter, current.entry.title);
  }
}

// ---------- 页面内叠加层：字幕、章节卡、点击高亮 ----------

async function caption(text: string | null): Promise<void> {
  await browser.execute((value) => {
    const id = "zcode-demo-caption";
    let node = document.getElementById(id);
    if (!value) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("div");
      node.id = id;
      Object.assign(node.style, {
        position: "fixed",
        left: "50%",
        bottom: "26px",
        transform: "translateX(-50%)",
        maxWidth: "min(1120px, 88vw)",
        padding: "10px 22px",
        borderRadius: "12px",
        background: "rgba(17, 17, 20, 0.9)",
        color: "#ffffff",
        font: "500 17px/1.55 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35)",
        textAlign: "center",
        whiteSpace: "pre-line",
        zIndex: "2147483647",
        pointerEvents: "none",
      });
      document.body.appendChild(node);
    }
    node.textContent = value;
  }, text);
}

async function titleCard(title: string, bullets: readonly string[], ms = 4_200): Promise<void> {
  await browser.execute(
    (heading, items) => {
      document.getElementById("zcode-demo-title")?.remove();
      const node = document.createElement("div");
      node.id = "zcode-demo-title";
      Object.assign(node.style, {
        position: "fixed",
        inset: "0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "22px",
        background: "rgba(12, 12, 16, 0.95)",
        color: "#ffffff",
        font: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif",
        zIndex: "2147483647",
        pointerEvents: "none",
      });
      const headingNode = document.createElement("div");
      headingNode.textContent = heading;
      Object.assign(headingNode.style, { font: "600 36px/1.3 inherit", letterSpacing: "0.5px" });
      node.appendChild(headingNode);
      if (items.length > 0) {
        const list = document.createElement("div");
        Object.assign(list.style, {
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          maxWidth: "min(980px, 86vw)",
          font: "400 19px/1.6 inherit",
          color: "#d4d4d8",
        });
        for (const item of items) {
          const line = document.createElement("div");
          line.textContent = `·  ${item}`;
          list.appendChild(line);
        }
        node.appendChild(list);
      }
      document.body.appendChild(node);
    },
    title,
    [...bullets],
  );
  await browser.pause(ms);
  await browser.execute(() => document.getElementById("zcode-demo-title")?.remove());
}

type LocateAction = "ring" | "ring-enabled" | "click";

/**
 * 在页面里找目标并高亮或点击：只取可见元素，给出 match 时取文本包含它的最小元素；
 * query 为 "*" 时按文本定位，再上溯到行级祖先（列表行没有 test id 时使用）。
 * 叠加层自身（字幕里也可能出现 match）和包含叠加层的 body/html 不参与匹配。
 */
async function locate(selector: string, match: string | undefined, action: LocateAction) {
  return await browser.execute(
    (query, text, mode) => {
      const overlays = ["zcode-demo-caption", "zcode-demo-title", "zcode-demo-spotlight"]
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => Boolean(node));
      const area = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(query)).filter(
        (element) =>
          element.getClientRects().length > 0 &&
          !overlays.some(
            (node) => node === element || node.contains(element) || element.contains(node),
          ) &&
          (!text || (element.textContent ?? "").includes(text)) &&
          (mode === "ring" ||
            (!(element as HTMLButtonElement).disabled &&
              element.getAttribute("aria-disabled") !== "true")),
      );
      let target = text
        ? candidates.reduce<HTMLElement | undefined>(
            (best, element) => (!best || area(element) < area(best) ? element : best),
            undefined,
          )
        : candidates[0];
      if (!target) return false;
      if (query === "*") {
        const row = target.closest<HTMLElement>(
          'li, [role="row"], [role="listitem"], [role="option"], button, a, label, [data-testid]',
        );
        if (row && area(row) < (window.innerWidth * window.innerHeight) / 6) target = row;
      }
      document.getElementById("zcode-demo-spotlight")?.remove();
      if (mode === "click") {
        target.click();
        return true;
      }
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = target.getBoundingClientRect();
      const ring = document.createElement("div");
      ring.id = "zcode-demo-spotlight";
      Object.assign(ring.style, {
        position: "fixed",
        left: `${rect.left - 5}px`,
        top: `${rect.top - 5}px`,
        width: `${rect.width + 10}px`,
        height: `${rect.height + 10}px`,
        border: "3px solid #f59e0b",
        borderRadius: "10px",
        boxShadow: "0 0 0 5px rgba(245, 158, 11, 0.28)",
        zIndex: "2147483646",
        pointerEvents: "none",
      });
      document.body.appendChild(ring);
      return true;
    },
    selector,
    match ?? null,
    action,
  );
}

async function spotlight(selector: string, match?: string): Promise<boolean> {
  return await locate(selector, match, "ring");
}

async function clearSpotlight(): Promise<void> {
  await browser.execute(() => document.getElementById("zcode-demo-spotlight")?.remove());
}

async function beat(ms = BEAT_MS): Promise<void> {
  if (activeRecording) await browser.pause(ms);
}

async function say(text: string, ms = BEAT_MS): Promise<void> {
  await caption(text);
  await beat(ms);
}

/** 带字幕地指向一个元素（只在录制时停留）；元素不存在视为该段失败。 */
async function point(
  selector: string,
  text?: string,
  options: { match?: string; ms?: number } = {},
): Promise<void> {
  if (text) await caption(text);
  await browser.waitUntil(async () => await spotlight(selector, options.match), {
    timeout: 30_000,
    timeoutMsg: `${MARKER}: 找不到要指向的元素 ${selector}${options.match ? `（${options.match}）` : ""}`,
  });
  await beat(options.ms ?? BEAT_MS);
  await clearSpotlight();
}

/** 点击可见、可用的目标；录制时先高亮停留，再点击。 */
async function demoClick(
  selector: string,
  options: { match?: string; leadMs?: number } = {},
): Promise<void> {
  const label = `${selector}${options.match ? `（${options.match}）` : ""}`;
  await browser.waitUntil(
    async () =>
      activeRecording
        ? await locate(selector, options.match, "ring-enabled")
        : await locate(selector, options.match, "click"),
    { timeout: 30_000, timeoutMsg: `${MARKER}: 没有可点击的 ${label}` },
  );
  if (!activeRecording) return;
  await browser.pause(options.leadMs ?? CLICK_LEAD_MS);
  const clicked = await locate(selector, options.match, "click");
  await clearSpotlight();
  if (!clicked) throw new Error(`${MARKER}: 点击前 ${label} 消失了`);
  await browser.pause(300);
}

// ---------- 页面导航 ----------

async function setLocaleAndTheme(locale: "zh-CN" | "en-US", theme: "light" | "dark") {
  await browser.execute(
    (language, color) => {
      const actions = (
        window as Window & {
          __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
        }
      ).__testActions;
      if (!actions) throw new Error("Missing locale/theme test actions");
      actions.setLocale(language);
      actions.setTheme(color);
    },
    locale,
    theme,
  );
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120))),
  );
}

async function setWindowWidth(width: number) {
  await browser.electron.execute(
    (electron, size) => {
      const window = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      window?.setMinimumSize(360, 600);
      window?.setSize(size.width, size.height);
    },
    { width, height: WINDOW.height },
  );
  await browser.pause(500);
}

async function parkPointer() {
  await browser.performActions([
    {
      type: "pointer",
      id: "park",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", x: 2, y: 2, duration: 0 }],
    },
  ]);
  await browser.releaseActions();
}

async function isPresent(selector: string): Promise<boolean> {
  return await browser.execute((query) => Boolean(document.querySelector(query)), selector);
}

async function openSettingsSection(section: string): Promise<void> {
  if (!(await isPresent(tid(TID_SETTINGS_PAGE)))) {
    await demoClick(tid(TID_TASK_SETTINGS_BUTTON));
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  }
  await demoClick(tid(testId(TID_SETTINGS_SECTION_NAV, section)));
}

async function leaveSettings(): Promise<void> {
  if (!(await isPresent(tid(TID_SETTINGS_PAGE)))) return;
  await demoClick(tid(TID_SETTINGS_BACK_BUTTON));
  await browser.waitUntil(async () => !(await isPresent(tid(TID_SETTINGS_PAGE))), {
    timeout: 30_000,
    timeoutMsg: `${MARKER}: 设置页没有关闭`,
  });
}

async function openDataSyncPage(): Promise<void> {
  await openSettingsSection("dataSync");
  await waitForTestIdByDom("remote-sync-section", { timeout: 30_000 });
}

async function readDeviceRow() {
  return await browser.execute(() => {
    const row = document.querySelector<HTMLElement>(
      '[data-testid="remote-sync-device-list"] [data-source-server-id]',
    );
    return {
      state: row?.dataset.deviceState ?? null,
      status:
        row?.querySelector('[data-testid="remote-sync-device-status"]')?.textContent?.trim() ?? "",
      action:
        row?.querySelector('[data-testid="remote-sync-device-action"]')?.textContent?.trim() ?? "",
    };
  });
}

async function waitForDevice(
  predicate: (row: Awaited<ReturnType<typeof readDeviceRow>>) => boolean,
  timeoutMsg: string,
  timeout = 60_000,
) {
  let last: Awaited<ReturnType<typeof readDeviceRow>> | undefined;
  await browser
    .waitUntil(
      async () => {
        last = await readDeviceRow();
        return predicate(last);
      },
      { timeout, interval: 500 },
    )
    .catch((error: unknown) => {
      throw new Error(`${MARKER}: ${timeoutMsg}（${JSON.stringify(last)}）`, { cause: error });
    });
}

async function waitForOverviewLoaded(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const table = document.querySelector('[data-testid="remote-sync-overview-table"]');
        return Boolean(table && !(table.textContent ?? "").includes("加载中"));
      }),
    { timeout: 90_000, interval: 300, timeoutMsg: `${MARKER}: 概览没有加载完成` },
  );
}

async function openDataSyncDialog(): Promise<void> {
  await openDataSyncPage();
  await waitForDevice((row) => row.action === "同步配置" || row.action === "重试", "设备不能同步");
  await demoClick(tid("remote-sync-device-action"));
  await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
}

/** 关闭数据同步弹窗：概览页用底部「关闭」，分类页用右上角关闭按钮。 */
async function closeDataSyncDialog(): Promise<void> {
  if (!(await isPresent(DIALOG))) return;
  if (await isPresent(tid("remote-sync-close"))) await demoClick(tid("remote-sync-close"));
  else await demoClick(DIALOG_CLOSE);
  await browser.waitUntil(async () => !(await isPresent(DIALOG)), {
    timeout: 30_000,
    timeoutMsg: `${MARKER}: 数据同步弹窗没有关闭`,
  });
}

/** 切换弹窗分类；给出 text 时同时更新字幕，避免上一步的字幕停留在新分类上。 */
async function openTab(id: string, text?: string, leadMs?: number): Promise<void> {
  if (text) await caption(text);
  await demoClick(tid(`remote-sync-tab-${id}`), { leadMs });
}

async function readRowState(key: string) {
  return await browser.execute((rowTestId) => {
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid]")).find(
      (element) => element.dataset.testid === rowTestId,
    );
    return row
      ? { status: row.dataset.syncStatus ?? null, checked: row.getAttribute("aria-checked") }
      : null;
  }, `remote-sync-row-${key}`);
}

async function waitForRow(key: string, status: string, timeout = 90_000): Promise<void> {
  let last: Awaited<ReturnType<typeof readRowState>> = null;
  await browser.waitUntil(
    async () => {
      last = await readRowState(key);
      return last?.status === status;
    },
    {
      timeout,
      interval: 300,
      timeoutMsg: `${MARKER}: ${key} 没有变为 ${status}（${JSON.stringify(last)}）`,
    },
  );
}

async function setRowChecked(key: string, checked: boolean): Promise<void> {
  if ((await readRowState(key))?.checked === String(checked)) return;
  await demoClick(rowSelector(key));
  await browser.waitUntil(async () => (await readRowState(key))?.checked === String(checked), {
    timeout: 10_000,
    timeoutMsg: `${MARKER}: ${key} 勾选状态没有变为 ${checked}`,
  });
}

async function readText(selector: string): Promise<string> {
  return await browser.execute(
    (query) => document.querySelector(query)?.textContent?.trim() ?? "",
    selector,
  );
}

async function waitForText(selector: string, expected: string, timeout = 120_000): Promise<void> {
  await browser.waitUntil(async () => (await readText(selector)).includes(expected), {
    timeout,
    interval: 300,
    timeoutMsg: `${MARKER}: ${selector} 没有出现「${expected}」（当前「${await readText(selector)}」）`,
  });
}

async function pushActiveCategory(): Promise<void> {
  await demoClick(tid("remote-sync-push"));
  await waitForText(tid("remote-sync-push"), "再次同步", 5 * 60_000);
}

async function readHint(key: string): Promise<string | null> {
  return await browser.execute(
    (hintId) => document.querySelector(`[data-testid="${hintId}"]`)?.textContent ?? null,
    `remote-sync-row-hint-${key}`,
  );
}

async function waitForHint(key: string, hint: string | null): Promise<void> {
  await browser.waitUntil(async () => (await readHint(key)) === hint, {
    timeout: 90_000,
    interval: 300,
    timeoutMsg: `${MARKER}: ${key} 的依赖提示没有变为 ${hint}（当前 ${await readHint(key)}）`,
  });
}

/** Radix 菜单需要 pointerdown 打开；只操作当前可见的触发器。 */
async function openPointerMenu(trigger: string, menu = '[role="menu"]'): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (triggerQuery, menuQuery) => {
          if (document.querySelector(menuQuery)) return true;
          const element = Array.from(document.querySelectorAll<HTMLElement>(triggerQuery)).find(
            (item) => item.getClientRects().length > 0,
          );
          element?.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
          return false;
        },
        trigger,
        menu,
      ),
    { timeout: 15_000, interval: 400, timeoutMsg: `${MARKER}: 菜单打不开 ${trigger}` },
  );
}

async function readScopeKey(): Promise<string | null> {
  return await browser.execute((selector) => {
    const trigger = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (element) => element.getClientRects().length > 0,
    );
    return trigger?.dataset.pluginScopeKey ?? null;
  }, SCOPE_TRIGGER);
}

async function selectScopeKey(key: string): Promise<void> {
  await openPointerMenu(SCOPE_TRIGGER, '[role="menuitemradio"]');
  await demoClick(`[role="menuitemradio"][data-plugin-scope-key="${key}"]`);
  await browser.waitUntil(async () => (await readScopeKey()) === key, {
    timeout: 30_000,
    timeoutMsg: `${MARKER}: scope 没有切到 ${key}`,
  });
}

async function readActiveTab(): Promise<string | null> {
  return await browser.execute(
    () =>
      document
        .querySelector('[data-testid^="remote-sync-tab-"][aria-current="page"]')
        ?.getAttribute("data-testid")
        ?.replace("remote-sync-tab-", "") ?? null,
  );
}

async function waitForDialogTab(tab: string): Promise<void> {
  await browser.waitUntil(
    async () => (await isPresent(DIALOG)) && (await readActiveTab()) === tab,
    {
      timeout: 30_000,
      timeoutMsg: `${MARKER}: 数据同步弹窗没有定位到 ${tab}`,
    },
  );
}

/** 段落失败后把界面收回：关掉菜单和非推送中的弹窗。 */
async function recover(): Promise<void> {
  await caption(null).catch(() => undefined);
  await clearSpotlight().catch(() => undefined);
  await browser.keys("Escape").catch(() => undefined);
  await browser.pause(300);
  if ((await isPresent(DIALOG)) && (await isPresent(DIALOG_CLOSE))) {
    await browser
      .execute((query) => document.querySelector<HTMLElement>(query)?.click(), DIALOG_CLOSE)
      .catch(() => undefined);
    await browser.pause(500);
  }
}

interface ChapterSpec {
  key: string;
  title: string;
  bullets: readonly string[];
  setup?: () => Promise<void>;
  run: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

/** 每章一段视频：先离线完成 setup，再开始录制，章节卡 → 演示 → 停止；失败只记录、不中断走查。 */
async function chapter(spec: ChapterSpec): Promise<void> {
  try {
    await spec.setup?.();
    await startPart(spec.key, spec.title);
    await titleCard(spec.title, spec.bullets);
    await spec.run();
    await caption(null);
    await beat(900);
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 400);
    failures.push(`${spec.title}：${detail}`);
    await browser
      .saveScreenshot(resolve(artifact, `FAILED-${spec.key}.png`))
      .catch(() => undefined);
    await recover();
  } finally {
    await caption(null).catch(() => undefined);
    await clearSpotlight().catch(() => undefined);
    await stopPart();
    await spec.cleanup?.().catch((error: unknown) => {
      failures.push(`${spec.title}（收尾）：${String(error)}`);
    });
  }
}

// ---------- 本机与远端内容 ----------

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function agentMarkdown(name: string, extra: string[], body: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} for the data sync demo`,
    ...extra,
    "---",
    body,
    "",
  ].join("\n");
}

function pluginManifest(name: string, version: string): string {
  return `${JSON.stringify({ name, version, description: `${name} for the data sync demo` }, null, 2)}\n`;
}

const STYLE_GUIDE = skillMarkdown(SKILL.synced, "Team style guide", "Follow the team style guide.");
const PLANNER = agentMarkdown(AGENT.synced, [], "Plan the work before writing code.");
const STANDUP = "---\ndescription: Summarize yesterday and today\n---\nWrite the standup notes.\n";
const SYNCED_HOOK = { matcher: "Edit", hooks: [{ type: "command", command: HOOK.synced }] };

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 本机六类内容：每类都有「推送」项，另配「更新 / 差异 / 已同步 / 不能同步」所需的对照项。 */
async function writeLocalContent(home: string): Promise<void> {
  const zcode = join(home, ".zcode");
  const skills = join(zcode, "skills");
  await writeText(
    join(skills, SKILL.push, "SKILL.md"),
    skillMarkdown(
      SKILL.push,
      "Review code with the team checklist",
      "Check tests, naming, errors.",
    ),
  );
  await writeText(
    join(home, ".agents", "skills", SKILL.agentsDir, "SKILL.md"),
    skillMarkdown(SKILL.agentsDir, "Skill from the ~/.agents compat directory", "Compat skill."),
  );
  await writeText(
    join(skills, SKILL.update, "SKILL.md"),
    skillMarkdown(SKILL.update, "API design rules", "Use nouns for resources. v1.2"),
  );
  await writeText(join(skills, SKILL.update, "_meta.json"), '{ "version": "1.2.0" }\n');
  await writeText(
    join(skills, SKILL.older, "SKILL.md"),
    skillMarkdown(SKILL.older, "Legacy migration tips", "Old tips."),
  );
  await writeText(join(skills, SKILL.older, "_meta.json"), '{ "version": "1.0.0" }\n');
  await writeText(
    join(skills, SKILL.differs, "SKILL.md"),
    skillMarkdown(SKILL.differs, "Release notes format", "Local release notes format."),
  );
  await writeText(join(skills, SKILL.synced, "SKILL.md"), STYLE_GUIDE);
  const blocked = join(skills, SKILL.blocked);
  await writeText(
    join(blocked, "SKILL.md"),
    skillMarkdown(SKILL.blocked, "Skill that links shared assets", "Uses linked assets."),
  );
  await symlink("SKILL.md", join(blocked, "linked.md"));

  await writeText(
    join(zcode, "agents", `${AGENT.push}.md`),
    agentMarkdown(
      AGENT.push,
      ["tools: [Read, Grep, Glob]", `skills: [${SKILL.push}]`, `mcpServers: [${MCP.push}]`],
      "Review the change against the team checklist.",
    ),
  );
  await writeText(join(zcode, "agents", `${AGENT.synced}.md`), PLANNER);

  await writeText(
    join(zcode, "commands", "demo", "commit.md"),
    "---\ndescription: Write a commit message\n---\nWrite a commit message for the staged diff.\n",
  );
  await writeText(join(zcode, "commands", "demo-standup.md"), STANDUP);
  await writeText(
    join(home, ".agents", "commands", "demo-review.md"),
    "---\ndescription: Review the diff (compat directory)\n---\nReview the diff.\n",
  );

  const pluginDirs: string[] = [];
  for (const [name, version] of [
    [PLUGIN.update, "1.1.0"],
    [PLUGIN.older, "1.0.0"],
  ] as const) {
    const dir = join(zcode, "plugins", name);
    await writeText(join(dir, ".zcode-plugin", "plugin.json"), pluginManifest(name, version));
    await writeText(join(dir, "README.md"), `${name} ${version}\n`);
    pluginDirs.push(dir);
  }

  const configPath = join(zcode, "cli", "config.json");
  const config = await readJson(configPath);
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  await writeText(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        plugins: { ...plugins, dirs: [...((plugins.dirs as string[]) ?? []), ...pluginDirs] },
        mcp: {
          ...mcp,
          servers: {
            ...(mcp.servers as Record<string, unknown> | undefined),
            [MCP.push]: {
              command: "node",
              args: ["-e", "process.exit(0)", "search-server.js"],
              env: { SEARCH_API_KEY: "demo-search-key" },
            },
            [MCP.filesystem]: {
              command: "node",
              args: ["-e", "process.exit(0)", join(home, "projects")],
            },
            [MCP.differs]: { command: "node", args: ["-e", "process.exit(0)", "--local-docs"] },
          },
        },
        hooks: {
          enabled: true,
          events: {
            PostToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: HOOK.push, timeout: 30 }] },
            ],
            PreToolUse: [
              SYNCED_HOOK,
              { matcher: "Write", hooks: [{ type: "command", command: HOOK.unchecked }] },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** 远端已有内容：差异、已同步与远端独有项；config.json 读改写，保留连接时写入的字段。 */
async function seedRemote(container: string): Promise<void> {
  const write = (path: string, content: string) =>
    writeRemoteContainerFile(container, `${REMOTE_HOME}/${path}`, content);
  await write(
    `.zcode/skills/${SKILL.update}/SKILL.md`,
    skillMarkdown(SKILL.update, "API design rules", "Use nouns for resources. v1.1"),
  );
  await write(`.zcode/skills/${SKILL.update}/_meta.json`, '{ "version": "1.1.0" }\n');
  await write(
    `.zcode/skills/${SKILL.older}/SKILL.md`,
    skillMarkdown(SKILL.older, "Legacy migration tips", "Newer tips on the remote."),
  );
  await write(`.zcode/skills/${SKILL.older}/_meta.json`, '{ "version": "2.0.0" }\n');
  await write(
    `.zcode/skills/${SKILL.differs}/SKILL.md`,
    skillMarkdown(SKILL.differs, "Release notes format", "Remote release notes format."),
  );
  await write(`.zcode/skills/${SKILL.synced}/SKILL.md`, STYLE_GUIDE);
  await write(
    `.zcode/skills/${SKILL.remoteOnly}/SKILL.md`,
    skillMarkdown(SKILL.remoteOnly, "Notes that only exist on the remote", "Remote only."),
  );
  await write(`.zcode/agents/${AGENT.synced}.md`, PLANNER);
  await write(".zcode/commands/demo-standup.md", STANDUP);
  const remotePluginDirs: string[] = [];
  for (const [name, version] of [
    [PLUGIN.update, "1.0.0"],
    [PLUGIN.older, "2.0.0"],
  ] as const) {
    await write(`.zcode/plugins/${name}/.zcode-plugin/plugin.json`, pluginManifest(name, version));
    await write(`.zcode/plugins/${name}/README.md`, `${name} ${version}\n`);
    await write(`.zcode/plugins/${name}/data/state.json`, '{ "remote": true }\n');
    remotePluginDirs.push(`${REMOTE_HOME}/.zcode/plugins/${name}`);
  }
  const config = (await remoteContainerPathExists(container, REMOTE_CLI_CONFIG))
    ? (JSON.parse(await readRemoteContainerFile(container, REMOTE_CLI_CONFIG)) as Record<
        string,
        unknown
      >)
    : {};
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  await writeRemoteContainerFile(
    container,
    REMOTE_CLI_CONFIG,
    `${JSON.stringify(
      {
        ...config,
        plugins: {
          ...plugins,
          dirs: [...((plugins.dirs as string[]) ?? []), ...remotePluginDirs],
        },
        mcp: {
          ...mcp,
          servers: {
            ...(mcp.servers as Record<string, unknown> | undefined),
            [MCP.filesystem]: {
              command: "node",
              args: ["-e", "process.exit(0)", `${REMOTE_HOME}/projects`],
            },
            [MCP.differs]: { command: "node", args: ["-e", "process.exit(0)", "--remote-docs"] },
            "remote-only-mcp": { command: "node", args: ["-e", "process.exit(0)"] },
          },
        },
        hooks: {
          enabled: true,
          events: {
            PreToolUse: [SYNCED_HOOK],
            PostToolUse: [
              { matcher: "Edit", hooks: [{ type: "command", command: HOOK.remoteOnly }] },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

// ---------- 拼接 ----------

async function probeDuration(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function formatTimestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** 各段统一缩放到同一画布后拼接为 H.264 mp4，并按段时长写出章节时间点。 */
async function assembleDemoVideo(): Promise<{ video?: string; error?: string }> {
  const usable = clips.filter((clip) => !clip.error);
  if (usable.length === 0) return { error: "没有可用的视频片段" };
  for (const clip of usable) clip.durationSec = await probeDuration(resolve(artifact, clip.file));
  const output = resolve(artifact, "data-sync-demo.mp4");
  const args = ["-y", "-loglevel", "error"];
  for (const clip of usable) args.push("-i", resolve(artifact, clip.file));
  const { width, height } = WINDOW;
  const filters = usable.map(
    (_, index) =>
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x18181b,setsar=1,fps=10[v${index}]`,
  );
  const concat = `${usable.map((_, index) => `[v${index}]`).join("")}concat=n=${usable.length}:v=1:a=0[out]`;
  args.push(
    "-filter_complex",
    [...filters, concat].join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "20",
    "-preset",
    "medium",
    "-movflags",
    "+faststart",
    output,
  );
  try {
    await run(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 });
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error).slice(0, 400) };
  }
  let offset = 0;
  let previous = "";
  const lines: string[] = [];
  for (const clip of usable) {
    if (clip.title !== previous) lines.push(`${formatTimestamp(offset)} ${clip.title}`);
    previous = clip.title;
    offset += clip.durationSec ?? 0;
  }
  await writeFile(resolve(artifact, "chapters.txt"), `${lines.join("\n")}\n`);
  return { video: output };
}

describe(`${MARKER}: 数据同步功能演示走查`, () => {
  let container = "";
  let offlineTarget: { host: string; port: number } | null = null;
  let providerDirLocked = false;

  after(async () => {
    if (offlineTarget)
      await bringRemoteDeviceOnline(container, offlineTarget).catch(() => undefined);
    if (providerDirLocked)
      await chmodRemoteContainerPath(container, "u+w", `${REMOTE_HOME}/.zcode/v2`).catch(
        () => undefined,
      );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-DEMO 按用户顺序演示数据同步全部功能并录制视频", async function () {
    this.timeout(90 * 60_000);
    await mkdir(artifact, { recursive: true });
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    const workspacePath = config.workspacePaths[0]!;
    const { homeDir } = getE2EAppDataPaths();

    // ---------- 离线准备：本机内容、marketplace 插件、模型提供商 ----------
    await writeLocalContent(homeDir);
    await prepareSSHConnectionPage(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setWindowWidth(WINDOW.width);
    await setLocaleAndTheme("zh-CN", "light");
    const fixture = await createPluginLifecycleFixture("1.0.0");
    await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    await installMarketplacePluginThroughAgent(
      PLUGIN_LIFECYCLE_NAME,
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );
    await openSettingsSection("modelProvider");
    await createAndConfigurePersonalProvider(PROVIDER);
    await leaveSettings();
    await parkPointer();

    await chapter({
      key: "intro",
      title: "ZCode 数据同步 · 功能演示",
      bullets: [
        "把本机的用户级配置推送到远端设备（SSH / WSL / Docker）",
        "六类内容：子智能体、插件、MCP 服务器、技能、命令、钩子；模型提供商只读",
        "推送永不删除远端独有的条目；远端较新或内容不同的项默认不勾选",
        "本次演示的远端是本机 Docker 容器模拟的 Linux 设备",
      ],
      run: async () => {
        await beat(1_200);
      },
    });

    await chapter({
      key: "entry",
      title: "① 入口：设置 → 数据与统计 → 数据同步",
      bullets: [
        "没有远端设备时显示空状态和「连接远端设备」",
        "「迁移」直接进入迁移向导第一步「会话」",
        "设置侧栏不再有单独的「引导」入口",
      ],
      run: async () => {
        await caption("从设置进入");
        await openSettingsSection("dataSync");
        await waitForTestIdByDom("remote-sync-empty", { timeout: 30_000 });
        await point(
          tid(testId(TID_SETTINGS_SECTION_NAV, "dataSync")),
          "「数据与统计」分组下新增「数据同步」；侧栏不再有单独的「引导」入口",
        );
        await point(tid("remote-sync-empty"), "还没有远端设备：显示空状态和「连接远端设备」按钮", {
          ms: LONG_BEAT_MS,
        });
        await caption("右上角「迁移」：从其他 AI 工具导入本机");
        await demoClick(tid("remote-sync-migrate"));
        await waitForTestIdByDom("onboarding-migration-dialog", { timeout: 30_000 });
        await say("直接进入迁移向导第一步「会话」，不再经过欢迎页；左下角是「取消」", LONG_BEAT_MS);
        await demoClick(tid("onboarding-wizard-cancel"));
        await browser.waitUntil(
          async () => !(await isPresent(tid("onboarding-migration-dialog"))),
          {
            timeout: 15_000,
            timeoutMsg: `${MARKER}: 迁移向导没有关闭`,
          },
        );
        await say("「取消」直接关闭向导，回到数据同步页");
      },
    });

    // ---------- 离线准备：连接设备并打开远端项目，预置远端内容 ----------
    await leaveSettings();
    const remoteTab = await connectSSHWorkspace({ caseMarker: MARKER, config, workspacePath });
    const sourceServerId =
      parseRemoteWorkspaceIdentity(remoteTab.workspaceIdentity ?? "")?.sourceServerId ?? "";
    expect(sourceServerId).toBeTruthy();
    await seedRemote(container);
    await parkPointer();

    await chapter({
      key: "devices",
      title: "② 设备列表与同步弹窗",
      bullets: [
        "设备行：状态点、名称、传输方式、目标地址、上次同步状态",
        "弹窗：顶部是目标设备；左侧分类导航；底部固定操作栏",
        "概览：每类的本机数量、远端数量，以及「N 项变更」或「已一致」",
      ],
      run: async () => {
        await caption("连接远端设备并打开项目后，回到「设置 → 数据同步」");
        await openDataSyncPage();
        await waitForDevice((row) => row.action === "同步配置", "设备行没有「同步配置」按钮");
        await point(
          tid("remote-sync-device-list"),
          "设备行：绿色状态点、名称、传输方式与目标地址；还没同步过，显示「尚未同步」",
          { ms: LONG_BEAT_MS },
        );
        await caption("点「同步配置」打开该设备的数据同步弹窗");
        await demoClick(tid("remote-sync-device-action"));
        await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
        await say("打开时先显示概览；各分类分别加载，算好一类显示一类");
        await waitForOverviewLoaded();
        await point(tid("remote-sync-dialog-device"), "顶部显示推送目标：状态点、设备名和目标地址");
        await point(
          tid("remote-sync-overview-table"),
          "概览：每类的本机数量、远端数量，以及「N 项变更」或「已一致」",
          { ms: LONG_BEAT_MS },
        );
        await point(
          tid("remote-sync-overview-providers"),
          "模型提供商是只读分类：勾选框不可用，不参与「推送全部」",
        );
        await say("点行前的勾选框只改变选择；点整行进入该分类");
      },
    });

    await chapter({
      key: "subagents",
      title: "③ 子智能体：按原文件推送，提示缺失依赖",
      bullets: [
        "按名称对齐、按原文件推送：模型、工具、技能等字段原样保留",
        "引用的 MCP 或技能在远端不存在时，行内提示缺失项",
        "提示不影响勾选和推送，由你决定是否一并推送依赖",
      ],
      run: async () => {
        await demoClick(tid("remote-sync-overview-subagents"));
        await waitForRow(AGENT.push, "push");
        await waitForHint(AGENT.push, DEPENDENCY_HINT_BOTH);
        await point(rowSelector(AGENT.push), "只在本机的子智能体：绿色「推送」，默认勾选");
        await point(
          tid(`remote-sync-row-hint-${AGENT.push}`),
          "它引用的 MCP「demo-search」和技能「demo-code-review」远端都没有：行内提示缺失项",
          { ms: LONG_BEAT_MS },
        );
        await point(rowSelector(AGENT.synced), "两端内容一致：灰色「已同步」，不可勾选");
      },
    });

    await chapter({
      key: "skills",
      title: "④ 技能：条目状态、选择与推送",
      bullets: [
        "推送（绿）· 更新（蓝）· 差异（黄）· 已同步（灰）· 不能同步（写明原因）",
        "列表按「推送 → 更新 → 差异 → 已同步」排序",
        "推送完成后列表自动刷新；主动勾选差异项才会覆盖远端",
      ],
      run: async () => {
        await openTab("skills");
        await waitForRow(SKILL.push, "push");
        await waitForRow(SKILL.update, "update");
        await say("列表按「推送 → 更新 → 差异 → 已同步」排序，需要处理的项在前");
        await point(rowSelector(SKILL.push), "绿色「推送」：只在本机，默认勾选");
        await point(
          rowSelector(SKILL.agentsDir),
          "兼容目录 ~/.agents/skills 的技能也会同步，统一写入远端 ~/.zcode/skills",
        );
        await point(
          rowSelector(SKILL.update),
          "蓝色「更新」：本机版本较新（1.1.0 → 1.2.0），默认勾选",
        );
        await point(
          rowSelector(SKILL.older),
          "黄色「差异」：远端版本较新（本机版本较旧），默认不勾选，不会无意中降级远端",
        );
        await point(rowSelector(SKILL.differs), "黄色「差异」：没有版本号且内容不同，默认不勾选");
        await point(rowSelector(SKILL.synced), "灰色「已同步」：两端一致，不可勾选");
        await point(
          rowSelector(SKILL.blocked),
          "不能同步的条目不可选，并写明原因（这里是目录内含软链）",
        );
        await say("远端独有的技能（remote-only-notes）不出现在列表中，推送也永远不会删除它");
        await point(tid("remote-sync-selection-summary"), "底部显示本次将同步的数量");
        await caption("「全选」会连黄色差异项一起选中");
        await demoClick(tid("remote-sync-select-all"));
        await beat();
        await caption("「取消选择」：显示「未选择任何内容」，推送按钮不可用");
        await demoClick(tid("remote-sync-clear"));
        await beat(LONG_BEAT_MS);
        await caption("逐项勾选：只选默认项");
        for (const key of [SKILL.push, SKILL.agentsDir, SKILL.update]) {
          await setRowChecked(key, true);
        }
        await beat(1_200);
        await caption("推送技能：按钮显示「同步中…」，推送期间弹窗不能关闭");
        await pushActiveCategory();
        await waitForRow(SKILL.push, "synced");
        await say(
          "完成后显示「再次同步」，列表自动刷新：刚推送的条目变为「已同步」；未勾选的差异项保持不变",
          LONG_BEAT_MS,
        );
        await caption("主动勾选黄色差异项，用本机内容覆盖远端");
        await setRowChecked(SKILL.differs, true);
        await pushActiveCategory();
        await waitForRow(SKILL.differs, "synced");
        await point(rowSelector(SKILL.differs), "覆盖完成，该项变为「已同步」");
        await caption("回到子智能体：缺失提示随两端列表更新");
        await openTab("subagents");
        await waitForHint(AGENT.push, DEPENDENCY_HINT_MCP);
        await point(
          tid(`remote-sync-row-hint-${AGENT.push}`),
          "技能「demo-code-review」已推送到远端，提示只剩缺少的 MCP",
          { ms: LONG_BEAT_MS },
        );
      },
    });

    await chapter({
      key: "categories",
      title: "⑤ 插件 · MCP 服务器 · 命令 · 钩子",
      bullets: [
        "插件：inline 插件按版本比较；marketplace 插件在远端按同一来源重新安装",
        "MCP：filesystem 类的本机 home 路径改写为远端 home",
        "命令：按相对路径对齐，包含 ~/.agents/commands 兼容目录",
        "钩子：每条定义单独一行，推送只合并选中的定义",
      ],
      run: async () => {
        await openTab("plugins");
        await waitForRow(`${PLUGIN.update}@inline`, "update");
        await point(
          rowSelector(`${PLUGIN.update}@inline`),
          "inline 插件：1.0.0 → 1.1.0，蓝色「更新」；远端插件目录里的 data/ 运行数据保留",
        );
        await point(
          rowSelector(`${PLUGIN.older}@inline`),
          "远端版本更高：黄色「差异」·「本机版本较旧」",
        );
        await point(
          rowSelector(PLUGIN.marketplace),
          "marketplace 插件：推送时在远端按同一来源重新安装；本地目录来源会先镜像到远端",
          { ms: LONG_BEAT_MS },
        );
        await openTab("mcp", "切到「MCP 服务器」");
        await waitForRow(MCP.push, "push");
        await point(rowSelector(MCP.push), "MCP 服务器：命令、参数、环境变量原样同步");
        await point(
          rowSelector(MCP.filesystem),
          "filesystem 类 MCP：本机 home 路径改写成远端 home 后再比较，两端一致，显示「已同步」",
          { ms: LONG_BEAT_MS },
        );
        await point(rowSelector(MCP.differs), "远端同名 MCP 的配置不同：黄色「差异」");
        await openTab("commands", "切到「命令」");
        await waitForRow(COMMAND.nested, "push");
        await point(rowSelector(COMMAND.nested), "命令按相对路径对齐，子目录结构保持不变");
        await point(
          rowSelector(COMMAND.agentsDir),
          "兼容目录 ~/.agents/commands 的命令统一写入远端 ~/.zcode/commands",
        );
        await openTab("hooks", "切到「钩子」");
        await browser.waitUntil(async () => await spotlight(ANY_ROW, HOOK.push), {
          timeout: 60_000,
          timeoutMsg: `${MARKER}: 钩子分类没有显示本机钩子`,
        });
        await clearSpotlight();
        await point(
          ANY_ROW,
          "每条钩子定义单独一行：显示事件、matcher 和完整命令，清楚知道将在远端执行什么",
          { match: HOOK.push, ms: LONG_BEAT_MS },
        );
        await point(ANY_ROW, "与远端一致的定义显示「已同步」", { match: HOOK.synced });
        await say("推送只合并选中的定义；远端已有的其他钩子（这里有一条远端独有的）保持不变");
        await caption("取消勾选其中一条");
        await demoClick(ANY_ROW, { match: HOOK.unchecked });
        await beat();
      },
    });

    await chapter({
      key: "push-all",
      title: "⑥ 推送全部",
      bullets: [
        "概览勾选框有全选、部分选、未选三种状态，与分类页同步",
        "「推送全部」只推送已勾选条目的分类",
        "推送期间按钮显示「全部同步中…」，完成后显示「已全部同步」",
      ],
      run: async () => {
        await openTab("overview");
        await waitForOverviewLoaded();
        await point(
          tid("remote-sync-overview-checkbox-hooks"),
          "钩子分类刚取消了一条：概览勾选框显示「部分选」",
          { ms: LONG_BEAT_MS },
        );
        await caption("点「推送全部」：按分类依次推送已勾选的条目");
        await demoClick(tid("remote-sync-push-all"));
        // 插件是第二个推送的分类，远端安装 marketplace 插件只需几秒：立即切过去，才能看到按行「停止」。
        await openTab("plugins", "切到插件分类查看推送进度", 150);
        // 插件推送已结束（按钮变为「再次同步」）就不再等「停止」按钮，避免画面空等。
        let stoppable = false;
        await browser
          .waitUntil(
            async () => {
              stoppable = await spotlight('[data-testid^="remote-sync-row-stop-"]');
              return stoppable || (await readText(tid("remote-sync-push"))).includes("再次同步");
            },
            { timeout: 20_000, interval: 100 },
          )
          .catch(() => undefined);
        if (stoppable) {
          await say("marketplace 插件在远端添加或安装期间，可以按行「停止」", LONG_BEAT_MS);
          await clearSpotlight();
        }
        await openTab("overview", "回到概览", 300);
        if ((await readText(tid("remote-sync-push-all"))).includes("全部同步中")) {
          await point(
            tid("remote-sync-push-all"),
            "推送全部期间按钮显示「全部同步中…」，弹窗不能关闭",
          );
        }
        await offCamera(() => waitForText(tid("remote-sync-push-all"), "已全部同步", 10 * 60_000));
        await waitForOverviewLoaded();
        await say(
          "完成后显示「已全部同步」：处理完的分类变为「已一致」；未勾选的差异项仍然保留",
          LONG_BEAT_MS,
        );
        await caption("回到子智能体：依赖都已在远端，缺失提示消失");
        await openTab("subagents");
        await waitForHint(AGENT.push, null);
        await point(rowSelector(AGENT.push), "子智能体已同步，没有缺失依赖提示");
      },
    });

    await chapter({
      key: "conflict",
      title: "⑦ 冲突保护与设备同步状态",
      bullets: [
        "列表加载后远端又被修改：推送不覆盖，提示「远端已变化，请刷新后重试」",
        "部分失败时失败项行内显示原因，底部汇总失败数量",
        "设备行显示「上次同步失败」+「重试」，成功后显示「今天 HH:MM 已同步」",
      ],
      setup: async () => {
        await writeText(
          join(homeDir, ".zcode", "skills", SKILL.conflict, "SKILL.md"),
          skillMarkdown(SKILL.conflict, "Skill created on this machine", "Local version."),
        );
        await closeDataSyncDialog();
        await demoClick(tid("remote-sync-device-action"));
        await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
        await openTab("skills");
        await waitForRow(SKILL.conflict, "push");
      },
      run: async () => {
        await point(rowSelector(SKILL.conflict), "本机新建了技能 demo-conflict：列表显示「推送」");
        await caption("列表加载之后，远端另一处也写入了同名技能");
        await writeRemoteContainerFile(
          container,
          `${REMOTE_HOME}/.zcode/skills/${SKILL.conflict}/SKILL.md`,
          skillMarkdown(SKILL.conflict, "Skill created on the remote", "Remote version."),
        );
        await beat();
        await caption("推送技能");
        await demoClick(tid("remote-sync-push"));
        await waitForText(tid(`remote-sync-row-error-${SKILL.conflict}`), "远端已变化", 120_000);
        await point(
          rowSelector(SKILL.conflict),
          "推送前校验远端基线：远端已变化时不覆盖，行内提示「远端已变化，请刷新后重试」",
          { ms: LONG_BEAT_MS },
        );
        await point(tid("remote-sync-failure-summary"), "底部汇总失败数量");
        await openTab("overview");
        await closeDataSyncDialog();
        await waitForDevice((row) => row.status === "上次同步失败", "设备行没有显示同步失败");
        await point(
          tid("remote-sync-device-list"),
          "设备行显示红点「上次同步失败」，按钮变为「重试」",
          { ms: LONG_BEAT_MS },
        );
        await caption("点「重试」重新打开该设备的同步弹窗");
        await demoClick(tid("remote-sync-device-action"));
        await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
        await openTab("skills");
        await waitForRow(SKILL.conflict, "difference");
        await point(
          rowSelector(SKILL.conflict),
          "重新加载后按最新远端比较：该项变为黄色「差异」，默认不勾选",
        );
        await caption("确认用本机内容覆盖：勾选后推送");
        await setRowChecked(SKILL.conflict, true);
        await pushActiveCategory();
        await waitForRow(SKILL.conflict, "synced");
        await openTab("overview");
        await closeDataSyncDialog();
        await waitForDevice((row) => row.status.includes("已同步"), "设备行没有显示同步时间");
        await point(tid("remote-sync-device-list"), "同步成功：设备行显示「今天 HH:MM 已同步」", {
          ms: LONG_BEAT_MS,
        });
      },
    });

    await chapter({
      key: "providers",
      title: "⑧ 模型提供商：只读、自动同步失败与重试",
      bullets: [
        "列出本机的模型提供商，API Key 只显示掩码",
        "显示上次自动同步的时间和结果；失败时显示原因和「重试」",
        "不参与勾选和「推送全部」，模型配置始终以本机为准整体下发",
      ],
      setup: async () => {
        // 远端模型配置目录只读：本机新增提供商后自动下发失败（与 DSYNC-13 相同的故障注入）。
        await chmodRemoteContainerPath(container, "a-w", `${REMOTE_HOME}/.zcode/v2`);
        providerDirLocked = true;
        await openSettingsSection("modelProvider");
        await createAndConfigurePersonalProvider(SECOND_PROVIDER);
        await openDataSyncPage();
        await parkPointer();
      },
      run: async () => {
        await caption("本机刚新增了一个模型提供商，自动下发到远端时写入失败");
        await demoClick(tid("remote-sync-device-action"));
        await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
        await point(
          tid("remote-sync-overview-providers"),
          "概览中「模型提供商」一行显示「同步失败」",
        );
        await openTab("providers");
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () =>
                document.querySelector<HTMLElement>('[data-testid="remote-sync-providers-status"]')
                  ?.dataset.provisioningState ?? null,
            )) === "failed",
          { timeout: 120_000, interval: 500, timeoutMsg: `${MARKER}: 模型提供商没有显示失败` },
        );
        await point(
          tid("remote-sync-resource-list"),
          "只读列表：本机的模型提供商与地址，API Key 只显示掩码",
          { ms: LONG_BEAT_MS },
        );
        await point(
          tid("remote-sync-providers-status"),
          "显示上次自动同步的时间和失败原因，并提供「重试」",
          { ms: LONG_BEAT_MS },
        );
        await chmodRemoteContainerPath(container, "u+w", `${REMOTE_HOME}/.zcode/v2`);
        providerDirLocked = false;
        await caption("远端恢复可写后点「重试」");
        await demoClick(tid("remote-sync-providers-retry"));
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () =>
                document.querySelector<HTMLElement>('[data-testid="remote-sync-providers-status"]')
                  ?.dataset.provisioningState ?? null,
            )) === "success",
          { timeout: 120_000, interval: 500, timeoutMsg: `${MARKER}: 重试后没有显示成功` },
        );
        await point(tid("remote-sync-providers-status"), "重试成功：显示「HH:MM 已自动同步」", {
          ms: LONG_BEAT_MS,
        });
      },
      cleanup: async () => {
        if (providerDirLocked) {
          await chmodRemoteContainerPath(container, "u+w", `${REMOTE_HOME}/.zcode/v2`);
          providerDirLocked = false;
        }
      },
    });

    await chapter({
      key: "runtime",
      title: "⑨ 推送后在远程项目中立即可用",
      bullets: ["推送后自动刷新远端的技能、子智能体、命令、MCP、插件", "不需要重开远程项目"],
      setup: async () => {
        await closeDataSyncDialog();
        await leaveSettings();
        await parkPointer();
      },
      run: async () => {
        await caption("回到远程项目，在输入框输入「/」");
        for (const value of ["/", "/d", "/de", "/dem", "/demo"]) {
          await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, value, { timeout: 30_000 });
          await browser.pause(220);
        }
        await browser.waitUntil(
          async () => (await readText(tid(TID_PROMPT_SUGGESTION_PANEL))).includes(COMMAND.nested),
          {
            timeout: 60_000,
            interval: 500,
            timeoutMsg: `${MARKER}: / 建议没有出现推送的命令`,
          },
        );
        await point(
          tid(TID_PROMPT_SUGGESTION_PANEL),
          "刚推送的命令（含子目录命令 /demo/commit 和兼容目录的 /demo-review）立即出现在 / 建议中",
          { ms: LONG_BEAT_MS + 600 },
        );
        await caption("向下滚动：推送的技能（$demo-…）和子智能体也在");
        // 建议列表是虚拟列表，只渲染可见行：边滚动边累计文字，再判断技能和子智能体是否出现。
        let seen = "";
        for (let step = 0; step < 30; step += 1) {
          const result = await browser.execute((panelId) => {
            const list = document.querySelector<HTMLElement>(
              `[data-testid="${panelId}"] [role="listbox"]`,
            );
            if (!list) return null;
            const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
            const text = list.textContent ?? "";
            list.scrollBy({ top: 96, behavior: "smooth" });
            return { atEnd, text };
          }, TID_PROMPT_SUGGESTION_PANEL);
          if (!result) break;
          seen += result.text;
          if (result.atEnd) break;
          await browser.pause(activeRecording ? 650 : 150);
        }
        expect(seen).toContain(SKILL.push);
        expect(seen).toContain(AGENT.push);
        await beat(LONG_BEAT_MS);
        await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");
      },
    });

    await chapter({
      key: "legacy-entries",
      title: "⑩ 旧同步入口统一打开数据同步弹窗",
      bullets: [
        "侧栏远端项目菜单、技能 / MCP / 插件设置页、Header 更多菜单的同步入口",
        "都打开同一个数据同步弹窗，并定位到对应的设备和分类",
      ],
      run: async () => {
        await caption("侧栏远端项目的「更多」菜单");
        await hoverProjectRow(workspacePath);
        await openPointerMenu(
          `${projectSectionSelector(workspacePath)} [data-testid="${TID_VIRTUAL_PROJECT_MENU}"]`,
        );
        await caption("「同步插件」");
        await demoClick(tid(virtualProjectActionTestId("sync-plugins-0")));
        await waitForDialogTab("plugins");
        await parkPointer();
        await point(DIALOG, "打开的是同一个数据同步弹窗，直接定位到该设备的「插件」分类", {
          ms: LONG_BEAT_MS,
        });
        await demoClick(DIALOG_CLOSE);
        await caption("技能设置页的「同步」按钮");
        await openSettingsSection("skill");
        await demoClick(tid("data-sync-entry-skills"));
        await waitForDialogTab("skills");
        await point(DIALOG, "同样打开数据同步弹窗，定位到「技能」分类", { ms: LONG_BEAT_MS });
        await demoClick(DIALOG_CLOSE);
      },
    });

    await chapter({
      key: "scope-menu",
      title: "⑪ 设置页 Scope 菜单按设备分组",
      bullets: [
        "「本机」下是用户和本机项目；每台在线远端设备下是用户和该设备的项目",
        "触发器显示「设备 · 用户」或「设备 · 项目」",
        "不打开远程项目也能直接编辑远端 ~/.zcode；插件、MCP、技能、子智能体、命令、钩子同一规则",
      ],
      setup: async () => {
        await openSettingsSection("skill");
      },
      run: async () => {
        const remoteUserKey = `source-user:${sourceServerId}`;
        await browser.waitUntil(async () => (await readScopeKey()) === remoteUserKey, {
          timeout: 60_000,
          timeoutMsg: `${MARKER}: 技能页没有默认选中远端设备的「用户」`,
        });
        await point(
          SCOPE_TRIGGER,
          "当前 workspace 在远端设备上：默认选中该设备的「用户」，触发器显示「设备 · 用户」",
          { ms: LONG_BEAT_MS },
        );
        await caption("菜单按设备分组：「本机」下是用户和本机项目；远端设备下是用户和该设备的项目");
        await openPointerMenu(SCOPE_TRIGGER, '[role="menuitemradio"]');
        await beat(LONG_BEAT_MS + 800);
        await browser.keys("Escape");
        await point(
          "*",
          "列表就是远端 ~/.zcode/skills：远端独有的 remote-only-notes 仍在，推送从不删除远端条目",
          { match: SKILL.remoteOnly, ms: LONG_BEAT_MS },
        );
        await caption("切到「本机 · 用户」");
        await selectScopeKey("user");
        await say("同一页面直接切换要编辑的设备：现在列表是本机技能", LONG_BEAT_MS);
        await caption("MCP 页遵循同一规则");
        await openSettingsSection("mcp");
        await point(SCOPE_TRIGGER, "MCP 页同样按设备分组，默认是当前 workspace 所在设备的「用户」");
      },
    });

    await chapter({
      key: "theme-locale",
      title: "⑫ 深色主题与英文界面",
      bullets: ["所有状态标签在浅色和深色主题下都清晰可读", "所有文案都有英文翻译"],
      setup: async () => {
        await openDataSyncDialog();
        await openTab("plugins");
        await waitForRow(`${PLUGIN.older}@inline`, "difference");
      },
      run: async () => {
        await setLocaleAndTheme("zh-CN", "dark");
        await say("深色主题：推送、更新、差异、已同步标签都清晰可读", LONG_BEAT_MS);
        await openTab("skills");
        await beat();
        await setLocaleAndTheme("en-US", "dark");
        await say("英文界面", LONG_BEAT_MS);
        await openTab("overview");
        await beat();
        await setLocaleAndTheme("en-US", "light");
        await say("English · light theme", BEAT_MS);
      },
      cleanup: async () => {
        await setLocaleAndTheme("zh-CN", "light");
        await closeDataSyncDialog();
      },
    });

    await chapter({
      key: "narrow",
      title: "⑬ 窄窗口",
      bullets: ["分类导航变为顶部可横向滚动的标签"],
      setup: async () => {
        await setWindowWidth(NARROW_WIDTH);
        await demoClick(tid("remote-sync-device-action"));
        await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
      },
      run: async () => {
        await point(tid("remote-sync-sidebar-frame"), "窄窗口：分类导航变为顶部横向标签", {
          ms: LONG_BEAT_MS,
        });
        await browser.execute(() =>
          document
            .querySelector('[data-testid="remote-sync-sidebar-frame"] nav')
            ?.scrollTo({ left: 600, behavior: "smooth" }),
        );
        await say("可以横向滚动");
        await openTab("hooks");
        await beat();
      },
      cleanup: async () => {
        await closeDataSyncDialog();
        await setWindowWidth(WINDOW.width);
      },
    });

    await chapter({
      key: "offline",
      title: "⑭ 设备离线与恢复",
      bullets: [
        "设备断开后弹窗显示离线，并禁用全部操作",
        "远端恢复后，打开中的远程项目自动重连",
        "设备重新上线后，弹窗自动重新加载列表",
      ],
      setup: async () => {
        await openDataSyncDialog();
        await waitForOverviewLoaded();
      },
      run: async () => {
        await caption("弹窗打开时，远端设备断开（这里停止了远端容器）");
        offlineTarget = { host: config.host, port: config.port };
        await takeRemoteDeviceOffline(container);
        await offCamera(() =>
          browser.waitUntil(async () => await isPresent(tid("remote-sync-offline")), {
            timeout: 5 * 60_000,
            interval: 500,
            timeoutMsg: `${MARKER}: 设备离线后弹窗没有显示离线`,
          }),
        );
        await point(
          tid("remote-sync-offline"),
          "弹窗显示「设备已离线，操作已禁用」；顶部状态点变为空心",
          { ms: LONG_BEAT_MS },
        );
        await point(tid("remote-sync-push-all"), "「推送全部」等操作全部禁用");
        await caption("远端恢复：打开中的远程项目会自动重连");
        await bringRemoteDeviceOnline(container, offlineTarget);
        offlineTarget = null;
        await beat(1_200);
        await offCamera(async () => {
          await browser.waitUntil(async () => !(await isPresent(tid("remote-sync-offline"))), {
            timeout: 5 * 60_000,
            interval: 500,
            timeoutMsg: `${MARKER}: 设备恢复后弹窗仍显示离线`,
          });
          await waitForOverviewLoaded();
        });
        await point(
          tid("remote-sync-overview-table"),
          "设备重新上线：离线提示消失，弹窗按最新远端状态自动重新加载列表",
          { ms: LONG_BEAT_MS },
        );
        await closeDataSyncDialog();
        await waitForDevice((row) => row.action === "同步配置", "设备行没有恢复为「同步配置」");
        await point(tid("remote-sync-device-list"), "设备行恢复为绿色状态点和「同步配置」", {
          ms: LONG_BEAT_MS,
        });
      },
      cleanup: async () => {
        if (offlineTarget) {
          await bringRemoteDeviceOnline(container, offlineTarget);
          offlineTarget = null;
        }
        await closeDataSyncDialog().catch(() => undefined);
      },
    });

    await chapter({
      key: "outro",
      title: "演示结束",
      bullets: [
        "数据同步页：设备列表、同步状态、迁移入口",
        "同步弹窗：概览、六类推送、模型提供商只读、冲突保护、离线保护",
        "旧入口统一打开同一个弹窗；Scope 菜单按设备分组",
      ],
      run: async () => {
        await beat(1_000);
      },
    });

    const assembled = await assembleDemoVideo();
    await writeFile(
      resolve(artifact, "index.json"),
      JSON.stringify(
        { marker: MARKER, capturedAt: new Date().toISOString(), assembled, clips, failures },
        null,
        2,
      ),
    );
    expect(assembled.error).toBeUndefined();
    expect(clips.filter((clip) => clip.error).map((clip) => clip.file)).toEqual([]);
    // 章节失败可以继续录后面的章节，但不能把未完成的演示汇总为 PASS。
    expect(failures).toEqual([]);
  });
});
