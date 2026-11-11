: << 'CMDBLOCK'
@echo off
REM Cross-platform wrapper for this plugin's hook scripts (same approach as the superpowers plugin).
REM On Windows cmd.exe runs this batch part, which finds Git Bash and runs the named script with it.
REM On macOS and Linux the shell reads ":" as a no-op, skips the heredoc, and runs the script with sh.
REM The scripts are POSIX sh, so the hooks need no Node installation.
REM
REM Usage: run-hook.cmd <script-name> [args...]

if "%~1"=="" exit /b 0
set "HOOK_DIR=%~dp0"

if exist "%ProgramFiles%\Git\bin\bash.exe" (
    "%ProgramFiles%\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b 0
)
if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" (
    "%ProgramFiles(x86)%\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b 0
)
if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" (
    "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b 0
)
where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    bash "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b 0
)

REM No bash: exit quietly, so the session and tool calls are never blocked.
exit /b 0
CMDBLOCK

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
script_name=$1
[ -n "$script_name" ] || exit 0
shift
exec sh "$script_dir/$script_name" "$@"
