import {
  applyContributionMessage,
  resolvePluginManifest,
  validateExtensionManifest,
  type ContributionSnapshot,
} from "#src/extension-host/contract.js";

// 清单两步校验：新版本插件装在旧宿主上得到 incompatible，而不是 invalid。
export const incompatibleExample = validateExtensionManifest({
  engines: { zcode: "^2.0.0" },
  unknownField: true,
});

export const invalidExample = validateExtensionManifest({
  engines: { zcode: "^1.0.0" },
  contributes: { commands: [{ id: "open", titel: "typo" }] },
});

// Window Host 读到 plugin.json 后生成静态表的一项与扩展声明：顶层 slots 的条目用 target 指向打开对象；
// 未知插槽 id 只记诊断，引用未声明视图的条目只让该条目不可用。
export const staticEntryExample = resolvePluginManifest(
  { pluginId: "demo@local", name: "demo", rootPath: "/Users/dev/plugins/demo" },
  {
    status: "ok",
    manifest: {
      name: "demo",
      extension: {
        engines: { zcode: "^1.0.0" },
        main: "./dist/extension.js",
        contributes: { views: [{ id: "panel", title: "Demo" }] },
      },
      slots: {
        "sidePane.launcher": [
          { id: "open-panel", target: { view: "panel" } },
          { id: "broken", target: { view: "missing" } },
        ],
        "future.slot": [{ id: "later", target: { view: "panel" } }],
      },
    },
  },
);

// 接收方只持最近快照：增量 rev 必须更大且同 gen，否则丢弃（返回 null）。
const base: ContributionSnapshot = {
  kind: "snapshot",
  gen: 1,
  rev: 1,
  extensions: [{ pluginId: "demo@local", state: "active" }],
  values: {},
};
export const afterDelta = applyContributionMessage(base, {
  kind: "delta",
  gen: 1,
  rev: 2,
  itemId: "demo@local/status",
  scopeKey: "app",
  value: { text: "ready" },
});
