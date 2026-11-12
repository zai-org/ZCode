/**
 * 麦克风权限引导浮层的状态（docs/chat/composer-voice-input.md「权限引导浮层」）。
 *
 * ```text
 * closed ─show()─▶ denied ─重新授权─┬─ granted ──────────▶ closed（toast 已开启）
 *                    ▲              ├─ denied ───────────▶ denied
 *                    │              ├─ restart-required ─▶ restart-required ─重启 ZCode─▶ 应用重启
 *                    │              └─ failed ───────────▶ denied（打开系统设置）
 *                    └─ 窗口 focus：ensureAccess 为 granted ─▶ closed（toast 已开启）
 * ```
 *
 * - 浮层只在 macOS / Windows 打开；Linux 没有系统设置页，仍用 toast。
 * - 窗口重新获得焦点时检查一次权限，事件触发，不轮询。
 * - 重新授权进行中（系统弹框打开时窗口会失焦再获焦）跳过焦点检查，
 *   避免同时调用 askForMediaAccess；结果以重新授权的返回值为准。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type {
  MicrophonePermissionGuide,
  MicrophonePermissionGuidePhase,
} from "@/voice-input/contract.js";
import { resolveVoiceInputOs } from "@/voice-input/domain/voiceInputFailure.js";

export function useMicrophonePermissionGuide(): MicrophonePermissionGuide {
  const platform = useOptionalPlatform();
  const microphone = platform?.microphone;
  const { intl } = useZCodeIntl();
  const os = resolveVoiceInputOs(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const [phase, setPhase] = useState<MicrophonePermissionGuidePhase | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const close = useCallback(() => setPhase(null), []);

  const closeGranted = useCallback(() => {
    setPhase(null);
    toast(intl.formatMessage({ id: "voiceInput.permission.granted" }), {
      variant: "success",
      dedupeKey: "voice-input-permission-granted",
    });
  }, [intl]);

  const show = useCallback(() => setPhase("denied"), []);

  const openSettings = useCallback(() => {
    void microphone?.openSettings("privacy");
  }, [microphone]);

  const reauthorize = useCallback(async () => {
    if (!microphone || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const result = await microphone.resetAccess().catch(() => "failed" as const);
    busyRef.current = false;
    setBusy(false);
    logger.lifecycle.info("[voice-input] reauthorize", { result });
    switch (result) {
      case "granted":
        closeGranted();
        return;
      case "restart-required":
        setPhase((current) => (current ? "restart-required" : current));
        return;
      case "failed":
        void microphone.openSettings("privacy");
        return;
      case "denied":
        return;
    }
  }, [closeGranted, microphone]);

  const relaunch = useCallback(() => {
    if (typeof platform?.executeDesktopCommand !== "function") return;
    logger.lifecycle.info("[voice-input] relaunch for microphone permission");
    platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp).catch((error: unknown) => {
      logger.lifecycle.warn("[voice-input] relaunch failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [platform]);

  // 用户在系统设置里打开开关后回到 ZCode：检查一次，已允许就关闭浮层。
  const open = phase !== null;
  useEffect(() => {
    if (!open || !microphone) return;
    const onFocus = () => {
      if (busyRef.current) return;
      void microphone
        .ensureAccess()
        .catch(() => "unsupported" as const)
        .then((access) => {
          if (access === "granted" && !busyRef.current) closeGranted();
        });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [closeGranted, microphone, open]);

  // 引用随状态变化，VoiceInputButton（memo）不随 Composer 的其他渲染重绘。
  return useMemo(
    () => ({
      phase,
      os: os === "windows" ? ("windows" as const) : ("mac" as const),
      available: os !== "linux",
      busy,
      show,
      close,
      openSettings,
      reauthorize,
      relaunch,
    }),
    [busy, close, openSettings, os, phase, reauthorize, relaunch, show],
  );
}
