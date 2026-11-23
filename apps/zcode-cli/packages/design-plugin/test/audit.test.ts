import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// 页面审查脚本在小夹具上的检出与误报；没有 Playwright/Chromium 时跳过浏览器用例并打印原因，设了 CI 时直接失败。
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scripts = join(repoRoot, "skills", "design", "scripts");
const fixture = (name: string) => join(repoRoot, "test", "fixtures", "audit", name);
const skeletons = join(repoRoot, "skills", "design", "design-resources", "design-skeletons");
const text = (...args: string[]) => spawnSync(process.execPath, [join(scripts, "audit.mjs"), ...args], { cwd: repoRoot, encoding: "utf8", timeout: 200_000 }).stdout;

function audit(...args: string[]) {
  const run = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(scripts, "audit.mjs"), ...args, "--json"], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, report: run.status === 0 ? JSON.parse(run.stdout) : null };
}

const available = audit(fixture("base.html"), "1440").status === 0;
if (!available) {
  if (process.env.CI) throw new Error("audit.mjs 找不到 Playwright 或 Chromium，CI 上不允许跳过浏览器用例");
  console.warn("audit.test.ts: 没有 Playwright 或 Chromium，跳过浏览器用例");
}
const keys = (r: { report: Array<{ mustFix: Record<string, string[]> }> }) => new Set(r.report.flatMap((w) => Object.keys(w.mustFix)));

describe("audit.mjs", () => {
  it("classify：按签名计数，先继承基线原有内容上的命中；骨架基线的样式键按签名存在继承；对比度变差算新增；外链和报错永不继承", async () => {
    const { classify, summarize } = await import(pathToFileURL(join(scripts, "audit.mjs")).href);
    const base = summarize({
      smallText: [["smallText|span|11", '11px span "c" @0,0']],
      lowContrast: [["lowContrast|p", '3.00:1 16px p "x" @0,0', 3]],
      edge: [["edge|p|L", 'L4 R0 p "x" @0,0']],
      externalResource: [["externalResource|fonts.googleapis.com", "e"]],
      consoleError: [["consoleError|x", "f"]],
    });
    const hits = {
      smallText: [["smallText|span|11", '11px span "a" @0,0'], ["smallText|span|11", '11px span "b" @0,9'], ["smallText|span|11", '11px span "c" @5,5'], ["smallText|p.note|10", "d"]],
      lowContrast: [["lowContrast|p", '2.95:1 16px p "y" @0,0', 2.95], ["lowContrast|p", '2.50:1 16px p "z" @0,0', 2.5]],
      edge: [["edge|p|L", "g"], ["edge|p|L", "h"]],
      externalResource: [["externalResource|fonts.googleapis.com", "e"]],
      consoleError: [["consoleError|x", "f"]],
    };
    const counted = classify(hits, base);
    expect(counted.own).toEqual({ smallText: ['11px span "a" @0,0', '11px span "b" @0,9', "d"], lowContrast: ['2.50:1 16px p "z" @0,0'], edge: ["h"], externalResource: ["e"], consoleError: ["f"] });
    expect(counted.inherited).toEqual({ smallText: 1, lowContrast: 1, edge: 1 });
    const skeleton = classify(hits, base, true);
    expect(skeleton.own).toEqual({ smallText: ["d"], lowContrast: ['2.50:1 16px p "z" @0,0'], edge: ["h"], externalResource: ["e"], consoleError: ["f"] });
    expect(counted.items.edge).toEqual(["g"]);
    const project = classify(hits, base, false, true);
    expect(project.own.externalResource).toBeUndefined();
    expect(project.items).toMatchObject({ externalResource: ["e"], consoleError: ["f"] });
    expect(classify(hits, base, true, true).own.externalResource).toEqual(["e"]);
  });

  it.skipIf(!available)("坏例：每类可测缺陷都检出，echoLabel 只进 advisory", () => {
    const { report } = audit(fixture("bad.html"), "1440");
    const found = keys(report);
    for (const k of ["smallText", "lowContrast", "truncated", "tightLeading", "textCollision", "edge", "externalResource"]) expect(found.has(k), k).toBe(true);
    expect(report.report[0].advisory.echoLabel?.length).toBe(1);
  }, 120_000);

  it.skipIf(!available)("干净例：等价定价档、深色定位层上的标题、横向滚动表、SVG 缩放文字、表情和换行标签组都不报 must-fix", () => {
    const { report } = audit(fixture("clean.html"), "1440,390");
    expect(report.total, JSON.stringify(report.report.map((w: { mustFix: unknown }) => w.mustFix))).toBe(0);
    expect(report.report[0].advisory.echoLabel).toBeUndefined();
    expect(report.report[0].advisory.repeatedText).toBeUndefined();
    expect(report.report[0].echoes).toEqual([]);
    // 等价的定价档不再报 identicalPeers：原来的提示自己又说"档位本来就该一样"，等于把自己撤回。
    expect(report.report[0].advisory.identicalPeers).toBeUndefined();
  }, 120_000);

  it.skipIf(!available)("回声清单：装饰性副本按页比对，aria-hidden 和 data-audit-skip 都关不掉它，抑制标记进报告", () => {
    const { report } = audit(fixture("echo-deco.html"));
    const w = report.report[0];
    expect(w.slides).toBe(3);
    expect(w.mustFix, JSON.stringify(w.mustFix)).toEqual({});
    // 第 1 页 aria-hidden 的 196px 副本，第 2 页带 data-audit-skip 的最大号字：两种装饰依据各报一条。
    expect(w.echoes.map((e: string[]) => e[0])).toEqual(["decorativeEcho", "decorativeEcho"]);
    expect(w.echoes[0][1]).toContain("div.shout");
    expect(w.echoes[0][1]).toContain("repeats h1");
    expect(w.echoes[1][1]).toContain("div.motif");
    expect(w.echoes[1][1]).toContain("repeats h2");
    // 第 3 页的 div.motif 只和第 1 页的标题同文：跨页不是同一视图，页脚也不当参照。
    expect(w.echoes.map((e: string[]) => e[1]).join()).not.toContain("Permissions");
    expect(w.suppressed.ariaHidden.count).toBe(1);
    expect(w.suppressed.auditSkip.count).toBe(1);
    expect(w.suppressed.auditSkip.at.join()).toContain("div.motif");
  }, 120_000);

  it.skipIf(!available)("回声清单：标题不是紧邻兄弟、同节的另一个标题、控件文案、图表标签各报一次，同文两处进 repeatedText，清单按具体程度排序", () => {
    const w = audit(fixture("echo-wide.html"), "1440").report.report[0];
    expect(w.mustFix, JSON.stringify(w.mustFix)).toEqual({});
    const msgs = w.echoes.map((e: string[]) => e[1]);
    expect(msgs, JSON.stringify(w.echoes)).toHaveLength(5);
    expect(w.echoes.map((e: string[]) => e[0])).toEqual(["echoLabel", "echoLabel", "echoLabel", "echoLabel", "repeatedText"]);
    expect(msgs[0]).toContain("Latency budget");
    expect(msgs[0]).toContain("repeats h2");
    expect(msgs.find((m: string) => m.includes("Quarterly revenue"))).toContain("repeats h2");
    expect(msgs.find((m: string) => m.includes("Export CSV"))).toContain("repeats button");
    expect(msgs.find((m: string) => m.includes("Tail latency"))).toContain("repeats text");
    expect(msgs[4]).toContain("uptime");
  }, 120_000);

  it.skipIf(!available)("回声清单不误报：目录项、标签页名、页眉页脚、sr-only、图例与数据标签、每张卡上的同一按钮、不同句子里的同一个词、以及无障碍名已给出的数值", () => {
    const w = audit(fixture("echo-ok.html"), "1440").report.report[0];
    expect(w.mustFix, JSON.stringify(w.mustFix)).toEqual({});
    expect(w.echoes, JSON.stringify(w.echoes)).toEqual([]);
    // 骨架和项目都会用 aria-hidden，报告要把认下的抑制标记数出来。
    expect(w.suppressed.ariaHidden.count).toBe(4);
  }, 120_000);

  it.skipIf(!available)("幻灯片：逐页审查，非当前页的缺陷也检出", () => {
    const { report } = audit(fixture("deck.html"));
    expect(report.report.map((w: { width: number }) => w.width)).toEqual([1920]);
    expect(report.report[0].slides).toBe(3);
    expect(report.report[0].mustFix.smallText?.length).toBe(1);
    expect(audit(fixture("deck-label.html")).report.report[0].slides).toBe(2);
  }, 120_000);

  it.skipIf(!available)("幻灯片行为：→ 不翻页、没有打印样式、讲者备注画在页上都是 must-fix，基线不继承；合格的幻灯片不报", () => {
    const bad = audit(fixture("deck.html")).report.report[0].mustFix;
    for (const k of ["deckPaging", "deckPrint", "notesOnScreen"]) expect(bad[k]?.length, k).toBe(1);
    expect(audit(fixture("deck.html"), "--baseline", fixture("deck-label.html")).report.report[0].mustFix.deckPaging?.length).toBe(1);
    const ok = audit(fixture("deck-ok.html")).report;
    expect(ok.total, JSON.stringify(ok.report[0].mustFix)).toBe(0);
    expect(ok.report[0].slides).toBe(2);
  }, 120_000);

  it.skipIf(!available)("独立文件：../ 路径、加载失败的图、禁止缩放是 must-fix；跳级标题和手机宽度上的小触控目标进 advisory，正文内联链接不算", () => {
    const [desk, mob] = audit(fixture("assets.html"), "1440,390").report.report;
    expect(desk.mustFix.localPath, JSON.stringify(desk.mustFix)).toEqual(["img ../outside.png"]);
    expect(desk.mustFix.brokenImage?.length).toBe(2);
    expect(desk.mustFix.noZoom?.length).toBe(1);
    expect(desk.advisory.headingSkip?.length).toBe(1);
    expect(desk.advisory.smallTarget).toBeUndefined();
    expect(mob.advisory.smallTarget, JSON.stringify(mob.advisory)).toHaveLength(1);
    expect(mob.advisory.smallTarget[0]).toContain("button.x");
  }, 120_000);

  it.skipIf(!available)("越滚越长的页面：预滚动跟着页面变长，最多 50 屏；无限加载照常结束并报扫描不完整，有限加载扫到尾部", () => {
    const r = audit(fixture("growing.html"), "1440");
    expect(r.status).toBe(0);
    expect(r.report.report[0].scrollCapped).toBe(true);
    // 只长两屏的懒加载：尾部滚到才出现的 9px 小字必须被检出，且不算扫描不完整。
    const once = audit(fixture("growing-once.html"), "1440");
    expect(once.report.report[0].scrollCapped).toBe(false);
    expect(Object.keys(once.report.report[0].mustFix)).toContain("smallText");
    // 滚到底后 200ms 才异步追加的一屏：预滚动要等一下再复查高度，跟上去检出尾部小字。
    const late = audit(fixture("growing-late.html"), "1440");
    expect(late.report.report[0].scrollCapped).toBe(false);
    expect(Object.keys(late.report.report[0].mustFix)).toContain("smallText");
    // 900ms 后才到的一屏错过了复查：没扫到就必须报扫描不完整，不能装作扫完。
    expect(audit(fixture("growing-too-late.html"), "1440").report.report[0].scrollCapped).toBe(true);
    // 晚到且不足半屏的一条：scrollTo 被夹在旧底部，这条从没进过视口，也要报扫描不完整。
    expect(audit(fixture("growing-tiny-late.html"), "1440").report.report[0].scrollCapped).toBe(true);
    expect(audit(fixture("clean.html"), "1440").report.report[0].scrollCapped).toBe(false);
    // 文档流里的页头滚动后收起、回到顶部又变高：页面没长出新内容，不能报扫描不完整。
    expect(audit(fixture("collapsing-header.html"), "1440").report.report[0].scrollCapped).toBe(false);
  }, 300_000);

  it.skipIf(!available)("文本输出以 next: 收尾：must-fix 数、看截图、用真实指针加 probe.js 操作；幻灯片多一条翻页与打印", () => {
    const run = spawnSync(process.execPath, [join(scripts, "audit.mjs"), fixture("deck.html")], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
    const next = run.stdout.slice(run.stdout.indexOf("\nnext:"));
    expect(next, run.stdout).toContain("fix the 4 must-fix");
    expect(next).toContain(join(scripts, "probe.js"));
    expect(next).toContain("page.mouse.click");
    expect(next).toContain("print preview");
    const page = spawnSync(process.execPath, [join(scripts, "audit.mjs"), fixture("clean.html"), "1440"], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 }).stdout;
    expect(page).toContain("must-fix is 0");
    expect(page).not.toContain("print preview");
    // --json 也要带上 next：不然 probe.js 和整个交互检查在这条路径上就没了。
    expect(audit(fixture("clean.html"), "1440").report.next).toContain(join(scripts, "probe.js"));
  }, 120_000);

  it.skipIf(!available)("--baseline：骨架带来的命中只计继承，同签名超出基线条数的和新加的才是 must-fix", () => {
    const { report } = audit(fixture("derived.html"), "1440", "--baseline", fixture("base.html"));
    const w = report.report[0];
    expect(w.mustFix.smallText).toHaveLength(2);
    expect(w.mustFix.smallText.join()).toContain("p.note");
    expect(w.mustFix.lowContrast).toHaveLength(1);
    expect(w.inherited).toEqual({ smallText: 1, lowContrast: 1 });
  }, 120_000);

  it.skipIf(!available)("--baseline：不变差的改色继承对比度命中，变差的算新增；多出的同类小字和外链字体仍是 must-fix", () => {
    const better = audit(fixture("palette-better.html"), "1440", "--baseline", fixture("palette-base.html")).report.report[0];
    expect(Object.keys(better.mustFix).sort()).toEqual(["externalResource", "smallText"]);
    expect(better.mustFix.smallText).toHaveLength(3);
    expect(better.inherited).toEqual({ smallText: 1, lowContrast: 3 });
    const worse = audit(fixture("palette-recolor.html"), "1440", "--baseline", fixture("palette-base.html")).report.report[0];
    expect(worse.mustFix.lowContrast).toHaveLength(3);
    expect(worse.inherited).toEqual({ smallText: 1 });
  }, 120_000);

  it.skipIf(!available)("骨架基线：骨架自身类名多出的卡片按签名继承样式键，只有新加的小字是 must-fix", () => {
    const w = audit(fixture("skeleton-derived.html"), "1440", "--baseline", fixture("skeleton/example.html")).report.report[0];
    expect(Object.keys(w.mustFix)).toEqual(["smallText"]);
    expect(w.mustFix.smallText).toHaveLength(1);
    expect(w.mustFix.smallText[0]).toContain("p.fine");
  }, 120_000);

  it.skipIf(!available)("不误报：sr-only 文字、带内边距的整宽行和段落；full-bleed 里的文字仍守边距，媒体不算", () => {
    expect(audit(fixture("a11y-rows.html"), "1440,390").report.total).toBe(0);
    const bleed = audit(fixture("full-bleed.html"), "1440,390").report;
    for (const w of bleed.report) expect(Object.keys(w.mustFix)).toEqual(["edge"]);
    for (const w of bleed.report) expect(w.mustFix.edge).toHaveLength(1);
    expect(bleed.report[0].mustFix.edge[0]).toContain("h1");
  }, 120_000);

  it.skipIf(!available)("轮播不算幻灯片：按页面在 1440 和 390 审；居中收缩的海报按海报本身当画布", () => {
    const car = audit(fixture("carousel.html")).report;
    expect(car.report.map((w: { width: number; kind: string }) => [w.width, w.kind])).toEqual([[1440, "page"], [390, "page"]]);
    expect(car.report[1].mustFix.smallText).toHaveLength(1);
    const poster = audit(fixture("poster-flex.html")).report.report;
    expect(poster).toHaveLength(1);
    expect(poster[0].kind).toBe("canvas");
    expect(Object.keys(poster[0].mustFix)).toEqual(["canvasBounds"]);
    expect(poster[0].mustFix.canvasBounds[0]).toContain("p.over");
  }, 120_000);

  it("--baseline 指向被审页面本身：警告并丢掉基线，缺陷不会被算成继承而把 must-fix 清零", () => {
    const self = audit(fixture("bad.html"), "1440", "--baseline", fixture("bad.html"));
    expect(self.stderr).toContain("is the audited page itself");
    if (!available) return;
    const plain = audit(fixture("bad.html"), "1440");
    expect(self.report.total).toBe(plain.report.total);
    expect(self.report.total).toBeGreaterThan(0);
    expect(self.report.report[0].inherited).toEqual({});
    expect(self.report.baselineIgnored).toContain("ignored");
  }, 200_000);

  it.skipIf(!available)("内容相同的另一份基线仍然继承：无限动画的光标和定时刷新的数据连跑三次都是 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-design-baseline-"));
    try {
      const copy = join(dir, "live-copy.html");
      copyFileSync(fixture("live.html"), copy);
      for (let i = 0; i < 3; i++) expect(audit(fixture("live.html"), "--baseline", copy).report.total).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 200_000);

  it.skipIf(!available)("文字密度：信息堆成段落的页面进 advisory；文章和结构化页面不报", () => {
    const dense = audit(fixture("dense.html"), "1440").report.report[0].advisory;
    expect(dense.textWall?.length).toBeGreaterThanOrEqual(4);
    expect(dense.denseFirstView).toHaveLength(1);
    for (const f of ["article.html", "structured.html"]) {
      for (const w of audit(fixture(f), "1440,390").report.report) {
        expect(w.advisory.textWall, f).toBeUndefined();
        expect(w.advisory.denseFirstView, f).toBeUndefined();
      }
    }
  }, 120_000);

  it.skipIf(!available)("不误报：禁用控件、sup、SVG 标签叠放、紧行高的展示标题和 18px 以上的中文标题", () => {
    expect(audit(fixture("disabled.html"), "1440,390").report.total).toBe(0);
    expect(audit(fixture("tight-heading.html"), "1440,390").report.total).toBe(0);
    const svg = audit(fixture("svg-labels.html"), "1440").report.report[0];
    expect(Object.keys(svg.mustFix)).toEqual(["textCollision"]);
  }, 120_000);

  it.skipIf(!available)("补检：占位符对比度为 must-fix，透明度 0 的文字、左边缘不齐、长页无分区导航进 advisory", () => {
    const w = audit(fixture("misses.html"), "1440").report.report[0];
    expect(w.mustFix.lowContrast?.[0]).toContain("placeholder");
    for (const k of ["invisibleText", "leftEdge", "noSectionNav"]) expect(w.advisory[k]?.length, k).toBe(1);
  }, 120_000);

  it.skipIf(!available)("固定画布：只按画布自身尺寸审一次，查越界而不查视口边距", () => {
    const { report } = audit(fixture("canvas.html"));
    expect(report.report).toHaveLength(1);
    expect(report.report[0].kind).toBe("canvas");
    expect(Object.keys(report.report[0].mustFix)).toEqual(["canvasBounds"]);
    expect(report.report[0].mustFix.canvasBounds).toHaveLength(1);
  }, 120_000);

  it.skipIf(!available)("截断：title 含全文不报；卡片里旁边有打开链接的进 advisory；链接里或无从得知全文的仍是 must-fix", () => {
    for (const w of audit(fixture("truncate-reachable.html"), "1440,390").report.report) {
      expect(w.mustFix.truncated).toHaveLength(2);
      expect(w.mustFix.truncated.join()).toContain("unreachable");
      expect(w.advisory.truncated).toHaveLength(1);
    }
  }, 120_000);

  it.skipIf(!available)("截断：按钮、导航、菜单项自己的标签被截是 must-fix；aria-label 含全文不报；title 不含全文不算", () => {
    for (const w of audit(fixture("truncate-control.html"), "1440,390").report.report) {
      expect(w.mustFix.truncated.map((m: string) => m.split(" ")[0])).toEqual(["button.cut", "span.cut", "div.cut"]);
      expect(w.mustFix.truncated.join()).not.toContain("Annual");
    }
  }, 120_000);

  it.skipIf(!available)("没跑的 opacity-0 揭示即使绝对定位且 pointer-events:none 也报；role=tooltip 不报；真实溢出推出右边的文字算 edge", () => {
    const [desk, mob] = audit(fixture("reveal-overflow.html"), "1440,390").report.report;
    for (const w of [desk, mob]) expect(w.advisory.invisibleText?.join(), JSON.stringify(w.advisory)).toContain("hero claim");
    for (const w of [desk, mob]) expect(w.advisory.invisibleText).toHaveLength(1);
    expect(mob.mustFix.edge).toHaveLength(3);
  }, 120_000);

  it.skipIf(!available)("noSectionNav：一排重复的 logo 不算看板，长落地页照报", () => {
    for (const w of audit(fixture("landing-logos.html"), "1440,390").report.report) expect(w.advisory.noSectionNav).toHaveLength(1);
  }, 120_000);

  it.skipIf(!available)("边距：按被 overflow 裁掉之后实际画出的文字量，390 下省略号单元格不报", () => {
    expect(audit(fixture("edge-clipped.html"), "1440,390").report.total).toBe(0);
  }, 120_000);

  it.skipIf(!available)("已折叠：max-height:0 手风琴、移出屏幕的抽屉、pointer-events:none 的提示不计入文字墙和不可见文字", () => {
    for (const w of audit(fixture("folded.html"), "1440,390").report.report) {
      expect(w.mustFix, JSON.stringify(w.mustFix)).toEqual({});
      for (const k of ["textWall", "denseFirstView", "invisibleText"]) expect(w.advisory[k], k).toBeUndefined();
    }
  }, 120_000);

  it.skipIf(!available)("真实项目对改版基线：项目自己的外链和报错继承并列出；独立 HTML 交付不继承", () => {
    const args = [fixture("project-new.html"), "1440", "--baseline", fixture("project-base.html")];
    const proj = audit(...args, "--project").report.report[0];
    expect(proj.mustFix).toEqual({});
    expect(proj.inherited).toEqual({ externalResource: 1, consoleError: 1 });
    expect(proj.inheritedItems.consoleError[0]).toContain("legacy prop");
    expect(Object.keys(audit(...args).report.report[0].mustFix).sort()).toEqual(["consoleError", "externalResource"]);
  }, 120_000);

  it.skipIf(!available)("probe.js：视口外的结果不算可见；原地小计数变化算；环境动画、定时器、慢刷新数据和上一个控件留下的焦点悬停都不算；label 里复选框的伪元素开关算控件变化，只有 :focus 样式的死按钮不算；watch 之前调用 changes 不抛错", () => {
    const code = `
      import fs from "node:fs";
      const { loadPlaywright, launch } = await import(${JSON.stringify(pathToFileURL(join(scripts, "audit.mjs")).href)});
      const browser = await launch(loadPlaywright());
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const out = {};
      // No mouse parking: focus and hover stay on the last control, as in real multi-action use.
      for (const [file, ids] of [["probe.html", ["hidden", "shown"]], ["probe-counter.html", ["add"]], ["probe-ambient.html", ["noop"]], ["probe-multi.html", ["t2", "dead", "t1", "dead"]], ["probe-switch.html", ["sw"]], ["probe-toggle.html", ["tg", "dead"]], ["probe-motion.html", ["soft", "snap"]], ["probe-instant.html", ["tab2", "sw", "more"]], ["probe-filter.html", ["filter", "drop", "fold"]]]) {
        await page.goto(${JSON.stringify(pathToFileURL(fixture("x")).href.slice(0, -1))} + file);
        await page.evaluate(fs.readFileSync(${JSON.stringify(join(scripts, "probe.js"))}, "utf8"));
        out.early ||= await page.evaluate(() => designProbe.changes());
        for (const [n, id] of ids.entries()) {
          await page.evaluate(() => designProbe.watch());
          const box = await page.locator("#" + id).boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(150);
          out[file + ":" + n + ":" + id] = await page.evaluate(() => designProbe.changes());
        }
      }
      console.log(JSON.stringify(out));
      await browser.close();`;
    const run = spawnSync("node", ["--input-type=module", "-e", code], { cwd: repoRoot, encoding: "utf8", timeout: 110_000 });
    const out = JSON.parse(run.stdout || "{}");
    expect(out.early?.error, run.stderr).toContain("watch");
    const v = (k: string) => out[k]?.visible;
    expect(v("probe.html:0:hidden"), JSON.stringify(out)).toBe(false);
    expect(v("probe.html:1:shown")).toBe(true);
    expect(v("probe-counter.html:0:add")).toBe(true);
    expect(v("probe-ambient.html:0:noop")).toBe(false);
    expect(out["probe-switch.html:0:sw"]?.controlChangedOnly, JSON.stringify(out)).toBe(true);
    expect(out["probe-toggle.html:0:tg"]?.controlChangedOnly, JSON.stringify(out)).toBe(true);
    expect(out["probe-toggle.html:1:dead"]?.controlChangedOnly, JSON.stringify(out)).toBe(false);
    expect([0, 1, 2, 3].map((n) => v(`probe-multi.html:${n}:${["t2", "dead", "t1", "dead"][n]}`)), JSON.stringify(out)).toEqual([true, false, true, false]);
    expect(out["probe.html:0:hidden"]?.hints?.join()).toContain("no result in view");
    expect(out["probe-motion.html:0:soft"]?.animated, JSON.stringify(out)).toBe(true);
    expect(out["probe-motion.html:1:snap"]?.animated, JSON.stringify(out)).toBe(false);
    expect(out["probe-motion.html:1:snap"]?.hints?.join()).toContain("no transition");
    // Hover box-shadow on the control is not its toggle animation; tab content swaps get no transition hint; an instant menu does.
    expect(out["probe-instant.html:0:tab2"]?.hints?.join() || "", JSON.stringify(out)).not.toContain("no transition");
    expect(out["probe-instant.html:1:sw"]?.animated, JSON.stringify(out)).toBe(false);
    expect(out["probe-instant.html:1:sw"]?.hints?.join()).toContain("no transition");
    expect(out["probe-instant.html:2:more"]?.hints?.join(), JSON.stringify(out)).toContain("no transition");
    // Filtering or shrinking a list is a content swap; collapsing a region is not.
    expect(out["probe-filter.html:0:filter"]?.hints?.join() || "", JSON.stringify(out)).not.toContain("no transition");
    expect(out["probe-filter.html:1:drop"]?.hints?.join() || "", JSON.stringify(out)).not.toContain("no transition");
    expect(out["probe-filter.html:2:fold"]?.hints?.join(), JSON.stringify(out)).toContain("no transition");
  }, 120_000);

  it.skipIf(!available)("probe.js：点在透明遮罩上、没有真实指针输入时，hints 说出原因和做法", () => {
    const code = `
      import fs from "node:fs";
      const { loadPlaywright, launch } = await import(${JSON.stringify(pathToFileURL(join(scripts, "audit.mjs")).href)});
      const browser = await launch(loadPlaywright());
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const probe = fs.readFileSync(${JSON.stringify(join(scripts, "probe.js"))}, "utf8"), out = {};
      await page.goto(${JSON.stringify(pathToFileURL(fixture("probe-ghost.html")).href)});
      await page.evaluate(probe);
      await page.evaluate(() => designProbe.watch());
      const box = await page.locator("#open").boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      out.ghost = await page.evaluate(() => designProbe.changes());
      await page.goto(${JSON.stringify(pathToFileURL(fixture("probe.html")).href)});
      await page.evaluate(probe);
      await page.evaluate(() => designProbe.watch());
      await page.evaluate(() => document.querySelector("#shown").click());
      out.synthetic = await page.evaluate(() => designProbe.changes());
      await page.evaluate(() => designProbe.watch());
      const b2 = await page.locator("#shown").boundingBox();
      await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
      out.real = await page.evaluate(() => designProbe.changes());
      console.log(JSON.stringify(out));
      await browser.close();`;
    const run = spawnSync("node", ["--input-type=module", "-e", code], { cwd: repoRoot, encoding: "utf8", timeout: 110_000 });
    const out = JSON.parse(run.stdout || "{}");
    expect(out.ghost?.hints?.join(), run.stderr).toContain("invisible layer (div#scrim");
    expect(out.ghost.hints.join()).toContain("pointer-events:none");
    expect(out.synthetic?.hints?.join()).toContain("no pointer input reached the page");
    expect(out.real?.visible).toBe(true);
    expect(out.real?.hints?.join() || "").not.toMatch(/pointer input|invisible layer/);
  }, 120_000);

  it.skipIf(!available)("动效：减弱动效下仍在循环是 must-fix；transition all、布局属性、无减弱规则、两条跑马灯、首尾帧不一致、无暂停的大循环、脚本驱动的移动进 advisory；缓动、起始缩放这类画法不再判定；克制的动效不报", () => {
    const [desk, mob] = audit(fixture("motion-bad.html")).report.report;
    expect(Object.keys(desk.mustFix).sort(), JSON.stringify(desk.mustFix)).toEqual(["reducedMotion"]);
    expect(desk.mustFix.reducedMotion).toHaveLength(3);
    expect(Object.keys(mob.mustFix).sort()).toEqual([]);
    expect(desk.advisory.slowTransition).toHaveLength(1);
    for (const k of ["transitionAll", "layoutAnimation", "noReducedMotion", "marquee", "loopSeam", "noPauseControl"]) expect(desk.advisory[k], k).toHaveLength(1);
    // 画法交给设计者：ease-in、回弹缓动、scale(0) 起始在规则层已无依据，审查不再报。
    for (const k of ["easeIn", "bouncyEase", "scaleFromZero"]) expect(desk.advisory[k], k).toBeUndefined();
    expect(desk.advisory.reducedMotionScript?.join()).toContain("div.orb");
    for (const w of audit(fixture("motion-clean.html")).report.report) {
      expect(w.mustFix, JSON.stringify(w.mustFix)).toEqual({});
      expect(w.advisory, JSON.stringify(w.advisory)).toEqual({});
    }
  }, 120_000);

  it.skipIf(!available)("slowTransition：产品界面（推断或 --surface operate）是 must-fix；落地页、未知表面和 --surface persuade 是 advisory", () => {
    const at = (f: string, ...a: string[]) => audit(fixture(f), "1440", ...a).report.report[0];
    expect(at("slow-app.html").mustFix.slowTransition).toHaveLength(1);
    expect(at("slow-app.html", "--surface", "persuade").mustFix.slowTransition).toBeUndefined();
    expect(at("slow-landing.html").mustFix.slowTransition).toBeUndefined();
    expect(at("slow-landing.html").advisory.slowTransition).toHaveLength(1);
    expect(at("slow-landing.html", "--surface", "operate").mustFix.slowTransition).toHaveLength(1);
    // Docs with a side rail and a toolbar are not product UI; link color fades stay advisory even on operate.
    expect(at("slow-docs.html").mustFix.slowTransition).toBeUndefined();
    expect(at("slow-docs.html").advisory.slowTransition).toHaveLength(1);
    expect(at("slow-docs.html", "--surface", "operate").mustFix.slowTransition).toBeUndefined();
    const warn = spawnSync("node", [join(scripts, "audit.mjs"), fixture("slow-docs.html"), "1440", "--surface", "docs", "--json"], { cwd: repoRoot, encoding: "utf8", timeout: 110_000 });
    expect(warn.stderr).toContain('unknown --surface "docs"');
    // An unknown surface still infers: the app stays must-fix; the must-fix move is not hidden behind an earlier color fade.
    expect(at("slow-app.html", "--surface", "docs").mustFix.slowTransition).toHaveLength(1);
    expect(at("slow-mixed.html").mustFix.slowTransition?.join()).toContain("transform");
  }, 120_000);

  it.skipIf(!available)("reducedMotion：进度指示（role=status/progressbar/aria-busy 下、只转圈、3 秒内的背景位移微光）继续跑不报；装饰循环照报", () => {
    const [desk] = audit(fixture("reduced-progress.html"), "1440").report.report;
    expect(desk.mustFix.reducedMotion, JSON.stringify(desk.mustFix)).toEqual([expect.stringContaining("div.blob")]);
  }, 120_000);

  it.skipIf(!available)("整卡链接里被截的标题和摘要算内容，进 advisory 而非 must-fix", () => {
    for (const w of audit(fixture("truncate-card.html"), "1440,390").report.report) {
      expect(w.mustFix.truncated).toBeUndefined();
      expect(w.advisory.truncated).toHaveLength(16);
    }
  }, 120_000);

  it.skipIf(!available)("noSectionNav：三栏评价墙不算看板照报；带列标题的看板列不报", () => {
    for (const w of audit(fixture("testimonial-wall.html"), "1440,390").report.report) expect(w.advisory.noSectionNav).toHaveLength(1);
    for (const w of audit(fixture("board.html"), "1440,390").report.report) expect(w.advisory.noSectionNav).toBeUndefined();
  }, 120_000);

  it("classify：签名带 core 的（正文、控件标签、手机宽度横向溢出）永不继承，骨架基线也不行；装饰性小字照旧继承", async () => {
    const { classify, summarize } = await import(pathToFileURL(join(scripts, "audit.mjs")).href);
    const hits = {
      smallText: [["smallText|p.body|13|core", '13px p.body "long copy" @0,0'], ["smallText|span.tag|11", '11px span.tag "tag" @0,0']],
      lowContrast: [["lowContrast|button.cta|core", '3.00:1 14px button.cta "Buy" @0,0', 3]],
      horizontalOverflow: [["horizontalOverflow|page|core", "scrollWidth 500 > 390"]],
    };
    const base = summarize(hits);
    for (const skeleton of [false, true]) {
      const c = classify(hits, base, skeleton);
      expect(c.own.smallText, `skeleton=${skeleton}`).toEqual(['13px p.body "long copy" @0,0']);
      expect(c.own.lowContrast).toHaveLength(1);
      expect(c.own.horizontalOverflow).toHaveLength(1);
      expect(c.inherited).toEqual({ smallText: 1 });
    }
  });

  it.skipIf(!available)("must-fix 总数按缺陷算：两档视口看到的同一条只算一次，只在一档出现的标出来", () => {
    const one = audit(fixture("bad.html"), "1440").report;
    const two = audit(fixture("bad.html"), "1440,390").report;
    expect(one.total).toBeGreaterThan(0);
    expect(two.total, JSON.stringify(two.perWidth)).toBe(one.total);
    expect(two.perWidth).toEqual([[1440, one.total], [390, one.total]]);
    const out = text(fixture("bad.html"));
    expect(out).toContain(`must-fix total: ${one.total} distinct`);
    expect(out).toContain(`fix the ${one.total} must-fix finding(s)`);
    // 只有手机宽度溢出的那三条要标清楚，别让人以为两档都有。
    expect(text(fixture("reveal-overflow.html"))).toContain("[this width only]");
  }, 200_000);

  it.skipIf(!available)("边距：全宽媒体不标记也不算缺陷，video 和 h5/h6 进检查范围，命中说出是哪一边", () => {
    const { report, total } = audit(fixture("edge-media.html"), "1440,390").report;
    expect(total).toBe(2);
    for (const w of report) {
      expect(Object.keys(w.mustFix), JSON.stringify(w.mustFix)).toEqual(["edge"]);
      expect(w.mustFix.edge).toHaveLength(2);
      expect(w.mustFix.edge[0]).toContain("4px from the left video.inset");
      expect(w.mustFix.edge[1]).toContain("h6");
    }
    // 旧格式 "L4 R1325" 看着像两处违例。
    expect(report[0].mustFix.edge.join()).not.toMatch(/\bR\d/);
  }, 120_000);

  it.skipIf(!available)("advisory：默认列第一处并说还剩几处，--all 全部列出", () => {
    const plain = text(fixture("truncate-card.html"), "1440");
    expect(plain).toContain("... 15 more (--all)");
    const all = text(fixture("truncate-card.html"), "1440", "--all");
    expect(all).not.toContain("more (--all)");
    expect(all.split("\n").filter((l) => l.includes("truncate") || l.includes("full rebr")).length).toBeGreaterThan(5);
  }, 200_000);

  it("没跑起来的时候不让看不存在的截图", async () => {
    const { nextSteps } = await import(pathToFileURL(join(scripts, "audit.mjs")).href);
    const t = nextSteps({ notRun: true });
    expect(t).not.toContain("look at the screenshots");
    expect(t).toContain("capture the page yourself");
    expect(t).toContain("took no screenshots");
    expect(nextSteps({ total: 2 })).toContain("look at the screenshots");
  });

  it("--baseline 是占位符或不存在的路径：警告后照常审，不再 exit 1", () => {
    const ph = audit(fixture("bad.html"), "1440", "--baseline", "<skeleton example.html or the original's snapshot>");
    expect(ph.stderr).toContain("placeholder");
    expect(ph.stderr).toContain("--baseline ignored");
    if (!available) return;
    expect(ph.status).toBe(0);
    expect(ph.report.total).toBe(audit(fixture("bad.html"), "1440").report.total);
    // 被审页面本身不存在还是用法错误。
    const miss = audit(join(tmpdir(), "no-such-page.html"), "1440");
    expect(miss.status).toBe(1);
  }, 200_000);

  it.skipIf(!available)("继承不是已解决：抄骨架的页面先看到 --baseline 提示，再看到命中；继承条数要写进交付", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-design-skeleton-"));
    try {
      const ex = join(skeletons, "docs-page", "example.html");
      const copy = join(dir, "page.html");
      copyFileSync(ex, copy);
      const out = text(copy, "1440");
      expect(out.indexOf("looks derived from"), out.slice(0, 400)).toBe(0);
      expect(out.indexOf("looks derived from")).toBeLessThan(out.indexOf("== 1440px"));
      expect(out).toContain(`re-run with --baseline ${ex}`);
      const based = text(copy, "1440", "--baseline", ex);
      expect(based).toContain("reported and not resolved");
      expect(based).toMatch(/inherited hit\(s\) are reported, not resolved/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 200_000);

  it.skipIf(!available)("reducedMotion：同名循环的两个元素各带坐标，不再是两条一模一样的话", () => {
    const d = audit(fixture("motion-bad.html")).report.report[0];
    expect(d.mustFix.reducedMotion).toHaveLength(3);
    expect(new Set(d.mustFix.reducedMotion).size).toBe(3);
    for (const m of d.mustFix.reducedMotion) expect(m).toMatch(/@-?\d+,-?\d+$/);
    expect(d.advisory.reducedMotionScript[0]).toMatch(/@-?\d+,-?\d+$/);
  }, 120_000);

  it("截图目录有上限：一天前的清掉，一天内保留最近 N 个，别人的目录不动", async () => {
    const { sweepShots } = await import(pathToFileURL(join(scripts, "audit.mjs")).href);
    const dir = mkdtempSync(join(tmpdir(), "zcode-design-shots-"));
    try {
      const old = join(dir, "design-audit-old");
      mkdirSync(old);
      const then = (Date.now() - 3 * 864e5) / 1000;
      utimesSync(old, then, then);
      const fresh = ["design-audit-a", "design-audit-b", "design-audit-c"].map((n) => join(dir, n));
      fresh.forEach((d, i) => { mkdirSync(d); const t = (Date.now() - (3 - i) * 60_000) / 1000; utimesSync(d, t, t); });
      mkdirSync(join(dir, "someone-else"));
      expect(sweepShots(dir, 864e5, 2)).toBe(2);
      expect(existsSync(old)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(["design-audit-b", "design-audit-c", "someone-else"]);
      expect(sweepShots(join(dir, "gone"))).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
