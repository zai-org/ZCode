# On-Demand Session Context

The agent reads another persisted ZCode session only when the current turn needs it.

The `ReadSessionContext` tool was deleted on 2026-11-03. Its uses moved to other entries.
See `docs/architecture/zcode-app-control-design.md` section 0.8.

- Read another session's history: the model calls `ReadSession` with its `sessionId` parameter.
  The model reads the messages itself. No lite model extracts or summarizes them.
- Read archived Feishu/Lark topic text: the text already arrives with the user message as a
  `text/plain` topic-history attachment. No tool reads the old `topicContext` raw text.
- Download a file or image from the topic: the model calls `ReadTopicResource`.

## Goals

- Avoid pre-generating capsules for every session.
- Avoid injecting another full session into the current model context.
- Keep the feature in the agent layer so desktop, web, and remote clients share the same behavior.
- Make `#sess_*` references lightweight UI syntax, not a protocol requirement.

## Session identity compatibility

New ordinary sessions restore the original `sess_${crypto.randomUUID()}` rule:
a random UUID v4 with hyphens, never a command-derived hash or UUID v7.
The UI and Host command factories allocate it once in `createSession.payload`.
Pending-command persistence and transport retries preserve that exact payload;
the Host reserves project ownership under it and the CLI persists the same ID.
Explicit IDs and historical pending payloads are not rewritten. Native creation
and callers without an assigned ID use the same UUID v4 rule.

The 3.16 Host also persisted `session_<32hex>` and `session_<UUID>`. These IDs remain
unchanged in both databases, messages, entries, parent/fork references, mailbox
directories and saved mentions. Reading, resuming or quoting a session must never
regenerate its ID, replace its prefix or search a different ID as an alias.

```text
new command -> allocate sess_<UUID v4> once -> pending payload / retry
            -> Host reserves exact ID -> CLI persists exact ID
persisted sess_ / session_ ID -> exact lookup -> resume / mention / context / mailbox
```

`ReadSession` (its `sessionId` parameter), inline `#` references, Markdown session mentions and mailbox
validation accept both prefixes with the existing safe suffix character set.
The topic-only `current` value was deleted with `ReadSessionContext`. Empty suffixes, path separators and
traversal input remain invalid. Host authority, workspace identity, CLI ownership,
desktop continuous and mobile replayable delivery stay unchanged. Provider
attribution retains its existing output for historical IDs; it does not rename
stored identities.

Acceptance: create a new `sess_<UUID v4>` task; seed both historical formats in an isolated
profile; completely restart Electron/Host/Agent; open, quote and read each original
ID; send a follow-up; restart again and verify histories and IDs remain unchanged.
CLI regression tests check exact store lookup, deduped mixed-prefix references and
mailbox path isolation. Desktop and mobile share the mention/parser and CLI
contracts; their interaction evidence is recorded separately.

### Old-client create retries

Clients that omit `payload.sessionId` use the same UUID v4 generator. Host stores
`(workspace_key, client_id, command_id) -> session_id` in
`session_creation_commands`, atomically with the task reservation. Sequential
retries, simultaneous requests and replay after reopening the database use the
first ID. The mapping is an allocation receipt, not a command ACK: CLI remains
the owner of admission, execution and durable command results. Distinct logical
commands retain globally unique command IDs, as required by CLI deduplication;
Host workspace/client scoping does not change that protocol invariant.

The additive migration creates only this table. Existing task/session IDs and
conversation rows are not rewritten. For an old command with no receipt, Host
checks whether the original 3.16 deterministic `session_<32hex>` task exists in
that exact workspace. If present, it records that ID without changing the task;
otherwise it allocates a new `sess_<UUID v4>`. The hash is lookup-only.

A conflicting explicit ID for an existing command is rejected. Failed project
validation rolls back both reservation and receipt. Receipts survive task purge;
replay cannot recreate a purged reservation. Native requests without a command
identity still use ordinary UUID allocation. CLI restart keeps its existing input
safety rule: promoted input returns its prior result; admitted but unexecuted
input is discarded and requires confirmation, never silently executed twice.

User-confirmed resend is a new logical command. When consuming a saved
`createSession` replay, discard its `payload.sessionId`; the new envelope allocates
a new UUID v4. This also applies to recovery entries persisted before the fix.
Transport retries retain the original envelope and ID. A discarded first input
remains attached to its original session; only the confirmed new command executes.

Controller remote workspace identity migration moves allocation receipts in the same transaction as
tasks. Identical receipts at both keys collapse; conflicting session IDs abort the
whole migration. Receipt-only workspaces (including purged tasks) must be included.

Receipts have no implicit expiry: they remain for the lifetime of the organization
database, including for clients with explicit IDs. Each logical creation stores one
four-ID row; retries add no rows and no message content is stored. This intentional
retention prevents purged tasks from being recreated and rejects a different ID for
the same command. Removing modern-client receipts or introducing a TTL would change
those guarantees and requires a separate retention policy.

Acceptance also covers durable admission followed by process exit before execution,
restart reconciliation to `inputDiscardedOnRestart`, and the actual banner Resend
button on desktop and mobile: accepted ACK, a different UUID v4 and exactly one promoted session input.
A migration fixture reserves a legacy-client command, rekeys its workspace, reopens
the database and retries the same command; it must return the original ID. Duplicate
and conflicting receipts, receipt-only tombstones and transaction rollback are checked.

```text
same workspace + client + command
  -> Host BEGIN IMMEDIATE
     existing receipt -> exact session ID
     no receipt -> existing 3.16 task OR new UUID v4
     reserve task + record ID -> COMMIT
  -> CLI command dedup -> accepted / duplicate / existing restart outcome
```

Acceptance adds duplicate and concurrent requests without an assigned ID,
independent SQLite connections, full Host/CLI restart replay, and a restart
between reservation and CLI delivery. Check one reservation/session/input,
stable IDs, unchanged CLI rows across replay and unchanged legacy Host rows during
allocation/migration. Normal restart may refresh Host CLI-fact cache timestamps;
identity and organization fields must remain unchanged. Also check command/workspace/client
isolation, explicit-ID conflicts, validation rollback and no resurrection after
purge. Empty drafts retain the existing CLI lifecycle; allocation alone does not
claim a message ran or a durable execution ACK exists.

## Flow

1. The current user prompt may mention a prior session, for example `#sess_abc`.
2. The runtime injects a small current-turn reminder. The reminder tells the model to read the referenced session with `ReadSession` and its `sessionId` parameter.
3. The model calls `ReadSession` only if it needs that history.
4. `ReadSession` returns the session status or a page of visible messages. No lite model extracts or summarizes them.

## Retired ReadSessionContext behavior

These parts were deleted with the tool on 2026-11-03:

- The `relevant` and `handoff` strategies and their lite-model extraction. Use `ReadSession` with `sessionId`.
- The `topic` strategy for raw topic text and the old `topicContext` compatibility read. The topic-history attachment carries this text.
- The `topic` strategy with `attachment`. Use `ReadTopicResource`.
- The fixed five-minute tool timeout and the `read_session_context_*` model-call telemetry.

Old sessions that already contain `ReadSessionContext` tool calls still render with the existing read-only renderer.
