import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { getV4ComposerDraftScopeSnapshot } from "#e2e/helpers/conversation-session-store";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  getUpstreamProviderModelValues,
  getUpstreamThoughtLevelLabels,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
  getV4ModelConfig,
  selectV4TaskById,
  switchV4Mode,
} from "#e2e/helpers/v4-conversation";

describe("会话区草稿模型切换首发 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I10/I47/I52: 首发冻结 Composer 选择，接纳后及冷重启继续保留", async function () {
    this.timeout(260000);

    await prepareV4ConversationE2E();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state === "idle" &&
        snapshot.sessionId === null &&
        snapshot.taskId === null &&
        snapshot.queueCount === 0,
      "草稿切模型 case 没有处于空草稿态",
      30000,
    );

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await assertSelectedSecondaryConfig();

    const runId = Date.now();
    const marker = `E2E_DRAFT_MODEL_SWITCH_FIRST_SEND_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "草稿切模型 case 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    const captureRecord = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(captureRecord, {
      expectedText: prompt,
      model: UPSTREAM_SECONDARY_MODEL,
    });
    if (UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
      assertUpstreamThoughtLevelCapture(captureRecord, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    }

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    const completed = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "草稿切模型 case 首轮完成后没有回到 idle",
      90000,
    );
    const sessionId = completed.sessionId ?? completed.taskId;
    if (!sessionId) throw new Error("草稿切模型 case 首轮完成后缺少 sessionId");

    // 已接纳的执行模型仍是 secondary；此后只修改 Composer，不能提前改写 Session。
    await assertSelectedSecondaryConfig();
    await selectUpstreamModelById(UPSTREAM_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });
    // 当前菜单使用 Build；Edit 仅供恢复历史草稿，不再作为新选择入口。
    await switchV4Mode("build");
    // 非空正文草稿才保存选项；保留未发送内容后验证同一 session scope 的冷恢复。
    const retainedDraftText = `E2E_DRAFT_MODEL_SWITCH_RETAINED_${runId}`;
    await setV4ComposerText(retainedDraftText);
    await waitForComposerConfig(UPSTREAM_MODEL, "build");
    // 修复原因：Composer 正文按 350ms 防抖落盘，配置已就绪时 waitForComposerConfig 立即返回，
    // 直接读 localStorage 会早于落盘。等待持久化草稿真实出现，失败时带回全部 scope 便于定位。
    let beforeRestartDraft = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, sessionId);
    try {
      await browser.waitUntil(
        async () => {
          beforeRestartDraft = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, sessionId);
          return beforeRestartDraft.exists && beforeRestartDraft.text === retainedDraftText;
        },
        { timeout: 10000, timeoutMsg: "Session scope 草稿没有落盘" },
      );
    } catch (error) {
      const scopes = await browser.execute(
        (key) =>
          Object.keys(
            (JSON.parse(window.localStorage.getItem(key) ?? "{}") as { scopes?: object }).scopes ??
              {},
          ),
        `zcode-v4-composer-drafts:v1:${encodeURIComponent(DEFAULT_WORKSPACE)}`,
      );
      throw new Error(
        `Session scope 草稿没有落盘; sessionId=${sessionId}; scopes=${JSON.stringify(scopes)}`,
        { cause: error },
      );
    }
    expect(beforeRestartDraft).toMatchObject({
      exists: true,
      text: retainedDraftText,
      mode: "build",
      modelSelection: {
        modelId: UPSTREAM_MODEL,
        providerId: UPSTREAM_PROVIDER_ID,
      },
    });
    // 完整重启 Electron/Host/CLI 后，未发送的 Session-scope Composer Draft 仍是唯一恢复源。
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterReloadSession();
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(sessionId);
    expect(await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, sessionId)).toMatchObject({
      exists: true,
      text: retainedDraftText,
      mode: "build",
      modelSelection: {
        modelId: UPSTREAM_MODEL,
        providerId: UPSTREAM_PROVIDER_ID,
      },
    });
    await waitForComposerConfig(UPSTREAM_MODEL, "build");
  });
});

async function waitForComposerConfig(model: string, mode: string) {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.source === "composer" &&
        latest.provider === UPSTREAM_PROVIDER_ID &&
        latest.model === model &&
        latest.mode === mode
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `Composer 配置没有恢复: ${JSON.stringify({ expected: { model, mode }, latest })}`,
    },
  );
}

async function assertSelectedSecondaryConfig() {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = getUpstreamProviderModelValues(UPSTREAM_SECONDARY_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
  const modelSelected =
    acceptedModelValues.includes(modelLabel.currentValue) ||
    modelLabel.text.includes(UPSTREAM_SECONDARY_MODEL) ||
    modelLabel.title.includes(UPSTREAM_SECONDARY_MODEL);
  if (!modelSelected) {
    throw new Error(
      `草稿当前模型不是 secondary 上游 模型: ${JSON.stringify({
        acceptedModelValues,
        model: UPSTREAM_SECONDARY_MODEL,
        modelLabel,
      })}`,
    );
  }

  if (!UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
    return;
  }
  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const acceptedThoughtValues = [
    UPSTREAM_SECONDARY_THOUGHT_LEVEL,
    ...getUpstreamThoughtLevelLabels(UPSTREAM_SECONDARY_THOUGHT_LEVEL),
  ].map((value) => value.toLowerCase());
  const currentThoughtCandidates = [
    thoughtLabel.currentValue,
    thoughtLabel.ariaLabel,
    thoughtLabel.text,
    thoughtLabel.title,
  ].map((value) => value.replace(/\s+/g, " ").trim().toLowerCase());
  if (!currentThoughtCandidates.some((candidate) => acceptedThoughtValues.includes(candidate))) {
    throw new Error(
      `草稿当前思考深度不是 secondary 配置: ${JSON.stringify({
        acceptedThoughtValues,
        thoughtLabel,
      })}`,
    );
  }
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const target = puppeteer
          .targets()
          .filter((candidate) => isRendererUrl(candidate.url()))
          .at(-1) as ({ _targetId?: string } & object) | undefined;
        if (!target?._targetId) return false;
        await browser.switchToWindow(target._targetId);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: "Composer Draft 冷重启后没有找到 renderer target",
    },
  );
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}
