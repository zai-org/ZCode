// @zcode-dev/plugin-api/protocol-v4（docs/plugins/extension-host.md §17.9）：完整行、context 组成与生成速率。
// 版本跟 v4 协议走（清单 protocols.rows）。
export type {
  ArtifactRow,
  AssistantTextRow,
  ContextComposition,
  ContextCompositionCategory,
  ContextCompositionCategoryId,
  ContextCompositionItem,
  ContextCompositionPhase,
  ContextCompositionToolOrigin,
  ContextCompositionUsageSource,
  ConversationInputSource,
  ConversationRow,
  ConversationRowKind,
  HookInvocationRow,
  PendingInteraction,
  PermissionRequestPayload,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UnreadableConversationRow,
  UserInputQuestionPayload,
  UserInputRequestPayload,
  UserInputRow,
  WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
// 定义在 extension-host-protocol（ctx.models.onDidGenerate 的事件）；根入口导出的是同一个类型。
export type { GenerationMetrics } from "@zcode/shared/extension-host";
