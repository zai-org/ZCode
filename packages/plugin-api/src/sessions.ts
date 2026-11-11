// @zcode-dev/plugin-api/sessions（docs/plugins/extension-host.md §17.9）：会话投影 v1、会话动作的入参与返回、读事件。
export type {
  // 会话动作：SessionActionInput<"createSession"> 等
  SessionAction,
  SessionActionInput,
  SessionActionResult,
  // 会话引用（读出来原样传给写动作）
  AppProjectRef,
  AppSessionRef,
  AppWorkspaceRef,
  // 读连接（§17.5）
  SessionConversationEvent,
  SessionListEvent,
  SessionListRow,
  SessionReadRowsInput,
  SessionReadRowsResult,
  SessionRow,
  SessionRowsEvent,
  SessionTargetInput,
  // 回答审批、提问与切换权限模式（§17.12）
  ExtensionAnswerableInteractionKind,
  ExtensionPermissionMode,
  SessionInteractionsEvent,
  SessionResolveInteractionInput,
  SessionResolveInteractionResult,
  SessionSetPermissionModeInput,
  SessionSetPermissionModeResult,
} from "@zcode/shared/extension-host";
