import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import { getTaskStoreSnapshot } from "#e2e/helpers/conversation-session-store";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import {
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  getV4ComposerText,
  getV4ConversationState,
  getV4Messages,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const FAIL_MARKER = "E2E_MODEL_SWITCH_RESTORE_REPRO_FAIL";
const SUCCESS_MARKER = "E2E_MODEL_SWITCH_RESTORE_REPRO_SUCCESS";
const ASSISTANT_TOKEN = "E2E_MODEL_SWITCH_RESTORE_REPRO_ASSISTANT_VISIBLE";

describe("会话区模型配置恢复吞消息复现探针", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("失败态后不切配置直接发送成功，确认 429 后续消息是否会被吞", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const failingPrompt = `${FAIL_MARKER}_${runId}: trigger quota-like failure.`;
    await sendPromptAndRequireUser(failingPrompt, "restore repro direct: 失败态 prompt");
    await waitForSessionSettled("restore repro: 失败态没有收口");

    const successPrompt = `${SUCCESS_MARKER}_${runId}: reply with the repro token.`;
    await sendPromptAndRequireUser(successPrompt, "restore repro direct: 429 后成功 prompt");
    await assertAssistantSurvivesRendererReload(successPrompt);
  });

  it("失败态后切思考深度发送成功，renderer reload 后 assistant 应仍可见", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const failingPrompt = `${FAIL_MARKER}_${runId}: trigger quota-like failure.`;
    await sendPromptAndRequireUser(failingPrompt, "restore repro switch: 失败态 prompt");
    await waitForSessionSettled("restore repro: 失败态没有收口");

    if (UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
      await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    }

    const successPrompt = `${SUCCESS_MARKER}_${runId}: reply with the repro token.`;
    await sendPromptAndRequireUser(successPrompt, "restore repro switch: 切思考深度后成功 prompt");
    await assertAssistantSurvivesRendererReload(successPrompt);
  });

  it("切模型配置成功回复后 renderer 重建并选择 task 仍应显示 assistant", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);

    const runId = Date.now();
    const successPrompt = `${SUCCESS_MARKER}_${runId}: reply with the repro token.`;
    await sendPromptAndRequireUser(successPrompt, "restore repro success-only: 成功 prompt");
    await assertAssistantSurvivesRendererReload(successPrompt);
  });

  it("切模型配置成功回复后 WDIO session 重建并选择 task 仍应显示 assistant", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);

    const runId = Date.now();
    const successPrompt = `${SUCCESS_MARKER}_${runId}: reply with the repro token.`;
    await sendPromptAndRequireUser(successPrompt, "restore repro app-session: 成功 prompt");
    await assertAssistantSurvivesAppSessionReload(successPrompt);
  });
});

async function sendPromptAndRequireUser(prompt: string, label: string) {
  try {
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", `${label} 发送后输入框没有清空`);
    await browser.waitUntil(
      async () => (await getV4Messages("user")).some((message) => message.text.includes(prompt)),
      {
        timeout: 20000,
        timeoutMsg: `${label} 没有进入可见 user 消息`,
      },
    );
  } catch (error) {
    throw new Error(
      [
        `${label} 发送/投影失败`,
        `prompt=${prompt}`,
        `diagnostics=${JSON.stringify(await collectReproDiagnostics())}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

async function assertAssistantSurvivesRendererReload(successPrompt: string) {
  await waitForV4AssistantMessageContaining(ASSISTANT_TOKEN);
  const settled = await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "restore repro: 成功回复后没有回到 idle",
    90000,
  );
  const sessionId = settled.sessionId || settled.taskId;
  if (!sessionId) {
    throw new Error(`restore repro: 成功回复后没有 sessionId: ${JSON.stringify(settled)}`);
  }

  const beforeReload = {
    root: await getV4ConversationState(),
    messages: await getV4Messages(),
    store: await getTaskStoreSnapshot(sessionId),
  };
  expect(beforeReload.messages.some((message) => message.text.includes(ASSISTANT_TOKEN))).toBe(
    true,
  );

  // 复现原因：用户日志里 provider/runtime 已经产出并持久化回复，疑点在 renderer
  // 重建后的 desktop-continuous 历史恢复/投影。先用 renderer reload 触发同一类 UI 重建路径。
  await reloadRendererAndRestoreSession(sessionId);

  let afterReload = {
    root: await getV4ConversationState(),
    messages: await getV4Messages(),
    store: await getTaskStoreSnapshot(sessionId),
  };
  await browser
    .waitUntil(
      async () => {
        afterReload = {
          root: await getV4ConversationState(),
          messages: await getV4Messages(),
          store: await getTaskStoreSnapshot(sessionId),
        };
        return afterReload.messages.some((message) => message.text.includes(ASSISTANT_TOKEN));
      },
      {
        timeout: 30000,
        interval: 500,
        timeoutMsg: "restore repro: reload 后等待 assistant token 超时",
      },
    )
    .catch(() => undefined);
  const visibleText = afterReload.messages.map((message) => message.text).join("\n");
  if (!visibleText.includes(ASSISTANT_TOKEN)) {
    throw new Error(
      [
        "restore repro: reload 后 assistant token 不可见",
        `prompt=${successPrompt}`,
        `token=${ASSISTANT_TOKEN}`,
        `before=${JSON.stringify(beforeReload)}`,
        `after=${JSON.stringify(afterReload)}`,
      ].join("\n"),
    );
  }
}

async function waitForSessionSettled(timeoutMsg: string) {
  await waitForV4ConversationState(
    (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
    timeoutMsg,
    90000,
  );
}

async function reloadRendererAndRestoreSession(sessionId: string) {
  await browser.execute(() => {
    window.location.reload();
  });
  await waitForDefaultWorkspaceReady(30000);
  await selectV4TaskById(sessionId);
  await waitForV4ConversationState(
    (snapshot) =>
      (snapshot.sessionId === sessionId || snapshot.taskId === sessionId) &&
      snapshot.runtimeStatus !== "restoring",
    `restore repro: reload 后没有恢复到 session ${sessionId}`,
    60000,
  );
}

async function assertAssistantSurvivesAppSessionReload(successPrompt: string) {
  await waitForV4AssistantMessageContaining(ASSISTANT_TOKEN);
  const settled = await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "restore repro: app session 重建前没有回到 idle",
    90000,
  );
  const sessionId = settled.sessionId || settled.taskId;
  if (!sessionId) {
    throw new Error(`restore repro: app session 重建前没有 sessionId: ${JSON.stringify(settled)}`);
  }

  const beforeReload = {
    root: await getV4ConversationState(),
    messages: await getV4Messages(),
    store: await getTaskStoreSnapshot(sessionId),
  };
  expect(beforeReload.messages.some((message) => message.text.includes(ASSISTANT_TOKEN))).toBe(
    true,
  );

  await browser.reloadSession();
  await waitForAnyRendererReadyAfterReloadSession();
  await waitForDefaultWorkspaceReady(60000);
  await selectV4TaskById(sessionId, 60000);
  await waitForV4ConversationState(
    (snapshot) =>
      (snapshot.sessionId === sessionId || snapshot.taskId === sessionId) &&
      snapshot.runtimeStatus !== "restoring",
    `restore repro: app session 重建后没有恢复到 session ${sessionId}`,
    60000,
  );

  let afterReload = {
    root: await getV4ConversationState(),
    messages: await getV4Messages(),
    store: await getTaskStoreSnapshot(sessionId),
  };
  await browser
    .waitUntil(
      async () => {
        afterReload = {
          root: await getV4ConversationState(),
          messages: await getV4Messages(),
          store: await getTaskStoreSnapshot(sessionId),
        };
        return afterReload.messages.some((message) => message.text.includes(ASSISTANT_TOKEN));
      },
      {
        timeout: 30000,
        interval: 500,
        timeoutMsg: "restore repro: app session 重建后等待 assistant token 超时",
      },
    )
    .catch(() => undefined);
  const visibleText = afterReload.messages.map((message) => message.text).join("\n");
  if (!visibleText.includes(ASSISTANT_TOKEN)) {
    throw new Error(
      [
        "restore repro: app session 重建后 assistant token 不可见",
        `prompt=${successPrompt}`,
        `token=${ASSISTANT_TOKEN}`,
        `before=${JSON.stringify(beforeReload)}`,
        `after=${JSON.stringify(afterReload)}`,
      ].join("\n"),
    );
  }
}

async function waitForAnyRendererReadyAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => isRendererUrl(target.url()))
          .at(-1);
        const targetId = rendererTarget
          ? ((rendererTarget as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) {
          return false;
        }
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        // Bugfix: reloadSession 后旧 CDP websocket 会短暂断开，等待 renderer 时应重试。
        return false;
      }
    },
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: "restore repro: app session 重建后没有找到 renderer target",
    },
  );
  // Bug 根因：reloadSession 后已存在的 V4 renderer 不渲染 legacy chat-view；
  // renderer target 可操作后交给 workspace/V4 task 屏障判断，不能用旧 DOM 锚点误报冷启动失败。
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

async function collectReproDiagnostics(sessionId?: string) {
  return {
    root: await getV4ConversationState(),
    composer: await getV4ComposerText(),
    messages: await getV4Messages(),
    store: sessionId ? await getTaskStoreSnapshot(sessionId) : null,
    toasts: await getToastMessages(),
  };
}
