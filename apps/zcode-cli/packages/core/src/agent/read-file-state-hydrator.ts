import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  ToolPart,
} from "@zcode/contracts";
import {
  parseReadFileStateMetadata,
  type PersistedReadFileStateTool,
  type RestorableReadFileStateMetadata,
} from "../tool/read-file-state-metadata.js";
import { READ_FILE_UNCHANGED_STUB } from "../tool/handlers/read-text.js";
import {
  normalizeReadFileStateMtimeMs,
  requestedPathField,
  setReadFileStateEntry,
} from "../tool/read-file-state.js";
import type { ReadFileStateMap } from "../tool/types.js";
import { activeSessionMessages } from "./session-history-hydrator.js";

export interface ReadFileStateHydrationResult {
  restoredCount: number;
  skippedUnreadableEditCount: number;
}

type CompletedToolPart = ToolPart & {
  state: ToolPart["state"] & {
    output: unknown;
    status: "completed";
  };
};

export async function hydrateReadFileStateFromSession(input: {
  branchCutAfterMessageId?: MessageId;
  messages: MessageWithParts[];
  /**
   * resume 传 true：恢复出的记录带 restoredFromSession，compaction 补回按读取时间排序。
   * rewind 在同一进程里重建，不传，和 live 记录一样按 mtime 排序。
   */
  markRestoredFromSession?: boolean;
  readFileState: ReadFileStateMap;
  /** rewind 传 true：保留会话开始由 context 写入的记录；resume 由 context 初始化重新写入。 */
  retainContextSeeds?: boolean;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<ReadFileStateHydrationResult> {
  // 修复原因：rewind 时整表清空会丢掉 MEMORY.md 的 context 记录，而 rewind 不会重新加载
  // context，之后 Write MEMORY.md 报未读。被回退部分读写过它时，记录已被工具记录覆盖，照常清掉。
  for (const [key, entry] of input.readFileState) {
    if (!(input.retainContextSeeds && entry.seededFromContext)) input.readFileState.delete(key);
  }
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });

  const result: ReadFileStateHydrationResult = {
    restoredCount: 0,
    skippedUnreadableEditCount: 0,
  };

  for (const message of activeMessages) {
    if (message.info.role !== "assistant") continue;

    for (const snapshot of inSnapshotOrder(dedupeParts(message.parts))) {
      if (restoreSnapshot(input.readFileState, snapshot, input.markRestoredFromSession)) {
        result.restoredCount++;
      }
    }
  }

  return result;
}

// range Read 与 same-runtime 一样恢复：按 live 的更新顺序覆盖，每个文件留最近一次视图。
// 修复原因：只恢复完整 Read 时，"完整 → 范围 → 重启 → 完整"会命中旧的完整视图返回
// Wasted call，而 live 返回正文；同一段历史在重启前后结果不同。
// Write / Edit 与内联草稿（模型亲手写的字节）只恢复成功时持久化的完整快照：resume 时不能读取
// 当前磁盘来"补全"状态，外部手动保存会被误认证为 agent 已读。
function restoreSnapshot(
  readFileState: ReadFileStateMap,
  { requestedPath, snapshot }: RestorableSnapshot,
  markRestoredFromSession: boolean | undefined,
): boolean {
  const fullWindow = isHistoricalFullReadWindow(snapshot);
  if (snapshot.tool !== "Read" && !fullWindow) return false;
  // 新快照只有正文哈希，升级前的旧快照带正文；都原样带进 live 记录，写前比较见 readFileStateContentMatches。
  const body =
    snapshot.content === undefined
      ? { contentSha256: snapshot.contentSha256 }
      : { content: snapshot.content };
  setReadState(readFileState, snapshot.path, body, {
    isPartialView: snapshot.isPartialView,
    ...requestedPathField(requestedPath, snapshot.path),
    ...(fullWindow ? {} : { offset: snapshot.offset, limit: snapshot.limit }),
    mtimeMs: normalizeReadFileStateMtimeMs(snapshot.mtimeMs),
    readAt: new Date(snapshot.readAtMs),
    ...(markRestoredFromSession ? { restoredFromSession: true as const } : {}),
    revisionId: snapshot.revisionId,
    sizeBytes: snapshot.sizeBytes,
    sourceTool: snapshot.tool,
  });
  return true;
}

function setReadState(
  readFileState: ReadFileStateMap,
  filePath: string,
  body: { content: string } | { contentSha256: string },
  metadata: {
    isPartialView?: boolean;
    limit?: number;
    mtimeMs?: number;
    offset?: number;
    readAt: Date;
    requestedPath?: string;
    restoredFromSession?: true;
    revisionId?: string;
    sizeBytes: number;
    sourceTool?: PersistedReadFileStateTool;
  },
): void {
  setReadFileStateEntry(readFileState, {
    path: filePath,
    ...(metadata.requestedPath === undefined ? {} : { requestedPath: metadata.requestedPath }),
    ...body,
    offset: metadata.offset,
    limit: metadata.limit,
    isPartialView: metadata.isPartialView ?? false,
    readAt: metadata.readAt,
    sourceTool: metadata.sourceTool,
    revisionId: metadata.revisionId,
    mtimeMs: metadata.mtimeMs,
    sizeBytes: metadata.sizeBytes,
    ...(metadata.restoredFromSession ? { restoredFromSession: true } : {}),
  });
}

interface HistoricalReadWindow {
  limit?: number;
  offset?: number;
}

function isHistoricalFullReadWindow({ offset, limit }: HistoricalReadWindow): boolean {
  return (offset ?? 1) <= 1 && limit === undefined;
}

function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

/**
 * 同一 assistant 内的快照按 `snapshotIndex` 排序，即 live 写入读取状态的顺序。
 *
 * 修复原因：part 在工具开始前按声明顺序落盘、完成时原地更新；工具结果返回的先后也不等于写入先后。
 * 并行的完整 Read 后写入时，live 最后是完整视图，按 part 顺序重放却留下范围视图，重启后同一次完整
 * Read 返回正文而不是 file_unchanged。有一个快照缺 `snapshotIndex`（旧数据）就保持 part 原顺序。
 *
 * 只认 completed tool part 上、由同名工具记录的结构化快照。resume 不从 provider-visible cat-n 文本
 * 恢复；只有带 mtimeMs / revisionId / sizeBytes 的快照才能支撑后续 stale guard。
 *
 * 修复原因：旧数据里返回 file_unchanged 的 Read 也存了快照（当时最新记录的副本）。按它重放会把读取
 * 时间改成这次调用的时间；之前那次真实读取不在 active history 里时，还会恢复出模型看不到原文的视图。
 * 跳过这类结果，由之前那次真实读取恢复。
 */
function inSnapshotOrder(parts: MessagePart[]): RestorableSnapshot[] {
  const snapshots = parts.flatMap((part) => {
    if (!isCompletedToolPart(part)) return [];
    if (part.tool === "Read" && part.state.output === READ_FILE_UNCHANGED_STUB) return [];
    const snapshot = parseReadFileStateMetadata(part.state.metadata);
    return snapshot?.tool === part.tool ? [{ requestedPath: inputFilePath(part), snapshot }] : [];
  });
  if (snapshots.some(({ snapshot }) => snapshot.snapshotIndex === undefined)) return snapshots;
  return snapshots.toSorted(
    (left, right) => (left.snapshot.snapshotIndex ?? 0) - (right.snapshot.snapshotIndex ?? 0),
  );
}

interface RestorableSnapshot {
  snapshot: RestorableReadFileStateMetadata;
  /** 工具输入里 `file_path` 的原始写法；compaction 补回按它再判定一次 deny。 */
  requestedPath?: string;
}

// 修复原因：原始写法原来随快照持久化，这个字段出现之前写下的记录没有它，升级后冷恢复，compaction 补回
// 只按规范化路径判定 deny，相对写法的规则拦不住。tool part 一直存着输入，从这里取，新旧记录相同。
function inputFilePath(part: CompletedToolPart): string | undefined {
  const filePath = part.state.input.file_path;
  return typeof filePath === "string" ? filePath : undefined;
}

function isCompletedToolPart(part: MessagePart): part is CompletedToolPart {
  return part.type === "tool" && part.state.status === "completed" && "output" in part.state;
}
