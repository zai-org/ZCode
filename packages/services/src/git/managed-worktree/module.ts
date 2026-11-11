export const moduleDefinition = {
  id: "managed-worktree-repo",
  requires: ["shared", "services", "managed-worktree-shared"],
  provides: ["git-worktree-repo"],
} as const;
