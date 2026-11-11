import {
  ProjectAccessTokenClient,
  type ApiClient,
  type ProjectAccessTokenMaterial,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ZCodeAccountAccess,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import {
  isSameOAuthAccountMaterial,
  type OAuthAccountMaterial,
} from "#src/oauth/repo/oauthCredentialRepo.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "#src/providers/api/apiJson.js";

const log = createServiceLogger("account-provider-team-plan-request-key");
const TEAM_PLAN_RUNTIME_KEY_REQUEST_TIMEOUT_MS = 15_000;

interface TeamPlanRequestKeyDependencies {
  readonly apiClient: ApiClient;
  readonly tokenClient?: ProjectAccessTokenClient;
  readonly accountIdentity: string;
  readonly rejectedProjectTokenFingerprint?: string;
  readonly loadOAuthAccountMaterial: (
    family: ProviderFamilyDomain,
  ) => Promise<OAuthAccountMaterial | null>;
  readonly access: Extract<ZCodeAccountAccess, { planKind: "team-coding-plan" }>;
}

export async function resolveAccountTeamPlanRuntimeApiKey(
  params: TeamPlanRequestKeyDependencies,
): Promise<string | null> {
  return (await resolveAccountTeamPlanRuntimeMaterial(params))?.token ?? null;
}

export async function resolveAccountTeamPlanRuntimeMaterial(
  params: TeamPlanRequestKeyDependencies,
): Promise<ProjectAccessTokenMaterial | null> {
  const { family, organizationId, projectId } = params.access;
  const account = await params.loadOAuthAccountMaterial(family);
  if (!account || account.accountIdentity !== params.accountIdentity) return null;
  const token = account.accessToken;
  if (!token) {
    log.warn(undefined, "Team Plan runtime key projection skipped: OAuth token missing", {
      family,
      projectId,
    });
    return null;
  }
  const zcodeJwtToken = account.zcodeJwtToken;
  if (family === "bigmodel" && zcodeJwtToken && token === zcodeJwtToken) {
    // BigModel /api/biz 只接受登录 access token，不能使用旧版本误存的 ZCode JWT。
    log.warn(undefined, "Team Plan runtime key projection skipped: stale zcode JWT token", {
      family,
      projectId,
    });
    return null;
  }

  const host =
    family === "zai"
      ? resolveZaiBusinessBaseUrl(process.env)
      : resolveBigModelApiOrigin(process.env);
  const client =
    params.tokenClient ??
    new ProjectAccessTokenClient({
      request: (url, init) =>
        readApiJson(params.apiClient, url, {
          ...init,
          timeoutMs: TEAM_PLAN_RUNTIME_KEY_REQUEST_TIMEOUT_MS,
        }),
      observe: (event) => log.warn(undefined, "团队项目 Token 获取失败", event),
    });
  const result = await client.resolve({
    origin: host,
    family,
    loginToken: token,
    accountId: account.accountIdentity,
    rejectedProjectTokenFingerprint: params.rejectedProjectTokenFingerprint,
    team: { organizationId, projectId },
  });
  if (!isSameOAuthAccountMaterial(account, await params.loadOAuthAccountMaterial(family))) {
    client.clear();
    throw new Error("project_token_scope_invalidated");
  }
  return result;
}
