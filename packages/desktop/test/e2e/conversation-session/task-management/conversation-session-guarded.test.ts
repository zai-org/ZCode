// DCA-V1-01/05/07/09..15：真实桌面 broker → handler → provider result。
// 所有目标均在 case 自有目录；Git 使用不存在的仓库，matcher 回归也不会破坏工作区。
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_CHAT_MODE_SELECT_ITEM,
  TID_CHAT_MODE_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  getV4ModelConfig,
  clickV4Stop,
  getV4PaneSnapshot,
  denyV4PermissionWithFeedback,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";

const CASE = "conversation-session-guarded";
const ROOT = resolveE2ERuntimePath(CASE);
const DENIED = [
  "E2E_GUARDED_RM",
  "E2E_GUARDED_STORAGE",
  "E2E_GUARDED_RESET",
  "E2E_GUARDED_CLEAN",
  "E2E_GUARDED_PUSH",
  "E2E_GUARDED_DISCARD",
  "E2E_GUARDED_STASH",
  "E2E_GUARDED_WORKTREE",
  "E2E_GUARDED_RSYNC",
] as const;
const executedPath = (marker: string) => resolveE2ERuntimePath(CASE, marker + ".executed");
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("Guarded dangerous command once approval", () => {
  let originalRules = "";
  before(async () => {
    await mkdir(ROOT, { recursive: true });
    // 新隔离 profile 先完成 staging 的职业引导，再进入原审批测试。
    await skipOccupationOnboardingIfPresent();
  });
  beforeEach(async () => {
    originalRules = await readProjectRules();
  });
  afterEach(async () => {
    expect(await readProjectRules()).toBe(originalRules);
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(ROOT, { recursive: true, force: true });
  });
  for (const marker of DENIED) {
    it(marker + " refuses without running any part of Bash", async () => {
      const protectedFiles =
        marker === "E2E_GUARDED_RM" ? ["remove-target/keep.txt", "--help", "--version"] : [];
      // macOS 将路径后的帮助词当作删除目标；fixture 先进入 case 目录，避免失败时触及其它文件。
      for (const name of protectedFiles) {
        await mkdir(join(ROOT, "remove-target"), { recursive: true });
        await writeFile(join(ROOT, name), "case-owned preserved content");
      }
      await prepareV4ConversationE2E();
      if (marker === "E2E_GUARDED_RM") {
        // 菜单候选替换不迁移历史 edit；真实选择后的拒绝闭环继续检查 Runtime 权限。
        await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).click();
        const guardedItemTestId = testId(TID_CHAT_MODE_SELECT_ITEM, "guarded");
        const guardedItem = $(`[data-testid="${guardedItemTestId}"]`);
        await guardedItem.waitForDisplayed();
        expect(await guardedItem.$("svg.lucide-shield-check").isExisting()).toBe(true);
        const modeIds = await browser.execute(
          (prefix) =>
            Array.from(document.querySelectorAll(`[data-testid^="${prefix}-"]`)).map((item) =>
              item.getAttribute("data-testid")?.slice(prefix.length + 1),
            ),
          TID_CHAT_MODE_SELECT_ITEM,
        );
        // staging 的 Plan 已独立置顶；权限候选仍以 Guarded 替换 Edit。
        expect(modeIds).toEqual(["plan", "build", "guarded", "yolo"]);
        // 直接确认已打开菜单中的选项，避免 Escape 后再次切换菜单造成状态竞态。
        await browser.execute((id) => {
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.focus();
        }, guardedItemTestId);
        await browser.keys("Enter");
        await guardedItem.waitForExist({ reverse: true, timeout: 5000 });
      } else {
        await switchV4Mode("guarded");
      }
      await sendV4Prompt(marker + " Execute the requested test command exactly once.");
      await waitForV4PermissionDialogInComposerDock();
      expect(
        await browser.execute(
          () => document.querySelectorAll('[data-permission-option-kind="allowAlways"]').length,
        ),
      ).toBe(0);
      expect(await exists(executedPath(marker))).toBe(false);
      expect(await denyV4PermissionWithFeedback("Guarded test: do not execute.")).toBe(true);
      await waitForV4TimelineContaining(marker + "_DONE", 60000);
      const result = await getLatestUpstreamToolResultByToolCallId("toolu_" + marker);
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain("Guarded test: do not execute.");
      expect(await exists(executedPath(marker))).toBe(false);
      for (const name of protectedFiles) {
        expect(await readFile(join(ROOT, name), "utf8")).toBe("case-owned preserved content");
      }
    });
  }
  for (const [marker, mode] of [
    ["E2E_GUARDED_ALLOW", "guarded"],
    ["E2E_GUARDED_YOLO", "yolo"],
  ] as const) {
    it(marker + " uses the real isolated Bash handler exactly once", async () => {
      await prepareV4ConversationE2E();
      const target = resolveE2ERuntimePath(CASE, marker + ".target");
      await writeFile(target, "case-owned disposable input");
      await switchV4Mode(mode);
      // 展示与权限分开：Guarded 复用 Edit 图标并显示浅蓝色，YOLO 仍为橙色警示。
      const trigger = $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`);
      const icon = mode === "guarded" ? "shield-check" : "shield-alert";
      const color = mode === "guarded" ? "icon-blue" : "warning";
      expect(await trigger.$(`svg.lucide-${icon}`).isExisting()).toBe(true);
      await browser.waitUntil(
        () =>
          browser.execute(
            (triggerId, token) => {
              const element = document.querySelector<HTMLElement>(`[data-testid="${triggerId}"]`)!;
              const probe = document.createElement("span");
              probe.style.color = `var(--color-${token})`;
              element.append(probe);
              const expected = getComputedStyle(probe).color;
              probe.remove();
              return getComputedStyle(element).color === expected;
            },
            TID_CHAT_MODE_SELECT_TRIGGER,
            color,
          ),
        { timeout: 5000, timeoutMsg: `${mode} trigger color` },
      );
      await sendV4Prompt(marker + " Run the isolated cleanup command once.");
      if (mode === "guarded") {
        await waitForV4PermissionDialogInComposerDock();
        expect(await exists(target)).toBe(true);
        const changeMode = $('[data-testid="permission-allow-switch"]');
        await changeMode.waitForDisplayed();
        expect(await $('[data-testid="permission-target-picker"]').isExisting()).toBe(false);
        await changeMode.click();
        await $('[data-testid="yolo-confirmation-risk"]').click();
        await $('[data-testid="yolo-confirmation-confirm"]').click();
        await browser.waitUntil(async () => (await getV4ModelConfig()).mode === "yolo");
      }
      await waitForV4TimelineContaining(marker + "_DONE", 60000);
      expect(await exists(target)).toBe(false);
      expect((await readFile(executedPath(marker), "utf8")).trim()).toBe("executed");
      const result = await getLatestUpstreamToolResultByToolCallId("toolu_" + marker);
      expect(result?.isError).toBe(false);
    });
  }

  for (const answerKind of ["preset", "custom", "empty", "deny"] as const) {
    it(`AskUserQuestion ${answerKind} completes once in Guarded`, async () => {
      const marker = `E2E_GUARDED_QUESTION_${answerKind.toUpperCase()}`;
      await prepareV4ConversationE2E();
      await switchV4Mode("guarded");
      await sendV4Prompt(marker + " Ask the fixture question exactly once.");
      const body = await $('[data-elicitation-dialog-body="true"]');
      await body.waitForDisplayed({ timeout: 60000 });
      if (answerKind === "custom") {
        const input = await body.$("textarea");
        await input.click();
        await input.setValue("Guarded custom answer");
        await browser.keys("Enter");
      } else if (answerKind === "preset") {
        await body.$('button[role="option"]').click();
      } else {
        const position = answerKind === "deny" ? "first-child" : "last-child";
        await $(`[data-elicitation-dialog-footer="true"] button:${position}`).click();
      }
      await waitForV4TimelineContaining(marker + "_DONE", 60000);
      const result = await getLatestUpstreamToolResultByToolCallId("toolu_" + marker);
      expect(result?.isError).toBe(answerKind === "deny");
      if (answerKind !== "deny")
        expect(result?.content).toContain(
          answerKind === "preset"
            ? "Blue"
            : answerKind === "custom"
              ? "Guarded custom answer"
              : "The user did not provide answers",
        );
      expect(await $('[data-elicitation-dialog-body="true"]').isExisting()).toBe(false);
    });
  }

  it("a child dangerous request is answered in the parent dock and returned to the child model", async () => {
    await prepareV4ConversationE2E();
    await switchV4Mode("guarded");
    await sendV4Prompt(
      "E2E_GUARDED_PARENT Delegate the fixture command to a general-purpose child.",
    );
    await waitForV4PermissionDialogInComposerDock();
    expect(await $('[data-interaction-origin-badge="subagent"]').isExisting()).toBe(true);
    expect(await exists(executedPath("E2E_GUARDED_CHILD"))).toBe(false);
    expect(await $('[data-testid="permission-allow-switch"]').isExisting()).toBe(false);
    expect(await denyV4PermissionWithFeedback("Guarded child refused")).toBe(true);
    await waitForV4TimelineContaining("E2E_GUARDED_PARENT_DONE", 60000);
    const result = await getLatestUpstreamToolResultByToolCallId("toolu_E2E_GUARDED_CHILD");
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Guarded child refused");
    expect(await exists(executedPath("E2E_GUARDED_CHILD"))).toBe(false);
  });
});

async function readProjectRules(): Promise<string> {
  const path = join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite");
  if (!(await exists(path))) return "[]";
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify(
      database
        .prepare(
          "select scope, scope_id, value from local_setting where namespace = 'permission' and key = 'ruleset' order by scope, scope_id",
        )
        .all(),
    );
  } finally {
    database.close();
  }
}
