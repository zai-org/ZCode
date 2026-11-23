/* oxlint-disable eslint(max-lines) -- message_completion 与 agent_step 共用 prompt 生命周期状态，拆分会增加跨文件同步复杂度。 */
import {
  legacyTelemetryModelFields,
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "./providerTelemetryIdentity.js";
import type {
  InputId,
  PlanIdentitySnapshot,
  ZCodeContextCompactionTimelineMeta,
  ZCodePersistedFileChange,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTimelineStatus,
  ZCodeUsage,
} from "@zcode/shared";
import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  NATIVE_SUPPLIER_KEY_PREFIX,
  createUuid,
  computeLineChangeStat,
  sanitizeTelemetrySkillName,
  normalizeToolErrorCode,
  decodeCustomModelValue,
} from "@zcode/shared";
export interface ComposerInputTimingSnapshot {
  inputStartTime: number;
  inputFirstCharTime: number;
}

type ComposerInputTimingState = ComposerInputTimingSnapshot;

interface PromptTelemetryState {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  baseEventExtraDetail: Record<string, string>;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  waitingMs: number;
  permissionWaitsByRequestId: Map<string, PermissionWaitState>;
  firstTokenAt: number | null;
  isFirstMessage?: boolean;
  sendMode?: "direct" | "queued";
  ttftOutputKind?: "reasoning" | "text" | "tool";
  ttftRequestId?: string;
  ttftCandidateRequestId?: string;
  ttftUsage?: { requestId: string; inputTokens?: number; cachedInputTokens?: number };
  usage: ZCodeUsage | null;
  usageEventKeys: Set<string>;
  finalizedAgentStepCount: number;
  toolCallTotal: number;
  toolCallFailed: number;
  firstToolCallError: string;
}

interface PermissionWaitState {
  requestedAt: number;
  toolCallId?: string;
}

interface FinalizePromptTelemetryInput {
  taskId: string;
  status: string;
  finishedAt: number;
  fileChanges?: readonly ZCodePersistedFileChange[];
  usage?: ZCodeUsage;
  errorType?: string;
  errorMsg?: string;
  messageSource?: PromptMessageSource;
  agentComposition?: AgentComposition;
}

/** 独立 background wake 轮的来源：Agent 工具的后台子代理，或 dynamic-workflow run 的通知。 */
export type PromptMessageSource = "background_subagent" | "background_workflow";

/**
 * `message_completion.agent_composition`：本轮消费过哪些 Subagent 结果（fg = 前台、bg = 后台、
 * wf = 动态工作流 run）。八个值 = 三个布尔的组合。
 */
type AgentComposition =
  | "main_only"
  | "main_plus_fg"
  | "main_plus_bg"
  | "main_plus_wf"
  | "main_plus_fg_bg"
  | "main_plus_fg_wf"
  | "main_plus_bg_wf"
  | "main_plus_fg_bg_wf";

export function composeAgentComposition(input: {
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  hasWorkflowResult: boolean;
}): AgentComposition {
  const parts = [
    ...(input.hasForegroundSubagentResult ? ["fg"] : []),
    ...(input.hasBackgroundSubagentResult ? ["bg"] : []),
    ...(input.hasWorkflowResult ? ["wf"] : []),
  ];
  return parts.length === 0 ? "main_only" : (`main_plus_${parts.join("_")}` as AgentComposition);
}

interface FinalizedPromptTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

type AgentStepType = "reasoning" | "tool_call" | "generation";
type GenerationCloseReason = "reasoning" | "tool_call" | "task_complete" | "task_error";
type AgentStepTelemetryClientMode = "desktop-continuous" | "web-remote-replayable";
export type AgentStepRole = "foreground subagent" | "background subagent" | "workflow subagent";

interface ActiveAgentStep {
  stepId: string;
  stepType: AgentStepType;
  loopIndex: number;
  startedAt: number;
  waitingMs: number;
  model?: AgentStepModelIdentity;
  usage?: AgentStepUsageAttribution;
  lastMessageChunkAt?: number;
  toolId?: string;
  toolName?: string;
  agentId?: string;
  agentRole?: AgentStepRole;
  skillMetadata?: AgentStepSkillMetadata;
  pluginMetadata?: { pluginId: string; component: "mcp" };
}

interface AgentStepSkillMetadata {
  name?: string;
  qualifiedName?: string;
  pluginId?: string;
  source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
}

interface AgentStepModelIdentity {
  requestId?: string;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

interface AgentStepUsageAttribution {
  requestIds: string[];
  requestCount: number;
  scope: "model_request" | "subagent_requests";
  usage: ZCodeUsage;
}

interface AgentStepToolAttribution {
  agentId?: string;
  agentRole?: AgentStepRole;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}

interface AgentStepTelemetryState {
  nextLoopIndex: number;
  currentModelRequest: AgentStepModelIdentity | null;
  pendingUsageByRequestId: Map<string, AgentStepUsageAttribution>;
  reasoningStep: ActiveAgentStep | null;
  generationStep: ActiveAgentStep | null;
  toolStepsById: Map<string, ActiveAgentStep>;
  settledPermissionWaitsByToolId: Map<string, SettledPermissionWaitAttribution>;
}

interface SettledPermissionWaitAttribution {
  waitingMs: number;
  earliestRequestedAt: number;
}

interface FinalizedAgentStepTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

const composerInputTimingByWorkspace = new Map<string, ComposerInputTimingState>();
const queuedPromptTelemetryByTask = new Map<string, PromptTelemetryState[]>();
const activePromptTelemetryByTask = new Map<string, PromptTelemetryState>();
const agentStepTelemetryByTask = new Map<string, AgentStepTelemetryState>();

function resolvePromptTelemetryModelProvider(params: {
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
}): string {
  const { modelName, provider, selectedSupplierKey } = params;
  // Bugfix: send_btn 的 model_name 已按 UI model value 修正，但 selectedSupplierKey
  // 偶尔仍停留在上一个 supplier，导致出现 `uuid/model` 搭配 `glm` provider。
  // 当 model value 自身带 provider 维度时，provider 必须与同一份 UI selection 对齐。
  const providerFromModelName = readProviderIdFromModelValue(modelName);
  if (providerFromModelName) {
    return providerFromModelName;
  }

  if (!selectedSupplierKey) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const customProviderId = selectedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return customProviderId || provider || "";
  }

  // ghost supplier 代表尚未解析到稳定 custom provider 的临时隔离态，provider 维度统一回退到当前 ZCode Agent provider。
  if (selectedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(NATIVE_SUPPLIER_KEY_PREFIX)) {
    const nativeProvider = selectedSupplierKey.slice(NATIVE_SUPPLIER_KEY_PREFIX.length).trim();
    return nativeProvider || provider || "";
  }

  return provider ?? "";
}

function readProviderIdFromModelValue(modelValue: string | null | undefined): string | null {
  const normalizedModelValue = modelValue?.trim() ?? "";
  if (!normalizedModelValue) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedModelValue);
  if (customModel?.providerId?.trim()) {
    return customModel.providerId.trim();
  }

  const separatorIndex = normalizedModelValue.indexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }

  const providerId = normalizedModelValue.slice(0, separatorIndex).trim();
  return providerId || null;
}

function resolveProviderHostname(baseURL: string | null | undefined): string {
  const normalizedBaseURL = baseURL?.trim() ?? "";
  if (!normalizedBaseURL) {
    return "";
  }

  try {
    return new URL(normalizedBaseURL).hostname;
  } catch {
    return "";
  }
}

function createAgentStepTelemetryState(): AgentStepTelemetryState {
  return {
    nextLoopIndex: 1,
    currentModelRequest: null,
    pendingUsageByRequestId: new Map(),
    reasoningStep: null,
    generationStep: null,
    toolStepsById: new Map(),
    settledPermissionWaitsByToolId: new Map(),
  };
}

function getAgentStepTelemetryState(taskId: string): AgentStepTelemetryState {
  const existing = agentStepTelemetryByTask.get(taskId);
  if (existing) {
    return existing;
  }

  const created = createAgentStepTelemetryState();
  agentStepTelemetryByTask.set(taskId, created);
  return created;
}

function createAgentStep(
  state: AgentStepTelemetryState,
  stepType: AgentStepType,
  startedAt: number,
  options: {
    toolId?: string;
    toolName?: string;
    skillMetadata?: AgentStepSkillMetadata;
  } = {},
): ActiveAgentStep {
  const step: ActiveAgentStep = {
    stepId: createUuid(),
    stepType,
    loopIndex: state.nextLoopIndex,
    startedAt,
    waitingMs: 0,
    ...(state.currentModelRequest ? { model: { ...state.currentModelRequest } } : {}),
    ...options,
  };
  const requestId = step.model?.requestId;
  if (requestId) {
    const pendingUsage = state.pendingUsageByRequestId.get(requestId);
    if (pendingUsage) {
      step.usage = pendingUsage;
      state.pendingUsageByRequestId.delete(requestId);
    }
  }
  state.nextLoopIndex += 1;
  return step;
}

function normalizeAgentStepStatus(status: string): string {
  if (status === "failed" || status === "fail" || status === "denied") {
    return "fail";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "success";
}

function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const automation = (value as { automation?: unknown }).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) return undefined;
  const automationId = (automation as { automationId?: unknown }).automationId;
  return typeof automationId === "string" && automationId.trim() ? automationId.trim() : undefined;
}

function markPromptFirstToken(
  prompt: PromptTelemetryState,
  now: number,
  kind: "reasoning" | "text" | "tool",
): void {
  if (prompt.firstTokenAt !== null) {
    return;
  }

  prompt.firstTokenAt = now;
  prompt.ttftOutputKind = kind;
  prompt.ttftRequestId = prompt.ttftCandidateRequestId;
}

function finalizeAgentStep(input: {
  prompt: PromptTelemetryState;
  step: ActiveAgentStep;
  finishedAt: number;
  status: string;
  errorType?: string;
  errorMsg?: string;
  /** 工具终态的原始 errorCode；只在失败的 tool step 上归一后写入 error_code。 */
  errorCode?: string;
  generationTailFinalizeMs?: number;
  automationId?: string;
}): FinalizedAgentStepTelemetry {
  const normalizedStatus = normalizeAgentStepStatus(input.status);
  const isToolCall = input.step.stepType === "tool_call";
  const usage = input.step.usage?.usage;
  const model = input.step.model;
  // Bugfix：completion 之前扫描整个 taskMessages，导致后一轮把历史 step/tool
  // 重复计入。逐 step 收口才是当前 message 的事实源，因此聚合必须在这里同步累计。
  input.prompt.finalizedAgentStepCount += 1;
  if (isToolCall) {
    input.prompt.toolCallTotal += 1;
    const isFailed = normalizedStatus !== "success" || Boolean(input.errorMsg);
    if (isFailed) {
      input.prompt.toolCallFailed += 1;
      if (!input.prompt.firstToolCallError && input.errorMsg) {
        input.prompt.firstToolCallError = input.errorMsg;
      }
    }
  }

  return {
    taskId: input.prompt.taskId,
    messageId: input.prompt.messageId,
    eventExtraDetail: {
      step_id: input.step.stepId,
      is_tftt_cached: "0",
      loop_index: String(input.step.loopIndex),
      step_type: input.step.stepType,
      // Bug 根因：旧实现从 prompt 共享字段取模型，后续主请求或 child 请求会覆盖已创建 step。
      // step 必须冻结其真实请求模型；只有旧事实缺少 request identity 时才回退 prompt seed。
      model_name: legacyTelemetryModelValue(
        model?.modelName ?? input.prompt.baseEventExtraDetail.model_name ?? "",
      ),
      model_provider: legacyTelemetryProviderId(
        model?.modelProvider ?? input.prompt.baseEventExtraDetail.model_provider ?? "",
      ),
      provider_name: model?.providerName ?? input.prompt.baseEventExtraDetail.provider_name ?? "",
      model_request_id:
        input.step.usage?.requestIds.length === 1 ? (input.step.usage.requestIds[0] ?? "") : "",
      model_request_count: String(input.step.usage?.requestCount ?? 0),
      token_usage_scope: input.step.usage?.scope ?? "",
      is_tool_call: isToolCall ? "1" : "0",
      tool_name: input.step.toolName ?? "",
      tool_call_id: isToolCall ? (input.step.toolId ?? "") : "",
      ...(input.step.agentId ? { agent_id: input.step.agentId } : {}),
      ...(input.step.agentRole ? { agent_role: input.step.agentRole } : {}),
      duration_ms: String(Math.max(input.finishedAt - input.step.startedAt, 0)),
      waiting_ms: String(input.step.waitingMs),
      generation_tail_finalize_ms:
        input.generationTailFinalizeMs !== undefined ? String(input.generationTailFinalizeMs) : "",
      status: normalizedStatus,
      input_tokens: String(usage?.inputTokens ?? 0),
      output_tokens: String(usage?.outputTokens ?? 0),
      reasoning_tokens: String(usage?.reasoningTokens ?? 0),
      cached_tokens: String(usage?.cachedInputTokens ?? 0),
      cache_write_input_tokens: String(usage?.cachedWriteInputTokens ?? 0),
      total_tokens: String(usage?.totalTokens ?? 0),
      error_type: normalizedStatus === "success" ? "" : (input.errorType ?? "UNKNOWN"),
      error_msg: normalizedStatus === "success" ? "" : (input.errorMsg ?? ""),
      // error_type 对工具失败一直是 TOOL_EXEC_ERROR，原因只能从这里拆；原文不出本机。
      error_code:
        isToolCall && normalizedStatus === "fail" ? normalizeToolErrorCode(input.errorCode) : "",
      ...(input.automationId ? { automation_id: input.automationId } : {}),
      ...(isToolCall && (input.step.pluginMetadata?.pluginId || input.step.skillMetadata?.pluginId)
        ? {
            plugin_id: input.step.pluginMetadata?.pluginId ?? input.step.skillMetadata!.pluginId!,
            plugin_component: input.step.pluginMetadata?.component ?? "skill",
          }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill"
        ? { skill_name: sanitizeTelemetrySkillName(input.step.skillMetadata?.name) }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.qualifiedName
        ? { skill_qualified_name: input.step.skillMetadata.qualifiedName }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.pluginId
        ? { skill_plugin_id: input.step.skillMetadata.pluginId }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.source
        ? { skill_source: input.step.skillMetadata.source }
        : {}),
    },
  };
}

function closeReasoningStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  output: FinalizedAgentStepTelemetry[],
): void {
  if (!state.reasoningStep) {
    return;
  }

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.reasoningStep,
      finishedAt: now,
      status: "success",
    }),
  );
  state.reasoningStep = null;
}

function closeGenerationStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
  closeReason?: GenerationCloseReason,
  clientMode: AgentStepTelemetryClientMode = "desktop-continuous",
): void {
  if (!state.generationStep) {
    return;
  }

  // 修复原因：replayable 恢复会把历史 chunk/terminal 在客户端重放，
  // Date.now() 只能代表本地处理时间，不能代表源端正文尾包到终态的真实尾延迟。
  const canReportGenerationTailFinalize = clientMode === "desktop-continuous";
  const generationTailFinalizeMs =
    canReportGenerationTailFinalize &&
    (closeReason === "task_complete" || closeReason === "task_error") &&
    state.generationStep.lastMessageChunkAt !== undefined
      ? Math.max(now - state.generationStep.lastMessageChunkAt, 0)
      : undefined;

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.generationStep,
      finishedAt: now,
      status,
      errorType: error?.type,
      errorMsg: error?.msg,
      generationTailFinalizeMs,
    }),
  );
  state.generationStep = null;
}

function settlePermissionWait(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  requestId: string,
  now: number,
): void {
  const permissionWait = prompt.permissionWaitsByRequestId.get(requestId);
  if (!permissionWait) {
    return;
  }

  const waitingMs = Math.max(now - permissionWait.requestedAt, 0);
  prompt.waitingMs += waitingMs;
  if (permissionWait.toolCallId) {
    const toolStep = state?.toolStepsById.get(permissionWait.toolCallId);
    if (toolStep) {
      toolStep.waitingMs += waitingMs;
    } else if (state) {
      const settled = state.settledPermissionWaitsByToolId.get(permissionWait.toolCallId);
      state.settledPermissionWaitsByToolId.set(permissionWait.toolCallId, {
        waitingMs: (settled?.waitingMs ?? 0) + waitingMs,
        earliestRequestedAt: Math.min(
          settled?.earliestRequestedAt ?? permissionWait.requestedAt,
          permissionWait.requestedAt,
        ),
      });
    }
  }
  prompt.permissionWaitsByRequestId.delete(requestId);
}

function applySettledPermissionWaitAttribution(
  state: AgentStepTelemetryState,
  step: ActiveAgentStep,
): void {
  if (!step.toolId) {
    return;
  }

  const settled = state.settledPermissionWaitsByToolId.get(step.toolId);
  if (!settled) {
    return;
  }

  step.waitingMs += settled.waitingMs;
  step.startedAt = Math.min(step.startedAt, settled.earliestRequestedAt);
  state.settledPermissionWaitsByToolId.delete(step.toolId);
}

function findEarliestPermissionRequestedAt(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
): number | undefined {
  let earliest = state.settledPermissionWaitsByToolId.get(toolCallId)?.earliestRequestedAt;
  for (const permissionWait of prompt.permissionWaitsByRequestId.values()) {
    if (permissionWait.toolCallId !== toolCallId) {
      continue;
    }
    earliest = Math.min(earliest ?? permissionWait.requestedAt, permissionWait.requestedAt);
  }
  return earliest;
}

function settlePermissionWaitsForTool(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
  now: number,
): void {
  for (const [requestId, permissionWait] of prompt.permissionWaitsByRequestId) {
    if (permissionWait.toolCallId === toolCallId) {
      settlePermissionWait(prompt, state, requestId, now);
    }
  }
}

function settleAllPermissionWaits(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  now: number,
): void {
  for (const requestId of prompt.permissionWaitsByRequestId.keys()) {
    settlePermissionWait(prompt, state, requestId, now);
  }
}

function closeToolSteps(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
): void {
  for (const [toolId, toolStep] of state.toolStepsById) {
    settlePermissionWaitsForTool(prompt, state, toolId, now);
    output.push(
      finalizeAgentStep({
        prompt,
        step: toolStep,
        finishedAt: now,
        status,
        errorType: error?.type,
        errorMsg: error?.msg,
      }),
    );
  }
  state.toolStepsById.clear();
}

export function buildPromptTelemetryExtraDetail(params: {
  askMode?: string | null;
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const modelProvider = resolvePromptTelemetryModelProvider({
    modelName: params.modelName,
    provider: params.provider,
    selectedSupplierKey: params.selectedSupplierKey,
  });
  const providerHostname = resolveProviderHostname(params.providerBaseURL);

  return {
    ask_mode: params.askMode ?? "",
    model_name: legacyTelemetryModelValue(params.modelName ?? ""),
    model_provider: legacyTelemetryProviderId(modelProvider),
    // 修复原因：custom provider 的 model_provider 经常是内部 uuid，数仓分析真实后端时没有意义。
    // provider_name 当前承载 provider hostname；不改 model_provider，避免影响既有 uuid/provider id 数仓口径。
    // 这里只从 URL 解析 hostname，不上报完整 endpoint，避免泄漏路径或 query。
    ...(providerHostname ? { provider_name: providerHostname } : {}),
    // agent 字段取 ZCode Agent provider；本仓库没有独立 session.agentId。
    agent: params.provider ?? "",
    plan_status: params.planIdentitySnapshot?.planStatus ?? "unknown",
    plan_product_id: params.planIdentitySnapshot?.planProductId ?? "",
  };
}

const COMPACTION_TERMINAL_STATUSES: readonly ZCodeTimelineStatus[] = [
  "completed",
  "failed",
  "interrupted",
];

function isCompactionTerminalStatus(status: ZCodeTimelineStatus): boolean {
  return COMPACTION_TERMINAL_STATUSES.includes(status);
}

/**
 * 构建压缩（context compaction）结果埋点字段。
 * 仅在终态（completed/failed/interrupted）返回字段对象，运行态（started/retrying/skipped）返回 null，
 * 调用方据此决定是否上报。成功率由数仓按 status 聚合：completed / (completed + failed + interrupted)。
 * provider/model 维度复用 buildPromptTelemetryExtraDetail，version 由后端 reportEvent 注入。
 */
export function buildCompactionTelemetryExtraDetail(params: {
  timeline: ZCodeContextCompactionTimelineMeta;
  provider?: ZCodeProvider;
  /** V4 fact 已从真实模型请求归一化出的 provider；优先于旧 UI supplier 推导。 */
  modelProvider?: string | null;
  modelName?: string | null;
  selectedSupplierKey?: string | null;
}): Record<string, string> | null {
  const { timeline } = params;
  if (!isCompactionTerminalStatus(timeline.status)) {
    return null;
  }

  const modelFields = params.provider
    ? buildPromptTelemetryExtraDetail({
        modelName: params.modelName,
        provider: params.provider,
        selectedSupplierKey: params.selectedSupplierKey,
      })
    : { model_name: params.modelName ?? "", model_provider: "" };

  const preCompactTokens = timeline.preCompactTokenCount ?? 0;
  const postCompactTokens = timeline.postCompactTokenCount ?? 0;
  // 压缩率用供应商口径 post/pre；pre 为 0（缺数据）时留空，避免除零污染分布。
  const compactRatio =
    preCompactTokens > 0 ? (postCompactTokens / preCompactTokens).toFixed(4) : "";
  const durationMs =
    timeline.startedAt !== undefined && timeline.endedAt !== undefined
      ? String(Math.max(timeline.endedAt - timeline.startedAt, 0))
      : "";

  return {
    status: timeline.status,
    trigger: timeline.trigger,
    reason: timeline.reason ?? "",
    attempt: String(timeline.attempt ?? 0),
    duration_ms: durationMs,
    pre_compact_tokens: String(preCompactTokens),
    post_compact_tokens: String(postCompactTokens),
    true_post_compact_tokens: String(timeline.truePostCompactTokenCount ?? 0),
    compact_ratio: compactRatio,
    model_name: legacyTelemetryModelValue(modelFields.model_name ?? ""),
    model_provider: legacyTelemetryProviderId(
      params.modelProvider?.trim() || modelFields.model_provider || "",
    ),
  };
}

function buildPromptUsageTelemetryExtraDetail(
  usage: ZCodeUsage | undefined,
  tokenSource?: string,
): Record<string, string> {
  if (!usage) {
    return {};
  }

  return {
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    reasoning_tokens: String(usage.reasoningTokens ?? 0),
    cached_input_tokens: String(usage.cachedInputTokens ?? 0),
    cache_write_input_tokens: String(usage.cachedWriteInputTokens ?? 0),
    // ZCode Agent 链路未透出 tool use prompt token，成功态显式补 0 保持 extraDetail 字段集合完整。
    tool_use_prompt_tokens: "0",
    total_tokens: String(usage.totalTokens),
    ...(tokenSource ? { token_source: tokenSource } : {}),
  };
}

function mergePromptUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) {
    return {
      inputTokens: right.inputTokens,
      outputTokens: right.outputTokens,
      totalTokens: right.totalTokens,
      reasoningTokens: right.reasoningTokens ?? 0,
      cachedInputTokens: right.cachedInputTokens ?? 0,
      cachedWriteInputTokens: right.cachedWriteInputTokens ?? 0,
    };
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

function ensureComposerInputTiming(workspacePath: string): ComposerInputTimingState {
  const existing = composerInputTimingByWorkspace.get(workspacePath);
  if (existing) {
    return existing;
  }

  const created: ComposerInputTimingState = {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  };
  composerInputTimingByWorkspace.set(workspacePath, created);
  return created;
}

export function consumeComposerInputTiming(
  workspacePath: string,
  sendTime: number,
): ComposerInputTimingSnapshot {
  const current = ensureComposerInputTiming(workspacePath);
  const inputStartTime = current.inputStartTime || current.inputFirstCharTime || sendTime;
  const inputFirstCharTime = current.inputFirstCharTime || inputStartTime || sendTime;

  composerInputTimingByWorkspace.set(workspacePath, {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  });

  return {
    inputStartTime,
    inputFirstCharTime,
  };
}

function collectFileChangeMetrics(fileChanges: readonly ZCodePersistedFileChange[] | undefined) {
  if (!fileChanges || fileChanges.length === 0) {
    return {
      changedFileCount: 0,
      generatedCodeLines: 0,
    };
  }

  const changedFileMap = new Map<string, { beforeContent: string | null; afterContent: string }>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
      } else {
        changedFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
        });
      }
    }
  }

  let generatedCodeLines = 0;
  for (const file of changedFileMap.values()) {
    generatedCodeLines += computeLineChangeStat(file.beforeContent, file.afterContent).added;
  }

  return {
    changedFileCount: changedFileMap.size,
    generatedCodeLines,
  };
}

export function recordComposerFocus(workspacePath: string, now = Date.now()): void {
  const inputTiming = ensureComposerInputTiming(workspacePath);
  inputTiming.inputStartTime = now;
  inputTiming.inputFirstCharTime = 0;
}

export function recordComposerInputStart(workspacePath: string, now = Date.now()): void {
  const inputTiming = ensureComposerInputTiming(workspacePath);
  if (inputTiming.inputFirstCharTime !== 0) return;
  inputTiming.inputFirstCharTime = now;
  if (inputTiming.inputStartTime === 0) inputTiming.inputStartTime = now;
}

export function resetComposerInputStart(workspacePath: string): void {
  ensureComposerInputTiming(workspacePath).inputFirstCharTime = 0;
}

export function recordComposerTextChange(
  workspacePath: string,
  nextText: string,
  now = Date.now(),
): void {
  if (nextText.length === 0) {
    return;
  }

  recordComposerInputStart(workspacePath, now);
}

function createPromptTelemetryState(input: {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  extraDetail?: Record<string, string>;
}): PromptTelemetryState {
  return {
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    baseEventExtraDetail: input.extraDetail ? { ...input.extraDetail } : {},
    sendTime: input.sendTime,
    inputStartTime: input.inputStartTime,
    inputFirstCharTime: input.inputFirstCharTime,
    waitingMs: 0,
    permissionWaitsByRequestId: new Map(),
    firstTokenAt: null,
    usage: null,
    usageEventKeys: new Set(),
    finalizedAgentStepCount: 0,
    toolCallTotal: 0,
    toolCallFailed: 0,
    firstToolCallError: "",
  };
}

export function queuePromptTelemetry(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  inputTiming?: ComposerInputTimingSnapshot;
  extraDetail?: Record<string, string>;
}) {
  const { inputStartTime, inputFirstCharTime } =
    input.inputTiming ?? consumeComposerInputTiming(input.workspacePath, input.sendTime);
  const promptTelemetry = createPromptTelemetryState({
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    sendTime: input.sendTime,
    inputStartTime,
    inputFirstCharTime,
    ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
  });

  const existingQueue = queuedPromptTelemetryByTask.get(input.taskId) ?? [];
  queuedPromptTelemetryByTask.set(input.taskId, [...existingQueue, promptTelemetry]);

  return {
    ...promptTelemetry.baseEventExtraDetail,
    input_start_time: String(inputStartTime),
    input_first_char_time: String(inputFirstCharTime),
    input_send_time: String(input.sendTime),
  };
}

export function activatePromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === messageId);
  if (targetIndex === -1) {
    return;
  }

  const [target] = queue.splice(targetIndex, 1);
  if (!target) {
    return;
  }

  if (queue.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
  } else {
    queuedPromptTelemetryByTask.set(taskId, queue);
  }

  activePromptTelemetryByTask.set(taskId, target);
  agentStepTelemetryByTask.set(taskId, createAgentStepTelemetryState());
}

/** background child 只复用 agent_step 状态，不创建或上报独立的 message 生命周期。 */
export function activateDetachedAgentStepTelemetry(input: {
  taskId: string;
  messageId: string;
  sendTime: number;
  extraDetail?: Record<string, string>;
}): void {
  activePromptTelemetryByTask.set(
    input.taskId,
    createPromptTelemetryState({
      taskId: input.taskId,
      messageId: input.messageId,
      sendTime: input.sendTime,
      inputStartTime: input.sendTime,
      inputFirstCharTime: input.sendTime,
      ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
    }),
  );
  agentStepTelemetryByTask.set(input.taskId, createAgentStepTelemetryState());
}

export function rekeyQueuedPromptTelemetry(
  taskId: string,
  fromMessageId: string,
  toMessageId: string,
): void {
  if (fromMessageId === toMessageId) {
    return;
  }

  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === fromMessageId);
  if (targetIndex === -1) {
    return;
  }

  const target = queue[targetIndex];
  if (!target) {
    return;
  }

  queue[targetIndex] = {
    ...target,
    messageId: toMessageId,
  };
  queuedPromptTelemetryByTask.set(taskId, queue);
}

export function recordPromptModelRequestStarted(
  taskId: string,
  event: Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>,
  activeInputId?: string,
): void {
  if (event.statusType !== "model_request_started") {
    return;
  }

  const active = activePromptTelemetryByTask.get(taskId);
  if (!active) {
    return;
  }

  const expectedInputId = activeInputId ?? active.inputId;
  if (expectedInputId && event.inputId && expectedInputId !== event.inputId) {
    return;
  }

  const modelProvider = event.providerId?.trim();
  const rawModelName = event.modelId?.trim();
  const providerHostname = resolveProviderHostname(event.baseURL);
  const modelName =
    rawModelName && modelProvider && !readProviderIdFromModelValue(rawModelName)
      ? `${modelProvider}/${rawModelName}`
      : rawModelName;
  if (!modelProvider && !modelName) {
    return;
  }

  if (active.firstTokenAt === null && (!event.querySource || event.querySource === "main_turn")) {
    active.ttftCandidateRequestId = event.requestId?.trim();
    active.ttftUsage = undefined;
  }
  const state = getAgentStepTelemetryState(taskId);
  state.currentModelRequest = {
    ...(event.requestId?.trim() ? { requestId: event.requestId.trim() } : {}),
    modelName: modelName ?? active.baseEventExtraDetail.model_name ?? "",
    modelProvider: modelProvider ?? active.baseEventExtraDetail.model_provider ?? "",
    providerName: providerHostname || active.baseEventExtraDetail.provider_name || "",
  };
  active.baseEventExtraDetail = {
    ...active.baseEventExtraDetail,
    // 修复原因：send_btn 是 UI 选择快照，但 message_completion/agent_step 要尽量代表真实模型请求。
    // 自定义供应商切换时 workspace configOptions 可能仍是 builtin 模型；这里用运行时 request_started 回包覆盖完成态模型维度。
    ...(modelName ? { model_name: modelName } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
    ...(providerHostname ? { provider_name: providerHostname } : {}),
  };
}

function findModelOutputStepForRequest(
  state: AgentStepTelemetryState,
  requestId: string,
): ActiveAgentStep | undefined {
  const candidates = [state.generationStep, state.reasoningStep];
  return candidates.find((step) => step?.model?.requestId === requestId) ?? undefined;
}

function assignUsageToStep(step: ActiveAgentStep, attribution: AgentStepUsageAttribution): void {
  step.usage = step.usage
    ? {
        requestIds: [...new Set([...step.usage.requestIds, ...attribution.requestIds])],
        requestCount: step.usage.requestCount + attribution.requestCount,
        scope:
          step.usage.scope === "subagent_requests" || attribution.scope === "subagent_requests"
            ? "subagent_requests"
            : "model_request",
        usage: mergePromptUsage(step.usage.usage, attribution.usage),
      }
    : attribution;
}

/**
 * 将 Subagent 的真实模型与累计 usage 写入其 Agent step。
 * foreground 使用父 task state，background 使用 detached child state。
 */
export function recordSubagentToolAttribution(input: {
  taskId: string;
  toolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  agentId: string;
  agentRole?: AgentStepRole;
  usage?: ZCodeUsage;
}): void {
  const state = agentStepTelemetryByTask.get(input.taskId);
  const step = state?.toolStepsById.get(input.toolCallId);
  if (!step) return;

  step.agentId = input.agentId;
  step.agentRole = input.agentRole ?? "foreground subagent";
  if (input.modelName || input.modelProvider || input.providerName) {
    step.model = {
      modelName: input.modelName,
      modelProvider: input.modelProvider,
      providerName: input.providerName,
    };
  }
  if (input.usage) {
    // Bug 根因：取消/失败时父 Agent 工具终态可能早于 SubagentStopped。若只在 stopped
    // 时首次归因，工具 step 已从活动索引删除，只能错误回退主模型且 token 为 0。
    // child fact 每次携带的是当前生命周期累计值，这里覆盖而不是叠加，避免增量同步重复计数。
    step.usage = {
      requestIds: [...input.requestIds],
      requestCount: input.requestCount,
      scope: "subagent_requests",
      usage: { ...input.usage },
    };
  }
}

function applyAgentStepToolAttribution(
  step: ActiveAgentStep,
  attribution: AgentStepToolAttribution | undefined,
): void {
  if (!attribution) return;
  if (attribution.agentId) {
    step.agentId = attribution.agentId;
    step.agentRole = attribution.agentRole ?? "foreground subagent";
  }
  if (attribution.modelName || attribution.modelProvider || attribution.providerName) {
    step.model = {
      modelName: attribution.modelName ?? "",
      modelProvider: attribution.modelProvider ?? "",
      providerName: attribution.providerName ?? "",
    };
  }
}

function applyAgentStepSkillMetadata(
  step: ActiveAgentStep,
  metadata: AgentStepSkillMetadata | undefined,
): void {
  if (!metadata || step.toolName !== "Skill") return;
  // 只接收已解析 metadata；绝不能用 input.skill/name 补齐失败调用的名称。
  const name =
    metadata.source && metadata.name !== undefined
      ? sanitizeTelemetrySkillName(metadata.name)
      : undefined;
  step.skillMetadata = {
    ...step.skillMetadata,
    ...(name ? { name } : {}),
    ...(metadata.qualifiedName ? { qualifiedName: metadata.qualifiedName } : {}),
    ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
  };
}

function materializePendingModelUsageBeforeTool(input: {
  prompt: PromptTelemetryState;
  state: AgentStepTelemetryState;
  now: number;
  finalized: FinalizedAgentStepTelemetry[];
  clientMode?: AgentStepTelemetryClientMode;
}): void {
  const requestId = input.state.currentModelRequest?.requestId;
  if (
    !requestId ||
    input.state.reasoningStep ||
    input.state.generationStep ||
    !input.state.pendingUsageByRequestId.has(requestId)
  ) {
    return;
  }

  // Bug 根因：模型直接返回 tool_use 时没有正文 step，旧逻辑会让 pending usage
  // 被随后创建的工具 step 消费。Agent 工具再叠加 child usage 后，就会把主模型 A
  // 和 child 模型 B 的 token 混在同一模型维度。这里补一个零时长 generation，
  // 只承接本次真实模型 request；工具 step 保持独立，等待工具或前台 child 的事实。
  input.state.generationStep = createAgentStep(input.state, "generation", input.now);
  closeGenerationStep(
    input.prompt,
    input.state,
    input.now,
    "success",
    input.finalized,
    undefined,
    "tool_call",
    input.clientMode,
  );
}

export function recordAgentStepTelemetryEvent(input: {
  taskId: string;
  event: ZCodeStreamEvent;
  activeInputId?: string;
  clientMode?: AgentStepTelemetryClientMode;
  toolAttribution?: AgentStepToolAttribution;
  skillMetadata?: AgentStepSkillMetadata;
  now?: number;
}): FinalizedAgentStepTelemetry[] {
  const prompt = activePromptTelemetryByTask.get(input.taskId);
  if (!prompt) {
    return [];
  }
  const eventInputId =
    "inputId" in input.event && typeof input.event.inputId === "string"
      ? input.event.inputId
      : undefined;
  if (input.activeInputId && eventInputId && input.activeInputId !== eventInputId) {
    // Bugfix：completion 改用逐 step 聚合后，旧 input 的迟到 chunk/tool 也会污染当前 message。
    // ownership 以 runtime activeInputId 为准，兼容 queued prompt 发送时实际 inputId 重绑定。
    return [];
  }

  const now = input.now ?? Date.now();
  const state = getAgentStepTelemetryState(input.taskId);
  const finalized: FinalizedAgentStepTelemetry[] = [];

  switch (input.event.type) {
    case "agent_thought_chunk":
      markPromptFirstToken(prompt, now, "reasoning");
      if (!state.reasoningStep) {
        closeGenerationStep(
          prompt,
          state,
          now,
          "success",
          finalized,
          undefined,
          "reasoning",
          input.clientMode,
        );
        state.reasoningStep = createAgentStep(state, "reasoning", now);
      }
      return finalized;

    case "agent_message_chunk":
      if (input.event.zcodeTimeline) {
        return finalized;
      }
      if (input.event.parentToolUseId) {
        // 修复原因：带 parentToolUseId 的 chunk 是工具/子 agent 输出，UI 会挂到工具卡片；
        // 不能把它当主 assistant 正文创建 generation step 或刷新正文尾包时间。
        return finalized;
      }
      markPromptFirstToken(prompt, now, "text");
      closeReasoningStep(prompt, state, now, finalized);
      if (!state.generationStep) {
        state.generationStep = createAgentStep(state, "generation", now);
      }
      state.generationStep.lastMessageChunkAt = now;
      return finalized;

    case "tool_call": {
      markPromptFirstToken(prompt, now, "tool");
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "tool_call",
        input.clientMode,
      );
      materializePendingModelUsageBeforeTool({
        prompt,
        state,
        now,
        finalized,
        clientMode: input.clientMode,
      });
      const toolStep = createAgentStep(state, "tool_call", now, {
        toolId: input.event.toolId,
        toolName: input.event.toolName ?? input.event.kind,
      });
      applyAgentStepToolAttribution(toolStep, input.toolAttribution);
      if (input.event.pluginMetadata) toolStep.pluginMetadata = input.event.pluginMetadata;
      applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
      applySettledPermissionWaitAttribution(state, toolStep);
      state.toolStepsById.set(input.event.toolId, toolStep);
      return finalized;
    }

    case "tool_call_update": {
      markPromptFirstToken(prompt, now, "tool");
      if (input.event.status === "pending" || input.event.status === "in_progress") {
        if (!state.toolStepsById.has(input.event.toolId)) {
          closeReasoningStep(prompt, state, now, finalized);
          closeGenerationStep(
            prompt,
            state,
            now,
            "success",
            finalized,
            undefined,
            "tool_call",
            input.clientMode,
          );
          materializePendingModelUsageBeforeTool({
            prompt,
            state,
            now,
            finalized,
            clientMode: input.clientMode,
          });
          const toolStep = createAgentStep(state, "tool_call", now, {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          });
          applyAgentStepToolAttribution(toolStep, input.toolAttribution);
          if (input.event.pluginMetadata) toolStep.pluginMetadata = input.event.pluginMetadata;
          applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
          applySettledPermissionWaitAttribution(state, toolStep);
          state.toolStepsById.set(input.event.toolId, toolStep);
        }
        return finalized;
      }

      let existing = state.toolStepsById.get(input.event.toolId);
      if (!existing) {
        materializePendingModelUsageBeforeTool({
          prompt,
          state,
          now,
          finalized,
          clientMode: input.clientMode,
        });
        existing = createAgentStep(
          state,
          "tool_call",
          findEarliestPermissionRequestedAt(prompt, state, input.event.toolId) ?? now,
          {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          },
        );
      }
      if (input.event.pluginMetadata) existing.pluginMetadata = input.event.pluginMetadata;
      applyAgentStepSkillMetadata(existing, input.skillMetadata ?? input.event.skillMetadata);
      applyAgentStepToolAttribution(existing, input.toolAttribution);
      // 修复原因：恢复/乱序链路可能先看到 permission_request，随后直接收到工具终态，
      // 没有前置 tool_call。先回填已收口等待，再把兜底 step 放回索引消费仍开放的等待，
      // 最后校正 startedAt，保证工具墙钟耗时始终覆盖 waiting_ms。
      applySettledPermissionWaitAttribution(state, existing);
      state.toolStepsById.set(input.event.toolId, existing);
      settlePermissionWaitsForTool(prompt, state, input.event.toolId, now);
      existing.startedAt = Math.min(existing.startedAt, now - existing.waitingMs);
      state.toolStepsById.delete(input.event.toolId);
      finalized.push(
        finalizeAgentStep({
          prompt,
          step: {
            ...existing,
            toolName: input.event.toolName ?? input.event.kind ?? existing.toolName,
          },
          finishedAt: now,
          status: input.event.status,
          errorType: input.event.status === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMsg: input.event.error,
          errorCode: input.event.errorCode,
          // Bug 原因：兼容流过去只把工具名和状态交给 agent_step，CronCreate
          // 返回的新任务 ID 留在 content 中，导致运营无法关联创建步骤与任务。
          automationId:
            input.event.status === "completed" &&
            (input.event.toolName ?? input.event.kind ?? existing.toolName) === "CronCreate"
              ? cronCreateAutomationId(input.event.content)
              : undefined,
        }),
      );
      return finalized;
    }

    case "task_complete":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "task_complete",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "success", finalized);
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    case "task_error":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "fail",
        finalized,
        {
          type: input.event.code ?? "UNKNOWN",
          msg: input.event.error,
        },
        "task_error",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "fail", finalized, {
        type: input.event.code ?? "UNKNOWN",
        msg: input.event.error,
      });
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    default:
      return finalized;
  }
}

export function recordPromptFirstToken(taskId: string, now = Date.now()): void {
  const active = activePromptTelemetryByTask.get(taskId);
  if (!active || active.firstTokenAt !== null) {
    return;
  }

  active.firstTokenAt = now;
}

// 当前激活 prompt 的模型名,供 ARMS 镜像事件(stream_stall 等)补齐 model 维度;
// 无激活 prompt 或未带 model_name 时返回 undefined,由调用方留空。
export function getActivePromptModelName(taskId: string): string | undefined {
  const active = activePromptTelemetryByTask.get(taskId);
  return active?.baseEventExtraDetail.model_name || undefined;
}

export function getActivePromptMessageId(taskId: string): string | undefined {
  return activePromptTelemetryByTask.get(taskId)?.messageId;
}

export function recordPromptAdmissionTelemetry(
  taskId: string,
  facts: {
    isFirstMessage?: boolean;
    sendMode?: "direct" | "queued";
  },
): void {
  const active = activePromptTelemetryByTask.get(taskId);
  if (!active) return;
  active.isFirstMessage = facts.isFirstMessage;
  active.sendMode = facts.sendMode;
}

/** 独立请求指标只服务首响归属，绝不再次累加 message/agent_step Token。 */
export function recordPromptRequestMetrics(input: {
  taskId: string;
  requestId: string;
  inputTokens?: number;
  cacheReadTokens?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) return;
  // 指标可能先于 tool_call；首响后只允许冻结的请求回填。
  const target =
    active.firstTokenAt === null ? active.ttftCandidateRequestId : active.ttftRequestId;
  if (input.requestId !== target) return;
  active.ttftUsage = {
    requestId: input.requestId,
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cacheReadTokens,
  };
}

export function recordPromptTokenUsageDelta(input: {
  taskId: string;
  eventKey: string;
  usage: ZCodeUsage;
  requestId?: string;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const eventKey = input.eventKey.trim();
  if (!active || eventKey.length === 0 || active.usageEventKeys.has(eventKey)) {
    return;
  }

  active.usageEventKeys.add(eventKey);
  active.usage = mergePromptUsage(active.usage, input.usage);

  const requestId = input.requestId?.trim();
  if (!requestId) return;
  const state = getAgentStepTelemetryState(input.taskId);
  const modelName = input.modelName?.trim();
  const modelProvider = input.modelProvider?.trim();
  const providerName = input.providerName?.trim();
  const step = findModelOutputStepForRequest(state, requestId);
  if (step) {
    step.model = {
      requestId,
      modelName: modelName ?? step.model?.modelName ?? "",
      modelProvider: modelProvider ?? step.model?.modelProvider ?? "",
      providerName: providerName ?? step.model?.providerName ?? "",
    };
    assignUsageToStep(step, {
      requestIds: [requestId],
      requestCount: 1,
      scope: "model_request",
      usage: input.usage,
    });
    return;
  }

  state.pendingUsageByRequestId.set(requestId, {
    requestIds: [requestId],
    requestCount: 1,
    scope: "model_request",
    usage: input.usage,
  });
}

export function recordPromptPermissionRequest(input: {
  taskId: string;
  requestId: string;
  toolCallId?: string;
  raw?: unknown;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const requestId = input.requestId.trim();
  if (!active || requestId.length === 0 || active.permissionWaitsByRequestId.has(requestId)) {
    return;
  }

  const raw =
    input.raw !== null && typeof input.raw === "object"
      ? (input.raw as Record<string, unknown>)
      : {};
  const rawToolCallId =
    typeof raw.toolCallId === "string" && raw.toolCallId.trim().length > 0
      ? raw.toolCallId.trim()
      : undefined;
  const toolCallId = input.toolCallId?.trim() || rawToolCallId || requestId;
  active.permissionWaitsByRequestId.set(requestId, {
    requestedAt: input.now ?? Date.now(),
    ...(toolCallId ? { toolCallId } : {}),
  });
}

export function recordPromptPermissionResponse(input: {
  taskId: string;
  requestId: string;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return;
  }

  settlePermissionWait(
    active,
    agentStepTelemetryByTask.get(input.taskId),
    input.requestId,
    input.now ?? Date.now(),
  );
}

export function finalizePromptTelemetry(
  input: FinalizePromptTelemetryInput,
): FinalizedPromptTelemetry | null {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return null;
  }

  settleAllPermissionWaits(active, agentStepTelemetryByTask.get(input.taskId), input.finishedAt);
  activePromptTelemetryByTask.delete(input.taskId);
  agentStepTelemetryByTask.delete(input.taskId);

  const { changedFileCount, generatedCodeLines } = collectFileChangeMetrics(input.fileChanges);
  const isSuccess = input.status === "success";
  // V4 live fact 的 usage 以低频 delta 到达，terminal 不重复携带整包累计值；
  // 旧链路仍可在 terminal 直接传 usage。成功态优先显式 terminal usage，缺省回落已聚合 delta。
  const usageForTelemetry = isSuccess
    ? (input.usage ?? active.usage ?? undefined)
    : (active.usage ?? undefined);
  const tokenSource = !isSuccess && active.usage ? "usage_delta" : undefined;
  const errorType = isSuccess
    ? ""
    : input.errorType?.trim() || (active.toolCallFailed > 0 ? "TOOL_CALL_FAILED" : "UNKNOWN");
  const errorMsg = isSuccess ? "" : input.errorMsg?.trim() || active.firstToolCallError;

  return {
    taskId: input.taskId,
    messageId: active.messageId,
    eventExtraDetail: {
      ...legacyTelemetryModelFields(active.baseEventExtraDetail),
      ...(usageForTelemetry
        ? buildPromptUsageTelemetryExtraDetail(usageForTelemetry, tokenSource)
        : {}),
      duration_ms: String(Math.max(input.finishedAt - active.sendTime, 0)),
      waiting_ms: String(active.waitingMs),
      generated_code_lines: String(generatedCodeLines),
      file_change_cnt: String(changedFileCount),
      is_first_message:
        active.isFirstMessage === undefined ? "unknown" : active.isFirstMessage ? "1" : "0",
      send_mode: active.sendMode ?? "unknown",
      ttft_output_kind:
        active.firstTokenAt === null ? "none" : (active.ttftOutputKind ?? "unknown"),
      ttft_request_id: active.ttftRequestId ?? "",
      ttft_input_tokens:
        active.ttftRequestId && active.ttftUsage?.requestId === active.ttftRequestId
          ? String(active.ttftUsage.inputTokens ?? "")
          : "",
      ttft_cached_input_tokens:
        active.ttftRequestId && active.ttftUsage?.requestId === active.ttftRequestId
          ? String(active.ttftUsage.cachedInputTokens ?? "")
          : "",
      time_to_first_token:
        active.firstTokenAt === null
          ? "-1"
          : String(Math.max(active.firstTokenAt - active.sendTime, 0)),
      request_time: String(active.sendTime),
      status: input.status,
      ...(input.messageSource ? { message_source: input.messageSource } : {}),
      agent_composition: input.agentComposition ?? "main_only",
      agent_step_cnt: String(active.finalizedAgentStepCount),
      retry_cnt: "0",
      tool_call_total: String(active.toolCallTotal),
      tool_call_failed: String(active.toolCallFailed),
      error_type: errorType,
      error_msg: errorMsg,
    },
  };
}

export function resetMessageTelemetryForTest(): void {
  composerInputTimingByWorkspace.clear();
  queuedPromptTelemetryByTask.clear();
  activePromptTelemetryByTask.clear();
  agentStepTelemetryByTask.clear();
}

/** workspace telemetry attachment 释放时只清自己的内部 task key，不影响其它 workspace。 */
export function discardPromptTelemetry(taskId: string): void {
  queuedPromptTelemetryByTask.delete(taskId);
  activePromptTelemetryByTask.delete(taskId);
  agentStepTelemetryByTask.delete(taskId);
}

/** 仅丢弃尚未激活的单条 prompt，避免同 session 其它排队消息被一并清空。 */
export function discardQueuedPromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue) return;
  const next = queue.filter((item) => item.messageId !== messageId);
  if (next.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
    return;
  }
  queuedPromptTelemetryByTask.set(taskId, next);
}
