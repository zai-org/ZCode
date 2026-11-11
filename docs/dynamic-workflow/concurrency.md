# Dynamic Workflow: Concurrency (spec)

Status: implemented. This document describes how many model requests a workflow run may
have in flight and how that number moves; its sibling
`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` owns what happens to a
run when a model error is not recoverable.

## Two bounds on a run

A model provider limits an account, not a machine. Every run in a CLI process, and the
main agent's own conversation, draw on the same quota, and the provider tells them so only
by refusing requests. The runtime therefore keeps two bounds and the effective concurrency
of a run is the smaller of the two:

| Bound | Unit | Set where | Moves? |
|---|---|---|---|
| the run's own bound, `caps.maxConcurrency` | asks in flight per run | at submit: the default parallelism, or the `max_concurrency` the call carried, floored to a whole number of at least 1; stored on `dwf_run`, reused on resume | yes, by a live retune: the user moves it from the settings popover, or the model moves it on the user's behalf with an `AmendWorkflow` carrying only `max_concurrency` ("Retuning a live run") |
| the shared cap | model requests in flight per provider key, per process | learned by the governor from provider feedback, between the floor of 1 and the key's growth limit | yes |

Both start from the same number, the **default parallelism** D:
`max(4, min(16, availableParallelism() − 2))`, computed once per process by
`resolveWorkflowDefaultConcurrency` in `packages/bootstrap`. D is a starting point, not a
limit. It is the bound of a run that asked for none, the cap a governor bucket starts at and
returns to after an idle reset, and the concurrency of the legacy `Workflow` tool and the
snippet service. The floor of four exists because the formula once also capped every run, and
on a small machine or a small remote host `cores − 2` came out at one or two: subagents wait on
a remote provider, not on local cores, so the core count is a weak signal at the bottom of its
range.

The engine's scheduler enforces the first bound at dispatch and knows nothing of the second:
it dispatches an ask when the subagent is idle and fewer than `maxConcurrency` asks are
active. A bound that moves while the run is going needs a second enforcement point below the
driver, because an ask already dispatched cannot be taken back; that is the seat gate of
"Retuning a live run". The shared cap lives entirely below the driver too, in the model
runner, and is the subject of the rest of this document.

The run's own bound is D unless the `CreateWorkflow` or `AmendWorkflow` call that started the
run carried `max_concurrency`. That value is floored to a whole number of at least 1 and has
**no upper limit**: a user who asks for 40 subagents at once gets 40, above D as readily as
below it. Its unit is the scheduler's: asks in flight, which is subagents working at once, not
model requests. The knob exists so a user can make a run less parallel or more parallel than
the default, and the model sets it only when the user asks — never against a provider's
limits, which are the shared cap's business. The tool field and the confirmation window are in
`docs/dynamic-workflow/launch.md`.

Only that same decision moves the bound again. Nothing in the runtime retunes a run on its
own: the governor answers provider pressure with the shared cap, and the run's own bound says
what the user asked of this run.

A bound above D is only worth something if the shared cap can follow it, because every
subagent's model requests go through the governor. The governor therefore lets its auto-growth
rise to **twice D** on its own, and further only as far as a live run asked for: a bucket's
growth limit is the larger of 2D and the largest bound among the live runs that have sent
requests on that key ("The governor"). Provider refusals still cut the cap wherever it stands.

Where this document ends: the runner retries a model request inside the subagent's turn,
without limit, until the request succeeds, the user cancels, or the error is one the
policy table calls deterministic. What the run does *then*, stopping as `stopped(provider)`,
failing the node with `ContextLimit`, or redriving the turn after backoff, is the engine's
contract, described in `execution-engine.md`. The engine core itself takes no decision on
any of this: it records the observations the driver reports (`node-waiting`,
`node-executing`, `concurrency-changed`, `run-stalled`) and nothing else, so replay stays
byte-identical and dispatch order stays unjournaled.

## Retuning a live run

A user who finds a run too parallel should not have to pay for the throttle with the run's
work. A change that touches **only** `max_concurrency`, on a run that is **live**, applies in
place: the same run id, no successor, no supersede, no confirmation window, and nothing in
flight is stopped. Everything else — a revised script, a different `subagent_model`, any change
at all to a run that is no longer live — is still an amendment, at the price
`docs/dynamic-workflow/launch.md` describes. There is no window because there is no script to
put in front of anyone: the call moves one number on a run that is already executing code that
was approved (`docs/dynamic-workflow/launch.md`, "Changing only the parallelism of a live
run").

The value is floored to a whole number of at least 1 like any other, with no upper limit;
`null` (from the GUI or the tool) means "no bound of the run's own" and applies the default
parallelism D; a value equal to the bound in force is refused as `unchanged` rather than
written again. Raising works as readily as lowering, above D included.

### Two enforcement points

Setting a bound and moving one are different problems. At submit the scheduler is the whole
enforcement: no ask has been dispatched, so a bound of two never dispatches a third. Mid-run
there are asks the scheduler cannot take back — a subagent admitted under a bound of eight is
in the middle of a turn, with a transcript, a tool call and a provider request of its own. So
the run's own bound is enforced twice, once where asks start and once where their requests go
out:

| Point | Where | What it enforces | What a change does |
|---|---|---|---|
| the scheduler | the engine, `engine/scheduler.ts` | dispatches an ask only while fewer than `caps.maxConcurrency` asks are active | a raise dispatches at once; a cut lets the excess drain as asks settle |
| the seat gate | the driver, `packages/bootstrap`, one per run | holds a working subagent's **next turn step** until a seat is free | a cut parks the excess within one model request; a raise unparks |

The scheduler alone would be honest but slow: an ask is a whole subagent turn and lasts
minutes, so "at most two at once" asked of a run with eight live asks would mean nothing for a
long time. The seat gate is what makes the number true now without cancelling anything: the
subagents over the limit finish the request they are in and then wait, keeping their session,
their transcript and their place in the run.

`caps` is therefore mutable and the scheduler reads it live — `host.caps` is a getter, not a
copy frozen at construction — so every pump sees the number in force.

### Park and unpark

The gate holds two things: `working`, the subagents with a live ask that are not parked, and
`parked`, a FIFO of those waiting for a seat. It is pure: no clock, no I/O, no subscription. Its
two facts come from what the driver already observes, and it keeps no second account of either.

| Rule | Behaviour |
|---|---|
| Park | a subagent makes a turn-step model request while `working.size > limit`: `tryAcquire` returns `undefined`, so the runner publishes `model_request_queued` and the driver reports `askWaiting(slot)` — the same 「等待槽位」 the shared cap produces; `acquire` then waits for a **seat** first and for the governor (`tryAdmit` / `admit`) second |
| Unpark | the head of the FIFO takes a seat whenever an ask settles or the limit rises, while `working.size < limit` |
| Abort | a seat wait honours the request's `AbortSignal`: the waiter leaves the FIFO, the promise rejects with the signal's reason, and the subagent **returns to `working`** (below) |
| Pass-through | while `working.size <= limit`, `acquire` returns without touching any state and `tryAcquire` goes straight to the governor: a run whose bound was never lowered takes that branch every time, so the fast path is untouched and nothing new is emitted |
| Both or neither | the gate wraps a governor port; where an assembly has none, the gate invents nothing and the subagent is ungoverned as before |

Parking between turn steps is what keeps a park cheap. A parked subagent holds no ticket, no
provider request and no tool; it is waiting in the same place the shared cap already makes
requests wait, which is why every surface that says 「等待槽位」 already means what it says and
no new wait vocabulary is needed.

**Where the two facts come from.** An ask's start is `startAsk`, where the driver already
resets the subagent's per-ask state. Its end is the engine's `node-settled`, read through a
wrapper around the driver's `emit`, which the engine calls for every event it records: that
event is the single exit of all three settlement paths, and it is the only honest end signal the
driver has — `currentInstance` is never cleared and an untyped ask is still `live()` after the
engine has settled it, so a gate reading either would hold a seat forever and the FIFO would
wait for nothing. The wrapper forwards the same object reference it was given, because the
launch's sequence capture matches events by identity. A `node-settled` for an instance the gate
never saw start — a cache hit, a world node — is a strict no-op: no seat is freed and nobody is
unparked.

**An abort ends a request, not necessarily an ask.** A transient redrive, a stream recovery, any
per-request signal can abort a parked waiter while its ask goes on, so the waiter is put back
into `working` on its way out: inside this gate, "not parked" has exactly one meaning, "working",
and a subagent left outside both sets would pass every later turn step ungated and never be
counted again, letting the effective limit drift upward. Adding it back may put `working` over
the limit for a moment, which is the same legal transient as the instant the limit is lowered:
the next subagent to ask for a turn step parks, and the count converges. When that ask really
does settle later, it frees no phantom seat — unpark's `working.size < limit` guard cannot be
satisfied by a set that was already at or above the limit when the parking happened. A signal
already aborted when the request arrives is refused on the spot, without ever entering the FIFO.
An ask that settles *while* its subagent is parked is removed from the FIFO and its waiter
rejected, and frees no seat either, because a parked subagent never held one.

**The `ensureSession` window.** The scheduler counts an ask at `pumpActor`, while the gate only
learns of it at `startAsk`, and between the two sits session creation. A cut that lands inside
that window is still enforced: the late subagent's `startAsk` pushes `working` over the new
limit, so its first turn step parks like everyone else, nobody is counted twice, and the counts
converge to the bound.

### Why a tool's own requests never park

A model request a tool makes inside a subagent's turn ("Tool-side requests") passes the same
admission port as the turn itself, and the seat gate must not hold it: that subagent is already
working, so it already holds a seat, and a WebSearch queued behind its owner's own seat would
wait for itself. The admission call carries only `{model}` and cannot say what it is for, so
the gate reads the fact the driver already keeps for that subagent — whether it has a tool call
in flight. A request made while a tool is running is tool-side and passes; a request made with
none is the next turn step and may park.

### One bound, two counters, no shared state

The scheduler and the gate share no state and never call each other. What keeps them consistent
is arithmetic:

```
activeAsks = working + parked
```

A parked subagent's ask is still active, so it still counts against the scheduler's bound.
Whenever anyone is parked, `activeAsks ≥ limit` and the scheduler dispatches nothing: it can
never put a new subagent in front of a parked one. And since `limit ≥ 1`, and a subagent parks
only because it was over the limit, someone is always working: the last seat is never empty
while the FIFO is not. There is no deadlock at any limit, one included.

### The control path

`RunControl` is the handle a live run exposes to its owner — one method, "set this run's
maximum concurrency to n". The run service creates one per live entry, and it travels the way
`escalationRegistry` and the cancel signal travel: through `launchDynamicWorkflowRun` into the
harness (`packages/dynamic-workflow-runtime`, `harness.ts`), which takes it as a binding port
and hands it the engine once the engine exists, and into the launch, which hands it the seat
gate together with the run's registration with the governor, so a retune moves both enforcement
points and the growth limit of the keys the run uses in one call. What the harness receives is
narrowed to the one method, not the whole engine: the control plane is a command channel, not a
second way to read a run.

```ts
retuneConcurrency(input: { runId: string; maxConcurrency: number | null }):
  | { ok: true;  maxConcurrency: number; previous: number; defaultConcurrency: number }
  | { ok: false; reason: "not_live" | "unchanged"; current?: number };
```

`null` is the default parallelism, so the caller passes the user's "no bound of my own" on as
itself and the port answers with the number it actually applied, floored to at least 1. The
three fields of the answer are the three a caller needs and none of them is derivable twice:
`defaultConcurrency` is what lets the response say "back to the default" instead of naming a
number, `previous` is
the left-hand side of the event-log line and of the settings turn's `{from, to}`, and `current`
on an `unchanged` refusal is the bound already in force, so the refusal can name it. Both
callers — the `AmendWorkflow` handler and the GUI's `amendWorkflowRunSettings` — read the same
answer, so there is one definition of what a retune is.

```
caller (tool / GUI)          run service              engine                        seat gate
 retuneConcurrency({runId,n}) ─▶ live entry with a bound control?
                                 no  ─▶ {ok:false, not_live} ─▶ caller falls through to a real amend
                                 n (or D, for null) == the bound it holds
                                     ─▶ {ok:false, unchanged, current}
                                 yes ─▶ control.setMaxConcurrency(n)
                                          run already settled ─▶ false ─▶ {ok:false, not_live}
                                          else: caps.maxConcurrency = n
                                                journal.updateRunCaps(runId, caps)
                                                record run-caps-changed {caps, previous}
                                                raise ─▶ scheduler.pumpAll() ────────▶ unpark to the new limit
                                          governor.setRunBound(runId, n)   (the bucket's growth limit)
                                 registry copy of maxConcurrency updated
                               ◀─ {ok:true, maxConcurrency, previous, defaultConcurrency}
```

"Live" here means what the run service can act on: an entry it holds with a control bound to a
built engine. A run that has settled, one another process owns, and a `pending` run whose
engine is not built yet are all `not_live`, answered at once — a call is never held waiting for
an engine to appear — and the caller treats the three alike. It is the last of them that keeps
the settings popover from promising the in-place wording on a pending run
(`docs/dynamic-workflow/presentation.md`, "The settings popover").

The two refusals are decided in different places, which is what keeps them apart. `unchanged`
is the run service's own answer, read from the bound it already holds for that run, before the
setter is called at all. The setter therefore says `false` for one remaining reason — the run
settled under it — and the port reports that as `not_live`.

`not_live` on a run that was live is the race: it settles between the caller's liveness check
and the call. The engine's setter ignores it, because a settled run's caps are history, the
port reports it, and the caller does what it would have done for a run that had already
settled — a real amend, which the tool guards so that a race cannot start a run nobody
approved (`docs/dynamic-workflow/launch.md`, "Changing only the parallelism of a live run").
Nothing is half-applied: the setter writes the caps, the journal row, the event and the pump in
one synchronous slice, or writes nothing at all.

The run service also updates its registry copy of the run's `maxConcurrency`, so the snapshot,
the run detail and `GetWorkflowRun` report the new bound at once rather than the submitted one.

### What a retune writes

| Where | What |
|---|---|
| `dwf_run.caps_max_concurrency` | `journal.updateRunCaps(runId, caps)`, the column's second writer beside `createRun`. A resume reads the row, so a retuned run resumes at the bound it was retuned to, not the one it was submitted with |
| `dwf_event` | `run-caps-changed {runId, caps, previous}`, recorded through the engine's one `record` function like every other event, so a cold replay of the journal mints the same bytes the live run emitted |
| the governor, in memory | the run's registered bound, which may raise or lower the growth limit of every key the run has used ("The governor") |

No migration: the column already exists and already holds this number.

## One ticket per request attempt

The unit the shared cap counts is one **attempt** of one model request. Before the runner
sends an attempt it takes a ticket from the admission port; when the attempt ends, by
success, failure, cancellation, or the consumer abandoning the stream, it returns the
ticket. Nothing else holds a ticket:

- A backoff sleep holds no ticket. The slot goes to someone else; the retry takes a new
  ticket when it wakes.
- Tool execution holds no ticket. A subagent running a ten-minute Bash command occupies no
  slot.
- A model request made *inside* a tool (WebSearch, WebFetch processing) takes its own
  ticket. A subagent that fans out three searches in parallel holds three tickets. The cap
  is therefore exactly "requests the provider sees at once", and it is not a bound on
  subagents.

```ts
interface ModelRequestTarget { providerId: string; modelId: string }   // the quota key, nothing more

interface ModelRequestAdmission {
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined; // sync fast path
  acquire(input: { model: ModelRequestTarget; signal?: AbortSignal }): Promise<ModelRequestAdmissionTicket>;
}

interface ModelRequestAdmissionTicket extends ModelStatusSink {  // the ticket is also the attempt's status sink
  release(): void;                                              // idempotent fallback
}
```

The ticket doubles as the attempt's status sink: the runner publishes the attempt's
`ModelNetworkStatus` events (`model_request_started`, `model_request_completed`,
`model_request_failed`, `model_retry_scheduled`) to the ticket as well as to the session,
and the governor reads the outcome from those events. `release()` only matters when no
terminal event arrived; it is idempotent, and the runner calls it both before every
backoff sleep and in the attempt's `finally`.

### Where the port is bound

The port is a runtime-only field, `modelRequestAdmission`, that never enters a JSON schema
or a provider request. It is bound once, in `createRuntimeModel` in `packages/core`: every
`Model` handle a runtime hands out is wrapped with a runtime-level invocation context that
carries the admission port and the retry budget. The wrapping is authoritative over the
call-site context, so a turn step, a WebSearch, a WebFetch processing call, compaction, the
title sidecar, or a memory agent all pass the gate without knowing it exists. The port
answers "who is calling", which the runtime knows when it builds the handle; the call site
answers only "why".

When one runtime's handle is wrapped by another runtime's layer, the **outer** layer wins,
that is the runtime that actually makes the call: a subagent that inherits its parent's model
reuses the parent's handle (`createInheritedSubagentModelFactory`), and the parent's layer,
being nearer the adapter, used to override the subagent's, so the subagent's requests carried
the parent's port, retry budget and session type (`main`, which also reached the provider as
the session-type header). An inner runtime layer now passes through when an outer one has
already applied; a runtime layer still overrides the call site. The "already applied" marker
travels inside the invocation context itself, because an inner layer can be reached late: the
off-peak wrapper's `streamText` is an async generator that calls the handle inside it only on
the first `next()`, after it has waited for a ticket, and only the invocation context is carried
across that boundary (`runWithModelInvocationContext` re-enters it for every `next()`).

| Runtime | Port | Effect |
|---|---|---|
| a workflow subagent (`taskType` `workflow_child` or `nested_workflow_child`) | the driver's per-subagent wrapper over the run's seat gate and the governor | takes a seat when the run's own bound was lowered under it ("Retuning a live run"), then queues at the governor's gate; feeds signals |
| the main agent, and its tools and sidecars | the governor's **observer** | never queues, never waits for cooldown; counts in flight and feeds signals |
| a subagent of the main agent (`taskType` `subagent_child`, the `Agent` tool), and its tools and sidecars | the governor's **session subagent pool**, one per parent session | queues at the governor's gate and waits for cooldown like a workflow run; feeds signals |
| a subagent of the legacy `Workflow` tool | none | ungoverned: no gate, no signals |
| a snippet evaluation (`EvalWorkflowSnippet`) | none | its driver has no ask path |

The main agent is an observer because its turn must never block behind workflow traffic,
and it still feeds the controller because the provider sees its requests too: a 429 on the
user's own conversation lowers the workflow cap.

A subagent of the main agent is **not** an observer. It used to inherit the observer from its
parent, and a turn that fans out ten `Agent` calls then sent ten request streams that neither
queued nor honoured a Retry-After, each retrying on its own backoff: in production the
subagents were the largest source of rate-limit refusals (2026-10-20: 46% of the sampled
1302s, against 21% for main-agent turns), and they kept refusing the workflow runs and the
user's own turn too. The main-agent rule protects the user's turn, which a subagent is not:
it is delegated work, the same kind of work a workflow subagent does, so it takes the same
gate. The governor exposes one admission per parent session, `sessionSubagents(parentSessionId)`:

- Its run identity is `\0subagents:<parentSessionId>`, so all the subagents of a session share
  **one** queue and take one turn in the round robin (below) next to each workflow run. A turn
  that fans out ten subagents gets one share of a saturated bucket, not ten.
- It neither registers a bound nor subscribes; it does not join a bucket's `runs`, so it never
  lifts the growth limit and leaves nothing behind when the session goes away.
- `tryAcquire` is the fast path, so a queued subagent request publishes `model_request_queued`
  and `model_request_admitted` like a workflow subagent's, and a tool deadline pauses for the wait.
  The `Agent` tool itself has no deadline, so a long cooldown cannot time a subagent out.
- A user cancel aborts the request signal, which takes the waiter out of the queue.
- The parent's foreground `Agent` call holds no ticket while it waits for its subagents (tool
  execution holds no ticket), so the parent waiting on a queued subagent cannot deadlock.

The runtime binds it at spawn time: `AgentRuntimeDeps.subagentModelRequestAdmission` is a
factory the core calls with its current session id when it builds a subagent runtime; an
assembly without it leaves the subagent on the parent's port, as before. Subagents cannot
spawn subagents, so the pool has no nesting.

### One attempt, start to end

```
runner attempt n           admission (per subagent)       governor bucket           session events
  tryAcquire ─────────────▶ port.tryAdmit(run, key) ──▶ inFlight < cap, not cooling, nobody waiting?
                            ◀── ticket(epoch e) ──────── yes: admitted, inFlight++
  (miss) publish model_request_queued ───────────────────────────────────────────▶ driver: waiting(slot)
         await acquire ───▶ port.admit(run, key, signal) → queue, round-robin across runs
                            ◀── ticket(epoch e) ────────
         publish model_request_admitted { queuedMs } ────────────────────────────▶ tool deadline resumes
  send request; publish model_request_started ───────────────────────────────────▶ driver: executing
  200 → publish model_request_completed ──▶ ticket → succeeded(e): inFlight--, streak++
  429 → publish model_retry_scheduled ────▶ ticket → throttled(e, reason, retryAfter): inFlight--, cap↓?
         release(); sleep(backoff, abortSignal); next attempt takes a new ticket
  finally release()  (no-op if already settled)
```

An abort while waiting at the gate rejects `acquire` with the signal's reason; the runner
records it as a cancelled failure in the connect phase, the same path a cancelled backoff
sleep takes.

## The controller

`ConcurrencyController` in `packages/dynamic-workflow` (`engine/concurrency.ts`) is a pure
state machine for one provider key: it reads no clock, does no I/O, and answers only
"what is the cap now, may a request be admitted, did this signal change the cap". It is an
AIMD controller, additive increase and multiplicative decrease, with two additions: a
remembered good level, and an epoch stamp that makes a burst of refusals count once.

```ts
interface ConcurrencyControllerSnapshot {
  key: string;             // `${providerId}/${modelId}`
  initial: number;         // the default parallelism D: start value and idle-reset value
  growthLimit: number;     // auto-growth never takes the cap above this; set by the governor
  cap: number;             // requests allowed in flight right now
  epoch: number;           // incremented on every throttle verdict
  inFlight: number;        // admitted, not yet released (observer requests included)
  waiters: number;         // queued at the gate (fed by the governor)
  successStreak: number;   // consecutive current-epoch successes since the last throttle
  cooldownUntil?: number;  // Retry-After freeze on new admissions
  lastRequestAt?: number;  // for the idle reset
  lastThrottledAt?: number; // the most recent refusal of any epoch; blocks a seed for five minutes
  lastGood?: number;       // highest cap proven by a full streak
  lastBad?: number;        // cap at the most recent throttle
}
```

| Constant | Value |
|---|---|
| `CONCURRENCY_DECREASE_FACTOR` | 0.75 |
| `CONCURRENCY_INCREASE_STEP` | 1 |
| `CONCURRENCY_INCREASE_AFTER_SUCCESSES` (K) | 4 |
| `CONCURRENCY_FLOOR` | 1 |
| `CONCURRENCY_IDLE_RESET_MS` | 300 000 |
| `WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR` (bootstrap) | 2 |

The constants are named exports, not configuration; there is no environment variable or
config key for any of them.

### Signals

| Method | Effect |
|---|---|
| `canAdmit(now)` | `inFlight < cap` and not in cooldown |
| `observe(now)` | idle-reset check only; the governor calls it on every admission path so an idle bucket resets before it admits |
| `admitted(now)` | `inFlight++`, `lastRequestAt = now`; returns the current epoch, which the request carries back |
| `succeeded(now, epoch)` | `inFlight--`; a current-epoch success extends the streak and may raise the cap |
| `throttled(now, epoch, reason, retryAfterMs?)` | `inFlight--`, streak reset, cooldown extended; a current-epoch throttle lowers the cap and turns the epoch |
| `failedTransient(now)` | `inFlight--`, streak reset, cap unchanged (timeouts, 5xx, network errors) |
| `ended(now)` | `inFlight--` only (permanent failure, cancellation, a ticket released without a terminal event) |
| `waiters(now, count)` | records how many requests are queued |
| `setGrowthLimit(now, limit)` | moves the growth limit (at least `initial`); a limit below the cap pulls the cap down to it, with reason `limit_lowered` |
| `seed(now, target)` | jumps the cap up to `min(target, growthLimit)`, with reason `seeded`, unless the target is not above the cap or a refusal arrived in the last five minutes |

Every signal returns the list of cap changes it caused, usually none or one; an idle reset
followed by a throttle yields two. The governor fans each one out unchanged as a
`concurrency-changed` event.

### The epoch rule

Each admitted request carries the epoch it was admitted under. A throttle verdict
increments the epoch. A refusal changes the cap only when its request's epoch is the
current one, that is, when the request was sent under the cap now in force. A refusal
from an older epoch was a verdict on a cap that has already been cut; it still resets the
streak and still extends the cooldown, but it moves nothing and emits nothing.

This is what damps a burst. Thirteen requests go out under cap 13 and eight of them come
back 429: the first one cuts the cap to 9 and turns the epoch, the other seven are old news.
The next cut must come from a request admitted under cap 9, so the controller never cuts
twice for one wave, and never waits for a wave to drain before it can cut again. Successes
follow the same rule: only a current-epoch success extends the streak, because an
old-epoch success proves that backoff thinned the load under the old cap, not that the new
cap could be higher. The epoch turns even when the cap is already at the floor and the
number did not change, so one batch can only ever trigger one verdict.

### Decrease

On a current-epoch throttle:

- If `lastGood` is set and `cap > lastGood`, the controller was probing above a proven
  level: `lastBad = cap`, `cap = lastGood`. No factor is applied.
- Otherwise the wall itself has moved down: `cap = max(1, floor(cap × 0.75))`,
  `lastBad = old cap`, and `lastGood` is cleared, because it was just disproved and the new
  cap has not been proven by any streak.

A `concurrency-changed` event is emitted when the cap changed **or** the throttle carried a
Retry-After, so a floor-level 429 with a Retry-After still tells the run header about the
cooldown.

### Increase

On a current-epoch success the streak grows. When it reaches K = 4 the current cap is
proven: `lastGood = max(lastGood, cap)`, whether or not anyone is waiting and whether or
not the cap is at the growth limit. Then, only if `waiters > 0` and `cap < growthLimit`, the
cap rises by one and the streak resets. An idle process never drifts upward on its own; it
climbs only when a run is waiting for a slot. `lastBad` is recorded for observability and does
not block probing.

The growth limit is the one number the controller does not own: the governor sets it
("The governor") and may move it either way at any time. Raising it changes nothing at once;
the cap climbs to it one step per streak, like any other climb. Lowering it below the cap pulls
the cap down to the new limit on the spot, emits a change with reason `limit_lowered`, clamps
`lastGood` to the limit, resets the streak and turns the epoch, because a refusal of a request
sent under the higher cap is no verdict on the lower one. It never goes below `initial`.

**Seeding.** The one other way the cap rises is a jump the governor asks for when a user raised a
run's bound ("The governor"). `seed(now, target)` sets the cap to `min(target, growthLimit)` at
once, emits a change with reason `seeded`, clears `lastGood` and `lastBad`, resets the streak and
turns the epoch. Clearing `lastGood` matters: the seeded level is a new starting point, not a
probe above a proven one, so the first refusal at it cuts by the factor (32 → 24 → 18 …) instead
of falling all the way back to the old proven level. It is refused, and changes nothing, when
the target is not above the cap, or when any refusal — of any epoch — arrived within the last
five minutes (`lastThrottledAt`, the idle-reset window): a seed then would knowingly rerun a
burst against a limit the provider has just shown, so the cap climbs one step per streak
instead.

### Cooldown and idle reset

A throttle with a Retry-After sets `cooldownUntil` to the later of its current value and
`now + retryAfterMs`. Cooldown gates **new admissions only**; requests already in flight are
untouched, and a retry that wakes during cooldown simply waits at the gate.

If a key has seen no admission for five minutes and nothing is in flight, the next signal of
any kind first resets the bucket: cap back to `initial` (D), streak, cooldown, `lastGood` and
`lastBad` and `lastThrottledAt` cleared, epoch turned. Rate limits are per-minute windows; a cut learned an hour
ago is stale evidence. The reset is lazy, there is no timer, and it is idempotent when the
bucket is already clean.

### A run against a real limit

D = 13 (growth limit 26), provider actually accepts 5:

```
cap 13, epoch 0: 13 requests out; 8 hit 429
  first 429 (epoch 0 = current)  → cap 9, lastBad 13, lastGood absent, epoch 1; concurrency-changed
  remaining 7 (epoch 0 ≠ 1)      → inFlight--, streak reset; nothing else
  retries wake: inFlight 5 < 9   → 4 admitted under epoch 1, the rest queue (waiting: slot)
  an epoch-1 request hits 429    → cap 6, epoch 2         (a real verdict on cap 9)
  an epoch-2 request hits 429    → cap 4, epoch 3
  4 successes with waiters       → lastGood 4, cap 5;  4 more → lastGood 5, cap 6
  6 hits the wall (cap > lastGood) → back to 5, lastBad 6
  from here: every 4 successes probe 6 once, at the cost of one 429
```

The steady state sits at the real limit and probes one level above it every K successes.
The price is one refused request per probe, plus one Retry-After cooldown per probe on
providers that send the header.

## The governor

`WorkflowConcurrencyGovernor` in `packages/bootstrap` (`workflow-concurrency-governor.ts`)
is a process-wide singleton, `getWorkflowConcurrencyGovernor()`, holding one bucket per
provider key `${providerId}/${modelId}`. Each bucket is a controller plus a queue. It is the
only place in the design that touches a clock or a timer: the controller receives `now`, and
a cooldown expiry needs a wake-up to release waiters.

A bucket is created on the first admission for its key, at the default parallelism D. It is
never reset when runs come and go; a new run inherits whatever the bucket has learned, and only
the five-minute idle reset forgets it. There is no process-wide total across keys: two models
on one provider are two buckets, and their in-flight sum is bounded by nothing but their own
caps. Keying by
model is also what keeps a run whose subagents were pointed at another model
(`docs/dynamic-workflow/launch.md`, `subagent_model`) out of the main agent's way: its asks
land in that model's own bucket, so a cap the governor learns for the subagents' model never
throttles the main agent's, and the other way round.

The driver sees a narrow port:

```ts
interface WorkflowConcurrencyPort {
  tryAdmit(runId, key): ModelRequestAdmissionTicket | undefined;              // sync; only when nobody is queued
  admit(runId, key, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>; // queue until admitted; abort rejects
  subscribe(runId, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId, bound: number): void;   // the run's own bound, at launch and on every retune
  clearRunBound(runId): void;                // the run's launch has settled
}
```

**The growth limit.** How high a bucket's cap may climb on its own is decided per key:

```
growthLimit(key) = max(2 × D, largest bound among registered runs that have used key)
```

A run registers its bound when its launch starts and on every retune, and clears it when the
launch settles; a run "has used" a key once it has asked for admission on it, fast path or
queue. So a run left at the default, or lowered, never lifts anything, and 2D is what the
cap may reach by probing when several runs share a key or subagents' tool calls add requests
of their own. A run the user raised to 40 lifts the growth limit of the keys it uses to 40 for
as long as it lives, and **seeds** the cap there: at the same moments the growth limit is
recomputed, the governor calls `seed` with the largest bound among the registered runs using
the key, so the cap jumps to 40 at once rather than climbing one step per four successes. A
provider that cannot take 40 answers with 429s, and the cap comes down by the factor, one cut
per wave (the epoch rule), to where the provider holds; a refusal in the last five minutes
suppresses the seed and the cap climbs instead. A run at the default never seeds: its bound is
D, and the cap is below D only after a refusal. When that run settles or is retuned down, the
limit falls back, and a cap above the new limit is pulled down to it (`limit_lowered`), so a cap
learned for one large run is not inherited by default runs. Both kinds of change are fanned out
to the runs engaged on the key and to every run registered on it, so the run whose retune caused
a seed hears of it even with no request in flight.

```
bucket glm-flash (D = 6)                     growthLimit     cap
  run A (bound 6) admits                     max(12, 6) = 12  6 → climbs while A waits, ≤ 12
  run B (bound 20) admits                    max(12, 20) = 20 ─▶ 20 at once (seeded), unless a 429 in the last 5 min
  run B settles → clearRunBound(B)           12              > 12 ─▶ 12   (limit_lowered)
  5 min idle                                 12              ─▶ 6          (idle_reset)
```

| Rule | Behaviour |
|---|---|
| Fast path fairness | `tryAdmit` returns `undefined` whenever anyone is queued on the key, even if the gate is open, so a request-dense run cannot bypass another run's queue |
| Round-robin | waiters are queued per run; each release, each admission and each cooldown expiry drains the queue, granting to the next run after the one granted last |
| Cooldown wake | when waiters exist and a cooldown is set, a single unref'd timer fires at the deadline and drains |
| Abort | an aborted waiter is removed from its queue and its promise rejects with the signal's reason |
| Fan-out | a cap change reaches every run that has a request in flight or queued on that key; the observer's requests count as no run |
| Fan-out before decrement | a ticket settles by fanning out the changes it caused, then decrementing the run's in-flight count, so the run whose only request caused the cut still hears about it |
| Old tickets | a cut never recalls admitted tickets; `inFlight > cap` is a legal transient state meaning "nobody new gets in until it drains" |
| Growth limit and seed | recomputed for a key whenever a registered run first uses it, a run's bound changes, or a run clears its bound, and a seed to the largest registered bound is attempted at the same moments; the observer's requests never lift or seed it |

### Reading a ticket

The ticket maps the attempt's status events onto controller signals, and settles once:

| Event on the ticket | Signal |
|---|---|
| `model_request_started` | nothing (already counted at admission) |
| `model_request_completed` | `succeeded(epoch)` |
| `model_retry_scheduled`, reason `rate_limited`, `provider_overloaded`, `offpeak_queued` | `throttled(epoch, reason, retryAfterMs)` |
| `model_retry_scheduled`, reason `reasoning_signature_repair` or `auth_refresh` | `ended` (not a provider failure; the streak survives) |
| `model_retry_scheduled`, any other reason | `failedTransient` |
| `model_request_failed`, `retryable: true` | nothing; the retry-scheduled event that follows is the signal |
| `model_request_failed`, `retryable: false`, and the model-error policy (below) says `stop` | `ended`: neither the cap nor the cooldown moves |
| `model_request_failed`, `retryable: false`, reason `rate_limited` | `throttled(epoch, "rate_limited", retryAfterMs)`: a 429 the classifier calls terminal is still a concurrency signal |
| `model_request_failed`, `retryable: false`, other | `ended` |
| `release()` before any of the above | `ended` |

The rows are read in order, so the policy check comes before the `rate_limited` row. A
`stop`-class failure — a quota code such as `1308`, an auth failure — says the account
cannot be served at all, not that the provider wants fewer requests at once. The run it
belongs to stops (`ProviderStop`), and the user decides when to try again: after a top-up or
a quota reset, a resume must reach the provider at once. A quota 429 usually carries a
Retry-After pointing at the end of the quota window; read as a throttle, it would freeze the
shared bucket until then, past the stop and past any reset the user bought, and every later
run on that model would wait at the gate without sending a request. The main agent's quota
429s go through the same rule. The ticket asks the very function the runner and the driver
use (`resolveWorkflowModelFailurePolicy`), so the three layers cannot disagree about which
failures are `stop`.

The off-peak queue (`offpeak_queued`) is a 429 with a Retry-After from a provider's idle
plan; it counts as a throttle and, in the runner, does not consume a retry attempt.

## Retry budget and the model-error policy

The concurrency cap only shapes *when* requests go out. What keeps a provider error from
becoming a workflow error is the retry budget on the request.

### Unbounded retries for workflow traffic

`modelRetryBudget` is a runtime-only request field with two values, `default` and
`unbounded`. The runtime layer sets it from the session's task type: `workflow_child` and
`nested_workflow_child` get `unbounded`; everything else keeps the adapter default of ten
retries. The budget is per request, not per adapter, because a subagent shares its parent
session's live model adapter and must keep seeing provider registry updates. The legacy
`Workflow` tool's subagents are built by the same factory with the same task type, so they
get the unbounded budget too, even though they pass no admission gate.

`unbounded` relaxes exactly two checks in the runner, the attempt loop's continue condition
and the "may we try again after this failure" gate, and nothing else:

| Unchanged under `unbounded` | Why |
|---|---|
| the backoff curve | waiting longer is not the same as giving up |
| the empty-completion retry and the compaction path | different problems, with their own bounds |
| no retry after the stream has emitted a visible event | the core's stream recovery owns that case, with its own anchor and a cap of ten |

The backoff curve is the runner's: 2 s doubling to a 60 s ceiling, multiplied by a jitter in
[0.5, 1]. A Retry-After header replaces the computed delay when it is at most five minutes,
or shorter than the exponential delay would have been; the runner then adds a small jitter on
top, never below the header (see `docs/bigmodel-business-error-retry.md` "Retry-After
Header"). After the ceiling the runner probes
forever; the only exits are success, user cancel, which interrupts the sleep and the gate
wait alike, and the policy table below (which includes a cap on consecutive unknown provider
codes).

Status events carry `maxAttempts: 0` to mean unbounded, since `Infinity` does not
serialize; consumers that render "attempt n of N" special-case zero.

### The policy table

The failure classifier's `retryable` flag answers "should the main conversation retry on
its own", and for some provider codes the product answer is no: a Start Plan concurrency
limit shows the user a banner instead. Workflow traffic asks a different question, "must a
person fix this before the run can continue", and reads a separate table,
`resolveWorkflowModelFailurePolicy` in `packages/adapters`
(`model/workflow-model-failure-policy.ts`). The runner's retry gate and the driver read the
same function, so a failure the runner retries can never reach the driver as a stop, and a
failure the runner declines is one the driver will stop on.

| Input, in order | Decision |
|---|---|
| reason `cancelled` | `cancelled` |
| provider code in the quota set (`1005`, `1308`, `1310`, `1313`, `1316`–`1321`, `2056`, `20097`, `insufficient_quota`, `credit_balance_exhausted`, the spend- and usage-limit codes) | `stop`, kind `quota` |
| reason `auth_failed` | `stop`, kind `auth` |
| reason `provider_not_configured`, or an error code in the not-configured family (`provider_not_found`, `provider_not_configured`, `model_config_missing`, `invalid_model_selection`, `model_request_auth_missing`) | `stop`, kind `not_configured` |
| error code `model_not_found` | `stop`, kind `model_unavailable` |
| reason `context_exceeded` | `context_exceeded` |
| reason `invalid_request`, unless the code is `invalid_model_response` | `stop`, kind `invalid_request` |
| reason `unknown` with a provider code (a code the classifier does not know, such as `1113`), the 10th time in a row within one request | `stop`, kind `other` |
| anything else: rate limits, overload, 5xx, timeouts, network and TLS errors, an unknown provider code fewer than 10 times in a row, a response the adapter could not parse | `retry` |

Under `unbounded`, `retry` means retry; `stop` and `context_exceeded` mean the attempt loop
ends and the turn rejects.

The cap on unknown provider codes (`WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE`, 10)
exists because such a code can be deterministic. On 2026-10-16 the server returned `1113`
to a set of accounts on every request; the classifier did not know the code, so workflow
runs retried it forever and only the stall notice said anything. An unknown code may also be
transient, so the first one does not stop the run. The count is consecutive, not the
attempt number: the runner keeps a streak per request (`nextUnrecognizedCodeStreak`), adds
one for each failure that is an unknown provider code, and resets it to zero on any other
failure. Nine network errors followed by one unknown code is a streak of one and retries;
unknown codes alternating with network errors never stop the run; ten unknown codes in a row
stop it, after about six minutes of backoff when nothing else interrupts them. Both paths
that see a failure count it, the catch around the request and the in-stream error chunk.
The runner passes the streak to the table, and the adapter error carries it as
`unrecognizedCodeStreak`, so the driver reads the same input and reaches the same stop.
The run stops as `stopped(provider)` with kind `other` and can be
resumed once the cause is fixed. Under `default` the classifier's flag is consulted exactly as
before, so main-conversation behaviour is untouched. The quota check comes before the
reason check on purpose: code `1005` classifies as `invalid_request`, and a stopped run
that reads "quota" is the one the user can act on.

The `stop` kinds are the vocabulary of `ProviderStop`; how a stopped run is presented and
resumed is in `execution-engine.md`.

### Where the two layers meet

A model error that leaves the runner reaches the driver, which reads the same table:

- `stop`: the driver stops the run as `stopped(provider)`, without settling the node.
- `context_exceeded`: the node fails with `ContextLimit`, which the script may catch.
- `retry` or `cancelled` (the residual case: a transient failure after the stream had already
  produced visible output and the core's ten stream recoveries ran out): the driver waits
  out the same backoff curve, Retry-After first, reports `askWaiting(backoff)` for the node,
  and then sends the subagent one more turn telling it to continue where it left off. The
  attempt count is per ask and resets on the next ask; only cancel ends the loop.

Only the first bullet's consequences and the shape of a stopped run belong to the engine
document; the redrive itself is a concurrency mechanism and stays here.

### The stall clock

A run that is retrying forever must still be visible. The driver keeps one clock per run,
shared by every subagent's turn and tool requests: any `model_request_completed` resets it,
and a `model_retry_scheduled` (signature repair and auth refresh excepted) arms it for
twenty minutes after the last success. If it fires with at least one retry recorded, the
driver reports `runStalled({ sinceMs, reason?, cap? })` once, where `reason` is the most
frequent retry reason in the segment and `cap` the last fan-out seen. The engine journals it
as `run-stalled`; the next success re-arms the clock and a new segment may fire again. The
run is not stopped. The notification the main agent and the user receive is described in
`docs/dynamic-workflow/transcript-and-notifications.md`.

## Tool-side requests

Because the admission port is bound on the model handle, a request a tool makes inside a
subagent's turn passes the same gate as the turn itself. Two adjustments make that workable.
It passes the shared cap's gate only: the run's own seat gate lets it through untouched, since
its subagent already holds a seat ("Why a tool's own requests never park").

**The tool deadline pauses while queued.** A tool's timeout guards against a slow provider,
not against the runtime's own queue; otherwise a low cap would push every WebSearch past
its 60 s deadline, the model would search again, and the storm would feed itself. The tool
executor wraps the session event sink for each call with `ToolDeadline`
(`packages/core`, `tool/executor/timeout.ts`): a `model_request_queued` event carrying this
call's `toolCallId` pauses the clock, the matching `model_request_admitted` resumes it, and
the remaining time is conserved. Several queued requests in one call pause as a union. A
backoff sleep does not pause, since that is the provider being slow. User cancellation still
aborts immediately. A timeout error carries `queuedMs` so a log can tell slow from waiting.

**Tool-side requests get a status sink by default.** The queued and admitted events reach
the deadline and the driver only through the session event stream, and a call site that
forgets to set a `statusSink` would leave its requests gated but silent. So the executor
wraps the `context.model` it hands each handler with a default sink that emits
`ModelNetworkStatus` session events under the call's `toolCallId`; a call site that sets
its own sink keeps it.

The queued and admitted events are runtime observations, not provider request states.
Consumers that enumerate status types (the telemetry facts, the product projection, the
network debug status) ignore them explicitly rather than inventing a UI state for them.

## What the driver observes

The driver, in `packages/bootstrap` (`workflow-driver-concurrency.ts`), gives each subagent
one object that is both its admission port and an observer of its session's
`ModelNetworkStatus` events. From the events it reports two things to the engine for the
subagent's live ask:

| Report | Meaning |
|---|---|
| `askWaiting(instance, { cause: "slot" })` | the next request is queued at the gate |
| `askWaiting(instance, { cause: "backoff", reason, attempt, delayMs, retryAfterMs? })` | the runner scheduled a retry |
| `askExecuting(instance)` | a request is actually at the provider |

```ts
interface AskWaitInfo { cause: "slot" | "backoff"; reason?: string; attempt?: number; delayMs?: number; retryAfterMs?: number }
```

`reason` is an open string holding a `ModelRetryReason` value; the pure package does not
import contracts. `delayMs` is relative because the engine has no clock.

A subagent may hold several tickets at once, so the driver tracks a set of **request chains**
per subagent, keyed by `(querySource, queryId, toolCallId)` so that a retry, which changes
`requestId`, stays in its chain. `model_request_queued` puts a chain in `queued`;
`model_request_admitted` or `model_request_started` puts it in `executing`;
`model_retry_scheduled` puts it in `backoff` (signature repair and auth refresh are ignored);
`model_request_completed`, or a non-retryable `model_request_failed`, removes it. The
subagent's phase is then: any chain executing, executing; otherwise, a chain waiting, waiting
with the most recent wait info; otherwise unchanged, so a subagent running a tool that is
not queued keeps showing executing. When an executing chain ends and only waiters remain,
the subagent turns to waiting with the latest wait info.

Within one stretch of waiting, wait info identical field-for-field to the last one reported
is not reported again: four parallel searches queued in the same millisecond produce one
`waiting(slot)`, while a change from backoff to slot is still reported. Reporting executing
clears the memory. The whole state resets at the start of each ask so the previous ask's
phase never leaks onto the next ask's first request.

The driver subscribes to the governor once at construction; every cap change it hears is
recorded through the sink as `concurrency-changed` and noted on the stall clock.

The run's seat gate wraps this per-subagent object rather than replacing it ("Retuning a live
run"), so nothing in the table above changes: a parked subagent is one whose next request was
refused a seat, which is a queued request, which the driver already reports as
`askWaiting(slot)`. The gate also reads this object for the one fact it needs, whether the
subagent has a tool call in flight.

## Protocol and UI

### Engine events

| Event | Payload |
|---|---|
| `node-waiting` | `{ instance } & AskWaitInfo` |
| `node-executing` | `{ instance }` |
| `concurrency-changed` | `{ key, previous, next, reason, lastGood?, lastBad?, cooldownMs? }`, `reason` one of `rate_limited`, `provider_overloaded`, `offpeak_queued`, `recovered`, `idle_reset`, `limit_lowered`, `seeded`; the reason is an open string on the wire, so a reason an older reader does not know is shown like any other change |
| `run-caps-changed` | `{ runId, caps, previous }`, plus the `concurrencyCeiling` the CLI splices in on the way out, exactly as it does for `run-started` |
| `run-stalled` | `{ sinceMs, reason?, cap? }` |

The engine records them only while the run is live and, for the node events, while the
node is live; a late observation on a settled node is dropped. None of them writes
`dwf_node`; `node-waiting ⇄ node-executing` is a self-loop between dispatched and settled.
`run-caps-changed` is the one of the five the engine itself decides rather than observes: it
is written by `setMaxConcurrency` beside the journal row it changes ("What a retune writes"),
and a setter call on a settled run records nothing.

### Protocol state

In `packages/shared` (`zcode-protocol-v4/workflow-runs.ts`):

- A node's `phase` is one of `queued`, `dispatched`, `executing`, `waiting`, `repairing`,
  `nudged`, `settled`. `dispatched` means the session is ready and the first request has not
  been admitted yet; readers group it with `queued` and `waiting` as "not at the provider".
- An actor's `status` is derived, not emitted: `running` when any of its nodes is
  executing, repairing or nudged; `waiting` when it has a live node (queued, dispatched or
  waiting) or no node yet while the run is live; `completed` otherwise, and always once the
  run has reached a terminal state.
- The wire names below predate the default parallelism and keep the word "ceiling"; they are
  frozen because older desktop, TUI and phone bundles read them. Each now carries D, the
  default parallelism, which is a reference level and no longer a maximum.
- `run.concurrency` is `{ key?, cap, ceiling, limit?, cooldownMs? }`. `cap` is the shared bound
  that `concurrency-changed` moves. `ceiling` is D: the reducer takes it from
  `run.concurrencyCeiling` when that is known, and only for a payload from a CLI too old to send
  it falls back to the largest `previous` or `next` it has seen. `limit` is the run's own bound
  when it **differs** from D, above or below, and arrives with `run-started`: that payload
  carries the engine's `caps.maxConcurrency` next to `concurrencyCeiling`, the D the CLI
  splices in when it mints the payload (a machine's core count is a host fact the engine
  neither sees nor should see), and the reducer records `limit` only when the two differ. A
  later `concurrency-changed` preserves it: the governor moving a provider key says nothing
  about what the user asked of this run. `run-caps-changed` is the one event that moves it, and
  it moves it by the same rule: the payload carries the new `caps` next to the same spliced
  `concurrencyCeiling`, so a bound other than D writes `limit`, a bound equal to D clears it,
  and clearing it when the shared side has nothing to say either (cap at or above D, no
  cooldown) drops `concurrency` whole. It leaves the shared side — `cap`, `key`, `cooldownMs` —
  alone, for the mirror image of the reason above. A `run-started` for a resumed run leaves the
  shared side alone, since the process may already have learned a cut cap for that key and
  writing D back over it would report a number that is not in force. `cooldownMs` is relative;
  the UI stamps the moment it first sees a given `concurrency` object and derives the deadline
  from that. `idle_reset` clears the cooldown, and so does the run's terminal state.
- `run.concurrencyCeiling` is D from the same `run-started` payload, and from
  `run-caps-changed`, kept whether or not the run has a bound of its own (a later payload
  without it keeps the known value). It is what the settings popover's stepper calls the
  default (`docs/dynamic-workflow/presentation.md`, "The settings popover"). When it is unknown
  the popover names no default; it never substitutes `concurrency.ceiling` for it, because on
  an old CLI that is a learned cap, not a default.
- `run-caps-changed` is additive for consumers that predate it. The event type crosses the wire
  as a plain string (`DynamicWorkflowRunProgressPayload.eventType`, no enum on either side) and
  the reducer's `default` branch only raises the sequence watermark, so an older desktop, TUI or
  phone bundle keeps reporting the run's last known bound instead of rejecting the payload. The
  engine's own event union gains the type; nothing else narrows it.

### What the user sees

| Surface | Behaviour |
|---|---|
| run header, side pane | 「最大并发数 N」("Max concurrency N"), where N is the effective bound `min(cap, bound)` with `bound = limit ?? D`, shown while that is below the run's bound or the run has a bound of its own, **and** the run can be configured (`docs/dynamic-workflow/launch.md`, "Which runs can be configured"); a run at the default with the shared cap at or above D shows nothing. N is a bound, never a count: a run with two subagents under a bound of six reads 「最大并发数 6」 next to the summary row's 「2 个子代理工作中」, and the two do not contradict each other because the chip's word is the bound's word. The popover's stepper, the provenance row and the stall notification's fact line carry the same word. The chip leaves with the Configure button: a completed run has nothing left to run under the bound and no control to change it, and a superseded run's bound is its successor's business, so a number there would only read as a stale live reading. A stopped or errored run keeps it, because a resume or a retry runs under that bound. The chip does not name which of the two bounds is in force, and needs no change for a retune: the reducer moves `limit` and the same expression re-reads it. The event log is where the two bounds are told apart — 「并发 13 → 9」 is the shared cap's, 「并发上限 8 → 2」 the run's own. With a live cooldown the same chip adds 「冷却至 HH:mm:ss」("cooling down until"), ticking until it expires |
| the settings popover | a stepper from 1 with no upper end, starting at the run's own bound (`concurrency.limit`) or D (`run.concurrencyCeiling`), hinted 「默认 N」("default N"), or 「= 默认」("= default") when it stands on D; D means "no bound of the run's own" and is sent as `null` (`docs/dynamic-workflow/launch.md`, "Changing a run's settings from the GUI"). On a live run with the stepper as the only change, Apply retunes that run in place, and the popover's sentence says so instead of warning that applying starts a new run (`docs/dynamic-workflow/presentation.md`, "The settings popover") |
| the confirmation window | 「最多 N 个子代理同时运行」("At most N subagents at once") when the call carries `max_concurrency`, a line of its own after the lineage row (`docs/dynamic-workflow/launch.md`, "What the window shows"). A retune raises no window at all, from either caller |
| event log | `node-waiting(slot)` → 「等待槽位」("Waiting for a slot"); `node-waiting(backoff)` → 「等待 provider（限流）· 5s 后重试」("Waiting for provider (rate limited) · retry in 5s"), with the reason mapped to rate limited / overloaded / off-peak queue / transient error, unknown reasons shown verbatim; `node-executing` → 「请求已发出」("Request sent"); `concurrency-changed` → 「并发 13 → 9」; `run-caps-changed` → 「并发上限 8 → 2」("Concurrency limit 8 → 2"), the run's own bound, with D written as the number it is on both ends so a retune to or from "no bound" still reads as two numbers |
| subagent pills and faces | a node's phase folds to four values: `queued`, `dispatched`, `waiting` → pending; `executing`, `repairing`, `nudged` → running; `settled` → done or failed. How the pill and its face draw those is in `docs/dynamic-workflow/presentation.md` |
| notifications | none for throttling or slot waiting; the ask is simply still running. The only message is the stall notification after twenty minutes without a successful request, which says the run is still running and needs nothing |
| the main agent | is never told about throttling; it hears of the stall once per stall segment. The tool description tells the model not to write retry loops or `try`/`catch` for provider errors (`docs/dynamic-workflow/authoring.md`). It learns a run's own bound only where it set one: the `CreateWorkflow` and `AmendWorkflow` results end with "At most N subagents run at once", an `AmendWorkflow` that retuned a live run names that one run and no successor ("Applied to the running run {id}; at most {n} subagents run at once. Run {id} keeps running under it: nothing was stopped and no new run was started.", `docs/dynamic-workflow/launch.md`, "Changing only the parallelism of a live run"), and `GetWorkflowRun` reports `maxConcurrency` when the bound differs from the default |

Every wait detail (reason, countdown, attempt) lives in the event log line only; no badge
carries it.

## Tests

| Suite | What it pins |
|---|---|
| `dynamic-workflow/tests/engine/concurrency.test.ts` | the constants; current-epoch throttle cuts by 0.75 to the floor and turns the epoch; a cut clears `lastGood` and records `lastBad`; old-epoch throttles move nothing, emit nothing, still reset the streak; thirteen epoch-0 refusals cut once; Retry-After cooldown, including from old epochs; K current-epoch successes prove `lastGood` with or without waiters; a raise needs waiters and headroom; old-epoch successes do not count; `failedTransient` and `ended`; idle reset after five minutes with nothing in flight, back to `initial`; growth stops at `growthLimit`, a raised limit is climbed step by step, a lowered one pulls the cap down (`limit_lowered`) and turns the epoch; `seed` jumps to the target within the growth limit, clears `lastGood` so the next refusal cuts by the factor, and is refused for a target at or below the cap or within five minutes of any refusal; the 16→12→13 and 13→9→6→4→5→6→5 sequences |
| `dynamic-workflow/tests/engine/engine-concurrency-observations.test.ts` | the three sink methods each record one event and are ignored after settlement |
| `bootstrap/tests/workflow-concurrency-governor.test.ts` | buckets per key; first run starts at D; auto-growth stops at 2D; a registered bound above 2D lifts the growth limit only for keys that run used and seeds the cap to it at once, a refusal in the last five minutes suppresses the seed, a default run never seeds, and clearing it pulls a higher cap down with `limit_lowered` fanned out to the runs still engaged; the observer never lifts it; a new run inherits a cap the observer's 429s lowered; idle reset; `tryAdmit` misses while anyone waits; round-robin across runs; the ticket's event mapping and double-count guard; a `stop`-class failure (quota code with a Retry-After) moves neither the cap nor the cooldown, from a run's ticket or the observer's, while a terminal 429 outside the stop set still throttles; `release()` as `ended`; abort dequeues; fan-out only to engaged runs; cooldown wake |
| `bootstrap/tests/workflow-driver-concurrency.test.ts` | slot and backoff waits, executing on the first and post-wait `started`, per-ask reset; chain aggregation with parallel tool requests; wait deduplication; the driver-side policy split (stop / `ContextLimit` / redrive); the stall clock's 19-minute silence, 20-minute fire, and re-arm |
| `dynamic-workflow/tests/engine/engine-retune-concurrency.test.ts`, `dynamic-workflow-runtime/tests/control.test.ts` | the setter: a raise pumps and dispatches within the same slice, a cut leaves live asks alone and stops the next dispatch, an unchanged value and a settled run both answer false and write neither row nor event; one `run-caps-changed` carrying `caps` and `previous`, one `updateRunCaps`; the scheduler reads `host.caps` on every pump, so a bound changed between two pumps is the one the second pump enforces; the harness binds the control to the engine it just built, and a binding never bound answers false |
| `bootstrap/tests/workflow-seat-gate.test.ts` | the gate alone: park on a turn step over the limit (`tryAcquire` misses → `model_request_queued` → `waiting(slot)`), seat before governor, FIFO unpark on an ask settling and on a raise, one at a time; `activeAsks = working + parked`; limit 1 keeps one subagent working and deadlocks nothing; a tool-side request never parks and a subagent with no live ask never parks; abort dequeues, rejects with the signal's reason and returns the subagent to `working`, its later settlement frees no phantom seat, an already-aborted signal never enters the FIFO, and a settle that beats the abort refuses the waiter without freeing a seat; a settle for an instance never seen started is a strict no-op; a cut inside the `ensureSession` window still parks the late subagent and counts nobody twice; two asks in a row on one subagent join idempotently; a run never lowered is a pure pass-through and the governor sees every call |
| `bootstrap/tests/workflow-driver-seat-gate.test.ts` | the gate through the real driver: a cut parks later turn steps one by one while a subagent with a tool in flight keeps sending; the engine's `node-settled` frees a seat and unparks the FIFO head, and the event reaches the driver's `emit` hook unchanged; a settle the gate never saw started does nothing; a raise unparks; cancelling a parked ask rejects its seat wait without freeing a seat; a run never lowered never enters the gate |
| `bootstrap/tests/workflow-run-control.test.ts` | the control handle: unbound answers false and buffers no value; an engine that says "nothing changed" leaves the gate's limit alone; an assembly with no gate still retunes (the scheduler alone); `retuneConcurrency` on an unbound or control-less entry answers `not_live` and writes nothing |
| `bootstrap/tests/workflow-concurrency-tool-traffic.test.ts` | real governor, real runner, fake provider that refuses above a threshold: six subagents each with a turn and three tool requests; the provider never sees more than the cap; the first 429 lands at D and cuts immediately; queued and admitted arrive in pairs; a Start Plan concurrency code is a retry, not a failure |
| `adapters/tests/runner-admission.test.ts` | generate and stream runners acquire per attempt, forward events to the ticket, release exactly once on every exit, hold no ticket during backoff, and behave identically with no port; queued/admitted only when the fast path missed |
| `adapters/tests/retry-budget.test.ts`, `workflow-model-failure-policy.test.ts` | the budget relaxes only the two gates; the policy table row by row |
| `core/tests/runtime-model-admission.test.ts`, `model-request-admission.test.ts`, `model-retry-budget.test.ts` | the factory binds port and budget on every handle; the runtime layer wins over the call site; a subagent runtime inherits the port |
| `core/tests/tool-deadline.test.ts` | pause on queued, resume on admitted, remaining time conserved, union of overlapping waits, abort while queued, `queuedMs` on the timeout error; the default tool status sink |
| `packages/shared` reducer tests, `packages/ui` tests | phase and actor-status derivation; run header and event lines in both languages |
| `bootstrap/tests/dynamic-workflow-run-service.test.ts` | the requested bound: below or above D it lands verbatim on `dwf_run`, absent is D, zero and negatives hit the floor of one and a fraction rounds down; D itself is `max(4, min(16, cores − 2))`; an amend carries its own value and inherits nothing from the predecessor; `defaultConcurrency()` is the one implementation; the launch registers the run's bound with the governor, a retune moves it and settlement clears it; snapshot and detail carry `maxConcurrency` only when it differs from D and answer from the registry copy in the gap before the journal row exists, while list rows never carry it; the `run-started` payload carries `concurrencyCeiling` next to the engine's caps, and cold replay mints the same bytes; `retuneConcurrency` answers `ok` with the applied bound, the `previous` one and `defaultConcurrency`, and moves the registry copy the snapshot and detail read; `null` applies D; a value above D is applied as is; `not_live` for a run the service does not hold live, a settled one and a pending one whose engine is not bound yet, with nothing buffered; `unchanged` carries the `current` bound |
| `packages/shared/test/zcodeProtocolV4WorkflowRunsReducer.test.ts` | `run-started` records `concurrencyCeiling` on the run whenever readable and keeps the known one otherwise; it records `limit` only when `caps.maxConcurrency` differs from `concurrencyCeiling`, above or below, and leaves `concurrency` absent for a run at D, an old payload with no `concurrencyCeiling`, or either field unreadable; `concurrency-changed` takes `ceiling` from `run.concurrencyCeiling` when known, and it and the terminal state keep `limit`; a resume's second `run-started` does not raise a cap the governor cut; `run-caps-changed` writes `limit` for any bound other than D, clears it at D, drops `concurrency` when the shared side has nothing to say, updates `concurrencyCeiling` when readable, and leaves `cap`, `key` and `cooldownMs` untouched; an unknown event type changes nothing but the watermark |
| `packages/ui/test/workflowRunThrottle.test.ts`, `workflowRunSettings.test.ts`, `workflowRunSettingsPopover.test.ts`, `workflowPermissionBlock.test.ts` | the chip shows `min(cap, limit ?? D)`, stays hidden for a default run whose cap is at or above D, shows for a raised run, and follows a retuned `limit` with no change of its own; it is present on running, pending, stopped and errored runs and absent on completed and superseded ones even with a bound of their own (`workflowRunSidePane.test.ts` renders both), and reads 「最大并发数 N」 / "Max concurrency N"; the stepper has no upper end and its hint names D; the 「并发上限 8 → 2」 event line in both languages; the popover's sentence switches to the in-place wording exactly when the stepper is the only change on a **running** run, and a pending one keeps the restart sentence; the confirmation row in both languages, ordered after the lineage row, and absent for an omitted, `null`, zero or fractional field |
| `core/tests/create-workflow-tool.test.ts`, `create-workflow-permission.test.ts`, `amend-workflow-permission.test.ts`, `get-workflow-run-tool.test.ts` | `resolveInput` floors before the window, leaves a whole-number inline call byte-identical at any size, and carries the value through a saved source; the amend tri-state (a number floored, `null` removing the key, an omitted field inheriting the snapshot's value as is, nothing inherited from a predecessor at D); `GetWorkflowRun` carries `maxConcurrency` and its `<max_concurrency>` tag only when the run has one |
| `core/tests/amend-workflow-permission.test.ts`, `core/tests/dynamic-workflow-run-settings.test.ts` | the routing, from both callers: only `max_concurrency` on a live run goes in place, with the same run id, no supersede and no window; a script, a `path`, a `subagent_model` or a name beside it, a settled run, a pending run with no engine yet and a host whose port has no `retuneConcurrency` all fall through to the amend they take today; the same value is refused `workflow_retune_unchanged` and the refusal names the bound in force; `not_live` amends a run the owner predicate accepts and refuses the rest (`workflow_run_settled`, `workflow_run_not_retunable`), so nothing a retune failed to apply starts a run nobody approved; `null` reaches the port and comes back as the applied bound; the response text verbatim for both endings, and `retuned` carrying the applied bound, the previous one and `defaultConcurrency` with no `status`, `backgroundTaskId` or display |
| `packages/ui/test/createWorkflowToolCallBlock.test.ts`, `workflowTurnDigests.test.ts`, `workflowRunSidePane.test.ts`, `packages/shared/test/zcodeProtocol.test.ts` | the retune row: drawn for a successful `AmendWorkflow` whose input is `run_id` + `max_concurrency` alone with no display and no run joined by tool call id, in the settings row's own words, clickable to that run's pane; a request equal to D, and `null`, read as "limit back to the default", a request above D reads as its number, and an unknown D shows the number as typed; the in-flight label stays 「正在调整工作流」; no turn-end digest card for it, and an in-place settings turn is a row without one; the optional `predecessorRunId` and the `run-caps-changed` payload across the protocol schemas |
| `packages/desktop/test/e2e/automations/workflows/automations-workflows-hub.test.ts`, the concurrency chip case | the real app: a running saved workflow at the default has no chip; Configure, one step down and Apply retune it in place and the chip reads 「最大并发数 N」 with the lowered bound; once the run completes the chip and Configure leave together. |

## Alternatives not taken

- **Admission per ask instead of per request attempt.** A slot taken at dispatch let every
  later request of that subagent, and every tool-side request, reach the provider unseen; a
  cut could not take effect until asks settled, and the governor saw a third of the 429s.
- **A drain window to damp a burst**, closed when in-flight fell below the new cap or a
  Retry-After expired. Without a Retry-After header the in-flight count, which included
  sleeping retries, never fell below the cap, the window never closed, and the cap froze at
  its first cut for the rest of the run. The epoch stamp needs no such condition.
- **Halving on throttle, 40 successes per step.** With request-level admission one 429 says
  the cap is high, rarely twice too high; and a failed probe costs one request, not worth
  40 successes.
- **Setting `lastGood` to the new cap on a cut.** It treats an unproven level as proven, so
  the next 429 reads as "the wall moved" and cuts again.
- **Retrying at the driver or engine, by re-running the turn or node.** It leaves the broken
  attempt in the subagent's transcript; the runner retries inside the request.
- **A separate model adapter for subagents** with its own retry options: it would freeze a
  copy of the provider registry.
- **A configuration key or environment variable for the default parallelism or the constants.**
- **A process-wide total across provider keys**, or a per-subagent ticket limit.
- **Reserved slots for the main agent**: it needs none, since it never queues.
- **Notifying the main agent on throttling**: a wait is not an event the model can act on.
- **A queue-time bound for tool-side requests**: a long wait still yields a result;
  cancel and cap recovery are the exits.
- **Retuning with the scheduler alone.** It is the one enforcement point that already exists,
  and a cut through it is correct: no further ask is dispatched. It is also nearly invisible.
  An ask is a subagent's whole turn and lasts minutes, so a run with eight live asks told "at
  most two" would keep eight subagents at the provider until six of them happened to finish.
  The user asked for the run to slow down now, and "now" is the next model request, not the
  next settlement.
- **Aborting the asks over the new limit.** It makes the number true immediately and throws
  away exactly what the in-place path exists to keep: the turn's transcript, its tool calls and
  whatever it had computed. An amendment at least replays the finished work from cache; a cut
  that cancels would lose the unfinished work with nothing gained over one.
- **A per-run request-count gate in the governor.** The governor already queues per run, so a
  per-run cap there looks like one line. Its unit is wrong: it counts model requests, and the
  run's own bound counts subagents working at once. A subagent that fans out three searches
  holds three requests, so a bound of two would park a second subagent because the first one
  was busy — and tool-side requests, which must never be held, are exactly the ones the
  governor cannot tell apart. The gate sits above the governor, where the driver already knows
  which subagent is asking and whether it has a tool in flight.
- **A `max_concurrency` on the saved workflow file, or in the hub's launch dialog.** How
  parallel a run may be is a property of the moment it is started, not of the recipe; a number
  written into a file against one machine's core count would be applied silently on the next.
- **A CPU-derived ceiling on the run's own bound**, the earlier design. Users found it
  surprisingly low — a small machine or a small remote host allowed two subagents at once —
  and the core count says little about a workload that waits on a remote provider. The
  number survives as the default, and the governor's 429s, not the machine, keep a raised run
  within what the provider allows.
- **A hard maximum for `max_concurrency`.** Rejected: a user who asks for 200 subagents at once
  has made a choice the runtime has no better information to overrule.
- **Growing the shared cap to 2D even for a run the user raised higher.** The run's bound counts
  asks and the cap counts requests, so a user's 40 would start 40 subagents and park most of
  them at 「等待槽位」 behind a cap of 2D: the raise would not show. The user's number lifts
  the growth limit and seeds the cap to it.
- **Climbing to a raised bound one step per streak.** It was the first design and was safe
  against a tight provider, but a run raised from 8 to 32 needed about 96 successful requests
  before the side pane showed 32, and the user reads that as the setting not having taken. The
  seed pays for immediacy with at most a few waves of refused requests — refused before any
  output, retried without limit, and damped to one cut per wave — which settle where the climb
  would have ended; the five-minute guard keeps it from rerunning a burst the provider just
  refused.

## Open questions

- Probe frequency. In front of a stable wall the controller probes every K = 4 successes and
  eats one 429 each time, plus a cooldown on providers that send Retry-After. If that proves
  costly, the next step is doubling K after repeated failures at the same `lastBad`.
- Quota-level versus model-level keys. Buckets are per model; if two models on one provider
  are always throttled together, a provider-level bucket would learn faster.
- Token-rate limits. AIMD converges on a concurrency limit; against a tokens-per-minute
  limit it keeps probing and oscillates a few levels below the growth limit.
- The stream-recovery budget stays at ten. If "ten recoveries and still failing" shows up
  in workflow runs, that budget could follow the task type like the retry budget does.
- A per-project default for the run's own bound, which `max_concurrency` would override and
  the hub launch would read too. Today a user who always wants this project's runs throttled
  has to say so on every call that starts one.
