/* oxlint-disable eslint(max-lines) -- 公开 Row 的 allow-list 构建与闭包校验必须同处一个策略边界，拆分会让 builder/validator 规则漂移。 */
import {
  projectShareToolDisplay,
  conversationShareContentBlockSchema,
  type ConversationShareContentBlock,
  type ConversationShareArtifactDescriptor,
} from "@zcode/shared";
import { toolCallDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import type {
  ArtifactRow,
  WireConversationRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";

import { ConversationShareServiceError } from "./conversationShare.js";

import type { ShareContentDraft } from "./conversationShareWorkflowSnapshot.js";

export interface ConversationSharePublicProjection {
  contentBlocks?: ConversationShareContentBlock[];
  rows: WireConversationRow[];
  selectedProductTurnIds: string[];
  artifacts: ConversationSharePublicArtifact[];
}

export interface ConversationSharePublicArtifact {
  sourceRef: string;
  descriptor: ConversationShareArtifactDescriptor;
}

interface PublicIdMaps {
  productTurnIds: Map<string, string>;
  turnIds: Map<string, string>;
  entityIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  artifactIds: Map<string, string>;
  artifactKeys: Map<string, string>;
}

const ACTIVE_TOOL_STATUSES = new Set(["inputStreaming", "pendingApproval", "running"]);
const PUBLIC_PRODUCT_TURN_ID = /^share-product-turn-[1-9]\d*$/u;
const PUBLIC_TURN_ID = /^share-turn-[1-9]\d*$/u;
const PUBLIC_ENTITY_ID = /^share-entity-[1-9]\d*$/u;
const PUBLIC_TOOL_CALL_ID = /^share-tool-call-[1-9]\d*$/u;
const PUBLIC_ARTIFACT_ID = /^share-artifact-[1-9]\d*$/u;

function throwProjectionError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
  diagnostics?: { rowKind?: string; rowId?: number; field?: string },
): never {
  throw new ConversationShareServiceError(kind, message, { diagnostics });
}

function visitStrings(value: unknown, visitor: (value: string) => void): void {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitStrings(entry, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      visitStrings(entry, visitor);
    }
  }
}

function assertSafeString(value: string): void {
  if (/^zcode-artifact:\/\//iu.test(value)) {
    throwProjectionError(
      "artifact_protocol_not_ready",
      "Artifact references must be represented by formal conversation artifact rows",
    );
  }
  // URI 前缀不能判定文本是否为附件；普通 file/data 文本保留，附件由正式引用校验。
}

// display 的闭集独立于 row.kind 演进；复用正式 schema，避免浅拷贝把未知嵌套字段送到 confirm。
function projectToolDisplay(row: ToolCallRow) {
  const parsed = toolCallDisplaySchema.safeParse(row.display);
  if (!parsed.success) {
    throwProjectionError("invalid_conversation", "Invalid tool display in shared conversation", {
      rowKind: row.kind,
      rowId: row.rowId,
      field: ["display", ...(parsed.error.issues[0]?.path ?? [])].join("."),
    });
  }
  // 插件交互资源属于宿主能力，公开卡片只保留 MCP 的静态描述。
  if (parsed.data.kind === "mcp_tool") {
    const { ui: _ui, ...display } = parsed.data;
    return display;
  }
  return parsed.data;
}

function isPublicArtifactRef(value: string): boolean {
  return /^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u.test(value);
}

function assertTerminalAndSafe(rows: WireConversationRow[]): void {
  for (const row of rows) {
    if (row.productTurnId === undefined) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation row is missing its product turn identity",
      );
    }
    if (row.kind === "turnHeader" && row.state === "running") {
      throwProjectionError("invalid_conversation", "Running turns cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      throwProjectionError("invalid_conversation", "Streaming rows cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (row.kind === "toolCall" && ACTIVE_TOOL_STATUSES.has(row.status)) {
      throwProjectionError("invalid_conversation", "Active tool calls cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (row.kind === "subagent" && row.status === "running") {
      throwProjectionError("invalid_conversation", "Active subagents cannot be shared", {
        rowKind: row.kind,
        rowId: row.rowId,
      });
    }
    if (
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running"))
    ) {
      throwProjectionError("invalid_conversation", "Active timeline operations cannot be shared");
    }
    if (row.kind === "toolCall") {
      if (row.display?.kind === "node_repl_images") {
        throwProjectionError("unsafe_structure", "Inline tool images cannot be shared", {
          rowKind: row.kind,
          rowId: row.rowId,
        });
      }
    }
    if (row.kind === "timelineMarker") {
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Timeline references outside the shared projection are not supported",
        );
      }
      if (row.marker.type === "compact" && row.marker.summaryRef !== undefined) {
        throwProjectionError(
          "artifact_protocol_not_ready",
          "Conversation summary references require the artifact row protocol",
        );
      }
    }
    // artifact.ref 是 Host 内部授权的读取引用，公开投影会替换；它不能参与通用 URL 泄漏检查。
    if (row.kind === "artifact") {
      const { ref: _localRef, ...safeFields } = row;
      visitStrings(safeFields, assertSafeString);
    } else if (row.kind === "toolCall" && row.output) {
      // truncated.ref 只用于本地按需读取大工具输出，公开投影本来就只保留 output.text；
      // 对不会出现在请求里的内部 ref 做安全校验会误阻断同一轮正式结果物上传。
      visitStrings({ ...row, output: { text: row.output.text } }, assertSafeString);
    } else if (row.kind === "userInput") {
      const { attachments: _attachments, ...safeFields } = row;
      visitStrings(safeFields, assertSafeString);
    } else {
      visitStrings(row, assertSafeString);
    }
  }
}

function allocateIds(values: Iterable<string>, prefix: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    if (!result.has(value)) {
      result.set(value, `${prefix}-${result.size + 1}`);
    }
  }
  return result;
}

function requiredMappedId(ids: Map<string, string>, sourceId: string, label: string): string {
  const mapped = ids.get(sourceId);
  if (!mapped) {
    throwProjectionError(
      "invalid_conversation",
      `Conversation ${label} reference is outside the shared projection`,
    );
  }
  return mapped;
}

function buildIdMaps(rows: WireConversationRow[], selectedProductTurnIds: string[]): PublicIdMaps {
  return {
    productTurnIds: allocateIds(selectedProductTurnIds, "share-product-turn"),
    turnIds: allocateIds(
      rows.map((row) => row.turnId),
      "share-turn",
    ),
    entityIds: allocateIds(
      rows.flatMap((row) => (row.entityId ? [row.entityId] : [])),
      "share-entity",
    ),
    toolCallIds: allocateIds(
      rows.flatMap((row) => (row.kind === "toolCall" ? [row.toolCallId] : [])),
      "share-tool-call",
    ),
    artifactIds: allocateIds(
      rows.flatMap((row) => (row.kind === "artifact" ? [row.artifactVersionId] : [])),
      "share-artifact",
    ),
    artifactKeys: allocateIds(
      rows.flatMap((row) => (row.kind === "artifact" ? [row.logicalArtifactKey] : [])),
      "share-artifact-key",
    ),
  };
}

function projectBase(row: WireConversationRow, index: number, ids: PublicIdMaps) {
  if (!row.productTurnId) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation row is missing its product turn identity",
    );
  }
  return {
    rowId: index + 1,
    turnId: requiredMappedId(ids.turnIds, row.turnId, "turn"),
    ...(row.entityId
      ? {
          entityId: requiredMappedId(ids.entityIds, row.entityId, "entity"),
        }
      : {}),
    productTurnId: requiredMappedId(ids.productTurnIds, row.productTurnId, "product turn"),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    createdAt: row.createdAt,
    createdAtSeq: row.createdAtSeq,
  } as const;
}

function projectTimelineMarker(
  row: Extract<WireConversationRow, { kind: "timelineMarker" }>,
): Extract<WireConversationRow, { kind: "timelineMarker" }>["marker"] {
  switch (row.marker.type) {
    case "compact":
      return {
        type: "compact",
        origin: row.marker.origin,
        status: row.marker.status,
        ...(row.marker.tokensBefore === undefined ? {} : { tokensBefore: row.marker.tokensBefore }),
        ...(row.marker.tokensAfter === undefined ? {} : { tokensAfter: row.marker.tokensAfter }),
      };
    case "modelChange":
      return { ...row.marker };
    case "goalSet":
      return { ...row.marker };
    case "goalVerify":
      return { ...row.marker };
    case "retryNotice":
      return { ...row.marker };
    case "forkNotice":
    case "forkCreated":
    case "checkpointRestored":
    // 已在 retainedRows 中过滤；走到这里说明调用方绕过了过滤。
    case "worktreeCreated":
      throwProjectionError(
        "invalid_conversation",
        "Timeline references outside the shared projection are not supported",
      );
  }
}

/**
 * 每类 Row 用 allow-list 新建对象。
 *
 * 这个 switch 故意穷尽且**不带 default**：返回类型非可选，所以 conversationRowSchema 新增
 * 一种 kind 时这里会编译失败。那是有意的闸门——公开投影是跨版本数据交换格式，往里加一种
 * 老客户端读不了的 kind 必须是个显式决定，不能靠 default 悄悄放过去。
 */
function projectRow(
  row: WireConversationRow,
  index: number,
  ids: PublicIdMaps,
): WireConversationRow {
  const base = projectBase(row, index, ids);
  switch (row.kind) {
    case "turnHeader":
      return {
        ...base,
        kind: "turnHeader",
        origin: row.origin,
        ...(row.executionKind ? { executionKind: row.executionKind } : {}),
        state: row.state,
        startedAt: row.startedAt,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        ...(row.activeMs === undefined ? {} : { activeMs: row.activeMs }),
        ...(row.workSegments
          ? {
              workSegments: row.workSegments.map((segment) => ({
                segmentId: segment.segmentId,
                ...(segment.triggerEntityId
                  ? {
                      triggerEntityId: requiredMappedId(
                        ids.entityIds,
                        segment.triggerEntityId,
                        "work segment entity",
                      ),
                    }
                  : {}),
                startedAt: segment.startedAt,
                ...(segment.endedAt === undefined ? {} : { endedAt: segment.endedAt }),
                ...(segment.activeMs === undefined ? {} : { activeMs: segment.activeMs }),
              })),
            }
          : {}),
        ...(row.fileChanges ? { fileChanges: { ...row.fileChanges } } : {}),
      };
    case "userInput": {
      const originMeta = row.originMeta
        ? {
            ...(row.originMeta.backgroundSource
              ? { backgroundSource: row.originMeta.backgroundSource }
              : {}),
            ...(row.originMeta.senderLabel ? { senderLabel: row.originMeta.senderLabel } : {}),
          }
        : undefined;
      const attachments = row.attachments?.flatMap((attachment) => {
        if (!isPublicArtifactRef(attachment.ref)) return [];
        if (attachment.previewRef !== undefined && !isPublicArtifactRef(attachment.previewRef)) {
          return [];
        }
        return [
          {
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
            ...(attachment.previewRef ? { previewRef: attachment.previewRef } : {}),
          },
        ];
      });
      return {
        ...base,
        kind: "userInput",
        text: row.text,
        origin: row.origin,
        ...(originMeta && Object.keys(originMeta).length > 0 ? { originMeta } : {}),
        ...(row.guided ? { guided: row.guided } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
    }
    case "assistantText":
      return {
        ...base,
        kind: "assistantText",
        text: row.text,
        state: row.state,
        ...(row.model ? { model: row.model } : {}),
      };
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        text: row.text,
        state: row.state,
        ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      };
    case "toolCall":
      return {
        ...base,
        kind: "toolCall",
        toolCallId: requiredMappedId(ids.toolCallIds, row.toolCallId, "tool call"),
        toolName: row.toolName,
        status: row.status,
        inputText: row.inputText,
        ...(row.input === undefined ? {} : { input: row.input }),
        ...(row.output ? { output: { text: row.output.text } } : {}),
        ...(row.display ? { display: projectToolDisplay(row) } : {}),
        ...(row.error ? { error: { ...row.error } } : {}),
        ...(row.backgrounded ? { backgrounded: row.backgrounded } : {}),
        ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
      };
    case "artifact": {
      const artifactVersionId = requiredMappedId(
        ids.artifactIds,
        row.artifactVersionId,
        "artifact",
      );
      return {
        ...base,
        kind: "artifact",
        artifactVersionId,
        logicalArtifactKey: requiredMappedId(
          ids.artifactKeys,
          row.logicalArtifactKey,
          "artifact key",
        ),
        displayName: row.displayName,
        artifactType: row.artifactType,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        ref: `zcode-artifact://share/${artifactVersionId}`,
        state: row.state,
      };
    }
    case "timelineMarker":
      return {
        ...base,
        kind: "timelineMarker",
        ...(row.lane ? { lane: row.lane } : {}),
        marker: projectTimelineMarker(row),
      };
    case "subagent":
      throwProjectionError(
        "invalid_conversation",
        "Subagent detail rows must be filtered before public projection",
      );
    case "hookInvocation":
      throwProjectionError(
        "invalid_conversation",
        "Hook invocation rows are not part of the V1 public projection",
      );
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throwProjectionError(
      "invalid_conversation",
      `Conversation public ${label} identities must be unique`,
    );
  }
}

export function assertConversationSharePublicProjection(input: {
  rows: WireConversationRow[];
  selectedProductTurnIds: string[];
}): void {
  if (input.rows.length === 0 || input.selectedProductTurnIds.length === 0) {
    throwProjectionError("invalid_conversation", "Conversation public projection cannot be empty");
  }
  assertTerminalAndSafe(input.rows);
  assertUnique(input.selectedProductTurnIds, "product turn");
  if (
    input.selectedProductTurnIds.some(
      (productTurnId) => !PUBLIC_PRODUCT_TURN_ID.test(productTurnId),
    )
  ) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation public product turn identity is invalid",
    );
  }

  const selectedProductTurnIds = new Set(input.selectedProductTurnIds);
  const headerCounts = new Map<string, number>();
  const entityIds = new Set<string>();
  const toolCallIds: string[] = [];
  const artifactIds: string[] = [];
  const turnIds = new Set<string>();

  for (const [index, row] of input.rows.entries()) {
    if (row.rowId !== index + 1) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public row identities must be contiguous",
      );
    }
    if (!PUBLIC_TURN_ID.test(row.turnId)) {
      throwProjectionError("invalid_conversation", "Conversation public turn identity is invalid");
    }
    turnIds.add(row.turnId);
    if (
      !row.productTurnId ||
      !PUBLIC_PRODUCT_TURN_ID.test(row.productTurnId) ||
      !selectedProductTurnIds.has(row.productTurnId)
    ) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation row belongs to an unselected product turn",
      );
    }
    if (row.entityId) {
      if (!PUBLIC_ENTITY_ID.test(row.entityId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public entity identity is invalid",
        );
      }
      // entityId 是持久实体身份，同一实体可以对应多个 Row；这里只收集引用闭包，不校验 Row 间唯一性。
      entityIds.add(row.entityId);
    }
    if (row.actions !== undefined) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public rows cannot contain local actions",
      );
    }
    if (row.kind === "turnHeader") {
      headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
      if (row.originMeta !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public turn headers cannot contain local work identity",
        );
      }
    } else if (row.kind === "userInput") {
      if (
        row.sourceCommandId !== undefined ||
        row.rootSourceCommandId !== undefined ||
        row.clientId !== undefined ||
        row.originMeta?.workId !== undefined ||
        row.originMeta?.senderSessionId !== undefined
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public input contains local write identity",
        );
      }
      for (const attachment of row.attachments ?? []) {
        if (!isPublicArtifactRef(attachment.ref)) {
          throwProjectionError(
            "invalid_conversation",
            "Conversation public input attachment reference is invalid",
          );
        }
        if (attachment.previewRef !== undefined && !isPublicArtifactRef(attachment.previewRef)) {
          throwProjectionError(
            "invalid_conversation",
            "Conversation public input preview reference is invalid",
          );
        }
      }
    } else if (row.kind === "assistantText") {
      if (row.feedback !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public assistant text contains local feedback",
        );
      }
    } else if (row.kind === "toolCall") {
      if (!PUBLIC_TOOL_CALL_ID.test(row.toolCallId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public tool call identity is invalid",
        );
      }
      toolCallIds.push(row.toolCallId);
      if (
        row.progress !== undefined ||
        row.approvalInteractionId !== undefined ||
        row.workId !== undefined
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public tool call contains local runtime identity",
        );
      }
    } else if (row.kind === "artifact") {
      if (
        !PUBLIC_ARTIFACT_ID.test(row.artifactVersionId) ||
        row.ref !== `zcode-artifact://share/${row.artifactVersionId}`
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public artifact identity is invalid",
        );
      }
      artifactIds.push(row.artifactVersionId);
    } else if (row.kind === "timelineMarker") {
      if (row.sourceCommandId !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public timeline contains local command identity",
        );
      }
    } else if (row.kind === "subagent") {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public projection cannot contain subagent details",
      );
    }
  }

  assertUnique(toolCallIds, "tool call");
  assertUnique(artifactIds, "artifact");
  if (turnIds.size === 0) {
    throwProjectionError("invalid_conversation", "Conversation public projection has no turns");
  }
  for (const productTurnId of input.selectedProductTurnIds) {
    if (headerCounts.get(productTurnId) !== 1) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public product turns require exactly one header",
      );
    }
  }

  for (const row of input.rows) {
    if (row.kind !== "turnHeader") continue;
    for (const segment of row.workSegments ?? []) {
      if (segment.triggerEntityId !== undefined && !entityIds.has(segment.triggerEntityId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation work segment entity reference is unresolved",
        );
      }
    }
  }
}

export function buildConversationSharePublicProjection(input: {
  rows: WireConversationRow[];
  selectedProductTurnIds: string[];
  additionalArtifacts?: ConversationSharePublicArtifact[];
  contentDrafts?: ShareContentDraft[];
  toolPresentation?: boolean;
  toolImages?: ReadonlyMap<number, Array<{ resourceId: string; mimeType: string }>>;
  sourceRows?: readonly WireConversationRow[];
}): ConversationSharePublicProjection {
  assertTerminalAndSafe(input.rows);
  assertUnique(input.selectedProductTurnIds, "source product turn");
  if (input.selectedProductTurnIds.length === 0) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation product turn selection cannot be empty",
    );
  }

  const selectedProductTurnIds = new Set(input.selectedProductTurnIds);
  if (
    input.rows.some((row) => !row.productTurnId || !selectedProductTurnIds.has(row.productTurnId))
  ) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation rows fall outside the selected product turns",
    );
  }

  // 本地运行投影包含 subagent 详情和写入态标识，不能直接作为公开载荷；
  // 必须先过滤非 V1 Row，再基于剩余内容生成一套闭合的公开 ID。
  // "已创建 worktree"标记含本机路径与 git 输出，属于本地执行环境，不进入公开载荷。
  const retainedRows = input.rows.filter(
    (row) =>
      row.kind !== "subagent" &&
      row.kind !== "hookInvocation" &&
      !(row.kind === "timelineMarker" && row.marker.type === "worktreeCreated"),
  );
  const sourceArtifactRows = retainedRows.filter(
    (row): row is ArtifactRow => row.kind === "artifact",
  );
  assertUnique(
    sourceArtifactRows.map((row) => row.artifactVersionId),
    "source artifact",
  );
  assertUnique(
    sourceArtifactRows.map((row) => row.logicalArtifactKey),
    "source artifact logical key",
  );
  const ids = buildIdMaps(retainedRows, input.selectedProductTurnIds);
  const rows = retainedRows.map((row, index) => projectRow(row, index, ids));
  const artifacts = sourceArtifactRows.map((sourceRow) => {
    const projected = rows.find(
      (row): row is ArtifactRow =>
        row.kind === "artifact" &&
        row.artifactVersionId === ids.artifactIds.get(sourceRow.artifactVersionId),
    );
    if (!projected?.productTurnId) {
      throwProjectionError("invalid_conversation", "Projected artifact row is missing");
    }
    const extension = extensionOf(projected.displayName);
    return {
      sourceRef: sourceRow.ref,
      descriptor: {
        artifact_id: projected.artifactVersionId,
        logical_artifact_key: projected.logicalArtifactKey,
        producer_product_turn_id: projected.productTurnId,
        artifact_version: 1,
        state: projected.state,
        ref: projected.ref,
        artifact_type: projected.artifactType,
        display_name: projected.displayName,
        extension,
        mime_type: projected.mimeType,
        size_bytes: projected.sizeBytes,
        sha256: projected.sha256,
      },
    };
  });
  const additionalArtifacts = (input.additionalArtifacts ?? []).map((artifact) => ({
    ...artifact,
    descriptor: {
      ...artifact.descriptor,
      producer_product_turn_id: requiredMappedId(
        ids.productTurnIds,
        artifact.descriptor.producer_product_turn_id,
        "input attachment product turn",
      ),
    },
  }));
  const allArtifactIds = [
    ...artifacts.map((artifact) => artifact.descriptor.artifact_id),
    ...additionalArtifacts.map((artifact) => artifact.descriptor.artifact_id),
  ];
  assertUnique(allArtifactIds, "artifact manifest");
  const projection: ConversationSharePublicProjection = {
    rows,
    selectedProductTurnIds: input.selectedProductTurnIds.map((productTurnId) =>
      requiredMappedId(ids.productTurnIds, productTurnId, "product turn"),
    ),
    artifacts: [...artifacts, ...additionalArtifacts],
  };
  if (input.contentDrafts?.length) {
    projection.contentBlocks = input.contentDrafts.map((draft, index) => {
      const entityId = requiredMappedId(ids.entityIds, draft.entityId, "content fallback");
      const fallback = rows.find((row) => row.entityId === entityId);
      if (!fallback) throwProjectionError("invalid_conversation", "Content fallback is missing");
      const contentArtifacts = draft.payload.artifacts.map((artifact) =>
        "resource_id" in artifact && artifact.resource_id
          ? {
              ...artifact,
              resource_id: requiredMappedId(
                ids.artifactIds,
                artifact.resource_id,
                "content resource",
              ),
            }
          : artifact,
      );
      return conversationShareContentBlockSchema.parse({
        id: `share-content-${index + 1}`,
        type: "workflow",
        version: draft.version ?? 1,
        product_turn_id: requiredMappedId(ids.productTurnIds, draft.productTurnId, "content turn"),
        fallback_row_id: fallback.rowId,
        captured_at: draft.capturedAt,
        resource_ids: contentArtifacts.flatMap((artifact) =>
          "resource_id" in artifact && artifact.resource_id ? [artifact.resource_id] : [],
        ),
        payload: { ...draft.payload, artifacts: contentArtifacts },
      });
    });
  }
  if (input.toolPresentation) {
    const originalRows = new Map(input.sourceRows?.map((row) => [row.rowId, row] as const) ?? []);
    const agentTypes = new Map(
      input.sourceRows?.flatMap((row) =>
        row.kind === "subagent" ? [[row.parentToolCallId, row.subagentType] as const] : [],
      ) ?? [],
    );
    const toolBlocks = retainedRows.flatMap((sourceRow, index) => {
      if (sourceRow.kind !== "toolCall") return [];
      const display = projectShareToolDisplay(sourceRow.output?.display);
      const images = (input.toolImages?.get(sourceRow.rowId) ?? []).flatMap((image) => {
        const id = ids.artifactIds.get(image.resourceId);
        return id ? [{ resource_id: id, mime_type: image.mimeType }] : [];
      });
      const agentType = agentTypes.get(sourceRow.toolCallId);
      const original = originalRows.get(sourceRow.rowId);
      const originalTool = original?.kind === "toolCall" ? original : sourceRow;
      const appName =
        originalTool.cuaApp?.name ??
        (originalTool.output?.display?.kind === "cua"
          ? originalTool.output.display.targetApp?.displayName
          : undefined) ??
        (originalTool.display?.kind === "node_repl_images"
          ? originalTool.display.app?.displayName
          : undefined);
      if (!display && !images.length && !agentType && !appName) return [];
      return [
        conversationShareContentBlockSchema.parse({
          id: `share-content-${(projection.contentBlocks?.length ?? 0) + index + 1}`,
          type: "tool-presentation",
          version: 1,
          product_turn_id: rows[index]!.productTurnId,
          fallback_row_id: rows[index]!.rowId,
          captured_at: sourceRow.endedAt ?? sourceRow.createdAt,
          resource_ids: [...new Set(images.map((image) => image.resource_id))],
          payload: {
            ...(display ? { display } : {}),
            ...(images.length ? { images } : {}),
            ...(agentType ? { agent_type: agentType } : {}),
            ...(appName ? { app_name: appName } : {}),
          },
        }),
      ];
    });
    if (toolBlocks.length)
      projection.contentBlocks = [...(projection.contentBlocks ?? []), ...toolBlocks];
  }
  assertConversationSharePublicProjection(projection);
  return projection;
}

function extensionOf(displayName: string): string {
  const fileName = displayName.trim();
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    throwProjectionError("invalid_conversation", "Conversation artifact extension is missing");
  }
  return fileName.slice(dot + 1).toLowerCase();
}
