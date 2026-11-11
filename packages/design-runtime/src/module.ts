export const designRuntimeModule = {
  id: "design-runtime",
  requires: [],
  provides: ["design-runtime-script", "design-runtime-messages"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
