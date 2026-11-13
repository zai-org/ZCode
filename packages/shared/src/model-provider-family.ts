import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  ZAI_CN_PROVIDER_ID,
  ZAI_PROVIDER_ID,
} from "./oauth.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type BuiltinModelProviderId } from "./model-provider-types.js";
import { ZCODE_ENV } from "./env.js";
import { buildBigModelCodingPlanTeamManageUrl } from "./zcodeEndpoint.js";

export type ModelProviderFamilyId = "zai" | "bigmodel";
export type ProviderFamilyDomain = ModelProviderFamilyId;

export interface ModelProviderFamilySpec {
  id: ModelProviderFamilyId;
  label: string;
  rootDomain: string;
  oauthProviderId: typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID;
  startPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  individualCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  teamCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
  teamCodingPlanManageUrl: string;
}

export const MODEL_PROVIDER_FAMILY_SPECS = [
  {
    id: "zai",
    label: "Z.ai",
    rootDomain: "z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    teamCodingPlanManageUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: "bigmodel",
    label: "BigModel",
    rootDomain: "bigmodel.cn",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV }),
  },
] as const satisfies readonly ModelProviderFamilySpec[];

const MODEL_PROVIDER_FAMILY_SPEC_BY_ID = new Map<ModelProviderFamilyId, ModelProviderFamilySpec>(
  MODEL_PROVIDER_FAMILY_SPECS.map((spec) => [spec.id, spec]),
);

const MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID = new Map<
  BuiltinModelProviderId,
  ModelProviderFamilyId
>(
  MODEL_PROVIDER_FAMILY_SPECS.flatMap((spec) =>
    [
      spec.startPlanProviderId,
      spec.individualCodingPlanProviderId,
      spec.teamCodingPlanProviderId,
    ].map((providerId) => [providerId, spec.id] as const),
  ),
);

export function getModelProviderFamilySpec(
  familyId: ModelProviderFamilyId,
): ModelProviderFamilySpec {
  return MODEL_PROVIDER_FAMILY_SPEC_BY_ID.get(familyId)!;
}

export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  return MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID.get(providerId as BuiltinModelProviderId) ?? null;
}

export function resolveModelProviderFamilyIdByBaseURL(
  baseURL: string | null | undefined,
): ModelProviderFamilyId | null {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const spec of MODEL_PROVIDER_FAMILY_SPECS) {
    if (hostname === spec.rootDomain || hostname.endsWith(`.${spec.rootDomain}`)) {
      return spec.id;
    }
  }
  return null;
}

export function resolveModelProviderFamilySpecByProviderId(
  providerId: string,
): ModelProviderFamilySpec | null {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? getModelProviderFamilySpec(familyId) : null;
}

export function resolveModelProviderFamilyLabelByProviderId(providerId: string): string | null {
  return resolveModelProviderFamilySpecByProviderId(providerId)?.label ?? null;
}

export function normalizeProviderFamilyDomain(
  value: string | null | undefined,
): ProviderFamilyDomain | null {
  return value === "zai" || value === "bigmodel" ? value : null;
}

export function resolveProviderFamilyDomainFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  if (provider === ZAI_PROVIDER_ID) {
    return "zai";
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return "bigmodel";
  }
  return null;
}

/**
 * 当前登录渠道对应的 Start Plan 家族；Host 与设置页共用这一份映射。
 *
 * Bug 原因：`zai_cn` 不是套餐家族，上面的映射返回 null。国内新账号没有 BigModel 关联时，
 * Start 找不到所属家族，被判为未连接并要求登录，设置页还同时显示两个 Start 入口。
 * Start 是 ZCode 用户级权益，只需要 ZCode JWT；国内登录的 Start 固定属于 BigModel，
 * 与 v3.17.2 国内入口（BigModel 直登）一致。付费套餐仍使用上面的家族映射与关联材料。
 */
export function resolveStartPlanFamilyFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  return provider === ZAI_CN_PROVIDER_ID
    ? "bigmodel"
    : resolveProviderFamilyDomainFromOAuthProvider(provider);
}

export function shouldShowModelProviderFamilyForDomain(params: {
  familyId: ModelProviderFamilyId;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(params.providerFamilyDomain);
  if (!providerFamilyDomain) {
    return true;
  }
  return params.familyId === providerFamilyDomain;
}

export function shouldShowModelProviderFamilyForActiveOAuth(params: {
  familyId: ModelProviderFamilyId;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowModelProviderFamilyForDomain({
    familyId: params.familyId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}

export function shouldShowBuiltinModelProviderForDomain(params: {
  providerId: string;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const familyId = resolveModelProviderFamilyIdByProviderId(params.providerId);
  if (!familyId) {
    return true;
  }
  return shouldShowModelProviderFamilyForDomain({
    familyId,
    providerFamilyDomain: params.providerFamilyDomain,
  });
}

export function shouldShowBuiltinModelProviderForActiveOAuth(params: {
  providerId: string;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowBuiltinModelProviderForDomain({
    providerId: params.providerId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}
