# 本机预装工具进程

- Main 只读取并装配 catalog，管理 utilityProcess 生命周期及消息转发，不保存工具状态。
- Host 按发布身份计算固定 `bin/` 并注入 AVAILABLE，不接收 catalog，也不等待准备。
- `process.ts` 校验初始化与命令；`coordinator.ts` 拥有全局自动预装设置、owner 表和唯一串行准备队列。
- `installation.ts` 每工具一个 owner，拥有该工具的记录、状态和准备/删除归属。目录位于 `tools/<toolId>/`。

```text
命令 {type, toolId} → coordinator → owner[toolId] 接纳/加入已有操作
                                 └→ 串行队列 → 安装事务 → 安装记录原子发布 → 派生入口
owner 完整投影 → coordinator {autoInstallEnabled, tools[]} → Main → preload → UI
```

- 初始化由各 owner 撤销本工具入口，成功后清理旧版本并重建有效记录入口；失败保留目录并标记 entryOutOfSync。coordinator 仅清理无主文件，完成后才回收移出 catalog 的目录；没有有效记录不保留入口。清单不可用（`tools` 为 null）时 coordinator 没有 owner，也不清理无主文件或回收目录。
- catalog 顺序同时决定状态/卡片与自动准备顺序。内置五个工具的 15 个资源，按资源声明的平台选择；未提供资源的平台没有目标。默认下载基址为 `https://cdn-zcode.z.ai/zcode/preinstalled-tools`，覆盖变量仍支持有序候选。
- 队列只运行一个安装事务，清理结束后才运行下一项。排队时显示 `queued`；重复请求加入同一 flight。
- 取消排队项只移除该项；取消活动项只中止该项。关闭自动预装不取消队列。
- 删除先接纳本工具归属，等待该工具已接纳的准备结束；撤入口、检查占用、删记录、删全部版本。有占用或无法确认时恢复入口。
- 设置复用设置服务写队列，成功后才推送；不维护乐观接受状态。命令回执不得覆盖 UI 快照。
- 每次准备新建网络策略快照和连接池，候选共用该快照，下次重试重新读取代理/noProxy/CA。每个候选从零下载，checksum > interrupted > network；ENOSPC 始终优先。
- 流式 tar.gz 解压拒绝越界路径/链接和不支持的条目，保留执行权限与合法链接。只检查 catalog 中的必需文件；归档身份文件移到打包检查。
- 安装事务先移到最终版本目录，再按 entries 生成私有检查入口，合并 stdout/stderr 校验所有 runtimeChecks。检查临时目录不暴露到公开 bin。POSIX 检查在独立进程组中运行，超时或取消时结束整组；Windows 只结束 shim。stdio 关闭后才清理检查目录。
- 可选 rewrite 在必需文件核对后、移入最终目录前执行：`staging → 文本/二进制前缀改写 → 仅重签改写过的 Mach-O → 最终目录运行检查 → 原子发布`。原 binary 补零放在 NUL 字符串末尾，保留路径后缀与总字节数；按 UTF-8 字节判断路径超长并报告 unsupported。每个文件的 IO 与重签均服从同一 flight 的取消信号。
- 安装记录原子 rename 是唯一发布点。最后取消检查与发布准入之间无 await；已准入发布先结算。发布后的清理失败不撤销有效记录。
- 旧 flight 的进度不覆盖新操作；清理与归属释放后才推送可重试状态。
- 初始化目录/设置故障保留在 worker 为可重试失败，不形成重启循环。worker 报告 initialized 后意外退出才重拉，清 staging、核对记录，但不自动下载；initialized 之前退出视为启动失败，不再重拉，查询与命令以错误结束。

- 04：每个 owner 从有效安装记录派生 installed；目标变化只排队准备新资源，入口在原子发布前继续指向旧版本。真正 App 启动才按占用检查回收非记录版本及移出 catalog 的工具；worker 重启只重建入口和清理 staging。

- 每工具使用开关由协调器串行保存 disabled ID 列表；owner 的发布、删除和开关共用入口写队列，下载不占该队列。设置保存失败不改入口或推送开关值。

- 已保存的 disabled ID 集合是开关唯一事实，owner 快照直接读取它，不缓存第二份 agentEnabled。初始化、发布、开关、重试共用单工具对齐函数，设置/清除独立 entryOutOfSync；失败不回滚记录或设置。sync-entries 不下载或改设置，删除撤入口失败立即中止。
- binary-dir-prefix 由 recipe 逐文件显式选择；安装器调用共享纯字节算法，用 / 填满目录前缀槽并保持后缀偏移。它与原 binary 共享超长日志、unsupported 错误和改写后 Mach-O 重签事务，不按工具身份分支。
