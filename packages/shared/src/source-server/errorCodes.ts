import { z } from "zod";

export const SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE = "source-server-install-required" as const;
export const SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE = "source-server-upgrade-required" as const;
export const SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE =
  "source-server-update-running-tasks" as const;
export const SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE =
  "source-server-downgrade-unconfirmed" as const;
/** 同一设备的更新进行中，本次连接在写状态和日志之前被拒绝；更新完成后可重试（R3 §6.3）。 */
export const SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE =
  "source-server-update-in-progress" as const;
export const WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE =
  "workspace-task-identity-conflict" as const;
export const WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE = "workspace-config-file-conflict" as const;
export const WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE =
  "workspace-migration-plan-diverged" as const;
export const WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE =
  "workspace-session-generation-changed" as const;
export const REMOTE_BIND_CANCELED_ERROR_CODE = "remote-bind-canceled" as const;
export const REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE =
  "remote-workspace-bind-session-missing" as const;
export const REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE =
  "remote-workspace-directory-unavailable" as const;
/** 远端读取项目目录超过截止时间仍没有返回；目录本身未必不可用，可重试。 */
export const REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE =
  "remote-workspace-directory-unresponsive" as const;
/**
 * 打开远程项目目录（读取目录 + 登记身份）的截止时间，超时报
 * REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE。Main 的 bind 兜底必须晚于它。
 */
export const REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS = 30_000;
export const REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE =
  "remote-recovery-budget-exhausted" as const;
export const SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE =
  "source-server-identity-change-pending" as const;
export const SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE =
  "source-server-remove-callback-missing" as const;
export const SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE =
  "source-server-remove-callback-failed" as const;
export const SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE =
  "source-server-remove-persist-failed" as const;
/** 远端 Supervisor 停止 Core 失败并进入 stop-failed，仍持有 data-root 锁（R2 §8.1）。 */
export const SOURCE_SERVER_STOP_FAILED_ERROR_CODE = "source-server-stop-failed" as const;
/** 远端 Supervisor 在 control 超时内没有应答；CLI 不强杀它（R2 §8.1）。 */
export const SOURCE_SERVER_CONTROL_UNRESPONSIVE_ERROR_CODE =
  "source-server-control-unresponsive" as const;

export const PUBLIC_ZCODE_ERROR_CODES = [
  "remote-authentication-failed",
  // 服务器在密码之后还要求交互验证（例如动态口令）；当前只支持密码、私钥与 SSH agent。
  "remote-authentication-unsupported",
  "remote-host-unreachable",
  "remote-connection-timeout",
  "remote-host-not-found",
  "remote-host-key-changed",
  "remote-download-failed",
  "remote-upload-failed",
  "remote-preflight-failed",
  "remote-install-failed",
  "remote-space-insufficient",
  "remote-permission-denied",
  // 远端系统或架构不在支持范围（Windows 原生主机、非 x64/arm64）；重试和改用直接下载都无效。
  "remote-platform-unsupported",
  "remote-connection-canceled",
  "remote-connection-unknown",
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
  SOURCE_SERVER_STOP_FAILED_ERROR_CODE,
  SOURCE_SERVER_CONTROL_UNRESPONSIVE_ERROR_CODE,
] as const;

export type PublicZCodeErrorCode = (typeof PUBLIC_ZCODE_ERROR_CODES)[number];

export const publicZCodeErrorCodeSchema = z.enum(PUBLIC_ZCODE_ERROR_CODES);

const publicZCodeErrorCodeSet = new Set<string>(PUBLIC_ZCODE_ERROR_CODES);

export function isPublicZCodeErrorCode(value: unknown): value is PublicZCodeErrorCode {
  return typeof value === "string" && publicZCodeErrorCodeSet.has(value);
}
