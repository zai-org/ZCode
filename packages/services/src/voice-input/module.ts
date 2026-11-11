/**
 * voice-input-service 模块清单（architecture-governance managed 模块）。
 * 层：adapters（HTTP + WebSocket IO）。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const voiceInputServiceModule = {
  id: "voice-input-service",
  requires: ["services", "shared", "rpc"],
  provides: ["voice-input-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
