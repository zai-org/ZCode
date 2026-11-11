// ZCode Protocol v4 —— CLI 权威投影（M2）。
// schema/纯函数在 @zcode/shared/zcode-protocol-v4；本目录是事件日志 → 投影的 reducer 宿主。
export { ProductProjection } from "./product-projection.js";
export type { SessionConfigSeed } from "./product-projection.js";
export { normalizeConversationEvent } from "./event-normalizer.js";
export type {
  CanonicalAssistantSegmentFact,
  CanonicalConversationFact,
  CanonicalConversationOrigin,
  CanonicalOpenSegmentIdentity,
  CanonicalConversationPlacement,
  CanonicalConversationVisibility,
  CanonicalPassthroughFact,
  CanonicalUserIntentFact,
  ConversationNormalizationDiagnostic,
  NormalizeConversationEventContext,
} from "./event-normalizer.js";
export { CommandInbox } from "./command-inbox.js";
export type { CommandInboxHost, CommandInboxOutcome, GuardDecision } from "./command-inbox.js";
export {
  createInitialConversationSnapshot,
  computeAvailability,
  computeInputRouting,
  deltaBumpsRevision,
} from "./projection-state.js";
export type { AvailabilityContext, SessionAvailabilityContext } from "./projection-state.js";
export {
  buildToolOutput,
  mapTurnHeaderOrigin,
  mapUserInputOrigin,
  mapTurnResultToHeaderState,
} from "./projection-rows.js";
export {
  ConversationTopicPublisher,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  ProjectionPayloadTooLargeError,
  appendConversationSubscriberBuffer,
  conversationSubscriberBufferByteLimit,
} from "./conversation-topic-publisher.js";
export {
  encodeConversationDeltasForLegacy,
  workflowRunDeltaGrowthUpperBound,
} from "./conversation-workflow-run-deltas.js";
export type {
  ConversationSubscriberBufferLimits,
  ConversationSubscriberBufferResult,
  ConversationSubscribeParams,
  ConversationSubscribeResult,
  ConversationTopicPublisherOptions,
} from "./conversation-topic-publisher.js";
export { SessionsIndexProjection, deriveSessionSummary } from "./sessions-index-projection.js";
export type { SessionSummaryDeriveExtra } from "./sessions-index-projection.js";
export { SessionsIndexPublisher } from "./sessions-index-publisher.js";
export type { SessionsIndexSubscribeResult } from "./sessions-index-publisher.js";
export { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
export type { WorkspaceConfigSubscribeResult } from "./workspace-config-publisher.js";
export type { TopicFrameReservation } from "./topic-frame-reservation.js";
export {
  ColdSessionResumeCoordinator,
  V4SubscribeSessionUnavailableError,
} from "./cold-session-resume.js";
export type {
  ColdSessionResumeHost,
  ColdSessionResumeOutcome,
} from "./cold-session-resume.js";
export {
  ConversationV4Gateway,
  V4CommandNoopError,
  V4CommandNotImplementedError,
} from "./v4-gateway.js";
export type { ConversationV4GatewayOptions, V4GatewayHost } from "./v4-gateway.js";
