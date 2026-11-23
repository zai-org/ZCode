// 符号链接写入防护：草稿写入前逐级核验父目录，拒绝经由符号链接写到工作区外（ZP-20261110-04）。
// 从 index.ts 拆出，使适配器主文件只为本次修复增长最少的行数。

import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export class SymlinkWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkWriteRefusedError";
  }
}

/**
 * 从 `base`（不含）起逐级 lstat 到 `target`，任一级是符号链接即拒绝。
 *
 * 为什么只看到 `target` 为止：`atomicWrite` 只检查最后一级，父目录链接会被 rename 跟随到项目外
 * （ZP-20261110-04：草稿目录链接到用户配置目录，覆盖后随即执行其中的 SessionStart 命令 Hook）。
 * 不存在的层级之下无需检查——之后的 mkdir 只会建出真实目录，ENOENT / ENOTDIR 即返回。
 * `base` 本身不核验：项目根经由链接访问是合法的。
 */
export async function assertNoSymlinkBetween(base: string, target: string): Promise<void> {
  const rel = relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SymlinkWriteRefusedError(`Refusing to write outside symlink-free base: ${target}`);
  }

  let current = base;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = getNodeErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${current} (under ${base})`,
      );
    }
  }
}

export function getNodeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
