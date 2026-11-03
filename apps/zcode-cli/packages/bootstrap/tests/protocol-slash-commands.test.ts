import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";

describe("protocol slash command surface", () => {
  it("expands prompt custom commands without taking over reserved builtins", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-custom-command-prompt-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "review", "Review changes", "Review $ARGUMENTS.");
      await writeCommand(userCommands, "init", "Custom init", "Should not expand.");
      await writeCommand(userCommands, "model", "Reserved model", "Should not expand.");
      await writeCommand(userCommands, "plan", "Reserved Plan action", "Should not expand.");

      const options = {
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };
      const prompt = await resolveZCodeCustomCommandPrompt("/review src packages", options);

      expect(prompt).toContain("Run custom command /review.");
      expect(prompt).toContain("Command source: user/zcode.");
      expect(prompt).toContain("Review src packages.");
      await expect(resolveZCodeCustomCommandPrompt("/model glm-5", options)).resolves.toBe(
        undefined,
      );
      await expect(resolveZCodeCustomCommandPrompt("/plan task", options)).resolves.toBe(undefined);
      expect(resolveZCodeBuiltinPromptCommand("/plan task", { workingDirectory: workspace })).toBe(
        undefined,
      );
      await expect(resolveZCodeCustomCommandPrompt("/init", options)).resolves.toBe(undefined);
      await expect(resolveZCodeCustomCommandPrompt("please /review", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // DWG-03：灰度关闭时 `/workflow` 不得展开。目录侧已经剃掉了它，但用户仍可手打命令名，
  // 两条路径必须给出同一个结论；同时 `workflow` 是保留名，自定义命令解析对它一律不展开，
  // 用户或插件的同名命令既顶替不了内置语义，也绕不过灰度门。
  it("expands builtin /workflow through the builtin resolver only, gated by the feature flag", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-workflow-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should not expand.");
      const options = {
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      const expanded = resolveZCodeBuiltinPromptCommand("/workflow ship it", {
        dynamicWorkflowEnabled: true,
        workingDirectory: workspace,
      });
      expect(expanded).toContain("Required skills: `dynamic-workflows`.");
      expect(expanded).toContain("ship it");
      expect(expanded).not.toContain("Should not expand.");
      // 缺席（TUI / headless）等于开启；显式 false 才挡下。
      expect(
        resolveZCodeBuiltinPromptCommand("/workflow ship it", { workingDirectory: workspace }),
      ).toContain("ship it");
      expect(
        resolveZCodeBuiltinPromptCommand("/workflow ship it", {
          dynamicWorkflowEnabled: false,
          workingDirectory: workspace,
        }),
      ).toBe(undefined);
      await expect(resolveZCodeCustomCommandPrompt("/workflow ship it", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("expands builtin /init into the workspace AGENTS.md prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-init-"));
    const workspace = join(tempRoot, "workspace");

    try {
      await mkdir(workspace, { recursive: true });
      const prompt = resolveZCodeBuiltinPromptCommand("/init include pnpm scripts", {
        workingDirectory: workspace,
      });

      expect(prompt).toContain("built-in /init command");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain(join(workspace, "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".zcode", "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".agents", "AGENTS.md"));
      expect(prompt).toContain("they already have an instructions file");
      expect(prompt).not.toContain("Do not create CLAUDE.md or AGNENTS.md");
      expect(prompt).toContain("include pnpm scripts");
      expect(resolveZCodeBuiltinPromptCommand("/review", { workingDirectory: workspace })).toBe(
        undefined,
      );
      expect(
        resolveZCodeBuiltinPromptCommand("please /init", { workingDirectory: workspace }),
      ).toBe(undefined);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("hands plugin shell blocks to the model with the plugin root resolved", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-plugin-command-shell-"));
    const workspace = join(tempRoot, "workspace");
    const pluginRoot = join(tempRoot, "ralph-loop");
    const commandsRoot = join(pluginRoot, "commands");
    const pluginDataRoot = join(tempRoot, "plugins");
    const configPath = join(tempRoot, "config.json");

    try {
      await mkdir(commandsRoot, { recursive: true });
      await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ralph-loop", version: "1.0.0" }),
      );
      await writeCommand(
        commandsRoot,
        "ralph-loop",
        "Start Ralph",
        [
          "Before",
          "```!",
          'echo "${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" "$ARGUMENTS" "$CLAUDE_PROJECT_DIR"',
          "```",
          "After",
        ].join("\n"),
      );
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
            enabled: true,
          },
          storage: {
            dir: pluginDataRoot,
          },
        }),
      );

      // 项目配置会剥离 plugins.dirs（工作区不能引入插件根目录），测试插件只能经用户配置加载；
      // homeDirectory 指向临时目录，不读本机用户命令。
      const prompt = await resolveZCodeCustomCommandPrompt("/ralph-loop build demo", {
        env: { ZCODE_ENV: "test" },
        homeDirectory: join(tempRoot, "home"),
        userConfigPath: configPath,
        workingDirectory: workspace,
      });

      expect(prompt).not.toContain("```!");
      expect(prompt).toContain(`the /ralph-loop command file (user/plugin), not from ZCode.`);
      // 命令文本自带 "/scripts/..."，期望值不能用 join() 拼平台分隔符；工作区变量由 Bash 环境提供，保持原文。
      // Windows 上插件路径改写成正斜杠，期望值按同一规则换算；POSIX 路径不受影响。
      expect(prompt).toContain(
        `\`\`\`bash\necho "${pluginRoot.replaceAll("\\", "/")}/scripts/setup-ralph-loop.sh" "build demo" "$CLAUDE_PROJECT_DIR"\n\`\`\`\n`,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function writeCommand(
  directory: string,
  name: string,
  description: string,
  body: string,
  extraFrontmatter: string[] = [],
): Promise<void> {
  await writeFile(
    join(directory, `${name}.md`),
    ["---", `description: ${description}`, ...extraFrontmatter, "---", "", body].join("\n"),
  );
}
