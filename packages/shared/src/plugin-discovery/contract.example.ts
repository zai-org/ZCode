import { pluginInstallRequestPayloadSchema } from "./contract.js";
/** 客户端只展示经过校验的官方 ID 和请求动作，不接收下载地址。 */
export function readInstallCard(payload: unknown) {
  return pluginInstallRequestPayloadSchema.safeParse(payload);
}
