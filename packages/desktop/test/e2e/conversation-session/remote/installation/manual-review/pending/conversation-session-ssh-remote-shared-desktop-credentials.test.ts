import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

import * as v4 from "#e2e/helpers/v4-conversation";
import * as ssh from "#e2e/helpers/ssh-remote-p0";
import * as app from "#e2e/helpers/desktop-app";
import * as provider from "#e2e/helpers/custom-openai-provider";
import * as models from "#e2e/helpers/upstream-provider";
import * as network from "#e2e/helpers/conversation-session-network";

// ZCT-2120452663971209216：远端与同一用户的 Desktop 共用 ~/.zcode/v2，且 Desktop 已把凭据库
// 固定为系统库来源。修复前 Server Core 只能去读 Desktop 的系统密钥（容器内没有 Secret Service），
// 启动失败；修复后 Server 改用 <server-root>/credentials/ 自有库，共享库保持不变。
const marker = "E2E_R3_SSH_SHARED_CRED";
const providerId = "e2e-r3-ssh-shared-cred";
const providerName = "R3 SSH Shared Credentials";
const modelId = "e2e-r3-ssh-shared-cred-model";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-ssh-shared-desktop-credentials",
);
const SHARED_DIR = '"$HOME/.zcode/v2"';
const SERVER_CREDENTIALS_DIR = '"$HOME/.zcode/server/credentials"';
// 合成的 Desktop 系统库密文，只用于让共享库呈现“已固定 os”的状态，不含任何真实凭据。
const SHARED_DESKTOP_RECORD =
  '{"e2e:shared-desktop-sentinel":"enc:v2:os:0123456789abcdef01234567:AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"}';
const SHARED_SHA_COMMAND = `cat ${SHARED_DIR}/credentials.json ${SHARED_DIR}/credential-source | sha256sum | cut -c1-64`;

let tunnel: { baseURL: string; close(): Promise<void> } | undefined;
// Bug 原因（评审）：原先在前置检查前就记录连接配置，清理只看配置是否存在；前置检查失败时
// 仍会停止目标机的 Server 并删除其已有凭据，且未检查的共享凭据文件会被直接覆盖。
// 修复：前置检查覆盖全部预置路径，只有预置成功后才记录归属，清理只处理本次运行的资源。
let ownedConfig: ReturnType<typeof ssh.readSSHRuntimeConfig> | undefined;

function readFact(stdout: string, name: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${marker}: 远端事实 ${name} 缺失：${stdout}`);
  return line.slice(name.length + 1).trim();
}

describe(`${marker}: 同机 Desktop 已固定系统库时远端使用 Server 自有凭据库`, () => {
  after(async () => {
    await tunnel?.close();
    await browser.electron.restoreAllMocks();
    await app.clearAppData();
    if (ownedConfig) {
      // 本 case 预置的共享库与 Server 自有库只属于本次运行；停止本次连接启动的 Server 后清理。
      await ssh.runSSHCommand(
        ownedConfig,
        `"$HOME/.zcode/server/bin/zcode" stop --wait --json >/dev/null 2>&1; rm -rf ${SERVER_CREDENTIALS_DIR} ${SHARED_DIR}/credential-source ${SHARED_DIR}/credentials.json`,
      );
    }
  });

  it("首连安装后 Provisioning 写入自有库、共享库不变，远端项目首发完成", async function () {
    this.timeout(5 * 60_000);
    const activeConfig = ssh.readSSHRuntimeConfig(marker);
    const seeded = await ssh.runSSHCommand(
      activeConfig,
      [
        "set -e",
        // 共享库状态只在全新远端 HOME 上有意义；已有准备结果会让本 case 判定失真。
        `test ! -e ${SERVER_CREDENTIALS_DIR} || { echo "precondition=server-credentials-exists"; exit 0; }`,
        `test ! -e ${SHARED_DIR}/credential-secret || { echo "precondition=shared-secret-exists"; exit 0; }`,
        `test ! -e ${SHARED_DIR}/credentials.json || { echo "precondition=shared-credentials-exists"; exit 0; }`,
        `test ! -e ${SHARED_DIR}/credential-source || { echo "precondition=shared-source-exists"; exit 0; }`,
        `mkdir -p ${SHARED_DIR}`,
        `printf 'os\\n' > ${SHARED_DIR}/credential-source`,
        `printf '%s' '${SHARED_DESKTOP_RECORD}' > ${SHARED_DIR}/credentials.json`,
        `chmod 600 ${SHARED_DIR}/credential-source ${SHARED_DIR}/credentials.json`,
        "echo precondition=fresh",
        `echo "shared=$(${SHARED_SHA_COMMAND})"`,
      ].join("\n"),
    );
    // 预置中途失败时不记录归属：宁可留下残留，也不删除可能不属于本次运行的文件。
    if (readFact(seeded.stdout, "precondition") === "fresh") ownedConfig = activeConfig;
    expect(readFact(seeded.stdout, "precondition")).toBe("fresh");
    const sharedBefore = readFact(seeded.stdout, "shared");

    await v4.prepareV4ConversationE2E({ skipProvider: true });
    const activeTunnel = await ssh.createSSHReplayTunnel(activeConfig, marker);
    tunnel = activeTunnel;
    await provider.seedCustomOpenAIChatCompletionsProvider({
      providerId,
      providerName,
      modelId,
      baseURL: activeTunnel.baseURL,
    });
    await provider.refreshSeededOpenAIProvidersThroughSettings([providerName]);
    await mkdir(artifactDir, { recursive: true });

    const tab = await ssh.connectSSHWorkspace({
      config: activeConfig,
      caseMarker: marker,
      workspacePath: activeConfig.workspacePaths[0],
    });
    if (!tab.workspaceIdentity) throw new Error(`${marker}: 远端 workspace identity 丢失`);
    expect(parseRemoteWorkspaceIdentity(tab.workspaceIdentity)?.sourceServerId).toBeTruthy();

    // 只读取存在性、权限、前缀计数和哈希，不读取任何凭据值。
    const storage = await ssh.runSSHCommand(
      activeConfig,
      [
        `echo "shared=$(${SHARED_SHA_COMMAND})"`,
        `echo "sharedSecret=$(test -e ${SHARED_DIR}/credential-secret && echo present || echo absent)"`,
        `echo "serverDirMode=$(stat -c %a ${SERVER_CREDENTIALS_DIR})"`,
        `echo "serverSecretMode=$(stat -c %a ${SERVER_CREDENTIALS_DIR}/credential-secret)"`,
        `echo "serverEnvValues=$(grep -o '"enc:v2:env:' ${SERVER_CREDENTIALS_DIR}/credentials.json | wc -l)"`,
      ].join("\n"),
    );
    const facts = {
      sharedUnchanged: readFact(storage.stdout, "shared") === sharedBefore,
      sharedSecret: readFact(storage.stdout, "sharedSecret"),
      serverDirMode: readFact(storage.stdout, "serverDirMode"),
      serverSecretMode: readFact(storage.stdout, "serverSecretMode"),
      serverEnvValues: Number(readFact(storage.stdout, "serverEnvValues")),
    };
    await writeFile(resolve(artifactDir, "storage-facts.json"), JSON.stringify(facts, null, 2));
    expect(facts.sharedUnchanged).toBe(true);
    expect(facts.sharedSecret).toBe("absent");
    expect(facts.serverDirMode).toBe("700");
    expect(facts.serverSecretMode).toBe("600");
    // Provisioning 的 allowlist 凭据由 Server 自有 credential-secret 加密后写入自有库。
    expect(facts.serverEnvValues).toBeGreaterThan(0);

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

    // Core 拉起的 Agent 必须与 Core 读写同一凭据文件。远端 Agent 在回合结束后会退出（实测进程树
    // 只剩 Supervisor/Core），因此在 controlled-stream 延迟回复期间读取：请求已到达回放服务，
    // 发起请求的 Agent 一定仍在运行。Agent 会把进程标题改为 zcode-cli（覆盖 cmdline），其插件子进程
    // 仍是 zcode.cjs __zcode-plugin；两者都按 exec 时环境核对。Core 的值在运行时写入 process.env，
    // /proc 只能看到 exec 时环境，因此不把 Core 计入。
    const agent = await ssh.runSSHCommand(
      activeConfig,
      [
        `echo "expected=ZCODE_CREDENTIALS_FILE=$(cd ${SERVER_CREDENTIALS_DIR} && pwd -P)/credentials.json"`,
        "for d in /proc/[0-9]*; do",
        `  cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null) || continue`,
        '  case "$cmd" in zcode-cli*) kind=agent;; */runtime/zcode.cjs\\ *) kind=plugin;; *) continue;; esac',
        `  value=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep '^ZCODE_CREDENTIALS_FILE=' || echo '<missing>')`,
        '  echo "agent=${d#/proc/}|$kind|$value"',
        "done",
      ].join("\n"),
    );
    const expected = readFact(agent.stdout, "expected");
    const agentProcesses = agent.stdout
      .split("\n")
      .filter((line) => line.startsWith("agent="))
      .map((line) => {
        const [pid, kind, value] = line.slice("agent=".length).split("|");
        return { pid, kind, value };
      });
    await writeFile(
      resolve(artifactDir, "agent-env-facts.json"),
      JSON.stringify({ expected, agentProcesses }, null, 2),
    );
    expect(agentProcesses.some((entry) => entry.kind === "agent")).toBe(true);
    expect([...new Set(agentProcesses.map((entry) => entry.value))]).toEqual([expected]);

    await v4.waitForV4AssistantMessageContaining(reply, 90_000);
    await v4.waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      `${marker}: 首发未收口`,
      90_000,
    );
    await browser.saveScreenshot(resolve(artifactDir, "main-final.png"));
  });
});
