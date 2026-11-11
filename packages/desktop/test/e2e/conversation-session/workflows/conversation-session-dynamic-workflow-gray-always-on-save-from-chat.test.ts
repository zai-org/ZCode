import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_AUTOMATIONS_PAGE_TAB,
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
} from "@zcode/shared";
import { TID_AUTOMATIONS_OPEN, testId } from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  pinE2ELocale,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  denyV4PermissionWithFeedback,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialogInComposerDock,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { expandToolCallDetails } from "#e2e/helpers/conversation-session-tool";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";

// 从对话保存工作流（docs/dynamic-workflow/launch.md「Saved workflows」、
// docs/dynamic-workflow/transcript-and-notifications.md「Saving the run, and running it again」）：
// - DWS-02：模型调用 SaveWorkflow，用户允许，文件落到项目目录，中枢列出它；
// - DWS-03：同名再存：拒绝不动文件，允许整体替换；
// - DWS-04：完成卡的保存弹层：名字、作用域、后果句、覆盖与遮蔽、写失败、直接保存；
// - DWS-05：不加载 Skill，用 saved 来源运行：列出、错名、错实参、确认窗、完成卡已保存。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// 回放只决定模型的选择；Skill 门、确认窗、写盘、saved 解析、编译、run 引擎与通知走产品链路。
// 新会话必须从项目行开：侧栏「新任务」落在一个 draft 虚拟工作区，那里的 `.zcode/workflows/` 不是这个项目的。
// 写失败靠把目录换成同名普通文件制造：容器里可能是 root，权限位挡不住写入，而这条路 root 也过不去。
const NAME = "dws-release-check";
const WORKFLOWS_DIR = join(DEFAULT_WORKSPACE, ".zcode", "workflows");
const WORKFLOW_FILE = join(WORKFLOWS_DIR, `${NAME}.dwf.ts`);
const VERBATIM_NAME = "dws-verbatim";
const VERBATIM_FILE = join(WORKFLOWS_DIR, `${VERBATIM_NAME}.dwf.ts`);
const BROKEN_FILE = join(WORKFLOWS_DIR, "dws-broken.dwf.ts");
const SHADOWED_NAME = "dws-shadowed";
// agent 进程的 HOME 是 DEFAULT_WORKSPACE 的上一级（automations-workflows-hub 同一事实）。
const GLOBAL_DIR = join(dirname(DEFAULT_WORKSPACE), ".zcode", "workflows");
const SHADOWED_FILE = join(GLOBAL_DIR, `${SHADOWED_NAME}.dwf.ts`);
// 与回放里的脚本逐字一致。
const SCRIPT_V1 =
  'phase("检查");\nreturn `E2E_DWS_RESULT_V1 ${String(args.target)} ${String(args.skipTests)}`;\n';
const SCRIPT_V2 =
  'phase("复查");\nreturn `E2E_DWS_RESULT_V2 ${String(args.target)} ${String(args.skipTests)}`;\n';
const SCRIPT_C = 'phase("整理");\nreturn "E2E_DWS_C_RESULT 弹层用的 run 已完成。";\n';
const RUN_C = "E2E 保存弹层";

const BLOCK = '[data-save-workflow-permission-block="true"]';
const POPOVER = '[data-testid="workflow-save-popover"]';

function completionCard(name: string) {
  return $(
    `//*[@data-workflow-completion-card="true"][.//*[@data-testid="workflow-card-name" and normalize-space()="${name}"]]`,
  );
}

async function textOf(selector: string): Promise<string> {
  return String((await $(selector).getProperty("textContent")) ?? "").trim();
}

// 确认窗的落点是宿主 OS 的原生绝对路径（Windows 是 `C:\...\.zcode\workflows\x.dwf.ts`）。
// 断言只关心项目内的相对段，所以先把分隔符归一成 `/` 再比，否则 Windows 上必然失败。
function toPosixSeparators(text: string): string {
  return text.replaceAll("\\", "/");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForText(selector: string, expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await textOf(selector)).includes(expected), {
    timeout: 15000,
    timeoutMsg: `${timeoutMsg}（实际：${await textOf(selector).catch(() => "<读取失败>")}）`,
  });
}

function readWindowOptionKinds(): Promise<(string | null)[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-v4-composer-dock="true"] [role="listbox"] button[role="option"]',
      ),
    ).map((button) => button.getAttribute("data-permission-option-kind")),
  );
}

async function waitForToolResult(toolCallId: string, isError: boolean) {
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId))?.isError === isError,
    {
      timeout: 60000,
      timeoutMsg: `${toolCallId} 的 tool_result 没有到达（期望 isError=${isError}）`,
    },
  );
  return String((await getLatestUpstreamToolResultByToolCallId(toolCallId))?.content ?? "");
}

// 已结束一轮的工具行收在「已处理」折叠里：行不在 DOM 里就展开所有收起的折叠，直到它出现。
async function revealToolBlock(toolCallId: string) {
  const selector = `[data-tool-call-id="${toolCallId}"]`;
  await browser.waitUntil(
    async () => {
      if (await isOutsideClosedHistory(selector)) return true;
      await openClosedHistoryFolds();
      return false;
    },
    { timeout: 30000, timeoutMsg: `工具行没有出现：${selector}` },
  );
  return selector;
}

async function chooseScope(label: string) {
  await $('[data-testid="workflow-save-scope"]').click();
  const option = $(`//*[@role="option"][contains(normalize-space(), "${label}")]`);
  await option.waitForDisplayed({ timeout: 10000 });
  await option.click();
  await waitForText('[data-testid="workflow-save-scope"]', label, "作用域没有切过去");
}

describe("动态工作流 · 从对话保存", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
    await rm(WORKFLOWS_DIR, { recursive: true, force: true });
    await mkdir(GLOBAL_DIR, { recursive: true });
    await writeFile(SHADOWED_FILE, `/* zcode-workflow\ndescription: E2E 全局同名\n*/\nreturn 1;\n`);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(WORKFLOWS_DIR, { recursive: true, force: true });
    await rm(SHADOWED_FILE, { force: true });
    await clearAppData();
  });

  it("DWS-02 模型调用 SaveWorkflow：窗口给出路径、说明、实参且只有允许与拒绝；允许后文件按格式落到项目目录，中枢列出它", async function () {
    this.timeout(240000);

    await sendV4Prompt("E2E_DWS_A_START 把这个发布检查保存成工作流");
    await waitForV4PermissionDialogInComposerDock();

    // 窗口：新建的问句；没有覆盖标记；落点、说明、使用时机、实参表都在。
    const block = await textOf(BLOCK);
    expect(block).toContain("把这个工作流保存到项目里？");
    expect(block).toContain(NAME);
    expect(toPosixSeparators(block)).toContain(`.zcode/workflows/${NAME}.dwf.ts`);
    expect(block).toContain("E2E 发布前检查");
    expect(block).toContain("用户要做发布前检查时");
    await expect($(`${BLOCK} [data-workflow-overwrite-hint="true"]`)).not.toBeExisting();
    await expect($(`${BLOCK} [data-workflow-overwrite-badge="true"]`)).not.toBeExisting();
    await expect($(`${BLOCK} [data-workflow-save-arg="target"]`)).toBeExisting();
    await expect($(`${BLOCK} [data-workflow-save-arg="skipTests"]`)).toBeExisting();
    // 选项：允许一次与拒绝；没有 Refine，也没有会话级选项。
    expect((await readWindowOptionKinds()).toSorted()).toEqual(["allowOnce", "rejectOnce"]);
    // 允许之前一个字节都没写。
    expect(await fileExists(WORKFLOW_FILE)).toBe(false);

    await approveV4Permission();
    await waitForV4AssistantMessageContaining("E2E_DWS_A_DONE", 60000);

    // 文件：`/* zcode-workflow` 元数据块 + 逐字节脚本；名字与作用域不写进文件。
    const saved = await readFile(WORKFLOW_FILE, "utf-8");
    expect(saved.startsWith("/* zcode-workflow\n")).toBe(true);
    expect(saved.endsWith(`*/\n${SCRIPT_V1}`)).toBe(true);
    expect(saved).toContain("description: E2E 发布前检查");
    expect(saved).toContain("whenToUse: 用户要做发布前检查时");
    expect(saved).toContain("target:");
    expect(saved).toContain("required: true");
    expect(saved).not.toContain("scope:");
    expect(saved).not.toContain(`name: ${NAME}`);
    expect(await waitForToolResult("toolu_dws_a_save", false)).toContain(
      `Saved the workflow '${NAME}' to`,
    );

    // 转写留下的工具卡：一行记录，展开后有作用域行。
    const tool = await revealToolBlock("toolu_dws_a_save");
    await waitForText(tool, "已保存工作流", "工具卡没有写「已保存工作流」");
    await expandToolCallDetails("toolu_dws_a_save");
    await waitForText(tool, "作用域", "工具卡展开后没有作用域行");
    expect(await textOf(tool)).toContain("项目");

    // 中枢：目录扫描就是事实，列出这份定义。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现自动化入口" });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), {
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    const card = `[data-testid="${testId(TID_WORKFLOW_CARD, NAME)}"]`;
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, NAME), {
      timeout: 20000,
      timeoutMsg: "中枢没有列出刚保存的工作流",
    });
    expect(await textOf(card)).toContain("E2E 发布前检查");
  });

  it("DWS-03 同名保存：窗口换成覆盖问句并带警告；拒绝不动文件，允许后整体替换且结果说 Replaced", async function () {
    this.timeout(240000);
    const before = await readFile(WORKFLOW_FILE, "utf-8");

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_DWS_B_START 把工作流换成复查版");
    await waitForV4PermissionDialogInComposerDock();

    // 第一次：覆盖问句、徽标、警告行。拒绝：文件逐字节不变，反馈回给模型。
    await waitForText(BLOCK, "E2E 被拒绝的一版", "第一次保存窗没有出现");
    const block = await textOf(BLOCK);
    expect(block).toContain("覆盖已保存的同名工作流？");
    expect(await textOf(`${BLOCK} [data-workflow-overwrite-badge="true"]`)).toContain("覆盖");
    expect(await textOf(`${BLOCK} [data-workflow-overwrite-hint="true"]`)).toContain(
      "该路径下已存在同名工作流，保存会整体替换这个文件。",
    );
    await denyV4PermissionWithFeedback("先别覆盖");
    expect(await waitForToolResult("toolu_dws_b_save1", true)).toContain("先别覆盖");
    expect(await readFile(WORKFLOW_FILE, "utf-8")).toBe(before);

    // 第二次：允许，文件被整体替换：旧脚本与旧 whenToUse 都不在了。
    await waitForV4PermissionDialogInComposerDock();
    await waitForText(BLOCK, "E2E 发布前复查", "第二次保存窗没有出现");
    await expect($(`${BLOCK} [data-workflow-overwrite-hint="true"]`)).toBeExisting();
    await approveV4Permission();
    await waitForV4AssistantMessageContaining("E2E_DWS_B_DONE", 60000);

    const replaced = await readFile(WORKFLOW_FILE, "utf-8");
    expect(replaced.endsWith(`*/\n${SCRIPT_V2}`)).toBe(true);
    expect(replaced).toContain("description: E2E 发布前复查");
    expect(replaced).not.toContain("E2E_DWS_RESULT_V1");
    expect(replaced).not.toContain("whenToUse");
    // `overwritten` 在写的那一刻重新判定：结果说 Replaced，不说 Saved。
    expect(await waitForToolResult("toolu_dws_b_save2", false)).toContain(
      `Replaced the saved workflow '${NAME}' at`,
    );
  });

  it("DWS-04 完成卡保存弹层：名字校验、作用域、后果句、覆盖与遮蔽；写失败时弹层留着且不落盘，恢复后直接保存逐字节写入并翻成再次运行", async function () {
    this.timeout(300000);

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_DWS_C_START 跑一个工作流");
    await approveV4Permission();
    await waitForV4AssistantMessageContaining("E2E_DWS_C_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60000);

    const card = completionCard(RUN_C);
    await card.waitForExist({ timeout: 60000 });
    const openSave = card.$('[data-testid="workflow-save-open"]');
    await openSave.waitForClickable({ timeout: 30000 });
    await expect(card.$('[data-testid="workflow-saved-chip"]')).not.toBeExisting();
    await openSave.click();
    await $(POPOVER).waitForDisplayed({ timeout: 15000 });

    const name = '[data-testid="workflow-save-name"]';
    const helper = '[data-testid="workflow-save-name-helper"]';
    const submit = $('[data-testid="workflow-save-submit"]');
    const consequence = '[data-testid="workflow-save-consequence"]';
    const overwrite = '[data-testid="workflow-save-overwrite"]';
    const setName = (value: string) =>
      setInputValueByTestIdDom("workflow-save-name", value, { timeoutMsg: "弹层没有名字框" });

    // 打开：焦点在名字框；中文 run 名不能当文件名，名字空着，说明预填 run 名；直接保存不可点。
    await browser.waitUntil(
      () => browser.execute(() => document.activeElement?.id === "workflow-save-name"),
      { timeout: 10000, timeoutMsg: "弹层打开后焦点不在名字框" },
    );
    expect(await $(name).getValue()).toBe("");
    expect(await $('[data-testid="workflow-save-description"]').getValue()).toBe(RUN_C);
    expect(await textOf(helper)).toContain("字母、数字");
    expect(await submit.isEnabled()).toBe(false);

    // 非法名字：提示行变成错误，直接保存仍不可点。
    await setName("bad name!");
    await waitForText(helper, "名字只能用字母、数字和", "非法名字没有变成错误提示");
    expect(await $(name).getAttribute("aria-invalid")).toBe("true");
    expect(await submit.isEnabled()).toBe(false);

    // 名字已被项目占用：后果句换成覆盖警告，按钮改词。
    await setName(NAME);
    await waitForText(
      overwrite,
      "本项目已有同名工作流，保存会覆盖它；已有的运行记录保留。",
      "同名时没有出现覆盖警告",
    );
    await waitForText('[data-testid="workflow-save-submit"]', "覆盖并直接保存", "按钮没有改词");
    await expect($(consequence)).not.toBeExisting();

    // 全局档同名、项目档没有：后果句补上遮蔽那一句。
    await setName(SHADOWED_NAME);
    await waitForText(consequence, "同名的全局工作流将被这一份遮蔽", "没有说出遮蔽事实");
    expect(await textOf(consequence)).toContain(`.zcode/workflows/${SHADOWED_NAME}.dwf.ts`);
    await waitForText('[data-testid="workflow-save-submit"]', "直接保存", "按钮没有改回直接保存");

    // 换到全局档：路径换到 `~`；项目里已有同名时说「会遮蔽它」。
    await setName(NAME);
    await waitForText(overwrite, "本项目已有同名工作流", "切作用域前的覆盖警告没出现");
    await chooseScope("全局");
    await waitForText(consequence, `~/.zcode/workflows/${NAME}.dwf.ts`, "全局档路径不对");
    await waitForText(consequence, "本项目里已有同名工作流，在这里会遮蔽它", "全局档没说遮蔽");
    await chooseScope("项目");

    // 写失败：把工作流目录换成同名普通文件，真实的 mkdir 一定失败。
    const aside = `${WORKFLOWS_DIR}.e2e-aside`;
    await rename(WORKFLOWS_DIR, aside);
    await writeFile(WORKFLOWS_DIR, "");
    try {
      await setName(VERBATIM_NAME);
      await waitForText(consequence, `.zcode/workflows/${VERBATIM_NAME}.dwf.ts`, "后果句没有路径");
      await waitForText(consequence, "按名字再次运行", "后果句不完整");
      await submit.click();
      const failure = '[data-testid="workflow-save-failure"]';
      await waitForText(failure, "写入失败，没有保存。", "写失败没有显示拒绝原因");
      await expect($(consequence)).not.toBeExisting();
      // 弹层留着，卡片没有翻；工作流目录仍是那个普通文件，一个字节都没写。
      await expect($(POPOVER)).toBeDisplayed();
      await expect(card.$('[data-testid="workflow-saved-chip"]')).not.toBeExisting();
      expect((await stat(WORKFLOWS_DIR)).isFile()).toBe(true);
      expect(await readFile(WORKFLOWS_DIR, "utf-8")).toBe("");
    } finally {
      await rm(WORKFLOWS_DIR, { force: true });
      await rename(aside, WORKFLOWS_DIR);
    }

    // 恢复后再点：写下这次 run 跑的脚本，逐字节；说明退回预填的 run 名；弹层关闭，卡翻面。
    await submit.click();
    await browser.waitUntil(() => fileExists(VERBATIM_FILE), {
      timeout: 15000,
      timeoutMsg: "恢复目录后直接保存没有写出文件",
    });
    const verbatim = await readFile(VERBATIM_FILE, "utf-8");
    expect(verbatim.endsWith(`*/\n${SCRIPT_C}`)).toBe(true);
    expect(verbatim).toContain(`description: ${RUN_C}`);
    await $(POPOVER).waitForDisplayed({ reverse: true, timeout: 15000 });
    const chip = card.$('[data-testid="workflow-saved-chip"]');
    await chip.waitForExist({ timeout: 15000 });
    await expect(card.$('[data-testid="workflow-save-run-again"]')).toBeExisting();
    await expect(card.$('[data-testid="workflow-save-open"]')).not.toBeExisting();
    await browser.waitUntil(
      async () =>
        String(
          await card.$('[data-testid="workflow-save-announcement"]').getProperty("textContent"),
        ) === "已保存到项目",
      { timeout: 15000, timeoutMsg: "保存后没有播报「已保存到项目」" },
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.activeElement?.getAttribute("data-testid") === "workflow-save-run-again",
        ),
      { timeout: 10000, timeoutMsg: "保存后焦点没有回到「再次运行」" },
    );

    // 芯片是通往中枢的按钮：打开这份工作流的详情页。
    await chip.click();
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, { timeoutMsg: "点芯片没有进入工作流详情页" });
  });

  it("DWS-05 没加载 Skill 也能跑已保存的工作流：列出可用与损坏的定义，错名与错实参不开窗，确认窗带来源徽标，跑完完成卡显示已保存", async function () {
    this.timeout(300000);
    await writeFile(BROKEN_FILE, "return 1;\n");

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_DWS_D_START 再跑一次发布复查");

    // 列表只读、不开窗：定义在，损坏的文件点名原因，全局那份带上，脚本正文不进上下文。
    const listed = await waitForToolResult("toolu_dws_d_list", false);
    expect(listed).toContain(NAME);
    expect(listed).toContain(SHADOWED_NAME);
    expect(listed).toContain("dws-broken.dwf.ts");
    expect(listed).toContain("missing_frontmatter");
    expect(listed).not.toContain("E2E_DWS_RESULT_V2");

    // 错名：列出确实存在的名字并标作用域。
    const missing = await waitForToolResult("toolu_dws_d_missing", true);
    expect(missing).toContain("No saved workflow named 'dws-nope'");
    expect(missing).toContain(`${NAME} (project)`);
    expect(missing).toContain(`${SHADOWED_NAME} (global)`);

    // 错实参：一次收集所有问题：未声明的键与类型不符都点名。
    const badArgs = await waitForToolResult("toolu_dws_d_badargs", true);
    expect(badArgs).toContain("wrong");
    expect(badArgs).toContain("target");
    await rm(BROKEN_FILE, { force: true });

    // 确认窗：saved 徽标、名字、路径、实参。整个会话没有 Skill 调用：这个窗证明 saved 来源不过门。
    await waitForV4PermissionDialogInComposerDock();
    const source = '[data-workflow-saved-source="true"]';
    await waitForText(source, "已保存的工作流", "确认窗没有 saved 来源徽标");
    expect(await textOf(`${source} [data-workflow-saved-name="true"]`)).toBe(NAME);
    expect(
      toPosixSeparators(await textOf(`${source} [data-workflow-saved-path="true"]`)),
    ).toContain(`.zcode/workflows/${NAME}.dwf.ts`);
    const grid = await textOf(`${source} [data-workflow-saved-args="true"]`);
    expect(grid).toContain("target");
    expect(grid).toContain("beta");
    await approveV4Permission();

    // 收尾回放只在通知载荷带 `E2E_DWS_RESULT_V2 beta false` 时匹配：跑的是覆盖后的第二版，
    // 实参到了 sandbox，默认值也填上了。
    await waitForV4AssistantMessageContaining("E2E_DWS_D_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60000);

    // run 名默认是 saved 名；按「run 叫的」规则，这张完成卡没有保存过也显示已保存 + 再次运行。
    const card = completionCard(NAME);
    await card.waitForExist({ timeout: 60000 });
    await card.$('[data-testid="workflow-saved-chip"]').waitForExist({ timeout: 30000 });
    await expect(card.$('[data-testid="workflow-save-open"]')).not.toBeExisting();
    const runAgain = card.$('[data-testid="workflow-save-run-again"]');
    await runAgain.waitForClickable({ timeout: 30000 });

    // 有实参的工作流：再次运行开启动窗，预填这次 run 的实参。关窗，不起新 run。
    await runAgain.click();
    await waitForTestIdByDom(TID_WORKFLOW_LAUNCH_DIALOG, { timeoutMsg: "再次运行没有开启动窗" });
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${testId(TID_WORKFLOW_LAUNCH_ARG, "target")}"]`).getValue()) ===
        "beta",
      { timeout: 15000, timeoutMsg: "启动窗没有预填这次 run 的实参" },
    );
    await browser.keys(["Escape"]);
    await $(`[data-testid="${TID_WORKFLOW_LAUNCH_DIALOG}"]`).waitForExist({
      reverse: true,
      timeout: 15000,
    });
  });
});
