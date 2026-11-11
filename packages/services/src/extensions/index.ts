// 浏览器安全的公共入口：只导出契约。Renderer 经 @zcode/services 引到这里。
export {
  IExtensionsService,
  type ExtensionsContributionsMessage,
} from "#src/extensions/contract.js";
export { IExtensionGrantsService } from "#src/extensions/grants/contract.js";
export {
  IExtensionViewsService,
  type ExtensionDraftAck,
  type ExtensionDraftRequest,
  type ExtensionViewNotification,
  type ExtensionViewOpenAck,
  type ExtensionViewOpenRequest,
  type ExtensionViewRequestInput,
  type PrepareExtensionViewInput,
  type PreparedExtensionView,
} from "#src/extensions/views/contract.js";
