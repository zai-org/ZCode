import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { stageE2EAppOutput } from "./e2e-app-output-stage.js";

/*
 * 复用构建时的共享只读快照（docs/testing/conversation-session-automatic-e2e-ci.md「复用构建时的共享快照」）。
 *
 * 修复原因：每个 WDIO 进程按 runId 复制一份桌面产物、重新 seed 一份官方插件缓存模板。
 * macOS 的写时复制几乎不花时间，Windows 没有写时复制：复制 out（约 6700 个文件、157MB，
 * 其中 renderer 占 6650 个）要 11s，seed 插件缓存要 8–16s，测试池和 CI 子 shard 的每一批
 * 都要再付一遍。复用构建（ZCODE_E2E_SKIP_BUILD=1）时产物和 CLI 在整轮里不变，按内容签名
 * 只做一次，之后的批次直接用。快照建好后只读；签名一变就另建，隔离效果与按 runId 复制相同。
 */

const COMPLETE_MARKER = ".zcode-e2e-snapshot-complete";
const KEEP_SNAPSHOTS = 3;

/** 目录内容签名：相对路径 + 大小 + 修改时间。不读文件内容，Windows 上 6700 个文件约 0.3s */
export function directorySignature(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative(dir, full)}\n`);
        walk(full);
      } else {
        const info = statSync(full);
        hash.update(`f:${relative(dir, full)}:${info.size}:${Math.trunc(info.mtimeMs)}\n`);
      }
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 16);
}

/** 单个文件的签名（大小 + 修改时间）。CLI 入口用它：同一轮里 CLI 不会重建 */
export function fileSignature(file: string): string | null {
  if (!existsSync(file)) return null;
  const info = statSync(file);
  return createHash("sha256")
    .update(`${file}:${info.size}:${Math.trunc(info.mtimeMs)}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * 取 cacheRoot/key 下的快照；没有就用 build 在临时目录里建好，再原子改名过去。
 * 多个进程同时建时只有一个改名成功，其余丢掉自己的临时目录、用已有的那份。
 * 建好后顺手清掉最旧的快照，只留最近几份；正在被别的运行使用而删不掉的跳过。
 */
export async function ensureSharedSnapshot(input: {
  cacheRoot: string;
  key: string;
  build: (dir: string) => Promise<void>;
  keep?: number;
}): Promise<string> {
  const finalDir = join(input.cacheRoot, input.key);
  if (existsSync(join(finalDir, COMPLETE_MARKER))) return finalDir;
  await mkdir(input.cacheRoot, { recursive: true });
  const tmp = join(input.cacheRoot, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await input.build(tmp);
    await writeFile(join(tmp, COMPLETE_MARKER), new Date().toISOString());
    if (existsSync(finalDir) && !existsSync(join(finalDir, COMPLETE_MARKER))) {
      // 上次建到一半就被打断的残留：没有完成标记，不能用
      await rm(finalDir, { force: true, recursive: true, maxRetries: 3 });
    }
    try {
      await rename(tmp, finalDir);
    } catch (error) {
      if (!existsSync(join(finalDir, COMPLETE_MARKER))) throw error;
    }
  } finally {
    await rm(tmp, { force: true, recursive: true, maxRetries: 3 }).catch(() => undefined);
  }
  await pruneSnapshots(input.cacheRoot, input.key, input.keep ?? KEEP_SNAPSHOTS);
  return finalDir;
}

async function pruneSnapshots(cacheRoot: string, current: string, keep: number) {
  const entries = (await readdir(cacheRoot, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && !e.name.startsWith(".tmp-"),
  );
  const aged = await Promise.all(
    entries.map(async (e) => ({
      name: e.name,
      mtime: (await stat(join(cacheRoot, e.name))).mtimeMs,
    })),
  );
  aged.sort((a, b) => b.mtime - a.mtime);
  for (const old of aged.slice(keep)) {
    if (old.name === current) continue;
    await rm(join(cacheRoot, old.name), { force: true, recursive: true }).catch(() => undefined);
  }
}

/**
 * 按 runId 准备应用目录，renderer 用共享快照：其余小目录照常复制（用例会往 main 里写启动文件），
 * renderer 目录放一个指向共享快照的链接（Windows 用 junction，不需要管理员权限）。
 * 递归删除运行目录只删链接本身，不会删到共享快照。
 */
export async function stageE2EAppOutputWithSharedRenderer(input: {
  sourceDir: string;
  destinationDir: string;
  cacheRoot: string;
  linkType?: "junction" | "dir";
}): Promise<{ renderer: string; reused: boolean }> {
  await mkdir(input.destinationDir, { recursive: true });
  const entries = await readdir(input.sourceDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== "renderer")
      .map(async (entry) => {
        const from = join(input.sourceDir, entry.name);
        const to = join(input.destinationDir, entry.name);
        if (entry.isDirectory()) return stageE2EAppOutput(from, to);
        if (!entry.isFile()) throw new Error(`Unsupported E2E app output entry: ${from}`);
        return copyFile(from, to, constants.COPYFILE_FICLONE);
      }),
  );
  const rendererSource = join(input.sourceDir, "renderer");
  if (!existsSync(rendererSource)) return { renderer: "", reused: false };
  const key = directorySignature(rendererSource);
  const existed = existsSync(join(input.cacheRoot, key, COMPLETE_MARKER));
  const renderer = await ensureSharedSnapshot({
    cacheRoot: input.cacheRoot,
    key,
    build: (dir) => stageE2EAppOutput(rendererSource, dir),
  });
  await rm(join(input.destinationDir, "renderer"), { force: true, recursive: true });
  await symlink(
    renderer,
    join(input.destinationDir, "renderer"),
    input.linkType ?? (process.platform === "win32" ? "junction" : "dir"),
  );
  return { renderer, reused: existed };
}
