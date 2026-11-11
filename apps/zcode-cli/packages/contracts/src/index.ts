// ============================================================
// Interface contracts exports
// ============================================================

// Interfaces
export * from "./interfaces/shared.js";
export * from "./interfaces/execution.port.js";
export * from "./interfaces/browser-control.port.js";
export * from "./interfaces/file-system.port.js";
export * from "./interfaces/context-source.port.js";
export * from "./interfaces/provider-endpoint-routing.port.js";
export * from "./interfaces/http-client.port.js";
export * from "./interfaces/image-processor.port.js";
export * from "./interfaces/pdf-document.port.js";
export * from "./interfaces/permission.port.js";
export * from "./interfaces/session.port.js";
export * from "./interfaces/session-mailbox.port.js";
export * from "./interfaces/session-store.port.js";
export * from "./interfaces/input-history.port.js";
export * from "./interfaces/tool-artifact-store.port.js";
export * from "./interfaces/subagent.port.js";
export * from "./interfaces/coordinator-response.port.js";
export * from "./interfaces/workflow.port.js";
export * from "./interfaces/workflow-submit.port.js";
export * from "./interfaces/workflow-escalate.port.js";
export * from "./interfaces/workflow-web-search-budget.port.js";
export * from "./interfaces/dynamic-workflow-run.port.js";
export * from "./interfaces/dynamic-workflow-snippet.port.js";
export * from "./interfaces/model-catalog.port.js";
export * from "./interfaces/automation.port.js";
export * from "./interfaces/off-peak.port.js";
export * from "./interfaces/topic-resource.port.js";
export * from "./interfaces/plugin-discovery.port.js";
export * from "./interfaces/mcp.port.js";

export * from "./interfaces/runtime-input-presentation.js";

// Events
export * from "./events/session.events.js";
export * from "./events/stream-recovery.events.js";
export * from "./events/event-reducer.js";
export * from "./events/session-event-retention.js";
export * from "./events/in-memory-session-event-store.js";

// Compact
export * from "./compact/index.js";

// Rewind
export * from "./rewind/index.js";

// Model
export * from "./model/index.js";
export * from "./model/image-media.js";
export * from "./model/media-policy.js";

// Telemetry
export * from "./telemetry/index.js";

// Errors
export * from "./errors/index.js";

// Config
export * from "./config/index.js";

// Hooks
export * from "./hooks/index.js";

// Skills
export * from "./skills/index.js";

// Custom Commands
export * from "./commands/index.js";

// Plugins
export * from "./plugins/index.js";

// Workflow
export * from "./workflow/index.js";

// Logging
export * from "./logging/logger.js";

// Tracing
export * from "./tracing/tracer.js";

// Time
export * from "./time/local-date.js";

// Path
export * from "./path/index.js";

// Network
export * from "./network/public-egress-ip.js";

// Tools
export * from "./tools/index.js";
export * from "./tools/websearch.js";

// 媒体预算上限由 App/Agent 共用策略定义；Contracts 统一转出，避免 Core 各处跨层取值。
export {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  VIDEO_INPUT_MAX_BYTES,
} from "@zcode/shared";

export * from "./tracing/local-turn-preparation.js";
export type { LocalTtftDetail } from "@zcode/shared";

export * from "./interfaces/permission-full-access.js";
