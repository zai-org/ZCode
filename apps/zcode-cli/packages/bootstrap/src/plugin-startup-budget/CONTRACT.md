# 插件启动预算

此模块是进程插件准备 owner 的预算状态实现，不创建第二份插件缓存或持久化状态。入口 `createPluginStartupBudget` 只接收超时长度和取消回调。`resolvePlugins` 包住 seed 与 discovery，返回完整结果或含稳定诊断的空插件结果。

并发调用共享截止时间；批次全部完成后解除计时。任一批次超时后 degraded 保持到进程释放，后续调用不执行 resolve 回调。迟到结果与拒绝被观察，但不能重新启用插件。dispose 拒绝未完成等待并清除定时器。

预算是事件循环可调度时的软上限，不能终止系统内核 IO；目录替换/回滚的事务收口由原 seed owner 负责。调用方的 onTimeout 必须取消后续 IO 并安全发布提示。

回归见 bootstrap/tests/bundled-plugins-resilience.test.ts；产品约定见 docs/workspace-capability-discovery-cache.md。
