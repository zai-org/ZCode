# storage 模块契约

设置页「数据与统计 → 存储管理」的服务端：扫描本机 `.zcode` 数据根、按类别聚合、按类别清理。spec 见 `docs/settings-storage-management.md`。

类型与测试表达不了的不变量：

- 同一时刻至多一个 running job；`startScan` 隐式取消旧 job，`cancelScan(jobId)` 对非当前 job 是 no-op。
- 同一 job 内进度快照的 `bytes` 只增不减；`status` 只能从 `scanning` 到 `complete | cancelled | failed`。
- `clean` 只删除 catalog 显式匹配且通过 `cleanPlan` 校验的路径；受保护白名单在任何类别下都不删；失败逐路径记入 `failures`，不抛整体异常。
- `entries` 只聚合到规则命中路径的下一级，并有数量上限；快照体积与文件总数无关。
- 数据根来自注入的 `RootsResolverPort`（desktop 传 `homedir()` 与 `getDataBaseDir()`），模块内不读环境变量、不读设置文件。
- 只做桌面端；不进入 task realtime 链路，不区分 `desktop-continuous` / `web-remote-replayable`。

- `preinstalled-tools` 归独立 `preinstalledTools` 类别，cleanability 为 none；它的删除只属于预装工具进程。
