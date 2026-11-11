import { sourceServerRunningTasksSchema, type SourceServerRunningTask } from "@zcode/shared";
import { z } from "zod";

export const SERVER_CLI_PROTOCOL_VERSION = 1;
export const SERVER_CREDENTIAL_FORMAT = 2;
export const SERVER_CREDENTIAL_FORMAT_ENV = "ZCODE_SERVER_CREDENTIAL_FORMAT";
export const SERVER_RUNTIME_NODE_VERSION = "22.16.0";
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

// Supervisor 停止/更新链路的时间预算唯一来源；等待 Supervisor 的调用方必须由这里推导，不能各自写死。
export const CORE_STOP_GRACE_TIMEOUT_MS = 5_000;
// Bug 原因：SIGKILL 只会被不可中断等待推迟，Rosetta + swap 的远端按事故时序推算回收约 3.5～5.4 秒；旧的
// 2 秒等待把必然结束的退出误判为 stop-failed，导致 update 失败并让 Supervisor 卡住锁。
export const CORE_KILL_TIMEOUT_MS = 10_000;
export const CORE_READY_TIMEOUT_MS = 15_000;
export const CONTROL_CLOSE_TIMEOUT_MS = 2_000;
// stop 等待方需要覆盖宽限 + 强杀等待 + control socket 关闭，另留状态落盘和锁释放余量。
export const SERVER_STOP_WAIT_TIMEOUT_MS =
  CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS + CONTROL_CLOSE_TIMEOUT_MS + 3_000;
// serve --daemon 等待方需要覆盖 Supervisor 冷启动（进程拉起、模块加载、取锁、启动恢复、control 监听）
// 与 Core ready 预算。Bug 原因：旧的 10 秒写死上限短于 Supervisor 自身的 15 秒 Core ready 预算；机器繁忙时
// Supervisor 冷启动实测可达 8～14 秒，CLI 先报 "Timed out waiting for Server ready"，daemon 随后照常 ready。
export const SERVER_READY_WAIT_TIMEOUT_MS = CORE_READY_TIMEOUT_MS + 10_000;
// Core heartbeat 周期：Core 发送方与 Supervisor 活性检查共用（R2 §4.2 Core 活性）。
export const CORE_HEARTBEAT_INTERVAL_MS = 10_000;
// ready 的 Core 连续这么多个 heartbeat 周期没有任何 IPC 消息，Supervisor 判定其事件循环卡死。
export const CORE_UNRESPONSIVE_HEARTBEAT_PERIODS = 6;

export const lifecycleStateSchema = z.enum([
  "starting",
  "ready",
  "stopping",
  "stop-failed",
  "stopped",
  "crashed",
  "crash-loop-stopped",
  "updating",
  "uninstalling",
  "uninstalled",
]);

export const crashBudgetSchema = z.object({
  windowStartedAt: z.number().int().nonnegative().optional(),
  crashCount: z.number().int().nonnegative(),
  nextRestartDelayMs: z.number().int().nonnegative(),
  exhausted: z.boolean(),
});

export const serverStatusSchema = z
  .object({
    protocolVersion: z.literal(SERVER_CLI_PROTOCOL_VERSION).default(SERVER_CLI_PROTOCOL_VERSION),
    state: lifecycleStateSchema,
    pid: z.number().int().positive().nullable(),
    port: z.number().int().nonnegative().nullable(),
    host: z.string().min(1).nullable(),
    version: z.string().min(1),
    generation: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().nullable().default(null),
    lastExitReason: z.string().max(500).nullable().default(null),
    serviceRegistered: z.boolean(),
    runningTaskCount: z.number().int().nonnegative(),
    crashBudget: crashBudgetSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type CrashBudgetSnapshot = z.infer<typeof crashBudgetSchema>;
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const runtimeIdentitySchema = z
  .object({
    supervisorVersion: z.string().min(1),
    supervisorReleaseId: z.string().min(1).optional(),
    activeReleaseVersion: z.string().min(1).optional(),
    activeReleaseId: z.string().min(1).optional(),
    coreVersion: z.string().min(1).optional(),
    coreReleaseId: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export const updatePreparationResultSchema = z
  .object({
    status: z.enum(["ready", "blocked"]),
    runningTaskCount: z.number().int().nonnegative(),
  })
  .strict();
export type UpdatePreparationResult = z.infer<typeof updatePreparationResultSchema>;

export function createStoppedServerStatus(
  version: string,
  options: { serviceRegistered?: boolean; now?: number } = {},
): ServerStatus {
  return serverStatusSchema.parse({
    protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
    state: "stopped",
    pid: null,
    port: null,
    host: null,
    version,
    generation: 0,
    startedAt: null,
    lastExitReason: null,
    serviceRegistered: options.serviceRegistered ?? false,
    runningTaskCount: 0,
    crashBudget: {
      crashCount: 0,
      nextRestartDelayMs: CRASH_BACKOFF_MS[0],
      exhausted: false,
    },
    updatedAt: options.now ?? Date.now(),
  });
}

const requestBase = z.object({ id: z.string().trim().min(1).max(128) });
export const controlRequestSchema = z.discriminatedUnion("command", [
  requestBase.extend({ command: z.literal("ping") }),
  requestBase.extend({ command: z.literal("status") }),
  requestBase.extend({ command: z.literal("running-tasks") }),
  requestBase.extend({ command: z.literal("stop") }),
  requestBase.extend({ command: z.literal("runtime-identity") }),
  requestBase.extend({ command: z.literal("prepare-update") }),
  requestBase.extend({ command: z.literal("apply-update"), force: z.boolean().optional() }),
  requestBase.extend({ command: z.literal("prepare-uninstall") }),
  requestBase.extend({ command: z.literal("confirm-uninstall"), confirmation: z.string() }),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;

export const controlResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ControlResponse = z.infer<typeof controlResponseSchema>;

const runningTasksSchema = z.custom<SourceServerRunningTask[]>(
  (value) => sourceServerRunningTasksSchema.safeParse(value).success,
);

export const coreMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    host: z.string().min(1),
    port: z.number().int().positive(),
    version: z.string().min(1),
    releaseId: z.string().min(1).optional(),
    generation: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    runningTasks: runningTasksSchema.optional(),
    at: z.number().int().nonnegative(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task-activity"),
    runningTasks: runningTasksSchema.optional(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("shutdown-ack") }),
  z.object({ type: z.literal("fatal"), message: z.string().max(500) }),
  z.object({ type: z.literal("exit"), reason: z.string().max(500) }),
]);
export type CoreMessage = z.infer<typeof coreMessageSchema>;

export const coreCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("shutdown") }),
]);
export type CoreCommand = z.infer<typeof coreCommandSchema>;

export const releaseManifestSchema = z
  .object({
    // version 会参与 releases/<version>-<target>-<sha> 路径拼接，不能允许 `/`、`\` 或 `..` 穿越 data root。
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    releaseDir: z.string().trim().min(1),
    nodeVersion: z.string().trim().min(1).optional(),
    releaseId: z.string().trim().min(1).optional(),
    appVersion: z.string().trim().min(1).optional(),
    target: z.string().trim().min(1).optional(),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            paths: z.array(z.string().trim().min(1)).min(1),
            sizeBytes: z.number().int().nonnegative(),
            archivePath: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const releaseCatalogEntrySchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    appVersion: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)
      .optional(),
    target: z.string().trim().min(1),
    archiveUrl: z.string().url(),
    manifestUrl: z.string().url().optional(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            sizeBytes: z.number().int().nonnegative(),
            archiveUrl: z.string().url().optional(),
            archiveSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/i)
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const releaseCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    releases: z.array(releaseCatalogEntrySchema),
  })
  .strict();
export type ReleaseCatalogEntry = z.infer<typeof releaseCatalogEntrySchema>;
export type ReleaseCatalog = z.infer<typeof releaseCatalogSchema>;
