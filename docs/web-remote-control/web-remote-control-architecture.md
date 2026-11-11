# Web 远程控制概览与外部 Relay 架构

本文描述当前有效实现。旧的仓库内 relay、窗口 control socket、bridge token、HTTP bootstrap API 已移除，不再作为兼容路径。

## 产品概览

手机 Web 远控让用户在浏览器中访问目标桌面窗口已经打开的工作区和任务。桌面应用承载
实际服务与 Agent runtime，手机通过外部 relay 接入同一 Host 的 workspace scope；手机页面
不启动独立 Host 或 Agent，relay 只负责鉴权、配对、心跳和消息透传。

### 使用流程与页面

1. 在桌面打开 Web 远控对话框，启动远控并取得二维码或连接链接；手机浏览器打开链接后完成配对。
2. 窄屏首次扫码默认进入任务首页：首页与桌面共用项目侧栏，可按项目或跨项目时间线浏览任务；
   Relay V2 连接时侧栏最顶部（“新建任务”之上）显示当前电脑行，整行点击即“切换设备”。二维码携带的初始任务用于选中和定位，不直接跳进聊天页。
3. 点击任务进入聊天；项目或全局的新建任务入口进入对应草稿页。跨工作区操作先切换 bridge，
   再访问目标工作区服务。返回首页保留任务选中态；聊天页刷新可以根据浏览器 history state 恢复聊天页。
4. 手机选中的工作区和任务独立于桌面选中态，不会使桌面切换 tab/task。
5. 网络恢复或页面回到前台时恢复连接，并按 replayable 协议重新同步任务状态；
   断开的远程工作区可从首页触发桌面已有重连流程，连接成功前不能打开或新建其中的任务。

窄屏使用独立的首页/聊天两页 shell，聊天内容复用现有 V4 会话组件。宽屏远控使用侧栏布局，
任务列表同样来自桌面同步的跨工作区索引。手机主题使用浏览器本地偏好，与桌面主题独立；
无本地偏好时默认使用 `zai-dark`。

### 能力与边界

- 可浏览目标窗口已有的工作区与任务、打开会话、发送输入、新建任务，并处理会话中的权限和交互请求。
- 远程工作区复用桌面已有连接与服务 scope；首页重连恢复已有工作区，不提供手机新建
  SSH/WSL/Docker 连接或管理其他桌面窗口工作区的入口。
- 同一 task 仍由既有 runtime owner 执行。桌面使用 `desktop-continuous`，手机使用
  `web-remote-replayable`；手机恢复不会改变桌面的 continuous 主链路。
- 手机服务和工具能力受 attachment/capability 约束，不因复用桌面 UI 而自动获得全部桌面能力。
  终端暴露边界见下文“启动调用边界与 Office XSS 关系”。

```text
手机浏览器（独立选中态、replayable）
  -> 外部 relay（透传）
  -> Desktop main（attachment 调度与 RPC 桥接）
  -> 目标窗口共享 Host 的 workspace scope -> 同一 task runtime owner
                          ^
桌面 renderer（continuous）─┘
```

### 专题导航

| 内容                               | 文档                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| 手机首页、聊天、新建任务与页面状态 | [手机任务首页](./mobile-task-home-design.md)                         |
| 手机任务时间线与排序               | [移动端任务时间线](../ui/web-remote-control-mobile-task-timeline.md) |
| 宽屏任务列表、搜索与归档           | [宽屏任务列表](./wide-screen-task-list.md)                           |
| 手机主题与浏览器表面               | [主题控制](./mobile-theme-control.md)                                |
| 远程工作区断开与重连               | [工作区重连](./mobile-remote-workspace-reconnect.md)                 |
| 实时同步、snapshot 与 gap 恢复     | [任务实时同步](./task-realtime-sync.md)                              |
| 输入 admission、队列与跨端命令路由 | [任务命令队列](../web-remote-control-task-command-queue.md)          |
| V4 静态资源发布                    | [V4 部署](./remote-v4-static-deployment.md)                          |
| 独立 OAuth 登录入口                | [Web Remote Login](./web-remote-login.md)                            |

下文描述当前技术实现；[最小跑通规划](./web-remote-control-minimal-plan.md)仅作为历史记录，
其中的仓库内 relay、专用 mobile host 和旧联调命令不适用于当前链路。

## 入口

Desktop 和 mobile web 使用当前 endpoint origin 的 Relay V2 入口；HTTPS 对应 WSS，HTTP 对应 WS：

```bash
production/default: wss://zcode.z.ai/api/v1/remote/ws2
test endpoint:       wss://zcode.z.ai/api/v1/remote/ws2
local/custom:        ws://localhost:3030/api/v1/remote/ws2
```

`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 仍是桌面 relay 的最高优先级显式调试覆盖，必须指向 V2
入口。没有覆盖时，localhost/custom endpoint 同样从各自 origin 推导 relay。当前桌面版本生成
`/remote/v4` 二维码；`ZCODE_WEB_REMOTE_CONTROL_URL` 用于显式调试覆盖。

开发时可以把手机页指向本地 web：

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=http://localhost:5173/remote/v4 \
pnpm dev:web-remote-control
```

## 静态部署

手机 V2 页面只通过 OSS 多版本流水线发布，无需入口变量。在主流水线手动运行 `upload:remote:test`、`upload:remote:prod`，或各自的 `:latest` job；环境、版本选源与生产限制见 [OSS 多版本部署](./remote-v4-static-deployment.md#gitlab-ci-测试与生产-oss-多版本产物)。

```text
选定 commit/tag → 按 app 版本构建 /remote/v4/<version>/ 资源
              → prepare 校验环境与清单 → OSS 版本目录
              → 网关按 app_version 选择 index、按目录选择静态资源
```

页面路由固定为 `/remote/v4`。旧 `/remote`、`/remote/v3`、`/remote/v4` Docker 单版本部署冻结在最后一次 V1 镜像；仓库已删除相应构建、推送、验证入口，不得覆盖旧部署。`/remote/__test__` 的独立测试链继续保留，使用方式见[静态部署文档](./remote-v4-static-deployment.md)。

OSS 的版本选择、环境隔离、latest 规则、网关路由及验收见[多版本部署](./remote-v4-static-deployment.md)。发布前必须完成 [Relay V2 外部依赖与真机验收](./relay-v2-pairing.md#外部依赖与发布顺序07)。

## Transport

桌面 device 使用 [Relay V2 配对与状态机](./relay-v2-pairing.md#桌面-device-生命周期03)：main 用当前账号 JWT 懒注册设备，每次建连前申请一次性 role=device token，再连接当前 endpoint 的 `/api/v1/remote/ws2?token&mid`。不发送 X-Device-ID；`auth_init` 只携带 SID、meta 和秒级 client_ts。

V2 心跳为每轮重新抽样的4~6秒 pair_status_query（不带 SID），独立15秒 ACK watchdog 判定失联。网络/5xx 指数退避，连接建立后的第一次重连先随机等待0~1.5秒（须小于桌面3秒手机断连宽限），401 停止并报 auth-required，KICKED 在60秒内仅允许一次2~5秒延迟恢复。二维码为 `/remote/v4?app_version=<ver>&sid=<sid>&mid=<mid>&name=<hostname>`，不含 hash/t 或 JWT/token。手机 terminal 同样使用 V2 token/auth_init，共享层只导出 V2 relay 契约。

Relay 只负责认证、配对、心跳和 data.payload 透传，不解析 task、session、workspace 或 rpc-frame 内部业务。main 按 workspaceKey 把手机 bridge attachment 挂到已有 Window Host，桌面 continuous 与手机 replayable 的 owner 和恢复边界保持不变。

## App Payload

`data.payload` 使用 `zcode_type` 区分业务消息：

- `bootstrap-request` / `bootstrap-response`
- `workspace-list-request` / `workspace-list-response` / `workspace-list-updated`
- `workspace-bridge-open` / `workspace-bridge-ready` / `workspace-bridge-error`
- `platform-request` / `platform-response`
- `mobile-view-state-update`
- `rpc-frame` / `rpc-frame-ack`（transport-only；relay 不解析）
- `app-error`

04D-3 已让 desktop main/mobile web 同时使用 shared acknowledged adapter；全局 app parser 正式接受
新 strict fragment/ACK，并删除 legacy 单片 branch。raw Channel message 不能直接做一次 base64 后塞入
单个 `rpc-frame`，而要切成带 `messageSeq/fragmentIndex/fragmentCount/messageBytes/CRC32` 的物理片；每片连最终
`{type:"data",payload,client_ts,server_ts}` 未压缩 JSON 必须不超过 1 MiB。单 logical raw
message 上限 16 MiB / 64 片，接收侧只 staging 一个 message 并在完整校验后原子交付一次。
`rpc-frame-ack` 是 raw transport 的 cumulative ACK，不是 command ACK，也不携带 conversation
业务事实。

production adapter 的 transport 状态是对称且 bridge-scoped 的：TX 在首片发送前保留整批 immutable
fragment，并按最终 outer JSON bytes 维护 `1 MiB / 256 KiB` flow edge、`32 MiB / 45s` replay
边界；RX 在完整 assembly 和同步 Channel delivery 成功后才排队 cumulative ACK。ACK 优先 flush。
同一 bridge 每次重新 send-ready 时都重放未 ACK batch，包括本地 WebSocket 未换代、但心跳重新确认
`matched` 的 `same-socket` 场景；对端 peer 可能已经换代，不能把本地 socket identity 当成交付证明。
重放复用原 immutable batch 且不刷新其 queued age；new bridge、terminal fault 或 dispose 清空旧
transport 状态。首个 queued ACK 也受 45s deadline 约束，后续更高 cumulative ACK 只替换值而不刷新 age。
这些状态不包含 task/session/topic/command 事实。desktop/web transport 为 payload 创建唯一 immutable
final outer JSON，adapter 的 meter 与实际 send 共用同一 serializer/cache；同 bridge replay 复用相同
bytes。raw frame/ACK 不进入 desktop main 的普通 50 项 app payload buffer。两端在 `JSON.parse` 前按
未压缩 UTF-8 `<=1 MiB` 硬闸，compression 开关不影响 admission；永久 oversize 与临时 unavailable
分流，raw fault 只触发一次 hard bridge recovery。跨端只传通用
`bridge-degraded: rpc-transport-fault`，具体 typed reasonCode 留在 owning 端安全日志。

### 合法大消息的重放容量（2026-10-27）

重放缓存默认值与可配置硬上限统一由 `2 * maxMessageBytes` 推导，当前为 32 MiB。
原来的 8 MiB 按编码后的整批外壳计量，6 MiB 原始消息经 Base64 和 JSON 编码就会超限；
这与单条 raw RPC 允许 16 MiB 的合同冲突。16 MiB 消息的编码批次约 21.35 MiB，
32 MiB 能容纳该批次及原有 8 MiB 在途余量。调用方仍可显式设置更低的缓存预算。
该值是每个 bridge、每方向的未确认外壳字节上限，不等于进程实际堆内存上限。

```text
原来：合法大 RPC → 整批编码超过 8 MiB → bridge 失效 → Web 重挂并重复读取
现在：合法大 RPC → 在 32 MiB 预算内整批保留 → 分片发送 → 原子交付 → ACK 释放
```

容量 owner 仍是 shared acknowledged adapter；Desktop main 只转发，Web 继续使用 replayable。
单消息 16 MiB、物理帧 1 MiB、流控高低水位、45s deadline、重放去重和现有恢复策略不变。
超过单消息上限或持续积压超过缓存预算仍按既有 terminal fault 处理；本次不宣称解决这些
输入的业务加载与跨 bridge 恢复循环，也不引入新的分页、分片 ACK 或手动重试语义。

验收见 MRL01/MRL02：真实 Web 页面读取合成 8 MiB RPC 响应后只挂载一次；真实 adapter
覆盖 6/8/16 MiB、在途余量、ACK 丢失后重放、暂时不可发送、身份隔离、硬上限与 deadline。
候选入口：`pnpm exec tsx packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-large-rpc.mjs`。

`mobile-view-state-update` 除了 `activeWorkspaceKey`、`activeTaskId`、`updatedAt`，还可以携带
`deviceInfo`。该字段由手机浏览器端采集，只包含浏览器可稳定获得的受控信息：`platform/version/name`、
`userAgent`、语言、`navigator.platform`、viewport、screen、timezone、online 和采集时间。Desktop main
只把它保存在当前 window runtime，并通过 `getWebRemoteControlStatus()` 暴露给桌面端；它不参与
workspace identity、session 绑定、缓存 key 或 relay 配对判定。

Desktop 和 mobile 收到 relay `data.payload` 后必须先走 `parseWebRemoteControlAppPayload()`。无效 payload 只记录安全元数据，不记录原始 JSON。

`workspace-list-updated` 只用于 desktop renderer 已经通过 `syncWebRemoteControlTasks` /
`syncWebRemoteControlWorkspaces` 同步新快照后，把同一份 `WebRemoteControlWorkspaceListResult`
推给已连接的手机端。它不改变 relay 和 desktop main 的职责：relay 仍只透传 `data.payload`，desktop main
仍只组合并转发 renderer 已同步的 workspace/task 索引，不持有 ZCode task、stream、queue 或 snapshot 业务状态。

`bridge-degraded` 不属于普通可丢 app response。Desktop main 为当前 bridge generation 保留一个不含业务
snapshot 的 invalidation latch：Source logical session 换代或 raw transport fault 后立即释放旧手机
attachment，并在 relay 再次 paired/send-ready 时补发，直到新 `workspace-bridge-ready` 成功后清除。
这只是连接级可靠通知，不把 task/session/queue/snapshot 事实下沉到 main。Mobile 收到后用新
`bridgeSessionId + bridgeGeneration + recoveryId` 重建；首次重建失败后只允许按 1s/2s/5s 有界退避继续
尝试，同一 recovery flight 保持 `recoveryId`、每次使用新的 bridge generation。任一次成功后清空预算；
预算耗尽后必须先销毁旧 bridge protocol 与 service registration，再进入明确的
`connection-recovery-timeout` 非 active 终态，并提供由用户触发的整页重试。不能继续把已 degraded 的旧
bridge 显示为 active，也不能由 relay/main 保存业务状态来掩盖恢复失败。

### Bridge 服务与在途 RPC 终结（2026-10-27）

Web 使用远端 workspace attachment 时，反馈仍由控制端 Window Host 的 `feedback` 服务处理，
复用其设备身份、账号和诊断日志；不能转交 Source 或因为远端集合没有该频道而等待注册超时。
本地 workspace 和桌面 continuous 的服务归属保持不变。

Web 已有会话发送前读取的 Gen UI 状态同样归控制端 Window Host。手机 attachment 只暴露
`gen-ui.listState`，保留 scope 参数；不开放 sandbox、文件读取、状态写入或其他未审阅方法。
缺少 widget 时正常返回空列表，不通过 Unknown channel 超时探测能力。

Acknowledged relay adapter 是单个 bridge 生命周期的唯一 owner。首次 terminal degraded 或
dispose 必须同步撤销该 bridge 的 RPC client，包括尚在等待 Initialize 的请求；之后的请求
立即拒绝，迟到回包不得完成旧请求。短暂断线、挂起和同一 bridge 的 ACK replay 不终结 client。
Web 服务连接消费 adapter 的生命周期信号；不新增业务计时器、重试队列或命令自动重发。

```text
发送 → Composer claim → 发送前 RPC → 命令登记 → CLI admission
                         │
bridge 终结 → RPC client 关闭 → 请求拒绝 → 既有失败处理恢复原草稿
已登记命令 ────────────────────────────→ 既有 query/snapshot 对账
```

根因是旧 bridge 仅释放传输 emitter，未拒绝在途 RPC；发送前已隐藏并持久化为空的草稿因此
无法进入失败恢复。修复不改变 bridge 降级触发条件、重连频率、Root key 或已接纳队列语义。
对 `ZCT-2114921598023585792` 只确认上述代码边界，不据此认定历史现场的全部 5 秒耗时或刷新触发源。

验收 MRS01–MRS04：真实 Web 入口与 Host attachment 装配、受控 relay/业务服务，覆盖本地/远端
反馈归属、发送上下文读取、发送前 bridge 终结与迟到回包、桌面 continuous 对照。候选保持 pending；
实体手机、生产 relay 与真实 SSH 网络不是该浏览器边界用例的覆盖范围。

### 后台恢复与原任务导航

Relay `matched` 只证明配对通路恢复，不证明旧 workspace bridge 仍存在。后台页面可能丢弃
`bridge-degraded`；Desktop 必须在每次已有 send-ready（包括 same-socket 心跳）补发当前
invalidation latch，直到新 identity 的 bridge-open 接管。继续使用现有心跳，不新增恢复轮询。
Web 对同一 active bridge 只执行一次 degraded 转换，由 raw adapter 的 `onDegraded` 进入唯一
recovery flight；重复通知不得重置 recoveryId、bridge generation 或有界重试预算，旧 bridge
通知不得影响新 bridge。未认证、旧 socket 和普通业务帧的接收门禁保持不变；挂起期间同一有效配对
socket 的 raw 帧准入与 ACK 规则见 [Relay V2 spec](./relay-v2-pairing.md#手机首次进入与恢复05)。

硬恢复保留原 workspaceKey/taskId。项目仅由手机打开时，释放短生命周期 attachment 后，原项目
可能不在桌面 tabs 派生的 bootstrap.workspaces 中；这不代表任务失效。有明确 taskId 的缺席目标
必须沿已有 `taskHostId + taskId + workspaceKey` 的 Host 任务导航重新核验目录与当前远程 session，
不能静默选择 default。窗口主进程不新增项目目录缓存，也不把 mobileViewState 当作可信目录。
任务不存在、身份不符或 Host 离线时沿既有失败/重试边界处理；成功建立新 bridge 后才更新导航位置。
已明确断开的远程候选继续保持断线语义。无 taskId 的草稿不进入任务导航，也不冒充持久化任务。

上述保留目标语义仅适用于携带 `preferredWorkspaceKey` 的硬恢复。首次加载、整页刷新和错误页
重试仍使用初始 workspace 选择规则：旧导航目标缺席或不可 bridge 时，选择第一个可 bridge 的
workspace；仅在没有可 bridge 候选时进入 home-only。冷启动不能只凭过期的
`mobileViewState` / `initialViewState` 对缺席目标发起 Host 任务导航。

```text
Desktop invalidation latch → 每次 send-ready 补发 → Web 首次 degraded → 单一恢复 flight
                                重复通知 ─────────→ 不重复恢复
原 workspace/task → bootstrap 中缺席 → Host 按任务身份核验 → 新 bridge → 原任务 snapshot
                                             核验失败 → 明确失败，不跳 default
冷启动 / 整页刷新 → 初始选择器 → 旧目标缺席或离线 → 第一个可 bridge 的 workspace
```

回归要求：首条失效通知丢失后，same-socket 恢复不再额外等待 raw 45 秒期限；重复失效通知不延长
重试预算；仅手机打开的本地/远端任务保持身份，核验失败不跨 workspace/Host；宽窄屏受控丢帧与真实后台恢复
后显示已完成内容并保留原任务，桌面 continuous 连接继续正常完成。候选 E2E 为 MRO04，保持 pending。

## Desktop Main

`packages/desktop/src/main/webRemoteControlManager.ts` 负责：

1. 通过独立 `WebRemoteControlDeviceTransport` 连接 V2 relay，握手、重连与心跳见 [桌面生命周期](./relay-v2-pairing.md#桌面-device-生命周期03)
2. main 直接用 Node fetch 调用注册/token 接口；`webRemoteControlRelayV2Device` 保存非敏感 `{deviceSid, userId, endpointOrigin}`，V1 sid/passHash 首次迁移时清除，不写新 credential
3. 根据 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 匹配 workspace
4. 为当前 mobile bridge 创建新的 `MessagePort` attachment
5. 用 shared acknowledged adapter 把 host `MessagePortProtocol` 的 RPC message 编码成有界
   `rpc-frame` fragments，并消费 cumulative ACK
6. 不解析 ZCode task 业务语义，不参与 task stream、permission 或 workspace task list 的同步逻辑

### 桌面应用重启后的启用状态恢复

桌面端把“上次是否开启 Web 远控”解释为用户的启用意图：一次远控启动成功后记录最后目标；
用户明确点击停止后清除该记录。窗口销毁和应用退出会释放本次运行的 transport / attachment，
renderer reload 可以继续复用窗口级 runtime；这些生命周期事件都不得把启用意图改写成关闭。
这样应用正常退出或意外退出后都能恢复，而用户主动关闭后不会在下次启动时重新打开。
endpoint 切换等配置变化可以暂停当前 runtime，但同样不代表用户关闭了远控功能。

持久化目标只保存 `workspacePath`、可选 `workspaceIdentity` 和可选 `initialTaskId`。
`remoteSessionId` 属于本次进程内的远程连接身份，禁止跨应用重启持久化。新进程必须等待
renderer 把当前窗口已恢复的 workspace 上下文同步到 main；启动前还必须读取有效登录 JWT。无 JWT 时保持
`auth-required`，保留启用目标，等待 renderer 登录通知后重读凭据并重试。登出立即停止
所有远控 runtime，但不清除启用目标。

最后目标只决定手机的初始定位，不是恢复门槛。应用启动只恢复上次激活的 workspace，最后目标常常
不在窗口里；远端目标也可能还没有重连。这两种情况都必须照常启动 device relay。main 按
`workspaceKey = workspaceIdentity?.trim() || workspacePath` 选择初始目标：

1. 最后目标在当前窗口快照中：使用它和 `initialTaskId`。远端未连接时不带 `remoteSessionId`。
2. 最后目标在其他窗口快照中：当前窗口让出，由那个窗口恢复，保持原窗口归属。
3. 其余情况：使用当前窗口第一个可 bridge 的 workspace；没有可 bridge 项时使用第一个 workspace。
   `initialTaskId` 属于最后目标，不得带到其他 workspace。
4. 当前窗口快照为空：保持 `idle`，等待下一次窗口同步。

自动恢复只从窗口已恢复的 workspace 中选目标，不得为自动恢复另起 local host、远程 session 或
Agent runtime。按第 3 条启动成功后，新目标照常成为最后目标。手机进入后的落点沿用上文的初始
workspace 选择规则。

远控以未连接的远端目标启动后，该目标稍后在本窗口连上时，结果必须和启动时已连接一致。窗口快照是
workspace 连接身份的唯一来源：main 在 runtime 建立时和每次窗口同步时，若 runtime 目标是远端且在
本窗口快照中，就让 runtime 的 `remoteSessionId` 跟随快照里同一 `workspaceKey` 的值；目标不在快照中
时没有新事实，保留原值。远端连上后，桌面弹窗按同一会话复用，不重启 device relay；最后目标带
`initialTaskId` 时，bootstrap 的 `initialViewState` 随之带上。远端 session 替换和失败事件仍在
快照同步之前即时更新 runtime。手机已上报的位置（`mobileViewState`）仍优先于 `initialViewState`；
远端离线期间配对的手机只上报 workspace，不带任务。

```text
上次启动成功 ──> 保存 enabled target ──┐
                                         v
新 desktop main -> 等待窗口 workspace sync -> 等待 JWT -> 选择初始目标 -> 启动 device relay
                                                            |
            最后目标在本窗口 ─────> 使用最后目标（含 initialTaskId）
            最后目标在其他窗口 ───> 本窗口让出，由那个窗口恢复
            其余 ─────────────────> 本窗口第一个可 bridge 的 workspace（不带 initialTaskId）
            窗口快照为空 ─────────> 保持 idle，等待下一次窗口同步

远端目标连接状态变化 ──> 窗口 workspace sync ──> runtime.remoteSessionId 跟随快照
                                              ──> 连上：弹窗判为同一会话；initialViewState 可带 initialTaskId

登录通知 ──> 重读 JWT + 已同步 workspace ──> 重试恢复
登出通知 ──> abort 启动 / 停止 runtime ──> auth-required（保留 enabled target）
用户明确停止 ──> 清除 enabled target ──> 下次启动保持 idle
```

回归要求：最后目标不在重启后的窗口中时，桌面自动进入 `running`，relay 上设备在线，初始目标为
窗口中的 workspace；用户停止后再重启保持 `idle`。E2E 见
[AUTH-09](../testing/desktop-auth-config-e2e-cases.md#auth-09-桌面重启后自动恢复远控pending)。
最后目标是 SSH 项目且重启时远端离线：远端连上后，远控状态的 `remoteSessionId` 等于 tab 的值；
手机断开后在该项目打开桌面弹窗，沿用原远控连接。E2E 见
[AUTH-09-R](../testing/desktop-auth-config-e2e-cases.md#auth-09-r上次远控目标是-ssh-项目重启时远端离线pending)。

自动恢复只重建 desktop device relay。手机仍通过 `web-remote-replayable` attachment 进入现有
shared host；桌面 renderer 仍保持 `desktop-continuous`，不得把 replayable snapshot / gap 恢复
语义扩散到桌面主链路。

外部 relay 不再提供 `bridgeToken` 或 `wsUrl`。`WebRemoteControlExternalWorkspaceBridge` 只描述 workspace 身份和 `bridgeSessionId`。

手机远控页面不拥有独立 host process，也不会启动独立 Agent runtime。desktop main 在收到
`workspace-bridge-open` 后，为手机 bridge 创建一个新的 `MessagePort` attachment，
并把该 attachment 挂到目标桌面窗口唯一 Window Host 的 local/remote workspace scope。
relay 只透传 `rpc-frame`，不解析 ZCode task、stream 或 workspace 业务语义。

Desktop renderer 和 mobile Web remote control 通过不同 RPC client 连接同一个 host/service/runtime。每个 attachment 由 host 分配独立 `connectionId` 和可信 `clientMode`：本地及 SSH/WSL/Docker 桌面窗口都是 `desktop-continuous`，手机 `/remote` 是 `web-remote-replayable`。host 为每个 attachment 建立 owned-subscription registry；下行帧只能写给拥有该 `subscriptionId` 的 MessagePort，禁止 workspace 广播后让手机丢弃桌面帧。

手机 raw adapter 的 high/low 边沿只通过 owning attachment 的 MessagePort sideband 上行；control object
在 Channel parser 前消费，不会成为 RPC request/event：

```text
mobile adapter high/low
  -> desktop main（无 topic/session state）
  -> owning host attachment only
  -> trusted connection scope（serial + dedupe）
  -> existing workspace CLI: v4/connection/flow
  -> pause/resume only mobile connection B

desktop connection A ───────────────────────────────> continues draining
```

main/relay 不能指定任意 connectionId；host scope 从 owned subscription 生成 workspace/connection route。
remote host relay 对下游 id 做长度前缀 namespace。port close 串行发送 `closed` 后再 dispose owned
subscriptions，旧 SAT/DRN/timer 不得复活。

`zcode-server /ws` 对所有普通连接固定为 replayable；旧的
`x-zcode-rpc-client-mode` header 会被忽略，不能把浏览器或普通 WebSocket 升格为
continuous。desktop server-remote 的 Node host 先通过受现有 server auth middleware
保护的 `POST /api/rpc-host-capability` 获取短期、一次性随机 capability，再在 Node-only
header 中携带它连接专用 `/ws/host`。服务端消费成功后才创建 continuous trusted relay
attachment，最终 `connectionId` 仍由 server 逐连接生成。open/no-token server 也保留同一
“显式申请 ticket → 一次消费”的边界；无 ticket、无效 ticket、过期或重放均拒绝。

```text
Desktop Node host
  │ POST /api/rpc-host-capability（沿用现有 auth）
  v
短期 capability ── 首次消费 ──> GET /ws/host ──> continuous trusted relay
       │                              │
       └─ 过期 / 重放：拒绝          └─ server 生成 connectionId

Browser / 任意普通 client
  └─ GET /ws（旧 mode header 被忽略）──────────> replayable terminal
```

每个 attachment 的 subscribe 在调用 CLI 前先建立 pending ownership。CLI server 用 request-scoped
post-response outbox 固定按 `ACK response -> initial notification` 写出；即便两行在同一 read 中到达，
ACK 前早到的 physical wire 仍只进入有界 staging，ACK 绑定 `subscriptionId`
后才按原序释放给唯一 owner 的 incremental assembler。ownership 过滤先于 assembly；
foreign subId 不占内存。staging 上限为 1,024 wires / 32 MiB，溢出清空整批并显式
标记 `fault.subscription.initialFrameStagingOverflow`，禁止 shift 单片。attachment close /
stale generation / unsubscribe 清空 staging 与 assembly。unsubscribe 则由 owned
registry 生成完整 `{ topic, subscriptionId, connectionId }` route，CLI 只删除三者完全匹配的
publisher entry，避免相同裸 `subscriptionId` 跨 topic 或连接误删。

CLI publisher 的 initial/online 帧均使用 non-destructive reservation：全部 physical
notification 在当前 transport 被接受后才推进水位；中途失败重试相同
logical id/content。topic encoder 按 CLI NDJSON、Channel binary 与旧 mobile outer 的保守上界
切片；production mobile Channel message 随后还会经过 raw adapter 的独立精确 final-envelope
meter/fragment，因此实际 relay JSON 同样不超过 1 MiB。附件另走
`begin -> <=512KiB decoded chunk -> commit/abort` 业务事务；renderer→host Channel 与 host→CLI
NDJSON 分别实测 envelope，禁止 full-data `attachment/put` fallback。relay/main 仍只看 opaque
`rpc-frame`，不保存 upload staging、checksum 或 artifact ref。
每个 subscription 同时持有单调 `logicalFrameOrdinal`；host/renderer assembler 用它
阻断迟到 replay 与反向 supersede，完成/fault/timeout 的 tombstone 只在
unsubscribe/换代时清除。

task messages、assistant stream、tool call、permission、plan、runtime status 和 task list 的真实元数据都来自同一个 CLI/runtime。composer draft、scroll/focus/panel 等未提交状态保持 renderer-local；一旦输入被提交，无论来自桌面还是手机，都直接进入同一个 CLI `CommandInbox`/runtime FIFO。手机 V4 不再经过 `enqueueTaskCommand` 的 host runtime command queue，桌面也不保留 renderer-local accepted queue；UI 只保留 pending optimistic overlay 并用 projection/`commands/query` 对账。

远程 workspace bridge 只允许 attach 到桌面窗口已经存在且未关闭的 `remoteSessionId`。`remoteSessionId`
由 Window Host 内的 registry 分配，仍是 workspace 级 logical session；main 只持请求关联并转发 scope，
最终由 Host 校验 session 已绑定的 `workspacePath + workspaceIdentity` 后创建独立 attachment。手机端不能创建新的 SSH / WSL /
Docker remote session，也不能借 session A 访问同 Host 下的 workspace B；身份隔离继续使用
`workspaceIdentity?.trim() || workspacePath`。

桌面 renderer 在远程目录选择或重连确定 canonical path 与 identity 后，必须通过
`BindRemoteWorkspaceSessionContext` 把同一组 `workspacePath + workspaceIdentity` 绑定回 main/Host 的
logical session。tab、远程历史与手机可见 workspace 列表使用的值若与 main descriptor 不一致，bridge 会以
`REMOTE_WORKSPACE_IDENTITY_MISMATCH` 拒绝（3.12.0 曾因新建连接后缺少这次 bind 导致手机端连不上远程项目）。

进程回收仍由桌面生命周期触发：真实关窗、app quit、update install 会关闭 attachment 后回收对应或全部
Window Host；手机 bridge/relay 断连、页面刷新和 replayable 重连只释放短生命周期 attachment，不能销毁
Window Host 或仍被其他 owner 使用的 remote connection。该边界不改变 `workspaceIdentity + remoteSessionId`
路由，也不把 replayable 状态下沉到 main。

## Task Message Streams

桌面端和手机端连接的是同一个 service/runtime，但 delivery profile 由可信 attachment 决定，不是 UI 参数：

- 桌面端（包括远程 workspace 桌面窗口）固定 `continuous`，保持完整实时数据流。
- 手机 Web 远控固定 `replayable`，用于断线重连、页面刷新、晚订阅和 gap 恢复。

replayable 不是 relay 级别的重放。relay 仍只透传 `rpc-frame`；connection-level
saturated/drained 由 desktop main 通过 owning MessagePort sideband 传给 host/CLI。topic seq、subscriber
buffer、fragment assembly、gap/resync 和 snapshot 都由 host facade 与 CLI publisher/client apply 维护，
relay/main 不持有 conversation 业务状态。

手机端 gap 或 attachment 重建后的恢复顺序是：

1. 重新 attach bridge，完成 V4 `hello/clientHello`，获得新的可信 connection context。
2. 自动按活跃 topic 重订阅；有合法 `{logEpoch, seq}` 时尝试 resume，否则 snapshot。
3. snapshot 完整分片 assembly 后整体替换；`toSeq <= localSeq` 静默丢弃。
4. gap 只触发一次 `v4/conversation/resync`；resume 再断档强制 snapshot。
5. 从 projection 恢复 permission/elicitation、queue/guided row 与 pending command summary；ACK 不明时用 `commands/query` 对账。

CLI runtime restart 会改变 `logEpoch` 并触发 snapshot。上一进程已 admitted 但未进入 transcript 的输入明确返回 `fault.command.inputDiscardedOnRestart` 及持久 `delivery`；旧 runtime 的 `queue/guide` 静默结算，只有未进入 transcript 的 `startNow` 或 `unknown` 提示用户确认重发，不能自动重放。手机网络断线但 runtime 未换代时，仍由 replayable snapshot 恢复权威 queue，不依赖 renderer localStorage。

阻塞类事件不能按普通 owner-only 内容流过滤。`permission_request`、`elicitation_request`、对应 response、terminal 和 snapshot invalidation 必须对同 task 的在线客户端可见，或至少触发 snapshot 对齐。

## Web

`/remote/v4` 是 V2 登录与 QR 直连入口，回调模式先于登录门禁。开发/构建别名沿用路由配置，全部使用 V2。

Mobile web 连接流程：

1. 识别 code/state 回调并保存登录态回跳；否则先过 JWT 登录门禁，再解析 sid/mid/name/app_version。无 SID 时读取当前账号设备列表，最近设备仍在线则直连，否则展示可刷新的设备列表；选择在线设备后回写 URL。
2. 通过 `WebRemoteControlTerminalTransport` 申请 role=terminal token，连接 ws2?token&mid，再发送 V2 auth_init(device_sid)；401 回登录，AUTH_FAILED 显示账号归属失败与切换账号动作。
3. paired 后发送 `bootstrap-request`；v4 使用响应中的可选 `desktopAppVersion` 校验 URL。
   首次不一致时校正并导航，已进入页面时保留页面并提示确认后重新加载；旧桌面缺字段时保持原行为。
   重连/回前台时即使 bridge 健康也重新校验，具体边界见 [v4 版本同步](./remote-v4-static-deployment.md#v4-url-与桌面实际版本同步)。
4. 优先采用 `mobileViewState ?? initialViewState` 中可 bridge 的 workspace；旧目标缺席或离线时，
   回退到第一个可 bridge 的 workspace。只有没有可 bridge 候选时才选择离线项。
5. 若目标远程工作区尚不具备 bridge 条件，渲染 home-only `Root`，保留工作区列表与重连入口；
   此时不创建 workspace bridge，也不开放依赖工作区服务的任务操作。没有可选工作区时显示错误页。
   工作区列表由 ProjectSidebar 在没有 projectService 时从 `listWorkspaces` 与推送读取，行为见
   [虚拟项目 §6.0.3](../superpowers/specs/2026-09-09-virtual-project-design.md#603-手机项目新目录的-shared-host-admission)。
   home-only 空服务沿用 `ProxyChannel` 命名契约：`onXxx` 是永不触发的 Event，`onDynamicXxx(arg)` 同步返回该 Event，
   其他未显式实现的方法异步返回 `undefined`。home-only `Root` 挂载后与 bridge `Root` 一样标记 ready，
   之后的配对状态变化只更新横幅，不再替换为加载页或重挂首页。
   已打开的同一远程会话随后断线时则注销失效 services、保留当前 Root 的只读内容与草稿，并显示断线横幅；详见[工作区重连](./mobile-remote-workspace-reconnect.md)。
6. 目标可建立 bridge 时发送 `workspace-bridge-open`，用 `createAcknowledgedWebRemoteControlRelayProtocol()`
   将 `rpc-frame` / `rpc-frame-ack` app payload 适配为 `IMessagePassingProtocol`，维护分片、ACK 与传输恢复。
7. `connectViaProtocol()` 后渲染 `Root`；窄屏由 `WebRemoteControlMobileShell` 管理首页/聊天页，
   宽屏使用远控侧栏。初始 workspace 的选择与页面落点是两种状态，不能把选中 task 等同于自动进入聊天。

手机 V1/HMAC、`/web-remote` 路由、已登录等待页和 `remoteControlToken` / `relayOrigin` 的旧 HTTP bootstrap 均移除。认证/连接 owner、错误恢复与时序见 [Relay V2](./relay-v2-pairing.md#手机首次进入与恢复05)。

## Feature Exposure

当前 Desktop main 使用 `createWebRemoteControlFeatureGate()`，其默认值为 `true`，
不按 production/development 环境自动禁用远控。生产环境可以通过既有远控入口启动并获取连接信息；
不能再把“生产构建”视为启动 IPC 被拒绝或 status 隐藏二维码的保证。

`WebRemoteControlFeatureGate` 仍保留显式禁用能力：注入 `false` 时 manager 拒绝启动，
status 不返回有效远控连接信息。该 gate 是功能开关，不替代下文的调用来源校验与内部票据边界。
当前接线见 `packages/desktop/src/main/index.ts`，开关实现见
`packages/desktop/src/main/webRemoteControlFeatureGate.ts`。

## 启动调用边界与 Office XSS 关系

打开 `WebRemoteControlDialog` 是用户进入 Web 远控的既有入口。当前目标没有可复用 runtime 时，
renderer 通过登录门禁后发送启动 IPC；二维码不再提供刷新配对操作。Desktop main 不叠加原生二次确认。

```text
WebRemoteControlDialog open (signed in)
        │
        ▼
Desktop main: window/source check
        ▼
Manager: issue internal one-time ticket (short TTL)
        │
        ▼
Manager: consume ticket exactly once -> start relay
```

manager 仍生成绑定 `windowId + workspaceKey + remoteSessionId` 的短 TTL、一次性内部票据，其中
`workspaceKey = workspaceIdentity?.trim() || workspacePath`；
票据不得进入 renderer 可写的共享协议，也不得写入日志、遥测或普通设置。它用于约束
`startAuthorized` 的调用和目标一致性，但因为同一个 IPC 请求会立即签发
票据，所以它不是用户授权，也不能阻止已被攻陷的 renderer 调用启动 IPC。

IPC handler 的 manager 依赖类型只暴露 `authorizeStart`、`startAuthorized`、
`notifyAuthStateChanged`、`stop` 和 `getStatus`。直接 `start` 属于 manager 内部生命周期实现，
不能进入 renderer 可达的 IPC 依赖接口；刷新配对 IPC 已删除。认证通知只包含状态，main 重新读取凭据。公共返回类型保留 `cancelled` 兼容分支，当前 Desktop 启动不会产生该终态。

启动、窗口关闭、用户停止和票据超时都必须使未消费票据失效。应用启动时恢复
“上次已启用”仍是内部生命周期操作，不得绕过 workspace/session 绑定。

Office 文档 XSS 的根因边界由 `docs/ui/office-file-preview.md` 定义：不可信链接必须经过协议白名单、
DOM 净化、点击拦截和受控外链打开。移除原生远控确认不改变这些根因修复；代价是如果未来出现新的
renderer XSS 或上述边界被绕过，攻击代码可以再次直接调用远控启动 IPC，内部票据不会提供用户在场
证明。安全评估不得把该票据当作 Office XSS 的补偿控制。

已通过现有登录、设备配对和 workspace bridge 挂接的 `web-remote-replayable` 客户端可以
打开终端。Window Host 的手机频道 allowlist 显式包含 `ServiceChannels.Terminal`，复用当前
local/remote attachment 所属的 `ITerminalService`，支持既有 create、输入、输出、resize 和
dispose 契约。工作目录与标签保活沿用已有实现；手机 PTY 的归属和结束规则见下节。
不新增授权票据、独立手机 runtime 或断连计时器。

2026-10-22 恢复说明：此前把 Terminal 排除在手机 allowlist 外，导致已配对客户端打开终端时
在服务调用前得到 `Channel name 'terminal' timed out after 1000ms`。只恢复该频道；其他频道
仍按原 allowlist 管理，Source Management、Provider Provisioning 和未审阅频道仍不开放。
`desktop-continuous` 继续使用原完整服务集合。Office XSS 修复和既有远控鉴权、配对、目标绑定
保持独立，不以禁用正常手机终端替代这些边界。

```text
手机 -> 既有配对 / workspace bridge -> 手机 allowlist -> 当前 Host Terminal -> PTY
桌面 -> 原 continuous attachment -> 原完整服务集合 ------> 当前 Host Terminal -> PTY
```

回归：MRO04 用真实桌面、手机视口 Web、loopback relay 和 PTY 验证手机打开、输入、输出、
关闭再打开，以及桌面既有终端继续执行命令；Host RPC 测试保留其他频道拒绝和桌面可用对照。

### 手机终端的连接换代（2026-10-22）

手机从已有会话返回首页、在同一项目新建草稿、再返回原会话时，workspace bridge 会换代。
原终端标签、xterm 历史和 Host 中的 PTY 保留，输入、输出、退出通知、resize 与显式关闭
必须使用当前连接。仅恢复 DOM、继续持有已释放的旧 RPC 代理，不满足终端保活合同。

常驻输入、输出和关闭使用的终端连接由现有 side pane session registry 条目持有；React 组件重挂时只更新连接绑定，
不重新创建 PTY。同一服务代理重复挂载不重复订阅；代理变化时先取消旧订阅，再订阅新代理，
旧订阅的迟到事件不得更新当前终端。显式关闭只释放一次当前绑定的 PTY 和订阅。
resize 已由当前挂载组件的服务代理处理，保留原有调度，不把旧组件的 resize 请求迁移到新连接。
复用同时校验已有的客户端命名空间（手机使用稳定设备身份）和 workspaceKey（远端使用包含
Source 身份的 workspaceIdentity）。即使两台设备的本地路径相同，也不挂载或重绑对方的保活条目，
不将旧 PTY id 交给其他工作区或机器；Host 退出后的进程恢复不属于此合同。
桌面侧栏终端复用同一规则；底部终端保持原生命周期。连接未变化时，桌面输入和订阅不变。

```text
修复前：新 bridge 就绪 → 旧 bridge 释放 → 原标签重挂 → 输入/订阅仍走旧代理
修复后：新 bridge 就绪 → 原条目绑定新代理 → 原 PTY 继续输入/输出
                                     └→ 旧订阅释放，迟到事件忽略
桌面：  原服务代理未变 → 原 PTY / 原订阅继续使用
```

MRO04 增加同项目新建草稿后返回原会话的回归：原标签 ID、shell PID 和历史保留，
新命令有完整输出，随后关闭重开正常，桌面底部与侧栏的原终端均继续执行。命令完成判定等待本次输出
标记和工作目录同时可见，并返回这份完整快照。完成标记在工作目录之后输出，避免同一终端的
旧目录输出满足等待条件；不以第一行输出到达代替本次命令输出完成。

### 手机终端 owner 与回收（CR-01，2026-10-22）

已确认的行为：刷新页面关闭旧终端；同页 workspace/bridge 换代保留 PTY；失联超过既有
3 秒断连宽限后关闭终端，重连再打开时创建新终端。两端第一次重连的随机等待加连接耗时必须落在这 3 秒内，
否则短断线也会被当成确认断连，见[重连打散](./relay-v2-pairing.md#重连打散)。关闭手机浏览器、切设备、远控停止、
鉴权失败或被踢均结束旧 owner。短暂断线在宽限内恢复则保留。页面卸载通知不作为可靠前提。

Main 的窗口远控 runtime 只负责页面会话与 owner 生命周期：Web 在一次页面连接内保留
`terminalClientSessionId`，bootstrap 与 bridge-open 携带该标识；Main 分配可信的
`terminalOwnerId`，先通知已有 Window Host，再挂接 bridge。刷新收到新页面标识时替换
owner；确认断连沿现有宽限回调结束 owner，不因单个 bridge/attachment 释放而结束。
桌面端终端不加入手机 owner。

Window Host 唯一持有该 owner 在 local/remote scope 中创建的 terminal ID，包装已有
Terminal 服务，不另建 PTY runtime。owner 替换/释放先使旧 scope 失效，再逐个 dispose；
已经在途的 create 即使晚到也立即回收，不得登记到新 owner。旧 attachment 与迟到请求
不能复活已结束 owner；同一 owner 在同一 scope 的新 attachment 复用原终端归属。
旧客户端未声明页面会话时，终端仅按 attachment 生命周期回收，不允许无主 PTY。

```text
页面会话 → Main 分配 owner → Host owner → local/remote Terminal → PTY
同页换 bridge ────────────→ 同 owner / 原 PTY
刷新 / 确认断连 / 远控终止 → owner 失效 → 回收全部所属 PTY
                                        └→ 晚到 create 立即 dispose
重连 → 新 owner → UI 清理旧保活条目 → 新 PTY
```

bridge-ready 返回 owner 标识。UI 将它用于终端生命周期，不改变草稿的稳定设备命名空间。
owner 结束产生 bridge-degraded，恢复沿已有 bootstrap/rebuild 路径；旧 xterm/terminal ID
不得绑定到新 owner。Host 计数 `terminal.open` 保留用于诊断。

同页故障恢复可能在草稿页重建整个 React Root。侧栏标签更新必须在既有 canonical commit
中同步写入 workspace memory；不能等旧 Root 的卸载 effect 才保存。新 Root 的首次 render
早于旧 Root 的 passive cleanup，延迟保存会丢失标签引用，留下仍存活但无法回到的 PTY。
同 owner、同 workspace 的恢复必须保留原标签 ID、历史和 PID，显式关闭后的标签不能恢复。

已卸载的侧栏实例不能再提交整份标签或折叠态快照。浏览器关闭等待主进程持久删除期间，
App 可能因登录页或错误恢复重挂；旧关闭完成后仍释放选定资源，但必须从原 workspace
的最新 memory 中只删除点击时选定的标签，保留新实例新增的标签及折叠偏好。
本次只收敛旧快照覆盖，不改变重挂后浏览器标签壳接收关闭结果的既有行为。

```text
关闭等待 -> App 卸载 -> 新实例提交标签 B -> 旧关闭完成
                                           -> 最新 workspace memory 只删除旧标签 -> 保留 B
```

确认断线的结束动作也必须释放没有页面 ID 的旧客户端 attachment；没有 owner 不等于没有
终端资源。普通旧客户端 bootstrap 不结束仍活跃的 attachment。迟到终端事件订阅由 RPC
请求边界拒绝并返回独立订阅错误，不得作为终端输出派发，也不得让异常退出共享 Host。

```text
侧栏交互 -> canonical commit -> 同步 workspace memory -> 新 Root 读取原标签
确认断线 -> 撤销在途 bridge -> 释放 attachment -> owner / legacy scope 回收 PTY
迟到 listen -> RPC 拒绝该订阅 -> 记录错误；其他订阅和桌面终端继续
```

验证：Host owner 与 Main 生命周期单测覆盖回收、晚到创建、旧页面迟到请求及旧客户端兼容。
MRO04 在 macOS Electron + Chrome 手机视口通过页面刷新、长断线恢复和关闭浏览器后的
真实 shell PID 回收断言，同时保留同页 bridge 换代的原 PID、桌面底部与侧栏终端对照。
证据见 [MRO04 覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md#手机远控终端恢复mro042026-10-22)。
远端断连导致底层服务不可达时报告清理错误，不能声称远端进程已结束。

## Workspace Hook Trust Review

Workspace Hook Trust 不在 relay、desktop main 或 renderer 中复制业务状态。Desktop continuous 与 Mobile/Web
replayable attachment 共享同一个 CLI Runtime review registry：

```text
project Hook discovery
  -> CLI Runtime immutable snapshot
  -> Runtime review registry (唯一权威)
       ├─ continuous delta -> Desktop Settings
       └─ replayable snapshot/delta -> Mobile/Web Settings

Settings decision
  -> trusted connection facade
  -> sendConversationCommandV4
  -> CLI CommandInbox
  -> task/run/remoteSession/workspace/bundle/generation validation
  -> Trust mutation or fail-closed reason
```

约束：

- Host capability `workspaceHookReview` 和 Client UI capability `workspaceHookReviewUi` 必须分别声明；缺失等价于 false。
- review request 作为 `pendingInteractions[kind=workspaceHookReview]` 投影，手机 refresh、gap/resync 或 attachment 重建只恢复 presentation，不 settle Runtime request。
- command target 绑定 `taskId + runId + remoteSessionId? + workspaceIdentity + bundleDigest + reviewFlowId + generation + interactionId`；任一不匹配都在 store mutation 前拒绝。
- renderer pending-command registry 只保存 sensitive command digest/ACK 状态。ACK 不明时可以 `commands/query`，不得持久化或自动重放原始 Trust decision。
- Runtime restart 产生新的 run epoch；旧 interaction、Allow once 和 pending sensitive command 不能跨 epoch 复用。
- `workspaceHookTrustEnabled=false` 时 Runtime 不读取 Trust store、不创建 review；Protocol Host 可在 trusted bootstrap 边界关闭该字段回滚到 hard block。
- managed deny 始终高于 UI/CLI 建立的 Trust；relay/main 只路由 opaque command 和 projection，不持有 policy、Trust store 或 lease 的副本。

### 2026-09 虚拟项目目录导航

手机 home 复用 ProjectSidebar，经当前 base attachment 读取 Host 项目行集合；手机 shell 仅拥有 home/chat 与浏览器返回状态。`workspace-bridge-open.project` 是严格的 projectId/hostId 意图，由 main 转交窗口 Host 的 ProjectService 准备执行目录。它允许在已在线物理 Source 上创建或复用目录 logical scope，不允许隐式新建物理连接、Host 或 Agent。准备前后检查连接成员代际、项目入口与物理连接对象；main 只保留当前导航的 RPC promise，同一 bridge identity 的重试不重复分配目录，取消/关窗/后续导航使迟到结果失效。

Host 返回可信 workspaceIdentity、remoteSessionId、cwd 后沿原 shared-host attachment 建立手机 replayable bridge。项目/provider/初始输入只在 Web 的 Root 交接中传递，main 不存草稿或任务业务状态。桌面 direct continuous、手机 snapshot/gap 恢复、owner/lease 和 CLI CommandInbox 的单队列规则保持不变。

手机未提交项目草稿复用 Renderer 既有 composer 持久化：按 workspaceKey 的 `__draft__` scope 保存可选 projectId，与正文/模型一起恢复。Root 重建或页面 reload 在 prewarm 前恢复该选择；显式新建未归类草稿写 NULL，明确 taskId 的历史打开优先。提升为持久任务后不把 projectId 复制到 session composer scope；已提交任务的归属仍只由 Host app 库拥有。main、relay 和 shared-host transport 均不持有这份草稿。
