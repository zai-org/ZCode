# 用户反馈与工单上传隐私优化实施计划

> 2026-09-29 默认值更新：按用户要求，新反馈日志默认勾选，可手动取消；FB-PRIV-01/08 改验默认开启与可取消，FB-PRIV-02 保留提交时选择及后台恢复断言。本文默认值与验收矩阵已同步，当前默认行为以 `docs/feedback-simplified-flow.md` 为准，日志收集与脱敏边界不变。

> 状态：实现及客户端验证完成，尚未发布。分支 `codex/sensitive-upload-privacy`，基线 `efcec33905`。

**目标：** 工单只携带用户确认的描述/联系方式/图片和必要设备信息；可选日志默认开启、可取消，明确限制收集范围，并保证所有反馈归档路径统一脱敏。
**架构：** shared 提供无 I/O 的反馈文本脱敏策略；services 的反馈域唯一维护诊断归档收集、过滤、脱敏、ZIP 和清理；desktop 注入额外诊断日志来源；UI 只负责展示草稿和提交选择。保留现有工单/附件协议及后台任务 owner。
**技术：** TypeScript、Node fs/promises、yazl、React、Vitest、Electron E2E。

## 范围与决策

用户已明确“先不动这里，只看用户反馈/工单上报这里”：仓库快照、自动遥测、模型请求、远控协议均不修改。代码变更层包括 draft-default、validation、commit-effect、presentation。隐私工程优化不能替代服务端留存期限、访问授权、删除机制与法务确认。

- 新反馈日志默认开启、可取消；所有帮助、任务、错误、远程连接入口一致，显式取消和恢复草稿中的 false 不得被覆盖。恢复同一后台 job 保留用户在提交时的选择。
- 不在打开反馈时自动截图。保留选择文件、粘贴、拖拽、预览和删除；图片内容由用户检查，文案明确提示。
- 上传归档只接受 app `logs/`、desktop CLI `log/`、CUA `*.exit.log` 中当天的文本日志；排除数据库、配置、rollout、会话正文、二进制和符号链接。备用实现遵循相同策略，缺少来源时省略。
- 单文件最多 8 MiB、完整包输入最多 32 MiB，compact 最多 2 MiB；超过限制跳过，不截断后泄露半个结构。遍历深度/数量有界。
- 结构化日志递归删除密钥、正文/消息/工具输入输出等字段，文本识别常见凭证、私钥、URL 凭证与用户目录；编码不支持、二进制、不可读都跳过，绝不复制原始文件兜底。
- 自动排障模板先脱敏；移除隐藏追加的模型配置列表。用户正文和联系字段保持用户意图，服务端发送前对标题/描述中的常见凭证补一道保护，不改用户主动提供的联系方式。
- 本地手动“导出日志”保留原契约；它不再作为反馈上传的全量来源。

## 影响简报

| UI 入口                                         | 草稿 owner / 默认                                               | 提交 / 权威 owner                                            | 模式与不变量                                            |
| ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| 帮助菜单、任务菜单、聊天/订阅错误、远程连接失败 | feedbackStore → FeedbackSubmitForm；日志 true（可取消）、图片空 | feedbackSubmissionJob → feedbackService → FeedbackHttpClient | desktop 使用本地服务；mobile unsupported 仍保持现有边界 |
| 新建反馈 / 功能建议                             | 各自草稿：新反馈默认开启日志，独立功能建议不附带日志            | 同上                                                         | 用户可编辑描述并检查附件                                |
| 后台任务恢复                                    | job.formDraft 提交时快照                                        | job registry，按 jobId 定位                                  | 不影响其他 job，不重新采集截图                          |
| 补充工单                                        | 用户手选附件和文本                                              | feedbackService                                              | 不新增自动采集                                          |
| 本地导出日志                                    | 用户显式导出                                                    | desktop exportLogs                                           | 不受反馈来源白名单影响                                  |

必查关系：UI 默认/自动截图 → job.includeLogs → prepareCompactLogArchive → desktop 注入 / services fallback → ZIP → uploadFile；自动上下文 → create/comment HTTP。状态 owner 保持现有分层，无新队列。登录 token/deviceMid 用于既有身份认证，不写入日志归档。

Codegraph 工具当前不可用；以精确源码调用点与 rg 交叉验证上述两层调用关系（深度 2），不把所有静态可达项视为业务影响。功能图对反馈上传缺少专门节点，记录为 graph-drift-candidate；`.agents` 当前只读，建议后续登记该上传边界，不以图谱维护阻塞修复。

## 实施步骤

1. **规格和用例（本文件及已有 feedback spec）**：更新默认值/归档范围/截图/自动上下文；列明允许与禁止的数据、兼容边界及用例。完成后才改代码。
2. **回归先行**：在 shared 新增反馈文本脱敏用例；services `compactLogArchive.test.ts` 新增嵌套 JSON、数据库/rollout、二进制/链接、过期/过大文件、ZIP 字节内容检查；desktop `exportLogs.test.ts` 更新反馈断言、保留手动导出断言；UI 覆盖默认开启、取消后提交与各入口、后台恢复。先运行并记录预期失败。
3. **统一反馈归档**：新增 services `feedbackLogArchive.ts` 和 shared `feedbackPrivacy.ts`；compact/full fallback 与 desktop 反馈注入调用同一个 builder；有界异步读文件、脱敏后写 ZIP、异常清理。原有手动 export 保持独立。
4. **表单与工单**：统一问题反馈入口默认开启、可取消，不自动截图；更新中英文隐私提示；移除隐藏模型列表、清洗自动模板和服务端文本出口，清理附件文件名路径部分。
5. **集成验证与复核**：合成敏感标记检查解压后的所有内容；工单请求使用 mock，不提交真实反馈。运行受影响 Vitest、typecheck、lint、architecture:check --changed；desktop/mobile 共享表单交互按 E2E 能力验证。出现环境阻塞明确记录，不宣称已覆盖。
6. **交付**：检查 diff 与引用、确认没有快照/遥测改动；必要验证全过才本地 Conventional Commit；不 push、不创建 MR。

## 验收矩阵与 E2E 交接

| Case ID    | 状态/动作                                       | 断言                                                                          | 证据                        |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| FB-PRIV-01 | 新反馈、各自动入口                              | 日志默认开启且可取消、无自动 capture 调用                                     | UI 测试 + E2E               |
| FB-PRIV-02 | 默认提交 / 取消后提交 / 恢复后台任务            | 只上传本次选中附件，恢复保留原选择                                            | job/UI 测试 + 服务 mock E2E |
| FB-PRIV-03 | full/compact/desktop 归档                       | SQLite、配置、rollout、symlink、binary、过期/过大文件不出现                   | 临时目录 + ZIP 解压         |
| FB-PRIV-04 | 嵌套 JSON/转义字符串/多行私钥/Authorization/URL | 合成 secret 不出现在任何 ZIP entry                                            | shared + ZIP 回归           |
| FB-PRIV-05 | 诊断含 prompt/messages/tool data                | 正文被移除，事件类型/错误码/计数可用                                          | 文本脱敏测试                |
| FB-PRIV-06 | 工单创建与补充                                  | title/description 常见凭证清洗；用户 contact 和显式正文意图保留；不带模型列表 | service/UI mock HTTP        |
| FB-PRIV-07 | 本地导出/取消/失败                              | 手动导出兼容；归档失败清理；创建取消不触发附件                                | 既有回归                    |
| FB-PRIV-08 | 桌面/手机、中文/英文                            | 开关含义和提示一致、窄屏可访问；手机 unsupported 不变                         | 共享 UI + E2E               |

主维度：来源 desktop/fallback、日志 default-on/off/restored、文件文本/二进制/链接/过期/超限、授权新建/后台恢复、语言/视口。剪枝：仓库快照和遥测按用户指示 excluded；不做模型 provider 全笛卡尔积，上传隐私策略与 provider 无关；截图像素自动识别不在范围，通过主动选择与预览提示约束。E2E 使用本地 mock 服务和临时日志目录，不接触真实账户/工单；新增用例仅 manual-review/pending，不自动转正。

FB-PRIV-02 补充：在隔离 Chromium 窗口挂载真实 `FeedbackSubmitForm`、提交 helper 和后台 job，只替换 `IFeedbackService` 为内存 mock。默认提交必须调用归档与 log 上传；取消后提交必须零归档/上传；真实 job 创建失败后卸载并按 jobId 恢复，再次提交时保持原 true/false。以 job 终态确认零调用，不能只等待短暂超时。该用例验证 Renderer 到服务边界，不宣称覆盖真实 HTTP/OSS 或手机远控。

2026-10-19 正式迁移复验：真实表单的两条用例已通过首轮断言，FB-PRIV-02 的打包前置因仓库根路径沿用 pending 目录深度而失败。
按正式目录修正根路径，先验证 esbuild 可解析真实表单入口，再重放整份用例；不改表单或服务行为。

## 待外部确认

服务端工单/OSS 留存、删除、访问审计和跨地域存储不在本客户端仓库可验证范围。客户端按已确认的默认开启、可取消行为实施；不替代服务端或隐私审批结论。

### E2E 用例落点

`packages/desktop/test/e2e/feedback/upload/feedback-upload-privacy.test.ts` 验证 FB-PRIV-01/02/08：FB-PRIV-01/08 通过真实帮助菜单打开表单，检查日志默认开启、用户可取消、无自动图片，并在宽窄窗口及中英文下重复执行；FB-PRIV-02 在隔离 Chromium 中使用真实表单/helper/job 和内存 `IFeedbackService` mock，验证默认提交、取消提交及按 jobId 恢复重试时的日志选择与服务调用，不覆盖真实 HTTP/OSS。复用 help client/config 本机 fixture；不创建真实工单或模型请求。手机远控服务仍 unsupported，窄视口只作为共享 UI 响应式证据，不宣称远控端到端上传覆盖。

## 初次实现的验证记录（2026-09-18）

- 已完成统一归档、反馈文本脱敏、入口授权默认值、截图行为、模型列表最小化与附件临时路径隔离；仓库快照和自动遥测无改动。
- 回归先记录预期失败，再完成实现。合成数据覆盖 JSON/JSONL、UTF-16、嵌套密钥、正文、文件白名单、容量和链接边界；使用 mock 检查请求，不上传真实用户数据。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 有 55 项存量警告，无错误。`git diff --check` 通过。
- 受影响单测 25 个文件、140 个用例全部通过；桌面反馈 E2E 的 2 个用例通过，覆盖 1280px 英文、430px 中文及各自深浅主题，截图已检查。新 E2E 保留 manual-review/pending，未转正。
- 本地依赖与锁文件曾不一致，按冻结锁文件重新安装后通过构建；依赖声明和锁文件均未修改。手机远控工单上传仍为原有 unsupported，未宣称手机真实上传验证。
- 服务端权限、留存和删除尚未验证；自动脱敏仍不能识别任意业务秘密，用户主动选择图片时仍须自行检查。
