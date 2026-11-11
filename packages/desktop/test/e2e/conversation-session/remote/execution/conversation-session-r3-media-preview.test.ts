import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readRemoteTabSnapshot, runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import {
  clickV4Send,
  pasteV4ComposerFileAttachment,
  selectV4TaskById,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4RowAttachments,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_MEDIA_PREVIEW";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-media-preview",
);
const IMAGE_FILE = "r3-dev05-preview.png";
// 2x2 红色 PNG（有效、可解码），用于校验预览真实加载出像素尺寸。
const PNG_2X2_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";

interface GalleryState {
  open: boolean;
  imageLoaded: boolean;
  naturalWidth: number;
  src: string;
  errorText: string;
  // 超时后补齐的现场事实：同一段点击代码在线时能打开 gallery，重连后打不开，
  // 必须知道"卡片是什么状态、有没有 portal 挂载"才能区分时序与产品行为。
  diagnostics?: unknown;
}

async function openSentImageAndReadGallery(requireCard = true): Promise<GalleryState> {
  const paneSelector = `[data-testid="${testId(TID_V4_SESSION_PANE, "workspace-main")}"]`;
  const clickCard = async () => {
    // 重连可能保留退场内容；限定主 pane，并使用用户可达的真实指针，不点击全局旧 DOM。
    const card = $(
      `${paneSelector} [data-v4-user-input-media-attachment="true"]:has(img[alt=${JSON.stringify(IMAGE_FILE)}])`,
    );
    if (
      !(await card.isDisplayed()) ||
      (await card.getAttribute("role")) !== "button" ||
      (await card.getAttribute("aria-disabled")) === "true"
    )
      return false;
    await card.scrollIntoView({ block: "center" });
    if (!(await card.isClickable())) return false;
    await card.click();
    return true;
  };
  let opened = false;
  if (requireCard) {
    // task 激活先于历史/缩略图挂载；失败录像中随后已出现图片，不能一次读取就判失败。
    await browser
      .waitUntil(
        async () => {
          opened = await clickCard();
          return opened;
        },
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg: `${CASE_MARKER}: 已恢复任务没有可点击的 ${IMAGE_FILE} 缩略图`,
        },
      )
      .catch(async (error) => {
        const cards = await browser.execute(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-v4-user-input-media-attachment='true']"),
          ).map((card) => ({
            visible: card.getClientRects().length > 0,
            disabled: card.getAttribute("aria-disabled"),
            role: card.getAttribute("role"),
            title: card.getAttribute("title"),
            images: Array.from(card.querySelectorAll<HTMLImageElement>("img")).map((image) => ({
              alt: image.alt,
              complete: image.complete,
              width: image.naturalWidth,
            })),
          })),
        );
        throw new Error(`${CASE_MARKER}: 缩略图尚未恢复或名称不匹配: ${JSON.stringify(cards)}`, {
          cause: error,
        });
      });
  } else {
    opened = await clickCard();
  }
  if (!opened)
    return {
      open: false,
      imageLoaded: false,
      naturalWidth: 0,
      src: "",
      errorText: "thumbnail-not-openable",
    };
  let state: GalleryState = {
    open: false,
    imageLoaded: false,
    naturalWidth: 0,
    src: "",
    errorText: "",
  };
  let diagnostics: unknown;
  await browser
    .waitUntil(
      async () => {
        state = await browser.execute(() => {
          const dialog = document.querySelector<HTMLElement>("[role='dialog']");
          const image = dialog?.querySelector<HTMLImageElement>("img");
          const errorText = Array.from(
            dialog?.querySelectorAll<HTMLElement>("[role='alert'], [data-error], p") ?? [],
          )
            .map((n) => n.innerText.trim())
            .filter((t) => /失败|错误|无法|error|fail/iu.test(t))
            .join(" | ")
            .slice(0, 200);
          return {
            open: Boolean(dialog),
            imageLoaded: Boolean(image && image.complete && image.naturalWidth > 0),
            naturalWidth: image?.naturalWidth ?? 0,
            src: (image?.src ?? "").slice(0, 40),
            errorText,
          };
        });
        return state.open && (state.imageLoaded || state.errorText.length > 0);
      },
      // role=button 已证明缩略图具备打开能力；图片 gallery 只需提交本地展示状态。
      // 旧 45 秒余量掩盖了在 onOpen 尚未提供时点击空 DIV 的测试错误。
      { timeout: 10_000, interval: 200, timeoutMsg: "gallery" },
    )
    .catch(async () => {
      diagnostics = await browser
        .execute((filename) => {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>("[data-v4-user-input-media-attachment='true']"),
          );
          const target = cards.find((candidate) =>
            candidate.querySelector<HTMLImageElement>(`img[alt="${filename}"]`),
          );
          const image = target?.querySelector<HTMLImageElement>(`img[alt="${filename}"]`);
          return {
            cardCount: cards.length,
            targetFound: Boolean(target),
            targetTag: target?.tagName ?? null,
            targetAriaDisabled: target?.getAttribute("aria-disabled") ?? null,
            targetRole: target?.getAttribute("role") ?? null,
            targetTitle: target?.getAttribute("title") ?? null,
            targetDataset: target ? { ...target.dataset } : null,
            thumbnailComplete: Boolean(image?.complete),
            thumbnailNaturalWidth: image?.naturalWidth ?? 0,
            thumbnailSrcScheme: (image?.src ?? "").split(":")[0] ?? "",
            dialogCount: document.querySelectorAll("[role='dialog']").length,
            portalCount: document.querySelectorAll("[data-radix-portal],[data-portal]").length,
            bodyLastChildTag: document.body.lastElementChild?.tagName ?? null,
          };
        }, IMAGE_FILE)
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
    });
  return { ...state, ...(diagnostics === undefined ? {} : { diagnostics }) };
}

// 远端 tab 不会自动成为 primary pane（离线隐藏任务行、重连后主区停在欢迎页），
// 两处读取 gallery 之前都要经 tab store 显式激活。
async function activateRemoteTab(identity: string): Promise<void> {
  const activated = await browser.execute((id) => {
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState?: () => {
            tabs?: Array<{ id: string; workspaceIdentity?: string }>;
            activateTab?: (tabId: string) => void;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    const state = store?.getState?.();
    const tab = state?.tabs?.find((candidate) => candidate.workspaceIdentity === id);
    if (!tab || !state?.activateTab) return false;
    state.activateTab(tab.id);
    return true;
  }, identity);
  expect(activated).toBe(true);
  await browser.waitUntil(
    async () => (await readRemoteTabSnapshot()).activeWorkspaceIdentity === identity,
    {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 未激活目标远端工作区`,
    },
  );
}

async function closeGallery(): Promise<void> {
  await browser.keys(["Escape"]);
  await browser.waitUntil(() => browser.execute(() => !document.querySelector("[role='dialog']")), {
    timeout: 10_000,
    timeoutMsg: `${CASE_MARKER}: gallery 没有关闭`,
  });
}

describe(`${CASE_MARKER}: 远端媒体附件的预览读取、断线后访问与恢复`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "media-preview.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-DEV-05/10 远端图片真实预览、断线与重连；重连后下载到本机字节一致，取消保存不覆盖文件", async function () {
    this.timeout(25 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });

    await setV4ComposerText(`${CASE_MARKER}_IMAGE 看图`);
    await pasteV4ComposerFileAttachment(IMAGE_FILE, { pngBase64: PNG_2X2_BASE64 });
    await browser.waitUntil(
      () =>
        browser.execute(
          (name) =>
            Boolean(
              Array.from(
                document.querySelectorAll<HTMLImageElement>(
                  '[data-composer-attachment-kind="image"][data-upload-status="ready"] img[alt]',
                ),
              )
                .find((img) => img.alt === name)
                ?.src.startsWith("blob:"),
            ),
          IMAGE_FILE,
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 图片没有完成上传与缩略图` },
    );
    const start = await getUpstreamRequestRecordCount();
    await clickV4Send();
    await waitForV4RowAttachments(60_000);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_IMAGE`] },
      `${CASE_MARKER}: 图片回合没有到达回放`,
      90_000,
      { afterIndex: start - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_MEDIA_PREVIEW_REPLY", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 图片回合没有收口`,
      90_000,
    );

    // 在线预览：gallery 打开且图片真实解码（naturalWidth=2）。
    const online = await openSentImageAndReadGallery();
    facts.previewOnline = online;
    expect(online.open).toBe(true);
    expect(online.imageLoaded).toBe(true);
    expect(online.naturalWidth).toBe(2);
    const [imageRequest] = await getUpstreamRequestEvidence(
      {
        lastUserMessageIncludes: [`${CASE_MARKER}_IMAGE`],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      { afterIndex: start - 1 },
    );
    const remoteImagePath = JSON.stringify(imageRequest?.requestJson).match(
      /\[Image: source: ([^\]]+)\]/u,
    )?.[1];
    expect(remoteImagePath).toMatch(/^\/home\/dev\/\.zcode\/cli\/image-cache\/[A-Za-z0-9_./-]+$/u);
    const remoteHash = await runSSHCommand(prepared.config, `sha256sum -- '${remoteImagePath}'`);
    expect(remoteHash.code).toBe(0);
    const expectedImageHash = createHash("sha256")
      .update(Buffer.from(PNG_2X2_BASE64, "base64"))
      .digest("hex");
    expect(remoteHash.stdout.split(/\s/u)[0]).toBe(expectedImageHash);
    facts.remoteImageSha256 = expectedImageHash;
    await closeGallery();

    // 断开 Source：sent row 缩略图/预览的表现（不得假成功地宣称新读取，不崩；允许使用本地 blob 缓存）。
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId ?? "";
    await selectTaskOrganizeMode(["项目", "Project"]);

    await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [taskA.identity] });

    await browser.pause(1_500);
    // 离线时任务行隐藏（O-07），经 tab store 激活远端 tab 后读取 gallery。
    await activateRemoteTab(taskA.identity);
    const offline = await openSentImageAndReadGallery(false);
    const rendererAlive = await browser.execute(() =>
      Boolean(
        document.querySelector('[data-testid^="v4-session-pane"], [data-testid="task-list"], main'),
      ),
    );
    facts.previewOffline = { ...offline, rendererAlive };
    expect(rendererAlive).toBe(true);
    if (offline.imageLoaded) expect(offline.src).toMatch(/^blob:/u);
    await closeGallery();

    // 重连后再次预览可读。
    await reconnectRemoteProject(taskA.identity, CASE_MARKER);
    await browser.waitUntil(
      async () =>
        Boolean((await readRemoteTabSnapshot(taskA.identity).catch(() => null))?.remoteSessionId),
      { timeout: 120_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 重连没有恢复` },
    );
    // 修复原因：上一步只等 remoteSessionId 出现，恢复链路此时还在拉任务列表；立刻点侧栏
    // task 会落在空草稿上（实测 latest.rowCount=0、sessionId="draft"，timeline 还是欢迎页）。
    // 先等工作区真正挂回来，再选任务。
    await waitForWorkspaceApp(workspaceA, 60_000);
    // 修复原因：远端 tab 在重连后不会自动成为 primary pane，主区停在"选择项目"欢迎页，
    // 点侧栏 task 也切不过去（实测 rowCount=0、sessionId="draft"）。离线读取那一步已经
    // 承认要手动激活远端 tab，重连后同样需要。
    await activateRemoteTab(taskA.identity);
    await selectV4TaskById(taskA.taskId, 60_000);
    const after = await openSentImageAndReadGallery();
    facts.previewAfterReconnect = after;
    expect(after.open).toBe(true);
    expect(after.imageLoaded).toBe(true);

    // DEV-10 的导出走真实 gallery → Main Save As；只控制 OS 选择路径，文件写入不替代。
    await mkdir(artifactDir, { recursive: true });
    const exportedPath = resolve(artifactDir, "exported-remote-image.png");
    const canceledPath = resolve(artifactDir, "canceled-export-canary.png");
    const cancelCanary = "R3_MEDIA_CANCEL_MUST_PRESERVE";
    await writeFile(canceledPath, cancelCanary);
    const saveDialog = await browser.electron.mock("dialog", "showSaveDialog");
    await saveDialog.mockResolvedValueOnce({ canceled: false, filePath: exportedPath });
    const download = $(
      '[role="dialog"] button[aria-label="下载图片"], [role="dialog"] button[aria-label="Download image"]',
    );
    await download.waitForClickable({ timeout: 15_000 });
    await download.click();
    let exported: Buffer | undefined;
    await browser.waitUntil(
      async () => {
        try {
          exported = await readFile(exportedPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        return exported.length > 0;
      },
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 下载没有在本机保存文件` },
    );
    expect(exported).toEqual(Buffer.from(PNG_2X2_BASE64, "base64"));
    facts.exportedImageSha256 = createHash("sha256").update(exported!).digest("hex");
    expect(facts.exportedImageSha256).toBe(facts.remoteImageSha256);

    await download.waitForEnabled({ timeout: 15_000 });
    await saveDialog.mockResolvedValueOnce({ canceled: true, filePath: canceledPath });
    await download.click();
    await browser.waitUntil(
      async () => {
        await saveDialog.update();
        return saveDialog.mock.calls.length === 2 && (await download.isEnabled());
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 取消保存没有结束` },
    );
    expect(await readFile(canceledPath, "utf8")).toBe(cancelCanary);
    facts.cancelPreservedLocalFile = true;
    await closeGallery();
  });
});
