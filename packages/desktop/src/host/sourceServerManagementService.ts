import { createSourceServerMigrationCounts } from "./sourceServerMigrationCounts.js";
import { Emitter, type Event } from "@zcode/rpc";
import {
  sourceServerManagementSnapshotSchema,
  sourceServerLifecycleSourceIdSchema,
  sourceServerRunningTasksResultSchema,
  sourceServerUpdateCancelProfileIdSchema,
  sourceServerUpdateRequestSchema,
  isSameSourceServerUpdateTarget,
  sourceServerManagementSnapshotRequestSchema,
  type SourceServerManagementSnapshotRequest,
  sourceServerManagementDirectoryDeltaSchema,
  sourceServerManagementStateDeltaSchema,
  sourceServerOperationLogSchema,
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
  type SourceServerConnectionStateSnapshot,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerManagementDirectoryDelta,
  type SourceServerManagementSnapshot,
  type SourceServerManagementStateDelta,
  type SourceServerOperationLog,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
import type {
  SourceServerDirectorySnapshot,
  SourceServerReconnectCandidate,
} from "./sourceServerDirectory.js";
import type {
  ManagedSourceServerConnection,
  SourceServerConnectionManagerOptions,
  ConnectSourceServerOptions,
} from "./sourceServerConnectionManager.js";
import type { ISourceServerManagementService, UpdateConnectionProfileInput } from "@zcode/services";

interface SourceServerManagementDirectory {
  readonly onDidChange?: Event<void>;
  snapshot(): Promise<SourceServerDirectorySnapshot>;
  resolveProfileTarget(
    profileOrId: string | ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }>>;
  resolveSourceLifecycleRoute(sourceServerId: string): Promise<SourceServerReconnectCandidate>;
  renameSource(sourceServerId: string, displayName: string): Promise<void>;
  renameProfile(profileId: string, displayName: string): Promise<void>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<void>;
  setPreferredProfile(sourceServerId: string, profileId: string): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  removeSourceServer(sourceServerId: string): Promise<void>;
  recordConversationWorkspace?(sourceServerId: string, workspacePath: string): Promise<void>;
}

interface SourceServerManagementManager {
  listStates(): SourceServerConnectionStateSnapshot[];
  onDidAppendOperationLog: Event<SourceServerOperationLog>;
  getRecentOperationLogs(
    profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">,
  ): SourceServerOperationLog[];
  onDidChangeState: Event<SourceServerConnectionStateSnapshot>;
  getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined;
  connect(input: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    confirmIdentityChange?: boolean;
    membershipIntent?: "add" | "retain";
    context?: ConnectSourceServerOptions["context"];
  }): Promise<ManagedSourceServerConnection>;
  updateServer(input: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    allowDowngrade?: boolean;
    resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
    context?: {
      onLog?: (event: { phase: string; message: string; progress?: number }) => void;
    };
  }): Promise<ManagedSourceServerConnection>;
  cancelUpdate(profileId: string): boolean;
  stopSource(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceServerReconnectCandidate>;
  }): Promise<void>;
  restartSource(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceServerReconnectCandidate>;
  }): Promise<ManagedSourceServerConnection>;
  getSourceRunningTasks(input: {
    sourceServerId: string;
    resolveOfflineRoute: () => Promise<SourceServerReconnectCandidate>;
  }): Promise<SourceServerRunningTasksResult>;
  disconnect(sourceServerId: string): void;
  removeProfile(profileId: string): void;
}

export interface SourceServerManagementService extends ISourceServerManagementService {
  dispose(): void;
}

export function createSourceServerManagementService(options: {
  directory: SourceServerManagementDirectory;
  manager: SourceServerManagementManager;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  onDirectorySnapshot?: (snapshot: SourceServerDirectorySnapshot) => void;
  onBeforeSourceServerRemoved?: (sourceServerId: string) => Promise<void>;
  /** 归还未识别线路的本机成员预留；profiles 为操作完成后的线路集合。 */
  releaseUnboundProfileHost?: (
    profile: ConnectionProfile,
    profiles: readonly ConnectionProfile[],
  ) => Promise<void>;
  onConnectionLog?: NonNullable<ConnectSourceServerOptions["context"]>["onLog"];
  now?: () => number;
}): SourceServerManagementService {
  let generation = 0;
  let disposed = false;
  const stateEmitter = new Emitter<SourceServerManagementStateDelta>();
  const directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
  const operationLogEmitter = new Emitter<SourceServerOperationLog>();
  const operationLogSubscription = options.manager.onDidAppendOperationLog?.((entry) => {
    operationLogEmitter.fire(sourceServerOperationLogSchema.parse(entry));
  });
  const migrationCounts = createSourceServerMigrationCounts({
    getOnlineConnection: (id) => options.manager.getOnlineConnection(id),
    onDidChange: publishDirectoryChange,
  });
  function publishDirectoryChange() {
    if (disposed) return;
    generation += 1;
    directoryEmitter.fire(sourceServerManagementDirectoryDeltaSchema.parse({ generation }));
  }
  const stateSubscription = options.manager.onDidChangeState((state) => {
    if (state.sourceServerId) migrationCounts.invalidate(state.sourceServerId);
    generation += 1;
    stateEmitter.fire(sourceServerManagementStateDeltaSchema.parse({ generation, state }));
  });
  const directorySubscription = options.directory.onDidChange?.(() => {
    migrationCounts.invalidate();
    publishDirectoryChange();
  });

  async function getSnapshot(
    input?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot> {
    if (
      sourceServerManagementSnapshotRequestSchema.parse(input === undefined ? {} : input)
        .refreshMigrationCounts
    ) {
      migrationCounts.invalidate();
    }
    for (;;) {
      const startGeneration = generation;
      const directory = await options.directory.snapshot();
      options.onDirectorySnapshot?.(directory);
      const counts = migrationCounts.read(directory);
      const states = options.manager.listStates();
      const endGeneration = generation;
      if (startGeneration !== endGeneration) continue;
      return sourceServerManagementSnapshotSchema.parse({
        generation: endGeneration,
        ...directory,
        states,
        ...counts,
      });
    }
  }

  async function readProfile(profileId: string) {
    const directory = await options.directory.snapshot();
    const profile = directory.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error(`Unknown Connection Profile: ${profileId}`);
    return profile;
  }

  function migrationService(sourceServerId: string) {
    const connection = options.manager.getOnlineConnection(sourceServerId);
    if (!connection) throw new Error(`Source Server must be connected: ${sourceServerId}`);
    return connection.services.sourceServerWorkspaceService;
  }

  return {
    onDidChangeState: stateEmitter.event,
    onDidChangeDirectory: directoryEmitter.event,
    onDidAppendOperationLog: operationLogEmitter.event,
    getSnapshot,
    async getRecentOperationLogs(profileId) {
      const profile = await readProfile(profileId);
      return options.manager
        .getRecentOperationLogs(profile)
        .map((entry) => sourceServerOperationLogSchema.parse(entry));
    },
    async connectProfile(profileId, connectOptions) {
      const [profile, target] = await Promise.all([
        readProfile(profileId),
        options.directory.resolveProfileTarget(profileId),
      ]);
      try {
        await options.manager.connect({
          profile,
          target,
          ...(connectOptions?.retainedOnly ? { membershipIntent: "retain" as const } : {}),
          // 项目入口经管理服务连接时也必须传递真实传输进度；不能只在 workspace 入口接线。
          ...(options.onConnectionLog ? { context: { onLog: options.onConnectionLog } } : {}),
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "source-server-identity-change-pending"
        ) {
          throw error;
        }
      }
      return await getSnapshot();
    },
    async confirmIdentityChange(profileId) {
      const [profile, target] = await Promise.all([
        readProfile(profileId),
        options.directory.resolveProfileTarget(profileId),
      ]);
      await options.manager.connect({
        profile,
        target,
        confirmIdentityChange: true,
        ...(options.onConnectionLog ? { context: { onLog: options.onConnectionLog } } : {}),
      });
      return await getSnapshot();
    },
    async disconnectSource(sourceServerId) {
      options.manager.disconnect(sourceServerId);
      return await getSnapshot();
    },
    async ensureConversationWorkspace(sourceServerId) {
      const connection = options.manager.getOnlineConnection(sourceServerId);
      if (!connection) {
        throw new Error(`Source Server must be connected: ${sourceServerId}`);
      }
      // 旧实现复用 default cwd，导致全局新建会话共享目录；统一由远端 Host 分配独立目录。
      const projects = connection.services.projectService;
      if (!projects) throw new Error("project.service-unavailable");
      const prepared = await projects.prepareSession();
      const result = {
        path: prepared.workspacePath,
        created: true,
        workspacePurpose: "conversation" as const,
      };
      await options.directory.recordConversationWorkspace?.(sourceServerId, result.path);
      return result;
    },
    async updateSource(input) {
      const { profileId, expectedTarget, force, allowDowngrade } =
        sourceServerUpdateRequestSchema.parse(input);
      const profile = await readProfile(profileId);
      // Profile ID 可原位改址；在读取凭据前核验失败身份，再从同一 Profile 固定执行目标。
      // force 确认后的请求也必须经过此边界，不能把旧授权用于另一设备/账户。
      const assertTarget = (target: Exclude<RemoteTarget, { kind: "server" }>) => {
        if (expectedTarget && !isSameSourceServerUpdateTarget(target, expectedTarget)) {
          throw Object.assign(new Error("Connection target changed; retry the connection"), {
            code: "remote-target-changed",
          });
        }
      };
      assertTarget(profile.target);
      const target = await options.directory.resolveProfileTarget(profile);
      assertTarget(target);
      await options.manager.updateServer({
        profile,
        target,
        force,
        allowDowngrade,
        resolveRelease: options.resolveRelease,
      });
      return await getSnapshot();
    },
    async cancelSourceUpdate(profileId) {
      return {
        canceled: options.manager.cancelUpdate(
          sourceServerUpdateCancelProfileIdSchema.parse(profileId),
        ),
      };
    },
    async stopSource(input) {
      const sourceServerId = sourceServerLifecycleSourceIdSchema.parse(input);
      await options.manager.stopSource({
        sourceServerId,
        resolveOfflineRoute: () => options.directory.resolveSourceLifecycleRoute(sourceServerId),
      });
      return await getSnapshot();
    },
    async restartSource(input) {
      const sourceServerId = sourceServerLifecycleSourceIdSchema.parse(input);
      await options.manager.restartSource({
        sourceServerId,
        resolveOfflineRoute: () => options.directory.resolveSourceLifecycleRoute(sourceServerId),
      });
      return await getSnapshot();
    },
    async getSourceRunningTasks(input) {
      const sourceServerId = sourceServerLifecycleSourceIdSchema.parse(input);
      return sourceServerRunningTasksResultSchema.parse(
        await options.manager.getSourceRunningTasks({
          sourceServerId,
          resolveOfflineRoute: () => options.directory.resolveSourceLifecycleRoute(sourceServerId),
        }),
      );
    },
    async renameSource(sourceServerId, displayName) {
      await options.directory.renameSource(sourceServerId, displayName);
      return await getSnapshot();
    },
    async renameProfile(profileId, displayName) {
      await options.directory.renameProfile(profileId, displayName);
      return await getSnapshot();
    },
    async updateProfile(input) {
      const previous = (await options.directory.snapshot()).profiles.find(
        (profile) => profile.profileId === input.profileId,
      );
      await options.directory.updateProfile(input);
      // Bug 原因：未识别线路改址后，旧地址的 admission 预留无人释放，成为侧栏持续读取失败的孤儿行。
      if (previous)
        await options.releaseUnboundProfileHost?.(
          previous,
          (await options.directory.snapshot()).profiles,
        );
      return await getSnapshot();
    },
    async setPreferredProfile(sourceServerId, profileId) {
      await options.directory.setPreferredProfile(sourceServerId, profileId);
      return await getSnapshot();
    },
    async removeProfile(profileId) {
      const { profiles } = await options.directory.snapshot();
      const removed = profiles.find((profile) => profile.profileId === profileId);
      // Bug 原因：首次连接在 probe 前按地址写入 hosts 预留行，握手成功才改名为设备行；删除未完成
      // 连接只改 settings，预留行成为孤儿，侧栏每次刷新都对它 readTree 并持续报 host-offline。
      // 与 removeSourceServer 同序先释放本机成员；settings 删除失败时线路保留，下次 add 连接重建预留。
      if (removed)
        await options.releaseUnboundProfileHost?.(
          removed,
          profiles.filter((profile) => profile.profileId !== profileId),
        );
      await options.directory.removeProfile(profileId);
      options.manager.removeProfile(profileId);
      return await getSnapshot();
    },
    async removeSourceServer(sourceServerId) {
      const before = await options.directory.snapshot();
      const exists =
        before.servers.some((server) => server.sourceServerId === sourceServerId) ||
        before.profiles.some((profile) => profile.sourceServerId === sourceServerId) ||
        before.workspaceHistory.some((entry) => entry.sourceServerId === sourceServerId);
      if (!exists) return await getSnapshot();
      if (!options.onBeforeSourceServerRemoved) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
          "Source Server removal requires the Host attachment cleanup callback",
        );
      }
      // Bug 根因：只删 Directory 记录会遗留运行中连接和 Source Settings attachment。
      // 删除必须先释放运行态，再由 Host 清理 attachment，最后提交本地持久化事务。
      options.manager.disconnect(sourceServerId);
      try {
        await options.onBeforeSourceServerRemoved(sourceServerId);
      } catch (error) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        await options.directory.removeSourceServer(sourceServerId);
      } catch (error) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        );
      }
      for (const profile of before.profiles) {
        if (profile.sourceServerId === sourceServerId)
          options.manager.removeProfile(profile.profileId);
      }
      return await getSnapshot();
    },
    async getMigrationReport(sourceServerId) {
      return await migrationService(sourceServerId).listMigrationReports();
    },
    async exportMigrationReport(sourceServerId) {
      return `${JSON.stringify(await migrationService(sourceServerId).listMigrationReports(), null, 2)}\n`;
    },
    async abandonWorkspaceMigration(sourceServerId, workspacePath, migrationId) {
      try {
        return await migrationService(sourceServerId).abandonFailedWorkspace({
          workspacePath,
          migrationId,
        });
      } finally {
        migrationCounts.invalidate(sourceServerId);
        publishDirectoryChange();
      }
    },
    async retryWorkspaceMigration(sourceServerId, workspacePath, migrationId) {
      try {
        return await migrationService(sourceServerId).retryWorkspaceMigration({
          workspacePath,
          migrationId,
        });
      } finally {
        migrationCounts.invalidate(sourceServerId);
        publishDirectoryChange();
      }
    },
    dispose() {
      disposed = true;
      migrationCounts.dispose();
      stateSubscription.dispose();
      directorySubscription?.dispose();
      stateEmitter.dispose();
      directoryEmitter.dispose();
      operationLogSubscription?.dispose();
      operationLogEmitter.dispose();
    },
  };
}

class SourceServerRemovalError extends Error {
  public readonly retryable = true;

  public constructor(
    public readonly code:
      | typeof SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE
      | typeof SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE
      | typeof SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
    message: string,
  ) {
    super(message);
    this.name = "SourceServerRemovalError";
  }
}
