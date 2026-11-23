// ============================================================
// Skill Contracts - reusable local instruction packs
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type SkillScope = "project" | "user" | "system" | "admin";

export type SkillSource = "agents" | "zcode" | "bundled" | "plugin" | "remote";

export type SkillDiagnosticSeverity = "warning" | "error";

export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillRoot {
  /** 附加目录能力的目录限定名；不是项目身份。 */
  namespace?: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  priority: number;
  /** 所属 plugin 的完整 id；仅 plugin root 可用。 */
  pluginId?: string;
}

export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  pluginName?: string;
  /** 所属 plugin 的完整 id；非 plugin skill 不设置。 */
  pluginId?: string;
  qualifiedName?: string;
  path: string;
  directory: string;
  rootPath: string;
  scope: SkillScope;
  source: SkillSource;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
  policy?: SkillPolicy;
}

/** Skill tool result 中允许跨边界传播的最小 metadata；不包含正文或 description。 */
export interface SkillTelemetryMetadata {
  /** 实际解析的技能原始名称；不限插件来源。 */
  name?: string;
  qualifiedName?: string;
  pluginId?: string;
  source?: SkillSource;
}

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

export interface SkillContent {
  metadata: SkillMetadata;
  content: string;
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillDiscoverRequest {
  workingDirectory: string;
  roots?: SkillRoot[];
  trace?: TraceContext;
}

export interface SkillLoadRequest {
  name: string;
  workingDirectory: string;
  roots?: SkillRoot[];
  maxBytes?: number;
  trace?: TraceContext;
}

export interface SkillOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

/**
 * 按名称找不到 skill（目录重读之后仍未命中）。Skill tool 按类型把它转成模型文字，不解析 message；
 * message 保持 `Skill not found: <name>`，CLI 命令直接输出它。
 */
export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill not found: ${skillName}`);
    this.name = "SkillNotFoundError";
    this.skillName = skillName;
  }
}

export interface SkillPort {
  discoverSkills(
    request: SkillDiscoverRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome>;
  loadSkill(request: SkillLoadRequest, options?: SkillOperationOptions): Promise<SkillContent>;
  /**
   * 实时目录的当前快照，同步、只读内存。实现了它的端口，runtime 在每次普通输入准备时读取；
   * 没有实现的端口（workflow child、测试注入）只在 context 初始化时发现一次。
   */
  currentCatalog?(): SkillLoadOutcome;
}

export interface SkillConfig {
  enabled: boolean;
  includeInstructions: boolean;
  metadataBudget: number;
  roots: string[];
}
