/** Shared sandbox transport/presentation and existing session admission binding. */
export { createPluginUiMessagePortTransport } from "./adapters/messagePortTransport.js";
export { createPluginUiPagePlane } from "./adapters/pluginUiPagePlane.js";
export { readPluginUiStyleVariables } from "./adapters/readPluginUiStyleVariables.js";
export {
  sandboxPages,
  onSandboxPageRemoved,
  type SandboxPageOwner,
} from "./adapters/sandboxPageOwners.js";
export {
  getPluginUiSessionActions,
  registerPluginUiSessionActions,
} from "./adapters/pluginUiSessionActions.js";
/** 页面层的纯构造与收尾：扩展视图（extension-slots）与 MCP App 共用同一份 hostContext、能力声明与卸载顺序。 */
export { buildPluginUiHostContext } from "./domain/buildPluginUiHostContext.js";
export { buildPluginUiHostCapabilities } from "./domain/buildPluginUiHostCapabilities.js";
export { runPluginUiHostTeardown } from "./app/pluginUiHostTeardown.js";
