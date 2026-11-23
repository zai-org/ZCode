# Route: Edit Existing Document

## Workflow Overview

```
1. Receive .docx (or .doc → convert)
2. Unpack → working directory
3. Analyze structure (document.xml, styles.xml)
4. Plan changes → batch by type
5. OUTPUT → By default pack to a NEW sibling file (`<stem>_updated.docx`),
            never touch the input; overwrite in place ONLY if the user explicitly
            asks to edit their own file — then first copy it to `<stem>_backup.docx`
            next to it (never /tmp)
6. Implement via Document library (Python)
7. Pack → <stem>_updated.docx
8. Verify (pandoc or visual)
```

> **Decide the output path BEFORE you modify anything.** The unpack step in Step 1 copies content out
> of the input, so the input itself stays intact — but the pack step in Step 7 will silently clobber
> whatever path you name. Never pass the user's original path to `zip`.

## Step 0: Format Conversion

```bash
# .doc → .docx
"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" run -- --convert-to docx input.doc
```

> **LibreOffice:** use the [unified launcher](../../../scripts/README.md). The launcher prefers managed LibreOffice, then any installed system version, and reports the fallback reason. If neither is available, retain existing files and follow setup.md. On desktop, first report the unavailable preparation state and ask the user to wait or let the Agent install. After installation, keep using the unified launcher so a later managed installation takes priority.

## Step 1: Unpack

```bash
IN="input.docx"; STEM="${IN%.docx}"     # deliverable will be "${STEM}_updated.docx"
mkdir -p work_dir && cd work_dir && unzip "../$IN"
```

Key files: `word/document.xml` (content), `word/styles.xml` (styles), `word/numbering.xml` (lists), `word/media/` (images), `[Content_Types].xml`, `word/_rels/document.xml.rels`

## Step 2: Plan Changes

Group changes into batches, process in order:

1. **Structural** — Add/remove sections, reorder paragraphs
2. **Style** — Font, size, color modifications
3. **Text** — Find/replace, fix typos
4. **Table** — Add/remove rows/columns, update data
5. **Image** — Replace/add images

## Step 3: Implement

Load `references/ooxml.md` for the full Document library API. Key patterns:

```python
from scripts.document import Document

doc = Document('work_dir')

# Text replacement with tracked changes
node = doc["word/document.xml"].get_node(tag="w:r", contains="old text")
rpr = tags[0].toxml() if (tags := node.getElementsByTagName("w:rPr")) else ""
replacement = f'<w:del><w:r>{rpr}<w:delText>old text</w:delText></w:r></w:del><w:ins><w:r>{rpr}<w:t>new text</w:t></w:r></w:ins>'
doc["word/document.xml"].replace_node(node, replacement)

doc.save()
```

## Step 4: Pack

```bash
# Pack to a NEW sibling file — never to the user's original path
cd work_dir && zip -r "../${STEM}_updated.docx" . -x ".*"
```

## Step 5: Verify

```bash
pandoc "${STEM}_updated.docx" -t plain -o /dev/stdout | head -50
# or visual
"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" run -- --convert-to pdf "${STEM}_updated.docx"
```

> **LibreOffice:** use the [unified launcher](../../../scripts/README.md). The launcher prefers managed LibreOffice, then any installed system version, and reports the fallback reason. If neither is available, retain existing files and follow setup.md. On desktop, first report the unavailable preparation state and ask the user to wait or let the Agent install. After installation, keep using the unified launcher so a later managed installation takes priority.

---

## Template Matching Workflow

When user says "use this format" or provides a template:

1. Unpack template, extract `styles.xml`, `numbering.xml`
2. Analyze font/size/spacing/margins
3. Copy `styles.xml` into target document
4. Match heading hierarchy and spacing

## Multi-File Merge

1. Use first document as base
2. Extract content from additional documents
3. Insert with page breaks between sections
4. Merge styles (prefer base document's)
5. Re-number figures/tables sequentially

## Redlining (Tracked Changes) — Default for Revisions

When user asks for revisions, **default to tracked changes** so they can review:

```python
doc = Document('work_dir', track_revisions=True)
# ... make changes using replace_node with <w:del>/<w:ins>
doc.save()
```

Ask user if they want clean output or tracked changes only if ambiguous.

## Common Operations Quick Reference

| Operation | Approach |
|-----------|----------|
| Replace text | `get_node` + `replace_node` with tracked changes |
| Change font | Modify `<w:rFonts>` in run properties |
| Add paragraph | `insert_after` with `<w:p>` element |
| Delete paragraph | `suggest_deletion` on `<w:p>` |
| Add table row | Clone `<w:tr>`, modify cells |
| Update header | Edit `word/headerN.xml` |
| Change margins | Edit `<w:pgMar>` in `<w:sectPr>` |
| Add image | See `references/ooxml.md` image insertion pattern |
| Add comment | `doc.add_comment(start, end, text)` |
