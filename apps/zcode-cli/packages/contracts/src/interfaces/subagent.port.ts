// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { InputPreemptionControl } from "../tools/contract.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

/** 一次 Agent 调用派生的子代理身份；`agentId`、`childSessionId` 与 `SubagentSpawned` 载荷里的同名字段是同一份值。 */
export interface SubagentIdentity {
  agentId: string;
  childSessionId: SessionId;
  /** runner 为这次运行定下的输出文件，`metadata.json` 在同一目录；冷恢复按它找，不按当前存储配置推算。 */
  outputFile: string;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny" | "allow";
  };
  /**
   * child session 就绪、发出 `SubagentSpawned` 时同步回报身份，调用时刻一定早于 launch 返回或抛错。
   * child session 就绪之前就失败时不调用。Agent 工具据此把身份结构化写进父 transcript 的 tool part；
   * 有这份记录的 part，冷恢复的 SendMessage、启动对账、冷加载和子代理会话查询都只读它，不解析模型可见文本。
   * 升级前写下的旧 part 没有这份记录，冷加载、子代理会话查询与启动对账按原来的方式读回执文本。
   */
  onChildSessionReady?: (identity: SubagentIdentity) => void;
  /**
   * 调用方工具的输入抢占接管点。只有传了它，立即发送时前台等待中的 run 才会转后台；
   * 缺省时父级 abort 一律取消 child。
   */
  inputPreemption?: InputPreemptionControl;
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  /** 开关关闭时模型显式请求后台（run_in_background）。 */
  runInBackground?: boolean;
  /**
   * Agent 总在后台运行（开关打开，07-subagent.md「ZCode 当前实现」）：不看 runInBackground 与 profile；
   * 本次执行禁止后台时改为前台运行，不报错。
   */
  alwaysBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export type SubagentStartOptions = SubagentRunOptions;

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  /** 胶囊只允许停止自己观察到的执行；SendMessage 恢复后旧身份失效。 */
  expectedExecutionId?: string;
  /**
   * 谁在停：TaskStop 传 "model"，App 停止传 "user"，系统路径（rewind、闲时任务收尾）不传。
   * 后台 agent 的 killed 通知据此写 "was stopped by ZCode" / "by user" / "was stopped"。
   */
  initiator?: "user" | "model";
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  /** 可选：只用于 UI 预览，缺省时用 message 的第一行；交付给 child 的只有 message。 */
  summary?: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export type SubagentSendMessageOptions = SubagentRunOptions;

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

export interface SubagentTaskSnapshot {
  taskId: string;
  executionId?: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

export interface SubagentPort {
  /** 关闭准入，取消所属执行并等待真实执行和资源清理；不删除历史。 */
  close?(): Promise<void>;
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
