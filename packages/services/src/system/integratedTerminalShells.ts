import type { IntegratedTerminalShellOption } from "@zcode/shared";
import { discoverWindowsGitBash, type WindowsGitBashDiscoveryOptions } from "@zcode/shared/node";

export async function listIntegratedTerminalShellOptions(options: {
  env: NodeJS.ProcessEnv;
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">;
  isExecutable?: WindowsGitBashDiscoveryOptions["isExecutable"];
  platform: NodeJS.Platform;
}): Promise<IntegratedTerminalShellOption[]> {
  if (options.platform !== "win32") {
    return [];
  }

  const shellOptions: IntegratedTerminalShellOption[] = [createCommandPromptOption(options.env)];
  // 原来重复的固定目录/PATH 发现会漏掉非标准安装；共享发现修复漏检，选择与来源映射保持不变。
  const gitBash = await discoverWindowsGitBash({
    ...options.gitBashDiscovery,
    env: options.env,
    isExecutable: options.isExecutable,
    platform: options.platform,
  });
  if (gitBash) {
    shellOptions.push({
      dialect: "git-bash",
      id: `git-bash:${gitBash.path}`,
      label: "Git Bash",
      path: gitBash.path,
      source: gitBash.source,
    });
  }

  return shellOptions;
}

function createCommandPromptOption(env: NodeJS.ProcessEnv): IntegratedTerminalShellOption {
  const path = getWindowsEnvValue(env, "ComSpec")?.trim() || "cmd.exe";
  return {
    dialect: "cmd",
    id: `cmd:${path}`,
    label: "CMD",
    path,
    source: "system",
  };
}

function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}
