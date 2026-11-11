# Execution engine (spec)

Status: implemented. This document covers everything between a submitted workflow script and a settled run; `docs/analysis.md` covers what the compiler learns about the script before it runs, and the three documents under `docs/dynamic-workflow/` (`authoring.md`, `concurrency.md`, `transcript-and-notifications.md`) cover the author-facing facade, the model-request governor, and what the app and the main agent render.

## Scope and siblings

The engine takes a script that has passed the analyzer, runs it inside a sandbox, turns each facade call into a durable step, drives the subagents that answer `ask` calls, and ends the run in one of three terminal states. Several neighbouring subjects are owned elsewhere and are cited here rather than repeated.

| Subject | Owner |
| --- | --- |
| The facade the author writes against: `agent`, `ask`, `files.*`, `git.*`, `world.run`, `report`, `artifact.*`, `phase`, `log`, prompts, the snippet service, "Usage, not budget" | `docs/dynamic-workflow/authoring.md` |
| Compile-time analysis: sites, the actor graph, control flow, diagnostics | `docs/analysis.md` |
| Admission of model requests, the governor, the retry budget, the model-error policy table, the stall clock, the driver's transient redrive | `docs/dynamic-workflow/concurrency.md` |
| Every sentence the main agent or the user reads: `<task-notification>`, the provider-stop `<error>` block, stall and escalation texts, delivery guidance, how the GUI renders a run | `docs/dynamic-workflow/transcript-and-notifications.md` |

The split with `concurrency.md` is exact: that document owns how a request is retried and how the governor decides a failure is not recoverable; this document owns what the run does once the driver has decided so (stop with `provider`, fail the node with `ContextLimit`, or redrive the turn).

## Terms

| Term | Meaning |
| --- | --- |
| Run | One execution of one script under one `runId` (`dwfrun-<uuid>`). The run id is also the background task id and the cancel work id. |
| Site | A facade call in the script, identified by a compile-time `siteId` such as `ask#3` or `agent#1`. |
| Hole | A `hole<T>()` site: a typed gap the main agent fills with code while the run waits at it. Open until filled; a filled hole is part of the effective script (see "Holes"). |
| Instance | One dynamic occurrence of a site, `siteId@ordinal`; the ordinal counts occurrences of that site within the run, starting at 0. |
| Subagent | The runtime session behind an `agent(...)` value. Code identifiers keep the older word `actor`; prose uses subagent. |
| Ask | One `x.ask(...)` instance: a message to a subagent and the result it settles with. |
| World read | A journaled call into the workspace: `files.*`, `git.*`, or `world.run`. |
| Node | The journal row for one instance of an ask, world read, `world.run`, `report`, or artifact publish. |
| Journal | The durable record of a run: `dwf_run`, `dwf_actor`, `dwf_node`, `dwf_event`. |
| Settlement | The moment a run reaches a terminal state; also the record of how it ended. |
| Artifact (settlement) | The script's top-level return value, `RunSettlement.artifact`. Distinct from the user-facing artifacts of `artifact.*`, which `authoring.md` owns. |

## The shape of a run: three boundaries

The engine is split along three boundaries. Each is a small typed interface, and each has exactly one production implementation and one test double.

| Boundary | Direction | Interface | Production side |
| --- | --- | --- | --- |
| A, the host API | script → engine | `WorkflowHostApi` | The sandbox child speaks NDJSON to the harness, which calls the engine. |
| B, the driver port | engine → world | `WorkflowDriver` downward, `WorkflowReportSink` upward | The bootstrap driver, backed by `AgentRuntime` sessions, the file-system and execution ports, and the artifact store. |
| C, run events | engine → observers | `RunEvent` | Every event is appended to `dwf_event`, then handed to `driver.emit`, which the run service turns into a `DynamicWorkflowRunProgress` session event. |

The engine core between A and B is pure: it owns state and decisions, performs no I/O of its own except through the journal port, and is deterministic given the same script, arguments, and driver answers. That property is what makes resume by replay possible.

```ts
export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  report(siteId: string, item: unknown, artifactId?: string): void;
  enterPhase(name: string): void;
  hole(siteId: string, name: string, prompt?: string): Promise<{ code: string }>;
  publishArtifact(siteId: string, op: string, args: unknown[]): Promise<ArtifactRef>;
  declareArtifact(siteId: string, op: string, args: unknown[]): void;
  log(message: string): void;
}
```

## From script to sandbox input: lowering

Lowering runs after the analyzer has accepted the script. It works in two passes over the same TypeScript source file: the first rewrites facade calls by `ts.Node` identity, using the site table the analyzer produced, so that every rewritten call carries the exact `siteId` the analyzer assigned; the second calls `ts.transpileModule` targeting ES2022. The output is `{ code, siteIds }`, where `code` is the body of an async function whose single parameter is the host binding `__host`.

| Facade form | Lowered form |
| --- | --- |
| `agent(name?, persona?)` | `__host.createActor(siteId, name?, persona?)` |
| `x.ask<T>(message)` | `__host.ask(siteId, x, message)`; an optional chain on `x` keeps its nullish guard |
| `files.glob/read/grep(...)`, `git.changedFiles/diff/status/log(...)`, `world.run(...)` | `__host.worldRead(siteId, op, [args...])`, with `op` taken from the world-read registry |
| `report(item, tag?)` | `__host.report(siteId, item, tag?)` |
| `artifact.file(...)`, `artifact.markdown(...)` | `__host.publishArtifact(siteId, op, [args...])` |
| `artifact.chart(...)` and the other declared kinds | `__host.declareArtifact(siteId, op, [args...])` |
| `phase("name")` | `__host.enterPhase("name")`; no site; a missing name lowers to `void 0` |
| `hole<T>(name, prompt?)`, open | `__host.hole(siteId, name, prompt?, (__src) => eval(__src))`: the last argument is an evaluator emitted **at the site**, so its `eval` is direct and runs in the hole's lexical scope (see "Holes") |
| `hole<T>(name, prompt?, body)`, filled | `__host.hole(siteId, name, prompt?, (__src) => eval(__src), async () => { …lowered body… })`; the cell calls the body and sends nothing. Lowering also returns `holeBodies`, each filled hole's body arrow as printed, type-erased text `(async () => { … })`: the text a live fill evaluates |
| `model("name")` | `"name"`: the argument itself. A `ModelRef` exists only in the type system, so at run time it is its name string and needs no host call; no site. A missing argument (which 9010 rejects first) lowers to `void 0` |
| `channel<T>(name?)` | `__host.channel(name?)`; no site: the queue is built inside the cell |
| `future(body)` | `__host.future(body)`; no site: the cell calls `body` at once and returns its promise |
| `log(message)` | `__host.log(message)` |
| a read of the facade `args` | `__host.args` |

The world-read registry is a single table `(container, member) → op` in `src/facade/registry.ts`; the analyzer's site collection, its facade-misuse diagnostics, and lowering all read it, so adding a primitive is one row. The key carries the declaring container because `git.log` and the top-level `log()` share a member name. The `WorldReadOp` union is derived from the table.

| Container | Member | `op` |
| --- | --- | --- |
| `files` | `glob`, `read`, `grep` | `glob`, `read`, `grep` |
| `git` | `changedFiles`, `diff`, `status`, `log` | `git-changed-files`, `git-diff`, `git-status`, `git-log` |
| `world` | `run` | `run` |

Site ids are stable across the analyzer, lowering, the journal, and the GUI, because all of them read the one site table.

## The sandbox

### Process and entry file

The lowered code runs in a separate Node process. Before spawning, the harness writes an entry file at `<cwd>/.zcode/workflow-runs/<runId>.mjs` that embeds the lowered code and the JSON-encoded arguments; the directory gets a `.gitignore` containing `*`, written once with the exclusive flag. When that directory cannot be written, the file falls back to `<os.tmpdir()>/zcode-workflow-runs/` and the harness reports the fallback through `onWarning`. The entry file exists because the payload once travelled on the command line, and Windows rejects an argument vector longer than 32,767 characters.

The child is started as `node --max-old-space-size=256 <entry>` in development, or as `[...argsPrefix, <entry>]` when the CLI is a single-executable build, where the prefix is the CLI binary itself with `__zcode-dwf-child`; the environment carries `ELECTRON_RUN_AS_NODE=1` so the same spawn works under the desktop shell. The entry file self-starts only when `realpath(argv[1])` is the file itself, so importing it by accident does nothing. If the spawn fails synchronously, the run settles at once as `stopped(interrupted)` with the failure `Interrupted: Could not start the workflow sandbox process: <cause>`.

### The vm cell

Inside the child, the code runs in a `vm.createContext` built from a null-prototype object, so the cell's global inherits nothing from the outer realm. The outer realm puts four values on it: two strings, `__argsJson` and `__runJson`, and two host functions, `__send(line)` and `__finish()`. The bootstrap's first statement moves both functions into a closure and deletes them from the global, before any other code runs. The script therefore never holds a function from the outer realm.

The realm boundary holds these rules:

- Only strings cross from the cell to the outer realm. The cell-side wrapper passes `__send` a string and catches anything the host function throws. It then throws a context-native `Error` instead, because a host error (a stack overflow on entry, for example) would carry the outer realm's `Function` constructor. The host side writes a line only when it receives a string and never coerces any other value.
- The outer realm calls the cell only through `__deliver`, `__checkStalled` and `__execute`. It reads them once, after the bootstraps and before the lowered body is compiled, and calls them unbound. A script that reassigns them changes nothing, and no host object is passed as `this`.
- No promise crosses the boundary. The outer realm does not call `then` on the promise that `__execute` returns, because the script can replace `Promise.prototype.then` and receive the host callbacks. Instead, `__execute` catches everything and calls `__finish` once, at its end.

The facade object `__host` is built inside the cell. Node `vm` is still not a security boundary. These rules close the known ways out of the realm, but they do not make the cell a sandbox for untrusted code. `args` is `Object.freeze(JSON.parse(__argsJson))`, a shallow freeze. Three sources of non-determinism are banned and throw: `Date.now`, `new Date()` without arguments, and `Math.random`; dynamic `import()` throws as well. Everything the script can observe about the world therefore comes through Boundary A and is journaled.

**Holes are evaluated in the cell, at the site.** `__host.hole(siteId, name, prompt, evaluate, body?)` with a `body` calls it and sends nothing. Without one it looks in the cell's fill table — a site filled earlier in this life and reached again — and otherwise sends `request {type: "hole", siteId, name, prompt}` and parks the promise; a parked hole is a request in flight, so the stall detector does not fire and every other branch keeps running. The answer `{code}` is stored by site id and handed to `evaluate`, whose direct `eval` produces an async function closed over the bindings the author's code has at that point, `__host` included; the shim calls it and settles the hole with its result. The evaluator is created anew at every reach, which is what gives a hole in a loop each iteration's bindings. `eval` and `Function` are bound to the context's globals as the spec allows, and the runtime bans apply inside the body as everywhere else.

**Channels and futures live in the cell** (`docs/dynamic-workflow/authoring.md`, "Streams"). `__host.channel(name?)` builds a context-native object: an item queue and a receiver queue, both arrays read through a head index so that neither `send` nor a receive is ever a shift over the buffer; the buffer is compacted once the consumed prefix outgrows the live part. `send` hands the item straight to the longest-waiting receiver when one is parked, otherwise appends; `close` resolves every parked receiver with the end marker and makes later sends throw a `ChannelClosed` error whose message names the channel. The async iterator serves buffered items through already-resolved promises and parks only on an empty, open channel. `__host.future(body)` calls `body` synchronously and returns its promise, turning a synchronous throw into a rejection. Neither crosses the wire: nothing is journaled, nothing is emitted, and a replayed run reproduces every delivery because the order of host settlements is what it depends on.

**The stall detector** is the cell's one asynchronous self-observation. The cell counts requests in flight (`__pending`) and receivers parked on channels. The outer realm calls its captured `__checkStalled` from a `setImmediate` scheduled after `__execute` starts and after every delivered response line, which is the first moment at which every continuation the response could have triggered has run, because the realm has no timers and no I/O of its own. If the script has not completed and no request is in flight, nothing can ever wake it: the cell emits an error `complete` (`ChannelDeadlock`, naming each channel with waiting receivers and their count, when receivers are parked; `ScriptStalled` otherwise) and the outer realm closes its reader. `__complete` is idempotent, so a script that could somehow complete afterwards emits nothing more. The detector has no timeout and no heuristic: it fires exactly when the run has provably nothing left to do.

### Wire protocol

The child and the harness exchange newline-delimited JSON over stdio.

| Direction | Message | Meaning |
| --- | --- | --- |
| child → parent | `create-actor` | `agent(...)` was called. Handled synchronously: the harness maps the child's local handle `local#N` to an engine `ActorId` before any later message can refer to it. |
| child → parent | `request` with `ask`, `world-read`, or `publish-artifact` | A promise-returning facade call. The harness answers with a `response`. |
| child → parent | `request` with `hole` | The script reached an open hole (`siteId`, `name`, `prompt?`). The harness answers with a `response` whose value is `{code}` once the main agent has filled it; the branch is parked until then, siblings run on. |
| child → parent | `event` with `log`, `report`, `declare-artifact`, or `phase-entered` | A fire-and-forget facade call; dispatched synchronously in order. |
| child → parent | `complete` | The async function body returned (`ok: true`, with the value) or threw (`ok: false`, with name, message, stack). |
| parent → child | `response` | Resolves or rejects one `request`. A rejection carries `code`, `message`, and where present `violations` and `finalText`, so the script's `catch` sees the same `WorkflowError` shape the engine raised. |

### How the bridge settles the run

| What happened at the process boundary | Run outcome |
| --- | --- |
| `complete` with `ok: true` | `engine.complete(value)` |
| `complete` with `ok: false` | `engine.fail(DriverError <script's message>)`, unless the engine has already recorded a run-level failure, in which case that earlier failure wins |
| the cell's stall detector fired | the same path: an error `complete` named `ChannelDeadlock` or `ScriptStalled`, so the run ends `failed` with a message that names the waiting channels ("The vm cell") |
| The abort signal fired | `engine.stop("model")` if the signal's reason is `"model"`, otherwise `engine.stop("user")` |
| A wall-clock timeout, when the caller set one | `stopped(interrupted)`; production sets no timeout |
| A malformed NDJSON line | `stopped(interrupted)` |
| The child exited before `complete` | `stopped(interrupted)`, with the last 64 KB of stderr as the cause |

After settlement the harness closes the child's stdin and lets it exit; if it does not, it is killed.

## The engine core

### Identity: sites, ordinals, phases

Every facade call the engine sees carries a `siteId`. The engine assigns the next ordinal for that site (an arrival counter, which is why a resume replays the first life's settle order — see "Replaying the settle order") and stamps the instance with its birth phase, so a node or subagent created in phase "review" carries `phaseName: "review"` on its `actor-created` or `node-queued` event, and on a cached `node-settled` during replay. `enterPhase` trims the name, ignores an empty one, keeps a per-name ordinal, and emits `phase-entered {name, ordinal}`.

The birth phase is **lexical first, dynamic second**. `EngineConfig.sitePhases` is the compile product's table of site id to phase name, derived by `collectSitePhases` from the same interpretation the confirmation graph is projected from: a site is in the table when every issue of it in the trace falls in one named phase. A minted instance takes that phase when its site is listed and the phase current at the call otherwise (a helper called from two phases, a call before the first marker, a run whose compile product predates the table). Two concurrent stages, each a future opening with its own marker, therefore stamp their own steps even though the engine's current phase is whichever marker ran last, and what the run pane shows agrees with the graph the user approved. `phase-entered` is unchanged: it still announces each marker as control passes it.

### Journal decisions and the input hash

Each instance has an `inputHash`: FNV-1a over the canonical JSON of its input. For an ask it is the instructions alone (the subagent is fixed by the ask's position in its FIFO); for a world read it is `{op, args}`; for a `report` it is the item alone. The hash is what replay compares against. When a replayed instance's hash differs from the journaled one, the run fails with `InputHashMismatch` and the message names the instance and both hashes: the script is not deterministic, so the journal cannot be replayed. The error carries `mismatch: {expected, got}`.

A node row is written when the instance goes live (`status: "running"`), and again when it settles (`completed` with `result`, or `failed` with `error`). Ask rows carry the subagent's site and ordinal and the `actorSeq`, the position of the ask in that subagent's own sequence. World-read rows carry a bounded copy of the input, `{op, args, truncated?}`, capped at 4,096 bytes, for display only; the hash is computed over the unbounded input.

### Per-subagent FIFO and the hold rule

A subagent answers one ask at a time. Asks to the same subagent queue in the order the script issued them, and the queue position is the journaled `actorSeq`. On replay, an ask whose journal row exists is held in a recorded queue keyed by its sequence and drained before any live ask on the same subagent is admitted; this hold rule keeps a replayed run from interleaving cached answers with live ones and so keeps the subagent's transcript in the order it was first produced.

Across subagents, the engine admits at most `caps.maxConcurrency` live asks at once. The cap comes from the run record and is the only concurrency decision the engine makes; it is not fixed for the life of the run, because `setMaxConcurrency(n)` retunes it in place on a live run (see "Retuning the cap of a live run"); the admission of individual model requests beneath it belongs to the governor, described in `docs/dynamic-workflow/concurrency.md`. The engine surfaces the governor's observations as `node-waiting`, `node-executing`, and `concurrency-changed` events without acting on them.

When an ask is admitted live, the engine writes the running row, emits `node-queued`, and lazily creates the subagent session if it does not exist yet. A failure to create the session settles the ask as `DriverError: Failed to create the subagent session: <cause>`.

### Retuning the cap of a live run

`setMaxConcurrency(n)` moves the run's own bound while the run is alive. A change that touches only `max_concurrency` is the one amendment that needs no successor: the run keeps its id, its in-flight asks settle where they are, and nothing is superseded. The call returns whether it changed anything, and both no-ops — the run has settled, or `n` equals the current bound — write nothing and emit nothing, so a caller that lost the race against settlement can fall back to a real amendment.

When it does change something, three things happen in one synchronous step and therefore never disagree: the engine replaces its `caps`, writes `caps_max_concurrency` through `updateRunCaps`, and records `run-caps-changed {runId, caps, previous}`. The scheduler reads the bound afresh on every dispatch, so a lower value simply stops admitting; it recalls nothing, and asks already in flight run to their end. A raise also pumps the scheduler once, because nothing else would: the queued asks would otherwise wait for the next settlement.

Resolving the value belongs to the caller — `null` means the default parallelism, a host fact (derived from the machine's core count) the engine neither sees nor should. The engine normalizes only what it is about to store, flooring to an integer of at least 1 and refusing a non-finite value, on the same grounds as `inheritedTokens`: the number lands in an `integer not null` column. Because resume replays the row's `caps`, the new bound survives a crash and a resume; the event is an observation of the command, not its source of truth.

### Usage accounting

The driver reports `askStats {tokens, toolCalls, turns}` after every model turn. The engine adds the tokens to the run's `spentTokens`, writes the run row, and emits `usage-updated {spentTokens}`; after the run has settled it still writes the journal but emits nothing. Stats reported for an ask that already settled are backfilled onto its row. There is no budget and no cap: the number is telemetry, shown on the completion card and in the run detail (`authoring.md`, "Usage, not budget").

`spentTokens` is the cost of the run's whole lineage, not of one life or one revision. A new run starts from `inheritedTokens` on its config, the settled predecessor's `spentTokens`, which the run service hands in on the amend path (see "Usage across the lineage" under "Amend-resume"); a fresh run has none and starts at zero. A resumed run restores the row's value. In both cases, whenever the restored or inherited total is non-zero the engine emits `usage-updated {spentTokens}` right after `run-started` (after `run-launched` when that fires), so the projection, whose `run-started` resets usage, shows the carried total before the first live turn instead of zero. A zero total emits nothing: the reset already says zero.

### Events

Every event goes through one function, `record`: append to `dwf_event`, then hand the same object to `driver.emit`. The order and the object identity are load-bearing; the run service captures the sequence the journal assigned and attaches it to the progress payload.

| Event | Payload | When |
| --- | --- | --- |
| `run-started` | `runId`, `caps` | Constructor, on a fresh run and on every resume |
| `run-launched` | `inputId`, `toolCallId?`, `parentSessionId?`, `phaseNames?`, `subagentModel?`, `subagentPermissionMode?`, `modelBindings?` | Once, right after the first `run-started` of a run's life; never on resume (see "Token telemetry for subagents"). `phaseNames` is the script's declared phase table in order (≤ 32 × 128), holes included by name in their place, handed in by the submitter so the sidebar rail can draw the stations ahead of the run (`docs/dynamic-workflow/presentation.md`, "The sidebar run line"); `holes?` lists the indexes into it that are open holes, aligned like the alongside table, so the rail draws them dashed. `subagentModel` is the model the run's subagents work on, canonical `providerId/modelId[$reasoningLevel]`, also handed in by the submitter (see "Subagent sessions"). `modelBindings` maps each model name the script uses, as the script spells it, to its canonical string; it is resolved before the run starts (`docs/dynamic-workflow/launch.md`, "Models the script names"). `subagentPermissionMode` is the launching session's permission mode (`build`, `edit`, `yolo`, `guarded` or `auto`; plan is not carried); the submitter reads it from the session, the engine never reads it, and resume reads it back to run the subagents in that mode, YOLO when it is absent or unknown (`docs/dynamic-workflow/launch.md`, "Permissions inside a run") |
| `actor-created` | `actor`, `name?`, `persona?`, `phaseName?` | `createActor` |
| `node-queued` | `instance`, `kind`, `actor?`, `actorSeq?`, `phaseName?`, `instructionsHead?` | An instance goes live. `instructionsHead` is on ask nodes only: the first `INSTRUCTIONS_HEAD_MAX_CHARS` = 240 characters of the author's instructions, trimmed, stored without an ellipsis. It is recorded where the scheduler admits the ask, which is before the driver appends its epilogues, so the head is the author's own words and nothing else. It is what lets a reader of a run say *what* a subagent was asked to do rather than only that it is busy (`docs/dynamic-workflow/launch.md`, "`GetWorkflowRun`"); the world-read `node-queued` never carries it |
| `node-dispatched` | `instance`, and on an ask also `kind`, `actor?`, `actorName?`, `actorPhaseName?`, `actorPersonaModel?`, `phaseName?`, `instructionsHead?` | The driver was told to start the ask or world read. An ask's dispatch **repeats its own birth facts**: `kind`, `actor`, `phaseName` and `instructionsHead` are what that instance's `node-queued` carried, and `actorName` / `actorPhaseName` / `actorPersonaModel` are the `name` / `phaseName` / `persona.model` its subagent's `actor-created` carried. They are the instance's own birth stamps, never the phase the run happens to be in when the dispatch is emitted — a queued ask can wait behind the concurrency bound while the script walks on into later phases. Repeating them makes the dispatch a second, self-contained birth, so a reader that lists an instance when it starts running rather than when it is queued can enter both it and its subagent from this one event (`docs/dynamic-workflow/presentation.md`). A world read's dispatch stays bare: it follows its own `node-queued` in the same synchronous slice and has no subagent |
| `node-repairing` | `instance`, `attempt`, `violations` | A typed submit was rejected |
| `node-nudged` | `instance` | A typed turn ended without a submit and the subagent was asked once more |
| `node-waiting` | `instance`, `cause: slot \| backoff`, `reason?`, `attempt?`, `delayMs?`, `retryAfterMs?` | Governor observation |
| `node-executing` | `instance` | Governor observation |
| `concurrency-changed` | the governor's change record | Governor observation |
| `run-caps-changed` | `runId`, `caps`, `previous` | `setMaxConcurrency(n)` changed the run's own bound (see "Retuning the cap of a live run") |
| `node-settled` | `instance`, `outcome: ok \| failed \| cancelled`, `cached?`, `error?`, `phaseName?`, and on a cached ask also `kind`, `actor`, `actorSeq`, `instructionsHead?`, `sourceSessionId?` | The instance ended. A cached settle is the instance's **birth**: no `node-queued` precedes it, so on an ask it repeats the birth facts a `node-queued` would have carried — `kind`, `actor`, `actorSeq`, `instructionsHead` and the `phaseName` stamp — for the reason `node-dispatched` repeats them: a reader that never saw the instance queued must still know whose answer it is. Without them a reader has no subagent to attribute the settlement to, and a subagent whose every ask was a cache hit reads as never started. `sourceSessionId` is present when the answer came from a predecessor's transcript — an amend import hit, or the replay of a row that was one — and names the session holding that exchange (the candidate's `transcriptSourceSessionId`, see "Amend-resume"); it is absent when the answer was produced in this run, whose own session then holds it. A world node's cached settle stays bare: it has no subagent |
| `node-progress` | `instance`, `turn`, `toolCalls`, `lastTool?: {name, target?}` | After each resolved turn of an ask, emitted immediately **before** that turn's `usage-updated` |
| `usage-updated` | `spentTokens` | After each turn |
| `log` | `message` | `log(...)` from the script, and the engine's own notices |
| `import-cache-closed` | `instance`, `cause: mutating-tool \| world-run`, `actorName?` | The first workspace write of an amended run (see "Amend-resume"); at most once per run |
| `phase-entered` | `name`, `ordinal` | `phase(...)` |
| `report` | `instance`, `item`, `artifactId?` | `report(...)` |
| `artifact-published`, `artifact-failed` | see `authoring.md` | `artifact.*` |
| `hole-reached` | `instance`, `name`, `prompt?`, `phaseName?` | The script reached an open hole; no node row (see "Holes") |
| `hole-filled` | `siteId`, `filledAt`, `filledBy?`, `phaseNames`, `holes?`, `scriptPath?` | `fillHole`: the effective script was written and the parked branch released. `scriptPath` is present when the fill minted the run's draft (a run that had none), so a cold read after a restart recovers the path: the last `hole-filled.scriptPath` wins over `run-launched.scriptPath`. `phaseNames` is the effective script's phase table, holes included by name in their place, and `holes` the indexes into it that are still open holes, aligned like the alongside table, so the sidebar rail redraws its stations without the display payload |
| `escalation-raised` | `qid`, `actor`, `actorName?`, `question`, `context?`, `askedAt` | A subagent called `escalate` |
| `escalation-resolved` | `qid`, `answer` | The main agent answered |
| `run-stalled` | `sinceMs`, `reason?`, `cap?` | The driver's stall clock fired |
| `run-settled` | `status`, `stopReason?`, `error?` | Terminal |

A `compaction` event type exists in the union and is never emitted.

### Progress within an ask

`usage-updated` answers "how much has this run spent"; it does not answer "is this subagent moving". `node-progress` does, and it is the only event that says anything about the inside of a turn. The driver reports it through `askProgress` after every resolved `executeTurn`, with `turn` the 1-based count of resolved turns within this ask (nudge rounds count, repair rounds do not — they never end a turn), `toolCalls` the same cumulative per-ask counter that feeds `AskStats.toolCalls`, and `lastTool` the most recent tool call the driver observed on that subagent's session. `lastTool.name` is the tool name (≤ `LAST_TOOL_NAME_MAX_CHARS` = 64) and `lastTool.target` is a short human-readable hint (≤ `LAST_TOOL_TARGET_MAX_CHARS` = 120): the file path for file tools, the head of the command line for `Bash`, absent when the tool's arguments name nothing a reader would recognize. The target is a hint, never the arguments themselves and never file contents — the journal is read by the main agent and shown in the GUI, and a tool's input can hold anything.

The engine core does not interpret the event. `askProgress` is a passthrough to `record(...)`, the same shape as `askStats` → `usage-updated`: it changes no scheduling decision, no `inputHash`, and nothing replay compares, and like every other late driver observation it is dropped once the run has settled. The two events for one turn are emitted in one order, `node-progress` first, so a reader that sees fresh usage has already seen the progress that earned it.

## Ask lifecycle

### States

| State | Entered by | Left by |
| --- | --- | --- |
| queued | `ask` called; waits for the subagent's FIFO and a concurrency slot | admission |
| dispatched | `startAsk` sent to the driver | a submit, a turn end, a failure, or a cancel |
| repairing | a typed submit was rejected (up to `REPAIR_ATTEMPTS = 3` rejections) | the next submit or turn end |
| nudged | a typed turn ended without a submit (`NUDGE_ATTEMPTS = 1`) | the next submit or turn end |
| settled ok | accepted submit, or the final text of an untyped ask | terminal |
| settled failed | `ValidationFailed`, `ResultNotSubmitted`, `ContextLimit`, `DriverError`, `Cancelled` | terminal; the script's `await` rejects with the `WorkflowError` |
| settled cancelled | the run ended while the ask was in flight | terminal |

### Untyped asks

An ask whose type argument is absent or is `string` is untyped. Its result is the subagent's final assistant text. Submits arriving on an untyped ask are not routed to the engine; the driver answers the tool call with a synthetic rejection telling the model to answer in its final message.

### Typed asks and `submit_result`

An ask with a non-string type argument is typed. The subagent must call the `submit_result` tool with a value that conforms to the schema synthesized from the type. The engine decodes leniently: if the submitted value is a string that fails validation, the engine tries one `JSON.parse` and validates the parsed value; violations are reported against the parsed value. On acceptance the ask settles with the value and the turn stops. On rejection the tool call returns an error result listing the violations, one line per violation in the form `<path>: expected <X>, got <Y>`, and the same turn continues so the model can correct itself; the engine emits `node-repairing {attempt, violations}`. After the third rejection the engine cancels the ask on the driver and settles it as `ValidationFailed {violations}`. If the turn ends without an accepted submit, the engine asks the driver to nudge once, a fresh turn on the same session with a fixed prompt; if that turn also ends without a submit, the ask settles as `ResultNotSubmitted {finalText}` with the message "The typed ask ended without a submit_result call, so there is no result."

### Submit profiles

Which `submit_result` a subagent gets is decided at compile time from the actor graph (`docs/analysis.md`, "The site graph"): the set of ask sites each `agent(...)` site can reach and their types.

| Profile | When | Tool declaration |
| --- | --- | --- |
| `untyped` | every ask the subagent can receive is untyped | `submit_result` is not registered |
| `mono` | every typed ask the subagent can receive has one and the same schema | `submit_result` is registered with that schema as its input schema, `strict: true` |
| `generic` | mixed schemas, or the analysis cannot bound the subagent's ask set (any ask site with an empty actor set turns every profile generic) | `submit_result` takes `{ result: unknown }` and the full schema travels in the ask epilogue |

Profiles are keyed by the subagent's site, so every ordinal of one `agent(...)` site shares a profile. The driver applies a runtime guard, `ensureSubmitProfileFits`, on each typed `startAsk`: if a `mono` subagent receives a typed ask with a different schema, the driver re-registers the tool as `generic` for that session, invalidates the tool cache, and logs `dynamic_workflow.submit_profile.mismatch`; if an `untyped` subagent receives a typed ask, the ask fails with a `DriverError` saying the ask-to-actor analysis missed this ask. Both are wiring defects, not authoring errors, and both keep the run alive.

### What the subagent reads

The instructions of an ask are followed by engine text that is not part of the cache identity, because the scheduler computes the `inputHash` before the epilogues are appended. Every ask ends with the quality epilogue (evidence per finding, checks count only when run at the named scale, unknowns stated as such, `escalate` when blocked). A typed ask on a `generic` subagent then carries the schema epilogue: a rule, the instruction to call `submit_result`, the schema as JSON, and the sentence "Pass the conforming JSON as `result`." A typed ask on a `mono` subagent carries one sentence pointing at the tool, since the schema is already in the tool declaration. The driver passes the length of the author's instructions as `epilogueStart`, so the transcript can fold the engine text (`transcript-and-notifications.md`).

### Strict forwarding

The `submit_result` contract declares `strict: true` when it carries a schema. The adapter forwards `strict` only to first-party Claude models on an Anthropic provider, and only when the schema fits the strict subset: constraints that constrained decoding cannot express (`minimum`, `pattern`, non-standard `format`, and the like) are folded into the property's `description`, where the model still reads them and the engine's validator still enforces them; a shape that cannot be expressed at all is sent without `strict`. Other tool details: `concurrentSafe: false`, `stopTurnOnSuccess: true`, a 16,000-byte input limit, no timeout.

### Schema synthesis and validation

The schema of a typed ask is synthesized from the TypeScript type at compile time and validated at runtime by a purpose-built validator over the same subset. The compiler rejects, with diagnostic code 9002, types that have no faithful JSON form: `any`, `never`, `undefined` or `void` outside an optional position, `bigint`, `symbol`, functions, classes, thenables, and the built-ins `Date`, `Map`, `Set`, `Promise`, `Error`, typed arrays and their kin. `unknown` becomes `{}`. Literals become `const`; unions of literals become `enum`, other unions `anyOf`, with at most `MAX_UNION_MEMBERS = 100` members; intersections merge; object types get `additionalProperties: false` unless they declare an index signature; optional properties drop `undefined` from their type; tuples use `prefixItems` with `minItems` and `maxItems`; recursive types go through `$defs` and `$ref`. JSDoc tags on properties become constraints: `@minimum`, `@maximum`, `@exclusiveMinimum`, `@exclusiveMaximum`, `@minLength`, `@maxLength`, `@pattern`, `@format`, `@minItems`, `@maxItems`, `@default`. The same emitter decides whether a `report` item type is serializable. `buildAskSpecs` must cover every ask site; an ask arriving at runtime with no spec is a run-level `MissingAskSpec` failure, a compile-output mismatch.

```ts
interface Violation { path: string; expected: string; got: string }
```

## The driver (Boundary B)

```ts
export interface WorkflowDriver {
  createActorSession(actor: ActorRef, persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef>;
  startAsk(session: SessionRef, instance: InstanceRef, message: { instructions: string; typed: boolean; schema?: unknown }): void;
  respondToSubmit(instance: InstanceRef, verdict: { kind: "accept" } | { kind: "reject"; violations: Violation[] } | { kind: "nudge" }): void;
  cancelAsk(instance: InstanceRef): void;
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  dispose?(): void;
}

export interface WorkflowReportSink {
  askSubmitAttempted(instance: InstanceRef, result: unknown): void;
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  askProgress(instance: InstanceRef, progress: { turn: number; toolCalls: number; lastTool?: { name: string; target?: string } }): void;
  askStats(instance: InstanceRef, stats: { tokens: number; toolCalls: number; turns: number }): void;
  askFailed(instance: InstanceRef, error: WorkflowError): void;
  stopRun(error: WorkflowError): void;            // code ProviderStop
  runStalled(info: { sinceMs: number; reason?: string; cap?: number }): void;
  askWaiting(instance: InstanceRef, info: { cause: "slot" | "backoff"; reason?: string; attempt?: number; delayMs?: number; retryAfterMs?: number }): void;
  askExecuting(instance: InstanceRef): void;
  concurrencyChanged(change: unknown): void;
}
```

`startAsk` never awaits the turn; the driver reports back through the sink. The engine and the driver share a journal and an `emit`, so driver-originated events (escalations) and engine events land in the same `dwf_event` sequence through the same append-then-emit discipline.

`askProgress` and `askStats` are the two reports a resolved turn makes, in that order ("Progress within an ask"). The driver counts the turns of an ask and watches the subagent's session for tool calls in one place, the per-actor activity observer that already counts tool calls for `AskStats` and reports the first workspace write; the last tool's name and its short target are read off the scheduled call's tool name and input, so a tool whose input names nothing recognizable simply has no target.

### Subagent sessions

Each subagent is one persistent child `AgentRuntime`; repeated `executeTurn` calls accumulate its transcript, so a subagent asked three times remembers the first two exchanges. The session id is minted deterministically, `dwf-<runId>-<siteId>@<ordinal>` after sanitizing (`_` becomes `__`, then any character outside `[A-Za-z0-9.-]` becomes `_`). On resume the driver reads the journaled `dwf_actor.session_id` and compares it with the minted id; a difference is a `DriverError` with `mismatch: {expected, got}`, raised before any turn, since a drifted minting rule would otherwise rehydrate the wrong transcript. The journaled id, when present, is used to resume the persisted session from the store; a session the store no longer has starts fresh.

The production runtime for a subagent is configured with the `mode` recorded as the run's `run-launched.subagentPermissionMode`, `"yolo"` when none is recorded (see `docs/dynamic-workflow/launch.md`, "Permissions inside a run"), `taskType: "workflow_child"`, `subagents: { enabled: false }`, the model the precedence below settles on, the shared event store, and an event sink back to the parent session. Its session is persisted before the first turn under the title `workflow subagent <siteId@ordinal>`, with a task link of role `workflow_actor` and path `dwf/<runId>/<siteId@ordinal>`; the journal row records the session id and the resolved `providerId/modelId`.

Four sources can say what model a subagent's session runs on, and they are read in one order: the **persona's `model`**, looked up in the run's `modelBindings` (`docs/dynamic-workflow/authoring.md`, "Choosing a model per subagent"), the **run's `subagentModel`** (journaled on `run-launched`, set by `subagent_model` on the launch tool, `docs/dynamic-workflow/launch.md`), the **resume pin** journaled on `dwf_actor.resolved_model`, and the **parent session's current model**. Only a resume carries a pin, either from this run's own row (crash-resume) or, on the first dispatch of an amend, from the transcript source row found by the lineage walk.

A persona that names a model is the most specific statement there is: it is written for this one subagent, and the user approved its binding in the window. It therefore wins over the run's selection as well as over the pin, whole, reasoning level included, and the table below only applies to subagents whose persona names none. A name the run's `modelBindings` does not bind can come only from a cast around the compiler's rule; it is `WorkflowActorModelUnboundError` at session creation, which fails that subagent's first ask with `DriverError`, never a quiet fallback to another model.

| The run's `subagentModel` | Resume pin | Effect |
| --- | --- | --- |
| set | any, including a malformed one | the subagent runs on the run's selection, whole, reasoning level included; the pin is not parsed; the resolved model is journaled on the new run's `dwf_actor.resolved_model` |
| none | none | the subagent inherits the parent session's model |
| none | equal to the parent session's model | no override recorded |
| none | a different, provider-qualified model | the subagent runs on the pin; the resolved pin is journaled on `dwf_actor.resolved_model` |
| none | an unqualified or unknown model | `WorkflowActorPinnedModelError` at session creation, which fails the first ask with `DriverError` |

**Omission inherits, an explicit value replaces.** `resolveInput` already applies this to `subagentModel` and `max_concurrency` on resume and amend; the pin is the same rule applied to the implicit default. When a run has no `subagentModel`, its subagents' default is not "the parent model as it is now" but "the model this subagent actually ran on last time", and the pin guards that default against the parent session's model drifting between runs. When the run has a `subagentModel`, there is no default to inherit and the pin has nothing to say, which is why it ranks below the run's selection: the pin exists to prevent a *silent* model change of a frozen persona, and an `AmendWorkflow` carrying `subagent_model` is exactly the explicit, user-visible decision the confirmation dialog and the tool output announce as "Subagents run on {model}". Nothing about the switch is silent: the new run's own `dwf_actor` row records the new model while the predecessor's row keeps the old one, so the lineage preserves where the change happened. An amend that omits `subagent_model` copies the predecessor's, so in a consistent chain an inherited selection equals the pin; in a chain the old precedence already made inconsistent, honoring the selection is still what the user asked for. A pin is compared against the parent session's model by identity only (`providerId/modelId`), so a parent whose reasoning level changed still counts as the same model and keeps the stronger "no override" path, which inherits the level. The pin-miss policy below applies only to the no-selection path.

The engine takes no part in any of this. It records the persona's `model` name and never interprets it, and it never reads `subagentModel` or `modelBindings`: the strings travel the host-metadata road, from the run service through the harness into the engine config, and are recorded once on the `run-launched` event beside the launch anchor and the phase names, in the run-creating life only. There is no column for it. The head of the event log is where the host reads it back, which is why a resume, a detail read and a cold replay all recover the same choice for free.

The subagent's tool surface is the parent's minus tools that would let it steer the parent, reach the user past the main agent, or start workflows of its own: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `CreateWorkflow`, `ReadTopicResource`, `ResolveWorkflowQuestion` are removed by the driver, and the child runtime's allowlist additionally excludes `SaveWorkflow` and `ResumeWorkflowRun`. `submit_result` is registered when the runtime was given a submit port, `escalate` when it was given an escalate port; the driver always injects both ports, so every subagent has `escalate`, and every non-`untyped` subagent has `submit_result`. A subagent that needs a person's judgment calls `escalate`; the main agent decides whether to ask the user (`docs/dynamic-workflow/launch.md`, "Permissions inside a run").

**Browser Use.** A subagent can drive the built-in browser (`mcp__node_repl__js` with `agent.browsers`), and it does so under its **own** session id, which the browser backend uses as the tab owner. A subagent gets its own set of tabs, separate from the main agent's and from every other subagent's, in the one browser the window has (`docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`). The storage partition is shared: logins, cookies and local storage are the app's, not the subagent's.

A subagent's session id is not a session the client knows. So the production factory hands its runtime a browser port the parent runtime's port derived for it, `BrowserControlPort.forChildSession({childSessionId, parentSessionId})`. On the ZCode Protocol broker this records the subagent under the launching session, and every browser request of the subagent is sent with the subagent's id as `sessionId` but with the workspace (`workspaceKey`, `workspacePath`, `workspaceIdentity`, `remoteSessionId`) and the `clientMode` of the launching session. A subagent that was never recorded, or whose record was released, is refused with `Session is not active: <id>`: the record is the only thing that lets a non-client session through, so there is no guessing a parent from the id's shape. A port with no `forChildSession`, such as the CLI's headless CDP runtime, does not check sessions against a client, and the subagent uses it as it is.

The record lives exactly as long as the subagent's runtime. The runtime reports each turn end to the port (`turnEnded` cancels that turn's pending requests and leaves the tabs), and closing it (`closeBrowserSession`, on run dispose, see "The four sequences") sends `closeSession` with `closeTabs: true` and then drops the record. `closeTabs` closes every tab the subagent's session owns, the ones it released with `finalize` included: a main session's tabs survive its close because the same conversation can come back and claim them, and no conversation ever comes back as a subagent. The main agent's own Browser Use is untouched by any of this.

An `Agent` subagent (`runtimeScope: "subagent"`) gets a derived port too, but with `tabOwner: "parent"`: its requests are sent with the launching session's id, so it shares the conversation's tabs, the panel reveals the tabs it opens, and its turn ends and run end send nothing to the desktop; the end of a run only drops the record (`docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`). A dynamic-workflow subagent keeps the default `tabOwner: "child"` described above. A legacy `Workflow` child gets none, because nothing closes its runtime to release the record and its tabs.

A subagent's skill port lists the skills the parent's does, including the plugins' (the browser-use plugin's `control-browser` among them), minus the bundled `dynamic-workflows` skill: a subagent cannot start workflows, so teaching it how to write one would only lead it to tools it does not have.

### The four sequences

| Sequence | Steps |
| --- | --- |
| accept | model calls `submit_result` → the handler blocks on the session's submit port → driver reports `askSubmitAttempted` → engine validates and calls `respondToSubmit(accept)` synchronously → the parked promise resolves `{accept: true}` → the tool result succeeds and stops the turn → when the turn resolves, the driver reports only `askStats` |
| reject | same start → `respondToSubmit(reject, violations)` → the parked promise resolves `{accept: false, violations}` → the handler throws → an error tool result in the same turn → the model tries again; after the repair budget the engine calls `cancelAsk` instead |
| nudge | the turn ends without an accepted submit → driver reports `askTurnEnded` → engine calls `respondToSubmit(nudge)` → the driver starts a fresh turn on the same session with the nudge prompt; the exchange is not over until a turn ends without a nudge |
| escalate | model calls `escalate` → the handler blocks on the session's escalate port → the driver mints a `qid`, parks the promise, registers the question, and records `escalation-raised` → the main agent answers through `ResolveWorkflowQuestion` → the driver resolves the promise, records `escalation-resolved`, and the tool result is the answer text; the turn continues in place |

A turn that rejects is triaged: if the ask was cancelled, nothing is reported; if the error is a model-side failure, the model-failure policy decides (see "Terminal states"); otherwise the ask fails with `DriverError: Subagent turn failed: <cause>`. Stats per turn are `tokens = usage.totalTokens`, `toolCalls` = count of tool-call starts, `turns = modelRequestCount ?? 1`.

### World reads

A world read is executed once per instance and journaled; on replay it is answered from the journal without touching the driver. The engine hashes `{op, args}`, writes the running row, emits `node-queued` and `node-dispatched`, calls `executeWorldRead`, and settles. A failure is a node-level `DriverError` the script can catch, with the message `World read failed: <op> <args>.` and the driver's error as the cause; the `try { git.changedFiles() } catch { files.glob(...) }` idiom depends on this. A row that is still `running` on resume, because the process died mid-read, is re-executed.

The driver validates argument shape per op before doing anything (`files.glob(pattern)`, `files.read(path)`, `files.grep(pattern, glob?)`, `git.changedFiles(base?)`, `git.diff(base?, path?)`, `git.status()`, `git.log(count?)`), and rejects extra or mistyped arguments with a `DriverError` sentence naming the argument position. Paths are resolved against the run's `cwd` and must stay inside the workspace; `files.read` re-checks this because `git.*` is the first primitive that produces paths rather than receiving them.

Git commands are fixed argument vectors, never shell strings. All path-producing commands use `-z`, so paths are byte-exact and file names with newlines survive; output paths are normalized to workspace-relative by asking `git rev-parse --show-prefix` and stripping the prefix (`ls-files` gets `--full-name` to align with the repository-relative baseline the other commands use). A ref argument must match `^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$` and may not look like an absolute path.

| Op | Command(s) | Result |
| --- | --- | --- |
| `git-changed-files` without base | `git diff --name-only -z HEAD -- .` plus `git ls-files --others --exclude-standard -z --full-name -- .`, union, sorted | `string[]` |
| `git-changed-files` with base | `git diff --name-only -z <base> -- .` | `string[]` |
| `git-diff` | `git diff --relative <base?> -- <path ?? .>` | patch text |
| `git-status` | `git status --porcelain=v2 -z --branch -- .` | parsed status with branch and entries |
| `git-log` | `git log -n<count> --pretty=format:%H%x00%s%x00%an%x00%aI` | `{hash, subject, author, date}[]` |

Caps are enforced in the driver by asking for one more than the cap, so "exactly the cap" and "truncated" are distinguishable, and by rejecting over the cap rather than truncating; the message says what to narrow. A cap violation is `WorldReadCapExceeded`.

| Cap | Value |
| --- | --- |
| `files.glob` files | 2,000 |
| `files.grep` matches | 2,000 |
| `files.grep` serialized bytes | 256 KB |
| `git.diff` bytes | 512 KB |
| `git.log` count | default 20, maximum 100 |
| `world.run` stdout, stderr | 16 MiB each with `output: "full"` (the default); `"discard"` and `{ tail: n }` have no limit on what the process prints, and n is at most 16 MiB |
| `world.run` timeout | default 300 s, no maximum |

Glob results are workspace-relative and sorted, so a journaled list does not depend on modification times.

`world.run(cmd, args?, opts?)` differs from `git.*` in three deliberate ways. A non-zero exit is a value (`{exitCode, stdout, stderr}`), not an error, so a gating loop does not need exception control flow. The command is authorized at compile time only (a string literal the user confirmed at submit); the driver keeps no second, runtime list. Output is bounded where the script declares it (`opts.output`), never by the driver, because the journal replays the result as stored and the script must see the same bytes. The timeout has no upper bound. Authorization and the facade shape belong to `authoring.md`.

### Artifact publish

`executeArtifactPublish` is optional on the port and always implemented by the production driver; whether an artifact store exists is a fact of the assembled dependencies, and its absence fails at publish time with `ArtifactStoreUnavailable`. Artifact kinds, caps, versioning, the primary flag and the `report` tag binding are in `authoring.md`. The engine, not the driver, decides `primary`: it reads the option before dispatch, admits or rejects against the ids already primary (`ArtifactPrimaryConflict`, re-checked at settle), and stamps the flag onto the stored record; the flag lives in `result_json`, so no migration was needed, and resume rebuilds it from completed rows.

## Progressive results: `report`

`report(item, tag?)` is fire-and-forget from the script and needs no driver round trip, but it is journaled. The engine first probes `JSON.stringify(item)`: a cycle or a `bigint` is `DriverError: report() item cannot be serialized to JSON (a cycle or a bigint) at <instance>. Report a plain JSON value.`; `undefined`, a function, or a symbol is a `DriverError` of the same form. A `tag` must name an artifact declared at the top of the script, else `ArtifactUndeclared`. Three caps guard the journal, each a `ReportCapExceeded` with a sentence telling the author what to do instead: 65,536 items per run, 1 MiB (1,048,576 bytes) per serialized item, and 1 GiB (1,073,741,824 bytes) of serialized items per run. Bytes are what the caps really protect: each item is stored twice (in its node row and in its event), so the worst case is about 1 GiB of items and 2 GiB on disk per run. The count and the per-item size are proxies for it — without the per-run budget, 65,536 items of 1 MiB would be 64 GiB of items. The count cap is sized so that no reasonable script meets it; the per-item cap keeps one item well inside one protocol message (16 MiB, with pages of 4 MiB that always carry at least one row), and leaves room for the readers that still load whole items (cold replay and `GetWorkflowRun` load at most 64, so at most 64 MiB at once). A result larger than that belongs in `artifact.file`. The per-item size is checked first, then the count, then the per-run budget, all before anything is written. No reader loads more than a bounded page of items ("Reading the journal"). The instance is hashed over the item alone, one `completed` row is written, and a `report {instance, item, artifactId?}` event is emitted. On replay the row is matched by hash and skipped — the lookup reads the row without its `result_json`, since only the hash is compared — and on resume the report count and the report bytes are restored from the rows (`countNodes` and `sumResultBytes`, neither of which reads an item), so both per-run caps survive a resume. Reports are the persistent home of progressive output: in every terminal state the run snapshot carries the first 256 items in report order, and no more than 8 MiB of them, as `reports` and the true total as `reportCount`, read from these rows, so a run that died on its twelfth ask still surfaces eleven asks' worth of findings.

## The journal

### Port

```ts
export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: { stopReason?: RunStopReason; failure?: WorkflowErrorJson; result?: unknown }): void;
  updateRunUsage(runId: string, spentTokens: number): void;
  updateRunCaps(runId: string, caps: Caps): void;
  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string, options: { name?: string; withPersona: boolean }): ActorRecord[];
  putNode(record: NodeRecord): void;
  getNode(runId: string, siteId: string, ordinal: number, options?: { withResult: boolean }): NodeRecord | undefined;
  listNodes(runId: string, options: { kinds: readonly NodeKind[] | "all"; withResult: boolean; limit?: number; maxResultBytes?: number }): NodeRecord[];
  countNodes(runId: string, kind: NodeKind): number;
  sumResultBytes(runId: string, kind: NodeKind): number;
  appendEvent(runId: string, event: RunEvent): { sequence: number; event: RunEvent };
  listEvents(runId: string, options: {
    types: readonly RunEvent["type"][] | "all";
    reportItems: "all" | { limit: number };
    afterSequence?: number;
    limit?: number;
  }): StoredEvent[];
}
```

The port is synchronous and repository-shaped. The engine holds it through the driver; the run service holds it directly for reads and for reconciliation.

A `StoredEvent` is `{sequence, event, timeCreated?}`. `timeCreated` is the epoch millisecond the store appended the event, filled by both implementations: SQLite reads back the `time_created` column it writes, the in-memory store stamps `Date.now()` at append. It is what dates everything the event log knows and the run detail shows — the age of a log line, when a subagent last did something, how long a run has been stalled — and the alternative was a clock in the reader, which dates a cold replay of a week-old run to now. It is optional on the type so that test doubles implementing the port keep compiling; the two real stores both fill it.

### Reading the journal

A run's tables grow with everything it did: one node row per call, ask answers and world-read results in `result_json`, and each report item twice — in its node row and in its `report` event's payload. So no reader loads a table and filters it in memory. Every read states what it takes, and the filtering, counting and grouping run in SQLite:

- **What is selected is always spelled out.** The options of the three list reads are required, not defaulted (`getNode` is a point read, so it reads the whole row unless told otherwise): `kinds` and `types` name the node kinds and event types a reader uses (`kind in (…)`, `type in (…)`), `withResult: false` leaves `result_json` unselected, `withPersona: false` leaves `persona_json` unselected, and `name` filters subagents by name. A read that really needs everything writes `"all"`, which makes a full read visible at its call site. Filtered reads keep the table's order — `id` for nodes and subagents, `sequence` for events — and `limit` pages after the filter.
- **Counts are counted, not loaded.** `countNodes(runId, kind)` is a `count(*)`, and `sumResultBytes(runId, kind)` is `sum(octet_length(result_json))`: SQLite reads a value's length from the row header without loading the value (summing 1.5 GB of results takes under a millisecond; `length()`, which counts characters, takes half a second). Both stores measure the same thing, the UTF-8 bytes of `JSON.stringify(result)`. The host-side reads that the engine never makes sit beside the port on the SQLite store and are probed for, the same way as `countNodesByStatus`: `countTaggedReports(runId)` groups tagged `report` rows by `artifact_id` for the dashboards' item counts.
- **Report items leave the store only to be shown.** `reportItems: {limit: N}` returns every event, but each `report` event after the first N in sequence order comes back without its `item`; every other field — the instance, `artifactId`, the phase fields stamped at emit time, and the time — is kept. SQLite strips the item: one indexed query finds the sequence of the run's Nth report event, and the main query applies `json_remove(payload_json, '$.item')` to report events after it, inside a `case`, so a kept payload is never parsed and a stripped item never reaches JavaScript. A `row_number()` window would have done it in one query, but it copies every payload into a temporary table before numbering the rows. A missing `item` can only mean stripped, because `report(undefined)` is refused. N is the bound of whatever displays the items: the projection keeps 64 report entries (`WORKFLOW_RUNS_LIMITS.maxReports`, `docs/dynamic-workflow/presentation.md`, "Cold replay"), and the terminal snapshot carries 256.
- **A list read can be bounded in bytes.** `listNodes` takes `maxResultBytes`: it stops before the row whose result would take the rows read so far past it, and always keeps the first row. The terminal snapshot uses it, because 256 items of 1 MiB would be 256 MiB. The same window as the pages below decides the rows, so the results of rows left out are never loaded.
- **Dashboards read fields, not items.** A dashboard reads only the fields its spec names, so `listArtifactItems` takes `fields` and returns, per item, a map from each path to its value instead of the item. SQLite extracts the values. A path follows `readWorkflowArtifactField` (in `packages/shared`, the one definition both sides use): split on `.`; on an array a segment is an index when `Number(segment)` is a non-negative integer in range; on an object it is a key; anything else is absent. SQLite's JSON paths must say in advance whether a step is an index (`[n]`) or a key (`."key"`), so each integer-looking segment expands into both spellings, and `coalesce` takes the one that matches — at each step the value is either an array or an object, so at most one candidate matches. `->` returns JSON text, so a JSON `null` comes back as a value and a missing path as SQL `NULL`, which leaves the key out of the map. A value whose JSON is larger than 4 KiB comes back as a clipped string (the first 1,000 characters and "…"), clipped in SQLite, so a large value never reaches JavaScript whole. The page's byte bound counts the extracted values. A request without `fields` gets whole items, which is what an older renderer asks for; an older CLI rejects `fields` as an unknown key, and the renderer then retries without it and remembers that for the session.
- **Pages are bounded in bytes as well as rows.** The two paged host reads, the event log (`listEventPage`) and a dashboard's items (`listArtifactItems`), end a page when it holds `limit` rows or when one more row would take the stored payload bytes over `maxBytes`. The first row is always included, so a row larger than `maxBytes` makes a page of its own instead of stalling the pager. The store also decides `hasMore`: whether a row exists after the page. A row count alone cannot bound a page, because 500 events carrying large report items reach the protocol's 16 MiB message limit. The byte bound is a quarter of that (`WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes`, `WORKFLOW_ARTIFACT_LIMITS.maxPageBytes`), and the gateway always sets it. One query decides the page: a window sums `octet_length(payload_json)`, which SQLite reads from the row header without touching the payload, and a lazy `case` loads only the payloads that go into the page. The row after the page, whose existence is `hasMore`, is never loaded. The in-memory journal has no `listEventPage`, so on it the event log pages by count alone.

| Reader | Reads |
| --- | --- |
| resume | ask and world rows without results, artifact rows with results, `countNodes(report)` and `sumResultBytes(report)`; settle-order events (`node-settled`, `artifact-published`, `artifact-failed`); import-closure events (`node-queued`, `import-cache-closed`) |
| subagent registration | nothing: the count of a subagent's journaled asks is built once from resume's ask rows, keyed by subagent; a fresh run's journal is empty, and a subagent is always registered before it asks anything |
| report replay | `getNode` without the result; only the hash is compared |
| amend preflight and import | ask rows without results for the boundary check; ask and world rows with results for the cache, grouped by subagent once; subagents by name without personas when resolving the transcript source |
| terminal snapshot | the first 256 `report` rows, no more than 8 MiB of results, and `countNodes(report)`; artifact rows and `countTaggedReports` |
| cold replay and `GetWorkflowRun` | events with `reportItems: {limit: 64}`; `GetWorkflowRun` also reads non-report rows without results and subagents without personas, once |
| the event-log page | `listEventPage`: at most 500 events (fewer if the caller asks) and at most 4 MiB of stored payload |
| a dashboard's items | `listArtifactItems` with the fields the spec names: tagged `report` events for one artifact id, at most 200 per page by default, 500 at most, and at most 4 MiB of stored payload; the renderer pages until `hasMore` is false |

The tables have no index on `kind` or `type`: the filters walk the `run_id` index, and SQLite reads the early columns of a row without the payload overflow behind them.

### Tables

One migration, `0019_dwf_journal`, creates four tables.

| Table | Key | Columns of note |
| --- | --- | --- |
| `dwf_run` | `id` | `parent_session_id`, `cwd`, `name`, `script_text`, `script_hash`, `args_json`, `tool_call_id`, `resumed_from`, `caps_max_concurrency`, `spent_tokens`, `status` (check: `pending`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `failure_json`, `time_created`, `time_updated`; index on `(cwd, time_updated)` |
| `dwf_actor` | autoincrement id; unique `(run_id, site_id, ordinal)` | `name`, `persona_json`, `resolved_model`, `session_id`; `run_id` cascades from `dwf_run` |
| `dwf_node` | autoincrement id; unique `(run_id, site_id, ordinal)` | `kind` (check: `ask`, `world-read`, `world-run`, `report`, `artifact`), `actor_site_id`, `actor_ordinal`, `actor_seq`, `input_hash`, `input_json`, `status` (check: `running`, `completed`, `failed`), `result_json`, `error_json`, `stats_json`, `message_boundary`, `artifact_id`; indexes on `run_id` and `(run_id, artifact_id)` |
| `dwf_event` | autoincrement id; unique `(run_id, sequence)` | `type`, `payload_json`, `time_created`; expression index on `(run_id, json_extract(payload_json, '$.artifactId'), sequence)` |

Session ids are stored as plain text without a foreign key to the session tables: a subagent session may be deleted without invalidating the run's history.

### Physical and logical status

The `status` column keeps its five original values; the three-state vocabulary is mapped in the codecs, so the terminal-state redesign needed no migration.

| Logical | Physical `status` | `failure_json` |
| --- | --- | --- |
| `completed` | `completed` | absent; `result_json` holds the settlement artifact |
| `errored` | `failed` | the `WorkflowErrorJson` |
| `stopped {reason}` | `cancelled` | an envelope `{stopReason, error?}`; `error` is present for `provider` (`ProviderStop`) and `interrupted` (`Interrupted`) |

Decoding is total: a `cancelled` row without an envelope reads as `stopped(user)`, and a `failed` row whose failure code is `Interrupted` reads as `stopped(interrupted)`. Status predicates in SQL go through `json_extract` on the envelope.

The event log is not mapped. `dwf_event` payloads are stored and read verbatim, so a `run-settled` written before the redesign still says `cancelled` or `failed`, and a `run-settled` written today says `stopped` or `errored`. No reader derives a run's status from that event: the row is the status authority, and the cold replay mints the trailing settle from the row rather than replaying the stored one (`docs/dynamic-workflow/presentation.md`, "Cold replay"). The projection reducer is the second guard: a `run-settled` whose status word it does not know settles the run as `errored` rather than leaving it live.

### Write timing

| Moment | Writes |
| --- | --- |
| `createRun` | one insert with metadata (`scriptText`, `scriptHash`, `args`, `name`, `toolCallId`, `resumedFrom`, `caps`); the metadata is written once and never rewritten, `caps` excepted (`updateRunCaps` is a second writer on that column) |
| resume | `updateRunStatus(running)`, which clears `failure`, `stopReason`, and `result` |
| subagent created | `putActor`, carrying an existing `sessionId` and `resolvedModel` forward on a re-put |
| instance goes live | `putNode` with `status: "running"` |
| instance settles | `putNode` with the result or the error; stats that arrive later are backfilled onto the row |
| the cap is retuned | `updateRunCaps`, which writes `caps_max_concurrency` and nothing else (see "Retuning the cap of a live run") |
| turn ends | `updateRunUsage`; the ask row's `messageBoundary` is written by the driver after the exchange (see "Amend-resume") |
| every event | `appendEvent`, one statement, `sequence = coalesce(max + 1, 0)`, returning the sequence |
| settlement | `updateRunStatus(<terminal>, settlement)`, then `run-settled`, then `driver.dispose?.()` |

A terminal `updateRunStatus` coalesces: a settlement without a `failure` keeps an earlier one, and a `result` of `null` is stored as `null`, distinct from absent. `listEvents` pages with a cursor that is strictly greater than `afterSequence`; `limit` of `-1` means unbounded. Sequences continue across resumes, so an event log read by cursor never restarts.

### Two stores, one contract

Production uses the SQLite repository. Tests and the engine's own suites use an in-memory store. Both are run against `runJournalStoreContract(factory)`, a shared suite covering: create and read, duplicate run rejected, every terminal encoding and its round trip, coalescing, the non-terminal flip clearing settlement fields, metadata persistence across settlement, `updateRunCaps` rewriting `caps_max_concurrency` and nothing else on the row (including across a settlement), usage writes not touching status, persona and resolved-model round trips, node rows including the bounded world-read input, `null` versus absent results, the read options (`kinds`, `withResult`, `limit` in id order, `countNodes`, `types` in sequence order and composed with the cursor, `reportItems` stripping only report events after the Nth and keeping their other fields, subagents by `name` and without personas, `getNode` without the result), `messageBoundary` read-modify-write, artifact rows and tags, monotonic sequences that continue across a resume, `timeCreated` filled on append and preserved on read back, strictly-greater cursor paging, per-run scoping, and isolation from caller mutation.

## Resume by replay

A resumed run is the same script run again with the journal answering for what already happened. The engine is constructed with the existing run record. It first checks that the incoming `scriptHash` equals the recorded one and throws `ScriptHashMismatch` synchronously otherwise, with `mismatch: {expected, got}` and a message that explains resume needs the byte-identical script and that a revised script is a new run amended from this one. It then restores the report counter by counting `report` rows, the artifact state from `artifact` rows, the number of journaled asks per subagent from the ask rows, and `spentTokens` from the run row, flips the status to `running`, and emits `run-started`, followed by `usage-updated` with the restored total when it is non-zero ("Usage accounting").

As the script re-executes, each instance meets its journal row. A `completed` or `failed` row is settled from the journal with `node-settled {cached: true}` and no driver call; the script sees the same value or the same rejection as before. A `running` row is re-executed live; because the subagent's transcript already holds the turns of the first attempt, that ask's stats are journaled without `worldToolCalls` ("How the engine consumes the cache"). Subagent sessions are re-attached by the journaled session id, so a subagent whose first ask is cached and whose second is live continues the same transcript. The hold rule keeps cached asks ahead of live ones on each subagent.

### Replaying the settle order

A site's ordinal is the arrival counter of its call, so every journaled call a branch makes **after** an await is numbered in the order the fan-out finished, not the order the script issued it. That order is wall-clock, and no node row reproduces it: released in admission order, a replayed `Promise.all` runs its continuations array-first, and the first `report` after the join takes the ordinal the journal gave to whichever branch happened to finish first. The run then dies on its own defensive check — `InputHashMismatch` at `report#2@1` — blaming a script that is in fact pure.

So a resume replays the schedule, not only the answers. It reads the run's own event log and takes the order in which each instance **first** settled: `node-settled` for asks and world nodes, `artifact-published` and `artifact-failed` for content artifacts, first occurrence per instance, kept only for instances whose row is terminal and whose replay resolves a promise. A `report` is void and a preset declaration is synchronous, so neither is in the list and neither can block it; a row still `running` is re-executed live rather than released, so it is not in it either. That list is a gate: a cached settlement is parked at its release point until every earlier entry has been released, and the parked ones then go out in journaled order — the interleaving of the first life, so the continuations run in the same order and every ordinal downstream of a join lands where the journal has it. Cached `node-settled` events are emitted at release, so a replayed life's event log carries the first life's order as well, and a third life recovers the same schedule.

An instance the gate has no entry for passes straight through: a fresh call, or a run whose events predate this rule. The gate therefore constrains only what it has evidence for and can never deadlock a run it knows nothing about, and on settlement it opens for good, so nothing the script is still awaiting is left hanging.

The induction underneath it: entry k+1's call was issued before it settled, hence at or before the burst of continuations that releasing entry k produced, so by the time the gate waits on k+1 the script has already claimed it. A script that breaks that — one that reaches a different journaled call for the same answers — is not deterministic, and the hash check behind the gate still fails it loudly.

Resume is gated at the run service before an engine exists.

| Refusal | Meaning |
| --- | --- |
| `not_found` | no run row |
| `already_running` | the same run id is in flight in this process |
| `not_resumable` | the run is `completed` or `errored`; only `stopped` resumes (`isResumableSettlement`) |
| `script_missing` | the row predates `script_text` |
| `script_mismatch` | the row's `script_hash` no longer matches its own `script_text` |
| `compile_failed` | the row's `script_text` no longer type-checks against the current facade (the facade changed after the run); the message carries bounded diagnostics, and the way forward is `AmendWorkflow` |

Caps and arguments come from the record, which is why a run retuned before it stopped resumes at the bound it was retuned to and not the one it was submitted with (see "Retuning the cap of a live run"), and `subagentModel` from the run's `run-launched` event, so a resume puts the subagents back on the model the run was launched with without the resumer having to name it; `resumedFrom` is not carried into the new engine because a resume is the same run, not a new lineage. Only a run's own parent session may resume it: on construction the run service reconciles orphans, marking every non-terminal run owned by that session as `stopped(interrupted)` with the failure "…was interrupted: the owning process exited before the run settled", without synthesizing events. Cold replay mints the trailing `run-settled` of every terminal row from the row itself (see "Physical and logical status"), and the run list marks a non-terminal run of another session as possibly interrupted rather than claiming it.

## Terminal states

### Three ways to end

| Status | Meaning | Resumable | `failure` |
| --- | --- | --- | --- |
| `completed` | the script returned; the return value is the settlement artifact | no | none |
| `errored` | the script threw, or the engine hit a run-level failure | no; amend with `AmendWorkflow` | always |
| `stopped {reason}` | something outside the script ended it | yes, `ResumeWorkflowRun`, except `superseded` | `provider` and `interrupted` carry one; `user`, `model` and `superseded` do not |

```ts
type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";
type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";
```

| Producer | Result |
| --- | --- |
| `complete(value)` | in-flight asks are aborted (`Cancelled: Run completed; in-flight subagent tasks were abandoned.`, `node-settled cancelled`), then `completed` |
| `fail(error)` | `errored`; in-flight asks are rejected with the same error and no cancelled events are emitted |
| `stop("user")` | the user cancelled from the app, the CLI, or the TUI |
| `stop("model")` | the main agent called the stop tool |
| `stop("superseded", undefined, supersededBy)` | `AmendWorkflow` stopped the run to replace it; the successor's id is recorded beside the reason (see "Amend-resume") |
| `stop("provider", error)` | the driver's `stopRun` after a non-recoverable model-side error; `error.code === "ProviderStop"` |
| `stop("interrupted", error?)` | the harness saw the sandbox die, the protocol break, or a timeout; the owning session App closed under the run (see "Engine ownership"); or reconciliation found an orphan |

Settlement is first-wins: once one producer has fired, the others are ignored. Every producer runs the same tail, `finishRun`: `updateRunStatus`, `run-settled`, `driver.dispose?.()`. The cancelled asks of a stopped run leave their rows in `running`, which is what makes them re-execute on resume.

Run-level failures the engine raises itself, all `errored`: `InputHashMismatch`, `ScriptHashMismatch` (before start), `DuplicateActorName`, `UnknownActor` (an actor handle the run does not know), `MissingAskSpec`. After settlement any further facade call is rejected with `Cancelled: Run already settled; <op> is no longer accepted.`

### Model-side errors

The driver classifies every rejected model turn with `resolveWorkflowModelFailurePolicy`, the same table the request runner uses (`docs/dynamic-workflow/concurrency.md`, "Retry budget and the model-error policy"). Three outcomes exist.

| Verdict | Engine-side effect |
| --- | --- |
| stop, kind `auth`, `not_configured`, `model_unavailable`, `invalid_request`, `quota`, or `other` | `sink.stopRun(ProviderStop)`; the whole run becomes `stopped(provider)`. The error message is `Subagent <name> hit a permanent model-side error (<reason> [<code>]): <raw>` and carries `ProviderStopDetails`. Kind `other` is a provider code the classifier does not know, returned 10 times in a row within one request (`concurrency.md`, "The policy table"). |
| `context_exceeded` | the ask fails with `ContextLimit`: "Subagent <name> exceeded the model's context window even after compaction. Give this ask a smaller input or split the work across subagents." The script may catch it; the run continues. |
| anything else | the driver redrives the turn after a backoff (2 s doubling to 60 s, jittered by half, or the provider's `Retry-After`), reporting `askWaiting {cause: "backoff"}` meanwhile; the script never sees the failure |

```ts
export interface ProviderStopDetails {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string; providerLabel?: string; modelId?: string; providerCode?: string;
  subagent?: string; subagentName?: string; phase?: string;
  rawMessage?: string;   // bounded to 2,000 characters
  resetAt?: number;      // quota only, epoch ms, when Retry-After was parseable
}
```

The engine enriches the details with the stopping subagent's birth phase before recording. The failure is stored as the stopped run's `failure`, and the notification reads `kind` to choose its wording, never the message (`transcript-and-notifications.md`). A stopped-for-provider run is resumable once the cause is fixed: the in-flight asks re-execute, and the completed ones replay from the journal.

A run whose subagents are all retrying makes no progress and emits no failure. The driver keeps one run-level stall clock: any successful model request resets it, any scheduled retry arms it, and when `WORKFLOW_STALL_NOTIFY_AFTER_MS` (twenty minutes) pass without a success while a retry has been scheduled, it fires once and the engine records `run-stalled {sinceMs, reason?, cap?}`. The run keeps going; the notice exists so the user can decide to cancel. The clock is described from the governor's side in `concurrency.md`.

### From `errored` to an amended run

`errored` is not resumable because the script that produced it will, by determinism, produce it again. The way forward is a revised script submitted with `AmendWorkflow`, which imports the completed work of the failed run as a cache (see "Amend-resume"). The tool descriptions steer the model that way; the run snapshot carries `runStatus` and `stopReason` so tool text and notifications can tell the truth even though the background-task tracker's own `status` vocabulary folds `stopped` into `cancelled` and `errored` into `failed`.

## Cancel and resume

### Cancel

A cancel travels one path regardless of who asked: the run service's `cancel(runId, initiator)` aborts the run's `AbortController` with the initiator as the reason; the harness reads the reason off the signal and calls `engine.stop("user")`, `engine.stop("model")`, or `engine.stop("superseded", undefined, supersededBy)` when the reason is the `{ superseded: <runId> }` object the amend path passes. The stop tool writes the initiator before calling the port. A user-initiated stop is also what makes the next amendment of that run ask for confirmation again (`docs/dynamic-workflow/launch.md`, "Amending this session's runs"). The engine aborts every in-flight ask through `cancelAsk` (the driver aborts the turn, rejects any parked submit or escalation promise with `Cancelled`, and withdraws a pending redrive), emits `node-settled cancelled` for each, and settles `stopped {reason}` without a failure.

### Resume

`ResumeWorkflowRun {run_id}` is the model's entry; the CLI and the GUI reach the same port method. The gate is the table under "Resume by replay", plus one rule read from the settlement: a run stopped as `superseded` is refused with `superseded` and the successor's id, because its unfinished work now belongs to that successor and replaying it would do the same work twice against a workspace the successor is changing. One more rule is read from the script: the stored text is type-checked against the **current** facade before anything is touched, and a script that no longer compiles (the facade changed after the run) is refused with `compile_failed` and a bounded diagnostics message. Replaying it verbatim could only fail; the way forward is a script rewritten for the current facade and submitted with `AmendWorkflow`, which keeps the finished work. Success starts the run in the background and returns `{ok: true, runId, status: "backgrounded", backgroundTaskId}`; the tool card joins the resumed run to the original `CreateWorkflow` call through the journaled `toolCallId`. Whether a run is resumable is computed once, in the CLI, by `isResumableSettlement`, and shipped as a boolean: on the `run-settled` progress payload as `resumable: true`, and on each row of the session's run list. Neither the projection nor the UI derives it from status.

Resuming re-arms the run in the background-task tracker: the terminal fields of the previous settlement are cleared when the `run-started` event of the resumed run arrives, so the card does not show a stale failure beside a running lamp.

### Resuming after a quota reset

A run stopped because the user's usage cap was reached (`stopped(provider)`, kind `quota`) resumes by itself once the cap resets, when the stop recorded a reset time. Before this, the main agent or the user had to remember to call `ResumeWorkflowRun` hours later; in one heavy user's 20 days of logs, 22 runs stopped on a cap, 17 were resumed by hand, and 5 were left.

The reset time is `providerStop.resetAt`. The adapter takes it from the provider's `Retry-After` header when there is one, and otherwise from the message: BigModel writes `您的限额将在 YYYY-MM-DD HH:MM:SS 重置`, a time without a zone that is read as Beijing time (UTC+8). Both sources go through the same window, from one day ago to 35 days ahead: a `Retry-After` that lands outside it (an abnormal or hostile header, such as a value of years) is ignored and the message is read instead, and a message time outside it is ignored too. A quota stop without a reset time (an exhausted balance, `1005`) is not resumed by itself.

The host module is `bootstrap/src/app/dynamic-workflow-quota-resume.ts`. It resumes the run `WORKFLOW_QUOTA_RESUME_MARGIN_MS` (one minute) after the reset, through the same path as the app's Resume (the session's execution boundary, `port.resume`, then the runtime re-arms tracking), so the resumed run has its terminal notification, its background-task entry and its residency.

```text
 run stops on 1308 ──► row: stopped(provider) { kind: quota, resetAt: T }
        │
        │ run-settled (this process)          session App constructed (cold start)
        ▼                                                 │
   read row ──► arm timer at T + 1 min ◄── scan the session's recent rows
        │                                                 │ (T + 1 min already past → fire now)
        ▼
   timer fires ──► read row again
        ├── still stopped(provider, quota) with the same T ──► resume (same path as the app's Resume)
        ├── another T ──► arm again at the new T + 1 min
        └── anything else (resumed by hand, superseded, …) ──► nothing
```

Seven rules keep it honest:

- **The run row is the only source of truth.** The timer only wakes the module; the decision is made by reading the row when it fires.
- **It lives in the session App.** A stopped run does not keep its App resident, so an idle session is closed after ten minutes and its timer with it. The scan at App construction is the catch-up: the run resumes the next time the session is opened. Nothing resumes a run of a session nobody opens.
- **No loop.** When a resumed run stops on the same reset time again (or an earlier one), the module does not resume it again in that process, drops any retry still pending for it, and logs `dynamic_workflow.quota_resume.not_advancing`. A later reset time is a new window and is resumed as usual.
- **Repeated resumes are spaced.** In one process, each auto-resume of a run pushes the earliest next one further out: `WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS` (10 minutes) after the previous start, doubling each time, at most `WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS` (one hour). The no-loop rule catches a reset time that does not move; this one catches a reset time that moves but is wrong, such as a provider that answers a quota stop with a `Retry-After` of a few seconds, which would otherwise resume the run and hit the cap once a minute. Real quota windows are hours apart, so the spacing does not delay them.
- **A transient refusal is retried, a few times.** The resume can fail for reasons that pass: `already_running` (the run is in flight in this process, such as the user pressing Resume at the same moment), or a thrown error (the execution boundary, a close race). The module tries again `WORKFLOW_QUOTA_RESUME_MARGIN_MS` later, at most `WORKFLOW_QUOTA_RESUME_RETRY_LIMIT` (2) times, and each retry reads the row again like any firing, so a run that did start in the meantime is left alone. The other refusals (`not_found`, `not_resumable`, `superseded`, `script_missing`, `script_mismatch`, `compile_failed`) say the run cannot be resumed as it is, and are logged and not retried. After the last retry the module logs `dynamic_workflow.quota_resume.gave_up`; the row is still a quota stop, so the next cold start of the session tries again.
- **A failed read ends the attempt, not the process.** Every journal read on the timer and run-settled paths is guarded like the cold-start scan: an exception is logged as `dynamic_workflow.quota_resume.read_failed` with a clipped message, and that run is not resumed this time. The module never lets an exception escape a timer callback or a subscription.
- **Close stops it first.** App close disposes the module before it closes the run service, so a timer never fires into a closed service.

The stop notification says the run resumes by itself after the reset and tells the main agent not to call `ResumeWorkflowRun` before then (`docs/dynamic-workflow/transcript-and-notifications.md`).

## Engine ownership

An engine belongs to the session App that started or resumed it, and to nothing else. It is a closure over that App's live objects: the actor runtimes are built from the parent's model factory and parent runtime, progress events travel the parent runtime's append chain, and the cancel controller, the escalation registry and the settlement promise live in that App's run service. None of those outlive the App, so neither does the engine. There is no process-wide engine host and no ownership record on the run row; a run's owner is the resident App of its parent session, or nobody.

Three rules follow, and each one has a test.

| Rule | Mechanism | Test |
| --- | --- | --- |
| **A live engine keeps its App resident.** | Every launch (submit, amend, resume) registers its settlement promise as residency-blocking work on the parent runtime in the same synchronous slice that starts it, the way a background Bash does; the count drops in the settlement's `finally`. The resident pool reads one runtime fact, so a session with a live run is never deactivated, for idleness or for high water. | a session whose run is live reports blocking work until the run settles; `dynamic-workflow-run-service.test.ts` |
| **Close stops what it owns.** | App close, after the runtime has begun shutdown and before any resource closes, calls the run service's `close()`: every live entry is aborted with initiator `interrupted` and every settlement is awaited. The harness maps that reason to `engine.stop("interrupted", failure)` with the `Interrupted` failure code and a message that names the owner's close, so the row is `stopped(interrupted)`, resumable, written by the engine itself through the normal `finishRun` tail (`updateRunStatus`, `run-settled`, driver dispose). The service refuses `submit`, `amend` and `resume` once closed. No journal event follows the close, and the model is not woken: the runtime is shutting down, so the terminal notification is dropped, and the next activation shows the run as stopped and resumable through cold replay and the run list. Because rule one blocks idle and LRU eviction, close under a live run now happens only when the user closes the session or the process exits. | fault-matrix cell B18: close under a live run yields one `stopped(interrupted)` written before `close()` resolves, no event after it, and a resume in a fresh service continues from the journal |
| **A live entry outranks the journal.** | Status synthesis reads the journal's status only for runs the service does not hold live. A terminal row under a live entry can only be a foreign write (another process's orphan reconciliation, see "Alternatives not taken"): the snapshot, the list and the detail keep reporting `running`, the stop reason and failure stay absent, the tracker keeps polling, no notification is enqueued, and the engine's own settlement rewrites the row. The service logs the foreign row once per entry. When a run settles `completed`, the settlement clears the failure column, so a foreign failure never survives beside a result. | fault-matrix cell B19: a foreign `stopped(interrupted)` row written under a live engine produces no terminal snapshot; the real completion does, and the row ends `completed` without a failure |

Orphan reconciliation keeps its scope: at service construction, the parent session's non-terminal rows are the remains of a dead process, because construction happens only for a session that is not resident, and rule one keeps a session with a live run resident. Inside one process, reconciliation can therefore no longer meet a live engine. Across processes it still can, which is the unsupported two-instance case: rule three keeps the owner from believing that write, and nothing else is promised.

## Amend-resume

A stopped run resumes; any run is amended. An amendment is a new run, with its own id, script, arguments, and caps, that borrows the completed work of a predecessor so the revised script does not pay for it twice. A running run can be amended too, and that is the cheap way to repair a script seen to be wrong while it runs: the amend stops it and starts the revision in one call. The cache closes at the first workspace write of the revision, so work the predecessor finished is reused whether or not the amendment came early; an early stop saves only what the predecessor had not yet started.

### Tool contract and refusals

`AmendWorkflow { run_id, script?, name?, max_concurrency?, subagent_model? }` is the model's entry (`docs/dynamic-workflow/launch.md`, "The `AmendWorkflow` tool"); it reaches the run service's `amend` method, a sibling of `submit` that owns the stop-then-import sequence. One shape of that call never arrives here: nothing but `max_concurrency`, against a live run, is routed to the run port's `retuneConcurrency({runId, maxConcurrency: number | null})` instead, which resolves `null` to the default parallelism, floors the value to at least 1, and calls `setMaxConcurrency` on the running engine (see "Retuning the cap of a live run"), answering with the bound it applied, the previous one and the default; the amendment below is every other call. The predecessor may be in any state. Every optional field keeps the predecessor's value when omitted, the script included: an amend that changes only settings re-runs the predecessor's recorded `script_text`, which the tool reads through the port's `getScript` before the confirmation, so `amend` always receives a script and never inherits one itself. The cache treats that script like any other; with it byte-identical, every cacheable ask of the predecessor is a hit.

```ts
amend(request: { scriptText; cwd; predecessorRunId; name?; parentSessionId?; toolCallId?; inheritArgs?: true; trace }):
  | { ok: true; runId; supersededRunId?: string }
  | { ok: false; reason: "run_not_found" | "missing_boundaries" };
```

An amendment starts with no arguments unless the request says `inheritArgs`, in which case the new run takes the predecessor's recorded `args_json`. Only the settings change from the GUI passes it (`docs/dynamic-workflow/launch.md`, "Changing a run's settings from the GUI"): it re-runs the predecessor's own script, which reads the arguments it was launched with. The tool does not pass it.

| Step | What happens | Failure |
| --- | --- | --- |
| preflight | read the predecessor; check that every completed ask has a `messageBoundary` | `run_not_found`, `missing_boundaries`; nothing was stopped, no row exists |
| mint | allocate the new run id | |
| stop | if the predecessor is not terminal: `cancel(predecessor, { superseded: newRunId })`, then await the predecessor's settlement promise (the same promise `waitForTask` awaits; it never rejects and there is no timeout) | |
| quiesce | ask the predecessor's driver which of its subagent sessions have finished being written, waiting no longer than a bounded interval | sessions that miss it contribute their completed prefix and no `inFlight` |
| import | build the cache from the settled predecessor (see "What is imported"); a refusal here is a host fault (the preflight already passed), surfaced as an error | |
| submit | create the new run with `resumedFrom`, the imported cache and the settled predecessor's `spentTokens` as `inheritedTokens`, otherwise exactly as a fresh `submit` does | |

The preflight runs before the stop on purpose: the two refusals are properties of the predecessor's journal that a stop does not change, so refusing first means a refused amend never leaves a stopped run behind. Any live run's completed asks are already journaled with their boundaries, so the preflight on a running run is as decisive as on a settled one.

The quiesce step exists because a run settles before its aborted turns have finished unwinding: the driver's `dispose` is synchronous and hands each session with a turn still in the air to a `then`, and the engine settles as soon as `cancelAsk` has aborted them. So the settlement promise says the run is over, not that the last message of the abandoned exchange is on disk. Only `inFlight` depends on that difference, because only it is measured from the session as it stands now; the completed prefix carries boundaries the driver journaled when each ask settled, and those are facts rather than present-tense observations. The wait is bounded and the bound is not a way of hoping the race is over: a session that misses it is not treated as settled, it simply yields no `inFlight`, which is the behavior an amendment had before the carry existed. The step costs nothing when the predecessor has no live engine in this process — nothing is writing its sessions, so every session is quiet at once.

A superseded predecessor settles `stopped {reason: "superseded"}` with `supersededBy` on its settlement record, journaled in the stopped envelope beside the reason (no schema change). `resumedFrom` on the successor and `supersededBy` on the predecessor are the two ends of the same edge; both travel on the run snapshot, the run list rows and the v4 run state, so cards can draw it in either direction. A completed or errored predecessor is not touched: it keeps its own settlement and may be amended again. The successor's terminal notification is delivered as usual; the superseded predecessor's is not (`docs/dynamic-workflow/transcript-and-notifications.md`), since the amend result already told the model about the stop.

The new run row records `resumedFrom`; the lineage can be several runs long.

### What is imported

```ts
export interface ImportedRunCache {
  actors: Map<string, {            // keyed by subagent name
    persona: PersonaSpec;
    entries: { inputHash: string; result: unknown; stats?: AskStats; messageBoundary: number }[];  // by actorSeq
    inFlight?: { inputHash: string; messageBoundary: number };   // the running ask at actorSeq === entries.length
    transcriptSourceSessionId: string;
    resolvedModel?: string;
  }>;
  world: Map<string, { inputHash: string; kind: NodeKind; result: unknown }[]>;  // by inputHash, nth occurrence
}
```

Subagents are matched by name, not by site: the revised script may move the `agent(...)` call. Only named subagents whose name is unique in the predecessor are imported; anonymous and duplicated names are skipped. For each, the cache holds the contiguous prefix of `completed` asks from sequence 0, each with its `inputHash`, `result`, `stats`, and `messageBoundary`. The transcript source is found by walking the `resumedFrom` chain and requiring, at each generation, exactly one same-named subagent with a journaled session id. World reads are imported from `completed` world rows and queued by `inputHash`, so the nth occurrence of the same read is answered by the nth recorded result.

Beside that prefix, `inFlight` carries the one ask the predecessor was still running when it stopped: the `running` row that sits right after the prefix, at sequence `entries.length`, with its `inputHash` and, as `messageBoundary`, the message count of the predecessor's whole settled session — prefix and unfinished exchange together, because an ask that never ended wrote no boundary of its own. It is imported only when the transcript source is the predecessor's own row: the partial exchange exists in that session and nowhere else, so a source resolved from an older ancestor carries the completed prefix and no more. A candidate may therefore hold an `inFlight` and an empty `entries`, which is the ordinary shape of a fan-out amended while its first round was still in the air, and a candidate with no completed ask is a candidate like any other.

Three things can leave that field absent while the prefix is imported as usual, and each of them is a way of saying that there is no exchange to continue rather than a failure. The row after the prefix has to be `running`: a `failed` row and a gap are the other two ways a prefix ends, and neither is an ask that was still being answered. The session has to be quiet, in the sense the quiesce step above defines. And the count has to be **strictly greater** than the last completed entry's boundary, or greater than zero when nothing completed: an ask that was queued but never dispatched has written nothing past the prefix, and a seed whose `messageCount` merely repeated the prefix — or, with no prefix, seeded nothing at all — would mark the subagent as having continued an exchange whose transcript it does not in fact hold.

### How the engine consumes the cache

When the revised script creates a subagent whose name and canonical-JSON persona (without `model`) match an imported subagent, and issues its k-th ask, the engine compares the ask's `inputHash` with the k-th cached entry. A match settles the ask from the cache with `node-settled {cached: true}` and no session; that event names the candidate's `transcriptSourceSessionId` as `sourceSessionId`, since the exchange lives in that session and in none of this run's. A resume of the amended run replays the row with the same `sourceSessionId` when the row was consumed from the import, which the engine knows at the moment it reconciles the row, before the settle is released. The first mismatch, or running past the cached prefix, makes that subagent diverge monotonically: from then on its asks are live and the cache is not consulted again for it. A world read whose hash has a queue takes the head of the queue.

A cached result is valid as long as everything it depended on is unchanged. Its script-side inputs, the persona, the conversation prefix and the instructions, are covered by the hash chain, and a change upstream propagates by itself: a live ask produces a new result, the prompt interpolating it changes, and the downstream hash misses. The one input the hash chain cannot see is the workspace a tool-using subagent read. The cache therefore closes for the whole run at the **first workspace write** of the revision, and not before:

- The driver watches each subagent's `ToolCallStarted` events, which the executor emits after the permission decision and before the handler runs, carrying the resolved `readOnly` and `sideEffectScope` of that call (for Bash, the read-only command classification the permission system already makes). The first call that `isWorkspaceMutatingToolCall` judges a write (`readOnly` false in scope `workspace`, `git` or `system`; an undeclared scope counts as a write) is reported once per ask as `askMutating(instance)`, and the engine closes the cache before the tool has written a byte.
- A live `world.run` is a write by definition and closes the cache before it is dispatched. A live world read does not.
- An ask going live does not close the cache. It has not changed anything yet, and in a `Promise.all` fan-out the asks issued after the first miss have no dependency on it. Closing at admission, the rule before this one, discarded every later hit in the fan-out: an amendment of a running 50-way fan-out lost six hits, and one of a 5-way fan-out lost the only hit it had.

After the close, cached world reads and cached asks that touched the world are not consulted; those asks run live and their subagent diverges. A cached ask whose recorded `stats.worldToolCalls` is zero is **pure**: it only answered, so it depended on nothing but its prompt and prefix and still settles from the cache after the close, as long as its subagent has not diverged. An entry whose stats lack the field is treated as having touched the world.

`worldToolCalls` counts the ask's tool calls that could observe or change the world, by `isWorldTouchingToolCall`: every scope except the two protocol ones, `session` and `userInteraction`. A read counts, because `Read` declares scope `none` yet its answer depends on the workspace; `submit_result` and `escalate` do not, because handing a result or a question back to the engine is not work on the world. Without that exemption no typed ask could ever be pure, since every one of them submits.

Both counts come from the same subscription the close does, not from the turn result: `TurnResult.events` carries no tool events, so counting there yielded zero for every ask ever recorded, tool-using ones included. The counters live in the driver's tool-activity observer, reset when an ask starts, and accumulate across its repair and nudge turns, so the last `askStats` of an ask reports its whole total.

One miss is not always a fresh start. When the revised script's k-th ask is the very ask the predecessor was still running — `k` equals `entries.length`, the whole prefix was consumed, and the hash equals `inFlight.inputHash` — the successor **continues** that exchange rather than beginning it again: the subagent's session is seeded with the predecessor's entire partial transcript, every intermediate turn of the unfinished ask included, and the ask runs live from there. The subagent still diverges, as any miss makes it, and every ask after this one is live too; what the carry saves is the work inside the unfinished exchange, which a cancel and resume of the same run keeps by re-attaching the same session and which an amendment otherwise throws away. The revised instructions are sent again on top of that transcript, so a subagent that had already answered part of the task sees its own working notes.

The carry holds only while the import cache is **open**. A partial transcript is made of the predecessor's observations of a workspace the revision may by then have rewritten, so after the first write it is worth no more than a cached world read: the ask starts from the completed prefix instead, and the unfinished exchange is dropped. This is the rule the tool-using entries obey and it is the same reason; the pure exemption has no counterpart here, because an ask that never ended has no recorded `stats` to be pure by.

The close is recorded once as `import-cache-closed {instance, cause, actorName?}` and is idempotent. On resume of an amended run, the engine recovers the closed state from that event alone; which asks were live is still read from `node-queued {kind: "ask"}`, and a live row never advances the consumption cursor. Whether a live row carried the predecessor's in-flight ask is recovered from the order of those same events, with no schema change: the carry decision and that ask's `node-queued` are made in one synchronous slice at admission, so the cache was open for the ask exactly when its `node-queued` precedes the first `import-cache-closed`. A re-dispatched row at sequence `entries.length` that was queued before the close and matches `inFlight.inputHash` therefore seeds the session it seeded the first time. The recovery has to be exact in both directions, and in one especially: seeding a session that in truth diverged earlier would copy the predecessor's messages into a transcript that is not its own, because the driver's idempotence check only asks whether the target already holds that many messages.

A subagent that went live after cached asks is created with an `ActorSessionSeed {sourceSessionId, messageCount, resolvedModel?}`, where `messageCount` is the `messageBoundary` of its last consumed cached ask. A subagent that carried the in-flight ask is seeded with `inFlight.messageBoundary` instead, and that is why it has a seed even when it consumed nothing at all. A subagent that diverged before reaching the in-flight ask, or that met it after the close, has no carry and follows the first rule: with nothing consumed there is no seed, and the session starts empty.

An ask whose transcript began before this dispatch is journaled without `worldToolCalls`. The driver's tool counters live in memory and are reset when an ask starts, so such an ask counts only the turns it ran itself and under-reports the calls already sitting in its transcript; a zero from it would read as **pure** and let a later amendment settle it from the cache after a close. An absent field already means "touched the world", so dropping it is the honest record. Two asks are in that state: one that carried the predecessor's in-flight exchange, and one re-dispatched from its own `running` row on resume. `tokens`, `toolCalls` and `turns` are reported as they arrive — they are usage, not a purity claim — and the rule covers both writes of an ask's stats, the one at settlement and the late backfill onto an already-settled row.

### Usage across the lineage

An amended run reports the cost of its whole lineage. The run service reads the predecessor's `spentTokens` after the predecessor has settled and the cache is built, and passes it down the launch path as `inheritedTokens`; the engine creates the new run row with that value instead of zero and emits it as the first `usage-updated` right after `run-launched` ("Usage accounting"). Since every predecessor's figure is itself cumulative, a chain of several amendments sums by construction and nothing walks the `resumedFrom` chain. The predecessor row is untouched and keeps its own total.

A cache hit adds nothing to the successor's `spentTokens`: its cost is inside the inherited figure, and the entry's `stats` are copied onto the node row for bookkeeping only. Only live asks of the revision add tokens. Two consequences follow. The figure includes work the predecessor did that the revision discarded by diverging: it is the money spent, not the money embodied in the result. And a straggler `askStats` that reaches the predecessor after the successor has read its row stays on the predecessor row and is not inherited; that is at most the last turn of one ask, the same window the predecessor's own live projection already has.

The registry entry that stands in for the run before its row exists carries the same `inheritedTokens`, so the list and detail read faces report the inherited total in that gap rather than zero.

### Time across the lineage

The completion card's time figure is counted over the same span as its token figure: the run's own lives plus every ancestor's, idle time between lives excluded (`docs/dynamic-workflow/transcript-and-notifications.md`, "How long it took"). Unlike usage it needs no accumulator on the row, because the event log already dates every life: a life runs from its `run-started` to the last event it recorded, and the chain is walked through `resumedFrom`. The engine takes no part in it — it neither reads nor writes a duration — and nothing here is a new column. The sum is read at snapshot time by the run service through the host-side `listRunLifeSpans` query, in the same terminal-only branch that reads the node rows, and rides the terminal snapshot as `activeDurationMs` for the notification to report. A journal without that query (the engine's in-memory implementation) simply leaves the field absent, and the notification falls back to the settling process's own clock.

### Driver side: boundaries and seeding

After each exchange ends (accept, or a turn end that was not nudged), the driver counts the messages persisted in the subagent's session and writes that count into the ask's node row as `messageBoundary`. Counting happens before the outcome is reported, because the engine may dispatch the subagent's next ask on the same session inside that call. The write is a read-modify-write of the row and is skipped if the next ask has already started. Every ask of every run is accounted this way, because any run is a potential predecessor.

When `createActorSession` receives a seed, the driver copies the first `messageCount` messages of the source session into the new session before rehydrating it, cloning each with a derived id `<target>-seed-<i>`. A source shorter than the boundary is a `DriverError` with `mismatch: {expected, got}`.

Seeding is skipped on two conditions, and a skip is not an error: when the target already holds at least that many messages, and when the target holds any message that is not a seed clone at its own index. The first is the ordinary crash-and-resume case, where the session already contains what was copied plus what the run then produced. The second says that a session which has begun a life of its own is never written into again, however short it looks: a target holding only seed clones is a half-finished copy and is completed, while one holding anything else is left alone. That matters because `inFlight`'s boundary, unlike every other number in the cache, is read from a session rather than from the journal, so a later rebuild can legitimately produce a larger one; without this rule that larger boundary would append the predecessor's messages after the successor's own, in a transcript that reads out of order and was never that subagent's. The rule is stated at the copy so that it holds for any future import fact that is not a function of the journal.

An ask carried from the predecessor can bring a tool call that was still streaming when the turn was aborted, and so has no result. Rehydration marks such a call interrupted, exactly as it does for a run that was stopped and resumed, so the subagent reads it as work that did not finish rather than as an answer.

### Naming uniqueness

Because the cache is keyed by name, the engine rejects a run that uses one non-empty subagent name twice: `DuplicateActorName`, a run-level failure whose message names both instances and explains that a named subagent is the identity an amended re-run matches its cache by. Anonymous subagents are unchecked. The analyzer reports the same rule at compile time for literal names, diagnostic code 9005 (`docs/analysis.md`, "Diagnostics").

## Escalation

A subagent that is blocked by something outside its reach asks the main agent instead of inventing an answer. The `escalate {question}` tool blocks the subagent's turn until an answer arrives, with no timeout: the alternative, a guessed value, is exactly what the tool exists to prevent, and the escape hatch is cancellation.

| Element | Behaviour |
| --- | --- |
| Question id | `dwfq-<runId fragment>-<seq>`, where the fragment is 8, then 16, then all characters of the run id after `dwfrun-`, chosen to avoid collision within the service, and `seq` is per run |
| Registry | per run service; `park`, `isTaken`, `withdraw`, `resolve`, `pendingFor`; retired ids are remembered up to 256 so a late answer is refused as `already_resolved` rather than unknown |
| Budget | `MAX_ESCALATIONS_PER_ASK = 3`; the fourth call in one ask returns `{status: "refused", reason: "budget_exhausted"}`; a call outside an ask returns `reason: "no_active_ask"`. The budget resets at the next ask, not at a nudge |
| Events | `escalation-raised {qid, actor, actorName?, question, context?, askedAt}` and `escalation-resolved {qid, answer}`, both driver-recorded through the shared journal and `emit` |
| Answer path | `ResolveWorkflowQuestion {question_id, answer}`, a main-agent tool that needs no approval; refusals `already_resolved`, `run_not_in_flight`, `unknown_question` |
| Failure of the journal write | on raise, the question is withdrawn and the tool call throws; on resolve, the answer is delivered and the write failure is only logged |
| Snapshot | `pendingQuestions` on the run snapshot is projected from the in-memory registry, not replayed from events, since after a process death no promise is waiting; it is the fallback when a notification was dropped |
| Withdrawal | a parked question is withdrawn when its ask is cancelled, when its turn rejects, and when the next ask starts on the same session |

The engine core is unaware of escalation: it happens inside the driver's execution of one ask, writes no node row, and leaves the ask's `inputHash` untouched. After a resume, an ask that was waiting on a question re-executes and the subagent asks again under a new `qid`. The notification the main agent receives, and the GUI's question row, are described in `transcript-and-notifications.md`.

## Search budget

Each ask may make a bounded number of `WebSearch` calls (`docs/dynamic-workflow/authoring.md`, "A subagent's search budget"). Like escalation, the budget lives inside the driver's execution of one ask: the engine core never sees it, it writes no node row and no run event, and it leaves the ask's `inputHash` untouched.

| Element | Behaviour |
| --- | --- |
| Limit | `persona.budget.webSearch` when present, else `DEFAULT_WEB_SEARCH_BUDGET_PER_ASK = 128`; read once when the driver creates the subagent session |
| Count | `webSearchesUsed` on the driver's session state; set to 0 by `startAsk`, not by a nudge or a repair turn |
| Charge | `WorkflowWebSearchBudgetPort.charge()` is called by the `WebSearch` handler before it sends its request; it is synchronous, so parallel calls in one batch are counted exactly. A call outside an ask is not charged and runs, the same as in a session without the port |
| Over budget | `charge()` returns `{kind: "exhausted", limit, message}`; the handler returns a tool error with `WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE` and that message, and sends no request |
| Injection | the driver builds the port per subagent session and passes it through the runtime factory with the submit and escalate ports; a runtime without the port has no budget |

The refusal is an error result rather than a normal one because the `WebSearch` output schema has no field for it, and because the tool error is what usage records count (`tool_usage.status = 'error'`), which makes budget hits visible without a new event. The message asks the subagent to say in its result that its search was cut short; that is how a hit reaches the main agent.

## Holes

A hole is a request from the script to the main agent for code (`docs/dynamic-workflow/authoring.md`, "Holes"). Unlike an escalation, which lives inside the driver's execution of one ask and which the engine core never sees, a hole is a Boundary A call: the script itself waits on it, so the engine owns it the way it owns an ask, minus the driver.

### The text that runs

The `code` a fill delivers is not written by the agent and not built by the harness. It is the effective script's own lowering of the hole's body arrow: lowering returns, beside `code` and `siteIds`, a `holeBodies` map from each filled hole's site id to the printed, type-erased text of its arrow, produced by the same two passes (site rewrite by node identity, then transpile) as the script around it. The live path and a later replay of the effective script therefore execute byte-identical text for that body, and every site inside it carries the same `hole#<hash>/…` id on both (`docs/analysis.md`, "Sites"). What the cell does with it is in "The vm cell".

### The engine's part

```ts
fillHole(fill: {
  siteId: string;
  code: string;                              // holeBodies[siteId] of the effective script
  script: { text: string; hash: string };    // the effective script
  askSpecs: ReadonlyMap<string, AskSpec>;    // the effective script's: a superset of the run's
  sitePhases: ReadonlyMap<string, string>;
  phaseNames: string[];                      // holes by name in their place
  holes?: number[];                          // indexes into phaseNames still open
  scriptPath?: string;                       // the draft this fill minted, when the run had none
  filledBy?: string;                         // the session that filled it
}): { ok: true } | { ok: false; reason: "not_waiting" | "settled" }
```

On `hole` the engine mints the site's next ordinal, stamps the birth phase as for any instance, records `hole-reached {instance, name, prompt?, phaseName?}` and parks a deferred under the site id. It writes no node row: a hole is not a step that settles with a result of its own, and what the fill produced is already in the journal as the effective script. On `fillHole` the engine, in one synchronous step, replaces its ask specs and site-phase table with the effective script's (every old id present, every new one written by this fill: prefixed by the filled hole's id, or a hole nested in it, or inside such a hole's body), writes the script through the port's `updateRunScript(runId, text, hash)`, records `hole-filled`, remembers the code under the site id, and resolves every deferred parked on that site with `{code}`. A later `hole` for the same site is answered from that memory without parking. `fillHole` on a site with nothing parked and nothing remembered is `not_waiting`; on a settled run, `settled`; both write and emit nothing.

`updateRunScript` is the second writer of `script_text` and `script_hash` after `createRun`. The two columns are written together, always, because resume compares one against the other; nothing else in the row is touched, on the `updateRunUsage` model.

### Resume and the lineage

Resume replays the row's script, which after a fill is the effective script: the filled hole's body runs inline, the shim sends nothing, and no `hole-reached` recurs. The `ScriptHashMismatch` check holds because the pair was updated together. A run stopped **while waiting** at a hole resumes to the same request: the script re-reaches the site, a new `hole-reached` is recorded (a hole has no row and no ordinal to collide with), and a fresh notification goes out. Nothing remembers a fill that never arrived.

An amendment inherits the effective script through `getScript` like any other, and the import cache keys nothing by site id, so the fill's asks match on name and hash like everyone else's. `SaveWorkflow` distils the effective script. Nothing on those paths knows the script once had a hole in it, except the `hole` calls still standing in it with their bodies.

### The run snapshot

`holes: [{siteId, ordinal, name, type, state: "waiting" | "filled", since?, filledAt?, filledBy?}]`, projected from `hole-reached` / `hole-filled` events plus the engine's parked set, the way `pendingQuestions` is projected from the registry: after a process death no promise is waiting, and the events alone would report as waiting a hole nothing is asking about. The chip on the run card counts `waiting`; the notification is the primary route and this field the fallback (`docs/dynamic-workflow/transcript-and-notifications.md`).

### The fill service's checks

The run service's `fill` sits beside `amend`. It reads the run's recorded script, locates the hole's call by site id in that script's site table, splices the body as the call's last argument (immediately after the last existing argument, on its own lines, so a trailing comma or a comment before the closing paren stays where it was), and compiles the result with `compileOnce`. Diagnostics are a refusal, mapped to the fill file's lines when they fall in the spliced range and to the draft's lines otherwise (`docs/dynamic-workflow/launch.md`, "The `FillWorkflowHole` tool"). Then two checks a clean compile does not imply: every site id of the previous table exists in the new one at the same source position shifted by the inserted lines, and every id not in the previous table carries the filled hole's prefix. A failure there is a host fault, never the model's: the analyzer's numbering rule has been broken, and the run must not be handed code whose ids it cannot join. Only then does it call `fillHole` with `holeBodies[siteId]`, the new compile product's specs and tables, and the effective script, and write the draft.

## Settlement cleanup

Two obligations follow `run-settled`. First, no ask may outlive its run: `complete`, `stop`, and `fail` all abort in-flight asks before writing the terminal status, so a subagent's turn cannot report into a settled engine and cannot keep spending tokens. Second, the subagent runtimes are released: `driver.dispose()` is called exactly once by the engine after `run-settled`, and it disposes the stall clock, unsubscribes from the governor, withdraws pending redrives, and runs the app's own session-closing chain (`closeBrowserSession`, which also shuts down the runtime and releases any REPL or browser session) for every subagent runtime; a runtime with a turn still landing is closed when that turn settles. Close failures are logged and never fail the settlement. The driver does not close the execution port, MCP, or the session store, which it does not own. The three lookup maps (session, instance, question id) are cleared, so a late `respondToSubmit` or `respondToEscalation` finds nothing and does nothing.

## Runtime error sentences

Every `WorkflowError` and `DriverError` message the engine or the driver produces is an English sentence or two, in a fixed shape: first the fact and what was received, with the instance where it helps (`(at ask#3@1)`); then, when there is one, the remedy, phrased in the facade's own words (`agent(...)`, `world.run`, `artifact.file`, `opts.timeoutMs`), not the engine's. The reader is the model or the script author, whose working language is the session's, so these sentences are not localized; the compile-time diagnostics follow the same rule. Structured fields (`code`, `violations`, `mismatch`, `cause`, `finalText`, `providerStop`) are what tests and callers branch on; the sentences are for reading. Examples in this document are quoted from the code: `Replay hit at <instance> but inputHash differs (expected <a>, got <b>): the script is not deterministic, so the journal cannot be replayed.`, `files.grep: over 2000 matches (the cap). Narrow the pattern or add a glob.`, `world.run: command '<cmd>' is not in the declared set of commands (a wiring error).`

## Engine-side persona

```ts
export interface PersonaSpec {
  name?: string;
  system?: string;
  model?: string;
  budget?: { webSearch?: number };
}
```

The author's `AgentPersona` is `{ system?: string; model?: ModelRef | string; budget?: { webSearch?: number } }` (`authoring.md`); a bare string is the system prompt, and `model` arrives as the name string (a `ModelRef` is lowered to its name). The engine normalizes the second and third arguments of `createActor` into one `PersonaSpec`, carrying the `name` argument into `persona.name` when the persona has none. The effective name is frozen at creation and is what `DuplicateActorName`, the import cache, escalation payloads, and the `ProviderStop` details use. `budget.webSearch` is kept only when it is an integer from 0 to 1024, and a `budget` with nothing kept is dropped. The persona is journaled as JSON on `dwf_actor.persona_json` and compared by canonical JSON, `model` and `budget` left out, when matching an imported subagent: like a model change, a budget change is the user's choice about the work still to come, and must not rerun finished work. There is no model tier and no tool profile on the persona: every subagent has the same tool surface, and the model is the one its persona names, else inherited unless pinned (see "Subagent sessions").

## How progress and completion reach the app and the main agent

The engine produces structured payloads only. Every `RunEvent` becomes, in order, a `dwf_event` row with a sequence, a `DynamicWorkflowRunProgress` session event appended to the parent session with the payload below, and, for a few event types, a queued notification. The transcript cluster owns every rendering of these payloads and every sentence in a notification.

```ts
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  toolCallId?: string;    // the CreateWorkflow call, for the tool card
  sequence: number;       // the journal sequence
  eventType: string;      // the RunEvent type
  payload: Record<string, unknown>;   // the event minus its type, size-bounded
  truncated?: boolean;
}
```

Two enrichments happen at this seam: an event that names a subagent gains `actorSessionId`, minted by the same function the driver uses, so the GUI can open that subagent's transcript — `actor-created`, an ask's `node-dispatched`, and a cached ask's `node-settled`, the last two carrying the same `actor` ref and minting the same id; `run-settled` gains `resumable: true` when the status is `stopped`; `actor-created` gains `model` and an ask's `node-dispatched` gains `actorModel`, the canonical string the run's `modelBindings` give the persona's model name (absent when the persona names none). Cold replay casts its payloads through this same function, so a dispatch read back from the journal arrives in the identical envelope. The progress sink checks that the event belongs to the session it was created for and never throws into the engine.

Notifications are enqueued by the core for `escalation-raised` (kind `escalation`), `hole-reached` (kind `hole`), `run-stalled` (kind `stall`), and settlement (`completed`, `errored`, `stopped` with the initiator and, for `provider`, the `ProviderStopDetails`); their texts, the `<task-notification>` envelope, and the delivery rules are in `transcript-and-notifications.md`. One more notice, the reminder, comes from no run event: the core reminds the main agent when the parent session has stayed idle while a live run has an open question or a waiting hole. The engine and the journal know nothing of it; it reads the run snapshot's `pendingQuestions` and `holes`, and its rules are in the same document under "Reminding an idle main agent". The main agent can also poll: the run snapshot exposes `runStatus`, `stopReason`, `failure`, `reports`, `artifacts`, and `pendingQuestions`, and the event log is readable by cursor through `listEvents`.

## Token telemetry for subagents

Business monitoring attributes model tokens to the message that caused them, as `agent_step` rows and a `message_completion` row per turn (`docs/monitoring/business-monitoring.md`, `docs/monitoring/agent-step-model-token-attribution.md`). A workflow subagent's tokens travel the same path as an `Agent`-tool background subagent's, under a third role, `agent_role = "workflow subagent"`. Two other token ledgers already include workflow subagents and are unaffected: the agent database's `model_usage` rows (`query_source = "workflow_child"`, behind the settings page) and the run's own `spentTokens` above.

**The launch anchor.** Every run remembers the message that launched it. The run service resolves the anchor at submit:

| Entry | `inputId` |
| --- | --- |
| `CreateWorkflow` in chat | the parent runtime's active turn, when the trace's turn id equals the active turn's; otherwise absent |
| direct launch from the hub | a fresh UUID v7, which is also the `inputId` of the control-only launch turn, so the launch turn's run card and the subagent steps hang off one message |
| `AmendWorkflow` | the predecessor's anchor; a predecessor without one falls back to the rows above |
| none of the above | a fresh UUID v7 |
| `resume` | never rewritten: the engine does not create the run again, and the anchor is read back from the journal |

The engine records the anchor once, as `run-launched {inputId, toolCallId?, parentSessionId?, phaseNames?, subagentModel?, subagentPermissionMode?}` right after the first `run-started` of the run's life, and never on a resume; `run-started` itself fires on every resume, which is why the anchor cannot ride on it. There is no SQL column for it, nor for the passengers that ride with it: the declared phase table, the run's subagent model and its subagent permission mode all live in this event alone. `actor-created` and `run-settled` progress payloads carry a derived `launchInputId`: from the submit on a fresh run, read from the first `run-launched` on a resumed one. A run journaled before the event existed has no anchor, so it reports nothing.

**Facts.** The CLI's telemetry fact layer derives `workflow.lifecycle` facts from the parent session's progress events: `{phase: "actor-spawned", runId, agentId, childSessionId, sourceCommandId, toolCallId}` from `actor-created`, with `sourceCommandId` the anchor, and `{phase: "run-settled", runId, status, stopReason?, errorMessage}` from `run-settled`; without a `launchInputId` no fact is emitted. The child session's `ModelComplete` events pass the usage gate as `usage.delta` because their `querySource` is `workflow_child`; the parent's nested `tool_internal` usage with no query source stays excluded, so nothing is counted twice. Tool and permission lifecycle facts from the child session flow as they always did. The parent session never fakes `SubagentSpawned` or `SubagentStopped` for a workflow subagent: those events also drive the session UI and the runtime task registry.

**Steps.** The rendering layer's telemetry supervisor registers each subagent by child session id under the anchor as `messageId`. While the run lives it reports one `tool_call` step with zero tokens per tool call the subagent makes and accumulates usage once per request id; the child session's own `turn.terminal` is ignored, since it ends one ask, not the subagent. When `run-settled` arrives it reports one summary step per registered subagent, then drains late terminal facts for tools already started and forgets the run. Usage arriving after the summary is not reported, and a reload does not rebuild history.

| Field | Workflow subagent value |
| --- | --- |
| `agent_role` | `workflow subagent` |
| `agent_id` | `siteId@ordinal`, the same string as the run pane's subagent label |
| `workflow_run_id`, `child_session_id` | the run id; the child session id (`sess_dwf-…`) |
| `workflow_tool_call_id` | the `CreateWorkflow` call that launched the run; `launch-…` for a direct launch; absent when unknown |
| `tool_call_id` | tool step `tool_workflow_<agentId>_<childToolCallId>`; summary step `tool_workflow_<agentId>_<runId>` |
| `tool_name` | the subagent's real tool for a tool step; `Agent` for the summary step |
| `token_usage_scope`, token fields, `model_request_count` | summary step: `subagent_requests` and the totals over every completed request; tool step: empty and `0` |
| `status`, `error_msg` | summary step: `success` for a completed run, `fail` for `errored` or `stopped`, with the engine's error text when there is one and `Workflow run stopped (<reason>)` otherwise |
| `message_id`, `talk_id` | the anchor; the parent session id |

**Composition.** `message_completion.agent_composition` has a workflow dimension: the three booleans fg, bg and wf give eight values, `main_only`, `main_plus_fg`, `main_plus_bg`, `main_plus_wf`, `main_plus_fg_bg`, `main_plus_fg_wf`, `main_plus_bg_wf`, `main_plus_fg_bg_wf`. `wf` is set the way `bg` is: when the runtime command queue wakes a batch that holds a command whose `originMeta.backgroundSource` is `workflow` (a run's completion or question notification), the turn's `TurnComplete` or `TurnError` payload carries `workflowResultConsumed: true`, and `turn.started.backgroundSource` gains the value `workflow`, so the wake turn's `message_source` reads `background_workflow`.

Boundaries: the legacy `Workflow` tool's children share the `workflow_child` query source, so their usage facts now pass the gate, but nothing registers them and the supervisor drops them as before; a run launched before the anchor existed reports no steps; there is no cap on the number of steps per run, so `agent_step_cnt` stays truthful; workflows do not nest, so `nested_workflow_child` is an unused enum value.

## Verification

Four layers of tests pin this document.

| Layer | Suite | What it holds |
| --- | --- | --- |
| Engine core | `packages/dynamic-workflow/tests/engine/*` with a fake driver | identity and ordinals, the hold rule, repair and nudge, lenient decode, world-read caching, `report` caps, import-cache take, carry and reconcile, phase stamping, usage after settlement, concurrency observations, `run-launched` once per run life, the in-memory journal against the contract suite |
| Sandbox | `packages/dynamic-workflow-runtime/tests/*` with an auto-driver | end to end through a real child process, argument freezing, the bans, entry-file placement and fallback, spawn arguments and environment, failures and interruption mapping, resume, provider stop, usage |
| Driver and service | `packages/bootstrap/tests/workflow-driver*.test.ts`, `dynamic-workflow-run-service.test.ts`, `dynamic-workflow-import.test.ts`, `workflow-actor-transcript.test.ts`, `workflow-escalation.test.ts`, `workflow-actor-model.test.ts`, the git world-read tests against a real repository | the four sequences, the submit-profile guard, message boundaries, the two seeding skips against a real session store, the conditions under which an `inFlight` is and is not built (`dynamic-workflow-import.test.ts`), the bounded quiescence ledger (`workflow-driver-quiescence.test.ts`), amending a predecessor that is mid-ask and reading back the successor's seeded transcript, with and without the carry (`dynamic-workflow-run-service.test.ts`), escalation parking and withdrawal, the model pin table, argument validation, the cancel and resume gates, orphan reconciliation, residency registration of live runs, the close settlement, foreign terminal rows under a live entry |
| Journal | `packages/adapters/tests/dwf-journal-store.test.ts` | the SQLite store against the contract suite, plus the status codec |

### The fault matrix

The terminal-state and model-error policies are exercised end to end against a fake provider rather than a mocked adapter. `FakeProviderServer` listens on the loopback interface and speaks both wires the adapters use, the Anthropic Messages API and the OpenAI chat-completions API, so the real runner, the real retry budget, and the real governor are under test. Each request is judged by a fault program, a pure function from `{ordinal, inFlight, toolResultCount, stream, route}` to a verdict: `serve`, `status` (a body with a provider code, such as a 429 with code 3008 and `retry-after-ms`, a 401 with code 1006, a 429 quota with code 1308 and `retry-after`, a 404 model-not-found, a 400 invalid request, or an unknown code), `reset`, `hang`, `cut` (drop the stream after visible output), `stream_error`, `delay`. Programs are built from combinators: `healthy`, `gate(limit)` (serve at most `limit` in flight, else busy), `failFirst`, `everyKth`, `cutVisibleUntil`, `always`.

Shapes are small scripts that differ only in parallelism, subagent count, and ask count: W1 through W16 are flat fan-outs; S-pipe chains asks; S-nest nests subagents; S-phase adds phases. A cell is one fault program on one shape, run with a compressed clock (backoff scaled by 0.01, a 400 ms stall clock) and asserted against six invariants shared by every cell.

| Invariant | Assertion |
| --- | --- |
| terminal state as expected | the settlement and the journal row agree on `completed`, `stopped{reason}`, or `errored` |
| no subagent lost | every ask row is `completed` on a completed run, and `completed` or `running`, never `failed`, on a stopped one |
| the script never sees a model error | no `node-settled failed`, and no `DriverError` in the run's failure |
| event grammar | every retryable failure has a `retry_scheduled` on the same request; a non-retryable failure appears only in a `stopped(provider)` cell |
| zero requests after stop | any request that reaches the server after `run-settled` plus a 10 ms wire grace is matched by a `cancelled` echo from the runner |
| in-flight bound | the server's peak in-flight count never exceeds the cell's ceiling (8) |

The quota cell (B11) also checks what a resume will meet: right after the stop, a new request on the same provider and model is admitted at once, because a `stop`-class failure moves neither the governor's cap nor its cooldown (`docs/dynamic-workflow/concurrency.md`, "Reading a ticket"). Two lifecycle cells exercise "Engine ownership" on the same bed: B18 closes the service under a live run, B19 writes a foreign terminal row under a live engine. The quick matrix runs in the default bootstrap suite; the full matrix runs when `ZCODE_FAULT_MATRIX=full` is set, with a 30 s ceiling per cell. Two production seams exist for this bed: the driver clock (`now`, `schedule`, `stallAfterMs`, `quiesceMs`) is injectable, and the adapter keeps `retryAfterMs` on its normalized error.

## Alternatives not taken

- A process-wide engine host that sessions attach to, so an engine survives its App's close: the engine's actor runtimes, model factory and progress sink are the App's, so a host would hold an engine whose dependencies were disposed with the App; keeping them alive is a daemon with its own factory and a buffered progress sink, a different project. Residency registration removes the only close that happened without the user asking.
- A cross-process owner lease on the run row, or a desktop that refuses to open a session attached elsewhere: only the unsupported two-instance case needs them.
- A wall-clock timeout on the sandbox in production: the harness supports one, but a long-running run with a healthy subagent is legitimate, and cancellation and the stall notice cover the failure mode.
- A timeout on `escalate`: a synthesized answer is the exact hazard the tool exists to prevent; cancellation is the escape.
- Treating a permanent provider error as an ask failure the script could catch: the script would then branch on infrastructure state, and every author would have to write the same retry; `stopped(provider)` keeps the run resumable once the cause is fixed.
- A `pending` state for questions replayed from `escalation-raised` events: after a process death no promise waits for the answer, so the registry is the only truth.
- Closing the import cache at the first live ask, or per subagent by a declared tool profile: the first is a clock standing in for a dependency check and throws away every later hit of a fan-out; the second needs a profile the persona no longer declares. The rule is the first observed write, with pure asks exempt.
- Tracking each cached ask's read set (paths and content hashes) so that a tool-using ask survives the close when nothing it read has changed: the precise rule, kept for later if per-item chains with tool-using subagents turn out to lose too much cache. It drops in behind the same lookup.
- A migration to three physical status values: the codec maps the five old values losslessly, so no schema change is needed.
- A per-actor `submit_result` registration decided by the driver at runtime: the driver lacks the site graph, so the profile is computed at compile time and only guarded at runtime.
- Truncating world-read results at the cap instead of rejecting: a silent partial glob once collapsed a six-way fan-out into one lane, and the wrong view would have been journaled and replayed.
- A `modelFailureReason` field on the run failure: superseded by `ProviderStopDetails`, whose `kind` is the key notifications read.

## Open questions

- The `ResumeWorkflowRun` contract's description and the port's `resume` comment still describe the resumable set as cancelled runs plus `Interrupted` failures; the handler and the service use `stopped`.
- The run snapshot's base `status` folds `stopped` into `cancelled` and `errored` into `failed` for the background-task tracker; `runStatus` and `stopReason` carry the truth beside it. Whether the tracker's vocabulary should grow is open.
- `world.run` with an explicit `undefined` third argument arrives as `null` after the JSON round trip and is rejected as not an options object.
- The `escalate` question is validated only for non-emptiness; no length cap exists on the wire, though the notification is capped at 4,000 characters.
- If the process dies between the predecessor's `stopped(superseded)` settlement and the successor's `createRun`, the predecessor points at a run id that does not exist. The window is a few microtasks wide; the snapshot reports `supersededBy` as recorded, and the model's next amend of that predecessor is allowed as for any settled run.
- A `phase()` marker inside a concurrent fan-out callback stamps the wrong instances, because the engine keeps one current phase for the run; per-async-context attribution would lift the rule that markers stay outside callbacks.
