import {
  SessionControlError,
  type AppSessionControl,
  type AppSessionTrustedContext,
  type AppTrustedContext,
} from "@zcode/session-control/contracts";
import {
  appControlCancelMethod,
  appControlCancelResultSchema,
  appControlProtocol,
} from "@zcode/shared";
import type { AppControlAction } from "@zcode/shared";
import type { ZCodeProtocolTrace } from "@zcode/shared";
import type { AppSessionControlBinding, AppSessionControlBindingOptions } from "./contract.js";
export type { AppSessionControlBinding, AppSessionControlBindingOptions } from "./contract.js";

const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
const CONTROL_WAIT_TIMEOUT_MS = 310_000;

export function createAppSessionControlBinding(
  options: AppSessionControlBindingOptions,
): AppSessionControlBinding {
  const rootSession = {
    kind: "app" as const,
    workspacePath: options.workspacePath,
    sessionId: options.sessionId,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.sourceServerId ? { sourceServerId: options.sourceServerId } : {}),
  };
  const context = (): AppSessionTrustedContext => ({
    callerId: options.sessionId,
    rootSession,
    allowedScopes: [{ ...rootSession, scope: "workspace" }],
  });
  async function call<A extends AppControlAction>(
    action: A,
    trusted: AppTrustedContext,
    input: unknown,
  ) {
    if (
      // 这里只转发模型工具（会话类调用方）；客户端类调用方只由 App Host 构造，不会经过 CLI。
      trusted.caller === "client" ||
      trusted.rootSession.sessionId !== options.sessionId ||
      trusted.rootSession.workspacePath !== options.workspacePath ||
      trusted.rootSession.workspaceIdentity !== options.workspaceIdentity ||
      trusted.rootSession.sourceServerId !== options.sourceServerId ||
      !trusted.toolCallId
    ) {
      throw new SessionControlError(
        "forbidden",
        "App session control requires the bound root session and tool call.",
      );
    }
    trusted.signal?.throwIfAborted();
    const endpoint = appControlProtocol[action];
    const params = endpoint.params.parse({
      callerSessionId: options.sessionId,
      callId: trusted.toolCallId,
      ...(trusted.turnId ? { turnId: trusted.turnId } : {}),
      input,
    });
    const trace: ZCodeProtocolTrace | undefined = trusted.traceId
      ? { traceId: trusted.traceId }
      : undefined;
    const cancel = () => {
      // 工具取消只能释放该调用的观察，不发 interrupt，更不能把目标任务当作未接纳重试。
      void options
        .requestClient(
          appControlCancelMethod,
          { callerSessionId: options.sessionId, callId: trusted.toolCallId },
          appControlCancelResultSchema,
          { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS, trace },
        )
        .catch(() => undefined);
    };
    trusted.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = endpoint.result.parse(
        await options.requestClient<unknown>(endpoint.method, params, endpoint.result, {
          signal: trusted.signal,
          trace,
          timeoutMs:
            action === "waitSessions" ? CONTROL_WAIT_TIMEOUT_MS : CONTROL_REQUEST_TIMEOUT_MS,
        }),
      );
      if (!result.ok) throw new SessionControlError(result.error.code, result.error.message);
      return result.result;
    } finally {
      trusted.signal?.removeEventListener("abort", cancel);
    }
  }
  // 有限方法映射与 shared endpoint 一一对应；只做传输，不在 CLI 重跑 App 用例或创建 runtime。
  const control: AppSessionControl = {
    listProjects: (ctx, input) =>
      call("listProjects", ctx, input) as ReturnType<AppSessionControl["listProjects"]>,
    listSessions: (ctx, input) =>
      call("listSessions", ctx, input) as ReturnType<AppSessionControl["listSessions"]>,
    readSession: (ctx, input) =>
      call("readSession", ctx, input) as ReturnType<AppSessionControl["readSession"]>,
    createSession: (ctx, input) =>
      call("createSession", ctx, input) as ReturnType<AppSessionControl["createSession"]>,
    forkSession: (ctx, input) =>
      call("forkSession", ctx, input) as ReturnType<AppSessionControl["forkSession"]>,
    sendToSession: (ctx, input) =>
      call("sendToSession", ctx, input) as ReturnType<AppSessionControl["sendToSession"]>,
    waitSessions: (ctx, input) =>
      call("waitSessions", ctx, input) as ReturnType<AppSessionControl["waitSessions"]>,
    interruptSession: (ctx, input) =>
      call("interruptSession", ctx, input) as ReturnType<AppSessionControl["interruptSession"]>,
    renameSession: (ctx, input) =>
      call("renameSession", ctx, input) as ReturnType<AppSessionControl["renameSession"]>,
    openSession: (ctx, input) =>
      call("openSession", ctx, input) as ReturnType<AppSessionControl["openSession"]>,
    setSessionArchived: (ctx, input) =>
      call("setSessionArchived", ctx, input) as ReturnType<AppSessionControl["setSessionArchived"]>,
    setSessionPinned: (ctx, input) =>
      call("setSessionPinned", ctx, input) as ReturnType<AppSessionControl["setSessionPinned"]>,
  };
  return { kind: "app", control, context };
}
