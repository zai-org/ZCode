import { z } from "zod";

// 命令与会话身份不能静默 trim，否则两个不同请求会被合并到同一个幂等键。
export const identifierSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.trim() === value && !value.includes("\0"),
    "Identifier must be canonical",
  );
export const requestIdSchema = identifierSchema;
export const workspacePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value) && !value.includes("\0"),
    "Expected an absolute workspace path",
  );
export const cliScopeSchema = z.strictObject({
  kind: z.literal("cli"),
  workspacePath: workspacePathSchema,
  workspaceIdentity: identifierSchema.optional(),
});
export const appProjectRefSchema = z.strictObject({
  kind: z.literal("app"),
  projectId: identifierSchema,
  sourceServerId: identifierSchema.optional(),
});
export const appWorkspaceRefSchema = z.strictObject({
  kind: z.literal("app"),
  workspacePath: workspacePathSchema,
  workspaceIdentity: identifierSchema.optional(),
  sourceServerId: identifierSchema.optional(),
});
export const appScopeSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    kind: z.literal("app"),
    scope: z.literal("host"),
    sourceServerId: identifierSchema.optional(),
  }),
  appProjectRefSchema.extend({ scope: z.literal("project") }),
  appWorkspaceRefSchema.extend({ scope: z.literal("workspace") }),
]);
export const cliSessionRefSchema = cliScopeSchema.extend({ sessionId: identifierSchema });
export const appSessionRefSchema = appWorkspaceRefSchema.extend({
  sessionId: identifierSchema,
  project: appProjectRefSchema.optional(),
});
export const sessionRefSchema = z.discriminatedUnion("kind", [
  cliSessionRefSchema,
  appSessionRefSchema,
]);
export type CliScope = z.infer<typeof cliScopeSchema>;
export type AppProjectRef = z.infer<typeof appProjectRefSchema>;
export type AppWorkspaceRef = z.infer<typeof appWorkspaceRefSchema>;
export type AppScope = z.infer<typeof appScopeSchema>;
export type CliSessionRef = z.infer<typeof cliSessionRefSchema>;
export type AppSessionRef = z.infer<typeof appSessionRefSchema>;
export type SessionRef = CliSessionRef | AppSessionRef;
export type Scope = CliScope | AppScope;

// 模型可只传会话 ID；可信一侧解析为完整引用后，才进入原有授权与 owner 校验。
// 会话 ID 有两种历史格式，都必须接受：当前的 `sess_<UUID v4>`，以及 3.16 Host 持久化的
// `session_<32hex>` / `session_<UUID>`。读取必须按原身份精确查找，不能改写前缀后查另一个会话
// （docs/session-context-tool.md「Session identity compatibility」）。
// 校验格式的目的不只是挡住错值：模型曾传入 "dummy" 这类占位值，无格式约束时一路走到授权才被拒，
// 错误信息只说越权，看不出是 ID 本身不对。
const SESSION_ID_PATTERN = /^(?:sess|session)_[A-Za-z0-9._-]+$/;
export const sessionIdSchema = identifierSchema.regex(
  SESSION_ID_PATTERN,
  "Session id must look like sess_… or the legacy session_… form",
);
const targetMessage = "Provide exactly one of session or sessionId";

/**
 * 重试同一请求时回放的请求身份（规格 0.14）。
 *
 * 幂等保护的价值只在重试时体现，代价却压在每一次调用上：原先 `requestId` 必填，正常路径模型必须
 * 凭空造一个 id——重复用会撞 conflict，重试时换新的会重复建会话、重复发消息。现在请求身份由工具层
 * 从执行上下文注入并在回执里返回，模型只在对账时把那个值原样放进 `retryOf`。
 */
export const retryOfSchema = identifierSchema.describe(
  "Only when retrying a request whose result was inconclusive: pass the requestId from that call's result. Leave it out otherwise, and never invent one.",
);

/**
 * 把端口字段集翻译成工具面字段集：去掉 `requestId`，换成可选的 `retryOf`。
 *
 * 端口与用例层的 `requestId` 不变（它仍是幂等键），变的只是「谁提供它」。
 */
function toolShape<T extends z.ZodRawShape>(shape: T) {
  if (!("requestId" in shape)) return shape;
  const { requestId: _requestId, ...rest } = shape as T & { requestId: unknown };
  return { ...rest, retryOf: retryOfSchema.optional() };
}

/**
 * 不指向已有会话、但需要幂等身份的写操作（当前只有 `CreateSession`）的两份 schema。
 * 与 withSessionTarget 同一套规则：端口收 `requestId`，工具面只给 `retryOf`。
 * `portOnly` 只进端口、不进工具面（同 withSessionTarget）：扩展新建会话时的权限模式
 * （docs/plugins/extension-host.md §17.12），模型看到的工具 schema 不变。
 */
export function withRequestIdentity<
  T extends z.ZodRawShape,
  P extends z.ZodRawShape = Record<never, never>,
>(shape: T, portOnly?: P) {
  const port = z.strictObject({ ...shape, ...(portOnly as P) });
  const tool = z.strictObject(toolShape(shape));
  return Object.assign(port, { tool });
}
/**
 * 目标会话字段的两份 schema，共用同一组业务字段定义：
 * - `port`：端口与用例层用，`session` 与 `sessionId` 二选一（完整引用仍是内部路由与展示的载体）。
 * - `tool`：工具层暴露给模型的，只有必填 `sessionId`。
 *
 * 规格 0.11：模型把两个字段都当必填，用 "dummy" 之类占位值补齐 `session`，一整轮调用全部失败。
 * 它无法可靠构造这个嵌套引用，所以不再让它看见；strictObject 会直接拒绝多传的 `session`，不静默忽略。
 *
 * `portOnly` 只进端口、不进工具面：给可信的非会话客户端用的字段（docs/plugins/extension-host.md §18.1 H10，
 * 扩展的 sendToSession 可带 model），模型看到的工具 schema 不变。
 */
export function withSessionTarget<
  R extends z.ZodType,
  T extends z.ZodRawShape,
  P extends z.ZodRawShape = Record<never, never>,
>(ref: R, shape: T, portOnly?: P) {
  const port = z
    .strictObject({
      session: ref.optional(),
      sessionId: sessionIdSchema.optional(),
      ...shape,
      ...(portOnly as P),
    })
    .refine(
      (value) => {
        const target = value as { session?: unknown; sessionId?: unknown };
        return (target.session === undefined) !== (target.sessionId === undefined);
      },
      { message: targetMessage },
    );
  const tool = z.strictObject({
    sessionId: sessionIdSchema.describe(
      "The target session id, for example sess_1a2b3c4d-… . Older sessions use session_… . Take it from a tool result or the user, never invent one.",
    ),
    ...toolShape(shape),
  });
  return Object.assign(port, { tool });
}

/** 解析后传给端口的输入：只含完整引用，不再带 sessionId。 */
export type ResolvedTarget<T, R> = Omit<T, "session" | "sessionId"> & { session: R };

export const actionSchema = z.enum([
  "listSessions",
  "readSession",
  "createSession",
  "forkSession",
  "sendToSession",
  "waitSessions",
  "interruptSession",
  "renameSession",
  "listProjects",
  "openSession",
  "setSessionArchived",
  "setSessionPinned",
]);
export type SessionControlAction = z.infer<typeof actionSchema>;

// 可信身份只能由启动装配或实际 RPC 连接构造，不能从工具 JSON 反序列化。
interface TrustedContextBase<S extends Scope> {
  callerId: string;
  allowedScopes: readonly S[];
  signal?: AbortSignal;
  uiTarget?: string;
  traceId?: string;
  turnId?: string;
  toolCallId?: string;
}
/**
 * 会话类调用方：模型的会话控制工具。根会话是调用者自己的会话，self_wait 按它检查。
 * `caller` 缺省即会话类：CLI 与既有构造方不写这个字段，行为不变（docs/plugins/extension-host.md §17.2）。
 */
export interface SessionCallerContext<
  R extends SessionRef,
  S extends Scope,
> extends TrustedContextBase<S> {
  caller?: "session";
  rootSession: R;
}
/**
 * 客户端类调用方：可信的非会话客户端（扩展经 Host 的 bindClient 构造）。它没有根会话，所以没有
 * self_wait；授权范围仍只来自可信装配。只存在于 App 上下文。
 */
export interface ClientCallerContext<S extends Scope> extends TrustedContextBase<S> {
  caller: "client";
  rootSession?: never;
}
/**
 * 客户端类只出现在 App 范围：S 里没有 App 范围时（CLI）为 never，CLI 端口收到的上下文类型仍只有会话类。
 * 用 Extract + 元组包裹，避免按 AppScope 的每个成员拆成多个客户端类型。
 */
type ClientCallerFor<S extends Scope> = [Extract<S, AppScope>] extends [never]
  ? never
  : ClientCallerContext<Extract<S, AppScope>>;
export type TrustedContext<R extends SessionRef = SessionRef, S extends Scope = Scope> =
  | SessionCallerContext<R, S>
  | ClientCallerFor<S>;
/** CLI 只有会话类调用方（模型工具），上下文形状不变。 */
export type CliTrustedContext = SessionCallerContext<CliSessionRef, CliScope> & {
  /**
   * 启动装配注入的只读范围：在场时 list/read 可访问本机 CLI 会话库中的任意会话。
   * 不能复用为 create/fork/send/interrupt/rename 的授权；写操作仍只看 allowedScopes。
   */
  readAnyLocalSession?: boolean;
};
interface AppContextFields {
  // Host 注入的只读发现范围；不能复用为正文、执行、组织或导航操作权限。
  discoveryScopes?: readonly AppScope[];
}
export type AppSessionTrustedContext = SessionCallerContext<AppSessionRef, AppScope> &
  AppContextFields;
export type AppClientTrustedContext = ClientCallerContext<AppScope> & AppContextFields;
export type AppTrustedContext = AppSessionTrustedContext | AppClientTrustedContext;

// fence 是 owner 可校验的授权/代际凭据。最终提交必须再次原子校验，不把预检当成许可证。
export interface AccessGrant<S extends Scope = Scope> {
  scope: S;
  fence: string;
}
export interface AccessRequest<R extends SessionRef, S extends Scope> {
  action: SessionControlAction;
  scope: S;
  session?: R;
}
export interface AccessPort<R extends SessionRef, S extends Scope> {
  authorize(context: TrustedContext<R, S>, request: AccessRequest<R, S>): Promise<AccessGrant<S>>;
}
export interface Deadline {
  expired: Promise<void>;
  close(): void;
}
export interface DeadlinePort {
  create(timeoutMs: number): Deadline;
}

export const sessionControlErrorCodeSchema = z.enum([
  "invalid_input",
  "invalid_output",
  "forbidden",
  "self_wait",
  "unavailable",
  "conflict",
  "cancelled",
  "observation_invalid",
]);
export type SessionControlErrorCode = z.infer<typeof sessionControlErrorCodeSchema>;
export class SessionControlError extends Error {
  readonly code: SessionControlErrorCode;
  constructor(code: SessionControlErrorCode, message: string) {
    super(message);
    this.name = "SessionControlError";
    this.code = code;
  }
}

export const paginationShape = {
  cursor: identifierSchema
    .optional()
    .describe(
      "The nextCursor from the previous page of this same call. Omit it for the first page.",
    ),
  limit: z.number().int().min(1).max(200).optional(),
};
export const queryShape = { query: z.string().max(4096).optional(), ...paginationShape };
export const promptSchema = z
  .string()
  .min(1)
  .max(1_000_000)
  .refine((value) => value.trim().length > 0, "Prompt must not be blank");
export const titleSchema = z.string().trim().min(1).max(1024);
export const modelSchema = identifierSchema.describe(
  "A model id from ListModels, either `modelId` or `providerId/modelId`. It must match exactly one configured model. Omit it to use the configured default.",
);
/** fork 的稳定边界（规格 0.14）：来源是 ReadSession(view=messages) 的 messages[].id，名字不同。 */
export const atMessageSchema = identifierSchema.describe(
  "A message id from ReadSession with view=messages — the `id` of the entry to fork at. Never invent one.",
);

/**
 * 中断的目标执行（规格 0.14）：来源是 ListSessions / WaitSessions 回执里的 executionId，名字不同。
 * 源字段是可选的——会话 idle 时不返回，那说明没有可中断的执行，不该去猜一个值。
 */
export const executionIdSchema = identifierSchema.describe(
  "The executionId reported by ListSessions or WaitSessions for this session. If neither reports one the session is not executing, so there is nothing to interrupt.",
);

export const messageSchema = z.strictObject({
  id: identifierSchema,
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
});
export const mutationResultSchema = z.strictObject({
  status: z.enum(["applied", "rejected", "unknown"]),
  // 规格 0.14：重试要用的身份必须由回执给出，不能让模型编。
  requestId: identifierSchema.describe(
    "This request's identity. Pass it as `retryOf` only if you must retry this exact request.",
  ),
  reason: z.string().optional(),
});
export type MutationResult = z.infer<typeof mutationResultSchema>;
export const openSessionResultSchema = z.strictObject({
  status: z.enum(["opened", "unavailable"]),
  uiTarget: identifierSchema.optional(),
  reason: z.string().optional(),
});
export type OpenSessionResult = z.infer<typeof openSessionResultSchema>;
