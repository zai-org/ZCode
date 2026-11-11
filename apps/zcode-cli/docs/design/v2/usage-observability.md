# Usage Observability

## Goal

Persist long-lived usage facts for `/usage` and local diagnostics. The data answers:

- Daily token usage by provider and model.
- Daily user turn count, similar to an activity heatmap.
- Model latency versus tool latency versus whole-turn latency.
- Cache hit and cache creation token volume.
- Error, retry, cancellation, and context-overflow rates.

Usage observability is not a billing ledger. Model, turn, and tool usage facts are retained
indefinitely, with no automatic age-based deletion on startup, writes, or queries.

## Source Of Truth

`model_usage` is the canonical token source. One row represents one logical model request recorded
at the runtime boundary, including main turns, compact summaries, title generation, target
completion verification, workflow child sessions, and subagents.

`message` and `part` may keep token snapshots for transcript rendering, but `/usage` must not read
them as the canonical source after this migration. `part` is a UI transcript unit, not a billing or
usage unit.

## Token Fields

Persist provider-normalized token fields separately:

- `input_tokens`
- `output_tokens`
- `reasoning_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `provider_total_tokens`
- `computed_total_tokens`

`input_tokens` stores provider-normalized total input. For AI SDK v6 Anthropic
usage this already includes ordinary input, cache-hit input, and cache-write
input. `cache_read_input_tokens` is cache-hit volume and
`cache_creation_input_tokens` is cache-write volume; both stay separate only as
breakdown fields so `/usage` can render cache behavior without hiding it.

`computed_total_tokens` is:

```text
input_tokens + output_tokens
```

`reasoning_tokens` is stored as its own provider detail. It is not added to `computed_total_tokens`
by default because providers may already include it in output totals.

## Tables

### `model_usage`

One row per logical model request. The row includes request identity, query source, model identity,
latency, token split, retry/error flags, and raw usage JSON for later adapter debugging.

### `turn_usage`

One row per user turn. The row aggregates model usage and tool usage for that turn. It is the source
for activity-style turn counts and loop-level latency.

### `tool_usage`

One row per tool call. The row tracks tool name, side-effect metadata, approval status, latency,
output byte counts, truncation, errors, and cancellation flags.

Rollups are intentionally deferred. `/usage` groups facts within the requested time range directly;
if queries grow expensive later, daily rollups can be rebuilt from the retained facts.

## Retention

`model_usage`, `turn_usage`, and `tool_usage` have no retention cutoff. Writing a new fact or
updating an existing fact must not delete older facts, including records older than 30 days or a year.
Closing and reopening the database must preserve the same history.

```text
Runtime usage events → CLI-owned SQLite write/upsert → retained usage facts
                                                    → requested-range aggregation
```

The store exposes no time-based `pruneUsage` operation. Remove the former 30-day constants, automatic
pruning calls, store method, and port capability together. Usage write capability detection must
only require the existing write methods; it must not depend on a removed cleanup method.

Query ranges remain filters, not retention policies: `since=0` includes all retained history, while
7-day and 30-day queries include only their requested windows. No schema migration is needed.
Previously pruned data cannot be restored by this change. Explicit session/data deletion keeps its
existing behavior; indefinite retention means no automatic expiry, not protection from user deletion.

## Write Points

- Runtime writes `model_usage` after every successful `ModelComplete` and after model request
  failures when a request reached the runtime boundary.
- 明确超窗且无有效输出的 finish 在 Adapter 归一为失败；若 provider 已报告 usage，将其保留在
  `model_request_failed.usage`。既有失败记账消费该事实，不添加额外 usage 数组。
  Turn 和 Subagent 汇总计入失败事件的 usage；成功响应仍只从 `ModelComplete` 计入，避免双计。
  记账在 Reactive Compact 前完成，压缩成功、失败、禁用和取消均不得遗漏原请求。
- Runtime writes `turn_usage` at turn completion or turn error.
- Runtime writes `tool_usage` from tool lifecycle events:
  `tool_call_scheduled`, `permission_requested`, `permission_resolved`,
  `permission_denied`, `tool_call_started`, `tool_call_progress`, `tool_call_result`, and
  `tool_call_error`.

All writes must use trace/session/turn identifiers already present in the runtime trace context.
Statistics rows must not store full prompts, full tool input/output, secrets, tokens, cookies, or
private file contents.

## `/usage` Query Shape

Daily model usage:

```sql
select
  date(started_at / 1000, 'unixepoch', 'localtime') as day,
  provider_id,
  model_id,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_creation_input_tokens) as cache_creation_input_tokens,
  sum(cache_read_input_tokens) as cache_read_input_tokens,
  sum(computed_total_tokens) as computed_total_tokens,
  count(*) as model_request_count,
  avg(duration_ms) as avg_duration_ms,
  avg(time_to_first_token_ms) as avg_time_to_first_token_ms
from model_usage
where started_at >= ?
group by day, provider_id, model_id
order by day asc;
```

Daily turn activity:

```sql
select
  date(started_at / 1000, 'unixepoch', 'localtime') as day,
  count(*) as turn_count,
  sum(computed_total_tokens) as computed_total_tokens
from turn_usage
where started_at >= ?
group by day
order by day asc;
```

Tool latency:

```sql
select
  tool_name,
  count(*) as calls,
  avg(duration_ms) as avg_duration_ms,
  sum(case when status = 'error' then 1 else 0 end) as error_count
from tool_usage
where started_at >= ?
group by tool_name
order by calls desc;
```

## Tests

- SQLite migration creates all usage tables and indexes.
- SQLite usage repository retains model, turn, and tool rows older than a year after writes,
  updates, and database reopening.
- All-time queries include historical facts; explicit 30-day queries still exclude them.
- Runtime usage recording works with a store that has no cleanup capability.
- Runtime records main-turn model usage, turn usage, and tool usage.
- Runtime records non-transcript model calls such as session title generation and compact through
  the same `model_usage` path.
