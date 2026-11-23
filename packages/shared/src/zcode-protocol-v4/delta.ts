import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
// ConversationDelta：快照增量与插件 UI 的 live-only 通知，操作集合封闭（10-protocol-spec §4.5）。
// 没有 row.inserted（中间插入）、没有 row.moved、没有字段级 JSON patch——
// 凡此模型表达不了的结构变化，服务端一律发 snapshot resync，刻意压缩客户端错误面。
//
// 唯一的例外是最后两条 `workflowRun.*`：`workflowRuns` 是一个高频状态键，键级整体替换让
// 每条引擎事件都要重发整张表（O(N) 字节/事件、O(N²)/run）。它们**只**给这一个键开了一道
// 按 (runId, siteId, ordinal) 的增量口子，语义仍是「键内整体替换，只是下探了两级」：
// header 键整键替换、条目整条替换，没有任何字段级深合并。规则在 workflow-runs-delta.ts。
import { z } from "zod";
import { streamablePathSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
import {
  backgroundWorkSummarySchema,
  activitySummaryDismissedSchema,
  commandStateSummarySchema,
  goalStateSchema,
  inputRoutingSchema,
  pendingInteractionSchema,
  planStateSchema,
  queueStateSchema,
  runtimeInitializationSchema,
  sessionActionAvailabilitySchema,
  sessionConfigStateSchema,
  sessionControlSchema,
  sessionMetaStateSchema,
  sessionModelTransitionSchema,
  sessionUsageStateSchema,
  subagentProjectionStateSchema,
  workspaceHookAdmissionStateSchema,
  workspaceMcpAdmissionStateSchema,
} from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunsStateSchema,
} from "./workflow-runs.js";

// StatePatch：键级整体替换（Object.assign），键集合封闭。键内绝不深合并。
export const statePatchSchema = z.object({
  runtimeInitialization: runtimeInitializationSchema.optional(),
  revision: z.number().optional(),
  control: sessionControlSchema.optional(),
  sharedContextImport: sharedContextImportStateSchema.optional(),
  availability: sessionActionAvailabilitySchema.optional(),
  inputRouting: inputRoutingSchema.optional(),
  meta: sessionMetaStateSchema.optional(),
  config: sessionConfigStateSchema.optional(),
  modelTransition: sessionModelTransitionSchema.nullable().optional(),
  usage: sessionUsageStateSchema.optional(),
  queue: queueStateSchema.optional(),
  pendingInteractions: z.array(pendingInteractionSchema).optional(),
  pendingCommands: z.array(commandStateSummarySchema).optional(),
  backgroundWorks: z.array(backgroundWorkSummarySchema).optional(),
  activitySummaryDismissed: activitySummaryDismissedSchema.optional(),
  completedActivityCount: z.number().int().nonnegative().nullable().optional(),
  subagents: subagentProjectionStateSchema.optional(),
  // workflow run 的实时运行态。容器本身不 strict，所以旧桌面收到这个新键只是**剥离一个键**、
  // 保住 patch 其余全部键——这正是它不需要任何版本偏斜防御的原因。
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable().optional(),
  plan: planStateSchema.nullable().optional(),
  // 软门禁：null = pending 清零(提示条消失);对象 = 待审核状态更新。
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().optional(),
  workspaceMcpAdmission: workspaceMcpAdmissionStateSchema.nullable().optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

export const pluginUiResourceSubscriberSchema = z
  .object({
    scopeId: z.string(),
    generation: z.number().int().nonnegative(),
    instance: mcpAppInstanceSchema,
  })
  .strict();

/**
 * run 的 **header** = `workflowRunSchema` 减去 actors / nodes 两张按实例增量同步的表。
 *
 * `.omit` 派生而不是手抄一份字段表：2026-09-04 的那次订阅永久失效就是「两处各写一份 run 词汇表」
 * 的后果。小集合（reports / artifacts / phases / pendingQuestions…）留在 header 里整键替换——
 * 它们的上界都是几十条，为它们再开一套增量语法只会多一套能写错的东西。
 */
export const workflowRunHeaderSchema = workflowRunSchema.omit({ actors: true, nodes: true });
export type WorkflowRunHeader = z.infer<typeof workflowRunHeaderSchema>;

/** header 的部分更新：在场的键整键替换，缺席的键保持不动（绝不深合并）。 */
export const workflowRunHeaderPatchSchema = workflowRunHeaderSchema.partial();
export type WorkflowRunHeaderPatch = z.infer<typeof workflowRunHeaderPatchSchema>;

/** 变成**缺席**的 header 键。「零条 ⇒ 键缺席」是 reports / pendingQuestions 等键的协议约定，所以增量必须说得出它。 */
export const workflowRunHeaderKeySchema = workflowRunHeaderSchema.keyof();
export type WorkflowRunHeaderKey = z.infer<typeof workflowRunHeaderKeySchema>;

/**
 * 一条被淘汰条目的**身份**（两张表共用的去重键）。从 actor schema 上 `.pick` 而不是手写
 * 两个字段：这两个字段的界只该有一处定义，理由与 `workflowRunHeaderSchema` 的 `.omit` 逐字相同。
 *
 * 刻意**只有身份**：淘汰要说的全部内容就是「这条走了」，带上条目本身只会让消费者以为这是一次
 * upsert。
 */
export const workflowRunEntryRefSchema = workflowRunActorSchema.pick({
  siteId: true,
  ordinal: true,
});
export type WorkflowRunEntryRef = z.infer<typeof workflowRunEntryRefSchema>;

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  // 追加到尾部（99%）。
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  // 按 rowId 整行替换（状态机迁移）。
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  // 删除该行及之后所有（edit/retry 分支）。作用于客户端已加载集合中所有 rowId >= fromRowId 的行。
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  // 流式文本追加。仅允许作用于流式态行（服务端保证，客户端可断言）。
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
  // 插件 UI 订阅的 MCP 资源通知。live-only：不改快照（apply 为 no-op）、不进冷恢复；
  // renderer 按 subscribers 派发给对应沙箱实例。
  z.object({
    op: z.literal("pluginUi.resourceUpdated"),
    pluginId: z.string(),
    serverName: z.string(),
    uri: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  z.object({
    op: z.literal("pluginUi.resourceListChanged"),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  z.object({
    op: z.literal("pluginUi.instanceClosed"),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  // App-Provided Tools 的"实例信箱"：模型发起的页面工具调用，live-only 投递给唯一实例（subscribers 恰一项）；
  // 渲染端认领后页面 tools/call，结果经 mcp/uiResolveAppToolCall 回传。不改快照、不进冷恢复。
  z.object({
    op: z.literal("pluginUi.appToolCall"),
    activity: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
  /**
   * 一条 dwf run 的键级增量。`revision` 是**这次变化之后**的 `workflowRuns.revision`（绝对值）；
   * 一条引擎事件最多产生一条本 op（节点相位、派生的 actor 状态、用量、水位一起落地，原子）。
   *
   * 六个载荷各有各的语义：`run` 按键整体替换、`cleared` 说哪些键变成了缺席、
   * `removedActors` / `removedNodes` 按 (siteId, ordinal) 删条目、`actors` / `nodes` 按同一个键
   * 整条 upsert。四张表的界与状态键同值——增量不该能拼出一个非法的状态。
   *
   * **施加序是 header → 删除 → upsert**，写在这里也写在字段序上：同一个键在一条 op 里被删又被加
   * （溢出过的 run 在 resume 时清表重开，或一个条目被淘汰后又回来）必须落在表尾，才与顺序施加
   * 两条 op 的结果一致。
   */
  z.object({
    op: z.literal("workflowRun.updated"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
    run: workflowRunHeaderPatchSchema.optional(),
    cleared: z
      .array(workflowRunHeaderKeySchema)
      .max(workflowRunHeaderKeySchema.options.length)
      .optional(),
    removedActors: z
      .array(workflowRunEntryRefSchema)
      .max(WORKFLOW_RUNS_LIMITS.maxActors)
      .optional(),
    removedNodes: z.array(workflowRunEntryRefSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
    actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
    nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
  }),
  /** 这条 run 被生产者淘汰了（只有生产者淘汰，而且必须说出来——客户端永远不自行施加上界）。 */
  z.object({
    op: z.literal("workflowRun.removed"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
  }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type PluginUiResourceDelta = Extract<
  ConversationDelta,
  { op: "pluginUi.resourceUpdated" | "pluginUi.resourceListChanged" }
>;
export type PluginUiAppToolCallDelta = Extract<ConversationDelta, { op: "pluginUi.appToolCall" }>;
/** 按沙箱实例投递的全部 live-only 增量。 */
export type PluginUiInstanceDelta =
  | Extract<ConversationDelta, { op: "pluginUi.instanceClosed" }>
  | PluginUiResourceDelta
  | PluginUiAppToolCallDelta;
export type WorkflowRunUpdatedDelta = Extract<ConversationDelta, { op: "workflowRun.updated" }>;
export type WorkflowRunRemovedDelta = Extract<ConversationDelta, { op: "workflowRun.removed" }>;
