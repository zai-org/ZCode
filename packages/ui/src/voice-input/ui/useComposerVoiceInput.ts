/**
 * Composer 语音输入（docs/chat/composer-voice-input.md）。
 *
 * 状态唯一 owner 是本 hook 的 attempt：
 *
 * ```text
 *                        result：替换语音文字
 * idle ─toggle─▶ requesting ─started─▶ recording ─toggle─▶ finishing ─completed─▶ idle（最终文本）
 *                    ├── Escape ─────────────┴─────────────────┴──▶ idle（删除语音文字）
 *                    └── 失败 / 用户输入 / 发送 / 切换会话 ───────▶ idle（保留语音文字）
 * ```
 *
 * - 每次录音一个 attemptId；Host 事件和异步回调只在 attemptId 仍是当前值时生效。
 * - 不加客户端超时：服务端 start / idle / finish 超时会以 error 结束会话。
 * - 识别结果直接写入编辑器的「语音文字」；语音文字由编辑器 handle 持有（setVoiceText / endVoiceText），
 *   用户一修改输入框就停止语音输入，避免两方同时改编辑器。
 * - 日志走 logger.lifecycle：生产构建下普通 renderer 日志是 no-op，失败原因必须能落盘排查；
 *   每次录音只有几条，不随音频块增长。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { toast } from "@/components/ui/toast.js";
import type {
  ComposerVoiceInput,
  VoiceInputState,
  VoiceInputStopReason,
} from "@/voice-input/contract.js";
import { startPcmCapture, type PcmCapture } from "@/voice-input/adapters/pcmCapture.js";
import { useMicrophonePermissionGuide } from "@/voice-input/ui/useMicrophonePermissionGuide.js";
import {
  classifyCapturedAudio,
  classifyGetUserMediaError,
  resolveVoiceInputFailureNotice,
  resolveVoiceInputOs,
  type VoiceInputFailure,
} from "@/voice-input/domain/voiceInputFailure.js";

interface Attempt {
  id: string;
  capture: PcmCapture | null;
  started: boolean;
  finishing: boolean;
  /** 用户已在输入框里打字：不再写入临时结果，最终结果写入时不移动用户光标 */
  userTookOver: boolean;
  /** attempt 结束（completed、失败、取消）时 resolve；发送前等待它拿到最终文本 */
  done: Promise<void>;
  resolveDone: () => void;
}

export function useComposerVoiceInput(options: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  /** 会话切换时取消 */
  sessionId: string | null | undefined;
  enabled: boolean;
}): ComposerVoiceInput {
  const { inputApiRef, sessionId } = options;
  const platform = useOptionalPlatform();
  const microphone = platform?.microphone;
  const { voiceInputService } = useBaseWorkspaceServices();
  const isLoggedIn = useZCodeStore((state) => state.user !== null);
  const { intl, locale } = useZCodeIntl();
  const available = Boolean(options.enabled && microphone && voiceInputService && isLoggedIn);
  const permissionGuide = useMicrophonePermissionGuide();
  const showPermissionGuide = permissionGuide.show;

  const [state, setState] = useState<VoiceInputState>("idle");
  const attemptRef = useRef<Attempt | null>(null);
  // 音量只推给订阅者（音量点阵），不进入本 hook 的 state，避免 Composer 每 100ms 重新渲染。
  const levelListenersRef = useRef(new Set<(peak: number) => void>());
  const subscribeLevel = useCallback((listener: (peak: number) => void) => {
    levelListenersRef.current.add(listener);
    return () => {
      levelListenersRef.current.delete(listener);
    };
  }, []);

  const reset = useCallback(
    (attempt: Attempt, options?: { removeVoiceText?: boolean }) => {
      if (attemptRef.current !== attempt) return;
      attemptRef.current = null;
      attempt.capture?.abort();
      inputApiRef.current?.endVoiceText({ remove: options?.removeVoiceText === true });
      setState("idle");
      attempt.resolveDone();
    },
    [inputApiRef],
  );

  const notify = useCallback(
    (failure: VoiceInputFailure) => {
      const notice = resolveVoiceInputFailureNotice(
        failure,
        resolveVoiceInputOs(typeof navigator === "undefined" ? "" : navigator.userAgent),
      );
      if (notice.permissionGuide) {
        showPermissionGuide();
        return;
      }
      if (!notice.messageId) return;
      const target = notice.settingsTarget;
      toast(intl.formatMessage({ id: notice.messageId }), {
        variant: "warning",
        durationMs: target ? 8000 : undefined,
        dedupeKey: "voice-input-failure",
        ...(target && microphone
          ? {
              actionLabel: intl.formatMessage({
                id:
                  target === "privacy"
                    ? "voiceInput.action.openPrivacySettings"
                    : "voiceInput.action.openSoundSettings",
              }),
              onAction: () => void microphone.openSettings(target),
            }
          : {}),
      });
    },
    [intl, microphone, showPermissionGuide],
  );

  const fail = useCallback(
    (attempt: Attempt, failure: VoiceInputFailure, detail?: Record<string, unknown>) => {
      if (attemptRef.current !== attempt) return;
      logger.lifecycle.warn("[voice-input] failed", { attemptId: attempt.id, failure, ...detail });
      // Host 对未知或已结束的 attempt 忽略 cancel，这里无条件发送。
      void voiceInputService?.cancel({ attemptId: attempt.id });
      reset(attempt);
      notify(failure);
    },
    [notify, reset, voiceInputService],
  );

  /** 立即结束语音输入：通知 Host 取消，之后到达的结果丢弃。只有 Escape 删除语音文字。 */
  const stopAttempt = useCallback(
    (reason: "escape" | "session-change") => {
      const attempt = attemptRef.current;
      if (!attempt) return;
      logger.lifecycle.info("[voice-input] stopped", { attemptId: attempt.id, reason });
      void voiceInputService?.cancel({ attemptId: attempt.id });
      reset(attempt, { removeVoiceText: reason === "escape" });
    },
    [reset, voiceInputService],
  );

  const finish = useCallback(
    async (attempt: Attempt) => {
      const capture = attempt.capture;
      if (!capture || !voiceInputService) {
        // 麦克风还没打开就再次点击：视为取消。
        void voiceInputService?.cancel({ attemptId: attempt.id });
        reset(attempt);
        return;
      }
      attempt.finishing = true;
      setState("finishing");
      const stats = await capture.stop();
      if (attemptRef.current !== attempt) return;
      const failure = classifyCapturedAudio(stats);
      logger.lifecycle.info("[voice-input] capture stopped", {
        attemptId: attempt.id,
        peak: Number(stats.peak.toFixed(5)),
        durationMs: Math.round(stats.durationMs),
        bytes: stats.bytes,
        failure,
      });
      if (failure) {
        fail(attempt, failure, { stage: "capture-stats" });
        return;
      }
      // stop() 返回时尾块已经以 sendAudio 发出；同一 RPC 通道按调用顺序送达，finish 一定排在尾块之后。
      void voiceInputService.finish({ attemptId: attempt.id });
    },
    [fail, reset, voiceInputService],
  );

  // Host 事件：只处理当前 attempt。
  useEffect(() => {
    if (!voiceInputService) return;
    const subscription = voiceInputService.onEvent((event) => {
      const attempt = attemptRef.current;
      if (!attempt || attempt.id !== event.attemptId) return;
      switch (event.type) {
        case "started":
          attempt.started = true;
          if (!attempt.finishing) setState("recording");
          return;
        case "result":
          // 用户接管后不再写临时结果，避免和用户输入争抢编辑器；最终结果在 completed 时写入。
          if (attempt.userTookOver) return;
          // 写入被拒说明用户改过语音文字（与写入合并在同一次提交、onUserInputStart 识别不到的情况）：
          // 按用户接管处理，和点击停止一样结束录音并等待最终结果。
          if (!inputApiRef.current?.setVoiceText(event.text)) {
            attempt.userTookOver = true;
            if (!attempt.finishing) void finish(attempt);
          }
          return;
        case "completed": {
          const text = event.text.trim();
          logger.lifecycle.info("[voice-input] completed", {
            attemptId: attempt.id,
            length: text.length,
          });
          // 最终文本只替换语音文字本身：用户在其后追加的文字保留，用户接管时不移动光标。
          // 最终文本为空时删除语音文字；语音文字被用户改过时拒绝写入，保留用户版本。
          inputApiRef.current?.setVoiceText(text, { preserveSelection: attempt.userTookOver });
          reset(attempt);
          if (!text) notify("no_speech");
          return;
        }
        case "error":
          fail(attempt, event.code, { source: "host" });
          return;
      }
    });
    return () => subscription.dispose();
  }, [fail, finish, inputApiRef, notify, reset, voiceInputService]);

  const begin = useCallback(async () => {
    if (!microphone || !voiceInputService) return;
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      capture: null,
      started: false,
      finishing: false,
      userTookOver: false,
      done,
      resolveDone,
    };
    attemptRef.current = attempt;
    setState("requesting");
    inputApiRef.current?.beginVoiceText();

    const access = await microphone.ensureAccess().catch(() => "unsupported" as const);
    if (attemptRef.current !== attempt) return;
    logger.lifecycle.info("[voice-input] start", { attemptId: attempt.id, access });
    if (access === "denied") {
      fail(attempt, "permission_denied", { stage: "system-permission" });
      return;
    }
    // 先建立 Host 会话再开始采集：started 之前的音频由 Host 按顺序缓存。
    await voiceInputService.start({
      attemptId: attempt.id,
      language: locale.startsWith("zh") ? "zh-CN" : "en-US",
    });
    try {
      const capture = await startPcmCapture({
        onChunk: (chunk, peak) => {
          // 修复原因：曾在 finishing 后丢弃音频，但 capture.stop() 的 flush 正是在此之后才送出
          // 不足 100ms 的尾块，导致最后一个音节被截断。finishing 只用于阻止重复点击；
          // 当前 attempt 在 stop() 返回前都要转发音频，取消或换代的 attempt 仍立即丢弃。
          if (attemptRef.current !== attempt) return;
          void voiceInputService.sendAudio({ attemptId: attempt.id, chunk });
          for (const listener of levelListenersRef.current) listener(peak);
        },
        onEnded: () => fail(attempt, "device_ended", { stage: "capture" }),
      });
      if (attemptRef.current !== attempt) {
        capture.abort();
        return;
      }
      attempt.capture = capture;
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "UnknownError";
      fail(attempt, classifyGetUserMediaError(name), {
        stage: "getUserMedia",
        errorName: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [fail, inputApiRef, locale, microphone, voiceInputService]);

  const toggle = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) {
      void begin();
      return;
    }
    if (attempt.finishing) return;
    void finish(attempt);
  }, [begin, finish]);

  // 修复原因：发送或用户打字曾直接 cancel，只保留临时结果、拿不到服务端最终优化的文本，
  // 与点击停止不一致。现在两者都走 finish：等待 completed，用最终文本替换语音文字。
  const settle = useCallback(
    (reason: VoiceInputStopReason): Promise<void> | undefined => {
      const attempt = attemptRef.current;
      if (!attempt) return undefined;
      if (reason === "user-input" && !attempt.userTookOver) {
        attempt.userTookOver = true;
        logger.lifecycle.info("[voice-input] user took over", { attemptId: attempt.id });
      }
      if (!attempt.finishing) {
        logger.lifecycle.info("[voice-input] settling", { attemptId: attempt.id, reason });
        void finish(attempt);
      }
      return attempt.done;
    },
    [finish],
  );

  // 会话切换、退出登录、组件卸载都停止当前识别，语音文字随草稿保留。
  useEffect(() => () => stopAttempt("session-change"), [stopAttempt, sessionId, available]);

  // 录音或识别中按 Escape 只取消语音输入，不触发停止生成等其他 Escape 行为。
  useEffect(() => {
    if (state === "idle") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      stopAttempt("escape");
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [stopAttempt, state]);

  return { available, state, toggle, settle, subscribeLevel, permissionGuide };
}
