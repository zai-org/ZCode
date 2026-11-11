# 后台 runtime 意外退出的会话提示

## 背景

同一个 workspace 的主会话与全部子代理跑在同一个 runtime 进程（app-server）里。进程意外退出时
（例如 Windows 上系统可提交内存耗尽，退出码 `0xE0000008`，不写 stderr）：

- 桌面端只在日志和稳定性遥测里记录 `ZCode agent process exited unexpectedly`，界面没有任何说明；
- 会话面板保留旧快照并在 250 ms / 1 s / 3 s 重连（重连会拉起新进程），重连窗口内胶囊计时继续走、
  停止按钮指向已不存在的执行；三次都失败时窗格换成订阅错误面板，胶囊仍显示旧快照里的运行项；
- 重连后的冷恢复由 CLI 收口：回合与工具调用收成已取消，上一代遗留的子代理收成 `lost`，并在下一轮
  告诉主代理（见 [Subagent「上一代 runtime 遗留的 Agent」](../../apps/zcode-cli/docs/design/v2/tool/07-subagent.md)）。

本页只规定界面如何说明「发生了什么」，不在界面改写会话状态。

## 状态与时序

```text
旧 app-server      Host（process manager）                 Renderer（SessionPane）
  │ 崩溃
  ├ stdio 关闭 ──► unavailable ─────────────────────────► store: connecting（保留旧快照）
  │                                                       └ runtimeOffline：胶囊计时停、停止/取消入口隐藏
  └ exit(code) ──► 等 stderr 排空 → onRuntimeExited ────► 横幅（原因 + 关闭）
                                                          └ 三次重连都失败：错误面板（重新连接）+ 同一条横幅
                                 （主泳道、terminationKind=unexpected）
                   重连拉起新进程 ─► CLI 冷恢复投影 ─────► store: live，胶囊/行按 CLI 终态显示
```

- `unavailable` 在协议关闭时立即发出，退出码要等进程退出、stderr 收齐后才有，因此原因走独立事件
  `onAgentRuntimeExited`，不扩展 `unavailable`。
- 唯一写者：会话事实仍归 CLI 投影；横幅是窗格内的展示状态，`runtimeOffline` 直接由订阅状态
  （`status !== "live"`）派生，不形成第二份运行态。

## 行为

- 事件：`IZCodeAgentService.onAgentRuntimeExited`，载荷含 `workspaceKey`、`exitCode`、`signal`、
  `cause`、`exitedAt`。`cause` 由 `@zcode/shared/agent-crash-diagnostic` 的
  `classifyAgentProcessExitCause` 判定，与稳定性遥测同一份规则；目前只有 `native_out_of_memory`
  （Windows `0xE0000008`）。回收、换代、关闭等主动终止，以及 mcp-status / plugin 泳道不发布。
- 横幅：窗格底部，与「重启前的输入未进入对话」提示同一位置和样式。
  - `native_out_of_memory`：「后台运行时异常退出：系统内存不足，可能是其他程序占用了大量内存。正在运行的任务和子代理已中断。」
  - 其他：「后台运行时异常退出。正在运行的任务和子代理已中断。」
  - 订阅进入错误态（三次重连都失败）时，错误面板会替换时间线和它的底部区域；横幅改挂在错误面板
    下方，仍在窗格底部，原因说明不随时间线消失。不放在顶部：右上角浮动的状态胶囊会盖住横幅的关闭
    按钮。「重新连接」只用错误面板上的按钮，横幅不再放第二个。
  - 用户关闭、切换到其他 workspace 或窗格卸载后消失；同一 workspace 再次异常退出时替换为新的一条。
- 胶囊：`runtimeOffline` 时终端（后台 Bash）、工作流、智能体三个分区的计时都停在断开前的数值，
  单项停止 / 取消按钮隐藏。三类运行项都在 runtime 里执行，目标执行已不存在；时间线卡片上的取消
  本来就按 `runtimeReady` 隐藏，胶囊与它保持一致。重连后由 CLI 冷恢复的投影决定是否仍在运行，
  上一代遗留的子代理收成 `lost`，进入已结束目录。
- 手机远控：远端服务面没有该事件，不显示横幅；胶囊仍按同一订阅状态暂停计时。

## 验证

- 桌面 E2E（manual-review/pending）：
  - ARE-01：SIGKILL app-server 后出现通用横幅，自动重连拉起新进程，横幅可关闭。
  - ARE-02：用回放夹具起一个后台 Bash，持续杀掉重新拉起的 app-server 直到窗格进入错误态。期望
    横幅仍在、胶囊里该 Bash 的计时不再变化、取消按钮消失；停止干预后点错误面板的「重新连接」恢复。
- 可重复场景（Linux 桌面开发版）：会话中启动后台子代理执行长命令，对 app-server 子进程
  `kill -9`。期望：出现通用横幅；重连后胶囊不再有该子代理、目录中显示 `lost`；下一条消息时模型
  收到中断通知。
- 内存不足文案：Windows 退出码无法在 Linux 用真实进程产生，分类规则由
  `pnpm --filter @zcode/desktop test:agent-crash-diagnostic` 覆盖；需要时在 Windows 预览机耗尽可提交
  内存复现。
