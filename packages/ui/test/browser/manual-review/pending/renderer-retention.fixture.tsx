import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService, WebRemoteControlStatus } from "@zcode/shared";
import type { IServiceAccessor, IBroadcastService } from "@zcode/services";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { createZCodeStore } from "@/store/index.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className = params.get("theme") ?? "light";
const noop = () => {};
const dispose = () => ({ dispose: noop });
const broadcast = { send: async () => {}, onMessage: dispose } as unknown as IBroadcastService;
const store = createZCodeStore(broadcast);
const services = {
  broadcastService: broadcast,
  settingService: { get: async () => ({}), update: async () => {} },
  zcodeAgentService: { onAgentRuntimeRestarted: dispose },
  subagentsService: { list: async () => ({ agents: [], capability: null }) },
  skillsService: { list: async () => ({ skills: [] }) },
  clientConfigService: { getSnapshot: async () => ({}) },
  pluginManagementService: { getPluginReferenceCatalog: async () => ({ plugins: [] }) },
} as unknown as IServiceAccessor;
const snapshots: WeakRef<ConversationSnapshot>[] = [];
const sent: Array<{ text: string; delivery?: string }> = [];
function makeSnapshot(sessionId: string, revision: number): ConversationSnapshot {
  const snapshot = {
    protocolVersion: 1,
    sessionId,
    logEpoch: "retention",
    revision,
    seq: revision,
    control: {
      phase: "running",
      canStop: true,
      activeWorks: [],
      stopState: "idle",
      lastError: null,
    },
    inputRouting: { mode: "queue" },
    config: { provider: "fixture", model: "fixture", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    workspaceMcpAdmission: null,
    rows: {
      window: [
        { kind: "assistantText", rowId: revision, text: ("history-" + revision).repeat(100000) },
      ],
      totalCount: 1,
      firstRowId: revision,
    },
  } as unknown as ConversationSnapshot;
  snapshots.push(new WeakRef(snapshot));
  return snapshot;
}
function makePlatform() {
  let current: WebRemoteControlStatus = { status: "idle" };
  const listeners = new Set<(status: WebRemoteControlStatus) => void>();
  const pending: Array<(status: WebRemoteControlStatus) => void> = [];
  let deferred = false,
    polls = 0;
  return {
    api: {
      getWebRemoteControlStatus: () => {
        polls++;
        return deferred
          ? new Promise<WebRemoteControlStatus>((resolve) => pending.push(resolve))
          : Promise.resolve({ ...current });
      },
      onWebRemoteControlStatusChanged: (listener: (status: WebRemoteControlStatus) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as IPlatformService,
    emit(status: WebRemoteControlStatus, count = 1) {
      current = status;
      for (let i = 0; i < count; i++) for (const listener of listeners) listener({ ...status });
    },
    defer() {
      deferred = true;
    },
    resolve() {
      for (const done of pending.splice(0)) done({ status: "idle", error: "stale" });
    },
    stats: () => ({ polls, listeners: listeners.size }),
  };
}
const platforms = [makePlatform(), makePlatform()];
function Status() {
  const [enabled, setEnabled] = useState(true);
  const status = useWebRemoteControlStatus({ enabled, intervalMs: 50 });
  return (
    <section data-testid="status-owner">
      <button onClick={() => setEnabled(!enabled)}>Enable</button>
      <output data-testid="status">{JSON.stringify(status)}</output>
    </section>
  );
}
function Fixture() {
  const [platform, setPlatform] = useState(0);
  const [scope, setScope] = useState({
    sessionId: "sess_probe_retention_0",
    token: Symbol("scope"),
    text: "restored-sess_probe_retention_0",
  });
  const content = useRef(scope.text);
  const [snapshot, setSnapshot] = useState(() => makeSnapshot("sess_probe_retention_0", 0));
  const [shown, setShown] = useState(true);
  Object.assign(window, {
    retentionFixture: {
      liveSnapshots: () => snapshots.flatMap((ref, index) => (ref.deref() ? [index] : [])),
      advance: () => setSnapshot((current) => makeSnapshot(scope.sessionId, current.revision + 1)),
      switchScope: () => {
        const sessionId = scope.sessionId.endsWith("0")
          ? "sess_probe_retention_1"
          : "sess_probe_retention_0";
        setScope({ sessionId, token: Symbol("scope"), text: "restored-" + sessionId });
        setSnapshot((current) => makeSnapshot(sessionId, current.revision + 1));
      },
      promote: () =>
        setScope((current) => ({ ...current, sessionId: "promoted", text: content.current })),
      indicators: (count: number) =>
        setSnapshot(
          (current) =>
            ({
              ...current,
              workspaceHookAdmission: { pendingCount: count, bundleDigest: String(count) },
              workspaceMcpAdmission: { pendingCount: count, bundleDigest: String(count) },
              backgroundWorks: Array.from({ length: count }, (_, index) => ({
                id: String(index),
                kind: "bash",
                status: "running",
              })),
            }) as ConversationSnapshot,
        ),
      sent,
      platforms,
      replacePlatform: () => setPlatform(1),
      unmount: () => setShown(false),
    },
  });
  return (
    <PlatformProvider platform={platforms[platform]!.api}>
      {params.get("kind") === "status" ? (
        shown && <Status />
      ) : (
        <ConversationComposer
          snapshot={snapshot}
          sessionId={scope.sessionId}
          composerDraftScopeToken={scope.token}
          composerDraft={{ text: scope.text, updatedAt: 1 }}
          workspacePath="/example"
          isWebRemoteControl={params.get("mobile") === "1"}
          stageComposerContent={noop}
          captureComposerContentLifecycleCommit={() => noop}
          captureComposerSubmissionDraftTransaction={() => ({
            claim: () => true,
            restore: () => ({ current: true, applied: true }),
            finalize: () => ({ current: true, applied: true }),
            release: noop,
            matchesTarget: () => false,
          })}
          persistComposerContent={noop}
          updateComposerContent={noop}
          replaceComposerDraft={noop}
          attachmentPut={async () => {
            throw new Error("No attachments in this fixture");
          }}
          onTextChange={(text) => {
            content.current = text;
          }}
          onSendText={async (text, options) => {
            sent.push({ text, delivery: options?.requestedDelivery });
            return "blocked";
          }}
          onOpenRunningBackgroundWorks={noop}
          onStop={noop}
          onSelectModel={noop}
          onSelectThought={noop}
          onSwitchMode={noop}
        />
      )}
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <StoreContext.Provider value={store}>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TabStoreProvider>
          <TooltipProvider>
            <Fixture />
          </TooltipProvider>
        </TabStoreProvider>
      </ZCodeIntlProvider>
    </StoreContext.Provider>
  </ServiceProvider>,
);
