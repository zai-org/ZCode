/**
 * bash-cmd-readonly-policy 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const bashCmdReadonlyPolicyModule = {
  id: "bash-cmd-readonly-policy",
  requires: ["zcode-cli"],
  provides: ["bash-cmd-readonly-policy"],
  publicEntrypoints: ["../handlers/bash-cmd-readonly-policy.ts", "contract.ts"],
} as const;
