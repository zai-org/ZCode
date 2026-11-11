export type * from "#src/main/web-remote-relay/contract.js";
export { createWebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/webRemoteControlDeviceStorage.js";
export {
  buildWebRemoteControlClientLanguageHeader,
  createWebRemoteControlV2Http,
} from "#src/main/web-remote-relay/webRemoteControlV2Http.js";
export {
  respondToWebRemoteControlActionRequest,
  type RunWebRemoteControlRendererAction,
  type WebRemoteControlActionRequestPayload,
} from "#src/main/web-remote-relay/webRemoteControlActionRequests.js";
export { runWebRemoteControlActionInRenderer } from "#src/main/web-remote-relay/webRemoteControlRendererAction.js";
export { WebRemoteControlDeviceTransport } from "#src/main/web-remote-relay/webRemoteControlTransport.js";
// 手机日志通道：实时落盘、拉取编排与导出。
export {
  createMobileLogSink,
  MOBILE_LOG_SINK_DEFAULTS,
  sanitizeMobileLogPathSegment,
  serializeMobileLogEntry,
  type MobileLogSink,
  type MobileLogSinkTarget,
} from "#src/main/web-remote-relay/mobileLogSink.js";
export {
  createMobileLogPullCoordinator,
  decodeCompressedMobileLogShard,
  MobileLogPullError,
  type MobileLogPullErrorCode,
  type MobileLogPullQuery,
  type MobileLogPullShard,
  type MobileLogPullSummary,
} from "#src/main/web-remote-relay/mobileLogPull.js";
export {
  MOBILE_LOG_PULL_DEFAULT_WINDOW_MS,
  pullAndExportMobileLogs,
  type MobileLogPullExportDependencies,
} from "#src/main/web-remote-relay/mobileLogPullExport.js";

export {
  MobilePushConnection,
  type MobilePushConnectionContext,
} from "#src/main/web-remote-relay/mobilePushConnection.js";
