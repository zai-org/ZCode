import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type {
  CommandAck,
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { IServiceAccessor, IBroadcastService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { createZCodeStore } from "@/store/index.js";
import { composerEditSessionKey, useComposerEditStore } from "@/composer-edit-mode/index.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "dark" ? "dark" : "light";
const mobile = query.get("mobile") === "true";
const count = Number(query.get("count") || 8);
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as unknown as IBroadcastService;
const services = {
  clientConfigService: {},
  subagentsService: { list: async () => ({ agents: [], capability: null }) },
  zcodeAgentService: {},
  settingService: { get: async () => ({}) },
  broadcastService: broadcast,
} as unknown as IServiceAccessor;
const platform = { platform: "darwin" } as unknown as IPlatformService;
const settings = createZCodeStore(broadcast);
settings.getState().setTheme(theme);
document.documentElement.className = `${theme} theme-zai-${theme}`;
const rows: ConversationRow[] = Array.from({ length: count }, (_, index) => {
  const base = {
    turnId: `turn-${index}`,
    createdAt: 1700000000000 + index,
    createdAtSeq: index + 1,
  };
  return [
    {
      ...base,
      rowId: index * 10 + 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: base.createdAt,
      endedAt: base.createdAt + 1000,
    },
    {
      ...base,
      rowId: index * 10 + 2,
      kind: "userInput",
      origin: "realUser",
      entityId: `user-${index}`,
      text: `E2E_EDIT_PRESENTATION_${index} 请分析编辑重发的布局。`,
      actions: { canEdit: index === count - 1 },
    },
    {
      ...base,
      rowId: index * 10 + 3,
      kind: "assistantText",
      entityId: `assistant-${index}`,
      state: "complete",
      text: Array.from(
        { length: 9 },
        (_, paragraph) => `第 ${paragraph + 1} 段：合成回答用于检查列表高度和滚动位置。`,
      ).join("\n\n"),
    },
  ] as ConversationRow[];
}).flat();
function makeSnapshot(sessionId: string, initialRows = rows): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-a",
    seq: 0,
    revision: 0,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {},
    inputRouting: {},
    meta: { title: "Fixture", titleSource: "default" },
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: initialRows,
      totalCount: initialRows.length,
      firstRowId: initialRows[0]?.rowId ?? null,
    },
  } as ConversationSnapshot;
}
function makeStore(sessionId: string, initialRows = rows) {
  const snapshot = makeSnapshot(sessionId, initialRows);
  let store: ConversationProjectionStore;
  const topic = `conversation:${sessionId}`;
  const subscriptionId = `sub-${sessionId}`;
  const transport = {
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    subscribe: async () => ({
      ack: { subscriptionId, mode: "snapshot", logEpoch: snapshot.logEpoch },
    }),
    activate: () =>
      store.handleFrame(
        {
          topic,
          subscriptionId,
          logEpoch: snapshot.logEpoch,
          fromSeq: 0,
          toSeq: 0,
          payload: { kind: "snapshot", snapshot },
        } as ConversationTopicFrame,
        { deliveryKind: "initial" },
      ),
    unsubscribe: async () => {},
  } as unknown as ConversationTransport;
  store = new ConversationProjectionStore(topic, transport);
  void store.connect();
  return store;
}
const store = makeStore("edit");
const other = makeStore(
  "other",
  rows.map((row) => ({ ...row, rowId: row.rowId + 1000, turnId: `other-${row.turnId}` })),
);
const commandId = "edit-command";
let resolveAck: (value: CommandAck | false) => void = () => {};
let editedText = "";
const send = (deltas: ConversationDelta[]) => {
  const current = store.getState().snapshot!;
  store.handleFrame({
    topic: store.topic,
    subscriptionId: store.getState().subscriptionId!,
    logEpoch: current.logEpoch,
    fromSeq: current.seq,
    toSeq: current.seq + 1,
    payload: { kind: "deltas", deltas },
  } as ConversationTopicFrame);
};
const probe = {
  submitted: false,
  cut: () => send([{ op: "row.removed", fromRowId: (count - 1) * 10 + 1 }]),
  ack: () => resolveAck({ commandId, status: "accepted" } as CommandAck),
  reject: () => {
    store.settleCommand(commandId);
    resolveAck(false);
  },
  replace: (sourceCommandId = commandId) => {
    const base = {
      turnId: `edited-${sourceCommandId}`,
      createdAt: 1700000100000,
      createdAtSeq: 99,
    };
    send([
      {
        op: "row.appended",
        row: {
          ...base,
          rowId: count * 10 + 1,
          kind: "turnHeader",
          origin: "userInput",
          state: "running",
          startedAt: base.createdAt,
        },
      },
      {
        op: "row.appended",
        row: {
          ...base,
          rowId: count * 10 + 2,
          kind: "userInput",
          origin: "realUser",
          sourceCommandId,
          entityId: `edited-${sourceCommandId}`,
          text: editedText,
          actions: { canEdit: true },
        },
      },
    ]);
  },
  queued: () =>
    send([
      {
        op: "state.updated",
        patch: {
          queue: {
            autoDrain: false,
            items: [{ queueItemId: "edit-queued", sourceCommandId: commandId, text: editedText }],
          },
        },
      } as ConversationDelta,
    ]),
  error: () =>
    send([
      {
        op: "state.updated",
        patch: {
          control: {
            ...store.getState().snapshot!.control,
            phase: "error",
            lastError: {
              code: "fixture.failure",
              message: "Fixture failed",
              recoverable: true,
              at: 1700000100000,
              source: "runtime",
            },
          },
        },
      },
    ]),
  epoch: () => {
    const snapshot = { ...makeSnapshot("edit", []), logEpoch: "epoch-b" };
    store.handleFrame(
      {
        topic: store.topic,
        subscriptionId: store.getState().subscriptionId!,
        logEpoch: snapshot.logEpoch,
        fromSeq: 0,
        toSeq: 0,
        payload: { kind: "snapshot", snapshot },
      } as ConversationTopicFrame,
      { deliveryKind: "recovery" },
    );
  },
  close: () => store.close(),
  switchSession: () => {},
  state: () => ({
    rows: store.getState().snapshot?.rows.window.map((row) => row.rowId),
    pending: store.getState().editPresentation != null,
    seq: store.getState().snapshot?.seq,
  }),
};
Object.assign(window, { editProbe: probe });
// 编辑在底部 composer 编辑态进行（docs/ui/composer-edit-mode.md）：Edit 只标记目标行进入编辑，
// 原行显示「正在下方编辑」。真实 composer 依赖 SessionPane 全量服务，这里用最小替身执行同一
// 提交契约：editUserQuery ACK 后等待显示交接完成才退出编辑态，失败保留可重试的编辑内容。
const editKey = composerEditSessionKey("/fixture", "edit");
const beginEdit = (target: { rowId: number; entityId: string }) => {
  useComposerEditStore.getState().begin(editKey, {
    target: { kind: "userQuery", rowId: target.rowId, entityId: target.entityId },
    scopeId: "edit::composer-edit:fixture",
    inputKind: "sendText",
    loadedText: "",
    lockConfirmed: false,
  });
};
const submitEdit = async (text: string) => {
  editedText = text;
  probe.submitted = true;
  store.markCommandPending({ commandId, type: "editUserQuery", issuedAt: Date.now() });
  const ack = await new Promise<CommandAck | false>((resolve) => {
    resolveAck = resolve;
  });
  if (ack) await store.waitForEditPresentation(commandId);
  if (ack) useComposerEditStore.getState().end(editKey);
  return ack;
};
function FixtureComposer() {
  const editing = useComposerEditStore((state) => state.sessions[editKey] !== undefined);
  const [submitting, setSubmitting] = useState(false);
  if (!editing) {
    return (
      <div className="h-16 w-full bg-background" data-testid="fixture-composer">
        Composer
      </div>
    );
  }
  return (
    <div className="h-16 w-full bg-background" data-testid="fixture-composer">
      <button
        type="button"
        data-testid="fixture-edit-submit"
        disabled={submitting}
        onClick={() => {
          setSubmitting(true);
          void submitEdit("E2E_EDIT_PRESENTATION 编辑后的问题").finally(() => setSubmitting(false));
        }}
      >
        Send
      </button>
    </div>
  );
}
function Fixture() {
  const [active, setActive] = useState(store);
  probe.switchSession = () => setActive(other);
  const state = useSyncExternalStore(
    (listener) => active.subscribe(listener),
    () => active.getState(),
  );
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const displayed = state.editPresentation?.rows ?? snapshot.rows;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <ConversationTimeline
          rows={displayed.window}
          totalCount={displayed.totalCount}
          sessionKey={snapshot.sessionId}
          compactForRemoteControl={mobile}
          rowContext={{
            codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
            sessionId: snapshot.sessionId,
            theme,
            workspacePath: "/fixture",
          }}
          onEdit={beginEdit}
          bottomDock={<FixtureComposer />}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <StoreContext.Provider value={settings}>
        <TabStoreProvider>
          <ZCodeIntlProvider initialLocale={mobile ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </ZCodeIntlProvider>
        </TabStoreProvider>
      </StoreContext.Provider>
    </PlatformProvider>
  </ServiceProvider>,
);
