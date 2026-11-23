/**
 * Trust store 文件 schema 已下沉到 `@zcode/shared/workspace-hook-trust-store-file`
 * 作为单一权威实现（services 层无法依赖 apps 下的 contracts，
 * 只好手写局部校验，导致 UI 与 runtime 对同一损坏文件结论分裂）。
 *
 * 此处 re-export 保持 contracts 既有 import 路径（adapters/bootstrap/core 等）
 * 不变。contracts 与 shared 使用同一个 zod 4，contracts 内部的 schema 可以直接组合这些 schema。
 */
export {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/shared/workspace-hook-trust-store-file";
export type {
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustStoreFile,
} from "@zcode/shared/workspace-hook-trust-store-file";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceHookPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny"),
      reason: nonEmptyStringSchema,
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("user_decides"),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow_trusted_only"),
      reason: nonEmptyStringSchema.optional(),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkspaceHookPolicy = z.infer<typeof workspaceHookPolicySchema>;
