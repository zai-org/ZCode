# Check

Keep the direction: fix what you find, and revert a fix that worsens a measured result.

```text
node "<skill-dir>/scripts/audit.mjs" "<workspace>/page.html"
```

Run it on each HTML file and act on what it prints, its `next:` steps included (`--help` for flags). When the design follows a `design-system/<name>.md`, also run `design-lint` per [design-system](design-system.md) and fix values that come from no token. What to operate is in [deck](deck.md), [app](app.md) or [page](page.md).

Add `--baseline` with the real path of the skeleton's `example.html` or of the pre-redesign snapshot, so what that author chose is reported instead of "fixed" into compliance; omit it when there is no such file (a skeleton marked `no example`, a `self` skeleton, a review-only task). It never excuses external resources, console errors, or unreadable running copy and control labels. Inherited hits are reported, not resolved: say how many stand, so `must-fix 0` is not read as "no defects".

What no script sees, judged on the render:

- stand-ins (CSS shapes, empty boxes) for an illustration, photo or logo; images blurred, cut off or badly cropped; placeholder or wrong copy;
- a line that paraphrases the one above it, restates a chart, or labels nothing; keep accessible names, constraints, errors, prices, terms, legal links and demo-data labels;
- user assets and brand boundaries changed, licenses unverified (search results grant none), fonts missing a language used;
- long text, other languages and extreme values breaking the layout; a control that reveals detail not named for what it reveals;
- motion missing or decorative against [references/motion.md](motion.md).

The `lint-artifact` linter the craft files cite does not ship. Deliver per [SKILL.md](../SKILL.md)'s Output once must-fix is 0 (or the audit could not run and you said so), stating what is unfinished or pending.
