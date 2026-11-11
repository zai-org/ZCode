export * from "./contract.js";
export { createManagedWorktreeService } from "./service.js";
export type { ManagedWorktreeCommand, ManagedWorktreeServicePorts } from "./ports.js";
export {
  createWorktreeRemovalGate,
  WORKTREE_REMOVING_ERROR,
  type WorktreeRemovalGate,
} from "./removal-gate.js";
