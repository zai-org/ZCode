import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import { importLiveBigModelCredentials } from "#e2e/helpers/live-bigmodel-profile";
import { selectUpstreamModel } from "#e2e/helpers/upstream-provider";
import {
  connectSSHWorkspace,
  createSSHReplayTunnel,
  readSSHRuntimeConfig,
  runSSHCommand,
  type ReplayTunnel,
} from "#e2e/helpers/ssh-remote-p0";
import {
  prepareV4ConversationE2E,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  sendV4PromptAndWaitAccepted,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_CONVERSATION_SHARE_SSH_ARTIFACT_V1";
const ARTIFACT_TEXT = "E2E_SSH_SHARE_ARTIFACT_CONTENT";

async function readPublishState() {
  return browser.execute(() => {
    const visible = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element?.getClientRects().length ? element : null;
    };
    const success = visible('[data-testid="conversation-share-success-dock"]');
    const error = visible('[data-testid="conversation-share-error-details"]');
    return {
      status: success ? "success" : error ? "failed" : "pending",
      detail: error?.innerText.slice(0, 1800) ?? "",
      progress:
        visible('[data-testid="conversation-share-publish-progress"]')?.innerText.slice(0, 500) ??
        "",
    };
  });
}

describe(`${CASE_MARKER}: Desktop SSH 产物分享`, () => {
  const config = readSSHRuntimeConfig(CASE_MARKER);
  const workspacePath = `${config.workspacePaths[0]}/zcode-share-${Date.now()}`;
  let tunnel: ReplayTunnel | null = null;
  const facts: Record<string, unknown> = {};

  before(async () => {
    // 远端 Agent 的 loopback 不是 Desktop；固定 replay 端口需反向隧道。
    tunnel = await createSSHReplayTunnel(config, CASE_MARKER, { mirrorLocalPort: true });
  });

  after(async () => {
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "share-ssh.json"), JSON.stringify(facts, null, 2));
    await runSSHCommand(config, `rm -rf -- '${workspacePath}'`).catch(() => undefined);
    await tunnel?.close().catch(() => undefined);
    await clearAppData();
  });

  it("SHARE18/SHARE-E2E-02 SSH trusted attachment 使用远端 Rows/File 与目标账号 JWT/API", async function () {
    this.timeout(300_000);
    // 根因：API Key 登录没有 OAuth user；假 JWT 又会触发真实控制面的 401。
    // 沿用 live-team 的显式凭据导入，WDIO 为这个独立用例固定匹配的生产控制面。
    const imported = await importLiveBigModelCredentials(CASE_MARKER);
    const defaultWorkspace = resolve(getE2EAppDataPaths().homeDir, "ZCodeProject");
    await mkdir(defaultWorkspace, { recursive: true });
    await seedSettings({
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: { bigmodel: imported.teamSelection },
      lastWorkspaceSession: [
        { kind: "local", workspacePath: defaultWorkspace, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    } as never);
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 分享测试仅需要固定工具回放；默认模型已经没有旧 high 选项。
    await selectUpstreamModel();
    await runSSHCommand(config, `mkdir -p -- '${workspacePath}'`);
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    await switchV4Mode("yolo");
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}: use Write to create report.html containing ${ARTIFACT_TEXT} in the workspace, then reply share-ssh-ready with a markdown link to report.html`,
      CASE_MARKER,
      "SSH 分享准备消息没有被接受",
    );
    await waitForV4AssistantMessageContaining("share-ssh-ready");
    await waitForV4ConversationState(
      (state) => state.state === "idle" && Boolean(state.taskId) && state.taskId !== "draft",
      "SSH 分享前会话没有进入终态",
      120_000,
    );
    const remoteArtifact = await runSSHCommand(config, `cat '${workspacePath}/report.html'`);
    expect(remoteArtifact.stdout).toContain(ARTIFACT_TEXT);
    await clickTestIdByDom("conversation-share-trigger");
    // 当前产品将确认放在 Dock checkbox；旧 disclosure-confirm 弹窗已移除。
    await clickTestIdByDom("conversation-share-disclosure-checkbox");
    await clickTestIdByDom("conversation-share-confirm");
    let publishState = await readPublishState();
    const publishStartedAt = Date.now();
    try {
      // 服务端明确失败后立即收口；不能继续空等成功提示直到 120 秒，掩盖真实失败阶段。
      await browser.waitUntil(
        async () => {
          publishState = await readPublishState();
          return publishState.status !== "pending";
        },
        { timeout: 120_000, interval: 250, timeoutMsg: "SSH 分享发布没有返回终态" },
      );
    } finally {
      facts.publishState = publishState;
      facts.publishWaitMs = Date.now() - publishStartedAt;
    }
    if (publishState.status !== "success") {
      throw new Error(`SSH 分享发布失败: ${publishState.progress}; ${publishState.detail}`);
    }
    await clickTestIdByDom("conversation-share-copy-link");
    let shareUrl = "";
    await browser.waitUntil(
      async () => {
        shareUrl = await browser.electron.execute((electron) => electron.clipboard.readText());
        return /^https:\/\/zcode\.z\.ai\/(?:cn\/)?share\//u.test(shareUrl);
      },
      { timeout: 10_000, timeoutMsg: "没有复制到已发布的分享链接" },
    );
    const shareCode = new URL(shareUrl).pathname.split("/").filter(Boolean).at(-1)!;
    const response = await fetch(
      `https://zcode.z.ai/api/v1/shares/${encodeURIComponent(shareCode)}/preview`,
      { signal: AbortSignal.timeout(30_000) },
    );
    expect(response.status).toBe(200);
    const preview = createConversationShareSuccessEnvelopeSchema(
      conversationSharePreviewDataSchema,
    ).parse(await response.json()).data;
    // 不能只看成功 UI：必须证明远端真实文件已上传，公开内容包含同一份产物字节。
    const artifact = preview.artifacts.find((item) => item.display_name === "report.html");
    expect(artifact).toBeDefined();
    const downloaded = await fetch(artifact!.url, { signal: AbortSignal.timeout(30_000) });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toContain(ARTIFACT_TEXT);
    Object.assign(facts, {
      shareUrl,
      artifactCount: preview.artifacts.length,
      artifactName: artifact!.display_name,
      remoteArtifactVerified: true,
    });
  });
});
