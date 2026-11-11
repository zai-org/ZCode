import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

import * as v4 from "#e2e/helpers/v4-conversation";
import * as ssh from "#e2e/helpers/ssh-remote-p0";
import * as app from "#e2e/helpers/desktop-app";
import * as provider from "#e2e/helpers/custom-openai-provider";
import * as models from "#e2e/helpers/upstream-provider";
import * as network from "#e2e/helpers/conversation-session-network";
import * as recorder from "#e2e/helpers/electron-window-recorder";

const marker = "E2E_R3_SSH_READY";
const providerId = "e2e-r3-ssh-ready";
const providerName = "R3 SSH Ready";
const modelId = "e2e-r3-ssh-ready-model";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-ssh-ready");
let tunnel: { baseURL: string; close(): Promise<void> } | undefined;

describe(`${marker}: Provider 首连与远端项目对话`, () => {
  after(async () => {
    await tunnel?.close();
    await browser.electron.restoreAllMocks();
    await app.clearAppData();
  });

  it("完整 Personal fixture 经首连同步后，在真实 SSH 项目 中首发并完成", async function () {
    this.timeout(5 * 60_000);
    const config = ssh.readSSHRuntimeConfig(marker);
    await v4.prepareV4ConversationE2E({ skipProvider: true });
    const activeTunnel = await ssh.createSSHReplayTunnel(config, marker);
    tunnel = activeTunnel;
    // 根因：seed helper 已改读 runtime Base URL，旧环境变量覆盖不再生效；远端误连本机 loopback 端口。
    // 与其他 SSH lifecycle case 一样，明确写入独立反向隧道的远端地址。
    await provider.seedCustomOpenAIChatCompletionsProvider({
      providerId,
      providerName,
      modelId,
      baseURL: activeTunnel.baseURL,
    });
    await provider.refreshSeededOpenAIProvidersThroughSettings([providerName]);
    await mkdir(artifactDir, { recursive: true });
    // 不打开 Process Monitor，保证显式录制持续绑定主窗口。
    const recording =
      process.env.ZCODE_E2E_FAILURE_ARTIFACTS === "1"
        ? undefined
        : await recorder.startElectronWindowRecording({
            outputPath: resolve(artifactDir, "main-flow.webm"),
          });
    try {
      const tab = await ssh.connectSSHWorkspace({
        config,
        caseMarker: marker,
        workspacePath: config.workspacePaths[0],
      });
      if (!tab.workspaceIdentity) throw new Error(`${marker}: 远端 workspace identity 丢失`);
      expect(parseRemoteWorkspaceIdentity(tab.workspaceIdentity)?.sourceServerId).toBeTruthy();
      expect(tab.secretPersistedInTab).toBe(false);
      // 0911 修正(provider-refactor-m2 b10e5e5d80 合入后的新合同):远端不落
      // model-selection——模型 Provider 设置绑定本地 Environment,远端事实经
      // Provisioning 单向下发(sourceSettingsServiceCollection.ts 注释明示)。
      // 远端对账对象改为 provider_config.json(provider-node 的 PERSONAL_
      // PROVIDER_CONFIG_FILE,Provisioning 下发到达证明);其内容含 provider
      // 凭据材料,按脱敏原则只断言存在性、不读内容不比对。
      const remote = await ssh.runSSHCommand(
        config,
        'test -f "$HOME/.zcode/v2/provider_config.json" && echo provisioned',
      );
      expect(remote.stdout).toContain("provisioned");
      // 本地同样只有 provider_config.json(round 41 取证:本地 v2/ 与远端一致,
      // model-selection 概念被 provider-refactor-m2 整体移除)——存在性对账,
      // 内容含凭据材料按脱敏原则不读。
      const localProviderConfig = await readFile(
        resolve(app.getE2EAppDataPaths().appDataDir, "provider_config.json"),
        "utf8",
      ).then(
        () => "present",
        () => "absent",
      );
      expect(localProviderConfig).toBe("present");
      await writeFile(
        resolve(artifactDir, "ready-facts.json"),
        JSON.stringify({ tab, localProviderConfig, remoteProviderConfig: "present" }, null, 2),
      );
      await models.selectUpstreamProviderModelById(modelId, {
        includePlainModelFallback: false,
        providerId,
        providerName,
      });
      await models.selectUpstreamThoughtLevelValue("disabled");
      const requestStart = await network.getUpstreamRequestRecordCount();
      const prompt = `${marker}_PROMPT`;
      const reply = `${marker}_REPLY`;
      await v4.sendV4PromptAndWaitAccepted(
        `${prompt}: 只回复 ${reply}`,
        prompt,
        `${marker}: 首发未被接收`,
      );
      await network.waitForUpstreamRequest(
        { lastUserMessageIncludes: [prompt] },
        `${marker}: 远端请求未到达回放服务`,
        90_000,
        { afterIndex: requestStart - 1 },
      );
      await v4.waitForV4AssistantMessageContaining(reply, 90_000);
      await v4.waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
        `${marker}: 首发未收口`,
        90_000,
      );
    } finally {
      await browser.saveScreenshot(resolve(artifactDir, "main-final.png"));
      await recording?.stop();
    }
  });
});
