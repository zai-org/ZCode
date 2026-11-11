# v4 Conversation Detail Parity

本文记录 v4 会话渲染在重构后需要补齐的 z-code-2 细节回归。范围只限 renderer /
adapter 层，不改变 protocol、runtime、host process、relay 或 session stream 语义。

## P0 行为合同

### 工具失败错误可见

v4 `ToolCallRow` 进入旧 `ToolCallBlock` 渲染前，必须保留足够的失败信息：

```text
ToolCallRow(status=error)
  -> toolCallRowToLegacyNode
  -> TaskChatToolCall(status=failed, error=可读错误)
  -> getToolCallErrorText
  -> ToolCallBlock / ToolOutput(error)
```

错误文案归一化优先级：

1. `row.error.message`
2. `row.output.text` 中完整包裹的 `<tool_use_error>...</tool_use_error>`
3. 非空 `row.output.text`
4. `row.error.code`

同时要在 legacy `raw` 上保留 `rawOutput`、`status=failed`、`v4Status` 和
`output.truncated` 引用，避免后续工具渲染或诊断再次丢失根因。`cancelled` 不应被当作
失败错误展示。

### 文件链接右侧详情

assistant markdown 中的本地文件链接继续走旧版 z-code-2 的宿主分流：

```text
MessageResponse file link
  -> onOpenFileLink
  -> WorkspaceShellLayout.handleOpenMarkdownFileLink
      file      -> PreviewPane code viewer
      directory -> WorkspaceFileTree reveal
```

v4 prop 链路必须从 shell 传到每个 row renderer：`V4ChatPane` /
`V4WorkspaceChatArea` -> `SessionPane` -> `ConversationRowRenderContext` ->
`AssistantTextRowView` / `AssistantPreviewCards`。`MessageResponse` 仍负责 hover
下划线、context menu 和 `Open With`，v4 不重新实现视觉样式。

### Windows 本地文件定位

右键“资源管理器”经现有 platform/preload IPC 进入 main；本地文件只调用一次
`shell.showItemInFolder(path)`（打开所在目录并选中文件），不再执行
`explorer.exe /select` 后按退出码二次打开。Explorer 可能已委托打开请求却以非零码退出，
不能把该退出码当作需要再次打开的依据。返回成功只表示已发出定位请求，不保证系统窗口已显示。
Windows 目录仍使用 `shell.openPath`；macOS Finder、WSL UNC 分支和手机远控保持原有行为。
验收：中文及空格文件路径只发出一次定位请求，不启动 Explorer 子进程；Windows 实机右键后
只出现目标目录窗口且选中文件，不额外出现桌面窗口。

自动回归：`openInEditor.test.ts` 检查无子进程调用；
`test/e2e/workspace/files/manual-review/pending/windows-file-reveal.test.ts` 检查真实 preload/main IPC
到 shell 的调用次数（Windows 专用，mock shell，不证明真实窗口数量）。

## P1 审计清单

以下细节来自 z-code-2 对照，本次只登记，不在 P0 中实现：

- Assistant Preview Card 的 file target 预览优先级仍需单独审计，避免目录卡片绕过 shell `stat` 分流。
- 旧版低噪音 tool diagnostics 可用于排查“任务结束但工具仍显示运行中”。
- foreground active tool call 对 thinking shimmer 的抑制逻辑需要确认 v4 是否等价。
- 手机 `/remote` 无 hover，assistant action 可见性需要单独审计。
- v4 `output.truncated.ref` 的完整工具输出加载入口仍未补齐。
- `ToolOutput` 的 `Error` / `Result` 标题仍是英文文本，后续需要 i18n 收敛。

## 验证口径

本次先用 UI 单测证明投影和回调链路：

- `v4ToolCallRowAdapter.test.ts` 覆盖 output-only error、tagged error、code fallback 和非失败状态。
- `toolCallBlocks.test.ts` 覆盖适配后的 failed node 能在工具卡中显示错误正文。
- v4 row / session wiring 单测覆盖 file/code/browser 三类打开回调进入 `MessageResponse` 和 tool row。

正式 WDIO E2E 可在后续补 `VDP` 分组，用 replay fixture 构造 failed tool row 和 markdown
本地文件链接，断言右侧 pane / 文件树真实打开。
