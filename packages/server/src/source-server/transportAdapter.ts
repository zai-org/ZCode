/* eslint-disable max-lines -- Source Server transport 在同一适配器内汇合安装、daemon、channel 与 target 生命周期，继续拆分会割裂取消边界。 */
import { Duplex } from "node:stream";
import {
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  normalizeRemoteAssetInstallMode,
  sourceServerInstallProgressSchema,
  type SourceServerInstallProgress,
  type PublicZCodeErrorCode,
  type RemoteTarget,
} from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { createRemoteBackend } from "@zcode/server/remote/create-backend.js";
import { detectRemoteTarTool } from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  probeSourceServer,
  SourceServerProbeEnvironmentError,
} from "@zcode/server/source-server/sourceServerProbe.js";
import { buildSourceServerReleaseDownloadCommand } from "@zcode/server/source-server/sourceServerReleaseDownload.js";
import {
  collectCommand,
  duplexFromStdio,
  quoteShellArg,
  readLastJsonLine,
  readStructuredCommandCode,
  readStructuredCommandError,
  throwIfAborted,
  type RemoteExecResult,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export type { RemoteExecResult } from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installPath?: string;
  installedVersion?: string;
  installedArchiveSha256?: string;
  /** 当前 release 由显式降级安装时，被替换的版本。 */
  downgradedFrom?: string;
  daemonStatus?: Record<string, unknown> & { state: string; port?: number };
}

export interface SourceServerProbeOptions {
  includeReleaseIdentity?: boolean;
}

export interface SourceServerIngressInfo {
  port: number;
  ingressToken: string;
  /** 端口取自 probe 读到的 status.json 快照，本次没有执行 serve --daemon。 */
  reusedProbeStatus?: true;
}

export interface ServerReleaseAsset {
  localArchivePath?: string;
  target: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  urls: string[];
}

export interface TransportContext {
  signal?: AbortSignal;
  onLog?: (event: {
    phase: string;
    message: string;
    progress?: number;
    level?: "info" | "warn" | "error";
  }) => void;
}

export interface SourceServerInstallOrUpdateOptions {
  force?: boolean;
  /** 用户已确认把远端切换到更旧版本；方向由远端 CLI 按真实 current 判定。 */
  allowDowngrade?: boolean;
}

export interface SourceServerEnsureDaemonOptions {
  observedStatus?: SourceServerProbeResult["daemonStatus"];
}

export class SourceServerTransportOperationError extends Error {
  public constructor(
    message: string,
    public readonly code: PublicZCodeErrorCode,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "SourceServerTransportOperationError";
  }
}

/**
 * 远端 Server CLI `--json` 失败输出 `{ok:false,error,code?,retryable?}`（写在 stdout）。
 * 公开错误码必须原样保留给 Host/UI 分类，不能只取 error 文本。
 */
function createServerCommandError(result: RemoteExecResult, fallbackMessage: string): Error {
  try {
    const response = readLastJsonLine(result.stdout);
    if (isPublicZCodeErrorCode(response.code)) {
      return new SourceServerTransportOperationError(
        typeof response.error === "string" && response.error.trim()
          ? response.error
          : fallbackMessage,
        response.code,
        typeof response.retryable === "boolean" ? response.retryable : undefined,
      );
    }
  } catch {
    // 输出不是 JSON 时按文本诊断处理。
  }
  // Bug 原因：CLI 的 --json 错误写在 stdout，stderr 可能只有 SQLite warning；
  // 安装路径与 daemon 启动复用同一错误解析，避免 warning 覆盖真正的失败原因。
  return new Error(
    (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) || fallbackMessage,
  );
}

/** 读取远端 Server CLI `--json` 命令的最终 JSON；非零退出按 {@link createServerCommandError} 失败。 */
export function readServerCommandResult(
  result: RemoteExecResult,
  fallbackMessage: string,
): Record<string, unknown> {
  if (result.exitCode !== 0) throw createServerCommandError(result, fallbackMessage);
  return readLastJsonLine(result.stdout);
}

export type SourceServerFileTransfer = Pick<IRemoteBackend, "exec" | "upload">;

export interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";
  /** Host 附件暂存复用当前 target 的 transport，不创建另一条远程连接。 */
  createFileTransfer(target: RemoteTarget): SourceServerFileTransfer;
  /** 取消单个连接目标的底层 transport，防止超时 flight 迟到注册为在线 Source。 */
  cancel?(target: RemoteTarget): void;
  probe(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerProbeOptions,
  ): Promise<SourceServerProbeResult>;
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options?: SourceServerInstallOrUpdateOptions,
  ): Promise<void>;
  ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerEnsureDaemonOptions,
  ): Promise<SourceServerIngressInfo>;
  openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex>;
  exec(target: RemoteTarget, argv: string[], context: TransportContext): Promise<RemoteExecResult>;
  dispose?(): void;
}

export interface CreateSourceServerTransportAdapterOptions {
  createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
}

const SERVER_ROOT_READ_PATH = "~/.zcode/server";
const SERVER_ROOT_SHELL = '"$HOME/.zcode/server"';
const SERVER_BIN_SHELL = '"$HOME/.zcode/server/bin/zcode"';
const STALE_BOOTSTRAP_AGE_MS = 30 * 60 * 1_000;
const INSTALL_PROGRESS_MESSAGES: Record<SourceServerInstallProgress["phase"], string> = {
  "verify-archive": "Verifying Source Server archive",
  extract: "Extracting Source Server files",
  verify: "Verifying Source Server files",
  restart: "Restarting Source Server",
};

type DirectChannelBackend = IRemoteBackend & {
  openDirectTcpChannel?: (port: number) => Promise<Duplex>;
};

class BackendSourceServerTransportAdapter implements SourceServerTransportAdapter {
  private readonly backends = new WeakMap<object, Promise<IRemoteBackend>>();
  private readonly backendPromises = new Set<Promise<IRemoteBackend>>();

  public constructor(
    public readonly kind: "ssh" | "wsl" | "docker",
    private readonly createBackend: (target: RemoteTarget) => Promise<IRemoteBackend>,
  ) {}

  public createFileTransfer(target: RemoteTarget): SourceServerFileTransfer {
    // R3 全转发遗漏了 desktop localPath 的跨机边界；只复用已有 backend 的文件原语。
    const backend = this.getBackend(target);
    return {
      exec: async (command) => (await backend).exec(command),
      upload: async (localPath, remotePath, options) =>
        (await backend).upload(localPath, remotePath, options),
    };
  }

  public async probe(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerProbeOptions = {},
  ): Promise<SourceServerProbeResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    try {
      return await probeSourceServer(backend, context, options);
    } catch (error) {
      // Bug 原因：catch 对所有失败都套 preflight 阶段兜底，握手超时、握手前断开等未识别的
      // 传输失败被报成“设备环境不满足安装要求”；断线恢复耗尽预算时横幅也沿用该误报。
      // 只有远端环境检查本身失败才是预检失败，传输失败识别不了就归入未知。
      const failure = normalizeRemoteConnectionError(
        error,
        error instanceof SourceServerProbeEnvironmentError ? "preflight" : undefined,
      );
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  public async installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions = {},
  ): Promise<void> {
    let phase = "preflight";
    try {
      await this.installRelease(
        target,
        release,
        {
          ...context,
          onLog: (event) => {
            phase = event.phase;
            context.onLog?.(event);
          },
        },
        options,
      );
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  private async installRelease(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions,
  ): Promise<void> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const operationId = `${process.pid}-${Date.now()}`;
    const bootstrapRootShell = `${SERVER_ROOT_SHELL}/.bootstrap-${operationId}`;
    const bootstrapDirShell = `${bootstrapRootShell}/extract`;
    const remoteArchive = `~/.zcode/server/.bootstrap-${operationId}/zcode-server.tar.gz`;
    const remoteArchiveShell = `${bootstrapRootShell}/zcode-server.tar.gz`;
    const cleanupCommand = `rm -rf ${bootstrapRootShell}`;
    const cleanupStaleBootstrapRootsCommand =
      "now_ms=$(($(date +%s) * 1000)); " +
      `for candidate in ${SERVER_ROOT_SHELL}/.bootstrap-*; do ` +
      '[ -d "$candidate" ] || continue; ' +
      "name=${candidate##*/}; " +
      "created_ms=${name##*-}; " +
      'case "$created_ms" in ""|*[!0-9]*) continue ;; esac; ' +
      "age_ms=$((now_ms - created_ms)); " +
      `[ "$age_ms" -le ${STALE_BOOTSTRAP_AGE_MS} ] || rm -rf -- "$candidate"; ` +
      "done";
    const prepareBootstrapRoot = async (): Promise<void> => {
      const result = await collectCommand(
        await backend.exec(
          // Bug 原因：Controller 在 SFTP/upload 中被强制退出时，JS catch 和远端 EXIT trap
          // 都没有机会运行，Server root 会永久积累数十 MiB 的半包。下次安装只回收带合法
          // epoch 后缀且超过 30 分钟的私有 staging；新鲜并发操作和未知目录一律保留。
          `${cleanupStaleBootstrapRootsCommand} && rm -rf ${bootstrapRootShell} && mkdir -p ${bootstrapRootShell}`,
        ),
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Source Server bootstrap staging failed");
      }
    };
    // Bug 原因：R3 切换完整 archive 后曾无条件走 Desktop upload，SSH 表单保存的
    // remote-download 变成无效选项。这里只分流 archive 获取位置，后续仍汇合到同一 installer。
    const remoteDownload =
      target.kind === "ssh" &&
      normalizeRemoteAssetInstallMode(target.assetInstallMode) === "remote-download" &&
      // Bug 原因：开发态 resolver 已固定本轮本地 archive；若仍按 Profile 偏好直下，
      // bootstrap 产物会被 CDN 同版本 release 替换。显式本地路径拥有更高的制品来源优先级。
      !release.localArchivePath;
    if (remoteDownload) {
      context.onLog?.({
        phase: "download",
        message: `Downloading Source Server ${release.version} on remote host`,
      });
      const downloadCommand = await buildSourceServerReleaseDownloadCommand({
        backend,
        release,
        remoteArchive,
        onLog: (message) => context.onLog?.({ phase: "download", message }),
      });
      await prepareBootstrapRoot();
      const downloadResult = await collectCommand(await backend.exec(downloadCommand), (line) => {
        if (/^download progress:/iu.test(line.trim()))
          context.onLog?.({ phase: "download", message: line.trim() });
      });
      if (downloadResult.exitCode !== 0) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw new Error(
          downloadResult.stderr.trim() || "Remote Source Server archive download failed",
        );
      }
    } else {
      if (!release.localArchivePath) {
        throw new Error("Source Server local archive is unavailable for upload");
      }
      // Bug 原因：本地下载上传路径过去不做 tar preflight，会先传完整 archive，
      // 最后才在远端解压阶段失败；且旧提示错误地建议用户切回同样需要 tar 的本地上传。
      context.onLog?.({
        phase: "preflight",
        message: "Checking remote installation prerequisites",
      });
      await detectRemoteTarTool(backend, {
        log: (message) => context.onLog?.({ phase: "preflight", message: String(message) }),
      });
      await prepareBootstrapRoot();
      context.onLog?.({
        phase: "upload",
        message: `Uploading Source Server ${release.version}`,
      });
      const uploadStartedAt = Date.now();
      try {
        await backend.upload(release.localArchivePath, remoteArchive, {
          signal: context.signal,
          onProgress: ({ uploadedBytes, totalBytes }) =>
            context.onLog?.({
              phase: "upload",
              message: `upload progress: ${(totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0).toFixed(1)}% (${(uploadedBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB, ${(uploadedBytes / 1048576 / Math.max(0.001, (Date.now() - uploadStartedAt) / 1000)).toFixed(2)} MB/s)`,
              progress: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
            }),
        });
      } catch (error) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw error;
      }
    }
    context.onLog?.({ phase: "extract", message: INSTALL_PROGRESS_MESSAGES.extract });
    const command = [
      "set -eu",
      // Bug 原因：running-task guard 让 update 非零退出后，`&& rm` 永远不会执行，远端
      // archive 与 bootstrap staging 会持续残留。EXIT trap 覆盖成功、guard、解压失败和中断。
      `trap ${quoteShellArg(cleanupCommand)} EXIT`,
      // Bug 原因：安全加固/最小服务器常把 /tmp 设为 noexec 或很小的 tmpfs。过去虽把
      // 解压目录移到 Server root，75MB archive 仍先写 /tmp，容量不足时上传到 90% 才
      // EPIPE。archive 与可执行 bootstrap 必须一起位于同一私有 Server staging root。
      `rm -rf ${bootstrapDirShell}`,
      `mkdir -p ${bootstrapDirShell}`,
      `tar -xzf ${remoteArchiveShell} -C ${bootstrapDirShell} --strip-components=1`,
      // Bug 原因：update 现在会重启完整 daemon；若不把既有 transport 能力边界传给目标
      // bootstrap CLI，WSL/Docker 会在 handoff 时误尝试注册不可用的 systemd user service。
      `${this.kind === "ssh" ? "" : "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "}${bootstrapDirShell}/bin/zcode update --from-archive ${remoteArchiveShell}${options.force ? " --force" : ""}${options.allowDowngrade ? " --allow-downgrade" : ""} --server-root ${SERVER_ROOT_SHELL} --json --progress --prepare-credentials`,
    ].join(" && ");
    // 上传完成后命令仍需解压、整树校验和 daemon 换代；必须实时消费阶段，不能等退出才显示。
    const result = await collectCommand(await backend.exec(command), (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const event = sourceServerInstallProgressSchema.safeParse(value);
      if (event.success) {
        context.onLog?.({
          phase: event.data.phase,
          message: INSTALL_PROGRESS_MESSAGES[event.data.phase],
        });
      }
    });
    if (result.exitCode !== 0) {
      throw createServerCommandError(result, "Source Server archive installation failed");
    }
    const response = readLastJsonLine(result.stdout);
    if (response.ok === false || response.applied !== true) {
      throw new Error("Source Server archive installation did not apply the release");
    }
    context.onLog?.({
      phase: "install",
      message: `Source Server ${release.version} installed`,
    });
  }

  public async ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerEnsureDaemonOptions = {},
  ): Promise<SourceServerIngressInfo> {
    throwIfAborted(context.signal);
    let status = options.observedStatus;
    const observedReady =
      status?.state === "ready" && Number.isInteger(status.port) && (status.port as number) > 0;
    if (!observedReady) {
      context.onLog?.({ phase: "daemon", message: "Starting Source Server" });
      const result = await this.exec(
        target,
        ["serve", "--daemon", "--json", "--prepare-credentials"],
        context,
      );
      if (result.exitCode !== 0) {
        // Bug 原因：Server CLI 的 --json 错误写在 stdout，Node 运行时 warning 写在 stderr。
        // 旧逻辑只取 stderr，最终把 SQLite warning 当成连接根因展示给用户。
        const message =
          (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
          "Source Server daemon failed to start";
        // CLI 失败信息会追加 Core 的失败原因；CLI 已按原首句带码时用该码，不让详情文本改判类别。
        const code = readStructuredCommandCode(result.stdout);
        throw code ? new SourceServerTransportOperationError(message, code) : new Error(message);
      }
      status = readLastJsonLine(result.stdout) as SourceServerProbeResult["daemonStatus"];
    }
    // Bug 原因：probe 刚确认 ready 后仍重复执行 serve --daemon，会多占一个远端 round-trip，
    // 让冷启动在 10 秒预算边缘失败。ready status 只复用端口；ingress token 仍每次重新读取。
    if (!status) throw new Error("Source Server daemon status is unavailable");
    const port = status.port;
    if (!Number.isInteger(port) || (port as number) <= 0) {
      throw new Error("Source Server daemon did not report a valid ingress port");
    }
    // Bug 原因：复用 probe 已确认就绪的 daemon 时也按 serviceRegistered 打印
    // “started in detached fallback mode”，日志读起来像每次连接都另起了一个实例。
    // 启动方式只在本次实际执行 serve --daemon 时报告。
    if (observedReady) {
      context.onLog?.({ phase: "daemon", message: "Reusing running Source Server" });
    } else if (status.serviceRegistered === false) {
      // Bug 原因：systemd 装载失败后 CLI 改用 fallback，原因只在本次输出的 serviceFallbackReason 里；
      // 不写进连接日志，用户和排障都看不出这次为什么没有用 OS 用户服务。脱敏由连接日志统一处理。
      const fallbackReason =
        typeof status.serviceFallbackReason === "string" ? status.serviceFallbackReason.trim() : "";
      context.onLog?.({
        phase: "daemon",
        message: `Source Server started in detached fallback mode for this remote environment${fallbackReason ? ` (${fallbackReason})` : ""}`,
      });
    } else if (status.serviceRegistered === true) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server registered with the remote OS user service manager",
      });
    }
    const backend = await this.getBackend(target);
    const ingressToken = (
      await backend.readFile(`${SERVER_ROOT_READ_PATH}/run/ingress-token`)
    ).trim();
    if (!ingressToken) throw new Error("Source Server ingress token is missing");
    return {
      port: port as number,
      ingressToken,
      ...(observedReady ? { reusedProbeStatus: true } : {}),
    };
  }

  public async openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex> {
    throwIfAborted(context.signal);
    const backend = (await this.getBackend(target)) as DirectChannelBackend;
    if (this.kind === "ssh" && backend.openDirectTcpChannel) {
      try {
        return await backend.openDirectTcpChannel(ingress.port);
      } catch (error) {
        context.onLog?.({
          phase: "channel",
          message: `SSH direct-tcpip unavailable; using proxy-stdio (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
    return duplexFromStdio(
      await backend.exec(
        `${SERVER_BIN_SHELL} server proxy-stdio --server-root ${SERVER_ROOT_SHELL}`,
      ),
    );
  }

  public async exec(
    target: RemoteTarget,
    argv: string[],
    context: TransportContext,
  ): Promise<RemoteExecResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const hasServerRoot = argv.includes("--server-root");
    // `restart` 会在远端重新执行 serve --daemon，必须与它一样保持 detached fallback（R2 §8.1）。
    const startsDaemon =
      (argv[0] === "serve" && argv.includes("--daemon")) || argv[0] === "restart";
    const daemonEnvironment =
      this.kind !== "ssh" && startsDaemon ? "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 " : "";
    const command = [
      // Bug 原因：WSL/Docker 没有稳定的用户级服务管理器；若沿用 SSH 命令会尝试
      // 注册 systemd user service 并在常见环境中失败。两者必须显式进入 detached fallback。
      `${daemonEnvironment}${SERVER_BIN_SHELL}`,
      ...argv.map(quoteShellArg),
      ...(hasServerRoot ? [] : ["--server-root", SERVER_ROOT_SHELL]),
    ].join(" ");
    return await collectCommand(await backend.exec(command));
  }

  public dispose(): void {
    for (const backend of this.backendPromises) {
      void backend.then(
        (resolved) => resolved.dispose(),
        () => undefined,
      );
    }
    this.backendPromises.clear();
  }

  public cancel(target: RemoteTarget): void {
    if (target.kind !== this.kind) return;
    const key = target as object;
    const backend = this.backends.get(key);
    if (!backend) return;
    // Bug 原因：启动 10 秒超时过去只 reject 外层 Promise，SSH 握手仍在后台继续，
    // 迟到后会把 Source 注册 online。精确摘除本 target backend，后续手动重试可新建 transport。
    this.backends.delete(key);
    this.backendPromises.delete(backend);
    void backend.then(
      (resolved) => resolved.dispose(),
      () => undefined,
    );
  }

  private async getBackend(target: RemoteTarget): Promise<IRemoteBackend> {
    if (target.kind !== this.kind) {
      throw new Error(`Transport ${this.kind} cannot handle target ${target.kind}`);
    }
    const key = target as object;
    let backend = this.backends.get(key);
    if (!backend) {
      backend = this.createBackend(target);
      this.backends.set(key, backend);
      this.backendPromises.add(backend);
    }
    return await backend;
  }
}

export function createSourceServerTransportAdapter(
  kind: "ssh" | "wsl" | "docker",
  options: CreateSourceServerTransportAdapterOptions = {},
): SourceServerTransportAdapter {
  return new BackendSourceServerTransportAdapter(
    kind,
    options.createBackend ?? createRemoteBackend,
  );
}
