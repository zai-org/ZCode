import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

/*
 * 官方插件缓存预热（docs/testing/conversation-session-automatic-e2e-ci.md「官方插件缓存预热」）。
 *
 * 修复原因：每个 spec 的 beforeSession 都会重置 HOME。CLI 首次处理请求时在事件循环上同步
 * seed 约 1100 个官方插件文件，Windows 上阻塞 8–15s，session/create 排在其后，首发用例的
 * “输入框清空”等待因此超时。这里在 launcher 用同一份 CLI 只 seed 一次模板，再在每个 HOME
 * 启动 Electron 前拷入；CLI 的 seed marker 校验命中后不再重写，业务用例不再承担冷启动开销。
 */

const execFileAsync = promisify(execFile);
const OFFICIAL_PLUGIN_CACHE_SEGMENTS = [
  ".zcode",
  "cli",
  "plugins",
  "cache",
  "zcode-plugins-official",
] as const;
const SEED_TIMEOUT_MS = 180_000;

function officialPluginCacheDir(homeDir: string): string {
  return join(homeDir, ...OFFICIAL_PLUGIN_CACHE_SEGMENTS);
}

/** 用 E2E 实际启动的 CLI 在模板 HOME 中 seed 官方插件缓存；`plugin list` 会完成 seed 后退出。 */
export async function prepareOfficialPluginCacheTemplate(input: {
  cliEntryPoint: string;
  templateHome: string;
}): Promise<void> {
  await rm(input.templateHome, { force: true, recursive: true });
  await mkdir(input.templateHome, { recursive: true });
  await execFileAsync(process.execPath, [input.cliEntryPoint, "plugin", "list"], {
    env: {
      ...process.env,
      HOME: input.templateHome,
      USERPROFILE: input.templateHome,
      ZCODE_DATA_BASE_DIR: input.templateHome,
      ZCODE_DESKTOP_HOME_DIR: input.templateHome,
    },
    timeout: SEED_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!existsSync(officialPluginCacheDir(input.templateHome))) {
    throw new Error(`官方插件缓存预热没有生成 cache 目录: ${input.templateHome}`);
  }
}

/** 把模板缓存拷入新 HOME；模板不存在时返回 false，由 CLI 照常冷 seed。 */
export async function installOfficialPluginCacheTemplate(input: {
  homeDir: string;
  templateHome: string;
}): Promise<boolean> {
  const source = officialPluginCacheDir(input.templateHome);
  if (!existsSync(source)) return false;
  await cp(source, officialPluginCacheDir(input.homeDir), { recursive: true });
  return true;
}
