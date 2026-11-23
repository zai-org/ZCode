#!/usr/bin/env bash
# 优先选择预装入口；存在但运行失败时仍保留它，由用户决定是否切换。
PY="$(command -v zcode-python || command -v python3)" || PY=""
# 没有解释器时无法运行 Python 引导脚本；先给桌面选择，避免进入自动装包或下载。
if [ -z "$PY" ] && [ -n "${ZCODE_PREINSTALLED_TOOLS_AVAILABLE:-}" ]; then
    echo "预装版本未就绪或已关闭，请在 帮助 → 预装工具 中查看"
    echo "Choose to wait, enable Python, or install system Python using the manual steps in env_setup/setup.md."
    return 1 2>/dev/null || exit 1
fi
# Lightweight environment check for PDF skill.
# Exit 0 = all CORE deps OK, exit 1 = missing CORE dependency.
# Playwright/Chromium (Creative/HTML pipeline) and Tectonic (Academic/LaTeX) are
# OPTIONAL — reported as INFO, never cause a non-zero exit. Install them on demand
# (with the user's confirmation) only when a route actually needs them.
# Also resolves and exports PDF_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING (core): $desc"; FAIL=1; fi; }
optional() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "optional OK: $desc"; else $QUIET || echo "optional MISSING: $desc (install on demand)"; fi; }
# 统一入口报告受管故障和系统回退；无可用程序时给安装指引，由用户决定等待或安装。
required_on_demand() {
    local result
    if result=$("$PY" "$1" check 2>&1); then
        $QUIET || echo "on-demand OK: LibreOffice — $result"
    else
        $QUIET || echo "$result"
    fi
}

# ── Resolve PDF_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PDF_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export PDF_SKILL_DIR

if [ "$(uname -s)" = "Darwin" ]; then
    FONT_DIR="${HOME}/Library/Fonts"
else
    FONT_DIR="/usr/share/fonts"
fi
export FONT_DIR

# ── CORE (required): Python + ReportLab/pypdf toolchain + CJK font ──
check "python3"    command -v "$PY"
check "pikepdf"    "$PY" -c "import pikepdf"
check "pdfplumber" "$PY" -c "import pdfplumber"
check "pypdf"      "$PY" -c "import pypdf"
check "reportlab"  "$PY" -c "import reportlab"
check "PyMuPDF"    "$PY" -c "import fitz"

# Font check: verify an embeddable CJK font is available (SimHei/Noto/WenQuanYi/Songti…)
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|simsun\|songti\|heiti\|wenquanyi\|yahei\|kai" \
        || { $QUIET || echo "MISSING (core): CJK font"; FAIL=1; }
fi

# ── OPTIONAL: Creative/HTML pipeline (Node + Playwright + Chromium) ──
optional "node"       command -v node
optional "playwright (npm)" node -e "require('playwright')"

# ── OPTIONAL: Academic/LaTeX pipeline (Tectonic) ──
if [ -x "$PDF_SKILL_DIR/scripts/tectonic" ] || command -v tectonic &>/dev/null; then
    $QUIET || echo "optional OK: tectonic"
else
    $QUIET || echo "optional MISSING: tectonic (LaTeX/Academic; install on demand)"
fi

# ── ON-DEMAND but NOT substitutable: Office→PDF (LibreOffice/soffice) ──
required_on_demand "${PDF_SKILL_DIR}/../../scripts/zcode_libreoffice.py"

$QUIET || echo "PDF_SKILL_DIR=$PDF_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
