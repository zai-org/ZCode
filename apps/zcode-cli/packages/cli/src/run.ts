import { ToolSearchModeSchema } from "@zcode/contracts";
import {
  STORAGE_MIGRATION_COMMAND,
  storageMigrationReportSchema,
} from "@zcode/shared/sqlite-migrations";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";
import { createNodeLoggerFactory } from "@zcode/adapters";
import { getRuntimeInfo, type PresentationSurface } from "@zcode/core";
import { color, formatJson, supportsColor } from "@zcode/core";
import { getZCodeCopy, isUiLocale, type UiLocale } from "@zcode/i18n";
import type { RunContext, GlobalOptions, GlobalOutputFormat } from "@zcode/shared-types";
import {
  applyCliRuntimeEnvSanitization,
  loadCliDotenv,
  prepareCliRuntimeEnv,
  shouldLoadCliDotenvForProtocolServer,
} from "./env.js";
import { formatCliHelp } from "./help.js";
import { runHooksCommand } from "./hooks-trust-command.js";
import { detectCliLocale } from "./locale.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { runEmbeddedSearchCli } from "./internal-search/embedded-search-cli.js";
import { runCommandsCommand } from "./commands-command.js";
import { resolveCliCwd } from "./cwd.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { CLI_COMMAND_NAME, CLI_PROCESS_NAME } from "./process-name.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { isDwfChildInvocation, runDwfChildCommand } from "./dwf-child-command.js";
import { runPrompt } from "./prompt-command.js";
import { runPluginsCommand, type PluginsCommandFlags } from "./plugins-command.js";
import { runSkillsCommand } from "./skills-command.js";
import { runTuiCommand } from "./tui-command.js";
import { resolveBrowserStateSelection, validateBrowserStateFlags } from "./browser-state-option.js";
import {
  DEFAULT_CLI_WORKFLOW_MODE,
  normalizeWorkflowModeOption,
  WORKFLOW_MODE_SCOPE_ERROR,
} from "./workflow-mode.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  CliTargetRequest,
  RunDependencies,
} from "./cli-types.js";

export type { RunDependencies } from "./cli-types.js";

declare const __CLI_VERSION__: string | undefined;

const version = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0";

const EMPTY_TARGET_ERROR = "--target requires non-empty text.";
const DEFAULT_HEADLESS_PROMPT_MODE: CliPermissionMode = "yolo";
const FORCE_MCS_SCOPE_ERROR = "--force-mcs can only be used with --prompt, --target, or tui.";
const TOOLSEARCH_MODE_SCOPE_ERROR =
  "--toolsearch-mode can only be used with --prompt, --target, or tui.";
const TOTAL_TOKENS_REMINDER_SCOPE_ERROR =
  "--total-tokens-reminder can only be used with --prompt, --target, or tui.";
const TOTAL_TOKENS_REMINDER_VALUE_ERROR = "--total-tokens-reminder must be one of on, off.";
const AGENT_ALWAYS_BACKGROUND_SCOPE_ERROR =
  "--agent-always-background can only be used with --prompt, --target, or tui.";
const AGENT_ALWAYS_BACKGROUND_VALUE_ERROR = "--agent-always-background must be one of on, off.";
const TARGET_REPLACE_REQUIRES_TARGET_ERROR = "--target-replace requires --target.";
const TARGET_CONFLICTS_WITH_PROMPT_ERROR =
  '--target cannot be used with --prompt. Use either --target <objective> or --prompt "/goal <objective>".';
const BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR =
  "--browser-executable requires --browser-use=headless.";
const BROWSER_USE_SCOPE_ERROR =
  "--browser-use=headless can only be used with --prompt, --target, or tui.";
const SURFACE_SCOPE_ERROR =
  "--surface can only be used with --prompt, --target, app-server, or agent-server.";
const MEMORY_BENCH_SCOPE_ERROR = "--memory-bench can only be used with -p/--prompt.";

const pluginsCommandFlags = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): PluginsCommandFlags => ({
  ...(values.all === true ? { all: true } : {}),
  ...(values.available === true ? { available: true } : {}),
  ...(values["keep-data"] === true ? { keepData: true } : {}),
  ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
  ...(Array.isArray(values.sparse) ? { sparse: values.sparse as string[] } : {}),
});

const commandName = (positionals: string[]): string => positionals[0] ?? "tui";

const isForceMcsSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean =>
  typeof input.prompt === "string" ||
  input.targetRequest !== undefined ||
  commandName(input.positionals) === "tui";

const isPresentationSurfaceSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean => {
  const command = commandName(input.positionals);
  return (
    typeof input.prompt === "string" ||
    input.targetRequest !== undefined ||
    command === "app-server" ||
    command === "agent-server"
  );
};

const globalOptions = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
  locale: UiLocale | undefined,
  detectedLocale: GlobalOptions["detectedLocale"],
  browserUse: GlobalOptions["browserUse"],
  browserExecutable: GlobalOptions["browserExecutable"],
  outputFormat: GlobalOptions["outputFormat"],
): GlobalOptions => {
  return {
    browserExecutable,
    browserUse,
    detectedLocale,
    force: values.force === true,
    json: values.json === true,
    locale,
    ...(values["memory-bench"] === true ? { memoryBench: true } : {}),
    noColor: values["no-color"] === true,
    ...(outputFormat ? { outputFormat } : {}),
    verbose: values.verbose === true,
  };
};

const OUTPUT_FORMATS: readonly GlobalOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Validate --output-format. Rejecting an unknown value matters more than it
 * looks: a caller that misspells it would otherwise get plain text back and
 * silently parse nothing.
 */
const normalizeOutputFormat = (value: string | undefined): GlobalOutputFormat | undefined => {
  if (value === undefined) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as GlobalOutputFormat;
  throw new Error(
    `--output-format must be one of ${OUTPUT_FORMATS.join(", ")} (received: ${value}).`,
  );
};

const normalizeLocaleOption = (value: string | undefined): UiLocale | undefined => {
  if (value === undefined) return undefined;
  if (isUiLocale(value)) return value;
  throw new Error(getZCodeCopy().cli.errors.localeUnsupported(value));
};

const normalizePromptMode = (value: string | undefined): CliPermissionMode | undefined => {
  if (value === undefined) return undefined;
  const mode = value.toLowerCase();
  if (
    mode === "build" ||
    mode === "plan" ||
    mode === "edit" ||
    mode === "yolo" ||
    mode === "guarded"
  )
    return mode;
  throw new Error(
    `Unsupported --mode value: ${value}. Supported modes: build, edit, plan, yolo, guarded.`,
  );
};

const normalizeBrowserUse = (value: string | undefined): GlobalOptions["browserUse"] => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "headless") return "headless";
  throw new Error(`Unsupported --browser-use value: ${value}. Supported value: headless.`);
};

const normalizePresentationSurface = (value: string | undefined): PresentationSurface => {
  if (value === undefined || value.toLowerCase() === "terminal") return "terminal";
  if (value.toLowerCase() === "desktop") return "zcode_desktop";
  throw new Error(`Unsupported --surface value: ${value}. Supported surfaces: terminal, desktop.`);
};

const normalizeTargetRequest = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): CliTargetRequest | undefined => {
  const rawTarget = values.target as string | undefined;
  const replaceExisting = values["target-replace"] === true;
  if (rawTarget === undefined) {
    if (replaceExisting) {
      throw new Error(TARGET_REPLACE_REQUIRES_TARGET_ERROR);
    }
    return undefined;
  }

  const objective = rawTarget.trim();
  if (objective.length === 0) {
    throw new Error(EMPTY_TARGET_ERROR);
  }

  return {
    objective,
    replaceExisting,
  };
};

const buildHeadlessTargetCommand = (targetRequest: CliTargetRequest): string =>
  targetRequest.replaceExisting
    ? `/goal replace ${targetRequest.objective}`
    : `/goal ${targetRequest.objective}`;

const writeHelp = (
  stdout: NodeJS.WriteStream,
  locale?: UiLocale,
  detectedLocale?: GlobalOptions["detectedLocale"],
): void => {
  stdout.write(formatCliHelp(version, locale, detectedLocale));
};

const runDoctor = (ctx: RunContext, options: GlobalOptions, workingDirectory: string): number => {
  const runtime = getRuntimeInfo();
  const payload = {
    cli: {
      name: CLI_COMMAND_NAME,
      processName: CLI_PROCESS_NAME,
      version,
    },
    runtime: {
      arch: runtime.arch,
      cwd: workingDirectory,
      execPath: runtime.execPath,
      node: runtime.node,
      platform: runtime.platform,
      processTitle: process.title,
      sea: runtime.sea,
    },
    packaging: {
      default: "node-bundle",
      sea: "optional",
    },
  };

  if (options.json) {
    ctx.stdout.write(formatJson(payload));
    return 0;
  }

  const colors = supportsColor(ctx.stdout, options.noColor);
  ctx.stdout.write(`${color.bold("zcode doctor", colors)}\n`);
  ctx.stdout.write(`version: ${payload.cli.version}\n`);
  ctx.stdout.write(`process: ${payload.runtime.processTitle}\n`);
  ctx.stdout.write(`node: ${payload.runtime.node}\n`);
  ctx.stdout.write(`platform: ${payload.runtime.platform}/${payload.runtime.arch}\n`);
  ctx.stdout.write(`sea: ${payload.runtime.sea ? "yes" : "no"} (${payload.packaging.sea})\n`);
  ctx.stdout.write(`default artifact: ${payload.packaging.default}\n`);

  if (options.verbose) {
    ctx.stdout.write(`execPath: ${payload.runtime.execPath}\n`);
    ctx.stdout.write(`cwd: ${payload.runtime.cwd}\n`);
  }

  return 0;
};

const runZCodeProtocolCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  presentationSurface: PresentationSurface,
  prepareStorageOnly = false,
): Promise<number> => {
  try {
    const env = prepareCliRuntimeEnv(deps.env ?? process.env);
    const workingDirectory = (deps.cwd ?? process.cwd)();
    // 打包态 app-server 是 desktop host 的内部协议子进程。
    // 如果这里继续从 workspace 向上读取用户 .env，读文件失败或环境污染会在协议建立前
    // 直接退出，外层只能看到 ZCode agent transport closed。
    const dotenvResult = shouldLoadCliDotenvForProtocolServer(env)
      ? (deps.loadDotenv ?? loadCliDotenv)({
          cwd: workingDirectory,
          env,
        })
      : {
          keys: [],
          loaded: false,
        };
    applyCliRuntimeEnvSanitization(env);

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const runProtocolAgent =
      deps.runZCodeProtocolAgent ?? (await loadBootstrapModule()).runZCodeProtocolAgent;
    await runProtocolAgent({
      lifecycle: deps.protocolLifecycle,
      cwd: workingDirectory,
      env,
      input: deps.protocolInput ?? ctx.stdin,
      output: ctx.stdout,
      presentationSurface,
      prepareStorageOnly,
      version,
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};

export const run = async (ctx: RunContext, deps: RunDependencies = {}): Promise<number> => {
  if (ctx.argv[0] === STORAGE_MIGRATION_COMMAND) {
    try {
      if (ctx.argv.length !== 1) throw new Error("storage-migrate accepts no arguments");
      const migrateStorage =
        deps.migrateStorage ??
        (async () => {
          // 复用正常启动的配置解析与存储入口，不初始化 Provider/MCP/Agent 运行态。
          const { createConfig, resolvePath } = await import("@zcode/adapters/config");
          const { openStartupSqliteSessionStore } = await import("@zcode/adapters/storage");
          const config = createConfig({ env: deps.env ?? process.env });
          const store = await openStartupSqliteSessionStore({
            dbPath: resolvePath(config.config.storage.sessionDbPath),
          });
          try {
            return store.migrationResult;
          } finally {
            store.close();
          }
        });
      const report = storageMigrationReportSchema.parse({
        version: 1,
        kind: "storage-migrated",
        ...(await migrateStorage()),
      });
      ctx.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    } catch (error) {
      ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (ctx.argv[0] === "__internal-search") {
    return runEmbeddedSearchCli(ctx.argv.slice(1), {
      cwd: (deps.cwd ?? process.cwd)(),
      stderr: ctx.stderr,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
    });
  }

  if (isPluginHostInvocation(ctx.argv)) {
    return await runPluginHostCommand(ctx, ctx.argv.slice(1));
  }

  // 与 plugin host 同理，且必须同样在 parseArgs 之前：SEA 下 dwf 的沙箱子进程是本二进制的
  // 自 re-exec，argv 末位是入口文件路径——交给严格 parseArgs 只会报未知参数。
  if (isDwfChildInvocation(ctx.argv)) {
    return await runDwfChildCommand(ctx, ctx.argv.slice(1));
  }

  if (ctx.argv[0] === "hooks") {
    return await runHooksCommand(ctx, deps, version);
  }

  let parsed: ReturnType<typeof parseGlobalArgs>;
  let toolDisallowlist: readonly string[] | undefined;

  try {
    const extracted = extractDisallowedToolsArgs(ctx.argv);
    parsed = parseGlobalArgs(extracted.args);
    toolDisallowlist = extracted.toolDisallowlist;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n\n`);
    writeHelp(ctx.stderr);
    return 1;
  }

  let locale: UiLocale | undefined;
  try {
    locale = normalizeLocaleOption(parsed.values.locale as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  let mode: CliPermissionMode | undefined;
  let workflowModeOption: ReturnType<typeof normalizeWorkflowModeOption>;
  let browserUse: GlobalOptions["browserUse"];
  let presentationSurface: PresentationSurface;
  try {
    mode = normalizePromptMode(parsed.values.mode as string | undefined);
    workflowModeOption = normalizeWorkflowModeOption(
      parsed.values["workflow-mode"] as string | undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    browserUse = normalizeBrowserUse(parsed.values["browser-use"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  try {
    presentationSurface = normalizePresentationSurface(parsed.values.surface as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const browserExecutable = parsed.values["browser-executable"] as string | undefined;
  if (browserExecutable !== undefined && browserUse !== "headless") {
    ctx.stderr.write(`${BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR}\n`);
    return 1;
  }
  const browserStateExplicitPath = parsed.values["browser-state"] as string | undefined;
  const browserStateDisabled = parsed.values["no-browser-state"] === true;
  const browserStateFlagError = validateBrowserStateFlags({
    browserUse,
    explicitPath: browserStateExplicitPath,
    disabled: browserStateDisabled,
  });
  if (browserStateFlagError) {
    ctx.stderr.write(`${browserStateFlagError}\n`);
    return 1;
  }

  const resumeRequest: CliResumeRequest = {
    continueSession: parsed.values.continue === true,
    resumeSessionId: parsed.values.resume as string | undefined,
  };
  if (resumeRequest.continueSession && resumeRequest.resumeSessionId) {
    ctx.stderr.write("--resume and --continue cannot be used together.\n");
    return 1;
  }

  const env = prepareCliRuntimeEnv(deps.env ?? process.env);
  const detectedLocale = detectCliLocale(env);
  let outputFormat: GlobalOptions["outputFormat"];
  try {
    outputFormat = normalizeOutputFormat(parsed.values["output-format"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const options = globalOptions(
    parsed.values,
    locale,
    detectedLocale,
    browserUse,
    browserExecutable,
    outputFormat,
  );
  const parsedToolsearchMode = ToolSearchModeSchema.safeParse(
    parsed.values["toolsearch-mode"] ?? "off",
  );
  if (!parsedToolsearchMode.success) {
    ctx.stderr.write("--toolsearch-mode must be one of auto, native, local, off.\n");
    return 1;
  }
  const toolsearchMode = parsedToolsearchMode.data;
  const totalTokensReminderOption = parsed.values["total-tokens-reminder"];
  if (
    totalTokensReminderOption !== undefined &&
    totalTokensReminderOption !== "on" &&
    totalTokensReminderOption !== "off"
  ) {
    ctx.stderr.write(`${TOTAL_TOKENS_REMINDER_VALUE_ERROR}\n`);
    return 1;
  }
  const totalTokensReminder = totalTokensReminderOption === "on";
  const agentAlwaysBackgroundOption = parsed.values["agent-always-background"];
  if (
    agentAlwaysBackgroundOption !== undefined &&
    agentAlwaysBackgroundOption !== "on" &&
    agentAlwaysBackgroundOption !== "off"
  ) {
    ctx.stderr.write(`${AGENT_ALWAYS_BACKGROUND_VALUE_ERROR}\n`);
    return 1;
  }
  // 缺省开启：Agent 总在后台运行（07-subagent.md「ZCode 当前实现」）。
  const agentAlwaysBackground = agentAlwaysBackgroundOption !== "off";
  const forceMcs = parsed.values["force-mcs"] === true;
  let targetRequest: CliTargetRequest | undefined;
  try {
    targetRequest = normalizeTargetRequest(parsed.values);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  if (targetRequest && typeof parsed.values.prompt === "string") {
    ctx.stderr.write(`${TARGET_CONFLICTS_WITH_PROMPT_ERROR}\n`);
    return 1;
  }

  if (
    parsed.values.surface !== undefined &&
    !isPresentationSurfaceSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${SURFACE_SCOPE_ERROR}\n`);
    return 1;
  }

  if (parsed.values.help === true) {
    writeHelp(ctx.stdout, options.locale, options.detectedLocale);
    return 0;
  }

  if (parsed.values.version === true) {
    ctx.stdout.write(`${version}\n`);
    return 0;
  }

  if (
    options.memoryBench &&
    (typeof parsed.values.prompt !== "string" || parsed.positionals.length > 0)
  ) {
    ctx.stderr.write(`${MEMORY_BENCH_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    browserUse === "headless" &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${BROWSER_USE_SCOPE_ERROR}\n`);
    return 1;
  }

  // app-server 的 mode 归 Host 决定（launch.md「The standalone CLI: `--workflow-mode`」），
  // 其余子命令不建会话；作用域与 --force-mcs 相同：只有 --prompt、--target 与 TUI。
  if (
    workflowModeOption !== undefined &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${WORKFLOW_MODE_SCOPE_ERROR}\n`);
    return 1;
  }
  const workflowMode = workflowModeOption ?? DEFAULT_CLI_WORKFLOW_MODE;

  // 只对本次启动生效的参数，作用域相同；报第一个用到的参数。
  const launchOnlyScopeError = (
    [
      [parsed.values["toolsearch-mode"] !== undefined, TOOLSEARCH_MODE_SCOPE_ERROR],
      [totalTokensReminderOption !== undefined, TOTAL_TOKENS_REMINDER_SCOPE_ERROR],
      [agentAlwaysBackgroundOption !== undefined, AGENT_ALWAYS_BACKGROUND_SCOPE_ERROR],
      [forceMcs, FORCE_MCS_SCOPE_ERROR],
    ] as const
  ).find(([used]) => used)?.[1];
  if (
    launchOnlyScopeError &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${launchOnlyScopeError}\n`);
    return 1;
  }

  let workingDirectory: string;
  try {
    workingDirectory = resolveCliCwd({
      cwd: deps.cwd ?? process.cwd,
      requestedCwd: parsed.values.cwd as string | undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  const commandDeps: RunDependencies = {
    ...deps,
    cwd: () => workingDirectory,
    env,
    logger:
      deps.logger ??
      createNodeLoggerFactory({ env }).createLogger("zcode").child({ module: "cli" }),
    loadDotenv: (dotenvOptions = {}) => {
      const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)(dotenvOptions);
      applyCliRuntimeEnvSanitization(dotenvOptions.env ?? env);
      return dotenvResult;
    },
  };

  if (browserUse === "headless") {
    const browserState = await resolveBrowserStateSelection({
      explicitPath: browserStateExplicitPath,
      disabled: browserStateDisabled,
      launchCwd: (deps.cwd ?? process.cwd)(),
      env,
    });
    if (!browserState.ok) {
      ctx.stderr.write(`${browserState.error}\n`);
      return 1;
    }
    for (const notice of browserState.notices) ctx.stderr.write(`${notice}\n`);
    if (browserState.selection) {
      options.browserState = browserState.selection;
      commandDeps.logger?.info("Browser state file loaded", {
        event: "cli.browser_state.loaded",
        module: "cli",
        ...browserState.logFields,
      });
    }
  }

  if (typeof parsed.values.prompt === "string") {
    return await runPrompt(
      ctx,
      parsed.values.prompt,
      parsed.values.attach ?? [],
      options,
      commandDeps,
      version,
      mode ?? DEFAULT_HEADLESS_PROMPT_MODE,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      toolsearchMode,
      presentationSurface,
      workflowMode,
      totalTokensReminder,
      agentAlwaysBackground,
    );
  }

  if (targetRequest) {
    return await runPrompt(
      ctx,
      buildHeadlessTargetCommand(targetRequest),
      [],
      options,
      commandDeps,
      version,
      mode,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      toolsearchMode,
      presentationSurface,
      workflowMode,
      totalTokensReminder,
      agentAlwaysBackground,
    );
  }

  switch (commandName(parsed.positionals)) {
    case "help":
      writeHelp(ctx.stdout, options.locale, options.detectedLocale);
      return 0;
    case "version":
      ctx.stdout.write(`${version}\n`);
      return 0;
    case "agent-server":
    case "app-server":
      return await runZCodeProtocolCommand(
        ctx,
        options,
        commandDeps,
        presentationSurface,
        parsed.values["prepare-storage"] === true,
      );
    case "doctor":
      return runDoctor(ctx, options, workingDirectory);
    case "login":
      return await runLoginCommand(
        ctx,
        options,
        commandDeps,
        parsed.values["no-browser"] === true,
        parsed.positionals.slice(1),
      );
    case "logout":
      return await runLogoutCommand(ctx, options, commandDeps);
    case "commands":
      return await runCommandsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "plugin":
    case "plugins":
      return await runPluginsCommand(
        ctx,
        options,
        commandDeps,
        parsed.positionals.slice(1),
        pluginsCommandFlags(parsed.values),
      );
    case "skills":
      return await runSkillsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "tui":
      return await runTuiCommand(
        ctx,
        options,
        commandDeps,
        version,
        mode,
        resumeRequest,
        toolDisallowlist,
        forceMcs,
        toolsearchMode,
        workflowMode,
        totalTokensReminder,
        agentAlwaysBackground,
      );
    default:
      ctx.stderr.write(`Unknown command: ${commandName(parsed.positionals)}\n\n`);
      writeHelp(ctx.stderr, options.locale, options.detectedLocale);
      return 1;
  }
};
