import { spawnWindowsRuntimeHost } from "#src/windows-runtime-host/index.js";
import { localRuntimeNetworkCapture } from "#src/zcode-agent/localRuntimeNetworkCapture.js";
import { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zcode-agent/zcodeAgent.js";
/* eslint-disable max-lines -- zcodeAgentProcessManager 集中维护 agent 子进程启动、复用、超时回收和 runtime identity，拆分会扩大进程生命周期状态同步面 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Emitter } from "@zcode/rpc";
import { GEN_UI_OUTPUT_DIRECTORY, GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { getAppConfigDir, getZCodeDataRootDir } from "#src/paths.js";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@zcode/shared/process-diagnostic";
import {
  classifyAgentProcessExitCause,
  redactAgentDiagnosticSecrets,
  type AgentProcessExitCause,
} from "@zcode/shared/agent-crash-diagnostic";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  ZCODE_RUNTIME_ENV_KEY,
  resolveWorkspaceKey,
  resolveZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
} from "@zcode/shared";
import {
  findZCodeAgentRuntimeBinary,
  findZCodeAgentRuntimeNodeBundle,
} from "../runtime-tools/providerRuntimeResolver.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "./zcodeStdioTransport.js";
import { readZCodeStdioTapDevState } from "./zcodeStdioTapDevConfig.js";
import type { ZCodeAgentPresentationSurface } from "./zcodeAgentPresentationSurface.js";
import { shouldSpawnInDetachedProcessGroup } from "../process/processTreeTerminator.js";
import type { RuntimeProcessLifecycleReporter } from "../process/runtimeProcessLifecycle.js";
import { buildAgentWorkspaceIdentityEnv } from "../runtime-tools/agentProxyEnv.js";

export interface ZCodeAgentCommand {
  /** 本地配套 CLI bundle 的存储专用 Worker 入口；远端/自定义命令不推断能力。 */
  storagePreparationEntry?: string;
  /** 本次部署的 Agent 支持迁移前的启动通知；旧自定义命令保持原协议。 */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ZCodeAgentCommandResolverContext {
  presentationSurface?: ZCodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export type ZCodeAgentCommandResolver = (
  context: ZCodeAgentCommandResolverContext,
) => Promise<ZCodeAgentCommand | null> | ZCodeAgentCommand | null;

type RuntimeWorkspace = { workspacePath: string; workspaceIdentity?: string };
const SHARED_TASK_RUNTIME_KEY = "shared-local-tasks";
interface RuntimeBinding {
  workspace: RuntimeWorkspace;
  processKey: string;
}

export interface ZCodeAgentProcessManagerOptions {
  /** Host 项目事实决定首次分配；运行中的绑定不随项目移动改变。 */
  useSharedTaskRuntime?: (workspace: RuntimeWorkspace) => Promise<boolean>;

  commandResolver?: ZCodeAgentCommandResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * 进程泳道标识。同一 workspace 的不同泳道各走独立 manager 实例；lane 会写入
   * runtimeIdentity 与 spawn/exit 日志，便于排障区分。
   * 缺省为 chat 主泳道，不追加任何标记。
   */
  lane?: string;
  /**
   * 空闲回收阈值：连接上没有请求在飞持续超过该时长，就主动回收整棵进程树，
   * 下次 getClient 透明重新拉起。只给 mcp-status 这类“按需探测、进程内挂着 MCP 子进程”
   * 的控制面 lane 使用；chat / plugin 缺省不回收。
   */
  idleTimeoutMs?: number;
  /**
   * 仅当默认进程 cwd 等于目标 workspace 且该目录不可用时使用。
   * 业务 workspacePath/workspaceKey 不随 cwd 兜底改变。
   */
  spawnFallbackCwd?: string;
  /**
   * 每次 spawn agent 子进程前解析的额外环境变量（在 process.env 之后、workspace 变量之前合入）。
   * 用于把设置页的代理等配置注入子进程；按 spawn 时读取，天然「下次启动生效」。
   *
   * context 携带本次 spawn 的 workspace 标识三元组（workspacePath/workspaceIdentity/workspaceKey）。
   * Helper lifecycle 不再回收或重启已有 Agent。
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * 可选的外部 spawn admission hook。CUA 默认装配不再注入 Helper recovery gate，
   * 避免 Helper lifecycle 阻塞或间接重启 Agent；保留该通用 hook 供其他产品策略使用。
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
}

interface ManagedZCodeAgentProcess {
  client: ZCodeProtocolClient;
  child: ChildProcessWithoutNullStreams;
  runtimePid: number | undefined;
  cleanupPromise?: Promise<void>;
  exitDiagnosticsCompleted: Promise<void>;
  exited: boolean;
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

type AgentProcessCleanupReason =
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "workspace-dispose"
  | "workspace-dispose-retry";

interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

const E2E_COVERAGE_PRELOAD_SOURCE = `
const { takeCoverage } = require("node:v8");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const coverageDirectory = process.env.NODE_V8_COVERAGE;
let coverageFlushStarted = false;
for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const flushCoverage = () => {
    if (coverageFlushStarted) return;
    coverageFlushStarted = true;
    if (coverageDirectory) {
      writeFileSync(
        resolve(coverageDirectory, \`coverage-signal-\${process.pid}.marker\`),
        signal,
      );
    }
    try {
      takeCoverage();
    } catch (error) {
      if (coverageDirectory) {
        writeFileSync(
          resolve(coverageDirectory, \`coverage-signal-error-\${process.pid}.txt\`),
          error instanceof Error ? error.stack || error.message : String(error),
        );
      }
    }
    if (process.listenerCount(signal) !== 1) return;
    setTimeout(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    }, 1000);
  };
  process.prependListener(signal, flushCoverage);
}
if (coverageDirectory) {
  writeFileSync(resolve(coverageDirectory, \`coverage-ready-\${process.pid}.marker\`), "");
}
`;

export function buildE2EAgentCoverageEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "zcode-e2e-coverage-preload.cjs");
  // CLI bundle 未压缩时解析耗时可能超过 E2E 的早退窗口，普通 shutdown
  // handler 尚未注册就收到 SIGTERM。用 NODE_OPTIONS preload 在解析 bundle 前接管落盘。
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * （CLI 重连重订边界）：同一 workspace 的 agent 进程被重建（超时回收/崩溃后
 * 首个 getClient 重新拉起）。v4 订阅（sessions-index/workspace-config/conversation）
 * 都活在 CLI 进程内存里，进程换代即失效——订阅方收到本事件后必须重发 subscribe。
 */
export interface ZCodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
}

export interface ZCodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

/**
 * 当前 runtime 进程意外退出（不是回收、换代或关闭）。在 stderr 收齐、退出码可用之后发布，
 * 因此晚于同一进程的 unavailable；界面据此说明原因，状态收口仍以 CLI 投影为准。
 */
export interface ZCodeAgentRuntimeExitedEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  exitCode: number | null;
  signal: string | null;
  /** 退出码能确定的原因；目前只有 Windows 0xE0000008（系统可提交内存耗尽）。 */
  cause?: AgentProcessExitCause;
  exitedAt: number;
}

export interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** 进程泳道标识；chat 主泳道缺省为空。 */
  lane?: string;
}

interface ZCodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}

const serviceLog = createServiceLogger("zcode-agent");

const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;
// 裸 key 和凭据必须在跨进程诊断和生产日志之前遮盖。规则与 desktop main 上报前共用一份：
// 这里曾自带一套、先做赋值替换，把 `Authorization: Bearer <token>` 的 `Bearer` 换掉后，
// main 再也认不出 token，token 随 errorStack 上报到 ARMS。
function redactAgentDiagnostic(value: string): string {
  return redactAgentDiagnosticSecrets(value);
}

const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};

function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnostic(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}

function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function buildZCodeAgentSpawnPreflight(
  command: ZCodeAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ZCodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveZCodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // Node spawn 的 ENOENT 既可能来自 command 缺失，也可能来自 cwd 缺失。
    // 生产日志在 spawn 前同时记录两者可见性，避免把工作区路径丢失误判成自动更新丢 binary。
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

function resolveBundledWorkspaceZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const distEntrypoint = findUpward("apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (distEntrypoint) {
    const useBytecode =
      process.versions.electron && process.env.ZCODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), "zcode.bytecode.cjs")
      : distEntrypoint;
    // 此同步 command resolver 沿用既有 existsSync 契约；显式试验不能静默回退成 JS。
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // Worker 与 Electron Node 子进程的 V8 snapshot 可不同；临时存储准备继续用 JS。
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // 桌面端 host 运行在 Electron utility process 中，process.execPath 指向 Electron Helper。
      // 这里显式启用 Node 运行模式，避免内置 zcode-agent 被当成 Electron/Chromium 子进程启动并卡在 GPU 初始化。
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zcode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

function resolveDeployedZCodeAgentBinaryCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // 旧 resolver 只识别 ZCODE_AGENT_SERVER_COMMAND env 和 monorepo 源码树。
  // SSH 远端把 zcode-server.cjs 单文件部署到 ~/.zcode/server/，宿主进程的 cwd 不在仓库内、
  // env 也不会被 ssh exec 继承，即使 zcode-agent 已经部署到 ~/.zcode/server/agents/glm/，
  // resolver 也找不到，第一次 getClient 就抛 "ZCode agent server command is not configured"。
  // 这里复用 findZCodeAgentRuntimeBinary 的候选链（含 GLM_BINARY_PATH env、
  // packagedResourcesPath、~/.zcode/server/agents/glm、bundled-agents 等），
  // 把已部署的原生 binary 当成最终兜底，远端/桌面打包形态都能命中。
  const binaryPath = findZCodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ZCODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

function resolveElectronRuntimeZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // 桌面打包态：host 跑在 Electron utility process 里，process.execPath 指向 Electron Helper，
  // 它内置的 Node runtime 与 zcode-cli 目标版本一致（Electron 41 = Node 24.x）。
  // 这里直接用 app 自带的 Electron Node 执行打进 resources/glm 的 zcode.cjs，
  // 不再随包内置一份独立 Node 二进制（体积从 ~180MB 降到 ~16MB，且跨平台同一份 JS）。
  // 用 process.versions.electron 作为闸门：远端 SSH/WSL host 由系统 Node 运行、没有 electron，
  // 会跳过这里继续走原生二进制兜底，桌面/远端两条链路互不影响。
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findZCodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [bundlePath, ...ZCODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // 关键：必须以纯 Node 模式启动，否则子进程会被当成 Electron/Chromium 子进程卡在 GPU 初始化。
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function resolveDefaultZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ZCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // 顺序：env 显式覆盖 → monorepo dev 源码/dist（dev 改源码立刻生效，不会被远端历史装的 native binary
  // 抢先匹配）→ 桌面打包态 Electron Node runtime 跑 zcode.cjs → 已部署 native binary（远端 SSH 兜底）。
  const bundled =
    resolveBundledWorkspaceZCodeAgentCommand(context) ??
    resolveElectronRuntimeZCodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedZCodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

function applyPresentationSurfaceToCommand(
  command: ZCodeAgentCommand | null,
  presentationSurface: ZCodeAgentCommandResolverContext["presentationSurface"],
): ZCodeAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Bug 原因：旧逻辑无条件消费下一个 token，孤立的 --surface 会把后续
      // --stdio 等 option 一并吞掉，导致自定义 Agent 命令失去协议启动参数。
      // 只有明确的非 option value 才属于 --surface；其他 option 继续走原参数链路。
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

export function wrapZCodeAgentCommandWithStdioTapDevProxy(
  command: ZCodeAgentCommand,
  workspaceKey: string,
): ZCodeAgentCommand {
  const tapState = readZCodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/zcode-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ZCode stdio tap proxy enabled but script not found");
    return command;
  }

  // 开发态 raw stdio 帧数据量和消息流同级，不能打进普通 info 日志。
  // 这里只在显式开关打开时用旁路 proxy 写盘，生产构建和默认开发路径都不受影响。
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

export class ZCodeAgentProcessManager {
  private readonly bindings = new Map<string, RuntimeBinding>();
  private readonly bindingFlights = new Map<string, Promise<RuntimeBinding>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly useSharedTaskRuntime: ZCodeAgentProcessManagerOptions["useSharedTaskRuntime"];
  private readonly processesByWorkspaceKey = new Map<string, ManagedZCodeAgentProcess>();
  private readonly ownedProcesses = new Set<ManagedZCodeAgentProcess>();
  private readonly startingByWorkspaceKey = new Map<string, Promise<ZCodeProtocolClient>>();
  private readonly restartGenerationByWorkspaceKey = new Map<string, number>();
  private readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
  private readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  private readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  private readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ZCodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(this.processKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  private readonly commandResolver: ZCodeAgentCommandResolver;
  private readonly presentationSurface: ZCodeAgentProcessManagerOptions["presentationSurface"];
  private readonly requestTimeoutMs: number | undefined;
  private readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  private readonly resolveSpawnEnv: ZCodeAgentProcessManagerOptions["resolveSpawnEnv"];
  private readonly waitForSpawnAdmission: ZCodeAgentProcessManagerOptions["waitForSpawnAdmission"];
  private readonly spawnFallbackCwd: string | undefined;
  private readonly lane: string | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly runtimeRestartedEmitter = new Emitter<ZCodeAgentRuntimeRestartedEvent>();
  private readonly runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  private readonly runtimeExitedEmitter = new Emitter<ZCodeAgentRuntimeExitedEvent>();
  private disposeAllInFlight: Promise<void> | undefined;
  private disposed = false;

  /** 进程换代通知（generation>1 时触发）；v4 订阅方据此重订，见 ZCodeAgentRuntimeRestartedEvent。 */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** 进程真实 spawn 后 available，当前 protocol client 关闭后 unavailable。 */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;
  /** 主泳道 runtime 意外退出；只在 terminationKind=unexpected 时发布。 */
  readonly onRuntimeExited = this.runtimeExitedEmitter.event;

  constructor(options?: ZCodeAgentProcessManagerOptions) {
    this.useSharedTaskRuntime = options?.useSharedTaskRuntime;
    this.commandResolver = options?.commandResolver ?? resolveDefaultZCodeAgentCommand;
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  }

  private processKey(params: RuntimeWorkspace): string {
    return (
      this.bindings.get(resolveWorkspaceKey(params))?.processKey ?? resolveWorkspaceKey(params)
    );
  }

  private async bind(params: RuntimeWorkspace): Promise<RuntimeBinding> {
    const key = resolveWorkspaceKey(params);
    const existing = this.bindings.get(key);
    if (existing) {
      const closing = this.recoverRetiredProcess(existing.processKey);
      if (closing) {
        await closing;
        return this.bind(params);
      }
      return existing;
    }
    const pending = this.bindingFlights.get(key);
    if (pending) return pending;
    const flight = Promise.resolve().then(async () => {
      const shared = await (!params.workspaceIdentity
        ? this.useSharedTaskRuntime?.(params)
        : false);
      if (this.disposed) throw new Error("ZCode agent process manager is disposed.");
      if (this.bindingFlights.get(key) !== flight)
        throw new Error("ZCode agent workspace allocation was cancelled.");
      const binding = {
        workspace: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        processKey: shared ? SHARED_TASK_RUNTIME_KEY : key,
      };
      // 旧进程树必须释放完毕，才能重新读取项目事实并分配。
      const closing = this.recoverRetiredProcess(binding.processKey);
      if (closing) {
        await closing;
        return binding;
      }
      this.bindings.set(key, binding);
      return binding;
    });
    this.bindingFlights.set(key, flight);
    let binding: RuntimeBinding;
    try {
      binding = await flight;
    } finally {
      if (this.bindingFlights.get(key) === flight) this.bindingFlights.delete(key);
    }
    return this.bindings.has(key) ? binding : this.bind(params);
  }

  isSharedRuntime(params: RuntimeWorkspace): boolean {
    return this.processKey(params) === SHARED_TASK_RUNTIME_KEY;
  }

  getRuntimeWorkspaces(params: RuntimeWorkspace): RuntimeWorkspace[] {
    const key = this.processKey(params);
    return [...this.bindings.values()]
      .filter((entry) => entry.processKey === key)
      .map((entry) => entry.workspace);
  }

  private publishAvailable(managed: ManagedZCodeAgentProcess, binding: RuntimeBinding): void {
    if (!managed.spawned || managed.exited || managed.client.isDisposed) return;
    const workspaceKey = resolveWorkspaceKey(binding.workspace);
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) ===
      managed.runtimeIdentity.identity
    )
      return;
    this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, managed.runtimeIdentity.identity);
    const runtimeIdentity = { ...managed.runtimeIdentity, workspaceKey };
    // 新加入共享进程的 workspace 也必须收到 available，供被动索引订阅连接。
    this.runtimeLifecycleEmitter.fire({
      ...binding.workspace,
      workspaceKey,
      runtimeIdentity,
      state: "available",
    });
    if (runtimeIdentity.generation > 1)
      this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity });
  }

  private reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // 进程生命周期上报是旁路观测，临时失败不得阻断 agent 启动或回收。
      warnLog("ZCode agent process lifecycle reporter failed", error);
    }
  }

  private clearIdleTimer(managed: ManagedZCodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * 空闲回收：每次在飞请求归零就重置计时；到点时若仍无请求在飞且该进程仍是当前活跃实例，
   * 主动回收整棵进程树（含挂在其下的 MCP 子进程）。归因为 expected/idle-timeout，
   * 不会被监控当作崩溃。到点时有新请求在飞则什么都不做，等下一次归零重新计时。
   */
  private scheduleIdleReclaim(workspaceKey: string, managed: ManagedZCodeAgentProcess): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // 自定义 Agent 的旧启动请求可能先结清，再继续数据库准备；无在飞 RPC 不代表迁移空闲。
      if (
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ZCode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.runtimePid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // 空闲计时器不能把 host 进程钉在事件循环里。
    timer.unref?.();
    managed.idleTimer = timer;
  }

  private recordTerminationIntent(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // protocol close 可能是 Agent 崩溃的结果，只有 Host 主动发起的回收
    // 才能建立退出意图。首次 cleanup 原因是根因事实，后续 app quit 等幂等回收不能
    // 把已经发生的异常 protocol close 改写成 expected。
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  private reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    for (const binding of this.bindings.values()) {
      if (binding.processKey !== managed.runtimeIdentity.workspaceKey) continue;
      const workspaceKey = resolveWorkspaceKey(binding.workspace);
      if (
        this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
        managed.runtimeIdentity.identity
      )
        continue;
      this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
      this.runtimeLifecycleEmitter.fire({
        ...binding.workspace,
        workspaceKey,
        runtimeIdentity: { ...managed.runtimeIdentity, workspaceKey },
        state: "unavailable",
      });
    }
  }

  private reportRuntimeExited(
    managed: ManagedZCodeAgentProcess,
    exit: { code: number | null; signal: string | null; endedAt: number },
  ): void {
    const cause = classifyAgentProcessExitCause(exit.code);
    for (const binding of this.bindings.values()) {
      if (binding.processKey !== managed.runtimeIdentity.workspaceKey) continue;
      const workspaceKey = resolveWorkspaceKey(binding.workspace);
      this.runtimeExitedEmitter.fire({
        ...binding.workspace,
        workspaceKey,
        runtimeIdentity: { ...managed.runtimeIdentity, workspaceKey },
        exitCode: exit.code,
        signal: exit.signal,
        ...(cause ? { cause } : {}),
        exitedAt: exit.endedAt,
      });
    }
  }

  private reportRuntimeReady(managed: ManagedZCodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.runtimePid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.runtimePid!,
        provider: ZCODE_AGENT_PROVIDER,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

  private cleanupManagedProcess(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean; deadlineAtMs?: number } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // protocol close 只会使 client 不再可复用，不代表它对应的
    // OS 进程已退出。将回收 Promise 绑在 managed process 上，timeout、restart 和
    // app quit 可以共用同一次幂等回收，Host 也不会丢失已退休进程的所有权。
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait({ deadlineAtMs: options.deadlineAtMs })
      .then(async () => {
        // 进程树回收可能先于异步 exit 监听器返回；必须等 stderr/退出事件完成，
        // 否则 Host 会提前释放所有权，关闭调用方看不到最后一条诊断。
        // OS 查询可能先于 Node exit 回调；诊断也必须服从同一关闭预算，
        // 不能在树清理结束后又无限等待。超时保留 ownership，下一次请求可重新核验。
        let exitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await (options.deadlineAtMs === undefined
            ? managed.exitDiagnosticsCompleted
            : Promise.race([
                managed.exitDiagnosticsCompleted,
                new Promise<never>((_, reject) => {
                  exitDeadlineTimer = setTimeout(
                    () => reject(new Error("runtime process exit diagnostics incomplete")),
                    Math.max(options.deadlineAtMs! - Date.now(), 0),
                  );
                }),
              ]));
        } finally {
          if (exitDeadlineTimer) clearTimeout(exitDeadlineTimer);
        }
        cleanupCompleted = true;
        log("ZCode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.runtimePid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    // Bug 原因：dispose 与重试编排竞态时，rejection 可能先于调用方 await 挂靠被判为
    // unhandledRejection（vitest 计为运行级失败，生产等价于未处理拒绝）。catch 必须在
    // 创建点无条件挂靠：reportError:false（重试路径）时静默吞掉，统一上报由
    // cleanupManagedProcessWithRetry 的 await/catch 完成，告警语义不变。
    void cleanupPromise.catch((error) => {
      if (options.reportError === false) {
        return;
      }
      errorLog("ZCode agent process cleanup failed", {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.runtimePid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        reason,
        error,
      });
    });
    return cleanupPromise;
  }

  private async cleanupManagedProcessForShutdown(managed: ManagedZCodeAgentProcess): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

  private cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    const processKey = managed.runtimeIdentity.workspaceKey;
    const existing = this.closing.get(processKey);
    if (existing) return existing;
    // 在终止引发同步 close 回调之前登记屏障，避免重复回收或并发启动第二棵进程树。
    const flight = Promise.resolve()
      .then(() =>
        this.performCleanupManagedProcessWithRetry(managed, reason, retryReason, retryScope),
      )
      .then(() => {
        if (this.closing.get(processKey) !== flight) return;
        for (const [key, binding] of this.bindings) {
          if (binding.processKey === processKey) this.bindings.delete(key);
        }
      })
      .finally(() => {
        // 清理失败的 Promise 不能永久阻塞普通重连。旧树归属由 ownedProcesses
        // 保留；下一次主动请求重新核验，确认清理完成后才释放绑定并启动新树。
        if (this.closing.get(processKey) === flight) this.closing.delete(processKey);
      });
    this.closing.set(processKey, flight);
    return flight;
  }

  private recoverRetiredProcess(processKey: string): Promise<void> | undefined {
    const closing = this.closing.get(processKey);
    if (closing) return closing;
    const active = this.processesByWorkspaceKey.get(processKey);
    const retired = [...this.ownedProcesses].find(
      (managed) =>
        managed.runtimeIdentity.workspaceKey === processKey &&
        (managed !== active || managed.client.isDisposed || managed.exited),
    );
    return retired
      ? this.cleanupManagedProcessWithRetry(
          retired,
          "protocol-close",
          "protocol-close",
          "connection recovery",
        )
      : undefined;
  }

  private async performCleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    // 同一次关闭与重试共用预算；普通重连的新请求才获得新预算。
    const deadlineAtMs = process.platform === "win32" ? Date.now() + 3_250 : undefined;
    try {
      // 首次 cleanup 的进程树/exit 观察可能只是中间态；在 retry 成功时，
      // 首次 rejection 不应提前升级为生产 error 告警。最终失败仍由本方法统一上报一次。
      await this.cleanupManagedProcess(managed, reason, { reportError: false, deadlineAtMs });
    } catch (firstError) {
      // Windows 进程表查询/exit 事件可能短暂落后，首次 cleanup 会误报 root
      // 残留。在同一预算内重试一次，保留旧成员身份并重新核验；真实残留或
      // 无法核验仍抛出错误，保留 ownership，交给下一次主动请求重新处理。
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ZCode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.runtimePid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, {
          reportError: false,
          deadlineAtMs,
        });
      } catch (finalError) {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.runtimePid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    const binding = await this.bind(params);
    const workspaceKey = binding.processKey;
    const closing = this.recoverRetiredProcess(workspaceKey);
    if (closing) {
      await closing;
      return this.getClient(params);
    }
    if (this.bindings.get(resolveWorkspaceKey(params)) !== binding) return this.getClient(params);
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed && !existing.client.isDisposed) {
      this.publishAvailable(existing, binding);
      return existing.client;
    }

    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ZCode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ZCode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      const managed = this.processesByWorkspaceKey.get(workspaceKey);
      if (managed) this.publishAvailable(managed, binding);
      return client;
    }

    // agent 启动前置后，host warmup 和 UI 首次 readWorkspacePresentation/sendPrompt
    // 可能同时进入 getClient。这里按 workspaceKey 收敛启动中的 promise，避免同一工作区重复 spawn。
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      workspaceKey === SHARED_TASK_RUNTIME_KEY ? { workspacePath: getZCodeDataRootDir() } : params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
    } catch (error) {
      if (
        !this.processesByWorkspaceKey.has(workspaceKey) &&
        ![...this.ownedProcesses].some(
          (managed) => managed.runtimeIdentity.workspaceKey === workspaceKey,
        )
      ) {
        for (const [key, route] of this.bindings)
          if (route.processKey === workspaceKey) this.bindings.delete(key);
      }
      throw error;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
    }
  }

  /**
   * 只读取已经登记的 runtime client；被动 observer 使用本入口避免 getClient 的隐式 spawn。
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(this.processKey(params));
    return managed && !managed.child.killed && !managed.client.isDisposed
      ? managed.client
      : undefined;
  }

  /** 资源管理器：当前仍存活的受管 runtime（pid + workspace + client） */
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ZCodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ZCodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.runtimePid !== "number")
        continue;
      result.push({
        pid: managed.runtimePid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** Agent service 首次通过 provider/model 门禁后调用；同一 runtime 只上报一次。 */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(this.processKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient 可能早于 ChildProcess 的异步 spawn 事件返回，也可能在 await 期间
    // 被新 runtime 替换。只给返回该 entry 的进程标 ready，并由 spawn 回调保证 start → ready 顺序。
    this.reportRuntimeReady(managed);
  }

  private async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient> {
    const startStartedAt = Date.now();
    const resolveCommandStartedAt = Date.now();
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
    if (!command) {
      throw new Error(
        "ZCode agent server command is not configured. Set ZCODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("ZCode agent process start was cancelled.");
    }
    const effectiveCommand = wrapZCodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ZCode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery 可能在 command resolve 期间开始；先等待一次，确保 env 解析使用
    // recovery 后的 broker 凭据，而不是把旧状态带到 spawn 边界。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // 设置页代理等运行时 env 在 process.env 之后合入（覆盖继承的同名 shell 变量），
    // 但仍让 command.env（部署特定）保持最高优先级。
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // app 正在关闭时，启动中的 warmup 可能刚完成 command/env resolve。
      // 这时继续 spawn 会绕过 disposeAllAndWait 的快照，重新制造一个无人托管的 agent 进程。
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // 切模型会重启单个 workspace。旧启动请求如果在重启后才恢复，
      // 不能继续 spawn 并写回进程池，否则新配置会被旧 agent 覆盖。
      throw new Error("ZCode agent process start was cancelled.");
    }
    // cwd 探测也让出事件循环，必须放在最终 admission 与销毁/代际检查之前。
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolve 本身是异步的，恢复屏障可能在这段时间重新关闭；必须在 spawn 前
    // 再等待并复查代际，不能只依赖第一次 admission。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ZCode agent process start was cancelled.");
    }
    // app 以本地开发方式启动时，让 agent 子进程也带上 ZCODE_RUNTIME_ENV=development；
    // 不再传 NODE_ENV，避免用户 shell/runtime 变量影响 ZCode 运行模式或泄漏到 Bash 工具。
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const childEnv = {
      ...sanitizeZCodeRuntimeEnv(process.env),
      [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
      ...spawnEnv,
      ...effectiveCommand.env,
      // 生成文件根目录由执行端 Host 唯一决定，保证 Agent 写入与 Host 读取授权一致。
      [GEN_UI_OUTPUT_ROOT_ENV]: join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY),
      // 身份/隔离语义使用 workspaceIdentity；cwd 继续使用 workspacePath。
      ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
      ...buildE2EAgentCoverageEnv(),
    };
    const windowsRuntime =
      process.platform === "win32"
        ? await spawnWindowsRuntimeHost({
            command: effectiveCommand.command,
            args: spawnPreflight.args,
            cwd: spawnPreflight.cwd,
            env: childEnv,
            signal: admissionSignal,
          })
        : undefined;
    const child =
      windowsRuntime?.child ??
      spawn(effectiveCommand.command, spawnPreflight.args, {
        cwd: spawnPreflight.cwd,
        detached: shouldSpawnInDetachedProcessGroup(),
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    let runtimePid = windowsRuntime ? undefined : child.pid;
    const startedAt = Date.now();
    const stderrTail = createAgentStderrTail();
    const transport = new ZCodeStdioTransport(child, {
      windowsRuntime,
      onStderrLine: (line) => {
        const diagnostic = parseZCodeProcessDiagnostic(line);
        if (diagnostic && typeof runtimePid === "number") {
          // 根因：只保存 exit tail 会漏掉存活 runtime 的异常；此旁路不依赖 debug 开关。
          // 身份绑定创建时的 child，不能查当前 workspace，避免重启后的迟到事件串进程。
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: runtimePid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              runtimeGeneration,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // 脱敏占位符可能比原文长，必须再次限长，避免 IPC schema 拒绝合法异常。
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // POSIX 下 child 由本 manager 以 detached=true 启动，pid 同时就是 Host
      // 拥有的独立 PGID；异常 root exit 后 cleanup 仍可按组回收同组后代。
      ...(process.platform !== "win32" && runtimePid ? { ownedProcessGroupId: runtimePid } : {}),
    });
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    const registerNetworkCapture = () => {
      if (runtimePid) {
        const unregister = localRuntimeNetworkCapture.register(client, runtimePid);
        child.once("close", unregister);
      }
    };
    if (!windowsRuntime) registerNetworkCapture();
    // Agent 进程重启后，Host 仍需要 runtime identity 区分新旧订阅和运行命令。
    // Provider Registry 由新 Worker 从所属 Environment 的 Config 重建，不再由 UI 重新下发。
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // 生命周期事件关联只需要本次 runtime 的不透明身份，不能复用包含 workspaceKey 的协议 identity。
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ZCodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${runtimePid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${runtimePid ?? "unknown"}`,
      ...(typeof runtimePid === "number" ? { processId: runtimePid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    const exitDiagnostics = Promise.withResolvers<void>();
    const managed: ManagedZCodeAgentProcess = {
      child,
      runtimePid,
      client,
      exited: false,
      exitDiagnosticsCompleted: exitDiagnostics.promise,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
    const publishStorage = () => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(workspaceKey, managed);
      }
      for (const binding of this.bindings.values()) {
        if (binding.processKey !== workspaceKey) continue;
        this.storageStartupEmitter.fire({
          workspaceKey: resolveWorkspaceKey(binding.workspace),
          snapshot: {
            generation: runtimeGeneration,
            state: client.storageStartup.snapshot ?? null,
          },
        });
      }
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
    const onSpawn = () => {
      if (managed.exited) return;
      managed.spawned = true;
      // Node spawn() 会先返回 ChildProcess，再异步报告 cwd/command ENOENT。
      // 旧代码在确认 spawn 成功前就发布 runtimeRestarted，订阅方随即重连并再次触发
      // 启动，最终形成失败启动 -> 假重启 -> 重连的自激风暴。只有 spawn 事件才表示
      // 新 CLI 运行时真实存在，可以安全通知 v4 订阅方重订。
      if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        for (const binding of this.bindings.values()) {
          if (binding.processKey === workspaceKey) this.publishAvailable(managed, binding);
        }
      }
      if (typeof runtimePid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: runtimePid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ZCode agent process started", {
        workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: runtimePid,
        runtimeHostPid: windowsRuntime?.child.pid,
        durationMs: Date.now() - startStartedAt,
      });
    };
    if (!windowsRuntime) child.once("spawn", onSpawn);
    child.once("error", (error) => {
      errorLog(
        `ZCode agent process error${this.processLifecycleReporter?.onError ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey,
          pid: runtimePid,
          runtimeHostPid: windowsRuntime?.child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof runtimePid === "number" ? runtimePid : null,
          provider: ZCODE_AGENT_PROVIDER,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: params.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
      if (child.pid == null) {
        exitDiagnostics.resolve();
        this.ownedProcesses.delete(managed);
      }
    });
    const onExit = async (code: number | null, signal: NodeJS.Signals | null) => {
      try {
        managed.exited = true;
        this.clearIdleTimer(managed);
        const endedAt = Date.now();
        const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
        // 协议解析/stream 故障会先触发 protocol-close，再由 Host 用 SIGTERM
        // 回收仍存活的进程。若只透传主动 termination intent，desktop 只能看到最终信号，
        // 无法区分协议故障与受控退出；保留首次 cleanup 原因作为结构化根因。
        const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
        // 协议已立即失效，但 exit 先于 stderr EOF；保留旧 runtime 闭包身份收齐最后诊断。
        await transport.waitForStderrDrain();
        const stderr = stderrTail.snapshot();
        const exitContext = {
          workspaceKey,
          pid: runtimePid,
          runtimeHostPid: windowsRuntime?.child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          code,
          signal,
          terminationKind,
          terminationReason,
        };
        // 之前日志只有新的 "process started"，缺少旧 pid 的退出轨迹。
        // agent native crash 后 UI 只会看到 protocol close/Session is not active，无法判断是崩溃还是主动重启。
        log("ZCode agent process exited", exitContext);
        if (terminationKind === "unexpected") {
          // Agent 顶层异常只写 stderr 并以非零 code 退出；stderr 过去仅走开发态
          // debug，生产日志只剩 code=1，无法还原异常。不能只按非零 code 判断：signal crash
          // 和长期运行的 Agent 自行 exit 0 同样是非预期退出。
          // 已有独立生命周期事件，显式标记包装日志，避免 Electron 将其再计为 JS 异常。
          errorLog(
            `ZCode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
            {
              ...exitContext,
              stderr,
            },
          );
        }
        if (terminationKind === "unexpected" && !this.lane) {
          this.reportRuntimeExited(managed, { code, signal, endedAt });
        }
        if (typeof runtimePid === "number") {
          this.reportProcessLifecycle((reporter) =>
            reporter.onExit({
              pid: runtimePid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              exitCode: code,
              signal,
              endedAt,
              terminationKind,
              runtimeReady: managed.readyAt != null,
              ...(terminationReason ? { terminationReason } : {}),
              runtimeGeneration,
              runtimeInstanceId,
              uptimeMs: Math.max(0, endedAt - startedAt),
              stderrLineCount: stderr.lineCount,
              ...(terminationKind === "unexpected" && stderr.tail.length > 0
                ? { stderrTail: stderr.tail }
                : {}),
            }),
          );
        }
      } finally {
        exitDiagnostics.resolve();
      }
    };
    if (windowsRuntime) windowsRuntime.onRootExit(onExit);
    else child.once("exit", onExit);
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ZCode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: runtimePid,
          },
        );
        return;
      }
      warnLog("ZCode agent request timed out; disposing stale protocol client", {
        workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: runtimePid,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // timeout 说明协议请求/响应链路已经不可信。旧实现只 reject 当前请求，
      // 但 child 仍未 exit，后续同 workspace 会继续复用坏 client 并反复超时。
      // 这里主动回收进程树，让下一次 getClient 重新拉起干净的 app-server。
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(workspaceKey) === managed;
      log("ZCode agent protocol client closed", {
        workspaceKey,
        pid: runtimePid,
        runtimeIdentity: runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
      if (this.ownedProcesses.has(managed)) {
        // 根 child 的 exit 不等于同组 MCP 后代已退出。即使 protocol close
        // 来自根进程退出，也必须按原进程组完成幂等回收后才能释放 Host 所有权。
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    if (windowsRuntime) {
      const assertAdmission = () => {
        admissionSignal.throwIfAborted();
        if (
          this.disposed ||
          (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration
        ) {
          throw new Error("ZCode agent process start was cancelled.");
        }
      };
      try {
        // ready 是异步边界，恢复 CLI 前重新核对原 admission，旧启动不能跨代复活。
        assertAdmission();
        runtimePid = await windowsRuntime.ready();
        managed.runtimePid = runtimePid;
        runtimeIdentity.processId = runtimePid;
        runtimeIdentity.identity = this.lane
          ? `${workspaceKey}:${runtimeGeneration}:${runtimePid}:${this.lane}`
          : `${workspaceKey}:${runtimeGeneration}:${runtimePid}`;
        assertAdmission();
        registerNetworkCapture();
        await windowsRuntime.start();
        onSpawn();
      } catch (error) {
        if (this.processesByWorkspaceKey.get(workspaceKey) === managed)
          this.processesByWorkspaceKey.delete(workspaceKey);
        await this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "start cancellation",
        ).catch(() => undefined);
        throw error;
      }
    }
    return client;
  }

  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAgentRuntimeIdentity> {
    const workspaceKey = this.processKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity 是查询接口，旧实现却复用了启动型 getClient，
    // 导致 provider 保存等被动探测按 workspace 数量隐式 spawn Agent CLI。
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return { ...managed.runtimeIdentity, workspaceKey: resolveWorkspaceKey(params) };
  }

  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ZCODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    this.bindingFlights.delete(resolveWorkspaceKey(params));
    const workspaceKey = this.processKey(params);
    const closing = this.closing.get(workspaceKey);
    if (closing) {
      await closing;
      return;
    }
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed =
      this.processesByWorkspaceKey.get(workspaceKey) ??
      [...this.ownedProcesses].find(
        (candidate) => candidate.runtimeIdentity.workspaceKey === workspaceKey,
      );
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose 不能把尚未完成的 start promise 从追踪表中删掉。删除会让
    // recovery/UI 的下一次 getClient 再开一条 spawn，旧 promise 随后又可能越过异步
    // resolve 回写进程池，形成同一 workspace 的 spawn/dispose 风暴。代际检查会让旧
    // promise 在真正 spawn 前失败，finally 再按 promise identity 清理 map。
    if (managed) {
      // restartWorkspaceProcess 回收该 workspace 绑定的物理进程，包含所有共享工作区。
      // 不能复用 disposeAll，否则会把整个 manager 标记为已关闭，后续首发/预热无法重新拉起。
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("ZCode agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

  private abortAllPendingStarts(
    reason = new Error("ZCode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // app/host 退出时旧逻辑只同步 dispose client，底层进程树的 SIGKILL 兜底
    // 依赖 unref timer，host 自己退出后 timer 不会再执行，zcode-cli 会残留为孤儿进程。
    // 这里让 host 可以等待每个 workspace 的 agent 进程树完成 graceful + force 清理。
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
