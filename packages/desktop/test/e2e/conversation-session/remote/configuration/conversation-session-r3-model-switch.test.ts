import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomAnthropicMessagesProvider,
} from "#e2e/helpers/custom-openai-provider";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readRemoteTabSnapshot, runSSHCommand, waitForRemoteTab } from "#e2e/helpers/ssh-remote-p0";
import {
  clickFirstV4Fork,
  editFirstV4UserQuery,
  getV4ConversationState,
  sendV4Prompt,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_MODEL_SWITCH";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-model-switch");
const PROVIDER_B_ID = "e2e-r3-model-switch-b";
const PROVIDER_B_NAME = "R3 Model Switch B";
const MODEL_B_ID = "e2e-r3-model-b";

describe(`${CASE_MARKER}: 慢回合中切换模型、fork/edit 与远端历史`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "model-switch.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-PRV-14/TASK-04 Model A 慢回合期间切到 B：A 请求体保持 A、下一回合请求体为 B；fork/edit 在远端保持历史与身份", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    // 第二个 provider/model（同回放隧道），首连同步前写入以便一次下发。
    await seedCustomAnthropicMessagesProvider({
      baseURL: `${provider.tunnel.baseURL}/anthropic`,
      modelId: MODEL_B_ID,
      providerId: PROVIDER_B_ID,
      providerName: PROVIDER_B_NAME,
    });
    await refreshSeededOpenAIProvidersThroughSettings([PROVIDER_B_NAME]);
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const remoteConfig = await runSSHCommand(
      prepared.config,
      'cat "$HOME/.zcode/v2/provider_config.json"',
    );
    expect(remoteConfig.stdout).toContain(PROVIDER_B_NAME);

    // PRV-14：Model A 慢回合 running 时切换到 Model B。
    const slowStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_SLOW 慢慢回答`);
    await waitForV4TimelineContaining("R3_SWITCH_STREAMING", 60_000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId === taskA.taskId,
      "A 没有进入 running",
      45_000,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`] },
      `${CASE_MARKER}: 慢回合请求体不是 Model A`,
      30_000,
      { afterIndex: slowStart - 1 },
    );
    await selectUpstreamProviderModelById(MODEL_B_ID, {
      includePlainModelFallback: false,
      providerId: PROVIDER_B_ID,
      providerName: PROVIDER_B_NAME,
    });
    // 自定义模型的 reasoningLevel 需显式选择，否则 composer 提交配置无效、发送键保持禁用。
    await selectUpstreamThoughtLevelValue("disabled");
    facts.switchedDuringRunning = (await getV4ConversationState()).state;
    expect(facts.switchedDuringRunning).toBe("streaming");
    await releaseControlledReplay("r3-switch-slow");
    // 慢回合按 A 的静态配置收口，不被切换打断。
    await waitForV4AssistantMessageContaining("R3_SWITCH_STREAMING", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 慢回合没有收口`,
      120_000,
    );
    const slowRequests = await getUpstreamRequestEvidence(
      {
        lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`],
        excludes: ["CRITICAL: Respond with TEXT ONLY"],
      },
      { afterIndex: slowStart - 1 },
    );
    expect(slowRequests).toHaveLength(1);
    expect(slowRequests[0]!.requestJson).toMatchObject({ model: SSH_LIFECYCLE_MODEL_ID });
    facts.slowRequestModelIsA = true;
    // 同 Session 下一普通回合：请求体 model 必须是 B。
    const nextStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_NEXT 请回复`,
      `${CASE_MARKER}_NEXT`,
      `${CASE_MARKER}: 切换后下一回合未被接受`,
    );
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [`${CASE_MARKER}_NEXT`],
        includes: [taskA.firstPrompt],
      },
      `${CASE_MARKER}: 下一回合请求体不是 Model B 或丢失历史`,
      60_000,
      { afterIndex: nextStart - 1 },
    );
    const nextRequests = await getUpstreamRequestEvidence(
      {
        lastUserMessageIncludes: [`${CASE_MARKER}_NEXT`],
        excludes: ["CRITICAL: Respond with TEXT ONLY"],
      },
      { afterIndex: nextStart - 1 },
    );
    expect(nextRequests).toHaveLength(1);
    expect(nextRequests[0]!.requestJson).toMatchObject({ model: MODEL_B_ID });
    facts.nextRequestModelIsB = true;
    await waitForV4AssistantMessageContaining("R3_MODEL_B_REPLY", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: B 回合没有收口`,
      60_000,
    );

    // TASK-04：fork 已完成 session → 新 session 同 Source、含父历史；edit 首条用户输入 → 请求上下文更新。
    await waitForV4Fork(30_000);
    expect(await clickFirstV4Fork()).toBe(true);
    let forkedTaskId = "";
    await browser.waitUntil(
      async () => {
        const state = await getV4ConversationState();
        if (state.taskId && state.taskId !== taskA.taskId && state.taskId !== "draft") {
          forkedTaskId = state.taskId;
          return true;
        }
        return false;
      },
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: fork 没有产生新 session` },
    );
    const forkTab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    expect(forkTab.remoteSessionId).toBe(taskA.remoteSessionId);
    const forkStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_FORK 请回复`,
      `${CASE_MARKER}_FORK`,
      `${CASE_MARKER}: fork 续发未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_FORK`], includes: [taskA.firstPrompt] },
      `${CASE_MARKER}: fork 子会话请求缺少父历史`,
      60_000,
      { afterIndex: forkStart - 1 },
    );
    await waitForV4ConversationState(
      (s) => s.taskId === forkedTaskId && s.state === "idle",
      `${CASE_MARKER}: fork 回合没有收口`,
      90_000,
    );
    facts.fork = { parent: taskA.taskId, child: forkedTaskId };

    const editStart = await getUpstreamRequestRecordCount();
    const editedText = `${CASE_MARKER}_EDITED 请回复`;
    await editFirstV4UserQuery(editedText);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_EDITED`], excludes: [`${CASE_MARKER}_FORK`] },
      `${CASE_MARKER}: edit 后请求上下文未按编辑后内容重放`,
      60_000,
      { afterIndex: editStart - 1 },
    );
    await waitForV4ConversationState(
      (s) => s.state === "idle",
      `${CASE_MARKER}: edit 回合没有收口`,
      90_000,
    );
    facts.editRequestReplayedFromEditedQuery = true;
    expect((await readRemoteTabSnapshot(taskA.identity)).secretPersistedInTab).toBe(false);
  });
});
