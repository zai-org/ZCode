import type {
  ConversationShareFailureIssue,
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@/conversation-share-interaction/contract.js";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ConversationShareTurnFingerprintContext {
  capabilitiesFingerprint?: string;
  logEpoch?: string;
  productTurnId?: string;
  remoteSessionId?: string;
  revision?: number;
  sessionId?: string;
  workspaceKey?: string;
}

export function conversationShareTurnFingerprint(
  rows: readonly ConversationRow[],
  productTurnId: string,
  workspacePath = "",
  context: ConversationShareTurnFingerprintContext = {},
): string {
  const turnRows = rows.filter((row) => row.productTurnId === productTurnId);
  const assistantText = turnRows
    .filter((row): row is Extract<ConversationRow, { kind: "assistantText" }> => {
      return row.kind === "assistantText";
    })
    .map((row) => row.text)
    .join("\n\n");
  const candidateFingerprint = extractConversationPreviewFileReferences(
    assistantText,
    workspacePath,
  ).map((candidate) => ({
    kind: candidate.kind,
    path: candidate.path,
    start: candidate.start,
    end: candidate.end,
  }));
  const signature = turnRows.map((row) => ({
    rowId: row.rowId,
    kind: row.kind,
    state: "state" in row ? row.state : undefined,
    status: "status" in row ? row.status : undefined,
    text: "text" in row ? row.text : undefined,
    fileChanges: row.kind === "turnHeader" ? row.fileChanges : undefined,
    display: row.kind === "toolCall" ? row.display : undefined,
    attachments:
      row.kind === "userInput"
        ? row.attachments?.map((attachment) => ({
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
          }))
        : undefined,
  }));
  return hashString(
    JSON.stringify({
      scope: {
        workspaceKey: context.workspaceKey ?? workspacePath,
        remoteSessionId: context.remoteSessionId ?? "",
        sessionId: context.sessionId ?? "",
      },
      productTurnId: context.productTurnId ?? productTurnId,
      revision: context.revision,
      logEpoch: context.logEpoch,
      capabilitiesFingerprint: context.capabilitiesFingerprint,
      rows: signature,
      previewCandidates: candidateFingerprint,
    }),
  );
}

export function conversationSharePreflightCacheKey(
  scopeKey: string,
  productTurnId: string,
): string {
  return `${scopeKey}\u0000${productTurnId}`;
}

/**
 * 聚合多个 turn 的预检结果时，去掉同一条无法定位到具体轮次/文件的全局错误。
 * 轮次或文件级问题保留各自定位字段，避免把用户真正需要处理的多个问题合并掉。
 */
export function dedupeConversationShareIssues(
  issues: readonly ConversationShareFailureIssue[],
): ConversationShareFailureIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const hasLocator =
      issue.rowId !== undefined ||
      issue.turnOrdinal !== undefined ||
      issue.artifactDisplayName !== undefined;
    // transport/conversation 问题本身就是全局状态；turn/artifact 问题没有定位字段时，
    // 即使内容相同也要保留，避免把多个待处理轮次误合并成一条。
    if (!hasLocator && issue.scope !== "transport" && issue.scope !== "conversation") {
      return true;
    }
    const key = JSON.stringify({
      code: issue.code,
      scope: issue.scope,
      rowId: issue.rowId,
      turnOrdinal: issue.turnOrdinal,
      artifactDisplayName: issue.artifactDisplayName,
      artifactType: issue.artifactType,
      extension: issue.extension,
      mimeType: issue.mimeType,
      actual: issue.actual,
      limit: issue.limit,
      retryAfterMs: issue.retryAfterMs,
      phase: issue.phase,
      allowedFormats: issue.allowedFormats,
      allowedArtifacts: issue.allowedArtifacts,
      availability: issue.availability,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 把一次预检结果拆成按 turn 的缓存条目。
 *
 * dev 下 host 进程不会随 services 重建重启，老 host 返回的结果没有 turnResults，
 * 调用方直接 `.map` 会抛异常并被下游 catch 报成「服务端预检失败」。这里对字段缺失做降级：
 * 找不到某个 turn 的明细就回落到整体 issues，宁可粒度粗一点也不能把成功的预检说成失败。
 */
export function buildConversationSharePreflightCacheEntries(
  result: ConversationSharePreflightResult,
  productTurnIds: readonly string[],
  turnFingerprints: ReadonlyMap<string, string>,
): ConversationShareTurnPreflightResult[] {
  const entriesByProductTurnId = new Map(
    (Array.isArray(result.turnResults) ? result.turnResults : []).map((entry) => [
      entry.productTurnId,
      entry,
    ]),
  );
  return productTurnIds.map((productTurnId) => {
    const entry = entriesByProductTurnId.get(productTurnId);
    return {
      ...(entry ?? {
        blockingIssues: result.blockingIssues,
        skippableWarnings: result.skippableWarnings,
        deferredIssues: result.deferredIssues,
      }),
      productTurnId,
      turnFingerprint: turnFingerprints.get(productTurnId),
    };
  });
}

export function getMissingConversationSharePreflightTurnIds(
  scopeKey: string,
  selectedProductTurnIds: readonly string[],
  cache: ReadonlyMap<string, ConversationShareTurnPreflightResult>,
  turnFingerprints?: ReadonlyMap<string, string>,
): string[] {
  return selectedProductTurnIds.filter((productTurnId) => {
    const entry = cache.get(conversationSharePreflightCacheKey(scopeKey, productTurnId));
    return (
      entry === undefined ||
      (turnFingerprints !== undefined &&
        entry.turnFingerprint !== turnFingerprints.get(productTurnId))
    );
  });
}

/**
 * 行数、产物数量与总大小都是整组选中项的约束，取消/新增轮次后必须重算，不能沿用某一批 RPC 的合计。
 *
 * 产物：Host 不再把这两个聚合阻断项写进按轮结果，只给 artifactBudget。修复原因：此前合计超限项被
 * 挂到每一轮并按轮缓存，取消轮次后不重新预检，旧超限项一直拦住生成；逐轮勾选时每批只算新增轮，
 * 合计永远不超限。这里按去重键合并当前选中轮的文件（跨轮引用同一预览文件只算一次）。
 * 没有 artifactBudget 的条目（旧 Host、或该批因其他阻断提前返回）不参与合计，只会少算，发布时仍复核。
 */
export function aggregateConversationShareBlockingIssues(
  entries: readonly ConversationShareTurnPreflightResult[],
): ConversationShareFailureIssue[] {
  let issues = entries.flatMap((entry) => entry.blockingIssues);
  if (entries.length > 0 && entries.every((entry) => entry.rowBudget)) {
    const actual = entries.reduce((count, entry) => count + entry.rowBudget!.count, 0);
    const limit = Math.min(...entries.map((entry) => entry.rowBudget!.limit));
    issues = [
      ...issues.filter((issue) => issue.code !== "rows_limit"),
      ...(actual > limit
        ? [{ code: "rows_limit" as const, scope: "conversation" as const, actual, limit }]
        : []),
    ];
  }
  const budgets = entries.flatMap((entry) => (entry.artifactBudget ? [entry.artifactBudget] : []));
  if (budgets.length > 0) {
    const items = new Map(
      budgets.flatMap((budget) => budget.items.map((item) => [item.key, item.bytes] as const)),
    );
    const bytes = [...items.values()].reduce((total, value) => total + value, 0);
    const countLimit = Math.min(...budgets.map((budget) => budget.countLimit));
    const bytesLimit = Math.min(...budgets.map((budget) => budget.bytesLimit));
    if (items.size > countLimit) {
      issues.push({
        code: "artifact_count_limit",
        scope: "conversation",
        actual: items.size,
        limit: countLimit,
      });
    }
    if (bytes > bytesLimit) {
      issues.push({
        code: "artifact_total_size_limit",
        scope: "conversation",
        actual: bytes,
        limit: bytesLimit,
      });
    }
  }
  return dedupeConversationShareIssues(issues);
}
