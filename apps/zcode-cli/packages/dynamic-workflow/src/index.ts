export { FACADE_DTS, FACADE_FILE_NAME, SNIPPET_FACADE_DTS } from "./facade/dts.js";
export {
  HOLE_SITE_ID_PATTERN,
  holePrefixOf,
  holeSiteId,
  isHoleSiteId,
} from "./analysis/hole-id.js";
export { WORLD_READ_CAPS } from "./facade/world-read-caps.js";
export { REPORT_CAPS } from "./facade/report-caps.js";
// 用户面产物：上限常量、注册表词汇、编译期清单与诊断。
export { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "./facade/artifact-caps.js";
export {
  ARTIFACT_REGISTRY,
  artifactFamilyOf,
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactOp,
  type ArtifactPresetOp,
  type ArtifactRow,
} from "./facade/registry.js";
export {
  ARTIFACT_DECLARATION_CODE,
  ARTIFACT_HOISTING_CODE,
  ARTIFACT_PRIMARY_CONFLICT_CODE,
  collectArtifactDeclarations,
  type ArtifactDeclarations,
  type DeclaredArtifact,
} from "./analysis/artifacts.js";
export {
  collectDiagnostics,
  compileWorkflowScript,
  createWorkflowProgram,
  SCRIPT_FILE_NAME,
  type CompileDiagnostic,
  type CompileResult,
  type CreateWorkflowProgramOptions,
  type ScriptLoc,
  type WorkflowProgram,
} from "./compiler/compile.js";
export { analyzeWorkflowScript, type AnalyzeResult } from "./analysis/analyze.js";
export {
  MODEL_REFERENCE_CODE,
  MODEL_UNRESOLVED_CODE,
  type ModelReference,
} from "./analysis/actor-models.js";
export { BUDGET_VALUE_CODE } from "./analysis/actor-budgets.js";
export { collectSites, type SiteTable } from "./analysis/sites.js";
export {
  collectWorldRunCommands,
  WORLD_RUN_LITERAL_CODE,
  type WorldRunCommands,
} from "./analysis/world-run.js";
export { collectPhaseMarkerDiagnostics, PHASE_MARKER_CODE } from "./analysis/phases.js";
export { collectPhaseNames, collectSitePhases } from "./analysis/site-phases.js";
// 留白（docs/dynamic-workflow/authoring.md「Holes」）：规则 9012、站点类型、补全服务的拼接与
// 稳定性复核。
export { collectHoleDiagnostics, HOLE_CODE, HOLE_NAME_MAX_CHARS } from "./analysis/hole-sites.js";
export type { HoleSite } from "./analysis/sites.js";
export {
  checkSiteStability,
  spliceHoleBody,
  type SiteStability,
  type SplicedHoleBody,
} from "./analysis/hole-splice.js";
export { MAIN_LANE } from "./analysis/causality-graph.js";
export type { FlowHole } from "./analysis/flow-graph.js";
export { interpret } from "./analysis/interpret.js";
export {
  toActorGraph,
  type ActorEdge,
  type ActorGraph,
  type ActorNode,
} from "./analysis/actor-graph.js";
export {
  SINK_ID,
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Lane,
  type NamePattern,
  type OrderEdge,
  type OrderKind,
  type Phase,
  type Region,
  type RegionKind,
  type Step,
  type StepKind,
} from "./analysis/causality-graph.js";
// 贪心不可约传递归约。display
// 裁剪层复用它对单一种类的边做无类型归约
// ——全部前向边同 kind、回边作 carry，它就退化成普通的不可约归约，且在有环输入上可靠。
export { reduceOrdering, type ReducibleEdge } from "./analysis/causality-reduce.js";
export {
  UNPHASED_ID,
  type JumpKind,
  type StructuralRegionKind,
  type TraceRegionKind,
} from "./analysis/causality-order.js";
// 控制流投影：occurrence 级 CFG 与阶段商。
export {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  projectControlFlow,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowNode,
  type FlowNodeKind,
  type FlowPhase,
  type FlowVia,
} from "./analysis/flow-graph.js";
export {
  actorGraphToMermaid,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  siteGraphToMermaid,
} from "./analysis/mermaid.js";
// 因果图的规范文本形式（快照面）。
export {
  serializeCausalityGraph,
  serializeControlFlow,
  serializeHandoffGraph,
} from "./analysis/serialize.js";
// 交接图投影：板面第二层的参与者卡与交接边。
export {
  FANOUT_EXPAND_CAP,
  projectHandoffGraph,
  UNPHASED,
  type Handoff,
  type HandoffGraph,
  type HandoffParticipant,
} from "./analysis/handoff-graph.js";
// 统一分析的核心产物与其规范文本形式：
// 站点图 / 因果图 / actor 图都是它上面的纯投影。
export {
  serializeCore,
  type AnalysisCore,
  type CoreActorSite,
  type CoreAskSite,
  type CoreFacts,
  type CoreFanoutSite,
  type CoreHoleSite,
  type CoreSimpleSite,
  type CoreSites,
  type CoreTypes,
} from "./analysis/core.js";
// core 的 JSON 编解码：样例包把 `AnalysisCore` 冻结成
// `core.json`，下游浏览器端在冻结产物上现场重算投影；Map 以有序 `[key, value][]` 落盘。
export {
  decodeAnalysisCore,
  encodeAnalysisCore,
  type AnalysisCoreJson,
} from "./analysis/core-json.js";
export type {
  ActorSite,
  SiteEdge,
  SiteGraph,
  SiteKind,
  SiteLoc,
  SiteNode,
} from "./analysis/types.js";
export {
  buildAskSpecs,
  synthesizeAskSchemas,
  synthesizeWorkflowSchemas,
  type SchemaSynthesisResult,
} from "./schema/synthesize.js";
export { validate, formatViolation, formatViolations } from "./schema/validate.js";
// 每个 actor 站点的 submit profile：编译期决定子代理拿 typed / generic / 无 submit_result 工具。
export {
  GENERIC_SUBMIT_PROFILE,
  deriveActorSubmitProfiles,
  deriveActorSubmitProfilesFor,
  type ActorSubmitProfile,
} from "./schema/actor-submit-profiles.js";
export { serializeSchema } from "./schema/serialize.js";
export {
  MAX_UNION_MEMBERS,
  SCHEMA_DIAGNOSTIC_CODE,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
  type Violation,
} from "./schema/types.js";
export {
  HOST_BINDING,
  lowerWorkflow,
  lowerWorkflowScript,
  type LoweredWorkflow,
  type LowerResult,
} from "./lowering/index.js";
export {
  WorkflowEngine,
  InMemoryJournalStore,
  ALL_EVENTS,
  NODE_KINDS,
  NON_REPORT_NODE_KINDS,
  type GetNodeOptions,
  type ListActorsOptions,
  type ListNodesOptions,
  type RunEventType,
  WorkflowError,
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  NUDGE_ATTEMPTS,
  REPAIR_ATTEMPTS,
  DEFAULT_WEB_SEARCH_BUDGET_PER_ASK,
  MAX_WEB_SEARCH_BUDGET_PER_ASK,
  canonicalJson,
  fnv1a,
  inputHash,
  refToString,
  type ActorId,
  type ActorRecord,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactRef,
  type ArtifactVersionRecord,
  type AskMessage,
  type AskLastTool,
  type AskProgress,
  type AskSpec,
  type AskStats,
  type Caps,
  type EngineConfig,
  type ImportedActorCandidate,
  type ImportedAskEntry,
  type ImportedInFlightAsk,
  type ImportedRunCache,
  type ImportedWorldEntry,
  type InstanceRef,
  type JournalStorePort,
  type ListEventsOptions,
  type NodeKind,
  type NodeOutcome,
  type NodeRecord,
  type NodeRecordStatus,
  type WorldReadInput,
  WORLD_READ_INPUT_MAX_BYTES,
  type PersonaSpec,
  type PersonaBudget,
  type RunEvent,
  type RunRecord,
  type RunSettlement,
  type RunSettlementRecord,
  type RunStallInfo,
  type RunStatus,
  type RunStopReason,
  type SessionRef,
  type StoredEvent,
  type SubmitVerdict,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowErrorCode,
  type WorkflowErrorJson,
  type ProviderStopDetails,
  type WorkflowErrorMismatch,
  type WorkflowHostApi,
  type WorkflowReportSink,
  type WorldReadOp,
  type AskWaitInfo,
  type ConcurrencyChange,
  type ConcurrencyChangeReason,
} from "./engine/index.js";
export {
  ConcurrencyController,
  CONCURRENCY_DECREASE_FACTOR,
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  CONCURRENCY_INCREASE_STEP,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "./engine/index.js";
export {
  HOLE_PROMPT_MAX_CHARS,
  type FilledHole,
  type FillHoleResult,
  type HoleFill,
  type OpenHole,
} from "./engine/index.js";
