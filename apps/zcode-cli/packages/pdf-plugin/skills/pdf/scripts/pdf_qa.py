#!/usr/bin/env python3
"""
PDF Quality Assurance Checker
=============================
Automatically detects common typesetting issues in PDFs.

Usage: "$(command -v zcode-python || command -v python3)" pdf_qa.py <pdf_path>

Checks:
  1. Page size consistency across all pages
  2. Blank page detection
  3. CJK punctuation placement (line-start/end forbidden punctuation)
  4. Color analysis (informational only — counts and lists colors)
  5. Font embedding check (warns on non-embedded fonts)
  6. PDF metadata check (title/author/creator)
  7. Content overflow detection (text exceeding page boundaries)
  8. Content fill ratio per page (multi-page docs, warns if < 40%)
  9. Cover/poster full-bleed check (background extends to page edges)
 10. Margin symmetry check (left/right text margins)
 11. Table centering check (if detected)
 12. Formula overflow check (optional)
"""

import os
import re
import sys

try:
    import pymupdf  # PyMuPDF
except ImportError:
    import fitz as pymupdf

# ============================================================
# Config
# ============================================================

# CJK punctuation forbidden at line start
LINE_START_FORBIDDEN = set(
    "。、，；：！？）】〛〉」』"
    "\u201c\u201d"  # "" curly double quotes
    "\u2026"        # … ellipsis
    "\u2014"        # — em dash
    "\uff5e"        # ～ fullwidth tilde
    "\u00b7"        # · middle dot
)

# CJK punctuation forbidden at line end
LINE_END_FORBIDDEN = set(
    "（【《〈「"
    "\u2018\u2019"  # '' curly single quotes
    "\u201c"        # " left curly double quote
)

# Minimum fill ratio for last page (DISABLED — caused false positives)
# LAST_PAGE_MIN_FILL = 0.40

# Maximum allowed color count — REMOVED (color count is now info-only)
# MAX_COLORS = 8

# ============================================================
# Checks
# ============================================================

class QAResult:
    def __init__(self):
        self.issues = []     # (severity, category, message)
        self.passes = []     # passed checks
        self.info = []       # informational

    def error(self, cat, msg):
        self.issues.append(('ERROR', cat, msg))

    def warn(self, cat, msg):
        self.issues.append(('WARN', cat, msg))

    def ok(self, msg):
        self.passes.append(msg)

    def add_info(self, msg):
        self.info.append(msg)


def check_last_page_fill(doc, result):
    """Check content fill ratio of the last page"""
    if len(doc) < 2:
        result.ok("Single-page document, no last-page blank check needed")
        return

    last_page = doc[-1]
    page_rect = last_page.rect
    page_area = page_rect.width * page_rect.height

    # Get bounding boxes of all content on last page
    blocks = last_page.get_text("blocks")
    if not blocks:
        result.error("Last page blank", f"Page {len(doc)} (last page) has no content at all!")
        return

    # Calculate max y-coordinate covered by content
    max_y = 0
    min_y = page_rect.height
    for b in blocks:
        if b[4].strip():  # Has text content
            min_y = min(min_y, b[1])
            max_y = max(max_y, b[3])

    if max_y == 0:
        result.error("Last page blank", f"Page {len(doc)} (last page) has no valid text content")
        return

    content_height = max_y - min_y
    fill_ratio = content_height / page_rect.height

    result.add_info(f"Last page fill ratio: {fill_ratio:.0%} (content height {content_height:.0f}px / page height {page_rect.height:.0f}px)")

    if fill_ratio < 0.25:
        result.error("Last page blank", f"Last page fill ratio only {fill_ratio:.0%}, mostly blank! Consider compressing preceding page spacing or trimming content")
    elif fill_ratio < LAST_PAGE_MIN_FILL:
        result.warn("Last page blank", f"Last page fill ratio {fill_ratio:.0%}, somewhat sparse — optimization recommended")
    else:
        result.ok(f"Last page fill ratio {fill_ratio:.0%} ✓")


def check_punctuation(doc, result):
    """Check CJK punctuation placement rules"""
    violations = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        # Extract text by line
        text_dict = page.get_text("dict")

        for block in text_dict.get("blocks", []):
            if block.get("type") != 0:  # Only check text blocks
                continue
            for line in block.get("lines", []):
                line_text = ""
                for span in line.get("spans", []):
                    line_text += span.get("text", "")

                line_text = line_text.strip()
                if not line_text:
                    continue

                # Check line start
                first_char = line_text[0]
                if first_char in LINE_START_FORBIDDEN:
                    violations.append((page_num + 1, f"Forbidden line-start punctuation '{first_char}': ...{line_text[:30]}"))

                # Check line end
                last_char = line_text[-1] if len(line_text) > 0 else ''
                if last_char in LINE_END_FORBIDDEN:
                    violations.append((page_num + 1, f"Forbidden line-end punctuation '{last_char}': {line_text[-30:]}..."))

    if violations:
        # Show at most 10
        shown = violations[:10]
        for page_num, desc in shown:
            result.warn("Punctuation rules", f"Page {page_num} - {desc}")
        if len(violations) > 10:
            result.warn("Punctuation rules", f"...{len(violations) - 10} more violations")
    else:
        result.ok("Punctuation placement check passed ✓")


def check_blank_pages(doc, result):
    """Check for completely blank pages"""
    blank_pages = []
    for i in range(len(doc)):
        page = doc[i]
        text = page.get_text().strip()
        # Also check for images
        images = page.get_images()
        drawings = page.get_drawings()

        if not text and not images and not drawings:
            blank_pages.append(i + 1)

    if blank_pages:
        result.error("Blank pages", f"Found blank pages: {blank_pages}")
    else:
        result.ok("No blank pages ✓")


def check_colors(doc, result):
    """Analyze colors used in the document (informational only, no pass/fail)"""
    colors = set()

    for page_num in range(len(doc)):
        page = doc[page_num]
        text_dict = page.get_text("dict")

        for block in text_dict.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    color = span.get("color", 0)
                    if color != 0:  # Exclude pure black
                        r = (color >> 16) & 0xFF
                        g = (color >> 8) & 0xFF
                        b = color & 0xFF
                        hex_color = f"#{r:02x}{g:02x}{b:02x}"
                        colors.add(hex_color)

        # Check drawing colors
        drawings = page.get_drawings()
        for d in drawings:
            if d.get("color"):
                c = d["color"]
                if isinstance(c, (tuple, list)) and len(c) >= 3:
                    hex_color = f"#{int(c[0]*255):02x}{int(c[1]*255):02x}{int(c[2]*255):02x}"
                    colors.add(hex_color)
            if d.get("fill"):
                c = d["fill"]
                if isinstance(c, (tuple, list)) and len(c) >= 3:
                    hex_color = f"#{int(c[0]*255):02x}{int(c[1]*255):02x}{int(c[2]*255):02x}"
                    colors.add(hex_color)

    # Filter out near-black/white/gray colors
    distinct_colors = []
    for c in colors:
        r = int(c[1:3], 16)
        g = int(c[3:5], 16)
        b = int(c[5:7], 16)
        max_diff = max(abs(r-g), abs(g-b), abs(r-b))
        if max_diff > 20:
            distinct_colors.append(c)

    result.add_info(f"Total text colors: {len(colors)} (chromatic: {len(distinct_colors)})")

    if distinct_colors:
        result.add_info(f"Chromatic colors: {', '.join(sorted(distinct_colors)[:10])}")


def check_page_size_consistency(doc, result):
    """Check whether all page sizes are consistent"""
    if len(doc) < 2:
        result.ok("Single-page document, size consistent ✓")
        return

    sizes = set()
    for i in range(len(doc)):
        page = doc[i]
        w = round(page.rect.width, 1)
        h = round(page.rect.height, 1)
        sizes.add((w, h))

    if len(sizes) > 1:
        result.warn("Page size", f"Inconsistent page sizes: {sizes}")
    else:
        size = list(sizes)[0]
        # Convert to mm
        w_mm = size[0] * 25.4 / 72
        h_mm = size[1] * 25.4 / 72
        result.add_info(f"Page size: {w_mm:.0f}mm × {h_mm:.0f}mm ({len(doc)} pages)")
        result.ok("Page size consistent ✓")


def check_text_overflow(doc, result):
    """Check whether text overflows page boundaries"""
    overflow_pages = []

    for i in range(len(doc)):
        page = doc[i]
        rect = page.rect
        blocks = page.get_text("blocks")

        for b in blocks:
            # b = (x0, y0, x1, y1, text, block_no, block_type)
            if b[2] > rect.width + 2 or b[3] > rect.height + 2:  # 2px tolerance
                overflow_pages.append(i + 1)
                break
            if b[0] < -2 or b[1] < -2:
                overflow_pages.append(i + 1)
                break

    if overflow_pages:
        result.warn("Content overflow", f"Pages {overflow_pages} may have content exceeding page boundaries")
    else:
        result.ok("No content overflow ✓")


def check_content_fill_ratio(doc, result):
    """Check content fill ratio per page — warns when content is crammed at top leaving large void below.

    Rules:
    - Skip single-page documents (may be intentional design)
    - Skip page 1 (usually cover with intentional whitespace)
    - Middle pages: warn if fill ratio < 40%
    - Last page: warn if fill ratio < 25% (naturally has less content)
    """
    if len(doc) < 2:
        result.ok("Single-page document, skipping content fill ratio check ✓")
        return

    low_fill_pages = []

    for i in range(len(doc)):
        page = doc[i]
        page_rect = page.rect
        page_height = page_rect.height

        # Skip page 1 (cover)
        if i == 0:
            continue

        blocks = page.get_text("blocks")
        images = page.get_images()
        drawings = page.get_drawings()

        if not blocks and not images and not drawings:
            continue  # Blank page check handles this

        # Calculate content bbox
        max_y = 0
        for b in blocks:
            if b[4].strip():
                max_y = max(max_y, b[3])

        # Include images in bbox
        for img in images:
            try:
                img_rects = page.get_image_rects(img[0])
                for r in img_rects:
                    max_y = max(max_y, r.y1)
            except Exception:
                pass

        if max_y == 0:
            continue

        fill_ratio = max_y / page_height
        is_last = (i == len(doc) - 1)
        threshold = 0.25 if is_last else 0.40

        if fill_ratio < threshold:
            low_fill_pages.append((i + 1, fill_ratio, threshold))

    if low_fill_pages:
        for pg, ratio, thresh in low_fill_pages:
            result.warn(
                "Content fill ratio",
                f"Page {pg} content only fills {ratio:.0%} of page height "
                f"(threshold: {thresh:.0%}). Content may be crammed at the top "
                f"with a large blank area below."
            )
    else:
        result.ok("Content fill ratio adequate on all pages ✓")


def check_cover_bleed(doc, result, poster=False):
    """Check if the cover page (page 1) fills the entire page area (full-bleed).

    A properly designed cover should have background color/graphics extending
    to the page edges. If the content bbox has significant margins on all sides,
    the cover likely wasn't rendered full-bleed (e.g. ReportLab with default margins).

    For poster mode: checks ALL pages (not just the cover) since every page of a
    seamlessly-paginated poster should have consistent background fill.

    Strategy: combine bounding boxes of drawings (rects, paths), images, and colored
    backgrounds. If the union bbox leaves > 5% margin on any side, warn.
    """
    if not poster and len(doc) < 2:
        # Single page doc (non-poster) — not necessarily a cover scenario
        return

    pages_to_check = range(len(doc)) if poster else [0]

    for page_idx in pages_to_check:
        page = doc[page_idx]
        page_rect = page.rect
        pw, ph = page_rect.width, page_rect.height

        # Collect all content bounding boxes
        min_x, min_y = pw, ph
        max_x, max_y = 0.0, 0.0
        has_content = False

        # 1. Drawings (vector paths, rectangles — typical for colored backgrounds)
        for d in page.get_drawings():
            r = d.get("rect")
            if r:
                min_x = min(min_x, r.x0)
                min_y = min(min_y, r.y0)
                max_x = max(max_x, r.x1)
                max_y = max(max_y, r.y1)
                has_content = True

        # 2. Images
        for img in page.get_images():
            try:
                for r in page.get_image_rects(img[0]):
                    min_x = min(min_x, r.x0)
                    min_y = min(min_y, r.y0)
                    max_x = max(max_x, r.x1)
                    max_y = max(max_y, r.y1)
                    has_content = True
            except Exception:
                pass

        page_label = f"Page {page_idx + 1}" if poster else "Cover page (p1)"

        if not has_content:
            blocks = page.get_text("blocks")
            if blocks:
                result.warn(
                    f"{page_label} not full-bleed",
                    f"{page_label} has no background graphics (no filled rectangles or images). "
                    "A proper cover/poster page should have a full-page background color or image "
                    "extending to all edges."
                )
            continue

        # Calculate margin ratios (how far content is from page edges)
        margin_left = max(0, min_x) / pw
        margin_top = max(0, min_y) / ph
        margin_right = max(0, pw - max_x) / pw
        margin_bottom = max(0, ph - max_y) / ph

        threshold = 0.05
        margins_ok = (margin_left <= threshold and margin_top <= threshold and
                      margin_right <= threshold and margin_bottom <= threshold)

        if margins_ok:
            result.ok(f"{page_label} content extends to page edges (full-bleed) ✓")
        else:
            sides = []
            if margin_left > threshold:
                sides.append(f"left {margin_left:.0%}")
            if margin_top > threshold:
                sides.append(f"top {margin_top:.0%}")
            if margin_right > threshold:
                sides.append(f"right {margin_right:.0%}")
            if margin_bottom > threshold:
                sides.append(f"bottom {margin_bottom:.0%}")
            result.warn(
                f"{page_label} not full-bleed",
                f"{page_label} has visible margins: {', '.join(sides)}. "
                f"Background/graphics should extend to page edges."
            )


def check_margin_symmetry(doc, result, skip_cover=False):
    """Check left/right margin symmetry using text block bounds."""
    warn_pages = []

    for page_num in range(len(doc)):
        if skip_cover and page_num == 0:
            continue

        page = doc[page_num]
        blocks = page.get_text("blocks")
        text_blocks = [b for b in blocks if b[4].strip()]

        if len(text_blocks) < 3:
            continue  # Skip decorative/cover-like pages

        left_margin = min(b[0] for b in text_blocks)
        right_margin = page.rect.width - max(b[2] for b in text_blocks)
        diff = abs(left_margin - right_margin)

        if diff > page.rect.width * 0.05:
            warn_pages.append((page_num + 1, left_margin, right_margin, diff))

    if warn_pages:
        for pg, left, right, diff in warn_pages:
            result.warn(
                "Margin symmetry",
                f"Page {pg} left/right margins differ by {diff:.0f}pt "
                f"(L {left:.0f}pt, R {right:.0f}pt)"
            )
    else:
        result.ok("Left/right margins appear symmetric \u2713")


def check_table_centering(doc, result):
    """Check if detected table regions are centered."""
    def _bbox_intersects(a, b, tol=6):
        return not (a[2] < b[0] - tol or a[0] > b[2] + tol or
                    a[3] < b[1] - tol or a[1] > b[3] + tol)

    def _rect_tuple(r):
        if hasattr(r, "x0"):
            return (r.x0, r.y0, r.x1, r.y1)
        return (r[0], r[1], r[2], r[3])

    any_tables = False

    for page_num in range(len(doc)):
        page = doc[page_num]
        drawings = page.get_drawings()
        segments = []

        for d in drawings:
            for item in d.get("items", []):
                if not item:
                    continue
                op = item[0]
                if op == "l" and len(item) >= 3:
                    p0, p1 = item[1], item[2]
                    segments.append((p0[0], p0[1], p1[0], p1[1]))
                elif op == "re" and len(item) >= 2:
                    x0, y0, x1, y1 = _rect_tuple(item[1])
                    segments.extend([
                        (x0, y0, x1, y0),
                        (x0, y1, x1, y1),
                        (x0, y0, x0, y1),
                        (x1, y0, x1, y1),
                    ])

        if not segments:
            continue

        cluster_list = []
        for x0, y0, x1, y1 in segments:
            min_x, max_x = min(x0, x1), max(x0, x1)
            min_y, max_y = min(y0, y1), max(y0, y1)
            bbox = (min_x, min_y, max_x, max_y)
            is_h = abs(y0 - y1) < 1 and (max_x - min_x) > 20
            is_v = abs(x0 - x1) < 1 and (max_y - min_y) > 20
            if not is_h and not is_v:
                continue

            placed = False
            for cl in cluster_list:
                if _bbox_intersects(bbox, cl["bbox"]):
                    cl["segments"].append((x0, y0, x1, y1, is_h, is_v))
                    cl["bbox"] = (
                        min(cl["bbox"][0], bbox[0]),
                        min(cl["bbox"][1], bbox[1]),
                        max(cl["bbox"][2], bbox[2]),
                        max(cl["bbox"][3], bbox[3]),
                    )
                    if is_h:
                        cl["h"] += 1
                    if is_v:
                        cl["v"] += 1
                    placed = True
                    break
            if not placed:
                cluster_list.append({
                    "bbox": bbox,
                    "segments": [(x0, y0, x1, y1, is_h, is_v)],
                    "h": 1 if is_h else 0,
                    "v": 1 if is_v else 0,
                })

        for cl in cluster_list:
            if cl["h"] < 2 or cl["v"] < 2:
                continue
            any_tables = True
            bbox = cl["bbox"]
            page_width = page.rect.width
            left_margin = bbox[0]
            right_margin = page_width - bbox[2]
            if abs(left_margin - right_margin) > page_width * 0.05:
                result.warn(
                    "Table centering",
                    f"Page {page_num + 1}: Table not centered "
                    f"(L {left_margin:.0f}pt, R {right_margin:.0f}pt)"
                )

    if any_tables:
        result.ok("Table centering check complete \u2713")


def check_font_embedding(doc, result):
    """Check font embedding status using PyMuPDF font list."""
    fonts_used = set()
    non_embedded = set()

    for page_num in range(len(doc)):
        page = doc[page_num]
        for font in page.get_fonts():
            basefont = font[3] if len(font) > 3 else "unknown"
            ext = font[1] if len(font) > 1 else ""
            fonts_used.add(basefont)
            if not ext:
                non_embedded.add(basefont)

    if fonts_used:
        result.add_info(f"Fonts used: {', '.join(sorted(fonts_used))}")
    else:
        result.add_info("Fonts used: (none detected)")

    if non_embedded:
        for basefont in sorted(non_embedded):
            result.warn(
                "Font embedding",
                f"Font {basefont} is not embedded. May display differently on other systems."
            )
    else:
        result.ok("All fonts are embedded \u2713")


def check_helvetica_in_cjk(doc, result):
    """Detect Helvetica rendering visible text in documents containing CJK text.

    Helvetica is a Latin-only built-in PDF font. When it appears rendering
    actual text content in a CJK document, it almost always means a raw string
    was passed to a ReportLab Table or flowable without wrapping it in
    Paragraph() with a CJK font. The CJK characters rendered via Helvetica
    become garbled (fall back to ZapfDingbats symbols).

    We only check Helvetica (not ZapfDingbats) because ZapfDingbats is
    legitimately used for bullet symbols in list items.

    We check actual rendered text spans (not just font presence in font list)
    because ReportLab internally registers Helvetica on every page even when
    only CJK fonts are used in visible content.
    """
    has_cjk = False
    helvetica_pages = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text") or ""

        # Check if document contains CJK characters
        if not has_cjk:
            for ch in text:
                if '\u4e00' <= ch <= '\u9fff' or '\u3400' <= ch <= '\u4dbf':
                    has_cjk = True
                    break

        # Check if Helvetica is actually used to render visible text on this page
        blocks = page.get_text("dict", sort=True).get("blocks", [])
        found_on_page = False
        for block in blocks:
            if found_on_page:
                break
            for line in block.get("lines", []):
                if found_on_page:
                    break
                for span in line.get("spans", []):
                    font = span.get("font", "")
                    txt = span.get("text", "").strip()
                    if "Helvetica" in font and len(txt) > 0:
                        helvetica_pages.append(page_num + 1)
                        found_on_page = True
                        break

    if has_cjk and helvetica_pages:
        pages_str = ', '.join(str(p) for p in helvetica_pages[:5])
        if len(helvetica_pages) > 5:
            pages_str += f' ...and {len(helvetica_pages) - 5} more'
        result.warn(
            "Helvetica in CJK document",
            f"Helvetica font detected rendering text on page(s) {pages_str} in a CJK document. "
            f"This usually means a raw string was passed to a ReportLab Table or flowable "
            f"without wrapping in Paragraph(text, style) with a CJK-capable font. "
            f"CJK characters rendered via Helvetica will appear as garbled symbols."
        )


def check_metadata(doc, result):
    """Check PDF metadata presence for title, author, creator."""
    meta = doc.metadata or {}

    def _missing(v):
        if v is None:
            return True
        if not str(v).strip():
            return True
        return False

    title = meta.get("title")
    author = meta.get("author")
    creator = meta.get("creator")

    if _missing(title) or str(title).strip().lower() in ("untitled", "(anonymous)"):
        result.warn("Metadata", "Missing/invalid title metadata")
    else:
        result.ok("Title metadata present \u2713")

    if _missing(author):
        result.warn("Metadata", "Missing author metadata")
    else:
        result.ok("Author metadata present \u2713")

    if _missing(creator):
        result.warn("Metadata", "Missing creator metadata")
    else:
        result.ok("Creator metadata present \u2713")


def check_toc_without_cover(doc, result):
    """Detect TOC on page 1 without a preceding cover page.

    If the first page contains Table of Contents / 目录, it means the document
    has a TOC but no cover page. This is a structural issue — documents with
    TOC should have: Cover (p1) → TOC (p2) → Content (p3+).
    """
    if len(doc) < 2:
        # Single-page docs don't need TOC/cover checks
        return

    page1 = doc[0]
    text = page1.get_text("text", sort=True).strip()

    # Normalize for matching
    text_lower = text.lower()
    first_300 = text_lower[:300]

    toc_keywords = [
        "table of contents", "contents",
        "目录", "目 录",
    ]

    has_toc = any(kw in first_300 for kw in toc_keywords)

    if has_toc:
        result.warn(
            "TOC without cover",
            "Page 1 appears to be a Table of Contents with no preceding cover page. "
            "Documents with TOC should have: Cover (p1) → TOC (p2) → Content (p3+)."
        )


def check_formula_overflow(doc, result):
    """Detect likely formula overflow past right content margin."""
    math_re = re.compile(r"[=+\-*/<>\u2264\u2265\u2211\u222b\u221a\u03c0\u00b5\u221e\u2202\u2206\u2248\u2260\u00b1\u00d7\u00f7]")

    for page_num in range(len(doc)):
        page = doc[page_num]
        blocks = page.get_text("blocks")
        text_blocks = [b for b in blocks if b[4].strip()]

        if len(text_blocks) < 3:
            continue

        right_edges = sorted(b[2] for b in text_blocks)
        mid = len(right_edges) // 2
        content_right = right_edges[mid] if right_edges else 0

        for b in text_blocks:
            x0, x1, text = b[0], b[2], b[4]
            if x1 <= content_right + 10:
                continue

            is_single_line = "\n" not in text.strip()
            is_wide = (x1 - x0) > page.rect.width * 0.5
            has_math = bool(math_re.search(text))

            if (is_single_line and is_wide) or has_math:
                delta = x1 - content_right
                result.warn(
                    "Formula overflow",
                    f"Page {page_num + 1}: Content extends {delta:.0f}pt beyond right content margin "
                    "(possible formula overflow)"
                )
                break


# ============================================================
# Main
# ============================================================

def run_qa(pdf_path, poster=False, skip_cover=False, check_tables=True, check_formulas=False):
    result = QAResult()

    if not os.path.exists(pdf_path):
        result.error("File", f"File not found: {pdf_path}")
        return result

    doc = pymupdf.open(pdf_path)

    result.add_info(f"File: {os.path.basename(pdf_path)}")
    result.add_info(f"Size: {os.path.getsize(pdf_path) / 1024:.1f} KB")
    if poster:
        result.add_info("Mode: poster (creative)")

    # Run all checks
    check_metadata(doc, result)
    check_page_size_consistency(doc, result)
    check_blank_pages(doc, result)
    check_punctuation(doc, result)
    check_colors(doc, result)
    check_font_embedding(doc, result)
    check_helvetica_in_cjk(doc, result)
    check_text_overflow(doc, result)
    if not poster:
        # Content fill ratio is not meaningful for posters — the last page
        # of a seamlessly-paginated poster naturally has less content.
        check_content_fill_ratio(doc, result)
    check_cover_bleed(doc, result, poster=poster)
    check_margin_symmetry(doc, result, skip_cover=skip_cover)
    if check_tables:
        check_table_centering(doc, result)
    if check_formulas:
        check_formula_overflow(doc, result)
    if not poster:
        check_toc_without_cover(doc, result)

    doc.close()
    return result


def format_report(result):
    lines = []
    lines.append("=" * 56)
    lines.append("  PDF Quality Assurance Report")
    lines.append("=" * 56)

    # Info
    if result.info:
        lines.append("")
        lines.append("ℹ️  Info:")
        for msg in result.info:
            lines.append(f"   {msg}")

    # Passes
    if result.passes:
        lines.append("")
        lines.append(f"✅ Passed ({len(result.passes)}):")
        for msg in result.passes:
            lines.append(f"   {msg}")

    # Issues
    errors = [(s, c, m) for s, c, m in result.issues if s == 'ERROR']
    warns = [(s, c, m) for s, c, m in result.issues if s == 'WARN']

    if errors:
        lines.append("")
        lines.append(f"❌ Errors ({len(errors)}):")
        for _, cat, msg in errors:
            lines.append(f"   [{cat}] {msg}")

    if warns:
        lines.append("")
        lines.append(f"⚠️  Warnings ({len(warns)}):")
        for _, cat, msg in warns:
            lines.append(f"   [{cat}] {msg}")

    # Summary
    lines.append("")
    lines.append("-" * 56)
    total_issues = len(result.issues)
    if total_issues == 0:
        lines.append("🎉 PASS — All checks passed!")
    elif errors:
        lines.append(f"💀 FAIL — {len(errors)} error(s), {len(warns)} warning(s)")
    else:
        lines.append(f"⚠️  WARN — {len(warns)} warning(s), optimization recommended")
    lines.append("-" * 56)

    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: \"$(command -v zcode-python || command -v python3)\" pdf_qa.py <pdf_path>")
        print("       \"$(command -v zcode-python || command -v python3)\" pdf_qa.py *.pdf  (batch check)")
        print("Options:")
        print("  --poster      Poster mode (creative)")
        print("  --skip-cover  Skip page 1 margin symmetry check")
        print("  --no-tables   Disable table centering check")
        print("  --formulas    Enable formula overflow check")
        sys.exit(1)

    import glob
    files = []
    poster = False
    skip_cover = False
    check_tables = True
    check_formulas = False
    args = sys.argv[1:]
    if '--poster' in args:
        poster = True
        args.remove('--poster')
    if '--skip-cover' in args:
        skip_cover = True
        args.remove('--skip-cover')
    if '--no-tables' in args:
        check_tables = False
        args.remove('--no-tables')
    if '--formulas' in args:
        check_formulas = True
        args.remove('--formulas')
    for arg in args:
        files.extend(glob.glob(arg))

    if not files:
        print(f"File not found: {args}")
        sys.exit(1)

    for pdf_path in files:
        result = run_qa(
            pdf_path,
            poster=poster,
            skip_cover=skip_cover,
            check_tables=check_tables,
            check_formulas=check_formulas
        )
        print(format_report(result))
        if len(files) > 1:
            print("\n")
