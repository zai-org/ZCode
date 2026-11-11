// M4 门禁：forkAssistant（catalog E 组）。
// 证据层 L3：父会话完成态 assistant 行点 Fork → forkAssistant 命令 →
// v4-bridge 经 resolveStableForkTarget 把 targetRowId 固定到 logical turn 边界 →
// forkStableConversation → ACK.result.sessionId → pane 原地切到 child session（新
// sessionId，但历史含父会话内容）。证明稳定边界解析与 conversation-only fork 打通。
import { TID_V4_MODEL_CONFIG } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import { restartWithSeededOpenAIProviders } from "#e2e/helpers/custom-openai-provider";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  clickFirstV4Fork,
  getV4ModelConfig,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：forkAssistant", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完成态 assistant 行 fork → 切到 child session，历史含父内容", async () => {
    // 该 case 创建一个 case-local GLM-5.2 provider，既保留真实三档能力目录，
    // 又让模型请求严格命中本用例 replay fixture。
    await prepareGlm52Draft();

    await sendV4Prompt("E2E_V4_FORK_PARENT 说一句话");
    await waitForV4TimelineContaining("V4_FORK_PARENT_REPLY", 60000);

    const parent = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "父会话没有绑定 sessionId",
    );
    const parentSessionId = parent.sessionId;

    // E11/FX11：父会话的 runtime 模型是 GLM-5.2，case-local provider 的能力是
    // 非通用三档。先固定父侧基线，避免 child 与同一个错误 fallback 相等时产生假绿。
    const parentThoughtLevels = await readThoughtLevelValues();
    expect(parentThoughtLevels).toHaveLength(3);
    expect(parentThoughtLevels).toEqual(expect.arrayContaining(["high", "max"]));

    // completedSuccess 最终 assistant 行出现 Fork；入口完全由 row.actions.canFork
    // 与 availability.fork 投影决定，不再由 UI 猜 phase。
    await waitForV4Fork();
    const clicked = await clickFirstV4Fork();
    expect(clicked).toBe(true);

    // fork 成功 → forkAssistant ACK accepted，pane 原地切到 child（sessionId 变化）。
    // 证明：stable target 解析 + conversation-only fork + child sessionId 回填 + 选择切换。
    const child = await waitForV4Pane(
      (s) => s.sessionId !== null && s.sessionId !== "draft" && s.sessionId !== parentSessionId,
      "fork 后 pane 没有切到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    // Bug 回归：fork child 没有 legacy task config cache。旧 UI 因 session snapshot 不带
    // 模型能力，只能从 workspace catalog / 通用五档重建；线上表现为五档，本 fixture
    // 会被 custom provider catalog 遮成 off/high/max，但都不是 runtime 的 nothink/high/max。
    // sessionId 先于能力 snapshot 切换；读取瞬时空数组会误报，等待同一目标集合到达。
    await browser.waitUntil(
      async () => (await readThoughtLevelValues()).join(",") === "high,max,nothink",
      { timeout: 30000, timeoutMsg: "fork child 没有恢复父会话的三档思考能力" },
    );
    expect(await readThoughtLevelValues()).toEqual(["high", "max", "nothink"]);
    await browser.waitUntil(async () => (await getV4ModelConfig()).thought === "high", {
      timeout: 30000,
      timeoutMsg: "fork child 没有恢复父会话的 high 思考等级",
    });

    const childPrompt = "E2E_V4_FORK_CHILD 继续回答";
    await sendV4Prompt(childPrompt);
    const childRequest = await waitForUpstreamNetworkCapture("E2E_V4_FORK_CHILD");
    assertUpstreamRequestCapture(childRequest, {
      expectedText: childPrompt,
      model: "GLM-5.2",
    });
    // 修复原因：GLM-5.2 的 OpenAI-compatible 合同使用 reasoning_effort，
    // upstream capture 默认的 Anthropic Messages thinking.type 断言会把已成功返回的 GLM 请求误判为失败。
    const childRequestJson = childRequest.requestJson as Record<string, unknown>;
    expect(childRequestJson.reasoning_effort).toBe("high");
    expect(childRequestJson.thinking).toBeUndefined();
    // 修复原因：fork notice 原先没有 Attachment metadata，实际请求把它当成无标签 user 文本。
    const boundaryText = "This session was forked from a previous session message.";
    const messages = childRequestJson.messages as Array<{ role: string; content: string }>;
    const boundaryIndex = messages.findIndex((message) => message.content.includes(boundaryText));
    const questionIndex = messages.findIndex((message) => message.content.includes(childPrompt));
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeLessThan(questionIndex);
    const boundary = messages[boundaryIndex]!;
    expect(boundary.role).toBe("user");
    expect(boundary.content).toMatch(/^<system-reminder>\n/);
    expect(boundary.content).toMatch(/\n<\/system-reminder>$/);
    expect(boundary.content.match(/<system-reminder>/g)).toHaveLength(1);
    expect(JSON.stringify(messages).split(boundaryText)).toHaveLength(2);
    await waitForV4TimelineContaining("V4_FORK_CHILD_REPLY", 30000);

    // child 历史继承父会话内容：fork 复制 message 不复制 event，冷订阅 hydration 检测到
    // 事件日志覆盖不了 transcript，改用 transcript→event 合成重建投影（transcript-hydration）。
    // 这条断言验证 fork 复制到目标点 + transcript 合成 hydration 全链路。
    await waitForV4TimelineContaining("V4_FORK_PARENT_REPLY", 30000);
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.timelineText).toContain("E2E_V4_FORK_PARENT");
    expect(finalSnapshot.timelineText).not.toContain(boundaryText);
    expect(finalSnapshot.timelineText).not.toContain("<system-reminder>");
  });
});

async function prepareGlm52Draft(): Promise<void> {
  const modelId = "GLM-5.2";
  const providerId = "e2e-v4-fork-glm52-provider";
  const providerName = `V4 Fork GLM 5.2 E2E ${Date.now()}`;
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  // 修复原因：设置页保存完成与 active workspace registry 刷新不是同一屏障，
  // 紧接着发送会让真实请求仍落到旧 provider。进程退出后原子 seed App+CLI 再重启。
  const [provider] = await restartWithSeededOpenAIProviders([
    {
      modelId,
      providerId,
      providerName,
      // 个人模型夹具不会按名称继承 Built-in 能力，显式声明三档与请求参数。
      reasoningLevel: {
        values: ["nothink", "high", "max"],
        map: '{"reasoning_effort":reasoningLevel}',
      },
    },
  ]);
  if (!provider) throw new Error("V4 fork GLM-5.2 replay provider seed 失败");
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  await selectUpstreamProviderModelById(modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName,
  });
  await waitForUpstreamModelSelected(modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  await selectUpstreamThoughtLevelValue("high");
}

async function readThoughtLevelValues(): Promise<string[]> {
  return browser.execute((testId) => {
    const values = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.dataset
      .thoughtLevels;
    return (values ?? "").split(",").filter(Boolean).sort();
  }, TID_V4_MODEL_CONFIG);
}
