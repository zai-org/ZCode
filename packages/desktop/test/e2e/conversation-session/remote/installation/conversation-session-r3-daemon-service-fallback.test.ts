import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import { readRemoteCoreIdentity } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

// R3A-BLD-08：带常驻 user manager 的 SSH 目标（run-local-docker.mjs --systemd）。
// stale-group / private-tmp 复现 manager 读不到 server root 时 systemd 装载失败，连接必须回退
// detached fallback 并在连接日志带原因；registered 是正常环境回归。
const CASE_MARKER = "E2E_R3_DAEMON_SERVICE_FALLBACK";
type ServiceCase = "stale-group" | "private-tmp" | "registered";
const SUBCASE = (process.env.R3_DAEMON_SERVICE_CASE ?? "") as ServiceCase;
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-daemon-service-fallback",
);
const ACCESS_GROUP = "zcode-e2e-svc";
const RESTRICTED_ROOT = "/srv/zcode-e2e-svc";
const PRIVATE_TMP_ROOT = "/tmp/zcode-e2e-private";
const SERVER_BIN = '"$HOME/.zcode/server/bin/zcode"';
const SERVER_ROOT = '"$HOME/.zcode/server"';
const FALLBACK_LOG = "Source Server started in detached fallback mode for this remote environment";
const REGISTERED_LOG = "Source Server registered with the remote OS user service manager";
const REUSE_LOG = "Reusing running Source Server";

type ConnectionLog = { message: string; level: string };

/** 连接日志带 `[source-server:<phase>] ` 前缀，按正文匹配。 */
function findLog(logs: ConnectionLog[], text: string): ConnectionLog | undefined {
  return logs.find((entry) => entry.message.includes(text));
}

async function rootShell(container: string, script: string): Promise<string> {
  return (await execInRemoteContainer(container, ["sh", "-c", script], { user: "0" })).stdout;
}

async function readManager(container: string): Promise<{ pid: number; groups: string[] }> {
  const output = await rootShell(
    container,
    "pid=$(systemctl show -p MainPID --value user@1000.service); echo $pid; grep '^Groups:' /proc/$pid/status",
  );
  const [pidText = "", groupsLine = ""] = output.trim().split("\n");
  return {
    pid: Number.parseInt(pidText, 10),
    groups: groupsLine
      .replace(/^Groups:\s*/u, "")
      .split(/\s+/u)
      .filter(Boolean),
  };
}

/** 读当前 server root 的 unit 状态；unit 名取 descriptor 文件名，与注册时 start 的名字一致。 */
async function readUnitState(config: SSHConnectionConfig): Promise<Record<string, string>> {
  const result = await runSSHCommand(
    config,
    `unit=$(basename "$(ls ${SERVER_ROOT}/service/com.zhipu.zcode.server.*.service | head -n1)"); ` +
      'echo "Unit=$unit"; systemctl --user show "$unit" -p LoadState -p ActiveState; ' +
      'echo "Enabled=$(systemctl --user is-enabled "$unit" 2>&1)"',
  );
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

async function readStatusFile(config: SSHConnectionConfig): Promise<Record<string, unknown>> {
  const result = await runSSHCommand(config, `cat ${SERVER_ROOT}/run/status.json`);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function readConnectionLogs(): Promise<ConnectionLog[]> {
  return browser.execute(
    () =>
      (window as Window & { __serviceFallbackLogs?: ConnectionLog[] }).__serviceFallbackLogs ?? [],
  );
}

/** 按 E-SVC fixture 造出 manager 读不到 server root 的现场，并验证前提成立，避免空跑通过。 */
async function prepareRemoteFixture(container: string, facts: Record<string, unknown>) {
  expect((await rootShell(container, "systemctl is-active user@1000.service")).trim()).toBe(
    "active",
  );
  if (SUBCASE === "stale-group") {
    // manager 开机常驻（linger），之后才把 dev 加进目录访问组：新 SSH 会话有该组，manager 没有。
    await rootShell(
      container,
      `set -e; groupadd ${ACCESS_GROUP}; install -d -o root -g ${ACCESS_GROUP} -m 0750 ${RESTRICTED_ROOT}; ` +
        `install -d -o dev -g dev -m 0700 ${RESTRICTED_ROOT}/.zcode; ` +
        `ln -sfn ${RESTRICTED_ROOT}/.zcode /home/dev/.zcode; chown -h dev:dev /home/dev/.zcode; ` +
        `usermod -aG ${ACCESS_GROUP} dev`,
    );
    const gid = (await rootShell(container, `getent group ${ACCESS_GROUP} | cut -d: -f3`)).trim();
    const manager = await readManager(container);
    expect(manager.groups).not.toContain(gid);
    facts.accessGid = gid;
    facts.managerBefore = manager;
    return gid;
  }
  if (SUBCASE === "private-tmp") {
    // manager 使用私有 /tmp，~/.zcode 指向宿主 /tmp：SSH 会话可写，manager 的挂载视图里不存在。
    await rootShell(
      container,
      "set -e; mkdir -p /etc/systemd/system/user@1000.service.d; " +
        "printf '[Service]\\nPrivateTmp=yes\\n' > /etc/systemd/system/user@1000.service.d/zcode-e2e-private-tmp.conf; " +
        "systemctl daemon-reload; systemctl restart user@1000.service; " +
        `install -d -o dev -g dev -m 0700 ${PRIVATE_TMP_ROOT}/.zcode; ` +
        `ln -sfn ${PRIVATE_TMP_ROOT}/.zcode /home/dev/.zcode; chown -h dev:dev /home/dev/.zcode`,
    );
    const manager = await readManager(container);
    const hidden = await rootShell(
      container,
      `test -d ${PRIVATE_TMP_ROOT}/.zcode && echo host-visible; ` +
        `nsenter -t ${manager.pid} -m test -e ${PRIVATE_TMP_ROOT} && echo manager-visible || echo manager-hidden`,
    );
    expect(hidden.trim().split("\n")).toEqual(["host-visible", "manager-hidden"]);
    facts.managerBefore = manager;
  }
  return undefined;
}

async function connectFirstProject(config: ReturnType<typeof readSSHRuntimeConfig>) {
  await openSSHRemoteDialog(CASE_MARKER);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(CASE_MARKER);
  expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
  await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
  return waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: config.workspacePaths[0] });
}

describe(`${CASE_MARKER}: systemd 注册装载失败时回退 detached fallback（${SUBCASE}）`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`R3A-BLD-08 ${SUBCASE}`, async function () {
    this.timeout(30 * 60_000);
    if (!["stale-group", "private-tmp", "registered"].includes(SUBCASE)) {
      throw new Error(
        `${CASE_MARKER}: R3_DAEMON_SERVICE_CASE 必须为 stale-group|private-tmp|registered`,
      );
    }
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const facts: Record<string, unknown> = { subcase: SUBCASE };
    const accessGid = await prepareRemoteFixture(container, facts);

    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => {
      const state = window as Window & {
        __serviceFallbackLogs?: ConnectionLog[];
        zcode?: {
          onRemoteConnectionLog: (callback: (entry: ConnectionLog) => void) => () => void;
        };
      };
      state.__serviceFallbackLogs = [];
      if (!state.zcode) throw new Error("Missing desktop platform");
      state.zcode.onRemoteConnectionLog(({ message, level }) =>
        state.__serviceFallbackLogs!.push({ message, level }),
      );
    });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    try {
      const project = await connectFirstProject(config);
      const identity = project.workspaceIdentity!;
      const core0 = await readRemoteCoreIdentity(config, CASE_MARKER);
      const status0 = await readStatusFile(config);
      const unit0 = await readUnitState(config);
      const firstLogs = await readConnectionLogs();
      Object.assign(facts, { core0, status0, unit0, firstLogs });
      expect(core0.state).toBe("ready");

      if (SUBCASE === "registered") {
        // 正常环境回归：探测与注册都成功，由 OS user service 托管。
        expect(status0.serviceRegistered).toBe(true);
        expect(unit0).toMatchObject({ LoadState: "loaded", ActiveState: "active" });
        expect(findLog(firstLogs, REGISTERED_LOG)).toBeDefined();
        expect(findLog(firstLogs, FALLBACK_LOG)).toBeUndefined();
        expect(await readHostProcesses()).toEqual(initialHosts);
        return;
      }

      // 1. 装载失败回退：连接成功、fallback 未注册；原因只进本次输出和连接日志，不写 status.json。
      expect(status0.serviceRegistered).toBe(false);
      expect(status0).not.toHaveProperty("serviceFallbackReason");
      // 装载阶段失败时没有启动任何 unit。
      expect(unit0).toMatchObject({ LoadState: "not-found", ActiveState: "inactive" });
      const fallbackLog = findLog(firstLogs, `${FALLBACK_LOG} (`);
      expect(fallbackLog?.message).toContain("Failed to register service com.zhipu.zcode.server.");
      expect(fallbackLog?.message).toContain(
        SUBCASE === "stale-group"
          ? "Failed to enable unit: Access denied"
          : "Failed to enable unit: Unit file",
      );

      // 2. 设备断开后重连：probe 看到存活的 fallback，直接复用，Supervisor/Core 都不换。
      const sourceId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
      expect(sourceId).toBeTruthy();
      await selectTaskOrganizeMode(["项目", "Project"]);
      await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [identity] });
      const logCountBeforeReconnect = (await readConnectionLogs()).length;
      await reconnectRemoteProject(identity, CASE_MARKER);
      const reconnectLogs = (await readConnectionLogs()).slice(logCountBeforeReconnect);
      const core1 = await readRemoteCoreIdentity(config, CASE_MARKER);
      Object.assign(facts, { core1, reconnectLogs });
      expect(core1).toMatchObject({
        pid: core0.pid,
        supervisorPid: core0.supervisorPid,
        startTicks: core0.startTicks,
      });
      expect(findLog(reconnectLogs, REUSE_LOG)).toBeDefined();
      expect(findLog(reconnectLogs, FALLBACK_LOG)).toBeUndefined();

      // 3. 服务管理器仍可用时直接执行 serve --daemon：存活的 fallback 一律复用，不停止、不再注册。
      const serve = await runSSHCommand(
        config,
        `${SERVER_BIN} serve --daemon --json --server-root ${SERVER_ROOT}`,
      );
      facts.directServe = serve;
      expect(serve.code).toBe(0);
      const served = JSON.parse(serve.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(served).toMatchObject({ state: "ready", pid: core0.pid, serviceRegistered: false });
      expect(served).not.toHaveProperty("serviceFallbackReason");
      expect(await readRemoteCoreIdentity(config, CASE_MARKER)).toMatchObject({
        pid: core0.pid,
        supervisorPid: core0.supervisorPid,
      });

      if (SUBCASE === "stale-group") {
        // 4. 自愈：刷新 manager 组列表并停止 daemon，下一次冷启动自动改用 OS user service。
        await rootShell(container, "systemctl restart user@1000.service");
        const managerAfter = await readManager(container);
        expect(managerAfter.groups).toContain(accessGid);
        facts.managerAfter = managerAfter;
        await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [identity] });
        const stopped = await runSSHCommand(
          config,
          `${SERVER_BIN} stop --wait --json --server-root ${SERVER_ROOT}`,
        );
        expect(stopped.code).toBe(0);
        const logCountBeforeHeal = (await readConnectionLogs()).length;
        await reconnectRemoteProject(identity, CASE_MARKER);
        const healLogs = (await readConnectionLogs()).slice(logCountBeforeHeal);
        const core2 = await readRemoteCoreIdentity(config, CASE_MARKER);
        const status2 = await readStatusFile(config);
        const unit2 = await readUnitState(config);
        Object.assign(facts, { healLogs, core2, status2, unit2 });
        expect(core2.pid).not.toBe(core0.pid);
        expect(core2.supervisorPid).not.toBe(core0.supervisorPid);
        expect(status2.serviceRegistered).toBe(true);
        expect(unit2).toMatchObject({ LoadState: "loaded", ActiveState: "active" });
        expect(findLog(healLogs, REGISTERED_LOG)).toBeDefined();
      }
      expect(await readHostProcesses()).toEqual(initialHosts);
    } finally {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        resolve(artifactDir, `daemon-service-fallback-${SUBCASE}.json`),
        JSON.stringify(facts, null, 2),
      );
    }
  });
});
