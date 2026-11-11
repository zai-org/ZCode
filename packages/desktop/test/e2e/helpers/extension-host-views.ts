/**
 * 扩展进程 E2E 的通用操作（docs/plugins/extension-host.md §15）：插件目录种子、扩展日志、
 * 扩展视图标签页与沙箱页面、composer.status 插槽、侧栏启动页。
 *
 * 抽取原因：PLM-EXT-2B（fixture 插件）与当时的 PLM-EXT-2C（示例插件 context-inspector，已迁到市场仓库）用同一组读法，
 * 两份复制的实现一旦漂移就会出现「一个 spec 绿另一个红」的假信号。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_EXTENSION_COMPOSER_STATUS,
  TID_EXTENSION_VIEW,
  TID_SIDE_PANE_EXTENSION_VIEW_ITEM,
} from "@zcode/shared/test-ids";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { ensureSidePaneEntryVisible } from "#e2e/helpers/browser-side-pane";

/** 把插件目录写进隔离 HOME 的 `~/.zcode/cli/config.json`（`plugins.dirs`），并启用为 `<name>@inline`。 */
export async function writePluginDirsConfig(
  dirs: readonly string[],
  pluginIds: readonly string[],
): Promise<void> {
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
          dirs: [...dirs],
          enabledPlugins: {
            ...((plugins.enabledPlugins ?? {}) as Record<string, boolean>),
            ...Object.fromEntries(pluginIds.map((id) => [id, true])),
          },
        },
      },
      null,
      2,
    ),
  );
}

// —— 日志：Main 以 [extension-host] / [extensions] 等前缀写进 ~/.zcode/v2/logs ——

async function readExtensionLogLines(): Promise<string[]> {
  const logDir =
    process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() || join(resolveE2EStorageRoot(), "v2", "logs");
  const names = (await readdir(logDir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".log"))
    .sort();
  const lines: string[] = [];
  for (const name of names) {
    lines.push(...(await readFile(join(logDir, name), "utf8")).split("\n"));
  }
  return lines.filter(
    (line) =>
      line.includes("[extension-host]") ||
      line.includes("[extensions]") ||
      line.includes("[extension-slots]") ||
      line.includes("[extension-view]"),
  );
}

export interface ExtensionLog {
  /** 只看这一刻之后的日志：种子前的首次启动也有一个（没有插件的）扩展进程。 */
  mark(): Promise<void>;
  lines(): Promise<string[]>;
  waitFor(predicate: (line: string) => boolean, message: string, timeout?: number): Promise<string>;
}

export function createExtensionLog(): ExtensionLog {
  let cursor = 0;
  const lines = async () => (await readExtensionLogLines()).slice(cursor);
  return {
    async mark() {
      cursor = (await readExtensionLogLines()).length;
    },
    lines,
    async waitFor(predicate, message, timeout = 30000) {
      let found = "";
      await browser.waitUntil(
        async () => {
          found = (await lines()).find(predicate) ?? "";
          return Boolean(found);
        },
        { timeout, interval: 500, timeoutMsg: message },
      );
      return found;
    },
  };
}

// —— 扩展视图标签页与沙箱页面 ——

export interface ViewPane {
  phase: string | null;
  gen: string | null;
  instance: string | null;
  sandbox: string | null;
  scope: string | null;
  displayed: boolean;
}

export async function readViewPane(viewId: string): Promise<ViewPane | null> {
  return browser.execute(
    (paneTestId, id) => {
      const pane = document.querySelector<HTMLElement>(
        `[data-testid="${paneTestId}"][data-extension-view-id="${id}"]`,
      );
      if (!pane) return null;
      const rect = pane.getBoundingClientRect();
      return {
        phase: pane.dataset.extensionViewPhase ?? null,
        gen: pane.dataset.extensionViewGen ?? null,
        instance: pane.dataset.extensionViewInstance ?? null,
        sandbox: pane.dataset.extensionViewSandbox ?? null,
        scope: pane.dataset.extensionViewScope ?? null,
        displayed: rect.width > 0 && rect.height > 0,
      };
    },
    TID_EXTENSION_VIEW,
    viewId,
  );
}

/** 等待失败时带上最后一次读数与沙箱各 frame 的状态，便于定位页面没跑起来的原因。 */
export async function waitWithEvidence<T>(
  read: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  message: string,
  timeout: number,
  interval: number,
  sandboxOf?: () => Promise<string | null>,
): Promise<T> {
  let latest: T | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await read();
        return Boolean(latest !== null && predicate(latest));
      },
      { timeout, interval },
    );
  } catch {
    const sandboxId = sandboxOf ? await sandboxOf() : null;
    const frames = sandboxId ? await dumpSandboxFrames(sandboxId) : null;
    throw new Error(`${message}: ${JSON.stringify(latest)} frames=${JSON.stringify(frames)}`);
  }
  return latest!;
}

async function sandboxWebContentsId(sandboxId: string): Promise<number> {
  return browser.execute((id) => {
    const webview = Array.from(
      document.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>("webview"),
    ).find((element) => (element.getAttribute("src") ?? "").includes(`/instance/${id}/`));
    try {
      return webview?.getWebContentsId?.() ?? 0;
    } catch {
      return 0;
    }
  }, sandboxId);
}

async function dumpSandboxFrames(sandboxId: string): Promise<unknown> {
  const webContentsId = await sandboxWebContentsId(sandboxId);
  if (!webContentsId) return "no webview";
  return browser.electron.execute(async (electron, id) => {
    const guest = electron.webContents.fromId(id);
    if (!guest || guest.isDestroyed()) return "guest destroyed";
    return Promise.all(
      guest.mainFrame.framesInSubtree.map(async (frame) => ({
        url: frame.url,
        state: await frame
          .executeJavaScript(
            `(async () => ({
              ready: document.readyState,
              zcode: typeof window.zcode,
              text: (document.body?.innerText ?? "").slice(0, 300),
              errors: window.__e2eErrors ?? null,
              scripts: Array.from(document.scripts).map((script) => script.src || "inline"),
              handshake: window.zcode
                ? await Promise.race([
                    window.zcode.ready().then(() => "ready", (error) => "error: " + (error?.message ?? error)),
                    new Promise((resolve) => setTimeout(() => resolve("pending"), 3000)),
                  ])
                : null,
            }))()`,
          )
          .catch((error: unknown) => String(error)),
      })),
    );
  }, webContentsId);
}

export async function waitForViewPane(
  viewId: string,
  predicate: (pane: ViewPane) => boolean,
  message: string,
  timeout = 60000,
): Promise<ViewPane> {
  return waitWithEvidence(
    () => readViewPane(viewId),
    predicate,
    message,
    timeout,
    300,
    async () => (await readViewPane(viewId))?.sandbox ?? null,
  );
}

/** 在沙箱里插件页面（relay shell 内的插件 frame）执行一段表达式，返回其结果。 */
export async function evaluateInViewPage<T>(
  sandboxId: string,
  expression: string,
): Promise<T | null> {
  const webContentsId = await sandboxWebContentsId(sandboxId);
  if (!webContentsId) return null;
  return (await browser.electron.execute(
    async (electron, id, source) => {
      const guest = electron.webContents.fromId(id);
      if (!guest || guest.isDestroyed()) return null;
      const frame = guest.mainFrame.framesInSubtree.find((candidate) =>
        candidate.url.startsWith("zcode-sandbox://plugin-"),
      );
      if (!frame) return null;
      return frame.executeJavaScript(source);
    },
    webContentsId,
    expression,
  )) as T | null;
}

export interface ViewPage {
  dataset: Record<string, string>;
  text: string;
}

export async function readViewPage(sandboxId: string): Promise<ViewPage | null> {
  return evaluateInViewPage<ViewPage>(
    sandboxId,
    `({ dataset: { ...document.body.dataset }, text: document.body.innerText })`,
  );
}

export async function waitForViewPage(
  viewId: string,
  predicate: (page: ViewPage) => boolean,
  message: string,
  timeout = 60000,
): Promise<ViewPage> {
  return waitWithEvidence(
    async () => {
      const pane = await readViewPane(viewId);
      return pane?.sandbox ? readViewPage(pane.sandbox) : null;
    },
    predicate,
    message,
    timeout,
    500,
    async () => (await readViewPane(viewId))?.sandbox ?? null,
  );
}

// —— composer.status 插槽 ——

export interface SlotReading {
  text: string;
  label: string;
}

export async function readSlot(itemId: string): Promise<SlotReading | null> {
  return browser.execute(
    (slotTestId, id) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${slotTestId}"][data-extension-item="${id}"]`,
      );
      return element
        ? { text: element.textContent ?? "", label: element.getAttribute("aria-label") ?? "" }
        : null;
    },
    TID_EXTENSION_COMPOSER_STATUS,
    itemId,
  );
}

export async function waitForSlot(
  itemId: string,
  predicate: (slot: SlotReading) => boolean,
  message: string,
  timeout = 60000,
): Promise<SlotReading> {
  return waitWithEvidence(() => readSlot(itemId), predicate, message, timeout, 200);
}

export async function clickSlot(itemId: string): Promise<void> {
  await browser.execute(
    (slotTestId, id) => {
      document
        .querySelector<HTMLElement>(`[data-testid="${slotTestId}"][data-extension-item="${id}"]`)
        ?.click();
    },
    TID_EXTENSION_COMPOSER_STATUS,
    itemId,
  );
}

// —— 侧栏启动页与标签 ——

/** 命令中心执行「重新加载扩展」（与用户的入口相同）。 */
export async function reloadExtensionsFromCommandCenter(): Promise<void> {
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

/** 关掉右侧面板里当前的标签（视图的 onDidClose 随之触发）。 */
export async function closeActiveSidePaneTab(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-side-pane-tab-id][data-state="active"] button',
        );
        if (!button) return false;
        button.click();
        return true;
      }),
    { timeout: 10000, interval: 200, timeoutMsg: "the active side pane tab should close" },
  );
}

/** 打开侧栏「新标签页」启动页：没有标签时是启动页本身，有标签时点「+」。 */
export async function openLauncher(): Promise<void> {
  await ensureSidePaneEntryVisible();
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const launcherVisible = Array.from(
          document.querySelectorAll<HTMLElement>('[data-side-pane-open-tab-item="browser"]'),
        ).some((element) => element.getBoundingClientRect().width > 0);
        if (launcherVisible) return true;
        document.querySelector<HTMLElement>("[data-side-pane-add-trigger]")?.click();
        return false;
      }),
    { timeout: 15000, interval: 500, timeoutMsg: "side pane launcher should be visible" },
  );
}

/** 点启动页「扩展」分区里的视图条目（`<pluginId>/<itemId>`）。 */
export async function openLauncherView(itemId: string): Promise<void> {
  await openLauncher();
  await browser.waitUntil(
    async () =>
      browser.execute(
        (rowTestId, id) => {
          const row = document.querySelector<HTMLElement>(
            `[data-testid="${rowTestId}"][data-side-pane-open-tab-item="extension-view:${id}"]`,
          );
          if (!row) return false;
          row.scrollIntoView({ block: "center" });
          row.click();
          return true;
        },
        TID_SIDE_PANE_EXTENSION_VIEW_ITEM,
        itemId,
      ),
    { timeout: 30000, interval: 500, timeoutMsg: `launcher should list the view item ${itemId}` },
  );
}

export async function readActiveSidePaneTab(): Promise<string | null> {
  return browser.execute(
    () =>
      document
        .querySelector<HTMLElement>('[data-side-pane-tab-id][data-state="active"]')
        ?.getAttribute("data-side-pane-tab-id") ?? null,
  );
}
