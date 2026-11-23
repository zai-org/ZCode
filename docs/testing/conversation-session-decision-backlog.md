# Conversation Session Decision Backlog

> **状态：V4 迁移前的决策快照。** 产品问题与裁决轨迹保留，但“当前代码观察”中的
> legacy hook/task-stream 路径已经失效，不能作为当前代码事实。现行产品语义与覆盖状态请以
> [Conversation Product Protocol](../conversation-product-protocol.md)、
> [case catalog](../conversation-session-case-catalog.md) 和
> [coverage matrix](./conversation-session-e2e-coverage-matrix.md) 为准。

目标：把会话区还不能写成稳定 E2E 的 case 变成可 review 的产品决策清单。这里不替产品做决定，只记录“必须确认什么”，确认后再回写主 catalog / fault catalog / coverage matrix。

关联文档：

- 主路径 catalog：[conversation-session-case-catalog.md](../conversation-session-case-catalog.md)
- 主路径覆盖矩阵：[conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md)
- 外部环境故障 catalog：[conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md)
- 覆盖审计：[conversation-session-case-coverage-audit.md](./conversation-session-case-coverage-audit.md)
- Compact 决策工作单：[conversation-session-compact-decision-worksheet.md](./conversation-session-compact-decision-worksheet.md)
- 网络与 SSE 决策工作单：[conversation-session-network-sse-decision-worksheet.md](./conversation-session-network-sse-decision-worksheet.md)
- 恢复与隔离决策工作单：[conversation-session-recovery-isolation-decision-worksheet.md](./conversation-session-recovery-isolation-decision-worksheet.md)

## 使用方式

1. 每次只挑一个小批次确认，比如先处理 `F09/G11/G12` 或 `N03/N04`。
2. 运行 `pnpm audit:conversation-session-coverage`，看 `next review cases`，按审计脚本给出的顺序推进。
3. 产品确认后，先在对应 worksheet 中把协议题写入明确 `产品结论`，并把 `Status` 改为 `answered`。
4. 某个 case 的所有协议题都 answered 后，审计中的 `decision readiness` 会从 blocked 变 ready。
5. ready 后再把对应 case 从本文件移出，回写源 catalog 的 `Review=accepted`。
6. 在 coverage matrix 里把 case 标成 `missing`，直到有独立 E2E setup/action/assert 后再改成 `covered`。
7. 若确认结果会产生新分支，需要先扩展源 catalog，再让审计脚本暴露新的缺口。

## Review 批次

建议按下面顺序确认。每一批确认完，都要同步更新源 catalog、fault coverage matrix 和本 backlog，保证审计脚本能显示剩余数量下降。

| 批次 | 数量 | 入口 | 目标 |
| --- | ---: | --- | --- |
| ~~P0-1 Compact 故障~~ | 0 | [Compact 决策工作单](./conversation-session-compact-decision-worksheet.md) | **已完成（2026-07-05）**：`F09/G11/G12`（含 fault alias `C01-C03`）与 `N06` 全部裁决，12+1 个协议题 answered，已回写 catalog / fault catalog / coverage matrix / product-protocol PB 节 |
| P0-2 模型/API 请求故障 | 8 | [网络与 SSE 决策工作单](./conversation-session-network-sse-decision-worksheet.md) | 确认 HTTP/auth/provider/timeout/malformed/title failure 的产品状态、queue 规则和 UI 断言 |
| P0-3 SSE 流式故障 | 7 | [网络与 SSE 决策工作单](./conversation-session-network-sse-decision-worksheet.md) | 确认 retry boundary、partial text、stall、late event 和 stop 后污染隔离 |
| P1-1 文件系统/存储故障 | 5 | [恢复与隔离决策工作单](./conversation-session-recovery-isolation-decision-worksheet.md) | 确认 ENOSPC/EACCES/坏 snapshot/log artifact 的用户可见结果 |
| P1-2 App 生命周期/进程故障 | 8 | [恢复与隔离决策工作单](./conversation-session-recovery-isolation-decision-worksheet.md) | 确认后台、关窗、退出、renderer/host/agent crash、sleep/wake、compacting quit 的恢复合同 |
| P2-1 Workspace / Tool 外部变化 | 5 | [恢复与隔离决策工作单](./conversation-session-recovery-isolation-decision-worksheet.md) | 确认 workspace 缺失、外部文件变化、git 降级、remote disconnect、pending permission |
| P2-2 跨 Session 故障隔离 | 3 | [恢复与隔离决策工作单](./conversation-session-recovery-isolation-decision-worksheet.md) | 确认非当前 session 的失败如何影响列表、当前视图、切回恢复 |

## 当前统计

| 范围 | 数量 |
| --- | ---: |
| 待产品决策 unique case | 36 |
| 主路径 compact undefined | 0（2026-07-05 裁决完成） |
| 模型/API 请求故障 | 8 |
| SSE 流式故障 | 7 |
| 文件系统/存储故障 | 5 |
| App 生命周期/进程故障 | 8 |
| Workspace / Tool 外部变化 | 5 |
| 跨 Session 故障隔离 | 3 |

## P0：Compact 未定义主路径（已裁决归档，2026-07-05）

`F09/G11/G12`（含 fault alias `C01-C03`）已全部裁决并回写，从本 backlog 移出。结论记录见：

- 主 catalog `F09/G11/G12` 行与 L 节（`docs/conversation-session-case-catalog.md`）
- compact decision worksheet 的裁决记录（`conversation-session-compact-decision-worksheet.md`）
- product-protocol「Pending Product Boundaries」节（`docs/conversation-product-protocol.md`）

三条裁决摘要：手动 compact 失败保持 completed + failed marker（retry 入口）、queue 保留不自动消费、全部操作恢复；auto compact 三连败继续无压缩执行 pendingAction + circuit breaker；auto compact 被 stop 与普通 stop 完全对齐（pendingAction 留时间线不回 queue，marker cancelled）。下一步是按 roadmap 写三条 spec（`compact-failure` / `compact-auto-failure` / `compact-auto-stop`）。

## P0：模型/API 请求故障

### 当前代码观察（非产品决策）

这些是 adapter/runtime/UI 的当前故障收口方式，帮助把 E2E 断言落到具体信号上；产品是否接受这些结果仍要单独确认。

| ID | 当前代码观察 | 证据入口 | 仍需产品确认 |
| --- | --- | --- | --- |
| N01 | HTTP `401/403` 会归一成 `ProviderNotConfigured` / `auth_failed`，不可重试；runtime 进入 `turn.failed`，UI 收到 `task_error` 后把 task runtime 标成 `failed`。 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`、`packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | 是否要强制打开/引导设置；queue、输入草稿和错误恢复入口怎么保留 |
| N02 | provider 不存在会在 registry resolve 阶段抛 `ProviderNotFound`；API Key 缺失会抛 `ProviderNotConfigured`，通常没有真实模型请求发出。 | `apps/zcode-cli/packages/adapters/src/model/registry.ts` | send 前禁用还是点击后失败；错误是否定位到设置页具体 provider |
| N03 | HTTP `429` 会归一成 `ModelRateLimited` / `rate_limited`，默认可重试；retry 期间会发布 `model_request_failed` 和 `model_retry_scheduled`，当前运行 turn 底部可显示 `apiRetry`。默认 retry 配置是最多 10 次 retry，即 `maxAttempts=11`，可被 env/config 覆盖。 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`、`apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`、`apps/zcode-cli/packages/adapters/src/model/retry-policy.ts`、`packages/ui/src/v4/ConversationTurnGroup.tsx`、`packages/ui/src/chat-input-toolbar/display.tsx` | 429 是否真的要按默认 retry；重试期间用户能否继续入队；最终失败后 queue 如何处理 |
| N04 | HTTP `5xx` 会归一成 `ModelRequestFailed` / `server_error`，默认可重试；`503` 没有独立产品语义，和其他 `5xx` 同类。 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`、`apps/zcode-cli/packages/adapters/tests/runner.test.ts` | 是否区分 502/503；最终失败后是否允许 retry/edit/fork |
| N05-code | HTTP `500` JSON error 若被 provider business parser 识别，会保留 provider message / code；否则按通用 `server_error` 处理并重试。 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`、`apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts`、`apps/zcode-cli/packages/adapters/src/model/registry.ts` | 错误文案要展示 provider 原文还是统一文案；哪些 provider code 需要专门产品处理 |
| N06 | DNS/connection refused/代理失败/TLS 失败等会归一到 network/proxy/tls 类 failure；其中 network/proxy 默认可重试，TLS 不可重试。 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts` | user message 是否保留为失败轮次；断网期间是否显示专门网络状态 |
| N07 | 非流式请求 timeout 会归一成 `ModelRequestTimeout` 并默认可重试；SSE 无 event 的 stall 是单独的 `model_stream_stalled` 状态。 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`、`apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts` | 超时阈值和 UI 文案；用户 stop 后是否等价 interrupted |
| N08 | 200 但非法模型响应没有独立产品语义；当前通常由 AI SDK/adapter 抛错后归一为 `ModelRequestFailed` 或 provider business failure。 | `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`、`apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | malformed 是协议错误、provider 错误，还是可恢复错误 |
| N09 | session title sidecar 是异步 fire-and-forget；失败只写 warn，不影响主 turn 完成。goal summary title 有 fallback title。 | `apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/goal-summary-title.ts` | 列表标题 fallback 文案和是否需要给用户可见提示 |

| ID | 来源/别名 | 场景 | 必须确认的问题 | 候选口径 | 确认后下一步 |
| --- | --- | --- | --- | --- | --- |
| N01 | - | 主模型请求返回 401/403 | 是否进入错误态；是否引导重新配置 API Key；queue 是否保留 | 阻止继续发送 / 保留 queue 并允许修配置后重试 / 直接失败当前轮 | 写 network fault fixture 和 UI error 断言 |
| N02 | - | provider 未配置或 API Key 缺失 | send 前阻止还是发出后失败；输入框内容是否保留 | 发送前禁用 / 点击发送后弹设置引导 / 进入错误消息 | 写 provider 缺失 setup 和无模型请求断言 |
| N03 | - | 主模型请求返回 429 | 是否自动重试；重试期间能否继续入队；最终失败后 queue 如何处理 | 自动重试 / 不重试直接失败 / 保留 queue 等用户手动处理 | 写 429 retry timeline 和 queue 断言 |
| N04 | - | 主模型请求返回 502/503 | 是否自动重试；失败后能否 retry/edit/fork | 自动重试 / 不重试直接失败 / 区分 502 与 503 | 写 503 replay 和 action button 断言 |
| N06 | - | DNS/connection refused，未拿到响应头 | user message 是否保留；是否可继续发消息；queue 如何处理 | 保留 user 并进入 error / 回退 draft / interrupted completed | 写 connection error fixture 和 snapshot 断言 |
| N07 | - | 请求超时，长时间无响应头 | 超时阈值；是否允许 stop；是否自动失败 | 一直 running 可 stop / 到阈值自动失败 / 仅提示网络慢 | 写 timer-controlled fixture |
| N08 | - | 200 但响应不是合法模型 JSON/SSE | 按模型错误还是协议错误；是否可 retry | protocol error / provider error / 忽略坏片段 | 写 malformed fixture 和日志断言 |
| N09 | - | title/sidecar 请求失败 | 是否完全不影响主会话；列表标题如何显示 | 主轮成功且标题 fallback / 显示 title error / 静默 warn | 写 sidecar failure 不污染主 turn 断言 |

## P0：SSE 流式故障

### 当前代码观察（非产品决策）

当前 adapter 对 SSE 的核心分界是“是否已经越过可见 retry boundary”。`start`、`text_start`、`text_end`、`reasoning_start/end`、`tool_input_*` 会先缓冲；一旦出现 `text_delta`、`reasoning_delta`、`tool_call` 等用户可见事件，后续失败不再自动 retry，避免重复输出或工具错序。

| ID | 当前代码观察 | 证据入口 | 仍需产品确认 |
| --- | --- | --- | --- |
| S01 | 只有响应头、没有任何可见 SSE event 时，adapter 仍处在 retry-safe 区域；若错误被分类为 retryable，会走重试，否则最终 `task_error`。正常 EOF 但内容不完整可能被 suspicious empty stream 逻辑转成 provider business/model failure。 | `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`、`apps/zcode-cli/packages/adapters/src/model/stream-retry-boundary.ts` | 是否等价模型错误；是否需要给“空响应”专门文案 |
| S02 | `message_start` / stream `start` 属于 retry-safe prelude，不会立刻作为用户可见正文提交；断开后的结果取决于错误是否 retryable。 | `apps/zcode-cli/packages/adapters/src/model/stream-retry-boundary.ts`、`apps/zcode-cli/packages/adapters/tests/runner.test.ts` | 如果最终失败，UI 是否生成 assistant error/interrupted 占位；queue 是否保留 |
| S03 | 一旦已有 `text_delta` 或 `reasoning_delta`，adapter 不再 retry；断流会抛模型失败，上层把 task 收口为 failed。当前已收到的可见 delta 会留在消息流里，但产品上是否算 interrupted 仍未定义。 | `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`、`packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | 部分文本是否允许 fork/edit；最终状态应是 failed 还是 interrupted |
| S04 | malformed SSE frame 如果不能被 provider business parser 识别，通常会由 AI SDK/adapter 抛为模型请求失败；没有专门的 malformed-event 产品分类。 | `apps/zcode-cli/packages/adapters/src/model/registry.ts`、`apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | 坏 event 是终止、忽略、还是尝试恢复 |
| S05 | HTTP 200 SSE `event: error` / provider business error frame 会被 registry transform 转成 `ProviderBusinessError`，再进入 `model_request_failed`；可重试性按 provider code/status 分类。 | `apps/zcode-cli/packages/adapters/src/model/registry.ts`、`apps/zcode-cli/packages/adapters/tests/runner.test.ts` | provider error 是否展示原文；哪些业务码需要特殊 UI |
| S06 | stream idle timeout 会先发布 `model_stream_stalled`，随后 abort 当前 attempt；如果还没越过可见 retry boundary 且可重试，会增加 30s idle timeout 后重试。默认基础 idle timeout 是 10 分钟。 | `apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts`、`apps/zcode-cli/packages/adapters/tests/runner.test.ts` | UI 是否显示“慢/重连中”；超时后是否自动失败或允许 stop |
| S07 | stop 后底层 stream 即使继续发 late event，也应该因为 abort/inputId 收口被视为 stale；UI terminal handler 已按 `activeInputId` 忽略旧 terminal event。 | `apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts`、`packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts`、`packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts` | 是否需要专门记录 late event warn；新一轮是否必须用 inputId 证明未污染 |

| ID | 来源/别名 | 场景 | 必须确认的问题 | 候选口径 | 确认后下一步 |
| --- | --- | --- | --- | --- | --- |
| S01 | - | 响应头已返回，但无任何 SSE event 后断开 | 是否等价模型错误；user message 是否保留 | error assistant / interrupted completed / 重试 | 写 empty SSE fixture |
| S02 | - | `message_start` 后断开 | 是否生成 interrupted/error assistant；queue 是否自动 drain | interrupted assistant / error assistant / 无 assistant | 写 partial-start artifact 和 queue 断言 |
| S03 | - | 若干 text delta 后断开 | 部分文本是否保留；是否允许 fork/edit；queue 是否保留 | 保留 partial 并 interrupted / 标 error 但保留文本 / 丢弃文本 | 写 partial text 和 action button 断言 |
| S04 | - | SSE event JSON malformed | 坏 event 是终止还是忽略 | 立即 protocol error / 忽略该 event / 尝试恢复 | 写 malformed event fixture |
| S05 | - | provider 在 SSE 中发 error event | 是否显示 provider error；是否可重试 | provider error message / interrupted marker / auto retry | 写 SSE error event 断言 |
| S06 | - | stream stall，长时间无新 event | stall 超时阈值；是否显示停止或重试入口 | 一直 running / 超时失败 / 提示慢但不断开 | 写 delayed event fixture |
| S07 | - | stop 后 provider 继续发 late SSE event | late event 是否必须忽略，不能污染新一轮 | 按 inputId 丢弃 / 记录 warn / 若同 run 继续追加 | 写 stale inputId/late event 断言 |

## P1：文件系统/存储故障

### 当前代码观察（非产品决策）

这些观察只说明当前代码已经暴露出的存储失败边界。它们不能替代产品口径：比如用户是否看到 toast、输入是否保留、重启后如何恢复，仍需单独确认。

| ID | 当前代码观察 | 证据入口 | 仍需产品确认 |
| --- | --- | --- | --- |
| D01 | SQLite session store 在 `createSession`、`saveMessage`、`savePart`、`saveSessionEntry` 等写入前都会触发 `sqliteRun` fault。注入 `ENOSPC` 时，底层写入会 reject 原始 Node 风格错误；单测证明失败前不会落入对应消息表。当前还没有产品层合同说明 runtime 是保留内存态继续、进入 task error，还是要求用户先释放磁盘。 | `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`、`apps/zcode-cli/packages/adapters/tests/session-store.test.ts` | UI 告警形态；内存态/queue 是否保留；重启后未落盘 turn 如何标记 |
| D02 | workspace tool 写文件走 `NodeFileSystemAdapter.writeTextFile`。当前 fault injection 只覆盖父目录创建、非原子直接写入和删除边界；默认 `atomic: true` 路径不在 temp 写入 / rename 插入 `ZCODE_E2E_FS_FAULTS`。atomic temp/chmod/sync/rename 失败后会清理 temp，并 fallback 到 `O_TRUNC` 非原子写；该 fallback 可能截断目标文件，当前作为既定行为暂时接受。文件系统端会把 `ENOSPC` 归一成 `io_error`，把 `EACCES/EPERM` 归一成 `permission_denied`。 | `apps/zcode-cli/packages/adapters/src/fs/index.ts`、`apps/zcode-cli/packages/adapters/tests/fs-context.test.ts` | tool block 展示为失败还是让 assistant 继续解释失败；当前轮是否中断；是否提供重试/打开文件入口 |
| D03 | `setting.json` 直接写入、provider `config.json` 原子写入、provider display order 写入都接入了 fs fault。当前 service 会把 `EACCES/ENOSPC` reject 给调用方；setting 写失败不会创建目标文件，provider 原子 rename fault 会清理临时文件。 | `packages/services/src/setting/settingService.ts`、`packages/services/src/model-provider/modelProviderServiceStorage.ts`、`packages/services/test/settingService.test.ts`、`packages/services/test/atomicFileUtils.test.ts`、`packages/services/test/modelProviderServiceStorageAtomic.test.ts` | 设置页是否 inline error/toast；表单输入是否保留；UI 是否回滚到旧配置；保存失败是否阻止继续发消息 |
| D04 | SQLite DB open 已接入 `sqliteOpen` fault；打开失败会包装成 `SqliteSessionMigrationError(kind=open_failed)`。migration checksum / SQL 失败也有结构化 `SqliteSessionMigrationError`。`openStartupSqliteSessionStore` 当前只是直接打开 DB，没有额外的坏库隔离、跳过或恢复策略。 | `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`、`apps/zcode-cli/packages/adapters/src/storage/session-store/errors.ts`、`apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts`、`apps/zcode-cli/packages/adapters/tests/session-store.test.ts` | 坏 session/坏 DB 是跳过、隔离备份、显示恢复错误，还是阻止进入 workspace；是否允许用户导出日志/重建库 |
| D05 | 日志写入和 artifact 写入不是同一种产品语义。CLI JSONL logger 与 desktop main logger 会吞掉目录/append fault，日志失败不影响主流程；tool result artifact 写入失败时，tool executor 会回退到截断 inline 输出并保持工具调用成功；workspace checkpoint artifact 写入失败只记 warn，不阻断主轮。 | `apps/zcode-cli/packages/adapters/src/logging/index.ts`、`packages/desktop/src/main/logger.ts`、`apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/tools.ts`、`apps/zcode-cli/packages/adapters/tests/logging.test.ts`、`packages/desktop/test/logger.test.ts`、`apps/zcode-cli/packages/core/tests/tool-executor-trace.test.ts` | 哪些 artifact 失败需要用户可见提示；诊断日志缺失是否要暴露；大 tool 输出回退截断是否可接受 |

| ID | 来源/别名 | 场景 | 必须确认的问题 | 候选口径 | 确认后下一步 |
| --- | --- | --- | --- | --- | --- |
| D01 | - | session history 写入 ENOSPC | UI 是否告警；内存态是否保留；重启后如何恢复 | 立即 toast / 只日志 / 阻止继续会话 | 写 fs fault relaunch 断言 |
| D02 | - | tool 正在写 workspace 文件时磁盘满；当前注入边界限于父目录创建、非原子写入或删除，默认 atomic temp/rename 不注入 | tool error 如何展示；assistant 是否继续总结失败 | tool block failed / assistant 继续解释失败 / 中断当前轮 | 写 workspace 父目录创建 / 非原子写入 ENOSPC 断言 |
| D03 | - | 保存 provider 设置时 app data permission denied | 是否阻止保存并保留输入；是否写日志 | 表单错误并保留输入 / toast 后回滚 / 静默失败禁止 | 写 settings save EACCES 断言 |
| D04 | - | 启动恢复时 session snapshot 文件损坏 | 跳过坏 session、显示恢复错误，还是阻止进入 workspace | 跳过并提示 / 显示坏 session error / 阻止进入 | 写 corrupt snapshot fixture |
| D05 | - | 长时间流式日志/artifact 写入失败 | 产品流程是否继续；日志失败是否只 warn | 产品继续且 warn / 中断当前轮 / 提示诊断失败 | 写 log sink fault 断言 |

## P1：App 生命周期/进程故障

### 当前代码观察（非产品决策）

生命周期类 case 不能只看 React 状态。当前代码已经有窗口、host process、agent process、renderer restore 几层机制，但“用户应看到什么”和“运行中任务是否继续/恢复/中断”仍要定义成产品合同。

| ID | 当前代码观察 | 证据入口 | 仍需产品确认 |
| --- | --- | --- | --- |
| L01 | 切到其他 app / blur / visibility hidden 时，当前能证明的是 composer 草稿会在 `blur`、`pagehide`、`freeze`、`visibilitychange(hidden)` 时保存；没有看到 desktop main 或 UI 对 running session 做 pause 的逻辑。应用交互态只用于 telemetry。 | `packages/ui/src/hooks/useChatComposer.ts`、`packages/desktop/src/main/index.ts` | 后台时 SSE/agent 是否必须继续；回到前台是否需要追流/补快照；后台通知和 unread 如何表现 |
| L02 | “关闭窗口”不是单一语义：macOS 点击关闭默认 hide；Windows 可配置 close-to-tray；真正 `closed` 时才 dispose 对应 host process 并清理 remote/web remote 绑定。非最后窗口关闭会真实关闭该窗口，最后窗口关闭可能触发 quit 确认。 | `packages/desktop/src/main/desktopDarwinCloseBehavior.ts`、`packages/desktop/src/main/desktopWindowLifecycle.ts`、`packages/desktop/src/main/index.ts` | 关闭当前窗口但 app 未退出时，运行中 task 是继续后台、stop，还是随 host dispose 中断；隐藏窗口是否等价继续运行 |
| L03 | app quit 会在 `before-quit` 拦截第一次退出，调用 `prepareAppQuit` 等待所有 host process 清理；host 会 `disposeServiceResourcesAndWait`，agent process manager 会等待每个 agent `disposeAndWait`，先 stdin EOF，再进程树兜底。当前代码更像“退出时主动回收运行中 agent”，不是“退出后继续运行”。 | `packages/desktop/src/main/index.ts`、`packages/desktop/src/host/index.ts`、`packages/services/src/node.ts`、`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`、`packages/services/src/zcode-agent/zcodeStdioTransport.ts` | 重启后 running turn 应恢复、标 interrupted、标 failed，还是保留 notReady；用户是否看到上次退出说明 |
| L04 | renderer `dom-ready` 会检查同一 webContents 旧 host，先 dispose 旧 host，再 spawn 新 host；历史 task 打开会走 `resumeSession` / `resumeTask` / snapshot restore。restore 失败当前 UI 会把 runtime 设为 `notReady`，workspace init 标 `failed`，避免把恢复失败混成模型生成失败。 | `packages/desktop/src/main/desktopWindowLifecycle.ts`、`packages/ui/src/hooks/useTaskRestore.ts`、`packages/ui/src/lib/zcodeSessionRestore.ts`、`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | renderer reload 期间本地 queue/activeInputId 是否必须保留；running continuous 是否靠 snapshot 恢复还是标 interrupted |
| L05 | host process exit 会从 main 的 maps、broadcast hub、task realtime bus 中注销；task realtime bus 会让 pending owner command / session message delivery 失败，并释放 lease、发 snapshot invalidation。没有看到本地窗口 host crash 后自动重启并恢复同一个 running session 的主流程。 | `packages/desktop/src/main/desktopHostProcess.ts`、`packages/desktop/src/main/taskRealtimeBus.ts` | host crash 后 UI 是全局错误、workspace notReady、自动重建 host，还是要求用户 reload；queue/permission pending 如何处理 |
| L06 | agent 子进程退出会触发 stdio transport close，protocol client reject 所有 pending request；process manager 从 workspace 进程池移除该 client。当前注释也说明 agent native crash 后 UI 常见信号是 protocol close / `Session is not active`，而不是专门的 crash 分类。UI 对 `task_error(PROCESS_EXIT/PROCESS_ERROR)` 有失败态处理，但 agent crash 是否稳定映射到这类 stream event 仍需 E2E 证明。 | `packages/services/src/zcode-agent/zcodeStdioTransport.ts`、`packages/services/src/zcode-agent/zcodeProtocolClient.ts`、`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`、`packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | agent crash 是否自动重启；当前轮/queue 是否保留；错误码是否必须统一成 `PROCESS_EXIT` |
| L07 | 没看到 desktop `powerMonitor` / OS sleep-wake 专门处理。与 sleep/wake 最接近的是 SSE stall、transport close、restore/snapshot 机制，但它们不是系统睡眠产品语义。 | `packages/desktop/src/main/index.ts`、`packages/services/src/zcode-agent/zcodeAgentService.ts`、`packages/ui/src/hooks/useTaskRestore.ts` | sleep/wake 后应继续等待、自动失败、自动 reconnect，还是提示用户手动恢复；超时阈值如何设 |
| L08 | compacting 时 app 退出没有独立收口路径；会走 L03 的 app quit/host dispose/agent dispose。compact marker 的最终可见状态取决于退出前是否已写入 start / failed / completed timeline，以及恢复时 snapshot 能读到什么。当前没有“compacting during quit”的专门恢复合同。 | `packages/desktop/src/main/index.ts`、`packages/desktop/src/host/index.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`、`packages/ui/src/hooks/useTaskRestore.ts` | 重启后 compact marker 是 failed、interrupted、unknown 还是移除；触发 compact 的 pendingAction/queue 如何恢复 |

| ID | 来源/别名 | 场景 | 必须确认的问题 | 候选口径 | 确认后下一步 |
| --- | --- | --- | --- | --- | --- |
| L01 | - | 用户切到其他 app 或最小化 | session 是否继续运行；回来后 UI 如何追流 | 继续运行并追上 / 后台暂停 / 仅 UI 停止渲染 | 写 background/foreground 断言 |
| L02 | - | 关闭当前窗口但不退出 app | host/agent 是否继续；重开窗口后如何恢复 | 继续后台 / stop 当前轮 / 关闭 host | 写 window close/open 断言 |
| L03 | - | 退出 app 后重新打开 | 当前轮继续、恢复、还是标 interrupted | relaunch interrupted / replay resume / 丢弃 running | 写 quit/relaunch 断言 |
| L04 | - | renderer reload/crash | continuous 链路是否重接；queue 是否丢失 | 重接并保留 queue / 标 interrupted / 重建详情页 | 写 renderer reload 断言 |
| L05 | - | host process crash/restart | 是否重建 host；session 状态如何恢复 | 重建并恢复 snapshot / 全部 error / 要求重开 workspace | 写 kill host helper |
| L06 | - | agent process crash/exit | UI 是否进入 error；queue 是否保留；能否 retry | 当前轮 error queue 保留 / interrupted completed / 自动重启 agent | 写 kill agent 断言 |
| L07 | - | 系统 sleep/wake | SSE 断开后如何处理；是否自动恢复 | 继续等待 / 失败可重试 / 自动重连 | 写 sleep/stall 模拟 |
| L08 | - | compacting 时 app 关闭/退出 | compact marker 重启后状态是什么 | failed / interrupted / unknown / 移除 marker | 写 compact relaunch 断言 |

## P2：Workspace / Tool 外部变化

### 当前代码观察（非产品决策）

这一组的关键不是“代码是否会报错”，而是 workspace / tool / remote 的外部变化如何转成用户可理解的产品状态。当前代码已经有若干保护边界，但还没有统一的会话区产品合同。

| ID | 当前代码观察 | 证据入口 | 仍需产品确认 |
| --- | --- | --- | --- |
| W01 | 文件/目录缺失主要在调用时发现：`NodeFileSystemAdapter` 会把底层 `ENOENT` 归一成 `not_found`，Git service 对 workspace missing cwd 也会降级成 `isRepository=false`。没有看到“workspace 根被删除或重命名后，整个会话区进入只读/锁输入/重选目录”的全局状态机。 | `apps/zcode-cli/packages/adapters/src/fs/index.ts`、`packages/services/src/git/repo/gitCliRepo.ts`、`packages/services/src/git/repo/gitCliHelpers.ts` | workspace 根缺失后，输入框、队列、tool 调用、历史消息和文件树各自应该是什么状态 |
| W02 | tool 写文件有两层新鲜度保护：Write 工具要求覆盖已有文件前必须读过完整文件，否则返回 errorCode 2（未读）；如果读后文件内容被外部修改，返回 errorCode 3（已过期）。底层 FileSystemPort 还支持 `expectedRevision`，revision 不匹配是 `stale_write`，目标消失是 `not_found`。 | `apps/zcode-cli/packages/core/src/tool/handlers/write.ts`、`apps/zcode-cli/packages/adapters/src/fs/index.ts`、`apps/zcode-cli/packages/core/tests/write-tool-contract.test.ts`、`apps/zcode-cli/packages/core/tests/file-tool-port.test.ts` | tool block 显示失败后，assistant 是否继续解释失败；当前轮是否算 failed；用户是否能一键重试/重新读 |
| W03 | Git 能力有降级边界：`resolveRepository` 区分 git binary 不可用、非仓库和 missing cwd；diff 在不可用时返回 unavailable diff；Git action menu 只有 `isGitAvailable && isRepository` 才可用。agent 侧 git context 明确是“conversation start snapshot”，不会在会话中实时更新。 | `packages/services/src/git/repo/gitCliRepo.ts`、`packages/ui/src/git-action-menu/display.ts`、`apps/zcode-cli/packages/core/src/context/sections/env-info.ts` | dirty state 或 repo 状态变化后，UI 是否自动重新探测；agent 下一轮是否必须拿到新 git 状态；旧轮是否保留 snapshot 语义 |
| W04 | remote workspace 断开时，host 会主动 dispose 并退出；main 的 realtime bus 在 host unregister 时会失败 pending owner command / session message delivery，并给 lease 发送 `task_snapshot_invalidated(stream_mirror_owner_lost)`。mobile shared-host attachment 必须携带 `workspaceIdentity`，否则拒绝建立身份隔离。 | `packages/desktop/src/host/index.ts`、`packages/desktop/src/main/taskRealtimeBus.ts`、`packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts` | desktop continuous 和 mobile replayable 在远端断开后分别展示什么；是否自动重连；queue/permission pending 是否保留 |
| W05 | 权限请求已经是 task 级队列：`permission_request` 会写入 store，多个请求顺序排队；切任务回来仍能看到待处理权限。runtime snapshot 也会先清旧 pending，再重放服务端 pending permission。client close 时 service 会清理对应 pending permission / user input / provider header。 | `packages/ui/src/hooks/taskStreamEventHandlers.ts`、`packages/ui/src/store/zcodeSessionStoreTaskSlice.ts`、`packages/ui/src/hooks/useTaskRestore.ts`、`packages/services/src/zcode-agent/zcodeAgentService.ts`、`packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts` | 用户切 session、关闭窗口或断线后，pending permission 是保留、过期、自动 reject，还是只绑定 active session |

| ID | 来源/别名 | 场景 | 必须确认的问题 | 候选口径 | 确认后下一步 |
| --- | --- | --- | --- | --- | --- |
| W01 | - | workspace 目录被删除或重命名 | 是否锁输入、提示重选、还是保留只读历史 | 只读历史 / 阻止输入 / 允许继续但 tool 失败 | 写 workspace missing 断言 |
| W02 | - | tool read/write 中目标文件被外部修改/删除 | tool error 如何展示；后续 assistant 是否知道失败 | tool failed / retry read / assistant 总结失败 | 写 external fs mutation 断言 |
| W03 | - | git repo 不存在或 dirty state 改变 | 是否降级为普通文件工作区 | capability 降级 / tool error / 自动重新探测 | 写 git capability 断言 |
| W04 | - | remote workspace SSH/WSL/Docker 连接断开 | mobile replayable 和 desktop continuous 各自如何恢复 | desktop error / mobile replayable gap / 自动重连 | 写 remote disconnect harness |
| W05 | - | permission request pending 时用户关闭或切换 session | pending request 保留、过期，还是自动 reject | 保留到回到 session / 自动 reject / 绑定 active session | 写 pending permission 断言 |

## P2：跨 Session 故障隔离

### 当前代码观察（非产品决策）

跨 session 隔离需要同时看 taskId、workspaceIdentity 和 activeInputId。当前代码有隔离机制，但还需要 E2E 证明“非当前 session 的失败不会污染当前用户正在看的页面”。

| ID | 当前代码观察 | 证据入口 | 仍需产品确认 |
| --- | --- | --- | --- |
| X01 | UI runtime / error / messages 都按 workspace state + taskId 写入；`task_error` handler 读取带 `workspaceIdentity` 的 workspace state，并只更新事件里的 taskId。terminal event 还会按 `activeInputId` 丢弃旧 input 的迟到失败态，避免污染新一轮。 | `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts`、`packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | A 在后台失败时，B 是否完全无感；是否允许全局 toast；A 列表 item 是否要显示 error badge |
| X02 | compact marker 属于 task 消息/timeline 投影，stream 与 restore 都按 taskId 回填。理论上 A compact 失败应落在 A 的消息/marker 上，不该改写 B 的 toolbar/sidebar，但当前还缺少“B active 时 A compact fail”的专门 E2E。 | `packages/ui/src/lib/zcodeSessionProjection.ts`、`packages/ui/src/hooks/taskStreamEventHandlers.ts`、`packages/ui/src/hooks/useTaskRestore.ts` | A 的 compact failed marker 是否只在切回 A 后展示；列表是否显示 compact failure；是否有全局提示 |
| X03 | 切回历史 task 会走 restore/snapshot，把 pending permissions、runtime、messages 等按 taskId 回填；完整错误对象也已从组件本地 state 移到 task store，避免切页后丢 traceId/code。restore 失败会进入 workspace init failed，而不是混成模型生成失败。 | `packages/ui/src/hooks/useTaskRestore.ts`、`packages/ui/src/store/zcodeSessionStoreTaskSlice.ts`、`packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | 切回 A error 后，error banner、queue、retry/edit/fork/compact 按钮应如何恢复；restore failed 与 task failed 的 UI 区分 |

| ID | 来源/别名 | 场景 | 必须确认的问题 | 候选口径 | 确认后下一步 |
| --- | --- | --- | --- | --- | --- |
| X01 | - | A running，B active，A 主模型请求失败 | B 主视图不能被 A 错误覆盖；A 列表状态如何显示 | 只 A item error / 全局 toast / 切回 A 才显示 | 写 inactive failure isolation 断言 |
| X02 | - | A compacting，B active，A compact 失败 | B toolbar/sidebar 是否完全不受 A marker 影响 | 完全隔离 / 列表显示 A marker / 全局提示 | 写 inactive compact failure 断言 |
| X03 | - | A error，B active，切回 A | A 的 error、queue、可操作按钮如何恢复显示 | 恢复完整 error state / 只显示历史 / 自动清 error | 写 switch-back error state 断言 |
