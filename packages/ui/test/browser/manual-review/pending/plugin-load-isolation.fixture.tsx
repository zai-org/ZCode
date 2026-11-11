import { createRoot } from "react-dom/client";
import type { IPluginManagementService } from "@zcode/services";
import { createPluginManagementStore } from "@/store/pluginManagementStore.js";
import { PluginStoreCard } from "@/settings/PluginStoreCard.js";
import { buildStoreItems } from "@/settings/pluginStoreListing.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
let failure = params.get("failure");
const calls = { list: 0, overview: 0 };
const plugin = {
  id: "installed@fixture",
  name: "installed",
  marketplace: "fixture",
  enabled: true,
  source: "cache",
  rootPath: "/fixture/installed",
  skillRootCount: 1,
  commandRootCount: 0,
  mcpServerNames: [],
};
const service = {
  listPlugins: async () => {
    calls.list++;
    if (failure === "list" || failure === "both") throw new Error("fixture list unavailable");
    return { plugins: [plugin], diagnostics: [] };
  },
  getPluginsOverview: async () => {
    calls.overview++;
    if (failure === "overview" || failure === "both")
      throw new Error("fixture overview unavailable");
    return {
      marketplaces: [{ id: "fixture", name: "Fixture", source: {}, pluginCount: 2 }],
      availablePlugins: [{ id: "available@fixture", name: "available", marketplace: "fixture" }],
      installedPlugins: [
        {
          ...plugin,
          installPath: plugin.rootPath,
          installedAt: "2026-01-01T00:00:00Z",
          scope: "user",
          version: "1.0.0",
        },
      ],
      restorableBuiltins: [],
      diagnostics: [],
    };
  },
} as unknown as IPluginManagementService;
const store = createPluginManagementStore(service);
const initialize = () =>
  store.getState().initialize({ workspacePath: "/fixture", pluginService: service });
await initialize();
function Fixture() {
  const state = store();
  const items = buildStoreItems(state);
  return (
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <TooltipProvider>
        <main className="min-h-screen space-y-4 bg-background p-4 text-ui-base text-foreground">
          <Button
            data-testid="recover"
            onClick={() => {
              failure = null;
              void initialize();
            }}
          >
            Retry
          </Button>
          {state.error && (
            <div role="alert" className="text-destructive">
              {state.error}
            </div>
          )}
          <output data-testid="state">
            {JSON.stringify({
              calls,
              plugins: state.plugins.length,
              marketplaces: state.marketplaces.length,
              available: state.availablePlugins.length,
              known: state.marketplaceAvailabilityKnown,
              orphaned: items.some((item) => item.orphaned),
            })}
          </output>
          <div className="grid gap-4 lg:grid-cols-2">
            {items.map((item) => (
              <PluginStoreCard
                key={item.id}
                item={item}
                actions={{
                  ...state,
                  onOpenDetail() {},
                  onInstall() {},
                  onUninstall() {},
                  onUpdate() {},
                }}
              />
            ))}
          </div>
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
