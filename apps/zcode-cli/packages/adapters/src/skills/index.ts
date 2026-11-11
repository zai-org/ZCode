// ============================================================
// Node Skill Adapter
// ============================================================

import { realpathSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  SkillContent,
  SkillDiagnostic,
  SkillLoadOutcome,
  SkillMetadata,
  SkillOperationOptions,
  SkillPort,
  SkillRoot,
} from "@zcode/contracts";
import { resolveDefaultSkillRoots, type SkillRootResolutionOptions } from "./roots.js";
import { scanSkillFilesUnderRoot } from "./scan.js";

const MAX_DESCRIPTION_LENGTH = 1024;
const SAFE_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "when_to_use",
  "license",
  "metadata",
]);
const DEFAULT_MAX_SKILL_BYTES = 100_000;
const MAX_PLUGIN_MANIFEST_SEARCH_DEPTH = 5;
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  ".zcode-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
] as const;

export interface NodeSkillAdapterOptions extends SkillRootResolutionOptions {
  // 被禁用的 SKILL.md 绝对路径集合（来自 config.json 的 skill.<path>.enable=false）。
  // 命中的 skill 在发现阶段直接剔除，使 discover/load/inspect 全链路保持一致。
  disabledPaths?: Iterable<string>;
}

export class NodeSkillAdapter implements SkillPort {
  private readonly disabledPaths: ReadonlySet<string>;
  private readonly pluginNameBySkillRoot = new Map<string, Promise<string | undefined>>();

  constructor(private readonly options: NodeSkillAdapterOptions = {}) {
    this.disabledPaths = new Set(
      Array.from(options.disabledPaths ?? []).flatMap((path) => {
        const resolvedPath = resolve(path);
        const canonicalPath = safeRealpathSync(resolvedPath);
        return canonicalPath && canonicalPath !== resolvedPath
          ? [resolvedPath, canonicalPath]
          : [resolvedPath];
      }),
    );
  }

  async discoverSkills(
    request: { workingDirectory: string; roots?: SkillRoot[] },
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    throwIfAborted(options);

    const workingDirectory = resolve(request.workingDirectory);
    const roots = request.roots ?? (await resolveDefaultSkillRoots(workingDirectory, this.options));
    const diagnostics: SkillDiagnostic[] = [];
    const selected = new Map<string, SkillMetadata>();
    let totalDiscovered = 0;

    for (const root of roots.toSorted((a, b) => a.priority - b.priority)) {
      throwIfAborted(options);
      const skillPaths = await this.skillFilesUnderRoot(root, diagnostics);
      for (const path of skillPaths) {
        throwIfAborted(options);
        const parsed = await this.parseSkill(path, root, diagnostics);
        if (!parsed) continue;
        if (await this.isDisabledSkillPath(parsed.path)) continue;
        totalDiscovered++;
        // 同名技能可能来自不同技能生态或版本，不能只按 name 去重；路径才是安装项身份。
        if (selected.has(parsed.path)) {
          continue;
        }
        selected.set(parsed.path, parsed);
      }
    }

    return {
      skills: Array.from(selected.values()).toSorted((a, b) => a.name.localeCompare(b.name)),
      diagnostics,
      totalDiscovered,
    };
  }

  async loadSkill(
    request: { name: string; workingDirectory: string; roots?: SkillRoot[]; maxBytes?: number },
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    throwIfAborted(options);

    const outcome = await this.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
      },
      options,
    );
    const metadata = outcome.skills.find((skill) => matchesSkillRequest(skill, request.name));
    if (!metadata) {
      throw new Error(`Skill not found: ${request.name}`);
    }

    const maxBytes = request.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
    const info = await stat(metadata.path);
    const truncated = info.size > maxBytes;
    const buffer = truncated
      ? await readFirstBytes(metadata.path, maxBytes)
      : await readFile(metadata.path);
    const rawContent = buffer.toString("utf8");
    const content = stripFrontmatter(rawContent).trim();

    return {
      metadata,
      content,
      baseDirectory: metadata.directory,
      bytesRead: buffer.byteLength,
      sizeBytes: info.size,
      truncated,
    };
  }

  private async skillFilesUnderRoot(
    skillRoot: SkillRoot,
    diagnostics: SkillDiagnostic[],
  ): Promise<string[]> {
    try {
      // manifest 的 skills 项既可指向单个技能目录，也可指向包含多个技能的根目录。
      // 插件单技能入口不再隐式带入子技能；用户级、项目级根保留原扫描范围。
      // 信任边界：plugin-scope 内容不可信，不跟随符号链接（目录级与文件级逃逸
      // 一并拒绝）；用户级根保持跟随，symlink 技能导入能力不变。
      return await scanSkillFilesUnderRoot(skillRoot.path, {
        followSymbolicLinks: skillRoot.source !== "plugin",
        stopAtSkill: skillRoot.source === "plugin",
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message:
          error instanceof Error ? error.message : `Failed to scan skill root: ${skillRoot.path}`,
        path: skillRoot.path,
      });
      return [];
    }
  }

  private async parseSkill(
    path: string,
    root: SkillRoot,
    diagnostics: SkillDiagnostic[],
  ): Promise<SkillMetadata | null> {
    let rawContent: string;
    try {
      rawContent = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return null;
      diagnostics.push({
        code: "skill_read_failed",
        severity: "warning",
        message: error instanceof Error ? error.message : `Failed to read skill: ${path}`,
        path,
      });
      return null;
    }

    const frontmatter = extractFrontmatter(rawContent);
    // 无 frontmatter 的手写 skill 仍可按目录名加载，避免设置页/CLI 出现无修复价值的错误。
    const parsed = frontmatter
      ? parseFlatYaml(frontmatter, path, diagnostics)
      : { values: {}, keys: [] };
    const name =
      parseScalar(parsed.values.name) ?? (frontmatter ? undefined : basename(dirname(path)));
    if (!name) {
      diagnostics.push({
        code: "skill_missing_name",
        severity: "error",
        message: `Skill frontmatter must include a name: ${path}`,
        path,
      });
      return null;
    }
    const rawDescription = parseScalar(parsed.values.description);
    if (!rawDescription && frontmatter) {
      diagnostics.push({
        code: "skill_missing_description",
        severity: "error",
        message: `Skill frontmatter must include a description: ${path}`,
        path,
        skillName: name,
      });
      return null;
    }
    const description = rawDescription ?? "";
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      diagnostics.push({
        code: "skill_description_too_long",
        severity: "error",
        message: `Skill description is too long: ${name}`,
        path,
        skillName: name,
      });
      return null;
    }

    // 第三方/旧版 skill 常带 version、homepage 等扩展字段。
    // 这些字段不影响加载，不再作为 warning 暴露，只保留 safeToAutoLoad 的保守判断。
    const pluginAlias = await this.resolvePluginSkillAlias(name, root);

    return {
      name,
      description,
      whenToUse: parseScalar(parsed.values.when_to_use),
      ...pluginAlias,
      ...(root.namespace ? { qualifiedName: `${root.namespace}/${name}` } : {}),
      path,
      directory: dirname(path),
      rootPath: root.path,
      scope: root.scope,
      source: root.source,
      safeToAutoLoad: parsed.keys.every((key) => SAFE_FRONTMATTER_KEYS.has(key)),
      frontmatterKeys: parsed.keys,
      policy: {
        allowImplicitInvocation: true,
      },
    };
  }

  private async isDisabledSkillPath(path: string): Promise<boolean> {
    const resolvedPath = resolve(path);
    if (this.disabledPaths.has(resolvedPath)) {
      return true;
    }
    const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
    // UI 可能把 symlink 目标真实路径写入 config，而 agent 从 ~/.zcode/skills 的链接路径扫描。
    // 同时比对扫描路径和真实路径，避免同一个 SKILL.md 因路径形态不同绕过禁用开关。
    return this.disabledPaths.has(canonicalPath);
  }

  private async resolvePluginSkillAlias(
    skillName: string,
    root: SkillRoot,
  ): Promise<Pick<SkillMetadata, "pluginId" | "pluginName" | "qualifiedName"> | undefined> {
    if (root.source !== "plugin") return undefined;
    const pluginName = await this.resolvePluginName(root.path);
    if (!pluginName) return undefined;

    return {
      ...(root.pluginId ? { pluginId: root.pluginId } : {}),
      pluginName,
      qualifiedName: `${pluginName}:${skillName}`,
    };
  }

  private async resolvePluginName(skillRootPath: string): Promise<string | undefined> {
    const resolvedRoot = resolve(skillRootPath);
    let cached = this.pluginNameBySkillRoot.get(resolvedRoot);
    if (!cached) {
      cached = readPluginNameForSkillRoot(resolvedRoot);
      this.pluginNameBySkillRoot.set(resolvedRoot, cached);
    }
    return cached;
  }
}

export function createNodeSkillAdapter(options: NodeSkillAdapterOptions = {}): NodeSkillAdapter {
  return new NodeSkillAdapter(options);
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return content;
  const lines = normalized.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return content;
  return lines.slice(endIndex + 1).join("\n");
}

function parseFlatYaml(
  frontmatter: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): { values: Record<string, string>; keys: string[] } {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      diagnostics.push({
        code: "skill_invalid_frontmatter",
        severity: "warning",
        message: `Invalid frontmatter line ${index + 1} in ${basename(path)}`,
        path,
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    keys.push(key);
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      // Agent 侧只读顶层 `description: >` 会把后续缩进行跳过，
      // 导致 `.agents/skills` 的合法多行触发说明注入给模型时只剩 `>`。
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }

  return { values, keys };
}

function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0 && !/^\s/.test(line)) {
      break;
    }
    rawLines.push(line);
    index += 1;
  }

  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent ?? 0),
  );
  return {
    value: style === "folded" ? foldBlockScalarLines(contentLines) : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }
  return paragraphs.join("\n").trim();
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function matchesSkillRequest(skill: SkillMetadata, requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}

async function readPluginNameForSkillRoot(skillRootPath: string): Promise<string | undefined> {
  let current = resolve(skillRootPath);
  for (let depth = 0; depth <= MAX_PLUGIN_MANIFEST_SEARCH_DEPTH; depth++) {
    for (const relativePath of PLUGIN_MANIFEST_RELATIVE_PATHS) {
      const pluginName = await readPluginNameFromManifest(join(current, relativePath));
      if (pluginName) return pluginName;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function readPluginNameFromManifest(manifestPath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : undefined;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    return undefined;
  }
}

function safeRealpathSync(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function throwIfAborted(options: SkillOperationOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new Error("Skill operation cancelled");
  }
}
