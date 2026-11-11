# Design

This plugin helps the Agent design: it turns a request into an HTML design draft, an interactive prototype or an HTML slide deck written to the workspace, and checks the result before delivering it.

- **The `design` skill** is the single entry point. It first decides whether the request is a new design, a redesign, a color task or a visual review, then reads only the rules and design resources it needs.
- Design resources ship with the plugin: 74 design skeletons (including HTML deck templates), 23 design systems used as style references, 11 craft guides, and sub-skills such as the infinite canvas and frontend slides.

## Usage

`design` ships with ZCode and is enabled by default (it can be disabled, not uninstalled). You can say:

- "Make a landing page for a budgeting app and save it under 原型/."
- "Redesign the settings page from this screenshot, one direction."
- "Build an 8-page HTML deck for a product launch."
- "Review the visual hierarchy and accessibility of 原型/pricing.html."
- "Import the design system from this repo, then design the billing page with it."
- "Check 原型/pricing.html against design-system/harbor.md."

Once a draft is written to the workspace (the `原型/` folder by default), the reply shows an HTML preview card. In a local Desktop workspace, click it to open the built-in Browser side pane, where you can switch sizes, zoom, and add elements to the conversation. Drafts open straight from `file://` and carry a `data-zcode-design` marker; where the host has no design mode, open the file in any browser and describe changes in the conversation.

## Design systems

The skill can bind a draft to a design-system file: color, font, spacing and radius tokens plus usage notes, stored in the workspace as `design-system/<name>.md`, several side by side. `scripts/import-design-system.mjs` builds one from the project's CSS custom properties, Tailwind config (read as text, never executed) and existing HTML pages; for images or documents the Agent writes the same format by hand. Before delivery `scripts/design-lint.mjs` reports every color, font family and (optionally) spacing value in the page that is not a token, with file, line and the nearest token.

## Division with other plugins

| What you want                                | Plugin        |
| -------------------------------------------- | ------------- |
| HTML design drafts, prototypes, HTML decks   | design        |
| In-chat interactive views, mockups, variants | visualize     |
| `.pptx` files                                | presentations |

When a pptx is needed, design hands it to the presentations plugin.

## Components

| Component | Type  | Purpose                                                                         |
| --------- | ----- | ------------------------------------------------------------------------------- |
| `design`  | Skill | Design workflow entry: intake, new designs and redesigns, exploration, review and delivery |

## Network, files and side effects

- **File writes**: drafts, prototypes and decks are written to the current workspace, `原型/` by default; redesigns keep the previous version.
- **Command execution**: three Node scripts run through Bash and install nothing: the infinite-canvas adapter `scripts/adapt-canvas.mjs` writes one new workspace file; `scripts/import-design-system.mjs` reads the workspace's CSS, Tailwind config and HTML (skipping dot-directories, `node_modules` and build output) and writes `design-system/<name>.md` without overwriting; `scripts/design-lint.mjs` only reads.
- **Network**: the plugin itself sends no requests. Delivered drafts are self-contained and need no external resources. Skeleton examples reference fonts and scripts from Google Fonts, gstatic and jsdelivr, which the browser loads when an example is opened; offline, they fall back to system fonts.
- **Other plugins (optional)**: browser checks use any available browser or screenshot tool (for example the browser-use plugin), image search uses the image-search plugin, and pptx export uses the presentations plugin.
- **Image generation**: not included in this release. It returns in phase two, once account authentication for the image service is in place.
- **Session context**: a SessionStart hook (`hooks/design-rules`, POSIX sh, no Node needed) adds one sentence to the model context for every session while the plugin is enabled: load the `design` skill for HTML designs, prototypes, HTML decks and redesigns, plus the skill's base directory (about 110 bytes plus the path). The workflow itself is read only when the skill loads.
- No commands.

## Sources and licenses

The plugin code is released under Apache-2.0. The design resources include third-party open-source content, and the license texts ship with the plugin:

- Design skeletons and the resource core derive from the open-design project, MIT (`skills/design/design-resources/LICENSE.md`, `NOTICE.md`).
- The HTML deck template series, MIT (`LICENSE` in each skeleton folder and `design-resources/LICENSE-html-ppt`).
- Some sub-skills carry their own licenses, such as Apache-2.0; see each sub-skill folder.
- Design systems use third-party brands as style references and imply no affiliation; see `design-resources/design-systems/BRAND-DISCLAIMER.md`.
