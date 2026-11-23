#!/usr/bin/env bash
# ---
# name: docx-setup
# author: Z.AI
# version: "1.0"
# description: Environment setup for the DOCX skill. Checks and installs all required dependencies.
# ---
#
# Installs only dependencies required by the DOCX skill.
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
ok() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

echo "============================================"
echo "  DOCX Skill — Environment Setup"
echo "============================================"
echo ""

OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $OS $ARCH"
echo ""

# ── 0. macOS: Homebrew ──
if [ "$OS" = "Darwin" ]; then
    echo "--- Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        BREW_VER=$(brew --version 2>/dev/null | head -1)
        ok "brew ($BREW_VER)"
    else
        fail "brew not found — Node.js install needs Homebrew on macOS"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    fi
    echo ""
fi

# ── 1. Node.js (docx-js runs on Node) ──
echo "--- Node.js ---"
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    ok "node ($NODE_VER)"
else
    fail "node not found (required — docx generation uses docx-js on Node)"
    case "$OS" in
        Darwin) info "Install: brew install node" ;;
        Linux)  info "Install: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
                info "         sudo apt install -y nodejs" ;;
        *)      info "Install: https://nodejs.org/" ;;
    esac
fi

# ── 2. npm ──
echo ""
echo "--- npm ---"
if command -v npm &>/dev/null; then
    NPM_VER=$(npm --version 2>/dev/null)
    ok "npm ($NPM_VER)"
else
    fail "npm not found"
    case "$OS" in
        Darwin) info "Install: brew install node (includes npm)" ;;
        Linux)  info "Install: comes with nodejs" ;;
        *)      info "Install: https://nodejs.org/" ;;
    esac
fi

# ── 3. npm package: docx ──
echo ""
echo "--- npm Packages ---"
if node -e "require('docx')" 2>/dev/null || npm list -g docx &>/dev/null; then
    DOCX_VER=$(node -e "try{console.log(require('docx/package.json').version)}catch(e){console.log('installed')}" 2>/dev/null)
    ok "docx ($DOCX_VER)"
else
    fail "docx not installed"
    info "Install: npm install -g docx"
    echo ""
    if [ -t 0 ]; then
        read -p "  Install now? [Y/n] " -n 1 -r REPLY
        echo ""
        REPLY=${REPLY:-Y}
    else
        warn "Non-interactive mode — skipping auto-install."
        REPLY=N
    fi
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        npm install -g docx 2>/dev/null && ok "Installed: docx" || fail "npm install failed"
    fi
fi

# ── 4. Python 3 (post-processing scripts) ──
echo ""
echo "--- Python (post-processing) ---"
if command -v "$PY" &>/dev/null; then
    PY_VER=$("$PY" --version 2>&1)
    ok "python3 ($PY_VER)"
    if [ "$OS" = "Darwin" ]; then
        PY_PATH="$PY"
        if [[ "$PY_PATH" == "/usr/bin/python3" ]]; then
            warn "Using macOS system Python (limited). Recommend: brew install python3"
        fi
    fi
else
    fail "python3 not found"
    case "$OS" in
        Darwin) info "Install: brew install python3" ;;
        Linux)  info "Install: sudo apt install python3 python3-pip  (Debian/Ubuntu)"
                info "         sudo dnf install python3 python3-pip  (Fedora/RHEL)" ;;
        *)      info "Install: https://www.python.org/downloads/" ;;
    esac
fi

# ── 5. pip ──
echo ""
echo "--- pip ---"
if "$PY" -m pip --version &>/dev/null 2>&1; then
    PIP_VER=$("$PY" -m pip --version 2>/dev/null | head -1)
    ok "pip ($PIP_VER)"
else
    fail "pip not found"
    case "$OS" in
        Darwin) info "Install: \"$PY\" -m ensurepip --upgrade"
                info "     or: brew install python3 (includes pip)" ;;
        Linux)  info "Install: sudo apt install python3-pip  (Debian/Ubuntu)" ;;
        *)      info "Install: \"$PY\" -m ensurepip --upgrade" ;;
    esac
fi

# ── 6. Python packages ──
echo ""
echo "--- Python Packages ---"
PY_PKGS=(
    "defusedxml:defusedxml"
)

MISSING_PY=()
for entry in "${PY_PKGS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if "$PY" -c "import $mod" 2>/dev/null; then
        ver=$("$PY" -c "import $mod; print(getattr($mod, '__version__', 'installed'))" 2>/dev/null)
        ok "$pkg ($ver)"
    else
        fail "$pkg not installed"
        MISSING_PY+=("$pkg")
    fi
done

if [ ${#MISSING_PY[@]} -gt 0 ]; then
    echo ""
    if [ -t 0 ]; then
        read -p "  Install missing Python packages? [Y/n] " -n 1 -r REPLY
        echo ""
        REPLY=${REPLY:-Y}
    else
        warn "Non-interactive mode — skipping auto-install. Run interactively or install manually."
        REPLY=N
    fi
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        "$PY" -m pip install -q "${MISSING_PY[@]}" 2>/dev/null \
            || "$PY" -m pip install -q --user "${MISSING_PY[@]}" 2>/dev/null \
            || "$PY" -m pip install -q --break-system-packages "${MISSING_PY[@]}" 2>/dev/null \
            || { fail "Python package installation failed. Try manually: \"$PY\" -m pip install ${MISSING_PY[*]}"; }
        ok "Installed: ${MISSING_PY[*]}"
    fi
fi

# ── LibreOffice：统一检查，安装方式由执行环境决定 ──
echo "--- LibreOffice ---"
_LO_PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
if "$PY" "$_LO_PLUGIN_DIR/scripts/zcode_libreoffice.py" check; then
    ok "LibreOffice ready"
else
    warn "LibreOffice is not ready; retain current files and follow the launcher message."
    # 桌面可用性只决定引导文案，程序通过 PATH 查找。
    info "Installation guidance (desktop: ask whether to wait or install): $_LO_PLUGIN_DIR/skills/docx/env_setup/libreoffice-unmanaged.md"
fi

# ── Summary ──
echo ""
echo "============================================"
echo "  Setup complete."
echo "  Core: Node.js + docx (npm)"
echo "  Post-processing: Python + defusedxml"
echo "  On-demand (not substitutable): LibreOffice"
echo "============================================"
