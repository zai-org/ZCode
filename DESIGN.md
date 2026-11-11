# ZCode Design System

Portable design system for AI-assisted UI work in this repository.

This document is the single source of truth for design rules and token intent.
Theme values are defined in [styles.css](packages/ui/src/styles.css), including the
fallback themes and active Zai Light / Zai Dark overrides; do not maintain a separate
copy of their numeric color values in documentation.

This file is meant for coding agents. When generating or editing UI in this repo, follow this file before inventing new visual rules.

## Highest-priority UI constraint

The dedicated `text-ui-*` scale is a mandatory repository-wide constraint for application interface typography:

- UI components must use `text-ui-xl`, `text-ui-lg`, `text-ui-base`, `text-ui-caption`, `text-ui-sm`, or `text-ui-xs`.
- The shared Settings section heading may use the dedicated `text-ui-settings-title` / `lg:text-ui-settings-title-lg` role defined below.
- Do not introduce Tailwind's built-in `text-base`, `text-sm`, or `text-xs` for application UI.
- Do not introduce arbitrary UI font sizes such as `text-[13px]` or inline `font-size` values.
- The only content-level exceptions are code, Diff, and terminal rendering that consume their independent numeric font-size settings. Their surrounding controls, labels, headers, and metadata must still use `text-ui-*`.
- Mobile Web editable inputs that must prevent iOS focus zoom use the fixed `text-mobile-input-safe` compatibility token (16px). Do not use it as a general UI hierarchy token.
- Never implement interface font scaling by changing `html` or `document.documentElement.style.fontSize`; update only `--ui-font-size`.

Treat violations of this section as design-system defects, not stylistic preferences.

## Product Character

ZCode is a desktop-first and web-compatible AI workspace. The interface should feel calm, dense, and operational rather than decorative.

Design for:

- long sessions
- high information density
- readable chat and tool output
- keyboard-driven workflows
- desktop and web parity
- macOS, Windows, and Linux compatibility
- internationalization and variable text length
- light and dark themes, plus Zai variants already supported by the codebase

Avoid:

- oversized marketing-style spacing
- playful gradients as the default UI language
- bright full-surface brand fills
- ambiguous hierarchy between background, card, and popover surfaces

## Theme Modes

### Full-page desktop overlays

Login, Coding Plan upgrade, and Rewards surfaces must keep minimize, maximize/restore,
and close-window controls reachable at the top right on Windows and Linux. Reuse
`DesktopWindowControls` and the existing platform CSS variants. Keep the controls
outside scrolling content and above page decoration, with a non-draggable hit area.
The embedded website's close-page action remains separate from close-window.
macOS keeps native traffic lights; ordinary Web and mobile Web hide desktop controls.
Verify all three surfaces in both themes, including narrow windows, maximize/restore,
minimize, and close-page versus close-window behavior.

User-facing theme choices are:

- System
- Light Theme, backed by Zai Light
- Dark Theme, backed by Zai Dark

Default light and dark CSS variables still exist as fallback foundations, but new UI should be validated against Zai Light and Zai Dark as the active light/dark experiences.

## Color Palette

### Core semantic colors

- **Brand**: `--color-brand`
  Use for key emphasis, important links, active indicators, and brand-accented actions. Never use as a full-page background.
- **Icon Blue**: `--color-icon-blue`
  Use for browser-style links and blue icon emphasis that follows the Figma `icon/blue` role. Keep file-type icons on their own descriptor colors.
- **Icon Purple**: `--color-icon-purple`
  Use for Highspeed duration emphasis and other UI explicitly mapped to the Figma `icon/purple` role. Do not reuse idle-task or terminal colors directly.
- **Highspeed Composer Material**: `--color-highspeed-composer-border-idle` with `--color-highspeed-glow-*`
  Use only for an active Highspeed composer shell. Its stable surface and particle layer are defined by the dedicated Highspeed activation stylesheet and must not leak into ordinary inputs.
- **Accent Surface**: `--color-accent`
  Use for weak emphasis blocks, selected highlights, and low-intensity branded surfaces.
- **Background**: `--color-background`
  Default page and app workspace background.
- **Background Alt**: `--color-background-alt`
  Alternate page region background when the layout needs a soft separation.
- **Header / Panel / Sidebar**: `--color-header`, `--color-panel`, `--color-sidebar`
  Structural layout surfaces only. Do not reuse as generic card colors.
- **Surface**: `--color-surface`
  Low-elevation container surface.
- **Surface Hover**: `--color-surface-hover`
  Hover state for low-elevation surfaces.
- **Remote Continuity Panel**: `--color-remote-continuity-panel`, `--color-remote-continuity-panel-surface`, `--color-remote-continuity-panel-foreground`, `--color-remote-continuity-panel-subtle`
  Reserved for the first-connect local-offline / remote-running comparison. It stays dark in both themes so the handoff remains visually stable; do not reuse it as a generic dark card.
- **Card**: `--color-card`
  Standard content card background.
- **Card Selected**: `--color-card-selected`
  Selected or active card background.
- **Popover**: `--color-popover`
  Dialog, popover, and floating panel background.
- **Menu**: `--color-menu`
  Dropdown and menu surface.
- **Menu Hover**: `--color-menu-hover`
  Hover state for menu items.
- **Input**: `--color-input`
  Default editable field background.
- **Input Focused**: `--color-input-focused`
  Focused editable field background.

### Text colors

- **Text Primary**: `--color-foreground`
  Main reading text.
- **Text Secondary**: `--color-foreground-subtle`
  Metadata, descriptions, supporting labels.
- **Text Tertiary**: `--color-foreground-subtlest`
  Placeholders, weak hints, disabled-adjacent copy.
- **Text Inverse**: `--color-foreground-inverse`
  Text on dark, branded, or state-colored fills.

### Border colors

- **Desktop Resize Handle**: `--color-resize-handle` uses sky-500 in light themes and sky-400 in dark themes. Use only for desktop workspace resize indicators; retain the existing geometry and interaction states.

- **Voice Input Recording**: `--color-voice-input-surface` (sky-100 `#e0f2fe` in light themes, sky-950 `#082f49` in dark themes) and `--color-voice-input-wave` (sky-600 `#0284c7` light, sky-300 `#7dd3fc` dark). The tokens hold these hex values directly, because Tailwind 4's oklch sky palette renders slightly different colors. Use only for the composer voice input recording pill: the surface fills the pill, the wave colors the level bars and the stop square.

- **Border**: `--color-border`
  Default border and separator.
- **Border Hover**: `--color-border-hover`
  Hovered border state.
- **Card Border**: `--color-card-border`
- **Popover Border**: `--color-popover-border`
- **Input Border**: `--color-input-border`
- **Input Border Hover**: `--color-input-border-hover`
- **Input Border Focused**: `--color-input-border-focused`

### Semantic feedback colors

- **Success**: `--color-success` with `--color-success-foreground`
- **Warning**: `--color-warning` with `--color-warning-foreground`
- **Destructive**: `--color-destructive` with `--color-destructive-foreground`
- **Success surface**: `--color-success-surface` with `--color-success-surface-foreground`
- **Warning surface**: `--color-warning-surface` with `--color-warning-surface-foreground`
- **Destructive surface**: `--color-destructive-surface` with `--color-destructive-surface-foreground`
- **Idle-time task**: `--color-idle-task` with `--color-idle-task-surface`
  Use only for idle-time queue and paused tags so they remain visually distinct
  from the green scheduled-task treatment.
- **Diff Added**: `--color-diff-added` with `--color-diff-added-foreground`
- **Diff Removed**: `--color-diff-removed` with `--color-diff-removed-foreground`

Use semantic colors only for actual semantic states. Do not borrow success, warning, or destructive colors just to make a block feel louder.
Use `*-surface` for translucent state chips and banners; pair it with the matching `*-surface-foreground` and never add ad-hoc alpha in a component. Surface foreground values must preserve at least 4.5:1 contrast across shipped themes.

### Blocking interaction colors

- **Ask Interaction**: `--color-interaction-ask-surface`, `--color-interaction-ask-foreground`, `--color-interaction-ask-fill`
  Legacy compatibility surface/foreground tokens for `AskUserQuestion`; waiting badges no longer use a separate blue treatment. The ask fill is reserved for countdown progress.
- **Confirmation Interaction**: `--color-interaction-confirmation-surface`, `--color-interaction-confirmation-foreground`
  Use for all waiting badges, including `AskUserQuestion`, permission, and `ExitPlanMode`.

Waiting badges use one green confirmation treatment so identical waiting copy does not appear as different states. Do not substitute `--color-success` for a waiting confirmation.

### Workflow timeline colors

The dynamic-workflow timeline (spec: `docs/dynamic-workflow/presentation.md`) draws with a
feature-scoped token family:

- **Rule**: `--color-workflow-rule`
  Sub-hairline for repeated furniture. Weaker than `--color-border`; do not use it as a
  general separator.
- **Trace / Trace Strong**: `--color-workflow-trace`, `--color-workflow-trace-strong`
  Rail and arc stroke ramp: not yet taken vs control has passed. The marching segment
  overlays `--color-warning` dashes; there is no third stroke colour.
- **Fill frame**: a filled hole's frame is drawn in `--color-workflow-trace` (1px), and in
  `--color-warning` (1.5px) only for the two seconds after the fill joins; never a tinted
  surface (spec: `docs/dynamic-workflow/presentation.md`, "Holes on the timeline").
- Station lamps and agent pills use the semantic status colours (`--color-success`,
  `--color-warning` for running, `--color-destructive`); agent avatars use the fixed nine-color HEX palette defined in the workflow spec,
  assigned by instance index (name hash fallback), and never encode status.
- A compile-feedback row (a script that did not compile, so nothing ran) uses a hollow lamp:
  `--color-warning` while it is the latest draft, `--color-foreground-subtlest` once a newer
  draft exists. Never `--color-destructive`, which on this feature belongs to a run that errored
  (spec: `docs/dynamic-workflow/presentation.md`, "Compiler feedback").

### Overlay and utility colors

- **Toast**: `--color-toast`
  The shared toast uses `bg-toast/60` with background blur and a `rounded-2xl` shell.
  Keep stack positioning in the shared toast component; do not add per-call offsets.
- **Tooltip**: `--color-tooltip`
- **Tooltip Text**: `--color-tooltip-foreground`
- **Tooltip Tag**: `--color-tooltip-tag`
- **Tooltip Tag Text**: `--color-tooltip-tag-foreground`
- **Tag**: `--color-tag`
- **Find Highlight**: `--color-find-highlight`, `--color-find-highlight-active`
  Use only for in-page/text search result highlights. The base token marks all matches; the active token marks the currently selected match.
- **Hover**: `--color-hover`
- **Selected**: `--color-selected`
- **Primary**: `--color-primary`
- **Primary Foreground**: `--color-primary-foreground`
- **Secondary**: `--color-secondary`

### Specialized color tokens

| Token                             | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `--color-markdown-inline-code`    | Markdown 行内代码背景，沿用 tag / label 胶囊层级           |
| `--color-popover-header`          | Popover header                                             |
| `--color-tab`                     | Tab 默认背景                                               |
| `--color-tab-active`              | 当前激活 tab                                               |
| `--color-tab-border`              | Tab 分隔线                                                 |
| `--color-feedback-privacy-hint`   | 反馈截图隐私提醒文字及叹号图标；独立一行，使用辅助说明字号 |
| `--color-git-none`                | Git 无变更状态，沿用普通文件名颜色                         |
| `--color-git-modified`            | Git modified，表示已跟踪文件有未提交修改                   |
| `--color-git-added`               | Git added，表示新增文件已进入工作树 / 暂存区               |
| `--color-git-deleted`             | Git deleted，表示已跟踪文件被删除                          |
| `--color-git-renamed`             | Git renamed，表示已跟踪文件移动或重命名                    |
| `--color-git-untracked`           | Git untracked，表示 Git 尚未跟踪的新文件                   |
| `--color-git-ignored`             | Git ignored，继承弱化文本层级                              |
| `--color-git-descendant`          | Git descendant，表示目录后代包含变更                       |
| `--color-file-node`               | 文件 mention node 背景                                     |
| `--color-file-node-hover`         | 文件 mention node hover 背景                               |
| `--color-file-node-foreground`    | 文件 mention node 文字 / 图标                              |
| `--color-skill-node`              | Skill mention node 背景                                    |
| `--color-skill-node-hover`        | Skill mention node hover 背景                              |
| `--color-skill-node-foreground`   | Skill mention node 文字 / 图标                             |
| `--color-command-node`            | Command mention node 背景                                  |
| `--color-command-node-hover`      | Command mention node hover 背景                            |
| `--color-command-node-foreground` | Command mention node 文字 / 图标                           |

Git file statuses must use `text-git-*` / `bg-git-*`, rather than borrowing diff or warning tokens.
Mention tokens belong to prompt-editor and UserPrompt mention nodes; their background, hover,
and foreground roles must stay together. Markdown inline code uses its own background token,
currently mapped to `--color-tag`.

## Color Usage Rules

- Use semantic tokens, not raw one-off color values.
- Prefer `bg-background + text-foreground` for page roots.
- Prefer `bg-card` or `bg-surface` for normal content containers.
- Prefer `bg-popover` or `bg-menu` for overlays; pair with `border-popover-border` or `border-border`.
- Prefer `bg-hover` for generic hover and `bg-selected` for selection.
- Prefer `bg-primary text-primary-foreground` for the default primary button.
- Prefer text hierarchy to create information density before adding more borders or colors.
- Keep brand color usage sparse and intentional.
- Never mix `bg-background`, `bg-card`, and `bg-surface` without a clear layering reason.
- Never replace semantic tokens with ad hoc values like `text-white/60`, `border-white/10`, or arbitrary neutral alpha fills.

- `DesktopWindowFrame` uses `bg-background-alt` on macOS desktop. Windows, Linux, and Web keep `bg-background-win-alt`; child surface colors remain independent.
- Linux desktop uses a `16px` outer window-shell radius around the `12px` workspace panels and their `4px` outer inset. Keep the shell radius and compositor clip path equal; maximized windows use `0px`.

### Lucide 前景透明度

- Lucide 的次级、三级前景使用不透明描边绘制完整图标，再整体与背景混合，避免多条路径交点加深。次级为 60%，三级浅色为 40%、深色为 30%。
- 保留现有 `text-foreground-subtle` / `text-foreground-subtlest` 调用；同时支持颜色类直接位于图标和从父元素继承。文字继续使用原有半透明颜色。
- 颜色 utility 的 hover、group-hover、focus、disabled 和 data 状态应同步图标层级；子元素显式使用其他颜色时清除继承的弱化层级。已有 `opacity-*` 继续独立叠加，`opacity-0` 仍隐藏图标。
- 本次适配范围为 Tailwind 颜色 utility；自定义 CSS / inline 的颜色与滤镜不作为层级入口，不全局改写非 Lucide SVG。标准 Lucide 的 `stroke="currentColor"` 是适配入口。
- 支持普通百分比颜色修饰符（如 `/50`）以及 `fill-current` 的实心图标。不支持相对颜色语法的浏览器保留原始绘制方式。
- 验收：390px / 1200px、Zai Light / Zai Dark，分别检查页面、面板和彩色背景上的直接/继承颜色、交点与非交点像素一致、文字颜色不变、交互颜色覆盖和额外透明度。

## Typography

### Font families

- **UI Sans**: use the app's default `font-sans` stack for almost all interface text.
- **UI Mono**: use `font-mono` for paths, commands, code, identifiers, shortcuts, commit hashes, model IDs, and terminal-like data.

### UI font tokens

Each `text-ui-*` utility maps to the corresponding `--text-ui-*` CSS token.

All interface typography must use the dedicated `text-ui-*` scale. The Appearance setting controls `--ui-font-size`, whose default is `14px`:

| Token             | Formula                | Default |
| ----------------- | ---------------------- | ------: |
| `text-ui-xl`      | `--ui-font-size + 4px` |    18px |
| `text-ui-lg`      | `--ui-font-size + 2px` |    16px |
| `text-ui-base`    | `--ui-font-size`       |    14px |
| `text-ui-caption` | `--ui-font-size - 1px` |    13px |
| `text-ui-sm`      | `--ui-font-size - 2px` |    12px |
| `text-ui-xs`      | `--ui-font-size - 4px` |    10px |
| `text-ui-2xs`     | `--ui-font-size - 5px` |     9px |

`text-ui-2xs` is a restricted exception below the `text-ui-xs` floor: it is permitted
only for graph **axis furniture** — timebase tick labels, channel codes, and unit
suffixes in the workflow timeline — never for content, labels, or metadata.
Treat any other use as a design-system defect.

The shared Settings section heading uses `text-ui-settings-title` with
`lg:text-ui-settings-title-lg`: `--ui-font-size + 10px` / `+ 16px` (24px / 30px
at the default setting), with line-height ratios of `4 / 3` / `1.2` (32px / 36px
by default). These tokens preserve the larger responsive heading while following
the interface font setting. They are reserved for this page heading; ordinary
section titles and controls retain the standard scale.

`text-mobile-input-safe` is a fixed 16px platform-compatibility token. It is
reserved for editable controls on mobile Web surfaces where iOS focus zoom must
be prevented, and therefore does not scale with `--ui-font-size`.

- Changing the interface font size updates only `--ui-font-size`; never mutate the root `html` font size.
- Icons, spacing, radii, and other `rem`-based geometry must not scale with the interface font setting.
- Code, Diff, and terminal content retain their independent font-size settings; only their surrounding interface controls use `text-ui-*`.
- Mobile Web inputs that require the iOS 16px focus-zoom floor use `text-mobile-input-safe`.

### Type roles

The `text-ui-*` scale expresses stable semantic roles. Choose a token by content role rather than by isolated visual preference:

| Token             | Primary roles                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `text-ui-xl`      | Markdown `h1` and equivalent first-level reading headings                                                    |
| `text-ui-lg`      | Markdown `h2` and equivalent second-level reading headings                                                   |
| `text-ui-base`    | Markdown `h3`-`h6`, body copy, common buttons, workspace and section titles, and other primary UI text       |
| `text-ui-caption` | Compact supporting copy that must remain one step below body text, such as the New Task feature announcement |
| `text-ui-sm`      | Secondary copy, supporting information, helper text, Tooltip copy, and Markdown inline code                  |
| `text-ui-xs`      | Tooltip keyboard shortcuts, badges, compact labels, counters, and very weak metadata                         |

- Markdown `h3`-`h6` share `text-ui-base`; distinguish their hierarchy through weight: `h3`-`h4` use `font-semibold`, `h5` uses `font-medium`, and `h6` uses `font-normal`.
- Body copy and common controls normally use `text-ui-base font-normal`; titles and labels may strengthen weight without changing their semantic size role.
- Pair secondary copy with an appropriate semantic color, usually `text-foreground-subtle`. Pair weak metadata with `text-foreground-subtlest`. Font size and color hierarchy are independent decisions.
- **Tooltip**: titles, plain descriptions, and log content use `text-ui-sm`; keyboard shortcut labels use `text-ui-xs`. Rich content such as Markdown release notes keeps its content typography hierarchy instead of flattening headings and links to the Tooltip copy size.
- **Code / Command / Path**: use `font-mono`, usually with `text-ui-base`; Markdown inline code uses `text-ui-sm`.
- When migrating a legacy explicit `13px` UI size without a deliberate compact-caption role, use `text-ui-base`. Use `text-ui-caption` only where the product explicitly requires a stable one-step-below-body caption treatment. Do not collapse either into `text-ui-xs`; `text-ui-xs` is reserved for badge-scale and very weak metadata roles.

### Markdown type scale

Markdown rendered through the shared assistant response uses a reading-oriented hierarchy while the surrounding operational UI remains compact:

- **User and assistant message containers**: `text-ui-base`
- **Body**: `text-ui-base`
- **Links**: `text-ui-base`
- **Inline code**: `font-mono text-ui-sm`
- **Code block body**: default `14px`, configurable through code preview settings
- **Code block header**: `text-ui-base`
- **Tables**: `text-ui-base`
- **h1**: `text-ui-xl`
- **h2**: `text-ui-lg`
- **h3**: `text-ui-base`
- **h4**: `text-ui-base`
- **h5**: `text-ui-base`
- **h6**: `text-ui-base`

### Typography rules

- Keep UI text compact and readable.
- Prefer `font-medium` for headings and labels; avoid heavy weights unless there is a strong reason.
- Use monospace only where the content is inherently technical.
- Use `text-ui-base` as the default compact app text size. Keep `text-ui-base` for workspace titles and stronger title treatments.
- Respect i18n expansion. Do not hard-code layouts that only work for short English labels.
- Do not depend on tight truncation as the only way a component survives translation.

## Spacing

Base spacing unit is `4px`.

Recommended rhythm:

- `4px`: tight icon/text spacing
- `8px`: compact control padding and inline gaps
- `12px`: dense list items and menu rows
- `16px`: standard card and panel padding
- `20px` to `24px`: larger sections or dialog interiors

Spacing rules:

- Keep dense operational UI compact by default.
- Prefer a small set of repeated gaps and paddings instead of arbitrary values.
- In flex layouts with text, add `min-w-0` where truncation or shrink is required.
- In nested scroll or split-panel layouts, add `min-h-0` where scrolling must be allowed.
- Prefer `w-full + max-w-*` over hard-coded widths when possible.

## Radius

Radius follows the nesting of visible rounded containers, not component importance or layout depth. These rules are the target specification; existing component defaults may still need migration.

### Container hierarchy

- Layout regions, ordinary wrappers, groups, and separators do not count as radius levels.
- The first rounded container starts at `rounded-xl`, whether inside or outside a layout region.
- Nested rounded containers step down through `rounded-lg` → `rounded-md` → `rounded-sm`; `rounded-sm` is the minimum.
- Count the nearest actual rounded container, not intermediate DOM wrappers. Peer containers at the same level use the same radius.
- Cards, chat bubbles, tool blocks, and ordinary composite input shells follow this hierarchy; size or importance alone does not justify `rounded-2xl`.

### Approved 2xl exceptions

The following explicit exceptions may retain `rounded-2xl`; do not extend them to other components based only on size or importance:

- **Main chat input shell**: the actual `ChatPromptEditor` input shell may use `rounded-2xl`. Its drag overlay matches the shell because it covers the same surface, rather than introducing a nested container.
- **Conversation status floating panel**: the shared shell may retain `rounded-2xl` across collapsed and expanded presentations.
- **Side Pane full-view floating composer**: in Side Pane full view the main chat input shell floats on its own (no outer frame); the drawer that slides out from behind it and the answer bubble shown above it use `rounded-2xl` to match the shell; the minimized state and the answer bubble's close button are deliberate circles (`rounded-full`).
- **Toast**: the independent notification shell may retain `rounded-2xl`.
- **Brand icon backplates**: welcome-screen brand art and plugin-detail icons may retain `rounded-2xl` as part of their icon shape. This is not a general exception for icon buttons or content cards.

The main composer region, including its context-header layout wrapper, is layout and does not count as a radius level. Its existing decorative radius does not force the actual input shell down a level. This classification alone does not prescribe changing the layout wrapper's decorative radius.

These exceptions do not automatically grant `2xl` to nested controls or content containers. Basic controls still use the table below. Dialog shells follow their separate rules.

### Basic controls

Buttons, menu trigger buttons, ordinary Input, Textarea, and Select triggers default to `rounded-lg`. Adjust them according to the nearest rounded parent container:

| Nearest rounded parent          | Control radius |
| ------------------------------- | -------------- |
| None, or `rounded-xl` and above | `rounded-lg`   |
| `rounded-lg`                    | `rounded-md`   |
| `rounded-md` / `rounded-sm`     | `rounded-sm`   |

Control size and primary/secondary action emphasis do not independently change radius.

### Dialogs

- Dialog shells, including alert and confirmation dialogs, use `rounded-2xl`.
- Only chat attachment preview, feedback screenshot preview, and CUA screenshot preview dialogs keep `rounded-xl` shells.
- The dialog shell does not count toward its content hierarchy. The first rounded content container starts again at `rounded-xl`, followed by `rounded-lg` → `rounded-md` → `rounded-sm`.
- Basic controls inside dialogs follow the control table; a layout wrapper does not introduce an extra level.

### Menus and selection overlays

- Dropdown menus, context menus, Select expanded panels, and similar option/action overlays use `rounded-lg` shells. This includes the main input's `@` / `/` suggestion panel; it does not inherit the main-input exception.
- Menu items and option hover/selected backgrounds use `rounded-md`.
- Rounded containers or controls nested inside an option use `rounded-sm`.
- Each submenu is an independent overlay: its shell restarts at `rounded-lg`, and its options use `rounded-md`.
- Overlay radius does not inherit the trigger's parent hierarchy. Triggers themselves follow the basic-control table.
- Other standalone popover containers follow the ordinary container hierarchy, starting at `rounded-xl`.

### Shape exceptions and consistency

- `rounded-full` is reserved exclusively for deliberate pill shapes or circles.
- Buttons, tags, counters, and icon buttons do not qualify for `rounded-full` merely because of their component type.
- Do not introduce arbitrary radius values or use the ambiguous bare `rounded` utility.
- Use `rounded-none` or side-specific radius removal only where joined surfaces must form a continuous shape.
- Apply the same rules on desktop and mobile Web, across platforms and themes.

## Sizing

### Common size baselines

- **Icon sizes**: `size-3`, `size-3.5`, `size-4`, `size-5`, `size-6`
- **Control heights**: `h-6`, `h-7`, `h-8`, `h-9`
- **Square icon buttons**: `size-6`, `size-7`, `size-8`, `size-9`

### Sizing rules

- `size-4` is the default UI icon baseline.
- Reuse existing button sizes instead of creating new height systems.
- Prefer fluid widths for content containers.
- Fixed widths are acceptable for menus, popovers, dialogs, and stable side panels.
- Avoid arbitrary `w-[...]` and `h-[...]` for ordinary business UI.
- Prefer the shared Button `size` variants, including `icon*`, over separate width/height overrides. The current variants are `default(h-7)`, `xs(h-5)`, `sm(h-6)`, and `lg(h-8)`; generic control baselines do not replace those component contracts.
- Regular inputs prefer `h-9`; compact filters and inline inputs may use `h-7` or `h-8`.
- Use `w-full`, `w-fit`, `max-w-full`, and `min-w-0` for content widths. Fixed overlays may use `w-52`, `w-64`, `w-80`, or `max-w-sm/md/lg/xl` when a stable width is required.
- Page roots use `h-full` or `min-h-screen`. Nested scroll and preview containers need `min-h-0` and `min-w-0` as appropriate; `overflow-auto` alone does not establish a shrinkable flex region.
- Prefer `max-h-*` to a fixed height for scrollable content. Do not combine `size-*` with conflicting `w-*` / `h-*` unless a non-square shape is deliberate.

## Components

### Buttons

Preferred button system matches `packages/ui/src/components/ui/button.tsx`.

- **Primary**: `bg-primary text-primary-foreground`
- **Outline**: border-based, neutral surface, subtle hover
- **Secondary**: `bg-secondary text-foreground`
- **Ghost**: transparent until hover
- **Destructive**: semantic destructive fill
- **Link**: text-only with underline on hover

Preferred sizes:

- `xs`: very compact controls
- `default`: most action buttons
- `sm`: compact buttons in dense lists
- `lg`: higher-emphasis buttons
- `icon-*`: icon-only actions

Button rules:

- Use existing button variants first.
- Keep icon-only buttons square.
- Do not promote every action to primary.
- Preserve a clear action hierarchy within each panel.

### Inputs

- Default to `bg-input border-input-border text-foreground`
- Hover with `border-input-border-hover`
- Focus with `border-input-border-focused` and `bg-input-focused`
- Normal form fields default to `rounded-lg`, stepping down according to the nearest rounded parent in the Radius rules.
- Ordinary composite input shells follow the container hierarchy, starting at `rounded-xl`; the main chat input shell is an approved `rounded-2xl` exception.

Input rules:

- Inputs should feel calm and integrated, not glowing by default.
- Use semantic error state styling only for real validation problems.
- Do not style ordinary inputs like cards.

### Cards and Panels

- Standard cards use `bg-card border-card-border`; radius follows the container hierarchy, starting at `rounded-xl`.
- Low-emphasis containers use `bg-surface`
- Selected cards may use `bg-card-selected`
- Main content cards usually use `16px` horizontal padding and compact text

Card rules:

- Cards should clearly sit above the page background but below overlays.
- Keep card surfaces quieter than overlays.
- Avoid mixing multiple card background styles in the same view unless they encode real hierarchy.

### Menus, Popovers, Dialogs

- Menus use `bg-menu`, compact rows, `rounded-lg`, and `shadow-md`
- Menus use `border border-popover-border` and typically `p-1`
- Dropdown menus, context menus, and select popovers should share the same menu surface language
- Adjacent option rows in dropdown menus, context menus, and select popovers use a fixed `2px` vertical gap (`gap-0.5`) at the shared option-stack layer
- Popovers and dialogs use `bg-popover` and `border-popover-border`. Ordinary standalone popovers start at `rounded-xl`; dialogs use `rounded-2xl` except the three preview exceptions in the Radius rules.
- Toasts use `bg-toast`, compact padding, and stronger shadow

Overlay rules:

- Floating UI should feel precise and compact.
- Interactive overlays such as dropdown menus, context menus, selects, and popovers must render above passive tooltips when both are open. Tooltips must never cover options or controls in an active interactive overlay.
- Dropdown menu surfaces must keep their overlay shadow from the first open frame through keyboard focus and pointer hover. Global focus-reset rules must not clear the menu shadow while the content root owns focus.
- Keep menu rows dense and highly scannable.
- Avoid giant popovers with loose spacing unless the task genuinely needs it.
- Do not style menus like cards or reuse `bg-card` / `bg-surface` for ordinary menu content.
- Menu items should read as compact action rows, not miniature buttons.
- Prefer stable item baselines such as compact height, `rounded-md`, `px-2`, `gap-2`, and `text-ui-base`.
- Use subtle hover states such as `bg-menu-hover`; avoid strong fills or per-row borders for normal menu items.
- Disabled items should keep their layout and hierarchy, and usually only drop to a weaker text color.
- Prefer weak separators and ordering to group actions; avoid building menus as stacked sub-cards.
- Reuse the same action-list content across dropdown and context-menu entry points when the action set is the same.
- For selected items, prefer checkmarks, radio indicators, or trailing state markers over strong full-row selection fills.
- Composite triggers with a primary action and a chevron should use a segmented shell: main action on the left, menu reveal on the right.
- Select triggers should continue to follow input-style semantics even when their expanded surface matches menu styling.
- Standard dropdown menus should usually align to the trigger's leading edge unless the trigger sits on the trailing side of a layout.
- Use end alignment when it helps menus open back toward the main content area or prevents edge crowding.
- Context menus should prioritize pointer context and appear near the interaction point rather than mimicking button anchoring.
- Select popovers should preserve a stable relationship with the trigger width and edges whenever practical.
- Keep menu offset small and consistent so the menu feels attached to its trigger while leaving enough room for border and shadow separation.
- Increase offset only when needed to avoid border collision, shadow merging, or layout crowding.

### Tabs and Selection States

- Default inactive tabs remain neutral
- Active tabs use a stronger surface contrast, not brand-fill blocks
- Use `bg-selected` for selected list rows or tabs when appropriate

### Chat, Tooling, and Developer UI

- Chat bubbles follow the container hierarchy, starting at `rounded-xl`. Main chat input shells may retain `rounded-2xl` under the approved exception.
- Tool output, terminal-like blocks, paths, hashes, and commands should bias toward monospace
- Diff UI must use diff-specific semantic colors, not generic success/destructive colors
- Dense operational panels are preferred over marketing-card styling

### Extension slots

Extension slots are shell-owned positions where extensions supply data only (spec: `docs/plugins/extension-host.md` §6, §16). The shell component owns all styling; a plugin never provides HTML, SVG, or CSS for a slot. Slot ids come only from `EXTENSION_SLOTS` in the extension host protocol. Slot items are static manifest declarations (top-level `slots`) and stay visible while the extension host is stopped.

- **`composer.status`**: sits directly left of the context-usage ring in the composer toolbar. Ghost `Button` at `size="default"` (`h-7`), `rounded-lg`, `px-1.5`, `gap-1`; a `size-3.5` icon plus text in `text-ui-sm text-foreground-subtle tabular-nums`, capped at `max-w-40` with truncation. The hover description uses `ControlHintTooltip`. It renders only when the extension has set `text`. It is the first item to collapse: collapse tier `extension` hides the text and leaves a `size-7` icon button.
- **Side pane launcher "Extensions" section**: follows the built-in apps and UI plugins in the new-tab launcher, after the same short divider, with a `text-ui-lg font-semibold` heading. Rows reuse `SidePaneLauncherRow`. Problem rows (`failed`, `invalid`, `incompatible`, and a plugin with an unusable slot item, labelled `invalid`) are static rows without a button or capsule, one per plugin: `CircleAlertIcon`, the plugin name, a `bg-tag` state label, and the reason in the hover title (with the field path when there is one). The "Extensions stopped" row uses `OctagonXIcon` and the secondary "Reload" capsule. Rows do not use destructive or warning fills; the state label carries the meaning as text.
- **Launcher view items**: `sidePane.launcher` items are ordinary `SidePaneLauncherRow` rows in the same section (whitelisted icon, localized view title, the plugin name as the description, the default "Open" capsule). While the extension host is stopped they stay visible: a `bg-tag` "Extensions stopped" label precedes the plugin name and the capsule becomes "Reload". No disabled or destructive styling.
- **Extension view tabs**: an `extension-view` side pane tab uses the standard tab trigger with the view's whitelisted icon and its localized title. The body is the plugin's MCP App page in the shared sandbox; the shell only draws the loading, "not running" and error states as centered `text-ui-sm text-foreground-subtle` text. Theme and locale reach the page through the MCP Apps host context (style variables), not through shell CSS.
- **Extension logs tab**: one `extension-logs` side pane tab per pane (`ScrollTextIcon`, title "Extension logs"), opened from an "Extension logs" `SidePaneLauncherRow` in the launcher "Extensions" section (shown only when a plugin declares `extension` or the host is stopped) and from the command center. A single `border-b` toolbar row (`px-3 py-2`, wraps when narrow): two input-style `Select` filters (source: all, extension host, each plugin id in `font-mono`; level: all, warnings and errors, errors only) on the left; `icon-md` ghost buttons with `ControlHintTooltip` on the right for auto-scroll (`secondary` + `aria-pressed` while on), copy and clear view. Rows are terminal-style `font-mono text-ui-sm` lines: time (`text-foreground-subtlest tabular-nums`), the level word padded to five characters, the source (`text-foreground-subtle`, plugin id or "Extension host gen=N"), then the message, all as one wrapping run (`whitespace-pre-wrap break-words`) with a hanging indent (`pl-9 -indent-6`) so continuation lines use the full width. Warning and error rows use `bg-warning-surface` / `bg-destructive-surface` with the matching `*-surface-foreground` level word; info rows have no fill. Empty, loading and "no match" states are centered `text-ui-sm text-foreground-subtle` text.
- **`nav.primary`**: rows in the left primary navigation, directly after "Plugin store", one per plugin, sorted by the localized title. Each row is the same ghost `Button` as the built-in rows (`size="lg"`, `w-full justify-start gap-2`) with a `size-4` whitelisted icon and the title truncated in one line. Rows have no selected state (no `aria-pressed`, no `bg-selected`): a click opens the target in the right Side Pane and the main view stays the conversation. A view-target row while the extension host is stopped keeps its title and adds a short `bg-tag` "Stopped" label plus a trailing `text-ui-sm text-foreground-subtle` "Reload"; the hover hint and accessible name carry the full "Extensions stopped · Reload"; the click reloads. The row is narrow, so it uses the short label to keep the title readable. Surface-target (MCP App) rows never show the stopped state. An extension can set an unread badge (spec §18.1 H11): a count renders after the title as the same `bg-tag` label (`text-ui-xs tabular-nums`, `99+` above 99), and `"dot"` renders the task list unread dot (`size-[7px] rounded-full bg-icon-blue`); the accessible name appends "N unread" or "New activity". Hidden in phone remote control, like "Automations" and "Plugin store".
- **File viewer tabs**: a `file.viewer` view opens as a regular `extension-view` tab per file; the tab title is the file name and the icon is the view's whitelisted icon. A `file.viewer` surface opens as a regular `plugin-ui` tab per file. No extra chrome; the page draws the file.
- **`composer.mention`**: one group per entry in the composer `@` panel, after the built-in groups. The group header (the entry title) is always shown, even when it is the only visible group. Candidate rows use the skills row density: a `size-3.5` whitelisted icon, the label in `text-ui-base font-medium` (truncated at half the row), the description in `text-ui-xs text-foreground-subtlest`. Loading reuses the panel's skeleton rows; a denied or failed query and "Extensions stopped" reuse the panel's error status row, one line inside the group, so other groups stay usable. A chosen candidate becomes a mention chip in the plugin colour (`text-plugin-node-foreground`) with the generic plugin icon; it serializes to the candidate's `insertText`.
- **Extension permissions** (spec §17.7): the launcher "Extensions" section shows one "Needs permission" row per plugin whose declared session tiers are not granted yet, right after the "Extensions stopped" row: a `SidePaneLauncherRow` with `KeyRoundIcon`, the plugin name, a `bg-tag` "Needs permission" label, the requested tiers as the description, and a "Grant" capsule that opens the consent dialog. The consent dialog and the enable confirmation reuse the shared `ConfirmDialog` (title names the plugin, the spec text is the description, default confirm button, no keyboard hints); no custom dialog chrome. The plugin details page shows a "Permissions" section after "Information" when the plugin declares or holds tiers: the same `border-b` heading as "Information", a `bg-tag` status label with the tiers, a primary "Grant" or an outline "Revoke" button at `size="sm"`, a one-line `text-ui-sm text-foreground-subtle` note, a "System notifications" row when the notifications tier is granted (spec §18.1 H8: `text-ui-base` label, `text-ui-sm text-foreground-subtle` note under it, the shared default-size `Switch` at the row end, on by default), and "Recent actions" rows in the information grid (`grid-cols-[8rem_minmax(0,1fr)]`, time in `tabular-nums text-foreground-subtle`). No destructive or warning fills. Desktop only.
- **Icons**: only Lucide names in the extension icon whitelist render (`packages/ui/src/extension-slots/components/extensionIcons.ts`); any other name falls back to `PuzzleIcon`. The whitelist: `activity`, `bell`, `bot`, `chart-bar`, `chart-pie` (alias `pie-chart`), `clock`, `cpu`, `database`, `eye`, `file-text`, `gauge`, `git-branch`, `git-merge`, `git-pull-request`, `globe`, `info`, `layers`, `list`, `log-in`, `log-out`, `message-square`, `puzzle`, `sparkles`, `terminal`, `timer`, `zap`. Add a name in both places; a whitelisted icon uses the same size and `currentColor` as the built-in icons of that slot.
- **Scope**: desktop only. Web and phone remote control render no slot. Verify in Zai Light and Zai Dark, zh-CN and en-US, at narrow toolbar widths where the composer slot collapses first, and with long navigation titles that must truncate.

## Elevation and Depth

ZCode should use restrained depth. Layer primarily through background contrast, borders, and radius before relying on heavy shadows.

Recommended elevation levels:

- **Base**: no shadow, structure comes from background contrast
- **Surface**: very subtle border-led separation
- **Overlay**: `shadow-md` for menus, popovers, dialogs
- **Attention**: `shadow-lg` only for toast, important floating cards, or rare emphasized panels

Depth rules:

- Do not rely on large soft shadows for ordinary layout.
- Menus and dialogs can feel elevated, but still compact and controlled.
- Background layering is usually more important than shadow strength.

## Motion

- Keep transitions fast and low-drama.
- Favor subtle fade, zoom, and directional slide for overlays.
- Motion should clarify state change, not decorate the screen.
- Avoid long, springy, or playful animations in the main workspace.

## Workspace layout

Desktop and wide Web workspace content uses independent conversation, bottom terminal, and Side Pane frames. The conversation frame contains WorkspaceHeader and conversation; the optional terminal has its own frame below it, and Side Pane owns its tab bar. Frames use their own background and border, with 4px resizable gaps matching the macOS outer inset. Resize handles keep a transparent 4px hit area and show a 2px tertiary foreground (`foreground-subtlest/50`) line on hover, focus or drag. The indicator extends along the panel edge, inset by the panel radius at both ends, with rounded ends and no mask. Layout frames do not count toward content radius levels. Mobile remote control retains its single-column and drawer presentation. See [workspace independent panels](docs/design/workspace-independent-panels.md) for platform chrome and persistence boundaries.

## Responsive Behavior

The product is desktop-first, but UI must remain functional on smaller screens.

Rules:

- Start with a stable base layout, then enhance with breakpoints.
- Use breakpoints mainly for layout, width, visibility, and density changes.
- Do not change the semantic meaning of components across breakpoints.
- Prefer changing `max-width`, `grid`, `flex`, and visibility over changing component identity.
- Preserve primary actions at all breakpoints; do not hide core workflows behind desktop-only affordances.

### Breakpoint roles

| Breakpoint     | Preferred use                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sm:`          | Dialog width, button arrangement, small-screen layout corrections                                                                                                                                                                            |
| `md:`          | Grid columns and form layout expansion                                                                                                                                                                                                       |
| `lg:`          | Desktop toolbar visibility and secondary information density                                                                                                                                                                                 |
| `xl:`          | Chat and complex content arrangements                                                                                                                                                                                                        |
| `2xl:`         | Wide-screen reading-width caps, not ordinary page behavior                                                                                                                                                                                   |
| `compact-web:` | Phone and narrow Web (`< 40rem` without a desktop platform class) layout corrections that must not change narrow desktop windows; CSS only, do not copy its condition into JS (see [settings narrow layout](docs/settings-narrow-layout.md)) |

Start with the unprefixed layout, then add the fewest breakpoints needed. Prefer changing
layout, `max-width`, and visibility to repeatedly switching fixed dimensions or semantic
colors, borders, and radii. Keep essential actions available below desktop breakpoints.
Dialogs should reuse patterns such as `sm:max-w-*`; grids grow from one column rather
than starting desktop-wide and being repeatedly reduced. Fix unstable base layout before
adding breakpoint overrides.

## Accessibility and Internationalization

- Support keyboard navigation as a first-class interaction path.
- Preserve the repo's established component focus styling. Do not add a shared `!important` outline to dialog descendants, remote controls, or settings navigation. Composite inputs use their existing outer border or ring without an additional inner outline. This also applies in forced-colors mode; test IDs are not styling contracts.
- Ensure contrast remains safe in light, dark, and Zai modes.
- Write layouts that tolerate longer translations.
- Avoid icon-only meaning when a text label is practical.
- Use semantic status colors together with readable text, never by color alone.

## Implementation Guidance

- Reuse existing semantic Tailwind utilities before adding new tokens.
- Reuse component primitives in `packages/ui/src/components/ui/` before inventing one-off variants.
- Match current density and component proportions already established in the repo.
- If a new UI need appears, first decide whether it belongs to structure, surface, interaction, or state. Then choose tokens accordingly.
- When in doubt, prefer quieter UI and stronger information hierarchy.

## Do

- use semantic color tokens consistently
- preserve the distinction between page background, card, and overlay surfaces
- keep controls compact and operational
- use text hierarchy to express density
- use monospace for technical values and command-like content
- support all shipped themes
- design for desktop, web, and cross-platform rendering constraints
- account for localization and long labels

## Don't

- use raw one-off colors in ordinary UI work
- fill large surfaces with brand color
- add arbitrary radii, shadows, widths, or heights without a stable system reason
- make menus and dialogs airy when they should be dense
- use semantic error or success colors for non-semantic decoration
- create components that only look correct in one theme
- trade clarity for visual novelty in tool-heavy screens

## Remote connection progress (RDUX-03)

`--color-progress-surface` / `--color-progress-surface-foreground` express work in progress, including connecting, automatic recovery and updating. Use `bg-progress-surface` with `text-progress-surface-foreground`; the foreground can also color progress indicators and borders. Four themes define the pair and all parent backgrounds must retain a 4.5:1 text contrast.

Remote state mapping: connected → success (neutral cloud in project rows); connecting/updating → progress; disconnected → neutral surface/subtle foreground; needs attention → warning; failed → destructive. SSH/WSL/Docker tokens are reserved for connection type labels, never connection status. Always include visible status text outside the connected state; recovery attempts are visible text. See the remote device UX specification for the authoritative mapping and glossary.

远程可读辅助文字：`--color-remote-foreground-muted` / `text-remote-foreground-muted` 用于远程向导、设备卡和日志辅助文字、侧栏设备标签与设置导航；侧栏共享的任务/项目视图切换、分组操作及搜索快捷键也沿用此可读辅助文字等级，浅色 `#595959`、深色 `#b3b3b3`，在 sidebar / popover / surface / card / selected / background 上保持至少 4.5:1。Zai Light SSH 类型标签前景为 `#0867ce`，保持与 `#ebf4ff` 底色至少 4.5:1。
