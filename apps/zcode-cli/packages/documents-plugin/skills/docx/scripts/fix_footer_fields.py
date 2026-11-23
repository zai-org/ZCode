#!/usr/bin/env python3
"""
Fix footer PAGE field instructions in a DOCX file for WPS/Word compatibility.

docx-js generates bare `PAGE` instrText in footers, but WPS ignores `pgNumType fmt`
from section properties, causing page numbers to display as raw field codes like
"PAGE \* arabic \* MERGEFORMAT" instead of actual numbers.

This script:
  1. Reads document.xml to determine each section's page number format
     (Roman vs Arabic) based on <w:pgNumType> and footer relationships
  2. Patches each footer XML: replaces bare ` PAGE ` with the correct
     format-switch variant (` PAGE \\* arabic \\* MERGEFORMAT` or
     ` PAGE \\* ROMAN \\* MERGEFORMAT`)
  3. Removes empty <w:pgNumType/> from cover sections (docx-js emits
     these even when no pageNumbers is set, confusing WPS)
  4. Replaces the original file in-place

Usage:
    "$(command -v zcode-python || command -v python3)" fix_footer_fields.py <docx_file>
    "$(command -v zcode-python || command -v python3)" fix_footer_fields.py <docx_file> --dry-run   # preview changes only

Example:
    "$(command -v zcode-python || command -v python3)" fix_footer_fields.py output.docx
"""

import argparse
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


# ── Namespace helpers ──────────────────────────────────────────────

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Patterns
# Match bare PAGE (not already followed by \*)
BARE_PAGE_RE = re.compile(
    r'(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)'
)
# Match PAGE that already has a format switch (to detect and possibly fix)
EXISTING_FORMAT_RE = re.compile(
    r'(<w:instrText[^>]*>)\s*PAGE\s+\\\*\s+\w+.*?(</w:instrText>)'
)
# Match PAGE with wrong \* decimal format (common bug)
DECIMAL_BUG_RE = re.compile(
    r'(<w:instrText[^>]*>)\s*PAGE\s+\\\*\s+decimal\b[^<]*(</w:instrText>)'
)
# Empty pgNumType
EMPTY_PGNUMTYPE_RE = re.compile(r'<w:pgNumType/>')
# pgNumType with fmt attribute
PGNUMTYPE_FMT_RE = re.compile(r'<w:pgNumType[^/]*?\bw:fmt="([^"]*)"')
# Footer reference in sectPr
FOOTER_REF_RE = re.compile(
    r'<w:footerReference[^>]*r:id="([^"]*)"[^>]*/?>|'
    r'<w:footerReference[^>]*r:id="([^"]*)"[^>]*>.*?</w:footerReference>'
)
# Section properties
SECT_PR_RE = re.compile(r'<w:sectPr\b[^>]*>.*?</w:sectPr>', re.DOTALL)


def _determine_section_formats(document_xml: str, rels_content: str) -> dict:
    """Parse document.xml to map footer rId → format ('arabic' or 'ROMAN').

    Strategy:
    - Find each <w:sectPr> block
    - Extract <w:pgNumType w:fmt="..."> if present
    - Extract <w:footerReference r:id="...">
    - Map rId to the inferred format

    If pgNumType has fmt="upperRoman" or "lowerRoman" → ROMAN
    Otherwise (including "decimal", absent, etc.) → arabic

    Returns:
        dict mapping rId (e.g. "rId8") to format string ("arabic" or "ROMAN")
    """
    fmt_map = {}  # rId → "arabic" | "ROMAN"

    for sect_match in SECT_PR_RE.finditer(document_xml):
        sect_xml = sect_match.group(0)

        # Determine format from pgNumType
        fmt_match = PGNUMTYPE_FMT_RE.search(sect_xml)
        if fmt_match:
            fmt_val = fmt_match.group(1).lower()
            if "roman" in fmt_val:
                page_format = "ROMAN"
            else:
                page_format = "arabic"
        else:
            # No pgNumType or no fmt → default to arabic
            page_format = "arabic"

        # Find footer references in this section
        for fref_match in FOOTER_REF_RE.finditer(sect_xml):
            rid = fref_match.group(1) or fref_match.group(2)
            if rid:
                fmt_map[rid] = page_format

    return fmt_map


def _resolve_footer_files(rels_content: str) -> dict:
    """Parse document.xml.rels to map rId → footer filename.

    Returns:
        dict mapping rId (e.g. "rId8") to filename (e.g. "footer1.xml")
    """
    rid_to_file = {}
    # Match Relationship elements for footer targets
    rel_re = re.compile(
        r'<Relationship[^>]*\bId="([^"]*)"[^>]*\bTarget="([^"]*footer[^"]*)"',
        re.IGNORECASE
    )
    for m in rel_re.finditer(rels_content):
        rid = m.group(1)
        target = m.group(2)
        # Target is like "footer1.xml" or "word/footer1.xml"
        filename = target.split("/")[-1]
        rid_to_file[rid] = filename

    return rid_to_file


def _patch_footer_xml(footer_xml: str, page_format: str) -> tuple:
    """Patch a single footer XML string.

    Args:
        footer_xml: Raw XML content of footer file
        page_format: "arabic" or "ROMAN"

    Returns:
        (patched_xml, changes_list)
    """
    changes = []
    result = footer_xml

    # Fix 1: Replace \* decimal with \* arabic (common bug)
    if DECIMAL_BUG_RE.search(result):
        replacement = rf'\g<1> PAGE \\* {page_format} \\* MERGEFORMAT \g<2>'
        result = DECIMAL_BUG_RE.sub(replacement, result)
        changes.append(f"Fixed \\* decimal → \\* {page_format}")

    # Fix 2: Patch bare PAGE (no format switch at all)
    if BARE_PAGE_RE.search(result):
        replacement = rf'\g<1> PAGE \\* {page_format} \\* MERGEFORMAT \g<2>'
        result = BARE_PAGE_RE.sub(replacement, result)
        changes.append(f"Added \\* {page_format} \\* MERGEFORMAT to bare PAGE")

    return result, changes


def fix_footer_fields(docx_path: str, dry_run: bool = False) -> list:
    """Fix footer PAGE field instructions in a DOCX file.

    Args:
        docx_path: Path to DOCX file (modified in-place unless dry_run)
        dry_run: If True, only report changes without modifying

    Returns:
        List of change descriptions
    """
    docx_path = Path(docx_path)
    if not docx_path.exists():
        raise FileNotFoundError(f"File not found: {docx_path}")

    all_changes = []

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        extracted_dir = temp_path / "extracted"
        temp_output = temp_path / "output.docx"

        # Extract DOCX
        with zipfile.ZipFile(docx_path, 'r') as zip_ref:
            zip_ref.extractall(extracted_dir)

        word_dir = extracted_dir / "word"
        document_xml_path = word_dir / "document.xml"
        rels_path = word_dir / "_rels" / "document.xml.rels"

        if not document_xml_path.exists():
            raise ValueError("document.xml not found in DOCX")

        document_xml = document_xml_path.read_text(encoding='utf-8')

        # ── Step 1: Remove empty <w:pgNumType/> from cover section ──
        empty_count = len(EMPTY_PGNUMTYPE_RE.findall(document_xml))
        if empty_count > 0:
            document_xml = EMPTY_PGNUMTYPE_RE.sub('', document_xml)
            all_changes.append(
                f"Removed {empty_count} empty <w:pgNumType/> from document.xml"
            )

        if not dry_run:
            document_xml_path.write_text(document_xml, encoding='utf-8')

        # ── Step 2: Determine section → format mapping ──
        rels_content = ""
        if rels_path.exists():
            rels_content = rels_path.read_text(encoding='utf-8')

        rid_to_format = _determine_section_formats(document_xml, rels_content)
        rid_to_file = _resolve_footer_files(rels_content)

        # Build filename → format mapping
        file_to_format = {}
        for rid, fmt in rid_to_format.items():
            fname = rid_to_file.get(rid)
            if fname:
                file_to_format[fname] = fmt

        # ── Step 3: Patch each footer XML ──
        footer_files = sorted(word_dir.glob("footer*.xml"))
        if not footer_files:
            all_changes.append("No footer files found — nothing to patch")
            return all_changes

        for footer_path in footer_files:
            fname = footer_path.name
            # Determine format: use mapping if available, default to arabic
            page_format = file_to_format.get(fname, "arabic")

            footer_xml = footer_path.read_text(encoding='utf-8')
            patched_xml, changes = _patch_footer_xml(footer_xml, page_format)

            if changes:
                for c in changes:
                    all_changes.append(f"{fname}: {c}")
                if not dry_run:
                    footer_path.write_text(patched_xml, encoding='utf-8')
            else:
                all_changes.append(f"{fname}: already correct (format={page_format})")

        if not dry_run:
            # Repack DOCX
            with zipfile.ZipFile(temp_output, 'w', zipfile.ZIP_DEFLATED) as zipf:
                for file_path in extracted_dir.rglob('*'):
                    if file_path.is_file():
                        arcname = file_path.relative_to(extracted_dir)
                        zipf.write(file_path, arcname)

            # Replace original
            shutil.move(str(temp_output), str(docx_path))

    return all_changes


def main():
    parser = argparse.ArgumentParser(
        description=(
            'Fix footer PAGE field instructions in a DOCX file. '
            'Patches bare PAGE → PAGE \\* arabic \\* MERGEFORMAT (or ROMAN), '
            'fixes \\* decimal bug, and removes empty <w:pgNumType/>.'
        )
    )
    parser.add_argument('docx_file', help='DOCX file to fix (modified in-place)')
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Preview changes without modifying the file'
    )

    args = parser.parse_args()

    try:
        changes = fix_footer_fields(args.docx_file, dry_run=args.dry_run)
        prefix = "[DRY RUN] " if args.dry_run else ""
        for c in changes:
            print(f"  {prefix}{c}")
        if args.dry_run:
            print("\nDry run complete — no files modified.")
        else:
            print(f"\nSuccessfully fixed footer fields in {args.docx_file}")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
