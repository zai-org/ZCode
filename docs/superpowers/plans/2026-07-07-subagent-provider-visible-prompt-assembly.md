# Subagent Provider-Visible Prompt Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ZCode subagent child request 的 provider-visible system prompt 组装收敛到统一的普通 subagent 形状，同时保留 `system[0] = "You are ZCode, an interactive coding agent"`；Explore/general-purpose 的 agent-specific body 只以测试中冻结的单一文案为基线。

**Architecture:** 新增一个 subagent 专用 context builder，直接生成 child runtime 的 `ContextBuildResult`，避免先跑主线程 `ContextBuilder` 再覆盖 system messages。Explore、general-purpose、自定义 agent 统一走 `ZCode prefix + agent-specific prompt + common Notes + env/model context`，其中 Explore/general-purpose 的 agent-specific prompt body 只采用单一冻结文案；common Notes 和 env/model context 按 `agentPrompt + common Notes + env/model context` 固定分段，但 env/model context 的数据来源、fallback 和格式化优先复用当前 main runtime/context builder 逻辑。

**Tech Stack:** TypeScript, Vitest, `AgentRuntime`, `MessageHistoryImpl`, provider-visible request capture through mocked `modelAdapter`.

## Global Constraints

- 本计划只处理 subagent provider-visible prompt assembly；不修改父侧 `Agent` tool schema/description、child `tools[]` schema、`SendMessage`、background notification、teammate、worktree isolation、fork/repl hydration。
- `system[0]` 必须保留现有 ZCode 产品前缀：`You are ZCode, an interactive coding agent`。
- 强要求：Explore 和 general-purpose 的 agent-specific prompt body 只使用一套冻结文案（以 `subagent-explore.test.ts` / `subagent-prompt-assembly.test.ts` 的精确断言为准）；不按模型、provider 或渠道引入文案变体，也不混入历史版本或 ZCode 临时实验分支文案。
- Explore/general-purpose body 的标点、换行、操作性措辞都是 provider-visible 验收内容；除 ZCode 产品名替换和 ZCode 当前工具名差异外，不要做“意思差不多”的改写。
- 除 `system[0]` 外，普通 subagent system body 按固定结构组织：agent-specific prompt、common subagent Notes、env/model context；其中 env/model context 的字段值、fallback、shell 展示、git repo 判定、model name 格式化以当前 main runtime/context builder 已有逻辑为准。
- 不硬造当前 main 没有的数据；只有 main 已经能提供或已经 provider-visible 的数据才能进入 subagent env/model context。
- 不新增“你是 subagent”这类额外身份叙事；只保留已有的操作性提示，如 `Agent threads...` 和 `parent agent reads your text output...`。
- Provider-visible request body 是验收面；不要只断言 runtime config 或 helper 返回的中间对象。
- 命名使用本地语义，不在代码标识符、注释、测试名里使用外部产品名。
- 不自动 commit；实现完成后只留下可 review 的工作区变更。

---

## Scope

### In Scope

- child `system` messages 的顺序和内容：
  - `system[0]`: ZCode CLI prefix
  - `system[1]`: agent-specific prompt
  - `system[2]`: common subagent Notes
  - `system[3]`: env/model context
- Explore prompt 中移除内嵌 Notes/env/model context。
- general-purpose 和 custom profile prompt 也追加同一套 common Notes/env/model context。
- child request 不再因为 `systemPrompt` 字符串触发 `ContextBuilder` 的 custom prompt 分支，也不通过 `systemMessages` 后置覆盖主 builder 结果。
- 测试捕获最终 child provider request，断言 `messages.filter(role === "system")` 的精确 shape。
- 执行过程中必须 double check Explore/general-purpose agent-specific body 是否仍与冻结文案一致；如果发现漂移，本轮必须先修正文案，再继续 system message 拆分和组装收敛。

### Out of Scope

- `Agent` tool provider-visible input schema 和 description。
- `Task` runtime alias / provider-visible filtering。
- child tool allowlist / disallowlist / MCP required server 语义。
- `SendMessage` 的 provider-visible schema、result text、child 注入文案。
- background `<task-notification>` 和 idle wake。
- 只读 agent 省略项目指令文件、agent memory、追加 subagent system prompt、fork/repl hydration、teammate/worktree isolation 的完整实现。
- 按模型、provider、渠道、历史版本或实验分支引入 subagent prompt 文案变体。

## Current State Summary

当前路径：

- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
  - 在 `runExploreAgent` 内计算 `systemPrompt: string`。
  - Explore 且 profile `systemPrompt` 为空时调用 `buildExploreSystemPrompt(...)`。
  - child `AgentRuntime` 通过 `systemPrompt` 配置进入 `ContextBuilder`。
- `apps/zcode-cli/packages/core/src/context/builder.ts`
  - `customSystemPrompt` 存在时输出：
    - `system[0] = buildCliPrefixSection()`
    - `system[1] = "\n" + customSystemPrompt`
  - 同时跳过默认 identity/dynamic/env/git/output style system 段。
- `apps/zcode-cli/packages/core/src/subagent/explore.ts`
  - 当前 `buildExploreSystemPrompt(...)` 同时包含 Explore agent prompt、common Notes、env/model context。
- `apps/zcode-cli/packages/core/src/agent/message-history.ts`
  - `MessageHistoryImpl.init(...)` 已支持传入 `Array<ModelInputMessage | RuntimeMessageEntry>`，可直接初始化多段 system messages。
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
  - 当前 `exploreSystemMessages` 断言 `system[0]` 是 ZCode prefix，`system[1]` 是带 leading newline 的整块 Explore prompt。

目标路径：

- `subagent.ts` 不再把 child prompt 作为 `systemPrompt: string` 传入 child runtime。
- 新增 `SubagentContextBuilder` 输出完整 `ContextBuildResult`，其中 `sections`、`systemMessages`、`metaUserAttachments` 都按 subagent 语义生成。
- child runtime 使用新的 `subagentContext` 配置选择 subagent builder；`ensureContextInitialized`、`refreshContextModelSnapshot`、resume/lazy context 统一走同一 builder strategy。

## File Structure

- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
  - 给 `AgentRuntimeConfig` 增加 `subagentContext?: { agentPrompt: string }`，不新增 `systemMessages` 覆盖配置。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
  - `createContextBuilderFromSnapshot(...)` 根据 `config.subagentContext` 创建 `SubagentContextBuilder`，主 runtime 继续创建 main `ContextBuilder`。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
  - 确认 lazy `getContextBuilder()` 也走 `createContextBuilderFromSnapshot(...)`，不额外引入 subagent special-case。
- Modify: `apps/zcode-cli/packages/core/src/context/sections/env-info.ts`
  - 将 main 当前使用的 git repo 判定逻辑导出为共享 helper，避免 subagent env/model context 复制一套相似但可能漂移的判定。
- Create: `apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`
  - 提供 `buildSubagentCommonNotes()`、`buildSubagentEnvironmentContext(...)`；builder 只消费已经按 main 逻辑准备好的 `EnvInfo`。
- Create: `apps/zcode-cli/packages/core/src/subagent/context-builder.ts`
  - 提供 `SubagentContextBuilder` / `createSubagentContextBuilder(...)`，返回完整 `ContextBuildResult`，并复用 common Notes/env/model helper。
- Modify: `apps/zcode-cli/packages/core/src/subagent/explore.ts`
  - 将 `buildExploreSystemPrompt(...)` 改为只返回 Explore agent-specific prompt。
- Modify: `apps/zcode-cli/packages/core/src/subagent/general-purpose.ts`
  - double check general-purpose agent-specific prompt body 是否与冻结文案一致；如果发现漂移，在本轮一并修正。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
  - 传入 `subagentContext.agentPrompt` 和 child `envInfo`，由 child runtime 自己的 builder 负责 prompt assembly。
- Modify: `apps/zcode-cli/packages/core/src/runtime/deps.ts`
  - 若 runtime deps barrel 当前导出 `buildExploreSystemPrompt`，同步导出/导入新的 builder。
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
  - 更新 Explore provider-visible system message 断言。
- Create: `apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts`
  - 覆盖 Explore、general-purpose、custom agent 的 child system prompt 组装。
- Modify: `docs/conversation-session-case-catalog.md`
  - 为 subagent prompt assembly 增加或更新 conversation E2E case 条目。
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
  - 将新增 case 的覆盖状态从 missing/undefined 更新到 covered。
- Create or Modify: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts`
  - 通过桌面前台窗口跑真实 conversation/session E2E，验证结果符合预期。
- Modify: 历史差异审计文档（已删除）
  - 更新 prompt assembly 现状：本轮只完成 child prompt common context，不宣称 tool/schema/background 对齐。

---

## Phase 1: Golden Tests For Child Prompt Shape

### Task 1: Add Provider-Visible Prompt Assembly Tests

**Files:**
- Create: `apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

**Interfaces:**
- Consumes:
  - `AgentRuntime` from `apps/zcode-cli/packages/core/src/runtime.ts`
  - `createSessionId`, `ModelRole`, `ModelRefSource`, `modelMessageContentToText` from `@zcode/contracts`
- Produces:
  - Failing tests that describe final child provider request shape before implementation.

- [ ] **Step 1: Double-check frozen prompt body baseline**

Run:

```bash
rg -n "You are ZCode Explore|You are an agent for ZCode|buildExploreSystemPrompt|buildGeneralPurposeSystemPrompt" apps/zcode-cli/packages/core/src/subagent apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
```

Expected:

- ZCode Explore/general-purpose body matches the exact expected text frozen in `subagent-explore.test.ts`.
- ZCode body does not include model-specific, provider-specific, historical, or experimental copy variants.

If ZCode body does not match the frozen expected text, do not treat this as out of scope. Add the expected body to the failing tests in this task, then align the implementation in Task 2 before changing the system message assembly.

- [ ] **Step 2: Create a helper to capture child provider requests**

Add this helper in `apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ModelRefSource,
  ModelRole,
  createModelId,
  createModelProviderId,
  createSessionId,
  modelMessageContentToText,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function createMainModelRef() {
  return {
    providerId: createModelProviderId("anthropic"),
    modelId: createModelId("claude-haiku-4-5-20251001-cc"),
    role: ModelRole.Main,
    source: ModelRefSource.Config,
  };
}

function systemContents(request: any): string[] {
  return request.messages
    .filter((message: any) => message.role === "system")
    .map((message: any) => message.content);
}

function allMessageText(request: any): string {
  return request.messages
    .map((message: any) => modelMessageContentToText(message.content))
    .join("\n");
}
```

- [ ] **Step 3: Add Explore system array test**

Add this test:

```ts
describe("subagent provider-visible prompt assembly", () => {
  it("assembles Explore child system messages with ZCode prefix, agent prompt, notes, and environment context", async () => {
    const sessionId = createSessionId("subagent-prompt-explore");
    const eventStore = createTestSessionEventStore();
    const childRequests: any[] = [];
    let parentCallCount = 0;

    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "build",
        modelRef: createMainModelRef(),
        modelProviderOptions: { reasoningEffort: "medium" },
        bashShellSelection: {
          dialect: "git-bash",
          display: { name: "Git Bash" },
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
          source: "user-config",
        },
        workingDirectory: "/Users/dev/Desktop/Z/z-code/apps/zcode-cli",
        currentDate: "2026-06-04",
        envInfo: {
          cwd: "/Users/dev/Desktop/Z/z-code/apps/zcode-cli",
          platform: "darwin",
          shell: "zsh",
          osVersion: "Darwin 24.3.0",
          nodeVersion: "24.14.0",
          isGitRepository: true,
        },
      },
      {
        eventStore,
        modelAdapter: {
          resolveConnection() {
            return {
              baseURL: "https://api.example.test/anthropic",
              providerId: "anthropic",
              providerKind: "anthropic",
            };
          },
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  model: request.model,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_explore",
                      name: "Agent",
                      input: {
                        description: "Find runtime loop",
                        prompt: "Find where the runtime injects tool results.",
                        subagent_type: "Explore",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                model: request.model,
                text: "parent used explore result",
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              };
            }
            childRequests.push(request);
            return {
              finishReason: "stop",
              model: request.model,
              text: "Explore found the runtime path.",
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("Use an explore agent for this question");

    expect(childRequests).toHaveLength(1);
    const systems = systemContents(childRequests[0]);
    expect(systems).toHaveLength(4);
    expect(systems[0]).toBe("You are ZCode, an interactive coding agent");
    expect(systems[1]).toContain("You are ZCode Explore");
    expect(systems[1]).toContain("READ-ONLY MODE");
    expect(systems[1]).not.toContain("Agent threads always have their cwd reset");
    expect(systems[1]).not.toContain("Here is useful information about the environment");
    expect(systems[2]).toContain("Notes:");
    expect(systems[2]).toContain("Agent threads always have their cwd reset between bash calls");
    expect(systems[2]).toContain("the parent agent reads your text output");
    expect(systems[3]).toContain("Here is useful information about the environment you are running in:");
    expect(systems[3]).toContain("Working directory: /Users/dev/Desktop/Z/z-code/apps/zcode-cli");
    expect(systems[3]).toContain("Is directory a git repo: Yes");
    expect(systems[3]).toContain("Platform: darwin");
    expect(systems[3]).toContain("Shell: Git Bash");
    expect(systems[3]).toContain("OS Version: Darwin 24.3.0");
    expect(systems[3]).toContain("You are powered by the model named anthropic/claude-haiku-4-5-20251001-cc.");

    const text = allMessageText(childRequests[0]);
    expect(text).not.toContain("You help the user with software engineering work in the current workspace.");
    expect(text).not.toContain("# claudeMd");
    expect(text).not.toContain("# user_instructions");
    expect(text).not.toContain("Project context:");
  });
});
```

- [ ] **Step 4: Add general-purpose prompt test**

Add this test in the same `describe` block:

```ts
  it("adds common notes and environment context to general-purpose child prompts", async () => {
    const sessionId = createSessionId("subagent-prompt-general-purpose");
    const eventStore = createTestSessionEventStore();
    const childRequests: any[] = [];
    let parentCallCount = 0;

    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "build",
        modelRef: createMainModelRef(),
        workingDirectory: "/repo",
        currentDate: "2026-06-04",
        envInfo: {
          cwd: "/repo",
          platform: "darwin",
          shell: "zsh",
          osVersion: "Darwin 24.3.0",
          nodeVersion: "24.14.0",
          isGitRepository: true,
        },
      },
      {
        eventStore,
        modelAdapter: {
          resolveConnection() {
            return {
              baseURL: "https://api.example.test/anthropic",
              providerId: "anthropic",
              providerKind: "anthropic",
            };
          },
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  model: request.model,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_general",
                      name: "Agent",
                      input: {
                        description: "Research runtime",
                        prompt: "Research how child runtimes are created.",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                model: request.model,
                text: "parent used general result",
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              };
            }
            childRequests.push(request);
            return {
              finishReason: "stop",
              model: request.model,
              text: "General-purpose agent found the runtime path.",
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("Use a general-purpose agent for this question");

    const systems = systemContents(childRequests[0]);
    expect(systems).toHaveLength(4);
    expect(systems[0]).toBe("You are ZCode, an interactive coding agent");
    expect(systems[1]).toContain("You are an agent for ZCode");
    expect(systems[1]).toContain("the caller will relay this to the user");
    expect(systems[1]).not.toContain("Agent threads always have their cwd reset");
    expect(systems[2]).toContain("Agent threads always have their cwd reset between bash calls");
    expect(systems[3]).toContain("Working directory: /repo");
  });
```

- [ ] **Step 5: Add custom profile prompt test**

Add this test:

```ts
  it("adds common notes and environment context to custom child prompts", async () => {
    const sessionId = createSessionId("subagent-prompt-custom");
    const eventStore = createTestSessionEventStore();
    const childRequests: any[] = [];
    let parentCallCount = 0;

    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "build",
        modelRef: createMainModelRef(),
        workingDirectory: "/repo",
        currentDate: "2026-06-04",
        envInfo: {
          cwd: "/repo",
          platform: "darwin",
          shell: "zsh",
          osVersion: "Darwin 24.3.0",
          nodeVersion: "24.14.0",
          isGitRepository: false,
        },
        subagents: {
          profiles: [
            {
              name: "code-researcher",
              description: "Research code paths.",
              color: "blue",
              source: "user",
              systemPrompt: "You are a focused code researcher. Return concise findings.",
              tools: ["Read", "Grep", "Glob"],
            },
          ],
        },
      },
      {
        eventStore,
        modelAdapter: {
          resolveConnection() {
            return {
              baseURL: "https://api.example.test/anthropic",
              providerId: "anthropic",
              providerKind: "anthropic",
            };
          },
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  model: request.model,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_custom",
                      name: "Agent",
                      input: {
                        description: "Research custom",
                        prompt: "Research the custom profile path.",
                        subagent_type: "code-researcher",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                model: request.model,
                text: "parent used custom result",
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              };
            }
            childRequests.push(request);
            return {
              finishReason: "stop",
              model: request.model,
              text: "Custom agent found the runtime path.",
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
        } as never,
      },
    );

    await runtime.executeTurn("Use the custom researcher agent for this question");

    const systems = systemContents(childRequests[0]);
    expect(systems).toHaveLength(4);
    expect(systems[0]).toBe("You are ZCode, an interactive coding agent");
    expect(systems[1]).toBe("You are a focused code researcher. Return concise findings.");
    expect(systems[2]).toContain("Notes:");
    expect(systems[3]).toContain("Is directory a git repo: No");
  });
```

- [ ] **Step 6: Update existing Explore test expectation**

In `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`, replace the single combined `exploreSystemMessages` constant with split constants:

```ts
const exploreAgentPrompt = `...`;
const subagentCommonNotes = `...`;
const subagentEnvironmentContext = `...`;

const exploreSystemMessages = [
  "You are ZCode, an interactive coding agent",
  exploreAgentPrompt,
  subagentCommonNotes,
  subagentEnvironmentContext,
];
```

Keep the exact body text consistent with the new builder from Phase 2. The old expected `system[1]` leading newline should be removed because child system messages are no longer generated through `ContextBuilder` custom prompt wrapping.

- [ ] **Step 7: Run failing tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
```

Expected before implementation:

- `subagent-prompt-assembly.test.ts` fails because child system messages still have only two system entries or Notes/env are embedded in `system[1]`.
- `subagent-explore.test.ts` fails after updating the expected split shape.

---

## Phase 2: Shared Subagent Prompt Pieces

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/context/sections/env-info.ts`
- Create: `apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`
- Modify: `apps/zcode-cli/packages/core/src/subagent/explore.ts`
- Modify: `apps/zcode-cli/packages/core/src/subagent/general-purpose.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/deps.ts`

**Interfaces:**
- Consumes:
  - `EnvInfo` from `@zcode/contracts`
  - `isEnvInfoGitRepository(info: EnvInfo): boolean` from `apps/zcode-cli/packages/core/src/context/sections/env-info.ts`
- Produces:
  - `buildSubagentCommonNotes(): string`
  - `buildSubagentEnvironmentContext(options): string`
  - `buildExploreAgentPrompt(options): string`

- [ ] **Step 1: Export main git repo判定 helper**

Modify `apps/zcode-cli/packages/core/src/context/sections/env-info.ts`.

Replace the private helper:

```ts
function isGitRepository(info: EnvInfo): boolean {
  return info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch));
}
```

with:

```ts
export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch));
}
```

Then update the two existing call sites in the same file:

```ts
const hasGitRepository = isEnvInfoGitRepository(info);
```

and:

```ts
if (!isEnvInfoGitRepository(envInfo)) {
  return null;
}
```

This keeps subagent git repo detection tied to the same logic main uses today.

- [ ] **Step 2: Create the shared prompt-piece file**

Create `apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`:

```ts
import type { EnvInfo } from "@zcode/contracts";
import { isEnvInfoGitRepository } from "../context/sections/env-info.js";

export interface SubagentEnvironmentContextOptions {
  agentPrompt: string;
  envInfo: EnvInfo;
}

export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.",
  ].join("\n");
}

export function buildSubagentEnvironmentContext(options: SubagentEnvironmentContextOptions): string {
  const { envInfo } = options;
  const modelLine = envInfo.currentModel
    ? [`You are powered by the model named ${envInfo.currentModel}.`]
    : [];

  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${envInfo.cwd}`,
    `Is directory a git repo: ${isEnvInfoGitRepository(envInfo) ? "Yes" : "No"}`,
    `Platform: ${envInfo.platform}`,
    `Shell: ${envInfo.shell}`,
    `OS Version: ${envInfo.osVersion}`,
    "</env>",
    ...modelLine,
  ]
    .join("\n");
}
```

Important boundary:

- `buildSubagentEnvironmentContext(...)` uses a fixed subagent env section shape, but values come from the same `EnvInfo` object main already uses.
- Do not add `additionalWorkingDirectories`, knowledge cutoff, git snapshot details, node version, or other fields unless current main context already exposes them in the relevant provider-visible context.
- Model name is read from `envInfo.currentModel`, matching main `createContextBuilderFromSnapshot(...)`, instead of formatting model refs inside the builder.

- [ ] **Step 3: Refactor Explore prompt to agent-specific prompt only**

In `apps/zcode-cli/packages/core/src/subagent/explore.ts`, rename `buildExploreSystemPrompt` to `buildExploreAgentPrompt` or keep the exported name with updated semantics if broader call sites are easier. Preferred:

```ts
export function buildExploreAgentPrompt(options: {
  embeddedSearchEnabled?: boolean;
}): string {
  const searchGuidelines = options.embeddedSearchEnabled
    ? [
        "- Use `find` via Bash for broad file pattern matching",
        "- Use `grep` via Bash for searching file contents with regex",
      ]
    : [
        "- Use Glob for broad file pattern matching",
        "- Use Grep for searching file contents with regex",
      ];
  const bashReadOnlyCommands = options.embeddedSearchEnabled
    ? "ls, git status, git log, git diff, find, grep, cat, head, tail"
    : "ls, git status, git log, git diff, find, cat, head, tail";

  return [
    "You are ZCode Explore, a file search and codebase research specialist for ZCode CLI. You excel at thoroughly navigating and exploring codebases.",
    "",
    "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
    "This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:",
    "- Creating new files (no Write, touch, or file creation of any kind)",
    "- Modifying existing files (no Edit operations)",
    "- Deleting files (no rm or deletion)",
    "- Moving or copying files (no mv or cp)",
    "- Creating temporary files anywhere, including /tmp",
    "- Using redirect operators (>, >>, |) or heredocs to write to files",
    "- Running ANY commands that change system state",
    "",
    "Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.",
    "",
    "Your strengths:",
    "- Rapidly finding files using glob patterns",
    "- Searching code and text with powerful regex patterns",
    "- Reading and analyzing file contents",
    "",
    "Guidelines:",
    ...searchGuidelines,
    "- Use Read when you know the specific file path you need to read",
    `- Use Bash ONLY for read-only operations (${bashReadOnlyCommands})`,
    "- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification",
    "- Adapt your search approach based on the thoroughness level specified by the caller",
    "- Communicate your final report directly as a regular message - do NOT attempt to create files",
    "",
    "NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:",
    "- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations",
    "- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files",
    "",
    "Complete the user's search request efficiently and report your findings clearly.",
  ].join("\n");
}
```

Remove `workingDirectory`, `workspaceRoot`, `envInfo`, and `modelName` from this function's options because those now belong to `buildSubagentEnvironmentContext(...)`.

- [ ] **Step 4: Align general-purpose body if the baseline check found drift**

If Task 1 Step 1 shows `apps/zcode-cli/packages/core/src/subagent/general-purpose.ts` has drifted from the frozen expected body, update `buildGeneralPurposeSystemPrompt()` before wiring the new system message builder.

Keep the body identical to the frozen expected text. Preserve provider-visible punctuation, paragraph breaks, and operational wording exactly.

Do not change this file if the baseline check proves it is already aligned.

- [ ] **Step 5: Keep a temporary compatibility export if needed**

If other imports still expect `buildExploreSystemPrompt`, add this shim in `explore.ts` during the refactor:

```ts
export const buildExploreSystemPrompt = buildExploreAgentPrompt;
```

Remove the shim only if all imports can be updated in the same task.

- [ ] **Step 6: Export the new prompt pieces through runtime deps**

In `apps/zcode-cli/packages/core/src/runtime/deps.ts`, export/import:

```ts
export { buildExploreAgentPrompt, EXPLORE_AGENT_TYPE } from "../subagent/explore.js";
export { buildSubagentCommonNotes, buildSubagentEnvironmentContext } from "../subagent/system-prompt.js";
```

If `deps.ts` currently exports `buildExploreSystemPrompt`, replace that export only after all call sites have moved.

- [ ] **Step 7: Run builder tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts
```

Expected after Task 2 only:

- Tests may still fail because runtime does not yet select the subagent context builder.
- Any direct import/type errors from the new prompt pieces should be fixed before moving on.

---

## Phase 3: Runtime Wiring With SubagentContextBuilder

### Task 3: Let Child Runtime Select Its Own Context Builder

**Files:**
- Create: `apps/zcode-cli/packages/core/src/subagent/context-builder.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`

**Interfaces:**
- Consumes:
  - `ContextBuildResult`, `ContextSection`, `ContextBuilderConfig` from context package
  - `buildSubagentCommonNotes(...)`
  - `buildSubagentEnvironmentContext(...)`
  - `buildExploreAgentPrompt(...)`
- Produces:
  - `AgentRuntimeConfig.subagentContext?: { agentPrompt: string }`
  - `SubagentContextBuilder` whose `build()` returns subagent sections, system messages, and meta-user attachments.

- [ ] **Step 1: Add `SubagentContextBuilder`**

Create `apps/zcode-cli/packages/core/src/subagent/context-builder.ts`.

The builder must extend or otherwise satisfy the runtime's existing context builder type and return a full `ContextBuildResult`:

```text
sections:
  CLI Prefix
  Subagent Agent Prompt
  Subagent Notes
  Subagent Environment
  Current Date, if present
  Skills, if declared and discovered

systemMessages:
  one provider-visible system message per subagent system section, all with ephemeral cache-control

metaUserAttachments:
  skills_listing for filtered declared skills
  context_prefix for currentDate
```

Do not include main identity, task behavior, project instructions, project context, memory, output style, or context management in this builder.

- [ ] **Step 2: Add `subagentContext` to runtime config**

In `apps/zcode-cli/packages/core/src/runtime/types.ts`, add near `systemPrompt?: string`:

```ts
  /**
   * Selects the subagent-specific context builder for child runtimes. The
   * builder still receives env/date/model data through the normal runtime
   * context snapshot, but assembles provider-visible system sections with the
   * subagent prompt shape instead of the main ContextBuilder stack.
   */
  subagentContext?: { agentPrompt: string };
```

- [ ] **Step 3: Select builder strategy in `createContextBuilderFromSnapshot(...)`**

In `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`, keep the shared `envInfo = { ...snapshot.envInfo, currentModel: formatModelRef(this.defaultModelRef) }` logic. After persisting `envInfo`, add:

```ts
if (this.config.subagentContext) {
  return createSubagentContextBuilder({
    agentPrompt: this.config.subagentContext.agentPrompt,
    currentDate: snapshot.currentDate,
    envInfo,
    skillMetadataBudget: this.config.skillMetadataBudget,
    skills: this.skillLoadOutcome,
  });
}
```

Main runtime continues to use the existing `createContextBuilder(contextConfig)` path.

- [ ] **Step 4: Remove the `systemMessages` override branch**

`initializeMessageHistoryFromContext(...)` should simply build the currently selected builder and initialize history from that `ContextBuildResult`. Do not special-case subagent messages in this method. `refreshContextModelSnapshot(...)` should keep calling `createContextBuilderFromSnapshot(...)`; the selected builder strategy handles subagent refresh automatically.

- [ ] **Step 5: Pass `subagentContext` from `subagent.ts`**

In `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`, replace the current `systemPrompt` calculation with an `agentPrompt` calculation:

```ts
const agentPrompt =
  request.agentType === EXPLORE_AGENT_TYPE && request.systemPrompt?.trim() === ""
    ? buildExploreAgentPrompt({ embeddedSearchEnabled })
    : request.systemPrompt?.trim();
```

Pass to child `AgentRuntime`:

```ts
envInfo: childPromptEnvInfo,
subagentContext: {
  agentPrompt: agentPrompt ?? "",
},
```

Keep the existing `baseChildEnvInfo` source order:

```ts
this.contextSourceSnapshot?.envInfo ?? this.config.envInfo ?? fallbackUnknownEnvInfo
```

Keep the existing shell override from `getSessionShellEnvironment(this)` before adding `currentModel`. This mirrors the main context path where `createContextBuilderFromSnapshot(...)` derives provider-visible env info from the current context snapshot and appends `currentModel: formatModelRef(this.defaultModelRef)`.

Do not add new env discovery, git probing, node-version output, knowledge-cutoff output, or additional-working-directory output in this task unless the current main prompt path already provides that exact data in provider-visible context.

- [ ] **Step 6: Keep current date behavior through shared meta-user context**

Do not put currentDate into the four subagent system messages. If `currentDate` exists, preserve the existing meta-user `context_prefix` path by including the normal current-date section in `SubagentContextBuilder.metaUserAttachments`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
```

Expected:

- New prompt assembly tests pass.
- Existing Explore test passes after expected system message split is updated.
- If failures show duplicate default identity/dynamic prompt text, inspect whether `initializeMessageHistoryFromContext` still runs after `systemMessages`.

---

## Phase 4: Documentation And Provider-Visible Verification

### Task 4: Document The Narrow Prompt Assembly Alignment

**Files:**
- Modify: 历史差异审计文档（已删除）

**Interfaces:**
- Consumes:
  - Implementation result from Tasks 2-3.
- Produces:
  - Updated audit section that records exactly what is now aligned and what remains out of scope.

- [ ] **Step 1: Add a dated section**

Add a section near the prompt/system context part:

```md
## 2026-07-07 subagent prompt assembly 现状

本轮只收敛普通 subagent child request 的 provider-visible system prompt 组装，不处理父 `Agent` tool schema、child tool surface、SendMessage、background notification、fork/repl hydration、teammate/worktree。

Explore/general-purpose 的 agent-specific body 只使用一套冻结文案。本轮执行时已 double check ZCode 当前 body 与冻结文案的一致性；如发现 drift，已在本轮修正后再做 system message 拆分和组装收敛。不引入按模型、provider、历史版本或实验分支区分的文案变体。

当前 child system message 顺序：

1. `You are ZCode, an interactive coding agent`
2. agent-specific prompt（Explore / general-purpose / custom profile body）
3. common subagent Notes（cwd reset、absolute paths、no emoji、no colon before tool calls、不要写 report/summary/findings/analysis `.md`）
4. env/model context（working directory、git repo、platform、shell、OS version、model name）

第 4 段的段落位置和外层结构固定，但字段值、fallback、shell 展示、git repo 判定和 model name 格式化以当前 main runtime/context builder 逻辑为准：从 `contextSourceSnapshot.envInfo` / `config.envInfo` 继承，沿用 session shell override，并用 `formatModelRef(childModelRef)` 写入 `envInfo.currentModel`。当前 main 没有提供的数据不在本轮硬造。

这保留了 ZCode 产品身份前缀，同时让后续 child prompt body 统一为 `agentPrompt + common Notes + env/model context` 结构。
```

- [ ] **Step 2: Update gap matrix entry for child system prompt**

Find the row about `Child system prompt` and change status from broad unaligned wording to:

```md
普通 child system prompt 的 common Notes / env-model context 已通过共享 builder 统一；仍未实现只读 agent 省略项目指令文件、agent memory、追加 subagent system prompt、fork/repl hydration、teammate/worktree 相关控制面。
```

- [ ] **Step 3: Run doc grep sanity check**

Run:

```bash
# 历史差异审计文档已删除，本步骤不再执行
```

Expected:

- The new dated section appears.
- Remaining out-of-scope features are still explicitly listed.

### Task 5: Final Validation Checklist

**Files:**
- No code files; validation only.

**Interfaces:**
- Consumes:
  - All previous tasks.
- Produces:
  - Verification evidence for final report.

- [ ] **Step 1: Run focused prompt tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
```

Expected:

- PASS.

- [ ] **Step 2: Run broader runtime prompt tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run apps/zcode-cli/packages/core/tests/context-builder.test.ts apps/zcode-cli/packages/core/tests/runtime-trace.test.ts
```

Expected:

- PASS.
- If failures are only stale expectations around child system prompt shape, update expectations to the new split system messages.
- If failures involve main-thread prompt shape, stop and inspect because this plan must not change main runtime ContextBuilder behavior.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

- PASS, or only known unrelated baseline failures. If failures are unrelated, record exact failing package/file in final report.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected:

- PASS, or only known unrelated baseline failures. If failures are unrelated, record exact failing package/file in final report.

- [ ] **Step 5: Inspect final child provider request shape from test capture**

Use the failing/passing test debug output only if needed. The final child request must satisfy:

```text
system[0] === "You are ZCode, an interactive coding agent"
system[1] contains agent-specific prompt
system[1] does not contain "Agent threads always have their cwd reset"
system[2] starts with "Notes:"
system[2] contains "the parent agent reads your text output"
system[3] starts with "Here is useful information about the environment you are running in:"
system[3] contains Working directory / git repo / Platform / Shell / OS Version / model name
```

### Task 6: Add And Run Foreground Desktop E2E

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create or Modify: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts`

**Interfaces:**
- Consumes:
  - Prompt assembly implementation from Tasks 2-3.
  - Existing desktop WDIO helpers under `packages/desktop/test/e2e/helpers/`.
  - Existing E2E command from `docs/testing/desktop-e2e-reporting.md`.
- Produces:
  - A desktop conversation/session E2E that opens the real Electron foreground window and verifies subagent prompt assembly behavior through user-visible flow plus provider/request evidence.

- [ ] **Step 1: Add or update the conversation-session case catalog**

In `docs/conversation-session-case-catalog.md`, add a case entry for subagent prompt assembly. Use the existing table style in that file, with this semantic content:

```md
| <next-id> | Subagent prompt assembly | 用户从前台窗口发起一次会触发 Explore/general-purpose subagent 的对话 | 子 agent provider-visible system prompt 保留 ZCode prefix，并将 agent prompt / common Notes / env-model context 拆成独立 system messages；主线程 prompt 不回归 | covered | `conversation-session-subagent-prompt-assembly.test.ts` |
```

Use the next valid case id according to the current catalog conventions; do not invent a new numbering family if an existing subagent/conversation family already exists.

- [ ] **Step 2: Update the E2E coverage matrix**

In `docs/testing/conversation-session-e2e-coverage-matrix.md`, add or update the matching row:

```md
| <same-id> | Subagent prompt assembly | covered | `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts` | Verifies foreground-window conversation path and child provider-visible prompt shape |
```

Keep the row format consistent with the current matrix. If the matrix separates source case id, state, and spec path into different columns, fill the equivalent columns rather than copying this row literally.

- [ ] **Step 3: Write the desktop E2E spec**

Create `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts`.

The spec must:

- Launch the real desktop app through WDIO.
- Use an existing replay/mock provider helper so the run is deterministic.
- Create a conversation from the foreground Electron window.
- Send a prompt that triggers `Agent` with `subagent_type: "Explore"` or the default general-purpose agent.
- Wait for the subagent result to appear in the conversation.
- Inspect captured model request evidence or persisted model-io/debug artifact from the E2E run.
- Assert the child request system messages satisfy:

```text
system[0] === "You are ZCode, an interactive coding agent"
system[1] contains the agent-specific prompt
system[1] does not contain "Agent threads always have their cwd reset"
system[2] starts with "Notes:"
system[2] contains "the parent agent reads your text output"
system[3] starts with "Here is useful information about the environment you are running in:"
```

Use existing helpers from nearby specs rather than creating a parallel E2E harness. Good reference files to inspect before writing the spec:

```text
packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts
packages/desktop/test/e2e/conversation-session/subagents/conversation-session-built-in-subagent-model-overrides.test.ts
packages/desktop/test/e2e/helpers/conversation-session.ts
packages/desktop/test/e2e/helpers/model-provider-replay.ts
packages/desktop/test/e2e/helpers/conversation-session-network.ts
```

- [ ] **Step 4: Run the E2E through the foreground desktop window**

Run the new spec with the local foreground Electron window, not only the container runner:

```bash
ZCODE_E2E_SPEC=./test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts pnpm --filter @zcode/desktop test:e2e
```

Expected:

- PASS.
- A real Electron desktop window is launched by WDIO during the run.
- The E2E report is written under `packages/desktop/.e2e-artifacts/<run-id>/`.
- The test result and captured provider/request evidence show the child system prompt split exactly as expected.

- [ ] **Step 5: Run conversation coverage audit**

Run:

```bash
pnpm audit:conversation-session-coverage
```

Expected:

- PASS.
- If the audit reports stale generated docs or missing coverage rows, update the catalog/matrix entries and rerun until it passes.

- [ ] **Step 6: Record E2E evidence in the final implementation report**

The final implementation report must include:

```text
E2E command:
ZCODE_E2E_SPEC=./test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts pnpm --filter @zcode/desktop test:e2e

E2E result:
PASS

Artifact path:
packages/desktop/.e2e-artifacts/<run-id>/

Provider-visible check:
child system[0..3] matched the expected prompt assembly shape
```

If the local machine cannot run foreground Electron E2E, do not mark the task complete. Report the blocker and leave the implementation uncommitted for review.

---

## Risks And Guardrails

- Main prompt regression risk: adding `systemMessages` must not change main runtime `ContextBuilder` behavior. Guard with `context-builder.test.ts` and `runtime-trace.test.ts`.
- Date context ambiguity: current child tests assert `# currentDate`; the target env/model context does not include date. Do not add a new date section unless current product semantics require it; if retained elsewhere, document the source separately.
- Main-env logic drift: env/model context should not become a second independent environment formatter. Reuse main `EnvInfo` source order, shell override, git repo boolean helper, and `currentModel` formatting; do not add fields main does not provide.
- Custom prompt leading newline drift: current `ContextBuilder` custom prompt adds `\n` before `system[1]`. New child system messages should not inherit that leading newline unless a provider-visible fixture proves it is required.
- Copy-branch drift: Explore/general-purpose body uses a single frozen copy. Execution must double check the current body against the frozen expected text before implementation; if drift is found, align the body in this change before moving sections between system messages.
- Naming drift: code helper names should be local and semantic, such as `createSubagentContextBuilder`, not external-product-specific.
- Scope creep: if implementation starts touching tool schemas, background, SendMessage, or MCP required server behavior, stop and split a separate plan.
- E2E completion risk: unit tests are not enough for this change. Completion requires a desktop E2E spec and a successful foreground-window WDIO run.
- Commit guardrail: do not create a git commit automatically after implementation or validation. Leave changes in the working tree unless the user explicitly asks for a commit.

## Completion Criteria

- New shared builder exists and is used by Explore, general-purpose, and custom child runtimes.
- Explore/general-purpose agent-specific body has been double checked against the frozen expected text and remains or has been brought into alignment, with no model-specific/provider-specific/historical/experimental copy mixed in.
- Explore prompt no longer embeds common Notes/env/model context.
- Subagent env/model context uses the fixed section placement and outer shape, while field values/fallbacks follow current main runtime/context builder logic.
- Child provider-visible system messages are split into four entries with ZCode prefix at `system[0]`.
- Main thread prompt assembly is unchanged.
- Focused prompt tests pass.
- A conversation-session E2E spec covers this prompt assembly behavior.
- The E2E spec has been run through the local foreground Electron window with `ZCODE_E2E_SPEC=./test/e2e/conversation-session/subagents/conversation-session-subagent-prompt-assembly.test.ts pnpm --filter @zcode/desktop test:e2e`, and the result is PASS.
- `pnpm audit:conversation-session-coverage` passes after catalog/matrix updates.
- `pnpm typecheck` and `pnpm lint` have been run, with any unrelated baseline failures explicitly reported.
- No automatic commit is created. The final state remains reviewable in the working tree until the user explicitly asks to commit.
