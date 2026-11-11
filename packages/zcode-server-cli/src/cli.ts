/* eslint-disable max-lines -- Server lifecycle、首装、迁移与卸载命令共享同一 CLI 解析和安全边界。 */
import { fork } from "node:child_process";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isPublicZCodeErrorCode, ZCODE_VERSION } from "@zcode/shared";
import { prepareServerCredentialStorage } from "@zcode/shared/credential-security";
import { SourceServerWorkspaceAliasRepo } from "@zcode/services/node";
import {
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  SERVER_READY_WAIT_TIMEOUT_MS,
  SERVER_CREDENTIAL_FORMAT,
  SERVER_CREDENTIAL_FORMAT_ENV,
  controlRequestSchema,
  createStoppedServerStatus,
  serverStatusSchema,
  type ServerStatus,
} from "./contracts.js";
import { requestControl } from "./ipc/controlClient.js";
import type { ServiceDescriptor } from "./platform/serviceManager.js";
import {
  resolveCanonicalServerLayout,
  resolveServerLayout,
  validateUninstallTarget,
} from "./runtime/paths.js";
import { validateServerInstallOwnership } from "./runtime/installationOwnership.js";
import { createReleaseAgentWiring, type BundledAgentWiring } from "./runtime/agentWiring.js";
import { writeStableLauncher } from "./runtime/stableLauncher.js";
import {
  runLocalArchiveUpdateCommand,
  runUpdateCommand,
  type UpdateDaemonHandoff,
} from "./runtime/updateCommand.js";
import { DataRootLock } from "./runtime/lock.js";
import { ReleaseManager } from "./runtime/releaseManager.js";
import { createUpdateDaemonHandoff } from "./runtime/updateHandoff.js";
import {
  acquireUninstallLock,
  describeLockInspection,
  removeRunContentsExceptLock,
} from "./runtime/uninstallGuard.js";
import { readPersistedStatus, readPersistedStatusDetailed } from "./runtime/statusSnapshot.js";
import {
  isStoppedServerStatus,
  readStatusForStopWithoutControl,
  stopSupervisorAndWait,
  waitForServerStopped,
} from "./runtime/shutdownWait.js";
export { readPersistedStatus } from "./runtime/statusSnapshot.js";
import {
  hasLegacyServiceRegistration,
  unregisterInstalledService,
  unregisterLegacyServiceForRoot,
} from "./runtime/serviceInstallation.js";
import { ProxyStdioError, runProxyStdio } from "./server-core/proxyStdio.js";

export interface CliIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
  confirm?: (prompt: string) => Promise<string>;
  legacyDelegate?: (argv: readonly string[]) => Promise<number>;
}

export interface ServerCliRuntimeOptions {
  bundledAgentWiring?: BundledAgentWiring | null;
  proxyStdioStreams?: { input: Readable; output: Writable };
  workspaceAliasRepo?: Pick<SourceServerWorkspaceAliasRepo, "retryFailedWorkspace">;
  /** process/service manager 是更新协调器的外部边界；测试可注入受控实现。 */
  updateDaemonHandoff?: UpdateDaemonHandoff;
}

const stdout = (io: CliIO, value: unknown): void =>
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const stderr = (io: CliIO, value: unknown): void =>
  io.stderr?.write(`${value instanceof Error ? value.message : String(value)}\n`);

async function acquireLifecycleCommandLock(
  layout: ReturnType<typeof resolveServerLayout>,
  conflictMessage: string,
): Promise<DataRootLock> {
  const lock = new DataRootLock(layout.updateLockFile);
  try {
    await lock.acquire();
    return lock;
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      throw new Error(conflictMessage, { cause: error });
    }
    throw error;
  }
}

export function serviceRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION !== "1";
}

export function daemonStartupMode(env: NodeJS.ProcessEnv = process.env): "service" | "fallback" {
  return serviceRegistrationEnabled(env) ? "service" : "fallback";
}

export function isRegisteredServiceEntry(args: readonly string[]): boolean {
  return args.includes("--service-entry");
}

export const SERVER_SERVICE_ARGS = ["serve", "--supervisor"] as const;

export function shouldRegisterService(
  daemonRequested: boolean,
  supervisorProcess: boolean,
): boolean {
  return daemonRequested && !supervisorProcess;
}

export async function runServerCli(
  argv: readonly string[],
  io: CliIO = {},
  runtimeOptions: ServerCliRuntimeOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const parsed = parseServerCliArguments(argv);
    const command = parsed.argv[0];
    if (command === "version" || command === "--version") {
      // Bug 原因：Server --version 过去落入 legacy delegate，实际输出取决于旁边的 Agent
      // zcode.cjs，Desktop probe 无法稳定判断 Server compatibility。
      stdout(io, json ? { product: "zcode-server", version: ZCODE_VERSION } : ZCODE_VERSION);
      return 0;
    }
    const proxyStdioRequested =
      command === "proxy-stdio" || (command === "server" && parsed.argv[1] === "proxy-stdio");
    const migrateRetryRequested = command === "migrate" && parsed.argv[1] === "retry";
    if (!command) {
      return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
    // 同一物理 data-root 的符号链接别名会派生不同 control endpoint 和 OS service
    // identity。生命周期命令统一在 IO 前收敛 root，避免第二个 Supervisor 绕过探测重复注册。
    const layout =
      ["serve", "status", "stop", "restart", "update", "uninstall"].includes(command) ||
      proxyStdioRequested ||
      migrateRetryRequested
        ? await resolveCanonicalServerLayout(parsed.layout.serverRoot)
        : parsed.layout;
    if (["serve", "update"].includes(command) && parsed.argv.includes("--prepare-credentials")) {
      // Desktop 的在线更新先于 ensureDaemon；候选 Core 启动前也必须准备同一持久密钥。
      await prepareServerCredentialStorage({
        filePath: join(layout.dataBaseDir, ".zcode", "v2", "credentials.json"),
      });
    }
    if (proxyStdioRequested) {
      try {
        await runProxyStdio({
          layout,
          input: runtimeOptions.proxyStdioStreams?.input ?? process.stdin,
          output: runtimeOptions.proxyStdioStreams?.output ?? process.stdout,
        });
        return 0;
      } catch (error) {
        const code = error instanceof ProxyStdioError ? error.code : "proxy-stdio-failed";
        io.stderr?.write(
          `${JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        return 1;
      }
    }
    if (migrateRetryRequested) {
      const pathIndex = parsed.argv.indexOf("--path");
      const workspacePath = pathIndex >= 0 ? parsed.argv[pathIndex + 1] : undefined;
      if (!workspacePath) throw new Error("migrate retry requires --path");
      if (!isAbsolute(workspacePath)) throw new Error("migrate retry --path must be absolute");
      const result = await (
        runtimeOptions.workspaceAliasRepo ?? new SourceServerWorkspaceAliasRepo()
      ).retryFailedWorkspace(workspacePath);
      stdout(io, json ? { ok: true, ...result } : `Migration recovered: ${result.canonicalKey}`);
      return 0;
    }
    switch (command) {
      case "serve":
        return await runServe(parsed.argv.slice(1), io, json, layout, runtimeOptions);
      case "stop":
        // Bug 原因：runControl 不接收 argv，`stop --wait` 曾被当成 ack 型 stop 立即返回，
        // 桌面端会在远端仍持锁时报告“已停止”。--wait 必须走统一的停止等待。
        if (parsed.argv.includes("--wait")) return await runStopAndWait(io, layout);
        return await runControl(command, io, json, {}, layout);
      case "restart": {
        // 与 update / uninstall 同一把生命周期命令锁：多台电脑或终端并发时，重启不能停掉正在被更新
        // 或卸载接管的服务。锁被占用时直接失败（不等待、不停止现有服务），沿用 uninstall 的冲突输出。
        const restartLock = await acquireLifecycleCommandLock(
          layout,
          "A ZCode Server update is already running",
        );
        try {
          return await runRestart(io, json, layout, runtimeOptions);
        } finally {
          await restartLock.release();
        }
      }
      case "status":
      case "running-tasks":
        return await runControl(command, io, json, {}, layout);
      case "update": {
        const updateLock = await acquireLifecycleCommandLock(
          layout,
          "Another ZCode Server update is already running",
        );
        const updateDaemonHandoff =
          runtimeOptions.updateDaemonHandoff ?? createUpdateDaemonHandoff();
        try {
          if (parsed.argv.includes("--from-archive")) {
            return await runLocalArchiveUpdateCommand(
              parsed.argv,
              io,
              json,
              layout,
              () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
              updateDaemonHandoff,
            );
          }
          return await runUpdateCommand(
            parsed.argv,
            io,
            json,
            layout,
            () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
            updateDaemonHandoff,
          );
        } finally {
          await updateLock.release();
        }
      }
      case "uninstall": {
        const uninstallLock = await acquireLifecycleCommandLock(
          layout,
          "A ZCode Server update is already running",
        );
        try {
          return await runUninstall(io, json, layout);
        } finally {
          await uninstallLock.release();
        }
      }
      default:
        return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
  } catch (error: unknown) {
    if (json) {
      const structured =
        error && typeof error === "object"
          ? (error as { code?: unknown; retryable?: unknown })
          : null;
      const publicCode = isPublicZCodeErrorCode(structured?.code) ? structured.code : undefined;
      stdout(io, {
        ok: false,
        ...(publicCode ? { code: publicCode } : {}),
        ...(publicCode && typeof structured?.retryable === "boolean"
          ? { retryable: structured.retryable }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } else stderr(io, error);
    return 1;
  }
}

function parseServerCliArguments(argv: readonly string[]): {
  argv: readonly string[];
  layout: ReturnType<typeof resolveServerLayout>;
} {
  const rootOptionIndexes = argv.flatMap((value, index) =>
    value === "--server-root" ? [index] : [],
  );
  if (rootOptionIndexes.length > 1) throw new Error("--server-root may only be specified once");
  const rootOptionIndex = rootOptionIndexes[0];
  if (rootOptionIndex === undefined) return { argv, layout: resolveServerLayout() };
  const serverRoot = argv[rootOptionIndex + 1];
  if (!serverRoot) throw new Error("--server-root requires an absolute path");
  if (!isAbsolute(serverRoot)) throw new Error("--server-root must be an absolute path");
  return {
    argv: argv.filter(
      (_value, index) => index !== rootOptionIndex && index !== rootOptionIndex + 1,
    ),
    layout: resolveServerLayout(serverRoot),
  };
}

async function runServe(
  args: readonly string[],
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
): Promise<number> {
  const daemonRequested = args.includes("--daemon");
  const supervisorProcess = args.includes("--supervisor");
  if (shouldRegisterService(daemonRequested, supervisorProcess)) {
    // 失败详情只采用本次启动之后写下的 Supervisor 失败记录（R2 §7.1）。
    const startupStartedAt = Date.now();
    let startupMode = daemonStartupMode();
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    if (startupMode === "service") {
      const { isServiceManagerAvailable } = await import("./platform/serviceManager.js");
      if (!(await isServiceManagerAvailable(platform))) {
        // Bug 原因：SSH 过去把 transport 类型等同于“必有 systemd --user/launchd”。
        // 容器、最小系统和无 user bus 的非交互会话因此在安装完成后必然连接失败。
        startupMode = "fallback";
      }
    }
    const legacyIdentityMigration =
      startupMode === "service" && (await hasLegacyServiceRegistration(layout));
    const existing = await readControlStatus(layout, 500);
    if (existing && (existing.state === "ready" || existing.state === "starting")) {
      // Bug 原因：fallback 现在可能是 systemd 装载失败的正常结果。旧逻辑在服务管理器可用时停掉空闲
      // fallback 再注册，重连时只会再次注册失败并重新拉起；有运行任务时还直接报错，连接被阻断。
      // 存活的 daemon 一律复用，只有同 root 的旧 identity service 仍需迁移。
      if (!legacyIdentityMigration) {
        // Bug 原因：复用 starting 的 Supervisor 时曾立即以 exit 0 返回 port:null，Desktop 只认带端口的
        // 成功结果，于是报 "did not report a valid ingress port"，daemon 随后照常 ready。
        const reused = existing.state === "ready" ? existing : await waitForControlReady(layout);
        if (json) stdout(io, reused);
        else
          stdout(io, `ZCode Server ${reused.state} at ${reused.host ?? ""}:${reused.port ?? ""}`);
        return 0;
      }
      if (existing.runningTaskCount > 0) {
        throw new Error(
          `Cannot replace legacy service daemon while ${existing.runningTaskCount} task(s) are running; stop the server first`,
        );
      }
      // 旧 identity 的 daemon 会持有 data-root lock，直接注册并启动新 identity 只能
      // 拉起一个立即锁冲突的 Supervisor。空闲时先收口旧 daemon，再注册新 identity。
      await stopSupervisorAndWait(layout, "legacy service migration");
    } else if (existing?.state === "stop-failed" && existing.pid === null) {
      // Bug 原因：stop-failed 的 Supervisor 观察到迟到的 Core 终态后仍持有锁和 control socket，
      // 直接启动只会让新 Supervisor 锁冲突，设备在手工 stop 前无法恢复。已无存活 Core 时由
      // 原 owner 按 stop 契约收口；pid 仍存在则不发 stop，继续由锁 fail-closed。
      await stopSupervisorAndWait(layout, "stop-failed restart");
    }
    // 没有复用、也没有被停止的现有 Supervisor（如 crash-loop-stopped）仍在运行并持有锁；
    // 等待失败时带出它在 control 上的实时状态。
    const unreusedSupervisor =
      existing &&
      existing.state !== "ready" &&
      existing.state !== "starting" &&
      !(existing.state === "stop-failed" && existing.pid === null)
        ? existing
        : undefined;
    const baselineUpdatedAt = (await readPersistedStatus(layout))?.updatedAt ?? 0;
    let serviceStarted = false;
    let serviceFallbackReason: string | undefined;
    let childEarlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let reapForkedSupervisor: (() => Promise<void>) | undefined;
    let registeredServiceDescriptor: ServiceDescriptor | undefined;
    if (startupMode === "service") {
      const {
        createDaemonServiceDescriptor,
        isServiceLoadFailure,
        registerService,
        serviceDescriptorPath,
      } = await import("./platform/serviceManager.js");
      await writeStableLauncher(layout, platform, {
        command: process.execPath,
        entry: process.argv[1] ?? fileURLToPath(import.meta.url),
      });
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      await mkdir(layout.serviceDir, { recursive: true, mode: 0o700 });
      const descriptorPath = serviceDescriptorPath(layout, descriptor);
      await writeFile(descriptorPath, descriptor.content, "utf8");
      await unregisterLegacyServiceForRoot(layout);
      try {
        await registerService(descriptor, descriptorPath);
        serviceStarted = true;
        registeredServiceDescriptor = descriptor;
      } catch (error) {
        // Bug 原因：能力探测只证明 user manager 的 bus 能连上。enable 由 manager 用它自己的组列表和
        // 挂载视图读取 unit；manager 启动后才加入的组、manager 的私有 /tmp 都让它读不到 server root，
        // 旧规则把这次失败直接返回，SSH 每次重连都失败，而同一 root 的 detached fallback 能正常运行。
        // 装载阶段失败时本次没有启动任何 unit，改用 fallback 并带回原因；启动阶段失败时 unit 已启用，
        // 未标记阶段的错误（launchd / Task Scheduler）也不能确认现场，仍原样返回。
        if (!isServiceLoadFailure(error)) throw error;
        serviceFallbackReason = (error as Error).message.trim();
        if (!json)
          stderr(io, `Starting ZCode Server in detached fallback mode: ${serviceFallbackReason}`);
      }
    }
    if (!serviceStarted) {
      // Bug 原因：archive bootstrap 协调更新时 import.meta.url 指向临时解压目录；handoff
      // 后该目录会被清理。fallback 必须复用本次目标 release 的真实 argv 入口。
      const supervisorEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
      const child = fork(
        supervisorEntry,
        [...SERVER_SERVICE_ARGS, "--server-root", layout.serverRoot],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
            ZCODE_SERVER_ROOT: layout.serverRoot,
          },
        },
      );
      child.unref();
      // Supervisor 是独立 daemon，不需要保留 CLI↔Supervisor 的 IPC 通道；关闭该通道
      // 才能让一次性的 `serve --daemon` CLI 在返回 ready 后真正退出。
      child.disconnect();
      // 子 Supervisor 以 detached + stdio ignore 启动，锁冲突等启动失败时静默退出；
      // 记录早退信息让等待循环立即报告真实原因。
      const childExited = new Promise<void>((resolve) => {
        child.once("exit", (code, signal) => {
          childEarlyExit = { code, signal };
          resolve();
        });
      });
      reapForkedSupervisor = async () => {
        // 已 unref 的 child 不再撑住事件循环；不重新 ref 的话，CLI 会在 exit 到达前无输出地退出。
        child.ref();
        child.kill("SIGKILL");
        await childExited;
      };
    }
    // Bug 原因（ZCT-2117253090228297728 / ZCT-2117275161536565248）：本次启动没有写过状态时，错误只有原首句，
    // 而原因都在远端：现有 Supervisor 停在 crash-loop-stopped、新 Supervisor 写状态前就失败（fallback 方式的输出被
    // stdio:ignore 丢弃，OS service 只进 journal）、unit 无法执行或被结束。等待失败时补齐 CLI 已掌握的这些事实。
    const readStartupFailureFacts = async (): Promise<string[]> => {
      const facts: string[] = [];
      if (unreusedSupervisor) {
        facts.push(
          `running supervisor: state=${unreusedSupervisor.state}${unreusedSupervisor.lastExitReason ? `, last exit: ${unreusedSupervisor.lastExitReason}` : ""}`,
        );
      }
      const supervisorFailure = await readSupervisorStartupFailure(layout, startupStartedAt);
      if (supervisorFailure) facts.push(`supervisor: ${supervisorFailure}`);
      if (registeredServiceDescriptor) {
        const { describeServiceState } = await import("./platform/serviceManager.js");
        const serviceState = await describeServiceState(registeredServiceDescriptor);
        if (serviceState) facts.push(`service: ${serviceState}`);
      }
      return facts;
    };
    let started: ServerStatus;
    try {
      started = await waitForPersistedStatus(
        layout,
        "ready",
        baselineUpdatedAt,
        () =>
          childEarlyExit
            ? `ZCode Server daemon exited before ready (code=${childEarlyExit.code ?? "null"} signal=${childEarlyExit.signal ?? "none"})`
            : undefined,
        serviceStarted,
        readStartupFailureFacts,
      );
    } catch (error) {
      // Bug 原因：CLI 放弃等待后，冷启动过慢的 fallback Supervisor 仍会取锁并 ready，调用方拿到的
      // 失败与远端事实相反，update 回滚的 stop 还可能因它尚未监听 control 而够不着、随后争锁。
      // fallback Supervisor 由本 CLI fork，CLI 是唯一 owner：先强杀并等到 exit 再报失败
      // （Core 经 IPC 断连自行收口，残留锁按 stale 由下一任接管）。OS service 由服务管理器持有，不越权停止。
      await reapForkedSupervisor?.();
      throw error;
    }
    // 回退原因只属于本次启动结果，不写入 status.json。
    if (json) stdout(io, serviceFallbackReason ? { ...started, serviceFallbackReason } : started);
    else stdout(io, `ZCode Server ${started.state} at ${started.host ?? ""}:${started.port ?? ""}`);
    process.stdin.pause();
    process.stdin.destroy();
    return 0;
  }
  const daemon = supervisorProcess;
  const { Supervisor } = await import("./supervisor/supervisor.js");
  const serviceRegistered = supervisorProcess && isRegisteredServiceEntry(args);
  // 写出第一份状态前的失败（读取 current、安装归属、取 data-root 锁）留下诊断记录，供发起 serve --daemon 的 CLI
  // 带进错误详情；前台 serve 直接把错误输出给用户，不需要记录。
  const recordStartupFailure = async (error: unknown): Promise<never> => {
    if (supervisorProcess) await recordSupervisorStartupFailure(layout, error);
    throw error;
  };
  const executingRelease = await new ReleaseManager(layout)
    .readCurrent()
    .catch(recordStartupFailure);
  const executingEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const executingReleaseDir = dirname(dirname(resolve(executingEntry)));
  const supervisorReleaseId =
    executingRelease?.releaseId &&
    resolve(executingRelease.releaseDir) === resolve(executingReleaseDir)
      ? executingRelease.releaseId
      : undefined;
  let foregroundStopped: (() => void) | undefined;
  const supervisor = new Supervisor({
    layout,
    launcher: {
      launch: (generation, release) => {
        const runtimeRoot = release?.releaseDir ? join(release.releaseDir, "runtime") : null;
        const corePath = runtimeRoot
          ? join(runtimeRoot, "server-core.js")
          : fileURLToPath(new URL("./server-core.js", import.meta.url));
        const runtimeNode = runtimeRoot
          ? join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node")
          : process.execPath;
        const inheritedEnv = {
          ...process.env,
          ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
        };
        const releaseWiring = runtimeRoot
          ? createReleaseAgentWiring(runtimeRoot, runtimeNode, inheritedEnv)
          : runtimeOptions.bundledAgentWiring;
        return fork(corePath, [String(generation)], {
          execPath: runtimeNode,
          env: {
            ...inheritedEnv,
            [SERVER_CREDENTIAL_FORMAT_ENV]: String(SERVER_CREDENTIAL_FORMAT),
            ...releaseWiring,
            ...(runtimeRoot ? { ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot } : {}),
            ...(release?.releaseId ? { ZCODE_SERVER_RELEASE_ID: release.releaseId } : {}),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      },
    },
    version: ZCODE_VERSION,
    ...(supervisorReleaseId ? { supervisorReleaseId } : {}),
    serviceRegistered,
    onStopped: () => {
      process.stdin.pause();
      foregroundStopped?.();
      if (supervisorProcess) process.disconnect?.();
    },
    // 失去 server root 后 control server 仍在监听，不能靠 return 结束进程；关闭它又会按路径删掉新 owner 的 socket。
    // 锁文件不存在属于异常退出：OS service 按 Restart=on-failure / KeepAlive 重新拉起真正的 owner。
    // Bug 原因：锁已被其他 owner 接管时也以 1 退出。共享 home 的两台主机都把对方活着的锁判为 stale，
    // 两边的服务管理器轮流重启、互相接管，每轮都停掉 Core。新 owner 已在运行，以 0 退出，服务管理器不再重启。
    onServerRootLost: (loss) => process.exit(loss === "missing" ? 1 : 0),
  });
  await supervisor.start().catch(recordStartupFailure);
  let status: ServerStatus;
  try {
    status = await waitForSupervisorReady(supervisor);
  } catch (error) {
    // Core 进入 crash-loop 时不能把错误直接抛给 CLI 顶层返回：control
    // socket 仍持有事件循环导致前台进程假死；用户 Ctrl+C（此时信号 handler 尚未注册，
    // 走默认强杀）后锁文件与 socket 残留，后续 serve 永远报 "already running"。
    // 启动失败必须先停 Supervisor 收口锁与 socket，再上抛错误。
    await supervisor.stop("startup-failed").catch(() => undefined);
    throw error;
  }
  if (json) stdout(io, status);
  else stdout(io, `ZCode Server ${status.state} at ${status.host ?? ""}:${status.port ?? ""}`);
  await new Promise<void>((resolve) => {
    foregroundStopped = resolve;
    if (!daemon) {
      const finish = () => {
        void supervisor.stop("signal").then(() => resolve());
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    }
  });
  return 0;
}

// apply-update 服务端最坏路径包含旧 Core 停止、新 Core ready 等待、新 Core 回滚停止、
// 旧 Core ready 等待以及旧 Core ready 超时后的再次停止，即三次停止预算加两次 ready 预算，
// 另需为 current/pending 文件操作和 IPC 调度留出余量。客户端超时必须覆盖完整回滚路径，
// 否则 CLI 会在 update 仍在后台执行时误报超时（R2-CLI-08）。
export const APPLY_UPDATE_TIMEOUT_MS =
  3 * (CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS) + 2 * CORE_READY_TIMEOUT_MS + 30_000;

async function requestApplyUpdate(
  layout: ReturnType<typeof resolveServerLayout>,
  force: boolean,
): Promise<unknown> {
  return await requestControl(
    layout.controlEndpoint,
    { command: "apply-update", ...(force ? { force: true } : {}) },
    APPLY_UPDATE_TIMEOUT_MS,
  );
}

async function runControl(
  command: string,
  io: CliIO,
  json: boolean,
  extra: Record<string, unknown> = {},
  layout = resolveServerLayout(),
): Promise<number> {
  const request = controlRequestSchema.parse({ id: "cli", command, ...extra });
  let result: unknown;
  try {
    result = await requestControl(
      layout.controlEndpoint,
      request,
      command === "apply-update" ? APPLY_UPDATE_TIMEOUT_MS : undefined,
    );
  } catch (error: unknown) {
    if (command === "status") {
      const persisted = await readPersistedStatusDetailed(layout);
      result = persisted.status ?? createStoppedServerStatus(ZCODE_VERSION);
    } else if (command === "stop") {
      // 快照缺失表示 daemon 从未写出过状态，按已停止输出。
      result =
        (await readStatusForStopWithoutControl(layout, error)) ??
        createStoppedServerStatus(ZCODE_VERSION);
    } else {
      throw error;
    }
  }
  if (json) stdout(io, result);
  else stdout(io, result ?? "ok");
  return 0;
}

/**
 * `stop --wait`：data-root 锁释放且 status 为比基线新的 stopped 后才输出最终 ServerStatus（R2 §8.1）。
 * daemon 未运行（锁缺失或 stale）时立即成功；stop-failed 与 control 超时以公开错误码失败。
 */
async function runStopAndWait(
  io: CliIO,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  await stopSupervisorAndWait(layout, "stop");
  const persisted = await readPersistedStatusDetailed(layout);
  const status = persisted.status;
  // Supervisor 已死时快照可能仍停在死前的 ready；输出只表达“已停止”这一最终事实。
  stdout(
    io,
    isStoppedServerStatus(status)
      ? status
      : createStoppedServerStatus(ZCODE_VERSION, {
          serviceRegistered: status?.serviceRegistered ?? false,
        }),
  );
  return 0;
}

/**
 * 整棵进程树重启（R2 §8.1），由发起命令的 CLI 协调，不在持锁的 Supervisor 内自举。
 *
 * Bug 原因：旧 `restart` 只经 control 让 Supervisor 在进程内换 Core，Supervisor 与崩溃预算不变；
 * daemon 未运行或 Supervisor 已死但残留 socket 时直接报错，`crash-loop-stopped` 也无法自救。
 * 现在先用统一停止等待收口现有 Supervisor（锁缺失或 stale 即视为未运行，跳过停止；新的
 * `stop-failed` 以公开码失败且不启动新实例），再按 `serve --daemon` 启动并等 ready。本进程由
 * stable launcher 从 current release 执行，启动方式沿用同一环境判定（OS service / detached fallback）。
 */
async function runRestart(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
): Promise<number> {
  await stopSupervisorAndWait(layout, "restart");
  return await runServe(["--daemon"], io, json, layout, runtimeOptions);
}

async function runUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  const first = await (io.confirm?.("Type DELETE to uninstall ZCode Server: ") ??
    Promise.resolve(""));
  if (first !== "DELETE") throw new Error("Uninstall cancelled");
  const second = await (io.confirm?.("Type DELETE again to confirm: ") ?? Promise.resolve(""));
  if (second !== "DELETE") throw new Error("Uninstall cancelled");
  // 不能把同一个 --server-root 同时作为 allowlist 根和删除目标：包含关系
  // 恒成立，任何绝对目录都能被卸载流程递归删除。停止服务前必须先验证安装归属。
  const ownership = await validateServerInstallOwnership(layout);
  try {
    await runControl("confirm-uninstall", io, json, { confirmation: "DELETE" }, layout);
  } catch (error: unknown) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (isStoppedServerStatus(persisted.status))
      return await finishUninstall(io, json, layout, ownership);
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "active") {
      throw new Error(`Cannot uninstall while Server lock is held by pid ${lockInspection.pid}`, {
        cause: error,
      });
    }
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(
        `Cannot verify Server shutdown before uninstall (${describeLockInspection(lockInspection)})`,
        { cause: error },
      );
    }
  }
  await waitForServerStopped(layout);
  return await finishUninstall(io, json, layout, ownership);
}

async function finishUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  ownership: Awaited<ReturnType<typeof validateServerInstallOwnership>>,
): Promise<number> {
  await unregisterInstalledService(layout);
  const uninstallLock = await acquireUninstallLock(layout);
  // 根因：删除 install.json 会在数据仍保留时生成新设备身份，App 因此归档原连接并拆出新设备。
  // 正式卸载只移除运行资产；身份随用户数据保留，卸载状态仍由 uninstalled.json 保护。
  const uninstallEntries = [
    "releases",
    "run",
    "cache",
    "bin",
    "service",
    "current.json",
    "pending.json",
    "downgrade.json",
    "uninstalled.json",
    "update-transaction.json",
    "node",
    "zcode-server.cjs",
    "agents",
    "build",
    "tools",
  ] as const;
  try {
    for (const entry of uninstallEntries) {
      const target = validateUninstallTarget(
        ownership.canonicalServerRoot,
        join(ownership.canonicalServerRoot, entry),
      );
      if (!target.ok || !target.canonicalPath) {
        throw new Error(`Unsafe uninstall target: ${target.reason ?? "unknown"}`);
      }
      if (entry === "run") {
        await removeRunContentsExceptLock(layout);
      } else {
        await rm(target.canonicalPath, { recursive: true, force: true });
      }
    }
    const preservedPaths = (await readdir(ownership.canonicalServerRoot))
      .filter((entry) => entry !== "run")
      .sort();
    // server root 允许用户显式指定，不能递归删除未知内容。卸载只清理上面的
    // ZCode allowlist，并把保留项写入结果供用户审计。先落盘 marker，再释放 lock，
    // 让并发 Supervisor 在删除 run 目录的最后窗口也会 fail-closed。
    await writeFile(
      layout.uninstalledFile,
      `${JSON.stringify({ uninstalled: true, uninstalledAt: Date.now(), version: ZCODE_VERSION, preservedPaths }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await uninstallLock.release();
    await rm(layout.runDir, { recursive: true, force: true });
    if (json) stdout(io, { uninstalled: true, preservedPaths });
    else stdout(io, "uninstalled");
    return 0;
  } catch (error: unknown) {
    await uninstallLock.release().catch(() => undefined);
    throw error;
  }
}

// Bug 原因：Core 启动失败时 Supervisor 已把原因写进 status，CLI 等待失败却只报
// "Timed out waiting for Server ready"，3.16.2 远端超时工单因此查不到 Core 为什么起不来。
// 失败时追加本次启动写过的 state 与 lastExitReason；启动前的旧快照不能冒充本次原因。
function describeStartupStatus(status: ServerStatus | null, minUpdatedAt: number): string {
  if (!status || status.updatedAt <= minUpdatedAt) return "";
  return ` (state=${status.state}${status.lastExitReason ? `, last exit: ${status.lastExitReason}` : ""})`;
}

// 追加的 Core 原因可能含 permission denied、ECONNREFUSED、timeout 等文本；Desktop 按文本猜类别时
// 会因此改换 UI 标题。按原首句的类别显式带码（与追加详情前 Desktop 的判定一致），详情只用于展示。
function startupWaitError(
  message: string,
  code: "remote-connection-timeout" | "remote-connection-unknown",
): Error {
  return Object.assign(new Error(message), { code });
}

async function waitForPersistedStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  expectedState: "ready" | "stopped",
  minUpdatedAt = 0,
  /** 返回值非空表示等待对象已失败，值为错误首句；状态详情由本函数追加。 */
  readEarlyFailure?: () => string | undefined,
  expectedServiceRegistered?: boolean,
  /** 本次启动没有写过状态时，失败详情改用这些事实（R2 §7.1）；只在失败时调用。 */
  readFailureFacts?: () => Promise<string[]>,
): Promise<ServerStatus> {
  const describeFailureFacts = async (): Promise<string> => {
    const facts = (await readFailureFacts?.().catch(() => [])) ?? [];
    return facts.length > 0 ? ` (${facts.join("; ")})` : "";
  };
  const deadline = Date.now() + SERVER_READY_WAIT_TIMEOUT_MS;
  let lastStatus: ServerStatus | null = null;
  while (Date.now() < deadline) {
    const status = await readPersistedStatus(layout);
    if (
      status?.state === expectedState &&
      status.updatedAt > minUpdatedAt &&
      (expectedServiceRegistered === undefined ||
        status.serviceRegistered === expectedServiceRegistered)
    )
      return status;
    lastStatus = status ?? lastStatus;
    const earlyFailure = readEarlyFailure?.();
    if (earlyFailure) {
      // Supervisor 退出前写下的最终状态可能晚于本轮读取，报告前再读一次。
      const detail =
        describeStartupStatus((await readPersistedStatus(layout)) ?? lastStatus, minUpdatedAt) ||
        (await describeFailureFacts());
      throw startupWaitError(
        `${earlyFailure}${detail || `; check ${layout.statusFile} for details`}`,
        "remote-connection-unknown",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const detail = describeStartupStatus(lastStatus, minUpdatedAt) || (await describeFailureFacts());
  throw startupWaitError(
    `Timed out waiting for Server ${expectedState}${detail}`,
    "remote-connection-timeout",
  );
}

// Supervisor 写出第一份状态前失败时的诊断记录（R2 §7.1）。失败的实例不持有锁，不能写 status.json；
// 记录只供发起 serve --daemon 的 CLI 带进错误详情，任何状态判断都不读它，写入失败不改变原错误。
async function recordSupervisorStartupFailure(
  layout: ReturnType<typeof resolveServerLayout>,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 300);
  const temporary = `${layout.supervisorStartupFailureFile}.${process.pid}.tmp`;
  try {
    await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify({ pid: process.pid, version: ZCODE_VERSION, at: Date.now(), message })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, layout.supervisorStartupFailureFile);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** 读取 at 不早于 since 的失败记录；本次启动之前留下的记录不能冒充本次原因。 */
async function readSupervisorStartupFailure(
  layout: ReturnType<typeof resolveServerLayout>,
  since: number,
): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(layout.supervisorStartupFailureFile, "utf8")) as {
      at?: unknown;
      message?: unknown;
    };
    if (typeof record.at !== "number" || record.at < since) return undefined;
    return typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

// 复用的 Supervisor 已在运行，control 是它的实时状态；status.json 可能是旧 Supervisor 留下的
// ready 快照（端口已失效），不能作为复用时的就绪依据。
async function waitForControlReady(
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<ServerStatus> {
  const deadline = Date.now() + SERVER_READY_WAIT_TIMEOUT_MS;
  let lastStatus: ServerStatus | null = null;
  while (Date.now() < deadline) {
    const status = await readControlStatus(layout, 500);
    if (status?.state === "ready") return status;
    lastStatus = status ?? lastStatus;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  // 复用的是正在运行的 Supervisor，control 返回的就是它当前的状态，不需要按启动基线过滤。
  throw startupWaitError(
    `Timed out waiting for Server ready${describeStartupStatus(lastStatus, 0)}`,
    "remote-connection-timeout",
  );
}

async function waitForSupervisorReady(supervisor: {
  status: () => ServerStatus;
}): Promise<ServerStatus> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = supervisor.status();
    if (status.state === "ready") return status;
    if (status.state === "crash-loop-stopped")
      throw new Error("Server Core entered crash-loop-stopped");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server Core ready");
}

async function readControlStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  timeoutMs: number,
): Promise<ServerStatus | null> {
  try {
    const result = await requestControl(layout.controlEndpoint, { command: "status" }, timeoutMs);
    return serverStatusSchema.parse(result);
  } catch {
    return null;
  }
}

async function delegateLegacyCli(argv: readonly string[], io: CliIO): Promise<number> {
  const candidate =
    process.env.ZCODE_LEGACY_CLI_ENTRY?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "zcode.cjs");
  try {
    await access(candidate);
  } catch {
    stdout(io, argv.length ? `Unknown command: ${argv[0]}` : "ZCode TUI");
    return argv.length ? 1 : 0;
  }
  const child = fork(candidate, [...argv], { stdio: "inherit" });
  return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}
