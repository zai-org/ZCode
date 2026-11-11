import { join, resolve } from "node:path";
import { withFileLock } from "@zcode/shared/node";

export interface PluginStorageLock {
  readonly root: string;
}

const activeOwners = new WeakSet<PluginStorageLock>();
const MANAGEMENT_WAIT_MS = 5 * 60_000;

export async function withPluginStorageLock<T>(
  storageRoot: string,
  operation: (lock: PluginStorageLock) => Promise<T>,
  held?: PluginStorageLock,
  signal?: AbortSignal,
): Promise<T> {
  const root = resolve(storageRoot);
  signal?.throwIfAborted();
  if (held) {
    if (held.root !== root || !activeOwners.has(held)) {
      throw new Error("Plugin mutation requires the active lock for its storage root");
    }
    return operation(held);
  }

  // 商店、工作区会话和独立 CLI 可能同时改同一份安装清单。原子替换不能合并
  // 旧快照；从复核到 cache/config 提交均由同一个 Host 文件锁保护。
  return withFileLock(
    join(root, "installed_plugins.json"),
    async () => {
      signal?.throwIfAborted();
      const owner = { root };
      activeOwners.add(owner);
      try {
        return await operation(owner);
      } finally {
        activeOwners.delete(owner);
      }
    },
    { lockMaxWaitMs: MANAGEMENT_WAIT_MS },
  );
}
