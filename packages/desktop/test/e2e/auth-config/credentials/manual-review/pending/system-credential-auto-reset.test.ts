import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";

// 规格：docs/plans/2026-10-29-system-credential-storage.md「已绑定目录：自动重置」。
const KEY = "bot:e2e:auto-reset";
const OLD_VALUE = "E2E_AUTO_RESET_OLD_SYNTHETIC_VALUE";
const NEW_VALUE = "E2E_AUTO_RESET_NEW_SYNTHETIC_VALUE";
const SERVICE = "ZCode Credential Encryption";
const SHELL_SELECTOR = `[data-testid="${TID_LOGIN_TRIGGER}"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]`;

type HostResult = { ok: true; value: string | null } | { ok: false; message: string };

// 经真实 Renderer → Host → 凭据桥 → Main 调用凭据服务；失败以结构化结果返回，便于断言。
async function callHost(method: "load" | "save", args: string[]): Promise<HostResult> {
  return browser.execute(
    async (selector, name, params) => {
      const element = document.querySelector(selector)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const context = fiber.memoizedProps?.value;
        const services = context?.credentialService ? context : fiber.memoizedProps?.services;
        if (services?.credentialService) {
          try {
            const value = await services.credentialService[name](...params);
            return { ok: true as const, value: value ?? null };
          } catch (error) {
            return { ok: false as const, message: String((error as Error)?.message ?? error) };
          }
        }
        fiber = fiber.return;
      }
      throw new Error("Credential service not found");
    },
    SHELL_SELECTOR,
    method,
    args,
  );
}

async function waitForShell() {
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => Boolean(document.querySelector(selector)), SHELL_SELECTOR),
    { timeout: 60000 },
  );
}

async function resetBackups(file: string) {
  const prefix = `${basename(file)}.key-unavailable-`;
  return (await readdir(dirname(file))).filter((name) => name.startsWith(prefix));
}

describe("System credential storage automatic reset", () => {
  it("resets a store whose OS key entry was lost, then saves and restores a new login", async function () {
    // 删除系统条目依赖 macOS security 工具；Windows/Linux 原生行为见 spec 的未验证项。
    if (process.platform !== "darwin") this.skip();
    this.timeout(180000);
    const paths = getE2EAppDataPaths();
    const file = paths.credentialsFile;
    const account = createHash("sha256").update(file).digest("hex");
    const keychainLink = join(paths.homeDir, "Library", "Keychains");
    const sourceFile = join(dirname(file), "credential-source");
    // 原生条目由 Main 创建；测试 runner 的 SDK 删除会返回 owner-edit 错误。
    // 系统工具按本用例唯一 account 精确删除，不读取或导出密钥。
    const deleteEntry = () =>
      promisify(execFile)("/usr/bin/security", [
        "delete-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
      ]).catch((error: { code?: number }) => {
        if (error.code !== 44) throw error;
      });
    // 真实系统库专项：不得注入托管密钥，否则来源永远是 env，走不到系统库。
    expect(await browser.electron.execute(() => Boolean(process.env.ZCODE_CREDENTIAL_SECRET))).toBe(
      false,
    );
    try {
      await waitForShell();
      // 1. 制造已绑定 os 的凭据库：合成明文经 Host 委托 Main 迁移为 OS 密文。
      const existing = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...existing, [KEY]: OLD_VALUE }));
      expect(await callHost("load", [KEY])).toEqual({ ok: true, value: OLD_VALUE });
      const bound = await readFile(file);
      expect(JSON.parse(bound.toString("utf8"))[KEY]).toMatch(/^enc:v2:os:/);
      expect(await readFile(sourceFile, "utf8")).toBe("os\n");

      // 2. 系统条目丢失（如重置登录钥匙串），再冷启动：Main 加载密钥得到 missing。
      await deleteEntry();
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForShell();

      // 3. 首次凭据读取让 Main 加载密钥得到 missing：本次请求失败，Main 随后在后台自动重置。
      // 隔离环境的启动阶段不读取凭据（运行时日志只有 inspectStore），必须由用例触发首次读取。
      const first = await callHost("load", [KEY]);
      expect(first.ok).toBe(false);
      // 重置后：备份逐字节保留旧库，写空库，解除来源绑定。
      await browser.waitUntil(async () => (await resetBackups(file)).length === 1, {
        timeout: 30000,
        timeoutMsg: "automatic credential reset did not produce a backup",
      });
      const [backup] = await resetBackups(file);
      expect((await readFile(join(dirname(file), backup!))).equals(bound)).toBe(true);
      await browser.waitUntil(
        async () => JSON.stringify(JSON.parse(await readFile(file, "utf8"))) === "{}",
        { timeout: 30000, timeoutMsg: "credential store was not cleared after the reset" },
      );
      await expect(readFile(sourceFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");

      // 4. 无需重启即可重新保存：系统库可用，重建系统密钥并重新固定 os。
      expect(await callHost("load", [KEY])).toEqual({ ok: true, value: null });
      expect(await callHost("save", [KEY, NEW_VALUE])).toEqual({ ok: true, value: null });
      expect(JSON.parse(await readFile(file, "utf8"))[KEY]).toMatch(/^enc:v2:os:/);
      expect(await readFile(sourceFile, "utf8")).toBe("os\n");

      // 5. 冷启动后读回新值，且不会再次清空。
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForShell();
      expect(await callHost("load", [KEY])).toEqual({ ok: true, value: NEW_VALUE });
      expect(await resetBackups(file)).toHaveLength(1);
    } finally {
      await clearAppData();
      await deleteEntry();
      await rm(keychainLink, { force: true });
    }
  });
});
