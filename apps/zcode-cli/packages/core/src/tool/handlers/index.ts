// import { replyToChannelToolEntry } from "./reply-to-channel.js";
import {
  SESSION_CONTROL_TOOL_NAMES,
  sessionControlTools,
  sessionControlToolsByKind,
} from "../session-control/index.js";
// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { deferredToolCallEntry } from "./deferred-tool-call.js";
import { toolSearchToolEntry } from "./tool-search.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronPauseSelfToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import { searchPluginsToolEntry, suggestPluginInstallToolEntry } from "./plugin-discovery.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { fillWorkflowHoleToolEntry } from "./fill-workflow-hole.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readTopicResourceToolEntry } from "./read-topic-resource.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// import { workflowToolEntry } from "./workflow.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// direct 分支保留 Glob/Grep 工具实现；embedded search 分支由 registerBuiltInTools
// 统一隐藏 Glob/Grep，并通过 Bash find/grep 接管搜索。

export const builtInTools: ToolEntry[] = [
  searchPluginsToolEntry,
  suggestPluginInstallToolEntry,
  ...sessionControlTools,
  toolSearchToolEntry,
  deferredToolCallEntry,
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  // applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  cronPauseSelfToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  submitResultToolEntry,
  // actor 的升级通道。与 submit_result 完全同构：
  // 端口在场即注册（includeEscalate），`tools:"none"` 下由 workflow_child 的 allowlist
  // 补回逻辑救回来。不入 actor 的默认 disallow——最可能撞上未预见之墙的 actor 恰是
  // 作者没标记的那一个。
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readTopicResourceToolEntry,
  // 渠道回复等待插件入口接入；仅注释默认注册，保留完整实现。
  // replyToChannelToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // 保存的定义：写侧 gate 与 CreateWorkflow 同档（alwaysAsk），读侧无 gate。
  saveWorkflowToolEntry,
  // workflow 创作的实验通道：同步、只读（v1）、完全瞬态。
  evalWorkflowSnippetToolEntry,
  // run 内省的两个只读工具：主会话 always-on、无 gate。它们不进 WORKFLOW_CHILD_DISALLOWED_TOOLS——
  // 那条禁令的理由是 CreateWorkflow 的 alwaysAsk 在子 runtime 里无窗可弹，只读查询不适用；但子
  // runtime 不持有 run 端口，它们在那里必然失败，所以按另一条规则从子 runtime 移除
  // （runtime/helpers/tool-allowlist.ts 的 RUN_INTROSPECTION_TOOLS）。
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // run 的恢复入口：与上面两个只读内省工具同族（run_id 键、端口探测失败同款），但它是
  // 执行语义——alwaysAsk 非 yolo 不可（cancelled 是用户的显式停止决定，复活必须先问），
  // 因此须进 WORKFLOW_CHILD_DISALLOWED_TOOLS（child yolo 无窗可弹）。插在 GetWorkflowRun 之后：run 工具簇 list/get/resume 相邻。
  resumeWorkflowRunToolEntry,
  // 升级问答的主代理侧：与上面三个 run 工具同族——
  // 同一个 dwf run 端口、同款 typeof 探测失败。与它们的不同点在下游：它进 actor 会话的
  // 禁用名单（bootstrap 的 workflowActorToolPolicy），子代理不许替主代理作答。
  resolveWorkflowQuestionToolEntry,
  // 留白补全的主代理侧（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：与
  // ResolveWorkflowQuestion 同族（run 端口、typeof 探测失败同款），但它在写脚本——与 AmendWorkflow
  // 同一道 alwaysAsk 门、同一条 owner 免确认规则，也同它一起进 workflow child 的禁用名单。
  fillWorkflowHoleToolEntry,
  // 定义清单（与上面两个 run 工具是两件事：那是历史，这是可跑的东西）。同为只读、无 gate。
  listSavedWorkflowsToolEntry,
  // 模型目录：同为只读、无 gate 的发现面，服务于 CreateWorkflow / AmendWorkflow 的
  // `subagent_model`。不进 WORKFLOW_CHILD_DISALLOWED_TOOLS
  // ——那条禁令的理由是 alwaysAsk 在 child 里无窗可弹，只读查询不适用。
  listModelsToolEntry,
  // workflowToolEntry,
];

/**
 * 动态工作流灰度门关闭时不注册的十个工具
 * （2026-09-28 起含 FillWorkflowHole：关闭态下没有 run 会到达留白）。
 * 灰度关的语义是「没有任何办法开始一条工作流」，所以创建、修订、保存、快照实验与四个
 * run 面工具一起下架；只读的 run 内省工具也在列，因为关闭态下它们只会指向用户无法再操作的历史。
 * `ListModels` **不在**这份名单里：这份名单同时是冷恢复激活判据（isDynamicWorkflowToolName），而只为
 * 给 `CreateSession.model` 挑模型调过一次 ListModels，不说明会话用过工作流。它的注册另有条件，见
 * registerBuiltInTools 里「有消费者才注册」那一段（规格 0.15）。
 * 旧的 `Workflow` 工具（`/expert` 脚本通道）是另一个功能，**不在**这份名单里。
 */
const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

/** 十个受灰度门管的工作流工具之一？冷恢复按历史判定激活时用（launch.md「On demand: activation」）。 */
export function isDynamicWorkflowToolName(toolName: string): boolean {
  return DYNAMIC_WORKFLOW_TOOL_NAMES.has(toolName);
}

interface RegisterBuiltInToolsOptions {
  includePluginDiscovery?: boolean;
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  includeSubmitResult?: boolean;
  /**
   * 在场时 submit_result 以 typed 声明注册（`{ result: <schema> }`，strict 资格），供 dwf mono
   * 子代理；缺席即通用声明。只在 includeSubmitResult 为真时有意义。
   */
  submitResultSchema?: JsonSchema;
  /** actor 的升级通道；门与 includeSubmitResult 同款（注入了 WorkflowEscalatePort 才注册）。 */
  includeEscalate?: boolean;
  includeWorkflow?: boolean;
  /** 只由可信启动绑定指定：选择同名会话工具的变体；未指定时这些工具都不注册。 */
  sessionControlKind?: "cli" | "app";
  includeAutomation?: boolean;
  /** Off-Peak 会话内创建工具面；由 host 的 offPeakToolEnabled flag（灰度/远程门）驱动。 */
  includeOffPeak?: boolean;
  /** 注入了 topicResourcePort（App 托管会话）才注册 ReadTopicResource；机器人授权在调用时校验。 */
  includeTopicResource?: boolean;
  /**
   * 动态工作流灰度门。**只有显式 false
   * 才下架** DYNAMIC_WORKFLOW_TOOL_NAMES：缺席代表调用方不参与灰度（TUI、headless、
   * workflow_child），它们必须保留全部工具面；fail-closed 的缺省值落在协议服务端的
   * appRuntimePreferences，不在这一层。
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl（js）默认关闭，由官方 browser-use 插件启用。 */
  includeNodeRepl?: boolean;
  /** browser-use 说明和 agent.browsers 注入由官方 browser-use 插件 + 宿主 browser bridge 共同启用。 */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  const sessionControlEntries = options.sessionControlKind
    ? new Map(
        sessionControlToolsByKind[options.sessionControlKind].map((entry) => [
          entry.metadata.name,
          entry,
        ]),
      )
    : undefined;
  for (const builtIn of builtInTools) {
    // 会话工具同名两种实现：独立 CLI 只有共有 8 个，App 另有 4 个；缺席即不注册。
    let entry = builtIn;
    if (SESSION_CONTROL_TOOL_NAMES.has(builtIn.metadata.name)) {
      const selected = sessionControlEntries?.get(builtIn.metadata.name);
      if (!selected) continue;
      entry = selected;
    }
    if (
      options.embeddedSearchEnabled === true &&
      (entry.metadata.name === "Glob" || entry.metadata.name === "Grep")
    ) {
      continue;
    }
    if (allowedTools && !allowedTools.has(entry.metadata.name)) {
      continue;
    }
    if (disallowedTools?.has(entry.metadata.name)) {
      continue;
    }
    if (isSubagentDispatchToolName(entry.metadata.name) && options.includeAgent !== true) {
      continue;
    }
    if (entry.metadata.name === "Skill" && options.includeSkill === false) {
      continue;
    }
    if (entry.metadata.name === "SendMessage" && options.includeSendMessage !== true) {
      continue;
    }
    if (
      entry.metadata.name === "RespondToCoordinator" &&
      options.includeRespondToCoordinator !== true
    ) {
      continue;
    }
    if (entry.metadata.name === "submit_result" && options.includeSubmitResult !== true) {
      continue;
    }
    if (entry.metadata.name === "escalate" && options.includeEscalate !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "SearchPlugins" || entry.metadata.name === "SuggestPluginInstall") &&
      options.includePluginDiscovery !== true
    )
      continue;
    if (entry.metadata.name === "Workflow" && options.includeWorkflow !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "CronCreate" ||
        entry.metadata.name === "CronList" ||
        entry.metadata.name === "CronUpdate" ||
        entry.metadata.name === "CronDelete" ||
        entry.metadata.name === "CronPauseSelf") &&
      options.includeAutomation !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "OffPeakCreate" || entry.metadata.name === "OffPeakList") &&
      options.includeOffPeak !== true
    ) {
      continue;
    }
    if (
      entry.metadata.name === readTopicResourceToolEntry.metadata.name &&
      options.includeTopicResource !== true
    ) {
      continue;
    }
    if (
      options.includeDynamicWorkflow === false &&
      DYNAMIC_WORKFLOW_TOOL_NAMES.has(entry.metadata.name)
    ) {
      continue;
    }
    // 规格 0.15：ListModels 有消费者才注册。它的两个消费者是 CreateWorkflow（灰度开启）与
    // CreateSession（会话控制在场）；两者都不在时（例如灰度关闭的子代理）留着它，只会叫模型去填
    // 不存在的工具。它不在 DYNAMIC_WORKFLOW_TOOL_NAMES 里，因为那份名单同时是冷恢复激活判据，
    // 而只为挑模型调过一次 ListModels 不说明会话用过工作流——两个用途对它的答案不同，所以分开判。
    if (
      entry.metadata.name === LIST_MODELS_TOOL_NAME &&
      options.includeDynamicWorkflow === false &&
      options.sessionControlKind === undefined
    ) {
      continue;
    }
    if (entry.metadata.name === "js" && options.includeNodeRepl !== true) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
): ToolEntry {
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  // 灰度门同时管工具面和**描述**：Agent / Task 的描述里有一条「工作流请求必须改用
  // CreateWorkflow」，关闭时那个工具不存在，留着只会把模型指向不存在的工具。用的是与注册过滤同一个
  // options.includeDynamicWorkflow，所以首次装配与分支刷新产出的描述必然一致。
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}
