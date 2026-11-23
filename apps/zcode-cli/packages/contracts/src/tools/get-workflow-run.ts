// ============================================================
// GetWorkflowRun Tool - 单 workflow run 的自适应详情（进度摘要 / 产物 / 失败）
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentSchema,
} from "./get-workflow-run-roster.js";
import { WorkflowRunSummarySchema } from "./list-workflow-runs.js";

// 情势截面（阶段 / 子代理 / 健康）的 schema 住在 get-workflow-run-roster.ts，此处原样再导出
// 以保持 `@zcode/contracts` 的导入路径不变。
export * from "./get-workflow-run-roster.js";

export const GET_WORKFLOW_RUN_TOOL_NAME = "GetWorkflowRun";

export const GetWorkflowRunInputSchema = z
  .object({
    // snake_case 随 TaskOutput 的 `task_id`：在模型眼里这两个键是同一族的 run/task 标识，
    // 命名风格分叉只会让它在两个工具之间猜。
    run_id: z
      .string()
      .min(1)
      .describe("The workflow run ID to inspect (as returned by CreateWorkflow or ListWorkflowRuns)"),
  })
  .strict();

export type GetWorkflowRunInput = z.infer<typeof GetWorkflowRunInputSchema>;

export const GetWorkflowRunInputJsonSchema = toToolJsonSchema(GetWorkflowRunInputSchema);

/**
 * run 的进度与用量（观察面，没有任何上限）。`nodesObserved` 是**已落库节点的行数**（三态之和），
 * 绝不冒充「总步数」：动态工作流没有静态总数，而 `queued` 只存在于事件相位、不落库。
 */
export const GetWorkflowRunUsageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

/** 一个 actor 站点实例。`persona` 刻意不出：整段 system prompt 是天然无界的字段。 */
export const GetWorkflowRunActorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

/**
 * 一条 `log()` 叙事。`at` 是这条事件落 journal 的时刻（`dwf_event.time_created`），模型面据它
 * 渲染「多久以前」；没有这一列的老 journal 上缺席，那样的行就不带年龄前缀——**绝不**用读时的
 * `Date.now()` 兜底，那会把一周前的整段叙事标成「刚刚」。
 */
export const GetWorkflowRunLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string(),
    at: z.number().optional(),
  })
  .strict();

/**
 * 一个此刻停驻、等主代理作答的升级问题。
 *
 * 这是升级通知丢弃后的**查询兜底**，也是模型侧唯一的发现面：`ResolveWorkflowQuestion` 只认
 * `qid`，而通知有两条已知的丢弃路径（stale branch generation / shutdown）。`askedAt` 让模型
 * 看得出「这个问题已经等了多久」——没有超时会替它兜底。
 */
export const GetWorkflowRunPendingQuestionSchema = z
  .object({
    qid: z.string(),
    /** 提问的 actor，`site@ordinal` 形态。 */
    actor: z.string(),
    /** 该 actor 的人类可读名；匿名 actor 缺席（读侧自己决定怎么渲染「无名」）。 */
    actorName: z.string().optional(),
    question: z.string(),
    context: z.string().optional(),
    /** 提问时刻（epoch ms，与 createdAt / updatedAt 同一把尺）。 */
    askedAt: z.number(),
  })
  .strict();

/** `holes` 的上界，与 display 契约的留白上界同值（docs/dynamic-workflow/presentation.md）。 */
export const GET_WORKFLOW_RUN_MAX_HOLES = 32;

/**
 * 一处留白（docs/dynamic-workflow/authoring.md「Holes」）。`waiting` 的在等主代理用
 * `FillWorkflowHole` 补上函数体，`filled` 的已经补过；`since` / `filledAt` 与 createdAt 同一把尺。
 * 与升级问题一样，这是通知丢失后模型侧唯一的发现面。
 */
export const GetWorkflowRunHoleSchema = z
  .object({
    /** 留白的站点 id（`hole#21b40fca`，名字键），`FillWorkflowHole` 的 `hole_id` 就是它。 */
    siteId: z.string(),
    ordinal: z.number(),
    /** 留白的字面名。 */
    name: z.string(),
    /** 类型实参原文（`Verdict`）。 */
    type: z.string(),
    state: z.enum(["waiting", "filled"]),
    /** 到达时刻（epoch ms）；`waiting` 时在场。 */
    since: z.number().optional(),
    /** 补全时刻（epoch ms）；`filled` 时在场。 */
    filledAt: z.number().optional(),
    /** 补全它的会话。 */
    filledBy: z.string().optional(),
  })
  .strict();

export type GetWorkflowRunHole = z.infer<typeof GetWorkflowRunHoleSchema>;

/**
 * 一件**用户面产物**：脚本经 `artifact.*` 发布给用户看的
 * 产出，此刻已经作为卡片摆在用户面前。
 *
 * ⚠ 术语：与本工具输出上的 `result`（脚本顶层返回值，引擎内部也叫 artifact）是**两件不同的
 * 东西**。模型侧的用法也不同：`result` 是要转述的内容，产物是要按
 * 标题**引用**的东西。
 *
 * 刻意**不带 `uri`**：模型读不了 tool-artifact store。字段取**最新版**的值（`version` 是版本
 * 号，历史版本的元数据在 UI 侧板上）。
 */
export const GetWorkflowRunArtifactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
    /** 卡片标题；脚本没给时缺席（facade 的默认标题就是 id）。 */
    title: z.string().optional(),
    /** 最新版号。 */
    version: z.number(),
    /** 内容产物的 MIME；预置看板缺席。 */
    contentType: z.string().optional(),
    /** 内容产物最新版的字节数；预置看板缺席。 */
    bytes: z.number().optional(),
    /** 内容产物的工作区出处（字节已拷进 store，这只是「它原本在哪」）。 */
    sourcePath: z.string().optional(),
    /** 预置看板收到的标签 `report` 条数；内容产物恒 0。 */
    itemCount: z.number(),
    /** run 的交付物（至多一件），排在清单最前。 */
    primary: z.literal(true).optional(),
  })
  .strict();

/** 结构化失败。`code` 是稳定判别键——模型必须能分辨「进程死了」与「脚本真失败」。 */
export const GetWorkflowRunErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** 只在 `code === "ProviderStop"` 时在场。 */
    providerStop: z
      .object({
        kind: z.enum([
          "auth",
          "not_configured",
          "model_unavailable",
          "invalid_request",
          "quota",
          "other",
        ]),
        reason: z.string(),
        providerId: z.string().optional(),
        providerLabel: z.string().optional(),
        modelId: z.string().optional(),
        providerCode: z.string().optional(),
        subagent: z.string().optional(),
        subagentName: z.string().optional(),
        phase: z.string().optional(),
        rawMessage: z.string().optional(),
        resetAt: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `summary` 的字符上界。一句话的预算：超出它的不是摘要，是又一份报告。 */
export const GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS = 400;

export const GetWorkflowRunOutputSchema = WorkflowRunSummarySchema.extend({
  /**
   * 情势的一句话：状态 + 已跑/已结束多久 + 阶段位置 + 步数与在飞细分 + 待答问题 + 最后进展。
   * 由 handler 从下面这些结构化字段**确定性**拼出（没有模型参与），所以同一份快照永远拼出
   * 同一句话；上界 {@link GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS}，超出时整句整句地丢尾巴。
   */
  summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS),
  /**
   * 这次快照被读出来的时刻（epoch ms）。模型面上每一个「多久以前」都是对它算的——
   * 一次输出一把尺，两个年龄才可比。`formatModelContent` 只收一个参数（core 的 ToolEntry
   * 契约），所以读时钟只能发生在 handler 里、并把结果随输出带过来；格式器因此是
   * `(output) => text` 的纯函数，可以逐字钉住。
   */
  generatedAt: z.number(),
  usage: GetWorkflowRunUsageSchema,
  /**
   * 本 run 自己的并发上界（同时在飞的子代理数），**只在低于当前天花板时在场**：跑在天花板上的
   * run 没有可说的（与 pendingQuestions 的「无则缺席」同规）。AmendWorkflow 省略 `max_concurrency`
   * 时沿用的就是这个值——模型据此知道一次修订会继承什么。
   */
  maxConcurrency: z.number().int().positive().optional(),
  /**
   * 本 run 的子代理跑在哪个模型上，规范形 `providerId/modelId[$reasoningLevel]`，**只在设过时
   * 在场**：跟着会话模型跑的 run 没有可说的（与 `maxConcurrency` 的「无则缺席」同规）。
   * AmendWorkflow 省略 `subagent_model` 时沿用的就是这个值。
   */
  subagentModel: z.string().optional(),
  /**
   * 本 run 的脚本点名的模型：脚本逐字写下的名字 → 规范形，**只在脚本点名过模型时在场**。
   * AmendWorkflow 里同名的模型沿用的就是这些绑定。
   */
  modelBindings: z.record(z.string(), z.string()).optional(),
  /**
   * 本 run 的脚本文件，**已经写成模型面该看到的样子**（在会话工作目录之下就是工作区相对路径，
   * 否则绝对路径）。**只在这个 run 记下过文件
   * 时在场**（与 `subagentModel` 的「无则缺席」同规）：草稿写不下去的项目、本特性之前发起的
   * run 都没有可说的。在场时它就是下一次 `AmendWorkflow` 该传的 `path`。
   */
  scriptPath: z.string().optional(),
  actors: z.array(GetWorkflowRunActorSchema),
  /** `log()` 事件的尾巴，按时序（sequence 升序）。无 log 事件即空数组。 */
  logTail: z.array(GetWorkflowRunLogEntrySchema),
  /**
   * 阶段表：声明序的已声明阶段，后面接上「进过但没声明」的那些。**脚本没声明阶段、也一个
   * 都没进过时整字段缺席**——那样的 run 没有阶段这回事，空数组读起来像「阶段表是空的」。
   */
  phases: z.array(GetWorkflowRunPhaseSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases).optional(),
  /**
   * 子代理花名册，按铸造顺序。**恒在场**，一个 actor 都没有的 run 是空数组：与 `phases`
   * 不同，「这个 run 有几个子代理」永远是个有答案的问题，而 0 就是那个答案。
   *
   * 与并列的 `actors` 刻意不合并：那是一张恒定的身份表，这里每一项都是读时快照。
   */
  subagents: z.array(GetWorkflowRunSubagentSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents),
  /** 花名册被这条界裁过。无则缺席（同 `truncated` 家族：不打 `false`）。 */
  subagentsTruncated: z.literal(true).optional(),
  /** run 整体还在不在动。恒在场。 */
  health: GetWorkflowRunHealthSchema,
  /**
   * 脚本的顶层返回值，**已序列化成文本**（string 原样、其余 pretty JSON）。只有 completed 的
   * run 才在场；`undefined` 产物即整字段缺席。
   *
   * 之所以收 string 而不是原值：面向模型的序列化在 core 有唯一实现
   * （`serializeWorkflowArtifact`，完成通知与 TaskOutput 共用它）。放行原值等于允许「同一个
   * run 的产物在通知里和在本工具里长得不一样」。
   */
  result: z.string().optional(),
  /** errored 恒在场；stopped 只对 provider / interrupted 在场。code 原样透出，不折叠。 */
  error: GetWorkflowRunErrorSchema.optional(),
  /**
   * 此刻还欠答案的升级问题，按提问顺序。**零条时整字段缺席**（与端口投影同规，不发空数组）：
   * 读侧据此让整块 pending 区消失，而不是渲染一个空节。
   */
  pendingQuestions: z.array(GetWorkflowRunPendingQuestionSchema).optional(),
  /**
   * 本 run 的留白（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；引擎文档
   * 「The run snapshot」）：到达过的每一处，`waiting` 的在等主代理的函数体，`filled` 的已经补上。
   * 与 pendingQuestions 同规：**零条时整字段缺席**、有界 32；它是留白通知丢失后的查询兜底。
   */
  holes: z.array(GetWorkflowRunHoleSchema).max(GET_WORKFLOW_RUN_MAX_HOLES).optional(),
  /**
   * 本 run 已发布的用户面产物，按首次发布顺序，**任意状态都附**（一个还在跑的 run 也可能
   * 已经交付了第一张图）。**零件时整字段缺席**，与 pendingQuestions 同规。有界 32
   * （= `ARTIFACT_CAPS.maxArtifactsPerRun`，一个 run 最多能有的 id 数）。
   */
  artifacts: z.array(GetWorkflowRunArtifactSchema).optional(),
}).strict();

export type GetWorkflowRunOutput = z.infer<typeof GetWorkflowRunOutputSchema>;

export const GetWorkflowRunOutputJsonSchema = toToolJsonSchema(GetWorkflowRunOutputSchema);
