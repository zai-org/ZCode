import { discoverBackupVolumes } from "./backup-volumes.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MigrationBackup, MigrationOptions, SqliteMigration } from "./contract.js";
import { describeTable, estimateTableBytes, hashTable, identifier } from "./table-snapshot.js";

const BACKUPS_TO_KEEP = 2;
const SPACE_MARGIN_BYTES = 1024 * 1024;
export const BACKUP_DATABASE_FILE = "tables.sqlite";

export async function createMigrationBackup(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<{ path?: string; skipped: boolean }> {
  const tables = [...new Set(migrations.flatMap((migration) => migration.touchedTables))].map(
    (table) => describeTable(db, table),
  );
  // 新库没有待保护的历史表；不为每个内存测试或首次安装制造空备份。
  if (tables.every((table) => table.columns.length === 0)) return { skipped: false };
  const metadata: MigrationBackup = {
    version: 2,
    database: options.database,
    ...(options.journalTable ? { journalTable: options.journalTable } : {}),
    migrations: migrations.map((migration) => migration.id),
    tables: [],
  };
  // Bug：旧空间估算依赖整表快照，尚未检查磁盘就可能 OOM；锁内逐行估算，不保留正文。
  const estimate =
    (SPACE_MARGIN_BYTES +
      tables.reduce((bytes, table) => bytes + estimateTableBytes(db, table), 0)) *
    2;
  const prefix = `${identifier(options.database).slice(1, -1)}-`;
  let skippedPath: string | undefined;
  for await (const directory of candidateDirectories(options)) {
    let path: string | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const space = await statfs(directory, { bigint: true });
      if (space.bavail * space.bsize < BigInt(estimate)) {
        skippedPath ??= directory;
        continue;
      }
      path = join(directory, `${prefix}${(options.now ?? Date.now)()}-${randomUUID()}`);
      await mkdir(path, { mode: 0o700 });
      const backup = new DatabaseSync(join(path, BACKUP_DATABASE_FILE));
      try {
        backup.exec("pragma cache_size=-2048; begin");
        metadata.tables = [];
        for (const table of tables) {
          if (table.columns.length)
            backup.exec(
              `create table ${identifier(table.name)} (${table.columns.map(identifier).join(",")})`,
            );
          metadata.tables.push(hashTable(db, table, metadata.version, backup));
        }
        backup.exec("commit");
      } finally {
        backup.close();
      }
      await writeFile(join(path, "backup.json"), JSON.stringify(metadata, null, 2), {
        mode: 0o600,
      });
      await pruneBackups(directory, prefix, path);
      return { path, skipped: false };
    } catch (error) {
      if (path) await rm(path, { recursive: true, force: true });
      if (!isUnavailableVolume(error)) throw error;
      skippedPath ??= directory;
    }
  }
  metadata.skipped = "insufficient-space";
  // 无空间不是数据迁移失败；保留显式结果，让启动入口提示用户，不能静默略过。
  if (skippedPath) {
    const path = join(skippedPath, `${prefix}${(options.now ?? Date.now)()}-${randomUUID()}`);
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(join(path, "backup.json"), JSON.stringify(metadata, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      if (!isUnavailableVolume(error)) throw error;
    }
  }
  options.onBackupSkipped?.(metadata);
  return { skipped: true };
}

function isUnavailableVolume(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["ENOSPC", "EACCES", "EPERM", "EROFS", "EEXIST", "ENOTDIR"].includes(String(error.code))
  );
}

async function pruneBackups(directory: string, prefix: string, current: string): Promise<void> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  let kept = 1;
  for (const name of names) {
    const path = join(directory, name);
    if (path === current) continue;
    // 只消费本模块生成且有完成元数据的目录；不清理用户文件或半成品。
    const metadata = await readFile(join(path, "backup.json"), "utf8").catch(() => null);
    if (!metadata) continue;
    if (kept++ < BACKUPS_TO_KEEP) continue;
    await rm(path, { recursive: true, force: true });
  }
}

async function* candidateDirectories(options: MigrationOptions): AsyncGenerator<string> {
  const seen = new Set<string>();
  for (const directory of options.backupDirectories) {
    seen.add(directory);
    yield directory;
  }
  const fallback = await (options.fallbackBackupDirectories ?? discoverBackupVolumes)();
  for (const directory of fallback)
    if (!seen.has(directory)) {
      seen.add(directory);
      yield directory;
    }
}
