import {
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ApiClient,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { LegacyTeamConnection } from "#src/setting/legacyAccountConnectionSettings.js";
import type {
  RemoteCustomerInfo,
  RemoteEnvelope,
} from "#src/model-provider/accountProviderApiTypes.js";

/** 仅供旧连接导入：只读 OAuth 用户信息，不依赖当前 Provider，也不申请团队 Key。退役旧版后删除。 */
export function createLegacyTeamOrganizationResolver(dependencies: {
  apiClient: ApiClient;
  loadOAuthTokenSet: (
    family: ProviderFamilyDomain,
  ) => Promise<{
    accessToken: string;
    zcodeJwtToken?: string | null;
    sessionRevision?: string | null;
    accountIdentity?: string;
    zcodeUserId?: string;
  } | null>;
}): (connection: LegacyTeamConnection) => Promise<string | null> {
  return async ({ family, projectId }) => {
    const tokens = await dependencies.loadOAuthTokenSet(family);
    const token = tokens?.accessToken.trim();
    if (!token || (family === "bigmodel" && token === tokens?.zcodeJwtToken)) return null;
    const origin =
      family === "zai"
        ? resolveZaiBusinessBaseUrl(process.env)
        : resolveBigModelApiOrigin(process.env);
    const response = await dependencies.apiClient.request(
      `${origin}/api/biz/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: 15_000,
        // 两个业务域都使用原始 OAuth token；不能添加 Bearer 或使用模型 API Key。
        headers: { Authorization: token, "Content-Type": "application/json" },
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as RemoteEnvelope<RemoteCustomerInfo>;
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) return null;
    // 账号切换使旧查询失去权威，即使项目 ID 碰巧相同也不能把组织写给新账号。
    const latest = await dependencies.loadOAuthTokenSet(family);
    if (
      latest?.accessToken.trim() !== token ||
      latest?.zcodeJwtToken !== tokens?.zcodeJwtToken ||
      latest?.sessionRevision !== tokens?.sessionRevision ||
      latest?.accountIdentity !== tokens?.accountIdentity ||
      latest?.zcodeUserId !== tokens?.zcodeUserId
    )
      return null;
    const organizations = new Set(
      (payload.data?.organizations ?? [])
        .filter((org) => org.projects?.some((project) => project.projectId?.trim() === projectId))
        .map((org) => org.organizationId?.trim())
        .filter((id): id is string => Boolean(id)),
    );
    return organizations.size === 1 ? [...organizations][0]! : null;
  };
}
