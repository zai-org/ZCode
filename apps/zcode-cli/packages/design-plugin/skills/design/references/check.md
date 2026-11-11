# Check

Contents: Boundaries · First look · Checklist · AI tells · Viewports · Validation · Rate and fix · Delivery self-check

Run after the work is written, then fix and re-check before delivering per [output](output.md). If the user asked for review only, report findings without treating the review as permission to modify.

## Boundaries

Do not redesign: keep the established direction, content structure and core flows; no rebuilds or irrelevant decoration; reuse the project's components, variables and conventions; fix issues directly instead of only reporting them. Prioritize systemic issues over one-off pixel tweaks.

## First look

Before the checklist, view the full-page desktop render once and write three lines: what it communicates, the first three things the eye lands on, one-word verdict. If the first three are not the intended ones, the hierarchy is wrong; any area whose purpose you cannot name in two seconds is undefined.

## Checklist

- **Icons and assets**: one consistent icon library; consistent size, stroke, corners and weight; optically aligned with text; important actions not icon-only; no emoji icons; images, illustrations and logos sharp, complete, undistorted, suitably cropped and stylistically consistent; no broken links, blurry images or meaningless placeholders. Preserve user-specified assets and brand boundaries; prefer user-provided and existing project assets. Verify the license of any external asset, and do not treat a search result as permission to reuse.
- **Type and content**: no text too small, lines too long or content too dense; no abnormal wrapping, truncation, overflow or obscured content; clear labels and copy for buttons, forms, navigation and states; fonts support the languages actually used; no Lorem Ipsum, placeholder or wrong content; heading levels not skipped; tabular-nums in number columns; curly quotes and the ellipsis character; labels stay visible, never placeholder-as-label.
- **Color and styling**: sufficient contrast for text, icons, buttons and backgrounds; success, warning, error, disabled and selected states distinguishable; no meaningless gradients, excessive shadows or stacked effects; shadows have an offset (a zero-offset colored halo is decoration); secondary text on a colored surface is tinted from that hue, not gray. Do not redefine the palette unless it harms readability or consistency.
- **Layout and spacing**: aligned to the grid or a shared baseline; same-type components follow consistent sizing and arrangement; no overlap, misalignment, clipping or abnormal empty space; more space above a heading than below.

## AI tells

Defects only when not inherited from the chosen skeleton, system or brand and encoding nothing: 3-column icon-in-circle feature row; everything centered; one large radius everywhere; card in card; CSS-shape illustration instead of an asset; gradient primary button; invented testimonials; Get Started / Learn More as the only actions; frosted glass by default; display type over 6rem off posters.

**Hard rejections (each one is High).** Generic SaaS card grid as the first impression; strong image with weak brand; strong headline with no clear action; busy imagery behind text; sections repeating the same mood statement; carousel with no narrative purpose; app UI built from stacked cards instead of layout.

**Litmus (yes/no).** Brand or subject unmistakable in the first screen? One strong visual anchor? Page understandable from headlines alone? Each section has one job? Every card necessary? Motion improves hierarchy? Still premium with decorative shadows removed?

## Viewports

Check desktop and mobile, plus key intermediate widths for complex pages: no unintended horizontal scroll, overlap, overflow or bad crops; navigation, tables, forms, dialogs and primary actions stay usable; order and priority stay sensible on small screens; type, spacing and touch targets not too small; images keep their aspect ratio; long text, other languages and extreme values do not break the layout; mobile is reorganized, not a scaled-down desktop; no `user-scalable=no`; no `transition: all`; animate transform and opacity only.

**Measurable edge and alignment check.** For responsive pages and prototypes (fixed canvases such as posters, decks and the infinite canvas are checked against their own bounds), run this in the page at 390 px and at desktop width and fix every hit; overflow checks do not catch content pressed against the edge:

```js
(() => {
  const vw = document.documentElement.clientWidth, gutter = vw < 768 ? 16 : 24;
  const hits = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,input,label,img,svg")]
    .filter((el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && !el.closest("[data-full-bleed]"); })
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.right > 0 && r.left < vw)
    .filter(({ r }) => r.left < gutter - 0.5 || r.right > vw - gutter + 0.5)
    .map(({ el, r }) => `${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 20)}" L${Math.round(r.left)} R${Math.round(vw - r.right)}`);
  return { vw, gutter, hits: hits.slice(0, 20), count: hits.length };
})()
```

Text, controls and media keep at least 16 px from both edges on mobile and 24 px on desktop; mark intentional edge-to-edge media with `data-full-bleed` (its inner text still obeys the gutter). Primary blocks in one column share one left edge at each viewport. Report hit counts per viewport; "no horizontal overflow" alone does not pass.

## Validation

Run or rebuild the affected project, or open and operate the actual HTML, with the available browser or screenshot tool: main pages, core interactions, affected viewports and components, nothing previously working broken. Operate core interactions with real pointer input: click or tap the element's on-screen center (for example Playwright `page.mouse.click` or CDP `Input.dispatchMouseEvent`) and confirm `document.elementFromPoint` there is the control or inside it; `element.click()` and synthetic DOM events skip hit-testing and miss covering layers. Closed overlays, scrims and drawers use `display:none`, or `visibility:hidden` with `pointer-events:none`; `opacity:0` alone still blocks clicks. Inspect screenshots under the entry's image rule; a capture alone is not a visual review. Without readable screenshots, check DOM, CSS, layout, contrast and states, and do not claim a screenshot review.

**Rate, then fix.** Rate hierarchy, typography, color, layout, states, responsiveness and AI tells 0-10; for each under 8 write what a 10 looks like for this brief, fix, re-rate. Severity: High hurts the first impression, trust or a core task; Medium reduces polish; fix both before delivery. Scores find gaps; do not report them as quality.

**After fixing.** Re-run the same checks; revert a fix that makes a measured result worse. Report each item as measured, looked at, or not verified.

## Delivery self-check

1. The file exists in the workspace and the current render, images and key interactions were actually viewed.
2. Everything above passes. Run `node "<skill-dir>/scripts/design-lint.mjs" "<page.html>" "<design-system file>"` (`--spacing` when the system has a spacing scale; see [design-system](design-system.md)) and fix or justify every hit; without a system file it runs generic checks only, so say so; exit 2 means the page or the system file you named could not be read or holds no tokens, so fix the path or the file instead of reporting a pass. Then check by eye what it cannot: components, type scale and rhythm against the adopted system.
3. CREATE: the skeleton, visual-system and craft reads in create happened before the first draft.
4. Full App: both files exist, share content and pass output's App rules; partial edits are checked only in scope.
5. The latest request, chosen options, PRD/QA, code baseline and redesign boundaries are all met, or explicitly marked out of scope or pending.
6. No invented results, testimonials or product facts; demo data is labelled.
