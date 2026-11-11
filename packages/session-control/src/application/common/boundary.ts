import { z } from "zod";
import {
  SessionControlError,
  type AccessGrant,
  type AccessPort,
  type AppTrustedContext,
  type CliTrustedContext,
  type Scope,
  type SessionControlAction,
  type SessionRef,
  type TrustedContext,
} from "#session-control/contract/common";
import { assertScope, sameScope } from "#session-control/domain/reference-scope";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SessionControlError("invalid_input", result.error.message);
  return result.data;
}
export function parseOutput<T>(schema: z.ZodType<T>, output: unknown): T {
  const result = schema.safeParse(output);
  if (!result.success) throw new SessionControlError("invalid_output", result.error.message);
  return result.data;
}
/**
 * 把工具层的二选一目标解析为完整引用。只给 sessionId 时由可信端口在本 Host 或本机会话库查找；
 * 解析结果与模型直接传完整引用等价，随后仍走原有授权与 owner 校验，不新增权限路径。
 */
/**
 * 记下哪些引用是调用方自己给的完整引用（而不是由 sessionId 解析出来的）。
 * 规格 0.10：模型只有裸 ID 时常自造引用，猜错字段后被授权拒绝却不知道下一步；
 * 据此在拒绝消息后追加固定引导。用 WeakSet 不改签名也不污染业务数据，引用回收后自动清理。
 */
const callerProvidedRefs = new WeakSet<object>();
const SESSION_ID_HINT =
  "If you only have the session id, pass it as sessionId instead of building a session reference.";

/** 目标被拒时，只有调用方自造引用才追加引导；不看目标是否存在，因此不泄露它在别处是否可见。 */
export function targetRejection(session: SessionRef | undefined, message: string): string {
  return session && callerProvidedRefs.has(session) ? `${message} ${SESSION_ID_HINT}` : message;
}

export async function resolveTarget<
  R extends SessionRef,
  T extends { session?: R; sessionId?: string },
>(
  ctx: { signal?: AbortSignal },
  input: T,
  resolve: (sessionId: string) => Promise<R | undefined>,
): Promise<Omit<T, "session" | "sessionId"> & { session: R }> {
  const { session, sessionId, ...rest } = input;
  if (session) {
    callerProvidedRefs.add(session);
    return { ...rest, session };
  }
  assertActive(ctx);
  const resolved = await resolve(sessionId!);
  assertActive(ctx);
  // 与完整引用在本范围内不存在时一致：不暴露目标是否存在于其他来源。
  if (!resolved) throw new SessionControlError("forbidden", "Target is outside the trusted scope");
  if (resolved.sessionId !== sessionId)
    throw new SessionControlError("invalid_output", "Owner resolved a different session");
  return { ...rest, session: resolved };
}
export function assertActive(ctx: { signal?: AbortSignal }): void {
  if (ctx.signal?.aborted)
    throw new SessionControlError("cancelled", "Call cancelled before owner admission");
}
export async function authorize<R extends SessionRef, S extends Scope>(
  access: AccessPort<R, S>,
  ctx: TrustedContext<R, S>,
  action: SessionControlAction,
  scope: S,
  session?: R,
): Promise<AccessGrant<S>> {
  assertActive(ctx);
  // 调用方所在的 facade 由判别字段决定：客户端类只存在于 App 上下文，它没有根会话；
  // 会话类看根会话的 kind（docs/plugins/extension-host.md §17.2）。
  const surface = ctx.caller === "client" ? "app" : ctx.rootSession.kind;
  // 列表发现曾误用操作权限而漏掉其他项目。仅此两种意图选择 discovery，owner 仍接收原 ctx。
  const discoveryScopes =
    surface === "app" && (action === "listProjects" || action === "listSessions")
      ? (ctx as AppTrustedContext).discoveryScopes
      : undefined;
  // 独立 CLI 的读不要求 owner：装配声明可读本机会话库时，list/read 跳过 workspace 收窄。
  // 写操作不进入此分支，仍由 allowedScopes 与 owner 校验。
  const readsLocalStore =
    surface === "cli" &&
    (action === "listSessions" || action === "readSession") &&
    (ctx as CliTrustedContext).readAnyLocalSession === true &&
    scope.kind === "cli";
  if (!readsLocalStore) {
    try {
      assertScope(
        discoveryScopes ? { ...ctx, allowedScopes: discoveryScopes } : ctx,
        scope,
        session,
      );
    } catch (error) {
      // 自造引用被拒时补一句怎么改；错误码与原文案不变，仍不透露目标在别处是否存在。
      if (error instanceof SessionControlError && error.code === "forbidden")
        throw new SessionControlError("forbidden", targetRejection(session, error.message));
      throw error;
    }
  }
  const grant = await access.authorize(ctx, { action, scope, ...(session ? { session } : {}) });
  assertActive(ctx);
  if (
    !grant ||
    typeof grant.fence !== "string" ||
    !grant.fence ||
    !grant.scope ||
    !sameScope(grant.scope, scope)
  )
    throw new SessionControlError("forbidden", "Access grant does not match the target scope");
  return grant;
}
