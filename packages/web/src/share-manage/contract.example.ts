/**
 * web-share-manage 标准调用示例：撤销一个分享，并以服务端返回的视图替换本地行。
 */
import type { ConversationShareManagedItem } from "@zcode/shared";
import type { ConversationShareManageApi } from "./contract.js";

export async function exampleRevokeShare(
  api: ConversationShareManageApi,
  accessToken: string,
  items: readonly ConversationShareManagedItem[],
  shareId: string,
): Promise<ConversationShareManagedItem[]> {
  const updated = await api.revoke(accessToken, shareId);
  return items.map((item) => (item.share_id === shareId ? updated : item));
}
