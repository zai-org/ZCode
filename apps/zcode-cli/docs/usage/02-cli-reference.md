# 02 · 命令行参考

## 常用入口

```sh
zcode
zcode --prompt "任务说明" --cwd /absolute/path/to/project --mode yolo --json
zcode doctor --json
zcode skills list --json
zcode commands list --json
zcode plugins list --json
zcode hooks trust status --workspace /absolute/path/to/project --json
```

无参数进入 TUI。`--prompt`/`-p` 必须带非空文本；不要把 `-p` 当作无需值的开关，也不要用裸位置参数替代 prompt。`app-server` 是协议服务入口，不是批量任务的普通问答命令。

## 参数

- `--cwd <path>`：本次调用的有效工作目录，用于项目配置、技能发现和会话归属。
- `--mode plan|build|edit|yolo|guarded`：显式指定权限模式。`--prompt` 缺省为 `yolo`；旧构建可能缺少 guarded。
- `--attach <path>`：添加本地附件，可重复。实际媒体支持还受所选模型限制。
- `--resume <sessionId>`：恢复指定会话；`--continue`/`-c` 恢复当前目录最近的会话。两者互斥。
- `--target <objective>`：设置或推进会话目标，与 `--prompt` 互斥；替换已有目标使用 `--target-replace`。
- `--disallowed-tools <names>` / `--disallowedTools <names>`：本次运行移除整项工具，逗号或空格分隔；不持久化。`Bash(git *)` 仍移除整个 `Bash`，不是命令匹配规则。
- `--json`：命令支持时输出 JSON；并非所有子命令或错误路径都返回 JSON。
- `--output-format text|json|stream-json`：控制普通 prompt 的输出，优先于 `--json`。
- `--workflow-mode disabled|onDemand|alwaysOn`：当前源码中用于 prompt、target 和 TUI；默认 `disabled`。旧构建可能拒绝此参数。
- `--memory-bench`：仅配合 `--prompt`，开启自动记忆提取并等待提取结束；须先启用记忆。
- `--total-tokens-reminder on|off`：用于 prompt、target 和 TUI，默认 `off`。打开后 system 末尾带固定的 token 预算行，收集输入附件时附带剩余量提醒；只控制提醒，不限制实际用量。只对本次启动有效，不写入会话，`app-server` 拒绝此参数。`--resume` / `--continue` 恢复的会话，system 跟随 prompt 快照：关闭时写下的会话在下次压缩或换模型前不带预算行，打开时写下的会话在此之前保留预算行；剩余量提醒按本次参数收集。
- `--agent-always-background on|off`：用于 prompt、target 和 TUI，默认 `on`。打开时 Agent 工具没有 `run_in_background` 参数，子代理总在后台运行，结果经完成通知在之后的回合送回；关闭时回到可选 `run_in_background`、省略时前台运行的形态。只对本次启动有效，不写入会话，`app-server` 拒绝此参数；同一进程里模型用 CreateSession 新建的根会话不继承它，按缺省开启。规则见 [07-subagent.md](../design/v2/tool/07-subagent.md)「ZCode 当前实现」。不论开关取值，`--prompt` 与 `--target` 都等后台工作（Agent、Bash、workflow）结束、通知回合跑完后才输出结果并退出，不设超时，见 [自动化](13-automation.md)。
- `--browser-use=headless`：显式启用 CLI 管理的无界面浏览器；可用 `--browser-executable <absolute-path>` 指定浏览器。后者不能单独使用。
- `--browser-state <path>`：配合 `--browser-use=headless`，在每个会话的浏览器上下文中注入只读的 Playwright storage state 登录态文件；相对路径按启动目录解析。不传时自动加载 `~/.zcode/cli/browser-state.json`（存在时），`--no-browser-state` 关闭默认加载。文件可用 `playwright open --save-storage <file> <url>` 在登录后关闭窗口生成；会话中的登录变化不会写回文件。
- `--locale auto|en-US|zh-CN`、`--no-color`、`--verbose`：语言、颜色与附加诊断。
- `--version`/`-v`：版本；`-v` 不是 verbose。

插件命令还支持 `--scope`、`--available`、`--all`、`--keep-data` 等选项，见[插件](10-plugins.md)。`--force-mcs` 是 Anthropic 接口的专项诊断选项，不是通用评测开关。

不要使用未经解析器支持的 `--print`、`--model`、`--settings`、`--max-turns`、`--allowed-tools` 或 `--permission-mode`。若需要运行时限，由评测进程管理器控制。除只控制提醒的 `--total-tokens-reminder` 外，没有 CLI token 或轮数预算参数，不要杜撰。

## JSON 与流式输出

普通 prompt 的 JSON 示例仅展示结构，具体字段可随构建变化：

```json
{
  "sessionId": "sess_example",
  "traceId": "trace_example",
  "response": "ready",
  "eventCount": 4,
  "projection": { "status": "idle", "turnCount": 1 }
}
```

`stream-json` 是 NDJSON：逐行输出事件，正常结束时输出 `type: "result"` 的结果行。逐行 `JSON.parse`，不要把整个文件当作一个 JSON 对象。遇到未知事件类型应保留原始记录；不要按固定事件数量判断成功。

`--prompt "/help"` 等本地命令可以提前返回文本，即使传了 `--output-format json` 也不代表一定有普通 prompt 的结果结构。此类调用只能验证参数被接受，不能验证完整输出协议。

stdout 保存业务输出，stderr 单独保存诊断。异常路径可能只有 stderr；先检查进程退出状态，再解析结果。进程成功结束也不等于任务评分通过，须结合工具执行、文件产物和独立判题结果。

## 退出与取消

常见参数或运行错误返回退出码 `1`；成功入口通常返回 `0`。信号取消要记录原始 exit code、signal 和超时标记，不要只归一化为“没有输出”。权限拒绝可能作为工具错误交给模型后继续一轮，因此也不能只靠进程退出码检测工具失败。

恢复、goal 和后台工作流的结束语义见[会话](06-sessions.md)。
