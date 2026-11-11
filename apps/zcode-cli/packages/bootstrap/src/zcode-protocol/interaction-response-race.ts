import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 让 legacy 反向 RPC（interaction/requestPermission 等）与 v4 resolveInteraction 命令
 * 竞速：谁先送达应答谁生效。
 *
 * 实现方式是"以 RPC 为主 await，v4 命中时取消 RPC"：
 * - 在 v4Interactions 登记 interactionId（= 业务 requestId，与 v4 投影
 *   PendingInteraction.interactionId 同源）；v4 应答到达时记下 answer 并 abort 内部
 *   controller，使 requestClient 以 ProtocolRequestError(-32021) 拒绝。
 * - catch 里发现已有 v4 answer 就返回映射结果（吞掉取消错误）；否则原样抛出
 *   （包括调用方 outerSignal 触发的取消），保持旧路径错误语义不变。
 * - finally 统一注销登记 + 摘除 outerSignal 监听，晚到的 v4 应答按未命中处理
 *   （resolveInteraction handler 幂等收口）。
 */
export async function raceClientRequestWithV4Interaction<T>(
  context: ZCodeProtocolAgentServerContext,
  interactionId: string,
  outerSignal: AbortSignal | undefined,
  startRequest: (signal: AbortSignal) => Promise<T>,
  mapAnswer: (answer: V4InteractionAnswer) => T,
  registrationOptions?: V4InteractionRegistrationOptions,
  onRegistered?: () => void,
): Promise<T> {
  const controller = new AbortController();
  // 每次尝试独立等待失败通知；成功仍由 registry 的 V4 answer 解除等待。
  // 仅复位布尔值唤不醒已经 await 的 legacy 应答；复用一次性通知又会让重试提前放行。
  let fullAccessFailure: Promise<void> | undefined;
  let finishAnswer!: () => void;
  const answerReady = new Promise<void>((resolve) => {
    finishAnswer = resolve;
  });
  const forwardAbort = () => {
    controller.abort();
    finishAnswer();
  };
  if (outerSignal?.aborted) {
    controller.abort();
  } else {
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  // 用容器而非裸值区分"应答就是 undefined 字段"与"尚未应答"。
  let v4Answer: { answer: V4InteractionAnswer } | undefined;
  const unregister = context.v4Interactions.register(
    interactionId,
    (answer) => {
      v4Answer = { answer };
      controller.abort();
      finishAnswer();
    },
    registrationOptions?.fullAccess
      ? {
          ...registrationOptions,
          fullAccess: async (mode) => {
            let notifyFailure!: () => void;
            const failure = new Promise<void>((resolve) => {
              notifyFailure = resolve;
            });
            fullAccessFailure = failure;
            try {
              await registrationOptions.fullAccess!(mode);
            } catch (error) {
              if (fullAccessFailure === failure) fullAccessFailure = undefined;
              notifyFailure();
              throw error;
            }
          },
        }
      : registrationOptions,
  );

  const waitForFullAccess = async () => {
    while (fullAccessFailure && !v4Answer && !outerSignal?.aborted) {
      await Promise.race([fullAccessFailure, answerReady]);
    }
  };

  try {
    onRegistered?.();
    const result = await startRequest(controller.signal);
    if (fullAccessFailure) {
      await waitForFullAccess();
      if (v4Answer) return mapAnswer(v4Answer.answer);
      outerSignal?.throwIfAborted();
    }
    return result;
  } catch (error) {
    if (fullAccessFailure) await waitForFullAccess();
    if (v4Answer) {
      return mapAnswer(v4Answer.answer);
    }
    throw error;
  } finally {
    unregister();
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}
