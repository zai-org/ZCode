import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocale, resolvePersistedUiLocale } from "@zcode/shared";
import type { Locale } from "@zcode/shared";

/**
 * 与 settingService 的 resolveUserHomeDir 保持同一优先级：独立 Dev 实例用 ZCODE_DESKTOP_HOME_DIR，
 * 否则用 HOME / USERPROFILE。不能直接用 os.homedir()，否则隔离实例会读到真实用户的设置。
 */
function resolveBootstrapHomeDir(): string {
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export function resolveApplicationLocaleBootstrapSettingsFile(
  homePath: string = resolveBootstrapHomeDir(),
): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

export function extractBootstrapApplicationLocale(rawValue: unknown): Locale | undefined {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return undefined;
  }
  // setting.json 的 uiLocale（缺失时回落旧字段 locale）是"实际界面语言"：localePreference=system 时
  // renderer 也会把解析出的系统语言写回这里，所以不需要在 Main 早期再解析 system。
  // 旧字段 locale 为兼容降级只存中英，必须走 resolvePersistedUiLocale 新字段优先，
  // 否则 ja/ru/ko 用户冷启动第一个请求的 X-Client-Language 会退化成 en-US。
  const locale = resolvePersistedUiLocale(rawValue as Record<string, unknown>);
  return isLocale(locale) ? locale : undefined;
}

/**
 * 在 Main 模块加载时同步读取持久化的界面语言，作为 currentApplicationLocale 的初值。
 *
 * bug 原因：currentApplicationLocale 以前初值是 DEFAULT_LOCALE(zh-CN)，要等 whenReady 里
 * 异步 settingService.get() 完成才赋值；而远控 notification/status 轮询在模块加载时就启动，
 * 于是 UI 语言为 ja/ru/ko 的用户冷启动第一个请求带 X-Client-Language=zh-CN。
 * setting.json 只有几 KB，同步读取对启动耗时影响可忽略（同 dataBaseDir / 硬件加速的早期 bootstrap）。
 * 文件不存在（首次启动）或读失败时返回 undefined，由调用方在 app ready 后用系统语言确定。
 */
export function readBootstrapApplicationLocale(
  settingsFile: string = resolveApplicationLocaleBootstrapSettingsFile(),
): Locale | undefined {
  if (!existsSync(settingsFile)) {
    return undefined;
  }
  try {
    return extractBootstrapApplicationLocale(JSON.parse(readFileSync(settingsFile, "utf-8")));
  } catch {
    return undefined;
  }
}
