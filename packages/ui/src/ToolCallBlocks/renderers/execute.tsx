import { ExecuteCommand } from "@/ToolCallBlocks/renderers/ExecuteCommand.js";
import {
  bashOutputDisplaySchema,
  executionOutputPreviewSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ExecuteOutput } from "@/ToolCallBlocks/renderers/ExecuteOutput.js";
import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const EXECUTE_TOOL_ICON = <SquareTerminalIcon className="size-4 shrink-0 text-foreground-subtle" />;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getExecuteSecondaryText(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    const parts = input.map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0) {
      return undefined;
    }

    const shellCommandIndex = parts.findIndex((part) => part === "-lc");
    if (shellCommandIndex >= 0 && parts[shellCommandIndex + 1]) {
      return parts[shellCommandIndex + 1];
    }

    return parts.join(" ");
  }

  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const parsedCommand = record.parsed_cmd;
  if (Array.isArray(parsedCommand)) {
    for (const item of parsedCommand) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
        continue;
      }

      if (typeof item !== "object" || item === null) {
        continue;
      }

      const parsedRecord = item as Record<string, unknown>;
      if (typeof parsedRecord.cmd === "string" && parsedRecord.cmd.trim().length > 0) {
        return parsedRecord.cmd.trim();
      }
    }
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function getExecuteContentParts(input: unknown): {
  executionCommand?: string;
} {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return {};
    }

    const shellMatch = trimmed.match(
      /^(?:\/bin\/)?(?<tool>zsh|bash|sh)\s+-lc\s+(?<command>[\s\S]+)$/i,
    );
    if (shellMatch?.groups) {
      return {
        executionCommand: shellMatch.groups.command?.trim() || undefined,
      };
    }

    return {
      executionCommand: trimmed,
    };
  }

  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    const parts = input.map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0) {
      return {};
    }

    const shellCommandIndex = parts.findIndex((part) => part === "-lc");
    if (shellCommandIndex >= 0) {
      return {
        executionCommand: parts[shellCommandIndex + 1] || undefined,
      };
    }

    return {
      executionCommand: parts.slice(1).join(" ") || undefined,
    };
  }

  if (typeof input !== "object" || input === null) {
    return {};
  }

  const record = input as Record<string, unknown>;
  if (typeof record.command === "string" && record.command.trim().length > 0) {
    return getExecuteContentParts(record.command);
  }

  if (typeof record.cmd === "string" && record.cmd.trim().length > 0) {
    return getExecuteContentParts(record.cmd);
  }

  if (typeof record.script === "string" && record.script.trim().length > 0) {
    return getExecuteContentParts(record.script);
  }

  const parsedCommand = record.parsed_cmd;
  if (Array.isArray(parsedCommand)) {
    for (const item of parsedCommand) {
      if (typeof item === "string") {
        const parts = getExecuteContentParts(item);
        if (parts.executionCommand) {
          return parts;
        }
        continue;
      }

      if (typeof item !== "object" || item === null) {
        continue;
      }

      const parsedRecord = item as Record<string, unknown>;
      const executionCommand =
        typeof parsedRecord.cmd === "string" && parsedRecord.cmd.trim().length > 0
          ? parsedRecord.cmd.trim()
          : typeof parsedRecord.command === "string" && parsedRecord.command.trim().length > 0
            ? parsedRecord.command.trim()
            : typeof parsedRecord.script === "string" && parsedRecord.script.trim().length > 0
              ? parsedRecord.script.trim()
              : undefined;

      if (executionCommand) {
        return { executionCommand };
      }
    }
  }

  return {};
}

function extractExecuteResultText(output: unknown): string | null {
  if (output == null) {
    return null;
  }

  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? output : null;
  }

  if (Array.isArray(output)) {
    const pieces = output
      .map((item) => extractExecuteResultText(item))
      .filter((item): item is string => item != null);
    return pieces.length > 0 ? pieces.join("\n") : null;
  }

  if (isPlainRecord(output)) {
    const directText = readFirstStringField(output, [
      "output",
      "text",
      "content",
      "result",
      "stdout",
      "message",
    ]);
    if (directText) {
      return directText;
    }

    const rawOutput = output.rawOutput;
    if (rawOutput !== undefined) {
      const nestedText = extractExecuteResultText(rawOutput);
      if (nestedText) {
        return nestedText;
      }
    }

    const content = output.content;
    if (Array.isArray(content)) {
      const contentText = content
        .map((item) => {
          if (typeof item === "string") {
            return item.trim();
          }

          if (isPlainRecord(item)) {
            return (
              readFirstStringField(item, [
                "output",
                "text",
                "content",
                "result",
                "stdout",
                "message",
              ]) ?? ""
            );
          }

          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (contentText.length > 0) {
        return contentText;
      }
    }
  }

  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return String(output);
  }

  return null;
}

export function ExecuteToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText, isOfficeMode = false } = context;
  const { toolCall } = toolCallNode;
  // 摘要展示调用意图，详情仍从原始 input 读取命令，避免 description 替代真实执行内容。
  const description =
    (toolCall.toolName ?? toolCall.kind) === "Bash" && isPlainRecord(toolCall.input)
      ? readFirstStringField(toolCall.input, ["description"])
      : undefined;
  const secondaryText = description ?? getExecuteSecondaryText(toolCall.input);
  const contentParts = getExecuteContentParts(toolCall.input);
  const outputText = extractExecuteResultText(toolCall.output);
  const rawOutputText = isPlainRecord(toolCall.raw)
    ? extractExecuteResultText(toolCall.raw.rawOutput)
    : null;
  const outputDisplay = useMemo(() => {
    if (!isPlainRecord(toolCall.raw)) return undefined;
    const parsed = bashOutputDisplaySchema.safeParse(toolCall.raw.display);
    return parsed.success ? parsed.data : undefined;
  }, [toolCall.raw]);
  const resultText = outputDisplay?.output ?? outputText ?? rawOutputText;
  const outputPreview = useMemo(() => {
    if (!isRunning || !isPlainRecord(toolCall.raw)) return undefined;
    const parsed = executionOutputPreviewSchema.safeParse(toolCall.raw.outputPreview);
    return parsed.success ? parsed.data : undefined;
  }, [isRunning, toolCall.raw]);
  const failureVisibleText =
    toolCall.status === "failed" ? (errorText ?? resultText ?? undefined) : undefined;
  const secondaryTextNode = useMemo(
    // 收起态 command 属于摘要正文，使用 UI sans 与同一行文案保持一致；
    // 展开后的完整命令仍保留 font-mono，便于阅读和复制技术内容。
    () => <code className="truncate font-sans text-foreground-subtlest">{secondaryText}</code>,
    [secondaryText],
  );
  const renderContent = useCallback(
    () => (
      <div
        data-testid="execute-detail"
        className="space-y-3 mb-2 rounded-xl border border-border bg-panel px-4 py-3"
      >
        <div className="space-y-1">
          <div className="flex items-start gap-2 font-sans text-ui-base text-foreground">
            <ExecuteCommand
              key={contentParts.executionCommand}
              command={contentParts.executionCommand}
            />
          </div>
        </div>

        {context.isPermissionPreview ? null : outputPreview || failureVisibleText || resultText ? (
          <ExecuteOutput
            text={outputPreview?.fullText ?? failureVisibleText ?? resultText ?? ""}
            running={isRunning}
          />
        ) : (
          !isRunning && (
            <div className="space-y-1">
              <p className="font-mono text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.toolCall.execute.noOutput",
                })}
              </p>
            </div>
          )
        )}
      </div>
    ),
    [
      contentParts.executionCommand,
      context.isPermissionPreview,
      failureVisibleText,
      intl,
      isRunning,
      resultText,
      outputPreview,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EXECUTE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={!isOfficeMode && (context.canToggle ?? true)}
        forceOpen={!isOfficeMode && (context.forceOpen ?? false)}
        // 描述是调用意图，展开后仍保留；只有命令摘要沿用隐藏规则，避免与详情重复。
        hideSecondaryTextWhenOpen={!description}
        kindLabel={
          (isOfficeMode
            ? intl.formatMessage({
                id: isRunning
                  ? "chat.toolCall.execute.running"
                  : "chat.toolCall.execute.conciseCompleted",
              })
            : context.kindLabelOverride) ??
          intl.formatMessage({
            id: isRunning ? "chat.toolCall.execute.running" : "chat.toolCall.execute.ran",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={
          isOfficeMode || secondaryText
            ? null
            : (toolCall.title ??
              toolCall.kind ??
              intl.formatMessage({ id: "chat.toolCall.execute.execute" }))
        }
        secondaryText={isOfficeMode ? undefined : secondaryTextNode}
        statusLabel={statusLabel}
        statusTooltip={isOfficeMode ? undefined : failureVisibleText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={isOfficeMode ? undefined : (description ?? toolCall.title)}
        renderContent={renderContent}
      />
      {!isOfficeMode ? (
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            context.onLoadFullToolCallFields
              ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
              : undefined
          }
        />
      ) : null}
      {/* <pre className="text-[8px]">{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}
