import type { ConversationShareFailureIssue } from "@zcode/services";
import { conversationShareRejectionSchema, type ConversationShareRejection } from "@zcode/shared";

export interface ConversationShareErrorDetails {
  name: string;
  kind: string;
  reasonCode?: string;
  diagnostics?: Record<string, string | number | boolean>;
  status?: number;
  code?: number;
  requestId?: string;
  clientRequestId?: string;
  rejection?: ConversationShareRejection;
  issues?: readonly ConversationShareFailureIssue[];
  issueCount?: number;
  omittedIssueCount?: number;
}

const PUBLISH_ERROR_MESSAGE_BY_KIND: Readonly<Record<string, string>> = {
  authentication_required: "conversationShare.error.authenticationRequired",
  feature_disabled: "conversationShare.error.featureDisabled",
  artifact_not_allowed: "conversationShare.error.artifactNotAllowed",
  limit_exceeded: "conversationShare.error.limitExceeded",
  rate_limited: "conversationShare.error.rateLimited",
  network: "conversationShare.error.network",
  service_unavailable: "conversationShare.error.serviceUnavailable",
  safety_check_rejected: "conversationShare.error.safetyCheckRejected",
  safety_check_unavailable: "conversationShare.error.safetyCheckUnavailable",
  not_found: "conversationShare.error.preparationNotFound",
  expired: "conversationShare.error.preparationExpired",
  revoked: "conversationShare.error.shareRevoked",
  unsupported_schema_version: "conversationShare.import.unsupportedVersion",
  safety_check_timeout: "conversationShare.error.safetyCheckTimeout",
  invalid_selection: "conversationShare.error.invalidSelection",
  invalid_conversation: "conversationShare.error.invalidConversation",
  unsafe_structure: "conversationShare.error.invalidConversation",
  artifact_protocol_not_ready: "conversationShare.error.invalidConversation",
  invalid_contract: "conversationShare.error.invalidContract",
  disclosure_required: "conversationShare.error.disclosureRequired",
  upload_incomplete: "conversationShare.error.uploadFailed",
  connection_unavailable: "conversationShare.error.connectionUnavailable",
} as const;

const PUBLISH_ERROR_MESSAGE_BY_REASON: Readonly<Record<string, string>> = {
  running_turn: "conversationShare.error.runningTurn",
  streaming_row: "conversationShare.error.streamingRow",
  active_tool_call: "conversationShare.error.activeToolCall",
  active_subagent: "conversationShare.error.activeSubagent",
  input_attachment: "conversationShare.error.inputAttachment",
  inline_tool_image: "conversationShare.error.inlineToolImage",
  unsupported_timeline: "conversationShare.error.unsupportedTimeline",
  unsafe_url: "conversationShare.error.unsafeUrl",
  missing_product_turn: "conversationShare.error.missingProductTurn",
  invalid_selection: "conversationShare.error.invalidSelection",
  artifact_type_not_allowed: "conversationShare.error.artifactTypeNotAllowed",
  artifact_extension_missing: "conversationShare.error.artifactExtensionMissing",
  artifact_outside_workspace: "conversationShare.error.artifactOutsideWorkspace",
  artifact_changed: "conversationShare.error.artifactChanged",
  artifact_read_failed: "conversationShare.error.artifactReadFailed",
  artifact_size_limit: "conversationShare.error.artifactSizeLimit",
  artifact_manifest: "conversationShare.error.artifactManifest",
  no_shareable_content: "conversationShare.error.noShareableContent",
  payload_limit: "conversationShare.error.payloadLimit",
} as const;

const SAFE_DIAGNOSTIC_KEYS = new Set([
  "rowKind",
  "rowId",
  "field",
  "artifactType",
  "extension",
  "phase",
  "expectedBytes",
  "actualBytes",
]);

function sanitizeIssue(issue: unknown): ConversationShareFailureIssue | null {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
  const value = issue as Record<string, unknown>;
  if (typeof value.code !== "string" || typeof value.scope !== "string") return null;
  const safeString = (candidate: unknown): string | undefined =>
    typeof candidate === "string" && candidate.length <= 128 && !/[\\/]|:\/\//u.test(candidate)
      ? candidate
      : undefined;
  const safeMimeType = (candidate: unknown): string | undefined =>
    typeof candidate === "string" &&
    candidate.length <= 128 &&
    /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(candidate)
      ? candidate
      : undefined;
  const artifactDisplayName = safeString(value.artifactDisplayName);
  const allowedFormats = Array.isArray(value.allowedFormats)
    ? value.allowedFormats.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length <= 128 && !/[\\/]|:\/\//u.test(entry),
      )
    : undefined;
  const allowedArtifacts = Array.isArray(value.allowedArtifacts)
    ? value.allowedArtifacts.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const artifact = entry as Record<string, unknown>;
        if (
          typeof artifact.type !== "string" ||
          artifact.type.length === 0 ||
          artifact.type.length > 64 ||
          /[\\/]|:\/\//u.test(artifact.type)
        ) {
          return [];
        }
        const extensions = Array.isArray(artifact.extensions)
          ? artifact.extensions.filter(
              (item): item is string =>
                typeof item === "string" && item.length <= 32 && !/[\\/]|:\/\//u.test(item),
            )
          : [];
        const mimeTypes = Array.isArray(artifact.mimeTypes)
          ? artifact.mimeTypes.filter(
              (item): item is string =>
                typeof item === "string" && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(item),
            )
          : [];
        if (extensions.length === 0 || mimeTypes.length === 0) return [];
        return [
          {
            type: artifact.type,
            extensions,
            mimeTypes,
            ...(typeof artifact.displayName === "string" &&
            artifact.displayName.length <= 64 &&
            !/[\\/]|:\/\//u.test(artifact.displayName)
              ? { displayName: artifact.displayName }
              : {}),
          },
        ];
      })
    : undefined;
  const availability =
    value.availability === "not_found" ||
    value.availability === "permission_denied" ||
    value.availability === "connection_unavailable" ||
    value.availability === "changed" ||
    value.availability === "unknown"
      ? value.availability
      : undefined;
  return {
    code: value.code as ConversationShareFailureIssue["code"],
    scope: value.scope as ConversationShareFailureIssue["scope"],
    ...(typeof value.rowId === "number" ? { rowId: value.rowId } : {}),
    ...(typeof value.turnOrdinal === "number" ? { turnOrdinal: value.turnOrdinal } : {}),
    // productTurnId 是「取消选择该轮」的唯一可靠定位依据（turnOrdinal 只用于文案）。
    ...(typeof value.productTurnId === "string" &&
    value.productTurnId.length > 0 &&
    value.productTurnId.length <= 128
      ? { productTurnId: value.productTurnId }
      : {}),
    ...(artifactDisplayName ? { artifactDisplayName } : {}),
    ...(safeString(value.artifactType) ? { artifactType: safeString(value.artifactType) } : {}),
    ...(safeString(value.extension) ? { extension: safeString(value.extension) } : {}),
    ...(safeMimeType(value.mimeType) ? { mimeType: safeMimeType(value.mimeType) } : {}),
    ...(typeof value.actual === "number" ? { actual: value.actual } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
    ...(value.phase === "collecting" ||
    value.phase === "uploading" ||
    value.phase === "checking" ||
    value.phase === "complete"
      ? { phase: value.phase }
      : {}),
    ...(allowedFormats && allowedFormats.length > 0 ? { allowedFormats } : {}),
    ...(allowedArtifacts && allowedArtifacts.length > 0 ? { allowedArtifacts } : {}),
    ...(availability === undefined ? {} : { availability }),
  };
}

function readRecord(error: unknown): Record<string, unknown> | null {
  return error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
}

export function getConversationShareErrorDetails(error: unknown): ConversationShareErrorDetails {
  const record = readRecord(error);
  const nestedDetails = readRecord(record?.details);
  const readField = (key: string): unknown => record?.[key] ?? nestedDetails?.[key];
  const name =
    typeof record?.name === "string"
      ? record.name
      : error instanceof Error
        ? error.name
        : "UnknownError";
  const kind = typeof record?.kind === "string" ? record.kind : "unknown";
  const reasonCodeValue = readField("reasonCode");
  const reasonCode = typeof reasonCodeValue === "string" ? reasonCodeValue : undefined;
  const rawDiagnostics = readField("diagnostics");
  const diagnostics: Record<string, string | number | boolean> = {};
  if (rawDiagnostics && typeof rawDiagnostics === "object" && !Array.isArray(rawDiagnostics)) {
    for (const [key, value] of Object.entries(rawDiagnostics)) {
      if (!SAFE_DIAGNOSTIC_KEYS.has(key)) continue;
      if (
        (typeof value === "string" && !/[\\/]|:\/\//u.test(value)) ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        diagnostics[key] = value;
      }
    }
  }
  const statusValue = readField("status");
  const codeValue = readField("code");
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const code = typeof codeValue === "number" ? codeValue : undefined;
  const requestIdValue = readField("requestId");
  const requestId =
    typeof requestIdValue === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestIdValue)
      ? requestIdValue
      : undefined;
  const clientRequestIdValue = readField("clientRequestId");
  const clientRequestId =
    typeof clientRequestIdValue === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(clientRequestIdValue)
      ? clientRequestIdValue
      : undefined;
  const rawIssues = readField("issues");
  const issues = (Array.isArray(rawIssues) ? rawIssues : [])
    .map(sanitizeIssue)
    .filter((issue): issue is ConversationShareFailureIssue => issue !== null);
  const issueCountValue = readField("issueCount");
  const issueCount = typeof issueCountValue === "number" ? issueCountValue : issues.length;
  const omittedIssueCountValue = readField("omittedIssueCount");
  const omittedIssueCount =
    typeof omittedIssueCountValue === "number"
      ? omittedIssueCountValue
      : Math.max(0, issueCount - issues.length);
  const rejection = conversationShareRejectionSchema.safeParse(readField("rejection"));
  return {
    name,
    kind,
    ...(rejection.success ? { rejection: rejection.data } : {}),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(Object.keys(diagnostics).length === 0 ? {} : { diagnostics }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
    ...(issues.length === 0 ? {} : { issues }),
    ...(issueCount === 0 ? {} : { issueCount }),
    ...(omittedIssueCount === 0 ? {} : { omittedIssueCount }),
  };
}

export function formatConversationShareErrorSummary(error: unknown): {
  titleId: string;
  issueCount: number;
  turnOrdinals: number[];
} {
  const details = getConversationShareErrorDetails(error);
  return {
    titleId: "conversationShare.error.summary",
    issueCount: details.issueCount ?? details.issues?.length ?? 0,
    turnOrdinals: [
      ...new Set(
        (details.issues ?? []).flatMap((issue) =>
          issue.turnOrdinal === undefined ? [] : [issue.turnOrdinal],
        ),
      ),
    ].sort((left, right) => left - right),
  };
}

const ISSUE_MESSAGE_IDS: Readonly<Record<ConversationShareFailureIssue["code"], string>> = {
  authentication_required: "conversationShare.error.authenticationRequired",
  network: "conversationShare.error.network",
  service_unavailable: "conversationShare.error.serviceUnavailable",
  rate_limited: "conversationShare.error.rateLimited",
  feature_disabled: "conversationShare.error.featureDisabled",
  connection_unavailable: "conversationShare.error.connectionUnavailable",
  invalid_contract: "conversationShare.issue.invalidServiceResponse",
  disclosure_required: "conversationShare.error.disclosureRequired",

  artifact_type_not_allowed: "conversationShare.issue.artifactTypeNotAllowed",
  artifact_extension_missing: "conversationShare.issue.artifactExtensionMissing",
  artifact_outside_workspace: "conversationShare.issue.artifactOutsideWorkspace",
  artifact_changed: "conversationShare.issue.artifactChanged",
  content_unavailable: "conversationShare.issue.contentUnavailable",
  artifact_read_failed: "conversationShare.issue.artifactReadFailed",
  input_attachment: "conversationShare.issue.inputAttachment",
  input_attachment_unavailable: "conversationShare.issue.inputAttachmentUnavailable",
  inline_tool_image: "conversationShare.issue.inlineToolImage",
  running_turn: "conversationShare.issue.runningTurn",
  streaming_row: "conversationShare.issue.streamingRow",
  active_tool_call: "conversationShare.issue.activeToolCall",
  active_subagent: "conversationShare.issue.activeSubagent",
  unsupported_timeline: "conversationShare.issue.unsupportedTimeline",
  unsafe_url: "conversationShare.issue.unsafeUrl",
  missing_product_turn: "conversationShare.issue.missingProductTurn",
  invalid_selection: "conversationShare.issue.invalidSelection",
  invalid_conversation: "conversationShare.issue.invalidConversation",
  artifact_protocol_not_ready: "conversationShare.issue.invalidConversation",
  payload_limit: "conversationShare.issue.payloadSizeLimit",
  stale_conversation: "conversationShare.issue.staleConversation",
  rows_limit: "conversationShare.issue.rowsLimit",
  artifact_count_limit: "conversationShare.issue.artifactCountLimit",
  artifact_size_limit: "conversationShare.issue.artifactSizeLimit",
  artifact_total_size_limit: "conversationShare.issue.artifactTotalSizeLimit",
  payload_size_limit: "conversationShare.issue.payloadSizeLimit",
  artifact_manifest: "conversationShare.issue.artifactManifest",
  no_shareable_content: "conversationShare.issue.noShareableContent",
  upload_incomplete: "conversationShare.issue.uploadIncomplete",
  unknown: "conversationShare.issue.unknown",
};

export function resolveConversationShareIssueMessageId(
  issue: ConversationShareFailureIssue,
): string {
  return ISSUE_MESSAGE_IDS[issue.code] ?? ISSUE_MESSAGE_IDS.unknown;
}

/**
 * 非阻断提示用独立文案：issue 版是「请确认文件仍存在后重试」的阻断语气，
 * warning 版要表达「已跳过、发布照常完成」。
 */
const WARNING_MESSAGE_IDS: Readonly<
  Partial<Record<ConversationShareFailureIssue["code"], string>>
> = {
  artifact_type_not_allowed: "conversationShare.warning.artifactTypeSkipped",
  artifact_changed: "conversationShare.warning.artifactChangedSkipped",
  content_unavailable: "conversationShare.issue.contentUnavailable",
  artifact_read_failed: "conversationShare.warning.artifactSkipped",
  input_attachment: "conversationShare.warning.inputAttachmentSkipped",
  input_attachment_unavailable: "conversationShare.warning.inputAttachmentUnavailable",
};

const ARTIFACT_TYPE_LABELS: Readonly<Record<string, { zh: string; en: string }>> = {
  pdf: { zh: "PDF", en: "PDF" },
  pptx: { zh: "PPT", en: "PowerPoint" },
  docx: { zh: "Word 文档", en: "Word document" },
  xlsx: { zh: "Excel 表格", en: "Excel spreadsheet" },
  image: { zh: "图片", en: "image" },
  html: { zh: "HTML", en: "HTML" },
  md: { zh: "Markdown", en: "Markdown" },
  text: { zh: "纯文本", en: "plain text" },
  video: { zh: "视频", en: "video" },
  audio: { zh: "音频", en: "audio" },
};

// 这里只有中英两套文案：中文界面用中文，其它界面语言（含 ja-JP/ru-RU/ko-KR）用英文。
function isChineseShareLocale(locale: string): boolean {
  return locale === "zh-CN";
}

function artifactLabel(value: string, locale: string): string {
  const key = value.replace(/^\./u, "").toLowerCase();
  return (
    ARTIFACT_TYPE_LABELS[key]?.[isChineseShareLocale(locale) ? "zh" : "en"] ?? value.toUpperCase()
  );
}

export function formatConversationShareArtifactType(
  issue: ConversationShareFailureIssue,
  locale: string,
): string {
  const value = issue.artifactType || issue.extension || issue.mimeType || "文件";
  return artifactLabel(value, locale);
}

export function formatConversationShareAllowedArtifacts(
  issue: ConversationShareFailureIssue,
  locale: string,
): string {
  if (issue.allowedArtifacts && issue.allowedArtifacts.length > 0) {
    const labels = issue.allowedArtifacts.map((artifact) =>
      artifactLabel(artifact.displayName || artifact.type, locale),
    );
    return [...new Set(labels)].join(isChineseShareLocale(locale) ? "、" : ", ");
  }
  if (issue.allowedFormats && issue.allowedFormats.length > 0) {
    return issue.allowedFormats.join(isChineseShareLocale(locale) ? "、" : ", ");
  }
  return isChineseShareLocale(locale) ? "暂时无法获取" : "temporarily unavailable";
}

export function resolveConversationShareWarningMessageId(
  issue: ConversationShareFailureIssue,
): string {
  return WARNING_MESSAGE_IDS[issue.code] ?? resolveConversationShareIssueMessageId(issue);
}

/** Host 侧已脱敏，这里仍复用同一套校验兜底，避免 progress 载荷被改动后泄漏路径。 */
export function sanitizeConversationShareWarnings(
  value: unknown,
): readonly ConversationShareFailureIssue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeIssue)
    .filter(
      (issue): issue is ConversationShareFailureIssue =>
        issue !== null &&
        issue.code !== "inline_tool_image" &&
        issue.code !== "unsupported_timeline",
    );
}

export function resolveConversationShareFallbackIssueCode(
  details: ConversationShareErrorDetails,
): ConversationShareFailureIssue["code"] {
  const reasonCode = details.reasonCode as ConversationShareFailureIssue["code"] | undefined;
  if (reasonCode && Object.prototype.hasOwnProperty.call(ISSUE_MESSAGE_IDS, reasonCode)) {
    return reasonCode;
  }
  if (details.kind === "invalid_conversation") return "invalid_conversation";
  if (details.kind === "artifact_not_allowed") return "artifact_type_not_allowed";
  if (details.kind === "limit_exceeded") return "payload_limit";
  if (details.kind === "upload_incomplete") return "upload_incomplete";
  // 预检可能在读取 capabilities 前因缺少登录态失败，不能把已知 kind 丢成 unknown。
  if (Object.prototype.hasOwnProperty.call(ISSUE_MESSAGE_IDS, details.kind)) {
    return details.kind as ConversationShareFailureIssue["code"];
  }
  return "unknown";
}

export function resolveConversationSharePublishErrorMessageId(error: unknown): string {
  const { kind, reasonCode, status } = getConversationShareErrorDetails(error);
  if (kind === "invalid_contract" && status !== undefined && status >= 400)
    return "conversationShare.error.invalidContractHttp";
  if (reasonCode && PUBLISH_ERROR_MESSAGE_BY_REASON[reasonCode]) {
    return PUBLISH_ERROR_MESSAGE_BY_REASON[reasonCode];
  }
  return PUBLISH_ERROR_MESSAGE_BY_KIND[kind] ?? "conversationShare.publishFailed";
}
