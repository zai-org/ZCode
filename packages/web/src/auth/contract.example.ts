import type { WebAuthContract } from "#src/auth/contract.js";

/** 读取只恢复缓存；显式登录由点击事件发起，取消信号覆盖全部网络等待。 */
export async function exampleWebAuth(auth: WebAuthContract, signal: AbortSignal): Promise<void> {
  if (!(await auth.restoreCachedSession())) await auth.startLogin({ provider: "zai_cn", signal });
}
