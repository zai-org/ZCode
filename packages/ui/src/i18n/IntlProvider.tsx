import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { Locale, LocalePreference } from "@zcode/shared";
import {
  DEFAULT_LOCALE,
  isLocale,
  isLocalePreference,
  resolveLocaleFromLanguageTag,
} from "@zcode/shared";
import type { BroadcastMessage, IBroadcastService, ISettingService } from "@zcode/services";
import { readNavigatorLanguage, readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import { LOCALE_MESSAGES as MESSAGES } from "./localeMessages.js";

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换 */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";
const STATE_LOCALE_CHANNEL = "state:locale";

interface LocaleBroadcastPayload {
  preference: LocalePreference;
  resolvedLocale: Locale;
}

function resolveLocaleBroadcastPayload(payload: unknown): LocaleBroadcastPayload | null {
  if (isLocale(payload)) {
    return {
      preference: payload,
      resolvedLocale: payload,
    };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<LocaleBroadcastPayload>;
  if (
    isLocalePreference(candidate.preference) &&
    isLocale(candidate.resolvedLocale)
  ) {
    return {
      preference: candidate.preference,
      resolvedLocale: candidate.resolvedLocale,
    };
  }

  return null;
}

export function resolveLocalePreferenceFromSettings({
  storedPreference,
  settingsLocale,
  settingsLocalePreference,
  preferSettingServiceLocale,
}: {
  storedPreference: LocalePreference | null;
  settingsLocale: Locale | undefined;
  settingsLocalePreference: LocalePreference | undefined;
  preferSettingServiceLocale: boolean;
}): LocalePreference | null {
  if (preferSettingServiceLocale && settingsLocale) {
    if (settingsLocalePreference === "system") {
      return settingsLocale;
    }
    return settingsLocale;
  }

  return storedPreference ?? settingsLocalePreference ?? settingsLocale ?? null;
}

export function shouldApplyLocaleBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
  options: {
    ignoredLocalPayload?: LocaleBroadcastPayload | null;
  } = {},
): message is Pick<BroadcastMessage, "channel"> & { payload: Locale | LocaleBroadcastPayload } {
  const payload = resolveLocaleBroadcastPayload(message.payload);
  if (message.channel !== STATE_LOCALE_CHANNEL || !payload) {
    return false;
  }
  if (
    message.sourceWindowId === undefined &&
    options.ignoredLocalPayload?.preference === payload.preference &&
    options.ignoredLocalPayload.resolvedLocale === payload.resolvedLocale
  ) {
    return false;
  }
  return true;
}

function createIntl(locale: Locale): IntlInstance {
  // noUncheckedIndexedAccess：用 ?? 回退到默认语言的翻译
  const messages = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]!;
  return {
    formatMessage({ id }, values) {
      let msg = messages[id] ?? id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          msg = msg.replaceAll(`{${key}}`, String(val));
        }
      }
      return msg;
    },
  };
}

interface IntlContextValue {
  intl: IntlInstance;
  locale: Locale;
  localePreference: LocalePreference;
  /**
   * 语言是否已确定：有 settingService 时要等持久化设置读完（或用户/其他窗口显式切换）才为 true。
   * 之前 locale 只是占位初值，不能同步给 Main / 用作发往服务端的语言。
   */
  localeResolved: boolean;
  setLocale: (locale: Locale) => void;
  setLocalePreference: (localePreference: LocalePreference) => void;
}

const IntlContext = createContext<IntlContextValue | null>(null);

/**
 * 国际化 Provider —— 管理当前语言和 intl 实例。
 * 如果传入 settingService，会从设置中读取初始语言并在切换时持久化。
 */
export function ZCodeIntlProvider({
  children,
  settingService,
  broadcastService,
  initialLocale,
  preferSettingServiceLocale = false,
  resolveSystemLocale: resolveHostSystemLocale,
}: {
  children: ReactNode;
  settingService?: ISettingService;
  broadcastService?: Pick<IBroadcastService, "send" | "onMessage">;
  initialLocale?: Locale;
  preferSettingServiceLocale?: boolean;
  resolveSystemLocale?: () => Locale | Promise<Locale>;
}) {
  const applyingBroadcastRef = useRef(false);
  const ignoredLocalLocaleBroadcastPayloadRef = useRef<LocaleBroadcastPayload | null>(null);
  const localePreferenceOperationSeqRef = useRef(0);
  const resolveNavigatorSystemLocale = useCallback((): Locale => {
    const language = readNavigatorLanguage();
    if (!language) {
      return DEFAULT_LOCALE;
    }

    return resolveLocaleFromLanguageTag(language);
  }, []);
  const resolveSystemLocale = useCallback(async (): Promise<Locale> => {
    const resolvedLocale = await resolveHostSystemLocale?.();
    if (isLocale(resolvedLocale)) {
      return resolvedLocale;
    }
    return resolveNavigatorSystemLocale();
  }, [resolveHostSystemLocale, resolveNavigatorSystemLocale]);

  const readStoredPreference = useCallback((): LocalePreference | null => {
    const raw = readSafeLocalStorage(LOCALE_PREFERENCE_KEY);
    if (isLocalePreference(raw)) {
      return raw;
    }
    return null;
  }, []);

  const persistLocalePreference = useCallback((preference: LocalePreference) => {
    writeSafeLocalStorage(LOCALE_PREFERENCE_KEY, preference);
  }, []);

  const [localePreference, setLocalePreferenceState] = useState<LocalePreference>(
    () => initialLocale ?? readStoredPreference() ?? "system",
  );
  const [systemLocale, setSystemLocale] = useState<Locale>(() => resolveNavigatorSystemLocale());
  // 注意不能写成 useState(() => !settingService)：桌面端先用不带 settingService 的 Provider 渲染
  // 数据库启动页，再在同一位置渲染带 settingService 的 Provider，React 会复用同一个实例的
  // state，初值 true 会被带过来，导致设置还没读完就被当成"已确定"。所以按 settingService 派生。
  const [localeResolvedBySettings, setLocaleResolved] = useState(false);
  const localeResolved = !settingService || localeResolvedBySettings;
  const enqueueLocalePreferenceUpdate = useCallback(
    (operationSeq: number, resolvedLocale: Locale, preference: LocalePreference) => {
      if (localePreferenceOperationSeqRef.current !== operationSeq) {
        return;
      }

      // Provider 层不能把持久化 RPC 串成无界等待链。
      // 一次 settingService.update 永久 pending 时，后续语言选择仍要继续尝试落盘；
      // 底层 settingService 负责文件写入顺序，这里只做最新操作校验和错误收口。
      void settingService?.update({
        locale: resolvedLocale,
        localePreference: preference,
      }).catch(() => {
        // 持久化失败不阻断 UI 状态和跨窗口广播，下一次语言操作会再次尝试写入。
      });
    },
    [settingService],
  );

  // 从 settingService 读取持久化的 locale
  useEffect(() => {
    if (!settingService) return;
    let disposed = false;
    const initialOperationSeq = localePreferenceOperationSeqRef.current;
    const markResolved = () => {
      if (!disposed) {
        setLocaleResolved(true);
      }
    };
    void settingService.get().then(async (settings) => {
      if (disposed || localePreferenceOperationSeqRef.current !== initialOperationSeq) {
        // 期间用户/其他窗口已显式切换语言，由那条路径标记已确定。
        return;
      }
      const nextPreference = resolveLocalePreferenceFromSettings({
        storedPreference: readStoredPreference(),
        settingsLocale: settings.locale,
        settingsLocalePreference: settings.localePreference,
        preferSettingServiceLocale,
      });
      if (disposed) {
        return;
      }
      if (nextPreference) {
        // 手机远控和桌面连接到同一个 settingService，但手机浏览器本地可能残留
        // en-US/system 偏好。远控入口必须以桌面 setting.json 为准，否则会出现桌面中文、手机英文。
        setLocalePreferenceState(nextPreference);
        // 无论来源是 localStorage 还是 setting.json，都把最终偏好回写 localStorage。
        // Bug 原因：过去只有 preferSettingServiceLocale 时才回写，主窗口从 setting.json 解析出
        // ja-JP 等语言后 localStorage 仍为空；资源管理器独立窗口、错误边界、官方版本的请求安全校验界面等只读
        // localStorage 的地方于是回落到系统语言（中文系统整窗中文）。
        if (nextPreference !== readStoredPreference()) {
          persistLocalePreference(nextPreference);
        }
        if (nextPreference === "system") {
          const resolvedLocale = await resolveSystemLocale();
          if (
            disposed ||
            localePreferenceOperationSeqRef.current !== initialOperationSeq
          ) {
            return;
          }
          setSystemLocale(resolvedLocale);
          markResolved();
          if (settings.locale !== resolvedLocale) {
            // setting.json 里的 locale 是 main 进程菜单、远控等非浏览器上下文的实际语言。
            // system 模式必须使用宿主系统语言；Electron renderer 的 navigator.language 可能和
            // macOS app.getLocale() 不一致，直接写回会把中文系统错误持久化成英文。
            enqueueLocalePreferenceUpdate(initialOperationSeq, resolvedLocale, "system");
          }
          return;
        }
      }
      markResolved();
    }, markResolved);
    return () => {
      disposed = true;
    };
  }, [
    persistLocalePreference,
    preferSettingServiceLocale,
    readStoredPreference,
    enqueueLocalePreferenceUpdate,
    resolveSystemLocale,
    settingService,
  ]);

  const locale = useMemo<Locale>(() => {
    return localePreference === "system" ? systemLocale : localePreference;
  }, [localePreference, systemLocale]);

  // 把界面语言同步到 <html lang>：CJK 字形回退（:lang(ja)/:lang(ko) 字体栈）、读屏发音、
  // 以及只拿得到 document 的平台方法（如 Web openCommunity）都依赖它；index.html 里只是占位的 "en"。
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocalePreference = useCallback(
    (newPreference: LocalePreference) => {
      const operationSeq = localePreferenceOperationSeqRef.current + 1;
      localePreferenceOperationSeqRef.current = operationSeq;
      setLocalePreferenceState(newPreference);
      persistLocalePreference(newPreference);
      void (async () => {
        const resolvedLocale =
          newPreference === "system" ? await resolveSystemLocale() : newPreference;
        if (localePreferenceOperationSeqRef.current !== operationSeq) {
          return;
        }
        if (newPreference === "system") {
          setSystemLocale(resolvedLocale);
        }
        setLocaleResolved(true);
        const broadcastPayload: LocaleBroadcastPayload = {
          preference: newPreference,
          resolvedLocale,
        };
        if (!applyingBroadcastRef.current && broadcastService) {
          // 跨窗口语言同步不能等待 settingService 持久化 RPC。
          // 持久化可能超时或拒绝，但本地 UI 与其他窗口应先按用户最后一次选择同步。
          ignoredLocalLocaleBroadcastPayloadRef.current = broadcastPayload;
          void broadcastService.send({
            channel: STATE_LOCALE_CHANNEL,
            payload: broadcastPayload,
          }).finally(() => {
            if (
              ignoredLocalLocaleBroadcastPayloadRef.current?.preference === broadcastPayload.preference &&
              ignoredLocalLocaleBroadcastPayloadRef.current.resolvedLocale === broadcastPayload.resolvedLocale
            ) {
              ignoredLocalLocaleBroadcastPayloadRef.current = null;
            }
          });
        }
        enqueueLocalePreferenceUpdate(operationSeq, resolvedLocale, newPreference);
      })();
    },
    [broadcastService, enqueueLocalePreferenceUpdate, persistLocalePreference, resolveSystemLocale],
  );

  useEffect(() => {
    if (!broadcastService) {
      return;
    }

    const subscription = broadcastService.onMessage((message) => {
      if (
        !shouldApplyLocaleBroadcastMessage(message, {
          ignoredLocalPayload: ignoredLocalLocaleBroadcastPayloadRef.current,
        })
      ) {
        return;
      }

      ignoredLocalLocaleBroadcastPayloadRef.current = null;
      const payload = resolveLocaleBroadcastPayload(message.payload);
      if (!payload) {
        return;
      }
      applyingBroadcastRef.current = true;
      try {
        // 语言切换真实发生在 IntlProvider，不能只依赖 store 里的 locale 字段。
        // 结构化广播需要同时携带用户偏好和解析语言，避免 system 被其他窗口降级成固定语言。
        localePreferenceOperationSeqRef.current += 1;
        setLocalePreferenceState(payload.preference);
        persistLocalePreference(payload.preference);
        setSystemLocale(payload.resolvedLocale);
        setLocaleResolved(true);
      } finally {
        applyingBroadcastRef.current = false;
      }
    });

    return () => subscription.dispose();
  }, [broadcastService, persistLocalePreference]);

  // 没有 settingService / broadcastService 的独立窗口（资源管理器）只认 localStorage；
  // 主窗口切换语言写入 localStorage 时，这里经 storage 事件跟随，不必重开窗口。
  useEffect(() => {
    if (settingService || broadcastService || typeof window === "undefined") {
      return;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_PREFERENCE_KEY || !isLocalePreference(event.newValue)) {
        return;
      }
      localePreferenceOperationSeqRef.current += 1;
      setLocalePreferenceState(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [broadcastService, settingService]);

  const setLocale = useCallback(
    (newLocale: Locale) => {
      setLocalePreference(newLocale);
    },
    [setLocalePreference],
  );

  const intl = useMemo(() => createIntl(locale), [locale]);

  const value = useMemo<IntlContextValue>(
    () => ({ intl, locale, localePreference, localeResolved, setLocale, setLocalePreference }),
    [intl, locale, localePreference, localeResolved, setLocale, setLocalePreference],
  );

  return <IntlContext value={value}>{children}</IntlContext>;
}

/** 获取 intl 上下文 */
export function useZCodeIntl(): IntlContextValue {
  const ctx = useContext(IntlContext);
  if (!ctx) {
    throw new Error("useZCodeIntl 必须在 ZCodeIntlProvider 内使用");
  }
  return ctx;
}
