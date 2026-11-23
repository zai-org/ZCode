import { memo, useEffect, useMemo, useState } from "react";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";
import { Button } from "@/components/ui/button.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

export function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

const DirectoryRow = memo(function DirectoryRow({
  item,
  onOpen,
}: {
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  const presentation = useToolPresentationCapabilities();
  const configuredColor = presentation.agentColor?.(item.subagentType);
  const faceStatus =
    item.status === "success"
      ? "done"
      : item.status === "running"
        ? "running"
        : item.status === "failed"
          ? "failed"
          : undefined;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-left text-ui-base transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => onOpen(item)}
    >
      {/* 按首行行高居中，避免固定顶部偏移导致头像随字号变化错位。 */}
      <span className="flex h-[1lh] w-5 shrink-0 items-center justify-center">
        <WorkflowAgentFace
          avatarIndex={undefined}
          name={item.subagentType}
          status={faceStatus}
          idle={item.status === "cancelled" || item.status === "lost"}
          showCompletionMark={item.status === "success"}
          color={configuredColor ? SUBAGENT_WORKFLOW_COLOR[configuredColor] : undefined}
          className="size-5"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{item.title}</span>
          {item.status !== "success" ? (
            <span className="shrink-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
            </span>
          ) : null}
        </span>
        {item.summary ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {item.summary}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          {formatTaskRelativeTime(timestamp, intl)}
        </span>
      ) : null}
    </button>
  );
});

export const SubagentDirectorySidePane = memo(function SubagentDirectorySidePane({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentDirectoryContents tab={tab} onOpenSubagentSession={onOpenSubagentSession} />
    </V4PaneConversationProvider>
  );
});

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const endedTotal = subagents?.endedTotal ?? 0;
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {running.length > 0 ? (
          <section>
            <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.running" })} · {running.length}
            </h3>
            {running.map((item) => (
              <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
            ))}
          </section>
        ) : null}

        <section className={running.length > 0 ? "mt-3" : undefined}>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} · {endedTotal}
          </h3>
          {directory.ended.items.map((item) => (
            <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p role="alert" className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]">
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
