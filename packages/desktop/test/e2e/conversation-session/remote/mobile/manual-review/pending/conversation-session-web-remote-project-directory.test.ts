import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ServiceChannels, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ProjectTree, RemoteProjectDirectory, VirtualProject } from "@zcode/services";
import { clearAppData, DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";

const CASE = "E2E_MRO02";
const CASE_NAME = "conversation-session-web-remote-project-directory";
const sessionStoreUrl = `/@fs${resolve(import.meta.dirname, "../../../../../../../../ui/src/store/remoteWorkspaceSessionStore.ts").replaceAll("\\", "/")}`;

interface DirectoryTestWindow extends Window {
  __mro02RestoreClipboard?: () => void;
  __zcodeTabStoreE2E?: {
    getState(): { activeWorkspacePath: string | null; activeWorkspaceIdentity?: string | null };
  };
}

function projectSelector(project: VirtualProject): string {
  return `[data-project-id=${JSON.stringify(project.id)}]`;
}

async function openProjectDraft(page: Page, project: VirtualProject): Promise<void> {
  const row = page.locator(projectSelector(project)).first();
  await row.waitFor();
  await row.hover();
  await row.getByTestId("virtual-project-create-task").click();
}

async function showDirectory(page: Page): Promise<void> {
  const back = page.getByRole("button", { name: /^(返回任务首页|Back to task home)$/u });
  const sidebar = page.getByTestId("sidebar");
  const onboarding = page.getByTestId("onboarding-page");
  // 新 Source 有独立引导记录；先通过真实 UI 完成前置，不能把引导遮挡误判成目录丢失。
  await sidebar.or(back).or(onboarding).filter({ visible: true }).first().waitFor();
  if (await onboarding.isVisible()) {
    // 复用通用 E2E 的 dismiss 语义；“跳过”只进入下一步，不代表整段引导结束。
    await page.keyboard.press("Escape");
    await onboarding.waitFor({ state: "hidden" });
    await sidebar.or(back).filter({ visible: true }).first().waitFor();
  }
  if (await back.isVisible()) await back.click();
  await sidebar.waitFor();
}

async function waitForWorkspace(page: Page, path: string, identity?: string): Promise<void> {
  await page.waitForFunction(
    ({ path, identity }) => {
      const state = (window as DirectoryTestWindow).__zcodeTabStoreE2E?.getState();
      return (
        state?.activeWorkspacePath === path &&
        (state.activeWorkspaceIdentity ?? null) === (identity ?? null)
      );
    },
    { path, identity },
    { timeout: 60_000 },
  );
}

/** 配对材料只经过内存中的 loopback 接收器，不进入 WebDriver 返回值或日志。 */
async function obtainPairingUrl(): Promise<string> {
  let receive!: (url: string) => void;
  const pairing = new Promise<string>((resolveUrl) => {
    receive = resolveUrl;
  });
  const receiver = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    let url = "";
    for await (const chunk of request) url += String(chunk);
    receive(url);
    response.end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error(`${CASE}: pair receiver unavailable`);
  try {
    await browser.execute((port) => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      (window as DirectoryTestWindow).__mro02RestoreClipboard = () => {
        navigator.clipboard.writeText = original;
      };
      navigator.clipboard.writeText = async (url) => {
        await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: url });
      };
    }, address.port);
    await $(
      'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
    ).click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const copy = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-testid="web-remote-control-dialog-scroll"] button',
            ),
          ).find(
            (button) => /^(复制链接|Copy link)$/u.test(button.innerText.trim()) && !button.disabled,
          );
          copy?.click();
          return Boolean(copy);
        }),
      { timeout: 60_000, timeoutMsg: `${CASE}: pairing link unavailable` },
    );
    const url = await pairing;
    if (new URL(url).origin !== "http://127.0.0.1:5173")
      throw new Error(`${CASE}: requires current local Web frontend`);
    await browser.keys("Escape");
    return url;
  } finally {
    await browser.execute(() => {
      (window as DirectoryTestWindow).__mro02RestoreClipboard?.();
      delete (window as DirectoryTestWindow).__mro02RestoreClipboard;
    });
    await new Promise<void>((done, reject) =>
      receiver.close((error) => (error ? reject(error) : done())),
    );
  }
}

describe(`${CASE}: 真实 SSH bridge 保留窗口项目目录`, () => {
  let webBrowser: Browser | undefined;
  let page: Page | undefined;
  const evidence: Record<string, unknown> = {};
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;

  after(async () => {
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "MRO02-directory.json"), JSON.stringify(evidence, null, 2));
      await page
        ?.screenshot({ path: join(artifactDir, "MRO02-last-page.png") })
        .catch(() => undefined);
    }
    await webBrowser?.close();
    await restoreHandoffProbes();
    await clearAppData();
  });

  it("MRO02：宽窄屏切入远端、更新和刷新后保留本机/置顶/已添加项目，隐藏未添加项目，并能返回本机", async function () {
    this.timeout(15 * 60_000);
    if (!artifactDir || !process.env.ZCODE_E2E_HOME_DIR)
      throw new Error(`${CASE}: isolated HOME and artifact directory required`);
    await prepareSSHConnectionPage(CASE);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await installHandoffRpcProbe();
    const localPath = resolveE2ERuntimePath(CASE_NAME, "local");
    const pinnedPath = resolveE2ERuntimePath(CASE_NAME, "pinned");
    await Promise.all([
      mkdir(localPath, { recursive: true }),
      mkdir(pinnedPath, { recursive: true }),
    ]);
    const local = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      {
        name: `${CASE}_LOCAL`,
        roots: [localPath],
        primaryRoot: localPath,
      },
    ]);
    const pinned = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      {
        name: `${CASE}_PINNED`,
        roots: [pinnedPath],
        primaryRoot: pinnedPath,
        pinned: true,
      },
    ]);

    const config = readSSHRuntimeConfig(CASE);
    const tab = await connectSSHWorkspace({
      caseMarker: CASE,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const identity = tab.workspaceIdentity;
    const parsed = identity ? parseRemoteWorkspaceIdentity(identity) : null;
    if (!identity || parsed?.kind !== "server")
      throw new Error(`${CASE}: missing stable Source identity`);
    const hostId = `remote:server:${parsed.sourceServerId}`;
    const sourceTree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const retained = sourceTree.projects.find((project) =>
      project.roots.some((root) => root.rootPath === config.workspacePaths[0]),
    );
    if (!retained) throw new Error(`${CASE}: SSH project was not persisted`);
    const remote = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      {
        id: retained.id,
        hostId,
        name: `${CASE}_REMOTE`,
      },
    ]);
    // 仅在真实远端 owner 建项目，不执行 addEntry；该项目必须永不出现在窗口目录。
    const hidden = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      {
        hostId,
        name: `${CASE}_NOT_ADDED`,
        roots: [config.workspacePaths[1]],
        primaryRoot: config.workspacePaths[1],
      },
    ]);
    const directory = await callHandoffHost<RemoteProjectDirectory>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    expect(directory.entries.some((entry) => entry.projectId === remote.id)).toBe(true);
    expect(directory.entries.some((entry) => entry.projectId === hidden.id)).toBe(false);
    const localRow = $(projectSelector(local));
    await localRow.moveTo();
    await localRow.$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(localPath, 45_000);
    const pairingUrl = await obtainPairingUrl();
    webBrowser = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME
        ? {
            executablePath:
              process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME,
          }
        : { channel: "chrome" }),
      headless: true,
    });

    for (const [label, viewport] of [
      ["wide", { width: 1440, height: 1000 }],
      ["narrow", { width: 390, height: 844 }],
    ] as const) {
      const context = await webBrowser.newContext({
        viewport,
        isMobile: label === "narrow",
        hasTouch: label === "narrow",
        locale: "zh-CN",
      });
      await context.addInitScript((credentials) => {
        if (sessionStorage.getItem("mro02-credentials-seeded")) return;
        sessionStorage.setItem("mro02-credentials-seeded", "1");
        for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
      }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
      page = await context.newPage();
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: CASE,
        phase: label,
        readySelector: projectSelector(local),
      });
      const assertDirectory = async (phase: string) => {
        await showDirectory(page!);
        await page!.locator(projectSelector(local)).first().waitFor({ timeout: 30_000 });
        await page!.locator(projectSelector(pinned)).first().waitFor();
        await page!.locator(projectSelector(remote)).first().waitFor();
        expect(await page!.locator(projectSelector(hidden)).count()).toBe(0);
        expect(
          await page!.locator(projectSelector(pinned)).locator("svg.lucide-pin").count(),
        ).toBeGreaterThan(0);
        evidence[`${label}-${phase}`] = await page!
          .locator("[data-project-id]")
          .evaluateAll((rows) =>
            rows.map((row) => ({
              id: row.getAttribute("data-project-id"),
              name: row.getAttribute("data-project-name"),
            })),
          );
        await page!.screenshot({ path: join(artifactDir, `MRO02-${label}-${phase}.png`) });
      };
      await assertDirectory("local");
      await openProjectDraft(page, remote);
      await waitForWorkspace(page, config.workspacePaths[0], identity);
      // 只读实际注册的 Source services；不得把工作区 project 通道替换为窗口目录通道。
      const sourceProjectIds = await page.evaluate(
        async ({ moduleUrl, identity }) => {
          const store = (await import(moduleUrl)) as {
            getRemoteWorkspaceServicesForIdentity(
              identity: string,
            ): { projectService?: { readProjects(): Promise<Array<{ id: string }>> } } | null;
          };
          const services = store.getRemoteWorkspaceServicesForIdentity(identity);
          if (!services?.projectService) throw new Error("remote scoped project service missing");
          return (await services.projectService.readProjects()).map((project) => project.id);
        },
        { moduleUrl: sessionStoreUrl, identity },
      );
      expect(sourceProjectIds).toContain(hidden.id);
      expect(sourceProjectIds).toContain(remote.id);
      expect(sourceProjectIds).not.toContain(local.id);
      evidence[`${label}-source-projects`] = sourceProjectIds;
      await assertDirectory("remote");
      const nextName = `${CASE}_LOCAL_${label}`;
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        { id: local.id, name: nextName },
      ]);
      await page.locator(`[data-project-name=${JSON.stringify(nextName)}]`).waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspace(page, config.workspacePaths[0], identity);
      await assertDirectory("reload");
      await openProjectDraft(page, local);
      await waitForWorkspace(page, localPath);
      await assertDirectory("back-local");
      await context.close();
      page = undefined;
    }
  });
});
