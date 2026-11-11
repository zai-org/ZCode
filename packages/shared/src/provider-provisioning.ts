import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  "account-settings",
  "credential",
  // 数据同步页「模型提供商」分类在最近一次失败后由用户触发的重试；只有 Main 协调器发出。
  "user-retry",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Provisioning 中允许跨 Environment 传输的凭据类别。 */
export const providerProvisioningCredentialScopeSchema = z.enum([
  "oauth-session",
  "account-provider",
]);

export type ProviderProvisioningCredentialScope = z.infer<
  typeof providerProvisioningCredentialScopeSchema
>;

/** 仅供校验 schema v1 旧信封；新 Source 不导出、新 Target 不应用这些历史 Key。 */
export function isProviderProvisioningAccountCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^account-provider:.+:api-key$/.test(normalized);
}

/** Personal Config 的 Envelope；具体字段由 @zcode/provider 在目标 Environment 再校验。 */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningAccountSettingsSchema = z
  .object({
    providerFamilyDomain: z.enum(["zai", "bigmodel"]).nullable(),
    providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema,
  })
  .strict();

export type ProviderProvisioningAccountSettings = z.infer<
  typeof providerProvisioningAccountSettingsSchema
>;

export const providerProvisioningCredentialEntrySchema = z
  .object({
    scope: providerProvisioningCredentialScopeSchema,
    key: nonEmptyString,
    value: z.string(),
  })
  .strict();

export type ProviderProvisioningCredentialEntry = z.infer<
  typeof providerProvisioningCredentialEntrySchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    // v3 整组携带国内/关联会话；旧 Target 必须在任何写入前拒绝未知版本。
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
    accountSettings: providerProvisioningAccountSettingsSchema,
    credentials: z.array(providerProvisioningCredentialEntrySchema).max(256),
  })
  .strict()
  .refine(
    (value) =>
      value.schemaVersion === 1 ||
      value.credentials.every((entry) => entry.scope === "oauth-session"),
    { message: "Provisioning v2/v3 only accepts OAuth credentials", path: ["credentials"] },
  );

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

/** 跨进程只透传固定阶段码，不能把远端自由文本作为可公开诊断信息。 */
export const providerProvisioningErrorCodeSchema = z.enum([
  "source-read-failed",
  "target-call-failed",
  "target-write-failed",
  "target-refresh-failed",
  "target-commit-failed",
  "target-apply-failed",
  "capability-unavailable",
  "session-unavailable",
  "host-execution-failed",
]);
export type ProviderProvisioningErrorCode = z.infer<typeof providerProvisioningErrorCodeSchema>;

/** Host 保存本地 Source 后通知 Main 的触发源；首次上线与用户重试只由 Main 协调器自己产生。 */
export type ProviderProvisioningSourceTrigger = Exclude<
  ProviderProvisioningTrigger,
  "environment-online" | "user-retry"
>;

/**
 * Main 协调器按 lane（Environment key）在内存中保留的最近一次执行结果，按 sourceServerId 查询。
 * 只在本机 Main → Host → Renderer 之间流转，不持久化，不进入远程 workspace RPC 合同与手机白名单。
 * - `none`：该设备没有已注册的 lane（本机没有打开该设备上的项目），不下发也不能重试。
 * - `present`：有 lane；`running` 为当前是否有 drain 在执行；`lastResult` 只含时间、结果与固定阶段码，不含 Secret。
 */
export const providerProvisioningLaneStatusSchema = z.discriminatedUnion("lane", [
  z.object({ lane: z.literal("none") }).strict(),
  z
    .object({
      lane: z.literal("present"),
      running: z.boolean(),
      lastResult: z
        .object({
          at: z.number().int().nonnegative(),
          outcome: z.enum(["success", "failed"]),
          errorCode: providerProvisioningErrorCodeSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type ProviderProvisioningLaneStatus = z.infer<typeof providerProvisioningLaneStatusSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;
