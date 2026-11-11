import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface LockOwnerRecord {
  ownerToken?: string;
  pid?: number;
  processIdentity?: string;
}

// 本进程当前持有的锁与恢复门 token。PID 等于自己时只有它能证明锁是本进程写的。
const heldOwnerTokens = new Set<string>();
let ownProcessIdentity: Promise<string | null | undefined> | undefined;

/** 本实例持有的锁已不在路径上：missing 为锁文件不存在，taken 为路径上的锁属于其他 owner。 */
export type DataRootLockLoss = "missing" | "taken";

export type DataRootLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number }
  | { state: "stale"; pid: number }
  | { state: "invalid" }
  | { state: "unreadable"; error: unknown };

export class DataRootLock {
  private handle: FileHandle | undefined;
  private ownerToken: string | undefined;
  public constructor(private readonly path: string) {}

  public async inspect(): Promise<DataRootLockInspection> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { state: "missing" };
      }
      return { state: "unreadable", error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid" };
    }
    const record = toOwnerRecord(parsed);
    const pid = record.pid;
    if (pid === undefined) return { state: "invalid" };
    return (await isHolderAlive(record)) ? { state: "active", pid } : { state: "stale", pid };
  }

  public async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (await this.tryAcquireOnce()) return;
    const recoveryPath = `${this.path}.recovery`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.readOwner(this.path);
      if (observed && (await isHolderAlive(observed.record))) {
        throw new Error("Another ZCode Server instance is already running");
      }
      const recoveryToken = await this.tryAcquireRecoveryGate(recoveryPath);
      if (!recoveryToken) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const current = await this.readOwner(this.path);
        if (current && (await isHolderAlive(current.record))) {
          throw new Error("Another ZCode Server instance is already running");
        }
        if (current) {
          await this.claimStalePath(this.path, current.raw);
        }
        if (await this.tryAcquireOnce()) return;
      } finally {
        await this.releaseOwnedPath(recoveryPath, recoveryToken);
        heldOwnerTokens.delete(recoveryToken);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Another ZCode Server instance is already running");
  }

  /**
   * 路径上的锁已不是本实例写下的那一份时返回原因：missing 为文件不存在，taken 为换成了其他 owner；仍持有返回 null。
   * 只认这两种确定证据；读取出错（权限、I/O）无法判断，按仍持有处理，不因瞬时错误让 daemon 退出。
   */
  public async readLoss(): Promise<DataRootLockLoss | null> {
    const ownerToken = this.ownerToken;
    if (!ownerToken) return null;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      return error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "missing"
        : null;
    }
    try {
      return toOwnerRecord(JSON.parse(raw)).ownerToken === ownerToken ? null : "taken";
    } catch {
      // 新 owner 以 wx 建锁后、写完内容前读到的是不完整内容，同样说明路径已属于别人。
      return "taken";
    }
  }

  public async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token) {
      await this.releaseOwnedPath(this.path, token);
      heldOwnerTokens.delete(token);
    }
  }

  private async tryAcquireOnce(): Promise<boolean> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      const record = await createOwnerRecord(ownerToken);
      handle = await open(this.path, "wx", 0o600);
      heldOwnerTokens.add(ownerToken);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      this.handle = handle;
      this.ownerToken = ownerToken;
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      await handle?.close().catch(() => undefined);
      const observed = await this.readOwner(this.path);
      if (observed?.record.ownerToken === ownerToken) {
        await this.releaseOwnedPath(this.path, ownerToken);
      }
      heldOwnerTokens.delete(ownerToken);
      throw error;
    }
  }

  private async readOwner(path: string): Promise<{
    raw: string;
    record: LockOwnerRecord;
  } | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      return { raw, record: toOwnerRecord(JSON.parse(raw)) };
    } catch {
      return { raw, record: {} };
    }
  }

  private async tryAcquireRecoveryGate(path: string): Promise<string | null> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      const record = await createOwnerRecord(ownerToken);
      handle = await open(path, "wx", 0o600);
      heldOwnerTokens.add(ownerToken);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.close();
      return ownerToken;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        await handle?.close().catch(() => undefined);
        const observed = await this.readOwner(path);
        if (observed?.record.ownerToken === ownerToken) {
          await this.releaseOwnedPath(path, ownerToken);
        }
        heldOwnerTokens.delete(ownerToken);
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const observed = await this.readOwner(path);
    if (!observed || !(await isHolderAlive(observed.record))) {
      if (observed) await this.claimStalePath(path, observed.raw);
      return null;
    }
    return null;
  }

  private async claimStalePath(path: string, expectedRaw: string): Promise<void> {
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const claimedRaw = await readFile(quarantine, "utf8").catch(() => null);
    if (claimedRaw === expectedRaw) {
      await rm(quarantine, { force: true });
      return;
    }
    // 陈旧观察误 claim 了后来者时必须恢复，不能删除新 owner 的 lock。
    await rename(quarantine, path).catch(() => undefined);
  }

  private async releaseOwnedPath(path: string, ownerToken: string): Promise<void> {
    const observed = await this.readOwner(path);
    if (observed?.record.ownerToken !== ownerToken) return;
    const quarantine = `${path}.release-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch {
      return;
    }
    const claimed = await this.readOwner(quarantine);
    if (claimed?.record.ownerToken === ownerToken) {
      await rm(quarantine, { force: true });
      return;
    }
    await rename(quarantine, path).catch(() => undefined);
  }
}

function toOwnerRecord(parsed: unknown): LockOwnerRecord {
  if (typeof parsed !== "object" || parsed === null) return {};
  const value = parsed as { ownerToken?: unknown; pid?: unknown; processIdentity?: unknown };
  return {
    ownerToken: typeof value.ownerToken === "string" ? value.ownerToken : undefined,
    pid:
      typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
        ? value.pid
        : undefined,
    processIdentity: typeof value.processIdentity === "string" ? value.processIdentity : undefined,
  };
}

async function createOwnerRecord(ownerToken: string): Promise<Record<string, unknown>> {
  ownProcessIdentity ??= readProcessIdentity(process.pid);
  const processIdentity = await ownProcessIdentity;
  return {
    pid: process.pid,
    acquiredAt: Date.now(),
    ownerToken,
    ...(processIdentity ? { processIdentity } : {}),
  };
}

// Bug 原因：旧逻辑只凭 PID 判活（PID 等于自己、kill 0 成功或 EPERM 都算存活）。容器、WSL 发行版
// 重启后进程全没了，锁文件还在；同样的启动顺序让新 Supervisor 拿到锁里的旧 PID，或旧 PID 落到
// 其他进程上，残留锁被判为存活，Supervisor 每次启动都报 already running 并 exit 1。
// 判活改为核对进程身份：身份一致才是写锁的那个进程。
async function isHolderAlive(record: LockOwnerRecord): Promise<boolean> {
  const pid = record.pid;
  if (pid === undefined) return false;
  if (pid === process.pid) {
    return record.ownerToken !== undefined && heldOwnerTokens.has(record.ownerToken);
  }
  if (record.processIdentity !== undefined) {
    const current = await readProcessIdentity(pid);
    if (current !== undefined) return current === record.processIdentity;
  }
  // 旧版本写的锁没有身份字段，或本平台读不到身份，只能按 PID 判定。
  // Bug 原因：kill(pid, 0) 对已退出未回收的进程（僵尸）同样成功，PID 1 不回收子进程的容器里，旧格式的锁
  // 会被僵尸一直“持有”。Linux 上先用进程状态排除僵尸，再按 PID 判定。
  if (process.platform === "linux" && (await readProcessIdentity(pid)) === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH：进程不存在。EPERM：PID 属于其他用户；锁文件 0600 只有当前用户能读，
    // 写锁的不可能是其他用户的进程，只能是 PID 被复用。
    return false;
  }
}

/**
 * 读取进程身份。PID 会被复用，进程启动时刻不会。
 * - Linux：boot_id + /proc/<pid>/stat 的 starttime。容器重启不换内核，boot_id 不变但 starttime 会变；
 *   整机重启后 boot_id 变化，排除 starttime 恰好相同的情况。
 * - macOS：ps 输出的启动时刻，固定 UTC 格式化。
 * 返回 null 表示进程不存在，undefined 表示读不到身份。
 */
async function readProcessIdentity(pid: number): Promise<string | null | undefined> {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error: unknown) {
      return error instanceof Error && "code" in error && error.code === "ENOENT"
        ? null
        : undefined;
    }
    // comm 字段可能含空格和括号；从最后一个 ")" 之后数，state 是第 3 个字段，starttime 是第 22 个。
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Bug 原因（ZCT-2117275161536565248）：Docker 容器的 PID 1 常是 `sleep infinity` 这类不回收子进程的程序，
    // Supervisor 非正常死亡后成为僵尸，/proc/<pid>/stat 仍在、starttime 不变，身份判定把它当成存活的持锁者，
    // 新 Supervisor 每次 exit 1，容器重启前设备一直连不上。僵尸（Z）与已死（X）已释放全部 fd、端口与内存，
    // 不可能再持有锁，按进程不存在处理。Node 主线程退出即进程结束，存活的 Supervisor 不会处于这两种状态。
    if (fields[0] === "Z" || fields[0] === "X") return null;
    const startTime = fields[19];
    if (!startTime) return undefined;
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "");
    return `${bootId.trim()}:${startTime}`;
  }
  if (process.platform === "darwin") {
    try {
      // Bug 原因：ps 按调用进程的时区格式化 lstart。写锁与检查锁的进程 TZ 不同（shell 设置了 TZ
      // 的 SSH 进程与 launchd 拉起的 Supervisor，或系统时区变化前后）时，同一进程身份不同，
      // 活着的持锁者被判为 stale 并被接管。固定 UTC，身份只取决于进程的启动时刻。
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      return stdout.trim() || null;
    } catch (error: unknown) {
      // ps 找不到该 PID 时以退出码 1 结束；ps 本身不可用时 code 是字符串。
      return error instanceof Error && "code" in error && typeof error.code === "number"
        ? null
        : undefined;
    }
  }
  return undefined;
}
