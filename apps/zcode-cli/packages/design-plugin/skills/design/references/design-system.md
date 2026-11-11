# Design system file

A design-system file is the adopted system in machine-checkable form: what [check](check.md) lints against and what a draft names when it binds to a system. Several may live side by side in the workspace, by default `design-system/<name>.md`; when several exist, name the one a design uses.

## Format

Markdown with a `name` front matter field and four sections, each a `| Token | Value | Use |` table: `## Colors` (hex, `rgb()` or `hsl()`), `## Fonts` (a full `font-family` stack), `## Spacing` (px or rem), `## Radii`; then `## Usage`, a few lines on roles and rules (which color is the one accent, which family is display). Token names are CSS custom property names when the source has them. Keep the table layout; edit values and usage freely. JSON with the same keys (`colors`, `fonts`, `spacing`, `radii`, `usage`, each an object of token to value) is also read.

## Import

When the user asks to use a project's own system, or a workspace has styles and no design-system file yet, import with this script before designing. Do not extract tokens from source files by hand: the script resolves Tailwind themes and variables the same way every time and writes the file where later checks and drafts look for it.

```text
node "<skill-dir>/scripts/import-design-system.mjs" "<workspace>" --name "<name>" [--from "<path>"]... [--out "<file>"] [--force]
```

It reads CSS and SCSS custom properties (`:root`, `html`, `:host`; other selectors such as a dark theme become qualified tokens), the static `theme` and `theme.extend` of `tailwind.config.{js,ts,cjs,mjs}` (`colors`, `fontFamily`, `spacing`, `borderRadius`; values such as `hsl(var(--primary))` resolve through the stylesheet, and channel-only variables like `--primary: 221 83% 53%` become `hsl()`), and `<style>` blocks and inline styles of existing HTML pages, whose repeatedly used unnamed values become `literal` candidates. It skips dot-directories, `node_modules` and build output. The Tailwind config is parsed as text and never executed: functions, imports, spreads and computed values are listed under Usage as skipped. `--from` limits the sources. It writes `design-system/<name>.md`, never overwrites without `--force`, and prints the path and token counts. Then open the file, give the roles and usage real names (which color is the accent, which family is display), and drop `literal` tokens that are accidents.

Images, PDFs, slide decks, brand guides and Figma exports: read them yourself (images per the entry's evidence rule) and write the same format by hand; mark values read off an image as approximate. Never invent tokens a source does not show.

## Lint

```text
node "<skill-dir>/scripts/design-lint.mjs" "<page.html>" "<workspace>/design-system/<name>.md" [--spacing] [--json]
```

It reads `<style>` blocks, `style` attributes and SVG color attributes, and reports each color whose RGB is not a token (an alpha variant of a token passes), each primary font family missing from every stack, and with `--spacing` each margin, padding or gap length off the scale, as `file:line`, the value and the nearest token. Exit 1 means violations; exit 2 means the page or a given system file cannot be read or parsed, or the system file has no tokens under Colors, Fonts, Spacing or Radii, so a mistyped path or a wrong file never passes as clean. With the system argument omitted it only reports literal colors outside custom properties, palette size and family count. It does not judge components, hierarchy or rhythm; check those by eye.
