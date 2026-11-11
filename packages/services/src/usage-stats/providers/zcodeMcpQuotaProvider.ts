/* ZCode 官方 Server MCP 的调用额度读取（`GET /api/v1/mcp/usage`）。
 *
 * 单文件承载该接口的全部细节：路径、信封解析、总额度映射。**鉴权不在这里实现**——
 * 身份头必须与 server MCP 端点用同一套 5 个头，唯一生产者是
 * `official-mcp/officialMcpCredentials.ts` 的 buildOfficialMcpAuthHeaders。
 * 这里只接收注入的凭证解析器，绝不自行拼头、补头或改前缀，否则会与服务端
 * WithCodingPlan 的读取口径分叉。
 */
import { z } from "zod";
import {
  MCP_USAGE_QUOTA_LIMIT_TYPE,
  buildRuntimeZCodeApiUrl,
  type ApiClient,
  type UsageMcpQuotaScope,
  type UsageMcpQuotaSnapshot,
  type UsageQuotaLimit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  buildOfficialMcpAuthHeaders,
  type OfficialMcpCredentialOutcome,
} from "#src/official-mcp/officialMcpCredentials.js";

const MCP_USAGE_PATH = "/api/v1/mcp/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");

/**
 * 注入的官方 MCP 凭证来源。
 *
 * 注入的是**凭证解析**而不是 createOfficialMcpAuthHeadersResolver 的 resolveHeaders：
 * 归属校验需要 snapshot.providerFamily，而身份头里没有 family 信息（只有 target-type /
 * organization / project）。身份头仍由共享的 buildOfficialMcpAuthHeaders 构造，保持单源。
 */
export interface OfficialMcpCredentialSource {
  resolve(): Promise<OfficialMcpCredentialOutcome>;
}

const mcpUsageTotalSchema = z.object({
  used: z.number().finite(),
  limit: z.number().finite(),
  remaining: z.number().finite(),
});

const mcpUsageDataSchema = z.object({
  server_time: z.number().finite(),
  next_refresh_at: z.number().finite().optional(),
  level: z.string().optional(),
  /**
   * 服务端汇总后的总额度。
   *
   * 刻意 optional 而不是必填：必填时缺字段会落进"结构不符合预期"那条通用告警，与"整体坏了"
   * 混在一起。单独分支能记一条"响应缺少 total_usage"，接口再变时一眼可辨——这一行的由来正是
   * 上一次的故障：服务端把返回从 `buckets` 数组改成 total_usage，客户端 schema 校验失败，
   * 而 mcpQuota 是可选数据面（失败即静默降级），表现为额度条无声消失。
   */
  total_usage: mcpUsageTotalSchema.optional(),
});

const mcpUsageEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: mcpUsageDataSchema.optional().nullable(),
});

/** 本次 entitlement 查询的连接归属，用于和凭证归属比对。 */
export interface McpQuotaRequestScope {
  providerFamily: "zai" | "bigmodel";
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * 凭证归属是否与本次 entitlement 查询一致。
 *
 * 凭证来自 settings 当前选中的连接，而 entitlement 是按面板 provider tab 分别查询的。
 * 同时持有 Z.ai 与 BigModel Coding Plan（或个人 + Team）的用户，如果不做这层比对，
 * 就会在另一个 tab 下看到不属于它的 MCP 额度。
 */
export function matchesMcpQuotaScope(
  scope: UsageMcpQuotaScope,
  request: McpQuotaRequestScope,
): boolean {
  if (scope.providerFamily !== request.providerFamily) {
    return false;
  }
  const requestOrganizationId = request.organizationId?.trim() ?? "";
  const requestProjectId = request.projectId?.trim() ?? "";
  const requestIsTeam = Boolean(requestOrganizationId && requestProjectId);
  if (!requestIsTeam) {
    return scope.targetType === "PERSONAL";
  }
  if (scope.targetType !== "TEAM") return false;
  return (
    (scope.organizationId?.trim() ?? "") === requestOrganizationId &&
    (scope.projectId?.trim() ?? "") === requestProjectId
  );
}

/**
 * 服务端汇总的总额度映射成一条等价的 UsageQuotaLimit，直接复用现有额度条 / 额度卡的展示逻辑。
 *
 * percentage 沿用 quota 接口语义（**已使用**占比），展示端统一反转成剩余。
 */
export function buildMcpQuotaAggregateLimit(params: {
  totalUsage: { used: number; limit: number; remaining: number };
  nextResetTime?: number;
}): UsageQuotaLimit | null {
  const limit = Math.max(0, params.totalUsage.limit);
  if (limit <= 0) {
    // 没有可用额度时不渲染一条 0% 的空条。
    return null;
  }
  // 服务端 remaining 已按 0 兜底，这里再夹一次上界：异常数据（remaining > limit）会算出负的
  // 已用占比，进而让展示端反转后越过 100%。
  const remaining = Math.min(Math.max(0, params.totalUsage.remaining), limit);
  const used = Math.max(0, params.totalUsage.used);

  const usedPercentage = Math.max(0, Math.min(100, 100 - (remaining / limit) * 100));
  return {
    type: MCP_USAGE_QUOTA_LIMIT_TYPE,
    currentValue: used,
    usage: used,
    remaining,
    percentage: usedPercentage,
    ...(params.nextResetTime === undefined ? {} : { nextResetTime: params.nextResetTime }),
    // usageDetails 留空：该字段在 StatusCards 里被当作模型名渲染，额度维度不适合走那条展示路径。
    usageDetails: [],
  };
}

function readScopeFromCredentialSnapshot(
  snapshot: Extract<OfficialMcpCredentialOutcome, { ok: true }>["snapshot"],
): UsageMcpQuotaScope | null {
  const scope = snapshot.planScope;
  if (!scope || (snapshot.providerFamily !== "zai" && snapshot.providerFamily !== "bigmodel"))
    return null;
  return scope.targetType === "TEAM"
    ? {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        providerFamily: snapshot.providerFamily,
        targetType: "TEAM",
      }
    : { providerFamily: snapshot.providerFamily, targetType: "PERSONAL" };
}

function readRequestId(headers: Headers): string | null {
  return headers.get("x-request-id")?.trim() || null;
}

/** 响应体截断长度。正常响应只有一两百字节，截断只为兜住错误页（如网关 HTML）。 */
const MAX_LOGGED_BODY_CHARS = 512;

/**
 * 响应体可以原样进日志：该接口的 data 只有 server_time / next_refresh_at / level / total_usage，
 * 全是非敏感计数，**不含任何凭证**。反过来，不记它就是这次故障排查慢的直接原因——
 * 服务端换了字段名，客户端只报一句"结构不符合预期"，看不出到底收到了什么。
 */
function truncateForLog(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…(${trimmed.length} chars)`
    : trimmed;
}

/**
 * 读取一次 MCP 额度。可选数据面：任何失败都返回 null 并只记 warn，
 * 绝不影响 entitlement 快照本身的成功与降级语义。
 */
export async function fetchMcpQuotaSnapshot(params: {
  apiClient: ApiClient;
  credentialSource: OfficialMcpCredentialSource;
  env: NodeJS.ProcessEnv;
  requestScope: McpQuotaRequestScope;
}): Promise<UsageMcpQuotaSnapshot | null> {
  let outcome: OfficialMcpCredentialOutcome;
  try {
    outcome = await params.credentialSource.resolve();
  } catch (error) {
    log.warn(undefined, "读取官方 MCP 额度凭证失败，跳过该额度", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!outcome.ok) {
    // official_auth_plan_required（无 Coding Plan / Start Plan / API Key 模式）与
    // official_auth_unavailable（未登录、凭证缺失、选择态竞态）都不发请求。
    log.info(undefined, "官方 MCP 额度不可用，跳过请求", { reason: outcome.reason });
    return null;
  }

  const scope = readScopeFromCredentialSnapshot(outcome.snapshot);
  if (!scope) {
    log.info(undefined, "官方 MCP 额度缺少可精确归属的套餐 scope，跳过请求", {
      credentialFamily: outcome.snapshot.providerFamily,
    });
    return null;
  }
  if (!matchesMcpQuotaScope(scope, params.requestScope)) {
    log.info(undefined, "官方 MCP 额度归属与本次查询不一致，跳过请求", {
      credentialFamily: scope.providerFamily,
      credentialTargetType: scope.targetType ?? null,
      requestFamily: params.requestScope.providerFamily,
      requestOrganizationId: params.requestScope.organizationId ?? null,
      requestProjectId: params.requestScope.projectId ?? null,
    });
    return null;
  }

  const url = buildRuntimeZCodeApiUrl(params.env, MCP_USAGE_PATH);
  const headers = buildOfficialMcpAuthHeaders(outcome.snapshot);
  let payload: unknown;
  let requestId: string | null = null;
  let body = "";
  // 请求与响应各记一条 info（不是 debug）：生产构建的最低级别是 Info，只记 debug 等于出问题时
  // 什么都看不到。该接口按 entitlement 的 TTL 缓存触发，量级是每会话个位数，不构成日志膨胀。
  // 只记 header **名**，绝不记值——里面是 JWT 与 Coding Plan 凭证。
  log.info(undefined, "官方 MCP 额度请求", {
    credentialFamily: scope.providerFamily,
    credentialTargetType: scope.targetType ?? null,
    headerNames: Object.keys(headers).sort(),
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    url,
  });
  const startedAt = Date.now();
  try {
    const response = await params.apiClient.request(url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      // 身份头原样使用共享构造结果：5 个头一个不改、不补、不改前缀。
      headers,
    });
    requestId = readRequestId(response.headers);
    const text = await response.text();
    body = truncateForLog(text);
    log.info(undefined, "官方 MCP 额度响应", {
      body,
      durationMs: Date.now() - startedAt,
      status: response.status,
      url,
      "x-request-id": requestId,
    });
    if (!response.ok) {
      log.warn(undefined, "官方 MCP 额度请求失败", {
        body,
        status: response.status,
        url,
        "x-request-id": requestId,
      });
      return null;
    }
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    log.warn(undefined, "官方 MCP 额度请求异常", {
      body,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      url,
      "x-request-id": requestId,
    });
    return null;
  }

  const envelope = mcpUsageEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    // 带上响应体与 zod 的 issue 路径：只报"结构不符合预期"时，看不出服务端到底改了哪个字段。
    log.warn(undefined, "官方 MCP 额度响应结构不符合预期", {
      body,
      issues: envelope.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
      ),
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  if (envelope.data.code !== 0 || !envelope.data.data) {
    // 业务失败（如 1000 用量存储故障）只清空该额度，不上抛。
    log.warn(undefined, "官方 MCP 额度业务失败", {
      code: envelope.data.code,
      msg: envelope.data.msg ?? null,
      "x-request-id": requestId,
    });
    return null;
  }

  const data = envelope.data.data;
  if (!data.total_usage) {
    // 与"结构不符合预期"分开记：这条专指接口把总额度字段换了名字/位置。
    log.warn(undefined, "官方 MCP 额度响应缺少 total_usage", {
      body,
      url,
      "x-request-id": requestId,
    });
    return null;
  }
  const aggregate = buildMcpQuotaAggregateLimit({
    totalUsage: data.total_usage,
    // 接口是 Unix 秒；客户端 nextResetTime 全链路是毫秒。
    ...(data.next_refresh_at === undefined ? {} : { nextResetTime: data.next_refresh_at * 1000 }),
  });
  if (!aggregate) {
    return null;
  }

  return {
    aggregate,
    level: data.level?.trim() || null,
    scope,
    serverTime: data.server_time * 1000,
  };
}
