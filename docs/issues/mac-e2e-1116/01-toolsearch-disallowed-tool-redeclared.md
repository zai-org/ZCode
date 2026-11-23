# 01 — Native ToolSearch：禁用的工具在离开目录后仍被原位重新声明

Status: wontfix

## 现象

2026-11-16 mac conversation E2E 中，三个 ToolSearch 用例的 native 模式失败，local 模式通过：

| 用例                                                                        | 断言                                                     | 结果 |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | ---- |
| `tools/conversation-session-toolsearch-cli.test.ts` TS02                    | `--disallowedTools=TodoRead` 后 resume 请求不含 TodoRead | 仍含 |
| `tools/conversation-session-toolsearch-feedback.test.ts` TS12-RESULT native | 失效引用数为 0                                           | 2    |
| `tools/conversation-session-toolsearch-recovery.test.ts` TS04               | MCP 被禁用后请求不含该 MCP 工具                          | 仍含 |

## 静态分析（未经运行时抓包确认）

- [ToolSearch 设计](../../../apps/zcode-cli/docs/design/v2/tool/19-tool-search.md)「历史定义交付」规定：已交付定义的工具离开目录后原位重新声明。实现见 `apps/zcode-cli/packages/core/src/tool/search/exposure.ts:209-213`（departed 分支）与 `:144`（有 retained 定义就不再 strip 引用）。
- 常驻 MCP 分支会检查 `input.registry?.get(...)`，departed 分支不检查。所以用户用 `--disallowedTools` 显式禁用、或 MCP 被禁用的工具，也会被重新声明。

## 待决定

用户显式禁用的工具是否属于「离开目录」：

- 属于：设计如此，只改三个用例的断言。
- 不属于：departed 分支需要排除被禁用的工具，属于产品 bug。

## 来源

mac conversation job `ci-conversation-341152-1138993`（ff3ecc47）的失败分诊。

## Comments

### 结论（2026-11-18）：设计如此

staging 的 08285def11（test(e2e): follow async MCP startup contracts）按现行设计更新了这三个用例与
case catalog：Native 冷恢复保留已交付的历史定义与引用，是否可执行由当前权限在调用时决定（禁用后真实调用
得到 `No such tool available`，解除禁用后真实执行成功）。所以「禁用工具仍在请求里」不是产品 bug，不改 `exposure.ts`。
