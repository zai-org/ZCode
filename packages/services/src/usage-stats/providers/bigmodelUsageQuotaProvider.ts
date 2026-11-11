/* eslint-disable max-lines -- quota、entitlement 与 monitor 请求共用同一套 provider 鉴权逻辑，拆文件会让 Coding Plan strict key 边界更难追踪。 */
import { z } from "zod";
import {
  isSameOAuthAccountMaterial,
  type OAuthAccountMaterial,
} from "#src/oauth/repo/oauthCredentialRepo.js";
import type {
  ApiClient,
  ApiRequestInit,
  CodingPlanRegularTpsRequest,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageMcpQuotaSnapshot,
  UsageQuotaLimit,
  UsageStatsRequest,
  UsageStatsSnapshot,
  ZCodeAccountAccess,
} from "@zcode/shared";
import {
  ApiError,
  BUILTIN_MODEL_PROVIDER_IDS,
  isCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  isZaiCodingPlanProviderId,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";
import type { ProviderFamilyDomain } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { IAccountRequestAuthService } from "../../model-provider/accountRequestAuthService.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { readEnv } from "../../oauth/providers/configUtils.js";
import {
  buildZaiStartPlanBalanceUrl,
  fetchZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanPlan,
} from "../../model-provider/zaiStartPlanBilling.js";
import type {
  BigModelUsageModelUsagePayload,
  BigModelUsageModelUsageEnvelope,
  BigModelUsageToolUsagePayload,
  BigModelUsageToolUsageEnvelope,
  BigModelCreditUsageActivityPayload,
  BigModelCreditUsageActivityEnvelope,
  BigModelCreditUsageDetailPayload,
  BigModelCreditUsageDetailEnvelope,
  BigModelUsageModelPerformancePayload,
  BigModelUsageModelPerformanceEnvelope,
} from "./bigmodelUsageMonitorMapper.js";
import {
  buildCodingPlanUsageSnapshotFromMonitor,
  buildUsageStatsSnapshotFromMonitor,
} from "./bigmodelUsageMonitorMapper.js";
import {
  resolveCodingPlanUsageTimeRange,
  resolveUsageTimeRange,
} from "./bigmodelUsageMonitorRange.js";
import { fetchBigModelSubscriptionSummary } from "./bigmodelSubscriptionProvider.js";
import {
  fetchMcpQuotaSnapshot,
  type OfficialMcpCredentialSource,
} from "./zcodeMcpQuotaProvider.js";
import type { BigModelUsageQuotaEnvelope } from "./bigmodelUsageQuotaMapper.js";
import { normalizeLimits, pickPrimaryLimit } from "./bigmodelUsageQuotaMapper.js";

const BIGMODEL_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const CODING_PLAN_RESET_BASE_PATH = "/api/v1/coding-plan/reset";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");
const EMPTY_MODEL_USAGE_PAYLOAD = {} satisfies BigModelUsageModelUsagePayload;
const EMPTY_TOOL_USAGE_PAYLOAD = {} satisfies BigModelUsageToolUsagePayload;
const EMPTY_CREDIT_ACTIVITY_PAYLOAD = {} satisfies BigModelCreditUsageActivityPayload;
const EMPTY_CREDIT_DETAIL_PAYLOAD = {} satisfies BigModelCreditUsageDetailPayload;
const EMPTY_MODEL_PERFORMANCE_PAYLOAD = {} satisfies BigModelUsageModelPerformancePayload;

const codingPlanResetEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});
const codingPlanResetOpportunitySchema = z.object({
  expire_at: z.number().finite().positive(),
});
const codingPlanResetHistorySchema = z.object({
  used_at: z.number().finite().positive(),
});
const codingPlanResetStatusDataSchema = z.object({
  available_five_hour_resets: z.array(codingPlanResetOpportunitySchema),
  available_week_resets: z.array(codingPlanResetOpportunitySchema),
  latest_five_hour_reset_history: codingPlanResetHistorySchema.nullable(),
  latest_week_reset_history: codingPlanResetHistorySchema.nullable(),
  has_unread_history: z.boolean(),
});
const codingPlanResetUseDataSchema = z.object({
  used: z.literal(true),
});
const codingPlanResetOpportunityGrantedDataSchema = z.object({
  granted: z.literal(true),
});
const codingPlanResetOpportunityDeniedDataSchema = z.object({
  granted: z.literal(false),
  next_try_at: z.number().int().positive(),
});

export interface UsageApiAuthorizationRequest {
  readonly preferredProviderId?: string;
  readonly requirePreferredProvider: boolean;
}

export interface UsageApiAuthorization {
  readonly authorization: string;
  readonly quotaUrl: string;
  readonly provider: ResolvedQuotaAuthorization["provider"];
}

interface BigModelUsageQuotaProviderOptions {
  apiClient: ApiClient;
  loadOAuthAccountMaterial(family: "zai" | "bigmodel"): Promise<OAuthAccountMaterial | null>;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  env?: NodeJS.ProcessEnv;
  /**
   * 官方 Server MCP 的凭证来源。缺省时 entitlement 快照的 mcpQuota 恒为 null，
   * 既有装配（含单测）无需改动即可保持原行为。
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

interface ResolvedQuotaAuthorization {
  authorization: string;
  quotaUrl: string;
  teamContext: TeamPlanContext | null;
  provider: {
    id: string;
    name: string;
  };
}

interface TeamPlanContext {
  organizationId: string;
  projectId: string;
  // Team Plan 用量查询在 zai/bigmodel 两个 family 上对称存在，
  // 但复制团队项目 API Key 的 host、OAuth token key、鉴权 header 都按 family 分离。
  // 这里必须带上 family，下游 resolveTeamPlanProjectApiKey 才能选对 zai/bigmodel 的业务域名和 token。
  family: ProviderFamilyDomain;
}

interface CodingPlanResetAuthorization {
  zcodeAuthorization: string;
  codingPlanAuthorization: string;
  teamContext: TeamPlanContext | null;
}

// 直接复用响应类型，避免本地副本遗漏新 bucket/周期字段。
type ZaiStartPlanBalance = NonNullable<
  NonNullable<ZaiStartPlanBalanceEnvelope["data"]>["balances"]
>[number];

export class BigModelUsageQuotaProvider {
  private readonly apiClient: ApiClient;
  private readonly loadOAuthAccountMaterial: BigModelUsageQuotaProviderOptions["loadOAuthAccountMaterial"];
  private readonly accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent"
  >;
  private readonly resolveApiAuthorization?: BigModelUsageQuotaProviderOptions["resolveApiAuthorization"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly officialMcpCredentialSource?: OfficialMcpCredentialSource;

  constructor(options: BigModelUsageQuotaProviderOptions) {
    this.apiClient = options.apiClient;
    this.loadOAuthAccountMaterial = options.loadOAuthAccountMaterial;
    this.accountRequestAuthService = options.accountRequestAuthService;
    this.resolveApiAuthorization = options.resolveApiAuthorization;
    this.env = options.env ?? process.env;
    this.officialMcpCredentialSource = options.officialMcpCredentialSource;
  }

  async getSnapshot(): Promise<UsageEntitlementSnapshot> {
    return this.getSnapshotForRequest({});
  }

  async getSnapshotForRequest(
    request: UsageEntitlementRequest = {},
  ): Promise<UsageEntitlementSnapshot> {
    // 设置页只能从 Registry 取得静态 family/mode。动态 planKind 与 Team scope
    // 必须在服务边界读取当前账号连接；不能要求 UI 从 Effective Config 伪造动态权益事实。
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    const resolvedRequest: UsageEntitlementRequest = {
      ...request,
      accountAccess,
    };
    if (request.preferredProviderId && isStartPlanModelProviderId(request.preferredProviderId)) {
      return this.getStartPlanSnapshot(
        request.preferredProviderId,
        accountAccess,
        request.invalidateBalanceCache,
      );
    }

    const generatedAt = Date.now();
    const teamContext = accountAccess ? resolveTeamPlanContext(accountAccess) : null;
    const providerId = request.preferredProviderId?.trim() ?? "";
    const account = accountAccess
      ? await this.loadOAuthAccountMaterial(accountAccess.family)
      : null;
    if (teamContext && !account) throw new Error("coding_plan_account_required");
    // 团队权益不以调用 Key 为前置条件；即使 Key 创建/复制失败也保留已确认的订阅。
    const teamEntitlement = teamContext
      ? await fetchBigModelSubscriptionSummary({
          apiClient: this.apiClient,
          authorization: "",
          quotaUrl:
            resolveQuotaUrlFromEnv(this.env) ??
            (teamContext.family === "zai"
              ? buildZaiQuotaUrl(this.env)
              : buildBigModelQuotaUrl(this.env)),
          teamContext,
          businessToken: account?.accessToken,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      : null;
    let resolved: ResolvedQuotaAuthorization | null = null;
    try {
      resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess,
        requirePreferredProvider: request.requirePreferredProvider === true,
        allowEnvApiKey: request.allowEnvApiKey,
      });
    } catch (error) {
      log.warn(undefined, "读取用量凭据失败，保留独立订阅判定", {
        error: error instanceof Error ? error.message : String(error),
        preferredProviderId: providerId,
      });
    }
    const entitlement =
      teamEntitlement ??
      (resolved
        ? await fetchBigModelSubscriptionSummary({
            apiClient: this.apiClient,
            authorization: resolved.authorization,
            quotaUrl: resolved.quotaUrl,
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        : { kind: "unknown" as const });
    // 订阅未知不能发布为成功空快照，否则 hook 会覆盖同身份已确认权益并清除失败退避。
    // 无凭据的未配置状态仍正常返回；已有查询身份时让统一失败路径保留快照。
    if (entitlement.kind === "unknown" && (resolved || teamContext)) {
      throw new Error("Coding Plan entitlement refresh failed");
    }
    const subscription =
      entitlement.kind !== "available" ? null : buildSubscriptionSnapshot(entitlement.subscription);
    const [payload, mcpQuota] = resolved
      ? await Promise.all([
          this.fetchQuota(resolved).catch(() => null),
          this.fetchMcpQuota(resolved).catch(() => null),
        ])
      : [null, null];
    // quota 失败或 level 存在都不改变权益；额度耗尽也只影响用量显示。
    const quotaData = payload && isSuccessfulBigModelEnvelope(payload) ? payload.data : null;
    const limits = normalizeLimits(quotaData?.limits);
    const primaryLimit = pickPrimaryLimit(limits);
    if (accountAccess && providerId) {
      await this.assertUnchangedRequestAccess(request.accountAccess, accountAccess);
    }
    if (
      account &&
      !isSameOAuthAccountMaterial(account, await this.loadOAuthAccountMaterial(account.family))
    )
      throw new Error("coding_plan_account_changed");
    return {
      generatedAt,
      authenticated: true,
      ...(entitlement.kind === "available"
        ? {}
        : {
            unavailableReason:
              entitlement.kind === "unavailable"
                ? ("no_plan" as const)
                : resolved || teamContext
                  ? ("unavailable" as const)
                  : ("not_configured" as const),
          }),
      ...(teamEntitlement?.kind === "unavailable" && teamEntitlement.reason
        ? { teamPlanUnavailableReason: teamEntitlement.reason }
        : {}),
      context: resolved
        ? buildUsageEntitlementContext(resolved, subscription)
        : buildUsageEntitlementContextFromRequest(resolvedRequest),
      provider: resolved?.provider ?? null,
      remaining: primaryLimit
        ? {
            count: primaryLimit.remaining ?? 0,
            isShow: true,
            percentage: primaryLimit.percentage,
            nextResetTime: primaryLimit.nextResetTime ?? null,
          }
        : null,
      subscription,
      quota: quotaData ? { level: quotaData.level?.trim() || null, limits } : null,
      mcpQuota,
    };
  }

  private async resolveRequestAccountAccess(
    accountAccess: UsageEntitlementRequest["accountAccess"],
  ): Promise<ZCodeAccountAccess | undefined> {
    if (!accountAccess) return undefined;
    if (!("mode" in accountAccess)) return accountAccess;
    return (await this.accountRequestAuthService.resolveAccessCurrent(accountAccess)) ?? undefined;
  }

  private async assertUnchangedRequestAccess(
    requested: UsageEntitlementRequest["accountAccess"],
    expected: ZCodeAccountAccess,
  ): Promise<void> {
    // 静态请求表示当前连接，须重解析原请求；具体 access 是浏览指定套餐，不能强绑当前选择。
    if (!requested || !("mode" in requested)) return;
    const current = await this.resolveRequestAccountAccess(requested);
    const scope = (access: ZCodeAccountAccess | undefined) =>
      access
        ? [
            access.family,
            access.planKind,
            access.planKind === "team-coding-plan"
              ? [access.organizationId, access.projectId, access.productId]
              : null,
          ]
        : null;
    if (JSON.stringify(scope(current)) !== JSON.stringify(scope(expected)))
      throw new Error("coding_plan_account_changed");
  }

  /**
   * 读取官方 Server MCP 额度。仅 Coding Plan provider 会发起：
   * 环境变量 key、普通 API Key provider 与 Start Plan 都没有该权益。
   */
  private async fetchMcpQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<UsageMcpQuotaSnapshot | null> {
    if (!this.officialMcpCredentialSource) {
      return null;
    }
    if (!isCodingPlanModelProviderId(resolved.provider.id)) {
      return null;
    }
    return fetchMcpQuotaSnapshot({
      apiClient: this.apiClient,
      credentialSource: this.officialMcpCredentialSource,
      env: this.env,
      requestScope: {
        providerFamily:
          resolved.teamContext?.family ??
          (isZaiCodingPlanProviderId(resolved.provider.id) ? "zai" : "bigmodel"),
        organizationId: resolved.teamContext?.organizationId ?? null,
        projectId: resolved.teamContext?.projectId ?? null,
      },
    });
  }

  private async getStartPlanSnapshot(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
    invalidateBalanceCache = false,
  ): Promise<UsageEntitlementSnapshot> {
    const generatedAt = Date.now();
    const resolved = await this.resolveStartPlanAuthorization(providerId, accountAccess);
    if (!resolved) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "not_configured",
        context: { scope: "personal" },
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    let balancePayload: ZaiStartPlanBalanceEnvelope;
    try {
      const balanceUrl = buildZaiStartPlanBalanceUrl();
      const balanceStartedAt = Date.now();
      // billing/current 已废弃，balance 会同时返回 plans 与 balances。
      // Start Plan 快照必须只发起一次 balance 请求，避免冷启动重复请求并继续依赖旧接口。
      balancePayload = await fetchZaiStartPlanBalanceEnvelope(
        this.apiClient,
        resolved.authorization,
        invalidateBalanceCache,
      );
      log.info(undefined, "billing/balance 请求完成", {
        balanceCount: balancePayload.data?.balances?.length ?? 0,
        balances: summarizeStartPlanBalances(balancePayload.data?.balances),
        code: balancePayload.code ?? null,
        durationMs: Date.now() - balanceStartedAt,
        msg: balancePayload.msg ?? null,
        payload: balancePayload,
        planCount: balancePayload.data?.plans?.length ?? 0,
        plans: summarizeStartPlans(balancePayload.data?.plans),
        providerId,
        success: balancePayload.code === 0,
        url: balanceUrl,
      });
    } catch (error) {
      log.warn(undefined, "billing/balance 请求失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
        responseHeaders: error instanceof ApiError ? (error.responseHeaders ?? null) : null,
        status: error instanceof ApiError ? error.status : null,
        url: buildZaiStartPlanBalanceUrl(),
      });
      // 保留 HTTP 429 等错误信息，让调用方退避并保留已确认的权益。
      throw error;
    }

    if (balancePayload.code !== 0) {
      throw new Error(balancePayload.msg || `Start Plan balance failed: ${balancePayload.code}`);
    }

    const currentPlan = pickCurrentZaiStartPlan(balancePayload.data?.plans);
    if (!currentPlan) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "no_plan",
        startPlanExpired:
          balancePayload.data?.plans?.some((plan) => plan.status?.toLowerCase() === "expired") ??
          false,
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    warnOnUnattributedStartPlanBuckets(
      balancePayload.data?.plans,
      readZaiStartPlanBalances(balancePayload),
    );

    return {
      generatedAt,
      authenticated: true,
      context: { scope: "personal" },
      provider: resolved.provider,
      // balance 的服务端时间与本响应的 effective_at 配对，不能用本机时钟覆盖。
      ...(typeof balancePayload.data?.server_time === "number" &&
      Number.isFinite(balancePayload.data.server_time) &&
      balancePayload.data.server_time >= 0
        ? { serverTime: balancePayload.data.server_time * 1_000 }
        : {}),
      remaining: buildZaiStartPlanRemaining(readZaiStartPlanBalances(balancePayload)),
      subscription: buildZaiStartPlanSubscription(balancePayload.data?.plans),
      quota: buildZaiStartPlanQuota(
        readZaiStartPlanBalances(balancePayload),
        balancePayload.data?.plans,
      ),
    };
  }

  private async resolveStartPlanAuthorization(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
  ): Promise<{
    authorization: string;
    provider: ResolvedQuotaAuthorization["provider"];
  } | null> {
    if (!accountAccess || accountAccess.planKind !== "start-plan") {
      return null;
    }
    let auth;
    try {
      auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
    } catch {
      return null;
    }
    const apiKey = auth.apiKey?.trim() ?? "";
    if (!apiKey) return null;

    return {
      authorization: /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`,
      provider: {
        id: providerId,
        name: resolveAccountProviderLabel(providerId),
      },
    };
  }

  async getUsageStatsSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: request.requirePreferredProvider === true,
      allowEnvApiKey: request.allowEnvApiKey,
    });
    if (!resolved) {
      // 设置页使用统计可被显式收口到 Coding Plan provider。
      // 严格指定 provider 时不允许回退到普通 API Key、环境变量或本地 session 聚合。
      throw new Error("no_bigmodel_api_key");
    }

    const { startTime, endTime } = resolveUsageTimeRange(request);
    const [modelPayload, toolPayload] = await Promise.all([
      this.fetchModelUsage(resolved, startTime, endTime),
      this.fetchToolUsage(resolved, startTime, endTime),
    ]);

    const modelData = readSuccessfulBigModelMonitorData(
      modelPayload,
      "BigModel model usage failed",
      EMPTY_MODEL_USAGE_PAYLOAD,
    );
    const toolData = readSuccessfulBigModelMonitorData(
      toolPayload,
      "BigModel tool usage failed",
      EMPTY_TOOL_USAGE_PAYLOAD,
      { allowMissingData: true },
    );

    return {
      ...buildUsageStatsSnapshotFromMonitor(request, modelData, toolData),
      sourceProvider: resolved.provider,
    };
  }

  async getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/status`),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createCodingPlanResetHeaders(authorization, true),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetStatusDataSchema);
    return {
      availableFiveHourResets: data.available_five_hour_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      availableWeekResets: data.available_week_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      latestFiveHourResetHistory: data.latest_five_hour_reset_history
        ? { usedAt: data.latest_five_hour_reset_history.used_at }
        : null,
      latestWeekResetHistory: data.latest_week_reset_history
        ? { usedAt: data.latest_week_reset_history.used_at }
        : null,
      hasUnreadHistory: data.has_unread_history,
    };
  }

  async useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/use`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          ...createCodingPlanResetHeaders(authorization, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          reset_type: request.resetType,
        }),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetUseDataSchema);
    return { used: data.used };
  }

  async requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    let payload: unknown;
    try {
      payload = await readCodingPlanResetApiJson(
        this.apiClient,
        buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/opportunity`),
        {
          method: "POST",
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers: {
            ...createCodingPlanResetHeaders(authorization, true),
            "content-type": "application/json",
          },
          body: JSON.stringify({ idempotency_key: idempotencyKey }),
        },
        { acceptedBusinessCodes: [3301] },
      );
    } catch (error) {
      // 后端在请求过快/发卡锁竞争时直接回 HTTP 429，不带 3301 信封和 next_try_at。
      // 映射成稳定错误码，客户端据此写兜底冷却，避免 30 秒轮询持续撞限流。
      if (error instanceof ApiError && error.status === 429) {
        throw new Error("coding_plan_reset_opportunity_throttled", {
          cause: error,
        });
      }
      throw error;
    }
    const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new Error("coding_plan_reset_invalid_response");
    }
    // 3301 的 next_try_at 是服务端限流边界，必须完整透传给客户端；
    // 丢弃该字段会让 30 秒轮询持续触发资格判断，绕过后端要求的重试间隔。
    if (envelope.data.code === 3301) {
      const denied = codingPlanResetOpportunityDeniedDataSchema.safeParse(envelope.data.data);
      if (!denied.success) {
        throw new Error("coding_plan_reset_invalid_response");
      }
      return { granted: false, nextTryAt: denied.data.next_try_at };
    }
    const data = readCodingPlanResetEnvelopeData(
      payload,
      codingPlanResetOpportunityGrantedDataSchema,
    );
    return { granted: data.granted, nextTryAt: null };
  }

  async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/history/read`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        // history/read 使用当前 Coding Plan credential 校验身份，但按用户共享已读游标，不带 target scope。
        headers: createCodingPlanResetHeaders(authorization, false),
      },
    );
    readCodingPlanResetEnvelope(payload);
  }

  private async resolveCodingPlanResetAuthorization(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetAuthorization> {
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (!accountAccess) {
      throw new Error("coding_plan_reset_account_access_required");
    }
    const account = await this.loadOAuthAccountMaterial(accountAccess.family);
    if (!account?.zcodeJwtToken) throw new Error("coding_plan_reset_zcode_jwt_required");
    if (!account.accessToken.trim()) throw new Error("coding_plan_reset_maas_jwt_required");
    await this.assertUnchangedRequestAccess(request.accountAccess, accountAccess);
    // 关联套餐未必与主登录渠道同名。两种 JWT 必须来自同一会话快照，防止换号时拼接。
    if (
      !isSameOAuthAccountMaterial(
        account,
        await this.loadOAuthAccountMaterial(accountAccess.family),
      )
    )
      throw new Error("coding_plan_reset_account_changed");
    const zcodeJwt = account.zcodeJwtToken;
    return {
      zcodeAuthorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
      codingPlanAuthorization: account.accessToken.trim(),
      teamContext: resolveTeamPlanContext(accountAccess),
    };
  }

  async getCodingPlanUsageSnapshot(
    request: CodingPlanUsageRequest,
  ): Promise<CodingPlanUsageSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    if (!resolved) {
      // Coding Plan 用量现在直接使用对应 Coding Plan provider 的 API Key。
      // 缺少 key 时不能回退普通 API Key、环境变量、OAuth 或本地 App Usage。
      throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));
    }

    const usageRange = resolveCodingPlanUsageTimeRange(request);
    // monitor 请求不能全有全无。quota 保持原有必须成功语义
    // （传输失败时整体失败，业务失败降级为 quota: null）；activity / detail / health
    // 是可选数据面，传输失败只清空对应区域并记 warn，任一路故障不能拖垮整张面板。
    const [quotaPayload, activityData, modelDetailData, toolDetailData, health7dData] =
      await Promise.all([
        this.fetchQuota(resolved),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageActivity(resolved, request.timeZone),
          "BigModel activity usage failed",
          EMPTY_CREDIT_ACTIVITY_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageDetail(resolved, usageRange.startTime, usageRange.endTime, "MODEL"),
          "BigModel model usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageDetail(resolved, usageRange.startTime, usageRange.endTime, "MCP"),
          "BigModel tool usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchModelPerformanceDay(resolved, request.timeZone, "7d"),
          "BigModel model performance failed",
          EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        ),
      ]);

    const quota =
      isSuccessfulBigModelEnvelope(quotaPayload) && quotaPayload.data
        ? {
            level: quotaPayload.data.level?.trim() || null,
            limits: normalizeLimits(quotaPayload.data.limits),
          }
        : null;

    return buildCodingPlanUsageSnapshotFromMonitor({
      request,
      provider: resolved.provider,
      quota,
      granularity: usageRange.granularity,
      xTime: usageRange.xTime,
      startDateKey: usageRange.startDateKey,
      endDateKey: usageRange.endDateKey,
      activityData,
      modelDetailData,
      toolDetailData,
      healthData: health7dData,
    });
  }

  async getCodingPlanRegularTps(request: CodingPlanRegularTpsRequest): Promise<number | undefined> {
    const startedAt = Date.now();
    let requestUrl: string | undefined;
    let responseHeaders: Record<string, string> = {};
    let responseStatus: number | undefined;
    let responseStatusText: string | undefined;
    let responseCode: number | undefined;
    try {
      const resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess: request.accountAccess,
        requirePreferredProvider: true,
        allowEnvApiKey: false,
      });
      if (!resolved) throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));

      const timeRange = resolveModelPerformanceTimeRange(request.timeZone, "7d");
      requestUrl = buildModelPerformanceMonitorUrl(
        resolved,
        timeRange.startTime,
        timeRange.endTime,
      );
      const response = await this.apiClient.request(requestUrl, {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      });
      responseStatus = response.status;
      responseStatusText = response.statusText;
      responseHeaders = readApiDiagnosticHeaders(response.headers) ?? {};
      let payload: BigModelUsageModelPerformanceEnvelope | undefined;
      let parseError: unknown;
      try {
        payload = JSON.parse(await response.text()) as BigModelUsageModelPerformanceEnvelope;
        responseCode = typeof payload.code === "number" ? payload.code : undefined;
      } catch (error) {
        parseError = error;
      }
      if (!response.ok) {
        throw new ApiError({
          message: readApiErrorMessage(payload, `HTTP ${response.status}`),
          url: requestUrl,
          method: "GET",
          status: response.status,
          responseHeaders,
          cause: parseError,
        });
      }
      if (parseError !== undefined || payload === undefined) {
        throw new ApiError({
          message: parseError instanceof Error ? parseError.message : "Invalid JSON response",
          url: requestUrl,
          method: "GET",
          status: response.status,
          responseHeaders,
          cause: parseError,
        });
      }
      const data = readSuccessfulBigModelMonitorData<BigModelUsageModelPerformancePayload>(
        payload,
        "BigModel model performance failed",
        EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        { allowMissingData: true },
      );
      return data.proMaxDecodeSpeed?.findLast((value) => Number.isFinite(value) && value > 0);
    } catch (error) {
      // Bug 原因：Highspeed 仅在 Renderer 记录了 TPS 读取失败文案，Host 层丢失了
      // monitor 的 HTTP status 和 request id，无法与后端日志对账。只输出 ApiError 中的安全诊断头。
      log.warn(undefined, "Highspeed 普通 TPS 健康检查失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId: request.preferredProviderId,
        durationMs: Date.now() - startedAt,
        status: error instanceof ApiError ? error.status : (responseStatus ?? null),
        statusText: responseStatusText ?? null,
        responseCode: responseCode ?? null,
        responseHeaders:
          error instanceof ApiError ? (error.responseHeaders ?? responseHeaders) : responseHeaders,
        url: sanitizeMonitorDiagnosticUrl(error instanceof ApiError ? error.url : requestUrl),
      });
      throw error;
    }
  }

  private async resolveAuthorization(
    request: {
      preferredProviderId?: string;
      accountAccess?: UsageEntitlementRequest["accountAccess"];
      requirePreferredProvider?: boolean;
      allowEnvApiKey?: boolean;
    } = {},
  ): Promise<ResolvedQuotaAuthorization | null> {
    if (request.allowEnvApiKey !== false && request.requirePreferredProvider !== true) {
      const envApiKey =
        readEnv(this.env, "ZCODE_BIGMODEL_USAGE_API_KEY") ??
        readEnv(this.env, "BIGMODEL_USAGE_API_KEY");
      if (envApiKey) {
        return {
          authorization: envApiKey,
          quotaUrl: resolveQuotaUrlFromEnv(this.env) ?? buildBigModelQuotaUrl(this.env),
          teamContext: null,
          provider: {
            id: "env:bigmodel-usage",
            name: "BigModel",
          },
        };
      }
    }

    const providerId = request.preferredProviderId?.trim() ?? "";
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (providerId && isCodingPlanModelProviderId(providerId)) {
      if (!accountAccess) return null;
      const auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
      const authorization = auth.apiKey?.trim() ?? "";
      if (!authorization) return null;
      return {
        authorization,
        quotaUrl:
          resolveQuotaUrlFromEnv(this.env) ?? resolveAccountProviderQuotaUrl(providerId, this.env),
        teamContext: resolveTeamPlanContext(accountAccess),
        provider: {
          id: providerId,
          name: resolveAccountProviderLabel(providerId),
        },
      };
    }

    const apiAuthorization = await this.resolveApiAuthorization?.({
      preferredProviderId: providerId || undefined,
      requirePreferredProvider: request.requirePreferredProvider === true,
    });
    return apiAuthorization ? { ...apiAuthorization, teamContext: null } : null;
  }

  private async fetchQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<BigModelUsageQuotaEnvelope> {
    return readApiJson<BigModelUsageQuotaEnvelope>(this.apiClient, buildQuotaLimitUrl(resolved), {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    });
  }

  private async fetchModelUsage(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
  ): Promise<BigModelUsageModelUsageEnvelope> {
    return readApiJson<BigModelUsageModelUsageEnvelope>(
      this.apiClient,
      buildUsageMonitorUrl(resolved, "model-usage", startTime, endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchToolUsage(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
  ): Promise<BigModelUsageToolUsageEnvelope> {
    return readApiJson<BigModelUsageToolUsageEnvelope>(
      this.apiClient,
      buildUsageMonitorUrl(resolved, "tool-usage", startTime, endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchCreditUsageActivity(
    resolved: ResolvedQuotaAuthorization,
    timeZone: string | undefined,
  ): Promise<BigModelCreditUsageActivityEnvelope> {
    const range = resolveCreditUsageActivityTimeRange(timeZone);
    return readApiJson<BigModelCreditUsageActivityEnvelope>(
      this.apiClient,
      buildCreditUsageMonitorUrl(resolved, "activity", range.startTime, range.endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchCreditUsageDetail(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
    usageType: "MODEL" | "MCP",
  ): Promise<BigModelCreditUsageDetailEnvelope> {
    return readApiJson<BigModelCreditUsageDetailEnvelope>(
      this.apiClient,
      buildCreditUsageMonitorUrl(resolved, "usage-detail", startTime, endTime, usageType),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

  private async fetchModelPerformanceDay(
    resolved: ResolvedQuotaAuthorization,
    timeZone: string | undefined,
    range: "7d" | "30d",
  ): Promise<BigModelUsageModelPerformanceEnvelope> {
    const timeRange = resolveModelPerformanceTimeRange(timeZone, range);
    return readApiJson<BigModelUsageModelPerformanceEnvelope>(
      this.apiClient,
      buildModelPerformanceMonitorUrl(resolved, timeRange.startTime, timeRange.endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }
}

function createCodingPlanResetHeaders(
  authorization: CodingPlanResetAuthorization,
  includeTargetScope: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authorization.zcodeAuthorization,
    "X-Bigmodel-Authorization": authorization.codingPlanAuthorization,
  };
  if (!includeTargetScope) {
    return headers;
  }
  headers["Bigmodel-Target-Type"] = authorization.teamContext ? "TEAM" : "PERSONAL";
  if (authorization.teamContext) {
    headers["Bigmodel-Organization"] = authorization.teamContext.organizationId;
    headers["Bigmodel-Project"] = authorization.teamContext.projectId;
  }
  return headers;
}

function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "msg", "detail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function readApiDiagnosticHeaders(headers: Headers): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const name of ["x-request-id", "x-trace-id", "x-span-id"] as const) {
    const value = headers.get(name)?.trim();
    if (value) {
      result[name] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// 联调对账后缀：envelope 业务错误（如 2007 依赖失败）需要把后端 x-request-id
// 带进错误 message，RPC 日志和 UI warn 才能与后端日志按请求 id 精确对上。
// 仅用于日志定位，客户端不做分支；缺失时返回空串保持原 message 契约。
function readCodingPlanResetErrorDiagnostics(headers: Headers): string {
  const requestId = headers.get("x-request-id")?.trim();
  return requestId ? ` (x-request-id:${requestId})` : "";
}

async function readCodingPlanResetApiJson(
  apiClient: ApiClient,
  input: string,
  init: ApiRequestInit,
  options: { acceptedBusinessCodes?: readonly number[] } = {},
): Promise<unknown> {
  const response = await apiClient.request(input, init);
  let payload: unknown;
  let parseError: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    parseError = error;
  }

  // reset 后端在 HTTP 4xx 时仍通过统一 envelope 返回稳定业务 code。
  // 必须先读取 code，不能把易变的 msg 当成客户端分支依据。
  const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (envelope.success && envelope.data.code !== 0) {
    if (options.acceptedBusinessCodes?.includes(envelope.data.code)) {
      return payload;
    }
    throw new Error(
      `coding_plan_reset_api_error:${envelope.data.code}${readCodingPlanResetErrorDiagnostics(response.headers)}`,
    );
  }

  if (!response.ok) {
    throw new ApiError({
      message: readApiErrorMessage(payload, `HTTP ${response.status}`),
      url: input,
      method: init.method,
      status: response.status,
      responseHeaders: readApiDiagnosticHeaders(response.headers),
      cause: parseError,
    });
  }
  if (parseError !== undefined) {
    throw new Error("coding_plan_reset_invalid_response", {
      cause: parseError,
    });
  }
  return payload;
}

function readCodingPlanResetEnvelope(
  payload: unknown,
): z.infer<typeof codingPlanResetEnvelopeSchema> {
  const result = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  if (result.data.code !== 0) {
    throw new Error(`coding_plan_reset_api_error:${result.data.code}`);
  }
  return result.data;
}

function readCodingPlanResetEnvelopeData<TSchema extends z.ZodType>(
  payload: unknown,
  schema: TSchema,
): z.infer<TSchema> {
  const envelope = readCodingPlanResetEnvelope(payload);
  const result = schema.safeParse(envelope.data);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  return result.data;
}

function resolveTeamPlanContext(accountAccess: ZCodeAccountAccess): TeamPlanContext | null {
  return accountAccess.planKind === "team-coding-plan"
    ? {
        organizationId: accountAccess.organizationId,
        projectId: accountAccess.projectId,
        family: accountAccess.family,
      }
    : null;
}

function buildUsageEntitlementContextFromRequest(
  request: Pick<UsageEntitlementRequest, "accountAccess">,
): UsageEntitlementSnapshot["context"] {
  if (
    !request.accountAccess ||
    !("planKind" in request.accountAccess) ||
    request.accountAccess.planKind !== "team-coding-plan"
  ) {
    return { scope: "personal" };
  }
  return {
    scope: "team",
    organizationId: request.accountAccess.organizationId,
    projectId: request.accountAccess.projectId,
  };
}

function buildUsageEntitlementContext(
  resolved: ResolvedQuotaAuthorization,
  subscription: UsageEntitlementSnapshot["subscription"],
): UsageEntitlementSnapshot["context"] {
  if (!resolved.teamContext) {
    return {
      scope: "personal",
      productId: subscription?.details[0]?.productId || null,
      displayName: subscription?.details[0]?.productName || null,
    };
  }
  return {
    scope: "team",
    organizationId: resolved.teamContext.organizationId,
    projectId: resolved.teamContext.projectId,
    productId: subscription?.details[0]?.productId || null,
    displayName: subscription?.details[0]?.productName || null,
  };
}

function createBigModelUsageHeaders(resolved: ResolvedQuotaAuthorization): Record<string, string> {
  const headers: Record<string, string> = {
    // monitor 接口要求 authorization 直接传完整凭据。
    // 普通用量和 Coding Plan 用量都走 API Key，不能额外加 Bearer 前缀。
    authorization: resolved.authorization,
  };
  if (resolved.teamContext) {
    // Team Plan 的 quota / usage 按组织和项目隔离。
    // 只用 provider id 会固定读取默认项目，多个团队时余额会和当前选择不一致。
    headers["bigmodel-organization"] = resolved.teamContext.organizationId;
    headers["bigmodel-project"] = resolved.teamContext.projectId;
  }
  return headers;
}

function buildQuotaLimitUrl(resolved: ResolvedQuotaAuthorization): string {
  if (!resolved.teamContext) {
    return resolved.quotaUrl;
  }

  // BigModel Team Plan 的 quota/limit 后端按 type=2 路由到团队套餐。
  // 只切换团队项目 key/header 仍会走个人 Coding Plan 分支并返回“当前用户不存在 coding plan”。
  const url = new URL(resolved.quotaUrl);
  url.searchParams.set("type", "2");
  return url.toString();
}

function readSuccessfulBigModelMonitorData<TData extends object>(
  payload: {
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  },
  fallbackMessage: string,
  emptyData: TData,
  options: { allowMissingData?: boolean } = {},
): TData {
  if (!isSuccessfulBigModelEnvelope(payload)) {
    throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
  }
  if (payload.data) {
    return payload.data;
  }
  if (options.allowMissingData === true && hasExplicitBigModelSuccessSignal(payload)) {
    // BigModel monitor 的 tool-usage 在团队项目无工具调用时会返回
    // code=200、msg=“操作成功”但省略 data。空用量应显示为空统计，不能中断整个统计页。
    return emptyData;
  }
  throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
}

// credit-usage/activity、usage-detail、model-performance-day 是可选数据面。
// 传输层失败（HTTP 非 2xx、超时、断网）时只清空对应区域并记 warn，不能让
// Promise.all 提前 reject 拖垮整张 Coding Plan Usage 面板。HTTP 200 但业务信封失败
// （如 token expired）仍由 readSuccessfulBigModelMonitorData 抛错：鉴权/后端错误必须
// 显式暴露给用户，不能伪装成空用量（既有测试已锁定该语义）。
async function readBestEffortBigModelMonitorData<TData extends object>(
  request: Promise<{
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  }>,
  fallbackMessage: string,
  emptyData: TData,
): Promise<TData> {
  let payload: Awaited<typeof request> | null = null;
  try {
    payload = await request;
  } catch (error) {
    log.warn(undefined, `${fallbackMessage}，该区域降级为空统计`, {
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof ApiError ? error.status : null,
    });
    return emptyData;
  }
  return readSuccessfulBigModelMonitorData(payload, fallbackMessage, emptyData, {
    allowMissingData: true,
  });
}

function readBigModelEnvelopeMessage(payload: { message?: string; msg?: string }): string {
  return payload.msg?.trim() || payload.message?.trim() || "";
}

function sanitizeMonitorDiagnosticUrl(url: string | undefined): string {
  if (!url) return "<unknown-monitor-url>";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-monitor-url>";
  }
}

function hasExplicitBigModelSuccessSignal(payload: { code?: number; success?: boolean }): boolean {
  return payload.success === true || payload.code === 0 || payload.code === 200;
}

function isSuccessfulBigModelEnvelope(payload: { code?: number; success?: boolean }): boolean {
  const code = payload.code;
  // BigModel monitor/quota 后端存在 code=0 且 msg=“操作成功”的成功响应。
  // 只按 code=200 判断会把团队用量统计的成功包误抛成错误，导致设置页显示无法读取统计。
  return (
    payload.success !== false && (code === undefined || code === null || code === 0 || code === 200)
  );
}

function buildSubscriptionSnapshot(summary: {
  productId: string;
  productName: string;
  billingCycle: string | null;
  renewTime: string | null;
  expireTime: string | null;
}): UsageEntitlementSnapshot["subscription"] {
  return {
    identityType: "unknown",
    identityMasked: null,
    details: [{ ...summary, purchaseTime: null, beginTime: null }],
  };
}

function buildZaiStartPlanSubscription(
  plans: ZaiStartPlanPlan[] | undefined,
): UsageEntitlementSnapshot["subscription"] {
  const activePlans = (plans ?? []).filter(
    (plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active",
  );
  return {
    identityType: "unknown",
    identityMasked: null,
    details: activePlans.map((plan) => ({
      productId: readNonEmptyString(plan.plan_id) ?? "",
      productName: readNonEmptyString(plan.name) ?? "编程套餐",
      purchaseTime: null,
      beginTime: formatUnixSecondsAsIso(plan.starts_at),
      billingCycle: pickZaiStartPlanBillingCycle(plan),
      // Start Plan 卡片不展示套餐级续期时间：额度桶刷新时间由每个 limit 的
      // nextResetTime（balance.expires_at）表达，套餐到期由 expireTime（ends_at）表达。
      renewTime: null,
      expireTime: formatUnixSecondsAsIso(plan.ends_at),
      entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
        const entitlementId = readNonEmptyString(entitlement.entitlement_id);
        if (!entitlementId) return [];
        return [
          {
            entitlementId,
            showName: readNonEmptyString(entitlement.show_name),
            effectiveTime: formatUnixSecondsAsIso(entitlement.effective_at),
          },
        ];
      }),
    })),
  };
}

/**
 * tripwire：服务端契约保证 balances 只属于 active plans、每个桶都能按
 * plan_id 归属到套餐卡。出现无归属桶（含缺失 plan_id 的桶）说明契约被破坏——
 * 设置页多卡路径会静默丢弃这些桶，必须在 provider 层显式暴露，避免「额度去哪了」
 * 类问题无迹可查。正常数据下此日志零输出，用 warn 保证生产环境可见。
 */
function warnOnUnattributedStartPlanBuckets(
  plans: ZaiStartPlanPlan[] | undefined,
  balances: ZaiStartPlanBalance[] | undefined,
): void {
  const activePlanIds = new Set(
    (plans ?? [])
      .filter((plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active")
      .map((plan) => readNonEmptyString(plan.plan_id))
      .filter((planId): planId is string => Boolean(planId)),
  );
  const orphanBuckets = (balances ?? []).filter((balance) => {
    const planId = readNonEmptyString(balance.plan_id);
    return !planId || !activePlanIds.has(planId);
  });
  if (orphanBuckets.length === 0) {
    return;
  }
  log.warn(undefined, "billing/balance 返回无法归属到 active 套餐的额度桶", {
    orphanCount: orphanBuckets.length,
    orphanPlanIds: orphanBuckets.map((balance) => balance.plan_id ?? null),
    activePlanIds: [...activePlanIds],
  });
}

function buildZaiStartPlanRemaining(
  balances: ZaiStartPlanBalance[] | undefined,
): UsageEntitlementSnapshot["remaining"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances);
  if (limits.length === 0) {
    return null;
  }

  const total = limits.reduce((sum, limit) => sum + (limit.number ?? 0), 0);
  const remaining = limits.reduce((sum, limit) => sum + (limit.remaining ?? 0), 0);
  return {
    count: remaining,
    isShow: true,
    percentage: total > 0 ? remaining / total : undefined,
    nextResetTime:
      limits
        .map((limit) => limit.nextResetTime)
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => left - right)[0] ?? null,
  };
}

function buildZaiStartPlanQuota(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageEntitlementSnapshot["quota"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances, plans);
  if (limits.length === 0) {
    return null;
  }

  return {
    level: "Start",
    limits,
  };
}

function normalizeZaiStartPlanBalanceLimits(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageQuotaLimit[] {
  if (!Array.isArray(balances)) {
    return [];
  }

  return balances
    .map((balance) => {
      const total = parseNumber(balance.total_units);
      const used = parseNumber(balance.used_units);
      // Start Plan 余额卡必须展示后端给出的 remaining_units。
      // available_units 会再扣除进行中请求的 reserved_units，不能作为“剩余”兜底。
      const remaining = parseNumber(balance.remaining_units);
      if (total === null && used === null && remaining === null) {
        return null;
      }
      // 额度桶的真实重置边界由 balance.expires_at 表达；服务端契约保证每个桶都带该字段。
      const nextResetSeconds = parseUnixSeconds(balance.expires_at);
      const capabilityLabels = normalizeZaiStartPlanCapabilities(balance.capabilities);
      const capabilityType = readNonEmptyString(capabilityLabels.join(", "));
      const displayName = readNonEmptyString(balance.show_name);
      const planId = readNonEmptyString(balance.plan_id);
      const userPlanId = readNonEmptyString(balance.user_plan_id);
      const plan = plans?.find((candidate) =>
        userPlanId && candidate.user_plan_id
          ? candidate.user_plan_id === userPlanId
          : candidate.plan_id === planId,
      );
      const period = plan?.entitlements?.find(
        (entry) => entry.entitlement_id === balance.entitlement_id,
      )?.period;
      const periodStart = parseUnixSeconds(balance.period_start);
      const periodEnd = parseUnixSeconds(balance.period_end);

      return {
        // 旧映射丢弃 bucket 和周期字段，Renderer 只能用变化的余额去重，导致反复提醒。
        bucketId: readNonEmptyString(balance.bucket_id) ?? undefined,
        userPlanId: userPlanId ?? undefined,
        periodStart: periodStart === null ? undefined : periodStart * 1000,
        periodEnd: periodEnd === null ? undefined : periodEnd * 1000,
        period: readNonEmptyString(period) ?? undefined,
        meter: readNonEmptyString(balance.meter) ?? undefined,
        unitType: readNonEmptyString(balance.unit_type) ?? undefined,
        type:
          readNonEmptyString(balance.entitlement_id) ??
          capabilityType ??
          readNonEmptyString(balance.meter) ??
          "model_usage",
        // planId 用于设置页按套餐卡片分组额度桶；服务端契约保证每个桶都携带 plan_id。
        ...(planId ? { planId } : {}),
        unit: total ?? undefined,
        number: total ?? undefined,
        usage: used ?? undefined,
        currentValue: used ?? undefined,
        remaining: remaining ?? undefined,
        percentage:
          total !== null && remaining !== null && total > 0 ? remaining / total : undefined,
        nextResetTime: nextResetSeconds === null ? undefined : nextResetSeconds * 1000,
        usageDetails: capabilityLabels.map((modelCode) => ({
          modelCode,
          // 两个 Start Plan 的 Today's balance 接口已经返回面向用户的 show_name。
          // 继续从 capabilities 推导会把 GLM-5-Turbo 显示成 GLM-5Turbo，并且丢失服务端名称语义。
          ...(displayName ? { displayName } : {}),
          usage: used ?? 0,
        })),
      };
    })
    .filter((limit): limit is NonNullable<typeof limit> => limit !== null);
}

function normalizeZaiStartPlanCapabilities(capabilities: string[] | undefined): string[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }

  return capabilities
    .map((capability) =>
      capability.startsWith("model:") ? capability.slice("model:".length) : capability,
    )
    .filter((capability) => capability.trim().length > 0);
}

function parseNumber(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numericValue) ? numericValue : null;
}

function pickCurrentZaiStartPlan(plans: ZaiStartPlanPlan[] | undefined): ZaiStartPlanPlan | null {
  return (
    plans?.find((plan) => {
      const status = readNonEmptyString(plan.status)?.toLowerCase();
      const planId = readNonEmptyString(plan.plan_id)?.toLowerCase();
      const name = readNonEmptyString(plan.name)?.toLowerCase();
      return (
        status === "active" && (isZaiStartPlanIdentity(planId) || isZaiStartPlanIdentity(name))
      );
    }) ?? null
  );
}

function readZaiStartPlanBalances(
  payload: ZaiStartPlanBalanceEnvelope,
): ZaiStartPlanBalance[] | undefined {
  return payload.data?.balances as ZaiStartPlanBalance[] | undefined;
}

function summarizeStartPlans(plans: ZaiStartPlanPlan[] | undefined): Array<{
  name: string | null;
  plan_id: string | null;
  status: string | null;
}> {
  return (plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    plan_id: plan.plan_id ?? null,
    status: plan.status ?? null,
  }));
}

function summarizeStartPlanBalances(balances: ZaiStartPlanBalance[] | undefined): Array<{
  entitlement_id: string | null;
  show_name: string | null;
  total_units: number | string | null;
  used_units: number | string | null;
  remaining_units: number | string | null;
  available_units: number | string | null;
  reserved_units: number | string | null;
}> {
  return (balances ?? []).map((balance) => ({
    entitlement_id: balance.entitlement_id ?? null,
    show_name: balance.show_name ?? null,
    total_units: balance.total_units ?? null,
    used_units: balance.used_units ?? null,
    remaining_units: balance.remaining_units ?? null,
    available_units: balance.available_units ?? null,
    reserved_units: balance.reserved_units ?? null,
  }));
}

function isZaiStartPlanIdentity(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.includes("start-plan") || value.includes("start plan");
}

function pickZaiStartPlanBillingCycle(plan: ZaiStartPlanPlan): string | null {
  return (
    plan.entitlements
      ?.map((item) => readNonEmptyString(item.period))
      .find((period): period is string => Boolean(period)) ?? null
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatUnixSecondsAsIso(value: number | string | null | undefined): string | null {
  const numericValue = parseUnixSeconds(value);
  if (numericValue === null) {
    return null;
  }

  return new Date(numericValue * 1000).toISOString();
}

function parseUnixSeconds(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}

function buildUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "model-usage" | "tool-usage",
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, `/${endpoint}`);
  if (resolved.teamContext) {
    // BigModel Team Plan 的 monitor 用量接口和 quota/limit 一样按 type=2 路由。
    // 只带团队项目 key/header 时仍会落到个人 Coding Plan 分支并返回不存在套餐。
    url.searchParams.set("type", "2");
  }
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

function buildCreditUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "activity" | "usage-detail",
  startTime: string,
  endTime: string,
  usageType?: "MODEL" | "MCP",
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/usage\/quota\/limit$/, `/credit-usage/${endpoint}`);
  // Team Plan 的 quota/limit 仍用 type=2，但 credit-usage 使用 type=3；
  // 继续沿用 type=2 会触发后端“仅企业主账号可查询企业汇总数据”分支。
  url.searchParams.set("type", resolved.teamContext ? "3" : "1");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  if (usageType) {
    url.searchParams.set("usageType", usageType);
  }
  return url.toString();
}

function buildModelPerformanceMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, "/model-performance-day");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

function resolveCreditUsageActivityTimeRange(timeZone: string | undefined): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, -365);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

function resolveModelPerformanceTimeRange(
  timeZone: string | undefined,
  range: "7d" | "30d",
): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, range === "7d" ? -6 : -29);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

function formatDateInTimeZone(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function resolveQuotaUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(env, "ZCODE_BIGMODEL_USAGE_QUOTA_URL") ?? readEnv(env, "BIGMODEL_USAGE_QUOTA_URL");
}

function resolveCodingPlanApiKeyError(providerId: string | undefined): string {
  if (providerId && isZaiCodingPlanProviderId(providerId)) {
    return "zai_coding_plan_api_key_required";
  }
  return "bigmodel_coding_plan_api_key_required";
}

function resolveAccountProviderQuotaUrl(providerId: string, env: NodeJS.ProcessEnv): string {
  return isZaiCodingPlanProviderId(providerId) ? buildZaiQuotaUrl(env) : buildBigModelQuotaUrl(env);
}

function resolveAccountProviderLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "Z.ai - Coding Plan"
    : "BigModel - Coding Plan";
}

function buildBigModelQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  return buildBigModelApiUrl(env, BIGMODEL_QUOTA_PATH);
}

function buildZaiQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  // ZAI usage/quota 与 business login 共用业务域名。
  // 测试环境必须请求 配置的 ZAI Business origin，不能把测试 token 发送到生产 api.z.ai。
  return buildRuntimeZaiBusinessUrl(env, "/api/monitor/usage/quota/limit");
}
