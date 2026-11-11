import { localTtftFactsSchema } from "../local-ttft/contract.js";
/* eslint-disable max-lines -- 三个 topic 的 logical/physical/candidate schema 必须共享同一通用传输声明，避免跨文件分叉。 */
// 传输外壳：连接握手 / 订阅 / 帧信封。
// 阶段为类型占位（后半接通道层时启用），数据形状已按规范定稿。
import { z } from "zod";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import {
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  conversationRowTargetSchema,
  timestampSchema,
  v4ColdResumeWorkspaceSchema,
} from "./core.js";
import { conversationDeltaSchema } from "./delta.js";
import { displayConversationRowSchema, toolCallRowSchema } from "./rows.js";
import { sessionsIndexDeltaSchema, sessionsIndexSnapshotSchema } from "./sessions-index.js";
import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import { conversationSnapshotSchema } from "./snapshot.js";
import { workspaceConfigDeltaSchema, workspaceConfigSnapshotSchema } from "./workspace-config.js";
import { createTopicWireFrameSchema, topicWireFrameCandidateSchema } from "./wire.js";

// ── 连接与握手 ──
export const hostCapabilitiesSchema = z.object({
  nativeDialogs: z.boolean(),
  localTerminal: z.boolean(),
  // ws binary（relay 链路探测用）。
  binaryFrames: z.boolean(),
  compression: z.enum(["none", "permessage-deflate"]),
  // Wire-compatible：旧 Host 缺失等价于 false；调用方必须用 === true 判断。
  workspaceHookReview: z.boolean().optional(),
  independentPlanState: z.boolean().optional(),
  genUiContext: z.boolean().optional(),
  /**
   * 本 Host 会发 `workflowRun.*` 键级增量（delta.ts 的两条 op），因而 `workflowRuns` 的
   * actors / nodes 可以到 1024 而不是旧界的 256。没有这个位的消费者收到的仍是整键
   * `state.updated`，并且先经 `clampWorkflowRunsForLegacy` 裁到旧界。
   */
  workflowRunDeltas: z.boolean().optional(),
  pluginDiscovery: z.boolean().optional(),
  historyFirst: z.boolean().optional(),
  /**
   * 本 Host 开启并转发 `v4/conversation/inputPrediction`。旧 Host 缺失等价于 false，
   * 手机必须用 === true 判断，否则不发预测请求。
   */
  inputPrediction: z.boolean().optional(),
  /** 本 Host 支持 rowsRange 的 `residency: "resident-only"`；缺失等价于 false，手机不得预加载。 */
  residentRowsRange: z.boolean().optional(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const helloMessageSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    connectionId: z.string(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    deliveryProfile: z.enum(["continuous", "replayable"]),
    // 首次时钟校准。
    serverTime: timestampSchema,
    capabilities: hostCapabilitiesSchema,
    // 此处只留位。
    auth: z.object({ userId: z.string().optional() }),
  })
  .strict()
  .superRefine((hello, context) => {
    const expectedProfile = hello.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    if (hello.deliveryProfile !== expectedProfile) {
      context.addIssue({
        code: "custom",
        message: "trusted clientMode and deliveryProfile must match",
        path: ["deliveryProfile"],
      });
    }
  });
export type HelloMessage = z.infer<typeof helloMessageSchema>;

// clientMode 连接级注册一次，不进 command 信封。
export const clientHelloSchema = z
  .object({
    kind: z.literal("clientHello"),
    protocolVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
    clientId: z.string(),
    clientKind: z.enum(["desktop", "web", "mobileRemote", "mobileApp"]).optional(),
    appVersion: z.string(),
    // 缺失代表旧客户端，不具备 Settings-centered review UI。
    capabilities: z
      .object({
        workspaceHookReviewUi: z.boolean().optional(),
        /**
         * 本客户端认得 `workflowRun.*` 增量。⚠ 声明规则是**单向**的：客户端只有在 Host 的
         * hello 里见到 `workflowRunDeltas === true` 时才能带上这个键——这个 capabilities 对象
         * 是 `.strict()` 的，老 Host 见到不认识的键会整条 clientHello 解析失败、连接握不上手。
         */
        workflowRunDeltas: z.boolean().optional(),
        pluginDiscoveryUi: z.boolean().optional(),
        historyFirst: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ClientHello = z.infer<typeof clientHelloSchema>;

export function hostSupportsWorkspaceHookReview(capabilities: HostCapabilities): boolean {
  return capabilities.workspaceHookReview === true;
}

export function clientSupportsWorkspaceHookReview(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workspaceHookReviewUi === true;
}

export function hostSupportsWorkflowRunDeltas(capabilities: HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

export function clientSupportsWorkflowRunDeltas(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workflowRunDeltas === true;
}

// ── §3.1 订阅 ──
export const subscribeParamsSchema = z
  .object({
    // "conversation/<sessionId>" | "sessions-index/<workspaceId>" | ...
    topic: z.string(),
    // 水位不变量：仅当客户端真持有该时刻一致状态才允许带。
    base: z.object({ logEpoch: z.string(), seq: z.number() }).optional(),
    // 手动重试仅消费当前 failed attempt；普通重连不重跑 hook。
    retryInitialization: z.string().min(1).optional(),
    // QoS hint，只影响调度，不影响语义。
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;

export const subscribeAckSchema = z.object({
  subscriptionId: z.string(),
  // resume = base 有效，从 base.seq 续传增量；否则 snapshot。
  mode: z.enum(["snapshot", "resume"]),
  logEpoch: z.string(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

const openTimingMsSchema = z.number().int().nonnegative().optional();
const openTimingCountSchema = z.number().int().nonnegative().optional();

/**
 * Desktop session 首次打开的低频诊断 timing；只挂在 conversation subscribe ACK，
 * 不进入 snapshot、delta、sessions-index 或 workspace-config。
 */
export const conversationOpenTimingSchema = z
  .object({
    version: z.literal(1),
    hostPrepareMs: openTimingMsSchema,
    providerRegistrySyncMs: openTimingMsSchema,
    taskMetaReadMs: openTimingMsSchema,
    cliRequestMs: openTimingMsSchema,
    cliBootstrapMs: openTimingMsSchema,
    cliSessionRestoreMs: openTimingMsSchema,
    historyReadyMs: openTimingMsSchema,
    initialFrameEncodeMs: openTimingMsSchema,
    cliProcessState: z.enum(["spawned", "reused"]).optional(),
    sessionRuntimeState: z.enum(["cold", "warm"]).optional(),
    snapshotRowCount: openTimingCountSchema,
  })
  .strict();
export type ConversationOpenTiming = z.infer<typeof conversationOpenTimingSchema>;

const conversationSubscribeAckSchema = subscribeAckSchema.extend({
  openTiming: conversationOpenTimingSchema.optional(),
});
export type ConversationSubscribeAck = z.infer<typeof conversationSubscribeAckSchema>;

// ── 帧信封（泛型帧用工厂构造具体 topic 的 schema）──
export function createTopicFrameSchema<S extends z.ZodTypeAny, D extends z.ZodTypeAny>(
  snapshotSchema: S,
  deltaSchema: D,
) {
  return z.object({
    topic: z.string(),
    // 代际标识，防旧流交错。
    subscriptionId: z.string(),
    // 区间记账 (fromSeq, toSeq]；snapshot 帧 fromSeq 固定为 0。
    fromSeq: z.number(),
    toSeq: z.number(),
    // CLI 时钟，供 clockOffset 估计。
    sentAt: timestampSchema,
    payload: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("snapshot"), snapshot: snapshotSchema }),
      z.object({ kind: z.literal("deltas"), deltas: z.array(deltaSchema) }),
    ]),
  });
}

export interface TopicFrame<S, D> {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: Timestamp;
  payload: { kind: "snapshot"; snapshot: S } | { kind: "deltas"; deltas: D[] };
}
type Timestamp = z.infer<typeof timestampSchema>;

// conversation topic 的具体帧 schema（五件套实例化）。
// 传输外壳/黄金测试用它做帧合法性校验；host 通道层 复用。
export const conversationTopicFrameSchema = createTopicFrameSchema(
  conversationSnapshotSchema,
  conversationDeltaSchema,
)
  .extend({
    ttft: localTtftFactsSchema.optional(),
    ttftRelated: z.array(localTtftFactsSchema).max(16).optional(),
  })
  .superRefine((frame, context) => {
    if (!frame.topic.startsWith("conversation/") || frame.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  });
export type ConversationTopicFrame = z.infer<typeof conversationTopicFrameSchema>;
export const conversationTopicWireFrameSchema = createTopicWireFrameSchema(
  conversationTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
    context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
  }
});
export type ConversationTopicWireFrame = z.infer<typeof conversationTopicWireFrameSchema>;
export const conversationTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
      context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
    }
  },
);
export type ConversationTopicWireCandidate = z.infer<typeof conversationTopicWireCandidateSchema>;

// sessions-index topic 的具体帧 schema（五件套实例化；侧栏列表活性数据源）。
export const sessionsIndexTopicFrameSchema = createTopicFrameSchema(
  sessionsIndexSnapshotSchema,
  sessionsIndexDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("sessions-index/") ||
    frame.topic.length === "sessions-index/".length
  ) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicFrame = z.infer<typeof sessionsIndexTopicFrameSchema>;
export const sessionsIndexTopicWireFrameSchema = createTopicWireFrameSchema(
  sessionsIndexTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("sessions-index/") || wire.topic.length === "sessions-index/".length) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});
export type SessionsIndexTopicWireFrame = z.infer<typeof sessionsIndexTopicWireFrameSchema>;
export const sessionsIndexTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("sessions-index/") ||
      wire.topic.length === "sessions-index/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid sessions-index topic",
        path: ["topic"],
      });
    }
  },
);
export type SessionsIndexTopicWireCandidate = z.infer<typeof sessionsIndexTopicWireCandidateSchema>;

// workspace-config topic 的具体帧 schema（additive 变更；配置目录活性数据源）。
export const workspaceConfigTopicFrameSchema = createTopicFrameSchema(
  workspaceConfigSnapshotSchema,
  workspaceConfigDeltaSchema,
).superRefine((frame, context) => {
  if (
    !frame.topic.startsWith("workspace-config/") ||
    frame.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicFrame = z.infer<typeof workspaceConfigTopicFrameSchema>;
export const workspaceConfigTopicWireFrameSchema = createTopicWireFrameSchema(
  workspaceConfigTopicFrameSchema,
).superRefine((wire, context) => {
  if (
    !wire.topic.startsWith("workspace-config/") ||
    wire.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});
export type WorkspaceConfigTopicWireFrame = z.infer<typeof workspaceConfigTopicWireFrameSchema>;
export const workspaceConfigTopicWireCandidateSchema = topicWireFrameCandidateSchema.superRefine(
  (wire, context) => {
    if (
      !wire.topic.startsWith("workspace-config/") ||
      wire.topic.length === "workspace-config/".length
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid workspace-config topic",
        path: ["topic"],
      });
    }
  },
);
export type WorkspaceConfigTopicWireCandidate = z.infer<
  typeof workspaceConfigTopicWireCandidateSchema
>;

/** 三个生产 topic 的公共 logical / physical 路由面。 */
export const routedTopicFrameSchema = z.union([
  conversationTopicFrameSchema,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
]);
export type RoutedTopicFrame = z.infer<typeof routedTopicFrameSchema>;
export const routedTopicWireFrameSchema = z.union([
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
]);
export type RoutedTopicWireFrame = z.infer<typeof routedTopicWireFrameSchema>;
export const routedTopicWireCandidateSchema = z.union([
  conversationTopicWireCandidateSchema,
  sessionsIndexTopicWireCandidateSchema,
  workspaceConfigTopicWireCandidateSchema,
]);
export type RoutedTopicWireCandidate = z.infer<typeof routedTopicWireCandidateSchema>;

// ── v4 RPC 出入口（host 通道层）──
// 载体复用现有 JSON-RPC（stdio NDJSON / socket），方法名带 v4/ 前缀与旧协议并存；
// 旧 session/* 方法删除后，这里就是唯一协议面。
export const V4_METHODS = {
  connectionFlow: "v4/connection/flow",
  controllerSubscribe: "v4/controller/subscribe",
  controllerResync: "v4/controller/resync",
  controllerUnsubscribe: "v4/controller/unsubscribe",
  conversationSubscribe: "v4/conversation/subscribe",
  sessionsIndexReconcile: "v4/sessionsIndex/reconcile",
  conversationResync: "v4/conversation/resync",
  conversationUnsubscribe: "v4/conversation/unsubscribe",
  // 行分页 query（rows/range）：只读、无状态、超时重发安全。
  conversationRowsRange: "v4/conversation/rowsRange",
  // 手机输入预测（input-prediction.ts）：只读查询；旧 CLI 不认识时手机静默无 hint。
  conversationInputPrediction: "v4/conversation/inputPrediction",
  // 当前有效分支的终态 ExitPlanMode 目录；只读、无状态、超时重发安全。
  conversationPlans: "v4/conversation/plans",
  conversationFileChanges: "v4/conversation/fileChanges",
  backgroundBashOutput: "v4/conversation/backgroundBashOutput",
  offPeakControl: "v4/conversation/offPeakControl",
  conversationFileRewindPreview: "v4/conversation/fileRewindPreview",
  // workflow run 的事件日志分页（详情页审计面）：只读、无状态、超时重发安全。
  // 新方法天然偏斜安全——旧桌面根本不会调用它。
  conversationWorkflowRunEvents: "v4/conversation/workflowRunEvents",
  conversationWorkflowRuns: "v4/conversation/workflowRuns",
  // workflow run 的用户面产物。三条同族：
  // 只读、无状态、超时重发安全；schema 在 workflow-artifacts.ts（那边还有术语消歧）。
  //   Artifacts    产物清单（冷恢复与中枢详情的 durable 读法）
  //   ArtifactData 预置看板的条目分页（cursor = journal sequence）
  //   ArtifactRead 内容产物的字节，≤ 512 KiB 一块，形状逐字照 attachmentRead
  conversationWorkflowRunArtifacts: "v4/conversation/workflowRunArtifacts",
  conversationWorkflowRunArtifactData: "v4/conversation/workflowRunArtifactData",
  conversationWorkflowRunArtifactRead: "v4/conversation/workflowRunArtifactRead",
  // workflow run 的工作区 transcript。两条同族，
  // 照产物的 ①/③ 拆法：Workspace 是轻行清单（不带正文），NodeResult 是一个节点的有界正文。
  conversationWorkflowRunWorkspace: "v4/conversation/workflowRunWorkspace",
  conversationWorkflowRunNodeResult: "v4/conversation/workflowRunNodeResult",
  // usage query（模式同 rows/range：只读、无状态、超时重发安全）。
  // usage 事实源在 CLI 的 session 库（model_usage/turn_usage 聚合），host 侧无副本，
  // 故收敛为 v4 query 而非 host 直连；旧词 usage/stats、session/usage 就此消费清零。
  usageStats: "v4/usage/stats",
  conversationUsage: "v4/conversation/usage",
  // context 组成（context-composition/contract.ts）：只读、existing-only；
  // 旧 CLI 返回 method-not-found，App 当作 null。
  conversationContextComposition: "v4/conversation/contextComposition",
  // 项目数据彻底删除（schema 在 session-data.ts）：measure 只读；purge 幂等，已不存在的会话按 0 字节成功。
  // 新方法偏斜安全：旧 CLI 返回 method-not-found，Host 据此不显示「删除数据」选项。
  sessionDataMeasure: "v4/storage/sessionData/measure",
  sessionDataPurge: "v4/storage/sessionData/purge",
  sessionDeletionPreview: "v4/storage/sessionData/deletionPreview",
  sessionDeletionExecute: "v4/storage/sessionData/deletionExecute",
  // 附件事务：禁止 full-data RPC。每个 chunk 的 decoded bytes <=512KiB，
  // renderer->host Channel 与 host->CLI NDJSON 都必须逐 request 证明 <=1MiB。
  attachmentBegin: "v4/attachment/begin",
  attachmentChunk: "v4/attachment/chunk",
  attachmentCommit: "v4/attachment/commit",
  attachmentAbort: "v4/attachment/abort",
  // 已发送图片预览：只读、按 session row 授权，响应仍按 512KiB 分块。
  attachmentRead: "v4/attachment/read",
  // Share 读取 userInput 附件：允许 text/plain 等非媒体类型，仍按 row/index 授权并分块返回。
  conversationAttachmentRead: "v4/conversation/attachmentRead",
  // Share 预检 userInput 附件元数据：只做 row/index 授权和 stat，不读取完整文件。
  conversationAttachmentStat: "v4/conversation/attachmentStat",
  // Desktop local 已发送视频：只返回经过同一 row/index 授权的本地播放源。
  attachmentPreviewSource: "v4/attachment/previewSource",
  commandsQuery: "v4/commands/query",
  command: "v4/command",
} as const;
export type V4Method = (typeof V4_METHODS)[keyof typeof V4_METHODS];

/** 按任务授权的有界输出查询，不接受任意路径或调用方扩大的读取预算。 */
export const v4BackgroundBashOutputParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
  workId: z.string().min(1),
});
export type V4BackgroundBashOutputParams = z.infer<typeof v4BackgroundBashOutputParamsSchema>;

export const v4ConnectionFlowStateSchema = z.enum(["saturated", "drained", "closed"]);
export type V4ConnectionFlowState = z.infer<typeof v4ConnectionFlowStateSchema>;

export const v4ConnectionFlowParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    state: v4ConnectionFlowStateSchema,
  })
  .strict();
export type V4ConnectionFlowParams = z.infer<typeof v4ConnectionFlowParamsSchema>;

export const v4ConnectionFlowResultSchema = z.object({}).strict();

export const V4_NOTIFICATIONS = {
  offPeakLifecycle: "v4/offPeak/lifecycle",
  // 下行帧（snapshot / deltas），params = ConversationTopicFrame。
  conversationFrame: "v4/conversation/frame",
  // 仅 live ingest 的无正文事实；不进入 topic snapshot/recovery。
  conversationTelemetryFact: "v4/telemetry/event",
  localTtftFacts: "v4/telemetry/local-ttft",
  // 仅当前进程 live ToolCallResult 产生；历史与 replayable 链路不得补造。
  cuaPermissionObservation: "v4/cua/permission-observation",
  pluginUiToolResult: "v4/plugin-ui/tool-result",
  // context 组成变更：只带 { sessionId, revision }，live-only，不进 snapshot。
  conversationContextCompositionChanged: "v4/conversation/contextCompositionChanged",
  // 模型请求指标（telemetry.ts 的 modelRequestMetricsFactSchema）：live-only，旧 App 不认识即忽略。
  modelRequestMetrics: "v4/telemetry/model-request-metrics",
} as const;

/** 3.3.6 SSH 历史任务归属证明与 sessions-index 冷种子共享同一有界窗口。 */
export const MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE = 200;

// subscribe 请求 = 通用 SubscribeParams + connectionId（重订阅替换按
// (connectionId, topic) 判定；stdio 单管道场景由 host 为每个下游客户端分配）。
export const v4ConversationSubscribeParamsSchema = subscribeParamsSchema.extend({
  additionalDirectories: z.array(z.string().trim().min(1)).max(256).optional(),
  connectionId: z.string(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  // 当前可信 attachment 的 workspace；cold resume 优先使用它恢复身份，live 不消费。
  workspace: zcodeWorkspaceRefSchema.optional(),
  /** host 从当前 remote workspace 的 tasks-index 精确读取的旧任务归属 allowlist。 */
  legacyTaskIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  /**
   * 本地 workspace 下 cwd 与 workspace 目录不同的会话（受管 worktree 任务，docs/git/worktree.md
   * §6.6.2）。CLI 本地冷列表只按 directory 扫描，看不到它们；host 从 tasks-index 精确提供 id，
   * CLI 只为这些 id 补读摘要，不改写任何存储字段。
   */
  worktreeSessionIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  // 仅供 host→CLI cold resume 使用；live conversation 不消费该 hint。
  resumeThoughtLevel: z.string().trim().min(1).optional(),
  /**
   * 这条订阅收不收 `workflowRun.*` 键级增量。与 `clientMode` 同族：由**可信 host** 从该连接的
   * clientHello 注入，面向 UI 的 subscribe 选不了它——一个客户端能不能认得增量是连接的事实，
   * 不是某一次订阅可以自选的口味。缺席 = 按旧消费者处理（整键 patch + 旧界裁剪）。
   */
  workflowRunDeltas: z.boolean().optional(),
  pluginDiscoveryUi: z.boolean().optional(),
  historyFirst: z.boolean().optional(),
});
export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;

// 公共 subscribe response 严格只含 ACK。initial snapshot/resume 由 server 的
// request-scoped post-response outbox 在 response line 之后作为 owned notification 发出。
export const v4ConversationSubscribeResultSchema = z
  .object({
    ack: conversationSubscribeAckSchema,
  })
  .strict();
export type V4ConversationSubscribeResult = z.infer<typeof v4ConversationSubscribeResultSchema>;

// sessions-index 与 conversation 共用同一 subscribe RPC；公共 response 同样 ACK-only。
export const v4SessionsIndexSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4SessionsIndexSubscribeResult = z.infer<typeof v4SessionsIndexSubscribeResultSchema>;

// workspace-config 也只回 ACK；initial frame 走同一 post-response notification 时序。
export const v4WorkspaceConfigSubscribeResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4WorkspaceConfigSubscribeResult = z.infer<
  typeof v4WorkspaceConfigSubscribeResultSchema
>;

// 活跃订阅的 same-sub 恢复。topic/connection/profile 必须由 host owned registry
// 反查，客户端只能声明自己已确认的水位与是否强制 snapshot。
export const conversationResyncParamsSchema = z
  .object({
    subscriptionId: z.string().trim().min(1).max(1024),
    base: z
      .object({
        logEpoch: z.string().trim().min(1).max(1024),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    forceSnapshot: z.boolean().optional(),
  })
  .strict();
export type ConversationResyncParams = z.infer<typeof conversationResyncParamsSchema>;

// CLI-facing 形状：topic/connectionId 只能由 connection facade 从 owned registry 注入。
export const v4ConversationResyncParamsSchema = conversationResyncParamsSchema
  .extend({
    topic: z.string().trim().min(1).max(2048),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationResyncParams = z.infer<typeof v4ConversationResyncParamsSchema>;

export const v4ConversationResyncResultSchema = z
  .object({
    ack: subscribeAckSchema,
  })
  .strict();
export type V4ConversationResyncResult = z.infer<typeof v4ConversationResyncResultSchema>;

export const v4ConversationUnsubscribeParamsSchema = z
  .object({
    topic: z.string().trim().min(1).max(2048),
    subscriptionId: z.string().trim().min(1).max(1024),
    connectionId: z.string().trim().min(1).max(1024),
  })
  .strict();
export type V4ConversationUnsubscribeParams = z.infer<typeof v4ConversationUnsubscribeParamsSchema>;

// ── rows/range（游标制行分页，loadOlder）──
// 无 index 语义：全序 = rowId 升序；客户端按 rowId 键控合并。
export const v4ConversationRowsRangeParamsSchema = z.object({
  workspace: v4ColdResumeWorkspaceSchema,
  sessionId: z.string(),
  /** Host attachment injects this trusted value; renderer callers omit it. */
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  // 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。
  beforeRowId: z.number().optional(),
  limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit),
  /**
   * 手机预加载只读热会话：会话不在内存就报 proto.sessionNotResident，不冷恢复、不重建投影；
   * Host 同时只复用已运行的工作区 CLI，不为它拉起进程。缺省 = 现有行为（按需冷恢复）。
   */
  residency: z.literal("resident-only").optional(),
});
export type V4ConversationRowsRangeParams = z.infer<typeof v4ConversationRowsRangeParamsSchema>;

export const v4ConversationRowsRangeResultSchema = z.object({
  // rowId 升序。历史回补与 snapshot 的 window 同档，逐行降级（封闭规则 13）：
  // 补拉旧页时遇到读不懂的行不能让整次 rows/range 失败，那会让会话永远卷不到顶。
  rows: z.array(displayConversationRowSchema),
  // 服务端取值时的水位/纪元；与 fileChanges 等只读查询共用，避免跨 revision 拼接发布数据。
  atSeq: z.number(),
  atRevision: z.number().int().nonnegative(),
  atLogEpoch: z.string(),
  // beforeRowId 方向是否还有更早的行。
  hasMore: z.boolean(),
});
export type V4ConversationRowsRangeResult = z.infer<typeof v4ConversationRowsRangeResultSchema>;

// ── conversation plans directory ──
// 目录来自 CLI 完整有效 projection，不能用 renderer 的有界 tail window 推导。
export const v4ConversationPlansParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansParams = z.infer<typeof v4ConversationPlansParamsSchema>;

export const v4ConversationPlansResultSchema = z
  .object({
    // 当前有效分支的终态 ExitPlanMode，rowId 降序（最新优先）。
    plans: z.array(toolCallRowSchema),
    atSeq: z.number().int().nonnegative(),
    atLogEpoch: z.string().min(1),
  })
  .strict();
export type V4ConversationPlansResult = z.infer<typeof v4ConversationPlansResultSchema>;

const readonlyDiffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileChangesParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileChangesParams = z.infer<typeof v4ConversationFileChangesParamsSchema>;

export const v4ConversationFileChangesResultSchema = z
  .object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    state: z.enum(["active", "reverted"]).optional(),
    items: z.array(
      z
        .object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          writeCount: z.number().int().nonnegative(),
          toolNames: z.array(z.string()),
          patches: z.array(readonlyDiffHunkSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type V4ConversationFileChangesResult = z.infer<typeof v4ConversationFileChangesResultSchema>;

// ── workflow run 事件日志──
// 形态与 rows/range、plans 同族：只读、无状态、超时重发安全。cursor = journal sequence
// （`appendEvent` 单调分配），在 workflowRuns[].lastEventSequence 抬升时重取。
// 刻意**不是** v4 command：command 的 ACK 结果是 commandResultSchema 那个封闭的「变更结果」
// 判别联合，把一页只读事件塞进去等于把读放进写的词汇表，还要白背 baseRevision/幂等那套机制。

/**
 * 事件日志一页的两道界，网关按它们取数（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Reading the journal」）。字节按存储里的序列化字节计、取协议单帧上限的四分之一：条数单独
 * 管不住字节，500 条带着大 report item 的事件足以顶到单帧上限。
 */
export const WORKFLOW_RUN_EVENTS_PAGE_LIMITS = {
  maxEvents: 500,
  maxBytes: PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes / 4,
} as const;

export const v4ConversationWorkflowRunEventsParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    /** 只取 sequence 严格大于该值的事件；缺省从头取。 */
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunEventsParams = z.infer<
  typeof v4ConversationWorkflowRunEventsParamsSchema
>;

export const v4ConversationWorkflowRunEventsResultSchema = z
  .object({
    events: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative(),
          type: z.string().min(1).max(64),
          // 载荷已在 CLI 侧经 boundDynamicWorkflowRunEventPayload 有界化（同一次序列化
          // 也喂给 workflowRuns 投影）。这里不再复述引擎的事件形状：读端按种类解释。
          payload: z.record(z.string(), z.unknown()),
          truncated: z.boolean().optional(),
        })
        .strict(),
    ),
    /** 本页之后仍有事件（页可能因条数或字节上界提前收尾）。 */
    hasMore: z.boolean(),
  })
  .strict();
// **刻意不带 `atSeq` / `atLogEpoch`**，尽管同族的 rows/range 与 plans 都带。
//
// 那两个字段在同族里是**陈旧读防护**：它们读的是 conversation projection，而 projection 的
// `rowId` 只在一个 log epoch 内有意义（重建 / fork / rewind 会重新编号），所以读端的契约是
// "atLogEpoch ≠ store 当前 epoch → 整个结果丢弃"。
//
// 本 query 读的是 **journal**（`dwf_event`），它与 conversation log 无关，且 cursor 永不失效：
// journal 的 JournalStorePort 契约要求 sequence 只追加、
// 跨 resume 从既有最大值继续、既不重置也不复用，既有条目的编号不变。也就是说一个
// `(runId, sequence)` cursor 永远有效——没有任何"陈旧"可供防护。
//
// 更要紧的是：带上 `atLogEpoch` 不是无害的对称。按同族的读端契约，一次与 run 完全无关的
// 会话 rewind（epoch 变化）会让详情页把**合法的** journal 页整页丢掉。宁可少一个字段，
// 也不要携带一个在这里定义不出正确语义的字段。
export type V4ConversationWorkflowRunEventsResult = z.infer<
  typeof v4ConversationWorkflowRunEventsResultSchema
>;

// ── dwf run 枚举 ──
// journal-backed 的重启后发现面：`workflowRuns` 投影是 memory-only（冷合并归类），
// 重启后为空——工具卡 join 与 Resume 按钮的可用性只能从 dwf_run 行还原。与
// workflowRunEvents 同族（只读、无状态、超时重发安全），同样刻意不是 v4 command，
// 同样不带 atSeq/atLogEpoch（读 journal，与 conversation log 无关，见上一个 query 的论证）。
// 新方法天然偏斜安全：旧桌面永远不会调用它。
export const v4ConversationWorkflowRunsParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    /** 返回条数上限；缺省与钳制在 CLI 侧（枚举面有界，绝不无界扫库）。 */
    limit: z.number().int().positive().max(64).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunsParams = z.infer<
  typeof v4ConversationWorkflowRunsParamsSchema
>;

export const v4ConversationWorkflowRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    /** 发起 run 的 CreateWorkflow 工具调用 id（工具卡 → 详情页/Resume 的关联键）；老 run 缺席。 */
    toolCallId: z.string().min(1).optional(),
    /**
     * 展示标签，服务端读时派生（`name` → 脚本首行 → runId）。optional 是偏斜安全：
     * 老 CLI 不发这个键，读侧回落 runId——少一个标签是退化，不是错误。
     * 上限与派生侧的 80 字符对齐后留一倍余量（用户起的 `name` 不受派生上限约束）。
     */
    label: z.string().min(1).max(160).optional(),
    /** 最后更新时间（epoch 毫秒，journal 的 `dwf_run.time_updated`）。缺席即不显示时间。 */
    updatedAt: z.number().int().nonnegative().optional(),
    // 与 workflowRuns 投影同一套五值词汇；
    // 此查询使用独立的 schema，新增查询状态不改变投影侧的状态键。
    status: z.enum(["completed", "errored", "pending", "running", "stopped"]),
    /** `status === "stopped"` 才在场。词表与观察面共用一份——这里曾各抄一遍，于是引擎多出
     * `superseded` 时这份 strict schema 把整页 run 目录拒掉（桌面端表现为
     * 「读取 run 摘要失败」，任务列表计数与目录页一起空白）。 */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    // lineage：修订出来的 run 带前驱，
    // 被替代的 run 带后继（只随 `stopReason: "superseded"`）。两者 optional：老 CLI 不发。
    resumedFrom: z.string().min(1).optional(),
    supersededBy: z.string().min(1).optional(),
    /** errored / stopped(provider|interrupted) 的结构化失败编码（`ProviderStop` / `Interrupted` …）。 */
    failureCode: z.string().min(1).max(64).optional(),
    failureMessage: z.string().max(2048).optional(),
    /** 是否可恢复。CLI 按 resume 门的同一个谓词算好——UI 绝不自行推导（两处谓词会漂移）。 */
    resumable: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunSummary = z.infer<
  typeof v4ConversationWorkflowRunSummarySchema
>;

export const v4ConversationWorkflowRunsResultSchema = z
  .object({
    /** 最近更新在前（排序在存储层）。 */
    runs: z.array(v4ConversationWorkflowRunSummarySchema),
  })
  .strict();
export type V4ConversationWorkflowRunsResult = z.infer<
  typeof v4ConversationWorkflowRunsResultSchema
>;

export const v4ConversationFileRewindPreviewParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileRewindPreviewParams = z.infer<
  typeof v4ConversationFileRewindPreviewParamsSchema
>;

const v4WorkspaceFileRewindSafeFileSchema = z
  .object({
    action: z.enum(["restore", "delete"]),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindUnsafeFileSchema = z
  .object({
    currentHash: z.string().optional(),
    expectedHash: z.string().optional(),
    message: z.string().optional(),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.enum([
      "checkpoint_missing",
      "checkpoint_unreadable",
      "external_modified",
      "file_read_failed",
      "unsupported_checkpoint",
    ]),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindIgnoredFileSchema = z
  .object({
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.literal("bash_ignored"),
    toolNames: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileRewindPreviewResultSchema = z
  .object({
    canApply: z.boolean(),
    ignoredFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
    safeFiles: z.array(v4WorkspaceFileRewindSafeFileSchema),
    unsafeFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  })
  .strict();
export type V4ConversationFileRewindPreviewResult = z.infer<
  typeof v4ConversationFileRewindPreviewResultSchema
>;

// ── usage query──
// app 级用量聚合：range/timeZone 入参与旧 usage/stats 同形（消费者语义不变），
// 结果 = AppUsageSnapshot（形状归属中性模块 usage-stats.ts，不与旧词表文件耦合）。
export const v4UsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export type V4UsageStatsParams = z.infer<typeof v4UsageStatsParamsSchema>;
export const v4UsageStatsResultSchema = appUsageSnapshotSchema;
export type V4UsageStatsResult = z.infer<typeof v4UsageStatsResultSchema>;

// 会话级 token 用量（旧 session/usage 的 v4 名字空间落位：会话是协议一等概念，
// task 是 UI 投影概念不进协议词表）。字段与旧 result 同形，旧 schema 随词一起死。
export const v4ConversationUsageParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ConversationUsageParams = z.infer<typeof v4ConversationUsageParamsSchema>;
export const v4ConversationUsageResultSchema = z
  .object({
    sessionId: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type V4ConversationUsageResult = z.infer<typeof v4ConversationUsageResultSchema>;

// ── 附件上行事务 ──
// UI 高层仍用 put(input)->ref；这份 full-data schema 只描述 renderer 内部调用，绝不作为
// production RPC method。wire 只能用 begin/chunk/commit/abort。
export const v4AttachmentPutParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    fileName: z.string().min(1),
    mime: z.string().min(1),
    // base64（不带 data: 前缀）；解码后字节数 ≤ PROTOCOL_V4_LIMITS.attachmentMaxBytes。
    dataBase64: z.string().min(1),
  })
  .strict();
export type V4AttachmentPutParams = z.infer<typeof v4AttachmentPutParamsSchema>;
export const v4AttachmentPutResultSchema = z.object({
  ref: z.string().min(1),
});
export type V4AttachmentPutResult = z.infer<typeof v4AttachmentPutResultSchema>;

const v4AttachmentUploadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const v4AttachmentChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const v4AttachmentBeginParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\0\r\n]+$/),
    mime: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
    totalBytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks),
    checksum: v4AttachmentChecksumSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.totalBytes === 0) !== (value.totalChunks === 0)) {
      context.addIssue({
        code: "custom",
        message: "zero-byte upload must declare zero chunks",
        path: ["totalChunks"],
      });
    }
  });
export type V4AttachmentBeginParams = z.infer<typeof v4AttachmentBeginParamsSchema>;

export const v4AttachmentBeginResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("staging"),
      nextChunkIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("committed"),
      nextChunkIndex: z.number().int().nonnegative(),
      ref: z.string().min(1),
    })
    .strict(),
]);
export type V4AttachmentBeginResult = z.infer<typeof v4AttachmentBeginResultSchema>;

function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return null;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
}

export const v4AttachmentChunkParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    dataBase64: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
  });
export type V4AttachmentChunkParams = z.infer<typeof v4AttachmentChunkParamsSchema>;

export const v4AttachmentChunkResultSchema = z
  .object({
    uploadId: v4AttachmentUploadIdSchema,
    nextChunkIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4AttachmentChunkResult = z.infer<typeof v4AttachmentChunkResultSchema>;

const v4AttachmentTerminalParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
  })
  .strict();
export const v4AttachmentCommitParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentCommitParams = z.infer<typeof v4AttachmentCommitParamsSchema>;
export const v4AttachmentCommitResultSchema = v4AttachmentPutResultSchema.strict();
export type V4AttachmentCommitResult = z.infer<typeof v4AttachmentCommitResultSchema>;
export const v4AttachmentAbortParamsSchema = v4AttachmentTerminalParamsSchema;
export type V4AttachmentAbortParams = z.infer<typeof v4AttachmentAbortParamsSchema>;
export const v4AttachmentAbortResultSchema = z.object({}).strict();

/** 已发送 image/video/PDF 预览 query；ref 必须由 CLI 对当前 session projection 再授权。 */
export const v4AttachmentReadParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    // 新 renderer 用稳定 row 身份 + 附件序号消除同一路径跨轮歧义；两者必须成对出现。
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentReadParams = z.infer<typeof v4AttachmentReadParamsSchema>;

/** Desktop local 已发送视频 source query；远端与 Web 必须返回 chunked。PDF 始终走 chunked。 */
export const v4AttachmentPreviewSourceParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema.optional(),
    attachmentIndex: z.number().int().nonnegative().optional(),
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.attachmentIndex === undefined)) return;
    context.addIssue({
      code: "custom",
      message: "target and attachmentIndex must be provided together",
      path: value.target === undefined ? ["target"] : ["attachmentIndex"],
    });
  });
export type V4AttachmentPreviewSourceParams = z.infer<typeof v4AttachmentPreviewSourceParamsSchema>;

export const v4AttachmentPreviewSourceResultSchema = z.union([
  z
    .object({
      kind: z.literal("local_path"),
      path: z.string().min(1),
      mediaType: z.string().refine((value) => value.startsWith("video/"), {
        message: "local attachment preview only supports video media types",
      }),
    })
    .strict(),
  z.object({ kind: z.literal("chunked") }).strict(),
]);
export type V4AttachmentPreviewSourceResult = z.infer<typeof v4AttachmentPreviewSourceResultSchema>;

export const v4AttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z
      .string()
      .refine(
        (value) =>
          value.startsWith("image/") ||
          value.startsWith("video/") ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf" ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "text/plain",
        "attachment preview only supports image/video/pdf/plain text types",
      ),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      // 根因：运行时已支持材料文本，响应 schema 仍只接受媒体，导致跨进程预览失败。
      (value.mediaType.startsWith("image/") ||
        value.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain") &&
      value.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        origin: "number",
        inclusive: true,
        message: "image/text preview exceeds total byte limit",
        path: ["totalBytes"],
      });
    }
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4AttachmentReadResult = z.infer<typeof v4AttachmentReadResultSchema>;

/** Share 读取用户输入附件，允许任意已授权 MIME，不改变媒体预览 read 的语义。 */
export const v4ConversationAttachmentReadParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationAttachmentReadParams = z.infer<
  typeof v4ConversationAttachmentReadParamsSchema
>;

export const v4ConversationAttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z.string().min(1),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationAttachmentReadResult = z.infer<
  typeof v4ConversationAttachmentReadResultSchema
>;

/** Share 选择阶段的 metadata-only 附件检查。 */
export const v4ConversationAttachmentStatParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    ref: z.string().min(1),
    target: conversationRowTargetSchema,
    attachmentIndex: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationAttachmentStatParams = z.infer<
  typeof v4ConversationAttachmentStatParamsSchema
>;

export const v4ConversationAttachmentStatResultSchema = z
  .object({
    mediaType: z.string().min(1),
    // stat 是 metadata-only 探测，必须能表达超过传输上限的真实大小，否则
    // 「已知容量超限」无法在选择阶段作为阻断项呈现（见 attachmentStatMaxBytes 注释）。
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentStatMaxBytes),
    mtimeMs: z.number().finite().optional(),
  })
  .strict();
export type V4ConversationAttachmentStatResult = z.infer<
  typeof v4ConversationAttachmentStatResultSchema
>;

/** conversation topic key 构造（与 parseConversationTopic 对偶）。 */
export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

/** conversation topic key 解析（"conversation/<sessionId>"）。 */
export function parseConversationTopic(topic: string): string | null {
  if (!topic.startsWith("conversation/")) return null;
  const sessionId = topic.slice("conversation/".length);
  return sessionId.length > 0 ? sessionId : null;
}
