# ExitPlanMode Plan File Compact Continuity Hack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划禁止自动提交；完成后只输出验证结果和 `git status --short`，除非用户再次明确要求提交。

**Goal:** 在保留当前 `ExitPlanMode({ plan, allowedPrompts? })` 输入形态的前提下，让审批通过的 plan 同步写入 workspace 下的 `.zcode/plans/*.md`，并在 compact 成功后通过 `plan_file_reference` 持久化恢复完整 plan，保证 compact/resume 后 plan 不丢。

**Architecture:** 这是一个保证 `plan_file_reference` 连续性的最小过渡方案，不做完整 provider-visible schema 重构。`ExitPlanMode` 审批通过后由 tool handler 通过现有 `FileSystemPort.writeTextFile({ createParents: true, atomic: true })` 写入确定性 plan file；`compactActiveConversation()` 在构造 `postCompactReminderEntries` 时读取同一文件并追加 `plan_file_reference` model-only reminder，复用现有 compact summary/reminder 原子持久化路径。没有 plan file 的会话不追加该 reminder。

**Review update:** 最终实现按 review 反馈进一步收敛 provider-visible plan file 效果：`plan_file_reference` 使用固定文案，plan file 写入原始 `plan` 字符串，保存失败不阻断已批准的退出 plan mode。下方早期执行步骤中的代码片段只保留为实施轨迹，最终合同以 `docs/plan-mode-plan-file-compact-continuity.md` 和源码为准。

**Tech Stack:** TypeScript, Vitest, ZCode core runtime, `FileSystemPort`, system reminder source registry, WDIO desktop conversation-session E2E, manual-review fixture promotion workflow.

## Global Constraints

- 本计划只实现 compact/resume 后 plan 连续性小 hack；不移除 provider-visible `ExitPlanMode.plan`，不新增 runtime injected input，不改变 permission broker schema，不实现完整的 plan-file schema 重构。
- plan file 路径固定为 `${workspaceRoot}/.zcode/plans/plan-${sanitizedSessionId}.md`；路径语义使用 `workspaceRoot`，不能使用会随 Bash `cd` 变化的 `workingDirectory`。
- 写 plan file 必须发生在用户审批通过并得到最终 plan input 之后；保存原始 `plan` 字符串，不做 trim 或补换行。写失败不阻断 `sessionModePort.exitPlanMode()`。
- compact 只在确定性 plan file 存在且内容非空时追加 `plan_file_reference`；没有 plan file 的普通会话不能因为读取缺失文件导致 compact 失败。
- `plan_file_reference` 内容必须包含固定文案：`A plan file exists from plan mode at: ${planFilePath}`、`Plan contents:`、完整 plan 正文，以及 `If this plan is relevant to the current work and not already complete, continue working on it.`。
- 不把 plan file 混进 generic read-state reminder；保留 `compact-post-reminders.ts` 对 `docs/superpowers/plans/` 的 skip guard。
- 不改 desktop/web/remote control 架构，不新增 relay/main 业务状态，不改 queue/stream/snapshot 语义。
- 新增功能先写 docs/spec，再写测试，再实现代码。
- 完成后必须运行 targeted tests、conversation E2E 可视化窗口验证、`typecheck:e2e`、`pnpm typecheck`、`pnpm lint`；不能自动 commit。

---

## File Structure

- Create: `docs/plan-mode-plan-file-compact-continuity.md`
  - 记录当前小 hack 的产品边界、路径合同、compact reminder 合同、非目标。
- Modify: `apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md`
  - 更新当前 ZCode plan mode 设计说明：`ExitPlanMode.plan` 仍保留，但审批通过后写 plan file，compact 后用 `plan_file_reference` 恢复。
- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file-continuity.ts`
  - 封装 plan file 路径、写入、读取、`plan_file_reference` entry 构造。
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`
  - 导出 `plan-file-continuity.ts`。
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`
  - `ExitPlanMode` 审批通过后 best-effort 写入 plan file，再退出 plan mode；写失败不阻断退出。
- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
  - 新增 persisted source：`plan_file_reference`。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
  - compact 成功时把 plan file reference entry 放入 `postCompactReminderEntries`，排在 read-state reminders 前。
- Create: `apps/zcode-cli/packages/core/tests/plan-file-continuity.test.ts`
  - 覆盖路径、写入、读取、reminder 正文。
- Modify: `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`
  - 覆盖 `ExitPlanMode` 审批后的 plan file 写入和写失败仍退出 plan mode。
- Modify: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`
  - 覆盖 `plan_file_reference` source 分组、descriptor、wrapper。
- Modify: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
  - 覆盖 compact 后 runtime history/provider context 包含 `plan_file_reference` 完整 plan。
- Modify: `docs/conversation-session-case-catalog.md`
  - 新增 plan approval + compact continuity accepted case。
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
  - 新增测试缩写和覆盖映射。
- Create: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`
  - 通过真实桌面窗口验证 plan approval、plan file 落盘、`/compact`、后续 provider request 中 plan continuity。
- After manual review, move: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts` -> `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`
  - 通过 `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts --reviewed --apply` 完成移动和脚手架生成。

---

## Phase 0: Spec First

### Task 0.1: 写 feature spec，锁定小 hack 边界

**Files:**
- Create: `docs/plan-mode-plan-file-compact-continuity.md`
- Modify: `apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md`

**Interfaces:**
- Consumes: 当前 `ExitPlanModeInputSchema` 仍要求 `plan: string`。
- Produces: 后续实现必须遵守的 plan file 路径合同和 reminder 正文合同。

- [ ] **Step 1: 创建 feature spec**

Create `docs/plan-mode-plan-file-compact-continuity.md` with this content:

```markdown
# Plan Mode Plan File Compact Continuity

## 背景

当前 ZCode 的 `ExitPlanMode` 仍通过 tool input 的 `plan` 字段承载完整 plan。若 `ExitPlanMode` 审批后很快触发 compact，summary 可能没有保留完整 plan，compact/resume 后模型无法稳定拿回已批准 plan。

## 目标

审批通过后的 `ExitPlanMode.plan` 必须同步写入 workspace root 下的确定性 plan file。compact 成功后，runtime 必须把该 plan file 的路径和完整内容作为 `plan_file_reference` model-only reminder 持久化到 compact 后历史里。

## 路径合同

plan file 路径为：

```text
${workspaceRoot}/.zcode/plans/plan-${sanitizedSessionId}.md
```

`workspaceRoot` 表示工作区根路径；不能使用可能被 Bash `cd` 改变的 `workingDirectory`。`sanitizedSessionId` 只保留 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，其他字符替换成 `-`，并去掉首尾 `-`。

## 写入合同

`ExitPlanMode` 在用户审批通过并应用 permission broker 返回的最终 input 后写 plan file。写入使用 `FileSystemPort.writeTextFile()`，参数必须包含 `createParents: true`、`atomic: true`、`encoding: "utf8"`。写失败时 `ExitPlanMode` 失败，session 保持 plan mode。

## Compact 合同

compact 成功后，如果确定性 plan file 存在且内容非空，runtime 在 `postCompactReminderEntries` 中追加 source 为 `plan_file_reference` 的 model-only reminder，内容格式为：

```text
A plan file exists from plan mode at: ${planFilePath}

${planContent}
```

该 reminder 排在 generic read-state reminders 前面，并通过现有 `persistCompactSummary()` 与 compact summary 一起持久化；任一步持久化失败时沿用现有 compact persistence rollback。

## 非目标

- 不改变 provider-visible `ExitPlanMode` input schema。
- 不实现 runtime injected `plan` / `planFilePath`。
- 不改变 `ExitPlanMode` output shape。
- 不新增 UI 展示。
- 不把 plan file 加入 generic read-state reminder。
- 不处理用户手动删除 `.zcode/plans` 后的恢复。
```

- [ ] **Step 2: 更新 plan mode 设计文档**

In `apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md`, keep the current statement that ZCode `ExitPlanMode` receives `plan` in tool input, and add a subsection named `审批后 plan file 连续性` containing:

```markdown
### 审批后 plan file 连续性

当前过渡实现仍保留 `ExitPlanMode({ plan, allowedPrompts? })` 的 provider-visible 输入形态。审批通过后，runtime 会把最终批准的 plan 写入 workspace root 下的 `.zcode/plans/plan-${sanitizedSessionId}.md`。

这个文件不是新的 provider-visible input，也不是完整的 plan-file schema 重构；它只用于 compact/resume continuity。compact 成功时，如果该 plan file 存在且非空，runtime 会在 compact 后历史中持久化 `plan_file_reference` model-only reminder：

```text
A plan file exists from plan mode at: ${planFilePath}

${planContent}
```

这样即使 `ExitPlanMode` 后立即 compact，恢复后的下一轮 provider context 仍能拿到完整批准计划。
```

- [ ] **Step 3: 检查 spec 没有扩展成完整 plan-file schema 重构**

Run:

```bash
rg -n "runtime injected|provider-visible.*allowedPrompts|remove.*plan|filePath output|EnterPlanMode.*draft|schema parity" docs/plan-mode-plan-file-compact-continuity.md apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md
```

Expected: no lines that require removing provider-visible `plan` or adding injected input. Lines inside the `非目标` section are acceptable only when they explicitly say the item is not implemented.

---

## Phase 1: Plan File Helper

### Task 1.1: 先写 plan-file continuity helper 单测

**Files:**
- Create: `apps/zcode-cli/packages/core/tests/plan-file-continuity.test.ts`
- Use existing: `apps/zcode-cli/packages/core/tests/memory-test-utils.ts`

**Interfaces:**
- Produces expected signatures:
  - `resolveApprovedPlanFilePath(input: { sessionId: string; workspaceRoot: string }): string`
  - `writeApprovedPlanFile(input: { abortSignal?: AbortSignal; fileSystemPort: FileSystemPort; plan: string; sessionId: string; traceContext?: TraceContext; workspaceRoot: string }): Promise<{ path: string }>`
  - `readApprovedPlanFileReferenceEntry(input: { abortSignal?: AbortSignal; fileSystemPort: FileSystemPort; sessionId: string; traceContext?: TraceContext; workspaceRoot: string }): Promise<RuntimeMessageEntry | undefined>`
  - `formatPlanFileReference(input: { planContent: string; planFilePath: string }): string`

- [ ] **Step 1: Add failing helper tests**

Create `apps/zcode-cli/packages/core/tests/plan-file-continuity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import { MemoryFileSystem } from "./memory-test-utils.js";
import {
  formatPlanFileReference,
  readApprovedPlanFileReferenceEntry,
  resolveApprovedPlanFilePath,
  writeApprovedPlanFile,
} from "../src/runtime/helpers/plan-file-continuity.js";

describe("plan file continuity", () => {
  it("resolves approved plan file under workspace root with sanitized session id", () => {
    const path = resolveApprovedPlanFilePath({
      sessionId: "session:with/slashes",
      workspaceRoot: "/workspace/project",
    });

    expect(path.replace(/\\/g, "/")).toBe(
      "/workspace/project/.zcode/plans/plan-session-with-slashes.md",
    );
  });

  it("writes the approved plan through FileSystemPort using the deterministic path", async () => {
    const fileSystemPort = new MemoryFileSystem({});
    const sessionId = createSessionId("plan-file-write");
    const traceContext = createRootTraceContext({ sessionId, turnId: "turn-plan-file-write" });

    const result = await writeApprovedPlanFile({
      fileSystemPort,
      plan: "1. Read current code\n2. Add compact reminder",
      sessionId,
      traceContext,
      workspaceRoot: "/workspace/project",
    });

    expect(result.path.replace(/\\/g, "/")).toBe(
      "/workspace/project/.zcode/plans/plan-plan-file-write.md",
    );
    expect(fileSystemPort.files[result.path]).toBe(
      "1. Read current code\n2. Add compact reminder",
    );
  });

  it("formats the plan_file_reference reminder body", () => {
    expect(
      formatPlanFileReference({
        planFilePath: "/workspace/project/.zcode/plans/plan-session.md",
        planContent: "1. Keep the approved plan\n2. Verify after compact",
      }),
    ).toBe(
      [
        "A plan file exists from plan mode at: /workspace/project/.zcode/plans/plan-session.md",
        "",
        "1. Keep the approved plan\n2. Verify after compact",
      ].join("\n"),
    );
  });

  it("returns a model-only plan_file_reference entry when the plan file exists", async () => {
    const sessionId = createSessionId("plan-file-reference");
    const fileSystemPort = new MemoryFileSystem({
      "/workspace/project/.zcode/plans/plan-plan-file-reference.md":
        "1. Preserve plan marker E2E_PLAN_FILE_CONTINUITY",
    });

    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort,
      sessionId,
      workspaceRoot: "/workspace/project",
    });

    expect(entry).toMatchObject({
      content: expect.stringContaining("A plan file exists from plan mode at:"),
      metadata: { source: "plan_file_reference" },
    });
    expect(entry?.content).toContain("E2E_PLAN_FILE_CONTINUITY");
  });

  it("returns undefined when the deterministic plan file does not exist", async () => {
    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort: new MemoryFileSystem({}),
      sessionId: createSessionId("no-plan-file"),
      workspaceRoot: "/workspace/project",
    });

    expect(entry).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run helper tests and confirm they fail because helper does not exist**

Run:

```bash
pnpm --filter @zcode/core test -- plan-file-continuity.test.ts
```

Expected: FAIL with module resolution error for `../src/runtime/helpers/plan-file-continuity.js`.

### Task 1.2: 实现 plan-file continuity helper

**Files:**
- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file-continuity.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`

**Interfaces:**
- Consumes: `FileSystemPort`, `PLAN_MODE_MAX_PLAN_CHARS`, `systemReminderAttachmentEntry`.
- Produces: the four helper functions used by Task 1.1 and later phases.

- [ ] **Step 1: Add helper implementation**

Create `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file-continuity.ts`:

```ts
import { join } from "node:path";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const PLAN_FILE_REFERENCE_MAX_BYTES = PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024;

export function resolveApprovedPlanFilePath(input: {
  sessionId: SessionId | string;
  workspaceRoot: string;
}): string {
  return join(
    input.workspaceRoot,
    ".zcode",
    "plans",
    `plan-${sanitizePlanFileSessionId(input.sessionId)}.md`,
  );
}

export async function writeApprovedPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  plan: string;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<{ path: string }> {
  const plan = input.plan.trim();
  if (!plan) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const path = resolveApprovedPlanFilePath(input);
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: plan,
      createParents: true,
      encoding: "utf8",
      path,
      trace: input.traceContext,
    },
    { signal: input.abortSignal },
  );
  return { path };
}

export async function readApprovedPlanFileReferenceEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<RuntimeMessageEntry | undefined> {
  const path = resolveApprovedPlanFilePath(input);
  let content: string;
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: PLAN_FILE_REFERENCE_MAX_BYTES,
        path,
        trace: input.traceContext,
      },
      { signal: input.abortSignal },
    );
    content = read.content.trim();
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }

  if (!content) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: content, planFilePath: path }),
  );
}

export function formatPlanFileReference(input: {
  planContent: string;
  planFilePath: string;
}): string {
  return [
    `A plan file exists from plan mode at: ${input.planFilePath}`,
    "",
    input.planContent,
  ].join("\n");
}

function sanitizePlanFileSessionId(sessionId: SessionId | string): string {
  const sanitized = String(sessionId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw createCoreError(CoreErrorType.InvalidInput, "Session id cannot produce a plan file name", {
      recoverable: false,
    });
  }
  return sanitized;
}
```

- [ ] **Step 2: Export helper**

Append to `apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`:

```ts
export * from "./plan-file-continuity.js";
```

- [ ] **Step 3: Run helper tests and confirm pass**

Run:

```bash
pnpm --filter @zcode/core test -- plan-file-continuity.test.ts
```

Expected: PASS all five tests.

---

## Phase 2: ExitPlanMode 写入 Plan File

### Task 2.1: 先写 ExitPlanMode 写入/失败行为测试

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`

**Interfaces:**
- Consumes: `writeApprovedPlanFile()` from Phase 1.
- Produces: `ExitPlanMode` approved path writes final broker-modified plan before leaving plan mode.

- [ ] **Step 1: Extend test helper to pass FileSystemPort and workspace paths**

In `createPlanModeExecutor()` test helper input type, add:

```ts
  fileSystemPort?: import("@zcode/contracts").FileSystemPort;
  workingDirectory?: string;
  workspaceRoot?: string;
```

In the `createToolExecutor()` call, pass:

```ts
    fileSystemPort: input.fileSystemPort,
    workingDirectory: input.workingDirectory ?? "/workspace/project",
    workspaceRoot: input.workspaceRoot ?? "/workspace/project",
```

- [ ] **Step 2: Update existing approval test to assert final modified plan file content**

In the existing test named `requests approval before exiting plan mode and returns the approved plan`, create a memory file system before the executor:

```ts
    const fileSystemPort = new MemoryFileSystem({});
```

Pass it to `createPlanModeExecutor({ ... })`:

```ts
      fileSystemPort,
      workspaceRoot: "/workspace/project",
```

After the existing output/modelContent assertions, add:

```ts
    expect(
      fileSystemPort.files[
        "/workspace/project/.zcode/plans/plan-exit-plan-mode.md"
      ],
    ).toBe("1. Update the service boundary\n2. Add tests");
```

Add import near the top:

```ts
import { MemoryFileSystem } from "./memory-test-utils.js";
```

- [ ] **Step 3: Add write-failure test**

Add this test in `describe("plan mode tools", ...)`:

```ts
  it("does not exit plan mode when approved plan file write fails", async () => {
    const sessionId = createSessionId("exit-plan-write-fails");
    const turnId = createTurnId("exit-plan-write-fails");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    let mode: CollaborationMode = "plan";
    let prePlanMode: Exclude<CollaborationMode, "plan"> | undefined = "build";
    const sessionModePort = createSessionModePort({
      getMode: () => mode,
      getPrePlanMode: () => prePlanMode,
      setMode: (nextMode) => {
        mode = nextMode;
      },
      setPrePlanMode: (nextMode) => {
        prePlanMode = nextMode;
      },
    });
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        return { decision: "allow", reason: "approved" };
      },
    };
    const fileSystemPort = {
      ...new MemoryFileSystem({}),
      async writeTextFile() {
        throw new Error("disk is read-only for plan file");
      },
    };

    const result = await createPlanModeExecutor({
      events,
      fileSystemPort,
      mode: () => mode,
      permissionBroker,
      sessionId,
      sessionModePort,
      traceContext,
      turnId,
      workspaceRoot: "/workspace/project",
    }).execute(
      {
        id: createToolCallId("exit-plan-write-fails"),
        input: {
          plan: "1. This plan should not exit if file persistence fails.",
        },
        name: "ExitPlanMode",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("disk is read-only for plan file");
    expect(mode).toBe("plan");
    expect(prePlanMode).toBe("build");
  });
```

- [ ] **Step 4: Run focused tests and confirm new assertions fail**

Run:

```bash
pnpm --filter @zcode/core test -- plan-mode-tool.test.ts
```

Expected: FAIL because `ExitPlanMode` has not written the plan file yet.

### Task 2.2: 写入 approved plan file 再退出 plan mode

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`

**Interfaces:**
- Consumes: `writeApprovedPlanFile()`.
- Produces: `ExitPlanMode` preserves current output shape and writes plan file before `sessionModePort.exitPlanMode()`.

- [ ] **Step 1: Import helper**

In `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`, add:

```ts
import { writeApprovedPlanFile } from "../../runtime/helpers/plan-file-continuity.js";
```

- [ ] **Step 2: Add FileSystemPort assertion helper**

Below `assertSessionModePort()`, add:

```ts
function assertFileSystemPort(
  context: ToolExecutionContext,
): asserts context is ToolExecutionContext & {
  fileSystemPort: NonNullable<ToolExecutionContext["fileSystemPort"]>;
} {
  if (context.fileSystemPort) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    "FileSystemPort is not configured for ExitPlanMode plan file persistence",
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: EXIT_PLAN_MODE_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}
```

- [ ] **Step 3: Write plan before mode transition**

In `exitPlanModeHandler`, after the mode check and before `context.sessionModePort.exitPlanMode(...)`, insert:

```ts
  assertFileSystemPort(context);
  await writeApprovedPlanFile({
    abortSignal: context.abortSignal,
    fileSystemPort: context.fileSystemPort,
    plan: parsed.plan,
    sessionId: context.sessionId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
    workspaceRoot: context.workspaceRoot,
  });
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core test -- plan-mode-tool.test.ts plan-file-continuity.test.ts
```

Expected: PASS. The existing output shape still includes `plan`, `approved`, `previousMode`, `mode`, and `allowedPrompts`; no `planFilePath` output field is introduced.

---

## Phase 3: `plan_file_reference` Source Registry

### Task 3.1: 先写 system reminder source 测试

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`

**Interfaces:**
- Produces: `plan_file_reference` is a persisted `history_continuity` / `resume_history` meta provider-visible reminder source.

- [ ] **Step 1: Add source to expected list and persisted bucket assertions**

In `EXPECTED_SOURCES`, insert `"plan_file_reference"` immediately after `"resume_referenced_session_context"`.

In the `SYSTEM_REMINDER_PERSISTED_SOURCES` assertion, insert `"plan_file_reference"` immediately after `"resume_referenced_session_context"`.

- [ ] **Step 2: Add explicit descriptor assertion**

Add this assertion to the test named `classifies sources by explicit source instead of reminder text`:

```ts
    expect(getSystemReminderDescriptor("plan_file_reference")).toMatchObject({
      channel: "history_continuity",
      evidenceLabel: "sr.plan_file_reference",
      isMeta: true,
      lifecycle: "resume_history",
      providerVisibility: "provider_visible",
    });
```

- [ ] **Step 3: Add wrapper assertion**

Add:

```ts
  it("wraps plan_file_reference without nested reminder metadata", () => {
    const reminder = wrapSystemReminderForSource(
      "plan_file_reference",
      "A plan file exists from plan mode at: /workspace/.zcode/plans/plan-session.md\n\n1. approved plan",
    );

    expectExactlyOneSystemReminderWrapper(reminder);
    expect(reminder).toContain("A plan file exists from plan mode at:");
    expect(reminder).toContain("1. approved plan");
  });
```

- [ ] **Step 4: Run source tests and confirm fail**

Run:

```bash
pnpm --filter @zcode/core test -- system-reminder-source.test.ts
```

Expected: FAIL because `plan_file_reference` is not registered yet.

### Task 3.2: 注册 `plan_file_reference`

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`

**Interfaces:**
- Consumes: persisted compact reminder entry metadata source.
- Produces: source descriptor usable by provider projection and persisted model-only reminder hydration.

- [ ] **Step 1: Add persisted source**

In `SYSTEM_REMINDER_PERSISTED_SOURCES`, insert:

```ts
  "plan_file_reference",
```

immediately after:

```ts
  "resume_referenced_session_context",
```

- [ ] **Step 2: Keep non-MCS behavior aligned with resume continuity reminders**

In `NON_MID_CONVERSATION_SYSTEM_SOURCES`, insert:

```ts
  "plan_file_reference",
```

immediately after:

```ts
  "resume_referenced_session_context",
```

This keeps the reminder projected through the same non-mid-conversation path as current resume continuity context.

- [ ] **Step 3: Add descriptor**

In `SYSTEM_REMINDER_DESCRIPTORS`, add:

```ts
  plan_file_reference: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.plan_file_reference",
  ),
```

immediately after `resume_referenced_session_context`.

- [ ] **Step 4: Run source tests**

Run:

```bash
pnpm --filter @zcode/core test -- system-reminder-source.test.ts
```

Expected: PASS.

---

## Phase 4: Compact 后注入 Plan Reference

### Task 4.1: 先写 compact runtime 回归测试

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- Consumes: `readApprovedPlanFileReferenceEntry()`.
- Produces: compact after approved plan stores `plan_file_reference` in post-compact runtime history and next provider request.

- [ ] **Step 1: Add regression test near existing compact post-reminder tests**

In `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`, add this import near the existing test helper imports:

```ts
import { MemoryFileSystem } from "./memory-test-utils.js";
```

Then add this test near the existing post-compact read-state reminder tests:

```ts
it("persists approved plan file reference after compact so resume keeps the full plan", async () => {
  const sessionId = createSessionId("runtime-compact-plan-file-reference");
  const eventStore = createTestSessionEventStore();
  const store = createRecordingSessionStore();
  const requests: Array<{ messages: Array<{ content: unknown; role: string }> }> = [];
  const planMarker = "E2E_PLAN_FILE_COMPACT_CONTINUITY_MARKER";
  const fileSystemPort = new MemoryFileSystem({
    "/workspace/project/.zcode/plans/plan-runtime-compact-plan-file-reference.md":
      `1. Preserve ${planMarker}\n2. Continue after compact`,
  });
  const modelAdapter = {
    async generateText(request: { messages: Array<{ content: unknown; role: string }> }) {
      requests.push({ messages: request.messages });
      return {
        finishReason: "stop",
        model: request.model,
        text: "<summary>Compact summary keeps older conversation short.</summary>",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      };
    },
  };

  const runtime = new AgentRuntime(
    sessionId,
    {
      systemPrompt: "You are a compact plan-file reference test agent.",
      workingDirectory: "/workspace/project",
    },
    {
      eventStore,
      fileSystemPort,
      modelAdapter: modelAdapter as never,
      sessionStore: store,
    },
  );

  await runtime.executeTurn("first setup before plan approval");
  await runtime.executeTurn("second setup before compact");

  const runtimeInternals = runtime as unknown as {
    compactActiveConversation(
      customInstructions: string | undefined,
      traceContext: { traceId: string },
      events: unknown[],
      options: {
        compactReason: CompactReason;
        phase: CompactPhase;
        trigger: CompactTrigger;
      },
    ): Promise<unknown>;
  };

  await runtimeInternals.compactActiveConversation(
    undefined,
    { traceId: "trace-plan-file-compact-reference" },
    [],
    {
      compactReason: CompactReason.UserRequested,
      phase: CompactPhase.StandaloneTurn,
      trigger: CompactTrigger.Manual,
    },
  );

  const resumedRuntime = new AgentRuntime(
    sessionId,
    {
      systemPrompt: "You are a compact plan-file reference test agent.",
      workingDirectory: "/workspace/unused-before-resume",
    },
    {
      eventStore,
      fileSystemPort,
      modelAdapter: modelAdapter as never,
      sessionStore: store,
    },
  );

  await resumedRuntime.resumeFromStore();
  await resumedRuntime.executeTurn("continue after compact");

  const postResumeContext = requests
    .at(-1)
    ?.messages.map((message) => message.content)
    .join("\n");

  expect(postResumeContext).toContain("A plan file exists from plan mode at:");
  expect(postResumeContext).toContain(planMarker);
});
```

- [ ] **Step 2: Run compact test and confirm fail**

Run:

```bash
pnpm --filter @zcode/core test -- runtime-compact.test.ts -t "persists approved plan file reference after compact"
```

Expected: FAIL because `compactActiveConversation()` only appends read-state reminders today.

### Task 4.2: Append plan file reference before generic read-state reminders

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`

**Interfaces:**
- Consumes: `readApprovedPlanFileReferenceEntry()`.
- Produces: `postCompactReminderEntries` includes `plan_file_reference` first when plan file exists.

- [ ] **Step 1: Import helper**

In `compact-active.ts`, import:

```ts
  readApprovedPlanFileReferenceEntry,
```

from `../helpers/index.js`.

- [ ] **Step 2: Build plan reference entry before read-state entries**

Replace:

```ts
      const postCompactReminderEntries = buildPostCompactReadStateReminderEntries({
        preservedEntries,
        readFileState: this.readFileState,
      });
```

with:

```ts
      const planFileReferenceEntry = this.fileSystemPort
        ? await readApprovedPlanFileReferenceEntry({
            abortSignal: options.abortSignal,
            fileSystemPort: this.fileSystemPort,
            sessionId: this.sessionId,
            traceContext: modelTraceContext,
            workspaceRoot: this.workspaceRoot,
          })
        : undefined;
      const postCompactReminderEntries = [
        ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
        ...buildPostCompactReadStateReminderEntries({
          preservedEntries,
          readFileState: this.readFileState,
        }),
      ];
```

- [ ] **Step 3: Run focused compact tests**

Run:

```bash
pnpm --filter @zcode/core test -- runtime-compact.test.ts -t "persists approved plan file reference after compact"
```

Expected: PASS.

- [ ] **Step 4: Run reminder/helper/plan-mode focused suite**

Run:

```bash
pnpm --filter @zcode/core test -- plan-file-continuity.test.ts plan-mode-tool.test.ts system-reminder-source.test.ts runtime-compact.test.ts
```

Expected: PASS for the four targeted files.

---

## Phase 5: Regression Guardrails

### Task 5.1: 确认 provider-visible tool schema 没有被小 hack 改动

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

**Interfaces:**
- Consumes: existing `ExitPlanModeInputSchema`.
- Produces: guard that provider-visible schema still exposes `plan` until the full plan-file schema work starts.

- [ ] **Step 1: Add or update tool-contract assertion**

In the plan-mode portion of `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`, ensure there is an assertion equivalent to:

```ts
expect(exitPlanModeContract.inputSchema).toHaveProperty("properties.plan");
expect(exitPlanModeContract.inputSchema).not.toHaveProperty("properties.planFilePath");
expect(exitPlanModeContract.inputSchema).not.toHaveProperty("properties.filePath");
```

- [ ] **Step 2: Run contract test**

Run:

```bash
pnpm --filter @zcode/core test -- tool-contracts.test.ts
```

Expected: PASS. Any failure blocks completion until its source is identified; do not edit unrelated files while diagnosing this gate.

### Task 5.2: Provider-visible compact evidence check

**Files:**
- No file changes.

**Interfaces:**
- Produces: evidence that acceptance is provider context, not just helper output.

- [ ] **Step 1: Inspect the focused compact test output**

Run:

```bash
pnpm --filter @zcode/core test -- runtime-compact.test.ts -t "persists approved plan file reference after compact" --reporter verbose
```

Expected: PASS. The assertion must inspect the post-resume provider request messages and must include both `A plan file exists from plan mode at:` and `E2E_PLAN_FILE_COMPACT_CONTINUITY_MARKER`.

---

## Phase 6: Conversation E2E Spec and Visual Window Validation

### Task 6.1: 先补 catalog 和 coverage matrix

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Produces: accepted product case before E2E code, as required by conversation-session workflow.

- [ ] **Step 1: Add catalog case**

In `docs/conversation-session-case-catalog.md`, add a new accepted row in the plan approval / tool interaction area with these fields:

```markdown
| P01 | `completed(success)` 或 `plan` flow，用户批准 `ExitPlanMode` 后立即触发 `/compact` | approve plan -> `/compact` -> resume/continue | planFileReferenceAfterCompact | 已批准 plan 写入 `.zcode/plans/plan-${sessionId}.md`；compact 成功后后续 provider context 包含 `plan_file_reference` 路径和完整 plan 内容；UI 不出现错误 banner，session 可继续完成下一轮 | accepted |
```

Before editing, run:

```bash
rg -n "^\\| P01 \\|" docs/conversation-session-case-catalog.md docs/testing/conversation-session-e2e-coverage-matrix.md
```

Expected: no output. A match means the plan ID is already occupied and implementation must stop for a user decision instead of inventing another ID.

- [ ] **Step 2: Add matrix abbreviation**

In `docs/testing/conversation-session-e2e-coverage-matrix.md`, add:

```markdown
| `PFC` | `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts` |
```

Then add the coverage row for the catalog ID chosen above:

```markdown
| P01 | covered | PFC | manual-review pending：可视化窗口验证 plan approval、plan file 落盘、manual compact completed、后续 provider request 包含 `plan_file_reference` 和唯一 plan marker；review 通过后移动到默认 conversation E2E |
```

- [ ] **Step 3: Run coverage audit**

Run:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
```

Expected: PASS. When the audit reports count drift, update the matrix statistics with the exact counts printed by the audit and rerun this command until it passes.

### Task 6.2: 写 pending manual-review E2E

**Files:**
- Create: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`

**Interfaces:**
- Consumes: existing helpers from `conversation-session-plan-approval-feedback-user-message.test.ts` and `conversation-session-compact.test.ts`.
- Produces: an E2E that drives the visible desktop window and asserts plan continuity after compact.

- [ ] **Step 1: Create E2E spec**

Create `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_WORKSPACE,
  clearAppData,
} from "../../../helpers/desktop-app.js";
import {
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolName,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const PROMPT_MARKER = "E2E_PLAN_FILE_COMPACT_CONTINUITY_PROMPT";
const PLAN_MARKER = "E2E_PLAN_FILE_COMPACT_CONTINUITY_MARKER";
const ENTER_MARKER = "E2E_PLAN_FILE_COMPACT_CONTINUITY_ENTER";
const EXIT_MARKER = "E2E_PLAN_FILE_COMPACT_CONTINUITY_EXIT";
const COMPACT_COMMAND = "/compact";

describe("conversation session plan file compact continuity", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps approved ExitPlanMode plan available after manual compact", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: enter plan mode and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode before drafting.`,
      `${EXIT_MARKER}: call ExitPlanMode with an implementation plan containing ${PLAN_MARKER}_${runId}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "composer should clear after sending plan prompt");
    await waitForUserMessageContaining(PROMPT_MARKER);

    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "initial plan mode request",
      60000,
    );
    await waitForToolCallBlockByToolName("EnterPlanMode", 60000);

    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_approval_enter_plan_mode"],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "exit plan mode request",
      60000,
    );
    await waitForToolCallBlockByToolName("ExitPlanMode", 60000);

    await approvePlan();
    await waitForAssistantMessageContaining("deepseek-e2e-ok");

    const planFile = await waitForPlanFileContaining(`${PLAN_MARKER}_${runId}`, 30000);
    expect(planFile.path).toContain(".zcode");
    expect(planFile.path).toContain("plans");

    await sendPrompt(COMPACT_COMMAND);
    await waitForComposerText("", "/compact should clear composer");
    await waitForUpstreamRequest(
      {
        includes: ["CRITICAL: Respond with TEXT ONLY"],
        excludes: ["Generate a concise title"],
      },
      "manual compact summary request",
      90000,
    );

    await sendPrompt(`continue after compact and mention ${PLAN_MARKER}_${runId}`);
    await waitForUpstreamRequest(
      {
        includes: [
          "A plan file exists from plan mode at:",
          `${PLAN_MARKER}_${runId}`,
        ],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "post compact continuation request",
      90000,
    );
    await waitForAssistantMessageContaining("deepseek-e2e-ok");
  });
});

async function approvePlan() {
  const approveButton = await $("//button[contains(., 'Approve') or contains(., '批准')]");
  await approveButton.waitForClickable({ timeout: 30000 });
  await approveButton.click();
}

async function waitForPlanFileContaining(
  marker: string,
  timeoutMs: number,
): Promise<{ content: string; path: string }> {
  let latestError = "";
  await browser.waitUntil(
    async () => {
      try {
        const result = await readLatestPlanFile();
        if (result.content.includes(marker)) return true;
        latestError = `latest plan file did not include marker: ${result.path}`;
        return false;
      } catch (error) {
        latestError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Timed out waiting for plan file containing ${marker}: ${latestError}`,
    },
  );

  return readLatestPlanFile();
}

async function readLatestPlanFile(): Promise<{ content: string; path: string }> {
  const planDir = join(DEFAULT_WORKSPACE, ".zcode", "plans");
  const planFiles = await browser.electron.execute((dir) => {
    const { readdirSync, statSync } = require("node:fs");
    const { join } = require("node:path");
    return readdirSync(dir)
      .filter((name: string) => name.endsWith(".md"))
      .map((name: string) => {
        const path = join(dir, name);
        return { mtimeMs: statSync(path).mtimeMs, path };
      })
      .sort((left: { mtimeMs: number }, right: { mtimeMs: number }) => right.mtimeMs - left.mtimeMs);
  }, planDir);
  const latest = planFiles[0];
  if (!latest) throw new Error(`No plan file found under ${planDir}`);
  return {
    content: await readFile(latest.path, "utf8"),
    path: latest.path,
  };
}
```

- [ ] **Step 2: Run TypeScript check for E2E**

Run:

```bash
pnpm --filter @zcode/desktop typecheck:e2e
```

Expected: PASS.

### Task 6.3: 用可视化窗口运行 pending E2E 并人工确认

**Files:**
- Uses: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`

**Interfaces:**
- Produces: visual evidence that plan approval dialog, compact marker, and final assistant completion behave as expected.

- [ ] **Step 1: Run the pending E2E in visual/manual-review mode**

Run:

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts'
```

Expected:
- A desktop app window opens.
- The visible chat shows the original user prompt.
- `EnterPlanMode` and `ExitPlanMode` tool blocks render.
- The plan approval dialog appears and is approved by the test.
- No `ChatViewErrorBanner` or `ChatErrorBanner` appears.
- After `/compact`, the compact marker reaches completed.
- The final continuation finishes with an assistant message containing `deepseek-e2e-ok`.
- Test process exits PASS.

- [ ] **Step 2: Inspect artifacts from the visual run**

Check the E2E output path printed by WDIO and verify:

```bash
rg -n "A plan file exists from plan mode at:|E2E_PLAN_FILE_COMPACT_CONTINUITY_MARKER|ChatViewErrorBanner|ChatErrorBanner" packages/desktop/.e2e-artifacts packages/desktop/.e2e-home
```

Expected:
- At least one provider capture contains `A plan file exists from plan mode at:`.
- At least one provider capture contains `E2E_PLAN_FILE_COMPACT_CONTINUITY_MARKER`.
- No artifact line indicates a visible `ChatViewErrorBanner` or `ChatErrorBanner` for this positive case.

### Task 6.4: Promote, fill fixtures, replay, and run final gates

**Files:**
- Move after visual pass:
  - From: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`
  - To: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`
- Modify after move:
  - `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Produces: stable default conversation E2E coverage and fixture replay.

- [ ] **Step 1: Move spec out of manual-review pending**

Run:

```bash
pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts --reviewed --apply
```

Expected:
- spec moves to `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts`;
- promotion creates fixture shells under `packages/desktop/test/e2e/fixtures/upstream/conversation-session/` and `packages/desktop/test/e2e/fixtures/cases/conversation-session/`;
- coverage matrix `PFC` path is updated to:

```markdown
| `PFC` | `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts` |
```

Update the coverage row note to remove `manual-review pending` and mention the green visual run artifact id from Step 6.3.

- [ ] **Step 2: Fill deterministic replay fixture from the reviewed capture**

Open the visual run capture artifact printed by Step 6.3 and classify requests:

```bash
rg -n "E2E_PLAN_FILE_COMPACT_CONTINUITY|A plan file exists from plan mode at:|CRITICAL: Respond with TEXT ONLY|Generate a concise title" packages/desktop/.e2e-artifacts packages/desktop/.e2e-home
```

Write the case-local provider fixture at:

```text
packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-plan-file-compact-continuity.json
```

The fixture must include exactly these main requests:
- initial plan-mode request containing `E2E_PLAN_FILE_COMPACT_CONTINUITY_PROMPT`;
- exit-plan request containing `E2E_PLAN_FILE_COMPACT_CONTINUITY_EXIT`;
- manual compact summary request containing `CRITICAL: Respond with TEXT ONLY`;
- post-compact continuation request containing `A plan file exists from plan mode at:` and `E2E_PLAN_FILE_COMPACT_CONTINUITY_MARKER`.

The fixture may reuse `packages/desktop/test/e2e/fixtures/upstream/common.json` for title-generation responses and must not rely on legacy shared provider fixtures for the four main requests.

- [ ] **Step 3: Check fixture consistency**

Run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec './test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts'
```

Expected: PASS.

- [ ] **Step 4: Replay the promoted E2E through WDIO**

Run:

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/planning/conversation-session-plan-file-compact-continuity.test.ts'
```

Expected: PASS. The replay must assert `plan_file_reference` in the post-compact provider request, not only visible UI completion.

- [ ] **Step 5: Run conversation docs audit**

Run:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
```

Expected: PASS.

- [ ] **Step 6: Run final required gates**

Run:

```bash
pnpm --filter @zcode/core test -- plan-file-continuity.test.ts plan-mode-tool.test.ts system-reminder-source.test.ts runtime-compact.test.ts
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
```

Expected:
- Focused core tests PASS.
- E2E typecheck PASS.
- Repo typecheck PASS.
- Repo lint PASS.

- [ ] **Step 7: Stop without committing**

Run:

```bash
git status --short
```

Expected: shows the docs, core, tests, and E2E files changed by this implementation. Do not run `git commit`. Final handoff must include:
- plan file path written in this planning step,
- implementation files changed,
- visual E2E command and artifact id,
- final verification commands and results,
- explicit note: no commit was created.

---

## Acceptance Criteria

- `ExitPlanMode` provider-visible input schema still includes required `plan`.
- `ExitPlanMode` approved final plan is written to `${workspaceRoot}/.zcode/plans/plan-${sanitizedSessionId}.md`.
- `ExitPlanMode` file write failure prevents mode exit.
- compact after plan approval persists a `plan_file_reference` model-only reminder with full plan content.
- resume after compact preserves the reminder in the next provider-visible context.
- Generic read-state reminders remain independent and still skip `docs/superpowers/plans/`.
- Conversation-session catalog and coverage matrix include the new accepted case before E2E implementation.
- The E2E is run through a visible desktop window, passes, is promoted, and passes replay/fixture checks.
- `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, and `pnpm lint` pass or have clearly documented unrelated pre-existing failures.
- No commit is created automatically.

## Change Surface and Cost

- Core helper + source registry: low risk, about 0.5 day.
- `ExitPlanMode` handler write path and tests: low to medium risk, about 0.5 day because it changes approval failure behavior.
- compact runtime injection and provider-context regression test: medium risk, about 0.5 day because compact persistence/resume must be validated at provider-visible boundary.
- conversation docs + visual E2E + fixture promotion: medium cost, about 0.5-1 day depending on E2E capture stability.
- Total expected cost for this small hack with tests/docs/E2E: 1.5-2.5 engineering days.
- The full plan-file schema redesign remains outside this plan and should use the existing full plan-file plan as a separate project.

## Self-Review Checklist

- [ ] Every implementation task has exact files and commands.
- [ ] The plan keeps current `ExitPlanMode.plan` schema intact.
- [ ] The plan writes through `FileSystemPort`, not `node:fs` inside core runtime.
- [ ] The plan uses `workspaceRoot`, not `workingDirectory`, for plan file path.
- [ ] The compact reminder source is explicit `plan_file_reference`, not generic read-state.
- [ ] The E2E phase starts from docs catalog/matrix and ends with a visible-window run plus replay.
- [ ] The final step stops at `git status --short` and does not commit.
