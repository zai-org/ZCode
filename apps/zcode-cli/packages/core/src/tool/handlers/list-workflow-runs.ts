// ============================================================
// ListWorkflowRuns Tool Handler
// ============================================================
// 按项目（= 会话的工作目录）枚举 workflow run，含跨会话历史。
//
// handler 刻意**很薄**：标签、归属标注、状态合成、时间戳都由 run service 烹熟了交出来
// （端口的 `DynamicWorkflowRunListItem` 注释解释了为什么原料不过边界）。这里只做三件事：
// 取端口、把 cwd 钉成本会话的工作目录、把结果投影成契约形状。

import {
  LIST_WORKFLOW_RUNS_DEFAULT_LIMIT,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsInputJsonSchema,
  ListWorkflowRunsInputSchema,
  ListWorkflowRunsOutputJsonSchema,
  ListWorkflowRunsOutputSchema,
  type ListWorkflowRunsInput,
  type ListWorkflowRunsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  formatWorkflowRunTimestamp,
  workflowIntrospectionUnavailableFailure,
  workflowRunAttribute,
} from "./workflow-run-introspection.js";

const LIST_WORKFLOW_RUNS_TIMEOUT_MS = 10_000;
/** 照 CreateWorkflow：列表刻意轻（单行 SQL 可答），24k 足够 50 行还留着余量。 */
const LIST_WORKFLOW_RUNS_MODEL_BYTES = 24_000;

const LIST_WORKFLOW_RUNS_DESCRIPTION = [
  "Lists this project's dynamic-workflow runs (the session's working directory is the project key), most recently updated first. Includes runs started by other sessions — the run journal is per-project, not per-session.",
  "",
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  "",
  "- Each row gives the run ID, its label, lifecycle status, whether this session started it, tokens spent, and timestamps.",
  '- `possibly_interrupted="true"` means this session cannot confirm the run is still alive: it may be a leftover from a process that exited, or a sibling session\'s run still in flight. It is an annotation, not a verdict — do not report it as a failure.',
  "- Pass a run ID to GetWorkflowRun for progress detail, the log tail, the final result, or the failure.",
  "- Three terminal states: `completed`; `errored` (the script itself failed); `stopped` with `stop_reason` — `user` (cancelled on purpose: resume only when the user asks), `model` (your own TaskStop), `provider` (a provider-side error stopped it: read GetWorkflowRun for the cause, resolve it with the user, then resume), `interrupted` (the owning process exited: continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `superseded_by` names the live successor — never resume a superseded run).",
  "- Any stopped run other than a superseded one can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script. An errored run cannot.",
  "- ANY run here — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script; the new run imports the old one's finished work as a warm cache (and stops it first if it is still running). A run whose script errored is the case to reach for it — fix the script instead of rewriting the workflow from scratch. `resumed_from` on a row names the run it was amended from.",
].join("\n");

const listWorkflowRunsHandler: ToolHandler = async (input, context) => {
  const parsed = ListWorkflowRunsInputSchema.parse(input) as ListWorkflowRunsInput;

  const port = context.dynamicWorkflowRunPort;
  // 「端口缺席」与「端口在场但方法缺席」给同一个业务失败：对模型这是同一件事。可选成员按
  // typeof 探测（端口契约里 `cancel` 立下的先例）。
  if (port === undefined || typeof port.listRuns !== "function") {
    return workflowIntrospectionUnavailableFailure();
  }

  const result = await port.listRuns({
    // cwd 恒取本会话的工作目录：模型无权跨项目扫库，这同时是 `sideEffectScope: "none"` 的前提。
    // 字面等值匹配、不做路径规范化——写入侧（submit）原样落，读侧原样查，规范化只会造出单侧不匹配。
    cwd: context.workingDirectory,
    // 界已由输入 schema 钳到 [1, 50]（preprocess），端口因此从不看到一次无界枚举。
    // limit 是 `.default(…).optional()`：parse 结果一定带值，`??` 只用来收窄类型。
    limit: parsed.limit ?? LIST_WORKFLOW_RUNS_DEFAULT_LIMIT,
    ...(parsed.statuses === undefined ? {} : { statuses: parsed.statuses }),
  });

  return {
    runs: result.runs.map((item) => ({
      runId: item.runId,
      label: item.label,
      labelSource: item.labelSource,
      status: item.status,
      ...(item.stopReason === undefined ? {} : { stopReason: item.stopReason }),
      ...(item.resumedFrom === undefined ? {} : { resumedFrom: item.resumedFrom }),
      ...(item.supersededBy === undefined ? {} : { supersededBy: item.supersededBy }),
      ownedByThisSession: item.ownedByThisSession,
      // 为真时才在场：`false` 会给每一行挂一个噪音字段。
      ...(item.possiblyInterrupted ? { possiblyInterrupted: true } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      spentTokens: item.spentTokens,
    })),
    ...(result.truncated ? { truncated: true } : {}),
  } satisfies ListWorkflowRunsOutput;
};

/**
 * 模型面：一个 XML-ish 容器 + **一 run 一行**。
 *
 * 为什么不照 TaskOutput 把每个字段拆成独立元素：那是单对象详情的形状，50 行 × 8 个元素会把
 * 一次列表读成几百行，逼近 24k 预算而信息密度不变。属性式单行保留了同一套 XML-ish 标签惯例
 * （模型对它的解析很稳），同时让 50 行仍然是 50 行。
 */
function formatListWorkflowRunsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListWorkflowRunsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListWorkflowRuns returned an invalid result.";

  const { runs, truncated } = parsed.data;
  const header = [
    workflowRunAttribute("count", runs.length),
    ...(truncated ? [workflowRunAttribute("truncated", true)] : []),
  ].join(" ");

  if (runs.length === 0) {
    // 「这个项目没跑过 workflow」必须说成一句话：空容器容易被读成「工具没答上来」。
    return `<workflow_runs ${header}>\nNo workflow runs recorded for this project.\n</workflow_runs>`;
  }

  const rows = runs.map((run) =>
    [
      "<run",
      workflowRunAttribute("id", run.runId),
      workflowRunAttribute("status", run.status),
      ...(run.stopReason === undefined
        ? []
        : [workflowRunAttribute("stop_reason", run.stopReason)]),
      ...(run.resumedFrom === undefined
        ? []
        : [workflowRunAttribute("resumed_from", run.resumedFrom)]),
      ...(run.supersededBy === undefined
        ? []
        : [workflowRunAttribute("superseded_by", run.supersededBy)]),
      workflowRunAttribute("label", run.label),
      workflowRunAttribute("label_source", run.labelSource),
      workflowRunAttribute("owned_by_this_session", run.ownedByThisSession),
      ...(run.possiblyInterrupted ? [workflowRunAttribute("possibly_interrupted", true)] : []),
      workflowRunAttribute("spent_tokens", run.spentTokens),
      workflowRunAttribute("created_at", formatWorkflowRunTimestamp(run.createdAt)),
      workflowRunAttribute("updated_at", formatWorkflowRunTimestamp(run.updatedAt)),
      "/>",
    ].join(" "),
  );

  return [`<workflow_runs ${header}>`, ...rows, "</workflow_runs>"].join("\n");
}

export const listWorkflowRunsToolEntry: ToolEntry = {
  capability: "List this project's dynamic-workflow runs, including runs from other sessions",
  metadata: {
    shouldDefer: true,
    name: LIST_WORKFLOW_RUNS_TOOL_NAME,
    description: LIST_WORKFLOW_RUNS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    maxOutputBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listWorkflowRunsHandler,
  inputSchema: ListWorkflowRunsInputJsonSchema,
  outputSchema: ListWorkflowRunsOutputJsonSchema,
  runtimeInputSchema: ListWorkflowRunsInputSchema,
  runtimeOutputSchema: ListWorkflowRunsOutputSchema,
  formatModelContent: formatListWorkflowRunsModelContent,
  permission: {
    permission: "listWorkflowRuns",
    reason: "ListWorkflowRuns reads the run journal for the current project",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // 输入里没有路径主体（cwd 来自会话上下文），所以模式只按工具名匹配。
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 刻意**不**继承 CreateWorkflow 的 alwaysAsk：那道 gate 的理由是「执行整块代码」，
    // 读状态不属于它。
  },
  resultBudget: {
    maxInlineBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    maxModelBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
      // head：最近更新的 run 在前，截尾丢的是最旧的那些。
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    maxMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ListWorkflowRuns reads the run journal synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
