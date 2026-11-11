# Conversation Session Decision Review Queue

目标：把当前仍待产品决策的会话区 case 按固定顺序展开，产品确认后再回写 catalog、coverage matrix 和 E2E。

生成命令：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md
```

## 当前状态

| 指标 | 当前值 |
| --- | ---: |
| Product case 总数 | 232 |
| 已覆盖 | 126 |
| 待产品决策 / 自动化 | 36 |
| 协议题总数 | 36 |
| 协议题 unanswered | 36 |
| Ready case | 0 |
| Blocked case | 36 |
| 下一批 review | N01, N02, N03 |
| 当前输出范围 | 全部待产品决策 case |
| 当前输出 case | 36 |

## 使用方式

1. 按本文件顺序 review case。
2. 对每个 `Question` 写下明确产品结论。
3. 回到对应 decision worksheet，把 `产品结论` 从 `待确认` 改成明确结论，并把 `Status` 改成 `answered`。
4. 按 `回写目标` 更新源 catalog / fault catalog / coverage matrix。
5. 产品语义明确后，再写对应 E2E，最后运行 `pnpm audit:conversation-session-coverage`。

## Review Queue

### P0-2 模型/API 请求故障

#### N01

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N01.1 | 401/403 后最终状态、设置引导、user message 与 queue 是否保留 | auth error、settings entry、queue snapshot | fault N01、fault coverage N01 |

#### N02

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N02.1 | provider/API Key 缺失是发送前阻止还是发送后失败，draft 是否保留 | no network request、composer draft、settings entry | fault N02、fault coverage N02 |

#### N03

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N03.1 | 429 retry 策略、retry 期间入队、最终失败后的状态与 queue | retry count、toolbar retry、queue | fault N03、fault coverage N03 |

#### N04

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N04.1 | 502/503 是否区分、retry 策略、失败后 retry/edit/fork/compact 是否可用 | status code、retry、action buttons | fault N04、fault coverage N04 |

#### N06

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N06.1 | DNS/connection/proxy/TLS 失败后的 user message、断网状态、queue 规则 | network error、message retention、queue | fault N06、fault coverage N06 |

#### N07

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N07.1 | 请求 timeout 阈值、stop 语义、超时后自动失败还是 retry | delay fixture、stop、timeout | fault N07、fault coverage N07 |

#### N08

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N08.1 | 200 malformed response 属于 protocol/provider/可忽略错误，以及是否 retry | malformed body、normalized error、log | fault N08、fault coverage N08 |

#### N09

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N09.1 | title/sidecar 失败的 fallback 文案、用户是否可见、是否影响主 turn | title fallback、warn、main turn completed | fault N09、fault coverage N09 |

### P0-3 SSE 流式故障

#### S01

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S01.1 | 空 SSE 断开是否 retry/error，assistant 占位、user message、queue 如何处理 | empty SSE、retry boundary、queue | fault S01、fault coverage S01 |

#### S02

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S02.1 | message_start 后断开是否生成 interrupted/error/no assistant，queue 是否自动 drain | prelude close、assistant placeholder、queue | fault S02、fault coverage S02 |

#### S03

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S03.1 | text delta 后断流的 partial 保留、final state、fork/edit/compact 是否可用 | partial text、failed/interrupted、buttons | fault S03、fault coverage S03 |

#### S04

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S04.1 | malformed SSE event 是终止、忽略还是恢复，以及日志分类 | bad event、protocol log、event ordering | fault S04、fault coverage S04 |

#### S05

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S05.1 | SSE provider error event 是否展示原文、是否 retry、是否生成 error assistant | provider error frame、retry、assistant error | fault S05、fault coverage S05 |

#### S06

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S06.1 | stream stall UI、超时阈值、用户 stop 和自动 retry/失败策略 | stalled event、toolbar state、timeout | fault S06、fault coverage S06 |

#### S07

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| S07.1 | stop 后 late SSE event 是否忽略、是否 warn、如何证明 inputId 隔离 | late event、activeInputId、new turn isolation | fault S07、fault coverage S07 |

### P1-1 文件系统/存储故障

#### D01

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| D01.1 | session history 写入 ENOSPC 后 UI 告警、内存态、queue、relaunch 语义 | sqliteRun fault、DB、queue、relaunch | fault D01、fault coverage D01 |

#### D02

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| D02.1 | tool 写 workspace 文件失败后的 tool block、assistant 后续、当前轮状态、重试入口 | workspace 父目录创建 / 非原子写 fault、tool block、file content | fault D02、fault coverage D02 |

#### D03

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| D03.1 | provider/settings 保存失败后的表单错误、输入保留、配置回滚、发送阻断 | settings/provider fault、form state、config file | fault D03、fault coverage D03 |

#### D04

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| D04.1 | 坏 DB/snapshot 启动恢复时是跳过、隔离备份、阻止进入还是显示恢复错误 | corrupt DB、workspace init、restore UI | fault D04、fault coverage D04 |

#### D05

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| D05.1 | 日志/artifact 写入失败是否用户可见，主流程是否继续，截断回退是否接受 | log fault、artifact fallback、warn | fault D05、fault coverage D05 |

### P1-2 App 生命周期/进程故障

#### L01

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L01.1 | 切到其他 app/最小化后 agent/SSE 是否继续，回前台如何追流和提示 unread | background、foreground、stream、draft | fault L01、fault coverage L01 |

#### L02

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L02.1 | close/hide 窗口时 host/agent 是否继续，重开窗口如何恢复，平台差异如何处理 | window close、host lifecycle、task restore | fault L02、fault coverage L02 |

#### L03

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L03.1 | quit/relaunch 后 running turn 是 interrupted/failed/notReady/replay resume，queue 如何恢复 | app quit、snapshot、queue、timeline | fault L03、fault coverage L03 |

#### L04

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L04.1 | renderer reload/crash 后 continuous 链路、queue、activeInputId 如何恢复 | renderer reload、store rehydrate、snapshot | fault L04、fault coverage L04 |

#### L05

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L05.1 | host process crash 后是否自动重建，UI 状态和 pending permission/queue 如何处理 | kill host、owner lost、workspace notReady | fault L05、fault coverage L05 |

#### L06

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L06.1 | agent process crash/exit 后错误码、自动重启、当前轮和 queue 是否保留 | kill agent、PROCESS_EXIT、queue | fault L06、fault coverage L06 |

#### L07

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L07.1 | sleep/wake 后继续等待、自动失败、自动 reconnect 还是提示手动恢复，超时阈值 | sleep/stall simulation、transport close | fault L07、fault coverage L07 |

#### L08

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| L08.1 | compacting 时 app 退出后 marker、pendingAction、queue 如何恢复 | compact quit、marker、pendingAction | fault L08、fault coverage L08 |

### P2-1 Workspace / Tool 外部变化

#### W01

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| W01.1 | workspace 缺失后输入、历史、file tree、tool 调用是只读/锁定/允许失败 | workspace missing、composer、file tree | fault W01、fault coverage W01 |

#### W02

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| W02.1 | tool 读写中目标文件外部变化后的 tool error、assistant 是否知道失败、是否一键重读/重试 | stale write、not_found、assistant | fault W02、fault coverage W02 |

#### W03

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| W03.1 | git repo 缺失或 dirty state 改变后 UI 是否自动探测，agent 下一轮是否刷新 git context | git capability、action menu、env context | fault W03、fault coverage W03 |

#### W04

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| W04.1 | remote disconnect 后 desktop continuous 和 mobile replayable 分别如何展示、重连、保留 pending | remote disconnect、clientMode、workspaceIdentity | fault W04、fault coverage W04 |

#### W05

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| W05.1 | pending permission 切换/关闭/断线时保留、过期、自动 reject 还是绑定 active session | permission queue、task store、response routing | fault W05、fault coverage W05 |

### P2-2 跨 Session 故障隔离

#### X01

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| X01.1 | A 后台主请求失败时 B 是否完全无感，是否全局 toast，A item 如何标记 | inactive failure、active DOM、task list badge | fault X01、fault coverage X01 |

#### X02

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| X02.1 | A 后台 compact 失败时 B toolbar/sidebar 是否隔离，A marker 和全局提示如何展示 | inactive compact failure、switch back | fault X02、fault coverage X02 |

#### X03

- worksheet: `recoveryIsolation`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| X03.1 | 从 B 切回 A error 时 error、queue、buttons、restore failed 区分如何恢复 | switch back、error detail、buttons | fault X03、fault coverage X03 |
