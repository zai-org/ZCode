# App 会话控制生产端口

App 工具通过专用 appControl 反向 RPC 调用纯核心。Host 从活跃 CLI 连接和已有产品会话重建可信作用域：正文与控制的 `allowedScopes` 绑定所属 Host，项目仅作组织和筛选条件，不阻止跨项目读取、打开或原有会话操作。列表使用独立 `discoveryScopes`，默认发现当前 Host 及窗口已连接来源中已添加项目的元信息，不从 caller 归属推导搜索条件。远端 source、workspaceIdentity 与真实 cwd 必须匹配，不回落到本机路径。

`discovery-directory.ts` 是现有项目目录的只读适配入口。每次 RPC 捕获来源句柄、成员代际、入口 ID 和 projectId，不保存跨调用目录。远端只取已经在线且支持项目快照的连接，不调用身份迁移、连接或 Agent 启动。来源读取完成后，批次 `prepareValidation` 读取一次自洽目录快照并返回同步校验函数。两类列表在最后一次 await 后验证该目录快照、同步验证全部连接代际并构造结果，中间不再 await。快照中已移除的入口或最终已失效的连接结果不纳入；快照后的目录变化下次生效，不承诺跨来源原子性。取消或 caller 换代终止整次调用。无稳定 projectId 的旧入口显式 unsupported。

两个列表返回 `searchScope: { scopes, unavailableSources }`：前者是实际成功查询范围，后者只含稳定来源 ID 与安全原因码。来源失败不能静默当作无会话；默认查询涵盖当前可发现范围，显式 project/workspace 仅收窄，workspace 仍只列未归类行。标题 query 为大小写归一的子串匹配，不查正文。跨操作范围的会话 `availableActions=[]`；发现结果不会扩大正文、执行、组织或导航权限。

Project/Task/Controller 是项目与组织态 owner；CLI 是标题、正文和执行 owner。执行只调用已有 V4 命令准入，不直接写 CLI 数据库，不新增输入队列。新建明确使用普通 build 权限，不继承调用会话 bypass。create 的首条输入必须带完整、经 Provider View 验证的模型配置；Provider 最终门禁继续属于 Agent service。

读取元信息不启动运行时、不导航、不标已读；summary 只用 existing-only session/read 与 session/events 读取活跃轮及其真实 foregroundExecutionId，无证据时不暴露 interrupt 动作。正文调用 session/messages 只读接口。wait 只根据同 sourceCommandId 的 turnHeader、queue 与 activeWorks 事实判断，使用独立连接订阅，不替换桌面 continuous 或手机 replayable 订阅。订阅先挂 listener 缓冲，再消费 ACK 指定代际的首帧和连续增量；断连、epoch 变化、缺口或取消释放订阅，不停止任务。

观察缓冲按 8 MiB 和 64 个待消费状态限额保护；超过观察能力（包括很大的合法历史快照）显式 invalidated，核心返回 unknown，不报告完成。fork 通过 rowsRange 分页定位稳定 entityId，以返回水位提交 CAS；owner epoch 变化拒绝。fork 的项目继承在首条 CLI 事实的 Host INSERT 事务完成，迟到 ACK 不覆盖已存在组织态。

Host dispatch 授权点为最后一次读取同一项目树快照、核对 caller 与 target 并发出命令。connection fence 只验证连接代际，不是假造的项目版本。该调用派发后发生的项目移动不撤销已派发命令；下次调用重新读取归属。CLI 仍原子校验执行 revision、epoch、foregroundExecutionId 与队列准入；不声称 CLI 原子验证 Host 项目版本。

远端创建在预留前调用所属 Source Server 的 canonical workspace resolver；重试使用同一预留 cwd/附加目录/identity。无 resolver 或身份不一致明确拒绝，不回落到本机路径。

导航是可注入窄端口，只有实际导航 owner 可以返回 opened。端口缺席时明确 unavailable。调用取消只释放当前请求资源；已经可能接纳的 mutation 不自动重试。

调用方分两类（`docs/plugins/extension-host.md` §17.2）。`bind` 为模型工具构造会话类上下文（`caller: "session"`，带根会话）；`requireTarget` 只对会话类复验根会话仍是本 Host 的真实任务，客户端类只核对连接代际与 fence。客户端类的 create/send 需要它自己的来源标识（§17.8），在支持之前报 `unavailable`，不退化成不标来源。

`bindClient`（§17.2）为 Host 进程内的可信非会话客户端构造客户端类上下文：callerId 是 `<sourceServerId>:client:<clientId>`（clientId 跨连接代际不变，是幂等键的一部分），fence 是 `connectionId`，范围与会话类相同（写只到本 Host，发现仍经 `bindAppDiscoverySources`）。每次端口调用都经 binding 的 `assertCurrent`（代际、释放与授权由构造方判断）。发现端口与导航端口只依赖两类共有的连接事实 `AppControlCallerConnection`。`AppControlService` 由 `createLocalServices` 的 `onAppControlServiceCreated` 回调交给进程内的扩展网关，不注册进 ServiceCollection，不出现在 RPC 上。
