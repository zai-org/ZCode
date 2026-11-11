import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

const TEST_TIMEOUT_MS = 120000;
const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";
const createdWorkspacePaths: string[] = [];

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

describe("会话区 Composer 前缀提示路由 E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await prepareV4ConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);

    // 文件及候选夹具归属于项目；全局新建会切到未归类 cwd，无法读取这里的文件。
    await startDraftFromProject(DEFAULT_WORKSPACE);
  });

  after(async () => {
    await Promise.all(
      createdWorkspacePaths.map((targetPath) => rm(targetPath, { recursive: true, force: true })),
    );
    await browser.electron.restoreAllMocks();
    // 修复原因：task index sqlite 由 host/service 生命周期持有，Windows 上在
    // spec-level after 里删除整个 appData 会撞到仍打开的 -shm 文件。全局 e2e
    // beforeSession 会重置隔离 HOME，Electron 退出后的兜底清理由 wdio 生命周期处理。
  });

  it("@ 聚合 plugin/file/session/whiteboard，/ 提示 command/skill/subagent，$ 兼容面板保留，且键盘选择写入正确 mention", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    const runId = Date.now();
    const seed = {
      commandName: `e2e-cmd-${runId}`,
      directoryName: `e2e-route-dir-${runId}`,
      fileName: `e2e-route-file-${runId}.ts`,
      skillName: `e2e-skill-${runId}`,
      subagentName: `e2e-agent-${runId}`,
      whiteboardName: `e2e-route-board-${runId}`,
    };

    // 目录现在由 CLI runtime 持有。旧测试写 renderer store 会被真实加载覆盖；
    // 冷启动前准备文件，确保本轮 prewarm 的冻结目录包含这三类候选。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await seedWorkspaceFileCandidates(seed);
        await seedPromptCatalogFiles(seed);
      },
    });
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await createWhiteboard(seed.whiteboardName);

    await setComposerText(`@${seed.fileName}`);
    const atFilePanel = await waitForPanelSections("@", ["files"], "@ 文件候选面板没有打开");
    expect(optionTexts(atFilePanel).join("\n")).toContain(seed.fileName);
    assertPanelExcludesSections(atFilePanel, ["commands", "subagents", "skills"]);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      seed.fileName,
      "@ 文件候选 Enter 后没有写入文件 mention markdown",
    );

    await setComposerText(`@${seed.directoryName}`);
    const atDirectoryPanel = await waitForPanelSections("@", ["files"], "@ 文件夹候选面板没有打开");
    expect(optionTexts(atDirectoryPanel).join("\n")).toContain(seed.directoryName);
    await browser.keys("Tab");
    await waitForComposerMarkdownContaining(
      `${seed.directoryName}/`,
      "@ 文件夹候选 Tab 后没有写入目录 mention markdown",
    );

    await setComposerText(`@${seed.whiteboardName}`);
    const atWhiteboardPanel = await waitForPanelSections(
      "@",
      ["whiteboards"],
      "@ 画板候选面板没有打开",
    );
    expect(optionTexts(atWhiteboardPanel).join("\n")).toContain(seed.whiteboardName);
    assertPanelExcludesSections(atWhiteboardPanel, ["commands", "subagents", "skills"]);

    // S01 语义：`@` 固定按 plugins → files → sessions → whiteboards 路由；
    // 当前 query 只命中 Plugin，选中后仍写入既有 canonical plugin:// markdown。
    // 默认启用的官方纯内容插件 skill-creator 作为确定性候选；选中写入 canonical plugin:// markdown。
    await setComposerText("@skill-creator");
    const atPluginPanel = await waitForPanelSections("@", ["plugins"], "@ plugin 候选面板没有打开");
    // 展示名称随语言变化；下方仍精确校验选中的 canonical plugin 标识。
    expect(optionTexts(atPluginPanel).join("\n")).toMatch(/skill-creator|技能创建器/u);
    assertPanelExcludesSections(atPluginPanel, ["commands", "subagents", "skills"]);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      "plugin://skill-creator@zcode-plugins-official",
      "@ plugin 候选 Enter 后没有写入 canonical plugin mention markdown",
    );

    // 候选列表虚拟化后，空 query 的 subagent 可能尚未挂载到 DOM；
    // 用三个磁盘夹具共有的前缀同时命中三组，仍精确验证分组顺序与排除项。
    await setComposerText("/e2e-");
    const slashPanel = await waitForPanelSections(
      "/",
      ["commands", "skills", "subagents"],
      "/ 候选面板没有打开",
    );
    assertPanelExcludesSections(slashPanel, ["files", "whiteboards"]);

    await setComposerText(`/${seed.commandName}`);
    const slashCommandPanel = await waitForPanelSections(
      "/",
      ["commands"],
      "/ command 候选面板没有打开",
    );
    expect(optionTexts(slashCommandPanel).join("\n")).toContain(`/${seed.commandName}`);
    await browser.keys("Enter");
    await waitForComposerMarkdown(
      `/${seed.commandName}`,
      "/ command 候选 Enter 后没有写入 slash command mention markdown",
    );

    await setComposerText(`/${seed.skillName}`);
    const slashSkillPanel = await waitForPanelSections("/", ["skills"], "/ skill 候选面板没有打开");
    expect(optionTexts(slashSkillPanel).join("\n")).toContain(`$${seed.skillName}`);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      `$${seed.skillName}`,
      "/ skill 候选 Enter 后没有写入 skill mention markdown",
    );

    await setComposerText(`/${seed.subagentName}`);
    const slashSubagentPanel = await waitForPanelSections(
      "/",
      ["subagents"],
      "/ subagent 候选面板没有打开",
    );
    expect(optionTexts(slashSubagentPanel).join("\n")).toContain(seed.subagentName);
    await browser.keys("Tab");
    await waitForComposerMarkdown(
      `@${seed.subagentName}`,
      "/ subagent 候选 Tab 后没有写入 subagent mention markdown",
    );

    await setComposerText(`$${seed.skillName}`);
    const skillPanel = await waitForPanelSections("$", ["skills"], "$ skill 候选面板没有打开");
    expect(optionTexts(skillPanel).join("\n")).toContain(seed.skillName);
    assertPanelExcludesSections(skillPanel, ["files", "whiteboards", "commands", "subagents"]);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      `$${seed.skillName}`,
      "$ skill 候选 Enter 后没有写入 skill mention markdown",
    );
  });
});

async function seedWorkspaceFileCandidates(seed: { directoryName: string; fileName: string }) {
  const directoryPath = join(DEFAULT_WORKSPACE, seed.directoryName);
  const filePath = join(DEFAULT_WORKSPACE, seed.fileName);
  await mkdir(directoryPath, { recursive: true });
  await writeFile(filePath, "export const e2eComposerPrefixRouting = true;\n", "utf-8");
  createdWorkspacePaths.push(directoryPath, filePath);
}

async function seedPromptCatalogFiles(seed: {
  commandName: string;
  skillName: string;
  subagentName: string;
}) {
  const files: Array<[string, string]> = [
    [
      join(DEFAULT_WORKSPACE, ".zcode", "commands", `${seed.commandName}.md`),
      `---\ndescription: E2E prefix command\nargument-hint: [topic]\n---\nPrefix fixture $ARGUMENTS.\n`,
    ],
    [
      join(DEFAULT_WORKSPACE, ".zcode", "skills", seed.skillName, "SKILL.md"),
      `---\nname: ${seed.skillName}\ndescription: E2E prefix skill\n---\nUse only for prefix routing.\n`,
    ],
    [
      join(DEFAULT_WORKSPACE, ".zcode", "agents", `${seed.subagentName}.md`),
      `---\nname: ${seed.subagentName}\ndescription: E2E prefix subagent\ntools: Read\n---\nUse only for prefix routing.\n`,
    ],
  ];
  for (const [file, body] of files) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, body, "utf8");
    createdWorkspacePaths.push(file);
  }
}

async function createWhiteboard(name: string) {
  await browser.execute(
    (workspacePath, boardName) => {
      const store = (
        window as unknown as {
          __whiteboardStoreE2E: {
            getState(): {
              createBoard(params: { defaultNamePrefix: string; workspacePath: string }): {
                id: string;
              };
              renameBoard(params: { boardId: string; name: string; workspacePath: string }): void;
            };
          };
        }
      ).__whiteboardStoreE2E;
      const board = store
        .getState()
        .createBoard({ workspacePath, defaultNamePrefix: "E2E route board" });
      store.getState().renameBoard({ workspacePath, boardId: board.id, name: boardName });
    },
    DEFAULT_WORKSPACE,
    name,
  );
}

async function setComposerText(text: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (inputTestId, nextText) => {
          const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`) as
            | (HTMLElement & {
                __zcodeLexicalInputE2E?: {
                  focus: () => void;
                  setText: (value: string) => void;
                };
              })
            | null;
          const bridge = input?.__zcodeLexicalInputE2E;
          if (!bridge) {
            return false;
          }
          bridge.setText(nextText);
          bridge.focus();
          return true;
        },
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    {
      timeout: 10000,
      timeoutMsg: `composer prefix routing: 输入框 E2E bridge 未就绪，无法输入 ${text}`,
    },
  );
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

function assertPanelExcludesSections(snapshot: PanelSnapshot, excludedSectionIds: string[]) {
  const actualSectionIds = optionSectionIds(snapshot);
  for (const excluded of excludedSectionIds) {
    expect(actualSectionIds).not.toContain(excluded);
  }
}

async function waitForComposerMarkdown(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await getComposerMarkdown()).trim() === expected, {
    timeout: 10000,
    timeoutMsg,
  });
}

async function waitForComposerMarkdownContaining(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await getComposerMarkdown()).includes(expected), {
    timeout: 10000,
    timeoutMsg,
  });
}

function getComposerMarkdown(): Promise<string> {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`) as
      | (HTMLElement & {
          __zcodeLexicalInputE2E?: { getText: () => string };
        })
      | null;
    return input?.__zcodeLexicalInputE2E?.getText() ?? "";
  }, TID_V4_COMPOSER_INPUT);
}
