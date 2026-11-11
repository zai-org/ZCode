# Session control

实现规格：[会话工具设计第 7 节](../../../docs/architecture/zcode-app-control-design.md#7-解耦架构与独立测试设计)。

公开入口为 `@zcode/session-control/contracts`、`/cli`、`/app` 和仅测试的 `/testing`。工厂分别返回 CLI 8 个、App 12 个方法。调用形态始终为 `(trustedContext, input)`；模型输入不能提供身份、权限或 trace。CLI/App 用例不相互导入。

- 调用方两类（[扩展进程设计 §17.2](../../../docs/plugins/extension-host.md#172-调用方会话类与客户端类)）：App 可信上下文用判别字段 `caller` 区分 `session`（模型的会话控制工具，带 `rootSession`；字段缺省即会话类，既有构造方与 CLI 不写它）与 `client`（Host 为可信的非会话客户端构造，没有 `rootSession`）。`TrustedContext` 只在 App 范围包含客户端类，CLI 上下文与 CLI 端口的类型不变。`boundary.ts` 按判别字段决定 facade（客户端类恒为 App）；self_wait 只对会话类检查；重复 operation、授权、输出复验对两类相同。

- 指向已有会话：**工具面只暴露 `sessionId`**（规格 0.11），完整引用退回端口与用例层。端口的 `session` / `sessionId` 二选一，两者都给或都缺为 `invalid_input`；wait 的每个 operation 例外——回执的 operation 同时带完整 `session` 与裸 `sessionId`，要能原样回放，所以规则是「至少给一个，两个都给必须指向同一会话」（规格 0.14）。用例先调 `sessions.resolveSession(ctx, id)` 解析为完整引用，再走原有授权与 owner 调用；解析不到为 `forbidden`，与完整引用不在授权范围内一致；解析结果的 sessionId 必须与输入相同。端口收到的输入只含完整引用。
- CLI 可信上下文的 `readAnyLocalSession` 只放宽 listSessions/readSession：可读本机 CLI 会话库任意会话，列表不收窄到调用者 workspace。create/fork/send/interrupt/rename 仍只看 `allowedScopes`。读取结果仍须返回同一 kind 的同一会话。工具面已无 `workspace` 过滤器（规格 0.14：发现链循环），没有该授权时列表恒收窄到绑定 workspace 并复验返回行。
- CLI 引用包含 `kind: cli`、workspacePath、可选 workspaceIdentity 和 sessionId。App 引用额外包含可选 sourceServerId、project；项目引用使用 projectId，不以 cwd 替代项目；CLI 的 `CreateSession` 也不再收 `cwd`（唯一合法值是绑定 workspace，实现侧按 realpath 复验）。workspaceKey 为 `workspaceIdentity.trim() || workspacePath`。source、kind 和 sessionId 一起组成目标身份。路径、identity 与项目归属仍须由生产 access/owner 验证。
- App 授权范围通过 `scope: host | project | workspace` 区分。模型提供的 project 只用于预筛，不能证明真实归属。access 返回 `{scope, fence}`，写端口保留可信 caller、scope、fence 和稳定 requestId。`requestId` 仍是端口必填的幂等键，但**不再由模型提供**（规格 0.14）：工具层注入 `retryOf ?? toolCallId`，回执把它返回给模型用于对账。App 的项目授权由 Host 在 dispatch 边界作出，CLI 的执行 guard、队列与去重在原 owner 准入点处理；两者不构成跨库分布式事务。独立 CLI 由托管 manager 校验根来源和代际。核心不保存 ledger 或队列，不重试 mutation。
- App listProjects/listSessions 仅使用 Host 可信注入的 `discoveryScopes?: readonly AppScope[]`；字段缺省时回退 `allowedScopes`，显式空数组不回退。列表 access 与 owner 均保留原 ctx，grants 为数组；正文、执行、组织与导航仍只用原 `allowedScopes`，列表不会扩大操作授权。
- App listSessions 只有 project 一个过滤器，省略时不注入 caller 项目，按发现范围跨项目搜索标题子串，不搜索正文。显式 project 只收窄发现范围；`workspace` 与 `listProjects.host` 已从工具面删除（规格 0.14），发现范围恒为可信上下文授予的全部来源。Host 验证真实归属；核心复验 source/project 内部一致、显式过滤与返回范围。
- `ListProjectsResult` 与 App 专用 `AppListSessionsResult` 必带 `searchScope: { scopes: AppScope[], unavailableSources: { sourceServerId: string, reason: string }[] }`。scopes 仅记录实际成功搜索的授权子范围，所有返回行必须落在该范围；unavailableSources 非空表示部分来源不可用，空结果只能说明已搜索范围无匹配。核心拒绝越权搜索范围和列表行。`unavailableSources` 是可信目录端口的诊断，只有严格字段校验，不用它推导授权；无 projectId 的 legacy 来源可以没有 discovery grant 而仍报告不可用。Host owner 对断连或入口移除后的迟到结果负责，核心不推断连接状态。CLI 的 `ListSessionsResult` 与默认 workspace 行为不变。
- create 独立报告 creation、firstInput、delivery。send 返回 session、operation、admission、delivery。operation 为 `{session, sessionId, commandId}`——`sessionId` 让模型能把整个 operation 原样放回 WaitSessions（规格 0.14）。create/send/fork 与 mutation 结果都必须回 `requestId`，它是重试时 `retryOf` 的唯一合法来源。核心校验输入与输出；返回的会话引用须复验原始可信 ctx 授权和 project/source 内部一致性，不能只检查 workspace grant。未知字段、交叉引用、越权输出和互相矛盾的回执不能通过。
- wait 先授权全部目标，再打开一致快照与有序更新。adapter 必须交付同 epoch、严格递增 revision；重复事件须先去重，换代、断连或缺口须 invalidated。accepted、queued、running、idle 不算完成。completed、interrupted、failed、needs_attention 满足对应 operation 的等待条件。单个目标满足条件后关闭其 feed 并保留结果，all 继续观察其余目标；已确认终态不能因流正常结束退回 unknown。OperationSnapshot、OperationUpdate、OperationFeed、WaitSessionsResult 保留引用泛型，CLI/App 返回值可直接回传同 facade。
- wait 默认 30 秒，上限 300 秒。timeoutMs=0 只读取 initial，收齐全部快照后再判断 any/all，不等待后续变化；授权和快照获取仍有 30 秒获取上限。未满足条件返回 timed_out，失效返回 unknown，取消返回 cancelled，并携带已知 operation 状态。self-wait 和重复 operation 在访问端口前拒绝。
- deadline、取消、open 失败或满足条件都会关闭已建立的 feed。迟到的 open 也关闭。feed.close 必须幂等且及时释放，并终止待取更新。取消只影响观察，不停止目标；已进入 owner 的 mutation 结果由原 receipt 对账。
- read/send/create/fork 不导航；archive 不停止执行。navigation 缺席只使 open 返回 unavailable。模型、Provider、组织归属和真实 UI 执行仍由生产 owner 管理。

`test` 使用包内 Node 配置与空 setupFiles，`typecheck` 独立执行。测试使用手动 deadline、deferred 和可控 feed，无真实进程、文件、网络或定时器。核心单测不证明跨进程 owner、RPC 原子授权或桌面/手机导航；这些由生产适配器集成与 E2E 验证。
