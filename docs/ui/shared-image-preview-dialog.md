# Shared Conversation Image Gallery

## Scope

Conversation Markdown images and Browser Use / `node_repl` result images use one
shared thumbnail layout and full-screen preview dialog. Chat attachment previews also use the shared dialog while retaining their own
loading/error metadata. The persistent Preview Pane keeps its separate pane lifecycle.

## Shared thumbnail layout

- A single image keeps its intrinsic ratio, uses at most half of the message
  width, and is capped at `max-h-90`.
- A multi-image group uses one column on the narrowest screens, two columns from
  the small breakpoint, and fixed `h-44` thumbnails on desktop.
- Desktop groups flow horizontally and wrap onto additional rows. They never
  create a horizontal scrollbar.
- Every thumbnail uses `rounded-xl`, a semantic border/background, and
  `object-cover`.
- Markdown and Browser Use retain separate image loading and group ownership;
  only their presentation contract is shared.

## Shared behavior

### Preview editing (2026-10-22)

The preview supports selection/moving annotations, pen, text, rectangle, ellipse,
arrow, color, undo and redo. The image editor has no eraser tool (2026-11-02
toolbar revision); selection plus Delete removes one annotation and never changes source
pixels. Tools are collapsed behind a small image-side “Draw” action on all screen sizes.
Expanding it reveals a vertical floating toolbar next to the image. Save creates a PNG at the source
image's natural resolution and adds it to the focused Composer as a new attachment.
It preserves existing text/attachments and never sends a prompt or overwrites the source.
Closing or navigating with edits requests Add / Discard / Keep editing confirmation.

- Clicking empty space closes the mask. Image clicks, controls and completed drags do not.
- Images that fit use the normal cursor. Selection mode shows grab/grabbing only
  when the scaled image exceeds its viewport; editing uses a crosshair or text cursor.
- Wheel zoom needs no modifier and anchors at the pointer, with the same 50–300%
  range as buttons and pinch. Pan stays bounded, including after viewport resize.
- A released stroke commits exactly once even when `lostpointercapture` with
  `buttons=0` arrives before `pointerup` (observed after the native color picker).
  `pointercancel` and capture loss while a button is still pressed discard the
  unfinished draft. Late end events never append a second copy.
- Text entry consumes arrows and undo keys. Gallery navigation must not interrupt typing.
- Save is available after an edit; it locks one focused Composer before async PNG
  export. Closing/navigating is blocked during export. Composer scope changes,
  unmount, disabled state or attachment admission failure reject the append.
  Failure keeps edits and reports an error; repeated save clicks cannot duplicate files.
  PNG export is limited to 32 million source pixels to bound canvas memory.
- Download continues to save original bytes. Video items keep their playback controls
  and do not expose annotation tools. Cross-origin canvas failures are explicit.

```text
image + preview-local annotations → Save → capture focused Composer receiver
                                           ↓
                                  async natural-size PNG export
                                           ↓
              preview still open + receiver still valid → addAttachmentFiles
                                           ↓
                                existing upload/draft attachment owner
```

Impact: presentation, draft-default and commit-effect; planning mode. The shared
`ImagePreviewDialog` is used by Markdown, tool result images, user-message media
and Composer attachments. Each entry keeps its own gallery/loading state; the
preview owns only transform and annotation history. `useComposerAttachments`
remains the attachment owner and enforces existing limits. Desktop and mobile
use the same renderer path and existing local/remote upload adapter. No changes
to accepted input, runtime, snapshots, replay or original file persistence.

Must inspect: shared dialog, annotation surface and focused Composer admission.
Should inspect: mixed video/image gallery and keyboard focus. Invariants: no
automatic send, no cross-scope late append, original media unchanged. Evidence:
codegraph is unavailable for this checkout; direct callers and attachment sink
were traced with source search to depth two. The feature graph now includes this
shared preview edit contract; there are no unresolved product decisions.

| Case | Setup/action | Expected | Decision |
| --- | --- | --- | --- |
| IPE01 | Fit image, click blank/image/control | Blank closes; image/control stays; cursor is normal | accepted |
| IPE02 | Wheel, button, pinch, pan, resize | Anchored bounded zoom/pan; grab only on overflow | accepted |
| IPE03 | Pen/text/shapes, select/move, delete selected mark, undo/redo | Original preserved; edits and history render consistently | accepted |
| IPE04 | Save with text and attachment already in Composer | One natural-size PNG appended; draft preserved; zero sends | accepted |
| IPE05 | Close/switch scope during export, full/disabled Composer, export failure | No late or duplicate append; failure retains editable history | accepted |
| IPE06 | 390/1100px, light/dark, Chinese/English | No eraser; tools collapsed by default; Add to chat appears below the active drawing only after an edit; controls accessible without overlap or horizontal page overflow | accepted |

Dimensions: image vs video, fit vs overflow, mouse vs touch, edit vs export,
available vs invalid Composer, width/theme/locale. Sending/queue/fork/replay
cross-products are pruned because saving only uses existing draft admission.
E2E handoff: browser candidate covers IPE01–03/05–06; desktop pending candidate
covers IPE04 with the real Composer. Promotion remains subject to human review.

- The active image starts centered at 100% zoom.
- A compact top action row contains zoom-out, percentage/reset, zoom-in, Open With,
  download, more actions and close. Mobile keeps icon actions compact.
- Zoomed images support bounded mouse drag, single-touch drag, and two-touch
  pinch zoom. Images that fit inside the viewport remain centered.
- Multi-image groups expose fixed `ArrowLeft` and `ArrowRight` controls centered
  vertically against the viewport. Keyboard arrows perform the same navigation.
- Changing images resets zoom and translation.
- Closing the dialog returns focus to the thumbnail that opened it.
- Download and close buttons stay in the top-right safe area. Windows
  positions the action row below the native `titleBarOverlay` caption area.
  Linux keeps the dialog content below its self-drawn titlebar and preserves a
  trailing inset for the action row. macOS places the action row below the hidden native titlebar; Web and mobile keep
  the normal top-right inset.
- Download saves the active image. Desktop sends HTTP(S) sources to Electron
  main for CORS-independent streaming. Main resolves each initial/redirect
  destination, rejects local/private/reserved addresses, and pins the accepted
  address set into the actual connection to prevent DNS rebinding. It applies a 30-second timeout and five-
  redirect limit, and enforces the 50 MiB bound before the native Save As
  destination is written; resolved `data:` images continue through the bounded
  byte payload path. Web uses a size-bounded response reader when JavaScript can
  read the source, and falls back to browser-native navigation for cross-origin
  HTTP(S) sources that reject CORS so renderer memory is not used as an
  unbounded download buffer.
- Base64 `data:image/...` sources never enter the network path; their content is
  bounded in renderer memory and saved through the byte-payload IPC variant.
- The dialog works in desktop continuous and Web remote replayable rendering
  without adding image bytes to conversation/session state.

## Source-specific behavior

- Markdown provides the adjacent Markdown image group and uses image alt text as
  the suggested filename.
- Browser Use / `node_repl` provides the retained images emitted by the same tool
  result as one group and suggests `result-image-{index}.{ext}` filenames. Core
  currently retains at most `MAX_NODE_REPL_DISPLAY_IMAGES = 2` display images
  per result.

## Accepted cases

| Case    | Setup                             | Action                    | Expected                                                    |
| ------- | --------------------------------- | ------------------------- | ----------------------------------------------------------- |
| SIG-001 | One Markdown or Browser Use image | Render message            | At most half message width and `max-h-90`                   |
| SIG-002 | Multiple images on narrow mobile  | Render message            | One column, wrapped without horizontal scrolling            |
| SIG-003 | Multiple images on small screen   | Render message            | Two columns, equal-height cropped thumbnails                |
| SIG-004 | Multiple images on desktop        | Render message            | Horizontal `h-44` thumbnails wrapping to new rows           |
| SIP-001 | One image                         | Open preview              | Centered image, no navigation arrows                        |
| SIP-002 | Multiple images                   | Open the second thumbnail | Second image active; arrows and keyboard navigate the group |
| SIP-003 | Zoomed image                      | Drag or pinch             | Translation/zoom stay within configured bounds              |
| SIP-004 | Any image                         | Download                  | Active image is saved through the current platform path     |
| SIP-005 | Navigated/zoomed image            | Change image              | Zoom and translation reset to 100%/center                   |
| SIP-006 | Windows or Linux desktop preview  | Open preview              | Download/close stay outside native or self-drawn controls   |

## Editing validation (2026-10-22)

- Before the fix, real browser regressions reproduced all three reports: a blank
  click kept the preview open, a fitted image had `grab`, and wheel input left
  zoom at 100%. The transparent Dialog content intercepted blank clicks, the
  viewport cursor was unconditional, and there was no wheel listener.
- Browser coverage verifies annotations, selection/move/erase/history, natural
  PNG pixels, touch pinch, bounded pan, resize, mouse-anchored wheel zoom, gallery
  button hit testing, disabled-save click isolation, and export cancellation/rejection.
  All 20 browser cases passed (18 together, two later regression cases individually).
  Visual checks cover
  390/1100px, Zai light/dark, Chinese/English.
- Real macOS Electron: save-to-Composer 1/1 passed (run
  `desktop-e2e-20261022124558480-p56523-2adaaa12b3911c95`); existing gallery 5/5
  passed (`desktop-e2e-20261022125109960-p80041-c18b5ef3f853e9e2`). The new case
  verifies a 320×240 PNG, existing draft/attachment retention and zero sends.
  Its first fixture had zero image dimensions; the repaired fixture explicitly
  waits for successful decoding before drawing.
- Official affected selection ran 502 files / 5279 assertions. One jsdom test
  lacked ResizeObserver; after adding its browser API mock, its targeted rerun
  passed 5/5. All other 501 files passed in the affected run.
- Root typecheck, Desktop E2E typecheck, lint, scoped formatting, architecture,
  fixture metadata and open-source checks passed. Lint retains existing warnings.
- Not executed: Windows/Linux native apps, real phone Safari, actual SSH/WSL/Docker
  attachment transport. Narrow browser/touch emulation does not claim those paths.
  The new desktop case remains pending human promotion; no Docker admission.

## Toolbar revision validation (2026-11-02)

- Save is right-aligned below the toolbar with a 12px gap. The image-preview
  eraser, pointer branch and translations are removed; selection/Delete and
  undo/redo remain available.
- The shared positioning container ignores pointer events in its empty area;
  only the toolbar and save area receive clicks. Browser hit testing caught
  and verified the fix for the container blocking gallery navigation.
- Browser: 20/20 passed, including 390/1100px, both themes, Chinese/English,
  separate save placement, no eraser, PNG output, navigation and disabled-save
  click isolation. Evidence: `packages/desktop/.e2e-artifacts/image-preview-edit-browser/20261102-results.log`
  and the screenshots in the same directory.
- macOS Electron: IPE04 passed with the actual Composer, including layout,
  original draft/attachment retention and zero sends. Evidence:
  `packages/desktop/.e2e-artifacts/desktop-e2e-20261102092929053-p92626-eefc98a26d487a2b`.
- Typecheck, Desktop E2E typecheck, lint (existing warnings), scoped formatting,
  architecture and fixture checks passed. Affected engineering selection found
  no tests. Windows/Linux native apps, physical phones and real remote attachment
  transport were not rerun; candidates remain pending human promotion.

## Stroke completion regression (2026-11-02)

A real macOS Electron 44.7.0 session reproduced the reported first-stroke loss
following the native color picker. The completed blue stroke had 16 points;
`lostpointercapture(buttons=0)` arrived about 0.3ms before `pointerup`. The former
cleared the draft and pointer membership, so the latter could not commit it.
The 3.17.1 packaged handler uses the same ending logic as the source baseline.

Completion now accepts either `pointerup` or capture loss with no buttons held.
The existing pointer membership guard still commits once. Genuine cancellation
and capture loss while pressed still discard the unfinished draft. No timers,
new history owner or color-specific workaround are introduced.

Evidence: `packages/desktop/.e2e-artifacts/image-preview-stroke-diagnosis/` contains
`manual-trace.json`, `fixed-electron-trace.json` and `browser-results.log`.
CDP replay reproduced the same native event order and failed before the fix;
after it, browser regressions passed 23/23, including consecutive colored strokes,
undo/redo and both cancellation paths. macOS Composer save passed 1/1 in
`packages/desktop/.e2e-artifacts/desktop-e2e-20261102095521629-p29703-d2ab6d64b0eca68e`.
Typechecks, lint (existing warnings), scoped formatting and architecture passed;
no affected engineering tests were selected. Native Windows/Linux and physical
phones were not verified. Browser and Desktop candidates remain pending.

## Layout superseded by the team-voted preview (2026-11-02)

The team vote chose the new preview layout: no persistent side toolbar,
annotation tools expanded on demand, Open With reused in the top action row, and
an image context menu with Add to chat, Copy image and Download; after saving a
local copy, Reveal opens the file manager. The right-aligned Save placement from
the toolbar revision above is replaced by the sections below. The eraser removal
and the stroke completion fix remain in force unchanged.

## Preview action consolidation (2026-11-02)

- The image context menu and the visible More button share Add to chat, Copy image,
  Reveal in file manager and Download original actions. Keyboard Context Menu /
  Shift+F10 opens the same menu. Mobile users do not need a right mouse button.
- Add to chat captures the focused Composer receiver before asynchronous reading;
  closing/switching the preview prevents late attachment insertion. It preserves
  original image bytes and does not send a message.
- Open With reuses the existing file application choices and platform ports.
  Conversation images are often data/blob URLs without a durable local path.
  “Save and open” explicitly asks for a copy through the existing Save As dialog,
  then opens that returned local path. Opening the application chooser follows the
  same explicit save step. Cancel leaves the preview unchanged. No remote path is
  passed to local applications. Reveal saves a local copy first when necessary.
- Copy and download always use the source image, not unsaved annotations. Saving
  annotations remains a separate action in the expanded side editor.
- No session, queue, stream, snapshot or host ownership changes. Desktop continuous
  and mobile replayable remain unchanged. Existing IPE01–06 apply; manual runtime
  evidence additionally covers context/More parity and Save As cancellation.

Review follow-up: successful ordinary downloads also populate the same local-copy
path used by Open With and Reveal. Collapsed annotation mode keeps marks visible
but ignores mark hit testing and editing shortcuts. Cross-origin copy uses a
bounded CORS read and temporary same-origin image; denied CORS surfaces failure.

## Inline image file mentions in user messages (2026-11-02)

User message file mentions such as `[小桥流水人家.jpg](./images/小桥流水人家.jpg)`
retain their destination separately from the display label. Image file mentions
in a workspace conversation are keyboard-accessible buttons that open this same
image dialog, including its context menu and top actions. Ordinary files,
directories, plugin links and unresolved/unsupported destinations retain their
existing display-only behavior.

Resolve only the stored destination: parse and preserve raw absolute/file-URL
paths before applying the shared relative/home path resolver. Raw mentions never
use the rehype root-relative heuristic. Use the conversation workspace/home
context for relative paths; never infer a filesystem path from
the visible filename. Reads go through the workspace-scoped file service supplied
by its ServiceProvider. The preview request identity includes workspaceIdentity
(with workspacePath fallback) and remote session identity. Closing, unmounting,
changing the destination or switching workspace/host invalidates pending reads.
Loading and missing-file failures are shown inside the dialog. Public/share
rendering without a workspace context does not gain local file access.

This changes only user-message presentation and an explicit read-only media
request. It does not change original prompt text, attachments, queues, session
ownership, desktop continuous or mobile replayable delivery.

Browser saveFile success without a local path means the download has started.
Only a returned local path can be passed to native Open With / Reveal; a
successful browser download must not display a save-failed error.

## Native application identity and Reveal (2026-11-03)

After a local copy is saved, query its registered applications and show the real
default application name and supplied icon in the top action. Before saving,
retain the neutral Save and open action: application lookup requires a real
local file. Reveal is available before saving and first requests a saved copy;
cancellation does not reveal, failure is reported, and subsequent reveals reuse
the same copy. Web without native file capability does not offer these actions.

## Collapsible side drawing tools (2026-11-03)

Replace the bottom Annotate entry with a small image-side Draw button. Tools
start collapsed. Clicking opens a vertical floating rail beside the image;
clicking again collapses it. Existing shapes stay visible but read-only while
collapsed. Reserve side space on narrow screens and bound the rail height with
scrolling, keeping top actions separate and Add to chat below the active drawing. No new drawing tools.

## Add edited image and guard unsaved work (2026-11-03)

When visible edits exist, show Add to chat centered just below the selected drawing (or the latest drawing when none is selected), not below the full image or inside the side rail. Export the edited copy into the captured current
Composer, close only after admission succeeds, and report that it can be removed
before sending. Never send or overwrite the source. Failure preserves editing.
All preview close requests and gallery navigation pass through the editor guard.
Unsaved changes offer Add to chat / Discard changes / Keep editing. Original-image
Add to chat uses the edited result while dirty, rather than bypassing the guard.
An in-flight export prevents close/navigation until it succeeds or fails.

While the confirmation is open, background editing and gallery shortcuts are blocked. Original-image asynchronous Add locks editing and navigation until admission resolves.

If closing interrupts an active drawing gesture, commit the currently visible
partial stroke once, then clear pointer tracking and release capture before
showing confirmation. Subsequent move/up events cannot change that frozen edit.

Gallery previous/next controls occupy the bottom corners, outside the vertical
drawing rail, on desktop and narrow screens. Expanding drawing tools or showing
the Add action must not intercept navigation clicks.

## Visual refinement: image-attached action (2026-11-03)

Use a quiet semantic-background canvas, popover chrome with a fine border and
soft shadow, and a single theme-matched action beneath the active drawing. The 36px-high Add to
chat button is centered 12px below the selected/latest drawing bounds, never wraps, and
only appears while dirty. Reserve bottom space and clamp positioning when
zoomed so it stays inside the viewport when the drawing approaches its edges.
The side drawing rail is one continuous surface: collapse control, drawing
controls, circular color swatch, and undo/redo groups separated by fine rules.
Use popover background and foreground tokens: light surface/dark text in light theme, dark surface/light text in dark theme. Do not invert with primary-button colors. Position follows drawing selection, movement, undo and zoom; empty drawing state hides it.
