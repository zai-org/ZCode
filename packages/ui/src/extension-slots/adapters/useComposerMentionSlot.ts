import { useEffect, useMemo, useRef, useState } from "react";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  MENTION_ITEMS_ERROR_CODES,
  slotScopeKey,
  type MentionItemsResult,
} from "@zcode/shared/extension-host";
import { logger } from "@/logger.js";
import {
  composerCommandScope,
  selectComposerMentionEntries,
} from "@/extension-slots/domain/slotSelectors.js";
import {
  useExtensionSlotsState,
  useExtensionsService,
} from "@/extension-slots/adapters/useExtensionSlots.js";
import type { ComposerMentionGroup, ComposerMentionSlotProps } from "@/extension-slots/contract.js";

/** 每个条目最近一次发出的查询。键 = 作用域 + query。 */
interface IssuedQuery {
  key: string;
  seq: number;
}

/**
 * composer.mention 的分组（docs/plugins/extension-host.md §16.6）：每个条目一组，候选项由
 * IExtensionsService.provideMentionItems 提供（command 走扩展命令，tool 走 CLI）。
 *
 * 时序（不设计取消）：
 * - 作用域或 query 变了，该条目发一次新查询（seq + 1），记为「最近一次」。
 * - 结果回来时只有 seq 仍是最近一次才采用；更早的结果晚到时丢弃。
 * - 新查询在途时继续显示上次采用的候选项；还没有任何结果时显示加载。
 * - 面板关闭不清结果，同一个键也不重发。原因：tool 的首次调用会在会话里弹审批，审批卡片替换输入框，
 *   编辑器失焦，`@` 面板随之关闭；如果重新打开就重发，拒绝或「允许一次」后每次打开都会再弹审批，
 *   永远看不到结果。代价：再次输入完全相同的查询时显示上次的结果，再输入一个字就会重查。
 */
export function useComposerMentionSlot({
  workspacePath,
  workspaceIdentity,
  sessionId,
  query,
  enabled,
}: ComposerMentionSlotProps): ComposerMentionGroup[] {
  const service = useExtensionsService();
  const { table, snapshot, status } = useExtensionSlotsState(service, (state) => ({
    table: state.table,
    snapshot: state.snapshot,
    status: state.status,
  }));
  const workspace = useMemo(
    () => ({ workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }),
    [workspacePath, workspaceIdentity],
  );
  const entries = useMemo(
    () => selectComposerMentionEntries({ table, snapshot, status }, { workspace, sessionId }),
    [table, snapshot, status, workspace, sessionId],
  );
  // tool 条目在会话的 MCP 连接上调用：要有会话（草稿为预热会话），且只在本机工作区
  // （扩展门面在本机 Host，远程工作区的会话不在本机 CLI 里）。
  const toolAvailable = Boolean(sessionId) && !isRemoteWorkspaceIdentity(workspaceIdentity ?? "");
  const scope = useMemo(() => composerCommandScope(workspace, sessionId), [workspace, sessionId]);
  // entries 随每次快照（动态值增量）换新数组；查询只看稳定的条目 id 列表，避免流式期间反复重查。
  const queryableIds = entries
    .filter((entry) => !entry.hostStopped && (entry.target.kind === "command" || toolAvailable))
    .map((entry) => entry.itemId)
    .join("\n");
  const [results, setResults] = useState<ReadonlyMap<string, MentionItemsResult>>(() => new Map());
  const issuedRef = useRef(new Map<string, IssuedQuery>());
  const seqRef = useRef(0);

  useEffect(() => {
    if (!service || !enabled || !queryableIds) return;
    const key = `${slotScopeKey(scope)}\n${query}`;
    for (const entry of queryableIds.split("\n")) {
      if (issuedRef.current.get(entry)?.key === key) continue;
      seqRef.current += 1;
      const seq = seqRef.current;
      issuedRef.current.set(entry, { key, seq });
      void service
        .provideMentionItems({ entry, query, scope, seq })
        .catch((error: unknown): MentionItemsResult => {
          logger.lifecycle.warn("[extension-slots] mention items failed", {
            entry,
            message: error instanceof Error ? error.message : String(error),
          });
          return { seq, status: "error", code: MENTION_ITEMS_ERROR_CODES.internal };
        })
        .then((result) => {
          if (issuedRef.current.get(entry)?.seq !== seq) {
            logger.debug("[extension-slots] stale mention result dropped", { entry, seq });
            return;
          }
          setResults((current) => new Map(current).set(entry, result));
        });
    }
  }, [enabled, query, queryableIds, scope, service]);

  return useMemo(() => {
    if (!enabled) return [];
    return entries.flatMap((entry): ComposerMentionGroup[] => {
      const base = {
        itemId: entry.itemId,
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
        title: entry.title,
      };
      if (entry.hostStopped) return [{ ...base, state: "stopped", items: [] }];
      if (entry.target.kind === "tool" && !toolAvailable) return [];
      const result = results.get(entry.itemId);
      if (!result) return [{ ...base, state: "loading", items: [] }];
      if (result.status === "unsupported") return [];
      if (result.status === "error") {
        return [{ ...base, state: "error", items: [], errorCode: result.code }];
      }
      return result.items.length > 0 ? [{ ...base, state: "ready", items: result.items }] : [];
    });
  }, [enabled, entries, results, toolAvailable]);
}
