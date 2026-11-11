// 项目数据彻底删除（docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」）。
// CLI 不感知项目：Host 传会话 ID 与目录，CLI 只处理自己写的数据库行与 cli/* 文件。
// 大小只统计磁盘上真实删除的文件；数据库行删除后文件不收缩，不计入。
import { z } from "zod";

const directorySchema = z
  .object({ workspacePath: z.string().min(1), workspaceIdentity: z.string().min(1).optional() })
  .strict();
const bytesSchema = z.number().int().nonnegative();

export const v4SessionDataParamsSchema = z
  .object({ sessionIds: z.array(z.string().min(1)), directories: z.array(directorySchema) })
  .strict();
export type V4SessionDataParams = z.infer<typeof v4SessionDataParamsSchema>;

const sessionBytesSchema = z.object({ sessionId: z.string().min(1), bytes: bytesSchema }).strict();
const memoryBytesSchema = z
  .object({ workspacePath: z.string().min(1), bytes: bytesSchema })
  .strict();

/** 会话大小含其附属后代会话（subagent / workflow / 侧边问答）的文件。 */
export const v4SessionDataMeasureResultSchema = z
  .object({ sessions: z.array(sessionBytesSchema), memory: z.array(memoryBytesSchema) })
  .strict();
export type V4SessionDataMeasureResult = z.infer<typeof v4SessionDataMeasureResultSchema>;

/**
 * 运行中的会话保留（running）；附件仍被本次不删除的会话引用的会话保留（referenced）；
 * 文件删除失败的会话不删行，记入 failed，重试仍可找到。
 */
export const v4SessionDataPurgeResultSchema = z
  .object({
    deleted: z.array(sessionBytesSchema),
    kept: z.array(
      z
        .object({ sessionId: z.string().min(1), reason: z.enum(["running", "referenced"]) })
        .strict(),
    ),
    failed: z.array(
      z
        .object({
          sessionId: z.string().min(1).optional(),
          workspacePath: z.string().min(1).optional(),
          code: z.string().min(1),
        })
        .strict(),
    ),
    memory: z.array(memoryBytesSchema),
  })
  .strict();
export type V4SessionDataPurgeResult = z.infer<typeof v4SessionDataPurgeResultSchema>;

/** 归档永久删除：CLI 仅处理单个根及 owned tree，不接受目录级删除参数。 */
export const v4SessionDeletionParamsSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    workspace: directorySchema,
  })
  .strict();
export type V4SessionDeletionParams = z.infer<typeof v4SessionDeletionParamsSchema>;
export const v4SessionDeletionPreviewSchema = z
  .object({
    sessionId: z.string(),
    revision: z.string(),
    sessionIds: z.array(z.string()),
    forks: z.array(z.object({ sessionId: z.string(), title: z.string() }).strict()),
    retainedArtifacts: z.array(
      z
        .object({
          sessionId: z.string(),
          artifactId: z.string(),
          fileName: z.string(),
          referrers: z.array(z.object({ sessionId: z.string(), title: z.string() }).strict()),
        })
        .strict(),
    ),
    deletedFiles: z.number().int().nonnegative(),
    blockedReason: z
      .enum(["running", "in-use", "not-found", "not-archived", "unavailable", "changed"])
      .optional(),
    incomplete: z.boolean(),
    completed: z.boolean(),
  })
  .strict();
export type V4SessionDeletionPreview = z.infer<typeof v4SessionDeletionPreviewSchema>;
export const v4SessionDeletionExecuteParamsSchema = v4SessionDeletionParamsSchema
  .extend({
    revision: z.string().min(1),
    operationId: z.string().min(1),
  })
  .strict();
export type V4SessionDeletionExecuteParams = z.infer<typeof v4SessionDeletionExecuteParamsSchema>;
export const v4SessionDeletionResultSchema = z
  .object({
    sessionId: z.string(),
    status: z.enum(["deleted", "blocked", "incomplete"]),
    sessionIds: z.array(z.string()),
    retainedArtifacts: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .strict();
export type V4SessionDeletionResult = z.infer<typeof v4SessionDeletionResultSchema>;
