import type { ZCodeProcessDiagnostic } from "@zcode/shared/process-diagnostic";

export interface RuntimeProcessSpawnEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: number;
  runtimeGeneration: number;
  runtimeInstanceId: string;
}

export interface RuntimeProcessReadyEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  readyAt: number;
  startupDurationMs: number;
  runtimeGeneration: number;
  runtimeInstanceId: string;
}

export interface RuntimeProcessExitEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  endedAt: number;
  terminationKind: "expected" | "unexpected" | "watchdog_recycle";
  terminationReason?: string;
  runtimeReady: boolean;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  uptimeMs: number;
  stderrLineCount: number;
  stderrTail?: string[];
}

export interface RuntimeProcessErrorEvent {
  /** 进程泳道（如 mcp-status）；缺省为 chat 主泳道。同 cwd、同 command 的多 lane 进程靠它归因。 */
  lane?: string;
  pid: number | null;
  provider: string;
  workspacePath: string;
  command: string;
  args: string[];
  errorName: string;
  errorCode?: string;
  errorMessage: string;
  errorStack?: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  occurredAt: number;
}

export interface RuntimeProcessLifecycleReporter {
  onSpawn(event: RuntimeProcessSpawnEvent): void;
  onReady?(event: RuntimeProcessReadyEvent): void;
  onExit(event: RuntimeProcessExitEvent): void;
  onError?(event: RuntimeProcessErrorEvent): void;
  onException?(event: RuntimeProcessExceptionEvent): void;
}

export interface RuntimeProcessExceptionEvent {
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  diagnostic: ZCodeProcessDiagnostic;
}

export interface RuntimeTaskCountChangedEvent {
  runningTaskCount: number;
}

export interface RuntimeTaskReporter {
  /** 兼容旧 task service / RPC 生命周期计数。 */
  onRunningTaskCountChanged(event: RuntimeTaskCountChangedEvent): void;
  /** 由 CLI v4 sessions-index 派生的唯一活动 session 数。 */
  onActiveSessionCountChanged?(event: RuntimeTaskCountChangedEvent): void;
}
