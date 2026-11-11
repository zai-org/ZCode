# Dynamic Workflow: Authoring (spec)

Status: implemented. This document describes what the model and the user see when a
workflow is written: the facade the script is written against, the `/workflow` command and
the authoring skill, the prompts a subagent receives, the artifact channel, `world.run`, and
the snippet tool. The analyzer that checks the script is in
`apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md`; what happens after the script
is accepted is in `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`; the
tools that submit and confirm a run are in `docs/dynamic-workflow/launch.md`.

## The authoring surface

A workflow is a TypeScript script. The model writes it, the user confirms it, the harness
runs it. Five things reach the model while it writes:

| Surface                                                                                           | What it carries                                                                                                                       | Where                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `CreateWorkflow`, `AmendWorkflow`, `SaveWorkflow`, `EvalWorkflowSnippet` descriptions and schemas | a paragraph each: what the tool does, when to call it, "load the skill first"; field hints of one sentence                            | `core/src/tool/handlers/*-description.ts`, `contracts/src/tools/*.ts` |
| `/workflow <instructions>` command                                                                | a five-line built-in prompt command that loads the skill and names `CreateWorkflow`                                                   | `bootstrap/src/builtin-workflow-command.ts`                           |
| `dynamic-workflows` skill                                                                         | the judgment layer (topology, quality, delivery, after submit) and, in §16, the facade declarations, the rules and each tool's fields | `packages/bundled-skills/skills/dynamic-workflows/`                   |
| the skill gate                                                                                    | the four tools refuse a script until the skill has been loaded in the session                                                         | `core/src/tool/handlers/workflow-skill-gate.ts`                       |

The division is fixed the other way round from how it stood until 2026-09-21: the
descriptions carry only what the model must know before it decides to call a tool (routing,
the never-unsolicited rule of `SaveWorkflow`, the pointer to the skill), and the skill carries
the API and every rule. The facade text appears in the model's context exactly once, in the
skill's §16.2, embedded verbatim from the same constant the compiler is fed, so the contract
the model reads cannot drift from what typechecks. Until then each of `CreateWorkflow` and
`SaveWorkflow` embedded the facade in its own description and `EvalWorkflowSnippet` embedded
the snippet subset: about 19 000 tokens of tool declarations re-sent with every model request
of every session, whether or not the session ever wrote a workflow, and about 4 300 more with
every subagent request. The four descriptions and their schemas now total under 2 000 tokens.
Under the `onDemand` gray mode the first row is absent altogether until the session's first
`/workflow` (launch.md "On demand: activation"): the command, the skill and the gate are
unchanged, only the moment the tools appear moves.

### The skill gate

Moving the rules into the skill is safe only if the model has read them before it writes.
Each authoring tool therefore refuses, in its `resolveInput` hook, until the session has a
completed `Skill` call for `dynamic-workflows` in the history the model can currently see.
The refusal is a business failure with its own code (428, `workflow-skill-gate.ts`): it
reaches the model as a tool error naming the skill, the `Skill` tool and the tool to call
again, and it happens before hooks and before the permission flow, so the user never sees a
confirmation window for a call that was going to be refused. The cost of a refusal is one
extra round trip in a session that skipped the skill.

Two calls are exempt because they are not authoring: `CreateWorkflow` with the `saved`
source alone (running a workflow the user already kept), and `AmendWorkflow` with neither
`path` nor `script` (changing a run's settings while keeping its script). `SaveWorkflow` and
`EvalWorkflowSnippet` are always gated.

"Loaded" is read off the runtime's provider-visible message history
(`core/src/agent/loaded-skills.ts`): an assistant `Skill` call whose input names the skill
(`{ skill }` or the legacy `{ name }`) with a tool result that is not an error. It is not a
session flag. After compaction the summary replaces that history, the skill text is gone
from the model's context, and the gate closes again until the skill is reloaded, which is
the same rule `Edit` follows for `Read` (the read-file state is cleared at the same point).
Resume and rewind rebuild the history and the answer with it. The probe reaches the tools
through `ToolInputResolutionContext.hasLoadedSkill`, which the runtime supplies only when
the session has a skill port: a session with no `Skill` tool cannot satisfy the gate, so it
has none.

## The facade

The facade is one `.d.ts` string, `FACADE_DTS` in `dynamic-workflow/src/facade/dts.ts`,
built by concatenating named segments. The snippet facade is a subset built from the same
segments. Both are injected into the compiler under one file name,
`workflow-facade.d.ts`; five modules decide "is this a facade call" by that file name, so a
declaration that lives anywhere else is an ordinary script declaration.

| Segment | Declares | In the full facade | In the snippet facade |
|---|---|---|---|
| actor | `Node<T>`, `AgentPersona`, `Agent`, `agent()` | yes | no |
| args | `args` | yes | yes (always `{}`) |
| run | `run` | yes | yes (a throwaway `dwfeval-…` id, no `resumedFrom`) |
| log | `log()` | yes | yes |
| report | `report()` | yes | no |
| artifact | `ArtifactRef`, the option and spec types, `artifact.*` | yes | no |
| phase | `phase()` | yes | no |
| world | `GrepMatch`, `GitStatus`, `GitCommit`, `files.*`, `git.*` | yes | yes |
| world-run | `WorldRunResult`, `world.run` | yes | yes |
| stream | `Channel<T>`, `channel()`, `future()` | yes | yes |
| hole | `hole()` | yes | no |

The doc comments are the reference half of the contract and nothing more: what a member
does, what it returns, when it rejects or fails the run, its caps, and the compile-time
rules on its arguments. Judgment — when to reach for a member, how to name things for the
user, which idiom to write — is the skill's prose, stated once. The facade reaches the model
only through the skill's §16.2, directly after that prose, so a comment that restates it is
paid twice on every authoring session and is the copy that drifts. A test caps
`FACADE_DTS` at 14 000 bytes to keep it that way.

### Compiler options

The compiler runs `strict` against the ES2022 library alone: no DOM, no Node. `process`,
`fetch` and `fs` fail typechecking. The script body is compiled inside a function, so it
may use top-level `await` and end in `return <value>`, and it may not use `declare`,
`import` or `export`. Result types are plain `interface` or `type` declarations in the
script.

`noUncheckedIndexedAccess` is off. Models write TypeScript as if it were off, because
training corpora almost universally have it off, and with it on the "possibly
'undefined'" diagnostics on `items[i]` were the largest single cause of compile failures,
nearly all on indexes whose bounds the surrounding logic already proved (grid access,
`xs[xs.length - 1]` after a length check, `for (i < xs.length)`). So indexing an array or
record yields `T`, and an index that is genuinely out of range fails at run time like any
other script error. `strictNullChecks` stays on: `.find()`, `.match()`, `Map.get()` and
optional properties still yield `T | undefined` or `null`, and the compiler's own message
names the variable, so those stay compile errors.

### Subagents: `agent()` and `.ask()`

```ts
declare interface Node<T> extends PromiseLike<T> {}
declare class ModelRef { private constructor(); private readonly modelRef: never }
declare function model(id: string): ModelRef;
declare interface AgentPersona { system?: string; model?: ModelRef | string; budget?: { webSearch?: number } }
declare interface Agent { ask<T = string>(instructions: string): Node<T> }
declare function agent(name?: string, persona?: string | AgentPersona): Agent;
```

An **actor** (the prose word is subagent) is a persistent conversation that executes asks
one at a time. Context accumulates across asks; concurrent asks on one subagent queue in
first-in-first-out order. Every `agent()` call creates a fresh context, so sharing a
context means sharing the variable.

The **name** is optional. A non-empty name is an identity, not a label: it must be unique
within the run, and two subagents under one name fail the whole run. It is also the key an
amended re-run matches its cache on, so stable names carry finished work across script
revisions; anonymous subagents never reuse imported work. Inside a fan-out or loop each
iteration is a separate subagent, so a fixed name there is the duplicate case. The compiler
reports a literal name inside a fan-out body (diagnostic 9006) and two literal names that
collide (9005); a computed duplicate fails at run time.

The **persona** is the subagent's system prompt, given as a string or `{ system }`,
optionally the model it runs on, `{ model }` (see "Choosing a model per subagent" below), and
optionally its search budget, `{ budget }` (see "A subagent's search budget" below). It
is frozen at creation. There is no per-subagent tool profile: every subagent has the regular
working tools (reading, searching, editing, running commands). A subagent whose persona names
no model runs on the run's subagent model when the launch chose one, and otherwise on the
session's current model. What a
subagent may do with its tools is said in the ask ("do not edit any file", "judge the text
as given"). A subagent works in the permission mode
of the session that launched the run, and its permission asks reach the user in the main
window (`docs/dynamic-workflow/launch.md`, "Permissions inside a run"). The driver subtracts
only the tools that would overreach: `AskUserQuestion` (a subagent asks the main agent with
`escalate`, never the user directly), `EnterPlanMode`, `ExitPlanMode`, `CreateWorkflow`,
`ReadTopicResource` and `ResolveWorkflowQuestion`. Two control tools are added: `submit_result`, which returns a
typed result, and `escalate`, which parks the subagent on a question for the main session.
Both are described in the engine document.

`Node<T>` is a thenable. Parallelism and joins are plain JavaScript: do not await yet, and
`Promise.all([...])` is recognised as a join.

### Choosing a model per subagent

A persona may name the model its subagent runs on. The value is a model name in the same
syntax as the launch tools' `subagent_model` (a bare model id, `providerId/modelId`, either
with an optional `$reasoningLevel`), written in one of two forms:

```ts
// A fixed choice: the name, inline.
const judge = agent("评审员", { system: "…", model: "GLM-5.3-Flash" });

// Routing: declare the candidates once with model(), pick one while running.
const MODELS = {
  light: model("GLM-5.3-Flash"),
  strong: model("GLM-5.3$high"),
};
interface Route { tier: "light" | "strong" }
const route = await agent("分诊", { model: MODELS.light }).ask<Route>(`…${request}`);
const answer = await agent("答复者", { model: MODELS[route.tier] }).ask(request);
```

**Every model a script can use is known before it runs.** The rule is on the type of the
`model` property, and the compiler checks it at every `agent()` site (diagnostic 9010):
it must be a `ModelRef`, a string literal type, or a union of string literal types. So an
inline literal, a `const` bound to a literal, a ternary between two literals, and anything
typed `ModelRef` are accepted; a `let`, a parameter, a template with holes, and a persona
object built into a variable (whose `model` widens to `string`) are rejected, with a message
saying to write the name inline, add `as const`, or use `model()`. `model()` itself takes
only a non-empty string literal (also 9010). `ModelRef` can be made by nothing else: it is a
class with a private constructor and a private member, so neither `new` nor an object
literal produces one.

The names a script can use are therefore a closed set: the arguments of its `model()` calls
plus the members of every literal type at an `agent()` site. That set is resolved against the
host's model catalog when the run is launched, before the confirmation window, exactly as
`subagent_model` is (`docs/dynamic-workflow/launch.md`, "Models the script names"). A name
the catalog cannot resolve, or one it finds under several providers without the session's own
among them, is diagnostic 9011 on the line that names it, listing the ids that do exist; no
window opens and nothing runs. 9011 is the one diagnostic that needs the host: the
compiler alone cannot know which models are configured, so `SaveWorkflow` does not check it,
and the same script can launch on one machine and fail 9011 on another.

The router answers with a typed key, and code maps the key to a `ModelRef`: the judge can
only choose among models the script declared, and never writes a model name. A literal-union
field on the answer (`model: "GLM-5.3" | "GLM-5.3-Flash"`) also passes 9010, and is safe for
the same reason (`submit_result` validates the answer against the enum synthesized from that
type), but the skill teaches the key-to-`ModelRef` table.

At run time a `ModelRef` is its name string: lowering erases `model("x")` to `"x"`, and the
engine records the name in the persona. The host maps it through the table the launch
resolved. A name missing from that table, which only a cast can produce, fails that
subagent's first ask with `DriverError`.

Whose choice the name is matters as much as its syntax. A persona names a model only when
the user asked for one, and the authoring agent never moves a subagent to a model under
another provider on its own, however light the work looks: another provider is another bill
(`docs/dynamic-workflow/launch.md`, `subagent_model`, states the rule for the run-level
field; it is the same rule). Seeing the fit is a reason to ask, not to act: the agent
proposes the model and asks the user before the call, and their yes is the request. A bare
name resolves only within the session's provider; when
the user asked for a model that lives elsewhere, the script writes it as
`providerId/modelId`, which is what the resolver demands for crossing the boundary.

A subagent's own model outranks everything else; the run's `subagent_model` becomes the
default for the subagents that name none (`execution-engine.md`, "Subagent sessions").
The model is not part of a subagent's cache identity: an amend that changes only the model a
named subagent runs on keeps its finished work, and its next live ask runs on the new model,
the same rule `AmendWorkflow`'s `subagent_model` follows.

### A subagent's search budget

Each ask a subagent runs may make at most **128** `WebSearch` calls. A persona can set its
own number when an ask is expected to need more:

```ts
// An ask expected to search widely: more searches per ask.
const scout = agent("调研员", { system: "…", budget: { webSearch: 512 } });
```

**The budget is counted per ask.** The turns that finish one ask, a nudge or a repair after a
rejected `submit_result`, draw on the same count; the next ask on the same subagent starts
from the full budget. A resumed run re-executes the interrupted ask, so that ask also starts
from the full budget. A `WebSearch` call counts once, however many provider-side searches it
runs. The call is counted when it starts, so in a batch of parallel calls exactly the first
calls up to the budget run.

**A call over the budget sends no request.** It returns an error result saying that the search
budget for this task is used up, that `WebSearch` must not be called again in this task, and
that the subagent should finish from what it has and say in its result that its search was cut
short. That sentence in the result is how the main agent, and through it the user, learn that a
budget was hit. Nothing else changes: the turn goes on, every other tool works, and the ask
settles the usual way.

**The value is known before the run starts.** It is an integer from 0 to 1024: a numeric
literal, a `const` bound to one, or a union of such literals. The compiler checks the type of
`budget.webSearch` at every `agent()` site (diagnostic 9013), so the number a subagent gets is
in the script the user confirms. There is no unlimited value. A model that has degenerated
inside a long turn can keep emitting searches for as long as nobody stops it, and a finite
budget is what ends that; a script that needs more writes a larger number.

**Whose choice the number is.** The default fits almost every ask, so the skill teaches only
one move: the authoring agent sets a larger number when it anticipates an ask needing more
searches, which should be rare. It does not tune budgets down; `0` is legal but not taught,
because a line spent telling a subagent not to search is usually prompt the run does not need.
When a subagent reports that its search was cut short, the remedy is an amend with a larger
budget. The budget is not part of a subagent's cache identity, so that amend keeps the
subagent's finished work, and the new budget applies from its next live ask.

The budget bounds one tool's resource use; it is not a cap on how many tool calls a subagent
makes, and no other tool is counted (`apps/zcode-cli/docs/design/v2/loop/model-anomaly-fallbacks.md`
keeps that rule for every agent loop). Interactive sessions and `Agent` subagents have no
`WebSearch` budget.

### Typed results

`ask<T>` takes an interface the script declares. The harness synthesizes a JSON schema from
the type, the subagent submits a conforming value through `submit_result`, and the
validated value is what the script receives. Without a type argument the ask returns the
subagent's final text. A JSDoc comment on a property becomes that field's schema
description, which is the text the subagent reads when filling it in; the skill calls this
the cheapest quality lever in the surface. The type must be expressible as a JSON schema
(diagnostic 9002). How the schema reaches the subagent, and the typed tool declaration a
mono-typed subagent gets, are in the engine document.

### Reading the world: `files.*` and `git.*`

These are journaled, read-only observations executed by the harness. A resumed run replays
the recorded value rather than re-reading the world. Paths in and out are
workspace-relative; the workspace is the world, so a workspace that is a subdirectory of
its repository does not see changes outside it (`git.log` excepted, because commits are
repository-wide objects). Every cap rejects the call rather than returning a partial view,
and the rejection is catchable, so a script that wants a coarser fallback writes one.

| Call | Returns | Cap |
|---|---|---|
| `files.glob(pattern)` | workspace-relative paths, sorted lexicographically | 2000 files |
| `files.read(path)` | UTF-8 text | size-capped |
| `files.grep(pattern, glob?)` | `{path, line, text}` per matching line, ripgrep syntax | 2000 matches or 256KB, whichever first |
| `git.changedFiles(base?)` | changed paths; with no base, modified against HEAD plus untracked | |
| `git.diff(base?, path?)` | unified diff against base (default HEAD) | 512KB |
| `git.status()` | `{branch?, clean, staged, unstaged, untracked}` | |
| `git.log(count?)` | `{hash, subject, author, date}` newest first, default 20 | 100 commits |

`git.*` is read-only by construction: the harness builds a fixed argument list for one
allowlisted subcommand and never a shell string. A base must name a single ref. Outside a
git repository, or with no `git` binary, every call rejects, so the idiom is `try`/`catch`
with a `files.glob` fallback. There is no write: writing to the world is a subagent's job.

### Running commands: `world.run`

```ts
declare interface WorldRunResult { exitCode: number; stdout: string; stderr: string }
declare const world: {
  run(
    cmd: string,
    args?: string[],
    opts?: { timeoutMs?: number; output?: "full" | "discard" | { tail: number } },
  ): Promise<WorldRunResult>;
};
```

`world.run` is the journaled effect primitive: the harness executes the command exactly
once per call site and iteration, records the result, and replays it on resume. Resume is
crash recovery, not re-verification; a run that needs to re-check a changed world is a new
run.

The contract differs from `git.*` on purpose:

- **A nonzero exit is a value.** A process that ran to completion resolves to its
  `{exitCode, stdout, stderr}` whatever the code. A failing check is the gating loop's
  normal case and does not travel exception control flow.
- **The promise rejects only when the command could not run as an observation**: spawn
  failure, or timeout. The default timeout is 300 seconds; `timeoutMs` overrides it per
  call with no upper cap, because real test suites take longer. Cancelling the run remains
  the control of last resort.
- **The command name is a compile-time string literal** (diagnostic 9003). That is the
  whole authorization: every command a script can run is readable off its text before the
  user approves it, and the confirmation graph shows each call as a `run <cmd>` step. The
  driver runs whatever command the compiled script hands it; there is no second, runtime
  list. There used to be one, built from the seed script at launch, and a fill whose body
  ran a new command was refused by it, because a fill compiles the effective script but
  the driver kept the seed's set. A list that must be kept in sync with the analyzer by
  hand is a second source of truth for a fact the analyzer already settled.
- **Fixed argv, never a shell.** No pipes, no redirection, no variable expansion, no
  `cwd` or `env` option: the working directory is the workspace and the environment is
  inherited. Compose with several calls and plain code. Runtime values go into the args
  array, where a value derived from an ask's result draws a data edge in the graph. A
  helper that needs Node builtins is inlined as `world.run("node", ["-e", code])`; the code
  string lives inside the script and inside the journal key.
- **Output is declared at the call site with `opts.output`.** One mode applies to both
  streams:

  | `output` | `stdout` / `stderr` | Limit on what the process prints |
  |---|---|---|
  | `"full"` (default) | the whole stream | 16 MiB per stream; over it the call rejects |
  | `"discard"` | always `""` | none; the process runs to exit |
  | `{ tail: n }` | the last `n` bytes of each stream | none; `n` is an integer, 1 ≤ n ≤ 16 MiB |

  In `"full"` mode a stream over 16 MiB rejects the call with `WorldReadCapExceeded` and a
  message naming the next move (`output: { tail: n }` or `"discard"`, quiet the output, or
  write a file and `files.read` a summary). Nothing is truncated silently. The 16 MiB is a
  journal budget, not a model-context budget: the `dwf_node` row stores the result as it is,
  and resume replays it, so the value the script saw and the value in the journal must be
  the same bytes. That is why the bound is declared in the script and not applied by the
  harness: a `discard` or `tail` result is the whole result of that call, and the journal
  stores exactly that. A gate that only needs the exit code uses `"discard"`; a gate that
  shows the failure to a subagent uses `{ tail: n }`. In `"discard"` mode the run panel
  shows 0 bytes for both streams, and in `{ tail: n }` mode it shows the kept tail's size,
  not the process's total, because it reads the sizes off the stored result.
  `{ tail: n }` cuts at a byte offset, so its first character can be a broken UTF-8
  sequence decoded as U+FFFD.

Argument shape is checked by the driver and a wrong shape is a `DriverError`: `cmd` must be
a string, `args` an array of strings, `timeoutMs` a positive integer, `output` one of
`"full"`, `"discard"` or `{ tail: n }` with `n` in range. `opts` is part of the
journaled input and its hash, so changing `output` makes a new node: it is not a replay
and not an import-cache hit. The journal records
the node with kind `world-run`, distinct from `world-read`, so an audit can tell effects
from reads. In the graphs it is a step on the workspace lane like any world read (see
`docs/analysis.md`, "Sites").

The guidance the model gets with the signature: model generates, code gates. A fixed,
machine-checkable check (build, proof checker, test suite) belongs in `world.run` with the
script branching on `exitCode`, not in an ask whose claim of success the subagent can fake.
Open-ended editing belongs to a subagent.

### Progress: `log` and `report`

`log(message)` emits a progress line to the person watching the run. It has no site and no
journal row.

`report(item, artifactId?)` publishes one intermediate result while the run is still going.
It returns nothing and there is nothing to await, but unlike `log` it is journaled: a
resumed run never shows the same item twice, and the items are delivered with the
completion notification even when the run ends in failure. That is its purpose: a run that
dies on its twelfth of forty tasks keeps eleven tasks' worth of work only if the script
reported each as it landed. The item must be JSON-serializable. Two caps fail the whole run
rather than the call, because a void return has no rejection channel: 65,536 items per run,
1 MiB per serialized item, and 1 GiB of items per run. A result larger than an item should
be is published with `artifact.file` instead. The optional second argument tags the item for a dashboard
artifact (see "Artifacts").

### Streams: `channel` and `future`

```ts
declare interface Channel<T> extends AsyncIterable<T> {
  send(item: T): void;
  close(): void;
}
declare function channel<T>(name?: string): Channel<T>;
declare function future<T>(body: () => Promise<T>): Promise<T>;
```

A **channel** is an unbounded first-in-first-out queue of typed items that one stage of a
script fills and another drains. A **future** starts an async block now and hands back its
promise to be joined later; it is the named form of an immediately invoked async function.
Together they say what a nested per-item callback cannot: a stage served by a bounded pool
of consumers, a producer that keeps discovering items while consumers are already at work,
stages written as separate top-down blocks, and a feedback loop from a later stage to an
earlier one.

Semantics, fixed on purpose:

- **`send` is synchronous and returns nothing.** The buffer is unbounded: asks are the only
  scarce resource and the run's concurrency cap already governs them, so a bounded buffer
  would add a second scheduling mechanism and a second way to deadlock for no gain. A send
  on a closed channel throws `ChannelClosed`, catchable like any script error.
- **`close` is explicit and idempotent.** It marks the end of the stream: every receiver
  still waiting, and every later one, sees the end once the buffered items have been
  drained. A channel's end depends only on its producers calling `close`, never on the state
  of the rest of the run.
- **Receiving is `for await`.** Each item goes to exactly one receiver, in send order;
  receivers waiting on an empty channel are served in the order they started waiting. There
  is no broadcast, no peek and no `select` over several channels in this version.
- **Both live inside the sandbox.** Like `Promise.all`, they are ordinary promise machinery:
  no host call, no journal row, no site id, no engine event. A replayed run reproduces every
  delivery, because the engine replays the order in which host promises settled (the engine
  document, "Replaying the settle order") and everything a channel does is a deterministic
  consequence of that order.
- **`future(body)` starts `body` at once**, runs it to its first `await`, and returns its
  promise. A body that throws synchronously yields a rejected promise. It defers nothing, so
  issue order stays source order, which is what the analyzer assumes.

**A stalled run fails instead of hanging.** The sandbox has no timers and no I/O of its own;
the only thing that can wake a suspended script is a host response. So whenever a response
has been delivered and its continuations have run, and no request is in flight while the
script has not completed, nothing can ever run again. The cell then fails the run:
`ChannelDeadlock` when receivers are waiting on channels, naming each channel and how many
are waiting, so the message says which producer forgot to close; `ScriptStalled` otherwise,
for a promise that can never resolve. Neither is a timeout: the check fires at the moment
the run has provably nothing left to do.

The idioms the skill teaches:

- **A stage is a future.** The phase marker stands first in its body, the workers are a
  `Promise.all` over K loops of `for await` on the input, and the output closes in a
  `finally`, so a failing worker still ends the stream for the stage downstream. Every
  stage is started, then all of them are joined once with `Promise.all`, with no `await`
  between the two: while the script awaits one stage, a failure in another has no listener
  and surfaces as an unhandled rejection instead of failing the run with its error.
- **A channel where the next stage should start before the previous one ends; a join where
  it cannot.** Researchers into verifiers is a channel. Verified facts into one writer is a
  shared array and the join, because the writer needs every item.
- **A cycle is counted.** A feedback channel has no single producer who knows when it is
  done, so the script keeps one count of open work items, increments before it finishes the
  item that produced the new one, and closes the feedback channel when the count reaches
  zero; a depth field on each item bounds the loop. The counter is the skill's copyable
  fragment, not a facade type: a `WaitGroup` would move the `if` but not the placement of
  increments and decrements, which is the part that can go wrong.
- **Pools trade cache locality for consistency.** A pool of K shared contexts assigns items
  by timing, so an amendment that changes one upstream item shifts the assignment and misses
  the cache for the whole pool; a fresh, item-named subagent per item misses only the
  changed item. Both are legitimate; the skill says when each is.

Analyzer view (`docs/analysis.md`): `channel()` and `future()` mint no site. A `send` is a
container write and a `for await` over a channel reads the container, so every producer of
an item draws a data edge to every consumer, which is the picture the pipeline should
show. The `for await` is a may-barrier over the producers' steps. A `future` body
inlines at the call as an entered strand, exactly as an inline `async` callback does. The
facade-siting rule applies as to every facade callable: `channel`, `future`, `send` and
`close` may only be called directly, while a channel value may be stored, passed to helpers
or retyped freely, because it carries no site.

### Holes: `hole<T>()`

```ts
declare function hole<T>(name: string, prompt?: string): Promise<T>;
declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;
declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;
```

A **hole** is a typed gap in the script: a place where the author does not yet know what
the program should do, because it depends on what an earlier step finds.
`await hole<Plan>("决定分组", `…${survey.slowest}…`)` parks that branch of the script when
control reaches it and hands the main agent a request to write the missing code. The main
agent fills it with a body (`FillWorkflowHole`, `docs/dynamic-workflow/launch.md`), the body
runs in the hole's place, and its return value is the hole's value. Everything else in the
run keeps going: a sibling future, a fan-out already in flight, a subagent mid-turn. Holes
are how a workflow is drafted piece by piece: the author writes what is known, leaves holes
typed by what the rest of the script needs, and the decisions are made with the run's own
findings in hand.

**A hole is a phase, and its name is its identity.** The name obeys the phase-name rules: a
non-empty string literal of at most 128 characters, written for the user in the user's
language, since it labels the station, the notification, the run pane and the fill file. It
must be **unique** among the script's holes and its phase markers, nested fills included
(9012): two markers with one name are one phase by design, but two holes with one name would
be two gaps with two types and two contexts, and merging them would be wrong. The site id is
the machine key the tool takes, and it is derived from the name: `hole#` and eight hex
digits, the same at any nesting depth (`docs/analysis.md`, "Sites"). The name is what every
surface shows, and the two are a bijection. When the body is filled, the hole's phase claims
the body's sites up to the body's first `phase()` marker, and the body's markers are phases
of their own that stand after it. So a body without markers is one station named after the
hole, holding the fill's asks; a body that opens with a marker leaves the hole's own phase
without members, and the phase stays in the run's phase list under the hole's name while
the timeline lets the fill's head stand for it.

The type argument is the contract. `T` is what the rest of the script needs from the hole.
It must be written explicitly (diagnostic 9012), and the body must return a `Promise<T>`,
which the compiler checks by the ordinary contextual typing of the arrow. Nothing is
validated at run time: a fill is code compiled against the whole script, not a value
arriving over a wire.

The **prompt** is the author's message to the main agent, a template string evaluated at the
site, so it carries the values the decision needs: `survey.slowest`, a count, a list. It is
the only channel: the agent reads values from the prompt and from the journal, and types
from the code. It is bounded like an escalation's context, and it is a taint sink, so the
confirmation graph draws what flows into the hole.

A filled hole is the same call with the body as its last argument:

```ts
const plan = await hole<Plan>("决定分组", `只跑一遍 ${survey.slowest} …`, async () => {
  phase("冒烟测试");
  const smoke = await agent("烟测员").ask<Smoke>(`只跑一遍 ${survey.slowest} 里的用例`);
  phase("分组");
  return await agent("分组员").ask<Plan>(`按模块分组，先排 ${smoke.failed.length} 个已失败用例`);
});
```

The body is an ordinary async function body **in the hole's lexical scope**: it reads every
binding declared before the hole, may assign outer `let`s, may return early, may declare
phases, subagents and asks of its own, and may leave holes of its own. It runs each time the
hole is reached: a hole inside a loop or a helper is filled once and its body runs per
iteration with that iteration's bindings, unlike `escalate`, which is answered per call. A
hole inside a fan-out callback (`xs.map(async x => …)`) is a compile error (9012): its fill
would have to be written while the elements are already running; a `for...of` body is
sequential and may hold one. The script that a fill produces, the **effective
script**, is plain TypeScript. It is what a resume replays, what an amend revises and what
`SaveWorkflow` keeps, so a saved workflow has no hole in it that its author did not leave on
purpose.

The tail form `return await hole<Result>("评判", …)` leaves the end of the script open: the
run's result is whatever the fill returns. It is also how a workflow **grows** when its
shape cannot be planned from the request: the script does what it can plan and ends in a
tail hole; each fill does one step and ends in a new tail hole of the same type, named for
the next step (names are unique across the effective script, so `第N步：…`); the last fill
returns. The effective script after k steps is k nested filled holes, and the timeline shows
one head per step. The skill teaches holes as the default posture, not a fallback: a script
is what the author knows for sure, and any phase whose subagents, asks or gate would have to
be guessed is a hole (§1 and §2 say so where the script's shape is decided, §15 gives the
idioms). The rule that separates a hole from a subagent ask: a subagent returns a value the
script already knows how to consume, a hole returns the code the script does not have yet. A fill that throws at run time rejects the hole's
promise at the site with that error; the script may catch it, and otherwise the run ends
errored like any script error, with the effective script in the run's draft for
`AmendWorkflow`.

The compile rules are 9012, in "Compile-time rules". The analysis is `docs/analysis.md`,
"Sites"; the engine side is the engine document, "Holes"; the timeline is
`docs/dynamic-workflow/presentation.md`, "Holes on the timeline".

### Phases

`phase("name")` is a presentation marker. It starts nothing and returns nothing; it groups
the steps that follow into the named stage the confirmation graph draws one node for. The
name must be a non-empty string literal and the call must stand alone as a statement
(diagnostic 9004); the marker claims the rest of the block it stands in, nested blocks and
inlined helper calls included, and two markers with the same name are one phase. Lowering
rewrites it to a host call so the engine can announce the phase as it is entered. The
analysis rules are in `docs/analysis.md`, "Phases".

Run-time stamping is **lexical where the script fixes it**. The compile step derives, from
the same interpretation the confirmation graph is drawn from, the phase each site belongs
to; every site that the analyzer places in exactly one named phase is stamped with that
phase when it is minted, whatever marker the engine happened to pass last. Only a site the
analyzer cannot place, a helper called from two phases or a call before the first marker,
falls back to the phase current at the moment of the call. The rule exists for concurrent
stages: two futures each opening with their own marker run at the same time, and a producer
that issues a second ask after its first `await` would otherwise be stamped with whichever
stage's marker ran last. It also keeps the run pane consistent with the graph the user
approved, which placed that step in that phase. The engine side is in the engine document,
"Identity: sites, ordinals, phases".

Phases are required in every submitted script, top to bottom, and every phase must contain
at least one ask or one `world.run`. Plain script logic between two asks (reading `args`,
shaping a prompt, building the return) runs in a flash and is not a stage; it folds into
the phase before or after it. Neither the setup at the top nor the `return` at the bottom
gets a phase.

### Run arguments: `args`

`args` is a read-only bag of the values supplied when the run started. A saved workflow
declares its arguments; the host validates the caller's values against the declaration and
fills in defaults before the run starts. For an inline script and inside a snippet it is
`{}`. Values are typed `unknown` so the compiler surface never changes from one workflow to
the next; the script narrows them. Declarations and validation are in
`docs/dynamic-workflow/launch.md`.

### The run's identity: `run`

`run` is a frozen `{ id, resumedFrom? }`. `id` is the run id that the run list,
`GetWorkflowRun` and the subagents' session ids carry. `resumedFrom` is present on a run
made by `AmendWorkflow` and names the run it revises. `ResumeWorkflowRun` keeps both: the
id does not change, and the host reads `resumedFrom` back from the journal, so a resumed
script reads the same values as the life that started it. This lets a script stamp what
outlives it (a ledger line, a file written for a later run, a report item) with the run
that produced it, without the main agent passing the id in through `args`.

`run` is a value, like `args`: lowering rewrites a read of it to `__host.run`, it has no
site, and a script's own local named `run` shadows it. `world.run` is a property and is not
affected.

Keep `run.id` and `run.resumedFrom` out of ask instructions, personas and `files` / `world`
arguments. Those are cache keys ("How the engine consumes the cache" in
`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`), and an amendment mints
a new id: an ask that quotes the id misses the cache on every amendment and runs again. A
resume is not affected, because its id does not change.

### What the facade does not have

There is no `budget`: the harness enforces no token budget and no node cap, and a script
cannot read either. Token usage is accounted per run as an observation surface only (see
"Usage, not budget"). There is no tool profile and no model tier on the persona (see
"Alternatives not taken"); a persona names a concrete model or none. There is no interactive permission prompt inside a run: the
confirmation window is the one place the user approves what the script can do.

## Compile-time rules

The analyzer adds its own diagnostics to TypeScript's. Each names something the script must
fix before submission, because it cannot be recovered later. The full table and the
reasoning are in `docs/analysis.md`, "Diagnostics"; the authoring-facing summary:

| Code | Rule |
|---|---|
| 9001 | Facade callables appear only as the callee of a direct call, and a value carrying a site-producing member is never converted to a type that lacks it. |
| 9002 | An `ask<T>` type is expressible as a JSON schema. |
| 9003 | `world.run`'s command is a string literal. |
| 9004 | `phase()`'s name is a non-empty literal and the call is its own statement. |
| 9005 | Two `agent()` sites do not share a literal name. |
| 9006 | An `agent("x")` inside a fan-out body has a fixed name for every element. |
| 9007 | An artifact id is a non-empty literal of at most 64 characters from `[A-Za-z0-9_.-]`; one id belongs to one artifact kind; a `report` tag is a literal naming a preset the script declares. |
| 9008 | A preset artifact is declared at the top level, not inside a loop, callback or conditional branch. A filled hole's body is not a callback: it runs where the hole stands, so a fill may declare a preset unless the hole itself sits in a loop, callback or branch. |
| 9009 | At most one artifact id carries a literal `primary: true`. |
| 9010 | A persona's `model` is a `ModelRef`, a string literal, or a union of string literals, and `model()` takes a non-empty string literal. |
| 9011 | Every model name the script uses resolves in this host's model catalog (checked at launch, not by the compiler; see "Choosing a model per subagent"). |
| 9012 | A `hole<T>()` names its type argument explicitly; its name is a non-empty literal of at most 128 characters, unique among the script's holes and phase markers; the call is awaited; it stands outside every fan-out callback (a `for...of` body is fine: it is sequential); its body, when present, is an inline function literal that references no binding declared after the hole. |

9007, 9008 and 9009 come from `dynamic-workflow/src/analysis/artifacts.ts`. 9008 is separate
because its certainty differs: re-declaring an identical spec inside a loop would be a
harmless no-op at run time, so this one rule can flag a script that would have run. The fix
is free (move the declaration to the top), and the alternative is a dashboard declaration
buried three callbacks deep. A named helper function that declares a preset and is called
once is not flagged; arrow functions and function expressions are treated as callbacks,
except the body of a filled hole. That body is spliced in where the hole stands and runs once
per reach, like the statements around it, so the rule looks straight through it to whatever
encloses the hole; otherwise no fill could declare a dashboard for the stage it writes.
9009 has the same character: two ids flagged in mutually exclusive branches would run, but
the run pane and the completion card lead with exactly one deliverable, and a script that
cannot say which is not finished. Only a literal `true` counts; a computed flag is left to
the run-time check.

The analysis collects the `world.run` command set (`collectWorldRunCommands`, deduplicated
and sorted) and `declaredArtifacts` (`[{id, kind}]`, deduplicated, sorted by id). Both are
fixed at submit time because their values are literals; that is what lets the confirmation
window show the commands before anything runs, and what lets the snippet tool ask only when
a snippet runs a command. Neither set is carried into the run: the driver re-checks nothing.

## The `/workflow` command and the skill

Both are built into the CLI. Neither lives in a plugin any more: until 2026-09-21 they
shipped from the `zcode-guide` official plugin, and a user who uninstalled or disabled that
plugin lost the command, the composer's plus-menu entry and the skill while the ten workflow
tools stayed registered (the 2026-09-19 "no workflow" reports). The tools and their
teaching material now have the same lifetime.

| Asset                     | Where it lives                                                                                       | How it ships                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| `/workflow`               | `bootstrap/src/builtin-workflow-command.ts`, expanded by `builtin-prompt-command.ts` next to `/init` | compiled into the CLI             |
| `dynamic-workflows` skill | `apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/`                                   | the **bundled skill pack**, below |

The bundled skill pack (`bootstrap/src/app/bundled-skills.ts`) is a skill root with
`source: "bundled"` and `scope: "system"`, injected next to the plugin skill roots wherever
the CLI discovers skills (the runtime's skill port, `zcode skills list`, the protocol's
skill catalog). It is not a plugin: it is absent from the plugin store, has no
enable/disable switch, cannot be uninstalled, and is not listed on the Settings skills page
or in the composer's `$` skill picker (the protocol's `skills/referenceCatalog` filters
`bundled` skills out rather than widening its closed `scope` enum, which older clients
validate strictly). The model still sees it in the session's skill listing and loads it with
the `Skill` tool exactly as before. It ranks after every user, project and plugin root, so a
same-named skill from any of those wins.

How the pack reaches each runtime:

- Development and the Electron desktop resolve `packages/bundled-skills` on disk next to the
  CLI entry, through the same candidate-directory walk official plugins use, and read it in
  place; nothing is copied. `packages/desktop/scripts/prepare-agent-node-bundle.mjs` stages
  it beside `resources/glm/zcode.cjs`.
- ZCode Server releases (headless Server and SSH / WSL / Docker Source Server) use
  `stageRelease` to stage the pack's `README.md` and `skills/` from `bundledSkillsDir` at
  `runtime/packages/bundled-skills`, beside `runtime/zcode.cjs`. Other top-level files are
  excluded. The pack belongs only to the `agent-runtime` component, including its content
  hash and archive, and is not listed in the manifest's `plugins`. Official plugin staging
  neither supplies nor overwrites the pack. Development remote
  deployment stages the same directory beside its agent bundle, includes every pack file
  in the deployment hash and checks the required files before reusing a remote installation.
  Both paths reject a missing or incomplete pack before publishing or uploading. They do
  not depend on an old plugin cache or on the server's working directory.
- SEA binaries embed `skills/**` under the `zcode-bundled-skills/` asset prefix
  (`cli/scripts/sea-bundled-skill-assets.mjs`) with a manifest whose hash covers every file.
  On start the CLI extracts the pack once into `~/.zcode/cli/bundled-skills/<hash>/`; the
  directory name is the content identity, so restarts are idempotent and concurrent starts
  have exactly one winner. A hash mismatch refuses the pack and falls back to the newest
  complete extraction.

Every file under `skills/dynamic-workflows/` is a required asset: a stage, a SEA build or an
extraction that loses one refuses the whole pack and logs `Bundled skill pack unavailable`
(or `seed degraded`) instead of shipping a skill with a missing reference file.

### The command

`/workflow <instructions>` is a prompt command, not a skill: a skill cannot take arguments
(the `Skill` handler discards them), and a command can declare `skills: dynamic-workflows`,
which makes the harness load the skill before the body runs. The command is defined in code
as a `CustomCommandContent` literal and expanded through the same contracts helper user
commands use, so the prompt the model receives is the one the plugin-era command produced:
the `Required skills` preamble, then the body with `$ARGUMENTS` interpolated. The body tells
the model to decide the subagent topology first (how many subagents, which share a context,
what result each returns), then write the script and call `CreateWorkflow`. It names
`CreateWorkflow` explicitly and says not to substitute the legacy `Workflow` tool or the
`Agent` tool, because the older script-workflow feature still exists under the same word.

`workflow` is a reserved slash-command name (it has an entry in
`packages/shared/src/zcode-slash-command-help.ts`, which is also where the catalog's
description and input hint come from). A user or plugin command of the same name is not
advertised and is never expanded, so nothing can shadow the built-in or reach around the
gray gate through a look-alike custom command.

A workflow starts only on the user's word. The two doors are this command and an explicit
request in prose ("use a workflow to …", "用工作流 …", any phrasing that names workflow as the
means). The model never starts one on its own initiative: the `CreateWorkflow` description
says an explicit request makes the tool mandatory and that without one the model delegates
with `Agent` or does the work itself, whatever the task's shape; the `Agent` description
repeats the first half and nothing else in the prompt invites proactive use. The earlier
routing hint that multi-subagent orchestration "belongs to CreateWorkflow" without a request
was removed on 2026-09-16 for the same reason, and the skill's routing table now routes by
request only (below). This keeps the model's behaviour identical whether the gray gate is on
or off: the only thing the gate changes is whether the door exists. Under the `onDemand` mode
the prose door does not exist until the session has been activated: `CreateWorkflow` is not
registered, so a prose request is handled the way it is under `disabled`, with `Agent` or by
the model itself, and `/workflow` is the one door until then. After activation both doors
are open for the rest of the session (launch.md "On demand: activation").

The command appears in the `/` menu in the desktop app and the TUI. In the desktop `/`
panel it sits directly after `/goal` as one of the two "start a piece of work" entries (the
order of `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`), and the composer's plus menu
offers a Workflow item below Goal that expands to `/workflow` at the start of an empty
draft. The TUI parses it as a known command and submits the raw text, like `/init`. In
headless mode, `-p "/workflow …"` is a known command that is not `/expert` or `/goal`, so
it rides the plain-prompt path and the workflow settle-wait and progress lines attach as
they do for a typed prompt. In the TUI and headless runs the command exists only when the
process was started with `--workflow-mode onDemand` or `alwaysOn`; without the flag the mode is
`disabled`, the TUI hides the command and answers it with a local notice, and headless exits
with an error (launch.md "The standalone CLI: `--workflow-mode`"). All three front-ends
expand it in one place, the input facade's builtin prompt resolver, and that expansion is
also where an `onDemand` session is activated: the resolver asks the runtime to register the ten tools before the turn is
executed, so the very turn that carried the command already sees `CreateWorkflow`.

### The skill

The skill's frontmatter `description` front-loads its trigger, "writing, debugging, or
resubmitting a dynamic-workflow script for the CreateWorkflow tool", within the first 250
characters the session listing shows, and stays under the loader's 1024-character cap. The
`when_to_use` line says a single delegation or a few independent lookups belong to the
`Agent` tool: the trigger is deliberately narrower than "multi-agent work". The skill is
not shown on the Settings skills page or in the composer's `$` picker (see above), so it
carries no UI localization entry.

`SKILL.md` holds the decision rules, the anti-pattern table, the post-submit lifecycle and,
as §16 "Tool reference", the contract the tool descriptions no longer carry: `CreateWorkflow`'s
three sources and its fields, the facade declarations embedded verbatim between
`<!-- facade-dts:start -->` and `<!-- facade-dts:end -->`, the rules the compiler and the
analyzer enforce, and the fields and rules of `AmendWorkflow`, `SaveWorkflow` and
`EvalWorkflowSnippet`. Two reference files are read on demand through `${ZCODE_SKILL_DIR}`:
`patterns.md`, a catalogue of sixteen topology shapes as fragments, whose index sends the
reader to the pipeline shapes first (per-item chaining, streaming through channels, a feedback
loop with a counted close) and then lists the rest (fan-out over a glob, changed-file review
sweep, planner and reviewer loop, judge panel, loop until approved, staged handoff, bounded
discovery, salvage by report, gated verifier loop, model routing, and the three hole shapes);
and `examples.md`, seven complete scripts (an adversarial implement-and-verify loop, flaky
test triage with judge and confirmer chained per finding, a call-site migration, a prover loop
gated by the real checker, the changed-file review that streams: a reviewer per file, triage
through one shared subagent that is fed as reviews land, a confirmer per kept finding, all
inside one callback and one phase, with the cross-file deduplication as the only join; a
fact-finding pipeline with a fresh verifier per fact; and a repository guide grown through
tail holes). The review script lived in `SKILL.md` §11 until 2026-09-21 and moved out to
keep the file under the `Skill` tool's 100 000-byte cap once §16 arrived; §11 now points at
it. The skill restates the facade exactly once, in §16.2, and nowhere else.

The `Skill` tool loads this skill with a 200 000-byte cap (`WORKFLOW_SKILL_MAX_BYTES` in
`core/src/tool/handlers/skill.ts`); every other skill keeps 100 000 (`MAX_SKILL_BYTES`). The
cap was raised on 2026-09-30, after `SKILL.md` had sat at the old one for a week and every
new feature had to be paid for by cutting existing guidance. The larger cap is keyed on the
requested name, `dynamic-workflows`, the same identity the skill gate checks, so a user or
project skill of that name, which shadows the bundled one, gets it too. The cost is context:
at about 4.15 bytes per token a full 200 000-byte skill is about 48 000 tokens, held for the
rest of every session that writes a workflow and loaded again after each compaction. The cap
is a ceiling, not a target.

What the skill teaches, section by section:

| Section | The rule |
|---|---|
| The bar | A workflow exists to produce the deliverable a senior practitioner would hand over. When a shortcut and the expert's way disagree, take the expert's way. Depth is measured by what is at stake: trim the work when the task is small, trim the checking when a wrong claim costs little or a command has already decided. |
| Is this the right tool | Routing is by request, not by task shape. When the user names workflow as the means, `CreateWorkflow` is mandatory and size decides only how many subagents; without that request the task goes to `Agent` (one delegation, or independent lookups in parallel) or is done inline, however multi-step it is. Only once a workflow has been requested does shape matter: results feeding results, a loop with a stopping condition, control flow on a typed result are what the script is good at. |
| Subagent topology | Fresh subagent per item gives independent, parallel verdicts; one shared subagent gives consistent verdicts and serializes. Names are unique identities and the amend cache key. Personas stack on the harness contract, so write the role, not the rules. At every hand-off, an item moves on to the next stage as soon as it is done; the stage waits for all its items only where the next step needs every one. Reuse the same two subagents across loop rounds. No nesting. |
| Choosing models | Only when the user asks for a model, with the name they used; never a model under another provider unless the user asked for that model, however light the work — when a lighter model would clearly fit, ask the user before the call and take their yes as the request. A fixed choice is the name inline; routing declares a `model()` table at the top and maps a typed key from the router to it. Names come from `ListModels`; every one is checked at launch. |
| Fresh eyes | A separate context sees the gaps the author filled. Ask for failures, not approval. Give reviewers the same evidence. One deliverable, one mechanism: a plan gets a reviewer who reads the code, findings get a confirmer, prose gets a reader; two is the ceiling and needs a reason. The independent read is for prose nothing else checked; a report whose findings were each confirmed has had its eyes. Not a gate on submitting the script. |
| Typed results | Type the ask when control flow branches on it. JSDoc becomes the field description. Keep results narrow; pass paths, not file contents. |
| Getting the world in | `files.glob` and `git.changedFiles` are fan-out sources. Caps reject. `world.run` is the deterministic gate. Choose the gate from the repository's own checks, build it in two tiers, and let the strongest tier the request implies decide the exit, run at least once before the final return with the timeout it needs. |
| Test the pieces | Fixed logic is verified in `EvalWorkflowSnippet` before submission; what passed pastes in verbatim. Run the deciding check once there to learn its output shape and its duration. |
| Pipeline by default; join only where the next step needs every item | A run with more than one stage is a pipeline: every stage works at the same time, and each item moves on the moment it is ready. Stages that map one to one are chained per item inside one fan-out, with one join at the end. A pool of shared workers, a producer still finding items, a feedback loop, or stages written as separate blocks use a `channel` between the stages and a `future` per stage. A join is written only where the next step needs every item (deduplication, a ranking on one scale, a synthesis) and carries a comment saying so. Parallelism comes from not awaiting yet. A shared calibrated subagent is a FIFO queue, not a barrier, so it is fed as items land. One rejection inside `Promise.all` sinks the join; catch per item or use `Promise.allSettled`. Results flow through plain variables, interpolation and destructuring so the analyzer can trace them. |
| Named phases | Required; one marker at the head of each stage; every phase contains an ask or a run; names for the user. Never inside a concurrent fan-out callback: the engine keeps one current phase and stamps each instance at birth, so callbacks re-entering two markers out of order would stamp each other's steps and count every re-entry as a round. A per-item pipeline is one phase, named for what it does to each item. |
| Write for the user | Seven things are read by the user: phase names, hole names, subagent names, `log` lines, artifact titles and markdown, the four report fields, escalated questions. Write each in the user's words and language, never in the machinery's. Method idioms in the skill are for the author, not words to translate literally. Findings are written by subagents, so asks carry the user's language too. |
| Verify in proportion to what a wrong claim costs | Confirm the findings the user will act on as fact, and keep a finding that fails confirmation labelled `unconfirmed`. Three things look like verification and are waste: a confirmer on what `world.run` already decided; a confirmer on creative or subjective output, which gets at most one read; the same suite run by the hunter, the confirmer and the gate, when the gate runs it once and the asks say so. `verified` names the commands that decided the result; `notCovered` is for what could not be checked, never for a check that exists and was skipped. Report each finding as it lands. Return the report shape. Publish the deliverable. |
| Anti-patterns | One row per mistake with the cost it produces, among them stacked verification mechanisms, a confirmer on a decided check, a stage that waits for the whole previous stage though it handles items one at a time, a join with no stated reason, and a wrong run left to finish or a stopped run left unamended. |
| After you submit | Diagnostics mean nothing ran, and they name the file the script was saved to: edit that file and resubmit with `path`, never by pasting the script again. Do not poll. The three terminal states and what each asks of the model. Amend any run with `AmendWorkflow` by editing the run's script file (the notification and `GetWorkflowRun` name it) and passing `path`; keep tunable constants out of ask text. Repair a run while it is still going with the same call: the amend stops it and starts the revision, and the earlier it happens the less is paid twice. |
| When a subagent escalates, or a hole is reached | Answer a question that has an answer with `ResolveWorkflowQuestion`; cancel and amend when the script is what is broken. A hole is answered in code: read the draft at the path the notification names, write the body's statements only, rehearse fixed logic in `EvalWorkflowSnippet`, call `FillWorkflowHole`, and on diagnostics edit the fill file it names and resubmit by `path` ("Holes"; `docs/dynamic-workflow/launch.md`). |

The "Write for the user" table pairs an English and a Chinese example on every row so the
rule reads as one principle rather than a ban list:

| Read by the user | Write | Not |
|---|---|---|
| Phase name | Check that the tests still pass / 确认测试仍然通过 | Gate: test verification / 执行测试验证任务 |
| Subagent name | Code reviewer / 代码评审员 | reviewer_2 / 节点3 |
| Hole name | Decide the split / 决定分组 | hole1 / 待定 |
| Subagent name | Independent reviewer / 独立评审员 | cold-reviewer / 冷眼评审 |
| `log` line | Reviewing 12 changed files / 正在检查 12 个改动的文件 | Fan-out sized: n=12 / 扇出阶段初始化完成 |
| Artifact title | Review report / 评审报告 | report-artifact-v1 / 产物输出 |

The report shape the skill hands the model to copy, which compiles as-is:

```ts
interface Finding {
  where: string;                          // "src/a.ts:42"
  what: string;                           // one sentence
  evidence: string;                       // the lines read, or the command and its output
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}
interface WorkflowReport {
  conclusion: string;                     // two or three sentences answering the request
  findings: Finding[];
  verified: string[];                     // what the run checked and how
  notCovered: string[];                   // what it did not look at, and why
}
```

The shape lives in the skill, not in the facade. The `CreateWorkflow` description carries
one rule ("return a report shape rather than a bare array; the skill carries the
interface"), and the completion notification tells the main agent to present the result in
that order (see "What the main agent is told when a run ends").

Three amend-resume rules the skill carries because the runtime cannot enforce them. First,
interpolating an upstream result into an ask is safe (it replays byte-identical), but
interpolating a script constant such as a threshold forfeits the cache of every ask that
mentions it the moment the constant is tuned; knobs live in control flow, prompts carry
replayed values and the fact of the branch taken. Second, an escalation is the cheapest
moment to amend a workflow: the ask that escalated never settled, so it sits exactly past
the cache boundary. Third, a script seen to be wrong is stopped and amended at once, not
left to finish: everything the predecessor finished is reused, whatever order the asks were
issued in, until the revision's first write to the workspace; an early stop saves only what
the predecessor had not yet started.

### Keeping the skill honest

A test in `bootstrap/tests/dynamic-workflow-skill.test.ts` pins the content:

- The built-in command declares `skills: [dynamic-workflows]`, an argument hint and an
  explicit `$ARGUMENTS` placeholder; it expands through the builtin resolver, and not when
  `dynamicWorkflowEnabled` is `false`.
- §16.2 embeds `FACADE_DTS` verbatim, once, between its markers, and `SKILL.md` stays under
  the `Skill` tool's 200 000-byte cap for this skill (`WORKFLOW_SKILL_MAX_BYTES`), which
  truncates from the tail, where §16 sits.
- Outside that marked block, no content file contains `declare `, `import` or `export`.
- The sentences that used to live in the tool descriptions are pinned in the skill: the
  three sources, the two run fields, the compiler and analyzer rules, the phase mechanics,
  the naming rule, the provider-error rule, `AmendWorkflow`'s `script_unchanged` and in-place
  retune, `SaveWorkflow`'s never-unsolicited rule, `EvalWorkflowSnippet`'s absent members.
- Every `artifact.*`, `files.*`, `git.*` and `world.*` member the skill mentions exists in
  `FACADE_DTS`; no `tools:`, `ToolProfile`, `"readonly"` or model tier (`"lite"`) appears.
- The other Workflow API's vocabulary (`pipeline(`, `parallel(`, `budget`, `agentType`,
  `isolation:`, `effort:`, `schema:`) is absent, and `phase(` appears only in the marker
  form `phase("literal")`.
- Every script block marked `<!-- compile -->` compiles through `compileWorkflowScript`
  and analyzes clean through `analyzeWorkflowScript`, and at least six such blocks exist.
  Unmarked blocks are fragments by contract; `patterns.md` is entirely unmarked and says
  so.
- The load-bearing sentences are pinned positively: the gate-adequacy paragraphs, the
  verify-before-report rule and the `unconfirmed` label, the artifact-delivery section,
  the "Write for the user" heading with its paired rows, and the routing that names
  `CreateWorkflow` and never says "the workflow tool".
- The bundled pack's required-path list and the skill files agree in both directions, and
  the gray gate's disabled path lands on the real `SKILL.md` under the resolved bundled
  root while a plugin skill root beside it is untouched.

`bootstrap/tests/bundled-skills.test.ts` covers the pack resolver itself: the real pack is
found in place, a staged pack missing a file is refused with a warning, a SEA pack is
extracted once by content hash and reused, and a corrupted SEA asset falls back to the
previous complete extraction.

The always-on tool descriptions carry only what a model must know before it decides to call:
`CreateWorkflow`'s routing (mandatory on an explicit request, never otherwise), its three
sources and the edit-then-`path` loop, the pointer to `AmendWorkflow`; `AmendWorkflow`'s
routing (fix, extend, repair a running run in one call, change settings without a script,
resume is another tool); `SaveWorkflow`'s never-unsolicited rule; and, on all four, "load the
`dynamic-workflows` skill first; the call is refused until it has been loaded". A model that
never loads the skill cannot submit a script, so the descriptions no longer echo the
authoring rules. `core/tests/workflow-routing-hints.test.ts` pins the routing signals and a
size budget per description; `core/tests/workflow-skill-gate.test.ts` and
`core/tests/loaded-skills.test.ts` pin the gate and its history probe.

## What a subagent is told

### The system prompt

A workflow subagent does not get the interactive agent's identity. The context builder
takes a third path when the runtime config carries `workflowActor` (mutually exclusive
with a custom system prompt; both present is a wiring error). The CLI prefix ("You are
ZCode, an interactive coding agent") is skipped, and the identity section is replaced by a
**Workflow Actor Identity** section, which is the first line of the system prompt:

1. An opening sentence: "You are a subagent inside a dynamic workflow run, named
   "<name>". A script created you and hands you work one ask at a time; the script, not a
   person, consumes what you return. There is no user in this conversation to talk to."
   The name clause appears only when the subagent has a name.
2. The author's persona, if any. It sits after the opening sentence so the role is
   prominent, and after it so the opening cannot be overridden.
3. The security notice and the `# Harness` block, reused verbatim from the interactive
   identity.
4. The workflow contract, `# Working inside a workflow`:
   - You have the regular working tools (reading, searching, editing, running commands)
     plus `submit_result` and `escalate`. There is no tool that asks a person anything.
   - Each ask states what to do. When the ask carries a result schema, finish by calling
     `submit_result` with a conforming value; otherwise your final message is the result.
   - Ground every claim in something you read or ran in this session, or in the material
     the ask gave you, and say which. Cite code as `path:line`. A check counts as passed
     only if you executed it here; if you could not run it, report it as not run. Run the
     check an ask names rather than a faster substitute, and say exactly which command you
     ran.
   - Report outcomes faithfully. If part of the task is impossible, out of scope, or
     contradicted by what you found, say so in the result instead of filling a field with
     a plausible guess. Never fake a passing result to satisfy an instruction.
   - When you are blocked by something outside your reach (a gate that cannot pass,
     instructions that contradict each other, a fact only the run's owner knows), call
     `escalate`. Questions written in prose reach nobody.
   - Do not write report or summary files on your own initiative; findings go in the
     result. When the ask names an output path, write exactly there and return that path
     in the result; the script publishes it to the user.

The desktop context, the dynamic-behaviour section and the session guidance are skipped
(they address a conversation with a user; the one rule worth keeping, "report outcomes
faithfully", moved into the contract). Memory, skills, user instructions and project
instructions follow as they do for any session. The child runtime strips any system prompt
inherited from the parent session so a parent with a custom prompt cannot leak it in.

The amend-resume cache matches subagents on the script-level persona, not on the composed
system prompt, so changes to the contract text never invalidate imported work. The persona's
`model` is left out of that match (see "Choosing a model per subagent").

### Each ask

The message a subagent receives for one ask is the script's instructions, then a quality
epilogue, then for a typed ask a schema epilogue. The journal's input hash covers the
instructions alone, so epilogue wording can change without invalidating a resumed run's
cache, and the GUI folds the epilogue into a collapsed disclosure using the boundary index
the driver passes along (`docs/dynamic-workflow/transcript-and-notifications.md`).

The quality epilogue, after a rule and the heading "Standard for this result":

- Every finding cites what you read or ran: path and line for code; the exact command and
  its output for a check; the part of the ask for material the ask itself gave you.
- A check counts as passed only if you ran it during this ask. Otherwise report it as not
  run.
- Run the check the ask names, at the scale it names. A narrower or faster substitute (one
  test file for the suite, a build for the tests) is reported as what it is, never as the
  ask's check; say the exact command you ran.
- Anything you could not do, verify, or find is stated as such, never filled with a
  plausible guess.
- When the schema's top-level properties include `evidence`: put each finding's citation
  in its `evidence` field. When they include `confidence`: rate it honestly; a low value
  with a reason beats a confident guess.
- If you are blocked by something outside your reach, call `escalate` instead of inventing
  a value.

The schema epilogue for a generic-profile subagent renders the JSON schema and says to call
`submit_result` with a conforming value; for a mono-typed subagent, whose schema is already
in the tool declaration, one sentence says to call the tool when done. The nudge sent when
a turn ends without a submission carries no epilogue. Profiles, nudges and repair rounds
are in the engine document.

## What the main agent is told when a run ends

The completion notification is XML (`<task-notification>` with status, result, error,
`<reports>` and `<artifacts>` sections) followed by prose that tells the main agent how to
present the outcome. The prose is appended only for dynamic-workflow runs; the legacy
`Workflow` tool's notification is unchanged. It comes last so that the notification's
total-length truncation removes guidance before artifacts and artifacts before reports.

For a completed run: present the outcome as a deliverable, in this order: the conclusion;
each finding with its evidence (path and line, or the command and output that showed it);
which findings were confirmed by a deterministic check or an independent subagent and
which are judged only; what the run did not cover. Reported items are individual findings
and keep their evidence. When the preview is partial, say so and read the rest with
`GetWorkflowRun`. Do not restate the phase graph or the script.

For a run that did not complete, the guidance depends on how it ended: present what it
salvaged first (the reported items), then the failure and what it means for the request,
then the next move. A run the user stopped is a decision, not an accident: do not resume
or rebuild it unless asked. A run the model stopped to fix the script is amended now with
`AmendWorkflow`; otherwise it is resumed only if the user wants. A run stopped by an exited
process or by a provider-side error names `ResumeWorkflowRun` or the cause to resolve
first; an errored script names the run's script file and points at `AmendWorkflow` with
`path` after editing it (`docs/dynamic-workflow/launch.md`, "Script files"). A run the model
amended away gets no notification of its own. The terminal states themselves are in the
engine document.

When the run published artifacts, one more sentence: artifacts listed above are already in
front of the user as cards; refer to them by title and do not paste their contents. The
`GetWorkflowRun` tool says the same of its `artifacts` section.

## Artifacts: what the user keeps

The word has two meanings in this codebase. In the engine, `artifact` is a site's typed
output value or the script's top-level return, the thing the model reads
(`RunSettlement.artifact`, `serializeWorkflowArtifact`). On the facade and every user
surface, an **artifact** (「产物」 in the Chinese UI) is what the script publishes for the
user to open: a file, a markdown document, or a dashboard fed by tagged `report` items.
This section is about the second. Engine identifiers keep the first meaning; new comments
next to both say which they mean.

Only the script publishes. Subagents have no artifact tool; a file a subagent writes does
not exist for the user until the script publishes it. The trust boundary is unchanged: the
user approves a script, and the script decides what is delivered.

### Two families

```ts
declare interface ArtifactRef { id: string; version: number }
declare interface ArtifactOptions { title?: string; description?: string; primary?: boolean }
declare interface ArtifactFileOptions extends ArtifactOptions { contentType?: string }
declare const artifact: {
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  chart(id: string, spec: ChartSpec): void;
  table(id: string, spec: TableSpec): void;
  metrics(id: string, spec: MetricsSpec): void;
  board(id: string, spec: BoardSpec): void;
};
```

| Family | Members | Nature | Failure channel |
|---|---|---|---|
| content | `file`, `markdown` | an effect: async, goes through the driver, copies bytes into the store, resolves to an `ArtifactRef` | rejects catchably; the node is recorded as failed |
| preset | `chart`, `table`, `metrics`, `board` | a declaration: synchronous, returns nothing, never touches a file; says how items tagged with its id are drawn | fails the whole run; a void return has no rejection channel |

The asymmetry is the design. A content publish can fail for reasons the script can act on
(the file is missing, the subagent wrote it somewhere else), so
`try { await artifact.file("book", "out/book.pdf") } catch { …ask a subagent to write
it… }` is the intended idiom. A preset is declared once at the top and fed by
`report(item, "<id>")`.

The `title` and `description` of a content publish belong to that version, so two versions of
one id can differ in both.

Every member is a site (`artifact#N`), registered in `dynamic-workflow/src/facade/registry.ts`
in a table separate from the world-read registry, because the two families lower to
different host calls (`publishArtifact` and `declareArtifact`) and neither is a read. The
sites draw no graph edges: a deliverable is not a step anyone waits for. Their arguments
are not taint sinks.

### Ids, tags and versions

An id is a compile-time string literal, non-empty, at most 64 characters of
`[A-Za-z0-9_.-]`, because it is carried verbatim through the journal column, the store's
call id, the protocol queries and the side-pane tab key. Within one run an id belongs to
exactly one member kind; using it with another is a compile diagnostic when both uses are
visible and an `ArtifactKindMismatch` at run time otherwise. Publishing a content id again
mints the next version, counted from 1, and keeps the old ones; a preset has one version.

A `report` tag is a compile-time literal naming a preset declared somewhere in the script.
The declaration may appear later in the text, but it must have executed by the time the
tagged report runs, or the run fails with `ArtifactUndeclared`. A tag naming a content
artifact is a diagnostic: a file holds content, not a stream of items. A tagged report
still counts against the report caps and still goes to the run's results; the tag adds the
dashboard, it does not replace anything.

**The primary.** `primary: true` marks the run's deliverable, the one artifact the user is
meant to open first. At most one id per run carries it. The flag is a property of the id,
not of a version: once an id is primary, every later version of it is primary too, whether
or not the publish repeats the option, so a report published as a draft and again as the
final does not lose its place. Marking a second, different id is `ArtifactPrimaryConflict`:
a catchable rejection recorded as a failed node for `file` and `markdown`, a run failure
for a preset, the same channels as `ArtifactKindMismatch`. When both literals are visible
the compiler says so first (9009). Two publishes that pass admission before either settles
are re-checked at settle, and the loser takes the failure path, so the journal never holds
two completed primaries. A failed primary publish promotes nothing in its place. Presets
may be primary: a benchmark board can be what the user asked for. Re-declaring a preset
with the flag added or removed changes its canonical spec and is `ArtifactRedeclared`.

Caps, in `dynamic-workflow/src/facade/artifact-caps.ts`:

| Cap | Value |
|---|---|
| ids per run | 32 |
| versions per id | 16 |
| `artifact.file` bytes | 20 MiB |
| `artifact.markdown` bytes | 256 KB |
| title | 120 characters |
| description | 500 characters |
| preset spec, canonical JSON | 8 KB |

### Publishing content

`artifact.file(id, path, opts)` takes a workspace-relative path resolved by the same
resolver `files.read` uses, then checked again after resolving symbolic links, so a link
out of the workspace cannot turn a private file into a card. The bytes are read with a
cap-plus-one probe and copied into the CLI's tool-artifact store at publish time under the
run's parent session, with project retention (so the hub can show them across sessions)
and a call id of `<runId>:<siteId>@<ordinal>`. Later edits or deletions in the workspace
change no version. The workspace path is kept on the record as provenance only.

The content type comes from the extension (`pdf html htm md markdown txt csv json png jpg
jpeg gif webp svg xlsx pptx docx`), or from `opts.contentType`, which must be a bare MIME
type without parameters because the viewer dispatches on the exact string. Anything else
is `application/octet-stream`, which the UI shows as a metadata card rather than
rendering. There is no content sniffing. `artifact.markdown` is always `text/markdown`.

`opts.title` and `opts.description` are checked for type and length and rejected over the
cap rather than truncated: a title cut mid-sentence looks like a normal card with nothing
to say it was cut. `opts.primary` must be a boolean; the engine reads it before dispatch
(the driver passes unknown option keys through untouched) and stamps the flag onto the
record it stores, so the record's `primary` is the engine's verdict, not the caller's
argument.

What can reject a content publish, all catchable and all recorded as a failed node:

| Code | Raised by | When |
|---|---|---|
| `ArtifactSourceMissing` | driver | the path does not exist or is not a regular file |
| `ArtifactPathOutsideWorkspace` | driver | the resolved path leaves the workspace |
| `ArtifactTooLarge` | driver | over the file, markdown, title or description cap |
| `ArtifactStoreUnavailable` | driver or engine | the host has no artifact store, no binary write, or no session scope |
| `ArtifactVersionCapExceeded` | engine | the id already has 16 versions |
| `ArtifactKindMismatch` | engine | the id was published under another kind |
| `ArtifactCapExceeded` | engine | a 33rd id |
| `ArtifactPrimaryConflict` | engine | `primary: true` on an id while another id is already primary |
| `DriverError` | either | a malformed argument (including a non-boolean `primary`), or the store write itself failed |

A missing store is a named failure the script sees, never a silent fallback to writing the
workspace or publishing an empty artifact.

### Declaring a dashboard

```ts
declare interface ArtifactField { field: string; label?: string; unit?: string }
declare interface ChartSpec extends ArtifactOptions {
  type?: "line" | "bar" | "scatter";   // default "line"
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];   // several = several series
  scale?: "linear" | "log";
  baseline?: ArtifactField;             // a horizontal rule from the first item that has it
}
declare interface TableSpec extends ArtifactOptions { columns: ArtifactField[]; key?: string }
declare interface MetricsSpec extends ArtifactOptions { metrics: ArtifactField[] }
declare interface BoardSpec extends ArtifactOptions {
  key: string; status: string; columns: string[]; cardTitle?: string; detail?: ArtifactField[];
}
```

A field is a dot path into a reported item (`"timing.after"`). A chart draws one point per
tagged item. A table draws one row per item, or replaces the row with the same `key` when
one is set. A metrics row shows, per tile, the newest item that has the field. A board
places each item as a card in the column its `status` names, moving the card when a later
item has the same `key`; a status not in `columns` lands in a trailing "other" column.
`cardTitle` names the field used as the card's title, distinct from the board's own
`title`.

The engine validates the spec shape before writing anything (a malformed spec would break
every reader that later loads it from the journal) and fails the run with
`ArtifactSpecInvalid`, whose message says what is wrong. Declaring an id again with an
identical spec is a no-op; with a different spec it is `ArtifactRedeclared`. A preset
declared under an id already used by another kind is `ArtifactKindMismatch`; a 33rd id is
`ArtifactCapExceeded`; `primary: true` while another id is primary is
`ArtifactPrimaryConflict`. All five fail the run.

A dashboard holds no data of its own. Every point, row, tile and card is one journal row
of kind `report` whose `artifact_id` matches, and every surface (the side pane, the
full-size tab, a cold reload) folds the same rows through the same pure function into the
same picture. A dashboard reads only the fields its spec names, so the renderer asks the CLI
for those fields and never for whole items: an item can be up to 1 MiB, and a chart needs
one number from it (the engine document, "Reading the journal").

### Journal rows and events

Each publish or declaration is one journal row of kind `artifact`, keyed by site and
ordinal, with the id in an `artifact_id` column. The row's result is an
`ArtifactVersionRecord`:

```ts
interface ArtifactVersionRecord {
  id: string;
  kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
  version: number;
  title?: string; description?: string;
  contentType?: string; bytes?: number; uri?: string;   // content only
  sourcePath?: string;                                   // file only
  spec?: unknown;                                        // preset only
  publishedAt?: number;
  primary?: true;                                        // stamped by the engine; sticky per id
}
```

`primary` rides inside the row's result, so it needed no migration; on resume the engine
rebuilds which id is primary from the completed rows alone.

Bytes never enter the journal; `uri` points into the store. A successful publish and a
declaration each emit `artifact-published` with the record; a failed content publish emits
`artifact-failed` with the id, the member and the structured error. Neither family emits
node lifecycle events (queued, dispatched, settled): an artifact site is in no graph, and a
settle event on it would surface as an unexplained node in the run pane. A replayed hit
emits nothing. The version number is derived from the count of completed rows for the id,
so it survives resume, and only completed rows claim an id, so a failed publish does not
spend one of the 32. A failed row replays as the same rejection. A tagged report row
carries the tag in `artifact_id` and its event carries `artifactId`; the tag is not part of
the report's input hash.

The engine side (ordering, journal port, protocol queries, store retention) is in the
engine document.

### How the user sees them

In brief, because the rendering belongs to `docs/dynamic-workflow/presentation.md` and
`docs/dynamic-workflow/transcript-and-notifications.md`:

- **The completion card** leads with the primary as a **row**: the preview frame at a
  tile's size beside the title, the description and a `kind · size` line; the other
  artifacts follow as an **index**, one line each (kind icon, title, size or count), at
  most six, the rest folded into a "N more" line that opens the run pane. A run with
  exactly one artifact gets the row without the flag. With no primary the card shows the
  index alone: no artifact earned a preview.
- **The run pane** has an artifacts section below the graph, present only when the run
  published something, rendered for failed and stopped runs too. With a primary it is the
  same row, then the rest as a one-column index with no cap; without one, each artifact
  is a tile with a preview (the dashboard live, a document thumbnail, the first rows of a
  CSV, an image, a PDF glyph) and a caption, in a grid that adapts to the pane width. The
  collapsed section header keeps the primary's title beside the count.
- **A full-size tab** (`workflow-artifact`) opens from a tile, a chip or a hub row. Its
  header shows the title, the kind and a version stepper; its body dispatches on content
  type: markdown, PDF, images, text and code, the office formats through the existing
  viewers, presets at full size. HTML gets a metadata card whose action is "open in
  browser", the fallback surface for the rule below; unknown types get a metadata card
  with "show in workspace".
- **"Open as file"** sits in the tab header of every content artifact (`file` and
  `markdown`; presets have no bytes). It is a split button: the main action opens the
  version on screen in the system's default app, the chevron lists the installed apps
  (the same list and remembered choice as the other "open with" menus, file managers
  first), then the location actions: "show in workspace" when the artifact has a workspace
  source the tab can reach, and "copy path". The header therefore carries one file control,
  not two; where the split button is absent, "show in workspace" stands in the header on
  its own. The file is a **copy the desktop writes** from the bytes the tab
  already read, at `~/.zcode/tmp/workflow-artifacts/<runId>-<digest>/<artifactId>-<digest>/v<N>/<name>`;
  the name is the base name of `sourcePath` for `file` (its extension picks the app) and
  `<artifactId>.md` for `markdown`. Each `<digest>` is the first 8 hex digits of the SHA-256 of
  the id before it, as the CLI sent it. It keeps two ids the engine tells apart in two directories
  when the readable part alone would merge them: file systems that ignore case (the macOS
  and Windows defaults) merge `Report` and `report`, and the sanitising that drops a leading
  dot merges `.notes` and `notes`. It is not the store's file, for three reasons: the
  store lives with the CLI, which for an SSH, WSL or Docker workspace is another machine;
  an editor writing to the store's file would change a published version under its
  journal record; and the protocol would have to hand host paths to the renderer. A copy
  is written only when its path is empty. A version's bytes never change, so an existing
  copy is either the same bytes or the user's own edits, and both are kept; opening again
  opens the same file. The action exists where the shell can write that copy (the desktop,
  local and remote workspaces alike) and is absent on the phone remote-control and web
  shells. The copies sit under `tmp`, which Settings' storage page lists with the other
  tool outputs and the user can clear; a cleared copy is written again on the next open.
- **An HTML artifact opens in the embedded browser tab directly**, from every surface that
  opens an artifact, without passing through the full-size tab. Three things must hold: the
  workspace is local (no workspace identity, no remote session), the shell has the embedded
  browser (desktop, not the phone remote-control web shell), and the artifact has a
  workspace source path. HTML here means a `contentType` of exactly `text/html`, the same
  test that decides whether the tab draws its HTML card, so the two never disagree about
  what is a page; a summary that carries no content type is not HTML and opens the tab.
  The URL is the `file://` URL of the workspace copy, the workspace path joined with the
  record's relative source path, the latest version's original file, exactly what "open in
  browser" opened from the tab. Clicking the same artifact again focuses the browser tab
  already on that URL in that workspace and reloads it, so a republished version shows
  fresh content instead of opening a second tab. The caveat the tab's card states holds
  here too: that file is the workspace's current bytes, not the bytes pinned for a version,
  which is why only the latest version is reachable this way.
- **The routing decision lives in one place**, the app panel open handler
  (`useAppPanels.handleOpenWorkflowArtifact`). A surface passes what its own summary knows,
  the `contentType`, and the `sourcePath` where it holds the merged journal view; the
  handler asks the run's artifact journal (`workflowRunArtifacts`) for a source path it was
  not given. When that query fails (an old CLI without it, a transient error) or the record
  carries no source path, the click opens the full-size tab instead. No click is ever dead.
- **The completion notification row** ends in up to three small artifact pills plus a
  "+N" overflow, each opening its artifact under the same rule.
- **The workflows hub** shows the same pills on run-history rows and a "latest artifacts"
  strip on a saved workflow's detail page, taken from its most recent completed run.

Every list is ordered **primary first, then publish order**. The order is fixed where the
lists are built, in the journal projection (`artifactsOf`) and in the notification's
manifest, before any cap is applied, so the primary is never the artifact a cap cuts. No
surface labels the primary; the row's form says it.

Where a click on an HTML artifact lands, from any of those surfaces:

| The click | Where it lands |
|---|---|
| local workspace, a shell with the browser, a source path in hand or in the journal | the browser tab, on the workspace file's `file://` URL |
| the same artifact clicked again | that same browser tab, focused and reloaded, never a second tab |
| a remote workspace or a remote session | the full-size tab, whose HTML card shows the local-only note |
| the phone remote-control shell | the full-size tab; that shell has no browser |
| the journal query fails, or the record has no source path | the full-size tab |
| the summary carries no `contentType` (an old CLI that emitted none) | the full-size tab |

On the model side, the completion notification's `<artifacts count shown>` section lists
one line per artifact, `- {id} ({kind}, primary, v{version}, {contentType}, {bytes} bytes):
{title}` (`primary` appears only on the primary; presets show `{n} items` instead of bytes),
at most eight lines after the `<reports>` section; `GetWorkflowRun` lists up to 32 the same
way. Neither gives the model a URI: the model cannot read the store, and content is reached
through `GetWorkflowRun` or by a subagent reading the workspace path.

### The guidance

The skill's "Deliver artifacts" section carries two habits; the facade comment on
`artifact` states only the id rules, the two families and the caps. Every run publishes its deliverable: a thing the user asked for (a
page, a PDF, a site) is written by a subagent into the workspace and published with
`file`; an answer (findings, a review) is published as markdown, the long form of the facts
the return summarises, once at the end, skipped only when the whole answer is one line. A
dashboard is for the person watching the run: declare one when there is state worth
watching mid-run, none when the run is over before anyone looks. Two tests keep the set
small: would the user open it on its own, and does it repeat another artifact. A run that
publishes more than one artifact marks its deliverable `primary: true`, so the card and the
run pane lead with it instead of with whatever was published first. The `return` stays the
model-facing result and artifacts the user-facing deliverable; the same content never goes
in both.

## EvalWorkflowSnippet

`EvalWorkflowSnippet` is the test bench for authoring. It compiles and runs a small
TypeScript snippet synchronously against the same compiler, lowering, sandbox and
world-read execution path a real run uses, and returns the result in the tool call. It
exists because testing fixed logic (a parser, a glob pattern, a gate predicate) in plain
Node has the wrong fidelity: `files.glob` returns workspace-relative sorted paths, caps
reject, `GrepMatch` has a shape, and the compiler options are the run's. A snippet that
passes pastes into a workflow verbatim.

| Input | Meaning |
|---|---|
| `code` | the snippet, written against the snippet facade |
| `path` | or: a file holding the snippet, read whole (relative to the working directory or absolute); exactly one of `code` and `path`, with separate refusals for both and for neither (`docs/dynamic-workflow/launch.md`, "The `CreateWorkflow` tool", "Input and output") |
| `timeoutMs` | wall clock for the whole snippet; default 60 000, accepted between 1 000 and 600 000 |

After resolution the input also carries `script`, always equal to the resolved `code`. The
model's schema does not list it, and a value the model supplies is overwritten. It is there
so that hooks and permission rules read the snippet under the same field name as the
script of `CreateWorkflow`, `AmendWorkflow` and `FillWorkflowHole`; a PreToolUse hook that
reads only `tool_input.script` would otherwise see nothing on a snippet and let it through.
`code` stays for the tool row and for hooks that already read it.

The snippet facade is the args, run, log, world and world-run segments. `agent()`, `report()`,
`artifact.*` and `phase()` are absent, so a snippet that uses one fails to compile with an
ordinary "cannot find name" diagnostic; asks cannot be rehearsed, only the pieces can. The
tool's description says what it is for and points at the skill; the facade subset and the
snippet rules are the skill's §16.6, and the call is refused until the skill has been loaded
in the session (see "The skill gate"). The
pipeline is the production one: one TypeScript program feeds diagnostics, the site table
and lowering; `world.run` commands are collected and a non-literal command is the same
diagnostic 9003; the lowered code runs in the sandbox harness with an in-memory journal, a
random run id, the production `executeWorldRead` (real file system, real git, production
caps) and a driver whose ask methods throw, as defence against a wiring error that could
never reach them.

Nothing persists: no journal rows, no background task, no entry in the run list. The
result is `{ok, diagnostics, logs, response, durationMs}`. With diagnostics, `ok` is false,
nothing ran, and the response says so. On success the response carries the returned value
serialized the way a completion notification serializes a result, and the `log()` lines in
order (at most 100, each at most 2 048 characters, truncation marked). A returned value
over 256KB is a failure (`ArtifactTooLarge`) with a message to return a summary. A script
error, a cap rejection, a timeout that killed the sandbox, or a cancellation all come back
as `ok: false` with the structured code and message.

Permission is ordinary, like `Bash`: modes, rules and "always allow" apply. The tool's
approval hook compiles the snippet and asks for confirmation only when it contains
`world.run` commands; a read-only snippet, and a snippet that does not compile, proceed
silently. The user reads the commands off the snippet's code, which the literal rule makes
possible. The tool is marked not read-only with workspace side-effect scope.

The tool card in the chat: while running, "Running workflow snippet · N s" with the code
expandable; when done, "Workflow snippet · N ms" with the return value expandable; on
failure, the generic failure summary with the error expanded, or the compiler feedback card
(`docs/dynamic-workflow/presentation.md`, "Compiler feedback") when the snippet did not
compile. Empty logs, empty return values and status words are never repeated. The card never repeats the diagnostics as text, whichever source the snippet came from.

## Usage, not budget

There is no budget construct. The harness enforces no token budget and no node cap, the
facade has no `budget` global, and no error code fails a run for usage. The reasons: no
production caller ever set a token budget, so the check was unreachable; the node cap was
a fence a normal large fan-out ran into; and cost control belongs to the harness and the
person, not to script code optimising against a limit. Cancellation and the run
confirmation are the controls.

Usage is still accounted, as an observation surface. The driver reports each turn's token
usage, the engine sums it into the run's `spentTokens`, writes it to the journal in the
same step it emits `usage-updated { spentTokens }`, and the two are always equal. The
protocol's run snapshot carries `usage { spentTokens, nodesUsed }`, `nodesUsed` counted
from first dispatch of each node. The run pane shows one line, 「用量：N tokens · M 步」
("Usage: N tokens · M steps"); the TUI card shows the tokens; `GetWorkflowRun` reports
`usage` with token and node counts and no limit fields. Because nothing stops a loop for
the script, a discovery loop bounds itself with a round constant in the script.

The figure is the cost of the run's lineage. An amended run (`AmendWorkflow`,
`docs/dynamic-workflow/launch.md`) starts its count at the predecessor's total rather than at
zero, and a chain of amendments sums by construction because each predecessor's figure is
already cumulative; a cache hit adds nothing, since its cost is inside the inherited total. A
resumed run continues its own count. In both cases the engine re-emits the carried total right
after `run-started`, so a card never shows zero for a run that has already cost something.
The predecessor keeps its own figure; it is the successor that reports the whole
(`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`, "Usage across the lineage").

## Alternatives not taken

- **A `budget` facade, a token budget and a node cap.** Never set in production, one more
  facade global with lowering and analyzer special cases, and the wrong layer for cost
  control.
- **A tool profile (`"none"`, `"readonly"`) or a model tier (`"lite"`) on the persona.**
  The tier had no lightweight model source on the host and resolved to the main model.
  Choosing a model moved to the run, as the `subagent_model` field of the launch tools
  (`docs/dynamic-workflow/launch.md`), where it is one decision the user can see and approve.
  A per-subagent model came back once the host had a model catalog, as a concrete model name
  rather than a tier ("Choosing a model per subagent"): the catalog is the host source the
  tier lacked, and resolving every name before the window keeps the choice visible and
  approvable. Named tiers (`"fast"`, `"strong"`) are still not offered; they would need a
  mapping the host does not have, which is what retired `"lite"`. The
  profiles enforced one sentence ("cannot edit or run") that every other subagent in the
  product carries as ask text, cost facade prose, contract branching and skill sections,
  and the tool-less profile produced placeholder escalations from subagents told to read
  what they could not. A script that still writes `tools:` gets TypeScript's own
  excess-property error, and one that writes `model: "lite"` gets 9011 (no such model);
  there is no compatibility shim and no custom hint.
- **A system-prompt section for workflow guidance.** Routing signals live in tool
  descriptions and the skill; the always-on prompt gains no workflow mention.
- **The skill restating the facade, or `.ts` example files.** A second copy drifts, and a
  `.ts` file invites `import`/`export` imitation.
- **A compile heuristic for which skill blocks are complete.** The `<!-- compile -->`
  marker is explicit; a heuristic would eventually pass a real error as a fragment.
- **`alwaysAsk` on the snippet tool.** That posture belongs to `CreateWorkflow`, whose
  submission is load-bearing and expensive; a snippet is cheap and ephemeral.
- **A shell string, a `cwd` or `env` option, or a computed command on `world.run`.** The
  confirmation window can show only a fixed command set.
- **Nonzero exit as an exception.** A failing check is the gating loop's normal path.
- **Gating logic in an external check file.** A file in the workspace is in the subagents'
  writable domain; logic inside the submitted script is not.
- **Truncating over-cap output** anywhere. A silently partial view is the failure the caps
  exist to prevent.
- **Subagents publishing artifacts directly.** The user approved the script, not the
  subagent.
- **Model-authored HTML dashboards, or an inline iframe for HTML artifacts.** The renderer
  has no sandbox to host script-bearing HTML, and the sandbox the product already owns is
  the browser tab's `<webview>`, which is where an HTML artifact opens instead; presets
  cover the watched-number and watched-status cases.
- **A `where` filter on `report` or a third argument.** One tag, one stream.
- **Content sniffing for artifact types.** A second judge disagrees with the first.
- **A separate artifacts table.** Versions are journal rows; a second table is a second
  truth.
- **Reusing `node-settled` for a failed publish.** The site is in no graph, so the run pane
  would show an unexplained node.
- **Putting the report tag in the report's input hash.** Every untagged report in an
  existing journal would mismatch on resume for no gain.
- **`WorkflowReport` in the facade.** Recognising the shape means schema synthesis and
  engine recognition; the skill's copyable interface buys the shape without the machinery.

- **A bounded channel, or an async `send`.** Backpressure has one scarce resource to protect
  and the concurrency cap already protects it; a full buffer would be one more thing a script
  can deadlock on.
- **Ending a channel by quiescence** (a receiver completes when nothing in the run could
  send). Deterministic and free of `close`, but a channel's end would depend on the whole
  run's state rather than on its producers, and a stage could never observe its own
  completion. Quiescence is kept as the stall detector, which is the same condition read as
  an error.
- **A `pool` or `stage` helper in the facade.** The helper existed to own the close protocol;
  a `finally` in a future body owns it just as well, and a fluent `.pipe()` chain cannot
  carry one phase marker per stage.
- **A scoped `phase(name, body)` form.** One call shorter than a marker inside a future, but
  it gives `phase` two forms and disturbs the standalone-statement rule.
- **A `channel` site and a relay node in the graphs.** The graph node kinds are a closed
  vocabulary that clients validate strictly; the container view gives the right edges today,
  and a node can be added when a picture needs it.
- **Broadcast channels.** A stage that must feed two consumers sends to two channels; each
  item having one receiver is what makes a pool a pool.

## Open questions

- Collapsing `AgentPersona` to a bare system-prompt string; the object form now has one
  field.
- A host-wide default subagent model chosen by the user. The per-run `subagent_model` on
  the launch tools covers picking one for a run; a setting that applies to every run does not
  exist.
- `WorkflowReport` as a facade type with native rendering of conclusion and findings.
- Listing `declaredArtifacts` in the run confirmation window; the compile product carries
  them, the permission display schema does not yet.
- A "save to workspace" action that writes a version's bytes to a path the user picks.
  "Open as file" covers opening a version in another app, including the types with no
  renderer; putting a copy in the workspace (to commit or keep editing it there) is not
  covered.
- Cascading deletion of store bytes when a run is deleted; retention today is the store's
  project policy.
- Whether the report caps are enough for a dashboard-heavy run, or tagged reports need
  their own quota.
- A `select` over several channels, and a `receive()` that yields one item outside a loop.
- Drawing a channel as a relay node once the graph vocabulary can grow.
