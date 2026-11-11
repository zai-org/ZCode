/**
 * voice-input 模块清单（architecture-governance managed 模块）。
 * 层：contract < domain（失败分类纯函数）< adapters（麦克风 PCM 采集）< ui（hook 与组件）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const voiceInputModule = {
  id: "voice-input",
  requires: ["services", "shared", "ui"],
  provides: ["voice-input"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
