import {
  BackgroundSubagentStallClock,
  backgroundSubagentStallDescription,
  formatBackgroundSubagentStallNotification,
  type BackgroundSubagentStallReminder,
} from "../../subagent/background-stall.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 父 runtime 的后台 Agent 停滞钟（构造函数里调一次）。钟只从 registry 派生在跑的后台 Agent，
 * 每次 registry 变化后对齐定时器；提醒走与终态通知相同的后台通知队列：父会话空闲时开一轮，
 * 正忙时在回合内插入。
 */
export function createSubagentStallReminder(
  runtime: AgentRuntimeInternal,
): BackgroundSubagentStallClock {
  const options = runtime.config.subagents;
  const clock = new BackgroundSubagentStallClock(
    {
      now: () => Date.now(),
      liveAgents: () => liveBackgroundAgents(runtime),
      remind: (reminder) => enqueueStallReminder(runtime, reminder),
      setTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return () => clearTimeout(handle);
      },
    },
    {
      ...(options?.backgroundStallNotifyMs === undefined
        ? {}
        : { firstAfterMs: options.backgroundStallNotifyMs }),
      ...(options?.backgroundStallMaxIntervalMs === undefined
        ? {}
        : { maxIntervalMs: options.backgroundStallMaxIntervalMs }),
    },
  );
  runtime.runtimeTaskRegistry.subscribe?.(() => {
    if (runtime.shuttingDown) {
      clock.dispose();
      return;
    }
    clock.reconcile();
  });
  return clock;
}

function liveBackgroundAgents(runtime: AgentRuntimeInternal): RuntimeTaskSnapshot[] {
  return Object.values(runtime.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.type === "local_agent" &&
      task.status === "running" &&
      task.isBackgrounded === true &&
      (task.parentSessionId === undefined || task.parentSessionId === runtime.sessionId) &&
      // 被 rewind 掉的分支上的任务，通知会被入口的分支围栏丢掉，不提醒。
      (task.branchGeneration ?? runtime.branchGeneration) === runtime.branchGeneration,
  );
}

function enqueueStallReminder(
  runtime: AgentRuntimeInternal,
  reminder: BackgroundSubagentStallReminder,
): void {
  runtime.logger?.info?.("Background subagent stall reminder sent", {
    agentId: reminder.agentId,
    event: "subagent.background.stall_reminder_sent",
    module: "core.runtime",
    noProgressForMs: reminder.noProgressForMs,
    nextReportInMs: reminder.nextReportInMs,
    ordinal: reminder.ordinal,
    runningTools: reminder.runningTools.map((tool) => tool.toolName),
  });
  runtime.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "subagent",
      // 标题由 CLI 给出、App 原样显示为后台结果轮的标题；不带 subagentResult，不改变 Agent 卡片状态。
      title: `${backgroundSubagentStallDescription(reminder.description)} — no progress for ${Math.max(1, Math.round(reminder.noProgressForMs / 60_000))} min`,
      workId: reminder.agentId,
      subagentStall: {
        noProgressForMs: Math.floor(reminder.noProgressForMs),
        lastProgressAt: reminder.lastProgressAt,
        ...(reminder.executionId ? { executionId: reminder.executionId } : {}),
      },
    },
    // taskId 让提醒继承该 Agent 的 branchGeneration（迟到通知的 fencing）。
    taskId: reminder.agentId,
    text: formatBackgroundSubagentStallNotification(reminder),
    traceContext: runtime.rootTraceContext,
  });
}
