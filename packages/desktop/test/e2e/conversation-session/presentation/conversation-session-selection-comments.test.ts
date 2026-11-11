import { join } from "node:path";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequests,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  clickSelectionAction,
  dragSelectMainTimelineText,
  openMainTimelineAnnotation,
  readMainComposerSelectionChip,
  readMainTimelineAnnotationMarks,
  typeSelectionComment,
} from "#e2e/helpers/conversation-selection-comment";
import {
  clickV4Send,
  editFirstV4UserQuery,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const artifacts = () => process.env.ZCODE_E2E_ARTIFACT_DIR!;
const ANSWER_ONE = "E2E_SCM_ANSWER_ONE";
const ANSWER_TWO = "E2E_SCM_ANSWER_TWO";
const COMMENT_KEEP = "E2E_SCM_COMMENT_KEEP";
const COMMENT_DROP = "E2E_SCM_COMMENT_DROP";
const COMMENT_ADDED = "E2E_SCM_COMMENT_ADDED";
/** 第一轮回答里表格之前的正文，用来验证“仅原文”注释（不写评论直接回车）。 */
const QUOTE_ONLY = "下面是结果";
const COMMENT_GUIDANCE = "user annotation on that exact quoted text";

async function waitForIdle(message: string): Promise<void> {
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.activeInputId === null,
    message,
    60000,
  );
}

/**
 * 等待 composer 注释 chip 为 count 条，并且正文编号标记的形态与 variants 一致
 * （comment = 有评论实心，quote = 仅原文空心，按编号顺序）。
 */
async function waitForAnnotations(count: number, variants: readonly string[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const chip = await readMainComposerSelectionChip();
      const marks = await readMainTimelineAnnotationMarks();
      return (
        chip.count === count &&
        (chip.label ?? "").includes(`${count} 条注释`) &&
        JSON.stringify(marks.map((mark) => mark.variant)) === JSON.stringify(variants) &&
        marks.every((mark, index) => mark.number === index + 1)
      );
    },
    {
      timeout: 15000,
      timeoutMsg: `注释状态不符，期望 ${count} 条 ${JSON.stringify(variants)}: ${JSON.stringify({
        chip: await readMainComposerSelectionChip(),
        marks: await readMainTimelineAnnotationMarks(),
      })}`,
    },
  );
}

describe("选区注释 manual review", () => {
  after(async () => {
    await clearAppData();
  });

  it("SCM01-06: 选区注释新增/仅原文/编辑/删除撤销、rewind 删除来源注释、注释随消息发给模型", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await pinE2ELocale("zh-CN");

    await sendV4Prompt("E2E_SCM_SEED_ONE: answer with a markdown table");
    await waitForV4AssistantMessageContaining(ANSWER_ONE, 60000);
    await waitForIdle("第一轮回答没有完成");
    await sendV4Prompt("E2E_SCM_SEED_TWO: answer with a code block");
    await waitForV4AssistantMessageContaining(ANSWER_TWO, 60000);
    await waitForIdle("第二轮回答没有完成");

    // SCM01：表格单元格里的回答文字 → 注释浮层 → 键盘输入评论并回车保存。
    await dragSelectMainTimelineText(ANSWER_ONE);
    await browser.saveScreenshot(join(artifacts(), "scm01-selection-menu.png"));
    await clickSelectionAction("comment");
    await typeSelectionComment(COMMENT_KEEP);
    await browser.saveScreenshot(join(artifacts(), "scm01-comment-editor.png"));
    await browser.keys("Enter");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await waitForAnnotations(1, ["comment"]);

    // 第二条注释挂在第二轮回答上，随后由 rewind 删除来源。
    await dragSelectMainTimelineText(ANSWER_TWO);
    await clickSelectionAction("comment");
    await typeSelectionComment(COMMENT_DROP);
    await $("[data-conversation-selection-comment-save]").click();
    await waitForAnnotations(2, ["comment", "comment"]);

    // SCM04：不写评论直接回车 = 只加原文（取代原“添加到当前任务”），正文为空心编号。
    await dragSelectMainTimelineText(QUOTE_ONLY);
    expect(await $('[data-conversation-selection-action="add-to-task"]').isExisting()).toBe(false);
    await clickSelectionAction("comment");
    await $("[data-conversation-selection-comment-input]").waitForDisplayed({ timeout: 5000 });
    await browser.saveScreenshot(join(artifacts(), "scm04-pending-mark.png"));
    await browser.keys("Enter");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await waitForAnnotations(3, ["comment", "comment", "quote"]);
    await $("[data-conversation-selection-reference-count]").moveTo();
    await $("[data-conversation-annotation-add-comment]").waitForDisplayed({ timeout: 5000 });
    await browser.saveScreenshot(join(artifacts(), "scm04-composer-chip-hover.png"));

    // SCM05：点正文 ③ → 编辑浮层补评论，空心变实心。
    await openMainTimelineAnnotation(3);
    await typeSelectionComment(COMMENT_ADDED);
    await browser.saveScreenshot(join(artifacts(), "scm05-edit-annotation.png"));
    await browser.keys("Enter");
    await waitForAnnotations(3, ["comment", "comment", "comment"]);

    // SCM06：编辑浮层删除整条注释，6 秒内撤销后原位恢复，编号不变。
    await openMainTimelineAnnotation(3);
    await $("[data-conversation-selection-comment-delete]").click();
    await waitForAnnotations(2, ["comment", "comment"]);
    await browser.saveScreenshot(join(artifacts(), "scm06-deleted-toast.png"));
    // toast 有淡入动画，按文字在 toast 宿主里找“撤销”并点击，失败时带上宿主内容方便定位。
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = Array.from(
            document.querySelectorAll<HTMLButtonElement>("#zcode-toast-host button"),
          ).find((candidate) => candidate.textContent?.trim() === "撤销");
          if (!button) return false;
          button.click();
          return true;
        }),
      {
        timeout: 5000,
        timeoutMsg: `删除注释后没有出现“撤销”: ${await browser.execute(
          () => document.querySelector("#zcode-toast-host")?.textContent ?? "<no toast host>",
        )}`,
      },
    );
    await waitForAnnotations(3, ["comment", "comment", "comment"]);

    // 浅色主题下复看浮层、注释输入与 chip；Esc 取消不改变已有注释。
    await browser.execute(() => {
      (
        window as typeof window & { __testActions: { setTheme(value: string): void } }
      ).__testActions.setTheme("zai-light");
    });
    await browser.waitUntil(() =>
      browser.execute(() => document.documentElement.classList.contains("theme-zai-light")),
    );
    await dragSelectMainTimelineText(ANSWER_ONE);
    await browser.saveScreenshot(join(artifacts(), "scm01-light-selection-menu.png"));
    await clickSelectionAction("comment");
    await typeSelectionComment("E2E_SCM_CANCELLED");
    await browser.saveScreenshot(join(artifacts(), "scm01-light-comment-editor.png"));
    await browser.keys("Escape");
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await waitForAnnotations(3, ["comment", "comment", "comment"]);
    await $("[data-conversation-selection-reference-count]").moveTo();
    await $("[data-conversation-selection-comment]").waitForDisplayed({ timeout: 5000 });
    await browser.saveScreenshot(join(artifacts(), "scm01-light-composer-chip-hover.png"));

    // SCM02：编辑最新问题会删除第二轮回答所在行；该行的注释同步移除，第一轮的两条保留并重新编号。
    await editFirstV4UserQuery("E2E_SCM_SEED_TWO_REWOUND: answer again");
    await waitForV4UserMessageContaining("E2E_SCM_SEED_TWO_REWOUND");
    await waitForV4AssistantMessageContaining("E2E_SCM_REWOUND_DONE", 60000);
    await waitForIdle("rewind 后回答没有完成");
    await waitForAnnotations(2, ["comment", "comment"]);
    await browser.saveScreenshot(join(artifacts(), "scm02-after-rewind.png"));

    // SCM03：注释随下一条消息作为结构化引用发给模型，并附带评论说明；发送后正文标记变灰。
    await setV4ComposerText("E2E_SCM_SEND: 请结合注释回答");
    await clickV4Send();
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [
          "E2E_SCM_SEND",
          ANSWER_ONE,
          COMMENT_KEEP,
          QUOTE_ONLY,
          COMMENT_ADDED,
          COMMENT_GUIDANCE,
        ],
      },
      "带注释的模型请求没有发出",
      60000,
    );
    expect(
      await countUpstreamRequests({ lastUserMessageIncludes: ["E2E_SCM_SEND", COMMENT_DROP] }),
    ).toBe(0);
    await waitForV4AssistantMessageContaining("E2E_SCM_SEND_DONE", 60000);
    await waitForIdle("带注释的消息没有完成");
    expect((await readMainComposerSelectionChip()).count).toBeNull();
    await browser.waitUntil(
      async () =>
        JSON.stringify((await readMainTimelineAnnotationMarks()).map((mark) => mark.variant)) ===
        JSON.stringify(["sent-comment", "sent-comment"]),
      { timeout: 10000, timeoutMsg: "发送后的注释标记没有变成灰色已发送态" },
    );
    await browser.saveScreenshot(join(artifacts(), "scm03-sent.png"));
  });
});
