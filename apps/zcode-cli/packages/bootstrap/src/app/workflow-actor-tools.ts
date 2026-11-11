// ============================================================
// workflow actor 的工具面（AgentRuntime 工具配置）
// ============================================================
//
// 子代理的工具面必须落到 child runtime 的工具注册上，否则实盘 transcript
// 里裁判 actor 也拿到了整套交互工具。两类风险：
//   1. 悬挂与越级：EnterPlanMode 在 headless child 里没有人可审批；AskUserQuestion 让子代理绕过
//      主代理直接问用户（见减法表注释）；
//   2. 越权与递归：CreateWorkflow 让 actor 能再提交一条工作流，ReadTopicResource 越界读父会话的话题资源。
// 本模块是那个缺失的映射，由 driver 侧的 runtime 工厂在造 AgentRuntime 时展开。
//
// persona 无工具档位：每个 actor 都拿完整工作工具集减去下面这份减法表；
// 「裁判不要改文件」由 ask 文本说清——普通子代理也是这么做的（Explore 保留 Bash，
// 只读靠提示）。

import {
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
} from "@zcode/contracts";

/** AgentRuntimeConfig 的工具面切片。 */
interface WorkflowActorToolPolicy {
  toolDisallowlist: readonly string[];
}

/**
 * 从全集里减掉的工具：plan 两件套——子代理不做待批准的计划；CreateWorkflow 会让 actor 递归
 * 提交工作流；ReadTopicResource 越界读父会话的话题资源（原 ReadSessionContext 已删除，2026-11-03）。其余（Bash / Edit / Write / 搜索 / web）照常
 * 保留——actor 就是要干活的。
 */
const ACTOR_DISALLOWED_TOOLS: readonly string[] = [
  // 子代理不问人（2026-10-19 起再次移除；2026-09-23 曾经父会话送达确认窗还给子代理）。
  // 问题：系统提示（core/src/context/sections/workflow-actor.ts）一直写着「没有向人提问的工具」，
  // 工具面却有 AskUserQuestion，模型行为取决于它信哪一边；并行的 N 个子代理还会各自弹窗，
  // 用户收到的是一串互不相干的问题，主代理也不知道发生过什么。
  // 修法：以提示为准，只留一条通道——子代理用 `escalate` 把问题交给主代理，由主代理决定是否
  // 问用户（docs/dynamic-workflow/launch.md「Permissions inside a run」）。
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  "CreateWorkflow",
  // 修订入口与 CreateWorkflow 同一种嵌套编排，同一个根因入列。
  "AmendWorkflow",
  // 话题资源只属于主会话已接纳的机器人输入（会话工具设计 0.8）。
  "ReadTopicResource",
  // 子代理不许替主代理回答升级问题（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Escalation」）。
  // 与上面几条的根因不同：这不是越权读，而是**身份**——升级的整个意义是把判断权
  // 交给创建这条工作流的那一方；让另一个 actor 顺手作答，等于把它悄悄退化成 actor 之间的
  // 互相说服。actor 提问用 `escalate`（恒注册），作答只属于主会话。
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
];

/**
 * workflow actor 的 AgentRuntime 工具配置。纯函数，供 driver 侧 runtime 工厂展开进
 * AgentRuntimeConfig：不收窄，只减掉 plan 与越权的元工具。
 *
 * 只覆盖内建工具；MCP / plugin 工具的过滤留待生产接线时处理（同一个工厂 seam）。
 */
export function workflowActorToolPolicy(): WorkflowActorToolPolicy {
  return { toolDisallowlist: ACTOR_DISALLOWED_TOOLS };
}
