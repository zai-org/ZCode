import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { restartWithSeededOpenAIProviders } from "#e2e/helpers/custom-openai-provider";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-markdown-table-layout";
const MODEL_ID = "e2e-markdown-table-layout-model";
const PROVIDER_ID = "e2e-markdown-table-layout-provider";
const PROVIDER_NAME = "Markdown Table Layout E2E";
const SMALL_TABLE_MARKER = "E2E_MARKDOWN_TABLE_SMALL";
const LARGE_TABLE_MARKER = "E2E_MARKDOWN_TABLE_LARGE";
const LARGE_TABLE_ROW_COUNT = 100;
const LARGE_TABLE_EXPECTED_FRAGMENTS = [
  LARGE_TABLE_MARKER,
  "Large Row 050",
  "Large Row 100",
  "Column 14 row 100 value",
];

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

interface MarkdownTableLayoutSnapshot {
  exists: boolean;
  hasContainerMinFullClass: boolean;
  hasFrameBorderClass: boolean;
  hasFrameRoundedClass: boolean;
  viewportClientWidth: number;
  viewportScrollWidth: number;
  containerScrollWidth: number;
  tableScrollWidth: number;
  bodyRowCount: number;
  scrollLeft: number;
  canScroll: boolean;
  pageHasHorizontalOverflow: boolean;
  viewportClassName: string;
  containerClassName: string;
  tableClassName: string;
  actionLabels: string[];
}

interface MarkdownTableActionState {
  copiedText: string | null;
  downloads: Array<{
    clicked: boolean;
    fileName: string | null;
    href: string;
    text: string | null;
    type: string;
  }>;
}

interface MarkdownTablePreviewSnapshot {
  exists: boolean;
  text: string;
  headerPosition: string;
  headerBackdropFilter: string;
  viewportClientWidth: number;
  viewportScrollWidth: number;
  viewportClientHeight: number;
  viewportScrollHeight: number;
  viewportScrollLeft: number;
  viewportScrollTop: number;
  canScrollHorizontally: boolean;
  canScrollVertically: boolean;
  tableClassName: string;
}

describe("会话区 Markdown Table Layout E2E", () => {
  before(async function () {
    this.timeout(240000);
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
    await prepareMarkdownTableReplayConversation();
    await renderSmallMarkdownTableCase();
    await renderLargeMarkdownTableCase();
  });

  afterEach(async () => {
    await browser.electron.restoreAllMocks();
  });

  after(async () => {
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("小表格不横向滚动且复制可用", async function () {
    this.timeout(160000);

    await expectSmallMarkdownTableLayout();
    await expectMarkdownTableCopy(SMALL_TABLE_MARKER);
  });

  it("小表格不横向滚动且下载按钮可用", async function () {
    this.timeout(160000);

    await expectSmallMarkdownTableLayout();
    await expectMarkdownTableDownload(SMALL_TABLE_MARKER);
  });

  it("小表格不横向滚动且预览可用", async function () {
    this.timeout(160000);

    await expectSmallMarkdownTableLayout();
    await expectMarkdownTablePreview(SMALL_TABLE_MARKER);
  });

  it("大表格在表格 viewport 内横向滚动且复制可用", async function () {
    this.timeout(160000);

    await expectLargeMarkdownTableLayout();
    await expectMarkdownTableCopy(LARGE_TABLE_MARKER, LARGE_TABLE_EXPECTED_FRAGMENTS);
  });

  it("大表格在表格 viewport 内横向滚动且下载按钮可用", async function () {
    this.timeout(160000);

    await expectLargeMarkdownTableLayout();
    await expectMarkdownTableDownload(LARGE_TABLE_MARKER, LARGE_TABLE_EXPECTED_FRAGMENTS);
  });

  it("大表格预览内可以横向和纵向滚动", async function () {
    this.timeout(160000);

    await expectLargeMarkdownTableLayout();
    await expectMarkdownTablePreview(LARGE_TABLE_MARKER, LARGE_TABLE_EXPECTED_FRAGMENTS, {
      expectScrollablePreview: true,
    });
  });
});

async function prepareMarkdownTableReplayConversation() {
  // 修复原因：表格布局 case 只验证 completed assistant markdown 的渲染合同。
  // 使用 case-local OpenAI-compatible replay provider 模拟 SSE，避免真实模型不稳定。
  // 修复原因：运行中经设置页创建 provider 只等待本地配置落盘，active workspace
  // registry 可能尚未刷新，首条消息仍会发给旧模型。停掉旧 Host/Agent 后同时 seed
  // App 与 CLI 配置，再重启并选择模型，保证 UI 与真实请求使用同一个 replay provider。
  // 修复原因：WDIO beforeSession 已经为每个 spec 重置隔离 HOME；在 spec before
  // 内再次 clearAppData 会杀掉当前 WebDriver 连接的 Electron，后续准备步骤只能拿死 session 超时。
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  const [provider] = await restartWithSeededOpenAIProviders([
    {
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
    },
  ]);
  if (!provider) throw new Error("Markdown table layout replay provider seed 失败");
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  await selectUpstreamProviderModelById(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName: provider.name,
  });
  await waitForUpstreamModelSelected(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
}

async function renderSmallMarkdownTableCase() {
  const marker = SMALL_TABLE_MARKER;

  await sendV4Prompt(
    `${marker}: 请只回复一个 Markdown 表格，不要解释，不要放进代码块。表头是 Name 和 Value，唯一数据行的 Name 是 ${marker}，Value 是 ok。`,
  );
  await waitForV4ComposerText("", "小表格 prompt 发送后输入框没有清空");
  await waitForV4UserMessageContaining(marker);
  await waitForV4AssistantMessageContaining(marker);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "小表格完成后会话没有回到 idle",
    90000,
  );
}

async function expectSmallMarkdownTableLayout() {
  const snapshot = await waitForMarkdownTableLayout(
    SMALL_TABLE_MARKER,
    (candidate) => candidate.exists && candidate.tableScrollWidth > 0,
    "小表格没有渲染出 markdown table",
  );

  expect(snapshot.canScroll).toBe(false);
  expect(snapshot.pageHasHorizontalOverflow).toBe(false);
  expectMarkdownTableViewportFrame(snapshot);
  expectMarkdownTableActionLabels(snapshot.actionLabels);
}

async function renderLargeMarkdownTableCase() {
  const marker = LARGE_TABLE_MARKER;

  await sendV4Prompt(buildLargeTablePrompt(marker));
  await waitForV4ComposerText("", "大表格 prompt 发送后输入框没有清空");
  await waitForV4UserMessageContaining(marker);
  await waitForV4AssistantMessageContaining(marker);
  await waitForV4AssistantMessageContaining("Large Row 100");
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "大表格完成后会话没有回到 idle",
    90000,
  );
}

async function expectLargeMarkdownTableLayout() {
  const snapshot = await waitForMarkdownTableLayout(
    LARGE_TABLE_MARKER,
    (candidate) => candidate.exists && candidate.canScroll,
    "大表格没有进入横向滚动状态",
    60000,
  );
  const scrollLeft = await scrollMarkdownTableViewportContaining(LARGE_TABLE_MARKER, 120);

  expect(snapshot.hasContainerMinFullClass).toBe(true);
  expectMarkdownTableViewportFrame(snapshot);
  expect(snapshot.viewportScrollWidth).toBeGreaterThan(snapshot.viewportClientWidth);
  expect(snapshot.bodyRowCount).toBe(LARGE_TABLE_ROW_COUNT);
  expect(scrollLeft).toBeGreaterThan(0);
  expect(snapshot.pageHasHorizontalOverflow).toBe(false);
  expectMarkdownTableActionLabels(snapshot.actionLabels);
}

function buildLargeTablePrompt(marker: string) {
  const headers = Array.from({ length: 14 }, (_, index) => `Column ${index + 1}`);

  return `${marker}: 请只回复一个 Markdown 表格，不要解释，不要放进代码块。表头依次是 ${headers.join("、")}；返回 ${LARGE_TABLE_ROW_COUNT} 行数据，第一行第一列是 ${marker}，第 50 行第一列是 Large Row 050，第 100 行第一列是 Large Row 100，其余列填入对应列名和行号。`;
}

function expectMarkdownTableViewportFrame(snapshot: MarkdownTableLayoutSnapshot) {
  expect(snapshot.hasContainerMinFullClass).toBe(true);
  expect(snapshot.hasFrameBorderClass).toBe(true);
  expect(snapshot.hasFrameRoundedClass).toBe(true);
}

async function waitForMarkdownTableLayout(
  marker: string,
  predicate: (snapshot: MarkdownTableLayoutSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: MarkdownTableLayoutSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getMarkdownTableLayout(marker);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getMarkdownTableLayout(marker);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }

  return getMarkdownTableLayout(marker);
}

function getMarkdownTableLayout(marker: string): Promise<MarkdownTableLayoutSnapshot> {
  return browser.execute((markerText) => {
    const tables = Array.from(
      document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
    );
    const table = tables.find((candidate) =>
      (candidate.innerText || candidate.textContent || "").includes(markerText),
    );
    const viewport = table?.parentElement;
    const visualFrame = viewport?.parentElement;
    let root: HTMLElement | null = table ?? null;
    while (root && !root.querySelector("[data-markdown-table-toolbar]")) {
      root = root.parentElement;
    }

    if (!table || !viewport || !visualFrame) {
      return {
        exists: false,
        hasContainerMinFullClass: false,
        hasFrameBorderClass: false,
        hasFrameRoundedClass: false,
        viewportClientWidth: 0,
        viewportScrollWidth: 0,
        containerScrollWidth: 0,
        tableScrollWidth: 0,
        bodyRowCount: 0,
        scrollLeft: 0,
        canScroll: false,
        pageHasHorizontalOverflow: false,
        viewportClassName: "",
        containerClassName: "",
        tableClassName: "",
        actionLabels: [],
      };
    }

    const documentElement = document.documentElement;
    const viewportClassName = viewport.getAttribute("class") ?? "";
    const visualFrameClassName = visualFrame.getAttribute("class") ?? "";
    const tableClassName = table.getAttribute("class") ?? "";
    const containerClassName = tableClassName;
    const actionLabels = Array.from(
      root?.querySelectorAll<HTMLButtonElement>("[data-markdown-table-toolbar] button") ?? [],
    )
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter(Boolean);

    return {
      exists: true,
      hasContainerMinFullClass: containerClassName.includes("min-w-full"),
      hasFrameBorderClass:
        visualFrameClassName.includes("border") && visualFrameClassName.includes("border-border"),
      hasFrameRoundedClass: visualFrameClassName.includes("rounded-xl"),
      viewportClientWidth: viewport.clientWidth,
      viewportScrollWidth: viewport.scrollWidth,
      containerScrollWidth: table.scrollWidth,
      tableScrollWidth: table.scrollWidth,
      bodyRowCount: table.querySelectorAll("tbody tr").length,
      scrollLeft: viewport.scrollLeft,
      canScroll: viewport.scrollWidth > viewport.clientWidth + 1,
      pageHasHorizontalOverflow: documentElement.scrollWidth > documentElement.clientWidth + 2,
      viewportClassName,
      containerClassName,
      tableClassName,
      actionLabels,
    };
  }, marker);
}

function scrollMarkdownTableViewportContaining(marker: string, left: number) {
  return browser.execute(
    (markerText, scrollLeft) => {
      const table = Array.from(
        document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
      ).find((candidate) =>
        (candidate.innerText || candidate.textContent || "").includes(markerText),
      );
      const viewport = table?.parentElement;
      if (!viewport) {
        return 0;
      }
      viewport.scrollLeft = scrollLeft;
      return viewport.scrollLeft;
    },
    marker,
    left,
  );
}

async function expectMarkdownTableCopy(marker: string, expectedFragments = [marker]) {
  await installMarkdownTableActionSpies();

  const copied = await clickMarkdownTableAction(marker, ["复制 Markdown", "Copy Markdown"]);
  expect(copied).toBe(true);
  await browser.waitUntil(
    async () => {
      const state = await getMarkdownTableActionState();
      return Boolean(state.copiedText?.includes(marker));
    },
    {
      timeout: 10000,
      timeoutMsg: `表格复制动作没有写入 marker=${marker} 的 Markdown`,
    },
  );
  const copiedState = await getMarkdownTableActionState();
  for (const fragment of expectedFragments) {
    expect(copiedState.copiedText).toContain(fragment);
  }
}

async function expectMarkdownTableDownload(marker: string, expectedFragments = [marker]) {
  await installMarkdownTableActionSpies();

  const downloaded = await clickMarkdownTableAction(marker, ["下载 CSV", "Download CSV"]);
  expect(downloaded).toBe(true);
  await browser.waitUntil(
    async () => {
      const state = await getMarkdownTableActionState();
      return state.downloads.some(
        (download) => download.clicked && download.text?.includes(marker),
      );
    },
    {
      timeout: 10000,
      timeoutMsg: `表格下载动作没有生成 marker=${marker} 的 CSV`,
    },
  );
  const downloadState = await getMarkdownTableActionState();
  const download = downloadState.downloads.find((candidate) => candidate.text?.includes(marker));
  expect(download?.clicked).toBe(true);
  expect(download?.fileName).toBe("table.csv");
  expect(download?.type).toBe("text/csv;charset=utf-8");
  for (const fragment of expectedFragments) {
    expect(download?.text).toContain(fragment);
  }
}

async function expectMarkdownTablePreview(
  marker: string,
  expectedFragments = [marker],
  options: { expectScrollablePreview?: boolean } = {},
) {
  await openMarkdownTablePreview(marker);
  const preview = await waitForMarkdownTablePreview(marker);
  for (const fragment of expectedFragments) {
    expect(preview.text).toContain(fragment);
  }
  expect(preview.headerPosition).toBe("sticky");
  expect(preview.headerBackdropFilter === "" || preview.headerBackdropFilter === "none").toBe(true);

  if (options.expectScrollablePreview) {
    expect(preview.canScrollHorizontally).toBe(true);
    expect(preview.canScrollVertically).toBe(true);

    const scrolledPreview = await scrollMarkdownTablePreview(120, 160);
    expect(scrolledPreview.viewportScrollLeft).toBeGreaterThan(0);
    expect(scrolledPreview.viewportScrollTop).toBeGreaterThan(0);
    expect(scrolledPreview.headerPosition).toBe("sticky");
    expect(
      scrolledPreview.headerBackdropFilter === "" ||
        scrolledPreview.headerBackdropFilter === "none",
    ).toBe(true);
  }

  await closeMarkdownTablePreview();
}

async function openMarkdownTablePreview(marker: string) {
  const previewOpened = await clickMarkdownTableAction(marker, ["预览表格", "Preview table"]);
  expect(previewOpened).toBe(true);

  await browser.waitUntil(
    async () => {
      const preview = await getMarkdownTablePreview(marker);
      return preview.exists;
    },
    {
      timeout: 10000,
      timeoutMsg: `没有打开 marker=${marker} 的表格预览弹窗`,
    },
  );
}

function expectMarkdownTableActionLabels(labels: string[]) {
  const labelSet = new Set(labels);
  expect(labelSet.has("复制 Markdown") || labelSet.has("Copy Markdown")).toBe(true);
  expect(labelSet.has("下载 CSV") || labelSet.has("Download CSV")).toBe(true);
  expect(labelSet.has("预览表格") || labelSet.has("Preview table")).toBe(true);
}

function installMarkdownTableActionSpies(): Promise<void> {
  return browser.execute(() => {
    type DownloadEntry = {
      clicked: boolean;
      fileName: string | null;
      href: string;
      text: string | null;
      type: string;
    };
    type MarkdownTableE2EWindow = Window & {
      __markdownTableE2E?: {
        copiedText: string | null;
        downloads: DownloadEntry[];
      };
    };

    const targetWindow = window as MarkdownTableE2EWindow;
    targetWindow.__markdownTableE2E = {
      copiedText: null,
      downloads: [],
    };

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          targetWindow.__markdownTableE2E!.copiedText = value;
        },
      },
    });

    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (!(object instanceof Blob)) {
        return originalCreateObjectURL(object);
      }
      const entry: DownloadEntry = {
        clicked: false,
        fileName: null,
        href: `blob:e2e-markdown-table-${targetWindow.__markdownTableE2E!.downloads.length}`,
        text: null,
        type: object.type,
      };
      targetWindow.__markdownTableE2E!.downloads.push(entry);
      void object.text().then((text) => {
        entry.text = text;
      });
      return entry.href;
    };
    URL.revokeObjectURL = () => undefined;

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function clickAnchor() {
      const state = targetWindow.__markdownTableE2E;
      const download = state?.downloads.find((candidate) => candidate.href === this.href);
      if (download) {
        download.clicked = true;
        download.fileName = this.download;
        return;
      }
      return originalClick.call(this);
    };
  });
}

function getMarkdownTableActionState(): Promise<MarkdownTableActionState> {
  return browser.execute(() => {
    type MarkdownTableE2EWindow = Window & {
      __markdownTableE2E?: MarkdownTableActionState;
    };
    const targetWindow = window as MarkdownTableE2EWindow;
    return (
      targetWindow.__markdownTableE2E ?? {
        copiedText: null,
        downloads: [],
      }
    );
  });
}

function clickMarkdownTableAction(marker: string, labels: string[]) {
  return browser.execute(
    (markerText, expectedLabels) => {
      // 修复原因：同一 spec 内复制、下载、预览会复用相同 marker。
      // 旧任务 DOM 仍可能短暂保留，选择当前可见的匹配表格才能操作本 case 刚生成的表格。
      const matchingTables = Array.from(
        document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
      ).filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          (candidate.innerText || candidate.textContent || "").includes(markerText)
        );
      });
      const table = matchingTables.at(-1);
      let root: HTMLElement | null = table ?? null;
      while (root && !root.querySelector("[data-markdown-table-toolbar]")) {
        root = root.parentElement;
      }
      const button = Array.from(
        root?.querySelectorAll<HTMLButtonElement>("[data-markdown-table-toolbar] button") ?? [],
      ).find((candidate) => expectedLabels.includes(candidate.getAttribute("aria-label") ?? ""));
      button?.click();
      return Boolean(button);
    },
    marker,
    labels,
  );
}

async function waitForMarkdownTablePreview(marker: string) {
  let latest: MarkdownTablePreviewSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getMarkdownTablePreview(marker);
        return latest.exists;
      },
      {
        timeout: 10000,
        timeoutMsg: `没有打开 marker=${marker} 的表格预览弹窗`,
      },
    );
  } catch (error) {
    latest = await getMarkdownTablePreview(marker);
    throw new Error(`没有打开 marker=${marker} 的表格预览弹窗; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getMarkdownTablePreview(marker);
}

function getMarkdownTablePreview(marker: string): Promise<MarkdownTablePreviewSnapshot> {
  return browser.execute((markerText) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const table = dialog?.querySelector<HTMLTableElement>('table[data-streamdown="table-preview"]');
    const text = table?.innerText || table?.textContent || "";
    const header = table?.querySelector<HTMLTableCellElement>("th");
    const headerStyle = header ? getComputedStyle(header) : null;
    const headerBackdropFilter =
      headerStyle?.backdropFilter ||
      (headerStyle as (CSSStyleDeclaration & { webkitBackdropFilter?: string }) | null)
        ?.webkitBackdropFilter ||
      "";
    const scrollAncestors: HTMLElement[] = [];
    let node = table?.parentElement ?? null;
    while (node && node !== dialog?.parentElement) {
      scrollAncestors.push(node);
      if (node === dialog) {
        break;
      }
      node = node.parentElement;
    }
    const horizontalViewport = scrollAncestors.find(
      (candidate) => candidate.scrollWidth > candidate.clientWidth + 1,
    );
    const verticalViewport = scrollAncestors.find(
      (candidate) => candidate.scrollHeight > candidate.clientHeight + 1,
    );

    return {
      exists: Boolean(table && text.includes(markerText)),
      text,
      headerPosition: headerStyle?.position ?? "",
      headerBackdropFilter,
      viewportClientWidth: horizontalViewport?.clientWidth ?? 0,
      viewportScrollWidth: horizontalViewport?.scrollWidth ?? 0,
      viewportClientHeight: verticalViewport?.clientHeight ?? 0,
      viewportScrollHeight: verticalViewport?.scrollHeight ?? 0,
      viewportScrollLeft: horizontalViewport?.scrollLeft ?? 0,
      viewportScrollTop: verticalViewport?.scrollTop ?? 0,
      canScrollHorizontally: Boolean(horizontalViewport),
      canScrollVertically: Boolean(verticalViewport),
      tableClassName: table?.getAttribute("class") ?? "",
    };
  }, marker);
}

function scrollMarkdownTablePreview(
  left: number,
  top: number,
): Promise<MarkdownTablePreviewSnapshot> {
  return browser.execute(
    (scrollLeft, scrollTop) => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const table = dialog?.querySelector<HTMLTableElement>(
        'table[data-streamdown="table-preview"]',
      );
      const text = table?.innerText || table?.textContent || "";
      const header = table?.querySelector<HTMLTableCellElement>("th");
      const headerStyle = header ? getComputedStyle(header) : null;
      const headerBackdropFilter =
        headerStyle?.backdropFilter ||
        (headerStyle as (CSSStyleDeclaration & { webkitBackdropFilter?: string }) | null)
          ?.webkitBackdropFilter ||
        "";
      const scrollAncestors: HTMLElement[] = [];
      let node = table?.parentElement ?? null;
      while (node && node !== dialog?.parentElement) {
        scrollAncestors.push(node);
        if (node === dialog) {
          break;
        }
        node = node.parentElement;
      }
      const horizontalViewport = scrollAncestors.find(
        (candidate) => candidate.scrollWidth > candidate.clientWidth + 1,
      );
      const verticalViewport = scrollAncestors.find(
        (candidate) => candidate.scrollHeight > candidate.clientHeight + 1,
      );
      if (horizontalViewport) {
        horizontalViewport.scrollLeft = scrollLeft;
      }
      if (verticalViewport) {
        verticalViewport.scrollTop = scrollTop;
      }

      return {
        exists: Boolean(table),
        text,
        headerPosition: headerStyle?.position ?? "",
        headerBackdropFilter,
        viewportClientWidth: horizontalViewport?.clientWidth ?? 0,
        viewportScrollWidth: horizontalViewport?.scrollWidth ?? 0,
        viewportClientHeight: verticalViewport?.clientHeight ?? 0,
        viewportScrollHeight: verticalViewport?.scrollHeight ?? 0,
        viewportScrollLeft: horizontalViewport?.scrollLeft ?? 0,
        viewportScrollTop: verticalViewport?.scrollTop ?? 0,
        canScrollHorizontally: Boolean(horizontalViewport),
        canScrollVertically: Boolean(verticalViewport),
        tableClassName: table?.getAttribute("class") ?? "",
      };
    },
    left,
    top,
  );
}

async function closeMarkdownTablePreview() {
  await browser.keys("Escape").catch(() => undefined);
  await browser.waitUntil(
    async () =>
      browser.execute(() => !document.querySelector('table[data-streamdown="table-preview"]')),
    {
      timeout: 5000,
      timeoutMsg: "表格预览弹窗没有关闭",
    },
  );
}
