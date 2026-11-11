import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
/* eslint-disable max-lines -- 测试相关的代码，忽略 */
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  isApiKeyAccess,
  type ModelConfig,
  type ProviderConfig,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { ZAI_PROVIDER_ID } from "@zcode/shared";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_V4_SESSION_PANE,
  TID_WORKSPACE_PATH,
} from "@zcode/shared/test-ids";
import type { AppSettings } from "@zcode/shared";
import { collectWindowsE2EProcessTreePids } from "./e2e-process-cleanup.js";
import {
  collectE2EWebDriverPageHandleCandidates,
  type E2EBrowserTargetInfo,
} from "./e2e-window-target.js";
import { dismissOccupationOnboarding } from "./occupation-onboarding.js";
import { sel } from "./selectors.js";
import { projectSectionSelector } from "./project-sidebar.js";

const DEFAULT_E2E_HOME_DIR = resolve(process.cwd(), ".e2e-home");
const E2E_HOME_DIR =
  process.env.ZCODE_E2E_HOME_DIR?.trim() ||
  process.env.ZCODE_DATA_BASE_DIR?.trim() ||
  process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
  // 修复原因：WDIO worker 环境不稳定时，helper 曾回落到真实 HOME，
  // 导致 provider 诊断和清理读写开发者本机配置，而不是当前 e2e sandbox。
  DEFAULT_E2E_HOME_DIR;
// Bug 根因：storage profile 回滚删除了该共享根字段，但多个 E2E 仍需定位 CLI 数据。
// 隔离由测试 HOME 保证，目录名保持生产历史语义 .zcode。
const E2E_STORAGE_ROOT = join(E2E_HOME_DIR, ".zcode");
const E2E_APP_DATA_DIR = join(E2E_STORAGE_ROOT, "v2");
export const DEFAULT_WORKSPACE = join(E2E_HOME_DIR, "ZCodeProject");
export const DEFAULT_CONVERSATION_WORKSPACE = join(E2E_STORAGE_ROOT, "workspace", "default");
const SETTINGS_FILE = join(E2E_APP_DATA_DIR, "setting.json");
const CREDENTIALS_FILE = join(E2E_APP_DATA_DIR, "credentials.json");
const CONFIG_FILE = join(E2E_APP_DATA_DIR, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
const CLI_CONFIG_FILE = join(E2E_STORAGE_ROOT, "cli", "config.json");
const AGENTS_STATE_FILE = join(E2E_APP_DATA_DIR, "agents-state.json");
const REMOVE_APP_DATA_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000];
const REMOVE_APP_DATA_MAX_ATTEMPTS = REMOVE_APP_DATA_RETRY_DELAYS_MS.length;
const E2E_USER_PROFILE = {
  displayName: "ZCode E2E",
  id: "zcode-e2e-user",
  username: "zcode-e2e-user",
};

interface WindowInfo {
  id: number;
  title: string;
  visible: boolean;
  width: number;
  height: number;
  resizable: boolean;
  url: string;
}

export interface CliConfigSnapshot {
  content: string | null;
}

export interface ElectronRendererContentSizeSnapshot {
  height: number;
  windowId: number;
  width: number;
}

/**
 * E2E 从 Personal Config 读取的断言快照。
 *
 * 它只描述测试需要观察的字段，不是 Provider 配置事实源，也不参与运行时装配。
 */
export interface E2EModelProviderSnapshot {
  apiFormat: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  apiKey: string;
  apiKeyRequired?: boolean;
  createdAt: number;
  defaultKind: E2EProviderKind;
  enabled?: boolean;
  endpoints: {
    anthropic?: string;
    baseURL?: string;
    openai?: string;
    paths?: Partial<Record<E2EProviderKind, string>>;
  };
  id: string;
  models: E2EProviderModelSnapshot[];
  name: string;
  source: "custom";
  systemDisabledReason?: string;
  updatedAt: number;
}

export type E2EProviderKind = "anthropic" | "openai" | "openai-compatible";
export type E2EProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface E2EProviderModelSnapshot {
  contextWindow: number;
  defaultMaxOutputTokens?: number;
  defaultKind?: E2EProviderKind;
  deleted?: boolean;
  disabledReason?: string;
  id: string;
  kinds: E2EProviderKind[];
  maxOutputTokens?: number;
  modalities: { input: E2EProviderModality[]; output: E2EProviderModality[] };
  name?: string;
  reasoning?: unknown;
  supportsJsonSchemaOutput?: boolean;
  supportsTools?: boolean;
}

export function createE2EProviderModelSnapshot(params: {
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  defaultKind?: E2EProviderKind;
  id: string;
  kinds?: readonly E2EProviderKind[];
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly E2EProviderModality[];
    output?: readonly E2EProviderModality[];
  };
  supportsJsonSchemaOutput?: boolean;
  supportsTools?: boolean;
}): E2EProviderModelSnapshot {
  return {
    id: params.id,
    kinds: [...new Set(params.kinds ?? [])],
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    contextWindow: params.contextWindow ?? 200_000,
    ...(params.defaultMaxOutputTokens === undefined
      ? {}
      : { defaultMaxOutputTokens: params.defaultMaxOutputTokens }),
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    modalities: {
      input: [...new Set<E2EProviderModality>(params.modalities?.input ?? ["text"])],
      output: [...new Set<E2EProviderModality>(params.modalities?.output ?? ["text"])],
    },
    ...(params.supportsTools === undefined ? {} : { supportsTools: params.supportsTools }),
    ...(params.supportsJsonSchemaOutput === undefined
      ? {}
      : { supportsJsonSchemaOutput: params.supportsJsonSchemaOutput }),
  };
}

export function resolveE2EProviderRuntimeBaseUrl(provider: E2EModelProviderSnapshot): string {
  return provider.endpoints.baseURL?.trim().replace(/\/+$/, "") ?? "";
}

type WorkspaceRendererSwitchResult =
  | { switched: true }
  | {
      switched: false;
      reason: string;
      currentUrl?: string | null;
      handleInspections?: Array<{
        currentHandle: string | null;
        currentUrl: string | null;
        error?: string;
        handle: string;
        targetUrl: string;
      }>;
      handles?: string[];
      target?: E2EBrowserTargetInfo | null;
      targets?: E2EBrowserTargetInfo[];
      windowUrl?: string | null;
      windows?: WindowInfo[];
      error?: string;
    };

async function ensureAppDataDir() {
  await mkdir(E2E_APP_DATA_DIR, { recursive: true });
}

export function readExactTestIdAttribute(testId: string, attributeName: string): string | null {
  // Bug 根因：Windows workspacePath 含反斜杠，直接拼入 CSS selector 会被当成转义字符。
  // 枚举稳定的 data-testid 节点后按属性值比较，同时兼容 Windows 和 macOS 原生路径。
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (item) => item.dataset.testid === testId,
  );
  return element?.getAttribute(attributeName) ?? null;
}

export function dispatchMouseDownByExactTestId(testId: string): boolean {
  // Bug 根因：Skill option id 包含 Windows 绝对路径，反斜杠直接拼入 CSS selector
  // 会被当成转义字符。按属性值比较后派发 mousedown，兼容所有原生路径格式。
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (item) => item.dataset.testid === testId,
  );
  if (!element) {
    return false;
  }
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  return true;
}

async function hasTestId(testId: string) {
  const value = await browser.execute(readExactTestIdAttribute, testId, "data-testid");
  return value === testId;
}

interface DomTestIdOptions {
  timeout?: number;
  timeoutMsg?: string;
}

interface SetInputValueByTestIdDomOptions extends DomTestIdOptions {
  /** 等待异步恢复收口后，重新建立并验证 Lexical 末尾光标。 */
  stabilizeLexicalCaretAtEnd?: boolean;
}

export async function waitForTestIdByDom(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有渲染 test id: ${testId}` }: DomTestIdOptions = {},
) {
  await browser.waitUntil(async () => hasTestId(testId), {
    timeout,
    timeoutMsg,
  });
}

export async function clickTestIdByDom(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可点击的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  // 修复原因：Electron Linux 容器里的 Chromium 会把部分设置页元素排到超大坐标，
  // WebDriver clickable 会误判失败。DOM click 仍触发 React onClick，可专注验证业务逻辑。
  let latestReason = "not-started";
  try {
    await browser.waitUntil(
      async () => {
        const latest = (await browser.execute((currentTestId) => {
          const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid === currentTestId,
          );
          if (!element) {
            return { clicked: false, reason: "missing" };
          }
          const disabled =
            (element instanceof HTMLButtonElement ||
              element instanceof HTMLInputElement ||
              element instanceof HTMLSelectElement ||
              element instanceof HTMLTextAreaElement) &&
            element.disabled;
          if (disabled) {
            return { clicked: false, reason: "disabled" };
          }
          element.click();
          return { clicked: true };
        }, testId)) as { clicked: boolean; reason?: string };
        latestReason = latest.reason ?? "clicked";
        return latest.clicked;
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // 修复原因：React/Radix 控件可能在等待命中后的下一帧重挂载。
    // 等待和点击必须在同一次 DOM 查询内完成，否则偶发 missing 会污染 e2e 认证。
    throw new Error(`${timeoutMsg}: ${latestReason}`, {
      cause: error,
    });
  }
}

export async function clickTestIdByWebDriver(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可点击的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  // Bug 根因：Radix DropdownMenu/Select 的 trigger 依赖 pointerdown 手势，
  // element.click() 只派发 click，测试会误报 portal item 不存在。这里保留真实
  // WebDriver 指针链，只给明确使用此类 trigger 的 case 调用。
  const element = $(sel(testId));
  await element.waitForClickable({ timeout, timeoutMsg });
  await element.click();
}

export async function hoverTestIdByWebDriver(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可悬停的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  const element = $(sel(testId));
  await element.waitForDisplayed({ timeout, timeoutMsg });
  await element.moveTo();
}

export async function setInputValueByTestIdDom(
  testId: string,
  value: string,
  {
    stabilizeLexicalCaretAtEnd = false,
    timeout = 10000,
    timeoutMsg = `页面没有可输入的 test id: ${testId}`,
  }: SetInputValueByTestIdDomOptions = {},
) {
  // 修复原因：同一类容器坐标异常会让输入框无法通过 WebDriver 聚焦。
  // 这里使用原生 value setter 并派发 input/change/blur，继续走页面保存逻辑。
  // M5：v4 composer 恢复为 Lexical contenteditable——写入改走编辑器挂载的
  // __zcodeLexicalInputE2E bridge（驱动真实 editor state，避免 DOM 直改绕过 Lexical）。
  // bridge 由 E2ELexicalInputBridgePlugin 短轮询补挂，可能晚于节点出现，故带重试。
  await waitForTestIdByDom(testId, { timeout, timeoutMsg });
  type SetInputResult = {
    ok: boolean;
    reason?: string;
    tagName?: string | null;
    value?: string;
  };
  let result: SetInputResult = { ok: false, reason: "not-attempted" };
  const attempt = async () => {
    result = (await browser.execute(
      (currentTestId, nextValue) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        if (
          element &&
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement) &&
          (element.isContentEditable || element.hasAttribute("data-e2e-lexical-bridge"))
        ) {
          // 原因：冷恢复时 bridge 已挂载但编辑器仍禁用，越权 setText 会与草稿恢复竞争。
          // 只在真实 DOM 开放输入后写入，不能靠延时或再次写入补偿被覆盖的文字。
          if (!element.isContentEditable) {
            return { ok: false, reason: "not-editable", tagName: element.tagName };
          }
          const bridge = (
            element as HTMLElement & {
              __zcodeLexicalInputE2E?: {
                focus: () => void;
                getText: () => string;
                setText: (text: string) => void;
              };
            }
          ).__zcodeLexicalInputE2E;
          if (!bridge) {
            return {
              ok: false,
              reason: "lexical-bridge-not-ready",
              tagName: element.tagName,
            };
          }
          // Bugfix: Lexical editor.update 在微任务里才 commit，setText 后同步 getText 读到旧值。
          // 这里先读当前值命中即成功，否则写入并标记 pending，交由外层 waitUntil 轮询确认。
          if (bridge.getText() === nextValue) {
            return { ok: true, value: nextValue };
          }
          bridge.focus();
          bridge.setText(nextValue);
          return {
            ok: false,
            reason: "lexical-pending",
            value: bridge.getText(),
          };
        }
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return {
            ok: false,
            reason: "not-input",
            tagName: element?.tagName ?? null,
          };
        }
        if (element.disabled || element.readOnly) {
          return {
            ok: false,
            reason: "not-editable",
            tagName: element.tagName,
          };
        }

        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        element.focus();
        if (descriptor?.set) {
          descriptor.set.call(element, nextValue);
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: nextValue,
            inputType: "insertText",
          }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: element.value === nextValue, value: element.value };
      },
      testId,
      value,
    )) as SetInputResult;
    return result;
  };
  await browser
    .waitUntil(
      async () => {
        const current = await attempt();
        // Bug 根因：点击行内编辑后 React 会把 user row 重挂载；waitForTestId 与
        // execute 之间可能正好处在旧节点卸载、新 Lexical 节点尚未挂载的帧。
        // missing 不是“选择器指向非输入框”的终态，必须和 bridge 初始化一起重试。
        return (
          current.ok ||
          (current.reason !== "not-editable" &&
            current.reason !== "lexical-bridge-not-ready" &&
            current.reason !== "lexical-pending" &&
            !(current.reason === "not-input" && current.tagName === null))
        );
      },
      { timeout, timeoutMsg },
    )
    .catch(() => undefined);

  if (!result.ok) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(result)}`);
  }

  if (stabilizeLexicalCaretAtEnd) {
    // Bug 原因：task 切换时 pane 会先变更 sessionId，Lexical 的草稿恢复和自动
    // 聚焦则在后续 RAF 完成。普通 setText 虽已写入文本，caret 仍可能被迟到
    // 的恢复移到文本前。该选项默认关闭，只让需要跨恢复稳定末尾 caret 的 case 显式启用。
    type LexicalCaretResult = {
      ok: boolean;
      reason?: string;
      text?: string;
    };
    let caretResult: LexicalCaretResult = { ok: false, reason: "not-attempted" };
    try {
      await browser.waitUntil(
        async () => {
          caretResult = (await browser.executeAsync(
            (currentTestId, nextValue, done) => {
              // ConversationComposer 的草稿恢复与聚焦各占一层 RAF；等它们收口后
              // 再用同一 bridge 重放 setText，避免只看到 sessionId 更新就提前写入。
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const element = Array.from(
                    document.querySelectorAll<HTMLElement>("[data-testid]"),
                  ).find((item) => item.dataset.testid === currentTestId) as
                    | (HTMLElement & {
                        __zcodeLexicalInputE2E?: {
                          focus: () => void;
                          getText: () => string;
                          setText: (text: string) => void;
                        };
                      })
                    | undefined;
                  const bridge = element?.__zcodeLexicalInputE2E;
                  if (!element?.isContentEditable || !bridge) {
                    done({ ok: false, reason: "lexical-not-editable" });
                    return;
                  }

                  bridge.setText(nextValue);
                  bridge.focus();
                  requestAnimationFrame(() => {
                    const selection = window.getSelection();
                    const focusNode = selection?.focusNode ?? null;
                    const trailingRange = document.createRange();
                    if (focusNode !== null && element.contains(focusNode) && selection) {
                      trailingRange.setStart(focusNode, selection.focusOffset);
                      trailingRange.setEnd(element, element.childNodes.length);
                    }
                    const text = bridge.getText();
                    const caretAtEnd =
                      focusNode !== null &&
                      element.contains(focusNode) &&
                      selection?.isCollapsed === true &&
                      trailingRange.toString() === "";
                    done({
                      ok: text === nextValue && caretAtEnd,
                      reason:
                        text === nextValue ? "caret-not-at-end" : "text-restored-by-initializer",
                      text,
                    });
                  });
                }),
              );
            },
            testId,
            value,
          )) as LexicalCaretResult;
          return caretResult.ok;
        },
        {
          timeout,
          timeoutMsg: `${timeoutMsg}: Lexical caret 未稳定在文本末尾`,
        },
      );
    } catch (error) {
      throw new Error(`${timeoutMsg}: ${JSON.stringify(caretResult)}`, {
        cause: error,
      });
    }
  }

  await browser.pause(50);
  await browser.execute((currentTestId) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === currentTestId,
    );
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.blur();
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
  }, testId);
}

export function workspaceLabel(workspacePath: string) {
  return basename(workspacePath) || workspacePath;
}

export function getE2EAppDataPaths() {
  return {
    appDataDir: E2E_APP_DATA_DIR,
    configFile: CONFIG_FILE,
    credentialsFile: CREDENTIALS_FILE,
    homeDir: E2E_HOME_DIR,
    storageRoot: E2E_STORAGE_ROOT,
    workspace: DEFAULT_WORKSPACE,
  };
}

/** 行为断言读取解密值；磁盘格式与损坏值断言继续直接读取原始文件。 */
export async function readE2ECredentialValue(key: string): Promise<string | undefined> {
  const record = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as Record<string, string>;
  const value = record[key];
  if (value === undefined) return undefined;
  return createSystemCredentialCipher({ filePath: CREDENTIALS_FILE }).decrypt(value);
}

export async function clearAppData() {
  if (process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP === "1") {
    // 修复原因：普通 spec 的 after hook 先 app.quit 会抢在 ChromeDriver
    // deleteSession 前销毁 browsing context，导致每个 worker 都支付断连超时。
    // WDIO afterSession 会在进程退出后删除 app data，此处只交还关闭所有权。
    return;
  }
  await quitElectronAppGracefully();
  await removeAppDataWithRetry();
}

export async function quitElectronAppGracefully() {
  try {
    const result = (await browser.electron.execute((electron) => {
      if (electron.app.getName() !== "ZCode E2E") {
        return { quit: false, pid: process.pid };
      }
      // 修复原因：clearAppData 常在 spec after 中运行；如果把 app.quit 延迟
      // 投递到下一 tick，长批次下旧 session 的 quit 可能串到下一轮 Electron。
      electron.app.quit();
      return { quit: true, pid: process.pid };
    })) as { quit: boolean; pid: number };

    if (result.quit && result.pid) {
      // Bug 根因：Electron 的 before-quit 最长会等待 9s Host 清理，10s 的
      // 外层等待会在 Main 最后一次 setting 写回前恰好返回。紧接着写入下一个
      // E2E 场景时，旧进程会用上一场景覆盖新 fixture。等待上限必须覆盖
      // Electron 自身的清理窗口，确认进程退出后才交还持久化文件所有权。
      await waitForPidExit(result.pid, 15_000);
    }
  } catch {
    // session already closed or app already gone — safe to continue
  }
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function removeAppDataWithRetry() {
  for (let attempt = 0; attempt <= REMOVE_APP_DATA_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rm(E2E_APP_DATA_DIR, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 500,
      });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === REMOVE_APP_DATA_MAX_ATTEMPTS) {
        if (
          !isRetryableRemoveError(error) ||
          process.env.ZCODE_E2E_STRICT_APP_DATA_CLEANUP === "1"
        ) {
          throw error;
        } else {
          // Bugfix: after hook 的 app 数据清理只负责收尾；Windows 可能短时间保留
          // tasks-index.sqlite 句柄，下一轮 beforeSession 会先杀进程再强制重置 .e2e-home。
          process.stderr.write(
            `[desktop-e2e-cleanup] clearAppData skipped locked app data cleanup: ${formatErrorMessage(error)}\n`,
          );
          return;
        }
      }
      // 修复原因：Windows 上 host/service 进程可能在 Electron 主进程退出后仍短暂持有
      // tasks-index.sqlite 的 WAL/SHM 句柄；删除前先清掉遗留 E2E 进程，避免 after hook
      // 因清理失败把业务 case 误报为失败。
      await cleanupLeftoverE2EProcesses();
      await browser.pause(REMOVE_APP_DATA_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRemoveError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "ENOTEMPTY" || error.code === "EBUSY" || error.code === "EPERM";
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function cleanupLeftoverE2EProcesses() {
  if (process.platform !== "win32") {
    return;
  }

  const pids = listWindowsLeftoverE2EProcessPids();
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 清理是尽力兜底；removeAppDataWithRetry 会继续用错误路径决定是否失败。
    }
  }
  await waitForProcessesExit(pids, 3000);
}

function listWindowsLeftoverE2EProcessPids() {
  try {
    const script = [
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ParentProcessId,CommandLine |",
      "ConvertTo-Json -Compress",
    ].join(" ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return collectWindowsE2EProcessTreePids(output, {
      currentPid: process.pid,
      homeDir: E2E_HOME_DIR,
      runId: process.env.ZCODE_E2E_RUN_ID,
    });
  } catch {
    return [];
  }
}
async function waitForProcessesExit(pids: number[], timeoutMs: number) {
  if (pids.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readSettings(): Promise<Partial<AppSettings>> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf-8")) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

async function readCliConfig(): Promise<Record<string, unknown>> {
  try {
    const json = JSON.parse(await readFile(CLI_CONFIG_FILE, "utf-8")) as unknown;
    return isRecord(json) ? json : {};
  } catch {
    return {};
  }
}

export async function readModelProviders(): Promise<E2EModelProviderSnapshot[]> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    return convertPersonalProviderConfig(await repository.read());
  } catch {
    return [];
  } finally {
    repository.dispose();
  }
}

export async function readAgentsState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(AGENTS_STATE_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function convertPersonalProviderConfig(
  document: ProviderConfigLayerSnapshot,
): E2EModelProviderSnapshot[] {
  return document.providers.entries().map(([providerId, provider]) => {
    const now = Date.now();
    const kind = mapPersonalProviderKind(provider);
    return {
      id: providerId,
      name: document.providers.getRule(providerId)?.providerName?.trim() || providerId,
      endpoints: {
        baseURL: provider.api?.baseUrl?.trim() || "",
        paths: { [kind]: "" },
      },
      apiFormat: provider.api?.type ?? "openai-chat-completions",
      apiKeyRequired: true,
      // 套餐手动 Key 同样是 API Key；仅识别普通类型会把已保存凭据误报为空。
      apiKey: isApiKeyAccess(provider.access) ? provider.access.apiKey?.trim() || "" : "",
      defaultKind: kind,
      models: (provider.personalModelIds ?? []).map((modelId) =>
        convertPersonalModelConfig(
          modelId,
          document.models.resolve({
            providerId,
            modelId,
            apiType: provider.api?.type,
            baseUrl: provider.api?.baseUrl,
          }),
          kind,
        ),
      ),
      source: "custom" as const,
      createdAt: now,
      updatedAt: now,
    };
  });
}

function convertPersonalModelConfig(
  modelId: string,
  model: ModelConfig,
  defaultKind: E2EProviderKind,
) {
  const properties = model.properties;
  const input: E2EProviderModality[] = ["text"];
  if (properties?.inputFormat?.supportsImage) input.push("image");
  if (properties?.inputFormat?.supportsAudio) input.push("audio");
  if (properties?.inputFormat?.supportsPdf) input.push("pdf");
  if (properties?.inputFormat?.supportsVideo) input.push("video");
  return createE2EProviderModelSnapshot({
    id: modelId,
    kinds: [defaultKind],
    defaultKind,
    contextWindow: properties?.contextWindow ?? undefined,
    defaultMaxOutputTokens: model.optionSpecs?.maxOutputTokens?.max ?? undefined,
    maxOutputTokens: model.optionSpecs?.maxOutputTokens?.max ?? undefined,
    modalities: { input, output: ["text"] },
    supportsTools: properties?.supportsToolCall ?? undefined,
    supportsJsonSchemaOutput: properties?.supportsJsonSchemaOutput ?? undefined,
  });
}

function mapPersonalProviderKind(provider: ProviderConfig): E2EProviderKind {
  switch (provider.api?.type) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
    case null:
    case undefined:
      return "openai-compatible";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeRecord(
  current: Record<string, unknown>,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value) ? mergeRecord(existing, value) : value;
  }
  return next;
}

export async function readModelProvider(
  providerId: string,
): Promise<E2EModelProviderSnapshot | null> {
  const providers = await readModelProviders();
  return providers.find((provider) => provider.id === providerId) ?? null;
}

export async function seedSettings(partial: Partial<AppSettings>): Promise<Partial<AppSettings>> {
  const current: Record<string, unknown> = await readSettings();
  // setting.json 的真实界面语言优先存在 uiLocale/uiLocalePreference（旧字段只存中英以兼容降级）。
  // 用例只种旧字段时要清掉上一个用例残留的新字段，否则 app 会按新字段优先读到旧语言。
  if ("locale" in partial && !("uiLocale" in partial)) delete current.uiLocale;
  if ("localePreference" in partial && !("uiLocalePreference" in partial)) {
    delete current.uiLocalePreference;
  }
  const next = { ...current, ...partial };
  await ensureAppDataDir();
  await writeFile(SETTINGS_FILE, JSON.stringify(next), "utf-8");
  return next;
}

type E2ELocale = "zh-CN" | "en-US";
type LocaleTestActions = { getLocale(): E2ELocale; setLocale(locale: E2ELocale): void };

/**
 * 运行中把界面语言固定为 locale，并等 renderer 生效。
 * 首帧跟随宿主系统语言：容器、英文系统下是英文，断言中文文案的 spec 必须自己固定语言。
 * 走真实的 setLocale（写进设置文件）；clearAppData 会清掉它，之后的 case 要重新调用。
 */
export async function pinE2ELocale(locale: E2ELocale): Promise<void> {
  const readLocale = () =>
    browser.execute(
      () =>
        (window as Window & { __testActions?: LocaleTestActions }).__testActions?.getLocale() ??
        null,
    );
  await browser.waitUntil(async () => (await readLocale()) !== null, {
    timeout: 30000,
    timeoutMsg: "renderer 没有注册 __testActions，无法固定界面语言",
  });
  await browser.execute((next) => {
    (window as Window & { __testActions?: LocaleTestActions }).__testActions?.setLocale(next);
  }, locale);
  await browser.waitUntil(async () => (await readLocale()) === locale, {
    timeout: 15000,
    timeoutMsg: `界面语言没有切到 ${locale}`,
  });
}

export async function seedCliConfig(
  partial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const current = await readCliConfig();
  const next = mergeRecord(current, partial);
  await mkdir(dirname(CLI_CONFIG_FILE), { recursive: true });
  await writeFile(CLI_CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function snapshotCliConfig(): Promise<CliConfigSnapshot> {
  try {
    return { content: await readFile(CLI_CONFIG_FILE, "utf-8") };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { content: null };
    }
    throw error;
  }
}

export async function restoreCliConfig(snapshot: CliConfigSnapshot): Promise<void> {
  // 修复原因：seedCliConfig 写的是隔离 HOME 下的 CLI 全局配置；只清 ~/.zcode/v2
  // 会让 WebFetch 临时代理留到同一 E2E session 后续步骤，必须恢复文件级快照。
  if (snapshot.content === null) {
    await rm(CLI_CONFIG_FILE, { force: true });
    return;
  }

  await mkdir(dirname(CLI_CONFIG_FILE), { recursive: true });
  await writeFile(CLI_CONFIG_FILE, snapshot.content, "utf-8");
}

/** 仅用于旧 Electron 已退出后的 fixture 注入；删除指定测试凭据，保留登录与其他键。 */
export async function removeSeededCredentials(keys: string[]): Promise<void> {
  const credentials = JSON.parse(await readFile(CREDENTIALS_FILE, "utf-8")) as Record<
    string,
    string
  >;
  for (const key of keys) delete credentials[key];
  await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials), "utf-8");
}

export async function seedCredentials(authToken = "mock-token") {
  await ensureAppDataDir();
  // Bugfix: 登录恢复已经迁移到 OAuth 命名空间；只写旧 auth_token
  // 会让 e2e 在欢迎页等待 workspace，录制 provider 流之前就失败。
  await writeFile(
    CREDENTIALS_FILE,
    JSON.stringify(
      {
        auth_token: authToken,
        "oauth:active_provider": ZAI_PROVIDER_ID,
        [`oauth:${ZAI_PROVIDER_ID}:access_token`]: authToken,
        [`oauth:${ZAI_PROVIDER_ID}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
        zcodejwttoken: authToken,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export interface WorkspaceAppProbeParams {
  workspacePathTestId: string;
  workspaceItemTestId: string;
  sessionPanePrefix: string;
  composerWorkspaceTriggerTestId: string;
  expectedPath: string;
}

// 在 renderer 内执行（browser.execute 序列化），不能引用模块作用域变量。
export function probeWorkspaceAppState(
  params: WorkspaceAppProbeParams,
): "ready" | "onboarding" | "pending" {
  // 修复原因：职业引导在“无作答记录且本机无 Task”时自动展示，E2E 每个 worker 都是
  // 全新隔离 HOME，必然命中；引导判定完成前 Root 不渲染主界面、展示时整页替换主界面，
  // 两者互斥，所以这里如实上报 onboarding，由调用方走真实 UI 关闭后继续等待工作区。
  if (document.querySelector('[data-testid="onboarding-page"]')) {
    return "onboarding";
  }

  const pathBadge = document.querySelector<HTMLElement>(
    `[data-testid="${params.workspacePathTestId}"]`,
  );
  if (pathBadge?.dataset.workspaceAbsPath === params.expectedPath) {
    return "ready";
  }

  // 修复原因：API Key 登录后进入空任务态时，主区域只展示新任务草稿，
  // 不一定渲染 WorkspaceHeader 的路径徽标。此时侧栏工作区项和会话 pane
  // 同时存在，才代表用户已经进入可操作的目标工作区。
  // 修复原因：Windows workspacePath 会进入 data-testid，反斜杠直接拼到
  // CSS attribute selector 会被当作转义字符，导致 DOM 里有元素也查不到。
  const workspaceItem =
    (
      window as Window & {
        __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
      }
    ).__zcodeTabStoreE2E?.getState().activeWorkspacePath === params.expectedPath;
  const conversationWorkspaceReady =
    params.expectedPath.replace(/\\/g, "/").endsWith("/.zcode/workspace/default") &&
    Boolean(document.querySelector(`[data-testid="${params.composerWorkspaceTriggerTestId}"]`));
  // v4 硬切后聊天区是 v4 session pane（testid 带 paneId 后缀，用前缀匹配）。
  return (workspaceItem || conversationWorkspaceReady) &&
    document.querySelector(`[data-testid^="${params.sessionPanePrefix}-"]`)
    ? "ready"
    : "pending";
}

// Bugfix: WorkspaceHeader 里的 TID_WORKSPACE_TITLE 现在展示的是 activeTaskTitle，
// 不再稳定代表当前工作区名。路径徽标的上下文改由 tooltip 承载，改读 data-workspace-abs-path。
// 虚拟项目侧栏不再渲染真实目录节点，新建任务草稿下以 tab store 的导航 owner + 可见
// session pane 判定，覆盖默认工作区自动打开及多标签切换。
export async function waitForWorkspaceApp(workspacePath: string, timeout = 10000) {
  const timeoutMsg = `主界面没有切到工作区: ${workspacePath}`;
  const probeParams: WorkspaceAppProbeParams = {
    workspacePathTestId: TID_WORKSPACE_PATH,
    workspaceItemTestId: "virtual-project-row",
    sessionPanePrefix: TID_V4_SESSION_PANE,
    composerWorkspaceTriggerTestId: TID_COMPOSER_WORKSPACE_TRIGGER,
    expectedPath: workspacePath,
  };

  try {
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(probeWorkspaceAppState, probeParams);
        if (state === "onboarding") {
          // Bug 根因：此前只有 v4 helper 先跳过引导，conversation-session、automations、
          // smoke 等走本函数的 spec 会被引导页挡满 30s 后失败。关闭后由下一轮轮询确认工作区。
          await dismissOccupationOnboarding();
          return false;
        }
        return state === "ready";
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // 修复原因：e2e 曾经只报等待超时，真实白屏原因藏在 renderer 状态里。
    // 失败时附带当前 DOM、窗口和存储摘要，后续 case 卡住能直接定位初始化边界。
    throw new Error(`${timeoutMsg}\n${await collectWorkspaceDiagnostics(workspacePath)}`, {
      cause: error,
    });
  }
}

async function isWorkspaceAppVisible(workspacePath: string) {
  try {
    return await browser.execute(
      (workspacePathTestId, sessionPanePrefix, expectedPath) => {
        if (
          (
            window as Window & {
              __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
            }
          ).__zcodeTabStoreE2E?.getState().activeWorkspacePath === expectedPath &&
          document.querySelector(`[data-testid^="${sessionPanePrefix}-"]`)
        )
          return true;
        const pathBadge = document.querySelector<HTMLElement>(
          `[data-testid="${workspacePathTestId}"]`,
        );
        return pathBadge?.dataset.workspaceAbsPath === expectedPath;
      },
      TID_WORKSPACE_PATH,
      TID_V4_SESSION_PANE,
      workspacePath,
    );
  } catch {
    // Bugfix: browser.reloadSession 后 WebDriver/CDP 会短暂断链；workspace
    // 等待应把这类“还没连上”当作未就绪，而不是提前失败。
    return false;
  }
}

export async function getActiveWorkspacePath() {
  return browser.execute((workspacePathTestId) => {
    const pathBadge = document.querySelector<HTMLElement>(`[data-testid="${workspacePathTestId}"]`);
    return pathBadge?.dataset.workspaceAbsPath ?? null;
  }, TID_WORKSPACE_PATH);
}

async function collectWorkspaceDiagnostics(expectedPath: string) {
  const projectSelector = projectSectionSelector(expectedPath);
  const windows = await getAllWindowInfo().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const targets = await getBrowserTargetInfo().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const dom = await browser
    .execute(
      (workspacePathTestId, projectSectionSelectorValue) => {
        const pathBadge = document.querySelector<HTMLElement>(
          `[data-testid="${workspacePathTestId}"]`,
        );
        const projectSection = document.querySelector(projectSectionSelectorValue);
        let localStorageKeys: string[] | { error: string };
        try {
          localStorageKeys = Object.keys(window.localStorage).sort();
        } catch (error) {
          localStorageKeys = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
          readyState: document.readyState,
          testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
            .slice(0, 80)
            .map((element) => element.dataset.testid ?? ""),
          title: document.title,
          url: window.location.href,
          projectRowExists: Boolean(projectSection),
          workspaceAbsPath: pathBadge?.dataset.workspaceAbsPath ?? null,
          localStorageKeys,
        };
      },
      TID_WORKSPACE_PATH,
      projectSelector,
    )
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

  return `诊断: ${JSON.stringify({ expectedPath, windows, targets, dom }, null, 2)}`;
}

export async function waitForDefaultWorkspaceReady(timeout = 10000) {
  await browser.waitUntil(
    async () => {
      try {
        await access(DEFAULT_WORKSPACE);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout,
      timeoutMsg: `默认工作区没有自动创建: ${DEFAULT_WORKSPACE}`,
    },
  );

  if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
    // 修复原因：browser.reloadSession 后 renderer 已经可操作，但 Electron bridge
    // 偶发仍处在重连窗口；此时继续依赖 BrowserWindow 列表会误报“主窗口没有出现”。
    return;
  }

  await browser.waitUntil(
    async () => {
      // Bug 根因：reloadSession 后 renderer DOM 往往先于 Electron service bridge
      // 恢复。旧实现进入这一轮等待后只轮询 BrowserWindow，哪怕页面随后已经可操作，
      // 也会一直等满超时并误报“主窗口没有出现”。两条就绪链路必须并行收敛。
      if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
        return true;
      }
      try {
        const windows = await getAllWindowInfo();
        return windows.length >= 1;
      } catch {
        return false;
      }
    },
    {
      interval: 250,
      timeout,
      timeoutMsg: "主窗口没有出现",
    },
  );

  if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
    return;
  }

  await switchToWorkspaceRendererWindow(DEFAULT_WORKSPACE, timeout);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, timeout);
}

export async function getAllWindowInfo(): Promise<WindowInfo[]> {
  return browser.electron.execute((electron) => {
    return electron.BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => ({
        id: win.id,
        title: win.getTitle(),
        visible: win.isVisible(),
        width: win.getBounds().width,
        height: win.getBounds().height,
        resizable: win.isResizable(),
        url: win.webContents.getURL(),
      }));
  });
}

export async function setCurrentElectronRendererContentSize(
  width: number,
  height?: number,
): Promise<ElectronRendererContentSizeSnapshot> {
  const currentUrl = await browser.getUrl();
  const result = await browser.electron.execute(
    (electron, targetUrl, nextWidth, nextHeight) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === targetUrl,
      );
      if (!target) {
        return {
          ok: false as const,
          candidateUrls: electron.BrowserWindow.getAllWindows()
            .filter((candidate) => !candidate.isDestroyed())
            .map((candidate) => candidate.webContents.getURL()),
        };
      }

      const [originalWidth = 0, originalHeight = 0] = target.getContentSize();
      // 修复原因：ChromeDriver 的 window/rect 会调用 Electron 未实现的
      // Browser.getWindowForTarget；E2E 必须通过 Electron 权威窗口 API 调整 client viewport。
      target.setContentSize(nextWidth, nextHeight ?? originalHeight);
      target.focus();
      const [appliedWidth = 0, appliedHeight = 0] = target.getContentSize();
      return {
        ok: true as const,
        appliedHeight,
        appliedWidth,
        zoomFactor: target.webContents.getZoomFactor(),
        snapshot: {
          height: originalHeight,
          windowId: target.id,
          width: originalWidth,
        },
      };
    },
    currentUrl,
    width,
    height,
  );

  if (!result.ok) {
    throw new Error(
      `当前 WebDriver URL 没有精确匹配 Electron renderer 窗口: ${currentUrl}; candidates=${JSON.stringify(result.candidateUrls)}`,
    );
  }
  if (
    Math.abs(result.appliedWidth - width) > 1 ||
    (height !== undefined && Math.abs(result.appliedHeight - height) > 1)
  ) {
    await restoreElectronRendererContentSize(result.snapshot);
    throw new Error(
      `Electron renderer content size 没有应用: requested=${width}x${height ?? "preserve"}; applied=${result.appliedWidth}x${result.appliedHeight}`,
    );
  }

  const expectedRendererWidth = Math.round(result.appliedWidth / result.zoomFactor);
  const expectedRendererHeight = Math.round(result.appliedHeight / result.zoomFactor);
  let latestRendererViewport: { height: number; width: number } | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestRendererViewport = await browser.execute(() => ({
          height: window.innerHeight,
          width: window.innerWidth,
        }));
        return (
          Math.abs(latestRendererViewport.width - expectedRendererWidth) <= 1 &&
          (height === undefined ||
            Math.abs(latestRendererViewport.height - expectedRendererHeight) <= 1)
        );
      },
      {
        timeout: 10000,
        timeoutMsg: `renderer viewport 没有收敛到 ${expectedRendererWidth}x${height === undefined ? "preserve" : expectedRendererHeight}`,
      },
    );
  } catch (error) {
    await restoreElectronRendererContentSize(result.snapshot);
    throw new Error(
      `renderer viewport 没有收敛: expected=${expectedRendererWidth}x${height === undefined ? "preserve" : expectedRendererHeight}; actual=${JSON.stringify(latestRendererViewport)}; zoomFactor=${result.zoomFactor}`,
      { cause: error },
    );
  }

  return result.snapshot;
}

export async function restoreElectronRendererContentSize(
  snapshot: ElectronRendererContentSizeSnapshot,
): Promise<void> {
  const result = await browser.electron.execute((electron, original) => {
    const target = electron.BrowserWindow.fromId(original.windowId);
    if (!target || target.isDestroyed()) {
      return { ok: true as const, windowMissing: true as const };
    }
    target.setContentSize(original.width, original.height);
    const [restoredWidth = 0, restoredHeight = 0] = target.getContentSize();
    return {
      ok:
        Math.abs(restoredWidth - original.width) <= 1 &&
        Math.abs(restoredHeight - original.height) <= 1,
      restoredHeight,
      restoredWidth,
      windowMissing: false as const,
    };
  }, snapshot);

  if (!result.ok) {
    throw new Error(
      `Electron renderer content size 恢复失败: expected=${snapshot.width}x${snapshot.height}; actual=${result.restoredWidth}x${result.restoredHeight}`,
    );
  }
}

export async function switchToWorkspaceRendererWindow(workspacePath: string, timeout = 10000) {
  let latestResult: WorkspaceRendererSwitchResult = {
    switched: false,
    reason: "not-started",
  };

  try {
    // 修复原因：Electron 启动初期 BrowserWindow 已创建，但 Chromedriver 看到的
    // WebDriver handle / CDP target 可能仍是 chrome-error 过渡页。这里按真实
    // BrowserWindow URL 重试切换，避免 conversation e2e 在错误 renderer 上找欢迎页。
    await browser.waitUntil(
      async () => {
        latestResult = await trySwitchToWorkspaceRendererWindow(workspacePath);
        return latestResult.switched;
      },
      {
        interval: 250,
        timeout,
        timeoutMsg: `未找到可切换的工作区 renderer target: ${workspacePath}`,
      },
    );
  } catch (error) {
    throw new Error(
      `未找到可切换的工作区 renderer target: ${workspacePath}\n诊断: ${JSON.stringify(
        latestResult,
        null,
        2,
      )}`,
      {
        cause: error,
      },
    );
  }
}

async function trySwitchToWorkspaceRendererWindow(
  workspacePath: string,
): Promise<WorkspaceRendererSwitchResult> {
  const windows = await getAllWindowInfo().catch((error: unknown) => ({
    error: serializeError(error),
  }));
  if (!Array.isArray(windows)) {
    return {
      switched: false,
      reason: "window-info-failed",
      error: windows.error,
    };
  }
  const windowUrl =
    windows.find((win) => isWorkspaceRendererUrl(win.url, workspacePath))?.url ??
    windows.find((win) => isRendererUrl(win.url))?.url ??
    null;

  if (!windowUrl) {
    return {
      switched: false,
      reason: "missing-renderer-window-url",
      windows,
    };
  }

  const targets = await getBrowserTargetInfo().catch(() => []);
  const handles = await browser.getWindowHandles().catch(() => []);
  const target =
    targets.find((item) => item.id && isExpectedRendererUrl(item.url, windowUrl, workspacePath)) ??
    null;
  const candidates = collectE2EWebDriverPageHandleCandidates(handles, targets).sort(
    (left, right) =>
      Number(isExpectedRendererUrl(right.targetUrl, windowUrl, workspacePath)) -
      Number(isExpectedRendererUrl(left.targetUrl, windowUrl, workspacePath)),
  );

  if (candidates.length === 0) {
    return {
      switched: false,
      reason: target?.id ? "renderer-target-not-in-webdriver-handles" : "missing-renderer-target",
      currentUrl: await getCurrentRendererUrl().catch(() => null),
      handles,
      target,
      targets,
      windowUrl,
      windows,
    };
  }

  const handleInspections: NonNullable<
    Exclude<WorkspaceRendererSwitchResult, { switched: true }>["handleInspections"]
  > = [];
  for (const candidate of candidates) {
    try {
      await browser.switchToWindow(candidate.handle);
      const currentHandle = await browser.getWindowHandle().catch(() => null);
      const currentUrl = await getCurrentRendererUrl().catch(() => null);
      handleInspections.push({
        currentHandle,
        currentUrl,
        handle: candidate.handle,
        targetUrl: candidate.targetUrl,
      });
      if (
        currentHandle === candidate.handle &&
        typeof currentUrl === "string" &&
        isExpectedRendererUrl(currentUrl, windowUrl, workspacePath)
      ) {
        setElectronWindowHandle(candidate.handle);
        return { switched: true };
      }
    } catch (error) {
      handleInspections.push({
        currentHandle: null,
        currentUrl: null,
        error: serializeError(error),
        handle: candidate.handle,
        targetUrl: candidate.targetUrl,
      });
    }
  }

  return {
    switched: false,
    reason: "webdriver-page-handle-url-mismatch",
    currentUrl: handleInspections.at(-1)?.currentUrl ?? null,
    handleInspections,
    handles,
    target,
    targets,
    windowUrl,
    windows,
  };
}

async function switchToHandle(handle: string) {
  await browser.switchToWindow(handle);
  setElectronWindowHandle(handle);
}

function setElectronWindowHandle(handle: string) {
  (browser.electron as typeof browser.electron & { windowHandle?: string }).windowHandle = handle;
}

async function getBrowserTargetInfo(): Promise<E2EBrowserTargetInfo[]> {
  const puppeteer = await browser.getPuppeteer();
  return puppeteer.targets().map((target) => ({
    id: (target as unknown as { _targetId?: string })._targetId ?? null,
    type: target.type(),
    url: target.url(),
  }));
}

async function getCurrentRendererUrl() {
  return browser.execute(() => window.location.href);
}

function serializeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedRendererUrl(currentUrl: string, windowUrl: string, workspacePath: string) {
  return currentUrl === windowUrl || isWorkspaceRendererUrl(currentUrl, workspacePath);
}

function isRendererUrl(url: string) {
  try {
    // 修复原因：E2E 会把 out 复制到 runId/app，renderer 身份不能再绑定共享 out 路径。
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

function isWorkspaceRendererUrl(url: string, workspacePath: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.endsWith("/renderer/index.html") &&
      parsed.searchParams.get("initialWorkspacePath") === workspacePath
    );
  } catch {
    return false;
  }
}

export async function switchToNewestWindow() {
  const handles = await browser.getWindowHandles();
  const newestHandle = handles.at(-1);

  if (!newestHandle) {
    throw new Error("当前没有可切换的窗口句柄");
  }

  await switchToHandle(newestHandle);
}

export async function clickAboutMenuItem() {
  await browser.electron.execute((electron) => {
    const menu = electron.Menu.getApplicationMenu();
    const topMenuLabel = process.platform === "darwin" ? electron.app.name : "Help";
    const topMenu = menu?.items.find((item) => item.label === topMenuLabel);
    const menuItem = topMenu?.submenu?.items.find((item) => item.label === "About ZCode");

    if (!menuItem) {
      throw new Error(`未找到 About ZCode 菜单项: ${topMenuLabel}`);
    }

    menuItem.click(undefined as never, undefined, undefined as never);
  });
}

export async function clickDockMenuItem(itemLabel: string) {
  await browser.electron.execute((electron, itemLabel) => {
    const menu = electron.app.dock?.getMenu();
    const menuItem = menu?.items.find((item) => item.label === itemLabel);
    menuItem?.click(undefined as never, undefined, undefined as never);
  }, itemLabel);
}

export async function getDockMenuLabels(): Promise<string[]> {
  return browser.electron.execute((electron) => {
    return (
      electron.app.dock
        ?.getMenu()
        ?.items.map((item) => item.label)
        .filter((label): label is string => Boolean(label)) ?? []
    );
  });
}

export async function clearRecentDocuments() {
  await browser.electron.execute((electron) => {
    if (process.platform === "darwin" || process.platform === "win32") {
      electron.app.clearRecentDocuments();
    }
  });
}

export async function getRecentDocuments(): Promise<string[]> {
  return browser.electron.execute((electron) => {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return [];
    }

    return electron.app.getRecentDocuments();
  });
}

export async function minimizePrimaryWindow() {
  await browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    win?.minimize();
  });
}

export async function isPrimaryWindowMinimized(): Promise<boolean> {
  return browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    return win?.isMinimized() ?? false;
  });
}

export async function getTabLabels(): Promise<string[]> {
  return browser.execute(() => {
    // 虚拟项目侧栏：项目行的 data-project-name 就是旧 workspace 标签名（目录 basename）。
    const projectSections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-project-id][data-project-name]"),
    );
    if (projectSections.length > 0) {
      return projectSections
        .map((node) => node.getAttribute("data-project-name")?.trim() ?? "")
        .filter(Boolean);
    }

    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='tab-item-'] span"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}
