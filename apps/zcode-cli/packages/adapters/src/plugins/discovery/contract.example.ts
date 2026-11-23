import { parsePluginManifest } from "./index.js";
/** 首载和热更新共用 manifest 解析规则。 */
export const manifestExample = parsePluginManifest({ name: "example", version: "1.0.0" });
