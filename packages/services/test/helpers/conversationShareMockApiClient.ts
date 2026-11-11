/* oxlint-disable eslint(max-lines) -- 有状态 Mock 集中模拟 revision 23 六条路由及其共享幂等状态，拆散会隐藏跨路由状态机。 */
/**
 * 分享 API 的有状态测试替身。
 *
 * 只用于测试：让真实的 ConversationShareHttpClient 跑完整
 * preparation → upload → confirm → preview → continuation 时序，并按后端契约
 * 返回文档化的 status/code 组合。运行时一律走真实 API，因此它必须留在 test/ 下，
 * 不能编进 @zcode/services 的发布产物。
 */
import { createHash } from "node:crypto";

import {
  conversationShareArtifactDescriptorSchema,
  conversationShareConfirmRequestSchema,
  conversationShareContinuationRequestSchema,
  conversationSharePreparationRequestSchema,
  type ApiClient,
  type ApiRequestInit,
  type ConversationShareAccessMode,
  type ConversationShareApiErrorCode,
  type ConversationShareArtifactDescriptor,
  type ConversationShareConfirmRequest,
  type ConversationSharePreparationRequest,
  type ConversationShareRecord,
} from "@zcode/shared";

import { buildConversationShareConfirmRequest } from "../../src/conversation-share/conversationShareIntegrity.js";
import { assertConversationSharePublicProjection } from "../../src/conversation-share/conversationSharePublicProjection.js";

type MockRoute =
  | "capabilities"
  | "preparation"
  | "upload"
  | "confirm"
  | "preview"
  | "continuation"
  | "manage";

export interface ConversationShareMockRouteError {
  status: number;
  code?: ConversationShareApiErrorCode;
  msg?: string;
}

export interface ConversationShareMockApiClientOptions {
  contentBlockVersions?: Record<string, number>;
  now?: () => number;
  ttlMs?: number;
  /** 创建者可选的有效期范围；null 模拟未声明范围的旧服务端。默认 1 小时至 30 天。 */
  ttlRange?: { minMs: number; maxMs: number } | null;
  authenticatedToken?: string;
  shareBaseUrl?: string;
  scenario?: Partial<Record<MockRoute, ConversationShareMockRouteError>>;
  confirmSafetyCheckPendingAttempts?: number;
}

interface StoredPreparation {
  preparationId: string;
  ownerToken: string;
  request: ConversationSharePreparationRequest;
  expiresAt: number;
  uploads: Map<string, ConversationShareArtifactDescriptor>;
  safetyCheckPendingResponses: number;
  share?: ConversationShareRecord;
}

/** E2E 预置分享的 owner：匹配任意已登录 token，测试进程不需要知道桌面端 JWT。 */
const ANY_OWNER_TOKEN = "*";
const MANAGE_DEFAULT_LIMIT = 20;

interface StoredShare {
  shareId: string;
  shareCode: string;
  ownerToken: string;
  status: "active" | "revoked";
  sourceSessionId?: string;
  createdAt: number;
  expiresAt: number;
  title: string;
  accessMode: ConversationShareAccessMode;
  artifacts: ConversationShareArtifactDescriptor[];
  request: ConversationShareConfirmRequest;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function success(data: unknown, headers?: ResponseInit["headers"]): Response {
  return new Response(JSON.stringify({ code: 0, msg: "", data }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

function failure(error: ConversationShareMockRouteError): Response {
  if (error.status === 401 && error.code === undefined) {
    return new Response(null, { status: 401 });
  }
  return new Response(
    JSON.stringify({
      code: error.code ?? 3001,
      msg: error.msg ?? "mock request failed",
    }),
    { status: error.status, headers: JSON_HEADERS },
  );
}

function parseBearer(init?: ApiRequestInit): string | null {
  const authorization = new Headers(init?.headers).get("Authorization");
  const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  return match?.[1]?.trim() || null;
}

function parseJsonBody(init?: ApiRequestInit): unknown {
  if (typeof init?.body !== "string") throw new TypeError("Expected a JSON body");
  return JSON.parse(init.body) as unknown;
}

/**
 * 与 revision 23 HTTP 契约一致的有状态内存 Mock。
 *
 * Mock 放在 ApiClient 边界，使上层始终运行真实 HTTP 客户端的鉴权、严格 schema
 * 和错误映射逻辑；切换到后端环境时只需要替换 ApiClient，不需要修改业务流程。
 */
export class ConversationShareMockApiClient implements ApiClient {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly ttlRange: { minMs: number; maxMs: number } | null;
  private readonly shareBaseUrl: string;
  private readonly scenario: Partial<Record<MockRoute, ConversationShareMockRouteError>>;
  private readonly confirmSafetyCheckPendingAttempts: number;
  /** 仅 E2E：下一次管理路由请求返回的一次性失败，消费后清空。 */
  private nextManageFailure: ConversationShareMockRouteError | undefined;
  private readonly preparations = new Map<string, StoredPreparation>();
  private readonly preparationByRequest = new Map<string, StoredPreparation>();
  private readonly shares = new Map<string, StoredShare>();
  private readonly grants = new Map<string, string>();
  private sequence = 0;

  private readonly contentBlockVersions: Record<string, number>;

  constructor(options: ConversationShareMockApiClientOptions = {}) {
    this.contentBlockVersions = options.contentBlockVersions ?? { workflow: 1 };
    const pendingAttempts = options.confirmSafetyCheckPendingAttempts ?? 0;
    if (!Number.isSafeInteger(pendingAttempts) || pendingAttempts < 0) {
      throw new TypeError("confirmSafetyCheckPendingAttempts must be a non-negative integer");
    }
    this.confirmSafetyCheckPendingAttempts = pendingAttempts;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
    this.ttlRange =
      options.ttlRange === undefined
        ? { minMs: 60 * 60 * 1_000, maxMs: 30 * 24 * 60 * 60 * 1_000 }
        : options.ttlRange;
    // Mock 生成的链接必须指向当前可运行的 share 页面；示例域名会让本地发布结果变成不可访问的假链接。
    this.shareBaseUrl = (
      options.shareBaseUrl ??
      process.env.ZCODE_CONVERSATION_SHARE_WEB_URL ??
      "http://127.0.0.1:5173/cn/share"
    ).replace(/\/+$/u, "");
    this.scenario = options.scenario ?? {};
  }

  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/u, "");

    if (path === "/shares/capabilities" && (init?.method ?? "GET") === "GET") {
      return this.route("capabilities", () => this.getCapabilities(init));
    }
    if (path === "/shares/preparations" && init?.method === "POST") {
      return this.route("preparation", () => this.createPreparation(init));
    }

    const upload = /^\/shares\/preparations\/([^/]+)\/artifacts$/u.exec(path);
    if (upload && init?.method === "POST") {
      return this.route("upload", () => this.uploadArtifact(decodeURIComponent(upload[1]!), init));
    }

    const confirm = /^\/shares\/preparations\/([^/]+)\/confirm$/u.exec(path);
    if (confirm && init?.method === "POST") {
      return this.route("confirm", () => this.confirm(decodeURIComponent(confirm[1]!), init));
    }

    const preview = /^\/shares\/([^/]+)\/preview$/u.exec(path);
    if (preview && (init?.method ?? "GET") === "GET") {
      return this.route("preview", () => this.getPreview(decodeURIComponent(preview[1]!), init));
    }

    // 仅 E2E 诊断：列出全部已存储分享的来源会话，便于定位「没有显示跳转」。
    if (path === "/shares/__e2e/managed" && (init?.method ?? "GET") === "GET") {
      return success([...this.shares.values()].map((share) => this.managedItem(share)));
    }
    if (path === "/shares/__e2e/seed-managed" && init?.method === "POST") {
      return this.seedManagedShares(init);
    }
    if (path === "/shares/__e2e/fail-next-manage" && init?.method === "POST") {
      this.nextManageFailure = parseJsonBody(init) as ConversationShareMockRouteError;
      return success(null);
    }
    if (path === "/shares/mine" && (init?.method ?? "GET") === "GET") {
      return this.route("manage", () => this.listManagedShares(url, init));
    }
    const managed = /^\/shares\/mine\/([^/]+?)(?:\/(revoke|restore))?$/u.exec(path);
    if (managed) {
      const shareId = decodeURIComponent(managed[1]!);
      const action = managed[2];
      if (action && init?.method === "POST") {
        return this.route("manage", () =>
          this.setManagedShareStatus(shareId, action === "revoke" ? "revoked" : "active", init),
        );
      }
      if (!action && init?.method === "DELETE") {
        return this.route("manage", () => this.deleteManagedShare(shareId, init));
      }
    }

    const continuation = /^\/shares\/([^/]+)\/continuation$/u.exec(path);
    if (continuation && init?.method === "POST") {
      return this.route("continuation", () =>
        this.getContinuation(decodeURIComponent(continuation[1]!), init),
      );
    }

    return failure({ status: 404, code: 3211, msg: "route not found" });
  }

  private async route(route: MockRoute, handler: () => Promise<Response>): Promise<Response> {
    if (route === "manage" && this.nextManageFailure) {
      const once = this.nextManageFailure;
      this.nextManageFailure = undefined;
      return failure(once);
    }
    const injected = this.scenario[route];
    return injected ? failure(injected) : handler();
  }

  private requireToken(init?: ApiRequestInit): string | Response {
    const token = parseBearer(init);
    return token ?? new Response(null, { status: 401 });
  }

  private async getCapabilities(init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    return success({
      schema_version: 1,
      content_block_versions: this.contentBlockVersions,
      ttl_ms: this.ttlMs,
      ...(this.ttlRange
        ? { min_ttl_ms: this.ttlRange.minMs, max_ttl_ms: this.ttlRange.maxMs }
        : {}),
      access_modes: ["private", "public_readonly", "public_importable"],
      max_rows: 10_000,
      max_payload_bytes: 10 * 1024 * 1024,
      max_artifact_count: 20,
      max_artifact_bytes: 50 * 1024 * 1024,
      max_total_artifact_bytes: 200 * 1024 * 1024,
      allowed_artifacts: [
        { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
        { type: "html", extensions: ["html"], mime_types: ["text/html"] },
        {
          type: "image",
          extensions: ["png", "jpg"],
          mime_types: ["image/png", "image/jpeg"],
        },
        {
          type: "pptx",
          extensions: ["pptx"],
          mime_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        },
        {
          type: "docx",
          extensions: ["docx"],
          mime_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        },
        {
          type: "xlsx",
          extensions: ["xlsx"],
          mime_types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        },
        { type: "md", extensions: ["md"], mime_types: ["text/markdown"] },
      ],
    });
  }

  private async createPreparation(init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;

    const parsed = conversationSharePreparationRequestSchema.safeParse(parseJsonBody(init));
    if (!parsed.success) return failure({ status: 400, code: 3001, msg: "invalid request" });
    // 与服务端一致：超出范围或未声明范围时拒绝，不静默截断。
    const ttl = parsed.data.ttl_ms;
    if (
      ttl !== undefined &&
      (!this.ttlRange || ttl < this.ttlRange.minMs || ttl > this.ttlRange.maxMs)
    ) {
      return failure({ status: 400, code: 3001, msg: "share ttl out of range" });
    }
    const requestKey = `${token}:${parsed.data.client_request_id}`;
    const existing = this.preparationByRequest.get(requestKey);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(parsed.data)) {
        return failure({
          status: 409,
          code: 3001,
          msg: "idempotency key conflict",
        });
      }
      return success(this.preparationData(existing));
    }

    const preparation: StoredPreparation = {
      preparationId: `mock-preparation-${++this.sequence}`,
      ownerToken: token,
      request: parsed.data,
      expiresAt: this.now() + this.ttlMs,
      uploads: new Map(),
      safetyCheckPendingResponses: 0,
    };
    this.preparations.set(preparation.preparationId, preparation);
    this.preparationByRequest.set(requestKey, preparation);
    return success(this.preparationData(preparation));
  }

  private preparationData(preparation: StoredPreparation): Record<string, unknown> {
    return {
      preparation_id: preparation.preparationId,
      status: preparation.share ? "confirmed" : "preparing",
      access_mode: preparation.request.access_mode,
      expires_at: preparation.expiresAt,
      ...(preparation.share ? { share: preparation.share } : {}),
    };
  }

  private async uploadArtifact(preparationId: string, init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    const preparation = this.ownedPreparation(preparationId, token);
    if (preparation instanceof Response) return preparation;
    if (!(init?.body instanceof FormData)) {
      return failure({
        status: 400,
        code: 3001,
        msg: "multipart body required",
      });
    }

    const descriptorValue = init.body.get("descriptor");
    const file = init.body.get("file");
    if (typeof descriptorValue !== "string" || !(file instanceof Blob)) {
      return failure({
        status: 400,
        code: 3001,
        msg: "descriptor and file required",
      });
    }
    let descriptorJson: unknown;
    try {
      descriptorJson = JSON.parse(descriptorValue) as unknown;
    } catch {
      return failure({ status: 400, code: 3001, msg: "invalid descriptor" });
    }
    const parsed = conversationShareArtifactDescriptorSchema.safeParse(descriptorJson);
    if (!parsed.success) return failure({ status: 422, code: 3205, msg: "invalid artifact" });
    // 同一 preparation 内的公开 artifact ID 必须唯一，禁止 Map#set 静默覆盖首次上传。
    if (preparation.uploads.has(parsed.data.artifact_id)) {
      return failure({ status: 409, code: 3210, msg: "share upload incomplete" });
    }
    const sha256 = createHash("sha256")
      .update(Buffer.from(await file.arrayBuffer()))
      .digest("hex");
    if (file.size !== parsed.data.size_bytes || sha256 !== parsed.data.sha256) {
      return failure({
        status: 422,
        code: 3205,
        msg: "artifact digest mismatch",
      });
    }
    preparation.uploads.set(parsed.data.artifact_id, parsed.data);
    return success({
      artifact_id: parsed.data.artifact_id,
      size_bytes: parsed.data.size_bytes,
      sha256,
      status: "uploaded",
      safety_status: "pending",
    });
  }

  private async confirm(preparationId: string, init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    const preparation = this.ownedPreparation(preparationId, token);
    if (preparation instanceof Response) return preparation;

    const parsed = conversationShareConfirmRequestSchema.safeParse(parseJsonBody(init));
    if (!parsed.success) return failure({ status: 400, code: 3001, msg: "invalid request" });
    // Bugfix：只校验 schema/hash 会让 Mock 接受后端必定以 3205 拒绝的本地运行 Row；
    // confirm 必须同时执行公开投影约束，保证联调前能复现真实服务端行为。
    try {
      assertConversationSharePublicProjection({
        rows: parsed.data.projection.rows,
        selectedProductTurnIds: parsed.data.selected_product_turn_ids,
      });
    } catch {
      return failure({
        status: 422,
        code: 3205,
        msg: "invalid shared conversation",
      });
    }
    if (preparation.share) return success(preparation.share);
    const artifacts = [...preparation.uploads.values()].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id),
    );
    if (artifacts.length !== preparation.request.artifact_count) {
      return failure({
        status: 409,
        code: 3210,
        msg: "artifact upload incomplete",
      });
    }

    // Bugfix：revision 23 不再在 confirm 重复发送 preparation 元数据和 artifacts；
    // Mock 必须像后端一样从 preparation/upload 状态重建后再校验摘要。
    const rebuilt = buildConversationShareConfirmRequest({
      selected_product_turn_ids: parsed.data.selected_product_turn_ids,
      projection: parsed.data.projection,
      artifacts,
      disclosure_confirmation: parsed.data.disclosure_confirmation,
    });
    if (
      rebuilt.integrity.content_blocks_sha256 !== parsed.data.integrity.content_blocks_sha256 ||
      rebuilt.integrity.projection_sha256 !== parsed.data.integrity.projection_sha256 ||
      rebuilt.integrity.artifact_set_sha256 !== parsed.data.integrity.artifact_set_sha256
    ) {
      return failure({
        status: 422,
        code: 3205,
        msg: "payload digest mismatch",
      });
    }

    if (preparation.safetyCheckPendingResponses < this.confirmSafetyCheckPendingAttempts) {
      preparation.safetyCheckPendingResponses += 1;
      return failure({
        status: 409,
        code: 3215,
        msg: "share safety check pending",
      });
    }

    const shareCode = `mock-share-${++this.sequence}`;
    // 分享有效期从 confirm 时起算，取 preparation 记录的 ttl_ms，未指定时用默认值。
    const shareExpiresAt = this.now() + (preparation.request.ttl_ms ?? this.ttlMs);
    const record: ConversationShareRecord = {
      share_code: shareCode,
      share_url: `${this.shareBaseUrl}/${encodeURIComponent(shareCode)}`,
      access_mode: preparation.request.access_mode,
      expires_at: shareExpiresAt,
    };
    preparation.share = record;
    this.shares.set(shareCode, {
      shareId: `mock-share-id-${this.sequence}`,
      shareCode,
      ownerToken: token,
      createdAt: this.now(),
      expiresAt: shareExpiresAt,
      title: preparation.request.title,
      accessMode: preparation.request.access_mode,
      status: "active",
      ...(preparation.request.source_session_id
        ? { sourceSessionId: preparation.request.source_session_id }
        : {}),
      artifacts,
      request: parsed.data,
    });
    return success(record);
  }

  private async getPreview(shareCode: string, init?: ApiRequestInit): Promise<Response> {
    const share = this.availableShare(shareCode);
    if (share instanceof Response) return share;
    const token = parseBearer(init);
    if (share.accessMode === "private" && token !== share.ownerToken) {
      return failure({ status: 404, code: 3211, msg: "share not found" });
    }
    return success(
      {
        schema_version: 1,
        share: this.publicMetadata(share),
        rows: share.request.projection.rows,
        ...(share.request.projection.content_blocks
          ? { content_blocks: share.request.projection.content_blocks }
          : {}),
        artifacts: share.artifacts.map((artifact) => ({
          ...artifact,
          url: `${this.shareBaseUrl}/${encodeURIComponent(shareCode)}/artifacts/${encodeURIComponent(artifact.artifact_id)}`,
          url_expires_at: share.expiresAt,
        })),
        integrity: share.request.integrity,
      },
      { "Cache-Control": "no-store" },
    );
  }

  private async getContinuation(shareCode: string, init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    const share = this.availableShare(shareCode);
    if (share instanceof Response) return share;
    const parsed = conversationShareContinuationRequestSchema.safeParse(parseJsonBody(init));
    if (!parsed.success) return failure({ status: 400, code: 3001, msg: "invalid request" });
    if (
      share.accessMode === "public_readonly" ||
      (share.accessMode === "private" && token !== share.ownerToken)
    ) {
      return failure({ status: 403, code: 3214, msg: "import not allowed" });
    }
    const grantKey = `${shareCode}:${token}:${parsed.data.client_request_id}`;
    let grantId = this.grants.get(grantKey);
    if (!grantId) {
      grantId = `mock-import-grant-${++this.sequence}`;
      this.grants.set(grantKey, grantId);
    }
    return success(
      {
        schema_version: 1,
        import_grant_id: grantId,
        import_grant_expires_at: share.expiresAt,
        share: { ...this.publicMetadata(share), share_id: share.shareId },
        rows: share.request.projection.rows,
        ...(share.request.projection.content_blocks
          ? { content_blocks: share.request.projection.content_blocks }
          : {}),
        artifacts: share.artifacts.map((artifact) => ({
          ...artifact,
          download_url: `${this.shareBaseUrl}/${encodeURIComponent(shareCode)}/downloads/${encodeURIComponent(artifact.artifact_id)}`,
          download_url_expires_at: share.expiresAt,
        })),
        integrity: share.request.integrity,
      },
      { "Cache-Control": "no-store" },
    );
  }

  private ownedPreparation(preparationId: string, token: string): StoredPreparation | Response {
    const preparation = this.preparations.get(preparationId);
    if (!preparation || preparation.ownerToken !== token) {
      return failure({ status: 404, code: 3211, msg: "preparation not found" });
    }
    if (this.now() > preparation.expiresAt) {
      return failure({ status: 410, code: 3212, msg: "preparation expired" });
    }
    return preparation;
  }

  private availableShare(shareCode: string): StoredShare | Response {
    const share = this.shares.get(shareCode);
    if (!share) return failure({ status: 404, code: 3211, msg: "share not found" });
    if (this.now() > share.expiresAt) {
      return failure({ status: 410, code: 3212, msg: "share expired" });
    }
    if (share.status === "revoked") {
      return failure({ status: 410, code: 3218, msg: "share revoked" });
    }
    return share;
  }

  private ownsShare(share: StoredShare, token: string): boolean {
    return share.ownerToken === token || share.ownerToken === ANY_OWNER_TOKEN;
  }

  private managedItem(share: StoredShare): Record<string, unknown> {
    return {
      share_id: share.shareId,
      share_code: share.shareCode,
      share_url: `${this.shareBaseUrl}/${encodeURIComponent(share.shareCode)}`,
      title: share.title,
      access_mode: share.accessMode,
      status: share.status,
      created_at: share.createdAt,
      expires_at: share.expiresAt,
      ...(share.sourceSessionId ? { source_session_id: share.sourceSessionId } : {}),
    };
  }

  /** 管理 API：owner 只能看到未过期的 active/revoked 分享，未持有返回 3211。 */
  private ownedManagedShare(shareId: string, token: string): StoredShare | Response {
    const share = [...this.shares.values()].find((item) => item.shareId === shareId);
    if (!share || !this.ownsShare(share, token)) {
      return failure({ status: 404, code: 3211, msg: "share not found" });
    }
    if (this.now() > share.expiresAt) {
      return failure({ status: 410, code: 3212, msg: "share expired" });
    }
    return share;
  }

  private async listManagedShares(url: URL, init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    const limit = Number(url.searchParams.get("limit") ?? MANAGE_DEFAULT_LIMIT);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const owned = [...this.shares.values()]
      .filter((share) => this.ownsShare(share, token) && this.now() <= share.expiresAt)
      .sort((left, right) => right.createdAt - left.createdAt);
    const page = owned.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return success({
      items: page.map((share) => this.managedItem(share)),
      ...(nextOffset < owned.length ? { next_cursor: String(nextOffset) } : {}),
    });
  }

  private async setManagedShareStatus(
    shareId: string,
    status: StoredShare["status"],
    init?: ApiRequestInit,
  ): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    const share = this.ownedManagedShare(shareId, token);
    if (share instanceof Response) return share;
    share.status = status;
    return success(this.managedItem(share));
  }

  private async deleteManagedShare(shareId: string, init?: ApiRequestInit): Promise<Response> {
    const token = this.requireToken(init);
    if (token instanceof Response) return token;
    const share = this.ownedManagedShare(shareId, token);
    if (share instanceof Response) return share;
    this.shares.delete(share.shareCode);
    return success(null);
  }

  /**
   * 仅 E2E：预置不来自本机发布的分享（其他设备的会话、旧版无来源的分享）。
   * owner 为任意 token，返回生成的 share_id 供用例断言。
   */
  private async seedManagedShares(init?: ApiRequestInit): Promise<Response> {
    const body = parseJsonBody(init) as {
      items: Array<{
        title: string;
        accessMode?: ConversationShareAccessMode;
        sourceSessionId?: string;
      }>;
    };
    const created = body.items.map((item) => {
      const shareCode = `mock-share-${++this.sequence}`;
      const share: StoredShare = {
        shareId: `mock-share-id-${this.sequence}`,
        shareCode,
        ownerToken: ANY_OWNER_TOKEN,
        status: "active",
        ...(item.sourceSessionId ? { sourceSessionId: item.sourceSessionId } : {}),
        // 比本机发布更早，列表按创建时间倒序时排在后面。
        createdAt: this.now() - this.sequence * 60_000,
        expiresAt: this.now() + this.ttlMs,
        title: item.title,
        accessMode: item.accessMode ?? "public_readonly",
        artifacts: [],
        request: {} as ConversationShareConfirmRequest,
      };
      this.shares.set(shareCode, share);
      return share.shareId;
    });
    return success({ share_ids: created });
  }

  private publicMetadata(share: StoredShare): Record<string, unknown> {
    return {
      title: share.title,
      access_mode: share.accessMode,
      created_at: share.createdAt,
      expires_at: share.expiresAt,
    };
  }
}
