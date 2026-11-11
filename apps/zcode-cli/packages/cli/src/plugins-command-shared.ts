import type { Logger } from "@zcode/contracts";
import type { listZCodePlugins } from "@zcode/bootstrap";
import { createInterface } from "node:readline";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { CliEnv } from "./env.js";

export type BootstrapModule = typeof import("@zcode/bootstrap");
export type PluginListOutcome = Awaited<ReturnType<typeof listZCodePlugins>>;
export type PluginListItem = PluginListOutcome["plugins"][number];
export type PluginDiagnostic = PluginListOutcome["diagnostics"][number];
export type PluginScope = "user" | "workspace";

/**
 * CLI 依赖名 → bootstrap 导出名。测试按依赖名注入假实现；生产路径按导出名懒加载 bootstrap，
 * 避免 `zcode plugins list` 这类轻命令把整个 bootstrap 图提前拉起来。
 */
export const BOOTSTRAP_EXPORTS = {
  addMarketplace: "addZCodePluginMarketplace",
  getPluginsOverview: "getZCodePluginsOverview",
  installPlugin: "installZCodeMarketplacePlugin",
  listPlugins: "listZCodePlugins",
  removeMarketplace: "removeZCodePluginMarketplace",
  setPluginEnabled: "setZCodePluginEnabled",
  uninstallPlugin: "uninstallZCodeMarketplacePlugin",
  updateMarketplace: "updateZCodePluginMarketplace",
  updatePlugin: "updateZCodeMarketplacePlugin",
  validatePluginPath: "validateZCodePluginPath",
} as const satisfies Record<string, keyof BootstrapModule>;

export type PluginDepName = keyof typeof BOOTSTRAP_EXPORTS;
export type PluginDepFn<K extends PluginDepName> = BootstrapModule[(typeof BOOTSTRAP_EXPORTS)[K]];

export type PluginsCommandOverrides = { [K in PluginDepName]?: PluginDepFn<K> };

export interface PluginsCommandDependencies extends PluginsCommandOverrides {
  cwd?: () => string;
  env?: CliEnv;
  logger?: Logger;
  loadBootstrapModule?: () => Promise<BootstrapModule>;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
}

/** `zcode plugins` 子命令专属旗标；由 run.ts 的全局解析器收集后原样透传。 */
export interface PluginsCommandFlags {
  all?: boolean;
  available?: boolean;
  keepData?: boolean;
  scope?: string;
  sparse?: readonly string[];
}

/** 参数用法错误：调用方打印 message + usage 并以 1 退出。 */
export class PluginsUsageError extends Error {}

export function requireOne(rest: string[]): string {
  const [value] = rest;
  if (rest.length !== 1 || !value || value.trim().length === 0) throw new PluginsUsageError();
  return value.trim();
}

export async function resolveDep<K extends PluginDepName>(
  deps: PluginsCommandDependencies,
  key: K,
): Promise<PluginDepFn<K>> {
  const override = deps[key] as PluginDepFn<K> | undefined;
  if (override) return override;
  const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
  return (await bootstrap())[BOOTSTRAP_EXPORTS[key]] as PluginDepFn<K>;
}

export function baseOptions(deps: PluginsCommandDependencies) {
  return {
    env: deps.env ?? process.env,
    logger: deps.logger,
    projectConfigPath: deps.projectConfigPath,
    skipUserConfig: deps.skipUserConfig,
    userConfigPath: deps.userConfigPath,
    workingDirectory: (deps.cwd ?? process.cwd)(),
  };
}

export function resolveScope(value: string | undefined): PluginScope | undefined {
  if (value === undefined) return undefined;
  if (value === "user") return "user";
  if (value === "project") return "workspace";
  if (value === "local") {
    throw new PluginsUsageError("Scope 'local' is not supported by zcode. Use: user, project");
  }
  throw new PluginsUsageError(`Invalid scope '${value}'. Use: user, project`);
}

export function splitPluginIdentifier(value: string): { name: string; marketplace?: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return { name: value };
  return { name: value.slice(0, at), marketplace: value.slice(at + 1) };
}

export function hasErrors(diagnostics: readonly PluginDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/** 裸 name 在已加载插件（内置 + 已安装）里唯一匹配才放行；多个同名必须带 @marketplace。 */
export async function resolveLoadedPluginId(
  deps: PluginsCommandDependencies,
  identifier: string,
): Promise<string> {
  if (splitPluginIdentifier(identifier).marketplace) return identifier;
  const outcome = await (await resolveDep(deps, "listPlugins"))(baseOptions(deps));
  const matches = outcome.plugins.filter((plugin) => plugin.name === identifier);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length > 1) throw ambiguousPluginError(matches.map((plugin) => plugin.id));
  throw new Error(`Plugin not found: ${identifier}`);
}

export function ambiguousPluginError(ids: string[]): Error {
  return new Error(`Plugin name is ambiguous, use <plugin>@<marketplace>: ${ids.join(", ")}`);
}

export function confirmUninstall(ctx: RunContext, pluginId: string): Promise<boolean> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: ctx.stdin, output: ctx.stdout });
    rl.question(`Uninstall ${pluginId}? [y/N] `, (answer) => {
      rl.close();
      resolvePrompt(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export function reportPluginsError(
  ctx: RunContext,
  options: GlobalOptions,
  error: unknown,
): number {
  const message = error instanceof Error ? error.message : String(error);
  ctx.stderr.write(`Error: ${message}\n`);
  if (options.verbose && error instanceof Error && error.stack) {
    ctx.stderr.write(`${error.stack}\n`);
  }
  return 1;
}
