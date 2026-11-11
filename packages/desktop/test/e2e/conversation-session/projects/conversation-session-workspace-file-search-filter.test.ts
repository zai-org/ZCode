import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E, setV4ComposerText } from "#e2e/helpers/v4-conversation";

// E2E case for catalog SFF01（Workspace File Search Default Filter）。
// 验证 @ 文件候选默认过滤矩阵在真实 Electron Desktop 上的可见性边界：
//   - 隐藏目录后代可搜：.github/workflows/<marker>.yml 出现
//   - 过宽目录放开：build/<marker>.txt 出现
//   - .env.* 默认排除：.env.<marker> 不出现
//   - node_modules 默认排除：node_modules/<pkg>/<marker>.js 不出现
// 过滤 authority 完全在 service 层（packages/services/src/file/workspaceFileMentionFilter.ts），
// UI 不维护第二份黑名单；本 spec 只取证最终用户可见矩阵，不触发 provider 请求。
const TEST_TIMEOUT_MS = 120000;
const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

const createdPaths: string[] = [];

interface PanelOptionSnapshot {
  id: string | null;
  index: number;
  sectionId: string | null;
  selected: boolean;
  text: string;
}

interface PanelSnapshot {
  options: PanelOptionSnapshot[];
  statuses: Array<{ sectionId: string | null; status: string | null; text: string }>;
  trigger: string | null;
}

describe("会话区 Workspace 文件搜索默认过滤矩阵 E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await prepareV4ConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);

    // 原因：全局新草稿可继承其它项目；搜索 fixture 必须绑定其实际项目。
    await startDraftFromProject(DEFAULT_WORKSPACE);
  });

  after(async () => {
    await Promise.all(
      createdPaths.map((targetPath) => rm(targetPath, { recursive: true, force: true })),
    );
    await browser.electron.restoreAllMocks();
  });

  it("@ files 候选默认过滤：隐藏目录后代可搜、build 放开、node_modules 与 .env 排除", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    // 唯一 marker 防止跨 spec / 历史种子相互串扰。
    const runId = Date.now();
    const marker = `sff-e2e-${runId}`;
    const seed = {
      envFileName: `.env.${marker}`,
      hiddenWorkflowRelPath: join(".github", "workflows", `${marker}.yml`),
      buildFileRelPath: join("build", `${marker}.txt`),
      nodeModulesFileRelPath: join("node_modules", "sff-e2e-pkg", `${marker}.js`),
    };

    await seedWorkspaceFileFilterCandidates(seed);

    // 隐藏目录后代：.github/workflows/<marker>.yml 必须可搜
    await setV4ComposerText(`@${marker}.yml`);
    const hiddenPanel = await waitForPanelSections("@", ["files"], "@ 文件候选面板没有打开");
    expect(optionSectionIds(hiddenPanel)).toEqual(["files"]);
    expect(optionTexts(hiddenPanel).join("\n")).toContain(`${marker}.yml`);

    // 过宽目录放开：build/<marker>.txt 必须可搜
    await setV4ComposerText(`@${marker}.txt`);
    const buildPanel = await waitForPanelSections("@", ["files"], "@ build 文件候选面板没有打开");
    expect(optionTexts(buildPanel).join("\n")).toContain(`${marker}.txt`);

    // node_modules 默认排除：node_modules/<pkg>/<marker>.js 不可搜
    // needle 用包目录名 sff-e2e-pkg（只存在于 node_modules 下），避免裸 marker 误匹配其它候选。
    await setV4ComposerText(`@${marker}.js`);
    await waitForPanelNoOptionContaining("sff-e2e-pkg", "node_modules 文件不应进入候选");

    // .env.* 默认排除：.env.<marker> 不可搜
    await setV4ComposerText(`@${marker}`);
    await waitForPanelNoOptionContaining(`.env.${marker}`, ".env 文件不应进入候选");
  });
});

async function seedWorkspaceFileFilterCandidates(seed: {
  envFileName: string;
  hiddenWorkflowRelPath: string;
  buildFileRelPath: string;
  nodeModulesFileRelPath: string;
}) {
  const envFilePath = join(DEFAULT_WORKSPACE, seed.envFileName);
  const hiddenWorkflowPath = join(DEFAULT_WORKSPACE, seed.hiddenWorkflowRelPath);
  const buildFilePath = join(DEFAULT_WORKSPACE, seed.buildFileRelPath);
  const nodeModulesFilePath = join(DEFAULT_WORKSPACE, seed.nodeModulesFileRelPath);

  await mkdir(join(DEFAULT_WORKSPACE, ".github", "workflows"), { recursive: true });
  await mkdir(join(DEFAULT_WORKSPACE, "build"), { recursive: true });
  await mkdir(join(DEFAULT_WORKSPACE, "node_modules", "sff-e2e-pkg"), {
    recursive: true,
  });

  // 内容里放 marker，方便未来如果需要做内容断言时复用，当前只用文件名做候选断言。
  await writeFile(envFilePath, `MARKER=${Date.now()}\n`, "utf-8");
  await writeFile(hiddenWorkflowPath, `name: ${Date.now()}\n`, "utf-8");
  await writeFile(buildFilePath, `sff e2e build marker ${Date.now()}\n`, "utf-8");
  await writeFile(nodeModulesFilePath, `export const sffMarker = ${Date.now()};\n`, "utf-8");

  createdPaths.push(envFilePath, hiddenWorkflowPath, buildFilePath, nodeModulesFilePath);
}

async function waitForPanelSections(
  trigger: string,
  expectedSectionIds: string[],
  timeoutMsg: string,
) {
  let latest: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getPanelSnapshot();
      // 修复原因：CI runner 上 Lexical 文本更新和 suggestion 过滤会跨帧完成。
      // 只等待 trigger/options 会读到上一帧的全量面板，导致 query-specific 断言误判。
      return (
        latest.trigger === trigger &&
        latest.options.length > 0 &&
        arraysEqual(optionSectionIds(latest), expectedSectionIds)
      );
    },
    {
      timeout: 15000,
      timeoutMsg,
    },
  );
  return latest ?? getPanelSnapshot();
}

// 默认排除项断言。
// 设计依据：mentionSearch 的 buildVisibleMentionGroups 会丢弃 "非 loading + 无 item + 无 error" 的分区，
// 所以当一个 query 正确命中 0 个文件时，files 分区会整段消失（既无 status 行也无 option 行）。
// 因此判定排除生效不能依赖 "files 分区出现且不含 needle"——分区不出现本身就是排除生效的信号。
// 关键前提：本 spec 前两条正向断言（.yml / .txt）已触发 listWorkspaceFiles 并缓存索引，后续负向 query
// 的结果几乎是即时的；这里用 "连续两帧快照一致" 判定稳定，再断言任何 files 候选都不含 needle。
async function waitForPanelNoOptionContaining(needle: string, timeoutMsg: string) {
  let previous: PanelSnapshot | null = null;
  let stable: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      const snapshot = await getPanelSnapshot();
      // 用 option + section 的签名比较，忽略 selected/index 等无意义抖动。
      const signature = panelSignature(snapshot);
      const previousSignature = previous ? panelSignature(previous) : null;
      previous = snapshot;
      if (previousSignature !== null && previousSignature === signature) {
        stable = snapshot;
        return true;
      }
      return false;
    },
    {
      timeout: 10000,
      timeoutMsg: `${timeoutMsg}（候选面板持续抖动，无法判定稳定终态）`,
    },
  );
  const finalSnapshot = stable ?? previous ?? (await getPanelSnapshot());
  const finalTexts = finalSnapshot.options
    .filter((option) => option.sectionId === "files")
    .map((option) => option.text);
  if (finalTexts.some((text) => text.includes(needle))) {
    throw new Error(
      `${timeoutMsg}（needle="${needle}"，实际 files 候选：${JSON.stringify(finalTexts)}）`,
    );
  }
}

// 面板稳定签名：files 分区的 status 集合 + files 候选文本列表。
// 排除项 query 命中 0 文件时 files 分区会被 buildVisibleMentionGroups 丢弃，
// 此时签名是稳定的空串；命中文件时签名随候选稳定下来后也不再变化。
function panelSignature(snapshot: PanelSnapshot): string {
  const filesStatuses = snapshot.statuses
    .filter((entry) => entry.sectionId === "files")
    .map((entry) => `${entry.status ?? "?"}:${entry.text}`)
    .join("|");
  const filesOptions = snapshot.options
    .filter((option) => option.sectionId === "files")
    .map((option) => option.text)
    .join("|");
  return `trigger=${snapshot.trigger ?? "?"};filesStatus=${filesStatuses};filesOptions=${filesOptions}`;
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getPanelSnapshot(): Promise<PanelSnapshot> {
  return browser.execute(
    (panelTestId, optionPrefix, statusPrefix) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      const options = Array.from(
        panel?.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`) ?? [],
      ).map((element) => ({
        id: element.getAttribute("data-option-id"),
        index: Number(element.getAttribute("data-option-index") ?? "0"),
        sectionId: element.getAttribute("data-section-id"),
        selected: element.getAttribute("data-selected") === "true",
        text: (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim(),
      }));
      const statuses = Array.from(
        panel?.querySelectorAll<HTMLElement>(`[data-testid^="${statusPrefix}-"]`) ?? [],
      ).map((element) => ({
        sectionId: element.getAttribute("data-section-id"),
        status: element.getAttribute("data-status"),
        text: (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim(),
      }));
      return {
        options,
        statuses,
        trigger: panel?.getAttribute("data-trigger") ?? null,
      };
    },
    TID_PROMPT_SUGGESTION_PANEL,
    TID_PROMPT_SUGGESTION_OPTION,
    TID_PROMPT_SUGGESTION_STATUS,
  );
}

function optionSectionIds(snapshot: PanelSnapshot) {
  return [
    ...new Set(
      snapshot.options
        .map((item) => item.sectionId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function optionTexts(snapshot: PanelSnapshot) {
  return snapshot.options.map((option) => option.text);
}
