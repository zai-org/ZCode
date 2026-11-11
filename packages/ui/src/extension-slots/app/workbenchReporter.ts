import type { IExtensionsService } from "@zcode/services";
import { logger } from "@/logger.js";
import { buildWorkbenchReport } from "@/extension-slots/domain/workbenchReport.js";
import type { WorkbenchPaneReport } from "@/extension-slots/contract.js";

// 屏幕会话报告（③ Renderer 报告）：每个对话窗格登记自己的一项，变化时合成整份报告发给 Window Host。
// 同一轮事件循环里的多次变化（React effect 先清理后登记）用 queueMicrotask 合并成一次；内容没变不发。
// 由事件驱动，不轮询。

export interface WorkbenchReporter {
  /** 登记或更新一个窗格；返回注销函数。 */
  set(key: string, entry: WorkbenchPaneReport): () => void;
}

const reporters = new WeakMap<IExtensionsService, WorkbenchReporter>();

export function getWorkbenchReporter(service: IExtensionsService): WorkbenchReporter {
  const existing = reporters.get(service);
  if (existing) return existing;
  const panes = new Map<string, WorkbenchPaneReport>();
  let scheduled = false;
  let lastSent = "";
  const flush = () => {
    scheduled = false;
    const report = buildWorkbenchReport(panes.values());
    const serialized = JSON.stringify(report);
    if (serialized === lastSent) return;
    lastSent = serialized;
    // 窗格、焦点与草稿模型变化才到这里，频率低。
    logger.lifecycle.info("[extension-slots] workbench report", {
      sessions: report.sessions.length,
      drafts: report.sessions.filter((session) => session.isDraft).length,
    });
    void service.reportWorkbench(report).catch((error: unknown) => {
      logger.lifecycle.warn("[extension-slots] workbench report failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  const reporter: WorkbenchReporter = {
    set(key, entry) {
      panes.set(key, entry);
      schedule();
      return () => {
        if (panes.get(key) !== entry) return;
        panes.delete(key);
        schedule();
      };
    },
  };
  reporters.set(service, reporter);
  return reporter;
}
