import { rewardsContextSchema, type RewardsContext } from "./rewardsEmbedded.js";

/** 此函数经 preload 序列化到网页主世界，不能引用模块外的运行时变量。 */
export function installRewardsPageBridge() {
  // 持久分区可能遗留上次账号；在业务脚本运行前清除，等待本次 App 注入完成。
  const storage = (globalThis as unknown as { localStorage: { removeItem: (key: string) => void } })
    .localStorage;
  for (const key of [
    "oauth:zai:access_token",
    "oauth:zai_cn:access_token",
    "oauth:bigmodel:access_token",
    "oauth:active_provider",
    "zcodejwttoken",
  ])
    storage.removeItem(key);
  const window = (
    globalThis as unknown as {
      window: { addEventListener: (event: string, callback: (event: Event) => void) => void };
    }
  ).window;
  let current: RewardsContext | null = null;
  const listeners = {
    theme: new Set<(value: unknown) => void>(),
    locale: new Set<(value: unknown) => void>(),
    auth: new Set<(value: unknown) => void>(),
  };
  window.addEventListener("zcode-rewards-context", (event) => {
    const next = (event as CustomEvent).detail;
    if (
      !next ||
      !["zai-light", "zai-dark"].includes(next.theme) ||
      !["zh-CN", "en-US"].includes(next.locale) ||
      !next.auth ||
      !["ready", "anonymous"].includes(next.auth.status) ||
      ![null, "zai", "zai_cn", "bigmodel"].includes(next.auth.provider) ||
      !Number.isSafeInteger(next.auth.revision) ||
      next.auth.revision < 0
    )
      return;
    const previous = current;
    current = next;
    for (const key of ["theme", "locale", "auth"] as const) {
      if (JSON.stringify(previous?.[key]) !== JSON.stringify(next[key])) {
        for (const callback of listeners[key]) callback(next[key]);
      }
    }
  });
  Object.defineProperty(window, "zcodeBridge", {
    configurable: false,
    writable: false,
    value: {
      // 对象方法不引入 esbuild keepNames 辅助闭包；序列化到主世界后可独立执行。
      getTheme() {
        return current?.theme ?? null;
      },
      getLang() {
        return current?.locale ?? null;
      },
      getAuthState() {
        return current?.auth ?? null;
      },
      onThemeChange(callback: (value: unknown) => void) {
        listeners.theme.add(callback);
        return () => listeners.theme.delete(callback);
      },
      onLangChange(callback: (value: unknown) => void) {
        listeners.locale.add(callback);
        return () => listeners.locale.delete(callback);
      },
      onAuthChange(callback: (value: unknown) => void) {
        listeners.auth.add(callback);
        return () => listeners.auth.delete(callback);
      },
    },
  });
}

export function createRewardsInjectionScript(
  context: RewardsContext,
  credentials: { oauth?: string | null; jwt?: string | null },
  expectedUrl?: string,
): string {
  const snapshot = rewardsContextSchema.parse(context);
  const values =
    snapshot.auth.status === "ready"
      ? {
          [`oauth:${snapshot.auth.provider}:access_token`]: credentials.oauth?.trim() || null,
          zcodejwttoken: credentials.jwt?.trim() || null,
          "oauth:active_provider": snapshot.auth.provider,
        }
      : {};
  return `(() => {
    ${expectedUrl ? `if (window.location.href !== ${JSON.stringify(expectedUrl)}) return;` : ""}
    for (const key of ["oauth:zai:access_token", "oauth:zai_cn:access_token", "oauth:bigmodel:access_token", "oauth:active_provider", "zcodejwttoken"]) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(${JSON.stringify(values)})) if (value) localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent("zcode-rewards-context", { detail: ${JSON.stringify(snapshot)} }));
  })()`;
}
