import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { WorkspaceHookReviewTrustState } from "./zcode-protocol-v4/workspace-hook-review.js";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

export type HookType = "command" | "process";

export interface HookConfiguredState {
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  sourcePath: string;
}

export interface WorkspaceHookDiscoveryState extends HookConfiguredState {
  reviewItemId: string;
  workspaceIdentity: string;
  bundleDigest: string;
  hookDeclarationDigest: string;
  sourceFileIndex: number;
  /** Read-only Settings evaluation; a live Runtime review projection overrides this value. */
  trustState?: WorkspaceHookReviewTrustState;
  /** 入口脚本不存在或无法读取（D24）：不能信任，行内展示原因而不是信任按钮。 */
  scriptUnavailable?: true;
}

export interface Hook {
  id: string;
  event: HookEvent;
  matcher?: string;
  type: HookType;
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  enabled: boolean;
  editable?: boolean;
  configuredState?: HookConfiguredState;
  workspaceHook?: WorkspaceHookDiscoveryState;
  custom?: Record<string, unknown>;
  location?: SettingsDirectoryLocation;
}

export interface HookConfig {
  event: HookEvent;
  matcher?: string;
  type: HookType;
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  enabled?: boolean;
  custom?: Record<string, unknown>;
  storageLevel?: "user" | "project";
}

/**
 * Metadata for hook identification in tool calls.
 * Used in both chat-panel.types.ts and conversationStore.ts.
 */
export interface ToolCallHookMeta {
  isHook?: boolean;
  hookEvent?: string;
  hookCommand?: string;
  hookMatcher?: string;
  hookToolName?: string;
  hookExitCode?: number | null;
  hookError?: string;
  hookStdout?: string;
  hookName?: string;
  hookFeedback?: string;
  hookStderr?: string;
  /** Skill-related metadata */
  "zcode/isSkill"?: boolean;
  "zcode/skillName"?: string;
  [key: string]: unknown;
}
