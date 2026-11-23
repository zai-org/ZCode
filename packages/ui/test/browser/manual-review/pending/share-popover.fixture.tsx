import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { ConversationSharePopover } from "@/conversation-share-interaction/ConversationSharePopover.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import { ConversationSharePreflightStatus } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import {
  getConversationShareSelectedProductTurnIds,
  useConversationShareSelectionStore,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
} from "@/store/conversationShareSelectionStore.js";
import { aggregateConversationShareBlockingIssues } from "@/conversation-share-interaction/conversationSharePreflightCache.js";
import "@/styles.css";
const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const items = Array.from({ length: Number(params.get("items") ?? 9) }, (_, i) => ({
  key: String(i),
  rowId: i + 1,
  unitIndex: i,
  userPreview: i === 0 ? "hello" : `你好，第 ${i + 1} 轮`,
  assistantPreview:
    "Hello! I'm ZCode, your coding assistant. I can help you explore the repository, understand the implementation, and improve the sharing experience.",
  isRunning: params.has("running") || i === 8,
}));
function Fixture() {
  const { intl } = useZCodeIntl();
  const [sessionId, setSessionId] = useState("a");
  const [inspected, setInspected] = useState(0);
  const [checking, setChecking] = useState(false);
  const [limitEnabled, setLimitEnabled] = useState(params.has("budget"));
  const [short, setShort] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState("");
  const [openedUrl, setOpenedUrl] = useState("");
  const candidates = completed ? items.map((item) => ({ ...item, isRunning: false })) : items;
  const visibleItems = short ? candidates.slice(0, 1) : candidates;
  const productTurnId = (id: number) => (params.has("grouped") && id <= 2 ? "group" : String(id));
  const state = useConversationShareSelectionStore();
  const draft = state.drafts[sessionId];
  const dock = state.dockStates[sessionId] ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const editing = draft?.pendingExcludedRowIds != null;
  const count = getConversationShareSelectedProductTurnIds(state, sessionId).length;
  const selected = new Set(
    (draft?.availableRowIds ?? []).filter(
      (id) => !(draft?.pendingExcludedRowIds ?? draft?.excludedRowIds ?? []).includes(id),
    ),
  );
  const pendingTurns = getConversationShareSelectedProductTurnIds(state, sessionId, "pending");
  const budgetIssues = aggregateConversationShareBlockingIssues(
    pendingTurns.map((id, i) => ({
      productTurnId: id,
      blockingIssues: [],
      skippableWarnings: [],
      deferredIssues: [],
      rowBudget: {
        count: params.has("budget")
          ? i === 0
            ? Number(params.get("budget"))
            : 0
          : id === "1"
            ? 120
            : 70,
        limit: Number(params.get("limit") ?? 500),
      },
    })),
  );
  const cancel = () => state.cancelSelectionEdit(sessionId);
  useEffect(() => {
    if (draft?.open)
      state.syncAvailableTurns(
        sessionId,
        candidates
          .filter((i) => !i.isRunning)
          .map((i) => ({ rowId: i.rowId, productTurnId: productTurnId(i.rowId) })),
      );
  }, [sessionId, draft?.open, completed]);
  const patch = (value: Parameters<typeof state.updateDockState>[1]) =>
    state.updateDockState(sessionId, value);
  return (
    <main className="relative flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-end px-4">
        <button
          data-testid="toggle-preflight"
          data-conversation-share-keep-open="fixture"
          onClick={() => setChecking(!checking)}
        >
          检查状态
        </button>
        <button
          data-testid="toggle-limit"
          data-conversation-share-keep-open="fixture"
          onClick={() => setLimitEnabled(!limitEnabled)}
        >
          Limit
        </button>
        <button
          data-testid="short-list"
          data-conversation-share-keep-open="fixture"
          onClick={() => setShort(!short)}
        >
          短列表
        </button>
        <button
          data-testid="complete-turn"
          data-conversation-share-keep-open="fixture"
          onClick={() => setCompleted(true)}
        >
          完成运行轮次
        </button>
        <ConversationShareMenu taskId={sessionId} />
      </header>
      <div className="relative min-h-0 flex-1">
        <button data-testid="outside" className="absolute bottom-20 right-4">
          正文外部区域
        </button>
        <button
          data-testid="switch"
          data-conversation-share-keep-open="fixture"
          onClick={() => setSessionId(sessionId === "a" ? "b" : "a")}
        >
          切换任务
        </button>
        <output data-testid="inspected">{inspected}</output>
        <output data-testid="copied-url">{copiedUrl}</output>
        <output data-testid="opened-url">{openedUrl}</output>
        <ConversationShareSelectionPanel
          visible={editing}
          items={visibleItems}
          selectedCount={pendingTurns.length}
          selectedRowIds={selected}
          preflight={
            checking
              ? { status: "checking" }
              : {
                  status: "ready",
                  revision: 1,
                  logEpoch: "fixture",
                  capabilitiesFingerprint: "fixture",
                  blockingIssues: limitEnabled ? budgetIssues : [],
                  skippableWarnings: [],
                  deferredIssues: [],
                  supportedArtifactTypes: [],
                  turnResults: [],
                }
          }
          onSelectAllChange={(selected) => state.setAllPendingRowsSelected(sessionId, selected)}
          onToggle={(id) => state.togglePendingRow(sessionId, id)}
          onInspect={(target) => setInspected(target.rowId)}
          onConfirm={() => state.confirmSelectionEdit(sessionId)}
          onCancel={cancel}
        />
      </div>
      <textarea
        aria-label="Composer"
        className="m-4 h-20 shrink-0 rounded-xl border border-border"
      />
      <ConversationSharePopover
        sessionId={sessionId}
        open={draft?.open ?? false}
        publishing={dock.publishing}
        selecting={editing}
        onClose={() => state.closeShare(sessionId)}
        onCancelSelection={cancel}
      >
        {dock.publishedShareUrl ? (
          <ConversationShareSuccessDock
            title={
              dock.title ?? "国内海外双区域登录与下载分发适配，以及长标题布局和多语言兼容性验证"
            }
            url={dock.publishedShareUrl}
            onCopy={async () => {
              setCopiedUrl(dock.publishedShareUrl!);
              return true;
            }}
            onOpen={() => setOpenedUrl(dock.publishedShareUrl!)}
            onDismiss={() => state.closeShare(sessionId)}
          />
        ) : (
          <ConversationShareConfirmationDock
            preflightChecking={checking}
            publishDisabled={checking}
            preflightContent={
              <ConversationSharePreflightStatus
                preflight={
                  params.has("issue")
                    ? {
                        status: "ready",
                        revision: 1,
                        logEpoch: "fixture",
                        capabilitiesFingerprint: "fixture",
                        blockingIssues: pendingTurns.includes("1")
                          ? [
                              {
                                code: "running_turn",
                                scope: "turn",
                                productTurnId: "1",
                                turnOrdinal: 1,
                              },
                            ]
                          : [],
                        skippableWarnings: [],
                        deferredIssues: [],
                        supportedArtifactTypes: [],
                        turnResults: [],
                      }
                    : { status: "checking" }
                }
                onDeselectTurn={(id) => state.deselectProductTurn(sessionId, id)}
              />
            }
            selectedCount={count}
            totalCount={8}
            title={
              dock.title ?? "国内海外双区域登录与下载分发适配，以及长标题布局和多语言兼容性验证"
            }
            accessMode={draft?.accessMode}
            selectionEditing={editing}
            pending={dock.publishing}
            progressPhase={dock.progress}
            completedArtifacts={dock.completedArtifacts}
            totalArtifacts={3}
            progressLabel={intl.formatMessage({
              id: `conversationShare.progress.${dock.progress}`,
            })}
            error={dock.error}
            onCancel={() => state.closeShare(sessionId)}
            onEditSelection={() => state.beginSelectionEdit(sessionId)}
            onTitleChange={(title) => patch({ title })}
            onAccessModeChange={(mode) => state.setAccessMode(sessionId, mode)}
            disclosureAccepted={dock.disclosureAccepted}
            onDisclosureAcceptedChange={(disclosureAccepted) => patch({ disclosureAccepted })}
            onConfirm={() => patch({ publishing: true, error: null })}
          />
        )}
      </ConversationSharePopover>
      {dock.publishing ? (
        <button
          data-testid="fail-publish"
          onClick={() =>
            patch({
              publishing: false,
              error: { issues: [], issueCount: 0, messageId: "conversationShare.issue.unknown" },
            })
          }
        >
          失败
        </button>
      ) : null}
      {dock.publishing ? (
        <button
          data-testid="advance-publish"
          onClick={() =>
            patch({
              progress: dock.progress === "collecting" ? "uploading" : "checking",
              completedArtifacts: 2,
            })
          }
        >
          下一阶段
        </button>
      ) : null}
      {dock.publishing ? (
        <button
          data-testid="resolve-publish"
          onClick={() =>
            patch({
              publishing: false,
              publishedShareUrl:
                "https://example.com/share/long-share-link-for-reviewing-regional-download-distribution-and-layout",
            })
          }
          className="fixed bottom-0 left-0"
        >
          完成模拟发布
        </button>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
