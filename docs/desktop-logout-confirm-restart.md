# Desktop Logout Confirmation And Restart

## 背景

桌面端退出登录会改变全局鉴权上下文。现有 ZCode Agent 会话、运行中的 task、后台工具链都依赖当前 provider token 和派生 Start/Coding Plan key。为了避免退出登录后旧会话继续持有失效上下文，桌面端退出登录需要在用户确认后中断当前运行并重启 App。

## 设计

- UI 侧继续使用统一 `ConfirmDialogHost`，不新增弹窗组件。
- Root 的 `handleLogout` 在执行 `oauthService.logout()` 前先查询桌面主进程维护的运行中会话计数。
- 如果检测到运行中 agent session，确认文案显示具体数量；如果没有检测到，文案仍说明 App 会重启。
- “断开连接并重启”是完成退出登录流程的主操作，确认按钮使用统一 ConfirmDialog 的默认 primary 按钮；运行中会话风险只通过标题和描述说明，不降级为 warning/danger 按钮。
- 用户取消时不触发 telemetry、logout 或重启。
- 用户确认后按原有顺序清理 OAuth、provider family domain 和展示态，然后通过桌面命令请求 App 重启。
- 桌面端在退出流程露出登录入口之前进入“退出中”阻断态，直到 App 重启：即 OAuth logout 与设置写入成功后、打开登录页和清空用户之前。期间 Root 只渲染启动画面（`RootStartupLoading`），不渲染登录页、登录按钮或工作区。原因：OAuth flow 只保存在当前 Host 内存中，重启前发起的登录会随 Host 退出丢失，浏览器授权完成后新进程只能报 `OAuth state 不匹配或已过期`。
- 不在确认时就进入阻断态：阻断态会卸载工作区，确认后、清空用户前的步骤（读设置、OAuth logout、写设置）失败时，界面必须保持原样，不丢失仅存于内存的界面状态（如已关闭的职业引导）。
- 阻断态内任一步失败（刷新、清理 webview 存储或重启命令本身），立即退出阻断态，展示登录入口（此时用户已清空），错误照常向上抛出；不使用超时解除阻断。
- Web / mobile remote 不进入阻断态，退出后直接展示登录入口。

```text
用户确认退出
  读设置 → oauth.logout → 写设置        ← 失败：保持原界面
  └─ [桌面] 进入退出中阻断态（启动画面，无登录入口）
       打开登录页 / setUser(null) → refreshProviderState
       → ClearCodingPlanWebviewStorage → RelaunchApp → 新进程
       失败 → 退出阻断态 → 登录入口
```

## 边界

- 运行中会话计数来自 main 进程已有的 host running task 统计，只用于桌面端确认文案，不把 session/task 业务状态下沉到 main。
- Web / mobile remote 不使用该重启命令；Web fallback 返回 0 个运行中会话并保持 no-op。
- 重启命令先走现有 app quit preparation，确保 host process 和 agent 子进程仍按桌面退出路径清理。
