import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { importLiveBigModelCredentials } from "#e2e/helpers/live-bigmodel-profile";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData, getE2EAppDataPaths, seedSettings } from "#e2e/helpers/desktop-app";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import { getUpstreamRequestRecordCount } from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_LIVE_TEAM";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-live-team");
const TEAM_PROVIDER_ID = "account:bigmodel-team-coding-plan";
// 原小写 API 名称无法匹配当前菜单与运行记录使用的规范 Model ID。
const TEAM_MODEL_ID = "GLM-5.3-Flash";

async function readRemoteModelNetwork(config: SSHConnectionConfig, startedAt: string) {
  const result = await runSSHCommand(
    config,
    // 只回收网络阶段、模型身份和状态；凭据、请求头、prompt 不进入 E2E facts。
    `cat "$HOME/.zcode/cli/log/"*.jsonl 2>/dev/null | awk -v since="${startedAt}" -F'"timestamp":"' 'substr($2,1,24) >= since' | grep -E '"event":"model\\.network\\.' | while IFS= read -r line; do printf '%s\\n' "$line" | grep -oE '"(timestamp|event|modelId|providerId|providerKind|baseURL|status|statusCode|responseStatus|durationMs|finishReason|errorCode|retryCount)":"?[^,"}]*' | paste -sd '\t' -; done`,
  );
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe(`${CASE_MARKER}: 账号 Coding Plan 代表（BigModel Team / glm-5.3-flash）经 Provisioning 到达 SSH 目标并真实请求`, () => {
  const facts: Record<string, unknown> = {};
  let remoteConfig: SSHConnectionConfig | undefined;
  let requestStartedAt: string | undefined;

  after(async () => {
    // 超时也要在 runner 删除目标容器前保存远端阶段，不能只采集成功请求。
    if (remoteConfig && requestStartedAt) {
      try {
        facts.remoteModelNetwork = await readRemoteModelNetwork(remoteConfig, requestStartedAt);
      } catch (error) {
        facts.remoteModelNetworkCollectionError = String(error);
      }
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "live-team.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-LIVE-02 本地账号窄设置与 OAuth provisioning 后，远端换证完成 Team 真实请求", async function () {
    this.timeout(30 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    remoteConfig = config;
    const workspaceA = config.workspacePaths[0];
    // 与 local-download-proxy 同序：先写隔离 profile 的凭据与窄设置，再冷启动，再进入默认工作区。
    const imported = await importLiveBigModelCredentials(CASE_MARKER);
    facts.imported = imported;
    // 方案 A（§46 附记二轮实锤后收敛）：已登录冷启无论 settings 合法与否都落在
    // conversation backing workspace（首启分支或 conversation 会话恢复），其空草稿
    // 不渲染 workspace 菜单（SessionPane 仅 isDraft 挂 contextHeader），远程连接入口
    // 不可达。本 case 的目标是 provisioning + 远端真实请求，非 conversation 工作区 UI——
    // 显式 seed 项目会话并预建目录，让 reloadSession 后与全批其它 case 同路径恢复
    // ZCodeProject（产品已不再自动创建该目录，见 startupWorkspace 注释）。
    const defaultWorkspace = resolve(getE2EAppDataPaths().homeDir, "ZCodeProject");
    await mkdir(defaultWorkspace, { recursive: true });
    await seedSettings({
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: { bigmodel: imported.teamSelection },
      lastWorkspaceSession: [
        { kind: "local", workspacePath: defaultWorkspace, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    } as never);
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    // 先验证同一真实账号在本机可见目标模型，区分账号前置不可用与 SSH 同步/远端解析问题。
    try {
      await selectUpstreamProviderModelById(TEAM_MODEL_ID, {
        includePlainModelFallback: false,
        providerId: TEAM_PROVIDER_ID,
        providerName: "BigModel",
      });
      facts.localAccountModelReady = TEAM_MODEL_ID;
    } catch (error) {
      facts.localAccountModelUnavailable = true;
      throw new Error(`${CASE_MARKER}: BLOCKED_ACCOUNT 本机真实账号的 Team 模型未就绪`, {
        cause: error,
      });
    }

    const startedAt = new Date().toISOString();
    requestStartedAt = startedAt;
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath: workspaceA });
    const remoteSettings = await runSSHCommand(config, 'cat "$HOME/.zcode/v2/setting.json"');
    expect(remoteSettings.stdout).toContain('"providerFamilyDomain": "bigmodel"');
    // 远端只保证自带运行时，不要求全局 node；原 tr 会连同键名内部的冒号一起删除。
    const remoteCredentialKeys = await runSSHCommand(
      config,
      `grep -o '"[^"]*":' "$HOME/.zcode/v2/credentials.json" | sed -E 's/^"//; s/":$//'`,
    );
    facts.remoteCredentialKeys = remoteCredentialKeys.stdout.trim().split("\n").filter(Boolean);
    // 当前合同只下发 OAuth 登录态，Team 请求在远端换证；旧 API Key 的落盘断言已过时。
    expect(remoteCredentialKeys.stdout).not.toContain("account-provider:coding-plan:");
    expect(remoteCredentialKeys.stdout).toContain("oauth:active_provider");
    expect(remoteCredentialKeys.stdout).toContain("oauth:bigmodel:access_token");

    await selectUpstreamProviderModelById(TEAM_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: TEAM_PROVIDER_ID,
      providerName: "BigModel",
    });
    // 项目创建已打开所属 Source 的草稿；全局新建会改为本地未分类任务。
    const replayBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_FIRST 请只回复 TEAM1，不要其它内容`,
      `${CASE_MARKER}_FIRST`,
      `${CASE_MARKER}: 首发未被接受`,
    );
    const running = await waitForV4ConversationState(
      (s) => Boolean(s.taskId && s.taskId !== "draft"),
      `${CASE_MARKER}: 首发没有产生 task`,
      60_000,
    );
    await waitForV4ConversationState(
      (s) => s.taskId === running.taskId && s.state === "idle" && s.queueCount === 0,
      `${CASE_MARKER}: 真实首发没有收口`,
      180_000,
    );
    // 用户 prompt 本身含 TEAM1；只有 assistant 正文能证明模型实际返回。
    await browser.waitUntil(
      async () =>
        (await getV4Messages("assistant")).some((message) => /TEAM\s*1/u.test(message.text ?? "")),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: assistant 未返回 TEAM1` },
    );
    const text = (await getV4Messages("assistant")).map((message) => message.text ?? "").join("\n");
    facts.replyContainsMarker = /TEAM\s*1/u.test(text);
    expect(text).toMatch(/TEAM\s*1/u);
    expect(await getUpstreamRequestRecordCount()).toBe(replayBefore);
    expect(await readHostProcesses()).toEqual(initialHosts);

    const remoteRequests = await readRemoteModelNetwork(config, startedAt);
    facts.remoteModelNetwork = remoteRequests;
    const completed = remoteRequests.find((row) => {
      const fields = row.split("\t");
      return [
        '"event":"model.network.completed',
        `"providerId":"${TEAM_PROVIDER_ID}`,
        `"modelId":"${TEAM_MODEL_ID}`,
      ].every((field) => fields.includes(field));
    });
    expect(completed).toBeDefined();
    expect(completed).toContain('"baseURL":"https://open.bigmodel.cn/api/anthropic');
  });
});
