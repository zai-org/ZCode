/**
 * desktop-microphone-access 标准调用示例：Main 启动时注册一次 IPC 处理器。
 */
import type { DesktopMicrophoneAccessContract } from "./contract.js";

export function exampleDesktopMicrophoneAccess(contract: DesktopMicrophoneAccessContract): void {
  contract.registerDesktopMicrophoneIpcHandlers({ info: () => {}, warn: () => {} });
}
