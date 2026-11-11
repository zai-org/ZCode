# 自动下载并安装更新

## 背景

Electron 自动更新弹窗需要支持用户选择“以后自动下载并安装更新”。该偏好必须持久化到全局设置，并和设置页里的同名开关保持一致。独立更新窗口不挂完整 workspace service，因此不能直接依赖 UI 层的 `settingService`。

## 行为

- 新增设置项 `autoDownloadAndInstallUpdates`，默认关闭。
- 更新弹窗在“未下载”状态的底部按钮上方展示左对齐 checkbox：`以后自动下载并安装更新`。
- 在设置页通用分组中展示同一个开关。
- 当该设置开启并检测到可用更新时，main 进程自动调用当前下载流程。
- 下载中主更新入口展示进度/加载态，仍可点击重新打开同一更新窗口。关闭小窗只结束展示，不取消后台下载；窗口规则见 [服务端 Manifest 自动更新](auto-update-service-manifest.md)。
- 下载完成后用户点击“重启以更新”：
  - 若没有运行中的 Agent session，直接执行现有 `quitAndInstallUpdate()`。
  - 若存在运行中任务，先提示应用将退出并重启、进行中的任务会中断；用户确认后再执行更新。

## 架构

- 设置持久化继续使用 `AppSettings` 和 `settingService`。
- 主进程 `autoUpdater` 在 `update-available` 事件中读取设置并触发自动下载，避免依赖任何 renderer 窗口是否打开。
- 独立更新窗口通过窄平台接口读写自动更新偏好，不暴露完整 setting service。
- 重启前任务检查复用现有 `IPlatformService.getDesktopSessionActivity()`，避免 UI 层直接读取任务 store 或跨层访问服务实现。

## 验证

- 单测覆盖：
  - 设置 schema 默认值和 patch。
  - 开启偏好后检测到更新自动开始下载。
  - 弹窗 checkbox 写入设置并在当前可用更新下触发下载。
  - 下载中主更新入口可重新打开当前进度。
  - 有运行中任务时重启按钮先请求确认。
- 仍需执行 `pnpm typecheck` 和 `pnpm lint`。
