import type {
  ProjectRepositoryContract,
  ProjectTaskRef,
} from "#src/project-storage/repository-contract.js";
export * from "#src/project-storage/repository-contract.js";
import type { DatabaseSync } from "node:sqlite";
import type { AppSettings } from "@zcode/shared";
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";

export interface ProjectMigrationContext {
  /** 可信持库 Server 身份；不受客户端请求或旧 canonical route 影响。 */
  hostId?: string;
  backupDirectories: readonly string[];
  settings?: Pick<
    AppSettings,
    "lastWorkspaceSession" | "recentProjects" | "sourceServers" | "connectionProfiles"
  >;
  now?: () => number;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

/** Host 数据库的版本化迁移端口；不读取或修改 CLI db.sqlite。 */
export interface ProjectStorageContract {
  /** 加法升级后同事务交接旧版本新增行/删除/标题意图；每次启动调用，不重算已处理的 NULL。 */
  migrate(db: DatabaseSync, context: ProjectMigrationContext): Promise<MigrationResult>;
  repository(db: DatabaseSync, hostId?: string): ProjectRepositoryContract;
  admitTaskIdentity(
    db: DatabaseSync,
    task: ProjectTaskRef & { forkedFromTaskId?: string },
    hostId?: string,
  ): void;
}
