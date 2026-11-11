# Ink TUI Renderer

## Goal

The interactive TUI should use Ink for terminal layout, borders, clipping, and
input rendering instead of hand assembling fixed-width strings. The immediate
user-visible fix is that the prompt box remains a stable box when the user types
CJK text, emoji, or styled content.

## Scope

- Replace the handwritten frame painter in `@zcode/tui` with an Ink component
  tree.
- Keep `runTui()` as the public CLI entrypoint.
- Keep session, permission, live event, token usage, todo, cancellation, and
  scrollback behavior owned by the TUI controller, not by React component-local
  state.
- Split the old monolithic TUI implementation into focused modules for state,
  controller logic, event projection, text formatting, and components.

## Non-Goals

- Do not move session state into the TUI layer.
- Do not introduce new `ZCODE_` environment variables.
- Do not change the runtime event contract or permission broker schema.
- Do not replace the CLI packaging path.

## Rendering Contract

The renderer owns presentation only. Its input is a `TuiScreen` projection and a
small controller interface for user actions. It must not call model providers,
read session storage, or perform filesystem/network/subprocess I/O.

The transcript starts empty. Runtime readiness or startup sentinel messages are
diagnostics, not user-visible system messages; leaking them into the transcript
causes confusing rows such as `System: OpenTUI Node runtime loaded.` before the
user has done anything.

Sidebar API request rows preserve raw request data in session events, but their
visible labels should compact opaque UUID-like provider/request identifiers to
`first8...last4` so long model request IDs do not dominate the URL and status.

Ink `Box` components own terminal borders and sizing. The prompt surface uses a
bounded multiline input area:

1. The outer prompt is a bordered Ink `Box`.
2. The editable field uses the OpenTUI textarea renderable with word wrapping.
3. `Enter` submits the prompt; `Shift+Enter` inserts an explicit newline.
4. Long input wraps inside the field, grows up to the configured maximum height,
   then scrolls internally instead of writing over the border.

The renderer may rely on Ink's internal `string-width`, `slice-ansi`, Yoga
layout, and `ink-text-input` behavior for display-cell measurement. Any local
string truncation helper used outside Ink must operate on terminal display width,
not JavaScript code unit length.

### Streaming Transcript Performance

Streaming model output can append many small text deltas. The TUI must avoid
turning every delta into a full transcript reflow:

- Message wrapping is cached per message object, width, and color mode. A cache
  entry is valid only while the message role and content are unchanged.
- Viewport measurement and viewport content must share the same wrapped line
  calculation for a render pass. A render must not measure the transcript and
  then independently wrap it again for display.
- The Ink component tree should contain only the visible transcript rows plus
  fixed-height spacer boxes that preserve scrollbar geometry. Off-screen
  transcript rows must not become individual `Text` nodes during steady-state
  streaming renders.

These rules keep the renderer presentation-only while making long-running
sessions viable when the transcript becomes large.

## State And Interfaces

`runTui()` creates a mutable `TuiScreen` projection for the current interactive
session. Controller functions are the only code allowed to mutate it. After each
mutation, the controller asks the renderer to commit a new Ink render.

The controller interface exposes user intents rather than raw rendering details:

- `setInput(value)`
- `submitInput(value)`
- `handleKey(input, key)`
- `requestPermission(request, options)`（挂载时经 `registerPermissionRequester` 登记一次，不随提交传递）
- `stop(code)`

Permission and clarification prompts stay promise-based at the runtime boundary,
but their visible state is stored in the same `TuiScreen.approvalQueue`
projection. Closing the TUI rejects unresolved prompts.

## Cross-Platform Behavior

The renderer must not depend on POSIX shell behavior or platform-specific path
formats. Terminal differences are handled through Ink and Node stream
capability checks:

- Non-TTY stdin/stdout still return the existing script-friendly error.
- Raw mode is restored on exit.
- Resize updates re-render the Ink tree.
- Ctrl+C exits the fullscreen TUI only after the user presses it twice in the
  confirmation window. The first press shows `Press Ctrl-C again to exit.`, and
  the confirmed second press aborts active work before closing the UI.
- The startup screen owns Ctrl+C only while initialization is pending. Before
  mounting the ready app, unmount the startup tree and release its keyboard
  listener. After handoff, only the app handles the two-press exit sequence.
- Escape never exits the fullscreen TUI. It pauses active output by cancelling
  the active turn when one is running, keeps approval/selection local cancel
  semantics, and is otherwise a no-op status hint.

## Failure Behavior

If a turn fails, the controller formats the error chain into an agent message and
lets the renderer display it. The renderer should not catch or swallow
application errors because it does not own recovery.

If Ink rendering throws during startup, `runTui()` must restore raw mode and
leave the alternate screen before returning or rethrowing at the CLI boundary.

## Tests

The TUI test suite should cover:

- Existing prompt submission, cancellation, approval, live event, todo, usage,
  and scrollback behavior.
- The input box remaining bounded when typing CJK text.
- The module split preserving the public `runTui()` API.
- Terminal cleanup restoring raw mode and pausing stdin.
- Ctrl+C first-press confirmation and second-press exit behavior.
- Transcript layout caching, shared measurement/content calculation, and visible
  row rendering for long scrollback.
