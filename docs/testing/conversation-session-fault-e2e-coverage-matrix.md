# Conversation Session Fault E2E Coverage Matrix

本文把 [conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md) 中的产品 fault case 和后续 WDIO E2E 覆盖状态一一对齐。

核心口径：fault case 必须先有产品结论，才能写稳定断言。`decision-needed` 不能伪装成 `covered`；`covered` 必须有独立 setup/action/assert 和自动化证据。

## 覆盖状态定义

| 状态              | 含义                                        |
| ----------------- | ------------------------------------------- |
| `decision-needed` | 产品预期未确认，不能写稳定断言              |
| `missing`         | 产品预期已 accepted，但还没有独立自动化断言 |
| `covered`         | 已有独立自动化断言覆盖                      |
| `failing`         | 已有自动化探针，但当前实现不满足产品预期    |
| `partial`         | 只有弱断言或覆盖了相邻语义，不能算完整证明  |
| `ignored`         | 产品确认当前版本不覆盖                      |
| `invalid`         | 产品确认该组合被前置规则剪掉                |

## Fault 测试缩写

fault spec 在正式目录前可以先以 `manual-review/pending` 形式登记；pending 仍算 `missing`，不能计入 `covered`。

| 缩写 | Spec                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| NQ   | `packages/desktop/test/e2e/conversation-session/queue/conversation-session-turn-error-queue-preserved.test.ts` |

## 当前统计

| 范围                   | 数量 |
| ---------------------- | ---: |
| 产品 fault row         |   40 |
| decision-needed        |   36 |
| missing accepted fault |    4 |
| covered                |    0 |
| failing probe          |    0 |
| partial                |    1 |
| ignored                |    0 |
| invalid                |    0 |
| 自动化缩写             |    1 |
| 被引用自动化缩写       |    1 |
| 有测试声明的 spec      |    1 |
| 含 skip/only 的 spec   |    0 |

## N. 模型/API 请求故障

| ID  | 覆盖状态        | 自动化 | 备注                                                                                                                                  |
| --- | --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| N01 | decision-needed |        | 主模型请求返回 401/403                                                                                                                |
| N02 | decision-needed |        | provider 未配置或 API Key 缺失                                                                                                        |
| N03 | decision-needed |        | 主模型请求返回 429                                                                                                                    |
| N04 | decision-needed |        | 主模型请求返回 502/503                                                                                                                |
| N05 | partial         | NQ     | 正式隔离与默认回放均通过：500 后保留 queue、暂停自动消费、显式继续后恢复；尚未独立断言 provider message/code 与错误卡片，不计完整覆盖 |
| N06 | decision-needed |        | DNS/connection refused，未拿到响应头                                                                                                  |
| N07 | decision-needed |        | 请求超时，长时间无响应头                                                                                                              |
| N08 | decision-needed |        | 200 但响应不是合法模型 JSON/SSE                                                                                                       |
| N09 | decision-needed |        | title/sidecar 请求失败                                                                                                                |

## S. SSE 流式故障

| ID  | 覆盖状态        | 自动化 | 备注                                                                                    |
| --- | --------------- | ------ | --------------------------------------------------------------------------------------- |
| S01 | decision-needed |        | 响应头已返回，但无任何 SSE event 后断开                                                 |
| S02 | decision-needed |        | `message_start` / thinking 后 stall 已有 pending diagnostic；只采当前事实，不计 covered |
| S03 | decision-needed |        | text delta 后 stall 已有 pending diagnostic；partial 最终产品语义仍待确认               |
| S04 | decision-needed |        | SSE event JSON malformed                                                                |
| S05 | decision-needed |        | provider 在 SSE 中发 error event                                                        |
| S06 | decision-needed |        | 六类 cutoff 已有真实 idle-timeout/recovery diagnostic；最终 UI/耗尽语义仍待确认         |
| S07 | decision-needed |        | stop 后 provider 继续发 late SSE event                                                  |

### 已确认恢复子边界证据

| ID     | 覆盖状态 | 自动化            | 备注                                                                                                                                                         |
| ------ | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S02-R1 | partial  | Core focused unit | reasoning-only 可重试断流/idle timeout 已证明安全锚点、新 assistant message id 与 discard 事件；pending fault-stream E2E 已补，但仍不计入顶层 fault 覆盖统计 |

pending diagnostic 的断言和证据边界见 [conversation-session-sse-stall-e2e-diagnostic.md](./conversation-session-sse-stall-e2e-diagnostic.md)。它覆盖真实 Desktop → Host → CLI → provider → V4 UI 链路，但在顶层产品结论确认前不登记 fault 自动化缩写，仍不计入 covered。

## C. Compact 故障别名

`C01-C03` 是主路径 `F09/G11/G12` 的环境故障视角别名。它们不额外增加 unique product case，但必须和源 case 的决策状态保持一致。

| ID  | 覆盖状态 | 自动化 | 备注                                                                                                                              |
| --- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| C01 | missing  |        | F09：手动 compact 的 streaming 主腿与 non-stream fallback 腿均失败（已裁决：completed + failed marker + retry，待补稳定断言 E2E） |
| C02 | missing  |        | G11：自动 compact 连续 3 次失败（已裁决：继续无压缩执行 + circuit breaker，待补稳定断言 E2E）                                     |
| C03 | missing  |        | G12：自动 compact 被 stop（已裁决：与普通 stop 对齐、pendingAction 留时间线，待补稳定断言 E2E）                                   |

## D. 文件系统/存储故障

| ID  | 覆盖状态        | 自动化 | 备注                                                                                                                |
| --- | --------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| D01 | decision-needed |        | session history 写入 ENOSPC                                                                                         |
| D02 | decision-needed |        | tool 正在写 workspace 文件时磁盘满；当前 fault 注入限于父目录创建、非原子写入或删除，默认 atomic temp/rename 不注入 |
| D03 | decision-needed |        | 保存 provider 设置时 app data permission denied                                                                     |
| D04 | decision-needed |        | 启动恢复时 session snapshot 文件损坏                                                                                |
| D05 | decision-needed |        | 长时间流式日志/artifact 写入失败                                                                                    |

## L. App 生命周期/进程故障

| ID  | 覆盖状态        | 自动化 | 备注                        |
| --- | --------------- | ------ | --------------------------- |
| L01 | decision-needed |        | 用户切到其他 app 或最小化   |
| L02 | decision-needed |        | 关闭当前窗口但不退出 app    |
| L03 | decision-needed |        | 退出 app 后重新打开         |
| L04 | decision-needed |        | renderer reload/crash       |
| L05 | decision-needed |        | host process crash/restart  |
| L06 | decision-needed |        | agent process crash/exit    |
| L07 | decision-needed |        | 系统 sleep/wake             |
| L08 | decision-needed |        | compacting 时 app 关闭/退出 |

## W. Workspace / Tool 外部变化

| ID  | 覆盖状态        | 自动化 | 备注                                                |
| --- | --------------- | ------ | --------------------------------------------------- |
| W01 | decision-needed |        | workspace 目录被删除或重命名                        |
| W02 | decision-needed |        | tool read/write 中目标文件被外部修改/删除           |
| W03 | decision-needed |        | git repo 不存在或 dirty state 改变                  |
| W04 | decision-needed |        | remote workspace SSH/WSL/Docker 连接断开            |
| W05 | decision-needed |        | permission request pending 时用户关闭或切换 session |

## X. 跨 Session 故障隔离

| ID  | 覆盖状态        | 自动化 | 备注                                   |
| --- | --------------- | ------ | -------------------------------------- |
| X01 | decision-needed |        | A running，B active，A 主模型请求失败  |
| X02 | decision-needed |        | A compacting，B active，A compact 失败 |
| X03 | decision-needed |        | A error，B active，切回 A              |
