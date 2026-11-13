/* eslint-disable max-lines -- Coding Plan 登录、订阅与 Start/Coding 互斥校验需要集中维护，拆散会让系统禁用原因更难追踪。 */
import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  resolveBigModelApiOrigin,
  ZAI_PROVIDER_ID,
  type ApiClient,
  type ProviderFamilyDomain,
  type ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import type {
  OAuthAccountMaterial,
  OAuthStartPlanMaterial,
} from "#src/oauth/repo/oauthCredentialRepo.js";
import { type BigModelTeamPlanBizContext } from "#src/bigmodel/teamPlanApiKey.js";
import {
  fetchPersonalCodingPlanEntitlement,
  fetchTeamCodingPlanEntitlement,
} from "#src/bigmodel/codingPlanEntitlement.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import { resolveBigModelStartPlanZcodeJwt } from "./bigmodelStartPlanZcodeJwt.js";
import {
  buildZaiStartPlanBalanceUrl,
  fetchZaiStartPlanBalanceEnvelope,
  resolveZaiStartPlanBalanceModelIds,
  type ZaiStartPlanBalanceEnvelope,
} from "./zaiStartPlanBilling.js";
import {
  createBigModelLoginAuthHeaders,
  createZaiLoginAuthHeaders,
} from "../coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";

const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("coding-plan-availability");
const BIGMODEL_SUBSCRIPTION_LIST_PATH = "/api/biz/subscription/list";

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export type CodingPlanUnavailableReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled";

function buildZaiSubscriptionListUrl(): string {
  // ZAI 测试环境业务 token 只能请求配置的 ZAI Business origin。
  // availability 校验必须和 OAuth business login 共用同一套 ZCODE_ENV 域名分流，只允许 origin 不同。
  return buildRuntimeZaiBusinessUrl(process.env, "/api/biz/subscription/list");
}

interface CodingPlanAvailabilityCredentialService {
  load(key: string): Promise<string | null>;
}

interface CodingPlanAvailabilityContext {
  apiClient?: ApiClient;
  accountMaterial?: OAuthAccountMaterial | null;
  /** Start 只用共享 ZCode JWT；与付费套餐材料分开，无关联的国内账号也能解析。 */
  startPlanMaterial?: OAuthStartPlanMaterial | null;
  credentialService?: CodingPlanAvailabilityCredentialService;
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}

interface BigModelCustomerInfoEnvelope {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: BigModelCustomerInfo | null;
}

interface BigModelCustomerInfo {
  organizations?: Array<{
    organizationId?: string | null;
    projects?: Array<{
      projectId?: string | null;
      projectType?: number | string | null;
    }> | null;
  }> | null;
}

interface ZaiStartPlanPlan {
  plan_id?: string | null;
  name?: string | null;
  status?: string | null;
  starts_at?: number | string | null;
  ends_at?: number | string | null;
  entitlements?: Array<{
    period?: string | null;
  }>;
}

export type CodingPlanAvailabilityResult =
  | { kind: "available"; models?: readonly string[] }
  | { kind: "pending"; effectiveAt: number; models: readonly string[] }
  | { kind: "unavailable"; reason: CodingPlanUnavailableReason }
  | { kind: "unknown" };

export interface CodingPlanAvailabilityProvider {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly planKind: "start-plan" | "individual-coding-plan" | "team-coding-plan";
  readonly apiKey?: string | null;
}

export async function validateCodingPlanProviderAvailability(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
): Promise<CodingPlanAvailabilityResult> {
  if (!context.apiClient) {
    return { kind: "unknown" };
  }

  if (provider.planKind === "start-plan") {
    return validateStartPlanAvailability(provider, context);
  }

  if (provider.planKind !== "individual-coding-plan") {
    return { kind: "unknown" };
  }

  if (provider.family === "zai") {
    return validateSubscriptionListAvailability(provider, context, buildZaiSubscriptionListUrl());
  }

  return validateSubscriptionListAvailability(
    provider,
    context,
    buildBigModelApiUrl(process.env, BIGMODEL_SUBSCRIPTION_LIST_PATH),
  );
}

export async function validateZaiAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  const startProvider = findAvailabilityProvider(providers, "zai", "start-plan");
  const individualProvider = findAvailabilityProvider(providers, "zai", "individual-coding-plan");
  const teamProvider = findAvailabilityProvider(providers, "zai", "team-coding-plan");
  return validateFamilyAccountProviders({
    family: "zai",
    context,
    startProvider,
    individualProvider,
    teamProvider,
  });
}

export async function validateBigModelAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  const startProvider = findAvailabilityProvider(providers, "bigmodel", "start-plan");
  const individualProvider = findAvailabilityProvider(
    providers,
    "bigmodel",
    "individual-coding-plan",
  );
  const teamProvider = findAvailabilityProvider(providers, "bigmodel", "team-coding-plan");
  return validateFamilyAccountProviders({
    family: "bigmodel",
    context,
    startProvider,
    individualProvider,
    teamProvider,
  });
}

function findAvailabilityProvider(
  providers: readonly CodingPlanAvailabilityProvider[],
  family: ProviderFamilyDomain,
  planKind: CodingPlanAvailabilityProvider["planKind"],
): CodingPlanAvailabilityProvider | undefined {
  return providers.find((provider) => provider.family === family && provider.planKind === planKind);
}

async function validateFamilyAccountProviders(params: {
  family: ProviderFamilyDomain;
  context: CodingPlanAvailabilityContext;
  startProvider?: CodingPlanAvailabilityProvider;
  individualProvider?: CodingPlanAvailabilityProvider;
  teamProvider?: CodingPlanAvailabilityProvider;
}): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  const unavailable = {
    kind: "unavailable" as const,
    reason: "coding_plan_not_connected" as const,
  };
  const result: Record<string, CodingPlanAvailabilityResult> = {};
  for (const provider of [params.startProvider, params.individualProvider, params.teamProvider]) {
    if (provider) result[provider.providerId] = unavailable;
  }

  const selection = params.context.providerFamilyConnectionSelections?.[params.family];
  // Start Plan 是独立权益：即使当前连接仍是个人/Team Coding Plan，也必须单独查询，
  // 否则领取后待生效或已拥有的 Start Plan 会被错误地当成“未连接”，设置页无法展示。
  if (params.startProvider) {
    result[params.startProvider.providerId] = await validateStartPlanAvailability(
      params.startProvider,
      params.context,
    );
  }
  // 个人订阅和 Start 独立查询，不以当前选中状态代替权益。Team 必须有具体项目身份。
  if (params.individualProvider) {
    result[params.individualProvider.providerId] = await validateCodingPlanProviderAvailability(
      params.individualProvider,
      params.context,
    );
  }
  if (selection?.kind === "team-coding-plan" && params.teamProvider) {
    result[params.teamProvider.providerId] = await validateSelectedTeamPlanAvailability(
      params.family,
      params.context,
    );
  } else if (params.teamProvider) {
    result[params.teamProvider.providerId] = { kind: "unknown" };
  }
  return result;
}

// zai/bigmodel Team Plan 对称化。原硬编码 bigmodel host/token/header，
// zai team plan 永远不校验 customerInfo（被移出团队也不禁用）。
// 泛化为 family-aware：按 family 选 host（zai 用配置的 ZAI Business origin）、token（oauth:zai:）、header（Bearer）。
// 已验证 zai 域名 getCustomerInfo 返回结构与 bigmodel 同构（organizations/projects）。
async function validateSelectedTeamPlanAvailability(
  family: ProviderFamilyDomain,
  context: CodingPlanAvailabilityContext,
): Promise<CodingPlanAvailabilityResult> {
  if (!context.apiClient) {
    return { kind: "unknown" };
  }
  const selectedTeamContext = resolveSelectedTeamContext(
    family,
    context.providerFamilyConnectionSelections,
  );
  if (!selectedTeamContext) {
    return { kind: "unknown" };
  }
  const { projectId } = selectedTeamContext;
  const oauthProvider = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
  const token =
    context.accountMaterial !== undefined
      ? context.accountMaterial?.accessToken
      : (await context.credentialService?.load(`oauth:${oauthProvider}:access_token`))?.trim();
  if (!token) {
    return { kind: "unavailable", reason: "coding_plan_not_connected" };
  }
  const zcodeJwtToken =
    context.accountMaterial !== undefined
      ? context.accountMaterial?.zcodeJwtToken
      : (await context.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim();
  // BigModel 旧版本可能把 zcodejwttoken 误写进 oauth access token；
  // 但 Z.ai 的 business JWT 本身就是合法 Bearer token，不能套用这个 stale-token 防御。
  if (family === "bigmodel" && zcodeJwtToken && token === zcodeJwtToken) {
    return { kind: "unavailable", reason: "coding_plan_not_connected" };
  }

  try {
    // zai 走 buildRuntimeZaiBusinessUrl（测试环境配置的 ZAI Business origin），
    // bigmodel 走 resolveBigModelApiOrigin。路径 /api/biz/customer/getCustomerInfo 两边同构。
    const host =
      family === "zai"
        ? buildRuntimeZaiBusinessUrl(process.env, "")
        : resolveBigModelApiOrigin(process.env);
    const authHeaders =
      family === "zai" ? createZaiLoginAuthHeaders(token) : createBigModelLoginAuthHeaders(token);
    const payload = await readApiJson<BigModelCustomerInfoEnvelope>(
      context.apiClient!,
      `${host}/api/biz/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: authHeaders,
      },
    );
    if (!isSuccessfulBusinessEnvelope(payload)) return { kind: "unknown" };
    if (!Array.isArray(payload.data?.organizations)) return { kind: "unknown" };
    const resolvedTeamContext = resolveBigModelTeamProjectContext(
      payload.data,
      selectedTeamContext,
    );
    log.info(undefined, "Team Plan 入口项目校验完成", {
      family,
      projectId,
      organizationId: selectedTeamContext.organizationId,
      hasSelectedTeamProject: Boolean(resolvedTeamContext),
      organizationCount: payload.data?.organizations?.length ?? 0,
    });
    if (!resolvedTeamContext) {
      return { kind: "unavailable", reason: "coding_plan_not_entitled" };
    }
    return validateTeamPlanSubscriptionAvailability({
      apiClient: context.apiClient,
      authorization: token,
      family,
      host,
      teamContext: resolvedTeamContext,
    });
  } catch (error) {
    log.warn(undefined, "Team Plan 入口项目校验失败", {
      family,
      error: error instanceof Error ? error.message : String(error),
      projectId,
      status: error instanceof ApiError ? error.status : null,
    });
    return classifyAvailabilityError(error);
  }
}

async function validateTeamPlanSubscriptionAvailability(params: {
  apiClient: ApiClient;
  authorization: string;
  family: ProviderFamilyDomain;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
}): Promise<CodingPlanAvailabilityResult> {
  try {
    const result = await fetchTeamCodingPlanEntitlement({
      ...params,
      authorization:
        params.family === "zai" ? `Bearer ${params.authorization}` : params.authorization,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return result.kind === "unavailable"
      ? { kind: "unavailable", reason: "coding_plan_not_entitled" }
      : { kind: result.kind };
  } catch (error) {
    return classifyAvailabilityError(error);
  }
}

// zai/bigmodel Team Plan 对称化。原仅解析 bigmodel selectedKey，
// zai team key 永远返回 null（availability 不校验 zai team project）。
// 泛化为 family-aware，按 family 读对应 selectedKey bucket + family-aware parse。
function resolveSelectedTeamContext(
  family: ProviderFamilyDomain,
  selections: ProviderFamilyConnectionSelectionSettings | null | undefined,
): {
  organizationId: string | null;
  projectId: string;
} | null {
  const selection = selections?.[family];
  if (selection?.kind !== "team-coding-plan") return null;
  return {
    organizationId: selection.organizationId,
    projectId: selection.projectId,
  };
}

function resolveBigModelTeamProjectContext(
  customerInfo: BigModelCustomerInfo | null | undefined,
  selectedContext: {
    organizationId: string | null;
    projectId: string;
  },
): BigModelTeamPlanBizContext | null {
  for (const organization of customerInfo?.organizations ?? []) {
    const organizationId = organization.organizationId?.trim() ?? "";
    if (selectedContext.organizationId && organizationId !== selectedContext.organizationId) {
      continue;
    }
    for (const project of organization.projects ?? []) {
      if (
        project.projectId?.trim() === selectedContext.projectId &&
        String(project.projectType ?? "").trim() === "2" &&
        organizationId
      ) {
        return {
          organizationId,
          projectId: selectedContext.projectId,
        };
      }
    }
  }
  return null;
}

async function validateSubscriptionListAvailability(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
  url: string,
): Promise<CodingPlanAvailabilityResult> {
  // 账号凭据已是三段 PAT；旧手工 Key 归一化会按 id.secret 截掉签名。
  const authorization = (provider.apiKey ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  // 请求期 Token 尚未准备好只能表示权益未知；不能用凭据缺失证明未订阅。
  if (!authorization) return { kind: "unknown" };
  try {
    const result = await fetchPersonalCodingPlanEntitlement({
      apiClient: context.apiClient!,
      authorization,
      url,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return result.kind === "unavailable"
      ? { kind: "unavailable", reason: "coding_plan_not_entitled" }
      : { kind: result.kind };
  } catch (error) {
    return classifyAvailabilityError(error);
  }
}

interface StartPlanAuthorization {
  value: string;
  missingReason: CodingPlanUnavailableReason;
}

async function validateStartPlanAvailability(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
): Promise<CodingPlanAvailabilityResult> {
  const authorization = await resolveStartPlanAuthorization(provider, context);
  if (!authorization.value) {
    return {
      kind: "unavailable",
      reason: authorization.missingReason,
    };
  }

  try {
    const startedAt = Date.now();
    // billing/current 已废弃，balance 的 data.plans 是 Start Plan 可用性权威来源。
    // availability 只请求一次 balance，避免冷启动在入口校验阶段重复打旧 current 接口。
    const payload = await fetchZaiStartPlanBalanceEnvelope(context.apiClient!, authorization.value);
    const activeStartPlan = hasActiveStartPlan(payload.data?.plans);
    log.info(undefined, "billing/balance 请求完成", {
      durationMs: Date.now() - startedAt,
      hasActiveStartPlan: activeStartPlan,
      msg: payload.msg ?? null,
      payload,
      planCount: payload.data?.plans?.length ?? 0,
      plans: summarizeStartPlans(payload.data?.plans),
      providerId: provider.providerId,
      success: isSuccessfulBusinessEnvelope(payload),
      url: buildZaiStartPlanBalanceUrl(),
      code: payload.code ?? null,
    });
    return resolveStartPlanBalanceAvailability(payload);
  } catch (error) {
    log.warn(undefined, "billing/balance 请求失败", {
      error: error instanceof Error ? error.message : String(error),
      providerId: provider.providerId,
      responseHeaders: error instanceof ApiError ? (error.responseHeaders ?? null) : null,
      status: error instanceof ApiError ? error.status : null,
      url: buildZaiStartPlanBalanceUrl(),
    });
    return classifyAvailabilityError(error);
  }
}

async function resolveStartPlanAuthorization(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
): Promise<StartPlanAuthorization> {
  if (context.startPlanMaterial !== undefined) {
    const jwt = context.startPlanMaterial?.zcodeJwtToken;
    return { value: jwt ? `Bearer ${jwt}` : "", missingReason: "coding_plan_not_authenticated" };
  }
  if (provider.family === "bigmodel") {
    const zcodeJwtToken = await resolveBigModelStartPlanZcodeJwt({
      credentialService: context.credentialService,
      provider,
    });
    return {
      value: zcodeJwtToken ? `Bearer ${zcodeJwtToken}` : "",
      missingReason: "coding_plan_not_authenticated",
    };
  }

  const credentialJwt = await loadZaiProviderConnectionZcodeJwtToken(context);
  const providerJwt = (provider.apiKey ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  return {
    value: credentialJwt || providerJwt ? `Bearer ${credentialJwt || providerJwt}` : "",
    missingReason: "coding_plan_not_authenticated",
  };
}

function resolveStartPlanBalanceAvailability(
  payload: ZaiStartPlanBalanceEnvelope,
): CodingPlanAvailabilityResult {
  if (!isSuccessfulBusinessEnvelope(payload)) {
    return { kind: "unavailable", reason: "coding_plan_auth_failed" };
  }
  if (!hasActiveStartPlan(payload.data?.plans)) {
    return { kind: "unavailable", reason: "coding_plan_not_entitled" };
  }
  const models = resolveZaiStartPlanBalanceModelIds(payload);
  const serverTime = payload.data?.server_time;
  const nowSeconds =
    typeof serverTime === "number" && Number.isFinite(serverTime) && serverTime >= 0
      ? serverTime
      : Date.now() / 1000;
  const effectiveTimes = (payload.data?.plans ?? [])
    .filter((plan) => plan.status?.toLowerCase() === "active")
    .flatMap((plan) =>
      plan.entitlements?.length
        ? plan.entitlements.map((entry) => entry.effective_at)
        : [plan.starts_at],
    )
    .map((value) =>
      value === null || value === undefined || value === "" ? undefined : Number(value),
    );
  // 只有明确所有权益都在未来才标 pending；缺失时间不伪造日期，模型仍由余额白名单决定。
  if (
    models.length === 0 &&
    effectiveTimes.length > 0 &&
    effectiveTimes.every(
      (value) => value !== undefined && Number.isFinite(value) && value > nowSeconds,
    )
  ) {
    return {
      kind: "pending",
      effectiveAt: Math.min(...(effectiveTimes as number[])),
      models: [],
    };
  }
  return models.length > 0
    ? { kind: "available", models: Object.freeze(models) }
    : { kind: "available" };
}

async function loadZaiProviderConnectionZcodeJwtToken(
  context: CodingPlanAvailabilityContext,
): Promise<string> {
  return (await context.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() || "";
}

function classifyAvailabilityError(error: unknown): CodingPlanAvailabilityResult {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return { kind: "unavailable", reason: "coding_plan_auth_failed" };
  }
  return { kind: "unknown" };
}

function isSuccessfulBusinessEnvelope(payload: { code?: number; success?: boolean }): boolean {
  return (
    payload.success !== false &&
    (payload.code === undefined || payload.code === 0 || payload.code === 200)
  );
}

function hasActiveStartPlan(plans: ZaiStartPlanPlan[] | undefined): boolean {
  return Boolean(
    plans?.some((plan) => {
      const status = plan.status?.trim().toLowerCase();
      const planId = plan.plan_id?.trim().toLowerCase();
      const name = plan.name?.trim().toLowerCase();
      // billing/balance 的 plans 真实返回的是 `plan_id=zcode-v3-start-plan`
      // 和 `name=ZCode V3 Start Plan`；只认 `name === "start plan"` 的话，
      // 已激活的 Start Plan 会被误写成 coding_plan_not_entitled。
      const identityMatches =
        !planId && !name ? true : isZaiStartPlanIdentity(planId) || isZaiStartPlanIdentity(name);
      return status === "active" && identityMatches;
    }),
  );
}

function isZaiStartPlanIdentity(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.includes("start-plan") || value.includes("start plan");
}

function summarizeStartPlans(
  plans: ZaiStartPlanPlan[] | undefined,
): Array<Pick<ZaiStartPlanPlan, "name" | "plan_id" | "status">> {
  return (plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    plan_id: plan.plan_id ?? null,
    status: plan.status ?? null,
  }));
}
