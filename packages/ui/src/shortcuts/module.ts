/**
 * shortcuts 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 公开入口沿用登记前已被各处直接引用的文件，登记时不改动调用方。
 */
export const shortcutsModule = {
  id: "shortcuts",
  requires: ["shared", "ui"],
  provides: ["shortcuts"],
  publicEntrypoints: [
    "contract.ts",
    "bindings.ts",
    "conflicts.ts",
    "label.ts",
    "useShortcutBindings.ts",
    "composerShortcuts.ts",
  ],
} as const;
