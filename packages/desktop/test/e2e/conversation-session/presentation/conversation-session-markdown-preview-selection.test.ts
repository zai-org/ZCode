import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_WORKSPACE_FILE_TREE_ROW,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";

const filePath = resolveE2ERuntimePath("markdown-preview-selection", "selection.md");
const marker = "E2E_MARKDOWN_PREVIEW_SELECTED_PARAGRAPH";

// 修复原因：文件树行 test id 含绝对路径；Windows 反斜杠在 CSS 属性值里是转义符，
// 未转义时 `\U`、`\.` 等被吞掉，选择器匹配不到真实存在的行。
function fileTreeRowSelector(path: string) {
  const value = testId(TID_WORKSPACE_FILE_TREE_ROW, path)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `[data-testid="${value}"]`;
}
describe("Markdown preview selection", () => {
  after(async () => {
    await rm(dirname(filePath), { recursive: true, force: true });
    await clearAppData();
  });
  it("MPS01/02/06/08/09: 预览选区加入草稿，去重、移除且不自动发送", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `# Preview\n\n${marker}\n`, "utf8");
    // 项目行的操作按真实 hover 挂载；helper 内部先 hover 项目行再点击文件树按钮。
    await openProjectFileTree(DEFAULT_WORKSPACE, {
      timeoutMsg: "Workspace file tree action did not mount after hover",
    });
    // 文件树会将单子目录链压缩为一行，入口使用压缩后的最深目录。
    for (const path of [dirname(filePath), filePath]) {
      const row = await $(fileTreeRowSelector(path));
      await row.waitForDisplayed({ timeout: 15000 });
      await row.click();
    }
    const preview = await $("[data-markdown-preview]");
    await preview.waitForDisplayed({ timeout: 15000 });
    const paneId = testId(TID_V4_SESSION_PANE, "workspace-main");
    await browser.execute(
      (paneTestId, inputTestId) => {
        const input = document.querySelector(
          `[data-testid="${paneTestId}"] [data-testid="${inputTestId}"]`,
        ) as HTMLElement & { __zcodeLexicalInputE2E?: { setText: (text: string) => void } };
        if (!input?.__zcodeLexicalInputE2E) throw new Error("Composer bridge missing");
        input.__zcodeLexicalInputE2E.setText("E2E_MARKDOWN_DRAFT_KEEP");
      },
      paneId,
      TID_V4_COMPOSER_INPUT,
    );
    for (let i = 0; i < 2; i++) {
      await browser.execute((text) => {
        const root = document.querySelector("[data-markdown-preview]")!;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.includes(text)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          node.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return;
        }
        throw new Error("Preview text missing");
      }, marker);
      const action = await $('[data-conversation-selection-action="add-to-task"]');
      await action.waitForDisplayed({ timeout: 5000 });
      const layout = await browser.execute(() => {
        const menu = document.querySelector<HTMLElement>("[data-conversation-selection-tooltip]")!;
        const [add, side] = Array.from(menu.querySelectorAll("button")).map((button) =>
          button.getBoundingClientRect(),
        );
        if (!add || !side) throw new Error("Selection actions missing");
        const rect = menu.getBoundingClientRect();
        return {
          horizontal: Math.abs(add.top - side.top) < 1 && side.left >= add.right,
          adaptive: menu.style.width === "max-content",
          inside: rect.left >= 11 && rect.right <= innerWidth - 11,
        };
      });
      expect(layout).toEqual({ horizontal: true, adaptive: true, inside: true });
      if (i === 0 && process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-selection-tooltip.png"),
        );
      }
      await action.click();
    }
    const chip = await $(
      `[data-testid="${paneId}"] [data-conversation-selection-reference-count="1"]`,
    );
    await chip.waitForDisplayed();
    expect(await chip.getText()).toContain("selection.md");
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-selection-composer.png"),
      );
    }
    const state = await browser.execute(
      (paneTestId, inputTestId) => {
        const pane = document.querySelector(`[data-testid="${paneTestId}"]`)!;
        const input = pane.querySelector(`[data-testid="${inputTestId}"]`) as HTMLElement & {
          __zcodeLexicalInputE2E?: { getText: () => string };
        };
        return {
          session: pane.getAttribute("data-session-id"),
          text: input.__zcodeLexicalInputE2E?.getText(),
        };
      },
      paneId,
      TID_V4_COMPOSER_INPUT,
    );
    expect(state).toEqual({ session: "draft", text: "E2E_MARKDOWN_DRAFT_KEEP" });
    const remove = await $(
      `[data-testid="${paneId}"] button[aria-label="移除对话引用"], [data-testid="${paneId}"] button[aria-label="Remove conversation selection"]`,
    );
    await remove.click();
    await chip.waitForExist({ reverse: true });
    // 移除后重新通过预览添加，验证实际发送与历史消息保留来源。
    await browser.execute(() => {
      const paragraph = document.querySelector("[data-markdown-preview] p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const addAgain = await $('[data-conversation-selection-action="add-to-task"]');
    await addAgain.waitForDisplayed();
    await addAgain.click();
    await sendV4Prompt("E2E_MARKDOWN_SIDE_PARENT Reply with a short acknowledgment.");
    await waitForV4TimelineContaining("E2E_MARKDOWN_SIDE_READY", 30000);
    const evidence = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_MARKDOWN_SIDE_PARENT", "<conversation_quote>"],
      excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
    });
    // 选区已改为结构化引用；检查模型边界的引用正文，避免旧 userselect 包装导致误报。
    expect(evidence.length).toBeGreaterThan(0);
    for (const record of evidence) {
      const { messages } = record.requestJson as {
        messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      };
      const selections = messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? ""),
        )
        .filter((text) => text.includes("E2E_MARKDOWN_SIDE_PARENT"))
        .flatMap((text) =>
          Array.from(
            text.matchAll(/<conversation_quote>\n([^]*?)\n<\/conversation_quote>/g),
            (match) => JSON.parse(match[1]!) as unknown,
          ),
        );
      expect(selections).toEqual([[{ path: filePath, text: marker }]]);
    }
    const historyChip = await $(
      `[data-testid="${paneId}"] [data-conversation-selection-reference-count="1"]`,
    );
    await historyChip.waitForDisplayed();
    expect(await historyChip.getText()).toContain("selection.md");
    // 草稿提升为任务会切换 task-owned 侧栏；重新打开文件标签并按实际展开状态定位。
    await openProjectFileTree(DEFAULT_WORKSPACE);
    const fileRow = $(fileTreeRowSelector(filePath));
    if (!(await fileRow.isDisplayed())) {
      const directory = $(fileTreeRowSelector(dirname(filePath)));
      await directory.waitForDisplayed();
      await directory.click();
    }
    await fileRow.waitForDisplayed();
    await fileRow.click();
    await preview.waitForDisplayed({ timeout: 15000 });
    await browser.execute(
      (paneTestId, inputTestId) => {
        const input = document.querySelector(
          `[data-testid="${paneTestId}"] [data-testid="${inputTestId}"]`,
        ) as HTMLElement & { __zcodeLexicalInputE2E: { setText: (text: string) => void } };
        input.__zcodeLexicalInputE2E.setText("E2E_MARKDOWN_MAIN_KEEP");
      },
      paneId,
      TID_V4_COMPOSER_INPUT,
    );
    // Lexical 提交草稿时会更新原生 Selection；等编辑器提交完成再创建预览选区。
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    await browser.execute(() => {
      const paragraph = document.querySelector("[data-markdown-preview] p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const sideAction = await $('[data-conversation-selection-action="ask-in-side-chat"]');
    await sideAction.waitForEnabled({ timeout: 15000 });
    await sideAction.click();
    const sideChip = await $(
      '[data-testid^="v4-session-pane-selection-side-chat:"] [data-conversation-selection-reference-count="1"]',
    );
    await sideChip.waitForDisplayed({ timeout: 30000 });
    expect(await sideChip.getText()).toContain("selection.md");
    const sideState = await browser.execute((inputTestId) => {
      const pane = document.querySelector('[data-testid^="v4-session-pane-selection-side-chat:"]')!;
      const input = pane.querySelector(`[data-testid="${inputTestId}"]`) as HTMLElement & {
        __zcodeLexicalInputE2E?: { getText: () => string };
      };
      const main = document.querySelector('[data-testid="v4-session-pane-workspace-main"]')!;
      const mainInput = main.querySelector(`[data-testid="${inputTestId}"]`) as typeof input;
      return {
        sideText: input.__zcodeLexicalInputE2E?.getText(),
        mainText: mainInput.__zcodeLexicalInputE2E?.getText(),
        distinct: pane.getAttribute("data-session-id") !== main.getAttribute("data-session-id"),
      };
    }, TID_V4_COMPOSER_INPUT);
    expect(sideState).toEqual({ sideText: "", mainText: "E2E_MARKDOWN_MAIN_KEEP", distinct: true });
    if (process.env.ZCODE_E2E_ARTIFACT_DIR)
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-side-conversation.png"),
      );
  });
});
