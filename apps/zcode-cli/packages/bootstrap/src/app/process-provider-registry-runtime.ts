import {
  AccountProviderService,
  MutableAccountProviderConfigSource,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
} from "@zcode/shared";
import { dirname, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";
import {
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
} from "./standalone-account-provider-runtime.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 自己拥有账号凭据与旧配置的一次性导入。 */
  readonly standalone?: {
    readonly credentialStore?: SharedZCodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  const credentialStore = options.standalone
    ? (options.standalone.credentialStore ?? createSharedZCodeCredentialStore({ env: { ...env } }))
    : undefined;
  let standaloneAccount: AccountProviderService | undefined;
  const bundledFile = options.standalone
    ? env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
          zcodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.zcodeBuiltinFilePath),
              "zcode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadZCodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ZCODE_VERSION,
                platform: resolveZCodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
                resolveZcodeJwtToken: () => credentialStore?.load("zcodejwttoken"),
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    accountSource,
    ...(credentialStore
      ? {
          createAccountSource(configService) {
            standaloneAccount = new AccountProviderService({
              configSource: configService,
              async resolve({ configRevision, configuredProviders }) {
                // 使用本轮捕获的 Built-in，而不是异步读另一份文件后仅贴上新 revision。
                const snapshot = await readStandaloneAccountProviderConfigSnapshot(
                  credentialStore,
                  env,
                  {
                    revision: configRevision,
                    providers: configuredProviders,
                  },
                );
                return {
                  providers: snapshot.providers,
                  states: snapshot.states ?? {},
                };
              },
            });
            standaloneAccount.onDidRefreshError(({ error }) => {
              try {
                options.standalone?.onAccountInitializationError?.(error);
              } catch {
                /* 观测回调不能改变账号事实。 */
              }
            });
            return standaloneAccount;
          },
        }
      : {}),
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  const disposeRecovery = standaloneAccount
    ? runtime.onDidCheckZCodeBuiltin(async () => {
        const [config, account] = await Promise.all([
          runtime.configService.read(),
          standaloneAccount!.read(),
        ]);
        if (config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision)
          await standaloneAccount!.refresh("builtin-account-recovery");
      })
    : undefined;
  // 复用 AccountService 的串行、过期结果丢弃机制，凭据变化与 Built-in 变化不能各自发布。
  const standaloneHeaders = credentialStore
    ? createStandaloneProviderRuntimeHeadersPort(credentialStore, env)
    : undefined;
  const disposeCredentialSubscription = credentialStore?.onDidChange?.(async () => {
    await standaloneHeaders?.invalidateChangedCredentials();
    await standaloneAccount!.refresh("standalone-credentials-changed");
    await runtime.registryService.refresh("standalone-credentials-barrier");
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        accountSource: standaloneAccount ?? accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          if (standaloneAccount)
            throw new Error("Standalone Account 由本进程管理，不接收 Host 覆盖");
          const changed = accountSource.replace(next, "host-account-config");
          // Source 去重只证明收过，不证明上次刷新成功。重交时仍刷新；配套配置未到
          // 则由 Registry 保留完整旧快照，不能把接收确认冒充应用确认。
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        dispose() {
          disposeCredentialSubscription?.();
          standaloneHeaders?.clearProjectTokens();
          disposeRecovery?.();
          standaloneAccount?.dispose();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        ...(credentialStore
          ? {
              providerRuntimeHeadersPort: standaloneHeaders!,
            }
          : {}),
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      disposeCredentialSubscription?.();
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    disposeCredentialSubscription?.();
    disposeRecovery?.();
    standaloneAccount?.dispose();
    runtime.dispose();
    throw error;
  }
}

/** 把协议信封解析为进程 Registry 使用的第三层 Account Config Overlay。 */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // 仅约束托管 Worker 的普通账号信封；独立 CLI、API 和闲时不需要 current。
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // 与 Overlay 属于同一快照；不能只更新 revision 却丢掉当前连接事实。
    ...(input.states ? { states: input.states } : {}),
  });
}
