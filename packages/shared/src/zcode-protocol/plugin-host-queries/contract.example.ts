/**
 * plugin-host-queries 标准调用示例：App 校验 plugins/readUserOptions 的结果，
 * 或把失败的 data 按稳定码分支（不读错误文本）。
 */
import {
  ZCODE_PLUGIN_READ_USER_OPTIONS_ERROR_CODES,
  zcodePluginQueryErrorDataSchema,
  zcodePluginsReadUserOptionsResultSchema,
  type ZCodePluginsReadUserOptionsResult,
} from "./contract.js";

export function exampleReadUserOptionsResult(raw: unknown): ZCodePluginsReadUserOptionsResult {
  // 值里可能有敏感值：只交给本插件的扩展，不打日志。
  return zcodePluginsReadUserOptionsResultSchema.parse(raw);
}

export function exampleIsPluginNotFound(errorData: unknown): boolean {
  const parsed = zcodePluginQueryErrorDataSchema.safeParse(errorData);
  return (
    parsed.success && parsed.data.code === ZCODE_PLUGIN_READ_USER_OPTIONS_ERROR_CODES.pluginNotFound
  );
}
