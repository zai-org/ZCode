(async () => {
  // In-page design audit: one expression resolving to a report. Evaluate the file as is, or, where a tool only takes a function,
  // as `() => <file>` or `return (<file>)`. Without audit.mjs, run it at 1440 and 390 with no baseline.
  // mustFix: measured defects. advisory: heuristics to look at, not to obey; equal items (pricing tiers, galleries, options, tags) are legitimate.
  // Visually hidden (sr-only) text and folded text (clipped away by an ancestor, off-screen drawers, tooltips waiting for a trigger)
  // are skipped. Painted text is measured even under [aria-hidden="true"] or [data-audit-skip] — both mark intent, not pixels, so they
  // mute only the heuristics that read intent (textWall, stretchedBox, leftEdge, transitions) and never the echo family, where the
  // marker is the evidence; aria-hidden text is exempt from contrast alone, which is the one check WCAG itself exempts for text
  // removed from the accessibility tree. out.suppressed reports every marker honoured, with counts and selectors.
  // Media that spans the whole viewport width is read as full-bleed and keeps no gutter; [data-full-bleed] frees media that
  // bleeds off one edge only, and in neither case its text.
  // Reading surfaces (<article>, [data-reading]) are exempt from textWall.
  // It first scrolls the page through once (as audit.mjs does) so scroll-triggered reveals fire; prescrolled says whether it did.
  // Each key has count, up to 5 samples and sigs (signature -> count). window.__designAuditFull = true adds every hit as
  // [sig, message, contrast ratio?] in items. A fixed canvas (poster, invoice, infinite canvas): set window.__designAuditCanvas =
  // "<its selector>" first; a deck: window.__designAuditDeck = true and evaluate once per slide with __designAuditCanvas naming it.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let prescrolled = !!window.__designAuditPrescrolled;
  if (!prescrolled) {
    // Follows the page as it grows (late async loads included), up to 50 screens, so an infinite feed cannot keep this running.
    // Content never in view by the end (past 50 screens, or arriving after the last check) marks the scan partial.
    const high = () => Math.min(document.documentElement.scrollHeight, innerHeight * 50);
    let y = 0, seen = 0;
    do { for (; y < high(); y += innerHeight / 2) { scrollTo(0, y); seen = Math.max(seen, Math.min(y + innerHeight, document.documentElement.scrollHeight)); await wait(60); } await wait(400); } while (y < high());
    // The browser clamps scrollTo at the bottom, so judge by where the viewport bottom really reached, not by y.
    // Still at the bottom: a page taller than that hit the 50-screen cap.
    const end = document.documentElement.scrollHeight;
    let capped = end > seen + 1;
    scrollTo(0, 0); await wait(800);
    // Taller at the top can be a header that collapses on scroll, not new content: measure again at the bottom,
    // in the same scroll state as end, and only real growth there marks the scan partial.
    if (!capped && document.documentElement.scrollHeight > end + 1) {
      scrollTo(0, end); await wait(400);
      capped = document.documentElement.scrollHeight > end + 1;
      scrollTo(0, 0); await wait(800);
    }
    window.__designAuditScrollCapped = capped;
    for (const a of document.getAnimations()) { try { if (a.effect?.getTiming().iterations !== Infinity) a.finish(); } catch {} }
    await document.fonts.ready;
    window.__designAuditPrescrolled = prescrolled = true;
  }
  const vw = document.documentElement.clientWidth, vh = window.innerHeight, y0 = window.scrollY;
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const rgba = (c) => {
    if (cache.has(c)) return cache.get(c);
    cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data, v = [r, g, b, a / 255];
    cache.set(c, v); return v;
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
  const lum = (c) => { const l = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const cs = (el, p) => getComputedStyle(el, p);
  const absY = (r) => r.top + window.scrollY;
  const sel = (el) => { const c = (el.getAttribute("class") || "").trim().split(/\s+/)[0]; return el.tagName.toLowerCase() + (c ? "." + c : ""); };
  const label = (el, r = el.getBoundingClientRect()) => `${sel(el)} "${(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28)}" @${Math.round(r.left)},${Math.round(absY(r))}`;
  // Core text: running copy the reader has to read (a sentence or more at reading size) and a control's own label. A size or
  // contrast hit on those is the deliverable's to fix even when a baseline has the same one, so the signature carries "core"
  // and audit.mjs never inherits it; a skeleton's decorative typesetting, eyebrows, chrome and code blocks still inherit. Icon
  // glyphs, carets and shortcut badges inside a control are not its label. The text inside a block card link is the item itself.
  const LABELLED = 'a[href],button,summary,input,select,textarea,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="switch"],[role="checkbox"]';
  const core = (el, text, fs) => {
    if (!/[\p{L}\p{N}]/u.test(text)) return "";
    if (text.length >= 60 && fs <= 20 && !el.closest("pre,code,kbd,samp")) return "|core";
    const ctl = el.closest(LABELLED);
    if (!ctl || el.closest("kbd")) return "";
    const cardLink = ctl.tagName === "A" && !/^inline$/.test(cs(ctl).display) && !!ctl.querySelector("h1,h2,h3,h4,h5,h6,p,ul,ol,dl,figure,blockquote");
    return cardLink ? "" : "|core";
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= +cs(e).opacity; return o; };
  const closed = (el) => { const d = el.closest("details:not([open])"); return d && !el.closest("summary"); };
  // Visually hidden accessible text (sr-only: 1px clipped box, clip rect(0...), clip-path inset(50%)) is not painted text.
  const srOnly = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const s = cs(e), r = e.getBoundingClientRect(); if (/^rect\(0/.test(s.clip) || /inset\(50%/.test(s.clipPath) || (r.width <= 1 && r.height <= 1 && /hidden|clip/.test(s.overflowX))) return true; } return false; };
  const shown = (el) => { const r = el.getBoundingClientRect(), s = cs(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && opacityOf(el) > 0.1 && !closed(el) && !srOnly(el); };
  const norm = (t) => t.toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
  const CJK = /[぀-ヿ㐀-鿿가-힯]/;
  const EMOJI = /^(?:\p{Extended_Pictographic}|[‍️⃣]|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]|\s)+$/u;
  const out = { url: location.href, viewport: `${vw}x${vh}`, prescrolled, scrollCapped: !!window.__designAuditScrollCapped, mustFix: {}, advisory: {}, unverifiedContrast: 0 };
  const SLIDE = ".slide,[data-slide],[data-screen-label],[data-slide-index],.reveal .slides>section,.swiper-slide";
  const canvas = window.__designAuditCanvas && document.querySelector(window.__designAuditCanvas);
  // Class-only slides (.slide, .swiper-slide) make a deck only when roughly viewport-sized; carousels stay pages.
  const isDeck = !!window.__designAuditDeck || [...document.querySelectorAll(SLIDE)].filter((s) => !s.parentElement?.closest(SLIDE) && (!s.matches(".slide,.swiper-slide") || (s.offsetWidth >= vw * 0.85 && s.offsetHeight >= vh * 0.7))).length > 1;
  const add = (bucket, key, sig, msg, v) => { (out[bucket][key] ||= []).push([`${key}|${sig}`, msg, ...(v === undefined ? [] : [v])]); };

  // Text owners: elements with their own visible text node, with that text's line boxes.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.data.trim() && !n.parentElement.closest("script,style,noscript,template") ? 1 : 2 });
  const texts = [], own = new Map();
  const invisible = [];
  // Tooltips and popovers waiting for a trigger: positioned, pointer-events:none, and role=tooltip, named by aria-describedby or
  // revealed by a :hover/:focus rule. Any other opacity-0 text is a reveal that never ran.
  const reveal = [];
  for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) if (/:(hover|focus)/.test(r.selectorText)) reveal.push(r.selectorText.replace(/:(hover|focus-within|focus-visible|focus)\b/g, "")); } catch {} }
  const tip = (el) => {
    let pos = false, trig = false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      pos ||= /absolute|fixed/.test(cs(e).position);
      trig ||= e.getAttribute("role") === "tooltip" || (!!e.id && !!document.querySelector(`[aria-describedby~="${CSS.escape(e.id)}"]`)) || reveal.some((q) => { try { return e.matches(q); } catch { return false; } });
    }
    return cs(el).pointerEvents === "none" && pos && trig;
  };
  const fixedIn = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) if (cs(e).position === "fixed") return true; return false; };
  const clipsX = (el) => { for (let e = el.parentElement; e; e = e.parentElement) if (/hidden|clip/.test(cs(e).overflowX)) return true; return false; };
  const scrollerIn = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (/auto|scroll/.test(cs(e).overflowX)) return true; return false; };
  for (let n; (n = walker.nextNode()); ) {
    const el = n.parentElement;
    if (!shown(el)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && cs(el).visibility !== "hidden" && !closed(el) && !srOnly(el) && !tip(el) && !invisible.includes(el)) invisible.push(el);
      continue;
    }
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const s = cs(el), lh = el instanceof SVGElement || s.lineHeight === "normal" ? Infinity : parseFloat(s.lineHeight);
    // Line boxes: glyph rects trimmed to the line height, so tight display type is not read as overlap.
    // Clipped by an overflow:hidden/clip ancestor (ellipsis cells, masks): only the painted part can collide.
    let clip = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const es = cs(e);
      if (/hidden|clip/.test(es.overflowX + es.overflowY)) { const er = e.getBoundingClientRect(); clip = { left: Math.max(clip.left, er.left), right: Math.min(clip.right, er.right), top: Math.max(clip.top, er.top), bottom: Math.min(clip.bottom, er.bottom) }; }
    }
    const lines = rects.map((r) => {
      const top = lh < r.height ? r.top + (r.height - lh) / 2 : r.top, bottom = lh < r.height ? r.bottom - (r.height - lh) / 2 : r.bottom;
      const b = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(top, clip.top), bottom: Math.min(bottom, clip.bottom) };
      return { ...b, width: Math.max(0, b.right - b.left), height: Math.max(0, b.bottom - b.top) };
    });
    const box = range.getBoundingClientRect();
    // Folded: clipped away by an ancestor (max-height:0 accordion, carousel slide) or entirely off-screen (transformed drawer).
    if (lines.every((l) => l.width <= 0 || l.height <= 0)) continue;
    // Past the side only when clipped (by an ancestor or a fixed drawer) or in a scroller; text pushed out by real overflow is measured.
    if ((((box.right <= 0 || box.left >= vw) && (clipsX(el) || fixedIn(el))) || ((box.bottom <= 0 || box.top >= vh) && fixedIn(el))) && !scrollerIn(el)) continue;
    texts.push({ n, el, rects, lines, box });
    own.set(el, (own.get(el) || []).concat({ n, rects }));
  }
  const owners = [...own.keys()];
  for (const el of invisible) add("advisory", "invisibleText", sel(el), `opacity ${opacityOf(el).toFixed(2)} ${label(el)}`);
  const scaleOf = (el) => { const m = el instanceof SVGGraphicsElement && el.getScreenCTM(); return m ? Math.hypot(m.a, m.b) : 1; };

  for (const el of owners) {
    const s = cs(el), isSvg = el instanceof SVGElement, fs = parseFloat(s.fontSize) * (isSvg ? scaleOf(el) : 1), text = el.textContent.trim();
    const px = Math.round(fs * 10) / 10;
    // An 11px eyebrow (short, uppercase or letter-spaced) is advisory; under 11px, or 11px copy, must be fixed. sup/sub are exempt.
    // A short count badge ("3", "12+") of 9px or more is advisory too.
    const eyebrow = (fs >= 11 && text.length <= 40 && (s.textTransform === "uppercase" || parseFloat(s.letterSpacing) >= fs * 0.05)) || (fs >= 9 && /^\d{1,3}\+?$/.test(text));
    if (el.closest("sup,sub")) {} else if (fs < 12 && eyebrow) add("advisory", "smallLabel", `${sel(el)}|${px}`, `${px}px ${label(el)}`);
    else if (fs < 12 || (fs < 14 && text.length > 80)) add("mustFix", "smallText", `${sel(el)}|${px}${core(el, text, fs)}`, `${px}px ${label(el)}`);
    if (!isSvg) {
      const lh = s.lineHeight === "normal" ? fs * 1.2 : parseFloat(s.lineHeight), cjk = CJK.test(text), tops = [];
      for (const t of own.get(el)) for (const r of t.rects) if (!tops.some((y) => Math.abs(y - r.top) < fs / 2)) tops.push(r.top);
      // Under 18px: 1.35 (1.5 for CJK); 18-20px headings and lead text: 1.25; larger display type is not checked.
      if (tops.length >= 2 && fs <= 20 && lh / fs < (fs < 18 ? (cjk ? 1.5 : 1.35) : 1.25)) add("mustFix", "tightLeading", `${sel(el)}|${fs < 18 ? "body" : "lead"}`, `${(lh / fs).toFixed(2)} ${fs}px ${label(el)}`);
      // Truncated: an ellipsis or line clamp that cuts text, or overflow hidden hiding real content (not glyph overhang of tight display type).
      const clamp = s.webkitLineClamp && s.webkitLineClamp !== "none", hidX = el.scrollWidth - el.clientWidth, hidY = el.scrollHeight - el.clientHeight;
      // Reachable: a title or aria-label holding the full text on it or a near ancestor: not a hit. A separate link or button beside it
      // in a small parent (an "Open" link in a card with a clamped summary) probably reaches it: advisory. A control's own label: must-fix.
      if ((s.textOverflow === "ellipsis" && hidX > 1) || (clamp && hidY > 2) || (/hidden|clip/.test(s.overflowX + s.overflowY) && (hidX > fs / 2 || hidY > lh / 2))) {
        const full = norm(text), ctl = el.closest('a[href],button,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option]');
        // A block-level card link (an <a href> holding a heading or other blocks) opens the full item: its text is content, not a label.
        const card = !!ctl && ctl !== el && ctl.tagName === "A" && !/^inline$/.test(cs(ctl).display) && !!ctl.querySelector("h1,h2,h3,h4,h5,h6,p,ul,ol,dl,figure,img,picture,blockquote,div,section,article");
        let reach = false, near = card;
        for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) if (["title", "aria-label"].some((a) => norm(e.getAttribute(a) || "").includes(full))) reach = true;
        const p = (ctl || el).parentElement;
        if (p && p.children.length <= 6 && !/^(MAIN|SECTION|ARTICLE|BODY)$/.test(p.tagName) && [...p.querySelectorAll("a[href],button")].some((c) => !c.contains(el))) near = true;
        if (!reach) add(near ? "advisory" : "mustFix", "truncated", sel(el), label(el));
      }
      if (cjk && /break-all/.test(s.wordBreak)) add("mustFix", "cjkBreak", `${sel(el)}|break-all`, `word-break:break-all ${label(el)}`);
    }
  }

  // CJK: a line starting with closing punctuation is a defect; a short orphaned last line in a heading is advisory.
  for (const t of texts) {
    if (!CJK.test(t.n.data) || t.rects.length < 2) continue;
    const fs = parseFloat(cs(t.el).fontSize), lines = [];
    for (const r of t.rects) { const l = lines.find((x) => Math.abs(x.top - r.top) < fs / 2); l ? (l.w += r.width) : lines.push({ top: r.top, w: r.width }); }
    if (lines.length > 1 && fs >= 18 && lines[lines.length - 1].w < fs * 2.5) add("advisory", "cjkOrphan", sel(t.el), label(t.el));
    const range = document.createRange(), p = document.createRange();
    for (let i = 1; i < t.n.data.length; i++) {
      if (!/[，。、；：！？）」』》,.;:!?)]/.test(t.n.data[i])) continue;
      range.setStart(t.n, i); range.setEnd(t.n, i + 1); p.setStart(t.n, i - 1); p.setEnd(t.n, i);
      if (range.getBoundingClientRect().top - p.getBoundingClientRect().top > fs / 2) { add("mustFix", "cjkBreak", `${sel(t.el)}|punct`, `line starts with "${t.n.data[i]}" ${label(t.el)}`); break; }
    }
  }

  // Colliding text: glyph boxes of different owners intersecting (chart labels, overlaid copy).
  const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const seen = new Set();
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el) || !inter(a.box, b.box) || a.box.right <= 0 || a.box.left >= vw) continue;
    if (a.lines.some((ra) => b.lines.some((rb) => inter(ra, rb) > 0.15 * Math.min(ra.width * ra.height, rb.width * rb.height)))) {
      const k = label(a.el) + label(b.el);
      if (!seen.has(k)) { seen.add(k); add("mustFix", "textCollision", `${sel(a.el)}|${sel(b.el)}`, `${label(a.el)} x ${label(b.el)}`); }
    }
  }

  // Gutters: text, controls and media keep 16px (mobile) / 24px (desktop) from the viewport edges. Horizontal scrollers are exempt;
  // inside a full-height sidebar or nav rail at the edge, 16px applies. On a fixed canvas, content stays inside the canvas instead.
  const gutterOf = (el) => {
    if (vw < 768) return 16;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect(), s = cs(e);
      if ((r.left <= 1 || r.right >= vw - 1) && r.width <= vw * 0.4 && (r.height >= vh * 0.9 || /fixed|sticky/.test(s.position)) && (/^(ASIDE|NAV)$/.test(e.tagName) || /navigation|complementary/.test(e.getAttribute("role") || "") || /fixed|sticky/.test(s.position))) return 16;
    }
    return 24;
  };
  const inScroller = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { if (/auto|scroll/.test(cs(e).overflowX) && e.scrollWidth > e.clientWidth + 1) return true; } return false; };
  const cb = canvas && canvas.getBoundingClientRect(), textIn = new Map();
  // Painted text only: line boxes clipped to overflow-hidden ancestors (an ellipsis cell is measured by what it shows).
  for (const t of texts) for (let e = t.el; e && e !== document.body; e = e.parentElement) { if (!textIn.has(e)) textIn.set(e, []); textIn.get(e).push(...t.lines.filter((l) => l.width > 0)); }
  for (const el of (canvas || document).querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,a,button,input,label,img,svg,video,canvas,td,th")) {
    if (!shown(el) || el.parentElement.closest("svg")) continue;
    let r = el.getBoundingClientRect();
    if (cb) {
      if (/^(IMG|svg|VIDEO|CANVAS)$/.test(el.tagName)) continue; // media may bleed off a canvas; text and controls may not
      if (r.left < cb.left - 0.5 || r.right > cb.right + 0.5 || r.top < cb.top - 0.5 || r.bottom > cb.bottom + 0.5) add("mustFix", "canvasBounds", sel(el), `past the canvas edge by ${[["L", cb.left - r.left], ["R", r.right - cb.right], ["T", cb.top - r.top], ["B", r.bottom - cb.bottom]].filter((d) => d[1] > 0.5).map((d) => d[0] + Math.round(d[1])).join(" ")} ${label(el, r)}`);
      continue;
    }
    const media = /^(IMG|svg|VIDEO|CANVAS)$/.test(el.tagName); // a <picture> is measured through its <img>
    // Media running the whole viewport width is a full-bleed image, not a gutter defect: no marker needed. [data-full-bleed]
    // frees media that bleeds off one edge only; text inside it still keeps the gutter.
    if (media && (el.closest("[data-full-bleed]") || (r.left <= 0.5 && r.right >= vw - 0.5))) continue;
    // Text is measured by its painted text, so padded rows and padded paragraphs are not flagged; controls and media by their box.
    if (!media && !/^(BUTTON|INPUT)$/.test(el.tagName)) { const rs = textIn.get(el) || []; if (!rs.length) continue; r = { left: Math.min(...rs.map((x) => x.left)), right: Math.max(...rs.map((x) => x.right)), top: Math.min(...rs.map((x) => x.top)) }; }
    const g = gutterOf(el);
    // Name the side that failed: "L4 R1325" read as two violations when only the left one was too close.
    const sides = [["left", r.left], ["right", vw - r.right]].filter((d) => d[1] < g - 0.5);
    if (r.right > 0 && (r.left < vw || !(media || /^(BUTTON|INPUT)$/.test(el.tagName))) && sides.length && !inScroller(el)) add("mustFix", "edge", `${sel(el)}|${sides.map((d) => d[0][0].toUpperCase()).join("")}`, `${sides.map((d) => `${Math.round(d[1])}px from the ${d[0]}`).join(" and ")} ${label(el, r)}`);
  }
  if (!cb && document.documentElement.scrollWidth > vw + 1) add("mustFix", "horizontalOverflow", vw < 768 ? "page|core" : "page", `scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);

  // External resources: requested ones plus referencing tags (requests can fail offline).
  const ext = new Set(performance.getEntriesByType("resource").map((e) => e.name));
  for (const e of document.querySelectorAll('script[src],img[src],source[src],video[src],audio[src],iframe[src],link[rel~="stylesheet"][href],link[rel~="preload"][href],link[rel~="icon"][href]')) ext.add(e.src || e.href);
  for (const name of [...ext].sort()) {
    let u; try { u = new URL(name, location.href); } catch { continue; }
    if (/^https?:$/.test(u.protocol) && u.origin !== location.origin) add("mustFix", "externalResource", u.host, name.slice(0, 100));
  }

  // A standalone file: local assets resolve beside it, never through ../, absolute or file:// paths; every image loads; zoom stays on.
  if (location.protocol === "file:") for (const e of document.querySelectorAll("script[src],img[src],source[src],source[srcset],video[src],video[poster],audio[src],iframe[src],link[href]")) {
    const v = e.getAttribute("src") || e.getAttribute("href") || e.getAttribute("srcset") || e.getAttribute("poster") || "";
    if (/^(\.\.[\\/]|[\\/](?![\\/])|file:|[a-z]:[\\/])/i.test(v.trim())) add("mustFix", "localPath", v, `${e.tagName.toLowerCase()} ${v.slice(0, 100)}`);
  }
  for (const img of document.querySelectorAll("img")) {
    if (img.getAttribute("src") && img.complete && img.naturalWidth === 0 && !img.closest("template")) add("mustFix", "brokenImage", img.getAttribute("src").slice(0, 100), `img ${img.getAttribute("src").slice(0, 100)}`);
  }
  const vp = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  if (/user-scalable\s*=\s*(no|0)\b|maximum-scale\s*=\s*1(\.0*)?(?![\d.])/i.test(vp)) add("mustFix", "noZoom", "viewport", vp.slice(0, 100));
  // Touch targets on a phone-width view: a control under 24x24 px that is not an inline link in running text (WCAG 2.5.8).
  if (vw < 768) for (const el of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,[role="button"],[role="tab"],[role="switch"],[role="checkbox"]')) {
    if (!shown(el) || el.closest("[data-audit-skip]") || (el.tagName === "A" && /^inline/.test(cs(el).display) && el.parentElement.closest("p,li,td,dd,blockquote"))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) add("advisory", "smallTarget", sel(el), `${Math.round(r.width)}x${Math.round(r.height)} ${label(el, r)}`);
  }
  // Heading levels go in order: a jump of two or more levels down (h1 to h3) is advisory.
  let lastLevel = 0;
  for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (!shown(h)) continue;
    const lv = +h.tagName[1];
    if (lastLevel && lv > lastLevel + 1) add("advisory", "headingSkip", `${sel(h)}|${lastLevel}>${lv}`, `h${lastLevel} then h${lv} ${label(h)}`);
    lastLevel = lv;
  }

  // Advisory: boxes stretched by their row; a lone box beside a void; identical or many peer boxes.
  const all = [...document.body.querySelectorAll("*")].filter((el) => !(el instanceof SVGElement) && shown(el));
  const boxy = (el) => { const s = cs(el); return s.boxShadow !== "none" || parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) > 0 && parseFloat(s.borderLeftWidth) > 0 || (rgba(s.backgroundColor)[3] > 0 && s.backgroundColor !== cs(el.parentElement).backgroundColor); };
  const contentBottom = (el) => { let b = -Infinity; const range = document.createRange(); range.selectNodeContents(el); for (const r of range.getClientRects()) if (r.height > 0) b = Math.max(b, r.bottom); for (const c of el.querySelectorAll("img,svg,video,canvas,input,button,select,textarea,iframe")) if (shown(c)) b = Math.max(b, c.getBoundingClientRect().bottom); return b; };
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.height < 120 || r.height > vh * 0.8 || r.width > vw * 0.9 || /^(NAV|ASIDE|HEADER|FOOTER|MAIN|DIALOG)$/.test(el.tagName) || !boxy(el) || el.closest("[data-audit-skip]")) continue;
    const s = cs(el), inner = r.height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
    const cb = contentBottom(el);
    if (cb === -Infinity) continue;
    const empty = r.bottom - parseFloat(s.paddingBottom) - parseFloat(s.borderBottomWidth) - cb;
    if (empty > Math.max(96, inner * 0.4)) add("advisory", "stretchedBox", sel(el), `${Math.round(empty)}px empty of ${Math.round(r.height)} ${label(el, r)}`);
  }
  for (const el of all) {
    const s = cs(el);
    if (!/grid|flex/.test(s.display) || (s.display.includes("flex") && !s.flexDirection.startsWith("row"))) continue;
    const kids = [...el.children].filter(shown);
    if (!kids.length) continue;
    const r = el.getBoundingClientRect(), rows = [];
    for (const k of kids) { const kr = k.getBoundingClientRect(), row = rows.find((x) => Math.abs(x.top - kr.top) < 4); row ? row.items.push(kr) : rows.push({ top: kr.top, items: [kr] }); }
    const cards = kids.filter((k) => boxy(k) && k.getBoundingClientRect().height >= 80);
    const multiCol = s.display.includes("grid") ? s.gridTemplateColumns.split(" ").length > 1 : s.flexWrap === "wrap" && rows.length > 1;
    const last = rows[rows.length - 1], lone = kids[kids.length - 1];
    if (multiCol && cards.length === kids.length && rows.length > 1 && last.items.length === 1 && last.items[0].width < r.width * 0.6) add("advisory", "loneItem", sel(lone), `${Math.round(r.width - last.items[0].width)}px empty beside ${label(lone)}`);
    if (cards.length >= 3 && cards.length === kids.length) {
      if (cards.length > 6 && rows.length < 3) add("advisory", "manyPeers", sel(el), `${cards.length} peer boxes in one group: ${label(el)}`);
    }
  }

  // Echo family: one view saying the same thing twice. decorativeEcho (decoration repeating what it sits beside), echoLabel
  // (a line whose content words a heading, control label or chart label nearby already says) and repeatedText (the same
  // string painted twice). audit.mjs numbers these into one worklist, so each is dispositioned instead of glanced at, and
  // no marker the model writes itself takes an item off it: these read painted text under [aria-hidden="true"] and
  // [data-audit-skip] too, because both declare intent and neither moves a pixel. out.suppressed reports every marker the
  // audit does still honour. One defect is listed once: decorativeEcho is the most specific, then echoLabel, then
  // repeatedText, and each key skips what an earlier one already listed. What a script cannot read — paraphrase, a line
  // restating a trend a chart shows, whether an eyebrow adds a category — stays with check.md's cut pass.
  const HEAD = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const SECT = 'section,article,[data-audit-on],[data-slide],[role="region"],main';
  const STOP = new Set("a an the our your my we us you its it this that these those and or of for in on at to by with from about how what why who all more new is are be".split(" "));
  const words = (t) => norm(t).split(" ").filter((w) => w && !STOP.has(w));
  // Two letters or digits at least, and at least one letter: a bare number is a counter, a score, an axis tick or a page
  // number ("04 / 12", "18", "12.5×"), and the same number twice in a view is normal, not a second expression of a fact.
  const substance = (t) => (t.match(/[\p{L}\p{N}]/gu) || []).length >= 2 && /\p{L}/u.test(t);
  const fsOf = (el) => parseFloat(cs(el).fontSize) * (el instanceof SVGElement ? scaleOf(el) : 1);
  // Painted extent: the line boxes already clipped to overflow-hidden ancestors, so a masked or ellipsised copy is measured by what shows.
  const pbox = (el) => {
    const rs = (textIn.get(el) || []).filter((l) => l.width > 0);
    return rs.length ? { left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)), top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) } : null;
  };
  const painted = [];
  for (const el of owners) {
    const box = pbox(el);
    if (box) painted.push({ el, t: norm(el.textContent), box, fs: fsOf(el), sect: el.closest(SECT) || document.body });
  }
  // One view: a deck slide (audited one at a time) or any one viewport of a page.
  const oneView = (a, b) => Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) <= vh;
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  const stacked = (a, b) => inter(a, b) > 0.4 * Math.min(area(a), area(b));
  // Equal items: the text sits in a set of three or more alike siblings (cards, tiles, chips, rows), where a repeat is the
  // pattern, not a defect. Sectioning elements and full-width tall bands are not the repeated unit; anything smaller can be.
  const inSet = (el) => {
    for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      const p = e.parentElement, r = e.getBoundingClientRect(), cls = e.getAttribute("class") || "";
      if (!p || e.matches(SECT) || (r.width > vw * 0.9 && r.height > vh * 0.6)) continue;
      if ([...p.children].filter((k) => k.tagName === e.tagName && (k.getAttribute("class") || "") === cls).length >= 3) return true;
    }
    return false;
  };
  const listed = new Set();

  // decorativeEcho: the decoration's whole string is already said in the view, exact or as a fragment of a longer one (on a
  // space or CJK boundary). It is not a hit when the decoration says more than the text it echoes, which is a title set
  // large, not a repeat. Decorative intent is taken from aria-hidden="true" (the author declared it carries nothing) or from
  // no semantic role plus the largest type in the view; it must also be set at least 1.2x the text it repeats, so only
  // decoration shouting over the real content counts. Not reported: controls, navigation, tabs, running footers, legends,
  // table cells, figures, SVG and chart text, on either side; a value whose accessible name sits on an ancestor; a copy
  // stacked on the original (layered type); equal items; a prose twin.
  const CHROME = 'nav,[role="navigation"],[role="tablist"],[role="tab"],[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],footer,[role="banner"],[role="contentinfo"],a[href],button,[role="button"],[role="link"],label,summary,select,option,legend,figcaption,caption,th,td,dt,figure,svg,[class*="legend" i],[class*="chart" i],[class*="axis" i]';
  const NAMED = 'h1,h2,h3,h4,h5,h6,p,li,dd,blockquote,q,time,abbr,code,kbd,[role]:not([role="presentation"]):not([role="none"])';
  const NOTREAL = '[aria-hidden="true"],svg,footer,[role="contentinfo"],[class*="legend" i],[class*="chart" i]';
  // A decorative repeat needs more body than a drop cap, a step number ("01") or a bullet glyph.
  const solid = (t) => t.length >= 3 && substance(t);
  // A value whose accessible name sits on an ancestor is that element's visual form, not a second expression of the fact.
  const spoken = (el, t) => { for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) for (const a of ["aria-label", "title"]) if (norm(e.getAttribute(a) || "").includes(t)) return true; return false; };
  // The real expression is a heading, a label or a short line — not prose: a value next to its own description is not a copy of it.
  const twins = painted.filter((x) => !x.el.closest(NOTREAL) && solid(x.t) && (x.el.matches(HEAD) || !!x.el.closest(HEAD) || (x.t.length <= 60 && !x.el.closest("p,li,dd,blockquote"))));
  const topFs = Math.max(0, ...twins.map((x) => x.fs));
  const deco = painted.filter((x) => x.fs >= 24 && solid(x.t) && !x.el.closest(CHROME) && !inSet(x.el) && !spoken(x.el, x.t)
    && (!!x.el.closest('[aria-hidden="true"]') || (x.fs >= 48 && x.fs >= topFs && !x.el.closest(NAMED))));
  const bnd = (s, i, len) => [s[i - 1], s[i + len]].every((c) => c === undefined || c === " " || CJK.test(c));
  const covers = (big, small) => { for (let i = big.indexOf(small); i >= 0; i = big.indexOf(small, i + 1)) if (bnd(big, i, small.length)) return true; return false; };
  for (const d of deco) {
    if ([...twins, ...deco].filter((x) => x.t === d.t).length >= 3) continue;
    const m = twins.find((x) => x.el !== d.el && !x.el.contains(d.el) && !d.el.contains(x.el) && d.fs >= x.fs * 1.2
      && covers(x.t, d.t) && oneView(d.box, x.box) && !stacked(d.box, x.box));
    if (m) { listed.add(d.el); add("advisory", "decorativeEcho", `${sel(d.el)}|${sel(m.el)}`, `${Math.round(d.fs)}px ${label(d.el)} repeats ${label(m.el)}`); }
  }

  // echoLabel: a line of at most six content words, all of which a heading, a control label or a chart label in the same
  // section and the same view already says. Not listed: the carriers themselves, text that has to stay readable to act
  // (KEEP, the list check.md keeps) and equal items. A sentence is not a carrier and a run inside a sentence is not a
  // candidate, so a word two sentences share is not a hit. An accessible name is not a carrier either: it paints nothing,
  // so it leaves nothing on screen for a visible line to duplicate, and check.md keeps accessible names on purpose.
  const KEEP = 'a[href],button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],label,summary,select,option,input,textarea,th,legend,nav,[role="navigation"],[role="alert"],[role="status"],footer,[role="contentinfo"],svg,[class*="legend" i],[class*="axis" i]';
  const CARRY = 'a[href],button,[role="button"],summary,label,th,svg';
  const wordSet = new Map(), setOf = (x) => { if (!wordSet.has(x)) wordSet.set(x, new Set(words(x.t))); return wordSet.get(x); };
  const carrier = (x) => x.el.matches(HEAD) || !!x.el.closest(HEAD) || !!x.el.closest(CARRY);
  const subset = (ws, cw, ct) => [...ws].every((w) => cw.has(w) || (CJK.test(w) && w.length >= 2 && ct.includes(w)));
  // An inline run inside a sentence (<strong>, <em>, a span in a paragraph) is part of that sentence, not a line of its own.
  const inProse = (el) => {
    let b = el;
    while (b.parentElement && b !== document.body && /^inline/.test(cs(b).display)) b = b.parentElement;
    return b !== el && words(norm(b.textContent)).length > 8;
  };
  for (const x of painted) {
    if (listed.has(x.el) || x.el.matches(HEAD) || x.el.closest(KEEP) || inSet(x.el) || !substance(x.t) || inProse(x.el)) continue;
    const xw = setOf(x);
    if (!xw.size || xw.size > 6) continue;
    const c = painted.find((y) => y !== x && !y.el.contains(x.el) && !x.el.contains(y.el) && y.sect === x.sect && oneView(x.box, y.box) && carrier(y) && subset(xw, setOf(y), y.t));
    if (!c) continue;
    listed.add(x.el);
    // Two elements saying exactly the same thing echo each other: list the pair once, not once per direction.
    if (c.t === x.t) listed.add(c.el);
    add("advisory", "echoLabel", `${sel(x.el)}|${sel(c.el)}`, `"${x.el.textContent.trim().slice(0, 30)}" repeats ${sel(c.el)} "${c.el.textContent.trim().slice(0, 30)}"`);
  }

  // repeatedText: the same string painted twice. Not repetition: navigation and in-page links, tab and menu labels, table
  // and control labels, running headers and footers (chrome repeats by design), a copy stacked on another (layered type
  // reads as one string), and equal items, where a status word or tag on every row is the pattern.
  const navish = (el) => el.closest('nav,[role="navigation"],[role="tablist"],[role="tab"],[role="menu"],[role="menuitem"],[role="option"],a[href^="#"],button,summary,label,option,select,td,th,header,footer,[role="banner"],[role="contentinfo"]');
  const counts = new Map();
  for (const x of painted) if (x.t.length >= 4 && substance(x.t)) counts.set(x.t, (counts.get(x.t) || []).concat(x));
  // Copies in one component slot (same tag and class, same kind of parent) are one component repeated — a byline on each
  // card, a status tag on each row, a counter in each corner — so each slot counts once. Two slots saying it is the hit.
  const slot = (el) => `${sel(el)}|${el.parentElement ? sel(el.parentElement) : ""}`;
  for (const [t, xs] of counts) {
    const rest = new Map();
    for (const x of xs) {
      if (navish(x.el) || listed.has(x.el) || inSet(x.el) || [...rest.values()].some((y) => stacked(x.box, y.box))) continue;
      if (!rest.has(slot(x.el))) rest.set(slot(x.el), x);
    }
    const at = [...rest.values()];
    if (at.length > 1) add("advisory", "repeatedText", t.slice(0, 40), `x${at.length} "${t.slice(0, 40)}" at y=${at.map((x) => Math.round(x.box.top + window.scrollY)).join(",")}`);
  }

  // Suppression report: every marker this audit still honours, so silencing shows up in the report instead of hiding in the
  // HTML. The echo family above ignores aria-hidden and data-audit-skip; the rest of the audit does not.
  const supp = {};
  for (const [k, q] of [["ariaHidden", '[aria-hidden="true"]'], ["auditSkip", "[data-audit-skip]"], ["fullBleed", "[data-full-bleed]"], ["readingSurface", 'article,[role="article"],[data-reading]']]) {
    const els = [...document.querySelectorAll(q)].filter((el) => !el.parentElement?.closest(q) && (el.textContent.trim() || el.querySelector("img,svg,video,canvas,picture")));
    if (els.length) supp[k] = { count: els.length, at: els.slice(0, 5).map((el) => label(el)) };
  }
  if (Object.keys(supp).length) out.suppressed = supp;

  // Advisory: numeric table columns right-aligned with tabular figures.
  const NUM = /^[-+−±]?[$€¥£]?\s?\d[\d,.\s]*\s?(%|[kKmMbB万亿元x×]|pts?|ms|s)?$/;
  const cols = new Set();
  for (const td of document.querySelectorAll("td")) {
    if (!shown(td) || !NUM.test(td.textContent.trim())) continue;
    const s = cs(td), table = td.closest("table"), key = `${table ? sel(table) : "table"} col ${td.cellIndex + 1}`;
    const tab = /tabular-nums/.test(s.fontVariantNumeric) || /tnum/.test(s.fontFeatureSettings);
    if ((!/right|end/.test(s.textAlign) || !tab) && !cols.has(key)) { cols.add(key); add("advisory", "tableNumbers", key, `${tab ? "" : "no tabular-nums "}${/right|end/.test(s.textAlign) ? "" : "align " + s.textAlign + " "}${key}`); }
  }

  // Advisory: blocks stacked in one column whose content starts at different x (primary blocks share one left edge).
  const minL = new Map(), maxR = new Map();
  for (const t of texts) for (let e = t.el; e && e !== document.documentElement; e = e.parentElement) {
    minL.set(e, Math.min(minL.get(e) ?? Infinity, t.box.left)); maxR.set(e, Math.max(maxR.get(e) ?? -Infinity, t.box.right));
  }
  for (const el of all) {
    const s = cs(el);
    if ((/flex|grid/.test(s.display) && !(s.display.includes("flex") && s.flexDirection.startsWith("column"))) || el.closest("[data-audit-skip]")) continue;
    const r = el.getBoundingClientRect(), pl = r.left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth), pr = r.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth);
    const kids = [...el.children].filter((k) => { const kr = k.getBoundingClientRect(), ks = cs(k); return shown(k) && minL.has(k) && kr.height >= 64 && kr.width >= (pr - pl) * 0.6 && !/absolute|fixed/.test(ks.position) && ks.float === "none" && !/^(UL|OL|DL|BLOCKQUOTE|PRE|FIGURE|TABLE|NAV|ASIDE)$/.test(k.tagName); });
    if (kids.length < 3 || kids.some((k, i) => i && k.getBoundingClientRect().top < kids[i - 1].getBoundingClientRect().bottom - 2)) continue;
    const lefts = kids.filter((k) => { const a = minL.get(k) - pl, b = pr - maxR.get(k); return cs(k).textAlign !== "center" && !(a > 8 && Math.abs(a - b) < 4); }).map((k) => [Math.round(minL.get(k)), k]);
    const xs = [...new Set(lefts.map((l) => l[0]))].sort((a, b) => a - b).filter((x, i, a) => !i || x - a[i - 1] > 3);
    if (xs.length > 1 && xs[xs.length - 1] - xs[0] < (pr - pl) * 0.4) { const odd = lefts.find((l) => Math.abs(l[0] - xs[0]) > 3 && Math.abs(l[0] - xs[xs.length - 1]) > 3) || lefts.find((l) => l[0] === xs[xs.length - 1]); add("advisory", "leftEdge", sel(el), `content starts at x=${xs.join("/")} in one column: ${label(odd[1])}`); }
  }

  // Advisory: long pages need a way to reach their sections; existing section navigation should mark the section in view.
  // A fragment may hold a literal % ("#100%-growth"), which decodeURIComponent rejects: fall back to the raw id.
  const frag = (href) => { const id = href.slice(1); try { return decodeURIComponent(id); } catch { return id; } };
  const links = [...document.querySelectorAll('a[href^="#"]')].filter((a) => { const id = frag(a.getAttribute("href")); return id && shown(a) && document.getElementById(id); });
  const targets = [...new Set(links.map((a) => a.getAttribute("href")))];
  const pageH = document.documentElement.scrollHeight;
  // App and board surfaces (kanban columns, dashboards, app shells) are operated, not read through: no section links expected.
  // Signals: an application or grid role; 2+ columns of draggable (draggable, cursor grab) items or 3+ side-by-side titled columns of
  // stacked item boxes (a short column title such as "To do (3)" above the first item; quotes and figures are not items); or a
  // full-height side rail plus a toolbar (2+ controls in the first 200px). Repeated logos, cards or a testimonial wall are not a board.
  const stacks = new Map();
  for (const el of all) { const d = el.getAttribute("draggable") === "true" || /^(grab|move)$/.test(cs(el).cursor); if ((d || (boxy(el) && el.getBoundingClientRect().height >= 40)) && el.parentElement) { const k = el.parentElement, v = stacks.get(k) || { n: 0, d: 0, tops: new Set(), items: [] }; v.n++; v.d += d; v.items.push(el); v.tops.add(Math.round(el.getBoundingClientRect().top)); stacks.set(k, v); } }
  const titled = (k, v) => { const h = k.firstElementChild, t = (h?.textContent || "").trim(); return !!h && !v.items.includes(h) && shown(h) && t.length > 0 && t.length <= 40 && h.getBoundingClientRect().bottom <= v.items[0].getBoundingClientRect().top + 1 && !v.items.some((i) => i.matches("blockquote,figure,q") || i.querySelector("blockquote,q")); };
  const lanes = [...stacks].filter(([, v]) => v.n >= 2 && v.tops.size === v.n).map(([k, v]) => [k.getBoundingClientRect(), v.d >= 2, titled(k, v)]);
  const titledLanes = lanes.filter(([, , t]) => t);
  const columns = lanes.filter(([, d]) => d).length >= 2 || titledLanes.some(([r]) => titledLanes.filter(([q]) => Math.abs(q.top - r.top) < 80 && (q.right <= r.left || q.left >= r.right || q === r)).length >= 3);
  const rail = all.some((el) => { const r = el.getBoundingClientRect(); return /^(ASIDE|NAV)$/.test(el.tagName) && (r.left <= 1 || r.right >= vw - 1) && r.width <= vw * 0.4 && r.height >= Math.min(pageH, vh * 3) * 0.9; });
  const toolbar = !!document.querySelector('[role="toolbar"]') || [...document.querySelectorAll("button,input,select,[role=button]")].filter((c) => shown(c) && absY(c.getBoundingClientRect()) < 200 && !c.closest("aside,nav")).length >= 2;
  const app = !!document.querySelector('[role="application"],[role="grid"]') || columns, board = app || (rail && toolbar);
  if (!isDeck && !canvas && !board && pageH > vh * 3 && targets.length < 3) add("advisory", "noSectionNav", "page", `${(pageH / vh).toFixed(1)} screens tall with no section links (${targets.length} in-page targets)`);
  if (!isDeck && targets.length >= 3 && pageH > vh * 2.5) {
    const sig = (a) => { const s = cs(a); return [a.className, a.getAttribute("aria-current"), s.color, s.fontWeight, s.backgroundColor, s.borderBottomColor, s.textDecorationLine, s.opacity].join("|"); };
    const goal = targets[Math.max(1, targets.length - 2)], goalLinks = links.filter((a) => a.getAttribute("href") === goal), before = goalLinks.map(sig);
    document.getElementById(frag(goal))?.scrollIntoView({ behavior: "instant", block: "start" });
    window.scrollBy(0, 40);
    await new Promise((r) => setTimeout(r, 700));
    const inView = goalLinks.some((a) => { const r = a.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; });
    if (inView && !goalLinks.some((a, i) => a.getAttribute("aria-current") || sig(a) !== before[i])) add("advisory", "navCurrent", goal, `link to ${goal} unchanged when its section is in view`);
  }

  // Advisory: text walls outside reading surfaces (article, [role=article], .prose, [data-reading]; quotes, code, footers, tables,
  // controls, dialogs and alerts exempt). Size = Latin words + CJK characters / 2. A block over 60, a run of plain sibling blocks
  // over 120, or over 100 in prose blocks (12+) in the first screen. Folded content (closed details, hidden panels) is not counted.
  const READ = 'article,[role="article"],.prose,.markdown-body,[data-reading],blockquote,pre,code,figcaption,footer,small,dialog,[role="dialog"],[role="alert"],[role="tooltip"],td,th,label,button,nav,[data-audit-skip]';
  const CJKG = /[぀-ヿ㐀-鿿가-힯]/g, size = (t) => (t.replace(CJKG, " ").match(/[\p{L}\p{N}]+/gu) || []).length + (t.match(CJKG) || []).length / 2;
  const blocks = new Map();
  for (const el of owners) {
    let b = el;
    while (b.parentElement && b !== document.body && /^inline/.test(cs(b).display)) b = b.parentElement;
    if (b !== document.body && !(b instanceof SVGElement) && !b.closest(READ) && !blocks.has(b)) blocks.set(b, 0);
  }
  const containers = new Set();
  for (const b of blocks.keys()) for (let e = b.parentElement; e; e = e.parentElement) containers.add(e);
  for (const b of [...blocks.keys()]) containers.has(b) ? blocks.delete(b) : blocks.set(b, size(texts.filter((t) => b.contains(t.el)).map((t) => t.n.data).join(" ")));
  let firstView = 0;
  for (const [b, n] of blocks) {
    if (n > 60) add("advisory", "textWall", sel(b), `${Math.round(n)} words in one block ${label(b)}`);
    const r = b.getBoundingClientRect();
    if (n >= 12 && absY(r) < vh && (!canvas || isDeck)) firstView += n;
  }
  for (const p of new Set([...blocks.keys()].map((b) => b.parentElement))) {
    let run = [], n = 0;
    for (const k of [...p.children, null]) {
      if (k && blocks.get(k) >= 12 && shown(k)) { run.push(k); n += blocks.get(k); continue; }
      if (run.length > 1 && n > 120) add("advisory", "textWall", `${sel(p)}|run`, `${run.length} plain blocks, ${Math.round(n)} words with no heading, list, table or control between ${label(run[0])}`);
      run = []; n = 0;
    }
  }
  if (firstView > 100) add("advisory", "denseFirstView", "page", `${Math.round(firstView)} words of prose in the first screen`);

  // Motion (references/motion.md). Transitions by computed style: `all` and layout properties are advisory (unintended motion and
  // jank, not a rule-layer defect); UI controls over 300 ms are must-fix on an Operate surface, where motion must not make the user wait.
  // Keyframes in use: layout properties, and moving keyframes with no prefers-reduced-motion rule anywhere, are advisory.
  // Infinite animations: more than one marquee (a translating strip wider than its box), a loop whose last frame differs from its
  // first (not alternate, not a marquee) and a large moving loop with no pause control are advisory. How motion is drawn (easing,
  // entry scale, origin) is the designer's call and is not checked. reducedMotion (audit.mjs) re-runs the page under
  // prefers-reduced-motion: reduce.
  const list = (v) => v.split(/,(?![^(]*\))/).map((x) => x.trim());
  const secs = (v) => (/ms$/.test(v) ? parseFloat(v) / 1000 : parseFloat(v));
  const LAYOUT = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset|margin|padding|grid-template|flex-basis)/;
  const MOVE = /^(transform|translate|rotate|scale|left|top|right|bottom|offset|background-position|backgroundPosition|margin)/;
  const COLOR = /(^|-)(color|fill|stroke|text-decoration|text-shadow)/;
  const CTL = 'a[href],button,input,select,textarea,summary,[role="button"],[role="tab"],[role="switch"],[role="menuitem"],[role="option"]';
  const slow = [], once = new Set(), hit = (bucket, key, s, msg) => { if (!once.has(key + s)) { once.add(key + s); add(bucket, key, s, msg); } };
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("[data-audit-skip]")) continue;
    const s = cs(el), props = list(s.transitionProperty), durs = list(s.transitionDuration).map(secs);
    props.forEach((p, i) => {
      const d = durs[i % durs.length];
      if (!(d > 0) || p === "none") return;
      if (p === "all") hit("advisory", "transitionAll", sel(el), `transition: all ${d}s ${label(el)}`);
      else if (LAYOUT.test(p)) hit("advisory", "layoutAnimation", `${sel(el)}|${p}`, `transition ${p} ${label(el)}`);
      if (d > 0.3 && p !== "visibility" && el.matches(CTL)) { const k = sel(el), j = slow.findIndex((x) => x[0] === k), m = !COLOR.test(p); if (j < 0) slow.push([k, `${p} ${Math.round(d * 1000)}ms ${label(el)}`, m]); else if (m && !slow[j][2]) slow[j] = [k, `${p} ${Math.round(d * 1000)}ms ${label(el)}`, m]; }
    });
  }
  // slowTransition is must-fix on an Operate surface (app UI): window.__designAuditSurface = "operate" (audit.mjs --surface operate), or, when
  // no surface is given, an inferred app (application or grid role, board columns; a side rail plus a toolbar is not enough, docs have
  // both). Color fades (links, hover tints) and other surfaces (Read, Persuade, decks, canvases): advisory.
  const surface = window.__designAuditSurface, operate = surface ? surface === "operate" : app && !isDeck && !canvas;
  for (const [s, m, moves] of slow) add(operate && moves ? "mustFix" : "advisory", "slowTransition", s, m);
  const frames = new Map();
  let reduceRule = [...document.scripts].some((sc) => /prefers-reduced-motion/.test(sc.textContent));
  const walk = (rules) => { for (const r of rules) {
    if (r.type === CSSRule.KEYFRAMES_RULE) frames.set(r.name, r);
    if (r.conditionText && /prefers-reduced-motion/.test(r.conditionText)) reduceRule = true;
    if (r.cssRules) walk(r.cssRules);
  } };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch {} }
  let moving = false;
  for (const name of new Set([...document.body.querySelectorAll("*")].flatMap((el) => list(cs(el).animationName)).filter((n) => n !== "none"))) {
    const r = frames.get(name);
    if (!r) continue;
    for (const k of r.cssRules) {
      const ps = [...k.style];
      const lay = ps.find((p) => LAYOUT.test(p));
      if (lay) hit("advisory", "layoutAnimation", `${name}|${lay}`, `@keyframes ${name} animates ${lay}`);
      if (ps.some((p) => MOVE.test(p))) moving = true;
    }
  }
  if (moving && !reduceRule) hit("advisory", "noReducedMotion", "page", "moving @keyframes and no prefers-reduced-motion rule in CSS or scripts");
  const loops = document.getAnimations().filter((a) => a.effect?.target && a.effect.getComputedTiming().iterations === Infinity);
  const strips = new Set(document.querySelectorAll("marquee")), seams = [];
  for (const a of loops) {
    const el = a.effect.target, pseudo = a.effect.pseudoElement || null, kf = a.effect.getKeyframes();
    const r = el.getBoundingClientRect(), box = el.parentElement?.getBoundingClientRect();
    if (kf.some((k) => /translate|matrix/.test(k.transform || "") || k.translate) && box && (r.width > box.width * 1.3 || r.width > vw)) { strips.add(el); continue; }
    const t = a.effect.getComputedTiming(), dir = a.effect.getTiming().direction;
    if (/alternate/.test(dir) || !(t.duration > 0)) continue;
    const snap = () => { const s = cs(el, pseudo), m = new DOMMatrix(s.transform === "none" ? "" : s.transform); return [m.a, m.b, m.c, m.d, m.e / 100, m.f / 100, +s.opacity, (parseFloat(s.rotate) || 0) % 360 / 360, ...rgba(s.color).slice(0, 3).map((c) => c / 255), ...rgba(s.backgroundColor).slice(0, 3).map((c) => c / 255)]; };
    const was = a.playState, at = a.currentTime, delay = a.effect.getTiming().delay || 0;
    try {
      a.pause(); a.currentTime = delay; const s0 = snap(); a.currentTime = delay + t.duration - 1; const s1 = snap();
      if (s0.some((v, i) => Math.abs(v - s1[i]) > 0.03 && Math.abs(Math.abs(v - s1[i]) - 1) > 0.03 * (i === 7))) seams.push(el);
    } catch {} finally { a.currentTime = at ?? 0; if (was === "running") a.play(); }
  }
  if (strips.size > 1) add("advisory", "marquee", "page", `${strips.size} marquees: ${[...strips].slice(0, 3).map((e) => sel(e)).join(", ")}`);
  for (const el of new Set(seams)) hit("advisory", "loopSeam", sel(el), `loop ends on a different frame than it starts ${label(el)}`);
  const big = loops.find((a) => { const r = a.effect.target.getBoundingClientRect(); return r.width * r.height >= vw * vh * 0.1 && a.effect.getKeyframes().some((k) => Object.keys(k).some((p) => MOVE.test(p))); });
  const pause = [...document.querySelectorAll('button,[role="button"],input[type="checkbox"]')].some((b) => /pause|stop|暂停|停止/i.test(`${b.textContent} ${b.getAttribute("aria-label") || ""} ${b.title}`));
  if (big && !pause) hit("advisory", "noPauseControl", sel(big.effect.target), `large moving loop over 5 s with no pause control ${label(big.effect.target)}`);

  // Contrast: composite the layers actually under the text (elementsFromPoint), so positioned overlays count.
  // Images, gradients, media and positioned pseudo-element layers make it unverifiable (counted, checked on the screenshot).
  const ancestorBg = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = cs(e);
      if (s.backgroundImage !== "none") return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    return layers;
  };
  const pseudoLayer = (e) => ["::before", "::after"].some((p) => { const s = cs(e, p); return s.content !== "none" && /absolute|fixed/.test(s.position) && (s.backgroundImage !== "none" || rgba(s.backgroundColor)[3] > 0); });
  const stackBg = (el, x, y) => {
    const stack = document.elementsFromPoint(x, y), i = stack.indexOf(el);
    if (i < 0) return undefined;
    const layers = [];
    for (const e of stack.slice(i)) {
      const anc = e.contains(el), s = cs(e);
      if (!anc && e instanceof SVGTextContentElement) continue;
      if (!anc && e instanceof SVGElement && e.tagName.toLowerCase() !== "svg") {
        if (/^url|none/.test(s.fill)) return null;
        const f = rgba(s.fill), a = f[3] * +s.fillOpacity * +s.opacity;
        layers.push([f[0], f[1], f[2], a]);
        if (a >= 1) break;
        continue;
      }
      if (!anc && /^(IMG|VIDEO|CANVAS|IFRAME|PICTURE|OBJECT|EMBED)$/.test(e.tagName)) return null;
      if (s.backgroundImage !== "none" || pseudoLayer(e)) return null;
      const c = rgba(s.backgroundColor), a = c[3] * (anc ? 1 : +s.opacity);
      if (a > 0) layers.push([c[0], c[1], c[2], a]);
      if (a >= 1) break;
    }
    return layers;
  };
  const byY = owners.map((el) => [el, absY(el.getBoundingClientRect())]).sort((a, b) => a[1] - b[1]);
  // Hit testing skips pointer-events:none layers that still paint; count them during the contrast pass.
  const pe = document.createElement("style");
  pe.textContent = "*,*::before,*::after{pointer-events:auto!important}";
  document.head.append(pe);
  for (const [el] of byY) {
    const text = el.textContent.trim();
    if (EMOJI.test(text) || el.closest(':disabled,[aria-disabled="true"],[aria-hidden="true"]')) continue;
    const s = cs(el), isSvg = el instanceof SVGElement, fs = parseFloat(s.fontSize) * (isSvg ? scaleOf(el) : 1);
    const range = document.createRange(); range.selectNodeContents(own.get(el)[0].n);
    let r = range.getClientRects()[0];
    if (!r) continue;
    if (r.top < 0 || r.bottom > vh) { window.scrollTo(0, absY(r) - vh / 3); r = range.getClientRects()[0]; }
    // Sample the start and the middle of the first line; the better surface counts (organic shapes, partial overlays).
    const y = r.top + r.height / 2, fg = rgba(isSvg && s.fill && s.fill !== "none" && !s.fill.startsWith("url") ? s.fill : s.color), fa = fg[3] * opacityOf(el);
    const surfaces = [r.left + Math.min(r.width / 2, 4), r.left + r.width / 2].map((x) => (x >= 0 && x < vw && y >= 0 && y < vh ? stackBg(el, x, y) : undefined));
    const found = surfaces.filter((l) => l !== undefined), all_ = found.length ? found : [ancestorBg(el)];
    if (all_.some((l) => !l)) { out.unverifiedContrast++; continue; }
    const c = Math.max(...all_.map((layers) => { const bg = layers.reduceRight((acc, c) => over(c, acc), [255, 255, 255, 1]); return ratio(over([fg[0], fg[1], fg[2], fa], bg), bg); }));
    const large = fs >= 24 || (fs >= 18.66 && +s.fontWeight >= 700);
    if (c < (large ? 3 : 4.5)) add("mustFix", "lowContrast", `${sel(el)}${core(el, text, fs)}`, `${c.toFixed(2)}:1 ${Math.round(fs)}px ${label(el)}`, +c.toFixed(2));
  }
  // Placeholder text of empty enabled fields, against the field's own surface.
  for (const el of document.querySelectorAll("input[placeholder],textarea[placeholder]")) {
    if (!el.placeholder.trim() || el.value || el.disabled || !shown(el)) continue;
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > vh) { window.scrollTo(0, absY(r) - vh / 3); r = el.getBoundingClientRect(); }
    const x = r.left + Math.min(r.width / 2, 8), y = r.top + r.height / 2;
    const layers = x >= 0 && x < vw && y >= 0 && y < vh ? stackBg(el, x, y) : ancestorBg(el);
    if (!layers) { out.unverifiedContrast++; continue; }
    const bg = layers.reduceRight((acc, c) => over(c, acc), [255, 255, 255, 1]), ps = cs(el, "::placeholder"), fg = rgba(ps.color);
    const c = ratio(over([fg[0], fg[1], fg[2], fg[3] * +ps.opacity * opacityOf(el)], bg), bg);
    if (c < 4.5) add("mustFix", "lowContrast", `${sel(el)}|placeholder|core`, `${c.toFixed(2)}:1 placeholder "${el.placeholder.slice(0, 28)}" ${label(el, r)}`, +c.toFixed(2));
  }
  pe.remove();
  window.scrollTo(0, y0);

  const full = window.__designAuditFull;
  for (const b of ["mustFix", "advisory"]) for (const k in out[b]) {
    const items = out[b][k], sigs = {};
    for (const [s] of items) sigs[s] = (sigs[s] || 0) + 1;
    out[b][k] = { count: items.length, samples: items.slice(0, 5).map((i) => i[1]), sigs, ...(full ? { items } : {}) };
  }
  return out;
})()
