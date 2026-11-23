import {
  PersistedToolSearchContentSchema,
  ToolSearchAnnouncementSchema,
  ToolSearchMcpDeltaSchema,
  compactBoundaryPayloadSchema,
  type Logger,
} from "@zcode/contracts";
import { compactDiscoveryMetadata } from "../tool/search/history.js";

export function hydrateToolSearchContent(value: unknown, logger?: Logger) {
  if (value === undefined) return undefined;
  const parsed = PersistedToolSearchContentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger?.warn("Invalid persisted ToolSearch content; using legacy tool result", {
    event: "session.tool_search.invalid_content",
    module: "core.session",
  });
  return undefined;
}

export function hydrateCompactDiscovery(value: unknown) {
  const parsed = compactBoundaryPayloadSchema.safeParse(value);
  return parsed.success ? compactDiscoveryMetadata(parsed.data) : undefined;
}

export function hydrateToolSearchAnnouncement(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = ToolSearchAnnouncementSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function hydrateToolSearchMcpDelta(value: unknown) {
  const parsed = ToolSearchMcpDeltaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
