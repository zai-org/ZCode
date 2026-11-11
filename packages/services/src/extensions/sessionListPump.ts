import type { AppSessionRef } from "@zcode/session-control/contracts";
import {
  ExtensionError,
  SESSION_LIST_MAX_ROWS,
  type SessionListEvent,
  type SessionListRow,
} from "@zcode/shared/extension-host";
import type { WindowHostControllerTaskRow } from "@zcode/shared/zcode-protocol-v4";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { CapabilitySubscription } from "#src/extensions/capabilityTypes.js";

// 会话列表泵（docs/plugins/extension-host.md §17.5，P3b）：读 Window Host 控制器的任务投影，与桌面侧栏、
// 手机同一份。有列表订阅者时才订阅投影，最后一个退订时退订。
//
//   控制器投影 ──onChange──► 映射成列表行 v1 ──► 与上一份按行比较 ──► delta（rev 加一）
//   新订阅者 ──► 当前整份 snapshot（rev 不变）
//
// 投影的每次回调都按映射后的行比较：流式期间只有活动时间在变，映射后的行不变，不推增量。

/** Window Host 宿主注入的控制器投影（只在本进程内，不在任何 RPC 频道上）。 */
export interface ExtensionTaskRowsSource {
  read(): readonly WindowHostControllerTaskRow[];
  /** 投影行任一变化即回调；订阅时会立即回调一次。 */
  subscribe(onChange: () => void): { dispose(): void };
}

export interface SessionListPumpDeps {
  taskRows: ExtensionTaskRowsSource | undefined;
  localSourceServerId(): string | undefined;
  logger: Pick<ServiceLogger, "debug" | "info">;
}

export interface SessionListPump {
  subscribe(pluginId: string): CapabilitySubscription<SessionListEvent>;
  dispose(): void;
}

interface Entry {
  row: SessionListRow;
  json: string;
}

interface Running {
  subscription: { dispose(): void };
  entries: Map<string, Entry>;
  truncated: boolean;
}

const refKey = (ref: AppSessionRef) =>
  `${ref.sourceServerId ?? ""}\0${ref.workspaceIdentity?.trim() || ref.workspacePath}\0${ref.sessionId}`;

/** 控制器的 liveStatus → session-control 摘要的 status。 */
function statusOf(liveStatus: WindowHostControllerTaskRow["liveStatus"]): SessionListRow["status"] {
  if (liveStatus === "running") return "running";
  if (liveStatus === "waiting") return "needs_attention";
  return "idle";
}

/** 列表行 v1。投影没有项目归属，所以引用不带 project（写操作接受不带项目的引用）。 */
function toRow(task: WindowHostControllerTaskRow, localSourceServerId: string): SessionListRow {
  const { address, meta, membership } = task;
  return {
    session: {
      kind: "app",
      sourceServerId: address.sourceServerId ?? localSourceServerId,
      workspacePath: address.workspacePath,
      ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
      sessionId: address.taskId,
    },
    title: meta.title,
    status: statusOf(task.liveStatus),
    ...(meta.updatedAt ? { updatedAt: new Date(meta.updatedAt).toISOString() } : {}),
    archived: membership.archived,
    pinned: membership.pinned,
    sourceAvailability: task.sourceAvailability,
  };
}

export function createSessionListPump(deps: SessionListPumpDeps): SessionListPump {
  const listeners = new Set<(event: SessionListEvent) => void>();
  let running: Running | null = null;
  let rev = 0;

  /** 映射、按 updatedAt 降序取前 SESSION_LIST_MAX_ROWS 行（相同时按引用排序，结果稳定）。 */
  const project = (source: ExtensionTaskRowsSource, local: string) => {
    const rows = source.read().map((task) => {
      const row = toRow(task, local);
      return { key: refKey(row.session), row, updatedAt: task.meta.updatedAt ?? 0 };
    });
    rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const visible = rows.slice(0, SESSION_LIST_MAX_ROWS);
    return {
      entries: new Map(visible.map(({ key, row }) => [key, { row, json: JSON.stringify(row) }])),
      truncated: rows.length > visible.length,
    };
  };

  const snapshotEvent = (state: Running): SessionListEvent => ({
    kind: "snapshot",
    rev,
    sessions: [...state.entries.values()].map((entry) => entry.row),
    ...(state.truncated ? { truncated: true as const } : {}),
  });

  const refresh = (source: ExtensionTaskRowsSource, local: string) => {
    const state = running;
    if (!state) return;
    const next = project(source, local);
    const upserted: SessionListRow[] = [];
    for (const [key, entry] of next.entries) {
      if (state.entries.get(key)?.json !== entry.json) upserted.push(entry.row);
    }
    const removed = [...state.entries]
      .filter(([key]) => !next.entries.has(key))
      .map(([, entry]) => entry.row.session);
    state.entries = next.entries;
    state.truncated = next.truncated;
    if (upserted.length === 0 && removed.length === 0) return;
    rev += 1;
    const event: SessionListEvent = { kind: "delta", rev, upserted, removed };
    // 与会话变化同频：只记 debug。
    deps.logger.debug(
      undefined,
      `session list delta rev=${rev} upserted=${upserted.length} removed=${removed.length}`,
    );
    for (const listener of listeners) listener(event);
  };

  const start = (source: ExtensionTaskRowsSource, local: string): Running => {
    if (running) return running;
    const initial = project(source, local);
    const state: Running = { subscription: { dispose() {} }, ...initial };
    running = state;
    // 订阅时投影会立即回调一次：内容与 initial 相同，不产生增量。
    state.subscription = source.subscribe(() => refresh(source, local));
    deps.logger.info(undefined, `session list pump started rows=${state.entries.size}`);
    return state;
  };

  const stop = () => {
    const state = running;
    if (!state) return;
    running = null;
    state.subscription.dispose();
    deps.logger.info(undefined, "session list pump stopped");
  };

  return {
    subscribe: (pluginId) => (listener, fail) => {
      const source = deps.taskRows;
      const local = deps.localSourceServerId();
      if (!source || !local) {
        fail(new ExtensionError("unavailable", "the session list is unavailable"));
        return { dispose() {} };
      }
      const state = start(source, local);
      listeners.add(listener);
      deps.logger.debug(undefined, `session list subscriber added plugin=${pluginId}`);
      listener(snapshotEvent(state));
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        },
      };
    },
    dispose() {
      listeners.clear();
      stop();
    },
  };
}
