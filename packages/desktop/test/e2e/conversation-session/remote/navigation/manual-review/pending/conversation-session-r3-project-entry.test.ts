import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import * as app from "#e2e/helpers/desktop-app";
import * as ssh from "#e2e/helpers/ssh-remote-p0";
import * as v4 from "#e2e/helpers/v4-conversation";
import * as recorder from "#e2e/helpers/electron-window-recorder";

const marker = "E2E_R3_PROJECT_ENTRY";

describe(`${marker}: R3 首连后显式添加项目`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await app.clearAppData();
  });

  it("真实 SSH 连接后经目录步骤打开指定远端项目，并绑定稳定 Source 身份", async function () {
    this.timeout(120_000);
    const config = ssh.readSSHRuntimeConfig(marker);
    await v4.prepareV4ConversationE2E({ skipProvider: true });
    const artifact = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!);
    await mkdir(artifact, { recursive: true });
    const recording =
      process.env.ZCODE_E2E_FAILURE_ARTIFACTS === "1"
        ? undefined
        : await recorder.startElectronWindowRecording({
            outputPath: resolve(artifact, "project-entry.webm"),
          });
    try {
      const tab = await ssh.connectSSHWorkspace({
        config,
        workspacePath: config.workspacePaths[0],
        caseMarker: marker,
      });
      expect(tab.remoteKind).toBe("ssh");
      expect(tab.workspacePath).toBe(config.workspacePaths[0]);
      expect(tab.remoteSessionId).toBeTruthy();
      expect(tab.secretPersistedInTab).toBe(false);
      expect(parseRemoteWorkspaceIdentity(tab.workspaceIdentity!)?.sourceServerId).toBeTruthy();
      await writeFile(resolve(artifact, "project-entry-facts.json"), JSON.stringify(tab, null, 2));
    } finally {
      await browser.saveScreenshot(resolve(artifact, "project-entry-final.png"));
      await recording?.stop();
    }
  });
});
