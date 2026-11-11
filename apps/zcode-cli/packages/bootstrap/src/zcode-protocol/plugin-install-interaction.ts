import {
  createSessionEvent,
  SessionEventType,
  type PluginDiscoveryCandidate,
  type PluginDiscoveryContext,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import {
  boundPluginLocalizedText,
  pluginInstallRequestPayloadSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 先登记再发布；卡片动作只认 install，未知/迟到应答绝不能批准。 */
export async function confirmPluginInstall(
  server: ZCodeProtocolAgentServerContext,
  plugin: PluginDiscoveryCandidate,
  reason: string,
  context: PluginDiscoveryContext,
): Promise<boolean> {
  context.signal.throwIfAborted();
  if (!context.emitEvent) throw new Error("plugin_install_interaction_unavailable");
  const interactionId = `plugin-install:${context.sessionId}:${context.toolCallId}`;
  const request = pluginInstallRequestPayloadSchema.parse({
    kind: "pluginInstall",
    pluginId: plugin.pluginId,
    name: plugin.name,
    displayName: plugin.displayName,
    displayNameI18n: boundPluginLocalizedText(plugin.displayNameI18n),
    description: plugin.description,
    descriptionI18n: boundPluginLocalizedText(plugin.descriptionI18n),
    icon: plugin.icon,
    reason,
    action: plugin.action,
    scope: plugin.scope,
    toolCallId: context.toolCallId,
  });
  let answer!: (accepted: boolean) => void;
  let rejectAnswer!: (error: unknown) => void;
  const response = new Promise<boolean>((resolve, reject) => {
    answer = resolve;
    rejectAnswer = reject;
  });
  // 发布失败/取消可能先于 await response；提前挂拒绝处理，避免未处理 Promise rejection。
  void response.catch(() => undefined);
  const unregister = server.v4Interactions.register(
    interactionId,
    (value) =>
      answer(
        value.optionId === "install" && value.action !== "decline" && value.action !== "cancel",
      ),
    { sessionId: context.sessionId, kind: "pluginInstall" },
  );
  const abort = () =>
    rejectAnswer(context.signal.reason ?? new Error("Plugin installation cancelled"));
  context.signal.addEventListener("abort", abort, { once: true });
  let decision: "install" | "skip" | "cancel" = "cancel";
  const emit = (
    type:
      | typeof SessionEventType.PluginInstallRequested
      | typeof SessionEventType.PluginInstallResolved,
    payload: unknown,
  ) =>
    context.emitEvent!(
      createSessionEvent(type, context.sessionId as SessionId, payload, {
        turnId: context.turnId as TurnId | undefined,
        traceId: context.traceId as TraceId,
      }),
    );
  try {
    await emit(SessionEventType.PluginInstallRequested, { interactionId, request });
    context.signal.throwIfAborted();
    const accepted = await response;
    decision = accepted ? "install" : "skip";
    return accepted;
  } finally {
    unregister();
    context.signal.removeEventListener("abort", abort);
    await emit(SessionEventType.PluginInstallResolved, {
      interactionId,
      pluginId: plugin.pluginId,
      toolCallId: context.toolCallId,
      decision,
      turnId: context.turnId,
    });
  }
}
