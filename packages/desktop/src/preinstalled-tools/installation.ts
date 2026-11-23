import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  preinstalledToolInstallationSchema,
  type PreinstalledToolManifest,
  type PreinstalledToolState,
  type PreinstalledToolError,
  type PreinstalledToolInstallation,
  type PreinstalledToolEntry,
} from "@zcode/shared/preinstalled-tools";
import type { resolvePreinstalledToolPaths } from "@zcode/shared/preinstalled-tools/node";
import type { createServiceLogger, HostApiNetworkTransport } from "@zcode/services/node";
import {
  extractPreinstalledArchive,
  validatePreinstalledFiles,
} from "@desktop/preinstalled-tools/archive.js";
import { rewritePreinstalledFiles } from "@desktop/preinstalled-tools/rewrite.js";
import { renamePreinstalledPath } from "@desktop/preinstalled-tools/rename.js";
import {
  PreinstalledToolFailure,
  checkPreinstalledToolSpace,
  classifyPreinstalledToolFailure,
  downloadPreinstalledTool,
} from "@desktop/preinstalled-tools/download.js";
import {
  guardedRemoveDirectories,
  removePreinstalledDirectory,
  assertPreinstalledDirectoriesIdle,
  PreinstalledToolsInUse,
} from "@desktop/preinstalled-tools/removal.js";
import {
  writePreinstalledEntries,
  removePreinstalledEntries,
  expandPreinstalledValue,
  preinstalledEntryExecutable,
  preinstalledEntryFiles,
} from "@desktop/preinstalled-tools/entries.js";

type Paths = ReturnType<typeof resolvePreinstalledToolPaths>;
const RUNTIME_CHECK_MAX_BUFFER = 1024 * 1024;

/**
 * 运行一项检查；超时或取消时结束整棵进程树，stdio 关闭后才结算，调用方随后清理检查目录。
 * 修复原因：execFile 的超时和取消只结束直接子进程。POSIX 入口 exec 成目标后，目标派生的后代
 * （例如 Linux LibreOffice 的 soffice.bin）会在检查返回、检查目录被删除后继续运行。
 * POSIX 改用独立进程组并结束整组；Windows 结束 shim，由其作业对象结束目标及其后代。
 */
function runPreinstalledRuntimeCheck(
  file: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const outputBytes = { stdout: 0, stderr: 0 };
    let failure: { error: unknown } | undefined;
    const stop = (error: unknown) => {
      failure ??= { error };
      try {
        if (process.platform === "win32") child.kill();
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // 整组已经退出时 kill 报 ESRCH，无需处理。
      }
      // 后代可能仍持有管道；主动关闭后 close 才会到达。
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(
      () => stop(new Error(`运行检查超时: ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    const abort = () => stop(options.signal.reason);
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    for (const name of ["stdout", "stderr"] as const)
      child[name].on("data", (chunk: Buffer) => {
        outputBytes[name] += chunk.length;
        if (outputBytes[name] > RUNTIME_CHECK_MAX_BUFFER)
          stop(new Error(`运行检查 ${name} 超出上限`));
        else output[name].push(chunk);
      });
    child.once("error", stop);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      const stdout = Buffer.concat(output.stdout).toString("utf8");
      const stderr = Buffer.concat(output.stderr).toString("utf8");
      if (failure) reject(failure.error);
      else if (code !== 0)
        reject(new Error(`运行检查失败: ${file} 退出码 ${code ?? signal}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

/** 一个工具的唯一操作 owner；准备的执行机会来自协调器的串行队列。 */
export class PreinstalledToolOwner {
  private state: Omit<PreinstalledToolState, "installed" | "agentEnabled">;
  // 只保存本进程见过的入口定义用于撤销；入口内容仍只从当前安装记录派生。
  private readonly knownEntries = new Map<string, PreinstalledToolEntry>();
  private record?: PreinstalledToolInstallation;
  private flight?: {
    id: string;
    controller: AbortController;
    promise: Promise<void>;
    publishing: boolean;
  };
  private deletion?: Promise<void>;
  private entryWrite?: Promise<void>;
  private disposed = false;
  private initialized = false;
  private storageLoaded = false;
  private initialization?: Promise<boolean>;
  constructor(
    private readonly options: {
      paths: Paths;
      toolId: string;
      displayName: string;
      manifest: PreinstalledToolManifest | null;
      appStartup: boolean;
      schedule(operation: () => Promise<void>, signal: AbortSignal): Promise<void>;
      createNetwork(): HostApiNetworkTransport;
      agentEnabled(): boolean;
      publish(): void;
      log: ReturnType<typeof createServiceLogger>;
      /** Windows 入口 shim 的绝对路径，由 Main 解析；其他平台没有。 */
      windowsEntryShim?: string;
    },
  ) {
    const { toolId, displayName, manifest } = options;
    for (const entry of manifest?.entries ?? []) this.knownEntries.set(entry.name, entry);
    this.state = {
      entryOutOfSync: false,
      toolId,
      displayName,
      status: "not-installed",
      target: manifest
        ? {
            resourceId: manifest.resourceId,
            version: manifest.version,
            archiveSizeBytes: manifest.archive.sizeBytes,
            installedSizeBytes: manifest.installedSizeBytes,
          }
        : null,
    };
  }
  snapshot(): PreinstalledToolState {
    return {
      ...this.state,
      agentEnabled: this.options.agentEnabled(),
      installed: this.record
        ? {
            resourceId: this.record.resourceId,
            version: this.record.version,
            installedSizeBytes: this.record.installedSizeBytes,
          }
        : null,
    };
  }
  ownsEntryFile(name: string): boolean {
    return [...this.knownEntries.keys()].some((entry) =>
      preinstalledEntryFiles(entry).includes(name),
    );
  }
  async syncEntries(): Promise<void> {
    await this.changeEntries(async () => {
      await this.reconcileEntries();
    });
  }
  /** 只在本工具的入口队列内调用；删除先撤入口，其余调用均按已保存事实对齐。 */
  private async reconcileEntries(revoke = false): Promise<boolean> {
    const { paths, toolId, log } = this.options;
    // 旧实现等入口 IO 成功才更新开关缓存，失败后发布会复活已关闭入口；直接读取已保存偏好。
    const record = !revoke && this.options.agentEnabled() ? this.record : undefined;
    let direction = "remove";
    try {
      await removePreinstalledEntries(
        paths.binDir,
        [...this.knownEntries.values()].filter(
          (entry) => !record?.entries.some((current) => current.name === entry.name),
        ),
      );
      if (record) {
        direction = "write";
        await writePreinstalledEntries(paths.binDir, record, {
          windowsEntryShim: this.options.windowsEntryShim,
        });
      }
      this.update({ entryOutOfSync: false });
      return true;
    } catch (error) {
      this.update({ entryOutOfSync: true });
      log.warn(undefined, "工具入口尚未与已保存事实同步", {
        toolId,
        direction,
        error: String(error),
      });
      return false;
    }
  }
  private async changeEntries(operation: () => Promise<void>): Promise<void> {
    // 下载不占这条队列；发布、删除与开关的入口操作必须串行，防止旧写入复活已关闭入口。
    const write = (this.entryWrite ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.entryWrite = write;
    try {
      await write;
    } finally {
      if (this.entryWrite === write) this.entryWrite = undefined;
    }
  }
  canAutoPrepare(): boolean {
    return this.initialized && !!this.options.manifest && this.state.status !== "ready";
  }
  private update(patch: Partial<Omit<PreinstalledToolState, "installed" | "agentEnabled">>) {
    this.state = { ...this.state, ...patch };
    this.options.publish();
  }
  failInitialization(error: unknown): void {
    this.options.log.error(undefined, "初始化失败，可手动重试", {
      toolId: this.options.toolId,
      error: String(error),
    });
    this.update({ status: "failed", error: classifyPreinstalledToolFailure(error, "runtime") });
  }
  initialize(): Promise<boolean> {
    if (this.initialized) return Promise.resolve(true);
    if (this.initialization) return this.initialization;
    const task = this.initializeStorage()
      .then(
        () => {
          this.initialized = true;
          return true;
        },
        (error: unknown) => {
          this.failInitialization(error);
          return false;
        },
      )
      .finally(() => {
        if (this.initialization === task) this.initialization = undefined;
      });
    this.initialization = task;
    return task;
  }
  /** 先读取全部工具的入口归属，协调器才可安全清理无主文件；此阶段不回收版本。 */
  async loadInstallation(): Promise<void> {
    if (this.storageLoaded) return;
    const { paths, toolId } = this.options;
    await mkdir(paths.stagingDir, { recursive: true });
    // staging 从未发布程序；旧 worker 已退出，残留归档和临时文件直接清理。
    for (const name of await readdir(paths.stagingDir))
      await rm(join(paths.stagingDir, name), { recursive: true, force: true });
    await mkdir(paths.versionsDir, { recursive: true });
    this.record = undefined;
    try {
      const record = preinstalledToolInstallationSchema.parse(
        JSON.parse(await readFile(paths.recordPath, "utf8")),
      );
      if (
        record.toolId !== toolId ||
        record.platform !== process.platform ||
        record.arch !== process.arch ||
        resolve(record.installationDir) !== resolve(paths.versionsDir, record.resourceId)
      )
        throw new Error("安装记录身份或目录不符");
      for (const entry of record.entries) this.knownEntries.set(entry.name, entry);
      await validatePreinstalledFiles(record.installationDir, record);
      this.record = record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.options.log.warn(undefined, "安装记录未通过启动核对", {
          toolId,
          error: String(error),
        });
      await rm(paths.recordPath, { force: true });
    }
    this.storageLoaded = true;
  }
  private async initializeStorage(): Promise<void> {
    await this.loadInstallation();
    const { paths, manifest, toolId } = this.options;
    await this.changeEntries(async () => {
      // 共享 bin 整体删除会把单工具 IO 故障变成所有工具准备失败；先按归属撤销，失败时保留版本。
      if (!(await this.reconcileEntries(true))) return;
      if (this.options.appStartup) {
        // 安装记录只在发布后切换；旧版本在本次运行中保留，到下次 App 启动才按占用回收。
        for (const name of await readdir(paths.versionsDir)) {
          if (name === this.record?.resourceId) continue;
          try {
            await guardedRemoveDirectories([join(paths.versionsDir, name)]);
          } catch (error) {
            this.options.log.warn(undefined, "保留仍在使用或无法确认空闲的旧版本", {
              toolId,
              resourceId: name,
              error: String(error),
            });
          }
        }
      }
      await this.reconcileEntries();
    });
    this.update({
      status:
        this.record && (!manifest || this.record.resourceId === manifest.resourceId)
          ? "ready"
          : "not-installed",
      error: undefined,
    });
  }
  delete(): Promise<void> {
    if (this.deletion) return this.deletion;
    if (this.disposed) return Promise.resolve();
    const flight = this.flight?.promise;
    const { paths, log, toolId } = this.options;
    const task = Promise.resolve()
      .then(async () => {
        // 删除先取得本工具归属，再等已经接纳的准备；新 prepare 必须排在删除之后。
        await flight;
        if (!(await this.initialize())) return;
        await this.changeEntries(async () => {
          if (!this.record) return;
          this.update({ deletionBlocked: false });
          if (!(await this.reconcileEntries(true))) return;
          try {
            await assertPreinstalledDirectoriesIdle([paths.versionsDir]);
            await rm(paths.recordPath, { force: true });
            this.record = undefined;
            this.update({ status: "not-installed", deletionBlocked: false, error: undefined });
            await rm(paths.versionsDir, { recursive: true, force: true });
            await mkdir(paths.versionsDir, { recursive: true });
            log.info(undefined, "工具资源已删除", { toolId });
          } catch (error) {
            if (this.record) {
              await this.reconcileEntries();
              if (error instanceof PreinstalledToolsInUse) this.update({ deletionBlocked: true });
            }
            log.warn(undefined, "工具删除未完成", { toolId, error: String(error) });
            if (!(error instanceof PreinstalledToolsInUse)) throw error;
          }
        });
      })
      .finally(() => {
        if (this.deletion === task) this.deletion = undefined;
      });
    this.deletion = task;
    return task;
  }
  prepare(): Promise<void> {
    if (this.deletion) return this.deletion.then(() => this.prepare());
    if (!this.initialized && !this.disposed)
      return this.initialize().then((ready) => (ready ? this.prepare() : undefined));
    if (this.disposed || !this.options.manifest || this.state.status === "ready")
      return Promise.resolve();
    if (this.flight)
      return this.flight.controller.signal.aborted
        ? this.flight.promise.then(() => this.prepare())
        : this.flight.promise;
    const controller = new AbortController();
    const id = randomUUID();
    let outcome: Partial<PreinstalledToolState> = {
      status: "not-installed",
      phase: undefined,
      downloadedBytes: undefined,
      error: undefined,
    };
    const finish = () => {
      if (this.flight?.id !== id) return;
      // 清理及队列移除结束后才释放归属并推送，紧邻重试不会加入已取消的旧操作。
      this.flight = undefined;
      this.update(outcome);
    };
    const promise = Promise.resolve()
      .then(() =>
        this.options.schedule(async () => {
          outcome = await this.install(id, controller.signal);
        }, controller.signal),
      )
      .then(finish, (error: unknown) => {
        this.options.log.error(undefined, "准备收尾失败", {
          toolId: this.options.toolId,
          operationId: id,
          error: String(error),
        });
        outcome = {
          status: "failed",
          phase: undefined,
          downloadedBytes: undefined,
          error: classifyPreinstalledToolFailure(error, "runtime"),
        };
        finish();
      });
    this.flight = { id, controller, promise, publishing: false };
    this.update({
      status: "preparing",
      phase: "queued",
      downloadedBytes: 0,
      error: undefined,
      deletionBlocked: false,
    });
    return promise;
  }
  async cancel(): Promise<void> {
    const flight = this.flight;
    if (!flight) return;
    if (!flight.publishing) flight.controller.abort();
    await flight.promise;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    await this.deletion;
    await this.initialization;
    await this.entryWrite;
  }
  private async checkRuntime(
    record: PreinstalledToolInstallation,
    manifest: PreinstalledToolManifest,
    staging: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (const check of manifest.runtimeChecks) {
      const directory = await mkdtemp(join(staging, "check-"));
      try {
        // 检查入口只放在私有临时目录；公开 bin 必须等安装记录发布后才能看到新版本。
        await writePreinstalledEntries(directory, record, {
          checkTempDir: directory,
          windowsEntryShim: this.options.windowsEntryShim,
        });
        const args = check.args.map((value) =>
          expandPreinstalledValue(value, record.installationDir, directory),
        );
        const result = await runPreinstalledRuntimeCheck(
          join(directory, preinstalledEntryExecutable(check.entry)),
          args,
          { cwd: record.installationDir, signal, timeoutMs: check.timeoutMs },
        );
        if (!`${result.stdout}\n${result.stderr}`.includes(check.expectedOutput))
          throw new Error("运行检查输出不匹配");
      } finally {
        await removePreinstalledDirectory(directory);
      }
    }
  }
  private async install(id: string, signal: AbortSignal): Promise<Partial<PreinstalledToolState>> {
    const { manifest, paths, log, toolId } = this.options;
    if (!manifest) return { status: "not-installed" };
    const staging = join(paths.stagingDir, id);
    const payload = join(staging, "payload");
    const archive = join(staging, "resource.tar.gz");
    const installationDir = join(paths.versionsDir, manifest.resourceId);
    let moved = false;
    let published = false;
    let outcome: Partial<PreinstalledToolState> = {
      status: "not-installed",
      phase: undefined,
      downloadedBytes: undefined,
      error: undefined,
    };
    let errorKind: PreinstalledToolError = "runtime";
    const phase = (value: NonNullable<PreinstalledToolState["phase"]>) => {
      signal.throwIfAborted();
      if (this.flight?.id !== id) throw new Error("准备操作已经失效");
      this.update({ status: "preparing", phase: value, error: undefined });
      log.info(undefined, "准备阶段", {
        toolId,
        operationId: id,
        resourceId: manifest.resourceId,
        phase: value,
      });
    };
    const logRenameRetry = (detail: { code: string; attempt: number; waitedMs: number }) =>
      log.warn(undefined, "改名被占用，等待重试", {
        toolId,
        operationId: id,
        resourceId: manifest.resourceId,
        ...detail,
      });
    try {
      if (
        !manifest.platforms.some(
          (target) => target.platform === process.platform && target.arch === process.arch,
        )
      )
        throw new PreinstalledToolFailure("unsupported", "目标平台不匹配");
      await mkdir(payload, { recursive: true });
      await checkPreinstalledToolSpace(paths.stagingDir, manifest);
      await downloadPreinstalledTool({
        manifest,
        archive,
        signal,
        createNetwork: this.options.createNetwork,
        progress: (downloadedBytes) => {
          if (this.flight?.id === id && !signal.aborted) this.update({ downloadedBytes });
        },
        phase,
        operationId: id,
        log,
      });
      errorKind = "extract";
      phase("extracting");
      await extractPreinstalledArchive(archive, payload, manifest, signal);
      errorKind = "checksum";
      await validatePreinstalledFiles(payload, manifest);
      signal.throwIfAborted();
      errorKind = "extract";
      await rewritePreinstalledFiles({
        directory: payload,
        installationDir,
        manifest,
        signal,
        log,
      });
      // 先移到最终目录，再通过同一入口执行检查，安装路径占位符才与发布后完全一致。
      errorKind = "runtime";
      await guardedRemoveDirectories([installationDir]);
      await renamePreinstalledPath(payload, installationDir, { signal, onRetry: logRenameRetry });
      moved = true;
      const record = preinstalledToolInstallationSchema.parse({
        schemaVersion: 1,
        toolId,
        resourceId: manifest.resourceId,
        version: manifest.version,
        platform: process.platform,
        arch: process.arch,
        installationDir,
        installedSizeBytes: manifest.installedSizeBytes,
        requiredFiles: manifest.requiredFiles,
        entries: manifest.entries,
        installedAt: new Date().toISOString(),
      });
      phase("checking");
      await this.checkRuntime(record, manifest, staging, signal);
      const temporaryRecord = join(staging, "installation.json");
      await writeFile(temporaryRecord, JSON.stringify(record));
      signal.throwIfAborted();
      // 最后取消检查与提交准入无 await；已准入的原子发布必须先结算，不能撤回成功记录。
      if (this.flight?.id !== id) throw new Error("准备操作已经失效");
      this.flight.publishing = true;
      // 已准入的发布不响应取消，重试也不传 signal。
      await renamePreinstalledPath(temporaryRecord, paths.recordPath, { onRetry: logRenameRetry });
      published = true;
      for (const entry of record.entries) this.knownEntries.set(entry.name, entry);
      this.record = record;
      outcome = { status: "ready", phase: undefined, downloadedBytes: undefined, error: undefined };
      await this.syncEntries();
      log.info(undefined, "安装发布完成", {
        toolId,
        operationId: id,
        resourceId: manifest.resourceId,
      });
    } catch (error) {
      if (!published)
        outcome = {
          status: signal.aborted ? "not-installed" : "failed",
          phase: undefined,
          downloadedBytes: undefined,
          error: signal.aborted ? undefined : classifyPreinstalledToolFailure(error, errorKind),
        };
      log.warn(undefined, signal.aborted ? "准备已取消" : "准备失败", {
        toolId,
        operationId: id,
        resourceId: manifest.resourceId,
        // 运行失败不能推断仿真支持情况；同时保留资源与宿主架构供导出日志定位。
        binaryArch: manifest.binaryArch,
        hostArch: process.arch,
        errorKind: classifyPreinstalledToolFailure(error, errorKind),
        error: String(error),
      });
    } finally {
      try {
        if (moved && !published) await guardedRemoveDirectories([installationDir]);
        await removePreinstalledDirectory(staging);
      } catch (error) {
        if (!published)
          outcome = {
            status: "failed",
            phase: undefined,
            downloadedBytes: undefined,
            // 清理错误不能覆盖安装阶段已确认的原因；新的 ENOSPC 仍由分类器优先处理。
            error: classifyPreinstalledToolFailure(error, outcome.error ?? "runtime"),
          };
        log.warn(undefined, "准备临时目录清理失败", {
          toolId,
          operationId: id,
          error: String(error),
        });
      }
    }
    return outcome;
  }
}
