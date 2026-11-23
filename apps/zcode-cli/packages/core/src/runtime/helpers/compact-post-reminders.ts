import { join, resolve } from "node:path";
import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";
import type { ReadFileStateEntry, ReadFileStateMap } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { normalizedInstructionSources } from "../../context/sections/request-user-context.js";
import { estimateTokens } from "../../context/utils.js";
import { MEMORY_INDEX_FILE_NAME } from "../../memory/index-content.js";
import {
  formatReadTextToolResult,
  readFileForCompactRestore,
  type PostCompactFileRead,
} from "../../tool/handlers/read.js";
import { READ_FILE_UNCHANGED_STUB } from "../../tool/handlers/read-text.js";
import {
  createReadFileStatePathKey,
  requestedPathField,
  setReadFileStateEntry,
} from "../../tool/read-file-state.js";
import { resolveApprovedPlanFilePath } from "./plan-file-continuity.js";

export type { PostCompactFileRead } from "../../tool/handlers/read.js";

const POST_COMPACT_MAX_FILES = 5;
const POST_COMPACT_MAX_FILE_TOKENS = 5_000;
const POST_COMPACT_MAX_TOTAL_TOKENS = 50_000;
const POST_COMPACT_RESTORE_SOURCE_TOOLS = new Set(["Read", "Write", "Edit"]);
const SKIPPED_FILE_READ: PostCompactFileRead = { type: "skipped" };

export interface PostCompactFileRestore {
  /** compaction 附件：补回的文件内容或引用提示，按选择顺序。 */
  entries: RuntimeMessageEntry[];
  /** compaction 持久化成功后写入 live 表的记录，按选择顺序（最新在前）。 */
  readFileStateEntries: ReadFileStateEntry[];
}

/**
 * compaction 补回文件：按时间从新到旧选文件，重读磁盘上的当前内容。
 * 规则见 docs/design/v2/rewind-compact.md 的“文件恢复”。
 */
export async function buildPostCompactFileRestore(input: {
  excludedPaths?: readonly string[];
  maxFileTokens?: number;
  maxFiles?: number;
  maxTotalTokens?: number;
  preservedEntries?: readonly RuntimeMessageEntry[];
  /** 一次拿到全部候选（规范化路径与工具输入的原始写法），按同样顺序返回读取结果。 */
  readFiles: (
    filePaths: readonly string[],
    requestedPaths: readonly (string | undefined)[],
  ) => Promise<PostCompactFileRead[]>;
  readFileState?: ReadFileStateMap;
  /** 保留段里相对路径的 Read 按它解析，和 Read 工具一致。 */
  workingDirectory?: string;
}): Promise<PostCompactFileRestore> {
  const maxFileTokens = input.maxFileTokens ?? POST_COMPACT_MAX_FILE_TOKENS;
  const maxTotalTokens = input.maxTotalTokens ?? POST_COMPACT_MAX_TOTAL_TOKENS;
  const excludedKeys = new Set(
    [
      ...(input.excludedPaths ?? []),
      ...collectPreservedReadFilePaths(input.preservedEntries ?? [], input.workingDirectory),
    ].map((filePath) => createReadFileStatePathKey(filePath)),
  );
  // 先选再读：读取失败或被跳过的文件照样占名额。
  const candidates = Array.from(input.readFileState?.values() ?? [])
    .filter((entry) => entry.sourceTool && POST_COMPACT_RESTORE_SOURCE_TOOLS.has(entry.sourceTool))
    .filter((entry) => !shouldSkipPostCompactReadStatePath(entry.path))
    .filter((entry) => !excludedKeys.has(createReadFileStatePathKey(entry.path)))
    .sort((left, right) => restoreRecency(right) - restoreRecency(left))
    .slice(0, input.maxFiles ?? POST_COMPACT_MAX_FILES);
  const restore: PostCompactFileRestore = { entries: [], readFileStateEntries: [] };
  if (candidates.length === 0) return restore;
  const reads = await input.readFiles(
    candidates.map((entry) => entry.path),
    candidates.map((entry) => entry.requestedPath),
  );

  let totalTokens = 0;
  candidates.forEach((candidate, index) => {
    const restored = toRestoredFile(candidate.path, reads[index]!, maxFileTokens);
    if (!restored) return;
    const tokens = restored.entries.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);
    // 总量超限的文件丢掉，不放提示，也不写记录；后面更小的文件仍可放入。
    if (totalTokens + tokens > maxTotalTokens) return;
    totalTokens += tokens;
    restore.entries.push(...restored.entries);
    // 写回的记录保留原始写法，下一次 compaction 仍按它判定 deny。
    if (restored.readFileStateEntry) {
      restore.readFileStateEntries.push({
        ...restored.readFileStateEntry,
        ...requestedPathField(candidate.requestedPath, restored.readFileStateEntry.path),
      });
    }
  });
  return restore;
}

/** 运行时的补回：排除 plan 文件、上下文前缀里的指令文件和 MEMORY.md，读权限 deny 的文件跳过。 */
export function restorePostCompactFiles(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    preservedEntries: readonly RuntimeMessageEntry[];
    traceContext: TraceContext;
  },
): Promise<PostCompactFileRestore> {
  const instructions = runtime.contextSourceSnapshot?.userInstructions;
  return buildPostCompactFileRestore({
    excludedPaths: [
      resolveApprovedPlanFilePath({
        sessionId: runtime.sessionId,
        workspaceRoot: runtime.workspaceRoot,
      }),
      ...(runtime.memoryRoot ? [join(runtime.memoryRoot, MEMORY_INDEX_FILE_NAME)] : []),
      ...(instructions
        ? normalizedInstructionSources(instructions).map((source) => source.filePath)
        : []),
    ],
    preservedEntries: input.preservedEntries,
    readFiles: (filePaths, requestedPaths) =>
      readPostCompactFiles(runtime, filePaths, requestedPaths, input),
    readFileState: runtime.readFileState,
    workingDirectory: runtime.workingDirectory,
  });
}

/**
 * 持久化成功后调用：原地清空执行器共享的同一个 Map，再写入补回的记录。
 * Map 顺序即最近写入顺序，所以从最旧写到最新，最新的文件排在最后，和其他写入方一致。
 */
export function replaceReadFileStateAfterCompact(
  readFileState: ReadFileStateMap,
  entries: readonly ReadFileStateEntry[],
): void {
  readFileState.clear();
  for (const entry of [...entries].reverse()) setReadFileStateEntry(readFileState, entry);
}

async function readPostCompactFiles(
  runtime: AgentRuntimeInternal,
  filePaths: readonly string[],
  requestedPaths: readonly (string | undefined)[],
  input: { abortSignal?: AbortSignal; traceContext: TraceContext },
): Promise<PostCompactFileRead[]> {
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort) return filePaths.map(() => SKIPPED_FILE_READ);
  let denied: boolean[];
  try {
    // 只跳过 deny；ask 规则照常读取，不弹确认。规则加载失败时一个都不读。
    // 修复原因：规则按原始字符串匹配，只用规范化后的绝对路径判定时，`Read(.env)` 这类相对写法的
    // deny 规则拦不住补回，模型同一写法 Read 被拒的文件会被补回。原始写法和规范化路径各判定一次，
    // 任一命中 deny 就跳过。
    const forms = filePaths.map((filePath, index) => {
      const requestedPath = requestedPaths[index];
      return requestedPath === undefined ? [filePath] : [filePath, requestedPath];
    });
    const verdicts = await runtime.executor.areReadsDeniedWithoutPrompt(
      forms.flat(),
      input.traceContext,
    );
    let cursor = 0;
    denied = forms.map((paths) => {
      const hit = verdicts.slice(cursor, cursor + paths.length).includes(true);
      cursor += paths.length;
      return hit;
    });
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    logSkippedFileRestore(runtime, input.traceContext, error);
    return filePaths.map(() => SKIPPED_FILE_READ);
  }
  return Promise.all(
    filePaths.map(async (filePath, index) => {
      if (denied[index]) {
        runtime.logger?.info("Post-compact file restore skipped a denied file", {
          ...traceContextToLogContext(input.traceContext),
          event: "compact.file_restore.denied",
          filePath,
          module: "core.runtime",
          status: "completed",
        });
        return SKIPPED_FILE_READ;
      }
      try {
        return await readFileForCompactRestore({
          abortSignal: input.abortSignal,
          filePath,
          fileSystemPort,
          trace: input.traceContext,
          workingDirectory: runtime.workingDirectory,
          workspaceRoot: runtime.workspaceRoot,
        });
      } catch (error) {
        // 取消时整个 compact 取消；其他读取失败只跳过这个文件，它仍占名额。
        if (input.abortSignal?.aborted) throw error;
        logSkippedFileRestore(runtime, input.traceContext, error, filePath);
        return SKIPPED_FILE_READ;
      }
    }),
  );
}

function logSkippedFileRestore(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  error: unknown,
  filePath?: string,
): void {
  runtime.logger?.warn("Post-compact file restore skipped a file", {
    ...traceContextToLogContext(traceContext),
    // 抛出的值不一定是对象（可能是 null），取 code 不能让整个 compaction 失败。
    errorCode: (error as { code?: unknown } | null)?.code,
    event: "compact.file_restore.skipped",
    filePath,
    module: "core.runtime",
    status: "failed",
  });
}

// 正文是两条（调用说明、结果），来源 resume_referenced_session_context，在 user 侧；引用提示是一条，
// 来源 compact_file_reference，和其余 compaction 附件一样投影（docs/design/v2/rewind-compact.md「文件恢复」）。
// 修复原因：正文曾是一条 `\n` 相连的 system 附件，和 Agent 列表等合在一起；模型看到的补回和读文件的结果形态不同。
function toRestoredFile(
  filePath: string,
  read: PostCompactFileRead,
  maxFileTokens: number,
): { entries: RuntimeAttachmentEntry[]; readFileStateEntry?: ReadFileStateEntry } | undefined {
  if (read.type === "skipped") return undefined;
  if (read.type === "too_large") return { entries: [compactFileReferenceEntry(filePath)] };
  if (read.output.truncatedByTokenCap || estimateTokens(read.output.content) > maxFileTokens) {
    // 模型只看到引用提示，记录为部分视图：之后 Read 返回正文，Edit / Write 要求先完整读取。
    return {
      entries: [compactFileReferenceEntry(filePath)],
      readFileStateEntry: { ...read.readFileStateEntry, isPartialView: true },
    };
  }
  return {
    entries: [
      systemReminderAttachmentEntry(
        "resume_referenced_session_context",
        `Called the Read tool with the following input: ${JSON.stringify({ file_path: filePath })}`,
      ),
      systemReminderAttachmentEntry(
        "resume_referenced_session_context",
        `Result of calling the Read tool:\n${formatReadTextToolResult(read.output)}`,
      ),
    ],
    readFileStateEntry: read.readFileStateEntry,
  };
}

// 本进程写入的记录按文件 mtime 排序；冷恢复出的记录按读取时间排序。缺 mtime 时用读取时间。
function restoreRecency(entry: ReadFileStateEntry): number {
  if (entry.restoredFromSession) return entry.readAt.getTime();
  return entry.mtimeMs ?? entry.readAt.getTime();
}

function compactFileReferenceEntry(filePath: string): RuntimeAttachmentEntry {
  return systemReminderAttachmentEntry(
    "compact_file_reference",
    `Note: ${filePath} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`,
  );
}

// 保留段里 Read 过的文件已在上下文中，不补回；返回 file_unchanged 的 Read 只指向已被摘要的旧结果，不算。
function collectPreservedReadFilePaths(
  entries: readonly RuntimeMessageEntry[],
  workingDirectory: string | undefined,
): string[] {
  const unchangedToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (!("message" in entry) || entry.message.role !== "tool") continue;
    const { content, toolCallId } = entry.message;
    if (toolCallId && content === READ_FILE_UNCHANGED_STUB) unchangedToolCallIds.add(toolCallId);
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    if (entry.message.role !== "assistant" || !entry.message.toolCalls) continue;
    for (const toolCall of entry.message.toolCalls) {
      if (toolCall.name !== "Read" || unchangedToolCallIds.has(toolCall.id)) continue;
      const filePath = readToolCallFilePath(toolCall.input);
      // 修复原因：read-state 记录用解析后的绝对路径，相对路径的 Read 不解析就排除不掉。
      if (filePath) paths.push(workingDirectory ? resolve(workingDirectory, filePath) : filePath);
    }
  }
  return paths;
}

function readToolCallFilePath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function shouldSkipPostCompactReadStatePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes("/.codex/memories/") ||
    normalized.includes("/docs/superpowers/plans/") ||
    normalized.includes("/.git/")
  );
}
