import { addZCodePluginMarketplace } from "../src/plugins.js";

// popover 调用约定：source 为自由文本；pluginStorageRoot 真实运行时由 config 推导，
// 这里显式覆盖到临时目录做隔离，等价「换一个干净工作区做导入」。
export function addViaFacade(source: string, storageRoot: string, workingDirectory: string) {
  return addZCodePluginMarketplace({
    source,
    pluginStorageRoot: storageRoot,
    workingDirectory,
    skipUserConfig: true,
  });
}
