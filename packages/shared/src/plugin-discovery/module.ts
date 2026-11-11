export const pluginInstallInteractionModule = {
  id: "plugin-install-interaction",
  requires: ["shared", "ui"],
  provides: ["plugin-install-interaction"],
  publicEntrypoints: ["contract.ts"],
} as const;
