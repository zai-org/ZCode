# 01 — Host 在主线程同步调用 fs.watch，一次卡住的 open() 让全部 RPC 停住

Status: needs-triage

## 现象

从设置页返回会话后发送消息，界面没有任何反应；约 73 s 后 Host 才恢复响应。

## 时序（`desktop-e2e-20261104145522184-p3406-ab66e8833bcaced1`，macOS）

```
22:56:33.656  会话面板重新挂载，Git 自动刷新请求 Host 递归监听两个目录（都在主仓库 .git 下）
              Host：await stat → fs.watch()（同步）→ open() 卡住，主线程停住
22:56:33.857  renderer 开始发送，等 highspeed-card.prepareTurn → 没有回应
              （这段时间 Host 没有任何日志）
22:57:46.835  watch #1 FAIL (73179.3ms)：EINTR: interrupted system call, watch '<主仓库>/.git'
22:58:04.684  watch #2 OK (91027.4ms)：#1 返回后才执行它的同步调用，又停了 18 s
```

## 证据

- 同步调用点：`packages/services/src/fileWatcher/fileWatcherService.ts` 的 `watch()`，`watchFactory(...)` 就是 `fs.watch`。libuv 在 macOS 上先同步 `open()` 目录，再注册 FSEvents，`EINTR` 说明 `open()` 在等待中被信号打断。
- 两次调用都从 22:56:33.65 开始计时，结束时间相差 18 s，说明它们依次占用了 Host 主线程。
- 系统日志：TCC 已允许该 Electron 访问 Desktop 目录（`authValue=2`），卡住期间没有新的 TCC 请求；本机没有第三方安全软件；没有其他相关记录。`open()` 为什么卡住，未查到。
- 2026-10-21 以来保存的 140 多次桌面 E2E 运行里，超过 1 s 的 `file-watcher.watch` 只出现这一次。

## 影响

文件系统的一次慢调用（网络盘、慢挂载、超大目录、系统卡顿）会让 Host 的全部 RPC 停住：发送消息、设置页、任务列表都没有反应，直到这次调用返回。

## 处理方向（未定）

- 把 watch 的建立移出 Host 主线程；或
- 给监听建立加降级：失败或过慢只影响 Git 自动刷新，不阻塞其他 RPC。

## 来源

2026-11-04 在动态 MCP 分支排查 Native E2E 偶发失败时发现。相关文件在该分支没有改动，不是该分支引入；该分支不修复。E2E 侧的触发条件见 [E2E home 位于仓库内](../desktop-e2e-isolation/01-e2e-home-inside-repository.md)。
