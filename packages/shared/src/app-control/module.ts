export const appControlProtocolModule = {
  id: "app-control-protocol",
  requires: ["session-control"],
  provides: ["app-control-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
