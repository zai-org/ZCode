# CLI 内存诊断与崩溃证据

app-server 就绪后调用 startCliMemoryDiagnostics，退出时调用 stop。
本模块独占 inspector 和诊断文件；只读取调用方提供的计数器，不持有会话或正文。
无 source map、脚本源码、调试端口、强制 GC 或完整堆快照。

采样与落盘单次在途，忙时丢样本。分配窗口、节点数、投影栈与文件大小都有上限。
跨进程只通过既有目录锁维护一份文件预算；锁竞争不排队，失败不传播到任务。
反馈归档按 shared 的 sanitizeCliMemoryDiagnostic 契约重新做安全投影。
同步工作耗时在 adapter 操作边界测量，异步恢复前的业务调度时间不计入预算。
首次降级原因、时间和耗时随有界记录保留；旧格式兼容，不添加退出取样或刷盘屏障。

Host stderr 证据与反馈归档由本模块共同维护：`createAgentStderrTail` 只保留脱敏后的有界文本，
连续栈不能挤掉 fatal 头；`AgentStderrCollector` 的流监听和 drain 契约保持不变。
不接管 ProcessManager 的退出、重启、进程树清理或任务状态。

完整参数和验收见 docs/monitoring/memory-diagnostics-log.md。
