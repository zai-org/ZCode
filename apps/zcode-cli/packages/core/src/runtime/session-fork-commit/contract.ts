import type {
  ForkCommitBundle,
  MessageId,
  MessageWithParts,
  ModelSelection,
  PartId,
  SessionEntryInfo,
  SessionGoal,
  SessionId,
  SessionInfo,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  StableConversationForkGoalBoundary,
  StableConversationForkTarget,
  StableConversationForkTargetCwd,
} from "../types.js";

/** stable/compact-edit fork 一次性预分配的完整 child-local 身份。 */
export interface ForkIdentityMap {
  parentSessionId: SessionId;
  childSessionId: SessionId;
  messageIds: Map<MessageId, MessageId>;
  partIds: Map<PartId, PartId>;
  turnIds: Map<string, string>;
  productTurnIds: Map<string, string>;
  targetIds: Map<string, string>;
  verifierEntryIds: Map<string, string>;
  verificationIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  notice: {
    hiddenMessageId: MessageId;
    hiddenPartId: PartId;
    messageId: MessageId;
    partId: PartId;
    turnId: TurnId;
    productTurnId: string;
  };
}

export interface AtomicConversationForkOptions {
  commandFact?: ForkCommitBundle["commandFact"];
  modelSelection?: ModelSelection;
  forkedSessionId?: SessionId;
  goalBoundary: StableConversationForkGoalBoundary;
  initialInput?: ForkCommitBundle["initialInput"];
  messages: readonly MessageWithParts[];
  parentSession: SessionInfo;
  revisionAtDecision?: number;
  sourceCommandId: string;
  targetMessageId: MessageId;
  target?: StableConversationForkTarget;
  /** 只服务显式 forkAssistant；缺省时子会话沿用父会话的 cwd。 */
  targetCwd?: StableConversationForkTargetCwd;
  traceContext: TraceContext;
  kind?: "fork" | "selection_side_chat";
}

/** 保留现有 runtime 参数，不引入新的 owner 或端口实现。 */
export type ForkCommitRuntime = AgentRuntimeInternal;
export interface ForkIdentityInput {
  childSessionId: SessionId;
  entries: readonly SessionEntryInfo[];
  goalSnapshots: readonly SessionGoal[];
  messages: readonly MessageWithParts[];
  parentSessionId: SessionId;
}
