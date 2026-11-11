# Output

Contents: Delivery · Source files · Dependencies · Markers and review · App · Web · Deck · Viewport · Infinite canvas

## Delivery

Write one complete, runnable file early, then improve it with successive edits; write large files in segments rather than composing the whole file in one reply. Actually write the design into the workspace (default `原型/`; follow any user-specified directory, file name or single-file requirement and do not add another copy). Check the real render, images and key interactions with an available browser or screenshot tool, run [check](check.md), then give the result in the reply body as a Markdown file link, e.g. `[项目名.html](原型/项目名.html)`; pptx / pdf also as file links. Reference each deliverable once, with no trailing file list. If only source was saved, a check failed or the scope is incomplete, state truthfully what is done and what is not. File-display requirements of subordinate resources do not override this section.

## Source files

- Edit in place by default on the stable source path; do not create V+1, move or archive for each change. When the user explicitly asks for a new version, branch option or kept history, save a new file (`V{N}` or a separate directory) and keep the current one.
- Do not switch skeleton or design system during iteration unless the user changes direction; other iterations read only the affected material.
- Before editing, verify the real source and the requested scope; keep everything not asked to change. Dragging, toggling or zooming in a preview is not written to source; change dynamic content in the real script, data or template, do not paste back live DOM.
- Do not modify or delete existing archives or assets still referenced by old versions.
- Naming: App is `{项目名}-无限画布.html` and `{项目名}-可交互原型.html`; Web and Deck are `{项目名}.html`. Project name and suffix follow the user's language (English: Infinite Canvas / Interactive Prototype); existing paths are not renamed. Avoid Windows-illegal characters and overlong paths; use UTF-8.
- Multiple directions each get their own subdirectory and a file name with the direction name, e.g. `方向A/项目名-方向A.html`; after one is chosen keep the other candidates.

## Dependencies

- The file opens straight from file://: classic inline `<script>` only, no `type="module"`, no fetch or XHR of local files.
- Inline CSS/JS; fonts use system fallbacks (including CJK and Windows fallbacks) or legitimate data: embedding; no external CSS, scripts or fonts, and no reliance on page network calls. Charts are inline implementations or SVG/CSS.
- Local assets live beside the HTML or in a subdirectory with unique names, e.g. `assets/hero-7f3c.png`; changed content gets a new file and does not overwrite a file an old version uses. No `../`, absolute paths or file:// references.
- Fetch data and media with real tools and write them into files; do not put connectors, tokens or service calls in the page.
- When the user asks for a single file or offline use, embed images as data: too, and open the file alone to check.

## Markers and review

- Every delivered design HTML has `<html data-zcode-design>`; decks mark slides as in Deck; several options in one page each sit in an element with `data-variant="<name>"`; tunable values (accent, theme, fonts, type scale, spacing, radius, motion) are CSS custom properties on `:root`.
- If the host's own tools or context show a design mode for the built-in browser, tell the user they can pin comments or make light edits there, and apply what comes back to the source. Otherwise fall back: ask them to open the file in a browser and describe the changes in the conversation. Never claim a design mode, pinned comments or sliders the host does not show.

## App

A complete multi-page App (phone / tablet / PC / wearable) ships two files by default: infinite canvas + interactive prototype, with shared content and key flows consistent. A single page, a component or a partial edit of existing HTML stays within the requested scope and does not add the other file. Decide the deliverable type from the user's goal and the settled platform, not backwards from a template; if unsure and it does not affect the goal, use Web.

The **infinite canvas** follows the three-layer architecture in `design-resources/skills/infinite-canvas/SKILL.md`:
- Row 1 project intro: must answer what it is, who it is for and what problem it solves; other dimensions by complexity.
- Row 2 design system: must have tone, palette (token + hex, matching the adopted system) and typography; show spacing, components, states and motion only when used.
- Row 3 designs: all pages left to right along the interaction flow, with guide lines marking navigation.
- The intro and design system do not get separate .md files.

The **interactive prototype** starts at the home page and covers the required core pages and flows: usable on desktop ≥1024, tablet 768–1023 and phone <768; a 390×844 authoring viewport is fine, but the main container must have a `max-width` / `clamp()` / media query fallback; at least two clickable elements with hover/pressed/disabled feedback and one state toggle, as a floor only.

**Edit scope**: changes to shared content (visual spec, modules, states, copy, flows) sync both files; an edit limited to one page or area changes only that scope, not Row 2 or the other file, and does not claim a sync. A whole visual-system change syncs Row 2 and affected pages. Canvas-only content changes only the canvas; prototype-only interaction changes only the prototype.

## Web

Landing pages, SaaS and web apps ship only the main HTML; decide yourself whether anything else is needed.

## Deck

When `used_mode == deck` the main product is one HTML deck `{项目名}.html`, not PPTX and not the App pair; when a pptx is needed call the presentations plugin. Required:
- One HTML source holds structure, styles, paging and speaker notes; default 1920×1080, 1024×768 when the skill specifies 4:3; the outer frame scales with the viewport.
- Each slide is a real `<section class="slide">` with page number / total and a section hint.
- ← / → or Space change slides, respecting `defaultPrevented` and keyboard ownership of forms and editable content; never a vertical long page.
- Landscape `@page` / `@media print` styles.
- Each slide has `<aside class="notes">` or `data-speaker-notes` notes, not HTML comments. Notes are spoken script ready to read aloud, not "this slide shows…" descriptions; unless specified, 80–160 Chinese characters and 2–4 sentences per slide, 150–300 Chinese characters for a verbatim script. Notes do not appear on screen.
- No phone or tablet frame.

Ordinary prototypes and canvases do not use deck markers (`data-deck-slide`, `data-screen-label`), and their file names do not use deck/slide/ppt.

## Viewport

A user-specified device wins; otherwise: App is 390×844 mobile-first, extending to tablet and desktop; Web / dashboard is desktop-first with phone and tablet breakpoints; the canvas outer layer fills the preview with `position:fixed;inset:0` and pans/zooms inside; Deck as above. Ordinary page containers use `width:100%` and a sensible `max-width`, not fixed width/height or clipping. When editing a real project, run or rebuild and check affected pages; for standalone HTML open the actual preview and exercise the interactions.

## Infinite canvas

Read the [canvas method](../design-resources/skills/infinite-canvas/SKILL.md) and [canvas template](../design-resources/skills/infinite-canvas/assets/infinite-canvas-template.html), then generate a project copy with the [canvas script](../scripts/adapt-canvas.mjs) before filling in content:

```text
node "<skill-dir>/scripts/adapt-canvas.mjs" "<workspace>/原型/项目名-无限画布.html"
```

Quote both paths. The script does not overwrite an existing file; the copy already includes reduced motion, shortcut hints, undo and drag isolation. Replace all sample content; `UI_STRINGS` and `html lang` follow the user's language, and canvas tokens match the pages; do not layer canvas effects inside pages. Keep `initDemo()` / `addPage()`. When editing canvas pages, styles apply only to page content, not to background, controls, labels, connectors or pan/zoom. A preview is not editable Figma layers.
