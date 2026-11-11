import { renderFileSummaryName } from "@/ToolCallBlocks/renderers.js";
import { SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const READ_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

export type ReadSummary = {
  path: string;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  entryType: "file" | "directory";
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function extractTaggedValue(text: string, tagName: string): string | undefined {
  const matched = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  const value = matched?.[1]?.trim();
  return value ? value : undefined;
}

function normalizeReadEntryType(value: string | undefined): "file" | "directory" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "dir" || normalized === "directory" || normalized === "folder") {
    return "directory";
  }

  return "file";
}

function readReadMetadataFromRaw(raw: unknown): {
  path?: string;
  entryType: "file" | "directory";
} {
  if (!isPlainRecord(raw)) {
    return { entryType: "file" };
  }

  const rawInput = isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const directPath = rawInput
    ? readStringField(rawInput, ["filePath", "file_path", "path", "filename"])
    : undefined;
  const directType = rawInput
    ? readStringField(rawInput, ["type", "fileType", "entryType"])
    : undefined;

  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const outputText = rawOutput
    ? readStringField(rawOutput, ["output", "text", "content"])
    : undefined;
  const taggedOutputPath = outputText ? extractTaggedValue(outputText, "path") : undefined;
  const taggedOutputType = outputText ? extractTaggedValue(outputText, "type") : undefined;
  if (taggedOutputPath) {
    return {
      path: taggedOutputPath ?? directPath,
      entryType: normalizeReadEntryType(taggedOutputType),
    };
  }

  const contentItems = Array.isArray(raw.content) ? raw.content : [];
  for (const item of contentItems) {
    if (!isPlainRecord(item)) {
      continue;
    }

    const nestedContent = isPlainRecord(item.content) ? item.content : null;
    const text =
      (nestedContent && readStringField(nestedContent, ["text"])) ??
      readStringField(item, ["text"]);
    const taggedPath = text ? extractTaggedValue(text, "path") : undefined;
    const taggedType = text ? extractTaggedValue(text, "type") : undefined;
    if (taggedPath) {
      return {
        path: taggedPath ?? directPath,
        entryType: normalizeReadEntryType(taggedType),
      };
    }
  }

  if (directPath) {
    // 有些模型只在 rawInput 里给 filePath，但会在 rawOutput/content 里补充目录类型。
    // 之前这里一旦先读到 rawInput.filePath 就会提前返回成 file，导致目录卡片图标错误。
    // 现在改成“类型优先看显式输出，路径再回退 rawInput”，只在确实没有输出标签时才用 input 兜底。
    return {
      path: directPath,
      entryType: normalizeReadEntryType(directType),
    };
  }

  return { entryType: "file" };
}

function readReadMetadataFromValue(value: unknown): {
  path?: string;
  entryType: "file" | "directory";
} {
  if (!isPlainRecord(value)) {
    return { entryType: "file" };
  }

  return {
    path: readStringField(value, ["filePath", "file_path", "path", "filename"]),
    entryType: normalizeReadEntryType(readStringField(value, ["type", "fileType", "entryType"])),
  };
}

function createReadSummary(
  path: string,
  options: {
    fileName?: string;
    entryType?: "file" | "directory";
  } = {},
): ReadSummary {
  const entryType = options.entryType ?? "file";
  const descriptor = resolveFileDisplayDescriptor(path);

  return {
    path,
    fileName: options.fileName ?? descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: entryType === "directory" ? FOLDER_FILE_ICON_SRC : descriptor.fileIconSrc,
    entryType,
  };
}

export function buildReadSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ReadSummary | null {
  const input = toolCall.input;
  if (isPlainRecord(input) && Array.isArray(input.parsed_cmd)) {
    const cwd =
      typeof input.cwd === "string" && input.cwd.trim().length > 0
        ? input.cwd.trim().replace(/\/+$/, "")
        : null;

    for (const item of input.parsed_cmd) {
      if (!isPlainRecord(item) || item.type !== "read") {
        continue;
      }

      const relativePath =
        typeof item.path === "string" && item.path.trim().length > 0 ? item.path.trim() : undefined;
      const fileName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : relativePath
            ? (relativePath.split("/").filter(Boolean).pop() ?? relativePath)
            : undefined;

      if (!relativePath && !fileName) {
        continue;
      }

      const absolutePath =
        relativePath && cwd && !relativePath.startsWith("/")
          ? `${cwd}/${relativePath}`
          : (relativePath ?? fileName ?? "read");

      // read 卡片之前只兼容 parsed_cmd 结构。
      // 其他模型常把路径放在 rawInput/filePath 或 rawOutput 的 <path> 标签里，
      // 导致 UI 只能退回 kind/title。这里保留结构化优先，再补原始输出兜底。
      return createReadSummary(absolutePath, {
        fileName,
        entryType: "file",
      });
    }
  }

  const directInputMetadata = readReadMetadataFromValue(input);
  if (directInputMetadata.path) {
    // 一些 provider 的 read/update 事件直接把文件路径放在 input.file_path，
    // 不会补 parsed_cmd，也不一定把相同字段镜像到 raw.rawInput.filePath。
    // 之前 summary 构建会直接漏掉这类 read 卡片，导致 primary/secondary 都退回标题。
    return createReadSummary(directInputMetadata.path, {
      entryType: directInputMetadata.entryType,
    });
  }

  const rawMetadata = readReadMetadataFromRaw(toolCall.raw);
  return rawMetadata.path
    ? createReadSummary(rawMetadata.path, {
        entryType: rawMetadata.entryType,
      })
    : null;
}

export function ReadFileChip({
  summary,
  clickable,
  onClick,
}: {
  summary: ReadSummary;
  clickable: boolean;
  onClick?: () => void;
}) {
  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-foreground hover:underline"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
        {renderFileSummaryName(summary.fileName, summary.path)}
      </button>
    );
  }

  return (
    <span className="inline-flex min-w-0 text-foreground max-w-full items-center gap-1.5">
      <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
      {renderFileSummaryName(summary.fileName, summary.path)}
    </span>
  );
}

export function ReadToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText, onOpenCodeViewer } = context;
  const { toolCall } = toolCallNode;
  const summary = buildReadSummary(toolCall);
  const canOpenPreview = summary?.entryType === "file" && Boolean(onOpenCodeViewer);
  const openFilePreview = useCallback(() => {
    if (!summary || summary.entryType !== "file" || !onOpenCodeViewer) {
      return;
    }

    onOpenCodeViewer({
      type: "file",
      title: summary.fileName,
      path: summary.path,
    });
  }, [onOpenCodeViewer, summary]);
  const primaryText = useMemo(
    () =>
      summary ? (
        <ReadFileChip summary={summary} clickable={canOpenPreview} onClick={openFilePreview} />
      ) : (
        (toolCall.title ?? toolCall.kind ?? intl.formatMessage({ id: "chat.toolCall.read.read" }))
      ),
    [canOpenPreview, intl, openFilePreview, summary, toolCall.kind, toolCall.title],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={intl.formatMessage({
          id: isRunning ? "chat.toolCall.read.reading" : "chat.toolCall.read.read",
        })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        content={null}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />

      {/* <pre className="px-4 py-3 rounded-xl bg-surface text-ui-xs mt-1 text-foreground-subtle max-h-50 overflow-auto">
        {JSON.stringify(toolCall, null, 2)}
      </pre> */}
    </>
  );
}
