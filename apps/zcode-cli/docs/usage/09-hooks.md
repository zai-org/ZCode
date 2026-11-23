# 09 · Hooks

Hook 是在会话或工具事件上运行的本地程序，可记录事件、补充上下文或阻断调用。用户配置、项目配置和插件都可能提供 Hook；项目 Hook 需要额外信任。

## 事件与最小配置

支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。

每次工具调用一般只运行 `PostToolUse` 和 `PostToolUseFailure` 中的一个（Hook 运行之后的步骤抛错时，会再运行一次 `PostToolUseFailure`）。工具结果是错误时运行 `PostToolUseFailure`，例如 Bash 非零退出、超时，或 MCP 返回 `isError`。这时 stdin 的 `error` 是模型看到的错误正文，没有 `tool_response`。grep、rg 等退出 1 表示没有匹配，不算错误，仍运行 `PostToolUse`。

在运行配置中显式启用：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["/absolute/path/to/guard.mjs"],
              "timeoutMs": 10000
            }
          ]
        }
      ]
    }
  }
}
```

此示例要求外部 Node。`guard.mjs` 读取 stdin JSON，以下示例用于验证拒绝路径，会拒绝全部匹配的 Bash 调用：

```js
let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.hook_event_name === "PreToolUse") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "本次测试禁止 Bash。",
      },
    }),
  );
}
```

这是 Hook 协议示例，不是完整安全策略。其他工具仍可能产生文件或网络副作用。

## 项目 Hook 信任

放在项目运行配置中的 Hook 默认未信任。开启 `hooks.enabled`、打开项目或使用 yolo 都不会自动信任它。

```sh
zcode hooks trust review --workspace /absolute/path/to/project --json
zcode hooks trust grant --workspace /absolute/path/to/project --hook-digest SHA256_FROM_REVIEW
zcode hooks trust status --workspace /absolute/path/to/project --json
zcode hooks trust revoke --workspace /absolute/path/to/project --hook-digest SHA256_FROM_REVIEW
```

先审查命令和来源，再使用 review 返回的 digest。需要批量授权当前声明时，使用 `--all-current --bundle-digest SHA256_FROM_REVIEW`；不要省略绑定到当前内容的 digest。

```text
发现项目 Hook → 未信任，跳过执行 → review → grant
→ 下一次自然事件可执行
声明改变 → digest 改变 → 再次未信任
```

信任绑定工作区身份和声明内容。已跳过的 SessionStart 不会在当前任务中补跑，验证时创建新会话。信任存储损坏会 fail closed，`status` 返回原因；先备份并按诊断恢复存储，不要把损坏当作“已授权”。

## 输入、输出与错误

stdin 包含事件名、会话、工作目录和相关工具信息；兼容字段可能同时包含 camelCase 和 snake_case。只读取当前事件需要的字段。

同步 `PreToolUse` 可返回 `allow`、`ask`、`deny`、`updatedInput` 和 `additionalContext`。退出码 `2` 表达阻断；其他失败、超时及非法输出会产生诊断，不能把所有异常都当作可靠拒绝。多个 Hook 需要通过事件记录核对最终结果。

`type: "command"` 支持 shell 命令及异步执行。`async: true` 的后台输出不能用于同步阻断或改写本次工具输入；需要这些作用时使用同步 Hook。`timeoutMs` 单位为毫秒，兼容字段 `timeout` 单位为秒。

matcher 不总是正则：`Write|Edit` 走精确工具名列表；包含其他正则语法时才进入正则匹配。事件的匹配对象不同，工具事件匹配工具名，SessionStart 匹配启动来源。

插件也可贡献可执行 Hook。排查时同时检查插件启用状态和 Hook 来源；不要仅凭用户配置中的开关推断所有插件 Hook 都已关闭。批量任务应记录实际加载的声明和信任状态。
