# Assistant File Preview Cards

Assistant file preview cards render inside the latest terminal assistant row,
above message actions and before the per-turn change summary. Assistant body text
keeps the existing Streamdown behavior: plain file-name mentions are not
automatically rewritten into clickable links. A complete
`::zcode-file-citation{...}` directive is a separate, explicit projection and is
rendered with the same file-link UI and opening behavior as a Markdown
`[label](path)` link.

`::zcode-file-citation{...}` remains the canonical syntax emitted by prompts and
Skills. The renderer also accepts the model compatibility form
`:zcode-file-citation{...}` with one missing leading colon. This tolerance is
limited to file citations: both forms share the same parameter parsing, path
validation, body-link projection, and preview-card eligibility, while other
directives such as `::code-comment{...}` remain strict.

## Scope

- Preview card file types: Markdown, HTML, DOCX, XLSX, PPTX, PDF, MP4, MOV,
  WebM, M4V, MP3, WAV, M4A, OGG, Opus, FLAC, and WEBA.
- Every preview card uses a 24 x 24 px leading icon for website, recognized-file,
  and fallback-file presentation, inside the existing card icon container.
- The whole card surface is clickable and shows hover feedback by preserving the
  opaque `bg-card` base and adding the same `bg-hover` token as a translucent
  overlay (`transition-opacity`), so the card and the summary row below it read
  as one family of interactive surfaces in every shipped theme.
- The file type registry owns extension, subtitle, and opening behavior so another
  previewable file type can be added without changing the extraction pipeline.
- Card extraction supports explicit Markdown file links and plain file path
  mentions. The shared extractor accepts Unicode file and directory names, paths
  containing spaces, Unix paths, and Windows drive-letter paths for every
  registered file type, including Markdown and HTML.
- Local file references accept balanced ASCII quotes (`"..."`, `'...'`) and
  Chinese smart quotes (`“...”`, `‘...’`) around citation parameters, Markdown
  destinations, and plain path mentions. Mismatched or unclosed quotes are kept
  as raw text and do not become file links, so malformed model output cannot
  silently change the target path.
- Home-relative paths beginning with `~/` or `~\\` are resolved against the
  `homedir` reported by the current workspace Host. This applies consistently to
  preview cards, Assistant body links, citations, code comments, and local
  Markdown images. The renderer never expands `~` with its own process home;
  when the Host Home is unavailable, the path fails closed instead of being
  treated as a workspace-relative path.
- Workspace-relative references are lexically normalized across `/` and `\\`
  separators before they become cards. `.` segments are removed,
  `..` segments may only cancel a preceding segment, and any traversal that
  would move above the workspace root is rejected before Host file I/O. Safe
  forms such as `./a/../report.pdf` resolve to the normalized workspace path;
  unsafe forms such as `foo/../../private.pdf` do not generate a card.
- Explicit absolute paths remain a separate, existing product capability. They
  are not joined to or authorized by the workspace-relative resolver; opening
  them continues to use the selected local or remote Host and its existing file
  access permissions.
- Plain file-name mentions in Assistant body text are not auto-linked. Existing
  explicit Markdown-link handling remains outside this card feature and keeps
  its pre-existing behavior.
- `zcode-file-citation` accepts `path`, `purpose`, and `artifact_kind` as its
  current common parameters. `path` is required; `purpose` is parsed but does not
  change presentation or opening behavior. Other syntactically valid parameters
  are tolerated and ignored by this projection.
- A valid citation path is rendered in the Assistant body as a file link whose
  label is the path's leaf name. Citation body links are not limited to preview
  card extensions and do not perform an eager existence check.
- Citation preview cards are limited to DOCX, XLSX, PPTX, PDF, video, and audio. The supported
  `artifact_kind` mapping is `document -> docx`, `presentation -> pptx`,
  `workbook -> xlsx`, `video -> video`, and `audio -> audio`; when `artifact_kind` is absent, the type is inferred from
  the path extension. An unknown or extension-incompatible `artifact_kind`
  suppresses only the citation card, not an otherwise valid body link.
- A complete citation occupies one protected extraction range. Its inner path is
  not extracted again as a Markdown, HTML, or plain file reference, so citation
  card eligibility cannot be bypassed by the generic path regex.
- During streaming, an unclosed citation on the final standalone line is hidden
  from the body until it closes. A valid-looking inline tail is treated the same
  way. If malformed output has already continued onto later prose, the raw text
  is retained so a missing `}` cannot swallow the rest of the answer. Code-fenced
  and inline-code examples are never projected.
- Card candidates are ordered by reverse body occurrence, then deduplicated by
  resolved file path or URL.
- At most the first 15 ordered candidates are checked. The Host checks those files
  concurrently, caches positive and negative results for one minute, and the UI
  renders at most the first 10 valid cards. Invalid candidates are not backfilled
  from positions after the first 15.
- Renderer validation is keyed by the semantic card signature and the selected
  workspace file service. Re-rendering an equivalent card list with a new array
  identity reuses the settled validation result without another Host RPC; changing
  either the card signature or workspace file service starts a new validation.
- Markdown and HTML cards require a matching active file in the current turn's
  `fileChanges`. Office, PDF, and video/audio cards do not use this gate.
- Current-turn `fileChanges` requests are deduplicated above virtualized rows in
  `SessionPane`. Running-turn requests include the current projection revision
  in their key and share only the in-flight promise; the settled result is
  removed because that turn can still grow. Terminal-turn requests use
  `sessionId + logEpoch + turnHeader rowId + entityId + fileChanges state`, share
  both in-flight and successful results, and remain in the renderer-local LRU of
  at most 20 entries. A projection transition from `active` to `reverted`
  therefore cannot reuse the pre-rewind result. Failed requests are always
  removed.
- File-reference extraction is memoized once per terminal turn text and
  workspace path. The Markdown/HTML `fileChanges` gate and final card builder
  consume the same extracted references; rebuilding an equivalent assistant-row
  array does not repeat Unicode/path parsing.

## Projection and state boundary

Preview cards remain a UI-only projection from already delivered V4 rows. They do
not add protocol rows, snapshot fields, replayable events, relay state, or
agent-side metadata.

```text
assistantText rows (desktop continuous / mobile replayable hydration)
  |
  +-- complete zcode-file-citation
  |     +-- body: render leaf-name link through existing MessageFileLink
  |     `-- cards: admit only compatible docx/xlsx/pptx/pdf references
  |
  +-- streaming / failed / non-tail row ----------------------> no cards
  |
  `-- latest complete|interrupted row
        |
        +-- join assistant text in body order once
        +-- extract file references once; reuse them for gate + card build
        +-- extract localhost candidates
        +-- fetch this turn's fileChanges with the turnHeader target when md/html is present
        |     +-- running: revision key + in-flight only
        |     +-- terminal: target + active|reverted key + settled success, shared LRU <= 20 entries
        |     `-- active md/html paths only
        +-- reverse occurrence order + dedupe
        +-- take first 15 candidates
        `-- workspace-scoped fileService.checkFilesExist()
              |
              +-- Host cache: workspace host instance + path, TTL 60 s
              +-- concurrent checks: at most 15
              `-- keep valid candidates, take first 10 -> render cards
```

The Host file service instance already belongs to one local or remote workspace
host. Cache entries are therefore isolated by the host instance; renderer code
must resolve the service with `useWorkspaceServices(workspacePath,
remoteSessionId, workspaceIdentity)` so remote paths are checked by their remote
workspace host.

The same workspace-scoped Host provides `systemService.info().homedir` for Home-
relative Assistant paths. Desktop local uses the local Host Home; SSH/WSL/Docker
and Web `/remote` use the attached remote Host Home. The Home result is cached per
`workspaceIdentity?.trim() || workspacePath` plus `remoteSessionId` and refreshed
when the Host service instance changes.

Workspace-scoped service selection identifies which Host performs file I/O; it
does not by itself prove that an input path is under the workspace directory.
That directory boundary is enforced earlier for relative Assistant card
references by the shared lexical resolver. Rejected card candidates must never
reach `checkFilesExist`, Preview Pane, Browser, or external-editor actions.

Citation body links deliberately remain outside this eager validation pipeline.
They reuse the existing Markdown file-link click path, including its workspace
scope, traversal rejection, Windows/UNC normalization, and click-time file stat.
The one-minute `checkFilesExist` cache is used only when a citation becomes a
preview-card candidate.

## Current-turn fileChanges gate

Markdown and HTML are source-like formats that appear frequently in discussion.
Their preview cards are shown only when the terminal row's turn reports an
`active` fileChanges result containing the resolved path. A missing target,
unavailable fetch function, reverted result, or failed request yields no Markdown
or HTML cards. This failure does not suppress DOCX/XLSX/PPTX/PDF/video/audio cards.

A stale-authority rejection (`proto.staleRevision`, `proto.staleLogEpoch`, or
`proto.staleTarget`) is not treated as a final failure. A turn that has just
completed can still have its projection revision advanced by trailing events,
so the query's `baseRevision` may already be outdated when the Agent checks it.
The card projection keeps Markdown/HTML hidden, waits for the stale recovery,
and retries the same terminal target up to three times with a short increasing
delay (150/300/450 ms). Only when those retries are exhausted, or on any other
error, does the gate settle to "no changed paths".

The turn header's `fileChanges.state` is the authoritative rewind state. When it
changes to `reverted`, the card projection immediately clears previously loaded
Markdown/HTML paths and does not wait for a detail query to rediscover the state.
The same primitive state is part of the shared terminal query key so the file
summary panel cannot reuse an `active` Promise/result after rewind.

The query target must be the same turn's `turnHeader` row. The terminal
`assistantText` row remains the body/card render anchor, but it is not a valid V4
`fileChanges` action target. If the turn header or its entity id is unavailable,
the UI fails closed for Markdown/HTML cards instead of querying with an assistant
row.

The gate compares normalized workspace paths. For a bare name, it may resolve to
a fileChanges path only when that name identifies a matching file in the current
turn; otherwise normal workspace-relative card resolution is used.

The shared cache lives above `ConversationTimeline` virtualization, so scrolling
a completed turn out of view and back does not repeat the full-detail query. A
running turn may expose a partial file summary; consumers therefore request it
with an in-flight-only policy and refetch after the header enters a terminal
state. This prevents an earlier projection revision from suppressing final
Markdown/HTML cards or leaving a remounted file-change panel incomplete. It is
recreated when the session, `logEpoch`, or fileChanges transport changes;
failures are never retained. This cache is separate from the Host's one-minute
file-existence cache because it stores turn diff results, including patch lines,
instead of path existence booleans.

## Opening behavior

- DOCX, XLSX, PPTX, PDF, supported video/audio, and Markdown open in Preview Pane using a file source
  carrying `workspacePath`, optional `workspaceIdentity`, and optional
  `workspaceRemoteSessionId`.
- After the latest assistant turn reaches `complete`, the renderer automatically
  opens the PPTX cards that survived the existing candidate limit and file
  existence validation. `interrupted`, `streaming`, `failed`, historical, and
  cold-resumed turns do not trigger automatic opening.
- When one completed turn produces multiple visible PPTX cards, every card is
  opened as a separate right-side Code Viewer tab. Existing tabs are reused by
  the normal workspace-scoped source key, and the first PPTX card in the card
  order becomes the active tab. This is tabbed preview, not a new split-pane
  layout.
- Local desktop HTML keeps the Browser side-pane behavior.
- Remote workspace HTML on Desktop degrades from `file://` Browser navigation to
  the file Preview Pane because the browser cannot safely resolve the host
  workspace path.
- Web `/remote` does not project localhost/127.0.0.1 URL cards or HTML
  output cards. Without port forwarding or a URL proxy those URLs cannot reach
  the Desktop host, and Preview Pane would only show HTML source rather than the
  rendered page. Markdown, DOCX, XLSX, PPTX, PDF, and video/audio cards remain available.
- Desktop localhost HTTP cards keep the Browser side-pane behavior. When a URL
  maps to a generated HTML file, the backing file must also pass the existence
  check.
- Desktop local and Desktop remote workspaces support the automatic PPTX open
  because they expose a right-side Preview Pane. Web `/remote` keeps the cards
  visible, but does not auto-open when the current surface has no usable right-
  side Preview Pane.

## Compatibility

- Desktop stays on the existing `desktop-continuous` message path.
- Web remote stays on `web-remote-replayable`; card projection runs only after
  row hydration and does not enter gap/snapshot recovery. Unsupported local URL
  and HTML candidates are filtered in renderer projection before the 15-card
  existence-check window, without adding protocol or Host state.
- The `fileChanges` cache is renderer-local query state. It does not add relay,
  Host, snapshot, or replayable state and does not alter delivery semantics.
- No service or cache key uses `workspacePath` as workspace identity. Remote
  routing continues to carry `workspaceIdentity` and `remoteSessionId` through
  the existing workspace service accessor.
- Existing Preview Pane Office/PDF renderers are reused; this feature does not
  add another document parser.
- Automatic opening is a renderer-local side effect. It does not add protocol
  rows, snapshot fields, relay state, or Agent metadata. A one-shot key scoped by
  workspace, session, log epoch, turn, and card signature prevents virtualized
  remounts and equivalent re-renders from reopening a tab after the user closes
  it.

## Card action menus

The entire card supports a context menu. The entire card surface — blank space,
icon, title, and subtitle — is one transparent full-card button that triggers the
same in-app preview action as the Open primary button. The right-side Open and
dropdown controls render above that transparent button, so one click never fires
the card action and a control action at the same time. When the preview action is
unavailable, the transparent button is disabled together with the Open button.
Because the surface is a real `<button>`, Tab focus and Enter or Space activation
work without extra handlers, and its accessible name is the Open label plus the
card title (Chinese: `打开 {title}`). The existing Open button and dropdown retain their original labels, flat
application list and width; both entry points reuse the same opening handlers.
File context menus offer Preview, Open (the system default application), an Open
with submenu, then the reveal entry described below, then copying relative and
absolute paths. The legacy Open containing folder entry and its separator stay
omitted. Chinese labels are 预览 and 打开.
Website cards use the same Preview and Open labels for side-pane and browser
actions, followed by copying the URL; file-backed local HTML additionally offers path actions.
The card primary button continues to read Open for all card types.

Both the card context menu and the Open dropdown offer one reveal entry that
locates the card's local file in the platform file manager: on macOS / Windows it
opens the parent folder with the file selected (falling back to opening the folder
if selection fails); on Linux it opens the parent folder. The label follows the platform: `Open in Finder` / `在 Finder 中打开` on
macOS, Explorer on Windows, and the generic file manager label elsewhere. The
entry is shown only when the card has a local file the current Host can reveal:

| Card                                                                       | Reveal path                          | Entry                        |
| -------------------------------------------------------------------------- | ------------------------------------ | ---------------------------- |
| File card (Office/PDF/media/Markdown)                                      | the card path                        | shown on desktop local / WSL |
| `file://` HTML website card                                                | `localPath`                          | shown                        |
| localhost website card whose URL path maps to an HTML written in this turn | `sourcePath` (the mapped `filePath`) | shown                        |
| Plain URL, or any card in a remote (SSH/Docker/Web remote) workspace       | none                                 | omitted                      |

The localhost-to-HTML mapping reuses the current-turn fileChanges gate, so it
applies only when the reply also references that HTML path (the HTML card itself
is then suppressed by the localhost rule). A reply that contains only the URL
yields a plain URL card without `sourcePath`.

`sourcePath` is used only for reveal. Opening a localhost card always passes the
original URL to the Browser, never the `file://` source, so routes and dynamic
content keep working. In the dropdown the reveal entry follows Open externally for
website cards and follows the application list for file cards.

Assistant body file links (`MessageFileLink`, the Markdown / citation link
rendered inside the reply text, not a card) offer the same platform reveal item
in their context menu. Order: Open, the application group (file associations for
files, workspace editors for directories), a separator, then the reveal item,
then Save as… (files only) and the path actions. A file link reveals the file in
its parent folder with the file selected (`OpenInEditor` `finder` / `explorer`,
`pathKind: "file"`; Linux or a failed locate falls back to opening the parent
folder). A directory link (stat result, or an explicit trailing slash before stat
returns) opens that directory itself through `OpenInFileManager`, never a
select-file request. Visibility follows `useFileContextActions.canRevealInFileManager`
like the card menus: local workspaces and WSL show it (WSL goes through
`explorer` with the UNC path), SSH / Docker / other remote workspaces and Web hide it.

Native file actions require the platform's explicit `canOpenLocalFiles` capability.
Web and mobile omit them. Remote files never use the local default application;
Open with retains the existing exact workspace identity/session match.
Unavailable platform actions are omitted, while temporarily loading application
choices display a disabled loading row. Preview keeps the existing scoped source
and mobile pane presentation.

```text
card context menu / unified file-application dropdown
              -> shared action owner (OpenSplitButton)
              -> existing preview callback / platform port / file action hook
```

The menu owns only transient UI state. It adds no runtime queue, protocol,
snapshot, or recovery state; desktop continuous and mobile replayable delivery
remain unchanged. Async app discovery is scoped to the target and ignores stale
results after the target changes or unmounts. Both menus reuse the design system
primitives, keyboard navigation, light/dark tokens and localized labels.

APC14 acceptance: right-click a real Office card, verify accessible application names,
explicit default-first ordering, first-three plus More grouping and that the legacy
Open containing folder entry stays omitted (the platform reveal entry is APC15).
Exercise 0/1/3/10 candidates with an isolated main IPC fixture, preview the file,
and verify the selected application ID and file target at the IPC boundary.
For each candidate count, the local-workspace Open dropdown shows the platform
file-manager item ("Open in Finder" / "Open in File Explorer" / "Open in File Manager")
exactly once, after the application group and directly before Save as; the card
context menu shows the same item (APC15). Clicking it on macOS / Windows sends exactly one `OpenInEditor` request
(`finder` / `explorer`, the file path, `pathKind: "file"`) so the file manager
opens the parent folder with the file selected; on Linux it sends exactly one
`OpenInFileManager` request with the parent directory. No application-open
request is sent.
The fixture does not claim native enumeration, external application launch or
a real file-manager window. Remote (SSH/Docker hidden, WSL shown) and Web
(hidden) visibility are not covered by APC14.
APC15 acceptance (macOS only; other platforms skip): with the main-process
file-manager IPC replaced by an isolated probe, (a) a DOCX card's context menu
and dropdown each send one `OpenInEditor` finder request for the file
(`pathKind: "file"`), while a plain localhost URL card has an existing dropdown
and neither menu offers the entry; (b) a localhost card whose URL path maps to an
HTML written by this turn sends the same request for that HTML from both menus,
and clicking the card still opens the original URL in the Browser; (c) in the reply
body, right-clicking a Markdown link to the local DOCX shows the entry exactly once,
after the application group and directly before Save as, and clicking it sends one
`OpenInEditor("finder", <path>, {pathKind: "file"})` with no `OpenInFileManager`
and no application-open request, while right-clicking a Markdown link to its folder
(no Save as) sends one `OpenInFileManager(<dir>)` and no further select-file request.
Windows/Linux labels and remote workspaces are not covered by this case.
Browser acceptance (`packages/ui/test/browser/manual-review/pending/preview-card-actions.test.mjs`)
covers the whole-card click contract for file and website cards: clicking the
card body previews exactly once, clicking the Open button previews exactly
once, clicking the dropdown trigger only expands the menu, and the overlay
button supports Enter and Space activation. PCA07 renders the real preview card
and change-summary header in light, dark, Zai Light, and Zai Dark themes.
It compares screenshot pixels after hover transitions settle, requires equal
hover colors and an unchanged opaque card base, checks that dark-theme hover
brightens the card, and repeats the card-body click assertion in every theme.
APC E2E exercises the card body
click on a localhost website card (APC01) and a Markdown file card (APC05)
alongside the existing Open-button path.
