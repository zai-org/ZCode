<!-- Modified by ZCode: checklist updated for the frameless screen. Derived from open-design 0.7.0 (Apache-2.0); see design-resources/NOTICE.md. -->

# Mobile app checklist

Run this before emitting `<artifact>`. P0 must pass.

## P0 — must pass

- [ ] **Screen has 44px rounded corners at 390×844.** No device frame, no bezel, no Dynamic Island, no metallic rails. The screen itself is the outermost element.
- [ ] **Status bar shows real glyphs**, not text like `· · · 5G · 100%`. Use the SVG icons from the seed.
- [ ] **Home indicator is the last visible thing.** Anything below it (e.g. extra padding, accidental `<div>`) breaks the illusion.
- [ ] **Content scrolls, screen doesn't.** `<main class="content">` has `overflow-y: auto`; the surrounding `.screen` does not. The page background never moves.
- [ ] **Tap targets ≥ 44px tall.** The seed's `.btn-primary` (48px), `.tab` (~50px), `.icon-btn` (36px ≥ touch with padding), `.list-row` (≥48px with padding) all pass. Don't ship a button under 44px.
- [ ] **Body text ≥ 14px.** `--fs-body: 15px` already enforces this on most copy. List-row sub text uses 13px max — that's the floor.
- [ ] **One accent, used at most twice on the screen.** Typically: one active tab + one CTA, OR one accent card + one tab. Never three.
- [ ] **No external image URLs.** Use the `.ph-img` placeholder class. External CDN images break the OD preview iframe and look fake when they 404.
- [ ] **Tab bar matches the screen kind.** Onboarding / detail / checkout: drop the `<nav class="tabbar">` entirely. Feed / focus / profile: keep it.
- [ ] **Display headlines use `var(--font-display)` (serif).** The seed binds this via `.h1`, `.h2`, `.header h1`. Don't override headings to system-sans — it instantly looks like a stock template.
- [ ] **No emoji icons in the UI.** SVG monoline only. Emoji in copy is fine ("9:41 ☀️ Tuesday" is not, but "Sunny day in Berlin" is).
- [ ] **`data-od-id` on the screen, content, header, and any major sections.**

## P1 — should pass

- [ ] **One screen, one job.** A profile screen does profile things. Don't graft a checkout form onto a feed.
- [ ] **Caption above the screen** names the screen (e.g. "FILEBASE · INBOX"). The seed already has the slot — fill it.
- [ ] **Status bar time is `9:41`** (Apple convention) unless the brief asks otherwise.
- [ ] **Mono font for numerics** — counts, prices, durations, dates. The seed's `.num` class binds this.
- [ ] **Real, specific copy.** "Mira Hassan · CTO" beats "User Name". "$1,920" beats "$X,XXX".
- [ ] **First-screen content fits inside the 844px frame** without requiring scroll for the primary action. If the CTA is below the fold, it's the wrong layout.

## P2 — nice to have

- [ ] **Subtle accent radial gradient on the page background** (already in seed). Removing it makes the screen feel pasted onto a flat sheet.
- [ ] **Backdrop-blurred tab bar** (already in seed via `backdrop-filter`).
- [ ] **At most one image placeholder per screen.** Two placeholders on a small canvas competes for attention.
