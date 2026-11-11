# Dynamic Workflow: Launch Surfaces (spec)

Status: implemented. This document covers every way a workflow gets started, saved, found,
and inspected; `docs/dynamic-workflow/authoring.md` covers how the script is written, and
`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` covers what happens to
the run after it starts.

## The ways a workflow starts

A workflow run begins in one of six places. Each one ends in the same `port.submit` or
`port.amend` call on the run service, and from there the runs are indistinguishable: same
journal, same notifications, same cancel and resume, same run pane.

| Surface | Who starts it | Confirmation | Where the run lands |
|---|---|---|---|
| `CreateWorkflow` tool, inline `script` | the model | the confirmation window | the current session |
| `CreateWorkflow` tool, `saved` source | the model | the confirmation window, with a saved-source badge | the current session |
| `AmendWorkflow` tool | the model | none when the run being amended is this session's own and the amendment brings in no new provider; the confirmation window otherwise (see "Amending this session's runs") | the current session |
| 「运行」 (Run) on the hub page | the user | none: the click is the consent | a new, empty session in the workflow's project |
| Configure on the run card or the run pane (a new run of the same script under new settings; one change starts none, see below) | the user | none: the click on Apply is the consent | the session that owns the run |
| `/dwf resume`, the run pane's Resume, `ResumeWorkflowRun` | the user or the model | none | the session that owns the run |

Two clients bypass the window on purpose: the terminal UI and headless `-p` runs. See "The
approval bypass".

Two of the six start nothing under one condition. A Configure whose only change is the
parallelism, and an `AmendWorkflow` carrying nothing but `max_concurrency`, applied to a run
that is still live, retune that run in place: same run id, no new run, nothing stopped (see
"Changing only the parallelism of a live run"). Every other combination, and every run that is
no longer live, starts a run exactly as the table says.

The model learns about runs through completion and question notifications
(`docs/dynamic-workflow/transcript-and-notifications.md`) and through two read-only tools,
`ListWorkflowRuns` and `GetWorkflowRun`.
A run that reaches a hole asks the model for code through a hole notification and
`FillWorkflowHole` ("The `FillWorkflowHole` tool"), which starts nothing: it extends the run
that asked.

## The `CreateWorkflow` tool

### When the model may call it

Only when the user asked for a workflow: through `/workflow`, or in prose that names
workflow as the means ("use a workflow to …", "用工作流 …"). Then the call is mandatory,
however small the task, and size decides only how many subagents the script gets. Without
such a request the model does not start a workflow, whatever the task's shape; multi-step or
multi-subagent work goes to the `Agent` tool or is done inline. The tool description states
both halves, the `Agent` description repeats the first, and the authoring skill's routing
table follows the same rule (`docs/dynamic-workflow/authoring.md`, "The command").

A call that submits a script (`script` or `path`) is also refused until the
`dynamic-workflows` skill has been loaded in the session; the description says so and names
the `Skill` tool. Running a saved workflow by name is exempt. The gate, its probe and its
exemptions are specified in `docs/dynamic-workflow/authoring.md`, "The skill gate".

### Input and output

```ts
interface CreateWorkflowInput {
  name?: string;          // display label; defaults to the saved workflow's name
  script?: string;        // the script, inline
  saved?: {               // or: a saved workflow, by name
    name: string;
    args?: Record<string, unknown>;
    scope?: "project" | "global";   // disambiguation only
    path?: string;                  // filled in by the tool, never by the model
  };
  path?: string;          // or: a script file on disk (see "Script files")
  args?: Record<string, unknown>;  // values for the arguments a `path` file declares; with `saved`, use `saved.args`
  max_concurrency?: number;  // at most this many subagents work at once, above or below the default; omitted = the default parallelism
  subagent_model?: string;   // the run's subagents work on this model; omitted = the session's model
  adjustable_settings?: {    // filled in by the tool, never by the model (see "Adjusting the settings in the window")
    subagent_model: boolean;       // this host can resolve a model choice
    concurrency_ceiling?: number;  // the default parallelism D, when the run port can say (wire name predates the default)
  };
  model_bindings?: Record<string, string>;  // filled in by the tool: each model name the script uses → canonical (see "Models the script names")
}
```

`max_concurrency` is the run's own concurrency bound
(`docs/dynamic-workflow/concurrency.md`, "Two bounds on a run"). It has no upper limit:
`resolveInput` only floors it to a whole number of at least 1 before the window, so the
window, the hooks and the handler all see the value that will be in force, and the response
names it: "At most N subagents run at once", with "(the default)" appended when the value is
the default parallelism itself.

`subagent_model` points the run's subagents at a model other than the session's. The call
may carry the name the user said, a bare model id, or a full `providerId/modelId`, each of
them optionally carrying a `$reasoningLevel`; `resolveInput` resolves that against the host's
model catalog and rewrites it into the canonical `providerId/modelId[$reasoningLevel]` before
the window, so the window, the hooks and the handler again see the value that will be in
force. The response names it: "Subagents run on {model} (the main agent stays on the session
model)". The parenthesis is load-bearing. The main agent keeps the session model whatever
this field says, and without that half-sentence it reads "runs on X" as its own switch and
reports one to the user that never happened.

The field is the user's choice, never the main agent's. The agent sets it only when the user
asked for a model, passing the name they used, and it never moves the subagents to a model
under another provider on its own: another provider is another bill, and a cheaper-looking
model there is not a reason to act, only a reason to ask. When the agent sees that a lighter
or faster model elsewhere would serve the run, it asks the user before the call, naming the
model, the provider and what it would save, and takes their answer as the request. When the
user did ask for a model that lives under another provider, by that question or on their
own, that is fine; the agent then writes the full `providerId/modelId`, which is the
only form the resolver accepts for a model the session's provider does not have (see the
table below). The same rule binds the models a script names for its subagents
(`docs/dynamic-workflow/authoring.md`, "Choosing a model per subagent"). The permission rule
backs this up for the one path that has no window of its own: an `AmendWorkflow` of this
session's run that would bring in a provider neither the session nor the run used asks the
user like any other amend ("Amending this session's runs").

Exactly one of `script`, `saved` and `path` must be given, and `args` only with `path`. The
rule is enforced by the tool's `validateInput` on the model's arguments, not by the schema:
after normalization (below) the input legitimately carries `script` next to `saved` or
`path`, and a schema refinement would reject that shape in the handler and after any hook
rewrite. Whatever the source, the script ends up in a file the model edits between
submissions; see "Script files".

More than one source and no source are refused with different messages, because they have
different causes. More than one is a choice to undo. No source at all usually means the
arguments never parsed: when a tool call's arguments are not valid JSON, the model adapter
logs `model.tool_input.normalize_failed` and hands the executor `{}`, and `{}` passes this
tool's schema because every field is optional. A model that did write a `script` would read
"passing none is ambiguous" as a contradiction and resend the same broken call. The
no-source message therefore says that a call which does not parse arrives empty, names the
usual cause (an unescaped backslash or double quote inside the inline script, such as a
regex's `\d`), and offers `path` as the way around it. `EvalWorkflowSnippet` has the same
two messages for `code` and `path`; the other authoring tools have required fields, so an
empty call fails their schema first.

There is no predecessor field. Revising an existing run is `AmendWorkflow`'s job (below);
the input is strict, so a stray `resume_from` is rejected as an unknown key instead of
silently starting a full-price run. The two tools have the same output.

```ts
interface CreateWorkflowOutput {
  diagnostics: { code; line; column; message }[];
  ok: boolean;
  response: string;                 // the text the model reads
  causalityGraph?: ...;             // the bounded display payload
  status?: "backgrounded";          // only when a run started
  backgroundTaskId?: string;        // = the run id
}
```

When a run starts, the response tells the model the run id, that the result will arrive as
a notification, and not to wait for it or poll it with `TaskOutput`.

### From call to run

The tool executor runs these steps in order. The order is what makes the confirmation
window trustworthy: everything downstream of step 3 sees one and the same script.

1. Schema validation of the model's arguments.
2. `validateInput`: exactly one source.
3. `resolveInput`: the only disk read. For an inline script this is the identity function.
   For `saved` it reads the file, validates the arguments against the declaration, and
   rewrites the input to `{ name: input.name ?? savedName, script, saved: { name, args,
   path, scope } }`, where `script` is the saved body byte for byte and `scope` is the
   archive the lookup hit. A failure here (unknown name, malformed file, bad arguments)
   returns a structured error to the model before any hook or dialog. The same step floors
   `max_concurrency` to a whole number of at least 1 (the port floors it again on the way to
   the engine) and reads the default parallelism from the run port's optional
   `defaultConcurrency` member for the window and the response; with no port, or a port that
   does not implement it, the default is simply unknown. It also resolves
   `subagent_model` through the run context's optional model catalog port, ahead of the disk
   read, so a call that names a model this host does not have costs no file system work. An
   inline call whose bound is in range and whose model is already spelled the way the catalog
   spells it gains one key and nothing else: when a run port is present the step writes the
   `adjustable_settings` block the window reads (see "Adjusting the settings in the window"),
   overwriting any value the model supplied.
   For `path` it reads that file (relative to the session's working directory, or absolute),
   strips a `/* zcode-workflow` block when the file carries one, validates `args` against the
   block's declaration (and rejects `args` when there is no block), and rewrites the input to
   `{ name, script, path: <absolute>, args? }`. A missing or unreadable file is a structured
   failure naming the path. When the file (a `path` file, or a saved one) carries a metadata
   block, the same step records `script_line_offset`, the number of lines before the body,
   so diagnostics can be reported in file lines. See "Script files". Last, with the script
   in hand, it compiles it (the one-slot memo makes the later compiles free) and resolves
   every model name the script uses into `model_bindings` (see "Models the script names").
4. `PreToolUse` hooks and project permission rules. They see the resolved script, so a rule
   that scans workflow scripts applies to saved workflows too.
5. The permission check. `CreateWorkflow` declares `alwaysAsk`, so the check goes straight
   to the always-ask branch (see "Why the window always appears").
6. `prepareApproval`: compile the script. Diagnostics mean no window (see below), and so does
   a model name the script uses that `model_bindings` does not bind. A clean compile produces the `create_workflow` display payload, the bounded graph the window
   draws, and the ask is raised.
7. The user answers, or a `PermissionRequest` hook answers first. An allow answer may carry
   the settings the user changed in the window; the executor applies them to the input
   through the tool's `applyInputAdjustments` before the handler runs (see "Adjusting the
   settings in the window").
8. The handler compiles once more (a one-slot memo makes this free). For an inline source
   it first writes the working copy into the drafts directory ("Script files"); this
   happens before the compile result is read, so a script that fails to compile is on disk
   too (a saved source's copy was already written in step 3). It then calls `port.submit`
   with the script, `cwd`, `name`, `args`, `scriptPath` (the draft, the saved copy, or the
   `path` file itself), the parent session id and the tool call id, and returns
   `backgrounded`, naming the file. When the user adjusted the settings, the response says
   so before anything else about them.
9. The executor records the run in the background-task tracker.

The catalog port reads the live registry view on every call, never a copy taken when the
session was assembled, so a provider the user added or removed mid-session is visible to the
next `CreateWorkflow`. Against that listing, `subagent_model` resolves by specificity:

| What the field says | What it resolves to |
|---|---|
| `providerId/modelId` | that entry |
| a bare `modelId` the session's own provider has | that provider's entry, whatever other providers also have it |
| a bare `modelId` only other providers have | a failure naming their full ids: a bare name never crosses the provider boundary, so moving the subagents to another provider is always written out as `providerId/modelId` |
| a bare `modelId`, when the session's model is not in the catalog | the entry when exactly one provider has it; otherwise a failure naming all of them (there is no provider boundary to keep) |

The provider boundary is the resolver's part of the rule above: a model id that happens to
exist under one more provider than the user has in mind (the same model on a personal key
and a team plan, say) is never picked up from the other one in silence, and the one form that
does cross the boundary is the one the agent writes only when the user asked for it.

Provider and model ids compare case-insensitively, since a registry publishes no display
name distinct from the id, and the canonical string is written in the catalog's own spelling
so it pastes back into a later call unchanged. A `$level` must be one of that model's
reasoning levels; without one the model's default level applies, and a model with no levels
takes no level at all. A disabled entry never matches quietly: when every match is disabled
the call fails and names the reasons, because choosing around it would hand the user a model
they did not ask for and choosing it would fail at the first subagent ask.

### Models the script names

A script may name models for its subagents (`docs/dynamic-workflow/authoring.md`, "Choosing a
model per subagent"). The compiler guarantees the set of names is closed, and the analysis
hands it over as `modelReferences`, one entry per occurrence with its line and column. The
last part of `resolveInput` resolves each distinct name with the same resolver and tiers as
`subagent_model` and writes the successes into the input:

```ts
model_bindings?: Record<string, string>;  // name as written in the script → canonical providerId/modelId[$level]
```

The key is the name exactly as the script spells it, because that string is what reaches the
host at run time: lowering erases `model("x")` to `"x"`, and the persona carries it verbatim.
Like `adjustable_settings`, the block is always overwritten, absent when the script names no
model, and not in the model-facing schema.

A name that does not resolve is not a structured failure of the call, as an unresolvable
`subagent_model` is; it is a fault in the script, and it takes the road of a compile error. It
gets no binding, `prepareApproval` sees a name without one and raises no window, and the
handler reports diagnostic 9011 at the name's first occurrence, in file lines, with the
resolver's own diagnosis and candidate list, then the usual note naming the file to edit
("Failures that never reach the window"). One diagnostic per distinct name, not per
occurrence: the candidate list is up to forty lines. On a host with no model catalog every
name fails with "This host cannot choose models; remove `model` from the personas".

The handler hands the bindings to the port as `modelBindings` (structured selections); the port
records them once, as canonical strings, on the `run-launched` event beside `subagentModel`, and
never infers one. When a subagent's session is created, the host looks up the persona's name in
that table (`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`, "Subagent
sessions"). A resume reads the table back from the event, so the names keep the models they
were launched with, whatever the catalog says by then.

A hole's body may name only models already in that table. The fill service checks the
effective script's names against the run's table and reports a name outside it as 9011 at
its first occurrence, in the fill file's lines, listing the names the run has; nothing is
spliced and the hole stays waiting. The table is never extended by a fill: the fill window
shows no model rows, so a model added there would run without the user ever having seen it,
and a second binding fact would have to be read back by resume, replay and introspection.
A run that needs another model is revised with `AmendWorkflow`, whose window lists them.

The response adds one sentence when the table is not empty, after the run settings:
"Models named in the script: "{name}" = {canonical}; …". Like the settings sentence it names
the canonical value, which the model can paste into a later call.

### Failures that never reach the window

A script that does not compile never asks the user anything, in any permission mode. The
gate returns `proceed`, the handler runs, and the model gets the diagnostics as
`{path}:L{line}:C{column} {message}` lines in file lines ("Diagnostics in file lines"),
plus a note that nothing was executed and that the file named is the one to edit and
resubmit with `path`. For a saved source the note says which saved workflow the draft was
copied from, so the model knows the fix belongs in a copy and the definition needs
`SaveWorkflow` if it is to change. Asking a user to approve code that cannot run would
interrupt the model's own fix-and-resubmit loop with a decision that has no effect.

TypeScript errors end the analysis: the analyzer's own rules run only on a script without
them, so a script can show its analyzer errors only after its TypeScript errors are fixed.

A model name in the script that the catalog cannot resolve is reported the same way, as
diagnostic 9011 on its line (see "Models the script names").

A `subagent_model` the catalog cannot resolve never reaches the window either, but as a
failure of the call rather than a diagnostic, since the field is an argument, not script. The
tool returns a
structured failure carrying the diagnosis and the ids that do exist, one per line, the
session's own model marked `[current]` so the model can see that picking it is the same as
omitting the field, capped at forty lines and closed with "Pass one of these ids, or call
ListModels". No window appears and nothing starts. A host with no model catalog refuses the
field outright ("This host cannot choose a subagent model; omit subagent_model") rather than
passing down a string it cannot check, which would surface only at the run's first subagent
ask, long after the user approved it.

When the session has no run port (a host without workflow execution), a clean script is
reported as compiled and not executed. The tool never pretends a run started.

## The `AmendWorkflow` tool

Amending is how a run gets a revised script: a new run, with its own id, that imports the
predecessor's finished work as a cache (`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`,
"Amend-resume"). It is a separate tool from `CreateWorkflow` because it is a different act
with a different display: the model is not starting something, it is changing something the
user is already watching, and the predecessor may still be running.

A revision does not have to touch the script. Every field of the tool follows one rule: omit
it and the new run keeps the predecessor's value. A call that only changes the parallelism,
moves the subagents to another model or renames the run passes `run_id` and that one field,
and the new run runs the predecessor's recorded script under the new settings. The
predecessor's finished work still replays from the cache, so only what it had not finished
runs live under them. The new run supersedes the old one all the same: a running
predecessor is stopped and its unfinished asks run again. A subagent that was mid-ask when
the stop came runs that ask again with the partial exchange it had already produced, so the
work inside it is not thrown away — the engine document ("How the engine consumes the cache")
says when that carry applies and when it does not.

One combination is not an amendment at all. A call carrying nothing but `max_concurrency`,
against a run that is still live, retunes that run where it stands and starts nothing (see
"Changing only the parallelism of a live run"). Everything below this paragraph describes the
amendment, which is what every other call is.

The amended run's token figure, on its completion card, in the run pane, in `GetWorkflowRun`
and in the run history, is the cost of the whole lineage: it starts at the predecessor's total
and adds only the revision's live turns, so a chain of amendments sums by construction. The
predecessor keeps its own figure (`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`,
"Usage across the lineage").

### Input and output

```ts
interface AmendWorkflowInput {
  run_id: string;    // the run to amend: any settled run of this project, or one still running in this process
  script?: string;   // the whole revised script, inline
  path?: string;     // or: the revised script's file, usually the predecessor's own script file
                     // neither = keep the predecessor's script
  name?: string;     // display label; defaults to the predecessor's name
  predecessor?: {    // filled in by the tool, never by the model (see below)
    name?: string;
    status: "pending" | "running" | "completed" | "errored" | "stopped";
    stop_reason?: "user" | "model" | "provider" | "interrupted" | "superseded";
    owned_by_this_session: boolean;
    script_inherited?: true;  // the call gave neither source; `script` now holds the predecessor's
  };
  max_concurrency?: number | null;  // omit = keep the predecessor's limit; null = remove it; a number = set it
  subagent_model?: string | null;   // omit = keep the predecessor's model; null = back to the session model; a string = set it
  adjustable_settings?: { subagent_model: boolean; concurrency_ceiling?: number };  // filled in by the tool, as on CreateWorkflow
  model_bindings?: Record<string, string>;  // filled in by the tool, as on CreateWorkflow
}
```

At most one of `script` and `path`, enforced by `validateInput`; unlike `CreateWorkflow`,
giving neither is legal and means the predecessor's script is kept (see "Keeping the
predecessor's script"). To revise the script the usual form is `path`: the errored
notification and `GetWorkflowRun` name the predecessor's script file, the model edits it in
place and passes the same path back, so a revision costs an `Edit` instead of a second copy
of the whole script. An inline script is still accepted, whole, with no patch format, and as
on `CreateWorkflow` it is written to a fresh draft. A saved workflow whose definition was
fixed is started again with `CreateWorkflow` and `saved`. The output is
`CreateWorkflowOutput`, so the executor's background-task tracking, the `backgrounded`
contract and the display payload are shared, not copied.

A `path` submission whose bytes equal the predecessor's recorded script is refused,
`script_unchanged`, before any window and with nothing stopped, unless the call also sets
`max_concurrency` or `subagent_model`: an errored run would fail the same way, a completed
one would replay whole from cache, and continuing a stopped one is `ResumeWorkflowRun`'s
job. The failure names the file and says to edit it first, or to pass the settings and omit
`path` when only they are changing. Only a `path` the model passed is compared. The check
exists to catch a forgotten edit; pasting a script is not that mistake, and neither is
omitting both sources, which says outright that the script stays.

The three states of `max_concurrency` live only until `resolveInput`, which resolves them
into a plain number or nothing: the window shows the value the new run will start with, and
the run port never sees `null`. The retune route is the one exception, and it is one on
purpose: `retuneConcurrency` takes `number | null` and reads `null` as the default
parallelism, so the port answers with the bound it actually applied instead of the tool guessing
the machine's number twice ("Changing only the parallelism of a live run"). Either way the two routes agree
on what the call asked for and differ only in what they do with it. The inherited value is the predecessor snapshot's
`maxConcurrency`, which the port reports only when it differs from the default, so a
predecessor that ran at the default inherits nothing and a raised one passes its number on
as is.

`subagent_model` has the same three states with the same lifetime: `resolveInput` turns them
into one canonical string or nothing, and the run port never sees `null`. The inherited value
is the predecessor snapshot's `subagentModel`, and it is resolved again rather than copied
across, so a model that has been removed or disabled since the predecessor started fails at
this call instead of at the new run's first subagent ask, where it would read as a runtime
fault. That failure says the model was inherited and points at `subagent_model: null`; the
call named no model, so the bare resolver diagnosis would send the model looking for an
argument it never passed. On a host with no model catalog the two sources part company: a
string the model passed is refused exactly as `CreateWorkflow` refuses it, while an inherited
one rides through unchanged, because it was resolved once already and failing here would
break an amend that never mentioned a model.

The model names in the revised script ("Models the script names") follow the same
omission-inherits rule, per name. A name the predecessor's `run-launched` table already binds
(the snapshot's `modelBindings`) keeps that binding, so a revision does not move a name to
another model just because the catalog's tiebreak changed since launch; its canonical string is resolved again, like an inherited
`subagent_model`, and a name whose inherited model is gone is diagnostic 9011 saying the
binding was inherited from the predecessor. A name the predecessor did not use is resolved
fresh. A retune has no script and so no names.

### Keeping the predecessor's script

A call that gives neither `script` nor `path` keeps the predecessor's script. The omission
has the same lifetime as the two settings' omissions: `resolveInput` resolves it before
anything else sees the input. It reads the predecessor's recorded script
through the run port's `getScript` (the journal's `script_text`, the same bytes a resume
replays), writes it into `script`, and sets `predecessor.script_inherited`. From there on the
input has one shape: `PreToolUse` hooks and project rules match on the script that will run,
the confirmation window draws its timeline and script fold from it, and the handler compiles
and submits it exactly as if the model had passed it back byte for byte. The flag lives in
the `predecessor` block, which is always overwritten, so a model cannot claim it.

`getScript` is a read of its own rather than a field of the run snapshot. The snapshot is
polled by the background-task tracker, and the script is the largest string the port has.
The `script_unchanged` check of a `path` amend reads the same member, so there is one answer
to "what is this run running".

A kept script gets a file like any other ("Script files"), and the rule is about bytes, not
about who owns the path. If the predecessor recorded a script file and that file, read now,
still holds exactly the kept script, `resolveInput` writes its path into the input and the
new run records the same file: nothing changed, so it is still the file to edit for the next
revision, and a run of Configure clicks does not pile up identical drafts. If the predecessor
recorded no file, or the file is gone, unreadable or has been edited since, the input carries
no `path` and the handler writes the kept script to a fresh draft, exactly as for an inline
script. A file whose contents are not the script that runs is never recorded on the run, since
the diagnostics' line numbers and "edit that file" would both point at other code. The edited
file itself is left alone. The GUI's Configure ("Changing a run's settings from the GUI")
follows the same rule through the same code whenever it amends; a Configure that only retunes
a live run touches no script and writes no draft at all.

Each failure says what to pass instead. The first two come before any hook or window, the
third at `prepareApproval`, still before the window:

| Case | Result |
|---|---|
| the predecessor's record has no script (it predates script persistence) | `workflow_amend_script_unavailable`: pass the whole script, as `script` or as a `path` |
| the host has no run port, or its port cannot read scripts | `workflow_amend_script_unavailable`, with the same next step |
| the inherited script no longer compiles against the current facade | the diagnostics, led by a sentence saying the script was the predecessor's, inherited because both `script` and `path` were omitted; the lines are file-anchored and the note names the file to edit and pass back as `path`, as for any script with a file; nothing is stopped or created |

The lead sentence matters for the same reason as the inherited model's failure above: the
model did not write the failing lines in this call, and without it would read the
diagnostics as a mistake in an argument it never passed.

A call with nothing but `run_id` is allowed. It runs the predecessor's script again under
the predecessor's settings, with every cacheable ask replaying from the import. The tool
description steers a stopped run to `ResumeWorkflowRun` instead, which continues the same
run rather than starting a new one.

### Changing only the parallelism of a live run

A call whose only field beside `run_id` is `max_concurrency`, against a run the agent is still
running, is not an amendment: it retunes that run where it stands. The run keeps its id, its
subagents, their transcripts and their asks in flight; nothing is stopped, nothing is
superseded, no cache is imported and no window appears. How the new bound takes hold inside
the engine and the driver is `docs/dynamic-workflow/concurrency.md`, "Retuning a live run".

The route is attempted for both live statuses, `pending` and `running`, but "live" is the
agent's answer, not the status word's: the run service must hold the run as a live entry with
a control bound to its engine. A `running` run always does. A `pending` one whose engine is
not built yet does not, and its call is answered `not_live` at once — nothing is buffered
until an engine appears — so it takes the amendment path below. That is why the settings
popover promises the in-place wording only for a running run
(`docs/dynamic-workflow/presentation.md`, "The settings popover").

The route is decided in `resolveInput`, the one step that knows both halves of the condition:
it has just read the predecessor for the `predecessor` block, so it knows the run's status,
and it has just resolved `max_concurrency`'s three states, so it knows the value. The
condition is "nothing else changes", not "only this field was typed": `script`, `path`,
`subagent_model` and `name` each send the call down the amendment path, whatever they carry.
The handler then calls the run port's `retuneConcurrency` in place of `port.amend`. A host
whose port has no `retuneConcurrency` has no such route at all, and every call lands as the
amendment it would have been before this existed, window and all.

Here `max_concurrency` is the one place the tri-state is *not* normalized: the resolved input
carries the number or `null`, and `null` travels to the port as itself. The route's own
`unchanged` is raised here too, before any hook, whenever the default parallelism is readable —
the requested value, floored, against the bound already in force. Where the host cannot name
the default, `null` cannot be turned into a number to compare, so this net lets the call
through and the port answers `unchanged` instead.

| The call | What happens |
|---|---|
| only `max_concurrency`, run held live, value differs from the bound in force | retuned in place |
| only `max_concurrency`, run held live, same value | `unchanged`: a structured failure naming the bound already in force, raised before any hook or window; nothing is written and nothing is stopped |
| only `max_concurrency`, run not held live (settled, another process's, or pending with no engine yet) | the amendment, unchanged |
| anything else present | the amendment, unchanged |
| the run settles between the check and the call | the port answers `not_live`; what follows depends on who owns the run (below) |

The third row is reached in two ways: `resolveInput` already sees a status that is not live, or
the status says live and the port answers `not_live` anyway. They end in the same place, so the
rest of this section speaks of `not_live` without distinguishing them.

A retune reads no script. `getScript`, the inheritance of "Keeping the predecessor's script"
and the compile are all skipped, because nothing new runs: the same engine goes on executing
the same script. Two refusals of the amendment path therefore cannot reach this call — a run
whose record predates script persistence (`workflow_amend_script_unavailable`) and a run whose
script no longer compiles against the current facade are both still retunable.

**No window, for any owner.** The window exists to put a script in front of the user before it
runs, and this call runs no script: it moves one number, up or down, on a run that is already
executing code someone approved. "Amending this session's runs" governs the
amendment path only.

**When the port says `not_live`.** The same input now describes an amendment — usually because
the run settled between the check and the call, sometimes because it is a `pending` run with no
engine yet. The handler re-reads the run before deciding anything, since the `predecessor`
block in its hands still says "running", and asks one question of the fresh facts, whether that
amendment would have needed a window. The question is the window rule's own predicate,
`isAmendWorkflowOwnedPredecessor` in contracts, which the permission service also calls — one
function, so "this session's own run, not stopped by the user" cannot come to mean two things:

| Situation | Result |
|---|---|
| the predicate holds: this session's own run, not stopped by the user | the handler makes the amendment, reading the predecessor's script and compiling it at that point instead of at step 2, and reporting a missing or non-compiling script as the amendment's own refusal. Nothing is skipped: an amendment of this session's own run opens no window either |
| the predicate fails and the run has settled | refused, `workflow_run_settled`, naming the run and saying to call again |
| the predicate fails and the run is still `pending` or `running`, so this agent simply never held it | refused, `workflow_run_not_retunable`, with the same advice |
| the run is gone from the port entirely | `run_not_found`, worded as `resolveInput`'s own: nothing was stopped or created, pass an existing run's id or start one with `CreateWorkflow` |

Both refusals exist for one reason: a retune shows no window, so nothing was approved, and that
approval of nothing must not be stretched into a new run of a script this user has not read. The
second call takes the amendment path from the top, with the window that path requires.

**What comes back.** The response names one run, the bound now in force, and that nothing else
happened:

> Applied to the running run {id}; at most {n} subagents run at once. Run {id} keeps running
> under it: nothing was stopped and no new run was started.

with "at most 1 subagent runs at once" in the singular, and "(the default)" appended when the
applied value is the default parallelism — the same distinction `CreateWorkflow`'s response
draws, decided from the `defaultConcurrency` the port answers with rather than from a number
the tool would have to look up twice.

That sentence is **the only fact this route puts across v4**. There is no display payload
(nothing was compiled), and the protocol's `toolOutputSchema` carries `text`, `display` and
`truncated` and nothing else, so the desktop tool row is drawn from this text and from the
input's shape (`docs/dynamic-workflow/presentation.md`, "The tool row"). Changing the wording
is therefore changing the UI, and two verbatim tests pin it.

The output also carries a structured `retuned: { runId, maxConcurrency, previous, defaultConcurrency }` —
absolute numbers, `maxConcurrency === defaultConcurrency` meaning "this run has no bound of its
own". It is
an explicit discriminator rather than something a reader infers from "ok and no `status`", which
this tool can also answer when a host has no run port at all. It does not cross v4; it serves
the CLI, the TUI, in-process consumers and the contract tests. Nothing is backgrounded: the run
was already in the background-task tracker under its own id and stays there, so there is no
`status: "backgrounded"`, no `backgroundTaskId` and no `causalityGraph`.

**The three refusals** are ordinary tool errors — a message whose first token is the code name,
and a numeric log code from `AMEND_WORKFLOW_ERROR_CODE` — and each says that nothing was
stopped, created or changed, then what to pass instead:

| Code | Log | Says |
|---|---|---|
| `workflow_retune_unchanged` | 27 | the bound already in force (or that the run has none and runs at the default parallelism), and to pass a different `max_concurrency`, or a revised script if an amendment was meant |
| `workflow_run_settled` | 28 | the run settled before the new limit could take hold, and to call `AmendWorkflow` again for a new run of it under that limit |
| `workflow_run_not_retunable` | 29 | the run is not being executed by this agent, so its parallelism cannot be changed in place, with the same next step |

### From call to run

A retune walks the same steps as an amendment, with two of them different: step 5 compiles
nothing, because no new script is going to run, and step 7 calls `retuneConcurrency` instead
of `port.amend`. Everything below therefore describes both, and names the retune where they
part. The lifecycle is `CreateWorkflow`'s with two differences: the disk read resolves the
predecessor instead of a saved file, and the handler may have to stop that predecessor
before it can import from it. Nothing in the run is touched before the script has compiled
and the gate has passed, so a denied or non-compiling amend leaves a running predecessor
running.

1. Schema validation of the model's arguments.
2. `resolveInput`: the only read before the handler. It looks the run up through the run
   port and rewrites the input with the `predecessor` block: its name, status, stop reason,
   and whether its parent session is this session. An unknown id is a structured
   `run_not_found` failure here, before any hook or dialog. The block is always overwritten,
   so a value the model supplies is inert; the model-facing JSON schema does not list it. The
   same read resolves `max_concurrency`'s three states against the snapshot's
   `maxConcurrency` and the default parallelism, and `subagent_model`'s three states against the
   snapshot's `subagentModel` and the model catalog. Both resolutions together answer "does
   anything but the bound change", which with the status settles the route (see "Changing only
   the parallelism of a live run"); a retune stops here, carrying the resolved bound and no
   script. Otherwise the same step settles the script from
   its three sources. A `path` is read as `CreateWorkflow` reads it, then compared with the
   predecessor's script from the run port's `getScript`, and `script_unchanged` is raised when
   the two are byte-identical and the call changes nothing else. With neither source the
   predecessor's recorded script is filled in (see "Keeping the predecessor's script").
   Either way the input is rewritten to carry `script`, and the absolute `path` when a file
   holds it, plus the `adjustable_settings` block `CreateWorkflow` writes. A retune carries no
   block: it raises no ask.
3. `PreToolUse` hooks and project permission rules see the resolved input.
4. The permission check. `AmendWorkflow` declares `alwaysAsk`; inside the always-ask branch
   the ownership rule may allow without a window (see "Amending this session's runs").
5. `prepareApproval`: compile the script, passed or inherited. Diagnostics mean no window
   and no stop; the model gets the `L{line}:C{column} {message}` lines exactly as for
   `CreateWorkflow`. A retune compiles nothing and raises no ask: there is no script in the
   input, none is going to start, and the gate returns `proceed`.
6. The user answers, or a `PermissionRequest` hook answers first. An allow answer from the
   window may carry adjusted settings, applied to the input before the handler exactly as for
   `CreateWorkflow` (see "Adjusting the settings in the window").
7. The handler writes a draft when the script has no file (inline, or kept from a
   predecessor whose file no longer holds it), then calls `port.amend` with the script, the
   predecessor id, `cwd`, `name` (falling back to the predecessor's), `scriptPath`, the
   parent session id and the tool call id. The port always receives a script: inheriting it
   is the tool's business, not the run service's. A retune calls
   `retuneConcurrency({ runId, maxConcurrency })` instead and ends there; steps 8 and 9 are
   the amendment's.
8. The run service (see the engine document for the mechanics):
   1. reads the predecessor and preflights its journal for transcript boundaries; a run
      whose completed asks lack them is refused `missing_boundaries` before anything is
      stopped;
   2. mints the new run id;
   3. if the predecessor is still in flight, cancels it with the initiator `superseded`
      and the new run id, and awaits its settlement promise (an in-process await on the
      run's own terminal state, not a timeout); the predecessor settles
      `stopped(superseded)` with `supersededBy` recorded;
   4. waits, for a bounded interval, until the predecessor's aborted turns have finished
      writing their sessions; a session that is still being written contributes its
      completed asks and none of its unfinished one;
   5. builds the import cache from the now-settled predecessor and submits the new run with
      `resumedFrom` set.
9. The handler returns `backgrounded`, telling the model which run was superseded (when one
   was) and which run started.

Refusals are structured failures whose message says what to do next and that nothing was
created: `run_not_found` (also raised at step 2), `missing_boundaries`, and three raised at
step 2 only: `script_unchanged`, `workflow_script_file_unreadable` and
`workflow_amend_script_unavailable`. The retune route adds three of its own,
`workflow_retune_unchanged`, `workflow_run_settled` and `workflow_run_not_retunable`
("Changing only the parallelism of a live run"), and all three leave the run untouched like the
rest. There is no
`not_amendable`: a running predecessor is stopped, not refused, so the race between a stop
and the amend that follows it no longer exists.

The response the model reads names both runs: "Run A was stopped and superseded. The
revised script started as run B …", or just the new run when the predecessor had already
settled. When the call kept the script it says "The script of run A started unchanged as
run B …" instead, so the model knows the settings were the whole change. A retune names one
run and no successor ("Changing only the parallelism of a live run"), which is how the model
tells the two outcomes apart without being told which route its call took. The predecessor's own terminal notification is not delivered (see
`docs/dynamic-workflow/transcript-and-notifications.md`): the amend result is the model's
account of that stop, and a second message saying "you stopped run A, amend it now" would
send the model in a circle.

### What the model is told

The tool description carries the routing and nothing else: amend to fix an errored run, to
extend a completed one, to repair a run that is visibly going wrong while it runs, in one
call, with no stop first and no waiting for it to finish, and to change a run's settings
without touching its script (neither `path` nor `script`); resuming a stopped run unchanged
is `ResumeWorkflowRun`. It then says to load the `dynamic-workflows` skill before revising a
script, and that a call carrying `path` or `script` is refused until the skill has been
loaded while a settings-only call is not.

Everything else the description used to carry is the skill's §16.4, which the gate makes the
model read first: the cache (unchanged asks of named subagents replay at zero cost until the
revision's first write to the workspace; after that only asks that read and ran nothing keep
replaying), the fact that a named subagent whose unfinished ask the revision did not change
picks that ask up where it left off, and the confirmation rule (this session's runs start
without a window unless the amendment brings in a new provider; another session's run asks). Its field list states one rule, omit a field
and the new run keeps the predecessor's value, in a fixed order: the script first (omit both
`path` and `script` to keep the predecessor's and change only the settings), then
`max_concurrency` (omit keeps, `null` removes, a number changes, and only when the user asks;
a call carrying nothing but this field, on a run that is still going, retunes that run in
place instead of starting a new one), then `subagent_model` (omit keeps, `null` returns the
subagents to the session model, a model id changes it, `ListModels` lists the ids). The three
are stated together because reading only one of them invites taking another's omission for a
removal, and because a model that believes the script is mandatory re-emits thousands of
tokens of it to change one number. Passing a revised script is one source and never both:
`path` first as the usual way (edit the run's script file in place, pass the same path back,
an unchanged file is refused `script_unchanged`), then inline `script` for a revision written
from scratch, which is saved to a draft so the next revision can go back to `path`.
`CreateWorkflow`'s §16.1 says the same from the other side — how many subagents work at once
is the runtime's decision, not the script's, and the field is never a reaction to provider
errors, which the runtime already adapts to; the subagents run on the session model unless
`subagent_model` says otherwise, and the main agent stays there either way. `GetWorkflowRun`,
`ListWorkflowRuns` and the terminal notifications point at the same tool.

## The `FillWorkflowHole` tool

A run that reaches an open hole (`docs/dynamic-workflow/authoring.md`, "Holes") parks that
branch and tells the model, through a hole notification, that code is owed.
`FillWorkflowHole` is how the model pays it. It starts nothing: the run keeps its id, its
journal and its subagents, and grows by the body the model wrote.

### Input and output

```ts
interface FillWorkflowHoleInput {
  run_id: string;    // the run that is waiting
  hole_id: string;   // the hole's site id from the notification, e.g. `hole#21b40fca`
  script?: string;   // the body: the statements of the hole's function, inline
  path?: string;     // or: a file holding those statements — usually the fill file of a rejected attempt
  hole?: {           // filled in by the tool, never by the model
    name: string;
    type: string;
    draft_path?: string;
    line?: number;
    owned_by_this_session: boolean;
  };
}
```

Exactly one of `script` and `path`. The body is **the statements only**: not the `hole(...)`
call, not the arrow, not the script around it. The tool splices them into the run's
**recorded** script (the script the run is executing, not the draft file on disk) as the
hole's body, right after the call's last argument, and compiles the whole
(`docs/analysis.md`, "Sites"; the engine document, "Holes"). Nothing else in the script can
change through this tool, and editing the draft on disk changes nothing the fill sees: a
change to the call site or anywhere else is an `AmendWorkflow`. The output is
`CreateWorkflowOutput` plus a `fill` block (`siteId`, `name`, `draftPath?`, `line?`, from the
resolved hole, present on every outcome), so the display payload of the effective script
rides the tool row exactly as a launch's does, the row can label itself by the hole's name
without the resolver's input (which never reaches a row), and the run card takes the
newest display for its run id (`docs/dynamic-workflow/presentation.md`, "Holes on the
timeline").

| Refusal | Meaning |
|---|---|
| `run_not_found` | no run row |
| `hole_not_waiting` | the run is not in flight, or is running in another process, or the hole is not one it is waiting at (already filled, not yet reached, unknown id); the message says which, for a stopped run points at `ResumeWorkflowRun`, after which the hole asks again, and for another process's run says only the session that started it can fill it |
| `fill_unchanged` | a `path` whose bytes equal the last rejected attempt for this hole: the forgotten edit, caught before any window |
| diagnostics | the effective script does not compile, or the body names a model the run has no binding for (9011); see "The fill file" and "Models the script names" |
| `fill_ids_unstable` | the compiled effective script renumbered an existing site: a host fault, never the model's; the hole stays waiting |

### The fill file

Every inline `script` fill is written, byte for byte, to
`<cwd>/.zcode/workflow-drafts/<slug>.<hole-slug>.dwf.ts` before the compile result is read,
exactly as an inline script is written to a draft. `<slug>` is the run's draft slug and
`<hole-slug>` the hole's name under the same slug rules; `-2`, `-3`, … is appended while the
name is taken, so an inline resubmission mints a new file and never overwrites one behind the
model's back. A `path` fill edits in place and mints nothing. Nothing deletes a fill file.
Editing one needs no approval, since it lies under the drafts directory ("Editing a draft
needs no approval").

On diagnostics nothing is spliced, nothing is journaled and the hole stays waiting. The
response leads with the fill file: "The fill is saved at {path}. Edit that file in place and
resubmit with `path`; do not paste it inline again." Each diagnostic reads
`{path}:L{line}:C{column} {message}` anchored to **the file it falls in**: a diagnostic
inside the spliced range is reported in the fill file's lines, and one outside it (a
duplicate subagent name whose other site is in the parent, 9005) in the draft's lines with
the draft's path, because that is the code it points at. When any diagnostic falls outside
the fill, the response adds that those lines are in the run's recorded script, which the
fill cannot change and which editing the draft on disk does not change either, and that the
way to fix them is `AmendWorkflow` with the corrected script, after which the hole asks
again. The chat shows the compiler-feedback row (`docs/dynamic-workflow/presentation.md`,
"Compiler feedback") under the fill row.

A fill that compiles but throws when it runs is no longer this tool's business: the body
has joined the effective script, the hole's promise rejects at the site, and the run ends
errored unless the script catches it. The errored notification names the run's draft, which
now holds the effective script, for `AmendWorkflow`.

### The draft after a fill

The run's draft is rewritten in place with the effective script, and the run's `scriptPath`
stays the same file. This is the one exception to "a draft is never overwritten behind the
model's back": the model asked for exactly this write, the notification for the next hole
points at the same file, and the file the model reads for context is always the script that
is running. A run whose draft could not be written gets one now, by the inline rule, and
records it. A `path` fill's own file is left as it is.

### Approval

A fill is an amendment of a live run's script without a new run, and it is judged by the
amend rule ("Amending this session's runs"), read from the run's recorded parent session: a
run this session started fills without a window; a run started by another session that this
process now holds, or one the user stopped, brings the confirmation window, which draws the fill's draft line (the new stations
between their ghosted neighbours) above the collapsed body, lists the `world.run` commands
the body adds, and offers Allow / Always allow in this session / Deny / Refine. A run whose
engine is in another process never reaches the window: this process cannot deliver the body to
it, so `resolveInput` refuses with `hole_not_waiting` (the snapshot's `liveInThisProcess` is
false), because asking would get the user's approval for something that cannot happen. The
session's always-allow covers fills as it covers amends. Project deny and ask rules match on
the effective script. A body that does not compile skips the window, as a non-compiling
script does, and so does a body that names a model outside the run's table.

### What the model is told

The hole notification (`docs/dynamic-workflow/transcript-and-notifications.md`, "What the
model reads") carries the run, the hole's site id, name and type as written, the prompt with
its values interpolated, the draft's path and the hole's line in it, and the names of the
phases before and after the hole. The tool's description says: read the draft for the
context, since the body is compiled where the hole stands and sees every binding declared
before it; write only the statements; return a value of the hole's type, or end the body
in a new tail hole named for the next step when the workflow's shape is not known yet (the
skill's §15, "Grow by tail holes"); rehearse fixed logic in `EvalWorkflowSnippet` first; and
that a hole is filled once, so a body under a loop runs per iteration. The notification's
return sentence says the same, so a chain is a normal reading of it, not a trick. On success the response says the fill joined the run, names the phases
it added, and names the draft as the file to edit for any later `AmendWorkflow`.

## The confirmation window

### Why the window always appears

`CreateWorkflow` declares `permission.alwaysAsk: true`. The permission service checks that
flag before any mode branch, so `yolo`, `plan`, `build`, `edit` and `default` all ask. The
reasoning: a workflow is a large block of execution and model calls that costs money and
has real side effects, and for a saved workflow the file on disk can change between two
runs of the same name, so "approved this name before" does not mean "approved this code".

Inside the always-ask branch the order is fixed:

| Check | Result |
|---|---|
| mode is `auto` | deny (`mode.auto.unimplemented`) |
| tool is in `disallowedTools` | deny |
| a project deny rule matches | deny |
| a session allow rule matches | allow, no event, no window (`rule.session.allow`) |
| `AmendWorkflow` of a run this session started, not stopped by the user, bringing in no new provider | allow, no event, no window (`rule.session.workflowOwner`) |
| otherwise | ask (`tool.alwaysAsk`) |

Project allow rules and `allowedTools` are never consulted for an always-ask tool. A
`PreToolUse` hook's `allow` cannot erase the ask; a hook's `ask` can turn either session
allow back into an ask. A `PermissionRequest` hook may still answer the ask; it races the
dialog and the first answer wins.

### What the window shows

The dialog's own header reads "Permission required" / 「需要权限」. Below it the workflow
block:

| Part | Content |
|---|---|
| Title | "Run this workflow?" / 「运行此工作流？」 for `CreateWorkflow`, "Amend this workflow?" / 「调整此工作流？」 for `AmendWorkflow`, then the workflow name and the phase count ("N phases" / 「N 个阶段」). Nothing else in the header: a script that reached the window has compiled. |
| Lineage row | `AmendWorkflow` only: "Amends run" / 「调整 run」 plus the run id, "script unchanged" / 「脚本不变」 when `predecessor.script_inherited` says the call kept the predecessor's script, and "still running, will be stopped" / 「仍在运行，将被停止」 when the predecessor is in flight. With the script kept, the timeline and the script fold show the predecessor's script, which is what will run. |
| Run settings | Two lines, "Subagents run on {model}" / 「子代理运行在 {model}」 and "At most {n} subagents at once" / 「最多 {n} 个子代理同时运行」, in the order model then bound. When the input carries `adjustable_settings` the two lines are always drawn and the value in each is a control the user can change before approving (see "Adjusting the settings in the window"): the model line shows the session model when the call set none, the bound line the default parallelism when the call set none. When the input carries no block (an older agent), the lines appear only for the fields the call set, as plain text, and nothing is adjustable. Either way what is being approved is "run under these conditions"; for an amend the lines show the inherited values too, because `resolveInput` has already written them into the input. The model is named by its **resolved label**, not by the canonical value `resolveInput` produced: "GLM-5.3-Flash · thinking High" / 「GLM-5.3-Flash · 思考 高」. The label rule (`describeWorkflowSubagentModel`, shared with the run card and the run pane) is: a builtin provider family shows the model id alone, a custom provider shows "{provider name}/{model id}", a provider the session's model listing cannot resolve falls back to the model id, and the provider id is never shown, because for a team plan it is a UUID. The canonical value stays reachable in a tooltip, so what will actually be used is still legible. The lines speak only of the subagents: the main agent keeps the session model whatever they say. When the input carries `model_bindings` the window does not list them: which model each named subagent uses is the authoring model's choice, written in the script the window shows, and listing every binding with a control would turn one decision ("run this") into many. The model line then reads "By default, subagents run on {model}" / 「子代理默认运行在 {model}」, because it no longer speaks for every subagent; the run pane names each subagent's own model once the run starts. |
| Saved-source badge | "Saved workflow" / 「已保存的工作流」 · scope, the saved name, its path, and an arguments grid labelled 「实参」, when the source is `saved`. |
| Timeline | the phase timeline built from the display payload's graph (`docs/dynamic-workflow/presentation.md`). It is always open and cannot be collapsed; nothing in it is clickable. |
| Script | a collapsible, closed by default ("Show full script" / 「显示完整脚本」), a TypeScript code block with line numbers inside a height-capped scroll area. |
| Origin badge | 「子智能体」 (subagent) next to the title when the ask was mirrored from a subagent. |

A script with no steps has no graph; then the timeline is omitted and the script starts
open, because the code is the only content. The window renders the tool's `reason` string
nowhere: that string is for logs.

A concurrency-only call on a live run raises no ask at all, so none of this is drawn for it
("Changing only the parallelism of a live run").

The window reads the script and the name from the tool input, not from the display
payload. This is why an old desktop paired with a new CLI still shows the full script of a
saved workflow: the input channel carries no schema, while a new display field would be
invisible to an old client.

### The options

| # | Button | Wire option | Effect |
|---|---|---|---|
| 1 | "Allow" / 「允许」, described as 「仅允许这一次」, or 「按调整后的设置运行一次」 / "Run once with the adjusted settings" once a setting was changed | `allow_once` | run once, under the adjusted settings when there are any |
| 2 | "Always allow in this session" / 「本会话内始终允许」, described as 「本会话内运行工作流不再询问」, or 「本次按调整后的设置运行；之后的工作流不再询问，各用各的设置」 / "This run with the adjusted settings; later runs are not asked and carry their own" once a setting was changed | `allowSession` | run, under the adjusted settings when there are any, and stop asking for this tool in this session |
| 3 | "Deny" / 「拒绝」 | `deny` | standard permission denial; the model is told the run was not approved |
| 4 | the feedback row, placeholder "Describe how the workflow should change…" / 「描述这个工作流应该怎么改…」 | `workflowRefine` | Refine: deny plus feedback (below) |

Keys 1, 2 and 3 answer immediately; 4 selects the feedback row. Arrow keys and Tab move
between buttons and the row; Enter confirms the selection, and Enter inside the row
submits the feedback. Escape only leaves the row. Deny never carries the row's draft: the
draft belongs to Refine, and a plain deny is a plain deny.

### Adjusting the settings in the window

The window lets the user change the two conditions a run is bound by, the model its subagents
run on and how many of them work at once, before approving it. Allow then starts the run under
the user's values from its first ask. The model is not asked, and no second run is started:
changing the same settings from the run card after Allow would stop the fresh run and start
another ("Changing a run's settings from the GUI").

**What the agent offers.** When a run port is present, `resolveInput` writes an
`adjustable_settings` block into the input of every call that can reach the window:

```ts
adjustable_settings?: {
  subagent_model: boolean;       // this host can resolve a model choice: it has a model catalog
  concurrency_ceiling?: number;  // the default parallelism D; absent when the run port cannot say
}
```

The block is a resolved fact of the same kind as `predecessor` and `saved.path`: it is always
overwritten, so a value the model supplies is inert, and the model-facing JSON schema does not
list it. It travels in the input rather than in the `create_workflow` display on purpose. The
display's field set is frozen: a new key there makes every client that parses the display
strictly, the chat card and the legacy v3 lookup among them, drop the whole payload, graph
included. The input channel carries no schema on any version. A client that does not know the
block ignores it and draws the plain lines; an agent that does not write it gets the plain
lines from a new client, so no client ever offers a change the agent would drop. There is no
block on a host without a run port, where nothing will run, and none on a retune, which raises
no ask.

**The controls.** They start from the input. The model starts at `subagent_model`, or at the
session model when the call set none. The bound starts at `max_concurrency`, or at the default
when the call set none, or empty when the default is unknown too. It has no upper end. When `subagent_model` in the
block is false, the model line is a sentence instead of a control ("Subagents stay on the
session model · this agent has no model catalog", or the call's own model when it set one) and
only the bound is adjustable. How the
controls look is in `docs/dynamic-workflow/presentation.md` ("The confirmation window").

**The answer.** Allow and "Always allow in this session" carry what the user changed in the
answer's `content`, and only what changed, in the tool's own field names and tri-state:

```ts
resolveInteraction.answer = {
  optionId,               // the allow option chosen
  content?: {
    subagent_model?: string | null;   // canonical providerId/modelId[$level]; null = the session model
    max_concurrency?: number | null;  // null = no bound of the run's own: the default parallelism
  };
};
```

The rules are the Configure popover's: a bound equal to the default is sent as `null`, and a
change of the thinking level alone is a change of the model. Deny and Refine never carry
`content`. The settings belong to the run Allow would start, and a denial starts nothing;
Refine's next window arrives with whatever the model's revised call carries.

**On the agent.** The broker reads `content` only on an allow answer to `CreateWorkflow` or
`AmendWorkflow`. It validates the two fields against their schemas, drops every other key, and
hands the result to the executor as the broker result's `inputAdjustments`. The executor
applies them after the permission grant and before the handler, through the tool's
`applyInputAdjustments`:

| Field | Value | Effect on the input |
|---|---|---|
| `subagent_model` | a string | resolved against the model catalog exactly as `resolveInput` resolves the field; the canonical string the window sends hits the first tier. A failure fails the call the way an unresolvable model fails it in `resolveInput`, before anything starts, and names the candidates |
| `subagent_model` | `null` | the key is removed: the session model |
| `max_concurrency` | a number | floored to a whole number of at least 1; no upper limit |
| `max_concurrency` | `null` | the key is removed: the default parallelism |

After this step the input has the shape `resolveInput` produces, so the handler, the run port
and the journal need nothing new: the model rides on the `run-launched` event and the bound on
`dwf_run.caps`, as they would had the model asked for them. A tool without
`applyInputAdjustments` ignores adjustments, and a `PermissionRequest` hook that answers first
carries none.

**What the model is told.** The model's `tool_use` block keeps the arguments it sent, so the
result has to say what actually ran. Right after the run id and the notification sentence, the
response carries:

> Before approving, the user adjusted the settings in the confirmation window: subagents run on
> {canonical} (the main agent stays on the session model); at most {n} subagents run at once
> (the default is {default}).

Only the changed halves appear. "subagents are back on the session model" and "the limit on
subagents at once is back to the default" stand for the two `null`s, and the default's
parenthesis is left out when the default is unknown. The sentence takes the place of the ordinary settings sentence
for each field it names; a field the user left alone keeps its ordinary sentence. Without it
the model believes the values it asked for are in force and may "correct" a run that is doing
what the user asked.

**The session grant.** "Always allow in this session" writes its per-tool rule as before, and
the settings ride on this one answer only. Later calls in the session run without a window and
carry their own settings; the option's description says so once a value has been changed. A
remembered default belongs to a host-wide subagent setting, not to the grant.

**Other clients.** The terminal UI and headless runs answer without a window, so they carry no
adjustments. A legacy v3 desktop sees the plain ask and answers without `content`. The phone
remote draws the same window as the desktop.

### Refine

Refine is a denial that carries the user's instructions to the model as a real message,
so the model revises and resubmits, which opens a new window. It is never consent.

1. The v4 projection adds a `workflowRefine` option (wire kind `custom`) to every
   `CreateWorkflow` and `AmendWorkflow` ask and to no other tool. The UI takes it out of the
   button list and makes it the feedback row's target.
2. The answer arrives as `{ optionId: "workflowRefine", freeText }`. The broker maps a
   non-empty `freeText` to `{ decision: "deny", reason: freeText, reasonSource:
   "workflow_refine_feedback" }`. Empty text, or the same option id on another tool, is a
   plain deny.
3. The executor writes the tool result as "The workflow run was not approved by the user."
   and attaches the feedback as a follow-up user input.
4. The runtime steers the active turn with that input as a `guide` delivery, persisted as
   an ordinary user message. The provider sees `assistant tool_use → tool_result → user
   feedback`, in that order.

Windows without a Refine option (`SaveWorkflow`) show the generic feedback row instead,
whose text becomes the deny reason.

### Always allow in this session

Option 2 exists because a user who has read and approved one script in a session should
not be asked again for every revision of it. The grant is session-scoped and never
persisted:

- The option's response carries no `permissionUpdates`. The broker synthesizes
  `sessionPermissionUpdates: [{ addRules, allow, rules: [{ toolName: "CreateWorkflow" }] }]`
  on the answer side; that field never crosses the wire.
- The permission service merges it into an in-memory session ruleset. The project
  permission store is never written.
- The rule is per tool, not per script: every later `CreateWorkflow` in the session runs
  without a window, with no permission event. An `AmendWorkflow` window (another session's
  run) offers the same option and writes its own rule; the two grants are independent.
- One permission service instance is one app is one session. Restarting the desktop, cold
  resuming the session, or `/new` starts from an empty ruleset and asks again.
- General-purpose and custom subagents share the parent's permission service and inherit
  the grant. The Explore subagent has its own instance. Workflow children cannot call
  `CreateWorkflow` at all (see "Recorded exceptions").

`SaveWorkflow` deliberately has no such option (`askOptions.allowAlways: false`): saving
is rare and every save's target and overwrite decision deserve a look.

### Amending this session's runs

An amendment of a run this session started begins without a window. The key is the run's
recorded parent session, not the presence of a run id: `ListWorkflowRuns` can name any run
in the project, including other sessions' runs, so a blanket pass for `AmendWorkflow` would
let the model start arbitrary new code without a window.

The rule is read from the journal, through the `predecessor` block `resolveInput` filled in:

| Predecessor | Result |
|---|---|
| `parent_session_id` is this session, `stop_reason` is not `user`, and the amendment brings in no new provider | allow, `rule.session.workflowOwner`, in every mode |
| `parent_session_id` is this session but the amendment brings in a new provider | ask: another provider is another bill, and only the user can choose it |
| `parent_session_id` is this session but the user stopped it | ask: the user ended that run on purpose, and a revision of it is a new decision |
| another session's run, ended | ask |
| another session's run, still running in another process | refused before the window, `workflow_run_held_elsewhere`: this process cannot stop it, and the cache imports only from a settled predecessor |

"A new provider" is `predecessor.introduces_providers`, which `resolveInput` computes as its last
step, after the script's model bindings are settled. It lists, once each and in alphabetical
order, the providers of the models the revision will use (the resolved `subagent_model` and the
values of `model_bindings`) that are neither the session model's provider nor a provider of the
models the predecessor ran on (its `subagentModel` and `modelBindings` from `run-launched`). The
key is present only when that list is not empty. A model the predecessor already used was
approved in that run's own window, so keeping it, or moving to another model under the same
provider, stays free. The fact is computed, never read from the call: the model-facing schema
has no `predecessor`, so a call that carries one is refused before `resolveInput`, and a full
`providerId/modelId` written by the model proves only that the name is unambiguous, not that the
user chose it. Without a model catalog there is no session provider to read, so the comparison
is with the predecessor alone; a model name the call passes cannot be resolved then anyway, and
an inherited one is the predecessor's own.

A hub launch owns the session it created, so amending it from that session is free. A run
that was itself an amendment is owned by the session that amended, so a chain of revisions
stays free. Because the rule is a property of the run rather than of the process, it
survives restart and cold resume, which the former in-memory lineage table did not; there is
nothing to seed and nothing to revoke. Amending a running predecessor is covered by the same
rule: the model can already stop this session's runs with `TaskStop` without a window, and
the amend result reports the stop.

This table is about amendments. A call that only retunes a live run's parallelism never
reaches it, from either session, because it starts nothing to ask about ("Changing only the
parallelism of a live run").

The server-side gates (`run_not_found`, `missing_boundaries`) still run at submit; the rule
only removes the window. A `max_concurrency` different from the predecessor's does not bring
the window back either, in either direction: it changes how many of the approved script's
subagents work at once, not what the script does or what any subagent may do, and a raise
still answers to the governor's cap on each provider key. Nor does a different `subagent_model`
under a provider the session or the run already used. It moves the subagents onto another model
this host already has configured and widens nothing about what the run may do, so such an amend
starts without a window like any other amend of this session's run. A model under a provider
neither has used is the exception in the table above: the window comes back, because that
choice moves the cost to another bill. An amend that omits both `script` and `path` is judged the same
way as one that passes it: free for this session's run, a window for another session's, where
the lineage row says the script is unchanged.

### Recorded exceptions

These places do not show the window, on purpose:

| Place | Why |
|---|---|
| 「运行」 on the hub page | the user is looking at a workflow they saved, has filled in its arguments, and pressed Run; the click is the consent. The launch goes through `startSavedWorkflowRun`, not the tool executor, so the tool's gate is untouched. |
| Apply in the Configure popover | the user is looking at the run, chose its new settings and read what applying does; the click is the consent. The change goes through `amendWorkflowRunSettings`, not the tool executor, and it runs the script the user already approved. |
| a retune of a live run's parallelism, from either caller | it starts nothing. No script is read, compiled or executed; one number moves, up or down, on a run that is already executing approved code ("Changing only the parallelism of a live run"). |
| the terminal UI and headless `-p` | the terminal user is already in a command-line context; friction outweighs protection. The bypass lives in the client's permission responder, not in core. |
| workflow child sessions | a subagent does not launch, revise or steer runs: that is the main agent's job, and the window would ask the user about a run nobody in the conversation proposed. `CreateWorkflow`, `AmendWorkflow`, `SaveWorkflow`, `ResumeWorkflowRun` and `ResolveWorkflowQuestion` are removed from a child's tool set; the child gets a clean tool-disallowed error. `ListSavedWorkflows` stays available. `ListWorkflowRuns` and `GetWorkflowRun` are removed too, from every child runtime (a workflow child, a nested workflow child, and a subagent of the main agent's `Agent` tool), for a different reason: they read through the dynamic-workflow run port, which only the app's top-level runtime holds and a child must not (`dynamic-workflow-run-progress-sink.ts` records why), so in a child they could only ever fail with `workflow_introspection_unavailable` (production, 2026-10-20: 155 calls from workflow children, all of them failing). The subagent's other asks and its questions are not exempt: they reach the user ("Permissions inside a run"). |

### Other clients

| Client | What it sees |
|---|---|
| desktop, web, phone remote (v4) | the window as described |
| legacy v3 desktop | a plain ask with only Allow once and Deny; the `display` and options policy are stripped because the old schemas are strict and would drop the whole event otherwise. The script is still in the input. |
| bots / IM | a text summary; the session option is classified as a generic "always allow" |
| terminal UI | no window: auto-allow (below) |
| headless | no window: auto-allow (below) |

## Permissions inside a run

A run's subagents work in the permission mode of the session that launched the run: Build,
Edit, YOLO, Guarded or Auto. A subagent asks the user whenever the main agent would ask for
the same tool call in that mode: an edit or a command in Build, a dangerous command in Guarded
(`docs/dangerous-command-approval-v1-plan.md`), nothing in YOLO. Plan is not carried into a
run: a run always executes, so a session in plan mode passes on its underlying mode, and an old
session whose mode is still the legacy `plan` value passes on `build`.

**The mode is decided once, when the run is created.** Every way a run starts or is revised
(`CreateWorkflow`, `AmendWorkflow`, 「运行」 on the hub, Apply in the Configure popover) reads
the launching session's mode at that moment and records it as `subagentPermissionMode` on the
run's `run-launched` journal event
(`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`, "Events"). Resume reads the
value back from that event, so a run keeps its mode across a cancel and resume, a desktop
restart and a cold resume. Switching the session's mode while a run is in flight changes
nothing for that run, in either direction; an amendment is a new run and takes the mode in
force when it is made. A run with no recorded mode (recorded before this field existed, or
launched by a host that does not report the session's mode) and a run whose recorded value is
not a mode this version knows both run their subagents in YOLO, as all runs did before. The
value is not shown anywhere and is not part of `GetWorkflowRun`.

**What a subagent's ask looks like.** A subagent's session is not a session the client knows,
so its permission requests go out under the parent session's id, the same routing ordinary
subagents use (`createChildClientPorts`). The dialog is built from the parent session's live
projection, so the subagent's `PermissionRequested`, `PermissionResolved` and
`PermissionDenied` events are also mirrored into the parent session (notify only, never stored
twice). Only these interaction events are mirrored; the subagent's tool activity stays in its
own transcript and on the run card. The request carries an `origin` of kind `subagent`
with the subagent's session id, and a `description` of the form `<name> (<siteId>@<ordinal>)`,
`<name>` being the subagent's persona name, or `subagent` when it has none. The permission
dialog shows the origin badge with that description: "Subagent · reviewer (agent#2@1)" /
「子智能体 · reviewer (agent#2@1)」. The badge truncates a long description and keeps the whole
text in its tooltip.

The dialog offers what the same ask from an ordinary subagent offers. Full access is never
offered on a subagent's ask. A Guarded
dangerous command gets Guarded's single-use ask, unchanged: Allow once or Deny, no "always
allow", no hook approval, no stored rule, no timeout. For other asks, an "always allow" that
writes a project rule covers every later subagent of every run, since each tool call reads the
project rules afresh; a session-scoped "always allow" covers only the subagent that asked,
because each subagent has its own session. Several subagents may wait at once; each has its
own request and the dialog handles them one at a time. Denial reaches the subagent as an
ordinary denied tool result and the subagent carries on. A waiting subagent keeps its
concurrency seat, and a permission wait is not a retry, so it does not count toward the run's
stall notice. Stopping the run cancels its pending asks with it.

**Questions.** A subagent does not have `AskUserQuestion`, in any mode. A subagent never asks
the user directly: when a decision is not its own, it calls `escalate`, and the main agent
answers it or asks the user itself. This keeps one route for questions. The subagent's system
prompt says it has no tool that asks a person, and its tool set agrees; several subagents in
parallel do not each open their own question for the user. `EnterPlanMode` and `ExitPlanMode`
stay removed too: a subagent never plans for approval.

Legacy `/workflow` runs (the `Workflow` tool's expert and script kinds) are not dynamic
workflows and keep forced YOLO children.

## Saved workflows

A saved workflow is a file. There is no index, no cache and no registry: the directory
scan is the truth, and every operation reads the disk.

### The file

```
/* zcode-workflow
description: Pre-release check for this repository: lint, tests, changelog
whenToUse: when the user asks to release / ship / do a pre-release check
args:
  target:
    type: string
    required: true
    description: package name or path to check
  skipTests:
    type: boolean
    default: false
*/

const reviewer = agent("Reviewer");
const found = await reviewer.ask<string>(`Check ${String(args.target)}`);
return found;
```

The file is `<name>.dwf.ts`, valid TypeScript: a `/* zcode-workflow` block comment carrying
YAML metadata, closed by a line containing only `*/`, followed by the script byte for byte.
The block comment (not a `---` fence) keeps editors working; YAML (not JSON) tolerates hand
edits; `.dwf.ts` (not `.ts`) lets a scan tell workflows from sources without opening them.

```ts
interface SavedWorkflowMeta {
  description: string;
  whenToUse?: string;
  args?: Record<string, { type: "string" | "number" | "boolean" | "json";
                          description?: string; required?: boolean; default?: unknown }>;
}
```

The metadata schema is strict, so a misspelled key is a visible parse error, not a silently
dropped field. The name is the file name and is not repeated inside; renaming is `git mv`.
The scope is the directory the file sits in and is not stored either.

Four parse failures have distinct names, because each calls for a different fix:
`missing_frontmatter`, `unterminated_frontmatter`, `invalid_yaml`, `invalid_metadata`.

The script body that follows the terminator is what gets type-checked, executed, and
hashed for resume. Diagnostics therefore count lines from the body, not from the top of
the file.

### Names and scopes

A name matches `^[A-Za-z0-9_.-]+$`, is at most 64 characters, and is not made only of
dots. Every operation validates the name before joining it into a path; the pattern is the
path-traversal defense.

| Scope | Directory | Visible from |
|---|---|---|
| `project` | `<cwd>/.zcode/workflows/` | this project |
| `global` | `~/.zcode/workflows/` (the agent process's home directory) | every project on this machine |

Lookups run over the roots in that order and the first hit wins: a project workflow hides
a global one of the same name. A lookup or listing may instead be directed at one scope;
a directed listing does no hiding, which is how the hub's global group shows a shadowed
global workflow. The legacy `Workflow` tool's `.workflow.js` files share the directories
and are invisible to the scan.

### `SaveWorkflow`

```ts
interface SaveWorkflowInput {
  name: string;
  description: string;
  whenToUse?: string;
  args?: SavedWorkflowArgsDeclaration;
  script?: string;                      // body only, no metadata block
  script_path?: string;                 // or: the file holding the body (a draft, usually)
  scope: "project" | "global";          // required, no default
  run_id?: string;                      // provenance: the run this workflow was distilled from
  // filled in by resolveInput, never by the model:
  path?: string;
  overwrite?: boolean;
  shadowing?: "hides_global" | "hidden_by_project";
}
```

`scope` is the model's decision every time. The field description gives the criterion:
`project` when the script references this repository's files, commands, conventions or
layout; `global` when it depends on nothing in the project.

`run_id` is provenance, not a source: the run whose work this definition came out of, when
the user asked to keep a workflow that had just run. It changes nothing about what is
written — the script still comes from `script` or `script_path` — and it is the only durable
link between a run and the workflow a model distilled from it, which is what lets the
completion card of that run show itself as saved
(`docs/dynamic-workflow/transcript-and-notifications.md`, "Which workflow a run is saved
as"). The GUI's own save has no need of it: it names the run in the call itself.

The call follows the same lifecycle as `CreateWorkflow`:

1. `validateInput`: the name is valid, exactly one of `script` and `script_path` is given
   (the field is not called `path` here only because `path` is already this tool's resolved
   destination), and an inline script does not itself start with `/* zcode-workflow`
   (metadata goes through the fields; there is no clever merge).
2. `resolveInput` reads a `script_path` file and rewrites the input with its body as `script`,
   dropping a metadata block the file may carry (a draft copied from a saved workflow keeps
   one; the fields, not the block, are what the user approves). It then computes the target
   path, whether a file already exists there
   (`overwrite`), and whether the other scope has a workflow of the same name
   (`shadowing`). These are the facts the confirmation must show, and they travel in the
   input so that every client version sees them.
3. `alwaysAsk`, then `prepareApproval` compiles the body with the same checker as
   `CreateWorkflow`. Diagnostics mean no window and nothing written.
4. The window: "Save this workflow to the project?" / 「把这个工作流保存到项目里？」, or
   "Overwrite the existing saved workflow?" / 「覆盖已保存的同名工作流？」 with an overwrite
   badge and a warning line; then the name, the path, `description` and `whenToUse`, an
   arguments table (name, type, required, default, description), and the script in a
   collapsible closed by default. Options: Allow once and Deny, plus the generic feedback
   row. No graph, no Refine, no session option.

   The window sits above the composer, and the model writes the description, the
   arguments and the script, so any of them can be long. The window is at most the smaller
   of 72% of the viewport height and 42rem, the same cap as the question window in the
   same place. It has exactly one vertical scrolling area: everything above the options.
   The options, the feedback row and Confirm stay below it, behind a hairline, so the
   decision is always on screen. The question and the name are the top of that area, not
   pinned above it: pinning them left too little room on a short viewport and needed a
   second scroller as a fallback.

   Pinning holds only on a viewport at least 36rem tall. The pinned part alone can reach
   about 320px (the options, a feedback box that grows to 5 lines, an error line and the
   Confirm row), more than the cap on a short screen such as a phone held sideways, where
   the window would clip it and Confirm with it. Below 36rem the whole window is the one
   scrolling area instead, and the options scroll with the content; the cap, the hairline
   and every disclosure stay the same. Either way there is exactly one vertical scroller.

   No part scrolls on its own. A scroller inside a scroller sends a single wheel
   gesture to whichever box happens to be under the pointer, then hands it on to the outer
   one. Long parts are shortened by disclosure instead, and each disclosure makes the one
   area longer:

   | Part | Collapsed | Expanded by |
   |---|---|---|
   | `description`, `whenToUse` | the first 4 lines | 「展开」 / "Show more" under the text, shown only when the text is actually cut; 「收起」 / "Show less" folds it back |
   | Arguments | the first 8 rows | 「显示全部 N 个参数」 / "Show all N arguments" under the table; 「收起参数」 / "Show fewer arguments" folds it back |
   | Script | closed | the script toggle; it opens inline at full height (a long line still scrolls sideways inside the code block) |

   The arguments table's column header sticks to the top of the scrolling area while
   its rows pass under it, and long names and defaults wrap rather than widening the
   table. A new request resets every disclosure to collapsed.

   Every disclosure is reachable from the keyboard. The window opens with focus on the
   first option, and Tab cycles through the options and the feedback row as in every
   permission window. Shift+Tab on the first option leaves that cycle and lands on the
   last control in the scrolling area (the script toggle); from there Tab and Shift+Tab
   walk the disclosures in reading order, and Tab past the last one returns to the
   selected option. The browser scrolls the area to the focused control.
5. Allow writes the file (creating the directory), replacing any existing one. The
   `overwritten` flag in the output is re-derived at write time, not copied from the input.

```ts
interface SaveWorkflowOutput {
  diagnostics; ok; response;
  name: string; scope: "project" | "global"; path: string;
  overwritten?: boolean;      // only when a file was written
}
```

The tool description carries one hard rule for the model, because it has to be read before
the model decides whether to call at all: never call `SaveWorkflow` unsolicited. When a
workflow looks reusable, suggest saving it in one sentence and wait; call the tool only after
the user agrees, or when the user asked directly. The file format, the argument declarations
(exactly the values that would change between runs), the overwrite rule and the authoring
rules are the `dynamic-workflows` skill's §16.5, and the call is refused until that skill has
been loaded in the session (`docs/dynamic-workflow/authoring.md`, "The skill gate").

`SaveWorkflow` is a `workspace`-scoped, medium-risk write, like `Write` and `Edit`. The
tool-call card that remains in the transcript shows the scope row (「作用域：项目」 or
「全局 · 对所有项目可见」) and, when relevant, the shadowing sentence: 「同名的全局工作流将被
这一份遮蔽」 or 「本项目里已有同名工作流，在这里会遮蔽它」.

### `ListSavedWorkflows`

No input. Output:

```ts
interface ListSavedWorkflowsOutput {
  workflows: { name; description; whenToUse?; args?; scope; path }[];
  invalid?: { path: string; reason: string }[];
}
```

It scans both roots for the session's working directory (depth one, `.dwf.ts` only,
sorted), applies the first-wins rule, and never returns script bodies: a listing of twenty
workflows must not pour twenty scripts into the context. Files that cannot be read or
parsed go into `invalid` with their path and reason, so the model can name the broken file
instead of it vanishing. A missing directory is an empty list, not an error.

The tool is read-only and needs no approval; plan and build modes allow it, and workflow
children keep it. Its description separates it from `ListWorkflowRuns`: this lists
definitions you can run, that lists runs that happened. The model is told to check here
before writing a workflow from scratch.

### Running a saved workflow

`CreateWorkflow { saved: { name, args?, scope? } }`:

- The lookup follows the scope rule; `scope` restricts it to one root. A name that resolves
  nowhere produces an error listing the names that do exist, each tagged `(project)` or
  `(global)`, including shadowed global ones, so the model learns when it needs
  `scope: "global"`.
- Arguments are validated against the declaration in one pass that collects every problem:
  unknown keys (an undeclared-args workflow rejects any argument), missing required values,
  and type mismatches. `json` accepts anything; `number` rejects `NaN` and infinities.
  Defaults are filled in and type-checked by the same rule as supplied values, so a
  declaration whose default does not match its type fails at call time with a clear message.
- The normalized input carries the body verbatim, so the confirmation window, hooks and the
  handler all see the same script, and the window looks exactly as it does for an inline
  script plus the saved-source badge and the arguments grid. The run's display name is the
  saved name unless the model passes `name`.
- The validated argument bag rides with the run: `submit` → engine config → the journal's
  `dwf_run.args_json` → the sandbox, where the script reads it as the frozen global `args`
  (`docs/dynamic-workflow/authoring.md`). An inline run's `args` is `{}`, never
  `undefined`. A resumed run replays the stored arguments and the stored concurrency bound
  and accepts no new ones; new arguments mean a new run and a new window.
- Neither the file nor the hub's launch dialog carries a concurrency limit or a subagent
  model. `max_concurrency` and `subagent_model` belong to the call that starts a run, not to
  the definition: `SaveWorkflow` stores neither, so a saved workflow runs at the default
  parallelism with its subagents on the session model unless the `CreateWorkflow` call that
  started it said otherwise, and a run started with 「运行」 on the hub takes the model of the
  session the hub created for it.

### Changing a workflow's scope

The two directions are different operations, because a project workflow usually references
its repository and a global one by definition does not.

- **Global to project** is a file move: `workflows/move` (see "Data path") renames
  `~/.zcode/workflows/<name>.dwf.ts` into the project's directory, falling back to copy and
  unlink across devices, byte for byte. It never overwrites; an existing target is rejected
  with `target_exists`. Overwriting is something only `SaveWorkflow` does, through its
  window.
- **Project to global** is the model's generalization ("Promote to global" on the hub).
  Nothing moves; the model reads the file, extracts repository-specific paths, commands and
  conventions into `args` or neutral wording, and saves a new global copy through
  `SaveWorkflow`, with the usual window. The source file is untouched, so both copies
  coexist and the project one shadows the global one inside that project until the user
  deletes it.

## Script files

Every script the tools work on has a home on disk, and that file is the handle the model
edits between submissions. Inline text is only a door: the moment `CreateWorkflow`,
`AmendWorkflow` or the hub receives a script that did not come from a file, it writes one.
The reasons are the three costs of inline resubmission: a script of twenty thousand tokens
streamed again for a one-line fix (and stalled by some providers), a script that context
compaction has already dropped by the time the run errors, and a compiler round that
regenerates the whole body instead of editing a line.

### The drafts directory

`<cwd>/.zcode/workflow-drafts/`, a sibling of `.zcode/workflows/` (the definitions the user
keeps) and `.zcode/workflow-runs/` (the compiled entry of every run). It is created on first
use with its own `.gitignore` containing `*`, written once and never rewritten, so drafts
never appear in the project's git status and the project's own `.gitignore` is not touched.
Nothing deletes a draft.

A file is named `<slug>.dwf.ts`. The name is the run's `name`; without one, the first
`phase("…")` literal of the script (every script must carry phase markers, written for the
user in the user's language, so it is the closest thing to a name); without that, `workflow`.
The `CreateWorkflow` description asks the model to always pass `name` for an inline script,
because it labels the run everywhere and names this file. The slug keeps Unicode letters and
digits plus `_ . -` (a Chinese name stays readable), turns whitespace into `-`, drops
everything else (which is exactly the path separators, Windows' reserved characters and
control characters), and is cut at 64 code points; `-2`, `-3`, … is appended while the name
is taken. The run label's own fallback, the script's first line, is deliberately not used:
in practice that line is a comment banner. Every inline submission mints a new file,
including one the model should have made by `path`: a draft is never overwritten behind the
model's back.

| Source | What is written | When |
|---|---|---|
| inline `script` | the script, byte for byte | in the handler, before the compile result is read, so a draft that fails to compile is on disk for editing; the handler runs for every inline call, since a non-compiling script skips the window |
| `saved` (tool call or hub launch) | the saved file, byte for byte, metadata block included, so `args` keep validating on resubmit | in `resolveInput`, right after the one read of the saved file, so the copy is the bytes just read and no second read can diverge from them; the normalized `saved` block records the copy's path as `draft`. The definition itself is never edited on a run's behalf |
| `path` | nothing; the file is already the working copy | — |

The write is best effort. A project directory that cannot be written (a read-only checkout,
`.zcode` being a plain file) does not fail the call: the tool proceeds without a file, the
response carries no path, and the old instruction, fix the script and resubmit inline, is
what the model reads. There is no fallback to a temporary directory, because a draft the
user cannot find in the project is not worth a path.

### An inline draft counts as written by the model

`Edit` and `Write` refuse a file the session has not read (`FILE_NOT_READ`), because the
model must not change bytes it has never seen. An inline draft is the one file where that
is already settled: its bytes are the `script` argument of the call that produced it. So
the handler that writes an inline draft records it in the session's read state exactly as
`Write` records the file it wrote (full view, the content, the file's modification time and
size), and the `Edit` the response asks for goes through without a `Read` of a script the
model has just produced. Without this the first `Edit` after every inline submission fails,
and the recovery is a full `Read` of what may be twenty thousand tokens, the very cost the
file exists to avoid.

Only bytes the model authored in that call count:

| Draft | Recorded as written? |
|---|---|
| inline `script` on `CreateWorkflow` / `AmendWorkflow` | yes |
| the copy of a `saved` workflow | no; it carries a metadata block and a body the model may never have seen |
| the fresh draft of an amend that kept the predecessor's script | no; the script may come from another session or from before a compaction |
| a hub launch, or the GUI's Configure workflow | no; no model call wrote it |

Everything else about the guard holds. A draft edited by anyone else after the submission
has a later modification time, so the `Edit` is refused as stale and the model reads it
first. The record is persisted on the tool part as `Write`'s is, so it survives a session
resume; context compaction clears it with the rest of the read state. It is best effort
like the draft itself: if the file cannot be inspected after the write, nothing is recorded
and the model's first `Edit` asks for a `Read`, as before.

### The `path` source

`path` names a script file, relative to the session's working directory or absolute. Any
readable file is accepted, exactly as `Read` accepts it. A file whose first non-blank line
is `/* zcode-workflow` is parsed as a saved workflow ("Saved workflows"): the block is
stripped, the body is the script, and the top-level `args` field is validated against the
block's declaration with the rules of `saved.args`. Any other file is the script whole, and
`args` is rejected because nothing declares them. `resolveInput` reads the file once and
rewrites the input to `{ name, script, path: <absolute>, args? }`; from there on hooks, the
window and the handler see the same bytes they would see for an inline script, and an edit
to the file after approval does not change what the run executes.

The same field exists on `AmendWorkflow` (in place of `script`) and on `EvalWorkflowSnippet`
(in place of `code`, read whole; the resolved input carries the bytes as both `code` and
`script`). On `SaveWorkflow` it is `script_path`, because `path` is
already that tool's resolved destination; the file's body is what gets saved and a metadata
block in it is dropped, since the metadata comes from the fields.

### Provenance

A run remembers the file it started from. `scriptPath`, an absolute path, travels with the
submit and amend requests into the `run-launched` event exactly as `subagentModel` does, and
is read back into the run snapshot and detail. It is absent for a run whose draft could not
be written and for runs older than this feature. A run started by `path` records that path;
a run started from an inline or saved script records its draft; an amended run records the
file its revision came from. An amend that kept the predecessor's script records the
predecessor's file when it still holds that script and a fresh draft otherwise ("Keeping the
predecessor's script"); in no case does a run record a file holding a different script.

Three model-facing surfaces read it, each in words that make the next move an edit:

- The tool response. On diagnostics: "The script is saved at {path}. Edit that file in
  place and resubmit with `path`; do not paste the script inline again." On a launch: "The
  script is saved at {path}; to revise it later, edit that file and pass `path` to
  AmendWorkflow."
- The terminal notification of an errored run
  (`docs/dynamic-workflow/transcript-and-notifications.md`, "What the model reads").
- `GetWorkflowRun`, as the `scriptPath` field and inside the `<amendable>` block.

A path is written workspace-relative when the file is under the session's working
directory and absolute otherwise.

### Diagnostics in file lines

When the script has a file, each diagnostic reads `{path}:L{line}:C{column} {message}` with
`line` counted in the file, metadata block included, so the number pastes into an `Edit`
against that file. The display payload keeps counting from the script body, because the
transcript shows the body. Without a file (a draft the tool could not write) the line stays
`L{line}:C{column} {message}` in body lines, as before.

### Editing a draft needs no approval

An `Edit` or `Write` whose target resolves under `<cwd>/.zcode/workflow-drafts/` is allowed
without a window (`PermissionService`, rule `tool.workflowDraft.preapproved`), at the same
point in the decision order as the preapproved `WebFetch` URLs: after the project's deny and
ask rules, after plan mode (which still blocks every write), before the mode defaults. The
directory is machine-owned and ignored, and running the script is gated by the confirmation
window whatever the file says. The tool executor passes the working directory in the
permission context for this purpose; a context without one preapproves nothing.

### What the user sees

Nothing new. The confirmation window, the tool row, the run card and the run pane do not
show the path: those surfaces are already dense, and the path is the model's handle, not
the user's. A `path` submission has no drafting pen, since nothing streams
(`docs/dynamic-workflow/presentation.md`, "The draft and the pen"); the model's edits appear
as ordinary `Edit` rows on a file under `.zcode/`.

## The hub page

The hub is where a user sees, manages and runs saved workflows without a conversation.

### Where it lives

The automations main view has two top-level tabs, and the page title is the switch:
「自动化 / 工作流」 ("Automations / Workflows"), two title-sized words side by side, the
inactive one in a subtler colour. Arrow keys move between them. The last choice is kept in
`sessionStorage` under one application-wide key, so returning from a detail page or a
conversation lands on the same tab. A navigation request with `openAutomationTab:
"workflow"` selects the tab. The automations view, and with it the hub, is not offered in
the web remote-control shell.

Below the title: a subtitle (「保存在已打开项目里的工作流，填好参数就能再跑一次。」), the
section heading 「已保存的工作流」 with the total count, and, on the right, a ghost button
「工作流设置」 (Workflow settings) followed by the current mode's label in the tertiary text
colour, then a refresh button 「刷新」 that makes every group reload past its cache. The
settings button opens Settings › Agent 能力 › 行为与工具, where the mode row lives (see "The user's choice"),
and is present exactly when that row is, which is whenever the hub is shown, except for a
snapshot from an older Host.

### Groups

The list is grouped, and the groups are always mounted so each can load and report its
state; a spinner covers the page until the first group has loaded.

**The global group** comes first, always, even when empty. Its header: 「全局」 (Global), a
badge 「对所有项目可见」 (visible from every project), the count, and a 「通过对话创建」
(Create in chat) button. An empty group shows 「还没有全局工作流。适合放不依赖某个项目的
流程，例如深度调研。」 An agent too old to understand the `scope` parameter shows 「当前
agent 不支持全局工作流。」; a machine with no reachable local agent shows 「无法连接本地
agent，全局工作流暂不可用。」 The create button is disabled with the hint 「打开一个本地项目
以运行」 when no local project is open.

**One project group per open project**, in sidebar order. A project is an open workspace
tab that is neither a conversation workspace nor read-only; remote workspaces count and
are served by their own agent. The header: the project label, a 「当前」 (current) badge on
the active workspace, the count, and 「通过对话创建」. Switching the active workspace moves
the badge; it does not reorder the groups. A project group with no valid workflow and no
broken file is hidden.

When every open project is empty (the global group does not count), a card replaces the
groups: 「已打开的项目里还没有保存的工作流」, a hint that unopened projects do not appear,
and 「通过对话创建」 aimed at the active project. With no project open at all the page says
「打开一个项目以查看它的工作流。」

A group with unreadable files shows a warning strip below its grid: 「{count} 个文件无法
读取」 and one monospace line per file, `path — reason`. A project group that failed to
load shows 「读取工作流失败：{error}」.

### Cards

A card is a fixed-height cell in a two-column grid:

| Part | Content |
|---|---|
| Name | one truncated line |
| Description | two clamped lines |
| Last run | 「尚未运行」 (never), or 「已完成」 / 「出错」 / 「运行中」 / 「已停止」 with a relative time, each with its own icon and colour |
| Arguments | up to three monospace chips of argument names, then `+N` |
| 「运行」 (Run) | an outline button; see "Direct launch from the hub" |
| ⋯ menu | 「查看详情」 (open), 「在对话里修订」 (revise in chat), 「复制路径」 (copy path), then 「提升为全局」 for a project workflow or 「移到项目…」 for a global one, a separator, and 「删除工作流」 in red |

Clicking anywhere else on the card, or Enter/Space, opens the detail page. Cards of remote
projects have no scope item: a promoted copy would land in the remote machine's home
directory, which the hub never reads.

"Last run" is the newest journal run whose `name` equals the workflow's name. A run the
model launched under a different `name` belongs to no saved workflow.

### The detail page

The detail page replaces the list. Its breadcrumb is 自动化 › name, and the section crumb
returns to the list. The breadcrumb has no project level: a project is a group in the list,
not a page, so a crumb for it would have nowhere to lead. The page says which project the
workflow belongs to in its header instead. Every action on the page targets the workflow's
own project, never the active one.

| Part | Content |
|---|---|
| Header | the name, beside it a small outlined label with the project's label (「全局」 for a global workflow), the description, a primary 「运行」 button and a ⋯ menu (revise, copy path, the scope item, delete). The label is plain text, not a control; a long project label is cut with an ellipsis. |
| 「最近产物」 (latest artifacts) | the artifact chips of the newest completed run that published any, clickable into that run's session |
| Tabs | 「定义」 (definition) and 「运行历史」 (run history, with the count); the file path with a copy button on the right |
| Definition: 「基本信息」 | 「说明」 (description, required), 「使用时机」 (when to use, with the help 「给 ZCode 的路由提示：什么场景该选这个工作流。」), and a 「参数」 table (name, type, required, default, description) with add and remove. Row errors: 「参数需要名字」, 「参数名重复」, 「默认值与类型不符」. |
| Save bar | appears only when the form differs from the file: 「放弃更改」 and 「保存元数据」. Saving rewrites the metadata block and leaves the script byte for byte (the note says so: 「只改写文件顶部的元数据，脚本正文保持原样。」). |
| Definition: 「脚本」 | the script, read-only, with a copy button and the note 「脚本只读。要改脚本，在对话里让 ZCode 修订后另存一版。」 |
| Run history | one row per run of this name: status word, start time, a project column for global workflows, `duration · tokens`, `key=value` argument chips, artifact chips, and 「查看实例」 (open run) |

「查看实例」 needs the run's parent session id and tool call id, and for a global workflow
the run's project must be open; it switches to that session and opens the run pane. The
project column shows the open project's label when the run's `cwd` matches one exactly,
otherwise the directory's base name with the full path as a tooltip, and such rows cannot
be opened. An artifact chip, on the strip or on a run-history row, makes the same session
switch and then opens the artifact there, an HTML one straight in the browser tab
(`docs/dynamic-workflow/authoring.md`, "How the user sees them").

A workflow whose file has disappeared shows 「这个工作流已不在项目里。」; other read failures
show 「无法读取这个工作流：{reason}」.

### Deleting

Delete asks first: 「删除工作流「{name}」？」 / 「会从项目里删除 {path}。已有的运行记录会保
留。」 / 「删除」. It deletes only `<name>.dwf.ts` under the chosen scope's root, after
validating the name; run records stay in the journal. The group reloads; a detail page for
that name returns to the list.

### Create and revise in chat

「通过对话创建」 and 「在对话里修订」 start a new task in the workflow's project with a
prefilled draft, not a sent message; the user finishes the sentence:

| Action | Draft (zh) |
|---|---|
| create, project | 「帮我设计一个工作流，跑通后保存到本项目：」 |
| create, global | 「帮我设计一个工作流，跑通后用 SaveWorkflow 保存为全局工作流（scope: "global"）：」 |
| revise | 「请修订已保存的工作流「{name}」（{path}）：」, plus 「它是全局工作流，保存时保持 scope: "global"。」 for a global one |

For the global group these land in the active local project, or the first local project.

### Promote to global

「提升为全局」 (project cards and detail pages, local projects only) creates a new session in
that project whose first user message is sent immediately:

> Promote the saved project workflow "{name}" ({path}) to a global workflow. … 1. read the
> file and understand its structure; 2. find every reference to this repository (paths,
> commands, layout, conventions, branch names); 3. turn them into `args` declarations with
> descriptions and sensible defaults, or neutral wording, keeping the causal structure;
> 4. save with `SaveWorkflow` and `scope: "global"`, keeping or improving the name, without
> touching the original file; 5. summarize what was generalized. If the workflow is
> inherently bound to this project, explain why and stop.

The GUI then switches to the new session. Only the name and path are sent; the model reads
the file itself. The save still goes through the `SaveWorkflow` window, where a same-named
project workflow shows as `hidden_by_project`. A rejected session creation shows 「提升失
败：{reason}」 and leaves nothing behind.

### Move to project

「移到项目…」 on a global workflow opens a small dialog titled 「移到项目」 with a project
select (local projects only; with none open it says 「打开一个本地项目以移动」 and the
「移动」 button is disabled). Submitting calls `workflows/move`. Success shows 「已移到
{project}」, closes any detail page for that name, and reloads both groups.
`target_exists` shows 「目标位置已有同名工作流」; other failures show 「移动失败：{reason}」
and keep the dialog open.

### Data path

The hub, and the completion card's save controls, talk to the agent through eight
workspace-level, session-less protocol methods.
All schemas are strict; `scope` defaults to `project`; for `global` the `workspace` field
names the runtime that does the work, whose path is not read.

| Method | Params | Result |
|---|---|---|
| `workflows/list` | `{ workspace, scope? }` | `{ workflows, invalid, dir }`; `dir` is the scanned directory, returned even when it does not exist, so the GUI can watch it |
| `workflows/get` | `{ workspace, name, scope? }` | `{ ok: true, name, path, scope, meta, script }` or a failure |
| `workflows/updateMeta` | `{ workspace, name, meta, scope? }` | `{ ok: true, path }`; reads the script back and rewrites the file with the new metadata |
| `workflows/delete` | `{ workspace, name, scope? }` | `{ ok: true, path }` |
| `workflows/runs` | `{ workspace, name?, limit ≤ 50, scope? }` | `{ runs, truncated? }`; `project` filters by `cwd`, `global` drops the filter and adds `cwd` to each row; rows carry `runId, name?, status, stopReason?, createdAt, updatedAt, spentTokens, parentSessionId?, toolCallId?, args?, cwd?, artifacts?` (at most 8) |
| `workflows/move` | `{ workspace, name }` | `{ ok: true, from, to }` or `{ ok: false, reason: invalid_name \| not_found \| target_exists \| read_error \| write_error, path?, detail? }` |
| `workflows/save` | `{ workspace, runId, name, meta, scope?, overwrite? }` | `{ ok: true, name, scope, path, overwritten, shadowing? }` or `{ ok: false, reason: invalid_name \| run_not_found \| script_missing \| target_exists \| compile_failed \| write_error, path?, detail? }` |
| `workflows/forRun` | `{ workspace, runId, candidates? }` | `{ entry?, match?: candidate \| script \| name, runArgs? }` |

Failures of `get`, `updateMeta` and `delete` share one shape: `{ ok: false, reason:
"invalid_name" | "not_found" | "parse_error" | "read_error", detail? }`. The handlers use
the same store and codec as the model tools; the GUI never parses a metadata block itself.
`workflows/list` always passes a directed scope, so the project group never leaks global
entries and the global group never loses a shadowed one. A journal without introspection
support answers `workflows/runs` with an empty page.

**Saving a run, from the GUI.** `workflows/save` is the completion card's verbatim path
(`docs/dynamic-workflow/transcript-and-notifications.md`, "The popover"). It takes a run,
not a script: the script it writes is the one that run actually executed, read from the
journal record (`scriptText`), so an amended run saves the script that settled it and a
transcript whose tool input was trimmed away saves the same bytes as one that was not. The
handler validates the name, refuses a target that exists unless `overwrite` says the user
was shown the warning, compiles the body with the same checker `SaveWorkflow` uses, and
writes through the same store; `overwritten` is re-derived at write time and `shadowing` is
computed as it is for the tool. A run the journal does not know is `run_not_found`; a record
from before scripts were stored is `script_missing`; diagnostics come back as
`compile_failed` with a bounded message and nothing is written. The call carries the run's
own workspace for both scopes, because the journal it reads lives there.

`workflows/forRun` answers "which saved workflow is this run" for the same card, in the
three-rule order that spec gives, and returns the resolved entry, the rule that matched, and
the run's stored arguments for the launch dialog. Both are refused by an agent that predates
them with a method-not-found, which is what the card reads as "this agent cannot save
directly".

**Carrier for global calls.** A global call from the services layer with no workspace
picks the first reusable local active runtime, else the plugin-management workspace's
runtime; never a remote one, so `~` is this machine's home directory.

**Freshness.** Each project group watches `<project>/.zcode/workflows` and the global group
watches the `dir` it was told, non-recursively, and reloads 300 ms after a change; a save
from a conversation therefore shows up on its own. Run records are not files: the hub
re-reads them on load and refresh, and shows no live progress; the conversation and the
task island do that.

**Cache.** A store shard per group (`"global"` or the workspace key) holds entries, bad
files, the newest 50 runs of that scope, `dir`, loading and error state. `list` and `runs`
are fetched in parallel; a failed `runs` call is logged and treated as empty so the list
still renders. In-flight requests are deduplicated unless the caller bypasses the cache.

## Direct launch from the hub

「运行」 starts the saved workflow in a new session, with no model turn and no confirmation
window. The model first hears of the run when its completion or question notification
arrives.

### The launch dialog

A project workflow with no declared arguments starts immediately on click; a failure
appears as a toast. A project workflow with arguments, and every global workflow (it needs a
target project), opens the dialog:

| Part | Content |
|---|---|
| Header | a workflow icon, the name in monospace, a scope badge 「全局」 / 「项目」, and the description |
| 「运行于」 (Run in) | global workflows only: a select over the open local projects, defaulting to the active one. With none open the select is replaced by 「打开一个本地项目以运行」 and Run is disabled. |
| Arguments | one field per declaration: a switch for `boolean`, a monospace textarea for `json`, a number input for `number`, a text input otherwise; a 「必填」 (required) badge; the description. Errors under the field: 「必填」, 「需要一个数字」, 「不是合法的 JSON」. Blank optional fields are omitted; blank required fields without a default fail. |
| Note | 「将立即在 {project} 的新会话中运行」 |
| Footer | 「取消」 and 「运行」, the latter showing a spinner while pending |
| Error area | appears when the launch is rejected: the reason text, then the agent's message in a monospace block (for `compile_failed`, the diagnostics) |

The dialog is as tall as its content, up to the smaller of the viewport height less a 1rem
margin on each side and 45rem. A declaration can carry any number of arguments, so the
dialog is laid out in three zones and only the middle one scrolls:

| Zone | Parts | Behaviour |
|---|---|---|
| Top | Header | fixed |
| Middle | 「运行于」 and the argument fields | scrolls on its own once the content passes the height cap. With three or more rows (「运行于」 counts as one) it shrinks no further than 6rem; with fewer it does not shrink at all, since its content is already shorter than a useful scroll area. |
| Bottom | Note, error area, footer | fixed, so the consequence of the click, the result of the last attempt and the buttons are always on screen. The agent's message block scrolls inside the error area past 10rem. |

When the fixed zones alone leave less than the middle zone's minimum (a very short
viewport), the dialog as a whole scrolls instead, so every part stays reachable.

A submit that fails validation scrolls the first failing field into view and moves focus
to it: with a long list the field and its error may be far from the visible part of the
list, and a click that changes nothing on screen reads as a dead button.

### The launcher

The launcher runs once at a time:

1. Acquire a connection lease on the target project's agent.
2. `createSession { workspaceId }`, with no first input and no config: the session takes
   the runtime's default model and mode. If this is rejected, report a generic error; no
   session exists.
3. `startSavedWorkflow { name, scope, args? }` on the new session (`args` omitted when
   empty).
4. Accepted: navigate to the new session, where the run card is already at the top.
   Rejected or thrown: delete the empty session, show the error in the dialog (or as a
   toast for the no-dialog path), and stay on the hub. The transcript therefore only ever
   contains runs that actually started.
5. Release the lease.

Rejections map to text by their fault code: `fault.command.capabilityUnsupported` → 「当前
agent 不支持直接启动工作流」; `fault.command.savedWorkflowStartRejected.<reason>` →
「工作流名无效」 (`invalid_name`), 「找不到这个工作流」 (`not_found`), 「部分实参不合法」
(`invalid_args`), 「工作流脚本编译失败」 (`compile_failed`), 「会话忙，请重试」
(`session_busy`), 「工作流启动失败」 (`start_failed`); anything else → 「工作流启动失败」.

### On the agent

`startSavedWorkflow` is a v4 session command with payload `{ name, scope?, args? }` and an
accepted result `{ type: "startSavedWorkflow", runId, toolCallId }`. It needs no base
revision. The app registers the capability only when the run port exists; otherwise the
client gets the capability-unsupported fault. The runtime method `startSavedWorkflowRun`
does the work, in this order:

| Step | On failure |
|---|---|
| The session has an active or queued turn | `session_busy` |
| Resolve the saved workflow (directed by `scope` when given) and validate the arguments; this is the same code `CreateWorkflow` uses, not a copy | `invalid_name`, `not_found` (a malformed file is reported as `not_found` with a message naming the file), `invalid_args` |
| Compile; any diagnostic rejects | `compile_failed`, diagnostics in the message, capped at 2,000 characters |
| Resolve the model names the script uses ("Models the script names") with the same code `CreateWorkflow` uses; an unresolved name is a 9011 diagnostic and rejects like one | `compile_failed` |
| The run port is present | `start_failed` |
| Persist the session with the workflow name as its title. The protocol's session record mirrors the runtime's persisted fact on the next session event, so the new session leaves draft state and enters `session/list` and the sessions index (the sidebar) without a first prompt | |
| Mint `toolCallId = launch-<uuid>` and `port.submit({ scriptText, cwd, name, args, modelBindings?, parentSessionId, toolCallId, trace })` | `start_failed`; the persisted empty session is what the GUI deletes |
| Record the launch turn (below) and register the run in the background-task tracker with a synthetic `CreateWorkflow` tool call `{ id: toolCallId, name: "CreateWorkflow", input: { name, saved: { name, scope, args? } } }` | logged only; the run is already in flight and can be cancelled from the pane |

Up to and including compilation nothing is persisted. The synthetic tool call is what lets
notifications, cancel, resume and the run pane treat a launched run exactly like a
tool-started one; only the `launch-` prefix and the turn's origin tell them apart.

### The launch turn

The launch is recorded as a control-only turn holding one user-visible, role `user`
message (synthetic source `workflow_launch`, semantics `real_user`) whose text is for the
model:

> Started the saved workflow "{name}" ({scope}) from the workflows hub as run {runId}.
> Arguments: ```json …``` Progress and results arrive as background notifications; do not
> start it again.

The turn and the message both carry the launch metadata, so live projection and cold
restore produce the same rows:

```ts
interface WorkflowLaunchMeta {
  runId; toolCallId; name; scope: "project" | "global"; path;
  args?: Record<string, unknown>;   // replaced by a placeholder over 4 KB
  description?: string;             // ≤ 500 chars
  display?: CreateWorkflowDisplay;  // the compiled graph, same shape as the tool row's
  script?: string;                  // ≤ 256,000 chars
}
```

The `display` is built by the same function that builds the `CreateWorkflow` tool row's and
the confirmation window's display, from the same three analysis projections (sites and
lanes, phase vocabulary, subagent cards and hand-offs). There is no second assembly of the
graph anywhere; a launch's graph is byte-for-byte what the tool path would have produced.

In the transcript the launch turn **is a run card**: the same `WorkflowRunDigest` a
`CreateWorkflow` row gets, with the timeline, the subagent pills, the questions chip, Cancel
and `⤢` (`docs/dynamic-workflow/presentation.md`「The run card」). The turn has no user
bubble: the launch user row is marked `origin: "workflowLaunch"`, and a turn whose header
carries the launch metadata does not count that row as a visible input (the canonical
sentence is for the model). A turn whose metadata is missing on both rows (an older
client) degrades to the sentence in a bubble. When the run is no longer in the eight-run
projection, the card is the header-only neutral card, "Workflow ended" / 「工作流已结束」,
never blank.

Completing the launch turn also takes a fresh session out of the projection's `draft` phase
(to `completedSuccess`, or `error` if the control-only turn failed). A draft is by definition
a session that never had persisted content; a session with a launch turn has, and the store
seeds it with a terminal phase after a restart. Without this the live sessions index would
carry a `draft` summary that the task-index syncer drops, and the session would appear in
the sidebar only after a restart. A control-only turn on a session that has already left
draft leaves its phase alone.

The launch facts that a tool-started run does not have are shown in the **run pane** as a
provenance block under the status header, for directly launched runs only: 「由你从工作流中
枢启动 · {time}」 (started by you from the workflows hub) with the scope badge 「项目」 /
「全局」, the description when present, and a key/value table of the arguments.

The pane finds the graph by the run's originating tool call id; for a direct launch there is
no `CreateWorkflow` row, so the same lookup table takes it from the launch metadata's
`display` (`docs/dynamic-workflow/presentation.md`).

## Changing a run's settings from the GUI

The run card and the run pane carry a **Configure** button. It changes the two settings a user
sets on a run, the model its subagents run on and how many of them work at once, without a
model turn. It has two outcomes, and which one Apply takes is decided by what the user
changed:

| What Apply carries | Outcome |
|---|---|
| only `maxConcurrency`, on a run the agent holds live (always a running one; a pending one only once its engine exists) | the run is **retuned in place**: same run id, no new run, nothing stopped, the finished and the in-flight work all kept |
| anything else: a model change, either change on a run that has settled, both at once | an **amendment that keeps the script**: the agent starts a new run of the run's recorded script under the new settings, imports everything the old run finished as a cache, and supersedes the old run, as an `AmendWorkflow` call that omits both `script` and `path` would |

The popover says which of the two applying will do before the user applies. The route is the
one the tool takes for the same change, through the same port method, so a user and a model
asking for the same thing get the same thing
(`docs/dynamic-workflow/concurrency.md`, "Retuning a live run"). How the button, the popover
and the transcript look is in `docs/dynamic-workflow/presentation.md` ("The settings popover").

### Which runs can be configured

| Run | Configure | Why |
|---|---|---|
| pending or running | yes | the main case: throttle the run, which is applied in place, or move its subagents to another model, which is an amendment |
| stopped and resumable | yes | a resume with changed settings; Resume alone keeps the same run |
| errored | yes | a retry under another model is the usual repair |
| stopped by an amendment (superseded) | no | its successor is the live run and carries the button |
| completed | no | every ask would replay from the cache, so nothing would run under the new settings |
| not in the run projection | no | the pane has no settings to show |

The button needs a host callback, like Resume: a read-only session and a host with the gray
release off (see "Gray release: the `dynamicWorkflow` feature key") get none. An agent without the
command answers `fault.command.capabilityUnsupported`, which the popover shows as a rejection.

### The command

`amendWorkflowRunSettings` is a v4 session command sent to the session that owns the run. It
carries no base revision, like `cancelBackgroundWork` and `resumeWorkflowRun`.

```ts
interface AmendWorkflowRunSettingsPayload {
  workId: string;                    // ≡ runId, as for cancel and resume
  subagentModel?: string | null;     // omit = keep; null = back to the session model; "providerId/modelId[$level]" = set
  maxConcurrency?: number | null;    // omit = keep; null = back to the default parallelism; n = set (floored to at least 1, no upper limit)
}
// accepted: { type: "amendWorkflowRunSettings", runId, toolCallId, supersededRunId? }
// rejected: fault.command.workflowRunSettingsRejected.<reason>, with a message
```

The two fields follow the tool's rule, omit means keep, so the popover sends only what the user
changed. `runId` and `toolCallId` in the accepted result name the new run; `supersededRunId` is
present when the old run was still in flight and was stopped.

One accepted result means the other outcome: a retune answers with the **same** `runId` the
payload carried and no `supersededRunId`, since nothing was started and nothing was stopped.
That is how the client tells a retune from an amendment without a second field for it — an
answer naming a run id the caller did not send is a new run.

| Reason | When | Popover line |
|---|---|---|
| `not_found` | no run with this id belongs to this session | "This run is not in this conversation's records." |
| `not_configurable` | the run completed, or an amendment already replaced it | "This run can no longer be configured." |
| `unchanged` | after resolution, neither setting differs from the run's own | "These are the run's current settings." |
| `script_missing` | the run has no stored script, or the host cannot read it | "This run has no stored script, so its settings cannot be changed here." Only the amendment reads a script, so a live run with no stored script can still have its parallelism retuned |
| `model_unavailable` | the model cannot be resolved against this agent's model catalog | "That model is not available on this agent now." |
| `compile_failed` | the stored script no longer compiles against the current facade | the resume wording: ask the agent to amend the workflow; the diagnostics under it |
| `missing_boundaries` | the run's journal lacks the transcript boundaries the cache needs | "This run's records are too old to carry its finished work over." |
| `start_failed` | the port is missing or the amendment threw | "The new run could not be started ({message})." |

Nothing is stopped or created before every check has passed. The old run keeps running through
any rejection.

### On the agent

`amendWorkflowRunSettings` on the app delegates to the runtime method of the same name. It is
the second caller of both `port.retuneConcurrency` and `port.amend`, beside the tool handler,
and shares the tool's resolution code rather than copying it:

| Step | On failure |
|---|---|
| Read the run with `port.getTask`; it must exist and its parent session must be this session | `not_found` |
| A completed run, or one with `supersededBy`, is refused | `not_configurable` |
| Resolve `subagentModel` with the tool's tri-state rule against the snapshot's model and the model catalog (`resolveAmendSubagentModelChoice`) | `model_unavailable` |
| Resolve `maxConcurrency` with the tool's tri-state rule against the snapshot's limit and the default parallelism (`resolveAmendMaxConcurrency`); a value equal to the default counts as no limit | |
| Compare with the run's own settings; if neither changed, refuse | `unchanged` |
| **The fork.** Only the bound changed → `port.retuneConcurrency({ runId, maxConcurrency })`, the popover's `null` travelling on as itself: on `ok` mint `toolCallId = settings-<uuid>`, queue the settings turn from the answer's `previous`, `maxConcurrency` and `defaultConcurrency`, and reply with the same `runId` and no `supersededRunId`, registering nothing new in the background-task tracker; on `unchanged` refuse; on `not_live` (settled, or pending with no engine yet) carry on down this table | `unchanged` |
| Read the stored script with `port.getScript` | `script_missing` |
| Compile the script (`analyzeScript`) | `compile_failed` |
| Rebind the script's model names from the snapshot's `modelBindings` ("Models the script names"): the script is the run's own, so every name it uses was bound at launch and keeps that binding, resolved again against the catalog | `model_unavailable` |
| Mint `toolCallId = settings-<uuid>` and call `port.amend` with the script, the predecessor id, `cwd`, the resolved settings, the model bindings, the new script's phase tables, the parent session id, the tool call id and `inheritArgs: true` | `missing_boundaries`, `not_found`; a throw is `start_failed` |
| Register the new run in the background-task tracker with a synthetic `AmendWorkflow` tool call `{ id: toolCallId, name: "AmendWorkflow", input: { run_id, name } }` | logged only |
| Queue the settings turn (below) and return the accepted result | logged only |

The script read moved below the fork on purpose: a retune runs no script, so a run whose
record has none, or whose script no longer compiles, is still retunable. The model resolution
stays above it, because "did anything but the bound change" cannot be answered until the
model's three states have been resolved into a value to compare.

`inheritArgs` gives the new run the arguments its predecessor was launched with
(`dwf_run.args_json`). The script is the predecessor's own, so the arguments it reads still
apply; a saved workflow started from the hub with arguments would otherwise rerun with an empty
`args`. The tool path does not pass it. A retune passes nothing of the sort: the run keeps the
arguments it has been running with, because it is the same run.

The model is not asked and no window opens on either branch. The amendment of a running run
stops it with the initiator `superseded`, so its own terminal notification is not delivered, as
for a tool amend; a retune stops nothing, so there is no notification to suppress.

### The settings turn

The change is recorded as a control-only turn, the same shape as the hub's launch turn: one
user-visible, role `user` message with source `workflow_launch`, whose text is for the model, and
the launch metadata on the turn and the message. The metadata carries an `amend` block that says
what changed:

```ts
interface WorkflowLaunchMeta {
  runId; toolCallId;                 // the new run; on a retune, the run that was retuned
  name?;                             // always on a hub launch; on a settings turn only when the run has a name
  scope?; path?; args?; description?; // hub launches only
  display?: CreateWorkflowDisplay;   // the compiled graph of the script, as for a launch
  amend?: {
    predecessorRunId?: string;                       // absent on a retune: there is no predecessor, the run is the same one
    subagentModel?: { from?: string; to?: string };  // present when the model changed; absent end = the session model
    maxConcurrency?: { from?: number; to?: number }; // present when the limit changed; absent end = the default parallelism
    ceiling?: number;                                // the default parallelism D (wire name predates it), for "默认 13 → 4"
  };
}
```

A retune writes the same block with `predecessorRunId` left out, and its absence is what says
"applied in place": `runId` is the run the user was already looking at, `maxConcurrency` is
the move, and there is no second run for the reader to reconcile. `display` is absent too,
since a retune compiles nothing, and the turn draws its row and no card
(`docs/dynamic-workflow/presentation.md`, "The run card"): that run's card is already in the
transcript where it was launched, and a second one for the same live run would be a duplicate,
not a record.

Making `predecessorRunId` optional is a recorded schema skew, of the same tier as `scope` and
`path` on this metadata: a consumer old enough to require it fails to parse the settings turn
and drops that one row, while every other row and the run itself are unaffected. The amendment
keeps sending it, so only the in-place turn is exposed, and what is lost there is the record of
a change, not the change.

A settings turn takes the name of the run it changes. An unnamed run gives an unnamed settings turn,
and the card, the pane and the notification show it under the same fallback word as any unnamed
run; the agent never makes a name up from the run id. The synthetic `AmendWorkflow` call carries
`name` under the same rule.

The message text names the old run, what changed and the new run:

> Changed the settings of workflow run {A} ("{name}") from the GUI: its subagents now run on
> {model}; at most {n} of them run at once. The same script continues as run {B}, which supersedes
> run {A} and imports everything run {A} finished as cache. Progress and results arrive as
> background notifications; do not amend, resume or restart it.

Only the changed settings appear; "its subagents are back on the session model" and "the limit
on subagents at once is removed" stand for the two `null`s. When run {A} had already settled,
"supersedes" reads "takes over from". The model is named by its canonical string, and the
quoted name is left out for an unnamed run.

A retune's text says that the run continued, because the sentence above would otherwise send
the model looking for a run {B} that does not exist:

> Changed the settings of workflow run {A} ("{name}") from the GUI: at most {n} of its
> subagents run at once. Run {A} keeps running under the new limit; nothing was stopped and no
> new run was started. Progress and results arrive as background notifications; do not amend,
> resume or restart it.

"the limit on subagents at once is removed" stands for the `null` here too, and the closing
instruction is the same one every launch turn carries, for the same reason: the run is in the
background and the model is not to poll it.

An amendment marks its predecessor superseded only when it had to stop it. A stopped or errored
run that is configured keeps its own settlement, so its card still offers Resume and Configure
beside the new run's card, exactly as after an `AmendWorkflow` call on a settled run.

The turn is not emitted inside the command handler. It is queued on the runtime command queue as
a `control-only-turn` command, which runs the same `emitControlOnlyUserTurn` the launch uses.
When the session is idle the queue runs it at once. When the main agent is mid-turn it waits
until that turn ends, because a user message cannot enter a turn in progress; the change itself
has already happened, and the run pane shows the new run meanwhile. The command has the
background notifications' priority, so it lands before any notification of the new run. Like
them it carries the branch generation, and a rewind drops it. The queue is in memory: an agent
that exits before the turn runs loses the record, but not the run.

## Composer entries

The composer offers two ways in that are authoring entries, not launch buttons:

- The plus menu's 「添加」 (Add) section lists 「工作流」 (Workflow) right after the attachment
  item and 「目标」 (Goal). Choosing it inserts the `/workflow` slash-command token into the
  empty draft, exactly as typing it in the `/` panel would; nothing is sent. The item is
  offered only for a strictly empty draft and only when the CLI's slash-command catalog
  contains a command named `workflow` (a built-in command the CLI withholds while the gray
  gate is off, and the composer must not send text the CLI will not expand).
- In the `/` panel the catalog pins `workflow` immediately after `goal`, so the two
  "start a piece of work" commands sit together.

What `/workflow` does once invoked is the authoring skill's business:
`docs/dynamic-workflow/authoring.md`.

The composer's background-work badge is the other workflow-shaped control there. It counts
running background work; clicking it opens the background panel, or, when one workflow run
is the only running activity, that run's details directly.

## The CLI and the TUI

The terminal client has a minimal surface: an inline card per `CreateWorkflow` or
`AmendWorkflow` tool call, a `/dwf` command, and an auto-allow for the confirmation. There is no graph, no panel and
no drill-down into subagent transcripts; the model's `GetWorkflowRun` answers deeper
questions.

### The inline card

The card joins the tool call to its run by tool call id and reads a `workflowRuns` mirror
that the TUI maintains with the same reducer the desktop projection uses
(`@zcode/shared`'s `workflow-runs-reducer`), fed by `dynamic_workflow_run_progress` events
through a subscription that outlives turns. There is no second clock: no polling, no
interval.

Collapsed, one coloured line:

```
Workflow <label> - <status> (<settled>/<observed> steps)  [+ to expand]
```

Expanded: token usage, up to six subagents with their status, the last ten `log()` lines
(200 characters each), a result preview (200 characters), the error, and a truncation
marker. The six subagent rows are the running ones first, then the waiting, then the
completed, each bucket in the run's own actor order, so a wide run's card still shows what
is running now rather than the six agents that happened to start first. `+` and `-` expand
and collapse every card at once; they are consumed only when the draft is empty and at
least one card exists, so pasting a diff still types normally. `stopped` shows its reason,
`stopped (model error)`.

On start and after `/resume` the TUI replays the journal's events for the session's runs
into the same reducer (so a card shows real step counts, not zeros), then fetches the
session's run list for labels, and prints one system line per resumable run:

```
Workflow <label> was interrupted and can be resumed: /dwf resume <runId>
```

Nothing resumes on its own. Raw events of subagent sessions never reach the main
transcript: the TUI drops any event whose session id is not the main session's before
applying it, otherwise a subagent's `turn_complete` would be appended as the main agent's
answer.

### `/dwf`

| Command | Effect |
|---|---|
| `/dwf`, `/dwf list` | this session's runs (up to 20), one per line: `runId · label · status[/reason] · resumable · updated <time>`, plus a failure suffix |
| `/dwf cancel [runId]` | cancels the run; without an id, cancels the single in-flight run or lists the candidates when there are several |
| `/dwf resume <runId>` | resumes through the server, which alone decides resumability; rejections are shown with their reason (`not_found`, `not_resumable`, `already_running`, `script_missing`, `script_mismatch`, `compile_failed`, the last one followed by the bounded diagnostics) |

A client without the capability answers "Dynamic workflow runs are not available in this
client." The list is session-scoped; project-wide history is the model's `ListWorkflowRuns`.
Under `--workflow-mode disabled` (the CLI's default) `list` and `cancel` keep working and
`resume` is refused with the disabled notice, since it would start an engine; see "The
standalone CLI: `--workflow-mode`".

### The approval bypass

In the TUI the permission responder resolves any `CreateWorkflow` or `AmendWorkflow` ask as
`allow` before an approval prompt is built, so no prompt renders. In headless mode a minimal
broker allows the same two tools and delegates every other tool to the deny broker headless
has always used (without it a `-p` run would fail at once with "No permission client
configured").

This bypasses the gate, not permissions: core is unchanged, `PermissionRequest` hooks still
answer first, permission events still fire, no `permissionUpdates` are written, and the
run's subagents inherit the session's permission profile (in `plan` mode they stay
read-only). For other tools the TUI prompt still offers Allow once, Always allow in this
project, and Deny; Escape denies.

### Headless runs

Headless `-p` / `--prompt` and `--target` invocations take their mode from `--workflow-mode`,
the same flag and the same `disabled` default as the TUI (see "The standalone CLI:
`--workflow-mode`"). `--resume` and `--continue` use this invocation's flag, never a value
from the resumed session. Explicit tool disallowlists still take precedence when the mode
turns the tools on. For example:

```sh
zcode --workflow-mode alwaysOn -p "/workflow review this change"
```

A `-p` run that started a workflow does not exit when the turn ends. Once workflow activity
has been observed (a progress event, or a `BackgroundTaskStarted` of kind `workflow`), the
process waits until the runtime reports no running background tasks and no active or queued
turn work, which covers the notification-driven turn in which the model summarizes the
result. The `response` is then the last turn's text, and a `turnResponses` array carries
every turn's text in order when there was more than one. A run with no workflow activity
behaves exactly as before. There is no timeout or separate wait flag; Ctrl-C exits, and the orphaned
run is recorded as `stopped` (`interrupted`) and can be resumed.

| Output format | Workflow progress |
|---|---|
| `stream-json` | one NDJSON line per progress event, `type: "workflow.run.progress"`, with the bounded payload verbatim and no `turnId` (these are out-of-turn events). The type is deliberately not part of the v3 protocol's event enum. |
| `text` (the default) | `workflow <runId>: <transition>` lines on stderr: `started`, node phase changes (throttled to one per 400 ms), `log: …`, and the settlement with its status and error |
| `json` | nothing; the contract is exactly one object |

### Single-executable builds

A single-executable build cannot spawn `node --eval`, so the CLI has a hidden subcommand
`__zcode-dwf-child <entry path>` dispatched before argument parsing, and the sandbox is
started by re-executing the CLI itself with that subcommand. The child script is written
to an entry file, `<cwd>/.zcode/workflow-runs/<runId>.mjs` (with a temp-directory fallback
and a `.gitignore`), and the command line carries only its path, so a long script never
exceeds the Windows command-line limit. The sandbox itself is the engine's:
`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`.

## Run introspection tools

Two read-only tools let the model look at runs on demand, including other sessions' runs
in the same project. Their descriptions steer the model away from polling: runs this
session starts settle on their own and deliver a notification with the final output; reach
for these when the user asks how a workflow is going, to review earlier runs, or when a
notification was truncated. Both need no approval, are allowed in plan and build modes,
remain available to workflow children, time out at 10 s, and never write the journal.

Both share one failure when the session has no run port or the journal lacks the
introspection queries: `workflow_introspection_unavailable`, a capability gap that is never
reported as an empty project.

### `ListWorkflowRuns`

```ts
interface ListWorkflowRunsInput { limit?: number; statuses?: LifecycleStatus[] }
// LifecycleStatus = "pending" | "running" | "completed" | "errored" | "stopped"

interface ListWorkflowRunsOutput {
  runs: {
    runId; label; labelSource: "name" | "script";
    status; stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
    resumedFrom?: string; supersededBy?: string;
    ownedByThisSession: boolean; possiblyInterrupted?: true;
    createdAt; updatedAt;            // epoch ms
    spentTokens;
  }[];
  truncated?: true;
}
```

`limit` defaults to 20 and is clamped to 1–50 rather than rejected. There is no `cwd`
input: the tool always queries the session's working directory, matched literally against
the run's recorded `cwd`. The rows come from the journal (newest updated first) joined with
the session's in-memory registry: a run whose `submit` returned but whose journal row is
not yet written appears as `pending`; a run the registry knows to have settled shows the
registry's status. `truncated` is decided by fetching one row more than the limit.

`ownedByThisSession` is true when the run's parent session is this one or the run is in
this session's registry. `possiblyInterrupted` marks a non-terminal run that is not this
session's: it may be a dead process's leftover or a sibling session's live run. It is an
annotation, never a status rewrite; only the owning session's startup reconciles orphans.

The label is `name` when the run has one, else the script's first non-empty line trimmed
to 80 characters, else the run id; the source says which. It is derived at read time and
never written back.

The model's text is one XML-ish `<run …/>` per line, with `resumed_from` and
`superseded_by` attributes when the run has them. The description explains the three
terminal states, that a `stopped` run continues with `ResumeWorkflowRun` unless it was
superseded, and that any run, finished or not, can be revised through `AmendWorkflow`.

### `GetWorkflowRun`

Input `{ run_id }`. Output: the same summary fields as a list row, plus

```ts
summary: string;                            // one deterministic sentence group, ≤ 400 chars, assembled from the fields below
generatedAt: number;                        // epoch ms the snapshot was read; every relative age in the model text is against it
usage: { spentTokens; nodesObserved; nodesRunning; nodesCompleted; nodesFailed };
maxConcurrency?: number;                    // the run's own concurrency bound, only when it differs from the default
subagentModel?: string;                     // the run's subagent model, only when the run chose one
modelBindings?: Record<string, string>;     // the model names the script uses → canonical, only when it uses any
actors: { siteId; ordinal; name? }[];
logTail: { sequence; message; at? }[];     // the last 20 log() entries, in order; `at` is the event's journal time
result?: string;                            // completed only; serialized text
error?: { code; message; providerStop? };   // errored, or stopped by provider / interrupted
pendingQuestions?: { qid; actor; actorName?; question; context?; askedAt }[];
artifacts?: { id; kind; title?; version; contentType?; bytes?; sourcePath?; itemCount; primary?: true }[]; // primary first

phases?: {                                  // absent when the script declared none and none were entered
  name; state: "done" | "current" | "ahead" | "unfinished";
  rounds;                                   // times entered; 0 for "ahead"
  nodesSettled; nodesRunning;
  enteredAt?; exitedAt?;                    // epoch ms, from phase-entered event times
}[];
subagents: {                                // always present, possibly empty
  siteId; ordinal; name?;
  state: "idle" | "executing" | "waiting" | "parked" | "done" | "failed" | "unfinished";
  phaseName?;                               // the phase of its current or last ask
  currentAsk?: {                            // present while one of its ask rows is still running
    siteId; ordinal; actorSeq?;
    instructionsHead?;                      // the author's own instructions, first 240 chars
    startedAt?;                             // epoch ms of the ask's node-dispatched
    turn?; toolCalls?;
    lastTool?: { name; target?; at? };      // at = the node-progress event's time
  };
  wait?: { cause: "slot" | "backoff"; reason?; retryAfterMs?; since? };
  parkedOn?;                                // a pending question's qid
  stepsSettled; stepsFailed; tokens;        // tokens = the sum over its settled asks
  lastProgressAt?;                          // epoch ms it was last seen moving
}[];
subagentsTruncated?: true;                  // the roster was clamped at 64 rows

health: {
  lastProgressAt?;                          // run-wide, epoch ms
  stalledSince?;                            // the last run-stalled with no progress after it
  concurrency?: { effective; cap; reason?; since? };  // only while held below the run's own bound
  consecutiveFailures;                      // trailing failed ask settlements
  cachedSteps;                              // settlements that were replay hits
  leftoverRunning?;                         // terminal runs only: rows still marked running
  pendingQuestionsKnown: boolean;
};
```

`nodesObserved` counts journaled node rows and is never presented as a total; a dynamic
workflow has no static step count. `result` is the script's return value serialized by the
same function the completion notification uses, so the two never disagree; an `undefined`
result omits the field. Empty `pendingQuestions` and `artifacts` are omitted, not empty
arrays. `maxConcurrency` follows the same rule from the other side: it is present only when
the run's own bound differs from the default parallelism, so a run at the default says nothing, and
it is exactly what an `AmendWorkflow` that omits `max_concurrency` would inherit.
`subagentModel` says nothing for the same reason from its own side: a run whose subagents
follow the session model has nothing to report, and the canonical string is present only when
the run chose one, which again is exactly what an `AmendWorkflow` that omits `subagent_model`
would inherit. An unknown id is `run_not_found`. The tool never waits; `TaskOutput` is the
waiting tool for runs this session started.

`phases`, `subagents` and `health` are what turn the counts above into a situation report:
where the run is, what each subagent is doing right now, and whether any of it is moving.
They are derived at read time from the journal — the run's events replayed through the same
reducer the run pane uses, joined with the node and actor rows — and nothing here is written
back. The reads are narrow (`execution-engine.md`, "Reading the journal"): the events come
back with report items past the 64th stripped, exactly as in the cold replay
(`presentation.md`, "Cold replay"), the node rows are the non-report ones without their
results, since the roster reads only kinds, statuses, stats and coordinates, and the actor
rows are read once, without personas.

Every clock in these three fields is `dwf_event.time_created`, the time the journal appended
the event, and nothing else. A `node-dispatched` is when an ask started, a `node-settled` is
when it ended, a `node-progress` is the last time it was seen moving, and a `phase-entered`
both opens its own phase and closes the previous one. A journal written before events carried
that column yields an absent time, never a zero and never the reader's own `Date.now()`:
stamping a week-old history with the moment it was read is the one failure this field exists
to prevent. Node rows contribute only status and, on a settled ask, its token count.

A subagent's `state` answers one question and is read in one order. While the run is live:
`parked` when a question of its own is waiting for an answer, else `waiting` when its current
ask's last lifecycle event was `node-waiting` (a slot or a backoff, which `wait` names), else
`executing` when one of its ask rows is still running, else `failed` when its last settled ask
failed, else `idle`. Once the run is terminal the live words are gone: `unfinished` when an ask
row is still marked running (the process died under it), else `failed` when its last settled
ask failed, else `done`. `currentAsk` is present exactly while an ask row of its own is
running, and carries that ask's assignment and progress readings; each of those is absent on a
journal that predates the field rather than presented as a zero, because zero tool calls is
itself a fact.

A phase is `ahead` when the script declared it and the control flow has not reached it, which
is the only state with `rounds: 0`; `current` when it is the last phase entered and the run is
live; `unfinished` when the run is terminal and the phase still holds asks in flight; `done`
otherwise. The table is the declared phase names in script order, followed by any phase that
was entered without being declared, and the whole field is absent only when the script
declared none and none were entered. `enteredAt` is the phase's most recent entry and
`exitedAt` the entry of the next phase after it, so the current phase has no exit.

`health.pendingQuestionsKnown` is the honest half of `pendingQuestions`. Parked questions live
in the asking process's memory and nowhere else, so a session reading a run it is not itself
running cannot tell an unanswered question from none at all. It is true when this session holds
the run in its own registry of live runs, or when the run is terminal — a terminal run has
nobody listening by definition — and false otherwise, and while it is false `pendingQuestions`
stays absent and no subagent is reported `parked`. A run whose journal row names this session
but which this process is not running is a restart's leftover, and it reads as unknown like any
other: the parked questions died with the process that held them.

`stalledSince` is the last `run-stalled` observation with no progress recorded after it.
Progress means an ask moved or the script itself moved: a node event, a phase entry, a `log`
line, a report or an artifact. A script running a string of world reads between asks emits no
ask events at all, so leaving its own output out would report it as stalled. Waiting for a slot
or a backoff is not progress either way, since that wait is the stall, and neither is a
`concurrency-changed` or a `run-stalled`, which are observations about not moving.

`concurrency` is present only when the governor is holding the run below its own bound, and it
says what is in flight against that bound, why, and since when. The bound is the run's
`max_concurrency` when it set one and the default parallelism otherwise; the reason and the
time come from the last `concurrency-changed`. The default is deliberately not the denominator, and
the run's own bound is already reported on its own as `maxConcurrency`: a run launched with
`max_concurrency: 3` on a six-way machine would read "3 of 6" for its whole life and look
throttled while it is doing exactly what it was asked to.

The model's text is a block per fact, in one fixed order: `<summary>`, then the identity and
lifecycle tags — `<run_id>`, `<label>`, `<status>`, `<stop_reason>`, `<resumed_from>`,
`<max_concurrency>`, `<subagent_model>`, `<script_models>`, `<superseded_by>`, `<owned_by_this_session>`,
`<possibly_interrupted>`, `<created_at>`, `<updated_at>` — then `<pending_questions>`,
`<health>`, `<phases>`, `<subagents>`, `<log_tail>`, `<usage>`, `<result>`, `<error>`,
`<artifacts>`, and last the routing blocks `<superseded>`, `<resumable>` and `<amendable>`.
`<max_concurrency>`, `<subagent_model>` and `<script_models>` stay next to each other and each
is present only when the run set one; `<script_models>` holds one `"{name}" = {canonical}` line
per binding. Pending questions come before health, the roster and the log tail, with
instructions to answer them through `ResolveWorkflowQuestion`.

An absent fact is an absent word: no block, no line and no field is rendered as `0` or as
"unknown" to stand in for something the journal does not know. There are exactly two
exceptions, and both exist because silence there would be read as an answer: when
`health.pendingQuestionsKnown` is false the `<pending_questions>` block is present and says in
one sentence that this session cannot see them and that resuming the run re-asks whatever a
subagent still needs, and a terminal run with `health.leftoverRunning` gets a second line in
`<health>` saying that the rows below marked running are leftovers rather than live work: of
the exited process for an interrupted run, of the ended run otherwise. The summary says the same:
a superseded run's leftovers belong to the new run, and only a stopped run's are re-dispatched on
resume. A leftover makes its phase `unfinished`, even when the stop event has already settled the
reduced node, and the summary's "across N phases" counts only the phases the run entered.

Every time in the text is written twice: the ISO 8601 instant, then its age relative to
`generatedAt` in parentheses, as `40s ago`, `5m 10s ago`, `2h 15m ago` or `3d 2h ago`. One
snapshot has one clock: `generatedAt` is read once per call, so two ages in the same output are
always comparable. A `logTail` entry whose event predates the journal's time column simply
carries no age prefix.

`<summary>` is assembled by the tool from the structured fields, never by a model, so the same
snapshot always yields the same sentence: the status with elapsed or ended time, the phase
position (`in phase 2 of 4 (judge)` while phases exist, `across 4 phases` once they are all
behind it), the settled and running step counts with the executing/waiting/parked breakdown,
the pending question count or the fact that it is unknown, the age of the last progress, and,
for a completed run, the deliverable's title. It is capped at 400 characters by dropping whole
trailing sentences.

`<health>` is one line of `key=value` readings, plus the leftover note. `<phases>` is one line
per phase with its index, name, state, rounds, settled and running counts and its duration or
time so far. `<subagents>` is one line per subagent — name when it has one, address, state,
phase, then what that state is about: the current ask's address and step index, the time on
that step, the turn and tool-call counts and the last tool with its age for one that is
executing; the wait cause and retry delay for one that is waiting; the question id and its age
for one that is parked; the settled step count otherwise — and its token total, followed by an
indented `task:` line carrying the ask's `instructionsHead` when the journal has one. The
`step N` printed beside an ask address is that ask's 1-based position in its own subagent's
sequence, the journal's `actorSeq` plus one, so the model can name the ask either by its
address or by its position. A
`stopped` run gets a `<resumable>` block whose sentence depends
on the reason (a user-stopped run is resumed only when the user asks; a provider stop needs
its cause fixed first). Every run gets an `<amendable>` block naming `AmendWorkflow`,
strongest for an `errored` run: fix the script and keep the finished work rather than
rewrite. Outside the one-sentence form below, it also says that a change of settings alone
omits both `script` and `path`, and, on a run that is still going, that a call carrying only
`max_concurrency` retunes it where it is instead of starting anything. On a run that is `running` and not stalled that block is one sentence instead of a
paragraph: a healthy run is not a decision the model has to make right now, and the routing
argument is worth its length only where something has actually gone wrong. A superseded
run gets a `<superseded>` block instead of `<resumable>`: it names the successor and says to
read or amend that run, since resuming a superseded run would redo work its successor owns.

### Their cards

Both tools carry a structured display payload (`list_workflow_runs`, `get_workflow_run`)
so their transcript cards are not raw JSON. The list card shows a count and one row per run
(status dot and word, label, time, tokens), marks this session's runs, warns on
`possiblyInterrupted`, and notes truncation. The status card's summary line is the label
and the assembled `summary` sentence; expanded it shows the result first for a completed
run, the error first for a failed one, then status, usage and non-empty logs. That `error`
carries only `code` and `message`; `providerStop` belongs to the model-facing output alone,
since the display schema is mirrored field for field in `packages/shared`. Old sessions
without a payload fall back to bounded text.

The status card carries the situation report too: the same assembled `summary` sentence, the
`phases` table, a bounded `subagents` roster (name, address, state, phase, the current ask's
`instructionsHead`, turn and tool-call counts, the last tool, the wait cause, tokens and the
times) and `health`. The payload is a trimmed subset of the tool output rather than a copy of
it: it carries what a card draws and nothing it does not, its enum sets are closed and identical
to the tool's, and its own bounds — 32 phases, 64 subagents, the reducer's string limits — are
applied on the display channel, which does not pass through the result budget. A roster or a
phase table clamped by those bounds sets the payload's `truncated` flag, the same one the log
tail already uses.

Every one of those five fields is optional on the wire although the producer always fills them.
A payload persisted before the situation report existed carries none of them, and the display
schema is strict: requiring them would fail the whole payload and blank that card in every
session already on disk. The text fallback this spec promises is for a row with no payload at
all, not for an older one, so a card reads whichever of the five it is given and draws the rest
from the counts it has always had.

## The model catalog

`subagent_model` names a model this host has configured. `ListModels` is how the model reads
that list instead of guessing at it: no input, no approval, allowed in plan and build modes,
still available to workflow children, like the other read-only listings.

```ts
interface ListModelsOutput {
  current?: string;              // providerId/modelId of the session's own model
  models: {
    id: string;                  // providerId/modelId
    providerId; modelId; providerLabel?;
    reasoningLevels: string[];   // empty when the model has none
    defaultReasoningLevel?; contextWindow?; disabledReason?;
  }[];
}
```

Each row's `id` pastes verbatim into `subagent_model`, with `$<level>` appended to take one
of that row's `reasoningLevels`. The session's own model is marked `[current]`, so the model
can see that choosing it is the same as omitting the field; a row carrying a `disabledReason`
cannot be used and says why, to be resolved with the user rather than picked around. The
model's text is one line per model inside `<models count="N">` rather than a block per entry
as `ListSavedWorkflows` writes: catalog rows are many and nearly identical, and the only
thing to do with one is copy its id. A host with nothing configured answers with a sentence
saying so and telling the model to omit `subagent_model`, rather than with an empty
container, which reads as a tool that failed to answer.

The description says in as many words that the tool does not change the model the session is
running on: the session model is the user's choice, and `subagent_model` moves only the
workflow's subagents. Without it, a tool that lists models is read as the switch for one. A
session with no model catalog fails the call with `model_catalog_unavailable`, a capability
gap that is never reported as an empty configuration, for the same reason
`workflow_introspection_unavailable` is not an empty project: a user who owns a dozen models
must not be told they have none.

The tool carries a `list_models` display payload, so its transcript row is a catalog card
rather than the model-facing text. The summary line is the kind word and a count; while the
call is in flight the kind word alone. Expanded, the models are grouped under their
provider's name, one row per model id, with the word "current" on the session's own model
and the context window at the right of the row; a row that cannot be used carries its reason
in place of nothing. A row's thinking levels and its canonical id live in the row tooltip,
which is the only place the canonical id appears. A host with nothing configured says so in
one sentence and has nothing to expand, and a failed call shows the status word rather than
an empty list, keeping "this session cannot read the catalog" distinct from "this host has
no models". The provider id is never rendered, the same rule the subagent model label
follows: on a team plan it is a UUID.

## Gray release: the `dynamicWorkflow` feature key

Status: implemented. The server decides, per client, which mode a user gets by default. The key is `data.configs.dynamicWorkflow.mode`
in the `/api/v1/client/configs` response, with the values `"disabled" | "onDemand" |
"alwaysOn"`. The user can pick any of the three modes in Settings (see "The user's choice"),
and an explicit choice always wins. The server only sets the default: the mode of a user who
has not chosen.

### What each mode means

The table describes the *effective* mode: the user's choice where one applies, otherwise the
offered mode.

| Mode | Behaviour in this version |
|---|---|
| `disabled` | No way to start a workflow. The ten workflow tools are not registered for the model, the `/workflow` command is absent from the slash catalog (so the composer's plus-menu entry and `/` panel entry disappear with it), the `dynamic-workflows` skill is not offered, and the automations page shows only 「自动化」 with no 「工作流」 tab. Runs that already exist keep rendering everywhere they did before: transcript cards, digests, completion cards, the run pane and its artifacts, the sidebar run line. Every Resume affordance is withheld (the run pane's, the transcript card footer's and the digest's) because each would start an engine; they share one supply point, the conversation context's resume callback. |
| `onDemand` | Every door of `alwaysOn`, with the model-facing tool surface deferred. The `/workflow` command stays in the slash catalog (so the composer's plus-menu entry and `/` panel entry stay), the `dynamic-workflows` skill stays discoverable, the automations page keeps its 「工作流」 tab and every Resume affordance is offered; but the ten workflow tools are **not registered for the model, and the `Agent`/`Task` descriptions carry no CreateWorkflow line, until the session is activated** by its first `/workflow`, by a Resume or Configure of one of its runs, or by resuming a session whose records already hold a workflow. Once activated a session stays activated. See "On demand: activation". `enabled = mode !== "disabled"` (`isDynamicWorkflowModeEnabled` in `packages/shared/src/dynamic-workflow-feature.ts`) still answers every "is the feature offered at all" question; only the registration gate reads the mode itself. |
| `alwaysOn` | Everything this document describes; the ten tools are registered from the session's first request. |

The key absent, malformed, or the request failed: the offer is `disabled`. A server that
stops sending the key has turned the default off; a stale "on" snapshot is never carried
forward past a successful response that lacks it. A user's explicit choice still applies on
top (see "The user's choice"). The terminal UI and headless `-p` runs never consult the
key: the standalone CLI does not read `/client/configs`. Its mode comes from the
`--workflow-mode` flag and is `disabled` when the flag is absent (see "The standalone CLI:
`--workflow-mode`").

### Who decides and who consumes

```
Host (packages/services)
  BigModelCodingPlanSubscriptionProvider.getDynamicWorkflowClientConfig()
    ← the cached /client/configs snapshot (1 h TTL, forceRefresh bypasses it)
    ← ZCODE_DYNAMIC_WORKFLOW_MODE (local override, see below)
    → the offer: { offeredMode, source }                     (latched once per Host process)
  settings.dynamicWorkflowMode (the user's choice, absent = follow the offer)
    ← local and standalone-server Hosts: their own settings file, read at each use
    ← desktop-attached remote Hosts: pushed by the desktop (see "The user's choice")
    → applyDynamicWorkflowUserMode(offer, choice): { mode, enabled, offeredMode, userMode?, source }
      │
      ├─► zcodeAgentService, at workspace client start and after every change of the choice:
      │      workspace/updateDynamicWorkflowPolicy { enabled, mode }   (CLI-wide fact)
      │   and on every session/create, session/resume, v4 createSession:
      │      dynamicWorkflowEnabled: true, dynamicWorkflowMode         (only when enabled)
      │
      └─► ICodingPlanSubscriptionService.getDynamicWorkflowClientConfig  (RPC to the renderer)
             → the automations page and the run pane read `enabled` (effective)
             → the Settings row reads `offeredMode` and `mode`

CLI (apps/zcode-cli, protocol server mode)
  appRuntimePreferences.dynamicWorkflowEnabled / .dynamicWorkflowMode  (default false / absent = fail-closed)
  createRecord: enabled = params.dynamicWorkflowEnabled === true || preferences flag
                mode    = params.dynamicWorkflowMode ?? preferences mode ?? (enabled ? "alwaysOn" : "disabled")
    → runtimeConfig.dynamicWorkflowEnabled, runtimeConfig.dynamicWorkflowToolsOnDemand (= mode is onDemand)
    → registerBuiltInTools({ includeDynamicWorkflow })   ten tools in or out; on demand: out until activation
    → disabled only: listProtocolSlashCommands drops the built-in `workflow`; the builtin prompt resolver does not expand `/workflow`
    → disabled only: the bundled `dynamic-workflows` SKILL.md is excluded from skill discovery
```

The Host is the single owner of the decision, and it reads the server once per Host process:
the first workspace client start awaits the snapshot and latches the offer, and every later
policy sync, session create and resume in that process reuses it. The user's choice is not
latched: it is applied to the latched offer at every use. A server flip therefore
takes effect at the next app start, the same rule as the desktop context prompt gray. The
latch is what keeps a session create from waiting on a network timeout when the machine is
offline; the cost is that a Host that started offline offers `disabled` until restart, so
a user who never chose a mode has the feature off until then (an explicit choice still
applies, see "The user's choice"). The
provider's own 1 h envelope cache and `forceRefresh` serve the renderer's refresh, not the
CLI gate. Remote Hosts over SSH, WSL and Docker evaluate the key themselves through their own
`/client/configs` request, so a remote machine that cannot reach the server offers
`disabled`: the feature is off there unless the user's choice (pushed by the desktop) or the
override (below) turns it on. The CLI never reads the key or the override;
it only consumes what the Host sends, the way `offPeakToolEnabled` works. Old CLIs that do
not know the policy method answer method-not-found, which the Host logs and ignores, and
their `z.object` schemas drop the unknown session flag, so the pairing degrades to disabled.
A workspace's live sessions keep the tool surface they started with; the flag is read on
create and resume, never mid-session, matching the off-peak rule. On-demand activation is
the one mid-session change, and it only adds: a session never loses the ten tools while it
lives.

When the gate is off, other tools' model-facing text stops pointing at the missing tools
too: the `Agent` tool description drops its "CreateWorkflow is mandatory for workflow
requests" line, so the model is not told to reach for a tool it cannot see.

The ten tools: `CreateWorkflow`, `AmendWorkflow`, `SaveWorkflow`, `ListSavedWorkflows`,
`EvalWorkflowSnippet`, `ListWorkflowRuns`, `GetWorkflowRun`, `ResumeWorkflowRun`,
`ResolveWorkflowQuestion`, `FillWorkflowHole`. `ListModels` is not in the set (since 2026-11-04).
It has two consumers: a run's `subagent_model` (see "The model catalog") and session control's
`CreateSession.model`. It is registered when either is present: the gate is on, or session
control is present. It is a deferred read-only tool, so it never enters the main tools segment.
The set is also the cold-resume history test (see "On demand: activation"), and a session that
called `ListModels` only to pick a model for a new session has not used a workflow. The legacy `Workflow` tool and `/expert` are a different feature
and are untouched. Workflow actor sessions (`workflow_child`) inherit the parent's flag, which
is necessarily on, since a child only exists under a run.

### On demand: activation

`onDemand` keeps every door of `alwaysOn` and
defers only what the model sees. A session born under it registers its built-in tools with
the ten workflow tools left out and the `Agent`/`Task` descriptions without their
CreateWorkflow line, exactly as `disabled` does; unlike `disabled`, the `/workflow` command
stays in the slash catalog, the composer keeps its plus-menu and `/` panel entries, the
bundled skill stays discoverable and the automations page keeps its 「工作流」 tab. The
declarations cost about 4 850 tokens on every main-session request (authoring.md "The
authoring surface"); a session that never asks for a workflow never pays them. The skill
stays listed because the command's `skills:` preamble has to be loadable the moment the
command runs, and a listing is one line in a system reminder, not a per-request cost.

**The state.** Each session has one boolean, *activated*, owned by the runtime. Under
`alwaysOn` it is true from construction. Under `onDemand` it starts false and becomes true
at most once; nothing turns it back. The registration gate both `registerBuiltInTools` call
sites share (`resolveRuntimeDynamicWorkflowToolsIncluded`) reads
`enabled ∧ (¬onDemand ∨ activated)`, so the branch refresh can neither re-add nor drop the
tools on its own (DWG-03b keeps holding). Activation is one runtime method: it re-registers
the built-in set with the gate open, invalidates the tool-contract cache so the next model
request carries the ten tools and the restored `Agent`/`Task` lines, and persists a
`runtime/dynamic_workflow_activation` session entry beside `runtime/execution_state`. The
entry is only a shortcut for the history scan on resume (every activation leaves a `/workflow`
message or a `CreateWorkflow` call behind), so a failed entry write is logged as a warning and
the activation still succeeds. A second call is a no-op. The runtime copies its config at construction, so the gate is read
from the runtime, never from the config object the app assembled.

**What activates.**

| Trigger | Where | Why |
|---|---|---|
| `/workflow …` submitted in this session | the input facade, when the builtin prompt resolver expands the command, before `executeTurn` | the turn that asked must already see `CreateWorkflow`; the user's command is the request |
| `resumeWorkflowRun` or `amendWorkflowRunSettings` accepted for a run of this session, or a saved workflow launched into this session from the hub (`startSavedWorkflowRun`) | the runtime methods behind those commands, after the run is started and before its turn is queued | each starts an engine whose completion notification tells the model to use `GetWorkflowRun`; a model told that with no such tool would be stuck |
| resume of a session whose records show a workflow | `resume.ts`, after the persisted messages are loaded, before the first turn | the activation entry is present; or, for sessions born under `alwaysOn` or before this rule, a persisted user message whose text is a `/workflow` command (user prompts persist as `displayInput`, the raw command), or any persisted tool call named one of the ten |

Nothing else activates. An explicit request in prose ("use a workflow to …") is not a
trigger: before activation the model has no `CreateWorkflow`, so it does what it does under
`disabled`, delegates with `Agent` or does the work itself. Under `onDemand` the `/workflow`
command is the only door until the session's first workflow exists (authoring.md "The
command"). The model is not told about the deferral; there is no tool to point it at.

**What does not deactivate.** Compaction: the skill gate closes with compaction because it
asks what the model can currently see; activation asks whether this session has ever had a
workflow, and once one exists the model needs `GetWorkflowRun`, `ResumeWorkflowRun` and the
tools the run notifications name for the rest of the session. A server flip to `disabled`
follows the existing rule: it takes effect at the next Host process, and a live session
keeps the surface it has. Rewind keeps activation too.

**Children.** A subagent child (`Agent`) inherits the parent's surface at spawn: the
enabled flag, the on-demand flag and the parent's activation at that moment, so a child
spawned before activation has no workflow tools and a child spawned after has them. A
workflow actor (`workflow_child`) exists only under a run and is therefore activated; it
still loses the authoring tools through `WORKFLOW_CHILD_DISALLOWED_TOOLS`, as before.

**How the mode travels.** The Host's gate stops folding to a boolean:
`resolveDynamicWorkflowGate` returns the snapshot's `mode`, and `enabled` is derived from
it. Every channel that carries `dynamicWorkflowEnabled: true` also carries
`dynamicWorkflowMode` (`workspace/updateDynamicWorkflowPolicy`, `session/create`,
`session/resume`, v4 `createSession`, `createSessionRecord`); the boolean remains the
enabled fact and remains the only thing older CLIs read. The CLI keeps
`appRuntimePreferences.dynamicWorkflowMode` beside the boolean for the paths that have no
Host params (v4 cold resume), and `createRecord` derives the runtime fields:
`dynamicWorkflowEnabled` as today, `dynamicWorkflowToolsOnDemand: true` only when the
resolved mode is `onDemand`. In core, an absent on-demand field means eager registration,
the same polarity as the enabled field: subagent children and in-process embedders that set
neither keep the full surface, while the standalone CLI always writes both fields from its
flag (DWG-04). A Host older than this rule sends the boolean alone, which a new
CLI reads as `alwaysOn`. A CLI older than this rule pairs the other way: v4 `createSession`
drops the unknown key; the legacy create and resume are strict, and the Host's existing
compat retry omits the rejected `dynamicWorkflowMode` and sends the boolean alone, so that
CLI behaves as `alwaysOn`; the policy method is strict too and has no retry, so its sync is
logged and ignored there and the per-session boolean carries the decision instead. Either
way the older CLI never sees a partial signal: the Host writes the mode only beside
`dynamicWorkflowEnabled: true`, never on its own.

### The user's choice

Status: implemented. One app-wide setting, `dynamicWorkflowMode` in the shared settings
file, holds the user's choice. Absent means "follow the offer". It holds one of the three
modes otherwise.

**Precedence.** The user's choice always wins. The server (or the local override) decides
only the *offer*, `offeredMode`: the default mode, which is the effective mode while the user
has not chosen. An offer of `disabled` is a default like the others, so a user can turn the
feature on where the server does not send the key, where the request failed, or on a remote
machine that cannot reach the server. A Host without a resolver for the offer at all (one
that does not wire the feature) stays `disabled` whatever the choice. The server therefore
has no remote off switch for a user who chose a mode; the feature is generally available, and
the key only moves the default. The shared helper `applyDynamicWorkflowUserMode(offer, choice)`
is the only place this rule is written; the Host calls it, and the renderer only reads its
result.

A snapshot without a readable `offeredMode` (`readDynamicWorkflowOfferedMode` returns
nothing) comes from an older Host (a newer UI bundle, such as the phone remote, attached to an
older desktop), which ignores the choice, so neither the row nor the hub's settings button
appears for it.

**Clear on default.** Picking the option that equals the offered mode deletes the stored
value (the patch carries the empty string, which the settings patch normalizer turns into a
delete, since `undefined` does not survive the RPC hop). An untouched install therefore keeps
following later server flips, for example `onDemand` today and `alwaysOn` in a later release.

**Where it is shown.** Settings › Agent 能力 › 行为与工具, in the card that holds 交互行为, directly below
提问自动继续: label 「动态工作流」, description
「让模型用脚本编排大量子代理并行工作，处理复杂任务、交付专业结果。」, and a 260 px select on
the right. The row uses the wide control column (280 px, stacked under the label on phone
widths); the default 192 px column would shrink the select. The list opens below the trigger
(`position="popper"`) at the trigger's width, and each option has an icon, a title and a
description that wraps inside the list:

| Value | Title | Description |
|---|---|---|
| `disabled` | 关闭 / Off | 禁用动态工作流。不能创建新的工作流，自动化页也不再显示「工作流」；对话历史中已有的工作流仍可正常查看。 |
| `onDemand` | 通过命令启用 / On command | 只有输入 /workflow 命令才会运行新的工作流。 |
| `alwaysOn` | 始终开启 / Always on | 除了 /workflow 命令，模型也会根据你的意图主动运行工作流。 |

The option equal to the offered mode carries a 「默认」 (Default) tag; the trigger shows the
effective mode's title only. The row is always rendered once the availability snapshot is
ready, whatever the offer: under an offer of `disabled` the trigger shows 关闭 and the tag
sits on 关闭. It is not rendered while the snapshot is loading, when reading it failed, or for
a snapshot from an older Host (above). The row has no note about timing; open sessions keeping their tools is the rule below, not something
the row explains.

**When it takes effect.** The same rule as a server flip: sessions created or resumed after
the change get the new tool surface, and live sessions keep the one they have. The CLI-wide
fact does change at once: the Host re-sends `workspace/updateDynamicWorkflowPolicy` to every
live CLI, with `enabled: false` when the choice is `disabled`, so the slash catalog of drafts
prepared afterwards drops or regains `workflow` (and with it the composer's plus-menu entry).
The renderer's availability snapshot is reloaded as soon as the Host has taken the choice,
so the 「工作流」 title word, the Resume affordances and the hub follow the new effective mode
without waiting for any CLI. The snapshot is the Host's own result (offer and choice); no CLI
takes part in it. The policy re-send runs on its own and nobody waits for it, so the slash
catalog and the plus-menu entry can follow a moment after the title word.

**How a change travels.** The settings file is the single source of the choice. A write in
any window reaches every window's renderer through the shared-settings broadcast; each
window's root then calls `zcodeAgentService.syncDynamicWorkflowUserMode` on its own Host and,
once that resolves, reloads its availability snapshot. The call resolves once the Host has
recorded the choice and forwarded it to its remote connections. It only queues the policy
re-send to the live CLIs and does not wait for their answers: a CLI that is busy with another
request, or is still starting, would otherwise hold the snapshot on the old mode (the
automations page kept its 「工作流」 tab after the user picked 关闭). The same holds where the
desktop pushes the choice to a remote Host while connecting: the connection waits for the
remote Host to record it, not for the remote CLIs.

- A Host with its own settings (desktop local, web and standalone server) reads the choice
  from its settings file at every use, so a session created before the signal arrives still
  gets the current choice; the call is only a signal to re-sync. Re-syncs run on a
  per-workspace chain and each step reads the choice when it runs, so a slow policy sync can
  never land after a newer one.
- A desktop-attached remote Host (SSH, WSL, Docker) has no access to the desktop's settings,
  so the desktop pushes the value: once when it builds the remote workspace services (read
  from the settings file), and again from the local Host's `syncDynamicWorkflowUserMode` to
  every live remote connection of that window. The first push is issued on the connection
  before any workspace request, and the connection delivers requests in order.
- A standalone server reached as a remote target keeps its own settings and is not pushed.
- The phone attaches to the desktop Host and follows it; it has no control of its own.
- The standalone CLI keeps `--workflow-mode` and never reads the setting.

**The hub link.** The hub's section heading row carries 「工作流设置」 and the current
mode's label (see "The hub page"). It is shown only while the hub itself is shown, that is,
while the effective mode is not `disabled`. Under `disabled` the page reverts to the plain
「自动化」 title and nothing points at the setting; the way back is Settings › Agent 能力 › 行为与工具, where the
row is always present. A user who chose Off and a user whose default is Off see the same
automations page.

### The local override

One environment variable, `ZCODE_DYNAMIC_WORKFLOW_MODE`, read by the Host resolver before any
network call. When it holds one of the three values the resolver returns it with
`source: "override"` and skips the fetch, so there is no TTL and no first-Host race. Desktop
Main is the gatekeeper: in `buildHostProcessEnv` it always writes or deletes the key before
the Host starts, never passes it through untouched, so the Host trusts whatever it sees.

| Build | What Main writes into the Host env | Effect |
|---|---|---|
| unpackaged dev (`pnpm dev:desktop`) | the developer's shell value, if it is one of the three | any mode, for hand testing |
| packaged preview (`ZCODE_PRODUCT_FLAVOR === "preview"`, production backend) | the literal `alwaysOn` | preview users always have the feature; the server key is ignored |
| packaged production | nothing; an inherited value is removed | the override cannot work |

Remote Hosts started over SSH, WSL and Docker receive the same value through
`pickRemoteRuntimeEnv`, so a preview build's remote workspaces match its local ones. The Web
and server Hosts have no Main and read the process environment directly; there the variable is
the operator's, not an end user's. The CLI ignores the variable entirely.

### The standalone CLI: `--workflow-mode`

The TUI and headless runs (`-p`, `--target`) have no Host, so their mode comes from a process
flag, `--workflow-mode disabled|onDemand|alwaysOn`, with the same three meanings as the server
key. **When the flag is absent the mode is `disabled`**: workflows in the standalone CLI are
opt-in. The value is read with the Host's normalizer (`normalizeDynamicWorkflowMode`: the
exact spelling, surrounding whitespace ignored); anything else fails at the CLI entry with an
error that names the three values, exit code 1, before any app or session exists. There is no
environment variable and no config key; `ZCODE_DYNAMIC_WORKFLOW_MODE` stays Host-only.

**Where the flag is accepted.** With `-p`/`--prompt`, with `--target`, and for the TUI (no
command, or `tui`). Anywhere else it is an error with exit code 1: on `app-server` and
`agent-server` because the Host owns the decision there and a flag would give the mode a
second owner; on the other subcommands (`login`, `plugins`, `skills`, `doctor`, …) because
they create no session for it to shape.

**How it reaches the runtime.** The CLI entry resolves the mode once per process and writes
both runtime-config fields explicitly on every app it creates (the first one and those behind
`/new`, `/resume` and fork): `dynamicWorkflowEnabled = mode !== "disabled"` and
`dynamicWorkflowToolsOnDemand = mode === "onDemand"`. Every consequence after that is the one
the protocol server already has. Under `disabled` the ten tools are not registered, `Agent`
and `Task` carry no CreateWorkflow line, the `dynamic-workflows` skill is not offered and the
builtin resolver does not expand `/workflow`. Under `onDemand` the activation rules above hold
as written; the TUI's `/dwf resume` activates the way the GUI's Resume does, because both go
through `trackResumedDynamicWorkflowRun`. Core's "absent means eager" polarity is untouched:
the standalone CLI simply never leaves the fields absent.

The mode belongs to the process, not the session. Nothing about it is persisted, and resuming
a session under a different mode switches its surface silently, the same rule as a server
flip on the desktop (an `onDemand` resume still restores activation from the session's
records). Existing runs keep rendering under every mode: the inline card, the journal replay
on start and after `/resume`, and the line naming a resumable run.

What the terminal shows under `disabled`:

| Surface | Behaviour |
|---|---|
| TUI `/` palette and `/help`, headless `-p "/help"` | no `/workflow` entry |
| TUI `/workflow …` typed anyway | a local notice that dynamic workflows are disabled and how to restart with them; nothing is sent to the model |
| TUI `/dwf`, `/dwf list`, `/dwf cancel` | unchanged: viewing and stopping a run start no engine |
| TUI `/dwf resume <runId>` | refused with the same notice before the server is asked; a resume would start an engine |
| headless `-p "/workflow …"` | the notice on stderr and exit code 1, before any app is created |

### Acceptance

The saved-workflow hub E2E (`automations-workflows-hub.test.ts`) requires the
case-local client-config gateway to offer `alwaysOn` before Electron starts.
It must not depend on a live rollout or a developer's local mode override.
Nor may it depend on the host's system language: its assertions use the Chinese copy,
so every case pins the UI language to `zh-CN` (`pinE2ELocale`) right after the workspace
is ready (earlier, the renderer has not registered its test actions yet). `clearAppData`
in each suite's teardown clears that setting with the rest.
The hub uses a local replay provider with no seeded OAuth account; account-specific
authentication belongs to separate fixtures, not this file-management and launch case.
Each case closes a launch dialog left by the previous case and leaves the automations
page through the default project's new-task action before preparing the conversation. Deferred worker
cleanup does not reset the page between cases in the same spec.
Run-side-pane actions and assertions target the visible active tab because inactive
tabs remain mounted. Hover assertions must establish pointer hover on the expanded
run row before checking Stop opacity. Concurrency assertions read the numeric input's
value, not its empty text content, and verify the decrement before applying it.
The same gateway continues to omit the key for the disabled gray-release case;
enabling the hub fixture must not change unrelated specs or the fail-closed product default.

| ID | Setup → action → assertion |
|---|---|
| DWG-01 | `resolveDynamicWorkflowClientConfig`: remote `{mode:"alwaysOn"}` → enabled/remote; remote absent, `null`, or `{mode:"bogus"}` → disabled/default; env override set → override wins over remote; `onDemand` → enabled with `mode` preserved as `onDemand` |
| DWG-02 | Host: policy sync sent with `enabled:true` and `mode` only when the snapshot is enabled; method-not-found from the CLI is ignored; create/resume/v4 createSession carry `dynamicWorkflowEnabled:true` and `dynamicWorkflowMode` only when enabled and omit both otherwise |
| DWG-03 | CLI protocol server: no flag → none of the ten tools registered, `workflow` absent from the slash catalog, `/workflow` not expanded; flag on with mode absent or `alwaysOn` → all ten registered from the first request and the catalog pins `workflow` after `goal`; the legacy `Workflow` tool unaffected either way |
| DWG-03b | CLI: the built-in tool set is registered from two places, session start and the embedded-search branch refresh (`refreshBranchAwareBuiltInTools`); both derive the gate from the same helper, so a disabled session stays without the ten tools after the refresh. Regression from the first real-app test, where the refresh re-added them |
| DWG-03c | CLI: a protocol session with the gate off (which includes the server key being absent) gets an `Agent` tool description with no reference to CreateWorkflow; a session with the gate on, and a runtime where the config field is never set, keep the line |
| DWG-04 | Core: a runtime whose config sets neither field (a subagent child, an in-process embedder) registers every tool; unset means on in core only. The standalone CLI never relies on it: without `--workflow-mode` the TUI and headless write `dynamicWorkflowEnabled: false`, and an absent server key always means off |
| DWG-04b | Headless `-p` / `--prompt` / `--target`: `--resume` and `--continue` take the pair from this invocation's `--workflow-mode` (absent → disabled), never from the resumed session; an explicit `--disallowed-tools CreateWorkflow` still removes the tool under `alwaysOn`; `app-server --stdio` / `agent-server --stdio` receive no workflow field from the CLI entry |
| DWG-05 | Desktop Main `buildHostProcessEnv`: dev + shell `disabled` → Host env `disabled`; dev + shell garbage → key absent; packaged preview + shell `disabled` → Host env `alwaysOn`; packaged production + shell `alwaysOn` → key absent |
| DWG-06 | `pickRemoteRuntimeEnv` forwards the key when set |
| DWG-07 | UI, disabled: automations page shows a plain 「自动化」 title and no workflow tab; a navigation request for the workflow tab lands on automations; the run pane, the transcript card and the digest of an existing run render but offer no Resume. Enabled: unchanged from before |
| DWG-08 | Desktop E2E against a mock `/client/configs`: `disabled` → plus menu has no 「工作流」, `/` panel has no `workflow`, automations page has no tab; `alwaysOn` and `onDemand` → all three present |
| DWG-09 | CLI protocol server, mode `onDemand`: the session starts with none of the ten tools and an `Agent` description without the CreateWorkflow line, while `workflow` is in the slash catalog and the `dynamic-workflows` skill is discoverable; submitting `/workflow …` activates before the turn's first model request, which carries all ten tools and the restored `Agent` line; the `runtime/dynamic_workflow_activation` entry is persisted; a later branch refresh keeps the ten; a second `/workflow` changes nothing; a prose request without the command leaves the surface as it was |
| DWG-10 | CLI resume, mode `onDemand`: a session with the activation entry has the ten tools before its first turn; a session without the entry but with a persisted `/workflow` user message, or a persisted `CreateWorkflow` (any of the ten) tool call, is activated on resume and gains the entry; a session with neither stays deferred. Mode `alwaysOn`: activated regardless |
| DWG-11 | v4 `resumeWorkflowRun` / `amendWorkflowRunSettings` accepted on an unactivated `onDemand` session, and a saved workflow launched into it from the hub, activate it before the following turn is queued; a rejected command activates nothing |
| DWG-12 | Children: an `Agent` child spawned before activation has no workflow tools, one spawned after has them; a `workflow_child` is always activated and still loses the authoring tools through its disallow list |
| DWG-13 | Compatibility: a CLI receiving `dynamicWorkflowEnabled:true` with no mode registers eagerly; a runtime with neither field (a child, an embedder) registers eagerly; a compaction after activation leaves the ten tools registered |
| DWG-14 | Standalone CLI flag: the TUI and `-p` with no `--workflow-mode` create the app with `dynamicWorkflowEnabled:false, dynamicWorkflowToolsOnDemand:false`; `onDemand` → `true, true`; `alwaysOn` → `true, false`; every app the TUI creates (`/new`, `/resume`) carries the same pair; `--workflow-mode bogus` → exit 1 naming the three values, no app created |
| DWG-15 | Flag scope: `--workflow-mode` with `app-server`, `agent-server`, `login`, `skills` → exit 1 with the scope error; with `-p`, `--target`, `tui` or no command → accepted |
| DWG-16 | TUI under `disabled`: the `/` suggestions and `/help` have no `workflow`; `/workflow x` answers the disabled notice without calling `submitPrompt`; `/dwf list` and `/dwf cancel` work; `/dwf resume <id>` answers the notice without calling `resumeWorkflowRun`. Under `onDemand` and `alwaysOn`: `/workflow` is suggested and submitted as before |
| DWG-17 | Headless under `disabled`: `-p "/workflow x"` → the notice on stderr, exit 1, no app created; `-p "/help"` lists no `/workflow`. With `--workflow-mode alwaysOn` the command rides the plain-prompt path and the settle-wait as before |
| DWG-18 | `applyDynamicWorkflowUserMode`: offer `onDemand` + choice `alwaysOn` → mode `alwaysOn`, `offeredMode` `onDemand`, `userMode` `alwaysOn`; offer `disabled` + choice `alwaysOn` → mode `alwaysOn`, enabled, `offeredMode` `disabled`; no choice → the offer unchanged; an invalid stored value is ignored. `readDynamicWorkflowOfferedMode` returns the offered mode, `disabled` included, and nothing for a snapshot without a readable `offeredMode` |
| DWG-19 | Settings patch: `dynamicWorkflowMode: ""` deletes the stored value; a mode is stored as is; an unknown stored value does not break reading the file |
| DWG-20 | Host: with a latched offer `alwaysOn`, a stored choice `onDemand` makes the next session create carry `dynamicWorkflowMode: "onDemand"` without a new server read; a choice `disabled` makes it carry no workflow fields; with a latched offer `disabled`, or an offer read that threw, a stored choice `alwaysOn` sends the policy `enabled: true` and makes session create carry the mode; without an offer resolver the choice is ignored; `syncDynamicWorkflowUserMode` re-sends the policy to every live workspace (`enabled: false` for `disabled`) only when the effective mode changed, in call order, and resolves without waiting for any CLI to answer |
| DWG-21 | Desktop-attached remote Host: without a local settings resolver it applies the last pushed value; the desktop pushes the settings value when it builds the remote workspace services and forwards later changes to live remote connections |
| DWG-22 | UI Settings row: absent while loading, on failure, and for a snapshot with no readable `offeredMode` (an older Host), where the hub's settings button is absent too; present under an offer `disabled`, showing 关闭 with the tag; with an offer `disabled` and a choice `alwaysOn` the hub shows its settings button; shows the effective mode; the 「默认」 tag sits on the offered mode; picking the offered mode writes `""`, picking another writes that mode; the store reloads after a change |
| DWG-23 | Desktop E2E against a mock `/client/configs` sending `alwaysOn`: the row shows 始终开启 with the tag; choosing 关闭 removes the 「工作流」 title word at once and keeps it away (it does not wait for a busy CLI) and, in a new draft, the plus-menu entry; choosing 始终开启 again clears the stored value. Offer `disabled`: the row shows 关闭 with the tag; choosing 始终开启 stores it and brings back the 「工作流」 tab and, in a new draft, the plus-menu entry |

## Alternatives not taken

- **Showing the script path in the confirmation window or the tool row.** The path is the
  model's handle; the user approves the script and the timeline, which they already see, and
  both surfaces were judged full.
- **Minting a run's working copy only when it errors.** The notification pipeline would gain
  a disk write, a cold-restored notification would have to re-mint, and a run that completed
  but needs one more stage would have no file; writing at submission is one small file per
  run next to the entry file the run already writes.
- **Letting an amend edit the saved definition in place.** A one-off fix would silently
  become the definition and skip `SaveWorkflow`'s window; the draft copy keeps the two acts
  apart.
- **A temporary-directory fallback for drafts.** The entry file has one because the run
  cannot start without it; a draft exists to be found and edited in the project.
- **A separate tool for running saved workflows.** The whole gate (always-ask, the Refine
  option, the session option, the graph payload, the v3 stripping, the bot fallback) is
  keyed on the launch-tool names; a third tool would re-implement all of it, and each
  omission would be a silent hole in the confirmation. `AmendWorkflow` exists despite this
  because amending is a different act with a different card and a stop of its own; it
  shares the gate by being registered as the second launch tool, not by copying it.
- **Keeping `resume_from` on `CreateWorkflow`** beside `AmendWorkflow`. Two ways to say the
  same thing would keep the old two-step repair (`TaskStop`, then create) alive in prompts
  and transcripts, and the card could not tell a start from a revision.
- **Refusing to amend a running run** (the former `not_amendable`). It made repairing a
  visibly wrong run a stop, a poll of `GetWorkflowRun` until the journal read stopped, and
  a resubmit; the service can await the run's own settlement instead.
- **Ending a superseded predecessor as `stopped(model)`.** Its notification would tell the
  model to amend a run that was just amended, and the card would read as an ordinary stop.
- **Returning the stored script on the run snapshot** so `resolveInput` could inherit it from
  `getTask`. The snapshot is polled by the background-task tracker; the script would ride
  every poll. `getScript` reads it once, when an amend asks for it.
- **A settings tool beside `AmendWorkflow`** (an `UpdateWorkflowRun` for concurrency and
  model). A model change still means a new run that supersedes the old one, so the second tool
  would repeat the gate, the card and the stop for the same act; an optional `script` says it
  with one tool. The retune did not revive the idea: it is reached by the same call, with the
  same field, and a tool of its own would make the model choose a route the handler can decide
  from the run's own state.
- **A diff against the predecessor's script in the amend window.** The window appears only
  for another session's run, where the user has not seen the old script either; the new
  script and its timeline are what they are approving.
- **Carrying the saved script in the display payload** instead of the normalized input.
  Old clients cannot read new display fields, and hooks and rules match on the input; the
  input channel makes the window and the policy see the script on every version.
- **Enforcing "exactly one source" in the zod schema.** The normalized input carries both.
- **A persistent (project-level) "always allow" for `CreateWorkflow`.** It would close the
  gate forever; the session grant closes it for one process lifetime.
- **Waiving confirmation for every `AmendWorkflow`.** `run_id` is a string any run in the
  project satisfies, and an amended script may add tool-using subagents; the rule binds to
  runs this session started.
- **An in-memory lineage table of approved runs** (the earlier design). It was lost on
  restart and cold resume, needed seeding on two launch paths and revoking on cancel; the
  run's recorded parent session says the same thing and is already persisted.
- **Starting hub runs through a synthesized chat message** ("please run saved workflow X").
  A model turn added latency, tokens and a chance of deviation, then a second confirmation
  of a decision the user had already made in the hub.
- **Changing a running run's subagent model, or its script, in place.** The model is frozen
  into subagent sessions that already exist, and the script is the run's identity: its
  `script_hash` is what a resume checks. Moving either mid-run would give the run two
  histories, the one it was submitted with and the one it ran under. An amendment keeps one
  record per run, and the cache makes it cheap. The parallelism is the exception, and it is one
  because it costs no second history: the bound is a number the scheduler re-reads on every
  dispatch, and a retune writes both the row and a `run-caps-changed` event, so the journal
  still says what the run ran under and when that changed
  (`docs/dynamic-workflow/concurrency.md`, "Retuning a live run").
- **A Configure button that sends a message to the model** ("lower the concurrency to 4"). It
  costs a model turn, and the model may re-send the whole script; the GUI can call the amendment
  itself, as the hub's Run button starts a launch itself.
- **Emitting the settings turn inside a busy turn.** A user message between an assistant's tool
  call and its result breaks the provider's grammar; the runtime command queue already holds work
  until the turn ends.
- **Starting hub runs in an existing session.** Queuing a launch behind an active turn
  needs admission semantics the control-only turn does not have; every launch gets a fresh
  session.
- **Per-workflow typed `args`.** Generating a `.d.ts` per file would make the compile
  surface vary by file; one facade compiles every workflow.
- **A `DeleteWorkflow` model tool.** A saved workflow is a file in the repository; git and
  the hub delete it.
- **Injecting the saved-workflow list into the system prompt.** Twenty saved workflows must
  not make every turn more expensive; `ListSavedWorkflows` is on demand.
- **Storing metadata as `export const meta`** or a `---` fence: the facade forbids
  `export`, and a fence makes the first line a syntax error.
- **Moving a project workflow to global as a file move.** Project workflows reference their
  repository; the promotion is the model's generalization.
- **A `/dwf status` command.** `GetWorkflowRun` is the model's tool; the user asks the model.
- **A `--wait` flag or timeout for headless runs.** Cancel and Ctrl-C are the controls.
- **Shipping a separate `node` binary in single-executable builds** (+50 MB per platform);
  the CLI re-executes itself instead.

## Open questions

- Configuring a run that had already stopped leaves it resumable beside the new run, so a user
  can end up with two runs of the same lineage. Marking a settled predecessor superseded would
  change the engine's amend contract for the tool as well; it is left as is.
- A run the model launched under its own `name` attaches to no saved workflow in the hub;
  the journal has no separate saved-name column.
- The global group fetches the newest 50 runs across all names and projects and filters by
  name in the client, so a busy machine can starve one global workflow's history.
- The `SaveWorkflow` confirmation block shows the target path but no explicit scope or
  shadowing line; both appear only on the tool-call card afterwards.
- The `openWorkflow` deep link into a detail page is accepted by the hub but nothing in the
  shell sends it.
- The launch metadata carries the script, but no surface reads it yet; the run pane reads
  only the graph. The settings turn does not carry it.
- An `AmendWorkflow` call carries no `args`, so amending a run started from a saved workflow
  with arguments gives the revision an empty `args`. An amend that keeps the script makes this
  likelier: the inherited script still reads the arguments it was written for. The settings
  change from the GUI passes `inheritArgs` and keeps them; the tool could do the same when it
  keeps the script.
- The delete confirmation says 「会从项目里删除 {path}」 for global workflows too.
- The TUI still offers "Always allow in this project" on `SaveWorkflow` asks; the rule it
  would write is inert against the always-ask gate.
- No host writes `disabledReason` on a catalog entry, so the resolver's disabled branch and
  the `[disabled: …]` marker describe a state nothing produces yet.
