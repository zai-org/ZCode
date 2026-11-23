import type { PreinstalledToolsState } from "@zcode/shared/preinstalled-tools";
export const unavailableExample: PreinstalledToolsState = {
  autoInstallEnabled: true,
  tools: [
    {
      agentEnabled: true,
      entryOutOfSync: false,
      toolId: "python",
      displayName: "Python",
      status: "not-installed",
      target: null,
      installed: null,
    },
  ],
};
