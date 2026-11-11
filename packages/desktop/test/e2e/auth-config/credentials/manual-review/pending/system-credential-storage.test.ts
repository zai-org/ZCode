import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { AsyncEntry } from "@napi-rs/keyring";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";

const KEY = "bot:e2e:secure-storage";
const VALUE = "E2E_SYSTEM_STORAGE_SYNTHETIC_VALUE";
async function readThroughHost() {
  return browser.execute(
    async (id, key) => {
      const element = document.querySelector(
        `[data-testid="${id}"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]`,
      )!;
      let fiber = (element as any)[
        Object.keys(element).find((name) => name.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const context = fiber.memoizedProps?.value;
        const services = context?.credentialService ? context : fiber.memoizedProps?.services;
        if (services?.credentialService) return services.credentialService.load(key);
        fiber = fiber.return;
      }
      throw new Error("Credential service not found");
    },
    TID_LOGIN_TRIGGER,
    KEY,
  );
}
async function waitForShell() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (id) =>
          Boolean(
            document.querySelector(
              `[data-testid="${id}"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]`,
            ),
          ),
        TID_LOGIN_TRIGGER,
      ),
    { timeout: 60000 },
  );
}

describe("System credential storage", () => {
  it("migrates a legacy secret through the real Host and restores it across restart using the OS key store", async function () {
    this.timeout(120000);
    const paths = getE2EAppDataPaths();
    const file = paths.credentialsFile;
    const keychainLink = join(paths.homeDir, "Library", "Keychains");
    // 测试 HOME 不含 macOS 默认钥匙串；只链接系统库位置，应用数据仍留在隔离目录。
    // 仅创建/清理本用例散列目录名对应的临时条目，不修改系统默认钥匙串设置。
    // 链接由 beforeSession 在启动 Main 前准备，不能在首次访问失败后再补。
    const entry = new AsyncEntry(
      "ZCode Credential Encryption",
      createHash("sha256").update(file).digest("hex"),
      { linux: { store: "secret-service" } },
    );
    expect(await browser.electron.execute(() => Boolean(process.env.ZCODE_CREDENTIAL_SECRET))).toBe(
      false,
    );
    try {
      await waitForShell();
      const existing = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...existing, [KEY]: VALUE }));
      expect(await readThroughHost()).toBe(VALUE);
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw[KEY]).toMatch(/^enc:v2:os:/);
      expect(JSON.stringify(raw)).not.toContain(VALUE);
      // 新合同只允许 Main 访问系统库，runner 不再用独立 Node 身份读取密钥。
      for (let index = 0; index < 10; index++) expect(await readThroughHost()).toBe(VALUE);
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForShell();
      expect(await readThroughHost()).toBe(VALUE);
    } finally {
      await clearAppData();
      if (process.platform === "darwin") {
        // 原生条目由 Main 创建；测试 runner 的 SDK 删除会返回 owner-edit 错误。
        // 系统工具按本用例唯一 account 精确删除，不读取或导出密钥。
        await promisify(execFile)("/usr/bin/security", [
          "delete-generic-password",
          "-s",
          "ZCode Credential Encryption",
          "-a",
          createHash("sha256").update(file).digest("hex"),
        ]).catch((error: { code?: number }) => {
          if (error.code !== 44) throw error;
        });
      } else {
        await entry.deleteCredential();
      }
      if (process.platform === "darwin") await rm(keychainLink, { force: true });
    }
  });
});
