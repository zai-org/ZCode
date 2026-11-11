import {
  appControlProtocol,
  appControlCancelMethod,
  appControlCancelParamsSchema,
  type AppControlAction,
  type ZCodeProtocolRequest,
} from "@zcode/shared";
import { SessionControlError } from "@zcode/session-control/contracts";
import type { AppControlBinding, AppControlService } from "#src/app-control/contract.js";

interface ReverseClient {
  respond(id: ZCodeProtocolRequest["id"], result: unknown): Promise<void>;
  respondError(
    id: ZCodeProtocolRequest["id"],
    error: { code: number; message: string },
  ): Promise<void>;
}

async function dispatch(
  service: AppControlService,
  action: AppControlAction,
  value: unknown,
  binding: AppControlBinding,
) {
  const context = await service.bind(binding);
  // 每个分支解析自己的封闭输入类型；没有 method 字符串下标执行任意服务的入口。
  switch (action) {
    case "listProjects":
      return service.control.listProjects(
        context,
        appControlProtocol.listProjects.params.parse(value).input,
      );
    case "listSessions":
      return service.control.listSessions(
        context,
        appControlProtocol.listSessions.params.parse(value).input,
      );
    case "readSession":
      return service.control.readSession(
        context,
        appControlProtocol.readSession.params.parse(value).input,
      );
    case "createSession":
      return service.control.createSession(
        context,
        appControlProtocol.createSession.params.parse(value).input,
      );
    case "forkSession":
      return service.control.forkSession(
        context,
        appControlProtocol.forkSession.params.parse(value).input,
      );
    case "sendToSession":
      return service.control.sendToSession(
        context,
        appControlProtocol.sendToSession.params.parse(value).input,
      );
    case "waitSessions":
      return service.control.waitSessions(
        context,
        appControlProtocol.waitSessions.params.parse(value).input,
      );
    case "interruptSession":
      return service.control.interruptSession(
        context,
        appControlProtocol.interruptSession.params.parse(value).input,
      );
    case "renameSession":
      return service.control.renameSession(
        context,
        appControlProtocol.renameSession.params.parse(value).input,
      );
    case "openSession":
      return service.control.openSession(
        context,
        appControlProtocol.openSession.params.parse(value).input,
      );
    case "setSessionArchived":
      return service.control.setSessionArchived(
        context,
        appControlProtocol.setSessionArchived.params.parse(value).input,
      );
    case "setSessionPinned":
      return service.control.setSessionPinned(
        context,
        appControlProtocol.setSessionPinned.params.parse(value).input,
      );
  }
}

export function createAppControlReverseRpc(options: {
  client: ReverseClient;
  service: () => AppControlService | undefined;
  bind: (request: {
    callerSessionId: string;
    callId: string;
    turnId?: string;
    trace?: ZCodeProtocolRequest["trace"];
    signal: AbortSignal;
  }) => Promise<AppControlBinding>;
  onResponseError: (error: unknown) => void;
}) {
  const pending = new Map<string, { controller: AbortController; binding?: AppControlBinding }>();
  let disposed = false;
  return {
    handle(request: ZCodeProtocolRequest): boolean {
      if (request.method === appControlCancelMethod) {
        const parsed = appControlCancelParamsSchema.safeParse(request.params);
        if (!parsed.success) {
          void options.client
            .respondError(request.id, { code: -32602, message: "Invalid appControl cancellation" })
            .catch(options.onResponseError);
          return true;
        }
        const key = JSON.stringify([parsed.data.callerSessionId, parsed.data.callId]);
        const call = pending.get(key);
        // 取消只命中同一实际 CLI 连接中的在途调用；已绑定的调用还要复检连接代际。
        try {
          call?.binding?.assertCurrent();
          call?.controller.abort();
          void options.client
            .respond(request.id, { cancelled: Boolean(call) })
            .catch(options.onResponseError);
        } catch (error) {
          options.onResponseError(error);
          void options.client
            .respond(request.id, { cancelled: false })
            .catch(options.onResponseError);
        }
        return true;
      }
      const action = (Object.keys(appControlProtocol) as AppControlAction[]).find(
        (key) => appControlProtocol[key].method === request.method,
      );
      if (!action) return false;
      const entry = appControlProtocol[action];
      const parsed = entry.params.safeParse(request.params);
      if (!parsed.success) {
        void options.client
          .respondError(request.id, { code: -32602, message: "Invalid appControl parameters" })
          .catch(options.onResponseError);
        return true;
      }
      const key = JSON.stringify([parsed.data.callerSessionId, parsed.data.callId]);
      void (async () => {
        if (disposed) throw new SessionControlError("unavailable", "App connection closed");
        if (pending.has(key))
          throw new SessionControlError("conflict", "Tool call is already in flight");
        const service = options.service();
        if (!service)
          throw new SessionControlError("unavailable", "App control is unavailable on this Host");
        const controller = new AbortController();
        const call: { controller: AbortController; binding?: AppControlBinding } = { controller };
        pending.set(key, call);
        try {
          const binding = await options.bind({
            callerSessionId: parsed.data.callerSessionId,
            callId: parsed.data.callId,
            turnId: parsed.data.turnId,
            trace: request.trace,
            signal: controller.signal,
          });
          call.binding = binding;
          binding.assertCurrent();
          if (controller.signal.aborted)
            throw new SessionControlError("cancelled", "App control call cancelled");
          const result = await dispatch(service, action, parsed.data, binding);
          await options.client.respond(request.id, entry.result.parse({ ok: true, result }));
        } finally {
          if (pending.get(key) === call) pending.delete(key);
        }
      })()
        .catch(async (error: unknown) => {
          options.onResponseError(error);
          // 协议响应只回稳定文案与错误码：底层异常文本可能带本地路径、远端地址或 provider
          // 内部细节，而这条响应会进模型上下文。可预期的失败由各端口显式抛 SessionControlError
          // 表达（例如会话未恢复 → unavailable），原始异常只进 onResponseError 的结构化日志。
          await options.client.respond(request.id, {
            ok: false,
            error: {
              code: error instanceof SessionControlError ? error.code : "unavailable",
              message: error instanceof SessionControlError ? error.message : "App control failed",
            },
          });
        })
        .catch(options.onResponseError);
      return true;
    },
    dispose() {
      disposed = true;
      for (const call of pending.values()) call.controller.abort();
      pending.clear();
    },
  };
}
