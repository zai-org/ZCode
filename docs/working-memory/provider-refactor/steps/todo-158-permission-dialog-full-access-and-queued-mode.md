# Todo158：权限审批框完全访问与待执行队列权限同步

> 状态：2026-09-17 实现与桌面验收已完成；整体验收未全部关闭。原有工作区改动保留，CLI lint/基线测试失败及手机整链路缺口见第 9 节。

> 当前产品行为：审批行已扩展为「允许，并切换为…」。默认自主模式，选完全访问仍需风险确认；保留各项 Plan，同项目新会话继承所选权限。以下为原设计记录，现行契约见 [权限审批规格](../../../permission-project-approval.md)。

## 1. 目标与最新裁决

减少工具执行期间的重复审批，在权限审批框内提供“完全访问”，一次明确操作使当前任务、当前任务的 Composer 和全部待执行队列消息使用 `mode=yolo`。

- **仅审批框的“完全访问”触发批量同步**；普通 Composer 权限菜单继续只编辑下一次 Submission 的草稿。
- Runtime、Composer 和每个队列项分别保留自己的 `planEnabled`，不能统一套用 Runtime 的 Plan，也不能因切换权限退出 Plan。
- 本次操作针对当前任务，不把项目默认权限、其他任务或新任务默认值设为 yolo；不新增一次用户消息，不停止或重启当前轮。
- 队列只修改权限字段。正文、附件、模型、思考等级、Plan、身份、顺序和投递方式保持原值。
- 批量更新完成后再放行当前工具审批；失败不能显示全量成功，重复点击和跨端重复应答不能重复产生副作用。

本条承接 [Todo71：Composer 持久草稿](./todo-71-persistent-composer-draft-and-submission-state.md) 和 [Todo151：Plan 独立状态](./todo-151-independent-plan-state-draft.md)。只为审批框完全访问增加队列权限修改的明确例外，不重新打开模型选择或普通队列语义。历史冲突见 [C26](../design-v2/evidence-and-contradictions.md#c26-审批框完全访问是否可以修改已接纳队列的权限)。

## 2. 审批选项与展示

普通命令审批按以下顺序展示；默认仍选第 1 项：

| 序号 | 选项                      | 说明与效果                                                                                    |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | 允许                      | 仅允许这一次，保留既有 allow_once 语义                                                        |
| 2    | 始终允许此命令            | 项目范围内，后续相同命令不再询问；保留既有 allow_project 规则生成与匹配                       |
| 3    | 完全访问                  | 当前会话和此项目后续新建的会话将使用完全访问。执行本 Todo 定义的当前任务、Composer 和队列同步 |
| 4    | 拒绝                      | 拒绝本次操作，保留既有 Deny 行为                                                              |
| 5    | 告诉模型接下来应该怎么做… | 保留拒绝附带反馈的独立输入行及提交方式                                                        |

- 数字快捷键、上下键、Tab、Enter、焦点和确认按钮随实际选项排列更新。`5` 聚焦反馈而不提交，输入法行为和手机输入兼容保持。
- 反馈行仍以请求声明支持反馈为前提；不能为没有该能力的入口伪造反馈响应。
- 第 2 项继续展示 Agent 给出的真实 prefix/exact scope，不能仅因标题改为“此命令”就改变匹配或扩大授权。
- 文件、网络、MCP、官方 CUA 等共享审批面保留现有工具范围文案与可信能力组语义，不能全部改称命令。
- 完全访问不关闭 Plan；`yolo + planEnabled=true` 仍受现有规划工具规则约束。AskUserQuestion、ExitPlanMode 等用户问答不因新增选项被自动回答。
- 桌面和手机共享组件、语义及国际化；不凭选项序号推导协议响应。

## 3. 当前代码事实与问题

| 事实                                                      | 实施含义                                                     | 入口                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer 菜单只修改当前 scope 草稿                        | 直接复用菜单回调不能解除当前审批                             | [SessionPane](../../../../packages/ui/src/v4/SessionPane.tsx)、[useDraftConfigControl](../../../../packages/ui/src/v4/composer/useDraftConfigControl.ts)                                                  |
| 即时切换命令仍被 Bot、自动化、CLI/TUI 和兼容路径使用      | 不能视为死代码删除，也不能把审批批量同步推广到所有调用方     | [task adapter](../../../../packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts)、[session facade](../../../../apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts)                       |
| `app.setMode()` 更新 Runtime 后还写项目 `permission/mode` | 本次任务级授权不能直接继承项目偏好副作用                     | [session facade](../../../../apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts)、[runtime config](../../../../apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts)                      |
| 仅传 `mode=yolo` 会归一为 `planEnabled=false`             | 审批专用更新必须显式保留 Plan，不能盲改共享兼容解码规则      | [execution-state](../../../../packages/shared/src/execution-state.ts)                                                                                                                                     |
| 每个工具调用开始时读取 Runtime mode，已有审批等待 broker  | 运行中可切，但不自动解除 pending，不重做已经读取旧模式的调用 | [call-runner](../../../../apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts)、[permission-flow](../../../../apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts)                |
| 队列项携带独立 mode/Plan，消费时重新应用                  | 只改 Runtime 或 UI，下一条出队可能切回旧权限                 | [product projection](../../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts)、[turn-model](../../../../apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts) |

`permission/mode` 是创建 Agent 时的项目模式 fallback；`permission/ruleset` 是“始终允许此命令”的规则集合；Session execution state 和 Composer Recent 又是不同事实源。本 Todo 不把它们合并，不写项目默认或新增权限规则。

本轮用现有 `resolveExecutionState()` 实际执行确认：`build + Plan=true` 仅传 `mode=yolo` 后变成 `yolo + Plan=false`；显式携带原 Plan 才保持 true。本次实现已补充 Runtime、SQLite、broker/race、V4 投影和 UI 回归，实际验证结果见第 9 节。

## 4. 状态归属、队列边界与顺序

```text
Desktop continuous / Mobile replayable
  → 审批框选择“完全访问”（session + interaction + command identity）
  → 同一 Agent owner 校验请求仍有效，并协调应答胜者与队列出队顺序
  → 更新当前 Runtime.mode=yolo，保留 Runtime.planEnabled
  → 更新此时已接纳、尚未执行的全部队列项 mode=yolo
      每项保留原 planEnabled / modelSelection / content / order / delivery
  → 权威结果与队列投影同步给客户端
      对应 Session Composer 定向更新 mode=yolo，保留其余草稿
  → 放行当前审批请求，继续原 Turn
```

### 队列修改边界

- 以 Agent 接纳这次审批动作时的串行顺序确定受影响队列，覆盖运行期间的待执行输入、暂停/held 队列以及队列中尚未消费的 Guide。
- 与 reserve/promote/drain 协调，不能在批量更新期间让目标项拿旧配置启动；已开始执行的消息不倒退为队列项，也不重写历史提交记录。
- 修改真正用于执行的权威数据，并同步必要的输入记录与事件/投影，避免内存、查询或撤回编辑取到旧值。不能只改 renderer 展示或只改 snapshot。
- 更新后，自动出队、“立即发送”、撤回编辑使用更新后的 mode；队列 ID、顺序、暂停状态和其他配置保持。
- 这是一次明确更新，不建立永久覆盖层；后续新提交仍按自己的明确 Submission 和服务端接纳顺序处理。当前 Composer 同步后正常发送使用 yolo。

```text
Runtime：build + Plan=true  → yolo + Plan=true
Composer：edit + Plan=false → yolo + Plan=false
队列 A：build + Plan=true   → yolo + Plan=true
队列 B：edit + Plan=false   → yolo + Plan=false
```

### 审批、失败与跨端

- 以一次明确的审批动作收口切权限、改队列和当前应答，不由 UI 独立发送两个无关联命令并假定原子成功。
- 复用现有 Runtime 状态更新、interaction broker 和命令幂等机制。Agent 是队列与权限 owner；不在 Renderer、Host 或 Relay 新建第二份 accepted queue。
- 校验 interaction 与 task/session 归属。请求已拒绝、取消或被另一端处理时，迟到动作不能继续扩大权限；Hook 与用户应答竞争仍需保证唯一胜者。
- 状态保存、队列更新、事件提交任一步失败，要有可对账的结果与幂等重试路径；不能批准工具后才发现队列未完成更新。实施时明确提交点、失败恢复和故障注入证据，不用多个 `await` 冒充事务。
- Composer 由现有草稿 owner 定向处理这次明确结果，同任务跨端与重连避免重复应用；普通 snapshot 仍不得持续覆盖草稿。迟到结果不能修改其他 scope 或覆盖已经明确处理过的更新。
- 客户端按实际授权回执更新当前项目 Composer Recent 的权限；后续真实 Submission 被 accepted 时仍沿用既有 Recent 规则。
- 父任务承接子 Agent 审批时核对 origin、broker 与实际执行 Runtime 的归属，不能只改展示所在 Runtime 就声称 child 生效；其他任务及独立 child 的授权范围不凭静态调用关系扩大。需要改变既有继承契约时先记录具体影响。

## 5. 实施切片与兼容约束

- [x] 按最新基线读取目录规则、architecture-governance、runtime 边界及 tool change chain，确认协议、owner 和实际消费者；本轮调查不能代替实施前核对。
- [x] 在本 Working Memory 补齐审批动作的 schema、提交/恢复契约和最小状态矩阵，先补能证明预期的回归，再实现。复用现有契约的部分不创建重复接口。
- [x] Agent 实现保留 Plan 的任务级权限更新、待执行输入批量更新及审批应答编排；现有普通 mode API 的必要修复单独说明影响，不能顺带重写 Bot、自动化、CLI 默认行为。
- [x] UI 接入新增选项和对应 Composer 定向同步，更新快捷键、反馈行序号、i18n 及错误/重试显示。
- [x] 旧客户端/旧 Agent 的能力差异明确处理：未支持完整动作时不能显示可用入口或把未知选项误映射成普通允许；不让 legacy TUI/Bot 静默获得新批量语义。
- [ ] 关闭全部必要验证门槛后标记整体完成；当前实现、长期文档和已取得证据已更新，剩余基线失败/手机整链路见第 9 节。

仅批准当前请求是已确认范围；其他已经挂起的独立权限请求不能因为新权限自动消失而被假定已处理。本 Todo 不扩展为任务级授权选项、规则管理/撤销界面、Bash 匹配优化或项目默认模式清理。

## 6. 验收与证据计划

以下为已接受的验收边界；实际覆盖与未验证项见第 9 节，不能以用例存在代替实跑。交互用例按 e2e-case-lifecycle 维护，实施时与现行 case catalog/coverage matrix 协调，不覆盖工作区已有改动。

| Case     | 场景                                          | 必须证明                                                                                                    |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PA158-01 | 普通命令审批                                  | 五行顺序、默认允许一次、1–4 选项与第 5 行反馈导航正确；未声明反馈时不伪造输入                               |
| PA158-02 | build/edit 的运行中任务等待审批，选择完全访问 | 不停轮、不新增消息；Runtime 变 yolo，当前工具执行，后续新工具按新权限判断                                   |
| PA158-03 | Runtime、Composer、队列各有不同 Plan          | 所有目标 mode 为 yolo，分别保留 true/false；yolo+Plan 仍遵守规划约束                                        |
| PA158-04 | 多条普通队列、held 队列与未消费 Guide         | 全部目标项更新，配置/附件/顺序/暂停状态不变；自动消费和“立即发送”无旧 mode 回写                             |
| PA158-05 | 更新后的队列项撤回编辑                        | Composer 得到该项更新后的权限及原 Plan/模型/正文；其他队列项不变化                                          |
| PA158-06 | 批量更新与新提交、reserve/promote/drain 交错  | 按 owner 顺序确定边界；不漏目标项、不重复执行、不覆盖后接纳的独立用户选择                                   |
| PA158-07 | 多端点击、Hook 应答、拒绝/取消、ACK 丢失      | 唯一应答胜者，过期动作无提权，重试可对账且无重复副作用                                                      |
| PA158-08 | 保存/队列更新/事件提交故障                    | 不展示虚假全量成功、不提前放行当前工具，恢复或重试后事实一致                                                |
| PA158-09 | 普通菜单、允许一次、项目始终允许、拒绝/反馈   | 保持原行为；普通菜单不批量更新队列，项目规则 scope 不扩大                                                   |
| PA158-10 | 桌面、手机重连及 scope 切换                   | continuous/replayable 分开验证；同任务结果一致、草稿不被普通快照覆盖、不串 workspaceIdentity/session        |
| PA158-11 | 任务/项目偏好与共享调用方                     | 此动作只更新本端项目 Recent 权限，不写 Agent 项目 mode/ruleset，不改变其他任务；Bot/自动化/CLI 既有调用回归 |
| PA158-12 | 子 Agent 来源审批与旧版本组合                 | origin 路由与实际执行权限一致，未支持的完整动作不误放行、不扩大到无关任务                                   |

必要验证：根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响测试；CLI 按其子级规则执行独立检查。UI 覆盖桌面/手机、深浅主题与中英文，交互必须有对应 E2E；浏览器局部验证不冒充原生或手机远控整链路通过，未通过准入的用例不自动转正。必要检查通过后 diff 自检并仅提交本次改动，Push/MR 由用户另行触发。

## 7. 本轮交付与剩余问题

- 完全访问经原 `resolveInteraction`、registry、Runtime owner 和 SQLite 事务完成；工具在 V4 投影确认后放行。普通 mode API 保留项目偏好行为，本动作不调用它。
- UI 新增完整能力入口、五行键盘导航、错误重试及 Composer 一次性同步；撤回编辑保留授权处理标记。
- 旧 UI/旧 Agent 通过独立 `fullAccessOption` 字段保持兼容；child-origin 与独立问答/确认不声明不完整能力。
- 正式契约已提炼至 [权限审批文档](../../../permission-project-approval.md)；测试层级与缺口保留在覆盖矩阵，不将 pending 自动转正。
- 必要验证未全部通过前保留工作区，不自动 commit；原有不相关变更不包含在本 Todo 交付范围内。

## 8. 实施契约（2026-09-17）

### 影响摘要与入口

本次属于 presentation、validation、commit-effect、persistence、recovery；planning 后直接实施。

| 场景/入口          | 共享实现                                | 草稿/默认          | 校验与提交                                            | 权威/保存                                               | 边界与隔离                       |
| ------------------ | --------------------------------------- | ------------------ | ----------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| 桌面/手机普通审批  | PermissionDialog / V4InteractionDialogs | 默认允许一次       | Agent 声明 fullAccess 选项；resolveInteraction 原命令 | interaction registry → Runtime → session store 原子提交 | continuous/replayable 各走原链路 |
| 普通 Composer 菜单 | useDraftConfigControl                   | 独立 scope 草稿    | 原草稿回调                                            | Renderer 草稿                                           | 不批量改队列                     |
| 项目始终允许       | 既有 option builder                     | Agent prefix/exact | 原 permissionUpdates                                  | 项目 ruleset                                            | 不扩大规则                       |
| 子 Agent / legacy  | 原审批面                                | 原选项             | 暂不声明完整 fullAccess 能力                          | 实际 child broker                                       | 不误切父任务，不伪造 child 成功  |

必须检查：registry/broker 的唯一应答、Core 的 pendingInputs/held 投影、SQLite session_input 与 execution entry、V4 mode/queue patch、Composer 定向同步。需回归：Plan、Guide、reserve/promote、撤回编辑、Hook、命令重试。Bot/TUI/普通 mode API 为隔离不变量；相关单测是证据而非另一 owner。

代码图工具在本环境未提供，使用明确入口的直接引用检查代替；扫描深度限于入口→owner→保存/投影，不声称完成 codegraph 索引验证。现有功能图缺少普通审批完全访问的语义边，实施时补充；队列域映射中 renderer/host 持有 accepted queue 的旧描述与当前 CommandInbox owner 不符，不作为实施依据。

### 提交、竞争与恢复

- 复用 `resolveInteraction`，选项稳定 ID 为 `fullAccess`，不根据序号推导授权。只有具备原子保存能力的 Agent 为普通主任务权限请求声明；子 Agent、问答、Plan 审批以及要求独立工具确认的 workflow 不宣称支持。
- Registry 校验 session、请求类型和选项能力，取得应答权。Core permission responder race 提供 broker claim：Hook 已胜出则不能 claim；claim 后 Hook 退赛。失败仍保留审批，可显式重试/拒绝，不自动放行。
- Runtime 在同一任务内锁住目标队列的消费/提升，已有 Guide 消费或 reserve 时返回可重试失败，取已接纳且未消费的固定 ID 集合；CommandInbox 串行 admission 约束后来提交。保留每项原 Plan 和其他字段。
- SessionStore 的原子提交同时写当前 execution state、目标 session_input 权限及按 interactionId 去重的 receipt；使用现有表，不新增数据库结构。事务提交前失败不改变内存；提交后发布失败保留 receipt，重试只补内存/事件，不重新抓取队列或覆盖后来输入。后续模式修改和队列消费先补齐未发布的提交；投影失败重试从原日志重建，保留事件顺序。
- 单一 SessionModeChanged 事件携带明确 permission grant 标记和队列 ID，Core/V4 投影同步改变权限，原始历史提交不重写。ACK 之前等待权威投影；当前工具在全部更新成功后才得到 allow。
- Composer 只消费明确 grant ID，持久化已处理标记；每个 scope 只应用一次，保留自身 Plan，后续手动改选不被普通快照反复覆盖。重连读取同一 grant 标记；进程重启保留当前 execution state，队列仍遵守现有重启丢弃契约。

```text
resolveInteraction(fullAccess) → session FIFO → registry claim（Hook 退赛）
 → Runtime 队列消费屏障 → SQLite 原子 execution + inputs + receipt
 → Runtime 内存 + 单事件 → V4 config/queue → Composer 按 grant ID 应用一次
 → 当前 broker allow → 当前工具继续 → ACK/query 对账
失败（提交前）→ 保留原状态及审批；失败（提交后）→ receipt 重试补齐发布
```

### 维度、剪枝与验收交接

沿用 PA158-01…12：主维度为审批胜者、事务阶段、队列生命周期、各自 Plan、scope 与 delivery；不展开工具×模型全排列。用户已确认权限批量同步与 Plan 保留，不重复询问。子 Agent 未支持完整动作时剪掉 fullAccess，保留原审批并验证无父任务误提权；普通菜单/问答不进入本动作。

回归分层：SQLite 原子故障测试、Core/runtime/race、V4 schema/projection/handler、UI 草稿/导航；桌面 pending E2E 使用受控工具审批与排队窗口，手机 replayable 单独验证。未取得的运行证据仍标 pending，不自动转正。当前没有待用户决定的产品问题。

## 9. 实跑证据与完成门槛

本轮所有临时日志位于 `/tmp/zcode-todo158/`；测试文件与实际断言为可重放证据。

| 验证                                                           | 结果                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 根 `pnpm typecheck`、CLI `pnpm --dir apps/zcode-cli typecheck` | 通过；CLI 28 个任务成功                                                                    |
| 根 `pnpm lint`、`pnpm architecture:check --changed`            | 通过；lint 有原有警告，架构 0 违规                                                         |
| SQLite 事务 / 固定目标 / 回滚 / 取消 / task 隔离               | 3 项通过，`adapters/tests/permission-full-access.test.ts`                                  |
| Core 权限 / Hook claim / Plan                                  | 24 项通过，`permission-full-access`、`permission-responder-race`、`independent-plan-state` |
| Contracts event reducer                                        | 27 项通过                                                                                  |
| Bootstrap broker / registry / projection / 原审批链            | 120 项通过                                                                                 |
| Bootstrap 队列 reserve/promote/撤回                            | 34 项通过，`v4-native-queue.test.ts`                                                       |
| V4 continuous / replayable 提交后恢复                          | 新增 2 项通过；同文件另有 1 项旧 revision 基线失败                                         |
| UI 审批/快捷键/兼容能力/Composer                               | 67 项通过；1 项 SHARE32 基线失败已单独复现，定向结果不包含它                               |
| UI 队列撤回/Plan transition                                    | 22 项通过；新增回归先失败后通过，恢复队列项 mode/Plan/模型与 reasoning                     |
| Desktop E2E 类型与 fixture 检查                                | 通过；fixture 的队列文本只用于入队/撤回，不执行模型请求，因此 matcher 警告保留             |
| CLI lint                                                       | 未通过；基线同样存在 max-lines 错误（含 telemetry/debug/bootstrap 等），未顺带重构         |

基线隔离：在同 HEAD 的 `/tmp/zcode-todo158/baseline` 应用任务开始时保存的原有 patch 后实跑，复现 SHARE32、gateway 的旧 revision 断言、background notification 时序断言与 CLI lint 失败。本功能用例均另列；不能宣称整个仓库测试全绿。

尚未取得：手机 shared-host 的真实重连/跨设备重复点击 E2E、Windows/macOS 实跑。continuous/replayable 当前证据为同一 Gateway 的真实协议订阅与故障恢复单测，不冒充手机整链路。子 Agent 不投放完全访问已测试，未扩展其继承契约。

桌面实跑：Linux Electron `1/1` 通过，run `desktop-e2e-20260917101937381-p869276-572a8de9c7ed2705`，exit 0。原 Write 工具执行落文件、同轮输出继续、两条队列顺序和正文保留，撤回后分别为 `yolo + Plan=true/false`。E2E 揭示并修复既有撤回路径只恢复正文/附件的缺口：现在恢复项中已记录的 mode、Plan、modelSelection（含 reasoning），旧项未记录字段沿用现有草稿。测试通过真实 UI 完成首跑引导，等待受控 SSE 窗口，不伪造业务 snapshot；用例仍在 manual-review/pending。

共享组件浏览器实跑：`permission-full-access.test.mjs` **4/4** 通过，390/1200 × light/dark；390 使用中文及 `isWebRemoteControl=true`，1200 使用英文。验证五行文案、数字 5 聚焦反馈不提交、数字 3 + Enter 回传稳定 fullAccess ID、无横向溢出。截图在 `packages/desktop/.e2e-artifacts/permission-full-access-browser/`，只是共享组件/移动宽度证据，不替代真实手机 relay E2E。

原有未提交改动单独保留；重叠的 catalog/matrix 仅追加 PA158，Composer 草稿存储仅补授权处理标记。2026-09-17 用户明确要求合并最新 staging、提交、推送并创建 MR；按此要求交付，同时保留上述基线失败与手机整链路缺口，不将整体验收标为通过。

合并最新 `origin/staging` 后复验（2026-09-17）：排除原有未提交改动的实际交付版本，根/CLI typecheck、根 lint、architecture 通过；UI 79、Core 24、SQLite 3、Contracts 27、Bootstrap 审批/队列 154、Gateway PA158 2 项通过，浏览器四组合通过。Linux Electron 再跑 1/1 通过，run `desktop-e2e-20260917120736651-p895163-873605a2d4994754`。首次构建因本机 Zod 旧依赖被 staging 的版本校验拦截，对齐本地安装至仓库要求的 4.6.5 后构建及 E2E 成功；未改依赖清单或锁文件。CLI lint 仍为原有 max-lines 失败。功能图新增节点/seed/边校验无新增问题，已有两个缺失 endpoint（`capability.mcp-oauth-authorization`、`persistence.desktop-user-data-root`）另记为基线缺口。

发布前 `ZCODE_PRE_PUSH_BASE=origin/staging pnpm verify:pre-push` 通过（lint、architecture、变更测试及 related 受影响测试）。Zod 4.6.5 校验暴露的新增兼容测试缺少 `detail` 已补齐并复验；产品逻辑未因此变更。

### CR-01 / CR-02 修复复验（2026-09-17）

- CR-01：每次 fullAccess 尝试有独立失败通知，提交/投影失败会解除已进入等待的 legacy 应答或超时；重试建立新屏障，成功仍等待 V4 answer。新增失败前/后到达、resolve/reject、重试及取消回归；原实现先复现 8 项失败，修复后 broker/registry/原审批链 128 项通过。
- CR-02：恢复时清空旧授权标记，损坏、未来字段及跨 session receipt 记录诊断后跳过，历史和已保存 execution state 继续恢复；授权幂等重试仍严格拒绝损坏 receipt。恢复、授权、Hook race、独立 Plan 共 30 项通过。额外运行的 `runtime-unbound-resume` 有 1 项既有错误文案断言失败，已在未修改实现的隔离基线复现。
- CLI typecheck 28 个任务、根 lint、architecture 均通过。CLI lint 仍是基线 max-lines 错误。根 typecheck 本轮因 Node 堆内存耗尽未完成；扩大至 8 GB 及拆为逐项目检查后，仍在未修改的 services 阶段 OOM，不将其标为通过。
- Linux Electron 审批 E2E 1/1 通过，run `desktop-e2e-20260917130117737-p944581-034f7d67ab10c80c`，exit 0。原工具、队列、各项 Plan 与撤回编辑链路通过；手机 shared-host、跨设备 ACK 及 Windows/macOS 仍沿用上述未验证边界。
- 本轮日志为 `/tmp/zcode-todo158/cr-*.log`。用户明确要求修复并 push，按该指令提交本轮修改并保留以上验证限制；原 MR !2718 已合并，本轮修复属于原分支上的后续提交。
