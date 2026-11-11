# Windows 安装器改造 Spec

## 目标

本 spec 约束 Windows NSIS 覆盖安装的四个用户问题：

1. managed 更新不得因为 NSIS 默认的全树清理而删除安装目录中的无关文件；无 manifest 的历史升级不在本轮保证范围内。
2. 对本版本之后生成的、带 ownership manifest 的更新链路，磁盘不足、权限不足和文件清理失败必须显示真实阶段和原因，不能统一伪装成“ZCode 正在运行”。历史版本卸载器不纳入本轮兼容承诺。
3. 安装器需要显示可核对的阶段步骤，并保留离线日志。
4. 更新后开始菜单、桌面快捷方式和 Windows AUMID 必须保持一致；用户主动删除的快捷方式不能被偷偷重建。

## 范围与不变量

- 继续使用 `electron-updater` 下载/校验，Windows 目标继续使用 NSIS；本轮不迁移到 Squirrel 或 MSIX。
- 安装目录是应用文件的执行目录，不是数据目录；只有检测到上一版本没有 ownership manifest、仍可能被旧卸载器全量删除时，命中安装目录或其子目录的 `.zcode` 数据才阻断覆盖安装。支持 manifest 的新卸载器只删除声明文件，不再因为 `.zcode` 阻断。
- 只允许删除当前版本明确声明为应用所有的文件；未知文件默认保留，冲突时以新版本应用文件为准。
- manifest cleanup 必须拒绝绝对路径、`..` 越界和卸载器自身条目；交互式目录保护扫描的 reparse point/junction 加固与访问预算作为后续收敛项。
- 安装器对已实现阶段尽力留下日志；日志写入失败不得阻断安装，日志不得记录完整原始命令行、用户数据内容或凭据。
- 快捷方式只在“已存在但目标失效/不一致”时原位修复；不存在的快捷方式继续尊重用户删除行为。
- 打包态主进程 AUMID 必须等于 electron-builder `appId`；开发态保留独立 AUMID。
- macOS/Linux 不进入 Windows 安装交接分支；桌面 continuous 与手机 web-remote replayable 状态链路不互相扩散。

## 版本边界与前向收敛

- `.zcode-install-manifest` 是新旧卸载器之间的能力标记，不要求比较数字版本。更新调用旧卸载器前，安装器先检查旧安装目录是否存在该文件：存在即按 manifest cleanup，不触发 `.zcode` 保护扫描；缺失即按 legacy full-cleanup 风险处理，先执行 `.zcode` 保护扫描。
- 首次从没有 manifest 的历史版本升级时，继续使用 electron-builder 的旧卸载器流程属于已知限制：旧卸载器可能全量清理安装目录、使用原生重试文案，或无法返回可分类的错误原因。本轮不为这条路径增加备份、恢复、回滚或定制卸载器兼容层。
- 用户在历史版本升级失败时，可以通过卸载重装或手动迁移文件完成升级；这不改变新版本之间更新的可靠性目标。
- 每个后续版本只收敛当前版本仍能观测到的失败，不以一次性兼容所有历史安装状态为目标。新增保证必须以真实安装器/卸载器 smoke 覆盖后再写入本 spec。

## 安装状态与时序

```text
update-downloaded
      |
      v
prepare app exit ----(失败/超时)----> updater error (保留按钮可重试)
      |
      v
launch NSIS
  CHECK_APP_RUNNING
      |
      v
  检查旧安装目录 manifest 能力
      |
      +----(无 manifest)----> `.zcode` 保护扫描
      |                           |
      |                           +----(data)----> blocked
      |                           |
      |                           v
      |                      legacy best-effort（允许原生重试/错误文案）
      |
      +----(有 manifest)----> ownership cleanup（跳过 `.zcode` 扫描）
                                  |
                                  +----(lock/ACL/space)----> 恢复已删除文件 + cleanup log
      |
      v
extract new files -> repair existing shortcuts -> write AUMID/notify Shell
      |
      v
installer-completed (日志可查，完成页直接启动 `$INSTDIR\\ZCode.exe`)
```

## 文件所有权与迁移

### 新版本

打包阶段生成安装器可读的 ownership manifest，记录相对于 `$INSTDIR` 的应用文件（目录不单独列出）。清单随安装包落盘，供下一次更新使用；清理失败的恢复边界见《Windows 更新：安装目录文件保留规范》，不承诺解压阶段或断电的完整文件系统事务。`customRemoveFiles` 只处理 manifest 中声明的条目；未知条目不删除。

### 从旧版本升级（后续增量设计）

旧版本没有 manifest 时，目标方案是在调用旧卸载器前把未能证明为应用所有的条目移入独立临时备份；新版本安装完成后只恢复新版本不存在的条目。备份目录不放在 `$PLUGINSDIR`，回滚失败时保留路径并写入日志。本轮尚未接管 electron-builder 外层的 `uninstallOldVersion` 调用，因此无法改变“第一次从无 manifest 版本升级”时旧卸载器的全树清理行为；当前实现对新版本之间的后续更新生效，详见《Windows 更新：安装目录文件保留规范》。

### 失败与回滚

- manifest cleanup 的 Delete 失败必须记录 cleanup 阶段、失败原因和卸载器 PID，并以非零退出码返回；未处理的文件保持原状；新安装器在调用旧卸载器前备份受管文件，失败时补回已删除文件。
- 管理版本之间更新时，SHELL_CONTEXT 和 HKCU 路径的旧卸载器返回非零都由外层安装器显示清理失败信息；保留 electron-builder 的五次重试，但重试耗尽时显示清理失败、重试/取消提示；取消后恢复已删除文件，不再显示“应用无法关闭”。
- 无 manifest 的历史卸载器不要求返回可分类错误，也不要求执行备份/恢复/回滚。
- 解压、复制和目录保护的细粒度 Win32 错误链路作为后续收敛项；当前不得把它们写成已实现的强保证。

## 诊断与步骤显示

- 本版本交互安装器始终显示 Details 区域（覆盖 electron-builder 默认的 `nevershow`），并把安装段的 `SetDetailsPrint none` 改为 `listonly`。安装详情按顺序显示安装开始、清理阶段、解压阶段、逐项 NSIS `File` 条目、快捷方式阶段和完成收尾；进程启动、初始化事件发生在 `.onInit`，以文件日志为准。
- 上一版本卸载器是独立进程，外层详情先显示 cleanup 开始/完成，进程返回后回放本次卸载器日志；当前版本卸载器会将 manifest 中实际尝试删除的相对路径逐项写入 `%TEMP%\\ZCode-uninstaller.log`。
- 静默更新不显示 UI，但写 `%TEMP%\\ZCode-installer.log`；UAC 提权内层直接尝试写 `%WINDIR%\\Logs\\ZCode-installer.log`。当前没有“外层临时日志按权限复制到 Windir”的实现，日志不可写不应阻断安装。
- 日志 marker 使用数字 PID 和阶段枚举，不写 `$CMDLINE`。当前已实现安装阶段为 `install-started`、`cleanup-started/completed`、`extract-started/completed`、`shortcuts-started/completed`、`install-finalization-started` 和 `install-completed`；managed cleanup 的失败分类限于 `permission-or-disk-space` 和旧卸载器返回非零，`reparse-point`、`extract` 的 Win32 错误码作为后续收敛项。
- 交互式 managed 更新保留最多 5 次旧卸载器重试；重试耗尽后使用本项目的清理失败及退出码提示，用户取消后恢复已删除文件。真实应用进程检查仍使用原有“应用无法关闭”提示；静默路径以退出码和日志为准。
- 清理失败错误框带 `/SD IDOK`，交互模式显示提示，静默模式自动确认并返回退出码 `2`，不得阻塞无人值守更新。

## 快捷方式与 AUMID

- 开始菜单/桌面 `.lnk` 目标正确时原样保留（包括参数）。
- 目标错误但 `.lnk` 存在时原位修复，随后设置稳定 AUMID 并发送 `SHChangeNotify(SHCNE_UPDATEITEM)`。
- 用户删除的 `.lnk` 不重建；完成页直接启动新安装目录的 exe。
- `app.setAppUserModelId()` 在打包态使用生产/Preview 对应 `appId`，开发态使用 `cn.aminer.zcode`。

## 接受用例

| Case                      | 场景                                   | 必须观察到                                                             |
| ------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| WIN-INSTALL-OWNERSHIP-001 | 更新前存在 `notes.txt`/自定义目录      | 更新后文件仍在，应用文件完成替换                                       |
| WIN-INSTALL-OWNERSHIP-002 | 旧版本无 manifest                      | 非本轮保证；允许旧卸载器沿用原生行为，后续只在有明确收益时增加迁移支持 |
| WIN-INSTALL-DIAG-001      | managed cleanup 遇到锁定/权限/磁盘错误 | cleanup 日志有阶段、分类和数字 PID；外层返回非零并显示清理失败         |
| WIN-INSTALL-RECOVERY-001  | 旧卸载器先删主程序、后因文件占用失败   | 主程序原字节恢复，锁定文件与无关文件保留，退出码非零                   |
| WIN-INSTALL-RECOVERY-002  | 备份源文件被独占打开                   | 不运行旧卸载器，原安装目录不变                                         |
| WIN-INSTALL-RECOVERY-003  | 已删除主程序的位置出现同名目录         | 不能声明恢复成功，保留备份并报告路径                                   |
| WIN-INSTALL-DIAG-003      | 旧版本无 manifest 或解压阶段失败       | 非本轮细粒度诊断保证；保留原生安装器结果，后续按真实问题逐步收敛       |
| WIN-INSTALL-DIAG-002      | 静默 `/S` 更新                         | 无 UI 但有阶段日志，日志 PID 为数字且无原始命令行                      |
| WIN-INSTALL-SHORTCUT-001  | 正确/失效/被删除的快捷方式             | 正确项保留参数，失效项修复，删除项不重建                               |
| WIN-INSTALL-AUMID-001     | 生产与 Preview 打包运行                | 主进程 AUMID 与 NSIS `appId` 相等，可被 Shell 正确索引/固定            |

## 本轮实现边界

本轮保证 ownership cleanup、安装详情中的阶段和解压文件列表、卸载器日志中的逐文件清理记录、快捷方式/AUMID 一致性，并用真实 NSIS smoke 覆盖。完整安装事务、reparse-safe 目录扫描、解压 Win32 错误码、Windir 日志复制和跨版本 manifest 迁移均属于后续收敛项；不得把这些未实现能力写成当前版本保证。
