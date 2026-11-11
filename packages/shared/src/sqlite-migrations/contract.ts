import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";

/** 历史 SQL 是 checksum 输入，发布后不可修改；apply 只供带数据回填的迁移使用。 */
export interface SqliteMigration {
  id: string;
  /** 开发分支迁移后移时沿用旧记账；所有已存在别名必须具有相同 SQL checksum。 */
  previousIds?: readonly string[];
  appVersion: string;
  sql: string;
  touchedTables: readonly string[];
  apply?: (db: DatabaseSync) => void;
}

export interface MigrationBackupTable {
  name: string;
  columns: string[];
  rows: number;
  hash: string;
}

export interface MigrationBackup {
  /** v2 按行摘要增量校验；恢复仍支持 v1 的排序 JSON 哈希。 */
  version: 1 | 2;
  database: string;
  journalTable?: "schema_migration" | "tasks_schema_migration";
  migrations: string[];
  tables: MigrationBackupTable[];
  skipped?: "insufficient-space";
}

export interface MigrationOptions {
  database: string;
  transactionOpen?: boolean;
  onBeforeApply?: (migrationId: string) => void | Promise<void>;
  onApplied?: (migrationId: string) => void;
  onCommitting?: () => void | Promise<void>;
  /** 保留已发布 Host 任务库的三列记账结构；默认使用 CLI/项目四列结构。 */
  journalTable?: "schema_migration" | "tasks_schema_migration";
  /** 按优先级排列的可写卷目录；首项通常是 ~/.zcode/backup。 */
  backupDirectories: readonly string[];
  /** 首选卷失败后探测；默认枚举平台已挂载卷，测试可注入受控临时目录。 */
  fallbackBackupDirectories?: () => Promise<readonly string[]>;
  /** 兼容现有 CLI schema_migration 列名，app 采用 applied_at。 */
  appliedAtColumn?: "time_applied" | "applied_at";
  now?: () => number;
  onBackupSkipped?: (backup: MigrationBackup) => void;
}

export interface MigrationResult {
  applied: string[];
  backupPath?: string;
  backupSkipped: boolean;
}

export class MigrationChecksumError extends Error {
  constructor(readonly migrationId: string) {
    super(`Migration checksum mismatch: ${migrationId}`);
    this.name = "MigrationChecksumError";
  }
}

export interface SqliteMigrationsContract {
  /** 串行 admission、校验 checksum、表级备份、单事务迁移；失败回滚并抛错。 */
  migrate(
    db: DatabaseSync,
    migrations: readonly SqliteMigration[],
    options: MigrationOptions,
  ): Promise<MigrationResult>;
  /** 工程恢复：停用业务写者后调用；关闭外键防级联，逐表验证，失败回滚。 */
  restore(db: DatabaseSync, backupPath: string): Promise<void>;
}

/** 建窗前的一次性 CLI 命令；不进入会话/消息协议。 */
export const STORAGE_MIGRATION_COMMAND = "storage-migrate";
export const storageMigrationReportSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("storage-migrated"),
    applied: z.array(z.string()),
    backupPath: z.string().optional(),
    backupSkipped: z.boolean(),
  })
  .strict();
