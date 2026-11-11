import { FlaskConical } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ToolCallEvalWorkflowSnippetDisplay } from "@zcode/shared/zcode-protocol-v4";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { WorkflowDiagnosticsSection } from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";
import {
  snippetResponse,
  snippetValue,
} from "@/ToolCallBlocks/renderers/workflow-snippet-presentation.js";

const ICON = <FlaskConical className="size-4 shrink-0 text-foreground-subtle" />;

/** 三态摘要不放结果预览，展开内容按执行状态排序。 */
export function EvalWorkflowSnippetToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const snippet = display?.kind === "eval_workflow_snippet" ? display : undefined;
  const running = context.isRunning;
  const failed = !running && (toolCall.status === "failed" || snippet?.ok === false);
  const startedAt = toolCall.startedAt;
  // 进行中按整秒走、每秒一格（与面板里其他计时同一粒度）；终态定格在工具结果的精确毫秒。
  // 不能每 100ms 显示一次毫秒——尾数肉眼读不了，却是聊天区里最频繁的待处理更新
  // （React 嵌套更新计数在投影帧积压时的种子）。
  const now = useNowTicker(running && typeof startedAt === "number");
  const durationText = running
    ? typeof startedAt === "number"
      ? `${Math.max(0, Math.floor((now - startedAt) / 1000))}s`
      : undefined
    : snippet?.durationMs === undefined
      ? undefined
      : `${snippet.durationMs}ms`;
  const durationNode = useMemo(
    () =>
      !failed && durationText !== undefined ? (
        <span className="font-mono tabular-nums">{durationText}</span>
      ) : undefined,
    [durationText, failed],
  );
  const input = toolCall.input as { code?: unknown } | undefined;
  const code = typeof input?.code === "string" && input.code.trim() ? input.code : undefined;
  const response = useMemo(
    () =>
      snippet
        ? snippetResponse(snippet)
        : typeof toolCall.output === "string" && toolCall.output.trim()
          ? toolCall.output
          : undefined,
    [snippet, toolCall.output],
  );
  const error =
    context.errorText ||
    (failed ? response || snippet?.diagnostics.map((d) => d.message).join("\n") : undefined);
  // 展开入口与当前实际展示的内容一致，不能因隐藏的代码/日志留下空面板。
  const hasDetails = running
    ? code !== undefined
    : failed
      ? code !== undefined ||
        !!snippet?.logs.length ||
        !!snippet?.diagnostics.length ||
        !!(response || error)
      : response !== undefined;
  const renderContent = useCallback(
    () => (
      <SnippetBody
        key={running ? "running" : "terminal"}
        code={code}
        display={snippet}
        running={running}
        failed={failed}
        response={
          failed ? response || (!snippet?.diagnostics.length ? error : undefined) : response
        }
        theme={context.theme}
      />
    ),
    [code, snippet, running, failed, response, error, context.theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: running
              ? "chat.toolCall.workflow.snippet.validating"
              : "chat.toolCall.workflow.snippet.ran",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={durationNode}
        statusLabel={failed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined}
        statusTooltip={failed ? error : undefined}
        showFailureStatus={failed}
        isRunning={running}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}

function SnippetBody({
  code,
  display,
  running,
  failed,
  response,
  theme,
}: {
  code?: string;
  display?: ToolCallEvalWorkflowSnippetDisplay;
  running: boolean;
  failed: boolean;
  response?: string;
  theme: ToolCallBlockRenderContext["theme"];
}) {
  const { intl } = useZCodeIntl();
  if (!failed) {
    const content = running
      ? code === undefined
        ? undefined
        : { code, language: "typescript" }
      : response === undefined
        ? undefined
        : snippetValue(response);
    if (!content) return null;
    return (
      <SnippetTextPanel
        key={content.code}
        text={content.code}
        language={content.language}
        running={running}
        truncated={!running && display?.truncated === true}
      />
    );
  }

  const codeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.snippet.section.code" });
  const codeBlock =
    code === undefined ? null : (
      <CodeBlock
        code={code}
        language="typescript"
        appTheme={theme}
        showLineNumbers
        renderMermaid={false}
      />
    );
  const value = response === undefined ? undefined : snippetValue(response);
  return (
    <div className="mb-2 space-y-3" data-testid="workflow-snippet-body">
      {display?.diagnostics.length ? (
        <WorkflowDiagnosticsSection diagnostics={display.diagnostics} />
      ) : null}
      {value ? (
        <section className="space-y-1.5" data-testid="snippet-result">
          <div className="max-h-72 overflow-auto">
            <CodeBlock
              code={value.code}
              language={value.language}
              appTheme={theme}
              renderMermaid={false}
            >
              <CodeBlockHeader>
                <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                  {intl.formatMessage({
                    id: failed
                      ? "chat.toolCall.status.failed"
                      : "chat.toolCall.workflow.snippet.section.response",
                  })}
                </h4>
                <CodeBlockCopyButton />
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        </section>
      ) : null}
      {display?.logs.some((line) => line.trim()) ? (
        <section className="space-y-1.5" data-testid="snippet-logs">
          <h4 className="text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.toolCall.workflow.snippet.section.logs" })}
          </h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
            {display.logs.join("\n")}
          </pre>
        </section>
      ) : null}
      {codeBlock ? (
        <details className="space-y-2" data-testid="snippet-code">
          <summary className="cursor-pointer text-ui-sm text-foreground-subtlest">
            {codeLabel}
          </summary>
          <div className="max-h-64 overflow-auto">{codeBlock}</div>
        </details>
      ) : null}
      {display?.truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}

/** 共用 Markdown 工具栏，正文独立滚动，避免复制按钮随长内容卷走。 */
function SnippetTextPanel({
  text,
  language,
  running,
  truncated,
}: {
  text: string;
  language: string;
  running: boolean;
  truncated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="mb-2 min-w-0" data-testid="workflow-snippet-body">
      <div data-testid={running ? "snippet-running-code" : "snippet-result"}>
        <CodeBlock
          code={text}
          language={language}
          className="border border-border bg-card"
          contentClassName="max-h-80 overflow-auto"
          wrapLongLines
          renderMermaid={false}
        >
          <CodeBlockHeader className="pl-3 pr-2 pt-2" language={language} />
        </CodeBlock>
      </div>
      {truncated ? (
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
