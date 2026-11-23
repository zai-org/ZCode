import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCK_BEGIN, BLOCK_END, CONFIG, TARGETS, TRACKS, buildAll, collectResources, firstSentence, resolveCraft } from "../skills/design/scripts/build-catalog.mjs";
import { parseFrontmatter, splitFrontmatter } from "../skills/design/scripts/frontmatter.mjs";

// references/catalog.md 与 deck / app / page.md 里的骨架块由 build-catalog.mjs 从 design-resources 生成；这里守住新鲜度、体量、覆盖和配置漂移。
const skillRoot = fileURLToPath(new URL("../skills/design/", import.meta.url));
const resourceRoot = join(skillRoot, "design-resources");
const script = join(skillRoot, "scripts", "build-catalog.mjs");
const referencesDir = join(skillRoot, "references");
const committed = readFileSync(join(referencesDir, "catalog.md"), "utf8");
const trackText: Record<string, string> = Object.fromEntries(TRACKS.map((t: string) => [t, readFileSync(join(referencesDir, `${t}.md`), "utf8")]));
const blockOf = (text: string) => text.slice(text.indexOf(BLOCK_BEGIN), text.indexOf(BLOCK_END) + BLOCK_END.length);
// 骨架清单分在三份交付物文件的生成块里，合起来才等于旧 catalog 的 Skeletons 一节。
const skeletonText = TRACKS.map((t: string) => blockOf(trackText[t] as string)).join("\n");
const generated = () => buildAll(resourceRoot, referencesDir) as Map<string, string>;
const resources = collectResources(resourceRoot);
const allSkeletonNames: string[] = [...resources.skeletons.keys()];
const excluded: string[] = CONFIG.excludeSkeletons;
// 依赖 Open Design 运行时的骨架留在磁盘上但不列出；其余都要恰好列一次。
const skeletonNames: string[] = allSkeletonNames.filter((n) => !excluded.includes(n));
const skillNames: string[] = [...resources.skills.keys()];
const systemNames: string[] = [...resources.systems.keys()];
const craftNames: string[] = resources.craft;

type Category = { key: string; title: string; prefix?: string; craft: string[]; members: string[] };
type Missing = { label?: string; inline?: string; paths: string[]; usedBy: string[] };
const categories: Category[] = CONFIG.categories;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`catalog 缺少 ## ${title}`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start + 1, end < 0 ? undefined : end);
}

// 从 catalog 文本反解出每一节列出的名称，以及按该节路径模板展开后的文件路径。
function listed(text: string) {
  const template = (body: string) => {
    const found = body.split("\n")[1]?.match(/`(design-resources\/[^`]*<name>[^`]*)`/)?.[1];
    if (!found) throw new Error(`缺少路径模板：${body.split("\n")[0]}`);
    return found;
  };
  const skeletons: string[] = [];
  let prefix = "";
  for (const line of skeletonText.split("\n")) {
    if (line.startsWith("### ")) prefix = line.match(/`([a-z0-9-]+-)<x>`/)?.[1] ?? "";
    const name = line.match(/^- `([^`]+)`/)?.[1];
    if (name) skeletons.push(prefix + name);
  }
  const rowNames = (title: string) =>
    section(text, title)
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .flatMap((line) => [...line.replace(/ — .*$/, "").matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1] as string));
  const names = {
    skeletons,
    skills: rowNames("Skills"),
    systems: rowNames("Design systems"),
    craft: rowNames("Craft"),
  };
  const paths = [
    ...names.skeletons.map((n) => template(`skeletons\n${skeletonText.split("\n").find((l) => l.startsWith("`design-resources/")) ?? ""}`).replace("<name>", n)),
    ...names.skills.map((n) => template(section(text, "Skills")).replace("<name>", n)),
    ...names.systems.map((n) => template(section(text, "Design systems")).replace("<name>", n)),
    ...names.craft.map((n) => template(section(text, "Craft")).replace("<name>", n)),
  ];
  return { names, paths };
}

const skeletonRow = (name: string) => {
  const category = categories.find((c) => c.members.includes(name)) as Category;
  const label = category.prefix ? name.slice(category.prefix.length) : name;
  return skeletonText.split("\n").find((line) => line.startsWith(`- \`${label}\``)) ?? "";
};

describe("生成文件的新鲜度与体量", () => {
  it("catalog.md 与三份交付物文件的骨架块都与 build-catalog.mjs 的生成结果逐字节一致", () => {
    const built = generated();
    expect([...built.keys()].sort()).toEqual(["app.md", "catalog.md", "deck.md", "page.md"]);
    expect(Object.values(TARGETS).map((t) => (t as { file: string }).file).sort()).toEqual([...built.keys()].sort());
    for (const [file, text] of built) {
      expect(text, `${file} 过期：运行 node skills/design/scripts/build-catalog.mjs`).toBe(readFileSync(join(referencesDir, file), "utf8"));
    }
  });

  it("生成结果确定：两次相同，无时间戳、绝对路径和 CR；catalog 以单个 LF 结尾；每份交付物文件恰有一对标记", () => {
    expect(generated()).toEqual(generated());
    for (const text of [committed, skeletonText]) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/);
      expect(text).not.toContain(skillRoot);
      expect(text).not.toMatch(/\]\(\/|`\/|\$\{[A-Z_]+\}/);
      expect(text).not.toContain("\r");
    }
    expect(committed.endsWith("\n") && !committed.endsWith("\n\n")).toBe(true);
    for (const t of TRACKS) {
      expect(trackText[t]?.split(BLOCK_BEGIN).length, t).toBe(2);
      expect(trackText[t]?.split(BLOCK_END).length, t).toBe(2);
    }
  });

  it("每份生成目标不超过自己的体量上限和 500 行；超过 100 行时顶部有 Contents", () => {
    expect(Object.fromEntries(Object.entries(TARGETS).map(([k, v]) => [k, (v as { maxBytes: number }).maxBytes]))).toEqual({ catalog: 6144, deck: 6144, app: 5120, page: 5120 });
    for (const [file, text] of generated()) {
      const target = Object.values(TARGETS).find((t) => (t as { file: string }).file === file) as { maxBytes: number };
      expect(Buffer.byteLength(text, "utf8"), file).toBeLessThanOrEqual(target.maxBytes);
      const lines = text.split("\n").length - 1;
      expect(lines, file).toBeLessThanOrEqual(500);
      if (lines > 100) expect(text.split("\n").slice(0, 12).some((line) => line.startsWith("Contents: ")), file).toBe(true);
    }
  });

  it("超过上限时非零退出、不写任何文件，并输出分段体量；未超时重写出同样的内容", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-design-catalog-"));
    try {
      cpSync(referencesDir, dir, { recursive: true });
      const before = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
      const run = spawnSync(process.execPath, [script, "--max-bytes=1000", `--dir=${dir}`], { encoding: "utf8", timeout: 20000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("over the 1000 B cap");
      for (const title of ["(head)", "Skills", "Design systems", "Craft", "Deck — specific need", "Dashboard", "App"]) expect(run.stderr, title).toContain(title);
      expect(Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]))).toEqual(before);
      writeFileSync(join(dir, "app.md"), readFileSync(join(dir, "app.md"), "utf8").replace(/`mobile-app`/, "`stale`"));
      const ok = spawnSync(process.execPath, [script, `--dir=${dir}`], { encoding: "utf8", timeout: 20000 });
      expect(ok.status).toBe(0);
      for (const f of ["catalog.md", "deck.md", "app.md", "page.md"]) expect(readFileSync(join(dir, f), "utf8"), f).toBe(readFileSync(join(referencesDir, f), "utf8"));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("catalog.md 覆盖与对应", () => {
  const { names, paths } = listed(committed);

  it("每个骨架、技能、设计系统和 craft 都列出或明确排除；列出的每项都能解析到随包文件", () => {
    expect(sorted(names.skeletons)).toEqual(sorted(skeletonNames));
    expect(names.skeletons).toHaveLength(skeletonNames.length);
    expect(sorted([...names.skills, ...CONFIG.skills.exclude])).toEqual(sorted(skillNames));
    expect(names.skills.filter((n) => CONFIG.skills.exclude.includes(n))).toEqual([]);
    expect(sorted(names.systems)).toEqual(sorted(systemNames));
    expect(sorted(names.craft)).toEqual(sorted(craftNames));
    expect(paths.length).toBeGreaterThan(100);
    expect(paths.filter((path) => !existsSync(join(skillRoot, ...path.split("/"))))).toEqual([]);
  });

  it("配置里的每个名称都对应真实资源", () => {
    const skeletonRefs = [
      ...categories.flatMap((c) => c.members),
      ...CONFIG.nameOnly,
      ...Object.keys(CONFIG.override),
      ...CONFIG.notes.flatMap((n: { names: string[] }) => n.names),
      ...CONFIG.missing.flatMap((m: { usedBy: string[] }) => m.usedBy),
    ];
    expect(skeletonRefs.filter((n) => !skeletonNames.includes(n))).toEqual([]);
    expect(excluded.filter((n) => !allSkeletonNames.includes(n))).toEqual([]);
    const skillRefs = [...CONFIG.skills.exclude, ...Object.keys(CONFIG.skills.override), ...CONFIG.nameMismatch];
    expect(skillRefs.filter((n) => !skillNames.includes(n))).toEqual([]);
    const systemRefs = [...Object.keys(CONFIG.systemNotes), ...Object.keys(CONFIG.systemOverride)];
    expect(systemRefs.filter((n) => !systemNames.includes(n))).toEqual([]);
    const craftRefs = [...CONFIG.craftBaseline, ...CONFIG.craftConditional, ...Object.values(CONFIG.craftAlias as Record<string, string>), ...categories.flatMap((c) => c.craft)];
    expect(craftRefs.filter((n) => !craftNames.includes(n))).toEqual([]);
    // 未随包的名字一旦随包，丢弃表和别名表就过期了。
    expect([...CONFIG.craftDrop, ...Object.keys(CONFIG.craftAlias)].filter((n) => craftNames.includes(n))).toEqual([]);
    // 每条注记挂在同一类别下。
    for (const note of CONFIG.notes as { names: string[] }[]) {
      const keys = new Set(note.names.map((n) => categories.find((c) => c.members.includes(n))?.key));
      expect(keys.size, note.names.join(",")).toBe(1);
    }
  });

  it("每个骨架恰好属于一个类别；设计系统的 Category 都在分组表里；craft 目录等于 CONFIG.craft 的键", () => {
    const members = categories.flatMap((c) => c.members);
    expect(sorted(members)).toEqual(sorted(skeletonNames));
    expect(members).toHaveLength(skeletonNames.length);
    const unknown = systemNames.filter((n) => !(resources.systems.get(n).category in CONFIG.systemGroups)).map((n) => `${n}: ${resources.systems.get(n).category}`);
    expect(unknown).toEqual([]);
    expect(sorted(Object.keys(CONFIG.craft))).toEqual(sorted(craftNames));
  });

  it("骨架声明的 craft 都能解析：在 craft/、别名、丢弃或条件表里", () => {
    const unresolved: string[] = [];
    for (const [name, { frontmatter }] of resources.skeletons) {
      for (const craft of frontmatter.od?.craft?.requires ?? []) {
        const target = resolveCraft(craft);
        if (target !== null && !craftNames.includes(target)) unresolved.push(`${name}: ${craft}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});

describe("design-resources 输入数据质量", () => {
  const files = [
    ...skeletonNames.map((n) => ({ dir: n, file: join(resourceRoot, "design-skeletons", n, "SKILL.md") })),
    ...skillNames.map((n) => ({ dir: n, file: join(resourceRoot, "skills", n, "SKILL.md") })),
  ];

  it("每个 SKILL.md 有 frontmatter，name 等于目录名（已知例外除外），description 非空，triggers 是字符串数组", () => {
    expect(files.length).toBeGreaterThan(75);
    const problems: string[] = [];
    for (const { dir, file } of files) {
      const raw = splitFrontmatter(readFileSync(file, "utf8"));
      if (raw === null) {
        problems.push(`${dir}: no frontmatter`);
        continue;
      }
      const fm = parseFrontmatter(raw);
      if ((fm.name === dir) === CONFIG.nameMismatch.includes(dir)) problems.push(`${dir}: name ${fm.name}`);
      if (typeof fm.description !== "string" || fm.description.trim() === "") problems.push(`${dir}: description`);
      if (fm.triggers !== undefined && !(Array.isArray(fm.triggers) && fm.triggers.every((t: unknown) => typeof t === "string"))) {
        problems.push(`${dir}: triggers`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("描述首句被截断（不足 20 字符或以 — / : 结尾，如 YAML 把 ` #` 当注释）时必须有覆盖句", () => {
    const suspicious = (description: string) => {
      const sentence = firstSentence(description);
      return [...sentence].length < 20 || /[—:]$/.test(sentence);
    };
    const bad = [
      ...[...resources.skeletons].filter(([n, { frontmatter }]) => !(n in CONFIG.override) && suspicious(frontmatter.description)),
      ...[...resources.skills].filter(([n, { frontmatter }]) => !(n in CONFIG.skills.override) && suspicious(frontmatter.description)),
    ].map(([n]) => n);
    expect(bad).toEqual([]);
    expect(suspicious(resources.skeletons.get("html-ppt-hermes-cyber-terminal").frontmatter.description)).toBe(true);
  });

  describe("frontmatter 解析器", () => {
    it("块标量、折叠标量、跨行流式列表、列表里的映射、行内注释", () => {
      const fm = parseFrontmatter(
        [
          "name: demo",
          "description: |",
          "  First line.",
          "  Second line.",
          "summary: >",
          "  folded",
          "  text",
          "triggers:",
          '  - "quoted, with comma"',
          "  - bare words",
          "od:",
          "  craft:",
          "    requires: [typography, color,",
          "      laws-of-ux]",
          "  default: 198 # Notion-blue",
          "  note: dark #0a0c10 canvas",
          "  inputs:",
          "    - name: title",
          "      type: string",
          "  design_system:",
          "    requires: false",
        ].join("\n"),
      );
      expect(fm.description).toBe("First line.\nSecond line.");
      expect(fm.summary).toBe("folded text");
      expect(fm.triggers).toEqual(["quoted, with comma", "bare words"]);
      expect(fm.od.craft.requires).toEqual(["typography", "color", "laws-of-ux"]);
      expect(fm.od.default).toBe(198);
      expect(fm.od.note).toBe("dark");
      expect(fm.od.inputs).toEqual([{ name: "title", type: "string" }]);
      expect(fm.od.design_system.requires).toBe(false);
    });

    it("兼容 CRLF 与 BOM", () => {
      const text = "\uFEFF---\r\nname: demo\r\ndescription: |\r\n  a\r\n  b\r\n---\r\nbody\r\n";
      const raw = splitFrontmatter(text);
      expect(raw).not.toBeNull();
      expect(parseFrontmatter(raw)).toEqual({ name: "demo", description: "a\nb" });
      expect(splitFrontmatter("# no frontmatter\n")).toBeNull();
    });

    it("不认识的构造直接抛错，不静默跳过", () => {
      for (const source of ['description: "starts here', "od: {mode: deck}", "base: &anchor x", "ref: *anchor", "tag: !str x", "just text", "a: 1\n   b: 2"]) {
        expect(() => parseFrontmatter(source), source).toThrow();
      }
    });
  });
});

describe("catalog.md 内容", () => {
  it("hermes 行用覆盖句而不是被 YAML 截断的描述；broadside 行带 editorial", () => {
    const hermes = skeletonRow("html-ppt-hermes-cyber-terminal");
    expect(hermes).toContain(CONFIG.override["html-ppt-hermes-cyber-terminal"]);
    expect(hermes).not.toMatch(/deck —\s*(\[|$)/);
    expect(skeletonRow("html-ppt-zhangzara-broadside")).toContain("editorial");
  });

  it("缺文件警示仍然成立：被点名的文件依旧未随包，写在被引用骨架所在那一档的块里", () => {
    for (const { label, paths, usedBy, inline } of CONFIG.missing as Missing[]) {
      const track = (categories.find((c) => c.members.includes(usedBy[0] as string)) as Category & { track: string }).track;
      // label 走那一档末尾的合并警示句，inline 走骨架自己那一行；两种恰有一种。
      expect(Boolean(label) !== Boolean(inline), usedBy.join(",")).toBe(true);
      if (label) expect(blockOf(trackText[track] as string), label).toContain(label);
      if (inline) for (const name of usedBy) expect(skeletonRow(name), name).toContain(inline);
      for (const path of paths) {
        expect(existsSync(join(resourceRoot, ...path.split("/"))), `${path} 已随包，更新 CONFIG.missing`).toBe(false);
      }
    }
  });

  // ai-assistant-mobile-dashboard 还按 Zwork 原样按分节引用已删除的 OUTPUT_RULES / DESIGN.md、端内 MEDIA: 预览和 审美相关skill/ 路径，
  // 并要求读不到就中止。资源层改不了，只能在规则层作废：说明挂在它自己那一行，不让整条 page 路线都付这份上下文。
  it("按分节引用已删除规则文件的骨架，作废说明就在自己那一行，且指向随包的文件", () => {
    const stale = /OUTPUT_RULES|审美相关skill|MEDIA:|DESIGN(\.md)? §/;
    const citing = skeletonNames.filter((n) => stale.test(readFileSync(join(resourceRoot, "design-skeletons", n, "SKILL.md"), "utf8")));
    const covered = (CONFIG.missing as Missing[]).filter((m) => m.inline).flatMap((m) => m.usedBy);
    expect(citing).toContain("ai-assistant-mobile-dashboard");
    expect(sorted(citing), "骨架引用了已删除的规则文件却没有作废说明：补 CONFIG.missing 的 inline").toEqual(sorted(covered));
    for (const { inline } of (CONFIG.missing as Missing[]).filter((m) => m.inline)) {
      // 说明必须真的作废（不读/不认领）并给出去处，而去处必须是随包的文件。
      expect(inline).toMatch(/not shipped/);
      expect(inline).toMatch(/never claim/);
      const links = [...(inline as string).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1] as string);
      expect(links.length).toBeGreaterThan(0);
      for (const href of links) expect(existsSync(join(referencesDir, href)), href).toBe(true);
    }
  });

  it("open-design-landing-deck 不承诺缺失的同伴文件；gstack 三个方法型技能不再列出", () => {
    const note = skeletonText.split("\n").find((line) => line.startsWith("- Note, `open-design-landing-deck`")) ?? "";
    for (const phrase of ["`scripts/compose.ts`", "not shipped", "`schema.ts`", "do not run"]) expect(note, phrase).toContain(phrase);
    for (const name of ["design-review", "plan-design-review", "design-consultation"]) {
      expect(committed + skeletonText, name).not.toContain(`\`${name}\``);
    }
    expect(skillNames).toEqual(expect.arrayContaining(["design-review", "plan-design-review", "design-consultation"]));
  });

  it("依赖 Open Design 运行时的四个骨架不出现在任何生成块里，并写明未列出的目录不能用", () => {
    expect(sorted(excluded)).toEqual(sorted(["live-artifact", "live-dashboard", "hyperframes", "video-shortform"]));
    for (const name of excluded) expect(skeletonText, name).not.toContain(`\`${name}\``);
    for (const track of TRACKS) expect(blockOf(trackText[track] as string), track).toContain("Folders not listed need a runtime this host lacks");
  });

  it("craft 节把 animation-discipline 和 references/motion.md 配对，并写明冲突时以 motion 为准", () => {
    const row = committed.split("\n").find((line) => line.startsWith("- `animation-discipline`")) ?? "";
    expect(row).toContain("[references/motion.md](motion.md)");
    expect(row).toMatch(/wins where/);
    expect(existsSync(join(skillRoot, "references", "motion.md"))).toBe(true);
  });

  it("设计系统节首行链接 BRAND-DISCLAIMER.md；kami 注明只经 kami-* 骨架选择", () => {
    const systems = section(committed, "Design systems");
    const first = systems.split("\n")[1] as string;
    expect(first).toContain("[BRAND-DISCLAIMER.md](../design-resources/design-systems/BRAND-DISCLAIMER.md)");
    expect(existsSync(join(resourceRoot, "design-systems", "BRAND-DISCLAIMER.md"))).toBe(true);
    expect(systems).toMatch(/`kami` \(only via kami-\* skeletons\)/);
  });

  it("no example 标记的集合等于磁盘上没有 example.html 的骨架集合", () => {
    const marked = skeletonNames.filter((n) => /\[[^\]]*no example[^\]]*\]$/.test(skeletonRow(n)));
    const missing = skeletonNames.filter((n) => !existsSync(join(resourceRoot, "design-skeletons", n, "example.html")));
    expect(missing.length).toBeGreaterThan(0);
    expect(sorted(marked)).toEqual(sorted(missing));
    expect(readdirSync(join(resourceRoot, "design-skeletons")).length).toBe(allSkeletonNames.length);
  });
});
