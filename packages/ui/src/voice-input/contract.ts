/**
 * voice-input（UI）对外契约：Composer 只依赖这里的类型与 index.ts 导出的 hook / 组件。
 */
export type VoiceInputState = "idle" | "requesting" | "recording" | "finishing";

/** Composer 触发的结束原因：发送消息、用户修改输入框。两者都与点击停止一致，等待最终结果。 */
export type VoiceInputStopReason = "submit" | "user-input";

export interface ComposerVoiceInput {
  /** 当前环境可用（桌面、已登录、Host 提供服务） */
  available: boolean;
  state: VoiceInputState;
  toggle: () => void;
  /**
   * 与点击停止一致地结束当前识别：发送尾块和 finish，等待最终结果替换语音文字。
   * 返回的 Promise 在本次识别结束（完成、失败或取消）时 resolve；空闲时返回 undefined，调用方无需等待。
   * 等待可能跨越会话切换：恢复后调用方必须自行校验目标是否仍有效。
   */
  settle: (reason: VoiceInputStopReason) => Promise<void> | undefined;
  /** 订阅录音中每个 100ms 音频块的峰值电平（满量程 1）；返回取消订阅函数。引用稳定 */
  subscribeLevel: (listener: (peak: number) => void) => () => void;
}
