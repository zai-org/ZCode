import { z } from "zod";
import type { RemoteTarget } from "#src/remoteTarget.js";
import { publicZCodeErrorCodeSchema } from "./errorCodes.js";
import { REMOTE_ASSET_INSTALL_MODES } from "../remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "../remoteResourcePackages.js";
import { wslUserSchema } from "../wslUserValidation.js";
import { serverRemoteWorkspaceInfoSchema } from "../server-remote.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const credentialKeySchema = nonEmptyStringSchema;
const timestampSchema = z.number().int().nonnegative();

export const sourceServerTransportKindSchema = z.enum(["ssh", "wsl", "docker"]);
export type SourceServerTransportKind = z.infer<typeof sourceServerTransportKindSchema>;

export const sshProfileTargetSchema = z
  .object({
    kind: z.literal("ssh"),
    host: nonEmptyStringSchema,
    port: z.number().int().positive().max(65_535).optional(),
    username: nonEmptyStringSchema,
    sshConfigAlias: nonEmptyStringSchema.optional(),
    privateKeyPath: z.string().optional(),
    assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
    resourcePackages: z
      .object({
        selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
      })
      .strict()
      .optional(),
    passwordCredentialKey: credentialKeySchema.optional(),
    privateKeyPassphraseCredentialKey: credentialKeySchema.optional(),
  })
  .strict();

export const wslProfileTargetSchema = z
  .object({
    kind: z.literal("wsl"),
    distro: z.string().optional(),
    user: wslUserSchema.optional(),
  })
  .strict();

export const dockerProfileTargetSchema = z
  .object({
    kind: z.literal("docker"),
    container: nonEmptyStringSchema,
  })
  .strict();

export const sourceServerProfileTargetSchema = z.discriminatedUnion("kind", [
  sshProfileTargetSchema,
  wslProfileTargetSchema,
  dockerProfileTargetSchema,
]);

export type SSHProfileTarget = z.infer<typeof sshProfileTargetSchema>;
export type WSLProfileTarget = z.infer<typeof wslProfileTargetSchema>;
export type DockerProfileTarget = z.infer<typeof dockerProfileTargetSchema>;
export type SourceServerProfileTarget = z.infer<typeof sourceServerProfileTargetSchema>;

/** 升级授权只绑定执行身份，不携带凭据或可变 Profile 内容。 */
export const sourceServerUpdateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: nonEmptyStringSchema.toLowerCase(),
      port: z.number().int().positive().max(65_535).default(22),
      username: nonEmptyStringSchema,
      sshConfigAlias: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wsl"),
      distro: nonEmptyStringSchema,
      user: wslUserSchema.refine((value) => value.length > 0),
    })
    .strict(),
  dockerProfileTargetSchema,
]);
export type SourceServerUpdateTarget = z.infer<typeof sourceServerUpdateTargetSchema>;

export function getSourceServerUpdateTarget(
  target: Exclude<RemoteTarget, { kind: "server" }>,
): SourceServerUpdateTarget {
  switch (target.kind) {
    case "ssh":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      });
    case "wsl":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        distro: target.distro,
        user: target.user,
      });
    case "docker":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        container: target.container,
      });
  }
}

export function isSameSourceServerUpdateTarget(
  left: Exclude<RemoteTarget, { kind: "server" }>,
  right: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (
    [left, right].some(
      (target) => target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim()),
    )
  )
    return false;
  return (
    JSON.stringify(getSourceServerUpdateTarget(left)) ===
    JSON.stringify(getSourceServerUpdateTarget(right))
  );
}

export const sourceServerUpdateRequestSchema = z
  .object({
    profileId: nonEmptyStringSchema,
    force: z.boolean().optional(),
    /** 用户已确认把较新的远端切换到本机 Desktop 版本；方向由远端 CLI 判定。 */
    allowDowngrade: z.boolean().optional(),
    expectedTarget: sourceServerUpdateTargetSchema.optional(),
  })
  .strict();
export type SourceServerUpdateRequest = z.input<typeof sourceServerUpdateRequestSchema>;

/** 取消更新只接收线路身份；是否处于可取消的本机阶段由 Host 判断（R3 §6.3）。 */
export const sourceServerUpdateCancelProfileIdSchema = z.string().uuid();

/**
 * 设备级生命周期操作（停止、重启远端服务，RDLC-01）只接收设备身份；具体走哪条连接由 Host 路由，
 * Renderer 不传 profileId。
 */
export const sourceServerLifecycleSourceIdSchema = z.string().uuid();

const connectionProfileBaseShape = {
  profileId: z.string().uuid(),
  sourceServerId: z.string().uuid().optional(),
  displayName: nonEmptyStringSchema.optional(),
  lastConnectedAt: timestampSchema.optional(),
  lastConnectError: z.string().optional(),
  createdAt: timestampSchema,
  lifecycleState: z.enum(["active", "retired"]).default("active"),
  retiredReason: z.literal("source-reinstalled").optional(),
  retiredAt: timestampSchema.optional(),
};

export const connectionProfileSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("ssh"),
      target: sshProfileTargetSchema,
    })
    .strict(),
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("wsl"),
      target: wslProfileTargetSchema,
    })
    .strict(),
  z
    .object({
      ...connectionProfileBaseShape,
      transport: z.literal("docker"),
      target: dockerProfileTargetSchema,
    })
    .strict(),
]);

export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

export const sourceServerRecordSchema = z
  .object({
    sourceServerId: z.string().uuid(),
    displayName: nonEmptyStringSchema,
    osUser: nonEmptyStringSchema.optional(),
    hostname: nonEmptyStringSchema.optional(),
    lastSeenVersion: nonEmptyStringSchema.optional(),
    lastOnlineAt: timestampSchema.optional(),
    preferredProfileId: z.string().uuid().optional(),
    installState: z.enum(["installed", "uninstalled"]).default("installed"),
    declaredWorkspaces: z
      .array(
        z
          .object({
            workspacePath: nonEmptyStringSchema,
            workspaceIdentity: nonEmptyStringSchema,
            label: nonEmptyStringSchema.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type SourceServerRecord = z.infer<typeof sourceServerRecordSchema>;

export const sourceServerWorkspaceHistoryEntrySchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    legacyWorkspaceIdentity: nonEmptyStringSchema.optional(),
    profileId: z.string().uuid(),
    sourceServerId: z.string().uuid().optional(),
    lastOpenedAt: timestampSchema,
  })
  .strict();

export type SourceServerWorkspaceHistoryEntry = z.infer<
  typeof sourceServerWorkspaceHistoryEntrySchema
>;

export const sourceServerMigrationConflictSchema = z
  .object({
    kind: z.enum(["task-identity", "config-file"]),
    key: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema.optional(),
    relativePath: nonEmptyStringSchema.optional(),
    sourceKey: nonEmptyStringSchema,
    canonicalKey: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
  })
  .strict();
export type SourceServerMigrationConflict = z.infer<typeof sourceServerMigrationConflictSchema>;

export const sourceServerMigrationReportRowSchema = z
  .object({
    migrationId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    canonicalKey: nonEmptyStringSchema,
    variantKeys: z.array(nonEmptyStringSchema),
    status: z.enum(["running", "completed", "failed", "abandoned", "abandoned-diverged"]),
    phase: nonEmptyStringSchema.optional(),
    errorCode: nonEmptyStringSchema.optional(),
    taskBackupPath: nonEmptyStringSchema.optional(),
    sessionBackupPath: nonEmptyStringSchema.optional(),
    updatedAt: timestampSchema,
    abandonedAt: timestampSchema.optional(),
    abandonedTrigger: nonEmptyStringSchema.optional(),
    conflicts: z.array(sourceServerMigrationConflictSchema),
  })
  .strict();
export type SourceServerMigrationReportRow = z.infer<typeof sourceServerMigrationReportRowSchema>;

export const sourceServerMigrationReportSchema = z
  .object({ rows: z.array(sourceServerMigrationReportRowSchema) })
  .strict();
export type SourceServerMigrationReport = z.infer<typeof sourceServerMigrationReportSchema>;

export const sourceServerMigrationPathActionSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    migrationId: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerMigrationPathAction = z.infer<typeof sourceServerMigrationPathActionSchema>;

export const sourceServerResolveWorkspaceRequestSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    legacyRouteHint: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceRequest = z.infer<
  typeof sourceServerResolveWorkspaceRequestSchema
>;

export const sourceServerResolveWorkspaceResultSchema = z
  .object({
    canonicalWorkspaceKey: nonEmptyStringSchema,
    mergedKeys: z.array(nonEmptyStringSchema),
    migrationId: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceResult = z.infer<
  typeof sourceServerResolveWorkspaceResultSchema
>;

export const sourceServerConnectionStateSchema = z.enum([
  "absent",
  "bootstrapping",
  "needs-install",
  "needs-upgrade",
  "updating",
  "online",
  "retrying",
  "offline",
  "identity-change-pending",
  "failed",
]);
export type SourceServerConnectionState = z.infer<typeof sourceServerConnectionStateSchema>;

/** 远端任务 owner 的活动投影；身份用于隔离，实际路径仅用于展示。 */
export const sourceServerRunningTaskSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerRunningTask = z.infer<typeof sourceServerRunningTaskSchema>;
export const sourceServerRunningTasksSchema = z.array(sourceServerRunningTaskSchema);

/**
 * 停止 / 重启远端服务确认前按设备读取的运行中任务（RDLC-01）。`available: false` 表示设备没有提供
 * 可信清单（远端输出 null、命令失败或输出不符 schema），不能当作“没有任务”；空数组才是没有任务。
 */
export const sourceServerRunningTasksResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), tasks: sourceServerRunningTasksSchema }).strict(),
  z.object({ available: z.literal(false) }).strict(),
]);
export type SourceServerRunningTasksResult = z.infer<typeof sourceServerRunningTasksResultSchema>;

/** 只读安装预览；sizeBytes 是安装包实际大小，不代表解压后的磁盘占用。 */
export const sourceServerInstallPreviewSchema = z
  .object({
    version: nonEmptyStringSchema,
    installPath: nonEmptyStringSchema.optional(),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type SourceServerInstallPreview = z.infer<typeof sourceServerInstallPreviewSchema>;

export const sourceServerConnectionStateSnapshotSchema = z
  .object({
    profileId: z.string().uuid(),
    sourceServerId: z.string().uuid().optional(),
    state: sourceServerConnectionStateSchema,
    error: z.string().optional(),
    updateAvailability: z.enum(["none", "available", "required"]).optional(),
    currentVersion: nonEmptyStringSchema.optional(),
    availableVersion: nonEmptyStringSchema.optional(),
    minimumVersion: nonEmptyStringSchema.optional(),
    upgradeTarget: z.enum(["controller", "server"]).optional(),
    /** 远端当前 release 由显式降级安装时，被替换的版本；向导据此不自动升级。 */
    downgradedFrom: nonEmptyStringSchema.optional(),
    /** 更新处于本机阶段（probe、release 解析与本机下载），`cancelSourceUpdate` 可取消（R3 §6.3）。 */
    updateCancelable: z.literal(true).optional(),
    errorCode: publicZCodeErrorCodeSchema.optional(),
    retryable: z.boolean().optional(),
    installPreview: sourceServerInstallPreviewSchema.optional(),
    runningTasks: sourceServerRunningTasksSchema.optional(),
    pendingSourceServerId: z.string().uuid().optional(),
    recoveryAttempt: z.number().int().positive().optional(),
    recoveryLimit: z.number().int().positive().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    updatedAt: timestampSchema,
  })
  .strict();
export type SourceServerConnectionStateSnapshot = z.infer<
  typeof sourceServerConnectionStateSnapshotSchema
>;

export const sourceServerManagementSnapshotRequestSchema = z
  .object({
    refreshMigrationCounts: z.boolean().optional(),
  })
  .strict();
export type SourceServerManagementSnapshotRequest = z.infer<
  typeof sourceServerManagementSnapshotRequestSchema
>;

export const sourceServerManagementSnapshotSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    profiles: z.array(connectionProfileSchema),
    servers: z.array(sourceServerRecordSchema),
    workspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema),
    states: z.array(sourceServerConnectionStateSnapshotSchema),
    failedPathCount: z.number().int().nonnegative(),
    abandonedPathCount: z.number().int().nonnegative(),
    migrationCounts: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            sourceServerId: nonEmptyStringSchema,
            status: z.literal("available"),
            failedPathCount: z.number().int().nonnegative(),
            abandonedPathCount: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({
            sourceServerId: nonEmptyStringSchema,
            status: z.literal("requires-connection"),
          })
          .strict(),
        z.object({ sourceServerId: nonEmptyStringSchema, status: z.literal("loading") }).strict(),
        z
          .object({ sourceServerId: nonEmptyStringSchema, status: z.literal("unavailable") })
          .strict(),
      ]),
    ),
  })
  .strict();
export type SourceServerManagementSnapshot = z.infer<typeof sourceServerManagementSnapshotSchema>;

export const sourceServerManagementStateDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
    state: sourceServerConnectionStateSnapshotSchema,
  })
  .strict();
export type SourceServerManagementStateDelta = z.infer<
  typeof sourceServerManagementStateDeltaSchema
>;

export const sourceServerManagementDirectoryDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
  })
  .strict();
export type SourceServerManagementDirectoryDelta = z.infer<
  typeof sourceServerManagementDirectoryDeltaSchema
>;

/** Server CLI 的可选逐行进度；终态仍由退出码和最后一行结果决定。 */
export const sourceServerInstallProgressSchema = z
  .object({
    type: z.literal("source-server-install-progress"),
    phase: z.enum(["verify-archive", "extract", "verify", "restart"]),
  })
  .strict();
export type SourceServerInstallProgress = z.infer<typeof sourceServerInstallProgressSchema>;

export const sourceServerOperationLogSchema = z
  .object({
    profileId: z.string().uuid(),
    operation: z.enum(["connect", "update", "stop", "restart"]),
    phase: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    progress: z.number().min(0).max(1).optional(),
    timestamp: timestampSchema,
  })
  .strict();
export type SourceServerOperationLog = z.infer<typeof sourceServerOperationLogSchema>;

export type SourceServerDeclaredWorkspaceWire = z.infer<typeof serverRemoteWorkspaceInfoSchema>;
