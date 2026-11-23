import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  type ModelRequest,
  type SkillPort,
} from "@zcode/contracts";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

// DWG-09 的装配层一半（docs/dynamic-workflow/launch.md「On demand: activation」）：`/workflow` 的展开处
// （create-app.ts 的 builtin prompt resolver）就是激活点，先于 executeTurn，所以敲命令那一轮的首个模型
// 请求就带着十个工具；prose 请求不是触发器。

function toolNames(request: ModelRequest | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name);
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const SKILL_CONTENT_OPEN_TAG = "<skill_content";
const WORKFLOW_COMMAND_TEXT = "/workflow";

/** 让下一次模型应答调 `Skill(dynamic-workflows)`；返回这次调用的 id。 */
function scriptWorkflowSkillCall(script: unknown[], id: string): string {
  script.push({
    finishReason: "tool-calls",
    text: "",
    usage: USAGE,
    toolCalls: [{ id, name: "Skill", input: { skill: DYNAMIC_WORKFLOW_SKILL_NAME } }],
  });
  return id;
}

/** 模型在后续请求里看到的那条 Skill 工具结果的正文。 */
function skillResultText(request: ModelRequest | undefined, toolCallId: string): string {
  const message = (request?.messages ?? []).find(
    (candidate) => candidate.role === "tool" && candidate.toolCallId === toolCallId,
  );
  expect(message, `tool result ${toolCallId}`).toBeDefined();
  const content = message?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** `<skill_content>` 之前的部分：未激活提示只可能出现在这里。 */
function skillResultPreamble(text: string): string {
  const index = text.indexOf(SKILL_CONTENT_OPEN_TAG);
  expect(index, "skill content wrapper").toBeGreaterThanOrEqual(0);
  return text.slice(0, index);
}

const WORKFLOW_SKILL_METADATA = {
  name: DYNAMIC_WORKFLOW_SKILL_NAME,
  description: "Use when writing a dynamic-workflow script",
  path: "/skills/dynamic-workflows/SKILL.md",
  directory: "/skills/dynamic-workflows",
  rootPath: "/skills",
  scope: "project",
  source: "zcode",
  safeToAutoLoad: true,
  frontmatterKeys: ["name", "description"],
  policy: { allowImplicitInvocation: true },
};

/** 只认 `dynamic-workflows` 的技能端口：`/expert` 子会话默认的技能来源不含内置技能目录，测试里显式给它。 */
const WORKFLOW_SKILL_PORT: SkillPort = {
  async discoverSkills() {
    return { skills: [WORKFLOW_SKILL_METADATA], diagnostics: [] } as never;
  },
  async loadSkill() {
    return {
      metadata: WORKFLOW_SKILL_METADATA,
      content: "workflow authoring body",
      baseDirectory: "/skills/dynamic-workflows",
      bytesRead: 23,
      sizeBytes: 23,
      truncated: false,
    } as never;
  },
};

async function withApp(
  runtimeConfig: Record<string, unknown>,
  run: (input: {
    app: Awaited<ReturnType<typeof createZCodeApp>>;
    requests: ModelRequest[];
    /** 预置的模型应答，先进先出；用完后回到固定的 "ok"。 */
    script: unknown[];
    sessionStore: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  }) => Promise<void>,
  options: { skillPort?: SkillPort } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-dwf-on-demand-"));
  const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  const requests: ModelRequest[] = [];
  const script: unknown[] = [];
  try {
    const app = await createZCodeApp({
      env: {},
      modelExecutor: {
        async generateText(request) {
          requests.push(request);
          const scripted = script.shift();
          if (scripted !== undefined) return scripted as never;
          return { finishReason: "stop", text: "ok", usage: USAGE } as never;
        },
      },
      runtimeConfig: { workingDirectory: root, ...runtimeConfig },
      sessionStore,
      skipUserConfig: true,
      ...(options.skillPort ? { skillPort: options.skillPort } : {}),
    });
    try {
      await run({ app, requests, script, sessionStore });
    } finally {
      await app.close();
    }
  } finally {
    sessionStore.close();
    await rm(root, { force: true, recursive: true });
  }
}

describe("onDemand：`/workflow` 经输入门面激活工具面（DWG-09）", () => {
  it("激活前没有工作流工具，prose 请求不激活；`/workflow` 那一轮的首个请求就带上，并落 entry", async () => {
    await withApp(
      { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true },
      async ({ app, requests, sessionStore }) => {
        await app.submitPrompt("hello");
        expect(toolNames(requests.at(-1))).not.toContain(CREATE_WORKFLOW_TOOL_NAME);
        // 反向断言：普通工具面完整，只差工作流那十个。
        expect(toolNames(requests.at(-1))).toContain("Read");

        await app.submitPrompt("use a workflow to ship it");
        expect(toolNames(requests.at(-1))).not.toContain(CREATE_WORKFLOW_TOOL_NAME);

        await app.submitPrompt("/workflow ship it");
        const workflowRequest = requests.at(-1);
        expect(toolNames(workflowRequest)).toContain(CREATE_WORKFLOW_TOOL_NAME);
        // 展开后的命令正文到了模型手里（不是原文 "/workflow ship it" 当普通 prompt）。
        expect(JSON.stringify(workflowRequest)).toContain("Required skills");
        expect(JSON.stringify(workflowRequest)).toContain("ship it");

        const entries = await sessionStore.sessionEntries?.({
          sessionID: app.sessionId,
          type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
        });
        expect(entries).toHaveLength(1);
        expect(entries?.[0]?.data).toEqual({ activated: true, source: "command" });

        // 之后的轮次保持。
        await app.submitPrompt("thanks");
        expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
      },
    );
  });

  it("首轮就是 `/workflow`：激活先于会话落盘，entry 由首次持久化补写", async () => {
    await withApp(
      { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true },
      async ({ app, requests, sessionStore }) => {
        await app.submitPrompt("/workflow ship it");
        expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
        const entries = await sessionStore.sessionEntries?.({
          sessionID: app.sessionId,
          type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
        });
        expect(entries).toHaveLength(1);
      },
    );
  });

  it("alwaysOn（只有布尔）从首个请求起就带工具，且不写激活 entry", async () => {
    await withApp({ dynamicWorkflowEnabled: true }, async ({ app, requests, sessionStore }) => {
      await app.submitPrompt("hello");
      expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
      const entries = await sessionStore.sessionEntries?.({
        sessionID: app.sessionId,
        type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
      });
      expect(entries ?? []).toHaveLength(0);
    });
  });

  // 2026-11：onDemand 未激活时模型仍看得到 `dynamic-workflows` 技能，读完正文被要求调 CreateWorkflow，
  // 而那十个工具没有注册。Skill 工具结果在这一刻带一段提示，让模型请用户发 `/workflow`。
  it("未激活时 Skill(dynamic-workflows) 的结果带 `/workflow` 提示，且不激活；激活后再加载不带", async () => {
    await withApp(
      { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true },
      async ({ app, requests, script }) => {
        const deferredCallId = scriptWorkflowSkillCall(script, "skill-deferred");
        await app.submitPrompt("use a workflow to ship it");
        const deferred = skillResultText(requests.at(-1), deferredCallId);
        expect(skillResultPreamble(deferred)).toContain(WORKFLOW_COMMAND_TEXT);
        // prose 请求 + 加载技能都不是触发器：工具面保持原样。
        expect(toolNames(requests.at(-1))).not.toContain(CREATE_WORKFLOW_TOOL_NAME);

        const activatedCallId = scriptWorkflowSkillCall(script, "skill-activated");
        await app.submitPrompt("/workflow ship it");
        expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
        const activated = skillResultText(requests.at(-1), activatedCallId);
        expect(skillResultPreamble(activated)).toBe("");
      },
    );
  });

  // 评审 CR-01 第二轮：`/expert` 子会话（workflow_child）整份展开父配置，onDemand 下出生未激活，又没有
  // `/workflow` 入口。它加载这份技能时拿到的必须是子会话版本的提示，且 CreateWorkflow 仍然不可用。
  it("onDemand 下 /expert 子会话加载该技能：提示让它报告父代理，不承诺本会话激活", async () => {
    await withApp(
      { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true },
      async ({ app, requests, script }) => {
        const callId = scriptWorkflowSkillCall(script, "skill-expert-child");
        // 流程能不能走完不是这里要验的：只要子会话发过带着这条工具结果的请求即可。
        await app.runExpertWorkflow({ task: "use a workflow" }).catch(() => undefined);
        const withResult = requests.find((request) =>
          (request.messages ?? []).some(
            (message) => message.role === "tool" && message.toolCallId === callId,
          ),
        );
        const preamble = skillResultPreamble(skillResultText(withResult, callId));
        expect(preamble).toMatch(/parent agent/i);
        expect(preamble).toMatch(/will not become available/i);
        expect(preamble).not.toMatch(/tell the user/i);
        expect(preamble).not.toMatch(/the tools appear after that/i);
        // 提示不为兑现自己而放宽权限：子会话的工具面里仍然没有 CreateWorkflow。
        expect(toolNames(withResult)).toContain("Skill");
        expect(toolNames(withResult)).not.toContain(CREATE_WORKFLOW_TOOL_NAME);
      },
      { skillPort: WORKFLOW_SKILL_PORT },
    );
  });

  it("alwaysOn：Skill(dynamic-workflows) 的结果不带提示", async () => {
    await withApp({ dynamicWorkflowEnabled: true }, async ({ app, requests, script }) => {
      const callId = scriptWorkflowSkillCall(script, "skill-always-on");
      await app.submitPrompt("use a workflow to ship it");
      expect(skillResultPreamble(skillResultText(requests.at(-1), callId))).toBe("");
    });
  });
});
