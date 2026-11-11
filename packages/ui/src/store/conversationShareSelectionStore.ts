import { createConversationSharePopoverActions } from "@/conversation-share-interaction/conversationSharePopoverActions.js";
import { create } from "zustand";
import type { ConversationShareAccessMode, ConversationShareRejection } from "@zcode/shared";
import type { ConversationShareFailureIssue } from "@zcode/services";

export const DEFAULT_CONVERSATION_SHARE_ACCESS_MODE: ConversationShareAccessMode =
  "public_importable";

export interface ConversationShareAttempt {
  key: string;
  clientRequestId: string;
  disclosureAcceptedAt: number;
}

export interface ConversationShareDisplayError {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
  requestId?: string;
  clientRequestId?: string;
  operationId?: string;
  status?: number;
  code?: number;
  rejection?: ConversationShareRejection;
  /** 没有服务端 issues 时展示的、按错误类型解析出的可行动文案。 */
  messageId?: string;
}

/** 发布成功但有结果物被跳过时的非阻断提示。 */
export interface ConversationShareDisplayWarnings {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
}

export type ConversationShareProgressPhase = "collecting" | "uploading" | "checking";

export interface ConversationShareSelectionDraft {
  open?: boolean;
  pendingExcludedRowIds?: readonly number[] | null;
  availableRowIds: readonly number[];
  excludedRowIds: readonly number[];
  productTurnIdByRowId: Readonly<Record<number, string>>;
  accessMode: ConversationShareAccessMode;
  /** 用户选择的分享有效时长；null 表示使用服务端默认值。与权限一样跨轮保留。 */
  ttlMs: number | null;
}

export interface ConversationShareDockState {
  title?: string;
  disclosureAccepted: boolean;
  publishing: boolean;
  progress: ConversationShareProgressPhase;
  completedArtifacts: number;
  totalArtifacts: number;
  publishedShareUrl: string | null;
  error: ConversationShareDisplayError | null;
  warnings: ConversationShareDisplayWarnings | null;
  attempt: ConversationShareAttempt | null;
}

export interface ConversationShareSelectionState {
  openShare: (taskId: string) => void;
  closeShare: (taskId: string) => void;
  beginSelectionEdit: (taskId: string) => void;
  togglePendingRow: (taskId: string, rowId: number) => void;
  setAllPendingRowsSelected: (taskId: string, selected: boolean) => void;
  confirmSelectionEdit: (taskId: string) => void;
  cancelSelectionEdit: (taskId: string) => void;
  drafts: Record<string, ConversationShareSelectionDraft>;
  dockStates: Record<string, ConversationShareDockState>;
  setAccessMode: (taskId: string, accessMode: ConversationShareAccessMode) => void;
  setTtlMs: (taskId: string, ttlMs: number | null) => void;
  syncAvailableTurns: (
    taskId: string,
    turns: readonly { rowId: number; productTurnId: string }[],
  ) => void;
  /** 按 product turn 身份整轮取消选择（阻断项的「取消选择该轮」入口）。 */
  deselectProductTurn: (taskId: string, productTurnId: string) => void;
  updateDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
  resetForTests: () => void;
}

const EMPTY_DRAFT: ConversationShareSelectionDraft = Object.freeze({
  availableRowIds: Object.freeze([]),
  excludedRowIds: Object.freeze([]),
  productTurnIdByRowId: Object.freeze({}),
  accessMode: DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  ttlMs: null,
});

export const DEFAULT_CONVERSATION_SHARE_DOCK_STATE: ConversationShareDockState = Object.freeze({
  disclosureAccepted: false,
  publishing: false,
  progress: "collecting",
  completedArtifacts: 0,
  totalArtifacts: 0,
  publishedShareUrl: null,
  error: null,
  warnings: null,
  attempt: null,
});

function normalizeRowIds(rowIds: readonly number[]): number[] {
  return [...new Set(rowIds.filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

export function getConversationShareDraft(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): ConversationShareSelectionDraft {
  return state.drafts[taskId] ?? EMPTY_DRAFT;
}

export function getConversationShareDockState(
  state: Pick<ConversationShareSelectionState, "dockStates">,
  taskId: string,
): ConversationShareDockState {
  return state.dockStates[taskId] ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
}

export function getConversationShareSelectedRowIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): number[] {
  const draft = getConversationShareDraft(state, taskId);
  const excluded = new Set(draft.excludedRowIds);
  return draft.availableRowIds.filter((rowId) => !excluded.has(rowId));
}

export function getConversationShareSelectedProductTurnIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
  source: "confirmed" | "pending" = "confirmed",
): string[] {
  const draft = getConversationShareDraft(state, taskId);
  const seen = new Set<string>();
  const excluded = new Set(
    source === "pending"
      ? (draft.pendingExcludedRowIds ?? draft.excludedRowIds)
      : draft.excludedRowIds,
  );
  return draft.availableRowIds
    .filter((rowId) => !excluded.has(rowId))
    .flatMap((rowId) => {
      const productTurnId = draft.productTurnIdByRowId[rowId];
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
}

export const useConversationShareSelectionStore = create<ConversationShareSelectionState>()(
  (set) => ({
    ...createConversationSharePopoverActions(
      set,
      getConversationShareDraft,
      getConversationShareDockState,
      DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
    ),
    drafts: {},
    dockStates: {},
    setAccessMode: (taskId, accessMode) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [taskId]: {
            ...(state.drafts[taskId] ?? EMPTY_DRAFT),
            accessMode,
          },
        },
      })),
    setTtlMs: (taskId, ttlMs) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [taskId]: {
            ...(state.drafts[taskId] ?? EMPTY_DRAFT),
            ttlMs,
          },
        },
      })),
    syncAvailableTurns: (taskId, turns) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (!current.open) return state;
        const productTurnIdByRowId = Object.fromEntries(
          turns.map((turn) => [turn.rowId, turn.productTurnId]),
        );
        const availableRowIds = normalizeRowIds(turns.map((turn) => turn.rowId));
        const available = new Set(availableRowIds);
        const nextDraft = {
          ...current,
          availableRowIds,
          excludedRowIds: current.excludedRowIds.filter((rowId) => available.has(rowId)),
          productTurnIdByRowId,
        };
        // 披露确认绑定有效分享范围；重开或运行轮次完成后新增内容，不能沿用旧确认。
        const before = new Set(getConversationShareSelectedProductTurnIds(state, taskId));
        const after = getConversationShareSelectedProductTurnIds(
          { drafts: { [taskId]: nextDraft } },
          taskId,
        );
        const changed = before.size !== after.length || after.some((id) => !before.has(id));
        return {
          drafts: { ...state.drafts, [taskId]: nextDraft },
          ...(changed
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: {
                    ...getConversationShareDockState(state, taskId),
                    disclosureAccepted: false,
                  },
                },
              }
            : {}),
        };
      }),
    updateDockState: (taskId, patch) =>
      set((state) => ({
        dockStates: {
          ...state.dockStates,
          [taskId]: {
            ...getConversationShareDockState(state, taskId),
            ...patch,
          },
        },
      })),
    resetForTests: () =>
      set({
        drafts: {},
        dockStates: {},
      }),
  }),
);
