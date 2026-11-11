# Todo144：连接测试独立使用 1 Token 输出预算

状态：已完成实现与验证；2026-09-15 补齐 Pro 桌面 E2E、定向单测与复审。2026-09-12 用户已确认并授权实施。

后续裁决（2026-09-17）：Air 的 OpenCode Go Luna 实测拒绝 1 Token，要求至少 16；用户已确认统一调整连接测试预算为 512，实施入口见 [Todo159](todo-159-connectivity-512-token-budget.md)。下文保留原实现与验证历史；512 已于 2026-11-02 实施，并受模型输出上限约束，真实 Air / OpenCode Go 验收待跟进。

## 裁决与边界

- 连接测试不是内容生成，不再复用 `auxiliaryModelOptions()` 的 5,000 Token 预算；在 Core `testModelConnectivity()` 独立绑定 `maxOutputTokens: 1`，仍取模型公开有序推理档位的首项。
- 固定 system `You are ZCode connectivity probe.` 与 user `hi` 原样保留，不改提示词、角色、模型配置或用户保存的选择。
- 消费完整正式 Model 流。正常 finish（含达到输出上限 length）即成功，允许无正文、只有 reasoning；仅开始响应但缺少 finish、error event、鉴权/参数拒绝、超时等仍失败。不吞错误，不自动提高预算重试。
- Git、标题等其他辅助调用的预算不变。无新配置、协议、持久化或迁移，无 Provider 特判。
- 部分上游可能拒绝 1 Token 或存在 thinking budget 约束，按正式错误边界报告；不声称支持所有供应商，也不承诺缩短排队/首响应耗时。
- 沿用正式 Adapter 的空响应重试：无正文、无推理且无用量的非 stop 结束可能重试一次，预算始终为 1；不在本项修改通用重试策略。E2E 的单次无正文成功场景明确返回 completion_tokens=1，区别于零用量空响应。

```text
设置页点击 -> 既有 Service/目标 Worker -> Core 创建本次 Model
  -> 最低档位 + 1 Token -> 原有鉴权/签名/Adapter -> 消费完整流
                                                     |- 正常 finish -> 成功（允许无正文）
                                                     `- 报错/无 finish -> 失败
```

唯一策略归属 Core 连接测试入口；桌面本地、远端 Worker 和手机 shared-host 复用既有调用链，不改变 continuous/replayable、owner、工作区身份或正在执行的 Model。

## 验收

- Core：先红后绿验证固定 1 Token、最低推理档位、无正文 stop/length 成功、流异常/缺少 finish 失败、提示词不变；保留 Git 辅助预算断言。
- Adapter：三类协议的最终输出预算字段均为 1，既有固定提示词/身份断言保留。
- E2E：扩展 pending `provider-connectivity-prompt.test.ts`；真实模型行点击，loopback 返回无正文 length，UI 显示成功；400 仍显示失败；最终 wire 预算为 1，Personal/会话选择不变。仅隔离测试，不改 Air 数据或发起真实账号请求。
- 合批运行相关测试、typecheck、lint、架构检查，再 review 和提交；未实测的上游兼容性如实记录。

## 实施与复审记录

- 分支 `connectivity-one-token`。生产仅修改 Core 连接测试入口，命名常量为 1，最低档位保持；未改 `auxiliaryModelOptions()`、Prompt、流结束/报错逻辑、配置或协议。
- TDD：旧实现预算断言 3 项失败，修改后 Core + Adapter 26/26 通过。补充无正文 stop/length 成功及 Git 仍为 5,000 的回归断言；原流抛错、error event、无 finish 失败断言继续通过。
- 三类最终字段验证：Anthropic `max_tokens=1`，Chat `max_completion_tokens=1`，Responses `max_output_tokens=1`；不把 SDK 参数名当作所有协议通用字段。同步更新 reasoning-fallback E2E 的旧 5,000 断言。
- `pnpm typecheck`、Core typecheck、Desktop `typecheck:e2e`、格式检查、`git diff --check` 通过；根 lint 0 errors / 42 既有 warnings；架构 0 violations。
- 桌面 E2E 使用新构建，首轮 `desktop-e2e-20260912-175609-167` 在创建 WebDriver session 时退出，测试尚未执行。启用 X11/禁用 GPU 的本地兼容启动与日志诊断仍失败；隔离目录直接启动同一 Electron 复现 SIGTRAP（退出码 133），尚未归因，不作为本次功能失败，也不冒称 E2E 通过。Pro SSH 认证后命令无输出退出 1，未能补跑。
- 依照仓库“交互 E2E 通过后再提交”的要求，暂不提交；待可用桌面环境跑通已更新的 pending 用例后收口。未修改 Air 配置、未向真实账号发起探测；真实供应商对 1 Token 的兼容性仍未实测。

## 2026-09-15 补验收

- 上述桌面环境阻塞已解除：Pro 隔离仓库重新构建 Electron 与 CLI，两个 pending spec 联合通过（2/2），run：`desktop-e2e-20260915073727784-p67110-e4267aabc5aa16a0`。产物在 Pro `/Users/dev/Desktop/projects/Z.AI/todo151-pro.hGJ5yI/repo/packages/desktop/.e2e-artifacts/` 对应 run 目录。
- C91-04 验证真实模型行点击、无正文且用量为 1 的 length 成功、400 失败、固定 Prompt 和 wire 预算、配置/选择不变。Todo95 验证 UI 添加仅 high 档位后，正式请求使用 high 且预算为 1。
- 首轮失败均已定位：无用量 fixture 触发现有空响应重试；旧 Todo95 用例仍依赖智能开关/档位在基础区，以及未知型号仅有 disabled 的旧默认。只修正 fixture 和真实 UI 操作，未修改通用重试、产品布局或模型默认规则。
- Core + Adapter 26/26、Service + UI 目标路由 8/8 通过；根 typecheck、Core typecheck、Desktop typecheck:e2e 通过；lint 0 errors / 42 既有 warnings，架构 0 violations，格式与 diff 检查通过。
- 复审：产品改动仍仅 Core 探测预算绑定；Git 等辅助预算不变，Prompt、鉴权、签名、流错误语义、配置和持久化均不变。手机/远端未实机补测；真实上游对 1 Token 的限制未实测，不据此宣称所有供应商均兼容。
