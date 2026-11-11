import { z } from "zod";
import { appClientSessionModeSchema } from "@zcode/session-control/contracts";
import { commandPayloadSchemas } from "#src/zcode-protocol-v4/command.js";
import { pendingInteractionSchema } from "#src/zcode-protocol-v4/snapshot.js";

// 插件回答审批、提问与切换权限模式（docs/plugins/extension-host.md §17.12，P3e）。
// 只对插件项目里的会话开放；只投影工具审批（permission）与 AskUserQuestion（userInput）两种交互，
// 工作区 Hook 信任审查与插件安装确认不给插件看、也不能由插件回答。
// 交互与权限模式的唯一事实源是 CLI 的会话快照（pendingInteractions、config.mode）。

const sessionIdSchema = z.string().min(1).max(200);
const requestIdSchema = z.string().min(1).max(200);

/** 插件能看到、能回答的交互种类。 */
export const EXTENSION_ANSWERABLE_INTERACTION_KINDS = ["permission", "userInput"] as const;
export type ExtensionAnswerableInteractionKind =
  (typeof EXTENSION_ANSWERABLE_INTERACTION_KINDS)[number];

export function isExtensionAnswerableInteraction(kind: string): boolean {
  return (EXTENSION_ANSWERABLE_INTERACTION_KINDS as readonly string[]).includes(kind);
}

/** 插件可以切换到的权限模式：宿主权限菜单的三档（edit 是旧草稿回显值，plan 是单独开关，都不开放）。 */
export const extensionPermissionModeSchema = appClientSessionModeSchema;
export type ExtensionPermissionMode = z.infer<typeof extensionPermissionModeSchema>;

/** 完全访问（yolo）：要清单声明并授权 sessions.fullAccess。 */
export const EXTENSION_FULL_ACCESS_MODE = "yolo" as const;

/**
 * 会话的待处理交互与当前权限模式。interactions 是 v4 pendingInteraction 原样（只留两种），跟 protocols.rows 走；
 * mode 是快照 config.mode 的原值（可能是 edit 等插件不能切换到的旧值）。
 */
export const sessionInteractionsEventSchema = z.strictObject({
  sessionId: sessionIdSchema,
  logEpoch: z.string(),
  revision: z.number(),
  mode: z.string(),
  interactions: z.array(pendingInteractionSchema),
});
export type SessionInteractionsEvent = z.infer<typeof sessionInteractionsEventSchema>;

/** answer 与 v4 resolveInteraction 的 answer 同一份定义，原样转给 CLI。 */
export const sessionResolveInteractionInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  interactionId: z.string().min(1).max(200),
  answer: commandPayloadSchemas.resolveInteraction.shape.answer,
  requestId: requestIdSchema,
});
export type SessionResolveInteractionInput = z.infer<typeof sessionResolveInteractionInputSchema>;

/**
 * accepted：命令已交给 CLI。宿主或别的客户端可能先一步回答了同一个交互（CLI 对晚到的应答幂等收下），
 * 所以 accepted 不表示「是这次应答生效的」；以订阅里交互消失时的会话状态为准。
 * stale：发命令前交互已不在当前快照里（已被回答、撤销或会话已结束），没有发命令。
 */
export const sessionResolveInteractionResultSchema = z.strictObject({
  status: z.enum(["accepted", "stale"]),
});
export type SessionResolveInteractionResult = z.infer<typeof sessionResolveInteractionResultSchema>;

export const sessionSetPermissionModeInputSchema = z.strictObject({
  sessionId: sessionIdSchema,
  mode: extensionPermissionModeSchema,
  requestId: requestIdSchema,
});
export type SessionSetPermissionModeInput = z.infer<typeof sessionSetPermissionModeInputSchema>;

/** unchanged：当前模式已经是目标值，没有发命令。新模式经 onDidChangeInteractions 到达。 */
export const sessionSetPermissionModeResultSchema = z.strictObject({
  status: z.enum(["accepted", "unchanged"]),
});
export type SessionSetPermissionModeResult = z.infer<typeof sessionSetPermissionModeResultSchema>;
