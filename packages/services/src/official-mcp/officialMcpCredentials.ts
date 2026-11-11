/*
 * ZCode 官方 Server MCP 的凭证解析与身份头构造。
 *
 * 本文件与 Off-Peak 的 offPeakRuntimeModel.ts **逻辑等价但完全独立**：
 * 不复用其函数、不修改其行为。理由是两者的套餐门槛、Team 支持范围与凭证通道预期会独立演进，
 * 共享 helper 会让任一侧的调整都变成需要评估双方影响的改动。
 *
 * 与 Off-Peak 的三处有意差异：
 *   1. 显式产出 Bigmodel-Target-Type（Off-Peak 侧当前没有生产者）；
 *   2. 不存在任何 mock 凭证分支（官方 MCP 无 mock 网关，测试用依赖注入替换来源）；
 *   3. 失败原因使用 official_* 分类，不复用 Off-Peak 的 reason 字符串。
 *
 * 凭证通道：Coding Plan 凭证走 `X-Bigmodel-Authorization` + MaaS 登录 JWT，
 * 不再发送 `X-Coding-Plan-Api-Key`。服务端把 API key 通道标为"仅存量客户端兼容"，且两个头同时
 * 发送是有害的——JWT 会赢得额度查询，但 API key 的归属校验仍会照跑，一把过期 key 就能让整个
 * 请求 403。Off-Peak 仍走 API key 通道，这也是上面"逻辑等价但完全独立"的又一个理由。
 */
import {
  OFFICIAL_MCP_AUTH_HEADER_NAMES,
  zcodeProviderAccountAccessSchema,
  type OfficialAuthConsumerKind,
  type OfficialMcpAuthFailureReason,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  isSameOAuthAccountMaterial,
  type OAuthAccountMaterial,
  type OAuthIdentityMaterial,
} from "#src/oauth/repo/oauthCredentialRepo.js";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("official-mcp");

/**
 * 只为日志算出 JWT 的剩余有效期（秒）。**不参与任何控制流**，解析失败返回 undefined。
 *
 * 存在理由：MaaS JWT 没有刷新链路，过期后服务端的表现是 queryCodingPlan 上游 401，
 * 客户端却收到"需要 Coding Plan"这类文案——真实原因与提示不符。有了这个数值，
 * "神秘的 403"能一眼看出是"token 早就过期了"。只记数字，绝不记 token 本身。
 */
function readJwtExpiresInSeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return Math.round(exp - Date.now() / 1000);
  } catch {
    return undefined;
  }
}

/** 凭证解析 info 日志的有效期分桶粒度（秒）；桶内不重复记录，见 createCredentialResolvedLogKey。 */
const CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS = 3600;

/**
 * 凭证解析成功日志的去重键（导出仅为可单测，无其他消费方）。
 *
 * 生产日志保留 JWT 有效期分桶，帮助区分凭据过期与套餐不可用，不记录凭据原文。
 * resolver 只合并正在执行的请求，没有时间缓存；因此按小时分桶去重，避免每次
 * MCP 调用都产生 info 日志。凭据有效期跨桶、进入 expired 或切换套餐类型时重新记录。
 */
export function createCredentialResolvedLogKey(input: {
  providerFamily: "zai" | "bigmodel";
  planTargetType: string | null;
  maasJwtExpiresInSeconds: number | undefined;
}): string {
  const expires = input.maasJwtExpiresInSeconds;
  const expiryBucket =
    expires === undefined
      ? "unparsable"
      : expires <= 0
        ? "expired"
        : `t${Math.floor(expires / CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS)}`;
  return `${input.providerFamily}|${input.planTargetType ?? "none"}|${expiryBucket}`;
}

let lastCredentialResolvedLogKey: string | undefined;

export interface OfficialMcpCredentialResolveOptions {
  /**
   * 套餐可选（插件命令进程，技术方案 5.8）：选中连接没有有效套餐时不返回 plan_required，
   * 只给 ZCode 登录身份，由服务端按免费档处理。登录态不完整（缺 MaaS JWT、跨 family）
   * 仍按 unavailable 返回，绝不把付费用户降成免费。
   */
  planOptional?: boolean;
}

export interface OfficialMcpCredentialResolverDeps {
  accountRequestAuthService: {
    resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  };
  getRegistryRevision(): number | null;
  loadOAuthIdentityMaterial(): Promise<OAuthIdentityMaterial | null>;
  loadOAuthAccountMaterial(family: "zai" | "bigmodel"): Promise<OAuthAccountMaterial | null>;
  modelSelectionService: {
    getView(): Promise<ModelSelectionView>;
  };
}

export type OfficialMcpPlanScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string };

export type OfficialMcpWireScope = OfficialMcpPlanScope | null;

/** 解析成功后的凭证快照。仅在 host/service 进程内存活，脱敏后才允许过 RPC。 */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * MaaS 登录 JWT（`oauth:<family>:access_token` 的原文，**不带 Bearer 前缀**）。
   * 前缀在 buildOfficialMcpAuthHeaders 里加，与 reset / usage 通道的既有约定一致。
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel" | "zai_cn";
  /** 当前选中连接的产品/额度归属；畸形旧 Team key 无法精确归属时为 null。 */
  planScope: OfficialMcpPlanScope | null;
  /** 实际发往 Server MCP 的身份头 scope；ZAI Team 与 Off-Peak 一致为 null。 */
  wireScope: OfficialMcpWireScope;
}

export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

type SelectedPlan = {
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  planScope: OfficialMcpPlanScope | null;
  wireScope: OfficialMcpWireScope;
};

type SelectedProvider = {
  providerId: string;
  access: ZCodeProviderAccountAccess;
};

function fail(reason: OfficialMcpAuthFailureReason): {
  ok: false;
  reason: OfficialMcpAuthFailureReason;
} {
  return { ok: false, reason };
}

/**
 * 从 Registry 判定当前启用的 Coding Plan Provider；动态套餐和 Team scope 随后由账号服务解析。
 * 禁止从静态 Provider Config 读取或伪造当前 Team scope。
 */
function resolveSelectedProvider(
  registry: ModelSelectionView,
): { ok: true; provider: SelectedProvider } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  const candidates = registry.providers.flatMap((provider) => {
    const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    return parsed.success &&
      (parsed.data.mode === "individual-coding-plan" || parsed.data.mode === "team-coding-plan")
      ? [{ providerId: provider.providerId, access: parsed.data }]
      : [];
  });
  if (candidates.length !== 1) {
    return fail("official_auth_plan_required");
  }
  return { ok: true, provider: candidates[0]! };
}

function resolveSelectedPlan(
  selectedProvider: SelectedProvider,
  access: ZCodeAccountAccess | null,
): { ok: true; plan: SelectedPlan } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  if (
    !access ||
    access.family !== selectedProvider.access.accountType ||
    (selectedProvider.access.mode === "team-coding-plan"
      ? access.planKind !== "team-coding-plan"
      : access.planKind !== "individual-coding-plan")
  ) {
    return fail("official_auth_plan_required");
  }
  const { providerId } = selectedProvider;
  const providerFamily = access.family;
  if (access.planKind === "team-coding-plan") {
    const teamScope: OfficialMcpPlanScope = {
      organizationId: access.organizationId,
      projectId: access.projectId,
      targetType: "TEAM",
    };
    return {
      ok: true,
      plan: {
        providerFamily,
        providerId,
        planScope: teamScope,
        wireScope: providerFamily === "bigmodel" ? teamScope : null,
      },
    };
  }
  return {
    ok: true,
    plan: {
      providerFamily,
      providerId,
      planScope: { targetType: "PERSONAL" },
      wireScope: { targetType: "PERSONAL" },
    },
  };
}

/** 非秘密的选择指纹，用于解析前后比对，防止把切换前后的两代凭证拼进同一请求。 */
function createSelectionFingerprint(registry: ModelSelectionView): string {
  return JSON.stringify({ revision: registry.revision, providers: registry.providers });
}

type OfficialMcpIdentitySnapshot = {
  activeProvider: "zai" | "bigmodel" | "zai_cn";
  userId: string;
  sessionRevision: string | null;
  jwt: string;
  registry: ModelSelectionView;
  selectionFingerprint: string;
  registryRevision: number | null;
};

async function readIdentitySnapshot(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<
  | { ok: true; snapshot: OfficialMcpIdentitySnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason }
> {
  const registryRevision = deps.getRegistryRevision();
  const registry = await deps.modelSelectionService.getView();
  const identity = await deps.loadOAuthIdentityMaterial();
  // 读取身份期间套餐 Registry 可能已切换；同步版本检查之后不再 await。
  if (deps.getRegistryRevision() !== registryRevision) return fail("official_auth_unavailable");
  if (!identity) return fail("official_auth_unavailable");
  const activeProvider =
    identity.loginProvider === "zai"
      ? "zai"
      : identity.loginProvider === "bigmodel"
        ? "bigmodel"
        : identity.loginProvider === "zai_cn"
          ? "zai_cn"
          : null;
  if (!activeProvider) return fail("official_auth_unavailable");
  return {
    ok: true,
    snapshot: {
      activeProvider,
      userId: identity.zcodeUserId,
      sessionRevision: identity.sessionRevision,
      jwt: identity.zcodeJwtToken,
      registry,
      registryRevision,
      selectionFingerprint: createSelectionFingerprint(registry),
    },
  };
}

function isSameIdentitySnapshot(
  before: OfficialMcpIdentitySnapshot,
  after: OfficialMcpIdentitySnapshot,
): boolean {
  return (
    before.activeProvider === after.activeProvider &&
    before.userId === after.userId &&
    before.sessionRevision === after.sessionRevision &&
    before.jwt === after.jwt &&
    before.registryRevision === after.registryRevision &&
    before.selectionFingerprint === after.selectionFingerprint
  );
}

function identityOnlyOutcome(identity: OfficialMcpIdentitySnapshot): OfficialMcpCredentialOutcome {
  log.debug("official mcp identity-only credentials resolved", {
    providerFamily: identity.activeProvider,
    reason: "official_auth_plan_required",
  });
  return {
    ok: true,
    snapshot: {
      jwt: identity.jwt,
      planScope: null,
      providerFamily: identity.activeProvider,
      wireScope: null,
    },
  };
}

/**
 * 解析当前选中连接的官方 MCP 凭证。
 *
 * 防竞态：Registry、动态 Account Access、active provider、zcode JWT 与 MaaS JWT
 * 都可能在解析期间变化。登录渠道不决定套餐 family；主身份与关联材料必须匹配同一
 * user ID、revision 和业务 JWT。解析前后再比对选择及关联材料，两轮仍不稳定则返回不可用。
 */
export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
  options: OfficialMcpCredentialResolveOptions = {},
): Promise<OfficialMcpCredentialOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await readIdentitySnapshot(deps);
    if (!identity.ok) {
      if (attempt === 0) continue;
      return identity;
    }
    const selectedProvider = resolveSelectedProvider(identity.snapshot.registry);
    if (!selectedProvider.ok) {
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }
    const accountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const selected = resolveSelectedPlan(selectedProvider.provider, accountAccess);
    if (!selected.ok) {
      if (!options.planOptional || selected.reason !== "official_auth_plan_required") {
        return selected;
      }
      // 套餐可选：选中的 Coding Plan 连接当前没有有效套餐（过期、类型不符），按只有登录身份处理。
      // 和上面「没有选中套餐」一样先确认身份没有在解析期间变化。
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }

    const material = await deps.loadOAuthAccountMaterial(selected.plan.providerFamily);
    // 登录渠道和套餐家族可以不同；只能接受主身份绑定的同一份关联材料。
    if (
      !material ||
      material.loginProvider !== identity.snapshot.activeProvider ||
      material.zcodeUserId !== identity.snapshot.userId ||
      material.sessionRevision !== identity.snapshot.sessionRevision ||
      material.zcodeJwtToken !== identity.snapshot.jwt
    )
      continue;
    const codingPlanAuthorization = material.accessToken.trim();
    if (!codingPlanAuthorization) return fail("official_auth_unavailable");
    const latestAccountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const latestMaterial = await deps.loadOAuthAccountMaterial(selected.plan.providerFamily);
    // 最后一项 IO 再读取主身份和 Registry，不能在换号后仍拼装此前的套餐头。
    const latestIdentity = await readIdentitySnapshot(deps);
    if (
      !latestIdentity.ok ||
      !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot) ||
      JSON.stringify(accountAccess) !== JSON.stringify(latestAccountAccess) ||
      !isSameOAuthAccountMaterial(material, latestMaterial)
    )
      continue;

    // provider 条目只作"该 Coding Plan 连接确实存在"的门槛。业务 key 本身不再是凭证
    // （已切到 MaaS JWT 通道），因此不再要求它有值——否则业务 key 正在刷新的瞬态
    // 会把一次本可成功的调用判成"没有套餐"。真正的"没有套餐"由上面两道门槛拦住：
    // API Key 模式与选中 Start Plan 连接，两者都不依赖业务 key。
    const provider = identity.snapshot.registry.providers.find(
      (candidate) => candidate.providerId === selected.plan.providerId,
    );
    if (!provider) return fail("official_auth_plan_required");

    // info 而非 debug：生产构建 debug 不落盘，而 MaaS JWT 剩余有效期是排障关键线索
    // （见 createCredentialResolvedLogKey 的说明）。只记剩余秒数，绝不记 token 本身。
    // 去重键跨桶才记录，避免日志量与官方 MCP 请求数同数量级。
    const maasJwtExpiresInSeconds = readJwtExpiresInSeconds(codingPlanAuthorization);
    const logKey = createCredentialResolvedLogKey({
      providerFamily: selected.plan.providerFamily,
      planTargetType: selected.plan.planScope?.targetType ?? null,
      maasJwtExpiresInSeconds,
    });
    if (logKey !== lastCredentialResolvedLogKey) {
      lastCredentialResolvedLogKey = logKey;
      log.info("official mcp credentials resolved", {
        maasJwtExpiresInSeconds,
        providerFamily: selected.plan.providerFamily,
        planTargetType: selected.plan.planScope?.targetType ?? null,
        wireTargetType: selected.plan.wireScope?.targetType ?? null,
      });
    }

    return {
      ok: true,
      snapshot: {
        codingPlanAuthorization,
        jwt: identity.snapshot.jwt,
        planScope: selected.plan.planScope,
        providerFamily: selected.plan.providerFamily,
        wireScope: selected.plan.wireScope,
      },
    };
  }

  return fail("official_auth_unavailable");
}

/**
 * 由凭证快照构造本次请求的身份头。
 * Team 身份成对原子性：organization/project 任一缺失时两者都不发送。
 */
export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  if (snapshot.codingPlanAuthorization) {
    // 服务端会 CutPrefix("Bearer ")，裸 token 也接受；这里按 MCP 接口文档发 Bearer 形式。
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] =
      `Bearer ${snapshot.codingPlanAuthorization}`;
  }
  const scope = snapshot.wireScope;
  if (scope) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
    if (scope.targetType === "TEAM") {
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
    }
  }
  return headers;
}

/** host handler 透传的请求上下文；不参与凭证选择。 */
export interface OfficialMcpAuthHeadersRequestContext {
  consumer: OfficialAuthConsumerKind;
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

export type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * 身份头解析入口，带 in-flight 去重。
 *
 * 只合并**并发**请求：已有解析在飞时后来者复用同一 Promise；settle 后立即丢弃，
 * 下一个请求重新完整解析。不做任何时间维度缓存，因此不存在"读到已被替换的旧凭证"的窗口。
 * 作用域为 host 全局——凭证是全局状态，按 plugin/mcpKey/workspace 分桶只会削弱去重、不增隔离。
 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  // 两种消费方的解析结果不同（套餐可选与否），按模式分别合并在飞的请求。
  const pending = new Map<
    "plan-required" | "plan-optional",
    Promise<OfficialMcpAuthHeadersOutcome>
  >();

  return {
    // request 只用来选解析模式（host handler 已在此之前完成可信校验，见 zcodeAgentService）；
    // 凭据是 host 全局状态，**不**按 plugin/mcpKey/workspace 分桶——分桶只会削弱 in-flight
    // 去重而不增加隔离。
    resolveHeaders(request?: OfficialMcpAuthHeadersRequestContext) {
      const mode = request?.consumer === "plugin-command" ? "plan-optional" : "plan-required";
      const existing = pending.get(mode);
      if (existing) return existing;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps, {
          planOptional: mode === "plan-optional",
        });
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      pending.set(mode, inFlight);
      // 用双 handler 的 then 而非 finally：finally 会派生一个同样 reject 的 promise，
      // 调用方只 await 了 inFlight，那个派生 promise 无人处理会变成 unhandled rejection。
      // 解析抛错也必须清空 slot，否则后续请求会永久复用失败的 Promise。
      const clear = (): void => {
        if (pending.get(mode) === inFlight) pending.delete(mode);
      };
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
