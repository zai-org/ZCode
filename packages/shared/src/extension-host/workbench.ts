import { z } from "zod";
import { modelSelectionSchema } from "#src/model-selection.js";
import { workspaceRefSchema } from "#src/extension-host/slots.js";

// 屏幕上的会话（docs/plugins/extension-host.md §3.4、§7.1、§9）。唯一 owner 是 Renderer：
// Renderer 在窗格、草稿、焦点或草稿所选模型变化时报告，Window Host 只持最近一份报告。

const sessionIdSchema = z.string().min(1).max(200);

/** 扩展经 workbench 能力读到的会话：不含草稿的所选模型。 */
export const workbenchSessionSchema = z.strictObject({
  sessionId: sessionIdSchema,
  workspace: workspaceRefSchema,
  isDraft: z.boolean(),
  focused: z.boolean(),
});
export type WorkbenchSession = z.infer<typeof workbenchSessionSchema>;

/** 产品最多 4 个分屏窗格；上限只防异常报告撑大消息。 */
export const WORKBENCH_REPORT_MAX_SESSIONS = 16;

/**
 * Renderer → Window Host 的报告。草稿多带所选模型：草稿的模型只在 Renderer（发送前不下发 CLI），
 * Window Host 只用它做 context 预演查询（§9），不经 workbench 能力暴露给扩展。
 */
export const workbenchReportSessionSchema = z.strictObject({
  sessionId: sessionIdSchema,
  workspace: workspaceRefSchema,
  isDraft: z.boolean(),
  focused: z.boolean(),
  draftModel: modelSelectionSchema.optional(),
});
export type WorkbenchReportSession = z.infer<typeof workbenchReportSessionSchema>;

export const workbenchReportSchema = z.strictObject({
  sessions: z.array(workbenchReportSessionSchema).max(WORKBENCH_REPORT_MAX_SESSIONS),
});
export type WorkbenchReport = z.infer<typeof workbenchReportSchema>;

/** 报告里去掉只给 Window Host 用的字段，得到扩展可见的形状。 */
export function toWorkbenchSessions(report: WorkbenchReport): WorkbenchSession[] {
  return report.sessions.map(({ sessionId, workspace, isDraft, focused }) => ({
    sessionId,
    workspace,
    isDraft,
    focused,
  }));
}

// —— workbench.startDraft（§18.1 H2）：请 Renderer 开一个预填文字的新草稿，不自动发送 ——

/** 预填文字的上限，与 composer.mention 候选项的 insertText 相同。 */
export const WORKBENCH_DRAFT_TEXT_MAX_LENGTH = 4000;

/**
 * `text` 去掉首尾空白后不能为空（空白文字时 Root 不预填，草稿是空的）。`workspace` 省略时用当前工作区；
 * 指定时按 Root 的新建任务规则解析（继承该工作区当前任务的项目）。
 */
export const workbenchStartDraftInputSchema = z.strictObject({
  text: z
    .string()
    .max(WORKBENCH_DRAFT_TEXT_MAX_LENGTH)
    .refine((text) => text.trim().length > 0, { message: "text must not be blank" }),
  workspace: workspaceRefSchema.optional(),
});
export type WorkbenchStartDraftInput = z.infer<typeof workbenchStartDraftInputSchema>;
