import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintDesign } from "../skills/design/scripts/design-lint.mjs";
import { parseColor, colorKey, parseDesignSystem } from "../skills/design/scripts/design-tokens.mjs";

// design-lint：设计稿里的颜色 / 字体 / 间距是否都出自设计系统文件。机判在前，人工只看它管不到的部分。
const skillRoot = fileURLToPath(new URL("../skills/design/", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/lint/", import.meta.url));
const script = join(skillRoot, "scripts", "design-lint.mjs");
const fixture = (name: string) => join(fixtures, name);
const system = () => parseDesignSystem(readFileSync(fixture("system.md"), "utf8"), "system.md");
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 20000 });

describe("design-lint", () => {
  it("颜色字面量统一成同一种写法：hex 大小写与简写、rgb 新旧语法、hsl", () => {
    expect(colorKey(parseColor("#FFF"))).toBe("#ffffff");
    expect(colorKey(parseColor("rgb(231 111 81 / 40%)"))).toBe("#e76f5166");
    expect(colorKey(parseColor("rgba(231, 111, 81, 1)"))).toBe("#e76f51");
    expect(colorKey(parseColor("hsl(0, 100%, 50%)"))).toBe("#ff0000");
    expect(parseColor("#12345")).toBeNull();
  });

  it("读 markdown 设计系统文件的四张 token 表", () => {
    const parsed = system();
    expect(parsed.name).toBe("harbor");
    expect(parsed.colors.map((t: { token: string }) => t.token)).toEqual(["--ink", "--paper", "--accent", "--line"]);
    expect(parsed.fonts[1].value).toBe('"Source Sans 3", "PingFang SC", "Microsoft YaHei", sans-serif');
    expect(parsed.spacing).toHaveLength(4);
    expect(parsed.radii[0].value).toBe("6px");
    expect(parsed.usage).toContain("Accent only");
  });

  it("含 3 个违规色值的样例报 3 处：变量定义、样式表、内联样式各一，带行号和最近的合法 token", () => {
    const html = readFileSync(fixture("violations.html"), "utf8");
    const { violations } = lintDesign(html, system());
    expect(violations.map((v: { value: string; line: number }) => [v.value, v.line])).toEqual([
      ["#6366f1", 7],
      ["hsl(262, 83%, 58%)", 10],
      ["rgb(17, 24, 39)", 14],
    ]);
    expect(violations.every((v: { kind: string }) => v.kind === "color")).toBe(true);
    // rgb(17,24,39) 最接近墨色 --ink。
    expect(violations[2].suggestion).toBe("--ink (#14213d)");
  });

  it("干净样例报 0：大小写、rgb/rgba、带透明度的同色、var()、注释里的色值、#id 选择器、SVG 属性都不误报", () => {
    const html = readFileSync(fixture("clean.html"), "utf8");
    const result = lintDesign(html, system(), { spacing: true });
    expect(result.violations).toEqual([]);
    expect(result.stats.colors).toBeGreaterThanOrEqual(4);
  });

  it("字体与间距：主字体不在系统里报 font；--spacing 时不在刻度上的 px/rem 报 spacing", () => {
    const html = `<style>p { font-family: Inter, sans-serif; margin: 12px 8px; padding: 0 1rem; }</style>`;
    const kinds = (spacing: boolean) =>
      lintDesign(html, system(), { spacing }).violations.map((v: { kind: string; value: string }) => `${v.kind}:${v.value}`);
    expect(kinds(false)).toEqual(["font:Inter"]);
    expect(kinds(true)).toEqual(["font:Inter", "spacing:12px"]);
  });

  it("字体写在任意名字的自定义属性里（如 --app-font-sans）再 var() 引用，也照样检查", () => {
    const html = `<style>:root { --app-font-sans: Inter, sans-serif; --font-size-lg: 18px; --font-weight-bold: 700; } p { font-family: var(--app-font-sans); }</style>`;
    const result = lintDesign(html, system());
    expect(result.violations.map((v: { kind: string; value: string }) => `${v.kind}:${v.value}`)).toEqual(["font:Inter"]);
    expect(result.stats.families).toBe(1);
  });

  it("名字带 font 但值不是字体栈的自定义属性不报（颜色、数字、关键字、font 简写）", () => {
    const html = `<style>:root { --font-color: #333; --font-display: swap; --font-lh: 1.5; --font-tracking: -0.01em; --fa-font-solid: normal 900 1em/1 "Font Awesome 6 Free"; --font-sans-fallback: Inter, sans-serif; }</style>`;
    const fonts = lintDesign(html, system())
      .violations.filter((v: { kind: string }) => v.kind === "font")
      .map((v: { value: string }) => v.value);
    expect(fonts).toEqual(["Inter"]);
  });

  it("JSON 形式的设计系统文件同样可读", () => {
    const json = parseDesignSystem(readFileSync(fixture("system.json"), "utf8"), "system.json");
    expect(json.fonts[0].value).toBe("Source Sans 3, sans-serif");
    const html = readFileSync(fixture("violations.html"), "utf8");
    expect(lintDesign(html, json).violations).toHaveLength(3);
  });

  it("CLI：有违规退出 1 并逐条打印 文件:行；干净退出 0", () => {
    const bad = run(fixture("violations.html"), fixture("system.md"));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain(`${fixture("violations.html")}:7 [color] --brand: #6366f1 -> nearest token:`);
    expect(bad.stdout).toContain("3 violation(s)");
    const clean = run(fixture("clean.html"), fixture("system.md"), "--spacing");
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    const json = JSON.parse(run(fixture("violations.html"), fixture("system.md"), "--json").stdout);
    expect(json.violations).toHaveLength(3);
  });

  it("没给设计系统时只做通用检查并说明，不判违规", () => {
    const generic = run(fixture("violations.html"));
    expect(generic.status, generic.stdout + generic.stderr).toBe(0);
    expect(generic.stdout).toContain("generic checks only");
    // 通用检查：不经 CSS 变量直接写的色值给 warning。
    expect(generic.stdout).toMatch(/warning: .*#fbf8f1 -> fix: define it once/);
    expect(run().status).toBe(2);
  });

  it("显式给了读得到但不是设计系统的文件（空文件、README、缺四个 token 区段、JSON 不合格式）：退出 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-design-lint-"));
    try {
      const cases: Record<string, string> = {
        "empty.md": "",
        "README.md": "# Harbor App\n\nA budgeting app. Run `pnpm dev` to start.\n\n## Install\n\n- node: 24\n",
        "no-sections.md": "---\nname: harbor\n---\n\n# Harbor\n\n## Usage\n\nAccent is for primary actions only.\n",
        "bad.json": JSON.stringify({ name: "harbor", palette: { brand: "#1b2a41" } }),
      };
      for (const [name, text] of Object.entries(cases)) {
        writeFileSync(join(dir, name), text);
        const result = run(fixture("violations.html"), join(dir, name));
        expect(result.status, name).toBe(2);
        expect(result.stderr, name).toContain(name);
        expect(result.stdout, name).not.toContain("violation(s)");
      }
      // 有效的 .md / .json 行为不变。
      expect(run(fixture("violations.html"), fixture("system.json")).status).toBe(1);
      expect(run(fixture("clean.html"), fixture("system.md")).status).toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("显式给了读不到的设计系统文件：退出 2，不降级成通用检查当通过", () => {
    // violations.html 对着真设计系统有 3 处违规；路径写错不能让它以 0 混过去。
    const missing = run(fixture("violations.html"), fixture("does-not-exist.md"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("does-not-exist.md");
    expect(missing.stdout).not.toContain("violation(s)");
  });
});
