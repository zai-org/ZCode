/* eslint-disable max-lines -- APC01-APC15 共用真实 Host stat、Browser/Preview Pane 与 cold-resume fixture。 */
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_WEBVIEW,
  TID_PREVIEW_PANE,
} from "@zcode/shared/test-ids";
import type { ChainablePromiseElement } from "webdriverio";
import { PlatformChannels, type FileApplicationInfo } from "@zcode/shared";
import {
  installFileApplicationMenuProbe,
  readFileApplicationMenuProbe,
  readFileLocateProbe,
  readFileManagerRevealProbe,
  restoreFileApplicationMenuProbe,
} from "../helpers/file-application-menu-probe.js";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_ASSISTANT_PREVIEW_CARDS";
const CASE_RELATIVE_ROOT = "assistant-preview-e2e";
const CASE_ROOT = join(DEFAULT_WORKSPACE, CASE_RELATIVE_ROOT);
const OFFICE_FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const STREAM_URL = "http://localhost:41789/assistant-preview-stream";

const SOURCE_HTML_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/本轮 输出/index 页面.html`;
const SOURCE_MARKDOWN_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/本轮 输出/说明 文档.md`;
const SOURCE_HTML_PATH = join(DEFAULT_WORKSPACE, SOURCE_HTML_RELATIVE_PATH);
const REVEAL_SOURCE_HTML_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/预览 源码/app 页面.html`;

const OFFICE_FILES = [
  { fixture: "sample.docx", name: "项目 简介.docx" },
  { fixture: "sample.xlsx", name: "年度 总结.xlsx" },
  { fixture: "sample.pptx", name: "产品 路线.pptx" },
  { fixture: "sample.pdf", name: "审计 报告.pdf" },
] as const;
const MEDIA_FILES = ["生成 视频.mp4", "生成 音频.wav"] as const;
// 与 getFileManagerLabel 按平台取文案一致；E2E 进程与 Electron 同机，process.platform 等价于 UA 判断。
const FILE_MANAGER_LABEL =
  process.platform === "darwin"
    ? /^(Open in Finder|在 Finder 中打开)$/
    : process.platform === "win32"
      ? /^(Open in File Explorer|在资源管理器中打开)$/
      : /^(Open in File Manager|在文件管理器中打开)$/;
const REVEAL_IN_FINDER_LABEL = /^(Open in Finder|在 Finder 中打开)$/;
const SELECT_OPEN_APP_SELECTOR =
  'button[aria-label="Choose app"], button[aria-label="选择打开方式"]';

interface PreviewCardSnapshot {
  text: string;
  title: string;
}

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";

describe("Assistant Preview Cards E2E", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureRootUrl = await listen(fixtureServer);
  });

  afterEach(async () => {
    await closeSidePanes();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("APC01/APC04: completed localhost URL 去重并打开真实 Browser 页面", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_LOCAL_URL`;
    await sendV4Prompt(
      `${marker}: reply with the same local preview URL more than once. E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
    );
    await waitForCompleted(`${marker}_DONE`);

    await waitForPreviewCards(["APC Local Preview"]);
    // APC01 同时验证整卡点击：localhost 网页卡片主体与主按钮触发同一 Browser 预览。
    await clickPreviewCardBody("APC Local Preview");
    await waitForBrowserSurface(fixtureRootUrl, "APC01_LOCAL_URL_PAGE");
  }).timeout(180_000);

  it("APC02: interrupted turn 在 URL 已到达后 Stop，卡片只在终态出现", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_INTERRUPTED`;
    await sendV4Prompt(`${marker}: keep streaming after publishing ${STREAM_URL}.`);
    await waitForV4AssistantMessageContaining(`${marker}_EARLY`, 60_000);
    expect(await readPreviewCards()).toEqual([]);

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${marker}_EARLY`),
      "APC02 Stop 后 turn 没有进入 interrupted 终态",
      60_000,
    );
    await waitForPreviewCards(["assistant-preview-stream"]);
  }).timeout(180_000);

  it("APC03: streaming 期间不显示卡片，complete 后显示", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_STREAMING`;
    await sendV4Prompt(`${marker}: stream ${STREAM_URL} before the final marker.`);
    await waitForV4AssistantMessageContaining(`${marker}_EARLY`, 60_000);
    expect(await readPreviewCards()).toEqual([]);

    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["assistant-preview-stream"]);
  }).timeout(180_000);

  it("APC04: localhost 与本轮 HTML 同时出现时按现有业务规则抑制 HTML", async () => {
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_LOCAL_SUPPRESSES_HTML`;
    await sendV4Prompt(
      `${marker}: create ${SOURCE_HTML_RELATIVE_PATH}, then mention it with E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}.`,
    );
    await waitForCompleted(`${marker}_DONE`);

    await waitForPreviewCards(["APC Local Only"]);
    await expectPreviewCardMissing(basename(SOURCE_HTML_RELATIVE_PATH));
  }).timeout(180_000);

  it("APC06/APC07: source gate、Office 自动打开 PPTX", async () => {
    await prepareCase();
    await materializeOfficeFixtures();
    await materializeStaleSourceFiles();
    const marker = `${CASE_MARKER}_OFFICE`;
    await sendV4Prompt(`${marker}_PPTX: report the prepared Office files and one missing PDF.`);
    await waitForCompleted(`${marker}_PPTX_DONE`);

    const officeTitles = [...OFFICE_FILES].reverse().map((item) => item.name);
    await waitForPreviewCards(officeTitles);
    await expectPreviewCardMissing("旧 页面.html");
    await expectPreviewCardMissing("旧 说明.md");
    await expectPreviewCardMissing("不存在.pdf");
    await waitForPreviewRenderer("产品 路线.pptx", "pptx");
    for (const file of OFFICE_FILES) {
      await assertFileOpenApps(file.name);
    }
  }).timeout(240_000);

  it("APC14: unified file menu defaults, first three and More dispatch the selected application", async () => {
    await prepareCase();
    await materializeOfficeFixtures();
    const marker = `${CASE_MARKER}_OFFICE`;
    await sendV4Prompt(`${marker}_PPTX: report the prepared Office files and one missing PDF.`);
    await waitForCompleted(`${marker}_PPTX_DONE`);
    await waitForPreviewCards([...OFFICE_FILES].reverse().map((item) => item.name));
    await closeSidePanes();
    const filename = "产品 路线.pptx";
    const targetPath = await realpath(join(CASE_ROOT, "office", filename));
    const row = await browser.$(`[data-preview-card-title="${filename}"]`);
    // 原生候选依平台而变；固定边界使用明确 IPC fixture，不冒充系统枚举或实际启动。
    for (const count of [0, 1, 3, 10]) {
      const applications = Array.from({ length: count }, (_, index) => ({
        id: `apc-app-${index}`,
        name: `APC Application ${index}`,
        isDefault: index === count - 1,
      }));
      await installFileApplicationMenuProbe(targetPath, applications);
      try {
        await assertFileOpenApps(filename, applications);
        await row.click({ button: "right" });
        const menu = await browser.$('[data-slot="context-menu-content"][data-state="open"]');
        await menu.waitForDisplayed();
        await assertApplicationMenu(menu, applications);
        const labels = await menu.$$('[role="menuitem"]').map((item) => item.getText());
        expect(labels[0]).toMatch(/^(Preview|预览)$/);
        expect(labels.some((label) => /Open containing folder|打开所在目录/.test(label))).toBe(
          false,
        );
        // 卡片右键与 Open 下拉提供同一个定位项（右键行为由 APC15 覆盖）。
        expect(labels.filter((label) => FILE_MANAGER_LABEL.test(label))).toHaveLength(1);
        await browser.keys("Escape");
        await assertRevealInFileManager(row, targetPath);
        // 点击真实预览动作后核对 renderer，而不是直接调用产品回调。
        await row.click({ button: "right" });
        await browser
          .$('[data-slot="context-menu-content"][data-state="open"] [role="menuitem"]')
          .click();
        await waitForPreviewRenderer(filename, "pptx");
        if (count > 3) {
          await row.$('button[aria-label="Choose app"], button[aria-label="选择打开方式"]').click();
          const dropdown = await browser.$(
            '[data-slot="dropdown-menu-content"][data-state="open"]',
          );
          await dropdown.$(".file-application-more-trigger").moveTo();
          const list = await browser.$("[data-file-application-list]");
          await list.waitForDisplayed();
          const items = await list.$$('[role="menuitem"]');
          const last = items[(await items.length) - 1]!;
          await last.scrollIntoView();
          await last.click();
          await browser.waitUntil(async () => (await readFileApplicationMenuProbe()).length === 1, {
            timeout: 10_000,
          });
          const [call] = await readFileApplicationMenuProbe();
          expect(call?.applicationId).toBe("apc-app-8");
          expect(call?.target.path).toBe(targetPath);
          expect(call?.target.pathKind).toBe("file");
        }
      } finally {
        await browser.keys("Escape");
        await browser.keys("Escape");
        await restoreFileApplicationMenuProbe();
      }
    }
  }).timeout(240_000);

  it("APC15: macOS 文件卡「在 Finder 中打开」定位到所在目录，纯网址卡不提供该项", async function () {
    // 文案与定位通道按平台分叉（Finder / 资源管理器 / 文件管理器），本例只覆盖 macOS。
    if (process.platform !== "darwin") this.skip();
    await prepareCase();
    await materializeOfficeFixtures();
    const marker = `${CASE_MARKER}_REVEAL`;
    await sendV4Prompt(
      `${marker}: report the prepared DOCX and a local preview URL. E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
    );
    await waitForCompleted(`${marker}_DONE`);
    const filename = "项目 简介.docx";
    const linkTitle = "APC Reveal Link";
    await waitForPreviewCardSet([filename, linkTitle]);
    await closeSidePanes();
    const expectedFile = await realpath(join(CASE_ROOT, "office", filename));
    const row = await browser.$(`[data-preview-card-title="${filename}"]`);
    const linkRow = await browser.$(`[data-preview-card-title="${linkTitle}"]`);

    await installFileManagerRevealProbe();
    try {
      // 右键菜单：文件卡出现该项，点击后让 Finder 打开所在目录并选中该文件。
      await row.click({ button: "right" });
      await clickOpenMenuItem("context-menu", REVEAL_IN_FINDER_LABEL);
      await expectFinderRevealCalls([expectedFile]);

      // 「打开」下拉：同一项走同一条定位通道。
      await row.$(SELECT_OPEN_APP_SELECTOR).click();
      await clickOpenMenuItem("dropdown-menu", REVEAL_IN_FINDER_LABEL);
      await expectFinderRevealCalls([expectedFile, expectedFile]);

      // 纯网址卡没有本机文件可定位：右键与下拉都不出现该项，也不触发 IPC。
      await linkRow.click({ button: "right" });
      expect(await readOpenMenuLabels("context-menu")).not.toContainEqual(
        expect.stringMatching(REVEAL_IN_FINDER_LABEL),
      );
      await browser.keys("Escape");
      // 下拉必须真实存在，否则「没有该项」的断言会因为没打开菜单而空过。
      const linkDropdownTrigger = await linkRow.$(SELECT_OPEN_APP_SELECTOR);
      expect(await linkDropdownTrigger.isExisting()).toBe(true);
      await linkDropdownTrigger.click();
      expect(await readOpenMenuLabels("dropdown-menu")).not.toContainEqual(
        expect.stringMatching(REVEAL_IN_FINDER_LABEL),
      );
      await browser.keys("Escape");
      expect(await readFileManagerRevealCalls()).toHaveLength(2);
    } finally {
      await browser.keys("Escape");
      await restoreFileManagerRevealProbe();
    }
  }).timeout(180_000);

  it("APC15: macOS localhost 预览卡映射到本轮 HTML 时定位源文件目录，打开仍走原 URL", async function () {
    if (process.platform !== "darwin") this.skip();
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_LOCAL_SOURCE`;
    // localhost 路径与本轮 Write 的工作区 HTML 一致，卡片才会带 sourcePath；URL 内不能有空白。
    const encodedSourcePath = REVEAL_SOURCE_HTML_RELATIVE_PATH.split("/")
      .map(encodeURIComponent)
      .join("/");
    const sourceUrl = `${new URL(fixtureRootUrl).origin}/${encodedSourcePath}`;
    await sendV4Prompt(
      `${marker}: create ${REVEAL_SOURCE_HTML_RELATIVE_PATH}, then share its local preview URL. E2E_BROWSER_FIXTURE_URL:${sourceUrl}`,
    );
    await waitForCompleted(`${marker}_DONE`);
    const title = basename(REVEAL_SOURCE_HTML_RELATIVE_PATH);
    await waitForPreviewCards([title]);
    await closeSidePanes();
    const expectedFile = await realpath(join(DEFAULT_WORKSPACE, REVEAL_SOURCE_HTML_RELATIVE_PATH));
    const row = await browser.$(`[data-preview-card-title="${title}"]`);

    await installFileManagerRevealProbe();
    try {
      // 卡片标题与 URL 兜底标题相同，卡片先于本轮 fileChanges 映射出现；sourcePath 到位后才有定位项。
      await browser.waitUntil(
        async () => {
          await row.click({ button: "right" });
          const labels = await readOpenMenuLabels("context-menu");
          if (labels.some((text) => REVEAL_IN_FINDER_LABEL.test(text))) return true;
          await browser.keys("Escape");
          return false;
        },
        { timeout: 15_000, interval: 500, timeoutMsg: "localhost 卡片没有出现定位源文件的菜单项" },
      );
      await clickOpenMenuItem("context-menu", REVEAL_IN_FINDER_LABEL);
      await expectFinderRevealCalls([expectedFile]);

      const dropdownTrigger = await row.$(SELECT_OPEN_APP_SELECTOR);
      expect(await dropdownTrigger.isExisting()).toBe(true);
      await dropdownTrigger.click();
      await clickOpenMenuItem("dropdown-menu", REVEAL_IN_FINDER_LABEL);
      await expectFinderRevealCalls([expectedFile, expectedFile]);
    } finally {
      await browser.keys("Escape");
      await restoreFileManagerRevealProbe();
    }

    // sourcePath 只用于定位：卡片打开仍把原 localhost URL 交给 Browser，而不是 file:// 源文件。
    await clickPreviewCardBody(title);
    await waitForBrowserSurface(sourceUrl, "APC01_LOCAL_URL_PAGE");
  }).timeout(180_000);

  it("APC15: macOS 正文文件链接右键「在 Finder 中打开」定位文件，目录链接直接打开目录", async function () {
    if (process.platform !== "darwin") this.skip();
    await prepareCase();
    await materializeOfficeFixtures();
    const marker = `${CASE_MARKER}_BODY_LINK_REVEAL`;
    await sendV4Prompt(`${marker}: link the prepared DOCX and its folder in the reply body.`);
    await waitForCompleted(`${marker}_DONE`);
    await closeSidePanes();
    const fileLinkLabel = "APC 正文文件链接";
    const directoryLinkLabel = "APC 正文目录链接";
    const fileLinkPath = await findBodyFileLinkPath(fileLinkLabel);
    const directoryLinkPath = await findBodyFileLinkPath(directoryLinkLabel);
    expect(await realpath(fileLinkPath)).toBe(
      await realpath(join(CASE_ROOT, "office", "项目 简介.docx")),
    );
    expect(await realpath(directoryLinkPath)).toBe(await realpath(join(CASE_ROOT, "office")));
    // 关联应用用固定 IPC fixture，菜单分组稳定；定位与打开目录两条 IPC 只记录，不拉起 Finder。
    const applications: FileApplicationInfo[] = [
      { id: "apc-body-app-0", name: "APC Body Application 0", isDefault: true },
      { id: "apc-body-app-1", name: "APC Body Application 1", isDefault: false },
    ];
    await installFileApplicationMenuProbe(fileLinkPath, applications);
    try {
      // 文件链接：定位项在应用分组之后、另存为之前，点击只发出一次 finder select-file。
      await browser.$(`button=${fileLinkLabel}`).click({ button: "right" });
      const order = await readBodyLinkMenuOrder(
        (current) => current.saveAs >= 0 && current.lastApplication >= 0 && !current.loading,
      );
      expect(order.revealCount).toBe(1);
      expect(order.reveal).toBeGreaterThan(order.lastApplication);
      expect(order.saveAs).toBe(order.reveal + 1);
      await clickOpenMenuItem("context-menu", REVEAL_IN_FINDER_LABEL);
      await browser.waitUntil(async () => (await readFileLocateProbe()).length > 0, {
        timeout: 10_000,
        timeoutMsg: "正文文件链接没有发出 Finder 定位请求",
      });
      // 稍等确认没有重复派发，也没有回退成打开目录或交给关联应用。
      await browser.pause(500);
      expect(await readFileLocateProbe()).toEqual([
        { editorId: "finder", path: fileLinkPath, pathKind: "file" },
      ]);
      expect(await readFileManagerRevealProbe()).toEqual([]);

      // 目录链接：同一项直接打开该目录，不走 select-file；目录没有另存为。
      await browser.$(`button=${directoryLinkLabel}`).click({ button: "right" });
      const directoryOrder = await readBodyLinkMenuOrder(
        (current) => current.reveal >= 0 && !current.loading,
      );
      expect(directoryOrder.revealCount).toBe(1);
      expect(directoryOrder.saveAs).toBe(-1);
      await clickOpenMenuItem("context-menu", REVEAL_IN_FINDER_LABEL);
      await browser.waitUntil(async () => (await readFileManagerRevealProbe()).length > 0, {
        timeout: 10_000,
        timeoutMsg: "正文目录链接没有发出打开目录请求",
      });
      await browser.pause(500);
      expect(await readFileManagerRevealProbe()).toEqual([directoryLinkPath]);
      expect(await readFileLocateProbe()).toHaveLength(1);
      expect(await readFileApplicationMenuProbe()).toEqual([]);
    } finally {
      await browser.keys("Escape");
      await restoreFileApplicationMenuProbe();
    }
  }).timeout(180_000);

  it("APC12: 独立音频消息打开原生 audio 播放器", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    const marker = `${CASE_MARKER}_OFFICE_AUDIO`;
    await sendV4Prompt(`${marker}: report the prepared audio file only.`);
    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["生成 音频.wav"]);
    const logSnapshot = await snapshotDesktopRuntimeLogs();
    await clickPreviewCard("生成 音频.wav");
    await waitForPreviewRenderer("生成 音频.wav", "audio");
    await assertLocalMediaPreviewLogs(logSnapshot);
  }).timeout(180_000);

  it("APC12: 独立视频消息打开并保持 media 节点", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    const marker = `${CASE_MARKER}_OFFICE_VIDEO`;
    await sendV4Prompt(`${marker}: report the prepared video file only.`);
    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["生成 视频.mp4"]);
    await assertFileOpenApps("生成 视频.mp4");
    const logSnapshot = await snapshotDesktopRuntimeLogs();
    await clickPreviewCard("生成 视频.mp4");
    await waitForPreviewRenderer("生成 视频.mp4", "video");
    const mediaUrl = await browser.execute(
      () => document.querySelector<HTMLVideoElement>("video[controls]")?.currentSrc ?? "",
    );
    expect(mediaUrl).not.toBe("");
    expect(new URL(mediaUrl).protocol).toBe("zcode-media:");
    await assertPreviewVideoSurvivesResizeAndFullscreen();
    await assertLocalMediaPreviewLogs(logSnapshot);
  }).timeout(180_000);

  it("APC08: 最多显示 10 张，并且前 15 个不足时不从第 16 个以后回填", async () => {
    await prepareCase();
    await materializeBoundFiles();

    const maxMarker = `${CASE_MARKER}_MAX_TEN`;
    await sendV4Prompt(`${maxMarker}: list the twelve prepared max-bound PDF paths in order.`);
    await waitForCompleted(`${maxMarker}_DONE`);
    await waitForPreviewCards(
      Array.from({ length: 10 }, (_, index) => `max-${String(12 - index).padStart(2, "0")}.pdf`),
    );
    await expectPreviewCardMissing("max-02.pdf");
    await expectPreviewCardMissing("max-01.pdf");

    await prepareCase();
    await materializeBoundFiles();
    const noFillMarker = `${CASE_MARKER}_NO_BACKFILL`;
    await sendV4Prompt(
      `${noFillMarker}: list all sixteen no-backfill PDF paths in ascending order.`,
    );
    await waitForCompleted(`${noFillMarker}_DONE`);
    await waitForPreviewCards(
      Array.from({ length: 9 }, (_, index) => `nofill-${String(16 - index).padStart(2, "0")}.pdf`),
    );
    await expectPreviewCardMissing("nofill-01.pdf");
  }).timeout(240_000);

  it("APC05/APC09/APC11: 当前轮 HTML/Markdown 逆序展示、打开，收起偏好在切换会话和 cold resume 后保留", async () => {
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_SOURCE_AND_COLD`;
    await sendV4Prompt(
      `${marker}: create ${SOURCE_HTML_RELATIVE_PATH} and ${SOURCE_MARKDOWN_RELATIVE_PATH}, then report both.`,
    );
    await waitForCompleted(`${marker}_DONE`);
    const targetSession = await waitForBoundSession(marker);

    const expectedTitles = [
      basename(SOURCE_MARKDOWN_RELATIVE_PATH),
      basename(SOURCE_HTML_RELATIVE_PATH),
    ];
    await waitForPreviewCards(expectedTitles);
    await assertSourcePreviewTargets();
    await assertLocalHtmlExternalOpen();

    await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
    await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
    await waitForSidePaneExpanded(true);
    await clickSidePaneToggle();
    await waitForSidePaneExpanded(false);

    await startNewV4Draft();
    const parkingMarker = `${CASE_MARKER}_PARKING`;
    await sendV4Prompt(`${parkingMarker}: complete a parking task before cold resume.`);
    await waitForCompleted(`${parkingMarker}_DONE`);
    const parkingSession = await waitForBoundSession(parkingMarker);
    expect(parkingSession).not.toBe(targetSession);

    await selectV4TaskById(targetSession, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === targetSession && snapshot.timelineText.includes(`${marker}_DONE`),
      `APC11 切回目标 session ${targetSession} 后没有恢复对话`,
      90_000,
    );
    await waitForPreviewCards(expectedTitles, 90_000);
    await waitForSidePaneExpanded(false);
    await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
    await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
    await waitForSidePaneExpanded(true);
    await closeSidePanes();

    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(targetSession, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === targetSession && snapshot.timelineText.includes(`${marker}_DONE`),
      `APC09 cold resume 后没有恢复目标 session ${targetSession}`,
      90_000,
    );
    await waitForPreviewCards(expectedTitles, 90_000);
    await assertSourcePreviewTargets();
  }).timeout(360_000);
});

async function prepareCase(options: { yolo?: boolean } = {}) {
  await prepareV4ConversationE2E();
  if (options.yolo) {
    await switchV4Mode("yolo");
  }
  await rm(CASE_ROOT, { recursive: true, force: true });
  await mkdir(CASE_ROOT, { recursive: true });
}

async function waitForCompleted(marker: string) {
  await waitForV4AssistantMessageContaining(marker, 90_000);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(marker),
    `Assistant Preview Cards turn 没有完成: ${marker}`,
    90_000,
  );
}

async function waitForBoundSession(marker: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) =>
      current.sessionId !== null &&
      current.sessionId !== "draft" &&
      !current.canStop &&
      current.timelineText.includes(marker),
    `Assistant Preview Cards 缺少已绑定 session: ${marker}`,
    60_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`Assistant Preview Cards 得到无效 sessionId: ${snapshot.sessionId ?? "null"}`);
  }
  return snapshot.sessionId;
}

async function readPreviewCards(
  expectedTitles: readonly string[] = [],
): Promise<PreviewCardSnapshot[]> {
  return browser.execute(
    (titles) => {
      const openLabels = new Set(["Open", "打开", "Preview", "预览"]);
      return Array.from(
        document.querySelectorAll<HTMLElement>('[data-zcode-stream-animate="true"]'),
      )
        .filter((row) =>
          Array.from(row.querySelectorAll<HTMLButtonElement>("button")).some((button) =>
            openLabels.has((button.textContent ?? "").trim()),
          ),
        )
        .map((row) => {
          const text = row.innerText.replace(/\u00a0/g, " ").trim();
          const title = titles.find((candidate) => text.includes(candidate)) ?? "";
          return { text, title };
        });
    },
    [...expectedTitles],
  );
}

async function waitForPreviewCards(expectedTitles: readonly string[], timeout = 60_000) {
  let latest: PreviewCardSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readPreviewCards(expectedTitles);
      return (
        latest.length === expectedTitles.length &&
        latest.every((card, index) => card.title === expectedTitles[index])
      );
    },
    {
      timeout,
      timeoutMsg: `预览卡片没有按预期收敛: expected=${JSON.stringify(expectedTitles)} latest=${JSON.stringify(latest)}`,
    },
  );
}

async function expectPreviewCardMissing(title: string) {
  const cards = await readPreviewCards([title]);
  expect(cards.some((card) => card.title === title)).toBe(false);
}

async function clickPreviewCard(title: string) {
  const result = await browser.execute((expectedTitle) => {
    const openLabels = new Set(["Open", "打开", "Preview", "预览"]);
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-zcode-stream-animate="true"]'),
    ).find((candidate) => candidate.innerText.includes(expectedTitle));
    const button = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => openLabels.has((candidate.textContent ?? "").trim()),
    );
    button?.click();
    return { clicked: Boolean(button), disabled: Boolean(button?.disabled) };
  }, title);
  expect(result.clicked).toBe(true);
  expect(result.disabled).toBe(false);
}

// 卡片主体整卡可点：点击标题区域（铺满卡片的透明按钮）与主按钮执行同一预览动作。
async function clickPreviewCardBody(title: string) {
  const result = await browser.execute((expectedTitle) => {
    const row = document.querySelector<HTMLElement>(`[data-preview-card-title="${expectedTitle}"]`);
    const overlay = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => (button.getAttribute("aria-label") ?? "").endsWith(expectedTitle),
    );
    overlay?.click();
    return { clicked: Boolean(overlay), disabled: Boolean(overlay?.disabled) };
  }, title);
  expect(result.clicked).toBe(true);
  expect(result.disabled).toBe(false);
}

async function assertApplicationMenu(
  menu: ChainablePromiseElement,
  applications: FileApplicationInfo[],
) {
  const unique = [...new Map(applications.map((app) => [app.id, app])).values()];
  const ordered = [
    ...unique.filter((app) => app.isDefault),
    ...unique.filter((app) => !app.isDefault),
  ];
  await browser.waitUntil(
    async () => {
      const ids = await menu
        .$$("[data-file-application-direct]")
        .map((item) => item.getAttribute("data-file-application-direct"));
      const text = await menu.getText();
      return (
        JSON.stringify(ids) === JSON.stringify(ordered.slice(0, 3).map((app) => app.id)) &&
        !/^(Loading|加载中)[….]*$/m.test(text)
      );
    },
    { timeout: 10_000, timeoutMsg: "File applications did not match the bound target" },
  );
  const direct = await menu.$$("[data-file-application-direct]");
  for (let index = 0; index < (await direct.length); index++) {
    const label = await direct[index]!.getText();
    expect(label).toContain(ordered[index]!.name);
    if (ordered[index]!.isDefault) expect(label).toMatch(/Open in|在.*中打开/);
    expect(
      await direct[index]!.$(
        '[data-slot="file-application-icon"], [data-slot="file-application-icon-fallback"]',
      ).isExisting(),
    ).toBe(true);
  }
  const text = await menu.getText();
  expect(text).toMatch(/Save as|另存为/i);
  expect(text).toMatch(/Copy absolute path|复制绝对路径/);
  if (ordered.length === 0) expect(text).toMatch(/Open with default app|使用默认应用打开/);
  const more = await menu.$(".file-application-more-trigger");
  expect(await more.isExisting()).toBe(ordered.length > 3);
  if (ordered.length > 3) {
    await more.moveTo();
    const list = await browser.$("[data-file-application-list]");
    await list.waitForDisplayed();
    const labels = await list.$$('[role="menuitem"]').map((item) => item.getText());
    expect(labels).toEqual(ordered.slice(3).map((app) => app.name));
    if (ordered.length > 9) {
      const dimensions = await list.getSize();
      expect(dimensions.height).toBeLessThanOrEqual(179);
    }
    await browser.keys("Escape");
  }
}

/**
 * 本地工作区 Open 下拉：定位项在应用分组之后、另存为之前。
 * macOS / Windows 点击后只发出一次 finder / explorer 定位（打开所在目录并选中该文件）；
 * 其他平台没有系统定位能力，只打开文件所在目录一次。
 */
async function assertRevealInFileManager(row: ChainablePromiseElement, targetPath: string) {
  await row.$('button[aria-label="Choose app"], button[aria-label="选择打开方式"]').click();
  const menu = await browser.$('[data-slot="dropdown-menu-content"][data-state="open"]');
  await menu.waitForDisplayed();
  await browser.waitUntil(async () => !/^(Loading|加载中)[….]*$/m.test(await menu.getText()), {
    timeout: 10_000,
    timeoutMsg: "File applications did not finish loading",
  });
  const order = await browser.execute((labelSource) => {
    const content = document.querySelector(
      '[data-slot="dropdown-menu-content"][data-state="open"]',
    );
    const items = Array.from(content?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const label = new RegExp(labelSource);
    const index = (predicate: (item: HTMLElement) => boolean) => items.findIndex(predicate);
    const appIndexes = items
      .map((item, position) =>
        item.matches("[data-file-application-direct], .file-application-more-trigger") ||
        /Open with default app|使用默认应用打开/.test(item.textContent ?? "")
          ? position
          : -1,
      )
      .filter((position) => position >= 0);
    return {
      lastApplication: appIndexes.at(-1) ?? -1,
      reveal: index((item) => label.test(item.textContent?.trim() ?? "")),
      revealCount: items.filter((item) => label.test(item.textContent?.trim() ?? "")).length,
      saveAs: index((item) => /^(Save as|另存为)/i.test(item.textContent?.trim() ?? "")),
    };
  }, FILE_MANAGER_LABEL.source);
  expect(order.revealCount).toBe(1);
  expect(order.lastApplication).toBeGreaterThanOrEqual(0);
  expect(order.reveal).toBeGreaterThan(order.lastApplication);
  expect(order.saveAs).toBe(order.reveal + 1);
  const reveal = (await menu.$$('[role="menuitem"]'))[order.reveal]!;
  expect(await reveal.getText()).toMatch(FILE_MANAGER_LABEL);
  await reveal.click();
  const dispatched = async () =>
    (await readFileManagerRevealProbe()).length + (await readFileLocateProbe()).length;
  await browser.waitUntil(async () => (await dispatched()) > 0, {
    timeout: 10_000,
    timeoutMsg: "Open in file manager was not dispatched",
  });
  // 稍等确认没有重复派发，也没有把文件交给系统默认应用或回退成第二次打开目录。
  await browser.pause(500);
  const locatorId =
    process.platform === "darwin" ? "finder" : process.platform === "win32" ? "explorer" : null;
  if (locatorId) {
    expect(await readFileLocateProbe()).toEqual([
      { editorId: locatorId, path: targetPath, pathKind: "file" },
    ]);
    expect(await readFileManagerRevealProbe()).toEqual([]);
  } else {
    expect(await readFileLocateProbe()).toEqual([]);
    expect(await readFileManagerRevealProbe()).toEqual([dirname(targetPath)]);
  }
  expect(await readFileApplicationMenuProbe()).toEqual([]);
}

async function assertFileOpenApps(filename: string, fixture?: FileApplicationInfo[]) {
  // Office 夹具位于 office/，不能按 CASE_ROOT 根目录查找；必须查询卡片对应的同一个真实文件。
  const filePath = await realpath(
    join(
      CASE_ROOT,
      OFFICE_FILES.some((file) => file.name === filename) ? "office" : "media",
      filename,
    ),
  );
  const expected =
    fixture ??
    (await browser.execute(async (filePath) => {
      const platform = (
        window as unknown as Window & {
          zcode: {
            getFileApplications(target: {
              path: string;
              pathKind: "file";
            }): Promise<FileApplicationInfo[]>;
          };
        }
      ).zcode;
      return platform.getFileApplications({ path: filePath, pathKind: "file" });
    }, filePath));
  const row = await browser.$(`[data-preview-card-title="${filename}"]`);
  await row.$('button[aria-label="Choose app"], button[aria-label="选择打开方式"]').click();
  const menu = await browser.$('[data-slot="dropdown-menu-content"][data-state="open"]');
  await menu.waitForDisplayed();
  try {
    await assertApplicationMenu(menu, expected);
    expect(await menu.getText()).toMatch(/Copy relative path|复制相对路径/);
  } finally {
    await browser.keys("Escape");
  }
}

async function assertLocalHtmlExternalOpen() {
  const openPath = await browser.electron.mock("shell", "openPath");
  await openPath.mockResolvedValue("");
  try {
    const expectedTitle = basename(SOURCE_HTML_RELATIVE_PATH);
    const rows = await browser.$$('[data-zcode-stream-animate="true"]');
    const row = (
      await rows.map(async (candidate) => ({
        candidate,
        text: await candidate.getText(),
      }))
    ).find(({ text }) => text.includes(expectedTitle))?.candidate;
    expect(row).toBeDefined();
    const trigger = await row?.$(
      'button[aria-label="Choose app"], button[aria-label="选择打开方式"]',
    );
    expect(trigger).toBeDefined();
    await trigger?.click();

    await browser.waitUntil(
      async () => {
        const labels = new Set(["Open in browser", "在浏览器中打开"]);
        const items = await browser.$$('[role="menuitem"]');
        const item = (
          await items.map(async (candidate) => ({
            candidate,
            text: await candidate.getText(),
          }))
        ).find(({ text }) => labels.has(text.trim()))?.candidate;
        if (!item) return false;
        await item.click();
        return true;
      },
      { timeout: 10_000, timeoutMsg: "本地 HTML 卡片没有显示外部浏览器入口" },
    );

    await browser.waitUntil(
      async () => {
        try {
          await expect(openPath).toHaveBeenCalledWith(await realpath(SOURCE_HTML_PATH));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, timeoutMsg: "本地 HTML 没有通过 shell.openPath 打开" },
    );
  } finally {
    await browser.electron.restoreAllMocks();
  }
}

async function clickSidePaneToggle() {
  const clicked = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        ["收起侧边面板", "Collapse side pane", "展开侧边面板", "Expand side pane"].includes(
          candidate.getAttribute("aria-label") ?? "",
        ),
    );
    button?.click();
    return Boolean(button);
  });
  expect(clicked).toBe(true);
}

async function waitForSidePaneExpanded(expectedExpanded: boolean) {
  let latestLabel = "";
  await browser.waitUntil(
    async () => {
      latestLabel = await browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) =>
            ["收起侧边面板", "Collapse side pane", "展开侧边面板", "Expand side pane"].includes(
              candidate.getAttribute("aria-label") ?? "",
            ),
        );
        return button?.getAttribute("aria-label") ?? "";
      });
      const isExpanded = ["收起侧边面板", "Collapse side pane"].includes(latestLabel);
      return isExpanded === expectedExpanded;
    },
    {
      timeout: 15_000,
      timeoutMsg: `side pane 展开状态不符合预期: expected=${expectedExpanded}, label=${latestLabel}`,
    },
  );
}

async function waitForBrowserSurface(expectedUrl: string, bodyMarker: string) {
  let latest = { address: "", webContentsId: 0 };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (addressTestId, webviewTestId) => {
          const address = document.querySelector<HTMLInputElement>(
            `[data-testid="${addressTestId}"]`,
          );
          const webview = document.querySelector<HTMLElement>(`[data-testid="${webviewTestId}"]`) as
            | (HTMLElement & { getWebContentsId?: () => number })
            | null;
          return {
            address: address?.value ?? "",
            webContentsId: webview?.getWebContentsId?.() ?? 0,
          };
        },
        TID_BROWSER_ADDRESS_INPUT,
        TID_BROWSER_WEBVIEW,
      );
      return latest.webContentsId > 0 && new URL(latest.address).href === new URL(expectedUrl).href;
    },
    {
      timeout: 60_000,
      timeoutMsg: `Browser Pane 没有打开目标 URL: ${JSON.stringify(latest)}`,
    },
  );

  let latestBody = "";
  await browser.waitUntil(
    async () => {
      latestBody = await browser.electron.execute(async (electron, webContentsId) => {
        const contents = electron.webContents.fromId(webContentsId);
        if (!contents || contents.isDestroyed()) return "";
        return contents.executeJavaScript("document.body?.innerText ?? ''");
      }, latest.webContentsId);
      return latestBody.includes(bodyMarker);
    },
    {
      timeout: 60_000,
      timeoutMsg: `Browser webview 没有加载页面 marker ${bodyMarker}: ${latestBody}`,
    },
  );
}

async function waitForPreviewRenderer(
  filename: string,
  renderer: "docx" | "excel" | "pptx" | "pdf" | "markdown" | "audio" | "video",
) {
  let latest = { hasError: false, header: "", ready: false, text: "" };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (previewTestId, expectedFilename, expectedRenderer) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${previewTestId}"]`);
          const text = (pane?.innerText ?? "").replace(/\u00a0/g, " ");
          const hasError = Boolean(pane?.querySelector('[role="alert"]'));
          let ready = false;
          if (expectedRenderer === "docx" || expectedRenderer === "excel") {
            ready = Boolean(
              pane?.querySelector(`[data-office-preview-kind="${expectedRenderer}"]`),
            );
          } else if (expectedRenderer === "pptx") {
            ready = Boolean(pane?.querySelector("aside[aria-label] button[aria-label]"));
          } else if (expectedRenderer === "pdf") {
            ready = Boolean(pane?.querySelector(".react-pdf__Document .react-pdf__Page"));
          } else if (expectedRenderer === "audio") {
            ready = Boolean(pane?.querySelector("audio[controls]"));
          } else if (expectedRenderer === "video") {
            ready = Boolean(pane?.querySelector("video[controls][playsinline]"));
          } else {
            ready = text.includes("APC05 Markdown renderer marker");
          }
          return {
            hasError,
            // 文件管理器把预览标题 portal 到共同头部；不能在预览正文里找文件名。
            header:
              pane?.closest("[data-file-manager-pane]")?.firstElementChild?.textContent ??
              text.split("\n")[0] ??
              "",
            ready,
            text,
          };
        },
        TID_PREVIEW_PANE,
        filename,
        renderer,
      );
      return !latest.hasError && latest.header.includes(filename) && latest.ready;
    },
    {
      timeout: 90_000,
      timeoutMsg: `Preview Pane renderer 没有就绪: ${filename}/${renderer}; latest=${JSON.stringify(latest)}`,
    },
  );
}

async function assertPreviewVideoSurvivesResizeAndFullscreen() {
  const videoReady = await browser.execute(() => {
    const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
    if (!video) return false;
    const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
    probeWindow.__zcodePreviewVideo = video;
    window.dispatchEvent(new Event("resize"));
    return true;
  });
  expect(videoReady).toBe(true);

  // resize settling 的 state update 应该已经完成；媒体节点不能被替换或卸载。
  await browser.pause(80);
  const sameVideoAfterResize = await browser.execute(() => {
    const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
    return (
      document.querySelector<HTMLVideoElement>("video[controls][playsinline]") ===
      probeWindow.__zcodePreviewVideo
    );
  });
  expect(sameVideoAfterResize).toBe(true);

  const fullscreenResult = await browser.executeAsync((done) => {
    const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
    if (!video?.requestFullscreen) {
      done("unsupported");
      return;
    }
    const finish = () => {
      document.removeEventListener("fullscreenchange", finish);
      done(document.fullscreenElement === video ? "entered" : "not-entered");
    };
    document.addEventListener("fullscreenchange", finish, { once: true });
    void video.requestFullscreen().catch(() => {
      document.removeEventListener("fullscreenchange", finish);
      done("unsupported");
    });
  });
  if (fullscreenResult === "entered") {
    await browser.pause(500);
    const sameVideoInFullscreen = await browser.execute(() => {
      const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
      const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
      return video === probeWindow.__zcodePreviewVideo && document.fullscreenElement === video;
    });
    expect(sameVideoInFullscreen).toBe(true);
    await browser.execute(() => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    });
  }
}

async function assertSourcePreviewTargets() {
  // 整卡点击（标题区域透明按钮）与主按钮路径先后各验证一次，防止整卡可点回归退化为仅按钮可点。
  await clickPreviewCardBody(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
  await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
  await closePreviewPane();

  await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
  await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
  await closePreviewPane();

  await clickPreviewCard(basename(SOURCE_HTML_RELATIVE_PATH));
  await waitForBrowserSurface(new URL(`file://${SOURCE_HTML_PATH}`).href, "APC05_HTML_PAGE");
  await closeSidePanes();
}

async function materializeOfficeFixtures() {
  const officeRoot = join(CASE_ROOT, "office");
  await mkdir(officeRoot, { recursive: true });
  await Promise.all(
    OFFICE_FILES.map((item) =>
      copyFile(join(OFFICE_FIXTURE_ROOT, item.fixture), join(officeRoot, item.name)),
    ),
  );
}

async function materializeMediaFixtures() {
  const mediaRoot = join(CASE_ROOT, "media");
  await mkdir(mediaRoot, { recursive: true });
  const videoFixture = await readFile(
    new URL("../fixtures/media/sample-video.mp4", import.meta.url),
  );
  const largeVideo = Buffer.concat([
    videoFixture,
    Buffer.alloc(Math.max(0, 8 * 1024 * 1024 + 1 - videoFixture.length)),
  ]);
  const wav = Buffer.alloc(45);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(37, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(1, 40);
  wav[44] = 128;
  await Promise.all([
    writeFile(join(mediaRoot, "生成 视频.mp4"), largeVideo),
    writeFile(join(mediaRoot, "生成 音频.wav"), wav),
  ]);
  expect((await stat(join(mediaRoot, "生成 视频.mp4"))).size).toBeGreaterThan(8 * 1024 * 1024);
}

async function materializeStaleSourceFiles() {
  const staleRoot = join(CASE_ROOT, "stale");
  await mkdir(staleRoot, { recursive: true });
  await Promise.all([
    writeFile(join(staleRoot, "旧 页面.html"), "<p>stale html</p>", "utf8"),
    writeFile(join(staleRoot, "旧 说明.md"), "stale markdown", "utf8"),
  ]);
}

async function assertLocalMediaPreviewLogs(snapshot: Map<string, number>): Promise<void> {
  const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
  if (!runtimeLogDir) {
    throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
  }

  let desktopLogs = "";
  await browser.waitUntil(
    async () => {
      desktopLogs = await readDesktopRuntimeLogsSince(runtimeLogDir, snapshot);
      return (
        desktopLogs.includes("[rpc:call] media-preview.prepare OK") &&
        desktopLogs.includes("local media preview path authorization OK")
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `本地媒体预览日志没有完成: ${desktopLogs}`,
    },
  );
  expect(desktopLogs).not.toContain("[rpc:call] file.readMediaPreview");
}

async function snapshotDesktopRuntimeLogs(): Promise<Map<string, number>> {
  const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
  if (!runtimeLogDir) {
    throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
  }
  const entries = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
  const snapshot = new Map<string, number>();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => {
        snapshot.set(entry.name, (await stat(join(runtimeLogDir, entry.name))).size);
      }),
  );
  return snapshot;
}

async function readDesktopRuntimeLogsSince(
  runtimeLogDir: string,
  snapshot: Map<string, number>,
): Promise<string> {
  const entries = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => entry.name)
    .sort();
  const contents = await Promise.all(
    logFiles.map(async (fileName) => {
      const content = await readFile(join(runtimeLogDir, fileName));
      const offset = Math.min(snapshot.get(fileName) ?? 0, content.byteLength);
      return content.subarray(offset).toString("utf8");
    }),
  );
  return contents.join("\n");
}

async function materializeBoundFiles() {
  const boundsRoot = join(CASE_ROOT, "bounds");
  await mkdir(boundsRoot, { recursive: true });
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      writeFile(
        join(boundsRoot, `max-${String(index + 1).padStart(2, "0")}.pdf`),
        "exists",
        "utf8",
      ),
    ),
    writeFile(join(boundsRoot, "nofill-01.pdf"), "excluded existing candidate", "utf8"),
    ...Array.from({ length: 9 }, (_, index) =>
      writeFile(
        join(boundsRoot, `nofill-${String(index + 8).padStart(2, "0")}.pdf`),
        "exists",
        "utf8",
      ),
    ),
  ]);
}

async function closePreviewPane() {
  // Bug 根因：PreviewPane 自身没有关闭按钮，关闭动作属于外层 side-pane tab。
  // 必须关闭当前激活 tab 并等待旧 pane 卸载，否则下一次点击卡片仍会看到旧 renderer。
  const closed = await browser.execute(() => {
    const activeTab = document.querySelector<HTMLElement>("[data-side-pane-tab-id][data-active]");
    const closeButton = activeTab?.querySelector<HTMLButtonElement>("button");
    closeButton?.click();
    return Boolean(closeButton);
  });
  expect(closed).toBe(true);
  await browser.waitUntil(
    async () =>
      !(await browser.execute(
        (previewTestId) => Boolean(document.querySelector(`[data-testid="${previewTestId}"]`)),
        TID_PREVIEW_PANE,
      )),
    {
      timeout: 10_000,
      timeoutMsg: "Preview Pane 点击关闭后没有卸载",
    },
  );
}

async function closeSidePanes() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const tab =
          document.querySelector<HTMLElement>("[data-side-pane-tab-id][data-active]") ??
          document.querySelector<HTMLElement>("[data-side-pane-tab-id]");
        const closeButton = tab?.querySelector<HTMLButtonElement>("button");
        if (!closeButton) return true;
        closeButton.click();
        return false;
      }),
    {
      interval: 100,
      timeout: 10_000,
      timeoutMsg: "Assistant Preview Cards 清理 side pane tabs 超时",
    },
  );
}

function createFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><html><head><title>APC01 Local Preview</title></head><body>APC01_LOCAL_URL_PAGE</body></html>",
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/assistant-preview`;
}

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function waitForPreviewCardSet(expectedTitles: readonly string[], timeout = 60_000) {
  const expected = [...expectedTitles].sort();
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = (await readPreviewCards(expectedTitles)).map((card) => card.title).sort();
      return JSON.stringify(latest) === JSON.stringify(expected);
    },
    {
      timeout,
      timeoutMsg: `预览卡片集合没有收敛: expected=${JSON.stringify(expected)} latest=${JSON.stringify(latest)}`,
    },
  );
}

type OpenMenuSlot = "context-menu" | "dropdown-menu";

async function readOpenMenuLabels(slot: OpenMenuSlot) {
  const menu = await browser.$(`[data-slot="${slot}-content"][data-state="open"]`);
  await menu.waitForDisplayed();
  return menu.$$('[role="menuitem"]').map(async (item) => (await item.getText()).trim());
}

async function clickOpenMenuItem(slot: OpenMenuSlot, label: RegExp) {
  const menuSelector = `[data-slot="${slot}-content"][data-state="open"]`;
  expect(await readOpenMenuLabels(slot)).toContainEqual(expect.stringMatching(label));
  // 菜单弹出动画期间的点击会被 Radix 吞掉（不触发 onSelect，下拉还会直接关闭），等动画结束再点。
  await browser.waitUntil(
    () =>
      browser.execute((selector) => {
        const menu = document.querySelector(selector);
        return Boolean(
          menu?.getAnimations({ subtree: true }).every((item) => item.playState !== "running"),
        );
      }, menuSelector),
    { timeout: 5_000, timeoutMsg: `${slot} 打开动画没有结束` },
  );
  // 关联应用列表异步加载，「加载中」占位行会在读取标签后消失；点击前按文字重新定位，不能复用旧序号。
  const items = await browser.$$(`${menuSelector} [role="menuitem"]`);
  for (const item of items) {
    if (label.test((await item.getText()).trim())) {
      await item.click();
      return;
    }
  }
  throw new Error(`${slot} 中找不到菜单项 ${label}`);
}

interface FileManagerRevealCall {
  channel: "OpenInFileManager" | "OpenInEditor";
  path: string;
  editorId?: string;
  pathKind?: string;
}

/**
 * 只在隔离 E2E 主进程替换「在文件管理器中打开」的两条 IPC，记录参数，不真的拉起 Finder：
 * macOS / Windows 走 OpenInEditor（finder / explorer 定位并选中文件），失败或 Linux 回退 OpenInFileManager（打开目录）。
 */
async function installFileManagerRevealProbe() {
  await browser.electron.execute(
    (electron, channels) => {
      type Handler = (...args: unknown[]) => unknown;
      const scope = globalThis as unknown as {
        __apcFileManagerReveal?: { calls: FileManagerRevealCall[]; restore(): void };
      };
      if (scope.__apcFileManagerReveal)
        throw new Error("File manager reveal probe already installed");
      const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const openDirectory = handlers.get(channels.openInFileManager);
      const openInEditor = handlers.get(channels.openInEditor);
      if (!openDirectory || !openInEditor) throw new Error("File manager IPC handlers unavailable");
      const probe = {
        calls: [] as FileManagerRevealCall[],
        restore() {
          handlers.set(channels.openInFileManager, openDirectory);
          handlers.set(channels.openInEditor, openInEditor);
          delete scope.__apcFileManagerReveal;
        },
      };
      handlers.set(channels.openInFileManager, (_event, path) => {
        probe.calls.push({ channel: "OpenInFileManager", path: String(path) });
        return { success: true };
      });
      handlers.set(channels.openInEditor, (_event, payload) => {
        const request = payload as {
          editorId: string;
          path: string;
          options?: { pathKind?: string };
        };
        probe.calls.push({
          channel: "OpenInEditor",
          editorId: request.editorId,
          path: request.path,
          pathKind: request.options?.pathKind,
        });
        return { success: true };
      });
      scope.__apcFileManagerReveal = probe;
    },
    {
      openInFileManager: PlatformChannels.OpenInFileManager,
      openInEditor: PlatformChannels.OpenInEditor,
    },
  );
}

async function readFileManagerRevealCalls(): Promise<FileManagerRevealCall[]> {
  return browser.electron.execute(
    () =>
      (globalThis as unknown as { __apcFileManagerReveal?: { calls: FileManagerRevealCall[] } })
        .__apcFileManagerReveal?.calls ?? [],
  );
}

async function restoreFileManagerRevealProbe() {
  await browser.electron.execute(() =>
    (
      globalThis as unknown as { __apcFileManagerReveal?: { restore(): void } }
    ).__apcFileManagerReveal?.restore(),
  );
}

/** macOS：每次点击只发一次 finder 定位请求，目标是文件本身（Finder 打开所在目录并选中它）。 */
async function expectFinderRevealCalls(expectedFiles: string[]) {
  let calls: FileManagerRevealCall[] = [];
  // timeoutMsg 在调用时就求值，只能反映初始空数组；超时后用最后一次读到的 calls 重新报错。
  await browser
    .waitUntil(
      async () => {
        calls = await readFileManagerRevealCalls();
        return calls.length === expectedFiles.length;
      },
      { timeout: 10_000 },
    )
    .catch(() => {
      throw new Error(
        `文件管理器定位调用次数不符: expected=${expectedFiles.length} calls=${JSON.stringify(calls)}`,
      );
    });
  expect(calls.map(({ channel, editorId, pathKind }) => ({ channel, editorId, pathKind }))).toEqual(
    expectedFiles.map(() => ({ channel: "OpenInEditor", editorId: "finder", pathKind: "file" })),
  );
  // renderer 传的是工作区内路径，可能未解析 /var → /private/var 等软链；按真实路径比对。
  expect(await Promise.all(calls.map(({ path }) => realpath(path)))).toEqual(expectedFiles);
}

/** 正文 Markdown 文件链接按钮的 title 是渲染层解析出的路径（与传给 IPC 的路径一致）；按可见文案读取。 */
async function findBodyFileLinkPath(label: string): Promise<string> {
  let path = "";
  await browser.waitUntil(
    async () => {
      path = await browser.execute((text) => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button[title]"),
        ).find((item) => (item.textContent ?? "").trim() === text);
        return button?.title ?? "";
      }, label);
      return path.length > 0;
    },
    { timeout: 30_000, timeoutMsg: `正文没有渲染文件链接 ${label}` },
  );
  return path;
}

interface BodyLinkMenuOrder {
  lastApplication: number;
  loading: boolean;
  reveal: number;
  revealCount: number;
  saveAs: number;
}

/** 正文链接右键菜单：stat 与关联应用异步加载，按调用方给的就绪条件轮询后返回各分组位置。 */
async function readBodyLinkMenuOrder(
  ready: (order: BodyLinkMenuOrder) => boolean,
): Promise<BodyLinkMenuOrder> {
  const menuSelector = '[data-slot="context-menu-content"][data-state="open"]';
  await browser.$(menuSelector).waitForDisplayed();
  let order: BodyLinkMenuOrder | null = null;
  await browser
    .waitUntil(
      async () => {
        order = await browser.execute(
          (selector, labelSource) => {
            const items = Array.from(
              document
                .querySelector(selector)
                ?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
            );
            const label = new RegExp(labelSource);
            const text = (item: HTMLElement) => item.textContent?.trim() ?? "";
            const appIndexes = items
              .map((item, position) =>
                item.matches("[data-file-application-direct], .file-application-more-trigger") ||
                /Open with default app|使用默认应用打开/.test(text(item))
                  ? position
                  : -1,
              )
              .filter((position) => position >= 0);
            return {
              lastApplication: appIndexes.at(-1) ?? -1,
              loading: items.some((item) => /^(Loading|加载中)[….]*$/.test(text(item))),
              reveal: items.findIndex((item) => label.test(text(item))),
              revealCount: items.filter((item) => label.test(text(item))).length,
              saveAs: items.findIndex((item) => /^(Save as|另存为)/i.test(text(item))),
            };
          },
          menuSelector,
          REVEAL_IN_FINDER_LABEL.source,
        );
        return ready(order);
      },
      { timeout: 10_000 },
    )
    .catch(() => {
      throw new Error(`正文链接右键菜单没有就绪: ${JSON.stringify(order)}`);
    });
  return order!;
}
