import { describe, expect, it } from "vitest";
import type { SkillMetadata } from "@zcode/contracts";
import { collectSkillsListingAttachment } from "../src/skills/listing.js";
import { parseSkillsListingDelta } from "../src/skills/listing-metadata.js";
import {
  cloneRuntimeMessageMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";

const skill = (name: string, description = `${name} skill`): SkillMetadata => ({
  name,
  description,
  path: `/skills/${name}/SKILL.md`,
  directory: `/skills/${name}`,
  rootPath: "/skills",
  scope: "user",
  source: "zcode",
  safeToAutoLoad: true,
  frontmatterKeys: ["name", "description"],
});

const collect = (
  skills: SkillMetadata[],
  entries: readonly RuntimeMessageEntry[] = [],
  options: { tools?: { name: string }[]; budget?: number } = {},
) =>
  collectSkillsListingAttachment({
    outcome: { skills, diagnostics: [], totalDiscovered: skills.length },
    entries,
    tools: options.tools ?? [{ name: "Skill" }],
    metadataBudget: options.budget,
  });

describe("skills listing delta", () => {
  it("keeps the first listing byte-identical to the former full listing", () => {
    const skills = [skill("beta"), skill("alpha")];
    const entry = collect(skills)!;
    // 字面量锁定字节：改为增量前 builder 渲染的完整列表就是这段文字。
    expect(entry.content).toBe(
      "The following skills are available for use with the Skill tool:\n\n" +
        "- alpha: alpha skill (file: /skills/alpha/SKILL.md)\n" +
        "- beta: beta skill (file: /skills/beta/SKILL.md)",
    );
    expect(entry.metadata.source).toBe("skills_listing");
    expect(entry.metadata.skillsListingDelta?.names).toEqual(["alpha", "beta"]);
    expect(entry.metadata.skillsListingDelta?.fingerprints).toHaveLength(2);
    expect(collect(skills, [entry])).toBeUndefined();
    expect(collect([])).toBeUndefined();
    expect(collect(skills, [], { tools: [{ name: "Read" }] })).toBeUndefined();
  });

  it("announces only new or changed lines and nothing for a removal", () => {
    const initial = collect([skill("alpha"), skill("beta")])!;
    const added = collect([skill("alpha"), skill("beta"), skill("gamma")], [initial])!;
    expect(added.content).toBe(
      "The following skills are available for use with the Skill tool:\n\n" +
        "- gamma: gamma skill (file: /skills/gamma/SKILL.md)",
    );
    expect(added.metadata.skillsListingDelta?.names).toEqual(["gamma"]);
    // 删除不发通知；用相同内容恢复也不重发。
    expect(collect([skill("alpha")], [initial, added])).toBeUndefined();
    expect(collect([skill("alpha"), skill("beta")], [initial, added])).toBeUndefined();
    const changed = collect([skill("alpha", "new text"), skill("beta")], [initial, added])!;
    expect(changed.metadata.skillsListingDelta?.names).toEqual(["alpha"]);
    expect(changed.content).toContain("- alpha: new text");
  });

  it("degrades a batch over budget to names without re-announcing it later", () => {
    const skills = [skill("alpha", "x".repeat(200)), skill("beta", "y".repeat(200))];
    const entry = collect(skills, [], { budget: 200 })!;
    expect(entry.content).toContain("- alpha (file: /skills/alpha/SKILL.md)");
    expect(entry.content).not.toContain("xxx");
    // 指纹按完整格式计算：之后预算变大也不重发同一批 skill。
    expect(collect(skills, [entry])).toBeUndefined();
  });

  it("replays only the kept history and treats legacy or malformed records as unannounced", () => {
    const initial = collect([skill("alpha")])!;
    const added = collect([skill("alpha"), skill("beta")], [initial])!;
    // compact 只保留后一条：补发缺失的行，不重复保留段已有的行。
    expect(
      collect([skill("alpha"), skill("beta")], [added])?.metadata.skillsListingDelta?.names,
    ).toEqual(["alpha"]);
    const legacy = systemReminderAttachmentEntry("skills_listing", initial.content);
    expect(collect([skill("alpha")], [legacy])?.metadata.skillsListingDelta?.names).toEqual([
      "alpha",
    ]);
    const malformed: RuntimeMessageEntry = {
      ...initial,
      metadata: {
        source: "skills_listing",
        skillsListingDelta: { names: ["a"], fingerprints: [] },
      },
    };
    const cloned = cloneRuntimeMessageMetadata(malformed.metadata);
    expect(cloned?.skillsListingDelta).toBeUndefined();
    expect(parseSkillsListingDelta({ names: ["a"], fingerprints: [1] })).toBeUndefined();
    expect(parseSkillsListingDelta(initial.metadata.skillsListingDelta)).toEqual(
      initial.metadata.skillsListingDelta,
    );
  });
});
