// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const webRemoteControlModule = {
  id: "web-remote-control",
  requires: ["client", "mobile-ui", "shared", "ui", "web", "web-auth", "web-remote-relay"],
  provides: ["web-remote-control"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "views.ts",
    "adapters/webRemoteControlThemeSeed.ts",
  ],
} as const;
