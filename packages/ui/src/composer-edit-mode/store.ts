// 编辑态的 renderer 内存状态：只属于发起端 renderer，不进入 snapshot、relay 或 main process；
// 刷新后自然消失。
import { create } from "zustand";
import { COMPOSER_EDIT_SCOPE_MARKER, type ComposerEditSession } from "./contract.js";

let nextEditScopeNonce = 1;

/**
 * 每次进入编辑态用新的 edit scope：切换编辑目标时 scope 必须变化，草稿 owner 才会载入新预填，
 * 而不是复用上一个目标的编辑内容。
 */
export function createComposerEditScopeId(sessionId: string): string {
  return `${sessionId}${COMPOSER_EDIT_SCOPE_MARKER}${nextEditScopeNonce++}`;
}

interface ComposerEditStoreState {
  sessions: Record<string, ComposerEditSession>;
  begin: (key: string, session: Omit<ComposerEditSession, "focusRequest">) => void;
  update: (key: string, patch: Partial<ComposerEditSession>) => void;
  end: (key: string) => void;
  requestFocus: (key: string) => void;
}

export const useComposerEditStore = create<ComposerEditStoreState>((set) => ({
  sessions: {},
  begin: (key, session) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...session, focusRequest: (state.sessions[key]?.focusRequest ?? 0) + 1 },
      },
    })),
  update: (key, patch) =>
    set((state) => {
      const current = state.sessions[key];
      if (!current) return state;
      return { sessions: { ...state.sessions, [key]: { ...current, ...patch } } };
    }),
  end: (key) =>
    set((state) => {
      if (!state.sessions[key]) return state;
      const { [key]: _ended, ...sessions } = state.sessions;
      return { sessions };
    }),
  requestFocus: (key) =>
    set((state) => {
      const current = state.sessions[key];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [key]: { ...current, focusRequest: current.focusRequest + 1 },
        },
      };
    }),
}));

export function getComposerEditSession(key: string): ComposerEditSession | undefined {
  return useComposerEditStore.getState().sessions[key];
}
