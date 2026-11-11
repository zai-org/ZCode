# 模型异常兜底设计记录

## 文档定位

本文记录 agent loop 面向模型异常行为的兜底策略，作为后续实现依据。重点覆盖 tool call 过多、重复工具调用、provider 异常结束、流式请求失败、上下文溢出和 malformed tool call 等场景。

核心原则：**ZCode 面向长程任务，tool call 数量不设硬停止条件，也不默认设置 100 次之类的全局上限**。硬停止只用于明确的资源或安全边界，例如用户取消、权限拒绝、工具超时、输出截断、进程终止、provider retry 上限、上下文不可恢复溢出等。

---

## 一、常见兜底手段

- 不设全局 hard `max tool calls` 限制；`tool_calls` 计数主要用于 metrics。`maxSteps` 一类配置即使存在，运行时仍把 tools 传给模型，本质是提示型软限制。
- turn loop 由 `needs_follow_up` 驱动：模型要工具就执行并回灌结果，无 tool follow-up 才结束。
- 连续多次相同工具、相同 JSON input 可以作为 doom loop 信号，交给权限确认或模型可见提示处理。
- provider 返回 `stop` 但同时带 tool calls 时，继续处理 tool calls，避免过早结束。
- malformed/unsupported tool call 先尝试 repair；失败后转为 model-visible 错误输出，fatal 错误才终止 turn。
- stream retry 与 request retry 各有上限；context limit 可触发 auto compact。
- API/stream 错误、上下文溢出、tool output 过大、bash/webfetch 超时都有单独兜底。

---

## 二、ZCode 设计原则

1. **长程任务优先**：tool call 计数只作为 telemetry/诊断输入，不作为 runtime 闸门；默认不限制调用次数。
2. **异常兜底可观测**：所有重试、compact、fallback 都要发事件，并携带 `traceId`、`turnId`、`spanId` 或可关联的父子关系。
3. **模型先自纠偏**：如果未来引入异常 warning，也只能作为模型可见提示，不禁用工具、不抛 `ToolMaxCalls`、不直接结束 turn。
4. **资源边界仍可硬保护**：工具超时、输出大小、进程取消、权限拒绝、用户中断、不可恢复 provider error 可以硬失败或中断。单个工具的资源预算也属于这一类，例如动态工作流子代理每个 ask 的 WebSearch 次数（`tool/13-websearch.md`）：超出预算只让该工具回模型可见的错误，不改 tools 列表、不结束 turn，也不计其他工具的调用次数，因此不是 tool call 数量上限。
5. **不要吞错误**：低层错误保留原始原因；只有 loop 边界负责决定是否转成模型可见 warning、用户提示或 turn error。

模型网络 retry 由 ZCode adapter 自己执行，不使用 AI SDK 内部 retry。默认重试次数为 10，对应事件里的 `maxAttempts = 11`；日志需要同时记录 `maxAttempts` 和派生的 `maxRetries`。退避策略应支持指数退避、jitter、`retry-after-ms` 和 `retry-after`，其中 provider header 只有在等待时间合理时才覆盖本地退避。

---

## 三、tool call 计数策略

### 3.1 配置契约

`maxToolCalls` 不再是 runtime 配置。tool call 计数只用于日志、trace、metrics 和诊断视图。默认不提供全局 tool call warning threshold；如果后续需要异常提醒，应放入独立 guard 配置，并保持非阻塞语义。

```typescript
interface ModelAnomalyGuardConfig {
  /**
   * 可选：单个 turn 内累计 tool calls 超过该值时，向模型注入 warning。
   * 未配置时不提醒。不是硬停止条件。
   */
  toolCallWarningThreshold?: number;

  /**
   * 相同 tool name + stable JSON input 连续出现多少次时触发重复调用 warning。
   * 默认 3。
   */
  repeatedToolCallWarningThreshold?: number;

  /**
   * 单个 turn 最多注入几次预算类 warning，避免 warning 本身造成上下文噪音。
   * 默认 3。
   */
  maxBudgetWarningsPerTurn?: number;
}
```

历史 `maxToolCalls` 配置不应再影响运行时行为。迁移期可以在配置解析层忽略它或提示 deprecated，但 core runtime 不应读取它，也不应抛 `ToolMaxCalls`。

### 3.2 运行时行为

运行时在每次模型请求前执行 context/token compact 判断。只要模型仍需要 tool follow-up，就继续执行工具并回灌结果；如果 active context 达到 compact 阈值，则在下一次模型请求前执行 mid-turn compact，compact 成功后继续当前任务。provider 明确返回 context overflow 时，每个 model-step 重试链最多执行一次 reactive compact；原地重试不会重新开放 compact，只有完整 tool result batch 推进到下一 model step 后才重置 guard。auto/reactive compact 还共用 `<3 tool turns / 3 consecutive refills` 的快速回填熔断，即 `next_turn` guard reset 与 rapid-refill breaker。

tool call 总数超过某个数字时，不改变 tools 列表、不注入禁止工具的消息、不结束 turn。

### 3.3 事件契约

```typescript
interface ModelAnomalyWarningPayload {
  category: 'tool_call_budget' | 'repeated_tool_call' | 'provider_finish_mismatch' | 'malformed_tool_call';
  severity: 'info' | 'warning';
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: string;
}
```

事件要求：

- `traceId` 必填，沿用当前 turn。
- `turnId` 必填。
- 事件本身不代表 turn 失败。
- warning 文案如果包含模型输入摘要，必须经过脱敏和截断。

---

## 四、重复工具调用警告

重复工具调用是比总数更强的 loop 信号。建议按 `toolName + stableJson(input)` 识别连续重复：

- 默认连续 3 次触发 warning。
- 只给模型警告，不因为重复本身硬停。
- 对有副作用工具，仍交给权限系统和 tool contract 判断是否需要审批或拒绝。
- `stableJson` 必须使用结构化序列化，不依赖普通字符串拼接。

warning 内容应包含具体工具名和重复次数，但不直接暴露完整敏感 input。

### 4.1 连续的精确定义

runtime 维护一个按单个 turn 生命周期存在的 repeated-tool-call streak：

- 比较键是 `toolName + stableJson(input)`。
- tool calls 按模型产生的顺序逐个进入 streak 判断；同一轮 assistant 一次返回多个 tool calls 时，也按返回顺序逐个处理。
- 只有**当前 tool call 的比较键与前一个 tool call 完全相同**时，streak 才加一；否则重置为 1 并切换到新的比较键。
- `tool` result、permission event、scheduler event、compact event 等 runtime 注入事件不参与 streak 比较，也不会单独打断 streak。
- 任意新的用户输入进入当前 turn 后，streak 必须重置，避免把用户显式纠偏后的继续尝试误判为 doom loop。
- 新 turn 开始时 streak 必须重置。

### 4.2 warning 触发语义

- 只在 streak **首次跨过阈值**时触发一次 warning；例如默认阈值为 3 时，第 3 次相同调用触发 warning，第 4、5 次不重复注入同一条 warning，直到 streak 被打断并重新累计。
- warning 既要发 session event，也要在下一次 model request 前向模型注入 `<system-reminder>` 形式的可见提示。
- reminder 只暴露 `toolName` 和重复次数，不直接回显完整 input；必要时可以在 runtime log 中保留脱敏摘要。
- 若单个 turn 的 warning 注入次数已达到 `maxBudgetWarningsPerTurn`，仍应发事件，但 `warningInjected=false`，避免 reminder 自身变成上下文噪音。

---

## 五、其他模型异常兜底清单

| 场景 | 兜底策略 | 是否硬停止 |
|------|----------|------------|
| tool calls 很多 | 只记录 telemetry/trace；可选非阻塞 warning | 否 |
| 连续重复相同 tool call | 注入模型 warning，发事件；有副作用时走权限策略 | 否 |
| provider `stop` 但带 tool calls | 优先处理 tool calls，并记录 provider mismatch | 否 |
| malformed tool arguments | 转成模型可见 tool/function error，让模型修正 | 否，除非 schema/adapter 无法构造回灌 |
| empty non-stop model result | 转成 `model_error`，发 `turn_error` 并在 TUI transcript 展示错误 | 是 |
| unsupported tool name | 回灌模型可见错误，提示可用工具范围 | 否 |
| stream 断开/idle timeout | 按 provider retry 策略重试，达到上限后 turn error | 达上限后是 |
| request 429/5xx/network | 按 retry policy 重试，记录 attempt 和 backoff | 达上限后是 |
| context overflow | 尝试 auto compact；compact 成功后继续 | compact 失败后是 |
| tool output 过大 | 截断并保留 artifact/ref | 否 |
| tool timeout / user cancel | 生成 aborted/timeout tool result 或 turn cancel | 取决于工具契约 |

---

## 六、后续实现任务

1. 更新 contracts：新增 `ModelAnomalyWarning` 事件和 payload schema。
2. 更新 runtime config：移除 core runtime 的 `maxToolCalls` 读取路径。
3. 更新 runtime：删除超过 `maxToolCalls` 抛 `ToolMaxCalls` 的硬停止逻辑。
4. 保留 prompt/message history 的正常 tool follow-up 序列，确保超 100 次 tool call 不产生特殊 provider-visible message。
5. 增加重复工具调用检测：按连续相同 `toolName + stableJson(input)` 计数。
6. 增加测试：
   - 单个 turn 超过 100 次 tool call 不会抛错。
   - 超过 100 次 tool call 后仍会执行 tool result follow-up。
   - tool call 数量不会生成禁止继续调用工具的 provider-visible message。
   - 连续重复工具调用会触发 repeated warning。
7. 保留资源硬保护测试：工具超时、输出截断、用户取消仍按 tool contract 处理。

---

## 七、当前实现差异

当前实现目标：`packages/core/src/runtime.ts` 不再使用 `maxToolCalls` 作为硬限制，tool call 计数只用于日志和结果统计。

当前 `packages/contracts/src/errors/index.ts` 仍包含 `ToolMaxCalls`。迁移时可以保留一段时间用于兼容历史事件或旧测试，但新 runtime 不应把 tool call 预算超限作为 turn error。
