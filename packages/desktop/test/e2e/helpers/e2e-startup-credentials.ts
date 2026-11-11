import { isRequestSecuritySpec } from "./request-security-edition/index.js";
export interface E2EStartupCredentialSeedOptions {
  specs?: string[];
  remoteProfile?: boolean;
  accountMock?: boolean;
  legacyAuthToken: string;
  restoredOAuthCredentials: Record<string, string>;
}

export function createE2EStartupCredentialSeed(
  options: E2EStartupCredentialSeedOptions,
): Record<string, string> {
  // 根因：远程回放 runner 默认假 OAuth 触发真实控制面的登录过期弹窗，SSH 前置入口被遮挡。
  // 回放从匿名 Personal Provider 开始；live case 仍在自己的步骤中导入真实凭据。
  if (options.remoteProfile) return {};
  const requiresZCodeJwt = options.specs?.some((spec) => {
    const fileName = spec.replaceAll("\\", "/").split("/").at(-1);
    return (
      // 营销投放 spec 按主题拆成 marketing-touch-delivery*.test.ts，领取用例都需要本地 JWT。
      fileName?.startsWith("marketing-touch-delivery") ||
      fileName === "conversation-session-share-popover.test.ts" ||
      fileName === "marketing-touch-entitlement.test.ts" ||
      // Rewards 专项走本地控制面，需要同时验证 OAuth 与 JWT 注入。
      fileName === "marketing-touch-rewards.test.ts" ||
      fileName === "jwt-401-auto-logout.test.ts" ||
      // 语音输入只对已登录用户显示，ticket 请求带 zcodejwttoken。
      fileName === "composer-voice-input.test.ts" ||
      isRequestSecuritySpec(fileName) ||
      fileName === "coding-plan-upgrade-webview-refresh-provider.test.ts" ||
      fileName === "start-plan-manual-claim-experience.test.ts" ||
      fileName === "provider-family-responsive.test.ts" ||
      fileName === "conversation-session-offpeak-subagent-model-inheritance.test.ts" ||
      // Team 回归只替代 HTTP，仍走真实凭据解析；缺少 JWT 会在创建前被拒绝。
      fileName === "conversation-session-off-peak-team-plan.test.ts" ||
      fileName === "conversation-session-off-peak-invalid-ticket.test.ts"
    );
  });
  // Bug 原因：默认假 OAuth 即使没有 JWT，仍会访问真实账号控制面并触发过期弹窗。
  // 默认空凭据；只有显式账号 mock 或 JWT 专项采用合成身份，不再逐条排除普通用例。
  if (!options.accountMock && !requiresZCodeJwt) return {};
  const restoredOAuthCredentials = { ...options.restoredOAuthCredentials };
  if (!requiresZCodeJwt) delete restoredOAuthCredentials.zcodejwttoken;
  return {
    auth_token: options.legacyAuthToken,
    ...restoredOAuthCredentials,
  };
}
