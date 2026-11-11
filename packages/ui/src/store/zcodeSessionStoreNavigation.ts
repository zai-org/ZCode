/**
 * ZCode Session Store 导航切片 —— 任务前进/后退历史管理
 *
 * 从 zcodeSessionStore.ts 拆分出来，封装所有任务导航相关的初始状态和 action。
 * 通过 createNavigationSlice(set, get) 返回可直接展开到 store 的对象。
 */
import { Emitter } from "@zcode/rpc";
import {
  createTaskNavigationHistory,
  goBack as navGoBack,
  goForward as navGoForward,
  pushAutomationsNavEntry,
  pushPluginStoreNavEntry,
  removeTaskFromHistory,
  type AutomationsNavigationTab,
  type WorkspaceNavEntry,
  type TaskNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { ZCodeSessionStoreState } from "./zcodeSessionStoreTypes.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;
type GetFn = () => ZCodeSessionStoreState;

// 查看事实只由完整导航提交发布；tab 激活与历史游标移动都可能暴露缓存任务，不能代替提交。
const taskNavigationCommitted = new Emitter<TaskNavEntry>();
export const onTaskNavigationCommitted = taskNavigationCommitted.event;
export function notifyTaskNavigationCommitted(target: Omit<TaskNavEntry, "kind">): void {
  taskNavigationCommitted.fire({ kind: "task", ...target });
}

/** 深层组件请求跳转到某个任务的目标（规格 0.13）。 */
export interface TaskNavigationRequest {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 跳转**请求**通道，与上面的「已提交」通道相反：这条是入站的。
 *
 * 会话气泡的「来自会话 X」这类深层展示组件到 App 顶层隔着 SessionPane / WorkbenchPane /
 * V4ChatPane 等多层，逐层传回调会把展示组件绑死在壳层结构上。这里只发意图，由
 * useWorkspaceTaskNavigation（handleSelectTask 的唯一持有者）订阅并执行——
 * 与 App 控制工具的 OpenSession 是同一条「外部请求 → 既有导航 owner」的形状。
 * 导航 owner 仍然唯一，不新增第二条导航路径。
 */
const taskNavigationRequested = new Emitter<TaskNavigationRequest>();
export const onTaskNavigationRequested = taskNavigationRequested.event;
export function requestTaskNavigation(target: TaskNavigationRequest): void {
  taskNavigationRequested.fire(target);
}

/**
 * 创建导航切片，供 store creator 展开使用：
 * `...createNavigationSlice(set, get)`
 */
export function createNavigationSlice(set: SetFn, get: GetFn) {
  return {
    taskNavHistory: createTaskNavigationHistory(),

    taskNavPushAutomations: (
      workspacePath: string,
      workspaceIdentity?: string,
      automationId?: string,
      automationTab?: AutomationsNavigationTab,
    ) => {
      set((state) => ({
        taskNavHistory: pushAutomationsNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
          automationId,
          automationTab,
        ),
      }));
    },

    taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) => ({
        taskNavHistory: pushPluginStoreNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
        ),
      }));
    },

    taskNavGoBack: (): WorkspaceNavEntry | null => {
      const state = get();
      const result = navGoBack(state.taskNavHistory);
      if (!result) {
        return null;
      }

      set({ taskNavHistory: result.history });
      return result.entry;
    },

    taskNavGoForward: (): WorkspaceNavEntry | null => {
      const state = get();
      const result = navGoForward(state.taskNavHistory);
      if (!result) {
        return null;
      }

      set({ taskNavHistory: result.history });
      return result.entry;
    },

    removeTaskFromNavHistory: (taskId: string) => {
      set((state) => ({
        taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
      }));
    },
  };
}
