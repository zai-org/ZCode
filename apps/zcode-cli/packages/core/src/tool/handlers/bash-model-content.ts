import {
  BashOutputSchema,
  parseImageDataUrl,
  type BashOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import {
  formatCompactPersistedOutputContent,
  truncateMiddleForModel,
} from "../result-persistence-format.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";

const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;
// 同步子代理的后台命令：子代理结束时封存通知，最终回复之后不会再有通知。
const SYNC_SUBAGENT_NOTIFICATION =
  "If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that \u2014 so do not end your turn to wait for it; if you need its result, wait for it before giving your final response.";
// 后台命令改目录时：后台命令结束时不写回会话 cwd。
const BACKGROUND_CWD_UNCHANGED =
  "directory changes made by the backgrounded command do not apply to subsequent commands.";
const READ_TOOL_NAME = "Read";

export function formatBashModelContent(output: unknown): ModelMessageContent {
  const parsed = BashOutputSchema.safeParse(output);
  if (!parsed.success) return stringifyFallback(output);

  const result = parsed.data;
  if (hasStructuredContent(result)) {
    return result.structuredContent as ModelMessageContent;
  }

  // Bash 失败以结果对象返回；模型可见的错误结果应保持为纯文本。
  if (isBashOutputProviderError(result)) {
    return formatProviderErrorContent(result);
  }

  const imageContent = maybeImageContent(result);
  if (imageContent) return imageContent;

  return formatTextContentForModel(result);
}

/** formatBashModelContent 走失败分支时为 true：正文已按字符保留头尾，有确定上限。 */
export function isBashModelContentBounded(output: unknown): boolean {
  const parsed = BashOutputSchema.safeParse(output);
  return (
    parsed.success && !hasStructuredContent(parsed.data) && isBashOutputProviderError(parsed.data)
  );
}

function hasStructuredContent(result: BashOutput): boolean {
  return Array.isArray(result.structuredContent) && result.structuredContent.length > 0;
}

export function formatPersistedBashModelContent(input: {
  content: string;
  output: unknown;
  persistedPath: string;
  originalBytes: number;
}): ModelMessageContent | undefined {
  if (!BashOutputSchema.safeParse(input.output).success) return undefined;
  // serializer 已经把完整 Bash provider-visible content 写入 artifact；
  // 这里必须只预览该 content，不能重进普通 formatter 后把 stderr/provider-error 文本完整追加回模型上下文。
  return formatCompactPersistedOutputContent({
    content: input.content,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
  });
}

// 失败命令的输出不落盘：用内联采集的前 30000 字节，超长时保留这段的头尾；超出 30000 字节的部分看不到。
// 修复原因：超过 30000 字节就落盘、只给 2KB 开头时，模型看不到这段后部的错误原因。
// 硬超时也走这里：超时行（stderr）排在输出之前，不加中断标记。
// 输出保留开头的空行（空行可能是输出的一部分），只去掉末尾空白；成功结果仍去掉开头的空行。
function formatProviderErrorContent(result: BashOutput): string {
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trim();
  const parts = result.status === "timed_out" ? [stderr, stdout] : [stdout, stderr];
  return truncateMiddleForModel(
    [`Exit code ${result.exitCode}`, ...parts].filter(Boolean).join("\n").trim(),
  );
}

function formatTextContentForModel(result: BashOutput): string {
  return [
    formatStdoutContentForModel(result),
    formatStderrForModel(result),
    formatBackgroundInfoForModel(result),
    result.staleReadFileStateHint?.trim() ?? "",
    result.ghRateLimitHint?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatStdoutContentForModel(result: BashOutput): string {
  let processedStdout = formatStdoutForModel(result.stdout);
  const persistedOutputPath =
    result.status === "backgrounded"
      ? undefined
      : (result.persistedOutputPath ?? result.rawOutputPath);
  if (persistedOutputPath) {
    processedStdout = formatCompactPersistedOutputContent({
      content: processedStdout,
      originalBytes: observedOutputBytes(result),
      persistedPath: persistedOutputPath,
    });
  }
  return processedStdout;
}

function stringifyFallback(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function formatStdoutForModel(stdout: string): string {
  if (!stdout) return "";
  return stdout.replace(/^(\s*\n)+/, "").trimEnd();
}

function formatStderrForModel(result: BashOutput): string {
  let message = result.stderr.trim();
  if (result.interrupted) {
    if (message) message += "\n";
    message += "<error>Command was aborted before completion</error>";
  }
  return message;
}

export function isBashOutputProviderError(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return isBashProviderErrorStatus(output);
}

function formatBackgroundInfoForModel(result: BashOutput): string {
  const info = formatBackgroundStartForModel(result);
  if (!info || !result.backgroundSessionCwd) return info;
  return `${info}\nSession cwd remains ${result.backgroundSessionCwd}; ${BACKGROUND_CWD_UNCHANGED}`;
}

function formatBackgroundStartForModel(result: BashOutput): string {
  if (!result.backgroundTaskId) return "";
  const outputText = formatBackgroundOutputPaths(result);
  if (result.assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${result.backgroundTaskId}. It is still running \u2014 you will be notified when it completes.${outputText} In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
  }
  if (result.backgroundedByUser) {
    return `Command was manually backgrounded by user with ID: ${result.backgroundTaskId}.${stripTrailingPeriod(outputText)}`;
  }
  const readHint = outputText
    ? ` To check interim output, use ${READ_TOOL_NAME} on that file path.`
    : "";
  const notification = result.backgroundInSyncSubagent
    ? SYNC_SUBAGENT_NOTIFICATION
    : "You will be notified when it completes.";
  if (result.timedOutAfterMs !== undefined) {
    const timeoutSeconds = Math.max(1, Math.round(result.timedOutAfterMs / 1000));
    return `Command did not complete within its ${timeoutSeconds}s timeout and was moved to the background (ID: ${result.backgroundTaskId}).${outputText} ${notification}${readHint}`;
  }
  return `Command running in background with ID: ${result.backgroundTaskId}.${outputText} ${notification}${readHint}`;
}

function formatBackgroundOutputPaths(result: BashOutput): string {
  // Bash 的 stdout/stderr 已直接写入单一输出文件，继续追加 stdout/stderr legacy path
  // 会让模型看到与单一输出文件不一致的双路径信息。
  const outputPath =
    result.rawOutputPath ??
    result.persistedOutputPath ??
    result.stdoutPersistedOutputPath ??
    result.stderrPersistedOutputPath;
  return outputPath ? ` Output is being written to: ${outputPath}.` : "";
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function observedOutputBytes(result: BashOutput): number {
  if (typeof result.persistedOutputSize === "number") return result.persistedOutputSize;
  if (
    typeof result.stdoutPersistedOutputSize === "number" ||
    typeof result.stderrPersistedOutputSize === "number"
  ) {
    return (result.stdoutPersistedOutputSize ?? 0) + (result.stderrPersistedOutputSize ?? 0);
  }
  return (
    (result.stdoutBytes ?? Buffer.byteLength(result.stdout, "utf8")) +
    (result.stderrBytes ?? Buffer.byteLength(result.stderr, "utf8"))
  );
}

function maybeImageContent(result: BashOutput): ModelMessageContent | undefined {
  if (!result.isImage) return undefined;
  const parsed = parseImageDataUrl(result.stdout, { allowWhitespace: true });
  if (!parsed) return undefined;
  return [
    {
      type: "image",
      mediaType: parsed.mediaType,
      dataUrl: parsed.dataUrl,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
