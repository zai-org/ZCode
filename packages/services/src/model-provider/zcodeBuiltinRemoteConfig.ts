import { downloadZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "@zcode/provider-node";
import type { ApiClient, ZCodeJwtTokenResolver } from "@zcode/shared";

export interface FetchZCodeBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly signal?: AbortSignal;
  readonly resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}

/** Services 仅注入既有网络装配；URL、预算与 Release 校验由 provider-node 唯一实现。 */
export async function fetchZCodeBuiltinRemoteRelease(
  options: FetchZCodeBuiltinRemoteReleaseOptions,
): Promise<ZCodeBuiltinRelease | null> {
  return downloadZCodeBuiltinRelease({
    endpointOrigin: options.endpointOrigin,
    appVersion: options.appVersion,
    platform: options.platform,
    signal: options.signal,
    resolveZcodeJwtToken: options.resolveZcodeJwtToken,
    request: (url, init) => options.apiClient.request(url, init),
  });
}
