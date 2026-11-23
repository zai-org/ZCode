# 05 · 权限

启动非交互任务时显式指定 `--mode`，不要依赖用户配置或交互终端的默认值。`--prompt` 缺省使用 `yolo`。

## 模式语义

- `plan`：限制普通写入和命令执行，主要用于分析。它不是操作系统级只读沙箱；当前实现还允许部分非破坏性 MCP 和会话控制能力。
- `build`：常规写入及有副作用的工具通常需要审批。
- `edit`：工作区文件编辑通常免审批，其余沿用 build 判定。
- `yolo`：普通工具跳过权限提示，适合已隔离的无人值守任务。
- `guarded`：当前源码支持。普通调用采用宽松策略，危险命令仍需逐次批准；不适合作为无人值守任务的“自动批准”模式。旧构建可能不支持。

`auto` 是内部保留值，不是可用的 CLI 自动模式。

## 为什么 yolo 仍可能拒绝

工具级交互要求、`alwaysAsk`、独立 Plan 状态、工作区 Hook 信任和 Hook 拦截都有自己的规则。不能把 yolo 简化成“任何代码都无条件执行”。配置中的普通 deny/allow 规则也不能替代操作系统隔离。

```text
工具未注册 → 无法调用
工具已注册 → 校验与权限判定 → allow / ask / deny
ask + 无审批客户端 → 工具失败
allow + Hook 阻断 → 工具失败
执行成功 → 仍需验证任务产物
```

这张图说明用户可观察的结果，不代表内部每个检查的严格调用顺序。细节以[权限服务](../../packages/core/src/permission/service.ts)及工具执行器为准。

## 验证权限

用一次性目录测试 Read、Write 和 Bash。对普通内置文件工具，plan 应拒绝写入，edit 可写文件；build 的写入审批在无客户端的 prompt 中可能失败。使用自定义工具、插件或 MCP 时，须分别验证其能力声明和权限规则。

需要审批但 prompt 没有审批客户端时，工具被拒绝，模型收到 `ZCode requested permissions to use <Tool>, but you haven't granted it yet.`（Write / Edit 写 `…to write to <file_path>…`）；guarded 模式下这次调用直接失败，错误为 `No permission client configured`。出现这两种情况时，检查当前模式和工具是否需要交互。不要仅通过重复提示模型来解决。移除不需要的交互工具，或选择具备审批客户端的交互入口。

工具拒绝后模型仍可能继续回答，进程也可能返回 `0`。同时检查流式事件、工具结果和文件产物。需要按参数拦截某类工具时可使用同步 `PreToolUse` Hook，但简单命令正则不是完整沙箱，见[Hooks](09-hooks.md)。
