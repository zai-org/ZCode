# Git Commit Dialog E2E Coverage

更新时间：2026-07-07

## Feature Summary

本轮需求把顶部 Git 写操作收敛为“提交或推送”主入口，并把提交弹窗改成紧凑、键盘优先的手动提交流程：自动生成提交信息只负责填充输入框，提交 / 提交并推送 / 推送由用户在底部 Command 动作区手动触发。

## UI Operation Inventory

| ID | UI 操作 | 期望行为 | 证据层 |
| --- | --- | --- | --- |
| GCD01 | 点击顶部 Git “提交或推送”主按钮 | dirty 仓库打开提交弹窗；按钮右侧不再出现三点下拉 | DOM / dialog |
| GCD02 | 打开提交弹窗 | 显示标准 overlay；弹窗宽度为紧凑 `max-w-md`；顶部显示当前分支和 `+/-` 统计 | DOM / layout |
| GCD03 | 弹窗内容加载完成 | 自动聚焦提交信息输入框 | activeElement |
| GCD04 | 点击顶部当前分支 | 展开可切换分支列表；提交弹窗不显示分支 footer 操作 | DOM / branch list |
| GCD05 | 手动输入提交信息 | 输入框保留焦点和输入内容 | DOM value |
| GCD06 | 点击右下角 Sparkles 生成按钮 | 只生成并填充提交信息，不自动提交 | service / DOM value |
| GCD07 | 切换“包含未暂存的更改” | checkbox 使用 shadcn 风格；开关会影响文件计数和后续 stage/commit scope | DOM / service payload |
| GCD08 | 聚焦提交信息输入框时按 ArrowDown / ArrowUp | 下方 Command 选中动作在“提交 / 提交并推送 / 推送”之间切换 | DOM selected state |
| GCD09 | 聚焦底部 Command 时按 ArrowDown / ArrowUp | 同样切换选中动作；不显示对号，只显示选中项快捷键 badge | DOM selected state |
| GCD10 | 按主快捷键 + Enter | macOS 使用 Command+Enter，Windows/Linux 使用 Ctrl+Enter，触发当前选中动作 | keyboard / service call |
| GCD11 | 选择“提交” | 必须手动提交；如果输入为空才先生成 Conventional Commit message 后提交 | service call / git state |
| GCD12 | 选择“提交并推送” | 成功提交后立即 push 当前分支 | service call / git state |
| GCD13 | clean 且 ahead 仓库点击主按钮 | 主按钮变为推送路径，打开推送弹窗 | DOM / service call |

## Pruning Decisions

| Candidate | Decision | Reason |
| --- | --- | --- |
| GCD01/GCD02/GCD03/GCD04/GCD05/GCD07/GCD08/GCD09 | accepted | 纯 UI / 本地 Git 状态可稳定构造，不需要 provider 请求或远端 remote |
| GCD06 | planned | 需要 case-local provider replay 或 manual capture；不能混进纯 UI case |
| GCD10 | planned | 需要验证平台快捷键映射和动作触发；适合单独做 no-push commit service 断言 |
| GCD11 | planned | 会改变 Git 历史，应单独构造 disposable repo 并断言 commit message / staged paths |
| GCD12/GCD13 | planned | 需要 remote/upstream fixture，不能和提交弹窗基础 UI 混测 |

## E2E Case Plan

| Case | Path | Status | Setup | Action | Assert |
| --- | --- | --- | --- | --- | --- |
| GCD-UI-01 | `packages/desktop/test/e2e/git/commit/git-commit-dialog-ui-flow.test.ts` | formal | WDIO 启动前把默认 workspace 初始化为 Git repo，包含 staged、unstaged 和第二个本地分支 | 打开提交弹窗，输入提交信息，切换 checkbox，方向键切换 Command，展开分支列表 | 弹窗 overlay 存在，输入框自动聚焦，按钮 / checkbox / Command / branch list 状态符合预期 |
| GCD-GEN-01 | 待定 | planned | case-local provider replay + dirty repo | 点击 Sparkles 生成 | 输入框填入 Conventional Commit message，未触发 commit |
| GCD-COMMIT-01 | 待定 | planned | disposable repo + no remote | 手动输入 message，Cmd/Ctrl+Enter 触发“提交” | Git 历史新增 commit；只 stage 当前 scope 文件 |
| GCD-PUSH-01 | 待定 | planned | disposable bare remote + ahead branch | clean ahead 点击主按钮 | 打开推送弹窗并执行 push / set-upstream |

## Handoff Notes

- `e2e:promote` dry-run 已确认当前脚本只支持 `conversation-session`，Git 域本次按同等转正规则手动移动到正式 case root；后续可把 promote 工具扩展到 `git` domain。
- 当前 `e2e:fixture:check` 只支持 `conversation-session` 正式目录；`GCD-UI-01` 不依赖 provider fixture，正式验证以 WDIO 单 spec 为准。
- `GCD-UI-01` 的稳定合同是 `providerRequestPolicy=none`，不点击生成、提交或推送。
- 后续生成 / 提交 / 推送 case 需要拆成 case-local fixture，避免模型请求、Git 历史副作用和 remote push 互相污染。

## 弹窗圆角迁移（2026-09-04）

依据 [DESIGN.md 的弹窗圆角规则](../../DESIGN.md#dialogs)，普通 Dialog 外壳统一 `2xl`，清理业务 `xl` / `3xl` 覆盖；聊天附件预览、反馈截图预览、CUA 截图预览显式保留 `xl`。本次不调整弹窗内部容器和控件。

GCD-UI-01 增加提交弹窗计算圆角 16px 的断言。共享默认值、业务覆盖和三个预览例外由单测覆盖。桌面和手机 Web 复用相同组件，无进程、状态同步或恢复语义变更；跨平台和手机端独立视觉验证需另行记录。

### 本次验证结果

- 新增圆角测试在修改前失败；修改后相关单测通过（首轮 34 项，补充聊天区查找分支后该测试组 18 项通过）。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint` 通过；Lint 为 41 个已有警告、0 错误。
- macOS Electron GCD-UI-01：1/1 通过，包含计算圆角 16px 断言；运行 ID：`desktop-e2e-20260904080854303-p50838-b01f152a8e3d50f0`。
- 三类预览保留 xl 的入口由单测验证，未逐个运行预览 UI；手机 Web、Windows、Linux 尚未进行独立视觉验证。
