# App 单测退役规格

## 决定与范围

2026-10-26：App 全链路不再维护独立业务单测。删除桌面、UI、services、共享协议、
Web、Provider、RPC、Client、Server 和 Source Server 中的业务 test/spec 文件，
包括源码旁未注册测试和模块 contract.test.ts。此次按归属退役，不逐项宣称测试没有价值。
产品运行时代码与产品行为不变。

保留 Agent CLI（apps/zcode-cli）、CUA producer（packages/zcode-cua）、桌面 E2E、
浏览器验收、Android 设备验收，以及构建、发布、架构、数据库 schema、E2E 工具等工程测试。
工程测试按被测对象判断，不能因为它位于 packages/desktop/test 就删除。
工程 Vitest 文件使用显式清单注册，禁止重新使用 packages/\*/test 的业务单测通配符。

## 执行入口

- 移除 App 的 test、test:unit、test:unit:affected、test:coverage 命令；工程 affected 选择器限定在工程项目。
- 保留独立 test:engineering（Vitest 工程检查）、test:architecture、db:schema:check、
  CLI/CUA 自有测试命令与现有 E2E 入口。根 Vitest 配置只注册工程测试和 CUA。
- 根 `pnpm typecheck` 纳入 `packages/desktop/tsconfig.renderer-services.json`，检查 Renderer 的远程服务装配是否满足共享接口；工程回归验证该文件确实被根命令及其项目引用覆盖。该窄工程不宣称覆盖完整 Renderer，后者仍由 `tsconfig.renderer.json` 单独检查。
- pre-push 保留工作区干净、非删除目标解析为 HEAD commit、Lint、schema、架构检查及受影响工程测试；不选择或执行 App 单测。
- 例外：守隐私或安全边界的定向取样，可以作为按路径触发的 MR CI job 自动执行（不进 pre-push，也不进工程 Vitest 清单），
  如 `test:auto-update-source-security`、`test:project-token-retry-after`。
  `test:agent-crash-diagnostic`（`.gitlab/ci/23-agent-crash-diagnostic.yml`）运行
  `packages/desktop/test/agent-crash-diagnostic.node.test.ts`：Agent 退出诊断与上报 ARMS 前的 stderr 凭据遮盖；
  0xE0000008 在 Linux 上无法由真实进程产生，只能对纯函数取样。
  架构与工程测试继续接收 push ref 信息并使用真实 Git 基线；附注标签先剥离到 commit。
  工程选择沿用 Vitest 官方依赖图，仅选择 engineering 项目；无关联或全量选择时明确报告未执行，
  全量选择仍按既有规则跳过，不据此宣称测试通过；显式全量使用 test:engineering。
- 移除只用于 App 单测的 lint-staged 接线、coverage 配置和禁用的 CI 单测 job。
  Vitest 及其修补若仍被工程、CLI 或 CUA 使用，继续保留。

## 架构和开发规则

managed 模块必需文件改为 module.ts、contract.ts、contract.example.ts、CONTRACT.md。
架构检查继续校验模块依赖、分层、公开入口、循环和源码规模；不再要求或自动生成 contract.test.ts。
生成器不得删除已有测试；CLI/CUA 的独立测试规则保持有效。

App 行为改动先更新 spec，再用既有 E2E、浏览器验收或可重复运行时场景验证；交互改动仍必须维护 E2E。
不为删除的单测逐条新建 E2E，也不把原单测覆盖自动标成 E2E 已覆盖。
工程工具有行为改动时先改其工程回归测试，再改实现。

## 共享资源与覆盖证据

删除测试专用 helper、mock、snapshot、依赖和配置前检查保留消费者。
E2E 使用的 shared/test/fixtures/fake-relay-v2、UI 浏览器和 workflow 夹具继续保留；
同样保护 CLI/CUA 引用、构建资源及包 exports。

覆盖矩阵和功能图谱只声明现行验证证据。旧 spec、历史运行记录及 unit-test-review 账本中的
App 单测路径属于退役前证据，不表示当前仍有该覆盖；历史用例数和通过记录不改写。
机器读取的现行自动化索引、精确路径白名单、roadmap 和派生统计必须同步移除退役证据；
唯一证据退役的场景明确记为 missing / ready-to-write，不继续声明 partial / implemented。
保留的 CLI/CUA 证据按完整路径确认归属，不能因同名 App 文件删除而标成退役。
现行覆盖矩阵中的退役证据逐处使用 `retired:原路径` 标记，不能只写顶部说明；
只有退役证据的状态行改为 unit-retired / missing，混合证据保留其实际剩余覆盖。
覆盖审计扫描全部 coverage matrix 的正文、任意长度别名和状态行，不以主路径 ID 长度限制退役检查。

## 验收

1. 记录起点，固定业务删除清单与工程保留清单；检查 CLI/CUA/E2E 和产品运行时文件未被删除或改写。
2. 先验证架构检查器不要求 contract.test.ts，生成器不再生成它，并仍拒绝缺少其它契约文件的模块。
3. 校验保留测试的导入、文件资源、配置与命令；清除失效的执行入口和测试专用依赖。
4. 执行 typecheck、lint、architecture:check --changed、变更格式检查、schema 检查和受影响工程测试。
   验证 Vitest 注册清单不含 App 业务测试，E2E 夹具仍可类型检查；有修改 E2E 接线时执行对应 E2E。
5. 保留测试未执行或环境受限时如实说明，不能以没有测试可选当作通过。必要检查通过后本地 commit。

历史逐文件质量审查规则和清理记录可从本文件 Git 历史读取；不再用旧规则要求恢复 App 单测。
