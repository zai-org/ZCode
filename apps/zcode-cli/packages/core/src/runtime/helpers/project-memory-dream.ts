import { basename, join, resolve } from "node:path";

import type { SessionInfo, TraceContext } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
} from "../../memory/dream.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolRunner,
  projectMemoryAgentEntries,
  renderProjectMemoryAgentRequest,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { invalidateProjectMemoryRecallPaths } from "./project-memory-recall.js";
import { isMainMemoryTaskType, resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 5;
const DREAM_MAX_TURNS = 50;
export interface ProjectMemoryUpdate {
  inContextPaths: string[];
  paths: string[];
  source: "dream";
  summary: string;
}

export function selectProjectDreamSessions(input: {
  currentSessionId: AgentRuntimeInternal["sessionId"];
  sessions: readonly SessionInfo[];
  workspacePath: string;
  workspaceIdentity?: string;
}): SessionInfo[] {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const workspacePath = workspaceIdentity ? undefined : resolve(input.workspacePath);

  return input.sessions.filter((session) => {
    if (session.id === input.currentSessionId) return false;
    if (!isMainMemoryTaskType(session.taskType)) return false;
    if (workspaceIdentity) return session.workspaceID === workspaceIdentity;
    return resolve(session.directory) === workspacePath;
  });
}

// 当前产品链路不自动触发 Dream；保留可等待的 handler，待 project transcript 隔离方案确定后再接线。
export async function runProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { traceContext: TraceContext },
): Promise<void> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;
  if (!runtime.modelIoDir) return;

  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  await executeProjectMemoryDream(runtime, context);
}

export function consumePendingProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const update = runtime.pendingMemoryUpdate;
  if (!update) return undefined;
  runtime.pendingMemoryUpdate = undefined;
  return systemReminderAttachmentEntry("memory_update", formatProjectMemoryUpdate(update));
}

async function executeProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
): Promise<void> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: context.causation,
    executionKind: "background",
    operation: "project_memory_dream",
    targetKind: "project_memory",
    traceContext: context.traceContext,
    trigger: "scheduler",
  });

  await telemetry.run(async () => {
    let acquiredPriorMtimeMs: number | undefined;
    try {
      const nowMs = runtime.now().getTime();
      const lastConsolidatedAtMs = await readDreamLastConsolidatedAt(context.memoryRoot);
      const timing = evaluateAutoDreamTiming({
        lastConsolidatedAtMs,
        lastScanAtMs: runtime.memoryDreamLastScanAtMs,
        nowMs,
      });
      if (timing.decision === "skip") {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }

      runtime.memoryDreamLastScanAtMs = nowMs;
      const sessions = selectProjectDreamSessions({
        currentSessionId: runtime.sessionId,
        sessions: await runtime.sessionStore!.listSessions(),
        workspacePath: context.workspaceRoot,
        workspaceIdentity: runtime.config.memory?.workspaceIdentity,
      });
      const transcriptSessionIds = await recentModelIoSessionIds(
        runtime,
        sessions,
        context,
        lastConsolidatedAtMs,
      );
      if (transcriptSessionIds.length < DREAM_MINIMUM_TRANSCRIPT_SESSIONS) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }

      const priorMtimeMs = await acquireDreamLock({ memoryRoot: context.memoryRoot, nowMs });
      if (priorMtimeMs === null) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }
      acquiredPriorMtimeMs = priorMtimeMs;

      const prompt = buildMemoryDreamPrompt({
        memoryRoot: context.memoryRoot,
        sessionIds: transcriptSessionIds,
        transcriptRoot: runtime.modelIoDir!,
      });
      const runTools = createProjectMemoryAgentToolRunner(runtime, context);
      const touchedPaths = new Set<string>();

      await runMemoryAgentLoop({
        bashShellSelection: context.bashShellSelection,
        entries: projectMemoryAgentEntries(context, prompt),
        executeToolCalls: (toolCalls, options) => {
          for (const toolCall of toolCalls) {
            collectDreamTouchedPaths(touchedPaths, {
              rootDir: context.memoryRoot,
              toolCall,
              workingDirectory: context.workingDirectory,
              workspaceRoot: context.workspaceRoot,
            });
          }
          return runTools(toolCalls, options);
        },
        maxTurns: DREAM_MAX_TURNS,
        registry: runtime.registry,
        renderRequest: (entries) => renderProjectMemoryAgentRequest(context, entries),
        model: context.model,
        rootDir: context.memoryRoot,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

      const paths = [...touchedPaths];
      if (paths.length > 0) {
        runtime.pendingMemoryUpdate = createProjectMemoryUpdate(runtime, paths);
        invalidateProjectMemoryRecallPaths(runtime, paths);
      }
      telemetry.finishCompleted();
    } catch (error) {
      telemetry.finishFailed("execute", "internal", error);
      if (acquiredPriorMtimeMs !== undefined) {
        try {
          await restoreDreamLockAfterFailure({
            memoryRoot: context.memoryRoot,
            priorMtimeMs: acquiredPriorMtimeMs,
          });
        } catch {
          // Dream 已失败；lock 恢复失败不改变前台 turn，也不追加第二套恢复机制。
        }
      }
    }
  });
}

async function recentModelIoSessionIds(
  runtime: AgentRuntimeInternal,
  sessions: readonly SessionInfo[],
  context: ProjectMemoryAgentContext,
  lastConsolidatedAtMs: number,
): Promise<string[]> {
  const sessionIds = await Promise.all(
    sessions.map(async (session) => {
      try {
        const result = await runtime.fileSystemPort!.stat({
          path: join(runtime.modelIoDir!, `model-io-${session.id}.jsonl`),
          trace: context.traceContext,
        });
        // 修复原因：gate 以真实 transcript mtime 为准；SessionStore.updated 只描述
        // durable session，不能代替 transcript 是否在上次 consolidation 后发生变化。
        return result.kind === "file" &&
          result.mtimeMs !== undefined &&
          result.mtimeMs > lastConsolidatedAtMs
          ? String(session.id)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return sessionIds.filter((sessionId): sessionId is string => sessionId !== undefined);
}

function createProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
  paths: string[],
): ProjectMemoryUpdate {
  const inContextPaths = paths.filter(
    (path) =>
      basename(path) === "MEMORY.md" ||
      runtime.memoryRecallState.recalledPaths.has(path) ||
      findLatestReadFileState(runtime.readFileState, path) !== undefined,
  );
  return {
    inContextPaths,
    paths,
    source: "dream",
    summary: `consolidated ${paths.length} memory file${paths.length === 1 ? "" : "s"}`,
  };
}

function formatProjectMemoryUpdate(update: ProjectMemoryUpdate): string {
  const lines = [
    `Background memory consolidation updated your memory directory: ${update.summary}`,
  ];
  if (update.paths.length > 0) {
    lines.push(`Files changed: ${update.paths.join(", ")}`);
  }
  if (update.inContextPaths.length > 0) {
    lines.push(
      `Your loaded copy of ${update.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
    );
  }
  lines.push(
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
  );
  return lines.join("\n");
}
