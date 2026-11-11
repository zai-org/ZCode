import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import {
  ExtensionError,
  NOTIFICATION_DAILY_LIMIT,
  NOTIFICATION_MIN_INTERVAL_MS,
  extensionGlobalId,
  findStaticView,
  type ExtensionGrantState,
  type ExtensionStaticTable,
  type NotificationsShowInput,
  type NotificationsShowResult,
} from "@zcode/shared/extension-host";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ExtensionNotificationAck,
  ExtensionNotificationRequest,
} from "#src/extensions/views/contract.js";

// 能力 notifications.show 在 Window Host 的一段（docs/plugins/extension-host.md §18.1 H8）：
//   网关已查 notifications 档位 → 详情页开关（muted）→ 限额（rate-limited）→ 请 Renderer（设置页开关、preload、
//   Main 的焦点与平台判断）→ 回执里 shown 为真才计入限额。
// 同一插件的调用串行：两次同时到达时不会都通过「60 秒 1 条」。限额只在内存里，Window Host 重启清零。
// 没有窗口在听时 host-unavailable；最后一个监听退订时在途请求一起失败，不用超时。日志不记标题与正文。

export interface NotificationRelay {
  readonly onRequests: Event<ExtensionNotificationRequest>;
  show(pluginId: string, input: NotificationsShowInput): Promise<NotificationsShowResult>;
  ack(ack: ExtensionNotificationAck): void;
  dispose(): void;
}

/** 本机日期（与审计文件同一口径）：限额按本机日期的同一天计。 */
function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function createNotificationRelay(deps: {
  staticTable(): ExtensionStaticTable;
  grantState(pluginId: string): ExtensionGrantState | undefined;
  logger: Pick<ServiceLogger, "info">;
  now?: () => number;
}): NotificationRelay {
  const now = deps.now ?? Date.now;
  const pending = new Map<
    string,
    { resolve(result: NotificationsShowResult): void; reject(error: Error): void; pluginId: string }
  >();
  /** 每插件真正弹出的时间（最近一天以内）。 */
  const shownAt = new Map<string, number[]>();
  /** 每插件的串行链。 */
  const chains = new Map<string, Promise<unknown>>();
  const requests = new Emitter<ExtensionNotificationRequest>({
    onDidRemoveLastListener: () => {
      for (const entry of pending.values()) {
        entry.reject(new ExtensionError("host-unavailable", "no window is listening"));
      }
      pending.clear();
    },
  });
  let listeners = 0;
  const countedRequests: Event<ExtensionNotificationRequest> = (listener) => {
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

  const limited = (pluginId: string): boolean => {
    const current = now();
    const today = localDay(current);
    const times = (shownAt.get(pluginId) ?? []).filter((time) => localDay(time) === today);
    shownAt.set(pluginId, times);
    const last = times.at(-1);
    return (
      (last !== undefined && current - last < NOTIFICATION_MIN_INTERVAL_MS) ||
      times.length >= NOTIFICATION_DAILY_LIMIT
    );
  };

  const run = async (
    pluginId: string,
    input: NotificationsShowInput,
  ): Promise<NotificationsShowResult> => {
    const table = deps.staticTable();
    const plugin = table.plugins.find((candidate) => candidate.pluginId === pluginId);
    const viewId = input.target ? extensionGlobalId(pluginId, input.target.view) : undefined;
    if (viewId && findStaticView(table, viewId)?.pluginId !== pluginId) {
      throw new ExtensionError("not-declared", `view is not declared: ${input.target!.view}`);
    }
    const finish = (result: NotificationsShowResult) => {
      deps.logger.info(
        undefined,
        `notifications.show plugin=${pluginId} shown=${result.shown}${result.reason ? ` reason=${result.reason}` : ""}`,
      );
      return result;
    };
    if (deps.grantState(pluginId)?.notificationsEnabled === false) {
      return finish({ shown: false, reason: "muted" });
    }
    if (limited(pluginId)) return finish({ shown: false, reason: "rate-limited" });
    if (listeners === 0) throw new ExtensionError("host-unavailable", "no window is listening");
    const requestId = randomUUID();
    const result = await new Promise<NotificationsShowResult>((resolve, reject) => {
      pending.set(requestId, { resolve, reject, pluginId });
      requests.fire({
        requestId,
        pluginId,
        pluginName: plugin?.name ?? pluginId,
        title: input.title,
        body: input.body,
        ...(viewId ? { viewId } : {}),
      });
    });
    if (result.shown) shownAt.set(pluginId, [...(shownAt.get(pluginId) ?? []), now()]);
    return finish(result);
  };

  return {
    onRequests: countedRequests,
    show(pluginId, input) {
      const previous = chains.get(pluginId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => run(pluginId, input));
      chains.set(pluginId, next);
      void next
        .finally(() => {
          if (chains.get(pluginId) === next) chains.delete(pluginId);
        })
        .catch(() => undefined);
      return next;
    },
    ack(ack) {
      const entry = pending.get(ack.requestId);
      if (!entry) return;
      pending.delete(ack.requestId);
      entry.resolve(ack.result);
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
