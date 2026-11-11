# Workspace Hook 持久信任简化规格

> 状态：2026-08-13 产品语义已确认，作为 Workspace Hook Trust 交互与状态模型的最新事实来源。旧文档中 `Allow once`、`Keep blocked`、`trust_all`、SessionStart 补跑及多状态徽章均由本文取代。

## 1. 目标

Workspace Hook 只保留一种用户授权：对当前工作区中某一条精确 Hook 声明建立持久信任。

- 配置开关只控制 Hook 是否启用。
- “信任”按钮只建立持久 Trust，不切换配置；其可见性来自 Settings 静态 Trust
  快照，不依赖当前是否已经存在 Runtime review flow。
- 已信任时不显示按钮或“已信任”徽章。
- 未信任时不显示“需要审核”“未持久信任”“将会运行/不会运行”等推导状态。
- 不提供 Workspace Hook 专属的本次授权、全部信任或本会话阻止操作。
- 通用工具权限中的 `Allow once` 不属于本功能，不受影响。

## 2. Impact Brief

### 2.1 变更层

| 层 | 本次变化 |
| --- | --- |
| presentation | 删除独立审核面板和行内状态徽章；未信任行在有效运行开关左侧始终显示“信任”按钮 |
| validation | 继续校验 workspace identity、bundle digest、review flow generation、interaction、review item，并在所有 Settings Trust mutation 前校验同一受信 managed policy provider |
| commit-effect | 用户只可提交单条或明确选中条目的 persistent Trust mutation |
| persistence | 仍使用 user-owned Trust store，以 `workspaceIdentity + hookDeclarationDigest` 为键 |
| recovery | continuous/replayable 继续投影 pending admission；超时、断连和页面关闭均不写 Trust |

### 2.2 UI Surface Matrix

| Surface | 展示/本地状态 | 提交入口 | 权威状态 | 多端边界 |
| --- | --- | --- | --- | --- |
| Settings / Hooks / Workspace 行 | Hook 配置与静态 Trust store 快照决定按钮/开关展示；活跃 review request 只提供可操作 generation | 有 session command binding 时复用 Runtime review；无 task/session 时经 workspace 级 Agent RPC 重验 snapshot，并通过 Host 注入的同一 managed policy provider 后提交精确 declaration digest | Runtime review controller / workspace pretrust authority + shared managed policy provider + user Trust store | Desktop 与 Web 共用组件；remote 必须携带 `workspaceIdentity` / `remoteSessionId`；不得为了信任创建隐藏 task |
| 会话 composer Hook 图标 | `workspaceHookAdmission.pendingCount` | `requestWorkspaceHookReview` 后打开 Hooks 设置 | Runtime admission projection | Desktop continuous 直推；Web remote replayable 从 snapshot 恢复 |
| Runtime dispatch gate | canonical snapshot evaluation | 无 UI 旁路 | Trust coordinator + security revision | 所有 SessionStart/tool dispatch 共用同一 gate |

### 2.3 必须检查的关系

- `must-inspect`：共享协议 decision schema、review controller、Trust coordinator、Hooks Settings 行组件、i18n 与相关测试。
- `should-inspect`：Hook 图标浮层、continuous/replayable projection、Trust store、policy、revoke 与 digest 变化。
- `invariant-only`：普通工具权限 `Allow once`、provider execution boundary、desktop queue 与 mobile replayable queue。
- `evidence-only`：旧审核面板、once-grant/session-family 测试和 UAT 文案；它们用于证明清理完整性，不再定义产品行为。

代码图服务在本次工作环境不可用；影响面以仓库 feature graph、`dep:refs`、协议调用链和精确文本引用交叉确认。本次已将此前缺失的 Workspace Hook Trust capability、Settings surface、renderer binding、Runtime controller 与 Trust store 关系补入 feature graph。

## 3. 状态模型

用户信任状态只保留两类产品语义：

```text
                         Hook declaration digest 变化
                    ┌──────────────────────────────────┐
                    │                                  v
               ┌──────────┐      点击“信任”      ┌──────────┐
               │ untrusted│ ────────────────────> │ trusted  │
               └──────────┘   精确校验 + 原子落盘 └──────────┘
                    ^                                  │
                    └──────────── exact revoke ────────┘
```

配置状态与信任状态正交：

| configured | trusted | 行内操作 | Runtime 结果 |
| --- | --- | --- | --- |
| off | no | 显示“信任”与锁定关闭的有效运行开关 | 不执行 |
| on | no | 显示“信任”与锁定关闭的有效运行开关；不改写原始配置 | 跳过并上报 pending |
| off | yes | 只显示关闭的配置开关 | 不执行 |
| on | yes | 只显示开启的配置开关 | 通过其他 policy / snapshot gate 后执行 |

未信任时开关展示的是“当前是否可运行”，因此统一为关闭且不可操作；原始
`configuredEnabled` 仍保留在 workspace 配置中。若它原本为 `on`，持久信任成功并刷新
Settings 后开关自然恢复为开启；若原本为 `off`，信任后仍保持关闭但变为可操作。打开
Settings、显示锁定开关或发起 Trust 都不得为了界面效果静默改写 workspace 配置。

`blocked_policy`、Trust store corrupt 等仍是 Runtime 安全原因，但不再伪装成用户信任选择，也不在 Hook 行堆叠产品徽章。策略不允许用户写 Trust 时，“信任”操作必须被服务端拒绝并显示可读错误。

## 4. 用户交互

```text
会话发现 enabled + untrusted Hook，或 Settings 静态发现任意 untrusted Hook
  -> Runtime 自然事件仍跳过 Hook，turn 继续
  -> 用户通过 Hook 图标浮层 或自行进入 Hooks 设置
  -> 静态 Trust 状态立即显示“信任”与锁定关闭的有效运行开关
  -> 点击后优先复用当前 session review flow
  -> 当前没有 task/session 时，经 workspace 级只读 Agent RPC 重新发现 canonical snapshot
  -> 使用与 session Runtime 相同的受信 managed policy provider 校验 mutation authority
  -> 仅 user_decides 可继续；deny / allow_trusted_only 返回稳定 reason code 且不写 store
  -> 同时匹配 workspaceIdentity + bundleDigest + hookDeclarationDigest 后提交该行
  -> Runtime 校验 immutable generation 与当前 bundle
  -> Trust store 原子落盘，security revision 递增
  -> 列表刷新；该行“信任”按钮消失
  -> 其他未信任行保持按钮可用
```

按钮在 mutation 进行中必须禁用，防止双击重复提交；失败时保留按钮并显示本地化错误。行本身仍可进入编辑，按钮点击必须阻止冒泡，不能误打开编辑表单。
没有活动 session command binding 时，按钮仍须显示且可操作；Hooks service 只能把请求转发给
workspace 级 Agent Trust authority，不能自行写 Trust Store。该入口不得创建隐藏 task，也不得
把静态 Settings 快照直接当成授权依据；Agent 必须在提交前重新发现并精确比较 canonical bundle。

## 5. 时间与生命周期

- 信任只作用于未来自然发生的 Hook event，不追溯执行已经跳过的事件。
- 被跳过的 `SessionStart` 不在当前 task 的第二、第三个 prompt 补跑；它最早在下一次真实 SessionStart（新 task/session）运行。
- review deadline 只使 immutable request 过期并关闭当前操作快照，不写负向决定、不清除 pending admission。
- 页面关闭、离开 Settings、attachment 断连、图标忽略均不改变 Trust。
- partial trust 后，已成功项按钮消失；若仍有 pending 项，Runtime 发布新的 generation，其他按钮继续可用。

时序：

```text
Renderer              V4/Bootstrap                 Core / Trust Store
   │ 未信任行点击“信任”      │                              │
   ├─ session 存在: request review ─> open/reuse flow      │
   ├─ 无 session: workspace grant ─> rediscover snapshot   │
   ├─ exact item decision ─>│ validate identity/bundle/flow│
   │                        ├─────────────────────────────>│ atomic grant
   │                        │<─────────────────────────────┤ revision + evaluation
   │<─ settled old flow ────┤                              │
   │<─ requested next flow ─┤ (仅仍有 pending 时)          │
   │ refresh Hooks list     │                              │
   │ 按钮按 persistent Trust 消失                           │
```

## 6. 协议与领域收敛

`WorkspaceHookReviewDecision` 只保留：

```ts
{
  action: "trust_selected";
  reviewItemIds: string[];
}
```

本次删除 Workspace Hook 专属的：

- `allow_once` / `trust_all` / `keep_blocked` decision；
- `WorkspaceHookOnceGrant`、once grant map 和 `trusted_once`；
- session-family user block 和 `blocked_user`；
- timeout 自动用户决定；
- SessionStart lazy catch-up；
- 独立 review panel、全选/多选控件、多状态徽章及对应 i18n/test-id/telemetry 分支。

保留 exact revoke 作为底层和既有其他入口能力；当前 Hook 列表不显示撤销按钮。

## 7. 不变量

1. 未持久信任的声明在任何 dispatch 入口都不执行。
2. Trust mutation 必须绑定 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 与精确 declaration digest。review binding 与路由按 `workspaceKey` 匹配；Trust record 的读写键是共享 resolver 计算出的 Trust identity。受管 worktree 的 Trust identity 归一为源仓库，其余 workspace 的 Trust identity 等于 `workspaceKey`（见 `workspace-hook-trust.md` D23）。
3. 远程 workspace 不得退化为仅按 `workspacePath` 判断。
4. stale generation、bundle 变化、snapshot 外 item 和 policy 拒绝全部 fail closed。
   Settings 无 session pretrust 与 session review 必须读取同一个由 Host 注入的
   `WorkspaceHookPolicyProvider`：`deny` 返回 `workspace_hooks_blocked_by_policy`，
   `allow_trusted_only` 返回 `workspace_hooks_policy_requires_pretrust`，两者均不得调用
   Trust store mutation。UI 或 workspace/project 配置不得提供或覆盖该 provider。
5. Trust store 位于用户拥有的存储；workspace 文件不能自授信任。
6. Desktop continuous 不拼接 mobile replayable 恢复消息；mobile replayable 不绕过 snapshot/gap/owner 边界。
7. UI 不直接调用 Repo；Settings 通过现有 command/service boundary 提交。

## 8. Case Planning 与剪枝

### 已确认

| Case | Setup | Action | Assertions | Evidence |
| --- | --- | --- | --- | --- |
| WHT01 | enabled + untrusted | 打开 Hooks 设置 | 只显示“信任”与开关，无状态徽章 | UI + Runtime request item |
| WHT02 | disabled + untrusted，且存在当前 immutable review | 点击“信任” | 可预先持久信任；配置仍关闭；按钮消失 | UI + Trust store |
| WHT03 | 多条 untrusted | 信任其中一条 | 仅该条落盘/消失；其余通过下一 generation 保持可操作 | Protocol + store + UI |
| WHT04 | 已信任 SessionStart 曾被跳过 | 当前 task 再发 prompt | 不补跑；下一新 task 的自然 SessionStart 才可运行 | Runtime lifecycle |
| WHT05 | pending review | 超时/关闭/断连 | Trust 不变，pending admission 不变，可重新请求 review | Protocol projection + store |
| WHT06 | 已信任声明发生语义变化 | 刷新/下次评估 | 新 digest 未信任，按钮重新出现，旧记录不授权新声明 | Digest + UI + runtime gate |
| WHT07 | 本地与远程 tab 使用相同 `workspacePath`，远程具有独立 identity | 本地 Settings 查找 review/command binding | 只命中本地 binding；远程 identity 不能通过 path fallback 成为本地提交通道 | UI store |
| WHT08 | explicit project config 与 auto-discovery 指向同一文件，或候选中含损坏 JSON | Runtime 与 Settings 分别构造 snapshot | 同一 canonical source 只出现一次；失败候选仍占 discovery order，双方 digest 一致 | adapters + shared discovery |
| WHT09 | Hook 图标浮层当前可见 | 点击“忽略”；随后 bundle digest 变化 | 当前 bundle 立即隐藏；新 bundle 重新显示；命令 reject 仅记录 services/UI 规范日志 | UI interaction |
| WHT10 | 同一 snapshot 连续请求审核或并发提交两次同一决策 | `requestReview` / `respond` | flow 只创建和监管一次；Trust 只落盘一次，第二次提交 superseded | bootstrap controller |
| WHT11 | Trust 已原子落盘，但 deadline 抢先终结旧 flow | controller 收口提交结果 | 按 accepted 回报，且只发一次 resolved Settled；不得把已成功授权误报为失败 | bootstrap controller + store |
| WHT12 | Trust store revoke 收到空 digest 列表；Windows rename 遇短暂占用 | revoke / atomic write | 空列表作为无效输入拒绝；`undefined` 仍表示撤销 workspace 全部；EPERM/EBUSY/EACCES 有界重试 | adapters persistence |
| WHT13 | Settings 静态快照为 untrusted，当前没有 review interaction，但存在同 workspace session command binding | 打开 Workspace Hooks；点击“信任” | 按钮立即可见；开关显示关闭并锁定；先请求 review，收到包含该 item 的同 bundle immutable request 后再提交 persistent Trust | UI store + bootstrap controller |
| WHT14 | 仅存在 configured-disabled + untrusted Hook，或当前没有 session command binding | 请求 review / 打开 Settings | controller 允许为 disabled pending item 建 flow；无 command binding 时按钮仍可点击，经 workspace grant 持久信任；任何展示均不改写 workspace 配置 | UI + bootstrap controller + services/Agent RPC |
| WHT15 | 没有 task/session，Settings snapshot 在点击前已过期或 Trust store 损坏 | 点击“信任” | Agent 重新发现 snapshot；bundle/digest 不匹配或 store corrupt 时 fail closed，不写 Trust、不创建 task | shared protocol + bootstrap pretrust + UI |
| WHT16 | 没有 task/session，Host managed policy 分别为 `user_decides` / `deny` / `allow_trusted_only` | Settings 点击“信任” | `user_decides` 才进入精确 grant；`deny` 返回 `workspace_hooks_blocked_by_policy`；`allow_trusted_only` 返回 `workspace_hooks_policy_requires_pretrust`；后两者不调用 store grant，也不能留下在后续 policy 放宽时生效的 record | protocol server + shared policy provider + Trust store spy |

### 剪枝

- `allow once × session family × restart`：产品已删除，不再枚举。
- `keep blocked × timeout × dismiss`：三者都归一为“无 Trust mutation”，不做负向决策排列。
- `trust all × configured enabled`：删除独立动作；批量选择不属于当前最小 UI。
- `trusted badge × will run badge × configured badge`：删除推导展示，避免组合爆炸和错误承诺。
- theme/locale/client mode 不与安全状态做全笛卡尔积；UI 单测覆盖中英和主题 token，共享 projection 测试覆盖 continuous/replayable 边界。

## 9. 验证

- Shared/contracts：decision schema 只接受 `trust_selected`；旧 action 拒绝。
- Core：只按 persistent Trust admission；无 once/user-block/catch-up 状态。
- Bootstrap：单条 trust 后 old flow settle，并为剩余 pending 发布 next generation；timeout 不写状态。
- UI：按钮由静态未信任状态决定可见；有 session 时按需请求并等待精确 immutable request，
  无 session 时通过 workspace Agent RPC 重新校验并持久信任；
  未信任开关按有效运行状态关闭且锁定；成功后刷新消失；状态徽章与旧 panel 不渲染。
- 回归：真实 CLI desktop-agent build、`pnpm typecheck`、`pnpm lint`、Trust 定向测试、provider 重构测试。

## 10. Review 修复不变量

本节记录 2026-08-13 review 后的实现约束；它们只修复隔离、确定性与可靠性问题，不扩展产品状态。

1. Renderer 查找 review/command binding 时先计算当前 `workspaceKey`。binding 自带非空
   `workspaceIdentity` 时只能与该 key 严格相等；仅自身没有 identity 的本地 binding 才允许
   使用 `workspacePath` fallback。相同路径的远程 tab 绝不能成为本地“信任”按钮的提交通道。
2. Runtime 与 Settings 必须共享 `discoverWorkspaceHookConfigPaths` 的候选编号和 canonical-path
   去重结果。explicit path 不得绕过该函数另行追加；加载失败的候选仍占 discovery order，避免
   后续声明 digest 整体错位。
3. Hook 图标的忽略是 renderer 本地、非持久状态，但点击必须立即触发组件重渲染；
   key 仍为 `sessionId + bundleDigest`，因此 bundle 变化后提示自然恢复。
4. Controller 的唯一生产入口是 `requestReview`。同一 pending flow 的重复请求必须复用 flow 和
   supervisor；并发 mutation 由 controller 队列串行。Trust store 已提交后，即使 deadline 使旧
   flow 无法再次 resolve，也必须按授权成功收口，且 resolved Settled 只发送一次。
5. Trust store revoke 参数保留严格三态：`undefined` 表示撤销该 workspace 全部记录；非空数组
   表示撤销精确 digest；空数组是调用错误，必须在任何 IO 前拒绝。原子 rename 对 Windows
   `EPERM` / `EBUSY` / `EACCES` 短暂占用进行有界异步重试，其他错误立即返回。
6. Workspace Hook review 不再接入通用 interaction broker 或 parked-turn dual-ACK 失败链。
   共享协议仅保留仍被 command envelope、core flow 与 task realtime 实际消费的 schema/类型。
7. Settings 静态 Trust 状态只决定展示，不能充当 mutation authority。有 session binding 时，
   行内 Trust 必须等待同 workspace identity、同 bundle digest、包含目标 reviewItemId 的
   immutable request；没有 session binding 时必须经 workspace Agent RPC 重新发现 canonical
   snapshot，并匹配同 workspace identity、bundle digest 与 declaration digest。两条路径的
   超时、断连或 bundle 变化均 fail closed。
8. `requestReview` 的“是否有待审项”不得按 `configuredEnabled` 过滤。配置开关与 Trust 正交：
   disabled declaration 允许预先信任，但仍不会运行；未信任开关的锁定展示不得改写配置文件。
9. Workspace pretrust 协议的 `reasonCode` 是明确枚举，不得承载底层 `Error.message`。已知公开
   domain reason 精确透出；包含绝对路径、用户名、配置内容或任意未知文本的异常统一映射为
   `workspace_hooks_config_unreadable`。底层异常不得跨 Agent/Host/UI 协议边界返回。
10. Protocol Host 必须创建或接收唯一受信 `WorkspaceHookPolicyProvider`，并把同一实例注入
    session Runtime 与无 session Settings pretrust。pretrust 必须在 discovery 和任何 Trust store
    IO/mutation 前读取 policy：只有 `user_decides` 可写；`deny` 与 `allow_trusted_only` 分别返回
    `workspace_hooks_blocked_by_policy` 与 `workspace_hooks_policy_requires_pretrust`。本地管理员 CLI
    若保留预审能力，必须继续走与 Settings RPC 不同的显式入口，不能复用普通 UI authority。
