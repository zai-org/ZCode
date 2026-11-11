import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";

describe("protocol slash command surface", () => {
  it("returns app-supported builtins plus agent-discovered custom commands", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-slash-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const projectCommands = join(workspace, ".zcode", "commands");
    const userCommands = join(home, ".zcode", "commands");

    try {
      await mkdir(projectCommands, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(projectCommands, "review", "Project review", "Project body.");
      await writeCommand(userCommands, "review", "User review", "User body.");
      await writeCommand(userCommands, "ship", "Ship changes", "Ship $ARGUMENTS.", [
        "argument-hint: [target]",
      ]);
      await writeCommand(userCommands, "model", "Reserved custom model", "Should be hidden.");
      await writeCommand(userCommands, "plan", "Reserved custom plan", "Should be hidden.");
      await writeCommand(userCommands, "offline", "Noninteractive disabled", "Hidden.", [
        "disable-noninteractive: true",
      ]);
      // 同名自定义命令不得顶替内置 `/workflow`（保留名）：目录里只剩内置那一行。
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should be hidden.");

      // homeDirectory 只隔离自定义命令；插件存储也必须隔离，避免读取本机已安装插件。
      const commands = await listProtocolSlashCommands({
        // 本例只验证用户/项目命令；官方插件命令由插件测试覆盖，不依赖本机已构建资源。
        pluginDiscovery: {
          discoverPlugins: async () => ({
            commandRoots: [],
            diagnostics: [],
            hooks: {},
            mcpServers: {},
            plugins: [],
            skillRoots: [],
          }),
        },
        env: { ZCODE_ENV: "test", ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      });

      expect(commands.map((command) => ({ name: command.name, source: command.source }))).toEqual([
        { name: "goal", source: "builtin" },
        // `/workflow` 是随 CLI 编译的内置 prompt 命令（builtin-workflow-command.ts）。App `/` 面板
        // 按本目录顺序展示，产品要求工作流紧随目标之后（docs/ui/chat-composer-action-menu.md
        // 「工作流入口」），顺序由 APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 决定。
        { name: "workflow", source: "builtin" },
        { name: "compact", source: "builtin" },
        { name: "init", source: "builtin" },
        { name: "review", source: "custom" },
        { name: "ship", source: "custom" },
      ]);
      expect(commands.find((command) => command.name === "review")?.description).toBe(
        "User review",
      );
      expect(commands.find((command) => command.name === "ship")?.inputHint).toBe("/ship [target]");
      expect(commands.find((command) => command.name === "workflow")?.inputHint).toBe(
        "/workflow [what the workflow should accomplish]",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

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
        env: { ZCODE_ENV: "test", ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
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
        env: { ZCODE_ENV: "test", ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
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
        env: { ZCODE_ENV: "test", ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
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

  it("hands session variables to Bash and reports missing skill context without execution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-command-runtime-context-"));
    const home = join(tempRoot, "home");
    const commands = join(home, ".zcode", "commands");
    try {
      await mkdir(commands, { recursive: true });
      for (const variable of ["CLAUDE_SESSION_ID", "CLAUDE_SKILL_DIR"]) {
        await writeCommand(commands, "runtime-context", "Runtime context", [
          "```!", `echo \"$${variable}\"`, "```",
        ].join("\n"));
        const prompt = await resolveZCodeCustomCommandPrompt("/runtime-context", {
          env: { ZCODE_ENV: "test", ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
          homeDirectory: home,
          skipUserConfig: true,
          workingDirectory: tempRoot,
        });
        if (variable === "CLAUDE_SESSION_ID") {
          expect(prompt).toContain(`echo \"$${variable}\"`);
          expect(prompt).toContain("```bash");
        } else {
          expect(prompt).toContain("was not run");
          expect(prompt).toContain("$CLAUDE_SKILL_DIR, which cannot be resolved here");
        }
        expect(prompt).not.toContain("```!");
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
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
