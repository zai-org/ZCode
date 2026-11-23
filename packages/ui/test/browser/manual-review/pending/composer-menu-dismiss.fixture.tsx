import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { createPluginUiPagePlane } from "@/plugin-ui/adapters/pluginUiPagePlane.js";
import {
  SidePaneFullViewConversationHost,
  useConversationPanePresentation,
} from "@/side-pane-full-view/index.js";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className = `theme-zai-${params.get("theme") ?? "light"}`;
const groups = [
  {
    key: "a",
    label: "Provider A",
    items: [
      { key: "one", value: "one", name: "Model One" },
      { key: "two", value: "two", name: "Model Two" },
      { key: "locked", value: "locked", name: "Locked Model" },
    ],
  },
  { key: "b", label: "Provider B", items: [{ key: "three", value: "three", name: "Model Three" }] },
];

function Composer() {
  const [model, setModel] = useState("one");
  const [effort, setEffort] = useState("high");
  const { reportComposerDockHeight } = useConversationPanePresentation();
  useEffect(() => reportComposerDockHeight(56), [reportComposerDockHeight]);
  return (
    <div
      data-v4-composer-dock
      className="absolute inset-x-0 bottom-0 flex h-14 items-center gap-2 rounded-2xl bg-background p-2"
    >
      <input data-testid="v4-composer-input" aria-label="Message" className="min-w-0 flex-1" />
      <ModelConfigSelect
        modelGroups={groups}
        normalizedValue={model}
        triggerLabel={groups.flatMap((g) => g.items).find((item) => item.value === model)!.name}
        showManageModelsAction={false}
        lockReasonMessage="Unavailable"
        isItemLocked={(value) => value === "locked"}
        onValueChange={setModel}
        composerOptions={{
          providerLabel: "Provider",
          modelsLabel: params.get("locale") === "zh-CN" ? "模型" : "Models",
          effortLabel: "Effort",
          selectModelLabel: "Select model",
          levels: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          value: effort,
          onValueChange: setEffort,
        }}
      />
      <output data-testid="selection" hidden>
        {model}
      </output>
    </div>
  );
}

function Fixture() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!slot || !params.has("electron")) return;
    // 使用真实插件承载层与 webview；只替换插件资源，避免安装和 Agent 请求干扰菜单事件证据。
    const plane = createPluginUiPagePlane({ onVisibility() {}, onCrash() {} });
    const unbind = plane.bind({ node: slot, kind: "sidebar", container: slot });
    plane.mount({
      sandboxId: "menu-dismiss",
      initId: 1,
      partition: "menu-dismiss",
      shellUrl: `${location.origin}/guest`,
    } as PluginSandboxHandle);
    return () => {
      plane.dispose();
      unbind();
    };
  }, [slot]);
  return (
    <main className="h-screen bg-background text-foreground">
      <div ref={setSlot} data-testid="plugin-slot" style={{ position: "absolute", inset: 16 }}>
        {!params.has("electron") && (
          <iframe
            title="Plugin"
            src="/guest"
            className="size-full border-0"
            style={{ pointerEvents: "auto" }}
          />
        )}
      </div>
      {params.has("electron") ? (
        <SidePaneFullViewConversationHost
          mode="floating"
          floating="collapsed"
          anchor="bottom-right"
          slotElement={slot}
          onFloatingChange={() => {}}
          onAnchorChange={() => {}}
          onOpenConversation={() => {}}
        >
          <Composer />
        </SidePaneFullViewConversationHost>
      ) : (
        <div style={{ position: "fixed", left: 16, right: 16, bottom: 16, height: 56 }}>
          <Composer />
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
