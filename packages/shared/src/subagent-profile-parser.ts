import { parseAgentFrontmatter, splitMarkdownFrontmatter } from "./subagent-profile-frontmatter.js";
import { parseSubagentMarkdownSelection } from "./subagent-markdown-selection.js";
import type { AgentPermissionMode } from "./subagents-types.js";
import type {
  AgentProfile,
  AgentProfileSource,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
} from "./subagent-profile.js";

const VALID_COLORS = new Set<NonNullable<AgentProfile["color"]>>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

const VALID_PERMISSION_MODES = new Set<AgentPermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

const VALID_MEMORY_SCOPES = new Set<AgentMemoryScope>(["user", "project", "local"]);

export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: AgentProfileSource;
}): { diagnostic?: AgentProfileParseDiagnostic; profile?: AgentProfile } {
  const parsed = splitMarkdownFrontmatter(input.content);
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: "agent_missing_frontmatter",
        message: `Agent Markdown must include frontmatter: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  const { mcpServers, values: frontmatter } = parseAgentFrontmatter(parsed.frontmatter);
  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, "\n");
  if (!name) {
    return missingRequiredDiagnostic("name", input.path);
  }
  if (!description) {
    return missingRequiredDiagnostic("description", input.path);
  }

  const modelSelection = parseSubagentMarkdownSelection(frontmatter);
  const color = normalizeColor(scalarString(frontmatter.color));
  const parsedPermissionMode = normalizePermissionMode(scalarString(frontmatter.permissionMode));
  // 修复原因：项目级 subagent markdown 属于仓库输入，不能通过 frontmatter 把
  // child runtime 提升到 bypass/yolo；项目级声明在此剥离。插件 profile 也以 source: "user" 解析，
  // 这里不剥离；插件 loader 会标记 permissionModeRestrictOnly，派生子会话时 core 只取比父会话更严格的模式。
  const permissionMode = input.source === "project" ? undefined : parsedPermissionMode;
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);
  const memory = parseAgentMemoryScope(frontmatter.memory);
  const memoryDiagnostic =
    frontmatter.memory !== undefined && memory === undefined
      ? {
          code: "agent_invalid_memory_scope",
          message: `Agent frontmatter memory must be user, project, or local: ${input.path ?? "<inline>"}`,
          path: input.path,
        }
      : undefined;
  if (mcpServers === null) {
    return {
      diagnostic: {
        code: "agent_invalid_mcp_servers",
        message: `Agent frontmatter mcpServers must be a list of parent server names: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  return {
    ...(memoryDiagnostic ? { diagnostic: memoryDiagnostic } : {}),
    profile: {
      name,
      description,
      source: input.source,
      systemPrompt: parsed.body.trim(),
      ...(input.path ? { path: input.path } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(color ? { color } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(memory ? { memory } : {}),
      ...optionalList("tools", frontmatter.tools),
      ...optionalList("disallowedTools", frontmatter.disallowedTools),
      ...optionalList("skills", frontmatter.skills),
      ...optionalBoolean("background", frontmatter.background),
      ...optionalBoolean("injectAgentsMd", frontmatter.injectAgentsMd),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    },
  };
}

function parseAgentMemoryScope(value: unknown): AgentMemoryScope | undefined {
  return typeof value === "string" && VALID_MEMORY_SCOPES.has(value as AgentMemoryScope)
    ? (value as AgentMemoryScope)
    : undefined;
}

function missingRequiredDiagnostic(
  field: string,
  path: string | undefined,
): { diagnostic: AgentProfileParseDiagnostic } {
  return {
    diagnostic: {
      code: "agent_missing_required_frontmatter",
      message: `Agent frontmatter must include ${field}: ${path ?? "<inline>"}`,
      path,
    },
  };
}

function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return normalizeToolNames(normalizeStringList(value));
  }
  if (typeof value !== "string") return undefined;
  const result: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of value) {
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth === 0 && (char === "," || /\s/u.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return normalizeToolNames(result);
}

function optionalList(
  key: "disallowedTools" | "skills" | "tools",
  value: unknown,
): Partial<AgentProfile> {
  const list = key === "skills" ? normalizeStringList(value) : parseToolList(value);
  if (list && list.length > 0) return { [key]: list };
  if (key === "tools" && Array.isArray(value)) {
    return { tools: [] };
  }
  return {};
}

function optionalBoolean(
  key: "background" | "injectAgentsMd",
  value: unknown,
): Partial<AgentProfile> {
  if (typeof value === "boolean") return { [key]: value };
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return { [key]: true };
    if (value.toLowerCase() === "false") return { [key]: false };
  }
  return {};
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return list.length > 0 ? list : undefined;
  }
  if (typeof value !== "string") return undefined;
  const list = value
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeColor(value: string | undefined): AgentProfile["color"] | undefined {
  if (!value) return undefined;
  return VALID_COLORS.has(value as NonNullable<AgentProfile["color"]>)
    ? (value as NonNullable<AgentProfile["color"]>)
    : undefined;
}

function normalizePermissionMode(value: string | undefined): AgentPermissionMode | undefined {
  if (!value) return undefined;
  return VALID_PERMISSION_MODES.has(value as AgentPermissionMode)
    ? (value as AgentPermissionMode)
    : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeToolNames(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const names = values.map(toolNameFromSpec).filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

function toolNameFromSpec(value: string): string {
  const trimmed = value.trim();
  const parenIndex = trimmed.indexOf("(");
  if (parenIndex < 0) return trimmed;
  return trimmed.slice(0, parenIndex).trim();
}
