/**
 * cli-session-execution 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliSessionExecutionModule = {
  id: "cli-session-execution",
  requires: ["shared", "zcode-cli"],
  provides: ["cli-session-execution"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "../../../core/src/runtime/permission-full-access.ts",
  ],
} as const;
