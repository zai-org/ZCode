import { STORAGE_MIGRATION_COMMAND } from "@zcode/shared/sqlite-migrations";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import { interceptTuiStderr, isTuiInvocation } from "./tui-stderr.js";
import { interceptKnownRuntimeWarnings } from "./runtime-warnings.js";
import { installStderrConsoleBoundary } from "./protocol-console.js";
import { setCliProcessTitle, setPluginHostProcessTitle } from "./process-name.js";
import { applyCliRuntimeEnvSanitization, mintStandaloneCuaCredentialsIfEligible } from "./env.js";
import { ensureSeaRuntimeTools } from "./sea-runtime-tools.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { scheduleCliExitWatchdog } from "./shutdown.js";
import { installCliProcessErrorBoundary } from "./process-errors.js";
import { installProtocolStderrBoundary } from "./protocol-stderr.js";
import { createProtocolProcessLifecycle } from "./protocol-lifecycle.js";
import { isProtocolServerInvocation } from "./arguments.js";

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 存储模式也可运行在 Host Worker 中，不能修改整个 Host 的进程名称。
  if (argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage")) {
    // 插件宿主复用 CLI 入口；统一改名会把 MCP 进程误标成 Agent，须在加载插件前按角色命名。
    if (isPluginHostInvocation(argv)) {
      setPluginHostProcessTitle(process.env[ZCODE_PLUGIN_ID_ENV_KEY]);
    } else {
      setCliProcessTitle();
    }
  }
  // 真实 zcode CLI 进程里仍可能有少量路径直接读取 process.env。
  // 入口先清洗用户 shell 注入的 NODE_ENV、代理和证书变量；网络变量只封存给后续 Bash/tool 子进程恢复。
  applyCliRuntimeEnvSanitization(process.env);
  const isProtocol = argv[0] === STORAGE_MIGRATION_COMMAND || isProtocolServerInvocation(argv);
  const isTui = isTuiInvocation(argv);
  mintStandaloneCuaCredentialsIfEligible({
    isProtocol,
    isPluginHost: isPluginHostInvocation(argv),
    platform: process.platform,
  });
  if (isProtocol) installProtocolStderrBoundary(process.stderr);
  const lifecycle =
    isProtocol && argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage")
      ? createProtocolProcessLifecycle()
      : undefined;
  // app-server/agent-server 的 stdout 是严格的 ZCode Protocol 帧通道，三方 SDK 的
  // console.debug 等普通输出不能直接写入 stdout。必须在加载 run/bootstrap 之前将
  // 进程级 console 统一引导到 stderr，否则任意依赖的一行普通日志都会触发传输层 JSON 解析崩溃。
  // TUI 同样独占 stdout；AI SDK 的首条提示使用 console.info，不能绕过 stderr 捕获。
  const restoreConsole =
    isProtocol || isTui ? installStderrConsoleBoundary(process.stderr) : undefined;
  const runtimeWarnings = interceptKnownRuntimeWarnings(process.stderr);
  const tuiStderr = isTui ? interceptTuiStderr(process.stderr) : undefined;
  const stderr = tuiStderr?.passthrough ?? process.stderr;
  const disposeProcessErrorBoundary = isProtocol
    ? installCliProcessErrorBoundary({
        stderr,
        onFatal: (reason) => {
          if (lifecycle)
            lifecycle.requestShutdown(new Error("Uncaught process error", { cause: reason }));
          else process.exit(1);
        },
      })
    : undefined;

  try {
    if (argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage"))
      Object.assign(process.env, await ensureSeaRuntimeTools());
    lifecycle?.signal.throwIfAborted();
    const context = {
      argv,
      stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    };
    // plugin-host 只承载插件；先导入 run 会求值 Agent、工具注册表和工作流模块，
    // 即使最终没有创建 AgentRuntime，也会让每个 MCP 子进程持有整套业务依赖。
    if (isPluginHostInvocation(argv)) {
      process.exitCode = await runPluginHostCommand(context, argv.slice(1));
      return;
    }
    if (argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage")) {
      const { prepareCliProviderRuntimeEnv } = await import("./provider-runtime-env.js");
      Object.assign(
        process.env,
        await prepareCliProviderRuntimeEnv({
          argv,
          env: process.env,
        }),
      );
    }
    lifecycle?.signal.throwIfAborted();
    const { run } = await import("./run.js");
    lifecycle?.signal.throwIfAborted();
    const exitCode = await run(context, {
      protocolLifecycle: lifecycle,
      protocolInput: lifecycle?.input,
    });

    process.exitCode = exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await waitForPendingWarnings();
    // 生命周期和 stderr guard 一直保留到实际退出，迟到的错误不能恢复递归写坏流。
    if (lifecycle) {
      await lifecycle.complete(normalizeProcessExitCode(process.exitCode));
    } else {
      if (tuiStderr) {
        tuiStderr.restore();
      }
      runtimeWarnings.restore();
      disposeProcessErrorBoundary?.();
      // plugin-host 的 main() 在 MCP server.connect() 完成后会返回，但此时
      // stdio handle 正是服务的存活条件。一次性 CLI watchdog 不能把它误判为泄漏并强退。
      const exitCode = normalizeProcessExitCode(process.exitCode);
      if (!isPluginHostInvocation(argv) || exitCode !== 0) {
        scheduleCliExitWatchdog({ exitCode });
      }
      restoreConsole?.();
    }
  }
}

function normalizeProcessExitCode(exitCode: string | number | null | undefined): number {
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  if (typeof exitCode === "string") {
    const parsed = Number(exitCode);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

function waitForPendingWarnings(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
