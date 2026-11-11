import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";
import { buildReadSummary, ReadFileChip } from "@/ToolCallBlocks/renderers/read.js";
import { getWebFetchPrimaryText } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { getSearchPrimaryText } from "@/ToolCallBlocks/renderers/search.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { type ReactNode } from "react";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ZCodePlanStep } from "@zcode/shared";

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

type AgentChildSummary = {
  animationKey: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  title?: string;
};

function getChildActionKindLabel(
  intl: IntlLike,
  family: ReturnType<typeof resolveToolCallIdentity>["family"],
) {
  switch (family) {
    case "file-read":
      return intl.formatMessage({ id: "chat.toolCall.read.reading" });
    case "web-fetch":
      return intl.formatMessage({ id: "chat.toolCall.webFetch.fetching" });
    case "search":
      return intl.formatMessage({ id: "chat.toolCall.search.searching" });
    case "shell":
      return intl.formatMessage({ id: "chat.toolCall.execute.running" });
    default:
      return intl.formatMessage({ id: "chat.toolCall.status.running" });
  }
}

function renderChildActionKindPrefix(actionKindLabel: string | null, content: ReactNode) {
  if (!actionKindLabel) {
    return content;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      {content}
    </span>
  );
}

function readTodoPlanFromToolCall(
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ZCodePlanStep[] | null {
  return (
    extractPlanStepsFromToolOutput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      output: childToolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      input: childToolCall.input,
    })
  );
}

function getTodoChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): AgentChildSummary | null {
  const plan = readTodoPlanFromToolCall(childToolCall);
  if (!plan || plan.length === 0) {
    return {
      animationKey: `todo:${childToolCall.toolId}:empty`,
      primaryText: (
        <span className="min-w-0 truncate">
          {intl.formatMessage({ id: "chat.toolCall.todo.updating" })}
        </span>
      ),
      title: childToolCall.title,
    };
  }

  const completedCount = plan.filter((step) => step.status === "completed").length;
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan.at(-1);
  const isComplete = completedCount === plan.length;
  const actionLabel = intl.formatMessage({
    id: isComplete ? "chat.toolCall.todo.updated" : "chat.toolCall.todo.updating",
  });
  const progressText = `${completedCount}/${plan.length}`;
  const primaryText = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0">{progressText}</span>
      {activeStep?.title ? <span className="min-w-0 truncate">{activeStep.title}</span> : null}
    </span>
  );

  return {
    animationKey: `todo:${childToolCall.toolId}:${completedCount}:${plan.length}:${activeStep?.id ?? "none"}:${activeStep?.title ?? ""}`,
    primaryText: (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground-subtle">{actionLabel}</span>
        <span className="min-w-0 truncate">{primaryText}</span>
      </span>
    ),
    title: activeStep?.title ?? childToolCall.title,
  };
}

function getLatestAgentChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
): AgentChildSummary | null {
  const childIdentity = resolveToolCallIdentity(childToolCall);
  const actionKindLabel =
    options.includeChildActionKindLabel === true
      ? getChildActionKindLabel(intl, childIdentity.family)
      : null;

  if (childIdentity.family === "todo") {
    return getTodoChildSummary(intl, childToolCall);
  }

  if (childIdentity.family === "file-read") {
    const readSummary = buildReadSummary(childToolCall);
    if (!readSummary) {
      return null;
    }
    const canOpenPreview = readSummary.entryType === "file" && Boolean(context.onOpenCodeViewer);
    const openFilePreview = () => {
      if (readSummary.entryType !== "file") {
        return;
      }

      context.onOpenCodeViewer?.({
        type: "file",
        title: readSummary.fileName,
        path: readSummary.path,
      });
    };

    return {
      animationKey: `read:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${readSummary.path}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <ReadFileChip summary={readSummary} clickable={canOpenPreview} onClick={openFilePreview} />,
      ),
      title: readSummary.path,
    };
  }

  if (childIdentity.family === "web-fetch") {
    const primaryText = getWebFetchPrimaryText(childToolCall.input);
    return {
      animationKey: `fetch:${childToolCall.toolId}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }
  if (childIdentity.family === "search") {
    const primaryText = getSearchPrimaryText(intl, childToolCall.input);

    return {
      animationKey: `search:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }

  if (childIdentity.family === "shell") {
    const secondaryText =
      getExecuteSecondaryText(childToolCall.input) ?? childToolCall.title ?? childToolCall.kind;

    return {
      animationKey: `shell:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${secondaryText}`,
      primaryText: actionKindLabel ? (
        <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      ) : null,
      secondaryText: <code className="min-w-0 truncate font-sans">{secondaryText}</code>,
      title: typeof secondaryText === "string" ? secondaryText : childToolCall.title,
    };
  }

  const fallbackText =
    childToolCall.title ??
    childToolCall.kind ??
    intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });

  return {
    animationKey: `tool:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${fallbackText}`,
    primaryText: renderChildActionKindPrefix(
      actionKindLabel,
      <span className="min-w-0 truncate">{fallbackText}</span>,
    ),
    title: typeof fallbackText === "string" ? fallbackText : childToolCall.title,
  };
}

export function getLatestAgentChildSummaryFromChildren(
  intl: IntlLike,
  childToolCalls: readonly TaskChatToolCallTreeNode[],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
) {
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const childToolCall = childToolCalls[index]?.toolCall;
    if (!childToolCall) {
      continue;
    }

    const summary = getLatestAgentChildSummary(intl, childToolCall, context, options);
    if (summary) {
      return summary;
    }
  }

  return null;
}
