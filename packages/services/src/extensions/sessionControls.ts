import { createHash } from "node:crypto";
import {
  EXTENSION_FULL_ACCESS_MODE,
  ExtensionError,
  type SessionResolveInteractionInput,
  type SessionResolveInteractionResult,
  type SessionSetPermissionModeInput,
  type SessionSetPermissionModeResult,
} from "@zcode/shared/extension-host";
import {
  PERMISSION_FULL_ACCESS_OPTION_ID,
  type CommandAck,
  type PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";
import type { AppSessionRef } from "@zcode/session-control/contracts";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import { withTrustedZCodeAgentV4Connection } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import {
  assertV4CommandAckOk,
  createHostCommandEnvelope,
  sendHostCasCommandV4,
} from "#src/zcode-agent/zcodeV4HostCommand.js";
import type { CapabilityCallContext } from "#src/extensions/capabilityTypes.js";
import type { PluginProjects } from "#src/extensions/pluginProjects.js";
import type { SessionInteractionsRead, SessionReads } from "#src/extensions/sessionReads.js";
import type { SessionAuditDetails, SessionsBackend } from "#src/extensions/sessionsBackend.js";

// 插件回答审批、提问与切换权限模式（docs/plugins/extension-host.md §17.12，P3e）。
//
//   resolveInteraction / setPermissionMode ──► 网关（已查 sessions.write 的声明、协议与授权）
//     └─ sessionsBackend.run（代际与授权 fence、审计）
//          ├─ reads.readInteractions：解析会话 + 范围检查（插件项目）+ 当前快照（镜像）
//          ├─ 完全访问另查 sessions.fullAccess（声明 → not-declared，授权 → not-granted）
//          └─ V4 命令（与界面同一套）：resolveInteraction / switchCollaborationMode
//               clientId = extension:<pluginId>；CLI 是唯一事实源，先到先得
//
// 不加超时：快照来自会话镜像（事件驱动）；命令的结果以 CLI 的回执为准。

export type FullAccessState = "granted" | "not-declared" | "not-granted";

export interface SessionControlsDeps {
  agent: IZCodeAgentService | undefined;
  reads: SessionReads;
  sessions: SessionsBackend;
  pluginProjects: Pick<PluginProjects, "projectIds">;
  /** 插件的完全访问状态：清单声明了 sessions.fullAccess 吗、用户授予了吗。 */
  fullAccess(pluginId: string): FullAccessState;
  logger: Pick<ServiceLogger, "info" | "warn">;
}

export interface SessionControls {
  /** 会话是否在调用方插件的项目里；不在时抛 forbidden（订阅与两个调用共用）。 */
  assertScope(pluginId: string, session: AppSessionRef): Promise<void>;
  /** 完全访问的检查（setPermissionMode、resolveInteraction 选 fullAccess、createSession 带 yolo 共用）。 */
  assertFullAccess(pluginId: string): void;
  resolveInteraction(
    call: CapabilityCallContext,
    input: SessionResolveInteractionInput,
  ): Promise<SessionResolveInteractionResult>;
  setPermissionMode(
    call: CapabilityCallContext,
    input: SessionSetPermissionModeInput,
  ): Promise<SessionSetPermissionModeResult>;
}

const RESOLVE = "sessions.resolveInteraction";
const SET_MODE = "sessions.setPermissionMode";

/** 应答的选择（只记种类，不记内容）：permission 记选项 kind 或 fullAccess；userInput 记 action。 */
function choiceOf(
  interaction: PendingInteraction,
  answer: SessionResolveInteractionInput["answer"],
): string | undefined {
  if (interaction.payload.kind === "permission") {
    if (answer.optionId === PERMISSION_FULL_ACCESS_OPTION_ID) return "fullAccess";
    return interaction.payload.options.find((option) => option.optionId === answer.optionId)?.kind;
  }
  if (interaction.payload.kind === "userInput") {
    if (answer.action === "decline") return "decline";
    if (answer.action === "cancel") return "cancel";
    return "answer";
  }
  return undefined;
}

export function createSessionControls(deps: SessionControlsDeps): SessionControls {
  const assertScope = async (pluginId: string, session: AppSessionRef) => {
    const projectId = session.project?.projectId;
    const allowed = await deps.pluginProjects.projectIds(pluginId);
    if (!projectId || !allowed.has(projectId))
      throw new ExtensionError(
        "forbidden",
        "approvals and permission modes are only available for sessions in the plugin's project",
      );
  };

  const assertFullAccess = (pluginId: string) => {
    const state = deps.fullAccess(pluginId);
    if (state === "not-declared")
      throw new ExtensionError(
        "not-declared",
        "full access needs sessions.fullAccess; declare it in extension.grants",
      );
    if (state === "not-granted")
      throw new ExtensionError("not-granted", "sessions.fullAccess is not granted");
  };

  const agentOf = () => {
    if (!deps.agent) throw new ExtensionError("unavailable", "session control is unavailable");
    return deps.agent;
  };

  /** CLI 拒绝命令：只把回执状态与 reasonCode 记进日志，扩展收到 unavailable。 */
  const rejected = (capability: string, ack: CommandAck) => {
    deps.logger.warn(
      undefined,
      `${capability} rejected status=${ack.status} reason=${ack.reasonCode ?? "none"}`,
    );
    return new ExtensionError("unavailable", `${capability} was not accepted by the session`);
  };

  const readCurrent = (call: CapabilityCallContext, sessionId: string) =>
    deps.reads.readInteractions(call, sessionId);

  return {
    assertScope,
    assertFullAccess,
    async resolveInteraction(call, input) {
      const details: SessionAuditDetails = {};
      return deps.sessions.run(
        call,
        RESOLVE,
        async () => {
          const { target, event }: SessionInteractionsRead = await readCurrent(
            call,
            input.sessionId,
          );
          const interaction = event.interactions.find(
            (entry) => entry.interactionId === input.interactionId,
          );
          if (!interaction) {
            // 已被宿主或别的客户端回答、已撤销或会话已结束：不发命令（§17.12「先到先得」）。
            deps.logger.info(
              undefined,
              `${RESOLVE} stale plugin=${call.pluginId} session=${input.sessionId}`,
            );
            return { status: "stale" as const };
          }
          details.interactionKind = interaction.kind as "permission" | "userInput";
          if (interaction.payload.kind === "permission") {
            const optionId = input.answer.optionId;
            const known =
              optionId !== undefined &&
              (interaction.payload.options.some((option) => option.optionId === optionId) ||
                interaction.payload.fullAccessOption?.optionId === optionId);
            if (!known)
              throw new ExtensionError(
                "invalid-input",
                "answer.optionId must be one of the interaction's options",
              );
            if (optionId === PERMISSION_FULL_ACCESS_OPTION_ID) assertFullAccess(call.pluginId);
          }
          details.choice = choiceOf(interaction, input.answer);
          const ack = await agentOf().sendConversationCommandV4(
            withTrustedZCodeAgentV4Connection(
              {
                workspacePath: target.workspacePath,
                ...(target.workspaceIdentity
                  ? { workspaceIdentity: target.workspaceIdentity }
                  : {}),
                envelope: createHostCommandEnvelope({
                  type: "resolveInteraction",
                  payload: { interactionId: input.interactionId, answer: input.answer },
                  sessionId: target.sessionId,
                  // 同一个 requestId 重试是同一个命令（CLI 幂等表按 commandId）。
                  commandId: `extension-${createHash("sha256")
                    .update(JSON.stringify([call.pluginId, input.requestId]))
                    .digest("hex")}`,
                  clientId: `extension:${call.pluginId}`,
                }),
              },
              {
                connectionId: `extension-host:${call.gen}:${call.pluginId}`,
                clientMode: "web-remote-replayable",
              },
            ),
          );
          try {
            assertV4CommandAckOk("resolveInteraction", ack, RESOLVE);
          } catch {
            throw rejected(RESOLVE, ack);
          }
          deps.logger.info(
            undefined,
            `${RESOLVE} accepted plugin=${call.pluginId} session=${input.sessionId} kind=${interaction.kind} choice=${details.choice ?? "none"}`,
          );
          return { status: "accepted" as const };
        },
        input,
        details,
      );
    },
    async setPermissionMode(call, input) {
      const details: SessionAuditDetails = { mode: input.mode };
      return deps.sessions.run(
        call,
        SET_MODE,
        async () => {
          if (input.mode === EXTENSION_FULL_ACCESS_MODE) assertFullAccess(call.pluginId);
          const { target, event } = await readCurrent(call, input.sessionId);
          if (event.mode === input.mode) return { status: "unchanged" as const };
          const agent = agentOf();
          try {
            // switchCollaborationMode 是 CAS 命令：与宿主相同，用 stale 回执里的最新 revision 收敛。
            await sendHostCasCommandV4({
              send: (envelope) =>
                agent.sendConversationCommandV4(
                  withTrustedZCodeAgentV4Connection(
                    {
                      workspacePath: target.workspacePath,
                      ...(target.workspaceIdentity
                        ? { workspaceIdentity: target.workspaceIdentity }
                        : {}),
                      envelope,
                    },
                    {
                      connectionId: `extension-host:${call.gen}:${call.pluginId}`,
                      clientMode: "web-remote-replayable",
                    },
                  ),
                ),
              type: "switchCollaborationMode",
              payload: { mode: input.mode },
              sessionId: target.sessionId,
              contextMessage: SET_MODE,
              clientId: `extension:${call.pluginId}`,
            });
          } catch (error) {
            // CLI 拒绝（回执带 ack）：只记状态与 reasonCode；其他失败由会话后端按类型映射。
            const ack = (error as { ack?: CommandAck } | null)?.ack;
            if (ack) throw rejected(SET_MODE, ack);
            throw error;
          }
          deps.logger.info(
            undefined,
            `${SET_MODE} accepted plugin=${call.pluginId} session=${input.sessionId} mode=${input.mode}`,
          );
          return { status: "accepted" as const };
        },
        input,
        details,
      );
    },
  };
}
