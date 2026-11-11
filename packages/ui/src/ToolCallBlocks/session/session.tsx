import { BookOpenTextIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ToolDetailSection } from "@/ToolCallBlocks/session/ToolDetailSection.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const SESSION_TOOLS = ["ListSessions", "ReadSession", "SendToSession", "WaitSessions"] as const;
export function isSessionToolName(name: string): boolean {
  return SESSION_TOOLS.some((tool) => tool === name);
}
function parseValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  value = parseValue(value);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function sessionId(value: unknown): string | undefined {
  return text(record(value).sessionId);
}
function shortId(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}
const STATUS_KEYS: Record<string, string> = {
  unknown: "unknown",
  idle: "idle",
  running: "running",
  needs_attention: "attention",
  accepted: "accepted",
  queued: "queued",
  completed: "completed",
  interrupted: "stopped",
  failed: "failed",
};

export function SessionToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const name = toolCall.toolName ?? toolCall.kind;
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `chat.toolCall.session.${key}` }, values);
  const input = record(toolCall.input);
  // 已有 output 是当前投影的唯一结果；只有字段缺失才读取旧快照 rawOutput，避免旧成功覆盖新失败。
  const result = parseValue(
    toolCall.output === undefined ? record(toolCall.raw).rawOutput : toolCall.output,
  );
  const output = record(result);
  // 大结果预算会把 JSON 转成保存提示或截断文本；解析失败不是空结果，必须保留原文。
  const resultText = text(result);
  const summary = record(output.summary);
  const targetId =
    sessionId(output.session) ??
    sessionId(summary.session) ??
    text(input.sessionId) ??
    sessionId(input.session);
  const target = text(summary.title) ?? (targetId ? shortId(targetId) : undefined);
  const sessions = rows(output.sessions);
  const operations = rows(output.operations);
  const inputOperations = rows(input.operations);
  const failed = toolCall.status === "failed" || Boolean(context.errorText);
  const aborted = failed || toolCall.status === "denied" || toolCall.status === "stopped";
  const running = !aborted && (context.isRunning || toolCall.status === "pending");
  const statusText = (value: unknown) => t(STATUS_KEYS[text(value) ?? ""] ?? "unknown");
  let status: string | undefined;
  if (aborted)
    status = failed ? t("failed") : t(toolCall.status === "denied" ? "rejected" : "stopped");
  else if (running) status = t(toolCall.status === "pending" ? "pending" : `${name}.running`);
  else if (resultText) status = t("textResult");
  else if (name === "SendToSession") {
    // admission/delivery 是业务回执，工具执行完成不表示目标会话已处理消息。
    status = t(
      output.admission === "rejected"
        ? "rejected"
        : output.admission === "accepted"
          ? output.delivery === "queued"
            ? "queued"
            : "accepted"
          : "unknown",
    );
  } else if (name === "WaitSessions") {
    const waitStatus: Record<string, string> = {
      completed: "waitEnded",
      timed_out: "timedOut",
      cancelled: "cancelled",
      unknown: "unknown",
    };
    status = t(waitStatus[text(output.status) ?? ""] ?? "unknown");
  }
  let primary = target;
  if (name === "ListSessions")
    primary =
      !aborted && Array.isArray(output.sessions)
        ? t("found", { count: sessions.length })
        : text(input.title);
  if (name === "WaitSessions") {
    const ids = new Set(
      (operations.length ? operations.map((row) => record(row.operation)) : inputOperations)
        .map((row) => sessionId(row.session) ?? text(row.sessionId))
        .filter(Boolean),
    );
    primary = ids.size ? t("count", { count: ids.size }) : undefined;
  }
  const sections: ReactNode[] = [];
  const add = (key: string, label: string, content: ReactNode, copy?: string) =>
    sections.push(
      <ToolDetailSection key={key} label={label} value={copy}>
        {content}
      </ToolDetailSection>,
    );
  const paragraph = (value: string) => (
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</p>
  );
  if (name !== "ListSessions" && name !== "WaitSessions" && target)
    add(
      "target",
      t("target"),
      <p title={targetId} className="[overflow-wrap:anywhere]">
        {target}
      </p>,
    );
  if (name === "SendToSession" && typeof input.prompt === "string")
    add("prompt", t("message"), paragraph(input.prompt), input.prompt);
  if (aborted) {
    const error = context.errorText || status || t("failed");
    add("error", t("result"), paragraph(error), error);
  } else if (resultText) {
    add("textResult", t("result"), paragraph(resultText), resultText);
  } else if (name === "ListSessions" && Array.isArray(output.sessions)) {
    const visible = sessions.map((row) => ({
      title:
        text(row.title) ??
        (sessionId(row.session) ? shortId(sessionId(row.session)!) : t("unknownSession")),
      id: sessionId(row.session),
      status: statusText(row.status),
    }));
    add(
      "sessions",
      t("sessions"),
      visible.length ? (
        <ul className="space-y-2">
          {visible.map((row, index) => (
            <li key={index} className="flex min-w-0 gap-3">
              <span title={row.id} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {row.title}
              </span>
              <span className="shrink-0 text-foreground-subtlest">{row.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        paragraph(t("empty"))
      ),
      visible.map((row) => `${row.title} — ${row.status}`).join("\n") || undefined,
    );
    const scope = record(output.searchScope);
    if (
      rows(scope.unavailableSources).length ||
      (Array.isArray(scope.scopes) && scope.scopes.length === 0)
    )
      add("scope", t("scope"), paragraph(t("partial")));
  } else if (name === "ReadSession" && output.view === "summary") {
    add("summary", t("result"), paragraph(statusText(summary.status)));
  } else if (
    name === "ReadSession" &&
    output.view === "messages" &&
    Array.isArray(output.messages)
  ) {
    const messages = rows(output.messages).filter((row) => typeof row.text === "string");
    const role = (value: unknown) =>
      t(
        ["user", "assistant", "system", "tool"].includes(String(value))
          ? `role.${value}`
          : "message",
      );
    add(
      "messages",
      t("messages"),
      messages.length ? (
        <div className="space-y-3">
          {messages.map((row, index) => (
            <div key={index} className="space-y-1">
              <p className="text-ui-sm text-foreground-subtlest">{role(row.role)}</p>
              {paragraph(row.text as string)}
            </div>
          ))}
        </div>
      ) : (
        paragraph(t("noMessages"))
      ),
      messages.map((row) => `${role(row.role)}\n${row.text}`).join("\n\n") || undefined,
    );
  } else if (name === "SendToSession" && !running) {
    const result = [status, text(output.reason)].filter(Boolean).join("\n");
    add("result", t("result"), paragraph(result), result);
  } else if (name === "WaitSessions" && (operations.length || inputOperations.length)) {
    const entries = operations.length
      ? operations.map((row) => ({
          id: sessionId(record(row.operation).session),
          state: statusText(row.status),
          reason: text(row.reason),
          attention: text(record(row.attention).message),
        }))
      : inputOperations.map((row) => ({
          id: sessionId(row.session) ?? text(row.sessionId),
          state: t("pending"),
          reason: undefined,
          attention: undefined,
        }));
    add(
      "operations",
      t("sessions"),
      <ul className="space-y-3">
        {entries.map((row, index) => (
          <li key={index} className="space-y-1">
            <div className="flex min-w-0 gap-3">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" title={row.id}>
                {row.id ? shortId(row.id) : t("unknownSession")}
              </span>
              <span className="shrink-0 text-foreground-subtlest">{row.state}</span>
            </div>
            {row.reason ? paragraph(row.reason) : null}
            {row.attention ? paragraph(row.attention) : null}
          </li>
        ))}
      </ul>,
      entries
        .map((row) =>
          [row.id ? shortId(row.id) : t("unknownSession"), row.state, row.reason, row.attention]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
    );
    if (!running) add("waitResult", t("result"), paragraph(status ?? t("unknown")));
  } else {
    add("empty", t("result"), paragraph(running ? t("waitingResult") : t("noResult")));
  }
  if (!aborted && text(output.nextCursor)) add("more", t("result"), paragraph(t("more")));
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={<BookOpenTextIcon className="size-4 shrink-0 text-foreground-subtle" />}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen}
      kindLabel={t(name)}
      primaryText={primary}
      statusLabel={status}
      showStatusLabel={Boolean(status)}
      showFailureStatus={failed}
      statusTooltip={failed ? context.errorText : undefined}
      isRunning={running}
      title={targetId ?? primary}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      renderContent={() => (
        <>
          <div
            data-session-details
            className="min-w-0 space-y-3 rounded-xl border border-border bg-surface/40 p-3"
          >
            {sections}
          </div>
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              context.onLoadFullToolCallFields
                ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
                : undefined
            }
          />
        </>
      )}
    />
  );
}
