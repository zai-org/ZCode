// ============================================================
// 后台停止分派的共享类型
// ============================================================
// 从 background.ts 抽出，供它与按 RuntimeTaskType 分派出去的各个停止分支模块共用
// （见 background-stop-dynamic-workflow.ts）。单独成文件是为了让分支模块不必 import
// background.ts，避免两者互相 import 类型，也限制 background.ts 的规模。
//
// background.ts 继续对外 re-export 这些名字，所以 agent-runtime.ts /
// internal-turn-methods.ts 的既有 import 路径不变。

import type { BackgroundTaskInfo, BackgroundTaskInfoStatus } from "../deps.js";
import type { RuntimeTaskSnapshot, RuntimeTaskType } from "../../runtime-task/registry.js";
import type { TraceContext } from "../deps.js";

export type RuntimeBackgroundStopFailureReason =
  | "background_task_cancel_not_supported"
  | "background_task_not_found"
  | "background_task_not_running";

export type RuntimeBackgroundStopStatus = BackgroundTaskInfoStatus | RuntimeTaskSnapshot["status"];

export type RuntimeBackgroundStopResult =
  | {
      alreadyTerminal?: boolean;
      command?: string;
      ok: true;
      status: RuntimeBackgroundStopStatus;
      taskId: string;
      type: RuntimeTaskType;
    }
  | {
      reason: RuntimeBackgroundStopFailureReason;
      ok: false;
      status?: RuntimeBackgroundStopStatus;
      taskId: string;
      type?: RuntimeTaskType;
    };

/**
 * GUI / 后台面板经
 * `runtime.cancelBackgroundTask` 进来的是 `"user"`，模型的 `TaskStop` 是 `"model"`；运行时
 * 清扫等系统路径不填。dwf 分支把它记到 registry 条目上，终态通知据此告诉模型「这是用户的
 * 决定，不要自行恢复」。
 */
export type RuntimeBackgroundStopInitiator = "user" | "model";

export interface RuntimeBackgroundStopOptions {
  expectedExecutionId?: string;
  initiator?: RuntimeBackgroundStopInitiator;
  strict?: boolean;
  traceContext?: TraceContext;
}

export interface RuntimeBackgroundStopTarget {
  currentStatus: RuntimeBackgroundStopStatus | undefined;
  existing: BackgroundTaskInfo | undefined;
  registryTask: RuntimeTaskSnapshot | undefined;
  taskId: string;
  taskType: RuntimeTaskType | undefined;
}

/** 已确定 taskType 的停止目标；各分支模块只接受这一形态。 */
export type TypedRuntimeBackgroundStopTarget = RuntimeBackgroundStopTarget & {
  taskType: RuntimeTaskType;
};
