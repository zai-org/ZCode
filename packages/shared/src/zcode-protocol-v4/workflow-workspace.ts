// ============================================================
// 工作区 transcript 的协议词汇表
// ============================================================
// 一个 run 的 `files.*` / `git.*` / `world.run` 调用，在侧板上以工具卡片的形式回放。
// 权威在 journal 的 `dwf_node` 行（`kind ∈ {world-read, world-run}`）：`input_json`
// （迁移 0030）给出 op 与实参，`result_json` 给出正文。
//
// 两条 v4 查询，照用户面产物的 ①/③ 拆法：
//   Workspace  轻行清单（op / args / 状态 / 摘要 / 时刻），**不带正文**；
//              活投影的 `lastEventSequence` 抬升时重查
//   NodeResult 一个节点的正文，按 maxBytes 保形有界化；展开时才取，按 tab 缓存
//
// 分层：正文永远不进清单；清单上的「多大 / 退出码 / 几条」由存储层用 SQLite 的 JSON 函数
// 在库内算出。与 workflowRunEvents 同族：只读、无状态、超时重发安全，刻意不是 v4 command，
// 不带 atSeq / atLogEpoch（读的是 journal，没有陈旧可防）。新方法天然偏斜安全。

import { z } from "zod";
import { v4ColdResumeWorkspaceSchema } from "./core.js";

/** 工作区 transcript 的展示上界。数字即契约。 */
export const WORKFLOW_WORKSPACE_LIMITS = {
  /** 一次清单最多多少行；超界由网关截尾并置 `truncated`。 */
  maxNodes: 2000,
  /** `op` 名的长度（`git-changed-files` 是最长的那个）。 */
  maxOpLength: 32,
  /** 实参个数（引擎侧截断后 ≤ 8；未截断的原值按 facade 签名 ≤ 3）。 */
  maxArgs: 16,
  /** 失败信息的展示长度；超长由宿主切尾。 */
  maxErrorMessageLength: 2000,
  /** 正文一次最多读回多少字节（截断而不是拒绝——这是审计面，不是脚本的取数面）。 */
  resultMaxBytes: 32 * 1024,
} as const;

export const workflowRunWorkspaceNodeKindSchema = z.enum(["world-read", "world-run"]);
export type WorkflowRunWorkspaceNodeKind = z.infer<typeof workflowRunWorkspaceNodeKindSchema>;

/** journal 行的状态（`NodeRecordStatus` 的线上镜像）。 */
export const workflowRunWorkspaceNodeStatusSchema = z.enum(["running", "completed", "failed"]);
export type WorkflowRunWorkspaceNodeStatus = z.infer<typeof workflowRunWorkspaceNodeStatusSchema>;

/** 结构化失败：journal `error_json` 的 code + message（其余字段不出协议）。 */
export const workflowRunWorkspaceNodeErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength),
  })
  .strict();
export type WorkflowRunWorkspaceNodeError = z.infer<typeof workflowRunWorkspaceNodeErrorSchema>;

/**
 * 清单上一行的摘要：不解正文就能报的几个数。哪个在场取决于 op——数组正文（glob / grep /
 * changedFiles）有 `resultCount`，`world.run` 有 `exitCode` 与两路输出的字节数，字符串正文
 * 只有 `resultBytes`。
 */
export const workflowRunWorkspaceNodeSummarySchema = z
  .object({
    resultBytes: z.number().int().nonnegative(),
    resultCount: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkflowRunWorkspaceNodeSummary = z.infer<typeof workflowRunWorkspaceNodeSummarySchema>;

/**
 * 工作区 transcript 的一行。`op` / `args` 来自 `input_json`，升级前的历史行两者缺席
 * （UI 退回静态图上的步标签）；`inputTruncated` 表示 args 是逐项字符串预览而不是原值。
 */
export const workflowRunWorkspaceNodeSchema = z
  .object({
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    kind: workflowRunWorkspaceNodeKindSchema,
    op: z.string().min(1).max(WORKFLOW_WORKSPACE_LIMITS.maxOpLength).optional(),
    args: z.array(z.unknown()).max(WORKFLOW_WORKSPACE_LIMITS.maxArgs).optional(),
    inputTruncated: z.literal(true).optional(),
    status: workflowRunWorkspaceNodeStatusSchema,
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    summary: workflowRunWorkspaceNodeSummarySchema.optional(),
    /** journal 行的建立 / 最近更新时刻（epoch 毫秒）；二者之差就是这一步的耗时。 */
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowRunWorkspaceNode = z.infer<typeof workflowRunWorkspaceNodeSchema>;

// ── v4 query ①：workflowRunWorkspace（轻行清单）──
export const v4ConversationWorkflowRunWorkspaceParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceParams = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceParamsSchema
>;

export const v4ConversationWorkflowRunWorkspaceResultSchema = z
  .object({
    /** 按落库先后（journal 行 id 升序 = 引擎准入顺序）。 */
    nodes: z.array(workflowRunWorkspaceNodeSchema).max(WORKFLOW_WORKSPACE_LIMITS.maxNodes),
    /** 清单超过 maxNodes 被截尾。 */
    truncated: z.boolean().optional(),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceResult = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceResultSchema
>;

// ── v4 query ②：workflowRunNodeResult（一个节点的正文）──
// 授权在 CLI 侧（端口实现）：sessionId 必须是该 run 的 parentSessionId，否则与「无此节点」
// 同一个答案。正文按 maxBytes **保形**有界化：字符串切尾、数组去尾、run 的 stdout / stderr
// 各自切尾——一张卡片要的是「跑了什么、前几百行是什么」，不是脚本那种全有或全无。
export const v4ConversationWorkflowRunNodeResultParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    /** 缺省与上限都是 resultMaxBytes；网关钳制。 */
    maxBytes: z.number().int().positive().max(WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultParams = z.infer<
  typeof v4ConversationWorkflowRunNodeResultParamsSchema
>;

export const v4ConversationWorkflowRunNodeResultResultSchema = z
  .object({
    status: workflowRunWorkspaceNodeStatusSchema,
    /** 有界化后的正文；running 行与 failed 行缺席。 */
    result: z.unknown().optional(),
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    truncated: z.boolean(),
    /** 截断前的序列化字节数。 */
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultResult = z.infer<
  typeof v4ConversationWorkflowRunNodeResultResultSchema
>;
