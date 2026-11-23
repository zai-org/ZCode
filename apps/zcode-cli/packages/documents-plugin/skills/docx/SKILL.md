---
name: docx
metadata:
  author: Z.AI
  version: "1.1"
description: "Complete DOCX document creation, editing, and analysis capabilities with support for revisions, comments, formatting preservation, and text extraction. Also handles Word format conversion: legacy .doc → .docx, DOCX → PDF, DOCX → images (PNG/JPG) for visual review or previews, and DOCX → Markdown/plain text extraction. Use for creating new documents, modifying content, handling revisions, adding comments, other professional Word document tasks, or when the user asks to convert, export, or render a Word document to another format (e.g. 'Word转PDF', 'doc转docx', 'export this docx as PDF/images')."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX Creation, Editing, and Analysis

## LibreOffice preflight

Before the first Python command, if neither `zcode-python` nor a system Python is available, follow [Python setup](env_setup/setup.md#python-interpreter-selection). On desktop, report that preinstalled Python is not ready or is disabled and let the user choose waiting, enabling it, or system installation. The same setup guide covers a selected preinstalled interpreter or package installation failure.

Set `DOCX_SKILL_DIR` to this Skill's returned base directory. Run `"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check` before a conversion or recalculation.
The [launcher contract](../../scripts/README.md) defines managed/system lookup, isolated profiles and failure handling. Report a managed failure and use any available system version. If neither is usable on desktop, preserve completed files and let the user choose waiting or Agent installation using [setup guidance](env_setup/libreoffice-unmanaged.md). The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance. Keep using the unified launcher after installation so later managed readiness takes priority. Other dependency setup remains unchanged.

## Quick Setup

```bash
bash "$SKILL_DIR/setup.sh"    # Interactive environment check + install
```

> **Local-font-first.** Inspect fonts available in the user's local environment and prefer a suitable
> installed font. Use bundled or downloaded fonts only as fallbacks; do not install fonts without the
> user's confirmation.

## Overview

A .docx file is a ZIP archive containing XML files. This skill provides tools for creating, editing, reading, and reviewing Word documents.

### Original File Preserved

User-provided input files are read-only by default. Deliverables go to new files
(`<stem>_updated.docx` next to the input); edit an original in place only when the user explicitly
asks — and then copy it to `<stem>_backup.docx` next to it (never `/tmp`) first. See
`routes/edit.md` for the full workflow.

## Quick Route — Read This First

**Step 1**: Determine task type → load the corresponding route file
**Step 2**: Determine business scene → load the corresponding scene file (if applicable)
**Step 3**: Load `references/design-system.md` for cover recipes, palettes, and chart colors
**Step 4**: Load `references/common-rules.md` for shared layout, font, and quality rules
**Step 5**: Execute per route instructions
**Step 6**: Run the post-generation checklist

⚠️ **MANDATORY — Cover Recipe Enforcement (Step 3):**
When creating a document that needs a cover page, you MUST use one of the 7 validated cover recipes (R1–R7) from `design-system.md`. **Free-form cover code is FORBIDDEN.** The recipe provides the wrapper table, background, layout structure, border settings, and spacing — do not reinvent any of these.

Workflow: (1) Call `selectCoverRecipe(docType, industry)` to get recipe + palette → (2) Use the corresponding `buildCoverRX()` function code from `design-system.md` → (3) Pass your `config` (title, subtitle, metaLines, etc.) into the recipe builder. If you skip this and write cover code from scratch, the cover WILL have compatibility issues (blank pages in MS Office, missing borders, overflow, etc.).

### Script Path Setup (MANDATORY before any script call)

All CLI tools live in `scripts/` relative to this skill's directory. Before calling any script, resolve the absolute path once:

```bash
DOCX_SCRIPTS="<skill_directory>/scripts"   # ← parent directory of this SKILL.md

# Then all commands use $DOCX_SCRIPTS:
"$(command -v zcode-python || command -v python3)" "$DOCX_SCRIPTS/postcheck.py" output.docx
"$(command -v zcode-python || command -v python3)" "$DOCX_SCRIPTS/add_toc_placeholders.py" output.docx --auto
```

**For Python imports** (when generation code needs to import skill modules):

```python
import sys, os
DOCX_SCRIPTS = os.path.join("<skill_directory>", "scripts")
if DOCX_SCRIPTS not in sys.path:
    sys.path.insert(0, DOCX_SCRIPTS)
```

Launch scripts through `"$(command -v zcode-python || command -v python3)"` and the absolute `$DOCX_SCRIPTS` path so the command works from any working directory.

### Task Router

| User Intent | Route | Files to Load |
|-------------|-------|---------------|
| Create/write/generate (no attachment) | **Create** | `routes/create.md` + `references/docx-js-core.md` |
| Edit/modify/revise (has attachment) | **Edit** | `routes/edit.md` + `references/ooxml.md` |
| Format/layout/font/margin | **Format** | `routes/format.md` |
| Comment/annotate/review | **Comment** | `routes/comment.md` |
| Read/analyze/extract | **Read** | `routes/read.md` |

### Scene Router (Optional — load after route)

| User Keywords | Scene | File |
|---------------|-------|------|
| thesis, academic, research, paper, dissertation, abstract, journal | Academic | `scenes/academic.md` |
| report, analysis, experiment, testing, survey, review, summary, proposal, feasibility, competitor, industry, operations | Report | `scenes/report.md` |
| contract, agreement, terms, transfer, NDA, confidential, framework, cooperation, service terms, user agreement, procurement | Contract | `scenes/contract.md` |
| resume, CV, job application | Resume | `scenes/resume.md` |
| exam, test, quiz, paper (exam context), lesson plan | Exam | `scenes/exam.md` |
| official document, notice, letter, reply, minutes, red header, government, issuance | Official | `scenes/official-doc.md` |
| broadcast script, product copy, livestream, speech, presentation script, video script | Copywriting | `scenes/copywriting.md` |
| plan, proposal (if not report context) | Report | `scenes/report.md` |
| policy, regulation, standard, management rules | Official | `scenes/official-doc.md` |

**If no scene matches**, use default design rules from `references/design-system.md` and `references/common-rules.md`.

## Formatting Standards (Always Apply)

→ See `references/common-rules.md` for full font profiles, spacing, indent, and layout rules.

**Key rules (quick reference):**
- **Line spacing**: 1.3x (`line: 312`) — MANDATORY. Exceptions: resume 1.15x, official doc 28pt fixed, copywriting `400`, contract 1.5x
- **CJK body**: Justified + 2-char indent (`firstLine: 480` SimSun / `420` YaHei)
- **Tables**: `margins` set, `ShadingType.CLEAR`, `tableHeader: true`, `cantSplit: true`, title `keepNext: true`
- **Images**: `type` parameter required, preserve aspect ratio via `image-size`, PageBreak inside Paragraph
- **Full-page Table row**: `rule: "exact"` with 1200 twips safety margin

## Unit Quick Reference

| Unit | Value |
|------|-------|
| 1 cm | 567 twips |
| 1 inch | 1440 twips |
| 1 pt | 20 half-points |
| A4 | 11906 × 16838 twips |

For Chinese font size table and common margins, see `references/common-rules.md`.

## Post-Generation — Two-Layer Verification

### Layer 1: Manual Checklist (self-check during generation)

#### Basic Format
- [ ] Line spacing is 1.3x (`line: 312`) or scene-specific override
- [ ] CJK body has 2-char indent (`firstLine: 480` or `420`)
- [ ] Tables have margins set
- [ ] Images preserve aspect ratio via `image-size` — NEVER hardcode both width and height
- [ ] PageBreak inside Paragraph
- [ ] ShadingType uses CLEAR
- [ ] Each numbered list uses unique `reference`
- [ ] **⚠️ CRITICAL — Quotation marks in JS strings properly escaped.** Chinese curly quotes (`""` `''`) MUST use Unicode escapes (`\u201c` `\u201d` `\u2018` `\u2019`); straight quotes (`"` `'`) use `\"` `\'` or alternate delimiters. **This is the #1 most common code generation bug.** Chinese text frequently contains `""` for emphasis or proper nouns (e.g., "双11", "前低后高", "618") — every occurrence MUST be escaped. Failure to escape produces JS syntax errors that silently break document generation.
- [ ] ImageRun includes `type` parameter
- [ ] Header/footer present (unless scene says otherwise)

#### Heading Styles
- [ ] All body chapter headings use `heading: HeadingLevel.HEADING_X` (never simulate with bold + large font)
- [ ] Cover title may skip Heading style (not in TOC), but body headings MUST use Heading style

#### Page Break & Blank Page Prevention
- [ ] Cover/content in separate sections
- [ ] Three rules to prevent blank pages:
  - ① When using section(NEXT_PAGE), previous section must NOT end with PageBreak (double break = blank page)
  - ② PageBreak paragraph SHOULD contain visible text — **exception**: section-ending empty para + PageBreak is allowed (normal section separator, e.g., after cover page)
  - ③ No more than 3 consecutive empty paragraphs
- [ ] Full-page Table row height uses `rule: "exact"` (never `"atLeast"` for tall tables)
- [ ] No unwanted blank pages (check each section ending)

#### TOC
→ See `references/toc.md` for the complete TOC reference and checklist.
- [ ] If TOC title exists → `TableOfContents` element must be present
- [ ] **⚠️ MANDATORY PageBreak after TableOfContents** — a Paragraph containing PageBreak MUST immediately follow the `TableOfContents` element; without it, TOC and body content will render on the same page. This is the #1 TOC formatting failure — never omit it
- [ ] `add_toc_placeholders.py --auto` runs after generation; exit code = 0
- [ ] **TOC MUST be in its own section** — body section sets `page: { pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } }` so page numbers start from the first body page, not from the TOC pages
- [ ] **Page number API nesting** — `pageNumbers` MUST be inside `page: {}`, NOT at properties top level (see toc.md § Page Number API)
- [ ] **3-section page numbering** — Cover (no page#) → Front matter (Roman i,ii,iii, start=1) → Body (Arabic 1,2,3, start=1)
- [ ] **Post-process footers** — Roman section footer instrText must contain `PAGE \* ROMAN \* MERGEFORMAT`; Arabic section `PAGE \* arabic \* MERGEFORMAT` (WPS ignores pgNumType fmt). **⚠️ NEVER use `\* decimal` in instrText** — `decimal` is a docx-js API enum value (`NumberFormat.DECIMAL`), NOT a valid Word field format switch; using it causes page numbers to render as "1decimal", "2decimal". The correct Word field switch for Arabic numerals is `\* arabic`.
- [ ] **Remove empty pgNumType** — Post-process to strip `<w:pgNumType/>` from cover section (docx-js emits empty element that confuses WPS)
- [ ] **⚠️ TOC Refresh Hint MANDATORY** — between `TableOfContents` element and the PageBreak, MUST add an italic gray note paragraph telling users to right-click TOC → "Update Field" to refresh page numbers (see toc.md § TOC Refresh Hint)

#### Table Cross-Page
- [ ] Header rows: `tableHeader: true`
- [ ] All rows: `cantSplit: true`
- [ ] Title paragraph: `keepNext: true`

#### Cover
- [ ] **Cover MUST use a validated recipe (R1–R7)** from `design-system.md` — free-form cover code is forbidden
- [ ] Cover recipe matches document type (per `selectCoverRecipe()` in `design-system.md`)
- [ ] Cover uses the 16838 outer wrapper table with `allNoBorders` (all recipes provide this)
- [ ] Cover title uses `calcTitleLayout()` — never hardcoded font size above 40pt
- [ ] Cover spacing uses `calcCoverSpacing()` — never hardcoded large spacing values
- [ ] Cover content does not overflow (total height ≤ 15638 twips, Table uses `rule: "exact"`)
- [ ] Every TextRun on dark/colored background has explicit `color` set (Rule 9 — never rely on default black)
- [ ] Cover section has no trailing PageBreak or empty paragraphs
- [ ] Title lines split at semantic boundaries (no mid-word breaks, no single-char orphan lines)
- [ ] No text-character decorative lines (`───`, `━━━`) — use paragraph borders only

#### Output Files
- [ ] The user's original input file is untouched at its original path (unless the user explicitly asked for in-place editing); any backup you created stays next to it — these are NOT temp/retry artifacts
- [ ] Deliverable is a new file (`<stem>_updated.docx`), not the input path overwritten
- [ ] Working directories from unpack/pack are cleaned up; only expected deliverables remain

### Layer 2: Automated Post-Check Script

```bash
"$(command -v zcode-python || command -v python3)" "$DOCX_SCRIPTS/postcheck.py" output.docx
```

Automatically checks 14 business rules: blank pages, **cover overflow (font size/spacing/trailing content)**, line spacing consistency, table margins, table cross-page control (cantSplit/tblHeader), image overflow, image aspect ratio distortion, font fallback, CJK indent, heading hierarchy, ShadingType misuse, TOC quality, document cleanliness (placeholder text/Markdown/HTML residuals), report content quality (abstract presence/heading specificity/vague conclusion detection).

⚠️ **After generating any document, MUST run postcheck.py and fix all ❌ errors.**

## Math Formulas

Formula input uses **LaTeX syntax**, internally converted to docx-js Math objects.

- **Basic formulas** (fractions, sub/superscript, roots, summation) → docx-js Math components
- **Complex formulas** (3+ nesting, matrices, piecewise functions) → matplotlib PNG fallback

See `references/math-formulas.md`.

## Charts

Default: **matplotlib template library** generates PNG for embedding.

6 ready-to-use templates: bar, line, pie, box, radar, heatmap.
Colors auto-derived from document palette.accent for style consistency.
Default palette: Morandi low-saturation (see design-system.md).

See `references/chart-templates.md`.

## Dependencies

- **pandoc**: Text extraction
- **docx**: `bun add docx` or `npm install docx` (creating)
- **LibreOffice**: PDF conversion, .doc support — install from the Tsinghua mirror
  (`https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/`, see below)
- **Poppler**: PDF to image (`pdftoppm`)
- **defusedxml**: Secure XML parsing
- **python-docx**: Simple comment operations

### Poppler and Pandoc

`pandoc` and the Poppler command `pdftoppm` keep their usual names; on desktop the preinstalled versions come first on PATH. If `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` is set and one of them is not found, stop before installing anything. Explain: “预装版本未就绪或已关闭，请在 帮助 → 预装工具 中查看” (the preinstalled version is not ready or is disabled; check **Help → Preinstalled tools**). Let the user choose waiting for it (or enabling it there), or continuing the original way: install it as listed above, or use another method this skill already describes for the same step. Without that variable, keep the existing guidance.

### LibreOffice execution

Use the [unified launcher](../../scripts/README.md) for all LibreOffice steps. Its lookup order is the managed installation, then any system version (including older and development builds). Report its version and why the managed program was not used. A managed execution failure retries once on the system program after cleanup; cancellation never retries.
If neither program is usable, keep existing files and report the reason. On desktop, first explain that preparation is unavailable, point to Help → Preinstalled Tools, and let the user choose waiting or Agent installation. Do not skip required validation.
When installation is chosen, follow [installation guidance](env_setup/libreoffice-unmanaged.md), then retry the unified launcher. Remote workspaces, standalone CLI and containers keep their existing installation flow. Always use the launcher after installation; it rechecks for a managed program on every call.

## Final response citations

Place `::zcode-file-citation{...}` inline in prose, not in a trailing list. Use `purpose="source"` for Q&A/no-op and `purpose="output"` for create/edit.

- [HARD REQUIREMENT] Create/edit: cite each final file exactly once with a plain output citation. Summarize representative changes; do not cite every section/page or add a separate filename, path, or Markdown link. Example: `Created ::zcode-file-citation{path="/abs/path/launch-plan.docx" purpose="output"}, highlighting the rollout and owners.`
- Q&A: do not edit/re-export.

### Document

For non-in-place edits, preserve the source and export a copy; if unchanged, cite the source plainly.

For page-specific evidence, use a page number verified against the latest render/inspection.

Locators support only `page_number`; otherwise use a plain citation. Do not guess or add object, label, paragraph, table, or cell IDs. Do not cite intermediates unless asked. Inspect complete relevant pages and preserve material headings, question/table labels, footnotes, sources, and sample sizes; cite each needed page once.

```text
::zcode-file-citation{path="/abs/path/file.docx" purpose="source" artifact_kind="document" page_number=4}
```

### PDF
Citations currently support only plain file citations. Do not add `artifact_kind`, `page_number`, or other locators. Never cite rendered PNGs, scratch files, builders, or QA intermediates unless asked. Inspect the complete relevant pages, preserve material headings, table/figure labels, footnotes, sources, and sample sizes, and cite each source PDF once with a plain source citation.

### Presentation 

inspect the complete relevant slide, including callouts, question wording, chart/table titles, totals/sample sizes, and source/methodology footers. Answer directly, group same-slide claims, and cite that slide once. For concrete chart/table/image/diagram/callout evidence, include exact inspected `slide_id`, `object_id`, and a useful label when available.

For non-in-place edits, preserve the source and export a copy; if unchanged, cite the source plainly.

Use only locators verified against the latest render/inspection:

```text
::zcode-file-citation{path="/abs/path/deck.pptx" purpose="source" artifact_kind="presentation" slide_number=3}
::zcode-file-citation{path="/abs/path/deck.pptx" purpose="source" artifact_kind="presentation" slide_number=1 slide_id="sl/gs5z1kshq0xv" object_id="ch/pz9t1r3ka8vn" label="ARR by segment chart"}
```

If IDs are not exact, stop at `slide_number`; never guess or cite intermediates unless asked.

### Spreadsheets

- Cite whole-workbook claims plainly; otherwise use the narrowest reliable `sheet` + `range` (the exact cell for a discrete value). Cite discontiguous cells separately. For objects, use `sheet` + exact inspected `object_id`; add `object_kind`/`label` only when useful. Never cite a sheet alone or guess locators.
- Calculations: cite only distinct inputs, drivers, formulas, or results the answer needs.

```text
::zcode-file-citation{path="/abs/path/book.xlsx" purpose="source" artifact_kind="workbook" sheet="Revenue Model" range="C27"}
```

Never cite intermediates unless asked.
