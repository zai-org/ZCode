/**
 * 后台 subagent 长时间无进展的发现与报告（apps/zcode-cli/docs/design/v2/tool/07-subagent.md
 * 「后台 Agent 无进展提醒」）。
 *
 * 运行时只负责「发现并报告」，停掉还是继续等由主代理决定：没有一刀切的超时。
 * - 进展 = 新的模型请求或回复、工具调用开始或结束。Bash 每秒的 ToolCallProgress 心跳不算：
 *   卡死的命令也会一直发心跳；流式 token 也不单独算（模型流自己有 idle timeout）。
 * - 活动只记在 RuntimeTaskRegistry 的任务快照上（唯一 owner），TaskOutput 读同一份。
 * - 钟只持有每个 Agent 的提醒次数，其余全部从快照派生；首个提醒在无进展 firstAfterMs 后，
 *   之后每次间隔加倍（上限 maxIntervalMs）。模型不停止它就是「继续等」；有新进展后计数清零。
 */
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { escapeXml, truncateTaskNotification } from "../runtime-task/notification.js";
import type {
  RuntimeTaskRegistry,
  RuntimeTaskSnapshot,
  SubagentActivitySnapshot,
  SubagentRunningToolActivity,
} from "../runtime-task/registry.js";

export type { SubagentActivitySnapshot, SubagentRunningToolActivity };

export const DEFAULT_BACKGROUND_SUBAGENT_STALL_FIRST_MS = 15 * 60_000;
export const DEFAULT_BACKGROUND_SUBAGENT_STALL_MAX_INTERVAL_MS = 4 * 60 * 60_000;
const TOOL_SUMMARY_MAX_CHARS = 200;
/** 提醒里的任务描述（XML、正文、轮标题共用）：Agent 入参的 description 没有硬上限。 */
const DESCRIPTION_MAX_CHARS = 200;
/** 提醒里列出的在途工具个数；其余只给个数，避免并行工具很多时提醒无限变长。 */
const RUNNING_TOOLS_MAX = 5;
/**
 * setTimeout 的最大延迟（2^31-1 ms，约 24.8 天）。超过时 Node 改成 1 ms 并告警：阈值配得很大
 * （例如想用大值「关掉」提醒）时，钟会变成每毫秒唤醒一次的忙循环（!3563 评审第二轮 SG-01）。
 * 更远的到期分段等待：fire() 会先判断是否真的到期，没到就再排下一段。
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 把一条 child 事件折进该 Agent 的活动快照；不是进展的事件不写 registry。
 * `executionId` 是发出事件的那次执行：同一 agentId 被 SendMessage 恢复成新执行后，旧执行的迟到
 * 事件不能改写新执行的快照（!3563 评审第四轮 CR-01）。
 */
export function noteSubagentActivity(
  registry: RuntimeTaskRegistry,
  agentId: string,
  event: SessionEvent,
  now: number = Date.now(),
  executionId?: string,
): void {
  const change = activityChange(event);
  if (!change) return;
  const belongs = (task: RuntimeTaskSnapshot) =>
    task.type === "local_agent" &&
    task.status === "running" &&
    (executionId === undefined ||
      task.executionId === undefined ||
      task.executionId === executionId);
  const current = registry.get(agentId);
  // 终态之后的迟到事件不再改写快照（update 会再次触发终态 waiter 与订阅者）。
  if (!current || !belongs(current)) return;
  registry.update(agentId, (task) => {
    if (!belongs(task)) return task;
    const previous = task.activity ?? {
      lastProgressAt: now,
      runningTools: [],
      waitingForPermission: false,
      pendingPermissionToolCallIds: [],
    };
    return { ...task, activity: change(previous, now) };
  });
}

type ActivityChange = (previous: SubagentActivitySnapshot, now: number) => SubagentActivitySnapshot;

function activityChange(event: SessionEvent): ActivityChange | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
  switch (event.type) {
    case SessionEventType.ModelRequest:
    case SessionEventType.ModelComplete:
      return (previous, now) => ({ ...previous, lastProgressAt: now });
    case SessionEventType.ToolCallScheduled:
    case SessionEventType.ToolCallStarted: {
      if (!toolCallId) return undefined;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
      const summary =
        event.type === SessionEventType.ToolCallScheduled
          ? toolInputSummary(payload.input)
          : undefined;
      return (previous, now) => {
        const existing = previous.runningTools.find((tool) => tool.toolCallId === toolCallId);
        const started = event.type === SessionEventType.ToolCallStarted;
        const tool: SubagentRunningToolActivity = {
          toolCallId,
          toolName: toolName ?? existing?.toolName ?? "tool",
          // 排队时间不算执行时间：Started 到达时重置为真正开始执行的时刻。
          startedAt: started ? now : (existing?.startedAt ?? now),
          ...((summary ?? existing?.summary) ? { summary: summary ?? existing?.summary } : {}),
        };
        return {
          ...previous,
          lastProgressAt: started ? now : previous.lastProgressAt,
          runningTools: [
            ...previous.runningTools.filter((item) => item.toolCallId !== toolCallId),
            tool,
          ],
        };
      };
    }
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError:
      if (!toolCallId) return undefined;
      return (previous, now) => ({
        ...withEnded(withPendingPermission(previous, toolCallId, false), { toolCallId }),
        lastProgressAt: now,
        runningTools: previous.runningTools.filter((tool) => tool.toolCallId !== toolCallId),
      });
    case SessionEventType.PermissionRequested:
      if (!toolCallId) return (previous) => ({ ...previous, waitingForPermission: true });
      return (previous) =>
        // 审批请求的发布可能比超时、取消后的结束事件更晚到：已结束的审批或工具调用不再挂起。
        permissionAlreadyEnded(previous, toolCallId, requestId)
          ? previous
          : withPendingPermission(previous, toolCallId, true);
    case SessionEventType.PermissionResolved:
    case SessionEventType.PermissionDenied:
      // 审批结束从这一刻重新计时，等人的时间不算无进展。按工具调用计：并行的另一个审批
      // 还挂着时仍在等人（!3563 评审 SG-02）。
      if (!toolCallId) {
        return (previous, now) => ({
          ...previous,
          lastProgressAt: now,
          waitingForPermission: false,
        });
      }
      return (previous, now) => ({
        ...withEnded(withPendingPermission(previous, toolCallId, false), {
          // 拒绝后工具调用不会执行；没有 requestId 时按工具调用记结束。
          ...(requestId ? { requestId } : { toolCallId }),
          ...(event.type === SessionEventType.PermissionDenied ? { toolCallId } : {}),
        }),
        lastProgressAt: now,
      });
    default:
      return undefined;
  }
}

const ENDED_IDS_KEPT = 64;

function permissionAlreadyEnded(
  previous: SubagentActivitySnapshot,
  toolCallId: string,
  requestId: string | undefined,
): boolean {
  return (
    (previous.endedToolCallIds ?? []).includes(toolCallId) ||
    (requestId !== undefined && (previous.endedPermissionRequestIds ?? []).includes(requestId))
  );
}

function withEnded(
  previous: SubagentActivitySnapshot,
  ended: { requestId?: string; toolCallId?: string },
): SubagentActivitySnapshot {
  const remember = (list: string[] | undefined, id: string | undefined) =>
    id === undefined
      ? list
      : [...(list ?? []).filter((item) => item !== id), id].slice(-ENDED_IDS_KEPT);
  const endedPermissionRequestIds = remember(previous.endedPermissionRequestIds, ended.requestId);
  const endedToolCallIds = remember(previous.endedToolCallIds, ended.toolCallId);
  return {
    ...previous,
    ...(endedPermissionRequestIds ? { endedPermissionRequestIds } : {}),
    ...(endedToolCallIds ? { endedToolCallIds } : {}),
  };
}

function withPendingPermission(
  previous: SubagentActivitySnapshot,
  toolCallId: string,
  pending: boolean,
): SubagentActivitySnapshot {
  const others = (previous.pendingPermissionToolCallIds ?? []).filter((id) => id !== toolCallId);
  const pendingPermissionToolCallIds = pending ? [...others, toolCallId] : others;
  return {
    ...previous,
    pendingPermissionToolCallIds,
    waitingForPermission: pendingPermissionToolCallIds.length > 0,
  };
}

function toolInputSummary(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = ["command", "description", "file_path", "path", "pattern", "url", "prompt"]
    .map((key) => record[key])
    .find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
    );
  if (!value) return undefined;
  return singleLine(value, TOOL_SUMMARY_MAX_CHARS);
}

function singleLine(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/** 提醒与轮标题里使用的任务描述：单行、有上限。 */
export function backgroundSubagentStallDescription(description: string): string {
  return singleLine(description, DESCRIPTION_MAX_CHARS) || "Subagent";
}

export interface BackgroundSubagentStallReminder {
  agentId: string;
  /** 生成提醒时的执行（SendMessage 恢复会换新）；出队时据此判断提醒是否过时。 */
  executionId?: string;
  description: string;
  parentToolCallId?: string;
  runningForMs: number;
  noProgressForMs: number;
  lastProgressAt: number;
  runningTools: Array<SubagentRunningToolActivity & { runningForMs: number }>;
  nextReportInMs: number;
  ordinal: number;
}

export interface BackgroundSubagentStallClockHost {
  now(): number;
  /** 在跑的后台 Agent（已过滤掉 rewind 分支）。 */
  liveAgents(): readonly RuntimeTaskSnapshot[];
  remind(reminder: BackgroundSubagentStallReminder): void;
  setTimer(callback: () => void, delayMs: number): () => void;
}

export interface BackgroundSubagentStallClockOptions {
  firstAfterMs?: number;
  maxIntervalMs?: number;
}

interface StallState {
  reminders: number;
  lastReminderAt?: number;
  /** 上次提醒时看到的进展时间；进展前进即清零。 */
  progressAt: number;
}

export class BackgroundSubagentStallClock {
  private readonly firstAfterMs: number;
  private readonly maxIntervalMs: number;
  private readonly states = new Map<string, StallState>();
  private cancelTimer: (() => void) | undefined;

  constructor(
    private readonly host: BackgroundSubagentStallClockHost,
    options: BackgroundSubagentStallClockOptions = {},
  ) {
    this.firstAfterMs = positiveOr(
      options.firstAfterMs,
      DEFAULT_BACKGROUND_SUBAGENT_STALL_FIRST_MS,
    );
    this.maxIntervalMs = Math.max(
      this.firstAfterMs,
      positiveOr(options.maxIntervalMs, DEFAULT_BACKGROUND_SUBAGENT_STALL_MAX_INTERVAL_MS),
    );
  }

  /** registry 变化后调用：同步在跑的 Agent，并把定时器对齐到最近的到期时间。 */
  reconcile(): void {
    const live = new Map(this.host.liveAgents().map((task) => [task.taskId, task]));
    for (const agentId of this.states.keys()) {
      if (!live.has(agentId)) this.states.delete(agentId);
    }
    for (const task of live.values()) {
      const progressAt = progressTime(task);
      const state = this.states.get(task.taskId);
      if (!state || progressAt > state.progressAt) {
        this.states.set(task.taskId, { reminders: 0, progressAt });
      }
    }
    this.schedule(live);
  }

  dispose(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.states.clear();
  }

  private intervalAfter(reminders: number): number {
    return Math.min(this.firstAfterMs * 2 ** reminders, this.maxIntervalMs);
  }

  private dueAt(state: StallState): number {
    return state.lastReminderAt === undefined
      ? state.progressAt + this.firstAfterMs
      : state.lastReminderAt + this.intervalAfter(state.reminders);
  }

  private schedule(live: ReadonlyMap<string, RuntimeTaskSnapshot>): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    let next: number | undefined;
    for (const [agentId, state] of this.states) {
      if (live.get(agentId)?.activity?.waitingForPermission) continue;
      const due = this.dueAt(state);
      next = next === undefined ? due : Math.min(next, due);
    }
    if (next === undefined) return;
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, next - this.host.now()));
    this.cancelTimer = this.host.setTimer(() => this.fire(), delayMs);
  }

  private fire(): void {
    this.cancelTimer = undefined;
    const now = this.host.now();
    const live = new Map(this.host.liveAgents().map((task) => [task.taskId, task]));
    for (const [agentId, state] of this.states) {
      const task = live.get(agentId);
      if (!task || task.activity?.waitingForPermission || this.dueAt(state) > now) continue;
      state.reminders += 1;
      state.lastReminderAt = now;
      const lastProgressAt = progressTime(task);
      this.host.remind({
        agentId,
        ...(task.executionId ? { executionId: task.executionId } : {}),
        description: task.description,
        ...(task.parentToolCallId ? { parentToolCallId: String(task.parentToolCallId) } : {}),
        runningForMs: Math.max(0, now - task.startedAt.getTime()),
        noProgressForMs: Math.max(0, now - lastProgressAt),
        lastProgressAt,
        runningTools: (task.activity?.runningTools ?? []).map((tool) => ({
          ...tool,
          runningForMs: Math.max(0, now - tool.startedAt),
        })),
        nextReportInMs: this.intervalAfter(state.reminders),
        ordinal: state.reminders,
      });
    }
    this.schedule(live);
  }
}

function progressTime(task: RuntimeTaskSnapshot): number {
  return task.activity?.lastProgressAt ?? task.startedAt.getTime();
}

/**
 * 排队中的提醒出队时是否仍然成立（!3563 评审第三轮 SG-01）。父会话正忙时提醒要等到回合结束；
 * 这期间 Agent 可能已经结束、有了新进展、进入审批，或被 SendMessage 恢复成新执行，「无进展」
 * 就不再属实，送达会误导主代理（甚至 TaskStop 一个在等人的 Agent）。任一不符即丢弃。
 */
export function isBackgroundSubagentStallReminderCurrent(
  task: RuntimeTaskSnapshot | undefined,
  stall: { lastProgressAt?: number; executionId?: string },
): boolean {
  if (!task || task.type !== "local_agent" || task.status !== "running") return false;
  if (task.activity?.waitingForPermission) return false;
  if (stall.executionId !== undefined && task.executionId !== stall.executionId) return false;
  if (stall.lastProgressAt !== undefined && progressTime(task) !== stall.lastProgressAt)
    return false;
  return true;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

const SYSTEM_NOTIFICATION_BANNER = [
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This is an automated status report about a background agent, NOT a message from the user.",
  "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
  "",
] as const;

/**
 * 给模型的报告正文。刻意不用 `<task-notification>`：App 把带 tool-use-id 的该标签读成 Agent 终态，
 * 不认识的 status 会落成「已完成」。措辞要让模型能判断、且不引导它草率停掉合理的长任务。
 */
export function formatBackgroundSubagentStallNotification(
  reminder: BackgroundSubagentStallReminder,
): string {
  // description、工具名与摘要来自 Agent 入参和 child 模型生成的工具入参：XML 块和正文里都转义，
  // 描述限长，整条再按标准通知上限截断（!3563 评审第三轮 SG-02）。
  const description = escapeXml(backgroundSubagentStallDescription(reminder.description));
  const agentId = escapeXml(reminder.agentId);
  const tools = [...reminder.runningTools].sort((a, b) => b.runningForMs - a.runningForMs);
  const listed = tools.slice(0, RUNNING_TOOLS_MAX);
  const lines: string[] = [
    ...SYSTEM_NOTIFICATION_BANNER,
    "<background-agent-stall>",
    `  <task-id>${agentId}</task-id>`,
    `  <description>${description}</description>`,
    `  <running-for-ms>${Math.floor(reminder.runningForMs)}</running-for-ms>`,
    `  <no-progress-for-ms>${Math.floor(reminder.noProgressForMs)}</no-progress-for-ms>`,
    `  <last-progress-at>${new Date(reminder.lastProgressAt).toISOString()}</last-progress-at>`,
  ];
  for (const tool of listed) {
    lines.push(
      `  <running-tool name="${escapeXml(tool.toolName)}" running-for-ms="${Math.floor(tool.runningForMs)}">${escapeXml(tool.summary ?? "")}</running-tool>`,
    );
  }
  if (tools.length > listed.length) {
    lines.push(`  <more-running-tools>${tools.length - listed.length}</more-running-tools>`);
  }
  lines.push(
    `  <next-report-in-ms>${Math.floor(reminder.nextReportInMs)}</next-report-in-ms>`,
    "</background-agent-stall>",
    "",
    `Background agent "${description}" (${agentId}) has been running for ${minutes(reminder.runningForMs)} and has made no progress for ${minutes(reminder.noProgressForMs)}: no new model request and no tool call has finished.`,
  );
  const [longest] = tools;
  if (longest) {
    lines.push(
      `It is inside ${escapeXml(longest.toolName)}, which has been running for ${minutes(longest.runningForMs)}${longest.summary ? `: ${escapeXml(longest.summary)}` : ""}.`,
    );
  }
  lines.push(
    "This is a status report, not a failure. Test suites, builds, simulations and polling loops with sleep often run this long or longer.",
    `If that fits what the agent is doing, do nothing and end your turn; if it is still quiet, the next report comes in about ${minutes(reminder.nextReportInMs)}.`,
    "Stop it with TaskStop only if you have a concrete reason to think it is stuck (for example, it waits for input that will never arrive). TaskOutput with block=false shows its current activity. Tell the user if they are waiting on it.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  if (value < 120) return `${value} minute${value === 1 ? "" : "s"}`;
  const hours = Math.round((value / 60) * 10) / 10;
  return `${hours} hours`;
}
