# Windows 更新安装交接

## 目标

Windows 桌面端继续使用 `electron-updater` 下载和校验更新，并通过
`quitAndInstall()` 交给 `electron-builder 26.17.0` 生成的 NSIS 安装器完成覆盖安装。
本方案不自定义下载器、增量更新算法或安装引擎，只补齐 ZCode 多进程退出和 NSIS
快捷方式保留策略之间的边界。

## 交接时序

```text
update-downloaded
  -> renderer 将“重启以更新”保持为 pending，禁止按固定短计时器重新启用
  -> main 标记 update_install
  -> 停止 app 级后台服务
  -> Cron Scheduler 与本地/SSH/WSL/Docker/Bot Host 并行进入统一退出屏障
  -> 最多等待 9 秒（7.5 秒触发强制结束）
  -> 实时扫描仍引用随包资源的 runtime，并对匹配进程执行 taskkill
  -> electron-updater.quitAndInstall()
  -> NSIS CHECK_APP_RUNNING 做现有的安装目录进程检查
  -> 解析旧安装目录后，在备份前再次检查同目录 ZCode.exe 残留并确认退出
  -> NSIS 读取旧安装目录 manifest 并按所有权备份
  -> 运行旧卸载器清理旧版本
  -> 完成页直接启动新安装目录下的 ZCode.exe
```

Main 进程不能在调用 `quitAndInstall()` 前按整个安装目录杀进程，因为 renderer、GPU
和当前 main 自身也从该目录运行。Main 只负责自己拥有的 host/agent/runtime；安装器启动后
按旧安装目录收口 ZCode.exe 进程，包括独立存活的 Crashpad handler。只按进程名匹配不安全，
安装器随包的原生 helper 必须先以查询权限读取完整映像路径，仅对目标目录的进程申请终止权限，
并在用于终止和等待的同一句柄上重新核对路径，避免 PID 复用或其他目录的同名进程权限不足误阻断更新。
结束后再枚举确认无残留。若候选路径无法查询、目标进程无法结束或复查失败，安装器停止旧版本清理并记录阶段、
进程名及 PID；独立诊断日志写入失败不能改变检查结果，stdout 仍返回诊断。
检查不依赖 PowerShell、Add-Type 或其他动态编译环境。

旧卸载器清理前的最终检查位于 `uninstallOldVersion` 已解析旧安装目录后的备份 hook，
同时覆盖自动更新和手动覆盖安装。现有 `CHECK_APP_RUNNING` 保持不变；本次不能证明它
漏检的原因。最终检查不依赖父进程是否存活、PowerShell 是否可用或动态编译权限；二次枚举只验证，若进程
仍存活则阻断。查询失败时必须阻断清理，不能解释为无残留。

## 行为约束

- 更新安装复用普通应用退出的唯一回收屏障：本地 Host、正在释放的 Host，以及
  SSH/WSL/Docker/Bot Remote Host 使用显式 `update-install` policy，最多等待 9 秒，并覆盖
  7.5 秒的强制回收时点；Windows 普通退出使用独立的 4 秒强杀/4.5 秒总等待预算，不得把
  普通退出的短预算误用于首次进入的更新安装。若更新请求与已启动的普通退出竞态，既有短
  timer 不重建；更新等待该屏障后继续实时资源扫描和安装器交接，不因残留或混合预算拒绝更新。
  Windows 普通退出的 4 秒预算仅用于 Local Host；Remote Host 始终保留 7.5 秒强杀与 9 秒
  等待上界，确保其串行 service/remote-connection 关闭阶段不会被普通关窗提前截断。
  Cron Scheduler 的 1.5 秒关闭兜底与 Host 清理并行执行，包含在同一 9 秒总屏障内，不得
  在 Host 屏障之前串行追加；进入关闭状态后不得再向 Host 派发 CronRun。
  Windows
  专项清理不得再次追加一段 Host 等待，只允许对屏障后实时扫描仍引用随包资源的进程
  执行一次集中式 `taskkill`，并保留 750ms 让 Windows 释放安装资源句柄。退出屏障前登记的
  Host/Agent PID 属于历史瞬时编号，不得跨越异步退出边界直接作为强杀身份。
- 更新前扫描到的随包 runtime 残留进程必须记录 PID、可执行路径和命令行，并尽力执行进程
  树回收。扫描失败、`taskkill` 非零或复扫仍有残留时记录告警但继续升级，辅助清理不得成为
  用户升级的新阻碍。
- 用户点击“重启以更新”后，renderer 不得用固定 5 秒 ACK 计时器释放按钮锁。退出准备和
  Windows 安装器交接可能超过该时间；成功路径保持禁用直到应用退出。main 在 ready 状态失效
  或退出准备失败、尚未调用安装器时必须 reject renderer IPC；renderer 收到 reject，或观察到
  更新状态离开 `update-downloaded` 时恢复按钮，避免永久 pending 与重复点击。
- PowerShell 进程扫描器必须排除执行查询的 PowerShell 自身。资源路径会作为查询脚本文本
  出现在扫描器命令行中，不能将该命令行误判为资源占用，也不能把扫描器 PID 交给后续
  `taskkill`。
- 不绕过 NSIS 的最终运行中应用检查；该检查不承诺覆盖所有独立 runtime。产品接受极少数
  runtime 持续占用时安装资源可能不完整的残余风险，并通过新版本启动完整性诊断保留证据。
- 旧卸载器进程收口：按完整映像路径和旧安装目录识别主程序及 Crashpad handler；结束与确认使用同一进程句柄；二次枚举发现重生、访问拒绝或查询失败时在备份前中止并记录 PID 与阶段。
- 注册表写入安装信息键和卸载项时都写入实际 `$INSTDIR` 的 `InstallLocation`，兼容通过 `UninstallString` 回退旧路径的历史安装。
- 覆盖更新保留用户“是否创建快捷方式”的选择：用户已删除的快捷方式不重新创建。
- 手动运行安装包覆盖已有版本（包括版本降级）时没有 `--updated` 参数。electron-builder 26.8.1
  在允许修改安装目录的 assisted installer 中会因此跳过 `KeepShortcuts`，旧卸载器继而调用
  `UninstShortcut` 注销 Windows 固定项；新安装器事后重建同名 `.lnk` 也不会恢复固定关系。
  安装目录页面生成后必须撤掉只用于该页面的预处理开关，使后续旧版本卸载交接在手动覆盖
  与自动更新两条路径都尝试传递 `--keep-shortcuts`。该保证只覆盖沿用原安装目录的覆盖安装；
  用户主动更换安装目录时 electron-builder 会创建指向新位置的快捷方式，不承诺迁移旧固定关系。

  ```text
  手动覆盖（无 --updated）
    -> 保留旧快捷方式并运行旧卸载器 --keep-shortcuts
    -> 安装新版本
    -> 保留原 .lnk / 固定身份
    -> 若继承的目标失效，则原位修复 .lnk
  ```

- 覆盖更新时，开始菜单和桌面快捷方式先由 electron-builder 的 `KeepShortcuts` 机制保留。
  ZCode 的 `customInstall` 必须读取已有 `.lnk` 的目标：目标已经等于本次 `$appExe` 时原样保留，
  不得再次调用 `CreateShortCut`；目标不同、为空或无法读取时才原位修复为 `$appExe`。修复原因
  是无条件覆盖 `.lnk` 会改变 Shell 观察到的快捷方式对象，在部分 Windows 11 版本或缓存状态
  下丢失“所有应用”索引或用户固定关系，而完全不修复又会让历史错误目标在升级后继续失效。
- 条件修复快捷方式后必须重新写入稳定 AUMID，并以 `SHCNE_UPDATEITEM` 通知 Windows Shell；
  用户已删除的快捷方式仍不得重新创建。
- 快捷方式名称或菜单目录确需迁移时，继续由 electron-builder 内建流程执行重命名、AUMID
  写入与 `SHChangeNotify`；不得在其通知 Shell 之后再静默修改 `.lnk`。
- assisted installer 完成页不得依赖可能由旧版本保留下来的 `.lnk`，必须直接启动
  `$INSTDIR\ZCode.exe`。
- `config.json.lock` 属于服务层跨进程原子写锁，不属于 Electron 更新器。等待者自身的等待
  时长只能决定何时返回超时，不能作为当前锁 stale 的证据；PID 仍存活的 owner 不允许被
  运行期等待者强制接管，正常并发写入必须保持串行。
- 锁目录在写入唯一 owner 文件前崩溃可能留下空目录；空目录或无有效唯一 owner 的损坏
  目录使用默认 100ms 的短 grace，且有效 grace 不得超过当前等待预算的一半，保证在一次
  写入等待内可回收。创建者写入 owner 后必须校验仍是自己创建的目录实例，避免暂停恢复
  时写进后来 writer 重建的锁目录。
- 锁元数据中的 PID 和创建时间均视为不可信输入；创建时间只接受有限、非负且最多超前
  5 分钟的值。非法值回退到同样受校验的 owner 文件 mtime，两者都非法时从当前观察时刻
  起算 stale；该观察时间必须绑定当前锁实例并在实例替换后重置，不能复用等待者进入旧锁
  竞争时的 startedAt，也不能在每次轮询时重新起算。禁止损坏或未来时间戳造成永久锁死。
- 当前更新安装交接不枚举或删除数据目录中的 `*.lock`；PID 被复用时，旧锁可能继续超时，
  这是当前接受的残余风险。若后续增加更新期锁清理，只能在确认相关进程退出后执行，不能
  下沉为 `atomicWriteText` 的通用运行期强制解锁规则。

## 失败边界

- 下载、签名、SHA 校验和安装包启动失败继续由 `electron-updater` 报错状态承接。
- host/agent 退出细节写入 main 日志；NSIS 无法关闭进程时不继续覆盖安装目录。
- Windows 随包 runtime 扫描与强杀采用 fail-open：PowerShell 查询失败、超时、强杀失败或
  复扫残留只告警，不中断 `quitAndInstall()`；升级可达性优先于辅助扫描的硬完整性门槛。
- 原子写锁不能把底层 `open(..., "wx")` 的短暂 `EEXIST` 直接暴露给用户；优先清理由
  已退出 owner 遗留的锁。正常竞争最多等待 8 秒；活跃 owner 到期后返回锁超时，只有
  owner 已退出，或锁缺少有效 PID 且当前锁自身已 stale 时才允许接管，不能沿用等待者在
  旧锁上的等待时长判断后来出现的新锁。删除权限不足时返回明确错误，禁止无限重试。
- 等待预算耗尽统一返回 `ZCODE_FILE_LOCK_TIMEOUT`。该错误码由 `@zcode/shared` 定义并由
  UI/服务消费者按 code 识别为瞬时锁竞争，不得依赖错误消息恰好包含 `config.json.lock`。
- sessions-index 订阅是幂等读，可在 UI 层按锁超时重试；provider/settings 写入
  已在原子写入口内等待并恢复，不在上层盲重放非幂等写操作，失败时保留明确错误交给调用方。
- 新版本启动时继续执行 bundled runtime 完整性诊断，以区分安装资源缺失和快捷方式失效。

## 验证范围

- Windows `installer.nsh` 必须使用当前锁定的 electron-builder 对应的真实 NSIS compiler、include
  与 plugin 目录做独立编译测试，禁止只靠源码字符串断言判断宏可用。
- NSIS 隔离夹具在临时安装目录执行覆盖更新宏：目标已经正确的桌面/开始菜单快捷方式必须
  保留目标、参数和 Shell 身份；目标失效的快捷方式必须修复为 `$appExe`；用户已删除的快捷
  方式不得重新创建，且 `$launchLink` 必须直接等于 `$appExe`。
  夹具不得写入真实桌面、开始菜单、ZCode 安装目录或产品注册表。
- 完整安装包 smoke test 继续覆盖 electron-builder 生成脚本中的宏插入位置和真实 NSIS 覆盖安装；
  独立夹具负责在不重打完整应用包时快速发现变量作用域、label、插件和快捷方式语义回归。

- Windows 覆盖更新：本地/Remote Host 正常退出、Host 需要强制退出、随包 runtime 子进程
  残留，以及 PowerShell 查询进程不得匹配自身。
- NSIS 安装目录进程检查：孤儿 Crashpad handler 在旧 ZCode.exe 仍加载时必须被找到并退出；
  其他安装目录的同名进程不得被结束；查询/结束/复查异常时安装器不得开始旧卸载清理。
- Windows 注册表：安装成功后安装信息键和卸载项的 `InstallLocation` 均指向实际安装目录。
- 快捷方式：开始菜单/桌面快捷方式目标正确、目标失效或被用户删除；只允许修复失效 `.lnk`。
- 完成页：存在旧 `.lnk` 时仍从新安装目录直接启动 exe。
- 原子写锁：同目标并发写、owner 崩溃留下新锁、超过 stale 阈值的锁、旧锁等待期间被新
  token 接管后不得误删新锁、后来出现的新空目录/ownerless 锁不得继承旧等待时长、创建
  owner 前崩溃留下的空锁目录、非法 PID/时间戳按锁实例首次观察时间完成回收。
- macOS/Linux 不进入 Windows 安装交接分支；原子写锁行为保持跨平台一致。
