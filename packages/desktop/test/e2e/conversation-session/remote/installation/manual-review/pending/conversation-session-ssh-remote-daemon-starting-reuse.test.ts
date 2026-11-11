import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { clearAppData } from "#e2e/helpers/desktop-app";
import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import {
  execInRemoteContainer,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";

// 3.16.2 远端回归的真实 SSH 验证（本机 Docker runner）：
// - R4：Desktop 连接时远端 Supervisor 正处于 starting，serve --daemon 必须等到 ready 并带端口返回，
//   不能以 exit 0 返回 port:null（Desktop 会报 "did not report a valid ingress port"）。
// - R9：远端 Source Server 拉起的 agent，模型请求头必须报 App 版本，而不是 CLI 包版本。
// R3_DAEMON_STARTING_WINDOW=0 时跳过 starting 窗口，只验证版本头（用于修复前对照）。
const MARKER = "E2E_SSH_DAEMON_STARTING_REUSE";
const STARTING_WINDOW_ENABLED = process.env.R3_DAEMON_STARTING_WINDOW !== "0";
// Core 在 require 阶段同步阻塞的时长。要短于 Supervisor 首启 15 秒的 ready 预算，
// 又要长到 Desktop 的 probe 与 serve --daemon 落在 starting 窗口内。
const SLOW_CORE_MS = 8_000;
const SERVER_ROOT = "/home/dev/.zcode/server";
const SLOW_CORE_SCRIPT = "/home/dev/.e2e-slow-core.cjs";
const SAMPLER_SCRIPT = "/home/dev/.e2e-daemon-sampler.sh";
const SAMPLER_LOG = "/tmp/e2e-daemon-samples.log";
const desktopRoot = process.cwd();
const repoRoot = resolve(desktopRoot, "../..");
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-daemon-starting-reuse",
);
const execFileAsync = promisify(execFile);

function readPackageVersion(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

async function docker(args: string[]): Promise<void> {
  await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 });
}

async function shInContainer(container: string, script: string): Promise<string> {
  return (await execInRemoteContainer(container, ["sh", "-c", script])).stdout;
}

/** 用 Desktop 将要安装的同一份 archive 预装远端，使连接直接进入 ensureDaemon。 */
async function preinstallRemoteRelease(container: string, appVersion: string): Promise<void> {
  const machine = (await shInContainer(container, "uname -m")).trim();
  const target = machine === "aarch64" ? "linux-arm64" : "linux-x64";
  const archive = resolve(
    desktopRoot,
    "mock-cdn/releases",
    appVersion,
    `zcode-server-${target}.tar.gz`,
  );
  await docker(["cp", archive, `${container}:/tmp/e2e-zcode-server.tar.gz`]);
  await execInRemoteContainer(container, ["chown", "dev:dev", "/tmp/e2e-zcode-server.tar.gz"], {
    user: "0",
  });
  await shInContainer(
    container,
    [
      "set -eu",
      'b="$HOME/.zcode/server/.e2e-bootstrap"',
      'rm -rf "$b"',
      'mkdir -p "$b"',
      'tar -xzf /tmp/e2e-zcode-server.tar.gz -C "$b" --strip-components=1',
      '"$b/bin/zcode" update --from-archive /tmp/e2e-zcode-server.tar.gz --server-root "$HOME/.zcode/server" --json',
      // update 会拉起 daemon；停掉后由本用例按需制造 starting 窗口。
      '"$HOME/.zcode/server/bin/zcode" stop --wait --server-root "$HOME/.zcode/server" --json',
      'rm -rf "$b" /tmp/e2e-zcode-server.tar.gz',
    ].join("; "),
  );
}

interface DaemonSnapshot {
  lockPid: number | null;
  state: string | null;
}

async function readDaemonSnapshot(container: string): Promise<DaemonSnapshot> {
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await readRemoteContainerFile(container, path)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const status = await read(`${SERVER_ROOT}/run/status.json`);
  const lock = await read(`${SERVER_ROOT}/run/server.lock`);
  return {
    lockPid: typeof lock?.pid === "number" ? lock.pid : null,
    state: typeof status?.state === "string" ? status.state : null,
  };
}

/** 后台启动一个 Core 慢启动的 daemon，并等到它停在 starting。返回该 Supervisor 的 pid。 */
async function startDaemonInStartingWindow(container: string): Promise<number> {
  await writeRemoteContainerFile(
    container,
    SLOW_CORE_SCRIPT,
    `if (/server-core\\.js$/.test(process.argv[1] || "")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_CORE_MS});\n`,
  );
  // 采样器：每 100 ms 记录 status 状态，以及 Desktop 经 SSH 执行的 serve --daemon --json 进程数。
  await writeRemoteContainerFile(
    container,
    SAMPLER_SCRIPT,
    [
      `end=$(( $(date +%s) + 60 ))`,
      `while [ "$(date +%s)" -lt "$end" ]; do`,
      `  s=$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\\([a-z-]*\\)".*/\\1/p' ${SERVER_ROOT}/run/status.json 2>/dev/null | head -n 1)`,
      `  n=$(ps -eo args | grep -c '[s]erve --daemon --json')`,
      `  echo "$(date +%s%3N) state=$s serveJson=$n" >> ${SAMPLER_LOG}`,
      `  sleep 0.1`,
      `done`,
      "",
    ].join("\n"),
  );
  await docker(["exec", "-d", "--user", "dev", container, "sh", SAMPLER_SCRIPT]);
  // 后台 daemon 不带 --json，采样器据此只统计 Desktop 发起的那一次 serve --daemon --json。
  await docker([
    "exec",
    "-d",
    "--user",
    "dev",
    "--env",
    "HOME=/home/dev",
    "--env",
    `NODE_OPTIONS=--require=${SLOW_CORE_SCRIPT}`,
    container,
    "sh",
    "-c",
    `"$HOME/.zcode/server/bin/zcode" serve --daemon --server-root "$HOME/.zcode/server" > /tmp/e2e-background-serve.log 2>&1`,
  ]);
  let snapshot: DaemonSnapshot = { lockPid: null, state: null };
  await browser.waitUntil(
    async () => {
      snapshot = await readDaemonSnapshot(container);
      return snapshot.state === "starting" && snapshot.lockPid !== null;
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `${MARKER}: 后台 daemon 没有进入 starting（${JSON.stringify(snapshot)}）`,
    },
  );
  return snapshot.lockPid!;
}

describe(`${MARKER}: 远端 daemon 正在 starting 时连接，以及远端 agent 版本头`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = { startingWindow: STARTING_WINDOW_ENABLED };

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "daemon-starting-reuse.json"),
      JSON.stringify(facts, null, 2),
    );
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R4 复用 starting 的 Supervisor 等到 ready 才连接；R9 远端模型请求报 App 版本", async function () {
    this.timeout(15 * 60_000);
    const appVersion = readPackageVersion(resolve(repoRoot, "package.json"));
    const cliVersion = readPackageVersion(resolve(repoRoot, "apps/zcode-cli/package.json"));
    facts.appVersion = appVersion;
    facts.cliVersion = cliVersion;
    const prepared = await prepareSSHLifecycle(MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const container = readRemoteDockerContainer(MARKER);

    let startingSupervisorPid: number | null = null;
    if (STARTING_WINDOW_ENABLED) {
      await preinstallRemoteRelease(container, appVersion);
      startingSupervisorPid = await startDaemonInStartingWindow(container);
      facts.startingSupervisorPid = startingSupervisorPid;
    }

    let connectError: unknown;
    try {
      await connectSSHWorkspaceAndSendFirstTurn({
        caseMarker: MARKER,
        config: prepared.config,
        provider: prepared.provider,
        label: "A",
        workspacePath: prepared.config.workspacePaths[0],
      });
    } catch (error) {
      connectError = error;
      facts.connectError = error instanceof Error ? error.message : String(error);
    } finally {
      if (STARTING_WINDOW_ENABLED) {
        facts.samples = (await shInContainer(container, `cat ${SAMPLER_LOG} 2>/dev/null || true`))
          .split("\n")
          .filter(Boolean);
        facts.backgroundServe = await shInContainer(
          container,
          "cat /tmp/e2e-background-serve.log 2>/dev/null || true",
        );
        facts.daemonAfterConnect = await readDaemonSnapshot(container);
      }
    }
    if (connectError) throw connectError;

    if (STARTING_WINDOW_ENABLED) {
      const samples = facts.samples as string[];
      // Desktop 的 serve --daemon --json 必须出现在 starting 期间，否则本次没有覆盖 R4 路径。
      expect(samples.some((line) => /state=starting serveJson=[1-9]/u.test(line))).toBe(true);
      // 连接成功后仍是同一个 Supervisor：Desktop 复用了它，没有重装或另起实例。
      expect(facts.daemonAfterConnect).toMatchObject({
        lockPid: startingSupervisorPid,
        state: "ready",
      });
    }

    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!capturePath) throw new Error(`${MARKER}: E2E_PROVIDER_CAPTURE_PATH 未配置`);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
    // 远端 agent 运行在 Linux 容器内，X-Platform 区分远端与本机发出的模型请求。
    const remoteRequests = capture.records
      .filter((record) => record.path.includes("/chat/completions"))
      .filter((record) => record.requestHeaders["x-platform"]?.startsWith("linux-"))
      .map((record) => ({
        platform: record.requestHeaders["x-platform"],
        userAgent: record.requestHeaders["user-agent"],
        appVersion: record.requestHeaders["x-zcode-app-version"],
      }));
    facts.remoteRequests = remoteRequests;
    expect(remoteRequests.length).toBeGreaterThan(0);
    for (const request of remoteRequests) {
      // AI SDK 会在产品标识后追加 ai-sdk/runtime 片段；断言首个产品标识是 App 版本。
      expect(request.userAgent?.split(" ")[0]).toBe(`ZCode/${appVersion}`);
      expect(request.appVersion).toBe(appVersion);
    }
  });
});
