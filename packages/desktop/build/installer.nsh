!include nsDialogs.nsh
!include FileFunc.nsh

!ifndef ZCODE_INSTALLER_DEFAULT_LOG_PATH
  !define ZCODE_INSTALLER_DEFAULT_LOG_PATH "$TEMP\ZCode-installer.log"
!endif
!ifndef ZCODE_INSTALLER_ELEVATED_LOG_PATH
  !define ZCODE_INSTALLER_ELEVATED_LOG_PATH "$WINDIR\Logs\ZCode-installer.log"
!endif
!ifndef ZCODE_INSTALLER_IS_ELEVATED_INNER
  ; 修复原因：来源只在测试夹具模拟内层，正式默认恒假会让提权进程继续使用调用方 /LOG。
  ; 使用 electron-builder 同一 UAC 判据；隔离夹具仍可显式替换，不改变真正的提权流程。
  !include UAC.nsh
  !define ZCODE_INSTALLER_IS_ELEVATED_INNER `${UAC_IsInnerInstance}`
!endif

!ifndef ZCODE_INSTALLER_PROCESS_HELPER
  ; CR-01 修复原因：普通 NSIS 只有 APP_64/APP_ARM64（压缩包路径），没有 APP_DIR_*；
  ; 正式构建由 afterPack 落盘按架构的 helper define 文件（见 electron-builder.config.js），
  ; 编译时按目标架构 include；缺失不在此报错，宏内在真正使用处明确失败。
  !ifdef APP_ARM64
    !include /NONFATAL "${__FILEDIR__}\generated\zcode-process-helper-arm64.nsh"
  !else
    !include /NONFATAL "${__FILEDIR__}\generated\zcode-process-helper-x64.nsh"
  !endif
!endif

!ifndef ZCODE_INSTALL_MANIFEST_NAME
  !define ZCODE_INSTALL_MANIFEST_NAME ".zcode-install-manifest"
!endif

!ifndef ZCODE_UNINSTALLER_LOG_PATH
  !define ZCODE_UNINSTALLER_LOG_PATH "$TEMP\ZCode-uninstaller.log"
!endif
!ifndef ZCODE_UNINSTALLER_FUNCTION_PREFIX
  !define ZCODE_UNINSTALLER_FUNCTION_PREFIX "un."
!endif

!ifdef BUILD_UNINSTALLER
  Var ZCodeUninstallerLogUnavailable

  ; 卸载器只在更新时删除旧文件；单独记录清理阶段，避免外层把权限/空间错误误报成应用仍在运行。
  !macro ZCodeReportUninstallerStage MESSAGE
    DetailPrint "ZCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ${ZCODE_UNINSTALLER_FUNCTION_PREFIX}ZCodeWriteUninstallerLog
  !macroend

  Function ${ZCODE_UNINSTALLER_FUNCTION_PREFIX}ZCodeWriteUninstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeUninstallerLogUnavailable "1" zcodeUninstallerLogDone
    ClearErrors
    FileOpen $R1 "${ZCODE_UNINSTALLER_LOG_PATH}" a
    IfErrors zcodeUninstallerLogFailed zcodeUninstallerLogWrite
    zcodeUninstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto zcodeUninstallerLogDone
    zcodeUninstallerLogFailed:
      ; 日志不可写不应改变卸载结果，保留原始清理错误供外层处理。
      StrCpy $ZCodeUninstallerLogUnavailable "1"
      ClearErrors
    zcodeUninstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  !macro customRemoveFilesDiagnosticsStart
    !insertmacro ZCodeReportUninstallerStage "cleanup-started"
  !macroend

  !macro customRemoveFilesDiagnosticsComplete
    !insertmacro ZCodeReportUninstallerStage "cleanup-completed"
  !macroend
!endif

!macro customRemoveFiles
  ; Bugfix：electron-builder 默认在更新时递归删除整个 $INSTDIR，用户放入的无关文件也会被清掉。
  ; 只按上一版本随包生成的所有权清单删除，清单缺失时迁移旧版本采用 fail-open 保留策略。
  ${if} ${isUpdated}
    !ifdef BUILD_UNINSTALLER
      !insertmacro customRemoveFilesDiagnosticsStart
    !endif
    ClearErrors
    FileOpen $R0 "$INSTDIR\${ZCODE_INSTALL_MANIFEST_NAME}" r
    IfErrors zcodeManifestMissing

    zcodeManifestRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeManifestClose
      ; NSIS FileRead 保留行尾 CRLF；打包清单统一使用换行结尾，先去掉两个行尾字符。
      StrCpy $R1 $R1 -2
      StrCmp $R1 "" zcodeManifestRead

      ; 拒绝绝对路径和 .. 前缀，避免损坏或篡改清单越界删除。
      StrCpy $R2 $R1 1
      StrCmp $R2 "\\" zcodeManifestRead
      StrCmp $R2 "/" zcodeManifestRead
      StrCpy $R2 $R1 2
      StrCmp $R2 ".." zcodeManifestRead
      StrCmp $R1 "${UNINSTALL_FILENAME}" zcodeManifestRead
      ; 清单是当前打开的元数据，自引用条目不能当作普通载荷删除。
      StrCmp $R1 "${ZCODE_INSTALL_MANIFEST_NAME}" zcodeManifestRead
      GetFullPathName $R2 "$INSTDIR\$R1"
      StrCmp $R2 "$INSTDIR\$R1" 0 zcodeManifestRead

      ; 当前版本卸载器与外层安装器是两个进程；逐项记录到卸载器日志，便于核对真正尝试删除的文件。
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-file path=$R1"
      !endif
      ClearErrors
      Delete "$INSTDIR\$R1"
      IfErrors zcodeManifestDeleteFailed
      Goto zcodeManifestRead

    zcodeManifestDeleteFailed:
      System::Call 'kernel32::GetLastError() i.R2'
      FileClose $R0
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-failed reason=delete-failed path=$R1 win32-error=$R2"
      !endif
      Abort "无法删除旧版本文件：$INSTDIR\$R1（Win32 错误 $R2）"

    zcodeManifestClose:
      FileClose $R0
      Goto zcodeManifestDone

    zcodeManifestMissing:
      ; 首次从旧版本升级时没有清单，不能猜测所有权并删除用户文件。
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-skipped reason=manifest-missing action=preserve"
      !endif
      ClearErrors

    zcodeManifestDone:
      !ifdef BUILD_UNINSTALLER
        !insertmacro customRemoveFilesDiagnosticsComplete
      !endif
  ${else}
    ; 普通卸载仍保持 electron-builder 的全量删除语义；ownership 清单只约束覆盖更新。
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var ZCodeInstallerLogPath
  Var ZCodeInstallerLogUnavailable
  Var ZCodeInstallerProcessRole
  Var ZCodeUninstallerDetailsUnavailable
  Var ZCodePreviousUninstallerSupportsManifest

  ; 详情面板和文件日志共用同一条阶段事件，避免静默安装丢失关键上下文。
  !macro ZCodeReportInstallerStage MESSAGE
    SetDetailsPrint listonly
    DetailPrint "ZCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ZCodeWriteInstallerLog
  !macroend

  Function ZCodeWriteInstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeInstallerLogPath "" zcodeInstallerLogDone
    StrCmp $ZCodeInstallerLogUnavailable "1" zcodeInstallerLogDone
    StrCpy $R2 0
    zcodeInstallerLogOpen:
      ClearErrors
      FileOpen $R1 $ZCodeInstallerLogPath a
      IfErrors zcodeInstallerLogRetry zcodeInstallerLogWrite
    zcodeInstallerLogRetry:
      IntOp $R2 $R2 + 1
      IntCmp $R2 3 zcodeInstallerLogFailed zcodeInstallerLogWait zcodeInstallerLogFailed
    zcodeInstallerLogWait:
      Sleep 50
      Goto zcodeInstallerLogOpen
    zcodeInstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto zcodeInstallerLogDone
    zcodeInstallerLogFailed:
      StrCpy $ZCodeInstallerLogUnavailable "1"
      ClearErrors
    zcodeInstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  Function ZCodeResetUninstallerLog
    StrCpy $ZCodeUninstallerDetailsUnavailable ""
    ClearErrors
    FileOpen $R0 "${ZCODE_UNINSTALLER_LOG_PATH}" w
    IfErrors zcodeUninstallerDetailsResetFailed zcodeUninstallerDetailsResetSucceeded
    zcodeUninstallerDetailsResetSucceeded:
      FileClose $R0
      Goto zcodeUninstallerDetailsResetDone
    zcodeUninstallerDetailsResetFailed:
      ; 外层详情不能读取旧卸载器日志时仍继续安装，文件日志和退出码仍是最终依据。
      StrCpy $ZCodeUninstallerDetailsUnavailable "1"
      ClearErrors
    zcodeUninstallerDetailsResetDone:
  FunctionEnd

  Function ZCodeShowUninstallerCleanupDetails
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeUninstallerDetailsUnavailable "1" zcodeShowUninstallerDetailsDone
    ClearErrors
    FileOpen $R0 "${ZCODE_UNINSTALLER_LOG_PATH}" r
    IfErrors zcodeShowUninstallerDetailsDone
    zcodeShowUninstallerDetailsRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeShowUninstallerDetailsClose
      StrCmp $R1 "" zcodeShowUninstallerDetailsRead
      SetDetailsPrint listonly
      DetailPrint "ZCode: cleanup-log $R1"
      Goto zcodeShowUninstallerDetailsRead
    zcodeShowUninstallerDetailsClose:
      FileClose $R0
    zcodeShowUninstallerDetailsDone:
      Pop $R2
      Pop $R1
      Pop $R0
  FunctionEnd

  !macro preInit
    Call ZCodeInitializeInstallerLog
  !macroend

  !macro customInit
    IfSilent zcodeInstallerInitSilent zcodeInstallerInitInteractive
    zcodeInstallerInitSilent:
      !insertmacro ZCodeReportInstallerStage "installer-initialized mode=silent"
      Goto zcodeInstallerInitDone
    zcodeInstallerInitInteractive:
      !insertmacro ZCodeReportInstallerStage "installer-initialized mode=interactive"
    zcodeInstallerInitDone:
  !macroend

  ; 这些宏由打包时的 electron-builder installSection.nsh 补丁按安装顺序调用。
  ; 只有阶段 marker 写入详情和日志，解压文件明细由 NSIS 的 File 命令在 listonly 模式输出。
  !macro customInstallSectionStarted
    !insertmacro ZCodeReportInstallerStage "install-started"
  !macroend

  !macro customInstallCleanupStarted
    Call ZCodeResetUninstallerLog
    !insertmacro ZCodeReportInstallerStage "cleanup-started"
  !macroend

  !macro customInstallCleanupCompleted
    !insertmacro ZCodeReportInstallerStage "cleanup-completed"
    Call ZCodeShowUninstallerCleanupDetails
  !macroend

  !macro customInstallExtractStarted
    !insertmacro ZCodeReportInstallerStage "extract-started"
  !macroend

  !macro customInstallExtractCompleted
    !insertmacro ZCodeReportInstallerStage "extract-completed"
  !macroend

  !macro customInstallShortcutsStarted
    !insertmacro ZCodeReportInstallerStage "shortcuts-started"
  !macroend

  !macro customInstallShortcutsCompleted
    !insertmacro ZCodeReportInstallerStage "shortcuts-completed"
  !macroend

  Function ZCodeDetectPreviousUninstallerCapabilities
    StrCpy $ZCodePreviousUninstallerSupportsManifest "0"
    ; manifest 是卸载器能力标记：存在即表示旧卸载器会按清单选择性删除。
    IfFileExists "$INSTDIR\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodePreviousUninstallerCapabilityCheckNested
      StrCpy $ZCodePreviousUninstallerSupportsManifest "1"
      Return

    zcodePreviousUninstallerCapabilityCheckNested:
      ; assisted installer 的目录页会在后续 instfilesPre 才补上 APP_FILENAME 子目录，提前兼容两种形态。
      IfFileExists "$INSTDIR\${APP_FILENAME}\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodePreviousUninstallerCapabilityDone
        StrCpy $ZCodePreviousUninstallerSupportsManifest "1"

    zcodePreviousUninstallerCapabilityDone:
  FunctionEnd

  !macro ZCodeCleanupErrorMessage CHINESE ENGLISH
    ${If} $LANGUAGE == 2052
      MessageBox MB_OK|MB_ICONSTOP "${CHINESE}" /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "${ENGLISH}" /SD IDOK
    ${EndIf}
  !macroend

  Var ZCodeCleanupSource
  Var ZCodeCleanupBackup
  Var ZCodeCleanupMode
  Var ZCodeCleanupFailed
  Var ZCodeCleanupManifest
  Var ZCodeCleanupManifestHasSelf

  ; 修复原因：PowerShell 或 Add-Type 被禁用时不能阻断已退出应用的更新；随包 helper 按路径验证句柄。
  !macro ZCodeStopPreviousInstallProcesses
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    ; CR-01 修复原因：普通 NSIS 只有 APP_64/APP_ARM64（压缩包路径），没有 APP_DIR_*；
    ; helper 来源由文件顶层的生成 define 提供，缺失在此明确失败，不得回退压缩包宏。
    !ifndef ZCODE_INSTALLER_PROCESS_HELPER
      !error "Installer process helper requires ZCODE_INSTALLER_PROCESS_HELPER or generated define"
    !endif
    File /oname=zcode-installer-process-helper.exe "${ZCODE_INSTALLER_PROCESS_HELPER}"
    nsExec::ExecToStack /TIMEOUT=30000 `"$PLUGINSDIR\zcode-installer-process-helper.exe" "$installationDir\${APP_EXECUTABLE_FILENAME}"`
    Pop $R1
    Pop $R2
    StrCmp $R1 "0" zcodePreviousProcessesStopped
    !insertmacro ZCodeReportInstallerStage "process-cleanup-failed exit-code=$R1 install-dir=$installationDir details=$R2"
    !insertmacro ZCodeCleanupErrorMessage "无法验证或关闭旧版本进程，安装已停止。请关闭 ZCode 后重试。进程信息：$R2" "Cannot verify or close previous-version processes. Setup stopped. Close ZCode and retry. Process details: $R2"
    SetErrorLevel 2
    Quit
    zcodePreviousProcessesStopped:
      !insertmacro ZCodeReportInstallerStage "process-cleanup-completed install-dir=$installationDir details=$R2"
  !macroend

  ; 旧卸载器已删除的文件不会自行恢复。新安装器在调用旧代码前尽力保存受管文件，
  ; 只有完整备份才能用于清理失败后的恢复；备份失败不阻断安装。
  ; 自定义 include 先于 common.nsh；延迟展开，确保卸载器名称已定义，避免正式打包 warning 6000。
  !macro ZCodeDefineCleanupSnapshot
  Function ZCodeCleanupSnapshot
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    StrCpy $R5 ""
    StrCpy $ZCodeCleanupFailed "0"
    StrCmp $ZCodeCleanupMode "restore" zcodeSnapshotRead
    StrCpy $ZCodeCleanupBackup ""
    StrCpy $ZCodeCleanupManifestHasSelf "0"
    IfFileExists "$ZCodeCleanupSource\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodeSnapshotDone
    ${GetParent} $ZCodeCleanupSource $R0
    ClearErrors
    GetTempFileName $ZCodeCleanupBackup $R0
    IfErrors zcodeSnapshotFailed
    Delete "$ZCodeCleanupBackup"
    CreateDirectory "$ZCodeCleanupBackup"
    IfErrors zcodeSnapshotFailed
    System::Call 'kernel32::CopyFileW(w "$ZCodeCleanupSource\${ZCODE_INSTALL_MANIFEST_NAME}", w "$ZCodeCleanupBackup\${ZCODE_INSTALL_MANIFEST_NAME}", i 1) i.R3 ?e'
    Pop $R4
    StrCmp $R3 "0" zcodeSnapshotFailed
    GetTempFileName $ZCodeCleanupManifest "$ZCodeCleanupBackup"
    IfErrors zcodeSnapshotFailed
    FileOpen $R5 "$ZCodeCleanupManifest" w
    IfErrors zcodeSnapshotFailed

    zcodeSnapshotRead:
      StrCmp $ZCodeCleanupBackup "" zcodeSnapshotDone
      ClearErrors
      FileOpen $R0 "$ZCodeCleanupBackup\${ZCODE_INSTALL_MANIFEST_NAME}" r
      IfErrors zcodeSnapshotFailed
    zcodeSnapshotNext:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeSnapshotClose
      StrCpy $R1 $R1 -2
      StrCmp $R1 "" zcodeSnapshotNext
      StrCmp $ZCodeCleanupMode "restore" zcodeSnapshotValidateEntry
      StrCmp $R1 "${ZCODE_INSTALL_MANIFEST_NAME}" zcodeSnapshotSelfEntry
      FileWrite $R5 "$R1$\r$\n"
      IfErrors zcodeSnapshotFailedClose
      Goto zcodeSnapshotValidateEntry
    zcodeSnapshotSelfEntry:
      StrCpy $ZCodeCleanupManifestHasSelf "1"
      Goto zcodeSnapshotNext
    zcodeSnapshotFailedClose:
      StrCpy $ZCodeCleanupFailed "1"
      Goto zcodeSnapshotClose
    zcodeSnapshotValidateEntry:
      ; 只接受清单中规范的相对路径，拒绝越界、通配符和卸载器自身。
      StrCpy $R2 $R1 1
      StrCmp $R2 "\" zcodeSnapshotNext
      StrCmp $R2 "/" zcodeSnapshotNext
      StrCpy $R2 $R1 2
      StrCmp $R2 ".." zcodeSnapshotNext
      StrCmp $R1 "${UNINSTALL_FILENAME}" zcodeSnapshotNext
      ; 清单已在循环前单独备份；自引用时再次排他复制会因目标存在而中止更新。
      StrCmp $R1 "${ZCODE_INSTALL_MANIFEST_NAME}" zcodeSnapshotNext
      ; Windows NSIS 对已删除的目标返回空路径；恢复时校验仍存在的备份，不能跳过待补回文件。
      StrCpy $R3 "$ZCodeCleanupSource"
      StrCmp $ZCodeCleanupMode "restore" 0 +2
        StrCpy $R3 "$ZCodeCleanupBackup"
      GetFullPathName $R2 "$R3\$R1"
      StrCmp $R2 "$R3\$R1" 0 zcodeSnapshotNext
      StrCpy $R2 0
    zcodeSnapshotValidate:
      StrCpy $R3 $R1 1 $R2
      StrCmp $R3 "" zcodeSnapshotCopy
      StrCmp $R3 "*" zcodeSnapshotInvalidPath
      StrCmp $R3 "?" zcodeSnapshotInvalidPath
      StrCmp $R3 ":" zcodeSnapshotInvalidPath
      IntOp $R2 $R2 + 1
      Goto zcodeSnapshotValidate
    zcodeSnapshotInvalidPath:
      StrCpy $ZCodeCleanupFailed "1"
      Goto zcodeSnapshotClose
    zcodeSnapshotCopy:
      StrCmp $ZCodeCleanupMode "restore" zcodeSnapshotRestore
      IfFileExists "$ZCodeCleanupSource\$R1" 0 zcodeSnapshotNext
      ${GetParent} "$ZCodeCleanupBackup\$R1" $R2
      CreateDirectory "$R2"
      System::Call 'kernel32::CopyFileW(w "$ZCodeCleanupSource\$R1", w "$ZCodeCleanupBackup\$R1", i 1) i.R3 ?e'
      Pop $R4
      Goto zcodeSnapshotCopyResult
    zcodeSnapshotRestore:
      IfFileExists "$ZCodeCleanupBackup\$R1" 0 zcodeSnapshotNext
      IfFileExists "$ZCodeCleanupSource\$R1" 0 zcodeSnapshotRestoreMissing
      ; 同名目录不能充当恢复后的文件，否则会误报已恢复主程序。
      System::Call 'kernel32::GetFileAttributesW(w "$ZCodeCleanupSource\$R1") i.R3'
      IntOp $R3 $R3 & 0x10
      StrCmp $R3 0 zcodeSnapshotNext
      StrCpy $ZCodeCleanupFailed "1"
      Goto zcodeSnapshotNext
    zcodeSnapshotRestoreMissing:
      ${GetParent} "$ZCodeCleanupSource\$R1" $R2
      CreateDirectory "$R2"
      System::Call 'kernel32::CopyFileW(w "$ZCodeCleanupBackup\$R1", w "$ZCodeCleanupSource\$R1", i 1) i.R3 ?e'
      Pop $R4
    zcodeSnapshotCopyResult:
      ; System 的 ?e 在 CopyFileW 返回时保存 Win32 错误，避免插件后续调用覆盖 GetLastError。
      StrCmp $R3 "0" 0 zcodeSnapshotNext
      !insertmacro ZCodeReportInstallerStage "cleanup-$ZCodeCleanupMode-file-failed path=$R1 win32-error=$R4"
      StrCpy $ZCodeCleanupFailed "1"
      StrCmp $ZCodeCleanupMode "restore" zcodeSnapshotNext
    zcodeSnapshotClose:
      FileClose $R0
      StrCmp $ZCodeCleanupMode "restore" zcodeSnapshotRestoreManifest
      FileClose $R5
      StrCpy $R5 ""
      StrCmp $ZCodeCleanupFailed "1" zcodeSnapshotDone
      StrCmp $ZCodeCleanupManifestHasSelf "1" 0 zcodeSnapshotDone
      ; 旧卸载器也会删除打开中的清单。完整备份后，仅原子移除自引用项供旧代码读取。
      System::Call 'kernel32::MoveFileExW(w "$ZCodeCleanupManifest", w "$ZCodeCleanupSource\${ZCODE_INSTALL_MANIFEST_NAME}", i 9) i.R3 ?e'
      Pop $R4
      StrCmp $R3 "0" zcodeSnapshotFailed zcodeSnapshotDone
    zcodeSnapshotRestoreManifest:
      ; 旧清单可能仍存在但已去掉自引用；失败回滚须恢复原始字节，而非仅补不存在的文件。
      System::Call 'kernel32::CopyFileW(w "$ZCodeCleanupBackup\${ZCODE_INSTALL_MANIFEST_NAME}", w "$ZCodeCleanupSource\${ZCODE_INSTALL_MANIFEST_NAME}", i 0) i.R3 ?e'
      Pop $R4
      StrCmp $R3 "0" zcodeSnapshotFailed zcodeSnapshotDone
    zcodeSnapshotFailed:
      StrCpy $ZCodeCleanupFailed "1"
    zcodeSnapshotDone:
      StrCmp $R5 "" +2
        FileClose $R5
      !insertmacro ZCodeReportInstallerStage "cleanup-$ZCodeCleanupMode-completed failed=$ZCodeCleanupFailed backup=$ZCodeCleanupBackup"
      Pop $R5
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
  FunctionEnd
  !macroend

  !macro customOldUninstallPrepare
    StrCpy $ZCodeCleanupSource "$installationDir"
    !insertmacro ZCodeStopPreviousInstallProcesses
    StrCpy $ZCodeCleanupMode "backup"
    Call ZCodeCleanupSnapshot
    ${If} $ZCodeCleanupFailed == "1"
      ; 修复原因：备份是可选保护；失败时弃用半份备份，避免旧卸载失败后误用它恢复。
      !insertmacro ZCodeReportInstallerStage "cleanup-backup-skipped path=$ZCodeCleanupBackup"
      StrCmp $ZCodeCleanupBackup "" zcodePreviousBackupCleanupDone
      ClearErrors
      RMDir /r "$ZCodeCleanupBackup"
      IfErrors zcodePreviousBackupCleanupFailed
      Goto zcodePreviousBackupCleanupDone
      zcodePreviousBackupCleanupFailed:
        !insertmacro ZCodeReportInstallerStage "cleanup-backup-delete-failed path=$ZCodeCleanupBackup"
      zcodePreviousBackupCleanupDone:
      StrCpy $ZCodeCleanupBackup ""
    ${EndIf}
  !macroend

  !macro customOldUninstallRetryFailed
    ; 上游把任意卸载非零都显示成应用未关闭；实际进程检查仍由 CHECK_APP_RUNNING 负责。
    ; 备份失败被弃用后没有可恢复的完整备份；提示必须与能否恢复一致，不能在无备份时承诺恢复。
    StrCmp $ZCodeCleanupBackup "" zcodeRetryExhaustedNoBackup
    !insertmacro ZCodeReportInstallerStage "cleanup-retries-exhausted exit-code=$R0 recoverable=1"
    ${If} $LANGUAGE == 2052
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "旧版本清理失败（错误码 $R0）。请排除文件占用或权限问题后重试，或取消以恢复旧版本。日志：$ZCodeInstallerLogPath" /SD IDCANCEL IDRETRY OneMoreAttempt
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Previous version cleanup failed (exit code $R0). Resolve file locks or permissions and retry, or cancel to restore the previous version. Log: $ZCodeInstallerLogPath" /SD IDCANCEL IDRETRY OneMoreAttempt
    ${EndIf}
    Goto zcodeRetryExhaustedDone
    zcodeRetryExhaustedNoBackup:
    !insertmacro ZCodeReportInstallerStage "cleanup-retries-exhausted exit-code=$R0 recoverable=0"
    ${If} $LANGUAGE == 2052
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "旧版本清理失败（错误码 $R0）。本次更新没有完整备份：排除占用后可重试，取消将退出安装且无法自动恢复旧版本文件。日志：$ZCodeInstallerLogPath" /SD IDCANCEL IDRETRY OneMoreAttempt
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Previous version cleanup failed (exit code $R0). No complete backup exists for this update: retry after resolving file locks, or cancel to exit setup without automatic restore. Log: $ZCodeInstallerLogPath" /SD IDCANCEL IDRETRY OneMoreAttempt
    ${EndIf}
    zcodeRetryExhaustedDone:
  !macroend

  Function ZCodeFinishOldUninstall
    ${If} $R0 != 0
      ; 修复原因：没有完整备份时不能用半份文件恢复，旧卸载失败仍由原流程报告。
      StrCmp $ZCodeCleanupBackup "" zcodeFinishOldUninstallDone
      StrCpy $ZCodeCleanupMode "restore"
      Call ZCodeCleanupSnapshot
      ${If} $ZCodeCleanupFailed == "1"
        !insertmacro ZCodeCleanupErrorMessage "旧版本文件恢复失败，备份已保留：$ZCodeCleanupBackup。详细日志：$ZCodeInstallerLogPath" "Cannot restore the previous version. Backup retained: $ZCodeCleanupBackup. Log: $ZCodeInstallerLogPath"
        Return
      ${EndIf}
    ${EndIf}
    StrCmp $ZCodeCleanupBackup "" zcodeFinishOldUninstallDone
    ClearErrors
    RMDir /r "$ZCodeCleanupBackup"
    IfErrors zcodeFinishOldUninstallBackupDeleteFailed
    StrCpy $ZCodeCleanupBackup ""
    Goto zcodeFinishOldUninstallDone
    zcodeFinishOldUninstallBackupDeleteFailed:
      ; 修复原因：备份清理故障不影响旧卸载结果及后续新版本安装，只保留路径供排查。
      !insertmacro ZCodeReportInstallerStage "cleanup-backup-delete-failed path=$ZCodeCleanupBackup"
    zcodeFinishOldUninstallDone:
  FunctionEnd

  !macro customUnInstallCheck
    Call ZCodeFinishOldUninstall
    ; handleUninstallResult 会把旧卸载器的退出码放在 $R0；失败时显示清理诊断，
    ; 不再复用 appCannotBeClosed（该文案只适用于进程占用）。
    ${if} $R0 != 0
      ; 修复原因：静默自动更新无人值守，未设置 /SD 的模态框会一直等待用户点击，
      ; 使明确的退出码无法返回 electron-updater。静默时自动采用 IDOK，交互时仍显示提示。
      SetDetailsPrint listonly
      DetailPrint "ZCode: cleanup-failed exit-code=$R0"
      Call ZCodeShowUninstallerCleanupDetails
      ; 最终错误也沿用安装器语言，避免英文 Retry/Cancel 之后固定切回中文。
      !insertmacro ZCodeCleanupErrorMessage "旧版本清理失败（错误码 $R0）。可能是文件被占用、权限不足或磁盘空间不足。详细日志：${ZCODE_UNINSTALLER_LOG_PATH}" "Previous version cleanup failed (exit code $R0). Files may be in use, permissions may be insufficient, or disk space may be low. Log: ${ZCODE_UNINSTALLER_LOG_PATH}"
      SetErrorLevel 2
      Quit
    ${endif}
  !macroend

  !macro customUnInstallCheckCurrentUser
    ; per-machine 安装切换到 HKCU 旧版本时，electron-builder 会走另一条 hook；
    ; 复用同一诊断，避免同一个清理失败因注册表根键不同又退回默认文案。
    !insertmacro customUnInstallCheck
  !macroend
!endif

!define ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH 180

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeDefineCleanupSnapshot
    ; 修复原因：异步生成的 header 可能先 include 本文件，再注册 UAC 插件目录。
    ; 在 customHeader 展开函数，确保插件已注册；preInit 仍调用同一函数和真实 UAC 判据。
    Function ZCodeInitializeInstallerLog
      Push $R0
      Push $R1
      Push $R2
      StrCpy $ZCodeInstallerLogUnavailable ""
      ${If} ${ZCODE_INSTALLER_IS_ELEVATED_INNER}
        StrCpy $ZCodeInstallerProcessRole "elevated-inner"
        StrCpy $ZCodeInstallerLogPath "${ZCODE_INSTALLER_ELEVATED_LOG_PATH}"
      ${Else}
        StrCpy $ZCodeInstallerProcessRole "outer"
        StrCpy $R0 $CMDLINE
        ClearErrors
        ${GetOptions} $R0 "/LOG=" $R1
        IfErrors zcodeInstallerLogUseDefault
        StrCmp $R1 "" zcodeInstallerLogUseDefault
        StrCpy $ZCodeInstallerLogPath $R1
        Goto zcodeInstallerLogPathReady
        zcodeInstallerLogUseDefault:
          StrCpy $ZCodeInstallerLogPath "${ZCODE_INSTALLER_DEFAULT_LOG_PATH}"
        zcodeInstallerLogPathReady:
          ${GetParent} $ZCodeInstallerLogPath $R2
          StrCmp $R2 "" zcodeInstallerLogInitialized
          CreateDirectory "$R2"
      ${EndIf}
      zcodeInstallerLogInitialized:
        !insertmacro ZCodeReportInstallerStage "installer-process-started role=$ZCodeInstallerProcessRole"
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    ; 修复原因：electron-builder 的 common.nsh 先设置 ShowInstDetails nevershow；
    ; hide 在该模板组合下仍可能留下空白列表且没有可展开入口，因此直接常显阶段详情。
    ShowInstDetails show
    !ifdef allowToChangeInstallationDirectory
      ; 修复原因：electron-builder 已在 assistedInstaller.nsh 中用该开关生成安装目录页面，
      ; 但 installUtil.nsh 随后还会用它禁止无 --updated 的手动覆盖保留快捷方式，导致旧卸载器
      ; 调用 UninstShortcut 注销开始菜单固定项。页面生成后撤掉开关，让自动更新和手动覆盖
      ; 在同一安装目录覆盖时都通过 KeepShortcuts 保留同一个 .lnk。
      !undef allowToChangeInstallationDirectory
    !endif
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; 修复原因：electron-builder 会先编译卸载器，但快捷方式目标读取只在安装更新流程中调用。
  ; 若把函数带入卸载器，NSIS 会产生 6010 未引用告警，并在 /WX 下直接中断 Windows CI。
  Function ZCodeReadShortcutTarget
    Exch $R9
    Push $R1
    Push $R2

    StrCpy $R2 ""
    System::Call 'Kernel32::SetEnvironmentVariableW(w "ZCODE_SHORTCUT_PATH", w "$R9") i.R1'
    StrCmp $R1 "0" zcodeReadShortcutTargetDone 0

    nsExec::ExecToStack /TIMEOUT=5000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Out.Write(([Activator]::CreateInstance([type]::GetTypeFromProgID('WScript.Shell'))).CreateShortcut([Environment]::GetEnvironmentVariable('ZCODE_SHORTCUT_PATH')).TargetPath)"`
    Pop $R1
    Pop $R2
    StrCmp $R1 "0" zcodeReadShortcutTargetDone 0
    StrCpy $R2 ""

    zcodeReadShortcutTargetDone:
      System::Call 'Kernel32::SetEnvironmentVariableW(w "ZCODE_SHORTCUT_PATH", p 0) i.R1'
      StrCpy $R9 "$R2"
      Pop $R2
      Pop $R1
      Exch $R9
  FunctionEnd
!endif

!macro ZCodeRepairShortcutIfNeeded SHORTCUT_PATH LABEL_PREFIX
  ${if} ${FileExists} "${SHORTCUT_PATH}"
    Push "${SHORTCUT_PATH}"
    Call ZCodeReadShortcutTarget
    Pop $R0
    StrCmp $R0 "$appExe" ${LABEL_PREFIX}Done 0

    ; 修复原因：历史版本可能留下指向已移动 exe 的 .lnk，但无条件覆盖正确快捷方式会让
    ; 部分 Windows 11 丢失“所有应用”索引或用户固定关系，因此只修复目标不一致的项。
    ClearErrors
    CreateShortCut "${SHORTCUT_PATH}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    IfErrors ${LABEL_PREFIX}Failed ${LABEL_PREFIX}Succeeded
    ${LABEL_PREFIX}Failed:
      DetailPrint "Unable to repair shortcut: ${SHORTCUT_PATH}"
      ClearErrors
      Goto ${LABEL_PREFIX}Done
    ${LABEL_PREFIX}Succeeded:
      WinShell::SetLnkAUMI "${SHORTCUT_PATH}" "${APP_ID}"
      ; 修复后的 .lnk 必须在最后一次写入后通知 Shell，避免开始菜单继续使用旧索引。
      System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "${SHORTCUT_PATH}", p 0)'
    ${LABEL_PREFIX}Done:
  ${endIf}
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeReportInstallerStage "install-finalization-started"
  !endif
  ${if} ${isUpdated}
  ${orIf} $keepShortcuts == "true"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro ZCodeRepairShortcutIfNeeded "$newStartMenuLink" zcodeStartMenuShortcutRepair
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      !insertmacro ZCodeRepairShortcutIfNeeded "$newDesktopLink" zcodeDesktopShortcutRepair
    !endif
  ${endIf}

  ; 修复原因：手动覆盖没有 --updated，继承旧快捷方式时仍需检查目标；首次安装没有旧项，
  ; 不应额外启动 PowerShell。用户已删除的快捷方式也不会重建。
  ; assisted installer 完成页始终直接运行本次安装落盘的 exe。
  ; 修复原因：安装信息键的 InstallLocation 用于旧卸载器路径解析；卸载注册表键也写入相同值，
  ; 避免 Windows 应用列表中的卸载项长期为空，并为后续迁移提供确定目录。
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" InstallLocation "$INSTDIR"
  !endif
  StrCpy $launchLink "$appExe"
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeReportInstallerStage "install-completed"
  !endif
!macroend

!macro customPageAfterChangeDir
  Function ZCodeResizeInstallDirBackButton
    GetDlgItem $1 $HWNDPARENT 3
    StrCmp $1 0 zcodeResizeInstallDirBackButtonDone 0

    System::Call "*(i 0, i 0, i 0, i 0) p.r2"
    StrCmp $2 0 zcodeResizeInstallDirBackButtonDone 0
    System::Call "user32::GetWindowRect(p r1, p r2)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
    System::Call "*$2(i.r3,i.r4,i.r5,i.r6)"
    System::Free $2

    IntOp $7 $5 - $3
    IntOp $8 $6 - $4
    IntCmp $7 ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH} zcodeResizeInstallDirBackButtonDone zcodeResizeInstallDirBackButtonResize zcodeResizeInstallDirBackButtonDone

    zcodeResizeInstallDirBackButtonResize:
      ; 修复原因：阻断页把“上一步”改成中文动作文案，NSIS 默认按钮宽度可能裁掉文字。
      ; 保持右边缘不动向左扩宽，避免和右侧“安装/取消”按钮重叠。
      IntOp $3 $5 - ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}
      System::Call "user32::MoveWindow(p r1, i r3, i r4, i ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}, i r8, i 1)"

    zcodeResizeInstallDirBackButtonDone:
  FunctionEnd

  Function ZCodeFindNestedDataDir
    Exch $R9
    Push $0
    Push $1

    StrCpy $R2 ""

    IfFileExists "$R9\.zcode\*.*" 0 +2
      StrCpy $R2 "$R9\.zcode"
    StrCmp $R2 "" 0 zcodeFindNestedDataDirDone
    IfFileExists "$R9\.zcode" 0 zcodeFindNestedDataDirListChildren
      StrCpy $R2 "$R9\.zcode"
    StrCmp $R2 "" 0 zcodeFindNestedDataDirDone

    zcodeFindNestedDataDirListChildren:
      FindFirst $0 $1 "$R9\*"
      IfErrors zcodeFindNestedDataDirDone

    zcodeFindNestedDataDirNext:
      StrCmp $1 "" zcodeFindNestedDataDirClose
      StrCmp $1 "." zcodeFindNestedDataDirContinue
      StrCmp $1 ".." zcodeFindNestedDataDirContinue
      IfFileExists "$R9\$1\*.*" 0 zcodeFindNestedDataDirContinue
        Push "$R9\$1"
        Call ZCodeFindNestedDataDir
        StrCmp $R2 "" zcodeFindNestedDataDirContinue zcodeFindNestedDataDirClose

    zcodeFindNestedDataDirContinue:
      FindNext $0 $1
      IfErrors zcodeFindNestedDataDirClose
      Goto zcodeFindNestedDataDirNext

    zcodeFindNestedDataDirClose:
      FindClose $0

    zcodeFindNestedDataDirDone:
      Pop $1
      Pop $0
      Pop $R9
  FunctionEnd

  Function ZCodeBlockInstallDirContainsData
    Call ZCodeDetectPreviousUninstallerCapabilities
    StrCmp $ZCodePreviousUninstallerSupportsManifest "1" zcodeInstallDirDataBlockSkip

    ; Bugfix: 用户可能把数据存储目录放进安装目录，Windows 更新覆盖安装目录时会清掉 .zcode。
    ; assisted installer 会把不含应用名的选择目录补成 "$INSTDIR\${APP_FILENAME}"，所以这里按相同规则计算最终安装目录。
    ${StrContains} $R1 "${APP_FILENAME}" "$INSTDIR"
    StrCmp $R1 "" 0 zcodeInstallDirDataBlockUseSelectedDir
    StrCpy $R0 "$INSTDIR\${APP_FILENAME}"
    Goto zcodeInstallDirDataBlockCheckDir

    zcodeInstallDirDataBlockUseSelectedDir:
      StrCpy $R0 "$INSTDIR"

    zcodeInstallDirDataBlockCheckDir:
      ; 修复原因：旧阻断只检查最终安装目录直属的 .zcode，漏掉 data\.zcode 等子目录数据。
      ; 安装器覆盖安装时会管理整个安装目录树，递归命中任意 .zcode 都必须阻断。
      Push "$R0"
      Call ZCodeFindNestedDataDir
      StrCmp $R2 "" zcodeInstallDirDataBlockSkip zcodeInstallDirDataBlockFound

    zcodeInstallDirDataBlockFound:
      IfSilent zcodeInstallDirDataBlockSilent

      !insertmacro MUI_HEADER_TEXT "需要修改安装目录" "当前安装目录或其子目录包含 ZCode 数据目录"
      nsDialogs::Create 1018
      Pop $0
      StrCmp $0 error zcodeInstallDirDataBlockDialogFailed 0

      ${NSD_CreateLabel} 0u 0u 300u 44u "检测到该安装目录或其子目录中存在 .zcode 数据目录：$\r$\n$R2"
      Pop $1
      ${NSD_CreateLabel} 0u 54u 300u 70u "为避免历史会话和配置被安装器清理，请返回上一步选择其他安装目录。$\r$\n$\r$\n当前目录不能继续安装。"
      Pop $1

      GetDlgItem $1 $HWNDPARENT 1
      EnableWindow $1 0
      GetDlgItem $1 $HWNDPARENT 3
      EnableWindow $1 1
      SendMessage $1 ${WM_SETTEXT} 0 "STR:重选目录"
      Call ZCodeResizeInstallDirBackButton

      nsDialogs::Show
      Return

    zcodeInstallDirDataBlockDialogFailed:
      MessageBox MB_OK|MB_ICONSTOP "检测到安装目录或其子目录中存在 .zcode 数据目录，安装已停止。请重新运行安装器并选择其他安装目录。"
      SetErrorLevel 1
      Quit

    zcodeInstallDirDataBlockSilent:
      SetErrorLevel 1
      Quit

    zcodeInstallDirDataBlockSkip:
      Abort
  FunctionEnd

  Function ZCodeBlockInstallDirContainsDataLeave
    ; 修复原因：阻断页的下一步按钮已禁用，但自动化或系统快捷键仍可能触发下一页。
    ; leave 回调只处理继续前进的路径，这里强制留在当前页，确保用户只能返回修改安装目录。
    Abort
  FunctionEnd

  Page custom ZCodeBlockInstallDirContainsData ZCodeBlockInstallDirContainsDataLeave
!macroend
