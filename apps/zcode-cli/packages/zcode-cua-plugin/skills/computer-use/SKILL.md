---
name: computer-use
description: "Use when a task needs a native desktop app's own UI or the OS. For anything inside a web page, use Browser Use. Main agent only."
---

# Computer Use

Read or operate the UI of native apps on the user's computer.

- Prefer a dedicated connector, API, CLI or skill when one can complete the task.
- For browser and web tasks, use Browser Use instead.
- Do not use AppleScript, `osascript`, JXA, System Events, shell commands, or any
  other UI-automation technology unless the user explicitly asks for that
  technology.
- Main agent only. Never delegate Computer Use to a subagent.

## Bootstrap every call

Each `mcp__node_repl__js` call runs in a fresh Worker. Globals, imports, module
cache and any binding are gone by the next call, so `const app` does not survive
the end of the cell. The UI state does survive, so re-binding in the next cell is
cheap.

Put the bootstrap and the actions in the **same** cell, bootstrap first:

```js
const root =
  process.env.ZCODE_CUA_PLUGIN_ROOT ??
  process.env.ZCODE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href,
);
await setupComputerUseRuntime({ globals: globalThis });
```

## Accessibility first

Accessibility is the primary action path. It is semantic, precise, works on a
background app and does not steal the user's focus.

1. Observe, then search the returned tree for the target by its role, name,
   title, value or other visible identity.
2. When a matching element exists, act on it by **index**. For a control that
   advertises a semantic action, `performSecondaryAction` is also correct.
3. For a settable element prefer `setValue` over typing or pasting. Reach for
   `paste` only when the target is not settable or the content is rich text.
4. Keyboard input is the fallback: use `pressKey` only when no element expresses
   the operation, or the user asked for keyboard interaction. Coordinates are the
   last fallback, for canvas, games and Electron content accessibility cannot see.

Do not replace an available element action with a keyboard shortcut just because
the shortcut is shorter. Do not run both the accessibility and visual paths for
the same action.

**Observation works on a background app, screenshots included** — on any
display, including windows at negative coordinates.
`has_image: false` means the call did not ask for pixels (`getAXState`), never
that capture failed.

Success means the API accepted an action, not that the app acted. Typing into a
web-content editor can be accepted and change nothing, so re-observe to confirm
the text landed.

## API

```typescript
type Vec2 = [x: number, y: number];
type ObservationOptions = { emit?: boolean };
type StateOptions = ObservationOptions & { disableDiffing?: boolean };
type StateAndScreenshot = { state: string; screenshot?: Uint8Array };
type Direction = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
type SelectionType = "text" | "cursor_before" | "cursor_after";
type Strategy = "auto" | "a11y" | "event";

type ClickOptions = {
  mouseButton?: MouseButton;
  clickCount?: number;
  modifiers?: string;
  strategy?: Strategy;
};
type SelectTextOptions = { prefix?: string; suffix?: string; selectionType?: SelectionType };
type PasteOptions = { format?: "text" | "md" | "html" };
type PressKeyOptions = { holdSeconds?: number; strategy?: Strategy };

interface Target {
  getAXState(options?: StateOptions): Promise<string>;
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  getAXStateAndScreenshot(options?: StateOptions): Promise<StateAndScreenshot>;
  elements(): Promise<{ index: number; kind: string; title: string | null; value: string | null; actions: string[] }[]>;

  paste(text: string, options?: PasteOptions): Promise<void>;
  click(target: number | Vec2, options?: ClickOptions): Promise<void>;
  drag(from: number | Vec2, to: number | Vec2, options?: { modifiers?: string }): Promise<void>;
  pressKey(key: string, options?: PressKeyOptions): Promise<void>;
  scroll(target: number | Vec2, direction: Direction, pages?: number): Promise<void>;
  selectText(elementIndex: number, text: string, options?: SelectTextOptions): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
}

interface App extends Target {}

type AppRef = { name?: string; bundle_id?: string; pid?: number; window_id?: number };
type AppInfo = { pid: number; name: string | null; bundle_id: string | null; active: boolean };
type State = { apps: AppInfo[] };

declare const agent: {
  computerUse: {
    getState(options?: ObservationOptions): Promise<State>;
    getApp(target: string | AppRef): Promise<App>;
    listApps(options?: ObservationOptions): Promise<AppInfo[]>;
    computer: Record<string, (args: object) => Promise<unknown>>;

    requestAccess(capabilities?: string[]): Promise<Record<string, unknown>>;
    stop(reason?: string): Promise<void>;
  };
};
```

The full reference is `agent.documentation.get("computer-use")`, fetched on demand;
read it only for an argument shape or response field this page does not give.

## The loop

Observe once, act, then observe again before deciding the next step.

`agent.computerUse.getApp(...)` binds an app and shows nothing; call `getAXState`
when you need to see its state. Binding also launches it if not running; there is
no separate launch tool. Its argument is a display name or a bundle identifier —
the same strings `listApps()` returns — or an `AppRef`.

When the user names an application, copy it character-for-character into the app
identifier. Do not translate, localize, normalize, shorten, or remove a suffix.
A rewritten name resolves to a different app or to nothing, and the failure reads
"app not found". If the exact string does not resolve, call
`agent.computerUse.listApps()` once and pick the matching identifier.

Batch related actions and a single closing observation into one cell:

```js
const app = await agent.computerUse.getApp("Notes");
await app.click(box);
await app.typeText("hello");
await app.pressKey("Return");
await app.getAXState();
```

An element index addresses that app's latest observation, so several actions may
reuse one index without re-observing between them — click an index, then type into
it, in the same cell. Observing renumbers the tree, so take indices from the newest
one. A vanished element fails closed with `ELEMENT_UNAVAILABLE`.

The tree comes back as a diff only against a tree this cell already showed you,
listing the elements that were removed, added or changed; unchanged rows are
omitted and their indices stay valid. The first tree after binding, and the first
after `getScreenshot` or `elements()`, are always complete. Pass
`{ disableDiffing: true }` for a full tree at any point. If a standalone
observation reports no change, do not immediately repeat it without an
intervening action.

A large tree is trimmed by priority (ancestors kept), the header says so, and
indices then skip numbers. `app.elements()` returns every element with its index,
trimmed ones included — filter it in JS, never guess an index.

A capture is scoped to one window: without a `window_id` the main/key window is
re-resolved every observation, so a modal that just opened becomes the captured
window. When an action fails or the tree reads like another part of the app, check
the observation's `window` — a dialog shows up there. Read it, then act on it, or
dismiss it (Escape or its own cancel) and observe again. A missing element is not
proof the action worked. Pin one with `getApp({pid, window_id})`; `list_windows`
has the id.

## Output

Observations display themselves: `getAXState`, `getScreenshot`,
`getAXStateAndScreenshot`, `getState` and `listApps` emit their own result.
Never pass their return value to `nodeRepl.write(...)` or
`nodeRepl.emitImage(...)`: a second raster in one result breaks the one-raster
rule and the frame is removed entirely, so you end up with no picture at all.
Pass `{ emit: false }` to suppress the display and still receive the value.

Action methods display nothing.

## Coordinates

Choose `x` and `y` only by looking at the current returned raster, with
`0 <= x < width` and `0 <= y < height` for that raster. Submit those integers
unchanged; CUA binds the current raster internally and owns every transform from
the returned raster to native dispatch. Element and window bounds are diagnostic
global screen points and must never be copied into a coordinate. When visual
fallback begins, discard coordinate-like numbers from earlier text or
accessibility results.

Act on the current raster when the target is clear; if it is too small or ambiguous,
re-observe rather than guessing at geometry.

A pointer action accepted with no change usually means the app acted where the real
pointer sits: repeating it will not help — use an element index or the keyboard.

A coordinate refusal may name an unexpected owner, or say the frame is stale — the
window moved, resized or was replaced. Observe again for a current raster, or act on
an element index, which does not depend on window geometry. Never move, resize or
close a window to make a coordinate land.

## Keyboard

`pressKey` takes a key or a `+`-separated chord and accepts both short names and
X keysym style: `"a"`, `"Return"`, `"Tab"`, `"Control_L+a"`, `"super+c"`, `"Up"`.
macOS uses `cmd`; Linux and Windows use `ctrl`. Use `{ holdSeconds }` to hold a
key or chord for a duration rather than simulating repeated presses.

Bind keyboard input to an app or element; never send it unbound. `paste` is for
rich text, or a target `setValue` cannot set — not for plain text a settable
element accepts.

`performSecondaryAction` accepts only an action the element advertises in the
current tree. Do not guess an action name.

At most one element is `focused` — the one holding keyboard focus; absent means
undetermined.

`selectText` locates text inside an editable element. Use `prefix`/`suffix` to
disambiguate repeated matches and `selectionType` to place the cursor instead of
selecting. An ambiguous match is refused rather than resolved to the first hit.

## Waiting

Observations wait for the UI to settle before capturing. Do not pause or delay
before reading state — no `setTimeout`, no polling loop.

## Errors and stopping

Actions resolve to `undefined` on success and throw `ComputerUseError` otherwise:

- `code` — `PERMISSION_DENIED`, `NOT_AUTHORIZED`, `APP_NOT_FOUND`,
  `AMBIGUOUS_APP`, `LAUNCH_FAILED`, `INVALID_APP`, `ELEMENT_UNAVAILABLE`,
  `STALE_STATE`, `NOT_SETTABLE`, `NOT_SELECTABLE`, `ACTION_UNAVAILABLE`,
  `FOREGROUND_REQUIRED`, `CONTROLLER_BUSY`, `CONTROL_STOPPED`, `SCREEN_LOCKED`,
  `HELPER_UNAVAILABLE`, `VERSION_MISMATCH`, `TIMEOUT`,
  `STRUCTURED_STATE_UNAVAILABLE`, `INTERNAL`.
- `actionSent` — whether the action may already have reached the app. Retry a
  non-idempotent action only when this is `false`; otherwise observe first and
  decide from what you see.
- `retry` — `"reobserve"`, `"retry"` or `"never"`.

`CONTROLLER_BUSY` means another live ZCode Computer Use session owns input. It is
never retryable: report the owner from the error and ask the user to close that
session.

Stop immediately after `agent.computerUse.stop()`, a kill switch, a permission
refusal, or a non-retryable error. Do not switch to a different UI-automation
technology after an access refusal.

Persist until the request is actually complete. Attempting an action is not
completion: verify the returned state visibly shows the result. If it is unchanged
or only intermediate, try another approach. Respond only when the requested state
is visibly present, or explain a concrete blocker you cannot resolve.

## Tool surface

`agent.computerUse.computer.<tool>(args)` is the low-level surface. Prefer the
bound-object API above; reach for a tool only for what the API does not
express — window enumeration, key repeat, or reading state back in the same
call. Arguments are strict: an undeclared key is refused. Each tool takes **one**
arguments object — the names below are its keys, not positional parameters:
`get_app_state({ app_ref: { bundle_id: "com.apple.Notes" }, include_screenshot: true })`.

Name an app as the OS lists it (Windows: the Start-menu name, not a window title).
Nothing takes the user's focus, except on Windows: launching a non-packaged app
does, and `include_screenshot=true` un-minimizes — a minimized tree is fully
usable, so keep the default.

```
list_apps({})
list_windows({app_ref})
get_app_state({app_ref, include_screenshot?=false, disable_diffing?=false})

left_click({target, mouse_button?="left", click_count?=1, modifiers?="",
           strategy?, app_ref?, return_state?})
left_click_drag({from_target, to, modifiers?="", strategy?, app_ref?,
                return_state?})
scroll({target, scroll_direction, scroll_amount, strategy?, app_ref?,
       return_state?})

type({text, target?, app_ref?, strategy?, return_state?})
set_value({target, value, strategy?, app_ref?, return_state?})
select_text({target, text_range?, app_ref?, return_state?})
key({text, repeat?, hold_seconds?, app_ref?, strategy?, return_state?})
paste({text, format?="text", app_ref?, return_state?})
perform_action({target, action, app_ref?, return_state?})

request_access({capabilities?})
stop_computer_control({reason?})
```

Argument shapes: `app_ref` / `app` is an `AppRef`, but a bare string here is
read as a bundle id, so pass `{name: "Notes"}` for a display name.
`scroll_direction` is `up|down|left|right`, `scroll_amount` is pages, `strategy`
is `auto|a11y|event`, and `return_state` is `compact|full|none` to return the app
state in the same call. For `target`, `text_range`, `modifiers` and the response
shapes, see `nodeRepl.write(await agent.documentation.get("computer-use"))`.
