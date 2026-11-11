export { AgentRuntime } from "./runtime/agent-runtime.js";
export type {
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./runtime/methods/workspace-generate-text.js";
export type { StartSavedWorkflowRunResult } from "./runtime/methods/dynamic-workflow-run-start.js";
export type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./runtime/methods/dynamic-workflow-run-settings.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  EditPendingInputOptions,
  EditPendingInputResult,
  ExecuteTurnOptions,
  LockPendingInputEditResult,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  PermissionDecisionResult,
  ProviderRuntimeHeadersPort,
  ResumeSessionOptions,
  ResumeSessionResult,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  StableConversationForkTargetCwd,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./runtime/types.js";

import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { AgentRuntimeConfig } from "./runtime/types.js";

export interface RuntimeFactory {
  create(config: AgentRuntimeConfig): Promise<AgentRuntime>;
}
