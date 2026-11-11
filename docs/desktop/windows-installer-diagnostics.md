# Windows 安装器诊断规范

## 目标

对本版本之后生成的 managed 更新，用户能在安装器详情和文件日志中看到可定位的阶段与进程，且静默更新仍记录同一组阶段事件。安装器使用 `.zcode-install-manifest` 判断上一版本卸载器能力，而不是依赖数字版本号：缺失 manifest 时按旧卸载器的全量删除风险处理，存在 manifest 时按新卸载器的选择性清理处理。

## 阶段事件

安装器启动后按顺序记录：

1. `installer-process-started`：记录安装器进程 PID 与角色（`outer` 或 `elevated-inner`）。
2. `installer-initialized`：记录安装模式（`interactive` 或 `silent`）。
3. `install-started`：进入 electron-builder 安装段。
4. `cleanup-started` / `cleanup-completed`：调用上一版本卸载器并处理其返回结果。
5. `extract-started` / `extract-completed`：开始/完成应用文件解压；两者之间的 NSIS `File` 条目会逐项显示在详情区。
6. `shortcuts-started` / `shortcuts-completed`：处理开始菜单和桌面快捷方式。
7. `install-finalization-started`：进入项目自定义收尾（快捷方式失效目标修复、启动目标设置）。
8. `install-completed`：安装段成功返回。

```text
NSIS .onInit
   │
   ├─ 初始化日志路径并写入 installer-process-started(pid)
   └─ 判断静默/交互模式并写入 installer-initialized
          │
          └─ install-started
                  ├─ cleanup-started → cleanup-completed
                  ├─ extract-started → File 条目 → extract-completed
                  ├─ shortcuts-started → shortcuts-completed
                  └─ customInstall：install-finalization-started → install-completed
```

交互式安装器始终显示 NSIS Details 区域，并在安装段开始时把 electron-builder 默认的 `SetDetailsPrint none` 改为 `listonly`。因此解压期间的每个 NSIS `File` 条目会持续出现在详情区；阶段事件同时写入详情区和日志文件。进程启动和初始化事件发生在 `.onInit`，详情控件尚未创建时不承诺回填到页面，只以文件日志为准。

旧卸载器由 electron-builder 作为独立进程运行，外层详情区先显示 cleanup 开始/完成，进程返回后再回放本次卸载器日志中的逐条记录；原始日志仍保留在 `%TEMP%\\ZCode-uninstaller.log`，用于核对实际尝试删除了哪些文件。历史版本卸载器仍可能只显示原生重试文案。

## 日志路径与安全边界

- 默认日志：`%TEMP%\ZCode-installer.log`。
- 外层安装器可通过 `/LOG=<path>` 指定路径，便于支持人员收集日志。
- UAC 提权内层不接受继承的 `/LOG` 路径，直接尝试写入 `%WINDIR%\Logs\ZCode-installer.log`，避免低权限调用方控制高权限文件路径。当前不承诺把外层 `%TEMP%` 日志复制到 Windir。
- 每条日志包含 `pid=<十进制 PID>`；日志写入失败只影响诊断，不得阻止安装流程。
- 正式安装器的内层判据必须接入 electron-builder 使用的 `UAC_IsInnerInstance`；不能默认写成恒假，只在 smoke fixture 中强制模拟内层。测试替换只允许隔离夹具显式定义，正式默认行为必须使用真实 UAC 状态。

## 卸载器能力判断

- 安装器在调用旧卸载器前检查旧 `$INSTDIR\\.zcode-install-manifest`。
- manifest 存在：上一版本卸载器支持 ownership cleanup，跳过 `.zcode` 目录保护扫描。
- manifest 缺失：上一版本可能是旧的全量删除卸载器，先扫描安装目录及子目录；发现 `.zcode` 时阻止继续安装。
- manifest 缺失不等同于某个精确数字版本，可能是历史版本、手动删除清单或安装损坏；统一采用保守路径。

## 兼容边界

- 只有上一版本已经携带 `.zcode-install-manifest` 时，ownership cleanup 和 `cleanup-failed` 分类才属于本规范的强保证；缺失 manifest 的路径采用旧卸载器兼容和 `.zcode` 保护。
- 从没有 manifest 的历史版本升级时，允许 electron-builder 原生卸载器重试和原生错误文案；本轮不接管其备份、恢复或全树清理。
- 交互式 managed 更新若旧卸载器重试耗尽，显示本项目的清理失败及退出码提示；用户取消后恢复已删除文件。真实应用进程检查仍保留原有提示，静默更新以退出码和日志为准。
- 清理失败提示使用 `/SD IDOK`：交互模式显示错误框，静默模式自动采用默认确认并返回退出码 `2`，不会等待用户操作。

## 当前未覆盖的诊断

- 目录保护扫描的 reparse point/junction 拒绝、访问预算、循环检测和 `.zcode-dev` 识别。
- electron-builder 解压阶段每个 Copy/Extract 的 Win32 错误码（阶段和文件条目已覆盖）。

## 静默安装

静默模式没有可见页面，仍必须在 `.onInit` 记录 `installer-initialized mode=silent`，并在安装段记录开始与完成事件。后续错误分类可据此关联安装器进程和阶段。

## 验收

- 编译顺序：`installer.nsh` 加载时只声明依赖扩展插件的日志初始化宏；electron-builder 注册插件目录后，由 `customHeader` 展开函数，`.onInit` 的 `preInit` 仍调用同一函数。不得依赖异步生成 header 时 `!addplugindir` 与自定义 include 的完成顺序。
- 编译回归必须在自定义 include 之后注册 NSIS 扩展插件目录，使用真实 `UAC_IsInnerInstance`，同时覆盖安装器与卸载器；普通 smoke 不再把外层判断替换为恒假，只有提权内层隔离场景保留显式模拟。
- Windows NSIS smoke fixture 能编译并运行交互/静默安装。
- 日志包含上述阶段且 PID 为正整数；`/LOG` 覆盖默认路径。
- 提权内层测试证明调用方提供的日志路径不会被修改。

## 清理恢复诊断

新安装器在执行带 manifest 的旧卸载器前记录 `cleanup-backup-completed`，包含备份路径与
`failed`。旧卸载器重试耗尽记录 `cleanup-retries-exhausted exit-code=...`，不再在此路径显示
“应用无法关闭”。实际应用进程检查仍使用原有提示。

清理失败后记录 `cleanup-restore-completed`；复制失败同时记录相对路径和 `win32-error`。
恢复失败必须保留备份并向用户显示其路径。此保证只覆盖旧卸载器清理阶段，不代表解压失败
或断电可回滚，也不证明所有“应用无法关闭”反馈都来自清理重试。
