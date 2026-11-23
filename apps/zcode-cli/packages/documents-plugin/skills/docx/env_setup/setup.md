# DOCX Skill — Environment Setup Guide

## Python interpreter selection

Run Python scripts and package installation with `"$(command -v zcode-python || command -v python3)"`. This selects the preinstalled entry when available and otherwise the existing system Python.

If neither the preinstalled entry nor a system Python is available and `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` is set, stop before running a Python script or any setup installer. Explain: “预装版本未就绪或已关闭，请在 帮助 → 预装工具 中查看” (the preinstalled version is not ready or is disabled; check **Help → Preinstalled tools**). Let the user choose waiting, enabling Python, or installing system Python. Without that variable, keep the existing installation guidance.

After the user chooses system installation, run the Python installation command from [Manual Install by Platform](#manual-install-by-platform) directly; do not rerun the setup preflight while Python is still missing. Make the installed interpreter visible to the current shell, then repeat interpreter selection and continue setup. No environment override is needed.

If the selected preinstalled Python cannot run or its package installation fails, stop this step and explain the cause. Ask the user to choose either their own Python for this step (including any package installation into that Python) or turning off Python in **Help → Preinstalled tools**. Do not switch interpreters automatically after a failure. Errors in the document or script itself follow the existing troubleshooting route.

## LibreOffice availability

Use this section when the unified launcher finds no usable installation. On desktop, first ask the user to wait for managed preparation or let the Agent install.

First run `"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check`. The launcher discovers the preinstalled entry on PATH; desktop availability only selects the installation guidance. If no program is usable on desktop, report the preparation state and reason, then ask the user to wait or let the Agent install. After installation, continue through the unified launcher, not soffice directly. Python, Node and other dependencies keep their existing setup rules.


This document contains full platform-specific instructions for setting up the DOCX skill environment.
The model should read this file when first-time setup is needed.

---

## Step 1: Platform Detection

Detect the OS and set core variables:

### macOS / Linux (bash/zsh)

```bash
OS="$(uname -s)"   # Darwin = macOS, Linux = Linux
ARCH="$(uname -m)" # x86_64 or arm64

DOCX_SKILL_DIR="<skill_directory>"
export DOCX_SKILL_DIR
```

### Windows (PowerShell, Win10/Win11)

```powershell
$WinVer = [System.Environment]::OSVersion.Version
$Arch   = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$env:DOCX_SKILL_DIR = "<skill_directory>"
```

---

## Step 2: Dependency Check & Install

Run the platform-appropriate setup script:

| Platform | Command |
|----------|---------|
| macOS / Linux | `bash "$DOCX_SKILL_DIR/env_setup/setup_mac_linux.sh"` |
| Windows | `powershell -ExecutionPolicy Bypass -File "$env:DOCX_SKILL_DIR\env_setup\setup_windows.ps1"` |

### Required Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| Runtime | Node.js + npm | DOCX generation (docx-js) |
| npm pkg | docx | Word document creation library |
| Runtime | Python 3 + pip | Post-processing scripts |
| Python pkg | defusedxml | Safe XML parsing for validation |
| On demand (not substitutable) | LibreOffice | `.doc`→`.docx`, DOCX→PDF, visual verification — install it; do not swap in local Word/WPS/Pages |
| Font | CJK fonts (from CDN) | Chinese text in documents |

### Manual Install by Platform

#### macOS

```bash
brew install node python3
npm install -g docx
"$(command -v zcode-python || command -v python3)" -m pip install defusedxml
# On demand, not substitutable: LibreOffice (prefer the Tsinghua mirror below)
brew install --cask libreoffice
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt install nodejs npm python3 python3-pip
npm install -g docx
"$(command -v zcode-python || command -v python3)" -m pip install defusedxml
# On demand, not substitutable: LibreOffice (prefer the Tsinghua mirror below)
sudo apt install libreoffice-core
```

#### Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.11
npm install -g docx
$PY = Get-Command zcode-python -ErrorAction SilentlyContinue
if (-not $PY) { $PY = Get-Command python3, python, py -ErrorAction SilentlyContinue | Select-Object -First 1 }
& $PY.Source -m pip install defusedxml
# On demand, not substitutable: LibreOffice (prefer the Tsinghua mirror below)
winget install TheDocumentFoundation.LibreOffice
```

Alternative Windows package managers:
- `choco install nodejs-lts python3`
- `scoop install nodejs-lts python`

---

## Step 3: Font Installation

Fonts are downloaded individually from CDN on first setup.

- **CDN base**: `https://z-cdn.chatglm.cn/office-skill/fonts/`
- **Font list**: `env_setup/font_list.txt` (78 fonts, one relative path per line)
- **Marker file**: `.office-skill-fonts-installed` in the user font directory prevents re-download
- Special characters in filenames (e.g., `[`, `]`) are URL-encoded automatically by the setup script

The setup scripts read `font_list.txt`, check which fonts are already installed, and download only the missing ones. Each font is saved flat (filename only) to the user font directory.

### CDN Directory Structure (78 fonts)

| Directory | Count | Description |
|-----------|-------|-------------|
| `truetype/lxgw-wenkai/` | 6 | LXGW WenKai — Chinese handwriting style |
| `truetype/noto-serif-sc/` | 9 | Noto Serif SC — Chinese serif (variable + 8 static weights) |
| `chinese/` | 14 | Noto Sans SC, Sarasa Mono SC, Liberation fallbacks |
| `dejavu/` | 8 | DejaVu Sans/Serif/Mono — Latin/symbol fallback |
| `emoji/` | 1 | Noto Color Emoji |
| `english/` | 12 | Tinos, Carlito, Calibri |
| `freefont/` | 12 | FreeSans/FreeSerif/FreeMono — open-source fallback |
| `liberation/` | 12 | Liberation Sans/Serif/Mono — MS-metric-compatible |
| `libreoffice/` | 1 | OpenSymbol |
| `noto/` | 1 | Noto Color Emoji (duplicate) |
| `wqy/` | 1 | WenQuanYi Zen Hei — CJK fallback |
| *(root)* | 1 | Japanese Gothic |

### Install Targets by Platform

| Platform | User Font Directory |
|----------|-------------------|
| macOS | `~/Library/Fonts/` |
| Linux | `~/.local/share/fonts/` (then run `fc-cache -f`) |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (per-user, no admin) |

### Manual Font Installation

If CDN is unreachable, download fonts manually. Example:

```bash
# Download a single font
curl -fSLO "https://z-cdn.chatglm.cn/office-skill/fonts/chinese/NotoSansSC%5Bwght%5D.ttf"
# Copy to user font dir
cp "NotoSansSC[wght].ttf" ~/Library/Fonts/   # macOS
```

Or download all fonts listed in `font_list.txt`:

```bash
while read f; do
    encoded=$(echo "$f" | sed 's/\[/%5B/g; s/\]/%5D/g')
    curl -fSLO "https://z-cdn.chatglm.cn/office-skill/fonts/$encoded"
done < env_setup/font_list.txt
```

### Post-Install Variable

After font installation, `FONT_DIR` points to the user font directory:

| Platform | FONT_DIR |
|----------|----------------|
| macOS | `~/Library/Fonts` |
| Linux | `~/.local/share/fonts` |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` |

---

## China Network Fallback

If default sources are unreachable, use China mirrors:

### npm (npmmirror)

```bash
npm install -g docx --registry https://registry.npmmirror.com
```

### pip (Tsinghua mirror)

```bash
"$(command -v zcode-python || command -v python3)" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  defusedxml
```

### Windows (PowerShell) China mirrors

```powershell
npm install -g docx --registry https://registry.npmmirror.com
$PY = Get-Command zcode-python -ErrorAction SilentlyContinue
if (-not $PY) { $PY = Get-Command python3, python, py -ErrorAction SilentlyContinue | Select-Object -First 1 }
& $PY.Source -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn defusedxml
```

### Installer downloads (China)

| Software | China Mirror |
|----------|-------------|
| Node.js | https://npmmirror.com/mirrors/node/ |
| Python | https://npmmirror.com/mirrors/python/ |
| LibreOffice | https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/ |

---

## LibreOffice — Recommended Download Source (Tsinghua TUNA mirror)

Use this section when the unified launcher finds no usable installation. On desktop, first ask the user to wait for managed preparation or let the Agent install.

**Prefer this mirror over the official libreoffice.org download and over `brew`/`apt`/`winget`
package sources** — it is much faster on Chinese networks and ships the current full build.

- **Recommended base URL:** `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/`
- **If 26.8.0 is gone** (the mirror only keeps a few releases), list
  `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/` and pick the newest
  version directory, then substitute that version number everywhere below.

### Pick the right package for the platform

Under the version directory, choose the subdirectory matching the OS and CPU architecture:

| Platform | Path under the version dir | Main package |
|----------|---------------------------|--------------|
| Linux x86_64 (Debian/Ubuntu) | `deb/x86_64/` | `LibreOffice_26.8.0_Linux_x86-64_deb.tar.gz` |
| Linux ARM64 (Debian/Ubuntu) | `deb/aarch64/` | `LibreOffice_26.8.0_Linux_aarch64_deb.tar.gz` |
| Linux x86_64 (RHEL/Fedora/openSUSE) | `rpm/x86_64/` | `LibreOffice_26.8.0_Linux_x86-64_rpm.tar.gz` |
| macOS Apple Silicon (M1+) | `mac/aarch64/` | `LibreOffice_26.8.0_MacOS_aarch64.dmg` |
| macOS Intel | `mac/x86_64/` | `LibreOffice_26.8.0_MacOS_x86-64.dmg` |
| Windows 64-bit | `win/x86_64/` | `LibreOffice_26.8.0_Win_x86-64.msi` |
| Windows ARM64 | `win/aarch64/` | `LibreOffice_26.8.0_Win_aarch64.msi` |

Determine the architecture with `uname -m` (macOS/Linux: `x86_64` vs `arm64`/`aarch64`) or
`$env:PROCESSOR_ARCHITECTURE` (Windows: `AMD64` vs `ARM64`). The base package is English-only; add
the Chinese UI with the matching `*_langpack_zh-CN.*` file from the same directory if the user wants
a Chinese interface. Help packs (`*_helppack_*`) are optional and not needed for conversion tasks.

### Linux (Debian/Ubuntu) — install from the mirror

```bash
LO_VER=26.8.0
case "$(uname -m)" in x86_64) LO_ARCH=x86_64; LO_TAG=x86-64 ;; aarch64|arm64) LO_ARCH=aarch64; LO_TAG=aarch64 ;; esac
BASE="https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/$LO_VER/deb/$LO_ARCH"

cd /tmp
curl -fSLO "$BASE/LibreOffice_${LO_VER}_Linux_${LO_TAG}_deb.tar.gz"
tar -xzf "LibreOffice_${LO_VER}_Linux_${LO_TAG}_deb.tar.gz"
sudo dpkg -i LibreOffice_${LO_VER}*/DEBS/*.deb
sudo apt-get install -f -y     # resolve any missing dependencies
"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check              # verify (binary lands in /usr/bin or /opt/libreoffice*/program)
```

If `soffice` is not on `PATH` after install, register it — see
*"Register the binary on PATH"* at the end of this section.

`sudo apt install libreoffice-core` from the distro repo remains an acceptable fallback if the
mirror is unreachable — it is older, but sufficient for conversion.

### macOS — install from the mirror

```bash
LO_VER=26.8.0
case "$(uname -m)" in arm64) LO_ARCH=aarch64; LO_TAG=aarch64 ;; x86_64) LO_ARCH=x86_64; LO_TAG=x86-64 ;; esac
BASE="https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/$LO_VER/mac/$LO_ARCH"

cd /tmp
curl -fSLO "$BASE/LibreOffice_${LO_VER}_MacOS_${LO_TAG}.dmg"
hdiutil attach "LibreOffice_${LO_VER}_MacOS_${LO_TAG}.dmg"
cp -R "/Volumes/LibreOffice/LibreOffice.app" /Applications/
hdiutil detach "/Volumes/LibreOffice"
"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check   # verify
```

`brew install --cask libreoffice` is the fallback if the mirror is unreachable.

### Windows (PowerShell) — install from the mirror

```powershell
$LoVer = "26.8.0"
$LoArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$LoTag  = if ($LoArch -eq "aarch64") { "aarch64" } else { "x86-64" }
$Base = "https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/$LoVer/win/$LoArch"
$Msi  = "$env:TEMP\LibreOffice_${LoVer}_Win_${LoTag}.msi"

Invoke-WebRequest -Uri "$Base/LibreOffice_${LoVer}_Win_${LoTag}.msi" -OutFile $Msi
Start-Process msiexec.exe -ArgumentList "/i `"$Msi`" /qn" -Wait   # silent install (needs admin)
$PY = Get-Command zcode-python -ErrorAction SilentlyContinue
if (-not $PY) { $PY = Get-Command python3, python, py -ErrorAction SilentlyContinue | Select-Object -First 1 }
& $PY.Source "$env:DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check    # verify
```

`winget install TheDocumentFoundation.LibreOffice` is the fallback if the mirror is unreachable.

### Register the binary on PATH (do this immediately after install)

**Do this as part of the install, not as an afterthought.** A LibreOffice that is installed but whose
`soffice` binary is not on the executable search path is indistinguishable from "not installed" to
the next `command -v soffice` probe — which re-triggers the HARD REQUIREMENT and makes you download
several hundred MB you already have. **The mechanism differs per OS; use the one for the platform you
are on.**

Before installing anything, probe first — if the binary already exists somewhere on disk, you need
only the registration step below, **not** a reinstall:

```bash
command -v soffice || ls -d /opt/libreoffice*/program/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice 2>/dev/null
```

```powershell
Get-Command soffice -ErrorAction SilentlyContinue; Test-Path "C:\Program Files\LibreOffice\program\soffice.exe"
```

#### Linux — symlink into a directory already on `PATH`

```bash
sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice
"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check   # re-verify: must print a version, not "command not found"
```

If the distro package was used instead of the mirror, `soffice` normally lands in `/usr/bin` already
and no link is needed.

#### macOS — symlink the binary inside the .app bundle

```bash
sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice
"$(command -v zcode-python || command -v python3)" "$DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check   # re-verify
```

On Apple Silicon, `/usr/local/bin` is not always on `PATH` — if the verify still fails, link into
`/opt/homebrew/bin` instead: `sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /opt/homebrew/bin/soffice`.

#### Windows — append the program directory to the user `PATH`

```powershell
$LoDir = "C:\Program Files\LibreOffice\program"
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$LoDir*") { setx PATH "$UserPath;$LoDir" }
```

`setx` only affects **newly launched** shells. The unified launcher also checks the default install
directory, so verify in the current session with:

```powershell
$PY = Get-Command zcode-python -ErrorAction SilentlyContinue
if (-not $PY) { $PY = Get-Command python3, python, py -ErrorAction SilentlyContinue | Select-Object -First 1 }
& $PY.Source "$env:DOCX_SKILL_DIR/../../scripts/zcode_libreoffice.py" check
```
