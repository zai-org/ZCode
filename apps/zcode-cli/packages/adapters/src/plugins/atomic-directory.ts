import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";

export interface ActivateDirectoryAtomicallyInput {
  authorityPath?: string;
  prepare?: (stagedPath: string) => Promise<void>;
  signal?: AbortSignal;
  sourcePath?: string;
  targetPath: string;
}

export interface ReplaceDirectoryAtomicallyInput extends ActivateDirectoryAtomicallyInput {
  sourcePath: string;
}

export interface AtomicDirectoryActivation {
  finalize: () => Promise<void>;
  rollback: () => Promise<void>;
  transactionId: string;
}

interface AtomicTransactionRecordV1 {
  stageName: string;
  version: 1;
}

interface AtomicTransactionRecordV2 {
  authorityPath?: string;
  hadTarget: boolean;
  mode: "coordinated" | "standalone";
  ownerId: string;
  ownerPid: number;
  stageName: string;
  transactionId: string;
  version: 2;
}

type AtomicTransactionRecord = AtomicTransactionRecordV1 | AtomicTransactionRecordV2;

const atomicProcessOwnerId = randomUUID();
const activeAtomicReservations = new Set<string>();
const activeAtomicTargets = new Map<
  string,
  Pick<AtomicTransactionRecordV2, "authorityPath" | "hadTarget" | "mode" | "transactionId">
>();

function getAtomicRecoveryPaths(targetPath: string): {
  backupPath: string;
  transactionPath: string;
} {
  const parent = dirname(targetPath);
  const name = basename(targetPath);
  return {
    backupPath: join(parent, `.${name}.backup`),
    transactionPath: join(parent, `.${name}.transaction.json`),
  };
}

/** 读取 standalone 原子文件的完整一代；恢复清理由现有写入口负责，读者不抢占事务。 */
export async function readStandaloneAtomicFile(targetPath: string): Promise<string> {
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(targetPath);
  let preferBackup = false;
  try {
    const transaction = JSON.parse(
      await readFile(transactionPath, "utf8"),
    ) as Partial<AtomicTransactionRecordV2>;
    preferBackup =
      transaction.version === 2 &&
      transaction.mode === "standalone" &&
      typeof transaction.ownerId === "string" &&
      Number.isSafeInteger(transaction.ownerPid) &&
      (transaction.ownerPid ?? 0) > 0 &&
      isAtomicTransactionOwnerAlive(transaction as AtomicTransactionRecordV2);
  } catch {
    // 没有事务标记时优先读取 target；崩溃留下的 backup 仍可作为缺失回退。
  }
  const first = preferBackup ? backupPath : targetPath;
  const second = preferBackup ? targetPath : backupPath;
  try {
    return await readFile(first, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // writer 可以在选定路径之后完成 promote/finalize；只在缺失时读取另一完整文件。
    return await readFile(second, "utf8");
  }
}

type AtomicGeneration = Pick<
  AtomicTransactionRecordV2,
  "authorityPath" | "hadTarget" | "mode" | "transactionId"
>;

/** 两个读取入口各自收集的磁盘事实。 */
interface AtomicTargetFacts {
  /** 本进程登记的活跃事务，否则为磁盘上的 v2 事务记录。 */
  generation?: AtomicGeneration;
  /** 事务仍由本进程或另一个存活进程持有。 */
  live: boolean;
  /** coordinated 事务的 transactionId 已写入权威状态。 */
  committed: boolean;
  targetExists: boolean;
  backupExists: boolean;
}

interface AtomicTargetDecision {
  /** 已提交的一代当前所在位置。 */
  read: "target" | "backup";
  /** 读的是 target，且没有仍在进行的未提交事务；只有 stable 的 target 可作为执行根。 */
  stable: boolean;
  /** 事务无人持有时的修复动作，只由同步恢复入口执行。 */
  repair: "none" | "restore_backup" | "drop_backup" | "drop_target";
}

/**
 * 原子事务的判定：同步恢复入口 recoverAtomicTargetSync 与异步只读入口 readAtomicTarget 都只收集事实再调用这里。
 * 修复前两个入口各写一套分支，同一磁盘状态下读到的一代或稳定性不同（例如 writer 仍存活、
 * 权威状态已提交但 target 缺失时，同步入口返回不存在的 target，异步入口返回 backup）。
 */
function decideAtomicState(facts: AtomicTargetFacts): AtomicTargetDecision {
  const { generation, live, committed, targetExists, backupExists } = facts;
  const repair = (action: AtomicTargetDecision["repair"]) => (live ? "none" : action);
  if (committed) {
    // 权威状态已带本事务：target 是新一代；target 异常缺失时退回完整的 backup。
    if (targetExists || !backupExists)
      return {
        read: "target",
        stable: true,
        repair: repair(backupExists ? "drop_backup" : "none"),
      };
    return { read: "backup", stable: false, repair: repair("restore_backup") };
  }
  if (live || generation?.mode === "coordinated") {
    // 未提交：backup 是上一代；没有 backup 时，事务开始前已存在的 target 仍是上一代。
    if (backupExists) return { read: "backup", stable: false, repair: repair("restore_backup") };
    if (generation?.hadTarget || !targetExists)
      return { read: "target", stable: !live, repair: "none" };
    // 首次安装尚未提交：target 不是已提交的一代。
    return { read: "backup", stable: false, repair: repair("drop_target") };
  }
  // 没有事务、v1 记录或无人持有的 standalone 事务：rename 本身就是提交点。
  if (targetExists || !backupExists)
    return { read: "target", stable: true, repair: backupExists ? "drop_backup" : "none" };
  return { read: "backup", stable: false, repair: "restore_backup" };
}

/** 异步 discovery 只选择已提交的一代；事务清理仍归安装/恢复所有者。 */
export async function readAtomicTarget(targetPath: string): Promise<{
  path: string;
  stable: boolean;
  files: string[];
}> {
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(targetPath);
  const files = [transactionPath];
  const transaction = await readFile(transactionPath, "utf8")
    .then((text) => parseAtomicTransaction(JSON.parse(text)))
    .catch(() => undefined);
  const active = activeAtomicTargets.get(resolve(targetPath));
  const generation = active ?? (transaction?.version === 2 ? transaction : undefined);
  let committed = false;
  if (generation?.mode === "coordinated" && generation.authorityPath) {
    const authority = await readAtomicTarget(generation.authorityPath);
    files.push(generation.authorityPath, ...authority.files);
    committed = await readFile(authority.path, "utf8")
      .then((text) => containsTransaction(JSON.parse(text), generation.transactionId))
      .catch(() => false);
  }
  const decision = decideAtomicState({
    generation,
    live:
      Boolean(active) || (transaction?.version === 2 && isAtomicTransactionOwnerAlive(transaction)),
    committed,
    targetExists: await pathExists(targetPath),
    backupExists: await pathExists(backupPath),
  });
  // backup 仅是提交前的读取视图，不能成为 cwd、环境变量或命令中的执行根。
  return {
    path: decision.read === "backup" ? backupPath : targetPath,
    stable: decision.stable,
    files,
  };
}

export function recoverAtomicTargetSync(targetPath: string): string {
  const parent = dirname(targetPath);
  const name = basename(targetPath);
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(targetPath);
  const active = activeAtomicTargets.get(resolve(targetPath));

  let transaction: AtomicTransactionRecord | undefined;
  try {
    transaction = parseAtomicTransaction(JSON.parse(readFileSync(transactionPath, "utf8")));
  } catch {
    transaction = undefined;
  }
  const generation = active ?? (transaction?.version === 2 ? transaction : undefined);
  // marker 只表示事务已经开始，不能证明 writer 已退出。普通 overview/discovery
  // 读取若恢复仍活跃的事务，会抢走 rollback backup，甚至删除 writer 的 staging。
  const live =
    Boolean(active) || (transaction?.version === 2 && isAtomicTransactionOwnerAlive(transaction));
  const decision = decideAtomicState({
    generation,
    live,
    committed:
      generation?.mode === "coordinated" &&
      typeof generation.authorityPath === "string" &&
      authorityContainsTransactionSync(generation.authorityPath, generation.transactionId),
    targetExists: existsSync(targetPath),
    backupExists: existsSync(backupPath),
  });
  if (live) return decision.read === "backup" ? backupPath : targetPath;

  if (decision.repair === "drop_backup") rmSync(backupPath, { force: true, recursive: true });
  if (decision.repair === "drop_target" || decision.repair === "restore_backup")
    rmSync(targetPath, { force: true, recursive: true });
  if (decision.repair === "restore_backup") renameSync(backupPath, targetPath);
  if (transaction?.stageName.startsWith(`.${name}.stage-`)) {
    rmSync(join(parent, transaction.stageName), { force: true, recursive: true });
  }
  rmSync(transactionPath, { force: true });
  return targetPath;
}

function isAtomicTransactionOwnerAlive(transaction: AtomicTransactionRecordV2): boolean {
  if (transaction.ownerPid === process.pid) {
    return transaction.ownerId === atomicProcessOwnerId;
  }
  try {
    process.kill(transaction.ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function authorityContainsTransactionSync(authorityPath: string, transactionId: string): boolean {
  const readableAuthorityPath = recoverAtomicTargetSync(authorityPath);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(readableAuthorityPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  return containsTransaction(value, transactionId);
}

function containsTransaction(value: unknown, transactionId: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (!Array.isArray(current) && "cacheTransactionId" in current) {
      const record = current as { cacheTransactionId?: unknown };
      if (record.cacheTransactionId === transactionId) return true;
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return false;
}

async function writeAtomicTransaction(
  targetPath: string,
  stagePath: string,
  input: Pick<AtomicTransactionRecordV2, "authorityPath" | "hadTarget" | "mode" | "transactionId">,
): Promise<void> {
  const { transactionPath } = getAtomicRecoveryPaths(targetPath);
  const record: AtomicTransactionRecordV2 = {
    ...(input.authorityPath ? { authorityPath: resolve(input.authorityPath) } : {}),
    hadTarget: input.hadTarget,
    mode: input.mode,
    ownerId: atomicProcessOwnerId,
    ownerPid: process.pid,
    stageName: basename(stagePath),
    transactionId: input.transactionId,
    version: 2,
  };
  try {
    // in-process reservation 无法覆盖 CLI/Desktop 等多进程 writer。
    // marker 必须排他创建，避免第二个进程覆写仍存活事务的 owner 与 rollback 快照。
    await writeFile(transactionPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Atomic directory activation is already active: ${targetPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function replaceDirectoryAtomically(
  input: ReplaceDirectoryAtomicallyInput,
): Promise<void> {
  const activation = await activateDirectoryAtomically(input);
  await activation.finalize();
}

export async function activateDirectoryAtomically(
  input: ActivateDirectoryAtomicallyInput,
): Promise<AtomicDirectoryActivation> {
  throwIfAborted(input.signal);
  const parent = dirname(input.targetPath);
  const name = basename(input.targetPath);
  await mkdir(parent, { recursive: true });
  recoverAtomicTargetSync(input.targetPath);
  const stagingContainer = await mkdtemp(join(parent, `.${name}.stage-`));
  const stagedPath = join(stagingContainer, "content");
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(input.targetPath);
  const targetKey = resolve(input.targetPath);
  const transactionId = randomUUID();
  let targetMoved = false;
  let committed = false;
  let transactionWritten = false;
  let ownershipActive = false;
  let reservationActive = false;

  try {
    // 固定 backup/marker 只能支持 single writer。允许第二个 activation
    // 覆盖内存 owner，并在失败清理时删除第一个事务的 marker，最终让 rollback 丢失快照。
    if (activeAtomicReservations.has(targetKey) || activeAtomicTargets.has(targetKey)) {
      throw new Error(`Atomic directory activation is already active: ${input.targetPath}`);
    }
    activeAtomicReservations.add(targetKey);
    reservationActive = true;
    // URL/settings marketplace 只有规范化 manifest，没有可复制的 source tree；
    // 仍需复用同一套 authority generation 与 rollback，不能退回直接覆盖 active 文件。
    if (input.sourcePath) {
      await cp(input.sourcePath, stagedPath, { force: true, recursive: true });
    } else {
      await mkdir(stagedPath, { recursive: true });
    }
    await input.prepare?.(stagedPath);
    throwIfAborted(input.signal);

    // 旧流程先 rm target 再 cp，下载后复制失败或取消会把最后可用缓存删掉。
    // staging 已完整准备后才进入提交点；提交点之后完成 rename/状态落盘，不再响应取消。
    const hadTarget = await pathExists(input.targetPath);
    activeAtomicTargets.set(targetKey, {
      ...(input.authorityPath ? { authorityPath: resolve(input.authorityPath) } : {}),
      hadTarget,
      mode: input.authorityPath ? "coordinated" : "standalone",
      transactionId,
    });
    ownershipActive = true;
    await writeAtomicTransaction(input.targetPath, stagingContainer, {
      ...(input.authorityPath ? { authorityPath: input.authorityPath } : {}),
      hadTarget,
      mode: input.authorityPath ? "coordinated" : "standalone",
      transactionId,
    });
    transactionWritten = true;
    if (hadTarget) {
      await rename(input.targetPath, backupPath);
      targetMoved = true;
    }
    try {
      await rename(stagedPath, input.targetPath);
      committed = true;
    } catch (error) {
      if (targetMoved && !(await pathExists(input.targetPath))) {
        try {
          await rename(backupPath, input.targetPath);
          targetMoved = false;
        } catch (rollbackError) {
          throw appendPluginSourceCleanupError(error, rollbackError);
        }
      }
      await cleanupPluginSourceBestEffort(async () => {
        await rm(transactionPath, { force: true });
      });
      transactionWritten = false;
      activeAtomicTargets.delete(targetKey);
      ownershipActive = false;
      throw error;
    }
    await cleanupPluginSourceBestEffort(async () => {
      await rm(stagingContainer, { force: true, recursive: true });
    });
    let settled = false;
    return {
      finalize: async () => {
        if (settled) return;
        settled = true;
        try {
          if (targetMoved) {
            // 权威状态带同一 transactionId 落盘后才删除 backup。
            await cleanupPluginSourceBestEffort(async () => {
              await rm(backupPath, { force: true, recursive: true });
            });
          }
          await cleanupPluginSourceBestEffort(async () => {
            await rm(transactionPath, { force: true });
          });
        } finally {
          activeAtomicTargets.delete(targetKey);
          activeAtomicReservations.delete(targetKey);
          ownershipActive = false;
          reservationActive = false;
        }
      },
      rollback: async () => {
        if (settled) return;
        try {
          // 依赖 closure 的后续插件或 installed state 写入失败时，撤销已激活目录。
          await rm(input.targetPath, { force: true, recursive: true });
          if (targetMoved) await rename(backupPath, input.targetPath);
          await cleanupPluginSourceBestEffort(async () => {
            await rm(transactionPath, { force: true });
          });
          settled = true;
        } finally {
          activeAtomicTargets.delete(targetKey);
          activeAtomicReservations.delete(targetKey);
          ownershipActive = false;
          reservationActive = false;
        }
      },
      transactionId,
    };
  } finally {
    if (!committed) {
      await cleanupPluginSourceBestEffort(async () => {
        await rm(stagingContainer, { force: true, recursive: true });
      });
      if (transactionWritten && !targetMoved) {
        await cleanupPluginSourceBestEffort(async () => {
          await rm(transactionPath, { force: true });
        });
      }
      if (ownershipActive) activeAtomicTargets.delete(targetKey);
      if (reservationActive) activeAtomicReservations.delete(targetKey);
    }
  }
}

export async function writeFileAtomically(path: string, data: string | Uint8Array): Promise<void> {
  const parent = dirname(path);
  const name = basename(path);
  await mkdir(parent, { recursive: true });
  recoverAtomicTargetSync(path);
  const temporaryPath = join(parent, `.${name}.stage-${randomUUID()}`);
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(path);
  const transactionId = randomUUID();
  let targetMoved = false;
  let committed = false;
  try {
    await writeFile(temporaryPath, data);
    try {
      // POSIX 可直接原子替换同目录文件，不制造 target 缺失窗口。
      // Windows 若拒绝覆盖已有目标，再进入带确定性 backup 的可恢复路径。
      await rename(temporaryPath, path);
      committed = true;
      return;
    } catch (replaceError) {
      if (!(await pathExists(path))) throw replaceError;
    }
    await writeAtomicTransaction(path, temporaryPath, {
      hadTarget: true,
      mode: "standalone",
      transactionId,
    });
    await rename(path, backupPath);
    targetMoved = true;
    try {
      await rename(temporaryPath, path);
      committed = true;
    } catch (error) {
      if (targetMoved && !(await pathExists(path))) {
        try {
          await rename(backupPath, path);
          targetMoved = false;
        } catch (rollbackError) {
          throw appendPluginSourceCleanupError(error, rollbackError);
        }
      }
      throw error;
    }
  } finally {
    await cleanupPluginSourceBestEffort(async () => {
      await rm(temporaryPath, { force: true });
    });
    if (committed && targetMoved) {
      await cleanupPluginSourceBestEffort(async () => {
        await rm(backupPath, { force: true });
      });
    }
    if (committed || !targetMoved) {
      await cleanupPluginSourceBestEffort(async () => {
        await rm(transactionPath, { force: true });
      });
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  throw error;
}

function parseAtomicTransaction(value: unknown): AtomicTransactionRecord | undefined {
  const parsed = value as Partial<AtomicTransactionRecord>;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (parsed.version === 1 && typeof parsed.stageName === "string") {
    return { stageName: parsed.stageName, version: 1 };
  } else if (
    parsed.version === 2 &&
    typeof parsed.stageName === "string" &&
    typeof parsed.transactionId === "string" &&
    typeof parsed.ownerId === "string" &&
    Number.isSafeInteger(parsed.ownerPid) &&
    (parsed.ownerPid ?? 0) > 0 &&
    typeof parsed.hadTarget === "boolean" &&
    (parsed.mode === "coordinated" || parsed.mode === "standalone") &&
    (parsed.authorityPath === undefined || typeof parsed.authorityPath === "string")
  ) {
    return parsed as AtomicTransactionRecordV2;
  }
  return undefined;
}

/**
 * 发现读取完整版本；不接管仍活跃的安装事务。
 * 已死亡事务的残留在返回前恢复成 target：discovery 的路径会被会话长期持有，
 * 若直接返回 backup，后续 describe/安装触发的恢复会把它改名为 target，会话里的 Skill/Hook 路径随即 ENOENT。
 */
export async function resolveAtomicReadPath(targetPath: string): Promise<string> {
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(targetPath);
  let transaction: AtomicTransactionRecord | undefined;
  try {
    transaction = parseAtomicTransaction(JSON.parse(await readFile(transactionPath, "utf8")));
  } catch {
    transaction = undefined;
  }
  const live =
    activeAtomicTargets.get(resolve(targetPath)) ??
    (transaction?.version === 2 && isAtomicTransactionOwnerAlive(transaction)
      ? transaction
      : undefined);
  if (live) {
    let committed = false;
    if (live.mode === "coordinated" && live.authorityPath) {
      try {
        committed = containsTransaction(
          JSON.parse(await readStandaloneAtomicFile(live.authorityPath)),
          live.transactionId,
        );
      } catch {
        committed = false;
      }
    }
    if (committed) return targetPath;
    if (await pathExists(backupPath)) return backupPath;
    return live.hadTarget && (await pathExists(targetPath)) ? targetPath : backupPath;
  }
  // 常态无残留，不进入恢复；只有崩溃残留才走与 describe/activation 相同的同步恢复。
  if (!transaction && !(await pathExists(backupPath))) return targetPath;
  // 恢复内部会再检查一次活跃事务：异步检查之后才启动的 writer 不会被抢走 backup。
  return recoverAtomicTargetSync(targetPath);
}
