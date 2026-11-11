/**
 * context-composition 模块清单（architecture-governance managed 模块）。
 * 范围：context 组成的 v4 线格式（本目录）、CLI 侧分类/预演/修订号/协议处理、App 侧查询与通知。
 * 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const contextCompositionModule = {
  id: "context-composition",
  requires: ["rpc", "services", "shared", "tool-discovery", "zcode-cli"],
  provides: ["context-composition"],
  publicEntrypoints: [
    "contract.ts",
    "../../../../../apps/zcode-cli/packages/core/src/runtime/context-composition/index.ts",
    "../../../../../apps/zcode-cli/packages/core/src/runtime/context-composition/state.ts",
    "../../../../../apps/zcode-cli/packages/core/src/runtime/context-composition/query.ts",
    "../../../../../apps/zcode-cli/packages/core/src/runtime/context-composition/classifier.ts",
    "../../../../../apps/zcode-cli/packages/core/src/runtime/context-composition/items.ts",
    "../../../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/context-composition/index.ts",
    "../../../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/context-composition/tracker.ts",
    "../../../../services/src/zcode-agent/contextCompositionClient.ts",
  ],
} as const;
