# Dynamic Workflow: Presentation (spec)

Status: implemented. This document describes how a workflow is drawn, before and during a
run: the display payload the tool hands the GUI, the timeline built from it, the live-run
overlay, and the surfaces that show them. The analyzer that produces the graphs is
`apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md`; the engine that produces the run
events is `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`; the launch
flow around the confirmation window is `docs/dynamic-workflow/launch.md`; the completion
card, notifications and the script transcript are
`docs/dynamic-workflow/transcript-and-notifications.md`.

## What the user sees

A workflow is drawn as one horizontal **timeline**: a rail, with the script's phases as
**stations** on it, the subagents of each phase as **pills** hanging under their station,
and the control-flow edges that skip or loop as **arcs** in the air above the rail. Phases
whose subagents run at the same time stand on parallel **tracks** between a fork and a
merge. The same timeline appears in three places, and all three build it with one pure
function,
`buildWorkflowTimeline(graph, run)` (`packages/ui/src/components/workflow-timeline/timeline-model.ts`):

| Surface | What it draws | Run data |
|---|---|---|
| The `CreateWorkflow` and `AmendWorkflow` tool rows in the chat | while the model is still writing: the phase line alone, written out by a pen; after that a one-line summary | none |
| The confirmation window | the full timeline, static, above the collapsed script | none |
| The run card under the turn (`WorkflowRunDigest`) | the timeline, live: lamps, pills and ink follow the run | `workflowRuns` |
| The run side pane | the same model read vertically as a **spine**: one section per phase, pills as rows, questions under their asker, artifacts at the bottom | `workflowRuns` |

The timeline changes shape during a run in exactly one way: at a **fill**, when the main
agent writes the body of a hole and a new display payload for the effective script replaces
the old one ("Holes on the timeline"). Between fills the set and order of stations, rails
and arcs is fixed; a run only changes lamps, pill status and ink, and can only add pills
(when one card splits into per-instance cards). There is no picture
of the run's end: the last station is the last phase, and nothing marks "may finish here".

Status is never colour alone. Every lamp sits next to a word or an icon with an
`aria-label`, and a `pending` pill is pixel-identical to a static one.

## The display contract

The GUI never sees the analyzer's graphs. A bounding layer in `packages/core`,
`boundCausalityGraph(causality, flow, handoff)`
(`apps/zcode-cli/packages/core/src/tool/handlers/create-workflow-graph-bounds.ts`), folds the
causality graph, the control-flow graph and the hand-off graph into one display payload,
`causalityGraph` (the field keeps its historical name). The same payload rides the
confirmation request's `display` and the tool output that is persisted on the tool row, so
the confirmation window, the tool row and the run pane read one contract. Three schemas
mirror it field for field: `apps/zcode-cli/packages/contracts/src/tools/create-workflow.ts`
(the authority), `packages/shared/src/zcode-protocol-v4/create-workflow-display.ts`, and the
v3 protocol; all are `.strict()`.

```ts
interface CreateWorkflowCausalityGraph {
  steps: Step[];               // ≤ 64: ask / world-read sites; the join key for run status
  lanes: Lane[];               // ≤ 32: actors, plus `workspace` / `unknown`
  participants: Participant[]; // ≤ 64: one card per (phase, lane), in hand-off order
  handoffs: Handoff[];         // ≤ 256: {from, to, back?, types?} between participants
  phases?: Phase[];            // ≤ 32: {id, name?, line?, column?, alongside?}, first-reach order
  phaseEdges?: Edge[];         // ≤ 128: {from, to, back?} between phases
  phaseStreams?: Stream[];     // ≤ 128: {from, to} — phase `from` feeds phase `to` while both run
  exits?: string[];            // phases after which control flow can complete normally
  sink?: string[];             // steps whose artifacts reach the return
  holes?: Hole[];              // ≤ 32: {siteId, name, type, phase?, tail?}, the open holes in source order;
                               // a phase or step written by a fill carries `fill: <hole id>`;
                               // a hole's own phase carries the hole enclosing it
  truncated?: true;
}
interface Step { id; kind: "ask" | "world-read"; label; labelPattern?; line?; column?;
                 lane; lanes?; source?; phase?; repeat?: "stack" | "serial" }
interface Lane { id; name?; namePattern?: { head?; tail? }; line?; column? }
interface Participant { id; phase; lane; steps: string[]; member?: { index; of }; many?: true }
```

Ids are at most 64 characters, names and labels at most 128.

**One arrow.** An edge says one thing, "runs after", and carries one optional mark: `back`
for a loop's back edge. The analyzer's edge kinds, certainty and exactness, its regions and a
step's region and certainty never enter the payload; the GUI draws none of them. Phase
edges are the control-flow quotient (see analysis.md, "The control-flow graph"), so an
arrow between phases answers "where can execution go next", not "which phase must precede
which". Hand-offs are the causality graph quotiented by participant (analysis.md, "The
hand-off graph"). Both are reduced before they are sent.

**Bounding order.** The collections reference each other, so the layer cuts them in a fixed
order and keeps referential integrity over retention: the UI must never receive an id that
points at nothing.

1. Steps: the first 64 in source order.
2. Lanes: only the lanes surviving steps stand in, in graph order, then the first 32. A
   step whose own lane was dropped goes; a may-set step merely narrows.
3. Participants: a card's `steps` narrow to the surviving ones and a card left with none
   goes; then the first 64 in the analyzer's order (the opener survives, the tail does
   not). Hand-offs touching a dropped card go with it, then the first 256; each hand-off
   keeps at most 8 `types`. A dropped card's steps stay in `steps`, so run status still
   joins on them; they just have no card.
4. `sink`: the surviving steps among the analyzer's `fedBy`.
5. Phases: the control-flow graph's phase table, whole, including marker-only phases (a
   position control passes through must show). Phase edges: drop any edge touching
   `entry` or `abort`; an edge into the flow `sink` becomes an entry in `exits`; drop
   self-loops; fold the rest per ordered pair, `back` only when every folded edge was a
   `loop`; then reduce (below). If the phase table exceeds 32 or the reduced edge list
   exceeds 128, the **whole vocabulary** is dropped: `phases`, `phaseEdges`, `exits` and
   every `Step.phase` go together, and `truncated` is set. Half a phase picture would lie.
   A participant whose phase is not listed is re-homed to `unphased`; its id does not change.
6. Phase streams (below): cut at 128 after the phase edges; more than 128 drops the whole
   vocabulary the same way.

`phases`, `phaseEdges`, `phaseStreams`, `exits` and `Step.phase` are all-or-nothing: a script
with no `phase()` marker has none of them, and `exits` may be empty inside the group (a
script with no normal completion path) but never appears outside it. `phaseStreams` is
omitted inside the group when there are none.

**Alongside.** A phase carries `alongside`: the listed phases whose strands were still
running when this phase was entered (analysis.md, "Strands and frames"), in phase-table
order, at most 32 ids, omitted when empty. It is a **node fact**, not an edge. Control did
not pass from those phases to this one; both are simply in flight. So it never enters
`phaseEdges` and never goes through the reduction, which would read it as "runs after" and
cut a real edge in its name. The bounding layer copies it from the control-flow projection
under the same referential integrity the edges get: a reference to an unlisted phase is
dropped, the phase's own id is dropped, the rest are deduplicated in order and cut at 32.
It rides the vocabulary all-or-nothing with `phases`, `phaseEdges` and `exits`.

**Streams.** A stage written as a `future` that hands items to the next stage through a
channel (authoring.md, "Streams") is concurrent with it, so the control-flow view relates the
two only by `alongside` and has no arrow between them: a five-stage pipeline arrived as five
unrelated strands. The **causality** view does see the hand-off: a `send` is a container
write and the `for await` reads it back, so the causality phase quotient carries a `data`
edge from producer to consumer. A **phase stream** `{from, to}` is such an edge whose two
ends are alongside each other (either one's `alongside` lists the other): two live strands
can exchange data only through a shared container, which is what a stream is. A `data` edge
into a phase that is not alongside — the writer after `await Promise.all([...stages])` — is
already the control arrow's business and is not a stream, and two futures with no channel
between them have no `data` edge and stay two strands. The bounding layer reads
`causality.phaseEdges` for kind `data`, drops self-loops, edges touching an unlisted phase and
pairs that are not alongside, dedupes per ordered pair in the analyzer's order, and cuts at
128. A stream is not a `phaseEdge` and never goes through the reduction (the causality
quotient arrives reduced); an arrow still means only "runs after". The analyzer does not see
a feedback channel (a consumer's later `send` into a producer's channel follows the
producer's read in walk order), so every stream it produces today points from an earlier
strand to a later one; the UI draws whatever direction arrives.

**Untyped reduction.** The folded phase edges are fed to the analyzer's `reduceOrdering`,
exported for exactly this purpose: every forward edge as one kind, every back edge as a
carry. That turns the typed reduction into an untyped one, which is what a single arrow
style needs: the drawn set is an irredundant generating set of the "runs after" relation,
reachability unchanged, no forward edge implied by a path of length two or more, no back
edge implied by forward → one back hop → forward, back edges never serving as witnesses.

It reduces the **condensation**, not the graph itself
(`create-workflow-graph-fold.ts`). Take the strongly connected components of the folded
forward edges — back edges are excluded, because they say "next round", and counting them
would shrink a whole loop body to one point and leave its genuinely redundant edges
undeletable. An edge whose two ends share a component survives unconditionally; only the
inter-component edges are reduced, deduplicated per component pair and kind, and the
survivors are expanded back over the raw edges. A witness that passes through a node
sharing a cycle with either endpoint asserts nothing about whether control can reach the
target directly, so it may not delete an edge. Two independent choices reusing the same
pair of phase names are the case that forces the rule: the quotient carries `left → right`
and `right → left` as ordinary branch edges, and reducing the raw graph deletes
`choose → left` on the witness `choose → right → left`, drawing a picture that says the
branch always goes right and `left` is a detour off `right`. Interleaved phases (`a; b; a`)
are one component for the same reason and keep their forward edges both ways. Hand-offs
arrive already reduced by the analyzer and are only truncated here.

**Text.** Names, labels and pattern affixes come from script literals, so they are cut with
a surrogate-safe slice: a boundary that lands after a high surrogate drops the half
character. An empty actor name or phase name becomes an absent `name` (the UI localizes
the fallback); an empty ask label falls back to the step id; a pattern whose affixes are
both cut away is omitted rather than sent as `{}`.

**Old payloads.** The schema is strict and has no compatibility shim. A persisted display
that carries fields the schema no longer knows fails `safeParse`, and the tool row falls
back to plain text with no graph. That fallback is now the *whole* cost of an unknown field:
since 2026-09-21 the v4 envelope carries every display payload as
`.optional().catch(undefined)`, so a payload this side cannot read is dropped and the frame is
still delivered (`docs/v4-refactor/10-protocol-spec.md` §4.4.5). Before that, a strict display
failure rejected the entire frame and took the subscription down with it — twice, for one added
key each time. Two exceptions are handled, both by the same pre-parse
scrub in `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts` that the two
parse entry points share. Displays persisted while the withdrawn name-refinement feature
existed carry `refinedName` on lanes and phases and `refinedLabel` on steps, and those three
keys are stripped. Persisted `get_workflow_run` displays carry `providerStop` on their
`error`, written while the card reused the tool output's error schema, and that key is
stripped too.

**Who reads what.** `phases` and `phaseEdges` become stations, rails and arcs,
`alongside` becomes bands, and `phaseStreams` become stream rails and take strands out of
their band. `participants` become pills, in payload order. `steps` and `lanes`
are the join key and the naming material. `sink` decides whether the implicit phase of an
unmarked script counts as an exit.
`handoffs` and `exits` are transported and validated but no component reads them today
(see "Open questions").

## The timeline model

`buildWorkflowTimeline(graph, run)` is a pure function with no React, no DOM and no clock.
Its output:

```ts
interface WorkflowTimelineModel {
  stations: TimelineStation[];   // one per phase, declared order
  rails: TimelineRail[];         // two stations next to each other on one track
  arcs: TimelineArc[];           // every other edge
  bands: TimelineBand[];         // parallel phases, ascending by `from`; empty without `alongside`
  runningIndex?: number;         // the running station (rightmost if several)
  live: boolean;                 // a run took part
  draft?: { agents: number };    // only the pen's model has this
}
interface TimelineStation { id; naming: { id; name? }; pills; status?; visited; rounds; onLoop; track; fraction?; typing? }
interface TimelineRail  { from; to; ink; kind?: "fork" | "merge" | "twin" | "stream" } // absent kind = a plain rail on one track
interface TimelineArc   { from; to; lane; ink; air; stream? }                 // `air` = whose track's air it flies in
interface TimelineTrack { stations: number[]; entry: TimelineInk; exit: TimelineInk }
interface TimelineBand  { from; to; pred?; join?; tracks: TimelineTrack[] }   // inclusive range; tracks[0] = the main line
interface TimelinePill { key; lane: LaneRef; laneClass; runtimeName?; avatarIndex?; status?;
                         instance?: { siteId; ordinal; sessionId? }; slot?: { siteId; ordinal };
                         workspace?: { phaseId }; stepIds; asking? }
type TimelineInk = "faint" | "strong" | "march";
```

**Cost.** The model is linear in the run: one pass indexes the listed nodes by
`(actorSiteId, actorOrdinal)` and every card reads that index instead of re-scanning
`run.nodes`, so a build costs O(actors + nodes) and never their product — at the table
bound of 1024 actors and 1024 nodes the product is a million comparisons per frame. The
model is also built **once per `(graph, run)` pair** and shared by every surface: the graph
and the run state are immutable protocol objects (a changed run arrives as a new object),
so `buildWorkflowTimeline` memoizes on their identity and the second surface of a frame —
the run card and the run pane draw the same run side by side — pays a lookup, not a build.

**The implicit phase.** A script with no markers has no phase vocabulary. The UI gives it
one phase, id `workflow` (localized "Workflow"), before anything else: every step and card
is re-homed to it, there are no phase edges, and `exits` is `[workflow]` when the script
returns something. `withImplicitPhase` returns a graph with a vocabulary unchanged
(reference-equal, so memoization holds). The analyzer's own `unphased` (localized
"Ungrouped") means "before the first marker" and is a different phase.

**Stations** are the payload's `phases` in declared order, which is the order of first
`phase()` markers. There is no ranking: two sibling phases that share only a predecessor
stand in declared order, and the edge between them becomes an arc — or, when the two are
parallel, nothing at all, the fork having said it already.

**Rails and arcs.** Each phase edge whose endpoints are both listed and distinct is folded
once per ordered pair and becomes a rail or an arc; the classification is below, the rails
first and then what a band does to the edges that touch it. An arc is a **back edge** when
its target is to the left of its source; the payload's `back` mark is not consulted, because
the analyzer classifies a re-entry (a second `phase("plan")` marker) as a forward edge and on
the timeline it still points left. A station is `onLoop` when it is the source or target of
a back edge, and every member of a band is `onLoop` when a back arc touches the band; only
such stations show a round count.

**Bands and tracks.** `foldPhaseBands` (`timeline-bands.ts`) turns `alongside` into the
picture. It works on station indexes alone, with no ids, no ink and no pixels, so the
sidebar's mini rail shares it (see "The sidebar run line"). The relation is symmetrized
first: only the later phase can report the earlier one, and on screen the two are equals.
Connected components with two or more members give the intervals `[min, max]`; overlapping
intervals merge, and every index inside an interval is a member, gaps closed for robustness
(they do not occur without loops). A **band** is one such interval. Its members are split
into **tracks** by greedy interval colouring in declared order: each member takes the lowest
track none of whose members is parallel to it, else opens a new one. The first member
therefore always takes track 0, the **main line**. A station outside every band has
`track: 0`.

**Streams take strands out of the band.** With `phaseStreams` (see "The display contract"),
two members are parallel *for the colouring* only when neither reaches the other along stream
edges: a stage and every stage downstream of it are one line of work, however concurrently
they run, and belong on one track in declared order. A band whose members all land on one
track is **dissolved**: it is not a band, its stations stand on the main line with no fork,
no merge and no twins, and they are joined by the rails below. A five-stage pipeline is
therefore five stations in a row. A strand no stream reaches (a side future) still takes a
track of its own, and the band stays a band around it. `foldPhaseBands` takes the streams as
an optional third argument; the sidebar's mini rail passes none, so its bands are the
`alongside` bands (see "The sidebar run line").

A band's `pred` is `from − 1` and its `join` is `to + 1`, each only when that station stands
outside every band and an edge runs from it into a member, or from a member into it. Two
bands standing next to each other have neither; what lies between them is a plain rail.

**Rails.** A rail joins two stations that stand next to each other on one track. There are
five kinds:

1. two adjacent stations outside every band with an edge between them, as before; two
   adjacent stations with no edge have no rail, and the rail never lies;
2. two consecutive members of one track, **unconditionally**: a track is one strand, and the
   edge between two of its members may have been reduced away — in an overlap chain `A → C`
   stands for `A → B → C` with B on the other track, and the strand would otherwise break;
3. `pred` → the first member of each track, plain for track 0 and `fork` above it;
4. the last member of each track → `join`, plain for track 0 and `merge` above it;
5. `twin`, between two declared-adjacent members of one band that sit on different tracks.
   Only the ledge and the sidebar read a twin; the card and the spine never draw one, and it
   never marches. It says "these two are parallel", not "control went this way".
6. `stream`, for a phase stream between two stations that stand next to each other on one
   track: two adjacent stations outside every band (a dissolved band's, typically), or two
   consecutive members of one track. It replaces the plain rail of the same pair. It says
   "feeds, while both run", not "runs after".

A phase stream that is not adjacent on one track becomes an **arc** with `stream: true`: in
that track's air when both ends share a band track, else in the top air. A stream between two
tracks of one band is not drawn; the fork and the merge already say the two run together.

A track's `entry` is the ink of its fork, or, with no `pred`, strong iff its first member is
visited; its `exit` is the ink of its merge, or, with no `join`, strong iff its last member
is visited. The spine inks the branches of its fork and merge rows from those two.

**Edges with bands.** A band is one node to an edge. For a folded edge `(f, t)`, with `B(x)`
the band of `x`:

- **same band, same track**: consecutive on the track → nothing, the strand already says it;
  otherwise an arc in that track's air.
- **same band, different tracks**: a forward edge is dropped, because the fork already said
  control passed through both; a back edge becomes the band's self-loop, an arc re-rooted to
  `from = B.to`, `to = B.from`.
- **one end in a band**: absorbed as the `pred` or the `join` when the outside end is
  adjacent to the band; otherwise an arc re-rooted to the band's last station when it leaves
  and its first station when it arrives, in the top air.
- **two bands**: an arc from the first band's last station to the second band's first
  station, or a plain rail between them when the two bands stand next to each other.
- **both outside**: a rail when adjacent, else an arc, as before.

Arcs are deduped per air and endpoint pair after the re-rooting. An arc's **air** is the
track whose air it flies in: an arc inside one track stays in that track's air, everything
else goes to the top one, `R − 1` for `R` the largest track count of any band and at least 1.
Without bands there are no bands to fold, every station has `track: 0`, every arc `air: 0`,
and the rails are the ones the old rule produced, rail for rail.

**Arc lanes.** Arcs are assigned heights by greedy interval colouring (`assignArcLanes`):
sorted by span, shortest first (payload order breaks ties), each arc takes the lowest lane
on which no already-placed arc intersects it in station index, intersection counted on
closed intervals (two arcs sharing an endpoint would merge their vertical segments). Arcs
that do not touch share a height; nested arcs stack inner-low, outer-high; only arcs that
cross are pushed up. Lanes are assigned **per air** (`assignAirLanes`): two arcs that fly in
different airs never push each other up, however much they cross in x. `arcLaneCount` is the
highest lane plus one, asked per air, and sets how much air the renderer leaves above that
track's row. Lanes keep two arcs that share a station apart in height; the terminal slots
(see "Rails and arcs" under "Drawing the timeline") keep their verticals apart in x.

**Pills.** The pills of a station are that phase's participants from the live participant
view (see "Splitting cards by instance"), in payload order, which is hand-off order with the
opener first. The main agent's lane (`main`) never makes a pill: its only steps are open
holes, and an open hole is drawn as its own station (see "Holes on the timeline"), not as a
subagent of the phase that holds the `hole()` call. A pill's name is the runtime name the engine reported for its bound instance
when there is one, otherwise the lane's display name (see "Names"). `avatarIndex` is
assigned by first appearance of `lane@ordinal` across the whole timeline, so the same
subagent keeps its face across phases and the first nine subagents never share a colour.
In a live run an agent pill carries `slot`, the identity it hands over when clicked: the
instance's ordinal when there is one, otherwise the ordinal it will get, `member.index + 1`
for a member card and 1 for a single or `many` card (the engine numbers ordinals per site
in order). A workspace pill carries `workspace: { phaseId }` instead. A pill is `asking`
when `run.pendingQuestions` names its instance.

**Run entry records.** A station is matched to `run.phases[]` by **name**: exact match
first, and when the display name is exactly 128 characters (the bound), a prefix match on
the runtime name (`phaseNameMatches`, `phase-name.ts`). The same rule decides whether a
station is `run.currentPhase`. A phase with no name (`unphased`, `workflow`) never matches.

**What a station observes.** `observePhase` walks `run.nodes` and keeps those whose site id
is one of the station's member steps (`step.source ?? step.id`, the same key the overlay
uses) and whose birth phase belongs to this station (see "Narrowing by phase"). From them:
`visited` (any node, or an entry record), `rounds` (the largest node ordinal, or the entry
record's `rounds`, whichever is larger), and `fraction` = settled / observed, absent when
nothing was observed.

**Station status.** A **stage** — a station with any `alongside` partner or any stream,
and at least one member step — takes its lamp from its own nodes and from the stages that
feed it, never from `currentPhase` or its entry record. Every stage future runs its marker
the moment it starts, so "entered" and "current" say nothing about it: in the triggering
run all five markers ran within 108ms, a stage still waiting on its channel read `done`,
and the last stage (the one `currentPhase`) took the run's final state without having run
a node. The stage rule:

1. no node observed: `pending` while the run is `pending` or `running`; after it ends,
   `done` when the run `completed` and the station was entered, else `pending`;
2. else the fold's value, except that a `done` stage stays `running` while the run is live
   and a stage feeding it (a stream source) is **open**. A stage is open while the run is
   live and it is `running` or `pending` by the fold (no node counts as pending), or a stage
   feeding it is open — a fixpoint, so a feedback cycle terminates.

A station that is not a stage, or a stage with no member steps (a marker-only phase), keeps
the sequential rule. Member nodes speak first, then control flow:

1. If the member steps fold (see "Folding statuses") to `running` or `failed`, that.
2. Else if the station is `currentPhase` and the run is `pending` or `running`: `running`
   (control flow is here between the first dispatch and the next marker).
3. Else if it is `currentPhase` and the run has ended: `done` for `completed`, `failed`
   otherwise (the failure happened in this phase whether or not it has nodes; a stopped run
   draws like a failed node).
4. Else the fold's value if it has one.
5. Else `done` if the station was entered, `pending` otherwise.

Without a run every station is `undefined`, every pill `undefined`, every rail and arc
`faint`, no rounds, no fractions.

**Ink.** A rail is `strong` when both its stations are visited, else `faint`. A back arc is
`strong` when its source is visited and its target has `rounds ≥ 2`; a forward arc when both
ends are visited. A stream rail or stream arc is `march` when both of its stations are
`running` (items are crossing now), else `strong` when its target is visited (something
crossed), else `faint`. A stream arc is not a loop: it never makes a station `onLoop`.

**March** is the ink of the edge control flow took into a running station, and it is decided
once per running station rather than once for the timeline: two tracks of one band can be
running at the same time, and each wants its own way in. For a running station `r`:

1. a re-entry back arc landing on `r`, or on `B(r).from` when `r` is in a band, with a
   visited source and `rounds(r) ≥ 2`, marches, and nothing else into `r` does;
2. else every non-twin rail into `r` from a visited source marches, so a join gets its
   main-row piece and every merge, and the first member of a branch gets its fork;
3. else one arc landing on `r` from a visited source.

Stream rails and stream arcs take no part: their ink was decided above and says whether
items are crossing, not which way control came.

`runningIndex` is still the rightmost running station; it is what the camera follows, not
what marches. The projection has no timestamps, so this is the most honest answer available
and a known approximation.

`pillActivity(graph, run, pill)` counts a pill's ask steps and world-read steps and names
the step that is running (else the last settled, else the first); the pane shows the
counts, not the label.

## Joining runtime instances

The analyzer never learns from a run. The engine reports instances `{siteId, ordinal}`, and
the GUI decorates the static picture by site id (analysis.md, "Joining runtime instances").

### Node status

`statusOfRunNode` maps a node's lifecycle phase to the four-value `StepRunStatus`:

| Node phase | Status | Why |
|---|---|---|
| `executing`, `repairing`, `nudged` | `running` | a model request is out |
| `settled` with outcome `ok` (cached included) | `done` | |
| `settled` with outcome `failed` or `cancelled` | `failed` | the journal tells them apart; the four-value picture does not |
| `queued`, `dispatched`, `waiting` | `pending` | no request is at the provider yet |

### Folding statuses

`aggregateRunStatuses` is the only fold, applied to a multiset of instance statuses:

- an empty set folds to `undefined`: **absence is not a status**, and no fold invents one;
- any `running` → `running`, deliberately ahead of `failed`: the reader most needs to know
  whether anything is still moving;
- some settled and some queued → `running`: started, not finished;
- all queued → `pending`;
- all settled → `failed` if any failed, else `done`.

All four rules are "any" tests, so folding per site and then per participant gives the same
result as folding the instances directly. `collapseStatuses(stepIds, table)` collects the
entries that exist and folds them; a step with no entry does not take part.

### The overlay

`workflowRunOverlay(run, graph)` (`components/workflow-graph/run-status.ts`) returns a
**partial** table `statuses: Partial<Record<stepId, StepRunStatus>>`: a step no instance was
observed for has no entry. "Never ran" and "queued" must not share a value; when they did, a
branch whose other arm never runs (a ternary receiver, an `if` without `else`, a skipped
`catch`, an unselected may-set copy) dragged its whole station to `pending` after it had
finished.

Each step becomes a target keyed by its **site id**, `step.source ?? step.id`. A may-set
copy (`ask#2~actor#1`) and a phase copy (`ask#1~phase#3`) share a site with their siblings,
so a node found by site id is admitted to a target only if it passes that target's claims:

- **lane**: a copy with `source` admits only nodes whose `actorSiteId` equals its lane. A
  node with no `actorSiteId` is admitted to every copy of the site (over-lighting, never a
  dark picture). A step without `source` makes no lane claim: the single card drawn for a
  receiver with more than four candidates may run on any of them.
- **phase**: a step with `phase` admits only nodes whose birth phase belongs to that phase,
  decided by the phase binder below.

A node whose site id is not in the graph is ignored; the overlay never adds or removes
nodes. `animatedEdges` is true when any step is running.

### Narrowing by phase

The engine stamps every node and actor with `phaseName`, the name of the phase current when
its ordinal was minted (the moment `agent()` or `.ask()` ran, not the moment the event was
emitted). The name is the one vocabulary the engine and the analyzer share. `phasesOf(name,
graph, runHasVocabulary)` (`instance-phases.ts`) says which display phases a stamp belongs to:

| Stamp | Run has any stamp | Belongs to |
|---|---|---|
| present | — | the phases whose display name matches (`phaseNameMatches`) |
| absent | yes | the nameless phase (`unphased` or `workflow`): the analyzer puts pre-marker steps there too |
| absent | no | every phase (an older CLI, an older run, an unmarked script) |

Whenever the answer would be empty, it is every phase: better a subagent shown twice than a
running subagent hidden. `phaseBinder(graph, run)` caches these answers and, when the graph
itself has no phases yet, answers "belongs" for everything. The binder is shared by the
overlay, the participant view and the station observation, so the three never disagree.
Without it a helper called from five phases that fans out twenty subagents each lit all five
stations when the first batch ran.

### Splitting cards by instance

`liveParticipantView(graph, run)` (`participant-model.ts`) is the one place a card meets its
instances. A card's instances are the actors on its lane that left a node on **this card's
sites** with a stamp in this card's phase, plus actors that left no node on those sites yet
and whose own birth stamp belongs to this phase, sorted by ordinal. On a run with no stamps
this reduces to "every actor on the lane", the older behaviour.

| Card | Instances | Result |
|---|---|---|
| `many` (family of unknown size) | 0 | the card stays, status by step fold |
| `many` | ≥ 1 | one card per instance, id `${id}@${ordinal}`; hand-offs copied to each |
| single | 0 | the card stays |
| single | 1 | the card **binds** the instance: id unchanged, runtime name shown, status by step fold |
| single | ≥ 2 | split like `many`: runtime multiplicity beats static multiplicity |
| member `[i]` (literal fan-out) | — | binds the i-th instance by ordinal; none yet → `pending`; instances past `of` get no card |

A bound or split card's status is folded from that instance's nodes on the card's sites
alone, and an instance with no node there yet is `pending`. A workspace card has no
instances and never moves. A run that ended is replayed from the journal, so a reopened
session still shows runtime names.

### Names

Site ids are identity; names are presentation, and no name is ever a site id. A lane's
display name (`laneDisplayName`, `lane-name.ts`) is, in order: the fixed word for a
synthetic lane ("Script" for `workspace`, an "unresolved" label for `unknown`); the author's
literal `agent("planner")` unchanged (localizing it would rewrite the author); the name
pattern rendered as `head…tail` for an interpolated name; else "Anonymous Subagent", numbered
`… N` only when two or more anonymous agent lanes coexist, in lane order, patterned lanes
not counted. A phase's display name is its `name`, else the localized word for `unphased`
or `workflow`. Localization happens at render time, never in the memoized model: the user
may switch language mid-session. A pill shows the runtime name over all of these.

## Drawing the timeline

`WorkflowTimeline` (`components/workflow-timeline/WorkflowTimeline.tsx`) is plain DOM plus
one SVG layer for the arcs. There is no canvas library.

### Geometry

| Constant | Value | Meaning |
|---|---|---|
| `STATION_WIDTH` / `STATION_GAP` / `STATION_PITCH` | 168 / 24 / 192 | five stations fit a 960px column |
| `MARK_X` | 17 | lamp centre from the station's left edge, over the pills' face column |
| `RAIL_ROW` | 24 | height of the rail row |
| `ARC_BASE` / `ARC_LANE` | 26 / 14 | lowest arc lane above the rail's centre; lane spacing |
| `TERMINAL_PITCH` | 10 | distance between two arc terminals on one lamp |
| `PILL_HEIGHT` / `PILL_GAP` | 32 / 6 | |
| `PILL_STAGGER_MS` | 30 | delay between pills landing |
| `PLATFORM_ROW` | 24 | height of the caption row; only a banded timeline has one |
| `CAPTION_X` | 12 | a caption's left edge from its station's left edge |
| `TAIL` / `STUB` | 4 / 6 | the main line's tail before a band with no `pred`, its stub after one with no `join` |

`ARC_BASE` must leave room after the 8px corner radius for a downward run long enough to
hold the 5.25px arrowhead; at 16 the last segment pointed up by a pixel and the arrowhead
vanished.

**The rows.** `timelineLayout(arcs, bands)` lays the picture out from the top down and is
pure, so `timelineHeight(model)` can be had without rendering: the run card animates its
frame between two of these values. There are `R` track rows, 1 without bands and otherwise
the largest track count of any band, at least 2. For each track from the top down the layout
leaves that track's **air** — 6px for the top row when that air holds no lanes, 0 for the
others when theirs holds none, else `8 + 26 − 12 + 14 × (lanes − 1)` counted over the arcs of
that air alone — and then a 24px row with the rail down its middle. The main line is
therefore the bottom row. After the rows comes the platform row, 24px, only when there is a
band; then 8px, the tallest pill column, and 8px for the scrollbar. The whole rail shifts
right by an **inset** of 12px when a band starts at station 0, so that the fork has somewhere
to stand. Without a band `R` is 1, there is no platform row, and the arithmetic is the old
arc air + 24 + 8 + pills + 8 to the pixel.

### The station head

A station head is a pill with no background: the lamp (10px) over the faces column, the name
(`text-ui-caption`, medium) over the names column, then the metadata in mono: `⟳ n` when the
station is on a loop and has rounds, a `·`, and `settled/observed` when nodes were observed.
A pending station's name is subtle; others are foreground. The head's `title` is the name,
plus "visited n times" on a loop station.

Lamps use one vocabulary, `STATUS_DOT` (`run-status-presentation.ts`):

| Status | Lamp |
|---|---|
| `pending` | hollow ring, 1.5px `foreground-subtlest` border |
| `running` | filled `warning` with a steady 3px warning halo, beating (below); the only glow on the page |
| `done` | filled `success` |
| `failed` | filled `destructive` with a 2px destructive ring |

**The beat.** The running lamp is the one thing on the timeline that moves on a clock, and it
carries the whole statement "work is happening here". `wf-lamp-running` holds the 3px halo
steady at 20% warning and beats every 1.6s (`--wf-beat`, declared beside `--wf-ease` on
`.wf-motion`): the lamp thumps to 1.12×, peaking at 12% of the beat and back at 40%, and
sends out one ring, a second shadow layer born at the halo's edge at 35% warning that widens
to 8px past the lamp and fades to nothing by 70%, then rests. The halo never leaves, so the
lamp is lit between beats and the ring is the lamp's own light rather than a second glow. The
spine's lamp and the ledge's folded lamps carry the same class and beat with it.

`running` is `warning`, not `primary`: primary inverts across themes and reads as emphasis;
warning is the activity colour in both. Run-level lamps derive from the same table:
`RUN_STATUS_DOT` maps `completed → done`, `errored → failed`, and `pending` and `stopped` to
the hollow ring (a stopped run is recoverable, not broken). The status word beside a run
lamp uses matching text colours and, for `stopped`, appends the reason: "by you", "by the
agent", "model error", "process exited". A run whose state carries `resumable: true` appends
a third word after the reason, "resumable" / 「可恢复」: the verb on the button says what the
action does, not what survives it, so the status line carries the consequence. It is the
CLI's status bit, shipped on the run, never derived in the UI from the status word.

When the host passes `onSelectStation` the head is a `<button>` (hover: name to foreground,
lamp halo in its own colour) and opens the run pane. Otherwise it is a `<span>`, not a
disabled button: browsers do not dispatch `click` on disabled controls, and the run card
relies on the click bubbling to its whole-card toggle.

### Rails and arcs

A rail is a 1px `foreground-subtlest` top border between two station heads, the `march` rail
included: `wf-rail-march::after` lays a still 1.5px gradient over that border, transparent at
the far end and full warning from 80% of the way along, reaching 4px past the rail's end so
the light touches the halo. Arcs (`WorkflowTimelineArcs.tsx`) are paths `M x_a, railY−7 V lane+8 Q … H … Q …
V railY−9`: up from the source lamp, an 8px quarter-round into the arc's lane, across, down,
stopping 9px above the rail so the 6-unit arrowhead sits on the target lamp.

**Terminal slots.** Where an arc meets a lamp is a **terminal**: its takeoff at the source, its
landing at the target. A station's terminals take slots `TERMINAL_PITCH` (10px) apart,
centred on the lamp (`arcTerminalOffsets`, `timeline-geometry.ts`), so a station with one
terminal keeps the lamp's centre. The slots run left to right: first the terminals whose arc's
far end lies to the left of the station, then those whose far end lies to the right; on each
side the arc in the lowest lane stands outermost, ties broken by arc order. Takeoffs and
landings are treated alike. The reasons:

- An arc's riser and horizontal make an L that opens toward its far end. Leftward Ls on the
  left and rightward Ls on the right stand back to back and never meet.
- On one side, the arc in the lower lane turns away lower. Standing inside, it would put its
  horizontal across the riser of the higher arc beside it; standing outside, its horizontal
  starts beyond that riser. This is the lane rule's closed-interval argument turned ninety
  degrees. Two arcs with a lamp terminal at one station fly in one air and share that station,
  so their lanes always differ.

With takeoffs at the lamp's centre and only landings spread, a station with an arc in and an
arc out drew the outgoing riser through the incoming arrowhead: two verticals fused into one
line with the arrowhead part-way up it (the 支路甲 and 支路乙 stations of the testfield stress
script). Two terminals now sit on the lamp's edge, and three or more reach past it. Two arcs
whose spans interleave still cross, as a horizontal over a vertical.

Stroke is `--color-workflow-trace` for faint and `--color-workflow-trace-strong` for strong; a
`march` arc is drawn strong with a lit path over it, the arc cut 6px short so the light stops
at the arrowhead's base. A new arc draws itself from source to target in 420ms (`pathLength=1`,
so the reveal is geometry-independent); later ink changes are colour transitions.

**The march edge.** Nothing moves along the edge into a running station. The march edge
records the past — control took this edge — and the lamp records the present — the work is
here — so the motion belongs to the lamp; anything travelling the edge reads as a run still
on its way between two phases, which is the one thing it does not mean. The edge is given
light instead: the lamp's own colour, brightest where it meets the lamp and fading toward
where control came from, as if the lamp lit the way it came in. On a rail that light is the
gradient above; on an arc, on a band's fork and merge curves, and on the spine's curves, it
is one `wf-lit` path laid over the base path (`MarchLight`, `WorkflowMarchLight.tsx`): 1.5px,
round caps, stroked with a `userSpaceOnUse` linear gradient from the path's first point to
its last, warning at zero opacity at the first point and full warning from 80% on. The
gradient runs along x, which is what these paths do but for two short risers.

### Stream rails

A stream rail (`kind: "stream"`) is the ordinary rail, cut at the middle of its visible span by
a 22px gap that holds three **chevrons** `›››`: 5px apart, each 2.6 × 6.4, stroke 1.35 with
round caps and joins, pointing along the stream (`WorkflowStreamChevrons.tsx`). On the station
row the span is the rail's own flex box, the line drawn as a `::before` gradient with the gap
cut out (`wf-rail-stream`), so the chevrons sit on nothing; the box is at least 42px wide,
which leaves about 10px of line on each side of the chevrons. In the band's SVG the rail path
is two strokes with the gap between them. A stream arc is drawn as an arc (arrowhead
included), its horizontal cut the same way around a chevron group at its middle, pointing the
arc's way.

The chevrons carry the ink. `faint` (nothing has crossed yet) is `workflow-trace`, `strong`
(something crossed, nothing crossing now) is `workflow-trace-strong`, and `march` (both ends
running: items are crossing) is `warning`, the three chevrons lighting one after another in
the direction of flow (`wf-stream-flow`: opacity 0.3 → 1 → 0.3 over 1.2s, 0.15s apart). The rail
itself keeps the rail's colour and never moves, and a stream never gets the march light.

Motion is allowed here and nowhere else on an edge. A march edge must not move because
motion along it reads as "control on its way between two phases", which a march edge never
means; a flowing stream means exactly that — items are travelling from one stage to the
next right now — so its chevrons move, and only they do. Why chevrons: the ledge's stubs,
the sidebar's twin segment and the leaders already use doubled and dotted lines; a chevron is
the one mark that says direction without an arrowhead and reads in monochrome at 1px. Three,
not a row along the whole rail: the rail stays a rail and the chevrons stay a label.

### Bands on the card

Without a band nothing above changes. With one, the rails move into the SVG layer beside the
arcs, because a fork and a merge are curves and a border cannot draw them.

The main line is the bottom row, directly above the platform row, and branch tracks stack
above it. Lamps stay DOM spans — the status classes, the halo and the beat live in CSS
— absolutely positioned on their own track's row at their station's left edge + 17. The
station heads move to the platform row at their station's left edge + `CAPTION_X`, 156px
wide, keeping their name, their metadata and their `<button>`-or-`<span>` semantics. A branch
phase gets a **leader** joining its lamp to its caption: 1px, dotted 1 on 2 with round caps,
in the trace colour, from 7px below the lamp to 10px above the caption row's centre line. A
main-line phase has none, its caption already standing under its lamp. Leaders and lamps fold
with their station.

A band forks at `forkX`, 16px before its first station's left edge, or at 4px when the band
starts at station 0. Branch track `t` leaves the main line 8px earlier for each track above
the first, rises to its own row through two 8px quarter-rounds, and runs on to 8px before its
first lamp. A band merges at `mergeX`, 10px before the join's left edge, or 6px past the last
station's slot when there is no join; branch track `t` turns down 8px earlier for each track
below the top one and lands back on the main line, the mirror of the fork. Without a `pred`
the main line grows a 4px `TAIL` before the fork point; without a `join` a 6px `STUB` after
the merge point. The model has no rail for the branch curves of such a band, so they are
drawn from the tracks' `entry` and `exit` ink.

A rail inside one track is a straight segment from lamp + 8 to lamp − 8 on that track's row;
a stream rail on a track is that segment with the chevron gap in it.
The main row's rails run through the fork and the merge points, so the main line reads as one
straight line; a plain rail whose two ends lie in different bands is that line's piece
between the first band's merge point and the second's fork point. A marching rail is lit
along its own path by the same component the arcs use.

An arc crosses at its lane's height in its air, but takes off from its source's own row and
lands on its target's own row. A source inside a band takes off from the merge point on the
main line, 3px above it; a target inside a band is landed on at the fork point on the main
line, 4px above it. A station takes off 7px above its lamp's row and is landed on 9px above
it. A band-level arc therefore passes the branch rows on its way up and down, in the columns
those rows leave empty. An arc leaving a band rises along the merge column itself, so its
riser overlaps the top track's merge vertical; that is the reading intended, the loop leaving
from where the strands met. A lamp's terminals still take slots (see "Rails and arcs"); the fork
and merge points take none, and the arcs re-rooted there do not count toward the slots of the
station whose index they carry. A fork is a point and not a row of lamps: only landings meet
it and only takeoffs leave a merge, so risers sharing one of those columns never stand over an
arrowhead.

A collapsed card keeps the tracks and the platform row and drops only the pills.

### The pill

`WorkflowAgentPill` is the one subagent pill, on the card and in the pane: 32px tall,
`rounded-full`, `bg-surface`, the lane glyph, the name, optional children (the pane's
counts), and a 14px **tail slot**. The status mark lives in the tail: a spinning ring for
`running` and a check for `done`, both in neutral `foreground-subtle`; a destructive cross
for `failed`; nothing for `pending`. When the pill can be opened, an `↗` shares the same grid
cell; on hover the mark scales out and the arrow scales in, so a status mark and an arrow
never fight for width. The `row` size (24px, no resting background, glyph 14px) is used by
the pane's roll.

A pill is a `<button>` exactly when the host gave it a callback and it has a handle: an agent
pill with `slot` opens that subagent's transcript tab whether or not the subagent has
started; a workspace pill with `workspace` opens the script transcript landed on its
station. Otherwise it is an inert `<span>` with no hover state. Hover on an openable pill:
background one step up, a 1px inner stroke in the face's colour at 35%, the face enlarged,
the name to foreground; press scales to 0.985; `focus-visible` adds a 2px ring. A workspace
pill has no hue and its stroke falls back to the border colour.

### The Tile face

A subagent's avatar is a code-drawn SVG, `WorkflowAgentFace`: the app icon's rounded square
(a 20×20 viewBox, radius 7) without its Z, with two eyes. The body colour is identity: nine
fixed colours (`FACE_COLORS`: teal `#54B9A6`, amber `#F19D38`, indigo `#6464EF`, violet
`#885CF5`, blue `#3C82F6`, orange `#ED712E`, pink `#EB4699`, green `#5BC67A`, red
`#EA4045`) taken by `avatarIndex`, cycling from the tenth; without an index the name is
hashed onto the same palette. Eyes are white. The pill's hover stroke uses the same
`agentColor`. A face is never smaller than 20px.

The expression is state (`faceState`):

| Pill status | State | Resting eyes | Motion |
|---|---|---|---|
| `pending` / none | waiting | three dots | the dots lift left to right and settle, then pause 1.5–3s |
| `running` | scanning | two upright pills | blink 2–3 times, glance to the other side, pause 1.5–3.5s; occasionally a focused or confused look |
| `done` | content | happy arches | hop 2–3 times, one short blink as pills, back to arches; pause 6–10s |
| `failed` | sad | downcast arches | float 1–2 times; about 40% of the time a burst of 3–5 angry shakes, then back |

Motion runs on the SVG's own timers and attributes (`data-motion`, `--wf-face-x`), never
through React state, and stops when the tab is hidden, the face leaves the viewport, or
`prefers-reduced-motion` is set; the resting expression stays, because it is information.

### Past six participants

A station with more than six participants (`ROSTER_THRESHOLD`) does not list them all.
`stationRoster(pills, { pins })` (`roster-model.ts`) splits them into **pinned** and the
**rest**, and every surface uses the same split. Pins, five on both the card and the pane,
are filled in this order and never left empty: asking (has a pending question), then
running, then failed, then participant order. Running carries no limit of its own: within a
bucket participant order holds, so a running pin is only given up when that participant
stops running, and the pins therefore change one at a time. A settled run has no asking and
no running pill, so the same order reads failed, then participant order, by itself. When a
participant changes bucket the pins are refilled; that is the only reordering during a run.

A station's participants are its pills, and at a bound the run's tables no longer hold them
all: an agent the reducer refused or evicted ("Reduction") has no pill, no face in the deck
and no transcript, and it still belongs to this station. The timeline model therefore carries
`station.unlisted` — `{actors, settled, failed, nodesSettled}`, summed over the
`unlistedByPhase` buckets whose birth phase binds to this station through the same
`phaseBinder` join that places the pills and counts the nodes, so the unphased bucket lands on
the station that already receives unstamped instances. The four numbers are the bucket's
`actors`, `actorsSettled`, `actorsFailed` and node `settled`, an absent subkey reading zero.
The roster counts them without listing them, through `stationRosterOf(station, pins)`: the
threshold is judged on listed plus unlisted, so a station left with four pills and three
hundred unlisted agents is a roster still; the total and the "{n} more" count add `actors`.
Only `settled` of those agents are known to have finished, so the tally and the meter add
`settled − failed` to done and `failed` to failed — which is also what the red `✕ n` behind
the row counts — and the remaining `actors − settled` to pending: an agent refused at its
birth, or evicted while it was still queued, has yet to run, and the one thing the bound must
not do is report it done. That subtraction needs no floor of its own, because the bucket is
clamped to `actorsFailed ≤ actorsSettled ≤ actors` at the source ("Reduction"); an agent whose
outcome the phase cannot attribute — a cached ask whose actor was never listed — therefore
counts as pending here until it is listed again. The station's `settled/observed` adds
`nodesSettled` to both of its
numbers, that being a count of nodes rather than of agents. A station's numbers therefore stay
true and never shrink as its agents leave the table — only its rows do.

On the card the station is the five pinned pills and one more row (`WorkflowMoreRow`) shaped
like a sixth pill: a deck of up to three faces from the rest in attention order (failed,
running, pending, done; their expressions already show status), the text "{n} more", a red
`✕ n` only when failures hide behind the row, and a resident `↗` in the tail. Clicking it
opens the run pane landed on this station. A station is therefore never taller than six
pills. The pane's form of the same row is described under "The spine".

### Overflow: the ledge

When the timeline is wider than its container it scrolls freely; there is no snapping and
no wrapping. Stations whose lamp has scrolled out fold onto a **ledge** at that edge
(`WorkflowLedge`, geometry in `timeline-ledge.ts`): the same 10px lamps, 16px apart, joined
by 6px rail stubs in the departing rail's ink, at most three lamps and a `+n` for the rest
(the lamps nearest the content are kept), and a short stub rail from the ledge to the first
open station, drawn only when it would be at least 6px. A station is folded when its lamp
lies under the ledge plus a 40px fade; the ledge widens with its lamp count, so the fold set
is iterated to a fixed point. The folded station's head fades out in place (160ms), stays
in the layout, and is neither clickable nor focusable; its pills are not folded. The
scroller carries a two-band mask: the rail band fades out under a ledge (or 40px from the
edge when there is overflow but no ledge), the pill band fades only at the viewport edge and
only on a side that has content beyond it. Nothing folds when the viewport measures zero
(the first frame, jsdom), and without overflow there is no ledge, mask or scrollbar.

The ledge stands on the **main line** row, and its segments are looked up by the **pair** of
stations they join rather than by their left end: inside a band one station can be the left
end of several rails at once. A `twin` becomes a **twin stub**, two 1px lines 2px apart. The
ledge has flattened the band, a fork and a merge do not fit in 6px, and two parallel lines
are the only mark left there that still says "at the same time". The fold set, the camera and
the stub widths all count from the inset, so they travel with the lamps. The scroller's rail
band reaches down to the bottom of the platform row, so a folded station's caption is cleared
along with its lamp.

Each ledge lamp is a button titled "{phase} · {status}"; clicking centres that station. With
focus on a station head or a ledge, `←`/`→` scroll one station. A 2px scrollbar runs along
the bottom (`WorkflowTimelineScrollbar`): thumb length is viewport²/content, at least 24px;
it is invisible at rest and shown on hover, while scrolling (800ms) or while dragging, and
thickens to 4px under the pointer; the thumb drags, the track pages one viewport per click.
The scrollbar stops the propagation of its clicks and pointer-downs, because the browser's
synthetic click after a drag would otherwise reach the run card and toggle it.

**Camera.** In a run the camera centres the running station whenever it changes; in a draft
it puts the newest station at the right edge (`index × 192 + 168 − clientWidth`). A user who
has scrolled is not fought; the camera re-anchors only when its focus station changes. A
`scrollTo` starts a **flight** `{index, target, from}`; while it lasts the target station is
excluded from folding, since the viewport was measured before the scroll began and would
report the station as out of view for the ~300ms of smooth scrolling. The flight ends by
position alone, never by timer: on landing (within 1px) or when a sample is farther from the
target than the last one, which means the user took over. The viewport hook takes the
scroller **element** as its dependency, not a ref object, because the draft's first frame
renders nothing and a ref-keyed effect would never attach its listeners.

### Motion

Every animation is declared once on `.wf-motion` and shared by card, confirmation window and
pane. Only opacity, transform and colour move; layout never does.

| Class | When | Effect | Duration |
|---|---|---|---|
| `wf-arrive` | a pill or tile mounts | opacity 0→1, y 4→0; staggered 30ms per pill (8ms, capped at 400ms, in the pane's roll) | 200ms |
| `wf-mark` | a status mark changes value | scale .6→1 | 180ms |
| `wf-lamp` / `wf-ink` | a lamp or rail changes state | colour transition | 320ms |
| `wf-draw` | an arc first appears | dash offset from source to target | 420ms |
| `wf-lamp-running` | a station is running | the lamp thumps to 1.12× and sends out one ring | 1.6s loop (`--wf-beat`) |
| `wf-rail-grow`, `wf-land`, `wf-caret` | the pen reveals a draft station | rail grows from the left (160ms), lamp lands (200ms), caret blinks when idle | |
| `wf-unfold` | a card body or phase section opens | opacity 0→1, y −3→0; closing is immediate | 200ms |
| `wf-swap` | a kind word or status word changes text | old word out, new word in (keyed on the text) | 200ms |
| `wf-stream-flow` | a stream is flowing (both ends running) | its three chevrons light in turn, 0.15s apart | 1.2s loop |

`wf-rail-march`, `wf-lit` and `wf-spine-march` are not in the table: the march edge is ink,
not motion, and the lamp's beat is the only loop left on the rail.

Entry animations fill `backwards`, not `both`: a `forwards` fill would leave a transform on
the element and block the hover transitions. Under `prefers-reduced-motion: reduce` every
duration is zero and every loop stops on a still frame (a steady halo with no thump and no
ring, a steady caret, a flowing stream's chevrons steady at full warning); the lit edge is
ink and does not change. Hover still swaps
background, stroke and arrow instantly, so nothing is conveyed by motion alone.

## Holes on the timeline

A hole (`docs/dynamic-workflow/authoring.md`, "Holes") is drawn as a **station**, because it
is a place on the rail where the program is not yet written, and it grows in place when it
is filled, because a fill is a splice into this script. This is what tells it apart from a
sub-workflow, which is a call and nests. The reference boards are in
`dwf-assets/experiments/dwf-typed-holes`, and those of the frame in
`dwf-assets/experiments/dwf-hole-frames`.

**The hole station.** A 10 px lamp with a `1.5px dashed foreground-subtlest` border and no
fill; the hole's name in `text-ui-caption` medium, subtle until reached; the rails touching
it dashed under the ordinary ink rules. A tail hole's rail runs 40 px past it and fades: the
script's end is not written. The confirmation window lists the holes by name in a chip row
and says the run will pause there; the detail counts 「2 个阶段 · 2 处留白」.

**The type is never shown.** `hole<T>`'s `T` is the contract the compiler checks the fill
against and the main agent reads from the notification; it is not something the user reads,
so no surface prints it: not the station, not the confirmation chips, not the head, not the
fill or notification rows, not the pane. (It was a mono badge after the name once; a real
type such as `{ target: string; reason: string }` filled the station head and squeezed the
name to nothing.)

**Waiting.** The rail into the hole marches, the dashed lamp takes the warning border and the
3 px warning halo, **steady**, since nothing runs there, and the meta reads 「等待补全」. The
header grows 「{n} 处留白待补全」 with the pen icon in the questions chip's slot; both chips may
show. The station and the chip open the run pane landed on the hole. Nothing is typed in the
GUI: the main agent fills, and the user talks to the main agent.

**Filled with phases.** The body's phases stand where the hole was, as ordinary stations,
and what remains of the hole is its **head**, kept in a 24 px row above the rail that exists
only on timelines with a fill: the pen (12 px) centred on the first inserted lamp's x, the
hole's name (`text-ui-caption` medium, subtle, truncating at 300 px). Its tooltip reads
「留白「{name}」· 由主代理补全 · {time}」; its click opens the pane on the heading. Hovering
the head, or focusing it from the keyboard, draws the fill's **frame**: one 1 px line in the
rail's own ink (`--color-workflow-trace`), radius 8, from 8 px left of the first inserted
column to 8 px right of the last, from the head row's middle down to 8 px under the fill's
tallest column (4 px under the rail row, or the platform row, when the fill's columns have no
pills, as when the card is collapsed). The head is its legend: the line breaks around the head
row, 4 px clear on either side, by a mask rather than by painting a background, so the frame
works on any surface the timeline sits on. The rail enters the frame on the left and leaves it
on the right. Nothing else triggers the frame: not a station, not a pill, not the frame's own
area, so crossing the card never flickers. The head turns `foreground` while its frame shows.
Only one frame is drawn at a time, so nesting never stacks: hovering an outer head frames the
outer fill, inner fill included; hovering an inner head frames the inner fill alone. A nested
fill that starts on its enclosing fill's first column has its frame inset 4 px on the left,
right and bottom per such enclosing fill, so the two outlines differ though never shown
together. Heads share the row: a nested head whose first column is its enclosing fill's first
column is placed after the outer head's text, at the outer head's right edge + 12 px, since
two pens on one lamp would read as one.

**The stroke.** The frame is drawn as one stroke: an SVG path with `pathLength` 1 that starts
on the top edge at the pen's x, runs clockwise round the fill and returns to the pen. Its dash
offset goes from 1 to 0 in 420 ms on `--wf-ease`, so the line appears coming out of the head's
right end and closes at the pen. Leaving the head fades the whole line in 160 ms; it is not
undrawn, since leaving is not an event worth a motion. For the two seconds after a fill joins
the run, the frame draws itself unasked, in `--color-warning` at 1.5 px, with the head in the
same colour, then lets go: the pen circles what it just wrote, once. Under
`prefers-reduced-motion` the frame appears and disappears whole.

**Filled without phases.** The hole's own phase holds the fill's asks (`docs/analysis.md`,
"Sites"), so nothing lifts: the station keeps the hole's name and gains a small pen mark on
the tag surface after it, the lamp is the ordinary lamp of the station's status, and the
fill's asks are its pills. A filled tail hole keeps the 40 px its open form had. The pen mark
is this fill's head: hovering it, or focusing the station head that carries it from the
keyboard, frames the station's one column, from 8 px either
side of the column and 4 px above the rail row down to 8 px under its pills. With no legend to
hold, the stroke starts at the top-left corner. Two seconds after the fill joins, this frame
too draws itself in the warning ink.

**Growth.** The stations to the right slide by the inserted width (a transform, 320 ms, then
committed), the rail row moves down 24 px if this is the card's first head, the new heads
land with `wf-land` and their rails grow with `wf-rail-grow`, and the frame draws itself
fresh round them: the pen's own motion, since a fill is the pen writing into a running script.
The camera holds the waiting station's x so the eye sees the ringed lamp become the head's
pen. Under `prefers-reduced-motion` the new row simply appears.

**The pane.** A hole is a section with the dashed lamp; waiting, it opens on how long, the
prompt and the run link. Filled with phases, a 24 px heading row stands before the first
section the fill wrote, the pen (14 px, on the background, covering the rail) where a lamp
would be, then the name. Nothing indents: the fill's sections keep the spine's one text column,
and nesting is said by the frames. Hovering or focusing the heading draws the same frame as the
card, standing up: the same ink, radius and stroke, from x = 8 (left of the lamps) to 12 px short
of the list's right edge, from the heading's middle down to 4 px under the fill's last section,
open or folded, with the rail running through it top to bottom as it runs through the card's
frame left to right. The stroke starts at the rail's x on the top edge; the heading's pen and
name carry the background, so they are the legend. A nested fill's frame is inset 4 px on each
side per enclosing fill. The frame follows the sections as they open and close. The heading
turns `foreground` on hover, with no surface of its own, and its click still opens or closes the
fill's first section. Filled without phases, the section keeps the name and the pen mark, and the
mark frames that one section, 2 px inside its top and bottom. The fresh frame draws itself here
too. On a phone there is no hover: the head on the card opens the pane, a tap on a heading
toggles its section, and no frame is drawn on tap.

**The sidebar** draws a hole as a dashed 6 px lamp, warning while waiting, with the
line 「决定分组 · 等待补全」; after the fill its mini rail has one lamp more and nothing else.

**The fill row.** `FillWorkflowHole` is rendered by the `CreateWorkflow` row's renderer with
the hole vocabulary, selected by tool name: 「正在补全留白」 shimmering while the body streams,
「留白补全草稿 · 草稿 {n} · {k} 处待修 未运行」（状态两词以 gap-2 分隔，无中点） on diagnostics with the compiler-feedback body,
「留白已补全 · {name} · {k} 个阶段 · {m} 个子代理 ↗」 when joined. Its draft line is the parent
rail with the fill in place: the head over the fill's stations at full ink, and on either
side the neighbours they go between, ghosted at 40%. It is the one thing a `CreateWorkflow`
draft never shows, context, and the card grows into the same picture. A `path` fill has no
pen, as a `path` submission has none. The row learns the hole's **name** (and the draft
path and line the compiler-feedback body cites) from the display payload's `fill` block,
which the tool writes from the resolved hole on every outcome, joined or refused. It cannot
read them from the row's input: the transcript keeps the model's own input (`run_id`,
`hole_id`, `script`), and the `hole` block the resolver adds for the permission rule never
reaches a row (the same is true of `AmendWorkflow`'s `predecessor`). The first live chain
test showed the consequence: rows titled by the hole's site id, and head rows titled by site
id once the run left the live state.

**The model.** A hole is a phase named by the hole, id its site id (`hole#` and eight hex
digits, keyed by the name; `docs/analysis.md`, "Sites"), unique by rule 9012, so every surface
labels it by name alone. The id says nothing about nesting, and nothing on this side parses
it beyond its shape. The display payload of the effective script carries `fill: <hole id>`
on the phases and steps a fill wrote and, on a hole's own phase or step, the hole enclosing
it; `buildWorkflowTimeline` reads the second into a parent table (`holeParents` on the
model), which is what lets an outer fill's head span an inner fill's stations and a nested frame
know how far to inset. `holes` lists the ones still open,
and a fill row's payload names the hole it filled in `fill` (`siteId`, `name`, `draftPath?`,
`line?`), which the card join accumulates as the head labels across fills; the sidebar,
which draws from `phaseNames` alone, reads the aligned `holes` index
table on `run-launched` and `hole-filled` to draw them dashed; the run state carries
`holes[]` (the engine document, "The run snapshot"). `buildWorkflowTimeline` derives the
heads from the phases' `fill` runs, so no station learns a new kind. A filled hole's own
phase that claims nothing while its body has stations of its own is not drawn: the head
already names it, and an empty lamp in front of the body would say nothing. Its in-edges are
joined to its out-edges so the rail does not break. It still stands in `phaseNames`, so the
sidebar names every step of a chain. A filled hole's own station, when it is drawn, belongs to
its own fill (its `data-fill` is its own id), not to the fill of the hole around it. The card and the pane
take the newest display payload whose run id is theirs, which is the fill row's after a fill
and the launch's before.

## The chat area

### The tool row

The `CreateWorkflow` tool row (`ToolCallBlocks/renderers/create-workflow.tsx`) reads its
inputs from the row's `input` (script, name, saved source) and its graph from
`display.causalityGraph` when that parses and has at least one step. Its shape follows the
row's v4 status:

| Row state | Kind word | Body |
|---|---|---|
| `inputStreaming` | "Writing workflow"; from draft 2 on "Revising workflow" / 「正在修改工作流」 | a `ToolLayout` row that cannot be expanded, with the **draft phase line** below it (not inside it: no fold) |
| `pendingApproval` | "Awaiting workflow confirmation" | a `ToolLayout` row, collapsed by default, expandable to the script (`CodeBlock`, 320px max) and diagnostics; the running shimmer stays on |
| compile errors | "Workflow draft" / 「工作流草稿」 | the compiler feedback row (see "Compiler feedback"): detail "draft {n}", a hollow lamp and "{n} to fix" "not run" (two words, gap-2, no dot), expandable to the script and the feedback card |
| failed with no display | "Workflow" | a `ToolLayout` row with the tool's status word, the error in its tooltip, expandable to the plain output text |
| launched, joined to a run | "Workflow" | `WorkflowToolSummary`: "Workflow · {n} agents ↗", one line, click or Enter/Space opens the run pane; plain text when the host cannot open it |
| compiled, never launched (denied, or a host without execution) | "Workflow" | the static card: header with a hollow "compiled" lamp, the static timeline, and a collapsed script fold; open state remembered per tool id |

The `AmendWorkflow` tool row is the same renderer with the amend vocabulary, chosen by tool
name before the family dispatch (`lib/workflowToolNames.ts`, `isAmendWorkflowToolCall`),
because the workflow family's fallback is the create card. It reads `run_id` from the
input for its lineage line and shares the `create_workflow` display kind, so the graph,
the draft pen and the compiler feedback card need no second implementation.

An amend that keeps the predecessor's script (`docs/dynamic-workflow/launch.md`, "Keeping
the predecessor's script") has neither `script` nor `path` in the row's input, because the
row shows what the model sent and the script is filled in only after that. A `path` amend
also lacks `script`, but it submits a revised script, so it is not read as one. Once the input has finished
streaming, the lineage line then reads "Amends run {id} · script unchanged" / 「调整 run
{id} · 脚本不变」, the card has no script fold and no draft pen, and the "no script" notice
of an empty create does not appear: the missing script is the point of the call, not a
fault. While the input streams nothing is said, since a script may still be on its way.
One reader decides it for the card and the window
(`ToolCallBlocks/renderers/createWorkflowInput.ts`, `readWorkflowAmendScriptInherited`): the
resolved input's `predecessor.script_inherited`, or a finished input with neither `script`
nor `path`.

| Row state | Kind word | Body |
|---|---|---|
| `inputStreaming` | "Amending workflow" / 「正在调整工作流」; from draft 2 on "Revising amendment" / 「正在修改工作流调整」 | the draft phase line below the row, as for a create |
| `pendingApproval` | "Awaiting amendment confirmation" / 「等待调整确认」 | as for a create |
| compile errors | "Amendment draft" / 「工作流调整草稿」 | the compiler feedback row, as for a create |
| refused (`run_not_found`, `missing_boundaries`, and the retune's three) | "Workflow amendment" / 「工作流调整」 | the refusal text |
| retuned a live run in place | — | the retune row (below) |
| launched, joined to a run | "Workflow amended" / 「工作流已调整」 | `WorkflowToolSummary`: "Workflow amended · {n} agents ↗", opening the **new** run's pane |
| compiled, never launched | "Workflow amendment" | the static card |

**The retune row.** An `AmendWorkflow` that only retuned a live run's parallelism
(`docs/dynamic-workflow/launch.md`, "Changing only the parallelism of a live run") compiled
nothing and started nothing, so neither the summary nor the static card fits: the card would
announce a second run of a script that never ran again, and the static card would read
"compiled · amends run X · script unchanged", three claims none of which happened. The row is
instead the **settings row the GUI leaves behind** (`WorkflowRetuneRow`, drawing
`WorkflowSettingsChangeRow`), word for word: the same act should not read two ways because a
model rather than a user asked for it. The one difference is that it is a button — the tool row
is where the model's step landed, so it opens `input.run_id`'s pane from there.

It is recognized from facts that already cross v4, never from a new one: the row's input has
`run_id` and `max_concurrency` and none of `script`, `path`, `subagent_model` or `name`
(`readWorkflowRetuneCall`), the status is success, there is **no display payload**, and no run
joins this row by `toolCallId`. A retune that lost the race and became a real amendment fails
the last two — it has a display and it mints a run — so the joined branch above takes it first.

The number the row says is the model's own, before the agent's floor, so the default
parallelism from the retuned run's projection (`run.concurrencyCeiling`) decides the wording:
equal to it, and for `null`, the row reads 「上限恢复为默认」 ("limit back to the default");
any other number, above or below, is the number. A default the projection cannot supply (the
run has been evicted, or an older CLI never sent one) leaves the number as typed. No `from` is
drawn: the input does not know the previous bound, and the wording reads only `to`.

While the input is still streaming, that same input shape keeps the row at 「正在调整工作流」
and never lets it become 「正在校验工作流」: there is nothing to validate on this route, and the
phase it would name lasts a few hundred milliseconds. The row also produces no turn-end digest
card — it names a run it neither started nor resumed, and that run's card is already in the
transcript where it was launched ("Joining cards to runs").

On the v4 host the joined row is intercepted before the renderer and replaced by the
summary, because the run card under the turn already draws the live timeline; the
renderer's own live card remains only for older hosts. The join is by `toolCallId`: the run
state carries the tool call that started it, and a row whose tool call has a run gets the
open callback. Rows for `ResumeWorkflowRun` join by run id and render a one-line compact
card ("Workflow run resumed", run id, lamp and word, `settled/total steps`).

### Compiler feedback

A script that does not compile has not failed. Nothing ran, and the diagnostics went back to
the model, which revises the script and submits it again (`docs/dynamic-workflow/launch.md`,
"Failures that never reach the window"). The row says this with the slots `ToolLayout`
already has (kind word, name, detail, status) and adds no element to the transcript. It
never uses the destructive colour: on this feature that colour belongs to a run that
errored.

**Draft numbers.** The host joins every `CreateWorkflow` and `AmendWorkflow` row of the row
window into a draft position in one pass in row order
(`packages/ui/src/v4/workflowDraftJoin.ts`, `buildWorkflowDraftByToolCallId`), and the row
context hands each tool row its own position. The rules:

- A **lineage** is the tool, plus the predecessor `run_id` for an amend. Creates number
  among creates; the amendments of each run number from 1 on their own.
- The **ordinal** is 1 plus the number of compile-failed rows (`display.ok === false`) of
  the same lineage and the same turn since that lineage's last row that compiled
  (`display.ok === true`). A row without a display (still streaming, awaiting
  confirmation, refused, cancelled) neither counts nor resets. A new turn starts at 1.
- A row is **superseded** when a later row of the same lineage exists in the window, in the
  same turn or a later one.
- The window is bounded, so a draft whose predecessors have left it numbers low. The
  number is presentation only; nothing else reads it.

**Words.** The detail slot reads "draft {n}" / 「第 {n} 稿」 on a compile-feedback row
always, and on an in-flight row (writing, validating, awaiting confirmation) from draft 2
on. A first draft is not numbered while it is written, so a row never predicts a second.
The compile-feedback row's status reads "{n} to fix" and "not run" / 「{n} 处待修正」「未运行」
(`errorCount`) as two words separated by a `gap-2` space, without a decorative dot, and its tooltip opens with the feedback sentence below, followed by one
`L{line}:C{col} message` line per diagnostic. The launched summary, the run card and the
confirmation window never carry a draft number. A host without the join shows no number
and an open lamp.

**The lamp.** A hollow ring stands before the status words, the same shape as "compiled"
and as a pending station, because nothing ran. It is warning while the row is its lineage's
latest draft: either the loop is live, or the model stopped there and the question is still
open. Once a newer row exists it turns neutral (`foreground-subtlest`), and that is the only
thing that changes on an old row. The status words stay in the row's subtlest grey.

**The card.** Expanding the row shows the script with line numbers, where the numbers of
flagged lines are tinted warning, and below it the feedback card
(`WorkflowDiagnosticsSection`, shared with the `EvalWorkflowSnippet` card):

| Part | Content |
|---|---|
| Frame | `border-border` on `bg-panel`, `rounded-xl`; no destructive border |
| Header | "Compiler feedback" / 「编译反馈」, and on the right "{n} notes" / 「{n} 条」 ("1 note") |
| Sentence | "Typecheck did not pass, so nothing ran. The feedback went back to the model to revise and resubmit." / 「类型检查未通过，脚本未运行；反馈已交回模型，由它修改后重新提交。」 For a saved source the sentence names the file instead: "The saved workflow file did not pass typecheck, so nothing ran. The feedback went back to the model to fix the file or save a corrected version." / 「保存的工作流文件未通过类型检查，脚本未运行；反馈已交回模型，由它修改该文件或保存修正后的版本。」 |
| One line per diagnostic | the `L{line}:C{col}` chip in subtle grey, the message in foreground, the code label in subtlest grey |
| Code label | `TS{code}` for TypeScript; "rule {code}" / 「规则 {code}」 for the analyzer's own codes 9001–9099 (`apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md`, "Diagnostics"), which are not TypeScript codes |
| Truncation | "Some diagnostics were omitted." when the payload is truncated, as before |

### The draft and the pen

While the model is writing, the analyzer has not run and there is no graph. The card scans
the partial script with a regular-expression scanner, not a parser (`draft-scan.ts`): it
recognizes `phase("…")` and `agent("…")` with single, double or back quotes, takes the text
before the first `${` of a template, and builds a model with stations only: faint rails
between consecutive stations, no pills, no arcs, no status, plus `draft.agents`, the count
of distinct agent names. A second closed `phase("implement")` is a return to that station,
not a new one, so the draft's station count matches the analyzer's and no station vanishes
at hand-over. An unclosed `phase("ver` marks the last station `typing`, and later text of the
same marker renames it rather than opening another. The streaming input preview must
therefore keep the `script` and `name` fields of the half-written JSON, which it does.

The pen (`useTypewriter`) turns the scanner's jumps into writing. It reveals one station at
a time in declared order; a revealed station's name is written at 24ms per character
(`PEN_MS`), then the pen rests 120ms (`PEN_GAP_MS`) before revealing the next. A station the
pen has not reached is not on the rail, even if the scanner knows it. A name that grows
mid-word keeps being written; a name whose prefix changed falls back to the common prefix.
Timing is keyed on content, so a new array with the same names does not interrupt the pen.
The caret follows the pen and blinks once it has caught up with the stream. The pen reveals
only when there is a next station: an empty draft (the script's opening lines before the
first `phase(`) does nothing, and under reduced motion whole names are derived at render
time rather than set in an effect. Both rules exist because the alternative, a `setState`
on every frame while projection frames pile up as synchronous commits, exceeded React's
nested-update limit and crashed the chat area. When the analyzer's display arrives the
draft model is replaced whole: the caret leaves, the stations keep their names, pills land,
arcs draw. A submission by `path` or `saved` streams no script, so it has no draft and no
pen: the row goes straight to validation, and the model's revisions of a script file show
up as ordinary `Edit` rows (`docs/dynamic-workflow/launch.md`, "Script files").

### The confirmation window

`WorkflowPermissionBlock` draws the decision surface of the confirmation request (the
window itself, its Deny / Refine / Run controls and the "always allow" option belong to
`docs/dynamic-workflow/launch.md`). Its header is "Run this workflow?", or "Amend this
workflow?" for an `AmendWorkflow` ask, with the workflow name (or "Workflow script") and one
detail, "{n} phases"; no lamp, no agent or step counts. Then, for an amend, a lineage row
"Amends run" with the run id, "script unchanged" when the call kept the predecessor's
script, and, when the predecessor is still running, "still running, will be stopped"; then the
two run settings, model first and bound second; and, for a saved source, a "Saved workflow"
badge with scope, name, path and arguments.

The two settings are sentences whose values can be changed before approving
(`docs/dynamic-workflow/launch.md`, "Adjusting the settings in the window"). They are drawn
whenever the input carries `adjustable_settings`, whether or not the call set the fields, so a
user who changes nothing still reads what will happen:

| Line | Parts |
|---|---|
| Model | "Subagents run on" / 「子代理运行在」, then the model chip: the composer's model list (`ModelConfigSelect`, the Configure popover's groups, with the session model first carrying the "session model" / 「会话模型」 badge), its trigger drawn as a chip, `h-6 rounded-md bg-surface text-ui-sm`, transparent border, chevron `size-3`, the border and the input background appearing on hover. Beside it the thinking-level chip (`ThoughtLevelCycleControl` in the same chip style), only when the chosen model has levels; picking a model sets its default level. A model the input names but the list no longer offers keeps its name and gets the "unavailable" / 「不可用」 badge; Allow then waits for another choice, as the popover's Apply does. When the block says the host cannot choose a model, or the workspace lists no models, the line is the sentence "Subagents stay on the session model · this agent has no model catalog" / 「子代理沿用会话模型 · 当前 agent 没有模型目录」, unless the call names a model (an amend that inherited one): then it is the plain line "Subagents run on {model}", because the window must not say the opposite of what will run |
| Bound | "At most" / 「最多」, a stepper (`InputGroup` at `h-6`: minus, a `w-[30px]` mono number, plus) from 1 with no upper end, then "subagents at once" / 「个子代理同时运行」, then in subtlest text "· default {n}" / 「· 默认 {n}」, which becomes "· = default" / 「· = 默认」 when the value is the default. With no default known and no value either it starts empty and the tail reads "· no limit of its own" / 「· 不设上限」 |

When the input carries `model_bindings` (the script names models for some of its subagents,
`docs/dynamic-workflow/authoring.md`, "Choosing a model per subagent"), the window does not
draw them: those choices are the authoring model's, in the script the window shows, and a line
per name would bury the one decision the window asks for. Only the model line's lead changes,
to "By default, subagents run on" / 「子代理默认运行在」 (plain: "By default, subagents run on
{model}"; no catalog: "By default, subagents stay on the session model"), because it no longer
speaks for every subagent. The run pane's rows name each subagent's own model once it runs.

Each line is `flex flex-wrap items-center gap-x-1.5 gap-y-1 min-h-6 text-ui-sm
text-foreground-subtle`, and the lines sit in a `space-y-1` block. An untouched value is drawn in
the chip's ordinary weight. A changed one goes to `font-medium` and the line gains a tail in
subtlest text, "· was {value}" / 「· 原为 {value}」, with a ghost `icon-xs` reset button
(lucide `Undo2`, tooltip "Back to the proposed value" / 「恢复原值」) that puts the line back.
"was" names what the line started at: the call's value when it set one, the default the line
showed otherwise. Nothing else changes colour: weight is enough on a line this short. Once any
line has changed, the first two options re-describe themselves (`docs/dynamic-workflow/launch.md`,
"The options"). While the answer is in flight every control is disabled with the options. The
chip's tooltip carries the canonical string and the sentence that the main agent stays on the
session model, as the plain line's tooltip does.

The option list keeps its keyboard model: arrow keys and Tab cycle the options. The settings are
ordinary focusable controls above it, and Shift+Tab on the first option leaves the list for
them, so the reading order and the focus order agree. Keys typed into a control stay in it: the
dialog's number shortcuts belong to the option buttons, not to the dialog.

When the input carries no block (an older agent), the window draws the plain lines instead,
only for the fields the call set, in `text-ui-xs text-foreground-subtlest`: "Subagents run on
{model}" and "At most {n} subagents at once". The model line says the **resolved label**, not
the canonical string `resolveInput` produced: a model name, plus "· thinking {level}" /
「· 思考 {level}」 when the choice carries a reasoning level. The canonical string keeps its
place in that line's tooltip, under one sentence saying the main agent stays on the session
model. One pure function decides the words for all three surfaces that name the model,
`describeWorkflowSubagentModel` (`components/workflow-timeline/subagent-model-label.ts`): a
builtin provider family shows the model id alone, a custom provider shows "{provider name}/{model
id}", and a provider that cannot be resolved falls back to the model id. The provider id is
never shown, because for a team plan it is a UUID.

Below the settings and the saved badge comes the static timeline, built with no run, not
collapsible, with no pill or station callbacks (nothing exists to open yet). Then the
script in a `Collapsible`, open by default only when there is no graph (a script with no
steps has nothing else to show), reset when the request id changes. The block is the one
permission block allowed to contain a fold.

### The run card

`WorkflowRunDigest` (`components/workflow-timeline/WorkflowRunDigest.tsx`) is the card under
the turn that started or touched the run. `resolveWorkflowTurnDigests` reads the whole turn
unit and applies one rule: **every source that names a run it started or resumed yields one
card**, one per run per turn (first source wins). The one source that names a run without
being such an event is the in-place settings turn, and it is the one exception: a run that was
retuned already has its card, so the turn is a row alone (see "The settings turn" below).

| Source | Joins by | Name |
|---|---|---|
| the launch turn of a direct launch (`unit.workflowLaunch`, `docs/dynamic-workflow/launch.md`) | `runId` from the metadata | the metadata's name |
| the settings turn of a change made with Configure (the same `unit.workflowLaunch`, with an `amend` block) that started a new run, which is the block carrying `predecessorRunId` | `runId` from the metadata | the metadata's name |
| a `CreateWorkflow` row | its tool call id (the projection's `run.toolCallId` is the originating row) | the input's `name` |
| a `ResumeWorkflowRun` row | the `runId` on its display | the fallback name |

A `CreateWorkflow` row names no run by itself, so a rejected or uncompilable script has no
card. The **graph is a property of the run**, found by the run's originating tool call id in
one table the host builds from the row window (`workflowRunCardJoin.buildWorkflowGraphByToolCallId`):
a `CreateWorkflow` row's display or a launch turn's `workflowLaunch.display`, whichever
carries it. A resume card therefore draws the same rail as the row that started the run. A
source whose run is **not in the projection** (evicted past eight runs, or a cold restore
with no journal hit) still yields a card, the header-only **neutral card**: kind word
"Workflow ended" / 「工作流已结束」, the name, `⤢`, no lamp, rail, detail, Stop or Resume,
`data-workflow-run-status="absent"`. The card renders as soon as the source is present, while
the main turn is still running, after the completion card and before other turn-tail cards.
For a launch turn the card is the turn's whole rendering (no user bubble).

A turn that renders **no user bubble** — the launch turn and the settings turn, whose user
row is the canonical sentence written for the model — also drops the turn container's top
padding, by the same rule and for the same reason as the notification row
(`docs/dynamic-workflow/transcript-and-notifications.md`, "The notification row"): that
padding is the breathing room above a bubble, and with no bubble under it the row or card
would float a turn's height below the previous turn. Its first node therefore sits at the
ordinary flow gap below the previous turn.

The space at the **top of the transcript** is a separate rule, owned by the timeline. The
status capsule floats over the conversation's top-right corner (16 px down, 34 px high as a
pill), so whatever starts the transcript needs 56 px of clearance or the capsule covers it
and swallows its clicks. A hub launch is the case that showed this: its turn is the
session's first and has no bubble, so the card's Configure, Stop and `⤢` lay under the
pill. The timeline therefore wraps the **session's first turn** in a 56 px top inset, and
that turn drops its own top padding, bubble or not: a first turn that opens with a bubble
sits where it always did (the inset replaces its padding), and a first turn without one sits
below the capsule instead of under it. The inset belongs to the turn's virtual item, not to
the list, so measuring, jumping to the first turn and keeping the reading position when
older history is prepended all count it. It applies only while the session's first turn is
loaded (no older history left to fetch) and no imported share sits above it (that block has
its own top spacing); otherwise the first loaded turn keeps the per-turn rule above.

The header is one line: the icon, the **kind word** for the run's status ("Workflow
started / running / completed / errored / stopped", shimmering while running; "Workflow
superseded" / 「工作流已被替代」 for a run stopped by an amendment), the name, a
warning-tinted **questions chip** "{n} questions" when the run has pending questions
(clicking it opens the run pane), the detail "{n} phases · {m} agents working" while the run
is pending or running and "{n} phases · {m} agents" after (agents = the larger of the run's
actor count and the graph's agent lanes), with the **subagent model name** appended as a last
segment when the run chose one ("{n} phases · {m} agents working · GLM-5.3-Flash") in the same
dim text, no chip and no prefix, the reasoning level and the canonical string in the detail's
tooltip; then the **Configure** icon button (sliders, `icon-md` ghost, tooltip "Configure
workflow" / 「配置工作流」) when the run can be configured (`docs/dynamic-workflow/launch.md`,
"Which runs can be configured"), which opens the settings popover under it (see "The settings
popover"); then one of **Resume run** (when the run state
says `resumable`) or a **Stop run** icon button (a filled square, while running; pressed
it disables and its tooltip becomes "Stopping…", reset by remounting on the next status),
then `⤢` "Open run details". Configure sits in the same slot in every state it appears in, so
it never moves `⤢`. The Stop tooltip carries a second line, "You can resume later;
finished steps are kept." / 「停止后可以随时恢复，已完成的步骤会保留。」, because the verb
was read as "discard" and a stopped run is resumable; while stopping, that line is gone (the
decision is already made). Stop calls the same `cancelBackgroundWork {workId: runId}`
command as the pane; there is no second stop path and no confirmation, because a stopped
run can be resumed. Every control appears only when the host gave the callback.

**When the header runs out of room.** The icon, the kind word, the questions chip, Configure,
Resume / Stop and `⤢` all keep their width, and the two texts give way instead: the name first
(it grows into whatever the row has left over, so it is the first to run short), then the
**detail, which truncates with an ellipsis**. The detail is the one that used to push Configure
and Stop past the card's right edge, because it never yielded and the subagent model name can
make it far longer than "3 phases · 2 agents working".

Both the right-hand cluster and the detail inside it need `min-width: 0`, and the one on the
cluster is the load-bearing half. A flex item's automatic minimum size is its min-content size,
and the detail's `white-space: nowrap` makes its min-content the *whole* string — `overflow:
hidden` does not shrink that, and neither does the detail's own `min-width: 0`, which only
frees the detail to be shrunk by its parent. Without `min-width: 0` on the cluster, the
cluster's floor is therefore "the entire detail plus the controls": it never yields a pixel and
the buttons leave the card exactly as before. Measured by stepping a card down in width, the
buttons escape from 520 px wide without it, and at no width down to 290 px with it. That
290 px floor is the row's fixed part — the kind word plus three icon buttons — and a pending
questions chip, being another fixed item, raises it to 380 px. A card narrower than its floor
still overruns, so a run holding a question can overflow on a phone; closing that case means
letting a third thing truncate, which is a design decision, not a layout bug.

**Lineage on the card.** The card does not spell out lineage. A run with `supersededBy`
shows no Resume button (it is not resumable) and its kind word reads **"Workflow superseded"
/ 「工作流已被替代」**; the lamp stays the neutral hollow ring of a stopped run. A run with
`resumedFrom` looks like any other run. The two sentences that name the other end of the
chain, "Amends run {id}" and "Superseded by run {id}", live only in the run pane (see "The
run pane") and in the confirmation window: on the card they were noise next to the counts.
Both facts still travel in the v4 run state (`resumedFrom`, `supersededBy`), fed by the CLI
projection from the `run-started` and `run-settled` progress payloads, so the pane can show
them; a run outside the projection window shows neither.

The card is expanded by default. When it has a rail, the whole card is a toggle: a click on
blank space, or Enter/Space with focus, collapses it to header plus phase line (pills
stripped, stations, arcs and ink kept as a progress overview); clicks on buttons, links,
form controls and `[role=button]` descendants belong to them. The timeline is built only
when both the graph and the live run state exist, since a graph with no run would draw a
finished run as never started. Its stations are not buttons here (they bubble to the
toggle), pills open transcripts, and the "{n} more" row opens the run pane landed on its
station (`onOpenRun({ phaseId })`); `⤢` and the chip open the whole run. Below the
timeline, in both states, an artifact strip shows up to three artifact pills and `+N`
(see `docs/dynamic-workflow/authoring.md` for artifacts); a pill opens its artifact, an
HTML one straight in the browser tab. A `truncated` run whose node table lists fewer
instances than the run has (`nodes.length` below the real step count; `truncated` alone is
not enough, the small collections set it too) grows one subtle line under the timeline,
"Details shown for {shown} of {total} steps" / 「仅展示 {shown}/{total} 步的详情」, where
{shown} is the instances the key lists and {total} the run's real step count: the counts
above it are already the real ones, and the line says that the per-step detail, not the
run, stopped at the bound. The line belongs to the timeline: the header-only card below has
no counts for it to qualify and does not carry it. When the run is in the
projection but the graph is not in the visible row window, the card is a single header line
with no rail, no detail and no toggle; when the run has been evicted from the projection
there is no card.

**The settings turn.** A change made with Configure is recorded as a control-only turn
(`docs/dynamic-workflow/launch.md`, "The settings turn"). Like a launch turn it has no user bubble
and its card is the new run's card; above the card one row says what changed, in the tool row's
one-line style: the sliders icon, "Settings changed" / 「已调整设置」, then one segment per changed
setting, "subagents on {model}" / 「子代理改用 {model}」 or "subagents back on the session model" /
「子代理改回会话模型」, "at most {n} at once" / 「最多 {n} 个同时运行」 or "limit back to the
default" / 「上限恢复为默认」, then the turn's time, separated by `·`, in subtle grey.
The model is the resolved label (`describeWorkflowSubagentModel`). The row is a record, not a
control. It is the turn's first node, so the turn keeps no top padding above it (see "The run
card" above). The old run's card stays where it is. When the change stopped it, the card turns into
"Workflow superseded" from the run state alone, which also takes its Configure, Stop and Resume
away; a run that had already stopped or errored keeps its card as it was
(`docs/dynamic-workflow/launch.md`, "The settings turn"). A settings turn of an unnamed run has no
name, and its card shows the fallback word like any unnamed run.

A **retune**'s settings turn is that row and nothing else: no card under it. Its metadata
carries no `predecessorRunId` (`docs/dynamic-workflow/launch.md`, "The settings turn"), which
is the signal — the run it names is the one whose card is already in the transcript, live and
unchanged in identity, and drawing a second card for it would read as a second run. The row
carries one segment, "at most {n} at once" / 「最多 {n} 个同时运行」 or "limit back to the
default" / 「上限恢复为默认」, since parallelism is the only thing a retune
changes, and no card anywhere turns into "Workflow superseded", because nothing was superseded.

### The settings popover

The card's Configure button, the pane's Configure button and the pane's model segment open one
popover (`components/workflow-timeline/WorkflowRunSettingsPopover.tsx`), anchored under the
control that opened it and aligned to its end. Its parts, top to bottom, in a `w-72` shell
(`PopoverContent`, `p-2.5`, 10 px between parts):

| Part | What it is |
|---|---|
| Title | "Configure workflow" / 「配置工作流」, `text-ui-base font-medium` |
| Subagent model | label "Subagent model" / 「子代理模型」; the composer's model list (`ModelConfigSelect`, the same groups the settings page's subagent select reads), with **the session model** as its first item carrying the "session model" / 「会话模型」 badge; the trigger shows the run's model, or the session model with the badge when the run has none. Beside the trigger, the thinking-level control the settings page uses for subagents (`SubagentReasoningField`), only when the chosen model has reasoning levels; picking a model sets its default level. A model the run is on but the list no longer offers is shown by its name with an "unavailable" / 「不可用」 badge; Apply then waits for another choice. When the workspace lists no models the field is the sentence "This agent has no model catalog; subagents stay on the session model." / 「当前 agent 没有可选的模型目录，子代理沿用会话模型。」 |
| Max concurrency | label "Max concurrency" / 「最大并发数」, the word the run pane's concurrency chip uses, so the chip and the control that sets it read the same (the minus and plus carry "Lower max concurrency" / 「降低最大并发数」 and "Raise max concurrency" / 「提高最大并发数」); a stepper (`InputGroup`: minus, a `w-9` mono number, plus) from 1 with no upper end, starting at the run's own bound or the default parallelism (`run.concurrencyCeiling`) when it has none; to its right in subtle text "default {n}" / 「默认 {n}」, which becomes "= default" / 「= 默认」 when the value is the default. The value at the default means no bound of the run's own. A run state without a default (an older agent) gives no hint |
| Sentence | one line, `text-ui-sm` subtle, chosen by what applying will actually do, so it says nothing until a field differs from the run: with Apply disabled there is no consequence to describe, and a guess made before the edit is wrong for one of the two fields (the stepper can apply in place, the model never does). The line keeps its one-line height while empty, so the first edit does not push the footer down. When the stepper is the only field that differs and the run is **running**, applying retunes that run in place and the line says so: "Applies to this run right away; no new run is started." / 「立即应用到当前运行，不会新起一次运行。」 A `pending` run keeps its own sentence even for a stepper-only change: its engine may not exist yet, in which case the agent falls back to an ordinary amendment (`docs/dynamic-workflow/launch.md`, "Changing only the parallelism of a live run"), and a promise of "no new run" is one this state cannot keep. Otherwise the line is the run state's: running "Stops this run and starts a new one with these settings; finished steps are kept." / 「将停止当前运行，以新设置另起一次运行，已完成的步骤会保留。」; pending "Starts a new run with these settings; this one has not begun any step yet." / 「将以新设置另起一次运行，当前运行尚未开始任何步骤。」; stopped "Continues as a new run with these settings; finished steps are kept." / 「将以新设置另起一次运行接着跑，已完成的步骤会保留。」; errored "Retries as a new run with these settings; finished steps are kept." / 「将以新设置另起一次运行重试，已完成的步骤会保留。」. The line follows the fields as they are edited, so touching the model select after moving the stepper brings the restart sentence back, and putting both fields back empties it again |
| Rejection | only after a rejected Apply: the reason's line from `docs/dynamic-workflow/launch.md` ("The command") in the pane's rejection style, `text-ui-xs` warning, with the ACK's message in a bounded mono block when it carries one. It clears when the user changes a field |
| Footer | **Apply** / 「应用」, right-aligned, `h-7` primary; disabled while neither field differs from the run; while the command is in flight it shows a spinner and "Applying…" / 「应用中…」 and the fields are disabled |

Opening the popover starts both fields from the run's current settings. Apply sends
`amendWorkflowRunSettings` with only the fields that differ: the model as its canonical
`providerId/modelId[$level]`, `null` for the session model; the bound as a number, `null` for
the default. A changed thinking level alone counts as a changed model. An accepted ACK closes
the popover; nothing else in it changes, because the new run arrives through the projection
like any other. Escape and a click outside close it without applying.

After an accepted Apply, a run pane showing the old run **follows the workflow**: its tab is
replaced in place by the new run's, keeping its place in the tab strip and its name, as soon as
the new run is in the projection. A pane that is closed or showing another run is left alone.
The card needs nothing: the old card turns into "Workflow superseded", and the new card arrives
with the settings turn.

A retune moves nothing. The ACK names the same run the popover was opened on, so there is no
new run to follow and no tab to replace: an open pane keeps showing the run it was showing,
which is the run that changed. What the user sees is the chip re-reading its bound, and the
settings turn arriving with its row over that same run's card
(`docs/dynamic-workflow/launch.md`, "Changing a run's settings from the GUI"). The client needs
no flag for this — an ACK whose `runId` is the one it sent, with no `supersededRunId`, is a
retune.

## The run pane

The side pane tab `workflow-run` is identified by `(parentSessionId, runId)` and carries
`toolCallId`, an optional frozen `workflowName` and an optional `focusPhaseId`. It is never
garbage-collected: it outlives the eight-run projection window and degrades, never closes.
Opening it again with a `phaseId` lands on that phase; a request without one deletes the
previous landing, and `openedAt` is refreshed each time so re-clicking a station lands
again.

The pane (`app-shell/WorkflowRunSidePane.tsx`) subscribes to the parent session's
projection, finds its run by id in `workflowRuns.runs`, and finds its graph by the tab's
tool call id in the same table the run card uses (`buildWorkflowGraphByToolCallId`): the
`CreateWorkflow` tool row's display or, for a directly launched saved workflow, the launch
turn's `workflowLaunch` display. A graph with no steps counts as absent. A run started by
Configure (tool call id `settings-…`) whose settings turn has not landed yet, because the main
agent is mid-turn, takes its predecessor's graph through `resumedFrom`: its script is the
predecessor's by construction. No other run borrows a graph, since a revised script draws a
different one. Top to bottom:

1. **Status header**, two rows and the lines under them. The first row holds the name in mono
   (it is an identifier) and the controls: **Configure** (an outline `sm` button with the sliders
   icon and the word "Configure" / 「配置」) when the run can be configured
   (`docs/dynamic-workflow/launch.md`, "Which runs can be configured"), a **Resume run**
   button only when `resumable`,
   and **Stop run**, always rendered, disabled unless the run is `running` ("Only a running
   workflow can be stopped."). A completed run adds the completion card's own verb before
   Stop — **Save** 「保存」, or **Run again** 「再次运行」 once the run has a saved workflow — with
   the same popover and the same launcher behind it
   (`transcript-and-notifications.md`, "Saving the run, and running it again"); the 「已保存」
   chip sits on the second row, after the status word. The second row holds the run lamp and word with the stop reason
   ("Stopped · superseded" for an amended-away run) and the **concurrency chip** "Max concurrency
   {cap}" / 「最大并发数 {cap}」, shown while the run is held below its own bound or has a bound of its
   own, **and** the run can be configured, with "cooling down until {time}" while a cooldown is pending
   (see `docs/dynamic-workflow/concurrency.md`, "What the user sees", for why). The status moved to a
   row of its own because three buttons beside it crowded the first row. Under the rows, a lineage
   line when the run has one ("Amends run {id}", or "Superseded by run {id}" as a link that opens
   the successor's pane). Stop carries the same filled square as the card, and, while it
   is enabled, the same second tooltip line, "You can resume later; finished steps are
   kept.": the verb was read as "discard" and a stopped run is resumable. A Stop or Resume
   the agent rejects draws a one-line **rejection hint** under the buttons, in the warning
   colour, worded from the ACK's reason code ("This run is not running in this agent, so
   nothing was stopped.", "The stored script no longer compiles with this version of the
   workflow facade. Ask the agent to amend the workflow instead of resuming it.", and so on;
   an unknown code falls back to a generic line naming it), with the ACK's message, when it
   carries one, in a bounded mono block underneath (the `compile_failed` diagnostics). The
   hint is remembered together with the run status it was raised under and disappears as
   soon as the status changes; it is never a toast and never blocks the buttons. Under it
   the summary row: "Subagents {model}" / 「子代理 {model}」 first, only when the run chose a
   model for its subagents (`docs/dynamic-workflow/launch.md`, `subagent_model`); when the run
   can be configured this segment is also a button, underlined on hover, that opens the same
   settings popover anchored to it; then
   "{n} agents working" or "{n} agents", "{done}/{total} steps",
   "{tokens} tokens", "round {r}" (live) or "{r} rounds"
   (settled) when any loop station has two or more rounds, "{n} artifacts" when any. The model
   belongs to this row rather than to a chip in the line above: the row is already the run's
   handful of numbers, and the model is its first word. The name is the resolved label; the
   reasoning level and the canonical string are in that segment's tooltip. Under the
   card's condition (a `truncated` run listing fewer instances than it has) the pane adds
   the card's line under the row, "Details shown for {shown} of {total} steps" /
   「仅展示 {shown}/{total} 步的详情」, in the same subtle text: the spine below lists the
   instances the key kept, and the numbers in the row count them all. When there is no
   graph the row degrades to the old usage line, 「用量：N tokens · M 步」, and the model segment
   still opens it: the model is a condition the user set on the run, so whether the graph is in
   the visible row window has no bearing on it.
2. **Provenance**, directly launched runs only (`workflowRunLaunchProvenance.ts` finds the
   launch turn's metadata by tool call id, header first): 「由你从工作流中枢启动 · {time}」 with
   the scope badge, the description, and a key/value table of the arguments. A run started by
   Configure has the same block with its own words: "Settings changed by you · {time}" /
   「由你调整设置 · {time}」, no scope badge, and one line per changed setting, "Subagent model"
   / 「子代理模型」 and "Max concurrency" / 「最大并发数」, reading "{from} → {to}" (the session
   model's word or the default for an absent end). Tool-started
   runs have no such block; their origin is the `CreateWorkflow` row in the transcript. A run
   whose parallelism was retuned keeps whichever block it had: the block says how the run
   started, and a retune did not start it. The change shows in the header's concurrency chip
   and as the 「并发上限 8 → 2」 line in the event log
   (`docs/dynamic-workflow/concurrency.md`, "What the user sees").
3. **Result panels**, at most one: for a run not in the projection, "No longer tracked
   live" with "This run is outside the most recent runs kept for live status. Its record is
   still complete."; for `completed`, "Result" with the hint that the result went to the
   conversation as a background result (a result preview is in the schema but never
   filled); for `errored` or `stopped`, "Run errored" or "Run stopped · {reason}" and the
   error text or "No error detail was recorded.".
4. **The spine**, or, when there is no graph, "The workflow graph is not in this
   conversation's visible history."
5. **Artifacts**, only when the run has any: a collapsible section, open by default, with the
   count in the header. With a primary (the flagged artifact, or the sole artifact): the
   deliverable row (frame 160 × 100, or 136 × 85 when the section is narrower than 380 px,
   by container query), a hairline rule, then the rest as the **index**: one line per
   artifact, a single column, no cap (see `transcript-and-notifications.md`, "The index");
   the collapsed header keeps the primary's title after the count. Without one, a gallery of
   tiles 130–180px wide, a size at which a thumbnail is legible (see authoring.md and
   `transcript-and-notifications.md`, "Artifact tiles"). The list is primary first, then
   publish order.

### The spine

`WorkflowRunPhaseList` reads the same timeline model vertically. A rail runs 21px from the
left edge; each phase is a section whose header holds the lamp on the rail. Rails are drawn
in two halves, from the lamp above down to its section's bottom and from the next section's
top down to its lamp, so a rail follows a section as it opens and closes without
measurement. Ink follows the model, but `faint` and `strong` render identically here (1px,
`foreground-subtlest`); only `march` is distinct, and here too it is lit rather than moving.
A march rail half is 1.5px (left 20.25px) and takes its gradient from `data-rail-position`:
the lower half of the previous section fades in from transparent to 70% warning, the upper
half of the running section runs from 70% to full warning into the lamp, and a `full` march
rail is a flat 70%. Back edges are not drawn in the spine; a loop shows as `⟳ n` in the
header. The running lamp is the card's lamp, `wf-lamp-running`, and beats with it; the spine
has no expanding ring of its own.

A band grows tracks here too, sideways, laid out like a commit graph: the rails on the left,
the text on the right, never sharing a column. Track t's rail runs at 21 + pitch × t from
the left edge, where pitch is 12px while the widest band has at most four branch tracks and
8px beyond. The lamp stays on its own track (left 16 + pitch × t) and alone says which line a
station is on. Everything else — every section header's content, every opened body, the
orphan-questions block — starts at one **text column** shared by the whole spine,
39 + pitch × (T − 1), T being the most tracks any band has; which track a station is on no
longer moves its text. Without a band T = 1 and nothing moves.

A fork and a merge happen *between* two phases, so each gets a 16px **joint row** of its own
between two sections, never a slice of a section's header. Every band has both: the fork row
stands just before the band's first section, the merge row just after its last. In a joint
row the main rail runs straight through, in the ink of the track-0 rail that crosses it (a
march there is the flat 70%). A band with no `pred` has an **open** fork row: its main rail
does not arrive from a phase above but starts 4px above the row with a round cap, the card's
`TAIL`, so the band reads as rising from one root point. A band with no `join` has an open
merge row, the mirror: the strands meet and the main rail stops 4px below the row, the
card's `STUB`. The stubs live in the row, not in a section, so nothing hangs off a header or
runs under a phase's pills. Every branch leaves it along one shared bus
at y = 8: down the main rail, a quarter-turn of radius min(6, pitch / 2), across to its own
column, a quarter-turn down, on to the row's bottom; with one track the two turns meet as an
S. The merge row is the mirror. A branch curve takes the ink of its track's `entry` (fork)
or `exit` (merge), and a marching curve is lit along its own path by the card's component.

A strand's rail runs from the fork row's bottom to the merge row's top. Rails keep their
per-section halves: a station's own track has an upper half where the strand arrives (from
the previous member, or from the fork row) and a lower half where it continues (to the next
member, or to the merge row); a track passes a section it has no lamp in at full height, in
the ink of the rail it is part of — the track's `entry` before its first member, its `exit`
after its last. The main rail passing a branch station's section is the same rule. Two bands
standing side by side have an open merge row followed by an open fork row, whose stubs meet.
A dissolved band (see "Bands and tracks") has no rows at all: its stages are one rail.

A **stream rail** in the spine keeps its two halves, each stopping 7px short of the section
boundary, and two chevrons pointing down stand in the gap, 5px apart and centred on the
boundary, in the card's three inks (`march` lighting in turn). Faint and strong chevrons differ
here even though faint and strong rails do not: the chevrons are where the stream's state is
read. A stream arc is not drawn in the spine, like any other arc.
A band whose every strand is a single phase, with nothing before or after it, is still drawn
whole: a root, one line per phase, a sink. The spine draws no twin: the fork and the merge
already say what it would.

A section header is a 36px button "Show phase {name}" / "Hide phase {name}": lamp, name
(subtle when pending), and on the right, in mono: while collapsed, an **avatar cluster** of
up to three faces and `+n`, or a 44px **mini meter** when the station is a roster (segments
done · failed · running · pending over its participants, listed and unlisted, widths
proportional, pending as the track); then `settled/observed`; then `⟳ n`; then a chevron. Every running phase opens
itself when it starts running, not only the rightmost, and nothing the user opened is
closed. A landing (`focusPhaseId`)
opens the section, opens its roster door, scrolls the header to the top and highlights it
for 1.2s.

Open, a section lists its pills as full-width rows: the same pill, with "{n} tasks · {n}
reads" as children. A subagent whose persona names a model adds its resolved label
(`describeWorkflowSubagentModel`) to those children, "{n} tasks · GLM-5.3-Flash", and the
canonical string to the row's tooltip; a subagent on the run's model says nothing, since the
summary row already names that. An agent row opens the subagent's transcript tab whether or not it has
started; a workspace row opens the script transcript at this phase. Pending **questions**
render under their asker's row, indented a further 26px: icon, asker name, question,
context, a waited-for label ("just now", "{n}m ago", …) ticking every 30s while any question
is pending, and the question id. Questions whose asker is not on any row collect in a block
after the last section titled "Waiting on an answer", each naming its asker. The pane is
read-only; the main agent answers.

Past six participants the section shows the five pinned rows and then the **door**: the
same "{n} more" row with a chevron in the tail instead of `↗`, `aria-expanded`, and, while
closed, a tally of the rest (`✓ n · ◌ n · ✕ n · ○ n`, zero counts omitted). Open, the tally
moves into group headings and the door's background rises. Behind it is the **roll**
(`WorkflowRoll`): only the unpinned participants, each once, grouped by status in attention
order (failed, running, pending, done; empty groups omitted), two columns of `row`-size
pills landing 8ms apart (capped at 400ms). A group heading is the count and word with a
hairline to the edge. An asker in the roll carries a small warning `?`; its question text is
not repeated there.

The door and its tally count this station's unlisted agents as well, and the roll cannot: an
agent the tables do not hold has no row to land in, and a group heading counts the rows under
it. So a station with unlisted agents ends its roll with one subtle line, "{n} more agents not
listed", in the type of the truncation notice; the line does not call them finished, because
the bound also keeps out agents that have yet to run. The difference between the door's count
and the rows below it is then something the reader is told rather than left to find.

### Subagent transcripts

An agent pill opens the tab `workflow-actor-session`, identified by `(runId, siteId,
ordinal)`, with `actorSessionId` optional: a pill for a subagent that has not started opens
the same tab that its started self will, and reopening merges the session id in. The pane
(`WorkflowActorSessionSidePane`) acquires the parent projection synchronously during render
and gates on `workflowActorStartState`: the actor is found by `(siteId, ordinal)`; **started**
when any node of that actor has left `queued` — a cache hit included, since it names its actor
("Reduction"); **notStarted** when the actor exists with no such node, or is unknown and the tab
has no session id; **unknown** when the actor is not in the projection but the tab has a session
id (an evicted or replayed run), in which case the transcript subscribes anyway. A started pane
subscribes to the actor's `sessionId`, which is the session **holding its transcript**, not
always the one minted for this run: a subagent of an amended run whose every answer so far came
from the predecessor has no session of its own — the cache hit created none — so its `sessionId`
is the predecessor's session the answers were read from, and it becomes the subagent's own
session at its first live dispatch, which is seeded with that same prefix. The predecessor's
session is shown whole, so it can run past the asks this run consumed; the pane reads it, it
never writes it. A run recorded before cache hits named their actor keeps the old failure: the
hit cannot be attributed, so the pane says not started. Not started renders "Not started yet"
("This subagent has not been asked anything yet. The transcript appears here as soon as its
first step is dispatched.") and mounts no session pane; the first dispatch flips it. The gate
must decide before the first frame, because a subscription to a session that does not exist yet
fails into a store the data layer keeps warm for 30 seconds. A workspace pill opens the script
transcript instead (`docs/dynamic-workflow/transcript-and-notifications.md`).

## The run state the pane draws

Every engine event becomes a session event, `dynamic_workflow_run_progress`, appended to the
**parent** session outside any turn, with payload `{runId, toolCallId?, sequence, eventType,
payload, truncated?, actorSessionId?, resumable?}`. The v4 projection reduces it with
`reduceWorkflowRunsState` (`packages/shared/src/zcode-protocol-v4/workflow-runs-reducer.ts`)
into the snapshot key `workflowRuns`, which every snapshot carries whole. On the wire an
event sends only what it changed: one `workflowRun.updated` op naming the run, carrying the
header fields that changed, the header keys that became absent, the actors and nodes the
reduction evicted, and the whole entries for the actors and nodes that changed — at most one
op per changed run per event, plus a `workflowRun.removed` for a run the projection evicted
(`docs/v4-refactor/10-protocol-spec.md`, §4.5). A client that did not negotiate those ops
keeps receiving the key as a whole in one `state.updated` patch, clamped to the bounds its
schema knows — the clamp keeps the participants that are still going, since those are the
rows the surfaces exist to show. The key carries its own
`revision` and does not bump the conversation revision (a run in flight would otherwise fail
every optimistic command). The journal that the events also go to is described in
`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`.

```ts
interface WorkflowRunsState { revision: number; runs: WorkflowRunState[] }   // ≤ 8 runs
interface WorkflowRunState {
  runId; toolCallId?; status: "pending" | "running" | "completed" | "errored" | "stopped";
  stopReason?: "user" | "model" | "provider" | "interrupted";   // stopped only
  usage: { spentTokens; nodesUsed; nodesUnlisted?; nodesUnlistedSettled? };
  error?; resumable?: true; resultPreview?;
  actors: { siteId; ordinal; name?; sessionId?; status: "waiting" | "running" | "completed"; phaseName?;
            model? }[];                                         // canonical, when its persona names a model
  nodes:  { siteId; ordinal; kind?; phase; outcome?; cached?; actorSiteId?; actorOrdinal?; phaseName?;
            instructionsHead?;                                  // the ask's assignment, first 240 chars
            turn?; toolCalls?; lastTool?: { name; target? } }[]; // how far into the ask it is, from node-progress
  reports?; pendingQuestions?; concurrency?; subagentModel?; artifacts?;
  phases?: { name; rounds }[]; currentPhase?; phaseNames?: string[];   // declared order, from run-launched
  phaseAlongside?: number[][];                                         // aligned with phaseNames, indexes into it
  unlistedByPhase?: { phaseName?; actors; actorsSettled?; actorsFailed?; settled }[];  // the bound's cost per phase
  truncated?: true; lastEventSequence: number;
}
```

| Bound (`WORKFLOW_RUNS_LIMITS`) | Value |
|---|---|
| runs kept | 8, oldest evicted |
| actors, nodes | 1024 each; a finished group, a settled loose node, or (for a dispatch) an idle group evicted to seat a newcomer |
| entries across the key | 6144 (nodes + actors, summed over the runs), oldest terminal run evicted |
| unlisted-by-phase buckets | 33 (one per phase plus the unphased one) |
| reports / preview chars | 64 / 2048 |
| pending questions / question chars | 32 / 2048 |
| artifacts | 32 |
| phases / phase name chars | 32 / 128 |
| actor name chars | 128 |
| subagent model chars | 256 |
| error chars | 2048 |
| instructions head chars | 240 |
| last tool name / target chars | 64 / 120 |

The last four node fields answer "what is this subagent doing right now, and is it moving",
which the phase alone cannot: an ask sits in `executing` for minutes at a time.
`instructionsHead` is the head of the author's own instructions for that ask, cut at the
source (the engine appends its epilogues afterwards, and they are not the assignment);
`turn` counts resolved model turns within the ask, `toolCalls` counts its tool calls, and
`lastTool` names the most recent one with a short target (a path, a command head) and never
its arguments. All four are absent on a journal written before the fields existed, and a
reader must show that absence rather than invent a zero.

Every optional collection is absent when empty rather than an empty array — which is why a
delta names the header keys that emptied instead of sending them as `[]` — and every
addition to this key has been optional: a required field an older CLI does not send would
fail the whole patch.

### Reduction

An envelope with no run id or no event type is rejected. An unknown run is seeded as
`pending` with empty collections; `lastEventSequence` only ever rises. An event that changes
nothing (byte-equal state) returns `null`, so a replayed event does not bump the revision.

| Event | Effect |
|---|---|
| `run-started` | status `running`, usage reset, and `error`, `resultPreview`, `pendingQuestions`, `resumable`, `stopReason`, `unlistedByPhase` of a previous life cleared. A run that is `truncated` additionally starts the life with **empty `actors` and `nodes`**: the new life re-emits every instance, and only an empty table lets each one be listed or counted exactly once — keeping a table that already lost entries would count a group evicted during the replayed prefix twice, once as unlisted and once as re-created. A run that never overflowed keeps its tables, so the ordinary resume still shows its history from the first event. `subagentModel` is read from the payload, trimmed, and kept only when non-empty and within its bound; an over-long value is dropped whole rather than cut, since a shortened model id is a false one. A payload without the key falls back to the value already on the run, like `resumedFrom`: a resume's second `run-started`, or an older CLI that does not send it, must not blank the model out of a run whose model has not changed |
| `run-launched` | `phaseNames` = the declared phase names in script order (cut to 32 × 128); absent when the script declared none. `phaseAlongside` rides with it and only with it: cut to the accepted names' length, each entry filtered to integers in range and never its own index, deduplicated, dropped when nothing survives. The only fields this event touches; it fires once per run life, so a resume keeps the table |
| `actor-created` | upsert by `(siteId, ordinal)`: name cut to 128, `sessionId` from the envelope's `actorSessionId`, birth `phaseName` cut to 128 (cut, not ellipsized: it is a join key), `model` from the payload's `model` (the canonical string the host resolved the persona's model name to; dropped whole past 256, like `subagentModel`). The `sessionId` is then kept pointing at the session that holds the subagent's transcript by the node events below |
| `node-queued` … `node-settled` | upsert by `(siteId, ordinal)`, and in a `truncated` run a new key only from a birth event or from a dispatch that carries the instance's birth facts, on an event that raises the watermark (see below); `kind` only on `queued` and on such a dispatch, else carried forward; actor ref and `phaseName` carried forward when absent; `outcome` and `cached` kept; the first `dispatched` of an instance counts one toward `usage.nodesUsed`. `instructionsHead` arrives on `queued` (cut to 240) and on a dispatch that repeats it, and is carried forward by the later events; `turn`, `toolCalls` and `lastTool` are carried forward the same way, except across the two **birth** events, which clear them. The birth events are `queued` and the cached `settled` the replay hit emits without a `queued`: a re-queued instance is a fresh attempt whose turn counter restarts at 1, and a cached settlement did not execute at all, so inheriting the previous life's "turn 9, 40 tool calls" would paint exactly the picture these readings exist to rule out. A cached `settled` still inherits `instructionsHead`, since the completion cache keys on the input and the instructions are therefore identical by construction; `queued` does not, since it may carry amended ones. An ask's cached `settled` carries its birth facts — `kind`, actor ref, `instructionsHead` — like the `queued` it replaces, so the node is attributed to its subagent even when the table never held the instance (an amended run always starts with none). The same two events move the listed actor's `sessionId`: an ask's cached `settled` sets it to the payload's `sourceSessionId` when present and to the envelope's `actorSessionId` otherwise, and an ask's `node-dispatched` sets it to the envelope's `actorSessionId`. The last such event wins, which is right because a subagent's asks settle in order and divergence from an import is monotone: import hits come first and name the predecessor's session, and from the first live dispatch on the subagent's own session holds everything, the imported prefix included. An event that brings neither id changes nothing, so a journal written before cache hits named their actor keeps the session `actor-created` gave. A dispatch that enters its subagent into the table (activation, below) builds the entry from the repeated birth facts, `model` from the payload's `actorModel` included, so a subagent evicted and brought back keeps its model label. |
| `node-progress` | updates `turn`, `toolCalls` and `lastTool` on the node that already exists, and nothing else — no phase, no step count, no actor status (a turn resolving is not a lifecycle transition). A field the payload does not carry readably keeps its known value; an instance the table does not hold (evicted at the bound, or progress before its `queued`) is ignored, like any other node event for an unknown instance. Last writer wins rather than a monotone max, so a re-queued ask may count down |
| `report` | upsert by `(siteId, ordinal)` into `reports` with a serialized preview; touches no node, actor or count |
| `artifact-published` | upsert by artifact id (a new version replaces its card), carrying `primary` when the record has it; `artifact-failed` is a no-op |
| `usage-updated` | `usage.spentTokens` = the event's absolute total. The reset on `run-started` is momentary for a run that already cost something: the engine emits this event with the restored (resume) or inherited (amend) total right after `run-started`, before any live turn (`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`, "Usage accounting") |
| `escalation-raised` / `-resolved` | upsert or remove by `qid`; the key disappears when empty |
| `concurrency-changed` | the `concurrency` block (`docs/dynamic-workflow/concurrency.md`) |
| `run-caps-changed` | the run's own bound inside the same `concurrency` block, by the rule `run-started` uses: `limit` when the new `caps.maxConcurrency` differs from the payload's `concurrencyCeiling` (the default parallelism), cleared when it equals it, and `concurrency` dropped when the shared side has nothing to say either; `concurrencyCeiling` updated when readable; the shared cap, key and cooldown untouched (`docs/dynamic-workflow/concurrency.md`, "Retuning a live run") |
| `phase-entered` | upsert `phases` by name with `rounds = max(rounds, ordinal)` (monotone, so a resumed prefix is a no-op); `currentPhase` always set, even when the phase table is full |
| `run-settled` | status for `completed` / `errored` / `stopped`; `stopReason` only when stopped; `error` cut to 2048; `resumable` only when the payload says so; pending questions and cooldown cleared |
| anything else (`log`, `compaction`) | raises the watermark only |

At a bound the table makes room before it refuses, because what a reader needs to see is the
work that is happening now, and at a bound that is exactly what a refusal drops. A **group**
is an actor together with every listed node that names it, and it has a class the moment it has
one, read off what its agent is doing **now**: **live** when one of those nodes is in
`dispatched`, `executing`, `waiting`, `repairing` or `nudged`; otherwise **idle** when one is
still `queued` (the agent is waiting for a slot — a settled ask behind it does not change that);
otherwise **finished**, every listed node settled. A listed actor with no listed node at all is
none of the three: it is a **zero-node** actor, either not asked yet or — on a journal written
before cache hits named their actor — one whose only asks were cache hits, whose settlements are
loose and name nobody. A **loose node** is a listed node with no actor ref (a world-read, or such
an older cache hit). A group or a loose node is **failed** when any of its node outcomes is
`failed` or `cancelled`. Table priority runs live > idle > finished > zero-node, and only an event
that raises the watermark ever evicts — a replayed one never does. Reading "idle" as *all* nodes
queued instead would leave an agent on its second ask in no class at all, and a table full of
those refuses a dispatch — the very symptom this rule exists to remove.

An agent becomes important when it is **dispatched**, not when it is queued, and that is the
whole shape of a wide fan-out: a phase emits every `actor-created` and then every `node-queued`
in its first seconds, so the first 1024 fill both tables while still queued, nothing is
finished, there is nothing to evict, and the rest are refused. The scheduler then dispatches
FIFO, so from the 1025th agent on every agent that runs is one of the refused ones. A full
table therefore admits on three occasions:

- **Birth.** An `actor-created` of an unlisted actor takes the place of one finished group, and
  a `node-queued` of an unlisted instance takes the place of a settled loose node when there is
  one and of a finished group otherwise. A queued newcomer never displaces a queued or a live
  incumbent, and with no finished victim it is refused.
- **Birth that cannot make a pill.** In a `truncated` run a `node-queued`, or an ask's cached
  `node-settled`, naming an actor the table does not hold is refused even when the node table
  has room: a node whose actor has no row draws no pill (`participant-model.ts` filters by
  `run.actors`), so listing it only burns a slot that a dispatched instance will need. Admitted, it would also be stuck: a node naming an
  actor is not loose, and a group is built from a listed actor, so such a node could never be
  evicted. A loose node is unaffected.
- **Activation.** A `node-dispatched` that repeats the instance's birth facts — its `kind` and
  actor ref, the actor's `actorName` and `actorPhaseName`, the node's own `phaseName` and
  `instructionsHead`, exactly what its `node-queued` and `actor-created` carried — admits that
  instance as a `dispatched` node when the table does not hold it, and admits its actor with it,
  built from those facts and the envelope's `actorSessionId`, when the actor is not held either.
  Room is made first: an actor slot takes one whole group, a finished one before an idle one and
  a **zero-node** actor only when there is neither; a
  node slot alone takes the newcomer's **own** settled nodes first, lowest table index first,
  one at a time until a slot is free, then a settled loose node, else a finished group, else an
  idle group — never a zero-node actor, which frees an actor row and no node row. A
  `node-dispatched` without an actor ref — an older journal, or the world-read dispatch the
  engine emits bare right after its own `node-queued` — behaves as it always did.

Every other new key at a full table is refused as before, with `truncated` set (never cleared);
in particular the cached `node-settled` that is *born* settled never evicts, since it never
executed and has nothing left to show. An existing key still updates: freezing a live instance
at `queued` would mislead more than omitting one. Eviction sets `truncated` too — the run's
tables no longer hold its own facts, which is what that flag says and what `run-started` reads
to decide whether the next life starts empty.

The victim is a pure function of the reduced state, so a cold replay of the same journal evicts
the same entries. Among finished groups and settled loose nodes it is a not-failed candidate
before a failed one (a failure is the one settled thing a reader still wants to find), then a
candidate from the phase that currently lists the most of them (the bound is spent where the
entries are crowded), then the lowest table index. Among idle groups it is the **highest** table
index instead: under FIFO the last agent born is the last one that will run, so it is the one
whose row is needed last. Zero-node actors go the same way, highest index first, and only at an
**activation** in a `truncated` run: they are last because evicting one costs nothing a reader
can see — the agent has no node, no fraction and no history in the table, and its own next
dispatch re-admits it with its facts (the `node-queued` in between is refused, which changes
nothing it could have drawn). Without the class a resumed wide run is stuck: `run-started` empties
the tables, the replayed prefix re-creates every agent, so a full actor table of agents whose
first ask has not come back yet — or, on an older journal, agents whose cache-hit settlements name
nobody — has no victim in any class and every later dispatch is refused — the original symptom,
one life later.
A live group is never a victim, and neither is the newcomer's **own**
group: a subagent on its fourth ask has three settled ones behind it, and a group that is being
handed work is not finished — evicting it would leave the new node in the table pointing at an
actor that is not, which is a running ask with no pill at all. Its own settled **nodes** are a
different matter, and an activation that needs only a node slot spends them first: the actor
stays, so the pill stays, and an agent gives up its own history before it takes another agent's
row. Without that an agent's dead weight can refuse its own next ask — the table full of asks it
has already finished, none of them evictable because they are its own.
Evicting a group takes the actor
and all its nodes out of both tables in a single reduction, by a filter that leaves the
survivors in order, and the newcomer is appended. When there is no victim the newcomer is
refused, exactly as at a bound without eviction.

Eviction is also the first thing that makes a table **shrink**, which costs one more rule, and
that rule applies **only to a run that is `truncated`**. In such a run a key new to a table is
admitted only by that instance's **birth** — `actor-created`, `node-queued`, or the cached
`node-settled` — or by the activation above, and only on an event that raises the watermark; any
other event for an instance the table does not hold changes nothing and is counted exactly as a
refusal at the bound, and `usage.nodesUsed` likewise counts a first dispatch only on a
watermark-raising event, since an unlisted instance has no row whose phase could absorb the
repeat. Without this a freed slot would take back an instance already counted as unlisted — from
a replayed event, or from a later phase of an instance the activation rule does not cover — and
the run would both list it and count it.

Below the bound nothing changes: any event may still create a row, watermark or not. The
reducer applies events under the watermark (it only refuses to lower it), and cold
materialization feeds a journal replay and live events to the same reducer, so a run that a
live event seeded before its journal prefix replayed has that whole prefix under the
watermark. Tightening every run would leave such a card empty — a regression in every ordinary
run, to close a hole that only exists once something has been refused or evicted, which is
exactly what `truncated` records.

An actor must never outlive its last listed node: with no node to derive from it settles into
a `pending` pill that nothing will ever move. So when a born-settled node is refused at a full
node table and its actor is listed and owns no listed node, that actor is removed with it — a
finished agent that cannot bring its node is not listed at all.

The converse — an agent evicted between two of its asks — is what activation closes. A finished
group is evictable even when the script will ask that agent again later, and a subagent kept
across phases, or asked once per loop round, is exactly that; but its next dispatch repeats the
agent's name, session and birth phase, so the actor is rebuilt from the dispatch and the ask
runs with its pill. What an agent loses by being evicted is its history: the earlier asks are
gone from the table and live on only in the counters and the journal.

An instance the table does not hold is still counted, in two optional counters on `usage`:
`nodesUnlisted` is how many instances the node table is not holding, `nodesUnlistedSettled`
how many of those have settled. So every total a surface shows is the run's real one and only
the per-step detail stops at the bound. An unlisted instance is **born** on a `node-queued`,
or on the cached `node-settled` a replay emits without a `queued`: the first raises
`nodesUnlisted`, the second raises both. Any other `node-settled` with no entry in the table
raises `nodesUnlistedSettled` alone. An evicted node raises `nodesUnlisted`, and raises
`nodesUnlistedSettled` with it only when that node had settled — an idle group leaves with a
`queued` node, which has not. An instance the table takes back at its activation lowers
`nodesUnlisted` again, never below zero: it is listed now, and a surface that both listed and
counted it would show one step too many. All of it counts only when the envelope's sequence is
above the run's `lastEventSequence`, so a replayed event stays the no-op it already is, and it
all resets on `run-started`: a resumed life re-emits the whole script prefix, a cached settle
for every instance that is done and a `queued` for every one that is not, and counting that
prefix a second time would double the run's totals. Absent when zero.

What the bound cost each phase is recorded in `unlistedByPhase`, one bucket per **birth** phase,
the bucket with no `phaseName` being the unphased one. `actors` is how many of that phase's
agents the actor table is **not** holding right now, whatever became of them; `actorsSettled` is
how many of those are known to have finished and `actorsFailed` how many of those failed; and
`settled` is how many unlisted settled nodes carry that phase. A group's phase is its actor's,
and the moves are: a refused `actor-created` raises `actors`; an evicted finished group raises
`actors` and `actorsSettled` (and `actorsFailed` when it failed); an evicted idle group raises
`actors` alone, since its agent is still going to run; an evicted zero-node actor likewise raises
`actors` alone, its outcome being unknown to the phase; the orphan rule raises both; and an actor
admitted at its activation lowers `actors` at `actorPhaseName`, never below zero. A refused
born-settled node whose actor is **not** listed adds nothing to the agent counters: that agent
was counted in `actors` under **its own** birth phase, which need not be the node's, and an
agent with two cached asks would otherwise be counted as settled twice. Node `settled` counts
the evicted settled nodes and the born-settled refusals, which carry a `phaseName` of their own.

Every bucket is then clamped to `actorsFailed ≤ actorsSettled ≤ actors`, and that clamp is the
law of the bucket rather than a repair: it is what lets `actorsSettled` fall as well as rise.
It has to fall, because an agent's group looks finished between two of its asks — an eviction
stamps it settled and its next dispatch brings it back — and the bucket cannot tell **which**
agent returned. Subtracting one from `actorsSettled` at an activation would therefore be a
guess, and in a wide fan-out a badly wrong one: hundreds of that phase's agents were refused at
birth and never settled at all, so each activation would drain a count that was never theirs.
The clamp errs only while a bucket is crowded — a returning finished agent leaves its settled
mark on some other unlisted agent of the same phase until the bucket drains — and the per-phase
numbers come right as agents are listed. The run-level counters are exact throughout.

A bucket whose numbers
are all zero is dropped and the key disappears with the last bucket. The table holds one bucket
more than the phase bound, and past it the attribution is dropped while the run-level counters
stay right: a station may lose a number, the run's totals may not lie. Absent when empty, and a
zero subkey absent. `workflowRunStepCounts` is unchanged — it reads the run-level counters,
which already cover both refusals and evictions.

Entries are budgeted across the key as well, and that budget evicts whole runs rather than
entries: when a reduction leaves more than `maxTotalEntries` nodes plus actors summed over all
runs, the **oldest terminal run** is evicted — never the run the event belongs to, never a
live one — until the sum is inside the budget or nothing is evictable. The rule is a pure
function of the reduced state, so a cold replay of the same journal in the same order evicts
the same runs, and a worst-case key stays inside the snapshot's byte limit.

After every actor or node event the actor statuses are re-derived: a run
that is no longer live makes every actor `completed`; else any node in `executing`,
`repairing` or `nudged` makes it `running`; else any node in `queued`, `dispatched` or
`waiting`, or no node at all, makes it `waiting`; else `completed`.

`resumable` is decided by the CLI, on the `run-settled` payload, by the same predicate the
resume command uses (`status === "stopped"`, whatever the reason); the UI never derives it
from status or error codes, since two predicates would one day disagree and show a button
whose command is refused.

### Cold replay

The projection is memory-only. When the CLI cold-materializes a session (`v4-bridge`
`loadPersistedEvents`, direct record hit only), it lists that session's most recent eight
runs from the journal, oldest first so both evictions — the run count and the entry budget —
match live arrival, skips runs already present in the session's memory events or live in the
process registry, and replays each run's stored events through the same minting function as
live progress into synthetic session events placed before the persisted ones.
**Report items past the projection's bound are never read.** The events are read with
`reportItems: {limit: 64}` (`execution-engine.md`, "Reading the journal"): every event comes
back, but a `report` event after the run's 64th keeps its instance, tag and time and loses its
`item`, which SQLite strips before the row reaches the CLI. The reduced state is the same as
from the full events, because the reducer keys report entries by instance and refuses new
ones once it holds 64, a `run-started` does not clear them, and each report instance is
emitted once (a replayed report is skipped silently). So the first 64 report events are
exactly the entries whose previews the reducer builds; for every later one it reads only the
instance — to set `truncated` — and the tag, to count the dashboard's items. A run that
reported 65,536 items rebuilds from a bounded read instead of its whole journal.
**The settle is minted from the row.**
For a run whose row is terminal, the trailing stored `run-settled` (when there is one) is
dropped and an in-memory `run-settled` carrying the row's status, stop reason (`user` when
missing), successor and failure takes its place at the same sequence; when the events end
before a settle (the process died, orphan reconciliation only rewrote the row) it is
appended after the last one; an App that closes under a live run does not leave this gap, because its engine writes its own `stopped(interrupted)` settle before the close resolves (`execution-engine.md`, "Engine ownership"). It is never written to the journal. The row is the status
authority and its codec already speaks the current vocabulary, whereas event payloads are
stored verbatim: runs settled before the terminal-state redesign carry `run-settled
{status: "cancelled" | "failed"}`, words the reducer does not know, and replaying those
verbatim left every such run `running` after a restart, with a Stop button that reached a
run the agent did not have. A settle mid-stream (a run cancelled and resumed in one
process) is real history and is left alone; the `run-started` after it flips the run back
to running as before. For a run settled with the current words the row-minted settle is
byte-identical to the stored one (the engine's settle event carries exactly the row's four
fields), so live and cold still run the same reducer over the same bytes, and every surface
shows the same state before and after a restart. The reducer itself never leaves a run live
after a `run-settled`: a status word outside `completed`, `errored`, `stopped` settles the run
as `errored` with the event's message (or a note naming the word). The TUI feeds the same
envelopes to the same reducer (`docs/dynamic-workflow/launch.md`).

### Joining cards to runs

`SessionPane` builds two tables from `workflowRuns.runs` once per snapshot
(`v4/workflowRunCardJoin.ts`): by `toolCallId` (runs without one have no clickable card and
are skipped) and by `runId` (needed because `toolCallId` keeps pointing at the original
`CreateWorkflow` row across a resume). A summary carries `runId`, `status`, `stopReason`,
`nodesSettled`, `nodesTotal`, `agents`, the whole run state, and `resumable`. Step counts
are `settled / observed`: a workflow has no static total, so the denominator is the number
of scheduled instances and never poses as a percentage. The pair comes from one helper in
`packages/shared/src/zcode-protocol-v4/`, `workflowRunStepCounts(run)` — `nodes.length +
usage.nodesUnlisted` observed, the settled entries plus `usage.nodesUnlistedSettled`
settled — which the card join, the timeline summary and the TUI mirror all read, so a run
past the node bound cannot show one total on the card and another in the pane. Opening a run
always prefers the projection's `toolCallId`, so the pane can find the originating row.

## Other places a run appears

The **status capsule** lists live runs (`pending` and `running`) in launch order. Each row
says which workflow, where it has got to, and how long, in two lines of fixed height (56 px):

- **Line one:** the Workflow icon, the name (one line, truncated; the fallback name
  "Workflow script" in the subtle colour when the run is unnamed) and, on the right, the
  elapsed time (`text-ui-sm`, subtle, tabular). The time uses the duration units without
  the "Running for" prefix and drops seconds past an hour (`1h 2m`). There is no time for a
  pending run or without a paired background work.
- **Line two** is the sidebar run line's vocabulary: the same `WorkflowRunRail` (lamps,
  trace segments, twin segments, the ±2 fold with `+n`), then the **phase words**. A running
  run's words are its burning phases joined by ` ∥ ` when more than one burns, else its
  current phase, else the status word. A pending run shows a hollow lamp and the status word.
  A run that declared no phases shows one running lamp and `{done}/{total} steps`, the only
  place steps still appear.
- A workflow work with no run in the projection (an older CLI) gets a **degraded row**: line
  one only (name and time), so the Stop entry never disappears.
- **Stop** is today's ghost button ("Stop", square icon) laid over the time. It shows on
  hover or keyboard focus within the row, and the time fades out under it. On a coarse
  pointer (no hover), it is always shown as a 32 px icon button in a third column, and the
  time moves to the end of line two. Stop is absent when the work cannot be cancelled. Its
  accessible name is the card's "Stop run".
- The row opens the run pane through a transparent sibling button when it has a tool call
  id. The button's accessible name carries the run's name, status and phase words, because
  the visible status word is gone.

The section header reads a running lamp and `{n} running`, the same whether the section is
open or folded (no longest-elapsed figure). Expanding the island never shows less than the
pill did: the section **opens when a live run appears** (the live count goes from zero to
one or more, including on entering a session that has one) and folds when the last run ends,
and clicking a pill that shows a workflow expands the island with the section open, even if
the reader folded it earlier. A fold by hand holds until the runs end or the session changes.
Terminals and Agents keep starting folded: they never lead the pill. Only the run list scrolls, at three and a half
rows so the half row shows there is more; the ended entry sits below the scroll area.

The capsule's **pill** (the collapsed summary) shows the first live run, ahead of every
other summary: the Workflow icon, the name, a lamp (running or pending), the phase words and
`+n` for the other live runs. The phase words keep their full width up to 45 % of the pill
and only the name is cut (the phase never shrinks, and its cap leaves the name the rest; a
fixed floor on the name would pad a short name with a gap): a name is recognised from its
start, a cut phase says nothing. A degraded run shows its name alone, with no lamp. A live workflow
outranks the to-do, goal and git summaries because while it runs it is what the session is
doing; the old reason to rank running work last (it repeated the composer badge's count)
does not hold for a name and a phase.

Below the rows, "ended workflows · N" opens the **run directory** tab (`workflow-directory`, one per session, no run
data): two sections, "Running" and "Ended", read from the journal's discovery query with a
limit of 64 ("Showing the {count} most recent runs only" when full), refreshed when the
projection's run count or settled count changes, never on node progress; rows without a
tool call id are dropped from both the list and the count so the two agree by
construction. The **composer badge** counts running workflows separately from terminals and
subagents; when the only running work in the session is one workflow with a tool call id,
clicking it opens that run's pane directly ("Open workflow details") instead of expanding
the capsule. A workflow launched directly from the hub draws the same **run card** in place
of the user bubble, joined to the same run (`docs/dynamic-workflow/launch.md`).

### The sidebar run line

A session that owns a live or unacknowledged workflow run grows a second line under its
title in every task list: the desktop sidebar (flat, grouped, timeline, pinned and archived
rows), the wide-screen web remote list and the phone task home. The line is the run at a
glance and nothing more: the lucide `Workflow` glyph (12 px, `text-foreground-subtle`), a
**mini rail** of 6 px lamps in the card vocabulary (`STATUS_DOT`: hollow pending, pulsing
warning running, success done, destructive failed) joined by 6 × 1 px segments that turn
from `--color-workflow-trace` to `--color-workflow-trace-strong` once control has passed
them, and the current phase name in `text-ui-sm text-foreground-subtle`. There is no halo,
no march light, no question chip (escalations are answered by the main agent, never by
the user), no subagent count and no arrow; those live in the hover tooltip, which reads
`{name} · {status}` over `{phase} · {n agents working} · {elapsed}`. An ended run shows a
neutral word in the same subtle colour, `Completed`, `Errored · {phase}` or
`Stopped · {reason}`; only the lamps carry colour. A rail with more than six stations folds
to the first running station ± 2 and a `+n` tail. A script that declared no phases draws one
implicit station named "Workflow". The line is a button: clicking it selects the session
and opens the run pane, the same jump the composer badge makes. The 32 px row becomes
52 px per line; a session shows at most two lines (live runs first in launch order, then
the most recent settled), the rest fold into a `+n` word. The leading 16 px slot (error,
unread, spinner) is untouched: the run line is a second channel, not a fourth priority.

**Acknowledgement.** A live run's line is always drawn. A settled run's line lingers until
the session is opened: the renderer keeps a bounded, persisted set of acknowledged run ids
(256, oldest evicted; localStorage on desktop, the phone keeps its own), and opening a
session acknowledges every settled run it carries at that moment. A run that settles while
its session is active is acknowledged at once, so the line folds under the reader's eyes
rather than lingering. There is no timer and no `settledAt`: the settled/acknowledged state
is a pure function of the sessions-index frame and the ack set.

**Collapsed project header.** When a project group is collapsed, the header shows a pulsing
running lamp beside the unread dot, with the count when more than one of its sessions has a
live run. Settled, unacknowledged runs do not roll up.

**Data.** The CLI's sessions-index projection derives a per-session `workflowActivity`
summary from the `workflowRuns` and `backgroundWorks` keys of the same snapshot, so the
sidebar never opens a session or subscribes to run progress:

```ts
workflowActivity?: {
  runs: {                       // ≤ 4: live runs in launch order, then the most recent settled
    runId; toolCallId?; name?;  // name = the workflow background work's title
    status: "pending" | "running" | "completed" | "errored" | "stopped"; stopReason?;
    startedAt?;                 // the background work's startedAt, for the tooltip's elapsed
    phases: { name?; status: "pending" | "running" | "done" | "failed";
              alongside?: number[] }[];     // ≤ 32, declared order; alongside indexes into this list
    currentPhase?; agentsWorking: number;   // actors with status running
  }[];
};
```

Phase statuses follow the card's rules: control flow first, then the run's own nodes. While
the run is live the current phase is `running`, every phase already entered is `done`, the
rest `pending`; a `completed` run marks the entered phases `done`; an `errored` run marks the
current phase `failed`; a `stopped` run leaves it `pending`. On top of that, a phase burns
`running` while the run is live and any node **born in it** is `executing`, `repairing` or
`nudged` — born in it meaning the node's birth phase name matches the station's, exactly or
by the 128-character prefix rule, the same rule the card uses. Nodes only ever add `running`;
they never rewrite `done`, `failed` or `pending`, so the failure word stays with control
flow. Without them two parallel phases could never burn at once, because control flow
remembers only the last marker while the first phase's subagents are still at work. A run
that is not live has nothing burning, even if a `settled` event never landed. The station
list is `run.phaseNames` when the launch carried one (`run-launched`, below), else the
entered phases plus the current one in entry order; with neither the list is empty and the UI
draws the implicit station.

`alongside` is the same fact the card reads, carried per phase as indexes into the emitted
list. It is filled only on the declared-table path, because the entered-phases fallback is a
different index space, and it is re-filtered after the 32-station cut. The line folds it into
bands with the card's `foldPhaseBands`, over the **whole** phase table before the ± 2 window,
so a band that straddles the window's edge is not torn in half; the mark rides the station,
not the segment. A segment between two declared-adjacent phases of one band on different
tracks is then a **twin segment**: two 1px lines 2px apart, same width and same ink rule as a
plain segment. The line does not read `phaseStreams` (they are not on `run-launched`), so a
pipeline's stages are a band here and draw twin segments, while the card and the spine draw
one line; both are true, the line's picture is only the coarser one. The window's anchor is
the **first** running station rather than the current
phase, which keeps a running band's fork in view. When more than one phase is running the
tooltip lists them all, joined by " ∥ ", in place of the current phase.

The summary is absent when the session has no run at all, so an older CLI changes nothing.
The same block rides the desktop host controller's task activity, the sessions-index
sidecar (`TaskListRowActivity.workflowActivity`) and the web-remote task target, and it
takes part in the summary equality check, so a phase flip, a settlement or a change in the
working-subagent count can never be conflated away. It does not make the list quieter:
every run progress event already advances `lastActivityAt`, which the same check compares,
and that stays true by design (the session ordering reads it as the activity fact).

**Phase names.** The run state never knew the full phase table, only the phases already
entered, so a rail could not show what lies ahead. `DynamicWorkflowRunSubmitRequest` carries
`phaseNames?` (the named `phases` of the causality graph, declared order, ≤ 32 × 128) and
`phaseAlongside?` beside it (`number[][]`, aligned by position with `phaseNames` and indexing
into it, absent when no phase has any). Both submitters (the `CreateWorkflow` tool, including
an amend, and the hub's direct start) fill them from one helper over one named-phase list, so
the two tables can never disagree about the index space, and a submitter that has no
`phaseNames` sends no `phaseAlongside` either. The engine journals both on `run-launched`
next to the input anchor, so a cold replay rebuilds them for free and an amend-resume gets
the new script's phases under the predecessor's anchor. The reducer reads `phaseAlongside`
only after it has accepted `phaseNames`: the table is cut to the accepted names' length, each
entry filtered to integers in range and never its own index, deduplicated, and the whole
field dropped when nothing survives — a payload is not a promise. There is no migration; the
fields ride the event like the names.

## Alternatives not taken

- **Reading a `future` call as blocking, for the display.** Drawing each stage as if its
  future returned before the next started gives a pipeline its single line cheaply, but the
  order is then source order, not data order: two futures with no channel between them draw as
  a false chain `A → B → writer` — the picture the parallel-phases work removed — and a plain
  rail between two stages claims the second ran after the first. Stream edges give the same
  line for every pipeline and leave independent futures a band.
- **Keeping the band and joining its stages with diagonal stream connectors.** Honest about
  concurrency, but it keeps every cost of a band of single-station strands: one row per stage,
  most of it empty line, the forks and merges bunched at the card's edges, the ledge folding
  branch tracks, and the diagonals crossing the leaders.
- **Moving dashes instead of chevrons on a stream rail.** Reads as motion from afar, but it is
  the look the march edge retired, and at rest a dashed rail is indistinguishable from the
  leaders and the sidebar's twin segment.

- **Editing the settings in place on the pane's summary row** (the model segment a menu, the
  chip a stepper): each change would start its own run, and the row has no room for the
  sentence that says so. One popover with one Apply makes a change of both settings one run.
- **Telling the retune row apart by a new display field.** Two shapes were available and both
  break old clients. Adding a `retune` key to the `create_workflow` display: all three of its
  schemas are `.strict()` over a frozen field set, so an unknown key does not degrade, it drops
  the whole tool result on a client that predates it. A display kind of its own:
  `toolOutputSchema.display` is a discriminated union, and an unknown kind is a parse failure on
  a version-pinned phone bundle. (Both hazards are bounded from 2026-09-21 onward — the envelope
  drops an unreadable display instead of rejecting the frame — but only for clients carrying that
  change. Against a client shipped before it, both shapes still break, so the decision stands
  until the fix has shipped everywhere that matters.) The row is therefore recognized from fields that already cross
  v4 — the input's shape, the absent display, the success status, the missing run join — and the
  tool's structured `retuned` block stays in the process (`docs/dynamic-workflow/launch.md`,
  "Changing only the parallelism of a live run").
- **A settings section in the pane**, with the card's button deep-linking to it: the most
  discoverable, but it spends about 70 px of header on every run and puts the card two steps
  from the change.
- **A node-and-edge board** (React Flow): phases as unfoldable modules, subagent cards
  inside each opened module with hand-off arrows between them, a docked inspector listing
  instances and facts, an expand dialog, a camera following the run frontier. Three
  surfaces gave one picture three click semantics and buried "where is the run now" under
  four levels; a rail with pills answers it at a glance.
- **Drawing the hand-off graph.** Inside a phase the reader wants to know who took part,
  not who followed whom; the pills are listed in hand-off order and the arrows are not drawn.
- **Kind-typed arrows, certainty cues** (dashed outlines, `?` designators, a key strip):
  each cost more reading than it paid; one arrow means "runs after" and nothing else.
- **Renaming lanes and steps by a model call before the confirmation window** (graph
  refinement): withdrawn; names are written once, correctly, when the script is written.
- **A rank strip** in the card header standing in for scrolled-out stations, and a **snapping
  viewport with arrows**, and **wrapping the rail onto several rows**: the ledge says which
  stations are out of view; a rail that wraps reads a leftward line as a back edge.
- **Reading `back` for arc direction**: a re-entry marker is a forward edge to the analyzer
  and points left on the timeline.
- **Shoulders or curves for arc terminals.** Keeping landings at the lamp's centre and moving
  every takeoff 8px to the side it leaves for fixes one arc in and one out, and fuses again at
  two takeoffs on one side. Bézier arcs separate in and out by angle, but change the card's
  orthogonal vocabulary, land arrowheads at every angle, and still meet at one point on the
  lamp. The terminal slots are the landing spread the card already had, given to takeoffs too.
- **A siding for a parallel phase** (the second phase on a short twin rail beside the first)
  and **span bars** (a Gantt row per phase, length by duration): the siding says "beside"
  without saying where control rejoins, and bars need a clock the projection does not have. A
  fork and a merge say both, in the vocabulary the timeline already speaks. The siding
  survives only on the ledge and in the sidebar, where a fork does not fit in 6px.
- **Drawing the `A → B` "next" edge inside a band**: the fork already says control passed
  through both, and an arrow between two parallel phases reads as "B runs after A", which is
  the one thing it does not mean.
- **One `march` edge for the whole timeline**: with two tracks running the single edge had to
  pick a winner, and the loser's fork went dark while its subagents worked.
- **Marching dashes and travelling light for the running edge.** The dashes came first: 4px
  warning dashes sliding along the march rail and arc on a 0.6s loop. They were the loudest
  ink on the card, on a clock that never agreed with the lamp's, and the card already spends
  a dashed vocabulary on a branch phase's leader (dotted 1 on 2) and on an arc revealing
  itself (`wf-draw`). A bead of the lamp's colour travelling the edge into the lamp read as
  the run being on its way from the previous phase to this one, and went quiet between beats.
  A solid 2px warning edge was the yellow line as such, louder than the lamp on a long back
  arc. Letting the lit edge breathe with the beat put motion back on the past and flashed a
  large area on a join or a long arc. Light spreading out of the lamp along the edge is
  travel again, pointed the other way.
- **A tally, meter and cell grid on the card** for large fan-outs: the card is a summary;
  the pane lists everyone.
- **PNG or hashed-hue avatars**: nine saturated images collapsed to hue at 16px and cost a
  megabyte; letters collide and drift with model naming.
- **Drawing the run's end** (a sink node, exit arrows): the last station is the end.
- **A floating pill above the composer** for the running workflow: the status capsule already
  houses live activity.
- **Timers as fallbacks** for the camera flight, the fold or the pen: state is synchronized
  by position and content, never by a clock.
- **A retiring lamp for `pending`** on cards: a pending card is pixel-identical to a static one.

## Open questions

- `handoffs` and `exits` are bounded, validated and transported, and nothing in the UI reads
  them since the board was retired. They stay because the contract is cheap and a reader of
  hand-offs (an inspector, a tooltip) is plausible; if none appears, they should go.
- The `march` edge is chosen by rules, not by time; nodes carry no timestamps. If they ever
  do, the edge should be the one from the station of the most recently settled node.
- There is no "phase left" event, so `phase("A"); if (x) { phase("B"); … } ask2` lights both
  A and B while `ask2` runs. Prompts discourage the shape; an exit event would cost a
  `try/finally` in lowering.
- A station re-entered from several phases reads `rounds` from node ordinals, which count
  per site: the k-th such station shows a round count that is really an instance count.
- The spine draws `faint` and `strong` rails identically; only the card shows the
  difference.
- The pane's roster tally orders done · running · failed · pending while the meter's
  segments run done · failed · running · pending; the meter's `aria-label` follows the
  tally.
- A band is only as good as `alongside`. An await the analyzer cannot resolve widens the
  ordering over everything in flight — the licensed direction, but it leaves the next marker
  with nothing parked beside it, so no band is drawn and the timeline reads as one straight
  line. The lamps still tell the truth, because they come from the nodes: two phases burn at
  once whether or not the picture forked. It is the failure mode the arcs already have, an
  over-approximation that costs detail rather than honesty.
- A forward edge between two tracks of one band is not drawn. The fork says control passed
  through both, but a reader who wants to know which member feeds which has no line to follow.
- Two bands standing next to each other with no station between them draw a plain main-row
  rail from the first band's merge point to the second's fork point, and neither band has a
  `pred` or a `join`. The shape does not arise today: a gap between two bands holds at least
  the phase that joined the first.
- The hover halo on a lamp serves the spine only. On the card the lamp is not inside its
  head button in either layout, so hovering a head never haloes the lamp; the running lamp's
  own halo and beat are unaffected.

### 代理完成徽标

Workflow 的 agent 头像与普通 subagent 复用左下角外叠完成勾徽标：`done` 时保留身份色和眼睛，停止头像动态，并显示圆形勾。代理条目末尾不再重复完成勾，保留可打开条目的悬停详情箭头；完成状态仍提供读屏文字。workspace / 未解析车道维持原状态标记。行内 4px、普通条目 8px 左内边距容纳外叠徽标，不改变头像尺寸或文字对齐。验收覆盖运行/完成/失败、可打开/不可打开、普通/紧凑条目、深浅主题，确认只有已完成代理显示徽标且没有裁切。
