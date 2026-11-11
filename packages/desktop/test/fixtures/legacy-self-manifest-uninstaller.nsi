Unicode true
Name "Legacy manifest reader"
OutFile "${OUTPUT_FILE}"
InstallDir "$TEMP\legacy-manifest-reader"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
; 保留旧包的行为：文件仍打开时删除清单自身会失败，用于验证新外层安装器的兼容。
Section
  FileOpen $0 "$INSTDIR\.zcode-install-manifest" r
  loop:
    ClearErrors
    FileRead $0 $1
    IfErrors done
    StrCpy $1 $1 -2
    StrCmp $1 "" loop
    StrCpy $2 $1 2
    StrCmp $2 ".." loop
    ClearErrors
    Delete "$INSTDIR\$1"
    IfErrors failed
    Goto loop
  failed:
    FileClose $0
    SetErrorLevel 2
    Quit
  done:
    FileClose $0
SectionEnd
