import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import {
  formatDiagnosticJson,
  formatDiagnosticLines,
  formatHumanMarketplaceList,
  formatMarketplaceJson,
  writeWarnings,
} from "./plugins-command-format.js";
import {
  baseOptions,
  hasErrors,
  PluginsUsageError,
  requireOne,
  resolveDep,
  resolveScope,
  type PluginsCommandDependencies,
  type PluginsCommandFlags,
} from "./plugins-command-shared.js";

export async function runMarketplaceCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  args: string[],
): Promise<number> {
  const [action, ...rest] = args;
  const base = baseOptions(deps);
  switch (action) {
    case "add": {
      // marketplaces 只有 Host 级一份，这里仅校验拼写以保持参数面一致。
      resolveScope(flags.scope);
      const source = requireOne(rest);
      const summary = await (
        await resolveDep(deps, "addMarketplace")
      )({
        ...base,
        source,
        ...(flags.sparse?.length ? { sparsePaths: [...flags.sparse] } : {}),
      });
      ctx.stdout.write(
        options.json
          ? formatJson(formatMarketplaceJson(summary))
          : `Added marketplace ${summary.id} (${summary.pluginCount} plugins)\n`,
      );
      return 0;
    }
    case "list": {
      if (rest.length > 0) throw new PluginsUsageError();
      const overview = await (await resolveDep(deps, "getPluginsOverview"))(base);
      ctx.stdout.write(
        options.json
          ? formatJson(overview.marketplaces.map(formatMarketplaceJson))
          : formatHumanMarketplaceList(overview.marketplaces),
      );
      return 0;
    }
    case "remove": {
      const marketplace = requireOne(rest);
      await (
        await resolveDep(deps, "removeMarketplace")
      )({ ...base, marketplace });
      ctx.stdout.write(
        options.json
          ? formatJson({ marketplace, removed: true })
          : `Removed marketplace ${marketplace}\n`,
      );
      return 0;
    }
    case "update": {
      if (rest.length > 1) throw new PluginsUsageError();
      const marketplace = rest[0]?.trim();
      const result = await (
        await resolveDep(deps, "updateMarketplace")
      )({
        ...base,
        ...(marketplace ? { marketplace } : {}),
      });
      const failed = hasErrors(result.diagnostics);
      if (options.json) {
        ctx.stdout.write(
          formatJson({
            ok: !failed,
            marketplaces: result.marketplaces.map(formatMarketplaceJson),
            diagnostics: result.diagnostics.map(formatDiagnosticJson),
          }),
        );
        return failed ? 1 : 0;
      }
      for (const summary of result.marketplaces) {
        ctx.stdout.write(`Updated marketplace ${summary.id} (${summary.pluginCount} plugins)\n`);
      }
      if (failed) {
        ctx.stderr.write(`Marketplace update failed\n${formatDiagnosticLines(result.diagnostics)}`);
        return 1;
      }
      writeWarnings(ctx, result.diagnostics);
      return 0;
    }
    default:
      throw new PluginsUsageError(
        action ? `Unknown marketplace command: ${action}` : "Missing marketplace command",
      );
  }
}
