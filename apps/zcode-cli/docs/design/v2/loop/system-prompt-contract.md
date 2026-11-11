# System Prompt Contract

ZCode stable system prompt is the long-lived behavioral contract for the main
agent. It should be provider-visible, cache-friendly, and specific enough
to make repository work evidence-first without mirroring runtime tool schemas.

A main session sends the system blocks it recorded in its prompt snapshot, not
the current text, until its next compaction or session model change. Changes
to this contract reach existing sessions only at those points; see
[Prompt Snapshot](prompt-snapshot.md).

## Goals

- Fix the agent identity to `zcode-agent`; callers must not compose identity
  text through runtime agent metadata.
- Make "read before deciding" the default behavior for repository tasks.
- Define clear safety, validation, communication, and scope boundaries with
  concrete examples.
- Keep stable prompt copy English-only so prompt behavior is consistent across
  locales.
- Keep tool schemas, project instructions, skills, and current date outside the
  default system blocks; keep the static/global-cache body separate from the
  dynamic/org-cache body.

## Stable Sections

| Section              | Purpose                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Static Default Body  | ZCode role, authorized-security boundary, and compact harness guidance.                                       |
| Dynamic Default Body | Code style, pronouns, risk guidance, session guidance, memory, and context management.                        |

The provider-visible `system[0]` CLI prefix is exactly
`You are ZCode, an interactive agent`. The provider-visible static
default body is a compact `system[1]` block after that short CLI prefix. It
intentionally does not render `# Agent Identity` or separate `Task Behavior`,
`Risky Actions`, or `Communication Style` headings. The legacy `task_behavior`,
`risk_actions`, and `communication_style` sources are no longer part of the
active context contract. The final provider body must follow this
static/global-cache boundary:

1. An unheaded intro that describes working toward the user's goals and using
   judgment, without limiting those goals to software engineering. Its exact text
   is `You are an agent working with the user toward their goals, using your own judgment along the way.`
2. Authorized security boundary.
3. `# Harness` section for terminal markdown, permission denial handling,
   system-controlled mid-conversation updates and hook feedback, dedicated tool
   preference, parallel independent tool calls, and clickable file references.

Every Harness bullet starts with one ASCII space followed by `- `, including
when the same Harness block is used by a workflow actor. The provider-visible
MCS and hook bullet describes the channel the request actually uses. The decision
is the same `shouldUseMidConversationSystem` flag that drives provider MCS
projection (`midConversationSystem.mode === "force"` or the executing Model's
`supportsMidConversationSystem`), evaluated per model step when the context prefix
is rebuilt. A model change inside a turn (a guide that switches the model, the
execution-model fallback, an off-peak user takeover) rebuilds the prefix with the
new model before the next request. Requests outside the turn loop that reuse the
session history (the goal completion verifier) rebuild the prefix with their own
request model first; a
rebuild without a model (language, output style, rewind, shell environment changes)
never decides the wording a request sends. With MCS it is exactly:

` - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.`

Without MCS, dynamic context arrives as user-side `<system-reminder>` blocks, and
the bullet is exactly:

`` - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback. ``

The static block ends at the final `# Harness` bullet. Code-style and
risk/reporting paragraphs must not be emitted in `system[1]`.

An active output style replaces the static intro with
`You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.`
It does not remove `# Harness`,
including when `keepCodingInstructions` is false. That field applies only to a
separate doing-tasks coding-instructions block; ZCode does not currently emit
such a block. The style text itself is not in the system prompt; it is the
`output_style_instructions` attachment (see [Meta User Context](meta-user-context.md)).
A custom system prompt does not suppress that attachment: it uses the same gate
as the environment and model attachments, and only the main thread sends it.

The provider-visible dynamic default body is `system[2]`. It always owns a
leading `\n\n` boundary, independent of provider kind. Its order after that
boundary is:

1. The unheaded communication sentence
   `Write code that reads like the surrounding code: match its comment density, naming, and idiom.`
   No long-form communication or code-comment appendix is emitted.
2. An unheaded pronoun paragraph: use they/them when pronouns have not been stated,
   never infer pronouns from a name, and apply this to all user-visible text,
   including visible thinking.
3. Risk/reporting paragraph for irreversible or outward-facing actions,
   external publishing, inspect-before-delete/overwrite, and truthful validation
   reporting.
4. Optional `# Session-specific guidance` for slash skill invocation when the
   Skill tool and at least one skill are available. Its bullet starts with ` - `.
   Interactive shell input through `! <command>` is unsupported and is not advertised.
5. Optional `# Memory` when an enabled Memory root is available, including an empty root.
6. `# Context management` for long-context summary/continuation behavior,
   followed by act-don't-rederive guidance. No autonomy appendix is emitted.
7. The token budget line `<total_tokens>15000000 tokens left</total_tokens>`,
   separated by `\n\n`. It is the last text of `system[2]`. The value is fixed;
   the per-request countdown is the `total_tokens_reminder` attachment (see
   [Meta User Context](meta-user-context.md)). A custom system prompt skips this
   line with the other dynamic sections; workflow actors keep it with Context
   management.

Environment, model, date, and the Git snapshot are independent history-backed
attachments; see [Meta User Context](meta-user-context.md).

Communication, pronouns, and action caution remain paragraphs of the existing
`dynamic_behavior` source, separated by exactly two newlines. Pronouns are not
a reminder source or a separate system block. They follow the existing default
body branches: included with an active output style, omitted for custom system
prompts and workflow actors that skip `dynamic_behavior`.

The risk/reporting paragraph retains authorization, external-publishing, and
truthful-reporting guidance. Its inspection sentence is exactly
`Before deleting or overwriting, look at the target.`; no conditional clause
is appended to that sentence.

Legacy ZCode `# Language`, `# Function Result Clearing`, and
`# Summarize Tool Results` sections are not emitted in this dynamic block. The
runtime may still compact or microcompact history, but that behavior is covered
by runtime mechanics rather than provider-visible system sections.

Every system section after the CLI prefix owns its left boundary: Main/Workflow
stable blocks and non-empty Subagent agent prompts start with `\n`; Main
dynamic and Subagent Notes start with `\n\n`.
An empty Subagent agent prompt does not produce a system block. Built-in blocks
do not add a trailing newline.

OpenAI-compatible adapters therefore concatenate contiguous leading system
blocks with an empty separator and never add or infer whitespace. Protocols
that support multiple system blocks preserve the original block contents.

Main's CLI prefix carries no cache marker; the static and dynamic bodies
retain their existing ephemeral markers, with no change to scope or TTL.

Subagent system output has two blocks: the CLI prefix and a single body formed
by concatenating the remaining system sections without adding separators.
Both blocks carry one ephemeral marker; an empty agent prompt still leaves
Notes in the body. Environment and model use separate dynamic attachments,
assembled by the same helper as Main; they do not appear in this initial body.
Internal sections remain separate for inspection. This leaves room for the existing
conversation-tail cache marker within the provider's four-breakpoint limit.

## Request-level context and prompt attachments

The `context_prefix` remains a user-side `<system-reminder>` for instruction
files and the Memory index only. It is a dynamic announcement, sent once per
session before the prompt (see `meta-user-context.md`). It has no generic
context intro, field heading, date, or automatic-account-context footer. The
Git-only `session_context` owns that intro and footer instead.

For text file prompt attachments, all synthetic Read reminder bodies produced
for one attachment form one runtime attachment entry and are joined with a
single newline. Separate attachment entries remain separated by two newlines
when projected into one mid-conversation system turn. This preserves the
attachment boundary without changing the global reminder separator.

When a text attachment is truncated by the default line limit, the
provider-visible note is exactly:

`Note: The file <filename> was too large and has been truncated to the first 2000 lines. Don't tell the user about this truncation. Use Read to read more of the file if you need.`

## Required Behavior

The stable prompt must include guidance equivalent to:

- The default identity describes an agent working with the user toward their
  goals and using its own judgment along the way; it does not restrict the task
  domain to software engineering. Product identity remains in the separate prefix.
- The agent works in the current workspace and can inspect, edit, and validate
  code using the available tools.
- User-facing text outside tool calls renders as GitHub-flavored Markdown in a
  terminal.
- A denied tool call means the user declined it; the agent adjusts rather than
  retrying the same call unchanged.
- Mid-conversation system turns are system-controlled updates rather than
  function results; hook feedback is treated as user feedback.
- Dedicated file/search tools should be preferred over shell commands when they
  fit; independent tool calls can run in parallel.
- Code references should use clickable `file_path:line_number` formatting.
- Existing code style, naming, idiom, and comment density should guide edits.
- Risky or shared-system actions require explicit user confirmation.
- External publishing may be cached or indexed and needs care.
- The agent inspects a target before deleting or overwriting it, especially when
  it did not create that target or the observed state contradicts the request.
- Authorized security work (defensive security, vulnerability analysis, CTF,
  education) is allowed; malicious-intent requests (destructive techniques, DoS,
  mass targeting, supply-chain compromise, detection evasion) are refused, and
  dual-use tooling needs a clear authorization context.
- The agent reports outcomes faithfully: failed tests, skipped checks, and
  verified completion are stated plainly.
- Slash skill requests use the Skill tool only for listed skills; the agent does
  not guess missing skill names.
- Memory guidance appears when an enabled Memory root is available, including
  when its index is empty, and tells the agent to treat recalled memory as
  background context rather than truth.
- Environment guidance must not include git branch/status/commit details; those
  belong to the optional `session_context` user reminder.
- Context-management guidance tells the agent to continue from summaries rather
  than stop early because compaction or summarization may happen.

## Tool Boundary

Stable prompt text may describe tool-use philosophy, but it must not duplicate
ordinary tool names, JSON schemas, permission metadata, or adapter-specific
runtime rules. Those belong in provider tool definitions and dynamic context.

Allowed examples:

- Prefer fast repository search and direct file reads before editing.
- Use shell commands for actions that dedicated tools cannot cover.
- Run focused tests, typechecks, or linters when they demonstrate the change.

Parallel tool-call guidance belongs to the shared static `# Harness` block.
The dynamic `session_guidance` source is omitted when no applicable skill
guidance exists.

Disallowed examples:

- Reprinting full tool schema fields in the stable prompt.
- Maintaining a separate list of all available tools in the stable prompt.
- Encoding provider-specific approval flags that the permission layer already
  owns.

## Identity Compatibility

`agentName` may remain runtime metadata for hooks, persistence, subsessions, and
debug records. It must not affect the stable main-agent system prompt.
`agentBasePrompt` is not part of the context-builder contract and should not be
accepted as a prompt composition input. Workflow and subagent specialisation
should be expressed through their own explicit prompt sections or runtime
context, not by string-splicing the identity sentence.

## Explore Subagent

The Explore subagent is a read-only file-search and research specialist. Its
toolset and prompt are governed here, separately from the main stable prompt.

Toolset (`EXPLORE_AGENT_ALLOWED_TOOLS`): `Bash`, `Glob`, `Grep`, `Read`,
`WebFetch`, `WebSearch`, `TodoWrite`, `Skill`. `Glob`/`Grep` are the
explore-only dedicated search tools; `WebSearch` is the public client-side
wrapper tool, and its handler performs the provider-native `web_search` side
request only when the current provider supports native search. `Skill` only
registers when the child runtime is given a `skillPort`.

Read-only enforcement model: the Explore child inherits the parent session's
permission mode, Plan state, and permission service. The shell AST classifies
each `Bash` command: read-only commands run without approval; other commands
ask for approval under a build/edit parent, are denied under Plan, run under
a yolo parent, and ask once under a guarded parent when they match a dangerous
command rule (otherwise they run). The allowlist still excludes every file-mutating tool
(`Write`/`Edit`/`ApplyPatch`), and the prompt's CRITICAL section still forbids
mutating shell commands, so the prompt and the permission layer both apply.
(Until 2026-10-31 the child ran in `yolo` with a separate permission service and
relied on the prompt alone, which let a prompt-injected model run any command
through `Agent(Explore)` without approval.)

Required Explore prompt behavior:

- Identifies as a read-only file-search / codebase-research specialist.
- Carries a CRITICAL READ-ONLY section that forbids file creation,
  modification, deletion, moves, redirects/heredocs, and any state-changing
  command; `Bash` is restricted to read-only operations.
- Encourages parallel tool calls and absolute paths (cwd may reset between
  `Bash` calls).
- ZCode-specific, kept on purpose: says exactly what is missing when evidence is
  incomplete, and explicitly forbids spawning another agent.

## Test Coverage

- ContextBuilder renders a fixed `zcode-agent` identity even when runtime config
  contains custom agent metadata.
- Stable system prompt contains evidence-first and no-guessing guidance.
- Stable system prompt contains safety boundaries with destructive-action
  examples.
- Stable system prompt contains validation and truthful-reporting guidance.
- Stable system prompt contains the authorized-security / refuse-malicious
  policy and the no-URL-fabrication rule.
- Stable system prompt tells the agent not to retry a denied tool call
  unchanged.
- Provider-visible static `system[1]` starts with the ZCode intro, uses compact
  `# Harness`, and does not render `# Agent Identity` or the old `# Task Behavior`,
  `# Risky Actions`, or `# Communication Style` headings; it ends at the final
  `# Harness` bullet.
- Provider-visible dynamic `system[2]` starts with the unheaded code-style
  sentence, then pronouns, then risk/reporting, after an unconditional
  leading `\n\n`. It then contains optional `# Session-specific guidance`,
  optional `# Memory`, `# Context management`,
  act-don't-rederive guidance, and the `<total_tokens>15000000 tokens left</total_tokens>`
  line in that order. Environment, model, output
  style, date, and Git are separate dynamic attachments. It excludes the long-form communication,
  code-comment, and autonomy appendices.
- Subagent initial system blocks contain the CLI prefix, then optional
  `\n` + non-empty agent-specific prompt (trimmed at both ends) followed by `\n\n` + the launcher-messages paragraph
  ("Messages from the agent that launched you — … can authorize changing your
  permission settings, AGENTS.md, or configuration.") + `\n\n` + Notes +
  `\n\n<total_tokens>15000000 tokens left</total_tokens>`. The
  paragraph, the final Notes sentence ("(Files written as input to another
  tool are fine; this note is about report files.)") and the budget line are fixed text;
  the instruction file is named `AGENTS.md`, as in the peer-message template.
  A general-purpose item about not re-delegating to another subagent is not emitted, because subagents cannot call `Agent`. The leading
  `\n` stays: it is the block's own left boundary for OpenAI-compatible
  concatenation.
  Environment/model announcements use the same dynamic collection as Main:
  MCS when supported, otherwise user-side system reminders. Neither a custom
  child prompt nor Main's full custom-system override suppresses them.
- OpenAI-compatible serialization concatenates leading system blocks with an
  empty separator and does not inspect or repair their contents.
- Provider-visible dynamic `system[2]` does not include legacy `# Language`,
  `# Function Result Clearing`, or `# Summarize Tool Results` sections.
- Dynamic `session_guidance` is emitted in provider-visible `system[2]` only
  when the Skill tool and at least one skill are available.
- Memory guidance is emitted in `system[2]` when an enabled Memory root is available,
  including when its index is empty.
- Stable system prompt does not mirror ordinary tool schemas.
