#!/usr/bin/env python3
"""
PDF Processing Toolkit — All-in-One CLI

Usage:
    "$(command -v zcode-python || command -v python3)" pdf.py <command> [args...]

Commands:
    env.check [--json]          Check environment dependencies
    env.fix                     Auto-install missing dependencies

    extract.text  <pdf> [-p pages]
    extract.table <pdf> [-p pages]
    extract.image <pdf> -o <dir>

    pages.merge <pdf>... -o <out>
    pages.split <pdf> -o <dir>
    pages.rotate <pdf> <deg> -o <out> [-p pages]
    pages.crop <pdf> <box> -o <out> [-p pages]

    meta.get <pdf>
    meta.set <pdf> -o <out> -d <json>
    meta.brand <pdf>... [-o <out>] [-t title] [-q]

    form.info <pdf>
    form.fill <pdf> -o <out> -d <json>
    form.detail <pdf> <output.json>
    form.fill-legacy <pdf> <fields.json> <output.pdf>
    form.annotate <pdf> <fields.json> <output.pdf>
    form.render <pdf> <output_dir> [--max-dim N]
    form.validate <page> <fields.json> <input_img> <output_img>
    form.check-bbox <fields.json>

    pages.clean <pdf> -o <out>       Remove blank pages

    convert.office <file> [-o <out>]
    convert.html <file> [-o <out>] [--css <file>]
    convert.blueprint <llm_response.txt> [-o <out>]
    convert.latex <file> [--runs N] [--keep-logs]

    palette.generate [--title "..."] [--mode minimal] [--format python|json|css]
    palette.cascade [--title "..."] [--mode minimal] [--format summary|json|css|reportlab]

    code.sanitize <file>
    content.sanitize <file> [--apply]  Fix content issues (CJK, encoding)

    font.check <pdf>

    toc.check <pdf>
"""

from __future__ import annotations

import asyncio
import glob
import html
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

# 统一入口在插件根目录；禁止导入时生成缓存，保持分发内容不可变。
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
from zcode_libreoffice import LibreOfficeInvocationError, LibreOfficeUnavailable, conversion_directory, run_cli_operation, run_libreoffice

# ═══════════════════════════════════════════════════════════════
#  Section 0: Framework — Output, @cmd registry, CLI parser
# ═══════════════════════════════════════════════════════════════

class Output:
    """Structured JSON output for all subcommands."""

    @staticmethod
    def success(data: dict):
        payload = {"status": "success", "data": data}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        raise SystemExit(0)

    @staticmethod
    def error(error: str, message: str, hint: str | None = None, code: int = 1):
        payload = {"status": "error", "error": error, "message": message}
        if hint is not None:
            payload["hint"] = hint
        sys.stderr.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        raise SystemExit(code)

    @staticmethod
    def check_file(filepath: str) -> Path:
        target = Path(filepath)
        if not target.exists():
            Output.error("FileNotFound", f"File not found: {filepath}", code=2)
        return target


# Command registry
_COMMANDS: dict[str, Callable] = {}


def cmd(name: str):
    """Decorator to register a CLI command under a dotted namespace."""
    def decorator(fn: Callable) -> Callable:
        _COMMANDS[name] = fn
        return fn
    return decorator


def _pop_flag(argv: list, short: str, long: str, needs_value: bool = True):
    """Extract a flag (and optional value) from *argv* in-place."""
    for idx, tok in enumerate(argv):
        if tok in (short, long):
            argv.pop(idx)
            if needs_value:
                if idx < len(argv):
                    return argv.pop(idx)
                Output.error("MissingArg", f"Flag {long} requires a value")
            return True
    return None


def _load_json_arg(argv: list) -> dict:
    """Read JSON from -d/--data string or -f/--file path."""
    raw = _pop_flag(argv, "-d", "--data")
    if raw is not None:
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            Output.error("InvalidJSON", f"JSON parse error: {exc}")

    fpath = _pop_flag(argv, "-f", "--file")
    if fpath is not None:
        try:
            with open(fpath) as fh:
                return json.load(fh)
        except Exception as exc:
            Output.error("FileError", f"Failed to read file: {exc}")

    Output.error("MissingData", "Requires --data or --file argument")


def _resolve_page_indices(range_spec: str | None, page_count: int) -> list[int]:
    """Turn a human-friendly range string (1-indexed) into a sorted list of 0-based indices."""
    if not range_spec:
        return list(range(page_count))
    indices: set[int] = set()
    for segment in range_spec.split(","):
        segment = segment.strip()
        if "-" in segment:
            lo, hi = segment.split("-", 1)
            for i in range(int(lo) - 1, min(int(hi), page_count)):
                indices.add(i)
        else:
            val = int(segment) - 1
            if 0 <= val < page_count:
                indices.add(val)
    return sorted(indices)


_SCRIPT_DIR = Path(__file__).resolve().parent


# ═══════════════════════════════════════════════════════════════
#  Section 1: env — environment diagnostics and auto-fix
# ═══════════════════════════════════════════════════════════════

def _probe_cmd(name: str, version_args: list[str] | None = None) -> tuple[str, str]:
    """Check if a command exists and optionally get its version. Returns (status, detail)."""
    path = shutil.which(name)
    if path is None:
        return ("missing", "")
    if version_args is None:
        return ("ok", "")
    try:
        result = subprocess.run(
            [path] + version_args,
            capture_output=True, text=True, timeout=10
        )
        ver = result.stdout.strip() or result.stderr.strip()
        return ("ok", ver)
    except Exception:
        return ("ok", "")


def _probe_python_module(mod_name: str) -> tuple[str, str]:
    """Check if a Python module is importable and get its version."""
    try:
        result = subprocess.run(
            [sys.executable, "-c", f"import {mod_name}; print(getattr({mod_name}, '__version__', 'installed'))"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return ("ok", result.stdout.strip())
        return ("missing", "")
    except Exception:
        return ("missing", "")


def _find_node() -> str | None:
    """Locate a node binary, PATH first then common install locations.

    Node is often installed outside PATH (official tarball unpacked into
    ~/.local, nvm/volta/fnm version dirs, a per-user Windows install), and a
    `export PATH=...` from an earlier shell does not survive. Searching those
    locations keeps us from reinstalling something that is already present.
    """
    found = shutil.which("node")
    if found:
        return found

    home = Path.home()
    if os.name == "nt":
        patterns = [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
            str(home / "AppData" / "Local" / "Programs" / "nodejs" / "node.exe"),
            str(home / "AppData" / "Roaming" / "nvm" / "*" / "node.exe"),
            str(home / "scoop" / "apps" / "nodejs" / "current" / "node.exe"),
            str(home / ".volta" / "bin" / "node.exe"),
        ]
    else:
        patterns = [
            str(home / ".local" / "*" / "bin" / "node"),   # official tarball unpacked
            str(home / ".local" / "bin" / "node"),
            str(home / ".nvm" / "versions" / "node" / "*" / "bin" / "node"),
            str(home / ".fnm" / "node-versions" / "*" / "installation" / "bin" / "node"),
            str(home / ".volta" / "bin" / "node"),
            str(home / "n" / "bin" / "node"),
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]

    for pattern in patterns:
        # reverse: prefer the highest version when a glob matches several
        for candidate in sorted(glob.glob(pattern), reverse=True):
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
    return None


def _probe_node() -> tuple[str, str]:
    node = _find_node()
    if not node:
        return ("missing", "")
    try:
        result = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=10
        )
        ver = (result.stdout.strip() or result.stderr.strip()).lstrip("v")
    except Exception:
        ver = ""
    # Surface the resolved path when it is not on PATH, so callers know to use it.
    detail = ver if shutil.which("node") else f"{ver} at {node}" if ver else node
    return ("ok", detail)


def _probe_python() -> tuple[str, str]:
    try:
        import platform
        return ("ok", platform.python_version())
    except Exception:
        return ("ok", "")


def _probe_libreoffice() -> tuple[str, str]:
    try:
        result = run_cli_operation(run_libreoffice(['--version'], timeout=15))
        return ('ok', f'{result.source}: {result.version}')
    except (LibreOfficeUnavailable, LibreOfficeInvocationError, OSError, ValueError) as error:
        return ('missing', str(error))


def _probe_tectonic() -> tuple[str, str]:
    home_bin = Path.home() / "tectonic"
    if home_bin.exists() and os.access(home_bin, os.X_OK):
        return ("ok", "")
    tec_local = _SCRIPT_DIR / "tectonic"
    if tec_local.exists() and os.access(tec_local, os.X_OK):
        return ("ok", "")
    if shutil.which("tectonic"):
        return ("ok", "")
    return ("missing", "")


def _find_npm() -> str | None:
    """Locate npm, PATH first then next to the resolved node binary."""
    found = shutil.which("npm")
    if found:
        return found
    node = _find_node()
    if not node:
        return None
    for name in (["npm.cmd", "npm"] if os.name == "nt" else ["npm"]):
        candidate = Path(node).parent / name
        if candidate.exists():
            return str(candidate)
    return None


def _probe_playwright_npm() -> tuple[str, str]:
    """Check if playwright npm package is installed."""
    node = _find_node()
    if node:
        # Try the caller's cwd first, then node's own install dir — installing
        # node privately and then running `npm install playwright` in that same
        # directory is a common pattern, and node resolves require() from cwd.
        for cwd in (None, str(Path(node).parent.parent)):
            try:
                result = subprocess.run(
                    [node, "-e", "console.log(require('playwright/package.json').version)"],
                    capture_output=True, text=True, timeout=10, cwd=cwd
                )
                if result.returncode == 0 and result.stdout.strip():
                    return ("ok", result.stdout.strip())
            except Exception:
                pass
    # Try global
    npm = _find_npm()
    if npm:
        try:
            result = subprocess.run(
                [npm, "list", "-g", "playwright", "--depth=0"],
                capture_output=True, text=True, timeout=15
            )
            import re as _re
            m = _re.search(r"playwright@(\S+)", result.stdout)
            if m:
                return ("ok", m.group(1))
        except Exception:
            pass
    return ("missing", "")


def _probe_chromium() -> tuple[str, str]:
    """Check if Playwright Chromium browser is installed."""
    import platform as _platform
    home = Path.home()
    if _platform.system() == "Darwin":
        cache_dir = home / "Library" / "Caches" / "ms-playwright"
    else:
        cache_dir = home / ".cache" / "ms-playwright"
    if cache_dir.is_dir():
        for entry in sorted(cache_dir.iterdir(), reverse=True):
            if "chromium" in entry.name.lower():
                return ("ok", entry.name)
    return ("missing", "")


@cmd("env.check")
def env_check(argv: list):
    """Check environment dependencies."""
    use_json = _pop_flag(argv, "-j", "--json", needs_value=False)

    s_node = _probe_node()
    s_pw = _probe_playwright_npm()
    s_cr = _probe_chromium()
    s_py = _probe_python()
    s_pike = _probe_python_module("pikepdf")
    s_plumb = _probe_python_module("pdfplumber")
    s_pypdf = _probe_python_module("pypdf")
    s_rl = _probe_python_module("reportlab")
    s_fitz = _probe_python_module("fitz")
    s_lo = _probe_libreoffice()
    s_tec = _probe_tectonic()
    s_pw_py = _probe_python_module("playwright")

    if use_json:
        report = {
            "core": {  # required for the default ReportLab + processing routes
                "python3": s_py[0], "python3_version": s_py[1],
                "reportlab": s_rl[0], "reportlab_version": s_rl[1],
                "pypdf": s_pypdf[0], "pypdf_version": s_pypdf[1],
                "PyMuPDF": s_fitz[0], "PyMuPDF_version": s_fitz[1],
                "pikepdf": s_pike[0], "pikepdf_version": s_pike[1],
                "pdfplumber": s_plumb[0], "pdfplumber_version": s_plumb[1],
            },
            "optional_html_route": {  # Creative / poster / HTML->PDF \u2014 install on demand
                "node": s_node[0], "node_version": s_node[1],
                "playwright": s_pw[0], "playwright_version": s_pw[1],
                "chromium": s_cr[0], "chromium_detail": s_cr[1],
                "playwright_python": s_pw_py[0], "playwright_python_version": s_pw_py[1],
            },
            "optional_other": {
                "libreoffice": s_lo[0],
                "libreoffice_message": s_lo[1],
                "tectonic": s_tec[0],
            },
        }
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        # Exit code reflects CORE only; optional engines never fail the check.
        rc = 0
        for v in [s_py, s_rl, s_pypdf, s_fitz, s_pike, s_plumb]:
            if v[0] != "ok":
                rc = 2
                break
        raise SystemExit(rc)

    # Human-readable output
    rc = 0

    def show(name: str, status: tuple[str, str], optional: bool = False,
             on_demand_required: bool = False):
        nonlocal rc
        s, d = status
        if s == "ok":
            detail = f" ({d})" if d else ""
            print(f"  \u2713 {name}{detail}")
        elif on_demand_required:
            print(f"  ○ {name}: {d}")
        elif optional:
            print(f"  \u25cb {name} (optional, not installed \u2014 install on demand)")
        else:
            print(f"  \u2717 {name} (missing)")
            rc = 2

    print("=== PDF Skill Environment ===\n")
    print("--- Core (required: ReportLab + processing routes) ---")
    show("python3", s_py)
    show("reportlab", s_rl)
    show("pypdf", s_pypdf)
    show("PyMuPDF", s_fitz)
    show("pikepdf", s_pike)
    show("pdfplumber", s_plumb)

    print("\n--- Optional: HTML route (Creative / poster / HTML\u2192PDF) ---")
    show("node", s_node, optional=True)
    if s_node[0] == "ok" and not shutil.which("node"):
        _node_abs = _find_node()
        print(f"    \u26a0 node is NOT on PATH \u2014 a bare `node ...` will fail.")
        print(f"      Invoke it by absolute path, e.g.:")
        print(f'        "{_node_abs}" "$PDF_SKILL_DIR/scripts/html2poster.js" poster.html -o poster.pdf')
    show("playwright", s_pw, optional=True)
    show("chromium", s_cr, optional=True)
    if s_pw_py[0] == "ok":
        print(f"    (playwright-python: {s_pw_py[1]})")

    print("\n--- On demand: other ---")
    show("libreoffice", s_lo, on_demand_required=True)
    show("tectonic", s_tec, optional=True)

    print("\n=== Install Commands (optional engines \u2014 install only when a route needs them, with the user's OK) ===")
    print("  Core Python: \"$(command -v zcode-python || command -v python3)\" -m pip install reportlab pypdf PyMuPDF pikepdf pdfplumber")
    print("  Node.js:     brew install node (macOS) / apt install nodejs (Ubuntu)")
    print("  Playwright:  npm install -g playwright && npx playwright install chromium   # large download, minutes")
    if os.environ.get('ZCODE_PREINSTALLED_TOOLS_AVAILABLE'):
        print('  LibreOffice: use the unified launcher; if neither program is usable, report the preparation state and reason, then ask the user to wait or let the Agent follow env_setup/setup.md. Keep using the launcher after installation.')
    else:
        print('  LibreOffice: follow env_setup/libreoffice-unmanaged.md when required; verify with the unified launcher check command.')
    print("  Tectonic:    curl -fsSL https://drop-sh.fullyjustified.net | sh            # downloads LaTeX packages on first run")
    raise SystemExit(rc)


@cmd("env.fix")
def env_fix(argv: list):
    """Auto-install missing CORE Python dependencies only.
    Browser engines (Playwright/Chromium) and LaTeX (Tectonic) are OPTIONAL and are
    NEVER auto-installed here — install them on demand, with the user's confirmation,
    only when a route needs them (they involve large downloads / long waits)."""
    modules = {
        "reportlab": "reportlab",
        "pypdf": "pypdf",
        "fitz": "PyMuPDF",
        "pikepdf": "pikepdf",
        "pdfplumber": "pdfplumber",
        "pdf2image": "pdf2image",
        "PIL": "Pillow",
    }
    installed = []
    for mod, pkg in modules.items():
        s, _ = _probe_python_module(mod)
        if s == "missing":
            print(f"Installing {pkg}...")
            for attempt in (
                [sys.executable, "-m", "pip", "install", "-q", pkg],
                [sys.executable, "-m", "pip", "install", "-q", "--user", pkg],
                [sys.executable, "-m", "pip", "install", "-q", "--break-system-packages", pkg],
            ):
                result = subprocess.run(attempt, capture_output=True, text=True)
                if result.returncode == 0:
                    installed.append(pkg)
                    break
            else:
                print(f"  Failed to install {pkg}")

    if installed:
        print(f"\nInstalled: {', '.join(installed)}")
    else:
        print("All Python dependencies are already installed.")
    raise SystemExit(0)


# ═══════════════════════════════════════════════════════════════
#  Section 2: extract — text, tables, and embedded images
# ═══════════════════════════════════════════════════════════════

@cmd("extract.text")
def extract_text(argv: list):
    """Pull plain text from selected pages."""
    if not argv:
        Output.error("MissingArg", "pdf path required")
    pdf_path = argv.pop(0)
    page_range = _pop_flag(argv, "-p", "--pages")

    import pdfplumber
    src = Output.check_file(pdf_path)
    try:
        doc = pdfplumber.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    total_pages = len(doc.pages)
    target_pages = _resolve_page_indices(page_range, total_pages)
    char_total = 0
    page_results = []

    for pg_idx in target_pages:
        content = doc.pages[pg_idx].extract_text() or ""
        char_total += len(content)
        page_results.append({"page": pg_idx + 1, "chars": len(content), "text": content})

    doc.close()
    Output.success({
        "total_pages": total_pages,
        "extracted_pages": len(target_pages),
        "total_chars": char_total,
        "pages": page_results,
    })


@cmd("extract.table")
def extract_table(argv: list):
    """Locate and return every table on selected pages."""
    if not argv:
        Output.error("MissingArg", "pdf path required")
    pdf_path = argv.pop(0)
    page_range = _pop_flag(argv, "-p", "--pages")

    import pdfplumber
    src = Output.check_file(pdf_path)
    try:
        doc = pdfplumber.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    total_pages = len(doc.pages)
    target_pages = _resolve_page_indices(page_range, total_pages)
    collected = []

    for pg_idx in target_pages:
        for tbl_num, raw_table in enumerate(doc.pages[pg_idx].extract_tables()):
            if not raw_table:
                continue
            sanitised = [
                [(cell.strip() if cell else "") for cell in row]
                for row in raw_table
            ]
            collected.append({
                "page": pg_idx + 1,
                "table_index": tbl_num,
                "rows": len(sanitised),
                "cols": len(sanitised[0]) if sanitised else 0,
                "data": sanitised,
            })

    doc.close()
    Output.success({
        "total_pages": total_pages,
        "extracted_pages": len(target_pages),
        "total_tables": len(collected),
        "tables": collected,
    })


@cmd("extract.image")
def extract_image(argv: list):
    """Save every embedded raster image to output dir."""
    if not argv:
        Output.error("MissingArg", "pdf path required")
    pdf_path = argv.pop(0)
    out_dir = _pop_flag(argv, "-o", "--output") or "."

    import pikepdf
    src = Output.check_file(pdf_path)
    dest = Path(out_dir)
    dest.mkdir(parents=True, exist_ok=True)

    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    saved = []
    seq = 0
    _EXT_MAP = {
        "/DCTDecode": "jpg",
        "/FlateDecode": "png",
        "/JPXDecode": "jp2",
    }

    for page_no, pg in enumerate(doc.pages, 1):
        res = pg.get("/Resources")
        if res is None or "/XObject" not in res:
            continue
        for key, ref in res.XObject.items():
            try:
                img_obj = doc.get_object(ref.objgen)
                if img_obj.get("/Subtype") != "/Image":
                    continue
                seq += 1
                w = int(img_obj.get("/Width", 0))
                h = int(img_obj.get("/Height", 0))
                filt = img_obj.get("/Filter")
                ext = _EXT_MAP.get(str(filt) if filt else None, "bin")
                fname = f"page{page_no}_img{seq}.{ext}"
                out_file = dest / fname
                out_file.write_bytes(img_obj.read_raw_bytes())
                saved.append({
                    "page": page_no, "name": str(key), "file": str(out_file),
                    "width": w, "height": h, "format": ext,
                })
            except Exception:
                continue

    doc.close()
    Output.success({"output_dir": str(dest), "total_images": len(saved), "images": saved})


# ═══════════════════════════════════════════════════════════════
#  Section 3: pages — merge, split, rotate, crop
# ═══════════════════════════════════════════════════════════════

@cmd("pages.merge")
def pages_merge(argv: list):
    """Concatenate several PDF files into one."""
    out_path = _pop_flag(argv, "-o", "--output")
    if out_path is None:
        Output.error("MissingArg", "--output is required")
    if not argv:
        Output.error("MissingArg", "At least one PDF required")

    import pikepdf
    sources = [Output.check_file(p) for p in argv]
    handles = []
    try:
        combined = pikepdf.new()
        descriptions = []
        for src in sources:
            handle = pikepdf.open(src)
            handles.append(handle)
            n = len(handle.pages)
            descriptions.append(f"{src.name} ({n} pages)")
            for pg in handle.pages:
                combined.pages.append(pg)
        total = len(combined.pages)
        combined.save(out_path)
        combined.close()
    except Exception as exc:
        Output.error("MergeError", f"Merge failed: {exc}", code=4)
    finally:
        for h in handles:
            try:
                h.close()
            except Exception:
                pass

    Output.success({"output": out_path, "total_pages": total, "sources": descriptions})


@cmd("pages.split")
def pages_split(argv: list):
    """Write each page as a separate single-page PDF."""
    if not argv:
        Output.error("MissingArg", "pdf path required")
    pdf_path = argv.pop(0)
    out_dir = _pop_flag(argv, "-o", "--output") or "."

    import pikepdf
    src = Output.check_file(pdf_path)
    dest = Path(out_dir)
    dest.mkdir(parents=True, exist_ok=True)

    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    generated = []
    base = src.stem
    try:
        for idx, pg in enumerate(doc.pages, 1):
            fp = dest / f"{base}_page{idx:03d}.pdf"
            single_doc = pikepdf.new()
            single_doc.pages.append(pg)
            single_doc.save(fp)
            single_doc.close()
            generated.append(str(fp))
        doc.close()
    except Exception as exc:
        Output.error("SplitError", f"Split failed: {exc}", code=4)

    Output.success({"output_dir": str(dest), "total_pages": len(generated), "files": generated})


@cmd("pages.rotate")
def pages_rotate(argv: list):
    """Rotate selected pages by 90/180/270 degrees."""
    if len(argv) < 2:
        Output.error("MissingArg", "pdf path and degrees required")
    pdf_path = argv.pop(0)
    degrees = int(argv.pop(0))
    out_path = _pop_flag(argv, "-o", "--output")
    if out_path is None:
        Output.error("MissingArg", "--output is required")
    page_range = _pop_flag(argv, "-p", "--pages")

    if degrees not in (90, 180, 270):
        Output.error("InvalidDegrees", "Rotation angle must be 90, 180, or 270")

    import pikepdf
    src = Output.check_file(pdf_path)
    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    targets = _resolve_page_indices(page_range, len(doc.pages))
    try:
        for i in targets:
            existing = int(doc.pages[i].get("/Rotate", 0))
            doc.pages[i]["/Rotate"] = (existing + degrees) % 360
        doc.save(out_path)
        doc.close()
    except Exception as exc:
        Output.error("RotateError", f"Rotation failed: {exc}", code=4)

    Output.success({"output": out_path, "degrees": degrees, "pages_rotated": len(targets)})


@cmd("pages.crop")
def pages_crop(argv: list):
    """Set the media/crop box on selected pages. box = 'left,bottom,right,top' in pt."""
    if len(argv) < 2:
        Output.error("MissingArg", "pdf path and crop box required")
    pdf_path = argv.pop(0)
    box_str = argv.pop(0)
    out_path = _pop_flag(argv, "-o", "--output")
    if out_path is None:
        Output.error("MissingArg", "--output is required")
    page_range = _pop_flag(argv, "-p", "--pages")

    try:
        coords = [float(v.strip()) for v in box_str.split(",")]
        assert len(coords) == 4
        left, bottom, right, top = coords
    except Exception:
        Output.error("InvalidBox", "Invalid crop box format, should be: left,bottom,right,top",
                      hint="Example: 50,50,550,750")

    import pikepdf
    src = Output.check_file(pdf_path)
    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    targets = _resolve_page_indices(page_range, len(doc.pages))
    try:
        arr = pikepdf.Array([left, bottom, right, top])
        for i in targets:
            doc.pages[i].mediabox = arr
            doc.pages[i].cropbox = arr
        doc.save(out_path)
        doc.close()
    except Exception as exc:
        Output.error("CropError", f"Crop failed: {exc}", code=4)

    Output.success({
        "output": out_path,
        "box": {"left": left, "bottom": bottom, "right": right, "top": top},
        "pages_cropped": len(targets),
    })


@cmd("pages.clean")
def pages_clean(argv: list):
    """Remove truly blank pages from a PDF.

    A page is considered blank ONLY if it has exactly 0 text characters AND
    0 images.  Pages with even a single character or a tiny image are kept.

    Usage:
        pdf.py pages.clean input.pdf -o output.pdf
    """
    if not argv:
        Output.error("MissingArg", "PDF path required")
    pdf_path = argv.pop(0)
    out_path = _pop_flag(argv, "-o", "--output")
    if out_path is None:
        Output.error("MissingArg", "--output is required")
    # --threshold is accepted but ignored (kept for backward compat)
    _pop_flag(argv, "-t", "--threshold")

    src = Output.check_file(pdf_path)

    # Phase 1: Detect blank pages using pdfplumber (text extraction)
    try:
        import pdfplumber
    except ImportError:
        Output.error("DependencyMissing", "pdfplumber required: \"$(command -v zcode-python || command -v python3)\" -m pip install pdfplumber")

    blank_indices = []  # 0-indexed
    total_pages = 0
    try:
        pdf = pdfplumber.open(str(src))
        total_pages = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            text = (page.extract_text() or "").strip()
            # Check for ANY images on the page (no size filter)
            images = page.images if hasattr(page, 'images') else []
            # A page is blank ONLY if it has exactly 0 characters AND 0 images
            if len(text) == 0 and len(images) == 0:
                blank_indices.append(i)
        pdf.close()
    except Exception as exc:
        Output.error("PDFError", f"Cannot analyze PDF: {exc}", code=3)

    if not blank_indices:
        Output.success({
            "output": str(src),
            "total_pages": total_pages,
            "blank_pages_removed": 0,
            "message": "No blank pages found",
        })
        return

    # Phase 2: Remove blank pages using pikepdf
    try:
        import pikepdf
    except ImportError:
        Output.error("DependencyMissing", "pikepdf required: \"$(command -v zcode-python || command -v python3)\" -m pip install pikepdf")

    try:
        doc = pikepdf.open(str(src))
        # Remove in reverse order to preserve indices
        for idx in sorted(blank_indices, reverse=True):
            if idx < len(doc.pages):
                del doc.pages[idx]
        doc.save(out_path)
        doc.close()
    except Exception as exc:
        Output.error("PDFError", f"Cannot remove blank pages: {exc}", code=4)

    remaining = total_pages - len(blank_indices)
    Output.success({
        "output": out_path,
        "total_pages": total_pages,
        "blank_pages_removed": len(blank_indices),
        "blank_page_numbers": [i + 1 for i in blank_indices],  # 1-indexed for humans
        "remaining_pages": remaining,
    })


# ═══════════════════════════════════════════════════════════════
#  Section 4: meta — metadata reading, writing, and branding
# ═══════════════════════════════════════════════════════════════

_XMP_MAPPING = {
    "Title": "dc:title",
    "Author": "dc:creator",
    "Subject": "dc:description",
    "Keywords": "pdf:Keywords",
    "Creator": "xmp:CreatorTool",
    "Producer": "pdf:Producer",
}
_ACCEPTED_KEYS = set(_XMP_MAPPING.keys())


@cmd("meta.get")
def meta_get(argv: list):
    """Read document information and metadata."""
    if not argv:
        Output.error("MissingArg", "pdf path required")

    import pikepdf
    src = Output.check_file(argv[0])
    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    record: dict = {
        "pages": len(doc.pages),
        "pdf_version": str(doc.pdf_version),
    }

    if doc.pages:
        mb = doc.pages[0].mediabox
        record["page_size"] = {
            "width": float(mb[2] - mb[0]),
            "height": float(mb[3] - mb[1]),
            "unit": "pt",
        }

    kv_pairs = {}
    if doc.docinfo:
        for k in doc.docinfo.keys():
            try:
                kv_pairs[str(k).lstrip("/")] = str(doc.docinfo[k])
            except Exception:
                pass
    record["metadata"] = kv_pairs
    record["encrypted"] = doc.is_encrypted
    record["has_form"] = "/AcroForm" in doc.Root
    record["has_outlines"] = "/Outlines" in doc.Root

    doc.close()
    Output.success(record)


@cmd("meta.set")
def meta_set(argv: list):
    """Update XMP + legacy docinfo metadata fields."""
    if not argv:
        Output.error("MissingArg", "pdf path required")
    pdf_path = argv.pop(0)
    out_path = _pop_flag(argv, "-o", "--output")
    if out_path is None:
        Output.error("MissingArg", "--output is required")
    data = _load_json_arg(argv)

    import pikepdf
    src = Output.check_file(pdf_path)
    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    # XMP layer
    with doc.open_metadata() as xmp:
        for raw_key, raw_val in data.items():
            norm = raw_key.title()
            xmp_key = _XMP_MAPPING.get(norm)
            if xmp_key is None:
                continue
            try:
                xmp[xmp_key] = str(raw_val)
            except Exception:
                pass

    # Legacy docinfo layer
    if not doc.docinfo:
        doc.docinfo = pikepdf.Dictionary()
    for raw_key, raw_val in data.items():
        norm = raw_key.title()
        if norm in _ACCEPTED_KEYS:
            doc.docinfo[pikepdf.Name(f"/{norm}")] = pikepdf.String(str(raw_val))

    doc.docinfo[pikepdf.Name("/ModDate")] = pikepdf.String(
        datetime.now().strftime("D:%Y%m%d%H%M%S")
    )

    try:
        doc.save(out_path)
        doc.close()
    except Exception as exc:
        Output.error("SaveError", f"Save failed: {exc}", code=4)

    Output.success({"output": out_path, "updated_fields": list(data.keys())})


@cmd("meta.brand")
def meta_brand(argv: list):
    """Add Z.ai branding metadata to PDF documents."""
    output_path = _pop_flag(argv, "-o", "--output")
    custom_title = _pop_flag(argv, "-t", "--title")
    quiet = _pop_flag(argv, "-q", "--quiet", needs_value=False)

    if not argv:
        Output.error("MissingArg", "At least one PDF file required")

    # Check if output is specified for multiple files
    if output_path and len(argv) > 1:
        Output.error("InvalidArg", "--output can only be used with a single input file")

    from pypdf import PdfReader, PdfWriter

    for input_path in argv:
        if not os.path.exists(input_path):
            print(f"Error: Input file not found: {input_path}", file=sys.stderr)
            continue

        try:
            reader = PdfReader(input_path)
        except Exception as e:
            print(f"Error: Cannot open PDF: {e}", file=sys.stderr)
            continue

        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)

        # Determine title
        if custom_title:
            title = custom_title
        else:
            original_meta = reader.metadata
            if original_meta and original_meta.title and original_meta.title not in ('(anonymous)', 'unspecified', None):
                title = original_meta.title
            else:
                title = os.path.splitext(os.path.basename(input_path))[0]

        writer.add_metadata({
            '/Title': title,
            '/Author': 'Z.ai',
            '/Creator': 'Z.ai',
            '/Producer': 'http://z.ai',
        })

        # Write output
        out = output_path if (len(argv) == 1 and output_path) else input_path
        try:
            with open(out, "wb") as f:
                writer.write(f)
        except Exception as e:
            print(f"Error: Cannot write output file: {e}", file=sys.stderr)
            continue

        if not quiet:
            print(f"\u2713 Updated metadata for: {os.path.basename(input_path)}")
            print(f"  Title: {title}")
            print("  Author: Z.ai")
            print("  Creator: Z.ai")
            print("  Producer: http://z.ai")
            if out != input_path:
                print(f"  Output: {out}")

    raise SystemExit(0)


# ═══════════════════════════════════════════════════════════════
#  Section 5: form — inspection, filling, annotation, rendering
# ═══════════════════════════════════════════════════════════════

# --- form.info (pikepdf-based) ---

_FIELD_TYPE_MAP = {
    "/Tx": "text",
    "/Sig": "signature",
}


def _classify_field(node) -> str:
    """Map a PDF field type token to a human label."""
    ft = str(node.get("/FT", ""))
    if ft in _FIELD_TYPE_MAP:
        return _FIELD_TYPE_MAP[ft]
    flags = int(node.get("/Ff", 0))
    if ft == "/Btn":
        return "radio" if (flags & (1 << 15)) else "checkbox"
    if ft == "/Ch":
        return "dropdown" if (flags & (1 << 17)) else "listbox"
    return "unknown"


def _extra_props(node, kind: str) -> dict:
    """Gather type-specific metadata (options, checked value, etc.)."""
    props: dict = {}
    if kind == "checkbox":
        ap = node.get("/AP")
        if ap and "/N" in ap:
            states = [str(s) for s in ap["/N"].keys()]
            props["states"] = states
            props["checked_value"] = next((s for s in states if s != "/Off"), states[0] if states else None)
    elif kind in ("dropdown", "listbox"):
        raw_opts = node.get("/Opt")
        if raw_opts:
            props["options"] = [
                {"value": str(item[0]), "label": str(item[1])} if isinstance(item, list) and len(item) >= 2
                else {"value": str(item), "label": str(item)}
                for item in raw_opts
            ]
    elif kind == "radio":
        kids = node.get("/Kids")
        if kids:
            radio_vals = []
            for child in kids:
                ap = child.get("/AP")
                if ap and "/N" in ap:
                    radio_vals.extend(str(k) for k in ap["/N"].keys() if str(k) != "/Off")
            if radio_vals:
                props["options"] = radio_vals
    return props


def _current_value(node):
    v = node.get("/V")
    return str(v) if v is not None else None


def _gather_fields(doc) -> list:
    """Walk the AcroForm field tree iteratively and return a flat list."""
    if "/AcroForm" not in doc.Root:
        return []
    acro = doc.Root.AcroForm
    if "/Fields" not in acro:
        return []

    page_lookup = {pg.objgen: idx for idx, pg in enumerate(doc.pages)}
    results = []
    stack = [(field, "") for field in reversed(list(acro.Fields))]

    while stack:
        node, parent_path = stack.pop()
        name = str(node.get("/T", ""))
        full = f"{parent_path}.{name}" if parent_path else name

        kids = node.get("/Kids")
        if kids and any("/T" in k for k in kids):
            for kid in reversed(list(kids)):
                stack.append((kid, full))
            continue

        kind = _classify_field(node)
        if kind == "unknown":
            continue

        entry = {"id": full, "type": kind}
        val = _current_value(node)
        if val:
            entry["current_value"] = val
        entry.update(_extra_props(node, kind))

        page_ref = node.get("/P")
        if page_ref and hasattr(page_ref, "objgen"):
            pg_num = page_lookup.get(page_ref.objgen)
            if pg_num is not None:
                entry["page"] = pg_num + 1

        results.append(entry)

    return results


@cmd("form.info")
def form_info(argv: list):
    """Return structured JSON describing every form field (pikepdf + check_fillable)."""
    if not argv:
        Output.error("MissingArg", "pdf path required")

    import pikepdf
    src = Output.check_file(argv[0])
    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    fields = _gather_fields(doc)
    if not fields:
        Output.success({"has_fields": False, "count": 0, "fields": [], "hint": "This PDF has no fillable form fields"})
    Output.success({"has_fields": True, "count": len(fields), "fields": fields})


@cmd("form.fill")
def form_fill(argv: list):
    """Write values into a fillable PDF (pikepdf version)."""
    if not argv:
        Output.error("MissingArg", "pdf path required")
    pdf_path = argv.pop(0)
    out_path = _pop_flag(argv, "-o", "--output")
    if out_path is None:
        Output.error("MissingArg", "--output is required")
    data = _load_json_arg(argv)

    import pikepdf
    src = Output.check_file(pdf_path)
    try:
        doc = pikepdf.open(src)
    except Exception as exc:
        Output.error("PDFError", f"Cannot open PDF: {exc}", code=3)

    if "/AcroForm" not in doc.Root or "/Fields" not in doc.Root.AcroForm:
        Output.error("NoForm", "This PDF has no form fields")

    known = {f["id"]: f for f in _gather_fields(doc)}

    # Validation
    issues = []
    for fid, fval in data.items():
        if fid not in known:
            issues.append(f"Field not found: {fid}")
            continue
        fmeta = known[fid]
        ftype = fmeta["type"]
        if ftype == "checkbox" and "states" in fmeta:
            ok_vals = fmeta["states"]
            if fval not in ok_vals and f"/{fval}" not in ok_vals and fval not in ("true", "True", "false", "False", "1", "0"):
                issues.append(f"Invalid value for field {fid}, options: {ok_vals} or true/false")
        if ftype in ("dropdown", "listbox") and "options" in fmeta:
            ok_vals = [o["value"] for o in fmeta["options"]]
            if fval not in ok_vals:
                issues.append(f"Invalid value for field {fid}, options: {ok_vals}")
    if issues:
        Output.error("ValidationError", "Field validation failed", hint="; ".join(issues))

    # Fill
    written = 0

    def _apply(node, parent_path=""):
        nonlocal written
        name = str(node.get("/T", ""))
        full = f"{parent_path}.{name}" if parent_path else name
        kids = node.get("/Kids")
        if kids and any("/T" in k for k in kids):
            for kid in kids:
                _apply(kid, full)
            return
        if full not in data:
            return
        val = data[full]
        kind = _classify_field(node)
        if kind == "checkbox":
            if val in ("true", "True", "1", True):
                ap = node.get("/AP")
                if ap and "/N" in ap:
                    checked_name = next((str(k) for k in ap["/N"].keys() if str(k) != "/Off"), "/Yes")
                    if not checked_name.startswith("/"):
                        checked_name = f"/{checked_name}"
                    node["/V"] = pikepdf.Name(checked_name)
                    node["/AS"] = pikepdf.Name(checked_name)
            else:
                node["/V"] = pikepdf.Name("/Off")
                node["/AS"] = pikepdf.Name("/Off")
        else:
            node["/V"] = pikepdf.String(str(val))
        written += 1

    for field in doc.Root.AcroForm.Fields:
        _apply(field)

    acro = doc.Root.AcroForm
    if "/NeedAppearances" not in acro:
        acro["/NeedAppearances"] = True

    try:
        doc.save(out_path)
    except Exception as exc:
        Output.error("SaveError", f"Save failed: {exc}", code=4)

    Output.success({"output": out_path, "fields_filled": written, "fields_requested": len(data)})


# --- form.detail (pypdf-based detailed field extraction) ---

def _get_full_annotation_field_id(annotation):
    """Build dotted field ID by walking parent chain."""
    components = []
    while annotation:
        field_name = annotation.get('/T')
        if field_name:
            components.append(field_name)
        annotation = annotation.get('/Parent')
    return ".".join(reversed(components)) if components else None


def _make_field_dict(field, field_id):
    field_dict = {"field_id": field_id}
    ft = field.get('/FT')
    if ft == "/Tx":
        field_dict["type"] = "text"
    elif ft == "/Btn":
        field_dict["type"] = "checkbox"
        states = field.get("/_States_", [])
        if len(states) == 2:
            if "/Off" in states:
                field_dict["checked_value"] = states[0] if states[0] != "/Off" else states[1]
                field_dict["unchecked_value"] = "/Off"
            else:
                print(f"Unexpected state values for checkbox `${field_id}`. Its checked and unchecked values may not be correct; if you're trying to check it, visually verify the results.")
                field_dict["checked_value"] = states[0]
                field_dict["unchecked_value"] = states[1]
    elif ft == "/Ch":
        field_dict["type"] = "choice"
        states = field.get("/_States_", [])
        field_dict["choice_options"] = [{
            "value": state[0],
            "text": state[1],
        } for state in states]
    else:
        field_dict["type"] = f"unknown ({ft})"
    return field_dict


def _get_field_info(reader) -> list:
    """Extract detailed field info from a PdfReader, including radio group aggregation."""
    fields = reader.get_fields()

    field_info_by_id = {}
    possible_radio_names: set[str] = set()

    for field_id, field in fields.items():
        if field.get("/Kids"):
            if field.get("/FT") == "/Btn":
                possible_radio_names.add(field_id)
            continue
        field_info_by_id[field_id] = _make_field_dict(field, field_id)

    radio_fields_by_id: dict[str, dict] = {}

    for page_index, page in enumerate(reader.pages):
        annotations = page.get('/Annots', [])
        for ann in annotations:
            field_id = _get_full_annotation_field_id(ann)
            if field_id in field_info_by_id:
                field_info_by_id[field_id]["page"] = page_index + 1
                field_info_by_id[field_id]["rect"] = ann.get('/Rect')
            elif field_id in possible_radio_names:
                try:
                    on_values = [v for v in ann["/AP"]["/N"] if v != "/Off"]
                except KeyError:
                    continue
                if len(on_values) == 1:
                    rect = ann.get("/Rect")
                    if field_id not in radio_fields_by_id:
                        radio_fields_by_id[field_id] = {
                            "field_id": field_id,
                            "type": "radio_group",
                            "page": page_index + 1,
                            "radio_options": [],
                        }
                    radio_fields_by_id[field_id]["radio_options"].append({
                        "value": on_values[0],
                        "rect": rect,
                    })

    # Filter fields without location
    fields_with_location = []
    for field_info in field_info_by_id.values():
        if "page" in field_info:
            fields_with_location.append(field_info)
        else:
            print(f"Unable to determine location for field id: {field_info.get('field_id')}, ignoring")

    # Sort by page number, then Y position (flipped), then X
    def sort_key(f):
        if "radio_options" in f:
            rect = f["radio_options"][0]["rect"] or [0, 0, 0, 0]
        else:
            rect = f.get("rect") or [0, 0, 0, 0]
        adjusted_position = [-rect[1], rect[0]]
        return [f.get("page"), adjusted_position]

    sorted_fields = fields_with_location + list(radio_fields_by_id.values())
    sorted_fields.sort(key=sort_key)

    return sorted_fields


@cmd("form.detail")
def form_detail(argv: list):
    """Extract detailed field info (pypdf version) to JSON."""
    if len(argv) < 2:
        Output.error("MissingArg", "Usage: form.detail <pdf> <output.json>")
    pdf_path = argv[0]
    json_output_path = argv[1]

    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    field_info = _get_field_info(reader)
    with open(json_output_path, "w") as f:
        json.dump(field_info, f, indent=2)
    print(f"Wrote {len(field_info)} fields to {json_output_path}")
    raise SystemExit(0)


# --- form.fill-legacy (pypdf version with monkeypatch) ---

def _validation_error_for_field_value(field_info, field_value):
    field_type = field_info["type"]
    field_id = field_info["field_id"]
    if field_type == "checkbox":
        checked_val = field_info["checked_value"]
        unchecked_val = field_info["unchecked_value"]
        if field_value != checked_val and field_value != unchecked_val:
            return f'ERROR: Invalid value "{field_value}" for checkbox field "{field_id}". The checked value is "{checked_val}" and the unchecked value is "{unchecked_val}"'
    elif field_type == "radio_group":
        option_values = [opt["value"] for opt in field_info["radio_options"]]
        if field_value not in option_values:
            return f'ERROR: Invalid value "{field_value}" for radio group field "{field_id}". Valid values are: {option_values}'
    elif field_type == "choice":
        choice_values = [opt["value"] for opt in field_info["choice_options"]]
        if field_value not in choice_values:
            return f'ERROR: Invalid value "{field_value}" for choice field "{field_id}". Valid values are: {choice_values}'
    return None


def _monkeypatch_pypdf_method():
    """
    Workaround for pypdf bug with selection list fields.
    pypdf's get_inherited returns a list of two-element lists for /Opt fields
    in selection lists, causing join() to throw TypeError. We patch it to
    return just the value strings.
    """
    from pypdf.constants import FieldDictionaryAttributes
    from pypdf.generic import DictionaryObject

    original_get_inherited = DictionaryObject.get_inherited

    def patched_get_inherited(self, key: str, default=None):
        result = original_get_inherited(self, key, default)
        if key == FieldDictionaryAttributes.Opt:
            if isinstance(result, list) and all(isinstance(v, list) and len(v) == 2 for v in result):
                result = [r[0] for r in result]
        return result

    DictionaryObject.get_inherited = patched_get_inherited


@cmd("form.fill-legacy")
def form_fill_legacy(argv: list):
    """Fill fillable form fields (pypdf version with monkeypatch)."""
    if len(argv) < 3:
        Output.error("MissingArg", "Usage: form.fill-legacy <pdf> <fields.json> <output.pdf>")
    input_pdf = argv[0]
    fields_json = argv[1]
    output_pdf = argv[2]

    from pypdf import PdfReader, PdfWriter

    _monkeypatch_pypdf_method()

    with open(fields_json) as f:
        fields = json.load(f)

    # Group by page number
    fields_by_page: dict[int, dict] = {}
    for field in fields:
        if "value" in field:
            field_id = field["field_id"]
            page = field["page"]
            if page not in fields_by_page:
                fields_by_page[page] = {}
            fields_by_page[page][field_id] = field["value"]

    reader = PdfReader(input_pdf)

    has_error = False
    field_info = _get_field_info(reader)
    fields_by_ids = {f["field_id"]: f for f in field_info}
    for field in fields:
        existing_field = fields_by_ids.get(field["field_id"])
        if not existing_field:
            has_error = True
            print(f"ERROR: `{field['field_id']}` is not a valid field ID")
        elif field["page"] != existing_field["page"]:
            has_error = True
            print(f"ERROR: Incorrect page number for `{field['field_id']}` (got {field['page']}, expected {existing_field['page']})")
        else:
            if "value" in field:
                err = _validation_error_for_field_value(existing_field, field["value"])
                if err:
                    print(err)
                    has_error = True
    if has_error:
        raise SystemExit(1)

    writer = PdfWriter(clone_from=reader)
    for page, field_values in fields_by_page.items():
        writer.update_page_form_field_values(writer.pages[page - 1], field_values, auto_regenerate=False)

    writer.set_need_appearances_writer(True)

    with open(output_pdf, "wb") as f:
        writer.write(f)

    print(f"Filled {len(fields_by_page)} page(s) in {output_pdf}")
    raise SystemExit(0)


# --- form.annotate (annotation-based filling with coordinate transform) ---

def _transform_coordinates(bbox, image_width, image_height, pdf_width, pdf_height):
    """Transform bounding box from image coordinates to PDF coordinates."""
    x_scale = pdf_width / image_width
    y_scale = pdf_height / image_height

    left = bbox[0] * x_scale
    right = bbox[2] * x_scale

    # Flip Y coordinates for PDF
    top = pdf_height - (bbox[1] * y_scale)
    bottom = pdf_height - (bbox[3] * y_scale)

    return left, bottom, right, top


def _normalise_fields_json(raw: dict) -> dict:
    """Accept both the current sheet-based schema and the legacy flat schema.

    Current (v2) schema uses ``sheet[].pg/dims/regions[]`` with nested
    ``label.bbox``, ``target.bbox``, ``ink{}``.

    Legacy (v1) schema uses ``pages[]`` + ``form_fields[]`` with flat keys
    like ``entry_bounding_box``, ``label_bounding_box``, ``entry_text{}``.

    Returns a normalised dict in the **v2** internal format used by all
    downstream functions.
    """
    # Already v2
    if "sheet" in raw:
        return raw

    # Convert legacy → v2
    pages_lut = {p["page_number"]: p for p in raw.get("pages", [])}
    sheets: dict = {}  # pg -> sheet entry

    for f in raw.get("form_fields", []):
        pg = f["page_number"]
        if pg not in sheets:
            pi = pages_lut.get(pg, {})
            sheets[pg] = {
                "pg": pg,
                "dims": [pi.get("image_width", 0), pi.get("image_height", 0)],
                "regions": [],
            }
        et = f.get("entry_text", {})
        region = {
            "id": f.get("field_label", f.get("description", "")),
            "hint": f.get("description", ""),
            "label": {"tag": f.get("field_label", ""), "bbox": f.get("label_bounding_box", [0, 0, 0, 0])},
            "target": {"bbox": f.get("entry_bounding_box", [0, 0, 0, 0])},
            "ink": {},
        }
        if isinstance(et, dict) and et.get("text"):
            region["ink"]["value"] = et["text"]
            if "font_size" in et:
                region["ink"]["size"] = et["font_size"]
            if "font_color" in et:
                region["ink"]["color"] = et["font_color"]
            if "font" in et:
                region["ink"]["font"] = et["font"]
        sheets[pg]["regions"].append(region)

    return {"sheet": list(sheets.values())}


@cmd("form.annotate")
def form_annotate(argv: list):
    """Fill a PDF by adding text annotations (FreeText) defined in fields.json."""
    if len(argv) < 3:
        Output.error("MissingArg", "Usage: form.annotate <pdf> <fields.json> <output.pdf>")
    input_pdf = argv[0]
    fields_json_path = argv[1]
    output_pdf = argv[2]

    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import FreeText

    with open(fields_json_path) as f:
        fields_data = _normalise_fields_json(json.load(f))

    reader = PdfReader(input_pdf)
    writer = PdfWriter()
    writer.append(reader)

    # Get PDF dimensions for each page
    pdf_dimensions = {}
    for i, page in enumerate(reader.pages):
        mediabox = page.mediabox
        pdf_dimensions[i + 1] = [mediabox.width, mediabox.height]

    annotations = []
    for page_entry in fields_data["sheet"]:
        pg = page_entry["pg"]
        image_width, image_height = page_entry["dims"]
        pdf_width, pdf_height = pdf_dimensions[pg]

        for region in page_entry["regions"]:
            ink = region.get("ink", {})
            text = ink.get("value", "")
            if not text:
                continue

            transformed_box = _transform_coordinates(
                region["target"]["bbox"],
                image_width, image_height,
                pdf_width, pdf_height
            )

            font_name = ink.get("font", "Arial")
            font_size = str(ink.get("size", 14)) + "pt"
            font_color = ink.get("color", "000000")

            annotation = FreeText(
                text=text,
                rect=transformed_box,
                font=font_name,
                font_size=font_size,
                font_color=font_color,
                border_color=None,
                background_color=None,
            )
            annotations.append(annotation)
            writer.add_annotation(page_number=pg - 1, annotation=annotation)

    with open(output_pdf, "wb") as output:
        writer.write(output)

    print(f"Successfully filled PDF form and saved to {output_pdf}")
    print(f"Added {len(annotations)} text annotations")
    raise SystemExit(0)


# --- form.render (PDF to PNG images) ---

@cmd("form.render")
def form_render(argv: list):
    """Convert each page of a PDF to a PNG image."""
    if len(argv) < 2:
        Output.error("MissingArg", "Usage: form.render <pdf> <output_dir> [--max-dim N]")
    pdf_path = argv.pop(0)
    output_dir = argv.pop(0)
    max_dim_str = _pop_flag(argv, "-m", "--max-dim")
    max_dim = int(max_dim_str) if max_dim_str else 1000

    from pdf2image import convert_from_path

    os.makedirs(output_dir, exist_ok=True)
    images = convert_from_path(pdf_path, dpi=200)

    for i, image in enumerate(images):
        width, height = image.size
        if width > max_dim or height > max_dim:
            scale_factor = min(max_dim / width, max_dim / height)
            new_width = int(width * scale_factor)
            new_height = int(height * scale_factor)
            image = image.resize((new_width, new_height))

        image_path = os.path.join(output_dir, f"page_{i+1}.png")
        image.save(image_path)
        print(f"Saved page {i+1} as {image_path} (size: {image.size})")

    print(f"Converted {len(images)} pages to PNG images")
    raise SystemExit(0)


# --- form.validate (bounding box validation image) ---

@cmd("form.validate")
def form_validate(argv: list):
    """Create validation images with bounding box rectangles."""
    if len(argv) < 4:
        Output.error("MissingArg", "Usage: form.validate <page> <fields.json> <input_img> <output_img>")
    page_number = int(argv[0])
    fields_json_path = argv[1]
    input_path = argv[2]
    output_path = argv[3]

    from PIL import Image, ImageDraw

    with open(fields_json_path) as f:
        data = _normalise_fields_json(json.load(f))

    img = Image.open(input_path)
    draw = ImageDraw.Draw(img)
    num_boxes = 0

    for page_entry in data["sheet"]:
        if page_entry["pg"] != page_number:
            continue
        for region in page_entry["regions"]:
            target_box = region["target"]["bbox"]
            label_box = region["label"]["bbox"]
            draw.rectangle(target_box, outline='red', width=2)
            draw.rectangle(label_box, outline='blue', width=2)
            num_boxes += 2

    img.save(output_path)
    print(f"Created validation image at {output_path} with {num_boxes} bounding boxes")
    raise SystemExit(0)


# --- form.check-bbox (bounding box overlap detection) ---

@dataclass
class _RectAndField:
    rect: list
    rect_type: str
    field: dict


def get_bounding_box_messages(fields_json_stream) -> list[str]:
    """Check for overlapping bounding boxes. Returns list of messages (max 20)."""
    messages = []
    raw = json.load(fields_json_stream)
    data = _normalise_fields_json(raw)

    total_regions = sum(len(pe["regions"]) for pe in data["sheet"])
    messages.append(f"Read {total_regions} regions across {len(data['sheet'])} page(s)")

    def rects_intersect(r1, r2):
        disjoint_horizontal = r1[0] >= r2[2] or r1[2] <= r2[0]
        disjoint_vertical = r1[1] >= r2[3] or r1[3] <= r2[1]
        return not (disjoint_horizontal or disjoint_vertical)

    has_error = False

    for page_entry in data["sheet"]:
        pg = page_entry["pg"]
        # Collect all rects on this page
        rects_and_regions = []
        for region in page_entry["regions"]:
            rects_and_regions.append(_RectAndField(region["label"]["bbox"], "label", region))
            rects_and_regions.append(_RectAndField(region["target"]["bbox"], "target", region))

        for i, ri in enumerate(rects_and_regions):
            for j in range(i + 1, len(rects_and_regions)):
                rj = rects_and_regions[j]
                if rects_intersect(ri.rect, rj.rect):
                    has_error = True
                    rid = ri.field.get("id", ri.field.get("hint", "?"))
                    rjd = rj.field.get("id", rj.field.get("hint", "?"))
                    if ri.field is rj.field:
                        messages.append(f"FAILURE: pg {pg} — label/target overlap for `{rid}` ({ri.rect}, {rj.rect})")
                    else:
                        messages.append(f"FAILURE: pg {pg} — {ri.rect_type} of `{rid}` ({ri.rect}) overlaps {rj.rect_type} of `{rjd}` ({rj.rect})")
                    if len(messages) >= 20:
                        messages.append("Aborting further checks; fix bounding boxes and try again")
                        return messages

            # Height check for target rects
            if ri.rect_type == "target":
                ink = ri.field.get("ink", {})
                if ink.get("value"):
                    font_size = ink.get("size", 14)
                    entry_height = ri.rect[3] - ri.rect[1]
                    if entry_height < font_size:
                        has_error = True
                        rid = ri.field.get("id", ri.field.get("hint", "?"))
                        messages.append(f"FAILURE: pg {pg} — target box height ({entry_height}) for `{rid}` is shorter than font size ({font_size}). Increase box height or decrease ink.size.")
                        if len(messages) >= 20:
                            messages.append("Aborting further checks; fix bounding boxes and try again")
                            return messages

    if not has_error:
        messages.append("SUCCESS: All bounding boxes are valid")
    return messages


@cmd("form.check-bbox")
def form_check_bbox(argv: list):
    """Check bounding boxes in fields.json for overlaps."""
    if not argv:
        Output.error("MissingArg", "Usage: form.check-bbox <fields.json>")
    with open(argv[0]) as f:
        messages = get_bounding_box_messages(f)
    for msg in messages:
        print(msg)
    raise SystemExit(0)


# ═══════════════════════════════════════════════════════════════
#  Section 6: convert — office, HTML, and LaTeX
# ═══════════════════════════════════════════════════════════════

_CONVERTIBLE_EXTENSIONS = frozenset({
    ".docx", ".doc", ".odt", ".rtf",
    ".pptx", ".ppt", ".odp",
    ".xlsx", ".xls", ".ods", ".csv",
    ".txt", ".html", ".htm",
})

async def _convert_office_with_runtime(src: Path, final: Path):
    await asyncio.to_thread(final.parent.mkdir, parents=True, exist_ok=True)
    async with conversion_directory(final.parent) as temporary:
        produced = temporary / (src.stem + '.pdf')
        result = await run_libreoffice(['--convert-to', 'pdf', '--outdir', str(temporary), str(src)], timeout=120, temporary_outputs=[produced])
        # 原实现会把同名旧 PDF 当成本轮成果；独立输出目录只接纳本次新生成的文件。
        def verify_output():
            with produced.open('rb') as output:
                if output.read(5) != b'%PDF-':
                    raise LibreOfficeInvocationError('Converted file is not a PDF')
        await asyncio.to_thread(verify_output)
        await asyncio.to_thread(os.replace, produced, final)
        return result


@cmd("convert.office")
def convert_office(argv: list):
    """Convert an office document to PDF via LibreOffice."""
    if not argv:
        Output.error("MissingArg", "input file required")
    src_path = argv.pop(0)
    out_path = _pop_flag(argv, "-o", "--output")

    src = Output.check_file(src_path)
    ext = src.suffix.lower()

    if ext not in _CONVERTIBLE_EXTENSIONS:
        Output.error(
            "UnsupportedFormat",
            f"Unsupported format: {ext}",
            hint=f"Supported formats: {', '.join(sorted(_CONVERTIBLE_EXTENSIONS))}",
        )

    final = Path(out_path).resolve() if out_path else src.with_suffix('.pdf').resolve()
    # 转换只生成交付副本；输出路径指向输入时必须在执行前拒绝。
    if final == src.resolve():
        Output.error('OutputOverwritesInput', 'PDF output must differ from the input document', code=4)
    try:
        result = run_cli_operation(_convert_office_with_runtime(src.resolve(), final))
    except asyncio.CancelledError as error:
        raise SystemExit(143 if error.args == ('SIGTERM',) else 130) from None
    except LibreOfficeUnavailable as error:
        Output.error('DependencyMissing', str(error), code=error.exit_code)
    except LibreOfficeInvocationError as error:
        # 统一入口的执行超时仍沿用 PDF CLI 的 Timeout 错误类型。
        Output.error('Timeout' if error.exit_code == 124 else 'ConvertError', str(error), code=4)
    except (OSError, ValueError) as error:
        Output.error('ConvertError', str(error), code=4)
    if result.stderr:
        print(result.stderr, file=sys.stderr, end='' if result.stderr.endswith('\n') else '\n')
    Output.success({'input': str(src), 'output': str(final), 'format': ext, 'libreoffice_source': result.source})


@cmd("convert.html")
def convert_html(argv: list):
    """Convert HTML to PDF via node html2pdf.js."""
    if not argv:
        Output.error("MissingArg", "input file required")

    js_path = _SCRIPT_DIR / "html2pdf.js"
    if not js_path.exists():
        Output.error("DependencyMissing", "html2pdf.js not found in scripts directory")

    node_path = _find_node()
    if not node_path:
        Output.error("DependencyMissing", "node not found in PATH")

    cmd_list = [node_path, str(js_path)] + argv
    try:
        proc = subprocess.run(cmd_list, timeout=180)
        raise SystemExit(proc.returncode)
    except subprocess.TimeoutExpired:
        Output.error("Timeout", "HTML conversion timeout (>180s)", code=4)
    except SystemExit:
        raise
    except Exception as exc:
        Output.error("ConvertError", f"HTML conversion failed: {exc}", code=4)


# --- convert.latex (tectonic wrapper with log filtering + PDF stats) ---

_NOISE_RE = re.compile(
    r"^note: (?:"
    r'"version 2" Tectonic'
    r"|Running TeX"
    r"|Rerunning TeX because"
    r"|Running xdvipdfmx"
    r"|downloading "
    r"|Skipped writing .* intermediate files"
    r")"
)


def _find_tectonic() -> str | None:
    """Locate the tectonic binary.

    Search order:
      1. scripts/ dir  (bundled binary — macOS arm64 only)
      2. ~/tectonic     (user-placed binary)
      3. System PATH    (package-manager install)

    NOTE: The bundled binary at scripts/tectonic is a macOS arm64 (Apple
    Silicon) Mach-O executable.  It will NOT run on Linux or Windows.
    On other platforms, install tectonic via the system package manager
    or download the correct binary — see the error message in
    convert_latex() for instructions.
    """
    local_bin = _SCRIPT_DIR / "tectonic"
    if local_bin.exists() and os.access(local_bin, os.X_OK):
        return str(local_bin)
    home_bin = Path.home() / "tectonic"
    if home_bin.exists() and os.access(home_bin, os.X_OK):
        return str(home_bin)
    system_bin = shutil.which("tectonic")
    return system_bin


def _human_size(nbytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024:
            return f"{nbytes:.2f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.2f} TB"


def _pdf_stats(pdf_file: Path):
    """Return (pages, word_count, image_count) or Nones."""
    try:
        from pypdf import PdfReader
    except ImportError:
        for attempt in (
            [sys.executable, "-m", "pip", "install", "-q", "pypdf"],
            [sys.executable, "-m", "pip", "install", "-q", "--break-system-packages", "pypdf"],
            [sys.executable, "-m", "pip", "install", "-q", "--user", "pypdf"],
        ):
            if subprocess.run(attempt, check=False, capture_output=True).returncode == 0:
                break
        try:
            from pypdf import PdfReader
        except ImportError:
            return None, None, None

    try:
        reader = PdfReader(str(pdf_file))
        n_pages = len(reader.pages)
        all_text = "".join(p.extract_text() or "" for p in reader.pages)
        n_words = len([w for w in all_text.split() if w.strip()])
        n_images = 0
        for pg in reader.pages:
            xobj = pg.get("/Resources", {}).get("/XObject")
            if xobj:
                obj = xobj.get_object()
                n_images += sum(1 for k in obj if obj[k].get("/Subtype") == "/Image")
        return n_pages, n_words, n_images
    except Exception as exc:
        print(f"Error extracting PDF info: {exc}", file=sys.stderr)
        return None, None, None


def _classify_lines(lines):
    """Bucket raw output into errors / warnings / layout issues."""
    errors, warnings, layout, pdf_note = [], [], [], None
    for raw in lines:
        ln = raw.rstrip()
        if not ln:
            continue
        if _NOISE_RE.match(ln):
            if ln.startswith("note: Writing"):
                pdf_note = ln
            continue
        if ln.startswith("error:"):
            errors.append(ln)
        elif ln.startswith("warning:"):
            warnings.append(ln)
        elif re.search(r"(Overfull|Underfull) \\[hv]box", ln) or re.search(r"(Font shape|Missing character)", ln):
            layout.append(ln)
    return errors, warnings, layout, pdf_note


def _parse_writing_note(note: str | None):
    m = re.search(r"Writing `(.+?)` \((.+?)\)", note or "")
    return (m.group(1), m.group(2)) if m else (None, None)


@cmd("convert.blueprint")
def convert_blueprint(argv: list):
    """
    [Auto-Pipeline] Extract JSON blueprint from LLM markdown response,
    compile it to HTML via design_engine, and render to PDF.
    """
    if not argv:
        Output.error("MissingArg", "Usage: convert.blueprint <llm_response_file.md> [-o <out.pdf>]")

    input_file = argv.pop(0)
    out_pdf = _pop_flag(argv, "-o", "--output") or "output.pdf"

    src = Output.check_file(input_file)
    content = src.read_text(encoding="utf-8")

    # 1. Smart JSON extraction (regardless of whether LLM wrapped in Markdown code blocks)
    match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
    if match:
        json_str = match.group(1)
    else:
        # Fallback: Assume the file is pure JSON
        json_str = content

    try:
        # Validate JSON format
        parsed_json = json.loads(json_str)
    except json.JSONDecodeError as e:
        Output.error("InvalidJSON", f"Failed to parse JSON blueprint: {e}", hint="Ensure the LLM output is valid JSON without trailing commas.")

    # 1b. Encoding integrity check — detect corrupted characters before rendering
    corruption_found = False
    def _scan_for_corruption(obj, path=""):
        """Recursively scan JSON values for encoding corruption markers."""
        nonlocal corruption_found
        if isinstance(obj, str):
            for i, ch in enumerate(obj):
                if ch == '\ufffd':  # Unicode replacement character
                    context = obj[max(0, i-10):i+10]
                    print(f"  \u26a0\ufe0f  U+FFFD at {path}[{i}]: ...{context}...")
                    corruption_found = True
                elif '\ud800' <= ch <= '\udfff':  # Lone surrogate
                    print(f"  \u26a0\ufe0f  Lone surrogate U+{ord(ch):04X} at {path}[{i}]")
                    corruption_found = True
        elif isinstance(obj, dict):
            for k, v in obj.items():
                _scan_for_corruption(v, f"{path}.{k}")
        elif isinstance(obj, list):
            for idx, v in enumerate(obj):
                _scan_for_corruption(v, f"{path}[{idx}]")

    _scan_for_corruption(parsed_json)
    if corruption_found:
        print("\n\u26a0\ufe0f  WARNING: Corrupted characters detected in blueprint content!")
        print("   These will render as \ufffd (replacement character) in the PDF.")
        print("   Consider fixing the source text and re-running.\n")

    # Also sanitize: replace U+FFFD with empty string to avoid visible corruption
    json_str_clean = json_str.replace('\ufffd', '')
    if json_str_clean != json_str:
        json_str = json_str_clean
        print("   \u2139\ufe0f  Auto-removed U+FFFD characters from blueprint.")

    # 2. Save clean JSON blueprint and temp HTML path
    blueprint_path = src.parent / f"{src.stem}_pure_blueprint.json"
    html_path = src.parent / f"{src.stem}_rendered.html"
    blueprint_path.write_text(json_str, encoding="utf-8")

    # 3. Call design_engine.py to compile HTML
    engine_script = _SCRIPT_DIR / "design_engine.py"
    print("🎨 [1/2] Compiling JSON Blueprint to Art-Directed HTML...", flush=True)
    try:
        subprocess.run([
            sys.executable, str(engine_script), "compile",
            "--blueprint", str(blueprint_path),
            "--output", str(html_path)
        ], check=True)
    except subprocess.CalledProcessError:
        Output.error("CompileError", "design_engine.py failed to compile the blueprint.", code=4)

    # 4. Call html2pdf.js to render PDF
    print("📄 [2/2] Rendering HTML to High-Res PDF via Playwright...", flush=True)
    js_script = _SCRIPT_DIR / "html2pdf.js"
    node_path = _find_node()
    if not node_path:
        Output.error("DependencyMissing", "node not found in PATH")

    try:
        subprocess.run([
            node_path, str(js_script), str(html_path), "-o", out_pdf,
            "--width", "720px", "--height", "960px"
        ], check=True)
    except subprocess.CalledProcessError:
        Output.error("RenderError", "html2pdf.js failed to render the PDF.", code=4)

    print(f"\n🎉 Success! Masterpiece generated at: {out_pdf}")
    raise SystemExit(0)


@cmd("convert.latex")
def convert_latex(argv: list):
    """Compile LaTeX file via tectonic, filter logs, report PDF stats."""
    if not argv:
        Output.error("MissingArg", "tex file required")
    tex_file = argv.pop(0)
    runs_str = _pop_flag(argv, "-r", "--runs")
    runs = int(runs_str) if runs_str else 1
    keep_logs = _pop_flag(argv, "-k", "--keep-logs", needs_value=False)

    tex = Path(tex_file)
    if not tex.exists():
        print(f"\u2717 Error: File not found {tex_file}")
        raise SystemExit(1)

    print(f"Compiling {tex.name}...", flush=True)
    if runs > 1:
        print(f"Running {runs} passes (for cross-references)", flush=True)

    tectonic = _find_tectonic()
    if tectonic is None:
        import platform
        print("\n\u2717 Error: tectonic command not found")
        print()
        print("The bundled scripts/tectonic binary is macOS arm64 only.")
        print("Install tectonic for your platform:\n")
        sys_name = platform.system()
        if sys_name == "Darwin":
            print("  macOS (Homebrew):  brew install tectonic")
            print("  macOS (binary):    curl -sSL https://drop-sh.fullyjustified.net | sh")
            print("                     mv tectonic ~/tectonic && chmod +x ~/tectonic")
        elif sys_name == "Linux":
            print("  Debian/Ubuntu:     apt install tectonic         (if available)")
            print("  Arch Linux:        pacman -S tectonic")
            print("  Conda:             conda install -c conda-forge tectonic")
            print("  Binary download:   curl -sSL https://drop-sh.fullyjustified.net | sh")
            print("                     mv tectonic ~/tectonic && chmod +x ~/tectonic")
        elif sys_name == "Windows":
            print("  Windows (scoop):   scoop install tectonic")
            print("  Windows (choco):   choco install tectonic")
            print("  Conda:             conda install -c conda-forge tectonic")
        else:
            print("  See: https://tectonic-typesetting.github.io/")
        print()
        print("After installing, verify with: tectonic --version")
        print()
        print("Quick check — is tectonic already installed somewhere?")
        print(f"  which tectonic:    {shutil.which('tectonic') or 'not found'}")
        print(f"  ~/tectonic:        {'exists' if (Path.home() / 'tectonic').exists() else 'not found'}")
        print(f"  scripts/tectonic:  {'exists' if (_SCRIPT_DIR / 'tectonic').exists() else 'not found'}")
        print(f"  Platform:          {sys_name} {platform.machine()}")
        raise SystemExit(1)

    all_lines = []
    ok = False
    for _ in range(runs):
        try:
            proc = subprocess.run(
                [tectonic, "-X", "compile", str(tex)],
                capture_output=True, text=True, timeout=120,
            )
            all_lines.extend((proc.stdout + proc.stderr).splitlines())
            ok = proc.returncode == 0
            if not ok:
                break
        except subprocess.TimeoutExpired:
            print("\n\u2717 Error: Compilation timeout (>2 minutes)")
            raise SystemExit(1)
        except Exception as exc:
            print(f"\n\u2717 Error: {exc}")
            raise SystemExit(1)

    if keep_logs:
        print("\n" + "=" * 50 + "\nFull logs:\n" + "=" * 50)
        for ln in all_lines:
            print(ln)
        print("=" * 50 + "\n")

    errors, warnings, layout, pdf_note = _classify_lines(all_lines)
    noted_name, noted_size = _parse_writing_note(pdf_note)
    pdf_name = noted_name or (tex.stem + ".pdf")
    pdf_path = tex.parent / pdf_name

    print()
    if ok:
        tag = "\u2713 Compilation successful" + (" (with warnings)" if warnings or layout else "")
        print(tag)
    else:
        print("\u2717 Compilation failed")

    if ok and pdf_path.exists():
        print("\n========================\nPDF Information\n========================")
        print(f"File: {pdf_name}")
        print(f"Size: {noted_size or _human_size(pdf_path.stat().st_size)}")
        pages, words, images = _pdf_stats(pdf_path)
        if pages is not None:
            print(f"Pages: {pages}")
        if words is not None:
            print(f"Words: ~{words:,}")
        if images is not None:
            print(f"Images: {images}")

    if layout:
        print(f"\n========================\nLayout Issues ({len(layout)})\n========================")
        for ln in layout:
            print(ln)

    if warnings:
        print(f"\n========================\nWarnings ({len(warnings)})\n========================")
        for ln in warnings:
            print(ln.replace("warning: ", "", 1))

    if errors:
        print("\n========================\nErrors\n========================")
        for ln in errors:
            print(ln.replace("error: ", "", 1))

    if ok and (layout or warnings):
        print()
        print("<system-reminder>")
        print(f"Detected {len(layout)} layout issues and {len(warnings)} warnings.")
        print("These issues affect PDF typesetting quality and must be fixed.")
        print("Do not dismiss with 'warnings don't affect output'. Fix all issues.")
        print("</system-reminder>")

    raise SystemExit(0 if ok else 1)


# ═══════════════════════════════════════════════════════════════
#  Section 7b: Font Fallback Engine — automatic <font> wrapping
# ═══════════════════════════════════════════════════════════════

# -- Data structures --------------------------------------------------------

FONT_FALLBACK_CHAIN: dict[str, list[str]] = {
    "Times New Roman": ["SimHei"],
    "Calibri":         ["SimHei"],
    "DejaVuSans":      ["SimHei"],
    "SimHei":          ["Times New Roman"],
    "Microsoft YaHei": ["Times New Roman"],
}

FONT_PREFER_RANGES: dict[str, list[tuple[int, int, str]]] = {
    "SimHei": [
        (0x0400, 0x04FF, "Times New Roman"),   # Cyrillic
        (0x0500, 0x052F, "Times New Roman"),   # Cyrillic Supplement
    ],
    "Microsoft YaHei": [
        (0x0400, 0x04FF, "Times New Roman"),
        (0x0500, 0x052F, "Times New Roman"),
    ],
}

# -- Content sanitization (runtime, pre-font-fallback) ----------------------

# Control: global switches
CONTENT_SANITIZE_ENABLED = True   # master switch
CONTENT_SANITIZE_STRIP_ZW = True  # zero-width chars (disable for Thai/Burmese/Hindi)

# Fullwidth ASCII → halfwidth (letters + digits only, NOT punctuation)
_FULLWIDTH_OFFSET = 0xFEE0  # ord('Ａ') - ord('A') == 0xFEE0

# Ligature decomposition (U+FB00–FB06)
_LIGATURE_MAP: dict[int, str] = {
    0xFB00: "ff",
    0xFB01: "fi",
    0xFB02: "fl",
    0xFB03: "ffi",
    0xFB04: "ffl",
    0xFB05: "st",   # ﬅ long s t
    0xFB06: "st",   # ﬆ st
}

# Zero-width / invisible characters to strip
_ZERO_WIDTH_CHARS: set[int] = {
    0x200B,  # ZERO WIDTH SPACE
    0x200C,  # ZERO WIDTH NON-JOINER
    0x200D,  # ZERO WIDTH JOINER
    0x2060,  # WORD JOINER
    0xFEFF,  # BOM (when not at file start)
    0x034F,  # COMBINING GRAPHEME JOINER
}

# Bidirectional control characters to strip
_BIDI_CONTROLS: set[int] = {
    0x200E, 0x200F,          # LRM, RLM
    0x202A, 0x202B, 0x202C,  # LRE, RLE, PDF
    0x202D, 0x202E,          # LRO, RLO
    0x2066, 0x2067, 0x2068, 0x2069,  # LRI, RLI, FSI, PDI
}

# Variation selectors to strip (emoji style modifiers)
_VARIATION_SELECTORS: set[int] = set(range(0xFE00, 0xFE10))  # U+FE00–FE0F

# Unicode noncharacters (should never appear in text interchange)
_NONCHARACTERS: set[int] = set(range(0xFDD0, 0xFDF0))  # U+FDD0–FDEF
_NONCHARACTERS.add(0xFFFE)
_NONCHARACTERS.add(0xFFFF)

_content_sanitize_warnings: list[str] = []


def content_sanitize(text: str, dry_run: bool = False) -> str:
    """Sanitize Paragraph text content before font fallback.

    Removes/replaces characters that should not appear in final PDF output.
    Designed for CJK + Latin content. Does NOT touch XML/HTML tags in the text.

    Args:
        text: Raw Paragraph text (may contain ReportLab XML tags like <b>, <font>).
        dry_run: If True, collect warnings but still return cleaned text.

    Returns:
        Cleaned text string.
    """
    if not CONTENT_SANITIZE_ENABLED or not text:
        return text

    global _content_sanitize_warnings
    if dry_run:
        _content_sanitize_warnings = []

    # Split text into tags and plain-text segments to avoid mangling XML tags
    # e.g. '<font name="SimHei">你好</font>' → ['', '<font name="SimHei">', '你好', '</font>', '']
    parts = _TAG_RE.split(text)
    tags = _TAG_RE.findall(text)

    out_pieces: list[str] = []

    for i, part in enumerate(parts):
        if part:
            # Process plain text segment character by character
            cleaned: list[str] = []
            for ch in part:
                code = ord(ch)
                replacement = _sanitize_one_char(ch, code, dry_run)
                if replacement is not None:
                    cleaned.append(replacement)
                # else: character was deleted
            out_pieces.append("".join(cleaned))

        # Append the tag that follows this part (if any)
        if i < len(tags):
            out_pieces.append(tags[i])  # tags pass through untouched

    return "".join(out_pieces)


def _sanitize_one_char(ch: str, code: int, dry_run: bool) -> str | None:
    """Process a single character. Returns replacement string, or None to delete."""

    # --- DELETE: ASCII control characters (except \t \n \r) ---
    if code <= 0x1F and ch not in '\t\n\r':
        if dry_run:
            _content_sanitize_warnings.append(
                f"DELETE control char U+{code:04X} ({repr(ch)})")
        return None

    # --- DELETE: U+007F DEL ---
    if code == 0x7F:
        return None

    # --- DELETE: zero-width characters ---
    if CONTENT_SANITIZE_STRIP_ZW and code in _ZERO_WIDTH_CHARS:
        if dry_run:
            _content_sanitize_warnings.append(
                f"DELETE zero-width U+{code:04X}")
        return None

    # --- DELETE: bidirectional controls ---
    if code in _BIDI_CONTROLS:
        if dry_run:
            _content_sanitize_warnings.append(
                f"DELETE bidi control U+{code:04X}")
        return None

    # --- DELETE: variation selectors ---
    if code in _VARIATION_SELECTORS:
        if dry_run:
            _content_sanitize_warnings.append(
                f"DELETE variation selector U+{code:04X}")
        return None

    # --- DELETE: Unicode noncharacters ---
    if code in _NONCHARACTERS:
        return None

    # --- REPLACE: U+FFFD replacement character → '?' ---
    if code == 0xFFFD:
        if dry_run:
            _content_sanitize_warnings.append(
                "REPLACE U+FFFD (upstream encoding error) → '?'")
        return '?'

    # --- REPLACE: fullwidth ASCII letters/digits → halfwidth ---
    # U+FF21–FF3A = Ａ–Ｚ, U+FF41–FF5A = ａ–ｚ, U+FF10–FF19 = ０–９
    if 0xFF21 <= code <= 0xFF3A or 0xFF41 <= code <= 0xFF5A or 0xFF10 <= code <= 0xFF19:
        halfwidth = chr(code - _FULLWIDTH_OFFSET)
        if dry_run:
            _content_sanitize_warnings.append(
                f"REPLACE fullwidth '{ch}' → halfwidth '{halfwidth}'")
        return halfwidth

    # --- REPLACE: ligatures → decomposed ---
    if code in _LIGATURE_MAP:
        decomposed = _LIGATURE_MAP[code]
        if dry_run:
            _content_sanitize_warnings.append(
                f"REPLACE ligature '{ch}' (U+{code:04X}) → '{decomposed}'")
        return decomposed

    # --- REPLACE: line/paragraph separators → newline ---
    if code == 0x2028 or code == 0x2029:
        if dry_run:
            _content_sanitize_warnings.append(
                f"REPLACE U+{code:04X} separator → '\\n'")
        return '\n'

    # --- REPLACE: soft hyphen → empty (invisible, ReportLab ignores it) ---
    if code == 0x00AD:
        return None

    # --- WARN (pass through): Private Use Area ---
    if 0xE000 <= code <= 0xF8FF:
        if dry_run:
            _content_sanitize_warnings.append(
                f"WARN Private Use Area U+{code:04X} (passed through)")
        return ch

    # --- PASS: everything else ---
    return ch


# -- Glyph detection -------------------------------------------------------

_glyph_cache: dict[tuple[str, int], bool] = {}


def _has_glyph(font_name: str, code: int) -> bool:
    """Check whether *font_name* has a real glyph outline for *code*."""
    key = (font_name, code)
    if key in _glyph_cache:
        return _glyph_cache[key]
    try:
        from reportlab.pdfbase import pdfmetrics
        font = pdfmetrics.getFont(font_name)
        result = code in font.face.charToGlyph
    except Exception:
        result = False
    _glyph_cache[key] = result
    return result


def _best_font_for_char(code: int, base_font: str) -> str:
    """Return the best registered font for a single character *code*."""
    # ASCII fast path
    if code < 128:
        return base_font

    # Aesthetic preference ranges
    for rng_start, rng_end, preferred in FONT_PREFER_RANGES.get(base_font, []):
        if rng_start <= code <= rng_end:
            if _has_glyph(preferred, code):
                return preferred

    # Base font has the glyph — use it
    if _has_glyph(base_font, code):
        return base_font

    # Walk the fallback chain
    for fb in FONT_FALLBACK_CHAIN.get(base_font, []):
        if _has_glyph(fb, code):
            return fb

    # Nothing found — return base_font (will render □ but won't crash)
    return base_font


# -- Text-level automatic <font> wrapping ----------------------------------

_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")


def font_fallback(text: str, base_font: str) -> str:
    """Wrap characters that *base_font* cannot render with ``<font>`` tags.

    Preserves existing XML tags (``<b>``, ``<font>``, ``<super>``, etc.).
    Returns the transformed markup string.
    """
    if not text:
        return text

    # Split text into (plain, tag, plain, tag, ...) segments
    parts = _TAG_RE.split(text)
    tags = _TAG_RE.findall(text)

    # Track <font> nesting so we don't re-wrap inside explicit <font>
    font_stack: list[str] = []
    out_pieces: list[str] = []

    for i, part in enumerate(parts):
        # Determine effective font at this point
        effective = font_stack[-1] if font_stack else base_font

        if part:
            # Process plain text character by character
            runs: list[tuple[str, list[str]]] = []
            for ch in part:
                code = ord(ch)
                best = _best_font_for_char(code, effective)
                if runs and runs[-1][0] == best:
                    runs[-1][1].append(ch)
                else:
                    runs.append((best, [ch]))

            for font_name, chars in runs:
                segment = "".join(chars)
                if font_name == effective:
                    out_pieces.append(segment)
                else:
                    out_pieces.append(f'<font name="{font_name}">{segment}</font>')

        # Append the tag that follows this part (if any)
        if i < len(tags):
            tag = tags[i]
            out_pieces.append(tag)
            # Track font stack
            tag_lower = tag.lower()
            if tag_lower.startswith("<font "):
                # Extract font name from tag
                m = re.search(r'name\s*=\s*["\']([^"\']+)["\']', tag, re.IGNORECASE)
                if m:
                    font_stack.append(m.group(1))
                else:
                    font_stack.append(effective)
            elif tag_lower == "</font>" and font_stack:
                font_stack.pop()

    return "".join(out_pieces)


# -- Monkey-patch installer -------------------------------------------------

_fallback_installed = False


def install_font_fallback():
    """Monkey-patch ``Paragraph.__init__`` so every Paragraph automatically
    runs ``font_fallback()`` on its text.  Idempotent — safe to call
    multiple times.
    """
    global _fallback_installed
    if _fallback_installed:
        return

    try:
        from reportlab.platypus import Paragraph as _Para
    except ImportError:
        return

    _orig_init = _Para.__init__

    def _patched_init(self, text, style=None, *args, **kwargs):
        if isinstance(text, str):
            text = content_sanitize(text)  # Layer 1: clean dangerous chars
            if style is not None:
                base_font = getattr(style, "fontName", None)
                if base_font and base_font in FONT_FALLBACK_CHAIN:
                    text = font_fallback(text, base_font)  # Layer 2: font selection
        _orig_init(self, text, style, *args, **kwargs)

    _Para.__init__ = _patched_init
    _fallback_installed = True


# -- Post-generation glyph check -------------------------------------------

def check_missing_glyphs(pdf_path: str) -> list[dict[str, Any]]:
    """Scan a PDF for .notdef glyphs, control chars, and other problematic characters.

    Returns a list of dicts with keys: page, position, context, kind.
    Empty list means no issues found.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("Warning: PyMuPDF (fitz) not installed — cannot check missing glyphs", file=sys.stderr)
        return []

    issues: list[dict[str, Any]] = []
    doc = fitz.open(pdf_path)

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text()
        for i, ch in enumerate(text):
            code = ord(ch)
            kind: str | None = None

            if ch == "\x00":
                kind = "notdef"
            elif code <= 0x1F and ch not in '\t\n\r' or code == 0x7F:
                kind = "control_char"
            elif code == 0xFFFD:
                kind = "replacement_char"
            elif code in _ZERO_WIDTH_CHARS:
                kind = "zero_width"
            elif code in _BIDI_CONTROLS:
                kind = "bidi_control"
            elif code in _VARIATION_SELECTORS:
                kind = "variation_selector"
            elif 0xE000 <= code <= 0xF8FF:
                kind = "private_use_area"

            if kind:
                start = max(0, i - 10)
                end = min(len(text), i + 11)
                context = text[start:end].replace("\x00", "□")
                issues.append({
                    "page": page_num + 1,
                    "position": i,
                    "char": f"U+{code:04X}",
                    "kind": kind,
                    "context": context,
                })

    doc.close()

    # Deduplicate by page + context + kind
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for item in issues:
        key = f"{item['page']}:{item['kind']}:{item['context']}"
        if key not in seen:
            seen.add(key)
            unique.append(item)

    return unique


@cmd("font.check")
def font_check(argv: list):
    """Scan a PDF for missing glyphs (□ boxes) after generation."""
    if not argv:
        Output.error("MissingArg", "Usage: font.check <pdf_file>")
    pdf_path = argv[0]
    if not os.path.isfile(pdf_path):
        Output.error("FileNotFound", f"File not found: {pdf_path}")

    issues = check_missing_glyphs(pdf_path)

    # Group by kind for better reporting
    by_kind: dict[str, list[dict]] = {}
    for item in issues:
        k = item.get("kind", "unknown")
        by_kind.setdefault(k, []).append(item)

    result: dict[str, Any] = {
        "status": "issues_found" if issues else "ok",
        "total_issues": len(issues),
        "by_kind": {k: len(v) for k, v in by_kind.items()},
    }
    if issues:
        result["issues"] = issues[:30]  # cap output
        result["hints"] = {
            "notdef": "Missing glyphs (□). Fix: call install_font_fallback() after font registration.",
            "control_char": "Control characters leaked into PDF. Fix: content_sanitize() should strip these.",
            "replacement_char": "U+FFFD found — upstream encoding error corrupted original character.",
            "zero_width": "Zero-width chars found. Usually harmless visually but affect text search/copy.",
            "bidi_control": "Bidirectional control chars found. May cause text direction issues.",
            "variation_selector": "Variation selectors found. No visual effect in ReportLab but shouldn't be here.",
            "private_use_area": "Private Use Area chars found. Will render as □ unless a custom font covers them.",
        }

    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if not issues else 1)


@cmd("toc.check")
def toc_check(argv: list):
    """Validate TOC quality in a PDF file (page numbers, entries, links)."""
    if not argv:
        Output.error("MissingArg", "Usage: toc.check <pdf_file>")
    pdf_path = argv[0]
    if not os.path.isfile(pdf_path):
        Output.error("FileNotFound", f"File not found: {pdf_path}")

    # Locate toc_validate.py relative to this script
    script_dir = Path(__file__).resolve().parent
    toc_script = script_dir / "toc_validate.py"
    if not toc_script.exists():
        # Try parent's scripts dir
        candidate = script_dir.parent / "scripts" / "toc_validate.py"
        if candidate.exists():
            toc_script = candidate

    if toc_script.exists():
        # Import and call directly
        import importlib.util
        spec = importlib.util.spec_from_file_location("toc_validate", str(toc_script))
        toc_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(toc_mod)
        result = toc_mod.check_pdf(pdf_path)
    else:
        Output.error("ScriptNotFound",
                      "toc_validate.py not found. Expected at: " + str(script_dir / "toc_validate.py"))

    # Add remediation hints per error code
    remediation = {
        "TOC_ALL_SAME_PAGE": "ReportLab: use multiBuild() instead of build() with TocDocTemplate",
        "TOC_NO_ENTRIES": "Check afterFlowable() notifies TOC correctly; ensure headings have bookmark_name/bookmark_level attributes",
        "TOC_PAGES_INVALID": "TOC entry references a page beyond document total — regenerate TOC",
        "TOC_NOT_FOUND": "Document has many pages but no TOC detected in first 5 pages",
        "TOC_LINKS_MISSING": "TOC entries exist but no clickable links — check bookmark_key in afterFlowable()",
        "TOC_ON_FIRST_PAGE": "Add a cover page before the TOC, or insert PageBreak() between cover and TOC. Expected: Cover(p1) → TOC(p2) → Content(p3+)",
    }
    for err in result.get("errors", []):
        code = err.get("code", "")
        if code in remediation:
            err["fix"] = remediation[code]
    for warn in result.get("warnings", []):
        code = warn.get("code", "")
        if code in remediation:
            warn["fix"] = remediation[code]

    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result.get("pass", False) else 1)


# ═══════════════════════════════════════════════════════════════
#  Section 7: code — sanitization pipeline for PDF generation code
# ═══════════════════════════════════════════════════════════════

# --- Step 0: restore literal unicode escapes/entities to real chars ---
_RE_UNICODE_ESC = re.compile(r"(\\u[0-9a-fA-F]{4})|(\\U[0-9a-fA-F]{8})|(\\x[0-9a-fA-F]{2})")


def _restore_escapes(s: str) -> str:
    # HTML entities: &#179; &#x2264; &alpha; ...
    s = html.unescape(s)

    # Literal backslash escapes: "\\u00B3" -> "³"
    def _dec(m: re.Match) -> str:
        esc = m.group(0)
        try:
            if esc.startswith("\\u") or esc.startswith("\\U"):
                return chr(int(esc[2:], 16))
            if esc.startswith("\\x"):
                return chr(int(esc[2:], 16))
        except Exception:
            return esc
        return esc

    return _RE_UNICODE_ESC.sub(_dec, s)


# --- Step 1: superscripts/subscripts -> <super>/<sub> ---
_SUPERSCRIPT_MAP: dict[str, str] = {
    "\u2070": "0", "\u00b9": "1", "\u00b2": "2", "\u00b3": "3", "\u2074": "4",
    "\u2075": "5", "\u2076": "6", "\u2077": "7", "\u2078": "8", "\u2079": "9",
    "\u207a": "+", "\u207b": "-", "\u207c": "=", "\u207d": "(", "\u207e": ")",
    "\u207f": "n", "\u1da6": "i",
}

_SUBSCRIPT_MAP: dict[str, str] = {
    "\u2080": "0", "\u2081": "1", "\u2082": "2", "\u2083": "3", "\u2084": "4",
    "\u2085": "5", "\u2086": "6", "\u2087": "7", "\u2088": "8", "\u2089": "9",
    "\u208a": "+", "\u208b": "-", "\u208c": "=", "\u208d": "(", "\u208e": ")",
    "\u2090": "a", "\u2091": "e", "\u2095": "h", "\u1d62": "i", "\u2c7c": "j",
    "\u2096": "k", "\u2097": "l", "\u2098": "m", "\u2099": "n", "\u2092": "o",
    "\u209a": "p", "\u1d63": "r", "\u209b": "s", "\u209c": "t", "\u1d64": "u",
    "\u1d65": "v", "\u2093": "x",
}


def _replace_super_sub(s: str) -> str:
    out = []
    for ch in s:
        if ch in _SUPERSCRIPT_MAP:
            out.append(f"<super>{_SUPERSCRIPT_MAP[ch]}</super>")
        elif ch in _SUBSCRIPT_MAP:
            out.append(f"<sub>{_SUBSCRIPT_MAP[ch]}</sub>")
        else:
            out.append(ch)
    return "".join(out)


# --- Step 2: symbol fallback for SimHei (protect tags, then replace) ---
_SYMBOL_FALLBACK: dict[str, str] = {
    # Currently empty - enable entries as needed for fonts missing specific glyphs
}


def _fallback_symbols(s: str) -> str:
    # Protect <super>/<sub> tags from being modified
    placeholders: dict[str, str] = {}

    def _protect_tag(m: re.Match) -> str:
        key = f"@@TAG{len(placeholders)}@@"
        placeholders[key] = m.group(0)
        return key

    protected = re.sub(r"</?super>|</?sub>", _protect_tag, s)

    # Replace symbols
    protected = "".join(_SYMBOL_FALLBACK.get(ch, ch) for ch in protected)

    # Restore tags
    for k, v in placeholders.items():
        protected = protected.replace(k, v)

    return protected


def sanitize_code(text: str) -> str:
    """
    Full sanitization pipeline for PDF generation code.
    - Restore unicode escapes/entities to real characters
    - Replace superscript/subscript unicode with <super>/<sub>
    - Replace other risky symbols with ASCII/text fallbacks
    """
    s = _restore_escapes(text)
    s = _replace_super_sub(s)
    s = _fallback_symbols(s)
    return s


@cmd("palette.generate")
def palette_generate(argv: list):
    """Generate a color palette via design_engine.py and output as Python-ready ReportLab code.

    Usage:
        pdf.py palette.generate [--title "document title"] [--mode minimal|dark|pastel|jewel|light] [--harmony auto|complementary|...] [--format python|json|css]

    If --title is provided, intent is auto-derived from the title.
    Output formats:
        python (default): Ready-to-paste ReportLab color variables
        json: Raw palette JSON
        css: CSS custom properties
    """
    title = _pop_flag(argv, "--title", "-t") or ""
    mode = _pop_flag(argv, "--mode", "-m") or "minimal"
    harmony = _pop_flag(argv, "--harmony", "--harmony") or "auto"
    fmt = _pop_flag(argv, "--format", "-f") or "python"
    seed_str = _pop_flag(argv, "--seed", "--seed")
    seed = int(seed_str) if seed_str else None

    engine_script = _SCRIPT_DIR / "design_engine.py"
    if not engine_script.exists():
        Output.error("DependencyMissing", f"design_engine.py not found at {engine_script}")

    # Import design_engine dynamically
    import importlib.util
    spec = importlib.util.spec_from_file_location("design_engine", str(engine_script))
    de = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(de)

    # Auto-derive intent from title
    if title:
        intent = de.derive_intent(title)
    else:
        intent = "neutral"

    palette = de.generate_color_palette(intent, mode, harmony=harmony, seed=seed)
    violations = de.audit_palette(palette)

    if fmt == "json":
        print(json.dumps(palette, indent=2, ensure_ascii=False))
    elif fmt == "css":
        print(de.palette_to_css(palette))
    else:
        # Python format: ready-to-paste ReportLab code
        print("# \u2501\u2501 Color Palette (auto-generated by pdf.py palette.generate) \u2501\u2501")
        print(f"# Intent: {intent} | Mode: {mode} | Harmony: {palette['meta']['harmony']}")
        print(f"# Contrast: text:bg={palette['meta']['contrast']['text_on_bg']} | accent:bg={palette['meta']['contrast']['accent_on_bg']}")
        print("from reportlab.lib import colors")
        print(f"ACCENT       = colors.HexColor('{palette['accent']}')")
        print(f"TEXT_PRIMARY  = colors.HexColor('{palette['text']}')")
        print(f"TEXT_MUTED    = colors.HexColor('{palette['muted']}')")
        print(f"BG_SURFACE   = colors.HexColor('{palette['mid']}')")
        print(f"BG_PAGE      = colors.HexColor('{palette['bg']}')")
        print(f"SURFACE_RGBA = '{palette['surface']}'  # For CSS/HTML elements")
        print("")
        print("# ReportLab table colors")
        print("TABLE_HEADER_COLOR = ACCENT")
        print("TABLE_HEADER_TEXT  = colors.white")
        print("TABLE_ROW_EVEN     = colors.white")
        print("TABLE_ROW_ODD      = BG_SURFACE")

    if violations:
        print("\n# \u26a0\ufe0f Palette audit warnings:", file=sys.stderr)
        for v in violations:
            print(f"#   - {v}", file=sys.stderr)

    raise SystemExit(0)


@cmd("palette.cascade")
def palette_cascade(argv: list):
    """Generate a role-based cascade palette (area ∝ 1/saturation).

    Usage:
        pdf.py palette.cascade [--title "document title"] [--mode minimal|dark|pastel|jewel|light] [--harmony auto|...] [--format summary|json|css|reportlab]

    The cascade palette produces 12 named roles + 4 semantic colors, each assigned
    to a size tier (XL/L/M/S/XS) with saturation caps enforced per tier.
    Cover, body, and chart colors all pull from the same palette — no color drift.
    """
    title = _pop_flag(argv, "--title", "-t") or ""
    mode = _pop_flag(argv, "--mode", "-m") or "minimal"
    harmony = _pop_flag(argv, "--harmony", "--harmony") or "auto"
    fmt = _pop_flag(argv, "--format", "-f") or "summary"
    seed_str = _pop_flag(argv, "--seed", "--seed")
    seed = int(seed_str) if seed_str else None

    engine_script = _SCRIPT_DIR / "design_engine.py"
    if not engine_script.exists():
        Output.error("DependencyMissing", f"design_engine.py not found at {engine_script}")

    import importlib.util
    spec = importlib.util.spec_from_file_location("design_engine", str(engine_script))
    de = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(de)

    if title:
        intent = de.derive_intent(title)
    else:
        intent = "neutral"

    cascade = de.generate_cascade_palette(intent, mode, harmony=harmony, seed=seed)

    if fmt == "json":
        print(json.dumps(cascade, indent=2, ensure_ascii=False, default=str))
    elif fmt == "css":
        print(cascade["css"])
    elif fmt == "reportlab":
        print(cascade["reportlab"])
    else:
        # Summary format
        meta = cascade["meta"]
        print(f"🎨 Cascade Palette | Intent: {meta['intent']} | Mode: {meta['mode']} | Harmony: {meta['harmony']}")
        print(f"   Base hue: {meta['base_hue']}° | Accent hue: {meta['accent_hue']}° | Secondary: {meta['secondary_hue']}°")
        print(f"   Contrast: text:bg={meta['contrast']['text_on_bg']} | accent:bg={meta['contrast']['accent_on_bg']}")
        print()
        print("   TIER   | ROLE              | HEX     | S      | USAGE")
        print("   ────── | ────────────────── | ─────── | ────── | ────────────")
        for name, info in cascade["roles"].items():
            tier = info['tier'].upper().ljust(6)
            nm = name.ljust(18)
            hx = info['hex'].ljust(7)
            s_val = f"{info['hsl'][1]:.3f}".ljust(6)
            print(f"   {tier} | {nm} | {hx} | {s_val} | {info['usage']}")
        print()
        print("   Semantic:")
        for name, info in cascade["semantic"].items():
            print(f"     {name}: {info['hex']} (S={info['hsl'][1]:.3f})")
        if meta["audit"]:
            print("\n   ⚠️ Violations:")
            for v in meta["audit"]:
                print(f"     - {v}")
        else:
            print("\n   ✅ All tier constraints pass")

    raise SystemExit(0)


@cmd("code.sanitize")
def code_sanitize(argv: list):
    """Sanitize Unicode in a Python script for PDF generation."""
    if not argv:
        Output.error("MissingArg", "Usage: code.sanitize <target_script.py>")
    target = argv[0]
    with open(target, encoding="utf-8") as f:
        code = f.read()
    sanitized = sanitize_code(code)
    with open(target, "w", encoding="utf-8") as f:
        f.write(sanitized)
    print(f"Sanitized: {target}")
    raise SystemExit(0)


@cmd("content.sanitize")
def content_sanitize_cli(argv: list):
    """Sanitize content text for PDF rendering (dry-run report).

    Reads a text file and reports what content_sanitize() would change.
    Useful for debugging before PDF generation.

    Usage:
        pdf.py content.sanitize <text_file>
        pdf.py content.sanitize <text_file> --apply
    """
    if not argv:
        Output.error("MissingArg", "Usage: content.sanitize <text_file> [--apply]")
    target = argv[0]
    apply_flag = "--apply" in argv

    with open(target, encoding="utf-8") as f:
        raw = f.read()

    global _content_sanitize_warnings
    _content_sanitize_warnings = []
    cleaned = content_sanitize(raw, dry_run=True)

    changes = len(_content_sanitize_warnings)
    result: dict[str, Any] = {
        "file": target,
        "original_chars": len(raw),
        "cleaned_chars": len(cleaned),
        "changes": changes,
        "details": _content_sanitize_warnings[:50],
    }

    if apply_flag and changes > 0:
        with open(target, "w", encoding="utf-8") as f:
            f.write(cleaned)
        result["applied"] = True
    else:
        result["applied"] = False
        if changes > 0:
            result["hint"] = "Run with --apply to write cleaned text back to file."

    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0)


# ═══════════════════════════════════════════════════════════════
#  Section 8: CLI dispatcher
# ═══════════════════════════════════════════════════════════════

def _usage():
    sys.stdout.write(__doc__.strip() + "\n")
    raise SystemExit(0)


def main():
    tokens = sys.argv[1:]
    if not tokens or tokens[0] in ("-h", "--help"):
        _usage()

    cmd_name = tokens.pop(0)

    # Direct match
    handler = _COMMANDS.get(cmd_name)
    if handler is not None:
        handler(tokens)
        return

    # Two-word match (e.g., "extract text" -> "extract.text")
    if tokens:
        compound = f"{cmd_name}.{tokens[0]}"
        handler = _COMMANDS.get(compound)
        if handler is not None:
            tokens.pop(0)
            handler(tokens)
            return

    # List commands in group
    group_cmds = [k for k in _COMMANDS if k.startswith(cmd_name + ".")]
    if group_cmds:
        print(f"Available commands in '{cmd_name}':")
        for c in sorted(group_cmds):
            print(f"  {c}")
        raise SystemExit(0)

    print(f"Unknown command: {cmd_name}\n")
    _usage()


if __name__ == "__main__":
    main()

