/**
 * 国内入口（zai_cn）新账号夹具：账号从未注册 BigModel。
 * ZCode 主体与 JWT 有效；登录回包与 profile 都只有 ZCode 主体，没有 bigmodel 关联块。
 * Spec 与账号控制面 mock 共用这些值，避免两侧各写一份身份导致 profile 匹配不上。
 */
export const CN_UNLINKED_E2E_USER_ID = "zcode-cn-new-user";
export const CN_UNLINKED_E2E_ZCODE_JWT = "e2e-cn-unlinked-zcode-jwt";
export const CN_UNLINKED_E2E_UPSTREAM_TOKEN = "e2e-cn-unlinked-upstream-oauth";

/** 明确成功但无关联的 profile：不能被解释成查询失败，也不能产生关联材料。 */
export function buildCnUnlinkedProfileResponse() {
  return {
    code: 0,
    data: { user: { user_id: CN_UNLINKED_E2E_USER_ID, name: "CN New User" } },
  };
}

/** 隔离凭据文件中的国内登录会话；只写当前产品读取的 OAuth 命名空间。 */
export function buildCnUnlinkedSessionCredentials(): Record<string, string> {
  return {
    "oauth:active_provider": "zai_cn",
    "oauth:session_revision": "e2e-cn-unlinked-revision",
    "oauth:zai_cn:access_token": CN_UNLINKED_E2E_UPSTREAM_TOKEN,
    "oauth:zai_cn:user_info": JSON.stringify({
      user_id: CN_UNLINKED_E2E_USER_ID,
      name: "CN New User",
    }),
    zcodejwttoken: CN_UNLINKED_E2E_ZCODE_JWT,
  };
}
