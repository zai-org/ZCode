import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  PreinstalledToolResource,
  PreinstalledToolsState,
} from "@zcode/shared/preinstalled-tools";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
} from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { resolveE2ERuntimePath, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { preinstalledEntryPath } from "#e2e/helpers/preinstalled-tools-fixture";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-preinstalled-tools-real-loopback";
const tools = ["python", "qpdf", "pandoc", "poppler", "libreoffice"];
const card = (id: string) => `[data-tool-id="${id}"]`;
const fixture = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const state = () =>
  browser.execute(async () =>
    (
      window as typeof window & {
        zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
      }
    ).zcode.getPreinstalledToolsState(),
  );
const http = async () =>
  (await fetch(`${fixture()}/status`)).json() as Promise<{
    requests: number;
    completed: number;
    maxActive: number;
    events: Array<{ event: string; toolId: string; resourceId: string }>;
    tools: Record<string, { requests: number }>;
  }>;
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function waitStatus(id: string, expected: string) {
  let failure: string | undefined;
  await browser.waitUntil(
    async () => {
      // 轮询只传回该工具的简短状态，避免五工具完整快照反复写日志影响真实资源验收。
      const current = await browser.execute(async (toolId: string) => {
        const snapshot = await (
          window as typeof window & {
            zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
          }
        ).zcode.getPreinstalledToolsState();
        const tool = snapshot.tools.find((item) => item.toolId === toolId)!;
        return { status: tool.status, phase: tool.phase, errorKind: tool.error };
      }, id);
      if (current.status === "failed") {
        failure = JSON.stringify(current);
        return true;
      }
      return current.status === expected;
    },
    // 单个工具从下载到 ready 的上限。Windows Defender 会逐个扫描解包写出的文件，真实 Python 资源
    // 在 Windows 上解包约 2.4～2.7 分钟，原 180 秒没有余量，曾因此超时；放宽到 300 秒。
    { timeout: 300000, interval: 500, timeoutMsg: `${id} 未到达 ${expected}` },
  );
  // waitUntil 会吞下条件异常继续轮询；失败状态必须在条件之外立即报告。
  if (failure) throw new Error(`${id} preparation failed: ${failure}`);
}
async function absent(path: string) {
  await expect(stat(path)).rejects.toHaveProperty("code", "ENOENT");
}
/**
 * Windows 上 Agent 的 Bash 是 Git Bash；裸 bash 可能是 WSL，按 git.exe 位置定位同一安装。
 * 修复原因：探针要观察 Agent 会话实际的命令解析顺序。Git 的 bin\bash.exe 是包装器，会把
 * /ucrt64/bin、/usr/bin 重新放到 PATH 最前，Git 自带的 pdftotext 因此抢先于预装入口；
 * 用 usr\bin\bash.exe 不改写 PATH，沿用 Agent 会话里已把 <bin> 放在最前的顺序。
 */
async function resolveAgentBash(): Promise<string> {
  if (process.platform !== "win32") return "/bin/bash";
  const { stdout } = await promisify(execFile)("where.exe", ["git"], { windowsHide: true });
  const git = stdout.split(/\r?\n/).find((line) => line.toLowerCase().endsWith("\\cmd\\git.exe"));
  if (!git) throw new Error("没有找到 Git for Windows");
  const candidate = join(dirname(dirname(git)), "usr", "bin", "bash.exe");
  await stat(candidate);
  return candidate;
}

describe("五个真实预装工具 loopback（待审核）", () => {
  after(async () => {
    try {
      await cp(
        resolveE2ERuntimePath(CASE),
        `${process.env.ZCODE_E2E_ARTIFACT_DIR}/real-document-results`,
        { recursive: true },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  it("PT-01/13/14/17/18：原会话、四插件、开关、升级、删除与文档结果", async function () {
    // 与 WDIO 外层预算一致：Windows 实测 14 分 11 秒，原 15 分钟余量不足 1 分钟。
    this.timeout(1500000);
    // 平台与 resourceId 以真实 .artifact.json 为准，不按开发机写死。
    const artifactPaths = JSON.parse(
      await readFile(process.env.ZCODE_E2E_PREINSTALL_ARTIFACTS!, "utf8"),
    ) as string[];
    const readResource = async (path: string) =>
      (JSON.parse(await readFile(path, "utf8")) as { resource: PreinstalledToolResource }).resource;
    const resources = await Promise.all(artifactPaths.map(readResource));
    const upgradeResource = await readResource(process.env.ZCODE_E2E_PREINSTALL_UPGRADE_ARTIFACT!);
    for (const resource of [...resources, upgradeResource])
      if (
        !resource.platforms.some(
          (item) => item.platform === process.platform && item.arch === process.arch,
        )
      )
        throw new Error(`${resource.resourceId} 不适用于 ${process.platform}-${process.arch}`);
    const qpdfResourceIds = {
      before: resources.find((resource) => resource.toolId === "qpdf")!.resourceId,
      after: upgradeResource.resourceId,
    };
    const python = process.env.ZCODE_E2E_DOCUMENT_PYTHON;
    const samples = process.env.ZCODE_E2E_DOCUMENT_SAMPLES;
    const systemApplication = process.env.ZCODE_E2E_LIBREOFFICE_SYSTEM_APP;
    const defaultProfile = process.env.ZCODE_E2E_LIBREOFFICE_DEFAULT_PROFILE;
    if (!python || !samples || !systemApplication || !defaultProfile)
      throw new Error("必须提供准备用 Python、真实样例、系统 LibreOffice 和默认配置路径");
    const sourcePackageVersion = JSON.parse(
      await readFile(new URL("../../../../../../../package.json", import.meta.url), "utf8"),
    ).version as string;
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    const directory = resolveE2ERuntimePath(CASE);
    const root = join(resolveE2EStorageRoot(), "preinstalled-tools", "development");
    await mkdir(directory, { recursive: true });
    await cp(
      new URL(`../../../fixtures/fs/conversation-session/${CASE}/`, import.meta.url),
      directory,
      { recursive: true },
    );
    await mkdir(join(directory, "中文 空格"), { recursive: true });
    for (const name of ["中文 字体验收.docx", "中文 字体验收.pptx", "legacy/中文 字体验收.doc"]) {
      await mkdir(join(directory, "中文 空格", name, ".."), { recursive: true });
      await cp(join(samples, name), join(directory, "中文 空格", name));
    }
    const helper = new URL(
      "../../../../../../../apps/zcode-cli/packages/documents-plugin/scripts/zcode_libreoffice.py",
      import.meta.url,
    );
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        python,
        systemApplication,
        defaultProfile,
        storageRoot: resolveE2EStorageRoot(),
        root,
        bash: await resolveAgentBash(),
        qpdfResourceIds,
        helperSha256: createHash("sha256")
          .update(await readFile(helper))
          .digest("hex"),
      }),
    );
    let sessionId: string | null = null;
    const observations: Record<string, unknown> = {};
    const observe = async (phase: string, timeout = 240000) => {
      const marker = `E2E_PT_REAL_${phase.toUpperCase().replaceAll("-", "_")}`;
      await sendV4Prompt(`${marker}: Run the exact real preinstalled tools acceptance phase.`);
      await waitForV4AssistantMessageContaining(`${marker}_DONE`, timeout);
      await waitForV4ConversationState((value) => value.state === "idle", `${phase} 未结束`);
      const result = await getLatestUpstreamToolResultByToolCallId(
        `toolu_pt_real_${phase.replaceAll("-", "_")}`,
      );
      expect(result?.isError).toBe(false);
      const current = (await getV4PaneSnapshot()).sessionId;
      expect(current).not.toBeNull();
      if (sessionId) expect(current).toBe(sessionId);
      sessionId = current;
      const receipt = JSON.parse(await readFile(join(directory, `${phase}.json`), "utf8"));
      observations[phase] = receipt;
      return receipt;
    };
    await waitStatus("python", "preparing");
    expect((await state()).tools.find((tool) => tool.toolId === "python")?.phase).toBe(
      "downloading",
    );
    const before = await observe("before");
    expect(before.systemCheck.source).toBe("system");
    expect(before.snapshots.length).toBeGreaterThan(0);
    const requestsBefore = await countUpstreamRequests({
      includes: ["E2E_PT_REAL"],
      excludes: ["Generate a concise title"],
    });
    await fetch(`${fixture()}/release`);
    for (const tool of tools) await waitStatus(tool, "ready");
    expect(
      await countUpstreamRequests({
        includes: ["E2E_PT_REAL"],
        excludes: ["Generate a concise title"],
      }),
    ).toBe(requestsBefore);
    const downloads = await http();
    expect(
      downloads.events.filter((event) => event.event === "requested").map((event) => event.toolId),
    ).toEqual(tools);
    expect(downloads.maxActive).toBe(1);
    expect(downloads.completed).toBe(5);
    await openDialog();
    // 与 tracer 相同的原因：Windows 上并发读取元素属性会遇到 chromedriver 拒绝新连接，改为一次 execute。
    expect(
      await browser.execute(() =>
        Array.from(document.querySelectorAll("[data-tool-id]"), (element) =>
          element.getAttribute("data-tool-id"),
        ),
      ),
    ).toEqual(tools);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/five-tools-ready.png`);
    await $('[data-testid="preinstalled-tools-auto-install"]').click();
    await browser.waitUntil(async () => !(await state()).autoInstallEnabled);
    await browser.keys("Escape");
    const main = await observe("main", 360000);
    expect(main.plugins).toEqual(["documents", "pdf", "spreadsheets", "presentations"]);
    expect(main.formulas).toEqual({ C1: 5, D1: "#DIV/0!" });
    // Windows 上 pdf2image 解析到入口目录下带扩展名的入口；探针已按 PATH 实际结果核对目录。
    expect(main.pdf2imageEntry.toLowerCase()).toContain(
      join(root, "bin", "pdftoppm").toLowerCase(),
    );
    const records = Object.fromEntries(
      await Promise.all(
        tools.map(async (tool) => [
          tool,
          JSON.parse(await readFile(join(root, "tools", tool, "installation.json"), "utf8")),
        ]),
      ),
    );
    for (const tool of tools) {
      await openDialog();
      const toggle = $(`${card(tool)} [data-testid="preinstalled-tools-agent-enabled"]`);
      await toggle.scrollIntoView();
      await toggle.click();
      await browser.waitUntil(
        async () => !(await state()).tools.find((item) => item.toolId === tool)?.agentEnabled,
      );
      await browser.keys("Escape");
      await observe(`${tool}-off`);
      for (const id of tools)
        expect(
          JSON.parse(await readFile(join(root, "tools", id, "installation.json"), "utf8")),
        ).toEqual(records[id]);
      await openDialog();
      await $(`${card(tool)} [data-testid="preinstalled-tools-agent-enabled"]`).scrollIntoView();
      await $(`${card(tool)} [data-testid="preinstalled-tools-agent-enabled"]`).click();
      await browser.waitUntil(
        async () => !!(await state()).tools.find((item) => item.toolId === tool)?.agentEnabled,
      );
      await browser.keys("Escape");
      await observe(`${tool}-on`);
    }
    expect((await http()).requests).toBe(5);
    await observe("fallbacks", 180000);
    const finish = await observe("finish");
    expect(finish.pythonBaseUnchanged).toBe(true);
    expect(finish.defaultProfileUnchanged).toBe(true);
    expect(finish.signatures).toBe(
      process.platform === "darwin" ? "valid-before-and-after" : "not-applicable",
    );
    const originalSessionId = sessionId;
    await writeFile(
      join(directory, "initial-session-evidence.json"),
      JSON.stringify({ sessionId, observations, downloads: await http() }, null, 2),
    );
    // Main 在 worker 重启时复用初始 catalog；只有真正 App 重启才载入新版本清单。
    await fetch(`${fixture()}/upgrade`);
    const previousAppPid = await browser.electron.execute(() => process.pid);
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    const upgradedAppPid = await browser.electron.execute(() => process.pid);
    expect(upgradedAppPid).not.toBe(previousAppPid);
    sessionId = null;
    await waitStatus("qpdf", "not-installed");
    expect((await http()).requests).toBe(5);
    await openDialog();
    await $(`${card("qpdf")} [data-testid="preinstalled-tools-update"]`).click();
    await waitStatus("qpdf", "preparing");
    await browser.keys("Escape");
    await observe("upgrade-before");
    await fetch(`${fixture()}/release/${qpdfResourceIds.after}`);
    await waitStatus("qpdf", "ready");
    await observe("upgrade-after");
    await expect(stat(records.qpdf.installationDir)).resolves.toBeDefined();
    for (const id of tools.filter((tool) => tool !== "qpdf")) {
      expect((await http()).tools[id]!.requests).toBe(1);
      expect(
        JSON.parse(await readFile(join(root, "tools", id, "installation.json"), "utf8")),
      ).toEqual(records[id]);
    }
    await writeFile(
      join(directory, "session-evidence.json"),
      JSON.stringify(
        {
          originalSessionId,
          upgradeSessionId: sessionId,
          appReload: { previousAppPid, upgradedAppPid },
          observations,
          downloads: await http(),
          requestsBefore,
          sourcePackageVersion,
          // default-App 的 getVersion 可能是 Electron 包版本，不能冒充本仓库产品版本。
          electronReportedAppVersion: await browser.electron.execute((electron) =>
            electron.app.getVersion(),
          ),
          electronVersion: await browser.electron.execute(() => process.versions.electron),
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      ),
    );
    // 真正 App 启动才回收旧版本；先结束原会话验收，再通过退出屏障重启。
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E();
    for (const tool of tools) await waitStatus(tool, "ready");
    await absent(records.qpdf.installationDir);
    await openDialog();
    const remainingRecords = Object.fromEntries(
      await Promise.all(
        tools.map(async (tool) => [
          tool,
          JSON.parse(await readFile(join(root, "tools", tool, "installation.json"), "utf8")),
        ]),
      ),
    );
    for (const tool of tools) {
      const recordPath = join(root, "tools", tool, "installation.json");
      const installed = JSON.parse(await readFile(recordPath, "utf8"));
      await $(`${card(tool)} [data-testid="preinstalled-tools-delete"]`).scrollIntoView();
      await $(`${card(tool)} [data-testid="preinstalled-tools-delete"]`).click();
      await $('[data-testid="preinstalled-tools-delete-confirm"]').waitForDisplayed();
      if (tool === "python")
        expect(await $('[data-testid="preinstalled-tools-delete-confirm"]').getText()).toContain(
          "Agent 额外安装的 Python 包也会删除",
        );
      await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
      await waitStatus(tool, "not-installed");
      await browser.waitUntil(
        async () => $(`${card(tool)} [data-testid="preinstalled-tools-download"]`).isEnabled(),
        { timeout: 30000 },
      );
      await absent(recordPath);
      await absent(installed.installationDir);
      expect(await readdir(join(root, "tools", tool, "versions"))).toEqual([]);
      expect((await state()).tools.find((item) => item.toolId === tool)?.agentEnabled).toBe(true);
      // Windows 入口是 <name>.exe 加 <name>.shim；只查无扩展名路径会让删除断言恒为真。
      for (const entry of installed.entries) {
        await absent(preinstalledEntryPath(join(root, "bin"), entry.name));
        if (process.platform === "win32") await absent(join(root, "bin", `${entry.name}.shim`));
      }
      delete remainingRecords[tool];
      for (const [other, expected] of Object.entries(remainingRecords)) {
        expect(
          JSON.parse(await readFile(join(root, "tools", other, "installation.json"), "utf8")),
        ).toEqual(expected);
        expect((await state()).tools.find((item) => item.toolId === other)?.status).toBe("ready");
      }
    }
    expect((await http()).requests).toBe(6);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/five-tools-deleted.png`);
    await writeFile(
      join(directory, "deletion-evidence.json"),
      JSON.stringify(
        { tools, oldQpdfRemovedOnAppRestart: true, http: await http(), state: await state() },
        null,
        2,
      ),
    );
    await cp(directory, `${process.env.ZCODE_E2E_ARTIFACT_DIR}/real-document-results`, {
      recursive: true,
    });
  });
});
