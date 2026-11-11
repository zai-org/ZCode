// PLM-EXT-H2：扩展经 workbench.startDraft 开预填草稿（docs/plugins/extension-host.md §18.1 H2、§18.4 GitLab 第 3 步）。
// 隔离 HOME：纯 JS fixture 扩展 e2e-ext-draft（test/e2e/fixtures/fs/plugins/plugin-extension-start-draft/）经
// plugins.dirs 加载。composer.status 条目 draft 点击执行命令，命令调 ctx.workbench.startDraft。
// 断言：新草稿的输入框预填了文字、没有发送（没有用户消息、文字仍在输入框里）、任务列表没有新任务；
// 第二次显式传工作区也一样；超长与空白文字报 invalid-input。不需要模型。
// 运行时证据：Main 日志（[extensions] / [extension-slots] / fixture 的 E2E_START_DRAFT*）、输入框与任务列表 DOM。
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  clickSlot,
  createExtensionLog,
  waitForSlot,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import {
  getV4ComposerText,
  getV4Messages,
  prepareV4ConversationE2E,
  setV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-H2";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-start-draft",
);
const PLUGIN = "e2e-ext-draft";
const PLUGIN_ID = `${PLUGIN}@inline`;
const SLOT_ITEM = `${PLUGIN_ID}/draft`;
const DRAFT_TEXT =
  "E2E_START_DRAFT review https://gitlab.example.com/group/project/-/merge_requests/7";

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();

async function seedFixture(): Promise<void> {
  const target = join(getE2EAppDataPaths().homeDir, "fixtures", "extension-start-draft");
  await mkdir(target, { recursive: true });
  await cp(join(FIXTURE_ROOT, PLUGIN), join(target, PLUGIN), { recursive: true, force: true });
  await writePluginDirsConfig([join(target, PLUGIN)], [PLUGIN_ID]);
}

/** 任务列表里的任务行数（草稿不在列表里，发送后才有任务）。 */
async function countTaskItems(): Promise<number> {
  return browser.execute(() => document.querySelectorAll('[data-testid^="task-item-"]').length);
}

async function waitForComposerText(expected: string, message: string): Promise<void> {
  let latest: string | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getV4ComposerText();
      return latest === expected;
    },
    { timeout: 30000, interval: 300, timeoutMsg: `${message}: ${JSON.stringify(latest)}` },
  );
}

describe("PLM-EXT-H2 workbench.startDraft 开预填草稿", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-h2-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("命令开出预填草稿：不发送、不新建任务；入参不合规时报 invalid-input", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    await seedFixture();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => log.mark(),
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    await waitForSlot(SLOT_ITEM, (slot) => slot.text.includes("E2E draft"), "draft slot");
    await setV4ComposerText("");
    const tasksBefore = await countTaskItems();
    evidence.tasksBefore = tasksBefore;

    // (a) 当前工作区：输入框预填文字，不发送，任务列表不变。
    const linesBeforeFirst = (await log.lines()).length;
    await clickSlot(SLOT_ITEM);
    evidence.firstLog = await log.waitFor(
      (line) => line.includes("E2E_START_DRAFT ") && line.includes("click=1"),
      "the first startDraft call should finish",
    );
    expect(String(evidence.firstLog)).toContain("E2E_START_DRAFT ok click=1 workspace=current");
    await waitForComposerText(`${DRAFT_TEXT} (click 1)`, "the new draft should be prefilled");
    evidence.firstWindowLogs = (await log.lines())
      .slice(linesBeforeFirst)
      .filter((line) => line.includes("workbench.startDraft"));
    expect(JSON.stringify(evidence.firstWindowLogs)).toContain(
      `workbench.startDraft acked plugin=${PLUGIN_ID} ok=true`,
    );
    // 日志不带文字本身。
    expect(JSON.stringify(evidence.firstWindowLogs)).not.toContain("E2E_START_DRAFT review");
    expect(await getV4Messages("user")).toEqual([]);
    expect(await countTaskItems()).toBe(tasksBefore);
    await capturePluginManualReview(CASE_ID, "draft-prefilled-zh-CN-zai-light");

    // (b) 入参不合规：超长、空白都在扩展进程内报 invalid-input，输入框不变。
    evidence.tooLongLog = await log.waitFor(
      (line) => line.includes("E2E_START_DRAFT_INVALID too-long"),
      "the too-long text should be rejected",
    );
    expect(String(evidence.tooLongLog)).toContain("code=invalid-input");
    evidence.blankLog = await log.waitFor(
      (line) => line.includes("E2E_START_DRAFT_INVALID blank"),
      "the blank text should be rejected",
    );
    expect(String(evidence.blankLog)).toContain("code=invalid-input");
    expect(await getV4ComposerText()).toBe(`${DRAFT_TEXT} (click 1)`);

    // (c) 显式传工作区（命令作用域的工作区）：同样预填、不发送。
    await setV4ComposerText("");
    await clickSlot(SLOT_ITEM);
    evidence.secondLog = await log.waitFor(
      (line) => line.includes("E2E_START_DRAFT ") && line.includes("click=2"),
      "the second startDraft call should finish",
    );
    expect(String(evidence.secondLog)).toContain("E2E_START_DRAFT ok click=2 workspace=explicit");
    await waitForComposerText(
      `${DRAFT_TEXT} (click 2)`,
      "the explicit-workspace draft should be prefilled",
    );
    expect(await getV4Messages("user")).toEqual([]);
    expect(await countTaskItems()).toBe(tasksBefore);
    evidence.tasksAfter = await countTaskItems();
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await capturePluginManualReview(CASE_ID, "draft-prefilled-en-US-zai-dark");
  });
});
