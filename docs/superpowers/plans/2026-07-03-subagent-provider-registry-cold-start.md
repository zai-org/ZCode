# Subagent Provider Registry Cold Start Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 desktop local 和 remote workspace 中，subagent profile 绑定未被主会话使用过的 provider 时，CLI child runtime 找不到 provider config 的问题。

**Architecture:** 修复语义是“任何会执行 subagent 的 agent runtime，在 turn 前必须拥有完整 app provider registry”。实现上分两条链路：local desktop 由 `zcodeAgentService` 在 service 内部把 `providerRegistrySource` 的完整 registry 注入当前 CLI workspace；remote workspace 保持现有 `remoteWorkspaceProviderSync` 专用链路，不把 local 行为混进 remote replayable 语义。subagent 不负责 provider 注入，继续复用父 runtime 的 `modelAdapter`。

**Tech Stack:** TypeScript, `@zcode/protocol`, ZCode Services, React/UI remote sync guard tests, Vitest, ZCode Desktop WDIO E2E.

## Global Constraints

- 新增、修改功能一定要留 `spec` 或 plan 到 `docs`；本文件就是本 bugfix 的执行计划。
- 修复 bug 时要留下中文注释，说明出问题原因和为什么这么修。
- process / services 相关逻辑必须同时保证桌面端本地流程与手机端远程控制链路不受影响。
- 远程控制链路必须保持 desktop `continuous` 与 web remote `replayable` 的边界；本修复不改变 stream/snapshot/queue 恢复语义。
- `workspaceIdentity` / `workspacePath` 禁止混用；身份隔离 key 使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- 不修改 `Agent` tool schema，不把 provider config 放进 provider-visible tool input、child prompt 或 tool result。
- 不把 workspace provider registry sync 放进 runtime headers 热路径。
- 不重构 `packages/ui/src/lib/remoteWorkspaceProviderSync.ts` 的现有 remote 语义。
- 修改完成后执行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`。
- 回归 E2E 使用正式 failing case：`packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts`。

---

## Root Cause

已提交的 `SR / I14` E2E 证明当前链路里：

- subagent profile 已加载，`custom:e2e-deepseek-alt:deepseek-v4-pro` 也被解析成 child model ref。
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 创建 child runtime 时复用父 runtime 的 `this.modelAdapter`。
- local cold start 时，CLI workspace catalog / model adapter 只有主会话 primary provider；alternate provider 没有被完整 app registry 注入。
- child runtime resolve `e2e-deepseek-alt/deepseek-v4-pro` 时抛 `Model provider is not configured: e2e-deepseek-alt`。

单个 `runtimeModel` 只能覆盖当前主会话模型，不能替代完整 provider registry。subagent profile 可能引用主会话没选中过的 provider，因此必须在 workspace/modelAdapter 层注入完整 registry。

## Decision

采用 **agent apply 水位线 + local service synchronizer + existing remote sync guard**：

1. **Agent apply boundary:** 在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` 的 `workspace/updateProviderRegistry` apply 边界记录 `providerRegistryGeneratedAt`。如果 incoming registry 的 `generatedAt` 早于当前已应用 registry，就返回当前 catalog，不覆盖 provider map。
2. **Local desktop:** 在 `packages/services/src/zcode-agent/zcodeAgentService.ts` 内新增 local provider registry synchronizer。只在 `providerRegistrySource` 存在时工作；remote attached host 没有该 source，自然不会走 local 分支。
3. **Local create/resume/read:** 在 `createSession`、`resumeSession`、`readSession`、`readWorkspaceState` 发协议请求前，确保当前 CLI client 已应用完整 provider registry。
4. **Local provider changes:** 扩展现有 `providerRegistrySource.onDidChangeProviderRegistry` 订阅。对 `activeClientsByWorkspaceKey` 里的本地 active workspace 先推完整 `workspace/updateProviderRegistry`，再更新已有 session 的 runtimeModel。
5. **Remote workspace:** 保持 `syncAppGlobalStateToRemoteWorkspace` / `syncWorkspaceModelProvidersToAgent` 原状。remote subagent 场景继续由现有 remote preflight 在 prepare/create/resume/send 前下发完整 registry；因为 remote 也走同一个 agent protocol apply 边界，所以 stale registry 保护同时覆盖 remote。

**Review adjustment:** `ProviderRegistrySnapshot.revision` 是 `sha256:*` 内容指纹，不具备大小顺序。stale 保护不应只放在 desktop service 发送前；所有入口最终都会落到 `workspace/updateProviderRegistry`，所以临时采用 `generatedAt` 在 agent apply 边界做 best-effort 水位。local synchronizer 也用单 workspace/client drain worker 串行下发 pending registry，并忽略比当前 pending/applied `generatedAt` 更旧的快照。旧 `generatedAt` 快照不能覆盖已应用的新 registry；同毫秒、系统时间回拨、不同机器时间漂移仍属于 best-effort 限制，长期方案应升级协议 CAS/单调 source sequence。

## Non-Goals

- 不把 `packages/ui/src/lib/remoteWorkspaceProviderSync.ts` 泛化为 local + remote 通用 helper。
- 不在 `getClient()` 里无条件同步 registry。
- 不在 `sendPrompt` 的 runtime headers 热路径里同步 workspace registry。
- 不修改 CLI subagent profile 解析或 child runtime 模型选择逻辑。
- 不在本任务里新增 Docker preset admission；修复后先跑本地 replay，Docker admission 另行处理。

## File Map

- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
  - 新增 service 内部 provider registry sync state 和 helper。
  - 在 local create/resume/read/readWorkspaceState 前同步完整 registry。
  - 在 provider registry changed event 中热推完整 registry 到 active local clients。
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
  - 在 `workspace/updateProviderRegistry` 的 apply 边界用 `providerRegistryGeneratedAt` 忽略 stale snapshot。
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`
  - 在 workspace model catalog record 上记录当前 registry snapshot 的 `generatedAt` 水位。
- Modify: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`
  - 增加 agent apply 边界单测：先应用新 `generatedAt` registry，再发送旧 `generatedAt` registry，旧快照不能覆盖当前 provider catalog。
- Modify: `packages/services/test/zcodeAgentService.providerRegistry.test.ts`
  - 增加 local session/create 前同步完整 registry 的红绿单测。
  - 增加 provider change 后 active workspace 热推 registry 的单测。
  - 增加 provider registry sync 并发时序单测：旧 in-flight 结束后再补发新 `generatedAt` registry，已应用新 registry 后忽略旧 `generatedAt` 事件。
  - 增加 public `updateProviderRegistry` stale 回包缓存边界单测：agent 没有应用本次入参时，service 不把该入参缓存成 remote workspace 的 provider registry。
  - 保持 runtime headers 不触发 workspace hot-sync 的既有测试。
- Read/Guard: `packages/ui/src/lib/remoteWorkspaceProviderSync.ts`
  - 不改实现，只通过现有 tests 证明 remote 专用链路未被破坏。
- Read/Guard: `packages/ui/test/remoteWorkspaceProviderSync.test.ts`
  - 跑现有 remote sync 测试。
- Read/Guard: `packages/ui/test/zcodeSessionPromptControl.test.ts`
  - 跑现有 create/resume/send 前 remote preflight 顺序测试。
- Modify after E2E green: `docs/testing/conversation-session-e2e-coverage-matrix.md`
  - 仅在 E2E 通过后，把 I14 从 `failing` 改为 `covered`。

---

## Phase 0: Baseline Red Evidence

**Files:**
- Test: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts`
- Fixture: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-provider-registry-cold-start.json`

**Interfaces:**
- Consumes: committed failing E2E `SR / I14`.
- Produces: baseline artifact proving current bug is still red before implementation.

- [ ] **Step 1: Validate fixture contract**

Run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts
```

Expected:

```text
Fixture check passed.
```

The title fixture may warn that its matcher has no E2E marker. That warning is acceptable because title generation is not this case's product assertion.

- [ ] **Step 2: Confirm the current E2E is red**

Run:

```bash
ZCODE_DESKTOP_AGENT_BUILD_MODE=pnpm \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-provider-registry-cold-start.json \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts'
```

Expected before fix: FAIL with:

```text
没有捕获到 alternate provider 的 child subagent 请求
```

The failure diagnostics should list child marker candidates using `deepseek-v4-flash`, not `deepseek-v4-pro`.

- [ ] **Step 3: Stop if the E2E unexpectedly passes**

If the E2E already passes before code changes, inspect recent commits and update this plan instead of applying duplicate sync logic.

---

## Phase 1: Add Local Provider Registry Sync Tests

**Files:**
- Modify: `packages/services/test/zcodeAgentService.providerRegistry.test.ts`

**Interfaces:**
- Consumes: `createZCodeAgentService({ providerRegistrySource })`.
- Consumes: `zcodeProtocolMethods.workspaceUpdateProviderRegistry`.
- Produces: tests that require full registry sync before local session/create and after local provider registry changes.

- [ ] **Step 1: Add test for session/create preflight**

Add this test to `describe("createZCodeAgentService provider registry", ...)`:

```ts
it("syncs the full local provider registry before session/create", async () => {
  const calls: string[] = [];
  const request = vi.fn(async (method: string) => {
    calls.push(method);
    if (method === zcodeProtocolMethods.workspaceUpdateProviderRegistry) {
      return {
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
        appliedProviderRevision: "sha256:provider-registry-full",
        status: "applied" as const,
        providerCount: 2,
      };
    }
    if (method === zcodeProtocolMethods.sessionCreate) {
      return createSessionSnapshot({
        model: { providerId: "e2e-primary", modelId: "deepseek-v4-flash" },
      });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      async getClient() {
        return {
          request,
          transportKind: "stdio",
          onNotification: () => ({ dispose() {} }),
          onRequest: () => ({ dispose() {} }),
          onClose: () => ({ dispose() {} }),
        };
      }
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import(
    "../src/zcode-agent/zcodeAgentService.js"
  );
  const service = createZCodeAgentService({
    providerRegistrySource: {
      async getProviderRegistrySnapshot() {
        return {
          generatedAt: 2,
          providers: [
            {
              providerId: "e2e-primary",
              kind: "anthropic",
              baseURL: "https://primary.example.com",
              models: [{ modelId: "deepseek-v4-flash" }],
            },
            {
              providerId: "e2e-alt",
              kind: "anthropic",
              baseURL: "https://alt.example.com",
              models: [{ modelId: "deepseek-v4-pro" }],
            },
          ],
          revision: "sha256:provider-registry-full",
        };
      },
    },
  });

  await service.createSession({
    workspacePath: "/workspace/app",
    model: { providerId: "e2e-primary", modelId: "deepseek-v4-flash" },
  });

  expect(calls).toEqual([
    zcodeProtocolMethods.workspaceUpdateProviderRegistry,
    zcodeProtocolMethods.sessionCreate,
  ]);
  expect(request).toHaveBeenNthCalledWith(
    1,
    zcodeProtocolMethods.workspaceUpdateProviderRegistry,
    expect.objectContaining({
      registry: expect.objectContaining({
        revision: "sha256:provider-registry-full",
        providers: expect.arrayContaining([
          expect.objectContaining({ providerId: "e2e-alt" }),
        ]),
      }),
      workspace: expect.objectContaining({
        workspacePath: "/workspace/app",
        workspaceKey: "/workspace/app",
      }),
      includeWorkspaceState: false,
    }),
    expect.any(Object),
  );
});
```

- [ ] **Step 2: Add test for provider registry change hot push**

Add a tiny event source in the test file:

```ts
function createProviderRegistryChangeSource(initial: ZCodeProviderRegistrySnapshot) {
  let listener:
    | ((event: { reason: string; snapshot: ZCodeProviderRegistrySnapshot }) => void)
    | undefined;
  return {
    source: {
      async getProviderRegistrySnapshot() {
        return initial;
      },
      onDidChangeProviderRegistry(callback) {
        listener = callback;
        return { dispose() {} };
      },
    },
    emit(reason: string, snapshot: ZCodeProviderRegistrySnapshot) {
      listener?.({ reason, snapshot });
    },
  };
}
```

Then add this test:

```ts
it("pushes changed local provider registry to active workspace clients", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === zcodeProtocolMethods.workspaceUpdateProviderRegistry) {
      return {
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
        appliedProviderRevision: "sha256:registry",
        status: "applied" as const,
        providerCount: 1,
      };
    }
    if (method === zcodeProtocolMethods.sessionCreate) {
      return createSessionSnapshot({
        model: { providerId: "e2e-primary", modelId: "deepseek-v4-flash" },
      });
    }
    if (method === zcodeProtocolMethods.sessionUpdateRuntimeModelConfig) {
      return {
        sessionId: "sess_1",
        modelRuntimeRevision: "model-runtime:updated",
        stateRevision: 2,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      async getClient() {
        return {
          request,
          transportKind: "stdio",
          onNotification: () => ({ dispose() {} }),
          onRequest: () => ({ dispose() {} }),
          onClose: () => ({ dispose() {} }),
        };
      }
      disposeAll() {}
    },
  }));
  const initial = {
    generatedAt: 1,
    providers: [
      {
        providerId: "e2e-primary",
        kind: "anthropic" as const,
        baseURL: "https://primary.example.com",
        models: [{ modelId: "deepseek-v4-flash" }],
      },
    ],
    revision: "sha256:registry-1",
  };
  const changed = {
    generatedAt: 2,
    providers: [
      ...initial.providers,
      {
        providerId: "e2e-alt",
        kind: "anthropic" as const,
        baseURL: "https://alt.example.com",
        models: [{ modelId: "deepseek-v4-pro" }],
      },
    ],
    revision: "sha256:registry-2",
  };
  const providerRegistrySource = createProviderRegistryChangeSource(initial);
  const { createZCodeAgentService } = await import(
    "../src/zcode-agent/zcodeAgentService.js"
  );
  const service = createZCodeAgentService({
    providerRegistrySource: providerRegistrySource.source,
  });

  await service.createSession({
    workspacePath: "/workspace/app",
    model: { providerId: "e2e-primary", modelId: "deepseek-v4-flash" },
  });
  providerRegistrySource.emit("provider_saved", changed);
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith(
      zcodeProtocolMethods.workspaceUpdateProviderRegistry,
      expect.objectContaining({
        registry: expect.objectContaining({
          revision: "sha256:registry-2",
          providers: expect.arrayContaining([
            expect.objectContaining({ providerId: "e2e-alt" }),
          ]),
        }),
      }),
      expect.any(Object),
    );
  });
});
```

If TypeScript complains about the inline source type, type the helper as:

```ts
import type { Event } from "@zcode/rpc";
```

and return the callback as an `Event<ModelProviderRegistryChangedEvent>` using the local event shape already exported by services. Do not weaken the production type.

- [ ] **Step 3: Verify tests fail before implementation**

Run:

```bash
pnpm exec vitest run packages/services/test/zcodeAgentService.providerRegistry.test.ts
```

Expected before implementation: the new tests fail because `session/create` currently happens before `workspace/updateProviderRegistry`, and registry change does not hot-push full workspace registry.

---

## Phase 2: Implement Agent Apply Waterline and Local Service Synchronizer

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`

**Interfaces:**
- Consumes: `providerRegistrySource?: ZCodeProviderRegistrySource`.
- Consumes: `ZCodeProtocolClient.request(zcodeProtocolMethods.workspaceUpdateProviderRegistry, ...)`.
- Produces: agent-side stale snapshot guard plus private helpers that sync complete provider registry to local active CLI clients without touching remote helper code.

- [ ] **Step 1: Add agent-side registry generatedAt waterline**

In `ZCodeProtocolWorkspaceModelCatalogRecord`, add:

```ts
  providerRegistryGeneratedAt?: number;
```

In `workspace/updateProviderRegistry`:

- Log `incomingGeneratedAt` and previous applied `providerRegistryGeneratedAt`.
- Before mutating `catalog.providers`, if `catalog.providerRevision` and `catalog.providerRegistryGeneratedAt` are both present and `params.registry.generatedAt < catalog.providerRegistryGeneratedAt`, return the current catalog as `status: "unchanged"` and do not clear or rewrite providers/secrets.
- If the revision is unchanged, update `providerRegistryGeneratedAt` to `Math.max(current, params.registry.generatedAt)`.
- After a successful registry apply, set `catalog.providerRevision = params.registry.revision` and `catalog.providerRegistryGeneratedAt = params.registry.generatedAt`.
- When legacy `workspace/upsertModelProvider` or `workspace/removeModelProvider` mutates the catalog outside registry snapshots, clear both `providerRevision` and `providerRegistryGeneratedAt`.

Add a Chinese bugfix comment at the stale guard explaining:

```ts
// Bugfix: workspace/updateProviderRegistry 可能从 session preflight、热同步、远端同步等入口并发到达。
// revision 是 sha256 指纹不能排序，所以在真正 apply 边界用 generatedAt 做 best-effort 水位线，
// 避免较旧快照晚到时把 CLI 内部 catalog 覆盖回旧 provider 集合。
```

- [ ] **Step 2: Add workspace sync state**

Near existing maps in `createZCodeAgentService`, add:

```ts
  const providerRegistrySyncByWorkspaceKey = new Map<
    string,
    {
      client: ZCodeProtocolClient;
      generatedAt?: number;
      inFlight?: Promise<void>;
      pending?: {
        includeWorkspaceState: boolean;
        reason: string;
        registry: ZCodeProviderRegistrySnapshot;
      };
      revision?: string;
    }
  >();
```

This state is separate from `providerRegistryByWorkspaceKey`. The latter is still used by desktop-attached remote fallback; this new map records whether a concrete protocol client has already received a local registry revision and serializes local delivery. Do not use this service-side map as the stale snapshot correctness boundary; that boundary lives in agent apply code.

- [ ] **Step 3: Clear sync state when a client closes**

Inside `wireClient(... onClose ...)`, where the code already deletes `providerRegistryByWorkspaceKey`, also delete the new sync state:

```ts
            providerRegistrySyncByWorkspaceKey.delete(workspaceKey);
```

Add a Chinese comment immediately above or near the new delete:

```ts
            // Bugfix: provider registry 是 CLI 进程内存态；client 重建后即使 app revision 没变也必须重推。
```

- [ ] **Step 4: Add private sync helper**

Add `syncProviderRegistrySnapshotToClient(...)` before `resolveRuntimeModelConfig`.

Required behavior:

- Resolve `workspaceKey` with `resolveWorkspaceKey(params.workspace)`.
- Keep one sync state per concrete workspace/client.
- Incoming snapshots older than the current pending/applied `generatedAt` are ignored after awaiting any current in-flight worker.
- Incoming snapshots not older than the current pending/applied `generatedAt` become `pending`; if a worker is already running, callers await that worker.
- The drain worker sends one `workspace/updateProviderRegistry` at a time with the merged `includeWorkspaceState` flag.
- When the worker sees a pending snapshot older than the applied `generatedAt`, it logs and skips it instead of sending stale registry to CLI.
- Only cache `params.registry` into `providerRegistryByWorkspaceKey` and `providerRegistrySyncByWorkspaceKey.revision` when `result.appliedProviderRevision === params.registry.revision`. If agent ignored this request as stale and returned a different applied revision, do not cache the stale input.

This helper is a delivery/cache optimization and a session preflight. It is not the final stale snapshot correctness guard.

- [ ] **Step 5: Add local-only ensure helper**

Add:

```ts
  async function ensureLocalProviderRegistrySynced(params: {
    client: ZCodeProtocolClient;
    includeWorkspaceState?: boolean;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    if (!providerRegistrySource) {
      return;
    }
    const registry = await providerRegistrySource.getProviderRegistrySnapshot();
    // Bugfix: 本地 desktop 的 CLI 不读取 app provider store；session create/resume/read 前
    // 必须先注入完整 registry，否则 subagent profile 引用未选中过的 provider 会 provider_not_found。
    await syncProviderRegistrySnapshotToClient({
      client: params.client,
      includeWorkspaceState: params.includeWorkspaceState,
      registry,
      reason: params.reason,
      workspace: params.workspace,
    });
  }
```

This helper must return immediately when `providerRegistrySource` is absent or the target is a desktop-attached remote workspace. That keeps desktop-attached remote behavior on the existing remote sync path.

- [ ] **Step 6: Guard public updateProviderRegistry cache**

In `async updateProviderRegistry(params)`, keep the direct protocol request so the method still returns the protocol result to the caller. After the response, only update local pushed-registry cache when the agent actually applied this input revision.

Low-risk implementation:

```ts
      const result = await client.request(
        zcodeProtocolMethods.workspaceUpdateProviderRegistry,
        {
          workspace: buildWorkspaceRef(params),
          registry: params.registry,
          ...(typeof params.includeWorkspaceState === "boolean"
            ? { includeWorkspaceState: params.includeWorkspaceState }
            : {}),
        },
        zcodeWorkspaceUpdateProviderRegistryResultSchema,
      );
      if (result.appliedProviderRevision === params.registry.revision) {
        providerRegistryByWorkspaceKey.set(resolveWorkspaceKey(params), params.registry);
        providerRegistrySyncByWorkspaceKey.set(resolveWorkspaceKey(params), {
          client,
          revision: params.registry.revision,
        });
      }
```

Do not change this method's external contract.

---

## Phase 3: Wire Local Sync Into Session Read/Create/Resume

**Files:**
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`

**Interfaces:**
- Consumes: `ensureLocalProviderRegistrySynced(...)`.
- Produces: local CLI has full provider registry before session creation, session resume, session read, and workspace state reads.

- [ ] **Step 1: Sync before session/create**

In `createSession`, after:

```ts
      const client = await getClient(params);
```

add:

```ts
      await ensureLocalProviderRegistrySynced({
        client,
        reason: "session_create",
        workspace: params,
      });
```

Keep this before `resolveRuntimeModelConfig(...)` so `session/create` and runtime model fallback both see a CLI workspace whose catalog has already been updated.

- [ ] **Step 2: Sync before session/resume**

In `resumeSession`, after `const client = await getClient(params);`, add:

```ts
      await ensureLocalProviderRegistrySynced({
        client,
        reason: "session_resume",
        workspace: params,
      });
```

Keep `allowDefaultModelForSession: false` unchanged. The registry sync must not make old sessions silently fall back to a different current workspace model.

- [ ] **Step 3: Sync before readSession and readWorkspaceState**

In `readSession`, after `const client = await getClient(params);`, add:

```ts
      await ensureLocalProviderRegistrySynced({
        client,
        reason: "session_read",
        workspace: params,
      });
```

In `readWorkspaceState`, after `const client = await getClient(params);`, add:

```ts
      await ensureLocalProviderRegistrySynced({
        client,
        includeWorkspaceState: false,
        reason: "workspace_read_state",
        workspace: params,
      });
```

Do not add this to `respondProviderRuntimeHeaders`. Do not add a blanket sync to every `sendPrompt`.

- [ ] **Step 4: Run service tests**

Run:

```bash
pnpm exec vitest run packages/services/test/zcodeAgentService.providerRegistry.test.ts
```

Expected: PASS.

---

## Phase 4: Hot Push Local Provider Registry Changes

**Files:**
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Test: `packages/services/test/zcodeAgentService.providerRegistry.test.ts`

**Interfaces:**
- Consumes: `providerRegistrySource.onDidChangeProviderRegistry`.
- Produces: active local workspace clients receive full registry updates when provider config changes.

- [ ] **Step 1: Extract existing runtimeModel event work into an async function**

Replace the current inline event body with a call:

```ts
  let providerRegistrySubscription = providerRegistrySource?.onDidChangeProviderRegistry?.(
    (event) => {
      void handleProviderRegistryChanged(event).catch((error) => {
        console.warn(
          formatLogPrefix("zcode-agent", process.pid),
          "provider registry 热同步失败",
          { message: error instanceof Error ? error.message : String(error) },
        );
      });
    },
  );
```

- [ ] **Step 2: Implement `handleProviderRegistryChanged`**

Add this function near the subscription:

```ts
  async function handleProviderRegistryChanged(event: ModelProviderRegistryChangedEvent) {
    if (providerRegistrySource) {
      await Promise.all(
        Array.from(activeClientsByWorkspaceKey.entries()).map(
          async ([workspaceKey, active]) => {
            await syncProviderRegistrySnapshotToClient({
              client: active.client,
              registry: event.snapshot,
              reason: event.reason,
              workspace: active.workspace,
            });
            logger.info(undefined, "provider registry 变更已推送到本地 active workspace", {
              providerCount: event.snapshot.providers.length,
              reason: event.reason,
              revision: event.snapshot.revision,
              workspaceKey,
              workspacePath: active.workspace.workspacePath,
            });
          },
        ),
      );
    }

    for (const [key, previousRuntimeModel] of runtimeModelConfigBySessionKey) {
      const target = runtimeModelSessionTargetByKey.get(key);
      if (!target) {
        continue;
      }
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(target));
      if (!active) {
        continue;
      }
      const runtimeModel = createRuntimeModelConfig({
        model: previousRuntimeModel.model,
        providerRegistry: event.snapshot,
        thoughtLevel: previousRuntimeModel.thoughtLevel,
      });
      if (!runtimeModel || runtimeModel.revision === previousRuntimeModel.revision) {
        continue;
      }
      await updateRuntimeModelConfigOnClient({ ...target, runtimeModel }, active.client);
    }
  }
```

If `ModelProviderRegistryChangedEvent` is not imported in this file, import it from the existing model-provider type source instead of using `any`.

- [ ] **Step 3: Keep failure isolation**

If one workspace fails to update, it should not prevent other active workspaces from receiving the new registry. If the direct `Promise.all` in Step 2 is too brittle for existing conventions, use:

```ts
      await Promise.allSettled(
        Array.from(activeClientsByWorkspaceKey.entries()).map(async ([workspaceKey, active]) => {
          try {
            await syncProviderRegistrySnapshotToClient({
              client: active.client,
              registry: event.snapshot,
              reason: event.reason,
              workspace: active.workspace,
            });
          } catch (error) {
            logger.warn(undefined, "provider registry 变更推送到 active workspace 失败", {
              message: error instanceof Error ? error.message : String(error),
              reason: event.reason,
              revision: event.snapshot.revision,
              workspaceKey,
              workspacePath: active.workspace.workspacePath,
            });
            throw error;
          }
        }),
      );
```

Pick one style and keep tests aligned. Prefer `Promise.allSettled` if the product expectation is “一个 workspace 同步失败不影响其他 workspace”。

- [ ] **Step 4: Run focused tests again**

Run:

```bash
pnpm exec vitest run packages/services/test/zcodeAgentService.providerRegistry.test.ts
```

Expected: PASS.

---

## Phase 5: Remote Workspace Guard

**Files:**
- Read/Guard: `packages/ui/src/lib/remoteWorkspaceProviderSync.ts`
- Read/Guard: `packages/ui/test/remoteWorkspaceProviderSync.test.ts`
- Read/Guard: `packages/ui/test/zcodeSessionPromptControl.test.ts`
- Read/Guard: `packages/ui/src/lib/zcodeSessionPromptControl.ts`

**Interfaces:**
- Consumes: existing remote provider registry preflight.
- Produces: evidence that remote subagent users remain covered and remote helper semantics were not changed.

- [ ] **Step 1: Do not modify remote sync implementation**

Keep these exports and their behavior unchanged:

```ts
syncAppGlobalStateToRemoteWorkspace(...)
syncWorkspaceModelProvidersToAgent(...)
syncWorkspaceModelProvidersToRemote(...)
```

Remote workspace remains responsible for receiving full app provider registry from desktop host before prepare/create/resume/send. This is still required because remote host does not have local `providerRegistrySource`.

- [ ] **Step 2: Run remote sync tests**

Run:

```bash
pnpm exec vitest run packages/ui/test/remoteWorkspaceProviderSync.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run prompt-control preflight ordering tests**

Run:

```bash
pnpm exec vitest run packages/ui/test/zcodeSessionPromptControl.test.ts
```

Expected: PASS, including tests that verify remote/replayable create/resume/send call `syncAppGlobalStateBeforeRemoteSession` before agent commands.

- [ ] **Step 4: Inspect changed files**

Run:

```bash
git diff -- packages/ui/src/lib/remoteWorkspaceProviderSync.ts packages/ui/src/lib/zcodeSessionPromptControl.ts
```

Expected:

```text
no diff for packages/ui/src/lib/remoteWorkspaceProviderSync.ts
```

If remote helper changed, stop and explain why the change is necessary before continuing.

---

## Phase 6: E2E Acceptance

**Files:**
- Test: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts`
- Fixture: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-provider-registry-cold-start.json`
- Modify after green: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Consumes: local service provider registry preflight.
- Produces: provider-visible child subagent request using alternate provider model.

- [ ] **Step 1: Re-run fixture check**

Run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts
```

Expected: PASS with the known title fixture warning.

- [ ] **Step 2: Run case-local replay**

Run:

```bash
ZCODE_DESKTOP_AGENT_BUILD_MODE=pnpm \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-provider-registry-cold-start.json \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/subagents/conversation-session-subagent-provider-registry-cold-start.test.ts'
```

Expected after fix: PASS.

Acceptance evidence:

```text
child subagent request model = deepseek-v4-pro
parent continuation request model = deepseek-v4-flash
Agent tool block status = completed
session state = idle
queueCount = 0
```

- [ ] **Step 3: If E2E still fails, inspect runtime evidence**

Run:

```bash
rg "workspace/updateProviderRegistry|provider_not_found|e2e-deepseek-alt|deepseek-v4-pro" \
  packages/desktop/.e2e-home/.zcode/cli/log \
  packages/desktop/.e2e-artifacts
```

Expected after fix:

```text
workspace/updateProviderRegistry appears before child subagent request
no provider_not_found for e2e-deepseek-alt
```

- [ ] **Step 4: Update matrix only after E2E is green**

In `docs/testing/conversation-session-e2e-coverage-matrix.md`, change I14 from:

```markdown
| I14 | failing  | SR     | 正式 E2E 复现当前缺陷：冷启时 CLI 只有 primary runtime/config，subagent profile 绑定 alternate provider；当前实现未捕获到 alternate child 请求，修复后应最终 idle |
```

to:

```markdown
| I14 | covered  | SR     | 冷启时 CLI 只有 primary runtime/config，subagent profile 绑定 alternate provider；child subagent 请求使用 alternate provider 并最终 idle |
```

Do not mark `covered` before the replay passes.

---

## Phase 7: Repository Gates And Commit

**Files:**
- Existing changed files only.

**Interfaces:**
- Consumes: passing unit tests and E2E.
- Produces: a Conventional Commit containing only this bugfix and doc status update.

- [ ] **Step 1: Run required gates**

Run:

```bash
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
git diff --check
```

Expected:

```text
typecheck:e2e exits 0
typecheck exits 0
lint exits 0
git diff --check exits 0
```

If lint exits 0 with warnings, record the warning count and verify no warning was introduced by this fix.

- [ ] **Step 2: Check staged surface**

Run:

```bash
git status --short
git diff --stat
```

Expected changed files:

```text
packages/services/src/zcode-agent/zcodeAgentService.ts
packages/services/test/zcodeAgentService.providerRegistry.test.ts
docs/testing/conversation-session-e2e-coverage-matrix.md
```

`packages/ui/src/lib/remoteWorkspaceProviderSync.ts` should not appear unless a separate approved remote fix was added.

- [ ] **Step 3: Commit**

Run:

```bash
git add \
  packages/services/src/zcode-agent/zcodeAgentService.ts \
  packages/services/test/zcodeAgentService.providerRegistry.test.ts \
  docs/testing/conversation-session-e2e-coverage-matrix.md
git commit -m "fix(desktop): sync provider registry before local agent sessions"
```

Omit `docs/testing/conversation-session-e2e-coverage-matrix.md` from `git add` if E2E is still red and I14 remains `failing`.

---

## Final Checklist

- [ ] Local desktop session create/resume/read/readWorkspaceState sync complete provider registry before CLI session operations.
- [ ] Provider config changes hot-push complete registry to active local workspace clients.
- [ ] Remote workspace provider registry sync implementation remains unchanged.
- [ ] Remote preflight tests still pass.
- [ ] Runtime headers path does not trigger workspace registry hot-sync.
- [ ] `Agent` tool schema and provider-visible request shape are unchanged.
- [ ] Formal E2E captures child subagent request model `deepseek-v4-pro`.
- [ ] I14 is marked `covered` only after E2E passes.
- [ ] Required typecheck/lint/diff gates pass.

## Rollback Plan

If local provider registry sync introduces startup latency or repeated protocol calls:

1. Revert only `packages/services/src/zcode-agent/zcodeAgentService.ts`.
2. Keep the failing E2E and tests as evidence.
3. Re-run `packages/services/test/zcodeAgentService.providerRegistry.test.ts` to confirm the red local sync expectation returns.
4. Reconsider a narrower public `workspace/prepareProviderRegistry` protocol call, but keep remote helper untouched unless remote evidence requires a separate fix.
