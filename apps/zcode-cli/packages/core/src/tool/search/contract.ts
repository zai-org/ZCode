/** 契约直接复用现有入口；投影不改写 canonical 历史，工具执行仍由执行器负责。 */
export {
  buildToolExposure,
  buildToolSearchAnnouncement,
  isDeferredTool,
  resolveToolSearchMode,
} from "./exposure.js";
export {
  collectDiscoveredTools,
  collectToolSearchHistory,
  compactDiscoveryMetadata,
  projectToolReferences,
} from "./history.js";
export { searchTools } from "./search.js";
export { toolSearchToolEntry } from "../handlers/tool-search.js";
export { deferredToolCallEntry } from "../handlers/deferred-tool-call.js";
export { ToolSearchInputSchema, TOOL_SEARCH_NAME, LOCAL_TOOL_SEARCH_NAME } from "@zcode/contracts";
export { ToolSearchAnnouncementSchema, ToolSearchMcpDeltaSchema } from "@zcode/contracts";
export type { ToolSearchExecutionContext, ToolSearchLiveView } from "@zcode/contracts";
