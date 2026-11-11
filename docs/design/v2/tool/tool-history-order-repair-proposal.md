# 工具历史顺序修复

2026-09-10，基于 `origin/staging` 的 `fa70e896834a88e17290739c54995437b03aceee`。
实现范围：现有 ToolPart 写入附带声明序号，provider history hydration 选择每次调用的最新记录，再恢复声明顺序。

## 根因

`model.ts` 接纳并去重工具声明，live history 按声明顺序提交调用和结果。
只读工具可以在流结束前执行；SQLite 的 part.sequence 却由第一次写入决定。
原 hydration 直接使用 SQLite 顺序，导致 resume、edit/rewind、fork 的模型历史与 live 不同。

```text
模型声明     Bash(0) ---------> Read(1)
执行时机     等待 finish         提前执行
首次落盘     后写 Bash           先写 Read
live         calls [Bash, Read] -> results [Bash, Read]
旧 hydrate   calls [Read, Bash] -> results [Read, Bash]
修复 hydrate calls [Bash, Read] -> results [Bash, Read]
```

真实 SQLite + 受控 ModelFactory 已在修复前复现倒序：正常完成、工具错误、可恢复断流
后的冷恢复请求均与 live 不同；纯 hydration 的排序、错误/中断和 fork 测试也先失败。

## 数据与行为契约

- ToolPart 顶层新增可选 `declarationIndex?: number`，含义是同一 assistant 内 runtime
  接纳的 client-executed 调用顺序，从 0 开始；重复声明、providerExecuted 不占序号。
- streaming 路径沿用已去重的 `acceptedToolCalls`，普通/恢复路径沿用 `coreToolCalls`。
  序号随原有 pending、running、completed/error 写入保存到 part.data JSON。
- 排序逻辑不增加存储读写，不移动写入点，不新增队列、await、partID 登记、超时或 catch。
  `onStreamToolCall` 仍同步返回；提前执行失败仍由原 catch 回退流结束后的执行。
- 提前执行异常后的回退及 synthetic recovery 沿用原有新建 part 行为，保留同一
  `callID` 和 `declarationIndex`；不登记、传递或复用失败尝试的 partID。
- 模型 hydration 在每个 assistant 内按 `callID` 选择最后新建的 part，依据原始
  持久化顺序，不比较更新时间，也不优先选择成功状态。最新 part 为 pending/running
  时沿用 interrupted result；不同消息中相同 callID 不合并。
- 序号由 runtime 枚举生成，所选 part 全部有序号时排序，允许间隙；全部或部分缺失
  时保留所选 part 的原始相对顺序。calls/results 共用同一份选择和排序结果。
- 不改变 SQL sequence、原始 message.parts、UI transcript、工具调度/权限/取消/结果。
  不改变 V4 protocol、桌面 continuous 和手机 replayable 的边界。
- fork 沿用已有 part 复制和 ID 重映射；数字序号无跨消息 ID 引用，无需新增 fork 逻辑。
- 旧版可以忽略该 JSON 字段。旧版重写同一 part 后可能丢字段，新版按旧记录规则兼容。

### 文件读取状态的写入顺序 `snapshotIndex`（2026-10-22 补充）

part 在工具开始前就按声明顺序落盘，完成时原地更新、位置不变，所以 part 顺序和 `declarationIndex`
都不是 live 写入文件读取状态的顺序；工具结果返回的先后也不是（handler 写入之后还有序列化、
PostToolUse hook、结果事件等异步步骤）。冷恢复需要 live 的写入顺序（见
[Read File State Resume](../../../../apps/zcode-cli/docs/design/v2/tool/17-read-file-state-resume.md)）。

```text
声明         完整 Read A(0) ──┐ 并行
             范围 Read B(1) ──┘
写入并记录快照 B 先写 → snapshotIndex 0；A 后写 → snapshotIndex 1（与谁先返回无关）
模型历史     按 declarationIndex：A, B（不变，前缀缓存不受影响）
读取状态恢复 按 snapshotIndex：B, A（与 live 最后写入的 A 一致）
```

- 文件读取快照（completed tool part 的 `metadata.readFileState`）新增可选 `snapshotIndex`。Read、
  Write、Edit 和工作流草稿写入 live 状态之后，同步调用 `recordReadFileStateMetadata` 记录快照，中间
  没有 await；执行器在这个回调里取号，所以序号就是 live 的写入顺序。ToolPart 不新增字段。
- 只用于同一 assistant 内比较，绝对值没有含义。计数器属于执行器，一个 runtime 一个，
  只增不减；文件读取状态的删除、清空不影响它。只有带快照的结果有序号。
- 返回 `file_unchanged` 的 Read 不写 live 状态，也不记录快照；冷恢复跳过这类结果，由之前那次真实读取恢复同一个视图。
- 模型 hydration 不使用它。文件读取状态恢复：同一 assistant 内的快照都带 `snapshotIndex` 时按它
  重放，否则（旧数据）保持原始顺序。
- 快照在 `state.metadata` 里，fork、checkpoint 和 workflow 转录按 `...part` 复制，原样保留。

## 验证

- core `tests/tool-history-order.test.ts`：有效排序、legacy/部分缺失、同调用多次尝试、
  最新成功/失败/未结束状态、消息间隔离、间隙、原数组不变及 fork 的 callID 重映射。
- core `tests/runtime-streaming-tool-part-identity.test.ts`：回退成功、失败、再次写入失败、
  synthetic recovery 和迟到 batch start；原始记录可以有多条，模型历史仅有一个调用及结果。
- bootstrap `tests/tool-fallback-read-state.test.ts`：真实 SQLite 和 Read/Edit handler，
  同一文件先被另一条 Read 读取，再由 Bash 类工具修改，最后由回退 Read 读取；冷恢复及
  rewind 后模型历史保持一致，Edit 使用最新已读快照成功执行。
- bootstrap `tests/tool-history-order.test.ts`：真实 SQLite，read 先写、write 后写；实际
  live 请求、关闭并重开数据库后的 cold 请求、rewind 后下一请求的 calls/results 完全一致。
  同时覆盖正常完成、工具错误、断流 synthetic result、pending 慢写/拒绝和 Stop。
  慢写通过 deferred 控制，证明后续模型事件继续消费；不依赖 sleep 推测竞态。
- Desktop D19：较早轮完成 Bash→Read，发送后续问题，再编辑最新问题；比较真实 provider
  tool_use/tool_result。用例位于 manual-review/pending，fixture 为 synthetic，待人工评审。
- 已通过：新增 20 项回归、原有 hydrator/runtime-tool-loop/session-fork 的 218 项测试、
  `pnpm typecheck`、`pnpm lint`（43 个既有 warning）、架构检查、contracts/core 类型检查、
  Desktop E2E 类型检查和 fixture 检查。
- macOS Electron D19 回放通过（1/1），真实请求命中 `d19-tools`、`d19-followup`、
  `d19-title`、`d19-later`、`d19-edited`，没有 fixture miss。报告：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260910122250619-p1669-f4f6ced2e19e5429/summary.md`。
  待审用例不计入正式 E2E 覆盖；Windows/Linux、手机远控未运行。
- 待审 runner 默认 240-token 窗口会触发额外 compact。本例比较未压缩历史，必须使用
  128000-token 窗口。首次准备因相对 fixture 路径解析失败，第二次因默认小窗口触发
  未配置的 compact 而失败；下列命令修正准备条件后通过，不涉及产品代码调整。

```sh
ZCODE_E2E_MANUAL_REVIEW=1 \
ZCODE_E2E_DEEPSEEK_CONTEXT_WINDOW=128000 \
ZCODE_E2E_DEEPSEEK_MAX_OUTPUT_TOKENS=32768 \
E2E_PROVIDER_HTTP_MODE=replay \
E2E_PROVIDER_REPLAY_FIXTURE_PATH="$PWD/packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-tool-history-order.json" \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/tools/conversation-session-tool-history-order.test.ts
```

### 2026-09-11：按调用选择最新尝试

- 先写回归再修代码：修改前 25 项定向测试中 19 项失败，包含真实 Read/Edit 在 cold resume
  和 rewind 后误报 stale；修复后 25 项全部通过。
- 使用当前 core、SQLite 和文件系统 adapter 源码执行 10 个相关测试文件，共 335 项通过；
  覆盖模型历史、fallback、断流、取消、fork、文件状态及 UI transcript hydration。
- macOS Electron D19 synthetic 回放 1/1 通过；runner 重新构建 desktop 和 Agent，继续验证
  live、后续提问、编辑后请求中的 calls/results 一致。报告：
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260911095916848-p74882-7ee773cd74562b10/summary.md`。
- core build、根 typecheck、根 lint、架构检查、Desktop E2E 类型检查和 fixture 检查通过。
  根 lint 有既有 warning；core 独立 lint 的报错位置/规则与修复前一致，包含原有超长文件。
  手动严格检查新增/修改测试时，剩余错误仅来自未改动的 `test-runtime-model.ts`、
  `test-agent-runtime.ts`、`runtime-output-token-continuation-test-helpers.ts`。
- 未运行 Windows/Linux 和手机远控 E2E；D19 仍为待审用例，本轮不转正。

## 范围限制

该修复只恢复有完整声明序号的工具记录顺序，不能反推旧数据，不能保证所有 cache miss
消失。同 callID 的多份 part 只在模型 hydration 中合并，不删除/迁移数据库记录，不改变
Stop 时原来未落库调用的集合。文件读取状态和 UI 继续消费原始 parts。
回退与断流恢复契约见
[流式工具执行与恢复](../../../../apps/zcode-cli/docs/design/v2/model/streaming-tool-execution-and-recovery.md)。

### 2026-11-02：`blockIndex` 接替 `declarationIndex` 的写入

[Assistant 内容块顺序](../../../../apps/zcode-cli/docs/design/v2/model/assistant-block-order.md)
引入 `blockIndex`：一次响应里所有块（reasoning、text、tool，包括服务端执行的工具）共用的到达序号。
工具之间的先后由它表达，所以：

- 新写入的 ToolPart 只带 `blockIndex`，不再写 `declarationIndex`。重试和恢复新建的 part 沿用同一个
  `blockIndex`。
- `selectToolPartsForHistory` 的排序依据依次是：全部有 `blockIndex` → 按它；否则全部有
  `declarationIndex` → 按它；否则保持物理顺序。"同一 callID 取最后新建的 part"不变。
- 本节之前写入的数据只有 `declarationIndex`，读取逻辑保留，冷恢复字节不变。
- 降级：本节之后、`declarationIndex` 引入之后的旧版本读到新数据时没有 `declarationIndex`，按物理顺序
  恢复工具，可能和新版本发出的字节不同。
- 读取边界按 `blockIndex` 排序有序 assistant 消息的 parts，UI 不再看到写库顺序。上面"UI 继续消费原始
  parts"对有序消息改为：UI 消费按流顺序排列的 parts。文件读取状态仍按 `snapshotIndex`。
- 本地工具的结果提交改按 `blockIndex` 稳定排序（只在 `executeToolCallsForModelStep` 排一次），live 结果和
  冷恢复同序。流中提前执行的只读工具仍在 `tool_call` 到达时写 pending part 并执行；其余工具的调度、
  pending part 写入和执行按排序后的顺序。上面非目标里的"不改变工具调度"对有序调用不再成立；块依次到达的
  协议下两种顺序相同，只有 openai-compatible 后一个调用的名字先到达时，执行顺序变为块开始的顺序。
  "不改变原始 message.parts / UI transcript"同样只对旧消息成立。

复用失败尝试的 partID 会保留首次插入位置，导致同文件后完成的回退读取在恢复文件状态时
被另一条更旧的 Read 覆盖。因此保留新建 part 的既有执行记录顺序，只修复模型历史的选择：

```text
原始 parts：Read A(pending,1) -> Read B(old,2) -> Bash(0) -> Read A(new,1)
                         |
         +---------------+------------------+
         v                                  v
模型 hydrate：同 callID 取最后 part     文件状态：原顺序的 completed parts
再排序 Bash(0), A(new,1), B(old,2)      B(old) -> A(new)，恢复 new
```
