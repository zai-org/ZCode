# 资源管理器

Host 的 `processResourceSampler` 读取本机进程表，按最近已知祖先划分基础服务、任务进程与插件。
Main 合并 Electron 指标与 Host 回报，UI 通过注入的查询/启停接口展示同一份快照。

- Agent 根属于基础服务，非插件后代属于任务进程；已知 MCP 根及其后代保持插件分类。
- 分类仅影响分组；ZCode 总量包含全部进程，每个 PID 只计一次。
- UI 不启动 Agent、不查询 OS 进程表，不按命令名或 task/session 推断归属。
- 采样启停、取消及迟到结果仍由现有 Main/Host 链路负责。
- 资源管理器只在 Desktop 提供，不改变远端或手机的业务消息交付。

完整口径与验收见 [资源管理器 spec](../../../../docs/electron/resource-manager.md)。
