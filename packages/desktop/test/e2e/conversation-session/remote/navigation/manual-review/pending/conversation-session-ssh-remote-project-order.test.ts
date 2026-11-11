import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

const MARKER = "E2E_SSH_PROJECT_ORDER";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-project-order",
);
const readOrder = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-project-workspace-identity]")).map(
      (item) => item.dataset.projectWorkspaceIdentity!,
    ),
  );

describe(`${MARKER}: 平铺项目拖动顺序`, () => {
  const facts: Record<string, unknown> = {};
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "project-order.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SSH-GUIDE-ORDER 真实拖动后重启保持顺序，断开与上线不重新排列项目", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const a = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const b = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[1],
    });
    await selectTaskOrganizeMode(["项目", "Project"]);
    const before = await readOrder();
    expect(new Set(before)).toEqual(new Set([a.workspaceIdentity, b.workspaceIdentity]));
    const from = $(
      `[data-project-workspace-identity="${before[1]}"] [data-testid="virtual-project-toggle"]`,
    );
    const to = $(
      `[data-project-workspace-identity="${before[0]}"] [data-testid="virtual-project-toggle"]`,
    );
    await from.scrollIntoView();
    const start = await from.getLocation();
    const end = await to.getLocation();
    const size = await from.getSize();
    const x = Math.round(start.x + Math.min(size.width / 2, 80));
    await browser
      .action("pointer")
      .move({ x, y: Math.round(start.y + size.height / 2) })
      .down({ button: 0 })
      .pause(100)
      .move({ x: x + 12, y: Math.round(start.y + size.height / 2) })
      .pause(100)
      .move({ x, y: Math.round(end.y + size.height / 2) })
      .pause(100)
      .up({ button: 0 })
      .perform();
    const expected = [...before].reverse();
    await browser.waitUntil(
      async () => JSON.stringify(await readOrder()) === JSON.stringify(expected),
      { timeout: 15_000, timeoutMsg: `${MARKER}: 拖动后项目顺序未改变` },
    );
    facts.before = before;
    facts.afterDrag = await readOrder();
    await browser.saveScreenshot(resolve(artifactDir, "after-drag.png"));

    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(MARKER);
    await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: b.workspaceIdentity!,
      expectedPath: b.workspacePath!,
      requireActive: false,
      timeoutMs: 180_000,
    });
    await selectTaskOrganizeMode(["项目", "Project"]);
    expect(await readOrder()).toEqual(expected);
    const sourceId = parseRemoteWorkspaceIdentity(a.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error("缺少设备身份");
    await disconnectRemoteSource(sourceId, MARKER);
    expect(await readOrder()).toEqual(expected);
    await requestRemoteProjectConnection(a.workspaceIdentity!, MARKER);
    // connectHost 恢复设备与项目入口状态，不为未激活目录创建 Renderer tab。
    const connectedProject = $(
      `[data-project-workspace-identity=${JSON.stringify(a.workspaceIdentity!)}]`,
    );
    await browser.waitUntil(
      async () => (await connectedProject.getAttribute("data-connection-state")) === "online",
      { timeout: 30_000, timeoutMsg: `${MARKER}: 项目连接状态未恢复` },
    );
    expect(await readOrder()).toEqual(expected);
    facts.restartAndConnectionOrderPreserved = true;
  });
});
