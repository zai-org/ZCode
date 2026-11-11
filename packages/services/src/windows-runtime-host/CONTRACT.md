# windows-runtime-host

Windows CLI 的内核进程归属边界。Host 负责路由，原生 helper 独占 Job 句柄。

不变量：

- CLI 创建时通过 Job 属性归组，保持 suspended，Host 安装监听后才 start；无法托管就拒绝启动。
- stdio 原样传递，独立命名管道只传生命周期控制。真实 CLI PID 与 helper PID 分开。
- EOF → 1800ms 正常收尾 → TerminateJobObject → 内核 ActiveProcesses=0 → helper 退出。
- close 超时不销毁控制连接、不释放归属。后续 close 重新观察同一 Job，不重置原生宽限。
- helper 或 Host 崩溃由 KILL_ON_JOB_CLOSE / 父进程句柄与控制连接断开触发清理。
- 未收到 empty 时先确认 helper 退出，再按唯一 Job 名只读核验；Job 不存在或活动成员为零才释放。核验失败保留归属，下次主动请求重试。
- 不持久化、不迁移 session，也不通过 PID/PPID 查询补认归属。
