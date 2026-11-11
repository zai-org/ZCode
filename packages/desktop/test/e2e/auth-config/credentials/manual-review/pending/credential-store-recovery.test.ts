import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getE2EAppDataPaths,
  waitForTestIdByDom,
  clickTestIdByDom,
  readE2ECredentialValue,
} from "#e2e/helpers/desktop-app";
import { openSubagentHostWindow } from "#e2e/helpers/subagent-host-window";
import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";

async function selectRecoveryLocale(locale: string) {
  await browser.execute((value) => {
    type Fiber = {
      return?: Fiber;
      memoizedProps?: { value?: { setLocalePreference?: (locale: string) => void } };
    };
    for (const element of document.querySelectorAll("div,button")) {
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
      for (
        let fiber = key ? (Reflect.get(element, key) as Fiber) : undefined;
        fiber;
        fiber = fiber.return
      ) {
        const context = fiber.memoizedProps?.value;
        if (context?.setLocalePreference) {
          context.setLocalePreference(value);
          return;
        }
      }
    }
    throw new Error("Missing actual locale context");
  }, locale);
}

/**
 * 单入口登录按区域选择渠道：中文默认国内 zai_cn，其轮询只受夹具 cn-ready 控制。
 * 恢复用例依赖 hold-poll / enable-poll 挂起与放行旧流程，因此登录前显式选全球区 zai。
 */
async function selectGlobalLoginRegion() {
  // 切换区域会同时切换界面语言并重渲染，每次从 DOM 重新读取，避免持有失效节点。
  const readRegion = () =>
    browser.execute(
      () => document.querySelector('[data-testid="login-region-switch"]')?.textContent ?? "",
    );
  await waitForTestIdByDom("login-region-switch", { timeout: 30000 });
  if ((await readRegion()).includes("Global")) await clickTestIdByDom("login-region-switch");
  let text = "";
  await browser.waitUntil(async () => (text = await readRegion()).includes("中国"), {
    timeoutMsg: `登录区域未切到全球区，当前开关文案：${text}`,
  });
}

describe("凭据容器确认恢复", () => {
  it("整库恢复后拒绝旧纯归因回调，新流程和归因去重仍有效", async function () {
    this.timeout(30_000);
    const fixture = fileURLToPath(
      new URL("../../../../fixtures/credential-recovery/oauth-attribution.ts", import.meta.url),
    );
    const result = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "oauth-attribution-recovery.json");
    await promisify(execFile)(process.execPath, ["--import", "tsx", fixture, result], {
      timeout: 25_000,
    });
    expect(JSON.parse(await readFile(result, "utf8")).results).toEqual(
      ["zai", "bigmodel"].map((provider) => ({
        provider,
        staleAttributionRejected: true,
        emptyStorePreserved: true,
        freshAttributionPreserved: true,
        duplicateRejected: true,
      })),
    );
  });
  it("恢复期间排队的条件写入或删除拒绝旧代次，新请求保持比较语义", async function () {
    this.timeout(30_000);
    const fixture = fileURLToPath(
      new URL("../../../../fixtures/credential-recovery/conditional-mutations.ts", import.meta.url),
    );
    const result = join(
      process.env.ZCODE_E2E_ARTIFACT_DIR!,
      "conditional-credential-mutations.json",
    );
    await promisify(execFile)(process.execPath, ["--import", "tsx", fixture, result], {
      timeout: 25_000,
    });
    expect(JSON.parse(await readFile(result, "utf8")).results).toEqual([
      { method: "saveIfAbsent", staleRejected: true, newOperationsPreserved: true },
      { method: "deleteIfEquals", staleRejected: true, newOperationsPreserved: true },
    ]);
  });
  it("所有网络入口和提权路径拒绝恢复，仅本机桌面保留", async function () {
    this.timeout(30_000);
    const fixture = fileURLToPath(
      new URL("../../../../fixtures/credential-recovery/server-websocket.ts", import.meta.url),
    );
    const result = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "server-credential-rpc-denied.json");
    await promisify(execFile)(process.execPath, ["--import", "tsx", fixture, result], {
      timeout: 25_000,
    });
    const rows = JSON.parse(await readFile(result, "utf8")).results;
    expect(rows.map((row: { publisher: string }) => row.publisher)).toEqual([
      "web-server-public",
      "web-server-authenticated",
      "source-server-core",
      "legacy-stdio",
      "local-desktop-policy",
      "attachment-desktop-continuous-remote",
      "attachment-desktop-continuous-source-settings",
      "attachment-desktop-continuous-unspecified",
      "attachment-web-remote-replayable-local",
    ]);
    for (const row of rows) {
      if (row.publisher === "local-desktop-policy") expect(row.recoveryPreserved).toBe(true);
      else {
        for (const boundary of row.direct ? [row.direct, row.selfIssuedCapability] : [row]) {
          expect(boundary.denied).toEqual({
            inspectStore: "feature_disabled",
            recoverStore: "feature_disabled",
          });
          expect(boundary.originalAndGenerationUnchanged).toBe(true);
          expect(boundary.ordinaryReadWritePreserved).toBe(true);
        }
        if (row.direct) {
          expect(row.missingAndForgedTicketDenied).toBe(true);
          expect(row.ticketReplayDenied).toBe(true);
        }
      }
    }
  });
  it("取消保留原件、备份失败不覆盖，确认后可恢复登录入口", async () => {
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockResolvedValue(undefined);
    const file = getE2EAppDataPaths().credentialsFile;
    const original = await readFile(file);
    const backup = `${file}.corrupt-${createHash("sha256").update(original).digest("hex").slice(0, 24)}.bak`;
    await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
    await browser.$("#loading").waitForExist({ reverse: true });
    await clickTestIdByDom("credential-store-recovery-open");
    await clickTestIdByDom("credential-store-recovery-cancel");
    expect(await readFile(file)).toEqual(original);
    await rm(backup, { force: true });
    await mkdir(backup);
    try {
      await clickTestIdByDom("credential-store-recovery-open");
      await clickTestIdByDom("credential-store-recovery-confirm");
      await waitForTestIdByDom("credential-store-recovery-error");
      expect(await readFile(file)).toEqual(original);
    } finally {
      await rm(backup, { recursive: true, force: true });
    }
    await clickTestIdByDom("credential-store-recovery-open");
    await clickTestIdByDom("credential-store-recovery-confirm");
    await waitForTestIdByDom("credential-store-recovery-reload");
    expect(await readFile(backup)).toEqual(original);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    const generation = await readFile(`${file}.recovery-generation`, "utf8");
    expect(generation.length).toBeGreaterThan(0);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "credential-recovered.png"),
    );
    await clickTestIdByDom("credential-store-recovery-reload");
    await waitForTestIdByDom("oauth-login-button", { timeout: 30000 });
    expect(await readFile(`${file}.recovery-generation`, "utf8")).toBe(generation);
    await selectGlobalLoginRegion();
    await clickTestIdByDom("oauth-login-button");
    // 主 JWT 与渠道无关；写入即证明恢复后的空库可以重新完成 OAuth 登录。
    await browser.waitUntil(
      async () => Boolean(JSON.parse(await readFile(file, "utf8"))["zcodejwttoken"]),
      { timeout: 15000, timeoutMsg: "空库恢复后未能重新 OAuth 登录并保存凭据" },
    );
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "credential-recovery.json"),
      JSON.stringify({
        originalBytes: original.length,
        backupMatches: (await readFile(backup)).equals(original),
        recovered: true,
      }),
    );
  });
  it("已有不完整备份时保留旧件，并独立创建完整备份后恢复", async () => {
    const file = getE2EAppDataPaths().credentialsFile;
    const raw = Buffer.from('{"unfinished":"backup-collision"');
    const prefix = `${file}.corrupt-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
    const originalBackup = `${prefix}.bak`;
    // 后台读取也会创建备份；先放置旧备份再暴露损坏原件，避免夹具覆盖正在写入的备份。
    await writeFile(originalBackup, "partial-backup");
    await writeFile(file, raw);
    await browser.refresh();
    await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
    await clickTestIdByDom("credential-store-recovery-open");
    await clickTestIdByDom("credential-store-recovery-confirm");
    await waitForTestIdByDom("credential-store-recovery-reload");
    expect(await readFile(originalBackup, "utf8")).toBe("partial-backup");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    const directory = dirname(file);
    const backupName = basename(prefix);
    const backups = (await readdir(directory)).filter(
      (name) =>
        name.startsWith(`${backupName}.`) && name.endsWith(".bak") && name !== `${backupName}.bak`,
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(join(directory, backups[0]!))).toEqual(raw);
  });
  it("旧确认不得清空已经有效的库，单条坏密文不进入重建入口", async () => {
    const file = getE2EAppDataPaths().credentialsFile;
    await writeFile(file, '{"unfinished":');
    await browser.refresh();
    await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
    await clickTestIdByDom("credential-store-recovery-open");
    const valid = JSON.stringify({ "bot:fixture": "enc:v1:bad.bad.bad" });
    await writeFile(file, valid);
    const generation = await readFile(`${file}.recovery-generation`, "utf8");
    await clickTestIdByDom("credential-store-recovery-confirm");
    await waitForTestIdByDom("credential-store-recovery-reload");
    expect(await readFile(file, "utf8")).toBe(valid);
    expect(await readFile(`${file}.recovery-generation`, "utf8")).toBe(generation);
    await clickTestIdByDom("credential-store-recovery-reload");
    await waitForTestIdByDom("oauth-login-button", { timeout: 30000 });
    expect(await browser.$('[data-testid="credential-store-recovery"]').isExisting()).toBe(false);
  });
  it("两个 Host 的重复确认不能覆盖恢复后保存的凭据", async () => {
    const file = getE2EAppDataPaths().credentialsFile;
    await writeFile(file, '{"unfinished":');
    await browser.refresh();
    await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
    const main = await browser.getWindowHandle();
    const second = await openSubagentHostWindow();
    try {
      await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
      await clickTestIdByDom("credential-store-recovery-open");
      await browser.switchToWindow(main);
      await clickTestIdByDom("credential-store-recovery-open");
      await clickTestIdByDom("credential-store-recovery-confirm");
      await waitForTestIdByDom("credential-store-recovery-reload");
      const saved = '{"bot:new":"new-credential"}';
      await writeFile(file, saved);
      const generation = await readFile(`${file}.recovery-generation`, "utf8");
      await browser.switchToWindow(second.handle);
      await clickTestIdByDom("credential-store-recovery-confirm");
      await waitForTestIdByDom("credential-store-recovery-reload");
      // 系统安全存储会把合成明文迁移为密文；断言旧确认没有清空库，而不比较磁盘格式。
      expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual(["bot:new"]);
      expect(await readE2ECredentialValue("bot:new")).toBe("new-credential");
      expect(await readFile(`${file}.recovery-generation`, "utf8")).toBe(generation);
    } finally {
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.close(),
        second.windowId,
      );
      await browser.switchToWindow(main);
    }
  });
  it("另一 Host 恢复后，旧 OAuth 响应不得重新写入凭据", async () => {
    const file = getE2EAppDataPaths().credentialsFile;
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    await writeFile(file, "{}");
    await browser.refresh();
    await waitForTestIdByDom("oauth-login-button", { timeout: 30000 });
    await selectGlobalLoginRegion();
    await fetch(`${baseUrl}/__e2e/hold-poll`, { method: "POST" });
    await clickTestIdByDom("oauth-login-button");
    await waitForTestIdByDom("oauth-cancel");
    const main = await browser.getWindowHandle();
    await writeFile(file, '{"unfinished":');
    const second = await openSubagentHostWindow();
    try {
      await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
      await clickTestIdByDom("credential-store-recovery-open");
      await clickTestIdByDom("credential-store-recovery-confirm");
      await waitForTestIdByDom("credential-store-recovery-reload");
      await fetch(`${baseUrl}/__e2e/enable-poll`, { method: "POST" });
      await browser.switchToWindow(main);
      await waitForTestIdByDom("oauth-error", { timeout: 15000 });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    } finally {
      await fetch(`${baseUrl}/__e2e/enable-poll`, { method: "POST" });
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.close(),
        second.windowId,
      );
      await browser.switchToWindow(main);
    }
  });
  it("恢复页与确认框兼容双主题、中英文及窄屏", async () => {
    const { credentialsFile, appDataDir } = getE2EAppDataPaths();
    const settingsFile = join(appDataDir, "setting.json");
    const settings = await readFile(settingsFile, "utf8");
    const credentials = await readFile(credentialsFile);
    try {
      await writeFile(credentialsFile, '{"unfinished":');
      for (const theme of ["zai-light", "zai-dark"]) {
        for (const locale of ["en-US", "zh-CN"]) {
          for (const width of [1280, 390]) {
            // 手改文件不会清除浏览器已保存的语言偏好；使用设置页相同的真实切换入口。
            await selectRecoveryLocale(locale);
            await browser.waitUntil(
              async () =>
                JSON.parse(await readFile(settingsFile, "utf8")).localePreference === locale,
            );
            await browser.execute((value) => localStorage.setItem("zcode-theme", value), theme);
            await setRendererViewport(width, 844);
            await browser.refresh();
            await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
            await browser.$("#loading").waitForExist({ reverse: true });
            expect(
              await browser.execute(
                (value) => document.documentElement.classList.contains(`theme-${value}`),
                theme,
              ),
            ).toBe(true);
            await clickTestIdByDom("credential-store-recovery-open");
            await browser.$('[role="alertdialog"]').waitForDisplayed();
            await waitForTestIdByDom("credential-store-recovery-confirm");
            const text = await browser.$('[role="alertdialog"]').getText();
            expect(text).toContain(locale === "zh-CN" ? "重新配置" : "reconfigure");
            expect(
              await browser.execute(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            ).toBe(true);
            await browser.saveScreenshot(
              join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `recovery-${theme}-${locale}-${width}.png`),
            );
            await clickTestIdByDom("credential-store-recovery-cancel");
            expect(await readFile(credentialsFile)).toEqual(Buffer.from('{"unfinished":'));
          }
        }
      }
    } finally {
      await writeFile(settingsFile, settings);
      await writeFile(credentialsFile, credentials);
      await clearRendererViewport();
    }
  });
  it("非法 UTF-8、非字符串记录可恢复；文件缺失与 IO 错误不得提供重建入口", async () => {
    const file = getE2EAppDataPaths().credentialsFile;
    const original = await readFile(file);
    try {
      for (const content of [Buffer.from([0xff, 0xfe]), Buffer.from('{"key":42}')]) {
        await writeFile(file, content);
        await browser.refresh();
        await waitForTestIdByDom("credential-store-recovery", { timeout: 30000 });
        await clickTestIdByDom("credential-store-recovery-open");
        await clickTestIdByDom("credential-store-recovery-cancel");
        expect(await readFile(file)).toEqual(content);
      }
      await rm(file);
      await browser.refresh();
      await waitForTestIdByDom("oauth-login-button", { timeout: 30000 });
      expect(await browser.$('[data-testid="credential-store-recovery"]').isExisting()).toBe(false);
      await mkdir(file);
      const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR!);
      const logs = join(logDir, new Date().toISOString().slice(0, 10) + ".log");
      const before = (await readFile(logs, "utf8").catch(() => "")).length;
      await browser.refresh();
      await browser.waitUntil(
        async () =>
          (await readFile(logs, "utf8")).slice(before).includes("credential.inspectStore FAIL"),
        { timeout: 10000, timeoutMsg: "IO 失败未经过真实 Host 读取边界" },
      );
      expect(await browser.$('[data-testid="credential-store-recovery-open"]').isExisting()).toBe(
        false,
      );
      if (process.platform !== "win32") {
        await rm(file, { recursive: true });
        await writeFile(file, original);
        await chmod(file, 0o000);
        const beforePermissionFailure = (await readFile(logs, "utf8")).length;
        await browser.refresh();
        await browser.waitUntil(
          async () =>
            (await readFile(logs, "utf8"))
              .slice(beforePermissionFailure)
              .includes("credential.inspectStore FAIL"),
          { timeout: 10000, timeoutMsg: "权限失败未经过真实 Host 读取边界" },
        );
        expect(await browser.$('[data-testid="credential-store-recovery-open"]').isExisting()).toBe(
          false,
        );
      }
    } finally {
      await chmod(file, 0o600).catch(() => undefined);
      await rm(file, { recursive: true, force: true });
      await writeFile(file, original);
    }
  });
});
