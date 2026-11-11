import type {
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@/conversation-share-interaction/contract.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
} from "@/lib/conversationShareError.js";
import {
  buildConversationSharePreflightCacheEntries,
  conversationShareTurnFingerprint,
} from "@/v4/conversationSharePreflightCache.js";

type PreflightMeta = Pick<
  ConversationSharePreflightResult,
  "revision" | "logEpoch" | "capabilitiesFingerprint" | "supportedArtifactTypes" | "ttlOptions"
>;

/** 响应只提交到 SessionPane 持有的缓存；请求代际仍由 scheduler 和 isCurrent 共同约束。 */
export function createConversationSharePreflightResponseHandlers({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  missingProductTurnIds,
  requestRows,
  selectedShareTurnFingerprints,
  sharePreflightCacheRef,
  sharePreflightMetaRef,
  sharePreflightCacheKey,
  isCurrent,
  onUpdated,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  missingProductTurnIds: readonly string[];
  requestRows: readonly ConversationRow[];
  selectedShareTurnFingerprints: ReadonlyMap<string, string>;
  sharePreflightCacheRef: {
    current: Map<string, ConversationShareTurnPreflightResult>;
  };
  sharePreflightMetaRef: { current: PreflightMeta };
  sharePreflightCacheKey: (productTurnId: string) => string;
  isCurrent: () => boolean;
  onUpdated: () => void;
}): {
  onResolved: (result: ConversationSharePreflightResult) => void;
  onRejected: (error: unknown) => void;
  onError: (error: unknown) => void;
} {
  return {
    onResolved: (result) => {
      if (!isCurrent()) return;
      // Bug 根因：dev 下 host 进程不随 services 重建重启，老 host 返回的结果没有
      // turnResults，直接 .map 会抛异常并被下游 catch 报成「服务端预检失败」。
      // 拆条目的降级逻辑收敛在 helper 里，见 conversationSharePreflightCache。
      const resultTurnFingerprints = new Map(
        missingProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(requestRows, productTurnId, workspacePath, {
            workspaceKey: workspaceIdentity?.trim() || workspacePath,
            remoteSessionId: remoteSessionId ?? "",
            sessionId,
            revision: result.revision,
            logEpoch: result.logEpoch,
            capabilitiesFingerprint: result.capabilitiesFingerprint,
          }),
        ]),
      );
      const entries = buildConversationSharePreflightCacheEntries(
        result,
        missingProductTurnIds,
        resultTurnFingerprints,
      );
      // 条目构建失败时保持旧元信息，否则错误终态的 fingerprint 会立即失效。
      sharePreflightMetaRef.current = {
        revision: result.revision,
        logEpoch: result.logEpoch,
        capabilitiesFingerprint: result.capabilitiesFingerprint,
        supportedArtifactTypes: result.supportedArtifactTypes,
        ...(result.ttlOptions ? { ttlOptions: result.ttlOptions } : {}),
      };
      for (const entry of entries) {
        sharePreflightCacheRef.current.set(sharePreflightCacheKey(entry.productTurnId), entry);
      }
      onUpdated();
    },
    onRejected: (error: unknown) => {
      // 只有 RPC / 服务端真实失败才走这里；成功回调里的渲染层异常由末尾 catch 兜住，
      // 分别记录诊断日志。issues 缺失时兜底成 unknown，并允许重新检查。
      const details = getConversationShareErrorDetails(error);
      logger.warn("[v4-share] 会话分享预检失败", {
        sessionId,
        turnCount: missingProductTurnIds.length,
        name: details.name,
        kind: details.kind,
        reasonCode: details.reasonCode,
        issueCount: details.issueCount ?? 0,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!isCurrent()) return;
      const issues =
        details.issues && details.issues.length > 0
          ? details.issues
          : [
              {
                code: resolveConversationShareFallbackIssueCode(details),
                scope: "transport" as const,
              },
            ];
      for (const productTurnId of missingProductTurnIds) {
        sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
          productTurnId,
          turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
          blockingIssues: issues,
          skippableWarnings: [],
          deferredIssues: [],
        });
      }
      onUpdated();
    },
    onError: (error: unknown) => {
      if (!isCurrent()) return;
      // 处理异常也必须结束 checking；保留当前指纹，让现有问题入口提供重试。
      for (const productTurnId of missingProductTurnIds) {
        sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
          productTurnId,
          turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
          blockingIssues: [{ code: "unknown", scope: "transport" }],
          skippableWarnings: [],
          deferredIssues: [],
        });
      }
      onUpdated();
      logger.error("[v4-share] 会话分享预检结果处理异常", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  };
}
