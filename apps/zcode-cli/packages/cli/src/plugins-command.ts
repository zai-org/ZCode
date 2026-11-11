import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { SetZCodePluginEnabledResult, ZCodePluginInstallData } from "@zcode/bootstrap";
import {
  formatAvailablePluginJson,
  formatDiagnosticJson,
  formatDiagnosticLines,
  formatHumanAvailableList,
  formatHumanPluginList,
  formatHumanPluginSet,
  formatHumanPluginUninstall,
  formatInstalledPluginJson,
  formatPluginJson,
  formatPluginSetJson,
  writeWarnings,
} from "./plugins-command-format.js";
import {
  ambiguousPluginError,
  baseOptions,
  confirmUninstall,
  hasErrors,
  type PluginListItem,
  PluginsUsageError,
  reportPluginsError,
  requireOne,
  resolveDep,
  resolveLoadedPluginId,
  resolveScope,
  splitPluginIdentifier,
  type PluginsCommandDependencies,
  type PluginsCommandFlags,
} from "./plugins-command-shared.js";
import { runMarketplaceCommand } from "./plugins-marketplace-command.js";

export type {
  PluginsCommandDependencies,
  PluginsCommandFlags,
  PluginsCommandOverrides,
} from "./plugins-command-shared.js";

const PLUGINS_COMMAND_USAGE = `Usage: zcode plugins <command> [options]

Commands:
  list [--json] [--available]                  List installed plugins; --available also lists the marketplace catalog
  install <plugin>[@marketplace] [-s <scope>]  Install a plugin from a known marketplace
  uninstall <plugin> [-s <scope>] [--keep-data] [--force]
                                               Uninstall a plugin (--keep-data keeps its data directory)
  enable <plugin> [-s <scope>]                 Enable a plugin
  disable [plugin] [-a|--all] [-s <scope>]     Disable a plugin, or every enabled plugin with --all
  update <plugin> [-s <scope>]                 Update a plugin to the latest marketplace version
  validate <path>                              Validate a plugin or marketplace manifest
  marketplace add <source> [--scope <scope>] [--sparse <path>]
                                               Add a marketplace from a URL, path, or GitHub repo
  marketplace list [--json]                    List configured marketplaces
  marketplace remove <name>                    Remove a configured marketplace
  marketplace update [name]                    Refresh one marketplace, or all when omitted

Scopes: user (default), project. \`zcode plugin\` is an alias of \`zcode plugins\`.`;

export async function runPluginsCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  args: string[],
  flags: PluginsCommandFlags = {},
): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  try {
    switch (subcommand) {
      case "list":
        if (rest.length > 0) throw new PluginsUsageError();
        return await runPluginsListCommand(ctx, options, deps, flags);
      case "install":
        return await runPluginsInstallCommand(ctx, options, deps, flags, requireOne(rest));
      case "uninstall":
        return await runPluginsUninstallCommand(ctx, options, deps, flags, requireOne(rest));
      case "enable":
        return await runPluginsSetCommand(ctx, options, deps, flags, requireOne(rest), true);
      case "disable":
        return await runPluginsDisableCommand(ctx, options, deps, flags, rest);
      case "update":
        return await runPluginsUpdateCommand(ctx, options, deps, flags, requireOne(rest));
      case "validate":
        return await runPluginsValidateCommand(ctx, options, deps, requireOne(rest));
      case "marketplace":
        return await runMarketplaceCommand(ctx, options, deps, flags, rest);
      default:
        throw new PluginsUsageError(`Unknown plugins command: ${subcommand}`);
    }
  } catch (error) {
    if (error instanceof PluginsUsageError) {
      ctx.stderr.write(`${error.message ? `${error.message}\n` : ""}${PLUGINS_COMMAND_USAGE}\n`);
      return 1;
    }
    return reportPluginsError(ctx, options, error);
  }
}

async function runPluginsListCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
): Promise<number> {
  const base = baseOptions(deps);
  const outcome = await (await resolveDep(deps, "listPlugins"))(base);
  const installed = outcome.plugins.map((plugin) => formatPluginJson(plugin, outcome.diagnostics));
  if (!flags.available) {
    ctx.stdout.write(
      options.json ? formatJson(installed) : formatHumanPluginList(outcome, options),
    );
    // 市场刷新失败这类诊断的 pluginId 是市场 id 或为空，归不到任何条目；error 级不能静默丢掉。
    const knownIds = new Set(outcome.plugins.map((plugin) => plugin.id));
    const orphaned = outcome.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        !(diagnostic.pluginId && knownIds.has(diagnostic.pluginId)),
    );
    if (orphaned.length === 0) return 0;
    ctx.stderr.write(formatDiagnosticLines(orphaned));
    return 1;
  }
  const overview = await (await resolveDep(deps, "getPluginsOverview"))(base);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        installed,
        available: overview.availablePlugins.map(formatAvailablePluginJson),
        diagnostics: [...outcome.diagnostics, ...overview.diagnostics].map(formatDiagnosticJson),
      }),
    );
    return 0;
  }
  ctx.stdout.write(
    `${formatHumanPluginList(outcome, options)}\n${formatHumanAvailableList(overview.availablePlugins)}`,
  );
  return 0;
}

async function runPluginsInstallCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  identifier: string,
): Promise<number> {
  const scope = resolveScope(flags.scope) ?? "user";
  const base = baseOptions(deps);
  const { name } = splitPluginIdentifier(identifier);
  let { marketplace } = splitPluginIdentifier(identifier);
  if (!marketplace) {
    const overview = await (await resolveDep(deps, "getPluginsOverview"))(base);
    const matches = overview.availablePlugins.filter((plugin) => plugin.name === name);
    if (matches.length > 1) throw ambiguousPluginError(matches.map((plugin) => plugin.id));
    if (matches.length === 0 || !matches[0]) {
      throw new Error(`Plugin not found in any marketplace: ${name}`);
    }
    marketplace = matches[0].marketplace;
  }
  const result = await (
    await resolveDep(deps, "installPlugin")
  )({
    ...base,
    marketplace,
    pluginName: name,
    scope,
  });
  return reportInstallOutcome(ctx, options, result, `${name}@${marketplace}`);
}

async function runPluginsUpdateCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  identifier: string,
): Promise<number> {
  resolveScope(flags.scope);
  const pluginId = await resolveLoadedPluginId(deps, identifier);
  const result = await (
    await resolveDep(deps, "updatePlugin")
  )({
    ...baseOptions(deps),
    pluginId,
  });
  const current = result.installedPlugins.find((plugin) => plugin.id === pluginId);
  const failed = hasErrors(result.diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        pluginId,
        ok: !failed,
        previousVersion: result.previousVersion,
        ...(current?.version ? { version: current.version } : {}),
        installed: result.installedPlugins.map(formatInstalledPluginJson),
        diagnostics: result.diagnostics.map(formatDiagnosticJson),
      }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(
      `Failed to update plugin ${pluginId}\n${formatDiagnosticLines(result.diagnostics)}`,
    );
    return 1;
  }
  const version = current?.version ?? "";
  ctx.stdout.write(
    version && version === result.previousVersion
      ? `Plugin ${pluginId} is already up to date (${version}).\n`
      : `Updated plugin ${pluginId} from ${result.previousVersion || "unknown"} to ${version || "unknown"}. Restart zcode to apply.\n`,
  );
  writeWarnings(ctx, result.diagnostics);
  return 0;
}

function reportInstallOutcome(
  ctx: RunContext,
  options: GlobalOptions,
  result: ZCodePluginInstallData,
  pluginId: string,
): number {
  const failed = hasErrors(result.diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        pluginId,
        ok: !failed,
        installed: result.installedPlugins.map(formatInstalledPluginJson),
        dependencyClosure: result.dependencyClosure,
        diagnostics: result.diagnostics.map(formatDiagnosticJson),
      }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(
      `Failed to install plugin ${pluginId}\n${formatDiagnosticLines(result.diagnostics)}`,
    );
    return 1;
  }
  for (const plugin of result.installedPlugins) {
    const version = plugin.version ? ` (${plugin.version})` : "";
    ctx.stdout.write(
      `Installed plugin ${plugin.id}${version} [${plugin.enabled ? "enabled" : "disabled"}]\n`,
    );
  }
  writeWarnings(ctx, result.diagnostics);
  return 0;
}

async function runPluginsSetCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  plugin: string,
  enabled: boolean,
): Promise<number> {
  const scope = resolveScope(flags.scope);
  const result = await (
    await resolveDep(deps, "setPluginEnabled")
  )({
    ...baseOptions(deps),
    enabled,
    plugin,
    ...(scope ? { scope } : {}),
  });
  ctx.stdout.write(options.json ? formatPluginSetJson(result) : formatHumanPluginSet(result));
  return 0;
}

async function runPluginsDisableCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  rest: string[],
): Promise<number> {
  if (flags.all && rest.length > 0) {
    throw new PluginsUsageError("Cannot use --all with a specific plugin");
  }
  if (!flags.all) {
    if (rest.length === 0) {
      throw new PluginsUsageError(
        "Please specify a plugin name or use --all to disable all plugins",
      );
    }
    return await runPluginsSetCommand(ctx, options, deps, flags, requireOne(rest), false);
  }
  if (flags.scope !== undefined) throw new PluginsUsageError("Cannot use --scope with --all");
  const base = baseOptions(deps);
  const listPlugins = await resolveDep(deps, "listPlugins");
  const setPluginEnabled = await resolveDep(deps, "setPluginEnabled");
  const entries: Array<{
    plugin: PluginListItem;
    result?: SetZCodePluginEnabledResult;
    error?: string;
  }> = [];
  for (const plugin of (await listPlugins(base)).plugins) {
    if (!plugin.enabled) continue;
    try {
      entries.push({
        plugin,
        result: await setPluginEnabled({ ...base, enabled: false, plugin: plugin.id }),
      });
    } catch (error) {
      entries.push({ plugin, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // 写的是 user 层；workspace/project 层的 enabledPlugins=true 优先级更高、盖不掉，所以按 effective 态复查。
  const stillEnabled = new Set(
    (await listPlugins(base)).plugins.filter((p) => p.enabled).map((p) => p.id),
  );
  const failed = entries.filter((entry) => entry.error || stillEnabled.has(entry.plugin.id));
  if (options.json) {
    ctx.stdout.write(
      formatJson(
        entries.map((entry) => ({
          enabled: entry.result?.enabled ?? entry.plugin.enabled,
          effectiveEnabled: stillEnabled.has(entry.plugin.id),
          path: entry.result?.path ?? null,
          plugin: formatPluginJson(entry.result?.plugin ?? entry.plugin, []),
          ...(entry.error ? { error: entry.error } : {}),
        })),
      ),
    );
    return failed.length > 0 ? 1 : 0;
  }
  if (entries.length === 0) {
    ctx.stdout.write("No enabled plugins.\n");
    return 0;
  }
  for (const entry of entries) {
    if (entry.result && !failed.includes(entry))
      ctx.stdout.write(formatHumanPluginSet(entry.result));
  }
  for (const entry of failed) {
    ctx.stderr.write(
      entry.error
        ? `Failed to disable plugin ${entry.plugin.id}: ${entry.error}\n`
        : `Warning: plugin ${entry.plugin.id} is still enabled by a higher-priority config layer (project/workspace); disable it there with --scope project.\n`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}

async function runPluginsUninstallCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  identifier: string,
): Promise<number> {
  resolveScope(flags.scope);
  const target = await resolveLoadedPluginId(deps, identifier);
  // 卸载是破坏性的彻底清除：交互终端下询问确认；非交互(管道/CI)且未带 --force 时拒绝执行，不静默卸载。
  if (!options.force) {
    if (!ctx.stdin.isTTY) {
      ctx.stderr.write(
        `Refusing to uninstall ${target} without confirmation. Re-run with --force in a non-interactive shell.\n`,
      );
      return 1;
    }
    const confirmed = await confirmUninstall(ctx, target);
    if (!confirmed) {
      ctx.stdout.write(`Aborted. ${target} was not uninstalled.\n`);
      return 0;
    }
  }

  const removed = await (
    await resolveDep(deps, "uninstallPlugin")
  )({
    ...baseOptions(deps),
    pluginId: target,
    ...(flags.keepData ? { keepData: true } : {}),
  });

  ctx.stdout.write(
    options.json
      ? formatJson({
          pluginId: removed?.id ?? target,
          removed: removed !== null,
          ...(flags.keepData ? { keptData: true } : {}),
          ...(removed ? { plugin: formatInstalledPluginJson(removed) } : {}),
        })
      : formatHumanPluginUninstall(removed, target),
  );
  return removed ? 0 : 1;
}

async function runPluginsValidateCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  path: string,
): Promise<number> {
  const diagnostics = await (
    await resolveDep(deps, "validatePluginPath")
  )({
    ...baseOptions(deps),
    path,
  });
  const failed = hasErrors(diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({ path, ok: !failed, diagnostics: diagnostics.map(formatDiagnosticJson) }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(`Plugin manifest is invalid: ${path}\n${formatDiagnosticLines(diagnostics)}`);
    return 1;
  }
  ctx.stdout.write(`Plugin manifest is valid: ${path}\n`);
  writeWarnings(ctx, diagnostics);
  return 0;
}
