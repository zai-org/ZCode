import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";

const MARKER = "E2E_SHARE_TOOL_PRESENTATION";
describe("FETCH01 / SHARE-TOOLS01: shared readonly tool presentation", () => {
  it("keeps WebFetch separate from search and publishes tool content", async function () {
    this.timeout(240_000);
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=onboarding-page]").isExisting()) ||
        (await $("[data-testid=task-settings-button]").isExisting()),
      { timeout: 30_000 },
    );
    if (await $("[data-testid=onboarding-page]").isExisting()) await dismissOccupationOnboarding();
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await sendV4Prompt(
      `${MARKER}: Use WebFetch to read http://example.localhost/paper with an extraction prompt, then reply exactly SHARE_TOOLS_READY. Do not use WebSearch.`,
    );
    await waitForV4AssistantMessageContaining("SHARE_TOOLS_READY");
    await waitForV4Pane((snapshot) => !snapshot.canStop, "Fetch did not finish", 90_000);
    await expandAssistantHistoriesWithContent();
    const tool = await waitForToolCallBlockByToolName("WebFetch");
    expect(tool.text).toMatch(/Fetch|网页抓取/);
    expect(tool.text).toContain("http://example.localhost/paper");
    expect(tool.text).not.toContain("EXTRACTION_MUST_NOT_BE_VISIBLE");
    // 验证真实发布 UI 与本地 fake API；人工 review 前只保留 pending，不自行转正。
    await $("[data-testid=conversation-share-trigger]").click();
    // 分享设置已合为单个浮窗；范围默认已选，敏感信息确认仍必须由用户勾选。
    await $("[data-testid=conversation-share-popover]").waitForDisplayed();
    await $("[data-testid=conversation-share-disclosure-checkbox]").waitForClickable();
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    // 修复原因：勾选确认后，waitForClickable 轮询的是勾选前取到的元素引用，5s 内一直判为
    // 不可点击；同一时刻重新查询到的按钮可见、可用且位于命中点顶层。每次轮询重新查询元素。
    await browser.waitUntil(() => $("[data-testid=conversation-share-confirm]").isClickable(), {
      timeout: 10_000,
      timeoutMsg: "分享确认按钮没有变为可点击",
    });
    await $("[data-testid=conversation-share-confirm]").click();
    await $("[data-testid=conversation-share-success-dock]").waitForDisplayed({ timeout: 90_000 });
    expect(await $("[data-testid=conversation-share-open-browser]").isEnabled()).toBe(true);
    await $("[data-testid=conversation-share-copy-link]").click();
    const link = await browser.execute(() => navigator.clipboard.readText());
    const url = new URL(link);
    const code = url.pathname.split("/").at(-1)!;
    const preview = (await fetch(`${url.origin}/api/v1/shares/${code}/preview`).then((response) =>
      response.json(),
    )) as { data: { rows: unknown[]; content_blocks?: Array<{ type: string }> } };
    expect(preview.data.rows.length).toBeGreaterThan(0);
    const fetchRow = preview.data.rows.find(
      (row) =>
        (row as { kind?: string; toolName?: string }).kind === "toolCall" &&
        (row as { toolName?: string }).toolName === "WebFetch",
    ) as { input?: { url?: string }; inputText: string };
    expect((fetchRow.input ?? JSON.parse(fetchRow.inputText)).url).toBe(
      "http://example.localhost/paper",
    );
    await browser.electron.execute((electron, shareCode) => {
      electron.app.emit(
        "open-url",
        { preventDefault() {} } as never,
        `zcode://share/import?code=${encodeURIComponent(shareCode)}`,
      );
    }, code);
    const imported = await $("[data-conversation-share-import-notice]");
    await imported.waitForDisplayed({ timeout: 90_000 });
    expect(await imported.getText()).toContain("http://example.localhost/paper");
    expect(await imported.getText()).toMatch(/Fetch|网页抓取/);
  });
});
