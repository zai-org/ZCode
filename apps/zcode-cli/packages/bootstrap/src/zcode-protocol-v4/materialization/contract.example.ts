import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { conversationWireSnapshot, measureConversationSnapshotBytes } from "./index.js";

export function measureWireExample(snapshot: ConversationSnapshot): number {
  return measureConversationSnapshotBytes(conversationWireSnapshot(snapshot), {
    topic: `conversation/${snapshot.sessionId}`,
    logEpoch: snapshot.logEpoch,
  });
}
