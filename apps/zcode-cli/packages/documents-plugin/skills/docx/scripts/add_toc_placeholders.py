#!/usr/bin/env python3
"""
Add placeholder entries to Table of Contents in a DOCX file.

This script adds placeholder TOC entries between the 'separate' and 'end'
field characters, so users see some content on first open instead of an empty TOC.
The original file is replaced with the modified version.

Usage:
    "$(command -v zcode-python || command -v python3)" add_toc_placeholders.py <docx_file>              # auto-extract headings (default)
    "$(command -v zcode-python || command -v python3)" add_toc_placeholders.py <docx_file> --auto       # explicit auto mode
    "$(command -v zcode-python || command -v python3)" add_toc_placeholders.py <docx_file> --entries <entries_json>

    entries_json format: JSON string with array of objects:
    [
        {"level": 1, "text": "Chapter 1 Overview", "page": "1"},
        {"level": 2, "text": "Section 1.1 Details", "page": "1"}
    ]

    Default behavior (no flags): auto-extracts Heading 1-3 from the document.
    Filters out table/figure captions (e.g. "表 1：xxx", "图 2：xxx").

Example:
    "$(command -v zcode-python || command -v python3)" add_toc_placeholders.py document.docx
    "$(command -v zcode-python || command -v python3)" add_toc_placeholders.py document.docx --auto
    "$(command -v zcode-python || command -v python3)" add_toc_placeholders.py document.docx --entries '[{"level":1,"text":"Introduction","page":"1"}]'
"""

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def _extract_headings_from_docx(docx_path: str, max_level: int = 3) -> list:
    """Extract headings from a DOCX file for auto-mode TOC generation.

    Args:
        docx_path: Path to DOCX file
        max_level: Maximum heading level to include (default 3)

    Returns:
        List of dicts with 'level', 'text', 'page' keys
    """
    from docx import Document

    doc = Document(docx_path)
    entries = []
    page_estimate = 1

    # Pattern to filter out table/figure captions styled as headings
    caption_pattern = re.compile(r'^[表图]\s*\d')

    for i, para in enumerate(doc.paragraphs):
        style_name = para.style.name if para.style else ''
        if not style_name.startswith('Heading'):
            continue
        m = re.search(r'(\d+)', style_name)
        if not m:
            continue
        level = int(m.group(1))
        if level > max_level:
            continue
        text = para.text.strip()
        if not text:
            continue
        # Filter table/figure captions
        if caption_pattern.match(text):
            continue

        # Rough page estimate: increment every ~8 headings
        page_estimate = max(1, 1 + i // 8)
        entries.append({"level": level, "text": text, "page": str(page_estimate)})

    return entries


def add_toc_placeholders(docx_path: str, entries: list = None) -> None:
    """Add placeholder TOC entries to a DOCX file (in-place replacement).

    Args:
        docx_path: Path to DOCX file (will be modified in-place)
        entries: Optional list of placeholder entries. Each entry should be a dict
                 with 'level' (1-3), 'text', and 'page' keys.
    """
    docx_path = Path(docx_path)

    # Create temp directory for extraction
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        extracted_dir = temp_path / "extracted"
        temp_output = temp_path / "output.docx"

        # Extract DOCX
        with zipfile.ZipFile(docx_path, 'r') as zip_ref:
            zip_ref.extractall(extracted_dir)

        # Ensure TOC styles exist in styles.xml
        styles_xml_path = extracted_dir / "word" / "styles.xml"
        toc_style_mapping = _ensure_toc_styles(styles_xml_path)
        print(f"TOC style mapping: {toc_style_mapping}")

        # Fix settings.xml: ensure updateFields has val="true"
        settings_xml_path = extracted_dir / "word" / "settings.xml"
        _fix_update_fields(settings_xml_path)

        # Fix Heading styles: ensure outlineLvl is set (required for TOC field update)
        _fix_heading_outline_levels(styles_xml_path)

        # Process document.xml
        document_xml = extracted_dir / "word" / "document.xml"
        if not document_xml.exists():
            raise ValueError("document.xml not found in the DOCX file")

        # Read and process XML
        content = document_xml.read_text(encoding='utf-8')

        # Fix fldChar structure: split merged begin+instrText+separate into separate <w:r> elements
        content = _fix_fld_char_structure(content)

        # Find TOC structure and add placeholders (uses lxml for robust XML parsing)
        modified_content = _insert_toc_placeholders(content, entries, toc_style_mapping)

        # Write back
        document_xml.write_text(modified_content, encoding='utf-8')

        # Repack DOCX to temp file
        with zipfile.ZipFile(temp_output, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for file_path in extracted_dir.rglob('*'):
                if file_path.is_file():
                    arcname = file_path.relative_to(extracted_dir)
                    zipf.write(file_path, arcname)

        # Replace original file with modified version (use shutil.move for cross-device support)
        docx_path.unlink()
        shutil.move(str(temp_output), str(docx_path))


def _fix_update_fields(settings_xml_path: Path) -> None:
    """Fix settings.xml to ensure <w:updateFields w:val="true"/> is present.

    The docx npm library generates <w:updateFields/> without val="true",
    which Word/WPS interprets as false, preventing TOC auto-update on open.
    """
    if not settings_xml_path.exists():
        return

    content = settings_xml_path.read_text(encoding='utf-8')
    original = content

    # Case 1: <w:updateFields/> (self-closing, no val) → add val="true"
    if '<w:updateFields/>' in content:
        content = content.replace('<w:updateFields/>', '<w:updateFields w:val="true"/>')
        print('Fixed: <w:updateFields/> → <w:updateFields w:val="true"/>')

    # Case 2: <w:updateFields w:val="false"/> → change to true (match precisely)
    elif re.search(r'<w:updateFields\s+w:val="false"\s*/>', content):
        content = re.sub(
            r'<w:updateFields\s+w:val="false"\s*/>',
            '<w:updateFields w:val="true"/>',
            content
        )
        print('Fixed: <w:updateFields w:val="false"/> → <w:updateFields w:val="true"/>')

    # Case 3: Not present at all → inject before </w:settings>
    elif '<w:updateFields' not in content:
        content = content.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>')
        print('Fixed: added <w:updateFields w:val="true"/> to settings.xml')

    if content != original:
        settings_xml_path.write_text(content, encoding='utf-8')


def _fix_heading_outline_levels(styles_xml_path: Path) -> None:
    """Fix Heading styles to include outlineLvl in pPr.

    The docx npm library creates Heading styles but sometimes doesn't set outlineLvl
    in the style definition. Without outlineLvl, Word's TOC field update won't find
    headings even though they display correctly.

    This ensures Heading1 has outlineLvl=0, Heading2 has outlineLvl=1, etc.
    """
    if not styles_xml_path.exists():
        return

    content = styles_xml_path.read_text(encoding='utf-8')
    original = content

    W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

    for level in range(1, 7):
        style_id = f'Heading{level}'
        outline_val = str(level - 1)

        # Pattern: find <w:style> with w:styleId="HeadingN"
        style_pattern = (
            rf'(<w:style[^>]*w:styleId="{style_id}"[^>]*>)'
            rf'(.*?)'
            rf'(</w:style>)'
        )

        match = re.search(style_pattern, content, flags=re.DOTALL)
        if not match:
            continue

        style_content = match.group(2)

        # Check if outlineLvl already exists in this style
        if '<w:outlineLvl' in style_content:
            continue

        # Find or create <w:pPr> within this style
        ppr_match = re.search(r'(<w:pPr[^>]*>)(.*?)(</w:pPr>)', style_content, flags=re.DOTALL)
        if ppr_match:
            # Add outlineLvl inside existing pPr
            new_ppr_content = ppr_match.group(2) + f'<w:outlineLvl w:val="{outline_val}"/>'
            new_style_content = (
                style_content[:ppr_match.start()] +
                ppr_match.group(1) + new_ppr_content + ppr_match.group(3) +
                style_content[ppr_match.end():]
            )
        else:
            # No pPr exists, create one
            new_ppr = f'<w:pPr><w:outlineLvl w:val="{outline_val}"/></w:pPr>'
            # Insert pPr right after style opening (after name/basedOn if present)
            new_style_content = new_ppr + style_content

        new_style = match.group(1) + new_style_content + match.group(3)
        content = content[:match.start()] + new_style + content[match.end():]
        print(f'Fixed: added outlineLvl={outline_val} to {style_id} style')

    if content != original:
        styles_xml_path.write_text(content, encoding='utf-8')


def _fix_fld_char_structure(xml_content: str) -> str:
    """Fix malformed fldChar structure where begin+instrText+separate are in one <w:r>.

    The docx npm library generates:
        <w:r><w:fldChar begin/><w:instrText>TOC...</w:instrText><w:fldChar separate/></w:r>

    Word/WPS requires the standard structure:
        <w:r><w:fldChar begin/></w:r>
        <w:r><w:instrText>TOC...</w:instrText></w:r>
        <w:r><w:fldChar separate/></w:r>
    """
    # Match a <w:r> that contains both begin fldChar AND instrText AND separate fldChar
    pattern = (
        r'<w:r(?:\s[^>]*)?>('
        r'<w:fldChar[^>]*w:fldCharType="begin"[^>]*/>'  # begin
        r')('
        r'<w:instrText[^>]*>.*?</w:instrText>'           # instrText
        r')('
        r'<w:fldChar[^>]*w:fldCharType="separate"[^>]*/>'  # separate
        r')</w:r>'
    )

    def split_run(match):
        begin = match.group(1)
        instr = match.group(2)
        separate = match.group(3)
        return f'<w:r>{begin}</w:r><w:r>{instr}</w:r><w:r>{separate}</w:r>'

    modified = re.sub(pattern, split_run, xml_content, flags=re.DOTALL)
    if modified != xml_content:
        print("Fixed: split merged fldChar begin+instrText+separate into separate <w:r> elements")

    # Fix TOC instrText: remove \t switch with wrong style names
    # docx npm lib generates \t "Heading1,1,Heading2,2,..." but Word expects "Heading 1,1,..."
    # Since we already have \o "1-3" which uses outlineLvl (now fixed), \t is redundant and harmful
    toc_t_pattern = r'(TOC\s+[^<]*?)\\t\s+&quot;[^&]*&quot;'
    modified2 = re.sub(toc_t_pattern, r'\1', modified)
    if modified2 != modified:
        print("Fixed: removed \\t switch from TOC instrText (\\o with outlineLvl is sufficient)")
        modified = modified2

    return modified


def _detect_toc_styles(styles_xml_path: Path) -> dict:
    """Detect TOC style IDs from styles.xml.

    Args:
        styles_xml_path: Path to styles.xml

    Returns:
        Dictionary mapping level (1-3) to style ID string
    """
    if not styles_xml_path.exists():
        return {}

    content = styles_xml_path.read_text(encoding='utf-8')
    result = {}

    for level in range(1, 4):
        # Standard TOC style names: "TOC 1", "TOC 2", "TOC 3" (with space)
        # or "TOC1", "TOC2", "TOC3" (no space) — docx-js uses numeric IDs like "9", "11", "12"
        patterns = [
            rf'w:styleId="(TOC{level})"',
            rf'w:styleId="(TOC {level})"',
            rf'<w:name\s+w:val="toc\s*{level}"[^/]*/>\s*</w:name>|<w:name\s+w:val="toc\s*{level}"[^/]*/>',
        ]
        for pattern in patterns[:2]:
            m = re.search(pattern, content)
            if m:
                result[level] = m.group(1)
                break
        else:
            # Try matching by w:name (case insensitive toc N)
            # Find <w:style> blocks with name containing "toc N"
            name_pattern = rf'<w:style[^>]*w:styleId="([^"]*)"[^>]*>.*?<w:name\s+w:val="[Tt][Oo][Cc]\s*{level}"'
            m = re.search(name_pattern, content, flags=re.DOTALL)
            if m:
                result[level] = m.group(1)

    return result


def _ensure_toc_styles(styles_xml_path: Path) -> dict:
    """Ensure TOC styles exist in styles.xml, adding them if necessary.

    Returns:
        Dictionary mapping level (1-3) to style ID string
    """
    if not styles_xml_path.exists():
        return {1: "9", 2: "11", 3: "12"}

    content = styles_xml_path.read_text(encoding='utf-8')
    detected = _detect_toc_styles(styles_xml_path)
    result = dict(detected)

    W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

    # Define TOC styles to add if missing
    toc_style_defs = {
        1: {
            'id': '9',
            'name': 'toc 1',
            'xml': f'''<w:style w:type="paragraph" w:styleId="9" xmlns:w="{W_NS}">
  <w:name w:val="toc 1"/>
  <w:basedOn w:val="Normal"/>
  <w:uiPriority w:val="39"/>
  <w:pPr>
    <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9026"/></w:tabs>
    <w:spacing w:before="120" w:after="60"/>
  </w:pPr>
  <w:rPr><w:b/><w:bCs/></w:rPr>
</w:style>'''
        },
        2: {
            'id': '11',
            'name': 'toc 2',
            'xml': f'''<w:style w:type="paragraph" w:styleId="11" xmlns:w="{W_NS}">
  <w:name w:val="toc 2"/>
  <w:basedOn w:val="Normal"/>
  <w:uiPriority w:val="39"/>
  <w:pPr>
    <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9026"/></w:tabs>
    <w:ind w:left="360"/>
    <w:spacing w:before="60" w:after="40"/>
  </w:pPr>
</w:style>'''
        },
        3: {
            'id': '12',
            'name': 'toc 3',
            'xml': f'''<w:style w:type="paragraph" w:styleId="12" xmlns:w="{W_NS}">
  <w:name w:val="toc 3"/>
  <w:basedOn w:val="Normal"/>
  <w:uiPriority w:val="39"/>
  <w:pPr>
    <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9026"/></w:tabs>
    <w:ind w:left="720"/>
    <w:spacing w:before="40" w:after="20"/>
  </w:pPr>
</w:style>'''
        },
    }

    modified = False
    for level in range(1, 4):
        if level not in result:
            style_def = toc_style_defs[level]
            result[level] = style_def['id']
            # Add style before </w:styles>
            insert_point = content.rfind('</w:styles>')
            if insert_point == -1:
                print(f"WARNING: Could not find </w:styles> to insert TOC {level} style", file=sys.stderr)
                continue
            content = content[:insert_point] + style_def['xml'] + '\n' + content[insert_point:]
            print(f"Added TOC {level} style (ID: {style_def['id']})")
            modified = True

    if modified:
        styles_xml_path.write_text(content, encoding='utf-8')

    # Ensure Hyperlink style exists
    _ensure_hyperlink_style(styles_xml_path)

    return result


def _ensure_hyperlink_style(styles_xml_path: Path) -> None:
    """Ensure Hyperlink character style exists in styles.xml."""
    if not styles_xml_path.exists():
        return

    content = styles_xml_path.read_text(encoding='utf-8')
    if 'w:styleId="Hyperlink"' in content:
        return

    W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    hyperlink_style = f'''<w:style w:type="character" w:styleId="Hyperlink" xmlns:w="{W_NS}">
  <w:name w:val="Hyperlink"/>
  <w:uiPriority w:val="99"/>
  <w:rPr>
    <w:color w:val="0563C1"/>
    <w:u w:val="single"/>
  </w:rPr>
</w:style>'''

    insert_point = content.rfind('</w:styles>')
    if insert_point != -1:
        content = content[:insert_point] + hyperlink_style + '\n' + content[insert_point:]
        styles_xml_path.write_text(content, encoding='utf-8')
        print("Added Hyperlink character style")


def _insert_toc_placeholders(xml_content: str, entries: list = None, toc_style_mapping: dict = None) -> str:
    """Insert placeholder TOC entries and heading bookmarks into XML content.

    Uses lxml ElementTree for robust XML manipulation instead of fragile regex.

    This function does TWO things:
    1. Adds bookmark anchors to each Heading paragraph (so Word can link TOC → heading)
    2. Replaces TOC placeholder area with proper entries containing HYPERLINK + PAGEREF

    Args:
        xml_content: The XML content of document.xml
        entries: List of placeholder entries with 'level', 'text', 'page' keys
        toc_style_mapping: Dictionary mapping level to style ID

    Returns:
        Modified XML content with bookmarks and TOC placeholders

    Raises:
        RuntimeError: If TOC structure cannot be found or is malformed
    """
    from lxml import etree

    if entries is None:
        entries = [{"level": 1, "text": "Contents", "page": "1"}]

    if toc_style_mapping is None:
        toc_style_mapping = {1: "9", 2: "11", 3: "12"}

    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

    # Parse XML
    root = etree.fromstring(xml_content.encode('utf-8'))
    nsmap = {'w': W, 'r': R_NS}

    # ── Step 1: Add bookmarks to Heading paragraphs ──
    bookmark_id_counter = 100000
    heading_bookmark_map = {}  # text → first bookmark_name (backward compat)
    heading_bookmark_map_all = {}  # text → [list of bookmark_names] for duplicate headings

    for para in root.iter(f'{{{W}}}p'):
        # Find pStyle
        ppr = para.find(f'{{{W}}}pPr')
        if ppr is None:
            continue
        pstyle = ppr.find(f'{{{W}}}pStyle')
        if pstyle is None:
            continue
        style_val = pstyle.get(f'{{{W}}}val', '')
        if not re.match(r'Heading\d$', style_val):
            continue

        # Extract heading text
        texts = []
        for t_elem in para.iter(f'{{{W}}}t'):
            if t_elem.text:
                texts.append(t_elem.text)
        heading_text = ''.join(texts).strip()
        if not heading_text:
            continue

        # Skip if already has bookmark
        if para.find(f'{{{W}}}bookmarkStart') is not None:
            continue

        # Generate bookmark
        bm_name = f"_Toc{bookmark_id_counter}"
        bm_id_str = str(bookmark_id_counter)
        bookmark_id_counter += 1

        # Store mapping (support duplicate headings)
        if heading_text not in heading_bookmark_map_all:
            heading_bookmark_map_all[heading_text] = []
        heading_bookmark_map_all[heading_text].append(bm_name)
        if heading_text not in heading_bookmark_map:
            heading_bookmark_map[heading_text] = bm_name

        # Insert bookmarkStart after pPr
        bm_start = etree.Element(f'{{{W}}}bookmarkStart')
        bm_start.set(f'{{{W}}}id', bm_id_str)
        bm_start.set(f'{{{W}}}name', bm_name)

        bm_end = etree.Element(f'{{{W}}}bookmarkEnd')
        bm_end.set(f'{{{W}}}id', bm_id_str)

        ppr_index = list(para).index(ppr)
        para.insert(ppr_index + 1, bm_start)
        # bookmarkEnd at end of paragraph
        para.append(bm_end)

    bookmarks_added = len(heading_bookmark_map)
    if bookmarks_added > 0:
        print(f"Added {bookmarks_added} bookmarks to Heading paragraphs")

    # ── Step 2: Find TOC field structure (begin → instrText → separate → end) ──
    toc_separate_para = None
    toc_end_para = None

    # Track field nesting to handle nested fields correctly
    field_stack = []
    toc_field_depth = None

    for fld_char in root.iter(f'{{{W}}}fldChar'):
        fld_type = fld_char.get(f'{{{W}}}fldCharType')
        run = fld_char.getparent()

        if fld_type == 'begin':
            para = run.getparent()
            instr_text = ''
            found_run = False
            for sibling in para:
                if sibling is run:
                    found_run = True
                    it = sibling.find(f'{{{W}}}instrText')
                    if it is not None and it.text:
                        instr_text += it.text
                    continue
                if found_run and sibling.tag == f'{{{W}}}r':
                    it = sibling.find(f'{{{W}}}instrText')
                    if it is not None and it.text:
                        instr_text += it.text
                    if sibling.find(f'{{{W}}}fldChar') is not None:
                        break

            field_stack.append(instr_text.strip())
            if 'TOC' in instr_text and toc_field_depth is None:
                toc_field_depth = len(field_stack)

        elif fld_type == 'separate':
            if toc_field_depth is not None and len(field_stack) == toc_field_depth:
                toc_separate_para = run.getparent()

        elif fld_type == 'end':
            if toc_field_depth is not None and len(field_stack) == toc_field_depth:
                toc_end_para = run.getparent()
                break
            if field_stack:
                field_stack.pop()

    if toc_separate_para is None or toc_end_para is None:
        has_begin = root.find(f'.//{{{W}}}fldChar[@{{{W}}}fldCharType="begin"]') is not None
        has_separate = root.find(f'.//{{{W}}}fldChar[@{{{W}}}fldCharType="separate"]') is not None
        if not has_begin:
            raise RuntimeError(
                "TOC FAILED: No field structure found in document. "
                "Ensure the code includes a TableOfContents element."
            )
        elif not has_separate:
            raise RuntimeError(
                "TOC FAILED: TOC field has 'begin' but no 'separate' fldChar. "
                "Run _fix_fld_char_structure() first or check the docx-js version."
            )
        else:
            raise RuntimeError(
                "TOC FAILED: Field structure found but no TOC instrText detected. "
                "Ensure TableOfContents element generates a TOC \\o field code."
            )

    # ── Step 3: Remove everything between separate-para and end-para ──
    # The TOC paragraphs may be direct children of <w:body> or wrapped in <w:sdt><w:sdtContent>
    toc_container = toc_separate_para.getparent()  # could be body or sdtContent
    container_children = list(toc_container)

    sep_idx = container_children.index(toc_separate_para)
    end_idx = container_children.index(toc_end_para)

    for elem in container_children[sep_idx + 1:end_idx]:
        toc_container.remove(elem)

    # ── Step 4: Build and insert placeholder paragraphs ──
    indent_mapping = {1: 0, 2: 360, 3: 720, 4: 1080, 5: 1440, 6: 1800}
    heading_occurrence_counter = {}

    insert_pos = list(toc_container).index(toc_end_para)

    for entry in entries:
        level = entry.get('level', 1)
        text_raw = entry.get('text', '')
        page = entry.get('page', '1')

        toc_style = toc_style_mapping.get(level, toc_style_mapping.get(1, "9"))
        indent = indent_mapping.get(level, 0)

        # Resolve bookmark (handle duplicate headings correctly)
        bm_name = ''
        if text_raw in heading_bookmark_map_all:
            occ = heading_occurrence_counter.get(text_raw, 0)
            bm_list = heading_bookmark_map_all[text_raw]
            if occ < len(bm_list):
                bm_name = bm_list[occ]
            heading_occurrence_counter[text_raw] = occ + 1

        # Build paragraph element
        p = etree.Element(f'{{{W}}}p')
        toc_container.insert(insert_pos, p)
        insert_pos += 1

        # pPr
        ppr = etree.SubElement(p, f'{{{W}}}pPr')
        pstyle = etree.SubElement(ppr, f'{{{W}}}pStyle')
        pstyle.set(f'{{{W}}}val', str(toc_style))
        if indent > 0:
            ind = etree.SubElement(ppr, f'{{{W}}}ind')
            ind.set(f'{{{W}}}left', str(indent))
        tabs = etree.SubElement(ppr, f'{{{W}}}tabs')
        tab = etree.SubElement(tabs, f'{{{W}}}tab')
        tab.set(f'{{{W}}}val', 'right')
        tab.set(f'{{{W}}}leader', 'dot')
        tab.set(f'{{{W}}}pos', '9026')
        spacing = etree.SubElement(ppr, f'{{{W}}}spacing')
        spacing.set(f'{{{W}}}before', '120')
        spacing.set(f'{{{W}}}after', '60')

        if bm_name:
            hyperlink = etree.SubElement(p, f'{{{W}}}hyperlink')
            hyperlink.set(f'{{{W}}}anchor', bm_name)
            hyperlink.set(f'{{{W}}}history', '1')

            r_text = etree.SubElement(hyperlink, f'{{{W}}}r')
            rpr = etree.SubElement(r_text, f'{{{W}}}rPr')
            rstyle = etree.SubElement(rpr, f'{{{W}}}rStyle')
            rstyle.set(f'{{{W}}}val', 'Hyperlink')
            t = etree.SubElement(r_text, f'{{{W}}}t')
            t.text = text_raw

            r_tab = etree.SubElement(hyperlink, f'{{{W}}}r')
            etree.SubElement(r_tab, f'{{{W}}}tab')

            r_begin = etree.SubElement(hyperlink, f'{{{W}}}r')
            fc_begin = etree.SubElement(r_begin, f'{{{W}}}fldChar')
            fc_begin.set(f'{{{W}}}fldCharType', 'begin')

            r_instr = etree.SubElement(hyperlink, f'{{{W}}}r')
            instr = etree.SubElement(r_instr, f'{{{W}}}instrText')
            instr.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
            instr.text = f' PAGEREF {bm_name} \\h '

            r_sep = etree.SubElement(hyperlink, f'{{{W}}}r')
            fc_sep = etree.SubElement(r_sep, f'{{{W}}}fldChar')
            fc_sep.set(f'{{{W}}}fldCharType', 'separate')

            r_page = etree.SubElement(hyperlink, f'{{{W}}}r')
            t_page = etree.SubElement(r_page, f'{{{W}}}t')
            t_page.text = str(page)

            r_end = etree.SubElement(hyperlink, f'{{{W}}}r')
            fc_end = etree.SubElement(r_end, f'{{{W}}}fldChar')
            fc_end.set(f'{{{W}}}fldCharType', 'end')
        else:
            r_text = etree.SubElement(p, f'{{{W}}}r')
            t = etree.SubElement(r_text, f'{{{W}}}t')
            t.text = text_raw

            r_tab = etree.SubElement(p, f'{{{W}}}r')
            etree.SubElement(r_tab, f'{{{W}}}tab')

            r_page = etree.SubElement(p, f'{{{W}}}r')
            t_page = etree.SubElement(r_page, f'{{{W}}}t')
            t_page.text = str(page)

    placeholders_inserted = len(entries)
    print(f"Inserted {placeholders_inserted} TOC placeholder entries")

    # Serialize back to string
    result = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
    return result.decode('utf-8')


def main():
    parser = argparse.ArgumentParser(
        description='Add placeholder entries to Table of Contents in a DOCX file (in-place)'
    )
    parser.add_argument('docx_file', help='DOCX file to modify (will be replaced)')
    parser.add_argument(
        '--auto', action='store_true',
        help='Auto-extract Heading 1-3 from the DOCX as TOC entries (recommended)'
    )
    parser.add_argument(
        '--entries',
        help='JSON string with placeholder entries: [{"level":1,"text":"Chapter 1","page":"1"}]'
    )

    args = parser.parse_args()

    # Determine entries
    entries = None
    if args.entries:
        try:
            entries = json.loads(args.entries)
        except json.JSONDecodeError as e:
            print(f"Error parsing entries JSON: {e}", file=sys.stderr)
            sys.exit(1)
    elif args.auto or True:
        # Default to auto mode — always extract from document headings
        entries = _extract_headings_from_docx(args.docx_file)
        if entries:
            print(f"Auto-extracted {len(entries)} headings from document", file=sys.stderr)
        else:
            print("No headings found in document, using minimal placeholder", file=sys.stderr)
            entries = [{"level": 1, "text": "Contents", "page": "1"}]

    # Add placeholders
    try:
        add_toc_placeholders(args.docx_file, entries)
        print(f"Successfully added TOC placeholders to {args.docx_file}")
    except RuntimeError as e:
        # TOC structure errors — hard fail with exit code 1
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
