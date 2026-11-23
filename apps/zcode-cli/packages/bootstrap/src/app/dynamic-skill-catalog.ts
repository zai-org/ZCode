import {
  createCatalogSkillPort,
  createSkillCatalogSource,
  type CatalogSkillPort,
} from "@zcode/adapters/skills/catalog";
import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import { discoverWorkspaceHookConfigPathsAsync } from "@zcode/shared/workspace-hook-discovery";
import type { Logger, PluginLoadOutcome, SkillRoot } from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";
import { getPluginStorageRoot } from "./paths.js";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_VISUALIZE_PLUGIN_ID,
} from "./official-plugin-definitions.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";

/**
 * 会话的 skill 端口读进程级实时目录（规则见根目录 docs/skills-live-catalog.md）。
 * 配置文件路径与 MCP 配置源同一份：两者监听同一组提交点，同一路径在进程内共用系统句柄。
 */
export async function createAppSkillPort(input: {
  options: ZCodeAppOptions;
  configResult: ConfigResult;
  pluginOutcome: PluginLoadOutcome;
  bundledSkillRoots: readonly SkillRoot[];
  cliStorageRoot: string;
  workingDirectory: string;
  logger: Logger;
}): Promise<CatalogSkillPort> {
  const { options, configResult, workingDirectory } = input;
  const projectPaths = await discoverWorkspaceHookConfigPathsAsync({
    workingDirectory,
    explicitProjectConfigPath: options.projectConfigPath,
    includeMissing: true,
  });
  const userPath = options.skipUserConfig ? undefined : configResult.sources.user.path;
  const sourceOptions = {
    homeDirectory: resolvePath("~/"),
    workingDirectory,
    additionalDirectories: options.additionalDirectories,
    configPaths: [...projectPaths.map((ref) => ref.path), ...(userPath ? [userPath] : [])],
    userConfigPath: userPath,
    pluginStorageRoot: options.pluginStorageRoot ?? getPluginStorageRoot(input.cliStorageRoot),
    pluginRoots: input.pluginOutcome.plugins,
    defaultEnabledPlugins: new Set(DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS),
    bundledRoots: input.bundledSkillRoots,
    // 动态工作流关闭时不提供 dynamic-workflows 技能：
    // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
    fixedDisabledPaths:
      options.runtimeConfig?.dynamicWorkflowEnabled === false
        ? collectDynamicWorkflowDisabledSkillPaths(input.bundledSkillRoots)
        : [],
    // 终端会话没有内联视图宿主；只过滤官方插件身份，与启动时的 visualize 门一致。
    excludedPluginIds: options.includeVisualize ? [] : [OFFICIAL_VISUALIZE_PLUGIN_ID],
    logger: input.logger,
  };
  const source = options.skillCatalogSourceRegistry
    ? await options.skillCatalogSourceRegistry.acquire(sourceOptions)
    : await createSkillCatalogSource(sourceOptions);
  return createCatalogSkillPort(source);
}
