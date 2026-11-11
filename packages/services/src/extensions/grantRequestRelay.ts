import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import {
  ExtensionError,
  type ExtensionGrant,
  type ExtensionGrantState,
} from "@zcode/shared/extension-host";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ExtensionGrantRequest,
  ExtensionGrantRequestAck,
} from "#src/extensions/grants/contract.js";

// 能力 grants.request 在 Window Host 的一段（docs/plugins/extension-host.md §18.1 H12，③ 请 Renderer）：
// 照 workbench.startDraft 的请求与回执。需要授权时经 IExtensionGrantsService 的事件请 Renderer 弹授权对话框，
// 等回执；回执在用户确认或取消、授予调用结束之后才到，所以这时读到的授权状态已含这次结果。
// 同一插件已有在途的请求时合并成一次，不叠对话框。没有窗口在听时直接 host-unavailable；最后一个监听
// 退订时在途请求一起失败，不靠超时。授予仍只走 IExtensionGrantsService.grant（用户在对话框里确认）。

export interface GrantRequestRelay {
  readonly onRequests: Event<ExtensionGrantRequest>;
  request(pluginId: string): Promise<{ granted: ExtensionGrant[] }>;
  ack(ack: ExtensionGrantRequestAck): void;
  dispose(): void;
}

export function createGrantRequestRelay(deps: {
  /** 授权状态的 owner（grants.json ⊕ 静态表）；插件既没声明也没记录时为 undefined。 */
  state(pluginId: string): ExtensionGrantState | undefined;
  logger: Pick<ServiceLogger, "info">;
}): GrantRequestRelay {
  /** 按插件合并：同一插件同一时刻只有一个在途的对话框请求。 */
  const pending = new Map<
    string,
    {
      requestId: string;
      promise: Promise<{ granted: ExtensionGrant[] }>;
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  const current = (pluginId: string) => ({ granted: [...(deps.state(pluginId)?.granted ?? [])] });
  const failAll = (message: string) => {
    for (const entry of pending.values()) {
      entry.reject(new ExtensionError("host-unavailable", message));
    }
    pending.clear();
  };
  const requests = new Emitter<ExtensionGrantRequest>({
    onDidRemoveLastListener: () => failAll("no window is listening"),
  });
  let listeners = 0;
  const countedRequests: Event<ExtensionGrantRequest> = (listener) => {
    listeners += 1;
    const subscription = requests.event(listener);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners -= 1;
        subscription.dispose();
      },
    };
  };

  return {
    onRequests: countedRequests,
    request(pluginId) {
      const state = deps.state(pluginId);
      // 没有声明档位、已经授予或插件不在静态表里（inactive）：没有可问的，直接返回当前生效的档位。
      if (!state || state.declared.length === 0 || state.status !== "needs-consent") {
        deps.logger.info(
          undefined,
          `grants.request plugin=${pluginId} dialog=no status=${state?.status ?? "none"}`,
        );
        return Promise.resolve(current(pluginId));
      }
      const existing = pending.get(pluginId);
      if (existing) return existing.promise;
      if (listeners === 0) {
        return Promise.reject(new ExtensionError("host-unavailable", "no window is listening"));
      }
      const requestId = randomUUID();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      }).then(() => current(pluginId));
      pending.set(pluginId, { requestId, promise, resolve, reject });
      deps.logger.info(undefined, `grants.request plugin=${pluginId} dialog=yes`);
      requests.fire({ requestId, pluginId });
      return promise;
    },
    ack(ack) {
      for (const [pluginId, entry] of pending) {
        if (entry.requestId !== ack.requestId) continue;
        pending.delete(pluginId);
        deps.logger.info(
          undefined,
          `grants.request acked plugin=${pluginId} ok=${ack.ok} granted=${current(pluginId).granted.join(",") || "none"}`,
        );
        // 回执失败（窗口没能弹出对话框）按宿主不可用处理；用户取消不是失败。
        if (ack.ok) entry.resolve();
        else
          entry.reject(
            new ExtensionError("host-unavailable", ack.error ?? "the window could not ask"),
          );
        return;
      }
    },
    dispose() {
      failAll("extensions service disposed");
      requests.dispose();
    },
  };
}
