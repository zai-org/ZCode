---
name: orbit-notion
description: |
  Open Orbit briefing skill — selected by the Orbit pipeline when
  Notion is the user's only connected connector, or when the user
  explicitly scopes their daily digest to Notion. Pulls the past 24
  hours of document edits, comments, mentions, and database row changes
  from the user's authenticated Notion connection and renders the
  digest as a native Notion page (callout / toggle / database table
  primitives). This skill should not be triggered manually — it is
  invoked by Orbit's daily-digest scheduler against live Notion data.
triggers:
  - "notion briefing"
  - "notion digest"
  - "doc digest"
  - "notion 简报"
  - "文档摘要"
od:
  mode: prototype
  platform: desktop
  scenario: orbit
  featured: 5
  preview:
    type: html
    entry: index.html
  design_system:
    requires: false
  example_prompt: "Generate today's Open Orbit Notion briefing. Notion is my only connected connector — pull yesterday's document edits, comments, @ mentions, and database row changes and render the digest as a native Notion page."
---
<!-- Modified by ZCode: added a localization rule. Derived from open-design 0.7.0 (Apache-2.0); see design-resources/NOTICE.md. -->

# Orbit · Notion Briefing

Single-connector Orbit template scoped to Notion. The briefing renders
*as a real Notion page* — same chrome, same block primitives, same
typography.

## LOCALIZATION RULE

This skeleton contains Notion-style UI chrome. When instantiating for a user, the agent MUST write ALL visible copy (section headings, card titles, table labels, placeholder text) in the user's conversation language. Structural CSS (Notion primitives, callout/toggle patterns) stays unchanged. The `<html lang>` attribute must match the user's language.

## ⚠️ Source-of-truth protocol (read this first)

**Step 1.** Open and read the shipped `example.html` in this folder
before writing any output. That file is the canonical design — your
job is to **reproduce it**, not reinterpret it.

**Step 2.** Mirror the example's structure 1:1:
- Same DOM hierarchy and class names
- Same H2 sections in the same order (Document changes → Comments / @ mentions → Database changes), headings written in the user's conversation language
- Same bullet rows / comment cards / database table columns and rows
- Same callout(s) and toggle block with equivalent copy, written in the user's conversation language
- Same property chips at the top (Type / Owner / Created)
- Same `<script>` block at the end (page-link → notion.so injection)

**Step 3.** You may refresh mock values (doc titles, mentioned people,
edit timestamps) so they read as "today", but you must **not**
invent extra blocks: no extra H2 sections, no extra callouts, no
extra database columns, no extra emoji decorations. If a detail is
not in `example.html`, it does not belong in your output.

The sections below are a **reference for tokens and visual language** —
not a license to extend the page.

## ⚠️ Design system policy

This skill ships with its **own** complete visual language baked into
`example.html` (Notion's native page chrome and block system). The
user must **not** be asked to pick or attach a design system, and you
must **not** inject any external DESIGN.md tokens into the output.

- If the active project has a design system attached, **ignore it**.
- If the user supplies brand tokens or a Figma file, **ignore them**.
- Use exclusively the colors / fonts / radii defined in `example.html`.

This is a hard constraint: the briefing must read as a real Notion
page, not as the user's brand.

## Canvas tokens (use these exact values)

```
ink (Notion black):  #37352F
text-secondary:      #787774
gray bg (block):     #F1F1EF
gray border:         #E3E2E0
gray light:          #F7F6F3
gray cover:          #E9E5E0
white surface:       #FFFFFF

blue:                #2383E2
blue bg:             #D3E5EF
blue text:           #24548A
green:               #4DAB60
green bg:            #DBEDDB
green text:          #1D6B2D
orange bg:           #FADEC9
orange text:         #93531D
yellow bg:           #FDE68A
callout bg:          #F1F1EF
```

Type stack:
- `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Helvetica, 'Apple Color Emoji', Arial, sans-serif, 'Segoe UI Emoji', 'Segoe UI Symbol'`
- Page title: 40px bold
- H2: 24px semibold with 1.6em top margin
- Body: 16px / line-height 1.5
- Captions / breadcrumbs: 14px

Notion always uses generous left/right margins; center the content
column at ~720px max width with the rest as `--gray-light` rails.

## Page sections (top to bottom)

1. **Top app bar** — full-width, white, 45px tall.
   Left: Notion-style sidebar toggle (`«`), then breadcrumb path
   `Open Orbit › Daily Briefing › May 6`. Breadcrumb separators in
   `text-secondary`. Far right: 🔍 search, ⏱ updates, ⚙ share, ⋯.

2. **Faint left sidebar (optional, may render as a 1px hairline rail)**
   to imply Notion's workspace sidebar without rendering it in full.

3. **Cover image** — full-width strip ~200px tall, gray cover color
   `#E9E5E0`, optional small "Add cover" hint hidden in the corner.

4. **Page header inside content column** — emoji icon (60px) at top,
   then page title `Daily Briefing · May 6, 2026 (Wed)` in 40px bold (localized to the user's language),
   then a row of property chips (gray):
   `🗂 Type: Daily Briefing  ·  👤 Owner: Eli  ·  📅 Created: 06:42`.

5. **Synopsis paragraph** — one sentence, italic muted:
   *"Auto-generated by Open Orbit from yesterday's Notion activity.
   12 events across 8 docs and 2 databases."*

6. **H2 section: 📝 Document changes** — list of bullet rows. Each bullet:
   `📄 [doc title]` (bold, hover-link blue), then a soft-block child
   showing `[author avatar] [author] edited "[snippet of changed text]"`
   with `· 8h ago` muted on the right.

7. **H2 section: 💬 Comments & @ mentions** — list of comment cards.
   Each card: `gray bg #F1F1EF` rounded 6px, 12px padding;
   `[avatar] [author] · in [doc title]`, then comment body in 15px
   regular, then a tiny "Reply" link.
   Highlight @-mentions with `blue text #24548A` underlined.

8. **Callout block** — required. `gray bg`, 16px padding, rounded 6px,
   left side has a 24px emoji (e.g. 🌟 or 💡). Body:
   *"Eli, you still have 3 unanswered comments from yesterday — worth a look before Wednesday's sync?"* (localized to the user's language)

9. **H2 section: 🗄 Database changes** — render as a Notion database
   table view inline.
   Columns: `Name | Status | Updated by | Updated`.
   Each cell has `gray border` 1px, slight left/right padding,
   row height ~38px. Header row uses 12px caps `text-secondary`.
   Status column uses **colored tag pills** with the green/blue/orange
   bg + text colors above (`Done` green, `In Progress` blue,
   `Triage` orange, `Backlog` gray).

10. **Toggle block** — required. Show a `▶ See 4 more changes` collapsed
    toggle that, when expanded, would reveal additional rows. Render
    it collapsed (just the chevron + label).

11. **Closing callout** — second callout at the bottom acting as a CTA:
    `🚀 Continue in Open Design →` (localized to the user's language) linked back to the OD project.

## Block formatting rules

- Heading-block hover icon (`+ ⋮⋮`) can be hinted but kept subtle.
- Use the exact Notion bullet glyph (`•`) and indentation (24px).
- Database tags must be Notion's native pill shape: 2-em radius,
  6×4 padding, 12px medium weight.
- Avatars: 18px circles with letter + Notion-style soft pastel bg.

## Implementation constraints (paired do / don't)

| Don't | Do |
|---|---|
| Borrow chrome from another connector (Material / Linear rows / GitHub pills) | Stay 100% in Notion's block primitives — H1 / H2 / bullet / callout / toggle / database table |
| Use lorem ipsum | Write real-shaped Notion copy in the user's conversation language: doc titles like `Q3 OKR`, `Onboarding Guide`, `Team Weekly`; people like Marie / Bob / Lily; comments like "This section needs your confirmation" (written in the user's conversation language) |
| Mix serif typography in body | Notion is sans only — use the system stack with emoji fallbacks |
| Render avatars as squares | Always circles, 18px with letter + Notion-style soft pastel bg |
| Add shadows or gradients | Flat surfaces only; differentiate blocks with `#E3E2E0` 1px borders or `#F1F1EF` block backgrounds |
| Use loud accent colors outside the Notion palette | Use only the documented Notion blue / green / orange / yellow tag hues |
| Replace Notion's gray callout bg with a solid color | Callouts must use `#F1F1EF` gray bg + 24px emoji on the left |
| Use placeholder doc names like "Document 1" | Use real-shaped Notion titles in the user's conversation language that read like a real workspace |
