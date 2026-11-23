(() => {
  // Visible-result probe. Evaluate this file's contents in the page once, then for each action:
  // The file is one expression: evaluate it as is, or as `() => <file>` / `return (<file>)` where a tool only takes a function.
  //   await designProbe.watch()     before the action (samples the idle page for about 1.2 s)
  //   (real click / tap / typing, then wait for transitions)
  //   await designProbe.changes()   after; visible:false with no scroll or URL change means the result is not in view.
  // hints say what to do next: a missing result, a click that was not real pointer input, an invisible layer that took the pointer,
  // a missing transition. Act on them.
  // controlChangedOnly: only the pressed control changed: its painted points, or attributes, checked state or the computed style
  // of it, its descendants, its label's input and that input's siblings, ::before/::after included (a small switch the point grid
  // misses); focus, hover and :active styling alone does not count. Judge whether that is the result.
  // It compares what is painted at a grid of viewport points, text boxes in view whose text, attributes or styles were
  // mutated, and added nodes that land in the viewport. Points and nodes that change while idle (looping animation,
  // tickers), nodes that changed during two earlier idle samples (slow live data) and infinitely running animations are
  // ignored; so is the focus or hover styling the previous action left on its control.
  // animated: whether the change ran a CSS transition or animation, element.animate(), a view transition or a JS tween (an element's
  // style attribute rewritten 3+ times) outside the pressed control (inside it, not the previous control, when only the control changed); a transition on the control
  // whose property ends where it was already heading at pointerdown (its hover or focus styling) does not count. hints: what to do; a missing transition is hinted only for the control's own state
  // change and for overlays or regions that open, close, expand or collapse, not for content swaps (tabs, filters, data, items leaving a list).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vw = () => document.documentElement.clientWidth;
  const inView = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && +s.opacity > 0.1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < vw();
  };
  const grid = () => {
    const w = vw(), h = innerHeight, pts = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 16; j++) {
      const el = document.elementFromPoint(((j + 0.5) * w) / 16, ((i + 0.5) * h) / 12);
      if (!el) { pts.push(["", null]); continue; }
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join("").trim().slice(0, 60);
      const clip = [Math.max(0, r.left), Math.max(0, r.top), Math.min(w, r.right), Math.min(h, r.bottom)].map(Math.round);
      pts.push([/^(HTML|BODY)$/.test(el.tagName) ? `root|${own}` : [el.tagName, own, s.color, s.backgroundColor, s.opacity, s.transform, ...clip].join("|"), el]);
    }
    return pts;
  };
  // Text-owning boxes in view: element -> text, page position, color, opacity.
  const textBoxes = () => {
    const map = new Map(), walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() && !n.parentElement.closest("script,style,noscript,template") ? 1 : 2) });
    for (let n; (n = walk.nextNode()) && map.size < 4000; ) {
      const el = n.parentElement;
      if (map.has(el) || !inView(el)) continue;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      map.set(el, [el.textContent.trim().slice(0, 80), Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height), s.color, s.opacity, s.visibility].join("|"));
    }
    return map;
  };
  const looping = () => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).map((a) => a.effect.target).filter(Boolean);
  // Pressed control's state, apart from its own box: checked, computed style and ::before/::after of it and its descendants, of the
  // input a label holds or names (for/id) and of that input's siblings (label > input:checked + span::after knobs).
  const PROPS = ["transform", "translate", "left", "right", "backgroundColor", "color", "opacity", "borderColor", "fill"];
  const state = (c) => {
    const inputs = [c, ...c.querySelectorAll("input"), c.control, ...(c.labels || [])].filter(Boolean), set = new Set();
    for (const e of inputs) for (const n of [e, ...(e.tagName === "INPUT" ? e.parentElement?.children || [] : [])]) for (const d of [n, ...n.querySelectorAll("*")]) set.add(d);
    return [...set].slice(0, 80).map((d) => [d.checked, ...["", "::before", "::after"].map((p) => PROPS.map((k) => getComputedStyle(d, p || null)[k]).join())].join()).join("|");
  };
  // Overlay or expanding region: positioned layer, dialog-like role, or an ancestor of it; aria-expanded / details open on the control.
  const overlay = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { if (/fixed|absolute|sticky/.test(getComputedStyle(e).position) || e.matches('dialog,details,[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],[popover]')) return true; } return false; };
  const openState = (c) => { const x = c.closest("[aria-expanded]"); const d = c.closest("details"); return x ? x.getAttribute("aria-expanded") : d ? String(d.open) : undefined; };
  // Collection item: el or its nearest ancestor with a sibling of the same tag and class.
  const sig = (e) => e.tagName + "." + e.className;
  const item = (el) => { for (let e = el; e && e.parentElement && e !== document.body; e = e.parentElement) if ([...e.parentElement.children].some((x) => x !== e && sig(x) === sig(e))) return [e, e.parentElement, sig(e)]; return null; };
  const under = (set, el) => { for (const m of set) if (m !== document.body && m !== document.documentElement && m.contains(el)) return true; return false; };

  // Motion started after watch(): CSS transitions and animations by event, WAAPI and view transitions by wrapping their entry points.
  const motion = (el, prop) => window.designProbe?._rec?.ready && el && window.designProbe._rec.anim.push([el, prop]);
  const camel = (p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  // Values the pressed control's transitions head for at pointerdown (hover and focus included), so its own hover transition is not
  // taken for the action's motion: a control transition counts only when its property ends somewhere else.
  const goal = (d, p) => { const k = d.getAnimations().find((a) => a.transitionProperty === p)?.effect.getKeyframes().at(-1), cp = camel(p); return k && cp in k ? String(k[cp]) : getComputedStyle(d)[cp]; };
  const goals = (c) => {
    const m = new Map();
    for (const d of [c, ...c.querySelectorAll("*")].slice(0, 80)) {
      for (const p of getComputedStyle(d).transitionProperty.split(",").map((x) => x.trim())) if (p !== "all" && p !== "none") m.set(m.size, [d, p, goal(d, p)]);
    }
    return m;
  };
  if (!window.designProbe) {
    for (const ev of ["transitionrun", "animationstart"]) addEventListener(ev, (e) => motion(e.target, e.propertyName), true);
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...a) { motion(this); return animate.apply(this, a); };
    const vt = document.startViewTransition;
    if (vt) document.startViewTransition = function (...a) { motion(document.documentElement); return vt.apply(this, a); };
  }

  // An ancestor painted at opacity 0 that still takes the pointer: a closed overlay, scrim or drawer left in the way.
  const ghost = (el) => { for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement ?? e.getRootNode()?.host) if (+getComputedStyle(e).opacity < 0.05 && getComputedStyle(e).pointerEvents !== "none") return e.tagName.toLowerCase() + (e.id ? "#" + e.id : e.classList[0] ? "." + e.classList[0] : ""); return null; };
  window.designProbe = {
    async watch() {
      this._mo?.disconnect();
      const rec = (this._rec = { ready: false, added: [], mutated: new Set(), url: location.href, y: scrollY, target: null, anim: [], styled: new Map(), entered: [] });
      this._mo = new MutationObserver((ms) => {
        for (const m of ms) {
          const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          if (el) rec.mutated.add(el);
          if (rec.ready && m.attributeName === "style") rec.styled.set(el, (rec.styled.get(el) || 0) + 1);
          for (const n of m.addedNodes) { rec.added.push(n.nodeType === 1 ? n : n.parentElement); if (rec.ready && n.nodeType === 1 && overlay(n)) rec.entered.push(n); }
        }
      });
      this._mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      rec.prev = [document.activeElement, [...document.querySelectorAll(":hover")].pop()].map((e) => e?.closest?.("button,a,input,select,textarea,label,summary")).filter(Boolean);
      const gs = [grid()], ts = [textBoxes()];
      for (let k = 0; k < 2; k++) { await sleep(600); gs.push(grid()); ts.push(textBoxes()); }
      const g2 = gs[2], t2 = ts[2];
      rec.unstable = new Set(g2.map((p, i) => gs.some((g) => g[i][0] !== p[0]) && i).filter((i) => i !== false));
      rec.idle = new Set([...rec.mutated, ...rec.added.filter(Boolean)]);
      for (const [el, k] of t2) if (ts.some((t) => t.get(el) !== k)) rec.idle.add(el);
      const seen = (this._seen ||= new Map());
      for (const el of rec.idle) seen.set(el, (seen.get(el) || 0) + 1);
      for (const [el, n] of seen) if (n >= 2) rec.idle.add(el);
      rec.added = []; rec.mutated = new Set(); rec.anim = []; rec.styled = new Map(); rec.entered = [];
      rec.view = g2; rec.viewEls = new Set(g2.map(([, el]) => el)); rec.items = new Map([...rec.viewEls].filter(Boolean).map((el) => [el, item(el)])); rec.text = t2; rec.ready = true;
      this._down && removeEventListener("pointerdown", this._down, true);
      // Shadow DOM retargets e.target to the host; take the real innermost target, or the whole component counts as the control.
      addEventListener("pointerdown", (this._down = (e) => { if (rec.target) return; const p = e.composedPath?.() || []; const tg = p[0]?.nodeType === 1 ? p[0] : e.target; rec.target = tg; rec.trusted = e.isTrusted; rec.ghost = ghost(tg); const c = tg.closest?.("button,a,input,select,textarea,label,summary,[role]") || tg; rec.state = state(c); rec.open = openState(c); rec.goals = goals(c); }), true);
      return "watching";
    },
    async changes() {
      const rec = this._rec;
      if (!rec?.ready) return { error: "call await designProbe.watch() before the action" };
      this._mo?.disconnect();
      const loops = looping(), ambient = (el) => !!el && (loops.some((t) => t === el || t.contains(el)) || rec.idle.has(el) || under(rec.idle, el));
      const t = rec.target?.closest?.("button,a,input,select,textarea,label,summary,[role]") || rec.target, atControl = (el) => !!el && [t, ...rec.prev].some((c) => c && c.contains(el));
      const now = grid();
      const diff = now.map((p, i) => !rec.unstable.has(i) && p[0] !== rec.view[i][0] && !ambient(p[1]) && !ambient(rec.view[i][1]) && [p[1], rec.view[i][1]]).filter(Boolean);
      const ctlState = !!t && t.nodeType === 1 && (rec.state !== state(t) || [...rec.mutated].some((el) => t.contains(el) && !ambient(el)));
      const changedPoints = diff.filter(([a, b]) => !atControl(a) && !atControl(b)).length;
      let controlOnly = diff.length - changedPoints, ctlChanged = ctlState;
      // Focus, hover and :active styling alone is not a result: compare with the control merely focused and hovered.
      if ((controlOnly || ctlChanged) && t?.nodeType === 1) {
        const f = document.activeElement;
        f?.blur?.();
        const again = grid();
        controlOnly = again.filter((p, i) => !rec.unstable.has(i) && p[0] !== rec.view[i][0] && !ambient(p[1]) && (atControl(p[1]) || atControl(rec.view[i][1]))).length;
        ctlChanged = rec.state !== state(t) || [...rec.mutated].some((el) => t.contains(el) && !ambient(el));
        f?.focus?.({ preventScroll: true });
      }
      const mutated = (el) => rec.mutated.has(el) || under(rec.mutated, el);
      const textChanged = [...textBoxes()].filter(([el, k]) => rec.text.get(el) !== k && mutated(el) && !ambient(el) && !atControl(el)).map(([el]) => el);
      const added = [...new Set(rec.added)].filter((el) => el && el.isConnected && !atControl(el) && !ambient(el) && inView(el));
      const name = (el) => `${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 30)}"`;
      const visible = changedPoints > 0 || textChanged.length > 0 || added.length > 0;
      const controlChangedOnly = (controlOnly > 0 || ctlChanged) && !visible, scrolled = Math.round(scrollY - rec.y), urlChanged = location.href !== rec.url;
      const same = (el, p) => { if (!p || !rec.goals) return false; for (const [d, q, v] of rec.goals.values()) if (d === el && q === p) return goal(el, p) === v; return false; };
      const moved = [...rec.anim.filter(([el, p]) => !same(el, p)).map(([el]) => el), ...[...rec.styled].filter(([, n]) => n >= 3).map(([el]) => el)].filter((el) => el.isConnected !== false && !loops.includes(el));
      const animated = visible || controlChangedOnly ? moved.some((el) => (controlChangedOnly ? !!t?.contains?.(el) : el === document.documentElement || !atControl(el))) : null;
      const hints = [];
      if (!rec.target) hints.push("no pointer input reached the page: if this was a click, use real pointer input at the control's centre (e.g. page.mouse.click); element.click() and dispatched events skip what a user's click goes through");
      else if (rec.trusted === false) hints.push("the pointer event was synthetic: click with real pointer input at the control's centre (e.g. page.mouse.click)");
      if (rec.ghost) hints.push(`the pointer landed on an invisible layer (${rec.ghost}, opacity 0): a closed overlay, scrim or drawer uses display:none or visibility:hidden plus pointer-events:none, since opacity:0 alone still takes clicks`);
      if (!visible && !controlChangedOnly && !scrolled && !urlChanged) hints.push("no result in view: bring it into view or give feedback at the control");
      if (controlChangedOnly) hints.push("only the control changed: fine if that is the result (toggle, like, tab), else add feedback");
      // A missing transition is hinted only for overlays and regions that enter, leave, expand or collapse; tab, filter and data swaps are not hinted.
      const real = (el) => el && !/^(HTML|BODY)$/.test(el.tagName) && !atControl(el) && !ambient(el);
      const appeared = now.map(([, el]) => el).filter((el) => real(el) && !rec.viewEls.has(el));
      const gone = [...rec.viewEls].filter((el) => real(el) && !(el.isConnected && inView(el)));
      const layer = [...new Set(rec.entered)].some((el) => el.isConnected && inView(el)) || [...appeared, ...gone].some(overlay);
      const toggled = !!t && t.nodeType === 1 && rec.open !== undefined && rec.open !== openState(t);
      // Items leaving a collection whose siblings stay (a filter, a shrinking list) are a content swap.
      const removed = gone.length > 0 && !appeared.length && !toggled && gone.every((el) => { const it = rec.items.get(el); return it && !(it[0].isConnected && inView(it[0])) && [...it[1].children].some((x) => x !== it[0] && sig(x) === it[2] && inView(x)); });
      const swap = removed || !!t?.closest?.('[role="tab"],[role="tablist"],[role="radio"],[role="option"],select') || (appeared.length > 0 && gone.length > 0 && !layer);
      const entered = layer || toggled || appeared.length > 0 !== gone.length > 0;
      if (animated === false && controlChangedOnly) hints.push("the control changed state with no transition: a state change in place usually carries motion (references/motion.md)");
      else if (animated === false && entered && !swap) hints.push("opened, closed, expanded or collapsed with no transition: something entering or leaving usually carries motion (references/motion.md); if it is instant on purpose, have a reason");
      return {
        visible, changedPoints, textChanged: textChanged.slice(0, 5).map(name), addedInView: added.slice(0, 5).map(name),
        controlChangedOnly, animated, scrolled, urlChanged, hints,
      };
    },
  };
  return "designProbe ready";
})()
