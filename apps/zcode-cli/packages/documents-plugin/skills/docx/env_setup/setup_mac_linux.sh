#!/usr/bin/env bash
# ---
# name: docx-env-setup (macOS / Linux)
# description: Environment detection, dependency check & install for DOCX skill on macOS and Linux.
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

# ── Resolve DOCX_SKILL_DIR ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCX_SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export DOCX_SKILL_DIR

echo "============================================"
echo "  DOCX Skill — Environment Setup"
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
echo "DOCX_SKILL_DIR=$DOCX_SKILL_DIR"
echo ""

# ── China mirror detection & config ──
USE_CN_MIRROR=false
PIP_MIRROR_ARGS=""
NPM_MIRROR_ARGS=""

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
    NPM_MIRROR_ARGS="--registry https://registry.npmmirror.com"
    info "China mirrors enabled (pip: tuna, npm: npmmirror)"
    echo ""
fi

ERRORS=0

# ── Step 2a: Homebrew (macOS only) ──
if [ "$PLATFORM" = "mac" ]; then
    echo "--- [1/7] Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        ok "brew installed"
    else
        fail "brew not found"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
fi

# ── Step 2b: Node.js + npm ──
echo "--- [2/7] Node.js + npm ---"
if command -v node &>/dev/null; then
    ok "node ($(node --version))"
else
    fail "node not found (required — docx generation uses docx-js on Node)"
    case "$PLATFORM" in
        mac)   info "Install: brew install node" ;;
        linux) info "Install: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
               info "         sudo apt install -y nodejs"
               if [ "$USE_CN_MIRROR" = true ]; then
                   info "China alt: https://npmmirror.com/mirrors/node/"
               fi ;;
    esac
    ERRORS=$((ERRORS + 1))
fi

if command -v npm &>/dev/null; then
    ok "npm ($(npm --version))"
else
    fail "npm not found"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# ── Step 2c: npm package: docx ──
echo "--- [3/7] npm package: docx ---"
if node -e "require('docx')" 2>/dev/null || npm list -g docx &>/dev/null; then
    DOCX_VER=$(node -e "try{console.log(require('docx/package.json').version)}catch(e){console.log('installed')}" 2>/dev/null)
    ok "docx ($DOCX_VER)"
else
    fail "docx not installed"
    info "Installing docx..."
    if [ "$USE_CN_MIRROR" = true ]; then
        npm install -g docx $NPM_MIRROR_ARGS 2>/dev/null && ok "Installed: docx" \
            || { fail "npm install failed. Try: npm install -g docx $NPM_MIRROR_ARGS"; ERRORS=$((ERRORS + 1)); }
    else
        npm install -g docx 2>/dev/null && ok "Installed: docx" \
            || { fail "npm install failed. Try: npm install -g docx"; ERRORS=$((ERRORS + 1)); }
    fi
fi
echo ""

# ── Step 2d: Python 3 + pip ──
echo "--- [4/7] Python 3 + pip (post-processing) ---"
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

# ── Step 2e: Python packages ──
echo "--- [5/7] Python packages (defusedxml) ---"
PY_PKGS=(
    "defusedxml:defusedxml"
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

# ── Step 2f: Font Installation (from CDN) ──
echo "--- [6/7] Font Installation ---"
FONT_CDN_BASE="https://z-cdn.chatglm.cn/office-skill/fonts"
FONT_LIST="$SCRIPT_DIR/font_list.txt"

if [ "$PLATFORM" = "mac" ]; then
    USER_FONT_DIR="$HOME/Library/Fonts"
else
    USER_FONT_DIR="$HOME/.local/share/fonts"
fi
mkdir -p "$USER_FONT_DIR"

MARKER="$USER_FONT_DIR/.office-skill-fonts-installed"
if [ -f "$MARKER" ]; then
    ok "Fonts already installed (marker found). To re-install, delete $MARKER"
else
    if [ ! -f "$FONT_LIST" ]; then
        fail "Font list not found: $FONT_LIST"
        ERRORS=$((ERRORS + 1))
    else
        TOTAL=$(wc -l < "$FONT_LIST" | tr -d ' ')
        INSTALLED=0
        SKIPPED=0
        FAILED=0
        info "Downloading $TOTAL fonts from CDN..."
        
        while IFS= read -r rel_path || [ -n "$rel_path" ]; do
            [ -z "$rel_path" ] && continue
            fname="$(basename "$rel_path")"
            
            if [ -f "$USER_FONT_DIR/$fname" ]; then
                SKIPPED=$((SKIPPED + 1))
                continue
            fi
            
            # URL-encode special chars (brackets)
            encoded=$(echo "$rel_path" | sed 's/\[/%5B/g; s/\]/%5D/g; s/ /%20/g')
            url="$FONT_CDN_BASE/$encoded"
            
            if curl -fSL --connect-timeout 15 --retry 2 -o "$USER_FONT_DIR/$fname" "$url" 2>/dev/null; then
                INSTALLED=$((INSTALLED + 1))
            else
                warn "Failed to download: $rel_path"
                FAILED=$((FAILED + 1))
                rm -f "$USER_FONT_DIR/$fname" 2>/dev/null
            fi
        done < "$FONT_LIST"
        
        if [ "$PLATFORM" = "linux" ] && [ $INSTALLED -gt 0 ]; then
            fc-cache -f "$USER_FONT_DIR" 2>/dev/null
        fi
        
        if [ $FAILED -eq 0 ]; then
            touch "$MARKER"
            ok "Fonts: $INSTALLED newly installed, $SKIPPED already present (target: $USER_FONT_DIR)"
        else
            warn "Fonts: $INSTALLED installed, $SKIPPED skipped, $FAILED failed (marker not written, will retry next run)"
            ERRORS=$((ERRORS + 1))
        fi
    fi
fi

# Set FONT_DIR to user font directory (fonts are now installed there)
FONT_DIR="$USER_FONT_DIR"
export FONT_DIR
echo ""

# ── Step 2g: CJK Font Verification ──
echo "--- [7/7] CJK Font Verification ---"
CJK_FOUND=false

if [ "$PLATFORM" = "mac" ]; then
    if [ -f "$HOME/Library/Fonts/NotoSansSC[wght].ttf" ] || fc-list :lang=zh 2>/dev/null | head -1 | grep -q .; then
        ok "CJK fonts available (Noto Sans SC or system)"
        CJK_FOUND=true
    fi
    if [ -f "$HOME/Library/Fonts/NotoSansSC[wght].ttf" ]; then
        ok "NotoSansSC (user fonts)"
        CJK_FOUND=true
    fi
elif [ "$PLATFORM" = "linux" ]; then
    if fc-list :lang=zh 2>/dev/null | head -1 | grep -q .; then
        ok "CJK fonts available (fc-list)"
        CJK_FOUND=true
    fi
fi

if [ "$CJK_FOUND" = false ]; then
    warn "No CJK font detected — fonts were downloaded and copied; rebuild font cache if needed"
fi
echo ""

# ── Summary ──
echo "============================================"
if [ $ERRORS -eq 0 ]; then
    echo "  All dependencies OK."
else
    echo "  $ERRORS issue(s) found. Fix them above."
fi
echo "  DOCX_SKILL_DIR=$DOCX_SKILL_DIR"
echo "  FONT_DIR=$FONT_DIR (user font directory)"
echo "============================================"
