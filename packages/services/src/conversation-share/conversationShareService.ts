/* oxlint-disable eslint(max-lines) -- 发布、远端 staging、安全轮询和原子导入共享同一 attempt 生命周期，拆分会让清理与进度状态失去单一 owner。 */
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import type {
  ConversationShareArtifactDescriptor,
  ConversationShareCapabilities,
  ConversationShareConfirmRequest,
  ConversationShareContinuation,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import {
  projectShareToolDisplay,
  decodeConversationShareRows,
  supportsConversationShareContent,
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  localizeConversationShareUrl,
  resolveConversationShareTtlOptions,
  resolveRuntimeZCodeEndpointOrigin,
  toZhOrEnLocale,
} from "@zcode/shared";
import {
  isWireConversationRow,
  type ConversationRow,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "@zcode/rpc";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "#src/zcode-session/zcodeSession.js";
import { getConversationWorkspaceDir } from "#src/paths.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type IConversationShareService,
  type PublishTextConversationInput,
  type ConversationSharePublishProgress,
  type ConversationShareImportProgress,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationSharePreflightResult,
  type ConversationShareAllowedArtifact,
  type ConversationShareTurnPreflightResult,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
  type ImportedConversationShare,
} from "./conversationShare.js";
import {
  ConversationShareClientError,
  type ConversationShareHttpClient,
} from "./conversationShareHttpClient.js";
import {
  buildConversationShareArtifactSnapshot,
  getConversationSharePreviewCandidateFingerprint,
  type ConversationSharePreviewPreflightSnapshot,
} from "./conversationShareArtifactDiscovery.js";
import {
  buildConversationShareConfirmRequest,
  sha256ConversationShareJson,
} from "./conversationShareIntegrity.js";
import { materializeConversationShareInlineImages } from "./conversationShareInlineImages.js";
import { buildConversationSharePublicProjection } from "./conversationSharePublicProjection.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import { formatSharedContextV1 } from "./sharedContextFormatter.js";

import {
  collectConversationShareWorkflowSnapshot,
  isWorkflowShareFallbackRow,
  type ShareWorkflowReader,
} from "./conversationShareWorkflowSnapshot.js";

const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONFIRM_POLL_TIMEOUT_MS = 120_000;
// download 兜底不能是裸 fetch（无 AbortSignal/超时）：对象存储连接挂住时导入会停在
// downloading 阶段直到 undici 默认 ~300s 兜底，体验上等于卡死。120s 覆盖慢速下行的大 artifact。
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MISSING_ARTIFACT_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
// 预检快照的兜底上限：单次分享最多写入所选轮次数量的条目，200 足够覆盖正常会话，
// 又能保证长驻 host 不会因为「一直预检、从不发布」而无限增长。
const PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES = 200;
// 预检 stat 的并发上限：本地几乎无差别，SSH/远程 workspace 下每次 stat 都是一次
// 网络往返，串行会让「下一步」长时间停在 checking。上限保证不把远端 host 打爆。
const SHARE_PREFLIGHT_STAT_CONCURRENCY = 6;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 有界并发 map，保持输出与输入同序。
 *
 * 预检的每次 stat 在 SSH/远程 workspace 下都是一次网络往返，串行会让「下一步」
 * 长时间停在 checking。并发上限存在的意义是不把远端 host 打爆；结果按下标回填，
 * 因此 issue 的产生顺序仍然是确定的（与串行实现完全一致）。
 */
const SOURCE_SESSION_ID_MAX_LENGTH = 128;

function sourceSessionIdOf(sessionId: string): { source_session_id: string } | undefined {
  const trimmed = sessionId.trim();
  return trimmed && trimmed.length <= SOURCE_SESSION_ID_MAX_LENGTH
    ? { source_session_id: trimmed }
    : undefined;
}

async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (items.length === 0) return [];
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** stat 的结果或失败原因；并发阶段只收集，分类仍在同序的第二轮里做。 */
type SettledResult<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

async function settle<Value>(run: () => Promise<Value>): Promise<SettledResult<Value>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function isMissingArtifactReadError(error: unknown): boolean {
  return (
    error instanceof ConversationShareServiceError &&
    error.reasonCode === "artifact_read_failed" &&
    typeof error.diagnostics?.errno === "string" &&
    MISSING_ARTIFACT_ERRNOS.has(error.diagnostics.errno)
  );
}

function sanitizeFileSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  return [...value.normalize("NFKC")]
    .map((character) =>
      character.codePointAt(0)! < 32 || forbidden.has(character) ? "-" : character,
    )
    .join("");
}

function uniqueImportedFileName(
  displayName: string,
  artifactId: string,
  usedNames: Set<string>,
): string {
  const base =
    sanitizeFileSegment(basename(displayName.replace(/\\/gu, "/")))
      .replace(/^[. ]+|[. ]+$/gu, "")
      .slice(0, 180) || "artifact";
  let candidate = base;
  if (usedNames.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const suffix = artifactId.replace(/[^A-Za-z0-9]/gu, "").slice(-8) || "artifact";
    candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export interface ConversationShareServiceOptions {
  zcodeAgentService: ConversationShareAgentService;
  client: ConversationShareHttpClient;
  artifactSource: ConversationShareArtifactSource;
  confirmPollIntervalMs?: number;
  confirmPollTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  zcodeSessionService?: Pick<IZCodeSessionService, "createSession" | "listSessions">;
  download?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** 单个 artifact 下载的超时（含读 body）；缺省 120s。 */
  downloadTimeoutMs?: number;
  conversationWorkspaceRoot?: string;
  /** 只由 Desktop Host 注入的 canonical share 页面根地址。 */
  shareWebUrl?: string;
  logger?: ServiceLogger;
}

type ConversationShareAgentService = ShareWorkflowReader &
  Pick<
    IZCodeAgentService,
    | "conversationRowsRangeV4"
    | "conversationFileChangesV4"
    | "conversationAttachmentReadV4"
    | "conversationAttachmentStatV4"
  >;

/** Symbol method 不可由 string-command ProxyChannel 调用，仅供 Desktop Host attachment 装配。 */
export const conversationShareConnectionScopeFactory = Symbol(
  "conversationShareConnectionScopeFactory",
);

const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

function normalizeConversationShareConnectionError(error: unknown): unknown {
  if (error instanceof Error && CONNECTION_UNAVAILABLE_ERRORS.has(error.message)) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation share connection is not ready",
    );
  }
  return error;
}

function workspaceKeyOf(path: string | undefined, identity: string | undefined): string {
  return identity?.trim() || path?.trim() || "__default_conversation_workspace__";
}

function importDedupeKey(shareCode: string, workspaceKey: string): string {
  return `${shareCode}\u0000${workspaceKey}`;
}

function previewPreflightKey(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  productTurnId: string,
): string {
  return [
    workspaceKeyOf(input.workspacePath, input.workspaceIdentity),
    input.remoteSessionId ?? "",
    input.sessionId,
    productTurnId,
  ].join("\u0000");
}

/**
 * 导入会话的标题前缀。services 层没有 intl，这里只维护一份最小映射；
 * 前缀在导入时定型并持久化为 session.title（titleSource: "custom"），之后切界面语言不再改写。
 */
const IMPORTED_SHARE_TITLE_PREFIX: Readonly<Record<"zh-CN" | "en-US", string>> = {
  "zh-CN": "来自分享：",
  "en-US": "From Share: ",
};

function formatImportedShareSessionTitle(shareTitle: string, locale: Locale | undefined): string {
  // 只内置中英前缀：未知语言保持原来的中文默认，ja-JP 等其它语言用英文。
  const prefixLocale = locale === undefined ? "zh-CN" : toZhOrEnLocale(locale);
  return `${IMPORTED_SHARE_TITLE_PREFIX[prefixLocale]}${shareTitle.trim()}`;
}

function localizePublishedShare(
  share: ConversationShareRecord,
  locale: Locale | undefined,
): ConversationShareRecord {
  if (!locale) return share;
  const shareUrl = localizeConversationShareUrl(share.share_url, locale);
  return shareUrl === share.share_url ? share : { ...share, share_url: shareUrl };
}

/** 本端产出的只读副本格式版本；与 wire 的 schema_version 各自独立演进。 */
const IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION = 1;

/**
 * 落盘的只读副本形状；来自磁盘，渲染前必须校验。
 *
 * formatVersion 与 rows 都刻意宽容：用户在新版导入过会话后回退到旧版时，只读块应该尽量
 * 显示出来（认不出的行跳过 + 顶部软提示），而不是整块静默消失让人以为内容丢了。
 */
const importedConversationShareFileSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    shareId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    title: z.string(),
    rows: z.array(z.unknown()),
    content_blocks: z.array(z.unknown()).optional(),
    artifacts: z.array(
      z.object({
        artifactId: z.string().trim().min(1),
        displayName: z.string(),
        mimeType: z.string().optional(),
        workspaceRelativePath: z.string().optional(),
      }),
    ),
  })
  .strip();

interface ConversationRowsRead {
  rows: WireConversationRow[];
  revision: number;
  logEpoch: string;
}

function turnOrdinalByProductTurn(rows: readonly WireConversationRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId || result.has(row.productTurnId)) continue;
    result.set(row.productTurnId, result.size + 1);
  }
  return result;
}

function rowTurnOrdinal(
  row: WireConversationRow,
  ordinals: Map<string, number>,
): number | undefined {
  return row.productTurnId ? ordinals.get(row.productTurnId) : undefined;
}

function hasUnsupportedArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return /^zcode-artifact:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedArtifactReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsupportedArtifactReference(entry),
  );
}

/**
 * V1 公开投影承载不了的已定稿内部结构静默移除：删掉不能公开的字段或整行，保留该轮其余
 * 内容，让发布不再被整体打死，也不把内部渲染结构暴露成用户错误。
 *
 * 只降级「已定稿但无法承载」的内容；运行中的轮次/行/工具/子代理仍由
 * collectShareStructureIssues 阻断 —— 那些内容尚未定稿，跳过等于分享半成品。
 */
function sanitizeUnsupportedShareStructures(
  rows: readonly WireConversationRow[],
): WireConversationRow[] {
  const sanitized: WireConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "timelineMarker") {
      // 运行中的 marker 留着，让 collectShareStructureIssues 照旧阻断——内容尚未定稿。
      // 被阻断的发布不会进入投影，保留该 marker 无副作用。
      const markerRunning =
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running");
      if (markerRunning) {
        sanitized.push(row);
        continue;
      }
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        // 分支/回滚 marker 只携带本地会话关系，公开页本来就不渲染；直接移除，不能把
        // 内部时间线结构计入“文件被跳过”或打扰用户。
        continue;
      }
      // 其余 marker 静默剥掉，不打扰分享者：
      // - compact（上下文已压缩）纯运行时记账，对只读读者没有价值；而且它的 lane 是
      //   assistantWork，留在 flow 尾部会顶掉「最终正文」折叠锚点，让整轮过程默认展开
      //   （conversationTurnWorkSegments.ts 的 assistantHistoryDefaultOpen）——这是它必须走的主因。
      // - goalVerify / goalSet / retryNotice 在分享页本来就不渲染，纯占位吃 max_rows 配额。
      // - modelChange 只能显示一句泛化的「模型已切换」，信息量低且暴露内部切模型行为。
      continue;
    }
    if (row.kind === "toolCall" && row.toolName === "EnterPlanMode") {
      // EnterPlanMode 只是内部模式切换边界，渲染层（isVisibleAssistantWorkRow）本来就过滤掉，
      // 但它仍会进 payload 白吃 max_rows / max_payload_bytes 配额，永远不显示。
      continue;
    }
    sanitized.push(row);
  }
  return sanitized;
}

function sanitizeUnsupportedShareArtifacts(
  rows: readonly WireConversationRow[],
  capabilities: ConversationShareCapabilities,
  ordinalRows: readonly WireConversationRow[],
): { rows: WireConversationRow[]; warnings: ConversationShareFailureIssue[] } {
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const warnings: ConversationShareFailureIssue[] = [];
  const retained = rows.filter((row) => {
    if (row.kind !== "artifact") return true;
    const extension = fileExtension(row.displayName);
    const mimeType = normalizedMimeType(row.mimeType);
    const allowed = capabilities.allowed_artifacts.find(
      (candidate) =>
        candidate.type === row.artifactType &&
        candidate.extensions.some(
          (value) => value.replace(/^\./u, "").toLowerCase() === extension,
        ) &&
        candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
    );
    if (allowed) return true;
    warnings.push({
      code: "artifact_type_not_allowed",
      scope: "artifact",
      rowId: row.rowId,
      ...(row.productTurnId && ordinals.has(row.productTurnId)
        ? { turnOrdinal: ordinals.get(row.productTurnId) }
        : {}),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
      artifactDisplayName: row.displayName,
      artifactType: row.artifactType,
      ...(extension ? { extension } : {}),
      mimeType,
      allowedFormats: allowedFormatLabels(capabilities),
      allowedArtifacts: allowedArtifactSummaries(capabilities),
    });
    return false;
  });
  return { rows: retained, warnings };
}

function collectShareStructureIssues(
  rows: readonly WireConversationRow[],
  ordinalRows: readonly WireConversationRow[] = rows,
): ConversationShareFailureIssue[] {
  const issues: ConversationShareFailureIssue[] = [];
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const add = (row: WireConversationRow, code: ConversationShareFailureIssue["code"]) => {
    issues.push({
      code,
      scope: code === "missing_product_turn" ? "conversation" : "turn",
      ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
      ...(rowTurnOrdinal(row, ordinals) === undefined
        ? {}
        : { turnOrdinal: rowTurnOrdinal(row, ordinals) }),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
    });
  };
  for (const row of rows) {
    if (!row.productTurnId) add(row, "missing_product_turn");
    if (row.kind === "turnHeader" && row.state === "running") add(row, "running_turn");
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      add(row, "streaming_row");
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    ) {
      add(row, "active_tool_call");
    }
    if (row.kind === "subagent" && row.status === "running") add(row, "active_subagent");
    if (row.kind === "timelineMarker") {
      // 只有「运行中」的时间线操作仍阻断；fork/checkpoint/compact summaryRef 已由
      // sanitizeUnsupportedShareStructures 降级为跳过。
      if (
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")
      ) {
        add(row, "unsupported_timeline");
      }
    }
    if (hasUnsupportedArtifactReference(row)) add(row, "artifact_protocol_not_ready");
  }
  return issues;
}

function allowedFormatLabels(capabilities: ConversationShareCapabilities): string[] {
  return capabilities.allowed_artifacts.flatMap((allowed) =>
    allowed.extensions.map(
      (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
    ),
  );
}

function allowedArtifactSummaries(
  capabilities: ConversationShareCapabilities,
): ConversationShareAllowedArtifact[] {
  return capabilities.allowed_artifacts.map((allowed) => ({
    type: allowed.type,
    extensions: [...allowed.extensions],
    mimeTypes: [...allowed.mime_types],
  }));
}

function capabilitiesFingerprint(capabilities: ConversationShareCapabilities): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}

function fileExtension(fileName: string): string | undefined {
  const baseName = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : undefined;
}

function normalizedMimeType(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function attachmentDisplayName(fileName: string): string {
  return basename(fileName.replace(/\\/gu, "/")) || "附件";
}

function allowedArtifactFor(
  capabilities: ConversationShareCapabilities,
  extension: string | undefined,
  mimeType: string,
) {
  if (!extension) return undefined;
  return capabilities.allowed_artifacts.find(
    (allowed) =>
      allowed.extensions.some((value) => value.replace(/^\./u, "").toLowerCase() === extension) &&
      allowed.mime_types.some((value) => value.toLowerCase() === mimeType),
  );
}

/**
 * 附件错误分类统一走协议侧稳定 fault 码（见 attachment-faults.ts）。
 *
 * 不能按 `error.message` 正则分类：RPC 包装/schema 校验一变就失效——
 * 超大附件的 ZodError 曾因此被误判成「未知」并降级成 deferred，静默丢内容。
 * 仅在 fault 码缺席时保留一条 errno 文本兜底，用于尚未带结构化码的旧 zcode-cli。
 */
function isDefiniteMissingAttachment(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found|not_found|statNotFile|is_directory/iu.test(message);
}

function isAttachmentAuthorizationError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /shareStatNotAuthorized|shareReadNotAuthorized|connectionUntrusted/iu.test(message);
}

/** 附件体积超出协议/通道可承载范围：选择阶段就应作为确定阻断呈现。 */
function isAttachmentTooLargeError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  return (
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge ||
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge
  );
}

function buildTurnPreflightResults(
  productTurnIds: readonly string[],
  turnOrdinalByProductTurnId: ReadonlyMap<string, number>,
  blockingIssues: readonly ConversationShareFailureIssue[],
  skippableWarnings: readonly ConversationShareFailureIssue[],
  deferredIssues: readonly ConversationShareFailureIssue[],
): ConversationShareTurnPreflightResult[] {
  return productTurnIds.map((productTurnId) => {
    const turnOrdinal = turnOrdinalByProductTurnId.get(productTurnId);
    const forTurn = (issues: readonly ConversationShareFailureIssue[]) =>
      issues.filter(
        (issue) =>
          issue.turnOrdinal === turnOrdinal ||
          (issue.turnOrdinal === undefined &&
            issue.rowId === undefined &&
            issue.artifactDisplayName === undefined &&
            (issue.scope === "conversation" || issue.scope === "transport")),
      );
    return {
      productTurnId,
      blockingIssues: forTurn(blockingIssues),
      skippableWarnings: forTurn(skippableWarnings),
      deferredIssues: forTurn(deferredIssues),
    };
  });
}

function removeIndependentArtifactRows(
  rows: readonly WireConversationRow[],
): WireConversationRow[] {
  // 文件候选来自用户输入附件和最终可见的 Assistant 预览卡片；内嵌图片随后独立转换。历史 artifact row
  // 若没有对应预览卡片，不再作为第三条独立发现来源进入公开 projection。
  return rows.filter((row) => row.kind !== "artifact");
}

function throwServiceError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
): never {
  throw new ConversationShareServiceError(kind, message);
}

function selectRows(
  rows: WireConversationRow[],
  selection: PublishTextConversationInput["selection"],
): { rows: WireConversationRow[]; productTurnIds: string[] } {
  let selectedProductTurnIds: Set<string>;
  if (selection.kind === "all") {
    selectedProductTurnIds = new Set(
      rows
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.productTurnId)
        .filter((value): value is string => value !== undefined),
    );
  } else if (selection.kind === "productTurns") {
    if (selection.productTurnIds.length === 0) {
      throwServiceError("invalid_selection", "At least one product turn must be selected");
    }
    selectedProductTurnIds = new Set(selection.productTurnIds);
  } else {
    if (selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    selectedProductTurnIds = new Set<string>();
    for (const rowId of new Set(selection.rowIds)) {
      const row = rowsById.get(rowId);
      if (!row?.productTurnId) {
        throwServiceError("invalid_selection", "A selected row no longer exists");
      }
      selectedProductTurnIds.add(row.productTurnId);
    }
  }

  const orderedProductTurnIds: string[] = [];
  const headerCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId) continue;
    headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
    if (selectedProductTurnIds.has(row.productTurnId)) {
      orderedProductTurnIds.push(row.productTurnId);
    }
  }
  if (
    orderedProductTurnIds.length === 0 ||
    orderedProductTurnIds.length !== selectedProductTurnIds.size ||
    orderedProductTurnIds.some((productTurnId) => headerCounts.get(productTurnId) !== 1)
  ) {
    throwServiceError("invalid_selection", "Selected product turns are incomplete or ambiguous");
  }

  const selectedTurnIds = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turnHeader" &&
          row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId),
      )
      .map((row) => row.turnId),
  );

  return {
    productTurnIds: orderedProductTurnIds,
    // 旧投影可能缺 productTurnId；只要 turnId 落在已选轮次也必须保留，让校验显式拒绝，
    // 不能在过滤时静默丢行后发布一份不完整会话。
    rows: rows.filter(
      (row) =>
        (row.productTurnId !== undefined && selectedProductTurnIds.has(row.productTurnId)) ||
        (row.productTurnId === undefined && selectedTurnIds.has(row.turnId)),
    ),
  };
}

export class ConversationShareService implements IConversationShareService {
  private readonly zcodeAgentService: ConversationShareAgentService;
  private readonly client: ConversationShareHttpClient;
  private readonly artifactSource: ConversationShareArtifactSource;
  private readonly confirmPollIntervalMs: number;
  private readonly confirmPollTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly progressEmitters = new Map<string, Emitter<ConversationSharePublishProgress>>();
  private readonly importProgressEmitters = new Map<
    string,
    Emitter<ConversationShareImportProgress>
  >();
  private readonly zcodeSessionService?: Pick<
    IZCodeSessionService,
    "createSession" | "listSessions"
  >;
  private readonly download: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  private readonly downloadTimeoutMs: number;
  private readonly conversationWorkspaceRoot: string;
  private readonly shareWebUrl: string;
  private readonly importIndexPath: string;
  private readonly logger: ServiceLogger;
  private readonly publishPhases = new Map<string, ConversationSharePublishProgress["phase"]>();
  // 选择阶段与发布阶段共享“最终可见卡片”边界；发布仍会重新 stat/read，但不会重新
  // 纳入选择阶段已经因缺失而被 UI 隐藏的候选。
  //
  // 生命周期：desktop host 是长驻进程，这张表原来只在 stat 未 settle 时删单条，
  // 会随使用时长单调增长。现在有两道回收：发布终态按 session 前缀清理，
  // 以及 set 时的 FIFO 上限兜底（覆盖用户中途放弃分享、永远不发布的路径）。
  private readonly previewPreflightSnapshots = new Map<
    string,
    ConversationSharePreviewPreflightSnapshot
  >();
  private readonly completedImports = new Map<string, ImportConversationShareResult>();
  private readonly completedImportsByWorkspace = new Map<string, ImportConversationShareResult>();
  private readonly inFlightImports = new Map<string, Promise<ImportConversationShareResult>>();
  private readonly inFlightImportsByWorkspace = new Map<
    string,
    Promise<ImportConversationShareResult>
  >();
  private completedImportsLoaded!: Promise<void>;
  private importIndexWriteChain: Promise<void> = Promise.resolve();

  constructor(options: ConversationShareServiceOptions) {
    this.zcodeAgentService = options.zcodeAgentService;
    this.client = options.client;
    this.artifactSource = options.artifactSource;
    this.confirmPollIntervalMs = options.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS;
    this.confirmPollTimeoutMs = options.confirmPollTimeoutMs ?? DEFAULT_CONFIRM_POLL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
    this.zcodeSessionService = options.zcodeSessionService;
    this.download = options.download ?? ((url, init) => fetch(url, { signal: init?.signal }));
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.conversationWorkspaceRoot =
      options.conversationWorkspaceRoot ?? getConversationWorkspaceDir();
    // 兜底写死生产站 https://zcode.z.ai/cn/share，于是测试环境（API base 走
    // 配置的 ZCode origin）导入后回链仍指向生产站，点分割线打开的是另一个环境的分享。
    // 改用与 API base 同一个环境解析器（buildRuntimeZCodeApiUrl 也走它），保证同环境。
    // 优先级不变：显式 option > ZCODE_CONVERSATION_SHARE_WEB_URL > 按环境推导。
    this.shareWebUrl = (
      options.shareWebUrl ??
      process.env.ZCODE_CONVERSATION_SHARE_WEB_URL ??
      `${resolveRuntimeZCodeEndpointOrigin(process.env)}/cn/share`
    ).replace(/\/+$/u, "");
    this.importIndexPath = join(this.conversationWorkspaceRoot, ".zcode-share-imports.json");
    this.logger = options.logger ?? createServiceLogger("conversation-share");
    this.completedImportsLoaded = this.loadCompletedImportIndex();
    if (this.zcodeSessionService) {
      void this.cleanupAbandonedImports().catch(() => undefined);
    }
  }

  getCapabilities() {
    return this.client.getCapabilities();
  }

  /** 写入预检快照，并在超过上限时按插入序淘汰最旧条目（Map 保持插入序）。 */
  private setPreviewPreflightSnapshot(
    key: string,
    snapshot: ConversationSharePreviewPreflightSnapshot,
  ): void {
    // 重新写同一 key 时先删再插，让它回到插入序末尾，淘汰才是真正的「最久未更新」。
    this.previewPreflightSnapshots.delete(key);
    this.previewPreflightSnapshots.set(key, snapshot);
    while (this.previewPreflightSnapshots.size > PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES) {
      const oldestKey = this.previewPreflightSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.previewPreflightSnapshots.delete(oldestKey);
    }
  }

  /** 分享结束后回收该 workspace+session 的全部预检快照。 */
  private clearPreviewPreflightSnapshots(
    input: Pick<
      PublishTextConversationInput | ConversationSharePreflightInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
  ): void {
    const prefix = previewPreflightKey(input, "");
    for (const key of this.previewPreflightSnapshots.keys()) {
      if (key.startsWith(prefix)) this.previewPreflightSnapshots.delete(key);
    }
  }

  async preflight(
    input: ConversationSharePreflightInput,
  ): Promise<ConversationSharePreflightResult> {
    try {
      return await this.preflightWithAgent(input, this.zcodeAgentService);
    } catch (error) {
      throw normalizeConversationShareConnectionError(error);
    }
  }

  private async preflightWithAgent(
    input: ConversationSharePreflightInput,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationSharePreflightResult> {
    const capabilities = await this.client.getCapabilities();
    const supportedArtifactTypes = allowedArtifactSummaries(capabilities);
    const ttlOptions = resolveConversationShareTtlOptions(capabilities);
    const conversation = await this.loadAllRows(input, agentService);
    const blockingIssues: ConversationShareFailureIssue[] = [];
    const skippableWarnings: ConversationShareFailureIssue[] = [];
    const deferredIssues: ConversationShareFailureIssue[] = [];

    let selected: { rows: WireConversationRow[]; productTurnIds: string[] };
    try {
      selected = selectRows(conversation.rows, input.selection);
    } catch (error) {
      if (error instanceof ConversationShareServiceError) {
        blockingIssues.push({
          code: "invalid_selection",
          scope: "conversation",
        });
      } else {
        throw error;
      }
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues,
        skippableWarnings,
        deferredIssues,
        supportedArtifactTypes,
        ...(ttlOptions ? { ttlOptions } : {}),
        turnResults: [],
      };
    }

    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurn(conversation.rows),
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: this.now(),
      preflight: true,
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(draft.productTurnId),
              },
            ]
          : [],
    );
    skippableWarnings.push(
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    );
    blockingIssues.push(...collectShareStructureIssues(selectedRows, conversation.rows));
    let hasShareableContent = selectedRows.some((row) => {
      if (row.kind === "turnHeader" || row.kind === "timelineMarker") return false;
      if (row.kind === "assistantText" || row.kind === "reasoning")
        return row.text.trim().length > 0;
      if (row.kind === "userInput") return row.text.trim().length > 0;
      if (row.kind === "toolCall") {
        return Boolean(
          row.inputText?.trim() || row.output?.text?.trim() || row.error?.message?.trim(),
        );
      }
      return true;
    });

    const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(conversation.rows);
    // 先把需要 stat 的附件收集齐，再有界并发跑，最后按原顺序分类。
    // 拆成两轮是为了在拿到远程并发收益的同时，让 issue 的产生顺序与串行实现一致。
    const attachmentChecks: {
      row: Extract<WireConversationRow, { kind: "userInput" }> & {
        entityId: string;
      };
      attachmentIndex: number;
      attachment: NonNullable<
        Extract<WireConversationRow, { kind: "userInput" }>["attachments"]
      >[number];
      allowed: ReturnType<typeof allowedArtifactFor>;
      baseIssue: Omit<ConversationShareFailureIssue, "code">;
    }[] = [];
    for (const row of selectedRows) {
      if (row.kind !== "userInput" || !row.attachments) continue;
      for (const [attachmentIndex, attachment] of row.attachments.entries()) {
        const extension = fileExtension(attachment.fileName);
        const mimeType = normalizedMimeType(attachment.mime);
        const allowed = allowedArtifactFor(capabilities, extension, mimeType);
        const baseIssue = {
          scope: "artifact" as const,
          rowId: row.rowId,
          ...(row.productTurnId && turnOrdinalByProductTurnId.has(row.productTurnId)
            ? { turnOrdinal: turnOrdinalByProductTurnId.get(row.productTurnId) }
            : {}),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
          ...(extension ? { extension } : {}),
          mimeType,
          ...(allowed ? { artifactType: allowed.type } : { artifactType: extension ?? "unknown" }),
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Partial<ConversationShareFailureIssue>;
        if (!row.entityId) {
          blockingIssues.push({
            code: "input_attachment",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
          continue;
        }
        attachmentChecks.push({
          row: { ...row, entityId: row.entityId },
          attachmentIndex,
          attachment,
          allowed,
          baseIssue,
        });
      }
    }
    const attachmentStats = await mapWithConcurrency(
      attachmentChecks,
      SHARE_PREFLIGHT_STAT_CONCURRENCY,
      (check) =>
        settle(() =>
          agentService.conversationAttachmentStatV4({
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            sessionId: input.sessionId,
            target: { rowId: check.row.rowId, entityId: check.row.entityId },
            attachmentIndex: check.attachmentIndex,
            ref: check.attachment.ref,
          }),
        ),
    );
    for (const [checkIndex, check] of attachmentChecks.entries()) {
      const { row, attachment, allowed, baseIssue } = check;
      const settled = attachmentStats[checkIndex]!;
      if (settled.ok) {
        const stat = settled.value;
        if (!allowed) {
          // 即使类型不支持，也必须先完成选择阶段存在性检查；只有存在的附件才展示
          // artifact_type_not_allowed，避免把已经清理的附件误报成能力问题。
          //
          // 类型判定必须排在体积判定之前：不支持的类型根本不会被上传，它的体积
          // 与分享无关。反过来会把「格式不支持（可跳过）」升级成「体积超限（阻断）」，
          // 用户被一个压缩也解决不了的错误挡住。
          skippableWarnings.push({
            code: "artifact_type_not_allowed",
            ...baseIssue,
          });
        } else if (stat.totalBytes > capabilities.max_artifact_bytes) {
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            actual: stat.totalBytes,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (attachment.bytes > 0 && stat.totalBytes !== attachment.bytes) {
          skippableWarnings.push({
            code: "artifact_changed",
            ...baseIssue,
            availability: "changed",
          });
        } else {
          hasShareableContent = true;
        }
      } else {
        const error = settled.error;
        if (isAttachmentAuthorizationError(error)) {
          blockingIssues.push({
            code: "artifact_protocol_not_ready",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
        } else if (isAttachmentTooLargeError(error)) {
          // 附件大到连 stat 都无法表达时，仍然是「已知容量超限」这一确定阻断，
          // 绝不能降级成 deferred —— 那会让发布悄悄丢掉这个附件。
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (isDefiniteMissingAttachment(error)) {
          skippableWarnings.push({
            code: "input_attachment_unavailable",
            ...baseIssue,
            availability: "not_found",
          });
        } else {
          hasShareableContent = true;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...baseIssue,
            availability: "unknown",
          });
        }
      }
    }

    if (!hasShareableContent) {
      blockingIssues.push({
        code: "no_shareable_content",
        scope: "conversation",
      });
    }

    if (blockingIssues.length > 0) {
      const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
      const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
      const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues: sanitizedBlockingIssues.issues,
        skippableWarnings: sanitizedWarnings.issues,
        deferredIssues: sanitizedDeferred.issues,
        supportedArtifactTypes,
        ...(ttlOptions ? { ttlOptions } : {}),
        turnResults: buildTurnPreflightResults(
          selected.productTurnIds,
          turnOrdinalByProductTurnId,
          sanitizedBlockingIssues.issues,
          sanitizedWarnings.issues,
          sanitizedDeferred.issues,
        ),
      };
    }

    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    if (registeredProjection.rows.length > capabilities.max_rows) {
      blockingIssues.push({
        code: "rows_limit",
        scope: "conversation",
        actual: registeredProjection.rows.length,
        limit: capabilities.max_rows,
      });
    }
    const manifestIssues = this.collectArtifactManifestIssues(
      capabilities,
      registeredProjection.artifacts,
    ).map((issue) => {
      // 内嵌图片的容量问题必须带轮次定位，否则拆分 turn 缓存时会漏掉文件级阻断。
      const row = selectedRows.find(
        (candidate) =>
          candidate.kind === "artifact" && candidate.displayName === issue.artifactDisplayName,
      );
      return row
        ? {
            ...issue,
            rowId: row.rowId,
            productTurnId: row.productTurnId,
            turnOrdinal: rowTurnOrdinal(row, turnOrdinalByProductTurnId),
          }
        : issue;
    });
    blockingIssues.push(
      ...manifestIssues.filter((issue) => issue.code !== "artifact_type_not_allowed"),
    );
    skippableWarnings.push(
      ...manifestIssues.filter((issue) => issue.code === "artifact_type_not_allowed"),
    );

    const headersByProductTurnId = new Map<
      string,
      Extract<WireConversationRow, { kind: "turnHeader" }>
    >();
    const assistantTextByProductTurnId = new Map<string, string[]>();
    for (const row of selectedRows) {
      if (row.kind === "turnHeader" && row.productTurnId) {
        headersByProductTurnId.set(row.productTurnId, row);
      }
      if (row.kind === "assistantText" && row.productTurnId && !isWorkflowShareFallbackRow(row)) {
        const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
        texts.push(row.text);
        assistantTextByProductTurnId.set(row.productTurnId, texts);
      }
    }

    for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
      const header = headersByProductTurnId.get(productTurnId);
      if (!header) continue;
      const assistantText = textParts.join("\n\n");
      const references = extractConversationPreviewFileReferences(
        assistantText,
        input.workspacePath,
      );
      const needsFileChanges = references.some(
        (reference) => reference.kind === "markdown" || reference.kind === "html",
      );
      let fileChanges: Array<{ path: string; state: "active" | "reverted" }> | undefined;
      if (needsFileChanges && header.fileChanges?.state !== "reverted") {
        if (!header.entityId) {
          deferredIssues.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            productTurnId,
            availability: "unknown",
          });
          continue;
        }
        const result = await agentService.conversationFileChangesV4({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          sessionId: input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: conversation.revision,
          baseLogEpoch: conversation.logEpoch,
        });
        fileChanges = result.items.map((item) => ({
          path: item.path,
          state: result.state === "reverted" ? ("reverted" as const) : ("active" as const),
        }));
      }

      const candidates = buildConversationPreviewArtifactCandidates({
        assistantText,
        productTurnId,
        workspacePath: input.workspacePath,
        fileChanges,
      });
      const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
      const previewCanonicalPaths = new Set<string>();
      let previewStatSettled = this.artifactSource.stat !== undefined;
      // stat 并发发起，判定仍按候选原顺序进行：去重和可见卡片上限都依赖顺序，
      // 而每次 stat 在远程 workspace 下都是一次往返。
      const artifactSourceStat = this.artifactSource.stat;
      const candidateStats = artifactSourceStat
        ? await mapWithConcurrency(candidates, SHARE_PREFLIGHT_STAT_CONCURRENCY, (candidate) =>
            settle(() =>
              artifactSourceStat({
                workspacePath: input.workspacePath,
                ref: candidate.sourceRef,
              }),
            ),
          )
        : [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;

        // 先检查候选上限内的全部路径，再从存在的路径里取 UI 同样的可见卡片上限。
        // 这样不会因为前面几个文件存在就漏掉后续候选的存在性检查。
        const settled = candidateStats[candidateIndex];
        if (!settled) {
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (settled.ok) {
          if (previewCanonicalPaths.has(settled.value.canonicalPath)) continue;
          previewCanonicalPaths.add(settled.value.canonicalPath);
        } else {
          if (isMissingArtifactReadError(settled.error)) {
            // Assistant 预览文件已不存在时，UI 也不会显示这张卡片，因此不产生 Share warning。
            continue;
          }
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
          visibleCandidates.push(candidate);
        }
      }

      for (const candidate of visibleCandidates) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;
        const allowed =
          candidate.previewKind === "video" || candidate.previewKind === "audio"
            ? undefined
            : allowedArtifactFor(
                capabilities,
                fileExtension(candidate.displayName),
                candidate.mimeType,
              );
        if (!allowed) {
          skippableWarnings.push({ code: "artifact_type_not_allowed", ...issue });
        }
      }
      const snapshotKey = previewPreflightKey(input, productTurnId);
      if (previewStatSettled) {
        this.setPreviewPreflightSnapshot(snapshotKey, {
          revision: conversation.revision,
          logEpoch: conversation.logEpoch,
          capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
          candidateFingerprint: getConversationSharePreviewCandidateFingerprint(candidates),
          visibleSourceRefs: visibleCandidates.map((candidate) => candidate.sourceRef),
        });
      } else {
        this.previewPreflightSnapshots.delete(snapshotKey);
      }
    }

    const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
    const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
    const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
    return {
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
      blockingIssues: sanitizedBlockingIssues.issues,
      skippableWarnings: sanitizedWarnings.issues,
      deferredIssues: sanitizedDeferred.issues,
      supportedArtifactTypes,
      ...(ttlOptions ? { ttlOptions } : {}),
      turnResults: buildTurnPreflightResults(
        selected.productTurnIds,
        turnOrdinalByProductTurnId,
        sanitizedBlockingIssues.issues,
        sanitizedWarnings.issues,
        sanitizedDeferred.issues,
      ).map((result) => ({
        ...result,
        rowBudget: {
          count: registeredProjection.rows.filter(
            (row) =>
              row.productTurnId ===
              registeredProjection.selectedProductTurnIds[
                selected.productTurnIds.indexOf(result.productTurnId)
              ],
          ).length,
          limit: capabilities.max_rows,
        },
      })),
    };
  }

  getPreview(shareCode: string) {
    return this.client.getPreview(shareCode);
  }

  getContinuation(input: { shareCode: string; clientRequestId: string }) {
    return this.client.getContinuation(input.shareCode, {
      schema_version: 1,
      client_request_id: input.clientRequestId,
    });
  }

  listManagedShares(input: { cursor?: string }) {
    return this.client.listManagedShares(input.cursor);
  }

  revokeManagedShare(shareId: string) {
    return this.client.revokeManagedShare(shareId);
  }

  restoreManagedShare(shareId: string) {
    return this.client.restoreManagedShare(shareId);
  }

  deleteManagedShare(shareId: string) {
    return this.client.deleteManagedShare(shareId);
  }

  /** Host attachment 内部 facade：复用同一业务 service，只替换 V4 Rows/File 查询的可信 Agent scope。 */
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService {
    return {
      getCapabilities: () => this.getCapabilities(),
      preflight: async (input) => {
        try {
          return await this.preflightWithAgent(input, agentService);
        } catch (error) {
          throw normalizeConversationShareConnectionError(error);
        }
      },
      publish: (input, operationId) => this.publishWithAgent(input, operationId, agentService),
      onDynamicPublishProgress: (operationId) => this.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => this.importShare(input, operationId),
      onDynamicImportProgress: (operationId) => this.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => this.getImportedConversation(input),
      getPreview: (shareCode) => this.getPreview(shareCode),
      getContinuation: (input) => this.getContinuation(input),
      listManagedShares: (input) => this.listManagedShares(input),
      revokeManagedShare: (shareId) => this.revokeManagedShare(shareId),
      restoreManagedShare: (shareId) => this.restoreManagedShare(shareId),
      deleteManagedShare: (shareId) => this.deleteManagedShare(shareId),
    };
  }

  onDynamicPublishProgress(operationId: string) {
    return this.getProgressEmitter(operationId).event;
  }

  onDynamicImportProgress(operationId: string) {
    return this.getImportProgressEmitter(operationId).event;
  }

  /**
   * 下载单个 artifact 的字节：带单请求超时（含读 body）与 Content-Length 预检。
   *
   * download 兜底不能是裸 fetch（无 AbortSignal），且 size/SHA-256 校验不能在
   * arrayBuffer() 之后才执行——挂住的连接会让导入无限停在 downloading 阶段（undici 默认
   * ~300s 兜底，体验上等于卡死）；被篡改的存储还能让客户端先把超大 payload 全量读进内存
   * 再发现不符。超时按 network 失败；Content-Length 声明超过 manifest 的 size_bytes 时
   * 在读 body 前直接判 integrity 失败并中断连接——完整性校验放在无界下载之后只保证
   * 正确性，不保护客户端资源。
   */
  private async downloadArtifactBytes(
    artifact: ConversationShareContinuation["artifacts"][number],
  ): Promise<{ bytes: Uint8Array; responseMimeType?: string }> {
    const artifactIssue = (
      code: ConversationShareFailureIssue["code"],
      extra?: { actual?: number; limit?: number },
    ): ConversationShareFailureIssue => ({
      code,
      scope: "artifact",
      artifactDisplayName: artifact.display_name,
      artifactType: artifact.artifact_type,
      extension: artifact.extension,
      mimeType: artifact.mime_type,
      phase: "downloading",
      ...(extra?.actual === undefined ? {} : { actual: extra.actual }),
      ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.download(artifact.download_url, { signal: controller.signal });
      if (!response.ok) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download failed",
          { issues: [artifactIssue("unknown")] },
        );
      }
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.size_bytes) {
        // body 已确定不会通过校验：先中断连接再抛错，不把超大响应读进内存。
        controller.abort();
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact integrity check failed",
          {
            issues: [
              artifactIssue("artifact_changed", {
                actual: declaredBytes,
                limit: artifact.size_bytes,
              }),
            ],
          },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      return { bytes, responseMimeType };
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ConversationShareServiceError)) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download timed out",
          {
            issues: [artifactIssue("unknown")],
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    await this.completedImportsLoaded;
    const workspaceKey = workspaceKeyOf(input.targetWorkspacePath, input.targetWorkspaceIdentity);
    const workspaceKeyedShare = importDedupeKey(input.shareCode, workspaceKey);
    const key = `${workspaceKeyedShare}\u0000${input.clientRequestId}`;
    const completed =
      this.completedImports.get(key) ?? this.completedImportsByWorkspace.get(workspaceKeyedShare);
    if (completed) {
      this.logger.info(undefined, "conversation share import reused", {
        operationId,
        phase: "complete",
      });
      return { ...completed, reused: true };
    }
    const inFlight =
      this.inFlightImports.get(key) ?? this.inFlightImportsByWorkspace.get(workspaceKeyedShare);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.importShareInternal(input, operationId)
      .then((result) => {
        this.completedImports.set(key, result);
        this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
        return this.persistCompletedImportIndex()
          .catch(() => undefined)
          .then(() => result);
      })
      .finally(() => {
        this.inFlightImports.delete(key);
      });
    this.inFlightImports.set(key, promise);
    this.inFlightImportsByWorkspace.set(workspaceKeyedShare, promise);
    void promise.then(
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
    );
    return promise;
  }

  private async importShareInternal(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    if (!this.zcodeSessionService) {
      throwServiceError("feature_disabled", "Conversation share import is unavailable");
    }
    // 两个摘要已在 ConversationShareHttpClient.getContinuation 里对服务端原样发来的值复核过。
    // 不能在这里拿解析产物重算：zod 默认剥掉未知字段，那样发布端加一个 optional 字段就会让
    // 所有老客户端算出不同的哈希，把纯 additive 的演进误报成「分享文件校验失败」。
    const continuation = await this.getContinuation(input);

    const remoteTarget =
      input.targetWorkspaceKind === "remote" || Boolean(input.targetWorkspaceIdentity);
    const workspacePath =
      input.targetWorkspacePath && !remoteTarget
        ? input.targetWorkspacePath
        : this.conversationWorkspaceRoot;
    const workspaceIdentity =
      input.targetWorkspaceIdentity && !remoteTarget ? input.targetWorkspaceIdentity : undefined;
    const shareRoot = join(workspacePath, ".zcode-share");
    const importRoot = join(shareRoot, sanitizeFileSegment(continuation.share.share_id));
    const markerPath = join(importRoot, ".zcode-share-import.json");
    const stagingPath = join(importRoot, ".share-import-staging");
    const finalArtifactsPath = join(importRoot, "shared-artifacts");
    const conversationPath = join(importRoot, "shared-conversation.json");
    const importId = randomUUID();
    const contextId = `shared-context-${randomUUID()}`;
    const sessionId = `share-import-${randomUUID()}`;
    // 这个 URL 会进持久化的 provenance 与 sharedContextImport 快照，而
    // sharedContextImportV2StateSchema 只接受规范的 /cn/share/<code>；durable 记录也不该
    // 存随界面语言变化的值（用户之后切语言，存的就错了）。本地化只在展示时做。
    const shareUrl = `${this.shareWebUrl}/${encodeURIComponent(input.shareCode)}`;
    await mkdir(shareRoot, { recursive: true });
    try {
      const existingMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        existingMarker.shareCode === input.shareCode &&
        typeof existingMarker.sessionId === "string" &&
        existingMarker.sessionId.startsWith("share-import-")
      ) {
        const sessions = await this.zcodeSessionService.listSessions({ workspacePath, limit: 100 });
        const existingSession = sessions.find(
          (item) => item.sessionId === existingMarker.sessionId,
        );
        if (
          existingSession &&
          typeof existingMarker.contextId === "string" &&
          typeof existingMarker.shareUrl === "string"
        ) {
          return {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            sessionId: existingSession.sessionId,
            contextId: existingMarker.contextId,
            shareUrl: existingMarker.shareUrl,
            title: existingSession.title,
            reused: true,
          };
        }
        await rm(importRoot, { recursive: true, force: true });
      }
    } catch {
      // 没有 marker 或 marker 不完整时继续创建；非本次 share 的目录不会被删除。
    }
    // 语义是「失败时是否还允许删 importRoot」，不是「我创建了它」：session 一旦提交
    // 就必须解除武装（见下方 createSession 之后）。
    let importRootCleanupArmed = false;
    try {
      await mkdir(importRoot);
      importRootCleanupArmed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throwServiceError("unknown", "Conversation share import is already in progress");
      }
      throw error;
    }
    try {
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "preparing",
          createdAt: this.now(),
        }),
        "utf8",
      );
    } catch (error) {
      await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await mkdir(stagingPath);
      const installedArtifacts: Array<{
        artifactId: string;
        workspaceRelativePath: string;
        displayName: string;
        mimeType: string;
        sha256: string;
      }> = [];
      const usedNames = new Set<string>();
      let completedArtifacts = 0;
      this.reportImportProgress(operationId, "downloading", 0, continuation.artifacts.length);
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "downloading",
          createdAt: this.now(),
        }),
        "utf8",
      );
      for (const artifact of continuation.artifacts) {
        const { bytes, responseMimeType } = await this.downloadArtifactBytes(artifact);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== artifact.size_bytes || sha256 !== artifact.sha256) {
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Conversation artifact integrity check failed",
            {
              issues: [
                {
                  code: "artifact_changed",
                  scope: "artifact",
                  artifactDisplayName: artifact.display_name,
                  artifactType: artifact.artifact_type,
                  extension: artifact.extension,
                  mimeType: artifact.mime_type,
                  actual: bytes.byteLength,
                  limit: artifact.size_bytes,
                  phase: "downloading",
                },
              ],
            },
          );
        }
        // content-type 不一致不能直接判 invalid_contract，否则 .md 一律导入失败——
        // 对象存储/CDN 按自己的规则给下载打标签（.md 常被标成 text/plain 或
        // application/octet-stream），与发布时的 mime_type 无关。
        //
        // 而到这一行字节已经通过 size + SHA-256 校验，且清单本身由 artifact_set_sha256 覆盖，
        // 所以 artifact.mime_type 才是权威值，响应头不提供任何额外完整性保证——
        // 拿它当门禁只会造成误拒。这里降级为记录，不再阻断。
        if (
          responseMimeType &&
          responseMimeType.toLowerCase() !== artifact.mime_type.toLowerCase()
        ) {
          this.logger.info(undefined, "conversation share artifact content-type differs", {
            artifactType: artifact.artifact_type,
            extension: artifact.extension,
            expectedMimeType: artifact.mime_type,
            responseMimeType,
          });
        }
        const fileName = uniqueImportedFileName(
          artifact.display_name,
          artifact.artifact_id,
          usedNames,
        );
        await writeFile(join(stagingPath, fileName), bytes);
        installedArtifacts.push({
          artifactId: artifact.artifact_id,
          workspaceRelativePath: `.zcode-share/${sanitizeFileSegment(continuation.share.share_id)}/shared-artifacts/${fileName}`,
          displayName: artifact.display_name,
          mimeType: artifact.mime_type,
          sha256: artifact.sha256,
        });
        completedArtifacts += 1;
        this.reportImportProgress(
          operationId,
          "downloading",
          completedArtifacts,
          continuation.artifacts.length,
        );
      }
      this.reportImportProgress(
        operationId,
        "installing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "installing",
          createdAt: this.now(),
        }),
        "utf8",
      );
      await rename(stagingPath, finalArtifactsPath);
      // 只读块要能永久离线打开：分享可能过期或尚未上线，渲染时不能回源，
      // 所以把公开 rows 与结果物元数据一起落在 importRoot 内，随失败清理一起删除。
      //
      // 写 rawRows 而不是解析产物：本端认不出的行和字段照样存下来，用户升级之后就能看到，
      // 不会因为导入当天的版本较旧而被永久抹掉。
      await writeFile(
        conversationPath,
        JSON.stringify({
          formatVersion: IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION,
          shareId: continuation.share.share_id,
          contextId,
          title: continuation.share.title,
          rows: continuation.rawRows,
          ...(continuation.content_blocks ? { content_blocks: continuation.content_blocks } : {}),
          artifacts: continuation.artifacts.map((artifact) => ({
            artifactId: artifact.artifact_id,
            displayName: artifact.display_name,
            mimeType: artifact.mime_type,
            workspaceRelativePath: installedArtifacts.find(
              (installed) => installed.artifactId === artifact.artifact_id,
            )?.workspaceRelativePath,
          })),
        }),
        "utf8",
      );
      const context = formatSharedContextV1({
        share: { shareId: continuation.share.share_id, title: continuation.share.title },
        rows: continuation.rows,
        installedArtifacts,
      });
      if (context.unsupportedKinds.length > 0) {
        // 模型侧 shared_context 少了内容：不阻断导入，但必须留痕。
        this.logger.info(undefined, "shared context skipped row kinds this build cannot format", {
          kinds: context.unsupportedKinds,
        });
      }
      this.reportImportProgress(
        operationId,
        "committing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "committing",
          createdAt: this.now(),
        }),
        "utf8",
      );
      const snapshot = await this.zcodeSessionService.createSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
        persistence: "immediate",
        importedHistory: {
          source: "sharedContext",
          // 会话标题加前缀，让导入的会话在任务列表里一眼可识别。
          // 注意 UI 侧没有任何地方读 sharedContextImport.title（只读 contextId/status/shareUrl），
          // 所以前缀不会污染展示；CLI 已直接用 importedHistory.title 写 session.title。
          title: formatImportedShareSessionTitle(continuation.share.title, input.locale),
          markdown: context.markdown,
          provenance: {
            shareId: continuation.share.share_id,
            contextId,
            shareUrl,
            status: "pending",
            projectionSha256: continuation.integrity.projection_sha256,
            artifactSetSha256: continuation.integrity.artifact_set_sha256,
            formatterVersion: 1,
            markdownSha256: context.markdownSha256,
            installedArtifacts: installedArtifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              workspaceRelativePath: artifact.workspaceRelativePath,
            })),
          },
        },
      });
      // session 已提交，且它的 provenance 引用 importRoot 里已安装的
      // artifacts。此后 marker 清理或进度上报一旦抛错，旧的 catch 会 rm -rf importRoot，
      // 用户就拿到一个引用缺失文件的会话。失败半径必须止于 createSession 之前，
      // 所以这里立刻解除清理武装；marker 是纯痕迹文件，删不掉也不该让导入失败。
      importRootCleanupArmed = false;
      await rm(markerPath, { force: true }).catch(() => undefined);
      this.reportImportProgress(
        operationId,
        "complete",
        completedArtifacts,
        continuation.artifacts.length,
      );
      return {
        workspacePath,
        workspaceIdentity,
        sessionId: snapshot.session.sessionId,
        contextId,
        shareUrl,
        title: continuation.share.title,
        reused: false,
        ...(remoteTarget
          ? { fallbackReason: "remote_workspace" as const }
          : input.targetWorkspacePath
            ? {}
            : { fallbackReason: "default_workspace" as const }),
      };
    } catch (error) {
      // 导入改为落在现有 workspace 后，删除 workspace 根目录会损坏用户项目；
      // 失败清理只能触及本次 import-owned 子目录。
      if (importRootCleanupArmed) {
        await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * 按 contextId 找回导入时落盘的公开 rows。
   *
   * 目录名用的是 share_id 而不是 contextId（二者不等价），所以扫 .zcode-share/ 下各
   * importRoot 并比对文件内的 contextId —— 不额外维护索引，历史导入也能被读到。
   * 内容来自磁盘，属跨存储边界，必须过 schema 再交给渲染层。
   */
  async getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null> {
    const shareRoot = join(input.workspacePath, ".zcode-share");
    let entries: Dirent[];
    try {
      entries = await readdir(shareRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(shareRoot, entry.name, "shared-conversation.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const validated = importedConversationShareFileSchema.safeParse(parsed);
      if (!validated.success || validated.data.contextId !== input.contextId) continue;
      const decoded = decodeConversationShareRows(validated.data.rows);
      // formatVersion 比本端新（用户在新版导入后回退到旧版）时，认不出的行照样计入
      // unsupportedRowCount，让 UI 出软提示——不能静默少内容。
      const unsupportedRowCount =
        decoded.unsupportedCount +
        (validated.data.formatVersion > IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION ? 1 : 0);
      if (unsupportedRowCount > 0) {
        this.logger.info(
          undefined,
          "imported conversation share has content this build can't read",
          {
            formatVersion: validated.data.formatVersion,
            kinds: decoded.unsupportedKinds,
            droppedCount: decoded.unsupportedCount,
            keptCount: decoded.rows.length,
          },
        );
      }
      return {
        shareId: validated.data.shareId,
        contextId: validated.data.contextId,
        title: validated.data.title,
        rows: decoded.rows,
        contentBlocks: validated.data.content_blocks,
        artifacts: validated.data.artifacts,
        unsupportedRowCount,
      };
    }
    return null;
  }

  private async loadCompletedImportIndex(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.importIndexPath, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<ImportConversationShareResult>;
      if (
        typeof record.workspacePath !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.title !== "string" ||
        typeof record.contextId !== "string" ||
        typeof record.shareUrl !== "string"
      ) {
        continue;
      }
      try {
        if (!(await stat(record.workspacePath)).isDirectory()) continue;
      } catch {
        continue;
      }
      const keyParts = key.split("\u0000");
      const shareCode = keyParts[0]!;
      const workspaceKey =
        keyParts[1] ?? workspaceKeyOf(record.workspacePath, record.workspaceIdentity);
      const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
      const result: ImportConversationShareResult = {
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
        sessionId: record.sessionId,
        contextId: record.contextId,
        shareUrl: record.shareUrl,
        title: record.title,
        reused: true,
      };
      this.completedImports.set(key, result);
      this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
    }
  }

  private async writeCompletedImportIndexOnce(): Promise<void> {
    const data = Object.fromEntries(this.completedImports.entries());
    const temporaryPath = `${this.importIndexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(data), "utf8");
      await rename(temporaryPath, this.importIndexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private persistCompletedImportIndex(): Promise<void> {
    // 链条原来不 catch，首个写入失败后 importIndexWriteChain 永久 rejected，
    // 之后每一次 persist 都变成静默 no-op（调用点还 .catch(() => undefined) 吞掉）。
    // 索引一丢就没有恢复源（marker 在成功时已删），再导入同一 share 会撞 mkdir EEXIST
    // 而永久报 "already in progress"。修法：存起来的链条始终 resolved，只用来串行化；
    // 返回值保持可观测，让调用方自己决定是否吞掉本次失败。
    const run = this.importIndexWriteChain
      .catch(() => undefined)
      .then(() => this.writeCompletedImportIndexOnce());
    this.importIndexWriteChain = run.catch(() => undefined);
    return run;
  }

  async publish(input: PublishTextConversationInput, operationId: string) {
    return this.publishWithAgent(input, operationId, this.zcodeAgentService);
  }

  private async publishWithAgent(
    input: PublishTextConversationInput,
    operationId: string,
    agentService: ConversationShareAgentService,
  ) {
    this.logger.info(undefined, "conversation share publish started", {
      operationId,
      accessMode: input.accessMode,
      selectionKind: input.selection.kind,
      remoteWorkspace: Boolean(input.workspaceIdentity || input.remoteSessionId),
    });
    try {
      const result = await this.publishInternal(input, operationId, agentService);
      this.logger.info(undefined, "conversation share publish completed", {
        operationId,
        phase: "complete",
      });
      // 发布成功即本次分享结束，该 session 的预检快照不再有消费者：立刻回收，
      // 否则长生命周期的 desktop host 会无限累积 workspace+session+turn 条目。
      this.clearPreviewPreflightSnapshots(input);
      return result;
    } catch (rawError) {
      const error = normalizeConversationShareConnectionError(rawError);
      const record =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
      this.logger.warn(undefined, "conversation share publish failed", {
        operationId,
        phase: this.publishPhases.get(operationId) ?? "collecting",
        kind: typeof record?.kind === "string" ? record.kind : "unknown",
        ...(typeof record?.reasonCode === "string" ? { reasonCode: record.reasonCode } : {}),
        ...(record?.diagnostics && typeof record.diagnostics === "object"
          ? { diagnostics: record.diagnostics }
          : {}),
        ...(typeof record?.status === "number" ? { status: record.status } : {}),
        ...(typeof record?.code === "number" ? { code: record.code } : {}),
        ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
        ...(error instanceof ConversationShareClientError && error.details?.clientRequestId
          ? { clientRequestId: error.details.clientRequestId }
          : {}),
        errorName:
          typeof record?.name === "string"
            ? record.name
            : error instanceof Error
              ? error.name
              : "UnknownError",
      });
      throw error;
    } finally {
      this.publishPhases.delete(operationId);
    }
  }

  private async publishInternal(
    input: PublishTextConversationInput,
    operationId?: string,
    agentService: ConversationShareAgentService = this.zcodeAgentService,
  ): Promise<ConversationShareRecord> {
    const report = (
      phase: ConversationSharePublishProgress["phase"],
      completedArtifacts = 0,
      totalArtifacts = 0,
      warnings?: {
        issues: readonly ConversationShareFailureIssue[];
        issueCount: number;
        omittedIssueCount: number;
      },
    ) => {
      if (!operationId) return;
      this.publishPhases.set(operationId, phase);
      this.logger.info(undefined, "conversation share publish phase changed", {
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings ? { warningCount: warnings.issueCount } : {}),
      });
      this.getProgressEmitter(operationId).fire({
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings
          ? { warnings: warnings.issues, omittedWarningCount: warnings.omittedIssueCount }
          : {}),
      });
    };
    report("collecting");
    if (!input.title.trim() || !input.clientRequestId.trim()) {
      throwServiceError("invalid_contract", "Share title and request identity are required");
    }
    if (!Number.isSafeInteger(input.disclosureAcceptedAt) || input.disclosureAcceptedAt <= 0) {
      throwServiceError("disclosure_required", "Explicit disclosure confirmation is required");
    }
    if (input.selection.kind === "rowAnchors" && input.selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }

    const capabilities = await this.client.getCapabilities();
    if (!capabilities.access_modes.includes(input.accessMode)) {
      throwServiceError("feature_disabled", "Requested share access mode is unavailable");
    }
    // 预检与发布之间服务端可能回滚或改配置；有效期不可用时明确失败，不能静默改用默认值。
    const ttlOptions = resolveConversationShareTtlOptions(capabilities);
    if (
      input.ttlMs !== undefined &&
      (!ttlOptions || input.ttlMs < ttlOptions.minMs || input.ttlMs > ttlOptions.maxMs)
    ) {
      throwServiceError("feature_disabled", "Requested share expiry is unavailable");
    }

    const conversation = await this.loadAllRows(input, agentService);
    const selected = selectRows(conversation.rows, input.selection);
    // 无法公开承载的已定稿结构先降级：删字段或丢整行，换成非阻断提示，
    // 后续所有投影与产物发现都基于这份 sanitized rows。
    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurn(conversation.rows),
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: this.now(),
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(draft.productTurnId),
              },
            ]
          : [],
    );
    const publishWarnings: ConversationShareFailureIssue[] = [
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    ];
    // 修复原因：此前公开投影遇到第一个不支持结构就直接退出，用户无法知道还有哪些轮次需要取消；
    // 现在先完成整组选中内容的结构预检，返回脱敏 issues 让 UI 给出逐项可操作建议。
    const structureIssues = collectShareStructureIssues(selectedRows, conversation.rows);
    if (structureIssues.length > 0) {
      const structureKind = structureIssues.some(
        (issue) => issue.code === "artifact_protocol_not_ready",
      )
        ? "artifact_protocol_not_ready"
        : "invalid_conversation";
      throw new ConversationShareServiceError(
        structureKind,
        "Selected conversation contains unsupported structure",
        { issues: structureIssues },
      );
    }
    // 本地运行投影包含 subagent 详情与写入态 ID，后端 V1 会以 3205 拒绝；
    // confirm 前必须先生成独立的公开投影，不能直接发送选中的本地 rows。
    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    this.validateArtifactManifest(capabilities, registeredProjection.artifacts);
    const preflightPreviewSnapshots = new Map<string, ConversationSharePreviewPreflightSnapshot>();
    for (const productTurnId of selected.productTurnIds) {
      const snapshot = this.previewPreflightSnapshots.get(
        previewPreflightKey(input, productTurnId),
      );
      if (snapshot) preflightPreviewSnapshots.set(productTurnId, snapshot);
    }
    const artifactSnapshot = await buildConversationShareArtifactSnapshot({
      zcodeAgentService: agentService,
      artifactSource: this.artifactSource,
      input,
      selectedRows,
      registeredArtifacts: registeredProjection.artifacts,
      inlineBytesBySourceRef: new Map([
        ...inlineImages.bytesBySourceRef,
        ...workflowSnapshot.bytes,
      ]),
      capabilities,
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      turnOrdinalByProductTurnId: turnOrdinalByProductTurn(conversation.rows),
      preflightPreviewSnapshots,
      currentCapabilitiesFingerprint: capabilitiesFingerprint(capabilities),
    });
    if (artifactSnapshot.issues.length > 0) {
      throw new ConversationShareServiceError(
        "artifact_not_allowed",
        "Conversation result artifacts are not allowed by server capabilities",
        { issues: artifactSnapshot.issues },
      );
    }
    if (artifactSnapshot.warnings.length > 0) {
      publishWarnings.push(...artifactSnapshot.warnings);
    }
    if (publishWarnings.length > 0) {
      // 非阻断：正文引用的文件或用户输入附件无法物化时，发布照常继续，但要让分享者
      // 知道哪些真实文件没有进入链接；内部 marker 已移除，内嵌图片已转换为 artifact。
      report("collecting", 0, 0, sanitizeConversationShareIssues(publishWarnings));
    }
    const publicProjection = buildConversationSharePublicProjection({
      rows: artifactSnapshot.rows,
      selectedProductTurnIds: selected.productTurnIds,
      additionalArtifacts: artifactSnapshot.additionalArtifacts,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
      ...(supportsConversationShareContent(capabilities)
        ? { contentDrafts: workflowSnapshot.drafts }
        : {}),
    });
    this.validateArtifactManifest(capabilities, publicProjection.artifacts);
    if (publicProjection.rows.length > capabilities.max_rows) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation contains too many rows to share",
        {
          issues: [
            {
              code: "rows_limit",
              scope: "conversation",
              actual: publicProjection.rows.length,
              limit: capabilities.max_rows,
            },
          ],
        },
      );
    }

    const confirmRequest = buildConversationShareConfirmRequest({
      selected_product_turn_ids: publicProjection.selectedProductTurnIds,
      projection: {
        rows: publicProjection.rows,
        ...(publicProjection.contentBlocks
          ? { content_blocks: publicProjection.contentBlocks }
          : {}),
      },
      artifacts: publicProjection.artifacts.map((artifact) => artifact.descriptor),
      disclosure_confirmation: {
        version: 1,
        accepted_at: input.disclosureAcceptedAt,
        acknowledged_no_secret_detection: true,
      },
    });
    if (
      Buffer.byteLength(JSON.stringify(confirmRequest), "utf8") > capabilities.max_payload_bytes
    ) {
      const actualBytes = Buffer.byteLength(JSON.stringify(confirmRequest), "utf8");
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation share payload is too large",
        {
          issues: [
            {
              code: "payload_size_limit",
              scope: "conversation",
              actual: actualBytes,
              limit: capabilities.max_payload_bytes,
            },
          ],
        },
      );
    }

    const payloadSha256 = sha256ConversationShareJson(confirmRequest);
    const preparation = await this.client.createPreparation({
      client_request_id: input.clientRequestId,
      title: input.title.trim(),
      schema_version: 1,
      access_mode: input.accessMode,
      ...(input.ttlMs === undefined ? {} : { ttl_ms: input.ttlMs }),
      // 来源会话只用于 owner 管理列表的「跳转对话」；超出服务端列宽时不发送，不能让它阻断发布。
      ...sourceSessionIdOf(input.sessionId),
      payload_sha256: payloadSha256,
      artifact_count: publicProjection.artifacts.length,
    });
    if (preparation.status === "confirmed") {
      report("complete", publicProjection.artifacts.length, publicProjection.artifacts.length);
      return localizePublishedShare(preparation.share, input.locale);
    }
    report("uploading", 0, publicProjection.artifacts.length);
    let uploadedArtifacts = 0;
    for (const artifact of publicProjection.artifacts) {
      const bytes = artifactSnapshot.bytesBySourceRef.get(artifact.sourceRef);
      if (!bytes) {
        throwServiceError(
          "invalid_conversation",
          "Conversation artifact bytes are missing from the publication snapshot",
        );
      }
      const upload = await this.client.uploadArtifact(
        preparation.preparation_id,
        artifact.descriptor,
        new Blob([Uint8Array.from(bytes).buffer], {
          type: artifact.descriptor.mime_type,
        }),
      );
      if (
        upload.artifact_id !== artifact.descriptor.artifact_id ||
        upload.size_bytes !== artifact.descriptor.size_bytes ||
        upload.sha256 !== artifact.descriptor.sha256
      ) {
        throw new ConversationShareServiceError(
          "upload_incomplete",
          "Conversation artifact upload acknowledgement does not match the manifest",
          {
            issues: [
              {
                code: "upload_incomplete",
                scope: "artifact",
                artifactDisplayName: artifact.descriptor.display_name,
                artifactType: artifact.descriptor.artifact_type,
                extension: artifact.descriptor.extension,
                mimeType: artifact.descriptor.mime_type,
                actual: upload.size_bytes,
                limit: artifact.descriptor.size_bytes,
              },
            ],
          },
        );
      }
      uploadedArtifacts += 1;
      report("uploading", uploadedArtifacts, publicProjection.artifacts.length);
    }
    report("checking", uploadedArtifacts, publicProjection.artifacts.length);
    const share = await this.confirmUntilReady(preparation.preparation_id, confirmRequest);
    report("complete", uploadedArtifacts, publicProjection.artifacts.length);
    // 服务端目前不接收 locale，只能把下发的链接改写到界面语言对应的站点；
    // localizeConversationShareUrl 只认已知分享路径形状，其它形状原样保留。
    return localizePublishedShare(share, input.locale);
  }

  private getProgressEmitter(operationId: string): Emitter<ConversationSharePublishProgress> {
    const existing = this.progressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationSharePublishProgress>({
      onDidRemoveLastListener: () => {
        this.progressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.progressEmitters.set(operationId, emitter);
    return emitter;
  }

  private getImportProgressEmitter(operationId: string): Emitter<ConversationShareImportProgress> {
    const existing = this.importProgressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationShareImportProgress>({
      onDidRemoveLastListener: () => {
        this.importProgressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.importProgressEmitters.set(operationId, emitter);
    return emitter;
  }

  private reportImportProgress(
    operationId: string,
    phase: ConversationShareImportProgress["phase"],
    completedArtifacts: number,
    totalArtifacts: number,
  ) {
    this.getImportProgressEmitter(operationId).fire({
      operationId,
      phase,
      completedArtifacts,
      totalArtifacts,
    });
  }

  private async cleanupAbandonedImports(): Promise<void> {
    if (!this.zcodeSessionService) return;
    await this.completedImportsLoaded;
    // 只扫描默认 conversation workspace 的 import-owned 子目录；其它 workspace 的 marker
    // 在下一次带 target 的导入请求中处理，避免启动期枚举并触碰用户项目目录。
    const shareRoot = join(this.conversationWorkspaceRoot, ".zcode-share");
    const imports = await readdir(shareRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of imports) {
      if (!entry.isDirectory()) continue;
      const importRoot = join(shareRoot, entry.name);
      const markerPath = join(importRoot, ".zcode-share-import.json");
      let marker: {
        sessionId?: unknown;
        shareCode?: unknown;
        clientRequestId?: unknown;
        workspaceKey?: unknown;
        contextId?: unknown;
        shareUrl?: unknown;
      };
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
      } catch {
        continue;
      }
      if (typeof marker.sessionId !== "string" || !marker.sessionId.startsWith("share-import-"))
        continue;
      try {
        const sessions = await this.zcodeSessionService.listSessions({
          workspacePath: this.conversationWorkspaceRoot,
          limit: 100,
        });
        const session = sessions.find((item) => item.sessionId === marker.sessionId);
        if (session) {
          if (
            typeof marker.shareCode === "string" &&
            typeof marker.clientRequestId === "string" &&
            typeof marker.contextId === "string" &&
            typeof marker.shareUrl === "string"
          ) {
            const workspaceKeyedShare = importDedupeKey(
              marker.shareCode,
              typeof marker.workspaceKey === "string"
                ? marker.workspaceKey
                : this.conversationWorkspaceRoot,
            );
            const result: ImportConversationShareResult = {
              workspacePath: this.conversationWorkspaceRoot,
              sessionId: session.sessionId,
              contextId: marker.contextId,
              shareUrl: marker.shareUrl,
              title: session.title,
              reused: true,
            };
            this.completedImports.set(
              `${workspaceKeyedShare}\u0000${marker.clientRequestId}`,
              result,
            );
            this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
            await this.persistCompletedImportIndex().catch(() => undefined);
          }
          await rm(markerPath, { force: true });
        } else {
          // 只删除带合法 marker 且没有匹配 session 的本次 importRoot。
          await rm(importRoot, { recursive: true, force: true });
        }
      } catch {
        // 无法证明 session 状态时保留 importRoot，禁止把暂时性错误升级为数据删除。
      }
    }
  }

  private collectArtifactManifestIssues(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): ConversationShareFailureIssue[] {
    const artifactIds = new Set<string>();
    const issues: ConversationShareFailureIssue[] = [];
    if (artifacts.length > capabilities.max_artifact_count) {
      issues.push({
        code: "artifact_count_limit",
        scope: "conversation",
        actual: artifacts.length,
        limit: capabilities.max_artifact_count,
      });
    }
    let declaredTotalBytes = 0;
    for (const { descriptor } of artifacts) {
      if (artifactIds.has(descriptor.artifact_id)) {
        issues.push({
          code: "artifact_manifest",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
        });
        continue;
      }
      artifactIds.add(descriptor.artifact_id);
      declaredTotalBytes += descriptor.size_bytes;
      if (descriptor.size_bytes > capabilities.max_artifact_bytes) {
        issues.push({
          code: "artifact_size_limit",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          actual: descriptor.size_bytes,
          limit: capabilities.max_artifact_bytes,
        });
      }
      const allowed = capabilities.allowed_artifacts.some(
        (candidate) =>
          candidate.type === descriptor.artifact_type &&
          candidate.extensions.some(
            (extension) => extension.replace(/^\./u, "").toLowerCase() === descriptor.extension,
          ) &&
          candidate.mime_types.some(
            (mimeType) => mimeType.toLowerCase() === descriptor.mime_type.toLowerCase(),
          ),
      );
      if (!allowed) {
        issues.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          allowedFormats: allowedFormatLabels(capabilities),
          allowedArtifacts: allowedArtifactSummaries(capabilities),
        });
      }
    }
    if (declaredTotalBytes > capabilities.max_total_artifact_bytes) {
      issues.push({
        code: "artifact_total_size_limit",
        scope: "conversation",
        actual: declaredTotalBytes,
        limit: capabilities.max_total_artifact_bytes,
      });
    }
    return issues;
  }

  private validateArtifactManifest(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): void {
    const issues = this.collectArtifactManifestIssues(capabilities, artifacts);
    if (issues.length > 0) {
      const hasTypeIssue = issues.some((issue) => issue.code === "artifact_type_not_allowed");
      throw new ConversationShareServiceError(
        hasTypeIssue ? "artifact_not_allowed" : "limit_exceeded",
        "Conversation artifacts cannot be shared",
        { issues },
      );
    }
  }

  private async confirmUntilReady(
    preparationId: string,
    request: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    let deadline: number | undefined;
    let lastRequestId: string | undefined;
    let lastStatus: number | undefined;
    let lastCode: number | undefined;
    while (true) {
      try {
        return await this.client.confirm(preparationId, request);
      } catch (error) {
        if (
          !(error instanceof ConversationShareClientError) ||
          error.kind !== "safety_check_pending"
        ) {
          throw error;
        }
        lastRequestId = error.requestId ?? lastRequestId;
        lastStatus = error.status ?? lastStatus;
        lastCode = error.code ?? lastCode;

        // 3215 是后端安全检查的非终态，同一 preparation/DTO 必须串行重试；
        // 不能重新 prepare，也不能无限等待。
        const currentTime = this.now();
        deadline ??= currentTime + this.confirmPollTimeoutMs;
        const remainingMs = deadline - currentTime;
        if (remainingMs <= 0) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
        const requestedDelayMs = error.retryAfterMs ?? this.confirmPollIntervalMs;
        await this.sleep(Math.min(requestedDelayMs, remainingMs));
        if (this.now() >= deadline) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
      }
    }
  }

  private async loadAllRows(
    input: Pick<
      PublishTextConversationInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationRowsRead> {
    // 读到的行是宽类型（可能含 unreadable 占位行），拒绝检查通过后才窄化成 wire 行。
    const pages: ConversationRow[][] = [];
    let beforeRowId: number | undefined;
    let logEpoch: string | undefined;
    let revision: number | undefined;

    while (true) {
      const result = await agentService.conversationRowsRangeV4({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
        sessionId: input.sessionId,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      });
      if (
        (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
        (revision !== undefined && result.atRevision !== revision)
      ) {
        throwServiceError("invalid_conversation", "Conversation changed while preparing share");
      }
      logEpoch = result.atLogEpoch;
      revision = result.atRevision;
      pages.unshift(result.rows);
      if (!result.hasMore) break;
      const firstRowId = result.rows[0]?.rowId;
      if (firstRowId === undefined || firstRowId === beforeRowId) {
        throwServiceError("invalid_contract", "Conversation row pagination did not advance");
      }
      beforeRowId = firstRowId;
    }

    // rows/range 现在逐行降级（04-sync-and-recovery 封闭规则 13），所以这里可能收到 unreadable
    // 占位行。分享必须**拒绝**，不能静默省略：少掉几行的分享会让读到链接的人看到一份失真的对话，
    // 那比发不出去更坏。本端读不懂说明发送端比本端新，提示用户升级后重试。
    const rows = pages.flat().filter(isWireConversationRow);
    if (rows.length !== pages.reduce((total, page) => total + page.length, 0)) {
      throwServiceError(
        "invalid_conversation",
        "Conversation contains rows this version cannot read; update ZCode and try again",
      );
    }
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (previous.rowId >= current.rowId) {
        throwServiceError("invalid_contract", "Conversation rows are not globally ordered");
      }
    }
    if (logEpoch === undefined || revision === undefined) {
      throwServiceError("invalid_contract", "Conversation rows are missing a read watermark");
    }
    return { rows, revision, logEpoch };
  }
}
