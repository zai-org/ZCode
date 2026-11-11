import { selectCombinedComposerThoughtLevel } from "./composer-model-picker.js";
/* eslint-disable max-lines -- v4 conversation e2e helper 集中承载 pane/composer/queue/分屏等全部定位与断言原语，拆分会让 spec 的导入面漂移。 */
// v4 竖切（protocol-v4）conversation e2e helper。
// 与旧 conversation-session.ts 的区别：所有定位走 TID_V4_* 常量（testid contract v2，
// 带 paneId 维度），状态断言读 v4 pane 的 data-* 投影属性，不再依赖旧 ChatView DOM。
// 旧 helper 的登录/工作区/provider 部分继续复用（desktop-app.ts / upstream-provider.ts）。
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_SUMMARY_PANEL,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_ITEM,
  TID_TASK_NEW_BUTTON,
  TID_V4_AUTODRAIN_TOGGLE,
  TID_V4_ATTACHMENT,
  TID_V4_BACKGROUND_WORK_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_EDIT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY,
  TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
  TID_V4_FOLLOWUP_TOGGLE,
  TID_V4_MODEL_CONFIG,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_PANE_SHELL,
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  TID_V4_SESSION_PANE,
  TID_V4_SESSION_TITLE,
  TID_V4_STOP,
  TID_V4_TIMELINE,
  TID_V4_TIMELINE_BOTTOM,
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  dispatchMouseDownByExactTestId,
  setCurrentElectronRendererContentSize,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "./desktop-app.js";
import {
  ensureUpstreamProviderForE2E,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "./upstream-provider.js";
import { readV4ChatRootSnapshotInBrowser } from "./conversation-session-chat-root-snapshot-script.js";
import { getTaskStoreSnapshot as readTaskStoreSnapshotForDiagnostics } from "./conversation-session-store.js";
import { consumeDraftRegenerationResend } from "#e2e/helpers/draft-regeneration-resend";
import { sel } from "./selectors.js";
import { skipOccupationOnboardingIfPresent } from "./occupation-onboarding.js";
import { startDraftFromProject, waitForProjectRow } from "#e2e/helpers/project-sidebar";
import { openLatestV4UserQueryEditInComposer } from "./v4-composer-edit.js";

export const LOGIN_API_KEY = "e2e-login-api-key";
export const E2E_REPLY_TOKEN = "upstream-e2e-ok";

/** 经真实附件菜单打开文件 input，再让 WebDriver 注入有磁盘路径的 File。 */
export async function pickV4ComposerFiles(paths: string[]) {
  const inputSelector = `[data-testid="${TID_V4_COMPOSER}"] input[type="file"]`;
  await browser.waitUntil(
    () => browser.execute((selector) => Boolean(document.querySelector(selector)), inputSelector),
    { timeout: 15_000, timeoutMsg: "v4 Composer 文件 input 没有出现" },
  );
  await browser.execute((selector) => {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error("v4 Composer 文件 input 不存在");
    // Bug 根因：native picker 不属于页面 DOM，E2E 无法用真实文件路径通过 WebDriver 选择。
    // 临时显示 input 供 WebDriver 设置磁盘文件，仍让 Chromium 创建带本机路径的 File。
    input.classList.remove("hidden");
    input.style.position = "fixed";
    input.style.left = "0";
    input.style.top = "0";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.opacity = "0";
    input.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
  }, inputSelector);
  const trigger = await $(`[data-testid="${TID_CHAT_ATTACHMENT_BUTTON}"]`);
  await trigger.waitForClickable({ timeout: 15_000 });
  await trigger.click();
  const menuItem = await $(`[data-testid="${TID_CHAT_ATTACHMENT_MENU_ITEM}"]`);
  await menuItem.waitForClickable({ timeout: 10_000 });
  await menuItem.click();
  await $(inputSelector).setValue(paths.join("\n"));
}

interface PrepareV4ConversationE2EOptions {
  resetDraftBeforeProvider?: boolean;
  skipProvider?: boolean;
  /** 跳过 ensureV4ShellReady 的 ZCodeProject 等待。已登录冷启（真实凭据 seed 后 reloadSession）
   * 的 app 按 startupWorkspace 语义落在 conversation backing workspace，ZCodeProject 永远不出现；
   * 调用方需自行等待 v4 shell 就绪（如侧栏新任务按钮）。见 ANALYSIS r3-rerun §46。 */
  skipShellReady?: boolean;
}

/** 单 pane 竖切固定 paneId（V4ChatPane 写死 workspace-main）。 */
export const V4_MAIN_PANE_ID = "workspace-main";

export interface V4PaneSnapshot {
  /** data-session-id；draft 表示未绑定 CLI session。 */
  sessionId: string | null;
  initialDraftProvider: string;
  initialDraftModel: string;
  /** stop 按钮是否存在（= projection.control.canStop）。 */
  canStop: boolean;
  /** timeline 全部行文本（虚拟滚动下为当前渲染窗口内的行）。 */
  timelineText: string;
  rowCount: number;
}

export interface V4CompactMarkerSnapshot {
  origin: string | null;
  rowId: number | null;
  status: string | null;
  text: string;
}

export interface V4ConversationStateSnapshot {
  activeInputId: string | null;
  modelSwitchPending: boolean;
  queueCount: number;
  runtimeStatus: string | null;
  sessionId: string | null;
  state: string | null;
  stopRequested: boolean;
  targetId: string | null;
  targetObjective: string | null;
  targetStatus: string | null;
  taskId: string | null;
}

export interface V4MessageSnapshot {
  id: string | null;
  role: "assistant" | "user";
  text: string;
}

export async function prepareV4ConversationE2E(options: PrepareV4ConversationE2EOptions = {}) {
  if (!options.skipShellReady) {
    await ensureV4ShellReady();
  }
  if (!options.skipShellReady || options.resetDraftBeforeProvider) {
    // Provider helper 也校验固定 cwd，必须先返回夹具项目，且不能把模型写入上一条会话。
    await ensureV4PreparationDraft(options);
  }
  if (!options.skipProvider) {
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  }
  await ensureV4PreparationDraft(options);
  if (!options.skipShellReady) {
    await waitForDefaultWorkspaceReady(30000);
  }
  if (!options.skipProvider) {
    // 新 Composer 会保留已经初始化的空选择。仅写 Recent 不能覆盖这个草稿；
    // 测试准备必须像用户一样选择目标模型和档位，不能依赖旧初始化副作用。
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
  }
  if (!options.skipShellReady) {
    await waitForV4WorkspacePresentationReady();
  }
}

/**
 * 等待 workspace presentation（slash 目录）写入 renderer store。
 *
 * 修复原因：全新 HOME 下 agent 首次 readPresentation 会同步 seed 官方插件缓存（约 97MB），
 * 阻塞 agent 事件循环 10-17s，期间首条 session/create 只能排队，首发 ACK 晚于 composer
 * 清空断言的等待时间。presentation 是该次 seed 的唯一完成事实；准备阶段先等它，
 * 让用例只验证自身语义。产品侧的冷启动耗时另见
 * docs/issues/official-plugin-seed/01-sync-seed-blocks-cli-event-loop.md。
 */
export async function waitForV4WorkspacePresentationReady(
  workspacePath: string = DEFAULT_WORKSPACE,
  timeout = 60_000,
) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (targetPath, caseInsensitive) => {
          const workspaces = (
            window as Window & {
              __zcodeSessionStoreE2E?: {
                getState(): { workspaces: Record<string, { slashCommands?: unknown[] }> };
              };
            }
          ).__zcodeSessionStoreE2E?.getState().workspaces;
          // Windows 路径大小写不敏感，store key 可能与夹具路径的盘符/目录大小写不同。
          const normalize = (path: string) => (caseInsensitive ? path.toLowerCase() : path);
          return Object.entries(workspaces ?? {}).some(
            ([key, workspace]) =>
              normalize(key) === normalize(targetPath) &&
              (workspace.slashCommands?.length ?? 0) > 0,
          );
        },
        workspacePath,
        process.platform === "win32",
      ),
    {
      timeout,
      timeoutMsg: `workspace presentation 没有就绪（slash 目录为空）: ${workspacePath}`,
    },
  );
}

async function ensureV4ShellReady() {
  try {
    // 新隔离 profile 的职业引导会遮住工作区，先复用真实 UI 跳过流程。
    await skipOccupationOnboardingIfPresent();
    await waitForProjectRow(DEFAULT_WORKSPACE, { timeout: 30000 });
    return;
  } catch (error) {
    if (!(await hasApiKeyLoginButton())) {
      throw error;
    }
    await loginWithApiKey();
    await skipOccupationOnboardingIfPresent();
    await waitForProjectRow(DEFAULT_WORKSPACE, { timeout: 30000 });
  }
}

async function ensureV4PreparationDraft(options: PrepareV4ConversationE2EOptions) {
  // Bug 根因：全局新建会创建独立 cwd；反复点击会让固定目录夹具与 Agent 工作区分离。
  // 只按实际 cwd 复用空草稿；为补项目标签而新建会打断冷启动预热，导致首发失败。
  // 其他 cwd 或已有内容才走项目级新建；显式全局新建 helper 保持原语义。
  const ready = await browser.execute(
    (inputId, paneId, stopId, workspacePath) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneId}"]`);
      const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputId}"]`);
      const activePath = (
        window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
        }
      ).__zcodeTabStoreE2E?.getState().activeWorkspacePath;
      return Boolean(
        pane?.dataset.sessionId === "draft" &&
        input?.getClientRects().length &&
        !input.textContent?.trim() &&
        !pane.querySelector(`[data-testid="${stopId}"]`) &&
        (!workspacePath || activePath === workspacePath),
      );
    },
    TID_V4_COMPOSER_INPUT,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_STOP,
    options.skipShellReady ? null : DEFAULT_WORKSPACE,
  );
  if (ready) return;
  if (options.skipShellReady) {
    await startNewV4Draft();
  } else {
    await startDraftFromProject(DEFAULT_WORKSPACE);
  }
}

async function hasApiKeyLoginButton() {
  const exists = await browser
    .execute(
      (currentTestId) => Boolean(document.querySelector(`[data-testid="${currentTestId}"]`)),
      TID_LOGIN_USE_API_KEY_BUTTON,
    )
    .catch(() => false);
  return Boolean(exists);
}

export async function loginWithApiKey() {
  await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
    timeout: 30000,
    timeoutMsg: "欢迎页没有出现 API Key 登录入口",
  });
  await setInputValueByTestIdDom(TID_LOGIN_API_KEY_INPUT, LOGIN_API_KEY, {
    timeout: 15000,
    timeoutMsg: "API Key 登录输入框没有出现",
  });
  await browser.waitUntil(
    async () =>
      browser.execute((continueButtonTestId) => {
        const button = document.querySelector<HTMLElement>(
          `[data-testid="${continueButtonTestId}"]`,
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      }, TID_LOGIN_API_KEY_CONTINUE_BUTTON),
    {
      timeout: 15000,
      timeoutMsg: "API Key 登录继续按钮没有变为可用",
    },
  );
  await clickTestIdByDom(TID_LOGIN_API_KEY_CONTINUE_BUTTON, {
    timeout: 15000,
    timeoutMsg: "API Key 登录继续按钮没有出现或不可点击",
  });
}

/** 新建草稿：点侧栏新任务按钮，等 v4 pane 回到 draft 态。 */
export async function startNewV4Draft() {
  await clickTestIdByDom(TID_TASK_NEW_BUTTON, {
    timeout: 15000,
    timeoutMsg: "侧栏新任务按钮没有出现或不可点击",
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft",
    "新建任务后 v4 pane 没有回到 draft 态",
  );
}

export function getV4PaneSnapshot(paneId: string = V4_MAIN_PANE_ID): Promise<V4PaneSnapshot> {
  return browser.execute(
    (paneTestId, stopTestId, timelineTestId, rowPrefix) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return {
        sessionId: pane?.getAttribute("data-session-id") ?? null,
        initialDraftProvider: pane?.getAttribute("data-initial-draft-provider") ?? "",
        initialDraftModel: pane?.getAttribute("data-initial-draft-model") ?? "",
        canStop: Boolean(pane?.querySelector(`[data-testid="${stopTestId}"]`)),
        timelineText: (timeline?.innerText ?? "").replace(/ /g, " "),
        rowCount: pane?.querySelectorAll(`[data-testid^="${rowPrefix}-"]`).length ?? 0,
      };
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_STOP,
    TID_V4_TIMELINE,
    TID_V4_ROW,
  );
}

export async function waitForV4Pane(
  predicate: (snapshot: V4PaneSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
  paneId: string = V4_MAIN_PANE_ID,
) {
  let latest: V4PaneSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4PaneSnapshot(paneId);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4PaneSnapshot(paneId);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  // 原因：会话切换时 pane 可能短暂经过 draft。waitUntil 已命中目标快照后若再读一次 DOM，
  // 调用方拿到的可能反而是下一帧过渡态，造成“条件通过但返回值不满足条件”的假失败。
  return latest ?? getV4PaneSnapshot(paneId);
}

export async function waitForV4ConversationState(
  predicate: (snapshot: V4ConversationStateSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: V4ConversationStateSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4ConversationState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4ConversationState();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  // 修复原因：命中 predicate 后再次读取会跨过 running/completed 瞬时边界，
  // 让调用方拿到与 waitUntil 判定不一致的状态。
  return latest ?? getV4ConversationState();
}

export async function getV4ConversationState(): Promise<V4ConversationStateSnapshot> {
  const browserSnapshot = await browser.execute(
    readV4ChatRootSnapshotInBrowser,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_QUEUE_ITEM,
    TID_V4_STOP,
  );
  if (browserSnapshot.bridgeError) {
    throw new Error(
      `无法读取 V4 conversation workspace: ${browserSnapshot.bridgeError}; ` +
        `workspaceKey=${browserSnapshot.workspaceKey}; paneSessionId=${browserSnapshot.paneSessionId}`,
    );
  }

  if (!browserSnapshot.taskId) {
    return {
      activeInputId: null,
      modelSwitchPending: browserSnapshot.modelSwitchPending,
      queueCount: browserSnapshot.queueCount,
      runtimeStatus: browserSnapshot.runtimeStatus,
      sessionId: null,
      state: browserSnapshot.runtimeStatus === "streaming" ? "streaming" : "idle",
      stopRequested: false,
      targetId: null,
      targetObjective: null,
      targetStatus: null,
      taskId: null,
    };
  }

  const taskStore = await readTaskStoreSnapshotForDiagnostics(
    browserSnapshot.taskId,
    browserSnapshot.workspaceKey ?? undefined,
  );
  if (!taskStore.workspaceKey) {
    throw new Error(
      `无法读取 V4 conversation task: ${taskStore.error}; ` +
        `workspaceKey=${browserSnapshot.workspaceKey}; taskId=${browserSnapshot.taskId}`,
    );
  }

  const goalProjection = await browser.execute(
    (paneTestId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!panel) return null;
      return {
        objective: panel.getAttribute("data-goal-objective"),
        status: panel.getAttribute("data-goal-status"),
      };
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_CHAT_SUMMARY_PANEL,
  );
  const hasBlockingGoalWork =
    goalProjection?.status === "active" || goalProjection?.status === "verifying";
  const effectiveRuntimeStatus =
    browserSnapshot.runtimeStatus === "streaming" ? "streaming" : taskStore.runtimeStatus;

  return {
    activeInputId: taskStore.activeInputId,
    modelSwitchPending: browserSnapshot.modelSwitchPending,
    queueCount: browserSnapshot.queueCount,
    runtimeStatus: effectiveRuntimeStatus,
    sessionId: browserSnapshot.taskId,
    state: effectiveRuntimeStatus === "streaming" || hasBlockingGoalWork ? "streaming" : "idle",
    stopRequested: taskStore.stopRequested,
    targetId: taskStore.taskMeta?.targetId ?? null,
    targetObjective: goalProjection?.objective ?? taskStore.taskMeta?.targetObjective ?? null,
    targetStatus: goalProjection?.status ?? taskStore.taskMeta?.targetStatus ?? null,
    taskId: browserSnapshot.taskId,
  };
}

/**
 * v4 composer 输入（M5 起为 Lexical contenteditable）：写入走
 * setInputValueByTestIdDom 的 __zcodeLexicalInputE2E bridge 分支（驱动真实 editor state）。
 */
export async function sendV4Prompt(prompt: string) {
  const resendOnDraftRegeneration = consumeDraftRegenerationResend();
  for (let attempt = 1; ; attempt += 1) {
    const since = resendOnDraftRegeneration ? await readRendererNow() : 0;
    await submitV4Prompt(prompt);
    if (!resendOnDraftRegeneration || attempt >= DRAFT_REGENERATION_MAX_ATTEMPTS) return;
    if (!(await isDraftRegenerationSendFailure(since))) return;
    console.warn(`[e2e][draft-regeneration] 第 ${attempt} 次发送遇到草稿换代，按产品提示重发`);
  }
}

async function submitV4Prompt(prompt: string) {
  await setV4ComposerText(prompt);
  const mainPaneTestId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (paneTestId, sendButtonTestId) => {
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const button = pane?.querySelector<HTMLButtonElement>(
              `[data-testid="${sendButtonTestId}"]`,
            );
            return Boolean(button && !button.disabled);
          },
          mainPaneTestId,
          TID_V4_COMPOSER_SEND,
        ),
      {
        timeout: 30000,
        timeoutMsg: "v4 发送按钮没有变为可用",
      },
    );
  } catch (error) {
    // 修复原因：会话切换竞态发生时，单独的“按钮 disabled”无法区分 projection connecting、
    // 上一轮仍在运行或 composer 未写入；把失败瞬间的 DOM 状态带回日志，避免继续靠猜测修复。
    const diagnostics = await browser.execute(
      (paneTestId, inputTestId, sendTestId, stopTestId) => {
        const panes = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid^="${paneTestId}"]`),
        );
        const active = document.activeElement as HTMLElement | null;
        return {
          activeTestId: active?.getAttribute("data-testid") ?? null,
          panes: panes.map((pane) => {
            const input = pane.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
            const send = pane.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
            return {
              paneTestId: pane.getAttribute("data-testid"),
              sessionId: pane.getAttribute("data-session-id"),
              inputText: input?.innerText ?? input?.textContent ?? null,
              sendDisabled: send?.disabled ?? null,
              sendTitle: send?.getAttribute("title") ?? null,
              canStop: Boolean(pane.querySelector(`[data-testid="${stopTestId}"]`)),
            };
          }),
        };
      },
      TID_V4_SESSION_PANE,
      TID_V4_COMPOSER_INPUT,
      TID_V4_COMPOSER_SEND,
      TID_V4_STOP,
    );
    throw new Error(`v4 发送按钮没有变为可用; diagnostics=${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
  const submitResult = await browser.execute(
    (paneTestId, sendButtonTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendButtonTestId}"]`);
      if (!pane) return { submitted: false, reason: "pane-missing" };
      if (!button) return { submitted: false, reason: "button-missing" };
      if (button.disabled) return { submitted: false, reason: "button-disabled" };

      const form = button.closest("form");
      if (!form) {
        button.click();
        return { submitted: true, method: "click-fallback" };
      }

      let submitEventSeen = false;
      const onSubmit = () => {
        submitEventSeen = true;
      };
      form.addEventListener("submit", onSubmit, { capture: true, once: true });
      form.requestSubmit(button);
      return {
        submitted: submitEventSeen,
        method: "request-submit",
        reason: submitEventSeen ? undefined : "submit-event-not-seen",
      };
    },
    mainPaneTestId,
    TID_V4_COMPOSER_SEND,
  );
  if (!submitResult.submitted) {
    throw new Error(`v4 composer 没有派发 submit 事件: ${JSON.stringify(submitResult)}`);
  }
}

// 草稿换代首发失败（staging 存量，另行排期）：重启并切模型后，草稿预热会话可能在首发前
// 换代，产品报“草稿会话已切换，请重新发送”，正文退回 composer。三处抛错都在 prompt 派发
// 之前，重发不会重复投递。产品修复前，只在重启准备之后的那次发送上按产品提示重发（有上限），
// 其他失败照常暴露。
const DRAFT_REGENERATION_SEND_ERROR = "草稿会话已切换，请重新发送";
const DRAFT_REGENERATION_MAX_ATTEMPTS = 3;
const DRAFT_SEND_RESULT_TIMEOUT_MS = 30_000;

/** 读 renderer 当前时钟，作为“本次点击之后”的 send 漏斗事件起点。 */
function readRendererNow(): Promise<number> {
  return browser.execute(() => Date.now());
}

async function isDraftRegenerationSendFailure(since: number): Promise<boolean> {
  // send_click 与 send_result 一一对应；按本次点击的 send_result 判定这次发送的结果。
  // 不能只看错误横幅：失败横幅会一直留到下一次成功发送，分不清是哪一次发送失败。
  let status: string | null = null;
  await browser
    .waitUntil(
      async () => {
        status = await browser.execute((sinceMs) => {
          type SendFunnelEvent = {
            name: string;
            recordedAt?: number;
            properties?: Record<string, unknown>;
          };
          const events =
            (window as Window & { __zcodeArmsCustomEventsE2E?: SendFunnelEvent[] })
              .__zcodeArmsCustomEventsE2E ?? [];
          const click = events.find(
            (event) => event.name === "send_click" && (event.recordedAt ?? 0) >= sinceMs,
          );
          const clickId = click?.properties?.send_click_id;
          if (!clickId) return null;
          const result = events.find(
            (event) => event.name === "send_result" && event.properties?.send_click_id === clickId,
          );
          return typeof result?.properties?.status === "string" ? result.properties.status : null;
        }, since);
        return status !== null;
      },
      { timeout: DRAFT_SEND_RESULT_TIMEOUT_MS },
    )
    .catch(() => undefined);
  if (status !== "fail") return false;
  // 横幅只显示通用的“发送失败”，原因只在详情弹窗里；必须确认是换代错误才重发。
  const paneTestId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
  await $(`[data-testid="${paneTestId}"] [data-testid="${TID_CHAT_ERROR_DETAILS_BUTTON}"]`).click();
  const dialog = $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 5000, timeoutMsg: "发送失败详情弹窗没有打开" });
  const detail = await dialog.getText();
  await browser.keys("Escape");
  await dialog.waitForDisplayed({
    reverse: true,
    timeout: 5000,
    timeoutMsg: "发送失败详情弹窗没有关闭",
  });
  if (!detail.includes(DRAFT_REGENERATION_SEND_ERROR)) {
    console.warn(`[e2e][draft-regeneration] 发送失败但不是草稿换代，不重发: ${detail}`);
    return false;
  }
  return true;
}

/**
 * 发送普通 prompt 并等待 renderer 明确接受：主 pane composer 清空且真实 user row 出现。
 * 不重试 submit，避免首发已进入 Host、但慢渲染尚未投影时重复发送同一条消息。
 */
export async function sendV4PromptAndWaitAccepted(
  prompt: string,
  userMessageMarker: string,
  timeoutMsg: string,
  timeout = 60_000,
) {
  await sendV4Prompt(prompt);
  let latest: {
    composerText: string | null;
    paneExists: boolean;
    sendDisabled: boolean | null;
    sessionId: string | null;
    userMessageSeen: boolean;
  } | null = null;
  const readAcceptance = () =>
    browser.execute(
      (paneTestId, inputTestId, sendTestId, timelineTestId, marker) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const input = pane?.querySelector<
          HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }
        >(`[data-testid="${inputTestId}"]`);
        const send = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
        const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
        const userMessageSeen = Array.from(
          timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
        ).some(
          (row) =>
            row.classList.contains("group/user-row") &&
            (row.innerText || row.textContent || "").includes(marker),
        );
        return {
          composerText: input?.__zcodeLexicalInputE2E?.getText() ?? null,
          paneExists: Boolean(pane),
          sendDisabled: send?.disabled ?? null,
          sessionId: pane?.getAttribute("data-session-id") ?? null,
          userMessageSeen,
        };
      },
      testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
      TID_V4_COMPOSER_INPUT,
      TID_V4_COMPOSER_SEND,
      TID_V4_TIMELINE,
      userMessageMarker,
    );

  try {
    await browser.waitUntil(
      async () => {
        latest = await readAcceptance();
        return latest.composerText === "" && latest.userMessageSeen;
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await readAcceptance().catch(() => latest);
    const state = await getV4ConversationState().catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError),
    }));
    throw new Error(
      `${timeoutMsg}; acceptance=${JSON.stringify(latest)}; state=${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}

/** 只写入 v4 composer，不触发发送。 */
export async function setV4ComposerText(text: string) {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    timeout: 15000,
    timeoutMsg: "v4 composer 输入框没有出现或不可输入",
  });
}

export async function waitForV4ComposerText(expected: string, timeoutMsg: string, timeout = 10000) {
  await browser.waitUntil(async () => (await getV4ComposerText()) === expected, {
    timeout,
    timeoutMsg,
  });
}

/** 点击 v4 composer 发送按钮（输入已由调用方写入，如 slash 命令）。 */
export async function clickV4Send() {
  await browser.waitUntil(
    async () =>
      browser.execute((sendButtonTestId) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-testid="${sendButtonTestId}"]`,
        );
        return Boolean(button && !button.disabled);
      }, TID_V4_COMPOSER_SEND),
    {
      timeout: 30000,
      timeoutMsg: "v4 发送按钮没有变为可用",
    },
  );
  await clickTestIdByDom(TID_V4_COMPOSER_SEND, {
    timeout: 15000,
    timeoutMsg: "v4 发送按钮没有出现或不可点击",
  });
}

export async function waitForV4TimelineContaining(text: string, timeout = 60000) {
  await waitForV4Pane(
    (snapshot) => snapshot.timelineText.includes(text),
    `v4 timeline 中没有出现: ${text}`,
    timeout,
  );
}

/**
 * 只等待当前 V4 pane 的 assistant 正文，避免用户 prompt 中的同名 marker
 * 抢先满足完成屏障。formal case 不应为此回退到 legacy conversation helper。
 */
export async function waitForV4AssistantMessageContaining(
  text: string,
  timeout = 90000,
  paneId: string = V4_MAIN_PANE_ID,
) {
  let latestAssistantMessages: string[] = [];
  const readAssistantMessages = () =>
    browser.execute(
      (paneTestId, timelineTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
        return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
          .filter((row) => row.classList.contains("group/assistant-row"))
          .map((row) => row.innerText.replace(/\u00a0/g, " ").trim());
      },
      testId(TID_V4_SESSION_PANE, paneId),
      TID_V4_TIMELINE,
    );

  try {
    await browser.waitUntil(
      async () => {
        latestAssistantMessages = await readAssistantMessages();
        return latestAssistantMessages.some((message) => message.includes(text));
      },
      {
        timeout,
        timeoutMsg: `v4 assistant 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    latestAssistantMessages = await readAssistantMessages().catch(() => latestAssistantMessages);
    throw new Error(
      `v4 assistant 消息中没有出现: ${text}; latest=${JSON.stringify(latestAssistantMessages)}`,
      { cause: error },
    );
  }
}

export function getV4Messages(role?: "assistant" | "user"): Promise<V4MessageSnapshot[]> {
  return browser.execute(
    (paneTestId, timelineTestId, selectedRole) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
        .map((element) => {
          const currentRole = element.classList.contains("group/user-row")
            ? "user"
            : element.classList.contains("group/assistant-row")
              ? "assistant"
              : null;
          return {
            id: element.getAttribute("data-row-id"),
            role: currentRole,
            text: element.innerText.replace(/\u00a0/g, " ").trim(),
          };
        })
        .filter(
          (message): message is V4MessageSnapshot =>
            message.role !== null && (!selectedRole || message.role === selectedRole),
        );
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_TIMELINE,
    role,
  );
}

export async function waitForV4UserMessageContaining(text: string) {
  let latestMessages: V4MessageSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestMessages = await getV4Messages("user");
        return latestMessages.some((message) => message.text.includes(text));
      },
      {
        timeout: 60000,
        timeoutMsg: `v4 user 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    const [state, composer, queue] = await Promise.all([
      getV4ConversationState().catch((stateError) => ({
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })),
      getV4ComposerText().catch((composerError) =>
        composerError instanceof Error ? composerError.message : String(composerError),
      ),
      getV4QueueItems().catch((queueError) => [
        {
          queueItemId: "<queue-read-error>",
          text: queueError instanceof Error ? queueError.message : String(queueError),
        },
      ]),
    ]);
    throw new Error(
      `v4 user 消息中没有出现: ${text}; latestMessages=${JSON.stringify(latestMessages)}; state=${JSON.stringify(state)}; queue=${JSON.stringify(queue)}; composer=${JSON.stringify(composer)}`,
      { cause: error },
    );
  }
}

export async function assertVisibleV4UserMessagesNotContaining(text: string) {
  const messages = await getV4Messages("user");
  expect(messages.map((message) => message.text).join("\n")).not.toContain(text);
}

export async function clickV4Stop() {
  await clickTestIdByDom(TID_V4_STOP, {
    timeout: 30000,
    timeoutMsg: "v4 stop 按钮没有出现或不可点击",
  });
}

// 修复原因：worktree 可用时 fork 按钮改为下拉菜单（ForkDestinationMenu），菜单项 testid 为
// v4-fork-here-* / v4-fork-to-worktree-*，同样匹配旧的 ^="v4-fork-" 前缀；且只点触发器不会 fork。
// 选择器排除菜单项，触发器是菜单时再选「在此处 fork」，与无 worktree 时的直接 fork 语义一致。
const V4_FORK_TRIGGER_SELECTOR =
  '[data-testid^="v4-fork-"]:not([data-testid^="v4-fork-here-"]):not([data-testid^="v4-fork-to-worktree-"])';

/** 点击第一个可见的 fork 按钮（完成态 assistant 行），返回是否点到。 */
export async function clickFirstV4Fork() {
  const buttons = await browser.$$(V4_FORK_TRIGGER_SELECTOR);
  for (const button of buttons) {
    await moveV4ForkRowIntoHoverState(button);
    if (!(await button.isDisplayed()) || !(await button.isEnabled())) {
      continue;
    }
    // Bug 根因：直接在 renderer 里调用 HTMLElement.click() 会绕过 WebDriver 的
    // 用户交互路径；Radix/React 组合控件在长批次中可能只更新视觉层而未提交 fork。
    // 使用 WebDriver 原生 click，保留同一个按钮和断言语义，确保触发真实 pointer/click 事件。
    await button.click();
    if ((await button.getAttribute("aria-haspopup")) === "menu") {
      const rowId = (await button.getAttribute("data-testid"))!.slice("v4-fork-".length);
      const forkHere = $(`[data-testid="v4-fork-here-${rowId}"]`);
      await forkHere.waitForClickable({
        timeout: 10000,
        timeoutMsg: "fork 菜单没有出现「在此处 fork」",
      });
      await forkHere.click();
    }
    return true;
  }
  return false;
}

export async function waitForV4Fork(timeout = 60000) {
  await browser.waitUntil(
    async () => {
      const buttons = await browser.$$(V4_FORK_TRIGGER_SELECTOR);
      for (const button of buttons) {
        await moveV4ForkRowIntoHoverState(button);
        if ((await button.isDisplayed()) && (await button.isEnabled())) {
          return true;
        }
      }
      return false;
    },
    { timeout, timeoutMsg: "v4 fork 按钮没有出现（assistant 行未完成？）" },
  );
}

async function moveV4ForkRowIntoHoverState(button: WebdriverIO.Element): Promise<void> {
  const rowTestId = await browser.execute(
    (element) => element.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null,
    button,
  );
  const row = rowTestId ? await browser.$(`[data-row-id="${rowTestId}"]`) : await button.$("..");
  // Bug 根因：assistant action toolbar 默认由 group-hover 隐藏，旧 helper 只检查 DOM
  // 存在就直接点隐藏按钮；长列表中该 click 不会触发真实 fork。先把所属 turn 移入
  // hover 状态，再用可见且 enabled 的按钮完成同一用户操作，不改变 case 证明。
  await row.moveTo();
}

/** 点击第一个可见的 edit 按钮（user 行），返回是否点到。 */
export async function clickFirstV4Edit() {
  return browser.execute(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid^="v4-edit-"]');
    btn?.click();
    return Boolean(btn);
  });
}

export async function waitForV4Edit(timeout = 60000) {
  await browser.waitUntil(
    async () =>
      browser.execute((editPrefix) => {
        const exactPattern = new RegExp(`^${editPrefix}-\\d+$`);
        return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
          (candidate) => exactPattern.test(candidate.dataset.testid ?? ""),
        );
      }, TID_V4_EDIT),
    { timeout, timeoutMsg: "v4 edit 按钮没有出现（user 行未完成？）" },
  );
}

/** 读取 v4 queue 面板当前项数与文本。 */
export function getV4QueueItems(): Promise<Array<{ queueItemId: string; text: string }>> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('li[data-testid^="v4-queue-item-"]'))
      // 修复原因：删除/编辑/立即发送按钮以及行内输入都共享
      // `v4-queue-item-*` 前缀和 data-queue-item-id；只按前缀会把一个 item
      // 统计成 4~5 个，误报 projection 没有显示 queue。列表项元素是唯一权威行。
      .filter((el) => el.hasAttribute("data-queue-item-id"))
      .map((el) => ({
        queueItemId: el.getAttribute("data-queue-item-id") ?? "",
        text: (el.innerText || "").replace(/ /g, " ").trim(),
      })),
  );
}

/** 读取 queue.autoDrain 权威 DOM 投影，供 fault/恢复 case 证明错误后不会自动消费。 */
export function getV4QueueAutoDrain(): Promise<boolean | null> {
  return browser.execute((queueTestId) => {
    const queue = document.querySelector<HTMLElement>(`[data-testid="${queueTestId}"]`);
    const value = queue?.getAttribute("data-queue-auto-drain");
    return value === null || value === undefined ? null : value === "true";
  }, TID_V4_QUEUE);
}

export async function waitForV4QueueCount(expected: number, timeout = 30000) {
  await browser.waitUntil(async () => (await getV4QueueItems()).length === expected, {
    timeout,
    timeoutMsg: `v4 queue 项数没有达到 ${expected}`,
  });
}

/** 点击某 queue 项的删除按钮（按 queueItemId）。 */
export async function clickV4QueueItemDelete(queueItemId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-queue-item-delete-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, queueItemId);
}

/** 点击某 queue 项的编辑按钮（按 queueItemId，冻结该项并进入 composer 编辑态）。 */
export async function clickV4QueueItemEdit(queueItemId: string, clickCount = 1) {
  return browser.execute(
    (id, count) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="v4-queue-item-edit-${id}"]`,
      );
      for (let index = 0; index < count; index += 1) {
        btn?.click();
      }
      return Boolean(btn);
    },
    queueItemId,
    clickCount,
  );
}

/** 点击某 queue 项的立即发送按钮（按 queueItemId）。 */
export async function clickV4QueueItemSendNow(queueItemId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-queue-item-send-now-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, queueItemId);
}

// ── 暂停队列发送确认与恢复（B06/B07/B14/B15/C08）──
// 原因：旧 E2E 把 clear/keep 当作 composer 的两颗替代发送按钮；产品交互改成
// 正常发送按钮先打开 modal 后，必须显式走“发送 → 等 modal → 选择”，否则测试会
// 把只打开弹窗误判成消息已经提交。

/** 暂停队列发送确认 modal 与两个操作按钮是否同时存在。 */
export function hasV4PausedQueueSendDialog(): Promise<boolean> {
  return browser.execute(
    (dialogTestId, clearTestId, keepTestId) =>
      Boolean(
        document.querySelector(`[data-testid="${dialogTestId}"]`) &&
        document.querySelector(`[data-testid="${clearTestId}"]`) &&
        document.querySelector(`[data-testid="${keepTestId}"]`),
      ),
    TID_V4_PAUSED_QUEUE_SEND_DIALOG,
    TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
    TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  );
}

/** 等待正常发送按钮提交后出现暂停队列确认 modal。 */
export async function waitForV4PausedQueueSendDialog(timeout = 30000) {
  await browser.waitUntil(async () => hasV4PausedQueueSendDialog(), {
    timeout,
    timeoutMsg: "暂停队列发送确认 modal 没有出现（清空/发送按钮缺失）",
  });
}

/** 通过正常发送按钮打开 modal，再选择“保留队列并发送”。 */
export async function sendV4PausedQueueKeep(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4PausedQueueSendDialog();
  await clickTestIdByDom(TID_V4_COMPOSER_KEEP_QUEUE_SEND, {
    timeout: 15000,
    timeoutMsg: "暂停队列确认 modal 的“发送消息”按钮没有出现或不可点击",
  });
}

/** 通过正常发送按钮打开 modal，再选择“清空队列并发送”。 */
export async function sendV4PausedQueueClear(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4PausedQueueSendDialog();
  await clickTestIdByDom(TID_V4_COMPOSER_CLEAR_QUEUE_SEND, {
    timeout: 15000,
    timeoutMsg: "暂停队列确认 modal 的“清空队列”按钮没有出现或不可点击",
  });
}

/** 暂停提示条与“继续”按钮是否同时存在。 */
export function hasV4PausedQueueBanner(): Promise<boolean> {
  return browser.execute(
    (bannerTestId, resumeTestId) =>
      Boolean(
        document.querySelector(`[data-testid="${bannerTestId}"]`) &&
        document.querySelector(`[data-testid="${resumeTestId}"]`),
      ),
    TID_V4_QUEUE_PAUSED_BANNER,
    TID_V4_QUEUE_RESUME,
  );
}

export async function waitForV4PausedQueueBanner(timeout = 30000) {
  await browser.waitUntil(async () => hasV4PausedQueueBanner(), {
    timeout,
    timeoutMsg: "暂停队列提示条或“继续”按钮没有出现",
  });
}

/** 点击暂停队列提示条的“继续”，恢复 CLI FIFO 自动消费。 */
export async function clickV4PausedQueueResume() {
  await waitForV4PausedQueueBanner();
  await clickTestIdByDom(TID_V4_QUEUE_RESUME, {
    timeout: 15000,
    timeoutMsg: "暂停队列提示条的“继续”按钮没有出现或不可点击",
  });
}

/** 读取后台工作面板项（workId + status）。 */
export function getV4BackgroundWorks(): Promise<Array<{ workId: string; status: string | null }>> {
  return browser.execute((itemPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`),
    ).map((el) => ({
      workId: el.getAttribute("data-work-id") ?? "",
      status: el.getAttribute("data-work-status"),
    }));
  }, TID_V4_BACKGROUND_WORK_ITEM);
}

/** 读取 Composer 当前 session 的后台任务计数与响应式展示形态；无入口返回 null。 */
export function getV4ComposerBackgroundWorkCounts(): Promise<{
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
  /** 入口点击的落点（docs/dynamic-workflow/presentation.md）："panel" | "workflow-run"。 */
  openTarget: string;
  typedVisible: boolean;
  compactVisible: boolean;
} | null> {
  return browser.execute((triggerTestId) => {
    const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
    if (!trigger) return null;
    const isVisible = (layout: string) => {
      const element = trigger.querySelector<HTMLElement>(
        `[data-composer-background-layout="${layout}"]`,
      );
      return Boolean(element && getComputedStyle(element).display !== "none");
    };
    return {
      bashCount: Number(trigger.dataset.backgroundBashCount ?? "0"),
      workflowCount: Number(trigger.dataset.backgroundWorkflowCount ?? "0"),
      subagentCount: Number(trigger.dataset.backgroundSubagentCount ?? "0"),
      totalCount: Number(trigger.dataset.backgroundTotalCount ?? "0"),
      openTarget: trigger.dataset.backgroundOpenTarget ?? "panel",
      typedVisible: isVisible("typed"),
      compactVisible: isVisible("compact"),
    };
  }, TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
}

/**
 * 失败时收集后台工作证据。用于区分三种情况：tool_use 未命中 fixture、
 * 权限弹窗导致工具未启动、事件已到达但 UI 未投影。
 */
export async function describeV4BackgroundFailureState(): Promise<string> {
  const [counts, works, snapshot] = await Promise.all([
    getV4ComposerBackgroundWorkCounts(),
    getV4BackgroundWorks(),
    getV4PaneSnapshot(),
  ]);
  return JSON.stringify({
    canStop: snapshot.canStop,
    composer: counts,
    backgroundWorks: works,
    timelineTail: snapshot.timelineText.slice(-1500),
  });
}

/** Electron driver 不实现 WebDriver window/rect；通过主进程 BrowserWindow 调整 viewport。 */
export async function setV4ElectronWindowSize(width: number, height: number) {
  // Bug 根因：外框和 renderer 内容区的差值随平台及 zoom 改变，固定误差会误报超时。
  // 复用精确绑定当前窗口的内容区 helper，同时保留尺寸应用失败的断言。
  await setCurrentElectronRendererContentSize(width, height);
}

/** 从 Composer 单一入口展开 Status panel，并直达所有非空后台类型区块。 */
export async function openV4ComposerRunningBackgroundWorks(timeout = 30000) {
  await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER, {
    timeout,
    timeoutMsg: "Composer 后台任务入口没有出现或不可点击",
  });
  await browser.waitUntil(
    async () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        const terminalCount = Number(panel?.dataset.runningTerminalCount ?? "0");
        const agentCount = Number(panel?.dataset.runningAgentCount ?? "0");
        const terminalTrigger = panel?.querySelector<HTMLElement>(
          '[data-status-section-trigger="terminal"]',
        );
        const agentTrigger = panel?.querySelector<HTMLElement>(
          '[data-status-section-trigger="agent"]',
        );
        // Bug 原因：Agent 行改用 taskId/executionId 停止身份后，testid 固定为
        // `v4-running-subagent-item`，不再是 `v4-background-work-item-<workId>`；
        // 只有 Agent 在跑时旧判定永远找不到行而超时。三类行共有的结构属性是
        // `data-background-task-kind`，按它判定“已有明细行”。
        return Boolean(
          panel?.dataset.state === "expanded" &&
          (terminalCount === 0 || terminalTrigger?.getAttribute("aria-expanded") === "true") &&
          (agentCount === 0 || agentTrigger?.getAttribute("aria-expanded") === "true") &&
          panel.querySelector("[data-background-task-kind]"),
        );
      }, TID_CHAT_SUMMARY_PANEL),
    { timeout, timeoutMsg: "Composer 入口没有直达展开的终端/智能体明细" },
  );
}

/** 展开统一 status panel 的非空后台类型区块；定位只依赖结构化属性，不依赖中英文。 */
export async function openV4RunningBackgroundWorks(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        if (!panel || Number(panel.dataset.runningBackgroundCount ?? "0") < 1) {
          return false;
        }
        if (panel.dataset.state === "collapsed") {
          panel.querySelector<HTMLButtonElement>("button")?.click();
          return false;
        }
        const sections = [
          {
            count: Number(panel.dataset.runningTerminalCount ?? "0"),
            name: "terminal",
          },
          {
            count: Number(panel.dataset.runningAgentCount ?? "0"),
            name: "agent",
          },
        ];
        let allOpen = true;
        for (const section of sections) {
          if (section.count === 0) continue;
          const trigger = panel.querySelector<HTMLButtonElement>(
            `[data-status-section-trigger="${section.name}"]`,
          );
          if (!trigger) return false;
          if (trigger.getAttribute("aria-expanded") !== "true") {
            trigger.click();
            allOpen = false;
          }
        }
        // 同上：Agent 行没有 `v4-background-work-item-*` testid，按共有结构属性判定。
        return allOpen && Boolean(panel.querySelector("[data-background-task-kind]"));
      }, TID_CHAT_SUMMARY_PANEL),
    { timeout, timeoutMsg: "status panel 没有展开终端/智能体 background work" },
  );
}

export function getLatestV4CommandAck(type: string): Promise<{
  type: string;
  status: string;
  reasonCode?: string;
} | null> {
  return browser.execute((commandType) => {
    const entries =
      (
        window as Window & {
          __zcodeV4CommandAcksE2E?: Array<{
            type: string;
            status: string;
            reasonCode?: string;
          }>;
        }
      ).__zcodeV4CommandAcksE2E ?? [];
    return [...entries].reverse().find((entry) => entry.type === commandType) ?? null;
  }, type);
}

/** 等待指定 v4 command 的结构化 ACK，避免业务断言把 command 卡住误报成模型无回复。 */
export async function waitForLatestV4CommandAck(type: string, timeout = 30000) {
  let latest: Awaited<ReturnType<typeof getLatestV4CommandAck>> = null;
  await browser.waitUntil(
    async () => {
      latest = await getLatestV4CommandAck(type);
      return latest !== null;
    },
    { timeout, timeoutMsg: `v4 command 没有返回 ACK: ${type}` },
  );
  return latest!;
}

/** 点击某后台工作的取消按钮（cancelBackgroundWork 命令，按 workId）。 */
export async function clickV4BackgroundWorkCancel(workId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-background-work-cancel-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, workId);
}

/** 通过侧栏归档，再从归档管理永久删除当前会话。 */
export async function clickV4DeleteSession() {
  const { sessionId } = await getV4PaneSnapshot();
  if (!sessionId || sessionId === "draft") throw new Error("删除要求已建立的会话");
  // 原因：Header 删除入口已移除；只能走用户可见的任务生命周期入口。
  const row = $(`[data-testid="${TID_TASK_ITEM}-${sessionId}"]`);
  await row.waitForDisplayed({ timeout: 15000 });
  await row.click({ button: "right" });
  const archive = $(
    '//*[@role="menuitem" and (normalize-space(.)="归档任务" or normalize-space(.)="Archive task")]',
  );
  await archive.waitForDisplayed({ timeout: 15000 });
  await archive.click();
  await row.waitForExist({ reverse: true, timeout: 15000 });
  await $('[data-testid="task-settings-button"]').click();
  await $('[data-testid="settings-section-nav-archives"]').click();
  // 归档管理默认收起分组，先经 UI 展开，不能把折叠中的任务误判为归档丢失。
  await $('[data-testid="archive-group-toggle"]').waitForDisplayed({ timeout: 15000 });
  for (const toggle of await $$('[data-testid="archive-group-toggle"]')) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  const archived = $(`[data-testid="archive-task"][data-task-id="${sessionId}"]`);
  await archived.waitForDisplayed({ timeout: 15000 });
  // 运行日志证明：展开动画中 row 已可见，但删除按钮仍被裁剪，原生 click 报 not interactable。
  // 等真实动画结束和按钮可点击后只点击一次，不能用固定暂停或重复点击补救。
  await browser.waitUntil(
    () =>
      browser.execute((id) => {
        const task = document.querySelector(`[data-testid="archive-task"][data-task-id="${id}"]`);
        const content = task?.closest('[data-state="open"]');
        return (
          Boolean(content) &&
          content!
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState !== "running")
        );
      }, sessionId),
    { timeout: 15000, timeoutMsg: "归档分组展开动画未结束" },
  );
  const deleteButton = archived.$('[data-testid="archive-delete"]');
  await deleteButton.waitForClickable({ timeout: 15000 });
  await deleteButton.click();
  const confirm = $('[data-testid="confirm-dialog-confirm"]');
  await confirm.waitForDisplayed({ timeout: 15000 });
  await confirm.click();
  await archived.waitForExist({ reverse: true, timeout: 15000 });
  await $('[data-testid="settings-back-button"]').click();
}

/** 读取 Composer 当前 mode/模型选择显示。 */
export function getV4ModelConfig(): Promise<{
  mode: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  thought: string | null;
}> {
  return browser.execute((modelTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
    return {
      mode: el?.getAttribute("data-mode") ?? null,
      provider: el?.getAttribute("data-provider") ?? null,
      model: el?.getAttribute("data-model") ?? null,
      source: el?.getAttribute("data-source") ?? null,
      thought: el?.getAttribute("data-thought") ?? null,
    };
  }, TID_V4_MODEL_CONFIG);
}

/** 等待当前 Composer 已从持久 Draft 完成 mode/模型选择初始化。 */
export async function waitForV4ComposerSelectionReady(timeout = 30_000) {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.source === "composer" &&
        Boolean(latest.mode?.trim()) &&
        Boolean(latest.provider?.trim()) &&
        Boolean(latest.model?.trim())
      );
    },
    {
      timeout,
      timeoutMsg: `v4 Composer 选择没有就绪: ${JSON.stringify(latest)}`,
    },
  );
}

/** 读取 draft 当前模型及其思考档位；V4 投影优先，legacy 目录仅作水合前 fallback。 */
export function getV4DraftThoughtState(workspacePath: string): Promise<{
  current: string | null;
  model: string | null;
  values: string[];
}> {
  return browser.execute(
    (path, modelTestId) => {
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            getWorkspaceState?: (workspacePath: string) => {
              configOptions?: Array<{
                category?: string;
                currentValue?: unknown;
                options?: Array<{ value: string }>;
              }>;
            };
          };
        };
      };
      const options =
        e2eWindow.__zcodeSessionStoreE2E?.getState().getWorkspaceState?.(path).configOptions ?? [];
      const model = options.find((option) => option.category === "model");
      const thought = options.find((option) => option.category === "thought_level");
      const v4Config = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
      const v4ThoughtLevels = (v4Config?.dataset.thoughtLevels ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return {
        current:
          v4Config?.dataset.thought?.trim() ||
          (typeof thought?.currentValue === "string" ? thought.currentValue : null),
        model:
          v4Config?.dataset.model?.trim() ||
          (typeof model?.currentValue === "string" ? model.currentValue : null),
        values:
          v4ThoughtLevels.length > 0
            ? v4ThoughtLevels
            : (thought?.options?.map((option) => option.value) ?? []),
      };
    },
    workspacePath,
    TID_V4_MODEL_CONFIG,
  );
}

/**
 * 通过 composer 工具条切换模型 + 思考深度（switchModelConfig 命令）。
 * M5：调试表单（provider/model/thought 文本框 + 应用）已被真实模型选择器替换——
 * helper 适配为驱动 ModelConfigSelect（含 provider 分组二级菜单）与思考深度选择器，
 * spec 的断言语义不变（config 投影更新为目标值）。
 */
export async function switchV4Model(provider: string, model: string, thought: string) {
  // 1) 模型：打开菜单 → （必要时展开 provider 分组子菜单）→ 点目标模型项。
  const modelItemTestId = testId(
    TID_CHAT_MODEL_SELECT_ITEM,
    encodeCustomModelValue(provider, model),
  );
  const providerGroupTestIds = [
    testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider}`),
  ];
  // 模型菜单是受控 DropdownMenu（pointerdown 打开），element.click() 不触发；
  // 与旧 upstream helper 同口径用 WebDriver 真实点击。
  const modelTrigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await modelTrigger.waitForClickable({ timeout: 30000 });
  await modelTrigger.click();
  await browser.waitUntil(
    async () => {
      // 已有会话切 Provider 需等待配置 ACK；保持原面板，仅在已收起时重新打开。
      await modelTrigger.waitForClickable({ timeout: 30000 });
      if ((await modelTrigger.getAttribute("aria-expanded")) !== "true") await modelTrigger.click();
      return browser.execute(
        (itemTestId, groupTestIds) => {
          const item = document.querySelector<HTMLElement>(`[data-testid="${itemTestId}"]`);
          if (item) {
            item.click();
            return true;
          }
          // 自定义 provider 模型在二级菜单：先触发分组展开（hover + click 双保险）。
          const group = groupTestIds
            .map((groupTestId) =>
              document.querySelector<HTMLElement>(`[data-testid="${groupTestId}"]`),
            )
            .find((candidate): candidate is HTMLElement => Boolean(candidate));
          if (!group) {
            const providerTrigger = document.querySelector<HTMLElement>(
              '[data-testid="composer-provider-trigger"]',
            );
            providerTrigger?.focus();
            providerTrigger?.dispatchEvent(
              new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
            );
          }
          if (group) {
            group.focus();
            for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
              group.dispatchEvent(
                new MouseEvent(eventName, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                }),
              );
            }
            group.click();
          }
          return false;
        },
        modelItemTestId,
        providerGroupTestIds,
      );
    },
    {
      timeout: 45000,
      timeoutMsg: `v4 模型选择器没有出现目标模型项: ${provider}/${model}`,
    },
  );

  // 模型 config 投影落定后再切思考深度：thought 命令的 provider/model 参数取自
  // 最新投影，模型切换未回流前切 thought 会被 UI 跳过（config-empty 防御）。
  await browser.waitUntil(async () => (await getV4ModelConfig()).model === model, {
    timeout: 30000,
    timeoutMsg: `模型切换后 config.model 投影没有更新为 ${model}`,
  });

  if (thought && (await selectCombinedComposerThoughtLevel(thought))) return;
  if (!thought && (await modelTrigger.getAttribute("data-composer-combined-model")) === "true") {
    await browser.keys("Escape");
    return;
  }

  // 无 reasoning metadata 的 custom provider 不渲染 thought selector。协议类 E2E
  // 传空值表示只切模型，不能把不存在的思考深度控件当作模型切换失败。
  if (!thought) {
    return;
  }

  // 2) 思考深度：Radix Select 的 item 在真实 pointer 事件上确认（element.click() 无效），
  // trigger/item 都用 WebDriver 真实点击。
  await selectRadixOption(
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thought),
    `v4 思考深度选择器没有出现目标档位: ${thought}`,
  );
}

/** Radix Select 通用驱动：真实点击 trigger 展开，item 需要完整 pointer 手势才会确认。 */
async function selectRadixOption(triggerTestId: string, itemTestId: string, timeoutMsg: string) {
  const trigger = $(sel(triggerTestId));
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(sel(itemTestId));
  try {
    await item.waitForClickable({ timeout: 15000 });
  } catch (error) {
    throw new Error(timeoutMsg, { cause: error });
  }
  // Radix SelectItem 的确认：mouse 手势要求 trusted pointer 链路（合成事件被手势
  // 判定忽略），键盘路径（item 聚焦 + Enter，SELECTION_KEYS）是自动化下最稳的确认方式。
  const confirmResult = await browser.execute((currentTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
    if (!element) {
      return {
        ok: false,
        reason: "item-missing",
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((el) => el.dataset.testid ?? "")
          .filter((id) => id.includes("select"))
          .slice(0, 40),
      };
    }
    element.focus();
    const focused = document.activeElement === element;
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    return { ok: true, focused };
  }, itemTestId);
  if (!confirmResult || confirmResult.ok !== true) {
    throw new Error(`${timeoutMsg}（item 确认阶段异常: ${JSON.stringify(confirmResult)}）`);
  }
  // 选择生效 ⇔ SelectContent 卸载（item 消失）；未关闭说明确认未生效，抛诊断。
  await browser
    .waitUntil(
      async () =>
        browser.execute(
          (currentTestId) => !document.querySelector(`[data-testid="${currentTestId}"]`),
          itemTestId,
        ),
      { timeout: 5000 },
    )
    .catch(() => {
      throw new Error(`${timeoutMsg}（item 确认后菜单未关闭——选择未生效）`);
    });
}

/** 读取 goal 横幅（data-goal-status / data-goal-objective 投影属性）；无目标返回 null。 */
export function getV4GoalProjection(): Promise<{
  status: string | null;
  objective: string | null;
} | null> {
  return browser.execute(
    (paneTestId, paneId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}-${paneId}"]`);
      const el = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!el) return null;
      return {
        status: el.getAttribute("data-goal-status"),
        objective: el.getAttribute("data-goal-objective"),
      };
    },
    TID_V4_SESSION_PANE,
    V4_MAIN_PANE_ID,
    TID_CHAT_SUMMARY_PANEL,
  );
}

/**
 * 打开 latest user query 的 composer 编辑态并写入新文本，但不提交。
 * 编辑复用底部 composer（docs/ui/composer-edit-mode.md），原草稿由产品暂存，不参与 newText。
 */
export async function beginFirstV4UserQueryEdit(newText: string) {
  const rowId = await openLatestV4UserQueryEditInComposer();
  await setV4ComposerText(newText);
  return rowId;
}

/** 按真实 composer 编辑态提交 latest user query：编辑态下的发送按钮路由到 editUserQuery。 */
export async function editFirstV4UserQuery(newText: string) {
  const rowId = await beginFirstV4UserQueryEdit(newText);
  await clickV4Send();
  return rowId;
}

/** 提交编辑态状态条中的“对话 + 文件重置”路径。 */
export async function clickV4EditWorkspaceReset(rowId: string) {
  await clickTestIdByDom(testId(TID_V4_EDIT_REWIND_WORKSPACE, rowId), {
    timeout: 15000,
    timeoutMsg: `v4 对话 + 文件重置按钮没有出现或不可点击: rowId=${rowId}`,
  });
}

export async function waitForV4EditWorkspaceConflict(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (testIdValue) => Boolean(document.querySelector(`[data-testid="${testIdValue}"]`)),
        TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
      ),
    { timeout, timeoutMsg: "v4 edit 文件冲突弹窗没有出现" },
  );
}

export async function clickV4EditConflictConversationOnly() {
  await clickTestIdByDom(TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY, {
    timeout: 15000,
    timeoutMsg: "v4 edit 冲突弹窗没有出现仅重置对话按钮",
  });
}

/** 读取结构化 compact marker；状态与来源只读 data-*，不依赖本地化 label。 */
export function getV4CompactMarkers(
  paneId: string = V4_MAIN_PANE_ID,
): Promise<V4CompactMarkerSnapshot[]> {
  return browser.execute(
    (paneTestId, rowPrefix) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      return Array.from(
        pane?.querySelectorAll<HTMLElement>(
          `[data-testid^="${rowPrefix}-"][data-row-kind="timelineMarker"][data-marker-type="compact"]`,
        ) ?? [],
      ).map((row) => {
        const rowId = row.dataset.rowId ? Number(row.dataset.rowId) : Number.NaN;
        return {
          origin: row.dataset.origin ?? null,
          rowId: Number.isFinite(rowId) ? rowId : null,
          status: row.dataset.status ?? null,
          text: row.innerText.trim(),
        };
      });
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_ROW,
  );
}

/** 等待结构化 compact marker；不读取本地化 label。 */
export async function waitForV4CompactMarker(
  expected: { status: string; origin: "manual" | "auto" },
  timeout = 90000,
) {
  await browser.waitUntil(
    async () =>
      (await getV4CompactMarkers()).some(
        (marker) => marker.status === expected.status && marker.origin === expected.origin,
      ),
    {
      timeout,
      timeoutMsg: `v4 compact marker 未达到 ${expected.origin}/${expected.status}`,
    },
  );
}

/** 读取会话标题显示（data-title 投影属性）。 */
export function getV4SessionTitle(): Promise<string | null> {
  return browser.execute((titleTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${titleTestId}"]`);
    return el?.getAttribute("data-title") ?? null;
  }, TID_V4_SESSION_TITLE);
}

/** 从当前会话的侧栏右键菜单重命名。 */
export async function renameV4Session(title: string) {
  const { sessionId } = await getV4PaneSnapshot();
  if (!sessionId || sessionId === "draft") throw new Error("重命名要求已建立的会话");
  // 原因：Header 不再提供重命名表单；侧栏菜单才是当前产品入口。
  const row = $(`[data-testid="${TID_TASK_ITEM}-${sessionId}"]`);
  await row.waitForDisplayed({ timeout: 15000 });
  await row.click({ button: "right" });
  const rename = $(
    '//*[@role="menuitem" and (normalize-space(.)="重命名任务" or normalize-space(.)="Rename task")]',
  );
  await rename.waitForDisplayed({ timeout: 15000 });
  await rename.click();
  const input = $('[role="dialog"] input');
  await input.waitForDisplayed({ timeout: 15000 });
  await input.setValue(title);
  await input.addValue("\uE007");
  await input.waitForExist({ reverse: true, timeout: 15000 });
}

/** 双击任务行打开同一个重命名弹窗；view 区分按项目与按分组两套行组件。 */
export async function renameV4SessionByDoubleClick(
  title: string,
  options: { view?: "projects" | "grouped" } = {},
) {
  const { sessionId } = await getV4PaneSnapshot();
  if (!sessionId || sessionId === "draft") throw new Error("重命名要求已建立的会话");
  const rowSelector = `[data-testid="${TID_TASK_ITEM}-${sessionId}"]`;
  const row =
    options.view === "grouped"
      ? $(`[data-testid="task-grouped-view"] ${rowSelector}`)
      : $(rowSelector);
  await row.waitForDisplayed({ timeout: 15000 });
  await row.doubleClick();
  const dialog = $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 15000 });
  expect(await $$('[role="dialog"]').length).toBe(1);
  const input = dialog.$("input");
  await input.waitForDisplayed({ timeout: 15000 });
  // 双击入口必须复用右键菜单的弹窗，并预填当前标题。
  expect(await input.getValue()).not.toBe("");
  await input.setValue(title);
  await input.addValue("\uE007");
  await dialog.waitForExist({ reverse: true, timeout: 15000 });
}

/** 读取输入控制条：autoDrain（data-auto-drain）与 followupMode（data-followup-mode）。 */
export function getV4InputControlState(): Promise<{
  autoDrain: string | null;
  followupMode: string | null;
}> {
  return browser.execute(
    (autoDrainTestId, followupTestId) => {
      const autoBtn = document.querySelector<HTMLElement>(`[data-testid="${autoDrainTestId}"]`);
      const followupBtn = document.querySelector<HTMLElement>(`[data-testid="${followupTestId}"]`);
      return {
        autoDrain: autoBtn?.getAttribute("data-auto-drain") ?? null,
        followupMode: followupBtn?.getAttribute("data-followup-mode") ?? null,
      };
    },
    TID_V4_AUTODRAIN_TOGGLE,
    TID_V4_FOLLOWUP_TOGGLE,
  );
}

/** 点击 autoDrain 开关（setAutoDrain 命令）。 */
export async function clickV4AutoDrainToggle() {
  return clickTestIdByDom(TID_V4_AUTODRAIN_TOGGLE, {
    timeout: 15000,
    timeoutMsg: "v4 autoDrain 开关没有出现",
  });
}

/** 点击 followupMode 开关（setFollowupMode 命令）。 */
export async function clickV4FollowupToggle() {
  return clickTestIdByDom(TID_V4_FOLLOWUP_TOGGLE, {
    timeout: 15000,
    timeoutMsg: "v4 followupMode 开关没有出现",
  });
}

/** 拖拽某 queue 项到目标 queue 项上（按 queueItemId）。 */
export async function dragV4QueueItemOnto(sourceQueueItemId: string, targetQueueItemId: string) {
  const positions = (await browser.execute(
    (sourceId, targetId) => {
      const dragHandle = Array.from(
        document.querySelectorAll<HTMLElement>('[data-v4-queue-drag-handle="true"]'),
      ).find((el) => el.getAttribute("data-queue-item-id") === sourceId);
      const targetItem = Array.from(
        document.querySelectorAll<HTMLElement>("li[data-queue-item-id]"),
      ).find((el) => el.getAttribute("data-queue-item-id") === targetId);

      if (!dragHandle || !targetItem) {
        return {
          ok: false,
          reason: "missing-element",
          hasDragHandle: Boolean(dragHandle),
          hasTargetItem: Boolean(targetItem),
        };
      }

      const dragRect = dragHandle.getBoundingClientRect();
      const targetRect = targetItem.getBoundingClientRect();
      return {
        ok: true,
        startX: Math.round(dragRect.left + dragRect.width / 2),
        startY: Math.round(dragRect.top + dragRect.height / 2),
        endX: Math.round(targetRect.left + targetRect.width / 2),
        endY: Math.round(targetRect.top + targetRect.height / 2),
      };
    },
    sourceQueueItemId,
    targetQueueItemId,
  )) as
    | { ok: true; startX: number; startY: number; endX: number; endY: number }
    | {
        ok: false;
        reason: string;
        hasDragHandle: boolean;
        hasTargetItem: boolean;
      };

  if (!positions.ok) {
    throw new Error(`v4 队列项拖拽元素不存在: ${JSON.stringify(positions)}`);
  }

  await browser.performActions([
    {
      id: "v4-queue-drag-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          x: positions.startX,
          y: positions.startY,
        },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        {
          type: "pointerMove",
          duration: 120,
          x: positions.startX,
          y: positions.startY - 10,
        },
        {
          type: "pointerMove",
          duration: 260,
          x: positions.endX,
          y: positions.endY,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();

  // 修复原因：dnd-kit 会屏蔽拖拽结束后的紧随 click，E2E 用空白 click 消耗这次屏蔽，
  // 避免后续按钮点击被误吞。
  await browser.execute(() => {
    document.body.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  });
  await browser.pause(50);
}

// ── M5④ 虚拟滚动：timeline 滚动状态读写 ──
// 虚拟化后 DOM 只有挂载的 turn units；raw 行数分别走 timeline 容器的
// data-window-row-count（rows.window）与 data-total-row-count（rows.totalCount），
// 避免把 mounted unit、logical unit 与持久 raw row 三种计量单位混用。

export interface V4TimelineScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** raw projection window 行数。 */
  windowRowCount: number;
  /** turn-level logical render unit 数。 */
  renderUnitCount: number;
  /** 全序行数（data-total-row-count）。 */
  totalRowCount: number;
  /** 底部跟随态（data-following："true" | "false"）。 */
  following: string | null;
  /** 实际挂载到 DOM 的 turn unit 数（虚拟化窗口 + overscan）。 */
  mountedRenderUnitCount: number;
  /** 「回到底部」按钮是否出现。 */
  hasBackToBottom: boolean;
}

export function getV4TimelineScrollState(): Promise<V4TimelineScrollState> {
  return browser.execute(
    (timelineTestId, bottomTestId) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return {
        scrollTop: timeline?.scrollTop ?? 0,
        scrollHeight: timeline?.scrollHeight ?? 0,
        clientHeight: timeline?.clientHeight ?? 0,
        windowRowCount: Number(timeline?.getAttribute("data-window-row-count") ?? 0),
        renderUnitCount: Number(timeline?.getAttribute("data-render-unit-count") ?? 0),
        totalRowCount: Number(timeline?.getAttribute("data-total-row-count") ?? 0),
        following: timeline?.getAttribute("data-following") ?? null,
        mountedRenderUnitCount:
          timeline?.querySelectorAll('[data-v4-turn-unit="true"]').length ?? 0,
        hasBackToBottom: Boolean(document.querySelector(`[data-testid="${bottomTestId}"]`)),
      };
    },
    TID_V4_TIMELINE,
    TID_V4_TIMELINE_BOTTOM,
  );
}

/**
 * 把 timeline 滚到顶（scrollTop=0，触发原生 scroll 事件 → 解除底部跟随），
 * 并等虚拟化窗口对齐到新滚动位置后才返回。
 *
 * bugfix（虚拟化语义）：scrollTop 赋值后 scroll 事件要到下一渲染帧才派发，
 * virtualizer 收到事件才重渲染顶端行——期间 DOM 仍是旧的底部窗口
 * （实测：scrollTop=0 后旧行 58..72 还挂在视口下方 3272px 处），此时视口里没有
 * 任何行。CDP execute 往返快于一帧，调用方紧接着的 DOM 采样会读到过期窗口。
 * 这里等「有行真正落进视口」（虚拟窗口已对齐当前滚动位置）再返回。
 * 注意不能等 scrollTop 停在 0：到顶会触发 loadOlder，prepend 锚定会立刻把
 * scrollTop 平移到保持阅读位置的新值（这正是被测语义），0 只是瞬态。
 */
export async function scrollV4TimelineToTop() {
  await browser.execute((timelineTestId) => {
    const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
    if (!timeline) return;
    // 修复原因：ConversationTimeline 会先用 wheel/touch/key 记录真实用户意图，
    // 仅写 scrollTop 的脚本滚动可能被布局保护窗口归类为虚拟化校正，继续保持底部跟随。
    timeline.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600 }),
    );
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new Event("scroll"));
  }, TID_V4_TIMELINE);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (timelineTestId, rowPrefix) => {
          const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
          if (!timeline) return false;
          const timelineTop = timeline.getBoundingClientRect().top;
          const viewportHeight = timeline.clientHeight;
          return Array.from(
            timeline.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
          ).some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom - timelineTop > 0 && rect.top - timelineTop < viewportHeight;
          });
        },
        TID_V4_TIMELINE,
        TID_V4_ROW,
      ),
    {
      timeout: 15000,
      timeoutMsg: "scrollTop=0 后虚拟化窗口没有对齐到滚动位置（视口内始终没有行）",
    },
  );
}

/** 点「回到底部」按钮（恢复跟随并贴底）。 */
export async function clickV4TimelineBackToBottom() {
  return clickTestIdByDom(TID_V4_TIMELINE_BOTTOM, {
    timeout: 15000,
    timeoutMsg: "v4 回到底部按钮没有出现",
  });
}

// ── TN：v4 对话轮次导航 minimap ──

export interface V4TurnNavigatorState {
  centerOffsetPx: number;
  composerLeftGutterPx: number;
  exists: boolean;
  firstItemLeftOffsetPx: number;
  visible: boolean;
  itemCount: number;
  paneWidthPx: number;
  items: Array<{
    active: boolean;
    height: number;
    left: number;
    testId: string;
    top: number;
    turnId: string | null;
    unitIndex: number | null;
    visualColorTone: string | null;
    visualScale: number | null;
    visualTone: string | null;
  }>;
}

export function getV4TurnNavigatorState(): Promise<V4TurnNavigatorState> {
  return browser.execute(
    (navigatorTestId, itemPrefix, timelineTestId, composerTestId, sessionPaneTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${sessionPaneTestId}"]`);
      const scope: Document | HTMLElement = pane ?? document;
      const navigator = scope.querySelector<HTMLElement>(`[data-testid="${navigatorTestId}"]`);
      const timeline = scope.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const composer = scope.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const style = navigator ? window.getComputedStyle(navigator) : null;
      const rect = navigator?.getBoundingClientRect();
      const timelineRect = timeline?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const paneRect = pane?.getBoundingClientRect();
      const items = Array.from(
        navigator?.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`) ?? [],
      ).map((el) => {
        const itemRect = el.getBoundingClientRect();
        return {
          active: el.getAttribute("data-active") === "true",
          height: itemRect.height,
          left: itemRect.left,
          testId: el.dataset.testid ?? "",
          top: itemRect.top,
          turnId: el.getAttribute("data-turn-id"),
          unitIndex:
            el.getAttribute("data-unit-index") === null
              ? null
              : Number(el.getAttribute("data-unit-index")),
          visualColorTone: el.getAttribute("data-visual-color-tone"),
          visualScale:
            el.getAttribute("data-visual-scale") === null
              ? null
              : Number(el.getAttribute("data-visual-scale")),
          visualTone: el.getAttribute("data-visual-tone"),
        };
      });
      const firstItemLeftOffsetPx =
        items[0] && timelineRect ? items[0].left - timelineRect.left : Number.NaN;
      const firstItem = items[0];
      const lastItem = items.at(-1);
      const stackCenter =
        firstItem && lastItem ? (firstItem.top + lastItem.top + lastItem.height) / 2 : Number.NaN;
      const timelineCenter = timelineRect ? timelineRect.top + timelineRect.height / 2 : Number.NaN;
      return {
        centerOffsetPx: stackCenter - timelineCenter,
        composerLeftGutterPx:
          composerRect && timelineRect ? composerRect.left - timelineRect.left : Number.NaN,
        exists: Boolean(navigator),
        firstItemLeftOffsetPx,
        visible: Boolean(
          navigator &&
          style &&
          rect &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0,
        ),
        itemCount: items.length,
        items,
        paneWidthPx: paneRect?.width ?? Number.NaN,
      };
    },
    TID_V4_TURN_NAVIGATOR,
    TID_V4_TURN_NAVIGATOR_ITEM,
    TID_V4_TIMELINE,
    TID_V4_COMPOSER,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
  );
}

export async function waitForV4TurnNavigator(
  predicate: (state: V4TurnNavigatorState) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: V4TurnNavigatorState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4TurnNavigatorState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4TurnNavigatorState();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getV4TurnNavigatorState();
}

async function getV4TurnNavigatorItemTestIdByIndex(index: number) {
  const state = await getV4TurnNavigatorState();
  const item = state.items[index];
  if (!item) {
    throw new Error(
      `v4 turn navigator item 不存在: index=${index}; latest=${JSON.stringify(state)}`,
    );
  }
  return item.testId;
}

export async function hoverV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  const item = $(sel(itemTestId));
  await item.waitForDisplayed({ timeout: 15000 });
  await item.moveTo();
  return itemTestId;
}

export async function focusV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  await browser.execute((currentTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`)?.focus();
  }, itemTestId);
  return itemTestId;
}

export async function clickV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  await browser.execute((currentTestId) => {
    document.querySelector<HTMLButtonElement>(`[data-testid="${currentTestId}"]`)?.click();
  }, itemTestId);
  return itemTestId;
}

export function getV4TurnNavigatorTooltipText(): Promise<string> {
  return browser.execute((tooltipPrefix) => {
    const tooltip = document.querySelector<HTMLElement>(`[data-testid^="${tooltipPrefix}-"]`);
    return (tooltip?.innerText ?? "").replace(/ /g, " ");
  }, TID_V4_TURN_NAVIGATOR_TOOLTIP);
}

export async function waitForV4TurnNavigatorTooltip(
  predicate: (text: string) => boolean,
  timeoutMsg: string,
  timeout = 15000,
) {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4TurnNavigatorTooltipText();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4TurnNavigatorTooltipText();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getV4TurnNavigatorTooltipText();
}

// ── M5⑤ 分屏（Layout/Focus 两层）：pane 级定位与焦点断言 ──
// 分屏后同 testid（composer 输入/发送等）在两个 pane 各有一份，全局 helper 只会
// 命中 DOM 序第一个（primary）。以下 helper 一律先按 v4-pane-shell-<paneId>
// 收口作用域再定位，焦点断言读外壳的 data-focused。

/** 读取当前 focused pane 的 paneId（data-focused="true" 的外壳）；无外壳返回 null。 */
export function getV4FocusedPaneId(): Promise<string | null> {
  return browser.execute((shellPrefix) => {
    const focused = document.querySelector<HTMLElement>(
      `[data-testid^="${shellPrefix}-"][data-focused="true"]`,
    );
    return focused?.getAttribute("data-pane-id") ?? null;
  }, TID_V4_PANE_SHELL);
}

/** 点击侧栏会话项并等待 primary pane 绑定到该 session。 */
export async function selectV4TaskById(sessionId: string, taskListTimeout = 15000) {
  await clickTestIdByDom(testId(TID_TASK_ITEM, sessionId), {
    timeout: taskListTimeout,
    timeoutMsg: `任务列表没有可点击的 v4 task: ${sessionId}`,
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `点击侧栏 task 后 primary pane 没有切到 ${sessionId}`,
    30000,
    V4_MAIN_PANE_ID,
  );
}

/** 对 pane 外壳派发 pointerdown（Focus 层 onPointerDownCapture → focus 该 pane）。 */
export async function focusV4Pane(paneId: string) {
  const dispatched = await browser.execute(
    (shellTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      if (!shell) return false;
      shell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      return true;
    },
    testId(TID_V4_PANE_SHELL, paneId),
  );
  if (!dispatched) {
    throw new Error(`focusV4Pane: pane 外壳不存在: ${paneId}`);
  }
  await browser.waitUntil(async () => (await getV4FocusedPaneId()) === paneId, {
    timeout: 15000,
    timeoutMsg: `pane ${paneId} 没有获得焦点`,
  });
}

/** pane 作用域内点 stop（分屏时全局 TID_V4_STOP 会命中 DOM 序第一个 pane）。 */
export async function clickV4StopInPane(paneId: string) {
  const clicked = await browser.execute(
    (shellTestId, stopTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      const btn = shell?.querySelector<HTMLButtonElement>(`[data-testid="${stopTestId}"]`);
      btn?.click();
      return Boolean(btn);
    },
    testId(TID_V4_PANE_SHELL, paneId),
    TID_V4_STOP,
  );
  if (!clicked) {
    throw new Error(`pane ${paneId} 内没有可点击的 stop 按钮`);
  }
}

/** pane 作用域内点分屏 pane 的 session pane snapshot（按 paneId）。 */
export async function waitForV4PaneById(
  paneId: string,
  predicate: (snapshot: V4PaneSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  return waitForV4Pane(predicate, timeoutMsg, timeout, paneId);
}

/** pane 作用域内写 composer 文本并点发送（同 sendV4Prompt，但按 paneId 收口）。 */
export async function sendV4PromptInPane(paneId: string, prompt: string) {
  const paneShellTestId = testId(TID_V4_PANE_SHELL, paneId);
  // M5：composer 为 Lexical contenteditable——写入走编辑器挂载的 __zcodeLexicalInputE2E
  // bridge（驱动真实 editor state）；bridge.focus() 同时驱动 Focus 层 → composer 归属该 pane。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (shellTestId, inputTestId, nextValue) => {
          const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
          const element = shell?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          if (!element) return false;
          const bridge = (
            element as HTMLElement & {
              __zcodeLexicalInputE2E?: {
                focus: () => void;
                getText: () => string;
                setText: (text: string) => void;
              };
            }
          ).__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.focus();
          bridge.setText(nextValue);
          return bridge.getText() === nextValue;
        },
        paneShellTestId,
        TID_V4_COMPOSER_INPUT,
        prompt,
      ),
    {
      timeout: 15000,
      timeoutMsg: `pane ${paneId} 的 composer 输入框没有出现或不可输入`,
    },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (shellTestId, sendTestId) => {
          const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
          const button = shell?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        paneShellTestId,
        TID_V4_COMPOSER_SEND,
      ),
    {
      timeout: 30000,
      timeoutMsg: `pane ${paneId} 的发送按钮没有变为可用`,
    },
  );
}

/** 等待 v4 权限弹窗出现（V4InteractionDialogs → PermissionDialog，role=listbox）。 */
export function hasV4PermissionDialog(): Promise<boolean> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/ /g, " ").trim();
    return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
  });
}

/** V4 普通 permission 声明 freeText 能力时，底部输入行必须实际挂载。 */
export function hasV4PermissionFeedbackInput(): Promise<boolean> {
  return browser.execute(() =>
    Boolean(
      document.querySelector(
        'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
      ),
    ),
  );
}

export async function waitForV4PermissionDialog(timeout = 60000) {
  await browser.waitUntil(hasV4PermissionDialog, { timeout, timeoutMsg: "v4 权限弹窗没有出现" });
}

export interface V4PermissionRuleScope {
  kind: "exact" | "prefix";
  text: string;
}

export async function getV4PermissionRuleScopes(): Promise<V4PermissionRuleScope[]> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/ /g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    return Array.from(
      listbox?.querySelectorAll<HTMLElement>("[data-permission-rule-scope]") ?? [],
    ).map((element) => ({
      kind: element.getAttribute("data-permission-rule-scope") === "prefix" ? "prefix" : "exact",
      text: normalize(element.innerText),
    }));
  });
}

export interface V4PermissionDockState {
  inDock: boolean;
  composerMounted: boolean;
  composerHidden: boolean;
  interactionBeforeComposer: boolean;
  composerAriaHidden: string | null;
  composerDisplay: string | null;
}

async function readV4PermissionDockState(): Promise<V4PermissionDockState> {
  return browser.execute((composerTestId) => {
    const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (el) => {
        const label = normalize(el.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    const dock = listbox?.closest<HTMLElement>('[data-v4-composer-dock="true"]') ?? null;
    const composer = dock?.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`) ?? null;
    const composerDisplay = composer ? getComputedStyle(composer).display : null;
    const interactionBeforeComposer = Boolean(
      listbox &&
      composer &&
      listbox.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return {
      inDock: Boolean(dock),
      composerMounted: Boolean(composer),
      composerHidden:
        composer?.getAttribute("aria-hidden") === "true" && composerDisplay === "none",
      interactionBeforeComposer,
      composerAriaHidden: composer?.getAttribute("aria-hidden") ?? null,
      composerDisplay,
    };
  }, TID_V4_COMPOSER);
}

/**
 * 等待真实权限弹窗进入 v4 composer dock，并确认阻塞期间 composer 只隐藏不卸载。
 */
export async function waitForV4PermissionDialogInComposerDock(timeout = 60000) {
  await waitForV4PermissionDialog(timeout);
  await browser.waitUntil(
    async () => {
      const state = await readV4PermissionDockState();
      return (
        state.inDock &&
        state.composerMounted &&
        state.composerHidden &&
        state.interactionBeforeComposer
      );
    },
    { timeout, timeoutMsg: "v4 权限弹窗没有进入 composer dock 或 composer 未正确隐藏" },
  );
  return readV4PermissionDockState();
}

/**
 * 批准 v4 权限弹窗的第一个选项（Allow once）。PermissionDialog 首项默认选中，
 * 单击已选中项即确认 onRespond → resolveInteraction 命令。为稳妥点两次
 *（第一次若只是选中，第二次确认）。
 */
export async function approveV4Permission(feedback?: string) {
  await waitForV4PermissionDialog();
  if (feedback !== undefined) {
    const input = await $(
      'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
    );
    await input.waitForDisplayed({ timeout: 15000 });
    await input.setValue(feedback);
  }
  const confirmFirstOption = () =>
    browser.execute(() => {
      const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (el) => {
          const label = normalize(el.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = listbox?.querySelector<HTMLButtonElement>('button[role="option"]');
      option?.click();
      return Boolean(option);
    });
  await confirmFirstOption();
  // 弹窗消失即视为已应答；若首次点击只是选中，再点一次确认。
  const dismissed = await browser
    .waitUntil(
      async () => {
        const stillOpen = await browser.execute(() => {
          const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
          return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
            (el) => {
              const label = normalize(el.getAttribute("aria-label"));
              return label === "Permission required" || label === "需要权限";
            },
          );
        });
        if (stillOpen) {
          await confirmFirstOption();
          return false;
        }
        return true;
      },
      { timeout: 15000, timeoutMsg: "v4 权限弹窗批准后没有关闭" },
    )
    .then(() => true)
    .catch(() => false);
  return dismissed;
}

/** 填写拒绝反馈并确认 Deny，反馈走同一个 resolveInteraction 应答。 */
export async function denyV4PermissionWithFeedback(feedback: string, submitWithEnter = false) {
  await waitForV4PermissionDialog();
  const input = await $(
    'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
  );
  await input.waitForDisplayed({ timeout: 15000 });
  await input.setValue(feedback);

  // 空白输入行不能提交；普通 Deny 仍可确认且只回传基础拒绝文案。
  if (!feedback.trim() && !submitWithEnter) {
    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('[role="option"][data-permission-option-kind^="reject"]')
        ?.focus();
    });
  }
  await browser.waitUntil(
    () =>
      browser.execute((hasFeedback: boolean) => {
        const selectedDeny = document.querySelector(
          '[role="option"][data-permission-option-kind^="reject"][aria-selected="true"]',
        );
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
        );
        return hasFeedback
          ? !selectedDeny &&
              document.activeElement === input &&
              input?.parentElement?.classList.contains("bg-selected")
          : Boolean(selectedDeny);
      }, Boolean(feedback.trim())),
    { timeout: 5000, timeoutMsg: "权限反馈行与普通 Deny 的独立选择状态不符合预期" },
  );

  if (submitWithEnter) {
    await input.click();
    await browser.keys("Enter");
  }

  const clicked = submitWithEnter
    ? true
    : await browser.execute(() => {
        const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
        const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
          (el) => {
            const label = normalize(el.getAttribute("aria-label"));
            return label === "Permission required" || label === "需要权限";
          },
        );
        // 按稳定的阻塞交互区域定位，避免新增视觉分组后依赖 listbox 的直接父节点。
        const confirmButton = listbox
          ?.closest('[data-v4-composer-dock="true"]')
          ?.querySelector<HTMLButtonElement>(
            'button[aria-label="Confirm"],button[aria-label="确认"]',
          );
        confirmButton?.click();
        return Boolean(confirmButton);
      });
  if (!clicked) return false;

  return browser
    .waitUntil(async () => !(await hasV4PermissionDialog()), {
      timeout: 15000,
      timeoutMsg: "v4 权限弹窗拒绝后没有关闭",
    })
    .then(() => true)
    .catch(() => false);
}

/** 选择携带 CLI suggestion 的项目级始终允许选项。 */
export async function approveV4PermissionAlways() {
  await waitForV4PermissionDialog();
  const confirmAlwaysOption = () =>
    browser.execute(() => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/ /g, " ").trim();
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (element) => {
          const label = normalize(element.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = Array.from(
        listbox?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
      ).find((button) => button.dataset.permissionOptionKind === "allowAlways");
      option?.click();
      return Boolean(option);
    });

  if (!(await confirmAlwaysOption())) return false;
  return browser
    .waitUntil(
      async () => {
        const stillOpen = await hasV4PermissionDialog();
        if (stillOpen) {
          await confirmAlwaysOption();
          return false;
        }
        return true;
      },
      { timeout: 15000, timeoutMsg: "v4 项目始终允许后权限弹窗没有关闭" },
    )
    .then(() => true)
    .catch(() => false);
}

// ── M5 composer 工具条 / slash 面板 ──

/** 读取 composer 当前文本（Lexical E2E bridge）。bridge 未挂载返回 null。 */
export function getV4ComposerText(): Promise<string | null> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const bridge = (
      element as (HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }) | null
    )?.__zcodeLexicalInputE2E;
    return bridge ? bridge.getText() : null;
  }, TID_V4_COMPOSER_INPUT);
}

/** composer 本体或其 Lexical 子节点当前是否持有焦点。 */
export function isV4ComposerFocused(): Promise<boolean> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    return Boolean(element && document.activeElement && element.contains(document.activeElement));
  }, TID_V4_COMPOSER_INPUT);
}

/** 读取 composer 附件卡片的可观察文件名与 ready 状态。 */
export function getV4ComposerAttachments(): Promise<
  Array<{ text: string; kind: string | null; uploadStatus: string | null }>
> {
  return browser.execute(
    (attachmentPrefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${attachmentPrefix}-"]`))
        .filter((element) => element.hasAttribute("data-upload-status"))
        .map((element) => {
          // Bug 原因：媒体卡片按产品设计只展示缩略图，文件名在 img alt 中；读取
          // innerText 会把 ready 的图片误判成“附件没有进入 ready”。
          const mediaFilename = element.querySelector<HTMLImageElement>("img[alt]")?.alt.trim();
          return {
            text: mediaFilename || (element.innerText || element.textContent || "").trim(),
            kind: element.getAttribute("data-composer-attachment-kind"),
            uploadStatus: element.getAttribute("data-upload-status"),
          };
        }),
    TID_V4_ATTACHMENT,
  );
}

/** slash 候选面板是否出现。 */
export function hasV4SlashPanel(): Promise<boolean> {
  return browser.execute(
    (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
    TID_PROMPT_SUGGESTION_PANEL,
  );
}

/** 读取 slash 面板当前候选项 id（如 "slash:compact"）。 */
export function getV4SlashOptionIds(): Promise<string[]> {
  return browser.execute((optionPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`),
    ).map((element) => element.getAttribute("data-option-id") ?? "");
  }, TID_PROMPT_SUGGESTION_OPTION);
}

/** 等待 slash 面板出现且包含目标候选项。 */
export async function waitForV4SlashOption(optionId: string, timeout = 15000) {
  await browser.waitUntil(
    async () => (await hasV4SlashPanel()) && (await getV4SlashOptionIds()).includes(optionId),
    {
      timeout,
      timeoutMsg: `slash 面板没有出现候选项: ${optionId}`,
    },
  );
}

/**
 * 点选 slash 候选项。面板选项在 mousedown 上确认（preventDefault 防 blur），
 * element.click() 不派发 mousedown，这里显式 dispatch。
 */
export async function clickV4SlashOption(optionId: string) {
  const optionTestId = testId(TID_PROMPT_SUGGESTION_OPTION, optionId);
  let dispatched = false;
  await browser.waitUntil(
    async () => {
      // Bug 根因：Windows Skill option id 含反斜杠，动态 CSS selector 无法精确命中；
      // 同时 React 可能在候选加载时重挂载节点，所以定位与 mousedown 必须在一次查询内重试。
      dispatched = await browser.execute(dispatchMouseDownByExactTestId, optionTestId);
      return dispatched;
    },
    {
      timeout: 15000,
      timeoutMsg: `slash 面板候选项不可点击: ${optionId}`,
    },
  );
  return dispatched;
}

/** 通过 Composer 工具条切换草稿权限，显式确认进入完全访问。 */
export async function switchV4Mode(mode: string) {
  const previous = mode === "yolo" ? (await getV4ModelConfig()).mode : null;
  await selectRadixOption(
    TID_CHAT_MODE_SELECT_TRIGGER,
    testId(TID_CHAT_MODE_SELECT_ITEM, mode),
    `v4 模式选择器没有出现目标模式项: ${mode}`,
  );
  if (mode === "yolo" && previous !== "yolo") {
    const risk = $('[data-testid="yolo-confirmation-risk"]');
    await risk.waitForClickable();
    await risk.click();
    const confirm = $('[data-testid="yolo-confirmation-confirm"]');
    await confirm.waitForClickable();
    await confirm.click();
    await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed({ reverse: true });
  }
}

/** 读取 config 投影扩展锚点（data-mode / data-usage-*，M5 additive）。 */
export function getV4ConfigProjection(): Promise<{
  mode: string | null;
  planEnabled: boolean;
  usageUsed: number;
  usageMax: number;
}> {
  return browser.execute((modelTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
    return {
      mode: el?.getAttribute("data-mode") ?? null,
      usageUsed: Number(el?.getAttribute("data-usage-used") || 0),
      planEnabled: el?.getAttribute("data-plan-enabled") === "true",
      usageMax: Number(el?.getAttribute("data-usage-max") || 0),
    };
  }, TID_V4_MODEL_CONFIG);
}

// ── M5 composer mention（@/#/$）/ 附件 ──
// mention 面板与 slash 面板共用 TID_PROMPT_SUGGESTION_PANEL / _OPTION 契约，
// 故读取/点选原语与 slash 同源；option-id 前缀区分（file:/session:/skill:）。

/**
 * 等待 mention 面板出现且含以 prefix 打头的候选项（如 "session:"）。
 * 返回首个命中的完整 option-id。
 */
export async function waitForV4MentionOptionPrefix(
  prefix: string,
  timeout = 15000,
): Promise<string> {
  let matched: string | undefined;
  await browser.waitUntil(
    async () => {
      if (!(await hasV4SlashPanel())) return false;
      matched = (await getV4SlashOptionIds()).find((id) => id.startsWith(prefix));
      return Boolean(matched);
    },
    {
      timeout,
      timeoutMsg: `mention 面板没有出现以 "${prefix}" 打头的候选项`,
    },
  );
  return matched as string;
}

/** 经真实 paste 事件向 v4 composer 加入一个 File，并走既有 eager upload。 */
export async function pasteV4ComposerFileAttachment(
  filename = "e2e-pasted.png",
  options: { base64?: string; mimeType?: string; pngBase64?: string } = {},
): Promise<string> {
  const pasted = await browser.execute(
    (inputTestId, fileName, explicitBase64, explicitPngBase64, explicitMimeType) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const editable =
        input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
        (input?.getAttribute("contenteditable") === "true" ? input : null);
      if (!editable) return false;
      // 修复原因：旧 fixture 虽能被 file 识别为 PNG，但 production Jimp 会拒绝其尾部数据；
      // 使用已通过同一解码器验证的 1×1 PNG，避免图片 E2E 在业务读取前退化为占位文本。
      const imageBase64 =
        explicitBase64 ??
        explicitPngBase64 ??
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";
      const binary = atob(imageBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileName, { type: explicitMimeType ?? "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      editable.focus();
      editable.dispatchEvent(pasteEvent);
      return true;
    },
    TID_V4_COMPOSER_INPUT,
    filename,
    options.base64,
    options.pngBase64,
    options.mimeType,
  );
  if (!pasted) {
    throw new Error("v4 composer 输入框没有出现，无法派发粘贴事件");
  }
  return filename;
}

/** 向 v4 composer 派发图片文件；保留既有 case 的语义化入口。 */
export function pasteV4ComposerImageAttachment(
  filename = "e2e-pasted.png",
  options: { base64?: string; mimeType?: string; pngBase64?: string } = {},
): Promise<string> {
  return pasteV4ComposerFileAttachment(filename, options);
}

/** 等待某个 user 行渲染出附件簇，返回文件 pill 文本及媒体缩略图的可访问文件名。 */
export async function waitForV4RowAttachments(
  timeout = 60000,
  expectedNames: readonly string[] = [],
): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = await browser.execute((attachmentsPrefix) => {
        const el = document.querySelector<HTMLElement>(`[data-testid^="${attachmentsPrefix}-"]`);
        if (!el) return "";
        // Bug 原因：已发送媒体只有缩略图，文件名由 img alt 承载，不能用 innerText
        // 是否为空来判断附件簇有没有渲染。
        const visibleText = (el.innerText ?? "").trim();
        const mediaFilenames = Array.from(el.querySelectorAll<HTMLImageElement>("img[alt]"))
          .map((image) => image.alt.trim())
          .filter(Boolean);
        return [visibleText, ...mediaFilenames].filter(Boolean).join("\n");
      }, TID_V4_ROW_ATTACHMENTS);
      // 文本卡和媒体缩略图异步挂载；需要整组附件的 case 不能把第一张卡当作全组就绪。
      return text.trim().length > 0 && expectedNames.every((name) => text.includes(name));
    },
    { timeout, timeoutMsg: "user 行没有渲染出附件簇（TID_V4_ROW_ATTACHMENTS）" },
  );
  return text;
}
