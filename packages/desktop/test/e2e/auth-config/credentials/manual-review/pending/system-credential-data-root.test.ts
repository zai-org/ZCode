import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AsyncEntry } from "@napi-rs/keyring";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";

// ZCT-2120723935487688704：3.18.0 起系统条目按凭据文件路径区分，切换数据存储路径只复制文件时，
// 新根启动后解不开原凭据，也不能重新登录。本用例在真实系统库上验证切换时由 Main 登记密钥。
const SERVICE = "ZCode Credential Encryption";
const KEY = "bot:e2e:data-root";
const VALUE = "E2E_DATA_ROOT_SYNTHETIC_VALUE";
const RELOGIN_KEY = "bot:e2e:data-root-relogin";
const RELOGIN_VALUE = "E2E_DATA_ROOT_RELOGIN_VALUE";
const SHELL_SELECTOR_IDS = ["onboarding-page", "oauth-login-button"] as const;
const CASE_TIMEOUT_MS = 240_000;

type HostServiceName = "credentialService" | "settingService";

/** 经 Renderer 的服务访问器调用真实 Host RPC，与设置页、登录页使用同一入口。 */
async function callHostService(service: HostServiceName, method: string, args: unknown[]) {
  return browser.execute(
    async (loginTriggerId, extraIds, serviceName, methodName, methodArgs) => {
      const selector = [loginTriggerId, ...extraIds]
        .map((id) => `[data-testid="${id}"]`)
        .join(", ");
      const element = document.querySelector(selector)!;
      let fiber = (element as any)[
        Object.keys(element).find((name) => name.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const context = fiber.memoizedProps?.value;
        const services = context?.[serviceName] ? context : fiber.memoizedProps?.services;
        const target = services?.[serviceName];
        if (target) return target[methodName](...methodArgs);
        fiber = fiber.return;
      }
      throw new Error(`${serviceName} not found`);
    },
    TID_LOGIN_TRIGGER,
    [...SHELL_SELECTOR_IDS],
    service,
    method,
    args,
  );
}

async function waitForShell() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (loginTriggerId, extraIds) =>
          Boolean(
            document.querySelector(
              [loginTriggerId, ...extraIds].map((id) => `[data-testid="${id}"]`).join(", "),
            ),
          ),
        TID_LOGIN_TRIGGER,
        [...SHELL_SELECTOR_IDS],
      ),
    { timeout: 60_000, timeoutMsg: "数据根切换用例：应用外壳没有就绪" },
  );
}

const accountFor = (credentialsFile: string) =>
  createHash("sha256").update(credentialsFile).digest("hex");
const fingerprintOf = (ciphertext: string) => ciphertext.split(":")[3];

async function readRecord(file: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
}

/** macOS 只查询条目是否存在，不读取密钥（只有 Main 可以访问系统库中的密钥）。 */
async function hasMacKeychainEntry(account: string): Promise<boolean> {
  try {
    await promisify(execFile)("/usr/bin/security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
    ]);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 44) return false;
    throw error;
  }
}

async function deleteKeychainEntry(account: string) {
  if (process.platform === "darwin") {
    // 原生条目由 Main 创建；runner 的 SDK 删除会返回 owner-edit 错误，按唯一 account 精确删除。
    await promisify(execFile)("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
    ]).catch((error: { code?: number }) => {
      if (error.code !== 44) throw error;
    });
    return;
  }
  await new AsyncEntry(SERVICE, account, { linux: { store: "secret-service" } })
    .deleteCredential()
    .catch(() => {});
}

describe("System credential storage across a data directory change", () => {
  it("registers the OS key for the new data root so credentials survive restart and new writes succeed", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    const paths = getE2EAppDataPaths();
    const customBaseDir = join(paths.homeDir, "scs-data-root-custom");
    const customCredentialsFile = join(customBaseDir, ".zcode", "v2", "credentials.json");
    const bootstrapSettingsFile = join(paths.appDataDir, "setting.json");
    const keychainLink = join(paths.homeDir, "Library", "Keychains");
    const accounts = [paths.credentialsFile, customCredentialsFile].map(accountFor);
    expect(await browser.electron.execute(() => Boolean(process.env.ZCODE_CREDENTIAL_SECRET))).toBe(
      false,
    );
    try {
      await waitForShell();
      // 1) 默认根：合成旧明文经真实 Host 委托 Main 迁移为 OS 密文，并创建默认根的系统条目。
      const existing = await readRecord(paths.credentialsFile);
      await writeFile(paths.credentialsFile, JSON.stringify({ ...existing, [KEY]: VALUE }));
      expect(await callHostService("credentialService", "load", [KEY])).toBe(VALUE);
      const migrated = (await readRecord(paths.credentialsFile))[KEY]!;
      expect(migrated).toMatch(/^enc:v2:os:/);
      const fingerprint = fingerprintOf(migrated);

      // 2) 切换数据存储路径：与设置页相同的 Host RPC；复制后由 Main 登记目标根条目。
      await rm(customBaseDir, { force: true, recursive: true });
      await mkdir(customBaseDir, { recursive: true });
      await callHostService("settingService", "updateDataBaseDir", [customBaseDir]);
      const bootstrap = await readRecord(bootstrapSettingsFile);
      expect(bootstrap.dataBaseDir).toBe(customBaseDir);
      expect((await readRecord(customCredentialsFile))[KEY]).toBe(migrated);
      if (process.platform === "darwin") {
        expect(await hasMacKeychainEntry(accounts[1]!)).toBe(true);
      }

      // 3) 冷重启：Main 绑定新根凭据路径，复制来的密文仍可读取（修复前为安全存储不可用）。
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForShell();
      expect(await callHostService("credentialService", "load", [KEY])).toBe(VALUE);

      // 4) 新根上写入新凭据（等价于重新登录写入）成功，且沿用同一把密钥。
      await callHostService("credentialService", "save", [RELOGIN_KEY, RELOGIN_VALUE]);
      expect(await callHostService("credentialService", "load", [RELOGIN_KEY])).toBe(RELOGIN_VALUE);
      const customRecord = await readRecord(customCredentialsFile);
      expect(customRecord[RELOGIN_KEY]).toMatch(/^enc:v2:os:/);
      expect(fingerprintOf(customRecord[RELOGIN_KEY]!)).toBe(fingerprint);
      expect(JSON.stringify(customRecord)).not.toContain(RELOGIN_VALUE);
      // 原根文件保持复制语义：仍在原处且未被改写。
      await access(paths.credentialsFile);
      expect((await readRecord(paths.credentialsFile))[KEY]).toBe(migrated);
    } finally {
      await clearAppData();
      await rm(customBaseDir, { force: true, recursive: true });
      for (const account of accounts) await deleteKeychainEntry(account);
      if (process.platform === "darwin") await rm(keychainLink, { force: true });
    }
  });
});
