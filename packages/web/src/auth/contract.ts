import type { OAuthCachedSessionRestoreResult, UserInfo } from "@zcode/shared";

export type WebOAuthProviderId = "zai" | "zai_cn" | "bigmodel";

/** 会话归仓储所有；读取不写入，登录/退出等待持久化；订阅不携带凭据。 */
export interface WebAuthContract {
  startLogin(options?: {
    provider?: WebOAuthProviderId;
    signal?: AbortSignal;
    devReturnTo?: string;
    appReturnTo?: string;
    redirectUri?: string;
  }): Promise<void>;
  logout(): Promise<void>;
  restoreCachedSession(): Promise<UserInfo | null>;
  restoreCachedSessionState(): OAuthCachedSessionRestoreResult;
  getZCodeJwtToken(): string | null;
  getSessionRevision(): string | null;
  getActiveAccount(): {
    displayName: string;
    avatarUrl?: string;
    provider: WebOAuthProviderId;
  } | null;
  subscribeSessionChange(listener: () => void): () => void;
}
export type WebAuthService = WebAuthContract;
