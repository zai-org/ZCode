# 独立 CLI 会话 runtime adapter

依据 [会话工具设计](../../../../../../docs/architecture/zcode-app-control-design.md) 的 CLI 端口及发起 runtime 托管策略。公开工厂 `createCliSessionControlRuntime({ workspace, sessionStore, createRootApp, limits? })` 返回 `control`、`attachRoot(app, provenance)`、`close()`；业务 DTO、8 操作和 wait 规则均复用 `@zcode/session-control`。

本 adapter 是本进程托管 roots 的生命周期 owner。可信独立 CLI 启动装配先创建 manager，再把 control 绑定到当前根，最后 attachRoot。来源标记由可信启动注入：`new-independent-root` 的当前主根可读写，`unverified-history` 只证明调用身份，不可写。独立 CLI 装配给根会话的可信上下文带 `readAnyLocalSession`：list/read 读本机 CLI 会话库（列表默认只列根会话，按最近更新排序，有界扫描），按 ID 可读任意会话；非托管会话 status 为 unknown、只宣称 readSession，读取不恢复 runtime、不认领 owner。正文只返回 active 分支，并按产品对话界面同一判据（`active-transcript`）过滤隐藏提醒。启动方必须核对该 sessionId 原本不存在；不能只依赖 resume=false。没有持久来源字段时，不把可能由 App 创建的历史认领为 CLI 目标。新根由注入的 App 工厂创建，manager 负责释放；borrowed root 由宿主释放。工厂参数只包含新 session ID、cwd、model、trace 和 resume（仅本 manager 新建的 fork），不包含 actor 权限、批准或 subagent 关系。可信启动方在工厂内把自己的 `permissionBroker` 传给新根：独立 TUI 的询问进入同一个审批队列并标明来源，headless 仍拒绝；这只共用询问通道，不共用批准结果。

```text
可信启动 → manager owned roots → 首发 app.sendInput（初始化 + 原子 admission）
                              → 后续 runtime.executeTurn（原 Core command FIFO）
                              → runtime 事件/completion → 按 inputId 观察 operation
close → 封闭入口 → beginShutdown/abort → 等待 completion → 取消后台 → app.close
```

- workspaceKey 使用 `workspaceIdentity.trim() || workspacePath`；真实 cwd 另外精确校验，create 还经异步 realpath 校验。caller 必须来自本 manager 登记根，allowedScopes、scope、fence 在最终准入入口重新校验。外部 owner、未知历史、App 来源不明目标均 unavailable；不把不可达理解为无 owner，不自动 restore。
- 当前仅支持本 manager 创建的根及可信启动登记的新建独立主根。list/read 返回其 availableActions；发生初始化或持久化部分失败的根只有 read，不能继续执行。其他终端和进程重启后的请求不在控制范围，不承诺跨进程幂等或恢复。
- manager 按 caller/root/requestId 保留本生命周期回执，重复 payload 返回同一 Promise，冲突拒绝。默认上限为 4096 个写请求、128 个根（包含借用根），可由可信装配收紧；达到上限拒绝新请求，不淘汰旧回执后重放。operation 数量受同一请求上限约束。没有第二份 accepted 输入队列。
- 真实事件证据显示 `sendInput(queueDelivery=queue)` 进入仅由 V4 bridge 消费的 deferred queue；独立 CLI 不使用该路径。首发通过 App 完成配置、shell、模型和权限初始化，后续同步调用 public `runtime.executeTurn` 进入已有 Core command FIFO；其 busy 读取与 enqueue 之间没有 await。fork 先显式 resume，再开放发送。输入 ID 始终对应原 operation。
- create 的根创建与首发接纳分别报告。根已创建后失败返回 created + firstInput unknown + 稳定引用；工厂结果不明返回 unknown + 已保留引用。fork 已提交但 runtime 工厂失败仍返回 created + 引用及原因。相同请求不会再次创建，也不偷偷恢复该历史。未成功初始化的 App 仍归 manager 的关闭链负责。
- operation 仅由匹配 inputId/turn 的事实推进。队列输入不被前轮终态完成；ModelError 不算终态，Core turn catch 的 TurnError 与 completion rejection 才算失败。wait 取消只释放订阅，不停止目标。权限/问题为 needs_attention，不代用户批准。
- 观察器按 inputId/active turn 索引，不在高频 delta 上遍历历史。open 精确匹配 session 和 commandId，同步建立水位；revision 递增。每个 operation 至多 100 个观察者，每个 feed 至多 64 条待取更新，溢出显式 invalidated 并退订。close 幂等并结束待取 next。
- fork 复用既有 stable resolver 和 runtime 原子 bundle，不回退 workspace 文件、不复制 queue。由于现有 bundle 会复制 session.permission，当前只允许通过原 runtime idle-only lease 锁住的空闲来源，无运行后台任务、无持久 permission 规则且历史边界为 build。含 session allow/deny/ask、其他未知权限字段或历史 yolo 的来源明确 rejected；完整支持需要原 owner 增加不复制权限的原子参数，不能由 bootstrap 改库清除。模型沿 fork 点保留；新根及 fork 的权限模式显式 build，不继承 actor yolo 或批准。
- 关闭先封闭准入，显式 abort 活跃和原 command FIFO 的待执行输入，等待完成/取消持久化，再取消后台运行并释放 App。晚到工厂结果也归本次 close 收口。单个取消/清理失败不跳过其他 App 资源释放，失败最终汇总报告。宿主必须在 shared store/provider 之前 await manager.close。后台根不脱离发起进程继续运行。

验证使用真实 bootstrap App、Core runtime、SQLite 与受控模型 executor，覆盖 create/send/wait、busy FIFO、并发输入顺序、fork/rename/精确 interrupt、取消观察、权限隔离、部分失败、容量及关闭交错。失败时夹具输出真实 turn 事件。此证据不覆盖跨终端 owner 路由，当前无该能力。
