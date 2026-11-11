import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}

// 一个 CLI 实例只探测一次；失败时允许下次重试，旧严格 schema 一律不发新字段。
type CapabilityClient = Pick<ZCodeProtocolClient, "request">;
const discoveredCapabilities = new WeakMap<
  object,
  Promise<{ historyFirst?: boolean; pluginDiscoveryUi?: boolean; pluginExtensionSummary?: boolean }>
>();
function discoverCapabilities(client: CapabilityClient) {
  let result = discoveredCapabilities.get(client);
  if (!result) {
    result = client
      .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
      .catch(() => {
        discoveredCapabilities.delete(client);
        return {};
      });
    discoveredCapabilities.set(client, result);
  }
  return result;
}
export async function supportsHistoryFirst(client: CapabilityClient): Promise<boolean> {
  return (await discoverCapabilities(client)).historyFirst === true;
}
export async function supportsPluginDiscoveryUi(client: CapabilityClient): Promise<boolean> {
  return (await discoverCapabilities(client)).pluginDiscoveryUi === true;
}
/** plugins/overview 的 includeExtensionSummary：旧 CLI 的参数 schema 是 strict，多一个键整条拒绝。 */
export async function supportsPluginExtensionSummary(client: CapabilityClient): Promise<boolean> {
  return (await discoverCapabilities(client)).pluginExtensionSummary === true;
}

const genUiChecks = new WeakMap<object, Promise<void>>();
/** 状态不能回退到拼接用户正文；不支持时保留草稿并拒绝发送。 */
export function ensureGenUiContextSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = genUiChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.genUiContext !== true) throw new Error("proto.genUiContextUnsupported");
    })
    .catch((cause: unknown) => {
      genUiChecks.delete(client);
      throw new Error("proto.genUiContextUnsupported", { cause });
    });
  genUiChecks.set(client, check);
  return check;
}

const highspeedOwnerChecks = new WeakMap<object, Promise<boolean>>();
/** 旧CLI的严格metadata不认识ownerKey；不支持时只去掉新增字段，保留发送。 */
export function supportsHighspeedCardOwner(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<boolean> {
  const existing = highspeedOwnerChecks.get(client);
  if (existing) return existing;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => result.highspeedCardOwner === true)
    .catch(() => {
      highspeedOwnerChecks.delete(client);
      return false;
    });
  highspeedOwnerChecks.set(client, check);
  return check;
}
