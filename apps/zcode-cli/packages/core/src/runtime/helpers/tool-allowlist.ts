import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  type SessionTaskType,
} from "@zcode/contracts";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../../subagent/explore-tools.js";
import type { AgentRuntimeConfig } from "../types.js";
import type { DynamicWorkflowToolSurfaceDeferral } from "../../tool/types.js";
import { normalizeToolNameAlias } from "../../tool/tool-visibility.js";

const EXPLORE_AGENT_ALLOWED_TOOL_SET = new Set<string>(EXPLORE_AGENT_ALLOWED_TOOLS);

/**
 * workflow child 运行时额外不注册的工具。
 *
 * 根因：workflow child（`/workflow`、`/expert` 与 script workflow 的 agent 调用）被强制成
 * yolo，而它的交互事件只在 subagent 路径上镜像到父会话（`runtime/methods/subagent.ts` 是
 * `mirrorSubagentToolEvent` 的唯一接入点）。CreateWorkflow 声明了 alwaysAsk，所以一段能编译
 * 的脚本会在 child 里发出一个父界面看不到的确认请求，一路挂到权限超时。直接不注册该工具，
 * child 拿到的是干净的"工具不可用"错误，而不是隐形挂起。
 *
 * 长期解法是把 workflow child 的交互事件也镜像到父会话，随执行引擎落地时一并处理
 */
const WORKFLOW_CHILD_DISALLOWED_TOOLS = [
  CREATE_WORKFLOW_TOOL_NAME,
  // AmendWorkflow 与 CreateWorkflow 同一道 alwaysAsk 门、同一种嵌套编排，因同一个根因入列。
  AMEND_WORKFLOW_TOOL_NAME,
  // SaveWorkflow 因**同一个**根因入列：它也声明了 alwaysAsk，所以在 child 里同样会发出一个
  // 父界面看不到的确认请求并挂到超时。ListSavedWorkflows 不在列——那条禁令的理由是无窗可弹，
  // 只读查询不适用（两个 run 内省工具另有根因，见下面的 RUN_INTROSPECTION_TOOLS）。
  SAVE_WORKFLOW_TOOL_NAME,
  // **结构性禁用**——child 内不得再编排。恢复 = 重新执行整块脚本（完结节点 replay、未完结
  // 重派发），与 CreateWorkflow 新启是同一能力档；纵使免确认后「无窗可弹」的技术问题消失，
  // 嵌套编排（child 再拉起或复活 run）仍不开放。
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  // ResolveWorkflowQuestion 与 ResumeWorkflowRun 同属**结构性禁用**，但守的是另一条不变式：
  // 升级问答的语义是「actor 提问，创建这条工作流的那一方作答」。
  // 让一个 child 顺手作答，等于把「把判断权交回给能改掉那道门的人」悄悄退化成 actor 之间的
  // 互相说服——而一个同样被挡在门内的 actor 恰恰是最没有资格拍板的那个。
  //
  // 与 bootstrap 的 `ACTOR_DISALLOWED_TOOLS` **刻意重复**（CreateWorkflow 已有同样的双列
  // 先例）：那一份是 driver 侧 persona 工具面的减法；这一份按 taskType 覆盖全部 workflow
  // child，不依赖 driver 记得写。
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  // FillWorkflowHole 与 AmendWorkflow 同一个根因（alwaysAsk 在 child 里无窗可弹）加同一条不变式
  // （留白是脚本向**主代理**要代码，子代理不得替它写）：一并进列。
  FILL_WORKFLOW_HOLE_TOOL_NAME,
] as const;

/**
 * 子 runtime 不注册的 run 内省工具。
 *
 * 根因与上面那份名单不同：它们只读、无 gate，但要经 dwf run 端口读取，而端口只在 app 顶层
 * runtime——子 runtime 按不变式不得持有（`bootstrap/src/app/dynamic-workflow-run-progress-sink.ts`：
 * 持有了，子会话发起的 run 会把事件投进父会话的 transcript）。所以它们在子 runtime 里只会报
 * `workflow_introspection_unavailable`（线上 2026-10-20：workflow child 调用 155 次，全部失败）。
 * 不注册，模型就不会去调一个必然失败的工具。
 */
const RUN_INTROSPECTION_TOOLS = [LIST_WORKFLOW_RUNS_TOOL_NAME, GET_WORKFLOW_RUN_TOOL_NAME] as const;

/**
 * 子 runtime 的 taskType：不持有 dwf run 端口（docs/dynamic-workflow/launch.md「workflow child sessions」），
 * 也没有 `/workflow` 命令入口（下面的 resolveRuntimeDynamicWorkflowToolSurfaceDeferral）。
 */
const CHILD_TASK_TYPES_WITHOUT_RUN_PORT: ReadonlySet<SessionTaskType> = new Set<SessionTaskType>([
  "subagent_child",
  "workflow_child",
  "nested_workflow_child",
]);

/**
 * 运行时最终的工具禁用名单：turn 级 `toolDisallowlist` 叠加按 taskType 推导出的结构性禁用。
 * 放在这里而不是各个 child runtime 的构造点，是因为构造点有两个
 * （`workflow-facade.ts` 与 `script-workflow-child-runtime.ts`），两份名单必然漂移。
 */
export function resolveRuntimeDisallowedTools(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const structural = [
    ...(config.taskType === "workflow_child" ? WORKFLOW_CHILD_DISALLOWED_TOOLS : []),
    ...(config.taskType !== undefined && CHILD_TASK_TYPES_WITHOUT_RUN_PORT.has(config.taskType)
      ? RUN_INTROSPECTION_TOOLS
      : []),
  ];
  if (structural.length === 0) return config.toolDisallowlist;

  const disallowed = new Set(config.toolDisallowlist ?? []);
  for (const toolName of structural) disallowed.add(toolName);
  return [...disallowed];
}

/**
 * 动态工作流灰度门在 registerBuiltInTools 上的取值（docs/dynamic-workflow/launch.md「Gray release」）。
 * **缺席即开启**：独立 CLI 的 TUI 与 headless 根据 --workflow-mode 显式写 true/false，
 * protocol session 由受信 Host 控制，workflow_child 继承父配置。fail-closed 的缺省值在
 * 独立 CLI 入口和协议服务端的 appRuntimePreferences，不在这一层。
 *
 * 之所以和 resolveRuntimeDisallowedTools 一样收在这里而不是写在调用点：注册面有**两个**入口
 * （helpers/runtime-tools.ts 的首次装配、methods/embedded-search-branch.ts 的分支刷新），
 * 两个入口必须使用同一规则，否则刷新工具列表时可能重新注册已关闭的工作流工具。
 */
export function resolveRuntimeDynamicWorkflowToolsIncluded(runtime: {
  config: AgentRuntimeConfig;
  dynamicWorkflowToolsActivated: boolean;
}): boolean {
  // enabled ∧ (¬onDemand ∨ activated)：激活态归 runtime（launch.md「On demand: activation」），
  // 非 onDemand 会话出生即 activated，所以这里对 alwaysOn / TUI / headless 仍只看 enabled。
  return runtime.config.dynamicWorkflowEnabled !== false && runtime.dynamicWorkflowToolsActivated;
}

/**
 * 工作流工具面「开着、但本会话还没激活」时，本会话处在哪一种未激活形态（launch.md「On demand:
 * activation」）。只有 onDemand 会话在激活之前不是 "none"；disabled（技能本就不可发现）、alwaysOn、
 * 已激活都是 "none"。与上面的注册门读同一个 runtime 状态，不另存副本。
 *
 * 修复原因（评审 CR-01，两轮）：子 runtime 没有 `/workflow` 入口——命令只在顶层会话的输入门面展开，
 * 子 runtime 由父侧直接 `executeTurn` 驱动，父会话之后激活也不会改它的工具面。所以子 runtime 单独一档
 * "subagent"：给它的提示不能承诺「用户发 /workflow 之后工具会出现在本会话」。
 * 判据是「是不是子 runtime」，不是「是不是 Agent 子代理」：第一版只认 `subagent_child`，漏了 `/expert`
 * 的 `workflow_child`（bootstrap/src/app/workflow-facade.ts 整份展开父配置，onDemand 标记跟着过去，
 * 出生未激活），它被归成 "session"。这里复用上面那份子 runtime 名单，不另列一份。
 */
export function resolveRuntimeDynamicWorkflowToolSurfaceDeferral(runtime: {
  config: AgentRuntimeConfig;
  dynamicWorkflowToolsActivated: boolean;
}): DynamicWorkflowToolSurfaceDeferral {
  if (runtime.config.dynamicWorkflowEnabled === false || runtime.dynamicWorkflowToolsActivated) {
    return "none";
  }
  const taskType = runtime.config.taskType;
  return taskType !== undefined && CHILD_TASK_TYPES_WITHOUT_RUN_PORT.has(taskType)
    ? "subagent"
    : "session";
}

/**
 * Agent 是否总在后台运行（07-subagent.md「ZCode 当前实现」）。缺席即开启，只有显式 false 回到旧形态。
 * 与上面的灰度门同理收在这里：两个注册入口必须用同一规则，否则分支刷新会把 Agent 换成另一种形态。
 */
export function resolveRuntimeAgentAlwaysBackground(config: AgentRuntimeConfig): boolean {
  // 修复原因：workflow 子会话（/expert 节点）展开父配置，继承了缺省开启；它只读一次回合的回复，
  // 后台子代理之后的完成通知没有读取方，结果会丢。与结构性禁用同理按 taskType 定，不看开关。
  if (config.taskType === "workflow_child") return false;
  return config.subagents?.alwaysBackground !== false;
}

export function resolveBuiltInToolAllowlist(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const normalizedAllowlist = normalizeBuiltInToolAllowlist(config.toolAllowlist);

  if (config.toolset !== "explore") {
    return appendChildControlTool(config, normalizedAllowlist);
  }

  if (!normalizedAllowlist) {
    return appendChildControlTool(config, EXPLORE_AGENT_ALLOWED_TOOLS);
  }

  return appendChildControlTool(
    config,
    normalizedAllowlist.filter((toolName) => EXPLORE_AGENT_ALLOWED_TOOL_SET.has(toolName)),
  );
}

function appendChildControlTool(
  config: AgentRuntimeConfig,
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!allowlist) {
    return allowlist;
  }

  if (config.taskType === "subagent_child") {
    if (allowlist.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
      return allowlist;
    }
    // Explore 会在 runtime 注册前再次求工具交集，child 控制工具必须在最终结果补回。
    return [...allowlist, RESPOND_TO_COORDINATOR_TOOL_NAME];
  }

  // workflow child 没有 allowlist 收窄（persona 无工具档位，工具面只有减法，见
  // bootstrap 的 workflow-actor-tools.ts），submit_result / escalate 由 includeSubmitResult /
  // includeEscalate 两道门注册，不需要在这里补回。
  return allowlist;
}

function normalizeBuiltInToolAllowlist(
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  return allowlist?.map((toolName) => normalizeToolNameAlias(toolName));
}
