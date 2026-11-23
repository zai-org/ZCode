import {
  WorkflowAgentCallInputSchema,
  createChildTraceContext,
  createSessionId,
  type ScriptWorkflowActivityRecord,
  type ScriptWorkflowRunRecord,
  type ScriptWorkflowRunStats,
  type ScriptWorkflowRunStatus,
  type ScriptWorkflowStorePort,
  type SessionId,
  type TraceContext,
  type WorkflowAgentCallInput,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { PrepareUserExecutionBoundary } from "./types.js";
import { readWorkflowScriptDocument, stableHash } from "./script-workflow-meta.js";
import { prepareScriptWorkflowRun } from "./script-workflow-prepare.js";
import { resolveWorkflowDefaultConcurrency } from "./workflow-default-concurrency.js";
import {
  runScriptWorkflowChild,
  type ScriptWorkflowChildRequest,
} from "./script-workflow-process.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";
import {
  emptyScriptWorkflowStats,
  formatScriptWorkflowList,
  formatScriptWorkflowRun,
  formatScriptWorkflowValidation,
  mergeScriptWorkflowStats,
} from "./script-workflow-format.js";
import {
  WorkflowLimiter,
  buildAgentPrompt,
  collectScriptWorkflowSessionStats,
  isRecord,
  isScriptWorkflowStore,
  mergedSignal,
  parseStructuredResponse,
  serializeError,
} from "./script-workflow-utils.js";

const MAX_WORKFLOW_AGENT_CALLS = 1000;

export interface ScriptWorkflowRuntimeDeps extends ScriptWorkflowAgentRuntimeDeps {
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  traceContext: TraceContext;
}

type ScriptWorkflowRunOptions = {
  abortSignal?: AbortSignal;
  onEvent?: (event: unknown) => void | Promise<void>;
} & Parameters<PrepareUserExecutionBoundary>[0];

export class ScriptWorkflowRuntime {
  // 与 dwf run service / 进程级治理器同一份默认并发实现（决策 30）；legacy 工具仍只有本地 limiter，不接治理器。
  private readonly concurrency = resolveWorkflowDefaultConcurrency();
  private readonly limiter = new WorkflowLimiter(this.concurrency);
  private callIndex = 0;
  private readonly shutdown = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private readonly children = new Set<AgentRuntime>();
  private closePromise?: Promise<void>;

  private track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    void work.then(
      () => this.running.delete(work),
      () => this.running.delete(work),
    );
    return work;
  }

  close(): Promise<void> {
    this.shutdown.abort(new Error("Workflow runtime closed"));
    this.closePromise ??= (async () => {
      while (this.running.size > 0) await Promise.allSettled(this.running);
      const results = await Promise.allSettled(
        [...this.children].map(async (runtime) => {
          await runtime.close();
          this.children.delete(runtime);
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Workflow cleanup failed");
    })().catch((error) => {
      // 清理失败的 child 仍在 children 中，最终 owner 必须能重试。
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private ownedOptions(options?: ScriptWorkflowRunOptions): ScriptWorkflowRunOptions {
    this.shutdown.signal.throwIfAborted();
    return {
      ...options,
      abortSignal: options?.abortSignal
        ? AbortSignal.any([options.abortSignal, this.shutdown.signal])
        : this.shutdown.signal,
    };
  }

  async run(
    input: { args?: unknown; resumeFromRunId?: string; runId?: string; scriptPath: string },
    options?: ScriptWorkflowRunOptions,
  ) {
    const owned = this.ownedOptions(options);
    return this.track(this.runOwned(input, owned));
  }

  async resume(input: { runId: string }, options?: ScriptWorkflowRunOptions) {
    const owned = this.ownedOptions(options);
    return this.track(this.resumeOwned(input, owned));
  }

  constructor(private readonly deps: ScriptWorkflowRuntimeDeps) {}

  async validate(input: { scriptPath: string }): Promise<{ response: string; traceId: string }> {
    const document = await readWorkflowScriptDocument({
      fileSystemPort: this.deps.fileSystemPort,
      scriptPath: input.scriptPath,
      traceContext: this.deps.traceContext,
    });
    this.callIndex = 0;
    return {
      response: formatScriptWorkflowValidation({
        meta: document.meta,
        scriptHash: document.hash,
        scriptPath: document.path,
      }),
      traceId: this.deps.traceContext.traceId,
    };
  }

  async list(input: { limit?: number } = {}): Promise<{ response: string; traceId: string }> {
    const runs = await this.store().listScriptWorkflowRuns({
      cwd: this.deps.workingDirectory,
      limit: input.limit ?? 20,
    });
    return {
      response: formatScriptWorkflowList(runs),
      traceId: this.deps.traceContext.traceId,
    };
  }

  async status(input: { runId?: string } = {}): Promise<{
    response: string;
    runId?: string;
    status?: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    const run = input.runId
      ? await this.store().getScriptWorkflowRun(input.runId)
      : (
          await this.store().listScriptWorkflowRuns({
            cwd: this.deps.workingDirectory,
            limit: 1,
          })
        )[0];
    if (!run) {
      return {
        response: "No workflow run found.",
        traceId: this.deps.traceContext.traceId,
      };
    }
    const activities = await this.store().listScriptWorkflowActivities({ runId: run.id });
    return {
      response: formatScriptWorkflowRun({ activities, run }),
      runId: run.id,
      status: run.status,
      traceId: this.deps.traceContext.traceId,
    };
  }

  private async runOwned(
    input: { args?: unknown; resumeFromRunId?: string; runId?: string; scriptPath: string },
    options?: ScriptWorkflowRunOptions,
  ): Promise<{
    response: string;
    runId: string;
    status: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    options?.abortSignal?.throwIfAborted();
    await this.deps.prepareUserExecutionBoundary(options);
    options?.abortSignal?.throwIfAborted();
    const document = await readWorkflowScriptDocument({
      fileSystemPort: this.deps.fileSystemPort,
      scriptPath: input.scriptPath,
      traceContext: options?.traceContext ?? this.deps.traceContext,
    });
    await this.deps.runtime.ensureSessionPersistedForExternalActivity(
      `/workflow run ${document.path}`,
      { traceContext: options?.traceContext ?? this.deps.traceContext },
    );
    const run = await prepareScriptWorkflowRun({
      args: input.args,
      document,
      parentSessionId: this.deps.sessionId,
      resumeFromRunId: input.resumeFromRunId,
      runId: input.runId,
      store: this.store(),
      workingDirectory: this.deps.workingDirectory,
    });
    await this.appendEvent(run.id, "workflow_started", { scriptPath: document.path });

    try {
      await this.store().updateScriptWorkflowRun({
        id: run.id,
        startedAt: Date.now(),
        status: "running",
      });
      const childResult = await runScriptWorkflowChild({
        args: input.args ?? run.args,
        budgetTotal: run.budgetTotal,
        document,
        handleEvent: (event) => this.handleChildEvent(run.id, event.type, event.payload),
        handleRequest: (request) => this.handleChildRequest(run, request, options),
        signal: options?.abortSignal,
        workingDirectory: this.deps.workingDirectory,
      });
      await this.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        id: run.id,
        status: "completed",
      });
      await this.appendEvent(run.id, "workflow_completed", { result: childResult.value });
    } catch (error) {
      await this.store().updateScriptWorkflowRun({
        completedAt: Date.now(),
        failure: serializeError(error),
        id: run.id,
        status: options?.abortSignal?.aborted ? "cancelled" : "failed",
      });
      await this.appendEvent(
        run.id,
        options?.abortSignal?.aborted ? "workflow_cancelled" : "workflow_failed",
        serializeError(error),
      );
    }

    const finalRun = (await this.store().getScriptWorkflowRun(run.id)) ?? run;
    const activities = await this.store().listScriptWorkflowActivities({ runId: run.id });
    return {
      response: formatScriptWorkflowRun({ activities, run: finalRun }),
      runId: run.id,
      status: finalRun.status,
      traceId: this.deps.traceContext.traceId,
    };
  }

  private async resumeOwned(
    input: { runId: string },
    options?: ScriptWorkflowRunOptions,
  ): Promise<{
    response: string;
    runId: string;
    status: ScriptWorkflowRunStatus;
    traceId: string;
  }> {
    const run = await this.store().getScriptWorkflowRun(input.runId);
    if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
    if (!run.scriptPath) throw new Error(`Workflow run has no script path: ${input.runId}`);
    return this.runOwned(
      {
        args: run.args,
        resumeFromRunId: input.runId,
        scriptPath: run.scriptPath,
      },
      options,
    );
  }

  private async handleChildRequest(
    run: ScriptWorkflowRunRecord,
    request: ScriptWorkflowChildRequest,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (request.type === "agent") {
      return this.runAgent(run, WorkflowAgentCallInputSchema.parse(request.payload), options);
    }
    if (request.type === "workflow") {
      throw new Error("Nested workflow() is reserved for a later workflow runtime version.");
    }
    throw new Error(`Unknown workflow child request: ${request.type}`);
  }

  private async handleChildEvent(runId: string, type: string, payload: unknown): Promise<void> {
    if (type === "phase" && isRecord(payload) && typeof payload.title === "string") {
      await this.store().updateScriptWorkflowRun({
        currentPhase: payload.title,
        id: runId,
      });
    }
    await this.appendEvent(runId, `script_${type}`, payload);
  }

  private async runAgent(
    run: ScriptWorkflowRunRecord,
    input: WorkflowAgentCallInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (this.callIndex >= MAX_WORKFLOW_AGENT_CALLS) {
      throw new Error(`Workflow agent call limit exceeded: ${MAX_WORKFLOW_AGENT_CALLS}`);
    }
    const callIndex = ++this.callIndex;
    const callPath = input.callPath ?? `root/agent${callIndex}`;
    const phase = input.opts?.phase ?? input.phase;
    const inputHash = stableHash({ opts: input.opts, phase, prompt: input.prompt });
    const cached = await this.store().findCachedScriptWorkflowActivity({
      callPath,
      inputHash,
      runId: run.id,
    });
    if (cached?.result) {
      await this.appendEvent(run.id, "activity_cached", { activityId: cached.id });
      // The child runner unwraps result.value while reading stats from the envelope.
      return cached.result;
    }

    const activity = await this.store().createScriptWorkflowActivity({
      callIndex,
      callPath,
      id: `activity_${crypto.randomUUID()}`,
      inputHash,
      label: input.opts?.label,
      opts: input.opts,
      phase,
      prompt: input.prompt,
      runId: run.id,
      type: "agent",
    });
    return this.limiter.run(() => this.runLiveAgent(run, activity, input, options));
  }

  private async runLiveAgent(
    run: ScriptWorkflowRunRecord,
    activity: ScriptWorkflowActivityRecord,
    input: WorkflowAgentCallInput,
    options?: ScriptWorkflowRunOptions,
  ): Promise<unknown> {
    if (input.opts?.isolation === "worktree") {
      throw new Error("workflow agent isolation 'worktree' is not implemented yet.");
    }
    const startedAt = Date.now();
    const childSessionId = createSessionId(`workflow_${activity.id}`);
    const childTraceContext = createChildTraceContext(this.deps.traceContext, {
      attributes: {
        parentSessionId: this.deps.sessionId,
        workflowActivityId: activity.id,
        workflowRunId: run.id,
      },
      sessionId: childSessionId,
      rootSessionId: this.deps.traceContext.rootSessionId ?? this.deps.sessionId,
    });
    const childRuntime = await createScriptWorkflowAgentRuntime({
      childSessionId,
      deps: this.deps,
      request: input,
      traceContext: childTraceContext,
    });
    this.children.add(childRuntime);
    const agentPrompt = buildAgentPrompt(input);

    let unsubscribe: (() => void) | undefined;
    try {
      // workflow_activity.child_session_id has an FK to session(id), so link only after persistence.
      await childRuntime.ensureSessionPersistedForExternalActivity(agentPrompt, {
        traceContext: childTraceContext,
      });
      await this.store().updateScriptWorkflowActivity({
        childSessionId,
        id: activity.id,
        startedAt,
        status: "running",
      });
      await this.appendEvent(run.id, "activity_started", { activityId: activity.id });
      unsubscribe = options?.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      const signal = mergedSignal(options?.abortSignal, input.opts?.timeoutMs);
      const result = await childRuntime.executeTurn(agentPrompt, undefined, {
        abortSignal: signal,
        inputSource: "subagent",
        traceContext: childTraceContext,
      });
      const stats = await this.collectSessionStats(childSessionId);
      const value = input.opts?.schema ? parseStructuredResponse(result.response) : result.response;
      const activityResult = {
        response: result.response,
        stats,
        traceId: result.traceId,
        turnId: result.turnId,
        value,
      };
      await this.store().updateScriptWorkflowActivity({
        completedAt: Date.now(),
        id: activity.id,
        result: activityResult,
        status: "completed",
      });
      const childSelection = childRuntime.getSessionModelSelection();
      await this.store().createSessionTaskLink({
        activityId: activity.id,
        agentType: input.opts?.agentType,
        childSessionId,
        id: `tasklink_${crypto.randomUUID()}`,
        label: input.opts?.label,
        model: childSelection
          ? `${childSelection.providerId}/${childSelection.modelId}`
          : undefined,
        parentSessionId: this.deps.sessionId,
        path: activity.callPath,
        phase: activity.phase,
        role: "workflow_agent",
        rootWorkflowRunId: run.id,
        status: "completed",
      });
      await this.addRunStats(run.id, stats);
      await this.appendEvent(run.id, "activity_completed", { activityId: activity.id });
      // Keep the activity envelope on the child-process IPC boundary; script code receives value.
      return activityResult;
    } catch (error) {
      await this.store().updateScriptWorkflowActivity({
        completedAt: Date.now(),
        error: serializeError(error),
        id: activity.id,
        status: options?.abortSignal?.aborted ? "cancelled" : "failed",
      });
      await this.addRunStats(run.id, {
        ...emptyScriptWorkflowStats(),
        agentCalls: 1,
        failedAgentCalls: 1,
      });
      await this.appendEvent(run.id, "activity_failed", {
        activityId: activity.id,
        error: serializeError(error),
      });
      throw error;
    } finally {
      unsubscribe?.();
      // activity 结果已经落地；释放失败保留 child，不能把成功结果改写成脚本执行失败。
      const cancelled = options?.abortSignal?.aborted === true;
      const released = cancelled ? childRuntime.close() : childRuntime.retire();
      const release = released.then(
        () => {
          this.children.delete(childRuntime);
        },
        (error: unknown) =>
          this.deps.logger?.warn("Workflow child resource cleanup pending", {
            event: "workflow.child.cleanup.pending",
            childSessionId,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      if (cancelled || !childRuntime.hasResidencyBlockingWork()) await release;
    }
  }

  private async collectSessionStats(sessionId: SessionId): Promise<ScriptWorkflowRunStats> {
    return collectScriptWorkflowSessionStats(
      this.deps.sessionStore,
      sessionId,
      emptyScriptWorkflowStats,
    );
  }

  private async addRunStats(runId: string, delta: ScriptWorkflowRunStats): Promise<void> {
    const run = await this.store().getScriptWorkflowRun(runId);
    const current = run?.stats ?? emptyScriptWorkflowStats();
    await this.store().updateScriptWorkflowRun({
      budgetSpent: (run?.budgetSpent ?? 0) + delta.tokens.total,
      id: runId,
      stats: mergeScriptWorkflowStats(current, delta),
    });
  }

  private async appendEvent(runId: string, type: string, payload?: unknown): Promise<void> {
    await this.store().appendScriptWorkflowEvent({
      id: `workflow_event_${crypto.randomUUID()}`,
      payload,
      runId,
      type,
    });
  }

  private store(): ScriptWorkflowStorePort {
    if (isScriptWorkflowStore(this.deps.sessionStore)) return this.deps.sessionStore;
    throw new Error("Script workflow store is not available for this session store.");
  }
}
