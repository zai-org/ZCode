#!/usr/bin/env bash
# ---
# name: xlsx-env-setup (macOS / Linux)
# description: Environment detection, dependency check & install for XLSX skill on macOS and Linux.
# ---
set -euo pipefail
# 优先选择预装入口；存在但运行失败时仍保留它，由用户决定是否切换。
PY="$(command -v zcode-python || command -v python3)" || PY=""
# 没有解释器时无法运行 Python 引导脚本；先给桌面选择，避免进入自动装包或下载。
if [ -z "$PY" ] && [ -n "${ZCODE_PREINSTALLED_TOOLS_AVAILABLE:-}" ]; then
    echo "预装版本未就绪或已关闭，请在 帮助 → 预装工具 中查看"
    echo "Choose to wait, enable Python, or install system Python using the manual steps in env_setup/setup.md."
    exit 1
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

# ── Resolve XLSX_SKILL_DIR ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
XLSX_SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export XLSX_SKILL_DIR

echo "============================================"
echo "  XLSX Skill — Environment Setup"
echo "  (macOS / Linux)"
echo "============================================"
echo ""

# ── Step 1: Platform Detection ──
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $OS $ARCH"

if [ "$OS" = "Darwin" ]; then
    PLATFORM="mac"
elif [ "$OS" = "Linux" ]; then
    PLATFORM="linux"
else
    echo "Unsupported platform: $OS. For Windows use env_setup/setup_windows.ps1"
    exit 1
fi

echo "Detected: $PLATFORM"
echo "XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
echo ""

# ── China mirror detection & config ──
USE_CN_MIRROR=false
PIP_MIRROR_ARGS=""

if [ "${USE_CN_MIRROR_FORCE:-}" = "true" ]; then
    USE_CN_MIRROR=true
elif curl -s --connect-timeout 3 https://pypi.org > /dev/null 2>&1; then
    USE_CN_MIRROR=false
else
    warn "pypi.org unreachable — enabling China mirrors"
    USE_CN_MIRROR=true
fi

if [ "$USE_CN_MIRROR" = true ]; then
    PIP_MIRROR_ARGS="-i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn"
    info "China mirrors enabled (pip: tuna)"
    echo ""
fi

ERRORS=0

# ── Step 2a: Homebrew (macOS only) ──
if [ "$PLATFORM" = "mac" ]; then
    echo "--- [1/6] Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        ok "brew installed"
    else
        fail "brew not found"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
fi

# ── Step 2b: Python 3 ──
echo "--- [2/6] Python 3 ---"
if command -v "$PY" &>/dev/null; then
    PY_VER=$("$PY" --version 2>&1)
    ok "python3 ($PY_VER)"
    if [ "$PLATFORM" = "mac" ]; then
        PY_PATH="$PY"
        if [[ "$PY_PATH" == "/usr/bin/python3" ]]; then
            warn "Using macOS system Python (limited). Recommend: brew install python3"
        fi
    fi
else
    fail "python3 not found"
    case "$PLATFORM" in
        mac)   info "Install: brew install python3" ;;
        linux) info "Install: sudo apt install python3 python3-pip" ;;
    esac
    ERRORS=$((ERRORS + 1))
fi

if "$PY" -m pip --version &>/dev/null 2>&1; then
    ok "pip installed"
else
    fail "pip not found"
    case "$PLATFORM" in
        mac)   info "Install: \"$PY\" -m ensurepip --upgrade" ;;
        linux) info "Install: sudo apt install python3-pip" ;;
    esac
    ERRORS=$((ERRORS + 1))
fi
echo ""

# ── Step 2c: Python packages ──
echo "--- [3/6] Python Packages (openpyxl, XlsxWriter) ---"
PY_PKGS=(
    "openpyxl:openpyxl"
    "xlsxwriter:XlsxWriter"
)

MISSING_PY=()
for entry in "${PY_PKGS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if "$PY" -c "import $mod" 2>/dev/null; then
        ver=$("$PY" -c "import $mod; print(getattr($mod, '__version__', 'ok'))" 2>/dev/null)
        ok "$pkg ($ver)"
    else
        fail "$pkg not installed"
        MISSING_PY+=("$pkg")
    fi
done

if [ ${#MISSING_PY[@]} -gt 0 ]; then
    info "Installing missing Python packages: ${MISSING_PY[*]}"
    # shellcheck disable=SC2086
    "$PY" -m pip install -q $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || "$PY" -m pip install -q --user $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || "$PY" -m pip install -q --break-system-packages $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || { fail "Python package installation failed. Try: \"$PY\" -m pip install $PIP_MIRROR_ARGS ${MISSING_PY[*]}"; ERRORS=$((ERRORS + 1)); }
    ok "Installed: ${MISSING_PY[*]}"
fi
echo ""

# ── LibreOffice：统一检查，安装方式由执行环境决定 ──
echo "--- LibreOffice ---"
_LO_PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../.." && pwd)"
if "$PY" "$_LO_PLUGIN_DIR/scripts/zcode_libreoffice.py" check; then
    ok "LibreOffice ready"
else
    warn "LibreOffice is not ready; retain current files and follow the launcher message."
    # 桌面可用性只决定引导文案，程序通过 PATH 查找。
    info "Installation guidance (desktop: ask whether to wait or install): $_LO_PLUGIN_DIR/skills/xlsx/env_setup/libreoffice-unmanaged.md"
fi

# ── Step 2e: Font Verification (local /usr/share/fonts/) ──
echo "--- [5/6] Font Verification ---"
FONT_BASE="/usr/share/fonts"
FONT_LIST="$SCRIPT_DIR/font_list.txt"

if [ ! -f "$FONT_LIST" ]; then
    fail "Font list not found: $FONT_LIST"
    ERRORS=$((ERRORS + 1))
else
    TOTAL=$(wc -l < "$FONT_LIST" | tr -d ' ')
    FOUND=0
    MISSING=0
    info "Verifying $TOTAL fonts in $FONT_BASE ..."

    while IFS= read -r rel_path || [ -n "$rel_path" ]; do
        [ -z "$rel_path" ] && continue
        if [ -f "$rel_path" ]; then
            FOUND=$((FOUND + 1))
        else
            warn "Missing font: $rel_path"
            MISSING=$((MISSING + 1))
        fi
    done < "$FONT_LIST"

    if [ $MISSING -eq 0 ]; then
        ok "All $FOUND fonts found in $FONT_BASE"
    else
        warn "Fonts: $FOUND found, $MISSING missing in $FONT_BASE"
        ERRORS=$((ERRORS + 1))
    fi
fi

# Set FONT_DIR to system font directory
FONT_DIR="$FONT_BASE"
export FONT_DIR
echo ""

# ── Step 2f: CJK Font Verification ──
echo "--- [6/6] CJK Font Verification ---"
CJK_FOUND=false

if [ -f "$FONT_BASE/truetype/chinese/NotoSansSC[wght].ttf" ]; then
    ok "Noto Sans SC found in $FONT_BASE"
    CJK_FOUND=true
elif fc-list :lang=zh 2>/dev/null | head -1 | grep -q .; then
    ok "CJK fonts available (fc-list)"
    CJK_FOUND=true
fi

if [ "$CJK_FOUND" = false ]; then
    warn "No CJK font detected in $FONT_BASE — ensure fonts are pre-installed"
fi
echo ""

# ── Summary ──
echo "============================================"
if [ $ERRORS -eq 0 ]; then
    echo "  All dependencies OK."
else
    echo "  $ERRORS issue(s) found. Fix them above."
fi
echo "  XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
echo "  FONT_DIR=$FONT_DIR (system font directory)"
echo "============================================"
