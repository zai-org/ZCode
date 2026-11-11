import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SiteCommand } from "../contract.ts";

/**
 * 面板菜单项来自插件自己的 `commands/*.md`，提示词只维护一份（技术方案 4.4）。
 * frontmatter 只取 description 和 argument-hint，都是单行标量。
 */
export async function readCommands(
  commandsDir: string,
): Promise<SiteCommand[]> {
  const files = (await readdir(commandsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const commands: SiteCommand[] = [];
  for (const file of files) {
    const fields = parseFrontmatter(
      await readFile(join(commandsDir, file), "utf8"),
    );
    if (!fields.description) continue;
    commands.push({
      name: file.slice(0, -".md".length),
      description: fields.description,
      ...(fields["argument-hint"]
        ? { argumentHint: fields["argument-hint"] }
        : {}),
    });
  }
  return commands;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    fields[pair[1]] = unquote(pair[2].trim());
  }
  return fields;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === value.at(-1) &&
    (value[0] === '"' || value[0] === "'")
  )
    return value.slice(1, -1);
  return value;
}
