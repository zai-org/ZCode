# Markdown Preview Renderers

Markdown messages are rendered through `MessageResponse` in
`packages/ui/src/components/ai-elements/message.tsx`.

The shared chat and file-preview type scale is compact and explicit: body text,
paragraphs, lists, links, tables, and H3-H6 use `text-ui-base`; H1 uses `text-lg`;
H2 uses `text-ui-lg`; inline code uses `text-ui-sm`. Fenced code blocks continue to
use the independent code font-size preference.

Strikethrough follows the GFM specification rather than GitHub's permissive
single-tilde extension: only `~~text~~` renders as strikethrough. A paired single
tilde such as `~text~` remains literal text in completed and streaming messages.

Bare URL literals end at CJK punctuation (U+3000–U+303F, U+FF00–U+FFEF), and at
a CJK letter that directly follows an emphasis marker (`*`, `_`, `~`). GFM only
ends a bare URL at ASCII whitespace or `<`, so `**https://example.com**（说明`
would otherwise pull the closing `**（说明` into the URL and leave the opening
`**` as literal text. Before parsing, `normalizeMarkdownCjkBareUrls`
(`packages/ui/src/lib/markdownCjkBareUrl.ts`) finds each bare URL that such a
CJK boundary ends, trims the GFM trailing punctuation (`? ! . , : * _ ~` and an
unbalanced `)`), and writes it as `<url>` (`www.` URLs become
`[www.x](http://www.x)`). The emphasis then pairs during parsing and only the URL
is a link. Text in inline code, fenced code (including fences indented inside
list items or prefixed by `>` in blockquotes), indented code blocks, link labels,
link destinations, existing `<url>` autolinks, and HTML attributes stays
unchanged. A non-list line indented by four spaces or a tab is always skipped, so
a bare URL in an indented list continuation paragraph keeps the plain GFM
rendering. A URL that ends at whitespace or at the end of the text also stays
unchanged, so the behavior of non-CJK text and of a URL that is still streaming
does not change. Known limitation: the scan is line based, so inline code that
spans several lines is not detected and a URL inside it can still be rewritten.

The markdown renderer now routes high-impact block elements through local UI
components instead of relying only on Streamdown defaults:

- Code fences use `CodeBlock` and `CodeViewer`, with syntax highlighting delayed
  while a message is streaming.
- Tables use `markdown-table.tsx` for the action toolbar, bordered container,
  horizontal scroll, edge shadow hint, and wrapping cell content. Tables should
  keep natural column sizing so many columns can still expand into horizontal
  scroll, while each cell has a readable max width so one long prose/URL/token
  wraps inside the cell instead of forcing the whole table wider. The bordered
  table frame should stay fixed around the viewport, while the wide table content
  scrolls inside that frame; edge shadows remain inside the frame to hint when
  more columns are available. The action toolbar order is copy,
  download, preview: copy writes a generated Markdown table, download saves CSV,
  and preview opens an app-modal table view whose width and height follow the
  table content until constrained by a 64px viewport margin on every side. When
  the preview table scrolls vertically, its header cells stay pinned to the top
  of the preview scroll viewport with an opaque semantic background. The virtual
  horizontal scrollbar may stick above the composer for tall tables in the main
  chat viewport, but tables in subagent prompt, thought, and output panels keep the
  scrollbar at the table bottom.
- Blockquotes use `markdown-blockquote.tsx` for the shared quote rail and text
  treatment.
- Ordered and unordered lists use `markdown-list.tsx` for consistent spacing,
  markers, and nested list rhythm.
- Links keep their primary click behavior and also expose a right-click menu.
  HTTP links open in the in-app browser pane by default and can be opened in the
  system browser from the menu. Workspace file and directory links use the same
  default open behavior as chat messages, then list installed local editors using
  the editor ordering from the workspace file tree and header editor controls.
- Images use `markdown-image.tsx` for Markdown grouping and the shared
  `image-preview-dialog.tsx` for preview interaction. A run containing at least two adjacent,
  image-only Markdown blocks is rendered as one gallery. Text, headings, lists,
  code, or other block content ends the run. At desktop widths the gallery keeps
  a fixed 176px thumbnail height and wraps onto additional rows when the available
  width is exhausted; the gallery does not introduce horizontal scrolling. Below
  the desktop breakpoint it wraps into two columns, and below the small breakpoint
  it wraps into one column. A single image keeps its natural aspect ratio while
  being constrained to at most half the message width and `max-h-90`. Clicking
  any rendered Markdown image opens an app-modal preview; gallery images can be
  traversed as one group with arrow-left/arrow-right controls placed on the left
  and right sides of the viewport and vertically centered on screen, plus keyboard
  arrows.
  The image is centered in a viewport-sized canvas. Once zoomed beyond the canvas,
  it supports bounded mouse or single-touch dragging; two-touch pinch adjusts zoom
  without allowing the image to be dragged completely out of view. Changing images
  resets zoom and position. The bottom toolbar is a compact pill containing only
  circular zoom-out and zoom-in buttons with the current zoom percentage between
  them. The preview supports bounded zoom and uses
  circular, bordered download and close buttons in the top-right corner, with
  download placed to the left of close.
  Both buttons fade their background surface to 80% opacity on hover. Downloading
  saves the currently visible preview image, including remote HTTP(S) and resolved
  local images. Desktop streams HTTP(S) sources in main after rejecting
  local/private/reserved initial and redirect destinations and pins the
  validated address set into each actual connection, with a 30-second
  timeout, five-redirect limit, and 50 MiB bound before writing the native Save
  As destination. Web uses a bounded response reader when CORS permits and otherwise
  delegates the HTTP(S) source to browser-native navigation. Cancellation is silent, while failures and
  successful saves provide explicit feedback. Local images continue to load through the
  injected `fileService`; HTTP(S) images continue to load directly in the browser.
  Browser Use / `node_repl` result images use the same thumbnail gallery and
  preview dialog while retaining tool-result grouping and result-derived filenames.

Keep new markdown block styling in these renderer components when possible.
`MessageResponse` should stay focused on connecting Streamdown component names to
the local renderers.
