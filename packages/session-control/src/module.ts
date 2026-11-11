export const sessionControlModule = {
  id: "session-control",
  requires: [],
  provides: ["cli-session-control", "app-session-control"],
  publicEntrypoints: [
    "contract.ts",
    "application/cli/index.ts",
    "application/app/index.ts",
    "testing/index.ts",
  ],
  layers: { contract: "contract", domain: "domain", app: "application" },
} as const;
