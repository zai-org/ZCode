import { ReadOutputSchema } from "@zcode/contracts";
import { findLatestReadFileState, hashReadFileStateContent } from "./read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

export const READ_FILE_STATE_METADATA_SCHEMA_VERSION = 1;
// `CreateWorkflow` / `AmendWorkflow` / `FillWorkflowHole`：内联草稿（或 fill 文件）的字节就是模型那次
// 调用的 `script` 入参，与 Write 同理记作完整视图（handlers/workflow-draft-read-state.ts）。
export type PersistedReadFileStateTool =
  | "Read"
  | "Write"
  | "Edit"
  | "CreateWorkflow"
  | "AmendWorkflow"
  | "FillWorkflowHole";

export interface PersistedReadFileStateMetadata {
  schemaVersion: typeof READ_FILE_STATE_METADATA_SCHEMA_VERSION;
  tool: PersistedReadFileStateTool;
  path: string;
  /**
   * live 记录正文的 sha256，快照不存正文本身。
   * 修复原因：原来存正文全文，Edit 每次都存一份修改后的整份文件，长会话打开时全部 part 被读出
   * 解析，JS 堆被撑满。恢复后正文只用于判断"内容是否相同"，哈希就够了
   * （17-read-file-state-resume.md「快照不存正文」）。
   */
  contentSha256: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAtMs: number;
  revisionId: string;
  mtimeMs: number;
  sizeBytes: number;
  /**
   * 执行器在工具记录快照时取的序号（与写 live 状态在同一个同步步骤里），即 live 的写入顺序；
   * 只在同一 assistant 内比较。旧记录没有这个字段。
   */
  snapshotIndex?: number;
}

/** 冷恢复或 rewind 读到的快照：新快照只有 contentSha256；升级前的旧快照只有正文 content，不迁移，照旧按正文比较。 */
export type RestorableReadFileStateMetadata = Omit<
  PersistedReadFileStateMetadata,
  "contentSha256"
> &
  ({ content: string; contentSha256?: undefined } | { content?: undefined; contentSha256: string });

export function createReadFileStateMetadata(input: {
  completedAt: Date;
  output: unknown;
  readFileState?: ReadFileStateMap;
  toolInput: unknown;
  toolName: string;
}): PersistedReadFileStateMetadata | undefined {
  if (input.toolName !== "Read") return undefined;

  const parsedOutput = ReadOutputSchema.safeParse(input.output);
  if (!parsedOutput.success) return undefined;
  const output = parsedOutput.data;
  // 只有真实读到内容的结果记录快照；file_unchanged 不记录（见 handlers/read.ts）。
  if (output.type !== "text") return undefined;

  const toolInput = asRecord(input.toolInput);
  const offset = toolInput ? numberField(toolInput, "offset") : undefined;
  const limit = toolInput ? numberField(toolInput, "limit") : undefined;
  const latest = findLatestReadFileState(input.readFileState, output.filePath);
  // 每个文件只有一条；只有它就是这次请求的视图时才记录，避免把别的视图写进这次的 metadata。
  const entry =
    latest && (latest.offset ?? 1) === (offset ?? 1) && latest.limit === limit ? latest : undefined;
  return createReadFileStateMetadataFromEntry({
    completedAt: input.completedAt,
    entry,
    toolName: "Read",
  });
}

export function createReadFileStateMetadataFromEntry(input: {
  completedAt: Date;
  entry?: ReadFileStateEntry;
  toolName: PersistedReadFileStateTool;
}): PersistedReadFileStateMetadata | undefined {
  const entry = input.entry;
  if (!entry) return undefined;
  if (entry.mtimeMs === undefined || entry.sizeBytes === undefined || !entry.revisionId) {
    // resume stale guard 必须恢复文件时间戳和 adapter revision；
    // 缺 freshness metadata 的历史文件状态不能冒充已读，否则会放过 stale 写入。
    return undefined;
  }
  // 快照只来自刚写入、带正文的 live 记录；冷恢复或 rewind 重建出的只有哈希的记录不会再生成快照。
  if (entry.content === undefined) return undefined;

  return {
    schemaVersion: READ_FILE_STATE_METADATA_SCHEMA_VERSION,
    tool: input.toolName,
    path: entry.path,
    contentSha256: hashReadFileStateContent(entry.content),
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
    isPartialView: entry.isPartialView,
    readAtMs: input.completedAt.getTime(),
    revisionId: entry.revisionId,
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
  };
}

export function parseReadFileStateMetadata(
  metadata: unknown,
): RestorableReadFileStateMetadata | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  const readState = asRecord(record.readFileState);
  if (!readState) return undefined;

  if (readState.schemaVersion !== READ_FILE_STATE_METADATA_SCHEMA_VERSION) return undefined;
  const tool = stringField(readState, "tool");
  if (!isPersistedReadFileStateTool(tool)) return undefined;

  const path = stringField(readState, "path");
  // 按字段区分新旧快照，不升 schemaVersion：旧版本恢复时要求 content，读到只有哈希的快照会跳过。
  const contentSha256 = stringField(readState, "contentSha256");
  const content = stringField(readState, "content");
  const body = contentSha256 ? { contentSha256 } : content === undefined ? undefined : { content };
  const readAtMs = numberField(readState, "readAtMs");
  const isPartialView = booleanField(readState, "isPartialView");
  const revisionId = stringField(readState, "revisionId");
  const mtimeMs = numberField(readState, "mtimeMs");
  const sizeBytes = numberField(readState, "sizeBytes");
  if (
    !path ||
    body === undefined ||
    readAtMs === undefined ||
    isPartialView === undefined ||
    !revisionId ||
    mtimeMs === undefined ||
    sizeBytes === undefined
  ) {
    return undefined;
  }
  const offset = numberField(readState, "offset");
  const limit = numberField(readState, "limit");
  const snapshotIndex = numberField(readState, "snapshotIndex");

  return {
    schemaVersion: READ_FILE_STATE_METADATA_SCHEMA_VERSION,
    tool,
    path,
    ...body,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    isPartialView,
    readAtMs,
    revisionId,
    mtimeMs,
    sizeBytes,
    ...(snapshotIndex === undefined ? {} : { snapshotIndex }),
  };
}

function isPersistedReadFileStateTool(value: unknown): value is PersistedReadFileStateTool {
  return (
    value === "Read" ||
    value === "Write" ||
    value === "Edit" ||
    value === "CreateWorkflow" ||
    value === "AmendWorkflow"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
