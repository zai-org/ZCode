import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { prepareV4ConversationE2E, setV4ComposerText } from "#e2e/helpers/v4-conversation";

// gitignore 解析按行识别，行尾风格不影响规则；统一写 \n 避免 e2e 源码里出现跨行字面量。
const LINE_SEP = "\n";

// E2E case for .zcodeignore 单一真相源（spec 2026-08-07 2026-09-15 增补，ZCT-2096811705629528064）。
// 验证真实 Electron Desktop 上的完整交互链路：
//   1. workspace 存在 .gitignore(含 obj/) 时，@ 扫描仅在内存中加载规则，不创建 .zcodeignore，
//      obj/ 整棵剪枝，obj 下文件不可搜；
//   2. 手动创建 .zcodeignore 放开排除规则（设置入口当前隐藏，文件编辑是真实用户路径），
//      关闭重开 @ 面板重扫后，obj 下文件恢复可搜。
// 过滤 authority 在 services 层 fileService.listWorkspaceFiles；本 spec 只取证用户可见矩阵。
const TEST_TIMEOUT_MS = 180000;
const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

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

// seed 产生的待清理状态：新目录 + 手动创建的 .zcodeignore + .gitignore 的原内容恢复。
let seededDirs: string[] = [];
let createdZcodeIgnore = false;
let originalGitignore: string | null = null;

describe("会话区 .zcodeignore 工作区搜索忽略规则 E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // 新隔离 profile 会先显示职业引导，完成后才能进入文件搜索场景。
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // 原因：全局新草稿可继承其它项目；搜索 fixture 必须绑定其实际项目。
    await startDraftFromProject(DEFAULT_WORKSPACE);
  });

  after(async () => {
    await Promise.all(seededDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    seededDirs = [];
    if (createdZcodeIgnore) {
      await rm(join(DEFAULT_WORKSPACE, ".zcodeignore"), { force: true });
      createdZcodeIgnore = false;
    }
    const gitignorePath = join(DEFAULT_WORKSPACE, ".gitignore");
    if (originalGitignore === null) {
      await rm(gitignorePath, { force: true });
    } else {
      await writeFile(gitignorePath, originalGitignore, "utf-8");
    }
    originalGitignore = null;
    await browser.electron.restoreAllMocks();
  });

  it("@ 按内存规则剪枝且不创建 .zcodeignore；手动规则文件仍生效", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    const runId = Date.now();
    const marker = `zci-e2e-${runId}`;
    const objFileRelPath = join("obj", "Debug", `${marker}.cs`);
    const srcFileRelPath = join("src", `${marker}.ts`);

    // seed：合并写入 .gitignore（保留原内容，after 恢复），obj 与 src 各放一个 marker 文件。
    const gitignorePath = join(DEFAULT_WORKSPACE, ".gitignore");
    originalGitignore = await readFile(gitignorePath, "utf-8").catch(() => null);
    const baseGitignore = originalGitignore ?? "";
    if (!/^obj\/$/m.test(baseGitignore)) {
      await writeFile(
        gitignorePath,
        `${baseGitignore}${baseGitignore.endsWith("\n") || !baseGitignore ? "" : "\n"}obj/\n`,
        "utf-8",
      );
    }
    const objDir = join(DEFAULT_WORKSPACE, "obj");
    const srcDir = join(DEFAULT_WORKSPACE, "src");
    await mkdir(join(objDir, "Debug"), { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(DEFAULT_WORKSPACE, objFileRelPath), `// ${marker}\n`, "utf-8");
    await writeFile(join(DEFAULT_WORKSPACE, srcFileRelPath), `// ${marker}\n`, "utf-8");
    seededDirs.push(objDir, srcDir);

    // 1) 默认剪枝：src marker 可搜（证明面板与索引正常），obj/Debug 不可搜（内存规则生效）。
    await setV4ComposerText(`@${marker}`);
    const visiblePanel = await waitForPanelSections("@", ["files"], "@ 文件候选面板没有打开");
    expect(visiblePanel.options.map((o) => o.text).join("\n")).toContain(`${marker}.ts`);
    await setV4ComposerText(`@${marker}.cs`);
    await waitForPanelNoOptionContaining("obj/Debug", "obj/ 下被忽略文件不应进入候选");

    // 管理入口隐藏期间，搜索不应自动在工作区创建配置文件。
    const zcodeIgnorePath = join(DEFAULT_WORKSPACE, ".zcodeignore");
    await expect(stat(zcodeIgnorePath)).rejects.toMatchObject({ code: "ENOENT" });

    // 2) 手动创建规则文件放开 obj/：设置入口当前隐藏（HIDDEN_SETTINGS_SECTIONS），
    // 真实用户路径是直接编辑 .zcodeignore；写入空规则等价于"删除全部排除规则"。
    // 用数组 join 写出字面 "\n" 结尾内容，避免字符串字面量跨行。
    await writeFile(zcodeIgnorePath, ["# emptied by e2e", ""].join(LINE_SEP), "utf-8");
    createdZcodeIgnore = true;

    // 3) 规则放开生效：先输入普通文本关闭 @ 面板（本地 30s TTL 缓存已移除——面板
    // 关闭即清理、重新打开必然重扫，spec 2026-08-26 2026-09-15 更新），随后刻意复用
    // 与第二步完全相同的 query 验证新规则：若缓存语义回退（miss-refresh 防重复会挡掉
    // 同 query 重扫），本断言将失败，形成回归保护。
    // 注意不能省略关闭步骤：第二步的 @ query 文本仍在输入框里，面板
    // enabled 从未变 false，不经历"关闭→重开"周期就不会重新读取索引。
    // 同会话第二次打开面板时 plugins/skills 分区已缓存就绪，故只断言 files 分区包含目标。
    await setV4ComposerText("refresh-panel");
    await setV4ComposerText(`@${marker}.cs`);
    await waitForPanelFilesOptionContaining(
      `${marker}.cs`,
      "删除规则后 obj/Debug 下文件未恢复可搜",
    );
  });
});

// 与 filter spec 相同的正向断言：面板 trigger 命中、files 分区出现且候选非空。
async function waitForPanelSections(
  trigger: string,
  expectedSectionIds: string[],
  timeoutMsg: string,
) {
  let latest: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getPanelSnapshot();
      return (
        latest.trigger === trigger &&
        latest.options.length > 0 &&
        arraysEqual(optionSectionIds(latest), expectedSectionIds)
      );
    },
    { timeout: 15000, timeoutMsg },
  );
  return latest ?? getPanelSnapshot();
}

function optionSectionIds(snapshot: PanelSnapshot): string[] {
  return Array.from(new Set(snapshot.options.map((option) => option.sectionId ?? "?")));
}

// 等待 files 分区出现包含 needle 的候选；不限制其他分区是否同时可见。
async function waitForPanelFilesOptionContaining(needle: string, timeoutMsg: string) {
  await browser.waitUntil(
    async () => {
      const snapshot = await getPanelSnapshot();
      if (snapshot.trigger !== "@") {
        return false;
      }
      return snapshot.options
        .filter((option) => option.sectionId === "files")
        .some((option) => option.text.includes(needle));
    },
    { timeout: 15000, timeoutMsg },
  );
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// 与 filter spec 相同的排除断言：连续两帧面板快照一致后，files 候选不得包含 needle。
async function waitForPanelNoOptionContaining(needle: string, timeoutMsg: string) {
  let previous: PanelSnapshot | null = null;
  let stable: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      const snapshot = await getPanelSnapshot();
      const signature = panelSignature(snapshot);
      const previousSignature = previous ? panelSignature(previous) : null;
      previous = snapshot;
      if (previousSignature !== null && previousSignature === signature) {
        stable = snapshot;
        return true;
      }
      return false;
    },
    { timeout: 15000, timeoutMsg: `${timeoutMsg}（候选面板持续抖动，无法判定稳定终态）` },
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
