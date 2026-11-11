# R3 合并后远程自动化用例矩阵

关联：[执行方案](r3-remote-automation-plan.md)、[准备度与实际记录](../archive/remote-r3/r3-remote-automation-readiness-2026-09-07.md)。

本表登记已接受语义下的候选实现合同，初始状态为 NOT_RUN / planned。**2026-09-08首批实际结果见[运行台账](../archive/remote-r3/r3-remote-automation-live-run-2026-09-08.md)**，其中部分首连/首发代表已实跑，不能据此将整行的全部动作或交叉组合标为通过。引用旧formal/pending case仅表示可复用材料；后续逐行关联实际spec、manifest、artifact与结果。

证据缩写：U=实际 UI/关键截图；P=进程/连接；R=协议/权威 runtime；N=请求/网络；F=正式 store/文件/数据库；L=相关时间窗日志。E 表示须经真实 Electron/浏览器操作；I 表示真实 store/协议/产物集成；E+I 表示两层各有独立证明。所有 GUI case 至少 U 加另一证据层。

环境名见执行方案。故障均在 E-ISO/E-SVC 专属环境；可控响应场景使用 replay，真实模型验收使用 live；用户已取消真实请求消耗上限，所有实际模型调用继续记录。S=进入 smoke；其余 accepted 行进入 full，SOAK 包单独执行。环境未就绪时保留对应 BLOCKED，不通过过滤发现机制从分母消失。

## 当前验收与历史记录

本表保留 R3A 稳定编号；历史 planned/NOT_RUN 和旧批次链接不是当前运行状态。
连接 UI 统一按[三屏向导](../architecture/remote-device-connection-ux-spec.md)与[项目导航](../remote/project-first-remote-navigation-spec.md)验收；
旧 connect-and-chat 操作不再执行。保留数据卸载重装沿用原身份与历史，独立环境替换才确认新身份，见
[Issue 08](../issues/remote-e2e-stability/08-reinstall-history-visible-in-new-device.md)。
各场景的实现/运行映射见[覆盖矩阵](conversation-session-e2e-coverage-matrix.md)与[SSH 指南回归](desktop-ssh-guide-regression.md)，
完整 soak 目标与较短 harness 档位的缺口见[测试方案](r3-remote-automation-plan.md)。

## A. 构建、安装与认证

| ID         | 级别/档位 | Setup                                                                                                  | Action                                                                       | Assertions                                                                                                                                                                                                                                                                  | 层 / 证据 |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| R3A-BLD-01 | P0/S      | 固定源码、干净输出、记录 dirty 摘要                                                                    | bootstrap:with-remote，WDIO 构建 Desktop                                     | 四个平台 descriptor/SHA/size/包内 manifest 自洽；构建顺序未采旧 runtime；记录实际活跃 Core/Agent 身份                                                                                                                                                                       | I/PFL     |
| R3A-BLD-02 | P0/S      | 未安装的独立 SSH 用户，已配置合法本地模型                                                              | UI 选择本地下载后上传、确认安装、打开目录                                    | 本轮 archive 经上传安装；Source/版本正确，首连同步成功才 ready；真实远端首请求                                                                                                                                                                                              | E/UPRNF   |
| R3A-BLD-03 | P0        | 已安装同版本旧 SHA；另备相同 SHA 对照                                                                  | 当前开发入口连接                                                             | 异 SHA 走更新并换实际进程；同 SHA 可复用；版本号相同不能绕过内容验真                                                                                                                                                                                                        | E/UPFL    |
| R3A-BLD-04 | P0        | 本地 descriptor/归档缺失、size/SHA 错误各独立 fixture                                                  | UI 发起本地下载连接                                                          | 明确失败，不回退使用未知旧包；无新 ready attachment；旧安装保持可对账                                                                                                                                                                                                       | E+I/UFL   |
| R3A-BLD-05 | P1        | archive 内 ESM CLI 与真实依赖闭包                                                                      | 执行包内版本 probe、首装和重启                                               | 无 yazl require(fs) 启动崩溃；CLI/Core 可实际运行；builtin config 不污染 immutable release                                                                                                                                                                                  | I/PLF     |
| R3A-BLD-06 | P1        | 目标不存在安装，或更新尚待确认                                                                         | UI 取消确认，再重新连接确认                                                  | 取消前无 release/service/Directory 提交；重试成功且无遗留 pending 会话                                                                                                                                                                                                      | E/URPF    |
| R3A-BLD-07 | P1        | 缺 user manager 的独立目标；重连前进入 systemd offline 环境                                            | 安装、断开桌面、终止 daemon 后重连                                           | detached、serviceRegistered=false；普通断开不杀 daemon；被跳过且返回 0 的探测不能误判可用；重连由 ensureDaemon 拉起新 daemon                                                                                                                                                | E/UPRL    |
| R3A-BLD-08 | P1        | E-SVC 可用 user bus；另有缺 XDG/DBUS 环境和 manager 读不到 server root（组列表过期、私有 /tmp）fixture | 分别安装启动；fallback 后重连、直接 serve --daemon；刷新组列表并停止后再连接 | 成功注册为 true；按既有能力探测恢复环境；装载阶段失败回退 detached、`serviceRegistered=false`、连接日志带原因且 unit 未启动；重连与直接 serve 复用同一 Supervisor/Core；环境修好后冷启动注册为 true                                                                         | E+I/UPRL  |
| R3A-BLD-09 | P1        | 隔离 /tmp noexec、缺 tar、缺进度工具、glibc<2.28、损坏 archive                                         | 分别执行安装                                                                 | staging 使用可执行 server root；tar 必需时早失败；glibc 过低只记 warn 并继续，注入低版本报告但 runtime 可运行时完成安装和项目绑定；真实 glibc 2.27 时安装失败，连接日志遮住路径但保留 ``version `GLIBC_2.28' not found``（old-glibc-runtime）；仅进度降级；不破坏旧 current | E+I/UPFL  |
| R3A-BLD-10 | P1        | detached 首连在线的 SSH 目标                                                                           | 设备卡「更多」停止远端服务，等一个重试周期后再连接                           | 危险确认回车不执行且说明含任务清单段；停止后未连接、Supervisor/Core 退出且锁释放、无残留 SSH；重试周期内不被拉起；再连接拉起新 Supervisor/Core（RDLC-01/#05）                                                                                                               | E/UPL     |
| R3A-BLD-11 | P1        | detached 首连在线、已有一轮对话的 SSH 目标                                                             | 设备卡「更多」重启远端服务，回到会话续发                                     | 期间只显示连接中；Supervisor/Core 都换代、仍为 detached、崩溃计数 0；设备回到已连接；已打开会话换代后可续发（RDLC-01）                                                                                                                                                      | E/UPRL    |
| R3A-BLD-12 | P1        | 首连在线；断开、停服后把当前 release 的 package.json 截为空                                            | 展开设备行后从错误条重新安装；再次损坏后从向导失败页重新安装                 | 两处在失败时出现、菜单常驻；确认 intent 为 source-server-reinstall；releaseId 不变、文件恢复、无 .damaged-_/.incoming-_；回到已连接并继续原连接（RDRI-01）                                                                                                                  | E/UPL     |
| R3A-CON-01 | P0/S      | 解析 linux-amd64-dev 的有效 target；正确密码在受控环境                                                 | UI 密码连接、选目录                                                          | 路径/RPC/identity 正确，一个 Window Host；敏感值不进 tab/日志                                                                                                                                                                                                               | E/URPNL   |
| R3A-CON-02 | P1        | 独立 sshd，无锁号影响                                                                                  | 错误密码失败后改正确密码重试                                                 | 有可读错误，无可用 logical session/Agent；重试不沿用旧 credential                                                                                                                                                                                                           | E/URPL    |
| R3A-CON-03 | P1        | 控制代理让首连接停在 pending                                                                           | 停止连接后立即重试同 target                                                  | 旧请求取消，迟到成功不发布；新请求使用新关联 ID，Host 保持正确                                                                                                                                                                                                              | E/URPN    |
| R3A-CON-04 | P1        | 同 target 的项目连接请求与独立向导等待者；共享 Source 的 A/B 项目                                      | 取消向导等待者，连接中移除 B 入口，再释放线路                                | 保留的项目连接请求不被取消；A 正常上线；B membership 不被迟到结果复活。移除入口不等于关闭已有 attachment；在线独立 Source 隔离另由 entry-attribution 覆盖                                                                                                                   | E+I/URP   |
| R3A-CON-05 | P1        | 同 Source 可通过两条 profile/alias 到达                                                                | 从不同 UI 入口连接、删除/切换 profile                                        | Source 不重复；identity 不变；恢复不使用已删线路；凭据按 profile 关联                                                                                                                                                                                                       | E/URF     |
| R3A-CON-06 | P1        | 仅测试连接禁止 forwarding 或中断 bootstrap/WS 字节                                                     | 连接/读取目录                                                                | 禁止转发时按主规格回退 proxy-stdio，完成握手、目录 RPC 与项目绑定；bootstrap/WS 中断有明确失败或恢复原因，SSH 登录成功不等于应用 ready                                                                                                                                      | E/URNL    |
| R3A-CON-07 | P1        | 独立受控下载端和本地代理；已知 SHA 当前 archive                                                        | 从对应部署入口下载上传                                                       | 证据证明代理路径、实际 archive、取消和缓存行为；不复用已退役 legacy component manifest 断言                                                                                                                                                                                 | E+I/UNFL  |

## B. Source、workspace 与 UI 隔离

| ID        | 级别/档位  | Setup                                                | Action                                        | Assertions                                                                                        | 层 / 证据 |
| --------- | ---------- | ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| R3A-ID-01 | P0/S       | 同 Source 两个项目 A/B，各有唯一历史 marker          | A/B 首发、交替续发                            | workspace identity/session 独立；请求只含自身历史；共享物理连接与 Host，无重复部署                | E/URPNF   |
| R3A-ID-02 | P0         | 两个 Source 使用相同绝对路径，加本地同路径哨兵       | 各自读写/发送/改 task 状态                    | 文件、任务、候选、缓存、持久化按 identity 隔离；无 local fallback                                 | E/URNF    |
| R3A-ID-03 | P1         | 同 Source 的 symlink 与 realpath、两个 profile       | 分别打开同目录                                | canonical workspace 不重复；历史对账；同 Source 不同线路允许独立 provisioning lane                | E/URF     |
| R3A-ID-04 | retired    | 旧远程无项目 UI 场景                                 | connect-and-chat 已停用                       | 历史编号保留；当前连接后选目录由 RPN 验收，旧结果不迁作通过                                       | 不适用    |
| R3A-ID-05 | retired    | 旧设备 task+ / conversation UI 场景                  | 远程无项目入口已停用                          | 当前项目身份隔离沿用 R3/项目导航，不恢复旧入口                                                    | 不适用    |
| R3A-ID-06 | P1         | 同 Source 项目 A/B 各有原 task                       | 移除本机 A 入口，B 续发，再加入原 projectId A | 只移除 membership，不关闭既有 attachment 或删除远端历史；A/B session 与 Host 保持，原 task 可续发 | E/URPF    |
| R3A-ID-07 | historical | 两窗口同 Source conversation 的旧场景                | UI 入口已停用                                 | 底层 canonical 与每窗口 attachment 隔离约束保留；旧 UI 用例不证明当前跨窗产品覆盖                 | 原 E/URPF |
| R3A-ID-08 | P1         | 新版活动目录 + 旧兼容投影，本地/远端项目混合         | 冷启动恢复活动目录，其他项目按需打开          | 保留 Host 项目入口；旧兼容字段不复活非活动 tab；按需打开后身份/凭据正确                           | E+I/URF   |
| R3A-UI-01 | P1         | known/pending/offline/connecting 项目与设备          | settings/sidebar/dialog 各入口连接/停止       | 连接后明确选择或加入项目；离线图标与可访问名称一致；连接中不重复派发                              | E/URL     |
| R3A-UI-02 | P1         | 多 Source tasks，在线/离线对照                       | pin/archive/open/resume、分组拖动和失败动作   | 写操作命中原 Source；离线 fail-closed；optimistic 失败回滚；分组持久化正确                        | E/URF     |
| R3A-UI-03 | P2         | zh-CN/light/desktop 与 en-US/dark/mobile 等 pairwise | 遍历连接、更新、无模型、恢复、设置关键状态    | 文案/主题/布局/焦点可用，viewport无关键操作遮挡；状态与权威事实一致                               | E/UR      |
| R3A-UI-04 | P1         | 首次持续运行说明尚未显示                             | 连接到目录页，关闭提示，再次打开              | 说明非阻断，不要求键盘确认；显示后写版本化 onboarding，不重复                                     | E/URF     |

## C. Provider Provisioning 与模型权威

| ID         | 级别/档位 | Setup                                                          | Action                                                                  | Assertions                                                                                                              | 层 / 证据 |
| ---------- | --------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| R3A-PRV-01 | P0/S      | 本地代表配置；目标配置/默认模型不同                            | 正常首连                                                                | 首次完整替换及 Registry refresh 后才 ready；逐字段摘要与真实请求正确，不仅 records 增长                                 | E/URNF    |
| R3A-PRV-02 | P0        | first apply 返回 failed/rollback_failed/unsupported 各 fixture | 首连                                                                    | 不发布 ready；原因明确、清理待建 lane/session；unsupported 不发 secret envelope                                         | E+I/URLPF |
| R3A-PRV-03 | P1        | 一个 Environment 已连接                                        | 打开第二项目与第二窗口                                                  | 同 Environment key 共 lane；无无意义第二首连写入；退出执行 Host 可由另一注册接管                                        | E+I/URPF  |
| R3A-PRV-04 | P1        | 两个在线 Source；同步 A 受 barrier 控制                        | 连续修改 Personal Config/规则/顺序                                      | 保存成功触发；single-flight + 最新尾随快照；各目标最终内容正确，非每事件排队                                            | E+I/URNF  |
| R3A-PRV-05 | P0        | 目标已有非空配置和默认模型                                     | 本地删除 provider、清空 Personal Config、保存/清除 default，各独立 case | 完整 replace；不保留被删镜像；保留失效默认，由 Host 推荐合法模型；空 Registry 无推荐；本机空配置不能被跳过              | E+I/URF   |
| R3A-PRV-06 | P0        | allowlist/non-allowlist 哨兵、两端不同 cipher                  | 本地保存/删除 allowlist 凭据并触发同步                                  | 目标重加密；同名删除传播；SSH/MCP/plugin 等非 allowlist 不变；无密文直接拷贝                                            | E+I/URFL  |
| R3A-PRV-07 | P1        | 目标有不同代理/locale/目录/Builtin                             | 保存账号窄字段并同步                                                    | 仅约定窄设置改变；其余设置与 Builtin Release 内容不变                                                                   | E+I/URF   |
| R3A-PRV-08 | P0        | 各写入阶段可控失败的真实 store fixture                         | apply 到账号/凭据/配置/default 后分别故障                               | 逆序恢复及内存 Registry 对齐；失败不记录成功；回滚失败明确 rollback_failed                                              | I/RFL     |
| R3A-PRV-09 | P0        | apply 已提交但 ACK 丢失；随后有新 sync                         | 用原 syncId 查询/重试，并重放更早完成 syncId                            | 返回原结果，不重新覆盖新数据；不重复副作用                                                                              | I/RNF     |
| R3A-PRV-10 | P1        | 损坏 JSON、未知 schema、allowlist 解密错误、读取期间变化       | 本地 source read / 首连                                                 | 明确失败，不能跳字段或部分成功；非 allowlist 损坏不阻断有效同步                                                         | E+I/URLF  |
| R3A-PRV-11 | P1        | 文件同时含无效 provider 与合法 provider；default两种状态       | 同步并读取目标 Registry                                                 | 完整 Personal Layer 保留；合法项可用、无效项 fail-closed；失效 default 原样落盘，Host 使用合法 Registry 推荐            | E+I/URNF  |
| R3A-PRV-12 | P1        | 连接成功后使后续同步失败                                       | 本地保存；修复条件后再次真实保存                                        | 本机保存反馈不伪报失败；连接保持，结构化 warning；无定时死循环；新触发成功                                              | E/URLNF   |
| R3A-PRV-13 | P0        | 同步 RPC 尚未返回时断开，离线期间本地多次改配置                | 自动/手动重连后发送                                                     | 旧 RPC 拒绝并释放 lane；新 session 同步最新内容；项目重连恢复各自 project sessions；已恢复 workspace 后续同步失败只告警 | E/URNF    |
| R3A-PRV-14 | P0        | 慢旧回合 Model A；配置 B 可辨请求体                            | 同步 B 完成后结束 A、同 Session 下一普通 turn、新 Session发送           | A静态配置保持；新 Model使用B；不能错误冻结整个Session；观察请求体而非仅UI标签                                           | E/URN     |
| R3A-PRV-15 | P1        | running下已 admitted queue，配置/selection各可辨               | 修改配置/selection后drain                                               | queue 的 selection按admission合同；新建Model读取更新后的静态Provider事实，来源ID/附件守恒                               | E+I/URN   |
| R3A-PRV-16 | P0        | 本地/远端模型候选不同；remote-waiting/旧响应可控               | 快速切tab、重连、从无模型横幅打开设置                                   | 对话读目标远端；不fallback本机/不采旧generation；设置编辑始终本地                                                       | E/URF     |
| R3A-PRV-17 | P1        | 激活Linux路径，存在/不存在可用本地workspace两类                | 模型设置连通性测试                                                      | 有本地cwd时在本地执行；无本地cwd时用本机对话目录在本地执行；不把Linux路径交本机Agent                                    | E/URPN    |
| R3A-PRV-18 | P1        | 同Source两条不同Environment key线路                            | 两线路连接、触发保存与接管                                              | 允许各自同步；事务不部分覆盖，最终配置一致；不强加按Source仅同步一次的未实施优化                                        | E+I/URF   |

Provisioning GUI 用例的 PRV-12 验收必须实际撤销隔离 Source 配置目录的写权限，证明本机保存成功、远端原配置保留、Main 产生带 Environment/trigger/status 的 warning、原会话不换代；保存事件收口后观察 10 秒无重试，再恢复权限并由新的真实保存下发完整最新配置。权限恢复放在 `finally`，不能把无故障的保存当作该失败分支证据。PRV-13 在删除配置时扣留 Desktop 产品 SSH 回包，先核对 Source 已提交且 Main 尚无完成结果，再断开；回放模型与控制探针走独立直连。旧 pending RPC 的拒绝还由 `packages/desktop/test/serverRemoteConnectionLifecycle.test.ts` 在真实 WebSocket/duplex 上验证。

## D. 远端开发与设置

| ID         | 级别/档位 | Setup                                                        | Action                                                                 | Assertions                                                                                               | 层 / 证据 |
| ---------- | --------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| R3A-DEV-01 | P0/S      | 远端独立repo/marker、本地同名哨兵                            | 文件树读写；终端pwd/写文件；刷新                                       | 实际执行在远端；watch/预览正确；本地哨兵不变                                                             | E/UPRF    |
| R3A-DEV-02 | P1        | 远端Git baseline与tracked/untracked文件                      | 修改、看diff/status、checkpoint/恢复代表                               | Git cwd与repo为远端；结果与控制连接复核一致；不修改用户项目                                              | E/URF     |
| R3A-DEV-03 | P1        | 远端terminal长命令、两个workspace                            | 切tab、断线恢复、关闭一个terminal                                      | 输出/PTY/cwd归属正确；不串workspace；按terminal合同回收，无孤儿资源                                      | E/UPRF    |
| R3A-DEV-04 | P1        | case-local文本/图片/PDF与可读取marker                        | UI上传并发送；远端工具读取                                             | attachment只落正确远端scope；请求引用可访问；无本机路径误用，取消/失败有明确状态                         | E/URNF    |
| R3A-DEV-05 | P1        | 远端音视频/图片fixture及媒体lease                            | 预览、range读取、断线/切scope再访问                                    | 内容/range正确；旧lease和其他scope不能误取；本地缓存生命周期可对账                                       | E+I/URNF  |
| R3A-DEV-06 | P1        | Source在线无project、另有选中project；八类设置各fixture      | 分别读写Skills/MCP/Plugins/Hooks/Subagents/Memory/Output/Settings-sync | 每类有独立子case；user/project落正确Source/store；本机不变；不是仅遍历tab                                | E/URF     |
| R3A-DEV-07 | P1        | 仅Source user-scope，无workspace；目标有合法Subagent模型候选 | 打开、选择模型/推理配置、保存并重开                                    | 正常显示目标模型并保存到正确Source文件；无workspace不能使合法候选不可用；静态接缝作为bug-candidate先复现 | E/URF     |

DEV-06 当前回归入口：远端项目激活时选择普通 User，
新建后本机 `agents/<name>.md` 存在、远端 user/project 同名文件不存在；按完整
workspace identity 选择远端项目后，新建只落各自 `.zcode/agents`。
DEV-07 的显式 Source User 必须独立验收，不得用菜单中最后一个 `default` workspace
冒充远端 User；该入口缺失时记录未覆盖，不改变 DEV-06 的本机 User 断言。
| R3A-DEV-08 | P1 | MCP/Skill/Plugin/Hook代表各有运行marker | 远端调用工具/执行一回合后切Source | 实际能力来自目标scope，输出/文件/执行日志正确；非Provider配置不被自动同步覆盖 | E/UPRNF |
| R3A-DEV-09 | retired | Repo Wiki 已整体移除 | 原远端生成/取消专项不再适用 | 随服务、UI 与测试入口退役，不计为当前覆盖 | 不适用 |
| R3A-DEV-10 | P1 | 明确远程文件本地打开/导出入口 | 触发下载/本地应用动作及取消 | remote读取与local platform动作职责分明；导出内容匹配；无非法远程路径本地执行 | E/URNF |

DEV-10 证据拆分（2026-09-24）：`file-local-actions` 验证远端读取、剪贴板、文件管理器门禁，
并在原生平台通过 VS Code CLI 录制夹具核对完整 Remote-SSH 文件 URI。Linux 的产品实现没有
编辑器候选，只能验证禁用态，不能作为原生编辑器正向证据。
`media-preview` 在重连后的图片预览中执行真实下载和取消：源端图片 SHA-256 与本机保存字节一致，
取消保存不得覆盖已有本机哨兵文件。两者共同覆盖 DEV-10，不能用 Markdown 文件树没有导出菜单
来跳过导出验收。这些补强仍需对应平台和服务器的实际复验，不能仅据新增断言计为完成。

## E. 对话与运行控制

| ID          | 级别/档位 | Setup                                      | Action                                                  | Assertions                                                                           | 层 / 证据 |
| ----------- | --------- | ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------- |
| R3A-TASK-01 | P0/S      | 配置完成，确定性文本+工具回放              | 首发、流式输出、工具调用、完成、续发                    | UI/协议/实际请求对应；工具真实远端执行；history与task身份一致                        | E/URNF    |
| R3A-TASK-02 | P0        | 可控running窗口                            | stop；busy连续输入；queue编辑/删除/reorder/send-now分项 | 单CommandInbox、FIFO admission；来源commandId/附件守恒；stop及reservation无丢失/重复 | E+I/URNF  |
| R3A-TASK-03 | P0        | permission阻塞、elicitation阻塞各fixture   | 各自允许/拒绝/回答/取消                                 | 真实blocking request ID唯一响应；UI清除与CLI继续/失败对应，无跨task处理              | E/URNF    |
| R3A-TASK-04 | P1        | 含工具历史的已完成session                  | edit/retry/fork分别操作合法目标                         | 远端历史/子会话/请求上下文正确，不串Source；运行态非法目标按guard拒绝                | E/URNF    |
| R3A-TASK-05 | P1        | 可compact历史及goal verifier受控           | 手动/自动compact代表、goal暂停/继续/结束代表            | 远端active-work状态与阻塞/queue行为正确；不重复调用/丢队列；遵守现行对话合同         | E+I/URNF  |
| R3A-TASK-06 | P1        | remote task存在子Agent/辅助会话            | 打开子会话、继续、父task停止                            | 同Source、独立session与正确owner；父/子状态按规格收口                                | E/URPN    |
| R3A-TASK-07 | P0        | command已admitted，ACK经代理丢失           | 重连/commands-query/用户重试                            | 原输入唯一归属queue/guided/transcript/显式终态；无重复副作用或silent drop            | E+I/URNF  |
| R3A-TASK-08 | P1        | token/error/truncated-stream/慢响应fixture | 远端请求失败后重试或切模型                              | 明确错误与可恢复操作；无假completed/永久running；保留用户输入和历史                  | E/URNL    |

## F. 断线、重连与冷恢复

| ID         | 级别/档位 | Setup                                                         | Action                                                          | Assertions                                                                                                                 | 层 / 证据 |
| ---------- | --------- | ------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------- |
| R3A-REC-01 | P0/S      | A/B在线，独立模型响应通道，远端running                        | 中断产品SSH连接，再恢复                                         | daemon/任务继续；connection unknown不等于task failed；sibling按组换代恢复，文件/历史正确                                   | E/UPRNF   |
| R3A-REC-02 | P1        | retrying、或旧online快照可迟到                                | 用户显式断开                                                    | 收口offline，停止恢复flight；迟到成功不重开；open history保留                                                              | E/URPL    |
| R3A-REC-03 | P1        | 网络持续不可用，控制恢复时机                                  | 观察重试预算耗尽、离线探测，再恢复网络                          | 按已定2/4/8秒和三次预算进入明确终态；探测不弹交互；恢复后无多连接                                                          | E+I/URPN  |
| R3A-REC-04 | P0        | A/B 已打开、断连；活动 B 已持久化，凭据可静默取得             | 完整重启 Electron/Main/Host，不点重连；B 恢复后从项目入口打开 A | 活动 B 自动恢复且不抢焦点，其他项目入口保留；A 按需打开后双方原 task 可续发；稳定 identity、新 session、一个新 Window Host | E/UPRNF   |
| R3A-REC-05 | P1        | 8 天前在线的 Source；密码未存/需安装/需升级/迁移冲突各fixture | 冷启动自动路径                                                  | 不按年龄排除保存连接，按最近在线排序；需交互时停止，不弹未授权交互/假ready/无限重试；合法用户动作后可恢复                  | E+I/URF   |
| R3A-REC-06 | P1        | running与两个opened workspace                                 | 仅renderer reload                                               | Host/物理连接复用；订阅与projection按当前规则恢复；不能用此代替完整App重启证据                                             | E/UPR     |
| R3A-REC-07 | P0        | E-ISO记录准确Core/Agent身份，已admitted未执行输入             | 分别kill Core或Agent并重连                                      | 区分transport loss与runtime restart；不自动续跑；遗留输入显式discarded；已完成历史保留                                     | E/UPRF    |
| R3A-REC-08 | P1        | 新session已发布，旧端口/请求回包被hold                        | 释放旧close/旧响应                                              | 新服务未被删；旧generation不覆盖当前状态；pending RPC明确拒绝/释放                                                         | E+I/URP   |
| R3A-REC-09 | P0        | permission与elicitation各阻塞                                 | Desktop自动恢复、Desktop手动恢复两路径分别断连/恢复/响应        | 每个组合独立断言snapshot恢复同ID；解决后清除，CLI继续，无第二response                                                      | E/URNF    |
| R3A-REC-10 | P1        | 历史 conversation/project entries，部分 purpose 记录缺失      | Source 更新、active-first 恢复                                  | 新版仅恢复活动目录，其他项目按需打开；旧设置导入仍验证 active-first；历史 purpose 与远端数据不误删                         | E+I/URF   |

R3A-REC-04 按[当前冷启动合同](../remote/desktop-remote-session-renderer-reattach.md)验收：
`lastActiveWorkspace` → 活动目录自动恢复；用户打开其他项目 → 创建对应工作区 attachment。
[2026-10-12 最终复验](../issues/remote-e2e-stability/15-cold-start-open-workspace-siblings.md)中
`coldreconnect` 已通过；对应 E2E 仍为 pending，待人工复核，不改变转正或 CI 准入状态。

R3A-REC-08 的证据分两层：桌面 E2E 扣留真实 SSH 回包，让 Source 完成受控回合，确认旧桌面尚未收到最终回复；自动换代后恢复最终回复和 idle，再释放代理，并分别核对实际写入与旧 socket 退役丢弃的字节数。退役丢弃不能算作迟到回调已送达。应用层乱序由 `packages/desktop/test/sourceServerConnectionManager.test.ts` 调用真实连接管理器验证：新 owner 发布后，旧 close 及旧恢复成功回调不能删除或替换新 owner，旧结果必须释放。代理自身另以真实 TCP 测试验证转发、退役丢弃和延迟 EOF。

## G. 版本与迁移

| ID         | 级别/档位 | Setup                                               | Action                                       | Assertions                                                                                               | 层 / 证据             |
| ---------- | --------- | --------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| R3A-UPG-01 | P0        | 认证的旧Server，无当前兼容能力                      | 当前Desktop连接并按门禁更新                  | 先识别需升级再archive更新，不向旧端发secret/provisioning；新Core可首连                                   | E/UPRNF               |
| R3A-UPG-02 | P1        | Desktop旧于不兼容Server                             | 旧Desktop连接对应路径                        | 主动作升级旧端，不自动降级新Server；用户二次确认后才可切到本机版本，被切回的Server不被自动升级           | E+I/URF               |
| R3A-UPG-03 | P0        | Server有running task，目标新archive                 | 普通更新被guard，再明确force更新             | 普通失败保持可用；force中断合同明确；Supervisor/Core/Agent目标release一致再applied                       | E/UPRF                |
| R3A-UPG-04 | P0        | 下载/解压/原子切换/进程启动阶段可控故障             | 逐阶段更新失败后重试                         | 原current/数据可恢复，失败无假online/applied；无垃圾release占用或混版本存活                              | E+I/UPFL              |
| R3A-UPG-05 | P0        | 固定8009d8cd08旧环境生成Provider配置/selection/历史 | 迁到当前版并首连、续发                       | 原配置意图正确迁移，旧字段不阻断合法路径；首连/实际模型请求/历史对账                                     | E/URNF                |
| R3A-UPG-06 | P0        | 认证旧版程序自然生成route-derived项目与任务         | 升级并通过alias/不同profile打开              | 控制端stable identity、远端canonical映射正确；单线路历史不丢；不重写为R4清洁key                          | E+I/URF               |
| R3A-UPG-07 | P0        | 多线路历史含重复/冲突及每phase中断fixture           | merge/resume/abandon/retry分别执行           | 全对象对账、ledger/backup、workspace粒度fail-closed；失败不推进后续重键；不局部假完成                    | I/RF；GUI报告代表另验 |
| R3A-UPG-08 | P1        | 单线路升级前封存历史与旧Desktop                     | 用旧Desktop经其支持链路回退/混连，继续同历史 | 历史与后续数据一致；多线路窄边缘按规格单列，不误承诺所有旧视图自动恢复                                   | E/URNF                |
| R3A-UPG-09 | P1        | 专属安装，有config/旧散资产/用户数据哨兵            | uninstall、核对preservedPaths、重新安装      | allowlist删除运行资产；config和installationId保留；原设备/项目历史可续聊；独立环境替换另验身份确认与隔离 | E+I/UPRF              |

## H. Mobile、平台与边界

| ID             | 级别/档位 | Setup                                                         | Action                                                                  | Assertions                                                                               | 层 / 证据                                                                                                          |
| -------------- | --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| R3A-MOB-01     | P0        | Desktop已有SSH/local scope，本地web与匹配relay环境            | 实际QR配对，手机viewport选择SSH task                                    | 配对成功、source/task正确；已有Host/SSH/Agent数量不增加                                  | E/UPRN                                                                                                             |
| R3A-MOB-02     | P0        | 桌面/手机同时观察running task                                 | 手机断网/限速/恢复                                                      | mobile独立replayable gap/snapshot恢复；desktop continuous持续推进，不清健康topic         | E/URN                                                                                                              |
| R3A-MOB-03     | P0        | Desktop/phone同task busy                                      | 两端交替输入、同时stop/send-now/回答blocking代表                        | 同一CLI FIFO，commandId/owner正确；单次reservation/response，无丢失或重复                | E/URNF                                                                                                             |
| R3A-MOB-04     | P0        | permission/elicitation各pending，手机attachment失效           | 重建手机bridge并回答                                                    | 恢复同blocking ID；解决后各端清除；不创建独立runtime                                     | E/UPRN                                                                                                             |
| R3A-MOB-05     | P0        | 已配对手机，知道channel名称                                   | 经真实trusted attachment尝试terminal/management/provisioning与scope伪造 | 服务端拒绝，底层effect为0；允许的model/media facade仍可用；clientMode不可伪造            | E+I/URNF                                                                                                           |
| R3A-MOB-06     | P1        | Desktop/phone attached，Source更新换代                        | 更新重连并恢复手机                                                      | Desktop先恢复；phone用新identity/session；phone恢复失败不dispose桌面                     | E/UPRN                                                                                                             |
| R3A-MOB-07     | P1        | 手机无所需已建workspace attachment                            | 选择设备/新建远程对话                                                   | 明确提示/门禁；不为手机创建新SSH/Host/Agent，已有桌面正常                                | E/UPR                                                                                                              |
| R3A-TRN-01     | P0        | 独立Docker target，当前正确平台archive                        | Desktop Docker入口安装、首发、关闭重连                                  | 真proxy-stdio与完整RPC；binary roundtrip、identity与Provider合同一致                     | E+I/UPRNF                                                                                                          |
| R3A-TRN-01-UID | P0        | 独立 Docker 容器，UID/GID 10001，passwd 无用户条目，可写 HOME | Desktop Docker 入口首装并打开项目                                       | Core ready；server-info.osUser 为 uid:10001；安装 UUID 与工作区身份一致；passwd 仍无条目 | E+I/UPRN；r3-docker-transport pending；2026-10-20 macOS → Linux arm64 PASS，run local-docker-20261020151240-63b1f0 |
| R3A-TRN-02     | P0        | Windows + WSL2 + current archive                              | WSL入口安装、首发、关闭重连                                             | 真WSL路径/stdio/进程清理；共享权威边界一致；缺Windows BLOCKED                            | E+I/UPRNF                                                                                                          |
| R3A-TRN-03     | P1        | 四平台archive                                                 | 校验并在对应可执行平台运行CLI启动代表                                   | 静态校验与运行结果分开；x64模拟结果注明emulation；无原生平台不能填native PASS            | I/PFL                                                                                                              |
| R3A-SEC-01     | P0        | 独立ingress，过期/错误/已消费capability ticket                | HTTP/WS握手及ticket重放                                                 | 鉴权失败先于业务RPC；loopback位置不代替token；secret不进日志                             | I/RNL                                                                                                              |
| R3A-SEC-02     | P0        | 全流程使用合成canary，真实凭据记录只留存在性                  | 收集UI/日志/RPC/artifact并审计                                          | secret明文不进入这些证据；合法Personal store明文与credential cipher分别按合同检查        | E+I/URLF                                                                                                           |
| R3A-SEC-03     | P1        | large/fragmented frame、CRC/乱序/缺片fixture                  | 通过transport/订阅发送                                                  | 不部分apply；正确resync/上限；坏mobile frame不破坏desktop sibling                        | I/RN；mobile代表E                                                                                                  |

转正回放的 MOB 与双端 soak 使用既有本地账号/Relay V2 fixture 和真实 Web 页面，Desktop、Web 指向同一隔离服务。仅替换外部登录与 relay 服务；真实 SSH、Source Server、Host attachment、端到端加密与 continuous/replayable 链路仍由产品实现完成。不依赖开发者登录态，也不将其当作线上 relay 可用性验收。共享固定 Web 端口的用例必须串行执行。

### 使用量与对话来源回归

| ID         | 级别/档位 | Setup                                                                                  | Action                                     | Assertions                                                                                                                               | 层 / 证据 |
| ---------- | --------- | -------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| R3A-TEL-01 | P1        | 隔离report捕获器；local/SSH task与connection lifecycle；远端conversation telemetry合同 | 各自发送、连接/重连，切tab并重建attachment | agent_step等事件的workspace_kind/remote_kind与实际来源一致；不串分类、不重复上报；上报失败不阻断产品；日志/事件不含host/secret等越界字段 | E+I/URNL  |

该行对应合并前R3的远端事实转发与local/remote分类修复，复用SSH P0中的report inventory断言；使用当前 `docs/monitoring/conversation-telemetry-v4.md` 合同，不把较早使用量文档的“尚无自动恢复”历史表述作为当前行为。

## I. 真实模型与长稳

| ID          | 级别/档位 | Setup                                                  | Action                                     | Assertions                                                                              | 层 / 证据 |
| ----------- | --------- | ------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- | --------- |
| R3A-LIVE-01 | P1        | 选定现有API Key代表导入隔离profile，请求记录入口启用   | 本机保存→真实SSH同步→远端首发/工具/续发    | 真实endpoint/provider/model/auth类别、远端工具效果正确；不经replay；请求与usage完整记录 | E/URNF    |
| R3A-LIVE-02 | P1        | 选定账号/Coding Plan代表，登录/权益可用                | 本地账号窄设置和凭据provisioning后远端请求 | 远端正式store解析鉴权，实际请求成功；不靠Desktop每请求在线注入；无权益BLOCKED_ACCOUNT   | E/URNF    |
| R3A-LIVE-03 | P1        | live凭据可用；静态变更/重连代表                        | 同步后下一回合、断线恢复后新请求           | 命中期望模型；辅助/重试也计数；额度/限流返回如实记录，不能改用replay冒充                | E/URN     |
| R3A-SOAK-01 | P1/soak   | 两Source×两项目+conversation，replay                   | 50轮连接/断开/恢复/开关tab                 | 每轮可继续执行；owned资源在相同静止条件回到基线，无旧generation误写                     | E/UPRFL   |
| R3A-SOAK-02 | P1/soak   | Desktop continuous + Mobile replayable同时运行，replay | 2小时流/工具/输入与手机恢复                | 无挂死/丢输入；资源趋势可解释；production生命周期日志不随chunk量刷盘                    | E/UPRNL   |

2026-09-08用户明确“不需要控制消耗”：取消20次总上限及8/8/4分配，真实请求按验收覆盖需要执行，不因人为次数或费用预算缩减覆盖。控制器必须能计数所有实际模型调用，否则 live 包先 BLOCKED，不依据发了几条聊天消息推算请求数。账号刷新/权益网络请求另记录，不能误称为模型请求或隐藏自动重试。

## J. 旧用例映射与实现优先级

R3-REMOTE-01～15（含子 case）的稳定编号与 setup/action/assertion 由 [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) 承载；原《R3 Source Server 发布测试方案》已归档到 [docs/archive/remote-r3/](../archive/remote-r3/r3-source-server-release-test-plan.md)，其中的「当前自动化状态」列不再维护，当前状态以本表与 [全量重跑记录](r3-remote-full-rerun-2026-09-10.md) 为准。

| 新合同      | 可复用材料                                                               | 必须补齐                                                                       |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| BLD/CON     | SSH-P0-CONN-01/02/03/04/05、CLI verify-remote-ssh、release manager tests | R3本地archive/进程证据；旧CONN-04仍测legacy manifest的内容须重写，不能照搬     |
| ID/TASK/PRV | SSH-P0-TASK-01/02、project-conversation-scope                            | 逐字段/实际请求证明；多Source同path；不以provisioning records数量替代正确性    |
| DEV         | SSH-P0-DEV-01/02/03、Source settings focused tests                       | 先装Git到专属环境；八设置写入断言；附件/媒体/能力实际执行                      |
| REC         | LIFE-01/02、offline-icons、cancel-retry pending                          | 替换旧zcode-server.cjs PID归属；冷重启真实到达恢复断言；blocking各交叉独立验证 |
| UPG         | R2 CLI tests、identity migration SQLite tests                            | 旧程序自然造数与真实GUI升级/回退，不能用空runtime archive当旧版                |
| MOB/TRN     | shared-host/allowlist/stream合同、Docker/WSL verifier                    | 新增浏览器真实配对与relay编排；区分SSH容器/原生Docker transport/WSL            |
| LIVE/SOAK   | reporter/recorder、provider真实请求入口                                  | 实际请求与usage记录，资源/日志趋势，success代表录像与远端证据                  |

实施顺序：H1/H2/H3 → smoke → PRV/ID/REC → DEV/TASK/UI/UPG → H4/MOB/TRN/LIVE → SOAK → 证据审计。目录/fixture建立遵循 e2e-case-lifecycle，不先把 planned case 放进 formal default glob。

## K. 剪枝、未定义与风险候选

| ID       | 分类                        | 范围                                                  | 理由 / 代表证明                                                                                     |
| -------- | --------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R3A-P-01 | pruned                      | 每个业务×所有transport×主题×语言全排列                | SSH深测共享业务；Docker/WSL实际代表；UI pairwise，ID/PRV/MOB边界不删                                |
| R3A-P-02 | pruned                      | 每种迁移数据库phase都重复Electron                     | 真实SQLite集成覆盖各phase；UPG-06/07另有GUI报告/真实自然数据代表                                    |
| R3A-P-03 | pruned                      | 所有Provider/model/权益组合均打真实请求               | LIVE两类接入代表；按协议与行为等价类选择，PRV参数/故障/事务使用可控响应以准确触发状态，不以消耗剪枝 |
| R3A-P-04 | pruned                      | 将同Source不同profile同步次数固定为1                  | 当前lane按Environment key；PRV-18验最终内容与事务，ID-03验稳定Source                                |
| R3A-P-05 | pruned                      | 远端cron、手机新runtime、R4清洁key、崩溃后自动续跑    | 当前不支持/禁止；必要负例仍由MOB-07/REC-07/UPG-06验证                                               |
| R3A-U-01 | undefined                   | 所有workspace关闭后Source idle TTL                    | 当前规格未定；只验关闭不丢数据/不伤sibling，不断言具体TTL                                           |
| R3A-U-02 | undefined                   | 多窗口所有角色切换与自动重连产品行为                  | 不扩大一般性承诺；已明确跨窗lane与RCONV-16分别PRV-03/ID-07                                          |
| R3A-B-01 | bug-candidate               | 无workspace的Source Subagent模型服务接缝              | 静态风险未实跑；DEV-07先取得运行证据，不能将当前异常直接写成期望                                    |
| R3A-B-02 | bug-candidate               | 旧配置matchRules阻断首连的历史记录                    | 旧运行记录不等于当前复现；UPG-05钉版本造数据验证，失败归因产品或fixture                             |
| R3A-I-01 | ignored-current-environment | Windows原生Desktop、iOS/Android实机、独立WAN/公网丢包 | 平台/网络资源尚未提供或确认；独立登记缺口，不宣称被容器/browser覆盖                                 |

候选状态与执行状态分开。后续因发现新变更新增case时保留稳定ID、记录来源并更新change-map；不得为了分母变小将失败行改成pruned。

## R3A-BLD-04/06 故障注入合同修正（2026-09-11）

`r3-install-faults` 必须按 A（未安装）和 B（已安装对照）各自远端 `uname -s` / `uname -m`，复用远端环境归一化函数，在 release descriptor 中唯一匹配 `target`，再使用该条目的 `fileName`、SHA 和 size。不能硬编码 x64 包，也不能推定两台目标架构相同。

```text
remote platform/arch -> descriptor target -> case-owned staged file
                                              | inject -> UI assert
                                              + finally -> restore original file
```

B 首装后先通过设备菜单显式断开，并等待同一 workspaceIdentity 的 remoteSessionId 清空，再经侧栏切回本地草稿；在线复用已有会话不会重新校验本地产物，不属于本故障场景。

case 是隔离 staged 文件的唯一写入者。缺失、等长 SHA 篡改、descriptor size 篡改和已安装目标保护均必须命中实际使用的条目；原有明确错误、无新安装、旧安装不变、单 Host、取消后重试成功断言保留。每次注入通过 `finally` 恢复原文件，包括断言失败；恢复不能污染硬链接指向的源包。取证记录 fault、target、fileName、预期错误、远端安装和 session 状态；意外关闭向导时先保存这些事实再报错。

此修正仅涉及 Desktop E2E fixture 与报告，不改变产品连接状态、workspace identity、desktop continuous 或 mobile replayable 链路。新增回归检查覆盖 ARM64/x64 与 macOS 架构归一化、缺失条目拒绝、故障后文件及硬链接源恢复；完整 BLD-04/06 仍以 GUI E2E 实跑为准。

2026-09-11 14:43 修正后完整 GUI E2E PASS（macOS arm64 → Linux arm64 A/B）；对应记录见 `r3-remote-full-rerun-2026-09-10.md` 的复核章节。

## 2026-09-15 SQLite 迁移重开写锁回归

本次回归沿用 R3A-P-02 的分层：
`packages/services/test/remoteSchemaMigrations.test.ts` 新增 Controller 无源行重连、Source
管理查询、已有 alias 的 session 解析三例，真实 WAL 双连接持锁下验证成功返回及 checksum
拒绝；均先复现后通过。REC-04/09 的 GUI 重连操作合同未改，本次未重跑 GUI E2E。

R3A-PRV-16 候选复审（2026-10-17）：合并模型菜单默认只显示当前供应商；读取候选前必须打开供应商列表，再按实际可见分组判断本地新增项。等待远端菜单使用控件就绪条件，不用固定暂停反复开关。

R3A-UI-04 候选复审（2026-10-17）：应用重启后以两条原项目行的 Source 在线状态为恢复前置，再通过真实目录入口确认介绍页不重复。后台空项目无需持有前台 workspace attachment，不能把其 `remoteSessionId` 当作设备连接成功条件；仍验证密码持久化和目录实际读取成功。

R3A-TASK-07 候选复审（2026-10-17）：故障必须发生在真实输入命令即将发出之后。先在 Renderer 的 RPC 出口暂挂带本例 marker 的 `sendConversationCommandV4`，允许此前的握手和配置查询正常完成；再扣住现有 SSH 连接的远端回包，并释放原命令一次。以实际 Provider 请求证明 admitted，以代理实际缓存字节证明回包被扣住。恢复后仍检查请求、用户消息、助手回复各一次和后续未发送草稿保留，不用固定暂停制造时序。

```text
点击发送 → 前置 RPC 正常完成 → 原输入命令暂挂
                                   ↓
                       SSH 回包开始扣留 → 释放原命令一次
                                   ↓
                       Provider 接收 → 连接换代 → 释放旧回包
                                   ↓
                       原输入唯一归属；后续草稿仍保留
```

R3A-TRN-01 候选复审（2026-10-17）：Docker transport 的 Provider 响应使用本例独立回放。容器内真实 Agent 通过测试专用反向 HTTP 隧道请求 replay server；SSH 隧道只搬运 Provider HTTP，Desktop 连接、安装、RPC、身份与重连仍必须走 Docker transport。以实际请求记录和远端模型日志证明首发，不再读取个人真实账号；真实云模型接入仍由 LIVE-01/02 独立覆盖。

SSH-GUIDE-SHARE 候选复审（2026-10-17）：先准备已恢复的本地合成账号，再建立远程项目和真实历史，最后写入不同远端账号验证分享请求权威。该场景不包含“建立匿名历史后切换本地账号”；本地账号播种与冷启动须位于任务创建前，避免把账号切换后的历史恢复混入分享授权前置。

SSH-GUIDE-EXIT / SSH-P0-LIFE-01（2026-10-19 用户确认）：完整退出后的启动导航进入原项目草稿；从任务列表手动打开原任务，再验证远端完成结果、请求唯一性和续聊。应用运行期间的断线重连仍保留当前任务选择，不与冷启动混用。
