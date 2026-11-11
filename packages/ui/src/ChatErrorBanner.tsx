import { resolveRequestSecurityErrorMessageId } from "@/request-security-edition/errors.js";
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
/**
 * ChatErrorBanner — 错误提示组件
 *
 * 显示 ZCode Agent 链路中的错误，带 traceId 方便排查。
 */
import { useState } from "react";
import {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import {
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_ERROR_HOOK_ICON,
} from "@zcode/shared/test-ids";
import { AnchorIcon, CopyIcon, InfoIcon, RocketIcon, SettingsIcon, X } from "lucide-react";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import type { IntlInstance } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { cn } from "./components/lib/utils.js";
import { toast } from "./components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getProviderBusinessErrorMessageId } from "@/lib/providerBusinessError.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";
import {
  isSuspiciousEmptyModelResultMessage,
  resolveOffPeakTicketExpiredBusinessCode,
  resolveRequestVerificationBusinessCode,
} from "@/lib/providerBusinessError.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

const HISTORICAL_MODEL_UNAVAILABLE_MESSAGES = [
  "历史任务使用的模型已不可用",
  "The model used by this historical task is no longer available",
];

const LOCALIZED_ERROR_CODES = new Set([
  "TASK_OWNED_BY_OTHER_HOST",
  "STALE_TASK_OWNER_COMMAND",
  "NO_ACTIVE_TASK_OWNER",
  "OWNER_COMMAND_FAILED",
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  // 服务层错误 message 是跨进程兜底，不能作为最终 UI 语言来源。
  // 历史任务模型不可用要按稳定 code 本地化，避免英文界面显示中文提示。
  "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
  "ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED",
]);

const MODEL_CONFIG_MISSING_CODES = new Set([
  "model_config_missing",
  "MODEL_CONFIG_MISSING",
  "ModelConfigMissing",
]);

// Core 建模阶段的目录错误码（子代理、目标续跑等不经发送前准入的路径仍会产生）。
// Bug 根因：体验套餐到期后 Provider 下架，这类 TurnError 曾把 Registry 内部文案
// "Provider Registry 中不存在 Provider: account:bigmodel-start-plan" 原样展示给用户。
// 按稳定 code 复用「当前模型已不可用，请重新选择」的本地化文案，不再透出内部实现。
const MODEL_NOT_IN_REGISTRY_CODES = new Set(["provider_not_found", "model_not_found"]);

/** 投影错误是否只是「会话模型不在 Registry」这一事实的 Core 侧表达。 */
export function isModelNotInRegistryError(error: Pick<ZCodeUiError, "code">): boolean {
  return Boolean(error.code && MODEL_NOT_IN_REGISTRY_CODES.has(error.code));
}

function isModelConfigMissingError(error: Pick<ZCodeUiError, "code" | "message">): boolean {
  // Bugfix: 桌面端发送前 registry 为空时，agent 会退回 CLI config 并抛 Model config is missing。
  // 真实原因是“当前没有可用模型”，不能把 CLI 配置路径直接暴露给桌面用户。
  // 这里只按结构化 code 识别，避免 UNKNOWN/SEND_FAILED 等包装错误的可读 message
  // 碰巧包含同一段文本时被误判，并连带隐藏复制、反馈等诊断入口。
  return Boolean(error.code && MODEL_CONFIG_MISSING_CODES.has(error.code));
}

function parseClaudeUnknownCommandMessage(message: string): {
  command: string;
  args?: string;
} | null {
  const match = message.match(/Claude Code 未知命令\s+(\S+?)(?:（参数：([^）]+)）)?。/u);
  if (!match?.[1]) {
    return null;
  }

  return {
    command: match[1],
    ...(match[2]?.trim() ? { args: match[2].trim() } : {}),
  };
}

/**
 * 缺模型横幅的措辞目标。远端 workspace 的模型目录来自远端 Registry，但本机配置保存后
 * 会由 Provisioning 自动下发到远端，因此只区分措辞，配置/升级动作始终指向本机。
 */
export type ChatErrorBannerModelConfigTarget = "local" | "remote";

export function resolveChatErrorBannerDisplayMessage(
  error: ZCodeUiError,
  intl: IntlInstance,
  modelConfigTarget: ChatErrorBannerModelConfigTarget = "local",
): string {
  const remoteCode = getRemoteConnectionFailureCode(error);
  if (remoteCode)
    return formatRemoteConnectionError({
      fallback: error.message,
      reasonCode: remoteCode,
      formatMessage: intl.formatMessage,
    });
  if (isModelConfigMissingError(error)) {
    return intl.formatMessage({
      id:
        modelConfigTarget === "remote"
          ? "chat.error.remoteNoAvailableModel"
          : "chat.error.noAvailableModel",
    });
  }

  if (error.code === "CLAUDE_UNKNOWN_COMMAND") {
    const parsed = parseClaudeUnknownCommandMessage(error.message);
    if (!parsed) {
      return error.message;
    }

    // Bugfix: 服务层为了兼容历史快照仍持久化中文兜底文案，UI 需要按稳定 code
    // 重新本地化，否则英文界面会混入中文错误提示。
    return parsed.args
      ? intl.formatMessage(
          { id: "zcode.error.CLAUDE_UNKNOWN_COMMAND_WITH_ARGS" },
          { command: parsed.command, args: parsed.args },
        )
      : intl.formatMessage(
          { id: "zcode.error.CLAUDE_UNKNOWN_COMMAND" },
          { command: parsed.command },
        );
  }

  const requestSecurityMessageId = resolveRequestSecurityErrorMessageId(error);
  if (requestSecurityMessageId) return intl.formatMessage({ id: requestSecurityMessageId });

  const providerBusinessCode =
    resolveRequestVerificationBusinessCode(error.code, error.message) ??
    resolveOffPeakTicketExpiredBusinessCode(error.code, error.message) ??
    error.code;
  const providerBusinessMessageId = getProviderBusinessErrorMessageId(providerBusinessCode);
  if (providerBusinessMessageId) {
    return intl.formatMessage({ id: providerBusinessMessageId });
  }

  if (isSuspiciousEmptyModelResultMessage(error.message)) {
    return intl.formatMessage({ id: "zcode.error.modelSuspiciousEmpty" });
  }

  if (isModelNotInRegistryError(error)) {
    return intl.formatMessage({ id: "zcode.error.ZCODE_RUNTIME_MODEL_UNAVAILABLE" });
  }

  return error.code && LOCALIZED_ERROR_CODES.has(error.code)
    ? intl.formatMessage({ id: `zcode.error.${error.code}` })
    : error.message;
}

export function shouldSuppressChatErrorBanner(
  error: Pick<ZCodeUiError, "code" | "message">,
): boolean {
  // 只有历史恢复残留的模型不可用提示才隐藏；当前发送/草稿报错需要展示，
  // 否则 registry 移除模型后用户会看到“请求没返回”而没有任何可操作反馈。
  return Boolean(
    error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE" &&
    HISTORICAL_MODEL_UNAVAILABLE_MESSAGES.some((message) => error.message.includes(message)),
  );
}

export function ChatErrorBanner({
  error,
  onRetry,
  retryLabel,
  retryDisabled,
  onDismiss,
  onOpenModelSettings,
  onOpenUpgrade,
  modelConfigTarget = "local",
  onReconnect,
  remoteKind,
}: {
  error: ZCodeUiError;
  onReconnect?: () => void;
  remoteKind?: string;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  onDismiss?: () => void;
  onOpenModelSettings?: () => void;
  onOpenUpgrade?: () => void;
  modelConfigTarget?: ChatErrorBannerModelConfigTarget;
}) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const actionButtonClassName = "shrink-0";
  const requestConfigError = Boolean(resolveRequestSecurityErrorMessageId(error));
  const iconButtonClassName = "shrink-0";
  const localizedErrorMessage = resolveChatErrorBannerDisplayMessage(
    error,
    intl,
    modelConfigTarget,
  );
  const remoteConnectionFailure = Boolean(getRemoteConnectionFailureCode(error));
  const modelConfigMissing = isModelConfigMissingError(error);
  const hookBlocked = error.code === "fault.runtime.hookBlocked";
  if (shouldSuppressChatErrorBanner(error)) {
    return null;
  }

  const handleOpenFeedback = async () => {
    openFeedbackSubmit({
      title: localizedErrorMessage.slice(0, 80),
      type: "bug",
      module: remoteConnectionFailure
        ? remoteKind === "ssh"
          ? "SSH连接失败"
          : remoteKind === "wsl"
            ? "WSL连接失败"
            : "其它"
        : "模型调用报错",
      severity: "P2-中",
      includeLogs: true,
      description: buildErrorFeedbackDescription({
        message: localizedErrorMessage,
        detail: error.detail,
        traceId: error.traceId,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
  };

  const handleCopyError = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "chat.error.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      // 错误横幅之前只能复制 TraceID，开发拿不到完整上下文。
      // 这里统一复制摘要、TraceID 和详情，方便用户一键转发完整报错信息。
      await navigator.clipboard.writeText(
        buildErrorCopyText({
          message: localizedErrorMessage,
          detail: error.detail,
          traceId: error.traceId,
          formatMessage: (id: string, values?: Record<string, string>) =>
            intl.formatMessage({ id }, values),
        }),
      );
      toast(intl.formatMessage({ id: "chat.error.copyFull.copied" }));
    } catch (copyError) {
      toast(
        intl.formatMessage(
          { id: "chat.error.copyFailed" },
          {
            error: copyError instanceof Error ? copyError.message : String(copyError),
          },
        ),
      );
    }
  };

  return (
    <div className="flex w-full justify-center">
      <div
        data-testid={TID_CHAT_ERROR_BANNER}
        data-error-code={error.code}
        className={cn(
          "w-full flex flex-wrap items-center gap-2 rounded-xl bg-surface backdrop-blur-md border border-border px-3 py-2",
        )}
      >
        {/* 配置恢复需要可操作的完整提示；手机横幅若与按钮挤在同一行，正文会只剩省略号。 */}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground",
            requestConfigError && "basis-full",
          )}
        >
          {hookBlocked ? (
            <AnchorIcon
              aria-hidden="true"
              className="size-4 shrink-0"
              data-testid={TID_CHAT_ERROR_HOOK_ICON}
            />
          ) : (
            <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
          )}
          <div
            className={cn(
              "min-w-0 font-medium",
              requestConfigError ? "whitespace-normal break-words" : "truncate",
            )}
          >
            {localizedErrorMessage}
          </div>
        </div>

        {modelConfigMissing ? (
          <>
            {onOpenUpgrade ? (
              <CodingPlanEntryButton
                type="button"
                variant="default"
                size="sm"
                onClick={onOpenUpgrade}
                className={cn(
                  actionButtonClassName,
                  "button-gradient gap-1.5 text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
                )}
                aria-label={intl.formatMessage({
                  id: "chat.quota.action.upgrade",
                })}
              >
                <RocketIcon className="size-3.5" />
                {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
              </CodingPlanEntryButton>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenModelSettings}
              className={cn(actionButtonClassName, "gap-1.5")}
              aria-label={intl.formatMessage({ id: "chat.error.setModels" })}
            >
              <SettingsIcon className="size-3.5" />
              {intl.formatMessage({ id: "chat.error.setModels" })}
            </Button>
          </>
        ) : null}

        {!modelConfigMissing && error.detail ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={actionButtonClassName}
              data-testid={TID_CHAT_ERROR_DETAILS_BUTTON}
              onClick={() => {
                // 详情之前内嵌在 banner 里展开，长错误会把消息区直接撑高，聊天滚动也会突然跳动。
                // 改成 dialog 后，横幅只保留单行摘要，详细内容放到独立浮层里看，结构和交互都更稳定。
                setDetailsDialogOpen(true);
              }}
            >
              {intl.formatMessage({ id: "chat.error.expandDetails" })}
            </Button>
            <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle className="whitespace-pre-wrap">{localizedErrorMessage}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "chat.error.expandDetails" })}
                  </DialogDescription>
                </DialogHeader>
                <pre className="max-h-[60vh] overflow-auto rounded-xl border border-border bg-surface px-3 py-2 text-ui-base whitespace-pre-wrap text-foreground-subtle">
                  {error.detail}
                </pre>
              </DialogContent>
            </Dialog>
          </>
        ) : null}

        {!modelConfigMissing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleCopyError();
            }}
            className={cn(actionButtonClassName, "gap-1.5")}
            aria-label={intl.formatMessage({ id: "chat.error.copyFull" })}
          >
            <CopyIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.error.copyFull" })}
          </Button>
        ) : null}

        {/* Bugfix: 错误横幅本身就是异常态，不能再经过 Radix Tooltip 的 Popper/Slot 状态链。
            这里改成普通 Button，避免无可用模型等错误触发横幅时发生 Maximum update depth 循环。 */}
        {!modelConfigMissing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleOpenFeedback();
            }}
            // ChatErrorBanner 这里之前混用了原生 button，导致按钮体系、焦点态和禁用态都绕开了设计系统。
            // 统一收口到 Button 组件后，错误横幅里的所有操作按钮才能保持同一套交互和主题表现。
            className={cn(actionButtonClassName)}
            aria-label={intl.formatMessage({ id: "chat.error.feedback" })}
            title={error.traceId}
          >
            {intl.formatMessage({ id: "chat.error.feedback" })}
          </Button>
        ) : null}

        {remoteConnectionFailure && onReconnect ? (
          <Button variant="outline" size="sm" onClick={onReconnect}>
            {intl.formatMessage({ id: "remote.conversation.reconnect" })}
          </Button>
        ) : null}
        {!remoteConnectionFailure && !modelConfigMissing && onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retryDisabled}>
            {retryLabel ?? intl.formatMessage({ id: "chat.error.retry" })}
          </Button>
        ) : null}

        {onDismiss ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onDismiss}
            className={cn(iconButtonClassName)}
            title={intl.formatMessage({ id: "chat.error.dismiss" })}
            aria-label={intl.formatMessage({ id: "chat.error.dismiss" })}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function buildErrorCopyText({
  message,
  detail,
  traceId,
  formatMessage,
}: {
  message: string;
  detail?: string;
  traceId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  return [
    formatMessage("feedback.submit.template.section.copyErrorHeading"),
    "",
    formatMessage("feedback.submit.template.section.errorSummary"),
    message,
    "",
    traceId ? formatMessage("feedback.submit.template.section.errorTraceId", { traceId }) : null,
    detail
      ? ["", formatMessage("feedback.submit.template.section.errorDetail"), detail].join("\n")
      : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
