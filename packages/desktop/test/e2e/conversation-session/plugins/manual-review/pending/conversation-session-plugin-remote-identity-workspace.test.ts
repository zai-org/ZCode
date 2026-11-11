import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { getPluginList, getPluginReferenceCatalog } from "#e2e/helpers/plugin-management-lifecycle";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readDualSSHRuntimeConfig,
  readHostProcesses,
  runSSHCommand,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E, selectV4TaskById } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_WPL_010_REMOTE_IDENTITY";
const PLUGIN_NAME = "wpl-remote-identity";
const PLUGIN_ID = `${PLUGIN_NAME}@inline`;
// 服务器队列沿用 /workspace；本机非 root Docker 用户必须显式提供本轮专用目录。
const ALLOWED_REMOTE_WORKSPACE = process.env.ZCODE_E2E_WPL010_WORKSPACE?.trim() || "/workspace";

describe("WPL-010 remote Workspace Plugin identity/path authority E2E", () => {
  let providerA: SSHLifecycleProvider | null = null;
  let providerB: SSHLifecycleProvider | null = null;
  let targetA: SSHConnectionConfig | null = null;
  let targetB: SSHConnectionConfig | null = null;
  let workspacePath = "";

  after(async () => {
    await providerA?.tunnel.close().catch(() => undefined);
    await providerB?.tunnel.close().catch(() => undefined);
    if (targetA && workspacePath) {
      await cleanupRemoteFixture(targetA, workspacePath).catch(() => undefined);
    }
    if (targetB && workspacePath) {
      await cleanupRemoteFixture(targetB, workspacePath).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("reads the same path from each target while isolating catalog and runtime by identity", async function () {
    this.timeout(40 * 60_000);

    const dual = readDualSSHRuntimeConfig(CASE_MARKER);
    [targetA, targetB] = dual.targets;
    workspacePath = dual.workspacePath;
    await seedRemoteFixture(targetA, workspacePath, "A");
    await seedRemoteFixture(targetB, workspacePath, "B");

    const remoteConfigA = await readRemoteWorkspaceConfig(targetA, workspacePath);
    const remoteConfigB = await readRemoteWorkspaceConfig(targetB, workspacePath);
    expect(remoteConfigA).toContain('"marker": "A"');
    expect(remoteConfigA).not.toContain('"marker": "B"');
    expect(remoteConfigB).toContain('"marker": "B"');
    expect(remoteConfigB).not.toContain('"marker": "A"');

    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    providerA = await createSSHLifecycleProvider(targetA, `${CASE_MARKER}_A`);
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: targetA,
      label: "A",
      provider: providerA,
      workspacePath,
    });
    const workspaceCatalogA = await getPluginReferenceCatalog({
      workspaceIdentity: taskA.identity,
      workspacePath,
    });
    expectCatalogMarker(workspaceCatalogA.plugins, "A");
    const pluginA = (await getPluginList(workspacePath, taskA.identity)).plugins.find(
      (plugin) => plugin.id === PLUGIN_ID,
    );
    expect(pluginA).toMatchObject({
      configuredOptions: { marker: "A" },
      enabled: true,
      enabledSource: "workspace",
      rootPath: posix.join(workspacePath, "plugin"),
    });
    const sessionCatalogA = await getPluginReferenceCatalog({
      sessionId: taskA.taskId,
      workspaceIdentity: taskA.identity,
      workspacePath,
    });
    expect(sessionCatalogA.authority).toBe("session");
    expectCatalogMarker(sessionCatalogA.plugins, "A");

    // Bug 根因：两个 remote lifecycle provider 使用同一个测试 model id；若在连接 A 前
    // 连续创建 A/B，后创建的 B 会替换模型列表中的 A。按目标串行创建可保持真实切换顺序，
    // 同时避免测试夹具先于 identity 隔离断言互相覆盖。
    providerB = await createSSHLifecycleProvider(targetB, `${CASE_MARKER}_B`);
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: targetB,
      label: "B",
      provider: providerB,
      workspacePath,
    });
    const workspaceCatalogB = await getPluginReferenceCatalog({
      workspaceIdentity: taskB.identity,
      workspacePath,
    });
    expectCatalogMarker(workspaceCatalogB.plugins, "B");
    const pluginB = (await getPluginList(workspacePath, taskB.identity)).plugins.find(
      (plugin) => plugin.id === PLUGIN_ID,
    );
    expect(pluginB).toMatchObject({
      configuredOptions: { marker: "B" },
      enabled: true,
      enabledSource: "workspace",
      rootPath: posix.join(workspacePath, "plugin"),
    });
    const sessionCatalogB = await getPluginReferenceCatalog({
      sessionId: taskB.taskId,
      workspaceIdentity: taskB.identity,
      workspacePath,
    });
    expect(sessionCatalogB.authority).toBe("session");
    expectCatalogMarker(sessionCatalogB.plugins, "B");

    expect(taskA.workspacePath).toBe(taskB.workspacePath);
    expect(taskA.identity).not.toBe(taskB.identity);
    expect(taskA.remoteSessionId).not.toBe(taskB.remoteSessionId);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspacePath,
      expectedRemoteSessionId: taskA.remoteSessionId,
      requireActive: false,
    });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspacePath,
      expectedRemoteSessionId: taskB.remoteSessionId,
    });
    expect(await readHostProcesses()).toEqual(initialHosts);

    // 非活动 remote Session 不保留在当前 target 的 Agent 内；先经真实 task 导航切回 A，
    // 再查它的 session-owned catalog，证明 B 的异步加载没有覆盖 A 的 workspace-keyed 状态。
    await selectV4TaskById(taskA.taskId, 30_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspacePath,
      expectedRemoteSessionId: taskA.remoteSessionId,
    });
    expectCatalogMarker(
      (
        await getPluginReferenceCatalog({
          sessionId: taskA.taskId,
          workspaceIdentity: taskA.identity,
          workspacePath,
        })
      ).plugins,
      "A",
    );
    expectCatalogMarker(sessionCatalogA.plugins, "A");
    expectCatalogMarker(sessionCatalogB.plugins, "B");
  });
});

async function seedRemoteFixture(
  target: SSHConnectionConfig,
  workspacePath: string,
  marker: "A" | "B",
): Promise<void> {
  const pluginRoot = posix.join(workspacePath, "plugin");
  const manifest = {
    name: PLUGIN_NAME,
    version: "0.0.0",
    description: `WPL-010 target ${marker}`,
    skills: "skills",
    userConfig: {
      marker: {
        type: "string",
        title: "Target marker",
      },
    },
  };
  const config = {
    plugins: {
      dirs: [pluginRoot],
      enabledPlugins: { [PLUGIN_ID]: true },
      options: { [PLUGIN_ID]: { marker } },
    },
  };
  const skill = [
    "---",
    `name: target-${marker.toLowerCase()}`,
    `description: WPL-010 target ${marker} runtime marker`,
    "---",
    "",
    `WPL_010_TARGET_${marker}`,
    "",
  ].join("\n");
  const command = [
    "set -eu",
    `rm -rf -- ${quoteShell(workspacePath)}`,
    `mkdir -p -- ${quoteShell(posix.join(pluginRoot, ".zcode-plugin"))}`,
    `mkdir -p -- ${quoteShell(posix.join(pluginRoot, "skills", "identity"))}`,
    `mkdir -p -- ${quoteShell(posix.join(workspacePath, ".zcode"))}`,
    writeBase64Command(
      posix.join(pluginRoot, ".zcode-plugin", "plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    writeBase64Command(posix.join(pluginRoot, "skills", "identity", "SKILL.md"), skill),
    writeBase64Command(
      posix.join(workspacePath, ".zcode", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    ),
  ].join(" && ");
  const result = await runSSHCommand(target, command);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
}

async function readRemoteWorkspaceConfig(
  target: SSHConnectionConfig,
  workspacePath: string,
): Promise<string> {
  const result = await runSSHCommand(
    target,
    `cat -- ${quoteShell(posix.join(workspacePath, ".zcode", "config.json"))}`,
  );
  expect(result.code).toBe(0);
  return result.stdout;
}

async function cleanupRemoteFixture(
  target: SSHConnectionConfig,
  workspacePath: string,
): Promise<void> {
  if (workspacePath !== ALLOWED_REMOTE_WORKSPACE) {
    throw new Error(`${CASE_MARKER}: refusing to clean unexpected remote path ${workspacePath}`);
  }
  await runSSHCommand(target, `rm -rf -- ${quoteShell(workspacePath)}`);
}

function expectCatalogMarker(
  plugins: Awaited<ReturnType<typeof getPluginReferenceCatalog>>["plugins"],
  marker: "A" | "B",
): void {
  const plugin = plugins.find((entry) => entry.pluginId === PLUGIN_ID);
  expect(plugin).toMatchObject({
    enabled: true,
    skillQualifiedNames: [`${PLUGIN_NAME}:target-${marker.toLowerCase()}`],
  });
  expect(plugin?.skillQualifiedNames).not.toContain(
    `${PLUGIN_NAME}:target-${marker === "A" ? "b" : "a"}`,
  );
}

function writeBase64Command(path: string, content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return `printf '%s' ${quoteShell(encoded)} | base64 -d > ${quoteShell(path)}`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
