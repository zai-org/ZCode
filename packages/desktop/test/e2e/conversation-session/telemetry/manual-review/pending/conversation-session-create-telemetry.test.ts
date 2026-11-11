import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("TEL11 session_create", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("预热零上报、首发一次、续发和重开不重复", async function () {
    this.timeout(360_000);
    await waitForDefaultWorkspaceReady(90_000);
    await prepareV4ConversationE2E();
    // 原因：准备 helper 可复用启动空态；只有真实点击项目新建才产生 project 来源。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });
    const reports = async (elementName = "session_create") => {
      await telemetryFetch.update();
      return telemetryFetch.mock.calls.flatMap((call) => {
        if (!String(call[0]).includes("/api/v1/event/report")) return [];
        const init = call[1] as { body?: unknown } | undefined;
        if (typeof init?.body !== "string") return [];
        const body = JSON.parse(init.body) as {
          element_name?: string;
          event_id?: string;
          talk_id?: string;
          message_id?: string;
          event_extra_detail?: Record<string, string>;
        };
        return body.element_name === elementName ? [body] : [];
      });
    };
    const waitForMatchingCompletion = async (created: {
      talk_id?: string;
      message_id?: string;
    }) => {
      expect(created.message_id).toBeTruthy();
      try {
        await browser.waitUntil(
          async () =>
            (await reports("message_completion")).some(
              (completed) =>
                completed.talk_id === created.talk_id &&
                completed.message_id === created.message_id,
            ),
          { timeout: 15_000, timeoutMsg: "创建/完成事件关联失败" },
        );
      } catch (error) {
        throw new Error(
          `创建/完成事件关联失败: ${JSON.stringify({ created, completions: (await reports("message_completion")).map(({ talk_id, message_id }) => ({ talk_id, message_id })) })}`,
          { cause: error },
        );
      }
    };
    await waitForV4ComposerSelectionReady();
    expect(await reports()).toEqual([]);
    await sendV4Prompt('E2E_SESSION_CREATE_TELEMETRY_FIRST: Reply exactly "SESSION_CREATE_OK".');
    await waitForV4TimelineContaining("SESSION_CREATE_OK", 60_000);
    const pane = await waitForV4Pane(
      (state) => !!state.sessionId && state.sessionId !== "draft" && !state.canStop,
      "首发未创建正式 session",
      60_000,
    );
    await browser.waitUntil(async () => (await reports()).length === 1, {
      timeout: 15_000,
      timeoutMsg: "首发没有 session_create",
    });
    const sessionId = pane.sessionId!;
    await browser.waitUntil(
      async () =>
        (await reports("message_completion")).some((event) => event.talk_id === sessionId),
      { timeout: 15_000 },
    );
    const firstMessageId = (await reports("message_completion")).find(
      (event) => event.talk_id === sessionId,
    )!.message_id;
    expect(firstMessageId).toBeTruthy();
    expect((await reports())[0]?.message_id).toBe(firstMessageId);
    expect((await reports())[0]?.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await reports()).toEqual([
      expect.objectContaining({
        talk_id: sessionId,
        event_extra_detail: {
          create_source: "project",
          client_kind: "desktop",
          workspace_kind: "local",
          remote_kind: "",
        },
      }),
    ]);
    await sendV4Prompt('E2E_SESSION_CREATE_TELEMETRY_NEXT: Reply exactly "SESSION_NEXT_OK".');
    await waitForV4TimelineContaining("SESSION_NEXT_OK", 60_000);
    await waitForV4Pane((state) => !state.canStop, "后续轮次没有结束", 60_000);
    await startNewV4Draft();
    await waitForV4ComposerSelectionReady();
    await selectV4TaskById(sessionId);
    await waitForV4Pane((state) => state.sessionId === sessionId, "历史重开失败", 30_000);
    expect(await reports()).toHaveLength(1);

    // 使用真实 Group 页新建入口，不能直接修改 store 伪造 create_source。
    const tabs = await $$('[role="tab"]');
    let groupTab;
    for (const tab of tabs) {
      if (["Group", "分组"].includes((await tab.getText()).trim())) groupTab = tab;
    }
    if (!groupTab) throw new Error("没有 Group 视图入口");
    await groupTab.click();
    await startNewV4Draft();
    await waitForV4ComposerSelectionReady();
    expect(await reports()).toHaveLength(1);
    await sendV4Prompt('E2E_SESSION_CREATE_TELEMETRY_GROUP: Reply exactly "SESSION_GROUP_OK".');
    await waitForV4TimelineContaining("SESSION_GROUP_OK", 60_000);
    await waitForV4Pane((state) => !state.canStop, "Group 首发未结束", 60_000);
    await browser.waitUntil(async () => (await reports()).length === 2, { timeout: 15_000 });
    expect((await reports())[1]?.event_extra_detail?.create_source).toBe("group");
    // 先验证该轮完成事件再刷新，避免把刷新时的异步上报中断误判为 ID 不一致。
    await waitForMatchingCompletion((await reports())[1]!);

    // 重载后的默认空态直接发首条消息；没有新建点击来设置来源。
    await startNewV4Draft();
    await browser.refresh();
    // Group 视图没有 Project 侧栏项；刷新后以实际草稿 pane 就绪为准。
    await waitForV4Pane(
      (state) => !state.sessionId || state.sessionId === "draft",
      "刷新后草稿未就绪",
      90_000,
    );
    await waitForV4ComposerSelectionReady();
    await sendV4Prompt('E2E_SESSION_CREATE_TELEMETRY_DIRECT: Reply exactly "SESSION_DIRECT_OK".');
    await waitForV4TimelineContaining("SESSION_DIRECT_OK", 60_000);
    await browser.waitUntil(async () => (await reports()).length === 3, { timeout: 15_000 });
    expect((await reports())[2]?.event_extra_detail?.create_source).toBe("session");
    expect(new Set((await reports()).map((event) => event.event_id)).size).toBe(3);
    for (const created of await reports()) await waitForMatchingCompletion(created);
  });
});
