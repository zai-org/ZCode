# -*- coding: utf-8 -*-
"""
cover_render.py — ReportLab cover generator for the PDF skill.

Renders a single-page A4 cover PDF (to be merged as page 1 of the body PDF via
pypdf). Pure ReportLab — no HTML/Playwright/Chromium required.

Nine templates (renumbered 01-09):
  01 HUD Data Terminal      (light)  — report/tech
  02 Corporate Editorial    (light)  — annual/financial
  03 Monolith               (light)  — white paper/proposal/gov
  04 Museum Minimal         (light)  — portfolio/gallery/luxury
  05 Solid Sidebar          (light)  — institutional/bidding/legal
  06 Academic Vertical      (dark)   — arXiv/preprint/tech report
  07 Academic Symmetric     (dark)   — IEEE/ACM/thesis
  08 Academic Journal       (dark)   — CJK journal/thesis w/ keywords
  09 Institutional          (white + black frame) — thesis proposal/gov

Fonts: auto-detected from the host machine, chosen by cover style
(sans for 01-05, serif for 06-09; kai optional). CFF/PostScript-outline fonts
(PingFang, Hiragino, Noto CJK OTC, Source Han) are skipped — ReportLab's TTFont
cannot embed them. Missing heavy weights are simulated with stroke faux-bold.

CLI:
  "$(command -v zcode-python || command -v python3)" cover_render.py <template 01-09> --out cover.pdf [--content content.json]
  "$(command -v zcode-python || command -v python3)" cover_render.py --demo            # renders all 9 with sample content
"""
import os, sys, json, argparse, subprocess
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

# ── Page geometry (A4 pt); HTML design canvas was 794x1123 px ──
W, H = 595.28, 841.89
PXW, PXH = 794.0, 1123.0
def X(px):  return px * W / PXW
def LW(px): return px * W / PXW
def VH(px): return px * H / PXH
def YT(px): return H - px * H / PXH
def FSpx(px): return px * W / PXW

# ── Default palette (override via palette dict) ──
DEFAULT_PALETTE = {
    "primary": "#1e3a5f", "secondary": "#2d5f8a", "text": "#1a1a2e",
    "muted": "#6b7280", "bg": "#ffffff",
    # academic dark
    "ac_bg": "#162032", "ac_accent": "#4A90C4", "ac_gold": "#8B7E5A",
    "ac_text": "#FFFFFF", "ac_muted": "#90A8C0", "ac_foot": "#607080",
}

# ═══════════════════════════════════════════════════════════════════
# Font detection — pick embeddable (TrueType-outline) CJK fonts by role
# ═══════════════════════════════════════════════════════════════════
_FONT_CANDIDATES = {
    # role: [(regname, [path candidates], subfontIndex)]
    "sans": [
        ("SimHei", ["/usr/share/fonts/truetype/chinese/SimHei.ttf",
                     "~/Library/Fonts/SimHei.ttf", "C:/Windows/Fonts/simhei.ttf"], None),
        ("MSYaHei", ["/usr/share/fonts/truetype/chinese/msyh.ttf",
                      "/usr/share/fonts/truetype/chinese/msyh.ttc",
                      "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyh.ttf"], 0),
        ("HeitiSC", ["/System/Library/Fonts/STHeiti Medium.ttc"], 1),
        ("WenQuanYiZenHei", ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"], 0),
        ("ArialUnicode", ["/Library/Fonts/Arial Unicode.ttf",
                           "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"], None),
    ],
    "serif": [
        ("SongtiSC", ["/System/Library/Fonts/Supplemental/Songti.ttc"], 0),   # Black
        ("SimSun", ["/usr/share/fonts/truetype/chinese/simsun.ttc",
                     "~/Library/Fonts/SimSun.ttf", "C:/Windows/Fonts/simsun.ttc"], 0),
        ("STSong", ["/System/Library/Fonts/Supplemental/Songti.ttc"], 4),
        ("ARPLUMing", ["/usr/share/fonts/truetype/arphic/uming.ttc"], 0),
    ],
    "kai": [
        ("KaiTi", ["/usr/share/fonts/truetype/chinese/simkai.ttf",
                    "~/Library/Fonts/SimKai.ttf", "C:/Windows/Fonts/simkai.ttf"], None),
        ("KaitiSC", ["/System/Library/Fonts/Supplemental/Kaiti.ttc"], 2),
    ],
    "latin": [
        ("TNR", ["/usr/share/fonts/truetype/english/Times-New-Roman.ttf",
                  "~/Library/Fonts/Times-New-Roman.ttf",
                  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
                  "C:/Windows/Fonts/times.ttf"], None),
    ],
}

def _try_register(name, path, idx):
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        return False
    try:
        pdfmetrics.registerFont(TTFont(name, path) if idx is None
                                else TTFont(name, path, subfontIndex=idx))
        return True   # succeeds only for embeddable TrueType-outline fonts
    except Exception:
        return False  # CFF/PostScript-outline (PingFang/Hiragino/Noto CJK) land here

def _fc_fallback(role):
    """Last resort: query fontconfig for a zh font and try to embed it."""
    try:
        pat = ":lang=zh:spacing=100" if role == "sans" else ":lang=zh"
        out = subprocess.run(["fc-list", pat, "file"], capture_output=True,
                             text=True, timeout=5).stdout
    except Exception:
        return None
    for line in out.splitlines():
        p = line.split(":")[0].strip()
        if p.lower().endswith((".ttf", ".ttc")):
            nm = "FC_%s_%d" % (role, abs(hash(p)) % 10000)
            if _try_register(nm, p, 0):
                return nm
    return None

def detect_fonts(overrides=None):
    """Return {sans, serif, kai, latin} of registered, embeddable font names.
    `overrides` may map any role -> (regname, path, idx) to force a choice."""
    picks = {}
    overrides = overrides or {}
    for role, cands in _FONT_CANDIDATES.items():
        chosen = None
        if role in overrides:
            nm, p, i = overrides[role]
            if _try_register(nm, p, i):
                chosen = nm
        if not chosen:
            for nm, paths, idx in cands:
                for p in paths:
                    if _try_register("F_%s_%s" % (role, nm), p, idx):
                        chosen = "F_%s_%s" % (role, nm); break
                if chosen: break
        if not chosen and role in ("sans", "serif"):
            chosen = _fc_fallback(role)
        picks[role] = chosen
    # graceful fallbacks
    if not picks.get("sans"):  picks["sans"] = picks.get("serif")
    if not picks.get("serif"): picks["serif"] = picks.get("sans")
    if not picks.get("latin"): picks["latin"] = picks.get("sans")
    if not picks.get("kai"):   picks["kai"] = picks.get("serif") or picks.get("sans")
    if not picks.get("sans"):
        raise RuntimeError("No embeddable CJK font found on this machine. "
                           "Install one of: SimHei, Microsoft YaHei, Songti/SimSun, "
                           "Heiti SC, WenQuanYi Zen Hei.")
    return picks

# ═══════════════════════════════════════════════════════════════════
# primitives
# ═══════════════════════════════════════════════════════════════════
def _c(hexv): return HexColor(hexv)

def fill_rect(c, x_px, top_px, w_px, h_px, color, alpha=1.0):
    c.saveState(); c.setFillColor(color); c.setFillAlpha(alpha)
    c.rect(X(x_px), YT(top_px) - VH(h_px), LW(w_px), VH(h_px), stroke=0, fill=1)
    c.restoreState()

def hline(c, x_px, top_px, w_px, thick_px, color, alpha=1.0):
    c.saveState(); c.setStrokeColor(color); c.setStrokeAlpha(alpha); c.setLineWidth(LW(thick_px))
    c.line(X(x_px), YT(top_px), X(x_px + w_px), YT(top_px)); c.restoreState()

def vline(c, x_px, top_px, h_px, thick_px, color, alpha=1.0):
    c.saveState(); c.setStrokeColor(color); c.setStrokeAlpha(alpha); c.setLineWidth(LW(thick_px))
    c.line(X(x_px), YT(top_px), X(x_px), YT(top_px + h_px)); c.restoreState()

def _style(font, size, color, leading=None, align=TA_LEFT):
    return ParagraphStyle('s', fontName=font, fontSize=size, leading=leading or size * 1.2,
                          textColor=color, alignment=align, wordWrap='CJK')

def para(c, text, x_px, top_px, w_px, font, size, color, line_h=1.2, align=TA_LEFT, fauxbold=0.0):
    st = _style(font, size, color, leading=size * line_h, align=align)
    w = LW(w_px); x = X(x_px)
    p = Paragraph(text, st); _, h = p.wrap(w, H); y = YT(top_px) - h
    if fauxbold > 0:
        for dx, dy in [(0, 0), (fauxbold, 0), (0, fauxbold), (fauxbold, fauxbold), (fauxbold / 2, fauxbold / 2)]:
            pp = Paragraph(text, st); pp.wrap(w, H); pp.drawOn(c, x + dx, y - dy)
    else:
        p.drawOn(c, x, y)
    return h

def line_text(c, text, x_px, top_px, font, size, color, ls_px=0.0, align=TA_LEFT,
              right_px=None, ascent=0.82, alpha=1.0):
    c.saveState(); c.setFillColor(color); c.setFillAlpha(alpha)
    ls = LW(ls_px); baseline = YT(top_px) - size * ascent
    if align == TA_RIGHT and right_px is not None:
        w = stringWidth(text, font, size) + ls * max(0, len(text) - 1); x = X(right_px) - w
    else:
        x = X(x_px)
    to = c.beginText(x, baseline); to.setFont(font, size)
    if ls: to.setCharSpace(ls)
    to.textOut(text); c.drawText(to); c.restoreState()

def center_line(c, text, top_px, font, size, color, ls_px=0.0, fauxbold=0.0, line_h=1.3):
    ls = LW(ls_px); w = stringWidth(text, font, size) + ls * max(0, len(text) - 1)
    x = W / 2 - w / 2; baseline = YT(top_px) - size * 0.82
    c.saveState(); c.setFillColor(color)
    def draw(dx, dy):
        to = c.beginText(x + dx, baseline - dy); to.setFont(font, size)
        if ls: to.setCharSpace(ls)
        to.textOut(text); c.drawText(to)
    if fauxbold > 0:
        for dx, dy in [(0, 0), (fauxbold, 0), (0, fauxbold), (fauxbold, fauxbold), (fauxbold / 2, fauxbold / 2)]:
            draw(dx, dy)
    else:
        draw(0, 0)
    c.restoreState()
    return size * line_h

# ═══════════════════════════════════════════════════════════════════
# templates  (F = detected font names, P = palette colors)
# ═══════════════════════════════════════════════════════════════════
def _t01_hud(c, ct, F, P):
    pri = _c(P["primary"]); txt = _c(P["text"]); mut = _c(P["muted"])
    c.saveState(); c.setStrokeColor(pri); c.setStrokeAlpha(0.05); c.setLineWidth(LW(0.5))
    x = 0
    while x <= PXW: c.line(X(x), 0, X(x), H); x += 50
    y = 0
    while y <= PXH: c.line(0, YT(y), W, YT(y)); y += 50
    c.restoreState()
    xc = 0.12 * PXW + 30
    vline(c, 0.12 * PXW, 0.10 * PXH, 0.80 * PXH, 6, pri)
    hline(c, xc, 0.72 * PXH - 12, 0.4 * PXW, 1, pri, alpha=0.4)
    line_text(c, ct["kicker"], xc, 0.15 * PXH, F["sans"], 16, mut, ls_px=3)
    para(c, ct["hero"], xc, 0.28 * PXH, 0.7 * PXW, F["sans"], 66, pri, line_h=1.15, fauxbold=1.4)
    para(c, ct["summary"], xc, 0.48 * PXH, 0.6 * PXW, F["sans"], 17, txt, line_h=1.6)
    para(c, ct["meta"], xc, 0.74 * PXH, 0.7 * PXW, F["sans"], 17, txt, line_h=1.7)

def _t02_corporate(c, ct, F, P):
    pri = _c(P["primary"]); txt = _c(P["text"]); mut = _c(P["muted"])
    c.saveState(); c.setFillColor(pri); c.setFillAlpha(0.05)
    yr = ct.get("year", "")
    w = stringWidth(yr, F["sans"], 180)
    c.drawString((W - X(20)) - w, YT(0.15 * PXH) - 180 * 0.80, yr); c.restoreState()
    fill_rect(c, 0, 0, PXW, 15, pri)
    fill_rect(c, 0.88 * PXW, 0.75 * PXH, 4, 0.13 * PXH, pri)
    line_text(c, ct["kicker"], 0.12 * PXW, 0.15 * PXH, F["sans"], 16, mut, ls_px=3)
    para(c, ct["hero"], 0.12 * PXW, 0.15 * PXH + 44, 0.75 * PXW, F["sans"], 60, pri, line_h=1.15, fauxbold=1.3)
    para(c, ct["summary"], 0.12 * PXW, 0.50 * PXH, 0.5 * PXW, F["sans"], 17, txt, line_h=1.6)
    para(c, ct["meta"], 0.15 * PXW, 0.70 * PXH, (0.88 * PXW - 20) - 0.15 * PXW,
         F["sans"], 17, txt, line_h=1.8, align=TA_RIGHT)

def _t03_monolith(c, ct, F, P):
    pri = _c(P["primary"]); txt = _c(P["text"]); mut = _c(P["muted"]); xc = 0.12 * PXW
    c.saveState(); c.setFillColor(pri); c.setFillAlpha(0.04)
    c.translate(X(0.85 * PXW), H / 2); c.rotate(-90)
    word = ct.get("word", "REPORT")
    tw = stringWidth(word, F["sans"], 170) + LW(8) * (len(word) - 1)
    to = c.beginText(-tw / 2, -170 * 0.35); to.setFont(F["sans"], 170); to.setCharSpace(LW(8))
    to.textOut(word); c.drawText(to); c.restoreState()
    fill_rect(c, xc, 0.15 * PXH, 50, 5, pri)
    vline(c, xc - 12, 0.70 * PXH, 0.12 * PXH, 2, pri, alpha=0.5)
    line_text(c, ct["kicker"], xc, 0.20 * PXH, F["sans"], 16, mut, ls_px=3)
    para(c, ct["hero"], xc, 0.28 * PXH, 0.7 * PXW, F["sans"], 60, pri, line_h=1.15, fauxbold=1.3)
    para(c, ct["summary"], xc, 0.45 * PXH, 0.55 * PXW, F["sans"], 17, txt, line_h=1.6)
    para(c, ct["meta"], xc, 0.70 * PXH, 0.7 * PXW, F["sans"], 18, txt, line_h=2.0)
    if ct.get("footer"):
        line_text(c, ct["footer"], 0, 0.90 * PXH, F["sans"], 16, mut, ls_px=1,
                  align=TA_RIGHT, right_px=0.88 * PXW, alpha=0.85)

def _t04_museum(c, ct, F, P):
    pri = _c(P["primary"]); txt = _c(P["text"]); mut = _c(P["muted"])
    M = 0.08 * PXW; arm = 30; lw = 2; op = 0.6
    def mk(hx, hy, vx, vy):
        fill_rect(c, hx, hy, arm, lw, pri, alpha=op); fill_rect(c, vx, vy, lw, arm, pri, alpha=op)
    mk(M, M, M, M); mk(PXW - M - arm, M, PXW - M - lw, M)
    mk(M, PXH - M - lw, M, PXH - M - arm); mk(PXW - M - arm, PXH - M - lw, PXW - M - lw, PXH - M - arm)
    styles = [
        (ct["kicker"], F["sans"], 16, mut, 1.3, 24, 0.84 * PXW, 0.0),
        (ct["hero"], F["sans"], 56, pri, 1.15, 20, 0.84 * PXW, 1.2),
        (ct["summary"], F["sans"], 17, txt, 1.6, 40, 0.6 * PXW, 0.0),
        (ct["meta"], F["sans"], 16, mut, 1.3, 0, 0.84 * PXW, 0.0),
    ]
    paras = []; total = 0
    for tx, fn, sz, col, lh, gap, wpx, fb in styles:
        st = _style(fn, sz, col, leading=sz * lh, align=TA_CENTER)
        p = Paragraph(tx, st); _, hh = p.wrap(LW(wpx), H)
        paras.append((tx, st, hh, gap, wpx, fb)); total += hh + VH(gap)
    y = H / 2 + total / 2
    for tx, st, hh, gap, wpx, fb in paras:
        x0 = (W - LW(wpx)) / 2
        if fb > 0:
            for dx, dy in [(0, 0), (fb, 0), (0, fb), (fb, fb), (fb / 2, fb / 2)]:
                pp = Paragraph(tx, st); pp.wrap(LW(wpx), H); pp.drawOn(c, x0 + dx, y - hh - dy)
        else:
            pp = Paragraph(tx, st); pp.wrap(LW(wpx), H); pp.drawOn(c, x0, y - hh)
        y -= hh + VH(gap)

def _t05_sidebar(c, ct, F, P):
    pri = _c(P["primary"]); txt = _c(P["text"]); mut = _c(P["muted"]); white = _c("#ffffff")
    sb = 0.1 * PXW; le = sb + 40
    fill_rect(c, 0, 0, sb, PXH, pri)
    c.saveState(); pth = c.beginPath(); pth.rect(0, 0, X(sb), H); c.clipPath(pth, stroke=0)
    c.setFillColor(white); c.setFillAlpha(0.15)
    c.translate(X(sb / 2), H / 2); c.rotate(-90)
    wm = ct.get("year", ct.get("word", ""))
    tw = stringWidth(wm, F["sans"], FSpx(52)) + LW(14) * (len(wm) - 1)
    to = c.beginText(-tw / 2, -FSpx(52) * 0.35); to.setFont(F["sans"], FSpx(52)); to.setCharSpace(LW(14))
    to.textOut(wm); c.drawText(to); c.restoreState()
    hline(c, le, 0.90 * PXH, 0.90 * PXW - le, 1, pri, alpha=0.3)
    blk_w = 0.90 * PXW - le
    items = [
        (ct["kicker"], F["sans"], 16, mut, 1.3, 18, 0.0),
        (ct["hero"], F["sans"], 58, pri, 1.15, 24, 1.25),
        (ct["summary"], F["sans"], 17, txt, 1.6, 30, 0.0),
        (ct["meta"], F["sans"], 18, txt, 1.8, 0, 0.0),
    ]
    paras = []; total = 0
    for tx, fn, sz, col, lh, gap, fb in items:
        st = _style(fn, sz, col, leading=sz * lh, align=TA_LEFT)
        pp = Paragraph(tx, st); _, hh = pp.wrap(LW(blk_w), H)
        paras.append((tx, st, hh, gap, fb)); total += hh + VH(gap)
    y = H / 2 + total / 2
    for tx, st, hh, gap, fb in paras:
        if fb > 0:
            for dx, dy in [(0, 0), (fb, 0), (0, fb), (fb, fb), (fb / 2, fb / 2)]:
                pp = Paragraph(tx, st); pp.wrap(LW(blk_w), H); pp.drawOn(c, X(le) + dx, y - hh - dy)
        else:
            pp = Paragraph(tx, st); pp.wrap(LW(blk_w), H); pp.drawOn(c, X(le), y - hh)
        y -= hh + VH(gap)
    if ct.get("footer_left"):
        line_text(c, ct["footer_left"], le, 0.90 * PXH - 26, F["sans"], 16, mut, alpha=0.9)
    if ct.get("footer_right"):
        line_text(c, ct["footer_right"], 0, 0.90 * PXH - 26, F["sans"], 16, mut,
                  ls_px=1, align=TA_RIGHT, right_px=0.90 * PXW, alpha=0.85)

def _dark_bg(c, color): c.setFillColor(color); c.rect(0, 0, W, H, stroke=0, fill=1)

def _t06_academic_vertical(c, ct, F, P):
    bg = _c(P["ac_bg"]); gold = _c(P["ac_gold"]); tx = _c(P["ac_text"]); mut = _c(P["ac_muted"]); foot = _c(P["ac_foot"])
    _dark_bg(c, bg)
    vline(c, 57, 76, PXH - 152, 2.5, gold)
    hline(c, 83, PXH - 132, PXW - 83 - 76, 0.5, gold)
    line_text(c, ct.get("label", ""), 83, 132, F["sans"], 9, gold, ls_px=3)
    para(c, ct["title"], 83, 228, 600, F["serif"], 30, tx, line_h=1.3)
    if ct.get("subtitle"): para(c, ct["subtitle"], 83, 560, 520, F["sans"], 12, mut, line_h=1.5)
    para(c, ct.get("authors", ""), 83, 700, 400, F["sans"], 12, tx, line_h=1.4)
    if ct.get("institution"): para(c, ct["institution"], 83, 740, 400, F["sans"], 10, mut, line_h=1.4)
    if ct.get("footer_left"): line_text(c, ct["footer_left"], 83, PXH - 76 - 9, F["sans"], 9, foot)
    if ct.get("footer_right"): line_text(c, ct["footer_right"], 0, PXH - 76 - 9, F["sans"], 9, foot,
                                          align=TA_RIGHT, right_px=PXW - 76)

def _centered_dark(c, ct, F, P, divider_px, keywords):
    bg = _c(P["ac_bg"]); acc = _c(P["ac_accent"]); tx = _c(P["ac_text"]); mut = _c(P["ac_muted"])
    _dark_bg(c, bg)
    hline(c, 114, 114, PXW - 228, 2, acc); hline(c, 114, PXH - 114, PXW - 228, 2, acc)
    inner = PXW - 228
    blocks = [(ct.get("label", ""), F["sans"], 9, acc, 1.2, 40),
              (ct["title"], F["serif"], 30 if keywords else 28, tx, 1.3, 20 if keywords else 24),
              (ct.get("subtitle", ""), F["sans"], 13, mut, 1.5, 40)]
    paras = []; total = 0
    for tx0, fn, sz, col, lh, gap in blocks:
        pp = Paragraph(tx0, _style(fn, sz, col, leading=sz * lh, align=TA_CENTER))
        _, hh = pp.wrap(LW(inner), H); paras.append((pp, hh, gap)); total += hh + VH(gap)
    if keywords:
        tail = ct.get("keywords_lines", []); tail_h = len(tail) * 11 * 1.8
    else:
        tail_h = 12 * 1.2 + VH(12) + 10 * 1.2
    total += VH(0.5) + VH(40) + tail_h
    y = H / 2 + total / 2
    for pp, hh, gap in paras:
        pp.drawOn(c, (W - LW(inner)) / 2, y - hh); y -= hh + VH(gap)
    c.saveState(); c.setStrokeColor(acc); c.setLineWidth(LW(0.5))
    c.line(W / 2 - LW(divider_px) / 2, y, W / 2 + LW(divider_px) / 2, y); c.restoreState()
    y -= VH(40)
    if keywords:
        for ln in ct.get("keywords_lines", []):
            pp = Paragraph(ln, _style(F["sans"], 11, mut, leading=11 * 1.8, align=TA_CENTER))
            _, hh = pp.wrap(LW(inner), H); pp.drawOn(c, (W - LW(inner)) / 2, y - hh); y -= hh
    else:
        pp = Paragraph(ct.get("authors", ""), _style(F["sans"], 12, tx, leading=12 * 1.2, align=TA_CENTER))
        _, hh = pp.wrap(LW(inner), H); pp.drawOn(c, (W - LW(inner)) / 2, y - hh); y -= hh + VH(12)
        pp = Paragraph(ct.get("institution", ""), _style(F["sans"], 10, mut, leading=10 * 1.4, align=TA_CENTER))
        _, hh = pp.wrap(LW(inner), H); pp.drawOn(c, (W - LW(inner)) / 2, y - hh)
    foot = " · ".join([s for s in [ct.get("footer_left"), ct.get("footer_right")] if s])
    if foot:
        pp = Paragraph(foot, _style(F["sans"], 9, mut, leading=9 * 1.2, align=TA_CENTER))
        pp.wrap(LW(inner), H); pp.drawOn(c, (W - LW(inner)) / 2, YT(PXH - 57))

def _t07_academic_symmetric(c, ct, F, P): _centered_dark(c, ct, F, P, 114, keywords=False)
def _t08_academic_journal(c, ct, F, P):  _centered_dark(c, ct, F, P, 152, keywords=True)

def _t09_institutional(c, ct, F, P):
    black = _c("#1a1a1a"); linec = _c("#333333"); dmut = _c("#4a4a4a")
    # serif family: use kai if requested, else serif
    serif = F["kai"] if ct.get("style") == "kai" else F["serif"]
    c.saveState(); c.setStrokeColor(black); c.setLineWidth(LW(2.5))
    c.rect(X(40), YT(PXH - 56), X(PXW - 40) - X(40), YT(56) - YT(PXH - 56), stroke=1, fill=0); c.restoreState()
    cont_l = 90; cont_w = (PXW - 40 - 50) - 90; cont_bottom = PXH - 56 - 60
    y = 56 + 60
    y += center_line(c, ct["institution"], y, serif, 30, black, ls_px=6) + 30
    dw = 0.70 * cont_w
    hline(c, PXW / 2 - dw / 2, y, dw, 2, black); y += 2 + 40
    if ct.get("doc_type"):
        y += center_line(c, ct["doc_type"], y, F["sans"], 22, black, ls_px=4) + 50
    y += para(c, ct["title"], (PXW - 520) / 2, y, 520, serif, 24, black, line_h=1.4, align=TA_CENTER) + 110
    fld_w = 400; fld_x = (PXW - fld_w) / 2; label_w = 90
    for lbl, val in ct.get("fields", []):
        line_text(c, lbl, fld_x, y, F["sans"], 14, black, ls_px=2)
        vx = fld_x + label_w + 12; vw = fld_w - label_w - 12
        pp = Paragraph(val, _style(F["sans"], 14, black, leading=14 * 1.2, align=TA_CENTER))
        _, hh = pp.wrap(LW(vw), H); pp.drawOn(c, X(vx), YT(y) - hh)
        hline(c, vx, y + 26, vw, 1, linec); y += 58
    if ct.get("date"):
        center_line(c, ct["date"], cont_bottom - 26, F["sans"], 14, dmut, ls_px=2)

TEMPLATES = {
    "01": (_t01_hud, "bg"), "02": (_t02_corporate, "bg"), "03": (_t03_monolith, "bg"),
    "04": (_t04_museum, "bg"), "05": (_t05_sidebar, "bg"),
    "06": (_t06_academic_vertical, "ac_bg"), "07": (_t07_academic_symmetric, "ac_bg"),
    "08": (_t08_academic_journal, "ac_bg"), "09": (_t09_institutional, "bg"),
}

# ═══════════════════════════════════════════════════════════════════
# public API
# ═══════════════════════════════════════════════════════════════════
def render_cover(template, content, out_pdf, palette=None, fonts=None, font_overrides=None):
    """Render one cover to a single-page A4 PDF.
    template: "01".."09"; content: dict (keys depend on template family);
    palette: optional dict overriding DEFAULT_PALETTE; fonts: optional pre-detected
    dict from detect_fonts(); font_overrides: role->(name,path,idx)."""
    template = str(template).zfill(2)
    if template not in TEMPLATES:
        raise ValueError("unknown template %r (expected 01-09)" % template)
    P = dict(DEFAULT_PALETTE); P.update(palette or {})
    F = fonts or detect_fonts(font_overrides)
    fn, bgkey = TEMPLATES[template]
    c = canvas.Canvas(out_pdf, pagesize=(W, H))
    c.setFillColor(_c(P[bgkey])); c.rect(0, 0, W, H, stroke=0, fill=1)
    fn(c, content, F, P)
    c.showPage(); c.save()
    return out_pdf

# ── demo sample content ──
_DEMO_REPORT = {
    "kicker": "2025 年度可持续发展报告 · ANNUAL ESG REPORT", "hero": "青松环境科技",
    "summary": "本报告系统披露青松环境科技在 2025 财年的 ESG 实践、碳中和路径与核心运营数据，涵盖 Green Energy、循环经济与社会责任等关键议题。",
    "meta": "发布单位：青松环境科技集团　·　2026 年 3 月",
    "footer": "QINGSONG GREENTECH · DOC 2026-ESG-001",
    "footer_left": "青松环境科技集团 · 2026 年 3 月", "footer_right": "DOC 2026-ESG-001",
    "year": "2026", "word": "REPORT",
}
_DEMO_ACADEMIC = {
    "label": "博士学位论文 · DOCTORAL DISSERTATION",
    "title": "面向城市交通的深度强化学习信号协同优化方法研究",
    "subtitle": "A Study on Deep Reinforcement Learning for Urban Traffic Signal Coordination",
    "authors": "张明远", "institution": "清华大学 计算机科学与技术系",
    "keywords_lines": ["深度强化学习 · 交通信号控制", "多智能体协同 · 城市交通仿真"],
    "footer_left": "Journal of Intelligent Transportation", "footer_right": "2026 年 3 月",
}
_DEMO_INST = {
    "institution": "清华大学", "doc_type": "博士学位论文开题报告",
    "title": "面向城市交通的深度强化学习信号协同优化方法研究",
    "fields": [["姓　　名", "张明远"], ["学　　号", "2021210001"], ["导　　师", "李国华 教授"],
               ["院　　系", "计算机科学与技术系"], ["专　　业", "计算机科学与技术"]],
    "date": "2026 年 3 月",
}
def _demo_content(t):
    if t in ("06", "07", "08"): return _DEMO_ACADEMIC
    if t == "09": return _DEMO_INST
    return _DEMO_REPORT

def main(argv=None):
    ap = argparse.ArgumentParser(description="ReportLab cover generator (templates 01-09)")
    ap.add_argument("template", nargs="?", help="01-09")
    ap.add_argument("--out", default="cover.pdf")
    ap.add_argument("--content", help="path to JSON content file")
    ap.add_argument("--demo", action="store_true", help="render all 9 with sample content")
    ap.add_argument("--outdir", default=".")
    a = ap.parse_args(argv)
    F = detect_fonts()
    print("Detected fonts:", {k: v for k, v in F.items()})
    if a.demo:
        for t in TEMPLATES:
            out = os.path.join(a.outdir, "cover_%s.pdf" % t)
            render_cover(t, _demo_content(t), out, fonts=F); print("wrote", out)
        return
    if not a.template:
        ap.error("template (01-09) or --demo required")
    content = _demo_content(str(a.template).zfill(2))
    if a.content:
        with open(a.content, encoding="utf-8") as f: content = json.load(f)
    render_cover(a.template, content, a.out, fonts=F); print("wrote", a.out)

if __name__ == "__main__":
    main()
