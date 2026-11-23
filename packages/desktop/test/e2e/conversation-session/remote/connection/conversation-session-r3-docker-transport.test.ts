import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  openRemoteProjectSelection,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
} from "#e2e/helpers/ssh-remote-p0";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_DOCKER_CONTAINER_INPUT, TID_REMOTE_KIND_DOCKER } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  getUpstreamRequestRecordCount,
  countUpstreamRequests,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  SSH_LIFECYCLE_THOUGHT_LEVEL,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  clickLastEnabledSSHDialogButton,
  readHostProcesses,
  readSSHRuntimeConfig,
  readRemoteTabSnapshot,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_DOCKER_TRANSPORT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-docker-transport",
);
const run = promisify(execFile);

async function dockerSh(container: string, command: string): Promise<string> {
  try {
    return (await run("docker", ["exec", container, "sh", "-lc", command], { maxBuffer: 1 << 22 }))
      .stdout;
  } catch (error) {
    return `ERR:${(error as { stderr?: string }).stderr ?? String(error)}`;
  }
}

async function connectDockerTargetUntilReady(
  container: string,
  workspacePath = process.env.ZCODE_E2E_SSH_WORKSPACE_PATH,
): Promise<{ identity: string; remoteSessionId: string; kind: string | null }> {
  // Composer 的旧远程入口已退役；与 SSH 一样从项目创建进入 transport 选择。
  await openRemoteProjectSelection();
  await clickTestIdByDom(TID_REMOTE_KIND_DOCKER, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 无法选择 Docker transport`,
  });
  const input = $(`[data-testid="${TID_DOCKER_CONTAINER_INPUT}"]`);
  await input.waitForDisplayed({ timeout: 30_000 });
  await input.setValue(container);
  await clickLastEnabledSSHDialogButton(CASE_MARKER);
  await waitForSSHDirectoryStep(CASE_MARKER);
  if (!workspacePath) throw new Error(`${CASE_MARKER}: 缺少 Docker 项目目录`);
  await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
  const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspacePath });
  return {
    identity: tab.workspaceIdentity!,
    remoteSessionId: tab.remoteSessionId!,
    kind: tab.remoteKind,
  };
}

describe(`${CASE_MARKER}: Desktop Docker transport 首装、首发与关闭重连`, () => {
  const facts: Record<string, unknown> = {};
  let provider: SSHLifecycleProvider | undefined;

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "docker-transport.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TRN-01-UID 数字 UID 无 passwd 条目仍可首装并打开 Docker 项目", async function () {
    this.timeout(15 * 60_000);
    const container = `zcode-e2e-numeric-uid-${process.pid}`;
    const fixtureHome = "/tmp/zcode-uid-home";
    const workspacePath = `${fixtureHome}/project`;
    try {
      await run("docker", [
        "run",
        "--detach",
        "--name",
        container,
        "--user",
        "10001:10001",
        "--env",
        `HOME=${fixtureHome}`,
        "--workdir",
        "/tmp",
        "node:22.16.0-bookworm-slim",
        "sh",
        "-c",
        `mkdir -p ${workspacePath} && exec sleep infinity`,
      ]);
      const readIdentity = async () =>
        JSON.parse(
          (
            await run("docker", [
              "exec",
              container,
              "node",
              "-e",
              `const { readFile } = require("node:fs/promises");
              readFile("/etc/passwd", "utf8").then(passwd => console.log(JSON.stringify({
                uid: process.geteuid(),
                hasPasswd: passwd.split("\\n").some(line => line.split(":")[2] === String(process.geteuid()))
              }))).catch(error => { console.error(error); process.exitCode = 1; });`,
            ])
          ).stdout,
        ) as { uid: number; hasPasswd: boolean };
      expect(await readIdentity()).toEqual({ uid: 10001, hasPasswd: false });
      await prepareV4ConversationE2E({ skipProvider: true });
      const ready = await connectDockerTargetUntilReady(container, workspacePath);
      expect(ready.kind).toBe("docker");
      const identity = parseRemoteWorkspaceIdentity(ready.identity);
      expect(identity?.kind).toBe("server");
      const result = await run("docker", [
        "exec",
        container,
        "node",
        "-e",
        `const { readFile } = require("node:fs/promises");
        async function main() {
          const root = process.env.HOME + "/.zcode/server/run/";
          const status = JSON.parse(await readFile(root + "status.json", "utf8"));
          const token = (await readFile(root + "ingress-token", "utf8")).trim();
          const response = await fetch("http://127.0.0.1:" + status.port + "/api/server-info", {
            headers: { authorization: "Bearer " + token }
          });
          const info = await response.json();
          console.log(JSON.stringify({ state: status.state, serverId: info.serverId, identity: info.identity }));
        }
        main().catch(error => { console.error(error); process.exitCode = 1; });`,
      ]);
      const serverInfo = JSON.parse(result.stdout) as {
        state: string;
        serverId: string;
        identity: { osUser: string };
      };
      expect(serverInfo.state).toBe("ready");
      expect(serverInfo.identity.osUser).toBe("uid:10001");
      expect(serverInfo.serverId).toBe(identity?.sourceServerId);
      expect(await readIdentity()).toEqual({ uid: 10001, hasPasswd: false });
      facts.numericUid = { ready, serverInfo };
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "numeric-uid-project.png"));
    } finally {
      try {
        await clearAppData();
      } finally {
        await run("docker", ["rm", "--force", container]).catch(() => undefined);
      }
    }
  });

  it("R3A-TRN-01 独立 Docker 容器：Docker 入口安装、Provisioning、真实首发、断开后重连", async function () {
    this.timeout(30 * 60_000);
    // 本机 runner 已把同一 SSH / Docker 目标写入 ZCODE_E2E_SSH_CONTAINER；旧用例只读服务器队列
    // 的别名，尚未执行产品操作就报缺变量。保留显式目标优先，否则复用 runner 创建的隔离容器。
    const container =
      process.env.R3_DOCKER_TARGET?.trim() || process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 需设置 R3_DOCKER_TARGET`);
    facts.container = container;
    facts.containerUser = (
      await dockerSh(
        container,
        "id -un; test -e ~/.zcode/server/current.json && echo installed || echo fresh",
      )
    ).trim();
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    // 旧用例误把容器不可达宿主回放当成必须使用个人账号；专用隧道只转发模型 HTTP，产品控制面仍走 Docker。
    provider = await createSSHLifecycleProvider(readSSHRuntimeConfig(CASE_MARKER), CASE_MARKER, {
      tunnelUsername: "tunnel",
    });

    const ready = await connectDockerTargetUntilReady(container);
    facts.ready = ready;
    expect(ready.kind).toBe("docker");
    const parsed = parseRemoteWorkspaceIdentity(ready.identity);
    expect(parsed?.kind).toBe("server");
    // 0911 修复：远端 provider_config.json 已迁移新 schema（providerRules[].providerName），
    // 旧字段 "label" 不存在 → grep 无匹配 exit 1 且 stderr 为空 → dockerSh 返回裸 "ERR:"，
    // 掩盖了前两段（archiveSha256/state:ready）的真实输出。改为 grep providerName，
    // 且每段 grep 兜底 || true，保证命令 exit 0 时 stdout 不被丢弃。
    const installState = await dockerSh(
      container,
      'grep -o \'"archiveSha256": *"[0-9a-f]*"\' ~/.zcode/server/current.json || true; cat ~/.zcode/server/run/status.json | tr -d "\\n "; echo; grep -o "\\"providerName\\": *\\"[^\\"]*\\"" ~/.zcode/v2/provider_config.json || true',
    );
    facts.remoteAfterConnect = installState.split("\n").filter(Boolean).slice(0, 8);
    expect(installState).toContain("archiveSha256");
    expect(installState).toContain('"state":"ready"');
    expect(installState).toContain(provider.name);
    expect(await readHostProcesses()).toEqual(initialHosts);

    // 容器内真实 Agent 经 Provider HTTP 隧道首发，响应由本例 fixture 提供。
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue(SSH_LIFECYCLE_THOUGHT_LEVEL);
    // 复用 Docker 项目草稿，保留当前机器与模型归属。
    const replayBefore = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_FIRST 请只回复 DOCKER1`,
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
    // 用户 prompt 本身含 DOCKER1，不能用整个页面文本作为真实回复证据。
    await browser.waitUntil(
      async () =>
        (await getV4Messages("assistant")).some((message) =>
          /DOCKER\s*1/u.test(message.text ?? ""),
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: assistant 未返回 DOCKER1` },
    );
    const text = (await getV4Messages("assistant")).map((message) => message.text ?? "").join("\n");
    expect(text).toMatch(/DOCKER\s*1/u);
    const requestMatch = {
      lastUserMessageIncludes: [`${CASE_MARKER}_FIRST`],
      excludes: ["Generate a concise title"],
    };
    await waitForUpstreamRequest(requestMatch, `${CASE_MARKER}: 容器首发未到达回放服务`, 30_000, {
      afterIndex: replayBefore - 1,
    });
    expect(await countUpstreamRequests(requestMatch, { afterIndex: replayBefore - 1 })).toBe(1);
    const remoteRequests = await dockerSh(
      container,
      'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "model.network.completed" "$F" || true; grep -o "\\"baseURL\\":\\"[^\\"]*\\"" "$F" | sort | uniq -c',
    );
    facts.remoteModelNetwork = remoteRequests.trim().split("\n");
    expect(remoteRequests).toContain(provider.tunnel.baseURL);

    // 关闭重连：设备断开 → 重连 → 新 remoteSessionId、Host 不变、容器内 daemon 仍在。
    const sourceId = parsed?.sourceServerId;
    await selectTaskOrganizeMode(["项目", "Project"]);

    await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [ready.identity] });

    const daemonAfterDisconnect = await dockerSh(
      container,
      'cat ~/.zcode/server/run/status.json | tr -d "\\n " | cut -c1-120',
    );
    expect(daemonAfterDisconnect).toContain('"state":"ready"');
    await reconnectRemoteProject(ready.identity, CASE_MARKER);
    let reconnected: string | null = null;
    await browser.waitUntil(
      async () => {
        const snapshot = await readRemoteTabSnapshot(ready.identity).catch(() => null);
        if (snapshot?.remoteSessionId && snapshot.remoteSessionId !== ready.remoteSessionId) {
          reconnected = snapshot.remoteSessionId;
          return true;
        }
        return false;
      },
      { timeout: 180_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: Docker 目标重连没有换代` },
    );
    facts.reconnected = { before: ready.remoteSessionId, after: reconnected };
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});
