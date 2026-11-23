// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";
import {
  WorkflowAdjustableSettingsSchema,
  WorkflowModelBindingsSchema,
} from "./workflow-settings.js";

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * 教模型写工作流的内置技能名（apps/zcode-cli/packages/bundled-skills/skills/<name>/SKILL.md）。
 * 四个创作工具（Create/Amend/Save/EvalWorkflowSnippet）的 resolveInput 以它为门：会话里没有
 * 加载过这份技能就拒绝提交脚本（docs/dynamic-workflow/authoring.md「The authoring surface」）。
 * 住在 contracts 里是因为 core 的门与 bootstrap 的技能包都读它，而两者不能互相 import。
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/**
 * 「一个来源都没到」的共用尾句（CreateWorkflow 与 EvalWorkflowSnippet；两者字段全可选）。
 *
 * Bug 原因：参数不是合法 JSON 时，adapter 记 `model.tool_input.normalize_failed` 后把调用恢复成
 * `{}`（adapters/src/model/tool-input-normalization.ts），`{}` 能过 schema，于是在「恰好一个来源」
 * 上失败。旧文案把「多给」与「没给」并成一句「…or none, is ambiguous」，明明写了脚本的模型读不出
 * 原因，只会原样重发同一个坏调用。所以「没给」单独成句，并说出最常见的原因和绕开它的办法。
 */
export const WORKFLOW_SOURCE_MISSING_HINT =
  "If you did pass one, the call's arguments were not valid JSON, and a call that does not parse arrives empty. The usual cause is an unescaped backslash or double quote in the inline source: inside a JSON string a regex's `\\d` must be written `\\\\d`. Escape it, or write the source to a file and pass `path`.";

/** 多给了来源（选择要撤回）。写成常量是因为模型是它唯一的读者，三条路径同一句话。 */
export const CREATE_WORKFLOW_SOURCE_CONFLICT_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one is ambiguous.";

/** 一个来源都没有：多半是参数没解析出来（见 {@link WORKFLOW_SOURCE_MISSING_HINT}）。 */
export const CREATE_WORKFLOW_SOURCE_MISSING_ERROR = `No workflow source arrived. Pass \`script\` for a one-off script written inline, \`saved\` to run a workflow saved in this project, or \`path\` for a script file on disk. ${WORKFLOW_SOURCE_MISSING_HINT}`;

/** `args` 只属于 `path` 来源的违规说明（`saved` 有自己的 `saved.args`，内联脚本没有声明）。 */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * `saved` 来源。模型填 `name`，可选 `args` 与 `scope`（消歧用）；`path` 是 `resolveInput`
 * 解析后**回填**的事实，`scope` 归一化后也变成命中的那一根，所以两者都可选。
 *
 * 归一化输入因此是一个 `script` 与 `saved` **同时在场**的合法执行态——这正是 XOR 不能写在
 * zod 上的原因（见 {@link CreateWorkflowInputSchema}）。
 */
export const CreateWorkflowSavedSourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("Name of a saved workflow (see ListSavedWorkflows)."),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Values for the arguments the saved workflow declares."),
    /** 解析回填：保存文件的落点。模型不填。 */
    path: z.string().min(1).optional(),
    /**
     * 消歧：从哪一档取这个 workflow。缺省走既有查找顺序（同名时项目档遮蔽全局档）。
     * 归一化后 `scope` 变成**命中**的那一根，见 create-workflow-source.ts。
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * 运行时的 `saved` 块：模型面那些字段 + `draft`。
 *
 * `draft` 是 `resolveInput` 写下那份工作副本之后回填的**落点**：保存的定义永远不因为一次 run 被改动，模型要改的是这份拷贝。它与
 * `AmendWorkflow.predecessor` 同一个姿态——事实由工具算，模型的 JSON schema 不列它，所以模型
 * 不会以为自己该填一个路径。写不下去时字段整个缺席（草稿是尽力而为）。
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * 执行体有三个来源，恰好给一个——但这条 XOR **刻意不写在 schema 上**。
 *
 * 理由是归一化：`resolveInput` 把保存的脚本（或 `path` 文件）解析出来之后，输入同时带着
 * `script`（要跑的字节）与 `saved` / `path`（它的来龙去脉）。一条 superRefine 会在两个地方炸掉
 * 这个合法形状——handler 自己的 `parse`，以及 hook 改写输入后 call-runner 的二次校验——而且
 * **只在非内联路径上**炸，属于那种测不到就上线的错误。XOR 因此由 `entry.validateInput` 在
 * **模型入参**上强制，那里正是它唯一为真的地方。JSON schema 本来也表达不了 refinement，
 * 模型侧靠字段描述引导。
 */
const CreateWorkflowModelInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
      ),
    script: z
      .string()
      .optional()
      .describe(
        "The whole workflow script, inline. Exactly one of `script`, `saved` and `path`.",
      ),
    saved: CreateWorkflowSavedSourceSchema.optional().describe(
      "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.",
    ),
    /**
     * 第三条来源：
     * 盘上的一个脚本文件。它是内联提交的**回程**——工具写下草稿、结果点名那个文件，模型下一次
     * 只改一行再把同一个路径交回来。带 `/* zcode-workflow` 块的文件按保存定义解析（块剥掉、
     * 正文当脚本、`args` 按块里的声明校验）。
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * `path` 文件声明的实参。`saved` 有自己的 `saved.args`（同一套校验规则），内联脚本没有声明，
     * 所以这个字段与 `path` 同进同退——`validateInput` 在模型入参上把这条钉住。
     */
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * run 自己的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。高于或低于
     * 默认并发都行、没有上限：`resolveInput` 只向下取整到至少 1，确认窗与 handler 看到的就是将要生效的
     * 值。缺席即默认并发。只在用户要求时设——provider 限流由运行时自适应，模型不该拿它当保险。
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Subagents working at once, above or below the default. Only when the user asks for more or less parallelism; never as a reaction to provider errors.",
      ),
    /**
     * 本 run 子代理跑在哪个模型上。与
     * `max_concurrency` 同族：模型面收一个宽松的字符串，`resolveInput` 经模型目录端口解析成
     * 规范形 `providerId/modelId[$reasoningLevel]`——确认窗与 handler 读到的就是将要生效的值，
     * 解不出来在开窗**之前**就作为业务失败退回。主代理自己恒留在会话模型上；缺席即子代理也是。
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks, and never a model under another provider the user did not name — ask them first if one would help; you stay on the session model.",
      ),
    // 修订续跑不在这里：它是 `AmendWorkflow` 的工作（amend-workflow.ts）。`.strict()` 让旧写法 `resume_from` 成为可见的 schema 错误，
    // 而不是被静默忽略后变成一次全价重跑。
  })
  .strict();

/**
 * 运行时入参：模型面那些字段 + `resolveInput` 回填的事实。
 *
 * 回填项与 `AmendWorkflow.predecessor` 同一个姿态——模型的 JSON schema 不列它们，因为它们不是
 * 可填的参数而是解析结果；模型若硬填，归一化会无条件覆盖。
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * 正文行 → 文件行的偏移（`path` / `saved` 文件带元数据块时才非零）。诊断按文件行报出来时
   * 加它，好让行号能直接粘进一次对该文件的 `Edit`。
   */
  script_line_offset: z.number().int().nonnegative().optional(),
  /**
   * 确认窗可调的两项设置（docs/dynamic-workflow/launch.md「Adjusting the settings in the window」），
   * 端口在场时由 `resolveInput` 回填。同上：解析结果，模型的 JSON schema 不列它。
   */
  adjustable_settings: WorkflowAdjustableSettingsSchema.optional(),
  /**
   * 脚本点名的模型解析成的绑定表（docs/dynamic-workflow/launch.md「Models the script names」），
   * `resolveInput` 回填。同上：解析结果，模型的 JSON schema 不列它。
   */
  model_bindings: WorkflowModelBindingsSchema.optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** 交给模型的 JSON schema：不含 `script_line_offset`、`adjustable_settings` 与 `model_bindings`，`saved` 里也不含 `draft`。 */
export const CreateWorkflowInputJsonSchema = toToolJsonSchema(CreateWorkflowModelInputSchema);

export const CreateWorkflowDiagnosticSchema = z
  .object({
    code: z.number(),
    column: z.number(),
    line: z.number(),
    message: z.string(),
  })
  .strict();

export type CreateWorkflowDiagnostic = z.infer<typeof CreateWorkflowDiagnosticSchema>;

// CreateWorkflow display 是独立于模型文本的有界投影：诊断可能很多，必须在协议边界限长，
// 避免类型检查结果把 continuous/replayable 消息扩成无界载荷。
// 诊断的 display 条目形状同时被 create_workflow 与 eval_workflow_snippet 两个 display
// payload 复用（同一 TS 诊断形状、同一道限长），因此定义在这里而不是 tool-result-metadata.ts
// ——后者要反向引用本文件里的 schema，放那里会成环。
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100;
export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2_048;

export const createWorkflowToolResultDisplayDiagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
  })
  .strict();

// Causality graph 是 display 通道的有界投影，但直接在工具输出边界限长：持久化的 tool
// output 与实时 display 载荷共用同一个契约，避免两处各自演化出不同的截断语义。
// 载荷只装 GUI 真正读的字段：边是
// `{from, to, back?}` 一种形状，region / certainty / 边种类都留在分析器里。第二层
// 是子代理导向：每阶段的参与者卡 + 交接边；
// step 级边因此不再进载荷（没有读者），step / 车道留作运行状态与检视器的键。
export const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128;
export const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128;

// `hole`：还开着的留白是一个站点（docs/dynamic-workflow/presentation.md「Holes on the timeline」），
// 车道是主代理的 `main`；补过的留白不再是站点。
export const CREATE_WORKFLOW_STEP_KINDS = ["ask", "world-read", "hole"] as const;

// 名字只在运行时成形（`` agent(`研究员${i + 1}`) ``）时静态能拿到的那部分：第一个洞之前的
// 字面量（head）与最后一个洞之后的字面量（tail）。两者至少有一个在场——分析器拿不到就整个
// 字段缺席，不会发空 pattern。**只搬数据**：把它渲染成「研究员…」的省略号是渲染层的决定。
export const CreateWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    tail: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowNamePattern = z.infer<typeof CreateWorkflowNamePatternSchema>;

// 一个 step = 一次要等待的 facade 操作（ask / files.*）。lane 是执行它的 actor（或
// workspace / unknown）；lanes 只在接收者是 may-set 时出现，此时该 step 已按候选车道展开成
// 每车道一份拷贝（各带 source）。repeat 区分两种多重性线索：stack（实例共存，画叠卡）与
// serial（实例相继，已由闭环箭头表达）。
// certainty / region 不进载荷：GUI 不画它们。
export const CreateWorkflowStepSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    kind: z.enum(CREATE_WORKFLOW_STEP_KINDS),
    label: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** `label` 只拿到兜底串（内联 `agent()` receiver）时，那个名字的静态形状。 */
    labelPattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lanes: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_LANES)
      .optional(),
    /**
     * 展开自的站点 id，只在 may-set 车道展开的拷贝上出现（拷贝 id 形如 `ask#2~actor#1`）。
     * 它是实时叠加的关联键：运行时实例报的是站点 id，所以带 source 的卡片按
     * `(node.siteId === source, node.actorSiteId === lane)` 收状态。刻意不参与引用完整性
     * 收敛——它指向的是被拷贝替换掉的那个站点，图里没有这个节点。
     */
    source: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /**
     * 作者用 `phase("…")` 标记划入的阶段（`phase#2`，或保留的 `unphased`）。与图的
     * `phases` / `phaseEdges` / `exits` 同进同退：四者要么全在场（此时**每个** step 都带一个，
     * 划分是全的），要么全缺席（零标记脚本）。
     */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    repeat: z.enum(["stack", "serial"]).optional(),
    /**
     * 这个站点是某次留白补全写进来的：值是补全它的留白站点 id（名字键 `hole#<8 位十六进制>`）；留白**自己的**阶段上是包着它的留白。时间轴据它画补全的
     * 笔头与区域（docs/dynamic-workflow/presentation.md「Holes on the timeline」）；没有补全过的脚本
     * 一律缺席。
     */
    fill: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowStep = z.infer<typeof CreateWorkflowStepSchema>;

// Lane = 一个 actor（外加一条 workspace 车道）。多重性不再挂在车道上（曾是 families →
// nesting）：车道不再渲染，家族的成员数由参与者的 `member` / `many` 表达。
export const CreateWorkflowLaneSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    /** `name` 缺席而 `agent()` 首参是带洞的模板串时的静态形状；与 `name` 互斥。 */
    namePattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export type CreateWorkflowLane = z.infer<typeof CreateWorkflowLaneSchema>;

// 边只表示一件事：runs after。阶段边与交接边同一形状。`back` 标记循环回边——画法与其他
// 边完全相同、不标注，只有布局排秩（回边不参与列序）与帧头 cycle 计数读它。分析器的
// kind / certainty / exact 不进载荷；两层边都做过统一的传递归约。
export const CreateWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    back: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowEdge = z.infer<typeof CreateWorkflowEdgeSchema>;

/**
 * 阶段流（docs/dynamic-workflow/presentation.md「Streams」）：`from` 阶段在两者都在跑的时候把东西
 * 交给 `to` 阶段——channel 串起来的两个 future 阶段。它**不是** runs after，所以不进 `phaseEdges`、
 * 不带 `back`（方向由 UI 按站的位置判断），也不带分析器的边种类。
 */
export const CreateWorkflowStreamSchema = z
  .object({
    from: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
  })
  .strict();

export type CreateWorkflowStream = z.infer<typeof CreateWorkflowStreamSchema>;

// 参与者 = 板面第二层的一张卡：某阶段里在某条车道上有 step 的那个子代理（或工作区 /
// 未解析）。fan-out 家族按字面量基数展开时每成员一张（`member`），基数未知时一张 `many`
// 卡代表全部成员。`steps` 是它在本阶段的 step——运行状态由此聚合，检视器由此列 ask。
// 数组顺序就是交接序（分析器定）：折叠面自上而下、展开面自左而右，第一张是开局者。
export const CreateWorkflowParticipantSchema = z
  .object({
    /** `${phase}:${lane}`，家族成员 `${phase}:${lane}[${index}]`。 */
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** 阶段 id；脚本无阶段词汇时恒为 `unphased`（此时 `phases` 缺席）。 */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    steps: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    member: z
      .object({
        index: z.number().int().nonnegative(),
        of: z.number().int().positive(),
      })
      .strict()
      .optional(),
    many: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowParticipant = z.infer<typeof CreateWorkflowParticipantSchema>;

// 交接 = 参与者之间的 runs after（归约后 happens-before 按卡取商）。`types` 是跨越这条边的
// 产物类型（站点图 data 边），只进检视器，不上箭头。
export const CreateWorkflowHandoffSchema = CreateWorkflowEdgeSchema.extend({
  types: z
    .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS))
    .min(1)
    .max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
    .optional(),
}).strict();

export type CreateWorkflowHandoff = z.infer<typeof CreateWorkflowHandoffSchema>;

// Phase = 作者用 `phase("…")` 标记出的一组 step。名字是键（同名的两处标记是同一个阶段），
// 所以 `name` 就是作者原词；合成兜底阶段 `unphased` **无 name**，显示名由 UI 本地化
// （与 workspace/unknown 车道同一模式）。loc 是首个标记的位置。
export const CreateWorkflowPhaseSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    /**
     * 进入本阶段时**还在跑**的其他阶段：它们 fan-out 出去的 strand 当时尚未 join。阶段表序，
     * 列出的阶段 id，不含自己，为空时整个字段缺席（与词汇表同进同退）。
     *
     * 它是**节点事实**而不是边——控制并没有从那些阶段转移过来，两边是同时在场的，所以它既不
     * 进 `phaseEdges` 也不参与边的归约（归约会把它当成 runs after，砍掉真正的边）。
     * 读者是时间轴：把由它串起来的相邻阶段折成一条分叉的「带」，主线之上再起支线轨道；
     * 侧栏迷你轨道据此画双线段。
     */
    alongside: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
    /** 这个阶段是某次留白补全写进来的：值是补全它的留白站点 id（同 `Step.fill`）。 */
    fill: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowPhase = z.infer<typeof CreateWorkflowPhaseSchema>;

/** `holes` 的上界，与阶段表同一个数：一处留白就是一个阶段。 */
export const CREATE_WORKFLOW_GRAPH_MAX_HOLES = CREATE_WORKFLOW_GRAPH_MAX_PHASES;

// 一处**还开着的**留白（docs/dynamic-workflow/authoring.md「Holes」；presentation.md「Holes on the
// timeline」）：时间轴画成一个虚线站点，确认窗列成一枚 chip。补过的留白不在这里——它的函数体已经
// 是普通的站点与阶段，只带 `fill` 标记。
export const CreateWorkflowHoleSchema = z
  .object({
    /** 留白的站点 id（名字键 `hole#<8 位十六进制>`），也是它作为阶段的 id。 */
    siteId: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** 留白的字面名。 */
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** 类型实参原文（`Verdict`）。 */
    type: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** 它出生的阶段 id（`phases[].id`）；与阶段词汇表同进同退。 */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /** 尾留白：`return await hole(...)`，脚本的结尾还没写。 */
    tail: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowHole = z.infer<typeof CreateWorkflowHoleSchema>;

// 名字沿用历史（它曾只装因果图）。三层：step 层是站点（运行状态的键，不再画）；参与者层
// 是每阶段的卡与交接（因果事实按卡取商）；阶段层是控制流事实（控制流图的阶段商）。层间的桥
// 是 `Participant.phase` / `Participant.steps`、`Step.phase` 与 `exits`。
export const CreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z.array(CreateWorkflowStepSchema).max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    lanes: z.array(CreateWorkflowLaneSchema).max(CREATE_WORKFLOW_GRAPH_MAX_LANES),
    participants: z
      .array(CreateWorkflowParticipantSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
    handoffs: z.array(CreateWorkflowHandoffSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
    /**
     * 阶段词汇表，与 `phaseEdges`、`exits`、`Step.phase` **全有或全无**：零标记脚本四者全
     * 缺席，UI 的视图切换条件就是「词汇表在场与否」。超界时也是整体缺席（+ `truncated`）
     * ——裁一半的阶段图会说谎。零成员的阶段（只有标记、没有 step）也在表里：控制流会经过它。
     */
    phases: z.array(CreateWorkflowPhaseSchema).max(CREATE_WORKFLOW_GRAPH_MAX_PHASES).optional(),
    phaseEdges: z
      .array(CreateWorkflowEdgeSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
    /**
     * 阶段流：因果图阶段商里两端互为 `alongside` 的 `data` 边（bounds 层求得），与词汇表同进同退，
     * 组内没有时缺席。时间线据它把流水线的各阶段从带里拿出来排成一条线，画成流轨。
     */
    phaseStreams: z
      .array(CreateWorkflowStreamSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
    /**
     * 控制流可以在其后正常完成的阶段（控制流图阶段商里指向 sink 终端的边的源），阶段表序。
     * 阶段视图的「阶段 → 返回物」箭头读它，让那张画面上的每条箭头都是控制流。组内可为空
     * （脚本没有正常完成路径），组外不得单独出现。
     */
    exits: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
    /** 返回物由哪些 step 供给（数据事实，下钻用）；脚本无返回时缺省。 */
    sink: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS)
      .optional(),
    /**
     * 还开着的留白，源序（docs/dynamic-workflow/presentation.md「The display contract」）。一处留白
     * 就是一个阶段，所以上界与阶段表同值；补过的留白不在这里，它写进来的阶段与站点带 `fill`。
     * 零处时整字段缺席。
     */
    holes: z.array(CreateWorkflowHoleSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HOLES).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export type CreateWorkflowCausalityGraph = z.infer<typeof CreateWorkflowCausalityGraphSchema>;

/**
 * run 的声明阶段表：因果图里**有名**的
 * 阶段，按声明序。运行状态只知道已进入的阶段，侧栏迷你轨道要画"前方还有哪些站"就得在提交时把这张表
 * 交给引擎记进 `run-launched`。两条提交路径（`CreateWorkflow` 工具、中枢直接启动）共用本函数，
 * 于是同一份脚本在两条路上画出同一条轨道。无图 / 无阶段词汇表 / 只有合成的 `unphased` → `undefined`
 * （字段整个缺席，而不是空数组：UI 据缺席画一个隐含站点）。
 */
export function createWorkflowPhaseNames(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string[] | undefined {
  return namedPhases(graph)?.map((phase) => phase.name);
}

/**
 * 与 {@link createWorkflowPhaseNames} **按位置对齐**的「同时在跑」表：`out[i]` 是声明表里第 i
 * 个有名阶段被进入时，strand 仍在跑的其他阶段的下标（同一张有名阶段表里的下标）。
 *
 * 下标空间是**有名阶段**的，不是因果图原阶段表的：无名阶段（合成的 `unphased`）被跳过，
 * 指向它、指向未列出阶段、或指向自己的引用一并丢掉——侧栏拿到一个越界下标就会把「同时在跑」
 * 连到错误的站上。它随 `DynamicWorkflowRunSubmitRequest.phaseAlongside` 进入 `run-launched`，
 * 侧栏迷你轨道据此把带内相邻的两站画成双线段。
 *
 * 无图 / 无阶段词汇表 / 没有任何阶段带 alongside → `undefined`（字段整个缺席，而不是一串空
 * 数组：缺席就是「这条轨道是一条直线」）。
 */
export function createWorkflowPhaseAlongside(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): number[][] | undefined {
  const named = namedPhases(graph);
  if (named === undefined) return undefined;
  const indexOf = new Map(named.map((phase, index) => [phase.id, index]));
  let any = false;
  const out = named.map((phase, self) => {
    const indexes: number[] = [];
    for (const id of phase.alongside ?? []) {
      const index = indexOf.get(id);
      if (index === undefined || index === self || indexes.includes(index)) continue;
      indexes.push(index);
    }
    any = any || indexes.length > 0;
    return indexes;
  });
  return any ? out : undefined;
}

/** 有名阶段（声明序，截到上界），`name` 已收窄。 */
type CreateWorkflowNamedPhase = CreateWorkflowPhase & { name: string };

/**
 * 上面两个函数共用的那张表：因果图里**有名**的阶段，声明序，截到
 * `CREATE_WORKFLOW_GRAPH_MAX_PHASES`。抽成一个函数正是为了让它们走同一条过滤、落在同一个
 * 下标空间里——`phaseAlongside[i]` 说的必须是 `phaseNames[i]` 这一站。
 */
function namedPhases(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): CreateWorkflowNamedPhase[] | undefined {
  if (graph?.phases === undefined) return undefined;
  const named: CreateWorkflowNamedPhase[] = [];
  for (const phase of graph.phases) {
    const name = phase.name;
    if (name === undefined) continue;
    named.push({ ...phase, name });
    if (named.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
  }
  return named.length === 0 ? undefined : named;
}

// 两个新字段只在「确认后真启动了一个 run」时出现；诊断-only 的结果保持原形状。
// 走显式 schema 而不是经 raw 夹带：.strict() 的意义就是形状变更必须是一次显式提交。
export const CreateWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    /** 仅在启动了后台 run 时出现；不是通用状态字段，故只收这一个字面量。 */
    status: z.literal("backgrounded").optional(),
    /** 后台任务 id ≡ taskId ≡ runId（取消与状态查询都以它为键）。 */
    backgroundTaskId: z.string().min(1).optional(),
    /**
     * `AmendWorkflow` 只改并发、就地生效时才在场（docs/dynamic-workflow/launch.md「Changing only
     * the parallelism of a live run」）：**没有**新 run，所以既没有 `status: "backgrounded"` 也没有
     * `backgroundTaskId`，run 还是调用里那一个。
     *
     * 是一个显式的块而不是让消费方按形状去猜：「ok 且没有 status」在这个工具上还有别的来路
     * （没有 run 端口时的「只 typecheck」）。数都是绝对值，`maxConcurrency === defaultConcurrency` 即
     * 「这个 run 没有自己的界」。
     *
     * ⚠ 这条事实**不跨 v4**：协议的 `toolOutputSchema` 只带 `text` / `display` / `truncated`，
     * 所以它服务的是 CLI/TUI、进程内消费方与契约测试，桌面 UI 读不到它。
     */
    retuned: z
      .object({
        runId: z.string().min(1),
        maxConcurrency: z.number().int().positive(),
        previous: z.number().int().positive(),
        defaultConcurrency: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /**
     * `FillWorkflowHole` 补的是哪处留白（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：
     * 站点 id 与**名字**，外加草稿路径与行号。成功与被拒都在场，且**跨 v4**——display 投影原样带上它，
     * 工具行靠它给自己起名。不能从行的入参读：transcript 存的是模型自己的入参，resolveInput 回填的
     * `hole` 块只给权限规则与 handler 看，到不了行（2026-09-28 首次接龙实测：行标题成了留白的站点 id）。
     */
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateWorkflowOutput = z.infer<typeof CreateWorkflowOutputSchema>;

export const CreateWorkflowOutputJsonSchema = toToolJsonSchema(CreateWorkflowOutputSchema);
