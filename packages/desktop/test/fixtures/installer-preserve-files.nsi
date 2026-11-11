Unicode true
Name "ZCode preserve-files smoke"
OutFile "${OUTPUT_FILE}"
InstallDir "$TEMP\zcode-preserve-files-smoke"
RequestExecutionLevel user
SilentInstall silent

!addincludedir "${NSIS_INCLUDE_DIR}"
!addincludedir "${ELECTRON_BUILDER_NSIS_INCLUDE_DIR}"
!addplugindir /x86-unicode "${NSIS_PLUGIN_DIR}"
!include "LogicLib.nsh"

!define APP_FILENAME "ZCode"
!define APP_ID "dev.zcode.preserve-files-smoke"
!define isUpdated `1 == 1`
; This fixture has no electron-builder uninstaller.nsh section; use a normal function for log smoke coverage.
!ifdef BUILD_UNINSTALLER
  !define ZCODE_UNINSTALLER_FUNCTION_PREFIX ""
!endif

Var appExe
; 仅恢复场景使用旧安装目录；普通清理夹具在 /WX 下不能留下未引用变量。
!ifdef RECOVERY_TEST
  Var installationDir
!endif

!include "${ZCODE_INSTALLER_NSH}"
; 正式构建先加载自定义 include，再由 common.nsh 声明卸载器名称。
!define UNINSTALL_FILENAME "uninstaller.exe"
!ifndef BUILD_UNINSTALLER
  !insertmacro ZCodeDefineCleanupSnapshot
!endif

Section
  SetOutPath "$INSTDIR"
  File /oname=ZCode.exe "${FIXTURE_EXE}"
  StrCpy $appExe "$INSTDIR\ZCode.exe"
  !ifndef OMIT_MANIFEST
    FileOpen $0 "$INSTDIR\.zcode-install-manifest" w
    FileWrite $0 "ZCode.exe$\r$\n"
    FileWrite $0 "owned-by-zcode.txt$\r$\n"
    !ifdef SELF_MANIFEST
      FileWrite $0 ".zcode-install-manifest$\r$\n"
    !endif
    FileWrite $0 "..\user-data.txt$\r$\n"
    FileClose $0
  !endif
  !ifdef FAIL_DELETE
    ; Keep the file handle open so Windows denies the manifest cleanup delete.
    FileOpen $0 "$INSTDIR\owned-by-zcode.txt" w
    FileWrite $0 "old app payload"
  !else
    FileOpen $0 "$INSTDIR\owned-by-zcode.txt" w
    FileWrite $0 "old app payload"
    FileClose $0
  !endif
  FileOpen $0 "$INSTDIR\user-data.txt" w
  FileWrite $0 "keep me"
  FileClose $0
  !ifdef RECOVERY_TEST
    InitPluginsDir
    File /oname=$PLUGINSDIR\old-cleanup.exe "${OLD_CLEANUP_EXE}"
    StrCpy $installationDir "$INSTDIR"
    !ifdef BACKUP_FAILURE
      ; 独占源文件，让 CopyFileW 确定失败；原安装文件不能被旧卸载器删除。
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\ZCode.exe", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.R8'
    !endif
    !insertmacro customOldUninstallPrepare
    FileOpen $8 "$INSTDIR\backup-dir.txt" w
    FileWrite $8 "$ZCodeCleanupBackup"
    FileClose $8
    OneMoreAttempt:
    ExecWait '"$PLUGINSDIR\old-cleanup.exe" /S /D=$INSTDIR' $R0
    !ifdef RESTORE_FAILURE
      ; 同名目录阻止恢复主程序，必须保留备份，不能误报恢复成功。
      CreateDirectory "$INSTDIR\ZCode.exe"
    !endif
    ${If} $R0 != 0
      !insertmacro customOldUninstallRetryFailed
    ${EndIf}
    !insertmacro customUnInstallCheck
  !else
    !insertmacro customRemoveFiles
  !endif
  ; 成功清理后模拟新版本文件落盘；失败路径必须在此前返回。
  SetOutPath "$INSTDIR"
  File /oname=ZCode.exe "${FIXTURE_EXE}"
  IfFileExists "$INSTDIR\owned-by-zcode.txt" 0 zcodeOwnedRemoved
    StrCpy $1 "present"
    Goto zcodeWriteMarker
  zcodeOwnedRemoved:
    StrCpy $1 "removed"
  zcodeWriteMarker:
    FileOpen $0 "$INSTDIR\remove-result.txt" w
    FileWrite $0 "$1"
    FileClose $0
SectionEnd
