import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG, MAX_BYTES, buildCatalog, collectResources, firstSentence, resolveCraft } from "../skills/design/scripts/build-catalog.mjs";
import { parseFrontmatter, splitFrontmatter } from "../skills/design/scripts/frontmatter.mjs";

// references/catalog.md 由 build-catalog.mjs 从 design-resources 生成；这里守住新鲜度、体量、覆盖和配置漂移。
const skillRoot = fileURLToPath(new URL("../skills/design/", import.meta.url));
const resourceRoot = join(skillRoot, "design-resources");
const script = join(skillRoot, "scripts", "build-catalog.mjs");
const committed = readFileSync(join(skillRoot, "references", "catalog.md"), "utf8");
const resources = collectResources(resourceRoot);
const skeletonNames: string[] = [...resources.skeletons.keys()];
const skillNames: string[] = [...resources.skills.keys()];
const systemNames: string[] = [...resources.systems.keys()];
const craftNames: string[] = resources.craft;

type Category = { key: string; title: string; prefix?: string; craft: string[]; members: string[] };
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
  for (const line of section(text, "Skeletons").split("\n")) {
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
    ...names.skeletons.map((n) => template(section(text, "Skeletons")).replace("<name>", n)),
    ...names.skills.map((n) => template(section(text, "Skills")).replace("<name>", n)),
    ...names.systems.map((n) => template(section(text, "Design systems")).replace("<name>", n)),
    ...names.craft.map((n) => template(section(text, "Craft")).replace("<name>", n)),
  ];
  return { names, paths };
}

const skeletonRow = (name: string) => {
  const category = categories.find((c) => c.members.includes(name)) as Category;
  const label = category.prefix ? name.slice(category.prefix.length) : name;
  return committed.split("\n").find((line) => line.startsWith(`- \`${label}\``)) ?? "";
};

describe("catalog.md 新鲜度与体量", () => {
  it("与 build-catalog.mjs 的生成结果逐字节一致", () => {
    expect(buildCatalog(resourceRoot), "catalog.md 过期：运行 node apps/zcode-cli/packages/design-plugin/skills/design/scripts/build-catalog.mjs").toBe(committed);
  });

  it("生成结果确定：两次相同，无时间戳、绝对路径和 CR，以单个 LF 结尾", () => {
    expect(buildCatalog(resourceRoot)).toBe(buildCatalog(resourceRoot));
    expect(committed).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/);
    expect(committed).not.toContain(skillRoot);
    expect(committed).not.toMatch(/\]\(\/|`\/|\$\{[A-Z_]+\}/);
    expect(committed).not.toContain("\r");
    expect(committed.endsWith("\n") && !committed.endsWith("\n\n")).toBe(true);
  });

  it("不超过 8 KB、500 行；超过 100 行时顶部有指向各节的 Contents", () => {
    expect(MAX_BYTES).toBe(8192);
    expect(Buffer.byteLength(committed, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
    const lines = committed.split("\n").length - 1;
    expect(lines).toBeLessThanOrEqual(500);
    if (lines > 100) {
      const contents = committed.split("\n").slice(0, 12).find((line) => line.startsWith("Contents: ")) ?? "";
      for (const heading of committed.matchAll(/^## (.+)$/gm)) {
        const title = heading[1] as string;
        expect(contents, title).toContain(`[${title}](#${title.toLowerCase().replace(/ /g, "-")})`);
      }
    }
  });

  it("超过上限时非零退出、不写文件，并输出分段体量", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-design-catalog-"));
    try {
      const out = join(dir, "catalog.md");
      const run = spawnSync(process.execPath, [script, "--max-bytes=1000", `--out=${out}`], { encoding: "utf8", timeout: 20000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("over the 1000 B cap");
      for (const title of ["(head)", "Skeletons", "Skills", "Design systems", "Craft"]) expect(run.stderr, title).toContain(title);
      expect(existsSync(out)).toBe(false);
      const ok = spawnSync(process.execPath, [script, `--out=${out}`], { encoding: "utf8", timeout: 20000 });
      expect(ok.status).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(committed);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("catalog.md 覆盖与对应", () => {
  const { names, paths } = listed(committed);

  it("每个骨架、技能、设计系统和 craft 都列出或明确排除；列出的每项都能解析到随包文件", () => {
    expect(sorted([...names.skeletons, ...CONFIG.excludeSkeletons])).toEqual(sorted(skeletonNames));
    expect(names.skeletons).toHaveLength(skeletonNames.length - CONFIG.excludeSkeletons.length);
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
      ...CONFIG.excludeSkeletons,
      ...CONFIG.nameOnly,
      ...Object.keys(CONFIG.override),
      ...CONFIG.notes.flatMap((n: { names: string[] }) => n.names),
      ...Object.values(CONFIG.defaults as Record<string, string>),
      ...CONFIG.missing.flatMap((m: { usedBy: string[] }) => m.usedBy),
    ];
    expect(skeletonRefs.filter((n) => !skeletonNames.includes(n))).toEqual([]);
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
    expect(sorted([...members, ...CONFIG.excludeSkeletons])).toEqual(sorted(skeletonNames));
    expect(members).toHaveLength(skeletonNames.length - CONFIG.excludeSkeletons.length);
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
    expect(files.length).toBeGreaterThan(80);
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
  it("头部写出的三个默认骨架都存在，并在各自类别里", () => {
    const { deck, web, app } = CONFIG.defaults as Record<string, string>;
    const keyOf = (name: string) => categories.find((c) => c.members.includes(name))?.key;
    expect(["deck", "zhangzara"]).toContain(keyOf(deck));
    expect(keyOf(web)).toBe("web");
    expect(keyOf(app)).toBe("app");
    const head = committed.slice(0, committed.indexOf("\n## "));
    expect(head).toContain(`Defaults: deck \`${deck}\`, web \`${web}\`, app \`${app}\`.`);
  });

  it("hermes 行用覆盖句而不是被 YAML 截断的描述；broadside 行带 editorial", () => {
    const hermes = skeletonRow("html-ppt-hermes-cyber-terminal");
    expect(hermes).toContain(CONFIG.override["html-ppt-hermes-cyber-terminal"]);
    expect(hermes).not.toMatch(/deck —\s*(\[|$)/);
    expect(skeletonRow("html-ppt-zhangzara-broadside")).toContain("editorial");
  });

  it("缺文件警示仍然成立：被点名的文件依旧未随包，头部写明", () => {
    const head = committed.slice(0, committed.indexOf("\n## "));
    for (const { label, paths } of CONFIG.missing as { label: string; paths: string[] }[]) {
      expect(head, label).toContain(label);
      for (const path of paths) {
        expect(existsSync(join(resourceRoot, ...path.split("/"))), `${path} 已随包，更新 CONFIG.missing`).toBe(false);
      }
    }
  });

  it("open-design-landing-deck 不承诺缺失的同伴文件；gstack 三个方法型技能不再列出", () => {
    const note = committed.split("\n").find((line) => line.startsWith("- Note, `open-design-landing-deck`")) ?? "";
    for (const phrase of ["`scripts/compose.ts`", "not shipped", "`schema.ts`", "do not run"]) expect(note, phrase).toContain(phrase);
    for (const name of ["design-review", "plan-design-review", "design-consultation"]) {
      expect(committed, name).not.toContain(`\`${name}\``);
    }
    expect(skillNames).toEqual(expect.arrayContaining(["design-review", "plan-design-review", "design-consultation"]));
  });

  it("依赖 OD daemon / connector / 媒体运行时的骨架不在可选目录里，目录说明未列出的不可用", () => {
    // 这几个上游骨架的强制步骤要 OD_* 包装命令、artifact 注册或 MP4 生成，本宿主没有，静态流程走不通。
    const excluded = ["live-artifact", "live-dashboard", "hyperframes", "video-shortform"];
    expect(sorted(CONFIG.excludeSkeletons)).toEqual(sorted(excluded));
    const skeletonSection = section(committed, "Skeletons");
    for (const name of excluded) {
      expect(skeletonNames, name).toContain(name);
      expect(committed, name).not.toContain(`\`${name}\``);
      expect(categories.flatMap((c) => c.members), name).not.toContain(name);
    }
    expect(skeletonSection.split("\n")[1]).toContain("Folders not listed need a runtime this host lacks; never use them.");
  });

  it("设计系统节首行链接 BRAND-DISCLAIMER.md；kami 注明只经 kami-* 骨架选择", () => {
    const systems = section(committed, "Design systems");
    const first = systems.split("\n")[1] as string;
    expect(first).toContain("[BRAND-DISCLAIMER.md](../design-resources/design-systems/BRAND-DISCLAIMER.md)");
    expect(existsSync(join(resourceRoot, "design-systems", "BRAND-DISCLAIMER.md"))).toBe(true);
    expect(systems).toMatch(/`kami` \(only via kami-\* skeletons\)/);
  });

  it("no example 标记的集合等于磁盘上没有 example.html 的骨架集合", () => {
    const offered = skeletonNames.filter((n) => !CONFIG.excludeSkeletons.includes(n));
    const marked = offered.filter((n) => /\[[^\]]*no example[^\]]*\]$/.test(skeletonRow(n)));
    const missing = offered.filter((n) => !existsSync(join(resourceRoot, "design-skeletons", n, "example.html")));
    expect(missing.length).toBeGreaterThan(0);
    expect(sorted(marked)).toEqual(sorted(missing));
    expect(readdirSync(join(resourceRoot, "design-skeletons")).length).toBe(skeletonNames.length);
  });
});
