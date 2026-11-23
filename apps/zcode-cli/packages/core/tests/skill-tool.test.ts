import { describe, expect, it } from "vitest";
import {
  createSessionId,
  createTraceId,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  SkillNotFoundError,
} from "@zcode/contracts";
import type { SkillContent, SkillLoadOutcome, SkillLoadRequest, SkillPort } from "@zcode/contracts";
import { createContextBuilder } from "../src/context/index.js";
import { collectSkillsListingAttachment } from "../src/skills/listing.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE,
  DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE,
  SKILL_RESULT_WRAPPER_BYTES,
  skillHandler,
  skillToolEntry,
  WORKFLOW_SKILL_MAX_BYTES,
} from "../src/tool/handlers/skill.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type {
  DynamicWorkflowToolSurfaceDeferral,
  ToolExecutionContext,
} from "../src/tool/types.js";

const skillOutcome: SkillLoadOutcome = {
  skills: [
    {
      name: "demo-skill",
      description: "Use this for demo workflows",
      path: "/workspace/.zcode/skills/demo-skill/SKILL.md",
      directory: "/workspace/.zcode/skills/demo-skill",
      rootPath: "/workspace/.zcode/skills",
      scope: "project",
      source: "zcode",
      safeToAutoLoad: true,
      frontmatterKeys: ["name", "description"],
      policy: { allowImplicitInvocation: true },
    },
  ],
  diagnostics: [],
  totalDiscovered: 1,
};

describe("Skill integration", () => {
  it("renders available skills in context without loading body", () => {
    const builder = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "test",
        shell: "test",
        osVersion: "test",
        nodeVersion: "test",
      },
      skills: skillOutcome,
    });

    const result = builder.build();
    const system =
      result.systemMessages.find((message) => message.role === "system")?.content ?? "";
    // 列表由 skills_listing 收集器渲染，builder 不再输出（docs/skills-live-catalog.md）。
    const skillReminder =
      collectSkillsListingAttachment({
        outcome: skillOutcome,
        entries: [],
        tools: [{ name: "Skill" }],
      })?.content ?? "";

    expect(system).not.toContain("demo-skill");
    expect(skillReminder).toContain("The following skills are available");
    expect(skillReminder).toContain("demo-skill");
  });

  it("loads skill content through SkillPort using the legacy name field", async () => {
    const loaded = await skillHandler(
      { name: "demo-skill" },
      contextWithSkillPort({
        async discoverSkills(): Promise<SkillLoadOutcome> {
          return skillOutcome;
        },
        async loadSkill(): Promise<SkillContent> {
          return {
            metadata: skillOutcome.skills[0]!,
            content: "# Demo Skill\n\nFollow this workflow.",
            baseDirectory: "/workspace/.zcode/skills/demo-skill",
            bytesRead: 37,
            sizeBytes: 37,
            truncated: false,
          };
        },
      }),
    );

    expect(loaded).toContain('<skill_content name="demo-skill">');
    expect(loaded).toContain("Follow this workflow.");
    expect(loaded).toContain("Base directory for this skill");
  });

  it("loads skill content through SkillPort using the provider-visible skill field", async () => {
    const loaded = await skillHandler(
      { skill: "demo-skill" },
      contextWithSkillPort({
        async discoverSkills(): Promise<SkillLoadOutcome> {
          return skillOutcome;
        },
        async loadSkill(): Promise<SkillContent> {
          return {
            metadata: skillOutcome.skills[0]!,
            content:
              "# Demo Skill\n\nRead ${CLAUDE_SKILL_DIR}/references.md and ${ZCODE_SKILL_DIR}/notes.md.",
            baseDirectory: "/workspace/.zcode/skills/demo-skill",
            bytesRead: 91,
            sizeBytes: 91,
            truncated: false,
          };
        },
      }),
    );

    expect(loaded).toContain('<skill_content name="demo-skill">');
    expect(loaded).toContain("/workspace/.zcode/skills/demo-skill/references.md");
    expect(loaded).toContain("/workspace/.zcode/skills/demo-skill/notes.md");
  });

  it("reports resolved skill metadata through the telemetry callback without changing content", async () => {
    const metadata = {
      ...skillOutcome.skills[0]!,
      name: "pptx",
      pluginName: "document-skills",
      pluginId: "document-skills@zcode-plugins-official",
      qualifiedName: "document-skills:pptx",
      source: "plugin" as const,
    };
    const reported: unknown[] = [];
    const loaded = await skillHandler(
      { skill: "document-skills:pptx" },
      contextWithSkillPort(
        {
          async discoverSkills(): Promise<SkillLoadOutcome> {
            return { ...skillOutcome, skills: [metadata] };
          },
          async loadSkill(): Promise<SkillContent> {
            return {
              metadata,
              content: "# PPTX Skill\n\nDescription stays in the skill body.",
              baseDirectory: "/plugins/document-skills/skills/pptx",
              bytesRead: 50,
              sizeBytes: 50,
              truncated: false,
            };
          },
        },
        (value) => reported.push(value),
      ),
    );

    expect(reported).toEqual([
      {
        name: "pptx",
        qualifiedName: "document-skills:pptx",
        pluginId: "document-skills@zcode-plugins-official",
        source: "plugin",
      },
    ]);
    expect(loaded).toContain("Description stays in the skill body.");
  });

  // docs/dynamic-workflow/authoring.md「The skill」：只有工作流技能拿 200 000 字节的上限，其余技能仍是 100 000。
  // 判据是请求里的名字，与技能门认的同一个。
  it("loads dynamic-workflows with its own byte cap and every other skill with the default", async () => {
    const requested: SkillLoadRequest[] = [];
    const port: SkillPort = {
      async discoverSkills(): Promise<SkillLoadOutcome> {
        return skillOutcome;
      },
      async loadSkill(request): Promise<SkillContent> {
        requested.push(request);
        return {
          metadata: { ...skillOutcome.skills[0]!, name: request.name },
          content: "body",
          baseDirectory: "/workspace/.zcode/skills/demo-skill",
          bytesRead: 4,
          sizeBytes: 4,
          truncated: false,
        };
      },
    };

    await skillHandler({ skill: DYNAMIC_WORKFLOW_SKILL_NAME }, contextWithSkillPort(port));
    await skillHandler({ skill: "demo-skill" }, contextWithSkillPort(port));

    expect(requested.map((request) => request.maxBytes)).toEqual([200_000, 100_000]);
  });

  // 结果预算是工具级的静态值：必须装得下最大上限的正文再加外壳，否则贴着上限的技能会被从尾部再截一刀。
  it("gives the tool result room for the largest skill plus its wrapper", () => {
    const ceiling =
      WORKFLOW_SKILL_MAX_BYTES +
      SKILL_RESULT_WRAPPER_BYTES +
      Math.max(
        Buffer.byteLength(DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE, "utf8"),
        Buffer.byteLength(DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE, "utf8"),
      );
    expect(skillToolEntry.metadata.maxOutputBytes).toBeGreaterThanOrEqual(ceiling);
    expect(skillToolEntry.resultBudget.maxInlineBytes).toBeGreaterThanOrEqual(ceiling);
    expect(skillToolEntry.resultBudget.maxModelBytes).toBeGreaterThanOrEqual(ceiling);
  });

  // docs/dynamic-workflow/launch.md「On demand: activation」：onDemand 且未激活时，工作流技能的结果
  // 前面带一段提示，让模型请用户发 `/workflow`。探针三态 + 非该技能。
  describe("工作流工具面未激活的提示", () => {
    const port: SkillPort = {
      async discoverSkills(): Promise<SkillLoadOutcome> {
        return skillOutcome;
      },
      async loadSkill(request): Promise<SkillContent> {
        return {
          metadata: { ...skillOutcome.skills[0]!, name: request.name },
          content: "body",
          baseDirectory: "/workspace/.zcode/skills/demo-skill",
          bytesRead: 4,
          sizeBytes: 4,
          truncated: false,
        };
      },
    };
    const load = (skill: string, deferral?: DynamicWorkflowToolSurfaceDeferral) =>
      skillHandler(
        { skill },
        {
          ...contextWithSkillPort(port),
          ...(deferral === undefined
            ? {}
            : { getDynamicWorkflowToolSurfaceDeferral: () => deferral }),
        },
      );
    /** 取结果里 `<skill_content>` 之前的那段提示。 */
    const noticeOf = (loaded: unknown) => {
      const text = String(loaded);
      return text.slice(0, text.indexOf("<skill_content"));
    };

    it("session：提示排在 <skill_content> 之前，且点名 /workflow", async () => {
      const loaded = String(await load(DYNAMIC_WORKFLOW_SKILL_NAME, "session"));
      expect(loaded.startsWith(`${DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE}\n`)).toBe(true);
      expect(loaded).toContain(`<skill_content name="${DYNAMIC_WORKFLOW_SKILL_NAME}">`);
      expect(loaded.endsWith("</skill_content>")).toBe(true);
    });

    // 评审 SG-01：这三条约束各自独立断言，不拿生产常量去比生产输出。只留「请发 /workflow」而删掉
    // 「别调未注册的工具」或「别用 Agent 顶替」，正是本次修复要避免的行为。
    it.each([
      { deferral: "session" as const, name: "主会话" },
      { deferral: "subagent" as const, name: "子代理" },
    ])("$name 提示：不许调未启用的工具，不许用 Agent 顶替", async ({ deferral }) => {
      const notice = noticeOf(await load(DYNAMIC_WORKFLOW_SKILL_NAME, deferral));
      expect(notice).toMatch(/do not try to call those tools/i);
      expect(notice).toMatch(/do not stand in for a workflow with the Agent tool/i);
      expect(notice).toContain("CreateWorkflow");
    });

    it("session 提示：让模型用用户的语言请用户发 /workflow，并说明之后工具会出现", async () => {
      const notice = noticeOf(await load(DYNAMIC_WORKFLOW_SKILL_NAME, "session"));
      expect(notice).toMatch(/tell the user/i);
      expect(notice).toMatch(/in the user's language/i);
      expect(notice).toContain("`/workflow`");
      expect(notice).toMatch(/in this session/i);
    });

    // 评审 CR-01：子代理没有 /workflow 入口，父会话之后激活也不会改它的工具面。给它的提示不能
    // 让它去请用户发命令，也不能承诺工具会出现在本会话；它该把限制报告给父代理。
    it("subagent 提示：报告给父代理，不承诺本会话会拿到工具", async () => {
      const notice = noticeOf(await load(DYNAMIC_WORKFLOW_SKILL_NAME, "subagent"));
      expect(notice).not.toBe(noticeOf(await load(DYNAMIC_WORKFLOW_SKILL_NAME, "session")));
      expect(notice).toMatch(/parent agent/i);
      expect(notice).toMatch(/will not become available/i);
      // 这段提示也发给 `/expert` 的 workflow 子会话，措辞不能只说「subagent」。
      expect(notice).toMatch(/child agent session/i);
      expect(notice).not.toMatch(/tell the user/i);
      expect(notice).not.toMatch(/the tools appear after that/i);
    });

    it("none（已激活 / alwaysOn）：结果与没有探针时逐字相同", async () => {
      const activated = await load(DYNAMIC_WORKFLOW_SKILL_NAME, "none");
      expect(String(activated).startsWith("<skill_content")).toBe(true);
      expect(activated).toBe(await load(DYNAMIC_WORKFLOW_SKILL_NAME));
    });

    it("探针缺席：不加提示", async () => {
      const loaded = String(await load(DYNAMIC_WORKFLOW_SKILL_NAME));
      expect(loaded.startsWith("<skill_content")).toBe(true);
    });

    it.each(["session", "subagent"] as const)("别的技能：%s 也不加提示", async (deferral) => {
      const loaded = String(await load("demo-skill", deferral));
      expect(loaded.startsWith("<skill_content")).toBe(true);
    });
  });

  it("上报 remote 来源的实际 skill name", async () => {
    const reported: unknown[] = [];
    const metadata = { ...skillOutcome.skills[0]!, source: "remote" as const };
    await skillHandler(
      { skill: "requested-alias" },
      contextWithSkillPort(
        {
          async discoverSkills() {
            return skillOutcome;
          },
          async loadSkill() {
            return {
              metadata,
              content: "body",
              baseDirectory: "/skills",
              bytesRead: 4,
              sizeBytes: 4,
              truncated: false,
            };
          },
        },
        (value) => reported.push(value),
      ),
    );
    expect(reported).toEqual([{ name: "demo-skill", source: "remote" }]);
  });

  it("tells the model an unknown skill name and suggests the closest listed name", async () => {
    const pluginSkill = {
      ...skillOutcome.skills[0]!,
      name: "review",
      qualifiedName: "acme:review",
    };
    const port: SkillPort = {
      async discoverSkills() {
        return { ...skillOutcome, skills: [...skillOutcome.skills, pluginSkill] };
      },
      async loadSkill(request) {
        throw new SkillNotFoundError(request.name);
      },
    };

    await expect(skillHandler({ skill: "missing" }, contextWithSkillPort(port))).resolves.toEqual({
      result: false,
      errorCode: 2,
      message: "Unknown skill: missing",
    });
    await expect(skillHandler({ skill: "demo-skil" }, contextWithSkillPort(port))).resolves.toEqual(
      {
        result: false,
        errorCode: 2,
        message: "Unknown skill: demo-skil. Did you mean demo-skill?",
      },
    );
    await expect(
      skillHandler({ skill: "acme:reveiw" }, contextWithSkillPort(port)),
    ).resolves.toMatchObject({ message: "Unknown skill: acme:reveiw. Did you mean acme:review?" });
    // 目录里有同名项但端口仍找不到（例如读正文时文件刚被删除）：不提示同一个名字。
    await expect(
      skillHandler({ skill: "demo-skill" }, contextWithSkillPort(port)),
    ).resolves.toEqual({
      result: false,
      errorCode: 2,
      message: "Unknown skill: demo-skill",
    });
  });

  it("keeps other skill loading errors as thrown errors", async () => {
    const port: SkillPort = {
      async discoverSkills() {
        return skillOutcome;
      },
      async loadSkill() {
        throw new Error("EACCES: permission denied");
      },
    };

    await expect(skillHandler({ skill: "demo-skill" }, contextWithSkillPort(port))).rejects.toThrow(
      "EACCES: permission denied",
    );
  });

  it("rejects an empty skill name before loading", () => {
    expect(skillToolEntry.validateInput?.({ skill: "  " })).toEqual({
      result: false,
      errorCode: 1,
      message: "Invalid skill format:   ",
    });
    expect(skillToolEntry.validateInput?.({ skill: "demo-skill" })).toEqual({ result: true });
  });

  it("can omit the Skill tool when the runtime has no SkillPort", () => {
    const registry = createToolRegistry();

    registerBuiltInTools(registry, { includeSkill: false });

    expect(registry.has("Read")).toBe(true);
    expect(registry.has("Skill")).toBe(false);
  });
});

function contextWithSkillPort(
  skillPort: SkillPort,
  recordSkillTelemetryMetadata?: ToolExecutionContext["recordSkillTelemetryMetadata"],
): ToolExecutionContext {
  return {
    toolCallId: "tool-skill",
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    skillPort,
    ...(recordSkillTelemetryMetadata ? { recordSkillTelemetryMetadata } : {}),
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: createSessionId("skill-test"),
  };
}
