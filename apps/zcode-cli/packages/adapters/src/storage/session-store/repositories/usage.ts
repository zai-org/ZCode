import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  AppUsageDayModelRow,
  AppUsageDayRow,
  AppUsageModelRow,
  AppUsageQueryInput,
  AppUsageQueryResult,
  AppUsageToolRow,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  ModelUsageRecord,
  ToolUsageRecord,
  TurnUsageRecord,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";

// 用量事实永久保留；查询时间范围只负责筛选，写入时不能清理历史统计。
export async function recordModelUsage(db: DatabaseSync, input: ModelUsageRecord): Promise<void> {
  const computedTotalTokens =
    input.computedTotalTokens ??
    inputSideTokensFromNormalizedUsage(
      input.inputTokens,
      input.cacheCreationInputTokens,
      input.cacheReadInputTokens,
    ) + integer(input.outputTokens);

  // 数据库沿用 0010 创建的历史列名；领域层使用更准确的 reasoningLevel。
  db.prepare(
    `
      insert into model_usage (
        id,
        logical_request_id,
        attempt_index,
        session_id,
        turn_id,
        trace_id,
        span_id,
        assistant_message_id,
        parent_user_message_id,
        query_source,
        provider_id,
        model_id,
        variant,
        agent,
        mode,
        task_type,
        status,
        started_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        finish_reason,
        tool_call_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        provider_total_tokens,
        computed_total_tokens,
        retry_count,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code,
        error_message,
        raw_usage_json,
        provider_metadata_json
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        logical_request_id = excluded.logical_request_id,
        attempt_index = excluded.attempt_index,
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        trace_id = excluded.trace_id,
        span_id = excluded.span_id,
        assistant_message_id = excluded.assistant_message_id,
        parent_user_message_id = excluded.parent_user_message_id,
        query_source = excluded.query_source,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        variant = excluded.variant,
        agent = excluded.agent,
        mode = excluded.mode,
        task_type = excluded.task_type,
        status = excluded.status,
        started_at = excluded.started_at,
        first_token_at = excluded.first_token_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        time_to_first_token_ms = excluded.time_to_first_token_ms,
        finish_reason = excluded.finish_reason,
        tool_call_count = excluded.tool_call_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        provider_total_tokens = excluded.provider_total_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = excluded.error_type,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        raw_usage_json = excluded.raw_usage_json,
        provider_metadata_json = excluded.provider_metadata_json
      `,
  ).run(
    input.id,
    input.logicalRequestId,
    integer(input.attemptIndex),
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.spanID ?? null,
    input.assistantMessageID ?? null,
    input.parentUserMessageID ?? null,
    input.querySource,
    input.providerId,
    input.modelId,
    input.reasoningLevel ?? null,
    input.agent ?? null,
    input.mode ?? null,
    input.taskType ?? null,
    input.status,
    input.startedAt,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    input.finishReason ?? null,
    integer(input.toolCallCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    input.providerTotalTokens ?? null,
    computedTotalTokens,
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    encodeJson(input.rawUsage),
    encodeJson(input.providerMetadata),
  );
}

export async function upsertTurnUsage(db: DatabaseSync, input: TurnUsageRecord): Promise<void> {
  db.prepare(
    `
      insert into turn_usage (
        session_id,
        turn_id,
        trace_id,
        user_message_id,
        status,
        started_at,
        first_model_start_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        model_request_count,
        model_retry_count,
        tool_call_count,
        tool_error_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        computed_total_tokens,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      on conflict(session_id, turn_id) do update set
        trace_id = coalesce(excluded.trace_id, turn_usage.trace_id),
        user_message_id = coalesce(excluded.user_message_id, turn_usage.user_message_id),
        status = excluded.status,
        started_at = min(turn_usage.started_at, excluded.started_at),
        first_model_start_at = coalesce(turn_usage.first_model_start_at, excluded.first_model_start_at),
        first_token_at = coalesce(turn_usage.first_token_at, excluded.first_token_at),
        completed_at = coalesce(excluded.completed_at, turn_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, turn_usage.duration_ms),
        time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn_usage.time_to_first_token_ms),
        model_request_count = excluded.model_request_count,
        model_retry_count = excluded.model_retry_count,
        tool_call_count = excluded.tool_call_count,
        tool_error_count = excluded.tool_error_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = coalesce(excluded.error_type, turn_usage.error_type),
        error_code = coalesce(excluded.error_code, turn_usage.error_code)
      `,
  ).run(
    input.sessionID,
    input.turnID,
    input.traceID ?? null,
    input.userMessageID ?? null,
    input.status,
    input.startedAt,
    input.firstModelStartAt ?? null,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    integer(input.modelRequestCount),
    integer(input.modelRetryCount),
    integer(input.toolCallCount),
    integer(input.toolErrorCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    integer(input.computedTotalTokens),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
  );
}

export async function upsertToolUsage(db: DatabaseSync, input: ToolUsageRecord): Promise<void> {
  db.prepare(
    `
      insert into tool_usage (
        id,
        session_id,
        turn_id,
        trace_id,
        tool_call_id,
        tool_name,
        side_effect_scope,
        read_only,
        destructive,
        approval_status,
        status,
        started_at,
        first_output_at,
        completed_at,
        duration_ms,
        time_to_first_output_ms,
        exit_code,
        output_bytes,
        stdout_bytes,
        stderr_bytes,
        truncated,
        retry_count,
        retryable,
        cancelled_by_user,
        error_type,
        error_code,
        error_message
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        turn_id = coalesce(excluded.turn_id, tool_usage.turn_id),
        trace_id = coalesce(excluded.trace_id, tool_usage.trace_id),
        tool_call_id = excluded.tool_call_id,
        tool_name = case
          when excluded.tool_name = 'unknown' then tool_usage.tool_name
          else excluded.tool_name
        end,
        side_effect_scope = coalesce(excluded.side_effect_scope, tool_usage.side_effect_scope),
        read_only = coalesce(excluded.read_only, tool_usage.read_only),
        destructive = coalesce(excluded.destructive, tool_usage.destructive),
        approval_status = coalesce(excluded.approval_status, tool_usage.approval_status),
        status = case
          when tool_usage.status in ('completed', 'error', 'cancelled') and excluded.status = 'running'
            then tool_usage.status
          else excluded.status
        end,
        started_at = min(tool_usage.started_at, excluded.started_at),
        first_output_at = coalesce(tool_usage.first_output_at, excluded.first_output_at),
        completed_at = coalesce(excluded.completed_at, tool_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, tool_usage.duration_ms),
        time_to_first_output_ms = coalesce(excluded.time_to_first_output_ms, tool_usage.time_to_first_output_ms),
        exit_code = coalesce(excluded.exit_code, tool_usage.exit_code),
        output_bytes = max(tool_usage.output_bytes, excluded.output_bytes),
        stdout_bytes = max(tool_usage.stdout_bytes, excluded.stdout_bytes),
        stderr_bytes = max(tool_usage.stderr_bytes, excluded.stderr_bytes),
        truncated = max(tool_usage.truncated, excluded.truncated),
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        error_type = coalesce(excluded.error_type, tool_usage.error_type),
        error_code = coalesce(excluded.error_code, tool_usage.error_code),
        error_message = coalesce(excluded.error_message, tool_usage.error_message)
      `,
  ).run(...toolUsageValues(input));
}

function toolUsageValues(input: ToolUsageRecord): SQLInputValue[] {
  return [
    input.id,
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.toolCallID,
    input.toolName,
    input.sideEffectScope ?? null,
    nullableBoolean(input.readOnly),
    nullableBoolean(input.destructive),
    input.approvalStatus ?? null,
    input.status,
    input.startedAt,
    input.firstOutputAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstOutputMs ?? null,
    input.exitCode ?? null,
    integer(input.outputBytes),
    integer(input.stdoutBytes),
    integer(input.stderrBytes),
    boolean(input.truncated),
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
  ];
}

// 说明：按本地日归桶用固定偏移 tzOffsetMs，dayIndex = floor((started_at + off)/DAY)。
// DST 跨日边界存在最多 1 小时误差，对用量统计可接受。
export async function queryAppUsage(
  db: DatabaseSync,
  input: AppUsageQueryInput,
): Promise<AppUsageQueryResult> {
  const { since, until, tzOffsetMs } = input;
  const DAY_MS = 86_400_000;

  const totals = db
    .prepare(
      `select
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
         coalesce(sum(cache_creation_input_tokens), 0) as cacheCreationTokens,
         coalesce(sum(cache_read_input_tokens), 0) as cacheReadTokens,
         count(*) as modelRequestCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as modelErrorCount,
         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
       from model_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;

  const turnTotals = db
    .prepare(
      `select
         count(distinct session_id) as totalSessions,
         count(*) as totalTurns,
         avg(case when status = 'completed' then duration_ms else null end) as avgTurnDurationMs
       from turn_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;
  const longestSession = db
    .prepare(
      `select coalesce(max(sessionDurationMs), 0) as longestSessionMs
       from (
         select coalesce(sum(case when status = 'completed' then duration_ms else 0 end), 0)
           as sessionDurationMs
         from turn_usage
         where started_at >= ? and started_at <= ?
         group by session_id
       )`,
    )
    .get(since, until) as Record<string, number | null>;

  const toolTotals = db
    .prepare(
      `select
         count(*) as toolCallCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as toolErrorCount
       from tool_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number>;

  const models = db
    .prepare(
      `select
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         count(*) as requestCount
       from model_usage
       where started_at >= ? and started_at <= ?
       group by model_id
       order by totalTokens desc`,
    )
    .all(since, until) as unknown as AppUsageModelRow[];

  const tools = db
    .prepare(
      `select
         tool_name as toolName,
         count(*) as callCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errorCount,
         avg(duration_ms) as avgDurationMs
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by tool_name
       order by callCount desc`,
    )
    .all(since, until) as unknown as AppUsageToolRow[];

  const days = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; totalTokens: number }>;

  const turnDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as turnCount
       from turn_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; turnCount: number }>;

  const toolDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as toolCallCount
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; toolCallCount: number }>;

  // 合并三类按日统计到同一 dayIndex
  const dayMap = new Map<number, AppUsageDayRow>();
  for (const row of days) {
    dayMap.set(row.dayIndex, {
      dayIndex: row.dayIndex,
      totalTokens: Number(row.totalTokens),
      turnCount: 0,
      toolCallCount: 0,
    });
  }
  for (const row of turnDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.turnCount = Number(row.turnCount);
    dayMap.set(row.dayIndex, existing);
  }
  for (const row of toolDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.toolCallCount = Number(row.toolCallCount);
    dayMap.set(row.dayIndex, existing);
  }

  const dayModels = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex, model_id`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as unknown as AppUsageDayModelRow[];

  return {
    totals: {
      totalTokens: Number(totals.totalTokens ?? 0),
      inputTokens: Number(totals.inputTokens ?? 0),
      outputTokens: Number(totals.outputTokens ?? 0),
      reasoningTokens: Number(totals.reasoningTokens ?? 0),
      cacheCreationTokens: Number(totals.cacheCreationTokens ?? 0),
      cacheReadTokens: Number(totals.cacheReadTokens ?? 0),
      modelRequestCount: Number(totals.modelRequestCount ?? 0),
      modelErrorCount: Number(totals.modelErrorCount ?? 0),
      avgTimeToFirstTokenMs:
        totals.avgTimeToFirstTokenMs == null ? null : Number(totals.avgTimeToFirstTokenMs),
    },
    turnTotals: {
      totalSessions: Number(turnTotals.totalSessions ?? 0),
      totalTurns: Number(turnTotals.totalTurns ?? 0),
      avgTurnDurationMs:
        turnTotals.avgTurnDurationMs == null ? null : Number(turnTotals.avgTurnDurationMs),
      longestSessionMs: Number(longestSession.longestSessionMs ?? 0),
    },
    toolTotals: {
      toolCallCount: Number(toolTotals.toolCallCount ?? 0),
      toolErrorCount: Number(toolTotals.toolErrorCount ?? 0),
    },
    models: models.map((m) => ({
      modelId: m.modelId ?? null,
      totalTokens: Number(m.totalTokens),
      inputTokens: Number(m.inputTokens),
      outputTokens: Number(m.outputTokens),
      requestCount: Number(m.requestCount),
    })),
    tools: tools.map((t) => ({
      toolName: t.toolName,
      callCount: Number(t.callCount),
      errorCount: Number(t.errorCount),
      avgDurationMs: t.avgDurationMs == null ? null : Number(t.avgDurationMs),
    })),
    days: [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex),
    dayModels: dayModels.map((d) => ({
      dayIndex: Number(d.dayIndex),
      modelId: d.modelId ?? null,
      totalTokens: Number(d.totalTokens),
    })),
  };
}

export async function queryTaskUsage(
  db: DatabaseSync,
  input: TaskUsageQueryInput,
): Promise<TaskUsageQueryResult> {
  const rows = db
    .prepare(
      `select
         id,
         query_source as querySource,
         status,
         input_tokens as inputTokens,
         output_tokens as outputTokens,
         reasoning_tokens as reasoningTokens,
         cache_creation_input_tokens as cacheCreationTokens,
         cache_read_input_tokens as cacheReadTokens,
         computed_total_tokens as computedTotalTokens,
         provider_total_tokens as providerTotalTokens
       from model_usage
       where session_id = ?
       order by started_at asc, id asc`,
    )
    .all(input.sessionID) as Array<{
    cacheCreationTokens: number;
    cacheReadTokens: number;
    computedTotalTokens: number;
    inputTokens: number;
    outputTokens: number;
    providerTotalTokens: number | null;
    querySource: string;
    reasoningTokens: number;
    status: string;
  }>;

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let modelErrorCount = 0;
  const inputBaselineBySource: Record<string, number> = {};

  for (const row of rows) {
    const rawTotalTokens = Number(row.providerTotalTokens ?? row.computedTotalTokens ?? 0);
    const inputSideTokens = inputSideTokensFromStoredUsage(row);
    const source = taskUsageInputBaselineSource(row.querySource);
    const incrementalInputTokens =
      source === undefined
        ? inputSideTokens
        : Math.max(0, inputSideTokens - (inputBaselineBySource[source] ?? 0));
    if (source !== undefined) {
      // 压缩会让后续 context input 变小；累计消耗不能因此回扣历史，
      // 但 baseline 必须降到压缩后的值，后续新增轮次才能继续按增量计算。
      inputBaselineBySource[source] = inputSideTokens;
    }

    const nonInputTokens = Math.max(0, rawTotalTokens - inputSideTokens);
    const rowOutputTokens = Number(row.outputTokens ?? 0);
    const rowReasoningTokens = Number(row.reasoningTokens ?? 0);
    totalTokens += incrementalInputTokens + nonInputTokens;
    inputTokens += incrementalInputTokens;
    outputTokens += rowOutputTokens;
    reasoningTokens += rowReasoningTokens;
    if (source === undefined) {
      cacheCreationTokens += Number(row.cacheCreationTokens ?? 0);
      cacheReadTokens += Number(row.cacheReadTokens ?? 0);
    }
    if (row.status === "error") {
      modelErrorCount += 1;
    }
  }

  return {
    sessionID: input.sessionID,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    modelRequestCount: rows.length,
    modelErrorCount,
    inputBaselineBySource,
  };
}

function inputSideTokensFromNormalizedUsage(
  inputTokens: number | null | undefined,
  cacheCreationTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
): number {
  const input = integer(inputTokens);
  if (input > 0) {
    return input;
  }
  return integer(cacheCreationTokens) + integer(cacheReadTokens);
}

function inputSideTokensFromStoredUsage(row: {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  computedTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  providerTotalTokens: number | null;
}): number {
  const input = integer(row.inputTokens);
  const cache = integer(row.cacheCreationTokens) + integer(row.cacheReadTokens);
  if (input <= 0) {
    return cache;
  }
  if (cache <= 0) {
    return input;
  }

  const output = integer(row.outputTokens);
  const total = integer(row.providerTotalTokens ?? row.computedTotalTokens);
  if (total > 0) {
    const totalInputDistance = Math.abs(total - (input + output));
    const noCacheInputDistance = Math.abs(total - (input + cache + output));
    if (noCacheInputDistance < totalInputDistance) {
      return input + cache;
    }
  }

  // AI SDK v6 写入的 inputTokens 已经是 total input；历史表里 cache 字段只是 breakdown。
  // task usage 和 compact 基线不能再把 cache read/write 叠到 inputTokens 上。
  return input;
}

function taskUsageInputBaselineSource(querySource: string): string | undefined {
  if (
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  ) {
    return querySource;
  }
  return undefined;
}

function integer(value: number | null | undefined): number {
  // providerTotalTokens 这类旧记录字段可能是 null；adapters 独立 tsc 需要先完成类型收窄。
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function boolean(value: boolean | undefined): number {
  return value ? 1 : 0;
}

function nullableBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : boolean(value);
}
