// ============================================================
// Tool Contract - shared tool declaration surface
// ============================================================

import type { RiskLevel } from "../interfaces/session.port.js";

export type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

/**
 * 会改写工作区的副作用范围：文件系统、git、
 * 以及无法证明只读的 shell / 宿主执行。`network`、`session`、`userInteraction`、`none` 不碰工作区。
 * dynamic-workflow 的导入缓存据此判「第一笔写入」——一次工具调用在解析后的能力上 `readOnly !== true`
 * 且范围落在这个集合里，就是一笔写入。判定放在 contracts 是因为产生标记的执行器（core）与消费它的
 * driver（bootstrap）都要用同一条规则。
 */
export const WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> = new Set<ToolSideEffectScope>([
  "workspace",
  "git",
  "system",
]);

/** 一次工具调用（按解析后的能力）是否会改写工作区。缺席的范围按会改写处理（保守：未声明即不可信）。 */
export function isWorkspaceMutatingToolCall(capability: {
  readOnly?: boolean | undefined;
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  if (capability.readOnly === true) return false;
  return capability.sideEffectScope === undefined
    ? true
    : WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

/**
 * 只服务于协议本身、不看也不动外部世界的副作用范围：`session` 是把结果 / 问题交回调用方
 * （dynamic-workflow 的 `submit_result`、`escalate` 就在这一档），`userInteraction` 是问用户。
 */
const PROTOCOL_ONLY_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> = new Set<ToolSideEffectScope>([
  "session",
  "userInteraction",
]);

/**
 * 一次工具调用是否**看或动了外部世界**（读文件、跑命令、访问网络……）。
 *
 * 与 `isWorkspaceMutatingToolCall` 的分工：那个判「写」，用来决定何时关掉 amend-resume 的导入缓存；
 * 这个判「碰」，用来决定一条缓存条目是不是**纯**的（纯 = 只按指令与转录前缀作答，关门后仍可命中）。
 * 读也算碰：`Read` 声明的范围是 `none`（它不产生副作用），可它的答案取决于工作区。所以判定是排除法
 * ——只把协议档（`session` / `userInteraction`）排除，其余一律算碰；范围缺席同样算碰。
 */
export function isWorldTouchingToolCall(capability: {
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  return capability.sideEffectScope === undefined
    ? true
    : !PROTOCOL_ONLY_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

export type ToolPermissionPatternSource =
  | "none"
  | "toolName"
  | "input"
  | "path"
  | "command"
  | "network"
  | "custom";

export type ToolResultBudgetStrategy = "inline" | "truncate" | "artifact";

export type ToolExecutionMode = "client" | "providerNative";

export interface ProviderNativeToolSpec {
  kind: "provider_native";
  logicalName: string;
  providerToolName: string;
  providerIds?: string[];
  args?: Record<string, unknown>;
  fallback: "disabled";
}

export interface ToolPermissionSpec {
  /** 内置工具在 handler 内收集专用确认；权限规则与 plan 限制仍先执行。 */
  confirmationHandledByTool?: boolean;
  permission: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope: ToolSideEffectScope;
  needsApproval: boolean;
  patternSources: ToolPermissionPatternSource[];
  alwaysAllowPatternSources?: ToolPermissionPatternSource[];
  denyPriority: "beforeAsk" | "afterStaticAllow";
  /**
   * Requires explicit user approval in every permission mode. Unlike `needsApproval`, which
   * the permissive modes are allowed to short-circuit, this survives yolo's pass-through and
   * plan mode's read-only pass-through: the tool's unit of work is large enough that no
   * permissiveness setting should be able to run it unattended.
   *
   * It overrides allow-granting branches only, never deny-granting ones — an explicitly
   * disallowed tool stays denied.
   */
  alwaysAsk?: true;
  /**
   * Narrows the options offered when this tool asks. `allowAlways: false` suppresses the
   * persistent project rule: a tool whose input is different code on every call cannot
   * have a decision remembered without permanently disabling its gate. `"session"` swaps
   * the persistent rule for an in-memory, session-scoped one ("Always allow in this
   * session"): the gate stays closed for the rest of this runtime only, and every new
   * session (restart, cold resume, `/new`) asks again first.
   */
  askOptions?: { allowAlways: false | "session" };
}

export interface ToolResultBudget {
  /** Inline UI/event threshold before a result should be summarized, truncated, or redirected. */
  maxInlineBytes: number;
  /**
   * Provider-visible inline threshold. For artifact strategy this is the threshold that triggers
   * artifact persistence; the successful <persisted-output> preview uses its own preview budget.
   */
  maxModelBytes: number;
  strategy: ToolResultBudgetStrategy;
  preview?: {
    maxBytes?: number;
    maxLines?: number;
    direction?: "head" | "tail";
  };
  artifact?: {
    enabled: boolean;
    retention?: "session" | "project" | "temporary";
  };
}

export interface NoToolTimeoutPolicy {
  kind: "none";
}

export interface TimedToolTimeoutPolicy {
  kind?: "timed";
  defaultMs: number;
  maxMs?: number;
  allowCallOverride: boolean;
  /**
   * Extra wall-clock budget reserved for cancellation and adapter cleanup after the
   * tool's own timeout. The user-facing timeout still comes from defaultMs/input.
   */
  cleanupGraceMs?: number;
}

export type ToolTimeoutPolicy = NoToolTimeoutPolicy | TimedToolTimeoutPolicy;

export interface ToolCancellationPolicy {
  supported: boolean;
  cleanup: "none" | "bestEffort" | "required";
  userVisibleMessage: string;
}

export interface ToolTracePolicy {
  required: true;
  propagateToAdapters: boolean;
  recordInput: "summary" | "full" | "none";
  recordOutput: "summary" | "full" | "none";
}

export interface ToolContractDeclaration {
  capability: string;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /**
   * 声明 `inputSchema` **有资格**走 provider 的严格模式（Anthropic `strict: true`：constrained
   * decoding 保证 tool_use.input 恰好满足 schema）。只是资格，不是命令：adapter 按 provider /
   * model 决定是否真的下发，并负责把 strict 子集表达不了的关键字折进 description。缺席即不严格。
   * 首个使用者是 dwf mono 子代理的 typed `submit_result`。
   */
  strict?: boolean;
  requiresUserInteraction?: boolean;
  permission: ToolPermissionSpec;
  resultBudget: ToolResultBudget;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
  trace: ToolTracePolicy;
}
