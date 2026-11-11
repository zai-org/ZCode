CREATE TABLE dwf_actor (
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

CREATE TABLE dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

CREATE TABLE dwf_node (
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

CREATE TABLE dwf_run (
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

CREATE TABLE input_history (
        id text primary key,
        project_id text not null,
        session_id text,
        text text not null,
        kind text not null,
        time_created integer not null
      , attachments text);

CREATE TABLE local_setting (
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

CREATE TABLE message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer);

CREATE TABLE model_usage (
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

CREATE TABLE part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer);

CREATE TABLE permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

CREATE TABLE "schema_migration" (id text primary key, checksum text not null, app_version text, "time_applied" integer not null);

CREATE TABLE session (
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
      , task_type text not null default 'interactive', title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom')), title_message_id text, time_title_updated integer, trace_id text, time_deleted integer, last_outcome text);

CREATE TABLE session_entry (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        type text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

CREATE TABLE session_input (
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

CREATE TABLE session_purge (
        session_id text primary key,
        root_id text not null,
        operation_id text not null,
        retained_artifacts text not null,
        workspace_path text not null,
        workspace_identity text,
        state text not null check(state in ('deleting', 'deleted'))
      );

CREATE TABLE session_runtime_presence (
        session_id text not null,
        owner_id text not null,
        process_id integer not null,
        primary key(session_id, owner_id)
      );

CREATE TABLE "session_target" (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      , summary_title text, active_input_id text, active_run_started_at integer, active_run_last_seen_at integer);

CREATE TABLE session_task_link (
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

CREATE TABLE todo (
        session_id text not null references session(id) on delete cascade,
        content text not null,
        status text not null,
        priority text not null,
        position integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, position)
      );

CREATE TABLE tool_usage (
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

CREATE TABLE turn_usage (
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

CREATE TABLE workflow_activity (
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

CREATE TABLE workflow_definition (
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
      , scope text not null default 'explicit'
        check(scope in ('builtin', 'explicit', 'project', 'user')));

CREATE TABLE workflow_event (
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

CREATE TABLE workflow_run (
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

CREATE TABLE zcode_database_identity (
      scope TEXT PRIMARY KEY,
      identity TEXT NOT NULL
    );

CREATE INDEX dwf_actor_run_idx on dwf_actor(run_id);

CREATE INDEX dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);

CREATE INDEX dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

CREATE INDEX dwf_node_run_idx on dwf_node(run_id);

CREATE INDEX dwf_run_cwd_idx on dwf_run(cwd, time_updated);

CREATE INDEX input_history_project_time_idx
        on input_history(project_id, time_created desc, id desc);

CREATE INDEX input_history_time_idx
        on input_history(time_created desc, id desc);

CREATE INDEX local_setting_namespace_key_idx
        on local_setting(namespace, key);

CREATE INDEX local_setting_scope_idx
        on local_setting(scope, scope_id);

CREATE INDEX message_session_sequence_idx
        on message(session_id, sequence, time_created, id);

CREATE INDEX message_session_time_created_id_idx
        on message(session_id, time_created, id);

CREATE INDEX model_usage_query_source_idx
        on model_usage(query_source);

CREATE INDEX model_usage_session_turn_idx
        on model_usage(session_id, turn_id);

CREATE INDEX model_usage_started_model_idx
        on model_usage(started_at, provider_id, model_id);

CREATE INDEX model_usage_trace_idx
        on model_usage(trace_id);

CREATE INDEX part_message_id_id_idx on part(message_id, id);

CREATE INDEX part_message_sequence_idx
        on part(message_id, sequence, time_created, id);

CREATE INDEX part_session_idx on part(session_id);

CREATE INDEX part_session_message_sequence_idx
        on part(session_id, message_id, sequence);

CREATE INDEX session_entry_session_idx on session_entry(session_id);

CREATE INDEX session_entry_session_type_idx on session_entry(session_id, type);

CREATE INDEX session_entry_time_created_idx on session_entry(time_created);

CREATE INDEX session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);

CREATE INDEX session_input_session_status_idx
        on session_input(session_id, status);

CREATE INDEX session_parent_idx on session(parent_id);

CREATE INDEX session_project_idx on session(project_id);

CREATE INDEX session_purge_root_idx on session_purge(root_id);

CREATE INDEX session_task_link_activity_idx
        on session_task_link(activity_id);

CREATE INDEX session_task_link_parent_idx
        on session_task_link(parent_link_id);

CREATE INDEX session_task_link_root_workflow_idx
        on session_task_link(root_workflow_run_id, depth, path);

CREATE INDEX session_task_type_idx on session(task_type);

CREATE INDEX session_trace_idx on session(trace_id);

CREATE INDEX session_workspace_idx on session(workspace_id);

CREATE INDEX todo_session_idx on todo(session_id);

CREATE UNIQUE INDEX tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id);

CREATE INDEX tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id);

CREATE INDEX tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name);

CREATE INDEX turn_usage_started_idx
        on turn_usage(started_at);

CREATE INDEX workflow_activity_child_session_idx
        on workflow_activity(child_session_id);

CREATE INDEX workflow_activity_run_status_idx
        on workflow_activity(run_id, status, call_index);

CREATE INDEX workflow_definition_source_idx
        on workflow_definition(source, enabled);

CREATE INDEX workflow_event_run_sequence_idx
        on workflow_event(run_id, sequence);

CREATE INDEX workflow_run_cwd_status_idx
        on workflow_run(cwd, status, time_updated desc);

CREATE INDEX workflow_run_definition_idx
        on workflow_run(definition_id);

CREATE INDEX workflow_run_parent_session_idx
        on workflow_run(parent_session_id);

CREATE TRIGGER message_sequence_autofill
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

CREATE TRIGGER part_sequence_autofill
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

CREATE TRIGGER session_purge_child_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.parent_id)
      begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_input_history_insert before insert on input_history
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_input_history_update before update on input_history
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_insert_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.id)
      begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_link_insert before insert on session_task_link
        when  exists(select 1 from session_purge where session_id=new.parent_session_id or session_id=new.child_session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_link_update before update on session_task_link
        when (new.parent_session_id is not old.parent_session_id or new.child_session_id is not old.child_session_id) and new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id or session_id=new.child_session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_message_insert before insert on message
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_message_update before update on message
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_model_usage_insert before insert on model_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_model_usage_update before update on model_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_owner_dwf_run_insert before insert on dwf_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_owner_dwf_run_update before update on dwf_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_owner_workflow_run_insert before insert on workflow_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_owner_workflow_run_update before update on workflow_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_part_insert before insert on part
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_part_update before update on part
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_actor_persona_json_insert before insert on dwf_actor
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.persona_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_actor_persona_json_update before update of persona_json on dwf_actor
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.persona_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_event_payload_json_insert before insert on dwf_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_event_payload_json_update before update of payload_json on dwf_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_node_error_json_insert before insert on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_node_error_json_update before update of error_json on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_node_input_json_insert before insert on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.input_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_node_input_json_update before update of input_json on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.input_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_node_result_json_insert before insert on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_node_result_json_update before update of result_json on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_run_args_json_insert before insert on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_run_args_json_update before update of args_json on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_run_failure_json_insert before insert on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_run_failure_json_update before update of failure_json on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_run_result_json_insert before insert on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_dwf_run_result_json_update before update of result_json on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_input_history_attachments_insert before insert on input_history
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.attachments, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_input_history_attachments_update before update of attachments on input_history
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.attachments, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_message_data_insert before insert on message
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_message_data_update before update of data on message
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_part_data_insert before insert on part
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_part_data_update before update of data on part
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_session_entry_data_insert before insert on session_entry
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_session_entry_data_update before update of data on session_entry
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_session_input_payload_insert before insert on session_input
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_session_input_payload_update before update of payload on session_input
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_session_revert_insert before insert on session
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.revert, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_session_revert_update before update of revert on session
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.revert, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_error_json_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_error_json_update before update of error_json on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_opts_json_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.opts_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_opts_json_update before update of opts_json on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.opts_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_prompt_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.prompt, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_prompt_update before update of prompt on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.prompt, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_result_json_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_activity_result_json_update before update of result_json on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_event_payload_json_insert before insert on workflow_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_event_payload_json_update before update of payload_json on workflow_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_run_args_json_insert before insert on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_run_args_json_update before update of args_json on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_run_failure_json_insert before insert on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_run_failure_json_update before update of failure_json on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_run_stats_json_insert before insert on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.stats_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_reference_workflow_run_stats_json_update before update of stats_json on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.stats_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_runtime_guard before insert on session_runtime_presence
      when exists(select 1 from session_purge where session_id=new.session_id)
      begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_session_entry_insert before insert on session_entry
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_session_entry_update before update on session_entry
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_session_input_insert before insert on session_input
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_session_input_update before update on session_input
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_session_target_insert before insert on session_target
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_session_target_update before update on session_target
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_todo_insert before insert on todo
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_todo_update before update on todo
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_tool_usage_insert before insert on tool_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_tool_usage_update before update on tool_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_turn_usage_insert before insert on turn_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_turn_usage_update before update on turn_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;

CREATE TRIGGER session_purge_update_guard before update on session
      when exists(select 1 from session_purge where session_id=new.id or (new.parent_id is not old.parent_id and session_id=new.parent_id))
      begin select raise(abort, 'session-data.deleting'); end;
