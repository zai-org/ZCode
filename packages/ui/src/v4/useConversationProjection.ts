import { useSyncExternalStore } from "react";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  editPresentation: null,
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(lease: SessionLease | null): ConversationStoreState {
  const store = lease?.store ?? null;
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? CLOSED_STATE,
    () => CLOSED_STATE,
  );
}
