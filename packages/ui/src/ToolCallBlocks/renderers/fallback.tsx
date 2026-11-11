import { WrenchIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { ToolDetailSection as DetailSection } from "@/ToolCallBlocks/session/contract.js";

const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
}

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

function ParameterValue({ value }: { value: unknown }) {
  const { intl } = useZCodeIntl();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0)
      return <p>{intl.formatMessage({ id: "chat.toolCall.fallback.noParameters" })}</p>;
    if (entries.every(([, item]) => item === null || typeof item !== "object")) {
      return (
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1.5">
          {entries.map(([key, item]) => (
            <div key={key} className="contents">
              <dt className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground-subtlest">
                {key}
              </dt>
              <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {displayValue(item)}
              </dd>
            </div>
          ))}
        </dl>
      );
    }
  }
  return <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{displayValue(value)}</pre>;
}

export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useZCodeIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const kindLabel =
    toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasPreview = displayModel.inlinePreview.type !== "none" || displayModel.planResult !== null;
  const failed = toolCall.status === "failed" || Boolean(errorText);
  const result = failed ? errorText || statusLabel : toolCall.output;
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      <>
        {childToolList ?? (
          <div
            data-fallback-details
            className="min-w-0 space-y-3 rounded-xl border border-border bg-surface/40 p-3"
          >
            {displayModel.showInput && toolCall.input !== undefined ? (
              <DetailSection
                label={intl.formatMessage({ id: "chat.toolCall.mcp.parameters" })}
                value={displayValue(toolCall.input)}
              >
                <ParameterValue value={toolCall.input} />
              </DetailSection>
            ) : null}
            {hasPreview && !failed ? (
              <ToolCallBody
                childToolList={null}
                displayModel={{
                  ...displayModel,
                  showInput: false,
                  showOutput: false,
                  showKind: false,
                }}
                toolCall={toolCall}
                workspacePath={workspacePath}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            ) : (
              <DetailSection
                label={intl.formatMessage({
                  id: failed ? "chat.toolCall.fallback.error" : "chat.toolCall.result",
                })}
                value={result === undefined ? undefined : displayValue(result)}
              >
                {/* 旧兜底把同一结果和整包 tool call 重复输出；这里只展示对应区的数据，保留 false/0 等有效结果。 */}
                {result !== undefined ? (
                  <pre
                    className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${typeof result === "string" ? "font-sans" : "font-mono"}`}
                  >
                    {displayValue(result)}
                  </pre>
                ) : (
                  <p className="text-foreground-subtlest">
                    {intl.formatMessage({
                      id:
                        isRunning || toolCall.status === "pending"
                          ? "chat.toolCall.fallback.waiting"
                          : "chat.toolCall.fallback.noResult",
                    })}
                  </p>
                )}
              </DetailSection>
            )}
          </div>
        )}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      handleLoadFullToolCallFields,
      hasPreview,
      failed,
      result,
      intl,
      isRunning,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly
          ? (context.summaryTextOverride ?? null)
          : (toolCall.title ?? intl.formatMessage({ id: "chat.toolCall.toolCall" }))
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        context.summaryOnly && typeof context.summaryTextOverride === "string"
          ? context.summaryTextOverride
          : toolCall.title
      }
      renderContent={renderContent}
    />
  );
}
