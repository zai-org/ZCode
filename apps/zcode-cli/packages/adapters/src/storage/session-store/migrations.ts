import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
export type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL } from "./migrations/0020-provider-model-selection.js";
import { SESSION_DATABASE_IDENTITY_MIGRATION } from "@zcode/shared/sqlite-migrations";

import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "./migrations/0021-official-glm-selection.js";
import { BACKFILLED_SESSION_REASONING_MIGRATION_SQL } from "./migrations/0022-backfilled-session-reasoning.js";

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    appVersion: "0.2.0",
    id: "0001_base_session_store",
    touchedTables: [
      "input_history",
      "message",
      "part",
      "permission",
      "session",
      "session_entry",
      "todo",
    ],
    sql: `
      create table if not exists session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        time_compacting integer,
        time_archived integer
      );

      create index if not exists session_project_idx on session(project_id);
      create index if not exists session_workspace_idx on session(workspace_id);
      create index if not exists session_parent_idx on session(parent_id);

      create table if not exists message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists message_session_time_created_id_idx
        on message(session_id, time_created, id);

      create table if not exists part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists part_message_id_id_idx on part(message_id, id);
      create index if not exists part_session_idx on part(session_id);

      create table if not exists todo (
        session_id text not null references session(id) on delete cascade,
        content text not null,
        status text not null,
        priority text not null,
        position integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, position)
      );

      create index if not exists todo_session_idx on todo(session_id);

      create table if not exists session_entry (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        type text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists session_entry_session_idx on session_entry(session_id);
      create index if not exists session_entry_session_type_idx on session_entry(session_id, type);
      create index if not exists session_entry_time_created_idx on session_entry(time_created);

      create table if not exists permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create table if not exists input_history (
        id text primary key,
        project_id text not null,
        session_id text,
        text text not null,
        kind text not null,
        time_created integer not null
      );

      create index if not exists input_history_project_time_idx
        on input_history(project_id, time_created desc, id desc);
      create index if not exists input_history_time_idx
        on input_history(time_created desc, id desc);
    `,
  },
  {
    appVersion: "0.2.0",
    id: "0002_local_setting",
    touchedTables: ["local_setting"],
    sql: `
      create table if not exists local_setting (
        scope text not null,
        scope_id text not null,
        namespace text not null,
        key text not null,
        value text not null,
        schema_version integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(scope, scope_id, namespace, key)
      );

      create index if not exists local_setting_scope_idx
        on local_setting(scope, scope_id);

      create index if not exists local_setting_namespace_key_idx
        on local_setting(namespace, key);
    `,
  },
  {
    appVersion: "0.2.0",
    id: "0003_backfill_permission_local_setting",
    touchedTables: ["local_setting"],
    sql: `
      insert or ignore into local_setting (
        scope,
        scope_id,
        namespace,
        key,
        value,
        schema_version,
        time_created,
        time_updated
      )
      select
        'project',
        project_id,
        'permission',
        'ruleset',
        data,
        1,
        time_created,
        time_updated
      from permission
      where data is not null;
    `,
  },
  {
    appVersion: "0.7.0",
    id: "0004_session_target",
    touchedTables: ["session_target"],
    sql: `
      create table if not exists session_target (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'complete')),
        time_created integer not null,
        time_updated integer not null
      );
    `,
  },
  {
    appVersion: "0.7.0",
    id: "0005_session_target_accounting",
    touchedTables: ["session_target", "session_target_next"],
    sql: `
      create table if not exists session_target_next (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_target_next (
        session_id,
        target_id,
        objective,
        status,
        token_budget,
        tokens_used,
        time_used_seconds,
        time_created,
        time_updated
      )
      select
        session_id,
        target_id,
        objective,
        status,
        null,
        0,
        0,
        time_created,
        time_updated
      from session_target;

      drop table session_target;
      alter table session_target_next rename to session_target;
    `,
  },
  {
    appVersion: "0.11.0",
    id: "0006_input_history_attachments",
    touchedTables: ["input_history"],
    sql: `
      alter table input_history add column attachments text;
    `,
  },
  {
    appVersion: "0.13.0",
    id: "0007_workflow_script_runtime",
    touchedTables: [
      "session",
      "session_task_link",
      "workflow_activity",
      "workflow_definition",
      "workflow_event",
      "workflow_run",
    ],
    sql: `
      alter table session add column task_type text not null default 'interactive';

      create index if not exists session_task_type_idx on session(task_type);

      create table if not exists workflow_definition (
        id text primary key,
        name text not null,
        source text not null check(source in ('builtin', 'user')),
        trusted integer not null default 0 check(trusted in (0, 1)),
        enabled integer not null default 1 check(enabled in (0, 1)),
        script_path text,
        script_hash text not null,
        meta_json text not null,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists workflow_definition_source_idx
        on workflow_definition(source, enabled);

      create table if not exists workflow_run (
        id text primary key,
        definition_id text,
        name text not null,
        kind text not null default 'script',
        parent_session_id text references session(id) on delete set null,
        cwd text not null,
        script_path text,
        script_hash text not null,
        args_json text,
        args_hash text,
        status text not null check(status in (
          'pending',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled'
        )),
        current_phase text,
        budget_total integer,
        budget_spent integer not null default 0,
        stats_json text,
        failure_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer
      );

      create index if not exists workflow_run_parent_session_idx
        on workflow_run(parent_session_id);
      create index if not exists workflow_run_cwd_status_idx
        on workflow_run(cwd, status, time_updated desc);
      create index if not exists workflow_run_definition_idx
        on workflow_run(definition_id);

      create table if not exists workflow_activity (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        parent_activity_id text,
        call_index integer not null,
        call_path text not null,
        attempt integer not null default 1,
        type text not null,
        phase text,
        label text,
        input_hash text not null,
        prompt text,
        opts_json text,
        status text not null check(status in (
          'queued',
          'running',
          'completed',
          'failed',
          'skipped',
          'cancelled',
          'cached',
          'lost'
        )),
        child_session_id text references session(id) on delete set null,
        result_json text,
        error_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer,
        unique(run_id, call_path, attempt)
      );

      create index if not exists workflow_activity_run_status_idx
        on workflow_activity(run_id, status, call_index);
      create index if not exists workflow_activity_child_session_idx
        on workflow_activity(child_session_id);

      create table if not exists workflow_event (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        phase text,
        activity_id text references workflow_activity(id) on delete set null,
        payload_json text,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists workflow_event_run_sequence_idx
        on workflow_event(run_id, sequence);

      create table if not exists session_task_link (
        id text primary key,
        root_workflow_run_id text references workflow_run(id) on delete cascade,
        parent_link_id text references session_task_link(id) on delete cascade,
        activity_id text references workflow_activity(id) on delete set null,
        parent_session_id text references session(id) on delete set null,
        child_session_id text not null references session(id) on delete cascade,
        role text not null,
        depth integer not null default 0,
        path text not null,
        phase text,
        label text,
        agent_type text,
        model text,
        status text not null,
        time_created integer not null,
        time_updated integer not null,
        unique(child_session_id)
      );

      create index if not exists session_task_link_root_workflow_idx
        on session_task_link(root_workflow_run_id, depth, path);
      create index if not exists session_task_link_parent_idx
        on session_task_link(parent_link_id);
      create index if not exists session_task_link_activity_idx
        on session_task_link(activity_id);
    `,
  },
  {
    appVersion: "0.13.0",
    id: "0008_workflow_definition_scope",
    touchedTables: ["workflow_definition"],
    sql: `
      alter table workflow_definition
        add column scope text not null default 'explicit'
        check(scope in ('builtin', 'explicit', 'project', 'user'));
    `,
  },
  {
    appVersion: "0.14.0",
    id: "0009_session_title_metadata",
    touchedTables: ["session"],
    sql: `
      alter table session
        add column title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom'));

      alter table session
        add column title_message_id text;

      alter table session
        add column time_title_updated integer;
    `,
  },
  {
    appVersion: "0.15.0",
    id: "0010_usage_observability",
    touchedTables: ["model_usage", "tool_usage", "turn_usage"],
    sql: `
      create table if not exists model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      );

      create index if not exists model_usage_started_model_idx
        on model_usage(started_at, provider_id, model_id);
      create index if not exists model_usage_session_turn_idx
        on model_usage(session_id, turn_id);
      create index if not exists model_usage_trace_idx
        on model_usage(trace_id);
      create index if not exists model_usage_query_source_idx
        on model_usage(query_source);

      create table if not exists turn_usage (
        session_id text not null references session(id) on delete cascade,
        turn_id text not null,
        trace_id text,
        user_message_id text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_model_start_at integer,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        model_request_count integer not null default 0,
        model_retry_count integer not null default 0,
        tool_call_count integer not null default 0,
        tool_error_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        computed_total_tokens integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        primary key(session_id, turn_id)
      );

      create index if not exists turn_usage_started_idx
        on turn_usage(started_at);

      create table if not exists tool_usage (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        tool_call_id text not null,
        tool_name text not null,
        side_effect_scope text,
        read_only integer check(read_only in (0, 1)),
        destructive integer check(destructive in (0, 1)),
        approval_status text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_output_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_output_ms integer,
        exit_code integer,
        output_bytes integer not null default 0,
        stdout_bytes integer not null default 0,
        stderr_bytes integer not null default 0,
        truncated integer not null default 0 check(truncated in (0, 1)),
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        error_type text,
        error_code text,
        error_message text
      );

      create unique index if not exists tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id);
      create index if not exists tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name);
      create index if not exists tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id);
    `,
  },
  {
    appVersion: "0.15.0",
    id: "0011_session_target_summary_title",
    touchedTables: ["session_target"],
    sql: `
      alter table session_target add column summary_title text;
    `,
  },
  {
    appVersion: "0.15.0",
    id: "0012_session_trace_id",
    touchedTables: ["session"],
    sql: `
      alter table session add column trace_id text;

      create index if not exists session_trace_idx on session(trace_id);
    `,
  },
  {
    appVersion: "0.15.0",
    id: "0013_session_target_active_run_accounting",
    touchedTables: ["session_target"],
    sql: `
      alter table session_target add column active_input_id text;
      alter table session_target add column active_run_started_at integer;
      alter table session_target add column active_run_last_seen_at integer;
    `,
  },
  {
    appVersion: "0.15.0",
    id: "0014_message_part_sequence",
    touchedTables: ["message", "part"],
    sql: `
      alter table message add column sequence integer;
      alter table part add column sequence integer;

      with ordered_message as (
        select
          id,
          row_number() over (
            partition by session_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from message
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_message
        where ordered_message.id = message.id
      )
      where sequence is null;

      with ordered_part as (
        select
          id,
          row_number() over (
            partition by message_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from part
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_part
        where ordered_part.id = part.id
      )
      where sequence is null;

      create index if not exists message_session_sequence_idx
        on message(session_id, sequence, time_created, id);

      create index if not exists part_message_sequence_idx
        on part(message_id, sequence, time_created, id);

      create index if not exists part_session_message_sequence_idx
        on part(session_id, message_id, sequence);
    `,
  },
  {
    appVersion: "0.15.2",
    id: "0015_message_part_sequence_backfill_and_guard",
    touchedTables: ["message", "part"],
    // 背景（16-timeline-authority-plan P0）：0014 backfill 之后仍持续出现 NULL sequence
    // （本机观测 message 1,690 / part 5,933 行，跨 331 sessions），主要嫌疑是旧版本二进制
    // 并存写同一 DB（其 INSERT 不含 sequence 列）。本迁移做两件事：
    // 1. 增量 backfill：只补 NULL 行，序号从各 scope 现有 max(sequence)+1 起、按
    //    time_created/rowid 排——与读路径 fallback（sequence is null 排在非空之后）完全
    //    一致，backfill 前后 hydrate 顺序不变。不能复用 0014 的 row_number-1 写法：
    //    它按全量行编号，混排数据下会与既有 sequence 撞号并把 NULL 行重排到前面。
    // 2. AFTER INSERT 触发器兜底：旧二进制再写入 NULL sequence 时自动补当前 scope 队尾，
    //    从源头阻止新的 NULL 产生；新代码路径 sequence 恒非空，触发器不生效。
    sql: `
      with session_max as (
        select session_id, coalesce(max(sequence), -1) as max_sequence
        from message
        group by session_id
      ),
      ordered_null_message as (
        select
          m.id as id,
          sm.max_sequence + row_number() over (
            partition by m.session_id
            order by m.time_created, m.rowid
          ) as stable_sequence
        from message m
        join session_max sm on sm.session_id = m.session_id
        where m.sequence is null
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_null_message
        where ordered_null_message.id = message.id
      )
      where sequence is null;

      with message_max as (
        select message_id, coalesce(max(sequence), -1) as max_sequence
        from part
        group by message_id
      ),
      ordered_null_part as (
        select
          p.id as id,
          mm.max_sequence + row_number() over (
            partition by p.message_id
            order by p.time_created, p.rowid
          ) as stable_sequence
        from part p
        join message_max mm on mm.message_id = p.message_id
        where p.sequence is null
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_null_part
        where ordered_null_part.id = part.id
      )
      where sequence is null;

      create trigger if not exists message_sequence_autofill
      after insert on message
      when new.sequence is null
      begin
        update message
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = new.session_id
        )
        where id = new.id;
      end;

      create trigger if not exists part_sequence_autofill
      after insert on part
      when new.sequence is null
      begin
        update part
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = new.message_id
        )
        where id = new.id;
      end;
    `,
  },
  {
    appVersion: "0.15.2",
    id: "0016_session_input_ledger",
    touchedTables: ["session_input"],
    // session_input 账本（16-timeline-authority-plan P3）：输入的 durable 生命周期
    // admitted -> promoted / cancelled / discarded。旧实现里队列/唤醒的存在性只在
    // 进程内存（事件日志也是内存的），崩溃即静默丢；账本让「queue 消失但不进
    // history」不可能静默发生，并为输入类 command 提供 durable 幂等。
    sql: `
      create table if not exists session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index if not exists session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.15.2",
    id: "0017_session_input_start_now_delivery",
    touchedTables: ["session_input", "session_input_before_start_now"],
    // 05C：所有 input command 都在执行前落 durable admission，startNow 也需要独立
    // delivery，不能伪装成 queue。SQLite 不能原地修改 CHECK，必须重建表并保全账本。
    sql: `
      alter table session_input rename to session_input_before_start_now;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_start_now;

      drop table session_input_before_start_now;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.15.2",
    id: "0018_session_input_failed_status",
    touchedTables: ["session_input", "session_input_before_failed_status"],
    // Bugfix：fork bundle 提交后 child runtime 仍可能同步启动失败。该输入已经被 parent
    // accepted fact 接受，不能伪装成 cancelled/discarded；新增 durable failed 终态，并通过
    // 重建 CHECK 保证旧库升级后也能写入，重启不会再次消费或改写它。
    sql: `
      alter table session_input rename to session_input_before_failed_status;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_failed_status;

      drop table session_input_before_failed_status;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.16.5",
    id: "0019_dwf_journal",
    touchedTables: ["dwf_run", "dwf_actor", "dwf_artifact", "dwf_node", "dwf_event"],
    // dynamic-workflow 执行引擎的 durable journal（docs/execution-engine.md 的 "Journal & storage"）。
    // legacy 的 workflow_* 表只是模板不是家：dwf_* 自成一套，与既有 workflow 机制彼此独立。
    //
    // 本条是 beta 前把开发期 0019–0030 十二条迁移**压成的单一基线**：四张表一次建齐、形状即
    // 0030 之后的终态。中间态（三次为放宽 CHECK 的整表重建、0028 的删列改名）只存在于
    // 内部预览库里，收敛办法是删掉四张 dwf_* 表并清掉 schema_migration 里的 dwf 记账行，
    // 下次启动由本条重建。beta 之后本条
    // 不可再改：runner 按 checksum 记账，历史迁移只能追加。
    //
    // 只为占住 0019 这个槽位，让
    // staging 后续迁移从 0020 起编号，功能分支合回时 ledger 不会撞号。四张表在功能落地前闲置无害。
    //
    // 几条刻意为之的设计：
    // 1) parent_session_id / session_id 是纯 text，不加 FOREIGN KEY——子代理会话跑在内存
    //    event store 上、没有 session 行，而 runner 开着 pragma foreign_keys = on，真加 FK
    //    会把合法的 journal 记录挡在门外。dwf_* 之外的任何表都不被引用，也不引用它们。
    // 2) dwf_run 没有节点上限 / token 预算列：run 级
    //    token 用量只作观察面，即 spent_tokens。
    // 3) dwf_node 的 unique(run_id, actor_id, actor_seq) 不可实现：putNode 是准入→结算→统计
    //    回填的 upsert，actor 坐标分散在三个可空列上；每子代理的 actor_seq 唯一性由引擎守。
    //    report / artifact 行有行无节点：一次写入、status 恒为 completed、actor 三列全空。
    // 4) 可空列一律「NULL 即缺席」：result_json / name / tool_call_id / args_json /
    //    resumed_from / resolved_model / message_boundary / artifact_id / input_json 都解码成
    //    缺席的键（args_json 解成 `{}`），不存哑值。
    // 5) 索引即查询形状（列序反了就只能全表扫）：
    //    - dwf_run_cwd_idx：按 cwd 枚举历史 run，「cwd 等值 + time_updated 倒序 + limit」。
    //    - dwf_node_artifact_idx：本 run 的产物行与按 id 取带标签的 report 行。
    //    - dwf_event_artifact_idx：看板取数按 journal sequence 分页，取数源是 dwf_event 而不是
    //      dwf_node；表达式索引（SQLite ≥ 3.9）让它不必扫整条 journal。第三列 sequence 不是
    //      装饰——没有它规划器宁可走 unique(run_id, sequence) 的自动索引再逐行筛产物。
    sql: `
      create table if not exists dwf_run (
        id text primary key,
        parent_session_id text,
        cwd text,
        name text,
        script_text text,
        script_hash text,
        args_json text,
        tool_call_id text,
        resumed_from text,
        caps_max_concurrency integer not null,
        spent_tokens integer not null default 0,
        status text not null check(status in (
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled'
        )),
        result_json text,
        failure_json text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists dwf_run_cwd_idx on dwf_run(cwd, time_updated);

      create table if not exists dwf_actor (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        resolved_model text,
        session_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_actor_run_idx on dwf_actor(run_id);

      create table if not exists dwf_node (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        kind text not null check(kind in ('ask', 'world-read', 'world-run', 'report', 'artifact')),
        actor_site_id text,
        actor_ordinal integer,
        actor_seq integer,
        input_hash text not null,
        input_json text,
        status text not null check(status in ('running', 'completed', 'failed')),
        result_json text,
        error_json text,
        stats_json text,
        message_boundary integer,
        artifact_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_node_run_idx on dwf_node(run_id);
      create index if not exists dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

      create table if not exists dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
    `,
  },
  {
    appVersion: "0.16.5",
    id: "0020_provider_model_selection",
    sql: PROVIDER_MODEL_SELECTION_MIGRATION_SQL,
    touchedTables: ["message", "part", "session_entry"],
  },
  {
    appVersion: "0.16.5",
    id: "0021_official_glm_selection",
    sql: OFFICIAL_GLM_SELECTION_MIGRATION_SQL,
    touchedTables: ["session_entry"],
  },
  {
    appVersion: "0.16.5",
    id: "0022_backfilled_session_reasoning",
    sql: BACKFILLED_SESSION_REASONING_MIGRATION_SQL,
    touchedTables: ["session_entry"],
  },
  {
    appVersion: "0.16.9",
    id: "0023_session_soft_delete_outcome",
    previousIds: ["0020_session_soft_delete_outcome"],
    touchedTables: ["session"],
    apply: (db) => {
      const columns = new Set(
        db
          .prepare("pragma table_info(session)")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("time_deleted"))
        db.exec("alter table session add column time_deleted integer");
      if (!columns.has("last_outcome")) db.exec("alter table session add column last_outcome text");
    },
    sql: `
      alter table session add column time_deleted integer;
      alter table session add column last_outcome text;
    `,
  },
  { ...SESSION_DATABASE_IDENTITY_MIGRATION, touchedTables: ["zcode_database_identity"] },
  {
    id: "0025_session_permanent_deletion",
    appVersion: "0.17.1",
    touchedTables: ["session_purge", "session_runtime_presence"],
    apply(db) {
      // 结构已存在但迁移未记账时，只补缺失对象，保留删除凭据和现有触发器。
      // 原 SQL 已发布且参与 checksum，守卫仅用于执行，避免已升级数据库校验失败。
      db.exec(this.sql.replaceAll(/create (table|index|trigger) /g, "create $1 if not exists "));
    },
    sql: `
      create table session_purge (
        session_id text primary key,
        root_id text not null,
        operation_id text not null,
        retained_artifacts text not null,
        workspace_path text not null,
        workspace_identity text,
        state text not null check(state in ('deleting', 'deleted'))
      );
      create index session_purge_root_idx on session_purge(root_id);
      create table session_runtime_presence (
        session_id text not null,
        owner_id text not null,
        process_id integer not null,
        primary key(session_id, owner_id)
      );
      create trigger session_purge_insert_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.id)
      begin select raise(abort, 'session-data.deleting'); end;
      create trigger session_purge_child_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.parent_id)
      begin select raise(abort, 'session-data.deleting'); end;
      create trigger session_purge_update_guard before update on session
      when exists(select 1 from session_purge where session_id=new.id or (new.parent_id is not old.parent_id and session_id=new.parent_id))
      begin select raise(abort, 'session-data.deleting'); end;
      ${["insert", "update"]
        .map(
          (action) => `
        create trigger session_purge_link_${action} before ${action} on session_task_link
        when ${action === "update" ? "(new.parent_session_id is not old.parent_session_id or new.child_session_id is not old.child_session_id) and new.parent_session_id is not null and" : ""} exists(select 1 from session_purge where session_id=new.parent_session_id or session_id=new.child_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
        )
        .join("\n")}
      create trigger session_purge_runtime_guard before insert on session_runtime_presence
      when exists(select 1 from session_purge where session_id=new.session_id)
      begin select raise(abort, 'session-data.deleting'); end;
      ${[
        "message",
        "part",
        "session_input",
        "session_entry",
        "todo",
        "model_usage",
        "session_target",
        "turn_usage",
        "tool_usage",
        "input_history",
      ]
        .flatMap((table) =>
          ["insert", "update"].map(
            (action) => `
        create trigger session_purge_${table}_${action} before ${action} on ${table}
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
          ),
        )
        .join("\n")}
      ${["dwf_run", "workflow_run"]
        .flatMap((table) =>
          ["insert", "update"].map(
            (action) => `
        create trigger session_purge_owner_${table}_${action} before ${action} on ${table}
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
          ),
        )
        .join("\n")}
      ${[
        ["dwf_run", "args_json"],
        ["dwf_run", "result_json"],
        ["dwf_run", "failure_json"],
        ["workflow_run", "args_json"],
        ["workflow_run", "stats_json"],
        ["workflow_run", "failure_json"],
        ["dwf_node", "input_json"],
        ["dwf_node", "result_json"],
        ["dwf_node", "error_json"],
        ["dwf_event", "payload_json"],
        ["dwf_actor", "persona_json"],
        ["workflow_activity", "prompt"],
        ["workflow_activity", "opts_json"],
        ["workflow_activity", "result_json"],
        ["workflow_activity", "error_json"],
        ["workflow_event", "payload_json"],
        ["part", "data"],
        ["message", "data"],
        ["session_entry", "data"],
        ["session_input", "payload"],
        ["session", "revert"],
        ["input_history", "attachments"],
      ]
        .flatMap(([table, column]) =>
          ["insert", "update"].map(
            (action) => `
        create trigger session_purge_reference_${table}_${column}_${action} before ${action}${action === "update" ? ` of ${column}` : ""} on ${table}
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.${column}, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
          ),
        )
        .join("\n")}
    `,
  },
];
