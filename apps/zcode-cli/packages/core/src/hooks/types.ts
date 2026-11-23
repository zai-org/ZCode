import type {
  ExecutionPort,
  HookEventName,
  HookExecutionDescriptor,
  HookInput,
  HookJSONOutput,
  HookPermissionDecision,
  HookOnError,
  HookSourceKind,
  HooksRuntimeConfig,
  WorkspaceHookBundleSnapshot,
  Logger,
  PermissionRequestHookDecision,
  SessionEvent,
} from "@zcode/contracts";

import type { WorkspaceHookRuntimeAdmissionPort } from "./workspace-hook-runtime-admission.js";

export interface HookCallbackContext {
  hookIndex: number;
  signal?: AbortSignal;
}

/**
 * 配置 Hook 的执行器可以附带 stderr 等诊断；这些信息只进入生命周期事件，
 * 不参与 Hook 决策，也不会作为 Hook JSON 输出暴露给模型。
 */
export interface HookCallbackDiagnostics {
  errorMessage?: string;
  stderrPreview?: string;
  stdoutPreview?: string;
}

export interface HookCallbackResult {
  kind: "hookCallbackResult";
  diagnostics?: HookCallbackDiagnostics;
  output?: HookJSONOutput;
}

export type HookCallback = (
  input: HookInput,
  context: HookCallbackContext,
) =>
  | HookJSONOutput
  | HookCallbackResult
  | void
  | Promise<HookJSONOutput | HookCallbackResult | void>;

export interface HookRunAdmissionDecision {
  allowed: boolean;
  reasonCode?: string;
  skipLifecycle?: boolean;
}

export interface HookRegistration {
  admission?: (input: HookInput) => HookRunAdmissionDecision;
  /**
   * admission 允许后、HookRunStarted 前的异步复核（D24：项目 Hook 入口脚本）。
   * 截止时间等于 timeoutMs，不占用执行计时；返回后 runner 会再次同步执行 admission。
   */
  verifyBeforeDispatch?: (input: HookInput, signal: AbortSignal) => Promise<HookRunAdmissionDecision>;
  async?: boolean;
  callback: HookCallback;
  descriptor?: HookExecutionDescriptor | ((input: HookInput) => HookExecutionDescriptor);
  event: HookEventName;
  matcher?: string;
  /** hook 自身出错时的处置（contracts 的 HookOnError）；缺席 = allow。 */
  onError?: HookOnError;
  source?: string;
  sourceKind?: HookSourceKind;
  timeoutMs?: number;
}

export interface HookRunOptions {
  matchValue?: string;
  matchValues?: readonly string[];
  signal?: AbortSignal;
}

export interface HookRunResult {
  additionalContexts: string[];
  blockRequested?: boolean;
  hookPermissionDecisionReason?: string;
  permissionBehavior?: HookPermissionDecision;
  permissionRequestResult?: PermissionRequestHookDecision;
  preventContinuation?: boolean;
  stopShouldContinue?: boolean;
  stopReason?: string;
  updatedInput?: unknown;
}

export interface HookRunner {
  run(input: HookInput, options?: HookRunOptions): Promise<HookRunResult>;
}

export interface HookRunnerOptions {
  defaultTimeoutMs?: number;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  hooks?: HookRegistration[];
  logger?: Logger;
}

export interface ConfiguredHookRunnerOptions {
  config: HooksRuntimeConfig;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort: ExecutionPort;
  getWorkingDirectory: () => string;
  logger?: Logger;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
}
