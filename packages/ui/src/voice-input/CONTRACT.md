# voice-input

Composer 语音输入的 UI 模块（`docs/chat/composer-voice-input.md`）。

- `useComposerVoiceInput({ inputApiRef, sessionId, enabled })`：状态机唯一 owner，返回 `available`、`state`、`toggle`、`settle(reason)`。
- `VoiceInputButton`：纯展示组件；按下时不抢输入框焦点。
- `ui/useMicrophonePermissionGuide.ts`：macOS / Windows 权限被拒时的引导浮层状态（重新授权、打开系统设置、重启 ZCode、窗口获焦时重查一次权限）；浮层由 `VoiceInputButton` 渲染。
- `adapters/pcmCapture.ts`：getUserMedia + AudioWorklet，输出 16kHz 单声道 PCM16，每 100ms 一块。
- `domain/voiceInputFailure.ts`：失败分类、静音判定和提示文案选择，纯函数。

与编辑器的交集：识别结果通过 `LexicalChatInputHandle.setVoiceText` 写入，结束时调用 `endVoiceText`。语音文字节点和上次写入内容由编辑器 handle 持有，本模块不保存第二份。

不变量：

- 每次录音一个 attemptId，旧 attempt 的事件和异步回调直接丢弃。
- 用户修改输入框（`onUserInputStart` 调用 `settle("user-input")`）、`setVoiceText` 返回 false、发送（`await settle("submit")`）都与点击停止一致：发送尾块和 finish，等待最终结果。用户接管后不再写临时结果，最终结果写入时不移动光标，用户在语音文字后追加的内容保留。
- `settle` 的等待可能跨越会话切换和状态变化：调用方恢复后必须校验目标，目标变化时中止；目标未变时要重新读取最新状态（Composer 交给最新渲染的 `submit`），不能沿用等待前闭包里的值。
- 只有 Escape 删除语音文字；失败、切换会话立即取消并保留语音文字。
- 不加客户端超时，依赖服务端超时。
- 可用条件：`platform.microphone` 存在、base 连接提供 `voiceInputService`、已登录。
- 401 不在本模块提示，由全局登录失效弹窗处理。
