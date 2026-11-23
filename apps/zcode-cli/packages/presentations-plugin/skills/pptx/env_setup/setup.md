# Presentation dependency setup

## Python interpreter selection

Run Python scripts and package installation with `"$(command -v zcode-python || command -v python3)"`. This selects the preinstalled entry when available and otherwise the existing system Python.

If neither the preinstalled entry nor a system Python is available and `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` is set, stop before running a Python script or any setup installer. Explain: “预装版本未就绪或已关闭，请在 帮助 → 预装工具 中查看” (the preinstalled version is not ready or is disabled; check **Help → Preinstalled tools**). Let the user choose waiting, enabling Python, or installing system Python. Without that variable, keep the existing installation guidance.

After the user chooses system installation, run the Python installation command from [Manual Install by Platform](#manual-install-by-platform) directly; do not rerun the setup preflight while Python is still missing. Make the installed interpreter visible to the current shell, then repeat interpreter selection and continue setup. No environment override is needed.

If the selected preinstalled Python cannot run or its package installation fails, stop this step and explain the cause. Ask the user to choose either their own Python for this step (including any package installation into that Python) or turning off Python in **Help → Preinstalled tools**. Do not switch interpreters automatically after a failure. Errors in the document or script itself follow the existing troubleshooting route.

LibreOffice operations use the [unified launcher](../../../scripts/README.md). The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance. If both programs are unavailable on desktop, report the state and reason, then let the user choose waiting or Agent installation. Retain existing files.

When installation is chosen, use [the LibreOffice installation guide](libreoffice-unmanaged.md), then keep using the unified launcher for all later steps. Other presentation dependencies are listed in [the Skill](../SKILL.md).

## Manual Install by Platform

Only after the user chooses system Python installation:

- macOS: `brew install python3`.
- Debian/Ubuntu: `sudo apt install python3 python3-pip`; Fedora/RHEL: `sudo dnf install python3 python3-pip`.
- Windows: `winget install Python.Python.3.11`, or use the installer from [python.org](https://www.python.org/downloads/). Ensure its directory is on the current shell's PATH. In PowerShell, select `zcode-python` first with `Get-Command`, then the available system `python3`, `python`, or `py` command.

Continue with the existing dependency commands in [the Skill](../SKILL.md) using the selected interpreter.
