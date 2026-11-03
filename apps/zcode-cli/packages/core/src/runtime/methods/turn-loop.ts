import {
  appendRequestAnnouncements,
  appendRuntimeContextAnnouncements,
  appendRuntimeSkillsAnnouncement,
  persistAnnouncements,
} from "./context-refresh.js";
import { getTurnTools } from "./turn-tool-visibility.js";
import { refreshOffPeakTurnAfterTakeover } from "../off-peak/turn.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBodyForTask,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildSilentTurnReminderBody,
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { querySourceForTask } from "./turn-model-step-usage.js";
import { inputRoleOf } from "../helpers/provider-entry-origins.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";
import { recordSessionFeatureFromToolSearchExposure } from "../session-features/contract.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    refreshOffPeakTurnAfterTakeover(this, state);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    // 通知只在带新输入的请求前取出：完整工具批次之后、文本回复后续上 guide，与输入附件同一时机。
    // 修复原因：每次迭代都取时，Stop hook 续跑、流重试、降级等重发同一份输入的请求也被插入通知；
    // 所以其余时候通知留在队列里，本轮结束后开新一轮。
    if (
      state.inputAttachmentCollectionPending &&
      state.modelStepCount > 0 &&
      !outputTokenRecoveryActive
    ) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const tools = getTurnTools(this, state);
    finishTools();

    // 输入附件在 compaction 之前运行：本轮输入或上一批工具结果产生的项属于 compaction
    // 保留或摘要的历史。只在有新输入时收集（轮首、完整工具批次之后、文本回复后续上 guide）；
    // 新轮通知的首个请求跳过。
    // Stop hook 续跑、模型降级、流恢复、Start Plan 排队重试、上下文超限恢复、闲时换票
    // 都重发同一份输入，不收集：每次收集都会多出一条 output_style 等不去重的附件。
    if (state.inputAttachmentCollectionPending) {
      state.inputAttachmentCollectionPending = false;
      if (!endsWithNewTurnInput(state.turnRequestState.entries)) {
        await collectInputAttachments(this, state, tools);
      }
    }

    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      // memory prefetch 排在输入附件之后。
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        getAgentListingTools: () => tools,
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        getContinuationTools: () => getTurnTools(this, state),
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    // 请求前公告在 compaction 之后运行，
    // 不受输入附件跳过规则影响；按类型对历史去重，通常为空。
    await appendRequestAnnouncements(
      this,
      state.turnRequestState,
      state.turnTraceContext,
      state.turnAbortSignal,
    );
    const requestEntries = [...state.turnRequestState.entries];
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      applyCacheControl: true,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // 能力标签取本次主循环请求的生效模式，在模型调用前打，本次请求就带上。请求准备环节本身不写状态，
    // 所以在调用方打；compact、目标校验、Memory 的请求准备不经过这里。
    recordSessionFeatureFromToolSearchExposure.call(
      this,
      prepared.toolSearch,
      state.turnTraceContext,
    );
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    if (result === "break") {
      break;
    }
  }
}

/**
 * 新轮通知与 peer 消息开启的轮次，首个请求不收集输入附件。
 * 请求前公告不受影响，照常运行并在投影时冒泡到通知之前。只看历史判断，resume/fork/rewind 后
 * 自然一致；调用工具后最后一条变成 tool result，后续请求照常收集。
 */
function endsWithNewTurnInput(entries: readonly RuntimeMessageEntry[]): boolean {
  const latest = entries.findLast((entry) => !isRuntimeAttachmentEntry(entry));
  return latest !== undefined && inputRoleOf(latest) === "new_turn";
}

/**
 * 输入附件收集，按固定顺序依次执行；各项保留自己的触发条件。
 * 全部写入历史，resume 后前缀不变。todo 提醒先提交再落盘，其余先持久化成功再提交。
 */
async function collectInputAttachments(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: ReturnType<typeof getTurnTools>,
): Promise<void> {
  await appendRuntimeContextAnnouncements(
    runtime,
    state.turnRequestState,
    state.model,
    state.turnOutputStyle,
    state.turnTraceContext,
    state.turnAbortSignal,
  );
  // ToolSearch 公告（deferred tools 增量）在模型之后、agent listing 之前。
  await appendToolSearchAnnouncement(runtime, state, tools);
  await appendRuntimeAgentListing(runtime, state.turnRequestState, tools, state.turnTraceContext);
  await appendRuntimeSkillsAnnouncement(runtime, state.turnRequestState, state.turnTraceContext);
  // 退出提醒由历史推导（最近的 plan 提醒之后没有退出提醒），内存标记只是额外触发。
  // 修复原因：只看内存标记时，冷恢复后标记丢失，计划模式的退出提醒不会发出。
  if (
    !runtime.getPlanEnabled() &&
    (runtime.needsPlanModeExitReminder || isPlanModeExitPending(state.turnRequestState.entries))
  ) {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody())],
      state.turnTraceContext,
    );
    runtime.needsPlanModeExitReminder = false;
  }
  const runtimeModeReminderBody = buildRuntimeModeReminderBodyForTask(
    state.turnRequestState.entries,
    {
      mode: runtime.getMode(),
      planEnabled: runtime.getPlanEnabled(),
      taskType: runtime.config.taskType,
      tools,
    },
  );
  if (runtimeModeReminderBody) {
    // 只写内存会在冷恢复时丢失提醒与计数边界；复用动态公告的持久化和 hydration。
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody)],
      state.turnTraceContext,
    );
  }
  if (
    tools.some((tool) => tool.name === "TodoWrite") &&
    shouldBuildTodoReminder(state.turnRequestState.entries)
  ) {
    const currentTodos = await runtime.readSessionTodosForContext(state.turnTraceContext);
    const reminderBody = buildTodoReminderBody(currentTodos);
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry("todo_reminder", reminderBody),
    ]);
    await runtime.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
      sessionId: runtime.sessionId,
      source: "todo_reminder",
      text: reminderBody,
      traceContext: state.turnTraceContext,
    });
  }
  const silentReminderBody =
    state.modelStepCount > 0 && querySourceForTask(runtime.config.taskType) === "main_turn"
      ? buildSilentTurnReminderBody(state.turnRequestState.entries)
      : null;
  if (silentReminderBody) {
    // 历史是计数的唯一来源；先持久化再提交，避免失败后留下已提醒的虚假标记。
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [systemReminderAttachmentEntry("silent_turn_reminder", silentReminderBody)],
      state.turnTraceContext,
    );
  }
  // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
  // 一律走 ui/update-model-context。
  // output_style 每次收集都产出，不去重。修复原因：只在首步发且不落 session 时，
  // 工具批次后的请求缺少它，resume 后的前缀也会变化。
  const outputStyleReminderBody = buildRuntimeOutputStyleReminderBody(state.turnOutputStyle);
  // Dream 可能在同一 turn 的首个模型请求期间完成；每次收集都检查，把一次性更新放进紧随其后的请求。
  // 修复原因：作为只属于单次请求的 entry 时，后续请求缺少它，同一会话内的请求前缀因此变化。
  const pendingMemoryUpdate = runtime.pendingMemoryUpdate;
  const memoryUpdate = consumePendingProjectMemoryUpdate(runtime);
  try {
    await persistAnnouncements(
      runtime,
      state.turnRequestState,
      [
        ...(outputStyleReminderBody
          ? [systemReminderAttachmentEntry("output_style", outputStyleReminderBody)]
          : []),
        ...(memoryUpdate ? [memoryUpdate] : []),
      ],
      state.turnTraceContext,
    );
  } catch (error) {
    // 修复原因：更新先取出再写库，写库失败时这条一次性更新会永久丢失。
    // 放回去由下一次收集再发；期间 Dream 产生了更新的版本时保留新的。
    runtime.pendingMemoryUpdate ??= pendingMemoryUpdate;
    throw error;
  }
}

async function appendToolSearchAnnouncement(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: ReturnType<typeof getTurnTools>,
): Promise<void> {
  const announcement = buildToolSearchAnnouncement({
    model: state.model,
    mode: runtime.config.toolSearch?.mode,
    tools,
    registry: runtime.getToolRegistry(),
    entries: state.turnRequestState.entries,
  });
  // 公告正文和增量事实必须先一起落盘；否则 fork/resume 会把已公告工具重新当成首次出现。
  await persistAnnouncements(
    runtime,
    state.turnRequestState,
    announcement ? [announcement] : [],
    state.turnTraceContext,
    state.model,
  );
}

function isPlanModeExitPending(entries: readonly RuntimeMessageEntry[]): boolean {
  const latest = entries.findLast(
    (entry) =>
      isRuntimeAttachmentEntry(entry) &&
      (entry.metadata.source === "runtime_mode" || entry.metadata.source === "plan_mode_exit"),
  );
  return latest?.metadata?.source === "runtime_mode";
}
