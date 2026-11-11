import {
  isPublicZCodeErrorCode,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
  SOURCE_SERVER_STOP_FAILED_ERROR_CODE,
  SOURCE_SERVER_CONTROL_UNRESPONSIVE_ERROR_CODE,
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
  type PublicZCodeErrorCode,
} from "@zcode/shared";

import type { RemoteTarget } from "@zcode/shared";
import type { RemoteConnectionAction } from "@/lib/remoteConnectionPresentationTypes.js";

export interface RemoteConnectionErrorPresentation {
  category: string;
  titleId: string;
  reasonId: string;
  values?: Record<string, string | number>;
  primaryAction: RemoteConnectionAction;
  actionMessageId: string;
  allowRemoteDownload: boolean;
}

const messageIdByCode: Record<PublicZCodeErrorCode, string> = {
  "remote-authentication-failed": "remote.error.authentication",
  "remote-authentication-unsupported": "remote.error.authenticationUnsupported",
  "remote-host-unreachable": "remote.error.hostUnreachable",
  "remote-connection-timeout": "remote.error.connectionTimeout",
  "remote-host-not-found": "remote.error.hostNotFound",
  "remote-host-key-changed": "remote.error.hostKeyChanged",
  "remote-download-failed": "remote.error.downloadFailed",
  "remote-upload-failed": "remote.error.uploadFailed",
  "remote-preflight-failed": "remote.error.preflightFailed",
  "remote-install-failed": "remote.error.installFailed",
  "remote-space-insufficient": "remote.error.spaceInsufficient",
  "remote-permission-denied": "remote.error.permissionDenied",
  "remote-platform-unsupported": "remote.error.platformUnsupported",
  "remote-connection-canceled": "remote.error.connectionCanceled",
  "remote-connection-unknown": "remote.error.unknown",

  [SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE]: "remote.error.sourceServerInstallRequired",
  [SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE]:
    "remote.error.sourceServerIdentityChangePending",
  [SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE]: "remote.error.sourceServerUpgradeRequired",
  [SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE]: "remote.error.sourceServerRunningTasks",
  [SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE]: "remote.error.sourceServerDowngradeUnconfirmed",
  [SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE]: "remote.error.sourceServerUpdateInProgress",
  [WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE]: "remote.error.workspaceTaskIdentityConflict",
  [WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE]: "remote.error.workspaceConfigConflict",
  [WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE]: "remote.error.workspaceMigrationPlanDiverged",
  [WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE]:
    "remote.error.workspaceSessionGenerationChanged",
  [REMOTE_BIND_CANCELED_ERROR_CODE]: "remote.error.bindCanceled",
  [REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE]: "remote.error.recoveryBudgetExhausted",
  [REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE]: "remote.error.bindSessionMissing",
  [REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE]: "remote.error.workspaceDirectoryUnavailable",
  [REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE]:
    "remote.error.workspaceDirectoryUnresponsive",
  [SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE]:
    "settings.source.error.source-server-remove-callback-missing",
  [SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE]:
    "settings.source.error.source-server-remove-callback-failed",
  [SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE]:
    "settings.source.error.source-server-remove-persist-failed",
  [SOURCE_SERVER_STOP_FAILED_ERROR_CODE]: "remote.error.sourceServerStopFailed",
  [SOURCE_SERVER_CONTROL_UNRESPONSIVE_ERROR_CODE]: "remote.error.sourceServerControlUnresponsive",
};

export function classifyRemoteConnectionError(input: {
  errorCode?: string;
  error?: string;
  target?: RemoteTarget;
  upgradeTarget?: "controller" | "server";
  recoveryAttempt?: number;
  recoveryLimit?: number;
}): RemoteConnectionErrorPresentation {
  const code = input.errorCode ?? "";
  let titleId = isPublicZCodeErrorCode(code) ? messageIdByCode[code] : "remote.error.unknown";
  let category = isPublicZCodeErrorCode(code) ? code : "unrecognized";
  let primaryAction: RemoteConnectionAction = "retry";
  switch (code) {
    case "remote-authentication-failed":
      category = "authentication";
      primaryAction = "edit-auth";
      break;
    case "ZCODE_REMOTE_WORKSPACE_DISCONNECTED":
      category = "disconnected";
      titleId = "remote.conversation.sendUnavailable";
      primaryAction = "connect";
      break;
    case "source-server-install-required":
      primaryAction = "install";
      break;
    case "source-server-upgrade-required":
      primaryAction = input.upgradeTarget === "controller" ? "update-desktop" : "update-server";
      break;
    case "source-server-identity-change-pending":
      primaryAction = "confirm-identity";
      break;
    case "remote-host-not-found":
      primaryAction = "edit-host";
      break;
    case "remote-host-key-changed":
      primaryAction = "security";
      break;
    case "remote-authentication-unsupported":
    case "remote-platform-unsupported":
    case "remote-space-insufficient":
    case "remote-permission-denied":
      primaryAction = "details";
      break;
    case "remote-bind-canceled":
    case "remote-connection-canceled":
      category = "canceled";
      primaryAction = "connect";
      break;
    case "credentials-required":
      category = "credentials";
      titleId = "remote.error.credentialsRequired";
      primaryAction = "credentials";
      break;
  }
  // 兼容旧传输层的无认证码消息；新连接直接消费公开码，不能从 permission denied 猜测认证。
  if (
    // SSH 认证发生在 probe 内，传输层可能附带 preflight 码；明确的认证原因优先于阶段兜底。
    (!code || code === "remote-connection-unknown" || code === "remote-preflight-failed") &&
    /all configured authentication methods failed|authentication failed|ssh authentication|SSH\s*认证失败/iu.test(
      input.error ?? "",
    )
  ) {
    category = "authentication";
    titleId = "remote.error.authentication";
    primaryAction = "edit-auth";
  }
  const kind = input.target?.kind;
  const variantTitles = [
    "remote.error.hostUnreachable",
    "remote.error.connectionTimeout",
    "remote.error.hostNotFound",
    "remote.error.preflightFailed",
    "remote.error.installFailed",
    "remote.error.spaceInsufficient",
    "remote.error.permissionDenied",
  ];
  if ((kind === "wsl" || kind === "docker") && variantTitles.includes(titleId))
    titleId += `.${kind}`;
  const deployment = [
    "remote-download-failed",
    "remote-upload-failed",
    "remote-preflight-failed",
    "remote-install-failed",
  ].includes(code);
  return {
    category,
    ...(code === REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE
      ? { values: { attempt: input.recoveryAttempt ?? "?", limit: input.recoveryLimit ?? "?" } }
      : {}),
    titleId,
    reasonId: `${titleId}.reason`,
    primaryAction,
    actionMessageId: `remote.action.${primaryAction}`,
    allowRemoteDownload:
      deployment &&
      category !== "authentication" &&
      input.target?.kind === "ssh" &&
      (input.target.assetInstallMode ?? "local-download-upload") === "local-download-upload",
  };
}

export function formatRemoteConnectionError(params: {
  fallback: string;
  reasonCode?: string;
  retryable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
}): string {
  const classified = classifyRemoteConnectionError({
    errorCode: params.reasonCode,
    error: params.fallback,
    recoveryAttempt: params.recoveryAttempt,
    recoveryLimit: params.recoveryLimit,
  });
  const message = params.formatMessage({ id: classified.titleId }, classified.values);
  return params.retryable === true
    ? `${message} ${params.formatMessage({ id: "remote.error.retryableHint" })}`
    : message;
}

export function shouldShowStandaloneRemoteErrorToast(reasonCode: string | undefined): boolean {
  // 版本阻断由 Source management 权威状态生成带「立即更新」的操作 Toast。
  // 重连路径再弹一个无动作错误会变成重复且不可恢复的噪音。
  return reasonCode !== "source-server-upgrade-required";
}
