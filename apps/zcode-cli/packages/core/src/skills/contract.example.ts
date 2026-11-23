/**
 * skill-live-catalog 标准调用示例：普通输入准备时，按当前快照与有效历史收集一条增量。
 */
import type { SkillLoadOutcome } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import { collectSkillsListingAttachment } from "./listing.js";

export function exampleSkillLiveCatalog(
  catalog: SkillLoadOutcome,
  history: readonly RuntimeMessageEntry[],
  tools: readonly { name: string }[],
) {
  // 没有新行时返回 undefined；有新行时调用方先持久化，再提交到历史。
  return collectSkillsListingAttachment({ outcome: catalog, entries: history, tools });
}
