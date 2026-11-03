import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import type { AgentPermissionMode } from "./subagents-types.js";

export type AgentProfileSource = "built-in" | "project" | "user";
export type AgentMemoryScope = "user" | "project" | "local";

export interface AgentProfile {
  background?: boolean;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  description: string;
  disallowedTools?: readonly string[];
  injectAgentsMd?: boolean;
  maxTurns?: number;
  mcpServers?: readonly string[];
  memory?: AgentMemoryScope;
  modelSelection?: ModelSelection;
  name: string;
  path?: string;
  permissionMode?: AgentPermissionMode;
  /**
   * permissionMode 只能收紧父会话模式。插件 loader 在 CLI 进程内设置；
   * 不进入下方跨进程 schema，若被跨边界发送，strict schema 会直接拒绝。
   */
  permissionModeRestrictOnly?: boolean;
  skills?: readonly string[];
  source: AgentProfileSource;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentProfileLoadResult {
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

/** 完整运行时 profile 的跨进程边界，不使用 Settings 摘要代替。 */
export const agentProfileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["built-in", "project", "user"]),
    systemPrompt: z.string(),
    path: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    background: z.boolean().optional(),
    injectAgentsMd: z.boolean().optional(),
    color: z
      .enum(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
      .optional(),
    permissionMode: z
      .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
      .optional(),
    memory: z.enum(["user", "project", "local"]).optional(),
    maxTurns: z.number().int().positive().optional(),
    tools: z.array(z.string()).readonly().optional(),
    disallowedTools: z.array(z.string()).readonly().optional(),
    skills: z.array(z.string()).readonly().optional(),
    mcpServers: z.array(z.string()).readonly().optional(),
  })
  .strict();
