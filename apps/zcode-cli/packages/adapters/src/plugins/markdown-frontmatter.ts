import {
  type PluginMaterialReader,
  rethrowPluginMaterialInterrupt,
  PLUGIN_MATERIAL_READ_CONCURRENCY,
} from "./helpers.js";
import { readFile } from "node:fs/promises";

/** 分批读取避免一次启动所有文件 IO；数组顺序保留同名组件的既有优先级。 */
export async function readMarkdownFrontmatters(paths: string[], materials?: PluginMaterialReader) {
  const results = [];
  for (let offset = 0; offset < paths.length; offset += PLUGIN_MATERIAL_READ_CONCURRENCY) {
    results.push(
      ...(await Promise.all(
        paths
          .slice(offset, offset + PLUGIN_MATERIAL_READ_CONCURRENCY)
          .map((path) => readMarkdownFrontmatter(path, materials)),
      )),
    );
  }
  return results;
}

/**
 * 轻量 Markdown frontmatter 抽取，支持 YAML 块标量（`>` 折叠 / `|` 字面，及 `+`/`-` chomping 变体）。
 *
 * 插件市场详情 (plugins/describe) 用一行正则读 `name`/`description` 时，遇到
 * `description: >` 这类块标量时会把指示符 `>` 当成描述本体，导致技能列表里每项描述只剩一个 `>`。
 * 这里复用与 skills adapter 同款的块标量解析规则（见 skills/index.ts），把后续缩进行
 * 正确折叠/拼接成完整描述；缺失 frontmatter 或无对应键时按「省略」优雅降级，绝不伪造。
 *
 * 仅提取 name / description 两个标量键（与 skills/commands 详情展示所需一致），不做完整 YAML 解析。
 */
export async function readMarkdownFrontmatter(
  filePath: string,
  materials?: PluginMaterialReader,
): Promise<{
  name?: string;
  description?: string;
}> {
  let content: string;
  try {
    if (materials) return await materials.parsed(filePath, "frontmatter", parseMarkdownFrontmatter);
    content = await readFile(filePath, "utf8");
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
    return {};
  }
  return parseMarkdownFrontmatter(content);
}

/** 纯函数版：直接解析 Markdown 文本的 frontmatter，便于单测覆盖块标量分支。 */
export function parseMarkdownFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return {};
  const values = parseFlatYamlScalars(frontmatter);
  const result: { name?: string; description?: string } = {};
  const name = parseScalar(values.name);
  if (name) result.name = name;
  const description = parseScalar(values.description);
  if (description) result.description = description;
  return result;
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

/** 解析顶层 `key: value`，块标量（`>`/`|`）会把后续缩进行收进同一个键。只保留标量字符串值。 */
function parseFlatYamlScalars(frontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    // 缩进行属于上一个块标量的内容，顶层扫描跳过。
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in values) continue;
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return values;
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
    // 非空且非缩进的行表示块标量结束（回到顶层键）。
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
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

/** 折叠样式（`>`）：同段内换行折成空格，空行分段。 */
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
  if (current.length > 0) paragraphs.push(current.join(" "));
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

export function applyCommandMetadataFrontmatter(
  markdown: string,
  metadata: Record<string, unknown>,
): string {
  const frontmatter = new Map<string, string>();
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    frontmatter.set("description", metadata.description.trim());
  }
  if (typeof metadata.argumentHint === "string" && metadata.argumentHint.trim()) {
    frontmatter.set("argument-hint", metadata.argumentHint.trim());
  }
  if (typeof metadata.model === "string" && metadata.model.trim()) {
    frontmatter.set("model", metadata.model.trim());
  }
  if (Array.isArray(metadata.allowedTools)) {
    const allowedTools = metadata.allowedTools
      .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim());
    if (allowedTools.length > 0) frontmatter.set("allowed-tools", allowedTools.join(", "));
  }
  if (frontmatter.size === 0) return markdown;
  const body = stripMarkdownFrontmatter(markdown).trimStart();
  return `---\n${Array.from(frontmatter, ([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}`;
}

function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return markdown;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return markdown;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(endIndex + 1).join("\n") : markdown;
}
