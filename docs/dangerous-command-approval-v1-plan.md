# Guarded 权限模式 V1

## 批量删除补充（2026-09-24）

仅扩展识别层，不重构审批核心：rm 递归或明确批量、CMD rd/rmdir /s、CMD del/erase、find -delete、Git clean 有效 force、Windows Robocopy /MIR 或 /PURGE。rm 的递归与批量共用原 ruleId，其余新增 ID 见下方目录。

- rm 不再要求 force；至少两个目标或未引用/未转义 glob 也确认。不检查文件存在、重复、glob 展开数量。单个普通文件、单个纯动态目标、引用/转义的字面 glob 不新增确认；`rm -- -r` 不命中，`rm -- -r -f` 因两个目标命中。帮助/交互选项不能取消已知危险证据。
- CMD 开关不区分大小写；rd/rmdir 需 `/s`，del/erase 有目标即确认；无目标及独立 `/?` 查询不命中，`/p` 不能代替单次审批。POSIX/Git Bash 的空目录 rmdir 不纳入。
- find 仅 POSIX/Git Bash：按已声明 arity 跳过谓词与输出参数，`-exec/-execdir/-ok/-okdir` 载荷只跳过，不递归匹配；未知 arity 停止分析，保留此前可靠的 `-delete` 命中，不推断表达式是否实际匹配。
- Robocopy 仅 CMD/Git Bash：可靠定位的 `/L` 列举不确认；`/JOB` 文件不展开，未知参数不能生成列举豁免。Git clean 取消必须有 `-d` 或 pathspec 的条件，保留原帮助、dry-run 与取消顺序。
- 逐词事实增加内部 `hasUnquotedGlob`，保留原 dynamic/位置语义；方言传到规则调度，不把 POSIX 路径或 rmdir 按 CMD 解释。
- 仍排除 PowerShell、brace/变量/命令替换展开、脚本、隐式配置、rimraf/shred/truncate、远端删除、Git 局部回退；wrapper 仍仅 env/time/sudo，xargs/find-exec/npx 不扩展。未命中/unsupported 沿原策略，不表示安全。
- 匹配器只作用于 Bash：MCP 工具（含 node_repl 的 `js`）不经过它，Guarded 下按 YOLO 基础策略放行；Bash 里的 `node -e` / `python -c` 等内联代码返回 unsupported，同样放行。这是已知覆盖限制（2026-11-05 记录），不表示这些调用安全。

参数归属回归：CMD 的 `rd/s/q target`、`rd target/s/q`、`del/q file` 按内建命令粘连开关识别，引用路径中的斜杠和重定向目标不拆成开关。Git Bash Robocopy 识别静态 `/c/...` 盘符路径，不因此放宽未知开关或 `/JOB` 的参数数量。rm 保留 GNU 风格危险选项扫描，批量计数同时覆盖 BSD 首个目标后把 `--help` 等当文件名的语义；不探测平台或文件系统，在存在批量删除解释时确认。

后续范围确认：BSD find 已声明的 `-d/-x` 按零参数前置选项消费，`find -d . -type f -delete` 和 `find -x . -type f -delete` 应命中。Robocopy 裸 glob 文件过滤参数暂不补充：例如 Git Bash 下 `robocopy src dst *.txt /MIR` 仍可能返回 unsupported、沿 YOLO 基础策略执行；这是已知覆盖限制，不表示该命令安全。

链路不变：matcher → Bash ToolEntry.userApprovalRule → PermissionService → executor/broker → 单次批准/拒绝 → 原 tool result。UI、模式/Plan、子任务、自动化、持久化和协议无改动。

验收对应 DCA-V1-19..25：七类正反例与 Guarded 拒绝/批准、YOLO 受控执行；Hook allow 不代批、取消不执行、零项目规则写入、pending 清理。原生语义验证全部在临时自有目录；Windows CMD/Git Bash 与桌面 UI 分开取证。新增 Desktop 用例保留 manual-review/pending，人工审核后才能转正；历史通过不作为本轮证据。

本轮运行证据（2026-09-24）：

- 识别测试先红：原实现 35 条中 24 条失败；本轮三个参数归属修复新增回归后，58 条中 14 条失败，再修复转绿。最终选定 core 14 suites / 512 tests、bootstrap 8 suites / 52 tests 通过。七类及本轮回归批准/拒绝均经过真实内存 broker 的 pending/resolve，检查迟到批准无效、handler 0/1 次和项目规则零写入；YOLO 对照不新增请求。
- `node apps/zcode-cli/packages/core/tests/fixtures/guarded-deletion-oracle.mjs`：macOS Bash 12 项通过（含 BSD rm 四种尾部选项形文件名）；同脚本通过 SSH 在 Windows 测试机（连接示例：`dev@192.0.2.10`）上执行 CMD/Git Bash 验证，24 项通过，临时目录均清理。本轮 6 条 Windows 回归的实际执行命令同时送入 matcher 核对：CMD 粘连开关与 Git Bash Robocopy 绝对盘符路径命中，`/L` 不命中。不冒充 Windows Desktop E2E。Robocopy 的冒号值、XF/XD 列表与 L 语义同时核对 [Microsoft 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/robocopy) 与原生命令结果。
- Desktop pending 5/5、正式 Guarded 16/16 通过，报告 `desktop-e2e-20260924091043202-p16067-b339773b57c600dd`。该次联跑的 Hook 用例因 pending 自动开启人工审核录屏，在收尾报 `spawn ffmpeg ENOENT`，不能记为整轮通过；不改代码，使用同一构建单独正式回放 Hook 1/1 通过，报告 `desktop-e2e-20260924091351270-p21173-3b35333ac8b83c4d`。新增 case-local fixture check 通过，不转正。
- 根 typecheck、lint（213 warnings / 0 errors）、E2E/core typecheck、改动生产文件 CLI lint、架构检查通过。全 CLI 脚本因缺 turbo 无法直接运行；本次 `pnpm --dir apps/zcode-cli -r typecheck` 全包通过，先前 bootstrap 类型阻塞未再出现，未修改依赖。递归 CLI lint 和 core lint 仍因未修改文件 max-lines 失败。覆盖审计仍被未修改的 Highspeed fixture ledger 元数据不一致阻塞；功能图谱此前 4 条悬空边与 HEAD 一致，本轮不修改图谱。
- 后续 find 定向修复：新增 `-d/-x/-d -x` 三组回归先失败，修复后 matcher/command/approval 三组共 364 条通过，覆盖谓词参数、exec 载荷、未知 arity、Guarded 批准/拒绝/取消及 YOLO 对照。macOS 原生 oracle 15/15，新增三条实际 find 命令与 matcher 成对核对；Robocopy 裸 glob 仍为 unsupported。根与 CLI 包级全量类型检查、根 lint、修改文件 CLI lint、架构检查通过，CLI 全量 lint 仍受既有 max-lines 阻塞。本次不改审批/UI，未重跑 Desktop E2E 或 Windows 原生测试，不更新其历史证据。

本轮不修以上范围外基线问题。全量门禁未通过，不宣称 production ready，不自动提交/推送；新增 E2E 待人工审核，Linux 原生执行及 Windows Desktop/手机 UI 未运行。状态与审批核心未修改。

## 界面文案（2026-09-23）

`guarded` 的界面名称为“自主模式 / Autonomous mode”，下方单行描述为“在有风险时询问 / Ask when there’s risk”。Desktop/手机 Composer、Automation/OffPeak 共用中英文翻译与模式目录；内部 mode 值、CLI 命令、权限语义、默认值和保存恢复不变，继续使用浅蓝色与 Edit 图标。验收覆盖中英文名称、单行描述及模式值不变。

## 审批 E2E 录屏依赖修复（2026-09-17）

转正后的 Hook 用例默认回放已复现：业务断言完成后，强制录屏收尾因 `spawn ffmpeg ENOENT` 失败（失败报告（本机报告 `desktop-e2e-20260917-105436-295`））。录屏是人工审核证据，不是审批功能的前置条件；仅当已有 `ZCODE_E2E_MANUAL_REVIEW=1` 时启用录屏及两段 3 秒阅读停留，编码器仍沿用 `ZCODE_E2E_FFMPEG_PATH` / PATH。默认回放保留截图、交互轨迹及全部业务断言，不创建录屏、不标记已生成视频。人工录屏失败继续报错，不捕获吞掉。

验证：未配置 ffmpeg 的默认回放 1/1（本机报告 `desktop-e2e-20260917-110126-662`） 通过，产物 `video_capture_mode=null` 且无视频；显式人工录屏回放 1/1（本机报告 `desktop-e2e-20260917-110306-504`） 通过，产物标记 `electron_capture_page` 且视频非空。两条路径均保留全部审批和 provider result 断言。E2E/root typecheck、lint（195 warnings / 0 errors）、fixture check、架构及覆盖审计通过；未改生产代码或 provider fixture。

## Guarded 视觉区分（2026-09-17）

仅调整 presentation：Guarded 触发器使用已有 `icon-blue` 浅蓝色（含 hover/展开态），图标复用 Edit 的 `ShieldCheckIcon`，菜单项同步使用该图标。当前旧 Edit 在共享组件中是默认前景色，本次不修改它；YOLO 保持橙色 `warning` 与 `ShieldAlertIcon`。名称、候选、默认值、权限语义与持久化不变。

唯一改点为共享 `ConfigSelect`，覆盖 Desktop/手机 Composer、Automation 和 OffPeak 表单；复用主题 token，不新增 CSS 变量或端侧分支。沿用 DCA-V1-13，先补组件回归和既有 Guarded E2E 的图标/颜色断言，再修改展示映射；不新增 provider fixture。

验证：新增中英组件断言先红后绿，相关 4 suites / 70 tests 通过；Desktop E2E 16/16（本机报告 `desktop-e2e-20260917-104756-745`） 验证菜单图标、Guarded/YOLO 触发器实际计算颜色及原审批闭环。E2E/root typecheck、lint（195 warnings / 0 errors）、架构检查通过。手机未做实机复验，使用相同共享组件与主题 token。

## E2E 转正范围（2026-09-17）

用户确认将 `conversation-session-guarded`（16 条）和 `conversation-session-permission-hook-rewrite`（1 条）转正。保留既有 V4 helper、case-local fixture 与所有执行次数、权限规则、迟到响应和 provider tool_result 断言；只迁移正式路径及其相对引用，不修改生产行为。

转正使用 `e2e:promote --reviewed` 的预览及事务式 apply，覆盖审计失败必须回滚。为解除已确认的基线文档阻塞，只补齐 D19/I74/I75 的自动化缩写登记、同步统计和重新生成过期审计文档；不改变这些其他用例的覆盖状态，不放宽审计规则。正式用例须通过 fixture check、common + case-local replay、default replay、类型检查、lint 与架构检查。

本次只转正现有桌面闭环，不把整个 DCA-V1 合同标为完成：真实手机恢复、无人值守 scheduler 实机闭环等仍按用户决定在发版前确认。Docker suite 准入不在本次范围内；测试目录迁移不等于 Windows Desktop 或手机验收。

本次实际验收（macOS，正式路径）：独立 common + case-local replay 的 Guarded 16/16（本机报告 `desktop-e2e-20260917-103040-969`）、Hook 改写 1/1（本机报告 `desktop-e2e-20260917-103358-154`） 均通过；两份 spec 的 default replay 联跑 17/17（本机报告 `desktop-e2e-20260917-103558-120`） 通过，无 flaky/skip/infra failure。录屏通过既有 `ZCODE_E2E_FFMPEG_PATH` 指向本机可用 ffmpeg，未改录屏 helper。

两份 fixture check、Desktop E2E/root typecheck、lint（195 warnings / 0 errors）、架构检查（0 violations）及 diff check 通过。全局覆盖审计现为 101 formal admitted / 0 rejected、0 contract gaps、0 stale generated docs；未将基线的其他 pending 用例转正。逐字对比确认测试仅变更 helper/文件 fixture 相对路径，所有断言和 provider fixture 均保持不变；Guarded fixture check 的既有输出标记 `E2E_GUARDED_PARENT_DONE` warning 保留。

## Feature Summary / 澄清记录

2026-09-15 按已确认的新边界定向替换，基线为已合并 staging 的 65e60809b7。替换前完整工作区（含 untracked）备份为 stash d4e1e36e29ebc6044600bf5bd81f70bf0f6ca7ae。不整体 reset，不恢复旧实现，不自动提交或推送。下方 09-10/11 的运行记录仅为历史证据，不作为本次验收。

新增 guarded（危险命令确认），显式选择启用。用户确认九项规则、子任务继承、PowerShell 排除；无产品未决项。guarded=YOLO 基础策略+明确危险命令用户单次批准；原 yolo/build/edit/plan/auto 保持原行为，auto 仍未实现。不修改默认值，不迁移已有任务/自动化/配置，不新增保护 boolean 或数据库迁移。不是完整 Auto Mode classifier，也不承诺未知语法安全。

### staging 合并兼容（2026-09-18）

- 沿用独立 Plan 状态：`guarded + planEnabled=true` 仍受 Plan 限制；进入/退出 Plan 保留 guarded 权限，不恢复旧的 mode=plan 状态切换。
- 普通审批保留 staging 的工具预览、会话授权与 Full access；危险请求的 `user-once` 约束优先，不提供项目/会话永久允许规则。主任务可由用户在新版审批框明确切换至完全访问并通过风险确认，子任务和独立工作流不开放此切换；本次工具应答仍是允许一次，不被 `prepareApproval.proceed` 放行。
- 新 workflow 工具的 `alwaysAsk`、预览和会话授权沿用 staging 行为；已删除的旧 CLI workflow 命令不恢复。普通子任务继续透传同一个 broker 登记信号和最内层 origin。
- 模式菜单保留独立 Plan 勾选及草稿语义，权限列表仍以 Guarded 替换 Edit；历史 edit 可以回显，Guarded 保留蓝色和 Edit 图标。

```text
提交 {mode: guarded, planEnabled} → Runtime 唯一执行状态
  → Plan 开启：既有 Plan 判权
  → Plan 关闭：危险命中 → user-once → 已登记的 broker → 单次批准/拒绝
                        普通请求 → 既有工具预览 / Hook / Full access
```

合并验证：根 typecheck、CLI 全包 typecheck、根 lint（206 warnings / 0 errors）、架构检查、覆盖审计与 E2E typecheck 通过。core 首轮 13 suites / 241 tests，追加 Guarded 审批与 matcher 回归 2 suites / 213 tests（存在交集，不累加）；bootstrap 7 suites / 37 tests、共享与 UI 2 suites / 9 tests 通过。Desktop E2E 17/17 通过，报告 `desktop-e2e-20260917-165215-454`，无 flaky/infra failure。Windows/真实手机恢复与无人值守 scheduler 未在本次重跑。

CLI 全包 lint 仍因 staging 已有的 `max-lines` 报错失败：contracts 的 browser-control、session-store、workflow、event-reducer、model，以及 debug 的 analyzer/App。前六个非 reducer 文件与 staging 相同，event-reducer 只增加单次审批字段，staging 本身已超过阈值；不在本次合并中拆分无关模块，本次提交不宣称 CLI 全包 lint 通过。

二次核查：对照两个合并父节点及 AUTO_MERGE，独立审查未发现合并引入的回归。追加运行 51 suites / 723 tests 全部通过，覆盖独立 Plan、模式与队列保存、workflow 审批/会话授权、Full access 竞态与投影、Memory/CUA 权限、工具执行器、Guarded 九项规则及子任务/问答。根 typecheck、lint（206 warnings / 0 errors）和架构检查再次通过；本轮未修改生产逻辑，Desktop E2E 使用上述合并后 17/17 证据，Windows/真实手机/scheduler 未重跑的边界保持不变。

改动层：validation、option-source、commit-effect、persistence/recovery 模式透传。

### 撤回版本兼容分支与影响清单（2026-09-16）

用户确认 Desktop 与 CLI 包内分发，不将版本 mismatch 作为本功能的支持场景。先撤回 Host 在空 Guarded `createSession` 成功后补发 `switchCollaborationMode` 的分支，随后按用户要求撤回 `firstInput.mode` 补齐及旧 schema 模拟测试。Host 恢复原创建转发逻辑，保留既有 OffPeak flag 注入；不为已排除的需求补另一层 CAS/重试。

- **Feature Summary**：`validation / commit-effect`；局部撤回，其他未提交改动只做 impact-only 审计。九项 matcher、共享审批核心、默认值与模式菜单不变。
- **UI Surface Matrix / State Owners**：Desktop/手机 Composer 的草稿仍由 UI 持有，`agentConversationTransport -> sendConversationCommandV4 -> CommandInbox -> createSession` 共用 Host 转发，CLI/runtime 拥有 session/mode；空会话 ACK 后由原调用方继续 sendText/命令。config.mode 与 firstInput.mode 原样传递，自动化记录不改写。
- **Shared And Divergent Behavior / Invariants**：空 Guarded 创建不再多发请求，Host 不补写 firstInput.mode；保留 config.mode、严格 Submission schema、配置实际应用失败阻断、桌面 continuous/手机 replayable、workspaceIdentity 隔离及既有权限生命周期。不新增状态、配置、协议或持久化。

```text
空 Guarded createSession(config.mode) -> CLI 应用配置 -> 返回原 ACK -> 原调用方提交输入
```

| Feature Relationships / rank           | 代码事实及处理                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| must-inspect：Host 创建后的模式补发    | `zcodeAgentService.ts::sendConversationCommandV4`：撤回额外请求；服务测试断言只发送一次 createSession        |
| must-inspect：Host firstInput 模式补齐 | 已撤回；缺省 mode 不注入，调用方显式 mode 不覆盖，模式解析仍由原 CLI 创建/Submission 链路承担                |
| evidence-only：旧 schema 模拟          | 已删除 oldModeSchema 测试桩与拒绝旧版本用例；保留正常创建仅发送一次、payload 原样转发的回归                  |
| should-inspect：CLI 配置应用失败阻断   | `session-mgmt.ts::createSession` 防止配置失败后继续执行，属于真实失败处理而非版本探测，保留                  |
| invariant-only：严格模式与旧值恢复     | mode 枚举、保存恢复、历史 edit/full-auto、broker registered/approvalMode 合同均非 Desktop/CLI 版本探测，保留 |

**Codegraph Evidence**：当前无 codegraph 工具，以 diff（含 untracked）和直接调用点追踪两层；主 seeds 为 Host 上述两个函数、SessionPane 创建分支、CLI createSession/applyRequestedSessionConfig。服务测试验证命令数，既有 Guarded pending E2E 验证用户选择/审批/provider result，不能声称它强制覆盖了无预热带附件分支。
**Graph Drift Candidates / Graph Delta**：图谱现有 Guarded 模式和审批不变量不依赖版本探测，无需改节点或边；旧 runtime 二进制验收从本功能当前要求移除，历史运行记录保留但不作为现行要求。
**Unresolved Questions**：本次版本兼容撤回无剩余未决项；不扩大到配置失败处理、权限策略或历史数据兼容。

本次验证：两次撤回均先改服务断言，分别复现多发 switchCollaborationMode、补写 firstInput.mode 的失败，再删除对应分支；Host 生产文件现已与 HEAD 一致。services/shared/Composer 三组 58 条测试通过。根 typecheck、lint（43 warnings / 0 errors）、architecture check（0 violations）、两个代码文件格式检查及 diff check 通过。未改 UI/E2E spec、未重跑 Desktop E2E；无预热带附件 UI 分支仍未验收，不借既有草稿 E2E 声称已覆盖。未提交或推送。

### 菜单替换与兼容收尾（2026-09-15）

用户确认：Guarded 只替换菜单中的 Edit 入口，不替换 YOLO，也不迁移已有 edit 会话/配置。
本次改动层为 option-source，以及恢复原有可观测性；不改变权限策略、审批时序或默认值。

| 入口/关系                              | 候选、展示与提交                                                                                               | 单一权威/兼容边界                                                         | 优先级         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------- |
| Desktop/手机 Composer → 共享模式目录   | build/guarded/plan/yolo；草稿随 Submission 提交                                                                | 原 edit 草稿/恢复值仍显示 edit，不因目录过滤变成 build/guarded            | must-inspect   |
| Automation/OffPeak 表单 → 同一候选目录 | 新选择不含 edit；未修改的旧 edit 原样保存                                                                      | 各自记录，不写当前对话或全局默认值                                        | must-inspect   |
| TUI /mode 建议、快捷键循环             | plan/build/guarded/yolo；显式选择才提交模式命令                                                                | Runtime 权威；显式旧 /mode edit 和 --mode edit 保持兼容                   | should-inspect |
| Session/config/protocol 归一化         | 可选菜单不是恢复值白名单；继续接受 edit                                                                        | 原权限、Plan 往返及持久化不迁移                                           | invariant-only |
| full-auto/full_auto 别名               | 恢复映射到 yolo，guarded 单独映射                                                                              | 不影响其他 provider 的既有别名                                            | must-inspect   |
| executor → logger                      | 恢复 evaluated/denied/resolved/hook_race_forfeited 的原级别、event/module/status/reason 和 trace/tool 关联字段 | 日志是派生观测，不参与审批；inputSummary 仅类型/键名/长度，不记录输入正文 | must-inspect   |

```text
模式目录（新选择） -> Composer/表单/TUI -> 原提交链路 -> runtime.mode
历史 edit（兼容值） -------------------------------> 原 edit 策略
审批生命周期 ------------------------------------> 原结构化日志
```

维度：入口 × 新选择/历史 edit × guarded/yolo；剪枝：无权限算法、Shell 文法、数据库迁移或远控恢复变更，不新增全排列。桌面 continuous 与手机 replayable 不改状态或路由。
DCA-V1-13 补充 accepted 子场景：菜单无 edit、有 guarded/yolo；选择 Guarded 后现有危险命令拒绝闭环仍成立；旧 edit 的 schema、config 投影、Composer/自动化回显与 Runtime 策略不变；别名正反向映射不漂移。菜单 UI 复用现有 pending E2E，不修改已转正键盘问答用例或增加 provider fixture。
日志回归使用真实 executor 与捕获 logger，覆盖 allow/ask/deny、broker 允许/拒绝、Hook 故障等待 broker；断言字段、级别、次数、输入摘要无正文及 handler 0/1 次。
代码图工具不可用，按共享目录/归一化、表单 builder、TUI 目录和 executor 的直接调用点核对（深度 2）。图谱增量为模式菜单 seeds 和“隐藏 edit 不影响恢复”不变量；无新增状态 owner 或未决产品问题。E2E 保持 manual-review/pending，运行后追加证据，不提前标 covered。

收尾验证：本机 macOS 341 条相关单测/集成通过（UI/shared/services 151、core 111、bootstrap 48、adapters 19、CLI 3、TUI 8、Guarded 图谱 1），含失败先行的别名、菜单与日志合同回归。Desktop 17/17、0 flaky/infra：Guarded 16 条（rm 拒绝前新增菜单断言）及原 Bash 项目授权 1 条通过，报告为 summary.md（本机报告 `desktop-e2e-20260915132447238-p43341-2120e3d1d2daaee9`）。真实 CLI 日志已观察到恢复的 resolved event/module/status 与 trace/request/tool 关联字段。
根 typecheck、Desktop typecheck:e2e、CLI core/tui/cli typecheck、lint（43 warnings/0 errors）、architecture check 和 fixture check 通过；fixture 仍有既存输出标记 warning。图谱整组的旧 node/edge 总数断言与覆盖审计仍有既存统计/生成文档漂移，未借本轮修改无关基线。原问答键盘 E2E 的失败未在本轮修复/重验；Windows、真实手机恢复及 scheduler 等未验收项保持不变。全部变更取消暂存，未提交/推送，未迁移用户数据。

## 命令目录 / Boundary Decisions

| ruleId（前缀 safety.bash.） | 明确命中                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| remove-critical-path        | rm recursive，或至少两个目标/未引用未转义 glob；不分析路径风险                  |
| system-storage              | dd、mount、umount、mkfs/mkfs.\*；声明的 help/version、无参 mount 列举除外       |
| git-reset-hard              | git reset --hard                                                                |
| git-clean-force             | 有效 force，真正 dry-run 除外                                                   |
| git-push-force              | 有效 force/force-with-lease/mirror/+refspec，真正 dry-run 除外                  |
| git-discard-tree            | checkout -f 或 checkout/restore 对 .、./、:/ 的整体回退；纯 staged restore 除外 |
| git-stash-clear             | git stash clear                                                                 |
| git-worktree-force-remove   | git worktree remove -f/--force，含重复 force                                    |
| rsync-delete                | delete/del/delete-before/during/delay/after/excluded，真正 dry-run 除外         |
| cmd-remove-tree             | CMD rd/rmdir /s；独立帮助除外                                                   |
| cmd-delete-files            | CMD del/erase 实际删除调用；无目标、独立帮助除外                                |
| find-delete                 | POSIX/Git Bash find 的 -delete 动作，不解释 exec 载荷                           |
| robocopy-delete             | CMD/Git Bash robocopy /MIR 或 /PURGE，可靠的 /L 列举除外                        |

POSIX bash/zsh 有限共同语法、Git Bash 使用现有 Bash AST；CMD 独立有限解析，不借用 Bash 引号规则。逐词保留字面性、动态性和位置，只提取直接调用、顺序、AND/OR、pipeline。字符串/注释/重定向目标不是命令。动态目标不抹去明确的 rm recursive+force。

CMD 的 REM 注释识别必须排除重定向目标：`>rem git reset --hard` 中 rem 是文件名，后续 Git 命令仍需匹配；真正的 `rem git reset --hard` 保持注释语义。不增加规则或改变 unsupported 与旧模式策略。

wrapper 首批仅 env/time/sudo，以声明式 arity 表消费选项，必须包含 time -o file。Git 支持 -C/--git-dir/--work-tree/-c 等前置参数（-c 只按取值 arity 跳过，不解释配置内容）。未知参数不猜测 arity；不展开脚本、函数、循环、动态 executable、命令替换、Git alias/config 语义、pathspec 文件和 PowerShell 载荷。沿现有 10000 字符解析上限。

结果 matched/notMatched/unsupported：可靠定位的独立命中优先于其它局部 unsupported；无法可靠提取的结构不伪造命中。未命中/unsupported 保留 YOLO 基础策略；解析故障不增加 ask，用户取消仍终止执行。

### 命令语义与豁免合同（2026-09-15 review 修复）

Shell AST 只证明词、边界和位置，不证明被调用程序如何解释 argv。此次发现的根因是把 rm 的尾随 `--help/--version` 按通用选项扫描当成查询退出；macOS 原生 rm 遇到首个路径后将它们作为文件名。修复保留九项目录及审批核心，不增加平台探测、可执行文件解析或未知语法审批。

- rm 是有限文法内 recursive + force 的存在性规则，不推断命令是否真正执行删除；`--help/--version/-i` 不取消命中。因此 `rm -rf --help` 也会确认，这是原合同的保守取舍。`rm --help` 无 recursive + force，仍不命中；`--` 后的 `-rf` 仍只是操作数。
- 通用选项解析必须显式声明 `stop-at-operand` 或 `interspersed`，没有默认值。wrapper 与 Git 前置参数在首个操作数停止；rm 存在性规则、Git 子命令与 rsync 按已声明文法继续扫描。这是识别合同，不代表所有操作系统的命令实现相同。
- 新增豁免必须说明所属命令、有效选项位置、arity、取消优先级及独立验证依据；不能从某个平台的帮助行为推导所有实现。参数值、`--` 后操作数、其它命令中的同名词不能产生豁免。

| 规则                      | 本次核对的消除命中条件                                                           |
| ------------------------- | -------------------------------------------------------------------------------- |
| rm recursive + force      | 无查询/交互选项豁免；本次删除 rm help/version 豁免                               |
| system-storage            | 仅独立单参数 `--help/--version`、无参 mount；不扫描其它参数中的帮助词            |
| git reset --hard          | Git 帮助、显式其它 reset 模式/patch；不借用 rm 的扫描语义                        |
| git clean force           | Git 帮助、有效 dry-run；exclude 参数值及 `--` 后路径不产生 dry-run               |
| git push force            | Git 帮助、有效 dry-run；force/lease/mirror 分别按对应取消选项归约                |
| git discard tree          | Git 帮助；restore staged-only；checkout force 的取消不抹去独立全树目标           |
| git stash clear           | Git 帮助；stash drop 不在范围内                                                  |
| git worktree force remove | Git 帮助、有效 no-force；重复 force 仍命中                                       |
| rsync delete              | 已声明的 dry-run/help/version；filter/exclude 等参数值与 `--` 后操作数不产生豁免 |

验证分两层：core 覆盖上述合同正反例、参数位置及 wrapper；macOS 原生 rm oracle 仅在 mkdtemp 自有目录内验证尾随帮助词仍被删除。桌面 pending E2E 将 rm 拒绝样例改为尾随 help/version，并断言目标内容不变、Bash 哨兵不存在、项目规则零写入及 provider 收到拒绝。原 YOLO/批准普通 rm 的对照保留。此处不把 oracle 与 GUI 证据混作所有命令实现的完整验收；Windows/手机等原待验收项不变。

### 未知选项、尾部重定向与缺失 Shell 选择（2026-09-17 review 修复）

本次 review 发现三类"应命中却退回 YOLO 静默执行"的缺口，全部属于识别层，不改审批核心、九项目录、默认值或协议。

**选项扫描策略是二维声明**：`ordering`（`stop-at-operand` | `interspersed`）× `unknown`（`abort` | `continue`），没有默认值。

- wrapper（env/time/sudo）与 Git 前置参数使用 `stop-at-operand` + `abort`：未知选项的 arity 决定真实命令从哪个词开始，猜不出就整体 `unsupported`。`time --unknown rm -rf build` 仍是 `unsupported`。
- rm、rsync 与 Git 子命令使用 `interspersed` + `continue`：未知选项只标记 `unsupported`，不消费下一个词、不进入已识别 `flags`，扫描继续。已识别的 recursive+force / `--delete` / `--force` 等证据不因后面多一个未知词而失效。
- 调用方按"命中优先"收敛：先用已识别选项判定规则；命中 → `matched`；未命中且遇到未知 → `unsupported`；否则 `notMatched`。这是 §命令目录"可靠定位的独立命中优先于其它局部 unsupported"在单条命令内部的落实。
- 保守方向：未知取值选项的值可能被当成独立 flag，最坏结果是多问一次。残余风险是该值恰好等于一个取消词（如 `-n`），接受并记录，不为此引入 arity 猜测。

选项表本身只补 Git 前置参数（`-c <key=val>`、`-p`/`-P`、`--bare`、`--exec-path[=path]` 等）：前置参数走 abort 策略，不认识就整条 unsupported，这是唯一必须扩表的位置。rm、rsync、Git 子命令的表保持原样——在 continue 策略下，`rm -rfx`、`rsync --delete --info=progress2`、`git push --force --no-verify`、`git checkout -f -t` 的未知选项只会让结果在 matched 之外多一个 unsupported 标记，而 `bash.ts` 只消费 matched，因此扩表对运行时零影响，不为测试标签精度增加维护面。

**CMD 尾部重定向**：`git reset --hard 2>nul`、`git reset --hard > out.txt` 曾整条 `unsupported`。根因是 EOF 收尾把"重定向目标词尚未 flush"误判为"缺少目标"。合同：只有重定向符之后没有开始任何目标词才是缺目标（`git reset --hard >` 仍 `unsupported`）；目标词已开始累积时由收尾 flush 按重定向目标丢弃，命令正常匹配。

**Shell selection 缺失**：`bashShellSelection` 为 `undefined` 是基础设施状态而非语法边界。与既有 `isRuntimeReadOnlyBashCommand` 一致，缺失时按 POSIX 文法匹配；显式 `legacy-shell` 仍为 `unsupported`。不引入平台探测。

**范围外例子**：`timeout`/`nohup`/`nice`/`exec`/`command`/`xargs` 前缀（wrapper 白名单外）、CMD `format`。本节 09-17 的旧目录中排除的 `git clean -f/-fx/-fX`、CMD rd/rmdir /s 与 del/erase 已由 09-24 补充合同纳入；上方当前目录优先于历史修复记录。

## 单一权威与事件顺序

```text
runtime.mode -> 本次权限快照(mode, input, cwd) + 既有 session Shell selection
                         |
               guarded ? +---- no --> 原权限路径
                         |
                    有限命令规则
                      /       \
                  matched     未命中/unsupported
                     |             |
                 user-once       YOLO 基础策略
                     |
             当前 requestId 用户批准
                     |
             同一 input/shell/cwd 执行

Hook modified input -> normalize/schema -> 重判 -> 必要时新 requestId
broker 批准 modified input -> normalize/schema -> 固定新输入 -> 执行
desktop continuous -----------\
                               > 同一 CLI/broker 权威
mobile replayable 恢复 -------/
```

executor 固定本次 mode/input/cwd，Shell 复用既有 session selection；ToolEntry 产生动态审批能力，PermissionService 消费，不在入口复制 matcher。显式 approvalMode=user-once 贯穿 broker/event/投影，不用空建议列表代替能力。命中后项目 allow、PreToolUse allow、PermissionRequest Hook 不能代批；危险请求直接 broker，普通请求保留既有 Hook/broker race、Memory 和 prefix 语义。

Hook/broker 改输入均回到统一 normalize/schema。Hook 改写需要权限重判；旧 requestId 结束，新输入需要确认时生成新 requestId。Guarded 中可信 broker 的 allow/modify + modifiedInput 表示用户已经批准修改后的输入，不再次判权或申请批准；仍固定本次 mode/cwd，并克隆冻结规范化后的输入用于执行。Shell 复用既有 session selection，不额外克隆或冻结。非法输入不执行；危险请求的 permissionUpdates 拒绝且不落盘。无 broker、超时、取消、非法响应或故障不执行。切换模式不批准挂起请求，下次调用使用新 mode。保留 Deny feedback 的最终 provider-visible tool_result。

### 撤回重复 Shell 快照

既有 session shell owner 在首次真实输入前初始化 selection，已有值不被设置热更新；冷恢复在执行前恢复持久化选择。审批期间切换 Git Bash/CMD 不是现有产品路径，因此 executor 的匹配与 handler 直接复用该 selection，不新增 per-call Shell clone/freeze。撤回测试中直接修改 `shell.dialect` 的虚构场景，改验同一会话选择原样传递；input/mode/cwd、取消、审批生命周期与 desktop continuous/mobile replayable 均不变，不迁移配置。

本次验收：先改回归断言，旧实现 3 条失败；撤回后 core 7 suites / 293 tests、bootstrap 2 suites / 16 tests 通过。根与 core typecheck、两份代码文件格式检查、架构检查（0 violations）、diff check 通过；根 lint 43 warnings / 0 errors。本次生产仅 call-runner.ts 净删 5 行，未修改 UI/E2E spec、未重跑 Desktop E2E 或 Windows 实机；覆盖状态继续 pending。未提交或推送。

问答结果不是操作改写：原请求的可信 `sideEffectScope=userInteraction` 且应答来自 broker 时，`modifiedInput` 表示填入答案，校验后执行 handler，不重新发起问答；Hook 的输入修改仍重判。用途取既有权限决定，来源取 executor 的 responder race，不接受应答载荷自报豁免，不新增协议/持久化字段。Desktop continuous 与手机 replayable 继续消费同一请求终态，不改变传输或 pending 所有权。回归覆盖预设/自定义/空答案、非法答案、拒绝及 Hook 修改；新增待审 Guarded E2E 验证问答答案进入下一次模型请求，不改已转正的键盘问答用例。

模式值贯穿 contracts/shared strict schema、V4 submission/command、CLI/TUI 菜单、session 保存/恢复、automation、Enter/ExitPlanMode。Desktop/CLI 按包内同版本运行，不新增旧 runtime 能力探测；真实配置/提交失败仍不能静默执行。复用已有 options wire shape，新增跨边界字段必须有严格 schema。

## 子任务继承 / Shared And Divergent Behavior

集中派生规则：parent=guarded 且普通/Explore/嵌套 subagent 的原 child mode=yolo 时改为 guarded，其余不变。动态工作流（dwf）的子代理继承发起会话的权限模式（不止 guarded）：run 创建时在 `run-launched` 记 `subagentPermissionMode`（如 `"guarded"`），该 run 的全部子代理（含 resume/重启后）以该模式运行；guarded 下危险命令经父会话 broker 以 `user-once` 请求用户，origin 标注子代理（`docs/dynamic-workflow/launch.md`「Permissions inside a run」）。旧 `/workflow` 的 expert/script workflow child 仍排除，保持内部 yolo，不接入危险审批；任何 workflow 启动/恢复都不能将 guarded 父任务切为 yolo。显式 plan/edit 保留；既有 yolo 自动化不变，仅自身选择 guarded 的 automation 启用。无人在线但 broker/runtime 存活时保留 pending，等待上线审批；超时/取消/进程退出不转为允许。

当前基线普通 subagent runtime 明确设置 `subagents.enabled=false`，普通 child 再创建 child 没有可达执行路径；本轮不新增嵌套能力。派生函数保留可组合语义，运行证据覆盖普通/Explore/自定义前台、普通后台与 workflow→Agent 既有代表路径，不声称验证了不存在的普通多级嵌套。

## 统一审批生命周期（2026-09-15）

Broker 同步登记是默认合同；需要异步准备的 protocol broker 在本次返回的 Promise 上提供 `registered` 完成信号。executor 等待它后发布事件；信号不保存授权或 pending 副本，仅表达原 broker 登记表已可响应。登记未完成时的取消/失败也必须收口，不能被登记等待阻塞；迟到的登记完成不能再发布已结束的请求。

包装另一个 broker 的实现（如子任务路由到父 session 的 broker）必须显式转发内层的 `registered`，返回类型使用契约中的交叉类型；不能依赖"恰好返回同一个 Promise 对象"这种同一性透传，否则任何 `async`/`.then` 改写都会静默丢掉信号并退回同步登记假设（2026-09-17 review 修复）。

同一次工具调用内，首次判权与 Hook 改写后的重判共用同一份 `preparedContext`（mode、bashShellSelection、workingDirectory 快照）；重判不得回退到只含 runtimeScope/cwd 的缩减上下文，避免 guarded matcher 在重判路径静默失效。

替换独立 requestUserOnce 流水线及递归 resolveToolPermission 重入：同一个 executor 驱动准备、判权、登记/发布、等待、响应转换与终态。Hook 输入改写只重新准备/判权，不重复已执行的 Hook 链；broker 已批准的修改只重新准备，不再次判权。broker 持有 pending，executor 持有本次执行快照，不新增协议状态副本。

```text
prepare(mode,input,cwd; sessionShell) -> decide -> allow/deny
                                  |
                                 ask -> register -> publish -> response -> close
                                                               |            |
                              broker approval/answer -> validate -> execute |
                                           Hook rewrite <-------------------+
                                              |
                                         prepare -> decide -> new requestId
```

请求用途来自可信权限能力，响应来源来自真实 responder；broker 的问答答案只完成交互，Hook 修改仍是请求改写。模型首次校验保留原错误反馈；所有 Hook/broker 修改均 normalize + schema，不在改写后重复调用 ToolEntry.validateInput。工具语义预检仍只在首次模型输入、PreToolUse 之前执行；handler 自身的校验不变。无修改的批准执行原快照；Hook 改写先收口旧 ID，再判断新输入；broker 批准修改后的输入则收口原请求并直接执行新快照，不额外询问。危险请求不能持久化授权。取消、超时、无 broker、非法响应及基础设施错误均不执行，保留既有结构化错误类型，不伪装成用户拒绝。所有请求只发一个终态，可见时必须已登记可响应，迟到/重复响应不能批准新 ID。

### broker 修改后批准的语义收敛（2026-09-15）

用户确认只调整 Guarded 的 broker 应答：allow/modify + modifiedInput 是对最终输入的本次批准，而不是待审批提案。以 responder race 的 source 为准，禁止 Hook 通过响应字段自报 broker 来绕过重判。旧模式的既有 modifiedInput 接受范围、Hook deny/ask 重判、问答完成、初始工具禁止条件与 handler 校验不变；不增加 UI 编辑入口、变更提示、协议字段或持久化状态。CLI/broker 继续是唯一 pending owner，desktop-continuous 与 mobile replayable 路由不改。

验收：broker 危险 A→危险 B 的 allow/modify 均只请求一次、执行 B 一次；schema 非法/持久化响应/取消均零执行；mode/cwd 快照不漂移，Shell 复用会话选择；Hook A→B 仍新 ID 重判且旧响应无效；真实 protocol broker 收口同一投影并产生正确 tool result。当前桌面没有操作输入编辑控件，不能用伪造 UI 操作冒充该分支的端到端覆盖；复验现有 Guarded 和 Hook 替换 Desktop E2E，改写批准由协议集成测试验证。

本次结果：先新增回归，core/bootstrap 的 allow、modify 共 4 个用例在旧行为下失败，最小生产分支修改后相关 14 suites / 222 tests 通过。根 typecheck、core/bootstrap typecheck、Desktop E2E typecheck、架构检查通过；根 lint 为 43 warnings / 0 errors，三个改动代码/测试文件定向 lint 为 0 warnings / 0 errors。覆盖审计仍被既有 D19/I74/I75、A-J 统计和三份生成文档漂移阻断，未扩修无关基线。

收尾检查：三个代码/测试文件格式检查通过，git diff --check 通过；spec、case catalog、coverage matrix 的整文件格式检查仍有告警，未对包含其他任务改动的大文档执行全量格式化。

Desktop 联跑 20260915153836774（本机报告 `desktop-e2e-20260915153836774-p59686-b1102287e558dd4f`） 为 16 passed / 1 failed：Hook 替换通过，Guarded 的 RM 用例在发送 prompt 前的模式菜单选择失败。Guarded 原样复跑 20260915154205099（本机报告 `desktop-e2e-20260915154205099-p62115-c388109bef724697`） 仍为 15 passed / 1 failed，停在同一前置位置；未改菜单或弱化断言，不将本轮 E2E 宣称全绿。两份 spec 继续 manual-review/pending；Windows、手机与 scheduler 等原待验收项不变。

Guarded 执行请求使用已有严格 mode 字段。创建时 guarded 配置失败阻止 firstInput；空会话按既有 createSession.config 应用模式并返回原 ACK，不再补发模式探测。实际模式切换仍使用既有严格命令，Host 不再额外补齐 firstInput.mode。桌面 continuous 与手机 replayable 消费同一 CLI 权威；手机断线不取消活着的 runtime 请求。CLI 重启后沿 hydrate 既有 cancelled/interrupted 语义，不恢复旧执行节点。

保留 matcher、模式贯通、普通 subagent 路由；替换共享审批核心；撤回 workflow child 继承。接受的测试终点是正确任务可见 -> 用户响应 -> 原请求结束 -> handler 0/1 次 -> provider tool_result，不以 mock broker 被调用代替。

## UI Surface Matrix / State Owners

### Hook 改写后的确认替换：人工交互验收（2026-09-15）

本次只增加 Desktop `desktop-continuous` E2E，不改变生产审批语义。使用 build 模式、项目 Write ask 规则及真实 PermissionRequest command Hook：模型请求写 A，Hook 在屏障释放后改写为 B；旧请求结束后 B 必须以新 requestId 在同一工具调用的 composer dock 中重新确认。测试通过真实 UI 点击产生 A 的批准，仅在 renderer MessagePort 暂存这一个原始命令，待 B 可见再原样投递，验证迟到的 A 批准不会执行 B。最终真实点击 B 的 Allow once，A 不存在、B 内容正确、PostToolUse 一次、provider 收到成功 tool_result，项目规则不变。

```text
A 确认可见 → UI 点击 A（仅延迟该命令） → 释放 Hook 屏障 → B 确认可见
                                                        ↓
                      投递旧 A 批准 → B 仍等待 → UI 批准 B → 执行一次
```

CLI/broker 仍为唯一授权 owner；测试只观测 DOM、记录真实协议 ID、延迟客户端原始包，不制造权限事件或修改业务状态。录制 Electron capturePage 视频，截图保留 A/B/迟到响应后/完成四个阶段；记录 DOM 替换时间，不把“无双窗口”夸大为无闪动。case 留在 manual-review/pending，归入 DCA-V1-06 的旧模式重判代表；不覆盖手机 replayable、Windows 或 Guarded broker 改写批准分支，后者由上节独立验收。

人工观看节奏：A、B 的确认卡在条件断言通过后，各额外停留 3 秒再点击。该停留仅用于录屏阅读，不承担状态同步或成功判定；继续保留条件等待、旧响应失效、零次/单次执行及 provider result 断言。上方工具历史行当前仍显示模型原始 A，下方审批卡改为 B；本次只改善演示可读性，不修改这一生产显示行为。

| 场景       | 入口/共享来源                     | 权威与提交                          | 必须隔离                      |
| ---------- | --------------------------------- | ----------------------------------- | ----------------------------- |
| 模式选择   | V4 Composer/手机/TUI/CLI 模式目录 | draft 或 runtime.mode，既有提交命令 | 其他任务及默认值              |
| 自动化模式 | 既有编辑/创建配置                 | automation record -> runtime        | 不回写当前对话                |
| 审批       | V4/TUI/broker options             | CLI pending/requestId -> executor   | UI 不计算危险性，无项目持久化 |
| 手机恢复   | shared-host projection            | 既有 owner 路由                     | replayable 不替换 continuous  |

broker 拥有 pending；executor 拥有输入快照；sessionStore 拥有项目规则；投影是派生事实。workspaceIdentity?.trim() || workspacePath 为身份键，执行使用 workspacePath。不新增第二份状态/队列。

## Feature Relationships / Codegraph Evidence

| rank           | 共享起点与直接链路                                               | 深度         |
| -------------- | ---------------------------------------------------------------- | ------------ |
| must-inspect   | Bash AST -> ToolEntry -> PermissionService -> permission-flow    | 2-3          |
| must-inspect   | mode schema/catalog -> submission/command -> runtime/persistence | 2            |
| must-inspect   | workflow/subagent factory -> child mode/executor                 | 2            |
| should-inspect | broker/event -> buildProtocolPermissionOptions -> V4/TUI         | 2            |
| invariant-only | continuous/replayable/workspace identity                         | 1            |
| evidence-only  | 既有 permission/BPR/PVD tests                                    | 不代表新覆盖 |

codegraph 不可用，使用源码调用点核对。Graph Drift：此前全模式拦截规划被本合同替代。Graph Delta：稳定 capability ID 不变，更新模式隔离与继承不变量和真实代码 seeds，不登记未来文件。

## Dimensions / Pruning / Accepted Cases

维度：mode×match、mode×child、输入版本×响应、Shell×语法、surface×恢复。剪枝：不做完整脚本/隐式环境模拟，不做全部 flags×平台×provider GUI 全排列。unknown 不增加 ask。

DCA-V1-01/03..08 转为 guarded 合同；02 保持 PowerShell pruned；09..12 恢复 Git/rsync 扩展；13..15 为模式贯通、继承、原 yolo 对照。accepted 不是 covered，未运行证据不得继承旧 stash。

## Implementation / E2E Handoff

1. spec/catalog/matrix/tool-chain 在先，失败测试在生产实现之前。
2. 模式链路 -> matcher -> 共享审批 -> 多端投影，不重写 prefix registry。
3. 每条规则至少一个真实拒绝闭环；批准路径使用隔离目录/受控 handler。检查 handler 次数、文件/规则存储及最终 provider tool_result。
4. 新用例先 manual-review/pending；case-local synthetic fixture 写明原因，普通 fast-text、取消/迟到受控时序。文件统一 .zcode-e2e/<case>。人工审核后才 promotion。
5. Windows Git Bash/CMD 必须有真实运行证据；缺 runner 则明确待验证。手机恢复测试不冒充物理网络 E2E。
6. 运行 targeted unit/integration、CLI typecheck、desktop typecheck:e2e、pnpm typecheck/lint、架构检查、覆盖审计。图谱基线统计漂移单列，不混入功能修复。

## 本轮验证（2026-09-15）

以下为完成定向替换后的本机 macOS 结果，不继承历史 covered 状态。666 条单元/集成测试与 16 条 Desktop E2E 通过，仍不等于跨平台、多端和调度的完整验收。

| 验证                       | 结果与实际终点                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core 19 suites             | 353 passed：guarded-\*、permission service/broker/race、Memory、Plan、Bash、executor error/trace、普通子任务交互/事件、queue intent、CUA 原权限对照                                    |
| bootstrap 11 suites        | 160 passed：真实 V4 registry/command/projection 即时回应、问答与拒绝/取消；workflow/script child 受控执行后父仍需批准；严格配置失败、自动化透传、SQLite 冷恢复、queue promotion        |
| services + shared 3 suites | 125 passed：automationRepo、zcodeAgentService.v4、guardedMode。旧 runtime 测试是实际子进程模拟旧严格 schema，非旧版本二进制                                                            |
| adapters 1 suite           | 19 passed：session-store-model-selection-codec 保存值与解码                                                                                                                            |
| TUI 2 files                | 8 passed：审批选项/伪造 project 响应拒绝、模式建议与键盘选择，使用 tsx + node:test                                                                                                     |
| feature graph targeted     | 1 passed，3 个无关测试未运行；真实代码 seed 与隔离边界成立，未执行 codegraph 影响面扫描                                                                                                |
| Desktop E2E                | 16/16 passed，0 flaky/skip/infra failure；最终 runId 为 desktop-e2e-20260915101434963-p76460-ac7d9f68efd32292                                                                          |
| 门禁                       | 根 pnpm typecheck、desktop typecheck:e2e、CLI core/bootstrap/cli/tui typecheck、pnpm lint（43 warnings/0 errors）、architecture:check --changed（0 violations）、git diff --check 通过 |
| 局部质量/fixture           | 6 个审批 executor 文件独立 lint 0 warnings/0 errors，11 个本轮核心/测试文件格式化；fixture check 通过，仅输出标记 E2E_GUARDED_PARENT_DONE 不属于请求 matcher 的 warning                |

桌面报告：最终 summary.md（本机报告 `desktop-e2e-20260915101434963-p76460-ac7d9f68efd32292`）。九类危险命令逐类拒绝，整个 Bash 的执行哨兵不存在；隔离目录批准与原 YOLO 对照均仅执行一次；预设/自定义/空答案/拒绝和普通 child 的审批结果进入真实 provider 请求。每条 E2E 比较 SQLite 项目 permission ruleset，确认零写入。全部仍为 manual-review/pending，未 promotion、未标 covered。

本轮也通过了首次 16 条桌面回放（desktop-e2e-20260915100036387-p61529-1f9fd964072a1a29），随后补登记中取消的回归并重跑上述最终版本。Bootstrap 与 Desktop 全量构建同时运行时，6 条用例命中既有 5 秒超时；构建完成后同一 11 suites 用 --no-file-parallelism 复跑，160 条通过（13.51s），未调大测试超时或改变断言。

根 lint 的 43 个 warning、core 全目录 lint 的 10 个 warning、bootstrap 全目录 lint 的 26 个 warning 均位于非本轮新逻辑。bootstrap 原 lint 脚本因 ignore 规则报告 No files found，改用 exec oxlint src --no-ignore 实际扫描，0 errors；没有将未扫描视为通过。

### 尚未完成的门禁与运行证据

- **覆盖审计未通过**：合并基线已有 D19 的“—”、I74 的 pending 路径及 I75 的“同上”不是已登记缩写；A-J 总数/accepted/missing/referenced 统计为 181/178/53/77，实际 184/181/56/80；三份 generated decision 文档 stale。已逐处与 HEAD 对照，未改无关条目。当前 pending fixture metadata 0 rejected、formal contract 0 gaps。
- **扩展基线回归有 1 条失败**：subagent-background.test.ts 的 strict snapshot batches 仍断言消息不含 system-reminder，但合并基线 incoming-message.ts 已加入该安全包装。生产模块与该测试均与 HEAD 一致，单独重跑也复现；其余 25 条通过。不修改通知语义或删除断言来掩盖基线问题。
- **Windows Git Bash/CMD**：只有有限 parser 单测，没有 Windows runner 实际 shell 证据；macOS 结果不能代替。
- **手机/重启**：真实 protocol/registry/投影和取消已验证，尚未跑手机断线重连、多端竞争、真实 Runtime 进程重启后的 hydrate 闭环。保持既有 clientMode/deliveryKind、owner/stale-run、workspaceIdentity 路由，不新增 pending 副本。
- **自动化真实调度**：已验证 record 持久化、协议透传和活 broker 无人在线保持 pending；尚未完成 scheduler → Host → CLI 实机调度后上线批准/拒绝。不能将受控 broker 等待视为真实 scheduler 验收。
- **queued 执行**：已有创建配置失败零执行、SQLite 冷恢复和 queue mode 的保留/提升断言；尚无完整 queued 自动消费至危险 handler 的运行证据。旧 runtime mismatch 已按包内分发边界排除，不再要求旧二进制验收；firstInput 旧 schema 模拟测试已删除。

### 复现命令（2026-09-17 更新为正式路径）

```sh
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-guarded.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/task-management/conversation-session-guarded.test.ts'
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec './test/e2e/conversation-session/task-management/conversation-session-guarded.test.ts'
pnpm --filter @zcode/bootstrap exec vitest run --no-file-parallelism tests/guarded-interaction-lifecycle.test.ts tests/guarded-permission-options.test.ts tests/guarded-projection.test.ts tests/guarded-workflow.test.ts tests/automation-port.test.ts tests/v4-native-session-mgmt.test.ts tests/v4-native-model-config.test.ts tests/v4-native-interaction-background.test.ts tests/workflow-effective-selection.test.ts tests/session-selection-cold-resume.test.ts tests/v4-native-queue.test.ts
pnpm typecheck
pnpm --filter @zcode/desktop typecheck:e2e
pnpm --filter @zcode/core --filter @zcode/bootstrap --filter @zcode/cli --filter @zcode/tui typecheck
pnpm lint
pnpm architecture:check --changed
pnpm audit:conversation-session-coverage
```

### 改动量与备份

按整个工作区相对 HEAD 统计，包含 staged、unstaged 和 untracked；fixture 计入测试，功能图谱计入文档，不含构建/E2E 产物：

| 类别           | 文件 | 新增 | 删除 | 净增 |
| -------------- | ---: | ---: | ---: | ---: |
| 生产代码       |   73 | 1314 |  489 |  825 |
| 测试 / fixture |   27 | 3348 |  273 | 3075 |
| 文档 / 图谱    |    5 |  286 |    0 |  286 |

本轮相对替换前完整备份，生产部分 15 文件 +604/-663，净减 59 行；包括删除独立 approval-once.ts、收敛旧 permission-response/重判分支，以及增加统一请求/输入准备边界。保留 mode/matcher 基础能力。完整备份 stash d4e1e36e29ebc6044600bf5bd81f70bf0f6ca7ae 仍在；未恢复旧 stash、未提交或推送、未新增模型调用/数据库迁移/用户配置迁移。

历史 09-10/11 的 11 条桌面结果仅保留为旧报告（本机报告 `desktop-e2e-20260910155146785-p680-77d38a5a440d10e6`），不计入本轮验收。

## Matcher review 修复验收（2026-09-15，独立于上方审批替换记录）

- 生产代码仅修改 `guarded/command.ts`、`options.ts`、`git.ts`、`wrappers.ts`，本次 +20/-11，净增 9 行；删除 rm 查询豁免并让调用方显式声明扫描策略。审批核心、模式、协议、默认值及持久化均未修改。
- 测试先红后绿：修改实现前 7 条失败，包含 Guarded deny 却成功执行、没有用户请求、三方言漏匹配及真实 macOS rm oracle；修复后 6 suites / 182 tests 全部通过。三方言词序/wrapper 组合是 parser 合同证据，不当作 Windows 运行时证据。
- 加强已有正反例，已支持的反例明确要求 `notMatched`，不能用 `unsupported` 蒙混；补 clean/push/rsync 的参数值与真正豁免、取消优先级对照。原生 `/bin/rm` 仅删除 mkdtemp 自有目标，验证尾随帮助词确实是文件名。
- Desktop pending E2E：16/16、0 flaky、0 infra failure；rm 目标文件/目录拒绝后保留，Bash 哨兵不存在、项目规则不变、provider 收到真实拒绝；普通批准、原 YOLO、问答、普通 child 对照通过。本次报告（本机报告 `desktop-e2e-20260915112613933-p58677-ff66706217d193de`）。fixture contract check 通过，仍只有既有输出 marker `E2E_GUARDED_PARENT_DONE` warning。
- 根 `pnpm typecheck`、core typecheck、desktop E2E typecheck、根 lint（43 warnings/0 errors）、core lint（10 warnings/0 errors）、架构检查（0 violations）通过；warnings 不在本次修改文件。
- 覆盖审计仍被基线 D19/I74/I75 缩写、A-J 统计及 3 份 generated docs stale 阻断，已与 HEAD 核对；本次 pending fixture metadata 0 rejected。Windows、手机恢复、scheduler、旧二进制的未验收项保持不变，未转正或标 covered，未提交/推送。
