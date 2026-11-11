import {
  type OperationSnapshot,
  type OperationStatus,
} from "#session-control/contract/observation";

export function isOperationSettled(status: OperationStatus): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "needs_attention"
  );
}
export function isWaitSatisfied(
  snapshots: readonly OperationSnapshot[],
  mode: "any" | "all",
): boolean {
  return (
    snapshots.length > 0 &&
    (mode === "any"
      ? snapshots.some((value) => isOperationSettled(value.status))
      : snapshots.every((value) => isOperationSettled(value.status)))
  );
}
