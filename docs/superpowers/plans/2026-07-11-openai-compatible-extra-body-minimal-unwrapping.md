# OpenAI-compatible `extra_body` Minimal Unwrapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变既有模型 policy、namespace pass-through 与 provider 方言的前提下，将 canonical `openaiCompatible.extra_body` 浅展开到真实 Chat Completions body。

**Architecture:** 只在 `runner-options.ts` 的现有 canonical → provider-name 投影边界增加一个浅解包 helper，并继续复用已有 `mergePlainRecords`。非法 wrapper 复用 generate/stream 既有失败收口；正式 E2E 只更新现有 I14/I15，I17 作为 direct-field 对照。

**Tech Stack:** TypeScript、Vitest、AI SDK `@ai-sdk/openai-compatible`、WebdriverIO、case-local DeepSeek replay fixture。

## Global Constraints

- 不新增模型或 provider 特判、字段 allowlist、snake/camel alias、400 retry 或 model-io。
- 不修改 reasoning/default policy 或 models-dev snapshot。
- canonical `extra_body` 与 direct 字段只做顶层浅合并；direct 优先。
- 修复前已有的 generic → raw provider-name merge 和所有 sibling namespace pass-through 保持不变。
- 按 TDD 顺序先看到真实 AI SDK wire 测试失败，再修改生产代码。

---

### Task 1: 固化最小请求合同

**Files:**

- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: `apps/zcode-cli/packages/adapters/tests/runner-options.test.ts`
- Create: `apps/zcode-cli/packages/adapters/tests/openai-compatible-extra-body-wire.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/models/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts`
- Modify: `packages/desktop/test/e2e/helpers/upstream-capture.ts`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-glm52-reasoning-request-shape.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-gpt-openai-compatible-reasoning-effort.json`

**Interfaces:**

- Consumes: `createGenerateTextOptions()` / `createStreamTextOptions()` 与现有 I14/I15/I17 replay case。
- Produces: 最终 wire 不含 `extra_body`、GLM/DeepSeek 扩展字段位于顶层的可执行合同。

- [ ] **Step 1: 更新 NL 合同**

将 I14 改为顶层 `chat_template_kwargs`，I15 改为顶层 `thinking`，两者都明确最终 body 不含
`extra_body`；I17 明确作为 direct `reasoning_effort` 不回归对照。coverage matrix 同步相同语义。

- [ ] **Step 2: 修改 options 单测期望**

现有 GLM 用例必须期望：

```ts
expect(options.providerOptions).toEqual({
  openaiCompatible: {
    extra_body: {
      chat_template_kwargs: { reasoning_effort: "max" },
    },
  },
  "GLM52 E2E": {
    chat_template_kwargs: { reasoning_effort: "max" },
  },
});
```

补一条 pass-through 用例，输入 canonical、raw provider-name、camel sibling 和其他 namespace，
只断言 canonical 解包投影后的 raw 结果与修复前已有 override 语义，其他 sibling 原样保留。

再补一条 `extra_body: []` 用例，断言 options 构造抛出 code 为 `InvalidModelRequest`、消息为
`openaiCompatible.extra_body 必须是对象` 的 `AiSdkModelAdapterError`。

- [ ] **Step 3: 写真实 SDK wire 失败测试**

使用 `createOpenAICompatible({ fetch })`、fake API key 和 `generateText()`，输入：

```ts
openaiCompatible: {
  extra_body: { thinking: { type: "enabled" } },
  reasoningEffort: "max",
}
```

断言 capture body 包含顶层 `thinking`、`reasoning_effort: "max"`，并且不含 `extra_body`。

- [ ] **Step 4: 运行 RED**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- --run tests/openai-compatible-extra-body-wire.test.ts tests/runner-options.test.ts
```

Expected: FAIL；现有代码把 `extra_body` 原样复制到 provider-name namespace，wire body 仍包含 wrapper。

- [ ] **Step 5: 更新既有 E2E 合同但暂不运行通过声明**

I14/I15 改读顶层字段并断言 `extra_body` 为 `undefined`；I17 继续断言 direct
`reasoning_effort`。六个 main fixture matcher 的 `bodyExcludes` 加入 `extra_body`。共享
`upstream-capture.ts` 的 OpenAI Chat 分支改读顶层 `thinking.type`。

### Task 2: 实现单一浅解包

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`

**Interfaces:**

- Consumes: canonical `Record<string, unknown>` 与已有 `mergePlainRecords()`。
- Produces: `unwrapOpenAiCompatibleExtraBody(options): Record<string, unknown>`。

- [ ] **Step 1: 增加最小 helper**

```ts
function unwrapOpenAiCompatibleExtraBody(
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (options.extra_body === undefined) {
    return options;
  }

  const extraBody = asPlainRecord(options.extra_body);
  if (!extraBody) {
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      "openaiCompatible.extra_body 必须是对象",
      { context: { namespace: "openaiCompatible", option: "extra_body" } },
    );
  }

  const { extra_body: _extraBody, ...directOptions } = options;
  return { ...extraBody, ...directOptions };
}
```

- [ ] **Step 2: 只替换投影 base**

```ts
[providerOptionsName]: mergePlainRecords(
  unwrapOpenAiCompatibleExtraBody(openAiCompatibleOptions),
  existingProviderOptions,
),
```

不得删除 `...input.providerOptions`，不得读取 camel alias，不得修改 `mergePlainRecords()`。

- [ ] **Step 3: 运行 GREEN**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- --run tests/openai-compatible-extra-body-wire.test.ts tests/runner-options.test.ts
```

Expected: 两个测试文件全部通过，真实 wire 无 `extra_body`。

### Task 3: 收口非法 wrapper 生命周期

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/runner.test.ts`

**Interfaces:**

- Consumes: `AiSdkModelAdapterError(ModelErrorCode.InvalidModelRequest)`。
- Produces: generate/stream 一致的 non-retryable `invalid_request` 失败合同。

- [ ] **Step 1: 写 generate/stream 失败测试**

两条测试都传入 `openaiCompatible.extra_body: []`，断言：

```ts
expect(runtimeCallCount).toBe(0);
expect(retryStatusCount).toBe(0);
expect(startedStatusCount).toBe(0);
expect(failedStatus).toMatchObject({
  type: "model_request_failed",
  reason: "invalid_request",
  retryable: false,
  message: "openaiCompatible.extra_body 必须是对象",
});
```

调用方收到 `AiSdkModelAdapterError`，code 为 `InvalidModelRequest`；不检查或新增 model-io。

- [ ] **Step 2: 运行 RED**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- --run tests/runner.test.ts
```

Expected: stream 尚未保留明确 invalid-request message；generate 的 options 异常尚未进入统一 catch。

- [ ] **Step 3: 最小调整 classifier 与 generate try 边界**

`classifyModelFailure()` 对 `InvalidModelRequest` 返回原错误消息、`invalid_request`、不可重试。
`runGenerateText()` 保持 `resolveModelForAttempt()` 在 try 外，只将 options 构造、started 发布和 runtime
调用放进既有 try；options 未构造时跳过 `recordGenerateTextDebug()`。

- [ ] **Step 4: 运行 GREEN**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- --run tests/runner.test.ts
```

Expected: generate/stream 两条新测试通过，既有 runner tests 无回归。

### Task 4: E2E 与仓库验证

**Files:**

- Verify only: all files above。

**Interfaces:**

- Consumes: I14/I15/I17 case-local fixtures。
- Produces: 可提交的最小修复与验证记录。

- [ ] **Step 1: 检查三个 fixture 合同**

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts
```

- [ ] **Step 2: 跑三条 default replay E2E**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts'
```

- [ ] **Step 3: 跑静态和覆盖门禁**

```bash
pnpm --filter @zcode/desktop typecheck:e2e
pnpm audit:conversation-session-coverage
pnpm typecheck
pnpm lint
```

- [ ] **Step 4: 审查最终 diff 并提交**

只允许 spec/plan、runner options/error boundary、targeted adapter tests、I14/I15/I17 及其既有 fixtures
发生变化。提交信息：

```bash
git commit -m "fix(model): unwrap OpenAI-compatible extra body"
```
