export const moduleDefinition = {
  id: "managed-worktree-tasks",
  requires: [
    "shared",
    "services",
    "project-storage",
    "managed-worktree-shared",
    "managed-worktree-repo",
    "rpc",
  ],
  provides: ["managed-worktree-service"],
} as const;
