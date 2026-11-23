# MR、版本与动态配置交付

本页解释模板/模型配置怎样交付，不授权维护者自动发布。创建 MR、合并、版本发布、修改在线配置指针是不同动作，各自保留结果和责任。

## Git 与 MR

正式配置是唯一编辑源，测试配置和必要文档/测试同一 MR 提交。内容变更使用新的 revision；两份环境文件保持相同 revision，但内容按各自环境派生。合并冲突后重新检查上游最新 revision，不能只解决文本冲突而复用已经被不同内容占用的版本号。

MR 说明至少列出模板与型号增删、默认启停、能力/Map/URL 的具体差异、正式/测试派生结果、官方证据、真实验证及缺口、旧实例/选择影响、交付方式与回退方案。内容按以下五章组织：

| 章节       | 本领域应说明的内容                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| TL;DR      | 具体问题与改变后的行为；真实文件数及增删行数                                                           |
| 目标       | 背景、原有行为、接入或修正的入口/型号、设计意图和验收条件；bugfix 附根因证据、反馈关联与本目录工作记录 |
| 改动范围   | 正式/测试配置、代码、测试、本目录规范与库存的实际变化，以及非目标                                      |
| 验证       | 实际命令及结果，Key/地区/套餐/协议矩阵，未验证项；bugfix 对应回归用例，有交互变化时附证据              |
| 风险与回滚 | 旧实例、个人覆盖、目标客户端版本、上线方式和恢复方案                                                   |

提交标题采用 `<type>(<scope>): <subject>`，例如文档整理使用 `docs(provider)`；内容变更与纯文档区分。文件规模来自 `git diff --shortstat origin/staging...HEAD`，描述契约以仓库 `zcode-mr` skill 为准，不能编造根因、反馈关联或验证结果。

创建/更新 MR 使用仓库 `zcode-mr` 工具：在干净的特性分支先运行 `python3 .agents/skills/zcode-mr/scripts/zcode_git_workflow.py setup` 检查认证，将五章描述写入临时 UTF-8 文件，再运行 `python3 .agents/skills/zcode-mr/scripts/zcode_git_workflow.py mr --description-file <描述文件> staging`。工具会保留 push hook、查找同源/目标 MR 并只在缺少时创建。检查返回的真实 MR URL；仅生成预填链接不算创建成功。已有 MR 的正文变化还需通过 glab 更新并核对。认证失败保留本地成果，不把凭据写入描述或命令。

普通目录改动走配置 MR；新协议、Access、Adapter、Logo 资源或 UI 行为需要对应代码和测试，不能以“只是模型更新”省略检查。缺 Key 的变更在 MR 中清楚保留真实 API 待验证项，默认启用按维护范围原则决定，不把缺 Key 作为额外例外审批事项。

## 选择交付方式

| 情况                                                              | 交付方式与条件                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 常规模板/模型维护                                                 | 随产品版本携带完整配置，验证最终包资源                                        |
| 仅使用目标客户端已经支持的字段、协议和能力，确需提前更新目录/规则 | 可评估动态配置；仍来自已审查 Git 内容和最终文件验证                           |
| 新 Schema/Access/协议、Adapter 行为、图片资源或 UI 能力           | 先交付客户端能力；不能仅推 JSON 给旧客户端                                    |
| 已上线内容错误                                                    | 纠正后的内容以更高 revision 发布；同时修复 Git/包内基线，避免两条链路长期分叉 |

`schemaVersion=1` 相同不证明所有旧客户端都理解新字段、值或 Map。动态更新前对目标产品版本/平台确认实际 decoder、Adapter 和已知行为；不得只在开发分支验证。灰度、版本分流、执行人和权限以实际控制面为准，本仓库未提供可假定存在的一键配置发布/自动回滚工具。

## 随版本交付

1. 合并后的正式源和派生测试源分别通过检查。
2. 按真实 `ZCODE_ENV` 构建，检查实际包内/嵌入内容的 revision、hash 和目标模板，不只看源码。环境选源、Desktop/CLI/SEA/Server 资源位置及缓存要求见本目录[配置规范](./configuration.md#构建选源与最终资源)。
3. 记录包含该提交的产品版本与测试/生产产物，确认安装后目标 Host 采用的配置；已有更高 revision 的有效缓存可能继续优先，不能仅因包升级就推断生效。
4. 按本次变更检查新增实例与已有继承实例、个人覆盖和模型实际请求。记录未覆盖的平台/远程模式。

## 必要时动态上线

现有客户端使用两阶段下载：控制面 `/api/v1/client/configs` 按 app_version/platform 返回 `data.configs.builtin_provider_config_json`，该字段是 HTTP 或 HTTPS 下载 URL；URL 内容是完整 Release。没有该字段表示本次无发布，不清空已有配置。

```mermaid
sequenceDiagram
    participant M as 维护/发布方
    participant C as 控制面与CDN
    participant H as Host或独立CLI
    participant R as Registry
    M->>M: 核验Git内容、目标客户端、最终文件和hash
    M->>C: 上传新的版本化URL
    M->>C: 下载比对成功后更新对应环境/版本指针
    H->>C: 获取URL并下载完整Release
    H->>H: 校验版本并原子更新Active
    H->>R: 等Account与Builtin版本对齐后发布完整组合
    M->>H: 核验采用revision与实际新建Model请求
```

操作顺序：

1. 确认必要性、目标客户端/平台、正式或测试环境、发布责任与授权，记录前一内容和恢复方案。
2. 从待交付 Git 内容准备最终文件，对该文件执行 Decoder、完整性及本次规则/请求验证，记录 hash。正式与测试分别验证和投递；同 revision 的两份文件不可混用。
3. 上传**新的 URL**，下载后核对 hash/完整内容，再切换对应控制面指针。不覆盖长期缓存的旧 URL，不临时在线手改 JSON 绕开 Git。
4. 验证实际客户端的下载结果、Active revision、完整 Registry 和后续创建 Model 的请求。成功下载不是成功采用，页面列表变化也不代表所有调用方已更新。
5. 观察受影响入口的鉴权、参数拒绝、工具流和用户反馈；按下述边界恢复。记录采用证据，更新工作项交付状态。

正式、测试环境以及 App Host、独立 CLI 共用下载器，均允许 HTTP / HTTPS；正式交付使用维护者配置的 HTTPS 地址，HTTP 保留给临时测试等场景；客户端不按环境强制分流。URL 不允许 userinfo，不跟随重定向，不携带账号 Token/Key；两次请求总预算 20 秒，正文按实际字节限制为 10,000,000。以[下载实现](../../packages/provider-node/src/zcode-builtin-download.ts)为准，不复制一套发布客户端。

HTTP 支持属于客户端代码能力，不能通过修改远端 JSON 让旧客户端解除 HTTPS 限制；发布 HTTP 地址前需按客户端版本确认支持范围。本次不新增环境开关，不自动切换协议。HTTP 下载失败与 HTTPS 一样保留有效本地配置。

2026-10-28 合入测试退役前的验证记录（相关 App 单测现已退役，桌面 E2E 和 CLI 测试保留）：共用下载边界及失败保留专项 28 项、独立 CLI Registry 12 项通过；真实 HTTP socket 覆盖正文超时取消和随后成功下载。桌面 BR117-F01 已验证 HTTP 下载请求实际到达并返回 500 后，Team 切换和 Start 模型选择仍成功。没有改动配置内容或 revision，也未切换线上下载地址。

## 生效与恢复边界

- 启动在兼容有效的包内/Active 候选中选较高 revision；在线低版本忽略，同版本同内容不变，同版本不同内容拒绝。启动遇到同号缓存内容冲突会回包内可信候选。
- Provider 与 Model 规则整体替换；结构合法不保证业务正确。下载失败保留基线，不承诺错误业务配置会自动回滚。
- Host/独立 CLI 持有刷新；每分钟检查一次。成功后的下载间隔取第一跳响应 `clientConfigRefreshIntervalSeconds`（60–3600 秒，缺省一小时），从本轮开始计时，到期判断有 5 秒容差，配成 60 秒时每分钟实际刷新一次。失败按分钟指数退避至一小时。手动 force 绕到期限制，不绕有效 lease；同进程内普通刷新在途时，force 等它结束后再强制刷新一次（在途的普通刷新可能复用 URL 跳过 CDN），并发的 force 合并为这一次。
- 第一跳每轮都请求；`builtin_provider_config_json` 与上次成功下载的 URL 相同且距上次下载不足一小时时跳过 CDN，记为 unchanged。“一小时”与到期判断使用同一 5 秒容差，否则一小时间隔的轮次略早到达时会再推迟一小时。URL 变化、超过一小时或手动 force 时重新下载。控制文件额外记录 `releaseUrl`、`releaseDownloadedAt`，缺失时按需下载，不影响 revision 判定。因此发布新配置必须换新 URL（见上文操作顺序第 3 步），否则最长一小时后才生效。
- 缓存按平台、App 版本、控制面 Endpoint 隔离；换 CDN URL 不重置来源版本。测试/正式不能只凭相同 revision 判断内容一致。
- Managed Worker 不独立下载；手机使用目标 Host。Builtin 与 Account 未对齐时保留上一份完整 Registry，不能把状态混合发布。
- Personal 意图不被覆盖，已有执行 Model 不原地变更；不要承诺当前请求或所有存量运行立即切换。
- 回退发布**更高 revision 的已验证旧行为/纠正内容**。仅把 URL 指回低 revision 不能让已经升级的客户端回退；客户端代码不兼容则需要修正版客户端或经过验证的投放限制。

实现核验：[Release Source](../../packages/provider-node/src/zcode-builtin-provider-config-source.ts)、[刷新协调](../../packages/provider-node/src/zcode-builtin-remote-synchronizer.ts)、[Registry 版本配对](../../packages/provider/src/registry-service.ts)。本轮没有查询当前线上指针；任何历史线上 revision 都不能代替今天的生产状态。

### 刷新节奏验收

| ID     | 前置 → 操作                                     | 断言                                                                        |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------- |
| BIR-01 | 第一跳间隔 60 秒，URL 不变 → 等两轮；再换新 URL | 第一跳约每 60 秒一次；URL 不变的一轮不请求 CDN；新 URL 在一个间隔内自动生效 |
| BIR-02 | 接 BIR-01，URL 不变 → 在设置页点“刷新”          | 同一 URL 的 CDN 被重新下载                                                  |

- E2E：`packages/desktop/test/e2e/settings/providers/manual-review/pending/provider-builtin-refresh-cadence.test.ts`（manual-review，未进 CI）。用例不发模型请求，但 manual-review 且无 case-local fixture 时默认走 capture，需显式 replay：`E2E_PROVIDER_HTTP_MODE=replay E2E_PROVIDER_REPLAY_FIXTURE_PATH=<仓库>/packages/desktop/test/e2e/fixtures/upstream/common.json pnpm test:e2e -- --spec <上述文件>`。
- 节奏细节由 CLI 测试 `apps/zcode-cli/packages/bootstrap/tests/process-provider-builtin-refresh-cadence.test.ts` 覆盖：到期容差、URL 复用与一小时兜底（含略早到达的轮次）、普通刷新在途时的 force、间隔上下限、撤销与失败退避、独立 CLI 排期。
