import { z } from "zod";
import { PersistedToolSearchContentSchema } from "./tool-search.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "@zcode/shared";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_WIDGET_META_MAX_BYTES,
} from "@zcode/shared/mcp-apps";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CreateWorkflowCausalityGraphSchema,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
} from "./workflow-observation-display.js";

export const COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION = 1;
export const TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS = 64;
export const TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS = 2_000;
export const MCP_TOOL_DISPLAY_MAX_NAME_CHARS = 256;
export const MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS = 4 * 1024;
export const CUA_TARGET_APP_DISPLAY_META_KEY = "zcode.cua/target-app-display-v1" as const;

export const applicationIconLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("darwin-bundle-id"), value: z.string().trim().min(1).max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("windows-executable-path"),
      value: z.string().trim().min(1).max(32_768),
    })
    .strict(),
  z.object({ kind: z.literal("windows-aumid"), value: z.string().trim().min(1).max(512) }).strict(),
]);

export const cuaTargetAppDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(512).optional(),
    iconLocators: z.array(applicationIconLocatorSchema).max(3),
  })
  .strict();

export const cuaRequestAccessStatusDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("darwin"),
    grantOwner: z.string().trim().min(1).max(512),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();

// CreateWorkflow display 诊断的限长常量与条目 schema 已移至 create-workflow.ts
// （被 create_workflow 与 eval_workflow_snippet 两个 display payload 复用，放这里会成环）。

export const toolResultDisplayDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const fileDiffToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(toolResultDisplayDiffHunkSchema),
    truncated: z.boolean().optional(),
  })
  .strict();

export const localAgentMessageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export const taskStopToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();

export const taskOutputToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS).optional(),
    output: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

export const respondToCoordinatorToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

export const cuaToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // 旧 v1 历史记录曾重复携带 ToolCallRow.input；只为回放兼容继续接受，新 producer 不再写入。
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    targetApp: cuaTargetAppDisplaySchema.optional(),
    permissionStatus: cuaRequestAccessStatusDisplaySchema.optional(),
    media: z
      .array(
        z
          .object({
            mimeType: z.string().min(1),
            // 256 KiB 原始图片编码后的最大 base64 长度；总预算由投影器执行。
            data: z.string().min(1).max(349_528).optional(),
            artifactUri: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * node_repl cell 的目标应用身份（Computer Use）。`appKey` 是 producer 的形态：
 * `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；
 * UI 按前缀派生 `ApplicationIconLocator` 再交给平台服务解析，协议不承载图标字节。
 */
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const nodeReplImageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images 可选而不是 min(1)：CUA 的纯动作 cell（点击、输入）没有截图，但仍要投影 app 身份。
    // kind 名保留为 node_repl_images —— 改名会让已持久化的 row 在 strict union 里整段被剥掉。
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

/**
 * 插件 UI 元数据。
 * 按 `@zcode/shared/mcp-apps` 的同一常量手写一份（历史原因：contracts 曾使用 zod 3，不能复用 shared 的
 * zod 4 schema 对象；两边现在是同一个 zod 4，改为直接复用留作后续）；字段集合与 `mcpToolDisplayUiSchema`
 * 必须一致，由 core/tests/mcp-ui-display.test.ts 用同一 fixture 双侧 parse 锁住。
 */
export const mcpToolDisplayUiPayloadSchema = z
  .object({
    pluginId: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    preferredDisplayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
    prefersBorder: z.boolean().optional(),
    csp: z
      .object({
        connectDomains: z.array(z.string().min(1).max(512)).optional(),
        resourceDomains: z.array(z.string().min(1).max(512)).optional(),
      })
      .strict()
      .optional(),
    structuredContent: z.string().max(MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES).optional(),
    widgetMeta: z.string().max(MCP_APPS_WIDGET_META_MAX_BYTES).optional(),
    // 原始 content 数组 JSON（≤ 32 KiB）与被省略字节数；与 shared mcpToolDisplayUiSchema 同步。
    content: z.string().max(MCP_APPS_CONTENT_MAX_BYTES).optional(),
    truncated: z.boolean().optional(),
    truncatedBytes: z.number().int().nonnegative().optional(),
    // MCP isError 结果（调用完成但工具报错），与 shared 同步。
    isError: z.literal(true).optional(),
    // 工具级强制常驻，与 shared 同步。
    showInline: z.literal(true).optional(),
    // 与 shared mcpToolDisplayUiSchema 同步；已删 widgetStateVisibility。
    surface: z
      .string()
      .min(1)
      .max(MCP_APPS_SURFACE_ID_MAX_CHARS)
      .regex(MCP_APPS_SURFACE_ID_PATTERN)
      .optional(),
  })
  .strict();

export const mcpToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    toolName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    description: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS).optional(),
    /**
     * 官方 Server MCP 判定本次调用不可用时下发的结构化标识（额度耗尽 / 无 Coding Plan）。
     * 只在 tool result 为 isError 且该 MCP 为官方来源时出现，UI 据此在输入框上方提示。
     * 与 code 同源：`@zcode/shared` 的 OFFICIAL_MCP_TOOL_ERROR_CODES。
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // 与 `@zcode/shared` v4 toolDisplay 的 mcp_tool.ui 同步；两侧都是 strict，缺一处会被 zod 静默 strip。
    ui: mcpToolDisplayUiPayloadSchema.optional(),
  })
  .strict();

/**
 * ⚠ 这个字段集合是**冻结**的。既有 kind 上多出来的键不是「旧客户端少读一个字段」，而是整块 display
 * 校验不过：两个真实的 strict 解析点（packages/ui 的 create-workflow renderer safeParse，
 * 与 legacy v3 的按 kind 查表）会连带把整条工具结果丢掉。gate 专属的事实一律走**工具入参**
 * 通道（那一侧对所有版本都无 schema），可复用工作流的 saved 来源就是这么做的。
 */
export const createWorkflowToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    // 工具输出边界已限长（见 create-workflow.ts 的图 schema），display 直接复用同一契约。
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

// 与 shared/bash-output-display.ts 保持同一严格契约（镜像来自 contracts 使用 zod 3 的时期，改为复用留作后续）。
const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();

export const toolResultDisplayPayloadSchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  fileDiffToolResultDisplayPayloadSchema,
  localAgentMessageToolResultDisplayPayloadSchema,
  taskStopToolResultDisplayPayloadSchema,
  taskOutputToolResultDisplayPayloadSchema,
  respondToCoordinatorToolResultDisplayPayloadSchema,
  cuaToolResultDisplayPayloadSchema,
  nodeReplImageToolResultDisplayPayloadSchema,
  mcpToolResultDisplayPayloadSchema,
  createWorkflowToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
]);

export type FileDiffToolResultDisplayPayload = z.infer<
  typeof fileDiffToolResultDisplayPayloadSchema
>;
export type LocalAgentMessageToolResultDisplayPayload = z.infer<
  typeof localAgentMessageToolResultDisplayPayloadSchema
>;
export type TaskStopToolResultDisplayPayload = z.infer<
  typeof taskStopToolResultDisplayPayloadSchema
>;
export type TaskOutputToolResultDisplayPayload = z.infer<
  typeof taskOutputToolResultDisplayPayloadSchema
>;
export type RespondToCoordinatorToolResultDisplayPayload = z.infer<
  typeof respondToCoordinatorToolResultDisplayPayloadSchema
>;
export type CuaToolResultDisplayPayload = z.infer<typeof cuaToolResultDisplayPayloadSchema>;
export type ApplicationIconLocator = z.infer<typeof applicationIconLocatorSchema>;
export type CuaTargetAppDisplay = z.infer<typeof cuaTargetAppDisplaySchema>;
export type CuaRequestAccessStatusDisplay = z.infer<typeof cuaRequestAccessStatusDisplaySchema>;
export type NodeReplImageToolResultDisplayPayload = z.infer<
  typeof nodeReplImageToolResultDisplayPayloadSchema
>;
export type McpToolResultDisplayPayload = z.infer<typeof mcpToolResultDisplayPayloadSchema>;
export type CreateWorkflowToolResultDisplayPayload = z.infer<
  typeof createWorkflowToolResultDisplayPayloadSchema
>;
export type NodeReplCuaAppDisplay = z.infer<typeof nodeReplCuaAppDisplaySchema>;

export type ToolResultDisplayPayload = z.infer<typeof toolResultDisplayPayloadSchema>;

export const toolResultSerializationMetadataSchema = z
  .object({
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    budgetStrategy: z.enum(["inline", "truncate", "artifact"]),
    artifactPath: z.string().min(1).optional(),
  })
  .strict();

export type ToolResultSerializationMetadata = z.infer<typeof toolResultSerializationMetadataSchema>;

export const completedToolPartMetadataSchema = z
  .object({
    // 错误结果沿用字符串内容；仅接受数组会使 V4 冷恢复丢弃整份 metadata，包括 display。
    modelContent: z.union([z.string(), PersistedToolSearchContentSchema]).optional(),
    schemaVersion: z.literal(COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION),
    display: toolResultDisplayPayloadSchema.optional(),
    serialization: toolResultSerializationMetadataSchema.optional(),
    /** 工具正常返回、但模型收到的 tool_result 带 is_error 时为 true；冷恢复据此还原 is_error。 */
    providerIsError: z.boolean().optional(),
  })
  .passthrough();

export type CompletedToolPartMetadata = z.infer<typeof completedToolPartMetadataSchema>;

export function parseCompletedToolPartMetadata(
  input: unknown,
): CompletedToolPartMetadata | undefined {
  const scrubbed =
    isPlainRecord(input) && "display" in input
      ? { ...input, display: scrubPersistedDisplay(input.display) }
      : input;
  const result = completedToolPartMetadataSchema.safeParse(scrubbed);
  return result.success ? result.data : undefined;
}

export function parseToolResultDisplayPayload(
  input: unknown,
): ToolResultDisplayPayload | undefined {
  const result = toolResultDisplayPayloadSchema.safeParse(scrubPersistedDisplay(input));
  return result.success ? result.data : undefined;
}

/**
 * 解析前的统一清洗。
 *
 * display 是**落库**的：它写进 tool part 的 `metadata.display`，此后每次读取都要重新过
 * 一遍严格解析，而渲染端对每一帧同样有一份严格的镜像 schema。所以剥离必须发生在 CLI 侧、
 * 解析之前——上面两个入口就是唯一的卡点，v4 冷启动水合与 session-transcript 回放都经过它。
 *
 * 每个 stripper 只认自己那一个 kind，只改在场的键，别的 kind 原样进入解析。
 */
function scrubPersistedDisplay(display: unknown): unknown {
  return stripProviderStopFromGetWorkflowRunError(stripWithdrawnRefinedNames(display));
}

/**
 * 剥掉持久化 get_workflow_run 卡上的 `providerStop`。
 *
 * 早期构造侧曾把只属于模型通道的 `providerStop` 一并写进 display，而渲染端的
 * 镜像 schema 从来只认 `{code, message}`，那些帧一律被拒。构造侧已经改成只带
 * code / message，但历史持久化的 part 每次冷启动都会被重新读一遍，只能在这里剥。
 *
 * 只认 kind 为 get_workflow_run、且 error 是普通对象、且 `providerStop` 在场的载荷；不带
 * 该键的 error 与缺席的 error 原样返回，不凭空添一个 undefined。
 */
function stripProviderStopFromGetWorkflowRunError(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "get_workflow_run") return display;
  const error = display.error;
  if (!isPlainRecord(error) || !("providerStop" in error)) return display;
  const { providerStop: _dropped, ...rest } = error;
  return { ...display, error: rest };
}

/**
 * 剥掉已撤回的模型精炼字段。
 *
 * 之前持久化的 create_workflow display 里，车道与阶段可能带 `refinedName`、
 * step 可能带 `refinedLabel`。这三个字段已从 schema 删除，而两个入口都是 `.strict()`
 * 解析：不先剥掉，旧会话的整个 display（连同图）会在这里被拒掉，而不只是丢一个名字。
 *
 * 只认 create_workflow 且带 causalityGraph 的载荷；别的 kind 原样进入解析。只改在场的
 * 键，不给缺席的 `phases` 之类凭空添一个 undefined。
 */
function stripWithdrawnRefinedNames(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return display;
  const graph = display.causalityGraph;
  if (!isPlainRecord(graph)) return display;
  return {
    ...display,
    causalityGraph: {
      ...graph,
      ...("lanes" in graph ? { lanes: withoutKey(graph.lanes, "refinedName") } : {}),
      ...("steps" in graph ? { steps: withoutKey(graph.steps, "refinedLabel") } : {}),
      ...("phases" in graph ? { phases: withoutKey(graph.phases, "refinedName") } : {}),
    },
  };
}

function withoutKey(items: unknown, key: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isPlainRecord(item) || !(key in item)) return item;
    const { [key]: _dropped, ...rest } = item;
    return rest;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
