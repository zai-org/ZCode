// 会话管理命令组：createSession / renameSession / deleteSession。
// 每个命令组一个文件：handler 纯函数 (host, envelope) → CommandResult|undefined，
// 决策逻辑直驱 core，环境能力走 host 钩子（见 ../types.ts 的过渡标注）。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadata } from "../input-intent.js";
import { commandAdmissionOf } from "../executor.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { applyRequestedSessionConfig } from "./model-config.js";
import {
  hasPromptInput,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";

/**
 * createSession：回落面最后一项的原生化。
 * 语义决策（原生层持有）：
 * - draft 语义：新会话一律 deferred（不进 sqlite），首条发送时由 prompt-turn 提升
 *   immediate——record 创建钩子固定传 deferred，提升逻辑不在钩子里。
 * - firstInput 可选：有则经原生 prompt turn 提交（与 sendText 同一条写路径——
 *   draft 提升/提交即返/ready 边界三个语义免费获得），不再经旧 sendPrompt op。
 * - workspaceId：本地工作区 = workspacePath（Workspace Identity 约束的本地 fallback）；
 *   远程 identity（remote:ssh/wsl/docker:...）由 host.createSessionRecord 经
 *   @zcode/shared parseRemoteWorkspaceIdentity 统一解析（跨 workspace 分屏 pane）。
 * 执行面（过渡钩子）：record 建立/事件接线/catalog 同步/失败清理与旧宿主纠缠，
 * 走 host.createSessionRecord（见 ../types.ts）。
 */
async function createSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  if (!host.createSessionRecord) {
    throw new Error("v4 createSession requires host.createSessionRecord capability");
  }
  // "已创建 worktree" 只描述 cwd 指向的 worktree；缺 cwd 时没有可绑定的目录。
  if (payload.worktreeCreation && !payload.cwd) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "worktreeCreation requires cwd");
  }
  // 完全空的 firstInput 必须在创建 record 前拒绝，避免失败请求遗留无效 deferred session。
  if (
    payload.firstInput &&
    !hasPromptInput(payload.firstInput.text, payload.firstInput.attachments)
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const { sessionId } = await host.createSessionRecord({
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.additionalDirectories
      ? { additionalDirectories: payload.additionalDirectories }
      : {}),
    workspaceId: payload.workspaceId,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.permissionScope ? { permissionScope: payload.permissionScope } : {}),
    mcpServers: payload.mcpServers,
    offPeakToolEnabled: payload.offPeakToolEnabled,
    dynamicWorkflowEnabled: payload.dynamicWorkflowEnabled,
    dynamicWorkflowMode: payload.dynamicWorkflowMode,
  });
  if (payload.worktreeCreation) {
    // 首轮持久化会话后、TurnStarted 之前落盘并投影（docs/git/worktree.md §6.6.4）。
    requireRecord(host, sessionId).app.runtime.recordPendingWorktreeCreation(
      payload.worktreeCreation,
    );
  }
  // createSession.config 消费——草稿态 UI 的先行选择（模型/思考深度/
  // 模式）在首发之前应用并补发事件，首条 turn 即用所选配置。必须在 firstInput 之前。
  // 普通配置保留既有 warn 降级；Guarded 是明确的授权选择，失败不得用缺省模式执行。
  if (payload.config) {
    const record = requireRecord(host, sessionId);
    try {
      await applyRequestedSessionConfig(host, record, payload.config);
    } catch (error) {
      if (payload.config.mode === "guarded" || payload.firstInput?.mode === "guarded") {
        // 根因：旧 catch 吞掉模式应用失败后仍提交首轮，Guarded 会静默退化。
        try {
          await host.deleteSession?.(sessionId);
        } catch (closeError) {
          host.logger?.warn?.("v4 guarded draft cleanup failed", { sessionId, closeError });
        }
        throw error;
      }
      host.logger?.warn?.("v4 createSession config apply failed; session keeps runtime defaults", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    }
  }
  let firstInput:
    | {
        delivery: "startNow" | "queue" | "guide";
        inputId: string;
        messageId?: string;
      }
    | undefined;
  if (payload.firstInput) {
    // 附件命令面：firstInput.attachments（AttachmentRef → TurnAttachment）随首条发送。
    const record = requireRecord(host, sessionId);
    const admission = commandAdmissionOf(envelope);
    const durableAdmission =
      (await host.admitInputCommand?.(envelope, sessionId, admission)) ?? null;
    try {
      const attachments = await mapAttachmentRefsToTurnAttachments(
        record.app,
        payload.firstInput.attachments,
      );
      const intent = inputIntentMetadata(envelope, {
        text: payload.firstInput.text,
        requestedDelivery: "startNow",
        attachmentRefs: payload.firstInput.attachments,
        ...resolveSubmittedExecutionState(record, payload.firstInput),
        // 首条消息与 sendText 同一来源契约：扩展代建会话时由 Host 注入，随 intent 持久化并投影。
        ...(payload.firstInput.source ? { source: payload.firstInput.source } : {}),
      });
      const started = await startPromptTurn(host, record, {
        content: payload.firstInput.text,
        inputId: envelope.commandId,
        intent,
        ...(attachments ? { attachments } : {}),
      });
      firstInput = {
        delivery: started.admission.kind === "queued" ? "queue" : "startNow",
        inputId: envelope.commandId,
        ...(started.messageId ? { messageId: started.messageId } : {}),
      };
    } catch (error) {
      if (durableAdmission) {
        try {
          await host.cancelInputCommand?.(
            sessionId,
            admission.queueItemId,
            "fault.command.inputRejected",
          );
        } catch (cancelError) {
          // 取消账本失败不能覆盖真正的首发失败；否则客户端会拿到错误的失败原因，
          // 而 admission 仍可在重启查询时按 discarded 收口，不会被误判为成功。
          host.logger?.warn?.("v4 createSession first input cancellation failed", {
            cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
            inputError: error instanceof Error ? error.message : String(error),
            queueItemId: admission.queueItemId,
            sessionId,
          });
        }
      }
      throw error;
    }
  }
  return { type: "createSession", sessionId, ...(firstInput ? { input: firstInput } : {}) };
}

/**
 * renameSession：用户显式重命名 → core runtime.setCustomSessionTitle。
 * - titleSource=custom 的粘性（此后自动标题生成被 custom_title 短路跳过）由 core 保证
 *   （core/src/runtime/methods/session-title.ts），handler 不重复实现。
 * - traceContext 透传会话根 traceContext（record 窄视图字段）：重命名归属该会话的
 *   任务链，不另起 trace（可观测性纪律）。
 * - 不做 legacy 广播：core 发 SessionTitleUpdated 事件，经 gateway 投影收口，
 *   v4 消费者由此感知标题变更。
 */
async function renameSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["renameSession"];
  const record = requireRecord(host, envelope.sessionId);
  // 注意：方法必须经 runtime 调用（不可解构，实现依赖 this 绑定，见 methods/index.ts 挂载方式）。
  await record.app.runtime.setCustomSessionTitle({
    title: payload.title,
    traceContext: record.traceContext,
  });
  return undefined;
}

/** CLI 先持久化软删除，再关闭运行实例；正文保留，后续冷种子不会复活该会话。 */
async function deleteSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.deleteSession) {
    // 关闭不能静默降级：钩子缺失说明 binder 接线不完整，直接失败（ACK failed）。
    throw new Error("v4 deleteSession requires host.deleteSession capability");
  }
  await host.deleteSession(record.app.sessionId);
  return undefined;
}

async function discardSharedContext(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["discardSharedContext"];
  const sessionId = envelope.sessionId;
  if (!sessionId || !host.discardSharedContext) {
    throw new Error("v4 discardSharedContext requires a session-scoped storage capability");
  }
  const updated = await host.discardSharedContext(sessionId, payload.contextId);
  if (!updated)
    throw new V4InputAdmissionRejectedError(
      "fault.command.inputRejected",
      "shared context is not pending",
    );
  return undefined;
}

export const sessionMgmtHandlers = {
  createSession,
  renameSession,
  deleteSession,
  discardSharedContext,
};
