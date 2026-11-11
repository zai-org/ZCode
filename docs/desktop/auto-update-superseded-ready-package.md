# 自动更新已下载包被新版本替代

## 背景

桌面端使用 `electron-updater` generic feed。客户端运行版本可能落后于已经下载但尚未安装的版本，例如当前进程是 `3.1.2`，已下载 `3.1.3`，用户暂时没有点击重启安装。

旧状态机在 `update-downloaded` 后把菜单固定为“重启以更新”，后台轮询只允许从 `idle` 发起。因此当 stable feed 后续推进到 `3.1.4` 时，同一运行进程不会再次检查，也就不会把可安装包替换为 `3.1.4`。只发现、尚未下载时也有同一类缺口：状态停在 `update-available` 后，轮询和菜单里的“检查更新”都不再请求 manifest，用户只能先安装第一次看到的版本。

## 目标语义

- 服务器最新版本是目标，本地包是另一件事实。已经展示 `update-available`、`download-progress` 或 `update-downloaded` 时，后台复查不得把界面切成 `checking`。
- 启动立即检查一次。没有可见更新时每 15 分钟复查；更新入口还在时每 2 分钟复查。下载完成或取消时，如果没有检查在飞，立即再查一次。下载失败无论来自下载 Promise 还是 error 事件，都再查一次；如果失败发生在当前检查收口前，等收口后再查。强制更新失败不复查。已有检查在飞的完成或取消不另排队，由短轮询接手。
- 菜单“检查更新”在 `update-available` 时重新请求 manifest，不回放内存里的旧版本。下载中只提示正在下载；已下载且仍等于目标时继续安装。
- 复查结果更高时替换目标的版本、通道和 release notes。自动下载开启且当前没有下载在途时，下载这个新版本；否则留在发现态，等用户确认。
- 复查结果等于当前目标时不重复下载。低于当前目标或该版本被跳过时，有 ready 包就留在 ready，没有则回到 idle。
- 已下载包版本等于当前目标时，用户点击“重启以更新”继续安装该包。目标已经更高而新包尚未就绪时，“重启以更新”不安装旧包；普通退出在任何版本状态下都不触发安装。
- 若替换下载失败且旧 ready 包仍存在，菜单恢复到旧 ready 状态，避免用户失去原本可安装的更新入口。

## 实现约束

- 下载由主进程显式触发：`electron-updater` 的 `autoDownload` 关闭，`update-available` 事件里根据 ready 版本判断是否调用 `downloadUpdate()`。下载进行中可以记住更高目标，但不并发启动另一次下载。
- 版本比较使用 semver coercion，兼容 `v3.1.4` 这类版本字符串；无法解析时只在字符串不同的情况下视为需要下载。
- 自动轮询从 `idle`、`update-available`、`update-downloaded` 发起。`checking` 与真正的 `download-progress` 仍然跳过，避免并发下载。所有平台的普通退出均不触发安装；只有用户显式选择“重启以更新”才进入安装流程，ready 包必须等于当前目标。
- 安装的唯一状态由 main 的 `quitAndInstallState` 持有，依次为 `idle → preparing → installing`，失败后进入终态 `recovering` 并受控重启。确认安装时立即锁定已就绪包，后台 manifest 请求不参与安装准入；检查迟到结果与检查失败不能修改锁定包或误判为原生安装错误。
- 下载事件先记录在对应 CancellationToken 上，下载 Promise 成功收口后才发布 ready。安装不等待网络工作：挂起的下载尚未 ready，已有 ready 不依赖后台检查结束；取消/失败下载不能发布陈旧 ready。
- `preparing` 开始后不接受新的检查、下载或更新结果。Host/Agent 清理不能撤销，准备失败、准备期间 staging 错误及交接后的原生安装失败均受控重启，不能回到服务已销毁的旧窗口。恢复只执行一次，重复错误不重复重启。
- `quitAndInstall()` 返回不代表安装结束；成功交接后保留 `installing`，原生 `before-quit` 放行，重复安装命令不重入。真实安装错误与带检查来源的错误分别处理，不用当前菜单猜测来源。
- 本修复只改变 desktop main 更新生命周期，不修改 Host/Agent 退出屏障、手机 shared-host attachment 或 desktop continuous / web remote replayable 消息边界。

```text
下载 Promise 成功收口 → ready → 显式确认安装/锁定包 → preparing → installing → 退出
                                  后台检查不参与等待   │          │
                                                      └─失败─────┴→ recovering → 重启恢复
```

## 回归验证

- 预期行为：普通退出在 macOS/Linux/Windows 的 ready 状态下不执行安装准备、不调用安装器、不安排 relaunch。安装失败后的新进程即使重新发现同一 pending 包，普通退出也应正常结束；这一恢复路径须经过真实启动恢复入口单独验收，不能用下面的 ready 状态注入场景替代。
- deb 回归复用锁定依赖的 `DebUpdater`，通过隔离命令执行边界验证安装成功、提权失败和恢复；不在开发机执行真实包管理器。真实 Ubuntu deb 的提权 UI、文件替换与版本升级需要独立实机验收。
- 现行 Electron smoke 覆盖挂起检查不阻塞 ready 安装、准备期间新版本事件与重复 IPC，以及原生错误恢复。安装与 Host/Agent 清理均只交接一次；历史 App 单测已退役，不作为现行覆盖。
- Electron 进程级 smoke 使用真实 `MacUpdater.quitAndInstall()`、renderer IPC 与 `app.before-quit`，控制原生 staging 回调在安装调用返回后到达；断言安装仅发起一次且进程正常退出。原生更新器使用夹具，不替换用户应用或执行真实 ShipIt 安装。
- 签名发布包的 ShipIt 文件替换和自动重启仍需发布前验证，不以 smoke 代替。

### 退出意图回归入口

`node packages/desktop/scripts/auto-update-install-reentry-smoke.mjs` 在隔离 userData 中运行真实 Electron、生产更新器模块和锁定的 electron-updater：

- 默认 / `--pending-check` / `--preparing-download-failure`：Mac 异步安装交接、挂起检查及准备期重复命令。
- `--native-install-error`：Mac staging 失败只恢复重启一次。
- `--ordinary-quit`：Mac 已下载包不拦截普通退出。
- `--linux-deb`：真实 DebUpdater 在非 root、`isAdminRightsRequired=false` 时仍调用 pkexec；仅命令执行边界被替换。
- `--linux-deb --native-install-error`：模拟提权失败，服务清理后只恢复重启一次。
- `--linux-deb --ordinary-quit`：更新器初始化后，通过 `update-downloaded` 事件注入 ready 状态，再验证普通退出不安装也不 relaunch。夹具不准备持久化 pending 数据，也不经过 `hydratePendingPostUpdateReleaseNotes()`，因此不覆盖新进程从 pending 包恢复状态的路径。

本机使用 macOS Electron 执行 Linux updater 分支，不代表已经验证真实 Linux 的授权对话框、包管理器或安装版本变化。
