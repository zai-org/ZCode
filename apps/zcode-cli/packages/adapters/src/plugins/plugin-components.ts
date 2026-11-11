import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CustomCommandRoot,
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
  PluginDiagnostic,
  PluginManifest,
  SkillRoot,
} from "@zcode/contracts";
import {
  directoryExistsAsync,
  fileExistsAsync,
  writePluginTextIfChanged,
  type PluginMaterialReader,
  rethrowPluginMaterialInterrupt,
  isMissingPathAsync,
  parsePathList,
  isRecord,
  resolveInside,
} from "./helpers.js";
import { createHookPluginContext, listPluginHookEventNames } from "./hook-sources.js";
import {
  applyCommandMetadataFrontmatter,
  readMarkdownFrontmatters,
} from "./markdown-frontmatter.js";
import { loadPluginMcpServerDefinitions } from "./mcp.js";
import { scanSkillFilesUnderRoot } from "../skills/scan.js";
import type { LoadedPlugin } from "./types.js";

// 组件分组类型定义已上移到 @zcode/contracts（PluginMetadata 需要引用），这里再导出保持对外契约稳定。
export type { PluginComponentGroup, PluginComponentItem, PluginComponentKind };

/**
 * 在已解析的插件根目录上枚举各类组件的名称与描述。纯文件读取，跨平台只用 node:path/fs。
 * manifest 由调用方读取后传入（可为 null）；缺失目录或无 frontmatter 时跳过或省略描述，
 * 不因单个组件异常阻断整体枚举。
 */
export async function enumeratePluginComponents(
  rootPath: string,
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin } = {},
): Promise<PluginComponentGroup[]> {
  const groups: PluginComponentGroup[] = [];
  const agentItems = await collectMarkdownComponents(
    rootPath,
    manifest?.agents,
    "agents",
    options.loaded?.materials,
  );
  if (agentItems.length > 0) groups.push({ kind: "agent", items: agentItems });

  const commandItems = await collectMarkdownComponents(
    rootPath,
    manifest?.commands,
    "commands",
    options.loaded?.materials,
  );
  if (commandItems.length > 0) groups.push({ kind: "command", items: commandItems });

  // 信任边界：组件枚举的 rootPath 就是插件根，扫描无条件不跟随符号链接——
  // 不依赖 loaded 是否凑齐（manifest 解析失败的 marketplace describe 链路同样生效）。
  const skillItems = await collectSkillComponents(
    rootPath,
    manifest?.skills,
    options.loaded?.materials,
  );
  if (skillItems.length > 0) groups.push({ kind: "skill", items: skillItems });

  const hookItems = await collectHookComponents(manifest, options);
  if (hookItems.length > 0) groups.push({ kind: "hook", items: hookItems });

  const mcpItems = await collectMcpComponents(manifest, options);
  if (mcpItems.length > 0) groups.push({ kind: "mcp", items: mcpItems });

  return groups;
}

/** command/agent：默认目录 + manifest 声明的额外路径下的 .md 文件，读 frontmatter name/description。 */
async function collectMarkdownComponents(
  rootPath: string,
  manifestField: unknown,
  defaultDir: "commands" | "agents",
  materials?: PluginMaterialReader,
): Promise<PluginComponentItem[]> {
  const items: PluginComponentItem[] = [];
  const seen = new Set<string>();

  // object 形式声明（{ name: { source|content, description } }）直接取声明的描述。
  if (isRecord(manifestField)) {
    for (const [rawName, rawMeta] of Object.entries(manifestField)) {
      const name = rawName.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description =
        isRecord(rawMeta) && typeof rawMeta.description === "string"
          ? rawMeta.description.trim()
          : undefined;
      items.push(description ? { name, description } : { name });
    }
  }

  const dirs = await collectComponentDirs(rootPath, manifestField, defaultDir, materials);
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await (materials?.directory(dir) ?? readdir(dir, { withFileTypes: true })))
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".md"))
        .map((dirent) => dirent.name);
    } catch (error) {
      rethrowPluginMaterialInterrupt(error);
      continue;
    }
    const frontmatters = await readMarkdownFrontmatters(
      entries.map((name) => join(dir, name)),
      materials,
    );
    for (const [index, fileName] of entries.entries()) {
      const baseName = fileName.slice(0, -".md".length);
      const path = join(dir, fileName);
      const fm = frontmatters[index]!;
      const name = fm.name ?? baseName;
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        name,
        ...(fm.description ? { description: fm.description } : {}),
        ...(defaultDir === "agents" ? { path } : {}),
      });
    }
  }
  return items;
}

/**
 * skill：有声明时只使用声明路径，否则使用默认 skills 目录。
 * 单技能入口不额外扫描子目录；按文件路径和最终 name 去重。
 */
async function collectSkillComponents(
  rootPath: string,
  manifestField: unknown,
  materials?: PluginMaterialReader,
): Promise<PluginComponentItem[]> {
  const items: PluginComponentItem[] = [];
  const seenFiles = new Set<string>();
  const seenNames = new Set<string>();
  const dirs = await collectComponentDirs(rootPath, manifestField, "skills", materials);
  for (const dir of dirs) {
    let skillFiles: string[];
    try {
      skillFiles = await (materials?.skillFiles(dir) ??
        scanSkillFilesUnderRoot(dir, { followSymbolicLinks: false, stopAtSkill: true }));
    } catch (error) {
      rethrowPluginMaterialInterrupt(error);
      continue;
    }
    const freshFiles = skillFiles.filter((skillFile) => {
      if (seenFiles.has(skillFile)) return false;
      seenFiles.add(skillFile);
      return true;
    });
    const frontmatters = await readMarkdownFrontmatters(freshFiles, materials);
    for (const [index, skillFile] of freshFiles.entries()) {
      const fallbackName = basename(dirname(skillFile));
      const fm = frontmatters[index]!;
      const name = fm.name ?? fallbackName;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      items.push(fm.description ? { name, description: fm.description } : { name });
    }
  }
  return items;
}

/** hook：复用 loader 的来源发现规则，但只取事件名用于详情展示，不构造可执行 hook。 */
async function collectHookComponents(
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin },
): Promise<PluginComponentItem[]> {
  if (options.loaded) {
    return (
      await listPluginHookEventNames({
        diagnostics: options.diagnostics ?? [],
        loaded: options.loaded,
      })
    ).map((name) => ({ name }));
  }
  if (!manifest) return [];
  return collectInlineHookEvents(manifest.hooks).map((name) => ({ name }));
}

/** mcp：复用 loader 读取 `.mcp.json` + `manifest.mcpServers` 的纯读解析，只展示原始 server 名。 */
async function collectMcpComponents(
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin },
): Promise<PluginComponentItem[]> {
  if (options.loaded) {
    return Object.keys(
      await loadPluginMcpServerDefinitions({
        diagnostics: options.diagnostics ?? [],
        loaded: options.loaded,
      }),
    )
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name }));
  }
  if (!manifest || !isRecord(manifest.mcpServers)) return [];
  return Object.keys(manifest.mcpServers)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function collectInlineHookEvents(value: unknown): string[] {
  const hooksField =
    isRecord(value) && isRecord((value as Record<string, unknown>).hooks)
      ? ((value as Record<string, unknown>).hooks as Record<string, unknown>)
      : value;
  if (!isRecord(hooksField)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const event of Object.keys(hooksField)) {
    const name = event.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 解析组件目录；skills 显式声明优先，其他组件保留默认目录合并规则。 */
async function collectComponentDirs(
  rootPath: string,
  manifestField: unknown,
  defaultDir: string,
  materials?: PluginMaterialReader,
): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const resolvedPath = resolveInside(rootPath, raw.replace(/^\.\//, ""));
    if (!resolvedPath || seen.has(resolvedPath)) return;
    seen.add(resolvedPath);
    dirs.push(resolvedPath);
  };
  const defaultPath = join(rootPath, defaultDir);
  if (
    (defaultDir !== "skills" || manifestField === undefined) &&
    (await (materials?.directoryExists(defaultPath) ?? directoryExistsAsync(defaultPath)))
  )
    add(defaultDir);
  if (typeof manifestField === "string") add(manifestField);
  else if (Array.isArray(manifestField)) {
    for (const value of manifestField) if (typeof value === "string") add(value);
  }
  return dirs;
}

/**
 * manifest 显式声明的 skills 路径没有可用技能时发出诊断，避免路径配置错误静默失败。
 * 声明集合独立于 roots 列表计算，默认 skills/ 目录为空时不误报；路径缺失、目录为空和
 * 符号链接越界分别保留可操作的诊断信息，权限错误交给实际扫描链路报告。
 */
export async function warnEmptyDeclaredSkillRoots(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): Promise<void> {
  const declared = parsePathList(input.loaded.manifest.skills);
  if (declared.length === 0) return;
  const seenPaths = new Set<string>();
  for (const rawPath of declared) {
    const resolved = resolveInside(input.loaded.rootPath, rawPath);
    if (!resolved || seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    // 路径缺失判定只认 ENOENT/ENOTDIR（stat 精确分类），EACCES 等权限
    // 错误不得误报成「不存在」——此时没有证据下结论，跳过告警，由 skill adapter
    // 扫描同一目录时发 skill_scan_failed。
    // message 按原因区分：「路径不存在」是 manifest 配错，「存在但没有技能」
    // 是内容问题，「symlink 逃逸出插件根」是安全拒绝，三者修复方式不同；
    // code 保持单一，UI 无需感知分类。
    if (await (input.loaded.materials?.missing(resolved) ?? isMissingPathAsync(resolved))) {
      input.diagnostics.push({
        code: "plugin_skill_root_empty",
        message: `Plugin skills path does not exist: ${rawPath}`,
        path: resolved,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    // 信任边界：声明路径是插件内容，扫描不跟随符号链接（目录级/文件级逃逸
    // 一并拒绝，含 Windows junction）。链接根/链接 SKILL.md 扫描为空后落入下方
    // 「没有任何技能」告警，不误报「不存在」（词法路径本身存在）。
    let skillFiles: string[];
    try {
      skillFiles = await (input.loaded.materials?.skillFiles(resolved) ??
        scanSkillFilesUnderRoot(resolved, { followSymbolicLinks: false, stopAtSkill: true }));
    } catch (error) {
      rethrowPluginMaterialInterrupt(error);
      continue;
    }
    if (skillFiles.length > 0) continue;
    input.diagnostics.push({
      code: "plugin_skill_root_empty",
      message: `Plugin skills path does not contain any skills: ${rawPath}`,
      path: resolved,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  }
}

export async function countSkillFiles(
  skillRoots: SkillRoot[],
  materials?: PluginMaterialReader,
): Promise<number> {
  // 技能识别规则收敛到共享 scan helper；重叠的声明入口仍需按文件路径去重。
  // 顺带修正漂移：只认 isDirectory() 会漏掉 symlink 技能子目录，统一 helper 后一并计入。
  // helper 只吞 ENOENT；权限错误（EACCES 等）会抛出，这里按原语义把该根计 0，
  // 真正的 skill_scan_failed 诊断由 skill adapter 在运行时扫描同一目录时发出。
  // 信任边界：这里只消费 plugin roots（resolveSkillRoots 产物），不跟随符号链接。
  const seenFiles = new Set<string>();
  for (const skillRoot of skillRoots) {
    try {
      const files = await (materials?.skillFiles(skillRoot.path, skillRoot.source !== "plugin") ??
        scanSkillFilesUnderRoot(skillRoot.path, {
          followSymbolicLinks: skillRoot.source !== "plugin",
          stopAtSkill: skillRoot.source === "plugin",
        }));
      for (const file of files) {
        seenFiles.add(file);
      }
    } catch (error) {
      rethrowPluginMaterialInterrupt(error);
      // 概览计数降级为 0；扫描诊断由 skill adapter 负责。
    }
  }
  return seenFiles.size;
}

export async function materializeCommandMetadataRoot(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): Promise<CustomCommandRoot | null> {
  const spec = input.loaded.manifest.commands;
  if (!isRecord(spec)) return null;

  const generatedRoot = join(input.dataPath, "generated-commands");
  let wroteCommand = false;
  await mkdir(generatedRoot, { recursive: true });

  for (const [rawName, rawMetadata] of Object.entries(spec)) {
    if (!isRecord(rawMetadata)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command metadata must be an object: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const name = normalizeGeneratedCommandName(rawName);
    if (!name) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Invalid plugin command name: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const source = typeof rawMetadata.source === "string" ? rawMetadata.source : undefined;
    const content = typeof rawMetadata.content === "string" ? rawMetadata.content : undefined;
    if ((source && content) || (!source && !content)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command '${rawName}' must provide exactly one of source or content`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    let markdown = content;
    if (source) {
      const sourcePath = resolveInside(input.loaded.rootPath, trimRelativePrefix(source));
      if (!sourcePath) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source escapes plugin root: ${source}`,
          path: input.loaded.manifestPath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      if (
        !(await (input.loaded.materials?.fileExists(sourcePath) ?? fileExistsAsync(sourcePath)))
      ) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source file not found: ${source}`,
          path: sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      markdown = await (input.loaded.materials?.text(sourcePath) ?? readFile(sourcePath, "utf8"));
    }
    if (markdown === undefined) continue;

    // 市场清单支持 commands object mapping 和 inline content。
    // ZCode 的 custom command loader 只扫描 markdown 根目录，因此把低风险命令内容
    // materialize 到插件 data 目录；生成路径不在 plugin root 外暴露，也不执行命令本身。
    await writePluginTextIfChanged(
      join(generatedRoot, `${name}.md`),
      applyCommandMetadataFrontmatter(markdown, rawMetadata),
    );
    wroteCommand = true;
  }

  return wroteCommand
    ? {
        path: generatedRoot,
        plugin: createHookPluginContext(input.loaded, input.dataPath),
        priority,
        scope: input.loaded.source === "official" ? "system" : "user",
        source: "plugin",
      }
    : null;
}

function normalizeGeneratedCommandName(name: string): string | null {
  const normalized = name.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(normalized)) return null;
  return normalized;
}

function trimRelativePrefix(path: string): string {
  return path.replace(/^\.\//, "");
}
