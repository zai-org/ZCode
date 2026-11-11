import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintDesign } from "../skills/design/scripts/design-lint.mjs";
import { parseTailwindTheme } from "../skills/design/scripts/import-design-system.mjs";
import { parseDesignSystem } from "../skills/design/scripts/design-tokens.mjs";

// 设计系统导入：从工作区的 CSS 变量、Tailwind 配置（只做文本解析，不执行）和已有页面抽出设计系统文件，
// 产物就是 design-lint 读的格式。
const skillRoot = fileURLToPath(new URL("../skills/design/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/frontend/", import.meta.url));
const importer = join(skillRoot, "scripts", "import-design-system.mjs");
const linter = join(skillRoot, "scripts", "design-lint.mjs");
const node = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20000 });

let workspace = "";
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-design-import-"));
  cpSync(fixture, workspace, { recursive: true });
  // 依赖目录不算项目自己的设计系统（node_modules 进不了仓库，测试时现放）。
  mkdirSync(join(workspace, "node_modules", "some-lib"), { recursive: true });
  writeFileSync(join(workspace, "node_modules", "some-lib", "evil.css"), ".evil { color: #ff00ff; }\n");
});
afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("import-design-system", () => {
  it("小样例前端目录 → design-system/<name>.md，含 CSS 变量、Tailwind theme 与页面里反复出现的字面量", () => {
    const run = node(importer, workspace, "--name", "Harbor App");
    expect(run.status, run.stderr).toBe(0);
    const out = join(workspace, "design-system", "harbor-app.md");
    expect(run.stdout.split("\n")[0]).toBe(out);
    const text = readFileSync(out, "utf8");
    const system = parseDesignSystem(text, out);
    const tokens = (section: "colors" | "fonts" | "spacing" | "radii") =>
      Object.fromEntries(system[section].map((t: { token: string; value: string }) => [t.token, t.value]));

    expect(system.name).toBe("harbor-app");
    expect(tokens("colors")).toMatchObject({
      "--brand-ink": "#1b2a41",
      "--brand-paper": "#F7F4EC",
      "--brand-accent": "rgb(209, 73, 91)",
      // var() 在同一份样式里解析到字面量。
      "--link": "rgb(209, 73, 91)",
      '--brand-paper ([data-theme="dark"])': "#10151f",
      primary: "#d1495b",
      "primary-600": "#b23a4b",
      "literal-color-1": "#2e8b57",
      // shadcn/ui 写法：变量只存 HSL 通道，Tailwind 用 hsl(var(--x) / <alpha-value>) 引用。
      "--surface": "hsl(40 33% 95%)",
      surface: "hsl(40 33% 95%)",
    });
    expect(tokens("fonts")).toMatchObject({
      "--font-sans": '"Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      "font-display": "Fraunces, Georgia, serif",
      "font-mono": '"JetBrains Mono", ui-monospace, monospace',
      "literal-font-1": '"Source Serif 4", serif',
    });
    expect(tokens("spacing")).toMatchObject({ "--space-sm": "8px", "--space-md": "16px", "spacing-18": "4.5rem" });
    expect(tokens("radii")).toMatchObject({ "--radius-card": "12px", "rounded-xl": "1rem", rounded: "6px", "rounded-lg": "0.5rem" });
    expect(system.usage).toContain("borderRadius.md = calc(var(--radius) - 2px) (not a plain length)");
    // 非 token 的变量（阴影、字号）不进表；依赖目录不扫。
    expect(text).not.toContain("--shadow-card");
    expect(text).not.toContain("--font-size-lg");
    expect(text).not.toMatch(/#ff00ff/i);
    expect(system.usage).toContain("never executed");
    expect(system.usage).toContain("theme.extend.colors.slate");
  });

  it("Tailwind 配置只读文本、从不执行：配置里写文件的语句没有生效，动态值记为跳过", () => {
    node(importer, workspace);
    expect(existsSync(join(workspace, "EXECUTED"))).toBe(false);
    const theme = parseTailwindTheme(readFileSync(join(workspace, "tailwind.config.js"), "utf8"));
    expect(theme.colors[0].primary).toEqual({ DEFAULT: "#d1495b", 600: "#b23a4b" });
    expect(theme.fontFamily[0].display).toEqual(["Fraunces", "Georgia", "serif"]);
    expect(theme.skipped).toEqual(["theme.extend.colors.slate", "theme.extend.colors.sand"]);
  });

  it("design-lint 能读导入产物：用导入 token 的页面干净，故意放的 3 个违规色值报 3 处", () => {
    expect(node(importer, workspace, "--name", "harbor").status).toBe(0);
    const system = join(workspace, "design-system", "harbor.md");
    const page = join(workspace, "原型", "page.html");
    mkdirSync(join(workspace, "原型"), { recursive: true });
    writeFileSync(
      page,
      [
        "<!doctype html>",
        '<html lang="en" data-zcode-design>',
        "<style>",
        "  :root { --brand-ink: #1b2a41; --brand-paper: #f7f4ec; --brand-accent: #d1495b; }",
        '  body { color: var(--brand-ink); background: var(--brand-paper); font-family: "Inter", sans-serif; padding: 16px; }',
        "  h1 { font-family: Fraunces, serif; color: #6366f1; }",
        "  .cta { background: #d1495b; border-color: #b23a4b; box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.4); }",
        "</style>",
        '<h1 style="border-bottom: 1px solid hsl(0, 0%, 90%)">Tide tables</h1>',
        "</html>",
      ].join("\n"),
    );
    const parsed = parseDesignSystem(readFileSync(system, "utf8"), system);
    const { violations } = lintDesign(readFileSync(page, "utf8"), parsed, { spacing: true });
    expect(violations.map((v: { value: string; line: number }) => `${v.line}:${v.value}`)).toEqual([
      "6:#6366f1",
      "7:rgba(99, 102, 241, 0.4)",
      "9:hsl(0, 0%, 90%)",
    ]);
    const cli = node(linter, page, system, "--spacing");
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("3 violation(s)");
  });

  it("多套并存：已存在的设计系统文件不覆盖，换 --name 另存，--force 才替换", () => {
    expect(node(importer, workspace, "--name", "a").status).toBe(0);
    const again = node(importer, workspace, "--name", "a");
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already exists");
    expect(node(importer, workspace, "--name", "b").status).toBe(0);
    expect(existsSync(join(workspace, "design-system", "a.md"))).toBe(true);
    expect(existsSync(join(workspace, "design-system", "b.md"))).toBe(true);
    expect(node(importer, workspace, "--name", "a", "--force").status).toBe(0);
  });

  it("并发导入同一新路径：不带 --force 时每轮至多一个成功，文件内容属于成功者", async () => {
    // 存在检查与写入若是两步，两个进程会都返回 0、后写者悄悄覆盖先写者；排他创建只让一个进程赢。
    const run = (name: string, out: string) =>
      new Promise<{ name: string; status: number | null }>((done) => {
        const child = spawn(process.execPath, [importer, workspace, "--name", name, "--out", out], { stdio: "ignore" });
        child.on("close", (status) => done({ name, status }));
      });
    const expected = {
      a: node(importer, workspace, "--name", "a", "--stdout").stdout,
      b: node(importer, workspace, "--name", "b", "--stdout").stdout,
    };
    expect(expected.a).not.toBe(expected.b);
    for (let round = 0; round < 20; round += 1) {
      const out = join(workspace, "race", `round-${round}.md`);
      const results = await Promise.all([run("a", out), run("b", out)]);
      const winners = results.filter((r) => r.status === 0);
      expect(winners.length, `round ${round}: ${JSON.stringify(results)}`).toBe(1);
      expect(results.find((r) => r.status !== 0)?.status).toBe(1);
      expect(readFileSync(out, "utf8")).toBe(expected[winners[0].name as "a" | "b"]);
    }
  }, 60000);

  it("--from 只读指定来源；名字里的路径与 Windows 非法字符被清理", () => {
    const run = node(importer, workspace, "--from", "public/index.html", "--name", 'Web: "v2"/main');
    expect(run.status, run.stderr).toBe(0);
    const out = join(workspace, "design-system", "web-v2-main.md");
    const system = parseDesignSystem(readFileSync(out, "utf8"), out);
    expect(system.colors.map((t: { value: string }) => t.value.toLowerCase())).toEqual(["#2e8b57", "#f7f4ec"]);
    expect(system.fonts.map((t: { value: string }) => t.value)).toEqual(['"Source Serif 4", serif']);
    expect(node(importer).status).toBe(2);
  });
});
