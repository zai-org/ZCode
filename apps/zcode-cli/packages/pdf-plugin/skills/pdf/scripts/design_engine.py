#!/usr/bin/env python3
"""
design_engine.py — Aesthetic computation engine for art-direction-first PDF production.

Philosophy: The LLM handles narrative and composition; this script handles the math
that models get wrong — precise color harmony, algorithmic SVG, and spatial tension.

Three core functions:
  1. generate_color_palette(intent)  — HSL-locked low-saturation palettes
  2. generate_generative_svg(svg_type) — Algorithmic art backgrounds
  3. calculate_layout(elements)      — Deliberate offset/overlap coordinates

Usage:
  "$(command -v zcode-python || command -v python3)" design_engine.py palette --intent calm --mode dark
  "$(command -v zcode-python || command -v python3)" design_engine.py palette --intent tension --mode light
  "$(command -v zcode-python || command -v python3)" design_engine.py svg --intent flow --dimensions 720x960
  "$(command -v zcode-python || command -v python3)" design_engine.py svg --intent grid --dimensions 720x960
  "$(command -v zcode-python || command -v python3)" design_engine.py layout --elements hero,body,meta --dimensions 720x960 --style offset
  "$(command -v zcode-python || command -v python3)" design_engine.py full --intent energy --mode dark --dimensions 720x960 --output-dir ./assets/
"""

import argparse
import colorsys
import json
import math
import os
import random
import sys

# ═══════════════════════════════════════════════════════════════════════
# 1. COLOR PALETTE — HSL with Saturation Clamped to [0.05, 0.25]
# ═══════════════════════════════════════════════════════════════════════
#
# Core constraint: Saturation MUST be between 0.05 and 0.25.
# This eliminates candy-colored, web-app-looking outputs and locks
# everything into the "high-end grey" (高级灰) tonal range.
#
# Two modes:
#   - Dark:  background L < 0.10, text L > 0.85
#   - Light: background L > 0.95, text L < 0.15
# The "muddy middle" (L between 0.30 and 0.70) is forbidden for backgrounds.

# Intent → base hue mapping (degrees on the HSL wheel)
# 5 intents: Calm, Tension, Energy, Authority, Warmth
# Plus utility intents (nature, cold, neutral) for keyword auto-derive
INTENT_HUES = {
    "calm":        210,   # Steel blue-grey, low saturation (merges old serenity+minimalism)
    "tension":     0,     # Warm near-black vs cold
    "energy":      30,    # Amber undertone
    "authority":   280,   # Muted violet, formal/premium (replaces old elegance)
    "warmth":      20,    # Terracotta undertone
    # Utility intents (for keyword auto-derive, not exposed in UI)
    "nature":      150,   # Desaturated sage
    "cold":        200,   # Slate blue
    "neutral":     45,    # Warm grey
    # Legacy aliases (backward compatibility)
    "serenity":    210,   # → calm
    "elegance":    280,   # → authority
    "minimalism":  0,     # → calm (achromatic variant)
}

# Theme keywords → intent mapping (for auto-derive from document description)
# When the user doesn't specify an intent, scan the document title/description
# for these keywords and map to the closest intent.
THEME_KEYWORDS = {
    # Technology / Data / Analytics
    "tech": "cold", "数据": "cold", "data": "cold", "AI": "cold",
    "科技": "cold", "digital": "cold", "analytics": "cold", "分析": "cold",
    # Nature / Environment / Sustainability
    "green": "nature", "绿色": "nature", "环保": "nature", "eco": "nature",
    "sustainability": "nature", "生态": "nature", "forest": "nature",
    # Business / Finance / Corporate
    "report": "neutral", "报告": "neutral", "finance": "neutral", "财务": "neutral",
    "annual": "neutral", "年度": "neutral", "corporate": "neutral",
    # Creative / Marketing / Social
    "marketing": "energy", "运营": "energy", "social": "energy", "品牌": "energy",
    "campaign": "energy", "活动": "energy", "launch": "energy",
    # Authority / Formal / Premium / Luxury
    "luxury": "authority", "奢华": "authority", "fashion": "authority", "时尚": "authority",
    "premium": "authority", "高端": "authority", "gala": "authority",
    "formal": "authority", "正式": "authority", "professional": "authority", "专业": "authority",
    "government": "authority", "政府": "authority", "bidding": "authority", "投标": "authority",
    "政府报告": "authority", "政府文书": "authority", "公文": "authority",
    "thesis": "authority", "毕业论文": "authority", "dissertation": "authority",
    "开题": "authority", "开题报告": "authority", "proposal": "authority", "学位": "authority",
    # Calm / Meditation / Healthcare / Minimalist
    "health": "calm", "健康": "calm", "meditation": "calm",
    "wellness": "calm", "calm": "calm", "医疗": "calm",
    "minimalist": "calm", "极简": "calm", "simple": "calm", "简约": "calm",
    # Urgent / Warning / Emergency
    "urgent": "tension", "warning": "tension", "紧急": "tension",
    "alert": "tension", "crisis": "tension",
    # Warm / Food / Lifestyle
    "food": "warmth", "美食": "warmth", "lifestyle": "warmth",
    "生活": "warmth", "home": "warmth", "家居": "warmth",
}


def derive_intent(text):
    """
    Auto-derive design intent from document title/description.
    Scans for theme keywords and returns the best-matching intent.
    Falls back to 'neutral' if no keywords match.

    Usage:
        "$(command -v zcode-python || command -v python3)" design_engine.py derive "Social Media Operations Monthly Report"  → energy
        "$(command -v zcode-python || command -v python3)" design_engine.py derive "2025 Annual Sustainability Report"  → nature
    """
    text_lower = text.lower()
    scores = {}
    for keyword, intent in THEME_KEYWORDS.items():
        if keyword.lower() in text_lower:
            scores[intent] = scores.get(intent, 0) + 1
    if not scores:
        return "neutral"
    # When tied, prefer specific intents over 'neutral' (which is a generic fallback)
    max_score = max(scores.values())
    top_intents = [k for k, v in scores.items() if v == max_score]
    if len(top_intents) > 1 and "neutral" in top_intents:
        top_intents.remove("neutral")
    return top_intents[0]

# Intent → recommended harmony mapping (reduces LLM decision burden)
# Used as fallback when LLM doesn't specify color_harmony
INTENT_HARMONY_MAP = {
    "calm":       "analogous",             # peaceful, flowing transition (merges serenity+minimalism)
    "tension":    "complementary",         # maximum visual conflict
    "energy":     "triadic",               # vibrant, multi-directional
    "authority":  "split_complementary",   # sophisticated, formal (replaces elegance)
    "warmth":     "analogous",             # natural, earthy cohesion
    # Utility intents
    "nature":     "analogous",             # organic harmony
    "cold":       "split_complementary",   # icy precision with subtle warmth
    "neutral":    "split_complementary",   # safe default, still interesting
    # Legacy aliases
    "serenity":   "analogous",
    "elegance":   "split_complementary",
    "minimalism": "monochrome",
}

def _hsl_to_hex(h, s, l):
    """Convert HSL (h: 0-360, s: 0-1, l: 0-1) to hex string."""
    r, g, b = colorsys.hls_to_rgb(h / 360.0, l, s)
    return f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}"


# Muddy / ugly hue zones that produce unattractive accent colors at medium saturation.
# These hue ranges tend to look "dirty" or "sickly" — yellow-green, brown-orange, etc.
# When an accent lands here, we nudge it to the nearest attractive neighbor.
_UGLY_HUE_ZONES = [
    # (start, end, nudge_low, nudge_high) — hues that look muddy
    # at S 0.4-0.7, L 0.35-0.55. When accent lands here, redirect.
    (28, 105, 15, 120),  # Dirty yellow/brown/olive/yellow-green zone
                          # nudge_low=15 (warm red-orange), nudge_high=120 (true green)
]


def _sanitize_accent_hue(hue):
    """Nudge accent hue away from muddy/ugly zones toward attractive neighbors."""
    hue = hue % 360
    for start, end, nudge_low, nudge_high in _UGLY_HUE_ZONES:
        if start <= hue <= end:
            mid = (start + end) / 2
            return nudge_low if hue < mid else nudge_high
    return hue

def _hex_to_rgb(hex_str):
    """Convert hex to 'r,g,b' string for rgba() usage."""
    hex_str = hex_str.lstrip('#')
    return f"{int(hex_str[0:2], 16)},{int(hex_str[2:4], 16)},{int(hex_str[4:6], 16)}"

def _relative_luminance(hex_str):
    """WCAG 2.1 relative luminance from hex color."""
    hex_str = hex_str.lstrip('#')
    channels = []
    for i in (0, 2, 4):
        c = int(hex_str[i:i+2], 16) / 255.0
        channels.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]

def _contrast_ratio(hex1, hex2):
    """WCAG contrast ratio between two hex colors."""
    l1, l2 = _relative_luminance(hex1), _relative_luminance(hex2)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)

def generate_color_palette(intent="neutral", mode="minimal", harmony=None, seed=None):
    """
    Generative Color Harmony Engine — geometric accent computation + 5 aesthetic modes.

    LLM is FORBIDDEN from specifying HEX/RGB. It only selects:
      - intent   → base hue (from INTENT_HUES)
      - mode     → S/L physical boundaries (minimal/dark/pastel/jewel/light)
      - harmony  → accent hue geometry (auto-recommended from intent if omitted)

    Returns dict with:
      - bg:      60% — dominant ground
      - mid:     30% — structural shade
      - accent:  10% — geometric harmony emphasis
      - text:    primary text color
      - muted:   secondary/caption text
      - surface: card/container background (translucent)
    """
    if seed is not None:
        random.seed(seed)

    # Auto-recommend harmony from intent if not specified
    if harmony is None or harmony == "auto":
        harmony = INTENT_HARMONY_MAP.get(intent, "split_complementary")

    base_hue = INTENT_HUES.get(intent, random.randint(0, 359))

    # 1. Geometric Accent Hue Derivation
    if harmony == "complementary":
        accent_hue = (base_hue + 180) % 360
    elif harmony == "split_complementary":
        accent_hue = (base_hue + random.choice([150, 210])) % 360
    elif harmony == "triadic":
        accent_hue = (base_hue + random.choice([120, 240])) % 360
    elif harmony == "analogous":
        accent_hue = (base_hue + random.choice([30, -30, 45, -45])) % 360
    else:  # monochrome
        accent_hue = base_hue

    # Sanitize accent hue — avoid muddy yellow-green and brown-orange zones
    accent_hue = _sanitize_accent_hue(accent_hue)

    # 2. Five Aesthetic Modes — hard-lock S and L boundaries
    if mode == "minimal":
        # DEFAULT for 50%+ of documents. Editorial paper tone + high-purity accent.
        # bg has visible tint (S 0.08-0.15, L 0.92-0.96) — not dead white.
        is_warm = random.choice([True, False])
        paper_hue = random.randint(35, 45) if is_warm else random.randint(200, 215)
        bg      = _hsl_to_hex(paper_hue,   random.uniform(0.08, 0.15), random.uniform(0.92, 0.96))
        mid     = _hsl_to_hex(paper_hue,   random.uniform(0.10, 0.18), random.uniform(0.85, 0.90))
        accent  = _hsl_to_hex(accent_hue,  random.uniform(0.55, 0.72), random.uniform(0.42, 0.52))
        text    = _hsl_to_hex(paper_hue,   0.05,                       random.uniform(0.10, 0.15))
        muted   = _hsl_to_hex(paper_hue,   0.05,                       random.uniform(0.45, 0.55))
        surface = f"rgba(0,0,0,{random.uniform(0.01, 0.03):.2f})"

    elif mode == "dark":
        # Cyber/tech: ultra-low saturation, ultra-low lightness
        bg      = _hsl_to_hex(base_hue,    random.uniform(0.04, 0.10), random.uniform(0.04, 0.08))
        mid     = _hsl_to_hex(base_hue,    random.uniform(0.08, 0.15), random.uniform(0.12, 0.20))
        accent  = _hsl_to_hex(accent_hue,  random.uniform(0.45, 0.60), random.uniform(0.52, 0.62))
        text    = _hsl_to_hex(base_hue,    0.05,                       random.uniform(0.88, 0.95))
        muted   = _hsl_to_hex(base_hue,    0.05,                       random.uniform(0.45, 0.55))
        surface = f"rgba(255,255,255,{random.uniform(0.03, 0.06):.2f})"

    elif mode == "pastel":
        # Morandi/macaron: medium-low saturation, high lightness
        # Accent tightened: S capped at 0.50 to avoid clashing with tinted bg
        bg      = _hsl_to_hex(base_hue,    random.uniform(0.15, 0.35), random.uniform(0.85, 0.92))
        mid     = _hsl_to_hex(base_hue,    random.uniform(0.20, 0.40), random.uniform(0.75, 0.82))
        accent  = _hsl_to_hex(accent_hue,  random.uniform(0.38, 0.50), random.uniform(0.38, 0.48))
        text    = _hsl_to_hex(base_hue,    0.15,                       random.uniform(0.15, 0.25))
        muted   = _hsl_to_hex(base_hue,    0.20,                       random.uniform(0.45, 0.55))
        surface = f"rgba(255,255,255,{random.uniform(0.30, 0.50):.2f})"

    elif mode == "jewel":
        # Gem/luxury: medium-high saturation bg, accent must NOT compete — lower S, higher L
        bg      = _hsl_to_hex(base_hue,    random.uniform(0.40, 0.60), random.uniform(0.15, 0.25))
        mid     = _hsl_to_hex(base_hue,    random.uniform(0.40, 0.60), random.uniform(0.25, 0.35))
        accent  = _hsl_to_hex(accent_hue,  random.uniform(0.30, 0.50), random.uniform(0.65, 0.80))
        text    = _hsl_to_hex(base_hue,    0.10,                       random.uniform(0.90, 0.96))
        muted   = _hsl_to_hex(base_hue,    0.20,                       random.uniform(0.60, 0.70))
        surface = f"rgba(0,0,0,{random.uniform(0.20, 0.40):.2f})"

    else:
        # light — noticeably tinted, not dead white (S 0.10-0.20, L 0.91-0.95)
        bg      = _hsl_to_hex(base_hue,    random.uniform(0.10, 0.20), random.uniform(0.91, 0.95))
        mid     = _hsl_to_hex(base_hue,    random.uniform(0.15, 0.25), random.uniform(0.84, 0.90))
        accent  = _hsl_to_hex(accent_hue,  random.uniform(0.35, 0.45), random.uniform(0.35, 0.45))
        text    = _hsl_to_hex(base_hue,    0.08,                       random.uniform(0.08, 0.15))
        muted   = _hsl_to_hex(base_hue,    0.05,                       random.uniform(0.45, 0.55))
        surface = f"rgba(0,0,0,{random.uniform(0.02, 0.05):.2f})"

    # 3. WCAG Contrast Safety Net — ensure text:bg ratio ≥ 4.5:1
    text_cr = _contrast_ratio(text, bg)
    if text_cr < 4.5:
        # Push text darker (light modes) or lighter (dark modes)
        r, g, b = (int(bg.lstrip('#')[i:i+2], 16) / 255.0 for i in (0, 2, 4))
        _, bg_l, _ = colorsys.rgb_to_hls(r, g, b)
        if bg_l > 0.5:
            text = _hsl_to_hex(base_hue, 0.08, 0.08)  # force near-black
        else:
            text = _hsl_to_hex(base_hue, 0.05, 0.95)  # force near-white

    # 4. Accent-on-bg visibility check — ensure accent stands out (ratio ≥ 3:1)
    accent_cr = _contrast_ratio(accent, bg)
    if accent_cr < 3.0:
        # Nudge accent lightness away from bg
        r, g, b = (int(bg.lstrip('#')[i:i+2], 16) / 255.0 for i in (0, 2, 4))
        _, bg_l, _ = colorsys.rgb_to_hls(r, g, b)
        target_l = 0.35 if bg_l > 0.5 else 0.70
        r2, g2, b2 = (int(accent.lstrip('#')[i:i+2], 16) / 255.0 for i in (0, 2, 4))
        _, _, accent_s = colorsys.rgb_to_hls(r2, g2, b2)
        accent = _hsl_to_hex(accent_hue, accent_s, target_l)

    return {
        "bg": bg, "bg_rgb": _hex_to_rgb(bg),
        "mid": mid, "mid_rgb": _hex_to_rgb(mid),
        "accent": accent, "accent_rgb": _hex_to_rgb(accent),
        "text": text, "muted": muted,
        "surface": surface,
        "meta": {
            "intent": intent, "mode": mode, "harmony": harmony,
            "base_hue": base_hue, "accent_hue": accent_hue,
            "contrast": {
                "text_on_bg": round(_contrast_ratio(text, bg), 2),
                "accent_on_bg": round(_contrast_ratio(accent, bg), 2),
            }
        }
    }

def palette_to_css(palette):
    """Convert palette dict to CSS custom properties."""
    return f""":root {{
  /* 60% ground */
  --c-bg: {palette['bg']};
  --c-bg-rgb: {palette['bg_rgb']};
  /* 30% structure */
  --c-mid: {palette['mid']};
  --c-mid-rgb: {palette['mid_rgb']};
  /* 10% emphasis */
  --c-accent: {palette['accent']};
  --c-accent-rgb: {palette['accent_rgb']};
  /* Typography */
  --c-text: {palette['text']};
  --c-muted: {palette['muted']};
  /* Surfaces */
  --c-surface: {palette['surface']};
}}"""


# ═══════════════════════════════════════════════════════════════════════
# 1b. CASCADE PALETTE — Role-Based Unified Color System
# ═══════════════════════════════════════════════════════════════════════
#
# Iron Law: Area ∝ 1/Saturation.
# The larger the colored area, the LOWER its saturation must be.
#
# Role tiers by area usage:
#   XL (>50% of page): page_bg, section_bg   → S ≤ 0.08, near-white/near-black
#   L  (20-50%):       card_bg, table_stripe  → S ≤ 0.15
#   M  (5-20%):        header_fill, sidebar   → S ≤ 0.30
#   S  (1-5%):         border, divider, icon   → S ≤ 0.50
#   XS (<1%):          accent_dot, badge, tag  → S up to 0.75 (the only place high-sat lives)
#
# Every color is derived from one base hue. No orphan colors.

# Tier saturation caps — enforced at generation AND audit time
CASCADE_TIER_CAPS = {
    "xl": 0.08,   # Page background, section background
    "l":  0.15,   # Card background, table stripe
    "m":  0.30,   # Header fill, sidebar, cover decorative blocks
    "s":  0.50,   # Borders, dividers, icons, chart grid lines
    "xs": 0.75,   # Accent dot, badge, tag, data point highlight
}


def generate_cascade_palette(intent="neutral", mode="minimal", harmony=None, seed=None):
    """
    Generate a role-based palette cascade where every color is derived from one
    base hue and saturation is inversely proportional to usage area.

    Returns a dict with:
      roles:     Complete role table (12 roles, each with hex, hsl, tier, usage_hint)
      cover:     Subset of roles for cover page rendering
      body:      Subset of roles for body content
      charts:    Subset of roles for data visualization
      semantic:  Low-saturation semantic colors (success, warning, error, info)
      meta:      Generation metadata (intent, mode, harmony, base_hue, audit)
      css:       Ready-to-use CSS custom properties
      reportlab: Ready-to-paste ReportLab Python code
    """
    if seed is not None:
        random.seed(seed)

    if harmony is None or harmony == "auto":
        harmony = INTENT_HARMONY_MAP.get(intent, "split_complementary")

    base_hue = INTENT_HUES.get(intent, random.randint(0, 359))

    # Geometric accent hue derivation (same logic as original)
    if harmony == "complementary":
        accent_hue = (base_hue + 180) % 360
    elif harmony == "split_complementary":
        accent_hue = (base_hue + random.choice([150, 210])) % 360
    elif harmony == "triadic":
        accent_hue = (base_hue + random.choice([120, 240])) % 360
    elif harmony == "analogous":
        accent_hue = (base_hue + random.choice([30, -30, 45, -45])) % 360
    else:  # monochrome
        accent_hue = base_hue

    # Sanitize accent hue — avoid muddy zones
    accent_hue = _sanitize_accent_hue(accent_hue)

    # Secondary hue — between base and accent, for chart variety
    secondary_hue = _sanitize_accent_hue(
        (base_hue + accent_hue) / 2 if accent_hue != base_hue else (base_hue + 30) % 360
    )

    # Mode-dependent lightness anchors
    is_dark = mode == "dark"
    if is_dark:
        bg_l_range = (0.04, 0.08)
        text_l = random.uniform(0.88, 0.95)
        muted_l = random.uniform(0.50, 0.60)
    elif mode == "jewel":
        bg_l_range = (0.15, 0.25)
        text_l = random.uniform(0.90, 0.96)
        muted_l = random.uniform(0.60, 0.70)
    else:  # minimal, pastel, light
        bg_l_range = (0.94, 0.97)
        text_l = random.uniform(0.08, 0.15)
        muted_l = random.uniform(0.45, 0.55)

    # ── Generate all 12 roles ──
    roles = {}

    # XL tier: page bg, section bg
    roles["page_bg"] = _make_role(
        base_hue, random.uniform(0.03, 0.08), random.uniform(*bg_l_range),
        "xl", "Page background, full-bleed areas")
    roles["section_bg"] = _make_role(
        base_hue, random.uniform(0.04, 0.08),
        random.uniform(bg_l_range[0] - 0.03, bg_l_range[1] - 0.02) if not is_dark
        else random.uniform(0.08, 0.14),
        "xl", "Section background, alternating bands")

    # L tier: card bg, table stripe
    roles["card_bg"] = _make_role(
        base_hue, random.uniform(0.06, 0.14),
        random.uniform(0.90, 0.94) if not is_dark else random.uniform(0.10, 0.16),
        "l", "Card/container background, table even rows")
    roles["table_stripe"] = _make_role(
        base_hue, random.uniform(0.05, 0.12),
        random.uniform(0.92, 0.96) if not is_dark else random.uniform(0.08, 0.12),
        "l", "Table alternating row fill")

    # M tier: header fill, sidebar, cover decorative block
    roles["header_fill"] = _make_role(
        base_hue, random.uniform(0.15, 0.28),
        random.uniform(0.25, 0.40) if not is_dark else random.uniform(0.20, 0.30),
        "m", "Table header, sidebar background, cover top bar")
    roles["cover_block"] = _make_role(
        base_hue, random.uniform(0.12, 0.25),
        random.uniform(0.30, 0.45) if not is_dark else random.uniform(0.15, 0.25),
        "m", "Cover decorative block, sidebar pillar")

    # S tier: border, divider, icon fill
    roles["border"] = _make_role(
        base_hue, random.uniform(0.10, 0.25),
        random.uniform(0.70, 0.82) if not is_dark else random.uniform(0.25, 0.35),
        "s", "Borders, divider lines, chart grid")
    roles["icon"] = _make_role(
        base_hue, random.uniform(0.25, 0.45),
        random.uniform(0.35, 0.50) if not is_dark else random.uniform(0.55, 0.70),
        "s", "Icons, bullet points, small UI elements")

    # XS tier: accent, badge, data highlight
    roles["accent"] = _make_role(
        accent_hue, random.uniform(0.50, 0.70),
        random.uniform(0.40, 0.55) if not is_dark else random.uniform(0.55, 0.70),
        "xs", "Primary accent: badges, tags, data point highlights, CTA")
    roles["accent_secondary"] = _make_role(
        secondary_hue, random.uniform(0.40, 0.60),
        random.uniform(0.45, 0.58) if not is_dark else random.uniform(0.50, 0.65),
        "xs", "Secondary accent: chart series 2, secondary badge")

    # Typography (no tier — text is special)
    roles["text_primary"] = _make_role(
        base_hue, 0.05, text_l,
        "text", "Primary body text")
    roles["text_muted"] = _make_role(
        base_hue, 0.04, muted_l,
        "text", "Captions, footnotes, secondary text")

    # ── Semantic colors (derived from base hue, low-sat) ──
    semantic = {
        "success": _make_role(140, random.uniform(0.25, 0.40),
                              random.uniform(0.35, 0.45) if not is_dark else random.uniform(0.55, 0.65),
                              "xs", "Positive: growth, pass, complete"),
        "warning": _make_role(40, random.uniform(0.30, 0.45),
                              random.uniform(0.40, 0.50) if not is_dark else random.uniform(0.55, 0.65),
                              "xs", "Caution: pending, alert"),
        "error":   _make_role(5, random.uniform(0.30, 0.45),
                              random.uniform(0.40, 0.50) if not is_dark else random.uniform(0.55, 0.65),
                              "xs", "Negative: decline, fail, error"),
        "info":    _make_role(210, random.uniform(0.25, 0.40),
                              random.uniform(0.40, 0.50) if not is_dark else random.uniform(0.55, 0.65),
                              "xs", "Informational: neutral status"),
    }

    # ── WCAG contrast enforcement ──
    page_bg_hex = roles["page_bg"]["hex"]
    text_hex = roles["text_primary"]["hex"]
    if _contrast_ratio(text_hex, page_bg_hex) < 4.5:
        if not is_dark:
            roles["text_primary"] = _make_role(base_hue, 0.08, 0.08, "text", "Primary body text")
        else:
            roles["text_primary"] = _make_role(base_hue, 0.05, 0.95, "text", "Primary body text")

    accent_hex = roles["accent"]["hex"]
    if _contrast_ratio(accent_hex, page_bg_hex) < 3.0:
        # Push accent lightness further from bg
        r, g, b = (int(page_bg_hex.lstrip('#')[i:i+2], 16) / 255.0 for i in (0, 2, 4))
        _, bg_l, _ = colorsys.rgb_to_hls(r, g, b)
        target_l = 0.35 if bg_l > 0.5 else 0.75
        roles["accent"] = _make_role(accent_hue, random.uniform(0.50, 0.70), target_l,
                                      "xs", "Primary accent: badges, tags, data point highlights, CTA")

    # ── Tier saturation audit (clamp any violations) ──
    for name, role in {**roles, **semantic}.items():
        tier = role["tier"]
        if tier in CASCADE_TIER_CAPS:
            cap = CASCADE_TIER_CAPS[tier]
            if role["hsl"][1] > cap:
                # Re-generate with capped saturation
                capped_s = cap * random.uniform(0.85, 1.0)
                fixed = _make_role(role["hsl"][0], capped_s, role["hsl"][2],
                                   tier, role["usage_hint"])
                if name in roles:
                    roles[name] = fixed
                elif name in semantic:
                    semantic[name] = fixed

    # ── Build convenience subsets ──
    cover_subset = {
        "background":   roles["page_bg"]["hex"],
        "top_bar":      roles["header_fill"]["hex"],
        "sidebar":      roles["cover_block"]["hex"],
        "accent_line":  roles["accent"]["hex"],
        "title":        roles["text_primary"]["hex"],
        "subtitle":     roles["text_muted"]["hex"],
        "watermark":    roles["border"]["hex"],  # low-opacity usage
    }

    body_subset = {
        "page_bg":       roles["page_bg"]["hex"],
        "section_bg":    roles["section_bg"]["hex"],
        "card_bg":       roles["card_bg"]["hex"],
        "table_header":  roles["header_fill"]["hex"],
        "table_stripe":  roles["table_stripe"]["hex"],
        "border":        roles["border"]["hex"],
        "heading":       roles["text_primary"]["hex"],
        "body_text":     roles["text_primary"]["hex"],
        "caption":       roles["text_muted"]["hex"],
        "highlight":     roles["accent"]["hex"],
    }

    chart_subset = {
        "series_1":     roles["accent"]["hex"],
        "series_2":     roles["accent_secondary"]["hex"],
        "series_3":     roles["header_fill"]["hex"],
        "series_4":     roles["icon"]["hex"],
        "series_5":     roles["cover_block"]["hex"],
        "grid":         roles["border"]["hex"],
        "axis_text":    roles["text_muted"]["hex"],
        "label":        roles["text_primary"]["hex"],
        "up":           semantic["success"]["hex"],
        "down":         semantic["error"]["hex"],
    }

    # ── Generate outputs ──
    css = _cascade_to_css(roles, semantic)
    reportlab_code = _cascade_to_reportlab(roles, semantic)

    audit_results = audit_cascade_palette(roles, semantic)

    return {
        "roles": {k: {"hex": v["hex"], "hsl": v["hsl"], "tier": v["tier"], "usage": v["usage_hint"]} for k, v in roles.items()},
        "cover": cover_subset,
        "body": body_subset,
        "charts": chart_subset,
        "semantic": {k: {"hex": v["hex"], "hsl": v["hsl"]} for k, v in semantic.items()},
        "meta": {
            "intent": intent, "mode": mode, "harmony": harmony,
            "base_hue": base_hue, "accent_hue": accent_hue, "secondary_hue": secondary_hue,
            "contrast": {
                "text_on_bg": round(_contrast_ratio(roles["text_primary"]["hex"], roles["page_bg"]["hex"]), 2),
                "accent_on_bg": round(_contrast_ratio(roles["accent"]["hex"], roles["page_bg"]["hex"]), 2),
            },
            "audit": audit_results,
        },
        "css": css,
        "reportlab": reportlab_code,
    }


def _make_role(h, s, l, tier, usage_hint):
    """Create a role entry with hex, HSL tuple, tier, and usage hint."""
    hex_val = _hsl_to_hex(h, s, l)
    return {
        "hex": hex_val,
        "hsl": (round(h, 1), round(s, 3), round(l, 3)),
        "tier": tier,
        "usage_hint": usage_hint,
    }


def _cascade_to_css(roles, semantic):
    """Convert cascade palette to CSS custom properties."""
    lines = [":root {"]
    lines.append("  /* ── XL tier: backgrounds (S ≤ 0.08) ── */")
    lines.append(f"  --page-bg: {roles['page_bg']['hex']};")
    lines.append(f"  --section-bg: {roles['section_bg']['hex']};")
    lines.append("  /* ── L tier: surfaces (S ≤ 0.15) ── */")
    lines.append(f"  --card-bg: {roles['card_bg']['hex']};")
    lines.append(f"  --table-stripe: {roles['table_stripe']['hex']};")
    lines.append("  /* ── M tier: structural fills (S ≤ 0.30) ── */")
    lines.append(f"  --header-fill: {roles['header_fill']['hex']};")
    lines.append(f"  --cover-block: {roles['cover_block']['hex']};")
    lines.append("  /* ── S tier: edges & icons (S ≤ 0.50) ── */")
    lines.append(f"  --border: {roles['border']['hex']};")
    lines.append(f"  --icon: {roles['icon']['hex']};")
    lines.append("  /* ── XS tier: emphasis (S ≤ 0.75) ── */")
    lines.append(f"  --accent: {roles['accent']['hex']};")
    lines.append(f"  --accent-secondary: {roles['accent_secondary']['hex']};")
    lines.append("  /* ── Typography ── */")
    lines.append(f"  --text-primary: {roles['text_primary']['hex']};")
    lines.append(f"  --text-muted: {roles['text_muted']['hex']};")
    lines.append("  /* ── Semantic (low-sat) ── */")
    for k, v in semantic.items():
        lines.append(f"  --semantic-{k}: {v['hex']};")
    lines.append("}")
    return "\n".join(lines)


def _cascade_to_reportlab(roles, semantic):
    """Convert cascade palette to ReportLab Python code."""
    lines = [
        "# ━━ Cascade Palette (auto-generated by design_engine.py palette-cascade) ━━",
        "from reportlab.lib import colors",
        "",
        "# XL tier: backgrounds (area > 50%, S ≤ 0.08)",
        f"PAGE_BG       = colors.HexColor('{roles['page_bg']['hex']}')",
        f"SECTION_BG    = colors.HexColor('{roles['section_bg']['hex']}')",
        "",
        "# L tier: surfaces (area 20-50%, S ≤ 0.15)",
        f"CARD_BG       = colors.HexColor('{roles['card_bg']['hex']}')",
        f"TABLE_STRIPE  = colors.HexColor('{roles['table_stripe']['hex']}')",
        "",
        "# M tier: structural fills (area 5-20%, S ≤ 0.30)",
        f"HEADER_FILL   = colors.HexColor('{roles['header_fill']['hex']}')",
        f"COVER_BLOCK   = colors.HexColor('{roles['cover_block']['hex']}')",
        "",
        "# S tier: edges & icons (area 1-5%, S ≤ 0.50)",
        f"BORDER        = colors.HexColor('{roles['border']['hex']}')",
        f"ICON          = colors.HexColor('{roles['icon']['hex']}')",
        "",
        "# XS tier: emphasis (area < 1%, S ≤ 0.75)",
        f"ACCENT        = colors.HexColor('{roles['accent']['hex']}')",
        f"ACCENT_2      = colors.HexColor('{roles['accent_secondary']['hex']}')",
        "",
        "# Typography",
        f"TEXT_PRIMARY   = colors.HexColor('{roles['text_primary']['hex']}')",
        f"TEXT_MUTED     = colors.HexColor('{roles['text_muted']['hex']}')",
        "",
        "# Semantic (low-saturation, area-appropriate)",
        f"SEM_SUCCESS   = colors.HexColor('{semantic['success']['hex']}')",
        f"SEM_WARNING   = colors.HexColor('{semantic['warning']['hex']}')",
        f"SEM_ERROR     = colors.HexColor('{semantic['error']['hex']}')",
        f"SEM_INFO      = colors.HexColor('{semantic['info']['hex']}')",
    ]
    return "\n".join(lines)


def audit_cascade_palette(roles, semantic):
    """Audit cascade palette for tier saturation violations and WCAG contrast."""
    violations = []
    for name, role in {**roles, **semantic}.items():
        tier = role["tier"]
        if tier in CASCADE_TIER_CAPS:
            cap = CASCADE_TIER_CAPS[tier]
            s = role["hsl"][1]
            if s > cap:
                violations.append(f"{name}: S={s:.3f} exceeds tier '{tier}' cap {cap}")

    # WCAG checks
    bg_hex = roles["page_bg"]["hex"]
    text_hex = roles["text_primary"]["hex"]
    cr = _contrast_ratio(text_hex, bg_hex)
    if cr < 4.5:
        violations.append(f"text_primary:page_bg contrast {cr:.2f} < 4.5:1 (WCAG AA)")

    accent_hex = roles["accent"]["hex"]
    cr_a = _contrast_ratio(accent_hex, bg_hex)
    if cr_a < 3.0:
        violations.append(f"accent:page_bg contrast {cr_a:.2f} < 3.0:1 (accent invisible)")

    # Header fill should be readable with white text on it
    hf_hex = roles["header_fill"]["hex"]
    cr_hf = _contrast_ratio("#ffffff", hf_hex)
    if cr_hf < 3.0:
        violations.append(f"white on header_fill contrast {cr_hf:.2f} < 3.0:1 (header text unreadable)")

    return violations


# ═══════════════════════════════════════════════════════════════════════
# 2. GENERATIVE SVG — Algorithmic Art Backgrounds
# ═══════════════════════════════════════════════════════════════════════
#
# Two primary modes:
#   - "flow": 3-5 large-radius bézier curves at ultra-low opacity (0.05)
#             Creates organic, breathing atmospheric depth
#   - "grid": 1px reference grid or noise texture
#             Creates structured, architectural underlying rhythm
#
# All SVG is inline-ready (no external files needed).

def _svg_open(w, h):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'

def _random_bezier_path(w, h):
    """Generate a single flowing bézier curve across the canvas."""
    # Start from a random edge point
    x0 = random.uniform(-w * 0.2, w * 0.3)
    y0 = random.uniform(0, h)
    # End at the opposite side
    x3 = random.uniform(w * 0.7, w * 1.2)
    y3 = random.uniform(0, h)
    # Control points — large sweeps for organic feel
    cx1 = random.uniform(w * 0.1, w * 0.5)
    cy1 = random.uniform(-h * 0.3, h * 1.3)
    cx2 = random.uniform(w * 0.5, w * 0.9)
    cy2 = random.uniform(-h * 0.3, h * 1.3)
    return f"M{x0:.0f},{y0:.0f} C{cx1:.0f},{cy1:.0f} {cx2:.0f},{cy2:.0f} {x3:.0f},{y3:.0f}"

def generate_flow_svg(w, h, color="#8a8a8a", curves=4, stroke_width=80, opacity=0.05):
    """
    Flow mode: ultra-wide, ultra-faint bézier curves.
    Creates atmospheric depth without competing with content.
    """
    random.seed(42)
    svg = _svg_open(w, h)
    svg += '\n  <defs>'
    svg += '\n    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">'
    svg += f'\n      <stop offset="0%" stop-color="{color}" stop-opacity="{opacity}"/>'
    svg += f'\n      <stop offset="50%" stop-color="{color}" stop-opacity="{opacity * 1.5:.3f}"/>'
    svg += f'\n      <stop offset="100%" stop-color="{color}" stop-opacity="{opacity * 0.5:.3f}"/>'
    svg += '\n    </linearGradient>'
    svg += '\n  </defs>'

    for i in range(curves):
        path = _random_bezier_path(w, h)
        sw = stroke_width + random.uniform(-20, 30)
        svg += f'\n  <path d="{path}" fill="none" stroke="url(#fg)" '
        svg += f'stroke-width="{sw:.0f}" stroke-linecap="round" opacity="{opacity + i * 0.01:.3f}"/>'

    svg += '\n</svg>'
    return svg

def generate_grid_svg(w, h, color="#888888", spacing=60, line_width=0.5, opacity=0.04):
    """
    Grid mode: architectural reference grid.
    Ultra-faint 1px lines creating underlying structure.
    """
    svg = _svg_open(w, h)
    svg += f'\n  <g opacity="{opacity}">'
    # Vertical lines
    for x in range(0, int(w) + 1, spacing):
        svg += f'\n    <line x1="{x}" y1="0" x2="{x}" y2="{h}" stroke="{color}" stroke-width="{line_width}"/>'
    # Horizontal lines
    for y in range(0, int(h) + 1, spacing):
        svg += f'\n    <line x1="0" y1="{y}" x2="{w}" y2="{y}" stroke="{color}" stroke-width="{line_width}"/>'
    svg += '\n  </g>'
    svg += '\n</svg>'
    return svg

def generate_noise_svg(w, h, frequency=0.8, octaves=4, opacity=0.035):
    """
    Noise mode: feTurbulence grain texture.
    Adds tactile paper-like quality.
    """
    svg = _svg_open(w, h)
    svg += f"""
  <defs>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="{frequency}"
                    numOctaves="{octaves}" stitchTiles="stitch" result="noise"/>
      <feColorMatrix type="saturate" values="0" in="noise" result="grey"/>
    </filter>
  </defs>
  <rect width="{w}" height="{h}" filter="url(#grain)" opacity="{opacity}"/>"""
    svg += '\n</svg>'
    return svg

def _generate_data_driven_svg(data_points, w=720, h=960, color="#8a8a8a"):
    """
    Content-Aware SVG: Transform business data arrays into Bézier background curves.
    The background subtly echoes the data's shape — a cross-modal design metaphor.
    """
    if not data_points or len(data_points) < 2:
        return generate_flow_svg(w, h, color)

    n = len(data_points)
    min_v = min(data_points)
    max_v = max(data_points)
    rng = max_v - min_v if max_v != min_v else 1.0

    # Normalize data to canvas coordinates
    # X: evenly spaced across width; Y: mapped to 20%-80% of height (inverted for SVG)
    points = []
    for i, v in enumerate(data_points):
        x = (i / (n - 1)) * w
        y_norm = (v - min_v) / rng  # 0..1
        y = h * 0.8 - y_norm * (h * 0.6)  # Map to 20%-80% height band
        points.append((x, y))

    # Build smooth Bézier path through all points (Catmull-Rom → cubic Bézier)
    def catmull_to_bezier(p0, p1, p2, p3, tension=0.5):
        """Convert 4 Catmull-Rom points to cubic Bézier control points for segment p1→p2."""
        cp1x = p1[0] + (p2[0] - p0[0]) / (6 * tension)
        cp1y = p1[1] + (p2[1] - p0[1]) / (6 * tension)
        cp2x = p2[0] - (p3[0] - p1[0]) / (6 * tension)
        cp2y = p2[1] - (p3[1] - p1[1]) / (6 * tension)
        return (cp1x, cp1y), (cp2x, cp2y)

    svg_paths = ""
    # Generate 3 layers at different offsets for depth
    for layer_idx, (opacity, y_offset, thickness) in enumerate([
        (0.08, 0, 3), (0.05, 60, 2), (0.03, -40, 1.5)
    ]):
        pts = [(px, py + y_offset) for px, py in points]
        # Pad start/end for Catmull-Rom
        padded = [pts[0]] + pts + [pts[-1]]
        d = f"M {padded[1][0]:.1f},{padded[1][1]:.1f} "
        for i in range(1, len(padded) - 2):
            cp1, cp2 = catmull_to_bezier(padded[i-1], padded[i], padded[i+1], padded[i+2])
            d += f"C {cp1[0]:.1f},{cp1[1]:.1f} {cp2[0]:.1f},{cp2[1]:.1f} {padded[i+1][0]:.1f},{padded[i+1][1]:.1f} "

        # Main stroke
        svg_paths += f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{thickness}" opacity="{opacity}" />\n'
        # Filled area below the curve
        fill_d = d + f"L {w},{h} L 0,{h} Z"
        svg_paths += f'<path d="{fill_d}" fill="{color}" opacity="{opacity * 0.4}" />\n'

    return f'<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">{svg_paths}</svg>'


def generate_supergraphic_svg(w, h, color="#8a8a8a", seed=42):
    """
    Supergraphic mode: oversized geometric shapes (circles, rectangles, polygons)
    cropped by the canvas edge, rendered at 3-5% opacity.
    Creates "blueprint of a larger world" feeling — McKinsey / Pentagram style.
    Shapes deliberately overflow the viewport so only partial arcs/edges are visible.
    """
    random.seed(seed)
    svg = _svg_open(w, h)
    # Layer 1: Giant concentric circles, center placed off-canvas
    cx = random.uniform(w * 0.6, w * 1.3)  # right-biased, partially off-canvas
    cy = random.uniform(-h * 0.2, h * 0.4)  # top-biased
    for i in range(4):
        r = w * (0.6 + i * 0.35)  # radii from 60% to 165% of width — always overflowing
        opacity = 0.04 - i * 0.008  # outer rings fainter
        svg += f'\n  <circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" '
        svg += f'fill="none" stroke="{color}" stroke-width="1.5" opacity="{max(opacity, 0.015):.3f}"/>'

    # Layer 2: Oversized rotated rectangles, clipped by viewport
    for _ in range(2):
        rx = random.uniform(-w * 0.3, w * 0.5)
        ry = random.uniform(h * 0.3, h * 1.2)
        rw = random.uniform(w * 0.8, w * 1.6)
        rh = random.uniform(h * 0.5, h * 1.2)
        angle = random.uniform(-15, 25)
        svg += f'\n  <rect x="{rx:.0f}" y="{ry:.0f}" width="{rw:.0f}" height="{rh:.0f}" '
        svg += f'fill="none" stroke="{color}" stroke-width="1" opacity="0.025" '
        svg += f'transform="rotate({angle:.1f} {rx + rw/2:.0f} {ry + rh/2:.0f})"/>'

    # Layer 3: A single massive polygon (pentagon/hexagon) barely visible
    sides = random.choice([5, 6, 8])
    pcx = random.uniform(-w * 0.1, w * 0.4)
    pcy = random.uniform(h * 0.5, h * 1.1)
    pr = w * random.uniform(0.9, 1.4)
    angle_offset = random.uniform(0, 360 / sides)
    points = []
    for i in range(sides):
        a = math.radians(angle_offset + i * 360 / sides)
        px = pcx + pr * math.cos(a)
        py = pcy + pr * math.sin(a)
        points.append(f"{px:.0f},{py:.0f}")
    svg += f'\n  <polygon points="{" ".join(points)}" '
    svg += f'fill="none" stroke="{color}" stroke-width="1" opacity="0.02"/>'

    svg += '\n</svg>'
    return svg


def generate_ordered_texture_svg(w, h, color="#8a8a8a", seed=42):
    """
    Ordered Texture mode: precision dot-matrix, coordinate grids, and contour lines
    placed in specific corners/edges of the canvas (not full coverage).
    Creates "engineered precision" feeling — ideal for tech, finance, data reports.
    """
    random.seed(seed)
    svg = _svg_open(w, h)

    # Region 1: Dot matrix in top-right corner (10x10 grid of small circles)
    dot_cols, dot_rows = 12, 10
    dot_spacing = 18
    dot_r = 2
    dot_origin_x = w - dot_cols * dot_spacing - 40  # right-aligned with margin
    dot_origin_y = 30  # top margin
    svg += '\n  <g opacity="0.08">'
    for row in range(dot_rows):
        for col in range(dot_cols):
            dx = dot_origin_x + col * dot_spacing
            dy = dot_origin_y + row * dot_spacing
            svg += f'\n    <circle cx="{dx}" cy="{dy}" r="{dot_r}" fill="{color}"/>'
    svg += '\n  </g>'

    # Region 2: Coordinate grid lines in bottom-left quadrant (blueprint style)
    grid_x0, grid_y0 = 20, h * 0.7
    grid_x1, grid_y1 = w * 0.45, h - 20
    grid_spacing = 30
    svg += f'\n  <g opacity="0.05" stroke="{color}" stroke-width="0.5" stroke-dasharray="4,6">'
    # Vertical lines
    x = grid_x0
    while x <= grid_x1:
        svg += f'\n    <line x1="{x:.0f}" y1="{grid_y0:.0f}" x2="{x:.0f}" y2="{grid_y1:.0f}"/>'
        x += grid_spacing
    # Horizontal lines
    y = grid_y0
    while y <= grid_y1:
        svg += f'\n    <line x1="{grid_x0:.0f}" y1="{y:.0f}" x2="{grid_x1:.0f}" y2="{y:.0f}"/>'
        y += grid_spacing
    svg += '\n  </g>'

    # Region 3: Tick marks along the grid (ruler effect)
    svg += f'\n  <g opacity="0.06" stroke="{color}" stroke-width="0.8">'
    x = grid_x0
    while x <= grid_x1:
        svg += f'\n    <line x1="{x:.0f}" y1="{grid_y1:.0f}" x2="{x:.0f}" y2="{grid_y1 + 5:.0f}"/>'
        x += grid_spacing
    svg += '\n  </g>'

    # Region 4: Flowing contour lines (Bézier) across mid-right area
    svg += f'\n  <g opacity="0.04" fill="none" stroke="{color}" stroke-width="1">'
    for i in range(5):
        y_base = h * 0.35 + i * 35
        x_start = w * 0.55
        x_end = w + 20  # overflow right edge
        cx1 = x_start + (x_end - x_start) * 0.3 + random.uniform(-30, 30)
        cy1 = y_base + random.uniform(-40, 40)
        cx2 = x_start + (x_end - x_start) * 0.7 + random.uniform(-30, 30)
        cy2 = y_base + random.uniform(-40, 40)
        svg += f'\n    <path d="M{x_start:.0f},{y_base:.0f} C{cx1:.0f},{cy1:.0f} {cx2:.0f},{cy2:.0f} {x_end:.0f},{y_base + random.uniform(-20, 20):.0f}"/>'
    svg += '\n  </g>'

    # Region 5: Cross-hair markers at 2-3 strategic points
    for _ in range(3):
        mx = random.uniform(w * 0.15, w * 0.85)
        my = random.uniform(h * 0.15, h * 0.85)
        size = 8
        svg += f'\n  <g opacity="0.06" stroke="{color}" stroke-width="0.8">'
        svg += f'\n    <line x1="{mx - size}" y1="{my}" x2="{mx + size}" y2="{my}"/>'
        svg += f'\n    <line x1="{mx}" y1="{my - size}" x2="{mx}" y2="{my + size}"/>'
        svg += f'\n    <circle cx="{mx}" cy="{my}" r="{size * 0.6:.0f}" fill="none"/>'
        svg += '\n  </g>'

    svg += '\n</svg>'
    return svg


def generate_generative_svg(svg_type="flow", w=720, h=960, color="#8a8a8a"):
    """Route to the appropriate SVG generator."""
    if svg_type == "flow":
        return generate_flow_svg(w, h, color)
    elif svg_type == "grid":
        return generate_grid_svg(w, h, color)
    elif svg_type == "noise":
        return generate_noise_svg(w, h)
    elif svg_type == "supergraphic":
        return generate_supergraphic_svg(w, h, color)
    elif svg_type == "ordered_texture":
        return generate_ordered_texture_svg(w, h, color)
    else:
        # Default: flow + noise layered
        flow = generate_flow_svg(w, h, color)
        return flow


def generate_continuous_flow_svg(w, h, total_pages, color="#8a8a8a", curves=4, stroke_width=80, opacity=0.05):
    """
    Continuous Flow mode: generates ONE large SVG spanning all pages.
    Returns a list of per-page SVG strings, each using viewBox to slice the master.

    The bezier curves are constrained to have anchor points every ~480px vertically,
    ensuring visible content on every page.
    """
    total_h = h * total_pages
    random.seed(42)

    # Build the master path data
    paths_data = []
    for _ in range(curves):
        # Generate anchor points — one every 480px ensures ~2 per page
        num_anchors = max(3, int(total_h / 480))
        anchors = []
        for i in range(num_anchors):
            ax = random.uniform(w * 0.1, w * 0.9)
            ay = (total_h / (num_anchors - 1)) * i
            anchors.append((ax, ay))

        # Build cubic bezier path through anchors
        path = f"M{anchors[0][0]:.0f},{anchors[0][1]:.0f}"
        for i in range(1, len(anchors)):
            prev = anchors[i - 1]
            curr = anchors[i]
            # Control points: spread horizontally for organic feel
            cx1 = random.uniform(w * 0.0, w * 1.0)
            cy1 = prev[1] + (curr[1] - prev[1]) * 0.33 + random.uniform(-100, 100)
            cx2 = random.uniform(w * 0.0, w * 1.0)
            cy2 = prev[1] + (curr[1] - prev[1]) * 0.66 + random.uniform(-100, 100)
            path += f" C{cx1:.0f},{cy1:.0f} {cx2:.0f},{cy2:.0f} {curr[0]:.0f},{curr[1]:.0f}"

        sw = stroke_width + random.uniform(-20, 30)
        paths_data.append((path, sw))

    # Generate per-page SVG slices
    page_svgs = []
    gradient_def = f'''<defs>
    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{color}" stop-opacity="{opacity}"/>
      <stop offset="50%" stop-color="{color}" stop-opacity="{opacity * 1.5:.3f}"/>
      <stop offset="100%" stop-color="{color}" stop-opacity="{opacity * 0.5:.3f}"/>
    </linearGradient>
  </defs>'''

    for page_idx in range(total_pages):
        vy = page_idx * h
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {vy} {w} {h}" width="{w}" height="{h}">'
        svg += f'\n  {gradient_def}'
        for i, (path, sw) in enumerate(paths_data):
            svg += f'\n  <path d="{path}" fill="none" stroke="url(#fg)" '
            svg += f'stroke-width="{sw:.0f}" stroke-linecap="round" opacity="{opacity + i * 0.01:.3f}"/>'
        svg += '\n</svg>'
        page_svgs.append(svg)

    return page_svgs


def generate_unified_svg(w, h, total_pages, svg_type, color="#8a8a8a", curves=4, stroke_width=80, opacity=0.05):
    """
    Generate a single SVG that spans the full continuous canvas (w x h*total_pages).
    Unlike generate_continuous_flow_svg which returns per-page slices,
    this returns ONE svg string for the entire document.
    Used by the continuous-canvas rendering mode.
    """
    total_h = h * total_pages
    random.seed(42)

    if svg_type in ("continuous_flow", "flow"):
        # Bezier curves spanning entire height
        paths_data = []
        for _ in range(curves):
            num_anchors = max(3, int(total_h / 480))
            anchors = []
            for i in range(num_anchors):
                ax = random.uniform(w * 0.1, w * 0.9)
                ay = (total_h / (num_anchors - 1)) * i
                anchors.append((ax, ay))
            path = f"M{anchors[0][0]:.0f},{anchors[0][1]:.0f}"
            for i in range(1, len(anchors)):
                prev = anchors[i - 1]
                curr = anchors[i]
                cx1 = random.uniform(w * 0.0, w * 1.0)
                cy1 = prev[1] + (curr[1] - prev[1]) * 0.33 + random.uniform(-100, 100)
                cx2 = random.uniform(w * 0.0, w * 1.0)
                cy2 = prev[1] + (curr[1] - prev[1]) * 0.66 + random.uniform(-100, 100)
                path += f" C{cx1:.0f},{cy1:.0f} {cx2:.0f},{cy2:.0f} {curr[0]:.0f},{curr[1]:.0f}"
            sw = stroke_width + random.uniform(-20, 30)
            paths_data.append((path, sw))

        gradient_def = f'''<defs>
    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{color}" stop-opacity="{opacity}"/>
      <stop offset="50%" stop-color="{color}" stop-opacity="{opacity * 1.5:.3f}"/>
      <stop offset="100%" stop-color="{color}" stop-opacity="{opacity * 0.5:.3f}"/>
    </linearGradient>
  </defs>'''

        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {total_h}" width="{w}" height="{total_h}">'
        svg += f'\n  {gradient_def}'
        for i, (path, sw) in enumerate(paths_data):
            svg += f'\n  <path d="{path}" fill="none" stroke="url(#fg)" '
            svg += f'stroke-width="{sw:.0f}" stroke-linecap="round" opacity="{opacity + i * 0.01:.3f}"/>'
        svg += '\n</svg>'
        return svg

    elif svg_type == "grid":
        # Grid pattern spanning full height
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {total_h}" width="{w}" height="{total_h}">'
        spacing = 60
        for x in range(0, w + 1, spacing):
            svg += f'\n  <line x1="{x}" y1="0" x2="{x}" y2="{total_h}" stroke="{color}" stroke-width="0.5" opacity="{opacity}"/>'
        for y in range(0, int(total_h) + 1, spacing):
            svg += f'\n  <line x1="0" y1="{y}" x2="{w}" y2="{y}" stroke="{color}" stroke-width="0.5" opacity="{opacity}"/>'
        svg += '\n</svg>'
        return svg

    elif svg_type == "noise":
        # Noise dots spanning full height
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {total_h}" width="{w}" height="{total_h}">'
        num_dots = int(200 * total_pages)
        for _ in range(num_dots):
            cx = random.uniform(0, w)
            cy = random.uniform(0, total_h)
            r = random.uniform(0.5, 2.5)
            svg += f'\n  <circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.1f}" fill="{color}" opacity="{random.uniform(opacity * 0.3, opacity * 1.5):.3f}"/>'
        svg += '\n</svg>'
        return svg

    return ""


# ═══════════════════════════════════════════════════════════════════════
# 3. LAYOUT CALCULATOR — Deliberate Spatial Tension
# ═══════════════════════════════════════════════════════════════════════
#
# Returns absolute coordinates for elements with intentional:
#   - Offset: elements not perfectly centered (art tension)
#   - Overlap: controlled z-index collisions
#   - Breathing margin: 15% minimum on all edges

BREATHING_MARGIN = 0.12  # 12% of canvas on each edge (was 15%, too tight for content-dense pages)

def calculate_layout(elements, w=720, h=960, style="offset"):
    """
    Calculate positioned layout for named elements.

    Args:
        elements: list of element names (e.g. ["hero", "body", "meta", "footer"])
        style: "offset" (deliberate asymmetry), "centered" (formal), "stacked" (vertical flow)

    Returns:
        dict mapping element names to {x, y, w, h, rotation} in pixels
    """
    # Safe area (15% breathing margin on all sides)
    safe_x = w * BREATHING_MARGIN
    safe_y = h * BREATHING_MARGIN
    safe_w = w * (1 - 2 * BREATHING_MARGIN)
    safe_h = h * (1 - 2 * BREATHING_MARGIN)

    layout = {}

    if style == "offset":
        # Asymmetric placement — elements shift left/right of center
        regions = _divide_vertical(safe_x, safe_y, safe_w, safe_h, len(elements))
        for i, name in enumerate(elements):
            rx, ry, rw, rh = regions[i]
            # Apply deliberate offset: odd elements shift left, even shift right
            offset_x = rw * 0.08 * (-1 if i % 2 == 0 else 1)
            layout[name] = {
                "x": round(rx + offset_x, 1),
                "y": round(ry, 1),
                "w": round(rw * 0.85, 1),  # Don't fill the full width
                "h": round(rh * 0.85, 1),
                "rotation": round(random.uniform(-1.5, 1.5), 2) if name != "body" else 0,
            }

    elif style == "centered":
        # Formal centered — golden ratio vertical split
        regions = _divide_vertical(safe_x, safe_y, safe_w, safe_h, len(elements))
        for i, name in enumerate(elements):
            rx, ry, rw, rh = regions[i]
            layout[name] = {
                "x": round(rx + (rw * 0.075), 1),  # Slight horizontal centering margin
                "y": round(ry, 1),
                "w": round(rw * 0.85, 1),
                "h": round(rh * 0.9, 1),
                "rotation": 0,
            }

    elif style == "overlap":
        # Controlled overlaps — elements bleed into each other's space
        regions = _divide_vertical(safe_x, safe_y, safe_w, safe_h, len(elements))
        for i, name in enumerate(elements):
            rx, ry, rw, rh = regions[i]
            overlap_y = rh * 0.15 if i > 0 else 0  # Pull up into previous region
            layout[name] = {
                "x": round(rx, 1),
                "y": round(ry - overlap_y, 1),
                "w": round(rw, 1),
                "h": round(rh + overlap_y * 0.5, 1),
                "rotation": 0,
                "z_index": len(elements) - i,  # Later elements on top
            }

    return layout

def _divide_vertical(x, y, w, h, n):
    """Divide a rectangle into n vertical bands with golden-ratio-inspired proportions."""
    if n <= 0:
        return []
    if n == 1:
        return [(x, y, w, h)]

    # Weighted distribution: first element (hero) gets more space
    weights = [1.618 if i == 0 else 1.0 for i in range(n)]
    total = sum(weights)

    regions = []
    current_y = y
    for i in range(n):
        region_h = h * weights[i] / total
        regions.append((x, current_y, w, region_h))
        current_y += region_h

    return regions


# ═══════════════════════════════════════════════════════════════════════
# VALIDATION — Post-generation color audit
# ═══════════════════════════════════════════════════════════════════════

def audit_palette(palette):
    """
    Strict audit: mode-specific S/L bounds + WCAG contrast checks.
    Returns list of violations (empty = clean).
    """
    violations = []
    mode = palette.get("meta", {}).get("mode", "minimal")

    for key in ["bg", "mid", "accent", "text"]:
        hex_val = palette.get(key, "")
        if not hex_val.startswith("#"):
            continue
        r, g, b = (int(hex_val[i:i+2], 16) / 255.0 for i in (1, 3, 5))
        h, l, s = colorsys.rgb_to_hls(r, g, b)

        # Tight bg/mid saturation limits per mode
        if key in ("bg", "mid"):
            limits = {"minimal": 0.20, "dark": 0.16, "pastel": 0.42, "jewel": 0.62, "light": 0.28}
            cap = limits.get(mode, 0.15)
            if s > cap:
                violations.append(f"{key}: S={s:.3f} > {cap} in {mode} mode")

        # Tight accent saturation — pastel/jewel reined in
        if key == "accent":
            accent_caps = {"minimal": 0.78, "dark": 0.62, "pastel": 0.52, "jewel": 0.52, "light": 0.48}
            cap = accent_caps.get(mode, 0.60)
            if s > cap:
                violations.append(f"accent: S={s:.3f} > {cap} in {mode} mode")

        # Lightness guardrails
        if key == "bg":
            if mode == "dark" and l > 0.10:
                violations.append(f"bg L={l:.3f} > 0.10 in dark (muddy middle)")
            elif mode == "minimal" and l < 0.90:
                violations.append(f"bg L={l:.3f} < 0.90 in minimal (too dark for paper)")
            elif mode == "light" and l < 0.88:
                violations.append(f"bg L={l:.3f} < 0.88 in light (too dark)")
            elif mode == "jewel" and l > 0.28:
                violations.append(f"bg L={l:.3f} > 0.28 in jewel (not deep enough)")
            elif mode == "pastel" and l < 0.83:
                violations.append(f"bg L={l:.3f} < 0.83 in pastel (too dark for Morandi)")

    # WCAG contrast checks
    bg_hex = palette.get("bg", "")
    text_hex = palette.get("text", "")
    accent_hex = palette.get("accent", "")
    if bg_hex.startswith("#") and text_hex.startswith("#"):
        cr = _contrast_ratio(text_hex, bg_hex)
        if cr < 4.5:
            violations.append(f"text:bg contrast {cr:.2f} < 4.5:1 (WCAG AA fail)")
    if bg_hex.startswith("#") and accent_hex.startswith("#"):
        cr = _contrast_ratio(accent_hex, bg_hex)
        if cr < 2.5:
            violations.append(f"accent:bg contrast {cr:.2f} < 2.5:1 (accent invisible)")

    return violations


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Design Engine — aesthetic computation for art-direction-first PDF",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s palette --intent serenity --mode dark
  %(prog)s palette --intent tension --mode light --seed 42
  %(prog)s palette-cascade --intent cold --mode minimal
  %(prog)s palette-cascade --intent neutral --format reportlab
  %(prog)s svg --intent flow --dimensions 720x960
  %(prog)s svg --intent grid --dimensions 720x960
  %(prog)s layout --elements hero,body,meta --dimensions 720x960 --style offset
  %(prog)s full --intent serenity --mode dark --dimensions 720x960 --output-dir ./assets/
  %(prog)s audit --css-file assets/palette.css
        """
    )
    sub = parser.add_subparsers(dest="command")

    # palette
    p_pal = sub.add_parser("palette", help="Generate HSL-locked color palette")
    p_pal.add_argument("--intent", default="neutral", choices=list(INTENT_HUES.keys()))
    p_pal.add_argument("--mode", default="minimal", choices=["minimal", "dark", "pastel", "jewel", "light"])
    p_pal.add_argument("--harmony", default="auto", choices=["auto", "complementary", "split_complementary", "triadic", "analogous", "monochrome"])
    p_pal.add_argument("--seed", type=int, default=None)
    p_pal.add_argument("--format", default="css", choices=["css", "json"])

    # svg
    p_svg = sub.add_parser("svg", help="Generate algorithmic SVG background")
    p_svg.add_argument("--svg-type", default="flow", choices=["flow", "grid", "noise", "supergraphic", "ordered_texture"])
    p_svg.add_argument("--dimensions", default="720x960")
    p_svg.add_argument("--color", default="#8a8a8a")

    # layout
    p_lay = sub.add_parser("layout", help="Calculate element positions")
    p_lay.add_argument("--elements", default="hero,body,meta")
    p_lay.add_argument("--dimensions", default="720x960")
    p_lay.add_argument("--style", default="offset", choices=["offset", "centered", "overlap"])

    # full
    p_full = sub.add_parser("full", help="Generate all assets at once")
    p_full.add_argument("--intent", default="neutral")
    p_full.add_argument("--mode", default="minimal", choices=["minimal", "dark", "pastel", "jewel", "light"])
    p_full.add_argument("--harmony", default="auto", choices=["auto", "complementary", "split_complementary", "triadic", "analogous", "monochrome"])
    p_full.add_argument("--svg-intent", default="flow", choices=["flow", "grid", "noise"])
    p_full.add_argument("--dimensions", default="720x960")
    p_full.add_argument("--elements", default="hero,body,meta")
    p_full.add_argument("--style", default="offset")
    p_full.add_argument("--seed", type=int, default=None)
    p_full.add_argument("--output-dir", default="./assets/")

    # audit
    p_audit = sub.add_parser("audit", help="Audit a palette for constraint violations")
    p_audit.add_argument("--palette-json", required=True)

    # palette-cascade
    p_pcas = sub.add_parser("palette-cascade", help="Generate role-based cascade palette (area ∝ 1/saturation)")
    p_pcas.add_argument("--intent", default="neutral", choices=list(INTENT_HUES.keys()))
    p_pcas.add_argument("--mode", default="minimal", choices=["minimal", "dark", "pastel", "jewel", "light"])
    p_pcas.add_argument("--harmony", default="auto", choices=["auto", "complementary", "split_complementary", "triadic", "analogous", "monochrome"])
    p_pcas.add_argument("--seed", type=int, default=None)
    p_pcas.add_argument("--format", default="summary", choices=["summary", "json", "css", "reportlab"])

    # compile
    p_compile = sub.add_parser("compile", help="Compile a JSON Blueprint into a final HTML document")
    p_compile.add_argument("--blueprint", required=True, help="Path to the JSON blueprint generated by LLM")
    p_compile.add_argument("--output", default="poster.html", help="Path to save the output HTML")

    # derive
    p_derive = sub.add_parser("derive", help="Auto-derive design intent from document description")
    p_derive.add_argument("text", help="Document title or description")

    # Backward compat: positional command
    parser.add_argument("legacy_command", nargs="?")
    parser.add_argument("legacy_args", nargs="*")

    args = parser.parse_args()

    if args.command == "palette":
        pal = generate_color_palette(args.intent, args.mode, harmony=args.harmony, seed=args.seed)
        if args.format == "json":
            print(json.dumps(pal, indent=2))
        else:
            print(palette_to_css(pal))

    elif args.command == "svg":
        w, h = map(int, args.dimensions.split("x"))
        print(generate_generative_svg(args.svg_type, w, h, args.color))

    elif args.command == "layout":
        w, h = map(int, args.dimensions.split("x"))
        elements = [e.strip() for e in args.elements.split(",")]
        result = calculate_layout(elements, w, h, args.style)
        print(json.dumps(result, indent=2))

    elif args.command == "full":
        w, h = map(int, args.dimensions.split("x"))
        os.makedirs(args.output_dir, exist_ok=True)

        # 1. Palette
        pal = generate_color_palette(args.intent, args.mode, harmony=getattr(args, 'harmony', 'split_complementary'), seed=args.seed)
        css = palette_to_css(pal)
        css_path = os.path.join(args.output_dir, "palette.css")
        with open(css_path, "w") as f:
            f.write(css)
        json_path = os.path.join(args.output_dir, "palette.json")
        with open(json_path, "w") as f:
            json.dump(pal, f, indent=2)
        print(f"✅ {css_path}")

        # 2. SVG
        svg_color = pal["accent"]  # Use accent for SVG strokes
        svg = generate_generative_svg(args.svg_intent, w, h, svg_color)
        svg_path = os.path.join(args.output_dir, "background.svg")
        with open(svg_path, "w") as f:
            f.write(svg)
        print(f"✅ {svg_path}")

        # 3. Layout
        elements = [e.strip() for e in args.elements.split(",")]
        lay = calculate_layout(elements, w, h, args.style)
        lay_path = os.path.join(args.output_dir, "layout.json")
        with open(lay_path, "w") as f:
            json.dump(lay, f, indent=2)
        print(f"✅ {lay_path}")

        # 4. Audit
        violations = audit_palette(pal)
        if violations:
            print("\n⚠️  Palette violations:")
            for v in violations:
                print(f"   - {v}")
        else:
            print("\n✅ Palette passes all constraints")

        print(f"\n🎨 {args.intent}/{args.mode} | {w}×{h} | {len(elements)} elements")

    elif args.command == "audit":
        with open(args.palette_json) as f:
            pal = json.load(f)
        violations = audit_palette(pal)
        if violations:
            print("⚠️  Violations found:")
            for v in violations:
                print(f"   - {v}")
            sys.exit(1)
        else:
            print("✅ Palette passes all constraints")

    elif args.command == "derive":
        intent = derive_intent(args.text)
        print(f"Intent: {intent}")
        print(f"Hue: {INTENT_HUES.get(intent, 45)}°")
        # Also generate a quick palette preview
        pal = generate_color_palette(intent, "dark")
        print(f"Preview (dark): bg={pal['bg']} accent={pal['accent']}")
        pal_light = generate_color_palette(intent, "light")
        print(f"Preview (light): bg={pal_light['bg']} accent={pal_light['accent']}")

    elif args.command == "palette-cascade":
        cascade = generate_cascade_palette(args.intent, args.mode, harmony=args.harmony, seed=args.seed)
        if args.format == "json":
            print(json.dumps(cascade, indent=2, ensure_ascii=False, default=str))
        elif args.format == "css":
            print(cascade["css"])
        elif args.format == "reportlab":
            print(cascade["reportlab"])
        else:  # summary
            meta = cascade["meta"]
            print(f"🎨 Cascade Palette | Intent: {meta['intent']} | Mode: {meta['mode']} | Harmony: {meta['harmony']}")
            print(f"   Base hue: {meta['base_hue']}° | Accent hue: {meta['accent_hue']}° | Secondary hue: {meta['secondary_hue']}°")
            print(f"   Contrast: text:bg={meta['contrast']['text_on_bg']} | accent:bg={meta['contrast']['accent_on_bg']}")
            print()
            print("   TIER   | ROLE              | HEX     | S      | USAGE")
            print("   ────── | ────────────────── | ─────── | ────── | ────────────")
            for name, info in cascade["roles"].items():
                tier = info['tier'].upper().ljust(6)
                nm = name.ljust(18)
                hx = info['hex'].ljust(7)
                s_val = f"{info['hsl'][1]:.3f}".ljust(6)
                print(f"   {tier} | {nm} | {hx} | {s_val} | {info['usage']}")
            print()
            print("   Semantic:")
            for name, info in cascade["semantic"].items():
                print(f"     {name}: {info['hex']} (S={info['hsl'][1]:.3f})")
            if meta["audit"]:
                print("\n   ⚠️ Violations:")
                for v in meta["audit"]:
                    print(f"     - {v}")
            else:
                print("\n   ✅ All tier constraints pass")

    elif args.command == "compile":
        try:
            out_path, pal = compile_blueprint(args.blueprint, args.output)
            print(f"✅ Blueprint compiled successfully to: {out_path}")
            violations = audit_palette(pal)
            if violations:
                print("⚠️ Warning: Generated palette had minor violations (auto-corrected by engine):")
                for v in violations: print(f"   - {v}")

        except Exception as e:
            print(f"❌ Failed to compile blueprint: {str(e)}")
            sys.exit(1)
    else:
        parser.print_help()


# ═══════════════════════════════════════════════════════════════════════
# 4. BLUEPRINT COMPILER — Converting JSON Intent to HTML Canvas
# ═══════════════════════════════════════════════════════════════════════
import re

# Base CSS that enforces the "Axioms" from visual_framework.md
BASE_CSS = """
@page {
  size: var(--canvas-w, 720px) var(--canvas-h, 960px);
  margin: 0;
}
:root {
  --font-sans: 'Inter', 'Noto Sans SC', 'Helvetica Neue', 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;
  --font-serif: 'Playfair Display', 'Noto Serif SC', 'Cormorant Garamond', 'Apple Color Emoji', serif;
  --font-mono: 'SF Mono', 'Consolas', 'Apple Color Emoji', monospace;

  /* Typographic Scale — 6-level fluid type system (Modular Scale) */
  --text-scale-6: clamp(64px, 12vw, 150px);   /* Hero / Display — oversized, single word or short phrase */
  --text-scale-5: clamp(48px, 8vw, 96px);      /* Primary Title — poster headline */
  --text-scale-4: clamp(32px, 5vw, 56px);      /* Subheadline — chapter opener or key quote */
  --text-scale-3: clamp(20px, 3vw, 32px);      /* Lead Paragraph — slightly larger than body */
  --text-scale-2: 16px;                         /* Body — standard body text */
  --text-scale-1: 12px;                         /* Meta / Caption — minimum readable size */
}
html, body {
  margin: 0; padding: 0;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
/* Browser preview: scale poster to fit viewport & center on matching background */
@media screen {
  html {
    height: auto;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    min-height: 100vh;
    background: var(--c-bg);
  }
  body {
    transform-origin: top center;
    margin: 0 auto;
    box-shadow: 0 0 60px rgba(0,0,0,0.3);
    /* scale injected by override_css with concrete canvas dimensions */
  }
}
.canvas {
  width: var(--canvas-w, 720px);
  min-height: var(--canvas-h, 960px);
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
  page-break-after: always;
}
/* ═══ Continuous Canvas Mode (multi-page as one seamless surface) ═══ */
.continuous-canvas {
  width: var(--canvas-w, 720px);
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
  /* height is set inline: canvas_h * total_pages */
}
.continuous-canvas .bg-layer-full {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
.continuous-canvas .bg-layer-full svg {
  width: 100%;
  height: 100%;
}
.continuous-canvas .page-section {
  position: absolute;
  left: 0;
  width: 100%;
  box-sizing: border-box;
  overflow: visible;
  /* top and height set inline per page */
}
.continuous-canvas .page-section .safe-zone {
  position: absolute;
  inset: 10% 12%;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: repeat(12, minmax(0, auto));
  align-content: start;
}
.continuous-canvas .page-section .page-ghost {
  position: absolute;
  bottom: -5%;
  right: 5%;
  font-size: 240px;
  font-weight: 900;
  color: var(--c-mid);
  opacity: 0.05;
  pointer-events: none;
  z-index: 0;
}
/* 12% Breathing Margin Enforcer (balanced: enough air without wasting space) */
.safe-zone {
  position: absolute;
  inset: 10% 12%;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: repeat(12, minmax(0, auto));
  align-content: start;
  /* gap is injected dynamically by compile_blueprint via inline style */
}
/* Grid-item wrapper — every component gets one */
.grid-item {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: visible;
}
/* Global content-overflow protection — prevents ANY text/block from breaking out of its container */
.grid-item * {
  max-width: 100%;
  box-sizing: border-box;
}
.grid-item p, .grid-item li, .grid-item span, .grid-item h1, .grid-item h2, .grid-item h3, .grid-item h4, .grid-item td, .grid-item th, .grid-item div {
  overflow-wrap: break-word;
  word-break: break-word;
}
/* CJK-safe text wrapping: prefer keeping CJK word groups intact, but allow break when necessary */
.hero-type, .hero-sub, .glass-canvas, .shaped-content, .stat-label, .delta-metric, .delta-label {
  text-wrap: balance;
  overflow-wrap: break-word;
  word-break: normal;
  line-break: strict;
}

/* ═══ Micro-Typography: Computational Typesetting ═══ */
p, .glass-canvas, .shaped-content, li {
  /* Algorithmic justification — eliminates white rivers between words */
  text-align: justify;
  hyphens: auto;
  word-spacing: -0.05em;
  /* Hanging punctuation — visually aligned optical edges */
  hanging-punctuation: first last;
  /* Kill orphans & widows — force min 3 lines carried across page breaks */
  orphans: 3;
  widows: 3;
}
.grid-item table {
  width: 100%;
  table-layout: fixed;
  overflow: hidden;
}
.grid-item img {
  max-width: 100%;
  height: auto;
}

/* --- Archetype Layouts --- */
/* All archetypes share the 12×12 grid via .safe-zone.
   Archetype classes may override alignment defaults on the canvas level. */
.archetype-cover_hero .safe-zone {
  align-content: start;
  inset: 12% 14%;
}
/* Cover hero typography scale: larger text for covers */
.archetype-cover_hero .hero-type {
  font-size: clamp(42px, 8vw, 72px);
  line-height: 1.15;
}
.archetype-cover_hero .hero-sub {
  font-size: clamp(22px, 4vw, 32px);
  line-height: 1.3;
  opacity: 0.85;
}
.archetype-cover_hero .floating-meta {
  font-size: clamp(16px, 2.5vw, 22px);
}
.archetype-split_vertical { display: grid; grid-template-columns: 1fr 1fr; min-height: 960px; }
.archetype-split_vertical .safe-zone { position: relative; inset: auto; padding: 10%; display: grid; grid-template-columns: repeat(12, 1fr); grid-template-rows: repeat(12, 1fr); align-content: center; }
.archetype-split_vertical.single-column { grid-template-columns: 1fr; }
.archetype-editorial_flow .safe-zone { align-content: center; }
.archetype-scattered_canvas .safe-zone { /* same 12×12 grid — scattered effect via grid_area placement */ }
.archetype-data_dashboard .safe-zone { /* same 12×12 grid — dashboard tiles via grid_area placement */ }
.archetype-shaped_editorial .safe-zone { align-content: center; }

/* Continuous canvas archetype overrides (page-section inherits archetype class) */
.continuous-canvas .page-section.archetype-cover_hero .safe-zone { align-content: start; inset: 12% 14%; }
.continuous-canvas .page-section.archetype-cover_hero .hero-type { font-size: clamp(42px, 8vw, 72px); line-height: 1.15; }
.continuous-canvas .page-section.archetype-cover_hero .hero-sub { font-size: clamp(22px, 4vw, 32px); line-height: 1.3; opacity: 0.85; }
.continuous-canvas .page-section.archetype-cover_hero .floating-meta { font-size: clamp(16px, 2.5vw, 22px); }
.continuous-canvas .page-section.archetype-editorial_flow .safe-zone { align-content: center; }
.continuous-canvas .page-section.archetype-shaped_editorial .safe-zone { align-content: center; inset: 5% 6%; }

/* --- Components --- */
.hero-type {
  font-size: clamp(48px, 10vw, 110px);
  line-height: 0.88;
  letter-spacing: -0.03em;
  margin: 0;
  overflow-wrap: break-word;
  word-break: break-word;
  position: relative;
  z-index: 10;
}
.hero-type.weight-black { font-weight: 900; }
.hero-type.weight-thin { font-weight: 100; letter-spacing: 0.05em; font-family: var(--font-serif); }
.hero-sub {
  margin: 8px 0 0 0;
  font-size: var(--text-scale-2);
  line-height: 1.3;
  opacity: 0.8;
}
/* Hero container needs vertical stacking */
.grid-item:has(.hero-type) {
  flex-direction: column;
  justify-content: center;
}
.hero-type, .hero-sub {
  width: 100%;
}
.hero-type {
  color: var(--c-text);
}

.glass-canvas {
  background: var(--c-surface);
  border: 1px solid rgba(128, 128, 128, 0.08);
  border-radius: 2px;
  padding: 36px;
  font-size: 16px;
  line-height: 1.6;
  z-index: 5;
  position: relative;
  overflow-wrap: break-word;
  word-break: break-word;
}

.floating-meta {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  color: var(--c-muted);
  opacity: 0.6;
  z-index: 20;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Positioned via grid_area in .grid-item wrapper — no absolute needed */
}
/* Legacy position helpers (kept for backwards compat with old blueprints) */
.pos-top-left { align-self: start; justify-self: start; }
.pos-top-right { align-self: start; justify-self: end; text-align: right; }
.pos-bottom-left { align-self: end; justify-self: start; }
.pos-bottom-right { align-self: end; justify-self: end; text-align: right; }

.stat-block { display: flex; flex-direction: column; margin-bottom: 24px; }
.stat-num { font-size: clamp(32px, 5vw, 56px); font-weight: 900; line-height: 0.9; color: var(--c-text); }
.stat-unit { font-size: clamp(14px, 2vw, 20px); font-weight: 300; color: var(--c-muted); margin-left: 4px; display: inline;}
.stat-label { font-size: 12px; letter-spacing: 0.15em; color: var(--c-accent); margin-top: 8px; text-transform: uppercase; }

.hairline { border: none; border-top: 0.5px solid var(--c-muted); opacity: 0.3; margin: 8px 0; width: 100%; }
.hairline.style-accent { border-top-color: var(--c-accent); width: 30%; margin-left: 0; opacity: 0.8;}

.page-ghost {
  position: absolute; bottom: -5%; right: 5%;
  font-size: 240px; font-weight: 900; color: var(--c-mid);
  opacity: 0.05; pointer-events: none; z-index: 0;
}

.bg-layer { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.bg-layer svg { width: 100%; height: 100%; }

/* --- Shaped_Canvas (Semantic Shape-Wrapping) --- */
.shaped-canvas {
  position: relative;
  padding: 24px;
  font-size: 16px;
  line-height: 1.7;
  z-index: 5;
  overflow-wrap: break-word;
  word-break: break-word;
}
.shape-float {
  float: left;
  margin: 0;
  padding: 0;
}
.shape-circle   { shape-outside: circle(45% at 50% 50%);   width: 40%; height: 90%; }
.shape-wave     { shape-outside: polygon(0 0, 80% 0, 60% 25%, 80% 50%, 60% 75%, 80% 100%, 0 100%); width: 45%; height: 100%; }
.shape-diagonal_slash { shape-outside: polygon(0 0, 100% 0, 0 100%); width: 50%; height: 100%; }
.shape-diamond  { shape-outside: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); width: 45%; height: 90%; }
.shape-wedge_right { shape-outside: polygon(0 0, 60% 0, 100% 50%, 60% 100%, 0 100%); width: 50%; height: 100%; }

/* --- Archetype: shaped_editorial --- */
.archetype-shaped_editorial .safe-zone {
  inset: 5% 6%;
  /* Inherits 12×12 grid from .safe-zone */
  align-content: center;
}

/* ═══ Tufte Marginalia System ═══ */
/* 30% sidenote rail for report/long-form archetypes */
.archetype-tufte_report .safe-zone {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 40px;
  align-content: start;
}
.archetype-tufte_report .main-column {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: repeat(12, 1fr);
  gap: inherit;
}
.archetype-tufte_report .side-rail {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-top: 8px;
}
.sidenote {
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-muted);
  border-left: 2px solid var(--c-accent);
  padding-left: 12px;
  opacity: 0.85;
}
.sidenote .sidenote-label {
  font-weight: 700;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-accent);
  display: block;
  margin-bottom: 4px;
}

/* ═══ Delta Widget — Data-to-Ink Ratio Component ═══ */
.delta-widget {
  text-align: center;
  padding: 16px 12px;
}
.delta-widget .delta-metric {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-muted);
  margin-bottom: 4px;
}
.delta-widget .delta-value {
  font-size: 36px;
  font-weight: 900;
  color: var(--c-text);
  line-height: 1.1;
}
.delta-widget .delta-change {
  font-size: 14px;
  font-weight: 700;
  margin-top: 4px;
}
.delta-widget .delta-label {
  font-size: 12px;
  color: var(--c-muted);
  margin-top: 8px;
}

/* ═══ Polymorphic Process_List — Container Query Adaptive ═══ */
.process-list-container {
  container-type: inline-size;
  width: 100%;
  min-height: 100%;
}
/* Wide: horizontal timeline */
.process-list {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0;
  min-height: 100%;
}
.process-list .process-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  position: relative;
  padding: 12px 4px;
}
.process-step .step-num {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--c-accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 14px; margin-bottom: 8px;
  flex-shrink: 0;
}
.process-step .step-title { font-weight: 700; font-size: 13px; color: var(--c-text); }
.process-step .step-desc { font-size: 12px; color: var(--c-muted); margin-top: 4px; line-height: 1.4; }
/* Connector line between horizontal steps */
.process-step:not(:last-child)::after {
  content: ''; position: absolute; top: 28px; right: -6px;
  width: 12px; height: 2px; background: var(--c-accent); opacity: 0.5;
}
/* Narrow: vertical numbered list */
@container (max-width: 360px) {
  .process-list {
    flex-direction: column;
    gap: 12px;
  }
  .process-list .process-step {
    flex-direction: row;
    text-align: left;
    align-items: flex-start;
    gap: 12px;
    padding: 4px 0;
  }
  .process-step .step-num { margin-bottom: 0; }
  .process-step:not(:last-child)::after { display: none; }
}
"""


def _prevent_orphan_chars(text):
    """
    Prevent orphan characters at end of paragraphs.
    Replace the last space/breakable point between the final two CJK chars
    (or words) with &nbsp; so the browser never wraps a single trailing char
    onto its own line.
    """
    # CJK orphan: bind last two CJK characters with a zero-width no-break joiner
    # Match: (CJK char)(optional space)(CJK char) at end of string (before tags)
    text = re.sub(r'([\u4e00-\u9fff\u3400-\u4dbf])[\s]+([\u4e00-\u9fff\u3400-\u4dbf])(?=\s*(?:<[^>]*>)*\s*$)', '\\g<1>\u2060\\g<2>', text)
    # Latin orphan: bind last two words
    text = re.sub(r'(\S+)\s+(\S+)\s*$', r'\1&nbsp;\2', text)
    return text


def simple_markdown_to_html(md_text):
    """Lightweight markdown → HTML for Glass Canvas. Handles paragraphs, headers, bold, italic, lists, and inline code."""
    if not md_text:
        return ""

    lines = md_text.split('\n')
    html_parts = []
    in_list = False
    paragraph_buffer = []

    def flush_paragraph():
        nonlocal paragraph_buffer
        if paragraph_buffer:
            text = ' '.join(paragraph_buffer)
            # Apply inline formatting
            text = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', text)
            text = re.sub(r'\*(.*?)\*', r'<em>\1</em>', text)
            text = re.sub(r'`(.*?)`', r'<code style="background:var(--c-surface);padding:2px 6px;border-radius:3px;font-size:max(12px, 0.9em)">\1</code>', text)
            # Anti-orphan: prevent single trailing character on last line
            text = _prevent_orphan_chars(text)
            html_parts.append(f'<p style="margin:0 0 12px 0;line-height:1.7">{text}</p>')
            paragraph_buffer = []

    def apply_inline(text):
        """Apply bold, italic, inline code."""
        text = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', text)
        text = re.sub(r'\*(.*?)\*', r'<em>\1</em>', text)
        text = re.sub(r'`(.*?)`', r'<code style="background:var(--c-surface);padding:2px 6px;border-radius:3px;font-size:max(12px, 0.9em)">\1</code>', text)
        return text

    for line in lines:
        stripped = line.strip()

        # Empty line — flush paragraph
        if not stripped:
            flush_paragraph()
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            continue

        # Headers
        if stripped.startswith('### '):
            flush_paragraph()
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append(f'<h3 style="font-size:16px;font-weight:700;margin:20px 0 8px 0;color:var(--c-accent);text-transform:uppercase;letter-spacing:0.05em;">{apply_inline(stripped[4:])}</h3>')
            continue
        if stripped.startswith('## '):
            flush_paragraph()
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append(f'<h2 style="font-size:20px;font-weight:700;margin:24px 0 12px 0;color:var(--c-text)">{apply_inline(stripped[3:])}</h2>')
            continue
        if stripped.startswith('# '):
            flush_paragraph()
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append(f'<h1 style="font-size:24px;font-weight:800;margin:28px 0 14px 0;color:var(--c-text)">{apply_inline(stripped[2:])}</h1>')
            continue

        # List items (- or *)
        list_match = re.match(r'^[-*]\s+(.*)', stripped)
        if list_match:
            flush_paragraph()
            if not in_list:
                html_parts.append('<ul style="margin:8px 0;padding-left:20px;list-style-type:disc">')
                in_list = True
            html_parts.append(f'<li style="margin:4px 0;line-height:1.6">{apply_inline(list_match.group(1))}</li>')
            continue

        # Numbered list items
        num_match = re.match(r'^(\d+)[.)]\s+(.*)', stripped)
        if num_match:
            flush_paragraph()
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append(f'<p style="margin:4px 0 4px 20px;line-height:1.6"><strong>{num_match.group(1)}.</strong> {apply_inline(num_match.group(2))}</p>')
            continue

        # Normal text — accumulate into paragraph
        paragraph_buffer.append(stripped)

    # Flush remaining
    flush_paragraph()
    if in_list:
        html_parts.append('</ul>')

    return '\n'.join(html_parts)


def _parse_grid_area(comp):
    """
    Parse grid_area from component JSON.
    Accepts two formats:
      - Array:  [row_start, col_start, row_end, col_end] — 1-based, max 13.
      - String: "row_start / col_start / row_end / col_end" — 1-based, max 13.
    Returns CSS grid-area string or None.
    """
    ga = comp.get("grid_area", None)
    if ga is None:
        return None
    # Array format: [1, 1, 3, 5]
    if isinstance(ga, list) and len(ga) == 4:
        rs, cs, re, ce = [max(1, min(13, int(v))) for v in ga]
        # Fix zero-height/zero-width grid areas (row_end must be > row_start)
        if re <= rs:
            re = min(13, rs + 1)
        if ce <= cs:
            ce = min(13, cs + 1)
        return f"{rs} / {cs} / {re} / {ce}"
    # String format: "1 / 1 / 3 / 5"
    if isinstance(ga, str) and "/" in ga:
        parts = [p.strip() for p in ga.split("/")]
        if len(parts) == 4:
            try:
                rs, cs, re, ce = [max(1, min(13, int(p))) for p in parts]
                # Fix zero-height/zero-width grid areas
                if re <= rs:
                    re = min(13, rs + 1)
                if ce <= cs:
                    ce = min(13, cs + 1)
                return f"{rs} / {cs} / {re} / {ce}"
            except ValueError:
                pass
    return None


def _parse_align(comp):
    """
    Parse align from component JSON.
    Format: "vertical / horizontal" where each is start|center|end.
    Returns (align-items, justify-content) tuple.
    """
    align = comp.get("align", "start / start")
    if "/" in str(align):
        parts = [p.strip() for p in str(align).split("/")]
        v = parts[0] if parts[0] in ("start", "center", "end") else "start"
        h = parts[1] if len(parts) > 1 and parts[1] in ("start", "center", "end") else "start"
    else:
        v, h = "start", "start"
    return v, h


def _estimate_content_weight(comp):
    """
    Estimate the visual weight (space needed) of a component based on its content.
    Returns a numeric weight proportional to how many grid rows it should occupy.

    Text-heavy components (Glass_Canvas, Shaped_Canvas) get weight proportional to
    character count. Fixed-height components (Stat_Block, Hero_Typography, etc.) get
    a small fixed weight since they don't grow with content.
    """
    ctype = comp.get("type", "")

    # Fixed-height components: their visual size is independent of text length
    FIXED_WEIGHTS = {
        "Hero_Typography": 2.5,
        "Stat_Block": 2.0,
        "Delta_Widget": 2.0,
        "Hairline_Divider": 1.0,
        "Floating_Meta": 1.0,  # usually positioned in corners, but fallback
        "Image_Asset": 3.0,
    }
    if ctype in FIXED_WEIGHTS:
        return FIXED_WEIGHTS[ctype]

    # Text-heavy components: weight scales with content length
    text = comp.get("markdown_content", "") or comp.get("body", "") or ""

    # Also count sub-items (Process_List steps)
    for step in comp.get("steps", []):
        text += step.get("title", "") + step.get("description", "")

    char_count = len(text)

    if ctype in ("Glass_Canvas", "Shaped_Canvas", "Process_List"):
        # Rough estimate: ~40 CJK chars per line at 16px in a ~500px wide container,
        # ~1.6 line-height, so each 40 chars ≈ 1 visual line ≈ ~25px.
        # Grid row on a 960px canvas ≈ 80px each (960/12).
        # So 40 chars ≈ 0.3 grid rows. But Glass_Canvas has padding (~72px total),
        # headings, list spacing, etc. Add base weight for the container itself.
        base = 2.0  # minimum for padding + heading
        text_rows = char_count / 120.0  # ~120 chars per grid-row worth of space
        return base + text_rows

    # Unknown component type: estimate from text length with a reasonable default
    if char_count > 0:
        return 2.0 + char_count / 120.0
    return 2.0


def _assign_floating_meta(comp):
    """Assign grid_area to a Floating_Meta component based on its position."""
    pos = comp.get("position", "top-right")
    if "top" in pos and "left" in pos:
        comp["grid_area"] = "1 / 1 / 2 / 7"
    elif "top" in pos:
        comp["grid_area"] = "1 / 7 / 2 / 13"
    elif "bottom" in pos and "left" in pos:
        comp["grid_area"] = "12 / 1 / 13 / 7"
    else:
        comp["grid_area"] = "12 / 7 / 13 / 13"


def _distribute_rows_by_weight(content_comps, start_row=1, end_row=13, full_width=True):
    """
    Distribute grid rows among content components proportionally to their content weight.
    Each component gets at least 2 rows. Components fill start_row to end_row seamlessly.
    """
    nn = len(content_comps)
    if nn == 0:
        return

    total_rows = end_row - start_row  # available rows

    # Calculate weights
    weights = [_estimate_content_weight(c) for c in content_comps]
    total_weight = sum(weights)

    if total_weight == 0:
        total_weight = nn  # fallback: equal distribution
        weights = [1.0] * nn

    # Allocate rows proportionally, with minimum 2 per component
    MIN_ROWS = 2
    raw_rows = [(w / total_weight) * total_rows for w in weights]

    # Ensure minimum, then redistribute excess
    allocated = []
    for r in raw_rows:
        allocated.append(max(MIN_ROWS, round(r)))

    # Adjust total to exactly fill the available rows
    # First pass: if total exceeds available, shrink the largest allocations
    while sum(allocated) > total_rows and any(a > MIN_ROWS for a in allocated):
        max_idx = max(range(nn), key=lambda i: allocated[i])
        allocated[max_idx] -= 1

    # Second pass: if total is less than available, grow the heaviest components
    while sum(allocated) < total_rows:
        max_weight_idx = max(range(nn), key=lambda i: weights[i])
        allocated[max_weight_idx] += 1

    # Assign grid_area
    col_start = 1
    col_end = 13 if full_width else 7  # can be overridden by caller
    current_row = start_row
    for j, comp in enumerate(content_comps):
        rs = current_row
        re = min(end_row, current_row + allocated[j])
        comp["grid_area"] = f"{rs} / {col_start} / {re} / {col_end}"
        current_row = re


def _auto_assign_grid_areas(archetype, components):
    """
    Auto-assign grid_area to components that don't have one,
    based on the archetype and number of components.
    Mutates components in-place.
    Skips Page_Ghost_Number (uses absolute positioning, not grid).

    Uses content-aware row distribution: text-heavy components (Glass_Canvas)
    get more rows than fixed-height components (Stat_Block, Hero_Typography).
    """
    # Filter out ghost numbers — they use absolute positioning, not grid
    gridded = [c for c in components if c.get("type") != "Page_Ghost_Number"]

    # Only process components without grid_area
    needs_area = [c for c in gridded if not c.get("grid_area")]
    if not needs_area:
        return  # All components already have grid_area

    n = len(gridded)

    if archetype == "cover_hero":
        # Cover: stack vertically, full width, spread across page
        # Typical: 2-4 components (Hero + Floating_Meta + optional divider/ghost)
        if n <= 2:
            slots = ["1 / 1 / 7 / 13", "9 / 1 / 13 / 13"]
        elif n == 3:
            slots = ["1 / 1 / 5 / 13", "5 / 1 / 9 / 13", "10 / 1 / 13 / 13"]
        else:
            slots = ["1 / 1 / 4 / 13", "4 / 1 / 7 / 13", "8 / 1 / 10 / 13", "10 / 1 / 13 / 13"]
        for i, comp in enumerate(gridded):
            if not comp.get("grid_area") and i < len(slots):
                comp["grid_area"] = slots[i]

    elif archetype == "data_dashboard":
        # Dashboard: tile components in a 2-column or 3-column grid
        has_area = [c for c in gridded if c.get("grid_area")]
        no_area = [c for c in gridded if not c.get("grid_area")]
        nn = len(no_area)
        if nn <= 2:
            slots = ["1 / 1 / 7 / 7", "1 / 7 / 7 / 13"]
        elif nn <= 4:
            slots = ["1 / 1 / 7 / 7", "1 / 7 / 7 / 13",
                     "7 / 1 / 13 / 7", "7 / 7 / 13 / 13"]
        elif nn <= 6:
            slots = ["1 / 1 / 5 / 7", "1 / 7 / 5 / 13",
                     "5 / 1 / 9 / 7", "5 / 7 / 9 / 13",
                     "9 / 1 / 13 / 7", "9 / 7 / 13 / 13"]
        elif nn <= 9:
            slots = ["1 / 1 / 5 / 5", "1 / 5 / 5 / 9", "1 / 9 / 5 / 13",
                     "5 / 1 / 9 / 5", "5 / 5 / 9 / 9", "5 / 9 / 9 / 13",
                     "9 / 1 / 13 / 5", "9 / 5 / 13 / 9", "9 / 9 / 13 / 13"]
        else:
            # Too many: 3-col grid, auto-expand rows
            slots = []
            cols = 3
            row_h = max(2, 12 // ((nn + cols - 1) // cols))
            for idx in range(nn):
                r = idx // cols
                c = idx % cols
                rs = 1 + r * row_h
                re = min(13, rs + row_h)
                cs = 1 + c * 4
                ce = min(13, cs + 4)
                slots.append(f"{rs} / {cs} / {re} / {ce}")
        j = 0
        for comp in no_area:
            if j < len(slots):
                comp["grid_area"] = slots[j]
                j += 1

    elif archetype == "editorial_flow":
        # Editorial: stack vertically, full width
        # Handle Floating_Meta separately — assign to corners based on position
        # Content components get rows proportional to their content weight
        no_area = [c for c in gridded if not c.get("grid_area")]
        content_comps = []
        for comp in no_area:
            if comp.get("type") == "Floating_Meta":
                _assign_floating_meta(comp)
            else:
                content_comps.append(comp)
        if content_comps:
            _distribute_rows_by_weight(content_comps, start_row=1, end_row=13, full_width=True)

    elif archetype == "split_vertical":
        # Split: first half on left, second half on right
        # Each side gets content-proportional row distribution
        no_area = [c for c in gridded if not c.get("grid_area")]
        nn = len(no_area)
        mid = (nn + 1) // 2
        left = no_area[:mid]
        right = no_area[mid:]
        # Left column: cols 1-7
        if left:
            weights_l = [_estimate_content_weight(c) for c in left]
            total_w = sum(weights_l) or 1
            current = 1
            for j, comp in enumerate(left):
                rows = max(2, round((weights_l[j] / total_w) * 12))
                rs = current
                re = min(13, current + rows)
                comp["grid_area"] = f"{rs} / 1 / {re} / 7"
                current = re
        # Right column: cols 7-13
        if right:
            weights_r = [_estimate_content_weight(c) for c in right]
            total_w = sum(weights_r) or 1
            current = 1
            for j, comp in enumerate(right):
                rows = max(2, round((weights_r[j] / total_w) * 12))
                rs = current
                re = min(13, current + rows)
                comp["grid_area"] = f"{rs} / 7 / {re} / 13"
                current = re

    elif archetype == "scattered_canvas":
        # Scatter: distribute pseudo-randomly across the grid
        no_area = [c for c in gridded if not c.get("grid_area")]
        scatter_slots = [
            "1 / 1 / 5 / 6", "1 / 7 / 4 / 13", "5 / 3 / 9 / 10",
            "6 / 1 / 10 / 5", "7 / 8 / 11 / 13", "10 / 2 / 13 / 8",
            "10 / 8 / 13 / 13", "3 / 1 / 6 / 5", "1 / 4 / 4 / 10",
        ]
        for j, comp in enumerate(no_area):
            if j < len(scatter_slots):
                comp["grid_area"] = scatter_slots[j]

    elif archetype == "shaped_editorial":
        # Shaped: main shaped canvas gets most of the page
        no_area = [c for c in gridded if not c.get("grid_area")]
        for j, comp in enumerate(no_area):
            if comp.get("type") == "Shaped_Canvas":
                comp["grid_area"] = "2 / 2 / 12 / 12"
            elif comp.get("type") == "Floating_Meta":
                _assign_floating_meta(comp)
            else:
                comp["grid_area"] = f"{1 + j * 3} / 1 / {min(13, 4 + j * 3)} / 13"

    # Fallback: if still no grid_area, make full-width stacked rows
    # Uses content-aware distribution instead of equal division
    remaining = [c for c in gridded if not c.get("grid_area")]
    if remaining:
        # First, handle Floating_Meta components by position
        non_meta = []
        for comp in remaining:
            if comp.get("type") == "Floating_Meta":
                _assign_floating_meta(comp)
            else:
                non_meta.append(comp)
        # Then distribute rows proportionally to content weight
        if non_meta:
            _distribute_rows_by_weight(non_meta, start_row=1, end_row=13, full_width=True)


def _wrap_grid_item(comp, inner_html):
    """Wrap a rendered component in a .grid-item div with grid positioning."""
    grid_area_css = _parse_grid_area(comp)
    v_align, h_align = _parse_align(comp)

    # Glass_Canvas and Process_List should stretch to fill their grid area
    ctype = comp.get("type", "")
    if ctype in ("Glass_Canvas", "Process_List"):
        v_align = "stretch"

    style_parts = []
    if grid_area_css:
        style_parts.append(f"grid-area: {grid_area_css}")
    style_parts.append(f"align-items: {v_align}")
    style_parts.append(f"justify-content: {h_align}")

    style = "; ".join(style_parts) + ";"
    return f'<div class="grid-item" style="{style}">\n{inner_html}</div>\n'


def render_component(comp):
    """Convert a JSON component object into HTML string, wrapped in grid-item."""
    # Flatten nested "content" and "style" dicts into top-level for compat
    # e.g. {"content": {"heading": "Hi"}} → {"heading": "Hi"}
    _content = comp.get("content", None)
    if isinstance(_content, dict):
        for k, v in _content.items():
            if k not in comp:
                comp[k] = v
    _style = comp.get("style", None)
    if isinstance(_style, dict):
        for k, v in _style.items():
            if k not in comp:
                comp[k] = v

    ctype = comp.get("type", "")
    inner = ""

    if ctype == "Hero_Typography":
        weight = comp.get("weight", "black")
        heading = comp.get("heading", "")
        subheading = comp.get("subheading", "")
        # Fallback: if "content" is a plain string, use it as heading
        raw_content = comp.get("content", "")
        if not heading and isinstance(raw_content, str) and raw_content:
            heading = raw_content
        # Sanitize consecutive <br> — collapse 3+ into max 2
        heading = re.sub(r'(<br\s*/?>){3,}', '<br><br>', heading)
        if subheading:
            subheading = re.sub(r'(<br\s*/?>){3,}', '<br><br>', subheading)
        scale = comp.get("scale", None)
        # Build inline style from both scale and custom style props
        style_parts = []
        if scale is not None and 1 <= int(scale) <= 6:
            style_parts.append(f"font-size: var(--text-scale-{int(scale)})")
        heading_font_size = comp.get("heading_font_size", "")
        heading_color = comp.get("heading_color", "")
        heading_ls = comp.get("heading_letter_spacing", "")
        text_align = comp.get("text_align", "")
        if heading_font_size:
            style_parts.append(f"font-size: {heading_font_size}")
        if heading_color:
            style_parts.append(f"color: {heading_color}")
        if heading_ls:
            style_parts.append(f"letter-spacing: {heading_ls}")
        if text_align:
            style_parts.append(f"text-align: {text_align}")
        h_style = f' style="{"; ".join(style_parts)}"' if style_parts else ""
        inner = f'<h1 class="hero-type weight-{weight}"{h_style}>{heading}</h1>\n'
        if subheading:
            sub_style_parts = []
            sub_fs = comp.get("subheading_font_size", "")
            sub_color = comp.get("subheading_color", "")
            sub_ls = comp.get("subheading_letter_spacing", "")
            if sub_fs:
                sub_style_parts.append(f"font-size: {sub_fs}")
            if sub_color:
                sub_style_parts.append(f"color: {sub_color}")
            if sub_ls:
                sub_style_parts.append(f"letter-spacing: {sub_ls}")
            if text_align:
                sub_style_parts.append(f"text-align: {text_align}")
            s_style = f' style="{"; ".join(sub_style_parts)}"' if sub_style_parts else ""
            inner += f'<p class="hero-sub"{s_style}>{subheading}</p>\n'

    elif ctype == "Glass_Canvas":
        md = comp.get("markdown_content", "") or comp.get("body", "")
        html_content = simple_markdown_to_html(md)
        # Build inline style from custom style props
        gs_parts = ["width:100%", "min-height:100%", "box-sizing:border-box"]

        # --- Auto font-size scaling for Glass_Canvas ---
        # When content is too long for the allocated grid rows, shrink font-size
        # to avoid overflow into adjacent components.
        # Estimation: ~80 chars per row at 16px base font-size (with padding).
        user_font_size = comp.get("font_size", "")
        if not user_font_size:  # Only auto-scale when user hasn't set a custom size
            grid_area_str = comp.get("grid_area", "")
            if grid_area_str:
                try:
                    ga_parts = [int(x.strip()) for x in grid_area_str.split("/")]
                    allocated_rows = ga_parts[2] - ga_parts[0]  # row_end - row_start
                    content_len = len(md)
                    chars_per_row = 80  # approximate chars that fit in one grid row at 16px
                    needed_rows = max(1, content_len / chars_per_row)
                    if needed_rows > allocated_rows:
                        # Scale down proportionally, but never below 12px
                        scale = allocated_rows / needed_rows
                        new_size = max(12, int(16 * scale))
                        if new_size < 16:
                            gs_parts.append(f"font-size: {new_size}px")
                except (ValueError, IndexError):
                    pass

        for prop in ["background", "border", "border_radius", "padding", "font_size", "color", "line_height", "text_align"]:
            val = comp.get(prop, "")
            if val:
                css_prop = prop.replace("_", "-")
                gs_parts.append(f"{css_prop}: {val}")
        grid_style = "; ".join(gs_parts) + ";"
        tension = comp.get("tension_score", None)
        if tension is not None:
            weight = int(300 + (float(tension) * 600))
            inner = f'<div class="glass-canvas" style="{grid_style}font-variation-settings: \'wght\' {weight};">{html_content}</div>\n'
        else:
            inner = f'<div class="glass-canvas" style="{grid_style}">{html_content}</div>\n'

    elif ctype == "Floating_Meta":
        pos = comp.get("position", "top-left")
        items_html = "".join([f"<span>{item}</span>" for item in comp.get("items", [])])
        fm_style_parts = []
        for prop in ["font_size", "color", "letter_spacing", "text_align"]:
            val = comp.get(prop, "")
            if val:
                fm_style_parts.append(f"{prop.replace('_', '-')}: {val}")
        fm_style = f' style="{"; ".join(fm_style_parts)}"' if fm_style_parts else ""
        inner = f'<div class="floating-meta pos-{pos}"{fm_style}>{items_html}</div>\n'

    elif ctype == "Stat_Block":
        inner = f'''<div class="stat-block">
            <div><span class="stat-num">{comp.get("number", "")}</span><span class="stat-unit">{comp.get("unit", "")}</span></div>
            <span class="stat-label">{comp.get("label", "")}</span>
        </div>\n'''

    elif ctype == "Hairline_Divider":
        style = comp.get("style", "bleed")
        inner = f'<hr class="hairline style-{style}">\n'

    elif ctype == "Page_Ghost_Number":
        # Ghost numbers are decorative overlays — still use absolute positioning
        return f'<div class="page-ghost">{comp.get("number", "")}</div>\n'

    elif ctype == "Shaped_Canvas":
        shape = comp.get("shape_keyword", "circle")
        md = comp.get("markdown_content", "") or comp.get("body", "")
        html_content = simple_markdown_to_html(md)
        sc_style_parts = []
        for prop in ["background", "border", "border_radius", "padding"]:
            val = comp.get(prop, "")
            if val:
                sc_style_parts.append(f"{prop.replace('_', '-')}: {val}")
        sc_style = f' style="{"; ".join(sc_style_parts)}"' if sc_style_parts else ""
        inner = f'''<div class="shaped-canvas"{sc_style}>
  <div class="shape-float shape-{shape}" aria-hidden="true"></div>
  <div class="shaped-content">{html_content}</div>
</div>\n'''

    elif ctype == "Image_Asset":
        src = comp.get("src", "")
        alt = comp.get("alt", "")
        fit = comp.get("object_fit", "cover")
        inner = f'<img src="{src}" alt="{alt}" style="width:100%;height:100%;object-fit:{fit};border-radius:2px;" />\n'

    elif ctype == "Sidenote_Block":
        label = comp.get("label", "")
        body = comp.get("body", "") or comp.get("markdown_content", "")
        html_body = simple_markdown_to_html(body)
        label_html = f'<span class="sidenote-label">{label}</span>' if label else ""
        inner = f'<div class="sidenote">{label_html}{html_body}</div>\n'
        # Sidenotes bypass grid-item wrapping for Tufte layout — returned raw
        return inner

    elif ctype == "Delta_Widget":
        metric = comp.get("metric", "")
        value = comp.get("value", "")
        delta = comp.get("delta", "")
        trend = comp.get("trend", "up")  # up / down / flat
        label = comp.get("label", "")
        trend_symbol = {"up": "▲", "down": "▼", "flat": "─"}.get(trend, "")
        trend_color = {"up": "#22c55e", "down": "#ef4444", "flat": "var(--c-muted)"}.get(trend, "var(--c-muted)")
        inner = f'''<div class="delta-widget">
  <div class="delta-metric">{metric}</div>
  <div class="delta-value">{value}</div>
  <div class="delta-change" style="color:{trend_color}"><span>{trend_symbol}</span> {delta}</div>
  <div class="delta-label">{label}</div>
</div>\n'''

    elif ctype == "Process_List":
        steps = comp.get("steps", [])
        steps_html = ""
        for i, step in enumerate(steps):
            title = step.get("title", "")
            desc = step.get("description", "")
            steps_html += f'<li class="process-step"><span class="step-num">{i+1}</span><div><div class="step-title">{title}</div><div class="step-desc">{desc}</div></div></li>\n'
        inner = f'<div class="process-list-container"><ul class="process-list">{steps_html}</ul></div>\n'

    else:
        return f"<!-- Unknown component: {ctype} -->\n"

    return _wrap_grid_item(comp, inner)


def compile_blueprint(json_path, output_html_path):
    """Reads the LLM JSON blueprint and generates the final poster.html"""
    with open(json_path, encoding='utf-8') as f:
        blueprint = json.load(f)

    art = blueprint.get("art_direction", {})
    # Intent: auto-derive from document title if not explicitly provided
    doc_title = blueprint.get("document_meta", {}).get("title", "")
    intent = art.get("intent", None)
    if not intent:
        intent = derive_intent(doc_title) if doc_title else "neutral"
    intent = intent.lower()
    mode = art.get("palette_mode", "minimal").lower()
    harmony = art.get("color_harmony", "auto").lower()  # "auto" → intent-based recommendation
    svg_type = art.get("background_svg", "flow")
    pages = blueprint.get("pages", [])
    total_pages = len(pages)

    # 1. Compute Aesthetics — three pillars: intent + mode + harmony
    palette = generate_color_palette(intent, mode, harmony=harmony)
    css_vars = palette_to_css(palette)

    # Detect if any component uses tension_score → switch to Variable Font URL
    has_tension = False
    for page in pages:
        for comp in page.get("components", []):
            if comp.get("tension_score") is not None:
                has_tension = True
                break
        if has_tension:
            break

    # Generate SVG backgrounds
    canvas_w = art.get("canvas_width", 720)
    canvas_h = art.get("canvas_height", 960)
    use_continuous = total_pages > 1  # Multi-page → continuous canvas mode
    continuous_svgs = None
    unified_svg = ""
    bg_svg = ""
    if use_continuous and svg_type != "none":
        # Generate one unified SVG spanning the entire document
        unified_svg = generate_unified_svg(canvas_w, canvas_h, total_pages, svg_type, palette['accent'])
    elif not use_continuous:
        if svg_type == "continuous_flow" and total_pages > 1:
            continuous_svgs = generate_continuous_flow_svg(canvas_w, canvas_h, total_pages, palette['accent'])
        elif svg_type != "none":
            bg_svg = generate_generative_svg(svg_type, canvas_w, canvas_h, palette['accent'])

    # Font URL: use variable axis range if tension is active
    if has_tension:
        font_url = "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=Noto+Sans+SC:wght@300;400;500;700;900&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&display=swap"
    else:
        font_url = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;900&family=Noto+Sans+SC:wght@300;400;500;700;900&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&display=swap"

    # 1b. Dynamic Gap — intent-driven grid density
    # If the LLM explicitly sets grid_gap in art_direction, use that (override).
    # Otherwise, derive from intent.
    explicit_gap = art.get("grid_gap", None)
    if explicit_gap is not None:
        dynamic_gap = str(explicit_gap) if "px" in str(explicit_gap) else f"{explicit_gap}px"
    else:
        gap_mapping = {
            "serenity": "48px",
            "elegance": "32px",
            "minimalism": "40px",
            "warmth": "24px",
            "neutral": "16px",
            "tension": "8px",
            "energy": "4px",
        }
        dynamic_gap = gap_mapping.get(intent, "16px")

    # 2. Build override CSS for custom canvas size, background, bleed
    override_css = ""
    override_css += f":root {{ --canvas-w: {canvas_w}px; --canvas-h: {canvas_h}px; }}\n"
    # @page size MUST use concrete values (CSS variables are NOT resolved in @page rules)
    override_css += f"@page {{ size: {canvas_w}px {canvas_h}px; margin: 0; }}\n"
    # html/body must match canvas size for full-bleed PDF output
    # Use min-height (not height) so content taller than canvas_h expands naturally
    override_css += f"html, body {{ width: {canvas_w}px; min-height: {canvas_h}px; }}\n"
    bg_color = art.get("background_color", "")
    if bg_color:
        override_css += f".canvas {{ background: {bg_color}; }}\n"
        override_css += f".continuous-canvas {{ background: {bg_color}; }}\n"
    if art.get("bleed", False):
        override_css += ".safe-zone { inset: 0 !important; padding: 0 !important; }\n"

    # Screen preview: inject concrete scale value (CSS calc with var may not work in scale)
    override_css += f"@media screen {{ body {{ scale: min(1, calc(100vw / {canvas_w}), calc(100vh / {canvas_h})); }} }}\n"

    # 3. Build HTML Document
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link href="{font_url}" rel="stylesheet">
    <title>{blueprint.get("document_meta", {}).get("title", "Document")}</title>
    <style>
        {css_vars}
        {BASE_CSS}
        {override_css}
    </style>
</head>
<body>
"""

    # 3. Render Pages
    if use_continuous:
        # ═══ CONTINUOUS CANVAS MODE ═══
        # Render all pages as one seamless surface, then let Playwright's page.pdf() slice it.
        total_height = canvas_h * total_pages
        html += f'\n<div class="continuous-canvas" style="height: {total_height}px; background: var(--c-bg);">\n'

        # Unified background SVG spanning the entire document
        if unified_svg:
            html += f'  <div class="bg-layer-full">{unified_svg}</div>\n'

        # Render each page as an absolutely-positioned section within the continuous canvas
        for page_idx, page in enumerate(pages):
            archetype = page.get("archetype", "cover_hero")
            page_top = page_idx * canvas_h

            # Auto-assign grid areas
            _auto_assign_grid_areas(archetype, page.get("components", []))

            # Cognitive Load Margins
            total_chars = 0
            sidenotes = []
            main_components = []
            for comp in page.get("components", []):
                text_content = comp.get("markdown_content", "") or comp.get("body", "") or ""
                total_chars += len(text_content)
                if comp.get("type") == "Sidenote_Block":
                    sidenotes.append(comp)
                else:
                    main_components.append(comp)
                    for step in comp.get("steps", []):
                        total_chars += len(step.get("title", "")) + len(step.get("description", ""))

            if total_chars > 500:
                safe_inset = "8% 10%"
            elif total_chars > 200:
                safe_inset = "10% 12%"
            else:
                safe_inset = ""
            safe_inset_style = f" inset: {safe_inset};" if safe_inset else ""

            # Page section: positioned absolutely within continuous canvas
            html += f'\n  <div class="page-section archetype-{archetype}" style="top: {page_top}px; height: {canvas_h}px;">\n'

            # Per-page data-driven SVG background (overlays on top of unified bg)
            if svg_type != "none":
                data_points = None
                for comp in page.get("components", []):
                    dp = comp.get("data_points")
                    if dp and isinstance(dp, list) and all(isinstance(x, (int, float)) for x in dp):
                        data_points = dp
                        break
                if data_points and len(data_points) >= 2:
                    page_svg = _generate_data_driven_svg(data_points, canvas_w, canvas_h, palette['accent'])
                    html += f'    <div class="bg-layer" style="position:absolute;inset:0;z-index:2;pointer-events:none;">{page_svg}</div>\n'

            # Tufte layout
            if archetype == "tufte_report" and sidenotes:
                html += f'    <div class="safe-zone" style="gap: {dynamic_gap};{safe_inset_style}">\n'
                html += f'      <div class="main-column" style="gap: {dynamic_gap};">\n'
                for comp in main_components:
                    html += "        " + render_component(comp)
                html += '      </div>\n'
                html += '      <div class="side-rail">\n'
                for comp in sidenotes:
                    html += "        " + render_component(comp)
                html += '      </div>\n'
                html += '    </div>\n'
            else:
                html += f'    <div class="safe-zone" style="gap: {dynamic_gap};{safe_inset_style}">\n'
                for comp in page.get("components", []):
                    html += "      " + render_component(comp)
                html += '    </div>\n'

            html += '  </div>\n'

        html += '</div>\n'

    else:
        # ═══ LEGACY PER-PAGE MODE (single-page documents) ═══
        for page_idx, page in enumerate(pages):
            archetype = page.get("archetype", "cover_hero")

            _auto_assign_grid_areas(archetype, page.get("components", []))

            total_chars = 0
            sidenotes = []
            main_components = []
            for comp in page.get("components", []):
                text_content = comp.get("markdown_content", "") or comp.get("body", "") or ""
                total_chars += len(text_content)
                if comp.get("type") == "Sidenote_Block":
                    sidenotes.append(comp)
                else:
                    main_components.append(comp)
                    for step in comp.get("steps", []):
                        total_chars += len(step.get("title", "")) + len(step.get("description", ""))

            if total_chars > 500:
                safe_inset = "8% 10%"
            elif total_chars > 200:
                safe_inset = "10% 12%"
            else:
                safe_inset = ""
            safe_inset_style = f" inset: {safe_inset};" if safe_inset else ""

            page_svg = ""
            if svg_type != "none":
                data_points = None
                for comp in page.get("components", []):
                    dp = comp.get("data_points")
                    if dp and isinstance(dp, list) and all(isinstance(x, (int, float)) for x in dp):
                        data_points = dp
                        break
                if data_points and len(data_points) >= 2:
                    page_svg = _generate_data_driven_svg(data_points, canvas_w, canvas_h, palette['accent'])
                elif continuous_svgs and page_idx < len(continuous_svgs):
                    page_svg = continuous_svgs[page_idx]
                elif bg_svg:
                    page_svg = bg_svg

            html += f'\n<div class="canvas archetype-{archetype}">\n'
            if page_svg:
                html += f'  <div class="bg-layer">{page_svg}</div>\n'

            if archetype == "tufte_report" and sidenotes:
                html += f'  <div class="safe-zone" style="gap: {dynamic_gap};{safe_inset_style}">\n'
                html += f'    <div class="main-column" style="gap: {dynamic_gap};">\n'
                for comp in main_components:
                    html += "      " + render_component(comp)
                html += '    </div>\n'
                html += '    <div class="side-rail">\n'
                for comp in sidenotes:
                    html += "      " + render_component(comp)
                html += '    </div>\n'
                html += '  </div>\n</div>\n'
            else:
                html += f'  <div class="safe-zone" style="gap: {dynamic_gap};{safe_inset_style}">\n'
                for comp in page.get("components", []):
                    html += "    " + render_component(comp)
                html += '  </div>\n</div>\n'

    html += "</body>\n</html>"

    # 4. Save
    with open(output_html_path, 'w', encoding='utf-8') as f:
        f.write(html)

    return output_html_path, palette

if __name__ == "__main__":
    main()
