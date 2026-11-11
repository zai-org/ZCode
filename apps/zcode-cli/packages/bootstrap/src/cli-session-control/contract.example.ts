import type { CliSessionControlRuntimeOptions } from "./contract.js";
import { createCliSessionControlRuntime } from "./module.js";

/** 装配先取得 control，再创建并登记当前根；由宿主在关闭共享资源前 await close。 */
export function composeCliSessionControl(options: CliSessionControlRuntimeOptions) {
  return createCliSessionControlRuntime(options);
}
