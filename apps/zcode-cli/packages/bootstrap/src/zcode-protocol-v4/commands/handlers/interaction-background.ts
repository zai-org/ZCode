import { permissionGrantMode } from "@zcode/shared/zcode-protocol-v4";
// 权限/后台命令组：resolveInteraction / cancelBackgroundWork。
// - resolveInteraction：前向命令收口反向请求（permission/AskUserQuestion），经
//   host.interactions（V4InteractionRegistry）投递给 broker 侧等待中的 deferred。
// - cancelBackgroundWork：直驱 core 的可选能力 cancelBackgroundTask（workId ≡ taskId）。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  SavedWorkflowStartRejectionReason,
  WorkflowRunSettingsRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/**
 * 能力不支持错误：会话 runtime 未实现可选能力时抛出（对照旧 server-operations.ts
 * cancelBackgroundTask 的 ProtocolRequestError -32031 语义）。v4 侧不再用 JSON-RPC
 * 错误码，改用带 reasonCode 的结构化 Error（fault 命名空间），网关据此收口 ACK。
 */
export class V4CapabilityUnsupportedError extends Error {
  readonly reasonCode = "fault.command.capabilityUnsupported";

  constructor(capability: string, sessionId: string) {
    super(`capability not supported by this session runtime: ${capability} (session ${sessionId})`);
    this.name = "V4CapabilityUnsupportedError";
  }
}

/**
 * resolveInteraction：投递应答给等待中的反向请求（interaction-broker 的 race deferred）。
 *
 * 语义保真（勘查结论）：
 * - 未命中（delivered === false，交互已被应答/已注销/未知 id）按幂等成功收口，不抛错——
 *   多端先到先得，晚到应答是无害幂等操作，抛 failed 会误导客户端。
 * - 不做 requireRecord：晚到应答可能发生在会话已收口/删除之后，同样必须无害；
 *   登记表按 interactionId 全局寻址，不依赖 record 存在。
 */
async function resolveInteraction(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resolveInteraction"];
  const mode = permissionGrantMode(payload.answer.optionId);
  const delivered = mode
    ? ((await host.interactions?.resolvePermissionMode(
        payload.interactionId,
        envelope.sessionId!,
        mode,
      )) ?? false)
    : (host.interactions?.resolve(
        payload.interactionId,
        payload.answer,
        envelope.sessionId,
        envelope.pluginDiscoveryUi === true,
      ) ?? false);
  // 未命中也会返回 accepted；只有实际提交的授权才能作为新会话默认权限的依据。
  if (delivered && mode) {
    return {
      type: "resolveInteraction",
      resolvedBy: { clientId: envelope.clientId, optionId: payload.answer.optionId },
    };
  }
  if (!delivered) {
    host.logger?.info?.("v4 resolveInteraction no pending interaction (idempotent)", {
      event: "zcode_protocol.v4.interaction_already_resolved",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

async function snoozeInteractionAutoResolution(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
  const snoozed = (await host.interactions?.snoozeAutoResolution(payload.interactionId)) ?? false;
  if (!snoozed) {
    host.logger?.info?.("v4 snoozeInteractionAutoResolution no active countdown (idempotent)", {
      event: "zcode_protocol.v4.interaction_auto_resolution_already_snoozed",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

export class V4WorkspaceHookReviewRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Workspace Hook review command rejected: ${reasonCode}`);
    this.name = "V4WorkspaceHookReviewRejectedError";
  }
}

async function respondWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["respondWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.respondWorkspaceHookReview(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function toggleWorkspaceHookReviewItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["toggleWorkspaceHookReviewItem"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.toggleWorkspaceHookReviewItem(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function revokeWorkspaceHookTrust(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["revokeWorkspaceHookTrust"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.revokeWorkspaceHookTrust(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

/**
 * 软门禁:按需开审核 flow。
 *
 * 用户点击「去审核」时调用。经 controller.requestReview → openOrReuseFlow +
 * superviseFlow。已有活跃 flow 时幂等复用。无 pending 项时为安全 no-op。
 */
async function requestWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["requestWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.requestWorkspaceHookReview({
    workspaceIdentity: payload.workspaceIdentity,
    bundleDigest: payload.bundleDigest,
  });
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

function requireWorkspaceHookReviewRecord(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  payloadSessionId: string,
) {
  if (envelope.sessionId !== payloadSessionId) {
    throw new V4WorkspaceHookReviewRejectedError("workspace_hooks_snapshot_mismatch");
  }
  return requireRecord(host, envelope.sessionId);
}

/**
 * cancelBackgroundWork 的业务拒绝：core 明确回「没有取消任何东西」（reason 在场）。
 *
 * 老 run 被冷回放误留在 running 时，详情页的 Cancel 可点，
 * 命令直达 core 却查无此任务（`background_task_not_found`）；旧 handler 把结构化结果整个丢掉、
 * 回 accepted，用户面前于是「点了没反应」。core 的 reason 是唯一权威，这里只做前缀搬运。
 */
class V4BackgroundWorkCancelRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, workId: string) {
    super(`background work ${workId} was not cancelled: ${reason}`);
    this.name = "V4BackgroundWorkCancelRejectedError";
    this.reasonCode = `${BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}${reason.replace(/^background_task_/, "")}`;
  }
}

/**
 * cancelBackgroundWork：workId ≡ 旧 taskId 直传 core。
 * - cancelBackgroundTask 是 ZCodeApp 可选能力：不存在 → 抛能力不支持（见上）。
 * - core 回 `reason`（不存在 / 已终结 / 类型不支持）→ 以 `fault.command.backgroundWorkCancelRejected.<reason>`
 *   的 reasonCode 回 ACK；真取消了或返回值缺席（stub 宿主）才是 accepted。
 * - 不需要 legacy 广播：BackgroundTask*（Started/Updated/Completed）生命周期事件
 *   由 core 直接 emit，v4 投影（product-projection backgroundWorks）自收口——
 *   对照旧 op 的 afterStateMutation("background_task_cancelled")，v4 面无此义务。
 */
async function cancelBackgroundWork(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelBackgroundWork"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.cancelBackgroundTask) {
    throw new V4CapabilityUnsupportedError("cancelBackgroundTask", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.cancelBackgroundTask(payload.workId);
  if (result?.reason !== undefined) {
    throw new V4BackgroundWorkCancelRejectedError(result.reason, payload.workId);
  }
  return undefined;
}

class V4SubagentStopRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, taskId: string) {
    super(`subagent ${taskId} was not stopped: ${reason}`);
    this.name = "V4SubagentStopRejectedError";
    this.reasonCode = `fault.command.subagentStopRejected.${reason.replace(/^background_task_/, "")}`;
  }
}

async function stopSubagent(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["stopSubagent"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.runtime?.stopBackgroundTask) {
    throw new V4CapabilityUnsupportedError("stopBackgroundTask", record.app.sessionId);
  }
  const result = await record.app.runtime.stopBackgroundTask(payload.taskId, {
    expectedExecutionId: payload.executionId,
    initiator: "user",
    strict: true,
  });
  if (!result.ok) throw new V4SubagentStopRejectedError(result.reason, payload.taskId);
  return undefined;
}

/**
 * resumeWorkflowRun：workId ≡ runId 直传 app 能力。
 * - 能力缺席（journal 不可用 / 端口无 resume）→ 能力不支持错误（同 cancel 的语义）。
 * - 业务拒绝（not_found / not_resumable / already_running / script_missing /
 *   script_mismatch / compile_failed）以 `fault.command.workflowRunResumeRejected.<reason>` 的 reasonCode
 *   回 ACK——网关对携带 reasonCode 的领域错误原样上行，UI 按词表分流；不用错误文本做判断。
 *   compile_failed 的有界诊断经 `error.message` 收进 `ack.message`（与 startSavedWorkflow 同一约定）。
 */
class V4WorkflowRunResumeRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, message?: string) {
    super(message ?? `workflow run resume rejected: ${reason}`);
    this.name = "V4WorkflowRunResumeRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function resumeWorkflowRun(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resumeWorkflowRun"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.resumeWorkflowRun) {
    throw new V4CapabilityUnsupportedError("resumeWorkflowRun", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.resumeWorkflowRun({
    workId: payload.workId,
    ...(payload.name === undefined ? {} : { name: payload.name }),
  });
  if (!result.ok) throw new V4WorkflowRunResumeRejectedError(result.reason, result.message);
  return undefined;
}

/**
 * startSavedWorkflow：中枢直接启动一个已保存的工作流。
 * - 能力缺席（无 dwf 端口 / stub 宿主）→ 能力不支持错误（与 resume 家族同一条语义），GUI 原样显示
 *   「当前 agent 不支持直接启动」并回收空会话。
 * - 业务拒绝（invalid_name / not_found / invalid_args / compile_failed / session_busy / start_failed）
 *   以 `fault.command.savedWorkflowStartRejected.<reason>` 的 reasonCode 回 ACK；`message` 携带
 *   人可读诊断（编译诊断合并后有界截断），供实参窗行内展示。网关对携带 reasonCode 的领域错误
 *   原样上行、并把 `error.message` 收进 `ack.message`，UI 按词表分流——不用错误文本做流程判断。
 * - 成功以 `{ type: "startSavedWorkflow", runId, toolCallId }` 回 ACK.result（联工具卡 → 详情页）。
 * 注：非输入类命令（不排队、不带 baseRevision），与 resume / cancel 同类，登记在 interaction-background 组。
 */
class V4SavedWorkflowStartRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: SavedWorkflowStartRejectionReason, message?: string) {
    // message 直接进 ack.message（网关约定：error.message 收口到 ACK），缺席时给可读兜底。
    super(message ?? `saved workflow start rejected: ${reason}`);
    this.name = "V4SavedWorkflowStartRejectedError";
    this.reasonCode = `${SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function startSavedWorkflow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["startSavedWorkflow"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.startSavedWorkflow) {
    throw new V4CapabilityUnsupportedError("startSavedWorkflow", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.startSavedWorkflow({
    name: payload.name,
    ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    ...(payload.args === undefined ? {} : { args: payload.args }),
  });
  if (!result.ok) throw new V4SavedWorkflowStartRejectedError(result.reason, result.message);
  return { type: "startSavedWorkflow", runId: result.runId, toolCallId: result.toolCallId };
}

/**
 * amendWorkflowRunSettings：run 卡 / 详情页的「配置」。workId ≡ runId；两项设置的三态原样下传给 runtime。
 * - 能力缺席（无 dwf 端口，或端口不带 amend / getScript）→ 能力不支持错误，弹层显示「不支持」。
 * - 业务拒绝以 `fault.command.workflowRunSettingsRejected.<reason>` 回 ACK，`message` 携带诊断
 *   （编译诊断 / 模型解析诊断 / 启动失败原因）；拒绝时旧 run 照旧在跑。
 * - 成功以 `{ type, runId, toolCallId, supersededRunId? }` 回 ACK.result——新 run 的两把联接键，
 *   详情页据它把 tab 换到新 run。
 */
class V4WorkflowRunSettingsRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: WorkflowRunSettingsRejectionReason, message?: string) {
    super(message ?? `workflow run settings rejected: ${reason}`);
    this.name = "V4WorkflowRunSettingsRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function amendWorkflowRunSettings(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["amendWorkflowRunSettings"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.amendWorkflowRunSettings) {
    throw new V4CapabilityUnsupportedError("amendWorkflowRunSettings", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.amendWorkflowRunSettings({
    runId: payload.workId,
    ...(payload.subagentModel === undefined ? {} : { subagentModel: payload.subagentModel }),
    ...(payload.maxConcurrency === undefined ? {} : { maxConcurrency: payload.maxConcurrency }),
  });
  if (!result.ok) throw new V4WorkflowRunSettingsRejectedError(result.reason, result.message);
  return {
    type: "amendWorkflowRunSettings",
    runId: result.runId,
    toolCallId: result.toolCallId,
    ...(result.supersededRunId === undefined ? {} : { supersededRunId: result.supersededRunId }),
  };
}

export const interactionBackgroundHandlers = {
  resolveInteraction,
  respondWorkspaceHookReview,
  toggleWorkspaceHookReviewItem,
  revokeWorkspaceHookTrust,
  requestWorkspaceHookReview,
  snoozeInteractionAutoResolution,
  cancelBackgroundWork,
  stopSubagent,
  resumeWorkflowRun,
  startSavedWorkflow,
  amendWorkflowRunSettings,
};
