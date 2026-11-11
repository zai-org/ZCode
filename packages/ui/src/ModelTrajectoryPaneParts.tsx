import type {
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
} from "@zcode/services";
import { Fragment } from "react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContentPartView, EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneDetails.js";
import { ExpandableTrajectoryMessage } from "@/ModelTrajectoryExpandableMessage.js";
import { ModelTrajectoryErrorBlock } from "@/ModelTrajectoryErrorBlock.js";
import {
  formatTrajectoryClockTime,
  formatTrajectoryDateTime,
  formatTrajectoryDuration,
} from "@/ModelTrajectoryFormat.js";
import { trajectoryRoleTextClass } from "@/ModelTrajectoryRoleStyles.js";
import { TrajectorySectionTitle } from "@/ModelTrajectorySectionTitle.js";

export { EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneDetails.js";

export type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

export function CallCard({
  record,
  index,
  inputMessages,
  expansionKeyPrefix,
  intl,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  inputMessages: ZCodeModelTrajectoryMessage[];
  expansionKeyPrefix?: string;
  intl: IntlShape;
}) {
  const response = record.response;
  const usage = response?.usage;
  const hasInput = inputMessages.length > 0;

  return (
    <article data-trajectory-call="" className="col-span-full grid grid-cols-subgrid">
      <div
        data-trajectory-call-summary=""
        className="sticky top-0 z-10 col-span-full flex w-full min-w-0 items-center gap-1.5 border-b border-border/50 bg-surface/90 px-3 py-2 text-left supports-[backdrop-filter]:backdrop-blur-sm"
      >
        <span className="flex size-5 shrink-0 items-center justify-center font-mono text-ui-xs text-foreground-subtlest">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <SourceTitle record={record} intl={intl} />
          {response?.finishReason ? (
            <Badge
              data-trajectory-finish-pill=""
              data-trajectory-finish-reason={response.finishReason}
              variant="outline"
              className="h-5 shrink-0 rounded-full border-border bg-tag px-2 text-ui-xs text-foreground-subtle"
            >
              {finishReasonLabel(response.finishReason, intl)}
            </Badge>
          ) : null}
        </span>
        <CallMetadata record={record} usage={usage} />
      </div>

      <div
        data-trajectory-call-content=""
        className="col-span-full grid grid-cols-subgrid gap-y-2 p-2"
      >
        {hasInput ? (
          <section
            data-trajectory-section=""
            className="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"
          >
            <TrajectorySectionTitle
              kind="input"
              label={intl.formatMessage({ id: "modelTrajectory.inputSection" })}
            />
            {inputMessages.map((message, messageIndex) => (
              <Fragment key={`${index}:${messageIndex}`}>
                <TrajectoryRowDivider />
                <MessageBlock
                  message={message}
                  callStartedAt={record.startedAt}
                  callDurationMs={record.durationMs}
                  isAlt={messageIndex % 2 === 1}
                  expansionKey={
                    expansionKeyPrefix ? `${expansionKeyPrefix}:input:${messageIndex}` : undefined
                  }
                  intl={intl}
                />
              </Fragment>
            ))}
          </section>
        ) : null}

        {response ? (
          <ResponseBlock
            response={response}
            callStartedAt={record.startedAt}
            callDurationMs={record.durationMs}
            startRowIndex={inputMessages.length}
            expansionKeyPrefix={expansionKeyPrefix}
            intl={intl}
          />
        ) : null}

        {record.error ? <ModelTrajectoryErrorBlock error={record.error} /> : null}
      </div>
      <div data-trajectory-call-divider="" className="col-span-full h-px bg-border" />
    </article>
  );
}

function SourceTitle({ record, intl }: { record: ZCodeModelTrajectoryRecord; intl: IntlShape }) {
  const callSource: NonNullable<ZCodeModelTrajectoryRecord["callSource"]> = record.callSource ?? {
    kind: "main",
  };
  const labelId = sourceLabelId(callSource);

  return (
    <span
      data-trajectory-source-title=""
      // E2E 曾把英文展示文案当成功能合同，切换到中文后误报轨迹投影失败；稳定属性保留原始语义，文案继续独立国际化。
      data-trajectory-source-kind={callSource.kind}
      data-trajectory-query-source={callSource.querySource}
      className="min-w-0 shrink truncate text-ui-sm font-medium text-foreground"
      title={callSource.querySource ? `querySource: ${callSource.querySource}` : undefined}
    >
      {intl.formatMessage({ id: labelId })}
    </span>
  );
}

function sourceLabelId(callSource: NonNullable<ZCodeModelTrajectoryRecord["callSource"]>): string {
  switch (callSource.querySource) {
    case "main_turn":
      return "modelTrajectory.source.main";
    case "session_title":
      return "modelTrajectory.source.sessionTitle";
    case "compact":
      return "modelTrajectory.source.compact";
    case "prompt_enhance":
      return "modelTrajectory.source.promptEnhance";
    case "target_completion_verification":
      return "modelTrajectory.source.targetCompletion";
    case "subagent":
      return "modelTrajectory.source.subagent";
    default:
      break;
  }

  switch (callSource.kind) {
    case "main":
      return "modelTrajectory.source.main";
    case "subagent":
      return "modelTrajectory.source.subagent";
    case "compact":
      return "modelTrajectory.source.compact";
    case "sidecar":
      return "modelTrajectory.source.sidecar";
    case "unknown":
      return "modelTrajectory.source.unknown";
  }
}

function MessageBlock({
  message,
  callStartedAt,
  callDurationMs,
  isAlt,
  expansionKey,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  callStartedAt: string;
  callDurationMs?: number;
  isAlt: boolean;
  expansionKey?: string;
  intl: IntlShape;
}) {
  // 调用时间按界面语言格式化（不跟系统语言）
  const { locale } = useZCodeIntl();
  // 只有已知角色才有 i18n key，未知角色直接展示原始 role，避免触发缺失 key。
  const knownRole = ["system", "user", "assistant", "tool"].includes(message.role);
  const roleLabel = knownRole
    ? intl.formatMessage({ id: `modelTrajectory.role.${message.role}` })
    : message.role;

  if (
    (message.role === "system" || message.role === "user" || message.role === "tool") &&
    message.parts.length > 0
  ) {
    return (
      <ExpandableTrajectoryMessage
        message={message}
        role={message.role}
        roleLabel={roleLabel}
        callDurationLabel={
          typeof callDurationMs === "number" ? formatTrajectoryDuration(callDurationMs) : "—"
        }
        callDatetimeLabel={formatTrajectoryDateTime(callStartedAt, locale)}
        callDatetimeTitle={callStartedAt}
        isAlt={isAlt}
        expansionKey={expansionKey}
        intl={intl}
      />
    );
  }

  return (
    <div
      data-trajectory-message-role={message.role}
      data-trajectory-search-target-key={expansionKey}
      data-trajectory-row-alt={isAlt || undefined}
      className={cn(
        "col-span-full grid min-h-8 min-w-0 grid-cols-subgrid px-3",
        isAlt && "bg-surface/30",
      )}
    >
      <span
        data-trajectory-role-label={knownRole ? message.role : "unknown"}
        className={cn(
          "pr-1 pt-0.5 font-mono text-ui-sm uppercase",
          knownRole
            ? trajectoryRoleTextClass(
                message.role === "tool"
                  ? "tool-result"
                  : (message.role as "system" | "user" | "assistant"),
              )
            : "text-foreground-subtlest",
        )}
      >
        {roleLabel}
      </span>
      <div
        data-trajectory-search-field="content"
        className="col-span-2 flex min-w-0 flex-col gap-1.5"
      >
        {message.parts.length === 0 ? (
          <span className="text-ui-sm text-foreground-subtlest">—</span>
        ) : (
          message.parts.map((part, partIndex) => (
            <ContentPartView key={partIndex} part={part} intl={intl} />
          ))
        )}
      </div>
    </div>
  );
}

function ResponseBlock({
  response,
  callStartedAt,
  callDurationMs,
  startRowIndex,
  expansionKeyPrefix,
  intl,
}: {
  response: NonNullable<ZCodeModelTrajectoryRecord["response"]>;
  callStartedAt: string;
  callDurationMs?: number;
  startRowIndex: number;
  expansionKeyPrefix?: string;
  intl: IntlShape;
}) {
  const hasContent =
    Boolean(response.text) || Boolean(response.reasoningText) || response.toolCalls.length > 0;

  if (!hasContent) {
    return null;
  }

  const rows: Array<{
    message: ZCodeModelTrajectoryMessage;
    roleLabel: string;
    key: string;
    visualRole?: "reasoning";
  }> = [];
  if (response.reasoningText) {
    rows.push({
      key: "reasoning",
      message: { role: "assistant", parts: [{ kind: "text", text: response.reasoningText }] },
      roleLabel: intl.formatMessage({ id: "modelTrajectory.reasoning" }),
      visualRole: "reasoning",
    });
  }
  if (response.text) {
    rows.push({
      key: "message",
      message: { role: "assistant", parts: [{ kind: "text", text: response.text }] },
      roleLabel: intl.formatMessage({ id: "modelTrajectory.role.assistant" }),
    });
  }
  response.toolCalls.forEach((toolCall, toolCallIndex) => {
    rows.push({
      key: `${toolCall.kind}:${toolCallIndex}`,
      message: { role: "assistant", parts: [toolCall] },
      roleLabel: intl.formatMessage({ id: "modelTrajectory.toolCall" }),
    });
  });

  return (
    <section
      data-trajectory-section=""
      data-trajectory-response-section=""
      className="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"
    >
      <TrajectorySectionTitle
        kind="output"
        label={intl.formatMessage({ id: "modelTrajectory.outputSection" })}
      />
      {rows.map((row, rowIndex) => (
        <Fragment key={row.key}>
          <TrajectoryRowDivider />
          <ResponseMessageRow
            message={row.message}
            roleLabel={row.roleLabel}
            visualRole={row.visualRole}
            callStartedAt={callStartedAt}
            callDurationMs={callDurationMs}
            isAlt={(startRowIndex + rowIndex) % 2 === 1}
            expansionKey={
              expansionKeyPrefix ? `${expansionKeyPrefix}:output:${row.key}` : undefined
            }
            intl={intl}
          />
        </Fragment>
      ))}
    </section>
  );
}

function TrajectoryRowDivider() {
  return <div data-trajectory-row-divider="" className="col-span-full h-px bg-border/50" />;
}

function ResponseMessageRow({
  message,
  roleLabel,
  visualRole,
  callStartedAt,
  callDurationMs,
  isAlt,
  expansionKey,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  roleLabel: string;
  visualRole?: "reasoning";
  callStartedAt: string;
  callDurationMs?: number;
  isAlt: boolean;
  expansionKey?: string;
  intl: IntlShape;
}) {
  // 调用时间按界面语言格式化（不跟系统语言）
  const { locale } = useZCodeIntl();
  return (
    <ExpandableTrajectoryMessage
      message={message}
      role="assistant"
      visualRole={visualRole}
      roleLabel={roleLabel}
      callDurationLabel={
        typeof callDurationMs === "number" ? formatTrajectoryDuration(callDurationMs) : "—"
      }
      callDatetimeLabel={formatTrajectoryDateTime(callStartedAt, locale)}
      callDatetimeTitle={callStartedAt}
      isAlt={isAlt}
      expansionKey={expansionKey}
      intl={intl}
    />
  );
}

function CallMetadata({
  record,
  usage,
}: {
  record: ZCodeModelTrajectoryRecord;
  usage?: ZCodeModelTrajectoryUsage;
}) {
  // token 数与时间按界面语言格式化（不跟系统语言）
  const { locale } = useZCodeIntl();
  const items: Array<{ text: string; title?: string }> = [];
  if (typeof usage?.inputTokens === "number") {
    items.push({ text: `IN ${usage.inputTokens.toLocaleString(locale)}` });
  }
  if (typeof usage?.outputTokens === "number") {
    items.push({ text: `OUT ${usage.outputTokens.toLocaleString(locale)}` });
  }
  if (typeof record.durationMs === "number") {
    items.push({ text: formatTrajectoryDuration(record.durationMs) });
  }
  items.push({
    text: formatTrajectoryClockTime(record.startedAt, locale),
    title: record.startedAt,
  });

  return (
    <span
      data-trajectory-call-metadata=""
      className="ml-auto flex shrink-0 items-center gap-1 font-mono text-ui-xs text-foreground-subtlest"
    >
      {items.map((item, index) => (
        <span key={`${item.text}:${index}`} title={item.title}>
          {index > 0 ? "· " : ""}
          {item.text}
        </span>
      ))}
    </span>
  );
}

function finishReasonLabel(reason: string, intl: IntlShape): string {
  switch (reason.toLowerCase().replaceAll("_", "-")) {
    case "stop":
      return intl.formatMessage({ id: "modelTrajectory.finish.stop" });
    case "tool-call":
    case "tool-calls":
      return intl.formatMessage({ id: "modelTrajectory.finish.toolCalls" });
    case "length":
      return intl.formatMessage({ id: "modelTrajectory.finish.length" });
    case "content-filter":
      return intl.formatMessage({ id: "modelTrajectory.finish.contentFilter" });
    default:
      return reason;
  }
}
