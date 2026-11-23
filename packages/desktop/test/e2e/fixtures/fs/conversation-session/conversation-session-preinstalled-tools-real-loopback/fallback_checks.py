"""以真实分发入口验证一次回退、取消收尾和桌面引导。"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).parent
# 修复原因：预装 Python 不设 PYTHONUTF8，Windows 上 read_text/write_text 默认用系统代码页（如 936）；
# 测试用 UTF-8 读写这些 JSON，路径或提示含中文时会解码错。读写测试交换的文件一律显式用 UTF-8。
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf8"))
DOCS = ROOT / "中文 空格"
PLUGINS = json.loads((ROOT / "plugins.json").read_text(encoding="utf8"))
HELPER = Path(PLUGINS["documents"]["path"]) / "scripts/zcode_libreoffice.py"
WINDOWS = sys.platform == "win32"


def quoted(value):
    return shlex.quote(str(value))


def fake_soffice(mode):
    """Windows 夹具：入口 shim 的配置把调用转给本脚本，路径经环境变量传入。"""
    arguments = sys.argv[2:]
    if mode == "managed":
        if "--version" in arguments:
            sys.exit(subprocess.run([os.environ["ZCODE_FALLBACK_ORIGINAL"], *arguments]).returncode)
        with open(os.environ["ZCODE_FALLBACK_MANAGED_LOG"], "a", encoding="utf8") as log:
            for argument in arguments:
                if argument.startswith("-env:UserInstallation="):
                    log.write(argument + "\n")
        if os.environ["ZCODE_FALLBACK_MODE"] == "sleep":
            time.sleep(60)
            sys.exit(0)
        Path(os.environ["ZCODE_FALLBACK_PARTIAL"]).write_text("failed partial output")
        sys.exit(78)
    actual = os.environ["ZCODE_FALLBACK_SYSTEM"]
    if "--version" in arguments:
        sys.exit(subprocess.run([actual, *arguments]).returncode)
    with open(os.environ["ZCODE_FALLBACK_SYSTEM_LOG"], "a", encoding="utf8") as log:
        log.write("run\n")
    if Path(os.environ["ZCODE_FALLBACK_PARTIAL"]).exists():
        sys.exit(91)
    sys.exit(subprocess.run([actual, *arguments]).returncode)


if __name__ == "__main__" and sys.argv[1:2] in (["managed"], ["system"]):
    fake_soffice(sys.argv[1])

spec = importlib.util.spec_from_file_location("acceptance_libreoffice", HELPER)
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)


def shim_config(mode):
    # shim 配置只接受绝对路径；目标是当前解释器，由它运行本脚本的假入口分支，调用方参数接在后面。
    return json.dumps({
        "schemaVersion": 1, "target": sys.executable,
        "args": [str(Path(__file__).resolve()), mode], "env": [],
    }, ensure_ascii=False)


async def main():
    bin_dir = Path(CONFIG["root"]) / "bin"
    # Windows 入口是 shim：exe 不变，改写同名 .shim 配置即可换目标；其他平台替换 sh 脚本。
    entry = bin_dir / ("zcode-soffice.shim" if WINDOWS else "zcode-soffice")
    original = entry.read_bytes()
    backup = ROOT / ("original-soffice-entry.exe" if WINDOWS else "original-soffice-entry")
    if WINDOWS:
        # 备份是完整入口（shim 副本加原配置）；配置写的是绝对路径，放在夹具目录也能运行。
        shutil.copyfile(bin_dir / "zcode-soffice.exe", backup)
        backup.with_suffix(".shim").write_bytes(original)
    else:
        backup.write_bytes(original)
        backup.chmod(0o755)
    managed_log, system_log = ROOT / "managed-failure.log", ROOT / "system-retry.log"
    output = DOCS / "Fallback PDF"
    output.mkdir(exist_ok=True)
    partial = output / "中文 字体验收.pdf"
    if WINDOWS:
        actual_system = Path(CONFIG["systemApplication"]) / "program/soffice.com"
    else:
        actual_system = Path(CONFIG["systemApplication"]) / "Contents/MacOS/soffice"
    system_dir = ROOT / "system-probe"
    system_dir.mkdir(exist_ok=True)
    # 系统 shim 只记录次数并委托真实系统应用；不修改官方应用目录。
    if WINDOWS:
        shutil.copyfile(bin_dir / "zcode-soffice.exe", system_dir / "soffice.exe")
        (system_dir / "soffice.shim").write_text(shim_config("system"), encoding="utf-8")
    else:
        system_entry = system_dir / "soffice"
        system_entry.write_text(f'''#!/bin/sh
for arg do
  if [ "$arg" = "--version" ]; then exec {quoted(actual_system)} "$@"; fi
done
printf 'run\\n' >> {quoted(system_log)}
if [ -e {quoted(partial)} ]; then exit 91; fi
export SAL_USE_VCLPLUGIN=osx
exec {quoted(actual_system)} "$@"
''')
        system_entry.chmod(0o755)
    env = dict(os.environ, PATH=str(system_dir) + os.pathsep + os.environ["PATH"])
    if WINDOWS:
        env.update({
            "ZCODE_FALLBACK_ORIGINAL": str(backup),
            "ZCODE_FALLBACK_MANAGED_LOG": str(managed_log),
            "ZCODE_FALLBACK_SYSTEM_LOG": str(system_log),
            "ZCODE_FALLBACK_PARTIAL": str(partial),
            "ZCODE_FALLBACK_SYSTEM": str(actual_system),
        })
    header = f'''#!/bin/sh
for arg do
  if [ "$arg" = "--version" ]; then exec {quoted(backup)} "$@"; fi
done
for arg do
  case "$arg" in -env:UserInstallation=*) printf '%s\\n' "$arg" >> {quoted(managed_log)};; esac
done
'''

    def install_entry(mode):
        if WINDOWS:
            env["ZCODE_FALLBACK_MODE"] = mode
            entry.write_text(shim_config("managed"), encoding="utf-8")
        else:
            body = "sleep 60\n" if mode == "sleep" else f"printf 'failed partial output' > {quoted(partial)}\nexit 78\n"
            entry.write_text(header + body)
            entry.chmod(0o755)

    try:
        install_entry("fail")
        result = await helper.run_libreoffice(
            ["--convert-to", "pdf", "--outdir", str(output), str(DOCS / "中文 字体验收.docx")],
            environment=env, temporary_outputs=[partial],
        )
        assert result.source == "system"
        assert system_log.read_text().splitlines() == ["run"]
        from pypdf import PdfReader
        assert "文档转换与中文显示" in PdfReader(partial).pages[0].extract_text()
        profile_urls = [line.split("=", 1)[1] for line in managed_log.read_text().splitlines()]
        assert all(not Path(unquote(urlparse(url).path).lstrip("/" if WINDOWS else "")).exists() for url in profile_urls)
        managed_log.unlink()
        system_log.unlink()
        install_entry("sleep")
        task = asyncio.create_task(helper.run_libreoffice(["--convert-to", "pdf", str(DOCS / "中文 字体验收.docx")], environment=env))
        # 等真实调用写出配置参数后取消，避免在子进程尚未启动前制造假通过。
        async with asyncio.timeout(30):
            while not managed_log.exists():
                await asyncio.sleep(0.02)
        task.cancel()
        try:
            await task
            raise AssertionError("Cancelled call unexpectedly completed")
        except asyncio.CancelledError:
            pass
        assert not system_log.exists()
        cancelled_profiles = [line.split("=", 1)[1] for line in managed_log.read_text().splitlines()]
        assert all(not Path(unquote(urlparse(url).path).lstrip("/" if WINDOWS else "")).exists() for url in cancelled_profiles)
    finally:
        entry.write_bytes(original)
        entry.chmod(0o755)
    # 用正常发现链隔离系统候选，不删除宿主安装，也不注入候选列表绕过查找。
    empty_home = ROOT / "no-tools-home"
    empty_home.mkdir(exist_ok=True)
    if WINDOWS:
        system_root = os.environ["SYSTEMROOT"]
        no_tools = dict(os.environ, HOME=str(empty_home), USERPROFILE=str(empty_home),
                        PATH=os.pathsep.join([str(Path(system_root) / "System32"), system_root]))
        # Windows 按 Program Files 发现系统版本；指向空目录即可隔离已安装的系统 LibreOffice。
        for name in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
            no_tools[name] = str(empty_home)
    else:
        assert not Path("/Applications/LibreOffice.app").exists()
        no_tools = dict(os.environ, HOME=str(empty_home), PATH="/usr/bin:/bin")
    try:
        await helper.run_libreoffice(["--version"], environment=no_tools)
        raise AssertionError("Missing tools unexpectedly succeeded")
    except helper.LibreOfficeUnavailable as error:
        guidance = str(error)
        assert "帮助" in guidance and "预装工具" in guidance
    (ROOT / "fallback-results.json").write_text(json.dumps({
        "source": result.source, "fallbackActualRuns": 1, "managedFailureCode": 78,
        "managedProfilesRemoved": profile_urls, "cancelledProfilesRemoved": cancelled_profiles,
        "cancelDidNotRetry": True, "guidance": guidance, "entryRestored": entry.read_bytes() == original,
        "realSystemApplication": str(actual_system),
    }, ensure_ascii=False, indent=2), encoding="utf8")


if __name__ == "__main__":
    asyncio.run(main())
