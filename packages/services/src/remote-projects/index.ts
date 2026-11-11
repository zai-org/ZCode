import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  type RemoteTargetSnapshot,
  parseRemoteWorkspaceIdentity,
  buildRemoteHostWorkspaceIdentity,
} from "@zcode/shared";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project-storage/contract.js";
import type {
  IRemoteProjectService,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  RemoteProjectHost,
} from "#src/remote-projects/contract.js";
export { IRemoteProjectService } from "#src/remote-projects/contract.js";
export { projectWorkspaceSettings } from "#src/remote-projects/workspace-settings.js";
export {
  createRemoteProjectConnectionAdmission,
  releaseRemoteProjectProfileHost,
  findRemoteProjectHostIdForProfile,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
} from "#src/remote-projects/connection-membership.js";

import { text, targetSchema, rootSchema, cacheSchema } from "#src/remote-projects/validation.js";

function write<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function entry(row: Record<string, unknown>): RemoteProjectEntry {
  return {
    id: String(row.entry_id),
    hostId: String(row.host_id),
    projectId: row.remote_project_id == null ? null : String(row.remote_project_id),
    name: String(row.cached_name),
    roots: z.array(rootSchema).parse(JSON.parse(String(row.cached_roots_json))),
    legacyWorkspace:
      row.legacy_workspace_json == null ? null : JSON.parse(String(row.legacy_workspace_json)),
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
    ...(row.initial_position == null ? {} : { initialPosition: Number(row.initial_position) }),
    ...(Number(row.cached_deleted) ? { deleted: true as const } : {}),
  };
}
/** 不含连接运行态的本机目录；调用方负责 SQLite 读事务。 */
export function readRemoteProjectDirectory(db: DatabaseSync): RemoteProjectDirectory {
  return {
    hosts: db
      .prepare(
        "SELECT * FROM hosts WHERE host_id<>'local' AND target_json IS NOT NULL ORDER BY position,host_id",
      )
      .all()
      .map((row) => ({
        id: String(row.host_id),
        membershipId: text.parse(row.membership_id),
        kind: row.kind as RemoteTargetSnapshot["kind"],
        target:
          row.target_json == null
            ? null
            : (targetSchema.parse(JSON.parse(String(row.target_json))) as RemoteTargetSnapshot),
        position: Number(row.position),
        ...(row.last_connection_status == null
          ? {}
          : { lastConnectionStatus: String(row.last_connection_status) }),
        ...(row.last_connection_error == null
          ? {}
          : { lastConnectionError: String(row.last_connection_error) }),
        ...(row.last_opened_at == null ? {} : { lastOpenedAt: Number(row.last_opened_at) }),
      })),
    entries: db.prepare("SELECT * FROM remote_project_entries ORDER BY rowid").all().map(entry),
  };
}

/** 复用已完成启动迁移的 SQLite 连接，不创建网络/会话运行实例。 */
export function createRemoteProjectService(options: {
  database(): Promise<DatabaseSync>;
  controller?: boolean;
  connectHost?(host: RemoteProjectHost): Promise<string>;
  readConnectionStates?(): Promise<
    ReadonlyMap<
      string,
      Pick<
        RemoteProjectHost,
        "connectionStatus" | "lastConnectionError" | "lastConnectionStatus" | "upgradeTarget"
      >
    >
  >;
  afterChange?(): Promise<void> | void;
  now?: () => number;
}): IRemoteProjectService {
  const now = options.now ?? Date.now;
  const nextVersion = (previous: unknown) => Math.max(now(), Number(previous ?? 0) + 1);
  const requireController = () => {
    if (options.controller === false) throw new Error("remote-project.controller-only");
  };
  const requireRemote = (id: string) => {
    requireController();
    text.parse(id);
    if (id === "local") throw new Error("remote-project.local-host");
  };
  const changed = async () => {
    await options.afterChange?.();
  };
  const service: IRemoteProjectService = {
    async readDirectory() {
      if (options.controller === false) return { hosts: [], entries: [] };
      const db = await options.database();
      db.exec("BEGIN");
      try {
        const result = readRemoteProjectDirectory(db);
        db.exec("COMMIT");
        const states = await options.readConnectionStates?.();
        return states
          ? {
              ...result,
              hosts: result.hosts.map((host) => ({
                ...host,
                connectionStatus: states.get(host.id)?.connectionStatus ?? "offline",
                // 连接管理器是当前错误的唯一来源；恢复后不能显示旧持久错误。
                lastConnectionError: states.get(host.id)?.lastConnectionError,
                lastConnectionStatus: states.get(host.id)?.lastConnectionStatus,
                upgradeTarget: states.get(host.id)?.upgradeTarget,
              })),
            }
          : result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    async connectHost(id) {
      requireRemote(id);
      const host = (await service.readDirectory()).hosts.find((item) => item.id === id);
      if (!host) throw new Error("remote-project.host-not-found");
      if (!options.connectHost) throw new Error("remote-project.connector-unavailable");
      const resolvedId = await options.connectHost(host);
      const connected = (await service.readDirectory()).hosts.find(
        (item) => item.id === resolvedId,
      );
      if (!connected || (connected.id === host.id && connected.membershipId !== host.membershipId))
        throw new Error("remote-project.host-removed");
      return connected;
    },
    async saveHost(input) {
      requireRemote(input.id);
      const target = targetSchema.parse(input.target);
      const db = await options.database();
      const result = write(db, () => {
        // 历史和未完成连接曾挤满固定配额；保存量不再限额，连接并发仍由连接管理器控制。
        const existing = db
          .prepare("SELECT membership_id FROM hosts WHERE host_id=? AND target_json IS NOT NULL")
          .get(input.id);
        db.prepare(`INSERT INTO hosts(host_id,kind,target_json,membership_id,position) VALUES(?,?,?,?,(SELECT coalesce(max(position),-1)+1 FROM hosts))
          ON CONFLICT(host_id) DO UPDATE SET kind=excluded.kind,target_json=excluded.target_json,membership_id=excluded.membership_id`).run(
          input.id,
          target.kind,
          JSON.stringify(target),
          existing?.membership_id ?? randomUUID(),
        );
        return readRemoteProjectDirectory(db).hosts.find((host) => host.id === input.id)!;
      });
      await changed();
      return result;
    },
    async bindHost(input) {
      requireRemote(input.id);
      text.parse(input.membershipId);
      if (!input.resolvedId.startsWith("remote:server:"))
        throw new Error("remote-project.invalid-source");
      const db = await options.database();
      const result = write(db, () => {
        const source = db
          .prepare(
            "SELECT * FROM hosts WHERE host_id=? AND membership_id=? AND target_json IS NOT NULL",
          )
          .get(input.id, input.membershipId);
        if (!source) return null;
        const sourceTarget = targetSchema.parse(JSON.parse(String(source.target_json)));
        // URL 在首次握手前也使用 server 前缀，只有固化 serverId 后才是稳定 Source。
        const urlAlias = sourceTarget.kind === "server" && !sourceTarget.serverId;
        const distinctSource =
          input.id.startsWith("remote:server:") && input.id !== input.resolvedId && !urlAlias;
        if (distinctSource && !input.createDistinctHost)
          throw new Error("remote-project.source-identity-changed");
        const targetJson =
          sourceTarget.kind === "server"
            ? JSON.stringify({
                ...sourceTarget,
                serverId: parseRemoteWorkspaceIdentity(
                  buildRemoteHostWorkspaceIdentity(input.resolvedId, "/"),
                )?.sourceServerId,
              })
            : source.target_json;
        if (distinctSource) {
          const retained = readRemoteProjectDirectory(db).hosts.find(
            (host) => host.id === input.resolvedId,
          );
          if (retained) return retained;
          // 重装后的 Source 属于新设备身份，确认只新增连接，不搬旧入口。
          db.prepare(`INSERT INTO hosts(host_id,kind,target_json,membership_id,position)
            VALUES(?,?,?,?,(SELECT coalesce(max(position),-1)+1 FROM hosts))
            ON CONFLICT(host_id) DO UPDATE SET kind=excluded.kind,target_json=excluded.target_json,membership_id=excluded.membership_id`).run(
            input.resolvedId,
            source.kind!,
            targetJson!,
            randomUUID(),
          );
          return readRemoteProjectDirectory(db).hosts.find((host) => host.id === input.resolvedId)!;
        }
        if (input.id !== input.resolvedId) {
          if (
            db
              .prepare("SELECT 1 FROM projects WHERE host_id IN (?,?) LIMIT 1")
              .get(input.id, input.resolvedId)
          )
            throw new Error("remote-project.authoritative-host");
          const retained = db
            .prepare("SELECT 1 FROM hosts WHERE host_id=? AND target_json IS NOT NULL")
            .get(input.resolvedId);
          if (!retained)
            db.prepare(`INSERT INTO hosts(host_id,kind,target_json,membership_id,position,last_connection_status,last_connection_error,last_opened_at)
            SELECT ?,kind,target_json,membership_id,position,last_connection_status,last_connection_error,last_opened_at FROM hosts WHERE host_id=?
            ON CONFLICT(host_id) DO UPDATE SET kind=excluded.kind,target_json=excluded.target_json,membership_id=excluded.membership_id`).run(
              input.resolvedId,
              input.id,
            );
          // 同一物理 Source 的重复入口保留目标 entry ID，旧响应随旧 ID 一起失效。
          db.prepare(`DELETE FROM remote_project_entries WHERE host_id=? AND remote_project_id IS NOT NULL
            AND remote_project_id IN (SELECT remote_project_id FROM remote_project_entries WHERE host_id=?)`).run(
            input.id,
            input.resolvedId,
          );
          db.prepare("UPDATE remote_project_entries SET host_id=? WHERE host_id=?").run(
            input.resolvedId,
            input.id,
          );
          db.prepare("DELETE FROM hosts WHERE host_id=?").run(input.id);
        }
        if (sourceTarget.kind === "server")
          db.prepare("UPDATE hosts SET target_json=? WHERE host_id=? AND membership_id=?").run(
            targetJson!,
            input.resolvedId,
            source.membership_id!,
          );
        return readRemoteProjectDirectory(db).hosts.find((host) => host.id === input.resolvedId)!;
      });
      if (result && input.id !== input.resolvedId) await changed();
      return result;
    },
    async removeHost(id) {
      requireRemote(id);
      const db = await options.database();
      const affected = write(db, () => {
        // 本机移除连接不能把权威项目级联删除；迁移后的本机表不应含远端权威项目。
        if (db.prepare("SELECT 1 FROM projects WHERE host_id=? LIMIT 1").get(id))
          throw new Error("remote-project.authoritative-host");
        db.prepare("DELETE FROM remote_project_entries WHERE host_id=?").run(id);
        return db.prepare("DELETE FROM hosts WHERE host_id=?").run(id).changes;
      });
      if (affected) await changed();
    },
    async addEntry(input) {
      requireRemote(input.hostId);
      const project = cacheSchema.parse(input.project);
      const db = await options.database();
      const result = write(db, () => {
        if (
          !db
            .prepare("SELECT 1 FROM hosts WHERE host_id=? AND target_json IS NOT NULL")
            .get(input.hostId)
        )
          throw new Error("remote-project.host-not-found");
        // 连接期间删除并重新添加同一设备后，旧向导不得给新 membership 登记入口。
        if (
          input.expectedMembershipId &&
          db.prepare("SELECT membership_id FROM hosts WHERE host_id=?").get(input.hostId)
            ?.membership_id !== input.expectedMembershipId
        )
          throw new Error("remote-project.host-removed");
        const old = db
          .prepare("SELECT * FROM remote_project_entries WHERE host_id=? AND remote_project_id=?")
          .get(input.hostId, project.projectId);
        const id = old ? String(old.entry_id) : randomUUID();
        // 显式添加只针对可用项目（新建或恢复），删除态缓存随之清零。
        db.prepare(`INSERT INTO remote_project_entries(entry_id,host_id,remote_project_id,cached_name,cached_roots_json,last_synced_at,cached_deleted) VALUES(?,?,?,?,?,?,0)
          ON CONFLICT(entry_id) DO UPDATE SET cached_name=excluded.cached_name,cached_roots_json=excluded.cached_roots_json,last_synced_at=excluded.last_synced_at,cached_deleted=0`).run(
          id,
          input.hostId,
          project.projectId,
          project.name,
          JSON.stringify(project.roots),
          nextVersion(old?.last_synced_at),
        );
        return entry(db.prepare("SELECT * FROM remote_project_entries WHERE entry_id=?").get(id)!);
      });
      await changed();
      return result;
    },
    async refreshEntry(input) {
      requireController();
      text.parse(input.entryId);
      z.number().int().nonnegative().nullable().parse(input.expectedLastSyncedAt);
      const project = cacheSchema.parse(input.project);
      const db = await options.database();
      const outcome = write(db, () => {
        // 删除及重新添加改变 entry ID；版本比较阻止迟到响应覆盖新缓存。
        const previous = db
          .prepare(`SELECT * FROM remote_project_entries
          WHERE entry_id=? AND last_synced_at IS ? AND (remote_project_id IS NULL OR remote_project_id=? OR remote_project_id LIKE ?)`)
          .get(
            input.entryId,
            input.expectedLastSyncedAt,
            project.projectId,
            LEGACY_SINGLE_ROOT_PROJECT_PREFIX + "%",
          );
        if (!previous) return { applied: false, changed: false };
        if (
          (previous.remote_project_id == null ||
            String(previous.remote_project_id).startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX)) &&
          db
            .prepare(
              "SELECT 1 FROM remote_project_entries WHERE host_id=? AND remote_project_id=? AND entry_id<>?",
            )
            .get(previous.host_id!, project.projectId, input.entryId)
        ) {
          // 多个旧 cwd 可解析到同一项目；保留已解析 entry ID，删除当前通过 CAS 的旧入口。
          db.prepare("DELETE FROM remote_project_entries WHERE entry_id=?").run(input.entryId);
          return { applied: true, changed: true };
        }
        const roots = JSON.stringify(project.roots);
        const deleted = project.deleted ? 1 : 0;
        db.prepare(
          `UPDATE remote_project_entries SET remote_project_id=?,cached_name=?,cached_roots_json=?,cached_deleted=?,last_synced_at=? WHERE entry_id=?`,
        ).run(
          project.projectId,
          project.name,
          roots,
          deleted,
          nextVersion(input.expectedLastSyncedAt),
          input.entryId,
        );
        return {
          applied: true,
          changed:
            previous.remote_project_id !== project.projectId ||
            previous.cached_name !== project.name ||
            previous.cached_roots_json !== roots ||
            Number(previous.cached_deleted) !== deleted,
        };
      });
      // 不变内容仍消费版本，但不广播，避免刷新回读形成反馈循环。
      if (outcome.changed) await changed();
      return outcome.applied;
    },
    async removeEntry(id) {
      requireController();
      text.parse(id);
      const affected = (await options.database())
        .prepare("DELETE FROM remote_project_entries WHERE entry_id=?")
        .run(id).changes;
      if (affected) await changed();
    },
  };
  return service;
}
