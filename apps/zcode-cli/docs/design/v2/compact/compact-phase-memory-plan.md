# Compact 阶段与 Memory 改造计划

## 文档定位

本文基于 ZCode 当前 compact 实现，列出下一步应该改什么：compact 阶段语义、history replacement、context baseline 与 memory read/write path。它是 `docs/design/v2/compact/README.md` 和 `plan.md` 的增量计划，不替代已有 compact 主路线。

当前实现已经具备：

- `/compact` 手动压缩入口。
- auto compact policy 和失败熔断。
- provider context overflow 后的 reactive compact retry。
- compact summary prompt、摘要回复里的工具调用不执行（见 README「摘要文本的选取」）、prompt-too-long retry。
- compact timeline part、summary message、compact boundary 事件。
- resume 时从最近 compaction boundary 后恢复 provider-visible history。
- compact phase/compactReason 元数据，覆盖 manual、pre-request、mid-turn 和 reactive 路径。
- memory read path：从 project `memory_summary.md` 加载轻量摘要，作为 dynamic system context 注入，并记录 skipped/loaded/failed 日志。

主要缺口不是“没有 compact”，而是：

- compact 后只是替换内存中的 provider messages，缺少更强的 history replacement 抽象。
- context prefix 每次重建，缺少 reference context baseline/diff。
- memory write path 还没有后台 extraction/consolidation pipeline。
- compact 和 memory 还没有明确边界。

## Todo: 三个 compact 阶段

这里的三个阶段指 compact 的三个核心时机：手动独立 compact、新 turn 请求前 compact、agent turn 中 follow-up 请求前 compact。ZCode 现有 reactive compact retry 是互补能力，保留但单独标注为 `reactive/provider_overflow`。

- [x] T1: 在 contract 中增加 `CompactPhase` 和 `CompactReason`，并让 boundary/timeline payload 可选携带。
- [x] T2: `/compact` 手动入口标为 `standalone_turn/user_requested`。
- [x] T3: 用户消息后、第一轮 provider request 前的 auto compact 标为 `pre_request/context_limit`。
- [x] T4: tool follow-up 或 pending input 导致的下一轮 provider request 前 auto compact 标为 `mid_turn/context_limit`。
- [x] T5: provider context overflow 后的 compact retry 标为 `reactive/provider_overflow`，不混入上述三阶段统计。
- [x] T6: 为 `mid_turn` compact 增加测试，证明 compact 发生在一次 model response 完成后、下一次 sampling 前，而不是 streaming delta 中途。
- [ ] T7: 将 summary persistence、boundary event、timeline completed 和 in-memory replacement 收敛到 `HistoryReplacement` 安装流程。
- [x] T8: 明确 compact 后 initial context 的处理策略：`pre_request` 和 `mid_turn` 第一阶段都保留现有 context prefix；后续再引入 reference context baseline/diff。
- [x] T9: 第一阶段只实现 memory read path，保证 memory instructions 可作为 context prefix 被 compact 保留或重建。
- [ ] T10: memory write path 不直接消费 synthetic compact summary 作为事实来源，优先使用原始用户消息、工具结果和验证证据。

## 一、现有实现对照

### 1.1 Runtime 触发点

当前 ZCode 在 regular turn 中先写入用户消息，然后进入 tool loop。每次模型请求前都会调用 `autoCompactIfNeeded`。

```text
user input persisted
-> messageHistory.addUser
-> while true:
     drain pending input if modelStepCount > 0
     autoCompactIfNeeded
     build model messages
     model request
     if tool calls:
       execute tools
       inject tool results
       continue
     else:
       complete turn
```

这意味着当前 auto compact 已经可能在两种时机发生：

- 第一轮模型请求前：用户消息后、provider 请求前。
- tool follow-up 前：工具结果写入 history 后、下一次 provider 请求前。

两者都保留 `trigger = auto`，并通过 `phase` 区分为 `pre_request` 与 `mid_turn`，ZCode 已把该语义写入 boundary/timeline。

相关代码：

- `packages/core/src/runtime.ts` 的 `executeTurn`
- `packages/core/src/runtime.ts` 的 `autoCompactIfNeeded`
- `packages/core/src/runtime.ts` 的 `reactiveCompactAfterContextExceeded`
- `packages/core/src/runtime.ts` 的 `compactActiveConversation`

### 1.2 Contract 层

当前 contract 已有：

- `CompactTrigger`
- `CompactPhase`
- `CompactReason`
- `CompactStatus`
- `CompactTimelineStatus`
- `CompactFailureReason`
- `CompactBoundaryPayload`
- `CompactTimelinePayload`
- `buildPostCompactItems`
- `getItemsAfterLastCompactBoundary`

缺少：

- `initialContextStrategy`
- compact 后 token 估算来源
- follow-up metadata，例如 `needsFollowUp`、`modelStepIndex`

### 1.3 Persistence 与 resume

当前 summary message 会持久化为 user message，并写入：

- synthetic text part
- compaction part with `compactBoundary`

resume 时 hydrator 从最近 compaction boundary 后恢复 history。这已经满足第一版 active chain 截断。

仍需加强：

- compact timeline started/completed 和 boundary 的原子性语义。
- replacement history 的可审计结构。
- preserved segment 的实际恢复测试。
- compact 后 token usage 重算或明确“估算值”来源。

### 1.4 Memory

当前已实现第一阶段 read path：bootstrap 从 CLI storage root 和当前 workspace 派生 project memory root，runtime 在 context 初始化阶段读取 `memory_summary.md`，并通过 `ContextSource = "memory"` 注入 dynamic system section。读取行为受 `features.memory`、`memory.use` 和 `memory.summaryMaxBytes` 控制，缺失或空 summary 只记录 skipped debug 日志。

仍未实现 write path。memory 继续作为独立能力建模，不塞到 `packages/core/src/compact` 内部。compact 后续可以依赖 memory 作为 summary source，但 memory 的写入、索引、citation 和后台 consolidation 仍要独立设计。

## 二、目标设计

### 2.1 Compact phase 与 compactReason

新增 contract：

```ts
export const CompactPhase = {
  StandaloneTurn: "standalone_turn",
  PreRequest: "pre_request",
  MidTurn: "mid_turn",
  Reactive: "reactive",
} as const;

export const CompactReason = {
  UserRequested: "user_requested",
  ContextLimit: "context_limit",
  ModelDownshift: "model_downshift",
  ProviderOverflow: "provider_overflow",
} as const;
```

映射：

| 当前路径 | trigger | phase | compactReason |
| --- | --- | --- | --- |
| `/compact` | `manual` | `standalone_turn` | `user_requested` |
| 用户消息后、第一轮请求前 auto compact | `auto` | `pre_request` | `context_limit` |
| tool follow-up 前 auto compact | `auto` | `mid_turn` | `context_limit` |
| provider overflow 后 compact retry | `reactive` | `reactive` | `provider_overflow` |
| 未来模型降级/切换小窗模型 | `auto` | `pre_request` | `model_downshift` |

`CompactBoundaryPayload` 和 `CompactTimelinePayload` 都应包含 `phase` 与 `compactReason`。旧字段 `trigger` 保留，避免 UI 和 reducer 破坏。Timeline 上已有的 `reason` 字段保留给失败/展示原因，不复用为 compact 触发原因。

### 2.2 MidTurn compact

当前 runtime 已经在 tool loop 下一次请求前运行 auto compact，但需要显式识别 phase。

建议新增：

```ts
type CompactRequestContext = {
  trigger: CompactTrigger;
  phase: CompactPhase;
  compactReason: CompactReason;
  modelStepIndex: number;
  hasToolFollowUp: boolean;
  hasPendingInput: boolean;
};
```

在 while loop 中：

```text
if modelStepCount === 0:
  phase = pre_request
else:
  phase = mid_turn
```

如果 `modelStepCount > 0` 且刚执行过 tools 或 drain 了 pending input，auto compact 完成后继续下一次 model request。这就是 `mid_turn` 语义。

验收：

- 有 tool call 的长任务在第二次模型请求前触发 auto compact 时，事件里 `phase = mid_turn`。
- 没有 follow-up 的最终 assistant 文本之后不触发 mid-turn compact。
- streaming delta 过程中不触发 compact。

### 2.3 History replacement 抽象

当前 `messageHistory.replaceMessages(postCompactMessages)` 是内存替换，persistence 靠 summary message + compaction part。下一步应把它收敛成明确接口：

```ts
interface HistoryReplacement {
  boundary: CompactBoundaryPayload;
  replacementMessages: ModelInputMessage[];
  summaryMessageId: MessageId;
  preservedSegment?: CompactPreservedSegment;
  tokenUsageEstimate: {
    value: number;
    method: "estimated" | "provider_usage" | "provider_count";
  };
}
```

`compactActiveConversation` 不直接散落写入 summary、boundary、timeline、messageHistory，而是产出 replacement，再由一个 session history service 原子安装。

短期可以保留现有写法，但要先补 spec 和测试，避免后续 partial compact、memory compact、resume relink 变复杂。

### 2.4 Reference context baseline

reference context baseline 的目的是避免每轮重复注入完整 initial context：只在 baseline 变化时注入 diff。ZCode 当前 context builder 每次初始化时构建完整 prefix。

建议分两步：

1. 先不做 diff，只在 spec 中定义 `ContextBaseline`：

```ts
interface ContextBaseline {
  baselineId: string;
  turnId?: TurnId;
  modelRef: string;
  cwd: string;
  permissionMode: string;
  userInstructionsHash?: string;
  projectContextHash?: string;
  skillsHash?: string;
  memorySummaryHash?: string;
}
```

2. 等 compact/memory 稳定后，再把 context builder 拆成：

```text
buildInitialContext
buildContextDiff
recordContextBaseline
clearContextBaselineAfterCompact
```

MidTurn compact 如果要立即继续请求，就不能依赖“下一轮初始化”恢复上下文；需要在 replacement messages 里保留或重新插入必要 context prefix。

### 2.5 Memory read path

先做轻量 read path，不做后台写入。

目录：

```text
<storage.dir>/memories/
  memory_summary.md
  MEMORY.md
  skills/
  rollout_summaries/
```

配置：

- `features.memory` 控制总开关。
- `memory.use` 控制是否注入 read instructions。
- `memory.root` 默认从 `storage.dir` 派生，不新增环境变量。
- `memory.summaryTokenLimit` 默认 5000。

新增 context section：

- source: `memory`
- injection target: `system` 或 `meta_user`，第一版建议 `system`，作为开发者侧指令注入。
- 内容只包含 `memory_summary.md` 和检索规则，不包含全部 memory 文件。

第一版不要求模型输出 XML citation，但应设计可选 citation 契约，后续给 TUI 或 debug 追踪“本轮用了哪些 memory 文件”。

### 2.6 Memory write path

第二阶段再做后台生成，不能和 read path 同时上。

分两阶段：

```text
Phase 1:
  completed sessions/transcripts
  -> raw memory JSON/markdown
  -> state DB

Phase 2:
  raw memories
  -> memory workspace
  -> restricted consolidation agent
  -> MEMORY.md, memory_summary.md, skills/*, rollout_summaries/*
```

限制：

- ephemeral session 不生成 memory。
- subagent 默认不生成 memory。
- consolidation agent 禁用 memory，避免递归。
- consolidation agent sandbox 只允许写 memory root。
- memory update 需要可审计、可重试、可暂停。
- 用户显式要求更新 memory 时，写 `extensions/ad_hoc/notes/`，不直接改 `MEMORY.md`。

### 2.7 Compact 与 Memory 的关系

compact 和 memory 是分开的模块，但它们通过 initial context 和 transcript 证据链发生关系。

读路径上，memory instructions 是 initial context 的一部分。也就是说，compact 后如果 replacement history 丢掉了 context prefix，下一次模型请求会失去“如何查 memory、如何引用 memory”的规则。initial context 的注入规则按 phase 区分：

- 手动 compact 和 `pre_request` compact：compact 后清空 reference baseline，让下一次 regular turn 完整重建 initial context，不在 replacement history 中注入。
- `mid_turn` compact：同一个 turn 马上还要继续请求模型，必须把 initial context 立刻插回 replacement history（位于最后一条 user message 之前）。

ZCode 第一阶段没有 reference baseline/diff，也仍然要保住这个约束：`mid_turn` compact 完成后，下一次 provider request 的 context prefix 必须仍包含 system、project instructions、skills 和 memory read instructions。

写路径上，memory 不应该把 compact summary 当成唯一事实来源。memory extraction 应信任 transcript 中的原始 user message、tool call/result 和验证证据，并排除 compaction 产物、developer message、reasoning 等 synthetic 内容。ZCode 后续做 memory write 时应遵守：

- compact summary 可以作为导航线索，帮助理解长 session 发生过什么。
- 长期 memory 的事实落库必须回到原始 transcript、工具结果、测试输出或用户显式偏好。
- consolidation agent 默认禁用 memory read/write，避免 memory 生成过程递归污染自身。
- compact boundary 和 replacement history 仍然要持久化，因为 resume 和后续 memory job 都可能依赖它重建可解释的 session 轨迹。

## 三、实施顺序

### M1: Phase/Reason 契约

文件：

- `packages/contracts/src/compact/index.ts`
- `packages/contracts/tests/compact.test.ts`
- `docs/design/v2/compact/README.md`

工作：

- 增加 `CompactPhase`、`CompactReason`。
- 在 timeline/boundary schema 中加入可选 `phase`、`compactReason`。
- reducer 保持兼容。
- 测试 schema 和旧 payload 兼容。

### M2: Runtime 标注 phase

文件：

- `packages/core/src/runtime.ts`
- `packages/core/tests/runtime-compact.test.ts`

工作：

- 给 `autoCompactIfNeeded` 增加 `phase`/`compactReason` 参数。
- `modelStepCount === 0` 标为 `pre_request`。
- `modelStepCount > 0` 标为 `mid_turn`。
- reactive compact 标为 `reactive/provider_overflow`。
- manual compact 标为 `standalone_turn/user_requested`。

验收：

- 第一轮请求前 auto compact 事件是 `pre_request`。
- tool follow-up 前 auto compact 事件是 `mid_turn`。
- provider overflow retry 事件是 `reactive`。

### M3: MidTurn 测试补齐

文件：

- `packages/core/tests/runtime-compact.test.ts`
- `packages/core/tests/runtime-tool-loop.test.ts`

工作：

- 构造一次 model 返回 tool call。
- tool result 进入 history 后超过阈值。
- 下一次 model request 前 compact。
- 断言 summary context 包含 tool result 后的现场，且不包含旧历史。

这一步主要证明现有机制已经能承担 `mid_turn` 语义。

### M4: Memory read path（已完成）

文件：

- `packages/contracts/src/config/index.ts`
- `packages/core/src/context/types.ts`
- `packages/core/src/context/builder.ts`
- `packages/core/src/context/sections/memory.ts`
- `packages/adapters/src/config/schema.ts`
- 新增 memory 文件读取 adapter 或注入端口

工作：

- 定义 memory config。
- context builder 支持 memory section。
- 从 `storage.dir/memories/memory_summary.md` 读取摘要。
- 摘要不存在或为空时不注入。
- `features.memory = false` 时完全跳过。

测试：

- 无 memory 文件不注入。
- 有 memory summary 时注入检索规则。
- summary 超过 token limit 时截断。
- memory disabled 时不读取文件。

当前落地文件：

- `packages/core/src/runtime/methods/context.ts`
- `packages/core/src/context/sections/memory.ts`
- `packages/core/tests/runtime-memory.test.ts`

### M5: History replacement service

文件：

- `packages/core/src/compact/*`
- `packages/core/src/agent/message-history.ts`
- `packages/core/src/agent/session-history-hydrator.ts`
- `packages/core/tests/runtime-compact.test.ts`
- `packages/core/tests/session-history-hydrator.test.ts`

工作：

- 把 summary persistence、boundary event、timeline completed、in-memory replacement 收敛成一个安装流程。
- 给安装失败定义 rollback 行为。
- 为 preserved segment 预留真实实现。

这一步不改变用户行为，但为 partial compact、session memory compact 和 replacement history 安装铺路。

### M6: Memory write pipeline spec

先只写 spec，不实现。

文件：

- `docs/design/v2/memory/README.md`
- `docs/design/v2/memory/write-pipeline.md`

内容：

- transcript/session 选择策略。
- raw memory schema。
- consolidation agent sandbox。
- state DB job claim/lease/retry。
- secret redaction。
- memory citation。
- ad-hoc user memory update。

## 四、当前不做的事

- 不接入 provider 侧的远程 compact 接口。
- 不在 streaming delta 中途 compact。
- 不把所有 memory 文件塞进每次 provider request。
- 不让 compact 自动写长期 memory。
- 不新增 `ZCODE_` 环境变量。
- 不把 memory write path 和 read path 一次性合并上线。

## 五、风险

- MidTurn compact 如果 replacement context 丢掉 tool call/result 配对，会导致下一次 provider 请求非法。
- memory summary 如果过宽，会污染所有任务；如果过窄，又无法引导检索。
- phase/compactReason 如果只写日志不进 contract，TUI 和 debug app 仍然无法稳定消费。
- context baseline/diff 过早实现会放大复杂度，建议等 phase 与 memory read path 稳定后再做。
