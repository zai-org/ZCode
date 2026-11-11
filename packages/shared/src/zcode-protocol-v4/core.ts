// ZCode Protocol v4 —— 数据模型草稿（未冻结，schema 定型以黄金测试为准）。
// 本包纪律：只放 schema 类型 + 纯函数，禁止任何运行时/IO/传输逻辑。
import { z } from "zod";
import { VIDEO_INPUT_MAX_BYTES } from "../zcode-media-policy.js";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";

/** V4 物理 wire 协议版本；projection snapshot 继续独立使用 protocolVersion=1。 */
export const V4_WIRE_PROTOCOL_VERSION = 3 as const;

/** V3 row target：display row 与稳定实体必须成对提交并由同一权威投影校验。 */
export const conversationRowTargetSchema = z
  .object({
    rowId: z.number().int().nonnegative(),
    entityId: z.string().trim().min(1),
  })
  .strict();
export type ConversationRowTarget = z.infer<typeof conversationRowTargetSchema>;

// 时钟规则：Unix ms，一律 CLI 时钟；客户端禁止拿本地时钟与协议 Timestamp 相减。
export const timestampSchema = z.number();
export type Timestamp = z.infer<typeof timestampSchema>;

// delivery profile：只存在于 CLI flush 管线的参数表，客户端代码禁止出现 profile 变量。
export const streamablePathSchema = z.enum(["text", "inputText", "output.text", "summaryText"]);
export type StreamablePath = z.infer<typeof streamablePathSchema>;

export interface DeliveryProfile {
  desktopOnlyRows: boolean;
  flushWindowMs: number;
  streamPaths: Record<StreamablePath, boolean>;
  streamOutputCapBytes: number;
  toolProgress: boolean;
}

export const DELIVERY_PROFILES = {
  continuous: {
    desktopOnlyRows: true,
    flushWindowMs: 30,
    streamPaths: {
      text: true,
      inputText: true,
      "output.text": true,
      summaryText: true,
    },
    streamOutputCapBytes: 262144,
    toolProgress: false,
  },
  replayable: {
    desktopOnlyRows: false,
    flushWindowMs: 150,
    streamPaths: {
      text: true,
      inputText: false,
      "output.text": false,
      summaryText: false,
    },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} as const satisfies Record<string, DeliveryProfile>;

export type DeliveryProfileName = keyof typeof DELIVERY_PROFILES;

// 常量与限额（初始值，实测调参）。
export const PROTOCOL_V4_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  logicalFrameAssemblyMaxFragments: 1024,
  logicalFrameAssemblyMaxConcurrent: 32,
  logicalFrameAssemblyMaxStagedBytes: 32 * 1024 * 1024,
  logicalFrameAssemblyTimeoutMs: 30_000,
  transportEnvelopeIdMaxChars: 256,
  subscriberBufferMaxOps: 500,
  subscriberBufferMaxBytes: 1024 * 1024,
  eventRetentionPerSession: 2000,
  snapshotTailWindowRows: 60,
  rowsRangeMaxLimit: 200,
  toolOutputFinalHeadBytes: 32 * 1024,
  toolOutputFinalTailBytes: 32 * 1024,
  goalVerificationsRetained: 20,
  pendingCommandsDisplayMax: 32,
  commandPendingTtlMs: 24 * 60 * 60 * 1000,
  idempotencyTablePerSession: 512,
  conversationQueryTimeoutMs: 10_000,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentChunkMaxBytes: 512 * 1024,
  attachmentPreviewMaxBytes: VIDEO_INPUT_MAX_BYTES,
  // share 选择阶段的 metadata-only stat 曾复用 attachmentPreviewMaxBytes
  // （30MiB）作为 totalBytes 上限，于是超过该值的附件在 schema 校验就抛错，
  // 「容量超限」这个本应确定阻断的分类反而被降级成 deferred 并静默丢内容。
  // stat 不搬运字节，只需要一个足够表达真实文件大小的上界。
  attachmentStatMaxBytes: 2 * 1024 * 1024 * 1024,
  attachmentPreviewMaxChunks: VIDEO_INPUT_MAX_BYTES / (512 * 1024),
  attachmentReadCacheMaxBytes: VIDEO_INPUT_MAX_BYTES,
  attachmentReadCacheTtlMs: 30_000,
  attachmentUploadMaxChunks: 64,
  attachmentUploadMaxConcurrent: 16,
  attachmentUploadMaxStagedBytes: 64 * 1024 * 1024,
  attachmentUploadTtlMs: 5 * 60_000,
  attachmentUnreferencedTtlMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * 会触发冷恢复的 V4 查询与命令信封上的可选 `workspace`（docs/git/worktree.md §9.3）。
 * 只由 Host 按当前 attachment 可信注入，renderer 不传；CLI 冷恢复只用它确定会话身份。
 * 缺席时 CLI 按存储的 cwd 重建身份：受管 worktree 会话的 key 会变成 worktree 路径，
 * 之后的反向请求被 Host 以"不属于本 CLI"拒绝，任务无法打开或发送。
 */
export const v4ColdResumeWorkspaceSchema = zcodeWorkspaceRefSchema.optional();
