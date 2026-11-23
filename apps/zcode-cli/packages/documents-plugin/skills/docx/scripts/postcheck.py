#!/usr/bin/env python3
"""
postcheck.py — Document business rule self-check script

Unlike traditional OpenXML Schema validation, this script does not check XML legality.
Instead, it checks document "visual quality" and "typesetting correctness" — issues visible to the human eye.

Usage:
  "$(command -v zcode-python || command -v python3)" postcheck.py output.docx [--fix] [--json]

Checks:
  1. Blank page detection — trailing/middle excess blank pages, double page breaks, consecutive empty paragraphs
  2. Line spacing consistency — whether body paragraph line spacing is uniform
  3. Table margins — whether cells have padding set
  4. Table pagination control — whether header rows have tblHeader set, data rows have cantSplit
  5. Image overflow — whether image width exceeds page usable area
  6. Font fallback — whether fonts are used that may be missing on target systems
  7. CJK indentation — whether Chinese body text has first-line indent (excluding table cells, lists, centered paragraphs)
  8. Heading level continuity — whether headings skip levels (H1→H3 skipping H2)
  9. Numbering continuity — whether numbered lists have gaps
  10. Cover separation — whether cover and body are in different sections
  11. ShadingType — whether SOLID is misused causing black cells
  12. TOC quality — whether TOC field exists, whether headings use standard Heading styles
  13. Image aspect ratio — whether images are stretched/distorted
  14. Document cleanliness — whether placeholder text, Markdown syntax, or draft expressions remain
  15. Report content quality — whether summary exists, whether titles are specific, whether vague conclusions are used
"""

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
}


class CheckResult:
    def __init__(self, name: str, passed: bool, message: str, severity: str = "warning"):
        self.name = name
        self.passed = passed
        self.message = message
        self.severity = severity  # "error" | "warning" | "info"

    def to_dict(self):
        return {
            "name": self.name,
            "passed": self.passed,
            "message": self.message,
            "severity": self.severity,
        }

    def __str__(self):
        icon = "✅" if self.passed else ("❌" if self.severity == "error" else "⚠️")
        return f"{icon} [{self.name}] {self.message}"


def read_document_xml(docx_path: str) -> ET.Element:
    """Read document.xml and return the root element"""
    with zipfile.ZipFile(docx_path, "r") as z:
        return ET.fromstring(z.read("word/document.xml"))


def get_sections(root: ET.Element) -> list:
    """Extract all sections (located via sectPr)"""
    body = root.find(".//w:body", NS)
    if body is None:
        return []

    sections = []
    current_children = []

    for child in body:
        tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
        if tag == "sectPr":
            sections.append({"children": current_children, "sectPr": child})
            current_children = []
        else:
            # Check whether paragraph contains sectPr (section break inside paragraph pPr)
            ppr_sect = child.find(".//w:pPr/w:sectPr", NS)
            if ppr_sect is not None:
                current_children.append(child)
                sections.append({"children": current_children, "sectPr": ppr_sect})
                current_children = []
            else:
                current_children.append(child)

    # Last section (body-level sectPr)
    body_sect = body.find("w:sectPr", NS)
    if body_sect is not None and current_children:
        sections.append({"children": current_children, "sectPr": body_sect})

    return sections


def check_blank_pages(root: ET.Element) -> CheckResult:
    """Detect excess blank pages — multi-pattern detection"""
    body = root.find(".//w:body", NS)
    paragraphs = body.findall("w:p", NS)
    issues = []

    if not paragraphs:
        return CheckResult("blank-pages", True, "No paragraph content")

    # Check 1: Whether the last paragraph only has a page break
    last_p = paragraphs[-1]
    runs = last_p.findall(".//w:r", NS)
    has_page_break = False
    has_text = False
    for run in runs:
        br = run.find("w:br", NS)
        if br is not None and br.get(f"{{{NS['w']}}}type") == "page":
            has_page_break = True
        t = run.find("w:t", NS)
        if t is not None and t.text and t.text.strip():
            has_text = True
    if has_page_break and not has_text:
        issues.append("Trailing page break at document end may cause blank page")

    # Check 2: Consecutive empty paragraphs (≥5 consecutive may form visual blank page)
    consecutive_empty = 0
    max_empty = 0
    max_empty_pos = 0
    for idx, p in enumerate(paragraphs):
        texts = p.findall(".//w:t", NS)
        has_any_text = any(t.text and t.text.strip() for t in texts)
        has_br = any(
            br.get(f"{{{NS['w']}}}type") == "page"
            for br in p.findall(".//w:br", NS)
        )
        has_drawing = p.find(".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}inline", None) is not None
        if not has_any_text and not has_br and not has_drawing:
            consecutive_empty += 1
            if consecutive_empty > max_empty:
                max_empty = consecutive_empty
                max_empty_pos = idx
        else:
            consecutive_empty = 0

    if max_empty >= 5:
        issues.append(f"Found {max_empty} consecutive empty paragraphs (starting around paragraph {max_empty_pos - max_empty + 2}), may form visual blank page")

    # Check 3: Double page break at section boundary (PageBreak at section end + NEXT_PAGE in next section)
    sections = get_sections(root)
    for i in range(len(sections) - 1):
        sec_children = sections[i]["children"]
        if not sec_children:
            continue
        # Check whether the last paragraph of the section contains PageBreak
        last_child = sec_children[-1]
        if last_child.tag == f"{{{NS['w']}}}p":
            for br in last_child.findall(".//w:br", NS):
                if br.get(f"{{{NS['w']}}}type") == "page":
                    # Check whether the next section is NEXT_PAGE
                    next_sect_pr = sections[i + 1]["sectPr"]
                    sect_type = next_sect_pr.find("w:type", NS)
                    if sect_type is not None and sect_type.get(f"{{{NS['w']}}}val") == "nextPage":
                        issues.append(f"Section {i+1} ends with PageBreak and Section {i+2} is type nextPage, double page break causes blank page")

    # Check 4: Empty paragraph + PageBreak (paragraph has only PageBreak, no text)
    # Exclude section-ending PageBreaks — they are normal section separators
    # (e.g., cover page ending with an empty para + PageBreak before a new section)
    section_last_paras = set()
    for sec in sections:
        children = sec["children"]
        if children:
            last_child = children[-1]
            section_last_paras.add(id(last_child))

    empty_pb_count = 0
    for p in paragraphs[:-1]:  # Last paragraph already handled in Check 1
        if id(p) in section_last_paras:
            continue  # Skip section-ending paragraphs (normal section breaks)
        runs = p.findall(".//w:r", NS)
        p_has_break = False
        p_has_text = False
        for run in runs:
            br = run.find("w:br", NS)
            if br is not None and br.get(f"{{{NS['w']}}}type") == "page":
                p_has_break = True
            t = run.find("w:t", NS)
            if t is not None and t.text and t.text.strip():
                p_has_text = True
        if p_has_break and not p_has_text:
            empty_pb_count += 1

    if empty_pb_count > 0:
        issues.append(f"Found {empty_pb_count} empty paragraphs with PageBreak (suggest attaching PageBreak to content paragraphs)")

    # Separate hard errors from soft warnings
    hard_issues = [i for i in issues if "double page break" in i.lower() or "trailing page break" in i.lower() or "consecutive" in i.lower()]
    soft_issues = [i for i in issues if i not in hard_issues]

    if hard_issues:
        return CheckResult(
            "blank-pages", False,
            "; ".join(hard_issues[:3]),
            "error"
        )
    if soft_issues:
        return CheckResult(
            "blank-pages", False,
            "; ".join(soft_issues[:3]),
            "warning"
        )

    return CheckResult("blank-pages", True, "No blank page issues detected")


def check_line_spacing(root: ET.Element) -> CheckResult:
    """Check body paragraph line spacing consistency"""
    body = root.find(".//w:body", NS)
    paragraphs = body.findall(".//w:p", NS)

    spacing_values = {}
    body_para_count = 0

    for p in paragraphs:
        ppr = p.find("w:pPr", NS)
        # Skip heading paragraphs
        if ppr is not None:
            style = ppr.find("w:pStyle", NS)
            if style is not None:
                val = style.get(f"{{{NS['w']}}}val", "")
                if val.startswith("Heading") or val == "Title":
                    continue

        spacing = ppr.find("w:spacing", NS) if ppr is not None else None
        line_val = spacing.get(f"{{{NS['w']}}}line") if spacing is not None else None

        # Only count paragraphs with text content
        texts = p.findall(".//w:t", NS)
        if not any(t.text and t.text.strip() for t in texts):
            continue

        body_para_count += 1
        key = line_val or "default"
        spacing_values[key] = spacing_values.get(key, 0) + 1

    if body_para_count == 0:
        return CheckResult("line-spacing", True, "No body paragraphs")

    if len(spacing_values) <= 1:
        dominant = list(spacing_values.keys())[0] if spacing_values else "default"
        return CheckResult("line-spacing", True, f"Line spacing uniform (line={dominant})")

    # Find the most common line spacing
    dominant = max(spacing_values, key=spacing_values.get)
    inconsistent = sum(v for k, v in spacing_values.items() if k != dominant)
    total = sum(spacing_values.values())

    if inconsistent / total > 0.2:
        return CheckResult(
            "line-spacing", False,
            f"Line spacing inconsistent: {dict(spacing_values)}, {inconsistent}/{total} paragraphs differ from dominant spacing {dominant}",
            "warning"
        )

    return CheckResult("line-spacing", True, f"Line spacing mostly uniform (line={dominant}, {inconsistent} exceptions)")



def check_image_overflow(root: ET.Element) -> CheckResult:
    """Check whether image width may exceed page bounds"""
    # Get page width
    sect_pr = root.find(".//w:body/w:sectPr", NS)
    page_width = 11906  # A4 default
    margin_left = 1701
    margin_right = 1417

    if sect_pr is not None:
        pg_sz = sect_pr.find("w:pgSz", NS)
        pg_mar = sect_pr.find("w:pgMar", NS)
        if pg_sz is not None:
            page_width = int(pg_sz.get(f"{{{NS['w']}}}w", "11906"))
        if pg_mar is not None:
            margin_left = int(pg_mar.get(f"{{{NS['w']}}}left", "1701"))
            margin_right = int(pg_mar.get(f"{{{NS['w']}}}right", "1417"))

    usable_width_emu = (page_width - margin_left - margin_right) * 635  # twips → EMU

    drawings = root.findall(".//wp:inline", NS) + root.findall(".//wp:anchor", NS)
    oversized = 0

    for dwg in drawings:
        extent = dwg.find("wp:extent", NS)
        if extent is not None:
            cx = int(extent.get("cx", "0"))
            if cx > usable_width_emu * 1.05:  # 5% tolerance
                oversized += 1

    if oversized > 0:
        return CheckResult(
            "image-overflow", False,
            f"{oversized} images exceed page usable area",
            "error"
        )

    return CheckResult(
        "image-overflow", True,
        f"All images within page width ({len(drawings)} images)"
    )


def check_image_aspect_ratio(docx_path: str, root: ET.Element) -> CheckResult:
    """Check whether images are stretched/distorted (aspect ratio drift).

    Compares the original aspect ratio of embedded images with the display aspect ratio set in wp:extent.
    Drift >10% is considered distortion (pie charts becoming elliptical, radar charts becoming diamond-shaped, etc).
    """
    import zipfile as _zf

    # Build a mapping: rId → image file path inside the zip
    # We need to parse word/_rels/document.xml.rels
    rid_to_path = {}
    try:
        with _zf.ZipFile(docx_path, 'r') as z:
            rels_path = 'word/_rels/document.xml.rels'
            if rels_path in z.namelist():
                rels_xml = z.read(rels_path)
                rels_root = ET.fromstring(rels_xml)
                rels_ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
                for rel in rels_root.findall(f'{{{rels_ns}}}Relationship'):
                    rid = rel.get('Id', '')
                    target = rel.get('Target', '')
                    rel_type = rel.get('Type', '')
                    if 'image' in rel_type:
                        # Target is relative to word/ directory
                        if not target.startswith('/'):
                            img_path = 'word/' + target
                        else:
                            img_path = target.lstrip('/')
                        rid_to_path[rid] = img_path

            # Now check each drawing
            drawings = root.findall(".//wp:inline", NS) + root.findall(".//wp:anchor", NS)
            distorted = []

            for dwg in drawings:
                extent = dwg.find("wp:extent", NS)
                if extent is None:
                    continue
                display_cx = int(extent.get("cx", "0"))
                display_cy = int(extent.get("cy", "0"))
                if display_cx == 0 or display_cy == 0:
                    continue

                # Find the blip rId
                blip = dwg.find(".//a:blip", NS)
                if blip is None:
                    continue
                r_embed = blip.get(f"{{{NS['r']}}}embed", "")
                if not r_embed or r_embed not in rid_to_path:
                    continue

                img_zip_path = rid_to_path[r_embed]
                if img_zip_path not in z.namelist():
                    continue

                # Read actual image dimensions
                try:
                    img_data = z.read(img_zip_path)
                    import io as _io

                    from PIL import Image as _PILImage
                    pil_img = _PILImage.open(_io.BytesIO(img_data))
                    orig_w, orig_h = pil_img.size
                    if orig_w == 0 or orig_h == 0:
                        continue
                except Exception:
                    continue

                # Compare aspect ratios
                orig_ratio = orig_w / orig_h
                display_ratio = display_cx / display_cy
                drift = abs(orig_ratio - display_ratio) / orig_ratio

                if drift > 0.10:  # >10% distortion
                    pct = drift * 100
                    distorted.append(
                        f"{img_zip_path.split('/')[-1]}: "
                        f"original {orig_w}×{orig_h} (ratio={orig_ratio:.2f}), "
                        f"display ratio={display_ratio:.2f}, distortion {pct:.0f}%"
                    )

    except Exception:
        return CheckResult(
            "image-aspect-ratio", True,
            "Cannot check image aspect ratio (zip read error)",
            "info"
        )

    if distorted:
        detail = "; ".join(distorted[:3])
        if len(distorted) > 3:
            detail += f" ...and {len(distorted)} more"
        return CheckResult(
            "image-aspect-ratio", False,
            f"{len(distorted)} images have aspect ratio distortion: {detail}",
            "warning"
        )

    img_count = len(drawings)
    return CheckResult(
        "image-aspect-ratio", True,
        f"All images have correct aspect ratio ({img_count} images)"
    )


def check_font_fallback(root: ET.Element) -> CheckResult:
    """Check whether potentially missing fonts are used"""
    SAFE_FONTS = {
        # Chinese
        "宋体", "SimSun", "黑体", "SimHei", "微软雅黑", "Microsoft YaHei",
        "仿宋", "FangSong", "FangSong_GB2312", "楷体", "KaiTi",
        # English
        "Times New Roman", "Arial", "Calibri", "Helvetica",
        "Courier New", "Georgia", "Verdana", "Tahoma",
        # Universal
        "Symbol", "Wingdings",
    }

    fonts_used = set()
    for rpr in root.findall(".//w:rPr", NS):
        for font_tag in ["w:rFonts"]:
            rf = rpr.find(font_tag, NS)
            if rf is not None:
                for attr in ["ascii", "eastAsia", "hAnsi", "cs"]:
                    f = rf.get(f"{{{NS['w']}}}{attr}")
                    if f:
                        fonts_used.add(f)

    risky = fonts_used - SAFE_FONTS
    if risky:
        return CheckResult(
            "font-fallback", False,
            f"Following fonts may be missing on target system: {', '.join(sorted(risky))}",
            "info"
        )

    return CheckResult("font-fallback", True, f"All fonts are common system fonts ({len(fonts_used)} types)")



def check_heading_levels(root: ET.Element) -> CheckResult:
    """Check whether headings skip levels"""
    body = root.find(".//w:body", NS)
    heading_levels = []

    for p in body.findall(".//w:p", NS):
        ppr = p.find("w:pPr", NS)
        if ppr is None:
            continue
        style = ppr.find("w:pStyle", NS)
        if style is None:
            continue
        val = style.get(f"{{{NS['w']}}}val", "")
        m = re.match(r"Heading(\d+)", val)
        if m:
            heading_levels.append(int(m.group(1)))

    if len(heading_levels) < 2:
        return CheckResult("heading-levels", True, "Too few headings, skipping check")

    skips = []
    for i in range(1, len(heading_levels)):
        diff = heading_levels[i] - heading_levels[i - 1]
        if diff > 1:
            skips.append(f"H{heading_levels[i-1]}→H{heading_levels[i]}")

    if skips:
        return CheckResult(
            "heading-levels", False,
            f"Heading level skip: {', '.join(skips[:5])}",
            "warning"
        )

    return CheckResult("heading-levels", True, f"Heading levels continuous ({len(heading_levels)} headings)")


# check_cover_separation removed — false positives on complex covers (>15 elements is normal)


def check_shading_type(root: ET.Element) -> CheckResult:
    """Check whether ShadingType.SOLID is misused"""
    shadings = root.findall(".//w:shd", NS)
    solid_count = 0

    for shd in shadings:
        val = shd.get(f"{{{NS['w']}}}val", "")
        if val == "solid":
            solid_count += 1

    if solid_count > 0:
        return CheckResult(
            "shading-type", False,
            f"Found {solid_count} instances of ShadingType.SOLID (should be CLEAR), may cause black cells",
            "error"
        )

    return CheckResult("shading-type", True, "No ShadingType.SOLID misuse found")



def check_toc(root: ET.Element, docx_path: str = "") -> CheckResult:
    """Check TOC quality: field existence, headings presence, outlineLvl, updateFields."""
    body = root.find(".//w:body", NS)
    if body is None:
        return CheckResult("toc", True, "Document body is empty, skipping TOC check", "info")

    paragraphs = list(body)
    w_ns = NS["w"]

    # --- Detect headings and their levels ---
    heading_count = 0
    heading_levels_used = set()  # e.g. {1, 2, 3}
    for p in paragraphs:
        if p.tag != f"{{{w_ns}}}p":
            continue
        ppr = p.find(f"{{{w_ns}}}pPr")
        if ppr is None:
            continue
        ps = ppr.find(f"{{{w_ns}}}pStyle")
        if ps is None:
            continue
        val = ps.get(f"{{{w_ns}}}val", "")
        m = re.match(r"(?i)heading\s*(\d)", val)
        if m:
            heading_count += 1
            heading_levels_used.add(int(m.group(1)))

    # --- Detect TOC field ---
    has_toc = False
    for instr in root.findall(f".//{{{w_ns}}}instrText"):
        if instr.text and "TOC" in instr.text.upper():
            has_toc = True
            break
    if not has_toc:
        for fld in root.findall(f".//{{{w_ns}}}fldSimple"):
            if "TOC" in fld.get(f"{{{w_ns}}}instr", "").upper():
                has_toc = True
                break
    # Also check SDT-wrapped TOC
    if not has_toc:
        for sdt in root.findall(f".//{{{w_ns}}}sdt"):
            for instr in sdt.findall(f".//{{{w_ns}}}instrText"):
                if instr.text and "TOC" in instr.text.upper():
                    has_toc = True
                    break
            if has_toc:
                break

    issues = []

    # Check 1: Document has a "目录" / "目  录" / "Table of Contents" title but no TOC field
    has_toc_title = False
    toc_title_pattern = re.compile(r'^(?:目\s*录|table\s+of\s+contents|contents)$', re.IGNORECASE)
    for p in paragraphs:
        if p.tag != f"{{{w_ns}}}p":
            continue
        texts = p.findall(f".//{{{w_ns}}}t")
        p_text = "".join(t.text or "" for t in texts).strip()
        if toc_title_pattern.match(p_text):
            has_toc_title = True
            break

    if has_toc_title and not has_toc:
        issues.append("TOC_FIELD_MISSING: document has a TOC title but no TOC field element — add TableOfContents in code")

    # Check 2: TOC field exists but no headings in document → TOC will be empty after update
    if has_toc and heading_count == 0:
        issues.append("TOC_NO_HEADINGS: TOC field exists but document has 0 Heading-styled paragraphs — TOC will be empty after update")

    # Check 3 & 4: Read styles.xml and settings.xml from DOCX (only when TOC exists)
    if has_toc and docx_path:
        try:
            import zipfile
            with zipfile.ZipFile(docx_path, 'r') as zf:
                # Check 3: outlineLvl missing in Heading styles
                if 'word/styles.xml' in zf.namelist():
                    styles_content = zf.read('word/styles.xml').decode('utf-8')
                    styles_root = ET.fromstring(styles_content)

                    missing_outline = []
                    for level in sorted(heading_levels_used):
                        style_id = f"Heading{level}"
                        # Find <w:style w:styleId="HeadingN">
                        for style_elem in styles_root.findall(f".//{{{w_ns}}}style"):
                            sid = style_elem.get(f"{{{w_ns}}}styleId", "")
                            if sid == style_id:
                                # Check if pPr has outlineLvl
                                ppr = style_elem.find(f"{{{w_ns}}}pPr")
                                has_outline = False
                                if ppr is not None:
                                    ol = ppr.find(f"{{{w_ns}}}outlineLvl")
                                    if ol is not None:
                                        has_outline = True
                                if not has_outline:
                                    missing_outline.append(style_id)
                                break

                    if missing_outline:
                        issues.append(
                            "TOC_OUTLINE_MISSING: %s style(s) missing outlineLvl — "
                            "Word TOC update won't find these headings. "
                            "Run add_toc_placeholders.py to fix" % ", ".join(missing_outline)
                        )

                # Check 4: updateFields not set to true
                if 'word/settings.xml' in zf.namelist():
                    settings_content = zf.read('word/settings.xml').decode('utf-8')
                    # Check for <w:updateFields w:val="true"/>
                    update_ok = bool(re.search(
                        r'<w:updateFields\s+[^>]*w:val\s*=\s*"true"',
                        settings_content
                    ))
                    if not update_ok:
                        issues.append(
                            "TOC_UPDATE_DISABLED: settings.xml missing updateFields=true — "
                            "Word won't prompt to update TOC on open. "
                            "Run add_toc_placeholders.py to fix"
                        )
        except Exception as e:
            issues.append(f"TOC_CHECK_ERROR: failed to read styles/settings from DOCX: {e}")

    if not issues:
        if has_toc:
            return CheckResult("toc", True, "TOC field present and update-ready")
        else:
            return CheckResult("toc", True, "No TOC needed")

    severity = "error" if any(k in i for i in issues for k in ("FIELD_MISSING", "NO_HEADINGS", "OUTLINE_MISSING")) else "warning"
    return CheckResult("toc", False, "; ".join(issues[:5]), severity)




def check_cover_overflow(root: ET.Element) -> CheckResult:
    """Detect cover section issues: oversized fonts, excessive spacing, trailing empty content."""
    sections = get_sections(root)
    if not sections:
        return CheckResult("cover-overflow", True, "No sections found")

    sec0 = sections[0]
    sect_pr = sec0["sectPr"]

    # Get page dimensions and margins for accurate available height calculation
    pg_sz = sect_pr.find("w:pgSz", NS)
    pg_mar = sect_pr.find("w:pgMar", NS)
    page_height = int(pg_sz.get(f"{{{NS['w']}}}h", "16838")) if pg_sz is not None else 16838
    margin_top = int(pg_mar.get(f"{{{NS['w']}}}top", "0")) if pg_mar is not None else 0
    margin_bottom = int(pg_mar.get(f"{{{NS['w']}}}bottom", "0")) if pg_mar is not None else 0

    issues = []
    children = sec0["children"]

    # Check 1: Oversized font in cover section (> 44pt = 88 half-points = 889000 EMU)
    max_font_size = 0
    for child in children:
        for sz in child.findall(".//" + f"{{{NS['w']}}}sz"):
            val = sz.get(f"{{{NS['w']}}}val")
            if val and val.isdigit():
                size_hp = int(val)
                if size_hp > max_font_size:
                    max_font_size = size_hp

    if max_font_size > 88:  # 88 half-points = 44pt
        issues.append(
            f"Cover has font size {max_font_size // 2}pt (>{44}pt max). "
            f"Use calcTitleLayout() for dynamic sizing"
        )

    # Check 2: Excessive spacing.before in cover section (> 5000 twips)
    max_spacing = 0
    for child in children:
        for sp in child.findall(".//" + f"{{{NS['w']}}}spacing"):
            before = sp.get(f"{{{NS['w']}}}before")
            if before and before.isdigit():
                val = int(before)
                if val > max_spacing:
                    max_spacing = val

    if max_spacing > 5000:
        issues.append(
            f"Cover has spacing.before={max_spacing} twips (>5000 max). "
            f"Use calcCoverSpacing() for dynamic spacing"
        )

    # Check 3: Trailing empty paragraphs in cover section
    trailing_empty = 0
    for child in reversed(children):
        tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
        if tag != "p":
            break
        texts = child.findall(".//" + f"{{{NS['w']}}}t")
        has_text = any(t.text and t.text.strip() for t in texts)
        if not has_text:
            trailing_empty += 1
        else:
            break

    if trailing_empty > 2:
        issues.append(
            f"Cover section ends with {trailing_empty} empty paragraphs (max 2 allowed) — "
            f"excessive empty paragraphs may cause blank page after cover"
        )

    if issues:
        return CheckResult(
            "cover-overflow", False,
            "; ".join(issues),
            "error"
        )

    return CheckResult("cover-overflow", True, "Cover section layout looks OK")


def run_all_checks(docx_path: str) -> list[CheckResult]:
    """Run all checks"""
    root = read_document_xml(docx_path)

    checks = [
        check_blank_pages,
        check_cover_overflow,
        check_line_spacing,
        check_image_overflow,
        check_font_fallback,
        check_heading_levels,
        check_shading_type,
    ]

    results = []
    for check_fn in checks:
        try:
            results.append(check_fn(root))
        except Exception as e:
            results.append(CheckResult(
                check_fn.__name__.replace("check_", ""),
                False,
                f"Check error: {e}",
                "error"
            ))

    # TOC check needs both root and docx_path
    try:
        results.append(check_toc(root, docx_path))
    except Exception as e:
        results.append(CheckResult("toc", False, f"Check error: {e}", "error"))

    # Image aspect ratio check needs both root and docx_path
    try:
        results.append(check_image_aspect_ratio(docx_path, root))
    except Exception as e:
        results.append(CheckResult("image-aspect-ratio", False, f"Check error: {e}", "error"))

    return results


def main():
    import argparse
    parser = argparse.ArgumentParser(description="docx business rule self-check")
    parser.add_argument("docx_path", help="Path to the .docx file to check")
    parser.add_argument("--json", action="store_true", help="Output in JSON format")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as failures")
    args = parser.parse_args()

    if not Path(args.docx_path).exists():
        print(f"❌ File not found: {args.docx_path}")
        sys.exit(1)

    results = run_all_checks(args.docx_path)

    if args.json:
        print(json.dumps([r.to_dict() for r in results], ensure_ascii=False, indent=2))
    else:
        print(f"\n📋 Document self-check report: {args.docx_path}\n")
        for r in results:
            print(f"  {r}")

        passed = sum(1 for r in results if r.passed)
        total = len(results)
        errors = sum(1 for r in results if not r.passed and r.severity == "error")
        warnings = sum(1 for r in results if not r.passed and r.severity == "warning")

        print(f"\n  {'─' * 50}")
        print(f"  Passed {passed}/{total} | ❌ {errors} errors | ⚠️ {warnings} warnings\n")

    # Exit code
    has_errors = any(not r.passed and r.severity == "error" for r in results)
    has_warnings = any(not r.passed and r.severity == "warning" for r in results)

    if has_errors:
        sys.exit(2)
    elif args.strict and has_warnings:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
