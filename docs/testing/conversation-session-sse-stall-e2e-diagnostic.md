# Conversation Session SSE Stall E2E Diagnostic

## 目标与边界

本文定义一组 Desktop 真实链路诊断 E2E，用本地 replay provider 在不同 SSE 语义边界停止下发 event，观察 idle timeout、自动恢复、UI 投影、网络请求和工具副作用。

运行链路不是 adapter/core 单测，而是：

```text
Desktop renderer (desktop-continuous)
  -> window-scoped Local Host
    -> ZCode CLI runtime
      -> provider adapter
        -> local replay HTTP/SSE server

first request:  event...event...<cut point>........(silence > idle timeout)
                                                   |
                                                   v
                                      adapter/core recovery boundary
                                                   |
second request:                          provider request -> success SSE
                                                   |
                                                   v
                         runtime event -> Host -> renderer -> V4 timeline
```

本轮只验证 desktop local 的 `desktop-continuous` 主链路，不修改 mobile `/remote` 的 `web-remote-replayable` gap/snapshot 恢复边界，也不新增 relay/main 业务状态。remote workspace、queue/Stop 竞争、重启恢复、重试耗尽和有副作用工具均不与本诊断矩阵叉乘。

## 为什么是 diagnostic

顶层 `S02/S03/S06` 的最终产品合同仍是 `decision-needed`：例如 partial text 最终应保留、折叠还是标错，重试耗尽后是 failed 还是 interrupted，按钮和 queue 如何处理，尚未定案。因此本 spec 放在 `manual-review/pending`：

- 硬断言只覆盖已经确认或安全所必需的不变量；
- 未定案的 UI/终态只采样，不把当前实现误写成产品合同；
- 跑出的事实回填本文“实测结果”，供后续产品裁决；
- 不把 pending diagnostic 计为顶层 fault `covered`。

已确认的 `S02-R1` 继续成立：reasoning-only 可重试断流或 idle timeout 应丢弃不完整 reasoning tail，从安全锚点以新的 assistant identity 恢复，不改变 queue、Stop 或交付边界。

## 中断点矩阵

| Case      | 首次 SSE 截止位置                                                                           | 语义边界                                            | 硬断言                                                                                                                       | 诊断采样                                                         |
| --------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| SSE-ST-01 | 仅 `message_start`                                                                          | retry-safe prelude                                  | 最终成功；主请求恰好 2 次；无工具调用                                                                                        | stall 时 `canStop/runtimeStatus/timeline`；收口后的 row/timeline |
| SSE-ST-02 | thinking block 内，已有 `thinking_delta`                                                    | reasoning-only visible boundary                     | 最终成功；主请求恰好 2 次；不完整 reasoning 不进入恢复请求历史；无工具调用                                                   | thinking marker 在运行态是否可见、恢复后如何投影                 |
| SSE-ST-03 | text block 内，已有 `text_delta`                                                            | user-visible text boundary                          | partial marker 曾在 live UI 出现；stall 必须有界退出；若发生恢复则最终成功；无工具调用                                       | partial 在恢复后保留/折叠/移除的当前行为                         |
| SSE-ST-04 | tool block 内，`input_json_delta` 是未闭合 JSON                                             | tool 尚未 commit                                    | stall 必须有界退出；未执行该工具；若发生恢复则请求不含未完成 tool call                                                       | 未闭合 tool block 是否进入 UI/store                              |
| SSE-ST-05 | tool block 已 `content_block_stop`，但没有 `message_delta/message_stop`                     | committed tool block / uncommitted message boundary | `content_block_stop` 后工具执行一次；恢复请求携带成功 `tool_result`；同一 toolCallId 不重复执行                              | complete tool block 在恢复后的 UI/runtime 投影                   |
| SSE-ST-06 | 首条流已正常结束且只读 `Read` 已成功执行；下一次模型 continuation 在 `message_start` 后停发 | post-tool continuation boundary                     | 工具只执行一次；三条主请求依次为 tool call、stalled continuation、recovered continuation；后两条都携带同一成功 `tool_result` | 工具完成后 stall 的 loading/runtime 投影                         |

每个 stalled 响应都在 cutoff 后安排一个晚于 E2E idle timeout 的哨兵 event。客户端应先因 idle timeout 取消该 attempt；下一条 fixture 立即返回唯一完成 marker。E2E worker 只为本 spec 把模型流 idle timeout 缩短到 `1000ms`，不进入生产配置，也不扩散到其他 worker。

## 证据与判定

每个 case 必须同时采集：

| 层            | 证据                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| UI            | cutoff marker、`canStop`、timeline 文本、row 数；恢复完成 marker 与 idle 状态 |
| Network       | 主请求序列、`fixtureId/status` 与恢复请求的消息历史                           |
| Runtime/store | `runtimeStatus/state/activeInputId` 在 stall 与完成后的快照                   |
| Tool          | DOM/store 中 toolCallId 数量；provider 实际收到的 `tool_result` 与 `isError`  |

失败判据是：没有触发真实恢复 provider request、恢复后无法完成、恢复请求被旧 partial 污染、未提交工具被执行、已提交工具没有执行、已成功执行的工具被重复执行，或工具结果没有成为恢复锚点。当前 UI 如何展示 discarded partial、最终是否显示 interrupted history，只记录事实，不据此让 diagnostic 失败。

replay capture 只在 response handler 正常结束时回填 `responseEvents`。本组 stalled attempt 会先被客户端 idle watchdog abort，因此 capture 中该条记录保持 `pending` 且 `responseEventCount=0`；这不代表 cutoff event 没有到达。cutoff 是否到达由 fixtureId、live UI cutoff marker、runtime streaming 状态及 Agent streaming 日志交叉证明，随后出现的新 provider request 证明 watchdog 已取消旧 attempt 并进入恢复。

正式隔离回放发现恢复请求也有建档窗口：SSE-ST-06 的恢复请求于 `06:28:53.931` 建立，
于 `.960` 正常完成；只等请求数量增长可能读到 `fixtureId=null`。恢复结果须等该请求的
capture 状态退出 `pending` 后判定，并断言响应为 200；不等待被 watchdog 取消的旧 stall 请求。
原来的 5 秒哨兵上界、请求次数、历史与工具副作用断言仍生效，不增加延时或重试。

## Fixture 与 spec

- provider fixture：`packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-sse-stall-diagnostic.json`
- case manifest：`packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-sse-stall-diagnostic.json`
- pending spec：`packages/desktop/test/e2e/conversation-session/runtime/conversation-session-sse-stall-diagnostic.test.ts`

运行命令：

```bash
desktop_dir="$PWD/packages/desktop"
E2E_PROVIDER_REPLAY_FIXTURE_PATH="$desktop_dir/test/e2e/fixtures/upstream/common.json,$desktop_dir/test/e2e/fixtures/upstream/conversation-session/conversation-session-sse-stall-diagnostic.json" \
  pnpm --filter @zcode/desktop test:e2e:serial -- \
  --spec ./test/e2e/conversation-session/runtime/conversation-session-sse-stall-diagnostic.test.ts
```

## 实测结果

2026-08-27 在 macOS 上完成真实 WDIO 运行，6/6 通过。测试 worker 的 base idle timeout 为 `1000ms`，每个 stalled fixture 的哨兵 event 在 `5000ms`；六个 case 都在哨兵到达前进入恢复并最终回到 idle。本轮 watchdog 到恢复请求/terminal 的观测时间约为 `0.9s~2.8s`，差异包含事件切点、runtime 调度和 retry backoff，不应当解释为生产 SLA。

| Case      | 当前实现实测事实                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE-ST-01 | 仅收到 `message_start` 时 UI 保持 streaming/可 Stop；idle timeout 后从 user 安全锚点发起第 2 次模型请求并成功，最终回到 idle。                                               |
| SSE-ST-02 | thinking partial 在 live UI 可见；恢复请求不携带该不完整 reasoning，完成后 partial 不再显示，第 2 次模型请求成功。                                                           |
| SSE-ST-03 | text partial 在 live UI 可见；当前实现仍自动发起第 2 次模型请求并成功，完成后 partial 不再显示。该丢弃行为仍是产品待裁决项。                                                 |
| SSE-ST-04 | 未闭合 `input_json_delta` 不提交、不执行 `Read`，恢复请求也不携带该 tool call；第 2 次模型请求成功。                                                                         |
| SSE-ST-05 | 收到 tool `content_block_stop` 后，即使 assistant 没有 `message_delta/message_stop`，`Read` 仍立即执行且成功；idle timeout 后第 2 次请求携带成功 `tool_result`，未重复执行。 |
| SSE-ST-06 | 第一条模型流正常提交并成功执行 `Read`；携带成功 `tool_result` 的第 2 次 continuation 卡住后，只重试模型 continuation 为第 3 次请求，工具未重复执行。                         |

所有切点的 stall 快照均为 `canStop=true/state=streaming`，完成后均为 `canStop=false/state=idle`。SSE-ST-05 的 Agent 日志进一步证明 `content_block_stop` 是实际工具提交边界：同一 toolCallId 只出现一次 `tool.call.started/completed`，随后成功结果成为 stream recovery anchor。

生产默认 base idle timeout 是 `600000ms`，第一次 recovery request 的 idle timeout 为 `630000ms`，之后每次增加 `30000ms`。本 E2E 只缩短当前 worker 的 base 值，验证的是状态机与副作用边界，不代表线上会在 1 秒后恢复。
