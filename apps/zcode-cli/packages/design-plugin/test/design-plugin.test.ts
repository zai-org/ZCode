import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 设计工作流插件 design：入口技能 + 设计资源 + SessionStart 注入。
// 宿主侧的插件 seed、默认启用与 hook 执行由 bootstrap / build-sea / desktop 的测试覆盖，这里只测插件内容。
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = join(pluginRoot, "skills", "design");

function read(relative: string): string {
  return readFileSync(join(skillRoot, ...relative.split("/")), "utf8");
}

function listMarkdown(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name));
}

const ruleFiles = () => [join(skillRoot, "SKILL.md"), ...listMarkdown(join(skillRoot, "references"))];

describe("design 插件结构", () => {
  // 原用例与另一份设计包逐项对照，对照对象不在本仓库；
  // 内置到 ZCode 后改成直接钉住随包内容，断言不变。
  it("随包子技能：四个方法型子技能齐全；第三方技能合集只带 SKILL.md、不带上游宣传页", () => {
    const skills = join(pluginRoot, "skills", "design", "design-resources", "skills");
    for (const kept of ["design-review", "plan-design-review", "design-consultation", "brand-guidelines"]) {
      expect(existsSync(join(skills, kept, "SKILL.md")), kept).toBe(true);
    }
    expect(existsSync(join(skills, "plan-design-review", "sections", "review-sections.md"))).toBe(true);
    expect(existsSync(join(skills, "design-consultation", "sections", "proposal-and-preview.md"))).toBe(true);
    // 上游任何版本都没有许可原文的子技能不随包。
    expect(existsSync(join(skills, "competitive-ads-extractor"))).toBe(false);
    // 带独立许可的子技能随目录带上游许可原文；主体许可是 Open Design 的 Apache-2.0。
    expect(readFileSync(join(skills, "frontend-design", "LICENSE.txt"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(skills, "taste-skill", "LICENSE"), "utf8")).toContain("Copyright (c) 2026 Leonxlnx");
    const resources = join(pluginRoot, "skills", "design", "design-resources");
    expect(readFileSync(join(resources, "LICENSE.md"), "utf8")).toContain("Copyright 2026 Open Design contributors");
    expect(readFileSync(join(resources, "NOTICE.md"), "utf8")).toContain("https://github.com/nexu-io/open-design");
  });

  it("技能发现只扫 skills/ 下一层：只有入口技能 design，design-resources 里的嵌套技能不会被单独注册", () => {
    const entries = readdirSync(join(pluginRoot, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(entries.map((e) => e.name)).toEqual(["design"]);
    expect(existsSync(join(pluginRoot, "skills", "design", "SKILL.md"))).toBe(true);
  });
});

describe("design 官方插件内容与加载", () => {
  it("manifest 与 package 版本一致，只声明技能，不声明 MCP、不需要配置", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
    expect(manifest.name).toBe("design");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.skills).toBe("./skills");
    for (const forbidden of ["agents", "hooks", "commands", "identity", "instructions", "mcpServers", "userConfig"]) {
      expect(manifest, forbidden).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(manifest)).not.toContain("user_config");
    expect(existsSync(join(pluginRoot, "mcp"))).toBe(false);
    expect(existsSync(join(pluginRoot, ".mcp.json"))).toBe(false);
  });

  it(".zcode-plugin 与 .claude-plugin 两份宿主清单逐字节一致", () => {
    const zcode = readFileSync(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8");
    expect(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).toBe(zcode);
  });

  it("入口技能 frontmatter 声明 design，并按产物把对话内视图与 pptx 排除在外", () => {
    const entry = read("SKILL.md");
    expect(entry).toMatch(/^---\nname: design\n/);
    const description = entry.match(/^description: "([^"]+)"/m)?.[1] ?? "";
    expect(description).toContain("visualize");
    expect(description).toContain("presentations");
    // 两个宿主的技能描述加载上限都按 1024 字符算。
    expect([...description].length).toBeLessThanOrEqual(1024);
  });

  it("规则层文件固定为入口 + 7 份按需文件，各自不超体量上限；超过 100 行的在顶部有目录，都不超过 500 行", () => {
    // create 的上限按方案草案放宽到 9 KB（交接文档为 6 KB，待肖京津确认）。
    // 0.7.0 加 design-system（设计系统文件格式、导入、design-lint）与产出约定：入口放宽到 4 KB、output 9 KB，总量 54 KB。
    const limits: Record<string, number> = {
      "SKILL.md": 4, "references/design-system.md": 5, "references/create.md": 9, "references/redesign.md": 5, "references/output.md": 9,
      "references/check.md": 8, "references/interact.md": 3, "references/catalog.md": 8,
    };
    const actual = ruleFiles().map((file) => file.slice(skillRoot.length + 1)).sort();
    expect(actual).toEqual(Object.keys(limits).sort());
    let total = 0;
    for (const [file, kb] of Object.entries(limits)) {
      const text = read(file);
      const bytes = Buffer.byteLength(text, "utf8");
      total += bytes;
      expect(bytes, file).toBeLessThanOrEqual(kb * 1024);
      const lines = text.split("\n").length;
      expect(lines, file).toBeLessThanOrEqual(500);
      if (lines > 100) expect(text.split("\n").slice(0, 12).join("\n"), file).toMatch(/Contents|目录/);
    }
    expect(total).toBeLessThanOrEqual(54 * 1024);
  });

  it("入口与 references 里的相对链接从所在文件出发都能解析到随包文件", () => {
    const files = ruleFiles();
    const broken: string[] = [];
    let checked = 0;
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (match[1] as string).split("#")[0] as string;
        // 「原型/…」是交付示例里的工作区产物路径，不是随包文件。
        if (target === "" || target.startsWith("原型/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        checked += 1;
        if (!existsSync(join(dirname(file), ...target.split("/")))) broken.push(`${file.slice(skillRoot.length)} -> ${target}`);
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(broken).toEqual([]);
  });

  it("入口与 references 正文统一为英文；路径、文件名示例和 catalog 里转引的资源元数据除外", () => {
    const mixed = ruleFiles()
      .filter((file) => !file.endsWith("catalog.md"))
      .filter((file) => {
        const prose = readFileSync(file, "utf8")
          .replace(/^description: .*$/m, "")
          .replace(/```[\s\S]*?```/g, "")
          .replace(/`[^`]*`/g, "")
          .replace(/\]\([^)]*\)/g, "]");
        return /[\u4e00-\u9fff]/.test(prose);
      });
    expect(mixed).toEqual([]);
  });

  it("不残留 Zwork 平台专有写法，也不点名只有某一个宿主才有的工具", () => {
    const banned =
      /skill:\/\/|deliver_file|zwork|memory_change|browser_tool|process\.exec|ask_user_question|tool_search|image_recognition|update_run_checklist|propose_work_plan|artifactCard|generate_image|search_image|control-browser|zcode-file-citation|在 Browser 中|AskUserQuestion|TodoWrite|ToolSearch/i;
    const hits = ruleFiles().filter((file) =>
      banned.test(readFileSync(file, "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("产出约定：file:// 直接可开、data-zcode-design 标记、section.slide / data-variant / CSS 变量；入口点名这些约定", () => {
    const output = read("references/output.md");
    for (const phrase of [
      "file://", 'type="module"', "fetch", "<html data-zcode-design>", '<section class="slide">', "data-variant",
      "CSS custom properties",
    ]) expect(output, phrase).toContain(phrase);
    // 幻灯片只认 section.slide，不再并列另一种写法。
    expect(output).not.toContain("<section data-slide>");
    const entry = read("SKILL.md");
    expect(entry).toContain("file://");
    expect(entry).toContain("data-zcode-design");
    expect(entry.split("\n").length).toBeLessThanOrEqual(500);
    expect([...(entry.match(/^description: "([^"]+)"/m)?.[1] ?? "")].length).toBeLessThanOrEqual(1024);
  });

  it("宿主设计模式按有无降级：有就提示用它钉评 / 轻改，没有就退回浏览器打开 + 文字描述，不声称不存在的功能", () => {
    const output = read("references/output.md");
    const section = output.slice(output.indexOf("## Markers and review"));
    expect(section).toMatch(/design mode/);
    expect(section).toMatch(/pin comments/);
    expect(section).toMatch(/open the file in a browser/);
    expect(section).toMatch(/describe (the )?changes/);
    expect(section).toMatch(/Never claim/);
    expect(read("SKILL.md")).toMatch(/design mode[^\n]*browser/);
  });

  it("adapt-canvas.mjs 校验模板哈希并写出适配副本，已存在的输出不覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-design-canvas-"));
    try {
      const out = join(dir, "canvas.html");
      const script = join(skillRoot, "scripts", "adapt-canvas.mjs");
      execFileSync(process.execPath, [script, out], { encoding: "utf8" });
      const adapted = readFileSync(out, "utf8");
      const template = read("design-resources/skills/infinite-canvas/assets/infinite-canvas-template.html");
      expect(adapted).not.toBe(template);
      expect(adapted).toContain("prefers-reduced-motion");
      expect(() => execFileSync(process.execPath, [script, out], { encoding: "utf8", stdio: "pipe" })).toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("gstack 三份子技能默认不读：规则文件不指向它们", () => {
    for (const name of ["design-review", "plan-design-review", "design-consultation"]) {
      for (const file of ruleFiles()) {
        expect(readFileSync(file, "utf8"), `${file} -> ${name}`).not.toContain(`skills/${name}/`);
      }
    }
  });

  it("一期不含生图：入口不路由单独生图，规则不链接 image.md", () => {
    expect(existsSync(join(skillRoot, "references", "image.md"))).toBe(false);
    for (const file of ruleFiles()) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/image\.md|generate_image_seedream/);
    }
  });

  // 设计工作流入口的常驻注入：SessionStart hook，POSIX sh，不依赖 Node。
  describe("SessionStart 注入设计工作流", () => {
    const hooksDir = join(pluginRoot, "hooks");
    const runHook = (env: Record<string, string>) =>
      spawnSync("sh", [join(hooksDir, "run-hook.cmd"), "design-rules"], { encoding: "utf8", timeout: 20000, env: { PATH: "/usr/bin:/bin", ...env } });

    it("hooks.json 先用 sh 调启动器、失败再直接调（市场安装不恢复可执行位），且出错放行", () => {
      const hooks = JSON.parse(readFileSync(join(hooksDir, "hooks.json"), "utf8"));
      const entry = hooks.hooks.SessionStart[0].hooks[0];
      expect(entry.command).toBe(
        'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" design-rules || "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" design-rules',
      );
      expect(entry.onError).toBe("allow");
      expect(entry.command).not.toMatch(/\bnode\b/);
    });

    it("在没有 Node 的 PATH 下输出合法的 additionalContext：只是指向 design 技能的指针，写明 base directory", () => {
      const run = runHook({ ZCODE_PLUGIN_ROOT: pluginRoot.replace(/\/$/, "") });
      expect(run.status).toBe(0);
      const out = JSON.parse(run.stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const ctx: string = out.hookSpecificOutput.additionalContext;
      expect(ctx).toContain(`relative to: ${skillRoot.replace(/\/$/, "")}`);
      expect(ctx).toContain("load the `design` skill first");
      for (const deliverable of ["HTML design", "prototype", "HTML deck", "redesign"]) {
        expect(ctx, deliverable).toContain(deliverable);
      }
      // 内置后默认启用，每个会话都会带上它：只放一句指针 + 路径基准，不注入入口正文。
      // 压短后（0.7.0 内置）去掉路径约 110 字节，上限从 1 KB 收到 160 字节，防止再长回去。
      expect(ctx).not.toContain("# 设计专家 · 工作流入口");
      expect(Buffer.byteLength(ctx.replace(skillRoot.replace(/\/$/, ""), ""), "utf8")).toBeLessThanOrEqual(160);
    });

    it("宿主只提供 CLAUDE_PLUGIN_ROOT 时也能定位插件目录", () => {
      const run = runHook({ CLAUDE_PLUGIN_ROOT: pluginRoot.replace(/\/$/, "") });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain(`relative to: ${skillRoot.replace(/\/$/, "")}`);
    });

    it("Windows（Git Bash 有 cygpath）时把路径转成 C:/ 形式，Node 侧的文件工具才读得到", () => {
      // 用假 cygpath 模拟 Git Bash：-u 原样返回，-m 返回盘符路径。
      const bin = mkdtempSync(join(tmpdir(), "design-cygpath-"));
      writeFileSync(join(bin, "cygpath"), '#!/bin/sh\n[ "$1" = "-m" ] && printf "C:/fake%s\\n" "$2" || printf "%s\\n" "$2"\n');
      chmodSync(join(bin, "cygpath"), 0o755);
      const run = spawnSync("sh", [join(hooksDir, "run-hook.cmd"), "design-rules"], {
        encoding: "utf8",
        timeout: 20000,
        env: { PATH: `${bin}:/usr/bin:/bin`, ZCODE_PLUGIN_ROOT: pluginRoot.replace(/\/$/, "") },
      });
      expect(run.status).toBe(0);
      const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain(`relative to: C:/fake${skillRoot.replace(/\/$/, "")}`);
    });

    it("入口缺失或路径错误时静默退出 0，不阻塞会话", () => {
      const run = runHook({ ZCODE_PLUGIN_ROOT: join(pluginRoot, "does-not-exist") });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    });
  });
});
