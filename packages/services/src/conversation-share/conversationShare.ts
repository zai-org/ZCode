/* oxlint-disable eslint(max-lines) -- Share 的错误/预检公共契约与跨 RPC 脱敏规则必须保持在同一边界，避免 UI、Host 和 API 各自漂移。 */
import type {
  ConversationShareAccessMode,
  ConversationShareCapabilities,
  ConversationShareContinuation,
  ConversationShareManagedItem,
  ConversationShareManagedList,
  ConversationSharePreview,
  ConversationShareRecord,
  ConversationShareTtlOptions,
  Locale,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { WireConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { Event as RpcEvent, type Event } from "@zcode/rpc";

import { createServiceDescriptor } from "../descriptors.js";
import type { ConversationShareClientErrorKind } from "./conversationShareHttpClient.js";

export type ConversationShareSelection =
  | { kind: "all" }
  | { kind: "productTurns"; productTurnIds: string[] }
  | { kind: "rowAnchors"; rowIds: number[] };

export interface PublishTextConversationInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  title: string;
  accessMode: ConversationShareAccessMode;
  /** 分享有效时长；省略时使用服务端默认值。必须落在预检返回的 ttlOptions 范围内。 */
  ttlMs?: number;
  selection: ConversationShareSelection;
  clientRequestId: string;
  disclosureAcceptedAt: number;
  /** 界面语言；决定返回的 share_url 落在中文站还是英文站。缺省不改写服务端下发的链接。 */
  locale?: Locale;
}

export interface ConversationSharePreflightInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  selection: ConversationShareSelection;
}

export interface ConversationShareAllowedArtifact {
  type: string;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  displayName?: string;
}

export interface ConversationShareTurnPreflightResult {
  /** 已转换的公开行数；选择变化时可按轮重新聚合，不缓存整组选中项的容量错误。 */
  rowBudget?: { count: number; limit: number };
  productTurnId: string;
  turnFingerprint?: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
}

export interface ConversationSharePreflightResult {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
  supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  /** 发布方服务端声明的有效期范围；未声明时省略，UI 不显示有效期选择。 */
  ttlOptions?: ConversationShareTtlOptions;
  turnResults: readonly ConversationShareTurnPreflightResult[];
}

export type ConversationShareServiceErrorKind =
  | ConversationShareClientErrorKind
  | "artifact_protocol_not_ready"
  | "connection_unavailable"
  | "invalid_selection"
  | "safety_check_timeout";

export type ConversationShareFailureReasonCode =
  | "running_turn"
  | "streaming_row"
  | "active_tool_call"
  | "active_subagent"
  | "input_attachment"
  | "input_attachment_unavailable"
  | "inline_tool_image"
  | "unsupported_timeline"
  | "unsafe_url"
  | "missing_product_turn"
  | "invalid_selection"
  | "artifact_type_not_allowed"
  | "artifact_extension_missing"
  | "artifact_outside_workspace"
  | "artifact_changed"
  | "content_unavailable"
  | "artifact_read_failed"
  // 已知容量超限：附件真实大小超过服务端 max_artifact_bytes 或通道可搬运上限。
  // 与 artifact_read_failed（不确定）不同，它在选择阶段就是确定阻断。
  | "artifact_size_limit"
  | "artifact_manifest"
  | "payload_limit"
  | "no_shareable_content"
  | "stale_conversation"
  | "artifact_protocol_not_ready"
  | "invalid_conversation";

export type ConversationShareFailureIssueCode =
  | "authentication_required"
  | "network"
  | "service_unavailable"
  | "rate_limited"
  | "feature_disabled"
  | "connection_unavailable"
  | "invalid_contract"
  | "disclosure_required"
  | ConversationShareFailureReasonCode
  | "rows_limit"
  | "artifact_count_limit"
  | "artifact_total_size_limit"
  | "payload_size_limit"
  | "upload_incomplete"
  | "unknown";

export interface ConversationShareFailureIssue {
  code: ConversationShareFailureIssueCode;
  scope: "conversation" | "turn" | "artifact" | "transport";
  rowId?: number;
  turnOrdinal?: number;
  /**
   * 问题所属的 product turn 身份。
   *
   * UI 的「取消选择该轮」曾用 turnOrdinal 去索引自己的 per-query 列表，
   * 而 turnOrdinal 是 service 按全部 turnHeader 编号的序号，两套编号在含系统上下文轮
   * 或多 steer query 的会话里必然错位，导致取消到别的轮次。轮次定位必须按身份，
   * turnOrdinal 只用于展示文案。
   */
  productTurnId?: string;
  artifactDisplayName?: string;
  artifactType?: string;
  extension?: string;
  mimeType?: string;
  actual?: number;
  limit?: number;
  retryAfterMs?: number;
  phase?: ConversationSharePublishProgress["phase"] | "downloading" | "installing" | "committing";
  allowedFormats?: readonly string[];
  allowedArtifacts?: readonly ConversationShareAllowedArtifact[];
  availability?:
    | "not_found"
    | "permission_denied"
    | "connection_unavailable"
    | "changed"
    | "unknown";
}

export type ConversationShareFailureDiagnosticValue = string | number | boolean;
export type ConversationShareFailureDiagnostics = Readonly<
  Record<string, ConversationShareFailureDiagnosticValue>
>;

function inferFailureReasonCode(message: string): ConversationShareFailureReasonCode {
  if (/Running turns/iu.test(message)) return "running_turn";
  if (/Streaming rows/iu.test(message)) return "streaming_row";
  if (/Active tool calls/iu.test(message)) return "active_tool_call";
  if (/Active subagents|subagent detail/iu.test(message)) return "active_subagent";
  if (/attachments?|public input contains local write identity/iu.test(message)) {
    return "input_attachment";
  }
  if (/Inline tool images/iu.test(message)) return "inline_tool_image";
  if (/Timeline|fork|checkpoint|summary references/iu.test(message)) {
    return "unsupported_timeline";
  }
  if (/Local and inline URLs/iu.test(message)) return "unsafe_url";
  if (/missing its product turn|product turn identity/iu.test(message)) {
    return "missing_product_turn";
  }
  if (/Selected product turns|selected row|selection/iu.test(message)) {
    return "invalid_selection";
  }
  if (/not allowed by server capabilities/iu.test(message)) return "artifact_type_not_allowed";
  if (/extension is missing/iu.test(message)) return "artifact_extension_missing";
  if (/outside the workspace/iu.test(message)) return "artifact_outside_workspace";
  if (/changed after|file changed|size\/mtime/iu.test(message)) return "artifact_changed";
  // 本地/远程 artifact source 的兜底消息是 "artifact cannot be read"，
  // 旧正则只覆盖 ended|source|chunk|readable，读失败因此被误判为 invalid_conversation。
  if (/artifact (?:ended|source|chunk|readable|cannot be read)/iu.test(message)) {
    return "artifact_read_failed";
  }
  if (/artifact (?:identifiers|manifest|acknowledgement|missing)/iu.test(message)) {
    return "artifact_manifest";
  }
  if (/payload|too many rows|too many artifacts/iu.test(message)) return "payload_limit";
  return "invalid_conversation";
}

export interface ConversationShareFailureDetails {
  requestId?: string;
  status?: number;
  code?: number;
  reasonCode?: ConversationShareFailureReasonCode;
  diagnostics?: ConversationShareFailureDiagnostics;
  issues?: readonly ConversationShareFailureIssue[];
  issueCount?: number;
  omittedIssueCount?: number;
  /** 仅用于 host 侧诊断的底层错误；绝不进入发给 Renderer 的 details。 */
  cause?: unknown;
}

const SAFE_FAILURE_DIAGNOSTIC_KEYS = new Set([
  "rowKind",
  "rowId",
  "field",
  "artifactType",
  "extension",
  "phase",
  "expectedBytes",
  "actualBytes",
  "errno",
]);

const MAX_FAILURE_ISSUES = 5;

function sanitizeFailureIssue(
  issue: ConversationShareFailureIssue,
): ConversationShareFailureIssue | null {
  const safeString = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && !/[\\/]|:\/\//u.test(value) ? value : undefined;
  const safeMimeType = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(value)
      ? value
      : undefined;
  const artifactDisplayName = issue.artifactDisplayName?.trim();
  // displayName 含路径/URL 或超长时，整条 issue 返回 null 会被过滤——脱敏目标是
  // 不泄露路径，而不是丢掉整条诊断信息。改为只剥离该字段，保留 code/scope 等定位信息。
  const safeArtifactDisplayName =
    artifactDisplayName &&
    artifactDisplayName.length <= 128 &&
    !/[\\/]|:\/\//u.test(artifactDisplayName)
      ? artifactDisplayName
      : undefined;
  const allowedFormats = issue.allowedFormats
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 128 && !/[\\/]|:\/\//u.test(value));
  const allowedArtifacts = issue.allowedArtifacts
    ?.map((artifact) => ({
      type: artifact.type.trim(),
      extensions: artifact.extensions
        .map((extension) => extension.trim().replace(/^\./u, ""))
        .filter((extension) => extension.length > 0 && extension.length <= 32),
      mimeTypes: artifact.mimeTypes
        .map((mimeType) => mimeType.trim().toLowerCase())
        .filter((mimeType) => /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(mimeType)),
      ...(artifact.displayName &&
      artifact.displayName.length <= 64 &&
      !/[\\/]|:\/\//u.test(artifact.displayName)
        ? { displayName: artifact.displayName.trim() }
        : {}),
    }))
    .filter(
      (artifact) =>
        artifact.type.length > 0 &&
        !/[\\/]|:\/\//u.test(artifact.type) &&
        artifact.extensions.length > 0,
    );
  return {
    code: issue.code,
    scope: issue.scope,
    ...(issue.rowId === undefined ? {} : { rowId: issue.rowId }),
    ...(issue.turnOrdinal === undefined ? {} : { turnOrdinal: issue.turnOrdinal }),
    ...(typeof issue.productTurnId === "string" && issue.productTurnId.length > 0
      ? { productTurnId: issue.productTurnId }
      : {}),
    ...(safeArtifactDisplayName ? { artifactDisplayName: safeArtifactDisplayName } : {}),
    ...(safeString(issue.artifactType) ? { artifactType: safeString(issue.artifactType) } : {}),
    ...(safeString(issue.extension) ? { extension: safeString(issue.extension) } : {}),
    ...(safeMimeType(issue.mimeType) ? { mimeType: safeMimeType(issue.mimeType) } : {}),
    ...(issue.actual === undefined ? {} : { actual: issue.actual }),
    ...(issue.limit === undefined ? {} : { limit: issue.limit }),
    ...(issue.retryAfterMs === undefined ? {} : { retryAfterMs: issue.retryAfterMs }),
    ...(issue.phase === undefined ? {} : { phase: issue.phase }),
    ...(allowedFormats && allowedFormats.length > 0 ? { allowedFormats } : {}),
    ...(allowedArtifacts && allowedArtifacts.length > 0 ? { allowedArtifacts } : {}),
    ...(issue.availability === undefined ? {} : { availability: issue.availability }),
  };
}

/**
 * 把 issue 列表裁剪并清洗成可安全跨 RPC 的载荷，返回被省略的条数。
 * 非阻断 warning 与阻断 issue 共用同一套脱敏规则。
 */
export function sanitizeConversationShareIssues(issues: readonly ConversationShareFailureIssue[]): {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount: number;
} {
  const sanitized = issues
    .slice(0, MAX_FAILURE_ISSUES)
    .map(sanitizeFailureIssue)
    .filter((issue): issue is ConversationShareFailureIssue => issue !== null);
  return {
    issues: sanitized,
    issueCount: issues.length,
    omittedIssueCount: Math.max(0, issues.length - sanitized.length),
  };
}

function sanitizeFailureDiagnostics(
  diagnostics: ConversationShareFailureDiagnostics | undefined,
): ConversationShareFailureDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const safe: Record<string, ConversationShareFailureDiagnosticValue> = {};
  for (const [key, value] of Object.entries(diagnostics)) {
    if (!SAFE_FAILURE_DIAGNOSTIC_KEYS.has(key)) continue;
    if (typeof value === "string" && (/[\\/]|:\/\//u.test(value) || value.length > 128)) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export class ConversationShareServiceError extends Error {
  readonly kind: ConversationShareServiceErrorKind;
  readonly requestId?: string;
  readonly status?: number;
  readonly code?: number;
  readonly reasonCode: ConversationShareFailureReasonCode;
  readonly diagnostics?: ConversationShareFailureDiagnostics;
  readonly issues?: readonly ConversationShareFailureIssue[];
  readonly issueCount: number;
  readonly omittedIssueCount: number;
  /** 通过现有 RPC details 字段传给 Renderer 的安全错误载荷。 */
  readonly details?: ConversationShareFailureDetails;

  constructor(
    kind: ConversationShareServiceErrorKind,
    message: string,
    details: ConversationShareFailureDetails = {},
  ) {
    super(message, ...(details.cause === undefined ? [] : [{ cause: details.cause }]));
    this.name = "ConversationShareServiceError";
    this.kind = kind;
    const requestId = details.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
    }
    if (Number.isSafeInteger(details.status)) this.status = details.status;
    if (Number.isSafeInteger(details.code)) this.code = details.code;
    this.reasonCode = details.reasonCode ?? inferFailureReasonCode(message);
    const diagnostics = sanitizeFailureDiagnostics(details.diagnostics);
    if (diagnostics) {
      this.diagnostics = diagnostics;
    }
    const sanitized = sanitizeConversationShareIssues(details.issues ?? []);
    this.issueCount = sanitized.issueCount;
    this.omittedIssueCount = sanitized.omittedIssueCount;
    if (sanitized.issues.length > 0) {
      this.issues = sanitized.issues;
    }
    const safeDetails: ConversationShareFailureDetails = {
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      reasonCode: this.reasonCode,
      ...(this.diagnostics === undefined ? {} : { diagnostics: this.diagnostics }),
      ...(this.issues === undefined ? {} : { issues: this.issues }),
      ...(this.issueCount > 0 ? { issueCount: this.issueCount } : {}),
      ...(this.issueCount > 0 ? { omittedIssueCount: this.omittedIssueCount } : {}),
    };
    if (Object.keys(safeDetails).length > 0) {
      this.details = safeDetails;
    }
  }
}

export interface ConversationSharePublishProgress {
  operationId: string;
  phase: "collecting" | "uploading" | "checking" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
  /**
   * 非阻断提示：发布照常继续，但这些结果物被跳过（例如正文引用的文件已不存在）。
   * 已过 sanitizeConversationShareIssues 脱敏，可安全跨 RPC。
   */
  warnings?: readonly ConversationShareFailureIssue[];
  omittedWarningCount?: number;
}

export interface ConversationShareImportProgress {
  operationId: string;
  phase: "downloading" | "installing" | "committing" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
}

export interface ImportConversationShareInput {
  shareCode: string;
  clientRequestId: string;
  /** 当前 renderer 捕获的目标；Deep Link 本身不得携带路径或 identity。 */
  targetWorkspacePath?: string;
  targetWorkspaceIdentity?: string;
  targetWorkspaceKind?: "local" | "remote";
  /** 界面语言；决定导入会话的标题前缀。回链本身固定存规范路径。 */
  locale?: Locale;
}

/** 导入时落盘的公开 rows 副本；会话里的只读块靠它渲染，不回源。 */
export interface ImportedConversationShare {
  contentBlocks?: unknown[];
  shareId: string;
  contextId: string;
  title: string;
  rows: WireConversationRow[];
  /**
   * 本端渲染不了、已跳过的行数（副本里有新 row kind，或 formatVersion 比本端新）。
   * >0 时只读块顶部必须出软提示，否则用户会以为内容丢了。
   */
  unsupportedRowCount: number;
  artifacts: Array<{
    artifactId: string;
    displayName: string;
    mimeType?: string;
    workspaceRelativePath?: string;
  }>;
}

export interface ImportConversationShareResult {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  contextId: string;
  shareUrl: string;
  title: string;
  reused: boolean;
  fallbackReason?: "remote_workspace" | "default_workspace";
}

export interface IConversationShareService {
  getCapabilities(): Promise<ConversationShareCapabilities>;
  preflight(input: ConversationSharePreflightInput): Promise<ConversationSharePreflightResult>;
  publish(
    input: PublishTextConversationInput,
    operationId: string,
  ): Promise<ConversationShareRecord>;
  onDynamicPublishProgress(operationId: string): Event<ConversationSharePublishProgress>;
  importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult>;
  onDynamicImportProgress(operationId: string): Event<ConversationShareImportProgress>;
  /** 读取导入时落盘的公开 rows；找不到返回 null（会话里就不渲染只读块）。 */
  getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null>;
  getPreview(shareCode: string): Promise<ConversationSharePreview>;
  getContinuation(input: {
    shareCode: string;
    clientRequestId: string;
  }): Promise<ConversationShareContinuation>;
  /** 当前 Host 登录账号的分享管理列表；cursor 原样回传上一页的 next_cursor。 */
  listManagedShares(input: { cursor?: string }): Promise<ConversationShareManagedList>;
  /** 停止分享（服务端 revoke）；重复调用幂等。 */
  revokeManagedShare(shareId: string): Promise<ConversationShareManagedItem>;
  restoreManagedShare(shareId: string): Promise<ConversationShareManagedItem>;
  /** 删除分享，不可恢复；重复调用幂等。 */
  deleteManagedShare(shareId: string): Promise<void>;
}

export const IConversationShareService = createServiceDescriptor<IConversationShareService>(
  ServiceChannels.ConversationShare,
);

/**
 * 分享能力不可用时的统一门禁实现。
 *
 * 每个不支持分享的宿主（desktop-attached remote、server remote 等）都要拒绝全部
 * 写操作并返回空事件流。手写会让 IConversationShareService 新增方法时漏改某个宿主，
 * 所以由这里集中生成。
 */
export function createUnsupportedConversationShareService(options: {
  message: string;
  /** 可选审计钩子：宿主想记录被拒绝的动作名时传入。 */
  onRejected?: (action: string) => void;
}): IConversationShareService {
  const reject = (action: string) => async (): Promise<never> => {
    options.onRejected?.(action);
    throw new ConversationShareServiceError("feature_disabled", options.message);
  };
  const noEvents = () => RpcEvent.None;
  return {
    getCapabilities: reject("getCapabilities"),
    preflight: reject("preflight"),
    publish: reject("publish"),
    onDynamicPublishProgress: noEvents,
    importShare: reject("importShare"),
    onDynamicImportProgress: noEvents,
    // 只读查询：不可用环境下返回 null 而不是抛错，会话里就是不渲染只读块。
    getImportedConversation: async () => null,
    getPreview: reject("getPreview"),
    getContinuation: reject("getContinuation"),
    listManagedShares: reject("listManagedShares"),
    revokeManagedShare: reject("revokeManagedShare"),
    restoreManagedShare: reject("restoreManagedShare"),
    deleteManagedShare: reject("deleteManagedShare"),
  };
}
