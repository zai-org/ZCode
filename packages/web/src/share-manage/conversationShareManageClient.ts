import {
  classifyConversationShareError,
  conversationShareCapabilitiesWireSchema,
  conversationShareErrorEnvelopeSchema,
  conversationShareManagedItemSchema,
  conversationShareManagedListSchema,
  conversationShareManagedUpdateRequestSchema,
  conversationShareRequestIdSchema,
  createConversationShareSuccessEnvelopeSchema,
  resolveConversationShareTtlOptions,
  type ConversationShareManagedItem,
  type ConversationShareManagedList,
  type ConversationShareManagedUpdateRequest,
  type ConversationShareTtlOptions,
} from "@zcode/shared";
import { z } from "zod";
import { ConversationSharePreviewClientError } from "../share/conversationSharePreviewClient.js";
import {
  CONVERSATION_SHARE_MANAGE_PAGE_SIZE,
  type ConversationShareManageApi,
} from "./contract.js";

const itemEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationShareManagedItemSchema,
);
const listEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationShareManagedListSchema,
);
// 管理页只用有效期字段；只校验这三项，capabilities 其他字段的演进不影响管理页。
const ttlCapabilitiesEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationShareCapabilitiesWireSchema.pick({
    ttl_ms: true,
    min_ttl_ms: true,
    max_ttl_ms: true,
  }),
);
// DELETE 成功时 data 为 null；只校验信封本身。
const emptyEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(z.unknown());

export class ConversationShareManageClient implements ConversationShareManageApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    // 与 preview client 相同：直接保存 window.fetch 再以实例方法调用会触发 Illegal invocation。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async ttlOptions(accessToken: string): Promise<ConversationShareTtlOptions | undefined> {
    const capabilities = await this.request(
      "/shares/capabilities",
      { method: "GET" },
      accessToken,
      ttlCapabilitiesEnvelopeSchema,
    );
    return resolveConversationShareTtlOptions(capabilities);
  }

  list(accessToken: string, cursor?: string): Promise<ConversationShareManagedList> {
    const query = new URLSearchParams({ limit: String(CONVERSATION_SHARE_MANAGE_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    return this.request(
      `/shares/mine?${query.toString()}`,
      { method: "GET" },
      accessToken,
      listEnvelopeSchema,
    );
  }

  update(
    accessToken: string,
    shareId: string,
    change: ConversationShareManagedUpdateRequest,
  ): Promise<ConversationShareManagedItem> {
    const body = JSON.stringify(conversationShareManagedUpdateRequestSchema.parse(change));
    return this.request(
      `/shares/mine/${encodeURIComponent(shareId)}`,
      { method: "PATCH", body, headers: { "Content-Type": "application/json" } },
      accessToken,
      itemEnvelopeSchema,
    );
  }

  revoke(accessToken: string, shareId: string): Promise<ConversationShareManagedItem> {
    return this.request(
      `/shares/mine/${encodeURIComponent(shareId)}/revoke`,
      { method: "POST" },
      accessToken,
      itemEnvelopeSchema,
    );
  }

  restore(accessToken: string, shareId: string): Promise<ConversationShareManagedItem> {
    return this.request(
      `/shares/mine/${encodeURIComponent(shareId)}/restore`,
      { method: "POST" },
      accessToken,
      itemEnvelopeSchema,
    );
  }

  async remove(accessToken: string, shareId: string): Promise<void> {
    await this.request(
      `/shares/mine/${encodeURIComponent(shareId)}`,
      { method: "DELETE" },
      accessToken,
      emptyEnvelopeSchema,
    );
  }

  private async request<TData>(
    path: string,
    init: RequestInit,
    accessToken: string,
    envelopeSchema: z.ZodType<{ data: TData }>,
  ): Promise<TData> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
      });
    } catch (cause) {
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Unable to reach the sharing service",
        cause,
      });
    }
    const headerId = conversationShareRequestIdSchema.safeParse(
      response.headers.get("x-request-id"),
    );
    const requestId = headerId.success ? headerId.data : undefined;
    let payload: unknown;
    try {
      const text = await response.text();
      payload = text.trim() ? (JSON.parse(text) as unknown) : undefined;
    } catch (cause) {
      throw new ConversationSharePreviewClientError({
        kind: response.ok ? "invalid_contract" : classifyConversationShareError(response.status),
        message: "Sharing service returned invalid JSON",
        status: response.status,
        requestId,
        cause,
      });
    }
    if (!response.ok) {
      const parsedError = conversationShareErrorEnvelopeSchema.safeParse(payload);
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(
          response.status,
          parsedError.success ? parsedError.data.code : undefined,
        ),
        message: parsedError.success ? parsedError.data.msg : "Sharing service request failed",
        status: response.status,
        requestId: requestId ?? (parsedError.success ? parsedError.data.logid : undefined),
        ...(parsedError.success ? { code: parsedError.data.code } : {}),
      });
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Sharing service response does not match the management contract",
        status: response.status,
        requestId,
        cause: parsed.error,
      });
    }
    return parsed.data.data;
  }
}
