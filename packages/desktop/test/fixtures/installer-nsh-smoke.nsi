Unicode true
Name "ZCode installer.nsh smoke"
OutFile "${OUTPUT_FILE}"
InstallDir "$TEMP\zcode-installer-nsh-smoke"
RequestExecutionLevel user
SilentInstall silent

!addincludedir "${NSIS_INCLUDE_DIR}"
!addincludedir "${ELECTRON_BUILDER_NSIS_INCLUDE_DIR}"

!include "LogicLib.nsh"
!ifndef BUILD_UNINSTALLER
  !include "MUI2.nsh"
  !include "StrContains.nsh"
!endif

!define APP_DESCRIPTION "ZCode NSIS smoke fixture"
!define APP_FILENAME "ZCode"
!define APP_ID "dev.zcode.installer-nsh-smoke"
; This fixture invokes the cleanup macro from a normal section; electron-builder's real uninstaller uses un.*.
!ifdef BUILD_UNINSTALLER
  !define ZCODE_UNINSTALLER_FUNCTION_PREFIX ""
!endif
; Simulate a manually launched overwrite installer without --updated.
!define isUpdated `1 == 0`
!define allowToChangeInstallationDirectory
!define ZCODE_INSTALLER_DEFAULT_LOG_PATH "${DEFAULT_LOG_PATH}"
!define ZCODE_INSTALLER_ELEVATED_LOG_PATH "${ELEVATED_LOG_PATH}"
!ifdef FORCE_ELEVATED_INNER
  !define ZCODE_INSTALLER_IS_ELEVATED_INNER `1 == 1`
!endif

Var appExe
Var launchLink
Var newStartMenuLink
Var newDesktopLink
Var keepShortcuts

!include "${ZCODE_INSTALLER_NSH}"
; 与正式构建保持顺序：common.nsh 的常量在自定义 include 之后才可用。
!define UNINSTALL_FILENAME "uninstaller.exe"
; 回归原因：electron-builder 异步生成 header 时，自定义 include 可能先于插件目录注册。
; 普通场景使用真实 UAC 判据，避免恒假替身掩盖插件尚未可用的编译错误。
!addplugindir /x86-unicode "${NSIS_PLUGIN_DIR}"
!ifndef BUILD_UNINSTALLER
  ; electron-builder inserts customHeader after assistedInstaller.nsh generated the directory page.
  !insertmacro customHeader
  !ifdef allowToChangeInstallationDirectory
    !error "customHeader must enable shortcut preservation for manual overwrite"
  !endif
  !insertmacro customPageAfterChangeDir

  Function .onInit
    !insertmacro preInit
  FunctionEnd
!endif

Section
  SetOutPath "$INSTDIR"
  File /oname=ZCode.exe "${FIXTURE_EXE}"
  StrCpy $appExe "$INSTDIR\ZCode.exe"
  StrCpy $launchLink "$INSTDIR\stale-target.exe"
  StrCpy $newStartMenuLink "$INSTDIR\start-menu.lnk"
  StrCpy $newDesktopLink "$INSTDIR\desktop.lnk"
  StrCpy $keepShortcuts "true"

  !ifdef PRECREATE_SHORTCUTS
    !ifdef STALE_SHORTCUTS
      CreateShortCut "$newStartMenuLink" "$INSTDIR\stale-target.exe" "--stale"
      CreateShortCut "$newDesktopLink" "$INSTDIR\stale-target.exe" "--stale"
    !else
      CreateShortCut "$newStartMenuLink" "$appExe" "--preserved"
      CreateShortCut "$newDesktopLink" "$appExe" "--preserved"
    !endif

    !ifndef BUILD_UNINSTALLER
      Push "$newStartMenuLink"
      Call ZCodeReadShortcutTarget
      Pop $R8
      FileOpen $0 "$INSTDIR\read-shortcut-target.txt" w
      FileWrite $0 "$R8"
      FileClose $0
    !endif
  !endif

  !ifndef BUILD_UNINSTALLER
    SetDetailsPrint none
    !insertmacro customInit
    ; The real electron-builder template invokes these hooks at the same points.
    !insertmacro customInstallSectionStarted
    !insertmacro customInstallCleanupStarted
    !insertmacro customInstallCleanupCompleted
    !insertmacro customInstallExtractStarted
    !insertmacro customInstallExtractCompleted
    !insertmacro customInstallShortcutsStarted
    !insertmacro customInstallShortcutsCompleted
    !insertmacro customInstall
  !endif

  FileOpen $0 "$INSTDIR\launch-link.txt" w
  FileWrite $0 "$launchLink"
  FileClose $0

  ; Expand cleanup diagnostics in the uninstaller smoke fixture so /WX checks the reference.
  !ifdef BUILD_UNINSTALLER
    !insertmacro customRemoveFiles
  !endif

SectionEnd
