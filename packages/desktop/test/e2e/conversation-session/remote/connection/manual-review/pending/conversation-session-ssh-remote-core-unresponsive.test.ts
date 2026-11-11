import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import {
  installAndStartRemoteDaemon,
  isRemotePidAlive,
  readRemoteDaemonFiles,
  type RemoteAccount,
} from "#e2e/helpers/remote-restart-stale-daemon";
import {
  connectSSHWorkspace,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// ZCT-2113570821476302848 的真实 SSH 验证（本机 Docker runner）：远端 Core 的事件循环被同步工作占满后，
// 不发 heartbeat、不响应握手、SIGTERM 无效，旧 Supervisor 一直报 ready，设备只能人工 kill -9。
// 修复后 Supervisor 连续 6 个 heartbeat 周期收不到 Core 消息就 SIGKILL 并按崩溃重启，Desktop 可重新连接。
// 同一用例先验证两种不能误杀的场景：正常空闲超过判定时长、整个远端被挂起再恢复。
const MARKER = "E2E_SSH_REMOTE_CORE_UNRESPONSIVE";
const DEV: RemoteAccount = { user: "dev", home: "/home/dev" };
const PROJECT_DIR = "/home/dev/e2e-core-unresponsive-project";
const SPIN_FLAG = "/home/dev/.e2e-core-spin";
const SPIN_PID_FILE = "/home/dev/.e2e-core-spin-pid";
const SEAM_SCRIPT = "/home/dev/.e2e-core-spin.cjs";
// 判定时长是 6 × 10 秒；空闲和挂起都要明显超过它，才能证明不会误杀。
const LONGER_THAN_LIVENESS_LIMIT_MS = 75_000;
const desktopRoot = process.cwd();
const execFileAsync = promisify(execFile);
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-core-unresponsive",
);

// 只作用于 server-core.js。标记文件出现时，由一个 Core 认领（unlink 原子）后进入同步死循环：
// 与事故相同，事件循环卡住、CPU 占满，JS 层的 SIGTERM 处理永远轮不到。重启后的 Core 不再认领。
const SEAM = `if (/server-core\\.js$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const timer = setInterval(() => {
    try {
      fs.unlinkSync(${JSON.stringify(SPIN_FLAG)});
    } catch {
      return;
    }
    clearInterval(timer);
    fs.writeFileSync(${JSON.stringify(SPIN_PID_FILE)}, String(process.pid));
    for (;;) {}
  }, 200);
  timer.unref();
}
`;

interface CoreStatus {
  state?: string;
  pid?: number | null;
  port?: number | null;
  generation?: number;
  lastExitReason?: string | null;
  crashBudget?: { crashCount?: number };
}

async function readCoreStatus(container: string): Promise<CoreStatus> {
  const { status } = await readRemoteDaemonFiles(container, DEV);
  if (!status) throw new Error(`${MARKER}: 远端没有 status.json`);
  return status as CoreStatus;
}

async function sh(container: string, script: string): Promise<string> {
  return (await execInRemoteContainer(container, ["bash", "-c", script])).stdout.trim();
}

/** 3 秒内能否从 Core 的 HTTP 端口读到响应首行；任何状态码都算有响应。 */
async function coreAnswersHttp(container: string, port: number): Promise<boolean> {
  const reply = await sh(
    container,
    `timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}; printf "GET /api/server-info HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n" >&3; head -c 12 <&3' || true`,
  );
  return reply.startsWith("HTTP/");
}

/** 2 秒内进程消耗的 CPU 时钟数（/proc/<pid>/stat 的 utime+stime，单位 1/CLK_TCK 秒）。 */
async function sampleCpuTicks(container: string, pid: number): Promise<number> {
  return Number(
    await sh(
      container,
      `a=$(awk '{print $14+$15}' /proc/${pid}/stat); sleep 2; b=$(awk '{print $14+$15}' /proc/${pid}/stat); echo $((b-a))`,
    ),
  );
}

async function readProjectConnectionState(identity: string): Promise<string | null> {
  return browser.execute(
    (workspaceIdentity) =>
      document.querySelector<HTMLElement>(
        `[data-project-workspace-identity=${JSON.stringify(workspaceIdentity)}]`,
      )?.dataset.connectionState ?? null,
    identity,
  );
}

/** 用户视角的“能重新连上”：先断开（若仍在线），再从项目行重连，等到远程页签拿到会话。 */
async function reconnectProjectAsUser(identity: string, sourceServerId: string): Promise<string> {
  let state: string | null = null;
  await browser.waitUntil(
    async () => {
      state = await readProjectConnectionState(identity);
      return state === "online" || state === "offline" || state === "failed";
    },
    { timeout: 120_000, interval: 1_000, timeoutMsg: `${MARKER}: 项目连接状态没有稳定` },
  );
  if (state === "online") {
    await disconnectRemoteSource(sourceServerId, MARKER, { workspaceIdentities: [identity] });
  }
  await reconnectRemoteProject(identity, MARKER);
  const snapshot = await readRemoteTabSnapshot(identity, PROJECT_DIR);
  if (!snapshot.remoteSessionId) throw new Error(`${MARKER}: 重连后远程页签没有会话`);
  return snapshot.remoteSessionId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

describe(`${MARKER}: 远端 Core 事件循环卡死后自动恢复`, () => {
  const facts: Record<string, unknown> = {};
  let container = "";
  let identity = "";
  let sourceServerId = "";

  before(async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    const appVersion = (
      JSON.parse(readFileSync(resolve(desktopRoot, "../../package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await prepareV4ConversationE2E({ skipProvider: true });
    await execInRemoteContainer(container, ["mkdir", "-p", PROJECT_DIR]);
    await execInRemoteContainer(container, ["rm", "-f", SPIN_FLAG, SPIN_PID_FILE]);
    await writeRemoteContainerFile(container, SEAM_SCRIPT, SEAM);
    await installAndStartRemoteDaemon(container, DEV, {
      desktopRoot,
      appVersion,
      nodeOptions: `--require=${SEAM_SCRIPT}`,
    });
    const tab = await connectSSHWorkspace({
      config,
      caseMarker: MARKER,
      workspacePath: PROJECT_DIR,
    });
    identity = tab.workspaceIdentity!;
    sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId ?? "";
    if (!sourceServerId) throw new Error(`${MARKER}: 项目身份里没有 sourceServerId`);
    facts.connected = await readCoreStatus(container);
  });

  after(async () => {
    await execFileAsync("docker", ["unpause", container]).catch(() => undefined);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "ssh-remote-core-unresponsive.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("heartbeat 正常时空闲超过判定时长，Core 不被重启", async function () {
    this.timeout(5 * 60_000);
    const before = await readCoreStatus(container);
    expect(before).toMatchObject({ state: "ready" });
    await sleep(LONGER_THAN_LIVENESS_LIMIT_MS);
    const after = await readCoreStatus(container);
    facts.idle = { before, after };
    expect(after).toMatchObject({
      state: "ready",
      pid: before.pid,
      generation: before.generation,
      port: before.port,
    });
    expect(await coreAnswersHttp(container, after.port as number)).toBe(true);
  });

  it("整个远端被挂起超过判定时长再恢复，Core 不被误杀，Desktop 仍可连接", async function () {
    this.timeout(8 * 60_000);
    const before = await readCoreStatus(container);
    // docker pause 冻结容器内全部进程（sshd、Supervisor、Core），等同主机休眠或 VM 暂停；
    // 冻结期间单调时钟照常前进，按时钟比较的活性检查会在恢复后误杀 Core。
    await execFileAsync("docker", ["pause", container]);
    await sleep(LONGER_THAN_LIVENESS_LIMIT_MS);
    await execFileAsync("docker", ["unpause", container]);
    await sleep(20_000);
    const after = await readCoreStatus(container);
    facts.paused = { before, after };
    expect(after).toMatchObject({
      state: "ready",
      pid: before.pid,
      generation: before.generation,
    });
    expect(await isRemotePidAlive(container, DEV, before.pid as number)).toBe(true);
    facts.pausedReconnectSessionId = await reconnectProjectAsUser(identity, sourceServerId);
  });

  it("Core 事件循环卡死后被自动换代，Desktop 重新连接成功", async function () {
    this.timeout(10 * 60_000);
    const before = await readCoreStatus(container);
    expect(before).toMatchObject({ state: "ready" });
    const stuckPid = before.pid as number;

    // 1. 复现事故现场：Core 进入同步死循环。
    await execInRemoteContainer(container, ["touch", SPIN_FLAG]);
    await browser.waitUntil(
      async () =>
        (await sh(container, `cat ${SPIN_PID_FILE} 2>/dev/null || true`)) === String(stuckPid),
      { timeout: 15_000, interval: 200, timeoutMsg: `${MARKER}: 当前 Core 没有进入死循环` },
    );
    const stuckAt = Date.now();
    const cpuTicks = await sampleCpuTicks(container, stuckPid);
    const httpWhileStuck = await coreAnswersHttp(container, before.port as number);
    // SIGTERM 由 Core 的 JS 处理函数接管，事件循环卡住时不会执行。
    await execInRemoteContainer(container, ["kill", "-TERM", String(stuckPid)]);
    await sleep(3_000);
    const aliveAfterSigterm = await isRemotePidAlive(container, DEV, stuckPid);
    const statusWhileStuck = await readCoreStatus(container);
    facts.stuck = { stuckPid, cpuTicks, httpWhileStuck, aliveAfterSigterm, statusWhileStuck };
    expect(cpuTicks).toBeGreaterThanOrEqual(100);
    expect(httpWhileStuck).toBe(false);
    expect(aliveAfterSigterm).toBe(true);
    expect(statusWhileStuck).toMatchObject({ state: "ready", pid: stuckPid });

    // 2. 修复点：Supervisor 判定无响应，SIGKILL 卡死的 Core 并拉起新一代。
    let recovered: CoreStatus | undefined;
    await browser
      .waitUntil(
        async () => {
          const status = await readCoreStatus(container);
          if (
            status.state === "ready" &&
            typeof status.pid === "number" &&
            status.pid !== stuckPid &&
            (status.generation ?? 0) > (before.generation ?? 0)
          ) {
            recovered = status;
            return true;
          }
          return false;
        },
        { timeout: 120_000, interval: 1_000 },
      )
      .catch(() => undefined);
    facts.recovered = recovered ?? (await readCoreStatus(container));
    facts.recoveredAfterMs = Date.now() - stuckAt;
    if (!recovered) {
      throw new Error(
        `${MARKER}: 卡死的 Core 120 秒内没有被 Supervisor 换代；status=${JSON.stringify(facts.recovered)}`,
      );
    }
    expect(recovered.lastExitReason).toContain("core unresponsive");
    expect(recovered.crashBudget?.crashCount).toBe(1);
    expect(await isRemotePidAlive(container, DEV, stuckPid)).toBe(false);
    expect(await coreAnswersHttp(container, recovered.port as number)).toBe(true);

    // 3. Desktop 侧：记录是否已自动恢复，再按用户操作重新连接，必须成功。
    facts.projectStateAfterRecovery = await readProjectConnectionState(identity);
    facts.reconnectSessionId = await reconnectProjectAsUser(identity, sourceServerId);
    const final = await readCoreStatus(container);
    facts.final = final;
    expect(final).toMatchObject({ state: "ready", pid: recovered.pid });
    await browser.saveScreenshot(resolve(artifactDir, "reconnected.png"));
  });
});
