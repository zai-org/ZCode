import { accessSync, constants as fsConstants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { discoverWindowsGitBash, type WindowsGitBashDiscoveryOptions } from "@zcode/shared/node";
import { resolveWindowsComSpec } from "./windows-executable.js";
import {
  type ExecutionShellDialect,
  type ExecutionShellSelection,
  WINDOWS_CMD_SHELL_DISPLAY_NAME,
} from "@zcode/contracts";

type PosixShellKind = "bash" | "zsh";
type ExecutableCheck = (path: string) => boolean;
type EffectiveBashShellResolveOptions = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform | string;
  exists?: ExecutableCheck;
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">;
  override?: ExecutionShellSelection;
};

const FIXED_POSIX_SHELL_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

export interface BashShellProvider {
  dialect: ExecutionShellDialect;
  envOverlay?: Record<string, string>;
  file: string;
  shell: boolean | string;
}

export interface EffectiveBashShellResolution {
  selection: ExecutionShellSelection;
  provider?: BashShellProvider;
}

export async function resolveEffectiveBashShellSelection(
  options: EffectiveBashShellResolveOptions,
): Promise<EffectiveBashShellResolution> {
  const snapshotResolution = resolveShellSnapshotSelection(options.override);
  if (snapshotResolution) {
    return snapshotResolution;
  }

  return options.platform === "win32"
    ? resolveEffectiveWindowsBashShellSelection(options)
    : resolveEffectivePosixBashShellSelection(options);
}

export function resolvePosixBashShell(
  env: NodeJS.ProcessEnv,
  exists?: ExecutableCheck,
): string | undefined {
  const candidates: string[] = [];
  const shell = env.SHELL;

  if (shell && posixShellKind(shell)) {
    candidates.push(shell);
  }

  for (const kind of preferredPosixShellKinds(env)) {
    candidates.push(...pathCandidates(kind, env));
    candidates.push(...fixedPosixShellCandidates(kind));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableCandidate(candidate, exists)) {
      return candidate;
    }
  }

  return undefined;
}

export async function resolveWindowsBashShellProvider(options: {
  env: NodeJS.ProcessEnv;
  exists?: ExecutableCheck;
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">;
  override?: ExecutionShellSelection;
}): Promise<BashShellProvider | undefined> {
  return (
    await resolveEffectiveWindowsBashShellSelection({
      env: options.env,
      exists: options.exists,
      gitBashDiscovery: options.gitBashDiscovery,
      override: options.override,
      platform: "win32",
    })
  ).provider;
}

export async function resolveWindowsGitBashShell(
  env: NodeJS.ProcessEnv,
  exists?: ExecutableCheck,
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">,
): Promise<string | undefined> {
  // 原来的固定目录/PATH 发现会漏掉非标准安装；共享发现修复漏检，不改 shell 选择策略。
  // exists 注入只描述隔离布局，不能混入本机注册表或配置；显式 discovery probe 仍可覆盖默认隔离。
  const gitBash = await discoverWindowsGitBash({
    ...(exists
      ? {
          readRegistryInstallRoots: async () => [],
          readTextFile: async () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          },
        }
      : {}),
    ...gitBashDiscovery,
    env,
    isExecutable: exists,
    platform: "win32",
  });
  return gitBash?.path;
}

function createGitBashProvider(shellPath: string): BashShellProvider {
  return {
    dialect: "git-bash",
    envOverlay: {
      GIT_EDITOR: "true",
      SHELL: shellPath,
    },
    file: shellPath,
    shell: false,
  };
}

function createPosixShellProvider(shellPath: string): BashShellProvider {
  return {
    dialect: "posix",
    envOverlay: {
      GIT_EDITOR: "true",
      SHELL: shellPath,
    },
    file: shellPath,
    shell: false,
  };
}

function resolveShellSnapshotSelection(
  selection: ExecutionShellSelection | undefined,
): EffectiveBashShellResolution | undefined {
  if (!selection || selection.source === "user-config") {
    return undefined;
  }
  return {
    provider: createShellProviderFromSelection(selection),
    selection,
  };
}

function createShellProviderFromSelection(
  selection: ExecutionShellSelection,
): BashShellProvider | undefined {
  if (!selection.path) return undefined;
  if (selection.dialect === "git-bash") {
    return createGitBashProvider(selection.path);
  }
  if (selection.dialect === "cmd") {
    return createWindowsCmdProvider(selection.path);
  }
  if (selection.dialect === "posix") {
    return createPosixShellProvider(selection.path);
  }
  return undefined;
}

async function resolveEffectiveWindowsBashShellSelection(
  options: EffectiveBashShellResolveOptions,
): Promise<EffectiveBashShellResolution> {
  const override = options.override;
  if (override?.source === "user-config") {
    if (
      override.dialect === "git-bash" &&
      override.path &&
      isExecutableCandidate(override.path, options.exists)
    ) {
      return {
        provider: createGitBashProvider(override.path),
        selection: shellSelection({
          dialect: "git-bash",
          displayName: "Git Bash",
          id: override.id,
          label: override.label,
          path: override.path,
          source: "user-config",
        }),
      };
    }
    if (override.dialect === "cmd") {
      const cmdPath = resolveWindowsCmdOverridePath(override.path ?? "cmd.exe", options.exists);
      if (cmdPath) {
        return {
          provider: createWindowsCmdProvider(cmdPath),
          selection: shellSelection({
            dialect: "cmd",
            displayName: WINDOWS_CMD_SHELL_DISPLAY_NAME,
            id: override.id,
            label: override.label,
            path: cmdPath,
            source: "user-config",
          }),
        };
      }
    }
  }

  const gitBash = await resolveWindowsGitBashShell(
    options.env,
    options.exists,
    options.gitBashDiscovery,
  );
  if (gitBash) {
    return {
      provider: createGitBashProvider(gitBash),
      selection: shellSelection({
        dialect: "git-bash",
        displayName: "Git Bash",
        id: "auto:git-bash",
        label: "Git Bash",
        path: gitBash,
        source: "auto-detected",
      }),
    };
  }

  // 修复原因：这里原来返回 legacy-shell / "system shell"（无 path、无 provider），执行层再另读
  // ComSpec。实际执行器是 cmd.exe，模型却看到 system shell 加工具名 Bash，按 bash 写命令，cmd 不认
  // ls、cat、head 等（Windows 冻结重放 36–42% 的下一步出现这类命令）；Guarded 也因 legacy-shell
  // 一律 unsupported 而不拦危险命令。现在在选择层就定下 ComSpec 上的 CMD，模型、权限、执行读同一份 selection。
  const comSpec = resolveWindowsComSpec(options.env);
  return {
    provider: createWindowsCmdProvider(comSpec),
    selection: shellSelection({
      dialect: "cmd",
      displayName: WINDOWS_CMD_SHELL_DISPLAY_NAME,
      id: "auto:cmd",
      label: WINDOWS_CMD_SHELL_DISPLAY_NAME,
      path: comSpec,
      source: "auto-detected",
    }),
  };
}

function resolveEffectivePosixBashShellSelection(
  options: EffectiveBashShellResolveOptions,
): EffectiveBashShellResolution {
  const bashShell = resolvePosixBashShell(options.env, options.exists);
  if (!bashShell) {
    return legacyShellSelection();
  }
  const kind = posixShellKind(bashShell) ?? "bash";
  return {
    provider: createPosixShellProvider(bashShell),
    selection: shellSelection({
      dialect: "posix",
      displayName: kind,
      id: `auto:${kind}`,
      label: kind,
      path: bashShell,
      source: "auto-detected",
    }),
  };
}

function shellSelection(options: {
  dialect: ExecutionShellDialect;
  displayName: string;
  id?: string;
  label?: string;
  path: string;
  source: "auto-detected" | "user-config";
}): ExecutionShellSelection {
  return {
    dialect: options.dialect,
    display: { name: options.displayName },
    id: options.id,
    label: options.label,
    path: options.path,
    source: options.source,
  };
}

function legacyShellSelection(): EffectiveBashShellResolution {
  return {
    selection: {
      dialect: "legacy-shell",
      display: { name: "system shell" },
      source: "legacy-fallback",
    },
  };
}

function createWindowsCmdProvider(shellPath: string): BashShellProvider {
  return {
    dialect: "cmd",
    file: shellPath,
    shell: shellPath,
  };
}

function resolveWindowsCmdOverridePath(
  shellPath: string,
  exists?: ExecutableCheck,
): string | undefined {
  if (isExecutableCandidate(shellPath, exists)) {
    return shellPath;
  }
  // 设置页在 ComSpec 缺失时会暴露系统默认 cmd.exe fallback；它和 generic
  // Windows shell fallback 一样不能依赖 accessSync 预校验，否则用户显式选择会被 Git Bash 抢走。
  return isWindowsCmdFallback(shellPath) ? shellPath : undefined;
}

function isWindowsCmdFallback(shellPath: string): boolean {
  return (
    !shellPath.includes("\\") &&
    !shellPath.includes("/") &&
    shellPath.toLowerCase() === "cmd.exe"
  );
}

function preferredPosixShellKinds(env: NodeJS.ProcessEnv): PosixShellKind[] {
  if (env.SHELL && posixShellKind(env.SHELL) === "bash") {
    return ["bash", "zsh"];
  }
  return ["zsh", "bash"];
}

function pathCandidates(kind: PosixShellKind, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH;
  if (!pathValue) return [];

  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, kind));
}

function fixedPosixShellCandidates(kind: PosixShellKind): string[] {
  return FIXED_POSIX_SHELL_DIRS.map((dir) => join(dir, kind));
}

function posixShellKind(path: string): PosixShellKind | undefined {
  const name = basename(path);
  if (name.includes("bash")) return "bash";
  if (name.includes("zsh")) return "zsh";
  return undefined;
}

export function isExecutableCandidate(path: string, exists?: ExecutableCheck): boolean {
  if (exists) {
    return exists(path);
  }

  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
