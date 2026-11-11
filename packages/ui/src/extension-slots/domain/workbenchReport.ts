import {
  WORKBENCH_REPORT_MAX_SESSIONS,
  type WorkbenchReport,
  type WorkbenchReportSession,
} from "@zcode/shared/extension-host";
import type { WorkbenchPaneReport } from "@/extension-slots/contract.js";

// 纯函数：把各窗格的报告合成一份屏幕会话报告（docs/plugins/extension-host.md §3.4）。

/** 同一会话出现在多个窗格时只报一次；任一窗格有焦点即为 focused。还没有有效会话的窗格不报告。 */
export function buildWorkbenchReport(panes: Iterable<WorkbenchPaneReport>): WorkbenchReport {
  const bySession = new Map<string, WorkbenchReportSession>();
  for (const pane of panes) {
    if (!pane.sessionId) continue;
    const existing = bySession.get(pane.sessionId);
    if (existing) {
      existing.focused ||= pane.focused;
      continue;
    }
    bySession.set(pane.sessionId, {
      sessionId: pane.sessionId,
      workspace: {
        workspacePath: pane.workspacePath,
        ...(pane.workspaceIdentity ? { workspaceIdentity: pane.workspaceIdentity } : {}),
      },
      isDraft: pane.isDraft,
      focused: pane.focused,
      ...(pane.isDraft && pane.draftModel ? { draftModel: pane.draftModel } : {}),
    });
  }
  // 顺序稳定：报告内容没变时序列化结果也不变，接收方据此去重。
  const sessions = [...bySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { sessions: sessions.slice(0, WORKBENCH_REPORT_MAX_SESSIONS) };
}
