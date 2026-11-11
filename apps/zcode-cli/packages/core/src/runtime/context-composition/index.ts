// context-composition（CLI core 部分）公开入口。规格：apps/zcode-cli/docs/design/v2/model/context-composition.md。
export {
  classifyContextComposition,
  projectContextCompositionToUsageSources,
  toContextCompositionCategories,
  CONTEXT_USAGE_SOURCE_ORDER,
  type ContextCompositionBreakdown,
  type ContextCompositionBreakdownCategory,
  type ContextCompositionBreakdownItem,
  type ContextCompositionClassifierInput,
  type ContextCompositionNamedSize,
} from "./classifier.js";
export { collectContextCompositionItems } from "./items.js";
export {
  markContextCompositionChanged,
  recordRequestContextComposition,
  recordRequestContextCompositionUsage,
  subscribeContextCompositionChanged,
  supersedeContextComposition,
  type ContextCompositionChangeListener,
  type ContextCompositionChangeReason,
  type ContextCompositionMeasurement,
} from "./state.js";
export {
  buildContextCompositionMeasurement,
  getContextComposition,
  type ContextCompositionQuery,
} from "./query.js";
