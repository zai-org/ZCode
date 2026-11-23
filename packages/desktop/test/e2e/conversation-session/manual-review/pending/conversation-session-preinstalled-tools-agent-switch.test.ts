import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreinstalledToolsState } from "@zcode/shared/preinstalled-tools";
import {
  lockPreinstalledDirectory,
  preinstalledFixtureRecordPath,
  unlockPreinstalledDirectory,
  preinstalledEntryPath,
} from "#e2e/helpers/preinstalled-tools-fixture";
import { resolveE2ERuntimePath, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const card = (toolId: string) =>
  `[data-testid="preinstalled-tools-card"][data-tool-id="${toolId}"]`;
const toggle = (toolId: string) =>
  $(`${card(toolId)} [data-testid="preinstalled-tools-agent-enabled"]`);
const snapshot = () =>
  browser.execute(async () =>
    (
      window as typeof window & {
        zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
      }
    ).zcode.getPreinstalledToolsState(),
  );
const requests = async () =>
  (await (await fetch(`${fixtureUrl()}/status`)).json()).requests as number;
const syncRetry = (toolId: string) =>
  $(`${card(toolId)} [data-testid="preinstalled-tools-sync-entries"]`);
async function waitEntrySync(toolId: string, outOfSync: boolean) {
  await browser.waitUntil(
    async () =>
      (await snapshot()).tools.find((tool) => tool.toolId === toolId)?.entryOutOfSync ===
        outOfSync && (await toggle(toolId).isEnabled()),
    { timeout: 10000 },
  );
  expect(
    await $(`${card(toolId)} [data-testid="preinstalled-tools-entry-out-of-sync"]`).isExisting(),
  ).toBe(outOfSync);
}
async function deleteTool(toolId: string) {
  await $(`${card(toolId)} [data-testid="preinstalled-tools-delete"]`).click();
  await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
}
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function setEnabled(toolId: string, enabled: boolean, keyboard = false) {
  const control = toggle(toolId);
  await control.scrollIntoView();
  if ((await control.getAttribute("aria-checked")) !== String(enabled)) {
    if (keyboard) {
      await control.execute((element) => element.focus());
      await browser.keys("Space");
    } else await control.click();
  }
  await browser.waitUntil(
    async () =>
      (await control.getAttribute("aria-checked")) === String(enabled) &&
      (await control.isEnabled()),
    { timeout: 10000 },
  );
}
async function waitStatus(toolId: string, status: string) {
  await browser.waitUntil(
    async () =>
      (await $(`${card(toolId)} [data-testid="preinstalled-tools-status"]`).getAttribute(
        "data-status",
      )) === status,
    { timeout: 60000 },
  );
}

describe("每工具 Agent 使用开关（待审核）", () => {
  it("PT-14/23 LO-06: 原会话切换、隔离、失败与持久化", async function () {
    this.timeout(360000);
    const directory = resolveE2ERuntimePath("conversation-session-preinstalled-tools-agent-switch");
    const system = join(directory, "system-bin");
    await mkdir(system, { recursive: true });
    await cp(
      new URL(
        "../../../fixtures/fs/conversation-session/conversation-session-preinstalled-tools-agent-switch/probe.mjs",
        import.meta.url,
      ),
      join(directory, "probe.mjs"),
    );
    await writeFile(join(system, "qpdf"), "#!/bin/sh\nprintf 'system-qpdf\\n'\n", { mode: 0o755 });
    await writeFile(join(system, "soffice"), "#!/bin/sh\nprintf 'LibreOffice 26.2.0\\n'\n", {
      mode: 0o755,
    });
    if (process.platform === "win32") {
      // Git Bash 按无扩展名脚本查找，cmd 按 .cmd 查找；两种调用都要落到假系统程序。
      await writeFile(join(system, "qpdf.cmd"), "@echo system-qpdf\r\n");
      await writeFile(join(system, "soffice.cmd"), "@echo LibreOffice 26.2.0\r\n");
    }
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        storageRoot: resolveE2EStorageRoot(),
        python: process.env.ZCODE_E2E_DOCUMENT_PYTHON || "python3",
      }),
    );
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await openDialog();
    await waitStatus("qpdf", "preparing");
    await setEnabled("qpdf", false, true);
    await waitStatus("qpdf", "preparing");
    for (const toolId of ["qpdf", "libreoffice"]) {
      await fetch(`${fixtureUrl()}/${toolId}/finish-check`);
      await fetch(`${fixtureUrl()}/${toolId}/release`);
      await waitStatus(toolId, "ready");
    }
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    const bin = join(root, "bin");
    const qpdfRecord = await preinstalledFixtureRecordPath(root, "qpdf");
    const officeRecord = await preinstalledFixtureRecordPath(root);
    await expect(stat(preinstalledEntryPath(bin, "qpdf"))).rejects.toHaveProperty("code", "ENOENT");
    expect(JSON.parse(await readFile(qpdfRecord, "utf8")).toolId).toBe("qpdf");
    await $('[data-testid="preinstalled-tools-auto-install"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute(
          "aria-checked",
        )) === "false",
      { timeout: 10000 },
    );
    const observations = [];
    let sessionId: string | null = null;
    for (const [stage, qpdfManaged, officeManaged] of [
      ["BEFORE", false, true],
      ["ON", true, true],
      ["OFF", true, false],
      ["RESTORED", true, true],
    ] as const) {
      if (stage === "ON") await setEnabled("qpdf", true);
      if (stage === "OFF") await setEnabled("libreoffice", false);
      if (stage === "RESTORED") await setEnabled("libreoffice", true);
      await browser.keys("Escape");
      const marker = `E2E_PT_AGENT_${stage}`;
      await sendV4Prompt(`${marker}: Run the exact read-only preinstalled-tools selection probe.`);
      await waitForV4AssistantMessageContaining(`${marker}_DONE`, 90000);
      await waitForV4ConversationState((state) => state.state === "idle", "入口探测未结束");
      const result = await getLatestUpstreamToolResultByToolCallId(
        `toolu_pt_agent_${stage.toLowerCase()}`,
      );
      expect(result?.isError).toBe(false);
      const observed = JSON.parse(result!.content);
      expect(observed.pathFirst).toBe(bin);
      // 预装入口在 Windows 上是 qpdf.exe；假系统程序仍是无扩展名的 sh 脚本，由 Git Bash 运行。
      expect(observed.qpdfPath).toBe(
        qpdfManaged ? preinstalledEntryPath(bin, "qpdf") : join(system, "qpdf"),
      );
      expect(observed.qpdf).toContain(qpdfManaged ? "qpdf fixture" : "system-qpdf");
      expect(observed.office.source).toBe(officeManaged ? "managed" : "system");
      if (!officeManaged) expect(observed.officeNotice).toContain("未就绪或已关闭");
      const current = (await getV4PaneSnapshot()).sessionId;
      if (sessionId) expect(current).toBe(sessionId);
      sessionId = current;
      observations.push({ stage, ...observed });
      await openDialog();
    }
    // 从可读但不可写的设置目录制造真实保存失败，不注入 UI/store 状态。
    const settingsDirectory = join(resolveE2EStorageRoot(), "v2");
    try {
      await lockPreinstalledDirectory(settingsDirectory);
      await toggle("qpdf").click();
      await $(
        `${card("qpdf")} [data-testid="preinstalled-tools-command-error"]`,
      ).waitForDisplayed();
      expect(await toggle("qpdf").getAttribute("aria-checked")).toBe("true");
      expect(await stat(preinstalledEntryPath(bin, "qpdf"))).toBeDefined();
      expect(await $$("[data-sonner-toast]").length).toBe(0);
    } finally {
      await unlockPreinstalledDirectory(settingsDirectory);
    }
    // 设置已保存但 bin 删除失败：观察公开快照和真实文件，不再把旧开关当作事实。
    const settingsPath = join(settingsDirectory, "setting.json");
    const requestsBeforeRetry = await requests();
    let failedSnapshot: PreinstalledToolsState;
    let savedAfterFailure: string;
    try {
      await lockPreinstalledDirectory(bin);
      await setEnabled("qpdf", false);
      await waitEntrySync("qpdf", true);
      failedSnapshot = await snapshot();
      expect(failedSnapshot.tools.find((tool) => tool.toolId === "qpdf")).toMatchObject({
        agentEnabled: false,
        entryOutOfSync: true,
        status: "ready",
      });
      expect(failedSnapshot.tools.find((tool) => tool.toolId === "qpdf")?.error ?? null).toBeNull();
      savedAfterFailure = await readFile(settingsPath, "utf8");
      expect(JSON.parse(savedAfterFailure).preinstalledToolsAgentDisabled).toEqual(["qpdf"]);
      expect(await stat(preinstalledEntryPath(bin, "qpdf"))).toBeDefined();
      expect(
        await $(`${card("qpdf")} [data-testid="preinstalled-tools-delete"]`).isExisting(),
      ).toBe(true);
      const workerPid = await browser.electron.execute(
        (electron) =>
          electron.app.getAppMetrics().find((item) => item.name === "zcode-preinstalled-tools")!
            .pid,
      );
      process.kill(workerPid, "SIGKILL");
      await browser.waitUntil(
        async () => {
          const pid = await browser.electron.execute(
            (electron) =>
              electron.app.getAppMetrics().find((item) => item.name === "zcode-preinstalled-tools")
                ?.pid,
          );
          return Boolean(pid && pid !== workerPid);
        },
        { timeout: 30000 },
      );
      for (const toolId of ["qpdf", "libreoffice"]) {
        await waitStatus(toolId, "ready");
        await waitEntrySync(toolId, true);
        expect(
          (await snapshot()).tools.find((tool) => tool.toolId === toolId)?.error ?? null,
        ).toBeNull();
      }
      expect((await snapshot()).tools.find((tool) => tool.toolId === "qpdf")?.agentEnabled).toBe(
        false,
      );
      await browser.keys("Escape");
      await openDialog();
      await waitEntrySync("qpdf", true);
      await syncRetry("qpdf").click();
      await waitEntrySync("qpdf", true);
      expect(await readFile(settingsPath, "utf8")).toBe(savedAfterFailure);
      expect(await requests()).toBe(requestsBeforeRetry);
    } finally {
      await unlockPreinstalledDirectory(bin);
    }
    await syncRetry("qpdf").click();
    await waitEntrySync("qpdf", false);
    await syncRetry("libreoffice").click();
    await waitEntrySync("libreoffice", false);
    await expect(stat(preinstalledEntryPath(bin, "qpdf"))).rejects.toHaveProperty("code", "ENOENT");
    expect(await readFile(settingsPath, "utf8")).toBe(savedAfterFailure!);
    expect(await requests()).toBe(requestsBeforeRetry);

    // 删除第一步无法撤入口时必须停止，不能删除仍被入口引用的有效资源。
    await setEnabled("qpdf", true);
    const beforeDelete = await readFile(qpdfRecord, "utf8");
    const installationDir = JSON.parse(beforeDelete).installationDir;
    try {
      await lockPreinstalledDirectory(bin);
      await deleteTool("qpdf");
      await waitEntrySync("qpdf", true);
      expect(await readFile(qpdfRecord, "utf8")).toBe(beforeDelete);
      expect(await stat(installationDir)).toBeDefined();
      expect((await snapshot()).tools.find((tool) => tool.toolId === "qpdf")).toMatchObject({
        status: "ready",
        agentEnabled: true,
        entryOutOfSync: true,
      });
      for (const locale of ["zh-CN", "en-US"] as const)
        for (const theme of ["zai-light", "zai-dark"] as const) {
          await setPluginPresentation({ locale, theme, width: 760, height: 640 });
          await syncRetry("qpdf").scrollIntoView();
          const layout = await browser.execute(() => {
            const dialog = document.querySelector<HTMLElement>(
              '[data-testid="preinstalled-tools-dialog"]',
            )!;
            const rect = dialog.getBoundingClientRect();
            return {
              overflow: dialog.scrollWidth > dialog.clientWidth + 1,
              left: rect.left,
              right: rect.right,
              bottom: rect.bottom,
              width: innerWidth,
              height: innerHeight,
            };
          });
          expect(layout.overflow).toBe(false);
          expect(layout.left).toBeGreaterThanOrEqual(0);
          expect(layout.right).toBeLessThanOrEqual(layout.width + 1);
          expect(layout.bottom).toBeLessThanOrEqual(layout.height + 1);
          await browser.saveScreenshot(
            `${process.env.ZCODE_E2E_ARTIFACT_DIR}/agent-switch-unsynced-${locale}-${theme}.png`,
          );
        }
      await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1000, height: 760 });
    } finally {
      await unlockPreinstalledDirectory(bin);
    }
    await syncRetry("qpdf").click();
    await waitEntrySync("qpdf", false);
    expect(await requests()).toBe(requestsBeforeRetry);

    // 发布点之后写入口失败：资源仍就绪，重试只补入口，不能重复下载或回滚记录。
    await deleteTool("qpdf");
    await waitStatus("qpdf", "not-installed");
    const enabledSettings = await readFile(settingsPath, "utf8");
    try {
      await lockPreinstalledDirectory(bin);
      await $(`${card("qpdf")} [data-testid="preinstalled-tools-download"]`).click();
      await waitStatus("qpdf", "ready");
      await waitEntrySync("qpdf", true);
      expect(await stat(qpdfRecord)).toBeDefined();
      expect(await stat(installationDir)).toBeDefined();
      expect(
        (await snapshot()).tools.find((tool) => tool.toolId === "qpdf")?.error ?? null,
      ).toBeNull();
    } finally {
      await unlockPreinstalledDirectory(bin);
    }
    const requestsAfterPublication = await requests();
    expect(requestsAfterPublication).toBe(requestsBeforeRetry + 1);
    const publishedRecord = await readFile(qpdfRecord, "utf8");
    await syncRetry("qpdf").click();
    await waitEntrySync("qpdf", false);
    expect(await stat(preinstalledEntryPath(bin, "qpdf"))).toBeDefined();
    expect(await readFile(qpdfRecord, "utf8")).toBe(publishedRecord);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).preinstalledToolsAgentDisabled).toEqual(
      JSON.parse(enabledSettings).preinstalledToolsAgentDisabled,
    );
    expect(await requests()).toBe(requestsAfterPublication);

    // 重现旧缺陷的完整序列：关闭失败后删除、再次发布，入口不能按旧缓存复活。
    try {
      await lockPreinstalledDirectory(bin);
      await setEnabled("qpdf", false);
      await waitEntrySync("qpdf", true);
    } finally {
      await unlockPreinstalledDirectory(bin);
    }
    await deleteTool("qpdf");
    await waitStatus("qpdf", "not-installed");
    await $(`${card("qpdf")} [data-testid="preinstalled-tools-download"]`).click();
    await waitStatus("qpdf", "ready");
    await waitEntrySync("qpdf", false);
    expect(await toggle("qpdf").getAttribute("aria-checked")).toBe("false");
    await expect(stat(preinstalledEntryPath(bin, "qpdf"))).rejects.toHaveProperty("code", "ENOENT");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).preinstalledToolsAgentDisabled).toEqual(
      ["qpdf"],
    );
    expect(await requests()).toBe(requestsAfterPublication + 1);
    await setEnabled("libreoffice", false);
    await browser.keys("Escape");
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E();
    await openDialog();
    for (const toolId of ["qpdf", "libreoffice"]) {
      await waitStatus(toolId, "ready");
      expect(await toggle(toolId).getAttribute("aria-checked")).toBe("false");
    }
    await expect(stat(preinstalledEntryPath(bin, "qpdf"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(preinstalledEntryPath(bin, "zcode-soffice"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await $(`${card("libreoffice")} [data-testid="preinstalled-tools-delete"]`).click();
    await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
    await waitStatus("libreoffice", "not-installed");
    expect(await toggle("libreoffice").getAttribute("aria-checked")).toBe("false");
    await expect(stat(officeRecord)).rejects.toHaveProperty("code", "ENOENT");
    expect(await stat(qpdfRecord)).toBeDefined();
    const settings = JSON.parse(await readFile(join(settingsDirectory, "setting.json"), "utf8"));
    expect(settings.preinstalledToolsAgentDisabled.sort()).toEqual(["libreoffice", "qpdf"]);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "agent-switch-evidence.json"),
      JSON.stringify(
        {
          observations,
          failedSnapshot: failedSnapshot!,
          entryRetryPreservedSettingsAndRequests: true,
          failedDeletePreservedRecordAndDirectory: true,
          failedPublicationPreservedRecordAndDirectory: true,
          disabledPublicationKeptEntriesAbsent: true,
          persistedDisabled: settings.preinstalledToolsAgentDisabled,
          deletionKeepsPreference: true,
        },
        null,
        2,
      ),
    );
  });
});
