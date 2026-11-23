export const moduleDefinition = {
  id: "managed-worktree-shared",
  requires: ["shared"],
  provides: ["managed-worktree-layout", "workspace-hook-trust-identity"],
} as const;
