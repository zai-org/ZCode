import { readFile } from "node:fs/promises";
import {
  resolvePreinstalledToolsCatalog,
  type PreinstalledToolConfiguration,
} from "@zcode/shared/preinstalled-tools";
import preinstalledToolCatalog from "@desktop/preinstalled-tools/catalog.json" with { type: "json" };

declare const __ZCODE_PREINSTALL_TEST_BUILD__: boolean;

const PREINSTALLED_TOOLS_CDN_BASE_URL = "https://cdn-zcode.z.ai/zcode/preinstalled-tools";
const PREINSTALLED_TOOLS_CDN_BASE_URL_ENV = "ZCODE_PREINSTALLED_TOOLS_CDN_BASE_URL";

/** 设置了覆盖变量就按书写顺序使用候选；默认仅使用已经部署资源的官方 CDN。 */
function resolvePreinstalledToolsCdnBaseUrls(): string[] {
  const override = process.env[PREINSTALLED_TOOLS_CDN_BASE_URL_ENV]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (override?.length) return override;
  return [PREINSTALLED_TOOLS_CDN_BASE_URL];
}

/**
 * Main 只装配构建配置；Host 无需等待本次读取或工具初始化。
 * 返回 null 表示清单不可用：工具归属未知，预装进程不得按 catalog 回收任何入口或目录。
 * 修复原因：此前任何装配失败都在 Main 变成空列表，预装进程把它当作全部工具移出 catalog，
 * 撤销入口并删除已安装资源（含 Python 附加区）。
 */
export async function loadPreinstalledToolsCatalog(logger: {
  error(...args: unknown[]): void;
}): Promise<PreinstalledToolConfiguration[] | null> {
  try {
    const catalog: unknown =
      __ZCODE_PREINSTALL_TEST_BUILD__ && process.env.ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG
        ? JSON.parse(await readFile(process.env.ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG, "utf8"))
        : preinstalledToolCatalog;
    const { tools, downloadBaseUrlsError } = resolvePreinstalledToolsCatalog(
      catalog,
      process.platform,
      process.arch,
      resolvePreinstalledToolsCdnBaseUrls(),
    );
    if (downloadBaseUrlsError)
      logger.error(
        `[preinstalled-tools] invalid ${PREINSTALLED_TOOLS_CDN_BASE_URL_ENV}; all tools have no target`,
        downloadBaseUrlsError,
      );
    return tools;
  } catch (error) {
    logger.error("[preinstalled-tools] invalid static target configuration", error);
    return null;
  }
}
