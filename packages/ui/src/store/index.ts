/**
 * Zustand Store —— 全局状态管理
 *
 * 需要跨窗口同步的状态通过 BroadcastService 广播。
 * 广播频道前缀 "state:" 表示状态同步类消息。
 */
import { create } from "zustand";
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { OAuthProviderId, UserInfo } from "@zcode/shared";
import type { CodingPlanResetType } from "@zcode/shared";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  applyCodingPlanQuotaResetAutoPlayedBroadcast,
  createCodingPlanQuotaResetStoreActions,
  parseCodingPlanQuotaResetAutoPlayedBroadcastMessage,
  type CodingPlanQuotaResetAutomaticObservations,
  type CodingPlanQuotaResetAutoPlayReservation,
  type CodingPlanQuotaResetAutoPlayReservationAttempt,
  type CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  applyUiFontSizePx,
  loadUiFontSizePx,
  normalizeUiFontSizePx,
  UI_FONT_SIZE_STORAGE_KEY,
} from "@/lib/uiFontSize.js";
import {
  isTaskNotificationEnabled,
  isTaskNotificationSoundPreferenceEnabled,
  persistTaskNotificationEnabled,
  persistTaskNotificationSoundEnabled,
} from "@/lib/taskNotificationPreferences.js";
import type { Theme } from "../useTheme.js";
import { applyTheme, normalizeThemePreference, resolveTheme } from "../useTheme.js";

import {
  INTERFACE_MODE_STORAGE_KEY,
  normalizeInterfaceMode,
  type InterfaceMode,
} from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";

export type LoginEntryPurpose = "app-login";

// v4 重构：类型与默认值下沉到 @/lib/codePreviewSettings.ts，
// 让纯展示组件不依赖 store；这里保留 re-export 兼容既有 import 路径。
export type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
export { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

export type LoginEntryAttemptStatus =
  | "requested"
  | "waiting"
  | "succeeded"
  | "cancelled"
  | "failed";

export interface LoginEntryAttempt {
  id: number;
  providerId?: OAuthProviderId;
  purpose?: LoginEntryPurpose;
  status: LoginEntryAttemptStatus;
}

const CODE_PREVIEW_SETTINGS_KEY = "zcode-code-preview-settings";
const FONT_SMOOTHING_STORAGE_KEY = "zcode-macos-font-smoothing";

function applyFontSmoothing(enabled: boolean): void {
  // 仅设置展示标记；CSS 以本机 macOS desktop 为边界，远端设备与 Web 不受影响。
  document.documentElement.classList.toggle("font-smoothing-enabled", enabled);
}

const PERFORMANCE_MODE_STORAGE_KEY = "zcode-performance-mode";
const HIDE_PROJECT_DEVICE_NAMES_STORAGE_KEY = "zcode-hide-project-device-names";
export const FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY =
  "zcode-file-manager-navigation-preferences";

function loadFileManagerNavigationPreferences(): Record<string, boolean> {
  try {
    const raw = readSafeLocalStorage(FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] =>
          entry[0].trim().length > 0 && typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function loadCodePreviewSettings(): CodePreviewSettings {
  try {
    const raw = readSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_CODE_PREVIEW_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<CodePreviewSettings>;
    return {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      ...parsed,
      fontSizePx:
        typeof parsed.fontSizePx === "number"
          ? Math.min(20, Math.max(12, Math.round(parsed.fontSizePx)))
          : DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}

function loadPerformanceMode(): boolean {
  return readSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY) === "true";
}

// ============================================================================
// State 定义
// ============================================================================

export interface ZCodeState {
  /** 展示详情偏好，不改变 Agent 权限或执行能力。 */
  interfaceMode: InterfaceMode;
  setInterfaceMode: (mode: InterfaceMode) => void;

  /** 当前主题 */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  /** 当前语言 */
  locale: string;
  setLocale: (locale: string) => void;

  /** 代码预览设置 */
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) => void;

  /** 各 workspace 的文件导航显隐偏好；缺席时默认展开。 */
  fileManagerNavigationOpenByWorkspace: Record<string, boolean>;
  setFileManagerNavigationOpen: (workspaceKey: string, open: boolean) => void;

  /** 本机 macOS 灰度字体平滑偏好。 */
  fontSmoothingEnabled: boolean;
  setFontSmoothingEnabled: (enabled: boolean) => void;
  /** UI 字号 token 的基准值（px），不改变根 rem。 */
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;

  /** 是否启用性能模式 */
  performanceMode: boolean;
  setPerformanceMode: (enabled: boolean) => void;

  /** 仅桌面项目行消费；设备身份和其他入口的显示不受影响。 */
  hideProjectDeviceNames: boolean;
  setHideProjectDeviceNames: (hidden: boolean) => void;

  /** 是否启用任务通知（桌面通知；提示音由子开关控制） */
  notificationEnabled: boolean;
  setNotificationEnabled: (enabled: boolean) => void;

  /** 是否启用任务通知声音（依附于任务通知总开关） */
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;

  /** 当前用户信息 */
  user: UserInfo | null;
  /** 用户由未登录进入登录态时递增；连接额外 provider 不会误判为重新登录。 */
  authSessionSeq: number;
  setUser: (user: UserInfo | null) => void;

  /** 启动阶段是否仍在恢复 OAuth 登录态 */
  isRestoringOAuthSession: boolean;
  setIsRestoringOAuthSession: (restoring: boolean) => void;

  /** OAuth 回调错误（Root 层写入，统一登录入口读取） */
  oauthError: string | null;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  oauthSuccessSeq: number;
  lastOAuthSuccessProvider: OAuthProviderId | null;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  apiKeyLoginSuccessSeq: number;
  lastApiKeyLoginModel: string | null;
  markApiKeyLoginSuccess: (preferredModel?: string | null) => void;
  /** 请求打开统一登录入口，可携带需要自动发起登录/连接的 provider */
  loginEntryRequest: {
    id: number;
    providerId?: OAuthProviderId;
    purpose?: LoginEntryPurpose;
  } | null;
  /** 当前统一登录尝试；购买等后续动作通过 id 只续接自己发起的 OAuth。 */
  loginEntryAttempt: LoginEntryAttempt | null;
  requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => number;
  clearLoginEntryRequest: (requestId?: number) => void;
  markLoginEntryAttemptStatus: (
    requestId: number,
    status: Exclude<LoginEntryAttemptStatus, "requested">,
  ) => void;

  /** Coding Plan 额度重置 UI 状态；entry/观察记录只在当前窗口内共享，不持久化。 */
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  /** 自动/运营完成首次被观察时所属的鉴权会话，用于区分同会话后挂载和重新登录。 */
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  /** 自动完成提示"多窗口只播一次"的已播 used_at 记录；窗口内存态，可被广播合并。 */
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
  /** 写入服务端 status / 手动 use 对账后的状态；entry 为 null 表示清空该类型。 */
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  /** Composer 展示前申请临时 reservation；此阶段不写 played。 */
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** 组件仍有效且即将展示时提交 reservation、played 与广播。 */
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  /** 组件失效时释放尚未 commit 的 reservation。 */
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;

  /** 手动请求打开 onboarding 弹窗 */
  newUserOnboardingOpen: boolean;
  setNewUserOnboardingOpen: (open: boolean) => void;
  /** 请求打开迁移向导；所有入口都直接进入第一步「会话」。 */
  onboardingDialogRequested: boolean;
  requestOnboardingDialog: () => void;
  clearOnboardingDialogRequest: () => void;
}

// ============================================================================
// 需要广播的字段 —— 只有这些字段的变更会发送给其他窗口
// ============================================================================

const BROADCAST_FIELDS = new Set([
  "theme",
  "locale",
  "uiFontSizePx",
  "fontSmoothingEnabled",
  "interfaceMode",
  "notificationEnabled",
  "hideProjectDeviceNames",
]);

type BroadcastField =
  | "theme"
  | "locale"
  | "uiFontSizePx"
  | "fontSmoothingEnabled"
  | "interfaceMode"
  | "hideProjectDeviceNames"
  // 任务通知开关跨窗口同步：角标是应用级表面，A 窗口关通知而 B 窗口仍上报未读时，
  // 主进程 max 聚合会让任务栏/托盘继续亮，设置与提醒状态错位。
  | "notificationEnabled";

/** 广播频道名前缀 */
const STATE_CHANNEL_PREFIX = "state:";

// ============================================================================
// Store 创建工厂
// ============================================================================

/**
 * 创建 Zustand store，连接广播服务实现跨窗口状态同步
 *
 * @param broadcastService - 广播服务。Desktop 走 RPC，Web 可传 no-op 实现
 */
export function createZCodeStore(
  broadcastService: IBroadcastService,
  options: {
    initialIsRestoringOAuthSession?: boolean;
  } = {},
) {
  /** 标记：正在应用来自广播的更新，此时不再重复广播（防止循环） */
  let applyingBroadcast = false;
  let loginEntryRequestSeq = 0;
  let cleanupSystemThemeListener: (() => void) | null = null;
  let syncSystemThemeListener = (_theme: Theme) => {};

  const useStore = create<ZCodeState>()((set, get) => ({
    interfaceMode: normalizeInterfaceMode(readSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY)),
    setInterfaceMode: (mode) => {
      const interfaceMode = normalizeInterfaceMode(mode);
      if (get().interfaceMode !== interfaceMode) {
        logger.debug("[InterfaceMode] 切换界面模式", {
          interfaceMode,
          source: applyingBroadcast ? "broadcast" : "local",
        });
      }
      writeSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY, interfaceMode);
      set({ interfaceMode });
    },
    // 默认主题统一收敛到 Zai dark，避免首次启动时 store 与其他主题入口表现不一致。
    // 仍然优先尊重 localStorage 中已保存的用户选择，不覆盖已有偏好。
    theme: normalizeThemePreference((readSafeLocalStorage("zcode-theme") as Theme) || "zai-dark"),
    setTheme: (theme: Theme) => {
      const normalizedTheme = normalizeThemePreference(theme);
      writeSafeLocalStorage("zcode-theme", normalizedTheme);
      syncSystemThemeListener(normalizedTheme);
      applyTheme(normalizedTheme);

      set({ theme: normalizedTheme });
    },

    locale: readSafeLocalStorage("zcode-locale") || "zh-CN",
    setLocale: (locale: string) => {
      writeSafeLocalStorage("zcode-locale", locale);
      set({ locale });
    },

    codePreviewSettings: loadCodePreviewSettings(),
    setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) =>
      set((state) => {
        const next = {
          ...state.codePreviewSettings,
          ...patch,
          fontSizePx:
            typeof patch.fontSizePx === "number"
              ? Math.min(20, Math.max(12, Math.round(patch.fontSizePx)))
              : state.codePreviewSettings.fontSizePx,
        };
        writeSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY, JSON.stringify(next));
        return { codePreviewSettings: next };
      }),

    fileManagerNavigationOpenByWorkspace: loadFileManagerNavigationPreferences(),
    setFileManagerNavigationOpen: (workspaceKey, open) => {
      const normalizedWorkspaceKey = workspaceKey.trim();
      if (!normalizedWorkspaceKey) return;
      set((state) => {
        const next = {
          ...state.fileManagerNavigationOpenByWorkspace,
          [normalizedWorkspaceKey]: open,
        };
        writeSafeLocalStorage(
          FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
          JSON.stringify(next),
        );
        return { fileManagerNavigationOpenByWorkspace: next };
      });
    },

    fontSmoothingEnabled: readSafeLocalStorage(FONT_SMOOTHING_STORAGE_KEY) !== "false",
    setFontSmoothingEnabled: (enabled) => {
      writeSafeLocalStorage(FONT_SMOOTHING_STORAGE_KEY, String(enabled));
      applyFontSmoothing(enabled);
      set({ fontSmoothingEnabled: enabled });
    },

    uiFontSizePx: loadUiFontSizePx(),
    setUiFontSizePx: (fontSizePx: number) => {
      const normalizedFontSizePx = normalizeUiFontSizePx(fontSizePx);
      writeSafeLocalStorage(UI_FONT_SIZE_STORAGE_KEY, String(normalizedFontSizePx));
      applyUiFontSizePx(normalizedFontSizePx);
      set({ uiFontSizePx: normalizedFontSizePx });
    },

    performanceMode: loadPerformanceMode(),
    setPerformanceMode: (enabled: boolean) => {
      writeSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY, enabled ? "true" : "false");
      set({ performanceMode: enabled });
    },

    hideProjectDeviceNames: readSafeLocalStorage(HIDE_PROJECT_DEVICE_NAMES_STORAGE_KEY) === "true",
    setHideProjectDeviceNames: (hidden) => {
      writeSafeLocalStorage(HIDE_PROJECT_DEVICE_NAMES_STORAGE_KEY, String(hidden));
      set({ hideProjectDeviceNames: hidden });
    },

    notificationEnabled: isTaskNotificationEnabled(),
    setNotificationEnabled: (enabled: boolean) => {
      persistTaskNotificationEnabled(enabled);
      set({ notificationEnabled: enabled });
    },

    notificationSoundEnabled: isTaskNotificationSoundPreferenceEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) => {
      persistTaskNotificationSoundEnabled(enabled);
      set({ notificationSoundEnabled: enabled });
    },

    user: null,
    authSessionSeq: 0,
    setUser: (user: UserInfo | null) =>
      set((state) => ({
        user,
        authSessionSeq:
          state.user === null && user !== null ? state.authSessionSeq + 1 : state.authSessionSeq,
      })),

    isRestoringOAuthSession: options.initialIsRestoringOAuthSession ?? false,
    setIsRestoringOAuthSession: (restoring: boolean) => set({ isRestoringOAuthSession: restoring }),

    oauthError: null,
    setOAuthError: (error: string | null) => set({ oauthError: error }),
    oauthPollingActive: false,
    setOAuthPollingActive: (active: boolean) => set({ oauthPollingActive: active }),
    oauthSuccessSeq: 0,
    lastOAuthSuccessProvider: null,
    markOAuthSuccess: (provider?: OAuthProviderId) =>
      set((state) => ({
        oauthSuccessSeq: state.oauthSuccessSeq + 1,
        lastOAuthSuccessProvider: provider ?? state.lastOAuthSuccessProvider,
      })),
    apiKeyLoginSuccessSeq: 0,
    lastApiKeyLoginModel: null,
    markApiKeyLoginSuccess: (preferredModel?: string | null) =>
      set((state) => ({
        apiKeyLoginSuccessSeq: state.apiKeyLoginSuccessSeq + 1,
        lastApiKeyLoginModel: preferredModel?.trim() || null,
      })),
    loginEntryRequest: null,
    loginEntryAttempt: null,
    requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => {
      const id = ++loginEntryRequestSeq;
      const attempt: LoginEntryAttempt = {
        id,
        providerId,
        purpose,
        status: "requested",
      };
      set({
        loginEntryRequest: {
          id,
          providerId,
          purpose,
        },
        loginEntryAttempt: attempt,
      });
      return id;
    },
    clearLoginEntryRequest: (requestId?: number) =>
      set((state) => {
        if (requestId !== undefined && state.loginEntryRequest?.id !== requestId) {
          return {};
        }
        return { loginEntryRequest: null };
      }),
    markLoginEntryAttemptStatus: (requestId, status) =>
      set((state) => {
        if (state.loginEntryAttempt?.id !== requestId) {
          return {};
        }
        return {
          loginEntryAttempt: {
            ...state.loginEntryAttempt,
            status,
          },
        };
      }),

    codingPlanQuotaResetUiBySource: {},
    codingPlanQuotaResetAutomaticObservationsBySource: {},
    codingPlanQuotaResetAutoPlayedBySource: {},
    ...createCodingPlanQuotaResetStoreActions({
      broadcastService,
      readState: get,
      writeState: (updater) => set((state) => updater(state)),
    }),

    newUserOnboardingOpen: false,
    setNewUserOnboardingOpen: (open) => set({ newUserOnboardingOpen: open }),
    onboardingDialogRequested: false,
    requestOnboardingDialog: () => set({ onboardingDialogRequested: true }),
    clearOnboardingDialogRequest: () => set({ onboardingDialogRequested: false }),
  }));

  syncSystemThemeListener = (theme: Theme) => {
    cleanupSystemThemeListener?.();
    cleanupSystemThemeListener = null;

    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (useStore.getState().theme !== "system") {
        return;
      }

      // system 模式需要持续订阅系统亮暗变化，不能只在切换到 system 的瞬间应用一次。
      // 否则用户后续切系统主题时，DOM 上的 dark class 不会同步更新，看起来就像“跟随系统失效”。
      applyTheme("system");
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      cleanupSystemThemeListener = () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
      return;
    }

    // 某些 Electron / Chromium 组合仍然只支持旧版 MediaQueryList listener API。
    // 如果这里只调用 addEventListener，system 模式切系统主题时会完全收不到通知。
    mediaQuery.addListener(handleSystemThemeChange);
    cleanupSystemThemeListener = () => {
      mediaQuery.removeListener(handleSystemThemeChange);
    };
  };

  // Zustand v5 的 setState 在 replace=true/false 上使用了不同重载，
  // 之前直接包一层并透传 replace，会在严格类型下落到互不兼容的签名分支。
  // 这里改成订阅状态变化后再广播，只比较真正需要跨窗口同步的字段，逻辑更直观，也避免重载冲突。
  useStore.subscribe((state, prevState) => {
    if (applyingBroadcast) {
      return;
    }

    for (const field of BROADCAST_FIELDS as Set<BroadcastField>) {
      if (state[field] === prevState[field]) {
        continue;
      }

      broadcastService.send({
        channel: `${STATE_CHANNEL_PREFIX}${field}`,
        payload: state[field],
      });
    }
  });

  // 监听来自其他窗口的广播
  broadcastService.onMessage((msg: BroadcastMessage) => {
    // 自动完成"多窗口只播一次"。其他窗口广播已播 used_at 后，本窗口合并
    // played 记录并收起正在播放的同 used_at 提示；本地回声已在解析阶段被忽略。
    const autoPlayed = parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(msg);
    if (autoPlayed) {
      useStore.setState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, autoPlayed));
      return;
    }

    if (!msg.channel.startsWith(STATE_CHANNEL_PREFIX)) return;

    const field = msg.channel.slice(STATE_CHANNEL_PREFIX.length) as BroadcastField;
    if (!BROADCAST_FIELDS.has(field)) return;

    applyingBroadcast = true;
    try {
      // 调用对应的 setter，确保副作用（localStorage、DOM）也执行
      const state = useStore.getState();
      if (field === "theme" && typeof msg.payload === "string") {
        state.setTheme(msg.payload as Theme);
      } else if (field === "locale" && typeof msg.payload === "string") {
        state.setLocale(msg.payload);
      } else if (
        field === "interfaceMode" &&
        (msg.payload === "office" || msg.payload === "coding")
      ) {
        state.setInterfaceMode(normalizeInterfaceMode(msg.payload));
      } else if (field === "fontSmoothingEnabled" && typeof msg.payload === "boolean") {
        state.setFontSmoothingEnabled(msg.payload);
      } else if (field === "uiFontSizePx" && typeof msg.payload === "number") {
        state.setUiFontSizePx(msg.payload);
      } else if (field === "notificationEnabled" && typeof msg.payload === "boolean") {
        state.setNotificationEnabled(msg.payload);
      } else if (field === "hideProjectDeviceNames" && typeof msg.payload === "boolean") {
        state.setHideProjectDeviceNames(msg.payload);
      }
    } finally {
      applyingBroadcast = false;
    }
  });

  syncSystemThemeListener(useStore.getState().theme);
  applyTheme(useStore.getState().theme);
  applyUiFontSizePx(useStore.getState().uiFontSizePx);
  applyFontSmoothing(useStore.getState().fontSmoothingEnabled);
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(useStore.getState().theme) === "dark",
  );

  return useStore;
}

export type ZCodeStore = ReturnType<typeof createZCodeStore>;
