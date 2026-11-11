import type { ToolSearchMode } from "@zcode/contracts";
import { getDefaultConfigPath, updateUiLocaleInFileConfig } from "@zcode/adapters/config";
import type { SessionEvent } from "@zcode/contracts";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { DEFAULT_LOCALE, type SupportedLocale } from "@zcode/i18n";
import type { TuiRequestPermission } from "@zcode/tui";
import type { GlobalOptions } from "@zcode/shared-types";
import type { DynamicWorkflowMode } from "@zcode/shared";
import { createCommandCenter, parseSlashCommand } from "./command-center.js";
import type { CommandCenterApp } from "./command-center.js";
import { resolveDisplayLocale } from "./locale.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
// 复用防御式 runtime 读取：subscribeEvents 不在 app 的静态类型面上，
// 两处各写一份「怎么把它读出来」就会在方法改名时只修好一处。
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import { createTuiSessionEventRelay } from "./tui-session-event-relay.js";
import { attachTuiAppQueries, readTuiSessionMetadata } from "./tui-prompt-handler-queries.js";
import {
  createTuiProcessRuntimeState,
  prepareTuiAppRuntime,
} from "./tui-prompt-handler-runtime.js";
import { DEFAULT_CLI_CLEANUP_TIMEOUT_MS, runCliCleanupWithTimeout } from "./shutdown.js";
import {
  configureApiKeyForTui,
  loginBigmodelForTui,
  loginForTui,
  logoutForTui,
} from "./tui-auth.js";
import {
  listCustomCommandsForTui,
  listSessionsForTui,
  listSkillsForTui,
  loadCustomCommandForTui,
} from "./tui-command-data.js";
import {
  currentCliMode,
  readTuiMode,
  TUI_TITLE_GENERATION_CONFIG,
  type TuiPromptHandler,
} from "./tui-command-state.js";
import { createTuiModelAvailabilityChecker } from "./tui-login-state.js";
import { withTuiMetadata } from "./tui-submit-metadata.js";
import { DEFAULT_CLI_WORKFLOW_MODE, resolveWorkflowModeRuntimeConfig } from "./workflow-mode.js";
import type {
  CliModeState,
  CliPermissionMode,
  CliResumeRequest,
  CliRuntimeMode,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

export function createTuiSubmitPrompt(
  deps: RunDependencies,
  modeState: CliModeState,
  version: string,
  resumeRequest: CliResumeRequest = { continueSession: false },
  uiLocale?: GlobalOptions["locale"],
  uiDetectedLocale?: GlobalOptions["detectedLocale"],
  startupLocale: SupportedLocale = DEFAULT_LOCALE,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  toolsearchMode: ToolSearchMode = "off",
  browserUse?: GlobalOptions["browserUse"],
  browserExecutable?: GlobalOptions["browserExecutable"],
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
): TuiPromptHandler {
  let app: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>> | undefined;
  let activeUiLocale = uiLocale;
  // 进程级句柄（telemetry / Provider Registry / endpoint 路由）跨 App 替换复用，见 runtime 文件。
  const processRuntime = createTuiProcessRuntimeState();
  let closeHandlerPromise: Promise<void> | undefined;
  const closePromises = new WeakMap<object, Promise<void>>();
  const browserRuntimes = new WeakMap<
    object,
    NonNullable<ReturnType<typeof createCliHeadlessBrowserRuntime>>
  >();
  // Bug 根因：审批入口原先只在单次 submitPrompt/sendInput 调用内有效，调用结束即恢复为空；
  // 通知驱动的回合和 CreateSession 建的后台会话在这之外询问，只能被 fail closed 拒绝。
  // 现在由 TUI 挂载时登记、卸载时注销，入口只有这一个 owner，不再按提交切换。
  let registeredRequestPermission: TuiRequestPermission | undefined;
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  const permissionBroker: NonNullable<ZCodeAppOptions["permissionBroker"]> = {
    requestPermission: async (request, requestOptions) => {
      const requestPermission = registeredRequestPermission;
      if (!requestPermission) {
        return {
          decision: "deny",
          reason: `No interactive approval handler configured for ${request.toolName}`,
          resolvedAt: new Date(),
        };
      }

      return await requestPermission(request, requestOptions);
    },
  };

  const closeApp = async (targetApp = app): Promise<void> => {
    if (!targetApp) return;
    const closeKey = targetApp as object;
    let closePromise = closePromises.get(closeKey);
    if (!closePromise) {
      closePromise = (async () => {
        await runCliCleanupWithTimeout(async () => targetApp.close?.(), cleanupTimeoutMs);
        // App/session 关闭悬空或失败时仍需释放 CLI 自己启动的 Chromium。
        await runCliCleanupWithTimeout(
          async () => browserRuntimes.get(closeKey)?.close(),
          cleanupTimeoutMs,
        );
      })();
      closePromises.set(closeKey, closePromise);
    }
    await closePromise;
  };

  // ── 跨回合常驻的会话事件订阅──
  // per-turn 的 onEvent 在回合结束即死，收不到出回合事件（dwf 进度、后台通知驱动的回合）。
  const sessionEventRelay = createTuiSessionEventRelay({
    currentRuntime: () => (app as { runtime?: unknown } | undefined)?.runtime,
    readSubscriber: readRuntimeEventSubscriber,
  });

  const replaceApp = async (
    factory: () => Promise<Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>>,
  ): Promise<CommandCenterApp> => {
    const previousApp = app;
    const nextApp = await factory();
    app = nextApp;
    if (previousApp && previousApp !== nextApp) {
      await closeApp(previousApp);
    }
    // 常驻订阅要跟着换 app 重挂：这里是 /new、/resume、/fork 共同的唯一收口，
    // 漏挂的后果是换 session 后 TUI 再也收不到出回合事件（dwf 进度、通知驱动回合）。
    sessionEventRelay.reattach();
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const createApp = async (request: CliResumeRequest) => {
    if (closeHandlerPromise) throw new Error("TUI prompt handler is closed");
    const {
      appEnv,
      configuredDefaultModelSelection,
      createAppFactory,
      providerRegistryRuntime,
      sessionId,
      workingDirectory,
    } = await prepareTuiAppRuntime(deps, version, request, processRuntime);
    const providerEndpointRoutingPort = processRuntime.providerEndpointRoutingPort;
    const browserRuntime = createCliHeadlessBrowserRuntime({ browserExecutable, browserUse }, deps);
    let createdApp: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>;
    try {
      createdApp = await createAppFactory({
        modelSelectionMode: "cli-default",
        standaloneSessionControl: true,
        browserControlPort: browserRuntime?.browserControlPort,
        env: appEnv,
        projectConfigPath: deps.projectConfigPath,
        ...(providerEndpointRoutingPort ? { providerEndpointRoutingPort } : {}),
        providerRegistry: providerRegistryRuntime.runtime.registryService,
        configuredDefaultModelSelection,
        ...(providerRegistryRuntime.providerRuntimeHeadersPort
          ? {
              providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
            }
          : {}),
        resume: sessionId !== undefined,
        runtimeConfig: {
          ...(modeState.override ? { mode: modeState.override } : {}),
          ...(toolDisallowlist ? { toolDisallowlist } : {}),
          toolSearch: { mode: toolsearchMode },
          ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
          // 首个 app 与 /new、/resume、fork 都经这里创建，mode 因此在进程内一致。
          ...resolveWorkflowModeRuntimeConfig(workflowMode),
          modelStreaming: "on",
          titleGeneration: TUI_TITLE_GENERATION_CONFIG,
          workingDirectory,
        },
        permissionBroker,
        sessionId,
        skipUserConfig: deps.skipUserConfig,
        uiDetectedLocale,
        uiLocale: activeUiLocale,
        userConfigPath: deps.userConfigPath,
        version,
      });
    } catch (error) {
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      throw error;
    }
    if (browserRuntime) browserRuntimes.set(createdApp as object, browserRuntime);
    // 初始化在等待旧身份导入时 TUI 可能已关闭；迟到 App 不能重新成为当前会话。
    if (closeHandlerPromise) {
      await closeApp(createdApp);
      throw new Error("TUI prompt handler is closed");
    }
    modeState.current = readTuiMode(createdApp, currentCliMode(modeState));
    return createdApp;
  };

  const getApp = async (): Promise<CommandCenterApp> => {
    app ??= await createApp(resumeRequest);
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp(
          sessionId
            ? {
                continueSession: false,
                resumeSessionId: sessionId,
              }
            : {
                continueSession: true,
              },
        ),
    );
  };

  const newApp = async (): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp({
          continueSession: false,
        }),
    );
  };

  const setCliMode = async (nextMode: CliPermissionMode): Promise<CliRuntimeMode> => {
    modeState.override = nextMode;

    if (app) {
      const modeCapableApp = app as ModeCapableApp;
      if (modeCapableApp.setMode) {
        const result = await modeCapableApp.setMode(nextMode);
        modeState.current = readTuiMode(modeCapableApp, result.mode);
        return modeState.current;
      }

      modeCapableApp.runtime.updateConfig({ mode: nextMode });
    }

    modeState.current = app ? readTuiMode(app, nextMode) : nextMode;
    return modeState.current;
  };

  const commandCenter = createCommandCenter({
    forkApp: async (targetCheckpointId) => {
      const activeApp = await getApp();
      const result = await activeApp.forkFromCheckpoint?.({ targetCheckpointId });
      if (!result) {
        throw new Error("Forking is not available in this client.");
      }
      await replaceApp(
        async () =>
          await createApp({
            continueSession: false,
            resumeSessionId: result.forkedSessionId,
          }),
      );
      return {
        copiedMessageCount: result.copiedMessageCount,
        forkedSessionId: result.forkedSessionId,
        response: `${result.response}\nSwitched to forked session ${result.forkedSessionId}.`,
        restoredFileCount: result.restoredFileCount ?? result.restoredFiles?.length ?? 0,
      };
    },
    getApp,
    getMode: () => currentCliMode(modeState),
    getLocale: () =>
      app?.getLocale?.() ?? resolveDisplayLocale(activeUiLocale, uiDetectedLocale) ?? startupLocale,
    hasSelectableModels: createTuiModelAvailabilityChecker(getApp),
    listCustomCommands: () => listCustomCommandsForTui(deps),
    listSessions: () => listSessionsForTui(deps),
    listSkills: () => listSkillsForTui(deps),
    configureApiKey: (options) => configureApiKeyForTui(deps, options),
    login: (options) => loginForTui(deps, options),
    loginBigmodel: (options) => loginBigmodelForTui(deps, options),
    loadCustomCommand: (name) => loadCustomCommandForTui(deps, name),
    newApp,
    recordInputHistory: async (input, kind) => {
      await app?.recordInputHistory?.(input, kind);
    },
    resumeApp,
    saveDefaultModelSelection: async (selection) => {
      const runtime = await processRuntime.providerRegistryRuntimePromise;
      if (!runtime?.modelSelectionConfigRepository) {
        throw new Error("Default model configuration storage is unavailable.");
      }
      await runtime.modelSelectionConfigRepository.saveConfiguredDefault(selection);
    },
    logout: () => logoutForTui(deps),
    setLocale: async (locale) => {
      if (app?.setLocale) {
        const result = await app.setLocale(locale);
        activeUiLocale = locale;
        return result;
      }
      activeUiLocale = locale;
      const persisted = await updateUiLocaleInFileConfig(
        deps.userConfigPath ?? getDefaultConfigPath(),
        locale,
      );
      return {
        configPath: persisted.path,
        locale: resolveDisplayLocale(locale, uiDetectedLocale) ?? "en-US",
        requestedLocale: locale,
      };
    },
    setMode: setCliMode,
    workflowMode,
  });

  const submitPrompt: TuiPromptHandler = async (input, options) => {
    const result = await commandCenter(input, options);
    return app ? { ...result, ...(await readTuiSessionMetadata(await getApp())) } : result;
  };

  submitPrompt.setMode = async (nextMode) => ({ mode: await setCliMode(nextMode) });

  submitPrompt.registerPermissionRequester = (requestPermission) => {
    registeredRequestPermission = requestPermission;
    return () => {
      // 只注销自己：重新挂载时新入口先登记，旧入口的迟到注销不能把它清掉。
      if (registeredRequestPermission === requestPermission)
        registeredRequestPermission = undefined;
    };
  };

  submitPrompt.sendInput = async (input, options) => {
    // Model/effort changes configure subsequent requests, including during an active turn.
    const command = parseSlashCommand(typeof input === "string" ? input : input.text);
    if (command?.type === "known" && (command.name === "model" || command.name === "effort")) {
      return {
        kind: "command_result",
        result: await submitPrompt(input, {
          ...options,
          abortSignal: options?.abortSignal ?? new AbortController().signal,
        }),
      };
    }
    const activeApp = await getApp();
    if (activeApp.sendInput) {
      const result = await activeApp.sendInput(input, options);
      if (result.kind !== "started_turn") return result;
      return withTuiMetadata(result.result, activeApp, currentCliMode(modeState));
    }

    return withTuiMetadata(
      await activeApp.submitPrompt(input, options),
      activeApp,
      currentCliMode(modeState),
    );
  };

  attachTuiAppQueries(submitPrompt, getApp);

  submitPrompt.subscribeSessionEvents = (sink: (event: SessionEvent) => void) => {
    const unsubscribe = sessionEventRelay.addSink(sink);
    // app 还没建好时首次实挂会落空；建好后再挂一次（reattach 幂等，不会重复扇出）。
    void getApp().then(
      () => sessionEventRelay.reattach(),
      () => undefined,
    );
    return unsubscribe;
  };

  // 主会话 id：给 TUI 做会话闸门用（actor/子会话事件保留子 sessionId 投进同一个 sink 集）。
  // 每次现读而不是缓存：replaceApp 换 app 就换会话，缓存下来的 id 会把整条转写判成外来。
  submitPrompt.getMainSessionId = () => {
    const runtime = (app as { runtime?: { getSessionId?: () => string } } | undefined)?.runtime;
    const sessionId = runtime?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  };

  submitPrompt.close = async () => {
    closeHandlerPromise ??= (async () => {
      await closeApp();
      // Bug 根因：TUI 的 Session 切换和进程退出共用了 App close，不能在 /new 等路径
      // 提前关闭共享 Owner；只有整个 Prompt Handler 终态才做对称 shutdown。
      await runCliCleanupWithTimeout(
        async () => processRuntime.shutdownTelemetry?.(),
        cleanupTimeoutMs,
      );
      const providerRegistryRuntime = await processRuntime.providerRegistryRuntimePromise;
      providerRegistryRuntime?.dispose();
    })();
    await closeHandlerPromise;
  };

  return submitPrompt;
}
