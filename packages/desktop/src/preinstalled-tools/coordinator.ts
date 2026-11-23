import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  PreinstalledToolConfiguration,
  PreinstalledToolsRelease,
  PreinstalledToolsState,
} from "@zcode/shared/preinstalled-tools";
import {
  resolvePreinstalledToolPaths,
  resolvePreinstalledToolsPaths,
} from "@zcode/shared/preinstalled-tools/node";
import type { createServiceLogger, HostApiNetworkTransport } from "@zcode/services/node";
import { PreinstalledToolOwner } from "@desktop/preinstalled-tools/installation.js";
import { removePreinstalledEntryFile } from "@desktop/preinstalled-tools/entries.js";
import { guardedRemoveDirectories } from "@desktop/preinstalled-tools/removal.js";

type QueuedPreparation = {
  operation(): Promise<void>;
  signal: AbortSignal;
  resolve(): void;
  reject(error: unknown): void;
  cancel(): void;
};

/** 发布身份内唯一协调器：只拥有全局设置和串行执行队列，工具事实仍归各自 owner。 */
export class PreinstalledToolsCoordinator {
  private readonly owners: Map<string, PreinstalledToolOwner>;
  private readonly queue: QueuedPreparation[] = [];
  private pump?: Promise<void>;
  private autoInstallEnabled = true;
  private agentDisabled = new Set<string>();
  private initialization?: Promise<boolean>;
  private initialized = false;
  private disposed = false;
  private preferenceWrite?: Promise<void>;
  constructor(
    private readonly options: {
      dataRoot: string;
      release: PreinstalledToolsRelease;
      /** null 表示清单不可用：没有 owner，也不按 catalog 归属回收任何入口或目录。 */
      tools: PreinstalledToolConfiguration[] | null;
      appStartup: boolean;
      readAutoInstall(): Promise<boolean>;
      persistAutoInstall(enabled: boolean): Promise<void>;
      readAgentDisabled(): Promise<string[]>;
      persistAgentDisabled(toolIds: string[]): Promise<void>;
      createNetwork(): HostApiNetworkTransport;
      publish(state: PreinstalledToolsState): void;
      log: ReturnType<typeof createServiceLogger>;
      windowsEntryShim?: string;
    },
  ) {
    this.owners = new Map(
      (options.tools ?? []).map((tool) => [
        tool.toolId,
        new PreinstalledToolOwner({
          ...tool,
          appStartup: options.appStartup,
          paths: resolvePreinstalledToolPaths({ ...options, toolId: tool.toolId }),
          createNetwork: options.createNetwork,
          windowsEntryShim: options.windowsEntryShim,
          agentEnabled: () => !this.agentDisabled.has(tool.toolId),
          log: options.log,
          publish: () => this.publish(),
          schedule: (operation, signal) => this.schedule(operation, signal),
        }),
      ]),
    );
  }
  snapshot(): PreinstalledToolsState {
    return {
      autoInstallEnabled: this.autoInstallEnabled,
      tools: [...this.owners.values()].map((owner) => owner.snapshot()),
    };
  }
  private publish() {
    this.options.publish(this.snapshot());
  }
  initialize(): Promise<boolean> {
    if (this.initialized) return Promise.resolve(true);
    if (this.initialization) return this.initialization;
    const task = Promise.resolve()
      .then(async () => {
        this.autoInstallEnabled = await this.options.readAutoInstall();
        this.agentDisabled = new Set(await this.options.readAgentDisabled());
        const paths = resolvePreinstalledToolsPaths(this.options);
        await mkdir(paths.rootDir, { recursive: true });
        await mkdir(paths.binDir, { recursive: true });
        await mkdir(paths.toolsDir, { recursive: true });
        const loadedOwners: PreinstalledToolOwner[] = [];
        for (const owner of this.owners.values()) {
          try {
            await owner.loadInstallation();
            loadedOwners.push(owner);
          } catch (error) {
            owner.failInitialization(error);
          }
        }
        // 修复原因：清单不可用曾以空列表传入，全部入口被当作无主撤销，全部工具目录被当作
        // 移出 catalog 删除。归属未知时两项都跳过：入口仍是上次按安装记录派生的结果，
        // 留给清单可用的启动对齐。
        const catalogAvailable = this.options.tools !== null;
        // 已知工具由自己的对齐函数报告 IO 故障；仅清理无主文件，清理失败前不能回收其可能指向的目录。
        for (const name of catalogAvailable ? await readdir(paths.binDir) : []) {
          if ([...this.owners.values()].some((owner) => owner.ownsEntryFile(name))) continue;
          // Windows 上无主的 .exe 可能仍在运行，先改名移走；.retired 只做尽力清理。
          await removePreinstalledEntryFile(paths.binDir, name);
        }
        for (const owner of loadedOwners) await owner.initialize();
        if (this.options.appStartup && catalogAvailable) {
          // 无主入口已撤销，移出 catalog 的工具不会再暴露入口；占用中的目录留待以后启动。
          for (const entry of await readdir(paths.toolsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || this.owners.has(entry.name)) continue;
            try {
              await guardedRemoveDirectories([join(paths.toolsDir, entry.name)]);
            } catch (error) {
              this.options.log.warn(undefined, "保留仍被占用的已移除工具", {
                toolId: entry.name,
                error: String(error),
              });
            }
          }
        }
        this.initialized = true;
        this.publish();
        return true;
      })
      .catch((error: unknown) => {
        for (const owner of this.owners.values()) owner.failInitialization(error);
        return false;
      })
      .finally(() => {
        if (this.initialization === task) this.initialization = undefined;
      });
    this.initialization = task;
    return task;
  }
  private owner(toolId: string): PreinstalledToolOwner {
    const owner = this.owners.get(toolId);
    if (!owner) throw new Error(`未知预装工具: ${toolId}`);
    return owner;
  }
  async prepare(toolId: string): Promise<void> {
    const owner = this.owner(toolId);
    if (!this.disposed && (await this.initialize())) await owner.prepare();
  }
  prepareAll(): void {
    if (this.disposed) return;
    for (const owner of this.owners.values())
      if (owner.canAutoPrepare())
        void owner
          .prepare()
          .catch((error) => this.options.log.error(undefined, "准备收尾失败", String(error)));
  }
  async cancel(toolId: string): Promise<void> {
    await this.owner(toolId).cancel();
  }
  async delete(toolId: string): Promise<void> {
    if (await this.initialize()) await this.owner(toolId).delete();
  }
  async setAutoInstallEnabled(enabled: boolean): Promise<void> {
    await this.writePreference(async () => {
      await this.options.persistAutoInstall(enabled);
      this.autoInstallEnabled = enabled;
      this.publish();
      if (enabled) this.prepareAll();
    });
  }
  async setAgentEnabled(toolId: string, enabled: boolean): Promise<void> {
    const owner = this.owner(toolId);
    if (!(await this.initialize())) throw new Error("预装工具设置尚未初始化");
    await this.writePreference(async () => {
      const disabled = new Set(this.agentDisabled);
      if (enabled) disabled.delete(toolId);
      else disabled.add(toolId);
      // 先保存唯一偏好事实；写失败不能撤销入口或推送新的开关值。
      await this.options.persistAgentDisabled([...disabled]);
      this.agentDisabled = disabled;
      await owner.syncEntries();
    });
  }
  async syncEntries(toolId: string): Promise<void> {
    const owner = this.owner(toolId);
    if (await this.initialize()) await owner.syncEntries();
  }
  private async writePreference(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) throw new Error("预装工具进程正在退出");
    const write = (this.preferenceWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.preferenceWrite = write;
    try {
      await write;
    } finally {
      if (this.preferenceWrite === write) this.preferenceWrite = undefined;
    }
  }
  private schedule(operation: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (this.disposed || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const job: QueuedPreparation = {
        operation,
        signal,
        resolve,
        reject,
        cancel: () => {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", job.cancel);
          resolve();
        },
      };
      this.queue.push(job);
      signal.addEventListener("abort", job.cancel, { once: true });
      this.startPump();
    });
  }
  private startPump(): void {
    if (this.pump || this.disposed) return;
    const flight = Promise.resolve()
      .then(async () => {
        while (this.queue.length && !this.disposed) {
          const job = this.queue.shift()!;
          job.signal.removeEventListener("abort", job.cancel);
          try {
            if (!job.signal.aborted) await job.operation();
            job.resolve();
          } catch (error) {
            job.reject(error);
          }
        }
      })
      .finally(() => {
        if (this.pump === flight) this.pump = undefined;
        // owner 的完成回调可以排入新请求；不能把旧 pump 的收尾当成队列已空。
        if (this.queue.length) this.startPump();
      });
    this.pump = flight;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.owners.values()].map((owner) => owner.dispose()));
    await this.pump;
    await this.preferenceWrite;
    await this.initialization;
  }
}
