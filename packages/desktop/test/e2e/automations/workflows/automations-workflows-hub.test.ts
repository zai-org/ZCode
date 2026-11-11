import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_AUTOMATIONS_PAGE_TAB,
  TID_CHAT_WORKFLOW_RUN_DIGEST,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_ARTIFACT_CARD,
  TID_WORKFLOW_ARTIFACT_PANE,
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_MENU,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_DETAIL_PROJECT,
  TID_WORKFLOW_GLOBAL_GROUP,
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  TID_WORKFLOW_LAUNCH_ERROR,
  TID_WORKFLOW_LAUNCH_FIELDS,
  TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_META_SAVE,
  TID_WORKFLOW_MOVE_DIALOG,
  TID_WORKFLOW_MOVE_DIALOG_SUBMIT,
  TID_WORKFLOW_PROJECT_GROUP,
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
} from "@zcode/shared";
import {
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_SUMMARY_PANEL,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  TID_V4_TIMELINE,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  pinE2ELocale,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  getMessages,
  prepareConversationE2E,
  waitForUserMessageContaining,
} from "#e2e/helpers/conversation-session";
import { getV4ComposerBackgroundWorkCounts } from "#e2e/helpers/v4-conversation";
import { readDynamicWorkflowGrayMockStatus } from "#e2e/helpers/dynamic-workflow-gray";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

const WORKFLOW_NAME = "release-check";
const WORKFLOWS_DIR = join(DEFAULT_WORKSPACE, ".zcode", "workflows");
const WORKFLOW_FILE = join(WORKFLOWS_DIR, `${WORKFLOW_NAME}.dwf.ts`);
const EDITED_DESCRIPTION = "发布前检查（E2E 已编辑）";
// 脚本正文：元数据编辑只改文件顶部的 frontmatter，这一段必须逐字节保留（不变式 4）。
const SCRIPT = [
  "export default async ({ agent }) => {",
  '  await agent("跑测试并整理发布说明");',
  "};",
  "",
].join("\n");
const SEED = [
  "/* zcode-workflow",
  "description: 发布前检查",
  "whenToUse: 准备发版时",
  "args:",
  "  branch:",
  "    type: string",
  "    required: true",
  "*/",
  SCRIPT,
].join("\n");

interface GroupHeaderInfo {
  groupTestId: string | null;
  text: string;
  createTestId: string | null;
}

beforeEach(async () => {
  // Bug 原因：worker 延后统一清理，前一条 case 的自动化页和编译失败弹窗仍在。
  // 先关闭弹窗并从默认项目新建任务；全局新建入口会进入无项目草稿，无法满足准备流程。
  const launchDialog = $(`[data-testid="${TID_WORKFLOW_LAUNCH_DIALOG}"]`);
  if (await launchDialog.isDisplayed()) {
    await browser.keys("Escape");
    await launchDialog.waitForDisplayed({ reverse: true });
  }
  const automationsOpen = await browser.execute(() =>
    Boolean(document.querySelector("[data-automations-content]")),
  );
  if (automationsOpen) {
    await startDraftFromProject(DEFAULT_WORKSPACE);
  }
});

/**
 * 每条 case 的准备：只要 workspace 就绪，不需要账号或模型 provider。
 * 断言中文文案，所以紧接着固定界面语言，不跟随宿主系统语言（容器里默认英文）；
 * 必须在 workspace 就绪之后调（此前 renderer 还没注册 __testActions），且每条 case 都调：
 * 各 describe 的 after 会 clearAppData，把语言设置一起清掉。
 */
async function prepareHubCase(): Promise<void> {
  await prepareConversationE2E({ skipProvider: true });
  await pinE2ELocale("zh-CN");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTestIdText(currentTestId: string): Promise<string | null> {
  return browser.execute((tid) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid && item.checkVisibility(),
    );
    return element?.textContent?.trim() ?? null;
  }, currentTestId);
}

async function clickRunSidePaneControl(currentTestId: string): Promise<void> {
  // Bug 原因：非活动侧栏页仍挂载；全局按 test id 取首项会操作前一条 case 的 run。
  // 限定活动 tab，并通过真实指针点击，避免隐藏控件造成假通过或污染其他 run。
  const control = $(`[role="tabpanel"][data-state="active"] [data-testid="${currentTestId}"]`);
  await control.waitForClickable();
  await control.click();
}

/**
 * 已保存工作流中枢「列表 → 详情 → 改元数据 → 删除」端到端（docs/dynamic-workflow/launch.md）。
 *
 * 只碰 UI + 项目目录里的 `.zcode/workflows/`：不发送 prompt、不依赖模型回放，因此是确定性的。
 * 「运行」走对话的用例在 conversation-session/ 下单独立案（需要回放 provider）。
 */
describe("已保存工作流中枢 E2E", () => {
  before(async () => {
    await mkdir(WORKFLOWS_DIR, { recursive: true });
    await writeFile(WORKFLOW_FILE, SEED, "utf-8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(WORKFLOWS_DIR, { recursive: true, force: true });
    await clearAppData();
  });

  it("预置的工作流可见，改说明只重写 frontmatter，删除后回到空态", async function () {
    this.timeout(150000);

    // 只需要 workspace 就绪即可进入自动化页，不需要账号或配置模型 provider。
    await prepareHubCase();

    const configStatus = await readDynamicWorkflowGrayMockStatus();
    expect(configStatus.mode).toBe("alwaysOn");
    expect(configStatus.configRequests).toBeGreaterThan(0);

    // 1) 打开自动化页，页标题切到「工作流」。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现自动化入口",
    });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });

    // 2) 全局视图按项目分组：默认工作区（folder 名 ZCodeProject）自成一组，组头带名字，
    //    组内「通过对话创建」按钮带以 workspaceKey 收尾的 test id。
    //    group / create 的 test id 后缀是 workspaceKey（本地通常 = workspacePath），但
    //    resolveWorkspaceKey 若对本地路径做归一化（大小写 / 去尾斜杠 / realpath）后缀就不等于
    //    DEFAULT_WORKSPACE——所以只按前缀等待与断言，不钉死整串。
    const readGroupInfo = () =>
      browser.execute(
        (groupPrefix: string, createPrefix: string) => {
          const group = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid?.startsWith(groupPrefix),
          );
          if (!group) return null;
          const createButton = group.querySelector<HTMLElement>(`[data-testid^="${createPrefix}"]`);
          return {
            groupTestId: group.dataset.testid ?? null,
            text: group.textContent ?? "",
            createTestId: createButton?.dataset.testid ?? null,
          };
        },
        TID_WORKFLOW_PROJECT_GROUP,
        // testId(base, "") = `${base}-`：create 按钮 test id 的前缀。
        testId(TID_WORKFLOWS_CREATE_VIA_CHAT, ""),
      ) as Promise<GroupHeaderInfo | null>;

    let groupInfo: GroupHeaderInfo | null = null;
    await browser.waitUntil(
      async () => {
        groupInfo = await readGroupInfo();
        return Boolean(groupInfo && groupInfo.createTestId);
      },
      { timeout: 20000, timeoutMsg: "工作流页没有出现默认工作区的项目组" },
    );
    const seen = groupInfo as GroupHeaderInfo | null;
    expect(seen?.groupTestId?.startsWith(TID_WORKFLOW_PROJECT_GROUP)).toBe(true);
    expect(seen?.text).toContain("ZCodeProject");
    expect(seen?.createTestId?.startsWith(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, ""))).toBe(true);
    expect(seen?.createTestId).toContain("ZCodeProject");

    // 3) 预置文件以卡片出现：名字 + frontmatter 里的说明。
    const cardTestId = testId(TID_WORKFLOW_CARD, WORKFLOW_NAME);
    await waitForTestIdByDom(cardTestId, {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现预置的 release-check 卡片",
    });
    expect(await readTestIdText(cardTestId)).toContain("发布前检查");

    // 4) 点卡片进详情，改说明并保存。
    await clickTestIdByDom(cardTestId, { timeoutMsg: "无法点击工作流卡片进入详情" });
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, { timeoutMsg: "没有进入工作流详情页" });

    // 4a) 面包屑只有「自动化 › 工作流名」两级：项目不是一页，不该占一级点不动的面包屑；
    //     项目归属写在标题旁的小标上。
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL_PROJECT, {
      timeoutMsg: "详情页标题旁没有项目归属小标",
    });
    expect(await readTestIdText(TID_WORKFLOW_DETAIL_PROJECT)).toBe("ZCodeProject");
    const crumbs = (await browser.execute(() => {
      const nav = document.querySelector('[data-testid="automations-main-drag-region"] nav');
      return nav
        ? Array.from(nav.querySelectorAll("li")).map((item) => ({
            text: item.textContent?.trim() ?? "",
            clickable: item.querySelector("button") !== null,
          }))
        : null;
    })) as { text: string; clickable: boolean }[] | null;
    expect(crumbs).toHaveLength(2);
    expect(crumbs?.[1]?.text).toBe(WORKFLOW_NAME);
    expect(crumbs?.map((crumb) => crumb.clickable)).toEqual([true, false]);

    // 4b) 一级面包屑回到列表，卡片还在；再点卡片回到详情。
    await clickTestIdByDom("settings-breadcrumb-section", {
      timeoutMsg: "详情页没有可点的一级面包屑",
    });
    await waitForTestIdByDom(cardTestId, { timeoutMsg: "点一级面包屑后没有回到工作流列表" });
    await clickTestIdByDom(cardTestId, { timeoutMsg: "无法再次点击工作流卡片进入详情" });
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, { timeoutMsg: "没有再次进入工作流详情页" });

    await setInputValueByTestIdDom(TID_WORKFLOW_DETAIL_DESCRIPTION, EDITED_DESCRIPTION, {
      timeoutMsg: "详情页没有出现说明输入框",
    });
    await clickTestIdByDom(TID_WORKFLOW_META_SAVE, {
      timeoutMsg: "改说明后没有出现「保存元数据」",
    });

    // 5) 磁盘：frontmatter 更新、脚本正文逐字节不变。
    await browser.waitUntil(
      async () => (await readFile(WORKFLOW_FILE, "utf-8")).includes(EDITED_DESCRIPTION),
      { timeout: 15000, timeoutMsg: "保存后磁盘文件的说明没有更新" },
    );
    const saved = await readFile(WORKFLOW_FILE, "utf-8");
    expect(saved.startsWith("/* zcode-workflow\n")).toBe(true);
    expect(saved.endsWith(`*/\n${SCRIPT}`)).toBe(true);
    expect(saved).toContain("whenToUse: 准备发版时");
    expect(saved).toContain("required: true");

    // 6) 详情页 ⋯ 菜单 → 删除 → 二次确认 → 回到列表空态，文件消失。
    await clickTestIdByWebDriver(TID_WORKFLOW_DETAIL_MENU, {
      timeoutMsg: "详情页没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_DELETE, WORKFLOW_NAME), {
      timeoutMsg: "详情页菜单没有「删除工作流」项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await waitForTestIdByDom(TID_WORKFLOWS_EMPTY, {
      timeout: 15000,
      timeoutMsg: "删除后没有回到工作流空态",
    });
    await browser.waitUntil(async () => !(await fileExists(WORKFLOW_FILE)), {
      timeout: 10000,
      timeoutMsg: "删除后磁盘文件仍然存在",
    });
  });
});

// ── 全局工作流：置顶「全局」组 + 全局→项目搬文件 + 项目→全局 AI 概括（docs/dynamic-workflow/launch.md）──
// E2E_HOME_DIR 由 wdio 配置设为隔离目录并写进 HOME（wdio.conf.ts:520），app / agent 进程都继承它，
// 因此 agent 的 os.homedir() 解析到这里，全局根 = `<E2E_HOME>/.zcode/workflows/`。
const E2E_HOME = dirname(DEFAULT_WORKSPACE);
const GLOBAL_WORKFLOW_NAME = "global-note";
const GLOBAL_WORKFLOWS_DIR = join(E2E_HOME, ".zcode", "workflows");
const GLOBAL_WORKFLOW_FILE = join(GLOBAL_WORKFLOWS_DIR, `${GLOBAL_WORKFLOW_NAME}.dwf.ts`);
const GLOBAL_PROJECT_WORKFLOWS_DIR = join(DEFAULT_WORKSPACE, ".zcode", "workflows");
const GLOBAL_PROJECT_WORKFLOW_FILE = join(
  GLOBAL_PROJECT_WORKFLOWS_DIR,
  `${GLOBAL_WORKFLOW_NAME}.dwf.ts`,
);
// 无实参的全局工作流：「移到项目…」是逐字节搬文件，脚本正文两端必须完全一致。
const GLOBAL_SCRIPT = [
  "export default async ({ agent }) => {",
  '  await agent("做一次深度调研");',
  "};",
  "",
].join("\n");
const GLOBAL_SEED = [
  "/* zcode-workflow",
  "description: 深度调研（全局）",
  "*/",
  GLOBAL_SCRIPT,
].join("\n");

describe("全局工作流中枢 E2E", () => {
  before(async () => {
    await mkdir(GLOBAL_WORKFLOWS_DIR, { recursive: true });
    await writeFile(GLOBAL_WORKFLOW_FILE, GLOBAL_SEED, "utf-8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(GLOBAL_WORKFLOW_FILE, { force: true });
    await rm(GLOBAL_PROJECT_WORKFLOW_FILE, { force: true });
    await clearAppData();
  });

  it("全局组置顶；全局→项目搬文件；项目→全局开新会话发概括提示、文件不动", async function () {
    this.timeout(150000);

    await prepareHubCase();

    // 1) 自动化页 →「工作流」标签。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });

    // 2) 顶部「全局」组出现，且含预置的 global-note 卡片。
    await waitForTestIdByDom(TID_WORKFLOW_GLOBAL_GROUP, {
      timeout: 20000,
      timeoutMsg: "工作流页没有出现「全局」组",
    });
    const globalCardTestId = testId(TID_WORKFLOW_CARD, GLOBAL_WORKFLOW_NAME);
    await waitForTestIdByDom(globalCardTestId, {
      timeout: 20000,
      timeoutMsg: "「全局」组里没有出现预置的 global-note 卡片",
    });

    // 3) 卡片 ⋯ →「移到项目…」→ 移动窗 → 提交。
    await clickTestIdByWebDriver(testId(TID_WORKFLOW_CARD_MENU, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "全局卡片没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_MOVE, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "全局卡片菜单没有「移到项目…」项",
    });
    await waitForTestIdByDom(TID_WORKFLOW_MOVE_DIALOG, { timeoutMsg: "没有出现「移到项目」窗" });
    await clickTestIdByDom(TID_WORKFLOW_MOVE_DIALOG_SUBMIT, {
      timeoutMsg: "「移到项目」窗没有提交按钮",
    });

    // 4) 磁盘：文件已搬到项目目录，从 HOME 消失。
    await browser.waitUntil(async () => fileExists(GLOBAL_PROJECT_WORKFLOW_FILE), {
      timeout: 15000,
      timeoutMsg: "移到项目后文件没有出现在项目目录",
    });
    await browser.waitUntil(async () => !(await fileExists(GLOBAL_WORKFLOW_FILE)), {
      timeout: 10000,
      timeoutMsg: "移到项目后 HOME 里的文件仍然存在",
    });

    // 5) 卡片现在落在项目组里，且「全局」组仍在项目组之上（比较 DOM 顺序）。
    const projectGroupTestId = await browser.waitUntil(
      async () => {
        const tid = await browser.execute((prefix: string) => {
          const group = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid?.startsWith(prefix),
          );
          return group?.dataset.testid ?? null;
        }, TID_WORKFLOW_PROJECT_GROUP);
        return tid ?? false;
      },
      { timeout: 15000, timeoutMsg: "移到项目后没有出现项目组" },
    );
    const order = await browser.execute(
      (globalTid: string, projectTid: string) => {
        const globalEl = document.querySelector<HTMLElement>(`[data-testid="${globalTid}"]`);
        const projectEl = document.querySelector<HTMLElement>(`[data-testid="${projectTid}"]`);
        if (!globalEl || !projectEl) return null;
        // Node.DOCUMENT_POSITION_FOLLOWING = 4：project 在 global 之后。
        return (globalEl.compareDocumentPosition(projectEl) & 4) !== 0
          ? "global-first"
          : "project-first";
      },
      TID_WORKFLOW_GLOBAL_GROUP,
      projectGroupTestId as string,
    );
    expect(order).toBe("global-first");
    // 卡片仍可见（此刻在项目组里）。
    await waitForTestIdByDom(globalCardTestId, { timeoutMsg: "移到项目后卡片消失了" });

    // 6) 项目卡片 ⋯ →「提升为全局」（2026-09-04 追记）：不搬文件，而是在本项目开新会话、自动发送
    //    概括提示（createSession.firstInput）。断言：切到新会话，首条用户消息含工作流名、路径与
    //    scope: "global" 指令；两处文件都不动（不变式 9：提升不搬、不删）。模型回合本身不断言
    //    （skipProvider 下没有 provider，那一跳失败与否与本特性无关）。
    await clickTestIdByWebDriver(testId(TID_WORKFLOW_CARD_MENU, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "项目卡片没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_MOVE, GLOBAL_WORKFLOW_NAME), {
      timeoutMsg: "项目卡片菜单没有「提升为全局」项",
    });
    await waitForUserMessageContaining(GLOBAL_WORKFLOW_NAME);
    const promoteMessage = (await getMessages("user")).find((message) =>
      message.text.includes(GLOBAL_WORKFLOW_NAME),
    );
    expect(promoteMessage?.text ?? "").toContain(GLOBAL_PROJECT_WORKFLOW_FILE);
    expect(promoteMessage?.text ?? "").toContain('scope: "global"');
    // 文件不动：项目档还在，HOME 里没有被搬回去的同名文件。
    expect(await fileExists(GLOBAL_PROJECT_WORKFLOW_FILE)).toBe(true);
    expect(await fileExists(GLOBAL_WORKFLOW_FILE)).toBe(false);
  });
});

// ── 直接启动：中枢「运行」→ 新会话顶部启动卡（docs/dynamic-workflow/launch.md）─────────
// 与前两组一样只碰 UI + 项目目录里的 `.zcode/workflows/`，且刻意用**无 agent()/模型调用**的
// 常量工作流：run 的子代理一个都不起，因此整条路（建会话 → startSavedWorkflow → run 结算）
// 都不需要 provider 回放，skipProvider 下即可跑到 completed。run 终态之后会触发既有的完成
// 通知回合（那一跳才第一次要模型），本组**刻意断言到启动卡 completed 为止**，不依赖模型——
// 与 spec 测试地图「完成通知回合按既有 replay 惯例处理或断言到通知行为止」一致。
const LAUNCH_OK_NAME = "direct-launch-ok";
const LAUNCH_OK_ARG = "topic";
const LAUNCH_OK_ARG_VALUE = "adaptive concurrency in agent runtimes";
const LAUNCH_OK_FILE = join(WORKFLOWS_DIR, `${LAUNCH_OK_NAME}.dwf.ts`);
// 脚本体：无 agent()、立即返回常量。声明一个必填实参 `topic`，好让「运行」弹出实参窗
// （无实参的项目档点击即跑、不弹窗，见 spec）。编译干净（`return <字面量>` 是合法脚本体）。
const LAUNCH_OK_SEED = [
  "/* zcode-workflow",
  "description: 常量工作流（直接启动 E2E）",
  "args:",
  "  topic:",
  "    type: string",
  "    required: true",
  "*/",
  "return { ok: true };",
  "",
].join("\n");

// 在跑一段时间的常量工作流（composer 徽标直达 E2E，docs/dynamic-workflow/presentation.md）：
// 零 agent、零 provider，靠 `world.run("sleep", …)` 停留在 running——这是沙箱里唯一不需要模型
// 又能让 run 停住的手段（沙箱 realm 只有 ES intrinsics，没有 setTimeout）。cmd 是编译期字面量，
// 直接启动把它编进 declaredRunCommands，不需要确认窗。无实参的项目档点「运行」即跑、不弹实参窗。
// 注：`sleep` 依赖 POSIX 环境；桌面 e2e 只在 macOS / Linux 容器里跑。
const LAUNCH_SLEEP_NAME = "direct-launch-sleeping";
const LAUNCH_SLEEP_FILE = join(WORKFLOWS_DIR, `${LAUNCH_SLEEP_NAME}.dwf.ts`);
const LAUNCH_SLEEP_SEED = [
  "/* zcode-workflow",
  "description: 停留 running 的常量工作流（composer 徽标直达 E2E）",
  "*/",
  'await world.run("sleep", ["40"]);',
  "return { ok: true };",
  "",
].join("\n");

// 保存 / 再次运行（docs/dynamic-workflow/transcript-and-notifications.md「Saving the run, and running
// it again」）：无实参的项目档，点「运行」即跑。脚本体与本组其他常量工作流逐字不同——「按 run 跑的
// 那一份认出已保存」这条规则必须只能命中它自己。
const LAUNCH_SAVE_NAME = "direct-launch-save";
const LAUNCH_SAVE_FILE = join(WORKFLOWS_DIR, `${LAUNCH_SAVE_NAME}.dwf.ts`);
const LAUNCH_SAVE_SCRIPT = "return { ok: true, savedFromRun: 1 };\n";
const LAUNCH_SAVE_SEED = [
  "/* zcode-workflow",
  "description: 保存与再次运行（直接启动 E2E）",
  "*/",
  LAUNCH_SAVE_SCRIPT,
].join("\n");

// 「作为文件打开」（docs/dynamic-workflow/authoring.md「How the user sees them」）：零 agent 的常量工作流
// 发布一份 markdown 产物，run 完成后从侧板打开产物 tab，点「作为文件打开」。系统默认 App 那一跳由
// shell.openPath 的 mock 接住——断言的是它收到的路径，以及那个路径上真的落了这一版的字节。
const LAUNCH_ARTIFACT_NAME = "direct-launch-artifact";
const LAUNCH_ARTIFACT_FILE = join(WORKFLOWS_DIR, `${LAUNCH_ARTIFACT_NAME}.dwf.ts`);
const LAUNCH_ARTIFACT_ID = "e2e-report";
const LAUNCH_ARTIFACT_MARKDOWN = "# E2E 报告\n\n作为文件打开。\n";
const LAUNCH_ARTIFACT_SEED = [
  "/* zcode-workflow",
  "description: 发布 markdown 产物（作为文件打开 E2E）",
  "*/",
  `await artifact.markdown(${JSON.stringify(LAUNCH_ARTIFACT_ID)}, ${JSON.stringify(
    LAUNCH_ARTIFACT_MARKDOWN,
  )}, { title: "E2E 报告" });`,
  "return { ok: true };",
  "",
].join("\n");

const LAUNCH_FAIL_NAME = "direct-launch-broken";
const LAUNCH_FAIL_FILE = join(WORKFLOWS_DIR, `${LAUNCH_FAIL_NAME}.dwf.ts`);
// frontmatter 仍然合法（卡片照常出现、实参窗照常弹），脚本体带一个类型错误（TS2322：把字符串
// 赋给 number）。编译只在启动的 ② 阶段发生，因此错误在 startSavedWorkflow 的 ACK 里以
// compile_failed 回来，被实参窗行内错误区接住——会话在此之前不存在（不变式 2）。
const LAUNCH_FAIL_SEED = [
  "/* zcode-workflow",
  "description: 编译失败工作流（直接启动 E2E）",
  "args:",
  "  topic:",
  "    type: string",
  "    required: true",
  "*/",
  'const answer: number = "not a number";',
  "return answer;",
  "",
].join("\n");

// 脚本点名了一个本机目录里没有的模型（docs/dynamic-workflow/launch.md「Models the script names」）：
// 编译本身干净，解不出来的名字按 9011 与编译诊断同一条路拒绝（compile_failed）。脚本里只**声明**
// 这个子代理、从不 ask 它，所以即使解析意外放行也不会碰 provider。
const LAUNCH_MODEL_NAME = "direct-launch-unknown-model";
const LAUNCH_MODEL_FILE = join(WORKFLOWS_DIR, `${LAUNCH_MODEL_NAME}.dwf.ts`);
const LAUNCH_MODEL_UNKNOWN = "no-such-model-e2e";
const LAUNCH_MODEL_SEED = [
  "/* zcode-workflow",
  "description: 点名未知模型的工作流（直接启动 E2E）",
  "args:",
  "  topic:",
  "    type: string",
  "    required: true",
  "*/",
  `agent("judge", { model: "${LAUNCH_MODEL_UNKNOWN}" });`,
  "return 1;",
  "",
].join("\n");

// 实参很多的工作流（docs/dynamic-workflow/launch.md「The launch dialog」的三段式布局）：40 个声明
// 的实参远高于视口，其中靠中间的一个是无默认值的必填项——既断言窗口不溢出、按钮够得着，也断言
// 校验失败时那个字段被带进视野。每三个里有一个 boolean：开关在 form 里带一个绝对定位的隐藏原生
// 控件，它曾经逃出实参滚动区、把窗口自身也撑出一条滚动条。脚本体是常量，本用例也从不真正启动它。
const LAUNCH_MANY_NAME = "direct-launch-many-args";
const LAUNCH_MANY_FILE = join(WORKFLOWS_DIR, `${LAUNCH_MANY_NAME}.dwf.ts`);
const LAUNCH_MANY_COUNT = 40;
const LAUNCH_MANY_REQUIRED = "arg20";
const LAUNCH_MANY_SEED = [
  "/* zcode-workflow",
  "description: 实参很多的常量工作流（实参窗限高 E2E）",
  "args:",
  ...Array.from({ length: LAUNCH_MANY_COUNT }, (_, index) => {
    const name = `arg${String(index).padStart(2, "0")}`;
    if (name === LAUNCH_MANY_REQUIRED) {
      return [`  ${name}:`, "    type: string", "    required: true"];
    }
    return index % 3 === 0
      ? [`  ${name}:`, "    type: boolean", "    default: true"]
      : [`  ${name}:`, "    type: string", `    default: v${index}`];
  }).flat(),
  "*/",
  "return { ok: true };",
  "",
].join("\n");

interface LaunchDialogGeometry {
  viewportHeight: number;
  dialogTop: number;
  dialogBottom: number;
  /** 提交按钮中心点上最上层的元素就是它自己（没被裁掉、没被盖住、在视口内）。 */
  submitHit: boolean;
  /** 窗口自身是否可滚：实参区之外不该再有第二条滚动条。 */
  dialogScrolls: boolean;
  fieldsClientHeight: number;
  fieldsScrollHeight: number;
  /** 指定实参控件是否完整落在滚动区的可视范围内。 */
  argVisible: boolean;
  argFocused: boolean;
}

/** 量实参窗：窗口与视口的关系、提交按钮是否点得到、滚动区的高度，以及某个实参控件的可见性。 */
async function readLaunchDialogGeometry(argName: string): Promise<LaunchDialogGeometry | null> {
  return browser.execute(
    (dialogTid, fieldsTid, submitTid, argTid) => {
      const byTestId = (tid: string) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === tid,
        );
      const dialog = byTestId(dialogTid);
      const fields = byTestId(fieldsTid);
      const submit = byTestId(submitTid);
      const arg = byTestId(argTid);
      if (!dialog || !fields || !submit || !arg) return null;
      const dialogRect = dialog.getBoundingClientRect();
      const submitRect = submit.getBoundingClientRect();
      const fieldsRect = fields.getBoundingClientRect();
      const argRect = arg.getBoundingClientRect();
      const top = document.elementFromPoint(
        submitRect.left + submitRect.width / 2,
        submitRect.top + submitRect.height / 2,
      );
      return {
        viewportHeight: window.innerHeight,
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        submitHit: top !== null && submit.contains(top),
        dialogScrolls: dialog.scrollHeight > dialog.clientHeight,
        fieldsClientHeight: fields.clientHeight,
        fieldsScrollHeight: fields.scrollHeight,
        argVisible: argRect.top >= fieldsRect.top && argRect.bottom <= fieldsRect.bottom,
        argFocused: document.activeElement === arg,
      };
    },
    TID_WORKFLOW_LAUNCH_DIALOG,
    TID_WORKFLOW_LAUNCH_FIELDS,
    TID_WORKFLOW_LAUNCH_SUBMIT,
    testId(TID_WORKFLOW_LAUNCH_ARG, argName),
  );
}

/** 按前缀读某个 testid 元素的可见文本（启动卡 / 任务项的 testid 后缀是运行期才知道的 key）。 */
async function readTestIdPrefixText(prefix: string): Promise<string | null> {
  return browser.execute((currentPrefix) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid?.startsWith(currentPrefix),
    );
    return element?.textContent?.replace(/ /g, " ").trim() ?? null;
  }, prefix);
}

/**
 * 启动轮 run 卡当前的 run 状态（`data-workflow-run-status`）；卡不在时为 null。直接启动的会话顶部长出的
 * 就是普通的轮尾 run 卡（docs/dynamic-workflow/presentation.md「The run card」），不是别的卡。
 */
async function readLaunchCardStatus(): Promise<string | null> {
  return browser.execute(
    (prefix) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (item) => item.dataset.testid?.startsWith(prefix),
      );
      return card?.getAttribute("data-workflow-run-status") ?? null;
    },
    testId(TID_CHAT_WORKFLOW_RUN_DIGEST, ""),
  );
}

/** 读 run 详情侧板来龙去脉节的可见文本（docs/dynamic-workflow/launch.md「The launch turn」）。 */
async function readLaunchProvenanceText(): Promise<string | null> {
  return browser.execute(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="workflow-run-provenance"]');
    return element?.textContent?.replace(/ /g, " ").trim() ?? null;
  });
}

/** 侧栏任务项数量（compile_failed 用例比较提交前后不变）。 */
async function countTaskItems(): Promise<number> {
  return browser.execute(
    (prefix) => document.querySelectorAll(`[data-testid^="${prefix}"]`).length,
    testId(TID_TASK_ITEM, ""),
  );
}

/** 侧栏所有任务项的文本拼接（断言会话标题里出现工作流名）。 */
async function readTaskItemsText(): Promise<string> {
  return browser.execute(
    (prefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
        .map((item) => item.textContent?.replace(/ /g, " ") ?? "")
        .join("\n"),
    testId(TID_TASK_ITEM, ""),
  );
}

/** 会话转写（v4 timeline）的全文（断言没有旧的合成 prompt 文案）。 */
async function readTimelineText(): Promise<string> {
  return browser.execute((timelineTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
    return element?.textContent?.replace(/ /g, " ") ?? "";
  }, TID_V4_TIMELINE);
}

describe("直接启动 E2E", () => {
  before(async () => {
    await mkdir(WORKFLOWS_DIR, { recursive: true });
    await writeFile(LAUNCH_OK_FILE, LAUNCH_OK_SEED, "utf-8");
    await writeFile(LAUNCH_FAIL_FILE, LAUNCH_FAIL_SEED, "utf-8");
    await writeFile(LAUNCH_MANY_FILE, LAUNCH_MANY_SEED, "utf-8");
    await writeFile(LAUNCH_MODEL_FILE, LAUNCH_MODEL_SEED, "utf-8");
    await writeFile(LAUNCH_SLEEP_FILE, LAUNCH_SLEEP_SEED, "utf-8");
    await writeFile(LAUNCH_SAVE_FILE, LAUNCH_SAVE_SEED, "utf-8");
    await writeFile(LAUNCH_ARTIFACT_FILE, LAUNCH_ARTIFACT_SEED, "utf-8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(WORKFLOWS_DIR, { recursive: true, force: true });
    await clearAppData();
  });

  it("中枢「运行」常量工作流：新会话顶部启动卡跑到 completed，无用户气泡、无确认窗", async function () {
    this.timeout(180000);

    // 只需要登录 + workspace，就绪即可；常量工作流不碰 provider（见组注释）。
    await prepareHubCase();

    // 1) 自动化页 →「工作流」标签 → 常量工作流的卡片。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    const okCardTestId = testId(TID_WORKFLOW_CARD, LAUNCH_OK_NAME);
    await waitForTestIdByDom(okCardTestId, {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现常量工作流卡片",
    });

    // 2) 点卡片的「运行」→ 有实参的项目档弹出实参窗：头部 = 名字 + 作用域徽标，且带「新会话」说明。
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_OK_NAME), {
      timeoutMsg: "常量工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const dialogText = (await readTestIdPrefixText(TID_WORKFLOW_LAUNCH_DIALOG)) ?? "";
    expect(dialogText).toContain(LAUNCH_OK_NAME); // 名字（mono）
    expect(dialogText).toContain("项目"); // 作用域徽标（scope.project）
    expect(dialogText).toContain("的新会话中运行"); // 「将立即在 X 的新会话中运行」说明

    // 3) 填实参并提交。提交前记下任务数，稍后新会话应比它多一个。
    const tasksBeforeLaunch = await countTaskItems();
    await setInputValueByTestIdDom(
      testId(TID_WORKFLOW_LAUNCH_ARG, LAUNCH_OK_ARG),
      LAUNCH_OK_ARG_VALUE,
      {
        timeoutMsg: "实参窗没有出现 topic 输入框",
      },
    );
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });

    // 4) 应用切到新会话，转写顶部长出 run 卡（不是用户气泡、不是 CreateWorkflow 工具行），
    //    卡上带工作流名；实参值不在卡上，而在 run 详情侧板的来龙去脉节里。
    const launchCardPrefix = testId(TID_CHAT_WORKFLOW_RUN_DIGEST, "");
    await browser.waitUntil(
      async () =>
        (await readLaunchCardStatus()) !== null ||
        Boolean(await readTestIdPrefixText(launchCardPrefix)),
      {
        timeout: 60000,
        timeoutMsg: "新会话顶部没有出现 run 卡",
      },
    );
    const cardText = (await readTestIdPrefixText(launchCardPrefix)) ?? "";
    expect(cardText).toContain(LAUNCH_OK_NAME);
    expect(cardText).not.toContain(LAUNCH_OK_ARG_VALUE);

    // 4b) 卡上的 ⤢ 开 run 详情侧板：来龙去脉节写着「由你从工作流中枢启动」、作用域与刚填的实参值。
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await browser.waitUntil(async () => (await readLaunchProvenanceText()) !== null, {
      timeout: 30000,
      timeoutMsg: "run 详情侧板没有出现来龙去脉节",
    });
    const provenanceText = (await readLaunchProvenanceText()) ?? "";
    expect(provenanceText).toContain(LAUNCH_OK_ARG_VALUE);

    // 5) 无用户气泡、无旧的合成 prompt 文案：转写里不出现「Run the saved workflow」这类
    //    被本 spec 删除的 composer 文案。
    expect(await readTimelineText()).not.toContain("Run the saved workflow");

    // 6) 无确认窗：直接启动是记录在案的确认旁路，通用二次确认窗不应出现。
    const hasConfirmDialog = await browser.execute(
      (confirmTestId) => Boolean(document.querySelector(`[data-testid="${confirmTestId}"]`)),
      TID_CONFIRM_DIALOG_CONFIRM,
    );
    expect(hasConfirmDialog).toBe(false);

    // 7) run 卡的状态跑到 completed（常量工作流零 agent，立即结算）。宽超时：
    //    run-started → run-settled 走真实 dwf 运行时的子进程。
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });

    // 8) 侧栏会话标题 = 工作流名（titleSource: first_input，不用消息全文、不等 LLM）；
    //    且确实新开了一个会话。
    await browser.waitUntil(async () => (await countTaskItems()) === tasksBeforeLaunch + 1, {
      timeout: 20000,
      timeoutMsg: "直接启动后没有新增一个会话",
    });
    expect(await readTaskItemsText()).toContain(LAUNCH_OK_NAME);
  });

  it("编译失败的工作流：实参窗行内错误显示 compile_failed，会话列表不新增", async function () {
    this.timeout(150000);

    await prepareHubCase();

    // 1) 自动化页 →「工作流」标签 → 编译失败工作流的卡片（frontmatter 合法，卡片照常出现）。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    const failCardTestId = testId(TID_WORKFLOW_CARD, LAUNCH_FAIL_NAME);
    await waitForTestIdByDom(failCardTestId, {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现编译失败工作流卡片",
    });

    // 2) 「运行」→ 实参窗 → 填实参并提交。记下提交前的任务数。
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_FAIL_NAME), {
      timeoutMsg: "编译失败工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const tasksBeforeReject = await countTaskItems();
    await setInputValueByTestIdDom(testId(TID_WORKFLOW_LAUNCH_ARG, LAUNCH_OK_ARG), "x", {
      timeoutMsg: "实参窗没有出现 topic 输入框",
    });
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });

    // 3) 行内错误区出现，标题是 compile_failed 的文案；实参窗留着（不导航、不留会话）。
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_ERROR, {
      timeout: 30000,
      timeoutMsg: "编译失败没有在实参窗行内错误区显示",
    });
    const errorText = (await readTestIdPrefixText(TID_WORKFLOW_LAUNCH_ERROR)) ?? "";
    expect(errorText).toContain("工作流脚本编译失败");
    // 实参窗仍在（失败不关窗）。
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeoutMsg: "编译失败后实参窗被意外关闭",
    });

    // 4) 会话列表没有新增：agent 侧 ① ② 阶段失败前不建任何行，GUI 侧随即 deleteSession
    //    收回刚建的空会话（不变式 2）。
    await browser.waitUntil(async () => (await countTaskItems()) === tasksBeforeReject, {
      timeout: 15000,
      timeoutMsg: "编译失败却新增了一个会话",
    });
  });

  it("实参很多的工作流：实参窗不溢出视口，实参区自己滚动，校验失败把出错字段带进视野", async function () {
    this.timeout(150000);

    await prepareHubCase();

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_MANY_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现实参很多的工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_MANY_NAME), {
      timeoutMsg: "实参很多的工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const tasksBefore = await countTaskItems();

    // 1) 窗口整个在视口内，提交按钮点得到；实参区的内容比它的可视高度长，靠它自己滚动。
    //    必填项在列表中段，此刻还在可视区之外。等开窗动画（缩放）结束后再量。
    await browser.waitUntil(
      async () => {
        const geometry = await readLaunchDialogGeometry(LAUNCH_MANY_REQUIRED);
        return (
          geometry !== null &&
          geometry.dialogTop >= 0 &&
          geometry.dialogBottom <= geometry.viewportHeight &&
          geometry.submitHit
        );
      },
      { timeout: 15000, timeoutMsg: "实参很多时实参窗溢出了视口，或提交按钮点不到" },
    );
    const opened = await readLaunchDialogGeometry(LAUNCH_MANY_REQUIRED);
    expect(opened?.fieldsScrollHeight ?? 0).toBeGreaterThan(opened?.fieldsClientHeight ?? 0);
    expect(opened?.argVisible).toBe(false);
    // 只有实参区这一条滚动条：窗口自身不可滚。
    expect(opened?.dialogScrolls).toBe(false);

    // 2) 必填项留空直接提交：校验失败，那个字段被滚进可视区并拿到焦点；按钮仍然点得到。
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });
    await browser.waitUntil(
      async () => {
        const geometry = await readLaunchDialogGeometry(LAUNCH_MANY_REQUIRED);
        return geometry !== null && geometry.argVisible && geometry.argFocused;
      },
      { timeout: 15000, timeoutMsg: "校验失败后出错的必填字段没有被带进视野并聚焦" },
    );
    const revealed = await readLaunchDialogGeometry(LAUNCH_MANY_REQUIRED);
    expect(revealed?.submitHit).toBe(true);
    expect(revealed?.dialogScrolls).toBe(false);
    expect(revealed?.dialogTop ?? -1).toBeGreaterThanOrEqual(0);

    // 3) 校验失败不启动：实参窗留着，会话列表不新增。
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeoutMsg: "校验失败后实参窗被意外关闭",
    });
    expect(await countTaskItems()).toBe(tasksBefore);
  });

  it("脚本点名的模型解不出来：实参窗行内显示 compile_failed 与那个名字的 9011，会话列表不新增", async function () {
    this.timeout(150000);

    await prepareHubCase();

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_MODEL_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现点名未知模型的工作流卡片",
    });

    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_MODEL_NAME), {
      timeoutMsg: "点名未知模型的工作流卡片没有「运行」按钮",
    });
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeout: 15000,
      timeoutMsg: "点「运行」后没有弹出实参窗",
    });
    const tasksBefore = await countTaskItems();
    await setInputValueByTestIdDom(testId(TID_WORKFLOW_LAUNCH_ARG, LAUNCH_OK_ARG), "x", {
      timeoutMsg: "实参窗没有出现 topic 输入框",
    });
    await clickTestIdByDom(TID_WORKFLOW_LAUNCH_SUBMIT, {
      timeoutMsg: "实参窗没有「运行」提交按钮",
    });

    // 与脚本编不过同一个出口：标题是 compile_failed 的文案，细节是一条带位置的诊断。
    // 宿主有目录时细节点出名字；没有目录时说「这台宿主选不了模型」——两种都是脚本侧的改法。
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_ERROR, {
      timeout: 30000,
      timeoutMsg: "解不出来的模型没有在实参窗行内错误区显示",
    });
    const errorText = (await readTestIdPrefixText(TID_WORKFLOW_LAUNCH_ERROR)) ?? "";
    expect(errorText).toContain("工作流脚本编译失败");
    expect(errorText).toMatch(/L\d+:C\d+/);
    expect(
      errorText.includes(LAUNCH_MODEL_UNKNOWN) || errorText.includes("cannot choose models"),
    ).toBe(true);
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, {
      timeoutMsg: "解不出来的模型让实参窗被意外关闭",
    });
    await browser.waitUntil(async () => (await countTaskItems()) === tasksBefore, {
      timeout: 15000,
      timeoutMsg: "解不出来的模型却新增了一个会话",
    });
  });

  // composer 徽标直达（docs/dynamic-workflow/presentation.md「Other places a run appears」）：
  // 会话里唯一在跑的是一条工作流时，点徽标不展开状态胶囊，直接打开该 run 的详情 side tab。
  it("唯一在跑的工作流：composer 徽标直达详情 side tab，状态胶囊不展开", async function () {
    this.timeout(180000);

    await prepareHubCase();

    // 1) 自动化页 →「工作流」标签 → 无实参的项目档点「运行」即跑（不弹实参窗、不弹确认窗）。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_SLEEP_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现停留 running 的常量工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_SLEEP_NAME), {
      timeoutMsg: "常量工作流卡片没有「运行」按钮",
    });

    // 2) 新会话顶部长出 run 卡，run 进入 running（world.run 的 sleep 让它停在这里）。
    const launchCardPrefix = testId(TID_CHAT_WORKFLOW_RUN_DIGEST, "");
    await browser.waitUntil(async () => Boolean(await readTestIdPrefixText(launchCardPrefix)), {
      timeout: 60000,
      timeoutMsg: "新会话顶部没有出现 run 卡",
    });

    // 2b) 侧栏运行行（docs/dynamic-workflow/presentation.md「The sidebar run line」）：发起它的会话行在标题下
    //     长出一条 running 的运行行；sleep 脚本没有 phase() 标记，所以轨道是一个隐含站点。
    await browser.waitUntil(
      async () =>
        browser.execute(
          (prefix) => {
            const rows = Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
            );
            return rows.some((row) => {
              const line = row.querySelector<HTMLElement>(
                '[data-workflow-run-line][data-run-status="running"]',
              );
              return (
                line !== null &&
                line.querySelector('[data-workflow-run-rail][data-implicit="true"]') !== null
              );
            });
          },
          testId(TID_TASK_ITEM, ""),
        ),
      { timeout: 60000, timeoutMsg: "侧栏里发起工作流的会话行没有长出 running 的运行行" },
    );

    // 2c) 状态胶囊（docs/dynamic-workflow/presentation.md「Other places a run appears」）：在跑的工作流
    //     排在胶囊最前，按名字显示（名字 · 灯 · 词），不再是「1 后台」这样的计数。
    await browser.waitUntil(
      async () =>
        browser.execute((panelTestId) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          const pill = panel?.querySelector<HTMLElement>("[data-workflow-pill]");
          const button = pill?.closest("button");
          return (
            pill !== null &&
            pill !== undefined &&
            (pill.textContent ?? "").trim().length > 0 &&
            button?.querySelector('[data-workflow-run-lamp="running"]') !== null
          );
        }, TID_CHAT_SUMMARY_PANEL),
      { timeout: 30000, timeoutMsg: "状态胶囊没有按名字显示在跑的工作流" },
    );

    // 2d) 胶囊不盖住启动卡（docs/dynamic-workflow/presentation.md「The run card」，转写顶部 inset）：
    //     启动轮是会话首轮且没有气泡，卡头部的配置 / 停止 / ⤢ 曾落在胶囊下面。clickTestIdByDom 走 DOM
    //     click 不做命中测试，所以这里按按钮中心点 elementFromPoint，命中的必须是按钮自己。
    const coveredHeaderButtons = await browser.execute(() => {
      const header = document.querySelector<HTMLElement>('[data-testid="workflow-card-header"]');
      const buttons = Array.from(header?.querySelectorAll<HTMLElement>("button") ?? []);
      if (buttons.length === 0) return ["<no header buttons>"];
      return buttons
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return !button.contains(hit);
        })
        .map((button) => button.getAttribute("aria-label") ?? button.outerHTML.slice(0, 80));
    });
    expect(coveredHeaderButtons).toEqual([]);

    // 3) composer 徽标：恰好一条 workflow、没有终端与子代理，且自述落点是 workflow-run。
    await browser.waitUntil(
      async () => {
        const counts = await getV4ComposerBackgroundWorkCounts();
        return (
          counts?.workflowCount === 1 &&
          counts.bashCount === 0 &&
          counts.subagentCount === 0 &&
          counts.totalCount === 1 &&
          counts.openTarget === "workflow-run"
        );
      },
      { timeout: 60000, timeoutMsg: "composer 徽标没有以 workflow-run 落点显示唯一在跑的工作流" },
    );
    const panelModeBefore = await browser.execute(
      (panelTestId) =>
        document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`)?.dataset
          .displayMode ?? null,
      TID_CHAT_SUMMARY_PANEL,
    );
    expect(panelModeBefore).not.toBe("panel");

    // 4) 点徽标 → 侧板出现该 run 的 workflow-run tab（结构化 id 前缀），胶囊没有被置成 panel。
    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER, {
      timeoutMsg: "composer 后台任务入口不可点击",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(document.querySelector('[data-side-pane-tab-id^="workflow-run:"]')),
        ),
      { timeout: 30000, timeoutMsg: "点徽标后侧板没有打开 workflow-run tab" },
    );
    const panelModeAfter = await browser.execute(
      (panelTestId) =>
        document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`)?.dataset
          .displayMode ?? null,
      TID_CHAT_SUMMARY_PANEL,
    );
    expect(panelModeAfter).not.toBe("panel");

    // 5) 点胶囊展开：「工作流」分区随之打开，不用再点分区头——展开后看到的不能比胶囊还少
    //    （docs/dynamic-workflow/presentation.md「Other places a run appears」）。run 行两行定高：第一行
    //    名字 + 时长，第二行灯 + 词（sleep 脚本没有 phase() 标记，所以是一盏运行灯 + 步数）。悬停这一行
    //    时 Stop 叠在时长上出现。
    await browser.execute((panelTestId) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      panel?.querySelector<HTMLElement>("[data-workflow-pill]")?.closest("button")?.click();
    }, TID_CHAT_SUMMARY_PANEL);
    const rowSelector = 'li[data-background-task-kind="workflow"]';
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const row = document.querySelector<HTMLElement>(selector);
          return (
            row !== null &&
            row.querySelector('[data-workflow-island-line="name"] [data-workflow-run-elapsed]') !==
              null &&
            row.querySelector(
              '[data-workflow-island-line="phase"] [data-workflow-run-lamp="running"]',
            ) !== null
          );
        }, rowSelector),
      {
        timeout: 15000,
        timeoutMsg: "点开胶囊后「工作流」分区没有直接显示 run 行（名字 + 时长 / 灯 + 词两行）",
      },
    );
    // 面板展开会移动 run 行；按当前布局重新悬停，并确认真实 hover 后再检查 Stop。
    await browser.waitUntil(
      async () => {
        await $(rowSelector).moveTo();
        return browser.execute((selector) => {
          const row = document.querySelector<HTMLElement>(selector);
          const stop = row?.querySelector<HTMLElement>(
            '[data-testid^="v4-background-work-cancel-"]',
          );
          return Boolean(row?.matches(":hover") && stop && getComputedStyle(stop).opacity === "1");
        }, rowSelector);
      },
      { timeout: 5000, timeoutMsg: "悬停 run 行时 Stop 没有出现" },
    );
  });

  // 并发芯片（docs/dynamic-workflow/concurrency.md「What the user sees」）：芯片的数是一条界，字是
  // 「最大并发数」；它与 Configure 同进同退——run 在跑时就地调小界，芯片出现；run 完成后芯片离开，
  // 不再把一条已经没有东西在它下面跑的界挂成实时读数。
  it("并发芯片：在跑的 run 就地调小界后显示「最大并发数 N」，run 完成后芯片离开", async function () {
    this.timeout(180000);

    await prepareHubCase();

    // 1) 跑那条停留 running 的常量工作流（world.run sleep 40s），打开它的 run 侧板。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_SLEEP_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现停留 running 的常量工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_SLEEP_NAME), {
      timeoutMsg: "常量工作流卡片没有「运行」按钮",
    });
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "running", {
      timeout: 60000,
      timeoutMsg: "run 卡没有进入 running",
    });
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await waitForTestIdByDom("workflow-run-configure", {
      timeout: 30000,
      timeoutMsg: "在跑的 run 侧板上没有 Configure",
    });

    // 2) 跑在默认并发 D 上（没有自己的界）：没有芯片。
    expect(await readTestIdText("workflow-run-concurrency")).toBeNull();

    // 3) Configure → 步进器减一 → 应用：只改界、run 在跑，就地生效（不另起 run）。
    await clickRunSidePaneControl("workflow-run-configure");
    await waitForTestIdByDom("workflow-run-settings-popover", {
      timeoutMsg: "点 Configure 后没有设置弹层",
    });
    // 步进器停在默认并发 D = max(4, min(16, 核数 − 2)) 上，减一总有可调小的余地。
    // 控件已改成 input；textContent 恒为空，Number("") 会把默认界误读为 0。
    const boundInput = $('[data-testid="workflow-run-settings-bound-value"]');
    const defaultBound = Number(await boundInput.getValue());
    expect(defaultBound).toBeGreaterThan(1);
    // 还没改：没有后果句（改动之前念哪一句都可能说错）。
    expect(await readTestIdText("workflow-run-settings-consequence")).toBe("");
    await clickTestIdByDom("workflow-run-settings-bound-decrease", {
      timeoutMsg: "设置弹层没有「降低最大并发数」",
    });
    await expect(boundInput).toHaveValue(String(defaultBound - 1));
    // 只改界、run 在跑：后果句是「就地生效」，不是「将停止当前运行」。
    expect(await readTestIdText("workflow-run-settings-consequence")).toMatch(
      /^(立即应用到当前运行，不会新起一次运行。|Applies to this run right away; no new run is started\.)$/,
    );
    await clickTestIdByDom("workflow-run-settings-apply", { timeoutMsg: "设置弹层没有「应用」" });

    // 4) 芯片出现，字是界的字，数是调小后的界。
    await browser.waitUntil(
      async () => {
        const text = await readTestIdText("workflow-run-concurrency");
        return (
          text !== null &&
          new RegExp(`^(最大并发数|Max concurrency) ${defaultBound - 1}\\b`).test(text)
        );
      },
      { timeout: 30000, timeoutMsg: "就地调小界后 run 侧板没有出现「最大并发数 N」芯片" },
    );

    // 5) run 跑完（sleep 结束）：Configure 与芯片一起离开。
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });
    await browser.waitUntil(
      async () =>
        (await readTestIdText("workflow-run-concurrency")) === null &&
        (await readTestIdText("workflow-run-configure")) === null,
      { timeout: 20000, timeoutMsg: "run 完成后侧板上仍有并发芯片或 Configure" },
    );
  });

  it("完成的 run：侧板有「已保存」与「再次运行」，芯片直达中枢；删掉后「保存」按原样写回同一份脚本", async function () {
    this.timeout(240000);

    await prepareHubCase();

    // 1) 中枢「运行」无实参的项目档：点即跑，新会话顶部的 run 卡跑到 completed。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_SAVE_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现保存用例的工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_SAVE_NAME), {
      timeoutMsg: "保存用例的工作流卡片没有「运行」按钮",
    });
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });

    // 2) ⤢ 打开 run 侧板：从中枢启动的 run 按名字规则天然「已保存」——芯片在状态行，动词是「再次运行」。
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await waitForTestIdByDom("workflow-saved-chip", {
      timeout: 30000,
      timeoutMsg: "run 侧板状态行没有出现「已保存」芯片",
    });
    await waitForTestIdByDom("workflow-save-run-again", {
      timeout: 10000,
      timeoutMsg: "run 侧板没有「再次运行」",
    });

    // 3) 芯片直达中枢里那个工作流的详情页。
    await clickRunSidePaneControl("workflow-saved-chip");
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, {
      timeout: 20000,
      timeoutMsg: "点芯片后没有进入工作流详情页",
    });
    expect((await readTestIdText(TID_WORKFLOW_DETAIL)) ?? "").toContain(LAUNCH_SAVE_NAME);

    // 4) 在中枢把它删掉：中枢刷新会作废卡片的读缓存，这次 run 不再「已保存」。
    await clickTestIdByWebDriver(TID_WORKFLOW_DETAIL_MENU, {
      timeoutMsg: "详情页没有「更多操作」菜单",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_ACTION_DELETE, LAUNCH_SAVE_NAME), {
      timeoutMsg: "详情页菜单没有「删除工作流」项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await browser.waitUntil(async () => !(await fileExists(LAUNCH_SAVE_FILE)), {
      timeout: 10000,
      timeoutMsg: "删除后磁盘文件仍然存在",
    });

    // 5) 回到发起它的会话，侧板上的动词翻回「保存」。
    const sessionTaskTestId = await browser.execute(
      (prefix, name) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)).find(
          (item) => item.textContent?.includes(name),
        )?.dataset.testid ?? null,
      testId(TID_TASK_ITEM, ""),
      LAUNCH_SAVE_NAME,
    );
    expect(sessionTaskTestId).not.toBeNull();
    await clickTestIdByDom(sessionTaskTestId!, { timeoutMsg: "侧栏里点不到发起它的会话" });
    await clickTestIdByDom("workflow-card-open-details", {
      timeout: 20000,
      timeoutMsg: "回到会话后 run 卡上没有「打开运行详情」",
    });
    await waitForTestIdByDom("workflow-save-open", {
      timeout: 30000,
      timeoutMsg: "删掉工作流之后 run 侧板没有翻回「保存」",
    });

    // 6) 「保存」→ 弹层 → 按原样直接保存：不经模型回合，写下的是这次 run 实际执行的那一份脚本。
    await clickRunSidePaneControl("workflow-save-open");
    await waitForTestIdByDom("workflow-save-popover", { timeoutMsg: "点「保存」后没有弹层" });
    await setInputValueByTestIdDom("workflow-save-name", LAUNCH_SAVE_NAME, {
      timeoutMsg: "保存弹层没有名称输入框",
    });
    await clickTestIdByDom("workflow-save-submit", { timeoutMsg: "保存弹层没有「直接保存」" });
    await browser.waitUntil(async () => fileExists(LAUNCH_SAVE_FILE), {
      timeout: 20000,
      timeoutMsg: "直接保存后磁盘上没有出现工作流文件",
    });
    const written = await readFile(LAUNCH_SAVE_FILE, "utf-8");
    expect(written.startsWith("/* zcode-workflow")).toBe(true);
    expect(written.endsWith(`*/\n${LAUNCH_SAVE_SCRIPT}`)).toBe(true);

    // 7) 卡片立刻翻面：芯片回来，动词又是「再次运行」。
    await waitForTestIdByDom("workflow-saved-chip", {
      timeout: 20000,
      timeoutMsg: "直接保存后 run 侧板没有出现「已保存」芯片",
    });
    await waitForTestIdByDom("workflow-save-run-again", {
      timeout: 10000,
      timeoutMsg: "直接保存后 run 侧板没有翻成「再次运行」",
    });
  });

  it("产物 tab「作为文件打开」：把这一版的 markdown 落成本机副本，交给系统默认 App", async function () {
    this.timeout(240000);

    await prepareHubCase();

    // 1) 中枢「运行」无实参的项目档：点即跑，run 发布一份 markdown 产物后 completed。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, LAUNCH_ARTIFACT_NAME), {
      timeout: 20000,
      timeoutMsg: "工作流列表没有出现产物用例的工作流卡片",
    });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, LAUNCH_ARTIFACT_NAME), {
      timeoutMsg: "产物用例的工作流卡片没有「运行」按钮",
    });
    await browser.waitUntil(async () => (await readLaunchCardStatus()) === "completed", {
      timeout: 90000,
      timeoutMsg: "run 卡的状态没有跑到 completed",
    });

    // 2) ⤢ 打开 run 侧板 → 唯一的产物即主产物行 → 产物 tab，正文是 markdown。
    await clickTestIdByDom("workflow-card-open-details", {
      timeoutMsg: "run 卡上没有「打开运行详情」",
    });
    await clickTestIdByDom(TID_WORKFLOW_ARTIFACT_CARD, {
      timeout: 30000,
      timeoutMsg: "run 侧板没有出现产物行",
    });
    await waitForTestIdByDom(TID_WORKFLOW_ARTIFACT_PANE, {
      timeout: 20000,
      timeoutMsg: "点产物行后没有打开产物 tab",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() => Boolean(document.querySelector('[data-artifact-body="markdown"]'))),
      { timeout: 20000, timeoutMsg: "产物 tab 没有画出 markdown 正文" },
    );

    // 3) 点「作为文件打开」：main 落副本，再经 shell.openPath 交给系统默认 App（这里被 mock 接住）。
    const openPath = await browser.electron.mock("shell", "openPath");
    await openPath.mockResolvedValue("");
    try {
      const readOpenedPaths = async (): Promise<string[]> => {
        await openPath.update();
        return openPath.mock.calls.map(([path]) => String(path));
      };
      await clickTestIdByDom("workflow-artifact-open-as-file", {
        timeoutMsg: "产物 tab 头部没有「作为文件打开」",
      });
      await browser.waitUntil(async () => (await readOpenedPaths()).length === 1, {
        timeout: 15000,
        timeoutMsg: "「作为文件打开」没有经 shell.openPath 打开文件",
      });
      const [openedPath] = await readOpenedPaths();
      expect(openedPath).toContain(join("tmp", "workflow-artifacts"));
      expect(openedPath!.endsWith(join("v1", `${LAUNCH_ARTIFACT_ID}.md`))).toBe(true);
      expect(await readFile(openedPath!, "utf-8")).toBe(LAUNCH_ARTIFACT_MARKDOWN);

      // 4) 再点一次：同一版开的是同一个副本。
      await clickTestIdByDom("workflow-artifact-open-as-file", {
        timeoutMsg: "产物 tab 头部没有「作为文件打开」",
      });
      await browser.waitUntil(async () => (await readOpenedPaths()).length === 2, {
        timeout: 15000,
        timeoutMsg: "第二次「作为文件打开」没有打开文件",
      });
      expect((await readOpenedPaths())[1]).toBe(openedPath);
    } finally {
      await browser.electron.restoreAllMocks();
    }
  });
});
