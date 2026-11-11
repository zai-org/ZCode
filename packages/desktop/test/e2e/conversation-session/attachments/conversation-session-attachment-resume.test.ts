import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  restartIntoWorkspacePreservingProfile,
  seedTurboAgentStartupModel,
} from "#e2e/helpers/model-provider-restart";
import {
  ensureUpstreamProviderForE2E,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  resolveSeededReplayBaseUrl,
  seedCustomAnthropicMessagesProvider,
} from "#e2e/helpers/custom-openai-provider-store";
import {
  clickV4Send,
  getV4ComposerAttachments,
  pickV4ComposerFiles,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4RowAttachments,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "conversation-session-attachment-resume");
const FIRST = "E2E_ATTACHMENT_RESUME_FIRST";
const HOT = "E2E_ATTACHMENT_RESUME_HOT";
const COLD = "E2E_ATTACHMENT_RESUME_COLD";

describe("AR01 attachment cold resume", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts");
    await browser.saveScreenshot(join(artifacts, "attachment-resume-failure.png"));
    console.info(
      "AR01 failure UI",
      await browser.execute(() => document.body.innerText.slice(-5000)),
    );
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(ROOT, { force: true, recursive: true });
    await clearAppData();
  });

  it("重启后保留首轮正文顺序与三行路径说明", async function () {
    this.timeout(240_000);
    await waitForDefaultWorkspaceReady();
    // 此用例不测模型选择；通过现有 fixture 设置启动模型，避免依赖已移除的旧 toolbar。
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
    // 通用 fixture 的 240 token 窗口用于 compact 场景；本用例需要保留未经压缩的原始消息。
    await seedCustomAnthropicMessagesProvider({
      baseURL: await resolveSeededReplayBaseUrl(),
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      providerName: "Attachment Resume Fixture",
    });
    await seedTurboAgentStartupModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(ROOT, { recursive: true });
    const path = join(ROOT, "resume-bundle.zip");
    await writeFile(path, "binary fixture");
    await pickV4ComposerFiles([path]);
    await browser.waitUntil(
      async () => {
        const attachments = await getV4ComposerAttachments();
        return attachments.length === 1 && attachments[0]?.uploadStatus === "ready";
      },
      { timeout: 30_000, timeoutMsg: "AR01 文件附件未 ready" },
    );
    await setV4ComposerText(FIRST);
    await clickV4Send();
    await waitForV4TimelineContaining("ATTACHMENT_RESUME_FIRST_OK");
    const first = await waitForV4Pane(
      (s) => Boolean(s.sessionId && s.sessionId !== "draft") && !s.canStop,
      "AR01 首轮未完成",
    );
    expect(await waitForV4RowAttachments()).toContain("resume-bundle.zip");
    await sendV4Prompt(HOT);
    await waitForV4TimelineContaining("ATTACHMENT_RESUME_HOT_OK");
    await waitForV4Pane((s) => !s.canStop, "AR01 热态续聊未完成");
    const hot = firstUserContent((await waitForUpstreamNetworkCapture(HOT)).requestJson);
    expect(hot[0]).toMatchObject({ type: "text", text: FIRST });
    expect(hot[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("The file was sent by local path because"),
    });
    expect(String(hot[1]?.text).split("\n")).toHaveLength(3);

    // 原说明必须来自持久化事实；删除原文件后冷恢复也不应重新解析或丢失文案。
    await rm(path);
    // 任务已绑定自己的目录；按 task 身份恢复，不等待初始化阶段的默认项目路径。
    await reloadElectronSessionSafely(browser);
    await selectV4TaskById(first.sessionId!);
    await waitForV4TimelineContaining(HOT);
    await sendV4Prompt(COLD);
    await waitForV4TimelineContaining("ATTACHMENT_RESUME_COLD_OK");
    const cold = firstUserContent((await waitForUpstreamNetworkCapture(COLD)).requestJson);
    expect(cold).toEqual(hot);
  });
});

function firstUserContent(value: unknown): Array<Record<string, unknown>> {
  const messages = (value as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  const user = messages?.find(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block?.text === FIRST),
  );
  if (!user || !Array.isArray(user.content))
    throw new Error("AR01 provider capture 缺少首轮 user content");
  // SDK 会把此前的 user reminder 合并进同一 message；只截取本次要验证的正文及紧随其后的附件。
  const promptIndex = user.content.findIndex((block) => block?.text === FIRST);
  return user.content.slice(promptIndex, promptIndex + 2);
}
