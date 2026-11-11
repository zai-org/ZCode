import type { MessageWithParts, SessionEvent, SessionInfo } from "@zcode/contracts";
import { projectActiveSessionMessages } from "./index.js";

/** 读取方先取持久消息、会话行与 rewind 事件，再投影 active 分支。 */
export function readActiveBranchExample(
  messages: MessageWithParts[],
  session: SessionInfo | null,
  rewindEvents: SessionEvent[],
): MessageWithParts[] {
  return projectActiveSessionMessages(messages, session, rewindEvents);
}
