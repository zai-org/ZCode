import type { GitChangeSourceId } from "@zcode/shared";
import type { SidePaneFullViewState } from "@/side-pane-full-view/contract.js";
import {
  normalizeWorkspaceSidePaneState,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

export interface TaskSidePaneMemoryState {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
  /** 对话级展开/收起偏好；tabs 本身仍按 workspace 复用。 */
  sidePaneCollapsedByOwner: Record<string, boolean>;
  /** 对话级完整视图状态（docs/ui/side-pane-full-view.md）；缺省表示普通视图。 */
  sidePaneFullViewByOwner: Record<string, SidePaneFullViewState>;
  /** 工具调用的自动打开已消费记录；不随消息行卸载清空。 */
  pluginUiAutoOpenKeys: ReadonlySet<string>;
  activeGitSourceId: GitChangeSourceId;
  browserUrls: Record<string, string>;
  /** @deprecated 旧版单浏览器 tab 的 URL，保留用于读取历史内存状态。 */
  browserUrl: string | null;
}

const DEFAULT_TASK_SIDE_PANE_MEMORY_STATE: TaskSidePaneMemoryState = {
  sidePaneState: null,
  isSidePaneCollapsed: true,
  sidePaneCollapsedByOwner: {},
  sidePaneFullViewByOwner: {},
  pluginUiAutoOpenKeys: new Set(),
  activeGitSourceId: "unstaged",
  browserUrls: {},
  browserUrl: null,
};

export const TASK_SIDE_PANE_MEMORY_MAX_ENTRIES = 50;

const DRAFT_SIDE_PANE_OWNER_KEY = "__draft__";

const taskSidePaneMemory = new Map<string, TaskSidePaneMemoryState>();

function touchTaskSidePaneMemoryEntry(
  key: string,
  state: TaskSidePaneMemoryState,
): TaskSidePaneMemoryState {
  taskSidePaneMemory.delete(key);
  taskSidePaneMemory.set(key, state);
  return state;
}

function pruneTaskSidePaneMemory(): void {
  while (taskSidePaneMemory.size > TASK_SIDE_PANE_MEMORY_MAX_ENTRIES) {
    const oldestKey = taskSidePaneMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    taskSidePaneMemory.delete(oldestKey);
  }
}

export function buildTaskSidePaneMemoryKey({
  workspacePath,
  workspaceIdentity,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
}): string | null {
  // side pane 的语义是“当前 workspace 右侧辅助工作区”，
  // 不是 task 自己的私有上下文。之前把 taskId 拼进 key 之后，
  // 同一 workspace 下切换 task 会命中一份全新的 side pane 内存，
  // 导致用户正在看的 browser / git / code viewer 像是被“切任务顺手清空”。
  // 这里改回只按 workspace 身份隔离，让同 workspace 的 task 共用同一份 side pane 状态。
  void taskId;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return workspaceKey.trim() ? workspaceKey : null;
}

export function readTaskSidePaneMemoryState(key: string | null): TaskSidePaneMemoryState {
  if (!key) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const state = taskSidePaneMemory.get(key);
  if (!state) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const normalizedState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...state,
    sidePaneState: normalizeWorkspaceSidePaneState(state.sidePaneState),
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...state.sidePaneCollapsedByOwner,
    },
    sidePaneFullViewByOwner: { ...state.sidePaneFullViewByOwner },
  };
  return touchTaskSidePaneMemoryEntry(key, normalizedState);
}

export function saveTaskSidePaneMemoryState(
  key: string | null,
  patch: Partial<TaskSidePaneMemoryState>,
): void {
  if (!key) {
    return;
  }

  // side pane memory 是 renderer 模块级缓存，长期切换大量 workspace 时旧 key
  // 如果永不淘汰会持续持有 tabs、browser URL、diff patch 等状态。这里用简单 LRU 上限
  // 保留最近访问的 workspace 状态，避免长时间运行时 Map 无界增长。
  const nextState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...taskSidePaneMemory.get(key),
    ...patch,
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...taskSidePaneMemory.get(key)?.sidePaneCollapsedByOwner,
      ...patch.sidePaneCollapsedByOwner,
    },
    // 完整视图记录由专用写入口整体替换，普通 patch 只保留已有记录，避免旧快照覆盖新状态。
    sidePaneFullViewByOwner:
      patch.sidePaneFullViewByOwner ?? taskSidePaneMemory.get(key)?.sidePaneFullViewByOwner ?? {},
  };
  nextState.sidePaneState = normalizeWorkspaceSidePaneState(nextState.sidePaneState);
  touchTaskSidePaneMemoryEntry(key, nextState);
  pruneTaskSidePaneMemory();
}

export function getSidePaneCollapsedPreference(
  state: TaskSidePaneMemoryState,
  ownerTaskId: string | null | undefined,
): boolean | undefined {
  return state.sidePaneCollapsedByOwner[ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY];
}

export function saveTaskSidePaneCollapsedPreference(
  key: string | null,
  ownerTaskId: string | null | undefined,
  isSidePaneCollapsed: boolean,
): void {
  if (!key) return;

  const state = readTaskSidePaneMemoryState(key);
  const ownerKey = ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY;
  saveTaskSidePaneMemoryState(key, {
    isSidePaneCollapsed,
    sidePaneCollapsedByOwner: {
      ...state.sidePaneCollapsedByOwner,
      [ownerKey]: isSidePaneCollapsed,
    },
  });
}

/** 渲染期读取：不触碰 LRU 顺序，保证 render 无副作用。 */
export function peekTaskSidePaneFullView(
  key: string | null,
  ownerTaskId: string | null | undefined,
): SidePaneFullViewState | null {
  if (!key) return null;
  return (
    taskSidePaneMemory.get(key)?.sidePaneFullViewByOwner[
      ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY
    ] ?? null
  );
}

export function saveTaskSidePaneFullView(
  key: string | null,
  ownerTaskId: string | null | undefined,
  value: SidePaneFullViewState | null,
): void {
  if (!key) return;
  const ownerKey = ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY;
  const next = { ...taskSidePaneMemory.get(key)?.sidePaneFullViewByOwner };
  if (value) {
    next[ownerKey] = value;
  } else {
    delete next[ownerKey];
  }
  saveTaskSidePaneMemoryState(key, { sidePaneFullViewByOwner: next });
}

/**
 * 草稿首发成新任务时，把草稿的完整视图记录（完整视图 / 浮窗形态、吸附位置）交给新任务。
 * 记录按 owner 存，不迁的话 owner 一换就查不到，界面退回三栏，像是「一发送就跳回主对话流」。
 */
export function adoptDraftTaskSidePaneFullView(key: string | null, sessionId: string): void {
  const draft = peekTaskSidePaneFullView(key, null);
  if (!draft) return;
  saveTaskSidePaneFullView(key, sessionId, draft);
  saveTaskSidePaneFullView(key, null, null);
}

export function clearTaskSidePaneMemoryStateForTest(): void {
  taskSidePaneMemory.clear();
}

export function claimPluginUiSidePaneAutoOpen(
  workspaceKey: string | null,
  requestKey: string,
): boolean {
  if (!workspaceKey) return false;
  const state = readTaskSidePaneMemoryState(workspaceKey);
  if (state.pluginUiAutoOpenKeys.has(requestKey)) return false;
  // 根因：行内 useRef 在会话切换/虚拟卸载后丢失，旧 fullscreen 结果会覆盖已保存的收起状态。
  // 与侧栏偏好共用同一内存 owner；同步消费也保证同一调用的多个锚点只触发一次。
  saveTaskSidePaneMemoryState(workspaceKey, {
    pluginUiAutoOpenKeys: new Set([...state.pluginUiAutoOpenKeys, requestKey]),
  });
  return true;
}
