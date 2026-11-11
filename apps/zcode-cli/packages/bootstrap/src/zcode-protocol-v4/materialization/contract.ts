import type { SessionEvent } from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "../product-projection.js";

export interface CandidateHydrationInput {
  /** 只能传尚未发布的候选，不得传 publisher 当前权威投影。 */
  projection: ProductProjection;
  events: readonly SessionEvent[];
  initialBytesUpperBound: number;
  measureWireSnapshot(snapshot: ConversationSnapshot): number;
}

/** null 表示候选不满足上限；调用方必须丢弃候选并重新严格重放。 */
export type CandidateHydrationResult = number | null;

export interface ConversationWireIdentity {
  topic: string;
  logEpoch: string;
}

export interface ConversationInputAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
}
