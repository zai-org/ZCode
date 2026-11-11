import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import { ExtensionError, type WorkbenchStartDraftInput } from "@zcode/shared/extension-host";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { ExtensionDraftAck, ExtensionDraftRequest } from "#src/extensions/views/contract.js";

// 能力 workbench.startDraft 在 Window Host 的一段（docs/plugins/extension-host.md §18.1 H2，③ 请 Renderer）：
// 照 views.open 的请求与回执。经 IExtensionViewsService 的事件请 Renderer 开一个预填文字的新草稿，等回执。
// 回执只表示窗口已接手（与插件市场「试用」同一条新建任务路径），不等草稿准备完；准备失败由 Renderer 提示用户。
// 没有窗口在听时直接 host-unavailable；最后一个监听退订（窗口关闭或重载）时在途请求一起失败，不靠超时。
// 日志不记文字，只记插件 id、长度与是否指定工作区。

export interface ExtensionDraftRelay {
  readonly onRequests: Event<ExtensionDraftRequest>;
  requestStart(pluginId: string, input: WorkbenchStartDraftInput): Promise<undefined>;
  ack(ack: ExtensionDraftAck): void;
  dispose(): void;
}

export function createExtensionDraftRelay(deps: {
  logger: Pick<ServiceLogger, "info">;
}): ExtensionDraftRelay {
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; pluginId: string }
  >();
  const requests = new Emitter<ExtensionDraftRequest>({
    onDidRemoveLastListener: () => {
      for (const entry of pending.values()) {
        entry.reject(new ExtensionError("host-unavailable", "no window is listening"));
      }
      pending.clear();
    },
  });
  let listeners = 0;
  const countedRequests: Event<ExtensionDraftRequest> = (listener) => {
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
    requestStart(pluginId, input) {
      if (listeners === 0) {
        return Promise.reject(new ExtensionError("host-unavailable", "no window is listening"));
      }
      const requestId = randomUUID();
      deps.logger.info(
        undefined,
        `workbench.startDraft requested plugin=${pluginId} chars=${input.text.length} workspace=${input.workspace ? "explicit" : "current"}`,
      );
      return new Promise<undefined>((resolve, reject) => {
        pending.set(requestId, { resolve: () => resolve(undefined), reject, pluginId });
        requests.fire({
          requestId,
          pluginId,
          text: input.text,
          ...(input.workspace ? { workspace: input.workspace } : {}),
        });
      });
    },
    ack(ack) {
      const entry = pending.get(ack.requestId);
      if (!entry) return;
      pending.delete(ack.requestId);
      deps.logger.info(
        undefined,
        `workbench.startDraft acked plugin=${entry.pluginId} ok=${ack.ok}`,
      );
      if (ack.ok) entry.resolve();
      else
        entry.reject(
          new ExtensionError("internal", ack.error ?? "the window could not start a draft"),
        );
    },
    dispose() {
      for (const entry of pending.values()) {
        entry.reject(new ExtensionError("host-unavailable", "extensions service disposed"));
      }
      pending.clear();
      requests.dispose();
    },
  };
}
