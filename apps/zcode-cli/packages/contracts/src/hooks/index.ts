import { z } from "zod";
import type { ModelToolSideEffectScope } from "../model/index.js";
import type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";
import type { PermissionUpdate } from "../interfaces/permission.port.js";
import type { SessionId, ToolCallId, TraceId, TurnId } from "../interfaces/shared.js";

export const HookEventName = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PermissionRequest: "PermissionRequest",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  Stop: "Stop",
} as const;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

export const HookOutcome = {
  Success: "success",
  Blocked: "blocked",
  Failed: "failed",
  Cancelled: "cancelled",
  TimedOut: "timed_out",
} as const;

export type HookOutcome = (typeof HookOutcome)[keyof typeof HookOutcome];

/**
 * hook 自身出错（非 0 且非 2 退出、超时、输出 JSON 不合 schema）时怎么办。缺省 `allow`：
 * 放行，与引入本字段之前相同。`deny`：只对 PreToolUse 生效，这次出错等同于 hook 以退出码 2
 * 拦截了工具调用。用户中断、未受信任而未运行的工作区 hook、async hook 不受它影响。
 */
export const HookOnError = {
  Allow: "allow",
  Deny: "deny",
} as const;

export type HookOnError = (typeof HookOnError)[keyof typeof HookOnError];

export const HookOnErrorSchema = z.enum([HookOnError.Allow, HookOnError.Deny]);

export const HookSourceKind = {
  User: "user",
  Plugin: "plugin",
  Project: "project",
  Internal: "internal",
} as const;

export type HookSourceKind = (typeof HookSourceKind)[keyof typeof HookSourceKind];

/** Runtime-only provenance attached after user/plugin config validation. */
export interface HookConfigSource {
  kind: "user" | "project" | "internal";
  path?: string;
}

/** Client-safe metadata. Unredacted commands and execution IO must never be added here. */
export interface HookExecutionDescriptor {
  clientVisible: boolean;
  sourceKind: HookSourceKind;
  sourcePath?: string;
  pluginId?: string;
  pluginName?: string;
  statusMessage?: string;
  executionType: "process" | "command";
  executionMode: "foreground" | "background";
  commandDisplay: string;
  timeoutMs: number;
}

export const HookPermissionDecision = {
  Allow: "allow",
  Ask: "ask",
  Deny: "deny",
} as const;

export type HookPermissionDecision =
  (typeof HookPermissionDecision)[keyof typeof HookPermissionDecision];

export interface BaseHookInput {
  agentName?: string;
  cwd: string;
  hookEventName: HookEventName;
  mode: CollaborationMode;
  sessionId: SessionId;
  timestamp: string;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreToolUse;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface PermissionRequestHookInput extends BaseHookInput {
  permissionSuggestions?: PermissionUpdate[];
  hookEventName: typeof HookEventName.PermissionRequest;
  reason: string;
  requestId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  artifactRefs?: string[];
  hookEventName: typeof HookEventName.PostToolUse;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
  toolResponse: unknown;
  toolResultPreview: string;
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  error: {
    message: string;
    type: string;
  };
  hookEventName: typeof HookEventName.PostToolUseFailure;
  isInterrupt?: boolean;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  attachmentsSummary?: string;
  hookEventName: typeof HookEventName.UserPromptSubmit;
  prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.SessionStart;
  model?: string;
  source: "startup" | "resume" | "fork" | "clear" | "compact";
}

export interface StopHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.Stop;
  responsePreview: string;
  responseText?: string;
  stopHookActive: boolean;
  toolCallCount: number;
}

export type HookInput =
  | PreToolUseHookInput
  | PermissionRequestHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | StopHookInput;

export type PermissionRequestHookDecision =
  | {
      behavior: "allow";
      permissionUpdates?: PermissionUpdate[];
      updatedPermissions?: PermissionUpdate[];
      updatedInput?: unknown;
    }
  | {
      behavior: "deny";
      interrupt?: boolean;
      message?: string;
    };

export type HookSpecificOutput =
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PreToolUse;
      permissionDecision?: HookPermissionDecision;
      permissionDecisionReason?: string;
      updatedInput?: unknown;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.UserPromptSubmit;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.SessionStart;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolUse;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolUseFailure;
    }
  | {
      decision?: PermissionRequestHookDecision;
      hookEventName: typeof HookEventName.PermissionRequest;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.Stop;
    };

export interface HookJSONOutput {
  additionalContext?: string;
  additional_context?: string;
  continue?: boolean;
  decision?: "approve" | "block";
  hookSpecificOutput?: HookSpecificOutput;
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
}

const PermissionRequestHookDecisionSchema = z.union([
  z.object({
    behavior: z.literal("allow"),
    permissionUpdates: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedPermissions: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    interrupt: z.boolean().optional(),
    message: z.string().optional(),
  }),
]);

export const HookSpecificOutputSchema = z.discriminatedUnion("hookEventName", [
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PreToolUse),
    permissionDecision: z.enum(["allow", "ask", "deny"]).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.UserPromptSubmit),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.SessionStart),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolUse),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolUseFailure),
  }),
  z.object({
    decision: PermissionRequestHookDecisionSchema.optional(),
    hookEventName: z.literal(HookEventName.PermissionRequest),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.Stop),
  }),
]);

export const HookJSONOutputSchema = z.object({
  additionalContext: z.string().optional(),
  additional_context: z.string().optional(),
  continue: z.boolean().optional(),
  decision: z.enum(["approve", "block"]).optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
});

export interface HookPluginContext {
  dataPath: string;
  id: string;
  name: string;
  rootPath: string;
  /** Actual hooks.json/manifest source. Other plugin consumers may omit it. */
  sourcePath?: string;
}

export interface HookCommandConfig {
  async?: boolean;
  command: string;
  enabled?: boolean;
  onError?: HookOnError;
  plugin?: HookPluginContext;
  shell?: true | string;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command";
}

export interface HookProcessConfig {
  args?: string[];
  command: string;
  enabled?: boolean;
  onError?: HookOnError;
  plugin?: HookPluginContext;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  type: "process";
}

export type HookConfig = HookCommandConfig | HookProcessConfig;

export interface HookMatcherConfig {
  hooks: HookConfig[];
  matcher?: string;
}

export interface HooksRuntimeConfig {
  enabled: boolean;
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface HooksRuntimeConfigPatch {
  enabled?: boolean;
  events?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface HookRunLifecyclePayload {
  agentName?: string;
  /** New events always carry this; optional keeps old persisted events replayable. */
  descriptor?: HookExecutionDescriptor;
  /** Sanitized human-readable reason when the Hook itself blocked execution. */
  blockReason?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hookEventName: HookEventName;
  hookIndex: number;
  hookCount?: number;
  hookInvocationId?: string;
  hookRunId: string;
  hookSource?: string;
  matcher?: string;
  outcome?: HookOutcome;
  outputBytes?: number;
  requestId?: string;
  startedAt?: number;
  stderrPreview?: string;
  stdoutPreview?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  truncated?: boolean;
}

export const HookProcessConfigSchema = z.object({
  type: z.literal("process"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  onError: HookOnErrorSchema.optional(),
});

export const HookCommandConfigSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  async: z.boolean().optional(),
  shell: z.union([z.literal(true), z.string().min(1)]).optional(),
  timeout: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  onError: HookOnErrorSchema.optional(),
});

export const HookConfigSchema = z.discriminatedUnion("type", [
  HookProcessConfigSchema,
  HookCommandConfigSchema,
]);

export const HookMatcherConfigSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookConfigSchema).min(1),
});

export const HooksRuntimeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  events: z
    .object({
      SessionStart: z.array(HookMatcherConfigSchema).optional(),
      UserPromptSubmit: z.array(HookMatcherConfigSchema).optional(),
      PreToolUse: z.array(HookMatcherConfigSchema).optional(),
      PermissionRequest: z.array(HookMatcherConfigSchema).optional(),
      PostToolUse: z.array(HookMatcherConfigSchema).optional(),
      PostToolUseFailure: z.array(HookMatcherConfigSchema).optional(),
      Stop: z.array(HookMatcherConfigSchema).optional(),
    })
    .strict()
    .optional(),
});

export const DefaultHooksRuntimeConfig: HooksRuntimeConfig = {
  enabled: false,
  events: {},
  maxOutputBytes: 32768,
  timeoutMs: 60000,
};

export * from "./workspace-hook-trust.js";
export * from "./workspace-hook-trust-store.js";
