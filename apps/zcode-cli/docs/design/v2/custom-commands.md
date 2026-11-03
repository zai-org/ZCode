# Custom Commands

## Goal

ZCode should support user-defined slash commands as reusable prompt templates.
The first version follows Claude Code's legacy `.claude/commands/*.md` format
closely enough for common commands to migrate, while keeping ZCode's stronger
runtime boundaries: discovery and file I/O live in adapters, execution is owned
by command center, permissions stay scoped to a single invocation, and TUI/ZCode app-server
only render command surfaces.

This feature is for NL -> Code workflows such as `/review`, `/fix-issue 123`,
`/commit`, or `/test auth`. A custom command is not a new local CLI command and
does not run arbitrary UI code.

## Compatible Command File Format

The compatible Claude Code command format stores prompt commands as markdown files:

- Project commands: `.claude/commands/**/*.md`
- User commands: `~/.claude/commands/**/*.md`
- File basename becomes the slash command name.
- Subdirectories provide namespace-like grouping in the loaded command surface.
- Optional YAML frontmatter can define `description`, `argument-hint`,
  `allowed-tools`, and `model`.
- Markdown body becomes the prompt template.
- Common dynamic syntax includes `$ARGUMENTS`, `$1`, `$2`, `@file`, and
  shell injection blocks such as ``!`git status` ``.

ZCode should be compatible with the stable file shape and common frontmatter,
but dynamic file/shell expansion must go through ZCode adapters and permission
contracts instead of being performed by ad hoc string replacement.

## User Contract

- A user can create `.zcode/commands/review.md` and invoke it as `/review`.
- A user can create `.claude/commands/review.md` and invoke it as `/review`
  when Claude compatibility is enabled.
- A user can create `.agents/commands/review.md` and invoke it as `/review`
  when `.agents` compatibility is enabled.
- `/help` and TUI slash suggestions list custom commands with their
  description, source, and argument hint.
- `zcode commands list` lists discoverable custom commands without starting a
  model turn.
- Headless `zcode --prompt "/review"` and ZCode app-server prompt commands can invoke custom
  commands that do not require terminal-only interaction.
- Built-in commands always win over custom commands with the same name. A
  custom `/help`, `/model`, `/skill`, etc. is ignored and reported as a
  diagnostic rather than shadowing local control commands.

## File Format

P0 supports markdown prompt commands:

```markdown
---
description: Review current changes
argument-hint: [scope]
allowed-tools: Read, Grep, Bash(git diff *)
model: main
---

Review the current diff for correctness, tests, and maintainability.

Scope: $ARGUMENTS
```

Frontmatter fields:

- `description`: optional string. If missing, use the first non-empty markdown
  line as a fallback, capped for display. Empty commands are invalid.
- `argument-hint`: optional string shown by TUI after completing `/command `.
- `allowed-tools`: optional comma or array list using ZCode permission rule
  syntax. It can grant only invocation-scoped allowances and never overrides
  global deny rules.
- `model`: optional `main`, `lite`, or configured `provider/model` one-turn
  override. Unknown model refs fail before starting a model turn.
- `disable-noninteractive`: optional boolean. When true, omit the command from
  ZCode app-server and headless command lists.

Reserved P1/P2 fields:

- `arguments`: named argument metadata.
- `when_to_use`: model-facing command discovery text.
- `context: inline | fork`: future subagent execution mode.
- `effort`: one-turn reasoning effort override.
- `shell`: shell profile for dynamic shell expansion.

Plugin compatibility adds one P0-compatible field:

- `skills`: optional comma or array list of skill names that should be loaded
  before running this prompt command. The command expander renders an explicit
  instruction to call the `Skill` tool for those names; it does not load the
  skill body directly.

Unknown frontmatter keys produce warnings and do not fail the command.

## Naming

Allowed command names use `^[a-z0-9][a-z0-9:-]{0,63}$` after normalization.
Spaces, path separators, leading dots, and uppercase-only distinctions are not
valid. Names are case-insensitive at invocation time.

For subdirectories, ZCode uses a stable colon namespace:

```text
.zcode/commands/review.md          -> /review
.zcode/commands/frontend/review.md -> /frontend:review
```

This avoids collisions and matches the command-center model better than showing
two different files as the same `/review`.

## Discovery Roots

Discovery is adapter-owned and receives `workingDirectory`, config, trace, and
abort signal. Core and TUI must not scan the filesystem directly.

Default roots, in priority order:

1. `commands.roots[]` from config, nearest entry first.
2. Project native roots from cwd up to worktree root:
   `.zcode/commands/**/*.md`.
3. Project `.agents` compatibility roots:
   `.agents/commands/**/*.md`.
4. Project Claude compatibility roots:
   `.claude/commands/**/*.md`.
5. User native root: `~/.zcode/commands/**/*.md`.
6. User `.agents` compatibility root: `~/.agents/commands/**/*.md`.
7. User Claude compatibility root: `~/.claude/commands/**/*.md`.

Config shape:

```ts
commands: {
  enabled: boolean;
  roots: string[];
  metadataBudget: number;
  maxCommandBytes: number;
  compatibility: {
    agents: boolean;
    claude: boolean;
  };
}
```

Plugin command roots are specified by [`plugin-compat.md`](plugin-compat.md).
They are projected as `source: "plugin"` roots and otherwise use this same
markdown command format.

No `ZCODE_*` environment variable is introduced for this feature. If a future
environment override is needed, it must be specified separately with precedence,
error behavior, and tests.

## Contracts

Add a command contract package beside skill contracts:

```ts
type CustomCommandScope = "project" | "user" | "system" | "admin";
type CustomCommandSource = "zcode" | "agents" | "claude" | "plugin";

interface CustomCommandMetadata {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
  rootPath: string;
  scope: CustomCommandScope;
  source: CustomCommandSource;
  allowedTools: string[];
  model?: string;
  disableNonInteractive: boolean;
  frontmatterKeys: string[];
}

interface CustomCommandPort {
  discoverCommands(request, options): Promise<CustomCommandLoadOutcome>;
  loadCommand(request, options): Promise<CustomCommandContent>;
}
```

The adapter returns structured diagnostics for scan failures, invalid names,
duplicate names, invalid frontmatter, and oversized files. Diagnostics are
surfaced by `zcode commands list --verbose`, `doctor` verbose output, and debug
logs.

## Invocation Flow

1. TUI, headless CLI, or ZCode app-server submits `/name args`.
2. Command center parses built-ins first.
3. If no built-in matches, command center asks the custom command registry for
   a command named `name`.
4. Command center loads the markdown body through `CustomCommandPort`.
5. Command center expands safe placeholders and builds a synthetic prompt.
6. Permission service evaluates any invocation-scoped `allowed-tools` and
   model override.
7. The app submits the expanded prompt to the normal runtime with trace,
   abort, event forwarding, and session persistence intact.

The visible transcript should show the user invocation (`/review auth`) and a
small command-loaded marker. The full markdown body is stored as hidden
model-visible command context, not re-rendered as user chat text.

## Prompt Expansion

P0 expansion:

- Strip YAML frontmatter.
- Replace `$ARGUMENTS` with the raw argument tail.
- Replace `$1`, `$2`, ... with parsed positional arguments.
- Parse positional arguments with a small cross-platform parser that supports
  whitespace separation and quotes. Do not delegate argument parsing to a shell.
- If the template does not reference `$ARGUMENTS` or positional placeholders
  and the user supplied args, append:

```text
User arguments:
<args>
```

Dynamic expansion:

- `@file` references are P1. They should resolve through the file-system
  adapter, respect workspace/path permissions, and produce attachment-style
  model context rather than raw string concatenation.
- ``!`command` `` and fenced `!` shell blocks never run while a command is
  resolved, whatever its source (project, user, or plugin). Resolution stays a
  pure text step: each block is rewritten into a hand-off note followed by a
  fenced `bash` block. The note says the step comes from the `/name` command
  file and its `scope/source`, not from ZCode, and asks the model to run that
  exact command with the `Bash` tool and use its output, unless it looks unsafe
  or unrelated to the user's request. The command then runs only as an ordinary
  `Bash` tool call, so plan mode, guarded checks, permission rules, hooks, and
  approval prompts all apply, and the user sees it as a tool call.
- An inline block is recognized only at the start of a line or after
  whitespace, so text such as `` `Warning!` `` followed by another code span
  stays plain text. A fenced block starts with ```` ```! ````.
- Each rewritten block ends with a line break, so text that followed an inline
  block continues on a new line after the closing fence.
- The rewrite runs on the command template before `$ARGUMENTS` / `$N`
  substitution, so argument text is never treated as a shell block.
- Session context variables stay as written in the block. Every `Bash` call
  sets them as environment variables (see [tool/04-bash.md](tool/04-bash.md)),
  so the shell expands them, including forms such as `${NAME:-default}`, and
  scripts started by the block can read them too:
  - `CLAUDE_PROJECT_DIR`, `ZCODE_PROJECT_DIR`: the session workspace root.
  - `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `ZCODE_SESSION_ID`: the
    session ID.
- Plugin variables are replaced with their values in the block text, in both
  the `${NAME}` and `$NAME` forms, because the `Bash` call does not know which
  plugin the step came from. This applies to plugin commands only:
  `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`,
  `ZCODE_PLUGIN_DATA`, `ZCODE_PLUGIN_ID`, `ZCODE_PLUGIN_NAME`. The values come
  from the installed plugin (validated manifest name, user-level install or
  config paths), never from the workspace.
- A Windows path value (starting with a drive letter such as `C:\` or with
  `\\`) is written with forward slashes. The text is parsed by the shell, and
  Git Bash removes backslashes outside quotes, so an unquoted
  `bash ${CLAUDE_PLUGIN_ROOT}/x.sh` would otherwise get a broken path. Git Bash
  accepts `C:/...` with or without quotes.
- The block is not handed off when it uses a plugin variable outside a plugin
  command, a plugin variable with a shell modifier (for example
  `${CLAUDE_PLUGIN_ROOT:-x}` or `${#CLAUDE_PLUGIN_ROOT}`), or `CLAUDE_SKILL_DIR` / `ZCODE_SKILL_DIR`
  (commands have no skill directory). It becomes a note that names the
  variable, so the shell never expands it to an empty string.
- Shell blocks never make resolution fail. Invoking such a command behaves like
  any other prompt for send-now, queue, edit, and retry.
- Known limits: the model's `Bash` call runs in the session's current
  directory, which can differ from the workspace root after an earlier `cd`;
  scripts do not get plugin variables from their environment; a plugin path
  that contains `$` or a backtick is expanded again by the shell, and an
  unquoted path with spaces is split; headless `-p`
  runs have no approval surface, so non-read-only blocks are denied unless the
  mode or allow rules permit them.

## Permissions

`allowed-tools` is not a way for a repository file to bypass user policy.

- Global disallowed tools always win.
- Invocation-scoped allowed tools expire after the command turn.
- Built-in and user-scope commands may apply `allowed-tools` directly when the
  permission service accepts the rule syntax.
- Project-scope commands with `allowed-tools` require trust/approval before the
  scoped allowlist is applied. In non-interactive mode, lack of approval is a
  command error rather than silent fallback.
- Invalid `allowed-tools` entries are diagnostics and are not applied.
- The command body itself never directly calls tools; it only influences the
  next model turn.

This keeps the convenience of the compatible command format while preserving
ZCode's audit and permission broker model.

## UI And ZCode app-server

TUI:

- Suggestions merge built-ins and custom commands.
- Built-ins sort before custom commands; custom commands sort by name.
- Rows show `/name`, `argument-hint`, short description, and a source suffix
  such as `project/zcode` or `user/claude`.
- Tab completion inserts `/name ` for custom commands.
- If discovery fails, suggestions still show built-ins and `/commands` can show
  diagnostics.

ZCode app-server:
- ZCode app-server advertises custom prompt commands through `available_commands_update`.
- ZCode app-server excludes commands with `disable-noninteractive: true`.
- ZCode app-server `/help` includes only ZCode app-server-advertised built-ins and compatible custom
  commands.
- ZCode app-server does not expose local-only management commands such as `/model`,
  `/resume`, or `/mcp` through custom command discovery.
- In stdio/app protocol mode, the agent is the single source of truth for the
  slash command list. The protocol list contains only app-supported built-ins
  (`/goal`, `/workflow`, `/compact`, `/init` and the app-only `/plan`) plus
  discovered compatible custom prompt commands.
  UI clients must not rebuild this list from app-side command services.
- Protocol slash command rows carry `source: "builtin" | "custom"` so clients
  can keep hiding unsupported built-ins while still showing user-defined
  commands returned by the agent. Older rows without `source` are treated as
  built-in rows for compatibility.
- Built-in command names and aliases are reserved in stdio/app protocol mode.
  A custom command with the same name as an internal built-in is not advertised,
  avoiding a UI row that would later be parsed as a different built-in action.
  Built-in prompt commands (`/init`, `/workflow`) are expanded by
  `bootstrap/src/builtin-prompt-command.ts` before custom-command lookup runs;
  the custom resolver returns "not found" for every reserved name, so a custom
  `workflow.md` can neither shadow the built-in nor bypass a feature gate on it.

CLI:

- `zcode commands list`: human list of custom commands.
- `zcode commands list --json`: structured metadata and diagnostics.
- `zcode commands inspect <name>`: show resolved metadata and file path; body is
  shown only with `--verbose`.

## Observability

Each invocation emits structured runtime/session events:

- `custom_command_discovered` for debug-only discovery summaries.
- `custom_command_invoked` with command name, source, scope, path hash, and
  whether scoped permissions/model override were requested.
- `custom_command_expanded` with body byte count, argument count, dynamic
  expansion count, and redacted diagnostics.

Logs must not include full command body, full arguments for sensitive commands,
API keys, or shell output beyond existing adapter truncation rules.

## Tests

Minimum test coverage:

- Adapter discovers `.zcode/commands`, `.agents/commands`, and
  `.claude/commands` with deterministic priority.
- Duplicate command names keep the higher-priority command and produce a
  diagnostic.
- Built-ins cannot be shadowed by custom commands.
- Frontmatter parses `description`, `argument-hint`, `allowed-tools`, `model`,
  and `disable-noninteractive`.
- `$ARGUMENTS` and `$1`/`$2` expansion work with quoted args on Windows, macOS,
  and Linux.
- `!` shell blocks are rewritten into `Bash` hand-off notes that name their
  source and resolve plugin variables (Windows paths with forward slashes),
  and are never executed during resolution; argument text is not rewritten.
- `allowed-tools` is scoped to one command invocation and respects deny rules.
- TUI suggestions include custom commands and argument hints.
- `zcode --prompt "/custom args"` expands and submits a normal runtime turn.
- ZCode app-server advertises only noninteractive-compatible custom commands.
- Command diagnostics are available in `zcode commands list --json`.

## Implementation Phases

P0:

- Add contracts, config shape, and Node adapter discovery/loading.
- Add `zcode commands list` and `inspect`.
- Add command-center lookup, prompt expansion, TUI suggestions, and headless
  invocation.
- Add ZCode app-server advertisement for compatible custom prompt commands.
- Support static markdown, frontmatter, `$ARGUMENTS`, positional args, scoped
  `allowed-tools`, and one-turn `model`.

P1:

- Implement `@file` references through the file-system adapter.
- Add command reload/invalidation when TUI stays open across file changes.

P2:

- Add plugin-provided commands with namespace isolation.
- Add forked/subagent command execution.
- Add command usage telemetry and diagnostics UI in debug tools.
- Consider unifying prompt commands and skills in a shared metadata index while
  keeping `/skill` autonomous loading separate from user-invoked `/command`.
