import { z } from "zod";
import {
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  appReadSessionInputSchema,
  appCreateSessionInputSchema,
  appForkSessionInputSchema,
  appSendToSessionInputSchema,
  appWaitSessionsInputSchema,
  appInterruptSessionInputSchema,
  appRenameSessionInputSchema,
  appOpenSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  listProjectsResultSchema,
  appListSessionsResultSchema,
  readSessionResultSchema,
  createSessionResultSchema,
  forkSessionResultSchema,
  sendToSessionResultSchema,
  waitSessionsResultSchema,
  mutationResultSchema,
  openSessionResultSchema,
  sessionControlErrorCodeSchema,
} from "@zcode/session-control/contracts";

const bindingFields = {
  // 由 CLI tool runtime 注入；Host 仍需用活跃连接及根会话事实核对。
  callerSessionId: z.string().trim().min(1).max(4096),
  callId: z.string().trim().min(1).max(4096),
};
const failure = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({ code: sessionControlErrorCodeSchema, message: z.string() }),
});
function method<K extends string, I extends z.ZodType, O extends z.ZodType>(
  name: K,
  input: I,
  result: O,
) {
  return {
    method: `appControl/${name}` as const,
    params: z.strictObject({
      ...bindingFields,
      turnId: z.string().trim().min(1).max(4096).optional(),
      input,
    }),
    result: z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), result }), failure]),
  };
}

/** 封闭的十二个意图；不接受任意 service/method 名称。 */
export const appControlProtocol = {
  listProjects: method("listProjects", appListProjectsInputSchema, listProjectsResultSchema),
  listSessions: method("listSessions", appListSessionsInputSchema, appListSessionsResultSchema),
  readSession: method("readSession", appReadSessionInputSchema, readSessionResultSchema),
  createSession: method("createSession", appCreateSessionInputSchema, createSessionResultSchema),
  forkSession: method("forkSession", appForkSessionInputSchema, forkSessionResultSchema),
  sendToSession: method("sendToSession", appSendToSessionInputSchema, sendToSessionResultSchema),
  waitSessions: method("waitSessions", appWaitSessionsInputSchema, waitSessionsResultSchema),
  interruptSession: method(
    "interruptSession",
    appInterruptSessionInputSchema,
    mutationResultSchema,
  ),
  renameSession: method("renameSession", appRenameSessionInputSchema, mutationResultSchema),
  openSession: method("openSession", appOpenSessionInputSchema, openSessionResultSchema),
  setSessionArchived: method(
    "setSessionArchived",
    appSetSessionArchivedInputSchema,
    mutationResultSchema,
  ),
  setSessionPinned: method(
    "setSessionPinned",
    appSetSessionPinnedInputSchema,
    mutationResultSchema,
  ),
} as const;
export type AppControlAction = keyof typeof appControlProtocol;
export const appControlCancelMethod = "appControl/cancel" as const;
export const appControlCancelParamsSchema = z.strictObject(bindingFields);
export const appControlCancelResultSchema = z.strictObject({ cancelled: z.boolean() });
export type AppControlRpcParams<A extends AppControlAction> = z.infer<
  (typeof appControlProtocol)[A]["params"]
>;
export type AppControlRpcResult<A extends AppControlAction> = z.infer<
  (typeof appControlProtocol)[A]["result"]
>;
