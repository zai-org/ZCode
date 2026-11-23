import { mkdir, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import type {
  Logger,
  McpConfigurationSnapshot,
  McpServerConfig,
  PluginMetadata,
  PluginDiagnostic,
} from "@zcode/contracts";
import { DefaultRuntimeConfig } from "@zcode/contracts";
import {
  readPluginSecretsFile,
  resolvePluginSecretOverrides,
  resolvePluginSecretsPath,
} from "../config/plugin-secrets.adapter.js";
import type { PluginOptionLayer } from "../config/config-factory.js";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../config/schema.js";
import {
  normalizeMcpServersShape,
  pluginMcpSources,
  resolvePluginMcpServers,
} from "../plugins/mcp.js";
import { sanitizePluginId } from "../plugins/helpers.js";
import {
  createLiveFileReader,
  readEnabledPlugins,
  readLiveConfig,
  type LivePluginCandidate,
} from "../plugins/live-inventory.js";
import { normalizeProjectMcpServer } from "../config/project-config.adapter.js";

export interface McpConfigurationLoaderOptions {
  configPaths: string[];
  userConfigPath?: string;
  fallbackPaths?: Record<string, string>;
  pluginStorageRoot: string;
  pluginRoots: LivePluginCandidate[];
  explicitServers?: Record<string, McpServerConfig>;
  workingDirectory: string;
  env?: Record<string, string | undefined>;
  defaultEnabledPlugins?: ReadonlySet<string>;
  logger?: Logger;
}

type StablePlugins = Map<string, { id: string; servers: Record<string, McpServerConfig> }>;

export function createMcpConfigurationLoader(options: McpConfigurationLoaderOptions) {
  // 读文件的回退基础与 warn 去重由共享 reader 持有，只在结果被采纳时提交。
  const reader = createLiveFileReader({
    label: "MCP configuration",
    logger: options.logger,
  });
  // 只跨越原子安装的未提交窗口保留稳定执行配置；解析失败、禁用、卸载均不回退。
  let stablePlugins: StablePlugins = new Map();

  async function load() {
    const pass = reader.begin();
    const { json, warnings } = pass;
    const { files, merged } = await readLiveConfig(pass, options);
    // 磁盘配置每次从来源重算，不能把旧合并结果作为底层，否则删除的 server 会复活。
    let servers: Record<string, McpServerConfig> = {};
    // 修复原因：项目配置曾原样进入加载器，项目 plugins.dirs 能注册并启动未经信任的插件 MCP。
    // 项目文件与启动配置共用白名单与 normalizeProjectConfig，去掉 Hook 声明与 plugins.dirs。
    for (const { path, user, base, patch } of files) {
      let configured = patch.mcp?.servers;
      const fallback = options.fallbackPaths?.[path];
      if (!Object.keys(configured ?? {}).length && fallback) {
        const legacy = await json(fallback, (value) => {
          const result = parseConfigFileToRuntimePatchWithDiagnostics({
            mcp: { servers: value.mcpServers ?? {} },
          });
          if (result.diagnostics.some((item) => item.severity === "error"))
            throw new Error("Invalid legacy MCP configuration");
        });
        configured = parseConfigFileToRuntimePatchWithDiagnostics({
          mcp: { servers: legacy?.mcpServers ?? {} },
        }).config.mcp?.servers;
      }
      // 修复原因：修复前磁盘 server 不带来源，工作区 guard 要自己推断。回退文件的读取规则与
      // guard 的声明规则不同，推断不到时放行，未信任工作区里的命令被执行。
      // 来源按声明它的文件标记：项目文件及其回退为 workspace，用户配置及其回退为 user。
      for (const [name, server] of Object.entries(configured ?? {})) {
        servers[name] = user
          ? { ...server, source: { kind: "user" } }
          : { ...normalizeProjectMcpServer(server, base), source: { kind: "workspace" } };
      }
    }
    const enabled = merged.features?.mcp ?? DefaultRuntimeConfig.features.mcp;
    const plugins = { ...DefaultRuntimeConfig.plugins, ...merged.plugins };
    // 私有选项曾只叠加到启动视图，动态加载器重读时会丢失。两条路径共用规则，并监听保存和清除。
    const secretsPath = resolvePluginSecretsPath(options.pluginStorageRoot);
    pass.files.add(secretsPath);
    const secrets = await readPluginSecretsFile(secretsPath);
    if (secrets.status === "unreadable") {
      warnings.push([
        "Plugin private options file is unreadable",
        { path: secretsPath, reason: secrets.reason },
      ]);
    }
    const layers: PluginOptionLayer[] = [
      ...files.filter((file) => file.user),
      ...files.filter((file) => !file.user && file.loaded),
    ].map(({ user, path, base, patch }) => ({
      scope: user ? "user" : "workspace",
      path,
      ...(user ? {} : { workspaceRoot: base }),
      options: patch.plugins?.options ?? {},
    }));
    plugins.options = { ...plugins.options };
    for (const { pluginId, key, value } of resolvePluginSecretOverrides(layers, secrets.file)) {
      plugins.options[pluginId] = { ...plugins.options[pluginId], [key]: value };
    }
    const pluginServers: Record<string, McpServerConfig> = {};
    const nextStablePlugins: StablePlugins = new Map();
    for (const { candidate, loaded, stable, watched } of await readEnabledPlugins(pass, {
      plugins,
      pluginStorageRoot: options.pluginStorageRoot,
      pluginRoots: options.pluginRoots,
      defaultEnabledPlugins: options.defaultEnabledPlugins,
    })) {
      if (!stable) {
        const previous = stablePlugins.get(candidate.rootPath);
        if (previous?.id === loaded.id) {
          nextStablePlugins.set(candidate.rootPath, previous);
          Object.assign(pluginServers, previous.servers);
        }
        continue;
      }
      try {
        const diagnostics: PluginDiagnostic[] = [];
        const context = { loaded, diagnostics };
        const definitions = Object.assign(
          {},
          ...(await Promise.all(
            pluginMcpSources(context).map(async (source) => {
              if (typeof source !== "string") return source;
              const value = await json(source, undefined, watched);
              return value === undefined ? {} : normalizeMcpServersShape(value, context);
            }),
          )),
        );
        const dataPath = join(options.pluginStorageRoot, "data", sanitizePluginId(loaded.id));
        const resolved = resolvePluginMcpServers({
          loaded,
          definitions,
          diagnostics,
          dataPath,
          env: options.env ?? process.env,
          options: plugins.options[loaded.id] ?? {},
          workingDirectory: options.workingDirectory,
        });
        // 首次热启用没有经过全量插件启动；发布前准备 cwd，失败只撤下当前插件。
        // MCP 关闭时不会启动这些 server，不创建目录。
        if (enabled && Object.keys(resolved).length > 0) await mkdir(dataPath, { recursive: true });
        for (const diagnostic of diagnostics)
          warnings.push(["Plugin MCP configuration diagnostic", { ...diagnostic }]);
        nextStablePlugins.set(candidate.rootPath, { id: loaded.id, servers: resolved });
        Object.assign(pluginServers, resolved);
      } catch (error) {
        // 变量声明等插件级错误不属于单个 server，不能让它阻断其他配置来源的增删。
        warnings.push([
          "Plugin MCP preparation failed",
          { pluginId: loaded.id, error: String(error) },
        ]);
      }
    }
    servers = { ...pluginServers, ...(options.explicitServers ?? servers) };
    const filesystem = servers.filesystem;
    // 配置重载发生在真正的执行环境；只补当前 workspace，不能丢掉首次创建时的目录授权。
    if (
      !options.explicitServers &&
      filesystem?.type === "stdio" &&
      filesystem.args?.some((arg) => arg.includes("@modelcontextprotocol/server-filesystem")) &&
      (
        await stat(options.workingDirectory).catch((error: NodeJS.ErrnoException) => {
          // 可选目录读取失败只跳过追加。修复前非 ENOENT 错误会让整次加载失败、配置无法发布。
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
            warnings.push([
              "MCP filesystem workspace unavailable",
              { path: options.workingDirectory, error: String(error) },
            ]);
          return undefined;
        })
      )?.isDirectory()
    ) {
      const key = (value: string) => {
        const path = normalize(value.trim()).replace(/[\\/]+$/, "");
        return process.platform === "win32" ? path.toLowerCase() : path;
      };
      if (!filesystem.args.some((arg) => key(arg) === key(options.workingDirectory))) {
        servers.filesystem = {
          ...filesystem,
          args: [...filesystem.args, options.workingDirectory],
        };
      }
    }
    // 返回未整形的结果：同一进程内共享的配置源把它交给每个会话自己的 prepare。
    // servers 与 pluginServers 共用同一批对象，官方 CUA 信任按对象身份判定，调用方不能深拷贝。
    return {
      configuration: { enabled, servers } satisfies McpConfigurationSnapshot,
      pluginServers,
      files: pass.files,
      /** 调用方采纳本次结果后提交回退基础与稳定插件配置，并只记录新出现的加载 warn。 */
      commit() {
        pass.commit();
        stablePlugins = nextStablePlugins;
      },
    };
  }

  return { load };
}
