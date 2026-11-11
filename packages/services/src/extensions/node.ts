// Window Host 侧实现入口，由 @zcode/services/node 转出。
export {
  createWindowHostExtensions,
  type WindowHostExtensions,
  type WindowHostExtensionsDeps,
} from "#src/extensions/windowHostExtensions.js";
export {
  createCapabilityHandlers,
  createCapabilityGateway,
  type CapabilityBackends,
  type CapabilityCallContext,
  type CapabilityHandler,
  type CapabilityHandlerMap,
} from "#src/extensions/capabilityGateway.js";
