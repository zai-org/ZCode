import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
// S01 / S05 / S08 门禁：composer 聚合入口、兼容触发器与 Session Skill catalog 生命周期。
// 证据层 L3：
// 1) 首轮固定回复建立一个 session（写入 sessions-index）；
// 2) 新建 draft → `@` 与 `#` 都能发现同一 sessions-index 候选；
// 3) 两条入口选中后都写入原 `#session-id` canonical mention；
// 4) `$` / `¥` / `￥` 继续打开 Skills 面板并写入原 Skill mention；
// 5) `+` 菜单展示 @ / / / $ 底部提示，手动输入 $ 打开技能候选；
// 6) Session 初始化后手动新增 SKILL.md，旧 Session 目录冻结，新建任务重新发现。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { TID_CHAT_ATTACHMENT_BUTTON, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clickV4SlashOption,
  getV4ComposerText,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const SESSION_SKILL_NAME = "e2e-session-skill-catalog";
const SESSION_SKILL_DIRECTORY = join(
  getE2EAppDataPaths().workspace,
  ".zcode",
  "skills",
  SESSION_SKILL_NAME,
);
const SESSION_SKILL_PATH = join(SESSION_SKILL_DIRECTORY, "SKILL.md");

function isSessionSkillOption(optionId: string) {
  return optionId.startsWith("skill:") && optionId.includes(SESSION_SKILL_NAME);
}

async function waitForSessionSkillAbsent(trigger: "/" | "$") {
  let snapshot: { hasTarget: boolean; status: string | null } | undefined;
  let stableEmptyPolls = 0;
  await browser.waitUntil(
    async () => {
      if (!(await hasV4SlashPanel())) {
        stableEmptyPolls = 0;
        return false;
      }
      snapshot = await browser.execute((skillName) => {
        const optionIds = Array.from(
          document.querySelectorAll<HTMLElement>("[data-option-id]"),
        ).map((element) => element.dataset.optionId ?? "");
        const status = document
          .querySelector<HTMLElement>('[data-section-id="skills"][data-status]')
          ?.getAttribute("data-status");
        return {
          hasTarget: optionIds.some(
            (optionId) => optionId.startsWith("skill:") && optionId.includes(skillName),
          ),
          status: status ?? null,
        };
      }, SESSION_SKILL_NAME);
      if (snapshot.hasTarget || snapshot.status === "empty" || snapshot.status === "error") {
        return true;
      }
      if (snapshot.status === "loading") {
        stableEmptyPolls = 0;
        return false;
      }
      // `$` 的单分组面板在过滤结果为空时会直接省略 Skills row，因此没有 explicit empty 状态。
      // 连续观察到面板存在、无 loading 且无目标候选，避免把首帧未完成误判为最终空结果。
      stableEmptyPolls += 1;
      return stableEmptyPolls >= 3;
    },
    {
      timeout: 15000,
      timeoutMsg: `${trigger} 没有完成旧 Session Skill catalog 查询`,
    },
  );
  expect(snapshot?.status).not.toBe("error");
  expect(snapshot?.hasTarget).toBe(false);
}

async function waitForSessionSkillPresent(trigger: "/" | "$") {
  let optionId: string | undefined;
  await browser.waitUntil(
    async () => {
      optionId = (await getV4SlashOptionIds()).find(isSessionSkillOption);
      return Boolean(optionId);
    },
    {
      timeout: 15000,
      timeoutMsg: `${trigger} 没有展示新任务重新发现的 Skill: ${SESSION_SKILL_NAME}`,
    },
  );
  return optionId as string;
}

describe("S01 / S05 / S08：composer 候选入口与 Session Skill catalog", () => {
  before(async () => {
    await rm(SESSION_SKILL_DIRECTORY, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(SESSION_SKILL_DIRECTORY, { recursive: true, force: true });
    await clearAppData();
  });

  it("@ 与 # 共用 sessions-index，+ 菜单突出 @、/ 和 $", async () => {
    await prepareV4ConversationE2E();

    // 1) 建立一个 session（供 @ / # 目录共同命中）
    await sendV4Prompt("E2E_V4_MENTION_SEED 建立可被 mention 的会话");
    await waitForV4TimelineContaining("V4_MENTION_SEED_OK", 45000);
    const seedPane = await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态且绑定 session",
      45000,
    );
    const seedSessionId = seedPane.sessionId;
    if (!seedSessionId || seedSessionId === "draft") {
      throw new Error(`没有拿到可引用的 seed session: ${JSON.stringify(seedPane)}`);
    }

    // 2) 新建 draft → 干净输入框
    // 全局新建会分配虚拟目录；Hook、Skill 与会话候选必须继续使用夹具所属项目。
    await openWorkspaceDraftFromSidebar(getE2EAppDataPaths().workspace);

    // 3) `@` 聚合入口加载 sessions-index，并仍写入 # canonical mention。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@E2E_V4_MENTION_SEED", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    const atSessionOptionId = await waitForV4MentionOptionPrefix("session:");
    expect(atSessionOptionId.startsWith("session:")).toBe(true);
    expect(await clickV4SlashOption(atSessionOptionId)).toBe(true);
    await browser.waitUntil(
      async () => ((await getV4ComposerText()) ?? "").includes(`#${seedSessionId}`),
      {
        timeout: 15000,
        timeoutMsg: "@ 会话候选没有写入原 #session-id canonical mention",
      },
    );
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 @ 会话候选后面板没有关闭",
    });

    // 4) 兼容 `#` 面板继续工作，并与 @ 使用同一 sessions-index authority。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#E2E_V4_MENTION_SEED", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    const hashSessionOptionId = await waitForV4MentionOptionPrefix("session:");
    expect(hashSessionOptionId).toBe(atSessionOptionId);
    expect(await clickV4SlashOption(hashSessionOptionId)).toBe(true);
    await browser.waitUntil(
      async () => ((await getV4ComposerText()) ?? "").includes(`#${seedSessionId}`),
      {
        timeout: 15000,
        timeoutMsg: "# 会话候选没有写入原 #session-id canonical mention",
      },
    );
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 # 会话候选后面板没有关闭",
    });

    // 5) Skills 旧触发器（含两种 Yen 键盘别名）继续打开同一候选面板。
    let expectedSkillOptionId: string | undefined;
    let expectedSkillMarkdown: string | undefined;
    for (const skillTrigger of ["$", "¥", "￥"] as const) {
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, skillTrigger, {
        timeout: 15000,
        timeoutMsg: `无法输入 Skills 兼容触发器 ${skillTrigger}`,
      });
      const skillOptionId = await waitForV4MentionOptionPrefix("skill:");
      expect(skillOptionId.startsWith("skill:")).toBe(true);
      if (expectedSkillOptionId) {
        expect(skillOptionId).toBe(expectedSkillOptionId);
      } else {
        expectedSkillOptionId = skillOptionId;
      }
      expect(await clickV4SlashOption(skillOptionId)).toBe(true);
      let selectedSkillMarkdown: string | undefined;
      await browser.waitUntil(
        async () => {
          selectedSkillMarkdown = (await getV4ComposerText()) ?? undefined;
          return Boolean(
            selectedSkillMarkdown?.startsWith("[$") && selectedSkillMarkdown.includes("SKILL.md)"),
          );
        },
        {
          timeout: 15000,
          timeoutMsg: `${skillTrigger} 候选没有写入原 Skill canonical mention`,
        },
      );
      if (expectedSkillMarkdown) {
        expect(selectedSkillMarkdown).toBe(expectedSkillMarkdown);
      } else {
        expectedSkillMarkdown = selectedSkillMarkdown;
      }
      await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
        timeout: 15000,
        timeoutMsg: `选中 ${skillTrigger} Skill 候选后面板没有关闭`,
      });
    }

    // 6) + 菜单以底部提示介绍快捷输入；提示不再是可点击的菜单项。
    // 放在 mention 断言之后，避免 Radix 菜单的关闭焦点与 Lexical 输入竞争。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "验证动作菜单前无法清空输入框",
    });
    const actionMenuButton = await $(`[data-testid="${TID_CHAT_ATTACHMENT_BUTTON}"]`);
    await actionMenuButton.waitForDisplayed({ timeout: 15000 });
    await actionMenuButton.click();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const triggers = Array.from(
            document.querySelectorAll<HTMLElement>('[data-trigger="+"] code'),
          ).map((element) => element.textContent);
          return JSON.stringify(triggers) === JSON.stringify(["@", "/", "$"]);
        }),
      {
        timeout: 15000,
        timeoutMsg: "+ 菜单没有按顺序展示 @ / / / $ 提示",
      },
    );
    await browser.keys("Escape");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "$", { timeout: 15000 });
    expect((await waitForV4MentionOptionPrefix("skill:")).startsWith("skill:")).toBe(true);
    await browser.keys("Escape");

    // 清空草稿，避免旧 mention 干扰 S08 的唯一名称过滤。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });

    // 7) 先回到已初始化的 S1，再从文件系统手动新增 Skill。
    // Bug 根因：旧 Composer 曾长期复用 workspace mount 时的 UI 快照，导致新任务也看不到文件变化；
    // 这里固定正确边界是旧 resident Session 不热更新，而新任务创建的新 runtime 会重新发现。
    await selectV4TaskById(seedSessionId);
    await mkdir(SESSION_SKILL_DIRECTORY, { recursive: true });
    await writeFile(
      SESSION_SKILL_PATH,
      [
        "---",
        `name: ${SESSION_SKILL_NAME}`,
        "description: E2E fixture for the Session Skill catalog lifecycle.",
        "---",
        "",
        "# Session Skill Catalog E2E",
      ].join("\n"),
      "utf-8",
    );

    // 8) S1 仍读取首次 context 初始化时冻结的 runtime catalog，/ 与 $ 都不能看到新 Skill。
    for (const trigger of ["/", "$"] as const) {
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `${trigger}${SESSION_SKILL_NAME}`, {
        timeout: 15000,
        timeoutMsg: `无法在旧 Session 输入 Skill 触发器 ${trigger}`,
      });
      await waitForSessionSkillAbsent(trigger);
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
        timeout: 15000,
        timeoutMsg: `旧 Session ${trigger} 断言后没有清空 composer`,
      });
    }

    // 9) 新建任务创建新的 prewarm/runtime；同一个真实 SKILL.md 必须同时进入 / 与 $ 候选。
    // 全局新建会分配虚拟目录；Hook、Skill 与会话候选必须继续使用夹具所属项目。
    await openWorkspaceDraftFromSidebar(getE2EAppDataPaths().workspace);
    let slashSkillOptionId: string | undefined;
    for (const trigger of ["/", "$"] as const) {
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `${trigger}${SESSION_SKILL_NAME}`, {
        timeout: 15000,
        timeoutMsg: `无法在新任务输入 Skill 触发器 ${trigger}`,
      });
      const optionId = await waitForSessionSkillPresent(trigger);
      if (slashSkillOptionId) {
        expect(optionId).toBe(slashSkillOptionId);
      } else {
        slashSkillOptionId = optionId;
      }
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
        timeout: 15000,
        timeoutMsg: `新任务 ${trigger} 断言后没有清空 composer`,
      });
    }
  });
});
