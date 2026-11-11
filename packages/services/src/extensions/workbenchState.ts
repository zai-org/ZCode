import { Emitter, type Event } from "@zcode/rpc";
import {
  toWorkbenchSessions,
  workspaceScopeKey,
  type WorkbenchReport,
  type WorkbenchReportSession,
  type WorkbenchSession,
  type WorkspaceRef,
} from "@zcode/shared/extension-host";

// 屏幕上的会话（docs/plugins/extension-host.md §3.4、§3.5 ③）：唯一 owner 是 Renderer。
// Window Host 只持最近一份报告，按报告整份替换，不维护第二份会话状态。

export interface WorkbenchState {
  /** Renderer 报告：整份替换。 */
  report(next: WorkbenchReport): void;
  /** 扩展可见的会话（不含草稿的所选模型）。 */
  sessions(): WorkbenchSession[];
  /** 报告里的一项（含草稿的所选模型），只给 Window Host 自己用。 */
  find(sessionId: string): WorkbenchReportSession | undefined;
  /** 报告里出现的工作区（去重），数据泵按它订阅 CLI 通知。 */
  workspaces(): WorkspaceRef[];
  /** 扩展可见的会话列表变化时触发（草稿换模型不算）。 */
  readonly onDidChangeSessions: Event<WorkbenchSession[]>;
  /** 每次报告都触发，给数据泵用（草稿换模型、工作区增减）。 */
  readonly onDidChangeReport: Event<WorkbenchReport>;
  dispose(): void;
}

export function createWorkbenchState(): WorkbenchState {
  let current: WorkbenchReport = { sessions: [] };
  let publicKey = "[]";
  const sessionsChanged = new Emitter<WorkbenchSession[]>();
  const reportChanged = new Emitter<WorkbenchReport>();
  return {
    report(next) {
      current = next;
      reportChanged.fire(next);
      const sessions = toWorkbenchSessions(next);
      const key = JSON.stringify(sessions);
      if (key === publicKey) return;
      publicKey = key;
      sessionsChanged.fire(sessions);
    },
    sessions: () => toWorkbenchSessions(current),
    find: (sessionId) => current.sessions.find((session) => session.sessionId === sessionId),
    workspaces() {
      const byKey = new Map<string, WorkspaceRef>();
      for (const session of current.sessions) {
        byKey.set(workspaceScopeKey(session.workspace), session.workspace);
      }
      return [...byKey.values()];
    },
    onDidChangeSessions: sessionsChanged.event,
    onDidChangeReport: reportChanged.event,
    dispose() {
      sessionsChanged.dispose();
      reportChanged.dispose();
    },
  };
}

/**
 * 按工作区订阅 CLI 通知：订阅报告里出现过的工作区；订阅本身不启动 CLI（agent 服务按工作区键分发事件）。
 *
 * 只增不减，直到数据泵停止（没有扩展订阅）才全部退订。原因：离开屏幕的工作区仍可能有在途请求
 * （例如切到别的工作区时上一条主轮请求还在流式输出），按报告退订会漏掉它的通知与生成速率。
 * 草稿首发交接期间报告曾短暂为空，那是 Renderer 侧的缺陷，已在预热协调器修复（§16.11）。
 */
export function createWorkspaceSubscriptions<T>(
  subscribe: (workspace: WorkspaceRef) => Event<T> | undefined,
  onEvent: (workspace: WorkspaceRef, event: T) => void,
  onSubscribed?: (workspaceKey: string) => void,
): { sync(workspaces: readonly WorkspaceRef[]): void; disposeAll(): void; size(): number } {
  const active = new Map<string, { dispose(): void }>();
  return {
    sync(workspaces) {
      for (const workspace of workspaces) {
        const key = workspaceScopeKey(workspace);
        if (active.has(key)) continue;
        const event = subscribe(workspace);
        if (!event) continue;
        active.set(
          key,
          event((payload) => onEvent(workspace, payload)),
        );
        onSubscribed?.(key);
      }
    },
    disposeAll() {
      for (const subscription of active.values()) subscription.dispose();
      active.clear();
    },
    size: () => active.size,
  };
}
