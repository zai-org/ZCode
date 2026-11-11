/**
 * web-share-manage 对外契约：分享管理页依赖的服务端操作。真实 HTTP 实现与开发态 mock 共用这一契约。
 * 所有方法都以服务端响应为唯一事实源，调用方不做乐观更新。
 */
import type {
  ConversationShareManagedItem,
  ConversationShareManagedList,
  ConversationShareManagedUpdateRequest,
  ConversationShareTtlOptions,
} from "@zcode/shared";

export { CONVERSATION_SHARE_MANAGE_PAGE_SIZE } from "@zcode/shared";

export interface ConversationShareManageApi {
  /** 读取服务端声明的有效期范围；未声明范围时返回 undefined，管理页不显示有效期选项。 */
  ttlOptions(accessToken: string): Promise<ConversationShareTtlOptions | undefined>;
  /** 列出当前登录用户未过期的 active/revoked 分享；cursor 原样回传服务端的 next_cursor。 */
  list(accessToken: string, cursor?: string): Promise<ConversationShareManagedList>;
  /** 修改访问权限和/或有效期（ttl_ms 从现在起算）；至少带一个字段。返回修改后的服务端视图。 */
  update(
    accessToken: string,
    shareId: string,
    change: ConversationShareManagedUpdateRequest,
  ): Promise<ConversationShareManagedItem>;
  /** 撤销分享；对已撤销的分享幂等。 */
  revoke(accessToken: string, shareId: string): Promise<ConversationShareManagedItem>;
  /** 恢复已撤销的分享，不改变有效期；对生效中的分享幂等。 */
  restore(accessToken: string, shareId: string): Promise<ConversationShareManagedItem>;
  /** 删除分享，不可恢复；重复删除幂等。 */
  remove(accessToken: string, shareId: string): Promise<void>;
}
