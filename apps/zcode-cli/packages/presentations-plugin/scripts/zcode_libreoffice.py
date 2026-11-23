#!/usr/bin/env python3
"""文档插件统一的 LibreOffice 调用边界。"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from typing import Mapping, Optional, Sequence

AVAILABLE_ENV = 'ZCODE_PREINSTALLED_TOOLS_AVAILABLE'
DESKTOP_GUIDANCE = '预装 LibreOffice 未就绪或已关闭。请用户打开“帮助 → 预装工具”查看状态，并选择等待、打开开关或由 Agent 按 setup.md 安装，避免重复下载。'
INSTALLATION_GUIDANCE = 'LibreOffice not found. Follow this plugin’s env_setup/setup.md installation guidance, then retry through this unified launcher, not soffice directly. Do not skip recalculation or validation.'
PROFILE_TEMPLATE = Path(__file__).resolve().parent / 'libreoffice-profile'
RECALC_MACRO = 'vnd.sun.star.script:Standard.ZCode.RecalculateAndSave?language=Basic&location=application'


class LibreOfficeUnavailable(RuntimeError):
    code = 'not-ready'
    exit_code = 69


class LibreOfficeInvocationError(RuntimeError):
    code = 'execution-failed'
    exit_code = 70

    def __init__(self, message, *, exit_code=70):
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class InvocationResult:
    source: str
    version: str
    executable: str
    stdout: str
    stderr: str
    # 使用系统版本时的版本与“受管版本未使用”原因；调用方不需要从 stderr 里拆分。
    notice: str = ''


async def _settle(task):
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    return task.result(), cancelled


def _copy_profile(env):
    root = Path(tempfile.mkdtemp(prefix='zcode-libreoffice-', dir=env.get('TMPDIR') or env.get('TEMP')))
    try:
        shutil.copytree(PROFILE_TEMPLATE, root / 'profile')
        return root / 'profile'
    except BaseException:
        shutil.rmtree(root)
        raise


@asynccontextmanager
async def _private_profile(env: Mapping[str, str]):
    creation = asyncio.create_task(asyncio.to_thread(_copy_profile, env))
    try:
        profile = await asyncio.shield(creation)
        yield profile
    finally:
        # 文件线程不能取消；先等创建结束再清理，避免取消后又冒出遗留目录。
        profile, cancelled_creation = await _settle(creation)
        _unused, cancelled_cleanup = await _settle(asyncio.create_task(asyncio.to_thread(shutil.rmtree, profile.parent)))
        if cancelled_creation or cancelled_cleanup:
            raise asyncio.CancelledError()


@asynccontextmanager
async def conversion_directory(parent: Path):
    # 转换目录与配置目录遵守相同的不可取消文件操作收尾规则。
    creation = asyncio.create_task(asyncio.to_thread(tempfile.mkdtemp, prefix='.office-convert-', dir=parent))
    try:
        yield Path(await asyncio.shield(creation))
    finally:
        directory, cancelled_creation = await _settle(creation)
        _unused, cancelled_cleanup = await _settle(asyncio.create_task(asyncio.to_thread(shutil.rmtree, directory)))
        if cancelled_creation or cancelled_cleanup:
            raise asyncio.CancelledError()


async def _system_candidates(env: Mapping[str, str]):
    names = ('soffice.com', 'soffice', 'libreoffice') if sys.platform == 'win32' else ('soffice', 'libreoffice')
    candidates = []
    for name in names:
        found = await asyncio.to_thread(shutil.which, name, path=env.get('PATH', ''))
        if found:
            candidates.append(Path(found))
    home = Path(env.get('HOME') or env.get('USERPROFILE') or str(Path.home()))
    if sys.platform == 'darwin':
        candidates.extend([
            Path('/Applications/LibreOffice.app/Contents/MacOS/soffice'),
            home / 'Applications/LibreOffice.app/Contents/MacOS/soffice',
        ])
    elif sys.platform == 'win32':
        # Windows 的 os.environ 规范化为大写，不能丢掉自定义安装盘符。
        for base in (
            env.get('PROGRAMFILES') or env.get('ProgramFiles') or 'C:/Program Files',
            env.get('PROGRAMFILES(X86)') or env.get('ProgramFiles(x86)') or 'C:/Program Files (x86)',
        ):
            candidates.append(Path(base) / 'LibreOffice/program/soffice.com')
    elif sys.platform == 'linux':
        candidates.extend(Path(value) for value in (
            '/usr/bin/soffice', '/usr/local/bin/soffice',
            '/usr/lib/libreoffice/program/soffice', '/snap/bin/libreoffice.soffice',
            '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
        ))
        candidates.extend(await asyncio.to_thread(lambda: sorted(Path('/opt').glob('libreoffice*/program/soffice'))))
    return list(dict.fromkeys(candidates))


async def _stop_process(process):
    if os.name == 'nt':
        # taskkill 依赖仍存活的根进程；启动器先退出的 Windows 子树归属尚未解决。
        if process.returncode is None:
            stopper = await asyncio.create_subprocess_exec(
                'taskkill', '/PID', str(process.pid), '/T', '/F',
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await stopper.wait()
        await process.wait()
        return
    else:
        # 启动器先退出时，子进程仍属于本次进程组；不能用启动器退出码放弃归属。
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    # wait() 在启动器已退出时会直接返回；管道关闭后才可释放配置。
    await process.communicate()


async def _execute(
    executable: Path,
    arguments: Sequence[str],
    profile: Path,
    env: Mapping[str, str],
    timeout: float,
    managed: bool = False,
):
    # macOS 原生插件支持系统中文字体；无此插件的既有 headless-only 程序不能被强制切换。
    process_env = dict(env)
    # 官方包的过期 pyc 也会在加载宏提供器时重写签名文件；本次调用只读应用目录。
    process_env['PYTHONDONTWRITEBYTECODE'] = '1'
    if sys.platform == 'darwin' and not managed:
        # 预装入口负责后端环境；系统入口仍按真实程序目录探测原生字体能力。
        # 调用保留链接名，后端文件仍从真实程序目录探测，避免链接入口丢失原生字体能力。
        program = await asyncio.to_thread(executable.resolve)
        native_plugin = program.parent.parent / 'Frameworks/libvclplug_osxlo.dylib'
        if await asyncio.to_thread(native_plugin.is_file):
            process_env.setdefault('SAL_USE_VCLPLUGIN', 'osx')
    args = [str(executable), '-env:UserInstallation=' + profile.as_uri()]
    creation = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, '--headless', '--norestore', *arguments,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=process_env,
        start_new_session=os.name != 'nt',
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
    ))
    process = None
    try:
        # OS 可能已创建进程而 await 尚未返回；取消不能丢失本次进程句柄。
        try:
            process = await asyncio.shield(creation)
        except OSError as error:
            # 保留真实启动原因，由统一调用边界执行一次系统回退。
            raise LibreOfficeInvocationError('LibreOffice could not start: ' + str(error)) from error
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        if process is None:
            process, _cancelled = await _settle(creation)
        cleanup = asyncio.create_task(_stop_process(process))
        # 先收回本次真实进程组，再让外层释放配置。
        _unused, cancelled_cleanup = await _settle(cleanup)
        # 超时收尾期间到达的取消仍优先；否则会把停止请求误当超时并启动系统重跑。
        if cancelled_cleanup:
            raise asyncio.CancelledError()
        if isinstance(error, asyncio.TimeoutError):
            raise LibreOfficeInvocationError('LibreOffice timed out; the document was not validated.', exit_code=124) from error
        raise

    return process.returncode, stdout.decode(errors='replace'), stderr.decode(errors='replace')


async def _find_system(
    profile: Path,
    env: Mapping[str, str],
    candidates: Optional[Sequence[Path]],
    timeout: float,
):
    # 根因：程序存在但探测失败（超时、缺共享库）原先与“没装”一样被跳过，最终报告“未找到”并引导重装，
    # 真实原因丢失。只把不存在的候选当作没有；首个探测失败原样交给调用方报告。
    failure = None
    for candidate in candidates if candidates is not None else await _system_candidates(env):
        try:
            # 系统入口可能按调用名分派；解析链接只作校验，执行时保留原入口名。
            executable = await asyncio.to_thread(Path(candidate).absolute)
            resolved = await asyncio.to_thread(executable.resolve, strict=True)
            if not await asyncio.to_thread(resolved.is_file):
                continue
        except OSError:
            continue
        try:
            code, stdout, stderr = await _execute(executable, ['--version'], profile, env, min(timeout, 10))
        except (OSError, LibreOfficeInvocationError) as error:
            failure = failure or f'{executable}: {error}'
            continue
        # 自测受管版本不能成为用户已有程序的准入门槛，开发版也保持可用。
        if code == 0:
            reported = re.match(r'^LibreOffice(?:Dev)?\s+(\S+)', stdout.strip())
            return (executable, reported.group(1) if reported else 'unknown'), None
        failure = failure or f'{executable} --version exited with {code}' + (f': {stderr.strip()[:500]}' if stderr.strip() else '')
    return None, failure


async def _prepare_recalculation(profile: Path, filename: Path):
    source = await asyncio.to_thread(filename.resolve, strict=True)
    if not await asyncio.to_thread(source.is_file):
        raise LibreOfficeInvocationError('重算输入不是文件')
    receipt = profile / 'recalculation-result.txt'
    macro = profile / 'user/basic/Standard/ZCode.xba'
    text = await asyncio.to_thread(macro.read_text, encoding='utf-8')
    # file URL 会编码引号和中文；不把原始文件名拼进 Basic 代码。
    text = text.replace('__ZCODE_INPUT_URI__', source.as_uri()).replace('__ZCODE_RECEIPT_URI__', receipt.as_uri())
    await asyncio.to_thread(macro.write_text, text, encoding='utf-8')
    return receipt


async def _invoke_program(executable, arguments, *, source, version, env, timeout, recalculate, managed=False, temporary_outputs=()):
    # 每次尝试复制新配置和新回执，受管失败的回执不能让系统重跑被误判成功。
    async with _private_profile(env) as profile:
        # 仅清理调用方拥有的临时产物；失败尝试留下的 PDF 不能冒充系统重跑成果。
        for output in temporary_outputs:
            _unused, cancelled = await _settle(asyncio.create_task(asyncio.to_thread(output.unlink, missing_ok=True)))
            if cancelled:
                raise asyncio.CancelledError()
        receipt = await _prepare_recalculation(profile, Path(recalculate)) if recalculate is not None else None
        invocation_args = ['--nodefault', RECALC_MACRO] if receipt is not None else arguments
        code, stdout, stderr = await _execute(executable, invocation_args, profile, env, timeout, managed)
        if code:
            raise LibreOfficeInvocationError(f'LibreOffice exited with {code}.\n' + stderr)
        if receipt is not None:
            try:
                outcome = (await asyncio.to_thread(receipt.read_text, encoding='utf-8-sig')).strip()
            except FileNotFoundError as error:
                raise LibreOfficeInvocationError('Missing recalculation receipt; the workbook was not validated.') from error
            if outcome != 'ok':
                raise LibreOfficeInvocationError('Failed recalculation receipt: ' + outcome)
        return InvocationResult(source, version, str(executable), stdout, stderr)


async def run_libreoffice(
    arguments: Sequence[str],
    *,
    timeout: float = 120,
    environment: Optional[Mapping[str, str]] = None,
    candidate_paths: Optional[Sequence[Path]] = None,
    recalculate: Optional[Path] = None,
    temporary_outputs: Sequence[Path] = (),
) -> InvocationResult:
    env = dict(os.environ if environment is None else environment)
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise LibreOfficeInvocationError('timeout 必须是大于零的有限秒数')
    if any(argument.lower().startswith(('-env:userinstallation=', '-env:brand_base_dir=')) for argument in arguments):
        raise LibreOfficeInvocationError('调用参数不能覆盖独立配置或私有字体目录')
    if recalculate is not None and not await asyncio.to_thread(Path(recalculate).is_file):
        # 根因：输入缺失原先在受管尝试内才报错，被当成受管失败，触发系统重跑和安装引导。
        # 用户参数错误按契约不重跑，在查找程序前直接报告。
        raise LibreOfficeInvocationError(f'重算输入不是文件：{recalculate}')
    outputs = tuple(Path(output) for output in temporary_outputs)
    managed_error = None
    reason = '未就绪或已关闭'
    # Windows 入口是 shim（zcode-soffice.exe），按 PATHEXT 查找；其他平台是 sh 脚本。
    entry = await asyncio.to_thread(shutil.which, 'zcode-soffice', path=env.get('PATH', ''))
    if entry:
        try:
            executable = Path(entry)
            async with _private_profile(env) as profile:
                code, stdout, stderr = await _execute(executable, ['--version'], profile, env, min(timeout, 10), managed=True)
                if code:
                    raise LibreOfficeInvocationError(f'LibreOffice exited with {code}.\n' + stderr)
                reported = re.match(r'^LibreOffice(?:Dev)?\s+(\S+)', stdout.strip())
                version = reported.group(1) if reported else 'unknown'
            return await _invoke_program(
                executable, arguments, source='managed', version=version,
                env=env, timeout=timeout, recalculate=recalculate, managed=True, temporary_outputs=outputs,
            )
        except (LibreOfficeInvocationError, OSError, ValueError) as error:
            # 入口可能在查找后被删除；先完成进程和配置收尾，再用系统版本重跑一次。
            # CancelledError 不在此捕获，用户取消绝不能启动另一份文档操作。
            managed_error = error
            reason = '运行失败：' + str(error)
    async with _private_profile(env) as profile:
        system, system_failure = await _find_system(profile, env, candidate_paths, timeout)
    if system is None:
        message = f'受管版本未使用：{reason}\n'
        if system_failure is not None:
            # 系统程序已安装但无法运行时直接报告原因；“未找到”的安装引导会导致重复安装。
            message += f'系统 LibreOffice 无法运行：{system_failure}\n'
        # 桌面先说明状态并交由用户选择，再给安装步骤，避免与后台准备重复下载。
        if env.get(AVAILABLE_ENV):
            message += DESKTOP_GUIDANCE + '\n'
        if system_failure is not None:
            raise LibreOfficeInvocationError(message.rstrip('\n')) from managed_error
        message += INSTALLATION_GUIDANCE
        if managed_error is not None:
            raise LibreOfficeInvocationError(message, exit_code=getattr(managed_error, 'exit_code', 70)) from managed_error
        raise LibreOfficeUnavailable(message)
    executable, version = system
    notice = f'Using system LibreOffice {version}. 受管版本未使用：{reason}\n'
    try:
        result = await _invoke_program(
            executable, arguments, source='system', version=version,
            env=env, timeout=timeout, recalculate=recalculate, temporary_outputs=outputs,
        )
    except (LibreOfficeInvocationError, OSError, ValueError) as error:
        # 系统只执行一次；最终错误同时保留受管和系统原因，不形成重试循环。
        raise LibreOfficeInvocationError(notice + str(error), exit_code=getattr(error, 'exit_code', 70)) from error
    return InvocationResult(result.source, result.version, result.executable, result.stdout, notice + result.stderr, notice.rstrip('\n'))


async def _with_cli_signals(operation, terminate):
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    if os.name != 'nt':
        loop.add_signal_handler(signal.SIGTERM, terminate, task)
    try:
        return await operation
    finally:
        if os.name != 'nt':
            loop.remove_signal_handler(signal.SIGTERM)


def run_cli_operation(operation):
    # 格式 CLI 也要接入取消收尾，否则 SIGTERM 会越过协程 finally，遗留独立子进程。
    termination_requested = False
    def terminate(task):
        nonlocal termination_requested
        termination_requested = True
        task.cancel()
    try:
        return asyncio.run(_with_cli_signals(operation, terminate))
    except asyncio.CancelledError as error:
        # Python 3.9 的任务传播会丢失取消消息；在事件循环外由 CLI owner 恢复信号原因。
        if termination_requested:
            raise asyncio.CancelledError('SIGTERM') from error
        raise


async def _run_cli(options):
    arguments = options.arguments if options.command == 'run' else ['--version']
    if arguments and arguments[0] == '--':
        arguments = arguments[1:]
    result = await run_libreoffice(
        arguments, timeout=options.timeout,
        recalculate=options.file if options.command == 'recalc' else None,
    )
    if result.stderr:
        print(result.stderr, file=sys.stderr, end='' if result.stderr.endswith('\n') else '\n')
    if options.command == 'check':
        print(json.dumps({
            'status': 'ready', 'source': result.source,
            'version': result.version, 'executable': result.executable,
        }, ensure_ascii=False))
    elif result.stdout:
        print(result.stdout, end='' if result.stdout.endswith('\n') else '\n')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description='Run document operations with an isolated LibreOffice profile.')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('check', 'run', 'recalc'):
        command = commands.add_parser(name)
        command.add_argument('--timeout', type=float, default=120)
        if name == 'run':
            command.add_argument('arguments', nargs=argparse.REMAINDER)
        if name == 'recalc':
            command.add_argument('file', type=Path)
    options = parser.parse_args(argv)
    try:
        return run_cli_operation(_run_cli(options))
    except (LibreOfficeUnavailable, LibreOfficeInvocationError) as error:
        print(str(error), file=sys.stderr)
        return error.exit_code
    except (OSError, ValueError) as error:
        print('LibreOffice invocation failed: ' + str(error), file=sys.stderr)
        return 70
    except asyncio.CancelledError as error:
        return 143 if error.args == ('SIGTERM',) else 130
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
