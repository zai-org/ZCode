import type {
  ConversationShareManagedItem,
  ConversationShareManagedList,
  ConversationShareManagedUpdateRequest,
  ConversationShareTtlOptions,
} from "@zcode/shared";
import { ConversationSharePreviewClientError } from "../share/conversationSharePreviewClient.js";
import {
  CONVERSATION_SHARE_MANAGE_PAGE_SIZE,
  type ConversationShareManageApi,
} from "./contract.js";

const MOCK_SHARE_COUNT = 25;
const HOUR_MS = 60 * 60 * 1000;
// 上限故意小于 30 天预设：SHARE-MG01 据此验收有效期选项受服务端范围约束。
const MOCK_TTL_OPTIONS: ConversationShareTtlOptions = {
  defaultMs: 7 * 24 * HOUR_MS,
  minMs: HOUR_MS,
  maxMs: 7 * 24 * HOUR_MS,
};

function mockSearchParam(name: string): string | null {
  return new URLSearchParams(globalThis.location?.search).get(name);
}

async function mockDelay(name: string): Promise<void> {
  const delayMs = Number(mockSearchParam(name) ?? 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 开发态内存实现：只用于 `pnpm dev:web-share:mock` 与 SHARE-MG01 浏览器验收。
 * 25 条数据保证有第二页；每次返回服务端视图的副本，页面只能以响应为准更新。
 */
export class MockConversationShareManageClient implements ConversationShareManageApi {
  private readonly items: ConversationShareManagedItem[];

  constructor(origin = globalThis.location?.origin ?? "http://localhost:5173") {
    const now = Date.now();
    this.items = Array.from({ length: MOCK_SHARE_COUNT }, (_, index) => {
      const shareCode = `mock-managed-${String(index + 1).padStart(2, "0")}`;
      return {
        share_id: `share-${index + 1}`,
        share_code: shareCode,
        share_url: `${origin}/cn/share/${shareCode}`,
        title:
          index === 0
            ? "一个标题非常长、需要在窄屏下截断显示的会话分享示例"
            : `会话分享 ${index + 1}`,
        access_mode:
          index % 3 === 0 ? "private" : index % 3 === 1 ? "public_readonly" : "public_importable",
        status: index === 2 ? "revoked" : "active",
        created_at: now - index * HOUR_MS,
        expires_at: now + (7 * 24 - index) * HOUR_MS,
      };
    });
  }

  async ttlOptions(accessToken: string): Promise<ConversationShareTtlOptions | undefined> {
    this.authorize(accessToken);
    // SHARE-MG01：?mockTtlAuthFail=1 让 capabilities 立即返回 401，验收迟到的列表不会覆盖登录页。
    if (mockSearchParam("mockTtlAuthFail") === "1") this.authorize("");
    // SHARE-MG01：?mockTtlDelayMs=N 模拟 capabilities 慢响应，验收列表不被它阻塞。
    await mockDelay("mockTtlDelayMs");
    return { ...MOCK_TTL_OPTIONS };
  }

  async list(accessToken: string, cursor?: string): Promise<ConversationShareManagedList> {
    this.authorize(accessToken);
    // SHARE-MG01：?mockListDelayMs=N 让列表晚于 capabilities 返回。
    await mockDelay("mockListDelayMs");
    const start = cursor ? Number(cursor) : 0;
    const end = start + CONVERSATION_SHARE_MANAGE_PAGE_SIZE;
    return {
      items: this.items.slice(start, end).map((item) => ({ ...item })),
      ...(end < this.items.length ? { next_cursor: String(end) } : {}),
    };
  }

  async update(
    accessToken: string,
    shareId: string,
    change: ConversationShareManagedUpdateRequest,
  ): Promise<ConversationShareManagedItem> {
    return this.mutate(accessToken, shareId, (item) => ({
      ...item,
      ...(change.access_mode ? { access_mode: change.access_mode } : {}),
      ...(change.ttl_ms ? { expires_at: Date.now() + change.ttl_ms } : {}),
    }));
  }

  async revoke(accessToken: string, shareId: string): Promise<ConversationShareManagedItem> {
    return this.mutate(accessToken, shareId, (item) => ({ ...item, status: "revoked" }));
  }

  async restore(accessToken: string, shareId: string): Promise<ConversationShareManagedItem> {
    return this.mutate(accessToken, shareId, (item) => ({ ...item, status: "active" }));
  }

  async remove(accessToken: string, shareId: string): Promise<void> {
    this.authorize(accessToken);
    const index = this.items.findIndex((item) => item.share_id === shareId);
    if (index >= 0) this.items.splice(index, 1);
  }

  private mutate(
    accessToken: string,
    shareId: string,
    change: (item: ConversationShareManagedItem) => ConversationShareManagedItem,
  ): ConversationShareManagedItem {
    this.authorize(accessToken);
    const index = this.items.findIndex((item) => item.share_id === shareId);
    if (index < 0) {
      throw new ConversationSharePreviewClientError({
        kind: "not_found",
        message: "Share not found",
        status: 404,
        code: 3211,
      });
    }
    const next = change(this.items[index]!);
    this.items[index] = next;
    return { ...next };
  }

  private authorize(accessToken: string): void {
    if (!accessToken) {
      throw new ConversationSharePreviewClientError({
        kind: "authentication_required",
        message: "Sign in required",
        status: 401,
      });
    }
  }
}
