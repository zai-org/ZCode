/**
 * voice-input-service 标准调用示例：开始、发送音频、结束，并按 attemptId 只处理自己的事件。
 */
import type { IVoiceInputService, VoiceInputEvent } from "./contract.js";

export function exampleTranscribe(
  service: IVoiceInputService,
  chunks: Uint8Array[],
): Promise<string> {
  const attemptId = "example-attempt";
  return new Promise((resolve, reject) => {
    const subscription = service.onEvent((event: VoiceInputEvent) => {
      if (event.attemptId !== attemptId) return;
      if (event.type === "completed") {
        subscription.dispose();
        resolve(event.text);
      } else if (event.type === "error") {
        subscription.dispose();
        reject(new Error(event.code));
      }
    });
    void service.start({ attemptId, language: "zh-CN" });
    for (const chunk of chunks) void service.sendAudio({ attemptId, chunk });
    void service.finish({ attemptId });
  });
}
