import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { seedCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider-store";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteContainerFile,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "#e2e/helpers/conversation-session-network";
import { hasAssistantReplyForUserTurn } from "#e2e/helpers/conversation-turn-evidence";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  SSH_LIFECYCLE_MODEL_ID,
  SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { prepareSSHConnectionPage } from "#e2e/helpers/ssh-remote-p0";
import {
  approveV4Permission,
  getV4Messages,
  hasV4PermissionDialog,
  sendV4PromptAndWaitAccepted,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

// DSYNC-09-05：推送内置 Explore 的模型覆盖后，远端已有 task 的下一轮 Explore 子请求使用推送的模型
// （docs/remote/data-sync.md「子智能体」，票 20）。模型请求经 SSH 反向隧道回到本机回放，
// 子请求的 model 字段就是远端 Agent 实际选用的模型。
const CASE_MARKER = "E2E_DSYNC_09_BUILTIN_RUNTIME";
const ALT_MODEL_ID = "e2e-dsync-09-alt-model";
const REMOTE_STATE_FILE = "/home/dev/.zcode/v2/agents-state.json";
const EXPLORE_KEY = "built-in:built-in:explore";
// 远端 Core 的子智能体监听在文件稳定 1000ms 后读取、再合并 300ms 才发布快照（docs/subagent-runtime-refresh.md）。
const SUBAGENT_PUBLISH_WINDOW_MS = 3_000;

async function readRowStatus(key: string): Promise<string | null> {
  return await browser.execute(
    (rowTestId) =>
      document.querySelector<HTMLElement>(`[data-testid="${rowTestId}"]`)?.dataset.syncStatus ??
      null,
    `remote-sync-row-${key}`,
  );
}

async function waitForRowStatus(key: string, status: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await readRowStatus(key)) === status, {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
}

/** 设置 → 数据同步 → 唯一在线设备 → 打开同步弹窗。 */
async function openDataSyncDialog(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
  });
  await waitForTestIdByDom("remote-sync-device-list", {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
  });
  await clickTestIdByDom("remote-sync-device-action");
  await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
}

/** 关闭同步弹窗和设置页，回到打开设置前的 task。 */
async function closeDataSyncDialogAndSettings(): Promise<void> {
  // 关闭按钮只在概览页底栏。
  await clickTestIdByDom("remote-sync-tab-overview", { timeout: 30_000 });
  await clickTestIdByDom("remote-sync-close", { timeout: 30_000 });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 30_000 });
  await browser.waitUntil(
    async () => !(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 设置页没有关闭` },
  );
}

/** 在当前 task 里让模型调用 Explore，返回这一轮 Explore 子请求使用的模型。 */
async function runExplore(key: string): Promise<Array<string | null>> {
  const prompt = `${CASE_MARKER}_RUN_${key}`;
  const done = `DSYNC_09_RUN_${key}_DONE`;
  const start = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${prompt}: 用 Agent 工具运行 Explore，然后只回复 ${done}`,
    prompt,
    `${CASE_MARKER}: ${key} 没有被接受`,
  );
  await browser.waitUntil(
    async () => {
      if (await hasV4PermissionDialog()) await approveV4Permission();
      return hasAssistantReplyForUserTurn(await getV4Messages(), prompt, done);
    },
    { timeout: SSH_LIFECYCLE_TURN_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: ${key} 没有最终回复` },
  );
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${CASE_MARKER}: ${key} 没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  const childRequests = await getUpstreamRequestEvidence(
    { lastUserMessageIncludes: [`E2E_EXPLORE_PROBE_${key}`] },
    { afterIndex: start - 1 },
  );
  return childRequests.map(
    (request) => (request.requestJson as { model?: string } | null)?.model ?? null,
  );
}

describe(`${CASE_MARKER}: 推送内置子智能体模型覆盖后远端生效`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-09-05 推送 Explore 模型覆盖后，远端已有 task 的下一轮 Explore 使用推送的模型", async function () {
    this.timeout(30 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const container = readRemoteDockerContainer(CASE_MARKER);

    // 第二个本机 Personal Provider：连接时随 Provisioning 下发到远端，作为 Explore 覆盖的目标。
    const alt = await seedCustomOpenAIChatCompletionsProvider({
      baseURL: provider.tunnel.baseURL,
      modelId: ALT_MODEL_ID,
      providerId: `e2e-dsync-09-alt-${Date.now()}`,
      providerName: `DSYNC 09 alt ${Date.now()}`,
    });
    await refreshSeededOpenAIProvidersThroughSettings([alt.name]);

    await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: prepared.config.workspacePaths[0],
    });

    // 推送前：远端没有覆盖，Explore 继承父会话模型。
    await execInRemoteContainer(container, ["rm", "-f", REMOTE_STATE_FILE]);
    await browser.pause(SUBAGENT_PUBLISH_WINDOW_MS);
    expect(await runExplore("BEFORE")).toEqual([SSH_LIFECYCLE_MODEL_ID]);

    // 本机给 Explore 选 alt 模型（e2e 模型只有 disabled 一个推理档位），经数据同步弹窗推送。
    const exploreOverride = {
      providerId: alt.id,
      modelId: ALT_MODEL_ID,
      options: { reasoningLevel: "disabled" },
    };
    const localStateDir = join(getE2EAppDataPaths().homeDir, ".zcode", "v2");
    await mkdir(localStateDir, { recursive: true });
    await writeFile(
      join(localStateDir, "agents-state.json"),
      `${JSON.stringify(
        {
          disabledAgentIds: [],
          builtInModelSelectionOverrides: { Explore: exploreOverride },
          pluginAgentModelSelectionOverrides: {},
        },
        null,
        2,
      )}\n`,
    );
    await openDataSyncDialog();
    await clickTestIdByDom("remote-sync-tab-subagents", { timeout: 60_000 });
    await waitForRowStatus(EXPLORE_KEY, "push", "Explore 覆盖没有显示为「推送」");
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送子智能体按钮不可用`,
    });
    await waitForRowStatus(EXPLORE_KEY, "synced", "推送后 Explore 覆盖没有变为「已同步」");
    const pushedAt = Date.now();
    const remoteState = JSON.parse(await readRemoteContainerFile(container, REMOTE_STATE_FILE)) as {
      builtInModelSelectionOverrides?: unknown;
    };
    expect(remoteState.builtInModelSelectionOverrides).toEqual({ Explore: exploreOverride });

    // 回到推送前已有的 task A，不重开项目、不重启远端 Agent：下一轮 Explore 用推送的模型。
    await closeDataSyncDialogAndSettings();
    await browser.pause(Math.max(0, SUBAGENT_PUBLISH_WINDOW_MS - (Date.now() - pushedAt)));
    expect(await runExplore("AFTER")).toEqual([ALT_MODEL_ID]);
  });
});
