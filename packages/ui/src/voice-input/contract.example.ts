/**
 * voice-input 标准用法：Composer 调用一次 hook，把按钮放在发送键左侧；
 * 用户修改输入框（onUserInputStart）时调用 settle；发送前 await settle，拿到最终文本再读草稿。
 */
import type { ComposerVoiceInput } from "./contract.js";

export function exampleComposerHooks(voiceInput: ComposerVoiceInput) {
  return {
    onUserInputStart: () => void voiceInput.settle("user-input"),
    // 有进行中的语音输入时才等待；等待后要校验发送目标没有变化。
    beforeSubmit: () => voiceInput.settle("submit"),
  };
}
