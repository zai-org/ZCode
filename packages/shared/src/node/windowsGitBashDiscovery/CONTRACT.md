# Windows Git Bash 发现

此模块只负责在执行所在机器上读取有限安装线索，返回第一个可用 Git Bash 路径。设置页和 CLI 消费同一算法；模块不保存设置或 session 状态。

- 固定目录与 PATH 的原有优先关系保持；新增来源只在它们未命中时读取。
- PATH 中一个 Git 没有配套 Bash时继续后面的候选；Scoop shims 只提供根目录线索，不执行代理。
- 新增根按 Git for Windows 布局校验，返回 `bin\bash.exe`，不执行窗口启动器或其他发行版 Bash。
- 布局校验不是信任校验。全局 Scoop 与系统盘 `tools\git` 不作为无线索默认候选；只有安装变量、用户配置、PATH 或安装记录明确指向时才检测，线索缺失或失效不恢复该兜底。当前用户的默认 Scoop 目录保留。
- 文件、配置、注册表异步读取；只查询确定的安装键和已知相对路径，无目录递归、程序执行探测或持久化缓存。
- 安装线索读取失败可由下一个来源恢复；不存在有效候选时返回 undefined，不代替调用方决定 CMD 或用户选择的语义。
- 测试注入文件检查及安装记录读取，避免宿主真实安装影响结果。非 Windows 返回 undefined，不执行这些 IO。

完整发现顺序与覆盖边界见 [Shell spec](../../../../../docs/runtime-tools/bash-effective-shell-snapshot.md#解析规则)。
