export const appControlModule = {
  id: "app-control",
  requires: [
    "session-control",
    "shared",
    "services",
    "session",
    "project",
    "provider",
    "project-storage",
    "remote-projects",
  ],
  provides: ["app-control"],
  publicEntrypoints: ["index.ts", "contract.ts", "discovery-directory.ts"],
} as const;
