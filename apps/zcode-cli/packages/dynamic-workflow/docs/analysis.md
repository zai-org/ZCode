# Dynamic Workflow: The Analyzer (spec)

Status: implemented. This document describes the static analysis in
`@zcode/dynamic-workflow` as built; its sibling `execution-engine.md` covers what happens
after a script is accepted.

## What the analyzer does

The model writes a workflow script in TypeScript against a small facade: `agent()`,
`.ask()`, `files.*`, `git.*`, `world.run`, `report`, `artifact.*`, `phase()`, `log`. Before
the script runs, the analyzer reads it once and answers four questions about it:

| Question | Answer | Module |
|---|---|---|
| What depends on what? | the **site graph** | `analysis/graph.ts` |
| What runs after what, and why? | the **causality graph** | `analysis/causality-graph.ts` |
| Where can execution go next? | the **control-flow graph** | `analysis/flow-graph.ts` |
| In each phase, who takes part and who hands work to whom? | the **hand-off graph** | `analysis/handoff-graph.ts` |

All four are pure functions of one artifact, the **analysis core**, which one
interpretation of the script produces. The core holds the data-dependency facts, the
temporal trace, the site table, and the artifact types. Once it exists the script is never
consulted again. The projections do not import `typescript`, so a browser can redraw the
graphs from a frozen core.

The pipeline, in `analysis/analyze.ts`:

1. Compile the script and typecheck it. Any TypeScript error stops here.
2. Collect the **site table**: every facade call, with its id.
3. Run the authoring checks. A failed check stops the submission, and all but one also
   withhold the graphs (see "Diagnostics").
4. **Interpret** the script: the taint fixpoint, then one temporal walk. Mint the core.
5. Project the four graphs.

The result carries `diagnostics`, `ok`, `core`, `graph`, `causality`, `flow`, `handoff`,
`declaredArtifacts`, and `modelReferences`: every model name the script can hand a subagent,
one entry per occurrence with its position, which the launch tools resolve against the host's
model catalog (`docs/dynamic-workflow/launch.md`, "Models the script names").

The GUI draws none of these graphs directly. A bounding layer in `packages/core` folds the
causality, control-flow, and hand-off graphs into the display payload the confirmation
window and run pane consume. That contract belongs to the GUI documents; the one thing the
analyzer exports for it is `reduceOrdering`, which the bounding layer reuses for an untyped
reduction of the phase edges. The text forms and mermaid emitters are for tests, debugging,
and the `pnpm charts` viewer.

## Sites

A **site** is one facade call in the script. Sites are the unit of identity for everything
downstream: the journal keys rows by site and execution count, replay matches on site ids,
the GUI joins runtime instances to the static picture by site id. Names on `agent()` are
display labels, not identity.

Site ids are per-kind, in source order: `ask#1`, `actor#2`, `world-read#3`, `join#1`,
`report#1`, `artifact#1`. A separate global `order` counter records the discovery sequence
across kinds; it is only a merge key for serialization. `fan-out#N` ids are assigned to
promoted iteration candidates in source order when the core is minted.

Which calls are sites, and what each one is in the graphs:

| Call | Site | Graph node | Reason |
|---|---|---|---|
| `x.ask(...)` | `ask#N` | yes | the step other steps wait for |
| `agent(...)` | `actor#N` | lane, not node | who performs a step |
| `files.*`, `git.*`, `world.run` | `world-read#N` | yes | a journaled read of the world |
| `Promise.all`, `Promise.allSettled` | `join#N` | relay node | values flow through it |
| a promoted iteration | `fan-out#N` | relay node | values flow through it |
| `report(...)` | `report#N` | no | emits progress; nothing can wait for it |
| `artifact.*(...)` | `artifact#N` | no | a deliverable, not a step |
| `phase("...")` | none | none | a marker; lowering rewrites it to `__host.enterPhase` |
| `log(...)` | none | none | no identity at all |
| `channel(...)`, `future(...)` | none | none | sandbox-local promise machinery; a channel is a container the analysis sees through (below) |

`report` and `artifact` need ids for lowering and journal dedupe, but their arguments are
not taint sinks and they draw no edges. `phase` consumes no counter at all, so adding a
marker moves no id and no serialization line.

World-read membership is resolved from a registry keyed by declaring container and member
(`facade/registry.ts`), never by name. `git.log` and the top-level `log()` share a name and
are different things.

**Site-id stability.** `collectSites` is the only place ids are minted. New collected
constructs must not touch the global `order` counter or any per-kind counter. Break this
and lowering emits ids the journal never recorded; the symptom is a hash mismatch at
resume, far from its cause.

**Hole sites.** `hole<T>(name, prompt?, body?)` is a site of its own kind
(`docs/dynamic-workflow/authoring.md`, "Holes"), but not on a positional counter: **a hole's
id is the key of its name**, `hole#` followed by the eight hex digits of the 32-bit FNV-1a
hash of the trimmed name, taken over its code points (`analysis/hole-id.ts`). Names are unique
across the effective script by rule 9012, so the key is unambiguous, and it is the same
whether the hole sits at the top of the script or ten fills deep. Two different names that
happen to hash alike are a 9012 diagnostic on the later one, never a guess. A hole whose
name is not a literal is already a 9012 and falls back to a positional `hole#N` only so the
diagnostic has a site; such a script never runs.

Its body, when present, is walked as an entered, once, not-deferred callback exactly as
`future`'s is, since the cell provably calls it at the site, with one addition that is the
whole reason a hole can be filled while its run is alive: **the walk opens a fresh set of
per-kind counters when it enters the body and prefixes every id minted inside with the
hole's own id**: `hole#21b40fca/ask#1`, `hole#21b40fca/actor#2`. The prefix is one level
deep: a hole inside the body gets its own name key, not the outer id plus its own, and the
sites in *its* body carry *its* prefix. Nesting is recorded on the site table instead, as
the hole's `fill` (the filled hole whose body holds it; absent at the top level). The outer
counters never see the body.

Why a name key and not a counter or a path. Any id computed from position shifts when a fill
inserts code before a later hole, and the journal keys every node by site id. A path of
enclosing ids, which the first version used (`hole#1/hole#1/ask#1`), is stable but grows
seven characters per level, and the protocol bounds ids at 64 characters: a tail chain
stalled after eight or nine steps. The name is the one fact that is both stable under
insertion and independent of depth. Filling a hole, which textually inserts code in the
middle of the script, therefore changes no existing `ask#N` / `actor#N` / `world-read#N` /
`report#N` / `artifact#N`: the journal keys of a live run, its ask specs, its site-phase
table and the GUI's join all survive the fill. This is the site-id stability rule extended
from "adding a marker" to "adding a body". Only the global `order` sequence shifts, because
the body's sites are discovered between their neighbours, and `order` is a merge key for
text output and nothing else. The fill service re-checks the rule on the compiled effective
script instead of trusting it (the engine document, "Holes"): every old id must survive at
its shifted place, and every new id must have been written by this fill, meaning it carries
the filled hole's prefix or is a hole whose `fill` chain leads to the filled hole, or sits
in such a hole's body.

An open hole is a step in every graph: the prompt flows into it (a sink, as an ask's
instructions are), its result is a value of type `T` from outside the run, and its lane is
the main agent's, since that is its participant. A filled hole is not a step, but it is still a
**phase**, id the hole's site id, named by the hole: it claims the body's sites up to the
body's first `phase()` marker, and the body's markers are phases of their own, standing
after it. The hole's phase has a mark node of its own, as an open hole's does, so it stays in
the control-flow phase table and in `phaseNames` even when it claims nothing (a body that
opens with a marker): that is how every step of a tail chain keeps its name in the sidebar.
Every phase and step a fill wrote carries `fill: <the filled hole's id>` so the display can
tell what a fill wrote; a hole's **own** phase, open or filled, carries the hole that
encloses it (none at the top level), which is where the display reads nesting from. An open hole is a phase too, with no members yet, so the rail can draw its station
ahead of the run. A body's own `return` is not a top-level return: it returns from the hole.

### Labels and names

An ask's label is the receiver's literal name when the receiver is an inline
`agent("name")`, the identifier when the receiver is a variable, and `"ask"` otherwise. An
actor's name is the literal first argument, else the variable it initializes, else absent.

A name computed at runtime still has a static shape. `` agent(`researcher-${i}`) `` yields
no name but a **name pattern**: the literal text before the first hole (`head`) and after
the last (`tail`). Literal text between holes is dropped. An affix is trimmed and must
contain a letter or digit, or it is discarded; `` `${x}-` `` would render as `…-`, which is
worse than an anonymous lane. The pattern is a separate field from `name`, so `name` is
always the author's own word and never a reconstruction. The ellipsis is added when the
GUI renders, not here. The same rule gives an ask its `labelPattern` when its label fell
back to `"ask"`.

### Iteration candidates

Two shapes register as candidates for a fan-out: a `for...of` statement, and any call the
callback registry marks `each` (see "The callback registry"), whether its callback is an
inline literal or any expression that holds a script function. A candidate becomes a
`fan-out` node only if its body reaches a facade site, directly or through the functions it
calls. A candidate that never promotes is a node in nothing.

An indexed `for` over `collection.length` is not a candidate. It is a loop, which the
temporal walk handles like every other loop statement.

A site that sits inside a promoted candidate's body, or inside a function that body calls,
directly or through further calls, carries `within`: the id of the nearest enclosing
fan-out. It means the site runs once per element. An actor site with `within` is a lane
family, one fresh actor per element; an actor created outside the fan-out but asked inside
it stays a single lane and is the serialization bottleneck the picture should show.
`within` is a may-fact: a helper called both inside and outside a fan-out still carries it.
It is read off the temporal walk: each time the walk reaches a site's call it notes the
innermost promoted candidate among the regions it stands in, and the site takes the first
such fan-out in source order. A helper's call site inlines only the callbacks that call
passed (see "Inlining"), so a step inside a callback belongs to the fan-out that passed
the callback, never to another fan-out that calls the same helper. A site the walk never
reaches, dead code, has no `within`.

## Diagnostics

The analyzer adds its own codes to the TypeScript ones. Each one names something the
script must fix before it can be submitted, because the thing it asks for cannot be
recovered later.

| Code | Rule | Why |
|---|---|---|
| 9001 | A facade callable may appear only as the callee of a direct call. | Sites are identity. `const f = planner.ask`, `const { read } = files`, `.bind`, passing `agent` as an argument: a call reached through an escaped function value has no site. |
| 9001 | A value carrying a site-producing facade member may not be converted to a type that lacks it. | `planner as Askable` makes `.ask` resolve to the local interface, and the real call runs unsited. Checked at `as`, `satisfies`, argument to parameter, return, annotated binding, and assignment. |
| 9002 | An `ask<T>` type must be expressible as a JSON schema. | `schema/` |
| 9003 | `world.run`'s command is a string literal. | The confirmation window shows the command set; a runtime-built command has nothing to show. |
| 9004 | `phase()`'s name is a non-empty string literal, and the call is its own statement. | The name labels the confirmation graph; a marker in expression position has no rest-of-block to claim. |
| 9005 | Two `agent()` sites may not share a literal name. | The name is the identity key an amended re-run matches its cache against. |
| 9006 | An `agent("x")` inside a fan-out body has a fixed name for every element. | The run would fail with `DuplicateActorName` on the second element. |
| artifact codes | Artifact ids are literals, tags name a declared preset, an id belongs to one family. | see `docs/dynamic-workflow/authoring.md`, "Compile-time rules" |
| 9012 | A `hole<T>()` names its type argument explicitly; its name is a non-empty literal of at most 128 characters, unique among the script's holes and phase markers, nested fills included; the call is awaited; it stands outside every array-method fan-out callback (a `for...of` body is sequential and allowed); and its body, when present, is an inline function literal that references no binding declared after the hole. | The type is the contract a fill is checked against, and an inferred `unknown` is no contract. The name is the hole's phase name and the identity every surface shows, so it must be one hole's alone; two markers with one name are one phase on purpose, two holes with one name would be two gaps merged by accident. An unawaited hole would let the script run past a gap that has no value yet. A hole in a concurrent fan-out would have to be filled while its elements run. The body must be a literal because lowering extracts and evaluates its text at the site, and a function value has no text. A body is a closure the compiler does not check for use before declaration, so a reference to a later `const` would throw at run time. |
| 9010 | A persona's `model` is typed `ModelRef`, a string literal, or a union of string literals; `model()` takes a non-empty string literal. | The set of models a script can use must be closed before it runs, so the launch can resolve every name and the window can show it. The rule reads the **type** of the `model` property at each `agent()` site, so constants and ternaries between literals pass and a widened `string` does not. |
| 9013 | A persona's `budget.webSearch` is typed as a numeric literal or a union of numeric literals, each an integer from 0 to 1024. | The number of searches a subagent may make per ask is in the script the user confirms. The rule reads the **type** at each `agent()` site, the same way 9010 does, so constants and ternaries between literals pass and a widened `number` does not. |

Facade siting (9001) is the only analyzability rule. Everything else the analysis cannot
follow widens edge sets; it never bounces the script back to the model.

9006 is the one diagnostic that leaves the graphs in place. It describes a runtime failure,
not an unanalyzable shape, and the author needs the graph to see which fan-out to fix. 9005
and 9006 are courtesy checks; the engine's runtime check in `createActor` is the authority.
9010 is not: nothing downstream re-checks what a subagent's `model` could be, so it is the
only thing that keeps the set of names closed. Its companion 9011 (a name the catalog cannot
resolve) is not an analyzer code; the launch tools raise it, because only the host knows its
models.
9013 is the authority for the budget's range in the same sense: the engine keeps a
`budget.webSearch` only when it is an integer from 0 to 1024 and drops anything else, which only
a cast can produce, so that subagent gets the default budget.
The run service's recompile at submit does not repeat them.

## The interpreter

`analysis/interpret.ts` runs two listeners over one script.

The **taint listener** is a flow-insensitive fixpoint: it treats functions as values,
keeps one global environment, and grows until nothing changes. It answers "which sites'
outputs may have flowed into this value."

The **temporal listener** is one flow-sensitive walk in evaluation order, run once after
the fixpoint has converged. It answers "when was each request issued, where does each
`await` sit, which region encloses each event." It reads the converged taint state as an
oracle for three questions it cannot answer from syntax: what a given `await` settles, what
a given guard reads, and which function bodies a given call runs.

Running the walk once, after convergence, is safe because a gen-only monotone fixpoint
converges to the same result whatever order the statements are visited in. Visitation order
changes the speed, not the answer.

Minting the core is the last place raw offsets and the type checker are consulted. It
resolves fan-out containment (`within`) onto each site, renames the taint pass's provisional
`fan-out@order` ids to the final `fan-out#N` everywhere, reads a fan-out's literal
cardinality, and materializes artifact types as strings.

### The core

```ts
interface AnalysisCore {
  sites: { asks, worldReads, joins, actors, fanouts };  // ids, labels, locations, order, within
  facts: { askData, askActor, worldReadData, joinIn, fanoutIn, returnData };
  trace: { events, regions, controls, root, phases };   // the temporal walk's output
  types: { siteType, joinPortTypes };                   // the checker's answers, as strings
}
```

A fan-out site carries `cardinality` when the iterated expression is an array literal with
no spread, or a `const` bound once to such a literal and never written through `push`,
index assignment, `length`, or reassignment. Anything else, including `Array.from`, a
`filter` result, a parameter, or an ask's answer, leaves it absent. Nested fan-outs
multiply; if any level is absent the product is absent.

The core has a canonical text form, `serializeCore`, and a JSON encoding for freezing it
(`core-json.ts`).

## Taint: what depends on what

The taint analysis is gen-only and may-flow. Every transfer function is a union over a
finite lattice, so the fixpoint exists and converges in a few passes. Taint is never
removed: no sanitizers, no strong updates. The price is imprecision; the reward is that
every edge the analysis fails to prove exact it still draws, as inexact.

### Labels and values

Each facade call site introduces one label. `ask`, `files.*`, `git.*`, `world.run`, joins,
and fan-outs introduce **artifact** labels, carried by their result and everything computed
from it. `agent()` introduces an **actor** label, carried by the `Agent` reference. Function
values are tracked alongside, so higher-order code keeps the call graph total.

Every label occurrence carries an **exactness bit**, set at introduction and cleared by
any widening. An edge is exact if some witness path kept the bit.

An abstract value has four parts: its label occurrences, its statically-known fields, the
script functions it may be, and an optional partial-application prefix from `.bind`.
Field nesting is depth-capped at `VALUE_DEPTH_CAP` (8); beyond that the structure collapses
into the value's occurrence set. Cyclic values are joined cycle-aware. Neither diverges.

### Propagation

An expression's taint is the union of its subexpressions': operators, template
interpolation, concatenation, `JSON.stringify`, literals, spread, value-preserving array
methods. Strings launder nothing. `await e` preserves `e`'s set.

Bindings flow taint field-sensitively: declarations, reassignment, parameters,
destructuring in both declaration and assignment form, property access with a static name.
Compound and logical assignments join the right side into the target. Default parameter
initializers join with the actuals; a rest parameter reads the union of the remaining
actuals.

Every subexpression position is visited, including ones that carry no value into the
result: a ternary's condition, a computed property key, an element-access key, `typeof` and
`void` operands. A computed write key folds into the container, because `Object.keys` can
observe it; a read key does not.

`throw` and `catch` share one script-global thrown set: every `throw` joins its operand,
every `catch` binding reads all of it. `Promise.reject(x)` feeds the same set. This is
flow-insensitive across disjoint `try` blocks and sound.

A tagged template is the call `tag(strings, ...)`. `yield` joins the enclosing function's
return summary. Object-literal shorthand methods are function-valued fields, a getter's
return is the field's read value, and a value written to an accessor field flows into the
setter's parameter. A shorthand property `{ out }` resolves the value symbol, not the
property symbol.

### Heap writes

Bindings alias; they never snapshot. An object reached through two names, or through a
name and a container field, is one shared value, and a write through any alias is visible
through every other. Assignment into an object or array adds the value to the container
weakly. `push`, `unshift`, `splice`, `Map.set`, `Set.add` write into their receiver;
`Object.assign` writes its sources into its target. Spread and `Object.assign` are shallow
copies, modeled as such: a write through the copy's sub-object stays visible through the
source.

Objects cross call boundaries by reference. Writes that reach a parameter inside a callee
merge back into the caller's argument at each call site, including a container-literal
argument, whose fields are live places. A fan-out or `for...of` element's field writes merge
back into the collection.

Some expression forms are real aliases at runtime but are not simple name-or-field chains:
a comma expression's last operand, a ternary, a double `await` of the same promise, a
`Promise.all` result element. These get **may-alias** back-references: a write through the
value is replayed weakly into each target, recursively through chained aliases, bounded by
identity and depth.

Two under-approximations are accepted. A callee's **returned sub-object** is
summary-substituted, not aliased, so a write through `const b = pick(wrap); b.f = t` is
invisible to `wrap`. **Reassignment** merges values rather than re-pointing, so a reassigned
variable never gains write-through onto its new target; re-pointing would be unsound under
conditional reassignment without points-to sets. Three narrower may-alias gaps remain
open: a write through a nested field of a may-alias place, `Object.assign` and computed-index
writes and parameter write-back onto a may-alias target, and a literal field position that
resolves as a place before it is evaluated.

A channel's `send` is in the mutator set with `push`, `set` and `add`: `ch.send(x)` writes
`x`'s taint into the channel's place, and a `for await (const item of ch)` reads the place
as any `for…of` reads its iterable, so each producer of an item draws a data edge to each
consumer (exact when nothing widened along the way, as with `push`). The channel itself has no label of its own: it is a container the analysis sees
through, not a relay node (`docs/dynamic-workflow/authoring.md`, "Alternatives not taken").

### Calls

A call to a script function applies that function's summary: a mapping from parameter and
captured-variable taint to the return taint and the facade sinks reached inside. Recursion
and mutual recursion are a fixpoint over summaries. There is no inlining depth limit.

Inside a body a parameter's taint is a symbolic **placeholder**. A call substitutes its
actuals for the callee's own placeholders only; a placeholder of an enclosing function passes
through unchanged. At emission a placeholder resolves to the union of the actuals recorded
for that parameter across every call, recursively through the placeholders those actuals
carry, collapsed to occurrences. That is reachability over the placeholder graph, so emission
resolves each strongly connected component once and every sink is a lookup. Walking the
paths instead is factorial: a callback helper shared by many callers puts every caller's
placeholder into every caller's actuals.

Invocation forms that reshape the argument list are handled before positional binding:
`.call` drops the receiver, `.apply` smears the array inexactly across every parameter, a
`...spread` ends positional certainty and folds into an inexact tail, `arguments` is a
rest-like view over all actuals of the nearest non-arrow function. `.bind` carries a prefix
that is prepended at the eventual call; because a merged value cannot say which function
was bound, application unions both alignments. The prefix length is capped like field
depth.

A call whose callee resolves to no script function is an **unknown call**: a library
method, `Array.from`, a `new` of a non-class. Its result is the union of the receiver's and
arguments' collapsed sets, and every script function among its arguments is applied
pessimistically: each parameter receives the receiver-and-siblings union with exactness
cleared, and the function's return joins the result. The pot a callback's parameters receive
carries the sibling data, not the callables themselves. A library member is never dispatched
on the callables its receiver value happens to carry. Higher-order library code therefore
widens taint and never launders it. `new Promise(executor)` and a custom thenable's `then`
are covered by the same rule; what a callback feeds to invocations of its own parameters
(`resolve(draft)`) joins the result.

Classes get one abstract instance per class, flow-insensitively. Field initializers,
constructors, methods, accessors, `super`, static-string computed member names, class
aliases, class expressions in fields, and parameter properties are all modeled; a mixin-call
heritage over-approximates the constructor. All instances of a class are conflated.

### The callback registry

`analysis/callbacks.ts` is the one place that says what a library callee does with the
script functions handed to it. Both listeners read it; neither keeps a private whitelist.

- **`each`**: the callback runs once per element. `map`, `flatMap`, `forEach`, `filter`,
  `some`, `every`, `find`, `findIndex`, `findLast`, `findLastIndex`, `reduce`,
  `reduceRight`, `sort` on any receiver whose member is not script-declared; and
  `Array.from(xs, fn)`. The entry names which callback parameters receive an element, the
  whole collection, or the accumulator.
- **`once`**: the callback runs at most once. `.then`, `.catch`, `.finally` and the timer
  globals are **deferred** (they run after the receiver settles); `new Promise(executor)`,
  `.finally` and the facade's `future(body)` are **entered** (the library provably calls the
  callback). `future` is the one facade function in the registry: its body starts at the
  call and runs alongside the caller, so an `async` body opens an entered `call` region with
  the strand flag, exactly as an inline `async` callback does.
- No entry: once, not entered, every argument a possible callback, which is exactly what
  the unknown-call rule already applies.

Every application of a script function is recorded in the **call oracle**
(`TaintState.applications`): per call, `new`, or tagged-template node, the functions applied
there and whether as callee or as argument. The temporal walk inlines exactly those bodies
at exactly those sites.

The fixpoint evaluates a helper's body once per pass with each parameter holding every
function any caller ever passed, so the record at a call **through a parameter** (`fn()`
inside `async function limited(slots, fn)`) names every caller's callback. The oracle
therefore also records **provenance**. When the callee, or a function-valued argument, is
syntactically a parameter of an enclosing script function — an identifier whose declaration
is that parameter, with no default initializer and never assigned in the body — the record
says "parameter `k` of `F`" beside the merged list, together with the functions the
merged list owes to that parameter. And at every callee application the oracle records
what each argument **binds** to the parameter it fills: the functions the argument's value
holds, and, when the argument is itself syntactically a parameter of its enclosing
function, "parameter `j` of `G`". The walk resolves these against the call it is inlining
(see "Inlining"). Any other flow — `const h = fn; h()`, a callback stored in an object or an
array, a destructured parameter, a parameter with a default or a reassignment — keeps the
merged record: sound, and as slow as before.

### Relays

A `Promise.all` call is a **join**. Each input's taint yields an edge into the join, with
the input position recorded as a **port** when the argument is a static array literal, and
the result carries the join's own label. Static destructuring or indexing of the result
selects a port; computed access reads the whole join.

A promoted iteration is a **fan-out**. The iterated collection's taint yields edges into
it, the element parameter carries its label inside the body, and the collected results carry
it out.

Relay labels are additive, never substitutive. A joined tuple carries the join's label in
addition to the producers' labels, so a downstream sink gets an edge from the relay and an
edge from each producer. That is what lets the causality projection skip relay nodes
without losing connectivity.

### Widening

Computed property access reads the container's whole set; values funneled through
containers whose fields cannot be tracked collapse; function arguments applied at unknown
calls lose exactness. Widening folds labels, never the call graph: a callee selected by
`fns[i]` still dispatches to its summary.

### Convergence

The fixpoint throws after `ITERATION_CAP` (100) passes. In practice a fixpoint fails to
converge for one reason: storage that grows per pass because a value created during a pass
became the target of a persistent merge.

**The canonical-heap rule.** Every abstract value that models runtime storage, meaning
anything that can be aliased, written through, or referenced from a may-alias set, is keyed
by a static program point and created once for the whole fixpoint: environment slots per
symbol, class instances per class, `reduce` accumulators per candidate, join results per
join call, conditional places per ternary node, container literals per literal node, and
their fields. Values built during a pass are snapshots and must never become alias targets
or write-back targets. May-alias sets dedupe by identity, so a freshly minted target adds a
never-seen member every pass and `changed` never settles.

Two corollaries. Any new place kind returned by `resolvePlace` must come from this heap.
Growth into a canonical node must report through the fixpoint's `changed` flag, or
consumers evaluated earlier in the same pass never observe it. And one caveat: a canonical
node must not resolve eagerly, before it has been evaluated, or the sites inside it are
never visited. The literal place honours this by construction: it is reached only through
evaluation, which visits every site inside and then merges the result into the place.

Structure that grows in extent rather than depth (a bind prefix that grows on self-rebind)
is capped and degraded into occurrences, never truncated; a truncation would drop a
may-flow.

### What the taint analysis does not do

- No runtime tracing. The GUI joins runtime instances to the static graph by site id; the
  analysis never learns from execution.
- No analyzability diagnostics beyond facade siting. Imprecision widens; it never rejects.
- Per-instance precision for classes, path-sensitive aliasing, and the three may-alias gaps
  above are out of scope until a real script needs them.

## The site graph

`projectSiteGraph(core)` emits a directed graph over sites whose edges mean "the output of
A may feed B." Nothing more is encoded: a loop is a cycle, alternatives are parallel edges,
joins and fan-outs are relay nodes. Two virtual nodes complete it: `source` (the script
entry) and `sink` (fed by whatever tracked value reaches the script's `return`).

Sinks and what they emit:

| Sink | Reads | Emits |
|---|---|---|
| `ask(instructions)` argument | artifact labels | `data` edge, label's site → ask |
| world-read arguments | artifact labels | `data` edge, label's site → world-read |
| join and fan-out inputs | artifact labels | `data` edge into the relay |
| script `return` | artifact labels | `data` edge → `sink` |
| `.ask()` receiver | actor labels | the context relation |

Two ask sites are **context-related** when their actor sets intersect; the relation is exact
when both sets are the same singleton. It is emitted as a `context` edge from the earlier
ask to the later one. Same-site repetition needs no self-edge.

### Edge emission

One edge per (label's site, sink site). Edges are deduplicated by `(from, to, kind, port)`;
a deduplicated edge is exact if any witness kept its bit. Actor labels never make data
edges. After emission, every `ask`, `world-read`, and `fan-out` node with no incoming data
edge gets an exact edge from `source`, and a relay node with no edges at all is pruned.

### Edge attributes

`kind` is `data` or `context`; `exact` is the witness bit. A data edge also carries
`type`, the producer's artifact type name, with provenance semantics: the edge means "a
value computed from A's output feeds B," so the label is A's type, not a claim about the
wire value. Types come from the checker's `typeToString`. `any`, `unknown`, `never`, and
`void` are omitted. An edge out of a join that selected a port takes the port's element
type; an edge into a join takes the producer's whole type. A fan-out's type is its collected
artifact type with the facade promise wrapper unwrapped through nested arrays: a `.map`
producing `Node<Review>` labels as `Review[]`.

Types ride the text and mermaid forms only. The display payload carries no edge types, by
decision: a type name on every arrow read as noise. The hand-off graph carries them per
hand-off for the inspector.

### The actor graph

`toActorGraph(siteGraph)` quotients the site graph by lane: actors as nodes, aggregated
data flow as edges, `source` and `sink` kept apart so it reads as a pipeline, world reads
collapsed into one `workspace` node, relays dropped (relay labels are additive, so nothing
is lost), edges between two endpoints hidden. A quotient by actor destroys temporal order,
so it cannot be what the GUI draws; no product code reads it. It stays exported as a
compact "who talks to whom" digest.

## The temporal walk

`analysis/causality-order.ts` walks the script body once in evaluation order and records a
**trace**: a list of events, a tree of regions, the control facts, and the phases reached.

### Events

| Event | When |
|---|---|
| `issue` | a facade call expression is evaluated: the request is sent |
| `settle` | an `await` barrier: these steps' promises are known to have settled here, and these strands are joined |
| `actor` | an `agent()` call is evaluated |
| `mark` | a `phase("...")` marker statement is evaluated |
| `jump` | `continue`, `break`, `return`, `throw`, or a recursive re-entry, with its target region already resolved |

Every event carries its region chain. An `issue` and a `jump` also carry the phase current
where they happened. A `settle` carries `joins`, the strand regions the barrier waited
for, absent when it waited for none, and `maybeJoins`, the subset it lifted on a may-claim
(the promise reached the await through a container or a helper), absent when every join
is certain. Its `steps` may be empty: a barrier that joins a
strand whose summary is already settled settles nothing new, and the join alone is a
control-flow fact worth an event. `maybe` is written `false` on such a join-only settle.

Happens-before is a partial order over events, not steps. JavaScript is single-threaded,
so issues are totally ordered by evaluation; only settles order the work. Two steps are
concurrent when neither's settle precedes the other's issue. Concurrency is therefore
incomparability and needs no notation of its own.

### Regions

Regions form a tree. Each leaf's chain names its ancestors; children are ordered by first
leaf.

| Kind | From | `entered` |
|---|---|---|
| `seq` | the root | yes |
| `loop` | `for`, `for-of`, `for-in`, `while`, `do-while`, `for await`; a recursion SCC (`recursive` flag) | a `do…while` body, or a `for` with a positive literal bound |
| `fanout` | a promoted iteration candidate; `strand` when its literal callback is `async` | no |
| `choice` | one `if`, ternary, `switch`, or short-circuit; `exhaustive` when an arm must run; `fallthrough` for switch | yes |
| `branch` | one arm of a choice; also a never-called body the sweep placed (`detached`) | no |
| `call` | one inlined helper body, located at the call site; `strand` when the applied function is `async` or the registry calls the callback deferred | yes |
| `try`, `attempt`, `catch`, `finally` | one try statement and its parts | try, attempt, finally yes; catch no |

The `strand` flag rides on `call` and `fanout` alone. It says the activation the region
stands for runs alongside the body that spawned it, and "Strands and frames" below is what
it means.

`choice`, `call`, `try`, `attempt`, `catch`, and `finally` are **structural** regions. The
causality projection looks through them: they count as certain in a chain, a step's home is
its innermost non-structural region, and they never reach its output. Stripping them and
the `mark` and `jump` leaves from a trace leaves a plain trace of issues, settles, and
non-structural regions, which is all the causality projection needs. `parallel` and
`shared` exist in the type union and are never created.

### Inlining

Function bodies run only when called, so the walk never descends into a function on its
own. It inlines the body at each call site, reading the call oracle for which bodies a call
runs. Each inlined body is an **activation** that carries what the call site bound to each
parameter, resolved against the enclosing activations when a binding is itself "parameter
`j` of `G`". A record "parameter `k` of `F`" at a call inside the body resolves to the
innermost activation of `F`: its binding for `k` replaces the functions the merged record
owes to that parameter, so `fn()` inside a shared helper inlines only the callback this
call passed. An unresolvable record — no activation of `F` on the stack, as in the sweep, or
a parameter the call left unfilled — falls back to the merged list. A callback's
multiplicity, certainty, and deferral come from the registry: an `each`
callback opens a `fanout` region; a `once` callback opens a `call` region, wrapped in a
skippable `choice` unless the library provably enters it; a deferred callback is a strand
whose **prologue** is an ordinary barrier over its receiver, run inside the strand's own
frame. A callee applied at more than one target opens an exhaustive `choice` with one
skippable arm per target. `new C(args)` and tagged templates inline the same way.

Re-entering a function is recursion only when an activation of it **with the same
bindings** is already open: a helper applied again inside its own callback with a different
callback is two activations, not a loop. Recursion is precomputed as self-reachability over
activations — the same resolution the walk performs, run over each body's call sites without
emitting events, memoized per activation. A recursive activation's body gets a `loop` region
with the `recursive` flag; re-entry is cut and recorded as a `recur` jump. That is what gives
recursion the same self-arrow as any other sequential repetition.

A helper called twice contributes two issue events for one step id. There is one step per
site, never one per call path (see "Alternatives not taken").

The end-of-walk **sweep** places bodies no call ever applies: dead code. Each gets a
`detached` branch region at the root. A detached region in a script with no dead code
means the oracle missed a call.

### Strands and frames

A **strand** is one asynchronous activation the walk inlines: the body of an `async`
function applied at a call, as callee or as callback, literal or named, or a deferred
callback (`.then`, `.catch`, `.finally`, a timer). A strand runs alongside the body that
spawned it. Its `await`s suspend the strand, never the spawner, and the spawner learns of
its completion only by awaiting its promise. A `for…of` body is not a strand: it runs in
the enclosing function's frame. The root body is not a strand either; it is the main
activation. A strand rides as the `strand` flag on the `call` or `fanout` region that is
its body.

The walk keeps one **frame** per open activation, a settled set of its own, root frame
first. A step is settled from the current activation's view when **any** frame on the
stack holds it: what the spawner already awaited is settled for the strands it spawns.
Fresh settles are recorded in the **current** frame alone: this activation's `await` tells
the spawner nothing. `issued` stays global, because from any frame's view everything
issued earlier is in flight until visibly settled, which is what widening needs. A single
global settled set would flatten concurrent activations onto one line, because an `await`
inside an inlined `async` callback would settle its step for the whole script.

A strand's **summary** is its frame's settled set at close: what the strand itself
awaited, and therefore what awaiting its promise settles. Each issue is also recorded on
the innermost open strand, which is the **lift rule**: a barrier that claims a step issued
inside a closed strand has, by that claim, waited for the strand.

Strands are numbered in **spawn order**, and an expression's joins are resolved against
the count of strands standing when its evaluation began. Deliberately not an event index:
a strand that emits no event before its own first `await` would tie with that await's
mark, and the barrier would join the very strand it stands in.

### Await barriers and the settle-certainty rule

`await p` settles two sets. The **syntactic** set is the steps issued while evaluating the
awaited expression; they settle certainly. The **oracle** set is the step labels the awaited
value carries, which resolves a promise stored in a variable, passed to a helper, or joined.
The barrier covers their union and widens over everything in flight only when both are
empty (`await 5`, an unknown call's promise). Widening over-orders, which understates
parallelism. Under-ordering is the one thing the walk must never do.

For the oracle set, after dropping join and fan-out labels:

- a singleton exact witness settles certainly;
- anything else, two or more witnesses or a single inexact one, settles as a may-claim;
- a witness admitted by repetition rather than by prior issue settles as a may-claim even
  when singleton and exact.

The oracle is flow-insensitive, so it can name a step not yet issued at this point. **A
promise cannot settle before its request issues**: witnesses are filtered by that invariant
before the singleton judgement, and the order matters, since dropping a phantom is what
lets the survivors be a singleton. The exception is **repetition**: a step that shares an
enclosing iteration construct with the await is realizable, because round k's promise
settles at round k+1's await. Such a witness is admitted but never certain: the first round
awaits the initial value and settles nothing, and the last round's issue escapes the loop.

Join sites stay conservative. The oracle cannot tell `Promise.all` from `Promise.race`,
which shares the join machinery and settles exactly one, so a multi-witness set is never
read as settle-all.

A barrier also **joins strands**, and each joined strand contributes its summary to the
sets above. There are two ways in:

- **syntactic**: the strands spawned while the operand was evaluated, keyed by spawn order,
  plus the strands bound to an identifier in an **awaited position** of the operand. The
  awaited positions are the operand itself, each argument of `Promise.all`, `allSettled`,
  `race` and `any`, each element of an array literal, a spread's operand, and the same
  positions through parentheses and type assertions. Every other expression is opaque,
  which is what keeps `await f(aWork.length)` from joining the strands `aWork` holds.
  A syntactic join settles the strand's summary **certainly**: the await provably waits
  for that activation.
- **lifted**: a closed, not-yet-joined strand one of whose issued steps this barrier
  claims. It settles its summary with the certainty the claim came in with, because all
  that is known is that something the strand issued has settled. Only a closed strand can
  be lifted.

A strand joins once. A second await of the same promise adds nothing, exactly as a second
settle of one step already adds nothing. Freshness then runs as usual: steps already
settled in a visible frame drop out, and the survivors are recorded in the current frame.

The joins ride the **first** event the barrier emits, the certain one when it emits both,
because a join is a property of the barrier and not of either certainty side. A barrier
that joins a strand but settles nothing fresh emits a join-only `settle`, with `joins` and
an empty `steps`, so the control-flow projection still learns where the strand's exits
reconnect.

A deferred callback's prologue is an ordinary barrier of this kind over the receiver: the
steps issued while the receiver was evaluated, plus the oracle's claim keyed by the member
name, split by the settle-certainty rule like any other await. A singleton exact receiver
therefore settles certainly. It needs no special certainty, because the barrier runs
inside the strand's own frame and so orders the continuation's body without asserting
anything about what the main line issues afterwards, and without robbing the main line's
own later `await` of its certain settle. A timer callback has no receiver, so it is a
strand with no prologue.

A `settle` event carries `maybe` when the barrier widened or the witness was ambiguous.

Frames move claimed orderings toward concurrency, so the invariant to guard is still
"never under-order". Four boundary cases are known and accepted:

- One residual **under**-ordering. A strand with internal awaits whose promise reaches the
  awaiting site only through a container or a helper parameter, and whose awaited steps are
  not on its return path, is joined by neither route: the position is opaque to the
  syntactic scan and the lift rule has no claimed step to lift. The common shapes are
  covered: `Promise.all(work)` names the array, `await helper()` spawns inside the operand,
  and `await q` with `q = p.then(async …)` joins through the binding.
- The deferred prologue can **widen**. An unresolvable receiver leaves both halves of the
  claim empty, so the prologue falls through to widening inside the strand's frame, which
  is what `await unknownCall()` does anywhere else. It over-orders, the licensed
  direction, and it touches the strand's own frame alone.
- A **recursive** deferred callback loses its prologue at the recursion cut. Inlining
  returns early when the declaration is already on the stack, which is before the prologue
  would run, so the re-entrant activation has no receiver barrier. Recorded, not fixed.
- `Promise.race` and `Promise.any` **join** every strand they name, although exactly one
  of their promises decides the result. The settle-certainty rule refuses to read them as
  settle-all for steps; the join is the over-ordering direction, and it is taken.

### Control dependence

The steps a guard reads control the region it guards. Controllers are the union of a
syntactic scan (variables bound to ask results, always certain) and the oracle's
`guardReads` (singleton exact is certain, otherwise a may-claim). Both halves are needed: the
oracle sees a derived value (`const ok = t.escalate; if (ok)`) the scan misses, and the scan
sees an implicit flow (`const flag = (await …) ? 1 : 2; if (flag)`) that carries no taint.
Guard sinks are the `if`, `while`, `switch`, and `for` conditions, a ternary's condition, a
short-circuit's left operand, and `for await`'s iterated expression. `do…while`'s condition
is deliberately not a guard sink: it cannot decide whether the body runs. The control side
takes no temporal filter: a guard may legitimately read a step issued later in the walk
across loop rounds.

### Phases

`phase("name")` is a marker statement. It claims the rest of the block it stands in: every
step issued in the remaining statements, including nested blocks and inlined helper
calls, belongs to that phase; when the block ends the outer phase resumes. A step belongs to
the phase current when its call is evaluated. Two markers with the same name are one phase;
ids `phase#N` number names by first reach. The reserved `unphased` phase holds steps issued
before the first marker; it has no name and appears only when it has members. A script with
no markers gets no phase vocabulary at all, and its graphs are byte-identical to the
pre-phase output.

The walk records a `mark` leaf at each marker. Nothing in the analysis requires a phase to
contain a step; the prompts teach the model not to write empty phases, and the engine emits
a `phase-entered` event at runtime so an empty phase still lights up.

`collectSitePhases(core)` reads the trace back into a table of site id to phase **name**,
for the engine's birth-phase stamp (the engine document, "Identity: sites, ordinals,
phases"): every `issue` event of a step and every `actor` event of a lane carries the phase
current where it was evaluated, and a site whose events all fall in one named phase is
listed under that name. A site with issues in two phases, or only in `unphased`, is absent,
and the engine falls back to its dynamic current phase for it. The table is derived from the
trace rather than from the projected graphs so that helper inlining, callback placement and
future bodies are read exactly as the confirmation graph reads them.

## The causality graph

`projectCausalityGraph(core, siteGraph)` is a partial order over **steps** with actors as
lanes. A step is an `ask` or a `world-read` site. An actor is an attribute of a step,
rendered as a lane, never a node. An edge means "runs after" and records why.

### Steps, lanes, regions

```ts
interface Step { id; kind; label; labelPattern?; loc; lane; lanes?; source?; region; certainty; phase?; repeat? }
interface Lane { id; name?; namePattern?; loc?; families? }
interface Region { id; kind; parent?; loc?; bound?; label? }
interface OrderEdge { from; to; kind; certainty; exact? }
interface CausalityGraph { steps; regions; lanes; edges; sink?: { fedBy }; phases?; phaseEdges? }
```

Lanes are the actor sites in creation order, then `workspace` for world reads, then
`unknown` for an ask whose receiver resolved to no actor. `Lane.families` lists the
iteration regions enclosing the `agent()` call, outermost first; a non-empty list makes the
lane a family, one fresh actor per element, and nested families multiply.

`source` is dropped: with time as an axis the origin is the script entry. `sink` is kept
as `fedBy`, the steps whose artifacts reach the return.

A step's `certainty` is `always` when it has at least one issue whose region chain is
certain (every enclosing region is `seq`, structural, or an entered loop) and it is the
target of no control edge; otherwise `maybe`. Certainty is model-only; the GUI does not
draw it.

### Where the edges come from

Five sources, none of them taint alone:

| Kind | Meaning | Source |
|---|---|---|
| `data` | B needed A's answer | the site graph's data edges between steps (relays skipped: their labels are additive) |
| `control` | A's answer decided whether B runs | the trace's control facts |
| `fifo` | same actor, serialized by the runtime | any two steps issued on one actor, in issue order; `maybe` when either receiver is a may-set; `workspace` and `unknown` excluded |
| `seq` | ordered only by where `await` sits | every step settled **in a frame this issue can see** precedes it |
| `carry` | round k feeds round k+1 | a back edge in issue order, retyped |

A `seq` fact whose source sits in a branch arm that ends in `continue` is marked
`viaJump`: the later step in the same round is reached only next round. A `break` arm drops
the fact instead.

Frame visibility is where the walk's strands reach this projection. A settle belongs to
the innermost `strand` region on its chain, or to the root when its chain has none. An
issue sees that settle when the frame is on its own region chain, or is the root: the
strand's own later issues and the issues of strands spawned inside it, never the
spawner's. Of the visible settles the strongest claim wins, one certain settle beating any
number of may-claims, and within one frame a certain settle still upgrades an earlier
may-settle. Two `async` callbacks awaiting their own asks therefore stay incomparable,
which is all concurrency is in this view.

### Repetition and the two multiplicity cues

For each `loop` and `fanout` region: the last step the region awaits gets a `seq` edge to
the region's first step, closing the cycle, and every awaited step is `serial`. A step the
region never awaits is `serial` with a `fifo` self-edge when it runs on a fixed actor, since
the mailbox serializes it; on a lane family its instances coexist, so it is `stack`. The cue
splits on concurrency, not cardinality: a stack means instances that coexist, a self-arrow
means instances that follow one another. A step that runs at most once has no `repeat`.
"Awaits" is lexical here, not frame-visible: a barrier inside a strand counts for every
region enclosing it, because what the cue asks is whether the construct's own rounds
overlap.

### Dedup, back-edge typing, reduction

Facts are collapsed to one per ordered pair: strongest kind wins (`control` > `data` >
`fifo` > `seq` > `carry`), `maybe` wins over `always`, `viaJump` survives only when every
contributing fact carries it.

A fact is a **back edge** when it is marked `viaJump`, is a self-edge, or its target's last
issue precedes its source's first issue. A back edge is kept only when repetition can
realize it: an iteration region enclosing both ends, or for a self-edge, any enclosing
iteration region or a second issue site. A realizable back edge is retyped `carry` and
remembers its underlying kind. An unrealizable one is dropped: the site graph's
variable-level data edges produce the full writers-times-readers product on a reassigned
`let`, so a refine-until-approved loop yields a data fact from the in-loop revision back to
the review that ran before the loop, and nothing can realize it.

#### Typed transitive reduction

`analysis/causality-reduce.ts`. With one arrow style on screen, reduction carries the whole burden of readability, and it must stay typed even
though rendering is not: a uniform reduction would drop `scan → judge`, the real
dependency, in favour of the incidental chain `scan → plan → review → judge`.

1. Lift the carry edges out. What remains is forward-only, though not always a DAG: a
   shared helper called before and inside a loop yields forward facts both ways.
2. Visit forward edges in issue order; drop an edge when a path of length two or more
   over surviving edges of strong-enough kind already orders its endpoints. `data` and
   `control` yield only to paths of `data` and `control`; `fifo` also yields to `fifo` hops;
   `seq` yields to anything. Deciding against the surviving set, not the original relation,
   keeps the result irredundant on cycles; deciding against the original relation and
   restoring afterwards leaves most of a cyclic graph's edges in place.
3. Drop a carry edge when a surviving composition of one forward path, exactly one carry
   hop, and one forward path asserts the same round-to-round fact, every hop at least as
   strong as the dropped carry's underlying kind. Two carries that justify each other cannot
   vanish together.
4. Restore the surviving carries.

Never dropped: an edge whose ordering no strong-enough witness path asserts.

Reduction is certainty-blind on purpose. Requiring the witness path to be no less certain
than the edge it replaces would keep an edge from every ancestor of the returned artifact,
which is precisely the producer-to-sink noise reduction exists to remove. Readers read a
chain as a chain.

### May-set lane expansion

A dynamically selected receiver, `(flag ? a : b).ask(…)`, is one site with a may-set of
lanes. As the last pass, after reduction, such a step expands into one copy per candidate
lane when the set has two to four real actor lanes. `(cond ? a : b).ask(p)` is the same
program as `cond ? a.ask(p) : b.ask(p)`, and the analyzer already draws the second as two
`maybe` steps. Each copy's id is `` `${id}~${lane}` ``, its `source` is the site id, its
certainty is forced to `maybe`. `fifo` edges expand lane-matched only; every other kind
expands to the full cross-product with certainty re-derived from the copies. A self-carry
becomes the full k×k product. A larger or unresolved set keeps a single card in the first
lane. Without expansion, a two-player game whose every ask is `(turn ? a : b).ask(…)`
leaves one lane with no step at all, and the picture reads as a one-player game.

### Phase copies and the phase quotient

When markers exist, `phase-graph.ts` finishes the graph. A step claimed by more than one
phase (a shared helper called from two phases) becomes one copy per phase, id
`` `${id}~${phase}` ``, `source` set once to the site id. These copies are both-run, not
alternatives; each copy's certainty is derived from the issues in its own phase. Every
step then carries exactly one `phase`.

Edges onto copies pass **temporal admission**: an edge a → b may land on the pair
(a@P, b@Q) only if b has an issue in Q after a's first issue in P, or the two sites share an
enclosing iteration region. Lane copies sit at one rank, so full expansion asserts nothing;
phase copies each occupy a time position, and full expansion would assert false order. A
`seq` fact also remembers the phase where its barrier was witnessed and lands its head only
there. If admission blocks every pair, the edge falls back to full expansion rather than
vanish: over-ordering is allowed, invented concurrency is not.

The **phase quotient** projects each reduced step edge onto the claiming phase pairs under
the same admission rule. Same-phase edges dissolve, except a same-phase `carry` which
stays as a self-loop in the model. Facts are deduped per phase pair with the same rule as
steps and reduced with the same function. The result is `phaseEdges`; the phase table lists
`unphased` first when it has members, then the phases with members. This quotient answers
"which phase must precede which." The GUI's phase arrows come from the control-flow
quotient instead, which answers the different question "where can execution go"; the
causality quotient reaches only the text form and the mermaid emitter.

## The control-flow graph

`projectControlFlow(core)` reads the trace as a structured control tree and emits where
execution can go next. Nodes are **occurrences**: each `issue` leaf (`ask#3@2` is the second
issue of `ask#3`) and each `mark` leaf. A helper called twice contributes two nodes for one
step. Three terminals: `entry`, `sink` (normal completion), `abort` (uncaught throw). A CFG
is never transitively reduced.

The graph is **concurrent**: a strand is entered by a `fork` where the trace records it and
left by a `join` at the barrier that awaits its promise, not at its spawn point.

Edge kinds: `next` (sequential), `branch` (choice head to an arm, or past a skippable
choice), `loop` (back edge, including `continue` and `recur`), `exit` (loop exit, `break`,
or a never-entered loop skipped), `fork` (into a fan-out body or a strand), `join` (out of
a fan-out, out of a strand at the barrier that joins it, or out of a strand at the sink
when nothing joins it), `jump` (`return` to the sink), `throw`, and `may-throw` (an issue
inside a try body to the catch). `via` names the jump statement behind an edge.

One edge stands for the whole path between two nodes, which may cross several boundaries.
It takes the most significant transition on the path: `next` < `branch` = `fork` < `exit` =
`join` = `jump` < `loop` < `throw` = `may-throw`. Three cases are forced regardless of rank:
a `return` reaching its own call becomes `next`, a `break` inside a switch becomes `branch`,
a `return` inside a fan-out callback becomes `join`.

Construction is a recursion over the tree that computes each node's entries and exits and
carries pending jumps up to their target region. A sequential container chains exits to
entries. A choice sends the incoming sources to every arm and, when not exhaustive, past the
arms too; switch fallthrough chains arms. A loop feeds body exits back to body entries and
out to the loop's exits; a never-entered loop also lets the incoming sources pass; a
recursive loop is closed only by `recur` jumps and its normal completion is the return. A
fan-out forks in and joins out. A try body sends every issue inside it to the catch entries
as `may-throw`, then to `finally` or to `abort`; jumps out of the try body pass through
`finally` first and continue from its exits. Incoming sources that pass through a loop body
without meeting a node do not close it: an iteration nobody can see is not an iteration.

A **strand** region overrides the rule for its own kind, `call` or `fanout` alike: what
matters is that the body runs concurrently with its spawner, not how it was written. It
flows its body from the incoming sources retyped `fork`, then **parks** its exits under
its own region id and hands the incoming sources straight through: the spawner carries on
with exactly what it arrived with. Beside the exits it parks two facts the joining barrier
reads: the sources it was spawned from, and whether control could pass through its body
without meeting a node (an incoming source that came out the other end, or a `return` that
met nothing on its way). The parked exits are the body's exits
and the callback's `return`s, all typed `join`. Two things never park. Sources that passed
through the body without meeting a node are dropped, as they are for a loop. So is any exit
still standing on one of the strand's own incoming sources: that is the spawner's control,
not the strand's, and parking it would draw a second, `join`-kinded copy of the
pass-through edge the spawner already makes. The second rule is also what keeps a
node-free strand's `return` out of the graph, and with it the entry placeholder such a
`return` can still be standing on. A strand with neither an exit to park nor a node of its
own is invisible and parks nothing; a strand whose exits all fell away but which created
nodes still parks, with no exits, so that a later marker can read it as running.

A `settle` leaf is where the strands it awaits rejoin the main line, and where the main
line gives up the control it carried for them. It returns the parked exits of every strand
the event's `joins` names, plus its incoming sources **minus the sources that stood at the
spawn** of each strand it joins for certain. Those sources were the spawner's control at
the moment it forked; the barrier is where that control waits for the strand, so what
follows the barrier follows the strand's exits, not the fork point. Two kinds of join leave
the spawn sources standing: a may-join (the event's `maybeJoins`: the promise reached the
await through a container or a helper, so the barrier may not have waited for this strand
at all), and a strand control could pass through without meeting a node (on that path
there is nothing to wait for). Sources the main line gained after the spawn are never
touched: a step issued between the fork and the barrier precedes what follows, beside the
strand's exits. A body still learning its entries stands on a placeholder for its incoming
sources; a barrier inside it consumes the placeholder exactly when it consumes every source
the placeholder stands for. Without this rule every helper call left its fork point standing on the
main line for good, so `n` sequential `await helper()` calls drew an edge from the entry
and from every earlier call into every later one, `n(n+1)/2` edges in all, and a picture in
which the third call could run before the first. A join-only settle, the one that names no step, is exactly as load-bearing
here as any other. Strands still parked when the root's sequence ends join the `sink`:
nothing awaited them, and all that is known is that the script did not outlive them.
Strands parked inside a detached body are discarded along with its pending jumps, because
a detached body has no position and neither have they.

A `mark` leaf records **`alongside`**: the phases of the strands still parked when the
marker is entered, minus the marker's own phase and minus any strand the marker sits
inside, in phase-table order. `unphased` is allowed and is ordered first; a strand spawned
before the script's first marker is running, and dropping it would claim a phase is
entered with nothing beside it. `alongside` is flow-insensitive across choice arms, like
the walk's `issued` set: a strand spawned in one arm counts as live at a marker in the
other, because over-claiming "may run alongside" is the licensed direction.

`alongside` is a node fact and not an edge kind, for two reasons. "An earlier phase's
strands are still live here" is not a transfer of control, and it cannot be recovered from
the edges once they fold: `A; if (x) B; C` yields the same shape without anything running
concurrently. It is also deliberately the mark-time definition rather than the causality
quotient's incomparability. The timeline draws phases, and a phase lights while an earlier
phase's subagents are still running even when its own first step waits on them.

The source list at every seam is deduplicated: a skippable choice with nothing inside
returns its incoming sources twice, and a helper inlined a few hundred times would double
them at every one. Tree children are ordered by a cached first-leaf index, so ordering
costs linear time in the trace rather than exponential in nesting depth.

The **phase quotient** (`flow-phase.ts`) projects each occurrence edge onto its endpoints'
phases. Same-phase edges dissolve except `loop` back edges, which stay as self-loops; kinds
are kept apart; terminals project to themselves; nothing is reduced. A phase's `alongside`
is folded here too, as the union of its mark nodes' lists in phase-table order, omitted
when empty: a phase entered twice with different strands running is entered alongside
both. It is not part of the quotient, because it is not an edge. The bounding layer feeds
this quotient to the GUI, dropping `entry` and `abort` edges, moving edges to `sink` into
`exits`, dropping self-loops, and reducing untyped over the condensation of the folded forward
edges — edges inside a strongly connected component are never dropped
(docs/dynamic-workflow/presentation.md, "Untyped reduction"). `alongside` is forwarded as a
node fact on each phase, never through the reduction (same file, "Alongside").

Known approximations: a loop head's condition is walked once, before the body, so a step
in a `while` condition sits outside the loop; an optional call `await f?.()` inlines the
helper unconditionally, so the path that skips it is not in the trace and has no edge (the
old transparent `settle` drew one by accident); `may-throw` edges come only from issues inside
a try body, not from steps in a catch or outside a try; and a step in a catch block still
reads `always` in the causality graph, because the transparency rule looks through `catch`
without consulting its `entered` flag.

## The hand-off graph

`projectHandoffGraph(core, causality, siteGraph)` gives the GUI's second level: for each
phase, one card per participant and the hand-offs between them.

**Participants.** One card per phase per lane that has at least one step there. A lane
family whose multiplicity is known and at most `FANOUT_EXPAND_CAP` (8) becomes one card per
member, `` `${phase}:${lane}[${i}]` ``; otherwise one `many` card. Multiplicity is the
product of the cardinalities of every fan-out enclosing the `agent()` call. Without phases
every step is in `unphased`.

**Hand-offs.** Take each reduced causality edge whose endpoints are in the same phase and
on different lanes. Map endpoints to cards, every member card for an expanded family. Merge
per ordered pair; `back` when every contributing edge was `carry`. Reduce with
`reduceOrdering`, forward edges as one kind and back edges as carries. Family members have
no edges between themselves: a self-carry on a fan-out ask would otherwise connect every
member to every other. For each surviving edge, collect the artifact types of the site
graph's data edges between the two cards' sites; they feed the inspector, never the arrow.

**Order.** Participants are grouped by phase in first-reach order, then by longest-path rank
over forward hand-offs, then by earliest step, then by member index. The array order is the
stack order on the folded card and the left-to-right order on the open one; the first
participant is the opener.

## Joining runtime instances

The analyzer never learns from a run. The run pane decorates the static graphs with what
the engine reports, and the join is by site id.

A runtime node is `{siteId, ordinal}`, an actor `{siteId, ordinal}` too. A step matches
nodes whose site id equals the step's `source`, or its `id` when it has no `source`; a
may-set copy is narrowed further by the node's `actorSiteId`, and a phase copy by the
node's `phaseName`, which the engine stamps on every node and actor at the moment its
ordinal is minted (the phase current when the call ran, not when the event was emitted).
An instance with no phase stamp on a run that has phase stamps belongs to the unnamed
phase; on a run with no stamps at all it belongs to every phase.

Instance-level data provenance is approximate. The engine records no "what fed what", so
a data edge between instances is inferred from the static edge plus settle-before-issue
order, and when a producer ran three times before a consumer was queued the join cannot say
which instance fed it. Step alignment is exact; provenance is not.

Statuses fold per step: any running instance makes the step running, else any failed, else
all settled makes it done; a step with no observed instance gets no entry rather than
`pending`, because "never ran" and "queued" must not share a value.

## Text forms and tests

Every graph has a canonical, deterministic text form in `analysis/serialize.ts` and
`analysis/core.ts`, and a mermaid emitter in `analysis/mermaid.ts`. Each fixture script
under `tests/graphs/` is snapshotted in all six forms:

| Golden | Form |
|---|---|
| `<fixture>.txt` | site graph |
| `<fixture>.actor.txt` | actor graph |
| `<fixture>.causality.txt` | causality graph, phases first when present |
| `<fixture>.core.txt` | the core |
| `<fixture>.cfg.txt` | control-flow graph, occurrence and phase levels |
| `<fixture>.handoff.txt` | hand-off graph |
| `*.mmd` | mermaid, for a representative subset |

The strand vocabulary reads in the goldens as three tokens: `strand`, `joins=`, and
`alongside=`. A region line ends in `strand`. A settle line carries `joins=a,b` after its
region chain, and a join-only settle drops the step token altogether, so it prints as
`settle in=seq#1 joins=call#1` with single spaces throughout:

```
region fanout#1 fanout parent=seq#1 @9:15 label="map" strand
settle ask#1,ask#2 in=seq#1 joins=fanout#1,fanout#2
settle in=seq#1 joins=call#1
node phase#2@1 mark phase=phase#2 alongside=phase#1
phase phase#2 "review" alongside=phase#1
```

In the control-flow text form `alongside=` sits after `phase=` on a mark node line and
after the name on a phase line. `phaseFlowToMermaid` draws one dashed `alongside` link per
pair, from the earlier phase to the later one in phase-table order, after the arrows.

The goldens are the analyzer's human-readable contract: regenerate with `pnpm test -- -u`
and review the diffs by hand. Two invariants hold across the whole corpus. The phase
vocabulary is all-or-nothing: no marker means no `phases`, `phaseEdges`, or `Step.phase`
anywhere; a marker means all three, and every step names a listed phase. And no fixture but
the one dead-code fixture yields a `detached` region.

The targeted suites are `analysis.test.ts` (diagnostics, facade siting, API shape),
`causality.test.ts` (ordering rules), `callback-invocation.test.ts` (oracle and registry),
`control-flow-projection.test.ts` (scale), `convergence.test.ts` (the canonical-heap
shapes), `phases.test.ts`, `actor-names.test.ts`, `core-json.test.ts`, and `smoke.test.ts`
(recorded production scripts, no goldens, must analyze within a time budget). A minimized
script that shows a soundness bug lives in `tests/holes/`, unsnapshotted, until the bug is
fixed and the script moves into `tests/graphs/` with a reviewed golden.

## Alternatives not taken

- **Analyzability diagnostics**, a ladder of "cannot trace X, inline it": imprecision
  widens, it never rejects. Only facade siting is enforced.
- **Runtime tracing as an edge source**: the static graph is complete before any node
  runs; the GUI decorates it by site id.
- **Loop containers and bounds in the picture**: the cycle in the arrows is the loop.
  `Region.bound` stays model-only.
- **The actor graph as the GUI's subject**: any quotient by actor destroys temporal order.
- **Certainty-aware reduction**: see "Typed transitive reduction".
- **A may-set step drawn once, spanning lanes**: see "May-set lane expansion".
- **One step per call path** (`ask#3/2`, `Step.callPath`, a `shared` region and a
  duplication cap): the only strong reason for it was resume-after-edit, and amend-resume
  keys its cache by (actor name, ask sequence), which is not positional. Worth revisiting
  only if a helper-called-twice picture misleads a reader.
- **Structural site hashes** for resume-after-edit: same reason.
- **A temporal filter on guard reads**: it would drop real control edges in every
  refine-until-approved loop.
- **Reading a multi-witness await as settle-all**: `Promise.race`.
- **A global barrier for deferred callbacks**: it would make the main line's `await` a
  no-op and downgrade every later `always` edge. Frames are the answer instead: the
  prologue is an ordinary barrier, and it settles nothing for the spawner because it runs
  in the strand's own frame.
- **A strand label in the taint domain**: the walk knows which activation it is in, so the
  concurrency question is answered where it arises. Carrying it as a label would surface
  as data edges, which is the wrong graph for a fact about time.
- **`alongside` as an edge kind**: "an earlier phase is still running here" is not a
  transfer of control, and after folding it is indistinguishable from an ordinary
  successor.
- **A syntactic callback whitelist in the temporal walk**: a walk that guesses from syntax
  which bodies run sends every `.then` callback, named `.map` callback, and
  callback-through-parameter to the sweep, which places them at the end of the script under
  `unphased`: subagents in the wrong phase, the summarizer's ask drawn before the workers'.
  The call oracle knows exactly which bodies each call applies.
- **Merging `source` and `sink`** into one orchestrator node in the actor graph: it draws
  back-edges into the start of the chart.

## Open questions

- A callback that reaches a call other than as a bare parameter identifier (`const h = fn;
  h()`, `{ fn }.fn()`, `fns[i]()`) is still resolved from the merged record, so every caller's
  callback inlines there. The taint placeholders could carry provenance through such flows,
  but a value merged from a parameter and a literal cannot be split exactly without tagging
  each function in the domain with where it came from.

- The certainty of a phase edge is `maybe` whenever any contributing edge is; "any
  `always` witness makes it `always`" is semantically closer on a quotient. Nothing renders
  it, so nothing has forced the choice.
- Mutually exclusive alternatives have no grouping in any graph; "exactly one of these
  runs" is inexpressible.
- Context-sensitive inlining cost: a helper that receives callbacks through a parameter and
  is called from k places inlines k bodies at each call. Acceptable at script scale; the cap
  would go in `inlineBody` if it stops being.
