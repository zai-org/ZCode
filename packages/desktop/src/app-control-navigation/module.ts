export const appControlNavigationModule = {
  id: "app-control-navigation",
  requires: ["app-control", "shared", "desktop", "services"],
  provides: ["app-control-navigation"],
  publicEntrypoints: ["contract.ts", "index.ts", "host.ts", "main.ts", "renderer.ts"],
} as const;
