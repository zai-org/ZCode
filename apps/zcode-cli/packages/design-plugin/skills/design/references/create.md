# Create

Approach it as the design lead at a studio known for identities that could not be mistaken for anyone else's, for a client who has already rejected proposals that felt templated: palette, typography and layout specific to this brief. If the category alone predicts your look, restart.

If the brief does not pin down the subject, name one concrete subject and its audience and say so; distinctive choices come from that subject's own materials, instruments, artifacts and vernacular. A PRD or QA document is broken down per [interact](interact.md).

## Read before authoring

Metadata loads nothing and a failed read is not a read. Adopt, borrow, combine or depart from what you read.

1. **Skeleton** from [deck](deck.md), [app](app.md) or [page](page.md): `design-resources/design-skeletons/<name>/SKILL.md`, its `example.html` unless marked `no example`, and the files its SKILL.md names; when none fits, a specialist skill from [catalog](catalog.md).
2. **Visual system**: a workspace `design-system/<name>.md` the user picked or the project already uses (see [design-system](design-system.md)), else the user's or project's tokens, else a `self` skeleton's own, else a `design-resources/design-systems/<name>/DESIGN.md` from [catalog](catalog.md) covering `od.design_system.sections`.
3. **Craft** in `design-resources/craft/`: `typography`, `color`, `anti-ai-slop`, `accessibility-baseline`, plus what [catalog](catalog.md) attaches and `od.craft.requires`.
4. **Motion**: [references/motion.md](motion.md); decide where this design moves before writing it.

## Typefaces

Settle the faces before setting type. Skeleton examples and some design systems link theirs from Google Fonts; a linked font does not ship — the page stands alone and the audit fails an external request whatever the baseline did, so a `<link>` stripped at the end leaves the type you tuned on system-ui. Decide instead, before the first line of CSS: a stack the device already has, chosen for this subject and named in full (display, body, a CJK family when the copy needs one, a Windows fallback), or the face embedded in the file as a `data:` `@font-face` under a license that permits it. The fallback chain the craft files ask for is what actually renders, so it carries the identity.

## Principles

- The opening is specific to the subject.
- Numbering, eyebrows, dividers and labels say something true about the content. Avoid unnecessary secondary labels and descriptions; let the layout do the explaining.
- What a picture carries better than a sentence becomes one you can produce (drawn SVG, diagram, chart, the user's image or logo), never a placeholder box.
- Decide what the reader needs first; grouping, hierarchy, disclosure or a picture carry the rest. Errors, required instructions, prices, terms and consequential confirmations are never folded away.
- Write the copy yourself, specific to the subject, from the user's side of the screen.
- Match execution to the vision: maximalist needs elaborate detail, minimal needs precision.
