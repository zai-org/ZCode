# Prompt Snapshot

Status: current behavior. Scope: main sessions (`querySourceForTask(taskType) === "main_turn"`) with a
session store. Subagents and workflow actors do not use a snapshot.

## Purpose

Provider prompt caches match the request prefix byte for byte, in the order tools → system →
messages. Without a snapshot, the system blocks are rendered from the current code on every
request. A new CLI version that changes a prompt section then changes the prefix of every older
session after a cold resume. The snapshot records the system blocks a session sent and keeps
sending them.

Tools are not recorded. Each request sends the tool list prepared from the current registry. MCP
servers connect after the first request can start and can change their tools during a session, so a
recorded tool list cannot stay fixed; a changed tool list changes the cache prefix from the tools
onward.

## Data

One `session_entry` row per session:

- type `runtime/prompt_snapshot`, id `<sessionId>:runtime-prompt-snapshot`, written with
  `touchSession: false` (it does not change the session list order);
- data:

```text
{
  model:  { providerId, modelId }          the session model the snapshot was rendered for
  system: [{ role: "system", content, cacheControl? }, ...]   the leading system messages
}
```

or the tombstone `{ cleared: true }`. The row is overwritten in place. No table changes are needed:
`session_entry.type` is free text and `data` is JSON. Older CLI versions read only the entry types
they know, so they ignore this row.

The snapshot stores no version and no projection flags. Two values that differ per process or per
session are kept out of the system blocks: the ZCode Desktop part (presentation surface, rollout
switch, Gen UI availability) and the Gen UI visualization directory are part of the environment
announcement (see `meta-user-context.md`). The other system content is frozen until compaction by
design, also when a later launch would render it differently: the memory section (memory root and
switch), the identity sentence that the output style selects, and a custom system prompt.

## Reading and writing

The runtime loads the row when it restores a session (cold resume). A read failure or an invalid row
counts as no snapshot and never blocks the restore. A new session starts without one.

- **Use.** A request uses the snapshot when its model has the snapshot's provider id and model id
  (the reasoning level is not compared).
- **Record.** When no snapshot applies, a main-loop request records one if its model is the session
  model selection and the turn is not pinned to an execution model
  (`modelSelectionScope !== "execution"`). The new row replaces the old one.
- **Session model change.** A guide input or an off-peak takeover that changes the session model
  selection is a session model change: the next request records a new snapshot for the new model.
- **Temporary models.** Model fallback, off-peak execution, compaction summaries, memory
  extraction and goal verification never write the snapshot. They use it only when their model is
  the snapshot model.

## System

`rebuildContextPrefix` builds the system messages from the current code, then replaces them with the
snapshot's system messages when the snapshot applies to the model the prefix is built for. The
conversation history therefore carries the frozen prefix, and every request that reads the history
(main loop, compaction, memory extraction) sends the same bytes. Announcements still use the fresh
build result. A record captures the leading system messages of the request that records it.

## Compaction, fork, rewind

- After a successful compaction (manual, auto or reactive) the snapshot is cleared: the runtime drops
  its copy, writes the tombstone, and rebuilds the context prefix of the history and of the entries
  it returns from the current code. The next main-loop request records a new snapshot. A skipped
  compaction and microcompaction keep the snapshot.
- A main session writes the tombstone on every successful compaction, also when the runtime holds
  no copy. A failed read at resume leaves the runtime without a copy while the row still holds the
  snapshot from before the compaction; without the tombstone, the next cold resume would apply that
  system to the window after the compaction.
- A fork copies the parent's current row to the child session (with the child session id). The
  child's system bytes equal the parent's current system. When the fork point is after the parent's
  latest compaction, the child's first request can reuse the parent's cached prefix. When the fork
  point is before that compaction, the copied snapshot belongs to the window after it while the
  child's history belongs to the window before it: the cached prefix matches only if the system did
  not change between the two windows. The fork writes an environment update with the child's own
  visualization directory into the child history, after the copied messages (see
  `meta-user-context.md`).
- Rewind does not change the snapshot.

A system section added by a later CLI version (for example the token budget line, see
`system-prompt-contract.md`) reaches an existing session only after its next successful compaction
or session model change. Until then the session keeps its recorded system bytes; reminders that the
new version adds to the history are appended and do not change the sent prefix.

## Failure and compatibility

- A failed write logs a warning and the request continues.
- Clearing the snapshot and committing the compaction are separate writes. A crash between them
  leaves the old snapshot until the next compaction or session model change.
- Cold hydration reads all session entries, so it decodes one snapshot row per session.
