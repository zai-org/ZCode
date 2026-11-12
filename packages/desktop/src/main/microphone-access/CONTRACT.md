# desktop-microphone-access

Composer 语音输入（`docs/chat/composer-voice-input.md`）在 Main 进程的系统权限部分：检查 / 请求麦克风系统权限，macOS 重新授权，打开系统设置页。

不变量：

- 只打开本模块列出的固定系统设置地址；renderer 只能选择 `privacy` 或 `sound`，不能传 URL。
- macOS `not-determined` 时才调用 `askForMediaAccess`；Windows 无法判定时返回 `unsupported`，交给 `getUserMedia` 的真实结果。
- Linux 没有统一的系统设置地址，`openSettings` 返回 `false`。
- 重新授权只执行 `/usr/bin/tccutil reset Microphone <当前 App bundle id>`，bundle id 读自运行中 App 的 Info.plist，renderer 不能传参数。开发版（未打包）跳过 tccutil。
- 重置后是否需要重启由重置后的状态决定（仍是 `denied` → `restart-required`），不做计时判断。
- 已经是 `granted` 时不重置；同时到达的重置请求在 main 进程合并为同一次，不并发执行 tccutil。
