import { z } from "zod";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- automation 仓库集中维护 automations / automation_runs 的 sqlite schema、
   调度状态机写入与运行历史，稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  resolveWorkspaceKey,
  zcodeAutomationBotDeliveryTargetSchema,
  modelSelectionSchema,
  zcodeTaskModeSchema,
  type ZCodeAutomation,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeAutomationCreateParams,
  type ZCodeAutomationDispatchStatus,
  type ZCodeAutomationLifecycleStatus,
  type ModelSelection,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** 在调用方的归档事务内暂停全部绑定任务，不撤销已认领轮次或改变终态。 */
export function pauseAutomationsForArchivedTask(
  db: DatabaseSyncInstance,
  workspaceKey: string,
  taskId: string,
): void {
  // 只写归档会留下仍可调度的任务；共用原连接使归档与暂停一起提交或回滚。
  db.prepare(`UPDATE automations SET enabled=0, lifecycle_status='paused', updated_at=?
    WHERE workspace_key=? AND target_task_id=? AND enabled=1 AND lifecycle_status='active'`).run(
    Date.now(),
    workspaceKey,
    taskId,
  );
}

/** 派发失败退避常量。 */
export const DISPATCH_RETRY_BASE_MS = 30_000;
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
export const DISPATCH_MAX_ATTEMPTS = 5;
/** 认领超时回收：running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。 */
export const CLAIM_STALE_MS = 10 * 60_000;

/** 创建总数超过产品上限；错误码会跨 RPC 保留在 message 中供 UI 识别。 */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
    this.name = "AutomationCreateLimitError";
  }
}

interface AutomationRow {
  automation_id: string;
  title: string;
  cron_expr: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  project_id?: string | null;
  host_id?: string | null;
  additional_directories?: string | null;
  target_task_id: string | null;
  bot_delivery_target: string | null;
  location_kind: string;
  recurring: number;
  max_runs: number | null;
  end_at: number | null;
  schedule_rule: string | null;
  schedule_edited_by_user: number;
  run_count: number;
  scheduled_run_count: number;
  enabled: number;
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  claimed_at: number | null;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AutomationRunRow {
  run_id: string;
  automation_id: string;
  workspace_key: string;
  scheduled_at: number | null;
  trigger: string;
  model_selection: string | null;
  dispatch_status: string;
  outcome: string | null;
  session_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

function rowToAutomation(row: AutomationRow): ZCodeAutomation {
  const modelSelection = readAutomationModelSelection(row);
  return {
    automationId: row.automation_id,
    title: row.title,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    ...(modelSelection ? { modelSelection } : {}),
    // 历史版本曾把空字符串写进 mode，旧读取逻辑又直接强转为枚举，导致
    // automation/list 在协议层校验整个数组时被单条脏数据拖垮。历史非法值按未设置兼容。
    mode: normalizeAutomationMode(row.mode),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    ...(row.project_id == null ? {} : { projectId: row.project_id }),
    ...(row.host_id == null ? {} : { hostId: row.host_id }),
    ...(row.additional_directories == null
      ? {}
      : {
          additionalDirectories: z
            .array(z.string().min(1))
            .max(256)
            .parse(JSON.parse(row.additional_directories)),
        }),
    targetTaskId: row.target_task_id ?? undefined,
    locationKind: row.location_kind === "remote" ? "remote" : "local",
    recurring: row.recurring === 1,
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule
      ? (JSON.parse(row.schedule_rule) as ZCodeAutomation["scheduleRule"])
      : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
    runCount: row.run_count,
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status as ZCodeAutomationLifecycleStatus,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    dispatchStatus: row.dispatch_status as ZCodeAutomationDispatchStatus,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readAutomationModelSelection(row: AutomationRow): ZCodeAutomation["modelSelection"] {
  // 旧字段只能经过独立 importer；新字段损坏或明确清空时不能复活旧选择。
  return readSerializedModelSelection(row.model_selection);
}

function serializeAutomationModelSelection(
  selection: ZCodeAutomation["modelSelection"],
): string | null {
  if (!selection) return null;
  const options = selection.options;
  const parsed = modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  });
  return JSON.stringify(parsed);
}

function normalizeAutomationMode(mode: string | null): ZCodeAutomation["mode"] | undefined {
  const parsed = zcodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}

function assertValidAutomationMode(mode: unknown): void {
  if (mode === undefined || mode === null) return;
  if (!zcodeTaskModeSchema.safeParse(mode).success) {
    // 读取兼容历史脏数据不代表允许继续写脏数据；Repo 是绕过 RPC 时的最终持久化边界。
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

function rowToRun(row: AutomationRunRow): ZCodeAutomationRun {
  const modelSelection = readSerializedModelSelection(row.model_selection);
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
    trigger: row.trigger as ZCodeAutomationTrigger,
    ...(modelSelection ? { modelSelection } : {}),
    dispatchStatus: row.dispatch_status as ZCodeAutomationRunDispatchStatus,
    outcome: (row.outcome as ZCodeAutomationRunOutcome | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readSerializedModelSelection(value: string | null): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 退避重试时间：now + min(BASE * 2^(attempts-1), CAP)。 */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}

/**
 * automation 存储仓库：automations（定义 + 调度状态）与 automation_runs（运行历史 + runId 幂等台账），
 * 与 task index 同库 tasks-index.sqlite（WAL、多进程安全）。
 *
 * 仓库只做存储与原子状态迁移；cron 表达式解析 / next_run_at 计算由调用方（scheduler / 管理层）
 * 用 cron 库算好后传入，仓库不感知 cron 语义。
 */
export class AutomationRepo {
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // db 路径不能从进程级全局 _dataBaseDir（getTasksIndexDatabasePath）解析：
  // vitest threads 池会在同一进程并发跑多个测试文件，各文件的 setDataBaseDir(tempDir)
  // 互相覆盖全局值，导致 repo 与裸 SQL 操作在并发窗口内写进真实库 ~/.zcode/v2（历史脏数据
  // /tmp/ws 系列即因此污染）。改为构造期固定一份 dbPath，测试通过依赖注入传入临时库路径，
  // 生产路径不传则回退 getTasksIndexDatabasePath，向后兼容。
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db))
      this.migrationBackupSkipped = (await runTasksDatabaseMigrations(this.db, path)).backupSkipped;
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("AutomationRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // workspaceKey 传入时强制归属校验（写/单查路径,防跨 workspace 越界）；省略=不加过滤,
  // 供 scheduler/host 跨 workspace 的调度状态机使用。
  private getRow(automationId: string, workspaceKey?: string): AutomationRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .get({ id: automationId, workspace_key: workspaceKey ?? null }) as AutomationRow | undefined;
    return row ?? null;
  }

  // ---- 管理 CRUD ----

  async create(
    params: ZCodeAutomationCreateParams,
    options: { nextRunAt: number | null; lifecycleStatus?: ZCodeAutomationLifecycleStatus },
  ): Promise<ZCodeAutomation> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const now = Date.now();
    const automationId = `automation-${randomUUID()}`;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const db = this.getDatabase();
    // 仅在 UI 或事务外先 list 再 create，会让多窗口/CronCreate 并发请求同时通过旧计数。
    // BEGIN IMMEDIATE 串行化“全状态总数检查 + 插入”，确保本地任务索引不会突破 20 条。
    db.exec("BEGIN IMMEDIATE");
    try {
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM automations").get() as {
        count: number | bigint;
      };
      if (Number(countRow.count) >= AUTOMATION_CREATE_LIMIT) {
        throw new AutomationCreateLimitError();
      }
      db.prepare(
        `INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, model_selection,
          workspace_key, workspace_path, workspace_identity, project_id, host_id, additional_directories, target_task_id, bot_delivery_target, location_kind,
          recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
          run_count, enabled, lifecycle_status,
          next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error,
          mode, thought_level,
          created_at, updated_at
        ) VALUES (
          @automation_id, @title, @cron_expr, @prompt, @model, @provider, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity, @project_id, @host_id, @additional_directories, @target_task_id, @bot_delivery_target, 'local',
          @recurring, @max_runs, @end_at, @schedule_rule, 0,
          0, @enabled, @lifecycle_status,
          @next_run_at, NULL, 0, NULL,
          'idle', 0, NULL, NULL,
          @mode, @thought_level,
          @created_at, @updated_at
        )`,
      ).run({
        automation_id: automationId,
        title: params.title,
        cron_expr: params.cronExpr,
        prompt: params.prompt,
        model: null,
        provider: null,
        // 任务配置的显式空值与尚未迁移的 SQL NULL 分开；run 的 SQL NULL 冻结语义不变。
        model_selection: serializeAutomationModelSelection(params.modelSelection) ?? "null",
        mode: params.mode ?? null,
        thought_level: null,
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
        project_id: params.projectId ?? null,
        host_id: params.hostId ?? null,
        additional_directories:
          params.additionalDirectories === undefined
            ? null
            : JSON.stringify(
                z.array(z.string().min(1)).max(256).parse(params.additionalDirectories),
              ),
        target_task_id: params.targetTaskId ?? null,
        bot_delivery_target: params.botDeliveryTarget
          ? JSON.stringify(params.botDeliveryTarget)
          : null,
        recurring: params.recurring ? 1 : 0,
        max_runs: params.maxRuns ?? null,
        end_at: params.endAt ?? null,
        schedule_rule: params.scheduleRule ? JSON.stringify(params.scheduleRule) : null,
        enabled: options.lifecycleStatus === "completed" ? 0 : 1,
        lifecycle_status: options.lifecycleStatus ?? "active",
        next_run_at: options.nextRunAt,
        created_at: now,
        updated_at: now,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return rowToAutomation(this.getRow(automationId)!);
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({ workspace_key: workspaceKey }) as unknown as AutomationRow[];
    return rows.map(rowToAutomation);
  }

  /** 首次派发专用读取：列表可以展示未绑定任务，但派发不能把损坏值当成跟随默认。 */
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    if (!row) throw new Error("Automation 不存在或不属于当前工作区");
    const selection = readAutomationModelSelection(row);
    if (selection) return selection;
    // 迁移已把旧默认写为 JSON null。SQL NULL 是缺配置，不能借旧列决定执行默认值。
    const followsWorkspace = row.model_selection === "null";
    if (!followsWorkspace) throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    return undefined;
  }

  /**
   * 仅供后台派发读取 Bot 回推目标；该内部来源信息不进入 automation 展示模型。
   */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    const raw = this.getRow(automationId, workspaceKey)?.bot_delivery_target;
    if (!raw) return undefined;
    try {
      const parsed = zcodeAutomationBotDeliveryTargetSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Bug 原因：历史/外部写入的脏 JSON 不能拖垮任务列表或 scheduler；无效来源按未配置处理。
      return undefined;
    }
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(scope);
    // CronCreate 过去为判断一个 session 的归属而读取并序列化完整列表，任意无关
    // 展示字段损坏都会让安全查询失败。这里仅查询授权判据本身，并严格限定 workspaceKey。
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS bound FROM automations
        WHERE workspace_key = @workspace_key AND target_task_id = @target_task_id
        LIMIT 1`,
      )
      .get({ workspace_key: workspaceKey, target_task_id: scope.targetTaskId }) as
      | { bound: number }
      | undefined;
    return row !== undefined;
  }

  async get(automationId: string, workspaceKey?: string): Promise<ZCodeAutomation | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row ? rowToAutomation(row) : null;
  }

  /** maxRuns 的生命周期口径只统计定时派发；manual run 仅属于 Card 累计展示。 */
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row?.scheduled_run_count ?? null;
  }

  /**
   * 编辑定义字段。调用方按需传入重算后的 nextRunAt（改 cron_expr 时）与新的 lifecycleStatus
   * （改 recurring/max_runs 时），仓库不感知 cron 语义。改 cron_expr 时清空 retry 态。
   */
  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    options?: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomationLifecycleStatus;
      resetRetry?: boolean;
    },
    workspaceKey?: string,
  ): Promise<ZCodeAutomation | null> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const existing = this.getRow(automationId, workspaceKey);
    if (!existing) return null;
    const now = Date.now();
    const next: AutomationRow = {
      ...existing,
      title: params.title ?? existing.title,
      cron_expr: params.cronExpr ?? existing.cron_expr,
      prompt: params.prompt ?? existing.prompt,
      // 旧三列只供回滚保留；标题等编辑不能清除尚未迁入的旧选择，也不能参与新版运行读取。
      model: existing.model,
      provider: existing.provider,
      model_selection:
        params.modelSelection === undefined
          ? existing.model_selection
          : (serializeAutomationModelSelection(params.modelSelection ?? undefined) ?? "null"),
      mode: params.mode === undefined ? existing.mode : params.mode,
      thought_level: existing.thought_level,
      recurring: params.recurring === undefined ? existing.recurring : params.recurring ? 1 : 0,
      max_runs: params.maxRuns === undefined ? existing.max_runs : params.maxRuns,
      end_at: params.endAt === undefined ? existing.end_at : params.endAt,
      schedule_rule:
        params.scheduleRule === undefined
          ? existing.schedule_rule
          : params.scheduleRule
            ? JSON.stringify(params.scheduleRule)
            : null,
      schedule_edited_by_user:
        params.scheduleEditedByUser === undefined
          ? existing.schedule_edited_by_user
          : params.scheduleEditedByUser
            ? 1
            : 0,
      next_run_at: options?.nextRunAt === undefined ? existing.next_run_at : options.nextRunAt,
      lifecycle_status: options?.lifecycleStatus ?? existing.lifecycle_status,
      dispatch_attempts: options?.resetRetry ? 0 : existing.dispatch_attempts,
      retry_at: options?.resetRetry ? null : existing.retry_at,
      dispatch_status: options?.resetRetry ? "idle" : existing.dispatch_status,
      // enabled 完整由 lifecycleStatus 推导：仅当调用方显式改了生命周期时才动它
      // （active→入调度=1；completed/failed/paused→出调度=0），否则保持原值。
      // 修复：原实现在 completed/failed 时错误保留 existing.enabled，可能出现「已完成但仍被 claimDue 认领」。
      enabled: options?.lifecycleStatus
        ? options.lifecycleStatus === "active"
          ? 1
          : 0
        : existing.enabled,
      updated_at: now,
    };
    this.writeRow(next);
    return rowToAutomation(next);
  }

  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ id: automationId, workspace_key: workspaceKey ?? null });
    return result.changes > 0;
  }

  /** 暂停 / 恢复。paused ↔ active，保留 next_run_at / run_count。 */
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET enabled = @enabled,
            lifecycle_status = @lifecycle_status,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        enabled: enabled ? 1 : 0,
        lifecycle_status: enabled ? "active" : "paused",
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /**
   * 执行轮自暂停（CronPauseSelf）：只有 active 且 enabled 的任务才转 paused，返回是否真的改了状态。
   * paused / completed / failed / 已删除都返回 false，避免把终态任务改写成 paused。
   * 保留 next_run_at / run_count，恢复仍走 setEnabled(true)。
   */
  async pause(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `UPDATE automations
        SET enabled = 0,
            lifecycle_status = 'paused',
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND lifecycle_status = 'active'
          AND enabled = 1`,
      )
      .run({ id: automationId, now: Date.now(), workspace_key: workspaceKey ?? null });
    return result.changes > 0;
  }

  /** 终态任务手动重跑：回 active、清计数与重试态，nextRunAt 由调用方重算传入。 */
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET lifecycle_status = 'active',
            enabled = 1,
            run_count = 0,
            scheduled_run_count = 0,
            dispatch_attempts = 0,
            retry_at = NULL,
            dispatch_status = 'idle',
            running = 0,
            claimed_at = NULL,
            next_run_at = @next_run_at,
            last_error = NULL,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        next_run_at: options.nextRunAt,
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /**
   * 立即运行：写入由当前 host 直接持有的 manual run，不修改 automation 的 cron 计划/生命周期。
   * 直派路径过去没有占用 automation running 锁，连续点击会并发投递到同一个 target task，
   * 进而让模型配置 revision 互相踩踏。这里复用 scheduler 的 single-flight 锁；host 派发结算后释放。
   * attempts=1 表示已经交给直接派发方；scheduler 只会在认领超时后做崩溃恢复。
   */
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: options.now - CLAIM_STALE_MS });

      const row = this.getRow(automationId, workspaceKey);
      if (!row) {
        db.exec("COMMIT");
        return null;
      }

      const claimed = db
        .prepare(
          `UPDATE automations
          SET running = 1, claimed_at = @now, updated_at = @now
          WHERE automation_id = @id
            AND running = 0
            AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
        )
        .run({
          id: automationId,
          now: options.now,
          workspace_key: workspaceKey ?? null,
        });
      if (claimed.changes !== 1) {
        db.exec("COMMIT");
        return null;
      }

      const runId = `${automationId}:manual:${randomUUID()}`;
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (
          @run_id, @automation_id, @workspace_key, @scheduled_at, 'manual',
          @model_selection, 'claimed', 1, @now, @now
        )`,
      ).run({
        run_id: runId,
        automation_id: automationId,
        workspace_key: row.workspace_key,
        scheduled_at: options.now,
        // 认领尚未经过目标 Host 解析；原意图仍在 automation，run 等首次派发再固定。
        model_selection: null,
        now: options.now,
      });
      db.exec("COMMIT");
      return {
        automation: rowToAutomation({
          ...row,
          running: 1,
          claimed_at: options.now,
          updated_at: options.now,
        }),
        run: rowToRun({
          run_id: runId,
          automation_id: automationId,
          workspace_key: row.workspace_key,
          scheduled_at: options.now,
          trigger: "manual",
          model_selection: null,
          dispatch_status: "claimed",
          outcome: null,
          session_id: null,
          error: null,
          attempts: 1,
          created_at: options.now,
          updated_at: options.now,
        }),
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- 调度状态机 ----

  /**
   * single-flight 认领到期项：原子 running=0→1。同时回收认领超时（claimed_at 过期）的僵尸项。
   * due 判定同时看 next_run_at 与 retry_at，任一到期即 due。
   */
  async claimDue(now: number): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      // 截止日期是计划边界；过期任务先转终态，避免继续被正常 cron 或 retry 认领。
      db.prepare(
        `UPDATE automations
        SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
            retry_at = NULL, running = 0, claimed_at = NULL, updated_at = @now
        WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < @now`,
      ).run({ now });
      // 先回收僵尸认领（持有者崩溃，running=1 但 claimed_at 过期）。
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });
      // 认领条件：enabled 且未在途。
      // - 有 retry_at（transient 退避中）：只按 retry_at 到期认领，忽略 next_run_at——
      //   否则 next_run_at 仍停在过去会让退避被绕过、每 tick 立即重试。next_run_at 保持不变，
      //   保证重试复用同一个 runId（scheduler 以 next_run_at 作 scheduledAt）。
      // - 无 retry_at：按 next_run_at 到期认领。
      const dueRows = db
        .prepare(
          `SELECT * FROM automations
          WHERE enabled = 1 AND running = 0
            AND (
              (retry_at IS NOT NULL AND retry_at <= @now)
              OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= @now)
            )`,
        )
        .all({ now }) as unknown as AutomationRow[];
      const claimed: ZCodeAutomation[] = [];
      const claim = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, dispatch_status = 'claimed', updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      for (const row of dueRows) {
        const res = claim.run({ id: row.automation_id, now });
        if (res.changes === 1) {
          claimed.push(
            rowToAutomation({
              ...row,
              running: 1,
              claimed_at: now,
              dispatch_status: "claimed",
            }),
          );
        }
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 认领 UI「立即运行」产生的 manual run。
   * 立即运行不能改 next_run_at，否则会污染原 cron 节奏；manual run 使用 automation_runs
   * 作队列，短暂占用 automation running 锁来避免和定时触发并发投递同一个 task。
   */
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });

      const rows = db
        .prepare(
          `SELECT
            a.automation_id AS a_automation_id,
            a.title AS a_title,
            a.cron_expr AS a_cron_expr,
            a.prompt AS a_prompt,
            a.model AS a_model,
            a.provider AS a_provider,
            a.model_selection AS a_model_selection,
            a.mode AS a_mode,
            a.thought_level AS a_thought_level,
            a.workspace_key AS a_workspace_key,
            a.workspace_path AS a_workspace_path,
            a.workspace_identity AS a_workspace_identity,
            a.project_id AS a_project_id,
            a.host_id AS a_host_id,
            a.additional_directories AS a_additional_directories,
            a.target_task_id AS a_target_task_id,
            a.location_kind AS a_location_kind,
            a.recurring AS a_recurring,
            a.max_runs AS a_max_runs,
            a.end_at AS a_end_at,
            a.schedule_rule AS a_schedule_rule,
            a.schedule_edited_by_user AS a_schedule_edited_by_user,
            a.run_count AS a_run_count,
            a.scheduled_run_count AS a_scheduled_run_count,
            a.enabled AS a_enabled,
            a.lifecycle_status AS a_lifecycle_status,
            a.next_run_at AS a_next_run_at,
            a.last_run_at AS a_last_run_at,
            a.running AS a_running,
            a.claimed_at AS a_claimed_at,
            a.dispatch_status AS a_dispatch_status,
            a.dispatch_attempts AS a_dispatch_attempts,
            a.retry_at AS a_retry_at,
            a.last_error AS a_last_error,
            a.bot_delivery_target AS a_bot_delivery_target,
            a.created_at AS a_created_at,
            a.updated_at AS a_updated_at,
            r.run_id AS r_run_id,
            r.automation_id AS r_automation_id,
            r.workspace_key AS r_workspace_key,
            r.scheduled_at AS r_scheduled_at,
            r.trigger AS r_trigger,
            r.model_selection AS r_model_selection,
            r.dispatch_status AS r_dispatch_status,
            r.outcome AS r_outcome,
            r.session_id AS r_session_id,
            r.error AS r_error,
            r.attempts AS r_attempts,
            r.created_at AS r_created_at,
            r.updated_at AS r_updated_at
          FROM automation_runs r
          JOIN automations a ON a.automation_id = r.automation_id
          WHERE r.trigger = 'manual'
            AND r.dispatch_status = 'claimed'
            AND a.running = 0
            AND (r.attempts = 0 OR r.updated_at <= @stale)
          ORDER BY r.created_at ASC`,
        )
        .all({ stale: now - CLAIM_STALE_MS }) as unknown as Array<Record<string, unknown>>;

      const claimed: ClaimedManualAutomationRun[] = [];
      const claimAutomation = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      const claimRun = db.prepare(
        `UPDATE automation_runs
        SET attempts = attempts + 1, updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status = 'claimed'`,
      );

      for (const row of rows) {
        const automationId = row["a_automation_id"] as string;
        const runId = row["r_run_id"] as string;
        const res = claimAutomation.run({ id: automationId, now });
        if (res.changes !== 1) continue;
        claimRun.run({ run_id: runId, now });
        claimed.push({
          automation: rowToAutomation({
            automation_id: automationId,
            title: row["a_title"] as string,
            cron_expr: row["a_cron_expr"] as string,
            prompt: row["a_prompt"] as string,
            model: (row["a_model"] as string | null) ?? null,
            provider: (row["a_provider"] as string | null) ?? null,
            model_selection: (row["a_model_selection"] as string | null) ?? null,
            mode: (row["a_mode"] as string | null) ?? null,
            thought_level: (row["a_thought_level"] as string | null) ?? null,
            workspace_key: row["a_workspace_key"] as string,
            workspace_path: row["a_workspace_path"] as string,
            workspace_identity: (row["a_workspace_identity"] as string | null) ?? null,
            project_id: row["a_project_id"] as string | null,
            host_id: row["a_host_id"] as string | null,
            additional_directories: row["a_additional_directories"] as string | null,
            target_task_id: (row["a_target_task_id"] as string | null) ?? null,
            location_kind: row["a_location_kind"] as string,
            recurring: row["a_recurring"] as number,
            max_runs: (row["a_max_runs"] as number | null) ?? null,
            end_at: (row["a_end_at"] as number | null) ?? null,
            schedule_rule: (row["a_schedule_rule"] as string | null) ?? null,
            schedule_edited_by_user: row["a_schedule_edited_by_user"] as number,
            run_count: row["a_run_count"] as number,
            scheduled_run_count: row["a_scheduled_run_count"] as number,
            enabled: row["a_enabled"] as number,
            lifecycle_status: row["a_lifecycle_status"] as string,
            next_run_at: (row["a_next_run_at"] as number | null) ?? null,
            last_run_at: (row["a_last_run_at"] as number | null) ?? null,
            running: 1,
            claimed_at: now,
            dispatch_status: row["a_dispatch_status"] as string,
            dispatch_attempts: row["a_dispatch_attempts"] as number,
            retry_at: (row["a_retry_at"] as number | null) ?? null,
            last_error: (row["a_last_error"] as string | null) ?? null,
            bot_delivery_target: (row["a_bot_delivery_target"] as string | null) ?? null,
            created_at: row["a_created_at"] as number,
            updated_at: now,
          }),
          run: rowToRun({
            run_id: runId,
            automation_id: row["r_automation_id"] as string,
            workspace_key: row["r_workspace_key"] as string,
            scheduled_at: (row["r_scheduled_at"] as number | null) ?? null,
            trigger: row["r_trigger"] as string,
            model_selection: (row["r_model_selection"] as string | null) ?? null,
            dispatch_status: row["r_dispatch_status"] as string,
            outcome: (row["r_outcome"] as string | null) ?? null,
            session_id: (row["r_session_id"] as string | null) ?? null,
            error: (row["r_error"] as string | null) ?? null,
            attempts: (row["r_attempts"] as number) + 1,
            created_at: row["r_created_at"] as number,
            updated_at: now,
          }),
        });
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 派发成功结算：展示总数与定时派发数各 +1、写 last_run_at、清重试态、复位 running；
   * 循环任务回 active（nextRunAt 由调用方按实际派发时间重算传入）；
   * 有限次任务达 max_runs 转 completed（enabled=0、next_run_at=NULL）；
   * 派发窗口内已被暂停（CronPauseSelf / UI 暂停）的任务保持 paused，只记录本次派发。
   */
  async markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return; // 已删除，丢弃回写，避免复活
    const runCount = row.run_count + 1;
    const scheduledRunCount = row.scheduled_run_count + 1;
    // 有限次任务（recurring=0）达上限即 completed。未显式设 max_runs 时按一次性任务处理（默认上限 1），
    // 否则一次性 cron 会一直停在 active 并被 cron 反复触发，永不结束。这里必须使用独立的
    // scheduled_run_count；run_count 还包含 manual run，只能用于 Card 累计展示。
    const reachedMax = row.recurring === 0 && scheduledRunCount >= (row.max_runs ?? 1);
    const reachedEnd = row.end_at !== null && (options.nextRunAt ?? Infinity) > row.end_at;
    const completed = reachedMax || reachedEnd ? 1 : 0;
    // 修复原因：scheduler 回写与 Host 侧暂停（CronPauseSelf / UI setEnabled(false)）跑在两个
    // 独立连接上，旧实现在这里无条件写 lifecycle_status='active'、enabled=1，会把派发窗口内
    // 刚落下的 paused 复活成 active。改为在同一条 UPDATE 里按行的当前值判定（SQLite SET 表达式
    // 读取的是更新前的旧值）：completed 优先收口；否则 enabled=0 的行保持原 lifecycle / enabled，
    // 只记录本次派发；其余仍回 active。不引入二次读取或重试，避免再开新的竞态窗口。
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET run_count = @run_count,
            scheduled_run_count = @scheduled_run_count,
            last_run_at = @dispatched_at,
            dispatch_status = 'dispatched',
            dispatch_attempts = 0,
            retry_at = NULL,
            last_error = NULL,
            running = 0,
            claimed_at = NULL,
            lifecycle_status = CASE
              WHEN @completed = 1 THEN 'completed'
              WHEN enabled = 0 THEN lifecycle_status
              ELSE 'active'
            END,
            enabled = CASE WHEN @completed = 1 THEN 0 ELSE enabled END,
            next_run_at = CASE WHEN @completed = 1 THEN NULL ELSE @next_run_at END,
            updated_at = @now
        WHERE automation_id = @id`,
      )
      .run({
        id: automationId,
        run_count: runCount,
        scheduled_run_count: scheduledRunCount,
        dispatched_at: options.dispatchedAt,
        completed,
        next_run_at: options.nextRunAt,
        now: options.dispatchedAt,
      });
  }

  /**
   * 派发失败：transient 累加 attempts 并按退避写 retry_at；达上限后循环任务放弃本轮跳下一个
   * next_run_at（调用方传入），有限次任务转 failed。permanent 直接 failed 终态停用。
   */
  async markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      /** transient 达上限后，循环任务的下一个正常 next_run_at（调用方重算）。 */
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return;
    const db = this.getDatabase();
    const now = options.failedAt;
    if (options.kind === "permanent") {
      db.prepare(
        `UPDATE automations
        SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
            enabled = 0, running = 0, claimed_at = NULL,
            last_error = @error, updated_at = @now
        WHERE automation_id = @id`,
      ).run({ id: automationId, error: options.error, now });
      return;
    }
    const attempts = row.dispatch_attempts + 1;
    if (attempts >= DISPATCH_MAX_ATTEMPTS) {
      if (row.recurring === 1) {
        // 循环任务：放弃本轮，跳下一个正常 next_run_at，清重试态回 idle。
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              running = 0, claimed_at = NULL, next_run_at = @next_run_at,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({
          id: automationId,
          next_run_at: options.nextRunAt ?? null,
          error: options.error,
          now,
        });
      } else {
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
              enabled = 0, running = 0, claimed_at = NULL,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: automationId, error: options.error, now });
      }
      return;
    }
    // 未达上限：写退避 retry_at，复位 running 等下轮重认领。
    db.prepare(
      `UPDATE automations
      SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = @attempts,
          retry_at = @retry_at, running = 0, claimed_at = NULL,
          last_error = @error, updated_at = @now
      WHERE automation_id = @id`,
    ).run({
      id: automationId,
      attempts,
      retry_at: computeRetryAt(now, attempts),
      error: options.error,
      now,
    });
  }

  /** 关机/退出时释放认领：清 running、保留 next_run_at，不记失败不推进。 */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, dispatch_status = 'idle', updated_at = @now
        WHERE automation_id = @id AND running = 1`,
      )
      .run({ id: automationId, now: Date.now() });
  }

  /** manual run 结束后只释放 single-flight 锁，不修改 automation 的调度状态。 */
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /** host 仍持有 queued/running manual run 时续租，避免长任务被 scheduler 当作僵尸认领回收。 */
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET claimed_at = @now, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /**
   * 错过触发窗口：原子地记一条 skipped run + 把 next_run_at 前推到下一个未来触发点 + 复位认领。
   * 不计 run_count。用于 scheduler 启动/恢复后发现 next_run_at 已远早于 now 的补偿跳过。
   * finalize=true 用于纯一次性任务：目标时刻已错过即终态（completed + 停用 + 清空调度），
   * 不得再从兼容性 scheduleRule 推导出后续周期继续执行。
   */
  async skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    const db = this.getDatabase();
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, 'schedule', 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      ).run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        reason: params.reason,
        now,
      });
      if (params.finalize) {
        db.prepare(
          `UPDATE automations
          SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
              running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, now });
      } else {
        db.prepare(
          `UPDATE automations
          SET next_run_at = @next_run_at, running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, next_run_at: params.nextRunAt, now });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- 运行历史 automation_runs ----

  /** 确保 run 历史存在。用于 host outcome 回写兜底，不增加 attempts，避免和 scheduler retry 计数互相污染。 */
  async ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        now,
      });
  }

  /** 认领时 upsert 一行 run（run_id 冲突即命中本轮 retry，不新建）。 */
  async upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, @model_selection, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'claimed',
          model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection),
          outcome = NULL,
          error = NULL,
          attempts = attempts + 1,
          updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        model_selection: serializeAutomationModelSelection(params.modelSelection),
        now,
      });
  }

  /**
   * Select 首次形成 Submission 时原子固定 run Selection；之后调用只能读回原值。
   * 旧派发在每次 transient retry 都重新读取 Host preferred，导致同一 run 换模型。
   */
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.prepare(
      `UPDATE automation_runs
       SET model_selection = COALESCE(model_selection, @model_selection), updated_at = @now
       WHERE run_id = @run_id`,
    ).run({
      run_id: runId,
      model_selection: serializeAutomationModelSelection(selection),
      now: Date.now(),
    });
    const row = db
      .prepare(`SELECT model_selection FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as Pick<AutomationRunRow, "model_selection"> | undefined;
    const fixed = row ? readSerializedModelSelection(row.model_selection) : undefined;
    if (!fixed) throw new Error(`Automation run 不存在或无法固定模型选择: ${runId}`);
    return fixed;
  }

  /** 派发结果回写 run（dispatched 回填 session_id / failed_to_dispatch 记 error）。 */
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET dispatch_status = @dispatch_status,
            session_id = COALESCE(@session_id, session_id),
            error = @error,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: params.runId,
        dispatch_status: params.dispatchStatus,
        session_id: params.sessionId ?? null,
        error: params.error ?? null,
        now: Date.now(),
      });
  }

  /**
   * manual run 首次派发成功结算：原子更新 run 台账与累计运行次数。
   * 手动运行过去只更新 automation_runs，Card 的 runCount 因而只统计定时触发；
   * 同一个 runId 还可能由 direct host、scheduler 崩溃恢复或迟到回报重复结算，所以必须以
   * dispatch_status 首次进入 dispatched 作为幂等边界。manual 不推进 cron/maxRuns/lifecycle，
   * 也不释放 single-flight claim，claim 仍由真实 turn 终态收口。
   */
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = db
        .prepare(
          `SELECT automation_id, workspace_key, dispatch_status
          FROM automation_runs
          WHERE run_id = @run_id AND trigger = 'manual'`,
        )
        .get({ run_id: params.runId }) as
        | Pick<AutomationRunRow, "automation_id" | "workspace_key" | "dispatch_status">
        | undefined;
      if (!run || run.dispatch_status === "dispatched") {
        db.exec("COMMIT");
        return false;
      }

      db.prepare(
        `UPDATE automation_runs
        SET dispatch_status = 'dispatched',
            session_id = COALESCE(@session_id, session_id),
            error = NULL,
            updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status <> 'dispatched'`,
      ).run({
        run_id: params.runId,
        session_id: params.sessionId ?? null,
        now: params.dispatchedAt,
      });
      const automationUpdate = db
        .prepare(
          `UPDATE automations
          SET run_count = run_count + 1,
              last_run_at = @dispatched_at,
              updated_at = @now
          WHERE automation_id = @automation_id AND workspace_key = @workspace_key`,
        )
        .run({
          automation_id: run.automation_id,
          workspace_key: run.workspace_key,
          dispatched_at: params.dispatchedAt,
          now: params.dispatchedAt,
        });
      db.exec("COMMIT");
      return automationUpdate.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** session runtime 回写运行结果（running / succeeded / failed / stopped）。 */
  async markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET outcome = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome
              ELSE @outcome
            END,
            error = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error
              ELSE COALESCE(@error, error)
            END,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({ run_id: runId, outcome, error: error ?? null, now: Date.now() });
  }

  /** 错过触发窗口：落一条 skipped run（session_id=null），不计 run_count。 */
  async recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    reason: string;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        reason: params.reason,
        now,
      });
  }

  async listRuns(automationId: string, workspaceKey?: string): Promise<ZCodeAutomationRun[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automation_runs
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({
        id: automationId,
        workspace_key: workspaceKey ?? null,
      }) as unknown as AutomationRunRow[];
    return rows.map(rowToRun);
  }

  async getRun(runId: string): Promise<ZCodeAutomationRun | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as AutomationRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `DELETE FROM automation_runs
        WHERE run_id = @run_id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ run_id: runId, workspace_key: workspaceKey ?? null });
  }

  /** 保留策略：删除超过 maxAgeMs 的历史 run（防无限增长）。 */
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(`DELETE FROM automation_runs WHERE created_at < ?`)
      .run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }

  private writeRow(row: AutomationRow): void {
    this.getDatabase()
      .prepare(
        `UPDATE automations SET
          title = @title, cron_expr = @cron_expr, prompt = @prompt, model = @model, provider = @provider,
          model_selection = @model_selection,
          mode = @mode, thought_level = @thought_level,
          recurring = @recurring, max_runs = @max_runs, end_at = @end_at,
          schedule_rule = @schedule_rule,
          schedule_edited_by_user = @schedule_edited_by_user,
          next_run_at = @next_run_at, lifecycle_status = @lifecycle_status,
          dispatch_attempts = @dispatch_attempts, retry_at = @retry_at, dispatch_status = @dispatch_status,
          enabled = @enabled, updated_at = @updated_at
        WHERE automation_id = @automation_id`,
      )
      .run({
        automation_id: row.automation_id,
        title: row.title,
        cron_expr: row.cron_expr,
        prompt: row.prompt,
        model: row.model,
        provider: row.provider,
        model_selection: row.model_selection,
        mode: row.mode,
        thought_level: row.thought_level,
        recurring: row.recurring,
        max_runs: row.max_runs,
        end_at: row.end_at,
        schedule_rule: row.schedule_rule,
        schedule_edited_by_user: row.schedule_edited_by_user,
        next_run_at: row.next_run_at,
        lifecycle_status: row.lifecycle_status,
        dispatch_attempts: row.dispatch_attempts,
        retry_at: row.retry_at,
        dispatch_status: row.dispatch_status,
        enabled: row.enabled,
        updated_at: row.updated_at,
      });
  }
}
