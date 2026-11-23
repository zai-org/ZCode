#!/usr/bin/env node
// Usage: node audit.mjs <file.html|url> [widths] [--baseline <file.html|url>] [--project] [--surface operate|persuade|read|experience] [--all] [--json]
// --surface: create's surface mode; slowTransition on controls (not color fades) is must-fix on operate (inferred from app or board
// signals when omitted), else advisory. An unknown value warns and falls back to inference.
// Renders the page in headless Chromium via Playwright at each width (default 1440,390), evaluates audit-page.js
// and prints must-fix defects and advisory notes. Decks are audited slide by slide at 1920x1080; fixed canvases
// (posters, invoices, infinite canvas) once at their own size (capped at 4000 px), against their own bounds.
// --baseline: a skeleton (example.html, a template or anything under design-resources) or the page before a redesign; never the audited page
// itself, which would inherit every hit (passing it is a warning and the baseline is dropped).
// Skeleton baseline: text size, contrast and leading signatures it has are inherited whatever their count; other keys and
// redesign baselines inherit up to the baseline's count per signature. Contrast that got worse than the baseline's is new.
// Inheritance has a floor: too-small or low-contrast running copy and control labels, and horizontal overflow at phone widths,
// stay must-fix however the baseline renders them, so a skeleton's unreadable body text is not shipped as inherited.
// The echo family (decorativeEcho, echoLabel, repeatedText) prints as a numbered echo worklist, in full at every width, and
// every suppression marker the audit honours (aria-hidden, data-audit-skip, data-full-bleed, reading surfaces) is counted and
// named, so silencing is visible; nothing the model marks itself takes an item off the worklist.
// External resources and console errors inherit only when the target is the user's real project (an http(s) URL, or --project)
// against a redesign baseline: its own CDN, fonts, APIs and framework warnings are reported, not fixed. Standalone HTML
// deliverables and skeleton baselines never inherit them. --all prints every hit: inherited ones and every advisory location.
// The must-fix total counts findings, not viewport passes: a defect both viewports show is one finding and drops the total by
// one when fixed; per-viewport counts are printed beside it. Screenshots land in a tmpdir the model reads after the run, so a
// run clears earlier ones instead (directories from the last day are kept, newest 100 at most).
// Infinite animations are paused at 0 and page timers stopped first. The first width also loads the page under
// prefers-reduced-motion: reduce and reports loops still running (reducedMotion) and script-driven movement (advisory).
// Decks also get deckPaging (→ changes nothing), deckPrint (no or portrait print styles) and notesOnScreen, never inherited.
// Text output ends with next: steps (look, operate with probe.js, deck paging and print), so the procedure is read when it applies.
// Exit 2 with "audit not run" when no Playwright or Chromium is found, or when the run itself failed (a load that never
// finishes, a document the audit cannot walk); exit 1 on a bad argument. Findings exit 0: they are the report, not a failure.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const HINTS = {
  smallText: "raise to >=12px (>=14px for running text); captions and chart ticks included",
  smallLabel: "11px eyebrow or label: fine if it stays legible, otherwise 12px",
  lowContrast: "darken or tint the text from its surface hue until 4.5:1 (3:1 for large text)",
  tightLeading: "multi-line text under 18px: line-height >=1.35 (>=1.5 CJK); 18-20px: >=1.25",
  truncated: "give the text room or wrap it; truncate only with the full value reachable",
  textCollision: "move, rotate, thin out or drop overlapping labels; do not overlay copy",
  cjkBreak: "avoid break-all and lines starting with closing punctuation",
  edge: "media running the full viewport width is full-bleed and already fine (one-edge bleed: mark it data-full-bleed); everything else keeps >=16px (mobile) / >=24px (desktop) from the named edge. Never pad a hero image to make this go away",
  canvasBounds: "keep text, controls and media inside the canvas or slide",
  horizontalOverflow: "find the element wider than the viewport and constrain it",
  externalResource: "inline CSS and JS and ship assets beside the HTML; fonts use system stacks (CJK included) or data: embedding; fetch data and media with your tools and write them into files, never call services from the page",
  localPath: "reference assets beside the HTML or in a subdirectory: no ../, absolute or file:// paths; for a single file or offline use embed them as data:",
  brokenImage: "the image did not load: fix the path or ship the file",
  noZoom: "remove user-scalable=no and maximum-scale=1: the page must stay zoomable",
  smallTarget: "touch target under 24x24 px on a phone width: enlarge it or its hit area",
  headingSkip: "heading levels go in order without skipping a level",
  deckPaging: "← / → and Space each move one slide, leaving keys alone when defaultPrevented or when focus is in a form field or editable content. Not a deck? Then do not mark screens with data-slide or data-screen-label",
  deckPrint: "add landscape @page and @media print styles that print one slide per page with nothing clipped",
  notesOnScreen: "speaker notes stay off screen: hide aside.notes or keep notes in data-speaker-notes",
  consoleError: "fix the script error",
  stretchedBox: "box much taller than its content: align-items:start or real content",
  loneItem: "lone box beside a void: rebalance if it is not deliberate",
  manyPeers: "many peers in one band: fine for equal items, otherwise group or rank",
  repeatedText: "same string painted twice outside navigation and chrome: keep both only if each does a job",
  echoLabel: "a line whose words a heading, control label or chart label nearby already says: drop it or make it say something new",
  decorativeEcho: "a decoration repeating what the view already says adds no information: drop it, or give that space something only it can say; marking it aria-hidden does not make it free",
  tableNumbers: "numeric column: right-aligned tabular-nums usually reads better",
  cjkOrphan: "short last line in a CJK heading: rebalance width or wording",
  navCurrent: "section navigation exists but does not mark the section in view",
  noSectionNav: "long page: offer section links or a table of contents that stays reachable",
  leftEdge: "primary blocks in one column share one left content edge",
  invisibleText: "text left at opacity 0: a reveal that never fired hides it; show it without depending on scroll or timing",
  textWall: "outside reading surfaces: cut it, fold detail (tabs, details, drawer, detail view) or turn it into structure (table, steps, list, chart, badges); keep critical text in view; mark real reading surfaces <article>",
  denseFirstView: "first screen reads as prose: keep what must be seen first, fold or move the rest, let layout carry the structure",
  transitionAll: "name the properties (transform, opacity, color); `all` animates layout and anything changed later",
  slowTransition: "on an Operate surface (app UI) a transition should not make the user wait on the control (over 300 ms here); must-fix there, advisory for color fades, reading pages, Persuade pages and decks",
  reducedMotion: "under prefers-reduced-motion: reduce, stop decorative loops and keep the state change visible without movement; progress indicators keep running (mark them role=status or progressbar)",
  reducedMotionScript: "a script keeps moving this under reduced motion: check matchMedia('(prefers-reduced-motion: reduce)') and stop it",
  layoutAnimation: "animate transform or opacity instead of layout properties; an expanding row may animate its height once",
  noReducedMotion: "add @media (prefers-reduced-motion: reduce) that stops loops and keeps every state change visible without movement",
  marquee: "keep at most one marquee",
  loopSeam: "a loop's last frame should equal its first, or it jumps each cycle; fine if the jump is the design",
  noPauseControl: "motion over 5 s that starts by itself needs a pause or stop control (WCAG 2.2.2)",
};

const NEVER_INHERITED = new Set(["externalResource", "consoleError"]);
// Inheritance is a floor with exceptions: a hit whose signature ends in "core" is the deliverable's whatever the baseline has.
// audit-page.js marks text size and contrast on running copy and on control labels, and horizontal overflow at phone widths.
const CORE = /\|core$/;
const DECK = ["deckPaging", "deckPrint", "notesOnScreen"];
// The echo family: one view saying the same thing twice. Printed as a numbered worklist, because "I looked and it is fine"
// satisfies an unbounded self-sweep and does not satisfy a disposition per item.
const ECHO = ["decorativeEcho", "echoLabel", "repeatedText"];
const SUPPRESSION = { ariaHidden: 'aria-hidden="true"', auditSkip: "data-audit-skip", fullBleed: "data-full-bleed", readingSurface: "reading surface" };
const STYLE = new Set(["smallText", "lowContrast", "tightLeading"]);
const where = (m) => m.replace(/ @-?\d+,-?\d+/g, "").replace(/^[\d.]+(:1|px)? /, "");

// Baseline hits per signature: { n, ratio (worst contrast), at (messages without position) }.
export function summarize(hits) {
  const base = {};
  for (const list of Object.values(hits)) for (const [sig, msg, v] of list) {
    const b = (base[sig] ||= { n: 0, at: [] });
    b.n++; b.at.push(where(msg));
    if (v !== undefined) b.ratio = Math.min(b.ratio ?? Infinity, v);
  }
  return base;
}

// Split hits into new ones and inherited ones (inherited: counts, items: their messages). Per signature up to the baseline's count is
// inherited, hits at the baseline's own content first, so samples point at what changed; with a skeleton baseline, style
// signatures it has are inherited whatever the count. Contrast more than 0.1 below the baseline's worst is new.
// Signatures marked core (readable copy, control labels, phone-width overflow) and external resources and console errors never
// inherit; the latter two only when project is set (a real project against a redesign baseline).
export function classify(hits, base = {}, skeleton = false, project = false) {
  const own = {}, inherited = {}, items = {}, used = {};
  for (const [key, list] of Object.entries(hits)) {
    const ok = list.map(([sig, msg, v]) => { const b = base[sig]; return !!b && !CORE.test(sig) && (!NEVER_INHERITED.has(key) || (project && !skeleton)) && !(v !== undefined && b.ratio !== undefined && v < b.ratio - 0.1); });
    const take = list.map(() => false);
    for (const pass of [0, 1]) list.forEach(([sig, msg], i) => {
      if (!ok[i] || take[i] || (pass === 0 && !base[sig].at.includes(where(msg)))) return;
      if ((skeleton && STYLE.has(key)) || (used[sig] || 0) < base[sig].n) { used[sig] = (used[sig] || 0) + 1; take[i] = true; }
    });
    list.forEach(([, msg], i) => { if (take[i]) { inherited[key] = (inherited[key] || 0) + 1; (items[key] ||= []).push(msg); } else (own[key] ||= []).push(msg); });
  }
  return { own, inherited, items };
}

export const isSkeleton = (t) => /(^|[\\/])(example|[^\\/]*template[^\\/]*)\.html$/i.test(t) || /[\\/]design-resources[\\/]/.test(resolve(t));

// Skeleton example the page seems derived from (shared class names), for the --baseline hint.
export function guessSkeleton(file) {
  const root = join(here, "..", "design-resources", "design-skeletons"), classes = (t) => new Set([...t.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  let mine, best = [0];
  try { mine = classes(readFileSync(file, "utf8")); } catch { return; }
  if (mine.size < 8 || !existsSync(root)) return;
  const canvas = join(here, "..", "design-resources", "skills", "infinite-canvas", "assets", "infinite-canvas-template.html");
  for (const ex of [canvas, ...readdirSync(root).map((d) => join(root, d, "example.html"))]) {
    if (!existsSync(ex) || resolve(ex) === resolve(file)) continue;
    const theirs = classes(readFileSync(ex, "utf8")), both = [...mine].filter((c) => theirs.has(c)).length, score = both / (mine.size + theirs.size - both);
    if (score > best[0]) best = [score, ex];
  }
  return best[0] >= 0.4 ? best[1] : undefined;
}

const SLIDE = ".slide,[data-slide],[data-screen-label],[data-slide-index],.reveal .slides>section,.swiper-slide";
// In the page: top-level slides by selector, else 2+ same-size stacked or scroll-snapped siblings shaped like slides.
// Class-only slides (.slide, .swiper-slide) count only when one is roughly viewport-sized, so carousels stay pages.
function findSlides(SLIDE) {
  let slides = [...document.querySelectorAll(SLIDE)].filter((s) => !s.parentElement?.closest(SLIDE));
  const big = (s) => s.offsetWidth >= innerWidth * 0.85 && s.offsetHeight >= innerHeight * 0.7;
  if (slides.length > 1 && slides.every((s) => s.matches(".slide,.swiper-slide")) && !slides.some(big)) slides = [];
  if (slides.length > 1) return slides;
  for (const p of document.querySelectorAll("body,body *")) {
    const kids = [...p.children].filter((k) => k.offsetWidth >= 600 && k.offsetHeight > 0 && Math.abs(k.offsetWidth / k.offsetHeight - 1.6) < 0.45);
    if (kids.length < 2 || kids.length < p.children.length * 0.6 || kids.some((k) => k.offsetWidth !== kids[0].offsetWidth || k.offsetHeight !== kids[0].offsetHeight)) continue;
    const stacked = kids.every((k) => k.offsetTop === kids[0].offsetTop && k.offsetLeft === kids[0].offsetLeft), snap = getComputedStyle(p).scrollSnapType !== "none";
    if (stacked || snap) return kids;
  }
  return [];
}

// Fixed canvas: a top-level box that keeps its width at 2560 and at 390 (flex shrinking switched off, so a centred poster
// counts and a responsive min(1280px, 100%) stage does not), holds most of the page's text and has a fixed height
// (extra content does not grow it, unlike a max-width page column).
async function findCanvas(page, size) {
  const probe = (noShrink) => {
    const st = document.createElement("style");
    if (noShrink) { st.textContent = "body>*,body>*>*{flex-shrink:0!important}"; document.head.append(st); }
    const r = [...document.querySelectorAll("body,body>*,body>*>*")].map((e) => [e.offsetWidth || 0, e.offsetHeight || 0]);
    st.remove();
    return r;
  };
  const a = await page.evaluate(probe), at = [];
  for (const [width, noShrink] of [[2560, false], [390, true]]) {
    await page.setViewportSize({ width, height: size.height });
    await page.waitForTimeout(200);
    at.push(await page.evaluate(probe, noShrink));
  }
  await page.setViewportSize(size);
  await page.waitForTimeout(200);
  const cands = a.map(([w, h], i) => [w * h, i]).filter(([, i]) => a[i][0] > 390 && at.every((b) => a[i][0] === b[i][0]) && a[i][1] >= 300).sort((x, y) => y[0] - x[0]).map((x) => x[1]);
  return page.evaluate((cands) => {
    const els = [...document.querySelectorAll("body,body>*,body>*>*")], total = document.body.innerText.replace(/\s/g, "").length;
    const e = cands.map((i) => els[i]).find((el) => {
      if (el.innerText.replace(/\s/g, "").length < total * 0.7) return false;
      const h = el.offsetHeight, x = document.createElement("div"); x.style.cssText = "height:400px;flex:none"; el.append(x); const grew = el.offsetHeight !== h; x.remove(); return !grew;
    });
    if (!e) return null;
    e.setAttribute("data-audit-canvas", "");
    const r = e.getBoundingClientRect();
    return { width: e.offsetWidth, height: e.offsetHeight, left: Math.max(0, Math.round(r.left)), top: Math.max(0, Math.round(r.top + scrollY)) };
  }, cands);
}

export function loadPlaywright() {
  const dirs = [process.cwd(), here, ...(process.env.NODE_PATH || "").split(delimiter).filter(Boolean)];
  for (const cmd of ["npm", "pnpm"]) {
    // Windows 上 npm / pnpm 是 .cmd，要经 shell 启动，否则 EINVAL；参数数组配 shell 在 Node 24 会报 DEP0190，
    // 所以 Windows 传整条命令字符串。命令是常量，没有注入面。
    const opts = { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] };
    try { dirs.push((process.platform === "win32" ? execSync(`${cmd} root -g`, opts) : execFileSync(cmd, ["root", "-g"], opts)).trim()); } catch {}
  }
  const home = homedir(), npx = join(home, ".npm", "_npx");
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm", "node_modules"));
  dirs.push(join(home, ".bun", "install", "global", "node_modules"), join(home, ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules",
    ...(existsSync(npx) ? readdirSync(npx).map((d) => join(npx, d, "node_modules")) : []));
  for (const dir of dirs) for (const name of ["playwright", "playwright-core"]) {
    try { return createRequire(join(dir, "noop.js"))(name).chromium; } catch {}
  }
}

export async function launch(chromium) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  const cached = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium")).sort().reverse()
    .flatMap((d) => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"].map((p) => join(cache, d, p))) : [];
  const system = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ...cached].filter((p) => p && existsSync(p));
  for (const opts of [{}, ...system.map((executablePath) => ({ executablePath })), { channel: "chrome" }]) {
    try { return await chromium.launch(opts); } catch {}
  }
}

// Finish one-shot animations, pause infinite ones at 0 and stop page timers and frame loops, so runs are repeatable.
const settle = () => {
  for (const a of document.getAnimations()) { try { if (a.effect?.getTiming().iterations !== Infinity) a.finish(); else { a.pause(); a.currentTime = 0; } } catch {} }
  for (let i = setTimeout(() => {}, 0); i > 0; i--) clearTimeout(i);
  for (let i = requestAnimationFrame(() => {}); i > 0; i--) cancelAnimationFrame(i);
  return document.fonts.ready;
};
// Repeatable runs: Math.random is seeded before any page script, and after load the audit waits until the DOM has been
// quiet for 0.5 s (at most 3 s) so data a page generates on load is in place before timers are stopped.
const seed = () => { let s = 1; Math.random = () => (s = (s * 16807) % 2147483647) / 2147483647; };
const quiet = () => new Promise((res) => {
  let t; const done = () => { mo.disconnect(); clearTimeout(cap); res(); };
  const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 500); });
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  t = setTimeout(done, 500); const cap = setTimeout(done, 3000);
});
async function newPage(browser, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  await page.addInitScript(seed);
  return page;
}
// Under prefers-reduced-motion: reduce, after load and a scroll through: infinite CSS or WAAPI animations still running (must-fix) and
// elements a script keeps moving (advisory). Exempt: spinner-sized elements (under 48 px both ways) and progress indicators, which keep
// showing progress: loops under role=status, role=progressbar or aria-busy=true, or animating only rotation or a background-position shimmer of 3 s or less (slow ambient pans still count).
async function reducedAt(browser, url, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await page.addInitScript(seed);
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(quiet);
    return await page.evaluate(async () => {
      // Follows the page as it grows, up to 50 screens: an infinite feed must not run forever. This pass only has to start the
      // page's animations, so it does not wait for late loads (the main prescroll does); an extra idle wait here made Chrome hang on close.
      const wait = (ms) => new Promise((r) => setTimeout(r, ms)), high = () => Math.min(document.documentElement.scrollHeight, innerHeight * 50);
      for (let y = 0; y < high(); y += innerHeight / 2) { scrollTo(0, y); await wait(40); }
      scrollTo(0, 0); await new Promise((r) => setTimeout(r, 500));
      const sel = (el) => { const c = (el.getAttribute("class") || "").trim().split(/\s+/)[0]; return el.tagName.toLowerCase() + (c ? "." + c : ""); };
      // Position included: two marquees both called div.strip are two findings, and the model has to be able to tell them apart.
      const at = (el) => { const r = el.getBoundingClientRect(); return `${sel(el)} @${Math.round(r.left)},${Math.round(r.top + scrollY)}`; };
      const big = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return (r.width >= 48 || r.height >= 48) && s.visibility !== "hidden" && s.display !== "none"; };
      const out = { mustFix: [], advisory: [] }, css = new Set();
      for (const a of document.getAnimations()) {
        const el = a.effect?.target;
        if (!el || a.playState !== "running" || a.effect.getComputedTiming().iterations !== Infinity) continue;
        css.add(el);
        const props = (a.effect.getKeyframes?.() || []).flatMap((k) => Object.entries(k).filter(([p]) => !/^(offset|computedOffset|easing|composite)$/.test(p)));
        const shimmer = a.effect.getComputedTiming().duration <= 3000;
        const spins = props.length > 0 && props.every(([p, v]) => p === "rotate" || (p === "transform" && /^(none|rotateZ?\([^)]*\)\s*)+$/.test(String(v))) || (shimmer && /^backgroundPosition[XY]?$/.test(p)));
        if (big(el) && !spins && !el.closest('[role="status"],[role="progressbar"],[aria-busy="true"]')) out.mustFix.push([`reducedMotion|${sel(el)}`, `${a.animationName || "animation"} loops under reduced motion ${at(el)}`]);
      }
      // Two animations of the same name on the same element are one loop reported twice.
      out.mustFix = [...new Map(out.mustFix.map((h) => [h[1], h])).values()];
      const els = [...document.body.querySelectorAll("*")].filter((el) => big(el) && ![...css].some((c) => c.contains(el))).slice(0, 3000);
      const snap = () => els.map((el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return [s.transform, s.translate, s.rotate, s.scale, s.backgroundPosition, Math.round(r.left), Math.round(r.top)].join("|"); });
      const a = snap(); await new Promise((r) => setTimeout(r, 700)); const b = snap();
      const moved = els.filter((el, i) => a[i] !== b[i] && !els.some((p, j) => p !== el && p.contains(el) && a[j] !== b[j]));
      for (const el of moved.slice(0, 5)) out.advisory.push([`reducedMotionScript|${sel(el)}`, `moves under reduced motion ${at(el)}`]);
      return out;
    });
  } finally {
    await page.close();
  }
}

const sizeFor = (width) => ({ width, height: width < 768 ? 844 : width >= 1900 ? 1080 : 900 });

// What the page is: { kind: "deck" | "canvas" | "page", size } (size: the canvas or deck viewport).
async function detect(browser, url) {
  const page = await newPage(browser, sizeFor(1440));
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(quiet);
    if ((await page.evaluate(`(${findSlides})(${JSON.stringify(SLIDE)}).length`)) > 1) return { kind: "deck", size: sizeFor(1920) };
    const c = await findCanvas(page, sizeFor(1440));
    if (c) return { kind: "canvas", size: { width: Math.min(4000, c.width + 2 * c.left), height: Math.min(4000, Math.max(900, c.height + 2 * c.top)) } };
    return { kind: "page" };
  } finally {
    await page.close();
  }
}

// One viewport: all hits as { mustFix: {key: [[sig, msg]]}, advisory, unverifiedContrast, slides, canvas }.
async function auditAt(browser, url, size, shots, reduced, surface) {
  const width = size.width;
  const page = await newPage(browser, size);
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 120)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  const script = readFileSync(join(here, "audit-page.js"), "utf8");
  const res = { viewport: "", mustFix: {}, advisory: {}, unverifiedContrast: 0, slides: 0, canvas: false, suppressed: {}, scrollCapped: false };
  const merge = (r) => {
    res.viewport = r.viewport; res.unverifiedContrast += r.unverifiedContrast; res.scrollCapped ||= !!r.scrollCapped;
    // A deck is evaluated once per slide: the same marker must not count once per pass, so take the widest view, not the sum.
    for (const [k, v] of Object.entries(r.suppressed || {})) {
      const s = (res.suppressed[k] ||= { count: 0, at: [] });
      s.count = Math.max(s.count, v.count);
      for (const a of v.at) if (!s.at.some((b) => where(b) === where(a))) s.at.push(a);
    }
    for (const b of ["mustFix", "advisory"]) for (const [k, v] of Object.entries(r[b])) {
      const list = (res[b][k] ||= []), have = new Set(list.map((i) => i[1]));
      for (const i of v.items) if (!have.has(i[1])) list.push(i);
    }
  };
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(quiet);
    await page.evaluate(`window.__auditSlides = ${findSlides}`);
    const slideCount = await page.evaluate((sel) => window.__auditSlides(sel).length, SLIDE);
    if (slideCount < 2) res.canvas = !!(await findCanvas(page, size));
    await page.evaluate(async () => {
      window.__designAuditFull = true;
      // Follows the page as it grows (lazy images, reveal-on-scroll, a late async load at the bottom), up to 50 screens.
      // Content that was never in view by the end (past 50 screens, or arriving after the last check) marks the scan partial.
      const wait = (ms) => new Promise((r) => setTimeout(r, ms)), high = () => Math.min(document.documentElement.scrollHeight, innerHeight * 50);
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
      window.__designAuditPrescrolled = true;
    });
    await page.evaluate(settle);
    if (surface) await page.evaluate((s) => { window.__designAuditSurface = s; }, surface);
    if (res.canvas) await page.evaluate(() => { window.__designAuditCanvas = "[data-audit-canvas]"; });
    // Decks: show each slide in turn (the deck's own active class plus forced visibility), audit against the slide's bounds, merge.
    res.slides = await page.evaluate((sel) => {
      const slides = window.__auditSlides(sel);
      if (slides.length < 2) return 0;
      window.__designAuditDeck = true; window.__designAuditCanvas = "[data-audit-on]";
      const active = ["active", "is-active", "current", "is-current", "present"].filter((c) => slides.filter((s) => s.classList.contains(c)).length === 1);
      slides.forEach((s, i) => s.setAttribute("data-audit-slide", i));
      window.__auditShow = (i) => { slides.forEach((s, j) => { s.toggleAttribute("data-audit-on", i === j); for (const c of active) s.classList.toggle(c, i === j); }); scrollTo(0, 0); };
      const st = document.createElement("style");
      st.textContent = "[data-audit-slide]:not([data-audit-on]){display:none!important}[data-audit-on]{opacity:1!important;visibility:visible!important}";
      document.head.append(st);
      return slides.length;
    }, SLIDE);
    for (let i = 0; i < Math.max(1, res.slides); i++) {
      if (res.slides) { await page.evaluate((n) => window.__auditShow(n), i); await page.waitForTimeout(150); await page.evaluate(settle); }
      merge(await page.evaluate(script));
      if (shots && (i === 0 || res.slides)) await page.screenshot({ path: join(shots, `${width}${res.slides ? `-s${i + 1}` : ""}.png`), fullPage: true, animations: "disabled" });
    }
    if (errors.length) res.mustFix.consoleError = errors.map((e) => [`consoleError|${e}`, e]);
  } finally {
    await page.close();
  }
  if (reduced) {
    const rm = await reducedAt(browser, url, size);
    if (rm.mustFix.length) res.mustFix.reducedMotion = rm.mustFix;
    if (rm.advisory.length) res.advisory.reducedMotionScript = rm.advisory;
  }
  return res;
}

// Deck behaviour on a fresh load: → changes what is shown, print styles exist and are not portrait, notes are not painted.
export async function deckChecks(browser, url) {
  const page = await newPage(browser, sizeFor(1920));
  const out = {};
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(quiet);
    await page.evaluate(settle);
    await page.mouse.move(1, 1);
    const before = await page.screenshot();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(900);
    if (Buffer.compare(before, await page.screenshot()) === 0) out.deckPaging = [["deckPaging|right", "→ on the first slide changed nothing on screen"]];
    const print = await page.evaluate(() => {
      let found = false, portrait = false;
      const walk = (rules) => { for (const r of rules) {
        if (r.type === 6) { found = true; if (/portrait/.test(r.style.getPropertyValue("size"))) portrait = true; }
        else if (r.media && r.cssRules) { if (/\bprint\b/.test(r.media.mediaText)) found = true; walk(r.cssRules); }
      } };
      for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch {} }
      return { found, portrait };
    });
    if (!print.found) out.deckPrint = [["deckPrint|none", "no @page or @media print styles"]];
    else if (print.portrait) out.deckPrint = [["deckPrint|portrait", "@page size is portrait"]];
    const notes = await page.evaluate(() => [...document.querySelectorAll("aside.notes,.notes,[data-speaker-notes]")].filter((n) => {
      const r = n.getBoundingClientRect(), s = getComputedStyle(n);
      return n.textContent.trim() && r.width > 0 && r.height > 0 && s.visibility !== "hidden" && +s.opacity > 0.1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    }).length);
    if (notes) out.notesOnScreen = [["notesOnScreen|first", `${notes} note element(s) painted on the first slide`]];
  } finally {
    await page.close();
  }
  return out;
}

// What to do after the numbers, printed with them so the procedure is read when it applies.
export function nextSteps({ total, deck, echoes, notRun, inherited, skeleton }) {
  const probe = join(here, "probe.js");
  return [
    "next:",
    skeleton ? `- re-run with --baseline ${skeleton} before changing anything: the hits above include that skeleton's own.` : "",
    notRun ? "" : total ? `- fix the ${total} must-fix finding(s) and re-run; deliver only when the total is 0.` : "- must-fix is 0.",
    inherited ? `- ${inherited} inherited hit(s) are reported, not resolved: say so in the delivery, so a must-fix total of 0 is not read as "no defects".` : "",
    echoes ? "- give every echo worklist item a disposition (deleted, folded, or a one-word reason it stays) and report the counts." : "",
    notRun
      ? `- capture the page yourself (full page, at 1440 and 390${deck ? ", a deck 1920x1080 per slide" : ""}) with an available browser or screenshot tool and look at it: this run took no screenshots. Say what it communicates and where the eye lands first, and fix what contradicts the brief.`
      : `- look at the screenshots${deck ? " (the first slide and any you are unsure of)" : ""}; a capture you have not looked at is not a review. Say what it communicates and where the eye lands first, and fix what contradicts the brief.`,
    `- operate it in an available browser tool with real pointer input at each control's centre (e.g. page.mouse.click). For each core click, toggle, filter and submit: evaluate ${probe} in the page once, await designProbe.watch(), act, await designProbe.changes(), and act on its hints. Without scripting, compare screenshots before and after.`,
    deck ? "- press ← / → and Space from the first slide to the last: one slide per press, page numbers match the real count, print preview is landscape with nothing clipped." : "",
  ].filter(Boolean).join("\n");
}

// The screenshots have to outlive the process: the model reads them after the run exits, so a run can only clear earlier ones.
// Kept: directories from the last day, newest first, at most keepN of them (a run's own is the newest, so it always survives).
// Anything older than a day, or past the newest keepN, is removed.
export function sweepShots(dir = tmpdir(), keepMs = 864e5, keepN = 100) {
  let found = [];
  try { found = readdirSync(dir).filter((d) => d.startsWith("design-audit-")).map((d) => join(dir, d)); } catch { return 0; }
  const now = Date.now(), aged = [];
  for (const d of found) { try { aged.push([d, statSync(d).mtimeMs]); } catch {} }
  const fresh = aged.filter(([, t]) => now - t < keepMs).sort((a, b) => b[1] - a[1]);
  let gone = 0;
  for (const [d] of aged.filter(([, t]) => now - t >= keepMs).concat(fresh.slice(keepN))) {
    try { rmSync(d, { force: true, recursive: true }); gone++; } catch {}
  }
  return gone;
}

const firstLine = (e) => `${e?.message || e}`.split("\n")[0].replace(/\.$/, "");
// Nothing was measured: say so and hand the caller the fallback, so a failed run is never read as a clean page.
const notRunText = (why) => `audit not run: ${why}. Evaluate ${join(here, "audit-page.js")} in an available browser tool at 1440 and 390 (a deck: 1920x1080, once per slide, per its header) and treat its mustFix as this audit's. With no browser tool either, say "page audit not run" in the delivery and check text size, contrast, line height, truncation, overlap, edges, CJK line breaks, external resources and console errors by eye.\n\n${nextSteps({ notRun: true })}`;

async function main() {
  const args = process.argv.slice(2), missing = [];
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args.splice(i, 2)[1]; if (v === undefined || v.startsWith("--")) { missing.push(n); return undefined; } return v; };
  let baseline = flag("--baseline");
  const all = args.includes("--all"), json = args.includes("--json");
  let surface = flag("--surface")?.toLowerCase();
  if (missing.length) { console.log(`${missing.join(" and ")} needs a value`); return 1; }
  if (surface && !["operate", "persuade", "read", "experience"].includes(surface)) { console.error(`unknown --surface "${surface}" (operate|persuade|read|experience): inferring from the page`); surface = undefined; }
  const [target, widthArg] = args.filter((a) => !a.startsWith("--"));
  if (!target || args.includes("--help")) {
    console.log(`usage: node audit.mjs <file.html|url> [widths, default 1440,390] [--baseline <file>] [--project] [--surface operate|persuade|read|experience] [--all] [--json]
  Decks are found and audited slide by slide at 1920x1080, fixed canvases at their own size; pass widths only for another device.
  --baseline  the skeleton's example.html (infinite canvas: its template) or the snapshot of the page before a redesign.
              Its own hits count as inherited, so a deliberate choice of the author it came from is reported, not "fixed" into
              compliance. Omit it when there is no such file (a skeleton marked no example, a self skeleton, a review-only task).
              It never excuses external resources, console errors, or too-small or low-contrast running copy and control labels:
              a web font the skeleton loads has to be inlined or replaced by a system stack before the typography is tuned to it.
  --project   the target is the user's real project (implied for URLs): its own external resources and console errors are reported, not failed.
  --surface   operate for app UI, where a slow transition on a control is must-fix; inferred when omitted.
  --all       list every hit: every advisory location and the inherited ones, not just the first of each.`);
    return 0;
  }
  const project = args.includes("--project") || /^https?:\/\//i.test(target);
  const toUrl = (t) => (/^[a-z]+:\/\//i.test(t) ? t : pathToFileURL(resolve(t)).href);
  // A directory renders as the browser's own file listing, whose script errors would be reported as the page's.
  const unusable = (t) => {
    if (/^[a-z]+:\/\//i.test(t)) return;
    if (!existsSync(resolve(t))) return `not found: ${t}${/[<>]/.test(t) ? " (that is the usage placeholder, not a path: pass the real file, or drop the flag)" : ""}`;
    if (statSync(resolve(t)).isDirectory()) return `not a file: ${t} is a directory; pass the HTML file`;
  };
  const bad = unusable(target);
  if (bad) { console.log(bad); return 1; }
  const widths = widthArg ? widthArg.split(",").map((w) => Number(w.trim())) : undefined;
  if (widths && !widths.every((w) => Number.isInteger(w) && w > 0)) { console.log(`bad widths: ${widthArg}; pass comma-separated pixel widths, e.g. 1440,390`); return 1; }

  // A baseline that is the audited page itself would make every hit inherited and the must-fix total 0 by construction: drop it.
  // An unusable baseline path drops it too, rather than stopping the audit: the page still gets measured, every hit as new.
  let baselineIgnored;
  const dropBaseline = (why) => { baselineIgnored = `--baseline ignored, every hit counts as new: ${why}. Pass the skeleton's example.html or the pre-redesign snapshot, or omit the flag when there is no such file.`; console.error(baselineIgnored); baseline = undefined; };
  if (baseline && unusable(baseline)) dropBaseline(unusable(baseline));
  else if (baseline && toUrl(baseline).replace(/[?#].*$/, "") === toUrl(target).replace(/[?#].*$/, "")) dropBaseline(`${baseline} is the audited page itself`);
  const notRun = (why) => { console.log(notRunText(why)); return 2; };
  const chromium = loadPlaywright();
  if (!chromium) return notRun("Playwright not found (cwd, script dir, NODE_PATH, global npm/pnpm/bun, npx cache)");
  const browser = await launch(chromium);
  if (!browser) return notRun("no launchable Chrome or Chromium");
  sweepShots();
  const shots = mkdtempSync(join(tmpdir(), "design-audit-"));
  const report = [];
  // One finding, not one per viewport: the same defect measured at 1440 and at 390 is one thing to fix, and fixing it must
  // drop the total by one. Keyed by hit minus its position, counted at the width that shows the most of it.
  const tally = new Map();
  try {
    const kind = await detect(browser, toUrl(target));
    const sizes = widths ? widths.map(sizeFor) : kind.size ? [kind.size] : [sizeFor(1440), sizeFor(390)];
    for (const [i, size] of sizes.entries()) {
      const r = await auditAt(browser, toUrl(target), size, shots, i === 0, surface);
      const base = baseline ? await auditAt(browser, toUrl(baseline), size, null, i === 0, surface) : null;
      const sk = !!baseline && isSkeleton(baseline);
      const must = classify(r.mustFix, base ? summarize(base.mustFix) : {}, sk, project), adv = classify(r.advisory, base ? summarize(base.advisory) : {}, sk);
      const echoes = ECHO.flatMap((k) => (adv.own[k] || []).map((m) => [k, m]));
      if (i === 0 && kind.kind === "deck") for (const [k, v] of Object.entries(await deckChecks(browser, toUrl(target)))) must.own[k] = v.map((x) => x[1]);
      const mustCount = Object.values(must.own).reduce((n, l) => n + l.length, 0);
      const local = new Map();
      for (const [k, v] of Object.entries(must.own)) for (const m of v) { const id = `${k}|${where(m)}`; local.set(id, (local.get(id) || 0) + 1); }
      for (const [id, count] of local) { const t = tally.get(id) || { n: 0, widths: [] }; t.n = Math.max(t.n, count); t.widths.push(size.width); tally.set(id, t); }
      report.push({ width: size.width, viewport: r.viewport, kind: r.slides ? "deck" : r.canvas ? "canvas" : "page", slides: r.slides, mustFix: must.own, inherited: must.inherited, inheritedItems: must.items, advisory: adv.own, echoes, suppressed: r.suppressed, unverifiedContrast: r.unverifiedContrast, scrollCapped: r.scrollCapped, mustCount });
    }
  } catch (e) {
    // A load that never finishes, a document the audit cannot walk, a crashed tab: report it as a run that did not happen.
    return notRun(firstLine(e));
  } finally {
    await browser.close();
  }
  const total = [...tally.values()].reduce((n, t) => n + t.n, 0);
  const inheritedTotal = report.reduce((n, r) => Math.max(n, Object.values(r.inherited).reduce((m, c) => m + c, 0)), 0);
  const skeleton = !baseline && !/^[a-z]+:\/\//i.test(target) ? guessSkeleton(resolve(target)) : undefined;
  const hint = skeleton && `looks derived from ${skeleton}: re-run with --baseline ${skeleton} so its own hits count as inherited instead of reading as this page's defects`;
  const next = nextSteps({ total, deck: report.some((r) => r.kind === "deck"), echoes: report.some((r) => r.echoes.length), inherited: inheritedTotal, skeleton });
  if (json) { console.log(JSON.stringify({ total, perWidth: report.map((r) => [r.width, r.mustCount]), report, next, ...(hint ? { baselineHint: hint } : {}), ...(baselineIgnored ? { baselineIgnored } : {}) })); return 0; }
  const n = all ? Infinity : 3, sum = (o) => Object.entries(o).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : v}`).join(", ");
  // The same finding at two widths is marked, so a width-only one (a phone-width overflow) is not mistaken for both.
  const only = (k, m) => (report.length > 1 && tally.get(`${k}|${where(m)}`)?.widths.length === 1 ? " [this width only]" : "");
  if (hint) console.log(hint);
  for (const r of report) {
    console.log(`\n== ${r.width}px ${r.viewport}${r.slides ? `, ${r.slides} slides, each checked against its own bounds` : r.kind === "canvas" ? ", fixed canvas, checked against its own bounds" : ""}`);
    console.log(`must fix: ${r.mustCount ? sum(r.mustFix) : "none"}`);
    for (const [k, v] of Object.entries(r.mustFix)) {
      console.log(`  ${k} -> ${HINTS[k] || ""}`);
      for (const s of v.slice(0, n)) console.log(`    ${s}${only(k, s)}`);
      if (v.length > n) console.log(`    ... ${v.length - n} more (--all)`);
    }
    if (Object.keys(r.inherited).length) console.log(`inherited from baseline, reported and not resolved (a redesign fixes those where it restyles; say in the delivery that they stand): ${sum(r.inherited)}${all ? "" : " (--all lists them)"}`);
    // The project's own external resources and errors are listed even without --all: the delivery reports them.
    for (const [k, v] of Object.entries(r.inheritedItems)) if (all || NEVER_INHERITED.has(k)) for (const s of v) console.log(`    ${k}: ${s}`);
    if (Object.keys(r.advisory).length) {
      console.log(`advisory (look, act only if it hurts this brief): ${sum(r.advisory)}`);
      for (const [k, v] of Object.entries(r.advisory)) {
        if (ECHO.includes(k)) continue;
        console.log(`  ${k}: ${v[0]} -> ${HINTS[k] || ""}`);
        for (const s of v.slice(1, all ? Infinity : 1)) console.log(`    ${s}`);
        if (!all && v.length > 1) console.log(`    ... ${v.length - 1} more (--all)`);
      }
    }
    // The echo worklist is listed in full at every width, --all or not: each item is deleted, folded, or kept with a reason.
    if (r.echoes.length) {
      console.log(`echo worklist (${r.echoes.length}): this view says the same thing twice. Delete each item, fold it, or record a one-word reason it stays; report the counts.`);
      r.echoes.forEach(([k, m], i) => console.log(`  ${i + 1}. ${k}: ${m}`));
      for (const k of [...new Set(r.echoes.map(([k]) => k))]) console.log(`  ${k} -> ${HINTS[k] || ""}`);
    }
    // Suppression is reported, never silent: these markers take text out of the other checks, and none of them off the worklist.
    const supp = Object.entries(r.suppressed || {});
    if (supp.length) {
      console.log(`suppression markers honoured: ${supp.map(([k, v]) => `${SUPPRESSION[k] || k} ${v.count}`).join(", ")}`);
      for (const [k, v] of supp) for (const a of v.at.slice(0, all ? Infinity : 2)) console.log(`    ${SUPPRESSION[k] || k}: ${a}`);
    }
    if (r.scrollCapped) console.log("scan incomplete: part of the page never came into view while prescrolling (it is over 50 screens, or content kept arriving after the last check), so reveal-on-scroll content there was not triggered. Check it on the screenshot or audit a bounded state.");
    if (r.unverifiedContrast) console.log(`contrast not computable (images, gradients, overlays, canvas labels): ${r.unverifiedContrast} text elements; check on the screenshot`);
  }
  if (hint) console.log(`\n${hint}`);
  if (baselineIgnored) console.log(`\n${baselineIgnored}`);
  const spread = report.length > 1 ? ` distinct (per viewport ${report.map((r) => `${r.width}: ${r.mustCount}`).join(", ")}; a finding both viewports show counts once)` : "";
  console.log(`\nscreenshots: ${shots}\nmust-fix total: ${total}${spread}\n\n${next}`);
  return 0;
}

// Compare real paths: import.meta.url is already symlink-resolved, so a run through a symlinked
// install path (or a symlinked /tmp) must not silently skip main() and look like a clean page.
const entry = (p) => { try { return p === undefined ? undefined : realpathSync(resolve(p)); } catch { return undefined; } };
if (entry(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((e) => { console.log(notRunText(firstLine(e))); return 2; });
}
