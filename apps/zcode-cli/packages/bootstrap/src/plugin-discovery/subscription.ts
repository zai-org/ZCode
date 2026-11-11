import type { ConversationDelta, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

type Pending = ConversationSnapshot["pendingInteractions"];

// 旧客户端严格解析交互 kind；只裁剪该连接的载荷，保留原序号和其他交互。
function visibleInteractions(all: Pending, supported: boolean): Pending {
  return supported || !all.some((item) => item.kind === "pluginInstall")
    ? all
    : all.filter((item) => item.kind !== "pluginInstall");
}
export function pluginInstallSnapshotForConnection(
  snapshot: ConversationSnapshot,
  supported: boolean,
): ConversationSnapshot {
  const pendingInteractions = visibleInteractions(snapshot.pendingInteractions, supported);
  return pendingInteractions === snapshot.pendingInteractions
    ? snapshot
    : { ...snapshot, pendingInteractions };
}
export function pluginInstallDeltasForConnection(
  deltas: readonly ConversationDelta[],
  supported: boolean,
): readonly ConversationDelta[] {
  if (supported) return deltas;
  return deltas.map((delta) => {
    if (delta.op !== "state.updated" || !delta.patch.pendingInteractions) return delta;
    const pendingInteractions = visibleInteractions(delta.patch.pendingInteractions, false);
    return pendingInteractions === delta.patch.pendingInteractions
      ? delta
      : { ...delta, patch: { ...delta.patch, pendingInteractions } };
  });
}
