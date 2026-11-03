import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseRuntimeSubagentConfig } from "./runtime-subagents/index.js";
import { migrateUserSubagentMarkdown, migrateSubagentStateFile } from "@zcode/shared/node";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@zcode/core";
import type { Logger, PluginMetadata } from "@zcode/contracts";
import {
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@zcode/shared";

interface LoadZCodeAgentProfilesInput {
  logger?: Logger;
  storageRoot: string;
  workingDirectory: string;
  additionalDirectories?: readonly string[];
}

interface LoadZCodeAgentProfilesResult {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

interface LoadPluginAgentProfilesInput {
  logger?: Logger;
  plugins: readonly PluginMetadata[];
  reservedProfileNames?: Iterable<string>;
  /** 来自已完成存储迁移的启动快照；不在插件 loader 另读磁盘或查询账号。 */
  modelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
}

interface ParsedPluginAgentProfile {
  bareName: string;
  plugin: PluginMetadata;
  profile: AgentProfile;
}

const RESERVED_AGENT_NAMES = new Set(["general-purpose", "Explore"]);

export async function loadZCodeAgentProfiles(
  input: LoadZCodeAgentProfilesInput,
): Promise<LoadZCodeAgentProfilesResult> {
  const migration = await migrateUserSubagentMarkdown(join(input.storageRoot, "agents"));
  await migrateSubagentStateFile(join(input.storageRoot, "v2", "agents-state.json"));
  const roots: Array<{ path: string; source: "user" | "project"; namespace?: string }> = [
    { path: join(input.storageRoot, "agents"), source: "user" as const },
    { path: join(input.workingDirectory, ".zcode", "agents"), source: "project" as const },
  ];
  for (const directory of new Set(
    (input.additionalDirectories ?? []).map((path) => resolve(path)),
  )) {
    if (directory === resolve(input.workingDirectory)) continue;
    roots.push({
      path: join(directory, ".zcode", "agents"),
      source: "project",
      namespace: basename(directory),
    });
  }
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const failure of migration.failures) {
    diagnostics.push({
      code: "agent_read_failed",
      message: "Subagent Markdown migration failed; original file preserved",
      path: failure.path,
    });
    input.logger?.warn("Subagent Markdown migration failed", {
      module: "bootstrap.subagents",
      path: failure.path,
      error: String(failure.error),
    });
  }
  const agentState = await readAgentState(input.storageRoot);
  const documents = (
    await Promise.all(
      roots.map(async (root) =>
        Promise.all(
          (await listMarkdownFiles(root.path)).map(async (path) => ({
            path,
            source: root.source,
            namespace: root.namespace,
            content: await readFile(path, "utf8"),
          })),
        ),
      ),
    )
  ).flat();
  const parsed = parseRuntimeSubagentConfig({
    documents,
    state: { ...agentState, disabledAgentIds: [...agentState.disabledAgentIds] },
  });
  for (const diagnostic of parsed.diagnostics)
    input.logger?.warn("Agent profile diagnostic", {
      ...diagnostic,
      module: "bootstrap.subagents",
    });
  return { ...parsed, diagnostics: [...diagnostics, ...parsed.diagnostics] };
}

export function loadPluginAgentTemplates(
  input: Pick<LoadPluginAgentProfilesInput, "plugins" | "logger">,
): { profiles: ParsedPluginAgentProfile[]; diagnostics: AgentProfileParseDiagnostic[] } {
  const parsedProfiles: ParsedPluginAgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const plugin of input.plugins) {
    if (!plugin.enabled) continue;
    const agents = plugin.components.find((group) => group.kind === "agent")?.items ?? [];
    for (const agent of agents) {
      // 名称可能来自 frontmatter，不能还原文件位置；只读取发现阶段保留的源路径。
      if (!agent.path) continue;
      const result = parsePluginAgentProfile({
        filePath: agent.path,
        logger: input.logger,
        plugin,
      });
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      if (result.parsed) parsedProfiles.push(result.parsed);
    }
  }

  return { profiles: parsedProfiles, diagnostics };
}

export function resolvePluginAgentProfiles(
  input: LoadPluginAgentProfilesInput,
  templates: ReturnType<typeof loadPluginAgentTemplates>,
): LoadZCodeAgentProfilesResult {
  const diagnostics = [...templates.diagnostics];
  const parsedProfiles = templates.profiles;
  const reservedProfileNames = new Set([
    ...RESERVED_AGENT_NAMES,
    ...(input.reservedProfileNames ?? []),
  ]);
  const bareNameCounts = countBareProfileNames(parsedProfiles);
  const profiles: AgentProfile[] = [];
  for (const parsed of parsedProfiles) {
    const override =
      input.modelSelectionOverrides?.[createPluginAgentStateId(parsed.plugin.id, parsed.bareName)];
    // 先替换完整选择再展开别名，避免同一插件的两个调用入口使用不同模型/档位。
    const canonical = {
      ...namespacePluginAgentProfile(parsed),
      ...(override ? { modelSelection: override } : {}),
    };
    profiles.push(canonical);

    const bareName = parsed.bareName.trim();
    if (bareNameCounts.get(bareName) === 1 && !reservedProfileNames.has(bareName)) {
      profiles.push({ ...canonical, name: bareName });
    } else if (reservedProfileNames.has(bareName)) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    } else if ((bareNameCounts.get(bareName) ?? 0) > 1) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    }
  }

  input.logger?.debug("Plugin agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.subagents",
    profileCount: profiles.length,
  });

  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    diagnostics,
    profiles,
  };
}

function parsePluginAgentProfile(input: {
  filePath: string;
  logger?: Logger;
  plugin: PluginMetadata;
}): { diagnostic?: AgentProfileParseDiagnostic; parsed?: ParsedPluginAgentProfile } {
  try {
    const content = readFileSync(input.filePath, "utf8");
    const result = parseAgentProfileFromMarkdown({
      content,
      path: input.filePath,
      source: "user",
    });
    if (result.diagnostic) {
      input.logger?.warn("Plugin agent profile diagnostic", {
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        module: "bootstrap.subagents",
        path: input.filePath,
        pluginId: input.plugin.id,
      });
      if (!result.profile) return { diagnostic: result.diagnostic };
    }
    if (!result.profile) return {};
    return {
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      parsed: {
        bareName: result.profile.name,
        plugin: input.plugin,
        // 修复原因：插件 profile 按 user 解析，permissionMode 原样生效；bypassPermissions 会让
        // 被委派的子会话在父会话 build 时以 yolo 运行。官方与第三方插件同一规则：声明只能收紧父会话模式。
        profile: { ...result.profile, permissionModeRestrictOnly: true },
      },
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "agent_read_failed",
        message:
          error instanceof Error ? error.message : `Failed to read plugin agent: ${input.filePath}`,
        path: input.filePath,
      },
    };
  }
}

function namespacePluginAgentProfile(parsed: ParsedPluginAgentProfile): AgentProfile {
  return {
    ...parsed.profile,
    name: `${parsed.plugin.name}:${parsed.bareName}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBareProfileNames(
  parsedProfiles: readonly ParsedPluginAgentProfile[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parsed of parsedProfiles) {
    const name = parsed.bareName.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

async function readAgentState(storageRoot: string): Promise<{
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: Set<string>;
}> {
  try {
    const raw = await readFile(join(storageRoot, "v2", "agents-state.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    return {
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      builtInModelSelectionOverrides: normalizeBuiltInSelectionOverrides(
        parsed.builtInModelSelectionOverrides,
      ),
      disabledAgentIds: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            )
          : [],
      ),
    };
  } catch {
    return {
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: new Set(),
    };
  }
}

function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]);
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore);
  if (generalPurpose.success) result["general-purpose"] = generalPurpose.data;
  if (explore.success) result.Explore = explore.data;
  return result;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    // 与 Host / Settings 一致，只加载根目录直接文件；插件使用独立发现入口。
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}
