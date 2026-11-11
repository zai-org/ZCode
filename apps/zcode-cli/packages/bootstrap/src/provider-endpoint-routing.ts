import { createConfig, type ConfigResult } from "@zcode/adapters/config";
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import { createProviderEndpointRoutingPort } from "@zcode/adapters/model";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import type { Logger, LoggerFactory, ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ModelProviderSourceTitle } from "./model-config.js";
import { createProviderEndpointRoutingSourceHeaders } from "./provider-endpoint-routing-source-headers.js";

const processRoutingPorts = new Map<string, ProviderEndpointRoutingPort>();
const delegatedRoutingPorts = new WeakMap<
  SharedZCodeCredentialStore,
  Map<string, ProviderEndpointRoutingPort>
>();

type NetworkConfig = ConfigResult["config"]["network"];

export interface ResolveProcessProviderEndpointRoutingPortOptions {
  credentialStore?: SharedZCodeCredentialStore;
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  network: NetworkConfig;
  sourceTitle?: ModelProviderSourceTitle;
}

export interface CreateDefaultProviderEndpointRoutingPortOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  sourceTitle?: ModelProviderSourceTitle;
  userConfigPath?: string;
  workingDirectory: string;
}

export function resolveProcessProviderEndpointRoutingPort(
  options: ResolveProcessProviderEndpointRoutingPortOptions,
): ProviderEndpointRoutingPort {
  const env = options.env ?? process.env;
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);
  const key = routingRegistryKey(endpointOrigin, options.network);
  // App-managed CLI 必须复用宿主凭据端口；不能与 standalone 的本地 Store 混用缓存。
  let ports = processRoutingPorts;
  if (options.credentialStore) {
    const existing = delegatedRoutingPorts.get(options.credentialStore);
    ports = existing ?? new Map();
    if (!existing) delegatedRoutingPorts.set(options.credentialStore, ports);
  }
  const existing = ports.get(key);
  if (existing) {
    return existing;
  }

  const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });

  const port = createProviderEndpointRoutingPort({
    appVersion: options.appVersion,
    endpointOrigin,
    httpClient: createNodeHttpClientAdapter({
      caCertFile: options.network.caCertFile,
      env,
      noProxy: options.network.noProxy,
      proxyUrl: options.network.httpProxy,
    }),
    logger: options.logger.child({
      module: "adapters.model.provider_endpoint_routing",
    }),
    readZCodeJwt: () => credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken),
    sourceHeaders: () =>
      createProviderEndpointRoutingSourceHeaders({
        appVersion: options.appVersion,
        env,
        sourceTitle: options.sourceTitle,
      }),
  });
  ports.set(key, port);
  return port;
}

export function createDefaultProviderEndpointRoutingPort(
  options: CreateDefaultProviderEndpointRoutingPortOptions,
): ProviderEndpointRoutingPort {
  const env = options.env ?? process.env;
  const configResult = createConfig({
    env,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory: options.workingDirectory,
  });
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env });
  const logger = loggerFactory.createLogger("zcode").child({
    module: "bootstrap.provider_endpoint_routing",
  });
  return resolveProcessProviderEndpointRoutingPort({
    appVersion: options.appVersion,
    env,
    logger,
    network: configResult.config.network,
    sourceTitle: options.sourceTitle,
  });
}

function routingRegistryKey(endpointOrigin: string, network: NetworkConfig): string {
  return JSON.stringify({
    caCertFile: network.caCertFile,
    endpointOrigin,
    httpProxy: network.httpProxy,
    noProxy: network.noProxy,
  });
}
