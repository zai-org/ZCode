import type {
  CapabilityId,
  ExtensionCapabilityInput,
  ExtensionCapabilityOutput,
  ExtensionCapabilityTable,
} from "#src/extension-host/capabilities.js";

// ctx.sessions 上 call 动作的入参与返回（docs/plugins/extension-host.md §17.9，类型包 /sessions 入口）。
// 由能力表推导，与 ctx 成员同一份类型；新增会话动作时这里不用改。
// 会话引用直接用 session-control 的类型：读出来的引用原样传给写动作（§17.6）。
export type {
  AppProjectRef,
  AppSessionRef,
  AppWorkspaceRef,
} from "@zcode/session-control/contracts";

type SessionCallId = {
  [K in CapabilityId]: K extends `sessions.${string}`
    ? ExtensionCapabilityTable[K]["kind"] extends "call"
      ? K
      : never
    : never;
}[CapabilityId];

/** `ctx.sessions` 上的 call 动作名：12 个 facade 动作与 `readRows`。 */
export type SessionAction = SessionCallId extends `sessions.${infer A}` ? A : never;

/** 例：`SessionActionInput<"createSession">`。带请求身份的动作 `requestId` 可选，扩展进程补。 */
export type SessionActionInput<A extends SessionAction> = ExtensionCapabilityInput<
  Extract<SessionCallId, `sessions.${A}`>
>;
export type SessionActionResult<A extends SessionAction> = ExtensionCapabilityOutput<
  Extract<SessionCallId, `sessions.${A}`>
>;
