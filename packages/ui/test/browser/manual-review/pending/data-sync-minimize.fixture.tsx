import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { DataSyncDialogProvider, useDataSyncEntry } from "@/data-sync/index.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { registerSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") ?? "zh-CN";
localStorage.setItem("zcode-locale-preference", locale);
document.documentElement.className =
  params.get("theme") === "dark" ? "theme-zai-dark dark" : "theme-zai-light";
const sibling = params.get("scenario") === "sibling";
const sourceServerId = "00000000-0000-4000-8000-000000000018";
const events: string[] = [];
let releaseImport: (() => void) | undefined;
let imported = false;
const listeners = new Set<() => void>();
let online = true;
const item = {
  key: sibling ? "minimize-plugin@inline" : "minimize-skill",
  name: "minimize-skill",
  description: "E2E_MINIMIZE",
  enabled: true,
};
const empty = { listSyncItems: async () => ({ items: [], homeDir: "/home/dev" }) };
const skillService = (target: boolean) => ({
  listSyncItems: async () => ({ items: target && !imported ? [] : [item], homeDir: "/home/dev" }),
  getSyncContentHashes: async () => ({ hashes: { [item.key]: "same" } }),
  checkSyncWriteAccess: async () => ({ ok: true }),
  exportSyncItems: async () => ({ items: [{ key: item.key, pluginId: "minimize-plugin" }] }),
  importSyncItems: async () => {
    events.push("import-start");
    await new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    imported = true;
    events.push("import-finish");
    return { results: [{ key: item.key, status: "created" }] };
  },
});
// 回放一个分类失败、另一个仍在导入的时序，释放导入前不依赖计时器。
const subagentItems = ["Explore", "general-purpose"].map((name) => ({
  key: `built-in:built-in:${name.toLowerCase()}`,
  name,
  enabled: true,
  builtInModelOverride: { modelId: "example-model", reasoningLevel: "high" },
}));
const userConfigService = (target: boolean) => ({
  listSyncItems: async ({ category }: { category: string }) => ({
    items: sibling && category === "subagents" && !target ? subagentItems : [],
    homeDir: "/home/dev",
  }),
  getSyncContentHashes: async () => ({ hashes: {} }),
  checkSyncWriteAccess: async () => ({ ok: true }),
  exportSyncItems: async () => ({ items: [] }),
  importSyncItems: async ({ items }: { items: { key: string }[] }) => ({
    results: items.map(({ key }) => ({
      key,
      status: "failed",
      error: "subagent is missing from the sync payload",
    })),
  }),
});
const services = {
  skillSyncService: sibling ? empty : skillService(false),
  mcpSyncService: empty,
  pluginSyncService: sibling ? skillService(false) : empty,
  userConfigSyncService: userConfigService(false),
  systemService: { info: async () => ({ homedir: "/home/dev" }) },
  pluginManagementService: {
    getPluginsOverview: async () => ({
      marketplaces: [],
      installedPlugins: [],
      availablePlugins: [],
    }),
    listPlugins: async () => ({ plugins: [] }),
  },
  sourceServerManagementService: {
    getSnapshot: async () => ({
      servers: [{ sourceServerId, displayName: "E2E Sync Device", installState: "installed" }],
      profiles: [
        {
          sourceServerId,
          profileId: "profile",
          target: { kind: "ssh", host: "example.com", username: "dev", port: 22 },
        },
      ],
      states: [{ profileId: "profile", state: online ? "online" : "offline" }],
    }),
    onDidChangeState: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  },
  deviceSyncStateService: {
    recordDeviceSyncResult: async ({ result }: { result: string }) => {
      events.push(`result:${result}`);
    },
  },
} as unknown as IServiceAccessor;
registerSourceSettingsServices({
  sourceServerId,
  attachmentId: "e2e",
  services: {
    ...services,
    skillSyncService: sibling ? empty : skillService(true),
    pluginSyncService: sibling ? skillService(true) : empty,
    userConfigSyncService: userConfigService(true),
  } as IServiceAccessor,
  dispose() {},
});
const web = params.get("platform") === "web";
const platform = (
  web
    ? {}
    : {
        requestSourceSettingsAttachment: async () => ({ attachmentId: "e2e" }),
        reportTelemetryEvent: async () => {},
      }
) as IPlatformService;

// 控制在途导入的完成点，避免用延时碰运气；浏览器运行真实 Provider、弹窗与推送 hook。
Object.assign(window, {
  syncFixture: {
    events,
    finish: () => releaseImport?.(),
    disconnect: () => {
      online = false;
      listeners.forEach((listener) => listener());
    },
  },
});
function Entry() {
  const entry = useDataSyncEntry({
    onPushFinished: () => {
      events.push("entry-refresh");
    },
  });
  return (
    <button
      data-testid="fixture-open"
      disabled={!entry.available}
      onClick={() => entry.open({ sourceServerId, category: "skills" })}
    >
      Open sync
    </button>
  );
}
function Fixture() {
  const [settings, setSettings] = useState(true);
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <button data-testid="fixture-navigate" onClick={() => setSettings((value) => !value)}>
        Switch page
      </button>
      {settings ? <Entry /> : <h1 data-testid="fixture-other-page">Workspace</h1>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <TabStoreProvider>
          {web ? (
            <Fixture />
          ) : (
            <DataSyncDialogProvider>
              <Fixture />
            </DataSyncDialogProvider>
          )}
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
