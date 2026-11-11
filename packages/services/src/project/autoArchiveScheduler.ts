import type { AutoArchiveInput, ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { ProjectTaskRef } from "#src/project/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

/**
 * 扫描只读一次设置 + 一次索引小查询，代价可忽略；5 分钟让刚超期或刚失去保护的任务
 * 很快离开列表，又不会像挂在点击上那样「点开即消失」。
 */
export const TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** 变更后需要立即补扫的设置键。 */
const TASK_AUTO_ARCHIVE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "taskAutoArchiveEnabled",
  "taskAutoArchiveOlderThanDays",
]);

export function shouldRescanTaskAutoArchive(keys: readonly string[]): boolean {
  return keys.some((key) => TASK_AUTO_ARCHIVE_SETTING_KEYS.has(key));
}

export interface TaskAutoArchiveSchedulerOptions {
  /** 读取当前策略；返回 null 表示自动归档关闭。 */
  readPolicy(): Promise<AutoArchiveInput | null>;
  repository(): Promise<Pick<ProjectRepositoryContract, "archiveInactive">>;
  /** 至少归档一条后调用，负责广播项目变更与逐条任务归档事件；没有变化时不调用。 */
  afterChange(archived: ProjectTaskRef[]): Promise<void>;
  intervalMs?: number;
}

export interface TaskAutoArchiveScheduler {
  /** 立即扫描一次并按固定间隔重复；重复调用无效。 */
  start(): void;
  /** 串行扫描；扫描进行中的调用合并为一次补扫。返回本次归档的任务。 */
  scan(): Promise<ProjectTaskRef[]>;
  dispose(): void;
}

/**
 * 自动归档的唯一触发者。
 *
 * Bug 根因（2026-09-14）：此前 archiveInactive 挂在项目服务 readTree 上，而侧栏每次
 * taskListVersion 变化都会重新 readTree。点开一条旧未读任务 → CAS 清未读 → 列表刷新 →
 * readTree 顺手归档了刚刚变成「无未读」的这条任务 → 项目树 false→true 清理详情，用户感知
 * 为「点了打不开」。归档判定不能由任何 UI 读取或点击触发，所以收口为 Host 定时扫描：
 * 启动首轮 + 固定间隔 + 自动归档设置变更后补扫。
 */
export function createTaskAutoArchiveScheduler(
  options: TaskAutoArchiveSchedulerOptions,
): TaskAutoArchiveScheduler {
  const log = createServiceLogger("task-auto-archive");
  const intervalMs = options.intervalMs ?? TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let running: Promise<ProjectTaskRef[]> | null = null;
  let queued: Promise<ProjectTaskRef[]> | null = null;

  const runOnce = async (): Promise<ProjectTaskRef[]> => {
    const policy = await options.readPolicy();
    if (!policy || disposed) return [];
    const archived = (await options.repository()).archiveInactive(policy);
    if (archived.length === 0) return archived;
    log.info(undefined, `自动归档 ${archived.length} 条任务`, {
      cutoff: policy.cutoff,
      taskIds: archived.map((task) => task.taskId),
    });
    await options.afterChange(archived);
    return archived;
  };

  const scan = (): Promise<ProjectTaskRef[]> => {
    if (disposed) return Promise.resolve([]);
    if (!running) {
      running = runOnce().finally(() => {
        running = null;
      });
      return running;
    }
    // 设置变更与定时器可能撞在同一轮：进行中的扫描读的是旧策略，结束后必须再扫一次；
    // 多个等待者共享同一次补扫，避免排队重复写事务。
    queued ??= running
      .catch(() => [])
      .then(() => {
        queued = null;
        return scan();
      });
    return queued;
  };

  const scanInBackground = () => {
    void scan().catch((error) => {
      log.warn(undefined, "自动归档扫描失败，等待下一轮", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    start() {
      if (timer || disposed) return;
      scanInBackground();
      timer = setInterval(scanInBackground, intervalMs);
      timer.unref?.();
    },
    scan,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
