# Todo159：连接测试输出预算统一调整为 512 Token

状态：已实施并完成本地仓库验证。2026-11-02 用户再次确认统一为 512 并创建 MR。本轮修改仓库代码，不修改 Air 已安装版本或个人配置。

## 问题与实际证据

MacBook Air 的 ZCode 3.12.2 在设置页测试 OpenCode Go（Responses）的 `gpt-5.6-luna` 时失败。2026-09-17 18:00:03、18:00:06（Asia/Shanghai）的两次请求均返回 HTTP 400；请求包含 `reasoning.effort: "none"` 和 `max_output_tokens: 1`。

- 使用 Air 原有 Key、地址、Prompt 和请求参数复现，服务端原始错误为：`[integer_below_min_value] Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.`
- 对照请求仅将 `max_output_tokens` 改为 `16`，返回 HTTP 200、正常文本与 `response.completed`。该证据证明本次连接失败由输出预算下限触发；512 尚未实测，不能把 16 的对照结果记作 512 验收通过。
- 原始失败记录位于 Air 的 `~/.zcode/cli/log/zcode-2026-09-17.jsonl` 与 `~/.zcode/cli/rollout/model-io-sess_8c93aadb-89ce-4f3e-bee9-8aaa0de12488.jsonl`。文档不保存 Key。
- 变更前 [Core 连接测试入口](../../../../apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts) 将 `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS` 固定为 `1`；[错误归一化](../../../../apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts) 将该 400 显示为通用的 `Provider rejected the model request.`。错误文案优化不纳入本项。

## 已确认目标与边界

1. Core `testModelConnectivity()` 的独立输出预算统一从 `1` 改为以 `512` 为目标、受模型输出上限约束的 `min(512, maxOutputTokens.max)`，适用于所有 Provider 的连接测试，不增加 Luna／OpenCode 特判，不按失败动态提高预算。
2. 仍取模型公开有序推理档位首项；system `You are ZCode connectivity probe.`、user `hi` 的文本、角色及顺序保持原契约，不混入历史或工具。
3. 保留正式流与错误处理：正常 finish（含 length）即成功，允许无正文；error、缺少 finish、超时、鉴权及参数拒绝仍失败。沿用既有空响应重试，重试沿用同一已受模型上限约束的预算。
4. 仅改变连接测试预算。普通会话与 Git、标题等辅助生成预算、模型输出能力上限、用户保存的配置和选择均不变；不新增配置、协议、持久化或迁移。
5. 预算策略仍由 Core 连接测试入口唯一持有，桌面、远端 Worker 和手机 shared-host 复用既有链路，保留 workspaceIdentity、owner 与 continuous/replayable 边界。

本项取代 [Todo144](todo-144-connectivity-one-token-budget.md) 的“连接测试固定 1 Token”裁决；其余契约和历史验证记录保留。512 是本次确定的目标值，不代表已验证所有上游兼容性。

## 实施与验收

- [x] 先更新 [Settings 连接测试规格](../design/registry/settings.md)、[桌面连接测试用例说明](../../../testing/desktop-local-model-provider-p0-e2e-cases.md)中的连接测试预算描述为 512。[OpenRouter 请求契约](../../../openrouter-reasoning-request-contract.md) 的 1 Token 是独立 Adapter 兼容断言，保留原值。
- [x] 先更新 [Core 测试](../../../../apps/zcode-cli/packages/core/tests/workspace-generate-text-streaming.test.ts)，证明旧实现不满足 512，再修改生产常量。继续验证最低推理档位、固定 Prompt、无正文 stop/length 成功、流异常／缺少 finish 失败，以及 Git 辅助预算仍为 5,000。
- [x] 更新 [Adapter wire 测试](../../../../apps/zcode-cli/packages/adapters/tests/connectivity-probe-wire.test.ts)：实际序列化的 Anthropic `max_tokens`、Chat `max_completion_tokens`、Responses `max_output_tokens` 均为 512；保留协议映射、Prompt 和身份断言。
- [x] 更新 [连接测试 E2E](../../../../packages/desktop/test/e2e/settings/providers/provider-connectivity-prompt.test.ts)与 [Reasoning fallback E2E](../../../../packages/desktop/test/e2e/settings/providers/provider-reasoning-fallback.test.ts)。通过真实模型行点击验证小容量模型预算为 256、普通模型为 512，正常 finish 成功、400 仍失败、Personal／会话选择不变。三种协议使用 Adapter wire 测试覆盖，桌面交互以 Chat 代表；本轮不扩展 UI 路径。
- 真实 Air / OpenCode Go 验收保留为发布后的跟进项，不属于本轮仓库测试；不以历史 16 Token 对照代替 512 的 App 验收。
- [x] 按根及 CLI 子级规则执行相关测试、typecheck、lint、架构检查和受影响 E2E；覆盖受影响桌面／手机路径，远端或手机环境阻塞时明确记录未验证项。必要验证通过后自检 diff 并提交。

## 初版验证（2026-11-02，评审修正前）

- Core 测试先改为 512：旧实现 2 项预算断言失败、14 项通过；修改常量后 Core 16 项与 Adapter wire 6 项全部通过。覆盖最低推理档位、固定 Prompt、无正文结束、错误流，以及辅助请求预算仍为 5,000。
- 本轮仅调整连接测试策略，不将此解释为已经证明修复所有连接超时。真实 Air、手机与远端环境未重放，三协议实际序列化由本地 Adapter 测试验证。
- Linux 桌面 E2E 2/2 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261102-073003-102`：真实模型行点击的预算为 512，无正文 length 成功、400 失败、配置及选择保持不变；未知型号保存后的连接测试同样为 512。首轮因指定 ChromeDriver 缓存缺失未进入用例，指定现有同主版本驱动后通过。
- 根与 CLI typecheck、desktop typecheck:e2e、根与 CLI lint、架构检查、修改文件格式检查通过；根 lint 218 条、CLI lint 71 条已有警告，无错误。受影响工程测试选择 0 项，CLI 定向测试与桌面 E2E 如上。

## 评审修正：尊重模型输出上限

固定绑定 512 会让上限小于 512 的合法模型在真实 Model.bind 范围校验时失败，尚未发送网络请求。预算在 Core 绑定前取目标值与模型上限的较小值；不修改模型能力或保存的配置。Core 回归覆盖上限 1、256、512、1024；C91-04 使用上限 256 的真实 Model 验证请求到达本地服务，Todo95 继续验证普通模型使用 512。

验证：修改前上限 1、256 的两条 Core 断言失败，17 项通过；修复后 Core 19 项与 Adapter wire 6 项通过。Linux 桌面两个正式 E2E 2/2 通过（`packages/desktop/.e2e-artifacts/desktop-e2e-20261102-080152-340`），小容量模型真实请求预算为 256，普通模型仍为 512；成功、400 失败和配置隔离断言通过。根与 CLI 类型/lint、desktop E2E 类型、架构、格式、文档检查通过；受影响工程测试选择 0 项。真实 Air、手机及远端实机未重放。
