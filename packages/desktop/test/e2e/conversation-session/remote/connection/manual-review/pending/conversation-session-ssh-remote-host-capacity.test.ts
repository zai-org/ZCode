import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity, ServiceChannels } from "@zcode/shared";
import type { RemoteProjectDirectory, RemoteProjectHost } from "@zcode/services";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  openRemoteDevicesSettings,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_HOST_CAPACITY";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-host-capacity",
);
const readDirectory = () =>
  callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");
const entryOwnership = (directory: RemoteProjectDirectory) =>
  directory.entries.map(({ id, hostId, projectId }) => ({ id, hostId, projectId }));

describe(`${MARKER}: 保存远程连接不设数量上限`, () => {
  const facts: Record<string, unknown> = {};
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "host-capacity.json"), JSON.stringify(facts, null, 2));
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-10：第 21 条真实 SSH 连接成功，同设备复用与确认新身份均不受数量限制", async function () {
    this.timeout(15 * 60_000);
    const target = readSSHRuntimeConfig(MARKER);
    // 同批用例共用远端容器；独立目录避免后续 P0 的同名项目被自动追加名称后缀。
    const config = {
      ...target,
      workspacePaths: [
        `${target.workspacePaths[0]}/host-capacity-a`,
        `${target.workspacePaths[1]}/host-capacity-b`,
      ] as const,
    };
    await execInRemoteContainer(readRemoteDockerContainer(MARKER), [
      "mkdir",
      "-p",
      "--",
      ...config.workspacePaths,
    ]);
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    expect((await readDirectory()).hosts).toHaveLength(0);

    // 用真实服务准备历史记录，避免直写 SQLite 绕过 Controller 的变更通知。
    const retained: RemoteProjectHost[] = [];
    for (let index = 0; index < 20; index += 1) {
      retained.push(
        await callHandoffHost<RemoteProjectHost>(ServiceChannels.RemoteProjects, "saveHost", [
          {
            id: `remote:server:e2e-retained-${index}`,
            target: { kind: "ssh", host: `retained-${index}.example.test`, username: "dev" },
          },
        ]),
      );
    }
    facts.savedBeforeConnect = (await readDirectory()).hosts.length;
    expect(facts.savedBeforeConnect).toBe(20);

    const first = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const sourceId = parseRemoteWorkspaceIdentity(first.workspaceIdentity!)?.sourceServerId;
    expect(sourceId).toBeTruthy();
    const connected = await readDirectory();
    expect(connected.hosts).toHaveLength(21);
    expect(connected.hosts.find((host) => host.id === `remote:server:${sourceId}`)).toMatchObject({
      connectionStatus: "online",
    });
    for (const host of retained) {
      expect(connected.hosts.find((candidate) => candidate.id === host.id)?.membershipId).toBe(
        host.membershipId,
      );
    }
    facts.savedAfterConnect = connected.hosts.length;
    facts.sourceId = sourceId;

    const second = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[1],
    });
    expect(parseRemoteWorkspaceIdentity(second.workspaceIdentity!)?.sourceServerId).toBe(sourceId);
    expect((await readDirectory()).hosts).toHaveLength(21);
    facts.sameSourceReused = true;
    const architecture = await runSSHCommand(config, "uname -m");
    expect(architecture.code).toBe(0);
    facts.containerArchitecture = architecture.stdout.trim();
    await openRemoteDevicesSettings();
    await waitForDeviceStatus(sourceId!, "online", MARKER);
    await browser.saveScreenshot(resolve(artifactDir, "connected-above-twenty.png"));

    // 第二个旧拦截点在身份确认写入；通过真实 RPC 验证，不伪装为设备重装流程。
    const previous = retained[0]!;
    const entriesBeforeConfirmation = entryOwnership(await readDirectory());
    const replacement = await callHandoffHost<RemoteProjectHost>(
      ServiceChannels.RemoteProjects,
      "bindHost",
      [
        {
          id: previous.id,
          membershipId: previous.membershipId,
          resolvedId: "remote:server:e2e-confirmed-replacement",
          createDistinctHost: true,
        },
      ],
    );
    expect(replacement.id).toBe("remote:server:e2e-confirmed-replacement");
    expect(replacement.membershipId).not.toBe(previous.membershipId);
    const confirmed = await readDirectory();
    expect(confirmed.hosts).toHaveLength(22);
    expect(confirmed.hosts.find((host) => host.id === previous.id)?.membershipId).toBe(
      previous.membershipId,
    );
    expect(entryOwnership(confirmed)).toEqual(entriesBeforeConfirmation);
    facts.savedAfterIdentityConfirmation = confirmed.hosts.length;
  });
});
