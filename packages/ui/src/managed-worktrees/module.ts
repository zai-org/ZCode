export const moduleDefinition = {
  id: "managed-worktree-ui",
  requires: ["services", "shared", "ui", "conversation-user-input-presentation"],
  provides: ["worktree-run-location", "fork-destination", "managed-worktree-descriptor"],
} as const;
