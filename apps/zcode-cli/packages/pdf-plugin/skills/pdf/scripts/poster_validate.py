#!/usr/bin/env python3
"""
poster_validate.py — Pre- and post-generation quality checks for poster/creative PDFs.

Usage:
    # Check HTML before PDF generation
    "$(command -v zcode-python || command -v python3)" poster_validate.py check-html poster.html [--fix] [--output fixed.html]

    # Check PDF after generation
    "$(command -v zcode-python || command -v python3)" poster_validate.py check-pdf poster.pdf --source-html poster.html

Both commands emit a JSON report to stdout:
    {"pass": bool, "source": "...", "check_type": "html"|"pdf",
     "errors": [...], "warnings": [...], "info": [...]}

Exit codes:
    0  pass (no errors; warnings/info are OK)
    1  fail (at least one error)
    2  script-level failure (bad arguments, unreadable file, …)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GENERIC_FAMILIES = frozenset(
    ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif",
     "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"]
)

SERIF_FONTS = frozenset(f.lower() for f in [
    "Playfair Display", "Georgia", "Times New Roman", "Times", "Noto Serif",
    "Noto Serif SC", "Noto Serif TC", "Noto Serif JP", "Noto Serif KR",
    "Source Serif Pro", "Source Serif 4", "Merriweather", "Lora", "PT Serif",
    "Libre Baskerville", "EB Garamond", "Cormorant Garamond", "Crimson Text",
    "STSong", "FangSong", "KaiTi", "STKaiti", "Songti SC",
])

CHINESE_FONTS = frozenset(f.lower() for f in [
    "SimHei", "Microsoft YaHei", "Noto Sans SC", "Noto Sans TC",
    "Noto Sans CJK SC", "Noto Sans CJK TC", "PingFang SC", "PingFang TC",
    "Source Han Sans SC", "Source Han Sans TC", "WenQuanYi Micro Hei",
    "WenQuanYi Zen Hei", "Hiragino Sans GB", "STHeiti", "STXihei",
    "Noto Serif SC", "Noto Serif TC", "Noto Serif CJK SC",
    "Source Han Serif SC", "SimSun", "NSimSun", "FangSong", "KaiTi",
    "STSong", "STFangsong", "STKaiti", "Songti SC", "Heiti SC",
])

# Selectors we treat as "main containers" whose overflow:hidden is dangerous.
# NOTE: .poster and .page are EXCLUDED because html2poster.js auto-injects
# overflow:hidden on them at render time. See SKILL.md Engine Selection Rules.
CONTAINER_SELECTORS = {"body", "html", ".slide",
                       "#app", "#root", ".container", ".wrapper", "main",
                       "section", "article"}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _issue(code: str, message: str, severity: str = "error", line: int | None = None) -> dict:
    d: dict[str, Any] = {"code": code, "message": message, "severity": severity}
    if line is not None:
        d["line"] = line
    return d


def _line_number(full_text: str, pos: int) -> int:
    """Return 1-based line number for character position *pos*."""
    return full_text.count("\n", 0, pos) + 1


# ---------------------------------------------------------------------------
# CSS regex helpers
# ---------------------------------------------------------------------------

_RE_FONT_FAMILY = re.compile(
    r"font-family\s*:\s*([^;}\n]+)", re.IGNORECASE
)

_RE_FONT_SIZE = re.compile(
    r"font-size\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt|em|rem)", re.IGNORECASE
)

_RE_PAGE_SIZE = re.compile(
    r"@page\s*\{[^}]*\bsize\s*:", re.IGNORECASE | re.DOTALL
)

_RE_CSS_URL = re.compile(
    r"url\(\s*['\"]?(https?://[^'\")\s]+)['\"]?\s*\)", re.IGNORECASE
)

_RE_OVERFLOW = re.compile(
    r"overflow\s*:\s*hidden", re.IGNORECASE
)

_RE_BG_WHITE = re.compile(
    r"background(?:-color)?\s*:\s*(white|#fff(?:fff)?|transparent)\b", re.IGNORECASE
)

_RE_COLOR_HEX = re.compile(r"#([0-9a-fA-F]{3,8})")
_RE_COLOR_RGB = re.compile(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)")

_RE_STYLE_BLOCK = re.compile(r"<style[^>]*>(.*?)</style>", re.IGNORECASE | re.DOTALL)
_RE_INLINE_STYLE = re.compile(r'style\s*=\s*["\']([^"\']*)["\']', re.IGNORECASE)

_RE_CSS_RULE = re.compile(
    r"([^{]+)\{([^}]*)\}", re.DOTALL
)

_RE_WIDTH_PX = re.compile(r"width\s*:\s*(\d+(?:\.\d+)?)\s*px", re.IGNORECASE)


def _parse_font_list(raw: str) -> list[str]:
    """Split a font-family value into individual font names (unquoted, stripped)."""
    fonts: list[str] = []
    for part in raw.split(","):
        name = part.strip().strip("'\"").strip()
        if name:
            fonts.append(name)
    return fonts


def _has_generic(fonts: list[str]) -> bool:
    return any(f.lower() in GENERIC_FAMILIES for f in fonts)


def _best_generic(fonts: list[str]) -> str:
    """Pick the best generic fallback for a list of named fonts."""
    lower = [f.lower() for f in fonts]
    if any(f in CHINESE_FONTS for f in lower):
        return "sans-serif"
    if any(f in SERIF_FONTS for f in lower):
        return "serif"
    return "sans-serif"


# ---------------------------------------------------------------------------
# Color / contrast helpers
# ---------------------------------------------------------------------------

def _hex_to_rgb(h: str) -> tuple[int, int, int] | None:
    h = h.lstrip("#")
    if len(h) == 3:
        h = h[0]*2 + h[1]*2 + h[2]*2
    if len(h) == 4:
        h = h[0]*2 + h[1]*2 + h[2]*2  # ignore alpha
    if len(h) == 8:
        h = h[:6]  # strip alpha
    if len(h) != 6:
        return None
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return None


def _relative_luminance(r: int, g: int, b: int) -> float:
    """WCAG 2.x relative luminance."""
    def _c(v: int) -> float:
        s = v / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    return 0.2126 * _c(r) + 0.7152 * _c(g) + 0.0722 * _c(b)


def _contrast_ratio(rgb1: tuple[int, int, int], rgb2: tuple[int, int, int]) -> float:
    l1 = _relative_luminance(*rgb1)
    l2 = _relative_luminance(*rgb2)
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def _extract_color(css_text: str, prop: str) -> tuple[int, int, int] | None:
    """Try to extract an RGB color for a given CSS property from a rule body."""
    pat = re.compile(rf"{prop}\s*:\s*([^;]+)", re.IGNORECASE)
    m = pat.search(css_text)
    if not m:
        return None
    val = m.group(1).strip()
    # Named colours (just the common ones)
    named = {
        "white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0),
        "green": (0, 128, 0), "blue": (0, 0, 255), "yellow": (255, 255, 0),
        "grey": (128, 128, 128), "gray": (128, 128, 128), "transparent": (255, 255, 255),
    }
    low = val.lower().split()[0].rstrip(";")
    if low in named:
        return named[low]
    m_rgb = _RE_COLOR_RGB.search(val)
    if m_rgb:
        return int(m_rgb.group(1)), int(m_rgb.group(2)), int(m_rgb.group(3))
    m_hex = _RE_COLOR_HEX.search(val)
    if m_hex:
        return _hex_to_rgb(m_hex.group(1))
    return None


# ---------------------------------------------------------------------------
# HTML visible text extractor (stdlib only)
# ---------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    """Extract visible text from HTML, skipping <script>, <style>, etc."""

    _SKIP_TAGS = frozenset(["script", "style", "noscript", "template", "svg"])

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in self._SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self.parts.append(data)

    def get_text(self) -> str:
        return " ".join(self.parts)


def _html_visible_text(html: str) -> str:
    ext = _TextExtractor()
    try:
        ext.feed(html)
    except Exception:
        pass
    return ext.get_text()


# ---------------------------------------------------------------------------
# CHECK-HTML
# ---------------------------------------------------------------------------

def check_html(html_path: str, *, fix: bool = False, output_path: str | None = None) -> dict:
    """Run all HTML pre-checks. Return the JSON-serialisable report dict."""

    path = Path(html_path)
    if not path.is_file():
        return {"pass": False, "source": html_path, "check_type": "html",
                "errors": [_issue("FILE_NOT_FOUND", f"Cannot read '{html_path}'.")],
                "warnings": [], "info": []}

    raw = path.read_text(encoding="utf-8", errors="replace")
    original = raw  # keep for line-number lookup
    # For fix mode: we collect all replacements and apply them at the end
    # using re.sub on the original to avoid offset corruption
    _all_fixes: list[tuple[str, str]] = []  # (old_text, new_text) applied in order

    errors: list[dict] = []
    warnings: list[dict] = []
    info: list[dict] = []

    # Collect all CSS text (style blocks + inline styles)
    all_css_positions: list[tuple[str, int]] = []  # (css_text, char_offset_in_raw)
    for m in _RE_STYLE_BLOCK.finditer(raw):
        all_css_positions.append((m.group(1), m.start(1)))
    for m in _RE_INLINE_STYLE.finditer(raw):
        all_css_positions.append((m.group(1), m.start(1)))

    all_css = "\n".join(c for c, _ in all_css_positions)

    # ---- 1. FONT_NO_FALLBACK ----
    for css_text, css_offset in all_css_positions:
        for m in _RE_FONT_FAMILY.finditer(css_text):
            fonts = _parse_font_list(m.group(1))
            if fonts and not _has_generic(fonts):
                abs_pos = css_offset + m.start()
                ln = _line_number(original, abs_pos)
                generic = _best_generic(fonts)
                errors.append(_issue(
                    "FONT_NO_FALLBACK",
                    f"font-family {', '.join(repr(f) for f in fonts)} has no generic fallback. "
                    f"Add '{generic}' at the end.",
                    line=ln
                ))
                if fix:
                    old_decl = m.group(0)  # e.g. "font-family: 'Montserrat'"
                    val_part = m.group(1).rstrip().rstrip(";").rstrip()
                    new_decl = f"font-family: {val_part}, {generic}"
                    _all_fixes.append((old_decl, new_decl))

    # ---- 2. OVERFLOW_HIDDEN_CONTAINER ----
    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip()
            body = rule_m.group(2)
            if not _RE_OVERFLOW.search(body):
                continue
            # Check if this selector is a container
            selectors = [s.strip().lower() for s in selector_raw.split(",")]
            for sel in selectors:
                # Strip pseudo-classes/elements for matching
                base_sel = re.split(r"[:>\s+~]", sel)[0].strip()
                if base_sel in CONTAINER_SELECTORS:
                    # Check for width < 200px exemption
                    w_m = _RE_WIDTH_PX.search(body)
                    if w_m and float(w_m.group(1)) < 200:
                        continue
                    abs_pos = css_offset + rule_m.start()
                    ln = _line_number(original, abs_pos)
                    errors.append(_issue(
                        "OVERFLOW_HIDDEN_CONTAINER",
                        f"'{base_sel}' has 'overflow: hidden' which clips content in PDF rendering. "
                        "Remove it or use 'overflow: visible'.",
                        line=ln
                    ))
                    if fix:
                        old_rule = rule_m.group(0)
                        fixed_body = re.sub(r"overflow\s*:\s*hidden\s*;?\s*", "", body, flags=re.IGNORECASE)
                        new_rule = f"{rule_m.group(1)}{{{fixed_body}}}"
                        _all_fixes.append((old_rule, new_rule))
                    break  # only report once per rule

    # Also check inline styles on body/html tags
    for tag_name in ("body", "html"):
        tag_pat = re.compile(rf"<{tag_name}([^>]*)>", re.IGNORECASE)
        for tm in tag_pat.finditer(raw):
            attrs_str = tm.group(1)
            style_m = re.search(r'style\s*=\s*["\']([^"\']*)["\']', attrs_str, re.IGNORECASE)
            if style_m and _RE_OVERFLOW.search(style_m.group(1)):
                ln = _line_number(original, tm.start())
                errors.append(_issue(
                    "OVERFLOW_HIDDEN_CONTAINER",
                    f"<{tag_name}> has inline 'overflow: hidden' which clips content. Remove it.",
                    line=ln
                ))
                if fix:
                    old_style = style_m.group(1)
                    new_style = re.sub(r"overflow\s*:\s*hidden\s*;?\s*", "", old_style, flags=re.IGNORECASE)
                    _all_fixes.append((old_style, new_style))

    # ---- 2b. FIXED_SIZE_NO_SCREEN_ADAPT ----
    # For fixed-size single-page designs (poster, infographic, certificate, card),
    # check that @media screen auto-scale CSS is present.
    # Detect fixed-size pages: html/body with explicit px width+height
    _has_fixed_width = False
    _has_fixed_height = False
    _fixed_h_value = None
    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip().lower()
            body_text = rule_m.group(2)
            selectors = [s.strip() for s in selector_raw.split(",")]
            if any(s in ("body", "html", "html, body", "body, html") for s in selectors):
                if re.search(r"(?<!max-)(?<!min-)width\s*:\s*\d+(?:\.\d+)?\s*px", body_text, re.IGNORECASE):
                    _has_fixed_width = True
                h_m = re.search(r"(?<!max-)(?<!min-)height\s*:\s*(\d+(?:\.\d+)?)\s*px", body_text, re.IGNORECASE)
                if h_m:
                    _has_fixed_height = True
                    _fixed_h_value = h_m.group(1)
    # Also check .page / .poster containers
    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip().lower()
            body_text = rule_m.group(2)
            selectors = [s.strip() for s in selector_raw.split(",")]
            if any(s in (".page", ".poster", "#page", "#poster", ".slide") for s in selectors):
                if re.search(r"(?<!max-)(?<!min-)width\s*:\s*\d+(?:\.\d+)?\s*px", body_text, re.IGNORECASE):
                    _has_fixed_width = True
                h_m = re.search(r"(?<!max-)(?<!min-)height\s*:\s*(\d+(?:\.\d+)?)\s*px", body_text, re.IGNORECASE)
                if h_m:
                    _has_fixed_height = True
                    if not _fixed_h_value:
                        _fixed_h_value = h_m.group(1)

    _is_fixed_size_page = _has_fixed_width and _has_fixed_height

    if _is_fixed_size_page:
        # Check for @media screen rule
        _has_media_screen = bool(re.search(r"@media\s+screen\s*\{", all_css, re.IGNORECASE))
        if not _has_media_screen:
            _height_hint = _fixed_h_value or "1400"
            warnings.append(_issue(
                "FIXED_SIZE_NO_SCREEN_ADAPT",
                f"Fixed-size page detected ({_height_hint}px tall) but no @media screen rule found. "
                "Browser preview will require scrolling to see the full page. "
                "Add @media screen {{ html {{ height:auto; display:flex; justify-content:center; }} "
                f"body {{ transform-origin:top center; scale:min(1, calc(100vh / {_height_hint})); "
                "margin:0 auto; }} }} for auto-scaling preview.",
                severity="warning"
            ))

        # Check for @media screen + scale/transform (more specific)
        if _has_media_screen:
            # Extract full @media screen block content (handles nested braces)
            _media_screen_content = ""
            _ms_match = re.search(r"@media\s+screen\s*\{", all_css, re.IGNORECASE)
            if _ms_match:
                # Find matching closing brace (count nested braces)
                _depth = 1
                _start = _ms_match.end()
                for _ci in range(_start, len(all_css)):
                    if all_css[_ci] == '{':
                        _depth += 1
                    elif all_css[_ci] == '}':
                        _depth -= 1
                        if _depth == 0:
                            _media_screen_content = all_css[_start:_ci]
                            break
            _has_scale = bool(re.search(
                r"(?:scale|transform|zoom)",
                _media_screen_content, re.IGNORECASE
            ))
            if not _has_scale:
                warnings.append(_issue(
                    "SCREEN_ADAPT_NO_SCALE",
                    "@media screen block exists but lacks scale/transform/zoom for auto-fitting. "
                    f"Add: body {{ scale: min(1, calc(100vh / {_fixed_h_value or '1400'})); }}",
                    severity="warning"
                ))

    # ---- 3. REMOTE_IMAGE ----
    # <img src="http...">
    for m in re.finditer(r'<img\s[^>]*src\s*=\s*["\']?(https?://[^\s"\'>\)]+)', raw, re.IGNORECASE):
        url = m.group(1)
        ln = _line_number(original, m.start())
        warnings.append(_issue(
            "REMOTE_IMAGE",
            f"img src='{_truncate(url, 80)}' is a remote URL. "
            "Download to images/ subdirectory and use relative path (src=\"images/filename.jpg\").",
            severity="warning", line=ln
        ))
    # CSS url(http...)
    for css_text, css_offset in all_css_positions:
        for m in _RE_CSS_URL.finditer(css_text):
            url = m.group(1)
            abs_pos = css_offset + m.start()
            ln = _line_number(original, abs_pos)
            warnings.append(_issue(
                "REMOTE_IMAGE",
                f"CSS url('{_truncate(url, 80)}') is a remote URL. "
                "Download locally for reliable PDF generation.",
                severity="warning", line=ln
            ))

    # ---- 3b. ABSOLUTE_PATH ----
    # <img src="file:///..." or src="/absolute/path">
    for m in re.finditer(r'<img\s[^>]*src\s*=\s*["\']?(file://[^\s"\'>\)]+|/[^\s"\'>\)]+)', raw, re.IGNORECASE):
        path_val = m.group(1)
        ln = _line_number(original, m.start())
        warnings.append(_issue(
            "ABSOLUTE_PATH",
            f"img src='{_truncate(path_val, 80)}' uses an absolute path. "
            "Use relative path (src=\"images/filename.jpg\") for portability.",
            severity="warning", line=ln
        ))

    # ---- 4. NO_PAGE_SIZE ----
    if not _RE_PAGE_SIZE.search(all_css):
        warnings.append(_issue(
            "NO_PAGE_SIZE",
            "@page { size: ... } not found in CSS. Playwright will use default A4 "
            "which may not match the poster design. Add explicit page size.",
            severity="warning"
        ))

    # ---- 4b. MISSING_MARGIN_RESET ----
    # Check if html/body has margin:0 reset (Chromium defaults to body { margin: 8px })
    has_margin_reset = bool(re.search(
        r'(?:html|body|\*)\s*(?:,\s*(?:html|body|\*)\s*)?{[^}]*margin\s*:\s*0',
        all_css, re.IGNORECASE
    ))
    if not has_margin_reset:
        warnings.append(_issue(
            "MISSING_MARGIN_RESET",
            "No 'margin: 0' found on html/body/*. Chromium's default body { margin: 8px } "
            "will cause black edges on top/left/bottom of the poster PDF. "
            "Add: html, body { margin: 0; padding: 0; }",
            severity="warning"
        ))

    # ---- 4c. PAGE_SIZE_CSS_VAR ----
    # CSS variables are NOT resolved in @page rules — will silently fallback to A4
    page_size_var_match = re.search(
        r'@page\s*\{[^}]*\bsize\s*:[^;]*var\s*\(',
        all_css, re.IGNORECASE | re.DOTALL
    )
    if page_size_var_match:
            errors.append(_issue(
                "PAGE_SIZE_CSS_VAR",
                "@page { size } uses CSS variables (var(...)). Chromium does NOT resolve "
                "CSS variables in @page rules — the page size will silently fallback to A4, "
                "causing content to be off-center. Use concrete px values instead: "
                "@page { size: 720px 960px; }",
                severity="error"
            ))

    # ---- 5. WHITE_BACKGROUND ----
    _has_styled_bg = False
    for css_text, _ in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip().lower()
            body = rule_m.group(2)
            selectors = [s.strip() for s in selector_raw.split(",")]
            if any(s in ("body", "html", ":root") for s in selectors):
                bg_m = re.search(r"background(?:-color)?\s*:\s*([^;]+)", body, re.IGNORECASE)
                if bg_m:
                    val = bg_m.group(1).strip().lower()
                    if val in ("white", "#fff", "#ffffff", "transparent", "rgba(0,0,0,0)",
                               "rgba(255,255,255,1)", "rgb(255,255,255)"):
                        pass  # still "white"-ish
                    else:
                        _has_styled_bg = True
    if not _has_styled_bg:
        warnings.append(_issue(
            "WHITE_BACKGROUND",
            "body/html has white, transparent, or no background. "
            "Posters typically need a styled background colour or gradient.",
            severity="warning"
        ))

    # ---- 6. TINY_FONT ----
    for css_text, css_offset in all_css_positions:
        for m in _RE_FONT_SIZE.finditer(css_text):
            size = float(m.group(1))
            unit = m.group(2).lower()
            # Convert to rough px
            if unit == "pt":
                size_px = size * (4 / 3)
            elif unit in ("em", "rem"):
                size_px = size * 16  # assume base 16px
            else:
                size_px = size
            if size_px < 10:
                abs_pos = css_offset + m.start()
                ln = _line_number(original, abs_pos)
                warnings.append(_issue(
                    "TINY_FONT",
                    f"font-size: {m.group(1)}{m.group(2)} ({size_px:.0f}px) may be unreadable in PDF output.",
                    severity="warning", line=ln
                ))

    # ---- 7. COLOR_CONTRAST ----
    _checked_pairs: set[tuple] = set()
    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            body = rule_m.group(2)
            fg = _extract_color(body, "color")
            bg = _extract_color(body, "background(?:-color)?")
            if fg and bg:
                pair = (fg, bg)
                if pair not in _checked_pairs:
                    _checked_pairs.add(pair)
                    ratio = _contrast_ratio(fg, bg)
                    if ratio < 3.0:
                        abs_pos = css_offset + rule_m.start()
                        ln = _line_number(original, abs_pos)
                        warnings.append(_issue(
                            "COLOR_CONTRAST",
                            f"Text color rgb{fg} on background rgb{bg} has contrast ratio "
                            f"{ratio:.1f}:1 (< 3:1 minimum). May be hard to read.",
                            severity="warning", line=ln
                        ))

    # ---- 8. MISSING_PRINT_BG_NOTE ----
    info.append(_issue(
        "MISSING_PRINT_BG_NOTE",
        "Remember to set print_background=True when calling page.pdf() in Playwright, "
        "otherwise CSS backgrounds won't render.",
        severity="info"
    ))

    # ---- 9. OVERFLOW_DECORATION ----
    # Detect decorative position:absolute elements that might overflow body width
    # Look for patterns like: left: -50px, right: -100px, left: 120%, transform: translateX(...)
    _overflow_positions = re.findall(
        r'(?:left|right)\s*:\s*(-\d+(?:\.\d+)?(?:px|%|rem|em))\s*;',
        all_css, re.IGNORECASE
    ) if all_css else []
    for pos_val in _overflow_positions:
        if pos_val.startswith('-') or (pos_val.endswith('%') and float(re.match(r'-?[\d.]+', pos_val).group()) > 100):
            warnings.append(_issue(
                "OVERFLOW_DECORATION",
                f"CSS position '{pos_val}' may push decorative elements outside body width, "
                "causing black edges in PDF. Keep absolute-positioned elements within [0, body_width].",
                severity="warning"
            ))
            break  # Only warn once

    # ---- 10. BG_COLOR_MISMATCH ----
    # Check if body/html background matches main content container background
    _body_bg = None
    _canvas_bg = None
    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip().lower()
            body_text = rule_m.group(2)
            selectors = [s.strip() for s in selector_raw.split(",")]
            bg_m = re.search(r"background(?:-color)?\s*:\s*([^;]+)", body_text, re.IGNORECASE)
            if bg_m:
                bg_val = bg_m.group(1).strip().lower()
                if any(s in ("body", "html") for s in selectors):
                    _body_bg = bg_val
                if any(s in (".canvas", ".poster", ".poster-container", ".page") for s in selectors):
                    _canvas_bg = bg_val
    # Helper: normalize a CSS background value to (r,g,b) for comparison.
    # Returns None if value uses var(), gradient, url(), or unparseable.
    def _bg_to_rgb(val: str):
        if not val:
            return None
        v = val.strip().lower()
        # Skip CSS variables, gradients, url() — can't compare reliably
        if v.startswith("var(") or "gradient" in v or "url(" in v:
            return None
        # Use _extract_color machinery: wrap as "background: <val>" and extract
        return _extract_color(f"background: {val};", "background")

    _body_bg_rgb = _bg_to_rgb(_body_bg)
    _canvas_bg_rgb = _bg_to_rgb(_canvas_bg)

    if _body_bg and _canvas_bg and _body_bg != _canvas_bg:
        # Skip if either uses CSS variables / gradients (can't reliably compare)
        if _body_bg_rgb is not None and _canvas_bg_rgb is not None:
            if _body_bg_rgb != _canvas_bg_rgb:
                warnings.append(_issue(
                    "BG_COLOR_MISMATCH",
                    f"body background '{_body_bg}' differs from content container background "
                    f"'{_canvas_bg}'. This may cause visible color borders in PDF output. "
                    "Ensure html/body background matches the poster canvas color.",
                    severity="warning"
                ))
        # else: unparseable (var/gradient/url) → skip, no warning

    # ---- 10b. SCREEN_BG_MISMATCH ----
    # Check if @media screen html background matches body/canvas background
    # Parse @media screen independently (check 2b only runs for fixed-size pages)
    _screen_has_media = bool(re.search(r"@media\s+screen\s*\{", all_css, re.IGNORECASE))
    _screen_content = ""
    if _screen_has_media:
        _ms_m = re.search(r"@media\s+screen\s*\{", all_css, re.IGNORECASE)
        if _ms_m:
            _d = 1
            _s = _ms_m.end()
            for _ci in range(_s, len(all_css)):
                if all_css[_ci] == '{':
                    _d += 1
                elif all_css[_ci] == '}':
                    _d -= 1
                    if _d == 0:
                        _screen_content = all_css[_s:_ci]
                        break
    if _screen_has_media and _screen_content:
        _screen_html_bg = None
        for rule_m in _RE_CSS_RULE.finditer(_screen_content):
            selector_raw = rule_m.group(1).strip().lower()
            body_text = rule_m.group(2)
            selectors = [s.strip() for s in selector_raw.split(",")]
            if any(s in ("html",) for s in selectors):
                bg_m = re.search(r"background(?:-color)?\s*:\s*([^;]+)", body_text, re.IGNORECASE)
                if bg_m:
                    _screen_html_bg = bg_m.group(1).strip().lower()
        _ref_bg = _body_bg or _canvas_bg
        if _screen_html_bg and _ref_bg and _screen_html_bg != _ref_bg:
            # Normalize to RGB for comparison (skip if either is var/gradient/url)
            _screen_rgb = _bg_to_rgb(_screen_html_bg)
            _ref_rgb = _bg_to_rgb(_ref_bg)
            if _screen_rgb is not None and _ref_rgb is not None:
                if _screen_rgb != _ref_rgb:
                    warnings.append(_issue(
                        "SCREEN_BG_MISMATCH",
                        f"@media screen html background '{_screen_html_bg}' differs from "
                        f"body/canvas background '{_ref_bg}'. Browser preview will show "
                        "a different color border around the poster. "
                        "Set @media screen html background to match the poster background.",
                        severity="warning"
                    ))
            # else: unparseable (var/gradient) → skip
        if _is_fixed_size_page and not _screen_html_bg:
            # Check if body/html already sets background globally (would be inherited)
            # If so, @media screen doesn't need its own background
            if not _body_bg:
                warnings.append(_issue(
                    "SCREEN_NO_BG",
                    "@media screen block exists but html has no explicit background color "
                    "(neither globally nor in @media screen). "
                    "Browser preview may show white borders around the poster. "
                    "Add: @media screen { html { background: <poster-bg-color>; } }",
                    severity="warning"
                ))
    # ---- 10c. MULTIPAGE_BODY_BG_MISSING ----
    # Multi-page documents with dark/colored .page backgrounds but no body background
    # → sub-pixel gap between .page and @page reveals white body, causing white edges
    _has_colored_page = False
    # Resolve CSS variables from :root for var() expansion
    _css_vars = {}
    for css_text, _ in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            sel = rule_m.group(1).strip().lower()
            if ":root" in sel:
                for vm in re.finditer(r"--(\w[\w-]*)\s*:\s*([^;]+)", rule_m.group(2)):
                    _css_vars[vm.group(1)] = vm.group(2).strip()

    def _resolve_bg(val):
        """Resolve a CSS background value, expanding var() references once."""
        v = val.strip().lower()
        var_m = re.match(r"var\(--(\w[\w-]*)\)", v)
        if var_m and var_m.group(1) in _css_vars:
            return _css_vars[var_m.group(1)].strip().lower()
        return v

    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip().lower()
            body_text = rule_m.group(2)
            selectors = [s.strip() for s in selector_raw.split(",")]
            if any(".page" in s for s in selectors):
                bg_m = re.search(r"background(?:-color)?\s*:\s*([^;]+)", body_text, re.IGNORECASE)
                if bg_m:
                    val = _resolve_bg(bg_m.group(1))
                    rgb = _bg_to_rgb(val)
                    if rgb is not None:
                        r_v, g_v, b_v = rgb
                        luminance = 0.299 * r_v + 0.587 * g_v + 0.114 * b_v
                        if luminance < 80:
                            _has_colored_page = True
                    elif "gradient" in val:
                        dark_hex = re.findall(r"#([0-9a-f]{3,6})", val)
                        for h in dark_hex:
                            if len(h) == 3:
                                h = h[0]*2 + h[1]*2 + h[2]*2
                            if len(h) == 6:
                                rv = int(h[0:2], 16)
                                gv = int(h[2:4], 16)
                                bv = int(h[4:6], 16)
                                if 0.299*rv + 0.587*gv + 0.114*bv < 80:
                                    _has_colored_page = True
                                    break
    _page_div_count = len(re.findall(r'class\s*=\s*["\'][^"\']*\bpage\b', original, re.IGNORECASE))
    if _page_div_count >= 2 and _has_colored_page and not _has_styled_bg:
        warnings.append(_issue(
            "MULTIPAGE_BODY_BG_MISSING",
            "Multi-page document has dark/colored .page backgrounds but html/body has no "
            "explicit background color. Playwright sub-pixel rounding creates <1px gaps "
            "at .page edges where body background shows through — white body = visible "
            "white edges on dark pages. Fix: set html,body { background: <darkest-page-color> }.",
            severity="warning"
        ))
    # ---- 11. HEIGHT_LOCKED ----
    # Check if content containers use height:100% instead of min-height
    _height_locked_selectors = set()
    # Selectors that are content containers (not SVG/img/shape)
    _content_containers = {".glass-canvas", ".shaped-canvas", ".process-list-container",
                           ".process-list", ".grid-item", ".stat-block", ".delta-widget"}
    for css_text, css_offset in all_css_positions:
        for rule_m in _RE_CSS_RULE.finditer(css_text):
            selector_raw = rule_m.group(1).strip()
            body_text = rule_m.group(2)
            # Check for height: 100% (not min-height)
            if re.search(r"(?<!min-)height\s*:\s*100%", body_text, re.IGNORECASE):
                selectors = [s.strip().lower() for s in selector_raw.split(",")]
                for sel in selectors:
                    base_sel = re.split(r"[:>\s+~]", sel)[0].strip()
                    # Skip non-content elements
                    if base_sel in (".bg-layer", "svg", "img", ".shape-float",
                                    ".shape-circle", ".shape-wave", ".shape-diagonal_slash",
                                    ".shape-diamond", ".shape-wedge_right"):
                        continue
                    if base_sel in _content_containers:
                        _height_locked_selectors.add(base_sel)
    # Also check inline styles
    for m in re.finditer(r'class\s*=\s*["\']([^"\']*)["\']\s*[^>]*style\s*=\s*["\']([^"\']*)["\']', raw, re.IGNORECASE):
        classes = m.group(1).lower().split()
        style = m.group(2)
        if re.search(r"(?<!min-)height\s*:\s*100%", style, re.IGNORECASE):
            for cls in classes:
                dotcls = f".{cls}"
                if dotcls in _content_containers:
                    _height_locked_selectors.add(dotcls)
    if _height_locked_selectors:
        warnings.append(_issue(
            "HEIGHT_LOCKED",
            f"Content containers {', '.join(sorted(_height_locked_selectors))} use 'height: 100%' "
            "instead of 'min-height: 100%'. This locks the container height and may clip content "
            "when it exceeds the allocated grid area. Use 'min-height: 100%' to allow content to grow.",
            severity="warning"
        ))

    # ---- Apply all fixes (unified, avoids offset corruption) ----
    # Apply larger replacements (full CSS rules like overflow fixes) before smaller
    # ones (font-family declarations), so the larger match strings are still valid.
    # Sort by length of old_text descending to ensure this order.
    if fix and _all_fixes:
        _all_fixes.sort(key=lambda pair: len(pair[0]), reverse=True)
        for old_text, new_text in _all_fixes:
            if old_text in raw:
                raw = raw.replace(old_text, new_text, 1)

    # ---- Build report ----
    has_errors = len(errors) > 0
    report: dict[str, Any] = {
        "pass": not has_errors,
        "source": html_path,
        "check_type": "html",
        "errors": errors,
        "warnings": warnings,
        "info": info,
    }

    # ---- Fix mode output ----
    if fix:
        if output_path:
            Path(output_path).write_text(raw, encoding="utf-8")
            report["fixed_file"] = output_path
        else:
            # Write fixed HTML to stdout after the JSON report to stderr
            report["fixed_output"] = "stdout"
            # We'll handle this in main()

    report["_fixed_html"] = raw if fix else None
    return report


# ---------------------------------------------------------------------------
# CHECK-PDF
# ---------------------------------------------------------------------------

def check_pdf(pdf_path: str, *, source_html: str | None = None, poster: bool = False) -> dict:
    """Run all PDF post-checks. Return the JSON-serialisable report dict."""

    path = Path(pdf_path)
    errors: list[dict] = []
    warnings: list[dict] = []
    info: list[dict] = []

    if not path.is_file():
        return {"pass": False, "source": pdf_path, "check_type": "pdf",
                "errors": [_issue("FILE_NOT_FOUND", f"Cannot read '{pdf_path}'.")],
                "warnings": [], "info": []}

    # ---- 1. FILE_TOO_SMALL ----
    file_size = path.stat().st_size
    if file_size < 10 * 1024:
        errors.append(_issue(
            "FILE_TOO_SMALL",
            f"PDF is only {file_size} bytes ({file_size/1024:.1f} KB). "
            "Likely empty or broken.",
        ))

    # ---- Import pdfplumber ----
    try:
        import pdfplumber
    except ImportError:
        errors.append(_issue(
            "DEPENDENCY_MISSING",
            "pdfplumber is not installed. Cannot perform PDF text checks. "
            "Install with: \"$(command -v zcode-python || command -v python3)\" -m pip install pdfplumber",
        ))
        return {"pass": False, "source": pdf_path, "check_type": "pdf",
                "errors": errors, "warnings": warnings, "info": info}

    # ---- Open PDF ----
    try:
        pdf = pdfplumber.open(str(path))
    except Exception as exc:
        errors.append(_issue(
            "PDF_UNREADABLE",
            f"Cannot open PDF: {exc}",
        ))
        return {"pass": False, "source": pdf_path, "check_type": "pdf",
                "errors": errors, "warnings": warnings, "info": info}

    pages = pdf.pages

    # ---- 2. TEXT_MISSING (requires source HTML) ----
    pdf_text_parts: list[str] = []
    page_char_counts: list[int] = []

    for page in pages:
        try:
            txt = page.extract_text() or ""
        except Exception:
            txt = ""
        pdf_text_parts.append(txt)
        meaningful = len(re.sub(r"\s", "", txt))
        page_char_counts.append(meaningful)

    pdf_chars = sum(page_char_counts)

    if source_html:
        html_p = Path(source_html)
        if html_p.is_file():
            html_raw = html_p.read_text(encoding="utf-8", errors="replace")
            html_text = _html_visible_text(html_raw)
            html_chars = len(re.sub(r"\s", "", html_text))

            if html_chars > 0 and pdf_chars < html_chars * 0.30:
                errors.append(_issue(
                    "TEXT_MISSING",
                    f"PDF contains only {pdf_chars} meaningful characters vs {html_chars} in "
                    f"source HTML ({pdf_chars/html_chars*100:.0f}%). "
                    "Fonts may have failed to load during rendering.",
                ))
        else:
            warnings.append(_issue(
                "SOURCE_HTML_NOT_FOUND",
                f"Source HTML '{source_html}' not found; skipping TEXT_MISSING check.",
                severity="warning"
            ))

    # ---- 3. DIMENSIONS_UNREASONABLE ----
    for i, page in enumerate(pages):
        w = page.width   # in points
        h = page.height
        if w < 200 or h < 200:
            warnings.append(_issue(
                "DIMENSIONS_UNREASONABLE",
                f"Page {i+1} dimensions are {w:.0f}×{h:.0f}pt "
                f"({w/72:.1f}×{h/72:.1f}in). Unusually small for a poster.",
                severity="warning"
            ))
            break  # only warn once

    # ---- 4. ORPHAN_PAGE ----
    # Skip for poster mode: seamlessly-paginated posters naturally have less content on the last page
    if not poster and len(pages) > 1:
        avg_chars = sum(page_char_counts[:-1]) / max(len(page_char_counts) - 1, 1)
        last_chars = page_char_counts[-1]
        if avg_chars > 0 and last_chars < avg_chars * 0.10:
            warnings.append(_issue(
                "ORPHAN_PAGE",
                f"Last page (page {len(pages)}) has very little content "
                f"({last_chars} chars vs avg {avg_chars:.0f}). "
                "This may indicate accidental overflow. Check your page sizing.",
                severity="warning"
            ))

    pdf.close()

    has_errors = len(errors) > 0
    return {
        "pass": not has_errors,
        "source": pdf_path,
        "check_type": "pdf",
        "errors": errors,
        "warnings": warnings,
        "info": info,
    }


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _truncate(s: str, max_len: int = 80) -> str:
    return s if len(s) <= max_len else s[:max_len - 3] + "..."


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
# LaTeX .tex file checks
# ---------------------------------------------------------------------------

def check_tex(tex_path: str) -> dict:
    """Check a LaTeX .tex file for common issues, especially table overflow in dual-column layouts."""
    errors = []
    warnings = []
    info = []

    if not os.path.exists(tex_path):
        return {"pass": False, "source": tex_path, "check_type": "tex",
                "errors": [_issue("FILE_NOT_FOUND", f"File not found: {tex_path}")], "warnings": [], "info": []}

    with open(tex_path, encoding="utf-8", errors="replace") as f:
        content = f.read()

    lines = content.split("\n")

    # Detect if this is a two-column document
    is_twocolumn = bool(re.search(
        r"\\documentclass\[.*?twocolumn.*?\]"
        r"|\\twocolumn"
        r"|\\begin\{multicols\}"
        r"|IEEEtran|acmart|sig-alternate",
        content, re.IGNORECASE
    ))

    # ---- 1. BARE_TABULAR_IN_TWOCOLUMN ----
    # Find \begin{tabular} not wrapped in resizebox/adjustbox/tabularx/tabular*
    # and not inside a table* (full-width) environment
    if is_twocolumn:
        info.append(_issue("TWOCOLUMN_DETECTED",
                           "Two-column layout detected. Checking tables for overflow risk.",
                           severity="info"))

    # Parse all tabular environments with line numbers
    tabular_pattern = re.compile(r"\\begin\{tabular\}\s*\{([^}]*)\}", re.IGNORECASE)
    for i, line in enumerate(lines, 1):
        m = tabular_pattern.search(line)
        if not m:
            continue

        col_spec = m.group(1)
        # Count data columns (l, c, r, p{}, X — skip @{}, |, >{}, <{})
        col_count = len(re.findall(r"[lcrX]|p\{[^}]*\}", col_spec))

        # Check if this tabular is wrapped in protective environments
        # Look backwards up to 10 lines for wrapping context
        context_start = max(0, i - 11)
        context = "\n".join(lines[context_start:i])
        has_resizebox = bool(re.search(r"\\resizebox", context))
        has_adjustbox = bool(re.search(r"\\adjustbox|\\begin\{adjustbox\}", context))
        has_table_star = bool(re.search(r"\\begin\{table\*\}", context))
        has_makebox = bool(re.search(r"\\makebox\[.*?\\textwidth\]", context))
        is_protected = has_resizebox or has_adjustbox or has_table_star or has_makebox

        if is_twocolumn and col_count >= 5 and not is_protected:
            errors.append(_issue(
                "BARE_TABULAR_OVERFLOW",
                f"Line {i}: \\begin{{tabular}} with {col_count} columns in a two-column document, "
                f"not wrapped in resizebox/adjustbox/table*. This WILL overflow \\columnwidth. "
                f"Fix: use tabularx{{\\columnwidth}}, or wrap in \\resizebox{{\\columnwidth}}{{!}}{{...}}, "
                f"or use table* for full-width.",
                severity="error"
            ))
        elif is_twocolumn and col_count >= 4 and not is_protected:
            warnings.append(_issue(
                "TABULAR_OVERFLOW_RISK",
                f"Line {i}: \\begin{{tabular}} with {col_count} columns in two-column layout. "
                f"May overflow \\columnwidth depending on content width. "
                f"Consider tabularx{{\\columnwidth}} or \\small font size.",
                severity="warning"
            ))
        elif not is_twocolumn and col_count >= 7 and not is_protected:
            warnings.append(_issue(
                "TABULAR_WIDE",
                f"Line {i}: \\begin{{tabular}} with {col_count} columns. "
                f"May overflow \\textwidth. Consider tabularx or resizebox.",
                severity="warning"
            ))

    # ---- 2. TABULAR_WITHOUT_TABLE ----
    # tabular not inside table/table* environment (no caption, no float)
    for i, line in enumerate(lines, 1):
        if re.search(r"\\begin\{tabular\}", line):
            context_start = max(0, i - 6)
            context = "\n".join(lines[context_start:i])
            if not re.search(r"\\begin\{table\*?\}", context):
                warnings.append(_issue(
                    "TABULAR_NO_FLOAT",
                    f"Line {i}: \\begin{{tabular}} not inside a table/table* float environment. "
                    f"Table will be inline (no caption, no \\label, no float positioning).",
                    severity="warning"
                ))

    # ---- 3. PREFER_TABULARX ----
    # Check if tabularx is loaded in preamble
    has_tabularx_pkg = bool(re.search(r"\\usepackage.*\{tabularx\}", content))
    tabular_count = len(re.findall(r"\\begin\{tabular\}", content))
    tabularx_count = len(re.findall(r"\\begin\{tabularx\}", content))
    tabular_star_count = len(re.findall(r"\\begin\{tabular\*\}", content))

    if tabular_count > 0 and tabularx_count == 0 and tabular_star_count == 0:
        if not has_tabularx_pkg:
            warnings.append(_issue(
                "TABULARX_NOT_LOADED",
                f"Document has {tabular_count} tabular environment(s) but tabularx package is not loaded. "
                f"Add \\usepackage{{tabularx}} to preamble for auto-width column support.",
                severity="warning"
            ))

    # ---- 4. IMAGE_NO_WIDTH ----
    # \includegraphics without width/max width constraint
    img_pattern = re.compile(r"\\includegraphics\s*(\[[^\]]*\])?\s*\{")
    for i, line in enumerate(lines, 1):
        m = img_pattern.search(line)
        if m:
            opts = m.group(1) or ""
            if not re.search(r"width|max width|scale|height", opts, re.IGNORECASE):
                warnings.append(_issue(
                    "IMAGE_NO_WIDTH",
                    f"Line {i}: \\includegraphics without width/height constraint. "
                    f"Add [max width=\\columnwidth] or [width=\\columnwidth] to prevent overflow.",
                    severity="warning"
                ))

    # ---- 5. CJK_ASCII_QUOTES ----
    # Detect ASCII " adjacent to CJK characters (common LLM mistake).
    # LaTeX interprets " as right double quote, so "北漂" renders with two
    # right quotes. Chinese text must use Unicode smart quotes “…”.
    cjk_quote_pattern = re.compile(
        r'[\u4e00-\u9fff\u3400-\u4dbf]"'
        r'|"[\u4e00-\u9fff\u3400-\u4dbf]'
    )
    # Regex to strip inline command content that legitimately contains ASCII quotes
    _inline_cmd_re = re.compile(
        r'\\(?:texttt|url|path|lstinline)\{[^}]*\}'
        r'|\\href\{[^}]*\}\{[^}]*\}'
        r"|\\verb([|!@#])(.*?)\1"
    )
    # Track verbatim-like environments to skip
    in_verbatim = False
    for i, line in enumerate(lines, 1):
        # Skip comment lines
        if line.lstrip().startswith('%'):
            continue
        # Track verbatim/lstlisting/minted environments
        if re.search(r'\\begin\{(verbatim|lstlisting|minted|Verbatim|lstcode)\}', line):
            in_verbatim = True
            continue
        if re.search(r'\\end\{(verbatim|lstlisting|minted|Verbatim|lstcode)\}', line):
            in_verbatim = False
            continue
        if in_verbatim:
            continue
        # Strip inline command arguments that may legitimately contain ASCII quotes
        check_line = _inline_cmd_re.sub('', line)
        if cjk_quote_pattern.search(check_line):
            errors.append(_issue(
                "CJK_ASCII_QUOTES",
                f'Line {i}: ASCII \'"\' found adjacent to CJK characters. '
                f'LaTeX interprets " as right double quote (\u201d), so "\u5317\u6f02" renders as \u201d\u5317\u6f02\u201d. '
                f'Fix: use Unicode smart quotes \u201c\u5317\u6f02\u201d (U+201C / U+201D) for Chinese text. '
                f'(This check skips verbatim/lstlisting/minted environments and '
                f'\\texttt{{}}/\\url{{}}/\\href{{}}{{}}/\\verb|| inline commands.)',
                severity="error"
            ))
            break  # One error is enough

    # ---- 6. EQUATION_OVERFLOW_RISK ----
    # Detect equations that are likely too wide for dual-column
    if is_twocolumn:
        in_equation = False
        eq_start_line = 0
        eq_content = ""
        eq_env_name = ""
        eq_envs = ["equation", "displaymath"]
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith('%'):
                continue
            for env in eq_envs:
                if f"\\begin{{{env}}}" in stripped:
                    in_equation = True
                    eq_start_line = i
                    eq_content = ""
                    eq_env_name = env
                if f"\\end{{{env}}}" in stripped and in_equation:
                    in_equation = False
                    # Check for two equations joined by \quad on same line
                    if re.search(r'\\quad\s*\\math', eq_content) or eq_content.count('=') >= 2:
                        if '\\\\' not in eq_content and 'aligned' not in eq_content and 'split' not in eq_content:
                            warnings.append(_issue(
                                "EQUATION_DUAL_ON_LINE",
                                f"Line {eq_start_line}: {eq_env_name} environment contains multiple equations "
                                f"joined by \\quad (or 2+ '=' signs) without line breaks. "
                                f"In dual-column format this will overflow. "
                                f"Fix: use align/split/aligned environment with \\\\ line breaks.",
                                severity="warning"
                            ))
                    # Check for very long equation content
                    math_len = len(re.sub(r'\\[a-zA-Z]+|\s|\{|\}|\[|\]|\^|_', '', eq_content))
                    if math_len > 80:
                        warnings.append(_issue(
                            "EQUATION_OVERFLOW_RISK",
                            f"Line {eq_start_line}: {eq_env_name} has ~{math_len} math chars "
                            f"(threshold 80). Likely overflows single column. "
                            f"Consider split, multline, or factoring out sub-expressions.",
                            severity="warning"
                        ))
            if in_equation:
                eq_content += stripped + " "

    # ---- 7. RESIZEBOX_TEXTWIDTH_IN_TWOCOLUMN ----
    # \resizebox{\textwidth} inside table (not table*) in twocolumn
    if is_twocolumn:
        in_table_star = False
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if '\\begin{table*}' in stripped:
                in_table_star = True
            if '\\end{table*}' in stripped:
                in_table_star = False
            if not in_table_star and '\\resizebox' in stripped and '\\textwidth' in stripped:
                errors.append(_issue(
                    "RESIZEBOX_TEXTWIDTH",
                    f"Line {i}: \\resizebox{{\\textwidth}} used inside single-column float. "
                    f"In two-column layouts, \\textwidth = full page width (~504pt), but "
                    f"a table float is only one column (~252pt). This causes ~50% overflow. "
                    f"Fix: use \\resizebox{{\\columnwidth}}{{!}} for single-column, "
                    f"or change to table* for full-width.",
                    severity="error"
                ))

    # ---- 8. ALGORITHM_OVERFLOW_RISK ----
    if is_twocolumn:
        in_algo = False
        algo_start = 0
        has_small_font = False
        for i, line in enumerate(lines, 1):
            if '\\SetAlFnt' in line and '\\small' in line:
                has_small_font = True
            if '\\begin{algorithm}' in line and '\\begin{algorithm*}' not in line:
                in_algo = True
                algo_start = i
            if '\\end{algorithm}' in line and in_algo:
                in_algo = False
                if not has_small_font:
                    warnings.append(_issue(
                        "ALGORITHM_NO_SMALL_FONT",
                        f"Line {algo_start}: algorithm environment in dual-column without \\SetAlFnt{{\\small}}. "
                        f"Algorithm text at default size frequently overflows narrow columns. "
                        f"Add \\SetAlFnt{{\\small}} before the algorithm.",
                        severity="warning"
                    ))
            # Check for very long KwInput/KwOutput lines
            if in_algo and ('\\KwInput' in line or '\\KwOutput' in line or '\\KwIn' in line or '\\KwOut' in line):
                content_len = len(line.strip())
                if content_len > 120:
                    warnings.append(_issue(
                        "ALGORITHM_LONG_IO",
                        f"Line {i}: Algorithm Input/Output line is {content_len} chars (threshold 120). "
                        f"Long I/O lines overflow column width. Break into multiple lines with \\\\ or "
                        f"abbreviate parameter names.",
                        severity="warning"
                    ))

    # Summary info
    info.append(_issue(
        "TABLE_SUMMARY",
        f"Tables: {tabular_count} tabular, {tabularx_count} tabularx, {tabular_star_count} tabular*. "
        f"Two-column: {'yes' if is_twocolumn else 'no'}.",
        severity="info"
    ))

    has_errors = any(e["severity"] == "error" for e in errors)
    return {
        "pass": not has_errors,
        "source": tex_path,
        "check_type": "tex",
        "errors": errors,
        "warnings": warnings,
        "info": info,
    }


# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate poster HTML/PDF for common quality issues."
    )
    sub = parser.add_subparsers(dest="command")

    # -- check-html --
    p_html = sub.add_parser("check-html", help="Pre-check an HTML file before PDF generation.")
    p_html.add_argument("html_file", help="Path to the HTML file.")
    p_html.add_argument("--fix", action="store_true",
                        help="Auto-fix issues where possible and output corrected HTML.")
    p_html.add_argument("--output", "-o", default=None,
                        help="Write fixed HTML to this file (default: stdout).")

    # -- check-pdf --
    p_pdf = sub.add_parser("check-pdf", help="Post-check a generated PDF file.")
    p_pdf.add_argument("pdf_file", help="Path to the PDF file.")
    p_pdf.add_argument("--source-html", default=None,
                       help="Path to the source HTML (enables TEXT_MISSING check).")
    p_pdf.add_argument("--poster", action="store_true",
                       help="Poster mode: suppress ORPHAN_PAGE for seamlessly-paginated posters.")

    # -- check-tex --
    p_tex = sub.add_parser("check-tex", help="Check a LaTeX .tex file for common issues (table overflow, etc.).")
    p_tex.add_argument("tex_file", help="Path to the .tex file.")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 2

    try:
        if args.command == "check-html":
            report = check_html(
                args.html_file,
                fix=args.fix,
                output_path=args.output,
            )
            fixed_html = report.pop("_fixed_html", None)

            if args.fix and fixed_html and not args.output:
                # JSON report goes to stderr, fixed HTML to stdout
                print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
                print(fixed_html)
            else:
                report.pop("_fixed_html", None)
                print(json.dumps(report, indent=2, ensure_ascii=False))

            return 0 if report["pass"] else 1

        elif args.command == "check-pdf":
            report = check_pdf(
                args.pdf_file,
                source_html=args.source_html,
                poster=getattr(args, 'poster', False),
            )
            print(json.dumps(report, indent=2, ensure_ascii=False))
            return 0 if report["pass"] else 1

        elif args.command == "check-tex":
            report = check_tex(args.tex_file)
            print(json.dumps(report, indent=2, ensure_ascii=False))
            return 0 if report["pass"] else 1

    except Exception as exc:
        err_report = {
            "pass": False,
            "error": f"Script error: {exc}",
            "check_type": args.command.replace("check-", ""),
        }
        print(json.dumps(err_report, indent=2, ensure_ascii=False), file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
