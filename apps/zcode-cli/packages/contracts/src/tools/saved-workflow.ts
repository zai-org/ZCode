// ============================================================
// Saved workflows - 保存的 dwf 定义的共享词汇表
// ============================================================
//
// 本模块**只**声明「一个保存的 workflow 是什么」：名字的合法形状、文件落点、参数声明与
// 元数据。三个工具（SaveWorkflow 写、ListSavedWorkflows 读、CreateWorkflow 以 `saved`
// 源运行）都以它为契约，core 侧的 store 也从这里取 schema——元数据形状一旦在写侧与读侧
// 各自演化，症状是「刚保存的 workflow 列不出来」，而那是最难被单侧测试抓住的一类分叉。

import { z } from "zod";

/**
 * 保存文件的扩展名。`.dwf.ts` 而不是 `.ts`：编辑器按 TypeScript 高亮（frontmatter 是块注释，
 * 语法上合法），而 `.dwf` 这一段让扫描不必打开文件就能把它与项目源码区分开。
 */
export const SAVED_WORKFLOW_FILE_EXTENSION = ".dwf.ts";

/** 项目作用域的存放目录（相对会话工作目录）。 */
export const SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows";

/**
 * 草稿目录（相对会话工作目录）。模型在两次提交之间就地编辑的脚本文件落在这里，是
 * `.zcode/workflows/`（用户保存的定义）的兄弟目录，机器自有、自带 `.gitignore: *`。
 */
export const WORKFLOW_DRAFTS_DIR = ".zcode/workflow-drafts";

/**
 * 全局作用域的存放目录（相对 agent 进程的家目录）。落点 `~/.zcode/workflows/<name>.dwf.ts`
 * ——与 legacy Workflow 工具的用户根同一处，对所有项目可见。
 */
export const SAVED_WORKFLOW_GLOBAL_DIR = ".zcode/workflows";

/**
 * 名字的合法形状。与旧 `Workflow` 工具的解析器同一条模式（script-workflow-tool-port.ts）——
 * 名字要同时当文件名用，所以斜杠、`..`、空白一概不允许：这条正则**就是**路径穿越的防线，
 * 不是风格偏好。
 */
export const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** 名字长度上限。文件名要在各平台都成立，64 远在任何 PATH_MAX 之内且足够描述性。 */
export const SAVED_WORKFLOW_MAX_NAME_CHARS = 64;

/**
 * 作用域。两档：`project` 落在项目的 `.zcode/workflows/`，只在那个项目里可见；`global`
 * 落在 `~/.zcode/workflows/`（agent 进程的家目录），对所有项目可见。一个文件的作用域由它所在的目录推得，frontmatter 不存。
 */
export const SAVED_WORKFLOW_SCOPES = ["project", "global"] as const;

export const SavedWorkflowScopeSchema = z.enum(SAVED_WORKFLOW_SCOPES);

export type SavedWorkflowScope = z.infer<typeof SavedWorkflowScopeSchema>;

/**
 * 遮蔽事实：另一档已有同名定义。保存时算出，供确认窗展示。
 * `hides_global`：这次保存的是项目档，它会在本项目里遮蔽同名的全局档；
 * `hidden_by_project`：这次保存的是全局档，本项目已有同名的项目档会遮蔽它。
 */
export const SAVED_WORKFLOW_SHADOWING = ["hides_global", "hidden_by_project"] as const;

export const SavedWorkflowShadowingSchema = z.enum(SAVED_WORKFLOW_SHADOWING);

export type SavedWorkflowShadowing = z.infer<typeof SavedWorkflowShadowingSchema>;

/**
 * 参数的类型词汇表。三个原语加一个 `json` 兜底：原语能被校验成"传错了"，`json` 明确表示
 * "这里什么都收"，于是「没校验」与「不校验」在声明里就是两件不同的事，而不是同一个洞。
 */
export const SAVED_WORKFLOW_ARG_TYPES = ["string", "number", "boolean", "json"] as const;

export const SavedWorkflowArgTypeSchema = z.enum(SAVED_WORKFLOW_ARG_TYPES);

export type SavedWorkflowArgType = z.infer<typeof SavedWorkflowArgTypeSchema>;

export const SavedWorkflowArgDeclarationSchema = z
  .object({
    type: SavedWorkflowArgTypeSchema.describe(
      'Value type. "json" accepts any JSON value without further checking.',
    ),
    description: z
      .string()
      .optional()
      .describe("What this argument means, for whoever calls the workflow later."),
    required: z
      .boolean()
      .optional()
      .describe("When true the workflow cannot run without this argument."),
    // `default` 刻意是 unknown 而不是按 `type` 判别的联合：默认值的类型正确性由
    // validateWorkflowArgs 在**应用默认值之后**与传入值走同一条校验，一处规则而不是两处。
    default: z.unknown().optional().describe("Value used when the caller omits this argument."),
  })
  .strict();

export type SavedWorkflowArgDeclaration = z.infer<typeof SavedWorkflowArgDeclarationSchema>;

export const SavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  SavedWorkflowArgDeclarationSchema,
);

export type SavedWorkflowArgsDeclaration = z.infer<typeof SavedWorkflowArgsDeclarationSchema>;

/**
 * frontmatter 里的元数据体。`.strict()` 让「拼错一个键」成为一条可见的 invalid 行，而不是
 * 一个被静默丢弃的字段——保存的文件是用户会手改的，错字必须能被指出来。
 */
export const SavedWorkflowMetaSchema = z
  .object({
    description: z.string().min(1),
    whenToUse: z.string().min(1).optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();

export type SavedWorkflowMeta = z.infer<typeof SavedWorkflowMetaSchema>;

/** 列表里的一行：元数据 + 落点，**不含脚本正文**（枚举不是读取）。 */
export const SavedWorkflowEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    whenToUse: z.string().optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
    scope: SavedWorkflowScopeSchema,
    path: z.string().min(1),
  })
  .strict();

export type SavedWorkflowEntry = z.infer<typeof SavedWorkflowEntrySchema>;

/**
 * 一个存在但读不出来的文件。列表**不因为一个坏文件而失败**：用户手改坏了一个 frontmatter
 * 时，其余 workflow 必须照常可用，而那个坏文件必须被指名道姓，否则它只是消失了。
 */
export const SavedWorkflowInvalidEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type SavedWorkflowInvalidEntry = z.infer<typeof SavedWorkflowInvalidEntrySchema>;

/** 名字是否可用作文件名（即是否可能指向一个保存的 workflow）。 */
export function isValidSavedWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_MAX_NAME_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  // `.` 与 `..` 通过了上面的字符集检查却是目录项，不是名字。
  return name.replaceAll(".", "").length > 0;
}
