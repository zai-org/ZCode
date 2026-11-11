// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@zcode/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI / 产品身份前缀
  | "identity" // Agent 基础描述
  | "env_info" // 环境信息 (cwd, platform, git repo boolean)
  | "session_context" // git snapshot context
  | "model" // 当前执行模型身份
  | "skills" // 可用 skills
  | "tools" // 工具定义
  | "request_user_context" // request-level user context provider-visible 组合块
  | "memory" // 长期 memory read path
  | "current_date" // 当前日期
  | "custom_system_prompt" // 自定义 stable system body
  | "workflow_actor_identity" // 动态工作流子代理身份：契约 + persona 叠加
  | "subagent_agent_prompt" // 子 agent 专属身份/任务 prompt
  | "subagent_notes" // 子 agent 通用操作提醒
  | "dynamic_behavior" // 动态行为边界
  | "session_guidance" // 当前可用内置能力指导
  | "context_management" // 长上下文管理提示
  | "total_tokens" // 固定的 token 预算行
  | "desktop_context"; // ZCode Desktop 渲染与交互协议

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "zcode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // 人类可读的 section 名称
  source: ContextSource; // 来源标识
  injectionTarget: ContextInjectionTarget; // 注入位置
  cacheHint: ContextCacheHint; // 缓存稳定性提示
  chars: number; // 字符数
  tokens: number; // 估算 token 数
  content: string; // 完整内容
  preview: string; // 前 100 字符预览
  /** request_user_context 的逐文件块；指令变化公告按它比较。 */
  instructionFiles?: InstructionFile[];
}

/** 指令公告里的一个文件块：`Contents of <path> (<type>):`、空行、正文（已 trim）。 */
export interface InstructionFile {
  path: string;
  type: string;
  body: string;
  /** body 的 sha256；构建文件时算一次（createInstructionFile），请求前的比较直接用它。 */
  hash: string;
}

export type InstructionRefreshReason = "session_start" | "compaction";

/**
 * context_prefix 记录在 runtime metadata 里保存的已公告文件（不发给 provider）。
 * 没有 reason 的是完整公告；有 reason 的是增量，files 只含变化或新增的文件。
 */
export interface InstructionAnnouncement {
  files: { path: string; type: string; hash: string }[];
  removed?: string[];
  reason?: InstructionRefreshReason;
}

export type ContextMetaUserAttachmentSource =
  | "skills_listing"
  | "context_prefix"
  | "session_context";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
  /** 只有 context_prefix 有：组成 content 的指令文件。 */
  files?: InstructionFile[];
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder 只组装 system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // 未包裹 <system-reminder> 的 meta user body
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  additionalDirectories?: readonly string[];
  envInfo: EnvInfo;
  /** 当前步骤的执行对象，不进入 Context Source 或持久化环境快照。 */
  model?: Model;
  /** 执行模型是否走 MCS；false 时 Harness 改述 `<system-reminder>` 通道。缺省按 MCS。 */
  midConversationSystem?: boolean;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * 动态工作流子代理（workflow child）的身份输入。在场即走 builder 的第三条路径：
   * 基座段（CLI prefix、安全行、Harness、memory）+ 工作流子代理契约 + persona 叠加，
   * 而不是像 `customSystemPrompt` 那样整段替换。与 `customSystemPrompt` 互斥。
   */
  workflowActor?: WorkflowActorContext;
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
}

/**
 * 工作流子代理的身份输入：有效名（匿名缺席）、作者写的 persona system prompt（可缺席）。
 * 没有工具档位：每个子代理都有完整工作工具集，契约只有一份文本。
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
