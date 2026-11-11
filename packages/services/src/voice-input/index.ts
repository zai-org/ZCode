// 浏览器安全的公共入口：只导出契约。Renderer 经 @zcode/services 引到这里。
export { IVoiceInputService } from "./contract.js";
export type { VoiceInputErrorCode, VoiceInputEvent } from "./contract.js";
