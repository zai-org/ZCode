---
name: xlsx
metadata:
  author: Z.AI
  version: "1.1"
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file; create a new spreadsheet from scratch or from other data sources; analyze data and output results as an Excel file with charts; convert between tabular file formats (CSV/TSV/JSON/PDF-table → XLSX, or XLSX → CSV/JSON); clean, merge, pivot, or transform tabular data. Trigger especially when the user references a spreadsheet file by name or path, says 'make a table/report/model', mentions Excel/CSV/数据分析/报表/汇总, asks to convert or export a spreadsheet (e.g. 'csv转excel', 'json转表格', 'export as CSV'), or wants data visualization inside a spreadsheet."
license: Proprietary. LICENSE.txt has complete terms
---

# XLSX — Scene-Driven Spreadsheet Workbench

## LibreOffice preflight

Before the first Python command, if neither `zcode-python` nor a system Python is available, follow [Python setup](env_setup/setup.md#python-interpreter-selection). On desktop, report that preinstalled Python is not ready or is disabled and let the user choose waiting, enabling it, or system installation. The same setup guide covers a selected preinstalled interpreter or package installation failure.

Set `XLSX_SKILL_DIR` to this Skill's returned base directory. Run `"$(command -v zcode-python || command -v python3)" "$XLSX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check` before a conversion or recalculation.
The [launcher contract](../../scripts/README.md) defines managed/system lookup, isolated profiles and failure handling. Report a managed failure and use any available system version. If neither is usable on desktop, preserve completed files and let the user choose waiting or Agent installation using [setup guidance](env_setup/libreoffice-unmanaged.md). The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance. Keep using the unified launcher after installation so later managed readiness takes priority. Other dependency setup remains unchanged.

## Environment Setup

**Quick check** — run this first. If it exits 0, skip to [Pre-Flight](#pre-flight-intent-gate):

```bash
source "<skill_directory>/env_setup/env_check.sh"
```

This auto-detects and exports `XLSX_SKILL_DIR` and `FONT_DIR`. No manual variable setup needed.

**Only if the check fails**, read [`env_setup/setup.md`](env_setup/setup.md) for full platform-specific installation instructions (dependencies, fonts, China mirrors).

> **LibreOffice:** use the unified launcher whenever recalculation or Office conversion is required. Report managed failures and use any working system version. If none is available on desktop, let the user choose waiting or Agent installation; then continue through the launcher and perform required validation.

| Variable | Auto-set by env_check.sh | Description |
|----------|--------------------------|-------------|
| `XLSX_SKILL_DIR` | skill root directory | Parent of this file |
| `FONT_DIR` | macOS: `~/Library/Fonts`, Linux: `/usr/share/fonts` | Font base directory |

> **Local-font-first.** Inspect fonts available in the user's local environment and prefer a suitable
> installed font. Use bundled or downloaded fonts only as fallbacks; do not install fonts without the
> user's confirmation.

---
## Pre-Flight: Intent Gate

Before touching any code, confirm the user actually needs a spreadsheet:

- Report / analysis summary (述职, 调研报告) → **docx skill**
- Presentation (汇报, 演示, pitch deck) → **pptx skill**
- Formal print document (合同, 证书, "PDF") → **pdf skill**
- Charts only, no data table needed → **charts skill**
- User explicitly says a format → respect it

If confirmed xlsx → proceed to Scene Router below.

**Request Decomposition** (do this every time):
- **Explicit needs**: sheets, columns, formulas, metrics the user stated
- **Implicit needs**: business context, downstream use (filter? sort? input?)
- **Multi-part requests**: generate ALL parts — never silently drop a component

**Multi-Intent Detection** — some requests combine multiple scenes:

```
"Create a financial model with charts and export a PDF summary"
 → scenes/finance.md + engines/chart.md + (hand off PDF to pdf skill)

"Analyze this CSV, build a dashboard, and make it look professional"
 → scenes/analyze.md + engines/chart.md + engines/design.md

"Edit this budget file, add a new quarter column, and create a pivot"
 → scenes/edit.md + quality/pipeline.md (pivot command)

"Convert these 5 CSVs into one xlsx with a summary sheet"
 → scenes/convert.md + scenes/create.md (for summary)
```

When multiple intents detected, load all matching files and execute in logical order: data preparation → analysis → visualization → styling → QA.

---

## File Loading Rules (MANDATORY)

**Always load ALL matched files. No shortcuts, no lazy loading, no "on demand".**

```
User Request
│
├─ 1. Read SKILL.md (this file) — always
├─ 2. Route to scene file(s) via Scene Router below — read COMPLETELY
├─ 3. If scene involves charts → ALSO read engines/chart.md
├─ 4. If scene produces styled output → ALSO read engines/design.md
├─ 5. If scene is analyze → ALSO read scenes/analyze-recipes.md
├─ 6. If scene is edit → ALSO read scenes/edit-patterns.md
├─ 7. If scene is VBA → ALSO read engines/vba-templates.md
└─ 8. QA: always run full pipeline (quality/pipeline.md)
```

**Rule: when in doubt, read the file.** The cost of reading an extra file is a few hundred tokens. The cost of NOT reading it is a broken output that needs to be redone.

**Chart + Design engines are loaded by default** unless the task is purely read-only (inspect/validate with no output file). If you are creating or editing an xlsx, you MUST read `engines/design.md`.

---

## Scene Router

```
User Request
│
├─ Involves an existing file?
│  ├─ Yes → Modify content or structure?
│  │         ├─ Yes ──────────────────── → scenes/edit.md
│  │         └─ No (read/analyze only) ─ → scenes/analyze.md
│  │
│  └─ Format conversion (CSV↔XLSX, JSON, PDF tables)?
│     └─ Yes ────────────────────────── → scenes/convert.md
│
├─ Create from scratch?
│  ├─ Financial / budget / forecast / cost tracking?
│  │  ├─ Complex (DCF / LBO / three-statement linkage (三表联动) / sensitivity / IB model)?
│  │  │  └─ Yes ─────────────────────── → scenes/finance.md
│  │  └─ Simple (budget table (预算表) / expense report (费用报表) / revenue vs cost (收支对比) / project cost (项目成本) / personal finance (个人记账))?
│  │     └─ Yes ─────────────────────── → scenes/finance_lite.md
│  └─ General table / report / template
│     └─ ──────────────────────────── → scenes/create.md
│
├─ Batch processing / large files / protection / validation?
│  └─ Yes ───────────────────────────── → scenes/advanced.md
│
├─ VBA / macros / automation inside Excel?
│  └─ Yes ───────────────────────────── → scenes/vba.md + engines/vba-templates.md
│
├─ Needs charts or data visualization?
│  └─ Yes ───────────── append ────────→ engines/chart.md
│
└─ Needs styling / design system?
   └─ Yes ───────────── append ────────→ engines/design.md
```

**Mixed requests**: load all matching files. Engine files always **append** to a scene.

**Finance detection**:
- **finance.md** (complex): DCF, LBO, P&L, 利润表, 资产负债, valuation, 估值, IRR, 三表联动, sensitivity, scenario
- **finance_lite.md** (simple): 预算, budget, 费用, expense, 收支, 记账, 项目成本, cost tracking, 报销, ROI

**VBA detection**: 宏, macro, VBA, 自动化, automation, .xlsm, 按钮, button, auto-run, 批量处理脚本

---

## Design Principles

### 1. Live Formula Guarantee
Every derived value SHOULD be an Excel formula so the spreadsheet stays dynamic.

**Exception — Programmatic Verification**: When the output file will be verified by Python (not opened in Excel), TOTAL/SUM rows should write **computed values** instead of formulas, because openpyxl cannot evaluate formulas and `data_only=True` returns `None` for newly-written formulas. Optionally add the formula as a cell comment for reference.

### 2. Zero Error Tolerance
Deliverables must have zero formula errors. All divisions wrapped with `IFERROR` or `IF(denom=0,...)`. Absolute references (`$C$42`) for shared denominators.

### 3. Compatibility First
No dynamic array functions (`FILTER`, `UNIQUE`, `XLOOKUP`, `SORT`, `SORTBY`, `XMATCH`, `SEQUENCE`, `LET`, `LAMBDA`, `RANDARRAY`). No implicit array formulas — use `SUMPRODUCT` alternatives.

### 4. Preserve & Match
When editing existing files: study and exactly match format, style, conventions. Existing patterns always override defaults. Text starting with `=` must be prefixed with `'`.

### 5. Language Mirror
Output language (sheet names, headers, labels) matches user's input language.

### 6. Data Consistency Over Instructions
When user instructions conflict with the actual data patterns in the existing file:
- **First priority**: match the existing data pattern (e.g., if existing data uses `0` for empty, don't switch to `-`)
- **Second priority**: follow user instructions literally
- Always flag the conflict to the user

Example: User says "show hyphen for zero" but existing data and answer key use numeric `0` → Use `0` and notify user of the discrepancy.

### 7. Original File Preserved
User-provided input files are read-only by default. Deliverables go to new
files; edit an original in place only when the user explicitly asks.

---

## Toolchain

### Script Path Setup (MANDATORY before any script call)

All CLI tools live relative to this skill's directory. Before calling any script, resolve the absolute path once:

```bash
XLSX_SKILL_DIR="<skill_directory>"   # ← parent directory of this SKILL.md

# Then all commands use absolute paths:
"$(command -v zcode-python || command -v python3)" "$XLSX_SKILL_DIR/xlsx.py" inspect data.xlsx --pretty
"$(command -v zcode-python || command -v python3)" "$XLSX_SKILL_DIR/xlsx.py" pivot data.xlsx output.xlsx --rows Region --values Revenue
"$(command -v zcode-python || command -v python3)" "$XLSX_SKILL_DIR/xlsx.py" validate output.xlsx
```

**For Python imports** (when generation code needs to import skill modules):

```python
import sys, os
XLSX_SKILL_DIR = "<skill_directory>"
for sub in [XLSX_SKILL_DIR, os.path.join(XLSX_SKILL_DIR, "templates")]:
    if sub not in sys.path:
        sys.path.insert(0, sub)
```

**⚠️ NEVER use bare `"$(command -v zcode-python || command -v python3)" xlsx.py ...`** — it only works if cwd happens to be the skill directory. Always use the absolute path.

### Tool Reference

| Tool | Use |
|------|-----|
| **openpyxl** | Formulas, formatting, charts, cell-level control |
| **pandas** | Data analysis, bulk operations, CSV/TSV |
| `load_workbook(read_only=True)` | Large file reads |
| `Workbook(write_only=True)` | Large file writes |
| **templates/base.py** | Design tokens, font resolution, style factories, utilities (single source of truth) |
| **xlsx.py** | QA commands (see `quality/pipeline.md`) |

Workbook metadata: `wb.properties.creator = "Z.ai"`

> **All code MUST import from `templates/base.py`** for colors, fonts, and style helpers. Never hardcode hex values or font names.

---

## Quality Gate

Every deliverable must pass the full integrity pipeline before delivery.

→ **Load `quality/pipeline.md` for the role-based integrity workflow.**

Quick reference:
```
Blueprint → Build & Self-check (per-sheet) → Inspect → Pivot (if needed) → Release
```

### LibreOffice execution

Use the [unified launcher](../../scripts/README.md) for all LibreOffice steps. Its lookup order is the managed installation, then any system version (including older and development builds). Report its version and why the managed program was not used. A managed execution failure retries once on the system program after cleanup; cancellation never retries.
If neither program is usable, keep existing files and report the reason. On desktop, first explain that preparation is unavailable, point to Help → Preinstalled Tools, and let the user choose waiting or Agent installation. Do not skip required validation.
When installation is chosen, follow [installation guidance](env_setup/libreoffice-unmanaged.md), then retry the unified launcher. Remote workspaces, standalone CLI and containers keep their existing installation flow. Always use the launcher after installation; it rechecks for a managed program on every call.

## Capability Matrix

| Capability | Supported | Scene/Engine |
|-----------|-----------|-------------|
| Create from scratch | ✅ | scenes/create |
| Edit existing file | ✅ | scenes/edit |
| Data analysis & EDA | ✅ | scenes/analyze |
| Format conversion | ✅ | scenes/convert |
| Financial models (DCF/LBO/P&L) | ✅ | scenes/finance |
| Simple budgets & expenses | ✅ | scenes/finance_lite |
| VBA macros & automation | ✅ | scenes/vba + engines/vba-templates |
| Batch processing | ✅ | scenes/advanced |
| Embedded charts | ✅ | engines/chart |
| Smart chart recommendation | ✅ | engines/chart |
| Design system & styling | ✅ | engines/design |
| PivotTable creation | ✅ | quality/pipeline (pivot cmd) |
| Formula validation | ✅ | quality/pipeline |
| Structural validation | ✅ | quality/pipeline |
| Data provenance tracking | ✅ | scenes/analyze |
| Large file handling | ✅ | scenes/advanced |
| Data protection & locking | ✅ | scenes/advanced |

## Final response citations

Place `::zcode-file-citation{...}` inline in prose, not in a trailing list. Use `purpose="source"` for Q&A/no-op and `purpose="output"` for create/edit.

- [HARD REQUIREMENT] Create/edit: cite each final file exactly once with a plain output citation. Summarize representative changes; do not cite every section/page or add a separate filename, path, or Markdown link. Example: `Created ::zcode-file-citation{path="/abs/path/launch-plan.docx" purpose="output"}, highlighting the rollout and owners.`
- Q&A: do not edit/re-export.

### Document

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
