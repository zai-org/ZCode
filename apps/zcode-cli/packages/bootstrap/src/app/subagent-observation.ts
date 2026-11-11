import {
  EventReducer,
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntime } from "@zcode/core";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import { projectSessionTranscript, type SessionTranscriptMessage } from "../session-transcript.js";
import {
  collectSubagentChildSessionIds,
  loadPreviousRuntimeRunMetadata,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "../zcode-protocol/subagent-session-query.js";
import { getCliStorageRoot, getSubagentOutputRootDir } from "./paths.js";

export interface SubagentTranscriptSnapshot {
  sessionId: string;
  sequenceNumber: number;
  messages: Array<SessionTranscriptMessage & { id?: string }>;
  events: SessionEvent[];
  replayMessageIds: string[];
}

type ObservationDeps = {
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  runtime: AgentRuntime;
  /** 用来定位子代理输出目录（与 create-app 写入时同一规则），读上一代遗留 Agent 的 metadata.json。 */
  configResult?: ConfigResult;
};

/** The app owns storage and lifecycle interpretation; the TUI receives a read model. */
export function createSubagentObservation(deps: ObservationDeps) {
  return {
    async readSubagents(
      input: { endedCursor?: string; endedLimit?: number } = {},
    ): Promise<ZCodeSessionSubagentsResult> {
      const eventStore = deps.runtime.getSessionEventStore();
      const parentSession = await deps.sessionStore.getSession(deps.sessionId);
      if (!parentSession)
        return { revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } };
      const messages = await deps.sessionStore.messages({ sessionID: deps.sessionId });
      const parentEvents = await eventStore.getEvents(deps.sessionId);
      const ids = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
      const children = await Promise.all(
        ids.map(async (id) => {
          const sessionId = id as SessionId;
          const session = await deps.sessionStore.getSession(sessionId);
          if (
            !session ||
            session.parentID !== deps.sessionId ||
            session.taskType !== "subagent_child"
          )
            return null;
          const [messages, events] = await Promise.all([
            deps.sessionStore.messages({ sessionID: sessionId }),
            eventStore.getEvents(sessionId),
          ]);
          return {
            session,
            messages,
            projection: events.length ? new EventReducer().reduce(events) : undefined,
          };
        }),
      );
      const valid = children.filter((child) => child !== null);
      const runtimeStartedAt = performance.timeOrigin;
      const previousRuntimeRunMetadata = await loadPreviousRuntimeRunMetadata({
        parentSession,
        messages,
        parentEvents,
        runtimeStartedAt,
        resolveOutputRootDir: () =>
          deps.configResult
            ? getSubagentOutputRootDir(
                getCliStorageRoot(resolvePath(deps.configResult.config.storage.dir)),
              )
            : undefined,
      }).catch(() => new Map());
      const projection = projectSessionSubagents({
        revision: await eventStore.getLatestSequenceNumber(deps.sessionId),
        parentSession,
        messages,
        parentEvents,
        parentProjection: await deps.runtime.getProjection(),
        runtimeStartedAt,
        previousRuntimeRunMetadata,
        childSessionsById: new Map(valid.map((child) => [child.session.id, child.session])),
        childMessagesById: new Map(valid.map((child) => [child.session.id, child.messages])),
        childProjectionsById: new Map(
          valid.flatMap((child) =>
            child.projection ? [[child.session.id, child.projection] as const] : [],
          ),
        ),
      });
      const ended = paginateEndedSubagents(projection.ended, {
        cursor: input.endedCursor,
        limit: Math.min(100, Math.max(1, input.endedLimit ?? 20)),
      });
      return {
        revision: projection.revision,
        childSessionIds: valid.map((child) => child.session.id),
        running: projection.running,
        ended: { total: projection.ended.length, ...ended },
      };
    },
    async readSubagentTranscript(childSessionId: string): Promise<SubagentTranscriptSnapshot> {
      const eventStore = deps.runtime.getSessionEventStore();
      const sessionId = childSessionId as SessionId;
      const child = await deps.sessionStore.getSession(sessionId);
      if (!child || child.parentID !== deps.sessionId || child.taskType !== "subagent_child") {
        throw new Error("Subagent does not belong to the current session.");
      }
      // Read persisted history first, then the event tail. For messages with a
      // complete live stream, replay replaces persisted text instead of appending
      // it twice. Later events are admitted strictly after this watermark.
      const persisted = await deps.sessionStore.messages({ sessionID: sessionId });
      const events = await eventStore.getEvents(sessionId);
      const replayMessageIds = new Set<string>();
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        if (
          event.type === SessionEventType.ModelStreaming &&
          payload.kind === "start" &&
          typeof payload.assistantMessageId === "string"
        ) {
          replayMessageIds.add(payload.assistantMessageId);
        }
      }
      const messages = persisted.flatMap((message) =>
        replayMessageIds.has(message.info.id)
          ? [{ id: message.info.id, content: "", role: "agent" as const }]
          : projectSessionTranscript([message]).map((projected) => ({
              ...projected,
              id: message.info.id,
            })),
      );
      return {
        sessionId,
        messages,
        events,
        replayMessageIds: [...replayMessageIds],
        sequenceNumber: events.at(-1)?.sequenceNumber ?? 0,
      };
    },
  };
}
