import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  isCodingPlanModelProviderId,
  isZaiCodingPlanProviderId,
  type OAuthProviderId,
  type OAuthAccountAvailability,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

export type CodingPlanPurchaseAuthStatus =
  | "unknown"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

export function isCodingPlanPurchaseAuthPending(status: CodingPlanPurchaseAuthStatus): boolean {
  return status === "unknown" || status === "loading";
}

export function readCodingPlanPurchaseTokenState(availability: OAuthAccountAvailability | null) {
  if (!availability) return {};
  const zai = availability.families.includes("zai");
  const bigmodel = availability.families.includes("bigmodel");
  return {
    [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: zai,
    [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]: zai,
    [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: zai,
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: bigmodel,
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: bigmodel,
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: bigmodel,
  } satisfies Partial<Record<CodingPlanProviderId, boolean>>;
}

export function normalizeCodingPlanProviderId(
  providerId: string | null | undefined,
): CodingPlanProviderId | null {
  const normalized = providerId?.trim();
  return normalized && isCodingPlanModelProviderId(normalized)
    ? (normalized as CodingPlanProviderId)
    : null;
}

export function isCodingPlanProviderId(
  providerId: CodingPlanProviderId | null,
): providerId is CodingPlanProviderId {
  return Boolean(providerId);
}

export function resolveCodingPlanOAuthProviderId(
  providerId: CodingPlanProviderId,
): OAuthProviderId {
  return isZaiCodingPlanProviderId(providerId) ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
}
