import { createHash } from "node:crypto";
import type { SkillLoadOutcome } from "@zcode/contracts";
import type { SkillsListingDelta } from "./listing-metadata.js";
import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "../agent/message-history.js";
import {
  buildSkillsContent,
  DEFAULT_SKILL_METADATA_BUDGET,
  formatSkillLine,
  skillDisplayName,
  sortSkillsForListing,
} from "../context/sections/skills.js";

const SKILL_TOOL_NAME = "Skill";
const FINGERPRINT_LENGTH = 16;

/**
 * skill 列表只追加增量（docs/skills-live-catalog.md）：从有效历史回放已公告的整行指纹，
 * 当前目录里指纹没公告过的行进入本次公告。删除不通知；内容变化产生新指纹，在同一头部下重发。
 * 修复前列表只发一次、冷恢复按当前目录原位改写，打开的会话看不到新 skill，改写还让 prompt cache 失效。
 */
export function collectSkillsListingAttachment(input: {
  outcome: SkillLoadOutcome | undefined;
  entries: readonly RuntimeMessageEntry[];
  tools: readonly { name: string }[];
  metadataBudget?: number;
}): RuntimeAttachmentEntry | undefined {
  if (!input.outcome || input.outcome.skills.length === 0) return undefined;
  if (!input.tools.some((tool) => tool.name === SKILL_TOOL_NAME)) return undefined;
  const announced = new Set<string>();
  for (const entry of input.entries) {
    if (entry.kind !== "attachment" || entry.metadata.source !== "skills_listing") continue;
    // 写入与恢复边界已校验并复制 delta；没有 delta 的旧记录不计入，升级后补一次完整列表。
    for (const fingerprint of entry.metadata.skillsListingDelta?.fingerprints ?? [])
      announced.add(fingerprint);
  }
  const pending = sortSkillsForListing(input.outcome.skills)
    .map((skill) => ({ skill, fingerprint: fingerprintOf(formatSkillLine(skill)) }))
    .filter(({ fingerprint }) => !announced.has(fingerprint));
  if (pending.length === 0) return undefined;
  // 恢复要求指纹唯一；两行完全相同时只公告一次，否则这条记录恢复时被判为非法、反复重发。
  const batch = [...new Map(pending.map((item) => [item.fingerprint, item])).values()];
  const delta: SkillsListingDelta = {
    names: batch.map(({ skill }) => skillDisplayName(skill)),
    fingerprints: batch.map(({ fingerprint }) => fingerprint),
  };
  return {
    kind: "attachment",
    content: buildSkillsContent(
      batch.map(({ skill }) => skill),
      input.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
    ),
    metadata: { source: "skills_listing", skillsListingDelta: delta },
  };
}

function fingerprintOf(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
